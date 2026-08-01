use crate::protocol::{EnvelopeKind, validate_envelope};
use serde_json::Value;
use std::io::{BufRead, BufReader, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

const MAX_PAYLOAD_BYTES: usize = 1024 * 1024;
const TRANSPORT_TIMEOUT: Duration = Duration::from_secs(3);

pub fn send(address: &str, request: &Value) -> Result<Value, String> {
    validate_envelope(request, EnvelopeKind::Request)
        .map_err(|error| serde_json::to_string(&error).unwrap_or(error.message))?;
    let address: SocketAddr = address
        .parse()
        .map_err(|_| "The Godot bridge address is invalid".to_owned())?;
    if !address.ip().is_loopback() {
        return Err("The Godot bridge must use a loopback address".to_owned());
    }
    let mut stream = TcpStream::connect_timeout(&address, TRANSPORT_TIMEOUT)
        .map_err(|error| format!("Could not connect to the Godot bridge: {error}"))?;
    stream
        .set_read_timeout(Some(TRANSPORT_TIMEOUT))
        .map_err(|error| format!("Could not configure the Godot bridge: {error}"))?;
    let mut payload = serde_json::to_vec(request)
        .map_err(|error| format!("Could not serialize the Godot request: {error}"))?;
    payload.push(b'\n');
    stream
        .write_all(&payload)
        .map_err(|error| format!("Could not send the Godot request: {error}"))?;
    let mut response = Vec::new();
    BufReader::new(stream)
        .read_until(b'\n', &mut response)
        .map_err(|error| format!("Could not read the Godot response: {error}"))?;
    if response.len() > MAX_PAYLOAD_BYTES {
        return Err("The Godot bridge response is too large".to_owned());
    }
    let response: Value = serde_json::from_slice(&response)
        .map_err(|error| format!("The Godot bridge returned invalid JSON: {error}"))?;
    let kind = if response.get("error").is_some() {
        EnvelopeKind::Error
    } else {
        EnvelopeKind::Response
    };
    validate_envelope(&response, kind)
        .map_err(|error| serde_json::to_string(&error).unwrap_or(error.message))?;
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::sync::mpsc;
    use std::thread;

    fn request(version: u64) -> Value {
        serde_json::json!({
            "protocolVersion": version,
            "id": "rust-1",
            "command": "handshake",
            "params": {}
        })
    }

    #[test]
    fn exchanges_a_valid_protocol_payload_with_a_loopback_bridge() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind fake bridge");
        let address = listener.local_addr().expect("fake bridge address");
        let (received_sender, received_receiver) = mpsc::channel();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept bridge client");
            let mut line = String::new();
            BufReader::new(stream.try_clone().expect("clone bridge stream"))
                .read_line(&mut line)
                .expect("read bridge request");
            received_sender.send(line).expect("report bridge request");
            writeln!(
                stream,
                "{}",
                serde_json::json!({
                    "protocolVersion": 1,
                    "id": "rust-1",
                    "result": {"acceptedVersion": 1}
                })
            )
            .expect("write bridge response");
        });

        let response = send(&address.to_string(), &request(1)).expect("bridge response");
        assert_eq!(response["result"]["acceptedVersion"], 1);
        let received: Value = serde_json::from_str(
            received_receiver
                .recv()
                .expect("receive bridge request")
                .trim(),
        )
        .expect("parse received bridge request");
        assert_eq!(received, request(1));
        server.join().expect("fake bridge server");
    }

    #[test]
    fn rejects_unsafe_addresses_and_versions_before_connecting() {
        assert!(
            send("192.0.2.1:4242", &request(1))
                .unwrap_err()
                .contains("loopback")
        );
        let error = send("127.0.0.1:1", &request(2)).unwrap_err();
        assert!(error.contains("unsupported_protocol_version"));
    }
}

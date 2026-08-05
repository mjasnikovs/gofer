//! Persistent, authenticated editor RPC for protocol v2.
#![allow(dead_code)]
//!
//! The session supervisor binds a loopback TCP port and passes its address plus a session token to
//! the Godot editor through the process environment. The Gofer addon connects outward, sends a
//! handshake, and then receives requests while emitting responses and events. This module owns
//! that connection: handshake validation, request/response correlation, event sequencing,
//! heartbeat generation, payload limits, and reconnect rules.

use crate::protocol_v2::{
    EnvelopeKind, MAX_ENVELOPE_BYTES, MAX_ID_LENGTH, MAX_IMAGE_ENVELOPE_BYTES, MAX_TIMEOUT_MS,
    PROTOCOL_VERSION, Readiness, validate_envelope,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

pub(crate) const HEARTBEAT_INTERVAL_MS: u64 = 5_000;
/// The id Gofer reuses for every heartbeat request. The addon answers it like any other request, so
/// the correlation table never holds an entry for it and its reply is recognized by this id alone.
const HEARTBEAT_ID: &str = "heartbeat";
const CONNECT_TIMEOUT_MS: u64 = 30_000;
const DEFAULT_REQUEST_TIMEOUT_MS: u64 = 60_000;
const MAX_RECONNECT_ATTEMPTS: usize = 3;
const RECONNECT_BACKOFF_MS: u64 = 500;

/// A structured, actionable RPC failure.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RpcError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
    pub readiness: Readiness,
    pub details: Value,
}

impl RpcError {
    pub(crate) fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_owned(),
            message: message.into(),
            retryable: false,
            readiness: Readiness::Ready,
            details: json!({}),
        }
    }

    fn retryable(mut self) -> Self {
        self.retryable = true;
        self
    }

    fn to_envelope(&self, id: &str) -> Value {
        json!({
            "protocolVersion": PROTOCOL_VERSION,
            "kind": "error",
            "id": id,
            "error": self,
        })
    }
}

/// A value event emitted by the Godot addon.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventEnvelope {
    pub sequence: u64,
    pub event: String,
    pub data: Value,
}

/// A response returned for a correlated request.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResponseEnvelope {
    pub id: String,
    pub result: Value,
    pub revision: Option<u64>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CallRequest {
    pub id: String,
    pub command: String,
    pub params: Value,
    #[serde(default)]
    pub expected_revision: Option<u64>,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

struct PendingRequest {
    sender: std::sync::mpsc::Sender<Result<ResponseEnvelope, RpcError>>,
}

enum ConnectionState {
    Idle,
    Connected { writer: TcpStream },
    Closed { error: RpcError },
}

struct SharedState {
    token: String,
    project_path: String,
    pending: HashMap<String, PendingRequest>,
    events: Vec<std::sync::mpsc::Sender<EventEnvelope>>,
    connection: ConnectionState,
    closed: bool,
    next_sequence: u64,
    readiness: Readiness,
}

/// A persistent, authenticated editor RPC session.
#[derive(Clone)]
pub struct RpcSession {
    state: Arc<Mutex<SharedState>>,
    request_tx: std::sync::mpsc::Sender<CallRequest>,
    stop_signal: Arc<AtomicBool>,
}

impl RpcSession {
    /// Start accepting the addon connection on `listener`. The addon must present `token` and
    /// report `project_path` during the handshake.
    pub fn start(listener: TcpListener, token: String, project_path: String) -> Self {
        let state = Arc::new(Mutex::new(SharedState {
            token,
            project_path,
            pending: HashMap::new(),
            events: Vec::new(),
            connection: ConnectionState::Idle,
            closed: false,
            next_sequence: 0,
            readiness: Readiness::Starting,
        }));
        let (request_tx, request_rx) = std::sync::mpsc::channel::<CallRequest>();
        let stop_signal = Arc::new(AtomicBool::new(false));

        thread::spawn({
            let state = Arc::clone(&state);
            let stop_signal = Arc::clone(&stop_signal);
            move || run_session(listener, state, request_rx, stop_signal)
        });

        Self {
            state,
            request_tx,
            stop_signal,
        }
    }

    /// Send a request and wait for the correlated response. Returns an error immediately if the
    /// session is closed or the request cannot be serialized.
    pub fn call(&self, request: CallRequest) -> Result<ResponseEnvelope, RpcError> {
        if request.id.len() > MAX_ID_LENGTH {
            return Err(RpcError::new(
                "invalid_request_id",
                "Request id exceeds 128 characters",
            ));
        }
        let timeout = request
            .timeout_ms
            .map(|ms| Duration::from_millis(ms.clamp(1, MAX_TIMEOUT_MS)))
            .unwrap_or_else(|| Duration::from_millis(DEFAULT_REQUEST_TIMEOUT_MS));
        let (tx, rx) = std::sync::mpsc::channel();
        {
            let mut state = self
                .state
                .lock()
                .map_err(|_| RpcError::new("lock_poisoned", "The RPC state lock is poisoned"))?;
            if state.closed {
                return Err(RpcError::new("session_closed", "The RPC session is closed"));
            }
            if let ConnectionState::Closed { error } = &state.connection {
                return Err(error.clone());
            }
            state
                .pending
                .insert(request.id.clone(), PendingRequest { sender: tx });
        }
        self.request_tx
            .send(request)
            .map_err(|_| RpcError::new("session_closed", "The RPC session has stopped"))?;
        rx.recv_timeout(timeout)
            .map_err(|_| RpcError::new("request_timeout", "The request timed out").retryable())?
    }

    /// Current lifecycle readiness reported by the addon.
    pub fn readiness(&self) -> Readiness {
        self.state
            .lock()
            .ok()
            .map(|state| state.readiness)
            .unwrap_or(Readiness::Unavailable)
    }

    /// Subscribe to addon events. Events are broadcast to every active subscriber.
    pub fn subscribe_events(&self) -> std::sync::mpsc::Receiver<EventEnvelope> {
        let (sender, receiver) = std::sync::mpsc::channel();
        if let Ok(mut state) = self.state.lock() {
            state.events.push(sender);
        }
        receiver
    }

    /// Stop the session, close the connection, and fail any pending requests.
    pub fn stop(&self) {
        self.stop_signal.store(true, Ordering::Release);
        let mut state = match self.state.lock() {
            Ok(state) => state,
            Err(_) => return,
        };
        state.closed = true;
        state.readiness = Readiness::Unavailable;
        fail_pending(
            &mut state,
            RpcError::new("session_stopped", "The RPC session was stopped"),
        );
        if let ConnectionState::Connected { writer } = &state.connection {
            let _ = writer.shutdown(std::net::Shutdown::Both);
        }
        state.connection = ConnectionState::Closed {
            error: RpcError::new("session_stopped", "The RPC session was stopped"),
        };
    }
}

fn run_session(
    listener: TcpListener,
    state: Arc<Mutex<SharedState>>,
    request_rx: std::sync::mpsc::Receiver<CallRequest>,
    stop_signal: Arc<AtomicBool>,
) {
    let mut reconnects = 0;
    let deadline = Instant::now() + Duration::from_millis(CONNECT_TIMEOUT_MS);

    while reconnects <= MAX_RECONNECT_ATTEMPTS && Instant::now() < deadline {
        if stop_signal.load(Ordering::Acquire) {
            break;
        }
        listener
            .set_nonblocking(false)
            .expect("listener blocking mode");
        match listener.accept().map(|(stream, _)| stream) {
            Ok(stream) => {
                if handle_connection(stream, &state, &request_rx, &stop_signal) {
                    reconnects = 0;
                } else {
                    break;
                }
            }
            Err(_) => {
                reconnects += 1;
                thread::sleep(Duration::from_millis(RECONNECT_BACKOFF_MS));
            }
        }
    }

    let mut state = state.lock().expect("RPC state lock");
    state.closed = true;
    state.readiness = Readiness::Unavailable;
    fail_pending(
        &mut state,
        RpcError::new("session_closed", "The RPC session closed"),
    );
}

/// Returns true if the session should accept another connection.
fn handle_connection(
    stream: TcpStream,
    state: &Arc<Mutex<SharedState>>,
    request_rx: &std::sync::mpsc::Receiver<CallRequest>,
    stop_signal: &Arc<AtomicBool>,
) -> bool {
    let _ = stream.set_read_timeout(Some(Duration::from_millis(HEARTBEAT_INTERVAL_MS * 3)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(HEARTBEAT_INTERVAL_MS * 3)));

    let mut reader = BufReader::new(stream.try_clone().expect("clone stream"));
    let mut writer = stream;

    let handshake_line = match read_line(&mut reader, MAX_ENVELOPE_BYTES) {
        Ok(Some(line)) => line,
        Ok(None) => return true,
        Err(error) => {
            let _ = write_envelope(&mut writer, &error.to_envelope("handshake"));
            close_with_error(state, error);
            return false;
        }
    };

    let handshake: Value = match serde_json::from_str(&handshake_line) {
        Ok(value) => value,
        Err(error) => {
            let error = RpcError::new(
                "invalid_protocol_payload",
                format!("The handshake is not valid JSON: {error}"),
            );
            let _ = write_envelope(&mut writer, &error.to_envelope("handshake"));
            close_with_error(state, error);
            return false;
        }
    };

    match validate_envelope(&handshake) {
        Ok(EnvelopeKind::Handshake) => {}
        Ok(_) => {
            let error = RpcError::new(
                "invalid_protocol_payload",
                "The first envelope must be a handshake",
            );
            let _ = write_envelope(
                &mut writer,
                &error.to_envelope(
                    handshake
                        .get("id")
                        .and_then(Value::as_str)
                        .unwrap_or("handshake"),
                ),
            );
            close_with_error(state, error);
            return false;
        }
        Err(error) => {
            let id = handshake
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or("handshake");
            let _ = write_envelope(&mut writer, &error.to_envelope(id));
            close_with_error(state, protocol_error_to_rpc(error));
            return false;
        }
    }

    let token = handshake.get("token").and_then(Value::as_str).unwrap_or("");
    let accepted_versions = handshake
        .get("acceptedVersions")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let client = handshake.get("client").cloned().unwrap_or_default();
    let project_path = client
        .get("projectPath")
        .and_then(Value::as_str)
        .unwrap_or("");
    let id = handshake
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("handshake")
        .to_owned();

    {
        let mut state = state.lock().expect("RPC state lock");
        if token != state.token {
            let _ = write_envelope(&mut writer, &unauthenticated(&id));
            state.connection = ConnectionState::Closed {
                error: RpcError::new("unauthenticated", "The handshake token did not match"),
            };
            return false;
        }
        if !same_project(&state.project_path, project_path) {
            let _ = write_envelope(
                &mut writer,
                &wrong_project(&id, &state.project_path, project_path),
            );
            state.connection = ConnectionState::Closed {
                error: RpcError::new(
                    "wrong_project",
                    "The addon reported a different project path",
                ),
            };
            return false;
        }
        if !accepted_versions
            .iter()
            .any(|v| v.as_u64() == Some(PROTOCOL_VERSION))
        {
            let _ = write_envelope(&mut writer, &unsupported_version(&id));
            state.connection = ConnectionState::Closed {
                error: RpcError::new(
                    "unsupported_protocol_version",
                    "The addon does not speak protocol version 2",
                ),
            };
            return false;
        }
        state.connection = ConnectionState::Connected {
            writer: writer.try_clone().expect("clone writer"),
        };
        state.readiness = Readiness::Ready;
    }

    let _ = write_envelope(&mut writer, &handshake_response(&id));

    let last_heartbeat = Arc::new(Mutex::new(Instant::now()));
    let reader_state = Arc::clone(state);
    let reader_stop = Arc::clone(stop_signal);
    let reader_writer = writer.try_clone().expect("clone writer for reader");
    let reader_last_heartbeat = Arc::clone(&last_heartbeat);
    let reader_handle = thread::spawn(move || {
        read_envelopes(
            reader_state,
            reader,
            reader_writer,
            reader_stop,
            reader_last_heartbeat,
        )
    });

    let mut result = true;
    while !stop_signal.load(Ordering::Acquire) {
        let heartbeat_due = {
            let last = last_heartbeat.lock().expect("heartbeat lock");
            Instant::now().duration_since(*last) > Duration::from_millis(HEARTBEAT_INTERVAL_MS)
        };
        if heartbeat_due {
            if write_envelope(&mut writer, &heartbeat_request()).is_err() {
                break;
            }
            // Restart the interval on the write, not on the reply, so one silent addon costs one
            // heartbeat per interval instead of one per poll. A dead connection is caught by the
            // read timeout, which is three intervals wide.
            *last_heartbeat.lock().expect("heartbeat lock") = Instant::now();
        }

        match request_rx.recv_timeout(Duration::from_millis(HEARTBEAT_INTERVAL_MS / 4)) {
            Ok(request) => {
                if write_request(&mut writer, &request).is_err() {
                    break;
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                result = false;
                break;
            }
        }
    }

    let _ = writer.shutdown(std::net::Shutdown::Both);
    let _ = reader_handle.join();

    {
        let mut state = state.lock().expect("RPC state lock");
        state.connection = ConnectionState::Idle;
        state.readiness = Readiness::Starting;
    }

    result
}

fn read_envelopes(
    state: Arc<Mutex<SharedState>>,
    reader: BufReader<TcpStream>,
    mut writer: TcpStream,
    stop_signal: Arc<AtomicBool>,
    last_heartbeat: Arc<Mutex<Instant>>,
) {
    let mut reader = reader;
    loop {
        if stop_signal.load(Ordering::Acquire) {
            break;
        }
        let line = match read_line(&mut reader, MAX_IMAGE_ENVELOPE_BYTES) {
            Ok(Some(line)) => line,
            Ok(None) => break,
            Err(error) => {
                let _ = write_envelope(&mut writer, &error.to_envelope("protocol"));
                close_with_error(&state, error);
                break;
            }
        };
        if line.trim().is_empty() {
            continue;
        }
        let envelope = match serde_json::from_str::<Value>(&line) {
            Ok(value) => value,
            Err(error) => {
                let error = RpcError::new(
                    "invalid_protocol_payload",
                    format!("Envelope is not valid JSON: {error}"),
                );
                let _ = write_envelope(&mut writer, &error.to_envelope("protocol"));
                close_with_error(&state, error);
                break;
            }
        };
        if is_heartbeat(&envelope) {
            *last_heartbeat.lock().expect("heartbeat lock") = Instant::now();
            continue;
        }
        if let Err(error) = dispatch_envelope(&state, envelope) {
            let _ = write_envelope(&mut writer, &error.to_envelope("protocol"));
            close_with_error(&state, error);
            break;
        }
    }
}

/// Decides whether the addon is editing the worktree this session owns.
///
/// Godot globalizes `res://` with a trailing separator, and the supervisor holds the canonical
/// worktree, so the two spellings of one directory never match as strings. Both sides are
/// normalized instead: a session must reject a different project, not a different spelling.
fn same_project(expected: &str, reported: &str) -> bool {
    if reported.is_empty() {
        return false;
    }
    let normalize = |value: &str| {
        let trimmed = value.trim_end_matches(['/', '\\']);
        let path = Path::new(if trimmed.is_empty() { value } else { trimmed });
        let canonical = crate::paths::canonical(path).unwrap_or_else(|_| path.to_path_buf());
        crate::paths::simplified(&canonical).to_path_buf()
    };
    normalize(expected) == normalize(reported)
}

/// Recognizes the liveness traffic that carries no correlated request: the addon's reply to a
/// heartbeat request, and an unsolicited heartbeat event.
fn is_heartbeat(envelope: &Value) -> bool {
    let kind = envelope.get("kind").and_then(Value::as_str).unwrap_or("");
    match kind {
        "response" | "error" => envelope.get("id").and_then(Value::as_str) == Some(HEARTBEAT_ID),
        "event" => envelope.get("event").and_then(Value::as_str) == Some("session.heartbeat"),
        _ => false,
    }
}

fn dispatch_envelope(state: &Arc<Mutex<SharedState>>, envelope: Value) -> Result<(), RpcError> {
    let kind = envelope.get("kind").and_then(Value::as_str).unwrap_or("");
    let id = envelope
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();

    match kind {
        "response" => {
            let mut state = state
                .lock()
                .map_err(|_| RpcError::new("lock_poisoned", "The RPC state lock is poisoned"))?;
            let Some(pending) = state.pending.remove(&id) else {
                return Err(RpcError::new(
                    "stale_reply",
                    format!("Received a response for unknown request {id}"),
                ));
            };
            let result = envelope.get("result").cloned().unwrap_or_default();
            let revision = envelope.get("revision").and_then(Value::as_u64);
            let _ = pending.sender.send(Ok(ResponseEnvelope {
                id,
                result,
                revision,
            }));
        }
        "error" => {
            let mut state = state
                .lock()
                .map_err(|_| RpcError::new("lock_poisoned", "The RPC state lock is poisoned"))?;
            let error_value = envelope.get("error").cloned().unwrap_or_default();
            let rpc_error = parse_error(error_value);
            if id == "handshake" || id.is_empty() {
                state.connection = ConnectionState::Closed {
                    error: rpc_error.clone(),
                };
                return Err(rpc_error);
            }
            let Some(pending) = state.pending.remove(&id) else {
                return Err(RpcError::new(
                    "stale_reply",
                    format!("Received an error for unknown request {id}"),
                ));
            };
            let _ = pending.sender.send(Err(rpc_error));
        }
        "event" => {
            let mut state = state
                .lock()
                .map_err(|_| RpcError::new("lock_poisoned", "The RPC state lock is poisoned"))?;
            let sequence = envelope
                .get("sequence")
                .and_then(Value::as_u64)
                .unwrap_or(state.next_sequence);
            let event = envelope
                .get("event")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned();
            let data = envelope.get("data").cloned().unwrap_or_default();
            state.next_sequence = sequence + 1;
            let envelope = EventEnvelope {
                sequence,
                event,
                data,
            };
            state
                .events
                .retain(|sender| sender.send(envelope.clone()).is_ok());
        }
        _ => {
            return Err(RpcError::new(
                "invalid_protocol_payload",
                format!("Unexpected envelope kind: {kind}"),
            ));
        }
    }
    Ok(())
}

fn read_line(
    reader: &mut BufReader<TcpStream>,
    max_bytes: usize,
) -> Result<Option<String>, RpcError> {
    let mut buffer = Vec::new();
    match reader.read_until(b'\n', &mut buffer) {
        Ok(0) => Ok(None),
        Ok(_) => {
            if buffer.len() > max_bytes {
                return Err(RpcError::new(
                    "payload_too_large",
                    format!("Envelope exceeded {max_bytes} bytes"),
                ));
            }
            String::from_utf8(buffer)
                .map(Some)
                .map_err(|_| RpcError::new("invalid_protocol_payload", "Envelope is not UTF-8"))
        }
        Err(error) => Err(RpcError::new(
            "transport_failed",
            format!("Could not read from the RPC connection: {error}"),
        )
        .retryable()),
    }
}

fn write_envelope(writer: &mut TcpStream, envelope: &Value) -> Result<(), RpcError> {
    let mut bytes = serde_json::to_vec(envelope).map_err(|error| {
        RpcError::new(
            "serialize_failed",
            format!("Could not serialize envelope: {error}"),
        )
    })?;
    bytes.push(b'\n');
    writer.write_all(&bytes).map_err(|error| {
        RpcError::new(
            "transport_failed",
            format!("Could not write to the RPC connection: {error}"),
        )
        .retryable()
    })
}

fn write_request(writer: &mut TcpStream, request: &CallRequest) -> Result<(), RpcError> {
    let timeout_ms = request.timeout_ms.unwrap_or(DEFAULT_REQUEST_TIMEOUT_MS);
    let mut envelope = json!({
        "protocolVersion": PROTOCOL_VERSION,
        "kind": "request",
        "id": request.id,
        "command": request.command,
        "params": request.params,
        "timeoutMs": timeout_ms,
    });
    if let Some(revision) = request.expected_revision {
        envelope["expectedRevision"] = json!(revision);
    }
    write_envelope(writer, &envelope)
}

fn close_with_error(state: &Arc<Mutex<SharedState>>, error: RpcError) {
    let mut state = state.lock().expect("RPC state lock");
    state.connection = ConnectionState::Closed {
        error: error.clone(),
    };
    state.readiness = Readiness::Unavailable;
    fail_pending(&mut state, error);
}

fn fail_pending(state: &mut SharedState, error: RpcError) {
    for (_, pending) in std::mem::take(&mut state.pending) {
        let _ = pending.sender.send(Err(error.clone()));
    }
}

fn handshake_response(id: &str) -> Value {
    json!({
        "protocolVersion": PROTOCOL_VERSION,
        "kind": "response",
        "id": id,
        "result": {
            "sessionId": "gofer-session",
            "acceptedVersion": PROTOCOL_VERSION,
            "heartbeatIntervalMs": HEARTBEAT_INTERVAL_MS,
            "limits": {
                "maxEnvelopeBytes": MAX_ENVELOPE_BYTES,
                "maxImageEnvelopeBytes": MAX_IMAGE_ENVELOPE_BYTES,
                "maxImageEdgePixels": 1920,
            }
        }
    })
}

fn heartbeat_request() -> Value {
    json!({
        "protocolVersion": PROTOCOL_VERSION,
        "kind": "request",
        "id": HEARTBEAT_ID,
        "command": "session.heartbeat",
        "params": {},
        "timeoutMs": HEARTBEAT_INTERVAL_MS,
    })
}

fn unauthenticated(id: &str) -> Value {
    json!({
        "protocolVersion": PROTOCOL_VERSION,
        "kind": "error",
        "id": id,
        "error": {
            "code": "unauthenticated",
            "message": "The handshake token did not match",
            "retryable": false,
            "readiness": "unavailable",
            "details": {}
        }
    })
}

fn wrong_project(id: &str, expected: &str, actual: &str) -> Value {
    json!({
        "protocolVersion": PROTOCOL_VERSION,
        "kind": "error",
        "id": id,
        "error": {
            "code": "wrong_project",
            "message": "The addon reported a different project path",
            "retryable": false,
            "readiness": "unavailable",
            "details": {"expected": expected, "actual": actual}
        }
    })
}

fn unsupported_version(id: &str) -> Value {
    json!({
        "protocolVersion": PROTOCOL_VERSION,
        "kind": "error",
        "id": id,
        "error": {
            "code": "unsupported_protocol_version",
            "message": "The addon does not speak a supported protocol version",
            "retryable": false,
            "readiness": "unavailable",
            "details": {"supportedVersions": [PROTOCOL_VERSION]}
        }
    })
}

fn protocol_error_to_rpc(error: crate::protocol_v2::ProtocolError) -> RpcError {
    RpcError {
        code: error.code.to_owned(),
        message: error.message,
        retryable: error.retryable,
        readiness: error.readiness,
        details: error.details,
    }
}

fn parse_error(value: Value) -> RpcError {
    let code = value
        .get("code")
        .and_then(Value::as_str)
        .unwrap_or("unknown_error");
    let message = value
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("An RPC error occurred")
        .to_owned();
    let retryable = value
        .get("retryable")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let readiness = value
        .get("readiness")
        .and_then(Value::as_str)
        .and_then(Readiness::parse)
        .unwrap_or(Readiness::Unavailable);
    let details = value.get("details").cloned().unwrap_or_default();
    RpcError {
        code: code.to_owned(),
        message,
        retryable,
        readiness,
        details,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::net::TcpListener;
    use std::thread;
    use std::time::Duration;

    fn handshake(token: &str, project_path: &str) -> Value {
        json!({
            "protocolVersion": 2,
            "kind": "handshake",
            "id": "handshake-1",
            "token": token,
            "acceptedVersions": [2],
            "client": {
                "name": "gofer-godot-addon",
                "addonVersion": "2.0.0",
                "engineVersion": "4.7.1.stable",
                "projectPath": project_path,
                "capabilities": ["session", "scene"]
            }
        })
    }

    fn addon_client(address: std::net::SocketAddr) -> TcpStream {
        TcpStream::connect(address).expect("connect to RPC")
    }

    #[test]
    fn accepts_valid_handshake_and_exchanges_a_request() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let address = listener.local_addr().expect("listener address");
        let project_path = "/tmp/gofer/project".to_owned();
        let token = "a1".repeat(32);
        let session = RpcSession::start(listener, token.clone(), project_path.clone());

        let mut addon = addon_client(address);
        writeln!(
            addon,
            "{}",
            serde_json::to_string(&handshake(&token, &project_path)).unwrap()
        )
        .unwrap();

        let mut reader = BufReader::new(addon.try_clone().unwrap());
        let mut response = String::new();
        reader.read_line(&mut response).unwrap();
        let response: Value = serde_json::from_str(&response).unwrap();
        assert_eq!(response["kind"], "response");
        assert_eq!(response["result"]["acceptedVersion"], 2);

        let request = CallRequest {
            id: "request-1".to_owned(),
            command: "scene.list".to_owned(),
            params: json!({}),
            expected_revision: None,
            timeout_ms: Some(100),
        };

        let addon_handle = thread::spawn(move || {
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            let request: Value = serde_json::from_str(&line).unwrap();
            assert_eq!(request["command"], "scene.list");
            writeln!(
                addon,
                "{}",
                serde_json::to_string(&json!({
                    "protocolVersion": 2,
                    "kind": "response",
                    "id": "request-1",
                    "result": {"scenes": []}
                }))
                .unwrap()
            )
            .unwrap();
        });

        let result = session.call(request).expect("call succeeds");
        assert_eq!(result.id, "request-1");
        assert_eq!(result.result["scenes"], json!([]));
        addon_handle.join().unwrap();
        session.stop();
    }

    #[test]
    fn rejects_invalid_handshake_token() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let address = listener.local_addr().expect("listener address");
        let session = RpcSession::start(listener, "a1".repeat(32), "/tmp/gofer/project".to_owned());

        let mut addon = addon_client(address);
        writeln!(
            addon,
            "{}",
            serde_json::to_string(&handshake("b2".repeat(32).as_str(), "/tmp/gofer/project"))
                .unwrap()
        )
        .unwrap();

        let mut reader = BufReader::new(addon);
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        let response: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(response["kind"], "error");
        assert_eq!(response["error"]["code"], "unauthenticated");
        session.stop();
    }

    #[test]
    fn rejects_wrong_project_path() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let address = listener.local_addr().expect("listener address");
        let token = "a1".repeat(32);
        let session = RpcSession::start(listener, token.clone(), "/tmp/gofer/project".to_owned());

        let mut addon = addon_client(address);
        writeln!(
            addon,
            "{}",
            serde_json::to_string(&handshake(&token, "/tmp/other/project")).unwrap()
        )
        .unwrap();

        let mut reader = BufReader::new(addon);
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        let response: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(response["kind"], "error");
        assert_eq!(response["error"]["code"], "wrong_project");
        session.stop();
    }

    #[test]
    fn accepts_the_trailing_separator_godot_reports() {
        let directory = tempfile::TempDir::new().expect("temporary directory");
        let worktree = crate::paths::canonical(directory.path()).expect("canonical worktree");
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let address = listener.local_addr().expect("listener address");
        let token = "a1".repeat(32);
        let session = RpcSession::start(listener, token.clone(), worktree.display().to_string());

        // `ProjectSettings.globalize_path("res://")` always ends in a separator.
        let mut addon = addon_client(address);
        writeln!(
            addon,
            "{}",
            serde_json::to_string(&handshake(&token, &format!("{}/", worktree.display()))).unwrap()
        )
        .unwrap();

        let mut reader = BufReader::new(addon);
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        let response: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(response["kind"], "response", "{response}");
        session.stop();
    }

    #[test]
    fn rejects_oversized_payload() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let address = listener.local_addr().expect("listener address");
        let token = "a1".repeat(32);
        let session = RpcSession::start(listener, token.clone(), "/tmp/gofer/project".to_owned());

        let mut addon = addon_client(address);
        let giant = "x".repeat(MAX_ENVELOPE_BYTES + 100);
        writeln!(
            addon,
            "{{\"protocolVersion\":2,\"kind\":\"handshake\",\"id\":\"h\",\"token\":\"{token}\",\"junk\":\"{giant}\"}}"
        )
        .unwrap();

        let mut reader = BufReader::new(addon);
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        let response: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(response["kind"], "error");
        assert_eq!(response["error"]["code"], "payload_too_large");
        session.stop();
    }

    #[test]
    fn detects_disconnect_and_reports_timeout() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let address = listener.local_addr().expect("listener address");
        let token = "a1".repeat(32);
        let project_path = "/tmp/gofer/project".to_owned();
        let session = RpcSession::start(listener, token.clone(), project_path.clone());

        let mut addon = addon_client(address);
        writeln!(
            addon,
            "{}",
            serde_json::to_string(&handshake(&token, &project_path)).unwrap()
        )
        .unwrap();

        let mut reader = BufReader::new(addon.try_clone().unwrap());
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();

        drop(addon);
        drop(reader);

        let request = CallRequest {
            id: "request-dead".to_owned(),
            command: "scene.list".to_owned(),
            params: json!({}),
            expected_revision: None,
            timeout_ms: Some(50),
        };

        let result = session.call(request);
        assert!(result.is_err(), "{result:?}");
        session.stop();
    }

    #[test]
    fn rejects_stale_reply_for_unknown_request() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let address = listener.local_addr().expect("listener address");
        let token = "a1".repeat(32);
        let project_path = "/tmp/gofer/project".to_owned();
        let session = RpcSession::start(listener, token.clone(), project_path.clone());

        let mut addon = addon_client(address);
        writeln!(
            addon,
            "{}",
            serde_json::to_string(&handshake(&token, &project_path)).unwrap()
        )
        .unwrap();

        let mut reader = BufReader::new(addon.try_clone().unwrap());
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();

        writeln!(
            addon,
            "{}",
            serde_json::to_string(&json!({
                "protocolVersion": 2,
                "kind": "response",
                "id": "unknown-id",
                "result": {}
            }))
            .unwrap()
        )
        .unwrap();

        thread::sleep(Duration::from_millis(100));

        let request = CallRequest {
            id: "request-1".to_owned(),
            command: "scene.list".to_owned(),
            params: json!({}),
            expected_revision: None,
            timeout_ms: Some(50),
        };
        let result = session.call(request);
        assert!(result.is_err(), "{result:?}");
        session.stop();
    }

    #[test]
    fn heartbeat_replies_keep_the_session_open() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let address = listener.local_addr().expect("listener address");
        let token = "a1".repeat(32);
        let project_path = "/tmp/gofer/project".to_owned();
        let session = RpcSession::start(listener, token.clone(), project_path.clone());

        let mut addon = addon_client(address);
        writeln!(
            addon,
            "{}",
            serde_json::to_string(&handshake(&token, &project_path)).unwrap()
        )
        .unwrap();

        let mut reader = BufReader::new(addon.try_clone().unwrap());
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();

        // The addon answers the heartbeat like any other request. It has no pending entry, so a
        // correlation-only reader would treat the reply as a stale reply and close the session.
        writeln!(
            addon,
            "{}",
            serde_json::to_string(&json!({
                "protocolVersion": 2,
                "kind": "response",
                "id": "heartbeat",
                "result": {}
            }))
            .unwrap()
        )
        .unwrap();

        thread::sleep(Duration::from_millis(100));

        let request = CallRequest {
            id: "request-1".to_owned(),
            command: "scene.list".to_owned(),
            params: json!({}),
            expected_revision: None,
            timeout_ms: Some(500),
        };

        let addon_handle = thread::spawn(move || {
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            let request: Value = serde_json::from_str(&line).unwrap();
            assert_eq!(request["command"], "scene.list");
            writeln!(
                addon,
                "{}",
                serde_json::to_string(&json!({
                    "protocolVersion": 2,
                    "kind": "response",
                    "id": "request-1",
                    "result": {"scenes": []}
                }))
                .unwrap()
            )
            .unwrap();
        });

        let result = session
            .call(request)
            .expect("session survives a heartbeat reply");
        assert_eq!(result.id, "request-1");
        addon_handle.join().unwrap();
        session.stop();
    }

    #[test]
    fn broadcasts_events_to_subscribers() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let address = listener.local_addr().expect("listener address");
        let token = "a1".repeat(32);
        let project_path = "/tmp/gofer/project".to_owned();
        let session = RpcSession::start(listener, token.clone(), project_path.clone());
        let events = session.subscribe_events();

        let mut addon = addon_client(address);
        writeln!(
            addon,
            "{}",
            serde_json::to_string(&handshake(&token, &project_path)).unwrap()
        )
        .unwrap();

        let mut reader = BufReader::new(addon.try_clone().unwrap());
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();

        writeln!(
            addon,
            "{}",
            serde_json::to_string(&json!({
                "protocolVersion": 2,
                "kind": "event",
                "sequence": 1,
                "event": "session.ready",
                "data": {"ready": true}
            }))
            .unwrap()
        )
        .unwrap();

        let event = events
            .recv_timeout(Duration::from_millis(200))
            .expect("event");
        assert_eq!(event.sequence, 1);
        assert_eq!(event.event, "session.ready");
        session.stop();
    }

    /// A caller never reaches the wire with a request the session already knows it cannot deliver.
    /// Both answers name their own reason instead of making the caller wait out a timeout: an id
    /// past the protocol's cap, and a session the caller has already stopped.
    #[test]
    fn a_call_is_refused_before_the_wire_when_the_session_cannot_carry_it() {
        let request = |id: String| CallRequest {
            id,
            command: "scene.list".to_owned(),
            params: json!({}),
            expected_revision: None,
            timeout_ms: Some(100),
        };
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let session = RpcSession::start(listener, "a1".repeat(32), "/tmp/gofer/project".to_owned());

        let oversized = session
            .call(request("x".repeat(MAX_ID_LENGTH + 1)))
            .expect_err("an id past the protocol cap never leaves the process");
        assert_eq!(oversized.code, "invalid_request_id");

        session.stop();
        let stopped = session
            .call(request("after-stop".to_owned()))
            .expect_err("a stopped session refuses immediately");
        assert_eq!(stopped.code, "session_closed");
    }

    /// The framing has to survive what a real socket delivers, and the two cases are not the same
    /// kind of event: a bare newline is keepalive and costs nothing, while a reply to a request
    /// nobody is waiting for means the two sides disagree about what is outstanding.
    #[test]
    fn a_blank_line_is_keepalive_and_a_stale_reply_ends_the_session() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let address = listener.local_addr().expect("listener address");
        let token = "a1".repeat(32);
        let project_path = "/tmp/gofer/project".to_owned();
        let session = RpcSession::start(listener, token.clone(), project_path.clone());

        let mut addon = addon_client(address);
        writeln!(
            addon,
            "{}",
            serde_json::to_string(&handshake(&token, &project_path)).unwrap()
        )
        .unwrap();
        let mut reader = BufReader::new(addon.try_clone().unwrap());
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        let accepted: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(accepted["kind"], "response");

        // Only the session loop tolerates a bare newline. The handshake reader does not: the
        // handshake must be the connection's first line, and a blank one there is a protocol
        // error rather than keepalive.
        writeln!(addon).unwrap();

        writeln!(
            addon,
            "{}",
            serde_json::to_string(&json!({
                "protocolVersion": 2,
                "kind": "response",
                "id": "nobody-is-waiting",
                "result": {}
            }))
            .unwrap()
        )
        .unwrap();
        line.clear();
        reader.read_line(&mut line).unwrap();
        let stale: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(stale["error"]["code"], "stale_reply");

        // A reply nobody is waiting for is not a stray message to drop: the addon and the session
        // disagree about what is outstanding, and the only safe answer is to stop. The connection
        // is closed behind that error.
        // The session is done with this addon: the disagreement is recorded as the connection's
        // error, so the next caller is told what happened instead of waiting out a timeout.
        let refused = session
            .call(CallRequest {
                id: "after-stale-reply".to_owned(),
                command: "scene.list".to_owned(),
                params: json!({}),
                expected_revision: None,
                timeout_ms: Some(100),
            })
            .expect_err("a session that lost track of its requests cannot carry another");
        assert_eq!(refused.code, "stale_reply");
        session.stop();
    }

    /// A line past the envelope cap cannot be answered and cannot be skipped: the reader would
    /// have to guess where the next envelope begins, and every message after it would be framed
    /// against that guess. The addon is told which cap it passed, and the connection ends.
    #[test]
    fn an_oversized_envelope_is_refused_rather_than_truncated() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let address = listener.local_addr().expect("listener address");
        let session = RpcSession::start(listener, "a1".repeat(32), "/tmp/gofer/project".to_owned());

        let mut addon = addon_client(address);
        writeln!(addon, "{}", "x".repeat(MAX_ENVELOPE_BYTES + 1)).unwrap();

        let mut reader = BufReader::new(addon.try_clone().unwrap());
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        let refused: Value = serde_json::from_str(&line).unwrap();

        assert_eq!(refused["error"]["code"], "payload_too_large");
        assert_eq!(refused["kind"], "error");
        session.stop();
    }
}

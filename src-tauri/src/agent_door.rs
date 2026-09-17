//! The door other agents come through: JSON-RPC over HTTP on the loopback interface.
//!
//! One request per `POST`, one JSON reply, no event stream. Spoken over `std::net` on a thread of
//! its own, like `godot_rpc` and `model_server`, because the process has no async runtime outside
//! tests and three JSON-RPC methods are not a reason to grow one.
//!
//! Every tool the worker has is behind it, through the same router, so an agent in a terminal
//! edits the scene the way the model does: same revision check, same undo stack, same worktree.
//! What the door cannot do is wait on the user — it has no turn and no dialog — so a gated
//! operation and `ask_user` are refused by code, and the board asks the caller to name itself in
//! `owner` because the token is shared. It used to speak MCP and reach the board alone; the
//! `scripts/gofer.mjs` CLI is the client it is shaped for now.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Shutdown, SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde::Serialize;
use serde_json::{Value, json};
use tauri::{AppHandle, Runtime};

use crate::ai_tools::{CATALOG, ToolRequest, dispatch_from_outside};
use crate::settings::DoorSettings;

const PATH: &str = "/door";
/// Longest request body that will be read. A card is bounded at a chat message's size, and one
/// request carries one card.
const MAX_BODY_BYTES: usize = 2 * 1024 * 1024;
/// How long a client may hold the connection open without finishing its request. A client that
/// connected and went quiet is the only thing this bounds; a real request arrives in one write.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
/// Longest request line plus headers that will be read. Real ones are a few hundred bytes.
const MAX_HEAD_BYTES: usize = 16 * 1024;

static SERVER: Mutex<Option<Running>> = Mutex::new(None);

struct Running {
    address: SocketAddr,
    token: Arc<Mutex<String>>,
    stop: Arc<AtomicBool>,
    thread: Option<thread::JoinHandle<()>>,
}

/// What the settings page shows about the door: where it is, whether it is open, and why not.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DoorStatus {
    pub(crate) url: Option<String>,
    pub(crate) error: Option<String>,
}

static LAST_ERROR: Mutex<Option<String>> = Mutex::new(None);

pub(crate) fn status() -> DoorStatus {
    let url = SERVER
        .lock()
        .ok()
        .and_then(|server| server.as_ref().map(|running| url_of(running.address)));
    let error = LAST_ERROR.lock().ok().and_then(|error| error.clone());
    DoorStatus { url, error }
}

fn url_of(address: SocketAddr) -> String {
    format!("http://{address}{PATH}")
}

/// Brings the server in line with the settings: started, moved to another port, or given the
/// new token. A bind that fails is remembered for the settings page and is not fatal — the
/// window is the door that matters, and it is open regardless.
pub(crate) fn apply<R: Runtime>(app: &AppHandle<R>, settings: &DoorSettings) {
    let mut server = match SERVER.lock() {
        Ok(server) => server,
        Err(_) => return,
    };
    if !settings.enabled {
        if let Some(running) = server.take() {
            stop(running);
        }
        record_error(None);
        return;
    }
    if let Some(running) = server.as_ref()
        && running.address.port() == settings.port
    {
        if let Ok(mut token) = running.token.lock() {
            token.clone_from(&settings.token);
        }
        return;
    }
    if let Some(running) = server.take() {
        stop(running);
    }
    match start(app.clone(), settings) {
        Ok(running) => {
            *server = Some(running);
            record_error(None);
        }
        Err(error) => record_error(Some(error)),
    }
}

fn record_error(error: Option<String>) {
    if let Ok(mut last) = LAST_ERROR.lock() {
        *last = error;
    }
}

fn stop(mut running: Running) {
    running.stop.store(true, Ordering::Release);
    // The accept loop is blocked in `accept`; one connection is what wakes it to see the flag.
    let _ = TcpStream::connect(running.address);
    if let Some(thread) = running.thread.take() {
        let _ = thread.join();
    }
}

fn start<R: Runtime>(app: AppHandle<R>, settings: &DoorSettings) -> Result<Running, String> {
    let listener = TcpListener::bind(("127.0.0.1", settings.port))
        .map_err(|error| format!("Port {} could not be opened: {error}", settings.port))?;
    let address = listener
        .local_addr()
        .map_err(|error| format!("The door port could not be read back: {error}"))?;
    let token = Arc::new(Mutex::new(settings.token.clone()));
    let stop = Arc::new(AtomicBool::new(false));
    let thread = thread::Builder::new()
        .name("gofer-door".to_owned())
        .spawn({
            let token = Arc::clone(&token);
            let stop = Arc::clone(&stop);
            move || accept_loop(listener, app, token, stop)
        })
        .map_err(|error| format!("The door thread could not be started: {error}"))?;
    Ok(Running {
        address,
        token,
        stop,
        thread: Some(thread),
    })
}

fn accept_loop<R: Runtime>(
    listener: TcpListener,
    app: AppHandle<R>,
    token: Arc<Mutex<String>>,
    stop: Arc<AtomicBool>,
) {
    for stream in listener.incoming() {
        if stop.load(Ordering::Acquire) {
            break;
        }
        let Ok(stream) = stream else { continue };
        let app = app.clone();
        let token = Arc::clone(&token);
        let _ = thread::Builder::new()
            .name("gofer-door-request".to_owned())
            .spawn(move || serve(stream, &app, &token));
    }
}

fn serve<R: Runtime>(mut stream: TcpStream, app: &AppHandle<R>, token: &Mutex<String>) {
    let _ = stream.set_read_timeout(Some(REQUEST_TIMEOUT));
    let _ = stream.set_write_timeout(Some(REQUEST_TIMEOUT));
    let mut reader = BufReader::new(&mut stream);
    // The head is judged before a byte of body is read, so a stranger with the wrong token is
    // shown the door without being waited for.
    let response = match read_head(&mut reader) {
        Ok(head) => match admit(&head, token).and_then(|()| read_body(&mut reader, head.length)) {
            Ok(body) => answer(&body, app),
            Err(problem) => problem,
        },
        Err(problem) => problem,
    };
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
    let _ = stream.shutdown(Shutdown::Both);
}

struct HttpHead {
    method: String,
    path: String,
    authorization: Option<String>,
    length: usize,
}

/// Reads the request line and headers, or answers with the response their shape deserves.
///
/// Every line is read through a cap on the whole head, because `read_line` grows a `String`
/// for as long as bytes arrive: a client streaming a line with no newline in it would otherwise
/// be given the heap. A line cut by the cap ends without a newline, which is how it is told apart
/// from one that fitted.
fn read_head(reader: &mut BufReader<&mut TcpStream>) -> Result<HttpHead, String> {
    let bad_request = || http(400, "Bad Request", "");
    let mut head = reader.take(MAX_HEAD_BYTES as u64);
    let mut line = String::new();
    head.read_line(&mut line).map_err(|_| bad_request())?;
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or_default().to_owned();
    let path = parts.next().unwrap_or_default().to_owned();
    let mut authorization = None;
    let mut length = 0usize;
    let mut chunked = false;
    loop {
        line.clear();
        head.read_line(&mut line).map_err(|_| bad_request())?;
        if !line.ends_with('\n') {
            return Err(http(431, "Request Header Fields Too Large", ""));
        }
        let header = line.trim_end();
        if header.is_empty() {
            break;
        }
        let Some((name, value)) = header.split_once(':') else {
            continue;
        };
        match name.trim().to_ascii_lowercase().as_str() {
            "authorization" => authorization = Some(value.trim().to_owned()),
            "content-length" => length = value.trim().parse().map_err(|_| bad_request())?,
            "transfer-encoding" => chunked = true,
            _ => {}
        }
    }
    if chunked {
        return Err(http(411, "Length Required", ""));
    }
    if length > MAX_BODY_BYTES {
        return Err(http(413, "Content Too Large", ""));
    }
    Ok(HttpHead {
        method,
        path,
        authorization,
        length,
    })
}

/// The door: the right path, the right method, and the token — before anything else is read.
fn admit(head: &HttpHead, token: &Mutex<String>) -> Result<(), String> {
    if head.path != PATH {
        return Err(http(404, "Not Found", ""));
    }
    if head.method != "POST" {
        return Err(http(405, "Method Not Allowed", ""));
    }
    let expected = token.lock().map(|token| token.clone()).unwrap_or_default();
    let presented = head
        .authorization
        .as_deref()
        .and_then(|header| header.strip_prefix("Bearer "))
        .map(str::trim);
    if expected.is_empty() || !presented.is_some_and(|presented| same_token(presented, &expected)) {
        return Err(http(401, "Unauthorized", ""));
    }
    Ok(())
}

/// Compares in time that does not depend on where the first wrong byte is. Over loopback against a
/// 128-bit token the leak is not usable, but a plain `!=` is the one thing every reviewer flags.
fn same_token(presented: &str, expected: &str) -> bool {
    if presented.len() != expected.len() {
        return false;
    }
    presented
        .bytes()
        .zip(expected.bytes())
        .fold(0u8, |acc, (a, b)| acc | (a ^ b))
        == 0
}

fn read_body(reader: &mut BufReader<&mut TcpStream>, length: usize) -> Result<Vec<u8>, String> {
    let mut body = vec![0; length];
    reader
        .read_exact(&mut body)
        .map_err(|_| http(400, "Bad Request", ""))?;
    Ok(body)
}

fn http(status: u16, reason: &str, body: &str) -> String {
    format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
}

fn answer<R: Runtime>(body: &[u8], app: &AppHandle<R>) -> String {
    let Ok(message) = serde_json::from_slice::<Value>(body) else {
        return http(
            400,
            "Bad Request",
            &rpc_error(Value::Null, -32700, "The body is not JSON", Value::Null).to_string(),
        );
    };
    match respond(&message, app) {
        Some(reply) => http(200, "OK", &reply.to_string()),
        None => http(202, "Accepted", ""),
    }
}

/// One JSON-RPC message in, one reply out — or none, for a notification.
///
/// Three methods. `tools` is the catalogue the worker is given, whole, so the caller reads the
/// same operations and parameters the model does. `call` is one tool call in the worker's own
/// shape, `{tool, params}`, routed through the same door: a refusal arrives as a JSON-RPC error
/// whose `data` is the router's failure, code and all, rather than as prose to parse.
fn respond<R: Runtime>(message: &Value, app: &AppHandle<R>) -> Option<Value> {
    let id = message.get("id").cloned().unwrap_or(Value::Null);
    let method = message
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let params = message.get("params").cloned().unwrap_or_else(|| json!({}));
    if method.starts_with("notifications/") {
        return None;
    }
    let result = match method {
        "ping" => Ok(json!({})),
        "tools" => tools(&id),
        "call" => call(&id, &params, app),
        _ => Err(rpc_error(
            id.clone(),
            -32601,
            &format!("There is no method {method}; the door answers ping, tools and call"),
            Value::Null,
        )),
    };
    Some(match result {
        Ok(result) => json!({"jsonrpc": "2.0", "id": id, "result": result}),
        Err(error) => error,
    })
}

fn rpc_error(id: Value, code: i64, message: &str, data: Value) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message, "data": data}})
}

/// A tool call that was refused, as JSON-RPC spells it. The router's failure rides in `data`.
const TOOL_REFUSED: i64 = -32000;

/// The board as the door offers it, in the row shape the Godot domains are listed in: `params` is
/// a list of `{name, kind, required}`, so one parser reads the whole listing. `id` is required on
/// every op that names a card, because an outside agent has no task whose card an omitted id could
/// mean; `owner` signs the write and never changes whose card it is.
pub(crate) const BOARD_LISTING: &str = r#"[
    {"op": "list", "summary": "Every card without its body.", "params": []},
    {"op": "read", "summary": "One card with its comments.", "params": [
        {"name": "id", "kind": "int", "required": true}
    ]},
    {"op": "create", "summary": "Adds a card, to backlog unless a status is given; never to done.", "params": [
        {"name": "title", "kind": "text", "required": true},
        {"name": "body", "kind": "text", "required": false},
        {"name": "status", "kind": "choice", "of": ["backlog", "ready", "doing", "review"], "required": false},
        {"name": "owner", "kind": "text", "required": true, "note": "The name the write is signed with, shown as the card's owner on create and as the author on comment. On move and edit it signs and changes nothing else."}
    ]},
    {"op": "move", "summary": "Moves a card to a column other than done. The card keeps its owner.", "params": [
        {"name": "id", "kind": "int", "required": true},
        {"name": "status", "kind": "choice", "of": ["backlog", "ready", "doing", "review"], "required": true},
        {"name": "owner", "kind": "text", "required": true, "note": "Signs the write; the card's owner does not change."}
    ]},
    {"op": "comment", "summary": "Adds a comment under a card, by the name in owner.", "params": [
        {"name": "id", "kind": "int", "required": true},
        {"name": "body", "kind": "text", "required": true},
        {"name": "owner", "kind": "text", "required": true, "note": "The comment's author."}
    ]},
    {"op": "edit", "summary": "Changes a card's title or body; a field left out is left alone. The card keeps its owner.", "params": [
        {"name": "id", "kind": "int", "required": true},
        {"name": "title", "kind": "text", "required": false},
        {"name": "body", "kind": "text", "required": false},
        {"name": "owner", "kind": "text", "required": true, "note": "Signs the write; the card's owner does not change."}
    ]}
]"#;

/// Every shape a `tagged` value takes, one branch per Godot type, as the request half of
/// `value.schema.json` states them. A terminal caller has no repository to read the schema from,
/// and a Vector2 spelled `{"x": 0, "y": 14}` is refused rather than read.
const TAGGED_VALUES: &str = include_str!("../../protocol/schemas/v2/value.schema.json");

/// Every tool the door answers: the Godot domains as the worker receives them, and the board and
/// the memory beside them. The names are the `tool` of a `call`.
fn tools(id: &Value) -> Result<Value, Value> {
    let mut listed = Vec::with_capacity(CATALOG.len() + 2);
    for domain in CATALOG {
        let domain = serde_json::to_value(domain).map_err(|error| {
            rpc_error(
                id.clone(),
                -32603,
                &format!("The catalogue could not be listed: {error}"),
                Value::Null,
            )
        })?;
        listed.push(domain);
    }
    listed.push(json!({
        "name": crate::board::BOARD_TOOL,
        "operations": serde_json::from_str::<Value>(BOARD_LISTING).map_err(|error| {
            rpc_error(id.clone(), -32603, &format!("The board listing is not JSON: {error}"), Value::Null)
        })?,
    }));
    listed.push(json!({
        "name": crate::remember::REMEMBER_TOOL,
        "operations": [{
            "op": "remember",
            "summary": "Files a fact about this project as a memory candidate for the user to keep, against the task the model is on. The call takes no op: send kind and content alone.",
            "params": [
                {"name": "kind", "kind": "choice", "of": crate::storage::MEMORY_KINDS, "required": true},
                {"name": "content", "kind": "text", "required": true}
            ]
        }]
    }));
    let tagged = serde_json::from_str::<Value>(TAGGED_VALUES)
        .ok()
        .and_then(|schema| schema.get("oneOf").cloned())
        .ok_or_else(|| {
            rpc_error(
                id.clone(),
                -32603,
                "The tagged value shapes could not be listed",
                Value::Null,
            )
        })?;
    Ok(json!({
        "tools": listed,
        "values": {
            "note": "A parameter of kind `tagged` is {\"type\": <Godot type>, \"value\": <payload>}; these are the payload each type takes.",
            "oneOf": tagged
        }
    }))
}

/// Routes one call and shapes what came back: the answer, or the failure with its code.
fn call<R: Runtime>(id: &Value, params: &Value, app: &AppHandle<R>) -> Result<Value, Value> {
    let Some(tool) = params.get("tool").and_then(Value::as_str) else {
        return Err(rpc_error(
            id.clone(),
            -32602,
            "`tool` names the tool to call, and `params` carries its parameters",
            Value::Null,
        ));
    };
    let request = ToolRequest {
        tool: tool.to_owned(),
        params: params.get("params").cloned().unwrap_or_else(|| json!({})),
    };
    dispatch_from_outside(app, request).map_err(|failure| {
        rpc_error(
            id.clone(),
            TOOL_REFUSED,
            &format!("{}: {}", failure.code, failure.message),
            serde_json::to_value(&failure).unwrap_or(Value::Null),
        )
    })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::storage::{CardStatus, NewCard, ProjectStorage, StorageSlot};
    use std::fs;
    use tauri::Manager;
    use tempfile::TempDir;

    pub(crate) fn app_with_storage(directory: &TempDir) -> tauri::App<tauri::test::MockRuntime> {
        let workspace = directory.path().join("workspace");
        fs::create_dir(&workspace).expect("workspace directory");
        let storage =
            ProjectStorage::open(&directory.path().join("data"), &workspace).expect("storage");
        let app = tauri::test::mock_builder()
            .build(crate::app_context())
            .expect("build mock Tauri app");
        app.manage(StorageSlot::new(Ok(storage)));
        app
    }

    /// Speaks HTTP to the server the way a client would, and answers with status and body.
    fn post(address: SocketAddr, path: &str, token: Option<&str>, body: &str) -> (u16, Value) {
        let mut stream = TcpStream::connect(address).expect("connect");
        let auth = token.map_or(String::new(), |token| {
            format!("Authorization: Bearer {token}\r\n")
        });
        write!(
            stream,
            "POST {path} HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\n{auth}Content-Length: {}\r\n\r\n{body}",
            body.len()
        )
        .expect("send");
        let mut answer = String::new();
        stream.read_to_string(&mut answer).expect("read");
        let (head, body) = answer.split_once("\r\n\r\n").expect("a head and a body");
        let status: u16 = head
            .split_whitespace()
            .nth(1)
            .and_then(|status| status.parse().ok())
            .expect("a status");
        let body = if body.is_empty() {
            Value::Null
        } else {
            serde_json::from_str(body).expect("json")
        };
        (status, body)
    }

    fn rpc(method: &str, params: Value) -> String {
        json!({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).to_string()
    }

    fn call(tool: &str, params: Value) -> String {
        rpc("call", json!({"tool": tool, "params": params}))
    }

    fn started(app: &tauri::App<tauri::test::MockRuntime>, token: &str) -> Running {
        start(
            app.handle().clone(),
            &DoorSettings {
                enabled: true,
                port: 0,
                token: token.to_owned(),
            },
        )
        .expect("the server starts on a free port")
    }

    /// The code the router refused with, off a `call` that was refused.
    fn refusal(body: &Value) -> &str {
        body["error"]["data"]["code"]
            .as_str()
            .expect("a refused call carries the router's failure in data")
    }

    #[test]
    fn the_door_needs_the_token_and_the_path() {
        let directory = TempDir::new().expect("temporary directory");
        let app = app_with_storage(&directory);
        let server = started(&app, "secret");

        let (status, _) = post(server.address, PATH, None, &rpc("ping", json!({})));
        assert_eq!(status, 401, "no token");
        let (status, _) = post(server.address, PATH, Some("wrong"), &rpc("ping", json!({})));
        assert_eq!(status, 401, "wrong token");
        let (status, _) = post(server.address, "/", Some("secret"), &rpc("ping", json!({})));
        assert_eq!(status, 404, "wrong path");
        let (status, body) = post(
            server.address,
            PATH,
            Some("secret"),
            &rpc("ping", json!({})),
        );
        assert_eq!(status, 200);
        assert_eq!(body["result"], json!({}));

        stop(server);
    }

    #[test]
    fn a_client_lists_every_tool_and_works_a_card_by_its_own_name() {
        let directory = TempDir::new().expect("temporary directory");
        let app = app_with_storage(&directory);
        let server = started(&app, "secret");
        let token = Some("secret");

        let (status, body) = post(
            server.address,
            PATH,
            token,
            &json!({"jsonrpc": "2.0", "method": "notifications/initialized"}).to_string(),
        );
        assert_eq!(status, 202, "a notification gets no reply");
        assert_eq!(body, Value::Null);

        let (_, body) = post(server.address, PATH, token, &rpc("tools", json!({})));
        let names: Vec<&str> = body["result"]["tools"]
            .as_array()
            .expect("tools")
            .iter()
            .map(|tool| tool["name"].as_str().expect("name"))
            .collect();
        for domain in CATALOG {
            assert!(
                names.contains(&domain.name),
                "{} is behind the door",
                domain.name
            );
        }
        assert!(names.contains(&"board"));
        let node = body["result"]["tools"]
            .as_array()
            .expect("tools")
            .iter()
            .find(|tool| tool["name"] == "godot_node")
            .expect("the node domain");
        assert!(
            node["operations"]
                .as_array()
                .expect("operations")
                .iter()
                .any(|operation| operation["op"] == "inspect"),
            "a domain is listed with the operations the worker sees"
        );

        let (_, body) = post(
            server.address,
            PATH,
            token,
            &call(
                "board",
                json!({"op": "create", "title": "Jump", "body": "Higher", "owner": "claude"}),
            ),
        );
        let card_id = body["result"]["id"]
            .as_u64()
            .expect("the card is named by its number");
        assert_eq!(body["result"]["owner"], json!("claude"));

        let (_, body) = post(
            server.address,
            PATH,
            token,
            &call(
                "board",
                json!({"op": "comment", "id": card_id, "body": "On it", "owner": "claude"}),
            ),
        );
        assert!(body.get("error").is_none(), "{body}");

        let (_, body) = post(
            server.address,
            PATH,
            token,
            &call(
                "board",
                json!({"op": "move", "id": card_id, "status": "ready", "owner": "claude"}),
            ),
        );
        assert_eq!(body["result"]["status"], json!("ready"));

        let (_, body) = post(
            server.address,
            PATH,
            token,
            &call("board", json!({"op": "read", "id": format!("#{card_id}")})),
        );
        assert_eq!(body["result"]["comments"][0]["author"], json!("claude"));

        let (_, body) = post(
            server.address,
            PATH,
            token,
            &call("board", json!({"op": "list"})),
        );
        let cards = &body["result"]["cards"];
        assert_eq!(cards.as_array().map(Vec::len), Some(1));
        assert_eq!(cards[0].get("body"), None, "the list leaves bodies to read");

        let (_, body) = post(
            server.address,
            PATH,
            token,
            &call(
                "board",
                json!({"op": "edit", "id": card_id, "title": "Jump higher", "owner": "claude"}),
            ),
        );
        assert_eq!(body["result"]["title"], json!("Jump higher"));

        stop(server);
    }

    #[test]
    fn a_refusal_is_a_coded_error_the_caller_can_branch_on() {
        let directory = TempDir::new().expect("temporary directory");
        let app = app_with_storage(&directory);
        let server = started(&app, "secret");
        let token = Some("secret");

        let (status, body) = post(
            server.address,
            PATH,
            token,
            &call(
                "board",
                json!({"op": "move", "id": "x", "status": "done", "owner": "claude"}),
            ),
        );
        assert_eq!(status, 200, "a refusal is a reply, not a transport fault");
        assert_eq!(body["error"]["code"], json!(TOOL_REFUSED));
        assert_eq!(refusal(&body), "card_not_found");

        let (_, body) = post(
            server.address,
            PATH,
            token,
            &call("board", json!({"op": "create", "title": "Jump"})),
        );
        assert_eq!(refusal(&body), "invalid_params");
        assert!(
            body["error"]["message"]
                .as_str()
                .expect("message")
                .contains("`owner` is required")
        );

        let (_, body) = post(
            server.address,
            PATH,
            token,
            &call(
                "board",
                json!({"op": "create", "title": "Jump", "owner": "claude", "status": "done"}),
            ),
        );
        assert_eq!(refusal(&body), "card_locked");

        let body = call_between_turns(server.address, "card_post_to_gofer", json!({"id": "x"}));
        assert_eq!(refusal(&body), "unknown_tool");

        let (_, body) = post(server.address, PATH, token, &rpc("tools/list", json!({})));
        assert_eq!(body["error"]["code"], json!(-32601));

        let (_, body) = post(
            server.address,
            PATH,
            token,
            &rpc("call", json!({"params": {}})),
        );
        assert_eq!(body["error"]["code"], json!(-32602));

        let (status, _) = post(server.address, PATH, token, "not json");
        assert_eq!(status, 400);

        stop(server);
    }

    /// The door has nobody to click for it: a gated operation and a question are refused by
    /// code, at once, with nothing run — never waited on.
    #[test]
    fn what_would_wait_on_the_user_is_refused_by_code() {
        let directory = TempDir::new().expect("temporary directory");
        let app = app_with_storage(&directory);
        let server = started(&app, "secret");

        let body = call_between_turns(
            server.address,
            "godot_resource",
            json!({"ops": [{"op": "delete", "path": "res://old.tres"}]}),
        );
        assert_eq!(refusal(&body), "approval_needed", "{body}");
        assert_eq!(
            body["error"]["data"]["details"]["gated"][0]["op"],
            json!("delete")
        );

        let body = call_between_turns(
            server.address,
            crate::ask::ASK_USER_TOOL,
            json!({"question": "Which one?", "options": ["a", "b"]}),
        );
        assert_eq!(refusal(&body), "needs_user", "{body}");

        stop(server);
    }

    #[test]
    fn applying_new_settings_moves_the_port_and_changes_the_token_in_place() {
        let directory = TempDir::new().expect("temporary directory");
        let app = app_with_storage(&directory);
        let first = started(&app, "one");
        let (status, _) = post(first.address, PATH, Some("one"), &rpc("ping", json!({})));
        assert_eq!(status, 200);

        if let Ok(mut token) = first.token.lock() {
            *token = "two".to_owned();
        }
        let (status, _) = post(first.address, PATH, Some("one"), &rpc("ping", json!({})));
        assert_eq!(status, 401, "the old token stops working at once");
        let (status, _) = post(first.address, PATH, Some("two"), &rpc("ping", json!({})));
        assert_eq!(status, 200);

        let address = first.address;
        stop(first);
        let refused = TcpStream::connect(address);
        assert!(refused.is_err(), "the stopped server no longer accepts");
    }

    /// Speaks whatever bytes it is given and reads the status line back.
    fn raw(address: SocketAddr, request: &[u8]) -> u16 {
        let mut stream = TcpStream::connect(address).expect("connect");
        stream.write_all(request).expect("send");
        let mut answer = String::new();
        stream.read_to_string(&mut answer).expect("read");
        answer
            .split_whitespace()
            .nth(1)
            .and_then(|status| status.parse().ok())
            .expect("a status")
    }

    /// Claim 1: a header the size of a novel is refused, not buffered.
    #[test]
    fn a_header_block_past_the_cap_is_refused() {
        let directory = TempDir::new().expect("temporary directory");
        let app = app_with_storage(&directory);
        let server = started(&app, "secret");
        let novel = "x".repeat(MAX_HEAD_BYTES + 1);
        let request = format!(
            "POST {PATH} HTTP/1.1\r\nAuthorization: Bearer secret\r\nX-Novel: {novel}\r\nContent-Length: 0\r\n\r\n"
        );
        assert_eq!(raw(server.address, request.as_bytes()), 431);
        stop(server);
    }

    /// Claim 4: the token is checked before a byte of body is read, so a stranger cannot make
    /// the server wait for a body that never comes.
    #[test]
    fn a_wrong_token_is_refused_before_the_body_is_waited_for() {
        let directory = TempDir::new().expect("temporary directory");
        let app = app_with_storage(&directory);
        let server = started(&app, "secret");
        let request = format!(
            "POST {PATH} HTTP/1.1\r\nAuthorization: Bearer wrong\r\nContent-Length: 100\r\n\r\n"
        );
        assert_eq!(raw(server.address, request.as_bytes()), 401);
        stop(server);
    }

    /// Claim 13: a chunked body is named as the problem rather than read as nothing.
    #[test]
    fn a_chunked_body_is_told_to_send_a_length() {
        let directory = TempDir::new().expect("temporary directory");
        let app = app_with_storage(&directory);
        let server = started(&app, "secret");
        let request = format!(
            "POST {PATH} HTTP/1.1\r\nAuthorization: Bearer secret\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n"
        );
        assert_eq!(raw(server.address, request.as_bytes()), 411);
        stop(server);
    }

    /// Claim 23: while the model works a card's task, the door is told so.
    #[test]
    fn a_card_being_worked_on_is_refused_at_the_door() {
        let directory = TempDir::new().expect("temporary directory");
        let app = app_with_storage(&directory);
        let storage = crate::workspace::project_storage(app.handle()).expect("storage");
        let nothing_to_stop = |_: &std::path::Path| Ok(());
        let switch = storage.switch_with_no_turn_to_refuse(&nothing_to_stop);
        let task_id = storage
            .tasks()
            .create(&switch)
            .expect("task")
            .task_id
            .expect("task id");
        let card = storage
            .board()
            .create(
                &NewCard {
                    title: "Jump".to_owned(),
                    body: String::new(),
                    owner: "user".to_owned(),
                    status: CardStatus::Ready,
                    attachments: Vec::new(),
                },
                crate::storage::Actor::User,
            )
            .expect("card");
        storage
            .board()
            .attach_task(&card.id, &task_id)
            .expect("attach");
        let server = started(&app, "secret");

        let turn = holding_the_provider_bit();
        let (_, body) = post(
            server.address,
            PATH,
            Some("secret"),
            &call(
                "board",
                json!({"op": "comment", "id": card.id, "body": "hurry", "owner": "claude"}),
            ),
        );
        drop(turn);
        assert_eq!(refusal(&body), "card_in_progress");

        // Another test may hold the bit for a moment; between turns is the claim, so keep asking
        // until a call lands between two.
        let body = until(|| {
            let (_, body) = post(
                server.address,
                PATH,
                Some("secret"),
                &call(
                    "board",
                    json!({"op": "comment", "id": card.id, "body": "later", "owner": "claude"}),
                ),
            );
            (body.get("error").is_none()).then_some(body)
        });
        assert!(
            body.get("error").is_none(),
            "between turns it is open: {body}"
        );
        stop(server);
    }

    /// Polls fast until the closure answers, and fails by name rather than hanging the suite when
    /// it never does. The bound is a ceiling on a test gone wrong, not a wait anything is expected
    /// to take.
    fn until<T>(mut attempt: impl FnMut() -> Option<T>) -> T {
        let deadline = std::time::Instant::now() + Duration::from_secs(30);
        loop {
            if let Some(answer) = attempt() {
                return answer;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "the condition never held within the ceiling"
            );
            std::thread::yield_now();
        }
    }

    /// One call from outside, sent again while some other test holds the turn's bit.
    fn call_between_turns(address: SocketAddr, tool: &str, params: Value) -> Value {
        until(|| {
            let (_, body) = post(address, PATH, Some("secret"), &call(tool, params.clone()));
            (body.get("error").is_none() || refusal(&body) != "turn_running").then_some(body)
        })
    }

    /// The bit is process-wide and other tests take it; wait for a turn at holding it.
    fn holding_the_provider_bit() -> crate::ai_turn::AiProviderOperation {
        until(|| crate::ai_turn::begin_provider_operation().ok())
    }

    /// Finding from review: the read ledger and the scene revision are one slot per worktree, so
    /// a door call during a turn would guard each agent with the other's last read. The door
    /// takes the turn's own bit, and says so when it cannot.
    #[test]
    fn a_godot_call_from_the_door_waits_for_no_turn_and_says_one_is_running() {
        let directory = TempDir::new().expect("temporary directory");
        let app = app_with_storage(&directory);
        let server = started(&app, "secret");
        let token = Some("secret");

        let turn = holding_the_provider_bit();
        let (_, body) = post(
            server.address,
            PATH,
            token,
            &call("godot_scene", json!({"ops": [{"op": "list"}]})),
        );
        assert_eq!(refusal(&body), "turn_running", "{body}");
        assert_eq!(
            body["error"]["data"]["retryable"],
            json!(true),
            "the same call is right once the turn ends"
        );
        let (_, body) = post(
            server.address,
            PATH,
            token,
            &call(
                crate::remember::REMEMBER_TOOL,
                json!({"kind": "decision", "content": "x"}),
            ),
        );
        assert_eq!(refusal(&body), "turn_running", "memory is the turn's too");
        let (_, body) = post(
            server.address,
            PATH,
            token,
            &call("board", json!({"op": "list"})),
        );
        assert!(
            body.get("error").is_none(),
            "the board has its own lock: {body}"
        );
        drop(turn);

        let body = call_between_turns(
            server.address,
            "godot_scene",
            json!({"ops": [{"op": "list"}]}),
        );
        assert_ne!(
            refusal(&body),
            "turn_running",
            "after the turn the call reaches the router: {body}"
        );
        stop(server);
    }

    /// Finding from review: the listing said `remember` took an `op`; it takes `kind` and
    /// `content`. The listing is now the shape the handler accepts, and this proves it.
    #[test]
    fn the_hand_written_listings_are_the_shapes_the_handlers_take() {
        let directory = TempDir::new().expect("temporary directory");
        let app = app_with_storage(&directory);
        let server = started(&app, "secret");
        let token = Some("secret");

        let (_, listed) = post(server.address, PATH, token, &rpc("tools", json!({})));
        let tools = listed["result"]["tools"].as_array().expect("tools");
        let remember = tools
            .iter()
            .find(|tool| tool["name"] == crate::remember::REMEMBER_TOOL)
            .expect("remember is listed");
        let params = remember["operations"][0]["params"]
            .as_array()
            .expect("params are a list, as every Godot row lists them");
        let kind = params
            .iter()
            .find(|param| param["name"] == "kind")
            .expect("kind");
        let kinds: Vec<&str> = kind["of"]
            .as_array()
            .expect("kinds")
            .iter()
            .map(|kind| kind.as_str().expect("kind"))
            .collect();
        assert_eq!(kinds, crate::storage::MEMORY_KINDS);
        assert!(
            params
                .iter()
                .any(|param| param["name"] == "content" && param["kind"] == "text")
        );
        for tool in tools {
            for operation in tool["operations"].as_array().expect("operations") {
                for param in operation["params"]
                    .as_array()
                    .expect("every row lists params")
                {
                    assert!(
                        param["name"].is_string()
                            && param["kind"].is_string()
                            && param["required"].is_boolean(),
                        "{} lists a param in the shared shape: {param}",
                        tool["name"]
                    );
                }
            }
        }
        assert!(
            listed["result"]["values"]["oneOf"]
                .as_array()
                .expect("tagged value branches")
                .iter()
                .any(|branch| branch["properties"]["type"]["const"] == "Vector2"),
            "the tagged value shapes travel with the listing"
        );
        // Not called live: the handler runs the embedder, seconds under the turn's bit, and the
        // turn tests would be refused for it. The shape is pinned against the handler's own list.

        let board = tools
            .iter()
            .find(|tool| tool["name"] == crate::board::BOARD_TOOL)
            .expect("board is listed");
        for operation in board["operations"].as_array().expect("operations") {
            let op = operation["op"].as_str().expect("op");
            let mut params =
                json!({"op": op, "owner": "claude", "title": "t", "body": "b", "status": "ready"});
            if operation["params"]
                .as_array()
                .expect("params")
                .iter()
                .any(|param| param["name"] == "id")
            {
                params["id"] = json!("#1");
            }
            let (_, body) = post(server.address, PATH, token, &call("board", params));
            let message = body["error"]["message"].as_str().unwrap_or_default();
            assert!(
                !message.contains("board needs an `op`"),
                "{op} is an op the board takes: {body}"
            );
        }
        stop(server);
    }

    /// Finding from review: an omitted id meant the worker's own card, which an outside agent
    /// has no business writing on by accident.
    #[test]
    fn a_door_write_with_no_id_is_refused_rather_than_aimed_at_the_workers_card() {
        let directory = TempDir::new().expect("temporary directory");
        let app = app_with_storage(&directory);
        let server = started(&app, "secret");
        let token = Some("secret");
        for op in ["read", "move", "comment", "edit"] {
            let (_, body) = post(
                server.address,
                PATH,
                token,
                &call(
                    "board",
                    json!({"op": op, "owner": "claude", "body": "x", "status": "ready"}),
                ),
            );
            assert_eq!(refusal(&body), "invalid_params", "{op}: {body}");
            assert!(
                body["error"]["message"]
                    .as_str()
                    .expect("message")
                    .contains("`id` is required"),
                "{op}: {body}"
            );
        }
        stop(server);
    }

    /// Finding from review: a refusal that crosses domains named only the first one's gated
    /// operations, while saying the whole call was described.
    #[test]
    fn a_gated_refusal_names_every_gated_operation_across_domains() {
        let directory = TempDir::new().expect("temporary directory");
        let app = app_with_storage(&directory);
        let server = started(&app, "secret");
        let body = call_between_turns(
            server.address,
            "godot",
            json!({"ops": [
                {"op": "resource.delete", "path": "res://a.tres"},
                {"op": "project.set_plugin_enabled", "plugin": "x", "enabled": true}
            ]}),
        );
        assert_eq!(refusal(&body), "approval_needed", "{body}");
        let gated = body["error"]["data"]["details"]["gated"]
            .as_array()
            .expect("gated");
        let named: Vec<(&str, &str)> = gated
            .iter()
            .map(|call| {
                (
                    call["tool"].as_str().expect("tool"),
                    call["op"].as_str().expect("op"),
                )
            })
            .collect();
        assert_eq!(
            named,
            [
                ("godot_resource", "delete"),
                ("godot_project", "set_plugin_enabled")
            ]
        );
        let (_, body) = post(
            server.address,
            PATH,
            Some("secret"),
            &rpc("call", json!({"params": {}})),
        );
        assert_eq!(body["id"], json!(1), "an error keeps the request's id");
        stop(server);
    }

    #[test]
    fn a_disabled_door_is_shut_by_apply() {
        let directory = TempDir::new().expect("temporary directory");
        let app = app_with_storage(&directory);
        let shut = DoorSettings {
            enabled: false,
            port: 0,
            token: "secret".to_owned(),
        };
        let running = started(&app, "secret");
        let address = running.address;
        *SERVER.lock().expect("server slot") = Some(running);
        apply(app.handle(), &shut);
        assert!(
            SERVER.lock().expect("server slot").is_none(),
            "apply shuts it"
        );
        assert!(TcpStream::connect(address).is_err(), "and nothing listens");
        assert_eq!(
            status(),
            DoorStatus {
                url: None,
                error: None
            }
        );
    }
}

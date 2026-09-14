//! The door other agents come through: an MCP server over HTTP on the loopback interface.
//!
//! It speaks the streamable-HTTP transport in its plainest form — one JSON-RPC request per `POST`,
//! one JSON reply, no event stream — which is all a client needs to list and call tools. Spoken
//! over `std::net` on a thread of its own, like `godot_rpc` and `model_server`, because the process
//! has no async runtime outside tests and five JSON-RPC methods are not a reason to grow one.
//!
//! Six tools, one per board operation, and nothing that reaches a file. A caller names itself in
//! `owner` on every write, because the token is shared and the board is the only place the name
//! is kept.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Shutdown, SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde::Serialize;
use serde_json::{Value, json};
use tauri::{AppHandle, Runtime};

use crate::board::{announce_change, outside_actor};
use crate::command_error::CommandError;
use crate::settings::McpSettings;
use crate::storage::{CardEdit, CardStatus, NewCard};

const PATH: &str = "/mcp";
const PROTOCOL_VERSION: &str = "2025-06-18";
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
pub(crate) struct McpStatus {
    pub(crate) url: Option<String>,
    pub(crate) error: Option<String>,
}

static LAST_ERROR: Mutex<Option<String>> = Mutex::new(None);

pub(crate) fn status() -> McpStatus {
    let url = SERVER
        .lock()
        .ok()
        .and_then(|server| server.as_ref().map(|running| url_of(running.address)));
    let error = LAST_ERROR.lock().ok().and_then(|error| error.clone());
    McpStatus { url, error }
}

fn url_of(address: SocketAddr) -> String {
    format!("http://{address}{PATH}")
}

/// Brings the server in line with the settings: started, moved to another port, or given the
/// new token. A bind that fails is remembered for the settings page and is not fatal — the
/// window is the door that matters, and it is open regardless.
pub(crate) fn apply<R: Runtime>(app: &AppHandle<R>, settings: &McpSettings) {
    let mut server = match SERVER.lock() {
        Ok(server) => server,
        Err(_) => return,
    };
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

fn start<R: Runtime>(app: AppHandle<R>, settings: &McpSettings) -> Result<Running, String> {
    let listener = TcpListener::bind(("127.0.0.1", settings.port))
        .map_err(|error| format!("Port {} could not be opened: {error}", settings.port))?;
    let address = listener
        .local_addr()
        .map_err(|error| format!("The MCP port could not be read back: {error}"))?;
    let token = Arc::new(Mutex::new(settings.token.clone()));
    let stop = Arc::new(AtomicBool::new(false));
    let thread = thread::Builder::new()
        .name("gofer-mcp".to_owned())
        .spawn({
            let token = Arc::clone(&token);
            let stop = Arc::clone(&stop);
            move || accept_loop(listener, app, token, stop)
        })
        .map_err(|error| format!("The MCP thread could not be started: {error}"))?;
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
            .name("gofer-mcp-request".to_owned())
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
    if expected.is_empty() || presented != Some(expected.as_str()) {
        return Err(http(401, "Unauthorized", ""));
    }
    Ok(())
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
            &rpc_error(Value::Null, -32700, "The body is not JSON").to_string(),
        );
    };
    match respond(&message, app) {
        Some(reply) => http(200, "OK", &reply.to_string()),
        None => http(202, "Accepted", ""),
    }
}

/// One JSON-RPC message in, one reply out — or none, for a notification.
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
        "initialize" => Ok(json!({
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "gofer", "version": env!("CARGO_PKG_VERSION")},
            "instructions": INSTRUCTIONS,
        })),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({"tools": tools()})),
        "tools/call" => Ok(call(&params, app)),
        _ => Err((-32601, format!("There is no method {method}"))),
    };
    Some(match result {
        Ok(result) => json!({"jsonrpc": "2.0", "id": id, "result": result}),
        Err((code, message)) => rpc_error(id, code, &message),
    })
}

fn rpc_error(id: Value, code: i64, message: &str) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}})
}

const INSTRUCTIONS: &str = "This is the project board of a Gofer workspace: cards in five columns \
    (backlog, ready, doing, review, done). You may read and write cards and comments and nothing \
    else. Name yourself in `owner` on every write. A card in `done` is locked, and so is a card \
    whose task Gofer is working on right now; only the user finishes a card, by merging its task.";

fn tool(name: &str, description: &str, properties: Value, required: &[&str]) -> Value {
    json!({
        "name": name,
        "description": description,
        "inputSchema": {
            "type": "object",
            "properties": properties,
            "required": required,
            "additionalProperties": false
        }
    })
}

fn tools() -> Vec<Value> {
    let owner = json!({"type": "string", "description": "Who is writing: your own name."});
    let id = json!({"type": "string"});
    let status = json!({"type": "string", "enum": CardStatus::ALL.map(CardStatus::as_str)});
    vec![
        tool(
            "board_list",
            "Every card on the board, column by column.",
            json!({}),
            &[],
        ),
        tool(
            "card_read",
            "One card with all of its comments.",
            json!({"id": id}),
            &["id"],
        ),
        tool(
            "card_create",
            "Adds a card. Goes to backlog unless a status is given; done is not allowed.",
            json!({"title": {"type": "string"}, "body": {"type": "string"}, "status": status, "owner": owner}),
            &["title", "owner"],
        ),
        tool(
            "card_move",
            "Moves a card to another column. Never to done.",
            json!({"id": id, "status": status, "owner": owner}),
            &["id", "status", "owner"],
        ),
        tool(
            "card_comment",
            "Adds a comment under a card.",
            json!({"id": id, "body": {"type": "string"}, "owner": owner}),
            &["id", "body", "owner"],
        ),
        tool(
            "card_edit",
            "Changes a card's title or body. A field left out is left alone.",
            json!({"id": id, "title": {"type": "string"}, "body": {"type": "string"}, "owner": owner}),
            &["id", "owner"],
        ),
    ]
}

/// Runs one tool call and shapes the outcome the way MCP wants it: a result either way, with
/// `isError` saying which, so the calling model reads the refusal rather than a transport fault.
fn call<R: Runtime>(params: &Value, app: &AppHandle<R>) -> Value {
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let arguments = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));
    match run(name, &arguments, app) {
        Ok(result) => json!({
            "content": [{"type": "text", "text": result.to_string()}],
            "structuredContent": result,
            "isError": false
        }),
        Err(failure) => json!({
            "content": [{"type": "text", "text": format!("{}: {}", failure.code, failure.message)}],
            "isError": true
        }),
    }
}

fn text<'a>(arguments: &'a Value, key: &str) -> Option<&'a str> {
    arguments.get(key).and_then(Value::as_str)
}

fn required<'a>(arguments: &'a Value, key: &str) -> Result<&'a str, CommandError> {
    text(arguments, key)
        .ok_or_else(|| CommandError::new("invalid_params", format!("`{key}` is required")))
}

fn status_of(arguments: &Value) -> Result<Option<CardStatus>, CommandError> {
    let Some(named) = text(arguments, "status") else {
        return Ok(None);
    };
    CardStatus::parse(named).map(Some).ok_or_else(|| {
        CommandError::new(
            "invalid_params",
            "`status` is one of backlog, ready, doing, review, done",
        )
    })
}

fn run<R: Runtime>(
    name: &str,
    arguments: &Value,
    app: &AppHandle<R>,
) -> Result<Value, CommandError> {
    let storage = crate::workspace::project_storage(app)
        .map_err(|failure| CommandError::new("workspace_not_open", failure.message))?;
    let board = storage.board();
    let answer = match name {
        "board_list" => json!({"cards": board.list()?}),
        "card_read" => json!(board.read(required(arguments, "id")?)?),
        "card_create" => {
            let owner = required(arguments, "owner")?;
            let card = NewCard {
                title: required(arguments, "title")?.to_owned(),
                body: text(arguments, "body").unwrap_or_default().to_owned(),
                owner: owner.to_owned(),
                status: status_of(arguments)?.unwrap_or(CardStatus::Backlog),
            };
            json!(board.create(&card, outside_actor())?)
        }
        "card_move" => {
            required(arguments, "owner")?;
            let status = status_of(arguments)?
                .ok_or_else(|| CommandError::new("invalid_params", "`status` is required"))?;
            json!(board.move_to(required(arguments, "id")?, status, outside_actor())?)
        }
        "card_comment" => {
            let owner = required(arguments, "owner")?;
            json!(board.comment(
                required(arguments, "id")?,
                owner,
                required(arguments, "body")?,
                outside_actor()
            )?)
        }
        "card_edit" => {
            required(arguments, "owner")?;
            let edit = CardEdit {
                title: text(arguments, "title").map(str::to_owned),
                body: text(arguments, "body").map(str::to_owned),
                owner: None,
            };
            json!(board.edit(required(arguments, "id")?, &edit, outside_actor())?)
        }
        other => {
            return Err(CommandError::new(
                "unknown_tool",
                format!("There is no tool {other}"),
            ));
        }
    };
    if name != "board_list" && name != "card_read" {
        announce_change(app);
    }
    Ok(answer)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::{ProjectStorage, StorageSlot};
    use std::fs;
    use tauri::Manager;
    use tempfile::TempDir;

    fn app_with_storage(directory: &TempDir) -> tauri::App<tauri::test::MockRuntime> {
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

    fn call(name: &str, arguments: Value) -> String {
        rpc("tools/call", json!({"name": name, "arguments": arguments}))
    }

    fn started(app: &tauri::App<tauri::test::MockRuntime>, token: &str) -> Running {
        start(
            app.handle().clone(),
            &McpSettings {
                port: 0,
                token: token.to_owned(),
            },
        )
        .expect("the server starts on a free port")
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
    fn a_client_initializes_lists_the_tools_and_works_a_card() {
        let directory = TempDir::new().expect("temporary directory");
        let app = app_with_storage(&directory);
        let server = started(&app, "secret");
        let token = Some("secret");

        let (_, body) = post(server.address, PATH, token, &rpc("initialize", json!({})));
        assert_eq!(body["result"]["protocolVersion"], json!(PROTOCOL_VERSION));
        assert_eq!(body["result"]["capabilities"]["tools"], json!({}));

        let (status, body) = post(
            server.address,
            PATH,
            token,
            &json!({"jsonrpc": "2.0", "method": "notifications/initialized"}).to_string(),
        );
        assert_eq!(status, 202, "a notification gets no reply");
        assert_eq!(body, Value::Null);

        let (_, body) = post(server.address, PATH, token, &rpc("tools/list", json!({})));
        let names: Vec<&str> = body["result"]["tools"]
            .as_array()
            .expect("tools")
            .iter()
            .map(|tool| tool["name"].as_str().expect("name"))
            .collect();
        assert_eq!(
            names,
            [
                "board_list",
                "card_read",
                "card_create",
                "card_move",
                "card_comment",
                "card_edit"
            ]
        );

        let (_, body) = post(
            server.address,
            PATH,
            token,
            &call(
                "card_create",
                json!({"title": "Jump", "body": "Higher", "owner": "claude"}),
            ),
        );
        assert_eq!(body["result"]["isError"], json!(false));
        let card_id = body["result"]["structuredContent"]["id"]
            .as_str()
            .expect("the card id")
            .to_owned();
        assert_eq!(
            body["result"]["structuredContent"]["owner"],
            json!("claude")
        );

        let (_, body) = post(
            server.address,
            PATH,
            token,
            &call(
                "card_comment",
                json!({"id": card_id, "body": "On it", "owner": "claude"}),
            ),
        );
        assert_eq!(body["result"]["isError"], json!(false));

        let (_, body) = post(
            server.address,
            PATH,
            token,
            &call(
                "card_move",
                json!({"id": card_id, "status": "ready", "owner": "claude"}),
            ),
        );
        assert_eq!(
            body["result"]["structuredContent"]["status"],
            json!("ready")
        );

        let (_, body) = post(
            server.address,
            PATH,
            token,
            &call("card_read", json!({"id": card_id})),
        );
        assert_eq!(
            body["result"]["structuredContent"]["comments"][0]["author"],
            json!("claude")
        );

        let (_, body) = post(server.address, PATH, token, &call("board_list", json!({})));
        assert_eq!(
            body["result"]["structuredContent"]["cards"]
                .as_array()
                .map(Vec::len),
            Some(1)
        );

        stop(server);
    }

    #[test]
    fn a_refusal_is_a_result_the_model_can_read_not_a_transport_fault() {
        let directory = TempDir::new().expect("temporary directory");
        let app = app_with_storage(&directory);
        let server = started(&app, "secret");
        let token = Some("secret");

        let (status, body) = post(
            server.address,
            PATH,
            token,
            &call(
                "card_move",
                json!({"id": "x", "status": "done", "owner": "claude"}),
            ),
        );
        assert_eq!(status, 200);
        assert_eq!(body["result"]["isError"], json!(true));
        assert!(
            body["result"]["content"][0]["text"]
                .as_str()
                .expect("text")
                .starts_with("card_not_found")
        );

        let (_, body) = post(
            server.address,
            PATH,
            token,
            &call("card_create", json!({"title": "Jump"})),
        );
        assert!(
            body["result"]["content"][0]["text"]
                .as_str()
                .expect("text")
                .contains("`owner` is required")
        );

        let (_, body) = post(
            server.address,
            PATH,
            token,
            &call(
                "card_create",
                json!({"title": "Jump", "owner": "claude", "status": "done"}),
            ),
        );
        assert!(
            body["result"]["content"][0]["text"]
                .as_str()
                .expect("text")
                .starts_with("card_locked")
        );

        let (_, body) = post(
            server.address,
            PATH,
            token,
            &rpc("resources/list", json!({})),
        );
        assert_eq!(body["error"]["code"], json!(-32601));

        let (status, _) = post(server.address, PATH, token, "not json");
        assert_eq!(status, 400);

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

    /// Claim 23: the door reaches cards and nothing that moves the checkout.
    #[test]
    fn the_door_cannot_post_a_card_to_gofer() {
        let directory = TempDir::new().expect("temporary directory");
        let app = app_with_storage(&directory);
        let server = started(&app, "secret");
        let (_, body) = post(
            server.address,
            PATH,
            Some("secret"),
            &call(
                "card_post_to_gofer",
                json!({"id": "x", "bringChanges": false, "owner": "claude"}),
            ),
        );
        assert_eq!(body["result"]["isError"], json!(true));
        assert!(
            body["result"]["content"][0]["text"]
                .as_str()
                .expect("text")
                .starts_with("unknown_tool")
        );
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
                },
                crate::storage::Actor::User,
            )
            .expect("card");
        storage
            .board()
            .attach_task(&card.id, &task_id)
            .expect("attach");
        let server = started(&app, "secret");

        // The bit is process-wide and other tests take it; wait for a turn at holding it.
        let turn = loop {
            if let Ok(turn) = crate::ai_turn::begin_provider_operation() {
                break turn;
            }
            std::thread::yield_now();
        };
        let (_, body) = post(
            server.address,
            PATH,
            Some("secret"),
            &call(
                "card_comment",
                json!({"id": card.id, "body": "hurry", "owner": "claude"}),
            ),
        );
        drop(turn);
        assert_eq!(body["result"]["isError"], json!(true));
        assert!(
            body["result"]["content"][0]["text"]
                .as_str()
                .expect("text")
                .starts_with("card_in_progress")
        );

        let (_, body) = post(
            server.address,
            PATH,
            Some("secret"),
            &call(
                "card_comment",
                json!({"id": card.id, "body": "later", "owner": "claude"}),
            ),
        );
        assert_eq!(
            body["result"]["isError"],
            json!(false),
            "between turns it is open"
        );
        stop(server);
    }
}

//! Acceptance coverage for the AI tool router: a real model turn driving a real Godot editor.
//!
//! Every other acceptance module drives one boundary from Rust. This one starts a turn above all
//! of them and lets the pieces meet: a scripted OpenAI-compatible model, the real Node worker over
//! the duplex NDJSON channel, the real router, and one pinned editor with its addon, language
//! server, and debug adapter. Nothing in the middle is a stand-in — the only fake is the model
//! itself, because a local LLM cannot be a test fixture.
//!
//! The done-criteria of the step is the turn: the agent edits a scene and saves it, fixes a
//! diagnostic the language server reported, runs to a breakpoint and inspects a local, and
//! captures the running game. The frame is proven twice: the router hands the worker a PNG, and
//! the request body of the following model turn carries it as an image the model can actually see.
//!
//! Gated behind the `godot-acceptance` feature so the fast gate needs no engine.

use crate::addon::AddonStager;
use crate::files::Workspace;
use crate::godot_rpc::RpcSession;
use crate::godot_session::{self, LogSource};
use crate::process::{ChildProcess, ProcessSpawner, SystemProcessSpawner};
use crate::{AiSettings, AiWorkerMessage, AiWorkerRequest, ChatSender, ai_tools};
use serde_json::{Value, json};
use std::ffi::{OsStr, OsString};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tempfile::TempDir;

const ARTIFACTS: &str = include_str!("../../protocol/godot-artifacts.json");
const READY_TIMEOUT: Duration = Duration::from_secs(90);
const PROBE_TIMEOUT_MS: u64 = 2_000;

/// The fixture's main scene script. `_tick` exists so the breakpoint stops two frames deep, and
/// the Label gives the screenshot something that changes.
const PROBE_SCRIPT: &str = "extends Node2D\n\nvar counter := 0\n\n@onready var label: Label = $Label\n\nfunc _process(_delta: float) -> void:\n\t_tick(1)\n\nfunc _tick(amount: int) -> void:\n\tcounter += amount\n\tlabel.text = \"ticks: %d\" % counter\n";
/// 1-based, matching the editor UI: the `counter += amount` line inside `_tick`.
const BREAK_LINE: i64 = 11;
const PROBE_SCENE: &str = "[gd_scene load_steps=2 format=3]\n\n[ext_resource type=\"Script\" path=\"res://scripts/main_probe.gd\" id=\"1_probe\"]\n\n[node name=\"AiFixture\" type=\"Node2D\"]\nscript = ExtResource(\"1_probe\")\n\n[node name=\"Label\" type=\"Label\" parent=\".\"]\noffset_right = 320.0\noffset_bottom = 40.0\n";

/// The same unclosed parameter list the language-server acceptance uses, because it is a parse
/// error the real server is already known to report.
const BROKEN_SCRIPT: &str = "extends Node\n\nfunc explode( -> void:\n\tpass\n";
const FIXED_SCRIPT: &str = "extends Node\n\nfunc explode() -> void:\n\tpass\n";

const SCENE_PATH: &str = "res://main.tscn";
const BROKEN_PATH: &str = "scripts/broken.gd";
const PROBE_PATH: &str = "scripts/main_probe.gd";

/// Base64 always opens with these characters when the payload is the eight-byte PNG signature.
const PNG_BASE64_PREFIX: &str = "iVBORw0KGgo";

struct Editor {
    child: Box<dyn ChildProcess>,
    output: Arc<Mutex<String>>,
}

impl Editor {
    fn output(&self) -> String {
        self.output
            .lock()
            .map(|output| output.clone())
            .unwrap_or_default()
    }
}

impl Drop for Editor {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn pinned_version_prefix() -> String {
    let manifest: Value = serde_json::from_str(ARTIFACTS).expect("parse Godot artifact manifest");
    manifest["version"]
        .as_str()
        .expect("manifest version")
        .replace('-', ".")
}

/// Resolves the pinned editor the same way the Node gate does: an absolute `GOFER_GODOT_BINARY`
/// wins, otherwise the pinned version is accepted from `PATH`. The version is always verified.
fn pinned_editor() -> String {
    let expected = pinned_version_prefix();
    let reported = |binary: &str| {
        let arguments = [OsString::from("--version")];
        let output = SystemProcessSpawner
            .output(OsStr::new(binary), &arguments)
            .ok()?;
        output
            .status
            .success
            .then(|| String::from_utf8_lossy(&output.stdout).trim().to_owned())
    };

    if let Ok(configured) = std::env::var("GOFER_GODOT_BINARY") {
        assert!(
            Path::new(&configured).is_absolute(),
            "GOFER_GODOT_BINARY must be an absolute path"
        );
        let version = reported(&configured)
            .unwrap_or_else(|| panic!("Could not execute GOFER_GODOT_BINARY at {configured}"));
        assert!(
            version.starts_with(&expected),
            "Expected Godot {expected}, received {version}"
        );
        return configured;
    }
    for candidate in ["godot4", "godot"] {
        if reported(candidate).is_some_and(|version| version.starts_with(&expected)) {
            return candidate.to_owned();
        }
    }
    panic!(
        "Godot {expected} is required. Install it on PATH, or set GOFER_GODOT_BINARY to the \
         absolute path of the pinned binary."
    );
}

fn copy_tree(source: &Path, target: &Path) {
    std::fs::create_dir_all(target).expect("create target directory");
    for entry in std::fs::read_dir(source).expect("read fixture directory") {
        let entry = entry.expect("fixture entry");
        let destination = target.join(entry.file_name());
        if entry.file_type().expect("entry type").is_dir() {
            copy_tree(&entry.path(), &destination);
        } else {
            std::fs::copy(entry.path(), &destination).expect("copy fixture file");
        }
    }
}

fn fixture_worktree(directory: &TempDir) -> PathBuf {
    let worktree = directory.path().join("worktree");
    let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("fixtures")
        .join("godot-project");
    copy_tree(&fixture, &worktree);
    let scripts = worktree.join("scripts");
    std::fs::create_dir_all(&scripts).expect("create scripts directory");
    std::fs::write(scripts.join("main_probe.gd"), PROBE_SCRIPT).expect("write the probe script");
    std::fs::write(scripts.join("broken.gd"), BROKEN_SCRIPT).expect("write the broken script");
    std::fs::write(worktree.join("main.tscn"), PROBE_SCENE).expect("write the probe scene");
    crate::paths::canonical(&worktree).expect("canonical worktree")
}

/// Launches the pinned editor with every transport the router needs, draining both pipes into the
/// session log buffer the `godot_logs` tool reads and into a string a failure can quote.
fn launch(worktree: &Path, rpc_port: u16, token: &str, lsp_port: u16, dap_port: u16) -> Editor {
    let arguments = [
        OsString::from("--editor"),
        OsString::from("--headless"),
        OsString::from("--path"),
        worktree.as_os_str().to_owned(),
        OsString::from("--lsp-port"),
        OsString::from(lsp_port.to_string()),
        OsString::from("--dap-port"),
        OsString::from(dap_port.to_string()),
    ];
    let environment = [
        (
            OsString::from("GOFER_RPC_PORT"),
            OsString::from(rpc_port.to_string()),
        ),
        (OsString::from("GOFER_RPC_TOKEN"), OsString::from(token)),
    ];
    let binary = pinned_editor();
    let mut child = SystemProcessSpawner
        .spawn_with_env(OsStr::new(&binary), &arguments, false, &environment)
        .expect("launch the pinned Godot editor");

    godot_session::clear_logs();
    let output = Arc::new(Mutex::new(String::new()));
    for (stream, source) in [
        (child.take_stdout(), LogSource::Editor),
        (child.take_stderr(), LogSource::EditorError),
    ] {
        let Some(stream) = stream else { continue };
        let sink = Arc::clone(&output);
        thread::spawn(move || {
            let mut reader = BufReader::new(stream);
            let mut line = String::new();
            while reader.read_line(&mut line).unwrap_or(0) > 0 {
                godot_session::append_log(source, &line);
                if let Ok(mut sink) = sink.lock() {
                    sink.push_str(&line);
                }
                line.clear();
            }
        });
    }
    Editor { child, output }
}

/// One editor session with every transport bound to the router's test hooks, so a tool call from
/// the worker reaches this editor exactly as it would reach a supervised one.
struct Session {
    rpc: RpcSession,
    editor: Editor,
    worktree: PathBuf,
    stager: AddonStager,
    _directory: TempDir,
}

impl Drop for Session {
    fn drop(&mut self) {
        crate::script::clear_test_session();
        crate::debug::clear_test_session();
        godot_session::bind_test_rpc(None);
        self.rpc.stop();
        let _ = self.stager.unstage(&self.worktree);
    }
}

impl Session {
    fn start() -> Self {
        let directory = TempDir::new().expect("temporary directory");
        let worktree = fixture_worktree(&directory);
        let stager = AddonStager::new(directory.path().join("ledger.json"));
        let workspace = Workspace::open(&worktree).expect("open worktree");
        stager.stage(&workspace).expect("stage the Gofer addon");

        let listener = TcpListener::bind("127.0.0.1:0").expect("bind RPC listener");
        let rpc_port = listener.local_addr().expect("listener address").port();
        let lsp_port = free_port();
        let dap_port = free_port();
        let token = "a4".repeat(32);
        let rpc = RpcSession::start(listener, token.clone(), worktree.display().to_string());
        let editor = launch(&worktree, rpc_port, &token, lsp_port, dap_port);

        godot_session::bind_test_rpc(Some(rpc.clone()));
        crate::script::bind_test_session(lsp_port, &worktree.display().to_string());
        crate::debug::bind_test_session(dap_port, &worktree.display().to_string());

        let session = Self {
            rpc,
            editor,
            worktree,
            stager,
            _directory: directory,
        };
        session.await_ready();
        session
    }

    /// Polls until the addon answers as ready: the editor imports the project and enables plugins
    /// before it connects, so early probes are expected to fail.
    ///
    /// Each probe carries its own request id. A reused id would be answered after its own timeout
    /// and arrive as a reply to a request the session no longer holds — a protocol violation that
    /// closes the transport for good.
    fn await_ready(&self) {
        let deadline = std::time::Instant::now() + READY_TIMEOUT;
        let mut last = "no reply".to_owned();
        let mut probe = 0;
        while std::time::Instant::now() < deadline {
            probe += 1;
            match self.rpc.call(crate::godot_rpc::CallRequest {
                id: format!("ai-acceptance-ready-{probe}"),
                command: "session.get_state".to_owned(),
                params: json!({}),
                expected_revision: None,
                timeout_ms: Some(PROBE_TIMEOUT_MS),
            }) {
                Ok(response) if response.result["state"] == "ready" => return,
                Ok(response) => last = response.result.to_string(),
                Err(error) => last = format!("{}: {}", error.code, error.message),
            }
            thread::sleep(Duration::from_millis(250));
        }
        panic!(
            "the addon never reported a ready session: {last}\n--- editor output ---\n{}",
            self.editor.output()
        );
    }
}

fn free_port() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind probe listener");
    let port = listener.local_addr().expect("probe address").port();
    drop(listener);
    port
}

/// What the scripted model answers on one turn.
enum ModelTurn {
    Tool {
        name: &'static str,
        arguments: Value,
    },
    Text(&'static str),
}

fn tool(name: &'static str, arguments: Value) -> ModelTurn {
    ModelTurn::Tool { name, arguments }
}

/// The scripted turn: one tool call per model response, each built from what the previous tool
/// calls actually answered. A fixed script could not do this — the scene revision, the file hash,
/// the frame id, and the variables reference are all values only the editor can produce.
fn next_turn(index: usize, results: &[Value]) -> ModelTurn {
    let result = |position: usize| -> &Value {
        results
            .get(position)
            .unwrap_or_else(|| panic!("turn {index} needs the result of tool call {position}"))
    };
    match index {
        0 => tool(
            "godot_scene",
            json!({"op": "open", "params": {"path": SCENE_PATH}}),
        ),
        1 => tool(
            "godot_node",
            json!({"op": "create", "params": {
                "scene": SCENE_PATH,
                "parent": "/AiFixture",
                "name": "AiMarker",
                "type": "Marker2D",
                "expectedRevision": result(0)["revision"],
            }}),
        ),
        2 => tool("godot_scene", json!({"op": "get_tree", "params": {}})),
        3 => tool(
            "godot_scene",
            json!({"op": "save", "params": {"expectedRevision": result(1)["revision"]}}),
        ),
        4 => tool(
            "godot_script",
            json!({"op": "open", "params": {"path": BROKEN_PATH}}),
        ),
        5 => tool(
            "godot_script",
            json!({"op": "diagnostics", "params": {"path": BROKEN_PATH, "timeoutMs": 30000}}),
        ),
        6 => tool(
            "godot_script",
            json!({"op": "save", "params": {
                "path": BROKEN_PATH,
                "text": FIXED_SCRIPT,
                "expectedHash": result(4)["hash"],
            }}),
        ),
        7 => tool(
            "godot_script",
            json!({"op": "diagnostics", "params": {"path": BROKEN_PATH, "timeoutMs": 30000}}),
        ),
        8 => tool(
            "godot_debug",
            json!({"op": "launch", "params": {
                "playArgs": ["--headless"],
                "breakpoints": [{"path": PROBE_PATH, "lines": [BREAK_LINE]}],
            }}),
        ),
        9 => tool(
            "godot_debug",
            json!({"op": "await_stop", "params": {"timeoutMs": 60000}}),
        ),
        10 => tool("godot_debug", json!({"op": "stack_trace", "params": {}})),
        11 => tool(
            "godot_debug",
            json!({"op": "scopes", "params": {"frameId": result(10)["frames"][0]["id"]}}),
        ),
        12 => tool(
            "godot_debug",
            json!({"op": "variables", "params": {
                "variablesReference": result(11)["scopes"][0]["variablesReference"],
            }}),
        ),
        13 => tool("godot_debug", json!({"op": "terminate", "params": {}})),
        14 => tool("godot_runtime", json!({"op": "run", "params": {}})),
        15 => tool("godot_runtime", json!({"op": "capture", "params": {}})),
        16 => tool("godot_runtime", json!({"op": "stop", "params": {}})),
        17 => tool(
            "godot_logs",
            json!({"op": "read", "params": {"limit": 200}}),
        ),
        _ => {
            ModelTurn::Text("Marker added, diagnostic fixed, breakpoint inspected, frame captured.")
        }
    }
}

/// What the scripted model saw and answered.
#[derive(Default)]
struct Transcript {
    /// One entry per model request: the whole body, so an assertion can look at what the model was
    /// actually shown — including the images tool results attached.
    bodies: Vec<Value>,
    /// The parsed tool results, in the order the agent reported them.
    results: Vec<Value>,
}

/// A scripted OpenAI-compatible completions endpoint.
///
/// It answers with one tool call per turn, chosen by [`next_turn`] from the results so far, and
/// finishes with text. Streaming is the only shape the provider accepts, so the answer goes out as
/// two SSE chunks and a `[DONE]`.
fn start_model(transcript: Arc<Mutex<Transcript>>) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind model listener");
    let port = listener.local_addr().expect("model address").port();
    thread::spawn(move || {
        let turn = AtomicUsize::new(0);
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { break };
            let Some(body) = read_http_body(&mut stream) else {
                continue;
            };
            let request: Value = serde_json::from_str(&body).expect("the model request is JSON");
            let results = tool_results(&request);
            let index = turn.fetch_add(1, Ordering::Relaxed);
            if let Ok(mut transcript) = transcript.lock() {
                transcript.results = results.clone();
                transcript.bodies.push(request);
            }
            write_completion(&mut stream, index, next_turn(index, &results));
        }
    });
    format!("http://127.0.0.1:{port}/v1")
}

/// Reads one HTTP/1.1 request and returns its body. Only what a completions client sends is
/// supported: a `Content-Length` request with no chunked encoding.
fn read_http_body(stream: &mut TcpStream) -> Option<String> {
    let mut reader = BufReader::new(stream.try_clone().ok()?);
    let mut length = 0usize;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).ok()? == 0 {
            return None;
        }
        let trimmed = line.trim_end();
        if trimmed.is_empty() {
            break;
        }
        if let Some((name, value)) = trimmed.split_once(':')
            && name.eq_ignore_ascii_case("content-length")
        {
            length = value.trim().parse().ok()?;
        }
    }
    let mut body = vec![0; length];
    reader.read_exact(&mut body).ok()?;
    String::from_utf8(body).ok()
}

/// Extracts what the agent reported back from every tool call so far. Godot's answers are JSON, so
/// the scripted model reads them the way a real model would read the same text.
fn tool_results(request: &Value) -> Vec<Value> {
    request["messages"]
        .as_array()
        .map(|messages| {
            messages
                .iter()
                .filter(|message| message["role"] == "tool")
                .filter_map(|message| message["content"].as_str())
                .map(|content| serde_json::from_str(content).unwrap_or(json!({"text": content})))
                .collect()
        })
        .unwrap_or_default()
}

fn write_completion(stream: &mut TcpStream, index: usize, turn: ModelTurn) {
    let (delta, finish) = match turn {
        ModelTurn::Tool { name, arguments } => (
            json!({
                "role": "assistant",
                "tool_calls": [{
                    "index": 0,
                    "id": format!("call-{index}"),
                    "type": "function",
                    "function": {"name": name, "arguments": arguments.to_string()},
                }],
            }),
            "tool_calls",
        ),
        ModelTurn::Text(text) => (json!({"role": "assistant", "content": text}), "stop"),
    };
    let chunk = |delta: Value, finish: Value| {
        json!({
            "id": format!("chatcmpl-{index}"),
            "object": "chat.completion.chunk",
            "created": 1,
            "model": "gofer-acceptance",
            "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
            "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
        })
    };
    let body = format!(
        "data: {}\n\ndata: {}\n\ndata: [DONE]\n\n",
        chunk(delta, Value::Null),
        chunk(json!({}), json!(finish))
    );
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n{body}"
    );
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
}

fn mock_app() -> tauri::App<tauri::test::MockRuntime> {
    let app = tauri::test::mock_builder()
        .build(tauri::generate_context!())
        .expect("build mock Tauri app");
    tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .expect("build mock webview");
    app
}

#[test]
fn an_ai_turn_edits_a_scene_fixes_a_diagnostic_debugs_and_captures_the_game() {
    let session = Session::start();
    let transcript = Arc::new(Mutex::new(Transcript::default()));
    let base_url = start_model(Arc::clone(&transcript));
    let app = mock_app();

    let completion = crate::run_ai_worker_with(
        app.handle(),
        1,
        AiWorkerRequest {
            settings: AiSettings {
                base_url,
                model: "gofer-acceptance".to_owned(),
                max_retries: 0,
                ..AiSettings::default()
            },
            api_key: None,
            messages: vec![AiWorkerMessage {
                sender: ChatSender::User,
                text: "Add a marker, fix the broken script, debug the probe, and show me the game."
                    .to_owned(),
                timestamp: 1,
                images: Vec::new(),
            }],
            agent_messages: None,
            workspace_path: session.worktree.display().to_string(),
            memory_context: None,
            tools: ai_tools::CATALOG,
        },
        &SystemProcessSpawner,
    )
    .unwrap_or_else(|error| {
        panic!(
            "the AI turn failed: {error}\n--- editor output ---\n{}",
            session.editor.output()
        )
    });
    assert!(completion.contains("Marker added"), "{completion}");

    let transcript = transcript.lock().expect("transcript lock");
    let results = &transcript.results;
    let quote = |what: &str| -> String {
        format!(
            "{what}\n--- tool results ---\n{}\n--- editor output ---\n{}",
            serde_json::to_string_pretty(results).unwrap_or_default(),
            session.editor.output()
        )
    };
    assert_eq!(
        results.len(),
        18,
        "{}",
        quote("every tool call is answered")
    );

    // The scene edit: created through the addon's undo stack, visible in the edited tree, and on
    // disk only after the explicit save.
    assert_eq!(results[0]["scene"], SCENE_PATH);
    assert_eq!(
        results[1]["revision"],
        1,
        "{}",
        quote("the mutation must bump the scene revision")
    );
    let children = results[2]["root"]["children"]
        .as_array()
        .unwrap_or_else(|| panic!("{}", quote("the edited scene must have children")));
    assert!(
        children.iter().any(|child| child["name"] == "AiMarker"),
        "{}",
        quote("the created node must appear in the edited scene")
    );
    assert_eq!(results[3]["dirty"], false);
    let saved = std::fs::read_to_string(session.worktree.join("main.tscn")).expect("read scene");
    assert!(saved.contains("AiMarker"), "{saved}");

    // The diagnostic: reported for the broken text, gone once the agent wrote the fix through the
    // workspace transaction. `published` separates a clean file from an unanswered question.
    assert_eq!(results[4]["text"], BROKEN_SCRIPT);
    assert_eq!(results[5]["published"], true, "{}", quote("diagnostics"));
    assert!(
        results[5]["diagnostics"]
            .as_array()
            .is_some_and(|diagnostics| !diagnostics.is_empty()),
        "{}",
        quote("the broken script must report a diagnostic")
    );
    assert_eq!(results[7]["published"], true, "{}", quote("diagnostics"));
    assert_eq!(
        results[7]["diagnostics"].as_array().map(Vec::len),
        Some(0),
        "{}",
        quote("the fixed script must report no diagnostics")
    );
    assert_eq!(
        std::fs::read_to_string(session.worktree.join(BROKEN_PATH)).expect("read script"),
        FIXED_SCRIPT
    );

    // The debug loop: the breakpoint verified with the launch, the stop, the two-frame stack, and
    // the `_tick` argument read out of the Locals scope.
    assert_eq!(results[8]["breakpoints"][0]["verified"], true);
    assert_eq!(results[8]["breakpoints"][0]["path"], PROBE_PATH);
    assert_eq!(
        results[9]["stopped"]["reason"],
        "breakpoint",
        "{}",
        quote("the game must stop on the breakpoint")
    );
    assert_eq!(results[10]["frames"][0]["name"], "_tick");
    assert_eq!(results[10]["frames"][0]["line"], BREAK_LINE);
    assert_eq!(results[10]["frames"][0]["path"], PROBE_PATH);
    assert_eq!(results[11]["scopes"][0]["name"], "Locals");
    let locals = results[12]["variables"]
        .as_array()
        .unwrap_or_else(|| panic!("{}", quote("Locals must list variables")));
    let amount = locals
        .iter()
        .find(|variable| variable["name"] == "amount")
        .unwrap_or_else(|| panic!("{}", quote("the _tick argument must be a local")));
    assert_eq!(amount["value"], "1");

    // The capture: a real PNG frame from the running game, both times.
    for position in [14, 15] {
        assert_eq!(
            results[position]["frame"]["encoding"],
            "png-base64",
            "{}",
            quote("a captured frame must be a PNG")
        );
        assert!(
            results[position]["frame"]["width"].as_u64().unwrap_or(0) > 0,
            "{}",
            quote("a captured frame must have pixels")
        );
        // The base64 payload is deliberately absent from the text the model reads.
        assert!(results[position]["frame"]["data"].is_null());
    }

    // The frame reaches the model as an image, not as a base64 blob in a tool result.
    let attached = transcript.bodies.iter().any(|body| {
        body.to_string()
            .contains(&format!("data:image/png;base64,{PNG_BASE64_PREFIX}"))
    });
    assert!(
        attached,
        "{}",
        quote("the captured frame must reach the model as an image")
    );

    // The logs domain: the editor's own output, captured by the session and paged with a cursor.
    let entries = results[17]["entries"]
        .as_array()
        .unwrap_or_else(|| panic!("{}", quote("the logs page must carry entries")));
    assert!(
        !entries.is_empty(),
        "{}",
        quote("the session captured logs")
    );
    assert!(
        results[17]["cursor"].as_u64().unwrap_or(0) > 0,
        "{}",
        quote("the logs page must carry a cursor")
    );
    assert!(
        entries.iter().any(|entry| entry["message"]
            .as_str()
            .unwrap_or_default()
            .contains("Godot Engine")),
        "{}",
        quote("the editor's own banner must be in the captured output")
    );
}

//! Acceptance coverage for the AI tool router: a real model turn driving a real Godot editor.
//!
//! Every other acceptance module drives one boundary from Rust. This one starts a turn above all
//! of them and lets the pieces meet: a scripted OpenAI-compatible model, the real Node worker over
//! the duplex NDJSON channel, the real router, and one pinned editor with its addon, language
//! server, and debug adapter. Nothing in the middle is a stand-in — the only fake is the model
//! itself, because a local LLM cannot be a test fixture.
//!
//! The done-criteria of the step is the turn: the agent edits a scene and saves it, fixes a
//! diagnostic the language server reported, runs to a breakpoint and inspects a local, captures
//! the running game, reads the project's settings, lists the worktree and cuts an atlas into a
//! tileset. The frame is proven twice: the router hands the worker a PNG, and the request body of
//! the following model turn carries it as an image the model can actually see.
//!
//! `godot_docs_search` is the one domain no turn here drives. It retrieves through the gofer-rag
//! sidecar against downloaded embedding models, and a suite that has to fetch a model before it
//! can start is not one anybody runs; its own tests stand in `rag.rs`. What it gets instead is the
//! route, in [`every_operation_no_turn_has_ever_used_still_answers`], against the fixture worker.
//!
//! Gated behind the `godot-acceptance` feature so the fast gate needs no engine.

use crate::ai_tools;
use crate::ai_turn::{AiWorkerMessage, ChatSender, Job, JobContext};
use crate::godot_editor_harness::{self, PNG_BASE64_PREFIX, Transports, free_port};
use crate::process::SystemProcessSpawner;
use crate::settings::AiSettings;
use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::Manager;
use tempfile::TempDir;

/// The fixture's main scene script. `_tick` exists so the breakpoint stops two frames deep, and
/// the Label gives the screenshot something that changes.
const PROBE_SCRIPT: &str = "extends Node2D\n\nvar counter := 0\n\n@onready var label: Label = $Label\n\nfunc _process(_delta: float) -> void:\n\t_tick(1)\n\nfunc _tick(amount: int) -> void:\n\tcounter += amount\n\tlabel.text = \"ticks: %d\" % counter\n";
/// 1-based, matching the editor UI: the `counter += amount` line inside `_tick`.
const BREAK_LINE: i64 = 11;
/// The line the turn actually asks for: `func _tick(...)`, the declaration above it.
///
/// This is the line a model names, having read the script and picked the function it cares about,
/// and Godot will verify a breakpoint on it and then never stop there. Measured on a real 4.7.2
/// editor: twenty seconds with the game running and no stop, against an immediate stop on the line
/// below. A live debugging turn set a declaration four times, spent six calls on `stop_timeout`,
/// and finished nothing. So the breakpoint is moved onto the first statement of the body, and this
/// turn is what proves the move reaches a real editor rather than only a string.
const ASKED_LINE: i64 = 10;
/// The blank line above that declaration: where a model that counted lines by eye lands.
const EMPTY_LINE: i64 = 9;
const PROBE_SCENE: &str = "[gd_scene load_steps=2 format=3]\n\n[ext_resource type=\"Script\" path=\"res://scripts/main_probe.gd\" id=\"1_probe\"]\n\n[node name=\"AiFixture\" type=\"Node2D\"]\nscript = ExtResource(\"1_probe\")\n\n[node name=\"Label\" type=\"Label\" parent=\".\"]\noffset_right = 320.0\noffset_bottom = 40.0\n";

/// The same unclosed parameter list the language-server acceptance uses, because it is a parse
/// error the real server is already known to report.
const BROKEN_SCRIPT: &str = "extends Node\n\nfunc explode( -> void:\n\tpass\n";
const FIXED_SCRIPT: &str = "extends Node\n\nfunc explode() -> void:\n\tpass\n";

const SCENE_PATH: &str = "res://main.tscn";
const BROKEN_PATH: &str = "scripts/broken.gd";
const PROBE_PATH: &str = "scripts/main_probe.gd";
/// The language server answers `definition` and `prepare_rename` about a name declared in one file
/// and used in another, and about nothing else — so the pair the LSP suite navigates is written
/// into this project too, rather than a second probe that means the same thing.
const MATH_PATH: &str = "scripts/math_utils.gd";
const KEEPER_PATH: &str = "scripts/score_keeper.gd";
/// A root script for the scene the node operations are exercised on, carrying the one handler
/// `connect_signal` and `disconnect_signal` need to have something to wire.
const LEVEL_SCRIPT: &str = "extends Node2D\n\nfunc _on_timer_timeout() -> void:\n\tpass\n";

/// The live fixture's own art: a real 8x2 atlas of 16x16 tiles, which is what makes
/// `create_tileset` answer with a grid rather than refuse a texture it cannot cut.
const ATLAS: &[u8] = include_bytes!("../../fixtures/live-project/assets/tiles.png");
const ATLAS_PATH: &str = "res://tiles.png";
const TILESET_PATH: &str = "res://tiles/world.tres";

/// Copies the fixture project and turns it into the project the turn works on: a main scene with
/// a probe script, a script that does not parse, and the atlas the tileset is cut from.
fn worktree_with_probes(directory: &TempDir) -> PathBuf {
    let worktree = godot_editor_harness::fixture_worktree(directory);
    let scripts = worktree.join("scripts");
    std::fs::create_dir_all(&scripts).expect("create scripts directory");
    std::fs::write(scripts.join("main_probe.gd"), PROBE_SCRIPT).expect("write the probe script");
    std::fs::write(scripts.join("broken.gd"), BROKEN_SCRIPT).expect("write the broken script");
    std::fs::write(
        scripts.join("math_utils.gd"),
        crate::godot_lsp_acceptance::MATH_UTILS,
    )
    .expect("write the script that declares add_score");
    std::fs::write(
        scripts.join("score_keeper.gd"),
        crate::godot_lsp_acceptance::SCORE_KEEPER,
    )
    .expect("write the script that calls add_score");
    std::fs::write(scripts.join("level.gd"), LEVEL_SCRIPT).expect("write the level script");
    std::fs::write(worktree.join("main.tscn"), PROBE_SCENE).expect("write the probe scene");
    std::fs::write(worktree.join("tiles.png"), ATLAS).expect("write the atlas");
    worktree
}

/// `[   0% ]` through `[ 100% ]`, the eight characters the editor opens a progress line with.
fn is_a_percentage(opening: &str) -> bool {
    opening.starts_with('[')
        && opening.ends_with("% ]")
        && opening[1..5]
            .trim()
            .bytes()
            .all(|byte| byte.is_ascii_digit())
        && !opening[1..5].trim().is_empty()
}

/// One editor session with every transport open and bound, so a tool call from the worker reaches
/// this editor exactly as it would reach a supervised one.
///
/// The binding is the harness's, not this suite's: the router reaches the language server, the
/// debug adapter and the addon through process-wide state, and that has to be cleared before the
/// session behind it is torn down — including when an assertion panics first.
fn start_session() -> godot_editor_harness::Session {
    let directory = TempDir::new().expect("temporary directory");
    let worktree = worktree_with_probes(&directory);
    let ledger = directory.path().join("ledger.json");
    godot_editor_harness::Session::start_on_worktree_with(
        worktree,
        ledger,
        Some(directory),
        Transports {
            lsp_port: Some(free_port()),
            dap_port: Some(free_port()),
            tee_session_logs: true,
            bind_editor: true,
            ..Transports::default()
        },
    )
}

/// What the scripted model answers on one turn.
enum ModelTurn {
    Tool {
        name: &'static str,
        arguments: Value,
    },
    Text(&'static str),
}

/// One operation, written the way the turns below read: `{op, params}`.
///
/// A real call is an `ops` list with the parameters flat beside the `op`, and the list is built
/// here rather than in thirty places. The turns are one operation each because each one needs the
/// answer of the one before it; [`tools`] is the turn that proves a list of several.
fn tool(name: &'static str, arguments: Value) -> ModelTurn {
    tools(name, &[arguments])
}

/// Several operations in one call, as the model writes them.
fn tools(name: &'static str, operations: &[Value]) -> ModelTurn {
    let listed: Vec<Value> = operations
        .iter()
        .map(|operation| {
            let mut entry = operation["params"].clone();
            if !entry.is_object() {
                entry = json!({});
            }
            entry["op"] = operation["op"].clone();
            entry
        })
        .collect();
    ModelTurn::Tool {
        name,
        arguments: json!({"ops": listed}),
    }
}

/// The scripted turn: one tool call per model response, each built from what the previous tool
/// calls actually answered. A fixed script could not do this — the frame id and the variables
/// reference are values only the editor can produce. The scene and its revision it never names:
/// the router supplies both, and the schema no longer offers the keys.
fn next_turn(index: usize, results: &[Value]) -> ModelTurn {
    let result = |position: usize| -> &Value {
        results
            .get(position)
            .unwrap_or_else(|| panic!("turn {index} needs the result of tool call {position}"))
    };
    match index {
        0 => tool(
            "godot",
            json!({"op": "scene.open", "params": {"path": SCENE_PATH}}),
        ),
        1 => tool(
            "godot",
            json!({"op": "node.create_nodes", "params": {
                "nodes": [{"parent": "/AiFixture", "name": "AiMarker", "type": "Marker2D"}],
            }}),
        ),
        2 => tool("godot", json!({"op": "scene.get_tree", "params": {}})),
        3 => tool("godot", json!({"op": "scene.save", "params": {}})),
        4 => tool(
            "godot",
            json!({"op": "script.open", "params": {"paths": [BROKEN_PATH]}}),
        ),
        5 => tool(
            "godot",
            json!({"op": "script.diagnostics", "params": {
                "paths": [BROKEN_PATH],
                "timeoutMs": 30000,
            }}),
        ),
        6 => tool(
            "godot",
            json!({"op": "script.save", "params": {"path": BROKEN_PATH, "text": FIXED_SCRIPT}}),
        ),
        7 => tool(
            "godot",
            json!({"op": "script.diagnostics", "params": {
                "paths": [BROKEN_PATH],
                "timeoutMs": 30000,
            }}),
        ),
        8 => tool(
            "godot",
            json!({"op": "debug.launch", "params": {
                "playArgs": ["--headless"],
                "breakpoints": [{"path": PROBE_PATH, "lines": [ASKED_LINE]}],
            }}),
        ),
        9 => tool(
            "godot",
            json!({"op": "debug.await_stop", "params": {"timeoutMs": 60000}}),
        ),
        10 => tool("godot", json!({"op": "debug.stack_trace", "params": {}})),
        11 => tool(
            "godot",
            json!({"op": "debug.scopes", "params": {"frameId": result(10)["frames"][0]["id"]}}),
        ),
        12 => tool(
            "godot",
            json!({"op": "debug.variables", "params": {
                "variablesReference": result(11)["scopes"][0]["variablesReference"],
            }}),
        ),
        13 => tool(
            "godot",
            json!({"op": "debug.set_breakpoints", "params": {"path": PROBE_PATH, "lines": []}}),
        ),
        14 => tool("godot", json!({"op": "debug.continue", "params": {}})),
        15 => tool("godot", json!({"op": "debug.terminate", "params": {}})),
        16 => tool("godot", json!({"op": "runtime.run", "params": {}})),
        17 => tool("godot", json!({"op": "runtime.capture", "params": {}})),
        18 => tool("godot", json!({"op": "runtime.stop", "params": {}})),
        19 => tool(
            "godot",
            json!({"op": "logs.read", "params": {"limit": 200, "minSeverity": "info"}}),
        ),
        20 => tool("godot", json!({"op": "resource.rescan", "params": {}})),
        21 => tool("godot", json!({"op": "project.get_settings", "params": {}})),
        22 => tool(
            "godot",
            json!({"op": "project.search_editor_settings", "params": {"query": "font_size"}}),
        ),
        23 => tool(
            "godot",
            json!({"op": "resource.list", "params": {"hashes": true}}),
        ),
        24 => tool(
            "godot",
            json!({"op": "resource.create_tileset", "params": {
                "path": TILESET_PATH,
                "texture": ATLAS_PATH,
                "tileWidth": 16,
                "tileHeight": 16,
                "solid": [[0, 0], [1, 0], [4, 0], [5, 0]],
            }}),
        ),
        25 => tool(
            "godot",
            json!({"op": "resource.describe_tileset", "params": {"path": TILESET_PATH}}),
        ),
        26 => tools(
            "godot",
            &[
                json!({"op": "node.inspect", "params": {"node": "/AiFixture"}}),
                json!({"op": "node.inspect", "params": {"node": "/AiFixture/AiMarker"}}),
            ],
        ),
        _ => ModelTurn::Text(
            "Marker added, diagnostic fixed, breakpoint inspected, frame captured, tileset built.",
        ),
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
///
/// A call of one operation is unwrapped to that operation's own answer, because that is what the
/// turns below read and what a model reads too — the list around it says nothing when it holds one.
fn tool_results(request: &Value) -> Vec<Value> {
    request["messages"]
        .as_array()
        .map(|messages| {
            messages
                .iter()
                .filter(|message| message["role"] == "tool")
                .filter_map(|message| message["content"].as_str())
                .map(|content| serde_json::from_str(content).unwrap_or(json!({"text": content})))
                .map(unwrapped_if_alone)
                .collect()
        })
        .unwrap_or_default()
}

/// The answer of the only operation in a call, or the whole list when it holds more than one.
fn unwrapped_if_alone(answer: Value) -> Value {
    match answer["ops"].as_array() {
        Some(entries) if entries.len() == 1 => entries[0]["result"].clone(),
        _ => answer,
    }
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
        .build(crate::app_context())
        .expect("build mock Tauri app");
    tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .expect("build mock webview");
    app
}

#[test]
fn an_ai_turn_edits_a_scene_fixes_a_diagnostic_debugs_and_captures_the_game() {
    let session = start_session();
    let transcript = Arc::new(Mutex::new(Transcript::default()));
    let base_url = start_model(Arc::clone(&transcript));
    let app = mock_app();
    let data = TempDir::new().expect("temporary application data");
    let storage = crate::storage::ProjectStorage::open(data.path(), &session.worktree)
        .expect("open project storage");
    app.manage(crate::storage::StorageSlot::new(Ok(storage)));

    let docs_cache = data.path().join("rag-cache");
    crate::rag::stage_probe_cache(&docs_cache).expect("stage the documentation model cache");
    // SAFETY: the acceptance runner gives each test its own process.
    unsafe {
        std::env::set_var("GOFER_RAG_CACHE_DIR", &docs_cache);
        std::env::set_var(
            "GOFER_RAG_RETRIEVE_WORKER",
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("..")
                .join("fixtures")
                .join("rag")
                .join("retrieve-worker.mjs"),
        );
    }

    let stream = tauri::ipc::Channel::new(|_| Ok(()));
    let turn = crate::ai_turn::AiTurn::begin(1, stream).expect("no other AI turn is running");

    let context = JobContext::for_suite(
        app.handle(),
        AiSettings::served_by(
            crate::settings::AiConnectionType::Local,
            Some(base_url),
            "gofer-acceptance".to_owned(),
            None,
        ),
        session.worktree.display().to_string(),
    )
    .expect("build the job context");
    let completion = crate::ai_turn::run_ai_worker_with(
        app.handle(),
        &turn,
        context.request(Job::Turn {
            task_id: Some("godot-ai-acceptance".to_owned()),
            messages: vec![AiWorkerMessage {
                sender: ChatSender::User,
                text: "Add a marker, fix the broken script, debug the probe, and show me the game."
                    .to_owned(),
                timestamp: 1,
                images: Vec::new(),
            }],
            agent_messages: None,
            is_retry: false,
            memory_context: None,
        }),
        &SystemProcessSpawner,
    )
    .unwrap_or_else(|error| {
        panic!(
            "the AI turn failed: {error}\n--- editor output ---\n{}",
            session.output()
        )
    });
    assert!(completion.contains("Marker added"), "{completion}");

    let transcript = transcript.lock().expect("transcript lock");
    let results = &transcript.results;
    let quote = |what: &str| -> String {
        format!(
            "{what}\n--- tool results ---\n{}\n--- editor output ---\n{}",
            serde_json::to_string_pretty(results).unwrap_or_default(),
            session.output()
        )
    };
    assert_eq!(
        results.len(),
        27,
        "{}",
        quote("every tool call is answered")
    );

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

    assert_eq!(
        results[4]["files"][0]["text"],
        crate::ai_tools::numbered_lines(BROKEN_SCRIPT)
    );
    assert_eq!(
        results[5]["files"][0]["published"],
        true,
        "{}",
        quote("diagnostics")
    );
    assert!(
        results[5]["files"][0]["diagnostics"]
            .as_array()
            .is_some_and(|diagnostics| !diagnostics.is_empty()),
        "{}",
        quote("the broken script must report a diagnostic")
    );
    assert_eq!(
        results[7]["files"][0]["published"],
        true,
        "{}",
        quote("diagnostics")
    );
    assert_eq!(
        results[7]["files"][0]["diagnostics"]
            .as_array()
            .map(Vec::len),
        Some(0),
        "{}",
        quote("the fixed script must report no diagnostics")
    );
    assert_eq!(
        std::fs::read_to_string(session.worktree.join(BROKEN_PATH)).expect("read script"),
        FIXED_SCRIPT
    );

    assert_eq!(results[8]["breakpoints"][0]["verified"], true);
    assert_eq!(results[8]["breakpoints"][0]["path"], PROBE_PATH);
    assert_eq!(
        results[8]["breakpoints"][0]["line"],
        BREAK_LINE,
        "{}",
        quote("a breakpoint on a declaration must move onto the body")
    );
    assert!(
        results[8]["breakpoints"][0]["message"]
            .as_str()
            .is_some_and(|said| said.contains(&ASKED_LINE.to_string())
                && said.contains(&BREAK_LINE.to_string())),
        "{}",
        quote("a moved breakpoint must name both lines")
    );
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

    assert_eq!(
        results[13]["breakpoints"].as_array().map(Vec::len),
        Some(0),
        "{}",
        quote("the breakpoint must be disarmed while the debug session is still live")
    );
    assert_eq!(
        results[14]["allThreads"],
        true,
        "{}",
        quote("the halted game must be let go before it is terminated")
    );

    for position in [16, 17] {
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
        assert!(results[position]["frame"]["data"].is_null());
    }

    let attached = transcript.bodies.iter().any(|body| {
        body.to_string()
            .contains(&format!("data:image/png;base64,{PNG_BASE64_PREFIX}"))
    });
    assert!(
        attached,
        "{}",
        quote("the captured frame must reach the model as an image")
    );

    let entries = results[19]["entries"]
        .as_array()
        .unwrap_or_else(|| panic!("{}", quote("the logs page must carry entries")));
    assert!(
        !entries.is_empty(),
        "{}",
        quote("the session captured logs")
    );
    assert!(
        results[19]["cursor"].as_u64().unwrap_or(0) > 0,
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
    assert!(
        entries.iter().all(|entry| !entry["message"]
            .as_str()
            .unwrap_or_default()
            .contains(char::from(27))),
        "{}",
        quote("no terminal escape code may reach the model")
    );
    assert!(
        entries.iter().all(|entry| {
            let message = entry["message"].as_str().unwrap_or_default().trim_start();
            !(message.starts_with("[ DONE ]") || message.get(..8).is_some_and(is_a_percentage))
        }),
        "{}",
        quote("no line of the editor's progress bar may reach the model")
    );
    assert!(
        results[19]["terminalLinesOmitted"].as_u64().unwrap_or(0) > 0,
        "{}",
        quote("a real import writes a progress bar, and the count has to say so")
    );

    assert_eq!(
        results[21]["projectName"],
        "Gofer Protocol Fixture",
        "{}",
        quote("the project domain must answer with this project's own settings")
    );
    assert!(
        results[22]["settings"]
            .as_array()
            .is_some_and(|settings| !settings.is_empty()),
        "{}",
        quote("the editor-settings search must reach the addon's editor domain")
    );

    let listed = results[23]["files"]
        .as_array()
        .unwrap_or_else(|| panic!("{}", quote("the listing must carry files")));
    let scene = listed
        .iter()
        .find(|file| file["path"] == "main.tscn")
        .unwrap_or_else(|| panic!("{}", quote("the worktree's own scene must be listed")));
    assert!(
        scene["hash"].is_null(),
        "{}",
        quote("a listing must not put a hash in front of the model")
    );
    assert!(
        listed.iter().all(|file| !file["path"]
            .as_str()
            .unwrap_or_default()
            .starts_with("addons/")),
        "{}",
        quote("the staged addon must not be listed as part of the project")
    );
    assert_eq!(
        crate::read_ledger::recall(
            &crate::paths::canonical(&session.worktree).expect("canonical worktree"),
            "main.tscn",
        )
        .as_deref(),
        Some(
            crate::files::hash_text(
                &std::fs::read_to_string(session.worktree.join("main.tscn")).expect("read scene")
            )
            .as_str()
        ),
        "{}",
        quote("a recorded hash must be the hash of what is on disk")
    );

    assert_eq!(
        results[24]["grid"],
        json!([8, 2]),
        "{}",
        quote("the atlas is eight tiles by two")
    );
    assert_eq!(
        results[24]["physicsLayers"],
        1,
        "{}",
        quote("solid tiles need a physics layer")
    );
    let tiles = results[25]["sources"][0]["tiles"]
        .as_array()
        .unwrap_or_else(|| panic!("{}", quote("the saved tileset must describe its tiles")));
    assert_eq!(tiles.len(), 16, "{}", quote("every atlas tile is defined"));
    assert_eq!(
        tiles
            .iter()
            .filter(|tile| tile["solid"] == json!(true))
            .count(),
        4,
        "{}",
        quote("only the four named tiles collide")
    );

    let batched = results[26]["ops"]
        .as_array()
        .unwrap_or_else(|| panic!("{}", quote("a list of two is answered as a list")));
    assert_eq!(
        batched.len(),
        2,
        "{}",
        quote("both inspections are answered by the one call")
    );
    assert_eq!(batched[0]["result"]["name"], "AiFixture");
    assert_eq!(batched[1]["result"]["name"], "AiMarker");
    assert_eq!(
        batched[1]["result"]["type"],
        "Marker2D",
        "{}",
        quote("the second entry answers about the second node, not the first")
    );
}

/// The first mutation of a session lands, without a read before it.
///
/// The catalog tells the model the router holds the revision every mutation is checked against —
/// "never pass it and never read the tree to fetch it". The ledger it is held in is in memory, so
/// on the first call of a session it holds nothing, the router supplies nothing, and the addon
/// refuses with `revision_conflict`. A live turn whose first act was `scene.create` was refused and
/// then did the tree read the catalog told it not to do: 719 tool tokens and 2.6 seconds to learn a
/// number the refusal itself carried.
///
/// The turn above cannot see this — it opens a scene first, which fills the ledger — and neither
/// can the journey, which passes its own revision. Both start from a read, which is exactly the
/// state this one refuses to start from.
/// A frame-awaiting runtime call against a game the debugger has stopped is refused, not waited out.
///
/// The end of what `godot_session::a_game_the_debugger_has_halted` promises: the flag is set by a
/// real adapter's `stopped` event (`godot_dap_acceptance`), the decision is unit-tested
/// (`godot_session::tests`), and this is the two lines in `run_one` between them — on a real editor,
/// a real debuggee and the real router.
///
/// The hazard is written down twice in this repository already. The turn above disarms its
/// breakpoint before it captures, and says why: "Left armed, it stops on its first `_process` and
/// renders nothing more, and the capture below waits out its whole twenty seconds against a game
/// that is paused rather than slow." Across every recorded live trace that cost 21 calls and 420
/// seconds.
///
/// **What this fixture proves, and what it does not.** The addon has a guard of its own —
/// `_runtime_broke`, set from the editor's `breaked` signal — and here it is set, so without the
/// router's guard this call comes back `runtime_broke` in milliseconds rather than timing out. So
/// the assertion that matters is the *code*: the router decides before the addon is asked. The
/// twenty seconds is what the corpus paid when the addon's flag was false, which is a state it
/// clears on any message from the game and which those recorded turns were in — every one of the
/// 21 answered `runtime_timeout`, not `runtime_broke`. Two guards on two different facts, and the
/// second one exists because the first missed twenty-one calls.
///
/// The five-second deadline is kept anyway: it is not a benchmark, it is the difference between
/// refusing and waiting, and without it the regression comes back as slowness nobody notices.
#[test]
fn a_frame_awaiting_call_against_a_halted_game_is_refused_before_it_waits() {
    let session = start_session();
    let app = mock_app();
    let data = TempDir::new().expect("temporary application data");
    let storage = crate::storage::ProjectStorage::open(data.path(), &session.worktree)
        .expect("open project storage");
    app.manage(crate::storage::StorageSlot::new(Ok(storage)));

    let call = |tool: &str, params: Value| {
        ai_tools::dispatch(
            app.handle(),
            ai_tools::ToolRequest {
                tool: tool.to_owned(),
                params,
            },
        )
    };

    let locations = call(
        "godot_debug",
        json!({"ops": [{"op": "breakpoint_locations", "path": PROBE_PATH, "line": BREAK_LINE}]}),
    )
    .expect("the adapter answers where a breakpoint can go");
    assert!(
        locations["ops"][0]["result"]["locations"]
            .as_array()
            .is_some_and(|found| found.iter().any(|location| location["line"] == BREAK_LINE)),
        "the line the breakpoint is moved onto has to be one the adapter offers: {locations}"
    );

    call(
        "godot_debug",
        json!({"ops": [{
            "op": "launch",
            "playArgs": ["--headless"],
            "breakpoints": [{"path": PROBE_PATH, "lines": [ASKED_LINE]}],
        }]}),
    )
    .expect("the debugger launches the probe");
    assert_eq!(
        crate::debug::armed_breakpoints(),
        vec![PROBE_PATH.to_owned()],
        "a launch that sets a breakpoint has to be remembered as having set one"
    );
    let stopped = call(
        "godot_debug",
        json!({"ops": [{"op": "await_stop", "timeoutMs": 60000}]}),
    )
    .expect("the probe stops on its own first frame");
    assert!(
        !stopped["ops"][0]["result"]["stopped"].is_null(),
        "the game must actually be halted for this test to be about anything: {stopped}"
    );

    let started = std::time::Instant::now();
    let refused = call(
        "godot_runtime",
        json!({"ops": [{
            "op": "input",
            "events": [{"kind": "key", "key": "A", "pressed": true}],
        }]}),
    )
    .expect_err("a halted game cannot answer a call that waits for a frame");
    let waited = started.elapsed();

    assert_eq!(refused.code, "game_halted", "{}", refused.message);
    assert!(
        refused.message.contains("debug.continue"),
        "{}",
        refused.message
    );
    assert!(
        refused.message.contains("inspect_node") && refused.message.contains("get_tree"),
        "the sentence must name what a halted game still answers: {}",
        refused.message
    );
    assert!(
        waited < std::time::Duration::from_secs(5),
        "the refusal is the point and it took {waited:?}"
    );

    let tree = call("godot_runtime", json!({"ops": [{"op": "get_tree"}]}))
        .expect("a read reaches a halted game off the debugger message pump");
    assert!(
        !tree["ops"][0]["result"]["root"].is_null(),
        "a halted game still answers a read: {tree}"
    );

    call("godot_debug", json!({"ops": [{"op": "step_in"}]}))
        .expect("step_in answers on a stopped debuggee");
    let stepped = call(
        "godot_debug",
        json!({"ops": [{"op": "await_stop", "timeoutMs": 60000}]}),
    )
    .expect("the step lands somewhere");
    assert!(
        !stepped["ops"][0]["result"]["stopped"].is_null(),
        "step_over needs a debuggee that is stopped again: {stepped}"
    );
    call("godot_debug", json!({"ops": [{"op": "step_over"}]}))
        .expect("step_over answers on a stopped debuggee");
    // Under ten parallel editors the step lands after the continue below is answered, the game
    // halts on it for real, and the pause's wait truthfully answers `step`. Waiting here is what
    // the contract tells the model to do after every step.
    let stepped_over = call(
        "godot_debug",
        json!({"ops": [{"op": "await_stop", "timeoutMs": 60000}]}),
    )
    .expect("the step over lands somewhere");
    assert!(
        !stepped_over["ops"][0]["result"]["stopped"].is_null(),
        "continue needs a debuggee that is stopped again: {stepped_over}"
    );

    call("godot_debug", json!({"ops": [{"op": "continue"}]})).expect("the game runs on");
    let after = call(
        "godot_runtime",
        json!({"ops": [{
            "op": "input",
            "events": [{"kind": "key", "key": "A", "pressed": true}],
        }]}),
    );
    if let Err(failure) = &after {
        assert_ne!(
            failure.code, "game_halted",
            "a game told to run on is not halted: {}",
            failure.message
        );
    }

    // A running game stopped where it is, rather than at a breakpoint, and the threads it reports
    // there. Godot debugs one thread, and the adapter's own answer is the only thing that says so.
    call("godot_debug", json!({"ops": [{"op": "pause"}]})).expect("pause the running game");
    let paused = call(
        "godot_debug",
        json!({"ops": [{"op": "await_stop", "timeoutMs": 60000}]}),
    )
    .expect("a paused game stops");
    assert_eq!(
        paused["ops"][0]["result"]["stopped"]["reason"], "paused",
        "the game stopped because it was told to, not because it hit anything: {paused}"
    );
    let threads = call("godot_debug", json!({"ops": [{"op": "threads"}]}))
        .expect("the adapter lists its threads");
    assert_eq!(
        threads["ops"][0]["result"]["threads"]
            .as_array()
            .map(Vec::len),
        Some(1),
        "Godot debugs exactly one thread: {threads}"
    );

    let _ = call("godot_debug", json!({"ops": [{"op": "terminate"}]}));
    assert_eq!(
        crate::debug::armed_breakpoints(),
        vec![PROBE_PATH.to_owned()]
    );

    // The armed breakpoint outlives the game it was set on, so a restart is a fresh game that
    // stops in the same place — which is the whole reason the operation exists.
    call("godot_debug", json!({"ops": [{"op": "restart"}]})).expect("restart the debuggee");
    let again = call(
        "godot_debug",
        json!({"ops": [{"op": "await_stop", "timeoutMs": 60000}]}),
    )
    .expect("the replacement game stops too");
    assert!(
        !again["ops"][0]["result"]["stopped"].is_null(),
        "a restart carries the breakpoints of the launch before it: {again}"
    );
    assert!(
        crate::debug::holds_a_game(),
        "the old game's end, written before the restart was answered, is not the new game's"
    );
    let _ = call("godot_debug", json!({"ops": [{"op": "terminate"}]}));

    call(
        "godot_debug",
        json!({"ops": [{"op": "set_breakpoints", "path": PROBE_PATH, "lines": []}]}),
    )
    .expect("clear the breakpoint");
    assert!(crate::debug::armed_breakpoints().is_empty());

    // Last, because it ends the session every call above needed.
    call(
        "godot_debug",
        json!({"ops": [{"op": "disconnect", "terminateDebuggee": true}]}),
    )
    .expect("let go of the adapter");
    assert!(
        !crate::debug::holds_a_game(),
        "a disconnect that terminates the debuggee leaves no game behind"
    );
}

/// Three things a live debugging turn met, on a real editor, through the router.
///
/// A breakpoint asked for on the blank line above `_tick` stops on the first line of its body,
/// rather than verifying and never firing. The pause's stale stop does not answer the wait after
/// the continue. And a game the runtime stopped is not one the debugger still holds, so the next
/// launch is not refused as `already_launched`.
#[test]
fn a_debugger_turn_meets_what_a_live_turn_met() {
    let session = start_session();
    let app = mock_app();
    let data = TempDir::new().expect("temporary application data");
    let storage = crate::storage::ProjectStorage::open(data.path(), &session.worktree)
        .expect("open project storage");
    app.manage(crate::storage::StorageSlot::new(Ok(storage)));

    let call = |tool: &str, params: Value| {
        ai_tools::dispatch(
            app.handle(),
            ai_tools::ToolRequest {
                tool: tool.to_owned(),
                params,
            },
        )
    };

    let launched = call(
        "godot_debug",
        json!({"ops": [{
            "op": "launch",
            "playArgs": ["--headless"],
            "breakpoints": [{"path": PROBE_PATH, "lines": [EMPTY_LINE]}],
        }]}),
    )
    .expect("the debugger launches the probe");
    let taken = &launched["ops"][0]["result"]["breakpoints"][0];
    assert_eq!(
        taken["line"], BREAK_LINE,
        "an empty line moves onto the next one that runs: {launched}"
    );
    assert!(
        taken["message"]
            .as_str()
            .is_some_and(|note| note.contains("holds no statement")),
        "the answer says why it moved: {launched}"
    );
    let stopped = call(
        "godot_debug",
        json!({"ops": [{"op": "await_stop", "timeoutMs": 60000}]}),
    )
    .expect("the moved breakpoint fires");
    assert_eq!(
        stopped["ops"][0]["result"]["stopped"]["reason"], "breakpoint",
        "{stopped}"
    );

    call("godot_debug", json!({"ops": [{"op": "continue"}]})).expect("run on");
    call(
        "godot_debug",
        json!({"ops": [{"op": "set_breakpoints", "path": PROBE_PATH, "lines": []}]}),
    )
    .expect("clear the breakpoint so the game runs freely");
    // The live turn's shape: pause, read nothing, continue — the pause's stop is still queued.
    call("godot_debug", json!({"ops": [{"op": "pause"}]})).expect("pause the running game");
    call("godot_debug", json!({"ops": [{"op": "stack_trace"}]})).expect("a paused game answers");
    call("godot_debug", json!({"ops": [{"op": "continue"}]})).expect("run on again");
    let after = call(
        "godot_debug",
        json!({"ops": [{"op": "await_stop", "timeoutMs": 3000}]}),
    );
    match after {
        Err(failure) => assert_eq!(failure.code, "stop_timeout", "{}", failure.message),
        Ok(answer) => panic!("nothing stops a game running freely, yet the wait answered {answer}"),
    }

    let stopped = call("godot_runtime", json!({"ops": [{"op": "stop"}]}))
        .expect("the runtime stops the game the debugger launched");
    assert_eq!(stopped["ops"][0]["result"]["running"], false, "{stopped}");
    let again = call(
        "godot_debug",
        json!({"ops": [{"op": "launch", "playArgs": ["--headless"]}]}),
    );
    match again {
        Ok(_) => {}
        Err(failure) => panic!(
            "a game the runtime stopped is not one the debugger holds: {} {}",
            failure.code, failure.message
        ),
    }
    let _ = call("godot_debug", json!({"ops": [{"op": "terminate"}]}));
    call(
        "godot_debug",
        json!({"ops": [{"op": "disconnect", "terminateDebuggee": true}]}),
    )
    .expect("let go of the adapter");
}

#[test]
fn every_operation_no_turn_has_ever_used_still_answers() {
    let session = start_session();
    let app = mock_app();
    let data = TempDir::new().expect("temporary application data");
    let storage = crate::storage::ProjectStorage::open(data.path(), &session.worktree)
        .expect("open project storage");
    app.manage(crate::storage::StorageSlot::new(Ok(storage)));
    // SAFETY: the acceptance runner gives each test its own process.
    unsafe {
        std::env::set_var("GOFER_RAG_CACHE_DIR", data.path().join("rag-cache"));
        std::env::set_var(
            "GOFER_RAG_RETRIEVE_WORKER",
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("..")
                .join("fixtures")
                .join("rag")
                .join("retrieve-worker.mjs"),
        );
    }

    let call = |tool: &str, params: Value| {
        ai_tools::dispatch(
            app.handle(),
            ai_tools::ToolRequest {
                tool: tool.to_owned(),
                params,
            },
        )
    };
    call(
        "godot_script",
        json!({"ops": [{"op": "open", "paths": [PROBE_PATH]}]}),
    )
    .expect("open the probe script");

    let inside_the_call = json!({"line": 7, "character": 3});
    let at = |op: &str| json!({"ops": [{"op": op, "path": PROBE_PATH, "position": inside_the_call.clone()}]});

    for op in [
        "completion",
        "signature_help",
        "declaration",
        "highlights",
        "references",
    ] {
        call("godot_script", at(op))
            .unwrap_or_else(|failure| panic!("{op}: {} {}", failure.code, failure.message));
    }
    call(
        "godot_script",
        json!({"ops": [{"op": "document_symbols", "path": PROBE_PATH}]}),
    )
    .expect("document_symbols");
    match call(
        "godot_script",
        json!({"ops": [{"op": "format", "source": "extends Node\n"}]}),
    ) {
        Ok(_) => {}
        Err(failure) => assert_eq!(failure.code, "formatter_unavailable", "{}", failure.message),
    }
    call(
        "godot_script",
        json!({"ops": [{"op": "update", "path": PROBE_PATH, "text": PROBE_SCRIPT}]}),
    )
    .expect("update");

    call(
        "godot_project",
        json!({"ops": [{"op": "get_editor_setting", "name": "run/window_placement/game_embed_mode"}]}),
    )
    .expect("get_editor_setting");
    let missing = call(
        "godot_project",
        json!({"ops": [{"op": "reset_input_action", "name": "ui_accept"}]}),
    );
    if let Err(failure) = &missing {
        assert_ne!(failure.code, "unrouted_tool", "{}", failure.message);
        assert_ne!(failure.code, "unknown_param", "{}", failure.message);
    }

    call(
        "godot_scene",
        json!({"ops": [{"op": "open", "path": SCENE_PATH}]}),
    )
    .expect("open the fixture scene");
    call(
        "godot_node",
        json!({"ops": [{
            "op": "create_nodes",
            "nodes": [{"parent": "/AiFixture", "name": "Undone", "type": "Marker2D"}],
        }]}),
    )
    .expect("something to undo");
    call("godot_session", json!({"ops": [{"op": "undo"}]})).expect("undo");
    call("godot_session", json!({"ops": [{"op": "redo"}]})).expect("redo");

    call("godot_session", json!({"ops": [{"op": "status"}]})).expect("status");
    call("godot_scene", json!({"ops": [{"op": "list"}]})).expect("list the scenes");
    call(
        "godot_script",
        json!({"ops": [{"op": "list", "under": "scripts"}]}),
    )
    .expect("list the scripts");
    call("godot_debug", json!({"ops": [{"op": "status"}]}))
        .expect("the adapter reports its capabilities");
    call(
        "godot_docs_search",
        json!({"ops": [{"op": "ask", "question": "What does _process do?"}]}),
    )
    .expect("ask the manual");

    // Attach takes a game the adapter did not launch itself, and this session has none. What
    // proves the route is the adapter's own answer about that: an op that never reached Godot
    // could not have produced it.
    let attaching = call("godot_debug", json!({"ops": [{"op": "attach"}]}));
    if let Err(failure) = &attaching {
        assert_eq!(failure.code, "dap_server_error", "{}", failure.message);
        assert!(
            failure.message.contains("not_running"),
            "the adapter must be the one refusing: {}",
            failure.message
        );
    }

    let state = call("godot_session", json!({"ops": [{"op": "get_state"}]}))
        .expect("the addon reports the session state");
    assert_eq!(state["ops"][0]["result"]["scene"], SCENE_PATH, "{state}");
    assert!(
        state["ops"][0]["result"]["dialog"].is_null(),
        "a session nobody asked a question is waiting on nothing: {state}"
    );

    // The navigation half of the language server. It answers about a name declared in one file and
    // used in another, so the pair goes through the router together.
    call(
        "godot_script",
        json!({"ops": [{"op": "open", "paths": [MATH_PATH, KEEPER_PATH]}]}),
    )
    .expect("open the pair of scripts");
    let usage = crate::godot_lsp_acceptance::position_of(
        crate::godot_lsp_acceptance::SCORE_KEEPER,
        "add_score",
    );
    let at_usage = json!({"line": usage.line, "character": usage.character});
    let defined = call(
        "godot_script",
        json!({"ops": [{"op": "definition", "path": KEEPER_PATH, "position": at_usage}]}),
    )
    .expect("definition");
    assert!(
        defined["ops"][0]["result"]["locations"]
            .as_array()
            .is_some_and(|locations| locations
                .iter()
                .any(|location| location["path"] == MATH_PATH)),
        "add_score must resolve into the script that declares it: {defined}"
    );

    let declaration = crate::godot_lsp_acceptance::position_of(
        crate::godot_lsp_acceptance::MATH_UTILS,
        "add_score",
    );
    let hovered = call(
        "godot_script",
        json!({"ops": [{
            "op": "hover",
            "path": MATH_PATH,
            "position": {"line": declaration.line, "character": declaration.character},
        }]}),
    )
    .expect("hover");
    assert!(
        hovered["ops"][0]["result"]
            .as_object()
            .is_some_and(|answer| answer.contains_key("hover")),
        "a hover answer carries the field whether or not the server had anything to say, and only \
         the real route produces it: {hovered}"
    );

    let prepared = call(
        "godot_script",
        json!({"ops": [{"op": "prepare_rename", "path": KEEPER_PATH, "position": at_usage}]}),
    )
    .expect("prepare_rename");
    assert_eq!(
        prepared["ops"][0]["result"]["renameable"], true,
        "the server renames add_score, so the position it is asked about is renameable: {prepared}"
    );

    let symbols = call(
        "godot_script",
        json!({"ops": [{"op": "workspace_symbols", "query": "mathutils"}]}),
    )
    .expect("workspace_symbols");
    assert!(
        symbols["ops"][0]["result"]["symbols"]
            .as_array()
            .is_some_and(|found| found.iter().any(|symbol| symbol["name"] == "MathUtils")),
        "the class the project declares must be findable by name: {symbols}"
    );

    let edited = call(
        "godot_script",
        json!({"ops": [{"op": "edit", "files": [{
            "path": KEEPER_PATH,
            "edits": [{"oldText": "var total := 0", "newText": "var total := 1"}],
        }]}]}),
    )
    .expect("edit the script through the language server");
    assert_eq!(edited["ops"][0]["result"]["files"][0]["path"], KEEPER_PATH);
    assert!(
        std::fs::read_to_string(session.worktree.join(KEEPER_PATH))
            .expect("read the edited script")
            .contains("var total := 1"),
        "an edit the router answered has to be on disk: {edited}"
    );

    let closed = call(
        "godot_script",
        json!({"ops": [{"op": "close", "paths": [MATH_PATH, KEEPER_PATH]}]}),
    )
    .expect("close the pair");
    assert_eq!(closed["ops"][0]["result"]["files"][0]["closed"], true);

    // The project configuration the turn above never touches. Every one of these writes
    // project.godot, so each is read back through the command that lists what it wrote.
    let searched = call(
        "godot_project",
        json!({"ops": [{"op": "search_settings", "query": "default gravity"}]}),
    )
    .expect("search the project settings");
    assert!(
        searched["ops"][0]["result"]["settings"]
            .as_array()
            .is_some_and(|settings| settings
                .iter()
                .any(|setting| setting["name"] == "physics/2d/default_gravity")),
        "a search for the words of a setting has to find it: {searched}"
    );

    call(
        "godot_project",
        json!({"ops": [{"op": "set_setting", "name": "gofer/probe", "value": {"type": "int", "value": 7}}]}),
    )
    .expect("write a setting to reset");
    let reset = call(
        "godot_project",
        json!({"ops": [{"op": "reset_setting", "name": "gofer/probe"}]}),
    )
    .expect("reset the setting");
    assert_eq!(reset["ops"][0]["result"]["changed"], true, "{reset}");
    assert_eq!(
        reset["ops"][0]["result"]["previous"],
        json!({"type": "int", "value": 7}),
        "a reset reports what it took away: {reset}"
    );

    call(
        "godot_project",
        json!({"ops": [{"op": "set_autoload", "name": "AiProbeHelper", "path": "res://tests/protocol_test.gd"}]}),
    )
    .expect("register an autoload");
    let autoloads = call("godot_project", json!({"ops": [{"op": "list_autoloads"}]}))
        .expect("list the autoloads");
    assert!(
        autoloads["ops"][0]["result"]["autoloads"]
            .as_array()
            .is_some_and(|listed| listed.iter().any(|entry| entry["name"] == "AiProbeHelper")),
        "an autoload that was registered has to be listed: {autoloads}"
    );
    call(
        "godot_project",
        json!({"ops": [{"op": "remove_autoload", "name": "AiProbeHelper"}]}),
    )
    .expect("remove the autoload");
    let without = call("godot_project", json!({"ops": [{"op": "list_autoloads"}]}))
        .expect("list the autoloads again");
    assert!(
        without["ops"][0]["result"]["autoloads"]
            .as_array()
            .is_some_and(|listed| listed.iter().all(|entry| entry["name"] != "AiProbeHelper")),
        "an autoload reported removed has to be gone: {without}"
    );

    let action = call(
        "godot_project",
        json!({"ops": [{
            "op": "set_input_action",
            "name": "ai_probe_jump",
            "events": [{"kind": "key", "key": "Space"}],
        }]}),
    )
    .expect("declare an input action");
    assert_eq!(
        action["ops"][0]["result"]["events"],
        json!([{"kind": "key", "key": "Space"}]),
        "the action answers with the events it now holds: {action}"
    );
    let actions = call(
        "godot_project",
        json!({"ops": [{"op": "list_input_actions"}]}),
    )
    .expect("list the input actions");
    assert!(
        actions["ops"][0]["result"]["actions"]
            .as_array()
            .is_some_and(|listed| listed.iter().any(|entry| entry["name"] == "ai_probe_jump")),
        "an action that was declared has to be listed: {actions}"
    );
    call(
        "godot_project",
        json!({"ops": [{"op": "remove_input_action", "name": "ai_probe_jump"}]}),
    )
    .expect("remove the input action");
    assert!(
        !std::fs::read_to_string(session.worktree.join("project.godot"))
            .expect("read project.godot")
            .contains("ai_probe_jump"),
        "an action reported removed has to be out of project.godot"
    );

    let plugins =
        call("godot_project", json!({"ops": [{"op": "list_plugins"}]})).expect("list the plugins");
    let gofer = plugins["ops"][0]["result"]["plugins"]
        .as_array()
        .unwrap_or_else(|| panic!("the plugin listing must carry plugins: {plugins}"))
        .iter()
        .find(|plugin| plugin["name"] == "gofer")
        .unwrap_or_else(|| panic!("the addon answering this call must list itself: {plugins}"))
        .clone();
    assert_eq!(gofer["enabled"], true, "{plugins}");
    assert_eq!(gofer["goferManaged"], true, "{plugins}");

    // Drawn rather than copied, because `create_texture` is the only way a model has of making one.
    let drawn = call(
        "godot_resource",
        json!({"ops": [{
            "op": "create_texture",
            "path": "res://art/probe.png",
            "width": 32,
            "height": 16,
            "background": "#3b2a1a",
            "rects": [{"x": 0, "y": 0, "width": 16, "height": 4, "color": "forestgreen"}],
        }]}),
    )
    .expect("draw a texture");
    assert_eq!(drawn["ops"][0]["result"]["width"], 32, "{drawn}");
    assert_eq!(drawn["ops"][0]["result"]["replaced"], false, "{drawn}");
    assert!(session.worktree.join("art/probe.png").exists(), "{drawn}");

    let shape = call(
        "godot_resource",
        json!({"ops": [{
            "op": "create_shape",
            "path": "res://art/hitbox.tres",
            "shapeType": "RectangleShape2D",
            "size": [32, 48],
        }]}),
    )
    .expect("write a shape");
    assert_eq!(
        shape["ops"][0]["result"]["shapeType"], "RectangleShape2D",
        "{shape}"
    );
    assert!(session.worktree.join("art/hitbox.tres").exists(), "{shape}");

    let _gate = crate::approvals::serialize_gate_tests();
    crate::approvals::open();
    let approving = crate::godot_journey_acceptance::approve_when_asked();
    let moved = call(
        "godot_resource",
        json!({"ops": [{"op": "move", "from": BROKEN_PATH, "to": "scripts/broken_moved.gd"}]}),
    )
    .expect("move a file inside the worktree");
    assert!(
        moved["ops"][0]["result"]["alsoMoved"].is_array(),
        "a move names the sidecars that went with the file: {moved}"
    );
    assert_eq!(
        approving.join().expect("the approval responder"),
        1,
        "moving a file is gated, so the move must have been approved rather than waved through"
    );
    assert!(session.worktree.join("scripts/broken_moved.gd").exists());

    let approving = crate::godot_journey_acceptance::approve_when_asked();
    let deleted = call(
        "godot_resource",
        json!({"ops": [{"op": "delete", "path": "art/hitbox.tres"}]}),
    )
    .expect("delete a file inside the worktree");
    assert_eq!(deleted["ops"][0]["result"]["deleted"], true, "{deleted}");
    assert!(
        deleted["ops"][0]["result"]["alsoRemoved"].is_array(),
        "a delete names the sidecars that went with the file: {deleted}"
    );
    assert_eq!(
        approving.join().expect("the approval responder"),
        1,
        "deleting a file is gated, so the delete must have been approved rather than waved through"
    );
    assert!(!session.worktree.join("art/hitbox.tres").exists());

    // Enabling the plugin that is already enabled: the one call this command answers without
    // severing the session that carries it, and the editor's own `changed: false` is the proof it
    // reached the editor rather than a table in Rust.
    let approving = crate::godot_journey_acceptance::approve_when_asked();
    let toggled = call(
        "godot_project",
        json!({"ops": [{"op": "set_plugin_enabled", "plugin": "gofer", "enabled": true}]}),
    )
    .expect("enable the plugin that is already enabled");
    assert_eq!(toggled["ops"][0]["result"]["changed"], false, "{toggled}");
    assert_eq!(toggled["ops"][0]["result"]["enabled"], true, "{toggled}");
    assert_eq!(
        approving.join().expect("the approval responder"),
        1,
        "changing a plugin is gated"
    );
}

/// Every scene and node operation no turn has ever used answers from a real editor.
///
/// The twin of [`every_operation_no_turn_has_ever_used_still_answers`], split off because it needs
/// a scene of its own to cut up: the operations here create, copy, move, retype and delete nodes,
/// and doing that to the scene the turn above works on would make every assertion in this file
/// depend on the order the suite happens to run in. The addon suites drive the same commands
/// straight down the wire; what is proven here is the door the model actually knocks on.
#[test]
fn every_scene_and_node_operation_no_turn_has_ever_used_still_answers() {
    let session = start_session();
    let app = mock_app();
    let data = TempDir::new().expect("temporary application data");
    let storage = crate::storage::ProjectStorage::open(data.path(), &session.worktree)
        .expect("open project storage");
    app.manage(crate::storage::StorageSlot::new(Ok(storage)));

    let call = |tool: &str, params: Value| {
        ai_tools::dispatch(
            app.handle(),
            ai_tools::ToolRequest {
                tool: tool.to_owned(),
                params,
            },
        )
    };
    let result = |answer: &Value| answer["ops"][0]["result"].clone();
    let tree = || {
        call("godot_scene", json!({"ops": [{"op": "get_tree"}]}))
            .expect("the edited scene answers with its tree")
    };

    let created = call(
        "godot_scene",
        json!({"ops": [{"op": "create", "path": "res://level.tscn", "rootType": "Node2D"}]}),
    )
    .expect("create a scene of this test's own");
    assert_eq!(result(&created)["scene"], "res://level.tscn", "{created}");
    assert_eq!(tree()["ops"][0]["result"]["root"]["name"], "level");

    call(
        "godot_node",
        json!({"ops": [{"op": "set_properties", "properties": [{
            "node": "/level",
            "property": "script",
            "value": {"type": "Resource", "value": {"path": "res://scripts/level.gd"}},
        }]}]}),
    )
    .expect("give the root the script the signal is wired to");
    call(
        "godot_node",
        json!({"ops": [{"op": "create_nodes", "nodes": [
            {"parent": "/level", "name": "Timer", "type": "Timer"},
            {"parent": "/level", "name": "Prop", "type": "Marker2D"},
            {"parent": "/level", "name": "Holder", "type": "Node2D"},
            {"parent": "/level", "name": "Terrain", "type": "TileMapLayer"},
        ]}]}),
    )
    .expect("build the scene the operations below work on");

    let wired = call(
        "godot_node",
        json!({"ops": [{
            "op": "connect_signal",
            "node": "/level/Timer",
            "signal": "timeout",
            "method": "_on_timer_timeout",
        }]}),
    )
    .expect("wire the timer to the root's handler");
    assert_eq!(result(&wired)["persistent"], true, "{wired}");
    let cut = call(
        "godot_node",
        json!({"ops": [{
            "op": "disconnect_signal",
            "node": "/level/Timer",
            "signal": "timeout",
            "method": "_on_timer_timeout",
        }]}),
    )
    .expect("unwire it again");
    assert_eq!(result(&cut)["connected"], false, "{cut}");
    let bare = call(
        "godot_node",
        json!({"ops": [{"op": "inspect", "node": "/level/Timer"}]}),
    )
    .expect("inspect the timer");
    assert!(
        result(&bare)["connections"]
            .as_array()
            .is_some_and(Vec::is_empty),
        "a signal reported disconnected has to be gone from the node: {bare}"
    );

    let copied = call(
        "godot_node",
        json!({"ops": [{"op": "duplicate", "node": "/level/Prop", "name": "PropCopy"}]}),
    )
    .expect("duplicate a node");
    assert_eq!(result(&copied)["node"], "/level/PropCopy", "{copied}");
    let moved = call(
        "godot_node",
        json!({"ops": [{"op": "reparent", "node": "/level/PropCopy", "newParent": "/level/Holder"}]}),
    )
    .expect("reparent it");
    assert_eq!(result(&moved)["node"], "/level/Holder/PropCopy", "{moved}");
    let retyped = call(
        "godot_node",
        json!({"ops": [{"op": "change_type", "node": "/level/Holder/PropCopy", "type": "Node2D"}]}),
    )
    .expect("change its type");
    assert_eq!(result(&retyped)["type"], "Node2D", "{retyped}");
    assert_eq!(
        result(
            &call(
                "godot_node",
                json!({"ops": [{"op": "inspect", "node": "/level/Holder/PropCopy"}]}),
            )
            .expect("inspect the retyped node")
        )["type"],
        "Node2D",
        "the tree has to hold the type the answer claimed"
    );

    let grouped = call(
        "godot_node",
        json!({"ops": [{"op": "add_to_group", "node": "/level/Prop", "group": "pickups"}]}),
    )
    .expect("add a node to a group");
    assert_eq!(result(&grouped)["groups"], json!(["pickups"]), "{grouped}");
    let ungrouped = call(
        "godot_node",
        json!({"ops": [{"op": "remove_from_group", "node": "/level/Prop", "group": "pickups"}]}),
    )
    .expect("take it out again");
    assert_eq!(result(&ungrouped)["groups"], json!([]), "{ungrouped}");

    call(
        "godot_resource",
        json!({"ops": [{
            "op": "create_tileset",
            "path": TILESET_PATH,
            "texture": ATLAS_PATH,
            "tileWidth": 16,
            "tileHeight": 16,
        }]}),
    )
    .expect("cut the atlas into a tileset");
    call(
        "godot_node",
        json!({"ops": [{"op": "set_properties", "properties": [{
            "node": "/level/Terrain",
            "property": "tile_set",
            "value": {"type": "Resource", "value": {"path": TILESET_PATH}},
        }]}]}),
    )
    .expect("give the layer its tileset");
    let painted = call(
        "godot_node",
        json!({"ops": [{"op": "set_cells", "node": "/level/Terrain", "cells": [
            {"x": 0, "y": 0, "width": 4, "height": 2, "atlas": [0, 0]},
        ]}]}),
    )
    .expect("paint cells");
    assert_eq!(result(&painted)["painted"], 8, "{painted}");
    let read = call(
        "godot_node",
        json!({"ops": [{"op": "get_cells", "node": "/level/Terrain", "limit": 4}]}),
    )
    .expect("read the cells back");
    assert_eq!(result(&read)["cells"], 8, "{read}");
    assert_eq!(result(&read)["truncated"], true, "{read}");

    let placed = call(
        "godot_node",
        json!({"ops": [{
            "op": "instantiate",
            "parent": "/level",
            "path": SCENE_PATH,
            "name": "Fixture",
        }]}),
    )
    .expect("place an instance of the scene next door");
    assert_eq!(result(&placed)["node"], "/level/Fixture", "{placed}");
    assert_eq!(result(&placed)["path"], SCENE_PATH, "{placed}");

    let deleted = call(
        "godot_node",
        json!({"ops": [{"op": "delete", "node": "/level/Holder/PropCopy"}]}),
    )
    .expect("delete a node");
    assert_eq!(result(&deleted)["deleted"], true, "{deleted}");
    assert!(
        !tree().to_string().contains("PropCopy"),
        "a node reported deleted has to be out of the tree"
    );

    let elsewhere = call(
        "godot_scene",
        json!({"ops": [{"op": "save_as", "path": "res://level_copy.tscn"}]}),
    )
    .expect("save the scene under another name");
    assert_eq!(
        result(&elsewhere)["scene"],
        "res://level_copy.tscn",
        "{elsewhere}"
    );
    let on_disk = std::fs::read_to_string(session.worktree.join("level_copy.tscn"))
        .expect("save_as must leave the file on disk");
    assert!(on_disk.contains("name=\"Terrain\""), "{on_disk}");

    call(
        "godot_node",
        json!({"ops": [{"op": "create_nodes", "nodes": [
            {"parent": "/level", "name": "Unsaved", "type": "Marker2D"},
        ]}]}),
    )
    .expect("something the file does not hold");
    call("godot_scene", json!({"ops": [{"op": "reload"}]})).expect("reload the scene from disk");
    let reloaded = tree().to_string();
    assert!(
        !reloaded.contains("Unsaved"),
        "a reload has to drop what the file never had: {reloaded}"
    );
    assert!(
        reloaded.contains("Terrain"),
        "a reload has to bring back what the file holds: {reloaded}"
    );
}

/// Every runtime operation no turn has ever used answers from a game that is really running.
///
/// The turn above runs the game and photographs it; what it never does is hold it still. Pausing,
/// resuming and replacing a running game are three of the four operations a model reaches for when
/// it is trying to see what a frame did, and none of them had ever been through this router.
/// The probe's own counter is what every assertion here reads: it climbs once per `_process`, so a
/// paused game is one whose counter stands still, and a restarted game is one whose counter starts
/// again.
#[test]
fn every_runtime_operation_no_turn_has_ever_used_still_answers() {
    let session = start_session();
    let app = mock_app();
    let data = TempDir::new().expect("temporary application data");
    let storage = crate::storage::ProjectStorage::open(data.path(), &session.worktree)
        .expect("open project storage");
    app.manage(crate::storage::StorageSlot::new(Ok(storage)));

    let call = |tool: &str, params: Value| {
        ai_tools::dispatch(
            app.handle(),
            ai_tools::ToolRequest {
                tool: tool.to_owned(),
                params,
            },
        )
    };
    let result = |answer: &Value| answer["ops"][0]["result"].clone();
    let counter = || {
        let read = call(
            "godot_runtime",
            json!({"ops": [{
                "op": "inspect_node",
                "path": "/root/AiFixture",
                "properties": ["counter"],
            }]}),
        )
        .expect("the probe answers about its own counter");
        result(&read)["properties"]["counter"]["value"]
            .as_i64()
            .unwrap_or_else(|| panic!("the counter has to cross the wire as a number: {read}"))
    };

    let ran = call("godot_runtime", json!({"ops": [{"op": "run"}]})).expect("run the game");
    assert_eq!(result(&ran)["running"], true, "{ran}");

    let state = call("godot_runtime", json!({"ops": [{"op": "get_state"}]}))
        .expect("the editor reports what the game is doing");
    assert_eq!(result(&state)["running"], true, "{state}");
    assert_eq!(result(&state)["runtimeReady"], true, "{state}");

    let waited = call(
        "godot_runtime",
        json!({"ops": [{"op": "wait", "frames": 5}]}),
    )
    .expect("let five frames pass");
    assert_eq!(result(&waited)["frames"], 5, "{waited}");

    let held = counter();
    let paused = call("godot_runtime", json!({"ops": [{"op": "pause"}]})).expect("pause the game");
    assert_eq!(result(&paused)["paused"], true, "{paused}");
    let standing = counter();
    call("godot_runtime", json!({"ops": [{"op": "wait", "ms": 200}]}))
        .expect("a paused game still answers a wait");
    assert_eq!(
        counter(),
        standing,
        "a paused game must not tick, and it stood at {held} before the pause"
    );

    let resumed = call("godot_runtime", json!({"ops": [{"op": "resume"}]})).expect("resume it");
    assert_eq!(result(&resumed)["paused"], false, "{resumed}");
    call(
        "godot_runtime",
        json!({"ops": [{"op": "wait", "frames": 20}]}),
    )
    .expect("let the resumed game run");
    assert!(
        counter() > standing,
        "a resumed game has to tick again: it stood at {standing}"
    );

    let running = counter();
    let restarted =
        call("godot_runtime", json!({"ops": [{"op": "restart"}]})).expect("restart the game");
    assert_eq!(result(&restarted)["running"], true, "{restarted}");
    assert!(
        counter() < running,
        "a restart is a fresh game, so its counter cannot carry on from {running}"
    );

    let stopped = call("godot_runtime", json!({"ops": [{"op": "stop"}]})).expect("stop the game");
    assert_eq!(result(&stopped)["running"], false, "{stopped}");
}

/// A script named where a scene belongs, which is the everyday way an editor ends up waiting on a
/// person: the engine refuses to play it and asks what to do instead.
const NOT_A_SCENE: &str = "extends Node\n\nfunc _ready() -> void:\n\tpass\n";

/// The dialog an editor is waiting on is read and answered through the router.
///
/// `godot_runtime_acceptance` proves the addon reports and clears one; this is the two operations a
/// model has for it. Nothing else in the catalogue can get past a dialog, so an `answer_dialog`
/// that only ever ran down the wire is an operation the model is told about and nothing has driven.
#[test]
fn a_dialog_the_editor_is_waiting_on_is_answered_through_the_router() {
    let directory = TempDir::new().expect("temporary directory");
    let worktree = worktree_with_probes(&directory);
    std::fs::write(worktree.join("scripts/not_a_scene.gd"), NOT_A_SCENE)
        .expect("write the script the project will name as its main scene");
    let project = worktree.join("project.godot");
    let configured = std::fs::read_to_string(&project)
        .expect("read the fixture project")
        .replace(
            "run/main_scene=\"res://main.tscn\"",
            "run/main_scene=\"res://scripts/not_a_scene.gd\"",
        );
    std::fs::write(&project, configured).expect("write the project");
    let ledger = directory.path().join("ledger.json");
    let session = godot_editor_harness::Session::start_on_worktree_with(
        worktree,
        ledger,
        Some(directory),
        Transports {
            bind_editor: true,
            ..Transports::default()
        },
    );
    let app = mock_app();
    let data = TempDir::new().expect("temporary application data");
    let storage = crate::storage::ProjectStorage::open(data.path(), &session.worktree)
        .expect("open project storage");
    app.manage(crate::storage::StorageSlot::new(Ok(storage)));

    let call = |tool: &str, params: Value| {
        ai_tools::dispatch(
            app.handle(),
            ai_tools::ToolRequest {
                tool: tool.to_owned(),
                params,
            },
        )
    };

    let refused = call("godot_runtime", json!({"ops": [{"op": "run"}]}))
        .expect_err("a launch the editor turned into a question is not a launch");
    assert_eq!(refused.code, "editor_dialog_open", "{}", refused.message);

    let state = call("godot_session", json!({"ops": [{"op": "get_state"}]}))
        .expect("the session state carries the question");
    let dialog = state["ops"][0]["result"]["dialog"].clone();
    assert!(
        dialog["text"]
            .as_str()
            .is_some_and(|text| text.contains("is not a scene file")),
        "the state has to carry what the editor asked: {state}"
    );
    assert!(
        dialog["buttons"]
            .as_array()
            .is_some_and(|buttons| buttons.iter().any(|button| button == "Cancel")),
        "the choices the editor is offering have to be listed: {state}"
    );

    let _gate = crate::approvals::serialize_gate_tests();
    crate::approvals::open();
    let approving = crate::godot_journey_acceptance::approve_when_asked();
    let answered = call(
        "godot_session",
        json!({"ops": [{"op": "answer_dialog", "button": "Cancel"}]}),
    )
    .expect("press the button");
    assert_eq!(
        answered["ops"][0]["result"]["answered"], "Cancel",
        "{answered}"
    );
    assert_eq!(
        approving.join().expect("the approval responder"),
        1,
        "pressing a button in the editor is gated, so it must have been approved"
    );

    let after = call("godot_session", json!({"ops": [{"op": "get_state"}]}))
        .expect("the session state after the answer");
    assert!(
        after["ops"][0]["result"]["dialog"].is_null(),
        "an answered dialog is gone from the state: {after}"
    );
}

/// The first mutation of a session needs no read before it.
///
/// Its own paragraph again: the comment that described it was left heading
/// `a_frame_awaiting_call_against_a_halted_game_is_refused_before_it_waits`, which was written in
/// above it.
#[test]
fn the_first_mutation_of_a_session_needs_no_read_before_it() {
    let session = start_session();
    let app = mock_app();
    let data = TempDir::new().expect("temporary application data");
    let storage = crate::storage::ProjectStorage::open(data.path(), &session.worktree)
        .expect("open project storage");
    app.manage(crate::storage::StorageSlot::new(Ok(storage)));
    crate::read_ledger::forget_worktree(&session.worktree);

    let answer = ai_tools::dispatch(
        app.handle(),
        ai_tools::ToolRequest {
            tool: "godot_node".to_owned(),
            params: json!({"ops": [{
                "op": "create_nodes",
                "nodes": [{"parent": "/AiFixture", "name": "FirstMarker", "type": "Marker2D"}],
            }]}),
        },
    )
    .unwrap_or_else(|failure| {
        panic!(
            "the first mutation was refused: {} {}",
            failure.code, failure.message
        )
    });
    assert_eq!(
        answer["ops"][0]["result"]["nodes"][0],
        "/AiFixture/FirstMarker"
    );

    let again = ai_tools::dispatch(
        app.handle(),
        ai_tools::ToolRequest {
            tool: "godot_node".to_owned(),
            params: json!({"ops": [{
                "op": "create_nodes",
                "nodes": [{"parent": "/AiFixture", "name": "SecondMarker", "type": "Marker2D"}],
            }]}),
        },
    )
    .expect("the mutation after the first needs no read either");
    assert_eq!(
        again["ops"][0]["result"]["nodes"][0],
        "/AiFixture/SecondMarker"
    );
}

/// A handler the editor cannot compile is refused for the reason it really is.
///
/// The method list a node reports comes from the compiled script. An autoload registered while the
/// editor has been running is not in the map its compiler resolves global names from, so every
/// script naming one stops compiling *in the editor* while running perfectly in the game —
/// `Script.reload` answers `ERR_PARSE_ERROR` and the old method list stays. `connect_signal` then
/// refused with `Its script declares _process`, which reads as a fact about the file and is not
/// one. One live turn was told that three times, and recovered only by stopping and starting the
/// whole session.
#[test]
fn a_handler_the_editor_cannot_compile_says_so_rather_than_blaming_the_script() {
    let session = start_session();
    let app = mock_app();
    let data = TempDir::new().expect("temporary application data");
    let storage = crate::storage::ProjectStorage::open(data.path(), &session.worktree)
        .expect("open project storage");
    app.manage(crate::storage::StorageSlot::new(Ok(storage)));
    std::fs::create_dir_all(session.worktree.join("scripts")).expect("create scripts");

    let call = |tool: &str, params: Value| {
        ai_tools::dispatch(
            app.handle(),
            ai_tools::ToolRequest {
                tool: tool.to_owned(),
                params,
            },
        )
    };
    let save = |path: &str, text: &str| {
        call(
            "godot_script",
            json!({"ops": [{"op": "save", "path": path, "text": text}]}),
        )
    };

    save(
        "scripts/thing.gd",
        "extends Node2D\n\n\nfunc _process(_d: float) -> void:\n\tpass\n",
    )
    .expect("write the script");
    call(
        "godot_node",
        json!({"ops": [
            {"op": "create_nodes", "nodes": [
                {"parent": "/AiFixture", "name": "Thing", "type": "Node2D"},
                {"parent": "/AiFixture", "name": "Ticker", "type": "Timer"}
            ]},
            {"op": "set_properties", "properties": [
                {"node": "/AiFixture/Thing", "property": "script",
                 "value": {"type": "Resource", "value": {"path": "res://scripts/thing.gd"}}}
            ]}
        ]}),
    )
    .expect("attach the script and add a timer");

    let plain = call(
        "godot_node",
        json!({"ops": [{"op": "connect_signal", "node": "/AiFixture/Ticker", "signal": "timeout",
                        "method": "_on_nothing", "target": "/AiFixture/Thing"}]}),
    )
    .expect_err("a method nobody wrote must be refused");
    assert!(
        plain.message.contains("Its script declares _process"),
        "a script that compiles is described by its methods: {}",
        plain.message
    );

    save(
        "scripts/score_probe.gd",
        "extends Node\n\n\nfunc add(_n: int) -> void:\n\tpass\n",
    )
    .expect("write the autoload script");
    call(
        "godot_project",
        json!({"ops": [{"op": "set_autoload", "name": "ScoreProbe",
                        "path": "res://scripts/score_probe.gd"}]}),
    )
    .expect("register the autoload");
    call(
        "godot_script",
        json!({"ops": [{"op": "open", "paths": ["scripts/thing.gd"]}]}),
    )
    .expect("read before writing");
    save(
        "scripts/thing.gd",
        "extends Node2D\n\n\nfunc _process(_d: float) -> void:\n\tpass\n\n\n\
         func _on_ticker_timeout() -> void:\n\tScoreProbe.add(1)\n",
    )
    .expect("write the handler");

    let refused = call(
        "godot_node",
        json!({"ops": [{"op": "connect_signal", "node": "/AiFixture/Ticker", "signal": "timeout",
                        "method": "_on_ticker_timeout", "target": "/AiFixture/Thing"}]}),
    )
    .expect_err("the editor cannot compile the script, so it cannot vouch for the method");
    assert!(
        refused.message.contains("cannot compile its script"),
        "the refusal must say the editor cannot compile it: {}",
        refused.message
    );
    assert!(
        refused.message.contains("ScoreProbe"),
        "and name the autoload this session registered: {}",
        refused.message
    );
    assert!(
        !refused.message.contains("Its script declares"),
        "and never describe the stale method list as the script's own: {}",
        refused.message
    );
}

/// A script open in the language server is read again once an autoload gives its global a meaning.
///
/// An autoload is a global name, and a script parsed before the autoload existed was told the name
/// is not declared — correctly, at the time. Nothing about the document changes when the autoload
/// is registered, so the server never revisits it, and `godot_script diagnostics` keeps serving
/// that verdict off its cache. A live turn wrote a `Score` autoload, registered it, and was told
/// `Identifier "Score" not declared in the current scope` on three separate calls; it recovered by
/// closing the file and opening it again, which is this, done by hand and three calls later.
/// A `class_name` written this session is a type the next script can name.
///
/// `godot_script` writes through the language server, which is a different door from every other
/// write in this router, and the file was never named to the editor's filesystem. The server read
/// it back perfectly well; nothing else knew it existed. Two live runs met that as
/// `Could not find type "Coin" in the current scope.` and `Could not find type "Player"`, six
/// occurrences between them, against classes they had written minutes earlier — and with strict
/// typing on, a warning like that is an error and the script does not load.
///
/// Measured before it was changed: reopening the dependent script does not fix it, and neither
/// does a whole-project `rescan` with no path. Naming the file does. See `told_the_editor_about`.
#[test]
fn a_class_name_written_this_session_is_a_type_the_next_script_can_use() {
    let session = start_session();
    let app = mock_app();
    std::fs::create_dir_all(session.worktree.join("scripts")).expect("create scripts");
    let call = |tool: &str, params: Value| {
        ai_tools::dispatch(
            app.handle(),
            ai_tools::ToolRequest {
                tool: tool.to_owned(),
                params,
            },
        )
        .unwrap_or_else(|failure| {
            panic!("{tool} was refused: {} {}", failure.code, failure.message)
        })
    };
    let complaints = |reported: &Value| -> Vec<String> {
        reported["diagnostics"]
            .as_array()
            .map(|list| {
                list.iter()
                    .filter_map(|one| one["message"].as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default()
    };

    let declared = call(
        "godot_script",
        json!({"ops": [{"op": "save", "path": "scripts/coin.gd",
                        "text": "class_name Coin\nextends Area2D\n\n\nfunc value() -> int:\n\treturn 1\n"}]}),
    );
    assert!(
        complaints(&declared["ops"][0]["result"]).is_empty(),
        "{declared}"
    );

    let user = call(
        "godot_script",
        json!({"ops": [{"op": "save", "path": "scripts/holder.gd",
                        "text": "extends Node\n\nvar held: Coin = null\n"}]}),
    );
    assert!(
        complaints(&user["ops"][0]["result"]).is_empty(),
        "a class declared a moment ago must be a type the next script can name: {user}"
    );

    let asked = call(
        "godot_script",
        json!({"ops": [{"op": "diagnostics", "paths": ["scripts/holder.gd"]}]}),
    );
    assert!(
        complaints(&asked["ops"][0]["result"]["files"][0]).is_empty(),
        "{asked}"
    );
}

#[test]
fn a_script_is_read_again_once_an_autoload_declares_the_name_it_uses() {
    let session = start_session();
    let app = mock_app();
    let scripts = session.worktree.join("scripts");
    std::fs::create_dir_all(&scripts).expect("create scripts");
    std::fs::write(
        scripts.join("settings.gd"),
        "extends Node\n\nvar volume := 0.5\n",
    )
    .expect("write settings.gd");
    std::fs::write(
        scripts.join("uses_autoload.gd"),
        "extends Node\n\n\nfunc _ready() -> void:\n\tprint(Settings.volume)\n",
    )
    .expect("write uses_autoload.gd");

    let call = |tool: &str, params: Value| {
        ai_tools::dispatch(
            app.handle(),
            ai_tools::ToolRequest {
                tool: tool.to_owned(),
                params,
            },
        )
        .unwrap_or_else(|failure| {
            panic!("{tool} was refused: {} {}", failure.code, failure.message)
        })
    };
    let named = |answer: &Value| -> Vec<String> {
        answer["ops"][0]["result"]["files"][0]["diagnostics"]
            .as_array()
            .map(|list| {
                list.iter()
                    .filter_map(|one| one["message"].as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default()
    };

    call(
        "godot_script",
        json!({"ops": [{"op": "open", "paths": ["scripts/uses_autoload.gd"]}]}),
    );
    let before = call(
        "godot_script",
        json!({"ops": [{"op": "diagnostics", "paths": ["scripts/uses_autoload.gd"]}]}),
    );
    assert!(
        named(&before)
            .iter()
            .any(|message| message.contains("Settings")),
        "the name has no meaning yet, so the server must say so: {before}"
    );

    call(
        "godot_project",
        json!({"ops": [{"op": "set_autoload", "name": "Settings",
                        "path": "res://scripts/settings.gd"}]}),
    );
    let after = call(
        "godot_script",
        json!({"ops": [{"op": "diagnostics", "paths": ["scripts/uses_autoload.gd"]}]}),
    );
    assert_eq!(
        named(&after),
        Vec::<String>::new(),
        "once the autoload declares it, the script that uses it is clean: {after}"
    );
}

/// A restart of a game halted at a step stops again, and the wait after it says so.
///
/// Godot's own `restart` re-ran the game and never announced the stop the new game hit: the
/// adapter sent `process` and `output` and no `stopped`, while `get_state` read `broke: true` and
/// `stack_trace` listed the frames. Two live turns waited 65 s on it. This is the live shape,
/// with no terminate before the restart, and it is answered by terminating and launching afresh.
#[test]
fn a_restart_of_a_game_halted_at_a_step_stops_again() {
    let session = start_session();
    let app = mock_app();
    let data = TempDir::new().expect("temporary application data");
    let storage = crate::storage::ProjectStorage::open(data.path(), &session.worktree)
        .expect("open project storage");
    app.manage(crate::storage::StorageSlot::new(Ok(storage)));
    let call = |tool: &str, params: Value| {
        ai_tools::dispatch(
            app.handle(),
            ai_tools::ToolRequest {
                tool: tool.to_owned(),
                params,
            },
        )
    };
    call(
        "godot_debug",
        json!({"ops": [{"op": "launch", "playArgs": ["--headless"],
            "breakpoints": [{"path": PROBE_PATH, "lines": [BREAK_LINE]}]}]}),
    )
    .expect("launch");
    call(
        "godot_debug",
        json!({"ops": [{"op": "await_stop", "timeoutMs": 60000}]}),
    )
    .expect("the first stop");
    call("godot_debug", json!({"ops": [{"op": "step_over"}]})).expect("step over");
    let stepped = call(
        "godot_debug",
        json!({"ops": [{"op": "await_stop", "timeoutMs": 60000}]}),
    )
    .expect("the step lands");
    assert_eq!(
        stepped["ops"][0]["result"]["stopped"]["reason"], "step",
        "{stepped}"
    );

    let restarted =
        call("godot_debug", json!({"ops": [{"op": "restart"}]})).expect("restart the halted game");
    assert_eq!(
        restarted["ops"][0]["result"]["op"], "launched",
        "a restart answers like the launch it is: {restarted}"
    );
    assert_eq!(
        restarted["ops"][0]["result"]["armed"],
        json!([format!("{PROBE_PATH}:{BREAK_LINE}")]),
        "and names the breakpoints it re-armed: {restarted}"
    );
    let again = call(
        "godot_debug",
        json!({"ops": [{"op": "await_stop", "timeoutMs": 60000}]}),
    )
    .expect("the restarted game stops on the same breakpoint, and the wait is told");
    assert_eq!(
        again["ops"][0]["result"]["stopped"]["reason"], "breakpoint",
        "{again}"
    );
    let _ = call("godot_debug", json!({"ops": [{"op": "terminate"}]}));
}

/// A game the editor plays after a debug game was terminated runs free of the debug breakpoints.
///
/// Measured on 4.7.2: a `set_breakpoints` with no lines sent after `terminate` is answered with
/// an empty list and changes nothing in the editor, and the next `runtime.run` broke on the line
/// the launch had set. A live turn did exactly that, twice, and read its own stale error tail
/// for the cause. The editor's copies are released before the terminate; Gofer's record stays
/// for the next launch, which re-sends it.
#[test]
fn a_run_after_a_terminated_debug_game_does_not_inherit_its_breakpoint() {
    let session = start_session();
    let app = mock_app();
    let data = TempDir::new().expect("temporary application data");
    let storage = crate::storage::ProjectStorage::open(data.path(), &session.worktree)
        .expect("open project storage");
    app.manage(crate::storage::StorageSlot::new(Ok(storage)));
    let call = |tool: &str, params: Value| {
        ai_tools::dispatch(
            app.handle(),
            ai_tools::ToolRequest {
                tool: tool.to_owned(),
                params,
            },
        )
    };
    call(
        "godot_debug",
        json!({"ops": [{"op": "launch", "playArgs": ["--headless"],
            "breakpoints": [{"path": PROBE_PATH, "lines": [BREAK_LINE]}]}]}),
    )
    .expect("launch");
    call(
        "godot_debug",
        json!({"ops": [{"op": "await_stop", "timeoutMs": 60000}]}),
    )
    .expect("the first stop");
    call("godot_debug", json!({"ops": [{"op": "terminate"}]})).expect("terminate");
    assert_eq!(
        crate::debug::armed_breakpoints(),
        vec![PROBE_PATH.to_owned()],
        "Gofer's own record outlives the game, for the next launch to re-send"
    );
    call(
        "godot_debug",
        json!({"ops": [{"op": "set_breakpoints", "path": PROBE_PATH, "lines": []}]}),
    )
    .expect("a clear after the terminate is still accepted");

    call(
        "godot_runtime",
        json!({"ops": [{"op": "run", "playArgs": ["--headless"]}]}),
    )
    .expect("the editor plays the game on its own");
    let waited = call(
        "godot_runtime",
        json!({"ops": [{"op": "wait", "ms": 1500}]}),
    )
    .expect("a game free of the debug breakpoint runs its frames");
    assert_eq!(waited["ops"][0]["result"]["exited"], false, "{waited}");
    let state = call("godot_runtime", json!({"ops": [{"op": "get_state"}]})).expect("state");
    assert_eq!(state["ops"][0]["result"]["broke"], false, "{state}");
    let _ = call("godot_runtime", json!({"ops": [{"op": "stop"}]}));
}

/// A wait for frames that the debugger interrupts is answered at the break, not at its deadline.
///
/// A live turn pressed the key that reached its own breakpoint and waited twenty seconds to be
/// told the game had stopped. The press was delivered; the addon knew the game had broken the
/// moment it did.
#[test]
fn a_wait_the_debugger_interrupts_is_answered_at_the_break() {
    let session = start_session();
    let app = mock_app();
    let data = TempDir::new().expect("temporary application data");
    let storage = crate::storage::ProjectStorage::open(data.path(), &session.worktree)
        .expect("open project storage");
    app.manage(crate::storage::StorageSlot::new(Ok(storage)));
    let call = |tool: &str, params: Value| {
        ai_tools::dispatch(
            app.handle(),
            ai_tools::ToolRequest {
                tool: tool.to_owned(),
                params,
            },
        )
    };
    call("godot_debug", json!({"ops": [{"op": "launch"}]})).expect("launch with nothing armed");
    // The launch answers when the process starts; the helper announces itself a little later,
    // and there is no event for it on this side, so the state is read until it says ready.
    let booting = std::time::Instant::now();
    let drawing = loop {
        let waited = call(
            "godot_runtime",
            json!({"ops": [{"op": "wait", "frames": 5}]}),
        );
        if let Ok(answer) = &waited
            && answer["ops"][0]["result"]["exited"] == false
        {
            break answer.clone();
        }
        assert!(
            booting.elapsed() < std::time::Duration::from_secs(60),
            "the helper never announced itself: {waited:?}"
        );
    };
    assert_eq!(drawing["ops"][0]["result"]["exited"], false, "{drawing}");
    let armed = call(
        "godot_debug",
        json!({"ops": [{"op": "set_breakpoints", "path": PROBE_PATH, "lines": [BREAK_LINE]}]}),
    )
    .expect("arm a line that runs every frame");
    assert_eq!(
        armed["ops"][0]["result"]["breakpoints"][0]["verified"], true,
        "{armed}"
    );
    let started = std::time::Instant::now();
    let interrupted = call(
        "godot_runtime",
        json!({"ops": [{"op": "wait", "ms": 20000}]}),
    )
    .expect_err("a wait the break interrupts is refused");
    assert_eq!(interrupted.code, "runtime_broke", "{}", interrupted.message);
    assert!(
        interrupted
            .message
            .contains("stopped the game while this call was waiting"),
        "{}",
        interrupted.message
    );
    assert!(
        started.elapsed() < std::time::Duration::from_secs(10),
        "answered at the break, not at the deadline: {:?}",
        started.elapsed()
    );
    let _ = call("godot_debug", json!({"ops": [{"op": "terminate"}]}));
}

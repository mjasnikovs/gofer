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
//! One catalog domain is deliberately absent. `godot_docs_search` retrieves through the gofer-rag
//! sidecar against downloaded embedding models, and a suite that has to fetch a model before it
//! can start is not one anybody runs; its own tests stand in `rag.rs`.
//!
//! Gated behind the `godot-acceptance` feature so the fast gate needs no engine.

use crate::ai_tools;
use crate::ai_turn::{AiWorkerMessage, AiWorkerRequest, ChatSender};
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
const PROBE_SCENE: &str = "[gd_scene load_steps=2 format=3]\n\n[ext_resource type=\"Script\" path=\"res://scripts/main_probe.gd\" id=\"1_probe\"]\n\n[node name=\"AiFixture\" type=\"Node2D\"]\nscript = ExtResource(\"1_probe\")\n\n[node name=\"Label\" type=\"Label\" parent=\".\"]\noffset_right = 320.0\noffset_bottom = 40.0\n";

/// The same unclosed parameter list the language-server acceptance uses, because it is a parse
/// error the real server is already known to report.
const BROKEN_SCRIPT: &str = "extends Node\n\nfunc explode( -> void:\n\tpass\n";
const FIXED_SCRIPT: &str = "extends Node\n\nfunc explode() -> void:\n\tpass\n";

const SCENE_PATH: &str = "res://main.tscn";
const BROKEN_PATH: &str = "scripts/broken.gd";
const PROBE_PATH: &str = "scripts/main_probe.gd";

/// The live fixture's own art: a real 8x2 atlas of 16x16 tiles, which is what makes
/// `create_tileset` answer with a grid rather than refuse a texture it cannot cut.
const ATLAS: &[u8] = include_bytes!("../../fixtures/live-project/assets/tiles.png");
const ATLAS_PATH: &str = "res://tiles.png";
const TILESET_PATH: &str = "res://tiles/world.tres";

/// Copies the fixture project and turns it into the project the turn works on: a main scene with
/// a probe script, a script that does not parse, and the atlas the tileset is cut from.
fn fixture_worktree(directory: &TempDir) -> PathBuf {
    let worktree = godot_editor_harness::fixture_worktree(directory);
    let scripts = worktree.join("scripts");
    std::fs::create_dir_all(&scripts).expect("create scripts directory");
    std::fs::write(scripts.join("main_probe.gd"), PROBE_SCRIPT).expect("write the probe script");
    std::fs::write(scripts.join("broken.gd"), BROKEN_SCRIPT).expect("write the broken script");
    std::fs::write(worktree.join("main.tscn"), PROBE_SCENE).expect("write the probe scene");
    // Written before the editor starts so its first import scan picks the texture up; the turn
    // still asks for a rescan, because that is the operation a real agent has to reach for after
    // it puts an asset in the worktree itself.
    std::fs::write(worktree.join("tiles.png"), ATLAS).expect("write the atlas");
    worktree
}

/// One editor session with every transport open and bound, so a tool call from the worker reaches
/// this editor exactly as it would reach a supervised one.
///
/// The binding is the harness's, not this suite's: the router reaches the language server, the
/// debug adapter and the addon through process-wide state, and that has to be cleared before the
/// session behind it is torn down — including when an assertion panics first.
fn start_session() -> godot_editor_harness::Session {
    let directory = TempDir::new().expect("temporary directory");
    let worktree = fixture_worktree(&directory);
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
        // No `expectedRevision`, on purpose, and this is the mutation that proves it: the router
        // holds the revision step 0's open answered with and supplies it. The parameter is hidden
        // from the signature, so a model that copies numbers out of answers is a model doing work
        // it was never meant to do — a measured turn spent a refusal and a whole second
        // `scene.get_tree`, 28,067 tokens, reading one back.
        1 => tool(
            "godot_node",
            json!({"op": "create", "params": {
                "scene": SCENE_PATH,
                "parent": "/AiFixture",
                "name": "AiMarker",
                "type": "Marker2D",
            }}),
        ),
        2 => tool("godot_scene", json!({"op": "get_tree", "params": {}})),
        // This one passes its own, because a caller that holds a revision must still be obeyed
        // rather than overruled by the record — the same contract `expectedHash` has.
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
        // No `expectedHash`, on purpose. The router holds the hash step 4's open answered with and
        // supplies it, so the model never copies sixty-four hex characters — the slip that cost a
        // live run its script. A save over a file this turn has not read is still refused.
        6 => tool(
            "godot_script",
            json!({"op": "save", "params": {"path": BROKEN_PATH, "text": FIXED_SCRIPT}}),
        ),
        7 => tool(
            "godot_script",
            json!({"op": "diagnostics", "params": {"path": BROKEN_PATH, "timeoutMs": 30000}}),
        ),
        8 => tool(
            "godot_debug",
            json!({"op": "launch", "params": {
                "playArgs": ["--headless"],
                "breakpoints": [{"path": PROBE_PATH, "lines": [ASKED_LINE]}],
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
        // The three domains the turn used to skip. `godot_project` is not a pass-through — the
        // router rewrites its three editor-settings operations into the addon's `editor.` domain —
        // and `godot_resource`'s list, move and delete are answered by the desktop out of the
        // workspace rather than by the addon at all. Both were only ever checked by a test that
        // reads strings.
        18 => tool("godot_resource", json!({"op": "rescan", "params": {}})),
        19 => tool("godot_project", json!({"op": "get_settings", "params": {}})),
        20 => tool(
            "godot_project",
            json!({"op": "search_editor_settings", "params": {"query": "font_size"}}),
        ),
        21 => tool(
            "godot_resource",
            json!({"op": "list", "params": {"hashes": true}}),
        ),
        22 => tool(
            "godot_resource",
            json!({"op": "create_tileset", "params": {
                "path": TILESET_PATH,
                "texture": ATLAS_PATH,
                "tileSize": 16,
                "solid": [[0, 0], [1, 0], [4, 0], [5, 0]],
            }}),
        ),
        23 => tool(
            "godot_resource",
            json!({"op": "describe_tileset", "params": {"path": TILESET_PATH}}),
        ),
        // The list itself, against the real editor: two inspections of the scene this turn built,
        // in one call rather than two. Everything above is one operation per call because each
        // needs the answer before it; nothing above would catch a list that only works in a unit
        // test.
        24 => tools(
            "godot_node",
            &[
                json!({"op": "inspect", "params": {"node": "/AiFixture"}}),
                json!({"op": "inspect", "params": {"node": "/AiFixture/AiMarker"}}),
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
    // `godot_resource`'s own operations are answered out of the workspace rather than by the
    // addon, and the workspace comes from project storage. It lives outside the worktree so that
    // listing the worktree lists the project and nothing of Gofer's.
    let data = TempDir::new().expect("temporary application data");
    let storage = crate::storage::ProjectStorage::open(data.path(), &session.worktree)
        .expect("open project storage");
    app.manage(crate::storage::StorageSlot::new(Ok(storage)));

    // Every declared tool is probed before the turn starts, and the documentation tool's probe
    // reads the machine: the sidecar script and the model cache. Both are pointed at fixtures, for
    // the same reason the tool is otherwise absent from this suite.
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

    // The turn's stream. Nothing reads it here — the assertions are about what the tools did, not
    // what the renderer was told — but the worker writes to it, so it has to exist.
    let stream = tauri::ipc::Channel::new(|_| Ok(()));
    // The real turn, not a re-enactment of one: it opens the approval gate the gated tools need
    // and puts every one of the turn's process-wide values back when this function returns.
    let turn = crate::ai_turn::AiTurn::begin(1, stream).expect("no other AI turn is running");

    let completion = crate::ai_turn::run_ai_worker_with(
        app.handle(),
        &turn,
        AiWorkerRequest {
            settings: AiSettings {
                base_url,
                model: "gofer-acceptance".to_owned(),
                max_retries: 0,
                ..AiSettings::default()
            },
            api_key: None,
            openrouter_api_key: None,
            brave_api_key: None,
            oauth_credential: None,
            session_id: Some("godot-ai-acceptance".to_owned()),
            workspace_path: session.worktree.display().to_string(),
            tools: ai_tools::CATALOG,
            // No system prompt of its own, so the suite drives the agent Gofer ships.
            job: crate::ai_turn::WorkerJob::Turn {
                messages: vec![AiWorkerMessage {
                    sender: ChatSender::User,
                    text:
                        "Add a marker, fix the broken script, debug the probe, and show me the game."
                            .to_owned(),
                    timestamp: 1,
                    images: Vec::new(),
                }],
                agent_messages: None,
                is_retry: false,
                memory_context: None,
                // Filled by `run_ai_worker_with`, like the prompt beside it, from the editor this
                // suite has bound.
                session_context: None,
                system_prompt: None,
            },
        },
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
        25,
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
    // The declaration the turn asked for became the statement under it, and the answer says so.
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

    // The project domain, and with it the router's own rewrite: `search_editor_settings` is not a
    // `project.` command at all, it is the addon's `editor.search_settings`, and the mapping lives
    // in `project_command` where nothing but a string comparison used to look at it.
    assert_eq!(
        results[19]["projectName"],
        "Gofer Protocol Fixture",
        "{}",
        quote("the project domain must answer with this project's own settings")
    );
    assert!(
        results[20]["settings"]
            .as_array()
            .is_some_and(|settings| !settings.is_empty()),
        "{}",
        quote("the editor-settings search must reach the addon's editor domain")
    );

    // The resource domain, which the desktop answers out of the workspace: the listing records the
    // hash a delete of a non-script file is held to, and it is the file's real hash. It records it
    // rather than reporting it — the ledger holds every hash now, so no answer carries one.
    let listed = results[21]["files"]
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
    // Gofer's own staged addon is not in the project, and Gofer says so itself by writing
    // `addons/gofer/` into the checkout's Git exclude file. Ten of the sixteen entries a bare
    // fixture used to list were it, and a turn stuck on a runtime call read `addons/gofer/
    // runtime.gd` through four subagents rather than working on the game.
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
            // The ledger is keyed by the workspace's own root, which is canonical.
            &std::fs::canonicalize(&session.worktree).expect("canonical worktree"),
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

    // The tileset pair, through the router this time rather than straight at the addon.
    assert_eq!(
        results[22]["grid"],
        json!([8, 2]),
        "{}",
        quote("the atlas is eight tiles by two")
    );
    assert_eq!(
        results[22]["physicsLayers"],
        1,
        "{}",
        quote("solid tiles need a physics layer")
    );
    let tiles = results[23]["sources"][0]["tiles"]
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

    // The list, against the real editor: two inspections written as one call, answered as two
    // entries in the order they were written. This is the whole point of the `ops` list — the
    // model that wanted both used to spend a turn on each — so it is proven here rather than only
    // where a fake backend answers.
    let batched = results[24]["ops"]
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
#[test]
fn the_first_mutation_of_a_session_needs_no_read_before_it() {
    let session = start_session();
    let app = mock_app();
    let data = TempDir::new().expect("temporary application data");
    let storage = crate::storage::ProjectStorage::open(data.path(), &session.worktree)
        .expect("open project storage");
    app.manage(crate::storage::StorageSlot::new(Ok(storage)));
    // Whatever any earlier test in this process left behind. The point of the test is the empty
    // ledger, so it is emptied rather than assumed.
    crate::read_ledger::forget_worktree(&session.worktree);

    let answer = ai_tools::dispatch(
        app.handle(),
        ai_tools::ToolRequest {
            tool: "godot_node".to_owned(),
            params: json!({"ops": [{
                "op": "create",
                "parent": "/AiFixture",
                "name": "FirstMarker",
                "type": "Marker2D",
            }]}),
        },
    )
    .unwrap_or_else(|failure| {
        panic!(
            "the first mutation was refused: {} {}",
            failure.code, failure.message
        )
    });
    assert_eq!(answer["ops"][0]["result"]["node"], "/AiFixture/FirstMarker");

    // And the number it settled on is now the router's, so the mutation after it needs no read
    // either — the retry has to leave the ledger where a normal answer would.
    let again = ai_tools::dispatch(
        app.handle(),
        ai_tools::ToolRequest {
            tool: "godot_node".to_owned(),
            params: json!({"ops": [{
                "op": "create",
                "parent": "/AiFixture",
                "name": "SecondMarker",
                "type": "Marker2D",
            }]}),
        },
    )
    .expect("the mutation after the first needs no read either");
    assert_eq!(again["ops"][0]["result"]["node"], "/AiFixture/SecondMarker");
}

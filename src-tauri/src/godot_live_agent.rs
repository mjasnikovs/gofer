//! One real model turn against one real Godot editor, recorded rather than asserted.
//!
//! Not a test, and it asserts nothing: a local LLM cannot be a fixture, which is why
//! [`crate::godot_ai_acceptance`] — the same wiring, the same router, the same pinned editor with
//! its addon, language server and debug adapter — drives a scripted model instead. This one points
//! that wiring at a real endpoint and writes down every event the turn streamed: every tool call,
//! its parameters' fate, its result, and the editor's own output.
//!
//! It exists because the question "what does the agent actually get wrong" has no other answer on a
//! machine without `WebKitWebDriver`, which is what `wdio.live.conf.ts` needs and which several
//! distributions do not package. Five recurring defects were found by reading its output and
//! counting: a vector written as `{x, y}`, a tagged value wrapped twice, a scalar boxed under the
//! protocol's own kind word, a catalogue telling the model to send what the router sends, and a
//! rule Gofer enforces that the prompt never mentioned. Each was a shape that repeated inside one
//! turn, which is what separates a defect from a model having a bad day.
//!
//! It does nothing at all unless `GOFER_LIVE_TASK` names an ask, so the gate that compiles it is
//! unaffected:
//!
//! ```text
//! cargo test --manifest-path src-tauri/Cargo.toml --features godot-acceptance --lib \
//!   -- live_agent_acceptance --test-threads=1 --nocapture
//! ```
//!
//! with `GOFER_LIVE_TASK` set, `GOFER_LIVE_OUT` naming a file for the events, and
//! `GOFER_LIVE_BASE_URL` / `GOFER_LIVE_MODEL` naming the endpoint — the defaults are a llama.cpp on
//! `127.0.0.1:8080`. `GOFER_LIVE_KEEP` copies the worktree out before its temporary directory goes,
//! which is the only way to look at what the agent built.
//!
//! [`dump_catalog_and_prompt`] writes the other half: the catalog and system prompt exactly as the
//! worker receives them, so a harness outside Rust can pose the same turn to the same model without
//! an editor. The prompt A/B that measured the strict-typing line ran on those two files.

use crate::ai_tools;
use crate::ai_turn::{AiWorkerMessage, AiWorkerRequest, ChatSender};
use crate::godot_editor_harness::{self, Transports, free_port};
use crate::process::SystemProcessSpawner;
use crate::settings::AiSettings;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::Manager;
use tempfile::TempDir;

fn start_session() -> godot_editor_harness::Session {
    let directory = TempDir::new().expect("temporary directory");
    let worktree = godot_editor_harness::fixture_worktree(&directory);
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
fn live_agent_acceptance() {
    let Ok(task) = std::env::var("GOFER_LIVE_TASK") else {
        return;
    };
    let out = PathBuf::from(
        std::env::var("GOFER_LIVE_OUT").expect("GOFER_LIVE_OUT names where the events go"),
    );
    let base_url = std::env::var("GOFER_LIVE_BASE_URL")
        .unwrap_or_else(|_| "http://127.0.0.1:8080/v1".to_owned());
    let model = std::env::var("GOFER_LIVE_MODEL").unwrap_or_else(|_| "local".to_owned());

    let session = start_session();
    // The rules a real session applies when it goes ready. Without them the strict-typing policy
    // Gofer ships turned on is simply absent, and a run measures a project nobody has.
    for call in crate::godot_policy::policy_calls(&crate::settings::GodotSettings::default()) {
        let answered = session.try_call(call.command, call.params.clone(), None);
        println!("policy {} -> {answered:?}", call.command);
    }
    let app = mock_app();
    let data = TempDir::new().expect("temporary application data");
    let storage = crate::storage::ProjectStorage::open(data.path(), &session.worktree)
        .expect("open project storage");
    app.manage(crate::storage::StorageSlot::new(Ok(storage)));

    // The user's own retrieval cache and the real retrieve worker, so `godot_docs_search` answers
    // out of the real corpus. A fixture worker would answer canned passages, and the agent is told
    // to search the docs before writing any Godot name — canned answers would be the experiment
    // measuring its own fixture.
    // SAFETY: the acceptance runner gives each test its own process.
    unsafe {
        std::env::set_var(
            "GOFER_RAG_CACHE_DIR",
            std::env::var("HOME")
                .map(|home| format!("{home}/.cache/gofer-rag"))
                .expect("HOME"),
        );
    }

    let events: Arc<Mutex<Vec<serde_json::Value>>> = Arc::new(Mutex::new(Vec::new()));
    let recorded = Arc::clone(&events);
    let stream = tauri::ipc::Channel::new(move |payload| {
        if let Ok(value) = payload.deserialize::<serde_json::Value>()
            && let Ok(mut held) = recorded.lock()
        {
            held.push(value);
        }
        Ok(())
    });
    let turn = crate::ai_turn::AiTurn::begin(1, stream).expect("no other AI turn is running");

    let started = std::time::Instant::now();
    let completion = crate::ai_turn::run_ai_worker_with(
        app.handle(),
        &turn,
        AiWorkerRequest {
            settings: AiSettings {
                base_url,
                model,
                max_retries: 0,
                ..AiSettings::default()
            },
            api_key: None,
            brave_api_key: None,
            oauth_credential: None,
            session_id: Some("godot-live-agent".to_owned()),
            workspace_path: session.worktree.display().to_string(),
            tools: ai_tools::CATALOG,
            job: crate::ai_turn::WorkerJob::Turn {
                messages: vec![AiWorkerMessage {
                    sender: ChatSender::User,
                    text: task.clone(),
                    timestamp: 1,
                    images: Vec::new(),
                }],
                agent_messages: None,
                is_retry: false,
                memory_context: None,
                system_prompt: None,
            },
        },
        &SystemProcessSpawner,
    );
    let seconds = started.elapsed().as_secs_f64();

    let held = events.lock().expect("events lock");
    let report = serde_json::json!({
        "task": task,
        "seconds": seconds,
        "completion": completion.as_deref().map(std::string::ToString::to_string).ok(),
        "failure": completion.as_ref().err().map(std::string::ToString::to_string),
        "events": held.clone(),
        "editorOutput": session.output(),
        "worktree": session.worktree.display().to_string(),
    });
    std::fs::write(
        &out,
        serde_json::to_string(&report).expect("serialize the report"),
    )
    .expect("write the report");
    // The worktree is a temporary directory the session removes, so anything the agent built has to
    // be copied out before this returns.
    if let Ok(keep) = std::env::var("GOFER_LIVE_KEEP") {
        let _ = std::fs::create_dir_all(&keep);
        godot_editor_harness::copy_tree(&session.worktree, &PathBuf::from(&keep));
    }
    // The game the turn launched is not the editor's child to reap, and dropping the session kills
    // only the editor. Four runs each left one behind, all of them holding Godot's default remote
    // debug port, and the fifth hung for thirty minutes waiting for a port three dead games were
    // sitting on. Asking the runtime to stop is the same call the agent would have made.
    let _ = session.try_call("runtime.stop", serde_json::json!({}), None);
    println!("live agent finished in {seconds:.1}s -> {}", out.display());
}

/// TEMPORARY: writes what the worker receives, so a harness outside Rust can pose the same turn.
#[test]
fn dump_catalog_and_prompt() {
    let Ok(catalog_path) = std::env::var("GOFER_DUMP_CATALOG") else {
        return;
    };
    let prompt_path = std::env::var("GOFER_DUMP_PROMPT").expect("GOFER_DUMP_PROMPT");
    std::fs::write(
        catalog_path,
        serde_json::to_string_pretty(ai_tools::CATALOG).expect("serialize the catalog"),
    )
    .expect("write the catalog");
    std::fs::write(
        prompt_path,
        crate::agent_prompt::default_prompt(ai_tools::CATALOG, true),
    )
    .expect("write the prompt");
}

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
//! with `GOFER_LIVE_TASK` set, `GOFER_LIVE_OUT` naming a file for the events — its `.jsonl` sibling
//! gets each event as it arrives, so a turn killed on a budget still leaves what it saw — and
//! `GOFER_LIVE_BASE_URL` / `GOFER_LIVE_MODEL` naming the endpoint, and `GOFER_LIVE_FIXTURE`
//! naming a project to work on other than the bare one — the defaults are a llama.cpp on
//! `127.0.0.1:8080`. `GOFER_LIVE_KEEP` copies the worktree out before its temporary directory goes,
//! which is the only way to look at what the agent built.
//!
//! [`dump_catalog_and_prompt`] writes the other half: the catalog and system prompt exactly as the
//! worker receives them, so a harness outside Rust can pose the same turn to the same model without
//! an editor. The prompt A/B that measured the strict-typing line ran on those two files.

use crate::ai_tools;
use crate::ai_turn::{AiWorkerMessage, ChatSender, Job, JobContext};
use crate::godot_editor_harness::{self, Transports, free_port};
use crate::process::SystemProcessSpawner;
use crate::settings::AiSettings;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::Manager;
use tempfile::TempDir;

/// The project the turn works on.
///
/// `fixtures/godot-project` by default — a bare project, which is the right start for a turn about
/// building something from nothing. It holds no art, so a task about tiles spends its first calls
/// discovering that and making a texture, which measures error recovery rather than the tilemap
/// path. `GOFER_LIVE_FIXTURE` names another directory to copy instead; `fixtures/live-project` is
/// the one with an atlas, two scripts and a scene in it.
fn live_worktree(directory: &TempDir) -> PathBuf {
    let worktree = match std::env::var("GOFER_LIVE_FIXTURE") {
        Err(_) => godot_editor_harness::fixture_worktree(directory),
        Ok(named) => {
            let worktree = directory.path().join("worktree");
            godot_editor_harness::copy_tree(&named_fixture(&named), &worktree);
            crate::paths::canonical(&worktree).expect("canonical worktree")
        }
    };
    make_it_a_repository(&worktree);
    worktree
}

/// Answers the approval prompts a turn raises, because nothing else here can.
///
/// `godot_resource delete` and `move`, addon and plugin changes, and machine-wide editor settings
/// all stop and wait for the user — and there is no user in a live turn. `APPROVAL_TIMEOUT` is 300
/// seconds, so every one of them costs five minutes and comes back refused. One turn stopped dead
/// at its 384th call on a single `delete` and spent the whole five minutes there, which is not the
/// agent being slow and reads exactly like it in the timings.
///
/// Allowed, not refused: the point of a live turn is to watch the agent work, and the worktree it
/// works in is a temporary directory this file made. `GOFER_LIVE_APPROVE=refuse` answers no
/// instead, for a run about what the agent does when it is told no.
fn answer_the_prompts_nobody_is_watching(finished: Arc<std::sync::atomic::AtomicBool>) {
    let allow = std::env::var("GOFER_LIVE_APPROVE").as_deref() != Ok("refuse");
    std::thread::spawn(move || {
        while !finished.load(std::sync::atomic::Ordering::Relaxed) {
            for asked in crate::approvals::pending_approvals() {
                let _ = crate::approvals::respond(&asked, allow);
                println!("live approval {asked} -> {allow}");
            }
            std::thread::sleep(std::time::Duration::from_millis(200));
        }
    });
}

/// The fixture `GOFER_LIVE_FIXTURE` names, resolved the way the repository spells it.
///
/// Cargo starts a test binary in the package root, so `fixtures/live-project` — the path this
/// file's own documentation gives, and the one the project uses everywhere else — lands in
/// `src-tauri/fixtures`, which does not exist. What came back was `read fixture directory: Os {
/// code: 2 }` from inside `copy_tree`, naming neither the variable nor the path it had tried. A
/// relative path is looked for from the repository root as well, and a path that is nowhere says
/// both places it looked.
fn named_fixture(named: &str) -> PathBuf {
    let named = PathBuf::from(named);
    if named.exists() {
        return named;
    }
    let from_root = PathBuf::from("..").join(&named);
    assert!(
        from_root.exists(),
        "GOFER_LIVE_FIXTURE names {}, which is neither there nor at {} from the package root",
        named.display(),
        from_root.display()
    );
    from_root
}

/// Gives the worktree a Git repository, because without one the agent can lock itself out.
///
/// `godot_session start` resolves the active task's workspace, and that resolution needs a repo:
/// a plain copy answers `The project is not a Git repository`, which reaches the model as
/// `no_active_task_workspace: A Godot session can only start for an active task branch`. The
/// session this harness binds up front works anyway — until the agent calls `godot_session stop`,
/// which the catalogue offers it, and then there is no way back.
///
/// One live turn did exactly that. It spent three refusals guessing at what "active" meant, then
/// `rm -rf .godot`, then `git init`, then a commit — and only then could it start an editor again,
/// with twenty of its thirty minutes gone. The agent's recovery was right; the door should not have
/// been there. In the desktop application it is not: a task always has a repository behind it.
///
/// Failures are ignored on purpose. This is the harness making its fixture look like a real
/// checkout, and a machine without `git` should still be able to run a turn.
fn make_it_a_repository(worktree: &std::path::Path) {
    let git = |arguments: &[&str]| {
        let _ = std::process::Command::new("git")
            .args(arguments)
            .current_dir(worktree)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    };
    git(&["init", "--quiet"]);
    git(&["config", "user.email", "live@gofer.test"]);
    git(&["config", "user.name", "Gofer live sweep"]);
    git(&["add", "-A"]);
    git(&[
        "commit",
        "--quiet",
        "-m",
        "The fixture, as the turn found it",
    ]);
}

/// Launches the editor on a worktree the caller has already prepared and settled.
///
/// Split from the preparation because staging must be the *last* thing that touches
/// `project.godot`. See [`live_agent_acceptance`] for what happens when it is not.
fn start_session(directory: TempDir, worktree: PathBuf) -> godot_editor_harness::Session {
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
    // Which of the three drivers answers this run. `openai-compatible` is the default because a
    // local server is what a run with nothing named wants; the other two reach a hosted endpoint
    // and need the credential their own environment variable carries.
    let driver = match std::env::var("GOFER_LIVE_CONNECTION").as_deref() {
        Ok("openai-codex") => crate::settings::AiConnectionType::OpenaiCodex,
        Ok("openrouter") => crate::settings::AiConnectionType::Openrouter,
        Ok("openai-compatible") | Err(_) => crate::settings::AiConnectionType::OpenaiCompatible,
        Ok(other) => panic!(
            "GOFER_LIVE_CONNECTION names {other}, which is not openai-compatible, openai-codex or \
             openrouter"
        ),
    };
    // Only the local driver gets an address filled in from nothing. ChatGPT's and OpenRouter's are
    // constants in the shipped connection, and a run that overwrote either with this default would
    // ask `127.0.0.1` for a hosted model.
    let base_url = std::env::var("GOFER_LIVE_BASE_URL").ok().or_else(|| {
        (driver == crate::settings::AiConnectionType::OpenaiCompatible)
            .then(|| "http://127.0.0.1:8080/v1".to_owned())
    });
    let model = std::env::var("GOFER_LIVE_MODEL").unwrap_or_else(|_| "local".to_owned());
    // Named rather than inherited, because how hard a model is asked to think decides what a run
    // costs and how long it takes — so two runs being comparable depends on it being written down.
    let thinking_level = std::env::var("GOFER_LIVE_THINKING")
        .ok()
        .filter(|l| !l.is_empty());

    // The project database is opened before the editor, and this order is the whole run.
    //
    // Opening a project creates its first task, and creating a task moves the checkout onto that
    // task's branch — cut from the base, so whatever was loose in the working tree is committed to
    // the base branch and left there. `ProjectStorage::open` is allowed to do that because in the
    // application it runs before any editor exists, so there is nothing staged to lose.
    //
    // Started the other way round, the addon is staged first and that switch throws it away:
    // `GoferRuntime` goes into a commit on `master` and the task branch begins without it. The
    // editor keeps running with the plugin it loaded, so nothing looks wrong — until a game is
    // launched, boots with no runtime helper, and every `godot_runtime` call waits for a helper
    // that can never announce. A live turn spent seventeen calls in that loop: `run` answering
    // `runtime_slow_start`, `get_state` answering `running: true, runtimeReady: false`, `wait`
    // answering `runtime_not_running`, over and over, about a game that was on screen the whole
    // time.
    let directory = TempDir::new().expect("temporary directory");
    let worktree = live_worktree(&directory);
    let app = mock_app();
    let data = TempDir::new().expect("temporary application data");
    let storage =
        crate::storage::ProjectStorage::open(data.path(), &worktree).expect("open project storage");
    app.manage(crate::storage::StorageSlot::new(Ok(storage)));

    let session = start_session(directory, worktree);
    // The rules a real session applies when it goes ready. Without them the strict-typing policy
    // Gofer ships turned on is simply absent, and a run measures a project nobody has.
    for call in crate::godot_policy::policy_calls(&crate::settings::GodotSettings::default()) {
        let answered = session.try_call(call.command, call.params.clone(), None);
        println!("policy {} -> {answered:?}", call.command);
    }

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

    // Every event twice: held for the report, and appended to a sibling `.jsonl` as it arrives.
    //
    // The report is written when the turn returns, and a turn that does not return writes nothing.
    // One run spent twenty-four minutes on a debugging task, was killed on its budget, and left an
    // empty directory — a whole turn of the evidence this file exists to collect, gone because the
    // only write was at the end. Appending is O(1) per event, so the running cost is a line.
    let trace = out.with_extension("jsonl");
    let _ = std::fs::remove_file(&trace);
    let events: Arc<Mutex<Vec<serde_json::Value>>> = Arc::new(Mutex::new(Vec::new()));
    let recorded = Arc::clone(&events);
    let stream = tauri::ipc::Channel::new(move |payload| {
        if let Ok(value) = payload.deserialize::<serde_json::Value>() {
            if let Ok(mut file) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&trace)
                && let Ok(line) = serde_json::to_string(&value)
            {
                use std::io::Write;
                let _ = writeln!(file, "{line}");
            }
            if let Ok(mut held) = recorded.lock() {
                held.push(value);
            }
        }
        Ok(())
    });
    let turn = crate::ai_turn::AiTurn::begin(1, stream).expect("no other AI turn is running");

    let finished = Arc::new(std::sync::atomic::AtomicBool::new(false));
    answer_the_prompts_nobody_is_watching(Arc::clone(&finished));

    // The context the application builds, from the same function — so what this run measures is
    // the turn Gofer composes, not one this file assembled to look like it. The run still chooses
    // where the model is, that none of this machine's credentials are sent, and which checkout the
    // editor it started is bound to.
    let context = JobContext::for_suite(
        app.handle(),
        AiSettings::served_by(driver, base_url, model, thinking_level),
        session.worktree.display().to_string(),
    )
    .expect("build the job context");
    let started = std::time::Instant::now();
    let completion = crate::ai_turn::run_ai_worker_with(
        app.handle(),
        &turn,
        context.request(Job::Turn {
            task_id: Some("godot-live-agent".to_owned()),
            messages: vec![AiWorkerMessage {
                sender: ChatSender::User,
                text: task.clone(),
                timestamp: 1,
                images: Vec::new(),
            }],
            agent_messages: None,
            is_retry: false,
            memory_context: None,
        }),
        &SystemProcessSpawner,
    );
    let seconds = started.elapsed().as_secs_f64();
    finished.store(true, std::sync::atomic::Ordering::Relaxed);

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

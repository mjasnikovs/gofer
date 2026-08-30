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
//! `GOFER_LIVE_BASE_URL` / `GOFER_LIVE_MODEL` naming the endpoint, `GOFER_LIVE_IMAGES=off`
//! saying the model cannot see, and `GOFER_LIVE_FIXTURE`
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

/// Answers the prompts a turn raises, because nothing else here can.
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
///
/// **A question is the other half, and it used to cost half an hour.** `ask_user` waits on
/// `QUESTION_TIMEOUT`, which is thirty minutes, and this loop answered only approvals — so a turn
/// that asked anything stopped dead until that ran out and then carried on with nothing. Measured:
/// `sol-12-refactor` asked "should you provide the intended player project, or should I add a new
/// player implementation here?" at its sixth call, against a fixture that has no player script, and
/// the run had thirty minutes of nothing left in it.
///
/// A skip rather than an answer, because a skip is what this run actually means: the question was
/// read and the decision is left to the implementer. Inventing prose would put words in a user's
/// mouth and make the turn a measurement of this file's opinions. See `respond_question` — a reply
/// with nothing in it is a skip either way, and saying so is clearer than relying on that.
fn answer_the_prompts_nobody_is_watching(finished: Arc<std::sync::atomic::AtomicBool>) {
    let allow = std::env::var("GOFER_LIVE_APPROVE").as_deref() != Ok("refuse");
    std::thread::spawn(move || {
        while !finished.load(std::sync::atomic::Ordering::Relaxed) {
            for asked in crate::approvals::pending_approvals() {
                let _ = crate::approvals::respond(&asked, allow);
                println!("live approval {asked} -> {allow}");
            }
            for asked in crate::ask::pending_questions() {
                let skipped = crate::ask::QuestionResponse {
                    question_id: asked.clone(),
                    answer: None,
                    picked: None,
                    blocked: Vec::new(),
                    skipped: true,
                    approved: false,
                    again: false,
                };
                let _ = crate::ask::respond_question(skipped);
                println!("live question {asked} -> skipped");
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
    let _ = std::fs::remove_dir_all(worktree.join(".git"));
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

/// A fixture that is already a repository starts the turn on one commit of its own.
///
/// A kept worktree used as the next run's fixture brings its `.git` with it, and `git init` on a
/// directory that has one keeps the branch and the history. The turn then opens on a branch named
/// after somebody else's task, which is what `loc-41-modify` reported back as the reason it could
/// not find a file that was sitting in front of it.
#[test]
fn a_fixture_that_carries_its_own_history_starts_the_turn_without_it() {
    let directory = TempDir::new().expect("temporary directory");
    let worktree = directory.path().join("worktree");
    std::fs::create_dir_all(&worktree).expect("the worktree");
    std::fs::write(worktree.join("kept.txt"), "from the run before\n").expect("a file");
    let git = |arguments: &[&str]| {
        std::process::Command::new("git")
            .args(arguments)
            .current_dir(&worktree)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .expect("git runs");
    };
    git(&["init", "--quiet"]);
    git(&["config", "user.email", "before@gofer.test"]);
    git(&["config", "user.name", "The run before"]);
    git(&["checkout", "--quiet", "-b", "gofer/task-01a0461b2099"]);
    git(&["add", "-A"]);
    git(&["commit", "--quiet", "-m", "what the run before did"]);

    make_it_a_repository(&worktree);

    let read = |arguments: &[&str]| -> String {
        let output = std::process::Command::new("git")
            .args(arguments)
            .current_dir(&worktree)
            .output()
            .expect("git runs");
        String::from_utf8_lossy(&output.stdout).trim().to_owned()
    };
    assert_eq!(
        read(&["log", "--oneline"]),
        {
            let one = read(&["log", "--oneline", "-1"]);
            one
        },
        "one commit, not the run before's as well"
    );
    assert!(
        read(&["log", "-1", "--format=%s"]).contains("as the turn found it"),
        "and it is this turn's own"
    );
    assert!(
        !read(&["branch", "--show-current"]).starts_with("gofer/task-"),
        "on a branch of its own rather than somebody else's task"
    );
    assert!(
        worktree.join("kept.txt").exists(),
        "the files are the fixture"
    );
}

#[test]
fn live_agent_acceptance() {
    let Ok(task) = std::env::var("GOFER_LIVE_TASK") else {
        return;
    };
    let out = PathBuf::from(
        std::env::var("GOFER_LIVE_OUT").expect("GOFER_LIVE_OUT names where the events go"),
    );
    let driver = match std::env::var("GOFER_LIVE_CONNECTION").as_deref() {
        Ok("openai-codex") => crate::settings::AiConnectionType::OpenaiCodex,
        Ok("openrouter") => crate::settings::AiConnectionType::Openrouter,
        Ok("cerebras") => crate::settings::AiConnectionType::Cerebras,
        Ok("openai-compatible") | Err(_) => crate::settings::AiConnectionType::OpenaiCompatible,
        Ok(other) => panic!(
            "GOFER_LIVE_CONNECTION names {other}, which is not openai-compatible, openai-codex, \
             openrouter or cerebras"
        ),
    };
    let base_url = std::env::var("GOFER_LIVE_BASE_URL").ok().or_else(|| {
        (driver == crate::settings::AiConnectionType::OpenaiCompatible)
            .then(|| "http://127.0.0.1:8080/v1".to_owned())
    });
    let model = std::env::var("GOFER_LIVE_MODEL").unwrap_or_else(|_| "local".to_owned());
    let thinking_level = std::env::var("GOFER_LIVE_THINKING")
        .ok()
        .filter(|l| !l.is_empty());
    let sees = std::env::var("GOFER_LIVE_IMAGES").as_deref() != Ok("off");

    let directory = TempDir::new().expect("temporary directory");
    let worktree = live_worktree(&directory);
    let app = mock_app();
    let data = TempDir::new().expect("temporary application data");
    let storage =
        crate::storage::ProjectStorage::open(data.path(), &worktree).expect("open project storage");
    app.manage(crate::storage::StorageSlot::new(Ok(storage)));

    let session = start_session(directory, worktree);
    for call in crate::godot_policy::policy_calls(&crate::settings::GodotSettings::default()) {
        let answered = session.try_call(call.command, call.params.clone(), None);
        println!("policy {} -> {answered:?}", call.command);
    }

    // SAFETY: the acceptance runner gives each test its own process.
    unsafe {
        std::env::set_var(
            "GOFER_RAG_CACHE_DIR",
            std::env::var("HOME")
                .map(|home| format!("{home}/.cache/gofer-rag"))
                .expect("HOME"),
        );
    }

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

    let context = JobContext::for_suite(
        app.handle(),
        if sees {
            AiSettings::served_by(driver, base_url, model, thinking_level)
        } else {
            AiSettings::served_by(driver, base_url, model, thinking_level).without_pictures()
        },
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
    if let Ok(keep) = std::env::var("GOFER_LIVE_KEEP") {
        keep_the_worktree(&session.worktree, &PathBuf::from(&keep));
    }
    let _ = session.try_call("runtime.stop", serde_json::json!({}), None);
    println!("live agent finished in {seconds:.1}s -> {}", out.display());
}

/// Copies the finished worktree out, into a directory that holds this run and nothing else.
///
/// `copy_tree` overwrites the files it finds and deletes none, which is right for its own callers:
/// they copy a fixture into a fresh temporary directory. `GOFER_LIVE_KEEP` names a path the caller
/// chose, and a caller reuses one — the same run, retried after a failure, is the everyday case.
///
/// What that cost, once, was half an hour of chasing a defect that did not exist. A turn died at
/// one second on a provider 404 and still copied its untouched worktree out; the retry was pointed
/// at the same directory and merged into it. The result had one run's script beside the other
/// run's `project.godot` and `.git`, so it read as an agent whose verified edit was missing from
/// disk — the worst thing a coding tool can do — with a git status to match. The mtimes were what
/// gave it away: 17:12:27 on the script, 17:43:48 on everything around it.
///
/// So a kept worktree is either this run's or it is not evidence, and the destination is emptied
/// first. Only its contents: the directory itself may be one the caller made, and removing it
/// would break a path they had already handed to something else.
fn keep_the_worktree(worktree: &std::path::Path, keep: &std::path::Path) {
    let ours = keep.join("project.godot").exists();
    if !ours && keep.read_dir().is_ok_and(|mut held| held.next().is_some()) {
        println!(
            "GOFER_LIVE_KEEP names {}, which holds something other than a kept worktree — copying \
             into it rather than emptying it. Name a directory of its own to keep this run alone.",
            keep.display()
        );
    }
    if let Ok(entries) = std::fs::read_dir(keep)
        && ours
    {
        for entry in entries.flatten() {
            let path = entry.path();
            let kind = entry.path().symlink_metadata().map(|held| held.is_dir());
            let removed = if kind.unwrap_or(false) {
                std::fs::remove_dir_all(&path)
            } else {
                std::fs::remove_file(&path)
            };
            if let Err(error) = removed {
                println!(
                    "GOFER_LIVE_KEEP could not clear {}: {error}",
                    path.display()
                );
            }
        }
    }
    let _ = std::fs::create_dir_all(keep);
    godot_editor_harness::copy_tree(worktree, keep);
}

/// A kept worktree holds one acceptance run, and never two of them merged.
///
/// The failure this pins produced half an hour of chasing a data-loss defect that did not exist.
/// A turn died at one second on a provider 404 and copied its untouched worktree out anyway; the
/// retry was pointed at the same `GOFER_LIVE_KEEP` directory, and `copy_tree` overwrites without
/// deleting. The kept tree then held the dead run's script beside the live run's `project.godot`
/// and `.git`, which reads exactly like an agent whose verified edit never reached disk.
/// A question nobody is watching is skipped, rather than waited out for half an hour.
///
/// The failure this pins cost a live run its whole budget. `sol-12-refactor` asked "should you
/// provide the intended player project, or should I add a new player implementation here?" at its
/// sixth call, against a fixture that has no player script — and this loop answered approvals only,
/// so the turn stopped there with `QUESTION_TIMEOUT`'s thirty minutes ahead of it.
///
/// The wait is bounded here rather than joined, because the regression is a question that is never
/// answered: joined, this test would reproduce the defect by hanging for half an hour instead of
/// failing.
#[test]
fn a_question_nobody_is_watching_is_skipped_rather_than_waited_out() {
    let _gate = crate::approvals::serialize_gate_tests();
    let app = mock_app();
    crate::ask::open_user_prompts();
    let finished = Arc::new(std::sync::atomic::AtomicBool::new(false));
    answer_the_prompts_nobody_is_watching(Arc::clone(&finished));

    let handle = app.handle().clone();
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let answered = crate::ask::ask_question(
            &handle,
            "question-nobody-is-watching",
            "Which of these did you mean?",
            Vec::new(),
            Vec::new(),
            "there is nobody to ask",
            None,
            false,
        );
        let _ = sender.send(answered);
    });

    let answered = receiver
        .recv_timeout(std::time::Duration::from_secs(20))
        .expect("a question nobody is watching is answered by the run itself");
    finished.store(true, std::sync::atomic::Ordering::Relaxed);
    crate::ask::cancel_user_prompts();

    match answered {
        crate::ask::Answer::Answered(reply) => assert!(reply.skipped, "{reply:?}"),
        other => panic!("the run must answer its own question, and it answered {other:?}"),
    }
}

/// A kept worktree holds one acceptance run and not two.
///
/// Its own paragraph again: the comment about `GOFER_LIVE_KEEP` and `copy_tree` was left heading
/// `a_question_nobody_is_watching_is_skipped_rather_than_waited_out`, which was written in above it.
#[test]
fn a_kept_worktree_holds_one_acceptance_run_and_not_two() {
    let source = TempDir::new().expect("a worktree to keep");
    std::fs::create_dir_all(source.path().join("scripts")).expect("scripts directory");
    std::fs::write(
        source.path().join("scripts/player.gd"),
        "the run that finished",
    )
    .expect("write the script");
    std::fs::write(source.path().join("project.godot"), "config_version=5\n")
        .expect("write the project");

    let keep = TempDir::new().expect("a destination");
    std::fs::write(keep.path().join("project.godot"), "the run that died").expect("stale project");
    std::fs::create_dir_all(keep.path().join("scripts")).expect("stale scripts directory");
    std::fs::write(keep.path().join("scripts/player.gd"), "the run that died")
        .expect("stale script");
    std::fs::write(keep.path().join("stale.txt"), "from the run before").expect("stale file");
    std::fs::create_dir_all(keep.path().join(".git")).expect("stale git directory");
    std::fs::write(keep.path().join(".git/HEAD"), "the other run's branch").expect("stale head");

    keep_the_worktree(source.path(), keep.path());

    assert_eq!(
        std::fs::read_to_string(keep.path().join("scripts/player.gd")).expect("the kept script"),
        "the run that finished",
        "the file both runs wrote must be this run's"
    );
    assert!(
        !keep.path().join("stale.txt").exists(),
        "a file only the dead run wrote must not survive into this run's evidence"
    );
    assert!(
        !keep.path().join(".git").exists(),
        "the dead run's repository must not sit beside this run's files"
    );
    assert!(
        keep.path().join("project.godot").exists(),
        "everything this run built must still be copied out"
    );
}

/// A destination that is not a kept worktree is copied into, never emptied.
///
/// `GOFER_LIVE_KEEP` names a path the caller typed, and one level off — `logs/oxloop` rather than
/// `logs/oxloop/<run>-worktree` — is every recorded batch in the corpus. Emptying that would erase
/// the evidence this whole loop is built on, to fix a merge.
#[test]
fn a_destination_that_is_not_a_worktree_acceptance_run_is_left_alone() {
    let source = TempDir::new().expect("a worktree to keep");
    std::fs::write(source.path().join("project.godot"), "config_version=5\n")
        .expect("write the project");

    let keep = TempDir::new().expect("a destination");
    std::fs::write(keep.path().join("batch12.log"), "somebody else's run")
        .expect("a file that is not a worktree's");

    keep_the_worktree(source.path(), keep.path());

    assert!(
        keep.path().join("batch12.log").exists(),
        "a directory holding something other than a worktree must not be emptied"
    );
    assert!(
        keep.path().join("project.godot").exists(),
        "and the run is still copied into it"
    );
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

//! The final acceptance journey: one task worktree taken through every capability the integration
//! promises, and then handed to a second task.
//!
//! Every other acceptance module proves one boundary and reaches its editor through a test seam —
//! the supervisor launches a windowed editor, so those suites launch their own and bind the
//! transport. This one removes the last stand-ins between Gofer and the engine. It builds a real
//! Git workspace, opens real project storage, creates a real task, and starts the session through
//! the supervisor itself, so the addon staging, the RPC listener, the language server, the debug
//! adapter, and the log archive are all the ones a user gets. Every operation then goes through
//! [`crate::ai_tools::dispatch`] — the same router the AI turn uses and the same handlers the
//! renderer's commands call — so the journey exercises the safety model on the way to the editor
//! rather than stepping around it.
//!
//! The nine steps of the plan are the nine sections of the test: connect to a task worktree;
//! inspect, mutate, undo, redo, and save a scene; author a script, fix its diagnostics, format it,
//! rename a symbol, and navigate references; break, run, inspect, evaluate, step, and continue;
//! inspect the runtime tree, inject input, and capture the changed screen; edit project settings
//! and approve one machine-wide editor setting; retrieve documentation; switch tasks with a
//! complete cleanup and rebinding; and delete a task out from under the editor running in it.
//!
//! Two things cannot be carried into a test and are stood in for deliberately, each at the outer
//! edge of the system: the user who answers an approval prompt, and the embedding index behind
//! documentation retrieval. Everything between those edges and the engine is real.
//!
//! Gated behind the `godot-acceptance` feature so the fast gate needs no engine.

use crate::ai_tools::{self, ToolFailure, ToolRequest};
use crate::approvals;
use crate::godot_editor_harness::copy_tree;
use crate::godot_lsp_acceptance::{MATH_UTILS, SCORE_KEEPER, position_of};
use crate::godot_session::{self, LogQuery};
use crate::storage::ProjectStorage;
use serde_json::{Value, json};
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::thread;
use std::time::{Duration, Instant};
use tauri::Manager;
use tempfile::TempDir;

/// The editor imports the project, enables the addon, and only then connects, so the first probes
/// are expected to fail.
const READY_TIMEOUT: Duration = Duration::from_secs(120);
/// How long a ready session gets to have the Godot rules applied to it. Measured in the low
/// hundreds of milliseconds; generous enough for a loaded machine, short enough that a watch which
/// never ran is reported rather than waited out.
const POLICY_TIMEOUT: Duration = Duration::from_secs(20);
const CALL_TIMEOUT_MS: u64 = 30_000;
/// A launch is answered only once the game booted, its helper announced itself, and the first
/// frame was captured.
const LAUNCH_TIMEOUT_MS: u64 = 60_000;
const STOP_TIMEOUT_MS: u64 = 60_000;

const SCENE_PATH: &str = "res://main.tscn";
const SCENE_FILE: &str = "main.tscn";
const SCENE_ROOT: &str = "/JourneyProbe";
const MARKER_NAME: &str = "JourneyMarker";
const PROBE_PATH: &str = "scripts/journey_probe.gd";
const BROKEN_PATH: &str = "scripts/broken.gd";
const MATH_PATH: &str = "scripts/math_utils.gd";
const KEEPER_PATH: &str = "scripts/score_keeper.gd";

/// The device id this journey stamps on the input it injects, and the only device the probe
/// counts. The game window is real and focusable, so without this the developer's own keyboard
/// would be counted alongside the injected key. See `godot_runtime_acceptance::INJECTED_DEVICE`.
const INJECTED_DEVICE: i64 = 7777;

/// The probe is the fixture game and the debugged script at once: `_tick` gives the breakpoint a
/// two-frame stack with a local worth reading, and the input counter gives the screenshot and the
/// remote tree a visible consequence of an injected event.
///
/// `INJECTED_DEVICE` is declared below `_tick` on purpose: `BREAK_LINE` points into this source,
/// so nothing may be inserted above the line it names.
///
/// It is also written the way Gofer's own strict-typing rule demands, and that is not a style
/// choice. This journey starts the session the supervisor way, which applies those rules to the
/// editor — so `event.pressed` after an `is` check, which reads a property off the inferred
/// `InputEvent`, is `unsafe_property_access` and the editor refuses to parse the file. It went
/// unnoticed while the rules were only applied on an edge nothing reliably reached: the fixture was
/// written in a style the product forbids, and the suite proving the product could not see it.
const PROBE_SCRIPT: &str = "extends Node2D\n\nvar presses := 0\nvar counter := 0\nvar last_source := \"none\"\n\n@onready var label: Label = $Label\n\nfunc _ready() -> void:\n\t_refresh()\n\nfunc _process(_delta: float) -> void:\n\t_tick(1)\n\nfunc _tick(amount: int) -> void:\n\tcounter += amount\n\nconst INJECTED_DEVICE := 7777\n\nfunc _input(event: InputEvent) -> void:\n\tif event.device != INJECTED_DEVICE:\n\t\treturn\n\tvar key := event as InputEventKey\n\tif key != null and key.pressed and not key.echo:\n\t\t_record(\"key\")\n\nfunc _record(source: String) -> void:\n\tpresses += 1\n\tlast_source = source\n\t_refresh()\n\nfunc _refresh() -> void:\n\tlabel.text = \"presses: %d (%s)\" % [presses, last_source]\n";
/// 1-based, matching the editor UI and Monaco's gutter: `counter += amount` inside `_tick`.
const BREAK_LINE: i64 = 16;
const PROBE_SCENE: &str = "[gd_scene load_steps=2 format=3]\n\n[ext_resource type=\"Script\" path=\"res://scripts/journey_probe.gd\" id=\"1_probe\"]\n\n[node name=\"JourneyProbe\" type=\"Node2D\"]\nscript = ExtResource(\"1_probe\")\n\n[node name=\"Label\" type=\"Label\" parent=\".\"]\noffset_right = 320.0\noffset_bottom = 40.0\n";

/// The same unclosed parameter list the language-server acceptance uses: a parse error the real
/// server is already known to report.
const BROKEN_SCRIPT: &str = "extends Node\n\nfunc explode( -> void:\n\tpass\n";
const FIXED_SCRIPT: &str = "extends Node\n\nfunc explode() -> void:\n\tpass\n";
/// Valid GDScript that gdformat has something to say about, so `changed` means the sidecar ran.
const UNFORMATTED: &str = "extends Node\n\nfunc value() -> int:\n\treturn 1+2\n";

/// Base64 always opens with these characters when the payload is the eight-byte PNG signature.
const PNG_BASE64_PREFIX: &str = "iVBORw0KGgo";

/// Sets a process environment variable for as long as the journey runs and puts back whatever was
/// there before. The suite runs single-threaded, so the process environment is the journey's while
/// it executes — but it is not the journey's afterwards, and the tests that follow read some of
/// these same names.
struct EnvGuard {
    key: &'static str,
    previous: Option<OsString>,
}

impl EnvGuard {
    fn set(key: &'static str, value: impl AsRef<OsStr>) -> Self {
        let previous = std::env::var_os(key);
        // SAFETY: acceptance tests run single-threaded and own the process environment.
        unsafe { std::env::set_var(key, value) };
        Self { key, previous }
    }
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        // SAFETY: acceptance tests run single-threaded and own the process environment.
        unsafe {
            match self.previous.take() {
                Some(value) => std::env::set_var(self.key, value),
                None => std::env::remove_var(self.key),
            }
        }
    }
}

/// Git inherits the environment of whatever ran the suite — a Git hook exports `GIT_DIR` and
/// `GIT_INDEX_FILE` — so the journey's checkout is addressed the same scrubbed way `git.rs`
/// addresses the real ones. Without it, `add` under a pre-commit hook writes these fixture files
/// into Gofer's own index while their objects stay in the temporary repository, and the commit
/// that started the hook then fails on an object it cannot find.
fn git(workspace: &Path, arguments: &[&str]) {
    let output = Command::new("git")
        .arg("-C")
        .arg(workspace)
        .args(arguments)
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE")
        .env_remove("GIT_OBJECT_DIRECTORY")
        .env_remove("GIT_ALTERNATE_OBJECT_DIRECTORIES")
        .env_remove("GIT_COMMON_DIR")
        .env_remove("GIT_PREFIX")
        .output()
        .unwrap_or_else(|error| panic!("git {arguments:?} could not run: {error}"));
    assert!(
        output.status.success(),
        "git {arguments:?} failed: {}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

/// What Git answers, for the questions whose answer is the assertion rather than the exit status.
fn git_text(workspace: &Path, arguments: &[&str]) -> String {
    let output = Command::new("git")
        .arg("-C")
        .arg(workspace)
        .args(arguments)
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE")
        .env_remove("GIT_OBJECT_DIRECTORY")
        .env_remove("GIT_ALTERNATE_OBJECT_DIRECTORIES")
        .env_remove("GIT_COMMON_DIR")
        .env_remove("GIT_PREFIX")
        .output()
        .unwrap_or_else(|error| panic!("git {arguments:?} could not run: {error}"));
    assert!(
        output.status.success(),
        "git {arguments:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_owned()
}

fn write(root: &Path, path: &str, contents: &str) {
    let target = root.join(path);
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).expect("create parent directory");
    }
    std::fs::write(&target, contents)
        .unwrap_or_else(|error| panic!("write {}: {error}", target.display()));
}

fn read(root: &Path, path: &str) -> String {
    std::fs::read_to_string(root.join(path))
        .unwrap_or_else(|error| panic!("read {}/{path}: {error}", root.display()))
}

/// Builds the user's own checkout: the fixture project plus the scripts this journey navigates,
/// committed, so every task worktree Gofer creates starts from the same tree.
fn committed_workspace(root: &Path) -> PathBuf {
    let workspace = root.join("workspace");
    let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("fixtures")
        .join("godot-project");
    copy_tree(&fixture, &workspace);
    write(&workspace, PROBE_PATH, PROBE_SCRIPT);
    write(&workspace, BROKEN_PATH, BROKEN_SCRIPT);
    write(&workspace, MATH_PATH, MATH_UTILS);
    write(&workspace, KEEPER_PATH, SCORE_KEEPER);
    write(&workspace, SCENE_FILE, PROBE_SCENE);

    git(&workspace, &["init", "--quiet", "--initial-branch", "main"]);
    git(&workspace, &["config", "user.email", "journey@gofer.test"]);
    git(&workspace, &["config", "user.name", "Gofer journey"]);
    // Git for Windows installs `core.autocrlf=true`, which would check every task worktree out
    // with CRLF and leave this journey asserting Git's line-ending policy instead of Gofer's own
    // round trip. The fixture repository hands back the bytes it was given, on every platform.
    git(&workspace, &["config", "core.autocrlf", "false"]);
    git(&workspace, &["config", "core.eol", "lf"]);
    git(&workspace, &["add", "--all"]);
    git(&workspace, &["commit", "--quiet", "--message", "Fixture"]);
    crate::paths::canonical(&workspace).expect("canonical workspace")
}

/// One journey: a Git workspace, project storage, a mock desktop application, and whichever task
/// session is currently running.
struct Journey {
    app: tauri::App<tauri::test::MockRuntime>,
    storage: ProjectStorage,
    workspace: PathBuf,
    directory: TempDir,
    _environment: Vec<EnvGuard>,
    /// The worker this journey stands in for, and the turn it runs inside.
    ///
    /// Declared in this order because fields drop in declaration order: the gate pair closes
    /// before the turn that admitted it releases the provider operation, which is the order
    /// [`crate::ai_turn`] runs a real worker in.
    _run: crate::ai_turn::WorkerRun,
    _turn: crate::ai_turn::AiTurn,
}

impl Drop for Journey {
    fn drop(&mut self) {
        // Ahead of stopping the session, for the reason `run_ai_worker_with` closes it ahead of
        // joining its tool threads: a gated call still waiting on a user it will never get holds
        // the thread that is about to be asked to shut the editor down. `_run`'s own `Drop` closes
        // it again once this body has finished — this is the one place the order matters.
        crate::ask::cancel_user_prompts();
        let _ = ai_tools::dispatch(
            self.app.handle(),
            ToolRequest {
                tool: "godot_session".to_owned(),
                params: json!({"ops": [{"op": "stop"}]}),
            },
        );
    }
}

impl Journey {
    fn start() -> Self {
        // Every other acceptance module binds an editor it launched itself. This one drives the
        // supervised session, so any binding still standing — including one a module that panicked
        // never took down — is dropped before anything runs.
        godot_session::bind(None);

        let directory = TempDir::new().expect("temporary directory");
        let root = directory.path().to_path_buf();
        let workspace = committed_workspace(&root);

        let environment = vec![
            // The supervisor launches the editor the user would see. A gate has no display, and
            // the journey's whole point is that it is the supervisor's own launch.
            EnvGuard::set("GOFER_GODOT_HEADLESS", "1"),
            // The cleanup ledger lives in application data. Redirected, so a journey can never
            // stage into — or unstage out of — the developer's own Gofer installation.
            EnvGuard::set("XDG_DATA_HOME", root.join("app-data")),
            EnvGuard::set("APPDATA", root.join("app-data")),
            // The editor the supervisor launches inherits this process's environment, and going
            // ready now applies the Godot rules — one of which, `game_embed_mode`, is a
            // machine-wide EditorSetting. Without this, a journey would quietly rewrite the
            // editor configuration the developer running the suite uses for their own work. The
            // other acceptance modules get this from the harness, which launches the editor
            // itself; this one drives the real supervisor, so it sets them here.
            EnvGuard::set("XDG_CONFIG_HOME", root.join("editor-config")),
            EnvGuard::set("XDG_CACHE_HOME", root.join("editor-cache")),
        ];

        let storage = ProjectStorage::open(&root.join("data"), &workspace).expect("open storage");
        let app = tauri::test::mock_builder()
            .build(crate::app_context())
            .expect("build mock Tauri app");
        // Approvals are shown in the main window, and a backend without one refuses rather than
        // deciding for the user.
        tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("build mock webview");
        app.manage(crate::storage::StorageSlot::new(Ok(storage.clone())));
        // A turn is running: gated tool calls only ever wait for a user inside one. The real
        // guard, rather than the approval half of it copied out by hand — which left every
        // `ask_user` a journey made refused by a gate nothing here had opened.
        //
        // Nothing reads the stream. A journey drives `ai_tools::dispatch` directly rather than
        // spawning a worker, so there are no agent events to carry; the turn is what owns the
        // channel, so one has to exist.
        let turn = crate::ai_turn::AiTurn::begin(1, tauri::ipc::Channel::new(|_| Ok(())))
            .expect("no other AI turn is running");
        let run = crate::ai_turn::WorkerRun::enter(&turn);

        Self {
            app,
            storage,
            workspace,
            directory,
            _environment: environment,
            _run: run,
            _turn: turn,
        }
    }

    /// Creates a task and opens it, which is what moves the one checkout onto its branch.
    ///
    /// The real Switch is used rather than a stub: stopping the editor before the checkout moves is
    /// the behaviour under test, not a detail the harness may skip. It goes through `leave_task`
    /// itself rather than re-spelling it — a harness that stopped the editor but kept the read
    /// ledger would be driving something the app never does.
    fn new_task(&self) -> PathBuf {
        let release = |workspace: &Path| crate::leave_task(self.app.handle(), workspace);
        self.storage
            .tasks()
            .create(&self.storage.switch_with_no_turn_to_refuse(&release))
            .expect("create task");
        let workspace = self
            .storage
            .tasks()
            .active_workspace()
            .expect("the new task must have a branch");
        // The session spells its directory the way `paths::canonical` does, which on Windows is
        // the plain path and not the verbatim one `fs::canonicalize` returns.
        crate::paths::canonical(&workspace).expect("canonical workspace")
    }

    /// The branch the checkout is on, which is the task the window would be showing.
    fn current_branch(&self) -> String {
        crate::git::current_branch(&self.workspace).expect("a branch is checked out")
    }

    fn try_call(&self, tool: &str, params: Value) -> Result<Value, ToolFailure> {
        ai_tools::dispatch(
            self.app.handle(),
            ToolRequest {
                tool: tool.to_owned(),
                params,
            },
        )
    }

    /// One operation, as a call of one: every call is an `ops` list, and the parameters sit flat
    /// beside the `op`.
    fn one(op: &str, params: Value) -> Value {
        let mut entry = params;
        if !entry.is_object() {
            entry = json!({});
        }
        entry["op"] = json!(op);
        json!({"ops": [entry]})
    }

    /// The answer of that one operation, unwrapped out of the list — the journey below reads what
    /// the handler said, not the list carrying it.
    fn call(&self, tool: &str, op: &str, params: Value) -> Value {
        self.try_call(tool, Self::one(op, params))
            .map(|answer| answer["ops"][0]["result"].clone())
            .unwrap_or_else(|failure| {
                panic!(
                    "{tool}.{op} failed: {} {}\n--- session output ---\n{}",
                    failure.code,
                    failure.message,
                    session_output()
                )
            })
    }

    fn error(&self, tool: &str, op: &str, params: Value) -> ToolFailure {
        self.try_call(tool, Self::one(op, params))
            .err()
            .unwrap_or_else(|| panic!("{tool}.{op} was expected to fail"))
    }

    /// Starts the session the supervisor way. The call itself is the wait.
    ///
    /// This used to start the editor and then poll `session.get_state` for up to two minutes,
    /// because `godot_session start` answered as soon as the process was spawned — across every
    /// recorded run it reported `ready` twice, `starting` thirteen times and `error` once, all as
    /// successes. A live turn met that and spent six calls on it, ending with the agent writing a
    /// thirty-iteration `curl` loop against Gofer's own RPC port to find out when the editor it
    /// had been told was started could answer.
    ///
    /// The wait belongs in the call, so the assertion here is what a caller is now entitled to:
    /// `start` answers with a session that can take the next request.
    fn start_session(&self) -> Value {
        let started = self.call("godot_session", "start", json!({}))["session"].clone();
        assert_eq!(
            started["state"],
            "ready",
            "godot_session start has to answer with an editor that can take a call, not with one \
             that is still coming up: {started}\n--- session output ---\n{}",
            session_output()
        );
        started
    }

    /// Opens a script through the language server, retrying while the editor is still importing:
    /// the script commands connect lazily, so the first call is also what proves the server is up.
    fn open_script(&self, path: &str) -> Value {
        let deadline = Instant::now() + READY_TIMEOUT;
        let mut last = "no attempt".to_owned();
        while Instant::now() < deadline {
            match self
                .try_call("godot_script", Self::one("open", json!({"path": path})))
                .map(|answer| answer["ops"][0]["result"].clone())
            {
                Ok(document) => return document,
                Err(failure) => last = format!("{}: {}", failure.code, failure.message),
            }
            thread::sleep(Duration::from_millis(500));
        }
        panic!(
            "the language server never accepted {path}: {last}\n--- session output ---\n{}",
            session_output()
        );
    }
}

/// The session's own captured output, quoted whenever an assertion fails: the editor's stdout and
/// stderr are drained into this buffer by the supervisor, so it holds what the engine said.
fn session_output() -> String {
    godot_session::read_logs(&LogQuery {
        limit: Some(200),
        ..LogQuery::default()
    })
    .map(|page| {
        page.entries
            .iter()
            .map(|entry| entry.message.clone())
            .collect::<Vec<_>>()
            .join("")
    })
    .unwrap_or_default()
}

fn child_names(tree: &Value) -> Vec<String> {
    tree["root"]["children"]
        .as_array()
        .unwrap_or_else(|| panic!("a scene tree must carry children: {tree}"))
        .iter()
        .map(|child| child["name"].as_str().expect("child name").to_owned())
        .collect()
}

fn assert_frame(frame: &Value) {
    assert_eq!(frame["encoding"], "png-base64", "frame encoding in {frame}");
    let width = frame["width"].as_u64().expect("frame width");
    let height = frame["height"].as_u64().expect("frame height");
    assert!(
        width > 0 && height > 0,
        "the frame must have pixels: {frame}"
    );
    assert!(
        width.max(height) <= 1920,
        "the longest edge must respect the protocol cap: {width}x{height}"
    );
    assert!(
        frame["data"]
            .as_str()
            .is_some_and(|data| data.starts_with(PNG_BASE64_PREFIX)),
        "the frame data must be a PNG"
    );
}

/// The stand-in renderer: answers whichever prompt is waiting, the way the approval dialog does
/// when the user clicks through it. The real one learns the identifier from the
/// `ai-approval-request` event; there is no window here to receive one.
fn approve_when_asked() -> thread::JoinHandle<usize> {
    thread::spawn(|| {
        let deadline = Instant::now() + Duration::from_secs(30);
        let mut answered = 0;
        while Instant::now() < deadline {
            for approval_id in approvals::pending_approvals() {
                if approvals::respond(&approval_id, true).is_ok() {
                    answered += 1;
                }
            }
            if answered > 0 {
                return answered;
            }
            thread::sleep(Duration::from_millis(25));
        }
        answered
    })
}

#[test]
fn the_final_journey_takes_one_task_from_connect_to_a_second_task() {
    let journey = Journey::start();

    // 1. Connect to a task worktree.
    //
    // The session is bound to the task's own checkout, never to the user's. That is the whole
    // reason the supervisor refuses `agent_workspace`'s fallback: staging writes files and edits
    // project.godot, and doing that in the main checkout is not something an undo can take back.
    let worktree = journey.new_task();
    let session = journey.start_session();
    assert_eq!(
        Path::new(session["worktree"].as_str().expect("session worktree")),
        worktree,
        "the session must bind to the active task's worktree"
    );
    assert!(
        session["godotVersion"]
            .as_str()
            .is_some_and(|version| version.starts_with("4.7.2.stable")),
        "the supervisor must report the pinned engine: {session}"
    );
    assert!(
        worktree.join("addons/gofer/plugin.cfg").is_file(),
        "the addon must be staged into the project the session is running in"
    );
    assert!(
        crate::git::current_branch(&journey.workspace)
            .is_some_and(|branch| branch.starts_with("gofer/task-")),
        "the session runs on the task's own branch in the project's one checkout"
    );
    assert!(read(&worktree, "project.godot").contains("GoferRuntime"));
    // The editor's own output is captured by the supervisor and archived against this session, so
    // the engine banner is both proof that a real editor started and the first line of the run.
    assert!(
        session_output().contains("Godot Engine v4.7.2"),
        "the session must capture the editor's own output:\n{}",
        session_output()
    );

    // The sentence the model is handed about this session, against the session it describes. It
    // names the engine and the readiness and not the worktree's own path — that path is one every
    // path-taking tool refuses, and naming it here is the only way a model can learn it. Measured:
    // with it, twenty of twenty turns asked to use the shell wrote a command the confinement rule
    // refused; without it, none did. See `ai_turn::describe_session`.
    let described = crate::ai_turn::describe_session(journey.app.handle());
    assert!(
        described.starts_with("Editor session: ready. Godot 4.7.2"),
        "the session sentence must name the readiness and the engine: {described}"
    );
    assert!(
        !described.contains(&worktree.display().to_string()),
        "the session sentence must not hand the model the worktree's absolute path: {described}"
    );
    assert!(
        described.contains("never an absolute one"),
        "the session sentence must say how a path is spelled instead: {described}"
    );

    // 2. Inspect and mutate a scene, undo it, redo it, and explicitly save.
    let opened = journey.call("godot_scene", "open", json!({"path": SCENE_PATH}));
    assert_eq!(opened["scene"], SCENE_PATH);
    let mut revision = opened["revision"]
        .as_u64()
        .expect("an opened scene revision");
    assert!(
        child_names(&journey.call("godot_scene", "get_tree", json!({}))).contains(&"Label".into()),
        "the edited scene must be inspectable before it is touched"
    );

    let created = journey.call(
        "godot_node",
        "create",
        json!({
            "scene": SCENE_PATH,
            "parent": SCENE_ROOT,
            "name": MARKER_NAME,
            "type": "Marker2D",
            "expectedRevision": revision,
        }),
    );
    revision = created["revision"].as_u64().expect("a mutated revision");
    assert!(
        child_names(&journey.call("godot_scene", "get_tree", json!({})))
            .contains(&MARKER_NAME.into())
    );

    // A stale revision is refused rather than applied to a scene that moved on: the marker is
    // already there, so this write is exactly what a second author would send.
    let stale = journey.error(
        "godot_node",
        "rename",
        json!({
            "scene": SCENE_PATH,
            "node": format!("{SCENE_ROOT}/{MARKER_NAME}"),
            "name": "Stale",
            "expectedRevision": revision - 1,
        }),
    );
    assert_eq!(stale.code, "revision_conflict");

    let undone = journey.call(
        "godot_session",
        "undo",
        json!({"expectedRevision": revision}),
    );
    revision = undone["revision"].as_u64().expect("an undone revision");
    assert!(
        !child_names(&journey.call("godot_scene", "get_tree", json!({})))
            .contains(&MARKER_NAME.into()),
        "undo must walk the edited scene's own history"
    );
    let redone = journey.call(
        "godot_session",
        "redo",
        json!({"expectedRevision": revision}),
    );
    revision = redone["revision"].as_u64().expect("a redone revision");
    assert!(
        child_names(&journey.call("godot_scene", "get_tree", json!({})))
            .contains(&MARKER_NAME.into())
    );

    // Nothing reached disk until the save, which is the point of keeping it a separate operation.
    assert!(!read(&worktree, SCENE_FILE).contains(MARKER_NAME));
    let saved = journey.call("godot_scene", "save", json!({"expectedRevision": revision}));
    assert_eq!(saved["dirty"], false);
    assert!(read(&worktree, SCENE_FILE).contains(MARKER_NAME));

    // 3. Create/edit a script, fix diagnostics, format it, rename a symbol, navigate references.
    let broken = journey.open_script(BROKEN_PATH);
    assert_eq!(broken["text"], BROKEN_SCRIPT);
    let reported = journey.call(
        "godot_script",
        "diagnostics",
        json!({"path": BROKEN_PATH, "timeoutMs": CALL_TIMEOUT_MS}),
    );
    assert_eq!(reported["published"], true);
    assert!(
        reported["diagnostics"]
            .as_array()
            .is_some_and(|diagnostics| !diagnostics.is_empty()),
        "the parse error must be reported: {reported}"
    );

    // No `expectedHash`. The open above put the file's hash in the router's ledger, and the save
    // is held to it from there — a caller never carries one, and no answer hands one out.
    assert!(
        broken["hash"].is_null(),
        "an open must not put a hash in front of its caller: {broken}"
    );
    journey.call(
        "godot_script",
        "save",
        json!({"path": BROKEN_PATH, "text": FIXED_SCRIPT}),
    );
    let fixed = journey.call(
        "godot_script",
        "diagnostics",
        json!({"path": BROKEN_PATH, "timeoutMs": CALL_TIMEOUT_MS}),
    );
    assert_eq!(fixed["published"], true);
    assert_eq!(
        fixed["diagnostics"].as_array().map(Vec::len),
        Some(0),
        "the fix must clear the diagnostic: {fixed}"
    );
    assert_eq!(read(&worktree, BROKEN_PATH), FIXED_SCRIPT);

    // Formatting is allowed to ship disabled, so the journey accepts either the pin doing its work
    // or the documented unavailable state, and nothing in between. Which one is legitimate is not
    // left open: a machine that has the sidecar — CI builds it with `npm run build:gdformat` and
    // exports this variable — must take the branch where formatting ran, because a `match` that
    // accepts both is a green run that proves nothing about the formatter.
    let sidecar_available = std::env::var_os(crate::gdformat::ENV_OVERRIDE).is_some();
    match journey
        .try_call(
            "godot_script",
            Journey::one("format", json!({"source": UNFORMATTED})),
        )
        .map(|answer| answer["ops"][0]["result"].clone())
    {
        Ok(formatted) => {
            assert_eq!(formatted["changed"], true, "{formatted}");
            let again = journey.call(
                "godot_script",
                "format",
                json!({"source": formatted["formatted"]}),
            );
            // Both strings, escaped, because the bare assertion said only `true != false`. The pin
            // is idempotent for this input as a file, through stdin, and frozen — measured on this
            // machine and on a clean ubuntu-24.04 — so a run that fails here is holding two
            // versions of the same script that differ somewhere invisible.
            assert_eq!(
                again["changed"], false,
                "formatting must be idempotent\n  once:  {:?}\n  twice: {:?}",
                formatted["formatted"], again["formatted"]
            );
            assert_eq!(
                read(&worktree, BROKEN_PATH),
                FIXED_SCRIPT,
                "the formatter must never touch a source file"
            );
        }
        Err(failure) => {
            assert!(
                !sidecar_available,
                "{} names a sidecar, so formatting must not report {}: {}",
                crate::gdformat::ENV_OVERRIDE,
                failure.code,
                failure.message
            );
            assert_eq!(failure.code, "formatter_unavailable");
        }
    }

    journey.open_script(MATH_PATH);
    journey.open_script(KEEPER_PATH);
    let usage = position_of(SCORE_KEEPER, "add_score");
    let position = json!({"line": usage.line, "character": usage.character});
    let references = journey.call(
        "godot_script",
        "references",
        json!({"path": KEEPER_PATH, "position": position, "includeDeclaration": true}),
    );
    let locations = references["locations"]
        .as_array()
        .unwrap_or_else(|| panic!("references must answer with locations: {references}"));
    assert!(
        locations
            .iter()
            .all(|location| !location["path"].as_str().unwrap_or("/").starts_with('/')),
        "navigation must stay workspace-relative: {references}"
    );
    assert!(
        locations
            .iter()
            .any(|location| location["path"] == MATH_PATH),
        "the declaration in the other script must be found: {references}"
    );

    let planned = journey.call(
        "godot_script",
        "rename",
        json!({"path": KEEPER_PATH, "position": position, "newName": "sum_score"}),
    );
    let files = planned["files"].clone();
    assert!(
        files.as_array().is_some_and(|files| files.len() >= 2),
        "the rename must plan across both scripts: {planned}"
    );
    assert!(
        read(&worktree, KEEPER_PATH).contains("add_score"),
        "a planned rename writes nothing"
    );
    journey.call("godot_script", "apply_rename", json!({"files": files}));
    for path in [MATH_PATH, KEEPER_PATH] {
        let text = read(&worktree, path);
        assert!(
            text.contains("sum_score") && !text.contains("add_score"),
            "{path}: {text}"
        );
    }

    // 4. Set a breakpoint, run, inspect stack/variables, evaluate, step, and continue.
    //
    // The breakpoint rides out with the launch, because Godot answers the launch only once
    // `configurationDone` spawns the game — the order is the adapter's, not the caller's.
    let launched = journey.call(
        "godot_debug",
        "launch",
        json!({"playArgs": ["--headless"], "breakpoints": [{"path": PROBE_PATH, "lines": [BREAK_LINE]}]}),
    );
    assert_eq!(launched["breakpoints"][0]["verified"], true, "{launched}");
    assert_eq!(launched["breakpoints"][0]["path"], PROBE_PATH);

    let stop = journey.call(
        "godot_debug",
        "await_stop",
        json!({"timeoutMs": STOP_TIMEOUT_MS}),
    );
    assert_eq!(stop["stopped"]["reason"], "breakpoint", "{stop}");

    let stack = journey.call("godot_debug", "stack_trace", json!({}));
    assert_eq!(stack["frames"][0]["name"], "_tick");
    assert_eq!(stack["frames"][0]["line"], BREAK_LINE);
    assert_eq!(stack["frames"][0]["path"], PROBE_PATH);
    assert_eq!(
        stack["frames"][1]["name"], "_process",
        "the probe must stop two frames deep: {stack}"
    );

    let frame_id = stack["frames"][0]["id"].clone();
    let scopes = journey.call("godot_debug", "scopes", json!({"frameId": frame_id}));
    assert_eq!(scopes["scopes"][0]["name"], "Locals");
    let locals = journey.call(
        "godot_debug",
        "variables",
        json!({"variablesReference": scopes["scopes"][0]["variablesReference"]}),
    );
    let amount = locals["variables"]
        .as_array()
        .unwrap_or_else(|| panic!("Locals must list variables: {locals}"))
        .iter()
        .find(|variable| variable["name"] == "amount")
        .unwrap_or_else(|| panic!("the _tick argument must be a local: {locals}"));
    assert_eq!(amount["value"], "1");

    let evaluated = journey.call(
        "godot_debug",
        "evaluate",
        json!({"expression": "amount + 1", "frameId": frame_id}),
    );
    assert_eq!(evaluated["result"], "2", "{evaluated}");

    // Step-out is Gofer's own emulation: Godot 4.7 has no `stepOut` handler, so bounded step-overs
    // run until the stack depth drops back into the caller.
    let stepped = journey.call("godot_debug", "step_out", json!({}));
    assert_eq!(stepped["outcome"]["kind"], "steppedOut", "{stepped}");
    assert_eq!(
        journey.call("godot_debug", "stack_trace", json!({}))["frames"][0]["name"],
        "_process"
    );

    // With the breakpoint cleared the game runs free again, and terminating it leaves the adapter
    // in place for the runtime loop that follows.
    journey.call(
        "godot_debug",
        "set_breakpoints",
        json!({"path": PROBE_PATH, "lines": []}),
    );
    assert_eq!(
        journey.call("godot_debug", "continue", json!({}))["allThreads"],
        true
    );
    journey.call("godot_debug", "terminate", json!({}));

    // 5. Inspect the runtime tree, inject input, and capture the changed game screen.
    let run = journey.call(
        "godot_runtime",
        "run",
        json!({"timeoutMs": LAUNCH_TIMEOUT_MS}),
    );
    assert_eq!(run["running"], true);
    assert_frame(&run["frame"]);

    let tree = journey.call("godot_runtime", "get_tree", json!({}));
    let running: Vec<String> = tree["root"]["children"]
        .as_array()
        .unwrap_or_else(|| panic!("the running tree must carry children: {tree}"))
        .iter()
        .map(|child| child["name"].as_str().expect("child name").to_owned())
        .collect();
    assert!(
        running.contains(&"GoferRuntime".to_owned())
            && running.contains(&"JourneyProbe".to_owned()),
        "the runtime helper and the main scene must both be live: {running:?}"
    );
    // The edited scene and the running scene stay separate concepts: the marker was saved into the
    // file, and the game running from it is a different tree with a different question to ask.
    assert!(
        !running.contains(&MARKER_NAME.to_owned()),
        "the running tree is the game's, not the edited scene's: {running:?}"
    );

    let label = |journey: &Journey| -> String {
        let inspected = journey.call(
            "godot_runtime",
            "inspect_node",
            json!({"path": "/root/JourneyProbe/Label", "properties": ["text"]}),
        );
        inspected["properties"]["text"]["value"]
            .as_str()
            .unwrap_or_else(|| panic!("the label text must cross the wire tagged: {inspected}"))
            .to_owned()
    };
    assert_eq!(label(&journey), "presses: 0 (none)");

    let injected = journey.call(
        "godot_runtime",
        "input",
        json!({"events": [
            {"kind": "key", "key": "G", "pressed": true, "device": INJECTED_DEVICE},
            {"kind": "key", "key": "G", "pressed": false, "device": INJECTED_DEVICE},
        ]}),
    );
    assert_eq!(injected["applied"], 2);
    assert_frame(&injected["frame"]);
    assert_eq!(
        label(&journey),
        "presses: 1 (key)",
        "the injected key must change fixture state"
    );
    assert_frame(&journey.call("godot_runtime", "capture", json!({}))["frame"]);
    assert!(
        journey.call(
            "godot_runtime",
            "get_monitors",
            json!({"monitors": ["fps"]})
        )["monitors"]["fps"]
            .as_f64()
            .is_some_and(|fps| fps >= 0.0)
    );
    journey.call("godot_runtime", "stop", json!({}));

    // 6. Edit project settings and approve one machine-wide editor setting.
    let written = journey.call(
        "godot_project",
        "set_setting",
        json!({"name": "gofer_journey/completed", "value": {"type": "bool", "value": true}}),
    );
    assert_eq!(written["saved"], true);
    assert_eq!(
        journey.call(
            "godot_project",
            "get_setting",
            json!({"name": "gofer_journey/completed"})
        )["value"],
        json!({"type": "bool", "value": true})
    );

    // A machine-wide editor setting is the one write the task cannot roll back, so it stops and
    // waits for the user. It is written back to itself: the developer's own settings file must not
    // change under a test, and what is being proven is the gate, not the value.
    let found = journey.call(
        "godot_project",
        "search_editor_settings",
        json!({"query": "font_size"}),
    );
    let candidate = found["settings"]
        .as_array()
        .expect("editor settings")
        .iter()
        .find(|entry| entry["value"]["type"] == "int")
        .cloned()
        .expect("an integer editor setting about font sizes");
    let responder = approve_when_asked();
    let approved = journey.call(
        "godot_project",
        "set_editor_setting",
        json!({"name": candidate["name"], "value": candidate["value"]}),
    );
    assert_eq!(approved["machineWide"], true);
    assert_eq!(
        responder.join().expect("responder thread"),
        1,
        "the machine-wide write must have waited for exactly one answer"
    );

    // 7. Retrieve relevant Godot documentation.
    //
    // The embedding index is the one thing that cannot be a fixture, so the retrieve sidecar's
    // model call is scripted the way the acceptance model is. Everything downstream of it is real:
    // the Node worker, its response framing, the vector stripping, and the router.
    let _cache = EnvGuard::set("GOFER_RAG_CACHE_DIR", journey.directory.path().join("rag"));
    let _worker = EnvGuard::set(
        "GOFER_RAG_RETRIEVE_WORKER",
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("fixtures")
            .join("rag")
            .join("retrieve-worker.mjs"),
    );
    let docs = journey.call(
        "godot_docs_search",
        "search",
        // No `maxPassages`: how many passages clear the relevance gate is the search's decision,
        // not the model's, so the model is no longer offered a number it cannot reason about.
        json!({"question": "How do I connect a signal?", "maxTextChars": 40}),
    );
    let passages = docs["passages"]
        .as_array()
        .unwrap_or_else(|| panic!("documentation must answer with passages: {docs}"));
    assert_eq!(passages.len(), 3, "{docs}");
    assert_eq!(passages[0]["chapter"], "Signals");
    assert!(passages[0]["order"].is_number() && passages[0]["score"].is_number());
    assert!(
        passages[0]["text"]
            .as_str()
            .expect("passage text")
            .chars()
            .count()
            <= 40,
        "passage text must respect the caller's bound: {docs}"
    );
    assert!(
        !docs.to_string().contains("vector"),
        "a raw embedding must never reach the model or the renderer: {docs}"
    );

    // 8. Switch tasks and verify complete cleanup and rebinding.
    let exclude = journey.workspace.join(".git").join("info").join("exclude");
    assert!(
        std::fs::read_to_string(&exclude)
            .expect("read the shared exclude file")
            .contains("addons/gofer/"),
        "the staged addon must be excluded through Git's own per-repository exclude file"
    );

    journey.call("godot_session", "stop", json!({}));
    assert!(
        !worktree.join("addons").exists(),
        "stopping must remove everything staging introduced"
    );
    let project = read(&worktree, "project.godot");
    assert!(
        !project.contains("GoferRuntime") && !project.contains("addons/gofer"),
        "project.godot must keep only what the project owns:\n{project}"
    );
    assert!(
        project.contains("[gofer_journey]") && project.contains("completed=true"),
        "the project setting the task made must survive the session that made it:\n{project}"
    );

    // The scene as the first task's branch records it, read before the switch. Nothing the second
    // task does may write over it, and nothing the first task's editor still held may either.
    let first_branch = journey.current_branch();
    let scene_on_first_branch = read(&worktree, SCENE_FILE);
    assert!(scene_on_first_branch.contains(MARKER_NAME));

    let second = journey.new_task();
    let second_branch = journey.current_branch();
    assert_eq!(
        second, worktree,
        "every task works in the project's one checkout"
    );
    assert_ne!(
        second_branch, first_branch,
        "a second task gets its own branch, and opening it moves the checkout"
    );
    // The measured failure this whole design exists to prevent. Godot holds every open scene in
    // memory and never rereads one a checkout changed underneath it: an editor left running through
    // a switch writes the outgoing task's copy over the incoming task's file on the next save, with
    // no error anywhere. Creating the task stopped the session, so there was no editor to do it.
    assert!(
        godot_session::current_info().is_none(),
        "opening another task must stop the editor before the checkout moves"
    );
    // The second branch came off the commit, not off the first task, so none of the first task's
    // work is visible in it.
    assert!(!read(&second, SCENE_FILE).contains(MARKER_NAME));
    assert!(!read(&second, "project.godot").contains("gofer_journey"));

    let rebound = journey.start_session();
    assert_eq!(
        Path::new(rebound["worktree"].as_str().expect("session worktree")),
        second,
        "the new session runs in the project, now holding the second task's branch"
    );
    assert!(second.join("addons/gofer/plugin.cfg").is_file());

    let bound = journey.call("godot_scene", "open", json!({"path": SCENE_PATH}));
    assert_eq!(bound["scene"], SCENE_PATH);
    assert!(
        !child_names(&journey.call("godot_scene", "get_tree", json!({})))
            .contains(&MARKER_NAME.into()),
        "the rebound editor must show the second task's scene"
    );

    // 9. Delete the task the editor is running in.
    //
    // Deleting is how the sidebar gets rid of a task, and an editor running in the project is
    // exactly when that is inconvenient: the session has to stop first, the addon has to come out
    // with it, the branch has to be gone afterwards, and the checkout has to end up somewhere the
    // user can still work.
    let before = journey.storage.tasks().list().expect("list tasks");
    let doomed = before
        .iter()
        .find(|task| task.is_current)
        .expect("the second task is the current one")
        .clone();
    let branch = doomed
        .worktree
        .as_ref()
        .expect("the second task's branch")
        .branch_name
        .clone();
    // The real Switch: the same `leave_task` a deletion runs in the app, not a re-spelling of it.
    let release = |worktree: &Path| crate::leave_task(journey.app.handle(), worktree);
    let replacement = journey
        .storage
        .tasks()
        .delete(
            &doomed.id,
            &journey.storage.switch_with_no_turn_to_refuse(&release),
        )
        .expect("delete the task the editor is running in");

    assert!(
        godot_session::current_info().is_none(),
        "deleting a task must stop the editor that was running in it"
    );
    assert!(
        second.join("project.godot").is_file(),
        "the project itself outlives any task deleted from it"
    );
    assert!(
        !git_text(&journey.workspace, &["branch", "--list", &branch]).contains(&branch),
        "the deleted task's branch must be gone from the repository"
    );
    assert_ne!(
        journey.current_branch(),
        branch,
        "the checkout must be moved off the branch being deleted, not left on it"
    );
    // Only the deleted task goes: the first task keeps its place in the list and its checkout.
    let remaining = journey.storage.tasks().list().expect("remaining tasks");
    assert_eq!(remaining.len(), before.len() - 1);
    assert!(!remaining.iter().any(|task| task.id == doomed.id));
    assert!(worktree.join("project.godot").is_file());
    let current = remaining
        .iter()
        .find(|task| task.is_current)
        .expect("a task takes over from the deleted one");
    assert_eq!(replacement.task_id.as_deref(), Some(current.id.as_str()));
    assert!(
        !std::fs::read_to_string(&exclude)
            .expect("read the shared exclude file")
            .contains("addons/gofer/"),
        "the session the deletion stopped must hand the shared exclude file back"
    );
}

/// The Godot rules a user ticked are applied to a session nothing is listening to.
///
/// The two rules are applied when a session goes ready, and going ready used to be an edge computed
/// inside `subscribe_godot_events` — a command the renderer calls, is refused while the editor has
/// no RPC channel yet, and retries on a reconcile tick. A subscriber that attached after the editor
/// was already ready seeded its own `last_state` with `Ready`, the edge never fired, and both
/// effects were discarded with `let _ =`. `enforce_godot_policy` had exactly one caller: that edge.
///
/// This journey subscribes to nothing at all, which is the case that used to apply no rules
/// whatever. The five warnings are project settings, so they are read back out of the worktree's
/// own `project.godot` through the addon rather than trusted from Gofer's bookkeeping.
#[test]
fn a_session_nobody_subscribed_to_still_gets_the_rules_the_user_chose() {
    use crate::godot_policy::{GAME_EMBED_MODE, STRICT_TYPING_WARNINGS};

    let journey = Journey::start();
    journey.new_task();
    journey.start_session();

    // The rules are applied off the watch's own thread, so the editor is asked until it agrees
    // rather than once at whatever moment this line runs. Its own deadline, and a short one: the
    // session is already ready by here, and a watch that is not running never agrees at all — so
    // this is how long a failure takes, not how long a pass does.
    let settle = |tool: &str, name: &str, want: Value| -> Result<(), Value> {
        let deadline = Instant::now() + POLICY_TIMEOUT;
        loop {
            let read = journey.call("godot_project", tool, json!({"name": name}))["value"].clone();
            if read == want {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err(read);
            }
            thread::sleep(Duration::from_millis(100));
        }
    };

    if let Err(last) = settle(
        "get_setting",
        STRICT_TYPING_WARNINGS[0],
        json!({"type": "int", "value": 2}),
    ) {
        panic!(
            "a ready session must enforce strict typing with nothing subscribed, and this one read \
             {last}\n--- session output ---\n{}",
            session_output()
        );
    }

    // All five, because four of them without the first still let an untyped `var` through.
    for warning in STRICT_TYPING_WARNINGS {
        assert_eq!(
            journey.call("godot_project", "get_setting", json!({"name": warning}))["value"],
            json!({"type": "int", "value": 2}),
            "{warning} must read as Error\n--- session output ---\n{}",
            session_output()
        );
    }

    // The other half of the same policy, and the half nothing used to read back here. It is an
    // EditorSetting rather than a project one, so it is asked for through the editor's own store —
    // and it is written last, so it is settled for separately rather than assumed from the
    // warnings. 1 is Embed Game; 0 is the per-project default a session that never applied it
    // leaves behind.
    if let Err(last) = settle(
        "get_editor_setting",
        GAME_EMBED_MODE,
        json!({"type": "int", "value": 1}),
    ) {
        panic!(
            "a ready session must embed the game window, and this one read {last}\n--- session \
             output ---\n{}",
            session_output()
        );
    }
}

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
//! The eight steps of the plan are the eight sections of the test: connect to a task worktree;
//! inspect, mutate, undo, redo, and save a scene; author a script, fix its diagnostics, format it,
//! rename a symbol, and navigate references; break, run, inspect, evaluate, step, and continue;
//! inspect the runtime tree, inject input, and capture the changed screen; edit project settings
//! and approve one machine-wide editor setting; retrieve documentation; and switch tasks with a
//! complete cleanup and rebinding.
//!
//! Two things cannot be carried into a test and are stood in for deliberately, each at the outer
//! edge of the system: the user who answers an approval prompt, and the embedding index behind
//! documentation retrieval. Everything between those edges and the engine is real.
//!
//! Gated behind the `godot-acceptance` feature so the fast gate needs no engine.

use crate::ai_tools::{self, ToolFailure, ToolRequest};
use crate::approvals;
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
const PROBE_TIMEOUT_MS: u64 = 2_000;
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

/// The probe is the fixture game and the debugged script at once: `_tick` gives the breakpoint a
/// two-frame stack with a local worth reading, and the input counter gives the screenshot and the
/// remote tree a visible consequence of an injected event.
const PROBE_SCRIPT: &str = "extends Node2D\n\nvar presses := 0\nvar counter := 0\nvar last_source := \"none\"\n\n@onready var label: Label = $Label\n\nfunc _ready() -> void:\n\t_refresh()\n\nfunc _process(_delta: float) -> void:\n\t_tick(1)\n\nfunc _tick(amount: int) -> void:\n\tcounter += amount\n\nfunc _input(event: InputEvent) -> void:\n\tif event is InputEventKey and event.pressed and not event.echo:\n\t\t_record(\"key\")\n\nfunc _record(source: String) -> void:\n\tpresses += 1\n\tlast_source = source\n\t_refresh()\n\nfunc _refresh() -> void:\n\tlabel.text = \"presses: %d (%s)\" % [presses, last_source]\n";
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
}

impl Drop for Journey {
    fn drop(&mut self) {
        approvals::cancel_all();
        let _ = ai_tools::dispatch(
            self.app.handle(),
            ToolRequest {
                tool: "godot_session".to_owned(),
                params: json!({"op": "stop", "params": {}}),
            },
        );
    }
}

impl Journey {
    fn start() -> Self {
        // Every other acceptance module points the script and debug commands at an editor it
        // launched itself. This one drives the supervised session, so any binding still standing —
        // including one a module that panicked never took down — is dropped before anything runs.
        crate::script::clear_test_session();
        crate::debug::clear_test_session();
        godot_session::bind_test_rpc(None);

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
        ];

        let storage = ProjectStorage::open(&root.join("data"), &workspace).expect("open storage");
        let app = tauri::test::mock_builder()
            .build(tauri::generate_context!())
            .expect("build mock Tauri app");
        // Approvals are shown in the main window, and a backend without one refuses rather than
        // deciding for the user.
        tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("build mock webview");
        app.manage(storage.clone());
        // A turn is running: gated tool calls only ever wait for a user inside one.
        approvals::open();

        Self {
            app,
            storage,
            workspace,
            directory,
            _environment: environment,
        }
    }

    /// Creates a task and returns its isolated worktree, which is what every session binds to.
    fn new_task(&self) -> PathBuf {
        self.storage.create_task().expect("create task");
        self.storage
            .active_task_workspace()
            .expect("the new task must have an isolated worktree")
            .canonicalize()
            .expect("canonical task worktree")
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

    fn call(&self, tool: &str, op: &str, params: Value) -> Value {
        self.try_call(tool, json!({"op": op, "params": params}))
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
        self.try_call(tool, json!({"op": op, "params": params}))
            .err()
            .unwrap_or_else(|| panic!("{tool}.{op} was expected to fail"))
    }

    /// Starts the session the supervisor way and waits until the staged addon reports readiness.
    fn start_session(&self) -> Value {
        let started = self.call("godot_session", "start", json!({}))["session"].clone();
        let deadline = Instant::now() + READY_TIMEOUT;
        let mut last = "no reply".to_owned();
        while Instant::now() < deadline {
            match self.try_call(
                "godot_session",
                json!({"op": "get_state", "params": {"timeoutMs": PROBE_TIMEOUT_MS}}),
            ) {
                Ok(state) if state["state"] == "ready" => return started,
                Ok(state) => last = state.to_string(),
                Err(failure) => last = format!("{}: {}", failure.code, failure.message),
            }
            thread::sleep(Duration::from_millis(250));
        }
        panic!(
            "the addon never reported a ready session: {last}\n--- session output ---\n{}",
            session_output()
        );
    }

    /// Opens a script through the language server, retrying while the editor is still importing:
    /// the script commands connect lazily, so the first call is also what proves the server is up.
    fn open_script(&self, path: &str) -> Value {
        let deadline = Instant::now() + READY_TIMEOUT;
        let mut last = "no attempt".to_owned();
        while Instant::now() < deadline {
            match self.try_call(
                "godot_script",
                json!({"op": "open", "params": {"path": path}}),
            ) {
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
            .is_some_and(|version| version.starts_with("4.7.1.stable")),
        "the supervisor must report the pinned engine: {session}"
    );
    assert!(
        worktree.join("addons/gofer/plugin.cfg").is_file(),
        "the addon must be staged into the task worktree"
    );
    assert!(
        !journey.workspace.join("addons").exists(),
        "the user's own checkout must never receive the addon"
    );
    assert!(read(&worktree, "project.godot").contains("GoferRuntime"));
    // The editor's own output is captured by the supervisor and archived against this session, so
    // the engine banner is both proof that a real editor started and the first line of the run.
    assert!(
        session_output().contains("Godot Engine v4.7.1"),
        "the session must capture the editor's own output:\n{}",
        session_output()
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

    journey.call(
        "godot_script",
        "save",
        json!({"path": BROKEN_PATH, "text": FIXED_SCRIPT, "expectedHash": broken["hash"]}),
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

    // Formatting is allowed to ship disabled — the pinned sidecar is built per platform in CI — so
    // the journey accepts either the pin doing its work or the documented unavailable state, and
    // nothing in between.
    match journey.try_call(
        "godot_script",
        json!({"op": "format", "params": {"source": UNFORMATTED}}),
    ) {
        Ok(formatted) => {
            assert_eq!(formatted["changed"], true, "{formatted}");
            let again = journey.call(
                "godot_script",
                "format",
                json!({"source": formatted["formatted"]}),
            );
            assert_eq!(again["changed"], false, "formatting must be idempotent");
            assert_eq!(
                read(&worktree, BROKEN_PATH),
                FIXED_SCRIPT,
                "the formatter must never touch a source file"
            );
        }
        Err(failure) => assert_eq!(failure.code, "formatter_unavailable"),
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
            {"kind": "key", "key": "G", "pressed": true},
            {"kind": "key", "key": "G", "pressed": false},
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
        json!({"question": "How do I connect a signal?", "maxPassages": 2, "maxTextChars": 40}),
    );
    let passages = docs["passages"]
        .as_array()
        .unwrap_or_else(|| panic!("documentation must answer with passages: {docs}"));
    assert_eq!(passages.len(), 2, "{docs}");
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

    let second = journey.new_task();
    assert_ne!(second, worktree, "a second task gets its own worktree");
    let rebound = journey.start_session();
    assert_eq!(
        Path::new(rebound["worktree"].as_str().expect("session worktree")),
        second,
        "the new session must bind to the new task's worktree"
    );
    assert!(second.join("addons/gofer/plugin.cfg").is_file());
    assert!(
        !worktree.join("addons").exists(),
        "the first task's worktree must stay clean while the second is staged"
    );
    // The second worktree branched from the commit, not from the first task: none of the first
    // task's uncommitted work is visible in it.
    assert!(!read(&second, SCENE_FILE).contains(MARKER_NAME));
    assert!(!read(&second, "project.godot").contains("gofer_journey"));

    let bound = journey.call("godot_scene", "open", json!({"path": SCENE_PATH}));
    assert_eq!(bound["scene"], SCENE_PATH);
    assert!(
        !child_names(&journey.call("godot_scene", "get_tree", json!({})))
            .contains(&MARKER_NAME.into()),
        "the rebound editor must show the second task's scene"
    );

    journey.call("godot_session", "stop", json!({}));
    assert!(!second.join("addons").exists());
    assert!(
        !std::fs::read_to_string(&exclude)
            .expect("read the shared exclude file")
            .contains("addons/gofer/"),
        "the last session to stop must hand the shared exclude file back"
    );
}

//! Acceptance coverage for the runtime feedback loop: the real addon bridging `runtime.*`
//! requests into a real running game over Godot's debugger channel.
//!
//! The unit suites on either side of this boundary cannot see the failures that live in the
//! middle — an editor plugin that never registers its debugger capture, a runtime autoload whose
//! announcement races the debugger session, an input event that parses but is never dispatched, a
//! screenshot of a window that was never rendered. This module removes the stand-ins: it stages
//! the addon, launches the pinned editor, starts the fixture game through `runtime.run`, and
//! proves the loop the inspector and the agent will drive — remote tree and node inspection,
//! keyboard/mouse/gamepad input, performance monitors, and game/editor viewport capture. The
//! done-criteria of the step is the middle of the test: an injected key press changes fixture
//! state, and the following screenshot and remote-tree answer carry the proof.
//!
//! The editor runs headless like every other acceptance session; the game it launches does not,
//! because a screenshot needs a rendered frame. Gated behind the `godot-acceptance` feature so
//! the fast gate needs no engine.

use crate::addon::AddonStager;
use crate::files::Workspace;
use crate::godot_rpc::{CallRequest, EventEnvelope, RpcSession};
use crate::process::{ChildProcess, ProcessSpawner, SystemProcessSpawner};
use serde_json::{Value, json};
use std::ffi::{OsStr, OsString};
use std::io::{BufRead, BufReader};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tempfile::TempDir;

/// The engine the repository pins. Kept in step with `scripts/godot-binary.mjs`, which reads the
/// same manifest and reports the version with dots where the release tag has a dash.
const ARTIFACTS: &str = include_str!("../../protocol/godot-artifacts.json");
const READY_TIMEOUT: Duration = Duration::from_secs(90);
const STOP_TIMEOUT: Duration = Duration::from_secs(15);
const CALL_TIMEOUT_MS: u64 = 30_000;
/// A launch is answered only after the game booted, its helper announced itself, and the first
/// frame was captured, so it gets a wider budget than an ordinary call.
const LAUNCH_TIMEOUT_MS: u64 = 60_000;
const PROBE_TIMEOUT_MS: u64 = 2_000;
/// Lifecycle events are queued before the launch that caused them is answered, so waiting on one
/// after the call returns is a formality — the budget only covers a loaded machine.
const EVENT_TIMEOUT: Duration = Duration::from_secs(15);

/// The device id this test stamps on every event it injects, and the only device the probe counts.
///
/// The game window is a real window on a real desktop: it can take focus, and the developer's own
/// keyboard and mouse reach `_input` exactly like an injected event does. Counting one device
/// instead of all input is what keeps the assertions about *this test's* input true no matter what
/// else is happening on the machine. Any value outside the engine's own device numbering works;
/// this one is far outside it.
const INJECTED_DEVICE: i64 = 7777;

/// The probe counts injected input by source and shows it in a Label, so both the remote tree and
/// the screenshots have a visible, inspectable consequence of every event. It listens in `_input`
/// rather than `_unhandled_input`: a Control under the cursor is allowed to consume mouse events,
/// and the test has no business depending on the label's mouse filter.
const PROBE_SCRIPT: &str = "extends Node2D\n\nconst INJECTED_DEVICE := 7777\n\nvar presses := 0\nvar last_source := \"none\"\n\n@onready var label: Label = $Label\n\nfunc _ready() -> void:\n\t_refresh()\n\n# Only the test's own input counts. Anything the desktop delivers to this window carries a device\n# the engine assigned, never this one, so a stray keystroke cannot change the assertions.\nfunc _input(event: InputEvent) -> void:\n\tif event.device != INJECTED_DEVICE:\n\t\treturn\n\tif event is InputEventKey and event.pressed and not event.echo:\n\t\t_record(\"key\")\n\telif event is InputEventMouseButton and event.pressed:\n\t\t_record(\"mouse\")\n\telif event is InputEventJoypadButton and event.pressed:\n\t\t_record(\"gamepad\")\n\nfunc _record(source: String) -> void:\n\tpresses += 1\n\tlast_source = source\n\t_refresh()\n\nfunc _refresh() -> void:\n\tlabel.text = \"presses: %d (%s)\" % [presses, last_source]\n";

/// The fixture scene with the probe script attached. Written into the copied worktree: the
/// checked-in fixture deliberately stays free of scripts so the Node journeys see a project that
/// can never produce script output.
const PROBE_SCENE: &str = "[gd_scene load_steps=2 format=3]\n\n[ext_resource type=\"Script\" path=\"res://scripts/runtime_probe.gd\" id=\"1_probe\"]\n\n[node name=\"RuntimeProbe\" type=\"Node2D\"]\nscript = ExtResource(\"1_probe\")\n\n[node name=\"Label\" type=\"Label\" parent=\".\"]\noffset_right = 320.0\noffset_bottom = 40.0\n";

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
/// wins, otherwise the pinned version is accepted from `PATH`. The version is always verified, so
/// neither route can silently test a different engine.
fn pinned_editor(spawner: &impl ProcessSpawner) -> String {
    let expected = pinned_version_prefix();
    let reported = |binary: &str| {
        let arguments = [OsString::from("--version")];
        let output = spawner.output(OsStr::new(binary), &arguments).ok()?;
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

/// Copies the fixture project and turns it into a game the loop can observe: a main scene whose
/// probe script counts injected input in a Label.
fn fixture_worktree(directory: &TempDir) -> PathBuf {
    let worktree = directory.path().join("worktree");
    let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("fixtures")
        .join("godot-project");
    copy_tree(&fixture, &worktree);
    std::fs::create_dir_all(worktree.join("scripts")).expect("create scripts directory");
    std::fs::write(worktree.join("scripts/runtime_probe.gd"), PROBE_SCRIPT)
        .expect("write the probe script");
    std::fs::write(worktree.join("main.tscn"), PROBE_SCENE).expect("write the probe scene");
    crate::paths::canonical(&worktree).expect("canonical worktree")
}

fn launch(worktree: &Path, port: u16, token: &str) -> Editor {
    let arguments = [
        OsString::from("--editor"),
        OsString::from("--headless"),
        OsString::from("--path"),
        worktree.as_os_str().to_owned(),
    ];
    let environment = [
        (
            OsString::from("GOFER_RPC_PORT"),
            OsString::from(port.to_string()),
        ),
        (OsString::from("GOFER_RPC_TOKEN"), OsString::from(token)),
    ];
    let binary = pinned_editor(&SystemProcessSpawner);
    let mut child = SystemProcessSpawner
        .spawn_with_env(OsStr::new(&binary), &arguments, false, &environment)
        .expect("launch the pinned Godot editor");

    // Both of the editor's streams are pipes. An unread pipe fills and stalls the editor long
    // before the addon loads, so they are drained into one buffer that a failure can quote.
    let output = Arc::new(Mutex::new(String::new()));
    for stream in [child.take_stdout(), child.take_stderr()] {
        let Some(stream) = stream else { continue };
        let sink = Arc::clone(&output);
        thread::spawn(move || {
            let mut reader = BufReader::new(stream);
            let mut line = String::new();
            while reader.read_line(&mut line).unwrap_or(0) > 0 {
                if let Ok(mut sink) = sink.lock() {
                    sink.push_str(&line);
                }
                line.clear();
            }
        });
    }
    Editor { child, output }
}

struct Session {
    rpc: RpcSession,
    editor: Editor,
    _directory: TempDir,
    stager: AddonStager,
    worktree: PathBuf,
}

impl Drop for Session {
    fn drop(&mut self) {
        self.rpc.stop();
        let _ = self.stager.unstage(&self.worktree);
    }
}

impl Session {
    /// Stages the addon into a fresh worktree, launches the editor, and waits for the addon to
    /// report that it is ready.
    fn start() -> Self {
        let directory = TempDir::new().expect("temporary directory");
        let worktree = fixture_worktree(&directory);
        let stager = AddonStager::new(directory.path().join("ledger.json"));
        let workspace = Workspace::open(&worktree).expect("open worktree");
        stager.stage(&workspace).expect("stage the Gofer addon");

        let listener = TcpListener::bind("127.0.0.1:0").expect("bind RPC listener");
        let port = listener.local_addr().expect("listener address").port();
        let token = "b2".repeat(32);
        let rpc = RpcSession::start(listener, token.clone(), worktree.display().to_string());
        let editor = launch(&worktree, port, &token);

        let session = Self {
            rpc,
            editor,
            _directory: directory,
            stager,
            worktree,
        };
        session.await_ready();
        session
    }

    /// Polls until the addon answers as ready. The editor imports the project and enables plugins
    /// before the addon connects, so early probes are expected to fail and use a short timeout.
    fn await_ready(&self) {
        let deadline = Instant::now() + READY_TIMEOUT;
        let mut last = "no reply".to_owned();
        while Instant::now() < deadline {
            match self.request("session.get_state", json!({}), PROBE_TIMEOUT_MS) {
                Ok(result) if result["state"] == "ready" => return,
                Ok(result) => last = result.to_string(),
                Err(error) => last = error,
            }
            thread::sleep(Duration::from_millis(250));
        }
        panic!(
            "the addon never reported a ready session: {last}\n--- editor output ---\n{}",
            self.editor.output()
        );
    }

    /// Polls until the editor reports the game fully gone. `runtime.stop` answers before the game
    /// process actually exits, and only the debugger session's teardown clears the helper's
    /// readiness, so assertions about the stopped state have to wait for it.
    fn await_stopped(&self) {
        let deadline = Instant::now() + STOP_TIMEOUT;
        while Instant::now() < deadline {
            if let Ok(state) = self.request("runtime.get_state", json!({}), PROBE_TIMEOUT_MS)
                && state["running"] == false
                && state["runtimeReady"] == false
            {
                return;
            }
            thread::sleep(Duration::from_millis(200));
        }
        panic!(
            "the game never stopped\n--- editor output ---\n{}",
            self.editor.output()
        );
    }

    fn request(&self, command: &str, params: Value, timeout_ms: u64) -> Result<Value, String> {
        static NEXT_ID: AtomicU64 = AtomicU64::new(0);
        let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
        self.rpc
            .call(CallRequest {
                id: format!("runtime-acceptance-{id}"),
                command: command.to_owned(),
                params,
                expected_revision: None,
                timeout_ms: Some(timeout_ms),
            })
            .map(|response| response.result)
            .map_err(|error| format!("{}: {}", error.code, error.message))
    }

    fn call(&self, command: &str, params: Value) -> Value {
        self.request(command, params, CALL_TIMEOUT_MS)
            .unwrap_or_else(|error| panic!("{command} failed: {error}"))
    }

    fn error(&self, command: &str, params: Value) -> String {
        self.request(command, params, CALL_TIMEOUT_MS)
            .err()
            .unwrap_or_else(|| panic!("{command} was expected to fail"))
    }
}

/// A frame must be a real PNG of the game viewport: the right encoding, a sane size inside the
/// protocol's 1920 px edge cap, and the PNG signature leading the base64 payload. Exact window
/// dimensions are deliberately not asserted — a tiling compositor may resize the game window.
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
    let data = frame["data"].as_str().expect("frame data");
    assert!(
        data.starts_with(PNG_BASE64_PREFIX),
        "the frame data must be a PNG"
    );
}

/// Waits for one named event, ignoring the others already queued. Each running game announces its
/// helper once, and a restart reuses the editor's single debugger session — the case where a
/// second announcement is easy to mistake for a repeat of the first and swallow.
fn await_event(events: &Receiver<EventEnvelope>, name: &str) -> Value {
    let deadline = Instant::now() + EVENT_TIMEOUT;
    while Instant::now() < deadline {
        match events.recv_timeout(Duration::from_millis(250)) {
            Ok(event) if event.event == name => return event.data,
            Ok(_) => continue,
            Err(RecvTimeoutError::Timeout) => continue,
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }
    panic!("the addon never sent a {name} event");
}

/// Reads the probe label through the debugger channel, the inspectable consequence of input.
fn label_text(session: &Session) -> String {
    let inspected = session.call(
        "runtime.inspect_node",
        json!({"path": "/root/RuntimeProbe/Label", "properties": ["text"]}),
    );
    inspected["properties"]["text"]
        .as_object()
        .filter(|tagged| tagged["type"] == "string")
        .and_then(|tagged| tagged["value"].as_str())
        .unwrap_or_else(|| {
            panic!("the label text must cross the wire as a tagged string: {inspected}")
        })
        .to_owned()
}

#[test]
fn the_runtime_loop_drives_input_and_proves_it_with_tree_and_screenshots() {
    let session = Session::start();
    let events = session.rpc.subscribe_events();

    // Nothing runs yet: inspection fails retryably and the state says so.
    let state = session.call("runtime.get_state", json!({}));
    assert_eq!(state["running"], false);
    assert_eq!(state["runtimeReady"], false);
    assert!(
        session
            .error("runtime.get_tree", json!({}))
            .starts_with("runtime_not_running"),
        "inspection without a game must fail before any debugger message is sent"
    );

    // The launch answer rides back with the first rendered frame — the proof the game produced
    // pixels, captured automatically as every successful run must.
    let run = session
        .request("runtime.run", json!({}), LAUNCH_TIMEOUT_MS)
        .unwrap_or_else(|error| {
            panic!(
                "runtime.run failed: {error}\n--- editor output ---\n{}",
                session.editor.output()
            )
        });
    assert_eq!(run["running"], true);
    assert_frame(&run["frame"]);
    assert_eq!(
        await_event(&events, "runtime.ready")["protocolVersion"],
        2,
        "the helper announces itself to the session, not only to the launch that waited for it"
    );

    assert!(
        session
            .error("runtime.run", json!({}))
            .starts_with("already_running"),
        "a second launch must be refused while the game is up"
    );

    // The remote tree is the running game's tree — the autoloaded helper and the probe scene sit
    // under the root window — and it stays a separate concept from the edited scene's tree.
    let tree = session.call("runtime.get_tree", json!({}));
    assert_eq!(tree["truncated"], false);
    let names: Vec<&str> = tree["root"]["children"]
        .as_array()
        .expect("root children")
        .iter()
        .map(|child| child["name"].as_str().expect("child name"))
        .collect();
    assert!(
        names.contains(&"GoferRuntime"),
        "the runtime helper must be autoloaded into the game: {names:?}"
    );
    assert!(
        names.contains(&"RuntimeProbe"),
        "the main scene must be running: {names:?}"
    );

    assert_eq!(label_text(&session), "presses: 0 (none)");

    // The step's done-criteria: an injected key press changes fixture state, and the response's
    // automatically captured frame plus the following inspection both postdate the change.
    let key = session.call(
        "runtime.input",
        json!({"events": [
            {"kind": "key", "key": "G", "pressed": true, "device": INJECTED_DEVICE},
            {"kind": "key", "key": "G", "pressed": false, "device": INJECTED_DEVICE},
        ]}),
    );
    assert_eq!(key["applied"], 2, "press and release are both applied");
    assert_frame(&key["frame"]);
    assert_eq!(label_text(&session), "presses: 1 (key)");

    // Input this test did not stamp belongs to whoever is using the desktop the game window opened
    // on. An unstamped event takes the same path into `_input` that a real keystroke does — the
    // engine assigns it a device of its own — so this is the assertion that says the count above
    // cannot be changed by a developer typing while the suite runs.
    let stray = session.call(
        "runtime.input",
        json!({"events": [
            {"kind": "key", "key": "H", "pressed": true},
            {"kind": "key", "key": "H", "pressed": false},
        ]}),
    );
    assert_eq!(stray["applied"], 2, "unstamped input is still injected");
    assert_eq!(
        label_text(&session),
        "presses: 1 (key)",
        "the probe counts this test's input and nothing else"
    );

    let click = session.call(
        "runtime.input",
        json!({"events": [
            {"kind": "mouse_button", "button": "left", "pressed": true, "position": [10, 10], "device": INJECTED_DEVICE},
            {"kind": "mouse_button", "button": "left", "pressed": false, "position": [10, 10], "device": INJECTED_DEVICE},
        ]}),
    );
    assert_eq!(click["applied"], 2, "press and release are both applied");
    assert_eq!(label_text(&session), "presses: 2 (mouse)");

    let pad = session.call(
        "runtime.input",
        json!({"events": [
            {"kind": "joypad_button", "button": 0, "pressed": true, "device": INJECTED_DEVICE},
            {"kind": "joypad_button", "button": 0, "pressed": false, "device": INJECTED_DEVICE},
        ]}),
    );
    assert_eq!(pad["applied"], 2, "press and release are both applied");
    assert_eq!(label_text(&session), "presses: 3 (gamepad)");

    assert!(
        session
            .error(
                "runtime.input",
                json!({"events": [{"kind": "key", "key": "NotAKey"}]})
            )
            .starts_with("unsupported_value"),
        "an unknown key must be refused by the helper, not injected"
    );
    assert!(
        session
            .error(
                "runtime.input",
                json!({"events": [{"kind": "key", "key": "G", "device": "keyboard"}]})
            )
            .starts_with("unsupported_value"),
        "a device that is not a number must be refused rather than coerced to 0, which is a device \
         the engine itself uses"
    );
    assert!(
        session
            .error("runtime.inspect_node", json!({"path": "/root/Nowhere"}))
            .starts_with("node_not_found")
    );

    // Performance monitors report from inside the game process.
    let monitors = session.call(
        "runtime.get_monitors",
        json!({"monitors": ["fps", "object_node_count"]}),
    );
    assert!(
        monitors["monitors"]["fps"].as_f64().expect("fps") >= 0.0,
        "fps must report: {monitors}"
    );
    assert!(
        monitors["monitors"]["object_node_count"]
            .as_f64()
            .expect("node count")
            > 0.0,
        "a running game has live nodes: {monitors}"
    );
    assert!(
        session
            .error("runtime.get_monitors", json!({"monitors": ["bogus"]}))
            .starts_with("unknown_monitor")
    );

    // Manual capture works on demand; the headless editor honestly refuses its own viewport.
    let capture = session.call("runtime.capture", json!({}));
    assert_frame(&capture["frame"]);
    assert!(
        session
            .error("runtime.capture", json!({"source": "editor"}))
            .starts_with("capture_unavailable"),
        "a headless editor has no viewport to capture"
    );

    // Restart replaces the process: the probe's state resets, proving the old game is gone.
    let restarted = session
        .request("runtime.restart", json!({}), LAUNCH_TIMEOUT_MS)
        .unwrap_or_else(|error| {
            panic!(
                "runtime.restart failed: {error}\n--- editor output ---\n{}",
                session.editor.output()
            )
        });
    assert_eq!(restarted["running"], true);
    assert_frame(&restarted["frame"]);
    assert_eq!(label_text(&session), "presses: 0 (none)");
    assert_eq!(
        await_event(&events, "runtime.ready")["protocolVersion"],
        2,
        "the replacement game announces itself too, over the same debugger session"
    );

    // Stop tears the helper down: readiness clears and inspection fails retryably again.
    let stopped = session.call("runtime.stop", json!({}));
    assert_eq!(stopped["running"], false);
    session.await_stopped();
    assert!(
        session
            .error("runtime.get_tree", json!({}))
            .starts_with("runtime_not_running"),
        "inspection after stop must fail before any debugger message is sent"
    );
}

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

use crate::godot_dap::{DapClient, MAIN_THREAD_ID};
use crate::godot_editor_harness::{self, PNG_BASE64_PREFIX, Session, Transports, free_port};
use crate::godot_rpc::{CallRequest, EventEnvelope};
use crate::protocol_v2::Readiness;
use serde_json::{Value, json};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::time::{Duration, Instant};
use tempfile::TempDir;

/// A launch is answered only after the game booted, its helper announced itself, and the first
/// frame was captured, so it gets a wider budget than an ordinary call.
const LAUNCH_TIMEOUT_MS: u64 = 60_000;
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
///
/// It also counts how often an injected event fired an Input Map *action*, which is a different
/// question from whether the event arrived. An event that arrives and matches no action leaves a
/// game standing still with nothing to say about it, and that is exactly what injected input did:
/// `project.set_input_action` binds on the physical key and the helper built events with only
/// `keycode`, so no action Gofer registered could ever be driven by input Gofer injected.
const PROBE_SCRIPT: &str = "extends Node2D\n\nconst INJECTED_DEVICE := 7777\nconst PROBE_ACTION := \"acceptance_probe_action\"\n\nvar presses := 0\nvar actions := 0\nvar last_source := \"none\"\nvar launch_args := \"\"\n\n@onready var label: Label = $Label\n\nfunc _ready() -> void:\n\tlaunch_args = \"|\".join(OS.get_cmdline_user_args())\n\t_refresh()\n\n# Only the test's own input counts. Anything the desktop delivers to this window carries a device\n# the engine assigned, never this one, so a stray keystroke cannot change the assertions.\nfunc _input(event: InputEvent) -> void:\n\tif InputMap.has_action(PROBE_ACTION) and event.is_action_pressed(PROBE_ACTION):\n\t\tactions += 1\n\tif event.device != INJECTED_DEVICE:\n\t\treturn\n\tif event is InputEventKey and event.pressed and not event.echo:\n\t\t_record(\"key\")\n\telif event is InputEventMouseButton and event.pressed:\n\t\t_record(\"mouse\")\n\telif event is InputEventJoypadButton and event.pressed:\n\t\t_record(\"gamepad\")\n\nfunc _record(source: String) -> void:\n\tpresses += 1\n\tlast_source = source\n\t_refresh()\n\nfunc _refresh() -> void:\n\tlabel.text = \"presses: %d (%s)\" % [presses, last_source]\n";

/// The fixture scene with the probe script attached. Written into the copied worktree: the
/// checked-in fixture deliberately stays free of scripts so the Node journeys see a project that
/// can never produce script output.
const PROBE_SCENE: &str = "[gd_scene load_steps=2 format=3]\n\n[ext_resource type=\"Script\" path=\"res://scripts/runtime_probe.gd\" id=\"1_probe\"]\n\n[node name=\"RuntimeProbe\" type=\"Node2D\"]\nscript = ExtResource(\"1_probe\")\n\n[node name=\"Label\" type=\"Label\" parent=\".\"]\noffset_right = 320.0\noffset_bottom = 40.0\n";

/// Copies the fixture project and turns it into a game the loop can observe: a main scene whose
/// probe script counts injected input in a Label.
fn worktree_with_probes(directory: &TempDir) -> PathBuf {
    let worktree = godot_editor_harness::fixture_worktree(directory);
    std::fs::create_dir_all(worktree.join("scripts")).expect("create scripts directory");
    std::fs::write(worktree.join("scripts/runtime_probe.gd"), PROBE_SCRIPT)
        .expect("write the probe script");
    std::fs::write(worktree.join("main.tscn"), PROBE_SCENE).expect("write the probe scene");
    worktree
}

/// A ready session editing the probe scene, on a worktree this suite prepared.
fn start_session() -> Session {
    let directory = TempDir::new().expect("temporary directory");
    let worktree = worktree_with_probes(&directory);
    let ledger = directory.path().join("ledger.json");
    Session::start_on_worktree(worktree, ledger, Some(directory))
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

/// The command line the running game was started with, as the probe read it back.
fn launch_args(session: &Session) -> String {
    let inspected = session.call(
        "runtime.inspect_node",
        json!({"path": "/root/RuntimeProbe", "properties": ["launch_args"]}),
    );
    inspected["properties"]["launch_args"]
        .as_object()
        .filter(|tagged| tagged["type"] == "string")
        .and_then(|tagged| tagged["value"].as_str())
        .unwrap_or_else(|| {
            panic!("the launch arguments must cross the wire as a tagged string: {inspected}")
        })
        .to_owned()
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

/// Reads one of the probe's own counters, which is a script variable on the running node.
fn probe_count(session: &Session, property: &str) -> i64 {
    let inspected = session.call(
        "runtime.inspect_node",
        json!({"path": "/root/RuntimeProbe", "properties": [property]}),
    );
    inspected["properties"][property]["value"]
        .as_i64()
        .unwrap_or_else(|| panic!("{property} must cross the wire as a number: {inspected}"))
}

#[test]
fn the_runtime_loop_drives_input_and_proves_it_with_tree_and_screenshots() {
    let mut session = start_session();
    let events = session.rpc().subscribe_events();

    session.call(
        "project.set_input_action",
        json!({"name": "acceptance_probe_action", "events": [{"kind": "key", "key": "F13"}]}),
    );

    session.await_session_view(Readiness::Ready, false);
    let state = session.call("runtime.get_state", json!({}));
    assert_eq!(state["running"], false);
    assert_eq!(state["runtimeReady"], false);
    assert!(
        session
            .error("runtime.get_tree", json!({}), None)
            .starts_with("runtime_not_running"),
        "inspection without a game must fail before any debugger message is sent"
    );

    let run = session
        .try_call_within("runtime.run", json!({}), LAUNCH_TIMEOUT_MS)
        .unwrap_or_else(|error| {
            panic!(
                "runtime.run failed: {error}\n--- editor output ---\n{}",
                session.output()
            )
        });
    assert_eq!(run["running"], true);
    assert_frame(&run["frame"]);
    session.await_session_view(Readiness::Ready, true);
    assert_eq!(
        await_event(&events, "runtime.ready")["protocolVersion"],
        2,
        "the helper announces itself to the session, not only to the launch that waited for it"
    );

    assert!(
        session
            .error("runtime.run", json!({}), None)
            .starts_with("already_running"),
        "a second launch must be refused while the game is up"
    );

    let tree = session.call("runtime.get_tree", json!({}));
    assert_eq!(tree["truncated"], false);
    assert_eq!(
        tree["paused"], false,
        "a game nobody paused reports the tree it actually has: {tree}"
    );
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

    let shallow = session.call("runtime.get_tree", json!({"depth": 0}));
    assert!(
        shallow["root"]["children"]
            .as_array()
            .expect("root children")
            .is_empty(),
        "depth 0 is the named node and nothing under it"
    );
    assert_eq!(shallow["truncated"], true, "the children were left out");
    let one = session.call("runtime.get_tree", json!({"limit": 1}));
    assert_eq!(one["truncated"], true, "a budget of one cannot hold a tree");
    let probe = session.call("runtime.get_tree", json!({"root": "/root/RuntimeProbe"}));
    assert_eq!(probe["root"]["name"], "RuntimeProbe");
    assert!(
        session
            .error("runtime.get_tree", json!({"root": "/root/Nowhere"}), None)
            .starts_with("node_not_found"),
        "a root the game does not hold is named rather than answered with an empty tree"
    );

    let waited = session.call("runtime.wait", json!({"frames": 5}));
    assert_eq!(waited["frames"], 5, "{waited}");
    let timed = session.call("runtime.wait", json!({"ms": 120}));
    assert!(
        timed["ms"].as_i64().expect("a wait reports its duration") >= 120,
        "a wait named in milliseconds has to last them: {timed}"
    );
    let capped = session.call("runtime.wait", json!({"frames": 100_000, "ms": 150}));
    assert!(
        capped["frames"].as_i64().expect("frames") < 100_000,
        "the duration has to end a frame count it outlives: {capped}"
    );

    let rate = session.call("runtime.wait", json!({"ms": 500}));
    assert!(
        rate["frames"].as_i64().expect("frames") > 5,
        "half a second of game time has to be more than a handful of frames, or the game under \
         test is not running: {rate}"
    );

    let playing = session.error(
        "node.create",
        json!({"parent": "/RuntimeProbe", "name": "Late", "type": "Marker2D"}),
        None,
    );
    assert!(
        playing.starts_with("session_playing"),
        "a mutation during play must be refused as such: {playing}"
    );
    assert!(
        playing.contains("godot_runtime stop"),
        "the refusal has to name the call that clears it: {playing}"
    );

    assert_eq!(label_text(&session), "presses: 0 (none)");

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
    let bound = session.call(
        "runtime.input",
        json!({"events": [
            {"kind": "key", "key": "F13", "pressed": true},
            {"kind": "key", "key": "F13", "pressed": false},
        ]}),
    );
    assert_eq!(bound["applied"], 2);
    assert_eq!(
        probe_count(&session, "actions"),
        1,
        "an injected key must fire the Input Map action bound to that key, or a level built with \
         these tools cannot be played by them"
    );

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

    let unspelled = session.call(
        "runtime.input",
        json!({"events": [
            {"kind": "mouse_button", "button": "left", "position": [10, 10], "device": INJECTED_DEVICE},
            {"kind": "mouse_button", "button": "left", "position": [10, 10], "device": INJECTED_DEVICE},
        ]}),
    );
    assert_eq!(unspelled["applied"], 2, "both events are still injected");
    assert_eq!(
        label_text(&session),
        "presses: 3 (mouse)",
        "an event that does not spell `pressed` is the press and then the release, not two presses"
    );

    let pad = session.call(
        "runtime.input",
        json!({"events": [
            {"kind": "joypad_button", "button": 0, "pressed": true, "device": INJECTED_DEVICE},
            {"kind": "joypad_button", "button": 0, "pressed": false, "device": INJECTED_DEVICE},
        ]}),
    );
    assert_eq!(pad["applied"], 2, "press and release are both applied");
    assert_eq!(label_text(&session), "presses: 4 (gamepad)");

    assert!(
        session
            .error(
                "runtime.input",
                json!({"events": [{"kind": "key", "key": "NotAKey"}]}),
                None,
            )
            .starts_with("unsupported_value"),
        "an unknown key must be refused by the helper, not injected"
    );
    let no_monitor = session.error(
        "runtime.get_monitors",
        json!({"monitors": ["frames_per_second"]}),
        None,
    );
    assert!(
        no_monitor.contains("The monitors are") && no_monitor.contains("fps"),
        "the refusal has to name the monitors there are: {no_monitor}"
    );

    let unnamed = session.error(
        "runtime.input",
        json!({"events": [{"kind": "mouse_button", "button": "1", "position": [4, 4]}]}),
        None,
    );
    assert!(
        unnamed.contains("left") && unnamed.contains("wheel_up") && unnamed.contains("as a number"),
        "the refusal has to name the buttons there are: {unnamed}"
    );
    for (sent, expected) in [
        (
            json!({"events": [{"key": "A"}]}),
            "An input event needs a kind",
        ),
        (
            json!({"events": [{"kind": "keyboard", "key": "A"}]}),
            "is not one of",
        ),
    ] {
        let refused = session.error("runtime.input", sent, None);
        assert!(refused.contains(expected), "{refused}");
        for named in [
            "key",
            "mouse_button",
            "mouse_motion",
            "joypad_button",
            "joypad_motion",
        ] {
            assert!(
                refused.contains(named),
                "the refusal must name {named}: {refused}"
            );
        }
    }
    assert!(
        session
            .error(
                "runtime.input",
                json!({"events": [{"kind": "key", "key": "G", "device": "keyboard"}]}),
                None,
            )
            .starts_with("unsupported_value"),
        "a device that is not a number must be refused rather than coerced to 0, which is a device \
         the engine itself uses"
    );
    assert!(
        session
            .error(
                "runtime.inspect_node",
                json!({"path": "/root/Nowhere"}),
                None
            )
            .starts_with("node_not_found")
    );

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
            .error("runtime.get_monitors", json!({"monitors": ["bogus"]}), None)
            .starts_with("unknown_monitor")
    );

    let capture = session.call("runtime.capture", json!({}));
    assert_frame(&capture["frame"]);
    assert!(
        session
            .error("runtime.capture", json!({"source": "editor"}), None)
            .starts_with("capture_unavailable"),
        "a headless editor has no viewport to capture"
    );

    let restarted = session
        .try_call_within("runtime.restart", json!({}), LAUNCH_TIMEOUT_MS)
        .unwrap_or_else(|error| {
            panic!(
                "runtime.restart failed: {error}\n--- editor output ---\n{}",
                session.output()
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

    let stopped = session.call("runtime.stop", json!({}));
    assert_eq!(stopped["running"], false);
    session.await_stopped();
    session.await_session_view(Readiness::Ready, false);
    assert!(
        session
            .error("runtime.get_tree", json!({}), None)
            .starts_with("runtime_not_running"),
        "inspection after stop must fail before any debugger message is sent"
    );

    session.kill_editor();
    session.await_session_view(Readiness::Starting, false);
}

/// The script for the game that will not be asked nicely: it binds a port so its liveness is
/// observable from outside, then spins its main thread solid so the editor's stop request can
/// never be answered and the process has to be killed instead.
///
/// The spin is armed from the scene's own first frame, not from the engine's start. It was
/// `Time.get_ticks_msec() > 4000`, counted from engine start, so the game's boot was spent against
/// it: under a second alone and about four beside nine other editors, and the spin then began on
/// the same frame the helper announced — before the launch's first-frame capture could be served.
/// Counting frames instead fixed that and broke the other end, because a frame is not a fixed
/// length either: at ten editors the game drew slowly enough that a hundred and twenty frames
/// outlasted the six seconds this test waits, and the stop below then reached a game that was
/// still answering. Two seconds of the scene running is long after the capture and long before the
/// wait ends, on a loaded machine and an idle one.
fn unkillable_probe_script(port: u16) -> String {
    format!(
        "extends Node2D\n\nvar server := TCPServer.new()\nvar running_since := 0\n\nfunc _ready() -> void:\n\tserver.listen({port}, \"127.0.0.1\")\n\nfunc _process(_delta: float) -> void:\n\tif running_since == 0:\n\t\trunning_since = Time.get_ticks_msec()\n\tif Time.get_ticks_msec() - running_since > 2000:\n\t\twhile true:\n\t\t\tpass\n"
    )
}

/// Whether the game's port has been let go, which is how these tests ask "is the process gone?".
///
/// A listening socket is bound for exactly as long as the process lives, so on Linux and macOS this
/// answers on the first attempt or not at all: the game is reaped before the stop is answered, and
/// any wait here would hide the asynchronous stop the assertion exists to catch. The budget below
/// is zero on both.
///
/// Windows reaps asynchronously, and that is an operating-system fact rather than a contract Gofer
/// can hold. The kill returns once it is scheduled; the kernel closes the process's handles, its
/// sockets among them, during a teardown that runs afterwards. So the port outlives a stop the
/// editor answered truthfully, by a few milliseconds, and `stopping_the_game_answers_only_once_the_game_is_gone`
/// and `a_call_that_was_waiting_for_a_frame_says_so` were the two nightly Windows reds that came of
/// it — never on Linux, never on macOS, and never on the contract they were written to check.
///
/// Two seconds is a teardown window, not a retry loop for a stop that did not happen. A game still
/// running holds its port for every one of those milliseconds and the assertion still fails; what
/// the window cannot do is turn a red into a green, only a flake into an answer.
fn port_released(port: u16) -> bool {
    let budget = if cfg!(windows) {
        Duration::from_secs(2)
    } else {
        Duration::ZERO
    };
    let deadline = std::time::Instant::now() + budget;
    loop {
        if std::net::TcpListener::bind(("127.0.0.1", port)).is_ok() {
            return true;
        }
        if std::time::Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

/// A game that holds a port for as long as its process lives, and nothing else.
///
/// The spinning probe above proves a stop is synchronous; this one asks a different question — who
/// is left running — so it must not be wedged. It binds and waits.
fn port_holding_probe_script(port: u16) -> String {
    format!(
        "extends Node2D\n\nvar server := TCPServer.new()\n\nfunc _ready() -> void:\n\tserver.listen({port}, \"127.0.0.1\")\n"
    )
}

/// An editor asked to quit takes the game it launched with it.
///
/// The failure this pins was found by two Godot games still running on this machine 4.8 hours
/// after the acceptance run that started them, holding worktrees that had already been deleted.
/// `--editor-pid` is a hint about which window to embed in, not a lifetime: measured against the
/// pinned 4.7.2, a game whose editor had gone was still holding a port it bound in `_ready`
/// ninety seconds later — on the editor's own `get_tree().quit()`, which is the path
/// [`crate::godot_session::stop`] takes and the path closing Gofer takes with it.
///
/// The port is the question rather than a process table: a listening socket is bound for exactly
/// as long as the process lives, so binding it here is a direct "is the game gone?".
///
/// What this cannot cover is the kill. An editor that will not answer is killed, and an addon in a
/// killed editor stops nothing; that path needs Gofer to know the game's own pid and is recorded
/// rather than asserted here.
#[test]
fn quitting_the_editor_takes_the_game_with_it() {
    let directory = TempDir::new().expect("temporary directory");
    let worktree = godot_editor_harness::fixture_worktree(&directory);
    let port = free_port();
    std::fs::create_dir_all(worktree.join("scripts")).expect("create scripts directory");
    std::fs::write(
        worktree.join("scripts/runtime_probe.gd"),
        port_holding_probe_script(port),
    )
    .expect("write the probe script");
    std::fs::write(worktree.join("main.tscn"), PROBE_SCENE).expect("write the probe scene");
    let ledger = directory.path().join("ledger.json");
    let mut session = Session::start_on_worktree(worktree, ledger, Some(directory));

    session
        .try_call_within("runtime.run", json!({}), LAUNCH_TIMEOUT_MS)
        .unwrap_or_else(|error| {
            panic!(
                "runtime.run failed: {error}\n--- editor output ---\n{}",
                session.output()
            )
        });
    assert!(
        std::net::TcpListener::bind(("127.0.0.1", port)).is_err(),
        "the game must be holding its port before the editor is asked to quit"
    );

    session.quit_editor();

    assert!(
        port_released(port),
        "the game outlived the editor that launched it: port {port} is still held"
    );
}

/// A call that was waiting for a frame says so, instead of blaming the clock.
///
/// The failure this pins cost one live turn **nine timeouts of twenty seconds each** — 180 seconds
/// of a 1468-second run — against a game its own `get_state` described as
/// `broke: false, running: true, runtimeReady: true`, and whose `inspect_node` answered in 49ms
/// between two of them. The game was alive and not drawing. `input`, `capture` and `wait` are the
/// three operations that cannot answer until it does; every other one is served straight out of
/// the debugger message pump, which the main loop polls whether the game is drawing or not.
///
/// "The game did not answer in time" reads as a slow game, and two separate live turns worked the
/// asymmetry out for themselves — "`input`/`wait` timed out while `inspect` kept answering" — at
/// the cost of the turn. The sentence now names it, and names the two calls that tell a halted
/// game from a wedged one rather than asserting which this is.
///
/// The probe spins its main thread, so nothing in the game can answer and the deadline is the only
/// way out. That deadline is four seconds here rather than twenty, for the reason the launch one
/// is shortened the same way: watching a request expire is the whole cost of the test.
#[test]
fn a_call_that_was_waiting_for_a_frame_says_so() {
    let directory = TempDir::new().expect("temporary directory");
    let worktree = godot_editor_harness::fixture_worktree(&directory);
    let port = free_port();
    std::fs::create_dir_all(worktree.join("scripts")).expect("create scripts directory");
    std::fs::write(
        worktree.join("scripts/runtime_probe.gd"),
        unkillable_probe_script(port),
    )
    .expect("write the probe script");
    std::fs::write(worktree.join("main.tscn"), PROBE_SCENE).expect("write the probe scene");
    let ledger = directory.path().join("ledger.json");
    let session = Session::start_on_worktree_with(
        worktree,
        ledger,
        Some(directory),
        Transports {
            request_timeout_ms: Some(4_000),
            ..Transports::default()
        },
    );
    session
        .try_call_within("runtime.run", json!({}), LAUNCH_TIMEOUT_MS)
        .expect("the game must launch");
    std::thread::sleep(Duration::from_secs(6));

    let refused = session
        .try_call(
            "runtime.input",
            json!({"events": [{"kind": "key", "key": "A", "pressed": true}]}),
            None,
        )
        .expect_err("a game that cannot draw cannot answer an input");
    assert!(
        refused.starts_with("runtime_timeout"),
        "the deadline is what must answer, not the transport: {refused}"
    );
    assert!(
        refused.contains("draws a frame") || refused.contains("draw a frame"),
        "a frame-awaiting call must say what it was waiting for: {refused}"
    );
    assert!(
        refused.contains("inspect_node") && refused.contains("get_tree"),
        "the refusal must name the calls that answer without a frame: {refused}"
    );
    assert!(
        !refused.contains("A game halted in the debugger"),
        "the addon cannot know a debugger is holding this game: {refused}"
    );
    assert!(
        refused.contains("If the debugger is holding it"),
        "and it offers the debugger as a thing to check: {refused}"
    );

    let answered = session
        .try_call("runtime.get_tree", json!({}), None)
        .expect("a call that needs no frame answers even here");
    assert_eq!(
        answered["root"]["name"], "root",
        "the frame-free call must answer with the real tree: {answered}"
    );

    session
        .try_call("runtime.stop", json!({}), None)
        .expect("the wedged game must be stopped rather than left running");
    assert!(
        port_released(port),
        "the spinning probe must be gone, not merely asked to go"
    );
}

/// `runtime.stop` answers `running: false`, and the game really is gone by then.
///
/// This is the one command in the addon that used to *assert* its answer rather than read one
/// back: `{"running": false}` was a literal, written on the frame the stop was asked for, with
/// nothing checking whether the editor agreed. That is the shape of every bug this suite has
/// found at the Godot boundary — an answer describing something the editor has not done yet.
///
/// The race was hunted and never observed. `EditorInterface.stop_playing_scene()` in the pinned
/// 4.7.2 kills the game on the calling frame: probes with a three-second `_exit_tree`, with a
/// per-frame heartbeat file, stopping at eight points across the boot, and bursting stop straight
/// after run all found `is_playing_scene()` already false and the process already reaped. So
/// there is no red-to-green step here to watch, and this test does not pretend otherwise.
///
/// What it does instead is assert the contract rather than the implementation, on the game the
/// editor has the least control over. A game spinning its main thread cannot answer the debugger,
/// so the editor must kill it; the game's listening port is bound for exactly as long as the
/// process lives, so binding that port ourselves the moment the response arrives is a direct
/// question — is the game gone? — that an engine with an asynchronous stop would answer "no" to.
#[test]
fn stopping_the_game_answers_only_once_the_game_is_gone() {
    let directory = TempDir::new().expect("temporary directory");
    let worktree = godot_editor_harness::fixture_worktree(&directory);
    let port = godot_editor_harness::free_port();
    std::fs::create_dir_all(worktree.join("scripts")).expect("create scripts directory");
    std::fs::write(
        worktree.join("scripts/runtime_probe.gd"),
        unkillable_probe_script(port),
    )
    .expect("write the probe script");
    std::fs::write(worktree.join("main.tscn"), PROBE_SCENE).expect("write the probe scene");
    let ledger = directory.path().join("ledger.json");
    let session = Session::start_on_worktree(worktree, ledger, Some(directory));

    session
        .try_call_within("runtime.run", json!({}), LAUNCH_TIMEOUT_MS)
        .unwrap_or_else(|error| {
            panic!(
                "runtime.run failed: {error}\n--- editor output ---\n{}",
                session.output()
            )
        });
    let held = std::net::TcpListener::bind(("127.0.0.1", port));
    assert!(
        held.is_err(),
        "the game must be holding its port before the stop is asked for"
    );
    std::thread::sleep(Duration::from_secs(6));

    let stopped = session.call("runtime.stop", json!({}));
    assert_eq!(stopped["running"], false, "{stopped}");
    assert!(
        port_released(port),
        "runtime.stop answered `running: false` while the game still held its port\n--- editor output ---\n{}",
        session.output()
    );
    let state = session.call("runtime.get_state", json!({}));
    assert_eq!(state["running"], false, "{state}");
    assert_eq!(state["runtimeReady"], false, "{state}");
}

/// The main scene's script carries the Godot 3 name a model reaches for. It does not parse, so the
/// scene it is attached to cannot load, and the game the editor launched stops at that error.
const UNPARSABLE_PROBE_SCRIPT: &str = "extends Node2D\n\nfunc _ready() -> void:\n\tvar points := PoolVector2Array()\n\tprint(points)\n";

/// A game paused at an error answers the launch that started it, instead of the clock answering.
///
/// This is the failure the whole loop was blind to, and it is the everyday one: a script that does
/// not parse. The game is launched, Godot's debugger stops it on the error, and it sits there —
/// process alive, `is_playing_scene()` still true, window on screen, nothing forthcoming. The
/// helper never announces, because a scene that breaks while loading breaks before it can. Nothing
/// in the addon watched the break, so the launch sat in the pending list on its deadline alone,
/// spent the full budget, and answered `runtime_timeout: The game did not answer in time` — a
/// sentence about a slow game, for a game that had stopped at an error half a minute earlier. An
/// agent reads that as "wait longer", and waits.
/// One scene can be run without making it the project's entry point.
///
/// One live turn took the only route that was open: it wrote `application/run/main_scene` to the
/// scene it wanted, ran, and wrote it back — two calls of detour, and a window in which the
/// project boots into a test scene. `play_custom_scene` is the editor's own F6 and is what "run
/// this scene" means.
#[test]
fn a_named_scene_runs_without_becoming_the_project_entry_point() {
    let directory = TempDir::new().expect("temporary directory");
    let worktree = worktree_with_probes(&directory);
    std::fs::write(
        worktree.join("other.tscn"),
        "[gd_scene format=3]\n\n[node name=\"OtherScene\" type=\"Node2D\"]\n",
    )
    .expect("write the other scene");
    let ledger = directory.path().join("ledger.json");
    let session = Session::start_on_worktree(worktree, ledger, Some(directory));

    let run = session
        .try_call_within(
            "runtime.run",
            json!({"scene": "res://other.tscn"}),
            LAUNCH_TIMEOUT_MS,
        )
        .unwrap_or_else(|error| {
            panic!(
                "runtime.run on a named scene failed: {error}\n--- editor output ---\n{}",
                session.output()
            )
        });
    assert_eq!(run["running"], true);
    assert_frame(&run["frame"]);

    let running = session.call("runtime.get_tree", json!({}));
    assert!(
        running.to_string().contains("OtherScene"),
        "the named scene must be the one running: {running}"
    );
    let settings = session.call("project.get_settings", json!({}));
    assert_eq!(
        settings["mainScene"], "res://main.tscn",
        "running one scene must not rewrite the project's entry point: {settings}"
    );

    let restarted = session
        .try_call_within("runtime.restart", json!({}), LAUNCH_TIMEOUT_MS)
        .unwrap_or_else(|error| panic!("runtime.restart failed: {error}"));
    assert_eq!(restarted["running"], true);
    let again = session.call("runtime.get_tree", json!({}));
    assert!(
        again.to_string().contains("OtherScene"),
        "a restart must restart the scene that was running: {again}"
    );

    session.call("runtime.stop", json!({}));
    let refused = session.error("runtime.run", json!({"scene": "res://nope.tscn"}), None);
    assert!(
        refused.starts_with("scene_not_found") && refused.contains("nope.tscn"),
        "a scene that does not exist must be refused by name: {refused}"
    );
}

/// The command line a caller asks for reaches the game, survives a restart, and is not written
/// down.
///
/// Neither `play_custom_scene` nor `play_main_scene` takes arguments, so the only route is the
/// `editor/run/main_run_args` project setting. That is a setting a person owns: an agent running a
/// scene must not leave it changed, and must not add a line to `project.godot` that was not there.
#[test]
fn a_run_carries_a_command_line_to_the_game_without_writing_it_down() {
    let directory = TempDir::new().expect("temporary directory");
    let worktree = worktree_with_probes(&directory);
    let project = worktree.join("project.godot");
    let ledger = directory.path().join("ledger.json");
    let session = Session::start_on_worktree(worktree, ledger, Some(directory));
    // After the session, not before: enabling the addon is its own write to project.godot.
    let before = std::fs::read_to_string(&project).expect("read project.godot");

    let run = session
        .try_call_within(
            "runtime.run",
            json!({"playArgs": ["--", "--rate=30", "--seconds=15"]}),
            LAUNCH_TIMEOUT_MS,
        )
        .unwrap_or_else(|error| {
            panic!(
                "runtime.run with playArgs failed: {error}\n--- editor output ---\n{}",
                session.output()
            )
        });
    assert_eq!(run["running"], true);
    assert_eq!(
        launch_args(&session),
        "--rate=30|--seconds=15",
        "the game must receive what the caller asked for, after the `--` it wrote"
    );

    let restarted = session
        .try_call_within("runtime.restart", json!({}), LAUNCH_TIMEOUT_MS)
        .unwrap_or_else(|error| panic!("runtime.restart failed: {error}"));
    assert_eq!(restarted["running"], true);
    assert_eq!(
        launch_args(&session),
        "--rate=30|--seconds=15",
        "a restart must restart the command line that was running"
    );

    session.call("runtime.stop", json!({}));
    session
        .try_call_within("runtime.run", json!({}), LAUNCH_TIMEOUT_MS)
        .expect("a run with no playArgs");
    assert_eq!(
        launch_args(&session),
        "",
        "a run that asks for no arguments must not inherit the last one's"
    );

    // The editor carries the command line as one string it splits on spaces, and measured on 4.7.2
    // it groups on double quotes without ever removing them. A spaced argument has no spelling that
    // arrives whole, so it is named rather than delivered in halves.
    let refused = session
        .try_call_within(
            "runtime.run",
            json!({"playArgs": ["--", "--level=Boss Fight"]}),
            LAUNCH_TIMEOUT_MS,
        )
        .expect_err("an argument that cannot survive the trip must be refused");
    assert!(
        refused.to_string().contains("cannot hold a space"),
        "{refused}"
    );

    session.call("runtime.stop", json!({}));
    let after = std::fs::read_to_string(&project).expect("read project.godot");
    assert!(
        !after.contains("main_run_args"),
        "running a game must not write the run arguments down: {after}"
    );
    assert_eq!(
        after, before,
        "running a game must not rewrite project.godot"
    );
}

#[test]
fn a_game_that_stops_at_an_error_ends_the_launch_waiting_on_it() {
    let directory = TempDir::new().expect("temporary directory");
    let worktree = godot_editor_harness::fixture_worktree(&directory);
    std::fs::create_dir_all(worktree.join("scripts")).expect("create scripts directory");
    std::fs::write(
        worktree.join("scripts/runtime_probe.gd"),
        UNPARSABLE_PROBE_SCRIPT,
    )
    .expect("write the probe script");
    std::fs::write(worktree.join("main.tscn"), PROBE_SCENE).expect("write the probe scene");
    let ledger = directory.path().join("ledger.json");
    let session = Session::start_on_worktree(worktree, ledger, Some(directory));

    let started = Instant::now();
    let error = session
        .try_call_within("runtime.run", json!({}), LAUNCH_TIMEOUT_MS)
        .expect_err("a game stopped at an error must not answer as launched");
    let waited = started.elapsed();

    assert!(
        !error.starts_with("runtime_timeout"),
        "the launch expired on its deadline instead of noticing the break: {error}\n\
         --- editor output ---\n{}",
        session.output()
    );
    assert!(
        error.starts_with("runtime_broke"),
        "a game paused at an error must say so, because every other answer sends the caller back \
         to waiting: {error}\n--- editor output ---\n{}",
        session.output()
    );
    assert!(
        waited < Duration::from_secs(20),
        "the failure took {waited:?}, which is the deadline rather than the break"
    );

    let state = session.call("runtime.get_state", json!({}));
    assert_eq!(state["broke"], true, "{state}");
    assert_eq!(state["runtimeReady"], false, "{state}");

    let forwarded = Instant::now();
    let refused = session
        .try_call("runtime.get_tree", json!({}), None)
        .expect_err("a paused game cannot answer a forwarded request");
    assert!(
        refused.starts_with("runtime_broke") || refused.starts_with("runtime_not_running"),
        "a forwarded request must be refused for the reason it cannot be served: {refused}"
    );
    assert!(
        forwarded.elapsed() < Duration::from_secs(10),
        "the refusal waited {:?}, which is a deadline rather than an answer",
        forwarded.elapsed()
    );

    let stopped = session.call("runtime.stop", json!({}));
    assert_eq!(stopped["running"], false, "{stopped}");
    session.await_stopped();
    let after = session.call("runtime.get_state", json!({}));
    assert_eq!(after["broke"], false, "{after}");
}

/// The deadline this test gives the editor, in place of the thirty seconds it ships with.
///
/// This is the only test whose subject is the deadline expiring, so it is the only one that has to
/// sit through one. At thirty seconds it was the acceptance suite's floor — hoisted to run first
/// because nothing could follow it, and still the last worker to finish. Four seconds proves the
/// same thing: the game is up, its helper is not, and the editor says so rather than calling the
/// game dead. What is being asserted is which answer comes back, not how long it took.
const STALL_LAUNCH_TIMEOUT_MS: u64 = 4_000;

/// An autoload that holds the main thread past the launch deadline without ever letting go of the
/// process, which is what a game whose helper cannot load looks like from the editor: playing, and
/// silent. A parse error in the addon's own runtime script produces exactly this.
///
/// Fifteen seconds is the shortened deadline plus room for the two calls that follow it. It is also
/// the fallback: the process leaves on its own if the stop below cannot reach a main thread that is
/// inside a `delay_msec`.
const STALLING_AUTOLOAD: &str = "extends Node\n\nfunc _ready() -> void:\n\tOS.delay_msec(15000)\n";

/// A launch that outlives its deadline while the editor is still playing says the game is up.
///
/// The opposite failure to the one above, and told apart from it on purpose. A live project met
/// this nine times in one task; six were followed by a `get_state` reporting `running: true,
/// runtimeReady: true` about the game the timeout had just described as unresponsive. The agent
/// read "did not answer in time" as "dead", stopped the game and ran it again — twice throwing away
/// a game that was working, at half a minute a cycle.
#[test]
fn a_launch_that_outlives_its_deadline_while_playing_says_the_game_is_up() {
    let directory = TempDir::new().expect("temporary directory");
    let worktree = godot_editor_harness::fixture_worktree(&directory);
    std::fs::create_dir_all(worktree.join("scripts")).expect("create scripts directory");
    std::fs::write(worktree.join("scripts/stall.gd"), STALLING_AUTOLOAD)
        .expect("write the autoload");
    let project = worktree.join("project.godot");
    let configured = std::fs::read_to_string(&project).expect("read the fixture project")
        + "\n[autoload]\n\nStall=\"*res://scripts/stall.gd\"\n";
    std::fs::write(&project, configured).expect("write the project");
    let ledger = directory.path().join("ledger.json");
    let session = Session::start_on_worktree_with(
        worktree,
        ledger,
        Some(directory),
        Transports {
            launch_timeout_ms: Some(STALL_LAUNCH_TIMEOUT_MS),
            ..Transports::default()
        },
    );

    let error = session
        .try_call_within("runtime.run", json!({}), LAUNCH_TIMEOUT_MS)
        .expect_err("a helper that never announces must not answer as launched");

    assert!(
        error.starts_with("runtime_slow_start"),
        "a game the editor is still playing must not be reported as one that did not answer: \
         {error}\n--- editor output ---\n{}",
        session.output()
    );
    assert!(
        error.contains("get_state"),
        "the failure has to name the call that reads the state instead of another launch: {error}"
    );

    let state = session.call("runtime.get_state", json!({}));
    assert_eq!(state["running"], true, "{state}");
    assert_eq!(state["runtimeReady"], false, "{state}");

    session.call("runtime.stop", json!({}));
}

/// A probe that moves every frame, so a frozen game is one whose position stops changing.
const MOVING_PROBE_SCRIPT: &str =
    "extends Node2D\n\n\nfunc _process(delta: float) -> void:\n\tposition.x += 240.0 * delta\n";

/// The scene for it.
const MOVING_PROBE_SCENE: &str = "[gd_scene load_steps=2 format=3]\n\n[ext_resource type=\"Script\" path=\"res://scripts/runtime_probe.gd\" id=\"1_probe\"]\n\n[node name=\"RuntimeProbe\" type=\"Node2D\"]\nscript = ExtResource(\"1_probe\")\n";

/// A running game can be frozen and read, and the helper keeps answering while it is.
///
/// The gap this closes was found by a live turn building a shooter. A path into a running game is
/// stale as soon as the node it names is freed, and a bullet is freed within a frame or two of the
/// `get_tree` that reported it: the turn was answered `No running node at '/root/Main/@Area2D@19'`
/// six times. It reached for the debugger to freeze the game instead, and a `pause` there is not a
/// break — no stack, and an `evaluate` that times out. So it **added a debug property to the game
/// it was building** to have something that stood still, which is a tool gap solved in the wrong
/// place.
///
/// The two halves that make this work at all are asserted, not assumed: that the tree really stops
/// moving, and that `wait` and `inspect_node` still answer while it is stopped — the helper sets
/// its own `process_mode` to `ALWAYS` for exactly that reason, and a pause that silenced it would
/// look like a hung game.
#[test]
fn a_running_game_can_be_frozen_and_read_and_let_go_again() {
    let directory = TempDir::new().expect("temporary directory");
    let worktree = godot_editor_harness::fixture_worktree(&directory);
    std::fs::create_dir_all(worktree.join("scripts")).expect("create scripts directory");
    std::fs::write(
        worktree.join("scripts/runtime_probe.gd"),
        MOVING_PROBE_SCRIPT,
    )
    .expect("write the probe script");
    std::fs::write(worktree.join("main.tscn"), MOVING_PROBE_SCENE).expect("write the scene");
    let ledger = directory.path().join("ledger.json");
    let session = Session::start_on_worktree(worktree, ledger, Some(directory));

    session
        .try_call_within("runtime.run", json!({}), LAUNCH_TIMEOUT_MS)
        .unwrap_or_else(|error| panic!("runtime.run failed: {error}\n{}", session.output()));

    let where_it_is = |session: &Session| -> f64 {
        session.call(
            "runtime.inspect_node",
            json!({"path": "/root/RuntimeProbe", "properties": ["position"]}),
        )["properties"]["position"]["value"][0]
            .as_f64()
            .expect("an x")
    };

    let started = where_it_is(&session);
    session.call("runtime.wait", json!({"frames": 20}));
    let moved = where_it_is(&session);
    assert!(
        moved > started,
        "the probe must be moving: {started} {moved}"
    );

    let stopped = session.call("runtime.pause", json!({}));
    assert_eq!(stopped["paused"], true, "{stopped}");
    let held = where_it_is(&session);
    session.call("runtime.wait", json!({"frames": 20}));
    assert!(
        (where_it_is(&session) - held).abs() < 0.001,
        "a paused game must not move: {held}"
    );
    assert_eq!(
        session.call("runtime.get_tree", json!({"limit": 4}))["paused"],
        true
    );

    let photographed = session.call("runtime.capture", json!({}));
    assert_eq!(
        photographed["frame"]["encoding"], "png-base64",
        "{photographed}"
    );
    assert!(
        photographed["frame"]["data"]
            .as_str()
            .is_some_and(|data| !data.is_empty()),
        "a paused game still renders: {photographed}"
    );
    assert!(
        photographed["frame"]["width"].as_u64().unwrap_or(0) > 0,
        "{photographed}"
    );

    let injected = session.call(
        "runtime.input",
        json!({"events": [{"kind": "key", "key": "Right", "pressed": true}]}),
    );
    assert_eq!(injected["applied"], 1, "{injected}");
    assert!(
        (where_it_is(&session) - held).abs() < 0.001,
        "a paused game must not move for input either: {held}"
    );

    assert_eq!(session.call("runtime.resume", json!({}))["paused"], false);
    session.call("runtime.wait", json!({"frames": 20}));
    assert!(
        where_it_is(&session) > held,
        "a resumed game must move again: {held}"
    );

    session.call("runtime.stop", json!({}));
}

/// A probe that joins a group in `_ready`, which is how half of a game's groups are joined.
const GROUPING_PROBE_SCRIPT: &str = "extends Node2D\n\nfunc _ready() -> void:\n\tadd_to_group(\"coins\")\n\tadd_to_group(\"_private\")\n";

/// The scene for it, with nothing in the file about any group.
const GROUPING_PROBE_SCENE: &str = "[gd_scene load_steps=2 format=3]\n\n[ext_resource type=\"Script\" path=\"res://scripts/runtime_probe.gd\" id=\"1_probe\"]\n\n[node name=\"RuntimeProbe\" type=\"Node2D\"]\nscript = ExtResource(\"1_probe\")\n";

/// `runtime.inspect_node` answers the groups a running node is in, without being asked.
///
/// A live turn wanted to know whether a coin it had put in `coin` was still in it once the game was
/// up. It wrote `inspect_node {properties: ["groups"]}` — `groups` is the word `node.inspect`
/// answers with — and was told `Node '/root/Main/Coin' has no property 'groups'`. True, and
/// useless: a group is not a property, and there was no way to ask for one.
///
/// The two sides genuinely disagree, which is why reading the scene instead is not the answer: a
/// script's `add_to_group` in `_ready` is invisible to the edited scene and is how half of a game's
/// groups are joined. Both halves are asserted here, on the same node at the same moment.
///
/// The refusal at the end of it is the other half of the same question — what a path into a running
/// game means. A node the engine named itself is one instance of something a spawner made, and a
/// path to one is stale as soon as it is freed.
#[test]
fn a_running_node_answers_its_groups_and_a_path_the_engine_named_says_why_it_is_gone() {
    let directory = TempDir::new().expect("temporary directory");
    let worktree = godot_editor_harness::fixture_worktree(&directory);
    std::fs::create_dir_all(worktree.join("scripts")).expect("create scripts directory");
    std::fs::write(
        worktree.join("scripts/runtime_probe.gd"),
        GROUPING_PROBE_SCRIPT,
    )
    .expect("write the probe script");
    std::fs::write(worktree.join("main.tscn"), GROUPING_PROBE_SCENE).expect("write the scene");
    let ledger = directory.path().join("ledger.json");
    let session = Session::start_on_worktree(worktree, ledger, Some(directory));

    session
        .try_call_within("runtime.run", json!({}), LAUNCH_TIMEOUT_MS)
        .unwrap_or_else(|error| panic!("runtime.run failed: {error}\n{}", session.output()));

    let inspected = session.call(
        "runtime.inspect_node",
        json!({"path": "/root/RuntimeProbe", "properties": ["position"]}),
    );
    let groups: Vec<&str> = inspected["groups"]
        .as_array()
        .unwrap_or_else(|| panic!("runtime.inspect_node answered no groups: {inspected}"))
        .iter()
        .filter_map(Value::as_str)
        .collect();
    assert_eq!(groups, vec!["coins"], "{inspected}");

    assert_eq!(
        inspected["properties"]["position"]["type"], "vector2",
        "{inspected}"
    );

    let authored = session.call("node.inspect", json!({"node": "/RuntimeProbe"}));
    assert_eq!(authored["groups"], json!([]), "{authored}");

    let refused = session
        .try_call(
            "runtime.inspect_node",
            json!({"path": "/root/RuntimeProbe/@Area2D@19", "properties": ["position"]}),
            None,
        )
        .expect_err("a node that is not there must be refused");
    assert!(refused.contains("node_not_found"), "{refused}");
    assert!(
        refused.contains("the engine's own for a node nobody named"),
        "{refused}"
    );

    let plain = session
        .try_call(
            "runtime.inspect_node",
            json!({"path": "/root/RuntimeProbe/Bullet", "properties": ["position"]}),
            None,
        )
        .expect_err("a node that is not there must be refused");
    assert!(!plain.contains("the engine's own"), "{plain}");

    session.call("runtime.stop", json!({}));
}

/// An autoload that kills its own process the moment it is added, which is what a game that
/// crashes during boot looks like from the editor: a process that was there and then was not,
/// with nothing said and nothing announced.
const SUICIDAL_AUTOLOAD: &str =
    "extends Node\n\nfunc _ready() -> void:\n\tOS.kill(OS.get_process_id())\n";

/// A game that dies before its helper loads ends the launch waiting on it.
///
/// Gofer's own autoload is appended to `[autoload]`, so an autoload written into the project ahead
/// of it runs first — early enough that the game is gone before anything Gofer put in it has run.
/// Nothing then arrives on the debugger channel at all, and the launch is left with the editor's
/// play state as its only evidence.
#[test]
fn a_game_that_dies_before_its_helper_loads_ends_the_launch() {
    let directory = TempDir::new().expect("temporary directory");
    let worktree = godot_editor_harness::fixture_worktree(&directory);
    std::fs::create_dir_all(worktree.join("scripts")).expect("create scripts directory");
    std::fs::write(worktree.join("scripts/suicide.gd"), SUICIDAL_AUTOLOAD)
        .expect("write the autoload");
    let project = worktree.join("project.godot");
    let configured = std::fs::read_to_string(&project).expect("read the fixture project")
        + "\n[autoload]\n\nSuicide=\"*res://scripts/suicide.gd\"\n";
    std::fs::write(&project, configured).expect("write the project");
    let ledger = directory.path().join("ledger.json");
    let session = Session::start_on_worktree(worktree, ledger, Some(directory));

    let started = Instant::now();
    let error = session
        .try_call_within("runtime.run", json!({}), LAUNCH_TIMEOUT_MS)
        .expect_err("a game that killed itself must not answer as launched");
    let waited = started.elapsed();

    assert!(
        !error.starts_with("runtime_timeout"),
        "the launch expired on its deadline instead of noticing the game had gone: {error}\n\
         --- editor output ---\n{}",
        session.output()
    );
    assert!(
        error.starts_with("runtime_not_running"),
        "a game that is gone must answer the retryable no-game error: {error}\n--- editor output ---\n{}",
        session.output()
    );
    assert!(
        waited < Duration::from_secs(20),
        "the failure took {waited:?}, which is the deadline rather than the death"
    );
    let state = session.call("runtime.get_state", json!({}));
    assert_eq!(state["running"], false, "{state}");
    assert_eq!(state["runtimeReady"], false, "{state}");
    assert_eq!(state["broke"], false, "{state}");
}

/// A script named where a scene belongs. The engine refuses to play it and asks the developer what
/// to do instead, which is the everyday way an editor ends up waiting on a person rather than
/// working: a scene gets renamed, or a model writes the setting with the file it was editing.
const NOT_A_SCENE: &str = "extends Node\n\nfunc _ready() -> void:\n\tpass\n";

/// A launch the editor answers with a question reports the question.
///
/// `EditorInterface.play_main_scene()` does not always start a game. When the main scene is not a
/// scene the editor pops an exclusive `ConfirmationDialog` — "Selected scene ... is not a scene
/// file. Select a valid one?", with Cancel, Select and Select Current — and waits for a person to
/// press one of them. Nothing in the addon looked at the editor's own windows, so the launch sat
/// in the pending list on its deadline alone and answered `runtime_timeout: The game did not
/// answer in time`, retryable, about a game that was never started and never would be. An agent
/// reads that as "wait longer", asks again, and every attempt stacks one more modal on the
/// developer's editor.
///
/// The dialog is also invisible to `runtime.capture`: on a real desktop the editor's subwindows
/// are native OS windows of their own, so the base control's viewport texture — the pixels that
/// capture reads — is the editor *behind* the dialog. Verified on the pinned 4.7.2: the dialog
/// reports `is_embedded() == false` and a window id of its own.
#[test]
fn a_launch_the_editor_answers_with_a_question_reports_the_question() {
    let directory = TempDir::new().expect("temporary directory");
    let worktree = godot_editor_harness::fixture_worktree(&directory);
    std::fs::create_dir_all(worktree.join("scripts")).expect("create scripts directory");
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
    let session = Session::start_on_worktree(worktree, ledger, Some(directory));
    let events = session.rpc().subscribe_events();

    let quiet = session.call("session.get_state", json!({}));
    assert!(
        quiet["dialog"].is_null(),
        "a session with no dialog open must report none: {quiet}"
    );

    let started = Instant::now();
    let error = session
        .try_call_within("runtime.run", json!({}), LAUNCH_TIMEOUT_MS)
        .expect_err("a launch the editor turned into a question must not answer as launched");
    let waited = started.elapsed();

    assert!(
        !error.starts_with("runtime_timeout"),
        "the launch expired on its deadline instead of noticing the dialog: {error}\n\
         --- editor output ---\n{}",
        session.output()
    );
    assert!(
        error.starts_with("editor_dialog_open"),
        "an editor waiting on a person must say so, because every other answer sends the caller \
         back to waiting: {error}"
    );
    assert!(
        error.contains("is not a scene file"),
        "the refusal must quote what the editor asked, which is the only thing that tells the \
         caller what to fix: {error}"
    );
    assert!(
        error.contains("session.answer_dialog"),
        "the refusal has to name the call that answers a dialog: {error}"
    );
    assert!(
        error.contains("waiting behind this dialog"),
        "a launch the editor turned into a question is still a launch, and the caller has to be \
         told so before it asks for a second one: {error}"
    );
    assert!(
        waited < Duration::from_secs(20),
        "the failure took {waited:?}, which is the deadline rather than the dialog"
    );

    let state = session.call("session.get_state", json!({}));
    let dialog = &state["dialog"];
    assert!(
        dialog["text"]
            .as_str()
            .is_some_and(|text| text.contains("is not a scene file")),
        "the session state must carry the question the editor is waiting on: {state}"
    );
    assert!(
        !dialog["title"].as_str().unwrap_or_default().is_empty(),
        "a reported dialog must carry the title bar the developer sees: {state}"
    );
    let buttons: Vec<String> = dialog["buttons"]
        .as_array()
        .unwrap_or(&Vec::new())
        .iter()
        .map(|button| button.as_str().unwrap_or_default().to_owned())
        .collect();
    for expected in ["Cancel", "Select", "Select Current"] {
        assert!(
            buttons.iter().any(|button| button == expected),
            "the choices the editor is offering must be listed, and '{expected}' is missing: \
             {state}"
        );
    }

    let announced = await_event(&events, "session.dialog");
    assert!(
        announced["dialog"]["text"]
            .as_str()
            .is_some_and(|text| text.contains("is not a scene file")),
        "the dialog opening must be announced, not only answerable: {announced}"
    );

    let unrelated = session
        .rpc()
        .call(CallRequest::new(
            "scene.open",
            json!({"path": "res://no-such-scene.tscn"}),
        ))
        .expect_err("opening a scene that does not exist must fail");
    assert!(
        unrelated.details["dialog"]["text"]
            .as_str()
            .is_some_and(|text| text.contains("is not a scene file")),
        "a failure while a dialog is open must carry the dialog: {:?}",
        unrelated.details
    );

    let refused = session.error("session.answer_dialog", json!({"button": "Nope"}), None);
    assert!(
        refused.starts_with("unknown_button") && refused.contains("Select Current"),
        "a button the dialog does not have must be refused with the ones it has: {refused}"
    );

    let answered = session.call("session.answer_dialog", json!({"button": "Cancel"}));
    assert_eq!(answered["answered"], "Cancel", "{answered}");

    let cleared = await_event(&events, "session.dialog");
    assert!(
        cleared["dialog"].is_null(),
        "answering the dialog must be announced as the editor being free again: {cleared}"
    );
    let after = session.call("session.get_state", json!({}));
    assert!(
        after["dialog"].is_null(),
        "the answered dialog must be gone from the state as well: {after}"
    );

    let none = session.error("session.answer_dialog", json!({"button": "Cancel"}), None);
    assert!(
        none.starts_with("no_dialog_open"),
        "answering a dialog that is not there must say so: {none}"
    );
}

/// A probe that ticks every frame, so a breakpoint set while the game is already running is hit on
/// the next frame rather than never. The scene expects the Label, so the script keeps writing it.
const TICKING_PROBE_SCRIPT: &str = "extends Node2D\n\nvar ticks := 0\n\n@onready var label: Label = $Label\n\nfunc _process(_delta: float) -> void:\n\tticks += 1\n\tlabel.text = \"ticks: %d\" % ticks\n";
/// 1-based, matching the editor UI and the adapter's declared `linesStartAt1`.
const TICK_BREAK_LINE: i64 = 8;
/// A breakpoint on a per-frame line is hit within a frame; the budget only covers a loaded machine.
const BREAK_TIMEOUT: Duration = Duration::from_secs(30);

/// Connects to the editor's debug adapter, which is still coming up while the addon is already
/// answering.
fn dap_client(dap_port: u16, session: &Session) -> DapClient {
    let address = SocketAddr::from(([127, 0, 0, 1], dap_port));
    let deadline = Instant::now() + Duration::from_secs(30);
    let mut last = "no attempt".to_owned();
    while Instant::now() < deadline {
        match DapClient::connect(address).and_then(|mut client| client.initialize().map(|_| client))
        {
            Ok(client) => return client,
            Err(error) => {
                last = format!("{}: {}", error.code, error.message);
                std::thread::sleep(Duration::from_millis(500));
            }
        }
    }
    panic!(
        "the debug adapter never answered: {last}\n--- editor output ---\n{}",
        session.output()
    );
}

/// A break refuses only what a break actually stops, and continuing clears it.
///
/// The break state is the addon's own, because the debugger's `is_breaked()` is stale over a
/// healthy game. It was cleared by any message from the game — and a game only ever speaks when
/// Gofer asks it something. So a breakpoint hit and then continued in the editor left every later
/// request refused with "the game is paused at an error", forever: the one call that could have
/// cleared the state was the call the state refused. The debugger's `continued` is the signal that
/// ends it, and nothing else can.
///
/// What the break stops is the scene tree, and only `input` and `wait` sit on it. Measured at a
/// live breakpoint on 4.7.2: capture answered in 140ms with a real PNG, and tree, node and monitor
/// reads all answered too — the renderer draws through a break. Refusing them cost the agent the
/// one look at the frozen frame that a breakpoint is for.
#[test]
fn a_break_refuses_only_the_calls_it_stops() {
    let directory = TempDir::new().expect("temporary directory");
    let worktree = worktree_with_probes(&directory);
    let script = worktree.join("scripts/runtime_probe.gd");
    std::fs::write(&script, TICKING_PROBE_SCRIPT).expect("write the ticking probe script");
    let ledger = directory.path().join("ledger.json");
    let dap_port = free_port();
    let session = Session::start_on_worktree_with(
        worktree,
        ledger,
        Some(directory),
        Transports {
            dap_port: Some(dap_port),
            ..Transports::default()
        },
    );
    session
        .try_call_within("runtime.run", json!({}), LAUNCH_TIMEOUT_MS)
        .expect("the game must launch");

    let client = dap_client(dap_port, &session);
    let events = client.subscribe_events();
    client.attach().expect("attach to the running game");
    client.configuration_done().expect("configuration done");
    let breakpoints = client
        .set_breakpoints(&script, &[TICK_BREAK_LINE])
        .expect("set breakpoints");
    assert!(
        breakpoints.iter().any(|breakpoint| breakpoint.verified),
        "the probe breakpoint must verify, got {breakpoints:?}"
    );

    let stopped = client
        .await_stop(&events, MAIN_THREAD_ID, BREAK_TIMEOUT)
        .expect("a stop must arrive")
        .expect("the game must stop at the breakpoint rather than terminate");
    assert_eq!(stopped.reason, "breakpoint", "{stopped:?}");

    let state = session.call("runtime.get_state", json!({}));
    assert_eq!(state["broke"], true, "{state}");
    let refused = session
        .try_call("runtime.wait", json!({"frames": 2}), None)
        .expect_err("a paused game runs no frames, so a wait cannot answer");
    assert!(
        refused.starts_with("runtime_broke"),
        "a paused game must refuse a wait for the pause: {refused}"
    );
    let paused_tree = session.call("runtime.get_tree", json!({}));
    assert!(
        paused_tree.get("root").is_some(),
        "a paused game still answers a read: {paused_tree}"
    );
    // The renderer draws through a break; only the scene tree stops.
    let paused_frame = session.call("runtime.capture", json!({}));
    assert_frame(&paused_frame["frame"]);

    client
        .set_breakpoints(&script, &[])
        .expect("clear breakpoints");
    assert!(client.continue_execution(MAIN_THREAD_ID).expect("continue"));

    let deadline = Instant::now() + Duration::from_secs(15);
    let tree = loop {
        match session.try_call("runtime.get_tree", json!({}), None) {
            Ok(answer) => break answer,
            Err(error) => {
                assert!(
                    Instant::now() < deadline,
                    "a continued game must answer again, and this one still refuses with {error}\n\
                     --- editor output ---\n{}",
                    session.output()
                );
                std::thread::sleep(Duration::from_millis(250));
            }
        }
    };
    assert!(
        tree["root"]["name"].is_string(),
        "the continued game must answer its remote tree: {tree}"
    );
    let after = session.call("runtime.get_state", json!({}));
    assert_eq!(after["broke"], false, "{after}");

    let stopped = session.call("runtime.stop", json!({}));
    assert_eq!(stopped["running"], false, "{stopped}");
    session.await_stopped();
}

/// A running path that stops matching names what it reached and what is under it.
///
/// The twin of the editor-side check, and it also proves the game process can load `params.gd`:
/// `runtime.gd` preloads it for this wording, and a preload the game cannot resolve stops the whole
/// helper script from parsing — which reaches a caller as every runtime call timing out rather than
/// as a parse error.
#[test]
fn a_running_path_that_stops_matching_names_what_is_under_the_node_it_reached() {
    let directory = TempDir::new().expect("temporary directory");
    let worktree = godot_editor_harness::fixture_worktree(&directory);
    std::fs::create_dir_all(worktree.join("scripts")).expect("create scripts directory");
    std::fs::write(
        worktree.join("scripts/runtime_probe.gd"),
        MOVING_PROBE_SCRIPT,
    )
    .expect("write the probe script");
    std::fs::write(worktree.join("main.tscn"), MOVING_PROBE_SCENE).expect("write the scene");
    let ledger = directory.path().join("ledger.json");
    let session = Session::start_on_worktree(worktree, ledger, Some(directory));

    session
        .try_call_within("runtime.run", json!({}), LAUNCH_TIMEOUT_MS)
        .unwrap_or_else(|error| panic!("runtime.run failed: {error}\n{}", session.output()));

    session.call(
        "runtime.inspect_node",
        json!({"path": "/root/RuntimeProbe", "properties": ["position"]}),
    );

    let refused = session
        .try_call(
            "runtime.inspect_node",
            json!({"path": "/root/RuntimeProbe/Scoreboard"}),
            None,
        )
        .expect_err("a node that is not there");
    assert!(
        refused.contains("node_not_found") && refused.contains("/root/RuntimeProbe"),
        "the refusal names how far the path got: {refused}"
    );
    assert!(
        refused.contains("no children at all") || refused.contains("is there and holds"),
        "and what is under it: {refused}"
    );

    let invented = session
        .try_call(
            "runtime.inspect_node",
            json!({"path": "/root/RuntimeProbe/@Area2D@214"}),
            None,
        )
        .expect_err("a node the engine never made");
    assert!(
        invented.contains("/root/RuntimeProbe")
            && (invented.contains("no children at all") || invented.contains("is there and holds")),
        "an engine name nothing has is answered the same way: {invented}"
    );

    session.call("runtime.stop", json!({}));
}

/// A game that ends itself a fixed number of frames after it is asked to, and not before.
///
/// The end has to be triggered rather than timed. A launch is only answered once the helper has
/// announced and a frame has come back, and a game on a clock of its own can reach the end of that
/// clock first — on a loaded runner the test would then fail at its own `runtime.run`, about a race
/// rather than about waiting. This one lives until a key it recognises arrives.
///
/// The lingering frames are what let the input that asks for the end be answered before the process
/// goes. Counted in frames because that is the clock `runtime.wait` is counted in too.
const SHORT_LIVED_PROBE_SCRIPT: &str = "extends Node2D\n\nconst INJECTED_DEVICE := 7777\nconst FRAMES_TO_LINGER := 30\n\nvar _left := -1\n\nfunc _input(event: InputEvent) -> void:\n\tif event.device != INJECTED_DEVICE:\n\t\treturn\n\tif event is InputEventKey and event.pressed and not event.echo:\n\t\t_left = FRAMES_TO_LINGER\n\nfunc _process(_delta: float) -> void:\n\tif _left < 0:\n\t\treturn\n\t_left -= 1\n\tif _left <= 0:\n\t\tprint(\"=== SUMMARY ===\")\n\t\tget_tree().quit()\n";

/// The scene that runs it.
const SHORT_LIVED_PROBE_SCENE: &str = "[gd_scene load_steps=2 format=3]\n\n[ext_resource type=\"Script\" path=\"res://scripts/runtime_probe.gd\" id=\"1_probe\"]\n\n[node name=\"RuntimeProbe\" type=\"Node2D\"]\nscript = ExtResource(\"1_probe\")\n";

/// A wait the game outlives answers what happened, instead of failing the call that asked.
///
/// A benchmark ends. That is the outcome, not a fault: a headless run told to do fifteen seconds
/// of work reaches the end of its work and quits. `runtime.wait` is held under ten seconds, so
/// observing fifteen takes two of them — and a live turn's second wait met a game that had already
/// finished, answered `runtime_not_running`, and took the rest of the ops list down with it. The
/// `get_state` and the log read that would have carried the benchmark's own numbers never ran.
///
/// So a wait whose game is gone answers `{exited: true}` and the frames it did get. Both waits here
/// assert the same thing on purpose: whether the game goes while the first is in flight or in the
/// gap before it, the answer a caller needs is the same one, and the test does not have to win a
/// race to say so.
#[test]
fn a_wait_whose_game_ends_answers_that_it_ended() {
    let directory = TempDir::new().expect("temporary directory");
    let worktree = godot_editor_harness::fixture_worktree(&directory);
    std::fs::create_dir_all(worktree.join("scripts")).expect("create scripts directory");
    std::fs::write(
        worktree.join("scripts/runtime_probe.gd"),
        SHORT_LIVED_PROBE_SCRIPT,
    )
    .expect("write the probe script");
    std::fs::write(worktree.join("main.tscn"), SHORT_LIVED_PROBE_SCENE).expect("write the scene");
    let ledger = directory.path().join("ledger.json");
    let session = Session::start_on_worktree(worktree, ledger, Some(directory));

    session
        .try_call_within("runtime.run", json!({}), LAUNCH_TIMEOUT_MS)
        .unwrap_or_else(|error| {
            panic!(
                "runtime.run failed: {error}\n--- editor output ---\n{}",
                session.output()
            )
        });

    // The game ends when it is told to, so nothing above this line can race it.
    session.call(
        "runtime.input",
        json!({"events": [
            {"kind": "key", "key": "Q", "pressed": true, "device": INJECTED_DEVICE},
            {"kind": "key", "key": "Q", "pressed": false, "device": INJECTED_DEVICE},
        ]}),
    );

    // Far more frames than the game has left.
    let waited = session
        .try_call_within("runtime.wait", json!({"frames": 600}), LAUNCH_TIMEOUT_MS)
        .unwrap_or_else(|error| {
            panic!(
                "a wait the game ended must answer, not fail: {error}\n--- editor output ---\n{}",
                session.output()
            )
        });
    assert_eq!(
        waited["exited"], true,
        "a wait interrupted by the game ending must say so: {waited}"
    );

    // The second wait of a stacked pair: the game was already gone when this one was sent.
    let after = session
        .try_call_within("runtime.wait", json!({"frames": 600}), LAUNCH_TIMEOUT_MS)
        .unwrap_or_else(|error| {
            panic!("a wait for a game that already ended must answer, not fail: {error}")
        });
    assert_eq!(
        after["exited"], true,
        "waiting for a game that is already over is answered the same way: {after}"
    );

    // What the rest of the ops list was there to read, and used to be skipped. `running` is the
    // editor's own play state, which lags the process; the helper is gone the moment its debugger
    // session is, which is the fact a caller can act on.
    let state = session.call("runtime.get_state", json!({}));
    assert_eq!(state["runtimeReady"], false, "{state}");
}

/// A headless run answers without a frame, because a headless game renders none.
///
/// Every launch proves itself by capturing its first frame. A game started with `--headless` has
/// no viewport to capture, so that proof costs a round trip to a helper that can only fail — and
/// on the runs where it does come back, it is a PNG of nothing, charged to a caller that asked for
/// a benchmark. The launch is proven by the helper announcing instead, which is the half of the
/// evidence a headless game can actually produce.
#[test]
fn a_headless_run_is_answered_without_a_frame() {
    let directory = TempDir::new().expect("temporary directory");
    let worktree = worktree_with_probes(&directory);
    let ledger = directory.path().join("ledger.json");
    let session = Session::start_on_worktree(worktree, ledger, Some(directory));

    let headless = session
        .try_call_within(
            "runtime.run",
            json!({"playArgs": ["--headless"]}),
            LAUNCH_TIMEOUT_MS,
        )
        .unwrap_or_else(|error| {
            panic!(
                "a headless run failed: {error}\n--- editor output ---\n{}",
                session.output()
            )
        });
    assert_eq!(headless["running"], true, "{headless}");
    assert!(
        headless.get("frame").is_none(),
        "a headless game renders nothing, so nothing is worth sending back: {headless}"
    );
    let state = session.call("runtime.get_state", json!({}));
    assert_eq!(
        state["runtimeReady"], true,
        "the helper still announces, which is what proves the launch: {state}"
    );

    session.call("runtime.stop", json!({}));

    // A run that asked for no such thing still carries its frame.
    let windowed = session
        .try_call_within("runtime.run", json!({}), LAUNCH_TIMEOUT_MS)
        .unwrap_or_else(|error| panic!("runtime.run failed: {error}"));
    assert_frame(&windowed["frame"]);
    session.call("runtime.stop", json!({}));
}

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
const PROBE_SCRIPT: &str = "extends Node2D\n\nconst INJECTED_DEVICE := 7777\nconst PROBE_ACTION := \"acceptance_probe_action\"\n\nvar presses := 0\nvar actions := 0\nvar last_source := \"none\"\n\n@onready var label: Label = $Label\n\nfunc _ready() -> void:\n\t_refresh()\n\n# Only the test's own input counts. Anything the desktop delivers to this window carries a device\n# the engine assigned, never this one, so a stray keystroke cannot change the assertions.\nfunc _input(event: InputEvent) -> void:\n\tif InputMap.has_action(PROBE_ACTION) and event.is_action_pressed(PROBE_ACTION):\n\t\tactions += 1\n\tif event.device != INJECTED_DEVICE:\n\t\treturn\n\tif event is InputEventKey and event.pressed and not event.echo:\n\t\t_record(\"key\")\n\telif event is InputEventMouseButton and event.pressed:\n\t\t_record(\"mouse\")\n\telif event is InputEventJoypadButton and event.pressed:\n\t\t_record(\"gamepad\")\n\nfunc _record(source: String) -> void:\n\tpresses += 1\n\tlast_source = source\n\t_refresh()\n\nfunc _refresh() -> void:\n\tlabel.text = \"presses: %d (%s)\" % [presses, last_source]\n";

/// The fixture scene with the probe script attached. Written into the copied worktree: the
/// checked-in fixture deliberately stays free of scripts so the Node journeys see a project that
/// can never produce script output.
const PROBE_SCENE: &str = "[gd_scene load_steps=2 format=3]\n\n[ext_resource type=\"Script\" path=\"res://scripts/runtime_probe.gd\" id=\"1_probe\"]\n\n[node name=\"RuntimeProbe\" type=\"Node2D\"]\nscript = ExtResource(\"1_probe\")\n\n[node name=\"Label\" type=\"Label\" parent=\".\"]\noffset_right = 320.0\noffset_bottom = 40.0\n";

/// Copies the fixture project and turns it into a game the loop can observe: a main scene whose
/// probe script counts injected input in a Label.
fn fixture_worktree(directory: &TempDir) -> PathBuf {
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
    let worktree = fixture_worktree(&directory);
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

    // Registered before the game starts, because the game reads the Input Map from the project.
    // This is the addon's own writer, so the binding is the physical-key one every action Gofer
    // registers gets — which is the whole point of asking whether injected input can fire it.
    // F13 rather than a key a person has: this event is injected *unstamped*, because a device
    // marker is what keeps an action from matching at all — the Input Map binds the keyboard's own
    // device, and an event carrying 7777 matches no keyboard binding. Unstamped is also how an
    // agent injects, so it is the path worth proving. A key no keyboard carries is what keeps a
    // developer typing during the suite out of the count.
    session.call(
        "project.set_input_action",
        json!({"name": "acceptance_probe_action", "events": [{"kind": "key", "key": "F13"}]}),
    );

    // Nothing runs yet: inspection fails retryably and the state says so. The session's own view
    // agrees, which is what the badge reads.
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

    // The launch answer rides back with the first rendered frame — the proof the game produced
    // pixels, captured automatically as every successful run must.
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
    // Godot is playing the project, and the session says so without being asked: the addon polls
    // `EditorInterface.is_playing_scene()` every frame and announces the transition. This is what
    // turns the toolbar's Run Game into Stop Game.
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

    // The remote tree is the running game's tree — the autoloaded helper and the probe scene sit
    // under the root window — and it stays a separate concept from the edited scene's tree.
    let tree = session.call("runtime.get_tree", json!({}));
    assert_eq!(tree["truncated"], false);
    // Whether the tree is paused, which belongs to the SceneTree and not to any node — so
    // `inspect_node` cannot reach it. Two live turns asked for it as a property of `/root` and were
    // told `/root has no property 'paused'`, which is true and no use. It rides with the tree
    // because the tree is what gets asked for.
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

    // The same three bounds the edited tree takes, on the tree that actually overran them: a live
    // project's running tree was 235,113 characters, and the worker cuts a tool result at 24,000.
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

    // Waiting happens inside the game, so the frames really are rendered before the answer leaves.
    // Thirteen of thirty bash calls in one live project were `sleep`, which stops the agent instead
    // and lets the game run unobserved.
    let waited = session.call("runtime.wait", json!({"frames": 5}));
    assert_eq!(waited["frames"], 5, "{waited}");
    let timed = session.call("runtime.wait", json!({"ms": 120}));
    assert!(
        timed["ms"].as_i64().expect("a wait reports its duration") >= 120,
        "a wait named in milliseconds has to last them: {timed}"
    );
    // Both bounds are held, so a wait can never outlast the request carrying it.
    let capped = session.call("runtime.wait", json!({"frames": 100_000, "ms": 150}));
    assert!(
        capped["frames"].as_i64().expect("frames") < 100_000,
        "the duration has to end a frame count it outlives: {capped}"
    );

    // And the game the wait is waiting on is actually running.
    //
    // It was not. Both fixtures set `window/size/no_focus` so a test game cannot take the
    // developer's keystrokes, and an X11 window that is never focused is never given a vblank —
    // so every frame Godot waited for one and timed out at about half a second. Measured
    // interleaved: 2.0 frames a second with the setting, 1125 without it, 3200 with it and vsync
    // off. Every runtime test above this line, and every live agent verifying its own game, was
    // watching something that rendered five frames in four seconds. The fixtures now cap at 60,
    // so half a second is thirty frames; five is a long way under that and a long way over the one
    // the throttle allowed.
    let rate = session.call("runtime.wait", json!({"ms": 500}));
    assert!(
        rate["frames"].as_i64().expect("frames") > 5,
        "half a second of game time has to be more than a handful of frames, or the game under \
         test is not running: {rate}"
    );

    // The edited scene cannot be mutated while the game is playing, and the refusal has to say
    // which call clears that. It used to end at "cannot be mutated", which names no way forward:
    // two live tasks met it and neither one stopped the game.
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
    // The event arriving is not the same as the game being driven. An injected key has to match
    // the action the Input Map binds to it, or a level built with these tools cannot be played by
    // them: the press lands, nothing answers it, and no error is raised anywhere.
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
                json!({"events": [{"kind": "key", "key": "NotAKey"}]}),
                None,
            )
            .starts_with("unsupported_value"),
        "an unknown key must be refused by the helper, not injected"
    );
    // The five named buttons are a closed set, so a refusal that does not carry them is one the
    // caller cannot act on. A live turn clicking a menu sent the *string* "1" — the number is
    // accepted and its spelling is not — and was told only that "1" is unknown.
    // A monitor that is not one names the monitors there are. Every other closed vocabulary in that
    // file says what it holds; this one only said what it does not.
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
    // The five kinds are the whole vocabulary and a caller that got one wrong has nowhere else to
    // read them. A live turn building a playable game sent an event with no kind at all and was
    // answered `Input event kind '' is not supported` twenty-two times running. The parameter
    // contract refuses that before it reaches this socket now; the helper still has to say it.
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
            .error("runtime.get_monitors", json!({"monitors": ["bogus"]}), None)
            .starts_with("unknown_monitor")
    );

    // Manual capture works on demand; the headless editor honestly refuses its own viewport.
    let capture = session.call("runtime.capture", json!({}));
    assert_frame(&capture["frame"]);
    assert!(
        session
            .error("runtime.capture", json!({"source": "editor"}), None)
            .starts_with("capture_unavailable"),
        "a headless editor has no viewport to capture"
    );

    // Restart replaces the process: the probe's state resets, proving the old game is gone.
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

    // Stop tears the helper down: readiness clears and inspection fails retryably again.
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

    // The editor is killed, which is what a crash and a person closing the window both look like.
    // Nothing is told: the addon is gone with the process, so there is no event and no reply. The
    // session still has to stop reporting a ready editor, because everything on screen is derived
    // from this and it used to go on saying ready over a corpse until something was clicked.
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

    // No wait: the editor answers `session.quit` before it acts and only leaves a frame later, so
    // by the time it has actually gone the game it stopped first has been gone longer.
    assert!(
        std::net::TcpListener::bind(("127.0.0.1", port)).is_ok(),
        "the game outlived the editor that launched it: port {port} is still held"
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
    // The port proves the game is up before anything is claimed about it being down.
    let held = std::net::TcpListener::bind(("127.0.0.1", port));
    assert!(
        held.is_err(),
        "the game must be holding its port before the stop is asked for"
    );
    // Long enough that the spin has started and the debugger channel is dead.
    //
    // Polling for those two rather than sleeping through them was tried and reverted: asking
    // `runtime.get_state` while the game is wedged is a question the editor answers slowly, and
    // under `npm run check` the loop turned an 11s test into a 33s failure. The wait is cheap and
    // the thing being waited for is not observable without disturbing it.
    std::thread::sleep(Duration::from_secs(6));

    let stopped = session.call("runtime.stop", json!({}));
    assert_eq!(stopped["running"], false, "{stopped}");
    // Nothing sleeps between the response and this bind: the answer has to be true when it is
    // written, not true a moment later.
    assert!(
        std::net::TcpListener::bind(("127.0.0.1", port)).is_ok(),
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
/// Two live turns reached for a `playArgs` parameter `godot_runtime run` does not have, and a
/// third took the only route that was open: it wrote `application/run/main_scene` to the scene it
/// wanted, ran, and wrote it back — two calls of detour, and a window in which the project boots
/// into a test scene. `play_custom_scene` is the editor's own F6 and is what "run this scene"
/// means.
#[test]
fn a_named_scene_runs_without_becoming_the_project_entry_point() {
    let directory = TempDir::new().expect("temporary directory");
    let worktree = fixture_worktree(&directory);
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

    // The running tree is the named scene's, and the project's main scene is untouched — which is
    // the whole point: the detour this replaces left the project pointing somewhere else.
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

    // A restart restarts what is running, not what the project starts with.
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
    // And a scene that is not there is refused by name, before anything is launched.
    let refused = session.error("runtime.run", json!({"scene": "res://nope.tscn"}), None);
    assert!(
        refused.starts_with("scene_not_found") && refused.contains("nope.tscn"),
        "a scene that does not exist must be refused by name: {refused}"
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

    // The state answers what the launch did. `running` is honestly true — the process is alive and
    // the editor is still playing it — which is exactly why the break has to be sayable on its own.
    let state = session.call("runtime.get_state", json!({}));
    assert_eq!(state["broke"], true, "{state}");
    assert_eq!(state["runtimeReady"], false, "{state}");

    // Nothing forwarded to a paused game can be answered either, and it fails now rather than on
    // its own deadline.
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

    // The game is still there to stop, and stopping it clears the break.
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
    // Gofer's own autoload is appended to `[autoload]`, so one written here runs ahead of it.
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

    // And the state it points at agrees: the game is there, its helper is not.
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

    // It moves.
    let started = where_it_is(&session);
    session.call("runtime.wait", json!({"frames": 20}));
    let moved = where_it_is(&session);
    assert!(
        moved > started,
        "the probe must be moving: {started} {moved}"
    );

    // Frozen, and the helper still answers — both the wait and the inspection below run while the
    // tree is paused.
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

    // A frozen game is still a game to look at: rendering does not stop with processing, so a
    // capture answers with pixels. Asserted because a pause a caller cannot photograph would be a
    // poor place to have led one.
    let photographed = session.call("runtime.capture", json!({}));
    assert_eq!(
        photographed["frame"]["encoding"], "png-base64",
        "{photographed}"
    );
    // The probe draws nothing, so the picture is a blank window and its PNG is small — what is
    // asserted is that there is one, with the window's own size on it.
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

    // And input reaches a frozen game and changes nothing, which is what a pause means: the events
    // are applied, and the node they would have moved does not move.
    let injected = session.call(
        "runtime.input",
        json!({"events": [{"kind": "key", "key": "Right", "pressed": true}]}),
    );
    assert_eq!(injected["applied"], 1, "{injected}");
    assert!(
        (where_it_is(&session) - held).abs() < 0.001,
        "a paused game must not move for input either: {held}"
    );

    // And let go again.
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

    // The named property is still answered beside them, and nothing was asked for `groups`.
    assert_eq!(
        inspected["properties"]["position"]["type"], "vector2",
        "{inspected}"
    );

    // And the edited scene, read at the same moment, knows nothing about it — which is the whole
    // reason this cannot be answered from the file.
    let authored = session.call("node.inspect", json!({"node": "/RuntimeProbe"}));
    assert_eq!(authored["groups"], json!([]), "{authored}");

    // A path to a node the engine named itself says what such a name is. A spawner's bullet has
    // one, and it is gone between the `get_tree` that reported it and the `inspect_node` that
    // names it — which one live turn building a shooter met four times.
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

    // A name somebody wrote gets the plain refusal, with nothing invented about it.
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

    // Nothing is open yet, and a session with no question outstanding must say so rather than
    // leave the field out — the renderer and the model both read the absence as "carry on".
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
        waited < Duration::from_secs(20),
        "the failure took {waited:?}, which is the deadline rather than the dialog"
    );

    // The dialog is still up — nothing dismissed it — so the session has to keep reporting it.
    // This is what the agent reads before it tries anything else, and what stops it from asking
    // for the same launch again.
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

    // Nothing had to ask. A dialog a person opens by hand is the same event, and without it the
    // only way to learn the editor is blocked is for something else to fail first.
    let announced = await_event(&events, "session.dialog");
    assert!(
        announced["dialog"]["text"]
            .as_str()
            .is_some_and(|text| text.contains("is not a scene file")),
        "the dialog opening must be announced, not only answerable: {announced}"
    );

    // Every refusal carries it, not just the launch that opened it. A model reads results and
    // nothing else: an unrelated command failing for its own reason is often the only thing it
    // looks at, and that is where it has to learn the editor is waiting on a person.
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

    // A button that is not there is refused by name, with the ones that are.
    let refused = session.error("session.answer_dialog", json!({"button": "Nope"}), None);
    assert!(
        refused.starts_with("unknown_button") && refused.contains("Select Current"),
        "a button the dialog does not have must be refused with the ones it has: {refused}"
    );

    // And the way out: the same press a person would make. Cancel is the safe one — Select opens
    // a file dialog and Select Current rewrites the project's main scene.
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

    // With nothing open, answering is a refusal rather than a silent no-op.
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

/// A game continued after a break answers again, without having to speak first.
///
/// The break state is the addon's own, because the debugger's `is_breaked()` is stale over a
/// healthy game. It was cleared by any message from the game — and a game only ever speaks when
/// Gofer asks it something. So a breakpoint hit and then continued in the editor left every later
/// request refused with "the game is paused at an error", forever: the one call that could have
/// cleared the state was the call the state refused. The debugger's `continued` is the signal that
/// ends it, and nothing else can.
#[test]
fn a_game_continued_after_a_break_answers_again() {
    let directory = TempDir::new().expect("temporary directory");
    let worktree = fixture_worktree(&directory);
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

    // Attached rather than launched: the game is the one the editor is already running, which is
    // the game every runtime command is about.
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

    // A paused game is refused for the reason it cannot answer, which is the state under test.
    let state = session.call("runtime.get_state", json!({}));
    assert_eq!(state["broke"], true, "{state}");
    let refused = session
        .try_call("runtime.get_tree", json!({}), None)
        .expect_err("a paused game cannot answer a forwarded request");
    assert!(
        refused.starts_with("runtime_broke"),
        "a paused game must be refused for the pause: {refused}"
    );

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

    // The game outlives the editor that spawned it, so a test that starts one stops it.
    let stopped = session.call("runtime.stop", json!({}));
    assert_eq!(stopped["running"], false, "{stopped}");
    session.await_stopped();
}

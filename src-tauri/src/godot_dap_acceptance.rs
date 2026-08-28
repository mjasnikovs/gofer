//! Acceptance coverage for the debug-adapter boundary: a real pinned Godot editor running the
//! real fixture game under the real [`DapClient`].
//!
//! The unit suite in `godot_dap` plays both sides of the wire — the same author wrote the client
//! and the fake adapter, which is how a green suite ships a handshake the real server never
//! speaks. This module removes the stand-in: it launches the pinned editor with `--dap-port`,
//! runs the fixture project through the exact Godot 4.7 sequence (initialize, launch,
//! setBreakpoints, configurationDone), and proves the loop the debugger UI and the agent will
//! drive: breakpoint hit, stack/scopes/variables, evaluate, emulated step-out, pause/continue,
//! restart, terminate. Gated behind the `godot-acceptance` feature so the fast gate needs no
//! engine.

use crate::godot_dap::{DapClient, DapEvent, MAIN_THREAD_ID, StepOutcome};
use crate::godot_editor_harness::{self, Editor, Launch, RETRY_EVERY, free_port, retry_until};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::mpsc::Receiver;
use std::time::{Duration, Instant};
use tempfile::TempDir;

const STOP_TIMEOUT: Duration = Duration::from_secs(60);

/// The probe ticks every frame, so the breakpoint is hit no matter when the run starts — the
/// game may be mid-flight before the adapter finishes configuration. `_tick` exists so the stack
/// at the breakpoint is two frames deep and step-out has somewhere to escape to.
const PROBE_SCRIPT: &str = "extends Node\n\nvar counter := 0\nvar label := \"probe\"\n\nfunc _process(_delta: float) -> void:\n\t_tick(1)\n\nfunc _tick(amount: int) -> void:\n\tcounter += amount\n";
/// 1-based, matching the editor UI and the client's declared `linesStartAt1`.
const BREAK_LINE: i64 = 10;

/// The fixture scene with the probe script attached. Written into the copied worktree: the
/// checked-in fixture deliberately stays free of scripts so the Node journeys see a project that
/// can never produce script output.
const PROBE_SCENE: &str = "[gd_scene load_steps=2 format=3]\n\n[ext_resource type=\"Script\" path=\"res://scripts/debugger_probe.gd\" id=\"1_probe\"]\n\n[node name=\"ProtocolFixture\" type=\"Node\"]\nscript = ExtResource(\"1_probe\")\n";

/// Copies the fixture project and gives it a main scene whose probe script the debugger can break
/// inside. The checked-in fixture stays script-free so the Node journeys never see script output.
fn worktree_with_probes(directory: &TempDir) -> PathBuf {
    let worktree = godot_editor_harness::fixture_worktree(directory);
    let scripts = worktree.join("scripts");
    std::fs::create_dir_all(&scripts).expect("create scripts directory");
    std::fs::write(scripts.join("debugger_probe.gd"), PROBE_SCRIPT).expect("write probe script");
    std::fs::write(worktree.join("main.tscn"), PROBE_SCENE).expect("write probe scene");
    worktree
}

/// Launches the pinned editor with its debug adapter on a known port.
fn launch(worktree: &std::path::Path, dap_port: u16) -> Editor {
    Launch::on(worktree).dap(dap_port).start()
}

/// Polls until the editor's debug adapter accepts a connection and answers initialize. The
/// editor imports the project first, so early connection attempts are expected to fail.
fn connect(dap_port: u16, editor: &Editor) -> DapClient {
    let address = SocketAddr::from(([127, 0, 0, 1], dap_port));
    retry_until(
        "the debug adapter never answered",
        || editor.output(),
        RETRY_EVERY,
        || {
            DapClient::connect(address)
                .and_then(|mut client| client.initialize().map(|_| client))
                .map_err(|error| format!("{}: {}", error.code, error.message))
        },
    )
}

/// Waits for a stopped-breakpoint event, skipping the chatter around it: output lines, continued
/// notifications, and the terminated/exited events a restart sends for the previous instance.
fn await_breakpoint(client: &DapClient, events: &Receiver<DapEvent>, editor: &Editor) {
    let deadline = Instant::now() + STOP_TIMEOUT;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        let stop = client
            .await_stop(
                events,
                MAIN_THREAD_ID,
                remaining.max(Duration::from_millis(1)),
            )
            .unwrap_or_else(|error| {
                panic!(
                    "no breakpoint stop arrived: {}\n--- editor output ---\n{}",
                    error.message,
                    editor.output()
                )
            });
        match stop {
            Some(stop) if stop.reason == "breakpoint" => return,
            // The previous instance terminated around a restart; the new one is still coming.
            None => continue,
            Some(stop) => panic!(
                "expected a breakpoint stop, got {stop:?}\n--- editor output ---\n{}",
                editor.output()
            ),
        }
    }
}

/// Waits for the terminated/exited events of a stopped game. Teardown can report one last stray
/// stop first, so the wait loops until the session actually ends.
fn await_termination(client: &DapClient, events: &Receiver<DapEvent>) {
    let deadline = Instant::now() + STOP_TIMEOUT;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        let ended = client
            .await_stop(
                events,
                MAIN_THREAD_ID,
                remaining.max(Duration::from_millis(1)),
            )
            .expect("termination");
        if ended.is_none() {
            return;
        }
    }
}

#[test]
fn the_editor_runs_breaks_steps_and_terminates() {
    let directory = TempDir::new().expect("temporary directory");
    let worktree = worktree_with_probes(&directory);

    let dap_port = free_port();
    let editor = launch(&worktree, dap_port);
    let client = Arc::new(connect(dap_port, &editor));
    let events = client.subscribe_events();
    let script = worktree.join("scripts").join("debugger_probe.gd");

    // Candidate validation comes first: the adapter must accept the probe line before the run.
    let locations = client
        .breakpoint_locations(&script, BREAK_LINE)
        .expect("breakpoint locations");
    assert!(
        locations.iter().any(|location| location.line == BREAK_LINE),
        "line {BREAK_LINE} must be a breakpoint candidate, got {locations:?}"
    );

    // The exact Godot 4.7 sequence: launch first (its response is deferred until
    // configurationDone spawns the game, so it is written now and collected below), then
    // breakpoints, then configurationDone. Godot does not forward --headless to the game it
    // spawns, so the play argument does.
    let launching = client
        .start_launch(&worktree, &["--headless".to_owned()])
        .expect("start launch");

    let breakpoints = client
        .set_breakpoints(&script, &[BREAK_LINE])
        .expect("set breakpoints");
    let verified = breakpoints
        .iter()
        .find(|breakpoint| breakpoint.verified)
        .unwrap_or_else(|| panic!("the probe breakpoint must verify, got {breakpoints:?}"));
    assert_eq!(verified.line, Some(BREAK_LINE));

    client.configuration_done().expect("configuration done");
    client.await_launch(launching).expect("launch response");
    await_breakpoint(&client, &events, &editor);

    // A real adapter's own `stopped` event is the only thing that sets this, and it is what stands
    // between a caller and twenty seconds of waiting for a frame a halted game will never draw.
    // See `godot_session::a_game_the_debugger_has_halted`.
    assert!(
        crate::godot_dap::debuggee_is_stopped(),
        "a real breakpoint stop must be visible to the runtime router"
    );

    // One thread, two frames: _tick called from _process, stopped on the probe line.
    let threads = client.threads().expect("threads");
    assert_eq!(threads.len(), 1, "Godot debugs exactly one thread");
    let frames = client.stack_trace(MAIN_THREAD_ID).expect("stack trace");
    assert!(
        frames.len() >= 2,
        "the probe must stop two frames deep, got {frames:?}"
    );
    assert_eq!(frames[0].name, "_tick");
    assert_eq!(frames[0].line, BREAK_LINE);
    assert!(
        frames[0]
            .source_path
            .as_deref()
            .is_some_and(|path| path.ends_with("debugger_probe.gd")),
        "the top frame must name the probe script, got {frames:?}"
    );

    // Locals, Members, and Globals are always reported, in that order.
    let scopes = client.scopes(frames[0].id).expect("scopes");
    let names: Vec<&str> = scopes.iter().map(|scope| scope.name.as_str()).collect();
    assert_eq!(names, ["Locals", "Members", "Globals"]);

    let locals = client
        .variables(scopes[0].variables_reference)
        .expect("locals");
    let amount = locals
        .iter()
        .find(|variable| variable.name == "amount")
        .unwrap_or_else(|| panic!("the _tick argument must be a local, got {locals:?}"));
    assert_eq!(amount.value, "1");
    let members = client
        .variables(scopes[1].variables_reference)
        .expect("members");
    assert!(
        members.iter().any(|variable| variable.name == "counter"),
        "the probe's counter must be a member, got {members:?}"
    );
    // The probe touches no autoloads or global classes, so Globals may legitimately be empty;
    // what matters is that the scope answers.
    client
        .variables(scopes[2].variables_reference)
        .expect("globals");

    // Evaluation runs in the stopped frame and comes back as the debuggee rendered it.
    let evaluation = client
        .evaluate("1 + 2", Some(frames[0].id))
        .expect("evaluate");
    assert_eq!(evaluation.result, "3");

    // Step-out is emulated: bounded step-overs until the stack shrinks back into _process.
    let outcome = client.step_out(&events, MAIN_THREAD_ID).expect("step out");
    let StepOutcome::SteppedOut { .. } = outcome else {
        panic!("the probe must step out into _process, got {outcome:?}")
    };
    let frames = client
        .stack_trace(MAIN_THREAD_ID)
        .expect("stack after step out");
    assert_eq!(frames[0].name, "_process");

    // With the breakpoint cleared, the game runs free until it is paused. Mid-session
    // breakpoint changes do take effect on the debuggee even though Godot does not broadcast
    // `breakpoint` events for them. The stream is drained before the pause anyway: the step-out
    // above consumed its own stops from it, and with no breakpoints left no new one can arrive
    // between the drain and the pause.
    let cleared = client
        .set_breakpoints(&script, &[])
        .expect("clear breakpoints");
    assert!(
        cleared
            .iter()
            .all(|breakpoint| breakpoint.line != Some(BREAK_LINE)),
        "the probe breakpoint must be gone, got {cleared:?}"
    );
    assert!(client.continue_execution(MAIN_THREAD_ID).expect("continue"));
    assert!(
        !crate::godot_dap::debuggee_is_stopped(),
        "a game told to run on is not halted, and a router that still thinks it is refuses a call \
         the game could have answered"
    );
    while events.try_recv().is_ok() {}
    client.pause(MAIN_THREAD_ID).expect("pause");
    let paused = client
        .await_stop(&events, MAIN_THREAD_ID, STOP_TIMEOUT)
        .expect("pause stop")
        .unwrap_or_else(|| {
            panic!(
                "the game terminated instead of pausing\n--- editor output ---\n{}",
                editor.output()
            )
        });
    assert_eq!(paused.reason, "paused");

    // A pause is not a break, and this is what that costs. Both are the engine's own behaviour on
    // the pinned 4.7.2, and both are why `why_there_are_no_frames` and
    // `what_a_timed_out_evaluate_usually_means` exist: a live turn paused to look at a collision it
    // could not see, read an empty stack twice, waited out the evaluate, and abandoned the
    // debugger.
    assert!(
        client
            .stack_trace(MAIN_THREAD_ID)
            .expect("a stack trace answer")
            .is_empty(),
        "a paused game has no frame to describe; if this answers with one, the two explanations in \
         debug.rs describe something that no longer happens"
    );
    let refused = client
        .evaluate("1 + 1", None)
        .expect_err("an evaluate with no frame cannot be answered");
    assert!(
        refused.message.contains("Timeout reached"),
        "{}",
        refused.message
    );

    // Terminate stops the game and ends the debug session but keeps the adapter. Stopping a
    // game mid-break can report one last stray stop before the termination events, so the wait
    // loops until the terminated/exited events actually arrive.
    assert!(client.continue_execution(MAIN_THREAD_ID).expect("continue"));
    client.terminate().expect("terminate");
    await_termination(&client, &events);

    // Restart with no session active: the relaunched instance takes the default debugger again,
    // receives the restored breakpoint during session sync, and hits it on its next frame.
    client
        .set_breakpoints(&script, &[BREAK_LINE])
        .expect("restore breakpoint");
    client.restart().expect("restart");
    await_breakpoint(&client, &events, &editor);

    client.terminate().expect("terminate");
    await_termination(&client, &events);
    client.disconnect(true).expect("disconnect");
    client.shutdown();
}

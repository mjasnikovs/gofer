//! What the model is told when a runtime call could not be answered.
//!
//! The addon knows a call went unanswered and knows nothing about why. Everything that can say why
//! is somewhere else — the editor's own stderr, the debugger's held game, the breakpoints this
//! session armed, whether `project.godot` still registers the runtime helper — and none of it is
//! the process supervisor's subject. This is the fold that turns those facts into the sentences a
//! failure carries, and [`SessionFacts`] is the one value it folds over.
//!
//! It lived in [`crate::godot_session`], where it was the largest thing in a file about starting
//! and stopping a process, and where the only thing holding it there was the log buffer it reads.

use crate::ai_tools::ToolFailure;
use crate::godot_session::{
    LogEntry, LogQuery, LogSeverity, SessionState, current_info, current_state, editor_has_exited,
    game_launch_cursor, newest_logs, now_millis, read_logs,
};
use std::sync::LazyLock;

/// The runtime failures that mean the game is not answering, whatever the reason turns out to be.
///
/// Every one of them is the addon reporting a state of the process rather than a fault in the
/// request: the game is paused at an error, it is gone, it stopped answering, or it is up and its
/// helper has not loaded. All four are worth the same treatment, because in all four the model's
/// next question is the same one, and the answer is in the editor's output either way.
///
/// `runtime_slow_start` is here for a failure that looks like patience and is not: a parse error in
/// the addon's own runtime script leaves the game running and its helper never loading, so the
/// launch times out while the editor is still playing, for ever. Without the output the message
/// reads as "wait a little longer", and there is nothing to wait for.
const GAME_IS_NOT_ANSWERING: [&str; 5] = [
    "runtime_broke",
    "runtime_not_running",
    "runtime_slow_start",
    "runtime_timeout",
    "session_closed",
];

/// Everything about the session that an explanation of a runtime failure is arithmetic over.
///
/// Each of these seven facts lives in a different module's process-wide state, and each explainer
/// used to reach for its own. That made a sentence about an armed breakpoint provable only by
/// forging `debug`'s and `godot_dap`'s globals from this module's tests, through `#[cfg(test)]`
/// doors those modules had to carry for it. Gathered once, the explaining is a fold over a value.
pub(crate) struct SessionFacts {
    /// Whether a process is still there, which is what decides whose crash line a marker was.
    editor_is_running: bool,
    /// The crash line, when one was printed recently enough to belong to the call being answered.
    crash: Option<String>,
    /// The session's last error lines, oldest first, the engine's own chatter already dropped.
    errors: Vec<String>,
    debugger_holds_a_game: bool,
    /// The files that still hold a breakpoint this session set.
    armed_breakpoints: Vec<String>,
    /// Whether `project.godot` has stopped registering the runtime helper.
    helper_missing: bool,
}

impl SessionFacts {
    /// Reads the session once. The only part of the explaining that touches anything outside it.
    fn gathered() -> Self {
        Self {
            editor_is_running: an_editor_is_still_running(),
            crash: a_crash_line_from_this_call(),
            errors: last_session_errors(CARRIED_ERROR_LINES),
            debugger_holds_a_game: crate::debug::holds_a_game(),
            armed_breakpoints: crate::debug::armed_breakpoints(),
            helper_missing: current_info().is_some_and(|info| {
                crate::addon::runtime_helper_missing(std::path::Path::new(&info.worktree))
            }),
        }
    }
}

/// What Godot prints as it dies of a signal.
const CRASH_MARKER: &str = "Program crashed with signal";

/// The newest crash marker, when it is recent enough to be about the call being answered.
///
/// Whose death it was is not decided here. The game inherits the editor's pipes, so both write the
/// same line into the same buffer, and only [`SessionFacts::editor_is_running`] tells them apart.
fn a_crash_line_from_this_call() -> Option<String> {
    let entry = newest_logs(
        &LogQuery {
            contains: Some(CRASH_MARKER.to_owned()),
            ..LogQuery::default()
        },
        1,
    )
    .pop()?;
    (now_millis().saturating_sub(entry.timestamp) <= CRASH_IS_THIS_CALLS_MS)
        .then_some(entry.message)
}

/// The crash line, when the editor died rather than merely stopped answering.
///
/// Godot 4.7.2 segfaults when it is asked to play a project whose script will not parse. Watched
/// three times in one night, always the same four lines:
///
/// ```text
/// SCRIPT ERROR: Parse Error: Function "add_child_node()" not found in base self.
/// ERROR: Failed to load script "res://scripts/spawner.gd" with error "Parse error".
/// ERROR: Parameter "t" is null.
/// handle_crash: Program crashed with signal 11
/// ```
///
/// What reached the model was `session_closed: The RPC session closed`, which is true and tells it
/// nothing — so it retried, and retried, and two of those three runs never finished. A crash is not
/// something to retry, and it is not the caller's mistake; the engine is the thing that broke, and
/// saying so is the difference between restarting the session and arguing with it.
///
/// Read without a severity floor on purpose. `handle_crash:` arrives on the editor's stderr and is
/// not classified as an error line, so the reader that carries error lines never sees it.
///
/// Guarded by [`an_editor_is_still_running`], because the marker on its own does not say whose
/// death it is: the game inherits the editor's pipes, so a segfaulting game writes the same line
/// into the same buffer.
fn editor_crashed(facts: &SessionFacts) -> Option<String> {
    if facts.editor_is_running {
        return None;
    }
    facts.crash.clone()
}

/// How recent a crash line must be to be the crash that ended this call.
const CRASH_IS_THIS_CALLS_MS: u64 = 60_000;

/// The crash line, when the **game** died of a signal and the editor that launched it did not.
///
/// [`editor_crashed`] reads the same marker and deliberately answers nothing while an editor is
/// still there, because "the marker on its own does not say whose death it is: the game inherits
/// the editor's pipes, so a segfaulting game writes the same line into the same buffer". That is
/// the right rule for the question it asks, and it leaves the other case unanswered: an editor that
/// is up and a game that is gone.
///
/// Which is a case that happens. Reproduced outside Gofer on 2026-08-27, with a local model server
/// holding both GPUs near full:
///
/// ```text
/// handle_crash: Program crashed with signal 11
/// Engine version: Godot Engine v4.7.2.stable.official
/// [2] 7fa579af5b7c (libnvidia-glcore.so.610.57.04+af5b7c)
/// ```
///
/// A windowed game cannot get a GL context and dies before its first frame. Inside a turn the
/// agent was told `The game started and then stopped before it was ready`, three times, with a
/// carried tail holding one line about a thumbnail and nothing about the crash — because
/// `handle_crash:` is not classified as an error and the tail reads errors only. It ran the game
/// again each time.
///
/// Guarded from the other side: the editor has to still be there, so a marker this reads cannot be
/// the editor's own death, and the same sixty seconds decide whether the crash belongs to the call
/// being answered.
fn the_game_crashed(facts: &SessionFacts) -> Option<String> {
    if !facts.editor_is_running {
        return None;
    }
    let message = facts.crash.as_ref()?;
    Some(format!(
        "The game died of a signal: {}. That is the game process crashing, not this call — \
         running it again will not help until the cause is gone. The backtrace under it is in \
         logs.read.",
        message.trim()
    ))
}

/// Whether there is still an editor process there, which decides whose crash line that was.
///
/// A game the editor launched writes to the editor's own pipes, so a GDExtension fault or a runaway
/// recursion inside the game puts `handle_crash: Program crashed with signal 11` into the one
/// buffer [`editor_crashed`] reads. Nothing in the line says which process printed it. Unguarded,
/// one crashed game turned every later runtime failure of the session into "the Godot editor itself
/// died — retrying will not help", about an editor sitting there ready; and because that branch
/// returns early, it also threw away the parse errors this function exists to attach.
///
/// The question is aliveness, and it is asked of the process rather than of the derived state. A
/// list of live states got that wrong in the case that matters most: `derive_state` answers `Error`
/// for `Readiness::Unavailable`, which is an editor that is *up* with an addon that has stopped
/// answering — the exact state `session_closed` reports. A game that segfaults leaves both a fresh
/// crash marker and a dropped addon socket, with the editor window still open, so the list claimed
/// the engine had died and sent the model off to start a second session. `Staging`, `DebugPaused`
/// and `Stopping` were missing from it too.
///
/// So: `Offline` is no editor, an exited child is a dead one, and everything else is a process that
/// is still there — whatever it is or is not answering.
fn an_editor_is_still_running() -> bool {
    !matches!(current_state(), SessionState::Offline) && !editor_has_exited()
}

/// Puts the error that ended the game into the failure the model is about to read.
///
/// The addon knows the game stopped and does not know why. A GDScript parse error is printed by
/// the engine onto the editor's own stderr and never crosses the debugger bridge, so the addon can
/// only say that nothing answered — which is how `runtime_broke` came to end with "read the error
/// in the session output", and how the call after it answered "The game stopped before it could
/// answer" and named nothing at all.
///
/// Gofer has that text. `godot_logs` reads the very same buffer, and a live run showed the two
/// lines that explained everything sitting in it while the model was told to go and look:
///
/// ```text
/// SCRIPT ERROR: Parse Error: Expected expression after "else".
/// ERROR: Failed to load script "res://scripts/generate_assets.gd" with error "Parse error".
/// ```
///
/// A pointer to a side channel costs a turn, and the turn after a crash is the one the model has
/// least to spare. So the lines travel with the failure instead of being described.
pub(crate) fn carrying_the_error_that_ended_the_game(failure: ToolFailure) -> ToolFailure {
    if !GAME_IS_NOT_ANSWERING.contains(&failure.code.as_str()) {
        return failure;
    }
    explaining(&SessionFacts::gathered(), failure)
}

/// The fold itself: which sentences a failure carries, given what the session looks like.
fn explaining(facts: &SessionFacts, mut failure: ToolFailure) -> ToolFailure {
    if !GAME_IS_NOT_ANSWERING.contains(&failure.code.as_str()) {
        return failure;
    }
    if let Some(crash) = editor_crashed(facts) {
        failure.message = format!(
            "{}\n\nThe Godot editor itself died: {crash}. That is the engine crashing, not this \
             call — retrying it will not help. Start a new session with session.start.",
            failure.message.trim_end()
        );
    }
    if failure.code.starts_with("runtime_") {
        if let Some(crash) = the_game_crashed(facts) {
            failure.message = format!("{}\n\n{crash}", failure.message.trim_end());
        } else if let Some(missing) = the_helper_is_not_installed(facts) {
            failure.message = format!("{}\n\n{missing}", failure.message.trim_end());
        } else if let Some(broken) = the_games_own_scripts_did_not_compile(facts) {
            failure.message = format!("{}\n\n{broken}", failure.message.trim_end());
        } else if let Some(held) = the_debugger_holds_the_game(facts) {
            failure.message = format!("{}\n\n{held}", failure.message.trim_end());
        } else if let Some(armed) = a_breakpoint_is_still_armed(facts) {
            failure.message = format!("{}\n\n{armed}", failure.message.trim_end());
        }
    }
    let printed = &facts.errors;
    if printed.is_empty() {
        return failure;
    }
    failure.message = format!(
        "{}\n\nThe session output ends with:\n{}",
        failure.message.trim_end(),
        printed.join("\n")
    );
    failure
}

/// The runtime operations a game halted in the debugger cannot answer.
///
/// Read out of the addon rather than written again here. `PROCESS_AWAITING_OPS` in
/// `runtime_queue.gd` is where the wait actually happens, so a second copy in Rust would be a
/// second thing to keep in step — and the one that drifted would refuse the wrong calls, silently,
/// in the direction that costs a working call.
///
/// A parse that finds nothing panics rather than answering with an empty list. It used to answer
/// with one, and moving the constant into its own script turned this guard off without failing
/// anything but the one acceptance test that watches a halted game.
static PROCESS_AWAITING_OPS: LazyLock<Vec<String>> = LazyLock::new(|| {
    let source = include_str!("../addon/runtime_queue.gd");
    let list = source
        .split_once("PROCESS_AWAITING_OPS: Array[String] = [")
        .and_then(|(_, rest)| rest.split_once(']'))
        .map(|(list, _)| list)
        .expect("runtime_queue.gd declares PROCESS_AWAITING_OPS as a literal array");
    let ops: Vec<String> = list
        .split(',')
        .filter_map(|word| word.trim().strip_prefix('"')?.strip_suffix('"'))
        .map(str::to_owned)
        .collect();
    assert!(
        !ops.is_empty(),
        "runtime_queue.gd's PROCESS_AWAITING_OPS parsed as empty, which refuses nothing"
    );
    ops
});

/// Refuses a runtime call that waits on the scene tree against a game the debugger has halted.
///
/// The whole point is the twenty seconds it does not spend. A game stopped at a breakpoint is
/// halted, not slow: `runtime.input` and `wait` sit on a process frame it will never run, and the
/// addon can only answer them when their deadline runs out. Counted across every recorded live
/// trace: **21 of those, 20 seconds each, 420 seconds** — one seventh of the time every tool call
/// in the corpus took, in one percent of the calls. `R01-backwards` spent eight in a row against a
/// breakpoint it had set itself, then tried to run the game again three times.
///
/// Both facts are needed and neither is enough. `holds_a_game` says the debugger started this game
/// and not whether it is halted; `debuggee_is_stopped` says the adapter's last word was a stop and
/// not whose game it was about. Together they are the one case where waiting cannot help.
///
/// `capture` was in this list and should never have been. A break stops the scene tree, not the
/// renderer: measured at a live breakpoint on 4.7.2, a capture answered in 140ms with a real PNG,
/// and `get_tree`, `inspect_node` and `get_monitors` answered too — they all run off the debugger
/// message pump, which a halted game still pumps. Refusing them cost the caller the frozen frame a
/// breakpoint exists to show. That asymmetry is `godot_runtime_acceptance`'s
/// `a_game_that_cannot_draw_answers_the_call_that_needs_no_frame`, on a real game.
///
/// Retryable, because it is: the call is right and the game is in the wrong state for it, which is
/// exactly what `godot_debug continue` fixes.
pub(crate) fn a_game_the_debugger_has_halted(op: &str) -> Result<(), ToolFailure> {
    refusing_a_halted_game(
        op,
        crate::debug::holds_a_game(),
        crate::godot_dap::debuggee_is_stopped(),
    )
}

/// The decision itself. Kept apart from the rest of [`SessionFacts`] because this runs before every
/// runtime call, where gathering the others would cost a project-file read per call.
fn refusing_a_halted_game(
    op: &str,
    debugger_holds_a_game: bool,
    debuggee_is_stopped: bool,
) -> Result<(), ToolFailure> {
    if !debugger_holds_a_game || !debuggee_is_stopped {
        return Ok(());
    }
    if !PROCESS_AWAITING_OPS.iter().any(|held_op| held_op == op) {
        return Ok(());
    }
    Err(ToolFailure {
        retryable: true,
        ..ToolFailure::new(
            "game_halted",
            format!(
                "The game is stopped in the debugger, so it runs no frame and runtime.{op} \
                 cannot be answered. Waiting will not change that. debug.continue lets it run \
                 on, and debug.stack_trace says where it is stopped. runtime.get_tree, \
                 runtime.inspect_node and runtime.get_monitors are not refused here — a break \
                 stops the scene tree and not the reads, so a stopped game still answers one."
            ),
        )
    })
}

/// Says so when the game a runtime call is waiting on is one the debugger launched.
///
/// A game stopped at a breakpoint answers nothing: the whole process is halted, so `runtime.input`
/// spends its deadline and comes back `The game did not answer in time`. That sentence reads as a
/// fault, and a live turn read it as one — eight timeouts in a row against a game stopped at a
/// breakpoint the same turn had set, three attempts to run it again on top of those, and the answer
/// waiting at the breakpoint never collected.
///
/// The flag says the debugger launched this game, not that it is halted this instant, and the
/// sentence says exactly that much: it names the call that lets a stopped game run on and leaves
/// the reader to look. Nothing here can be wrong about a game the debugger never started.
fn the_debugger_holds_the_game(facts: &SessionFacts) -> Option<String> {
    facts.debugger_holds_a_game.then(|| {
        "This game was launched by the debugger, and a game stopped at a breakpoint answers \
         nothing until it runs on. If one is set, debug.continue is what lets this call through; \
         debug.stack_trace says where it is stopped."
            .to_owned()
    })
}

/// Says so when the game is not slow, it is broken: its own scripts did not compile.
///
/// `runtime_slow_start` leads with "The game is running and its helper has not answered yet. Read
/// godot_runtime get_state rather than running it again", which is the right sentence for a game
/// that is starting and the wrong one for a game that will never finish.
///
/// **What this does not say, after two attempts at saying it.** The first draft claimed a game whose
/// scripts fail to compile "never reaches the code that announces the Gofer helper", which is false:
/// the helper announces from its own autoload's `_ready`, and an autoload runs before the main
/// scene. The second claimed the project's own autoloads run *ahead* of Gofer's and can stop it
/// loading — true of a project that already had autoloads when the addon was staged, and **false of
/// the run this was written from**: `cer-41-arena`'s kept worktree has `GoferRuntime` first and its
/// own broken `GameManager` second, because the agent registered it during the turn.
///
/// So the mechanism is not known, and this sentence does not invent one. What is known is what was
/// watched: the errors are a compile failure, and the turn waited and re-ran nine times without the
/// helper ever answering. That is what it says.
///
/// Measured on `cer-41-arena`, live: eight `runtime_slow_start` refusals and a forty-five-call
/// loop — `run`, `stop`, `run`, `restart`, `wait` — while the editor printed
/// `SCRIPT ERROR: Parse Error: Could not find type "Enemy" in the current scope` and eleven like
/// it, and the game started cleanly on OpenGL every time. The parse errors were already being
/// carried under the refusal by [`last_session_errors`]; what was missing is the sentence saying
/// they are the cause rather than the background, against a leading sentence that says to wait.
///
/// Only what the engine itself calls a script failure. `SCRIPT ERROR:` covers a parse error and a
/// compile error both, and it is the engine's own prefix — a warning, an `at:` frame or an editor
/// diagnostic is not one, and `last_session_errors` has already dropped the engine's epilogue and
/// the editor's own chatter before this reads them.
fn the_games_own_scripts_did_not_compile(facts: &SessionFacts) -> Option<String> {
    // The editor's language server spells the same failure `ERROR: LSP: Failed to parse script:`
    // — a warning the project treats as an error reached a live turn that way, and only that way.
    if !facts.errors.iter().any(|line| {
        line.starts_with("SCRIPT ERROR: Parse Error:")
            || line.starts_with("SCRIPT ERROR: Compile Error:")
            || line.starts_with("ERROR: LSP: Failed to parse script")
    }) {
        return None;
    }
    Some(
        "The game's own scripts did not compile — the errors below are the engine refusing to run \
         them, not a slow start. Waiting for the helper and reading get_state again will not change \
         that, and stopping and running again reaches the same place. Fix what the errors name and \
         run once more; runtime.run restarts a halted game by itself."
            .to_owned(),
    )
}

/// Says so when a breakpoint this session set is still in the editor, holding a game it never
/// launched.
///
/// The editor holds breakpoints, the debug session does not, and the editor hands them to the
/// **next** game it plays — including one `godot_runtime run` starts, which the debug adapter never
/// hears about. That game stops on its first `_process`, draws nothing, and every frame-awaiting
/// call spends its whole deadline against a game that is not slow.
///
/// `godot_ai_acceptance` disarms its breakpoint before it captures for this reason and says so in
/// its own comment. `sol-35-hud-xhigh` met it live: `godot_debug terminate`, `godot_runtime run`,
/// then a `wait`/`capture`/`stop` that came back `runtime_timeout` twenty seconds later with
/// `scripts/hud.gd` still holding a break — which the turn worked out for itself four calls later
/// and cleared.
///
/// Second, not first. [`the_debugger_holds_the_game`] is about a game the debugger *is* holding and
/// says so more precisely; this is the other case, where the debugger has let go and the breakpoint
/// has not.
fn a_breakpoint_is_still_armed(facts: &SessionFacts) -> Option<String> {
    if facts.armed_breakpoints.is_empty() {
        return None;
    }
    Some(format!(
        "A breakpoint is still set in {}. The editor holds breakpoints rather than the debug \
         session, so it hands them to the next game it plays — including one runtime.run \
         starts — and a game stopped at one draws no frame. Clear it with debug.set_breakpoints \
         and an empty lines list for that file, then run again.",
        facts.armed_breakpoints.join(", ")
    ))
}

/// Says so when the game cannot possibly answer, because its helper is not in the project any more.
///
/// The other three explanations a runtime failure carries all come out of the session output. This
/// one is not in it: the game boots, runs, and prints nothing wrong — it simply has no
/// `GoferRuntime` autoload, so nothing inside it ever announces itself. Every runtime call then
/// waits its full deadline and answers with advice to wait longer, for ever.
///
/// See [`crate::addon::runtime_helper_missing`] for what takes the autoload away under a session
/// that is still running, and why the file rather than the editor is what gets read.
fn the_helper_is_not_installed(facts: &SessionFacts) -> Option<String> {
    if !facts.helper_missing {
        return None;
    }
    Some(
        "The game has no Gofer runtime helper to answer with: project.godot no longer registers \
         the GoferRuntime autoload, so nothing in the game can reply and waiting will not change \
         that. Something rewrote project.godot after this session staged it — a branch switch, a \
         merge, or an edit to the file. Restart the editor with session.stop then session.start, \
         which stages it again."
            .to_owned(),
    )
}

/// How many of the session's last errors travel with a runtime failure.
///
/// Enough for the two lines an engine prints about one bad script — the parse error and the load
/// that failed because of it — and few enough that a buffer full of an earlier problem cannot bury
/// the message it is attached to.
const CARRIED_ERROR_LINES: usize = 6;

/// The most recent error lines the running session printed, oldest of them first.
///
/// Errors only. The `at:` frames and the GDScript backtrace under one are classified as info, and
/// a failure message is not the place for engine internals — what the model needs is the sentence
/// naming the script and what is wrong with it. `godot_logs` is still there for the rest.
///
/// Read backwards. Paging forward for a tail meant reading at most `MAX_LOG_PAGE` matches out of a
/// `MAX_LOG_ENTRIES` buffer and taking the end of *those*, which a game erroring once a frame fills
/// in seconds — after which every failure carried the first six errors of the run and none of the
/// one that had just ended it.
fn last_session_errors(wanted: usize) -> Vec<String> {
    newest_logs(
        &LogQuery {
            min_severity: Some(LogSeverity::Error),
            ..LogQuery::default()
        },
        wanted * 4,
    )
    .into_iter()
    .filter(|entry| {
        belongs_to_the_current_game(entry)
            && !is_about_a_file_changed_since(entry)
            && !is_the_engines_own_epilogue(&entry.message)
            && !is_the_editor_talking_to_itself(&entry.message)
            && !is_a_thumbnail_the_headless_editor_cannot_draw(entry)
    })
    .map(|entry| entry.message)
    .rev()
    .take(wanted)
    .collect::<Vec<_>>()
    .into_iter()
    .rev()
    .collect()
}

/// A game that fails to load prints nothing of its own: the editor printed why beforehand, so a
/// load failure from before the launch still counts and anything else does not.
fn belongs_to_the_current_game(entry: &LogEntry) -> bool {
    entry.sequence > game_launch_cursor()
        || [
            "Parse Error:",
            "Compile Error:",
            "Failed to load script",
            "LSP: Failed to parse",
        ]
        .iter()
        .any(|marker| entry.message.contains(marker))
}

fn is_about_a_file_changed_since(entry: &LogEntry) -> bool {
    let Some(info) = current_info() else {
        return false;
    };
    let Some(path) = the_res_path_in(&entry.message)
        .or_else(|| the_line_after(entry.sequence).and_then(|under| the_res_path_in(&under)))
    else {
        return false;
    };
    std::fs::metadata(std::path::Path::new(&info.worktree).join(path))
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
        .is_some_and(|modified| modified.as_millis() > u128::from(entry.timestamp))
}

/// The project path a line names, as `res://scripts/a.gd` in a message or `(res://scripts/a.gd:4)`
/// in the frame under it.
fn the_res_path_in(line: &str) -> Option<String> {
    let rest = &line[line.find("res://")? + "res://".len()..];
    let end = rest.find([':', '"', ')', '\'']).unwrap_or(rest.len());
    Some(rest[..end].to_owned()).filter(|path| !path.is_empty())
}

/// A line the engine prints while taking itself apart, rather than about the project.
///
/// `runtime_not_running` carried these six lines in two recorded live runs, identically:
///
/// ```text
/// ERROR: BUG: Unreferenced static string to 0: _exists
/// ERROR: BUG: Unreferenced static string to 0: _recognize_path
/// ERROR: BUG: Unreferenced static string to 0: _set_path_cache
/// ERROR: BUG: Unreferenced static string to 0: _reset_state
/// ERROR: BUG: Unreferenced static string to 0: servers
/// ERROR: Pages in use exist at exit in PagedAllocator: N10StringName5_DataE
/// ```
///
/// That is Godot's leak accounting on the way out. It is attached to a failure whose whole job is
/// to carry the error that ended the game, and it says nothing about the game at all — while
/// reading, to a model, exactly like six errors it caused. A game that exited cleanly has no error
/// to carry, and saying nothing is the honest version of that.
///
/// Dropped from the *carried tail* only. `godot_logs read` still answers with every line, which is
/// where a reader who wants the engine's own diagnostics goes.
fn is_the_engines_own_epilogue(message: &str) -> bool {
    message.contains("BUG: Unreferenced static string")
        || message.contains("at exit in PagedAllocator")
        || message.contains("still in use at exit")
        || message.contains("leaked at exit")
}

/// A line the engine prints about the editor's own machinery, rather than about the project.
///
/// The sibling of [`is_the_engines_own_epilogue`], one level up: that one is the engine taking
/// itself apart, this one is the editor's own bookkeeping. Counted across every recorded live
/// trace, **28 of the 35 carried tails held nothing but engine chatter**, in eight runs, and 19 of
/// those 28 occurrences were the one line below — `R01-backwards` was handed it eleven times,
/// attached to "The game did not answer in time".
///
/// ```text
/// ERROR: Couldn't find the given section "res://scripts/player.gd" and key "state", …
///    at: get_value (core/io/config_file.cpp:60)
/// ```
///
/// That is `loading_editor_layout` restoring which script tabs were open, from a cache written by
/// some earlier editor. It is printed **before a game can be launched at all**, so it can never be
/// the error that ended one. In the recorded trace it sits four lines under `[ DONE ]
/// loading_editor_layout` and above the first game's own banner.
///
/// It is matched on the engine's own words and on the key only this cache uses, so nothing a
/// project prints can be mistaken for it. Dropped from the *carried tail* only — `godot_logs read`
/// still answers with every line.
///
/// ### The second line, and where it went
/// ```text
/// ERROR: Parameter "t" is null.
///    at: texture_2d_get (./servers/rendering/dummy/storage/texture_storage.h:110)
///    [0] _scene_save (res://addons/gofer/plugin.gd:…)
/// ```
/// That is the "Creating Thumbnail" step of a scene save asking the **dummy** rendering server for
/// a texture. It was filtered here once and cannot be: `Parameter "t" is null` is `ERR_FAIL_NULL`'s
/// generic wording, several `RenderingServer` entry points emit it, and a *game* that hands one of
/// them a null texture would have had its only diagnostic line dropped. The `at:` line that tells
/// the two apart is a separate entry in the buffer, which this function is not given.
///
/// It is [`is_a_thumbnail_the_headless_editor_cannot_draw`] now, which is given the entry and reads
/// that frame — so the editor's own noise goes and a game's identical sentence stays.
pub(crate) fn is_the_editor_talking_to_itself(message: &str) -> bool {
    message.contains("Couldn't find the given section") && message.contains("key \"state\"")
}

/// The line the session printed immediately after one, whatever its severity.
///
/// The carried tail reads errors only, and the `at:` frame under an error is classified as info —
/// so the one line that says which of two identically worded errors this is cannot be seen from
/// inside that read. Asked for by sequence rather than by paging, and only when a caller has an
/// entry it cannot tell apart, so the ordinary path pays nothing.
fn the_line_after(sequence: u64) -> Option<String> {
    read_logs(&LogQuery {
        after: Some(sequence),
        limit: Some(1),
        ..LogQuery::default()
    })
    .ok()?
    .entries
    .into_iter()
    .next()
    .filter(|entry| entry.sequence == sequence + 1)
    .map(|entry| entry.message)
}

/// A null the **editor** hit drawing a scene thumbnail it has no renderer for.
///
/// ```text
/// [  20% ] save | Creating Thumbnail
/// ERROR: Parameter "t" is null.
///    at: texture_2d_get (./servers/rendering/dummy/storage/texture_storage.h:110)
/// ```
///
/// Every acceptance and live session runs the editor `--headless`, so every `scene.save` asks the
/// **dummy** rendering server for a texture and gets this. It is Godot's own, it is about the
/// editor rather than the game, and it is the only error most of those sessions ever print — so a
/// game that stopped for its own reasons had this handed to it as the reason. One live turn ran the
/// game three times and was given this line, and nothing else, all three.
///
/// It was filtered on its message alone once and that was wrong: `Parameter "t" is null` is
/// `ERR_FAIL_NULL`'s generic wording, several `RenderingServer` entry points emit it, and a *game*
/// handing one of them a null texture would have had its only diagnostic dropped. What tells them
/// apart is the frame under it, which is a separate entry — so this reads that entry rather than
/// guessing from the message, and matches only the dummy driver's own texture storage.
fn is_a_thumbnail_the_headless_editor_cannot_draw(entry: &LogEntry) -> bool {
    entry.message.contains("Parameter \"t\" is null")
        && the_line_after(entry.sequence)
            .is_some_and(|under| under.contains("texture_2d_get") && under.contains("/dummy/"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::godot_session::{
        ExternalEditor, LogSource, MAX_LOG_PAGE, REQUIRED_ENGINE_VERSION, SESSION_TEST_LOCK,
        SessionInfo, append_log, backdate_logs, bind, clear_logs, note_a_game_launch,
    };
    use serde_json::json;

    /// Serializes every test that touches the process-wide session state or log buffer.
    fn session_test_lock() -> std::sync::MutexGuard<'static, ()> {
        SESSION_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Seeds the session log buffer with the output one editor produced, and nothing else.
    fn given_the_session_printed(lines: &[(LogSource, &str)]) {
        clear_logs();
        for (source, line) in lines {
            append_log(*source, &format!("{line}\n"));
        }
    }

    /// The failure the addon answers a runtime call with, before this module has touched it.
    fn addon_failure(code: &str, message: &str) -> ToolFailure {
        ToolFailure {
            code: code.to_owned(),
            message: message.to_owned(),
            retryable: true,
            details: json!({}),
        }
    }

    /// A session with nothing wrong with it, so a test can vary the one fact it is about.
    fn a_session_with_nothing_wrong() -> SessionFacts {
        SessionFacts {
            editor_is_running: true,
            crash: None,
            errors: Vec::new(),
            debugger_holds_a_game: false,
            armed_breakpoints: Vec::new(),
            helper_missing: false,
        }
    }

    #[test]
    fn a_game_with_no_runtime_helper_is_told_that_and_not_to_wait() {
        let _test = session_test_lock();
        given_the_session_printed(&[(LogSource::Editor, "GOFER_ADDON_READY:2")]);
        let worktree = tempfile::TempDir::new().expect("temporary worktree");
        std::fs::write(
            worktree.path().join(crate::addon::PROJECT_FILE),
            "config_version=5\n\n[application]\n\nconfig/name=\"Fixture\"\n",
        )
        .expect("a project with no autoload section");
        bind(Some(std::sync::Arc::new(ExternalEditor::at(
            0,
            0,
            worktree.path(),
        ))));

        let carried = carrying_the_error_that_ended_the_game(addon_failure(
            "runtime_slow_start",
            "The game is running and its helper has not answered yet.",
        ));

        bind(None);
        assert_eq!(carried.code, "runtime_slow_start");
        assert!(
            carried.message.contains("GoferRuntime"),
            "the failure named nothing to fix: {}",
            carried.message
        );
        assert!(
            carried.message.contains("session.start"),
            "the failure offered no way out: {}",
            carried.message
        );
    }

    /// A missing autoload is one half of the answer, and what the engine printed is the other.
    ///
    /// The branch that names it used to return early, which is the very defect the crash branch was
    /// fixed for: a branch switch that takes the autoload away while a script has a parse error
    /// answered with the autoload advice alone, and the model restarted into the same failure.
    #[test]
    fn a_missing_helper_still_carries_what_the_session_printed() {
        let _test = session_test_lock();
        given_the_session_printed(&[
            (LogSource::Editor, "GOFER_ADDON_READY:2"),
            (
                LogSource::EditorError,
                "SCRIPT ERROR: Parse Error: Expected expression after \"else\".",
            ),
        ]);
        let worktree = tempfile::TempDir::new().expect("temporary worktree");
        std::fs::write(
            worktree.path().join(crate::addon::PROJECT_FILE),
            "config_version=5\n\n[application]\n\nconfig/name=\"Fixture\"\n",
        )
        .expect("a project with no autoload section");
        bind(Some(std::sync::Arc::new(ExternalEditor::at(
            0,
            0,
            worktree.path(),
        ))));

        let carried = carrying_the_error_that_ended_the_game(addon_failure(
            "runtime_slow_start",
            "The game is running and its helper has not answered yet.",
        ));

        bind(None);
        assert!(
            carried.message.contains("GoferRuntime"),
            "the failure named nothing to fix: {}",
            carried.message
        );
        assert!(
            carried.message.contains("Expected expression after"),
            "and it threw away what the engine printed: {}",
            carried.message
        );
    }

    #[test]
    fn a_staged_project_is_not_accused_of_losing_its_helper() {
        let _test = session_test_lock();
        given_the_session_printed(&[(LogSource::Editor, "GOFER_ADDON_READY:2")]);
        let worktree = tempfile::TempDir::new().expect("temporary worktree");
        std::fs::write(
            worktree.path().join(crate::addon::PROJECT_FILE),
            format!(
                "config_version=5\n\n[autoload]\n\n{}=\"{}\"\n",
                crate::addon::AUTOLOAD_NAME,
                crate::addon::AUTOLOAD_TARGET
            ),
        )
        .expect("a staged project");
        bind(Some(std::sync::Arc::new(ExternalEditor::at(
            0,
            0,
            worktree.path(),
        ))));

        let carried = carrying_the_error_that_ended_the_game(addon_failure(
            "runtime_slow_start",
            "The game is running and its helper has not answered yet.",
        ));

        bind(None);
        assert!(
            !carried.message.contains("GoferRuntime"),
            "a staged project was accused of losing its helper: {}",
            carried.message
        );
    }

    /// The editor's language server spells a compile failure its own way, and a warning the
    /// project treats as an error reaches the session only that way.
    #[test]
    fn a_parse_failure_the_language_server_reported_is_a_compile_failure_too() {
        let _test = session_test_lock();
        given_the_session_printed(&[
            (LogSource::Editor, "GOFER_ADDON_READY:2"),
            (
                LogSource::EditorError,
                "ERROR: LSP: Failed to parse script: res://scripts/player.gd",
            ),
        ]);
        let carried = carrying_the_error_that_ended_the_game(addon_failure(
            "runtime_slow_start",
            "The game is running and its helper has not answered yet.",
        ));
        assert!(
            carried.message.contains("did not compile"),
            "a parse failure was read as a slow start: {}",
            carried.message
        );
    }

    /**
     * A crashed game reaches the model with the error that crashed it.
     *
     * Observed in a live run against a blank project: the game stopped on a parse error, the model
     * was told to "read the error in the session output", and the next `godot_runtime run` answered
     * "The game stopped before it could answer". Two failures, no cause, while both lines that
     * explained it sat in the buffer this reads.
     */
    #[test]
    fn a_dead_game_answers_with_the_error_that_killed_it() {
        let _test = session_test_lock();
        given_the_session_printed(&[
            (LogSource::Editor, "GOFER_ADDON_READY:2"),
            (
                LogSource::EditorError,
                "SCRIPT ERROR: Parse Error: Expected expression after \"else\".",
            ),
            (
                LogSource::EditorError,
                "ERROR: Failed to load script \"res://scripts/generate_assets.gd\" with error \
                 \"Parse error\".",
            ),
        ]);

        let carried = carrying_the_error_that_ended_the_game(addon_failure(
            "runtime_not_running",
            "The game stopped before it could answer",
        ));

        assert_eq!(carried.code, "runtime_not_running");
        assert!(
            carried
                .message
                .contains("The game stopped before it could answer"),
            "the failure lost what it already said: {}",
            carried.message
        );
        assert!(
            carried
                .message
                .contains("Parse Error: Expected expression after \"else\""),
            "the failure named no cause: {}",
            carried.message
        );
        assert!(
            carried.message.contains("scripts/generate_assets.gd"),
            "the failure named no file to go and fix: {}",
            carried.message
        );
    }

    /// When the editor itself dies, the failure says so instead of describing a game.
    ///
    /// Godot 4.7.2 segfaults on being asked to play a project whose script will not parse. Watched
    /// three times in one night, and what reached the model was `session_closed: The RPC session
    /// closed` — true, and no help at all: two of those three runs spent their whole budget
    /// retrying a call that could never work.
    ///
    /// The crash line arrives on the editor's stderr and is not classified as an error, which is
    /// why the reader that carries error lines never saw it and why this one reads without a floor.
    #[test]
    fn an_editor_that_crashed_is_named_as_the_thing_that_broke() {
        let _guard = session_test_lock();
        given_the_session_printed(&[
            (
                LogSource::EditorError,
                "SCRIPT ERROR: Parse Error: Function \"add_child_node()\" not found in base self.",
            ),
            (
                LogSource::EditorError,
                "handle_crash: Program crashed with signal 11",
            ),
        ]);

        let carried = carrying_the_error_that_ended_the_game(addon_failure(
            "session_closed",
            "The RPC session closed",
        ));

        assert_eq!(carried.code, "session_closed");
        assert!(
            carried.message.contains("The RPC session closed"),
            "the failure lost what it already said: {}",
            carried.message
        );
        assert!(
            carried.message.contains("Program crashed with signal 11"),
            "the crash has to be in it: {}",
            carried.message
        );
        assert!(
            carried.message.contains("session.start"),
            "and the one thing worth doing about it: {}",
            carried.message
        );
        assert!(
            carried.message.contains("retrying it will not help"),
            "a crash is not something to retry: {}",
            carried.message
        );
    }

    /// A game that crashed is not the editor crashing, however alike the two lines look.
    ///
    /// The game the editor launches inherits the editor's pipes, so its `handle_crash:` line lands
    /// in the very buffer the crash check reads. Unguarded, one segfaulting game told the model for
    /// the rest of the session that the engine had died and there was no point retrying — while the
    /// editor sat there ready — and dropped the parse error that had actually ended the game.
    #[test]
    fn a_game_that_crashed_does_not_get_reported_as_a_dead_editor() {
        let _test = session_test_lock();
        given_the_session_printed(&[
            (
                LogSource::EditorError,
                "SCRIPT ERROR: Invalid access to property or key 'velocity' on a base object of \
                 type 'Node2D'.",
            ),
            (
                LogSource::EditorError,
                "handle_crash: Program crashed with signal 11",
            ),
        ]);
        let worktree = tempfile::TempDir::new().expect("temporary worktree");
        std::fs::write(
            worktree.path().join(crate::addon::PROJECT_FILE),
            format!(
                "config_version=5\n\n[autoload]\n\n{}=\"{}\"\n",
                crate::addon::AUTOLOAD_NAME,
                crate::addon::AUTOLOAD_TARGET
            ),
        )
        .expect("a staged project");
        bind(Some(std::sync::Arc::new(ExternalEditor::at(
            0,
            0,
            worktree.path(),
        ))));

        let carried = carrying_the_error_that_ended_the_game(addon_failure(
            "runtime_broke",
            "The game stopped at an error while starting",
        ));

        bind(None);
        assert!(
            !carried.message.contains("The Godot editor itself died"),
            "a live editor was accused of dying: {}",
            carried.message
        );
        assert!(
            carried
                .message
                .contains("Invalid access to property or key 'velocity'"),
            "and the error that did end the game was thrown away with it: {}",
            carried.message
        );
    }

    /// A game that died of a signal is told so, while the editor that launched it is still there.
    ///
    /// Reproduced outside Gofer on 2026-08-27: a windowed Godot 4.7.2 game segfaults inside
    /// `libnvidia-glcore` before its first frame when a local model server holds both GPUs near
    /// full. Inside a turn the agent was told `The game started and then stopped before it was
    /// ready` three times and given nothing about the crash — `handle_crash:` is classified as
    /// info, so the carried tail, which reads errors only, never sees it, and `editor_crashed`
    /// deliberately answers nothing while an editor is still running.
    #[test]
    fn a_game_that_died_of_a_signal_is_named_as_the_reason_the_call_failed() {
        let _test = session_test_lock();
        given_the_session_printed(&[
            (
                LogSource::Editor,
                "handle_crash: Program crashed with signal 11",
            ),
            (
                LogSource::Editor,
                "[2] 7fa579af5b7c (libnvidia-glcore.so.610.57.04+af5b7c)",
            ),
        ]);
        let worktree = tempfile::TempDir::new().expect("temporary worktree");
        std::fs::write(
            worktree.path().join(crate::addon::PROJECT_FILE),
            format!(
                "config_version=5\n\n[autoload]\n\n{}=\"{}\"\n",
                crate::addon::AUTOLOAD_NAME,
                crate::addon::AUTOLOAD_TARGET
            ),
        )
        .expect("a staged project");
        bind(Some(std::sync::Arc::new(ExternalEditor::at(
            0,
            0,
            worktree.path(),
        ))));

        let carried = carrying_the_error_that_ended_the_game(addon_failure(
            "runtime_not_running",
            "The game started and then stopped before it was ready",
        ));

        bind(None);
        assert!(
            carried.message.contains("died of a signal")
                && carried.message.contains("Program crashed with signal 11"),
            "the crash is what ended the game and has to be named: {}",
            carried.message
        );
        assert!(
            !carried.message.contains("The Godot editor itself died"),
            "a live editor was accused of dying: {}",
            carried.message
        );
    }

    /// A runtime failure with no crash line behind it says nothing about one.
    #[test]
    fn a_runtime_failure_with_no_crash_behind_it_names_no_crash() {
        let _test = session_test_lock();
        given_the_session_printed(&[(
            LogSource::EditorError,
            "SCRIPT ERROR: Parse Error: Expected expression after \"else\".",
        )]);
        let worktree = tempfile::TempDir::new().expect("temporary worktree");
        std::fs::write(
            worktree.path().join(crate::addon::PROJECT_FILE),
            format!(
                "config_version=5\n\n[autoload]\n\n{}=\"{}\"\n",
                crate::addon::AUTOLOAD_NAME,
                crate::addon::AUTOLOAD_TARGET
            ),
        )
        .expect("a staged project");
        bind(Some(std::sync::Arc::new(ExternalEditor::at(
            0,
            0,
            worktree.path(),
        ))));

        let carried = carrying_the_error_that_ended_the_game(addon_failure(
            "runtime_not_running",
            "The game started and then stopped before it was ready",
        ));

        bind(None);
        assert!(
            !carried.message.contains("died of a signal"),
            "nothing crashed: {}",
            carried.message
        );
        assert!(
            carried.message.contains("Expected expression after"),
            "and the parse error still travels: {}",
            carried.message
        );
    }

    /// `Error` is not the same as gone: it is also what a live editor with a silent addon reads as.
    ///
    /// `derive_state` answers `Error` for `Readiness::Unavailable`, which is the editor up and the
    /// addon not answering — the exact state `session_closed` reports. A game that segfaults leaves
    /// a fresh crash marker AND drops the addon socket, with the editor window still open, so a
    /// guard written as a list of live states claimed the engine had died and sent the model off to
    /// start a second session against the one that was already running.
    #[test]
    fn an_editor_whose_addon_went_quiet_is_not_reported_as_dead() {
        let _test = session_test_lock();
        given_the_session_printed(&[
            (
                LogSource::EditorError,
                "SCRIPT ERROR: Parse Error: Expected expression after \"else\".",
            ),
            (
                LogSource::EditorError,
                "handle_crash: Program crashed with signal 11",
            ),
        ]);
        let worktree = tempfile::TempDir::new().expect("temporary worktree");
        bind(Some(std::sync::Arc::new(ExternalEditor::new(
            SessionInfo {
                session_id: "external".to_owned(),
                state: SessionState::Error,
                rpc_address: String::new(),
                lsp_port: 0,
                dap_port: 0,
                godot_version: REQUIRED_ENGINE_VERSION.to_owned(),
                worktree: worktree.path().display().to_string(),
                headless: true,
            },
        ))));

        let carried = carrying_the_error_that_ended_the_game(addon_failure(
            "session_closed",
            "The RPC session closed",
        ));

        bind(None);
        assert!(
            !carried.message.contains("The Godot editor itself died"),
            "a live editor with a quiet addon was accused of dying: {}",
            carried.message
        );
        assert!(
            carried.message.contains("Expected expression after"),
            "and the error that did end the game went with it: {}",
            carried.message
        );
    }

    #[test]
    fn a_crash_from_earlier_in_the_session_is_not_this_calls_crash() {
        let _test = session_test_lock();
        given_the_session_printed(&[
            (
                LogSource::EditorError,
                "handle_crash: Program crashed with signal 11",
            ),
            (
                LogSource::EditorError,
                "SCRIPT ERROR: Parse Error: Expected expression after \"else\".",
            ),
        ]);
        backdate_logs(10 * 60 * 1000);
        bind(None);

        let carried = carrying_the_error_that_ended_the_game(addon_failure(
            "runtime_not_running",
            "The game stopped before it could answer",
        ));

        assert!(
            !carried.message.contains("The Godot editor itself died"),
            "an old game crash was reported as the editor's death: {}",
            carried.message
        );
        assert!(
            carried.message.contains("Expected expression after"),
            "and the error that did end the game went with it: {}",
            carried.message
        );
    }

    /// A crash that did just happen says so, and still carries what the engine printed on its way.
    ///
    /// The saying and the carrying used to be exclusive: naming the crash returned early, so the
    /// parse errors this function exists to attach were dropped exactly when the model had least
    /// context to spare.
    #[test]
    fn an_editor_that_just_died_says_so_and_still_carries_what_it_printed() {
        let _test = session_test_lock();
        given_the_session_printed(&[
            (
                LogSource::EditorError,
                "SCRIPT ERROR: Parse Error: Expected expression after \"else\".",
            ),
            (
                LogSource::EditorError,
                "handle_crash: Program crashed with signal 11",
            ),
        ]);
        bind(None);

        let carried = carrying_the_error_that_ended_the_game(addon_failure(
            "runtime_not_running",
            "The game stopped before it could answer",
        ));

        assert!(
            carried.message.contains("The Godot editor itself died"),
            "{}",
            carried.message
        );
        assert!(
            carried.message.contains("Expected expression after"),
            "the crash branch threw away what the engine printed: {}",
            carried.message
        );
    }

    /// The carried errors are the session's last ones, not its first ones.
    ///
    /// The reader pages forward: it answers with the first matches after its cursor and stops at
    /// `MAX_LOG_PAGE`, which is a quarter of the buffer. A game erroring once per `_process` frame
    /// fills that page in seconds, and every failure after it carried six lines from the start of
    /// the run while the one that ended the game sat further down.
    #[test]
    fn a_buffer_full_of_earlier_errors_still_carries_the_last_one() {
        let _test = session_test_lock();
        clear_logs();
        for index in 0..(MAX_LOG_PAGE + 10) {
            append_log(
                LogSource::EditorError,
                &format!("SCRIPT ERROR: frame {index} went wrong again\n"),
            );
        }
        append_log(
            LogSource::EditorError,
            "SCRIPT ERROR: Parse Error: Expected expression after \"else\".\n",
        );

        let carried = carrying_the_error_that_ended_the_game(addon_failure(
            "runtime_broke",
            "The game stopped before it could answer",
        ));

        assert!(
            carried.message.contains("Expected expression after"),
            "the last error is the one it exists to carry: {}",
            carried.message
        );
        assert!(
            !carried.message.contains("frame 0 went wrong"),
            "and it carried the start of the run instead: {}",
            carried.message
        );
    }

    /// The `read the error in the session output` pointer is replaced by the error itself.
    #[test]
    fn a_broken_game_stops_pointing_at_a_side_channel() {
        let _test = session_test_lock();
        given_the_session_printed(&[(
            LogSource::EditorError,
            "SCRIPT ERROR: Invalid access to property or key 'velocity' on a base object of type \
             'Node2D'.",
        )]);

        let carried = carrying_the_error_that_ended_the_game(addon_failure(
            "runtime_broke",
            "The game stopped at an error while starting and is paused in the debugger; read the \
             error in the session output, fix it, and run again",
        ));

        assert!(
            carried
                .message
                .contains("Invalid access to property or key 'velocity'"),
            "the failure named no cause: {}",
            carried.message
        );
    }

    /// A timeout against a game the debugger launched says where the game probably is.
    ///
    /// `The game did not answer in time` is what a game stopped at a breakpoint answers, because a
    /// halted process answers nothing. One live turn read that as a fault: eight timeouts in a row
    /// against a breakpoint it had set itself, three attempts to run the game again on top, and the
    /// answer waiting at the breakpoint never collected.
    #[test]
    fn a_timeout_against_the_debuggers_own_game_names_the_call_that_frees_it() {
        let held = explaining(
            &SessionFacts {
                debugger_holds_a_game: true,
                ..a_session_with_nothing_wrong()
            },
            addon_failure("runtime_timeout", "The game did not answer in time"),
        );
        assert!(held.message.contains("debug.continue"), "{}", held.message);

        let alone = explaining(
            &a_session_with_nothing_wrong(),
            addon_failure("runtime_timeout", "The game did not answer in time"),
        );
        assert_eq!(alone.message, "The game did not answer in time");
    }

    /// The operations a halted game cannot serve are the addon's list, not a second copy of it.
    ///
    /// A drift here is silent and costs a working call: an operation this list gained that Rust
    /// never heard of would go on spending its deadline, and one Rust invented would be refused
    /// against a game that could have answered it.
    #[test]
    fn the_process_awaiting_operations_are_the_addons_own() {
        assert_eq!(
            *PROCESS_AWAITING_OPS,
            vec!["capture".to_owned(), "input".to_owned(), "wait".to_owned()],
            "runtime_queue.gd's PROCESS_AWAITING_OPS is what this reads, and the parse answered otherwise"
        );
    }

    /// A frame-awaiting call against a halted game is refused now rather than in twenty seconds.
    ///
    /// Both flags are needed, and the test says so by turning each off in turn: a game the
    /// debugger never started is not this situation whatever the adapter last said, and a game it
    /// started and let run answers a frame like any other.
    #[test]
    fn a_frame_awaiting_call_against_a_halted_game_is_refused_at_once() {
        let refused = refusing_a_halted_game("input", true, true)
            .expect_err("a halted game cannot answer a call that waits for a frame");
        assert_eq!(refused.code, "game_halted");
        assert!(refused.retryable, "continue is what makes this call work");
        assert!(
            refused.message.contains("debug.continue"),
            "{}",
            refused.message
        );
        assert!(
            refused.message.contains("inspect_node") && refused.message.contains("get_tree"),
            "{}",
            refused.message
        );

        assert!(refusing_a_halted_game("inspect_node", true, true).is_ok());
        assert!(refusing_a_halted_game("get_tree", true, true).is_ok());
        assert!(refusing_a_halted_game("input", true, false).is_ok());
        assert!(refusing_a_halted_game("input", false, true).is_ok());
    }

    /// A breakpoint the editor still holds is named when a runtime call cannot be answered.
    ///
    /// The case `the_debugger_holds_the_game` cannot reach: the debugger has let go — `terminate`,
    /// then `godot_runtime run` — and the breakpoint has not, because the editor holds it and hands
    /// it to the next game it plays. `sol-35-hud-xhigh` spent twenty seconds there.
    #[test]
    fn a_timeout_with_a_breakpoint_still_set_names_the_file_holding_it() {
        let armed = SessionFacts {
            armed_breakpoints: vec!["scripts/hud.gd".to_owned()],
            ..a_session_with_nothing_wrong()
        };

        let carried = explaining(
            &armed,
            addon_failure("runtime_timeout", "The game did not answer in time"),
        );
        assert!(
            carried.message.contains("scripts/hud.gd"),
            "{}",
            carried.message
        );
        assert!(
            carried.message.contains("set_breakpoints"),
            "{}",
            carried.message
        );

        let held = explaining(
            &SessionFacts {
                debugger_holds_a_game: true,
                ..armed
            },
            addon_failure("runtime_timeout", "The game did not answer in time"),
        );
        assert!(held.message.contains("debug.continue"), "{}", held.message);
        assert!(
            !held.message.contains("still set in"),
            "one sentence or the other, never both: {}",
            held.message
        );

        let alone = explaining(
            &a_session_with_nothing_wrong(),
            addon_failure("runtime_timeout", "The game did not answer in time"),
        );
        assert_eq!(alone.message, "The game did not answer in time");
    }

    /// A game whose scripts did not compile is told it is broken, not that it is slow.
    ///
    /// `runtime_slow_start` leads with "read get_state rather than running it again", which is
    /// advice for a game that is starting. `cer-41-arena` followed it into a forty-five-call loop —
    /// `run`, `stop`, `run`, `restart`, `wait`, nine times over — while the editor printed twelve
    /// parse errors and the game started cleanly on OpenGL every time.
    #[test]
    fn a_game_whose_scripts_did_not_compile_is_not_described_as_starting() {
        let _test = session_test_lock();
        given_the_session_printed(&[(
            LogSource::EditorError,
            "SCRIPT ERROR: Parse Error: Could not find type \"Enemy\" in the current scope.",
        )]);

        let carried = carrying_the_error_that_ended_the_game(addon_failure(
            "runtime_slow_start",
            "The game is running and its helper has not answered yet",
        ));
        assert!(
            carried.message.contains("did not compile"),
            "{}",
            carried.message
        );
        assert!(
            carried.message.contains("will not change that"),
            "{}",
            carried.message
        );
        assert!(
            !carried.message.contains("autoload"),
            "the sentence must not explain a mechanism nobody has measured: {}",
            carried.message
        );

        given_the_session_printed(&[(LogSource::Editor, "Godot Engine v4.7.2.stable")]);
        let quiet = carrying_the_error_that_ended_the_game(addon_failure(
            "runtime_slow_start",
            "The game is running and its helper has not answered yet",
        ));
        assert_eq!(
            quiet.message,
            "The game is running and its helper has not answered yet"
        );
    }

    /// The engine's own shutdown accounting is not the error that ended the game.
    ///
    /// Two live runs carried exactly these six lines with `runtime_not_running`, and nothing else.
    /// They name no script, no line and no cause — they are Godot's leak tracking on the way out —
    /// and to a model they read like six errors it caused, attached to a failure whose whole job
    /// is to say what went wrong.
    #[test]
    fn the_engines_shutdown_notes_are_not_carried_as_the_cause() {
        let _test = session_test_lock();
        given_the_session_printed(&[
            (
                LogSource::EditorError,
                "ERROR: BUG: Unreferenced static string to 0: _exists",
            ),
            (
                LogSource::EditorError,
                "ERROR: BUG: Unreferenced static string to 0: _recognize_path",
            ),
            (
                LogSource::EditorError,
                "ERROR: BUG: Unreferenced static string to 0: _set_path_cache",
            ),
            (
                LogSource::EditorError,
                "ERROR: BUG: Unreferenced static string to 0: _reset_state",
            ),
            (
                LogSource::EditorError,
                "ERROR: BUG: Unreferenced static string to 0: servers",
            ),
            (
                LogSource::EditorError,
                "ERROR: Pages in use exist at exit in PagedAllocator: N10StringName5_DataE",
            ),
        ]);

        let carried = carrying_the_error_that_ended_the_game(addon_failure(
            "runtime_not_running",
            "No game with the Gofer runtime helper is running",
        ));

        assert_eq!(
            carried.message, "No game with the Gofer runtime helper is running",
            "a game that exited cleanly has no error to carry, and saying nothing is the honest \
             version of that"
        );
    }

    /// The editor talking to itself is not the error that ended the game either.
    ///
    /// Counted across every recorded live trace: **28 of the 35 carried tails were nothing but
    /// these two lines**, in eight runs. `R01-backwards` was handed them eleven times.
    ///
    /// Both were traced to where they come from rather than guessed at:
    ///
    /// * `Couldn't find the given section "res://….gd" and key "state"` is `config_file.cpp:60`,
    ///   printed once during `loading_editor_layout` while the editor restores which script tabs
    ///   were open. It is older than any game in the session — it happens before one can be
    ///   launched — and it was carried as the reason a game did not answer.
    /// * `Parameter "t" is null` is `texture_2d_get` in the **dummy** rendering server, printed by
    ///   the "Creating Thumbnail" step of a scene save with no renderer to make one. Reproduced on
    ///   demand under the acceptance harness, backtrace and all.
    ///
    /// Neither can ever be about the project, so neither can ever be the answer this function
    /// exists to carry. `godot_logs read` still answers with both, which is where a reader who
    /// wants the engine's own diagnostics goes.
    #[test]
    fn the_editors_own_startup_chatter_is_not_carried_as_the_cause() {
        let _test = session_test_lock();
        given_the_session_printed(&[(
            LogSource::EditorError,
            "ERROR: Couldn't find the given section \"res://scripts/player.gd\" and key \
                 \"state\", and no default was given.",
        )]);

        let carried = carrying_the_error_that_ended_the_game(addon_failure(
            "runtime_timeout",
            "The game did not answer in time",
        ));

        assert_eq!(
            carried.message, "The game did not answer in time",
            "the editor's own chatter was carried as the cause"
        );

        given_the_session_printed(&[(LogSource::EditorError, "ERROR: Parameter \"t\" is null.")]);
        assert!(
            carrying_the_error_that_ended_the_game(addon_failure(
                "runtime_timeout",
                "The game did not answer in time",
            ))
            .message
            .contains("Parameter"),
            "a line only the engine can disambiguate must not be guessed at"
        );
    }

    /// And a real error printed after that chatter is still the one carried.
    #[test]
    fn an_error_after_the_editors_chatter_is_still_the_one_carried() {
        let _test = session_test_lock();
        given_the_session_printed(&[
            (
                LogSource::EditorError,
                "ERROR: Couldn't find the given section \"res://scripts/player.gd\" and key \
                 \"state\", and no default was given.",
            ),
            (
                LogSource::EditorError,
                "SCRIPT ERROR: Parse Error: Expected expression after \"else\".",
            ),
        ]);

        let carried = carrying_the_error_that_ended_the_game(addon_failure(
            "runtime_not_running",
            "No game with the Gofer runtime helper is running",
        ));

        assert!(
            carried.message.contains("Expected expression after"),
            "the parse error is what ended it: {}",
            carried.message
        );
        assert!(
            !carried.message.contains("given section"),
            "and the chatter went with it: {}",
            carried.message
        );
    }

    /// And the real cause still travels, even when the epilogue printed after it.
    #[test]
    fn an_error_before_the_shutdown_notes_is_still_the_one_carried() {
        let _test = session_test_lock();
        given_the_session_printed(&[
            (
                LogSource::EditorError,
                "SCRIPT ERROR: Parse Error: Expected expression after \"else\".",
            ),
            (
                LogSource::EditorError,
                "ERROR: BUG: Unreferenced static string to 0: _exists",
            ),
            (
                LogSource::EditorError,
                "ERROR: Pages in use exist at exit in PagedAllocator: N10StringName5_DataE",
            ),
        ]);

        let carried = carrying_the_error_that_ended_the_game(addon_failure(
            "runtime_not_running",
            "No game with the Gofer runtime helper is running",
        ));

        assert!(
            carried.message.contains("Expected expression after"),
            "the parse error is what ended it: {}",
            carried.message
        );
        assert!(
            !carried.message.contains("Unreferenced static string"),
            "and the epilogue is not beside it: {}",
            carried.message
        );
    }

    /// The thumbnail a headless editor cannot draw is not the reason a game stopped.
    ///
    /// Every acceptance and live session runs the editor `--headless`, so every `scene.save` prints
    /// this pair. One live turn ran the game three times and each `runtime_not_running` carried
    /// exactly this one line and nothing else — the editor's own noise, offered as the cause.
    #[test]
    fn the_headless_editors_thumbnail_null_is_not_carried_as_the_games_error() {
        let _test = session_test_lock();
        given_the_session_printed(&[
            (LogSource::Editor, "[  20% ] save | Creating Thumbnail"),
            (LogSource::EditorError, "ERROR: Parameter \"t\" is null."),
            (
                LogSource::EditorError,
                "   at: texture_2d_get (./servers/rendering/dummy/storage/texture_storage.h:110)",
            ),
        ]);

        let carried = carrying_the_error_that_ended_the_game(addon_failure(
            "runtime_not_running",
            "No game with the Gofer runtime helper is running",
        ));

        assert_eq!(
            carried.message, "No game with the Gofer runtime helper is running",
            "the editor's thumbnail is not the game's error: {}",
            carried.message
        );
    }

    /// The same sentence from a game keeps travelling, because the frame under it is not the
    /// dummy driver's.
    ///
    /// `Parameter "t" is null` is `ERR_FAIL_NULL`'s generic wording and several `RenderingServer`
    /// entry points emit it, so filtering it by message alone would drop a real game's only
    /// diagnostic line.
    #[test]
    fn a_games_own_null_texture_is_still_the_error_that_is_carried() {
        let _test = session_test_lock();
        given_the_session_printed(&[
            (LogSource::EditorError, "ERROR: Parameter \"t\" is null."),
            (
                LogSource::EditorError,
                "   at: texture_2d_get (servers/rendering/renderer_rd/storage_rd/texture_storage.cpp:1)",
            ),
        ]);

        let carried = carrying_the_error_that_ended_the_game(addon_failure(
            "runtime_not_running",
            "No game with the Gofer runtime helper is running",
        ));

        assert!(
            carried.message.contains("Parameter \"t\" is null"),
            "a null the game hit is still what ended it: {}",
            carried.message
        );
    }

    /// A buffer with nothing wrong in it leaves the failure exactly as the addon wrote it.
    #[test]
    fn a_runtime_failure_with_no_error_to_carry_is_left_alone() {
        let _test = session_test_lock();
        given_the_session_printed(&[(LogSource::Editor, "Godot Engine v4.7.2.stable")]);

        let carried = carrying_the_error_that_ended_the_game(addon_failure(
            "runtime_timeout",
            "The game did not answer in time",
        ));

        assert_eq!(carried.message, "The game did not answer in time");
    }

    /// A fault in the request is not a fault in the game, and gains nothing from the game's output.
    #[test]
    fn a_request_the_game_refused_carries_no_session_output() {
        let _test = session_test_lock();
        given_the_session_printed(&[(
            LogSource::EditorError,
            "SCRIPT ERROR: something unrelated went wrong earlier",
        )]);

        let carried = carrying_the_error_that_ended_the_game(addon_failure(
            "unsupported_value",
            "A value must be a tagged object with a type and a value",
        ));

        assert_eq!(
            carried.message,
            "A value must be a tagged object with a type and a value"
        );
    }

    /// A worktree holding one script, last written `age` ago, bound as the session's.
    fn a_session_on_a_script_written(age: std::time::Duration) -> tempfile::TempDir {
        let worktree = tempfile::TempDir::new().expect("temporary worktree");
        std::fs::create_dir_all(worktree.path().join("scripts")).expect("scripts directory");
        let script = worktree.path().join("scripts/probe.gd");
        std::fs::write(&script, "extends Node\n").expect("write the script");
        std::fs::File::options()
            .write(true)
            .open(&script)
            .and_then(|file| file.set_modified(std::time::SystemTime::now() - age))
            .expect("age the script");
        bind(Some(std::sync::Arc::new(ExternalEditor::at(
            0,
            0,
            worktree.path(),
        ))));
        worktree
    }

    const PARSE_ERROR_IN_PROBE: [(LogSource, &str); 2] = [
        (
            LogSource::EditorError,
            "SCRIPT ERROR: Parse Error: Function \"PoolVector2Array()\" not found in base self.",
        ),
        (
            LogSource::EditorError,
            "          at: GDScript::reload (res://scripts/probe.gd:4)",
        ),
    ];

    /// city, 2026-09-17 11:35: the index errors of a game run fourteen minutes earlier went out
    /// under the run that failed on a missing node.
    #[test]
    fn an_error_from_an_earlier_game_is_not_carried_for_this_one() {
        let _test = session_test_lock();
        given_the_session_printed(&[(
            LogSource::EditorError,
            "ERROR: Index p_x = 256 is out of bounds (width = 256).",
        )]);
        note_a_game_launch();
        append_log(
            LogSource::EditorError,
            "ERROR: Node not found: \"Light\" (relative to \"/root/LampTest\").\n",
        );

        let carried = carrying_the_error_that_ended_the_game(addon_failure(
            "runtime_timeout",
            "The game did not answer in time",
        ));

        assert!(
            carried.message.contains("Node not found"),
            "{}",
            carried.message
        );
        assert!(
            !carried.message.contains("p_x"),
            "an earlier game's error was carried: {}",
            carried.message
        );
    }

    /// The editor prints a parse error and the game it then runs prints nothing of its own, so a
    /// parse error from before the launch still explains it while the script is unchanged.
    #[test]
    fn a_parse_error_printed_before_the_run_still_explains_it() {
        let _test = session_test_lock();
        let _worktree = a_session_on_a_script_written(std::time::Duration::from_secs(60));
        given_the_session_printed(&PARSE_ERROR_IN_PROBE);
        note_a_game_launch();

        let carried = carrying_the_error_that_ended_the_game(addon_failure(
            "runtime_slow_start",
            "The game is running and its helper has not answered yet",
        ));

        bind(None);
        assert!(
            carried.message.contains("did not compile"),
            "{}",
            carried.message
        );
        assert!(
            carried.message.contains("PoolVector2Array"),
            "{}",
            carried.message
        );
    }

    /// city, 2026-09-17 10:09: parse errors about a version of the script already saved over,
    /// with clean diagnostics, were carried as the reason its run failed.
    #[test]
    fn a_parse_error_about_a_script_saved_since_is_not_carried() {
        let _test = session_test_lock();
        given_the_session_printed(&PARSE_ERROR_IN_PROBE);
        backdate_logs(60 * 1000);
        let _worktree = a_session_on_a_script_written(std::time::Duration::ZERO);
        note_a_game_launch();

        let carried = carrying_the_error_that_ended_the_game(addon_failure(
            "runtime_not_running",
            "The game stopped before it could answer",
        ));

        bind(None);
        assert!(
            !carried.message.contains("did not compile")
                && !carried.message.contains("PoolVector2Array"),
            "a parse error the script was saved over was carried: {}",
            carried.message
        );
    }

    /// Godot prefixes a runtime error with `SCRIPT ERROR:` too.
    #[test]
    fn a_runtime_script_error_is_not_called_a_compile_failure() {
        let _test = session_test_lock();
        given_the_session_printed(&[(
            LogSource::EditorError,
            "SCRIPT ERROR: Invalid access to property or key 'energy' on a base object of type 'null instance'.",
        )]);

        let carried = carrying_the_error_that_ended_the_game(addon_failure(
            "runtime_not_running",
            "The game stopped before it could answer",
        ));

        assert!(
            carried.message.contains("Invalid access"),
            "{}",
            carried.message
        );
        assert!(
            !carried.message.contains("did not compile"),
            "a runtime error was called a compile failure: {}",
            carried.message
        );
    }
}

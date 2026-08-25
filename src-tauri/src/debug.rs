//! Debugging for the renderer and the agent.
//!
//! [`crate::godot_dap`] owns the protocol; this module owns the *session*: one lazily connected
//! adapter bound to the active session's `--dap-port`, keyed by port and worktree so a restarted
//! editor reconnects instead of writing into a dead socket. Both the UI's debugger panel and the
//! agent's `godot_debug` tool come through here, which is what keeps a launch the user started and
//! a launch the agent started from being two different code paths.
//!
//! Two Godot behaviours shape the API. A `launch` is only answered once `configurationDone` spawns
//! the game, so [`DebugRequest::Launch`] carries the breakpoints to install and performs the whole
//! sequence — launch on its own thread, `setBreakpoints`, `configurationDone`, join — rather than
//! exposing an order the caller can get wrong. And stopping is an event, not a response, so
//! [`DebugRequest::AwaitStop`] is a request in its own right: run, then wait for the stop, then
//! inspect.

use crate::files::{FileError, Workspace};
use crate::godot_dap::{
    Breakpoint, BreakpointLocation, DapCapabilities, DapClient, DapError, DapEvent, DebugThread,
    EvaluateResult, Scope, StackFrame, StepOutcome, StoppedDetails, Variable,
};
use crate::godot_session;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Receiver;
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Godot debugs exactly one thread, and every request that takes a thread id defaults to it.
pub const MAIN_THREAD_ID: i64 = 1;
/// How long [`DebugRequest::AwaitStop`] waits by default. Long enough for a game to boot and reach
/// a breakpoint on a loaded machine, short enough that a wait cannot outlive an agent turn.
const DEFAULT_STOP_TIMEOUT_MS: u64 = 30_000;
const MAX_STOP_TIMEOUT_MS: u64 = 120_000;

/// One debugger operation. Tagged by operation so a request cannot carry parameters the operation
/// does not take.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "op")]
pub enum DebugRequest {
    /// Connects if needed and reports what the adapter supports.
    Status,
    SetBreakpoints {
        path: String,
        #[serde(default)]
        lines: Vec<i64>,
    },
    BreakpointLocations {
        path: String,
        line: i64,
    },
    /// Runs the project under the debugger with the given breakpoints installed.
    Launch {
        #[serde(default)]
        play_args: Vec<String>,
        #[serde(default)]
        breakpoints: Vec<SourceBreakpoints>,
    },
    /// Attaches to a game that is already running under this adapter.
    Attach,
    Threads,
    StackTrace {
        #[serde(default)]
        thread_id: Option<i64>,
    },
    Scopes {
        frame_id: i64,
    },
    Variables {
        variables_reference: i64,
    },
    Evaluate {
        expression: String,
        #[serde(default)]
        frame_id: Option<i64>,
    },
    Continue {
        #[serde(default)]
        thread_id: Option<i64>,
    },
    Pause {
        #[serde(default)]
        thread_id: Option<i64>,
    },
    StepOver {
        #[serde(default)]
        thread_id: Option<i64>,
    },
    StepIn {
        #[serde(default)]
        thread_id: Option<i64>,
    },
    /// Emulated by bounded step-overs: Godot 4.7 has no `stepOut` handler.
    StepOut {
        #[serde(default)]
        thread_id: Option<i64>,
    },
    /// Waits for the next stop. Answers `stopped: null` when the debuggee ended first.
    AwaitStop {
        #[serde(default)]
        thread_id: Option<i64>,
        #[serde(default)]
        timeout_ms: Option<u64>,
    },
    Restart,
    Terminate,
    Disconnect {
        #[serde(default)]
        terminate_debuggee: Option<bool>,
    },
}

/// The fields one [`DebugRequest`] variant deserializes, as serde spells them on the wire, and
/// whether a call may leave one out.
///
/// Declared beside the enum rather than recovered from it. `tool_drift` holds the catalogue's
/// parameter table to what the handler behind it really reads, and it used to do that by parsing
/// this file: find `enum DebugRequest {`, read to the first `\n}`, find the variant, split each
/// line on its first `:`. A field whose type wrapped onto a second line was dropped without a
/// word, and a rename left the whole comparison iterating an empty set — a check that passes on
/// nothing. What a request takes is a fact about the request, so it is written here, where
/// changing the variant and not the list is the same edit.
///
/// Optional means what serde means: the type is an `Option`, or the field carries
/// `#[serde(default)]`. `None` is for a name no variant answers, which is what makes a catalogue
/// operation added without a variant fail loudly rather than be skipped.
#[cfg(test)]
pub fn request_fields(op: &str) -> Option<&'static [(&'static str, bool)]> {
    const ON_A_THREAD: &[(&str, bool)] = &[("threadId", true)];
    Some(match op {
        "status" | "attach" | "threads" | "restart" | "terminate" => &[],
        "set_breakpoints" => &[("path", false), ("lines", true)],
        "breakpoint_locations" => &[("path", false), ("line", false)],
        "launch" => &[("playArgs", true), ("breakpoints", true)],
        "stack_trace" | "continue" | "pause" | "step_over" | "step_in" | "step_out" => ON_A_THREAD,
        "scopes" => &[("frameId", false)],
        "variables" => &[("variablesReference", false)],
        "evaluate" => &[("expression", false), ("frameId", true)],
        "await_stop" => &[("threadId", true), ("timeoutMs", true)],
        "disconnect" => &[("terminateDebuggee", true)],
        _ => return None,
    })
}

/// The breakpoint lines to install in one script.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceBreakpoints {
    pub path: String,
    #[serde(default)]
    pub lines: Vec<i64>,
}

/// The answer to one [`DebugRequest`], tagged with the operation that produced it.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "op")]
pub enum DebugResponse {
    Status {
        capabilities: DapCapabilities,
    },
    Breakpoints {
        breakpoints: Vec<VerifiedBreakpoint>,
    },
    BreakpointLocations {
        locations: Vec<BreakpointLocation>,
    },
    Launched {
        breakpoints: Vec<VerifiedBreakpoint>,
    },
    Attached,
    Threads {
        threads: Vec<DebugThread>,
    },
    StackTrace {
        frames: Vec<DebugFrame>,
        /// Why the list is empty, when it is. See [`why_there_are_no_frames`].
        #[serde(skip_serializing_if = "Option::is_none")]
        note: Option<&'static str>,
    },
    Scopes {
        scopes: Vec<Scope>,
    },
    Variables {
        variables: Vec<Variable>,
    },
    Evaluate {
        #[serde(flatten)]
        result: EvaluateResult,
    },
    Continued {
        all_threads: bool,
    },
    Acknowledged,
    Stepped {
        outcome: StepOutcome,
    },
    Stopped {
        stopped: Option<StoppedDetails>,
    },
}

/// A breakpoint the adapter verified, reported with the workspace-relative path it belongs to so
/// Monaco's gutter and the agent's answer name the same file.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifiedBreakpoint {
    pub path: String,
    pub line: Option<i64>,
    pub verified: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// One stack frame with its script named the way every other command names files.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugFrame {
    pub id: i64,
    pub name: String,
    pub line: i64,
    pub column: i64,
    /// Workspace-relative when the frame's script is inside the worktree; absent otherwise, since
    /// an engine-owned path is nothing the renderer or the agent can open.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

/// What one debugger request needs: the adapter, the worktree it is bound to, and the stop stream.
type BoundAdapter = (Arc<DapClient>, Workspace, Arc<Mutex<Receiver<DapEvent>>>);

struct Connection {
    key: String,
    client: Arc<DapClient>,
    workspace: Workspace,
    /// The stop receiver `AwaitStop` drains. Held here so consecutive waits see one ordered event
    /// stream instead of each subscribing to a fresh receiver that missed the stop it wants.
    events: Arc<Mutex<Receiver<DapEvent>>>,
}

static CONNECTION: Mutex<Option<Connection>> = Mutex::new(None);

/// Whether a game is running because the debugger started one.
///
/// `godot_runtime run` asks the editor `is_playing_scene()`, and a game the debug adapter launched
/// is not one the editor is playing — so the guard passed, `play_main_scene()` ran, a second game
/// collided with the first, and the model was told
/// `runtime_not_running: The game started and then stopped before it was ready`. A live debugging
/// turn met exactly that, twice, and read it as "the engine is broken": it spent the next seven
/// calls trying to launch the project from the shell, every one of them refused by the workspace
/// rule, before coming back and doing it the way that already worked.
///
/// So the router asks here first. Set when a launch or a restart is answered, cleared by terminate,
/// disconnect, the supervisor dropping the session, and any answer that says the debuggee ended on
/// its own — every way the game can go.
static DEBUGGER_HOLDS_A_GAME: AtomicBool = AtomicBool::new(false);

/// Whether the debugger has a game of its own running right now.
pub fn holds_a_game() -> bool {
    DEBUGGER_HOLDS_A_GAME.load(Ordering::Relaxed)
}

/// Sets that flag for a test about what the router says when the debugger is holding a game.
/// Nothing else may write it: every real path goes through a launch, a terminate or a disconnect.
#[cfg(test)]
pub fn pretend_it_holds_a_game(holds: bool) {
    DEBUGGER_HOLDS_A_GAME.store(holds, Ordering::Relaxed);
}

/// What an empty stack means, said where the empty list is.
///
/// A `pause` stops the game between frames rather than inside a script, and Godot's debug adapter
/// then has no frame to describe. Measured on the pinned 4.7.2, in the acceptance suite that drives
/// a real game: after `pause` answered `stopped` with `reason: "paused"`, `stackTrace` answered
/// `[]` and `evaluate` answered a timeout.
///
/// A live turn building a shooter met both. It paused to look at a collision that was not
/// happening, read `frames: []` twice, waited out the evaluate, and gave up on the debugger — its
/// own compaction summary records "Pause + evaluate failed (empty frames, timeout)". Nothing it
/// read said that a pause is not a break.
fn why_there_are_no_frames(frames: &[DebugFrame]) -> Option<&'static str> {
    if !frames.is_empty() {
        return None;
    }
    Some(
        "The debuggee has no frame to describe. A pause stops the game between frames rather than \
         inside a script, so there is nothing to read until it stops at a breakpoint: set one with \
         set_breakpoints, continue, and wait for it with await_stop.",
    )
}

/// The same fact, on the error an `evaluate` without a frame answers with.
///
/// Godot's adapter does not refuse it — it waits, and answers `Timeout reached while processing a
/// request`, which reads as a slow machine. The clause says what a timeout here usually is, and
/// says it as a likelihood rather than a diagnosis, because a genuinely slow adapter answers the
/// same way.
fn what_a_timed_out_evaluate_usually_means(failure: DapError) -> DapError {
    if !failure.message.contains("Timeout reached") {
        return failure;
    }
    let mut failure = failure;
    failure.message = format!(
        "{} An evaluate times out like this when the game is paused rather than stopped at a \
         breakpoint: a pause gives the debugger no frame to evaluate in. Read stack_trace first — \
         an empty one says the same thing.",
        failure.message
    );
    failure
}

/// Answers one debugger request, and notices in the answer that the game it was holding is gone.
pub fn call(request: DebugRequest) -> Result<DebugResponse, DapError> {
    let answered = answer(request);
    if answered.as_ref().is_ok_and(answer_says_the_game_ended) {
        DEBUGGER_HOLDS_A_GAME.store(false, Ordering::Relaxed);
    }
    answered
}

/// Whether an answer says the debuggee this session was holding has ended.
///
/// A game that quits, is closed, or crashes goes through no `terminate` and no `disconnect`, and
/// the flag was only ever lowered by those. From the first `get_tree().quit()` onward every
/// `godot_debug launch` answered `already_launched` and every `godot_runtime run` answered
/// `already_running`, both about a game that no longer existed, for the rest of the session.
///
/// The adapter's `terminated` and `exited` events are read by exactly two calls — a wait that ends
/// with no stop, and a step-out that ran out of debuggee — so those two answers are where the news
/// arrives, and there is nowhere else to look for it.
fn answer_says_the_game_ended(answer: &DebugResponse) -> bool {
    match answer {
        DebugResponse::Stopped { stopped } => stopped.is_none(),
        DebugResponse::Stepped { outcome } => matches!(outcome, StepOutcome::Terminated),
        _ => false,
    }
}

fn answer(request: DebugRequest) -> Result<DebugResponse, DapError> {
    let (client, workspace, events) = connection()?;
    match request {
        DebugRequest::Status => Ok(DebugResponse::Status {
            capabilities: client.capabilities().clone(),
        }),
        DebugRequest::SetBreakpoints { path, lines } => Ok(DebugResponse::Breakpoints {
            breakpoints: set_breakpoints(&client, &workspace, &path, &lines)?,
        }),
        DebugRequest::BreakpointLocations { path, line } => {
            let absolute = resolve(&workspace, &path)?;
            Ok(DebugResponse::BreakpointLocations {
                locations: client.breakpoint_locations(&absolute, line)?,
            })
        }
        DebugRequest::Launch {
            play_args,
            breakpoints,
        } => {
            refuse_a_second_launch(holds_a_game())?;
            launch(&client, &workspace, play_args, breakpoints)
        }
        DebugRequest::Attach => {
            client.attach()?;
            client.configuration_done()?;
            Ok(DebugResponse::Attached)
        }
        DebugRequest::Threads => Ok(DebugResponse::Threads {
            threads: client.threads()?,
        }),
        DebugRequest::StackTrace { thread_id } => {
            let frames: Vec<DebugFrame> = client
                .stack_trace(thread_id.unwrap_or(MAIN_THREAD_ID))?
                .into_iter()
                .map(|frame| to_debug_frame(&workspace, frame))
                .collect();
            Ok(DebugResponse::StackTrace {
                note: why_there_are_no_frames(&frames),
                frames,
            })
        }
        DebugRequest::Scopes { frame_id } => Ok(DebugResponse::Scopes {
            scopes: client.scopes(frame_id)?,
        }),
        DebugRequest::Variables {
            variables_reference,
        } => Ok(DebugResponse::Variables {
            variables: client.variables(variables_reference)?,
        }),
        DebugRequest::Evaluate {
            expression,
            frame_id,
        } => Ok(DebugResponse::Evaluate {
            result: client
                .evaluate(&expression, frame_id)
                .map_err(what_a_timed_out_evaluate_usually_means)?,
        }),
        DebugRequest::Continue { thread_id } => Ok(DebugResponse::Continued {
            all_threads: client.continue_execution(thread_id.unwrap_or(MAIN_THREAD_ID))?,
        }),
        DebugRequest::Pause { thread_id } => {
            client.pause(thread_id.unwrap_or(MAIN_THREAD_ID))?;
            Ok(DebugResponse::Acknowledged)
        }
        DebugRequest::StepOver { thread_id } => {
            client.next(thread_id.unwrap_or(MAIN_THREAD_ID))?;
            Ok(DebugResponse::Acknowledged)
        }
        DebugRequest::StepIn { thread_id } => {
            client.step_in(thread_id.unwrap_or(MAIN_THREAD_ID))?;
            Ok(DebugResponse::Acknowledged)
        }
        DebugRequest::StepOut { thread_id } => {
            // The one stream, held for the whole emulated step-out: the stops it consumes are the
            // stops a later `AwaitStop` must no longer see.
            let events = events.lock().map_err(|_| poisoned())?;
            Ok(DebugResponse::Stepped {
                outcome: client.step_out(&events, thread_id.unwrap_or(MAIN_THREAD_ID))?,
            })
        }
        DebugRequest::AwaitStop {
            thread_id,
            timeout_ms,
        } => {
            let timeout = Duration::from_millis(
                timeout_ms
                    .unwrap_or(DEFAULT_STOP_TIMEOUT_MS)
                    .min(MAX_STOP_TIMEOUT_MS),
            );
            let events = events.lock().map_err(|_| poisoned())?;
            Ok(DebugResponse::Stopped {
                stopped: client.await_stop(
                    &events,
                    thread_id.unwrap_or(MAIN_THREAD_ID),
                    timeout,
                )?,
            })
        }
        DebugRequest::Restart => {
            client.restart()?;
            // A restart is a launch by another name: it leaves a game running, and the refusal the
            // flag drives is the one that names restart as the way to replace one.
            DEBUGGER_HOLDS_A_GAME.store(true, Ordering::Relaxed);
            Ok(DebugResponse::Acknowledged)
        }
        DebugRequest::Terminate => {
            // The flag goes down whatever the adapter answers. Terminate is the way out the
            // refusal names, and a terminate that errored is not a reason to go on refusing every
            // launch for the rest of the session.
            let terminated = client.terminate();
            DEBUGGER_HOLDS_A_GAME.store(false, Ordering::Relaxed);
            terminated?;
            Ok(DebugResponse::Acknowledged)
        }
        DebugRequest::Disconnect { terminate_debuggee } => {
            let disconnected = client.disconnect(terminate_debuggee.unwrap_or(true));
            DEBUGGER_HOLDS_A_GAME.store(false, Ordering::Relaxed);
            disconnected?;
            Ok(DebugResponse::Acknowledged)
        }
    }
}

/// Drops the cached adapter connection. The session supervisor calls this when a session stops, so
/// the next debug request reconnects rather than talking to a dead editor.
pub fn disconnect() {
    DEBUGGER_HOLDS_A_GAME.store(false, Ordering::Relaxed);
    let previous = CONNECTION.lock().ok().and_then(|mut slot| slot.take());
    if let Some(connection) = previous {
        connection.client.shutdown();
    }
}

/// Runs Godot's exact launch sequence: the launch request goes out first and is answered only
/// after `configurationDone` spawns the game, so it is written here and collected at the end while
/// the breakpoints and the configuration-done request go out in between.
///
/// The order is the whole point. Godot answers a `configurationDone` that arrives with no launch
/// pending and then forgets it, leaving the launch behind it unspawned and unanswered — a game
/// that never starts and a request that only ends at its own timeout. Writing the launch on this
/// thread rather than on one that may not have been scheduled yet is what rules that out.
/// Refuses a launch on top of a game the debugger is already running.
///
/// What a model reaches for when a wait times out is another launch. Watched in one live turn:
/// **seven `launch` calls with no `terminate` between them**, and nine `stop_timeout`s around them.
/// Every new game arrives carrying the breakpoints of the launch that made it, so a wait left over
/// from the launch before is waiting for a stop that the game it is watching was never told to
/// make — and the answer to that is not a ninth launch.
///
/// The twin of the guard `godot_runtime run` takes for the same game from the other side. Both name
/// the ways out rather than only the refusal.
fn refuse_a_second_launch(holds_a_game: bool) -> Result<(), DapError> {
    if !holds_a_game {
        return Ok(());
    }
    Err(DapError::new(
        "already_launched",
        "The debugger is already running a game. Let it go on with continue, stop it where it is \
         with pause, or end it with terminate — and restart is the one call that replaces a running \
         game with a fresh one.",
    ))
}

fn launch(
    client: &DapClient,
    workspace: &Workspace,
    play_args: Vec<String>,
    breakpoints: Vec<SourceBreakpoints>,
) -> Result<DebugResponse, DapError> {
    ensure_scene_open()?;
    let launching = client.start_launch(workspace.root(), &play_args)?;

    let mut verified = Vec::new();
    let mut install_error = None;
    for source in &breakpoints {
        match set_breakpoints(client, workspace, &source.path, &source.lines) {
            Ok(mut installed) => verified.append(&mut installed),
            Err(error) => {
                install_error = Some(error);
                break;
            }
        }
    }

    // configurationDone goes out even when a breakpoint failed: without it the launch request is
    // never answered and the wait below would run to its own timeout.
    let configured = client.configuration_done();
    let launched = client.await_launch(launching);
    launched?;
    configured?;
    if let Some(error) = install_error {
        return Err(error);
    }
    DEBUGGER_HOLDS_A_GAME.store(true, Ordering::Relaxed);
    Ok(DebugResponse::Launched {
        breakpoints: verified,
    })
}

/// Opens the project's main scene when the editor is editing none.
///
/// Godot's adapter launches the *edited* scene: with no scene open it spawns a process that exits
/// with code 0 before it draws a frame, and the launch reports success. The editor's own Play
/// button plays the project's main scene instead, and Run means the same thing here, so the scene
/// the game needs is opened before the launch rather than discovered missing after it.
fn ensure_scene_open() -> Result<(), DapError> {
    crate::godot_session_api::open_main_scene_if_none().map_err(|error| {
        let failure = DapError::new(
            if error.code == "no_main_scene" {
                "no_scene_to_run"
            } else {
                "scene_open_failed"
            },
            error.message,
        );
        if error.retryable {
            failure.retryable()
        } else {
            failure
        }
    })
}

fn set_breakpoints(
    client: &DapClient,
    workspace: &Workspace,
    path: &str,
    lines: &[i64],
) -> Result<Vec<VerifiedBreakpoint>, DapError> {
    let absolute = resolve(workspace, path)?;
    let relative = relative_path(workspace, &absolute).unwrap_or_else(|| path.to_owned());
    let text = std::fs::read_to_string(&absolute).unwrap_or_default();
    let moved: Vec<Moved> = lines.iter().map(|line| Moved::of(&text, *line)).collect();
    let asked: Vec<i64> = moved.iter().map(|one| one.line).collect();
    Ok(client
        .set_breakpoints(&absolute, &asked)?
        .into_iter()
        .zip(moved)
        .map(
            |(breakpoint, moved): (Breakpoint, Moved)| VerifiedBreakpoint {
                path: relative.clone(),
                line: breakpoint.line,
                verified: breakpoint.verified,
                message: breakpoint.message.or_else(|| moved.note()),
            },
        )
        .collect())
}

/// A breakpoint line as it was asked for, and as it will actually stop.
///
/// Godot answers `verified: true` for a breakpoint on a `func` declaration and then never stops
/// there — the header is not a statement, and the editor's own gutter will not take a breakpoint on
/// one. Measured against a real 4.7.2 editor: the same script, breakpoint on the `func` line,
/// `breakpointLocations` offers it, `setBreakpoints` verifies it, and twenty seconds pass with the
/// game running; on the line under it the stop arrives at once.
///
/// A model reads a script, sees the function it cares about, and names that line. A live debugging
/// turn did exactly that four times, spent six of its calls on `stop_timeout`, and finished nothing.
/// So the breakpoint moves onto the first statement of the body, which is what every debugger does
/// with a line that cannot hold one, and the answer says where it went.
struct Moved {
    line: i64,
    from: Option<i64>,
}

impl Moved {
    fn of(text: &str, line: i64) -> Self {
        match first_statement_of_function(text, line) {
            Some(body) => Self {
                line: body,
                from: Some(line),
            },
            None => Self { line, from: None },
        }
    }

    fn note(&self) -> Option<String> {
        let from = self.from?;
        Some(format!(
            "Line {from} declares the function and never runs, so a breakpoint on it would be \
             verified and never hit. This one is on line {}, the first statement of the body.",
            self.line
        ))
    }
}

/// The first line of a function's body, when `line` is the `func` that declares it.
///
/// `None` for everything else, which is every ordinary breakpoint: a line already holding a
/// statement is left exactly where it was asked for.
fn first_statement_of_function(text: &str, line: i64) -> Option<i64> {
    let lines: Vec<&str> = text.lines().collect();
    let index = usize::try_from(line.checked_sub(1)?).ok()?;
    let declares = |text: &str| {
        let trimmed = text.trim_start();
        trimmed.starts_with("func ") || trimmed.starts_with("static func ")
    };
    if !declares(lines.get(index)?) {
        return None;
    }
    // The signature can span lines. It ends on the one closing with `:`, and the search stops at
    // the next declaration so a one-line `func f(): return 1` — which is a statement and stays put
    // — cannot borrow the body of the function after it.
    let mut header = index;
    while !lines[header].trim_end().ends_with(':') {
        header += 1;
        if header >= lines.len() || declares(lines[header]) {
            return None;
        }
    }
    lines
        .iter()
        .enumerate()
        .skip(header + 1)
        .find(|(_, text)| {
            let trimmed = text.trim();
            !trimmed.is_empty() && !trimmed.starts_with('#')
        })
        .and_then(|(found, _)| i64::try_from(found + 1).ok())
}

/// Returns the adapter for the active session, connecting on first use.
fn connection() -> Result<BoundAdapter, DapError> {
    // The same guard the editor's other two doors take. A debugger attached through a checkout the
    // window has moved away from is stepping through another task's code.
    crate::godot_session_api::require_session_task_here().map_err(|refusal| {
        DapError::new("session_other_task", refusal.message).with_details(refusal.details)
    })?;
    let (dap_port, worktree) = active_session().ok_or_else(|| {
        DapError::new(
            "session_not_active",
            "No Godot session is active, so no debug adapter is reachable",
        )
        .retryable()
    })?;
    let key = format!("{dap_port}|{worktree}");
    let mut slot = CONNECTION.lock().map_err(|_| poisoned())?;
    // The same three conditions the language server's cache takes, closed included: an adapter
    // that hung up — every `disconnect` ends with one — is not a connection to hand out again.
    if let Some(existing) = slot.as_ref()
        && existing.key == key
        && !existing.client.is_closed()
    {
        return Ok((
            Arc::clone(&existing.client),
            existing.workspace.clone(),
            Arc::clone(&existing.events),
        ));
    }
    if let Some(previous) = slot.take() {
        previous.client.shutdown();
    }
    let workspace = Workspace::open(&PathBuf::from(&worktree)).map_err(file_error)?;
    let address = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), dap_port);
    let mut client = DapClient::connect(address)?;
    // Subscribing before initialize would still be too late for `initialized`, which rides out
    // with the initialize response; the events that matter here are the stops that follow.
    client.initialize()?;
    let events = Arc::new(Mutex::new(client.subscribe_events()));
    let client = Arc::new(client);
    *slot = Some(Connection {
        key,
        client: Arc::clone(&client),
        workspace: workspace.clone(),
        events: Arc::clone(&events),
    });
    Ok((client, workspace, events))
}

/// The editor the debug commands bind to: the bound editor's adapter port and its worktree.
fn active_session() -> Option<(u16, String)> {
    godot_session::current_info().map(|info| (info.dap_port, info.worktree))
}

/// Resolves a script path against the worktree. `res://` is accepted because that is how the
/// editor, the addon, and Godot's own errors name scripts; everything else goes through the same
/// canonical-path validation as every other file operation.
fn resolve(workspace: &Workspace, path: &str) -> Result<PathBuf, DapError> {
    let relative = path.strip_prefix("res://").unwrap_or(path);
    workspace.resolve(relative).map_err(file_error)
}

fn relative_path(workspace: &Workspace, absolute: &std::path::Path) -> Option<String> {
    absolute
        .strip_prefix(workspace.root())
        .ok()
        .map(|path| path.to_string_lossy().replace('\\', "/"))
}

fn to_debug_frame(workspace: &Workspace, frame: StackFrame) -> DebugFrame {
    let path = frame
        .source_path
        .as_deref()
        .map(PathBuf::from)
        .and_then(|source| relative_path(workspace, &source));
    DebugFrame {
        id: frame.id,
        name: frame.name,
        line: frame.line,
        column: frame.column,
        path,
    }
}

/// Keeps the workspace's own code so a path escape stays a path escape instead of being flattened
/// into a generic adapter failure.
fn file_error(error: FileError) -> DapError {
    DapError {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        details: error.details,
    }
}

fn poisoned() -> DapError {
    DapError {
        code: "lock_poisoned",
        message: "The debug session lock is poisoned".to_owned(),
        retryable: false,
        details: json!({}),
    }
}

#[cfg(test)]
mod tests {

    /// A pause is not a break, and both answers say so.
    ///
    /// Measured against the pinned 4.7.2 in `godot_dap_acceptance`, which drives a real game:
    /// after a pause, `stackTrace` answers `[]` and `evaluate` answers a timeout. A live turn met
    /// both, read nothing into either, and abandoned the debugger.
    #[test]
    fn an_empty_stack_and_a_timed_out_evaluate_both_say_a_pause_is_not_a_break() {
        assert!(
            why_there_are_no_frames(&[])
                .unwrap_or_default()
                .contains("A pause stops the game between frames")
        );

        let frame = DebugFrame {
            id: 1,
            name: "_process".to_owned(),
            path: Some("scripts/player.gd".to_owned()),
            line: 12,
            column: 1,
        };
        assert_eq!(why_there_are_no_frames(&[frame]), None);

        let timed_out = what_a_timed_out_evaluate_usually_means(DapError::new(
            "dap_server_error",
            "Timeout reached while processing a request. (timeout)",
        ));
        assert!(
            timed_out.message.contains("no frame to evaluate in"),
            "{}",
            timed_out.message
        );

        // Anything else the adapter says is left exactly as it said it.
        let other = what_a_timed_out_evaluate_usually_means(DapError::new(
            "dap_server_error",
            "Parse error in expression",
        ));
        assert_eq!(other.message, "Parse error in expression");
    }
    /// A launch on top of a live game is refused, and the refusal names every way onward.
    ///
    /// One live debugging turn made seven launches with no terminate between them. Each new game
    /// carries the breakpoints of the launch that made it, so the waits left over from earlier
    /// launches time out — nine of them in that turn — and the model answers a timed-out wait with
    /// another launch.
    #[test]
    fn a_launch_on_top_of_a_running_game_is_refused() {
        let refused = super::refuse_a_second_launch(true)
            .expect_err("a second launch must be refused while one game is running");
        assert_eq!(refused.code, "already_launched");
        for onward in ["continue", "pause", "terminate", "restart"] {
            assert!(
                refused.message.contains(onward),
                "the refusal has to name {onward}: {}",
                refused.message
            );
        }
        assert!(super::refuse_a_second_launch(false).is_ok());
    }

    /// A game that ended on its own puts the flag down, so the next launch is not refused forever.
    ///
    /// The flag was raised by a launch and lowered by terminate, disconnect and session stop — and
    /// a debuggee that quits, is closed, or crashes goes through none of those. From the first
    /// `get_tree().quit()` onward, every `godot_debug launch` answered `already_launched` and every
    /// `godot_runtime run` answered `already_running`, both about a game that no longer existed,
    /// for the rest of the editor session.
    ///
    /// The adapter says so in the only two answers that carry it: a wait that ends with no stop,
    /// and a step-out that ran out of debuggee.
    #[test]
    fn an_answer_that_says_the_debuggee_ended_puts_the_flag_down() {
        let stop = super::StoppedDetails {
            reason: "breakpoint".to_owned(),
            thread_id: Some(super::MAIN_THREAD_ID),
            description: None,
            text: None,
            all_threads_stopped: true,
        };

        for ended in [
            super::DebugResponse::Stopped { stopped: None },
            super::DebugResponse::Stepped {
                outcome: super::StepOutcome::Terminated,
            },
        ] {
            assert!(
                super::answer_says_the_game_ended(&ended),
                "{ended:?} says the debuggee is gone"
            );
        }

        // And a game that is merely stopped, stepped, or launched is still a game.
        for alive in [
            super::DebugResponse::Stopped {
                stopped: Some(stop.clone()),
            },
            super::DebugResponse::Stepped {
                outcome: super::StepOutcome::SteppedOut { stop: stop.clone() },
            },
            super::DebugResponse::Stepped {
                outcome: super::StepOutcome::Resumed,
            },
            super::DebugResponse::Launched {
                breakpoints: Vec::new(),
            },
            super::DebugResponse::Acknowledged,
        ] {
            assert!(
                !super::answer_says_the_game_ended(&alive),
                "{alive:?} does not say the debuggee is gone"
            );
        }
    }

    use super::*;
    use serde_json::json;
    use tempfile::TempDir;

    fn workspace() -> (TempDir, Workspace) {
        let directory = TempDir::new().expect("temporary directory");
        std::fs::create_dir_all(directory.path().join("scripts")).expect("create scripts");
        std::fs::write(directory.path().join("scripts/probe.gd"), "extends Node\n")
            .expect("write probe");
        let workspace = Workspace::open(directory.path()).expect("open workspace");
        (directory, workspace)
    }

    /*
     * A breakpoint on a `func` line is moved onto the body, because Godot will not stop on one.
     *
     * Measured against a real 4.7.2 editor on one script: line 8 is `func _process(...)`, line 9 is
     * its only statement. `breakpointLocations` offers line 8, `setBreakpoints` answers
     * `verified: true` for it, and twenty seconds pass with the game running and no stop. On line 9
     * the stop arrives at once.
     *
     * A live debugging turn set line 8 four times — it is the line a model names, having read the
     * script and picked the function — spent six calls on `stop_timeout`, and finished nothing.
     */
    #[test]
    fn a_breakpoint_on_a_function_header_moves_onto_its_first_statement() {
        let script = "extends Node2D\n\n@export var speed: float = 24.0\n\nvar travelled := 0.0\n\n\nfunc _process(delta: float) -> void:\n\ttravelled += speed * delta\n";

        assert_eq!(first_statement_of_function(script, 8), Some(9));
        // A line already holding a statement stays exactly where it was asked for.
        assert_eq!(first_statement_of_function(script, 9), None);
        assert_eq!(first_statement_of_function(script, 3), None);
        assert_eq!(first_statement_of_function(script, 1), None);
        // And a line the file does not have is not a breakpoint this can improve.
        assert_eq!(first_statement_of_function(script, 99), None);
        assert_eq!(first_statement_of_function(script, 0), None);

        let moved = Moved::of(script, 8);
        assert_eq!(moved.line, 9);
        let note = moved.note().expect("a moved breakpoint says where it went");
        assert!(note.contains("line 9"), "{note}");
        assert!(Moved::of(script, 9).note().is_none());

        // Comments and blank lines under the header are not statements either.
        let commented = "extends Node\n\nfunc go() -> void:\n\t# what this does\n\n\tprint(1)\n";
        assert_eq!(first_statement_of_function(commented, 3), Some(6));

        // A signature written over several lines ends on the one closing with `:`.
        let wrapped = "extends Node\n\nfunc go(\n\tfirst: int,\n\tsecond: int\n) -> void:\n\tprint(first + second)\n";
        assert_eq!(first_statement_of_function(wrapped, 3), Some(7));

        // A one-line function is a statement of its own and must not borrow the body of the next
        // one. Nothing between it and the following declaration closes a signature, so it stays.
        let inline = "extends Node\n\nfunc one(): return 1\n\nfunc two() -> void:\n\tprint(2)\n";
        assert_eq!(first_statement_of_function(inline, 3), None);

        // A declaration with nothing under it has no body to move to.
        assert_eq!(
            first_statement_of_function("func trailing() -> void:\n", 1),
            None
        );

        // `static func` declares one too.
        let statics = "extends Node\n\nstatic func make() -> int:\n\treturn 3\n";
        assert_eq!(first_statement_of_function(statics, 3), Some(4));
    }

    #[test]
    fn scripts_are_named_the_way_the_editor_names_them() {
        let (_directory, workspace) = workspace();

        let from_res = resolve(&workspace, "res://scripts/probe.gd").expect("res:// path");
        let from_relative = resolve(&workspace, "scripts/probe.gd").expect("relative path");
        assert_eq!(from_res, from_relative);
        assert_eq!(
            relative_path(&workspace, &from_res).as_deref(),
            Some("scripts/probe.gd")
        );

        // Escapes are the workspace's refusal, kept whole rather than flattened into a generic
        // adapter failure.
        let escaped = resolve(&workspace, "../outside.gd").expect_err("escape is refused");
        assert!(!escaped.message.is_empty());
        assert_ne!(escaped.code, "");
    }

    #[test]
    fn frames_outside_the_worktree_lose_their_path() {
        let (_directory, workspace) = workspace();
        let inside = workspace.root().join("scripts/probe.gd");

        let mapped = to_debug_frame(
            &workspace,
            StackFrame {
                id: 1,
                name: "_tick".to_owned(),
                line: 7,
                column: 0,
                source_path: Some(inside.display().to_string()),
            },
        );
        assert_eq!(mapped.path.as_deref(), Some("scripts/probe.gd"));
        assert_eq!(mapped.line, 7);

        let engine_owned = to_debug_frame(
            &workspace,
            StackFrame {
                source_path: Some("/usr/share/godot/core.gd".to_owned()),
                ..StackFrame::default()
            },
        );
        assert_eq!(engine_owned.path, None);
    }

    #[test]
    fn every_operation_is_refused_without_a_session() {
        let _no_editor = godot_session::no_editor_bound();
        for request in [
            json!({"op": "status"}),
            json!({"op": "launch"}),
            json!({"op": "stackTrace"}),
            json!({"op": "awaitStop", "timeoutMs": 10}),
        ] {
            let request: DebugRequest =
                serde_json::from_value(request).expect("a well-formed debug request");
            let error = call(request).expect_err("no session is active");
            assert_eq!(error.code, "session_not_active");
            assert!(error.retryable);
        }
    }

    #[test]
    fn a_launch_carries_its_breakpoints_and_arguments() {
        let request: DebugRequest = serde_json::from_value(json!({
            "op": "launch",
            "playArgs": ["--headless"],
            "breakpoints": [{"path": "res://scripts/probe.gd", "lines": [7]}],
        }))
        .expect("launch request");

        let DebugRequest::Launch {
            play_args,
            breakpoints,
        } = request
        else {
            panic!("the launch request must deserialize as a launch")
        };
        assert_eq!(play_args, ["--headless"]);
        assert_eq!(breakpoints[0].path, "res://scripts/probe.gd");
        assert_eq!(breakpoints[0].lines, [7]);
    }
}

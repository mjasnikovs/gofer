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

/// Answers one debugger request, connecting to the active session's adapter on first use.
pub fn call(request: DebugRequest) -> Result<DebugResponse, DapError> {
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
        } => launch(&client, &workspace, play_args, breakpoints),
        DebugRequest::Attach => {
            client.attach()?;
            client.configuration_done()?;
            Ok(DebugResponse::Attached)
        }
        DebugRequest::Threads => Ok(DebugResponse::Threads {
            threads: client.threads()?,
        }),
        DebugRequest::StackTrace { thread_id } => Ok(DebugResponse::StackTrace {
            frames: client
                .stack_trace(thread_id.unwrap_or(MAIN_THREAD_ID))?
                .into_iter()
                .map(|frame| to_debug_frame(&workspace, frame))
                .collect(),
        }),
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
            result: client.evaluate(&expression, frame_id)?,
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
            Ok(DebugResponse::Acknowledged)
        }
        DebugRequest::Terminate => {
            client.terminate()?;
            Ok(DebugResponse::Acknowledged)
        }
        DebugRequest::Disconnect { terminate_debuggee } => {
            client.disconnect(terminate_debuggee.unwrap_or(true))?;
            Ok(DebugResponse::Acknowledged)
        }
    }
}

/// Drops the cached adapter connection. The session supervisor calls this when a session stops, so
/// the next debug request reconnects rather than talking to a dead editor.
pub fn disconnect() {
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
    Ok(client
        .set_breakpoints(&absolute, lines)?
        .into_iter()
        .map(|breakpoint: Breakpoint| VerifiedBreakpoint {
            path: relative.clone(),
            line: breakpoint.line,
            verified: breakpoint.verified,
            message: breakpoint.message,
        })
        .collect())
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

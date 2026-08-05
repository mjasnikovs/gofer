//! Public desktop API for Gofer-managed Godot sessions.
//!
//! This layer binds each session to the active task's isolated worktree, stages the Gofer addon
//! through [`crate::addon::AddonStager`], exposes the Tauri commands the renderer uses, and
//! forwards addon events through a Tauri channel.

use crate::addon::AddonStager;
use crate::approvals::ApprovalError;
use crate::files::Workspace;
use crate::godot_rpc::{CallRequest as RpcCallRequest, EventEnvelope, ResponseEnvelope, RpcError};
use crate::godot_session::{self, LaunchRequest, SessionError, SessionInfo, SessionState};
use crate::storage::ProjectStorage;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, Runtime};

const LEDGER_FILE_NAME: &str = "godot-addon-ledger.json";
const EVENT_FORWARD_INTERVAL_MS: u64 = 50;

/// An empty request body for commands that need no parameters.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartGodotSessionRequest {}

/// Summary of a Godot session returned to the renderer.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GodotSessionResponse {
    pub state: SessionState,
    pub rpc_address: String,
    pub lsp_port: u16,
    pub dap_port: u16,
    pub godot_version: Option<String>,
    pub worktree: String,
}

/// A tagged RPC request from the renderer.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CallGodotRequest {
    pub id: String,
    pub command: String,
    pub params: Value,
    #[serde(default)]
    pub expected_revision: Option<u64>,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

/// A tagged RPC response to the renderer.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CallGodotResponse {
    pub id: String,
    pub result: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revision: Option<u64>,
}

/// Events emitted on the Tauri channel returned by `subscribe_godot_events`.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum SessionEvent {
    StateChanged {
        state: SessionState,
    },
    RpcEvent {
        sequence: u64,
        event: String,
        data: Value,
    },
}

/// An approval response from the renderer for an AI-initiated operation.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolApprovalRequest {
    pub approval_id: String,
    pub approved: bool,
}

struct EventSubscription {
    stop: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}

impl EventSubscription {
    fn stop(mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

static EVENT_SUBSCRIPTION: Mutex<Option<EventSubscription>> = Mutex::new(None);

/// Starts a Godot editor session bound to the active task's worktree.
pub fn start_session<R: Runtime>(
    app: &AppHandle<R>,
    _request: StartGodotSessionRequest,
) -> Result<GodotSessionResponse, SessionError> {
    let storage = project_storage(app)?;
    let worktree = storage.active_task_workspace().map_err(|error| {
        SessionError::new(
            "no_active_task_workspace",
            format!("A Godot session can only start for an active task worktree: {error}"),
        )
    })?;

    let stager = AddonStager::new(ledger_path(app));
    let workspace = Workspace::open(&worktree).map_err(|error| {
        SessionError::new(
            "worktree_unavailable",
            format!(
                "The active task worktree could not be opened: {}",
                error.message
            ),
        )
    })?;
    stager.stage(&workspace).map_err(|error| {
        SessionError::new(
            "addon_stage_failed",
            format!("The Gofer addon could not be staged: {}", error.message),
        )
    })?;

    match godot_session::start(LaunchRequest {
        worktree: worktree.clone(),
    }) {
        Ok(info) => Ok(to_response(&info)),
        Err(error) => {
            let _ = stager.unstage(&worktree);
            Err(error)
        }
    }
}

/// Stops the active session and removes the staged addon.
pub fn stop_session<R: Runtime>(app: &AppHandle<R>) -> Result<(), SessionError> {
    let worktree = current_worktree();
    // The language server and the debug adapter both die with the editor, so the cached clients
    // are dropped before the process is stopped rather than left to fail the renderer's next
    // script or debugger request.
    crate::script::disconnect();
    crate::debug::disconnect();
    let result = godot_session::stop();
    if let Some(worktree) = worktree {
        // Unstaging must read the same ledger staging wrote, or the addon is left in the worktree.
        let _ = AddonStager::new(ledger_path(app)).unstage(&worktree);
    }
    stop_event_subscription();
    result
}

/// Returns the active session summary, if any.
pub fn get_session() -> Result<Option<GodotSessionResponse>, SessionError> {
    Ok(godot_session::current_info().map(|info| to_response(&info)))
}

/// Sends one tagged RPC call to the connected addon.
pub fn call_godot(request: CallGodotRequest) -> Result<CallGodotResponse, RpcError> {
    let rpc = godot_session::rpc_session()
        .ok_or_else(|| RpcError::new("session_not_active", "No Godot session is active"))?;
    let response = rpc.call(RpcCallRequest {
        id: request.id,
        command: request.command,
        params: request.params,
        expected_revision: request.expected_revision,
        timeout_ms: request.timeout_ms,
    })?;
    Ok(to_call_response(response))
}

/// Streams addon events through a Tauri channel until the session stops or the renderer
/// unsubscribes.
pub fn subscribe_godot_events<R: Runtime>(
    app: &AppHandle<R>,
    channel: tauri::ipc::Channel<SessionEvent>,
) -> Result<(), SessionError> {
    stop_event_subscription();

    let rpc = godot_session::rpc_session()
        .ok_or_else(|| SessionError::new("session_not_active", "No Godot session is active"))?;

    let events = rpc.subscribe_events();
    let stop = Arc::new(AtomicBool::new(false));
    let flag = Arc::clone(&stop);
    let app = app.clone();

    let worker = thread::spawn(move || {
        let mut last_state = godot_session::current_state();
        emit_state_changed(&app, last_state);

        while !flag.load(Ordering::Acquire) {
            match events.recv_timeout(Duration::from_millis(EVENT_FORWARD_INTERVAL_MS)) {
                Ok(envelope) => {
                    update_state_from_event(&envelope);
                    let current = godot_session::current_state();
                    if current != last_state {
                        last_state = current;
                        emit_state_changed(&app, current);
                    }
                    let _ = channel.send(SessionEvent::RpcEvent {
                        sequence: envelope.sequence,
                        event: envelope.event,
                        data: envelope.data,
                    });
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
    });

    *EVENT_SUBSCRIPTION.lock().map_err(|_| {
        SessionError::new("lock_poisoned", "The event subscription lock is poisoned")
    })? = Some(EventSubscription {
        stop,
        worker: Some(worker),
    });
    Ok(())
}

/// Stops the active event subscription, if any.
pub fn unsubscribe_godot_events() -> Result<(), SessionError> {
    stop_event_subscription();
    Ok(())
}

/// Answers one AI tool call that is waiting for the user. The gated call resumes — or fails with
/// `approval_denied` — the moment this returns.
pub fn respond_tool_approval(request: ToolApprovalRequest) -> Result<(), ApprovalError> {
    crate::approvals::respond(&request.approval_id, request.approved)
}

fn project_storage<R: Runtime>(app: &AppHandle<R>) -> Result<ProjectStorage, SessionError> {
    app.try_state::<ProjectStorage>()
        .map(|storage| storage.inner().clone())
        .ok_or_else(|| {
            SessionError::new(
                "storage_unavailable",
                "Project storage has not been initialized",
            )
        })
}

fn ledger_path<R: Runtime>(app: &AppHandle<R>) -> PathBuf {
    app.path()
        .app_data_dir()
        .map(|path| path.join(LEDGER_FILE_NAME))
        .unwrap_or_else(|_| PathBuf::from(LEDGER_FILE_NAME))
}

fn current_worktree() -> Option<PathBuf> {
    godot_session::current_info().map(|info| PathBuf::from(info.worktree))
}

fn to_response(info: &SessionInfo) -> GodotSessionResponse {
    GodotSessionResponse {
        state: info.state,
        rpc_address: info.rpc_address.clone(),
        lsp_port: info.lsp_port,
        dap_port: info.dap_port,
        godot_version: Some(info.godot_version.clone()),
        worktree: info.worktree.clone(),
    }
}

fn to_call_response(response: ResponseEnvelope) -> CallGodotResponse {
    CallGodotResponse {
        id: response.id,
        result: response.result,
        revision: response.revision,
    }
}

fn emit_state_changed<R: Runtime>(app: &AppHandle<R>, state: SessionState) {
    let _ = app.emit_to(
        "main",
        "godot-session-event",
        SessionEvent::StateChanged { state },
    );
}

fn update_state_from_event(envelope: &EventEnvelope) {
    let new_state = match envelope.event.as_str() {
        "session.starting" => Some(SessionState::Starting),
        "session.importing" => Some(SessionState::Importing),
        "session.ready" => Some(SessionState::Ready),
        "session.playing" => Some(SessionState::Playing),
        "session.debug_paused" => Some(SessionState::DebugPaused),
        "session.stopping" => Some(SessionState::Stopping),
        _ => None,
    };
    if let Some(state) = new_state {
        godot_session::set_state(state);
    }
}

fn stop_event_subscription() {
    if let Ok(mut slot) = EVENT_SUBSCRIPTION.lock()
        && let Some(subscription) = slot.take()
    {
        subscription.stop();
    }
}

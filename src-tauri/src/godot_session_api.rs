//! Public desktop API for Gofer-managed Godot sessions.
//!
//! This layer binds each session to the active task's isolated worktree, stages the Gofer addon
//! through [`crate::addon::AddonStager`], exposes the Tauri commands the renderer uses, and
//! forwards addon events through a Tauri channel.

use crate::addon::AddonStager;
use crate::approvals::ApprovalError;
use crate::files::Workspace;
use crate::godot_rpc::{CallRequest as RpcCallRequest, EventEnvelope, ResponseEnvelope, RpcError};
use crate::godot_session::{
    self, LaunchRequest, LogQuery, LogSeverity, SessionError, SessionInfo, SessionState,
};
use crate::storage::{
    AppendGodotLogsRequest, FinishGodotRunRequest, GodotLogEntry, ProjectStorage,
    StartGodotRunRequest,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, Runtime};

const LEDGER_FILE_NAME: &str = "godot-addon-ledger.json";
const EVENT_FORWARD_INTERVAL_MS: u64 = 50;
/// Opening a scene loads its resources, which is slower than an ordinary addon request.
const SCENE_OPEN_TIMEOUT_MS: u64 = 30_000;
/// How often buffered session output is written to durable storage. The session buffer is bounded,
/// so a long import can push lines out of it; flushing on a timer is what keeps them.
const LOG_FLUSH_INTERVAL_MS: u64 = 1_000;
/// How many buffered lines one storage segment carries.
const LOG_FLUSH_BATCH: usize = 500;
const LOG_TICK: Duration = Duration::from_millis(50);

/// An empty request body for commands that need no parameters.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartGodotSessionRequest {}

/// Summary of a Godot session returned to the renderer.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GodotSessionResponse {
    /// Names this editor session. Stored run logging is keyed by it, so the renderer can tell
    /// output from the running editor apart from output the archive kept.
    pub session_id: String,
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

/// The task the running editor session belongs to.
///
/// A session is pinned to the worktree it started in; the active task is whatever the sidebar last
/// pointed at. Nothing kept the two together, so switching tasks with a session running left every
/// panel reading one task's editor while the file tools — the agent's included — wrote into
/// another's checkout. The scene that answered was a scene the user was not looking at, and nothing
/// on screen said so. This is what a call is checked against.
static SESSION_TASK: Mutex<Option<String>> = Mutex::new(None);

fn remember_session_task(task_id: Option<String>) {
    if let Ok(mut owner) = SESSION_TASK.lock() {
        *owner = task_id;
    }
}

/// Refuses a call when the editor session belongs to a task the window has moved away from.
///
/// Answering would be worse than refusing: the reply describes another checkout entirely, and it
/// looks exactly like an answer about this one.
pub fn require_session_task<R: Runtime>(app: &AppHandle<R>) -> Result<(), RpcError> {
    if godot_session::current_info().is_none() {
        return Ok(());
    }
    let Ok(owner) = SESSION_TASK.lock() else {
        return Ok(());
    };
    let Some(session_task) = owner.clone() else {
        return Ok(());
    };
    drop(owner);
    // A storage that cannot be read is not evidence of a mismatch, so it is not treated as one.
    let Ok(storage) = project_storage(app) else {
        return Ok(());
    };
    let Ok(active) = storage.active_task() else {
        return Ok(());
    };
    if active.as_deref() == Some(session_task.as_str()) {
        return Ok(());
    }
    Err(RpcError::new(
        "session_other_task",
        "The Godot editor session belongs to another task. Open that task, or stop the session \
         and start one here.",
    ))
}

/// The stored run one editor session is writing its output into.
///
/// Run logging used to belong to the standalone Godot process Gofer launched from the Run button.
/// That process is gone, so the managed session owns it: a run row is opened when the editor
/// starts, carries the session identifier, and is closed when the session stops. Everything already
/// recorded keeps its segments and its full-text rows — a run without a session is simply one that
/// predates the managed editor.
struct RunLogger {
    run_id: String,
    storage: ProjectStorage,
    stop: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}

static RUN_LOGGER: Mutex<Option<RunLogger>> = Mutex::new(None);

/// Starts a Godot editor session bound to the active task's worktree.
///
/// Starting a session that is already running answers with the one that is running. The AI agent is
/// told to start the session when it is offline and cannot always tell, and the cost of getting it
/// wrong used to be severe: staging the addon begins by *unstaging* it, so a redundant start pulled
/// `addons/gofer` out from under the live editor and rewrote its `project.godot`, killing the very
/// session it was asked to make sure of — and only then failed with "already active".
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

    if let Some(running) = godot_session::current_info() {
        // The running session reports the path it resolved; the task table holds the one it was
        // given, and on a machine with a symlinked temporary directory those are different strings
        // for one directory.
        let resolved = crate::paths::canonical(&worktree).unwrap_or_else(|_| worktree.clone());
        if Path::new(&running.worktree) == resolved {
            return Ok(to_response(&running));
        }
        return Err(SessionError::new(
            "session_already_active",
            format!(
                "A Godot session is already running for {}. Stop it before starting one for {}.",
                running.worktree,
                worktree.display()
            ),
        ));
    }

    let stager = addon_stager(app);
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
        binary: crate::configured_godot_binary(app),
    }) {
        Ok(info) => {
            remember_session_task(storage.active_task().ok().flatten());
            start_run_logging(&storage, &info, &worktree);
            Ok(to_response(&info))
        }
        Err(error) => {
            let _ = stager.unstage(&worktree);
            Err(error)
        }
    }
}

/// Opens the stored run for a session and starts draining the session buffer into it.
///
/// A failure here never fails the session: the editor is running and usable without a log archive.
/// It is reported into the session buffer instead, which is where the user is already looking for
/// what the editor is doing.
fn start_run_logging(storage: &ProjectStorage, info: &SessionInfo, worktree: &Path) {
    stop_run_logging("aborted");
    let run = match storage.start_godot_run_in(
        &StartGodotRunRequest {
            task_id: None,
            session_id: Some(info.session_id.clone()),
            godot_version: Some(info.godot_version.clone()),
            metadata: json!({
                "rpcAddress": info.rpc_address,
                "lspPort": info.lsp_port,
                "dapPort": info.dap_port,
            }),
        },
        worktree,
    ) {
        Ok(run) => run,
        Err(error) => {
            godot_session::append_log(
                godot_session::LogSource::EditorError,
                &format!("ERROR: Gofer could not record this session's run: {error}"),
            );
            return;
        }
    };

    let stop = Arc::new(AtomicBool::new(false));
    let flag = Arc::clone(&stop);
    let sink = storage.clone();
    let run_id = run.id.clone();
    let worker = thread::spawn(move || {
        let mut cursor = 0_u64;
        let mut waited = Duration::ZERO;
        // The wait is ticked rather than slept through, so stopping a session does not sit out a
        // whole flush interval before its final drain.
        while !flag.load(Ordering::Acquire) {
            thread::sleep(LOG_TICK);
            waited += LOG_TICK;
            if waited < Duration::from_millis(LOG_FLUSH_INTERVAL_MS) {
                continue;
            }
            waited = Duration::ZERO;
            flush_logs(&sink, &run_id, &mut cursor);
        }
        // The lines that explain a crash arrive last, so the final drain happens after the stop.
        flush_logs(&sink, &run_id, &mut cursor);
    });

    if let Ok(mut slot) = RUN_LOGGER.lock() {
        *slot = Some(RunLogger {
            run_id: run.id,
            storage: storage.clone(),
            stop,
            worker: Some(worker),
        });
    }
}

/// Writes every buffered line after `cursor` into the run, in storage-sized batches.
///
/// Blank lines are dropped rather than sent: storage refuses an empty message, and one blank line
/// from the engine would otherwise lose the whole batch around it.
fn flush_logs(storage: &ProjectStorage, run_id: &str, cursor: &mut u64) {
    loop {
        let Ok(page) = godot_session::read_logs(&LogQuery {
            after: Some(*cursor),
            limit: Some(LOG_FLUSH_BATCH),
            ..LogQuery::default()
        }) else {
            return;
        };
        if page.entries.is_empty() {
            return;
        }
        *cursor = page.cursor;
        let entries = page
            .entries
            .iter()
            .filter(|entry| !entry.message.trim().is_empty())
            .map(|entry| GodotLogEntry {
                timestamp: entry.timestamp,
                level: match entry.severity {
                    LogSeverity::Error => "error".to_owned(),
                    LogSeverity::Warning => "warning".to_owned(),
                    LogSeverity::Info => "info".to_owned(),
                },
                message: entry.message.clone(),
                source: Some(
                    serde_json::to_value(entry.source)
                        .ok()
                        .and_then(|value| value.as_str().map(str::to_owned))
                        .unwrap_or_else(|| "editor".to_owned()),
                ),
                stack_trace: None,
            })
            .collect::<Vec<_>>();
        if entries.is_empty() {
            continue;
        }
        if storage
            .append_godot_logs(&AppendGodotLogsRequest {
                run_id: run_id.to_owned(),
                entries,
            })
            .is_err()
        {
            return;
        }
    }
}

/// Stops the drain, waits for its final flush, and closes the run row.
fn stop_run_logging(status: &str) {
    let logger = RUN_LOGGER.lock().ok().and_then(|mut slot| slot.take());
    let Some(mut logger) = logger else { return };
    logger.stop.store(true, Ordering::Release);
    if let Some(worker) = logger.worker.take() {
        let _ = worker.join();
    }
    let _ = logger.storage.finish_godot_run(&FinishGodotRunRequest {
        run_id: logger.run_id.clone(),
        status: status.to_owned(),
        exit_code: None,
    });
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
    // The run is closed after the editor is stopped so the drain's last pass sees the output the
    // shutdown itself produced.
    stop_run_logging(if result.is_ok() {
        "completed"
    } else {
        "failed"
    });
    if let Some(worktree) = worktree {
        // Unstaging must read the same ledger staging wrote, or the addon is left in the worktree.
        let _ = addon_stager(app).unstage(&worktree);
    }
    stop_event_subscription();
    remember_session_task(None);
    result
}

/// Stops the session when it is the one editing `worktree`.
///
/// A worktree about to be removed must not be pulled out from under a running editor: the editor
/// would keep writing into a directory that is gone, and the addon Gofer staged in it would never be
/// unstaged. Any other session — or none — is left alone.
pub fn release_worktree<R: Runtime>(app: &AppHandle<R>, worktree: &Path) {
    let Some(running) = godot_session::current_info() else {
        return;
    };
    // The running session reports the path it resolved, so the comparison is made against the
    // canonical form of the one the task table holds.
    let resolved = crate::paths::canonical(worktree).unwrap_or_else(|_| worktree.to_path_buf());
    if Path::new(&running.worktree) != resolved {
        return;
    }
    let _ = stop_session(app);
}

/// Returns the active session summary, if any.
pub fn get_session() -> Result<Option<GodotSessionResponse>, SessionError> {
    Ok(godot_session::current_info().map(|info| to_response(&info)))
}

/// Sends one tagged RPC call to the connected addon.
pub fn call_godot<R: Runtime>(
    app: &AppHandle<R>,
    request: CallGodotRequest,
) -> Result<CallGodotResponse, RpcError> {
    require_session_task(app)?;
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

/// Opens the scene `project.godot` names, unless the editor is already editing one.
///
/// A fresh worktree has no editor state to restore, so Godot settles on an empty tab: the scene
/// tree, the inspector, and the debugger's launch all read nothing, and the launch in particular
/// starts a game that exits before it draws a frame. Opening the project's own main scene is what
/// the editor's Play button means by "the project", so it is what a ready session starts from.
pub(crate) fn open_main_scene_if_none() -> Result<(), RpcError> {
    let rpc = godot_session::rpc_session()
        .ok_or_else(|| RpcError::new("session_not_active", "No Godot session is active"))?;
    let state = addon_call(&rpc, "session.get_state", json!({}))?;
    if state
        .get("scene")
        .and_then(Value::as_str)
        .is_some_and(|scene| !scene.is_empty())
    {
        return Ok(());
    }
    let settings = addon_call(&rpc, "project.get_settings", json!({}))?;
    let main_scene = settings
        .get("mainScene")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    if main_scene.is_empty() {
        return Err(RpcError::new(
            "no_main_scene",
            "No scene is open and the project names no main scene",
        ));
    }
    addon_call(&rpc, "scene.open", json!({ "path": main_scene }))?;
    Ok(())
}

/// One addon request this module makes on its own behalf rather than on the renderer's.
fn addon_call(
    rpc: &crate::godot_rpc::RpcSession,
    command: &str,
    params: Value,
) -> Result<Value, RpcError> {
    rpc.call(RpcCallRequest {
        id: format!("session-{}", uuid::Uuid::now_v7()),
        command: command.to_owned(),
        params,
        expected_revision: None,
        timeout_ms: Some(SCENE_OPEN_TIMEOUT_MS),
    })
    .map(|response| response.result)
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
                        // The scene is opened off this thread: the open is an RPC round trip, and
                        // the events arriving behind it — including the `scene.changed` the open
                        // itself raises — must keep flowing while it is in flight.
                        if current == SessionState::Ready {
                            thread::spawn(|| {
                                let _ = open_main_scene_if_none();
                            });
                        }
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
    app.try_state::<crate::storage::StorageSlot>()
        .ok_or_else(|| {
            SessionError::new(
                "storage_unavailable",
                "Project storage has not been initialized",
            )
        })?
        .get()
        .map_err(|error| SessionError::new("storage_unavailable", error))
}

/// The stager that owns this installation's addon ledger.
pub fn addon_stager<R: Runtime>(app: &AppHandle<R>) -> AddonStager {
    AddonStager::new(ledger_path(app))
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
        session_id: info.session_id.clone(),
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::godot_session::{LogSource, SessionState};
    use crate::storage::SearchGodotLogsRequest;
    use tempfile::TempDir;

    fn session_info(session_id: &str, worktree: &Path) -> SessionInfo {
        SessionInfo {
            session_id: session_id.to_owned(),
            state: SessionState::Starting,
            rpc_address: "127.0.0.1:7000".to_owned(),
            lsp_port: 6005,
            dap_port: 6006,
            godot_version: "4.7.1.stable".to_owned(),
            worktree: worktree.display().to_string(),
        }
    }

    /// The Run button used to launch a standalone Godot process that recorded its own run; the
    /// managed session records it now. What has to survive that move is the archive: output the
    /// editor produced is still stored, still full-text searchable, and now names the session that
    /// produced it.
    #[test]
    fn session_output_is_recorded_against_the_session_and_stays_searchable() {
        let _test = godot_session::SESSION_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let directory = TempDir::new().expect("temporary directory");
        let worktree = directory.path().join("worktree");
        std::fs::create_dir(&worktree).expect("create worktree");
        let storage = ProjectStorage::open(&directory.path().join("data"), &worktree)
            .expect("open project storage");

        godot_session::clear_logs();
        godot_session::append_log(LogSource::Editor, "Godot Engine v4.7.1.stable\n");
        // A blank line is what the engine prints between phases. Storage refuses an empty message,
        // so one of them must not be able to lose the batch it arrived in.
        godot_session::append_log(LogSource::Editor, "   \n");
        godot_session::append_log(
            LogSource::EditorError,
            "ERROR: Gofer packaged fixture reported an invalid call\n",
        );

        start_run_logging(&storage, &session_info("session-1", &worktree), &worktree);
        stop_run_logging("completed");

        let hits = storage
            .search_godot_logs(&SearchGodotLogsRequest {
                query: "Gofer packaged fixture reported an invalid call".to_owned(),
                limit: None,
            })
            .expect("search recorded output");
        assert_eq!(hits.len(), 1, "the error line must reach the index");
        assert_eq!(hits[0].session_id.as_deref(), Some("session-1"));
        assert_eq!(hits[0].level, "error");
        assert_eq!(hits[0].source.as_deref(), Some("editorError"));

        // Stopping twice is what a crashed editor followed by a normal stop looks like: the
        // second stop finds no logger and answers rather than closing someone else's run.
        stop_run_logging("completed");
    }

    /// Storage that cannot record the run must not stop the editor from being usable: the failure
    /// is reported where the user is already looking for what the editor is doing.
    #[test]
    fn a_run_that_cannot_be_recorded_is_reported_into_the_session_buffer() {
        let _test = godot_session::SESSION_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let directory = TempDir::new().expect("temporary directory");
        let worktree = directory.path().join("worktree");
        std::fs::create_dir(&worktree).expect("create worktree");
        let storage = ProjectStorage::open(&directory.path().join("data"), &worktree)
            .expect("open project storage");
        std::fs::remove_dir_all(directory.path()).expect("remove the storage directory");

        godot_session::clear_logs();
        start_run_logging(&storage, &session_info("session-2", &worktree), &worktree);
        stop_run_logging("failed");

        let page = godot_session::read_logs(&LogQuery::default()).expect("read session logs");
        assert!(
            page.entries.iter().any(|entry| entry
                .message
                .contains("could not record this session's run")),
            "the failure must be visible in the session output: {:?}",
            page.entries
        );
    }
}

//! Public desktop API for Gofer-managed Godot sessions.
//!
//! This layer binds each session to the active task's isolated worktree, stages the Gofer addon
//! through [`crate::addon::AddonStager`], exposes the Tauri commands the renderer uses, and
//! forwards addon events through a Tauri channel.

use crate::addon::AddonStager;
use crate::approvals::ApprovalError;
use crate::files::Workspace;
use crate::godot_policy;
use crate::godot_rpc::{CallRequest as RpcCallRequest, ResponseEnvelope, RpcError};
use crate::godot_session::{
    self, LaunchRequest, LogQuery, LogSeverity, SessionError, SessionInfo, SessionState,
};
use crate::settings::{GodotSettings, read_godot_settings};
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
/// How often the session watch looks at what state the editor is in.
const SESSION_WATCH_TICK: Duration = Duration::from_millis(50);

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
///
/// No id: the session mints one. The renderer used to send a `crypto.randomUUID()` it never read
/// back, which made it a seventh place inventing a value whose rules live in the transport.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CallGodotRequest {
    pub command: String,
    pub params: Value,
    #[serde(default)]
    pub expected_revision: Option<u64>,
    /// The scene that revision was read from. See `CallRequest::about`.
    #[serde(default)]
    pub expected_scene: Option<String>,
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

/// What entering a state obliges Gofer to do, beyond telling the window about it.
///
/// A table rather than a branch inside a loop, so what a transition means can be read in one place
/// and tested without an editor. The effects it names are carried out by [`settle_transition`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AfterTransition {
    /// Nothing. The window is told, and that is all the transition asks for.
    Nothing,
    /// The addon can be asked things now: apply the Godot rules the user chose, and open the
    /// project's main scene if the editor came up editing none.
    SettleReadyEditor,
}

/// What one transition means. See [`AfterTransition`].
///
/// Entering `Ready` from `Playing` is a game that stopped rather than an editor that arrived, and
/// it settles again — which is what this has always done. Both effects are safe to repeat, and
/// narrowing the rule is a separate decision from making it happen at all.
fn after_transition(_from: SessionState, to: SessionState) -> AfterTransition {
    match to {
        SessionState::Ready => AfterTransition::SettleReadyEditor,
        _ => AfterTransition::Nothing,
    }
}

/// Watches one session for the whole of its life, whatever happens to be listening.
///
/// The state a session is in is derived from three live facts rather than stored, and this is the
/// thing that looks at them. It belongs to the session because what a transition obliges Gofer to
/// do is owed to the session, not to a subscriber: the Godot rules the user ticked in Settings are
/// applied when the editor becomes ready, and an editor that exits has bookkeeping to do whether or
/// not a window is open on it.
///
/// It used to be the event subscription's second job. That subscription is refused while the editor
/// has no RPC channel yet — the ordinary state of one that is still starting — so the renderer's
/// first attempt fails and a reconcile tick asks again later. A subscriber that attaches after the
/// editor is already `Ready` seeds its own `last_state` with `Ready`, the edge never fires, and the
/// rules were silently never applied. Both effects were discarded with `let _ =`, so nothing said
/// so, and `enforce_godot_policy` had exactly one caller: that edge.
struct SessionWatch {
    stop: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}

impl SessionWatch {
    fn stop(mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

static SESSION_WATCH: Mutex<Option<SessionWatch>> = Mutex::new(None);

/// Carries out what [`after_transition`] named, and tells the window either way.
fn settle_transition<R: Runtime>(app: &AppHandle<R>, from: SessionState, to: SessionState) {
    emit_state_changed(app, to);
    if after_transition(from, to) != AfterTransition::SettleReadyEditor {
        return;
    }
    // Read here rather than on the spawned thread so a settings file that cannot be read leaves the
    // rules alone instead of guessing at them. Godot reads the embed mode once, when its game view
    // becomes ready, so a session that has already started is the last moment this can be set for
    // that session at all.
    let godot = read_godot_settings(app).ok();
    // Off this thread: opening a scene is an RPC round trip, and the watch has to keep looking
    // while it is in flight.
    thread::spawn(move || {
        if let Some(godot) = godot {
            let _ = enforce_godot_policy(&godot);
        }
        let _ = open_main_scene_if_none();
    });
}

/// Starts the watch for the session that has just started, replacing any that came before.
fn start_session_watch<R: Runtime>(app: &AppHandle<R>) {
    stop_session_watch();

    let stop = Arc::new(AtomicBool::new(false));
    let flag = Arc::clone(&stop);
    let app = app.clone();
    // Seeded from the state the session is in right now, which a session that has just started is
    // `Starting` — so the arrival at `Ready` is a transition this has seen the whole of.
    let mut last_state = godot_session::current_state();
    let worker = thread::spawn(move || {
        while !flag.load(Ordering::Acquire) {
            thread::sleep(SESSION_WATCH_TICK);
            // An editor that is gone is noticed here, in time, rather than whenever the window next
            // asks. This does the bookkeeping and tells the window itself, so there is nothing left
            // for the loop to report.
            if noticed_editor_exit(&app) {
                break;
            }
            let current = godot_session::current_state();
            if current == last_state {
                continue;
            }
            settle_transition(&app, last_state, current);
            last_state = current;
        }
    });

    if let Ok(mut slot) = SESSION_WATCH.lock() {
        *slot = Some(SessionWatch {
            stop,
            worker: Some(worker),
        });
    }
}

fn stop_session_watch() {
    if let Ok(mut slot) = SESSION_WATCH.lock()
        && let Some(watch) = slot.take()
    {
        watch.stop();
    }
}

/// The task the running editor session belongs to.
///
/// A session is pinned to the worktree it started in; the active task is whatever the sidebar last
/// pointed at. Nothing kept the two together, so switching tasks with a session running left every
/// panel reading one task's editor while the file tools — the agent's included — wrote into
/// another's checkout. The scene that answered was a scene the user was not looking at, and nothing
/// on screen said so. This is what a call is checked against.
/// The handle the editor's guards read the project through.
///
/// Set once when the window is built. The three doors to the editor are `call_godot`, the language
/// server and the debug adapter, and only the first carries a handle: Monaco's commands and the
/// agent's script and debug tools reach `script`/`debug` with nothing but a request. Without this
/// the one guard in front of the editor could only stand in front of one of its three doors.
///
/// A handle that was never set — a headless test, a suite that builds no window — means the guard
/// has nothing to compare against, which is the same answer it already gives for a project it
/// cannot read: not evidence of a mismatch, so not treated as one.
static GUARD_APP: Mutex<Option<AppHandle>> = Mutex::new(None);

/// Remembers the handle the guards read through. Called once, from the app's setup.
pub fn remember_app(app: AppHandle) {
    if let Ok(mut slot) = GUARD_APP.lock() {
        *slot = Some(app);
    }
}

/// Refuses a call when the editor belongs to a task the window has moved away from.
///
/// The same guard `call_godot` takes, for the two doors that carry no handle. See [`GUARD_APP`].
pub(crate) fn require_session_task_here() -> Result<(), RpcError> {
    let Some(app) = GUARD_APP.lock().ok().and_then(|slot| slot.clone()) else {
        return Ok(());
    };
    require_session_task(&app)
}

/// Which task the running editor session belongs to.
///
/// Three states, not two, and the third is the whole point. `Unknown` used to be spelled the same
/// as `NoTask` — `storage.tasks().active().ok().flatten()` folds "the query failed" into "there is
/// no task" — and `NoTask` is permissive, so one transient database error at session start
/// disarmed the cross-task guard for the entire session. A question that could not be answered is
/// not an answer. It is asked again.
#[derive(Clone, Debug, PartialEq)]
enum SessionOwner {
    /// The owner could not be read when the session started. Resolved on first use.
    Unknown,
    /// Read successfully, and this project has no active task. Nothing to cross.
    NoTask,
    /// The task the session was started for.
    Task(String),
}

static SESSION_TASK: Mutex<SessionOwner> = Mutex::new(SessionOwner::NoTask);

fn remember_session_task(task_id: Result<Option<String>, impl std::fmt::Debug>) {
    let owner = match task_id {
        Ok(Some(id)) => SessionOwner::Task(id),
        Ok(None) => SessionOwner::NoTask,
        Err(_) => SessionOwner::Unknown,
    };
    if let Ok(mut held) = SESSION_TASK.lock() {
        *held = owner;
    }
}

/// Which task owns the running session's worktree, read from the task list rather than from the
/// active task.
///
/// The fallback for an owner that could not be recorded when the session started. A worktree is
/// one task's directory for the whole life of that task, so it identifies the owner without asking
/// what the window is looking at now. Still `Unknown` when the list cannot be read either — the
/// question stays open rather than being closed by a second failure.
fn session_owner_by_worktree(storage: &ProjectStorage) -> SessionOwner {
    let Some(info) = godot_session::current_info() else {
        return SessionOwner::Unknown;
    };
    let Ok(tasks) = storage.tasks().list() else {
        return SessionOwner::Unknown;
    };
    let session_worktree = Path::new(&info.worktree);
    tasks
        .into_iter()
        .find(|task| {
            task.worktree
                .as_ref()
                .is_some_and(|tree| Path::new(&tree.worktree_path) == session_worktree)
        })
        // A list that was read and matched nothing is an answer: this session is not running out of
        // any task's worktree, so there is no task to cross. Only a list that could not be read at
        // all leaves the question open.
        .map_or(SessionOwner::NoTask, |task| SessionOwner::Task(task.id))
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
    let held = owner.clone();
    drop(owner);
    // A storage that cannot be read is not evidence of a mismatch, so it is not treated as one.
    let Ok(storage) = project_storage(app) else {
        return Ok(());
    };
    // An owner nobody could read at session start is worked out now, from the session's own
    // worktree — not from whichever task is active, which is the question being asked, not the
    // answer. The worktree is what the session was started on and it does not move, so the
    // task that owns that directory is still the task that owns the session.
    let held = match held {
        SessionOwner::Unknown => {
            let resolved = session_owner_by_worktree(&storage);
            // Only a definite answer is kept. Storing `Unknown` would cache the failure and refuse
            // every call for the rest of the session — the same latching this whole change is
            // about, one level up.
            if resolved != SessionOwner::Unknown
                && let Ok(mut slot) = SESSION_TASK.lock()
            {
                *slot = resolved.clone();
            }
            resolved
        }
        held => held,
    };
    let session_task = match held {
        SessionOwner::Task(id) => id,
        SessionOwner::NoTask => return Ok(()),
        // Refused, not allowed. This is the guard's own principle applied to its own ignorance:
        // answering out of a checkout nobody can name is exactly the failure it exists to stop,
        // and "I could not tell" is not evidence that there is nothing to tell.
        SessionOwner::Unknown => {
            return Err(RpcError::new(
                "session_owner_unknown",
                "Gofer could not tell which task this editor session belongs to, so it will not \
                 answer out of it. Restart the editor session to bind it to this task.",
            ));
        }
    };
    let Ok(active) = storage.tasks().active() else {
        return Ok(());
    };
    if active.as_deref() == Some(session_task.as_str()) {
        return Ok(());
    }
    // The task is named rather than merely referred to. "Another task" is true and useless: the
    // sidebar holds several, and the user cannot tell which one to open from a refusal that will
    // not say. The title travels in the details too, because a button is built from those.
    let title = storage
        .tasks()
        .list()
        .ok()
        .and_then(|tasks| {
            tasks
                .into_iter()
                .find(|task| task.id == session_task)
                .map(|task| task.title)
        })
        .filter(|title| !title.trim().is_empty());
    let message = match &title {
        Some(title) => format!(
            "The Godot editor session belongs to the task “{title}”. Open that task, or stop the \
             session and start one here."
        ),
        None => "The Godot editor session belongs to another task. Open that task, or stop the \
                 session and start one here."
            .to_owned(),
    };
    Err(
        RpcError::new("session_other_task", message).with_details(json!({
            "taskId": session_task,
            "taskTitle": title,
        })),
    )
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
    let worktree = storage.tasks().active_workspace().map_err(|error| {
        SessionError::new(
            "no_active_task_workspace",
            format!("A Godot session can only start for an active task branch: {error}"),
        )
    })?;

    // A session whose editor is gone must not answer for this start. Answering with it is what
    // "starting a session that is already running answers with the one that is running" used to do
    // to a dead one: the call returned the failed session, reported success, and started nothing,
    // so the button the user pressed to get their editor back did nothing at all.
    noticed_editor_exit(app);
    if let Some(running) = godot_session::current_info()
        && !godot_session::editor_has_exited()
    {
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
                "The project could not be opened for the active task: {}",
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
        binary: crate::workspace::configured_godot_binary(app),
        // The other half of the same rule. `enforce_godot_policy` writes the editor setting once
        // the editor is ready; this decides the display driver it is launched with, because on
        // Linux only one of them can embed anything. A settings file that cannot be read falls
        // back to what a machine that never chose gets, rather than to "off".
        embed_game_window: read_godot_settings(app)
            .map(|godot| godot.embed_game_window)
            .unwrap_or_else(|_| GodotSettings::default().embed_game_window),
    }) {
        Ok(info) => {
            remember_session_task(storage.tasks().active());
            start_run_logging(&storage, &info, &worktree);
            // Started with the session, not with a subscription, so what the editor becoming ready
            // obliges Gofer to do happens whether or not a window is listening for it.
            start_session_watch(app);
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
    stop_run_logging(RunOutcome::Aborted);
    let run = match storage.runs().start_in(
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
            .runs()
            .append_logs(&AppendGodotLogsRequest {
                run_id: run_id.to_owned(),
                entries,
            })
            .is_err()
        {
            return;
        }
    }
}

/// How a run ended, in the three words the run table accepts.
///
/// A `&str` here was one typo away from a run that never closed: the store refuses a status it does
/// not know, the refusal is not worth failing a shutdown over, and so the row sat at `running`
/// forever for an editor that had exited. Spelling it as a type is what makes that unwritable.
#[derive(Clone, Copy)]
enum RunOutcome {
    Completed,
    Failed,
    Aborted,
}

impl RunOutcome {
    fn as_str(self) -> &'static str {
        match self {
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Aborted => "aborted",
        }
    }
}

/// Stops the drain, waits for its final flush, and closes the run row.
fn stop_run_logging(outcome: RunOutcome) {
    let logger = RUN_LOGGER.lock().ok().and_then(|mut slot| slot.take());
    let Some(mut logger) = logger else { return };
    logger.stop.store(true, Ordering::Release);
    if let Some(worker) = logger.worker.take() {
        let _ = worker.join();
    }
    let _ = logger.storage.runs().finish(&FinishGodotRunRequest {
        run_id: logger.run_id.clone(),
        status: outcome.as_str().to_owned(),
        exit_code: None,
    });
}

/// How an editor session ended, and therefore what is left to take back.
enum SessionEnd<'a> {
    /// Gofer stopped it. The process is still there to be killed, and the worktree is still the one
    /// the addon was staged into, so both are dealt with here.
    Stopped {
        worktree: Option<PathBuf>,
        stager: &'a AddonStager,
    },
    /// The editor exited on its own — it crashed, or the user closed the window. There is nothing
    /// to kill and nothing that may safely be unstaged from under a directory Gofer no longer knows
    /// the state of; only the bookkeeping a stop would have done.
    Exited,
}

/// What ending a session needs from the editor it is ending.
///
/// The two lifecycle questions, held apart from [`godot_session::Editor`] because these are the
/// ones a fake has to be able to answer *badly*. `end_session` branches on an editor that refuses
/// to stop, and no adapter reading the supervisor's static can ever say no — so the branch that
/// decides whether a run row is recorded as completed or failed had no test at all.
trait EditorLifecycle {
    /// Releases whatever binding is in front of the supervisor's session, answering whether there
    /// was one.
    ///
    /// Done before the stop below. Every reader asks the binding first, so an editor bound by
    /// something else would still answer as running after this returned — and a stop that leaves an
    /// editor answering is a stop the caller cannot check.
    fn release_binding(&self) -> bool;

    /// Ends the editor process.
    fn stop(&self) -> Result<(), SessionError>;
}

/// The editor this process's supervisor started, which is the one production always ends.
struct SupervisedEditor;

impl EditorLifecycle for SupervisedEditor {
    fn release_binding(&self) -> bool {
        let was_bound = godot_session::is_bound();
        godot_session::bind(None);
        was_bound
    }

    fn stop(&self) -> Result<(), SessionError> {
        godot_session::stop()
    }
}

/// Ends a session, in the one order the steps have to happen in.
///
/// Two things end a session and they used to write this out separately, so the order was knowledge
/// held by the order of statements in one function and half-repeated in the other — and the half
/// that was repeated was missing two steps. It is knowledge: the clients go before the process, the
/// run closes after it, the addon comes out only once nothing is reading it, and the bookkeeping is
/// last. A third ending should not have to rediscover any of it.
fn end_session(end: SessionEnd<'_>) -> Result<(), SessionError> {
    end_session_with(end, &SupervisedEditor)
}

/// The step list both endings walk, with a yes/no per step rather than two functions that drift.
fn end_session_with(end: SessionEnd<'_>, editor: &dyn EditorLifecycle) -> Result<(), SessionError> {
    let stopped_by_gofer = matches!(end, SessionEnd::Stopped { .. });

    // 1. The language server and the debug adapter both die with the editor, so the cached clients
    //    are dropped before the process is stopped rather than left to fail the renderer's next
    //    script or debugger request.
    crate::script::disconnect();
    crate::debug::disconnect();

    // 2. The watch, but only for a stop. An exit is noticed *by* the watch, which breaks its own
    //    loop, and joining it from inside itself would never return.
    if stopped_by_gofer {
        stop_session_watch();
    }

    // 3. The process, again only for a stop: an editor that exited on its own has nothing left to
    //    kill. A binding released with nothing of the supervisor's behind it is a complete ending,
    //    not a failure.
    let result = if stopped_by_gofer {
        let was_bound = editor.release_binding();
        match editor.stop() {
            Err(error) if was_bound && error.code == "session_not_active" => Ok(()),
            other => other,
        }
    } else {
        Ok(())
    };

    // 4. The run row, after the editor is stopped so the drain's last pass sees the output the
    //    shutdown itself produced. An editor that exited on its own did not complete anything.
    stop_run_logging(if stopped_by_gofer && result.is_ok() {
        RunOutcome::Completed
    } else {
        RunOutcome::Failed
    });

    // 5. The addon, once nothing is reading it. Only a stop may do this: after an exit Gofer no
    //    longer knows the state of the directory, and unstaging from under one it does not know is
    //    how the addon is left half out.
    if let SessionEnd::Stopped {
        worktree: Some(worktree),
        stager,
    } = end
    {
        // Unstaging must read the same ledger staging wrote, or the addon is left in the worktree.
        let _ = stager.unstage(&worktree);
    }

    // 6. The bookkeeping, for both. An exit used to skip these two, so after a crash the events
    //    kept being forwarded from a session that was gone, and the next refusal named the task the
    //    dead editor had belonged to rather than the one the window is on.
    stop_event_subscription();
    remember_session_task(Ok::<_, ()>(None));
    result
}

/// Stops the active session and removes the staged addon.
pub fn stop_session<R: Runtime>(app: &AppHandle<R>) -> Result<(), SessionError> {
    // Read before anything is torn down: this is the running session's own worktree, and stopping
    // is what makes it unreadable.
    let worktree = current_worktree();
    end_session(SessionEnd::Stopped {
        worktree,
        stager: &addon_stager(app),
    })
}

/// Stops the session when it is the one editing `worktree`, and answers whether it is now free.
///
/// A working tree about to move must not be pulled out from under a running editor. Godot holds
/// every open scene in memory, never rereads one a checkout changed underneath it, and saves the
/// copy it still holds over whatever is there now — with no error anywhere. A worktree about to be
/// removed is worse: the editor keeps writing into a directory that is gone, and the addon Gofer
/// staged in it is never unstaged.
///
/// The failure used to be thrown away here, so a stop that did not happen read exactly like one
/// that did and the checkout moved regardless. The caller is told instead, and refuses.
///
/// An editor in some other worktree is not this task's to stop, and is left alone.
///
/// Having no editor to stop is not the same as having nothing to release. A session that died
/// without its stop — a crash, a kill — leaves the addon staged, and returning early here left it
/// staged through the commit the caller takes next. That commit records Gofer's two lines in
/// `project.godot` while `addons/gofer` stays hidden by the exclude entry, so the project keeps a
/// pointer to an addon no checkout of it has.
pub fn release_worktree<R: Runtime>(app: &AppHandle<R>, worktree: &Path) -> Result<(), String> {
    release_worktree_with(app, &addon_stager(app), worktree)
}

fn release_worktree_with<R: Runtime>(
    app: &AppHandle<R>,
    stager: &AddonStager,
    worktree: &Path,
) -> Result<(), String> {
    // The running session reports the path it resolved, so the comparison is made against the
    // canonical form of the one the task table holds.
    let resolved = crate::paths::canonical(worktree).unwrap_or_else(|_| worktree.to_path_buf());
    let ours = godot_session::current_info()
        .is_some_and(|running| Path::new(&running.worktree) == resolved);
    if ours {
        // Stopping the session is what unstages the addon.
        return stop_session(app).map_err(|error| {
            format!(
                "The Godot editor could not be stopped, so the files were left as they are: {}",
                error.message
            )
        });
    }
    // Unstaged against the same canonical path staging wrote, or the entry is not found.
    let _ = stager.unstage(&resolved);
    Ok(())
}

/// Returns the active session summary, if any.
///
/// An editor that exited on its own is noticed here, because this is what the window polls. Before
/// that, closing the Godot window left Gofer presenting the session it last had: the badge read
/// ready, the panels offered Run, every call failed with a transport error that named nothing, and
/// the stored run row stayed `running` for a process that was gone.
pub fn get_session<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<Option<GodotSessionResponse>, SessionError> {
    noticed_editor_exit(app);
    Ok(godot_session::current_info().map(|info| to_response(&info)))
}

/// Marks a session whose editor has exited, and does the bookkeeping a stop would have done.
///
/// Called from the event tick, which is what notices in time, and from `get_session`, which is what
/// notices when nothing is subscribed. Answers whether this call was the one that found it, so the
/// caller can stop looking.
fn noticed_editor_exit<R: Runtime>(app: &AppHandle<R>) -> bool {
    if !godot_session::poll_editor_exit() {
        return false;
    }
    let _ = end_session(SessionEnd::Exited);
    emit_state_changed(app, SessionState::Error);
    true
}

/// Sends one tagged RPC call to the connected addon.
pub fn call_godot<R: Runtime>(
    app: &AppHandle<R>,
    request: CallGodotRequest,
) -> Result<CallGodotResponse, RpcError> {
    require_session_task(app)?;
    let rpc = godot_session::rpc_session()
        .ok_or_else(|| RpcError::new("session_not_active", "No Godot session is active"))?;
    let response = rpc.call(
        RpcCallRequest::new(request.command, request.params)
            .expecting(request.expected_revision)
            .about(request.expected_scene)
            .within(request.timeout_ms),
    )?;
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

/// Holds the live editor to the Godot rules the user chose.
///
/// Every call is made, in order, even after one fails: the five typing warnings and the embed mode
/// are independent settings, and a project that refuses one has no reason to be left without the
/// other four. The first failure is what comes back, so a caller that reports it reports a real
/// one rather than the last one.
pub(crate) fn enforce_godot_policy(settings: &GodotSettings) -> Result<(), RpcError> {
    let rpc = godot_session::rpc_session()
        .ok_or_else(|| RpcError::new("session_not_active", "No Godot session is active"))?;
    let mut failure = None;
    for call in godot_policy::policy_calls(settings) {
        if let Err(error) = addon_call(&rpc, call.command, call.params)
            && failure.is_none()
        {
            failure = Some(error);
        }
    }
    match failure {
        Some(error) => Err(error),
        None => Ok(()),
    }
}

/// One addon request this module makes on its own behalf rather than on the renderer's.
fn addon_call(
    rpc: &crate::godot_rpc::RpcSession,
    command: &str,
    params: Value,
) -> Result<Value, RpcError> {
    rpc.call(RpcCallRequest::new(command, params).within(Some(SCENE_OPEN_TIMEOUT_MS)))
        .map(|response| response.result)
}

/// Streams addon events through a Tauri channel until the session stops or the renderer
/// unsubscribes.
///
/// Forwarding, and nothing else. What state the session is in, and what a change of it obliges
/// Gofer to do, belong to [`SessionWatch`] — which is started with the session rather than with a
/// subscription, so neither depends on anything being subscribed.
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

    // The state a subscriber arrives to, so a window that attaches mid-session draws the editor it
    // actually has rather than waiting for the next change.
    emit_state_changed(app, godot_session::current_state());

    let worker = thread::spawn(move || {
        while !flag.load(Ordering::Acquire) {
            match events.recv_timeout(Duration::from_millis(EVENT_FORWARD_INTERVAL_MS)) {
                Ok(envelope) => {
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
        .map_err(|error| SessionError::new("storage_unavailable", error.message))
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

    /// Every state a session can be in, so a new one has to be given an answer here rather than
    /// falling into `Nothing` because nobody thought about it.
    const EVERY_STATE: [SessionState; 9] = [
        SessionState::Offline,
        SessionState::Staging,
        SessionState::Starting,
        SessionState::Importing,
        SessionState::Ready,
        SessionState::Playing,
        SessionState::DebugPaused,
        SessionState::Stopping,
        SessionState::Error,
    ];

    /// Arriving at `Ready` is what settles an editor, and it is arriving that does it — from any
    /// state, because which one it came from is not what makes the rules apply.
    ///
    /// This is the whole of the decision the session watch makes. It used to be an `if` inside the
    /// event subscription's loop, where the reachable half depended on when a renderer happened to
    /// subscribe.
    #[test]
    fn every_arrival_at_ready_settles_the_editor_and_nothing_else_does() {
        for to in EVERY_STATE {
            for from in EVERY_STATE {
                let expected = if to == SessionState::Ready {
                    AfterTransition::SettleReadyEditor
                } else {
                    AfterTransition::Nothing
                };
                assert_eq!(
                    after_transition(from, to),
                    expected,
                    "{from:?} -> {to:?} must settle only when it arrives at Ready"
                );
            }
        }
    }

    fn session_info(session_id: &str, worktree: &Path) -> SessionInfo {
        SessionInfo {
            session_id: session_id.to_owned(),
            state: SessionState::Starting,
            rpc_address: "127.0.0.1:7000".to_owned(),
            lsp_port: 6005,
            dap_port: 6006,
            godot_version: "4.7.2.stable".to_owned(),
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
        godot_session::append_log(LogSource::Editor, "Godot Engine v4.7.2.stable\n");
        // A blank line is what the engine prints between phases. Storage refuses an empty message,
        // so one of them must not be able to lose the batch it arrived in.
        godot_session::append_log(LogSource::Editor, "   \n");
        godot_session::append_log(
            LogSource::EditorError,
            "ERROR: Gofer packaged fixture reported an invalid call\n",
        );

        start_run_logging(&storage, &session_info("session-1", &worktree), &worktree);
        stop_run_logging(RunOutcome::Completed);

        let hits = storage
            .runs()
            .search_logs(&SearchGodotLogsRequest {
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
        stop_run_logging(RunOutcome::Completed);
    }

    /// The run table takes three words and refuses everything else, and the refusal is swallowed
    /// where a run is closed — closing it is bookkeeping, not something worth failing a shutdown
    /// over. So a status it does not know is silent: the row stays `running` for an editor that
    /// exited, and the only place it shows up is the user's run history, later.
    #[test]
    fn every_run_outcome_is_a_status_the_run_table_accepts() {
        let directory = TempDir::new().expect("temporary directory");
        let worktree = directory.path().join("worktree");
        std::fs::create_dir(&worktree).expect("create worktree");
        let storage = ProjectStorage::open(&directory.path().join("data"), &worktree)
            .expect("open project storage");

        for outcome in [
            RunOutcome::Completed,
            RunOutcome::Failed,
            RunOutcome::Aborted,
        ] {
            let run = storage
                .runs()
                .start_in(
                    &StartGodotRunRequest {
                        task_id: None,
                        session_id: None,
                        godot_version: None,
                        metadata: json!({}),
                    },
                    &worktree,
                )
                .expect("open a run to close");
            storage
                .runs()
                .finish(&FinishGodotRunRequest {
                    run_id: run.id,
                    status: outcome.as_str().to_owned(),
                    exit_code: None,
                })
                .unwrap_or_else(|error| {
                    panic!("closing a run as {} must work: {error}", outcome.as_str())
                });
        }
    }

    /// Unbinds the editor on the way out, however the test left.
    ///
    /// The binding is process-wide, so a test that returned early with an editor still bound would
    /// hand the next test an editor that is not there.
    struct PlantedSession;

    impl PlantedSession {
        fn new(worktree: &Path, task_id: &str) -> Self {
            godot_session::bind(Some(Arc::new(godot_session::ExternalEditor::new(
                session_info("session-guard", worktree),
            ))));
            remember_session_task(Ok::<_, ()>(Some(task_id.to_owned())));
            Self
        }
    }

    impl Drop for PlantedSession {
        fn drop(&mut self) {
            godot_session::bind(None);
            remember_session_task(Ok::<_, ()>(None));
        }
    }

    /// The regression: an owner nobody could read at session start must not disarm the guard.
    ///
    /// `remember_session_task` used to be fed `storage.tasks().active().ok().flatten()`, which
    /// spells a failed query and a genuinely task-less project the same way — and the task-less
    /// spelling is permissive. One transient database error in that instant turned the cross-task
    /// guard off for the whole session, silently. The unknown case is now asked again on first use.
    #[test]
    fn an_owner_that_could_not_be_read_is_asked_again_rather_than_assumed_absent() {
        let _test = godot_session::SESSION_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let directory = TempDir::new().expect("temporary directory");
        let worktree = directory.path().join("worktree");
        std::fs::create_dir(&worktree).expect("create worktree");
        let storage = ProjectStorage::open(&directory.path().join("data"), &worktree)
            .expect("open project storage");
        let first = storage
            .tasks()
            .active()
            .expect("read the active task")
            .expect("opening the storage leaves a task active");
        let app = tauri::test::mock_builder()
            .build(crate::app_context())
            .expect("build mock Tauri app");
        app.manage(crate::storage::StorageSlot::new(Ok(storage.clone())));

        let _planted = PlantedSession::new(&worktree, &first);
        // The session started, but the question "whose is it?" failed at that moment.
        remember_session_task(Err::<Option<String>, _>("the database was busy"));

        // The window then moves to another task. A guard that had recorded the failure as "no
        // task" would answer this happily, out of the first task's checkout.
        let second = storage
            .tasks()
            .create(&storage.switch_with_no_turn_to_refuse(&|_| Ok(())))
            .expect("create a second task")
            .task_id
            .expect("the new task has an id");
        assert_ne!(second, first);

        // The owner is worked out from the session's own worktree rather than from whichever task
        // is active — which is the question, not the answer. These tasks have no worktree of their
        // own, so the list is read, nothing matches, and there is genuinely no task to cross.
        assert_eq!(
            session_owner_by_worktree(&storage),
            SessionOwner::NoTask,
            "a list that was read and matched nothing is an answer, not a failure"
        );
        require_session_task(app.handle())
            .expect("a session that belongs to no task's worktree has nothing to cross");

        // A definite answer is kept, so the question is asked once rather than on every call.
        assert_eq!(
            *SESSION_TASK.lock().expect("owner"),
            SessionOwner::NoTask,
            "the resolved answer replaces Unknown"
        );

        // And once the owner is known, the ordinary rules resume: the window has moved on.
        remember_session_task(Ok::<_, ()>(Some(first.clone())));
        let named = require_session_task(app.handle())
            .expect_err("the window has moved to the second task");
        assert_eq!(named.code, "session_other_task");
        assert_eq!(named.details["taskId"], json!(first));
    }

    /// The half that must not be lost while fixing the latch.
    ///
    /// `Unknown` is the state where the question has no answer. What changed is only that it is not
    /// *cached* as one — the next call asks again — and that "read the list, matched nothing"
    /// stopped counting as unanswerable.
    #[test]
    fn an_unanswered_owner_is_not_written_down_as_absent() {
        let _test = godot_session::SESSION_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let app = tauri::test::mock_builder()
            .build(crate::app_context())
            .expect("build mock Tauri app");
        // No storage at all, so the owner can never be worked out.
        godot_session::bind(Some(Arc::new(godot_session::ExternalEditor::absent())));
        remember_session_task(Err::<Option<String>, _>("the database was busy"));

        // Without storage the guard has nothing to compare against and says nothing, which is the
        // pre-existing rule. What matters is that the failure was not written down as "no task".
        assert!(require_session_task(app.handle()).is_ok());
        assert_eq!(
            *SESSION_TASK.lock().expect("owner"),
            SessionOwner::Unknown,
            "an unanswered question stays unanswered rather than caching itself as absent"
        );
        remember_session_task(Ok::<_, ()>(None));
        godot_session::bind(None);
    }

    /// A call is refused when the session belongs to a task the window has moved away from, and
    /// answered when it does not.
    ///
    /// The refusal was found in a live sweep, where the agent asked for the scene tree after the
    /// user switched tasks and was told about `Level1` — a scene from a checkout its task had
    /// nothing to do with. It read exactly like an answer about the task in front of it.
    #[test]
    fn a_call_is_refused_only_when_the_session_belongs_to_another_task() {
        let _test = godot_session::SESSION_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let directory = TempDir::new().expect("temporary directory");
        let worktree = directory.path().join("worktree");
        std::fs::create_dir(&worktree).expect("create worktree");
        let storage = ProjectStorage::open(&directory.path().join("data"), &worktree)
            .expect("open project storage");
        // Opening the storage leaves one task active, which is the task the session will own.
        let first = storage
            .tasks()
            .active()
            .expect("read the active task")
            .expect("opening the storage leaves a task active");
        let app = tauri::test::mock_builder()
            .build(crate::app_context())
            .expect("build mock Tauri app");
        app.manage(crate::storage::StorageSlot::new(Ok(storage.clone())));

        // No session at all: there is nothing to be wrong about, and the guard says nothing. The
        // absent editor is bound rather than left unbound, because the supervisor's own answer
        // depends on whether some other test in this process left a real session behind.
        godot_session::bind(Some(Arc::new(godot_session::ExternalEditor::absent())));
        remember_session_task(Ok::<_, ()>(Some("some-other-task".to_owned())));
        require_session_task(app.handle()).expect("no session means nothing to refuse");
        remember_session_task(Ok::<_, ()>(None));

        let _planted = PlantedSession::new(&worktree, &first);
        require_session_task(app.handle())
            .expect("the session's own task must be able to call into it");

        // Switching tasks is what makes the same session the wrong one to answer from.
        let second = storage
            .tasks()
            .create(&storage.switch_with_no_turn_to_refuse(&|_| Ok(())))
            .expect("create a second task")
            .task_id
            .expect("the new task has an id");
        assert_ne!(second, first, "the second task must be a different task");
        let refused =
            require_session_task(app.handle()).expect_err("another task's session must not answer");
        assert_eq!(refused.code, "session_other_task");
        // The refusal has to be actionable: the window builds an "open that task" control out of
        // these, and the user reads the title out of the sentence.
        assert_eq!(refused.details["taskId"], json!(first));
        assert_eq!(refused.details["taskTitle"], json!("New task"));
        assert!(
            refused.message.contains("New task"),
            "the refusal must name the task that owns the session: {}",
            refused.message
        );

        // And moving back is enough to make it answerable again — nothing has to be restarted.
        storage
            .tasks()
            .activate(&first, &storage.switch_with_no_turn_to_refuse(&|_| Ok(())))
            .expect("switch back");
        require_session_task(app.handle()).expect("the session's own task answers again");
    }

    /// Releasing a worktree no editor is holding still has to unstage the addon.
    ///
    /// A session that died without its stop leaves the addon staged. Every caller of this commits
    /// the checkout straight afterwards, and `git add --all` then records Gofer's two lines in
    /// `project.godot` — while `addons/gofer` itself stays hidden behind the exclude entry. What
    /// lands in the user's history is a project naming an addon no checkout of it has, and Godot
    /// answers that with three errors on every open.
    #[test]
    fn releasing_a_worktree_with_no_editor_still_unstages_the_addon() {
        let _test = godot_session::SESSION_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let directory = TempDir::new().expect("temporary directory");
        let worktree = directory.path().join("worktree");
        std::fs::create_dir(&worktree).expect("create worktree");
        std::fs::write(worktree.join("project.godot"), "config_version=5\n").expect("project file");
        let workspace = Workspace::open(&worktree).expect("workspace");
        // The stager is handed in rather than read off the app: a test may never stage into, or
        // unstage out of, the developer's own Gofer installation.
        let stager = AddonStager::new(directory.path().join("ledger.json"));
        let app = tauri::test::mock_builder()
            .build(crate::app_context())
            .expect("build mock Tauri app");

        stager.stage(&workspace).expect("stage the addon");
        assert!(workspace.root().join("addons/gofer").is_dir());

        // The editor that staged it is gone, and nothing else took its place.
        godot_session::bind(None);
        release_worktree_with(app.handle(), &stager, workspace.root()).expect("release");

        assert!(
            !workspace.root().join("addons").exists(),
            "the addon must not survive the release"
        );
        let project = std::fs::read_to_string(workspace.root().join("project.godot"))
            .expect("read the project file");
        assert!(
            !project.contains(crate::addon::AUTOLOAD_TARGET),
            "the commit the caller takes next must not carry the autoload: {project}"
        );
        assert!(
            !project.contains(crate::addon::PLUGIN_ENTRY),
            "nor the editor plugin: {project}"
        );
    }

    /// An editor whose lifecycle a test decides, which is what the supervisor's own can never be.
    struct ScriptedEditor {
        bound: bool,
        refuses: Option<SessionError>,
        stops: Mutex<usize>,
    }

    impl ScriptedEditor {
        fn stopping() -> Self {
            Self {
                bound: false,
                refuses: None,
                stops: Mutex::new(0),
            }
        }

        fn refusing(error: SessionError) -> Self {
            Self {
                bound: false,
                refuses: Some(error),
                stops: Mutex::new(0),
            }
        }

        fn stopped(&self) -> usize {
            *self.stops.lock().expect("the recorder")
        }
    }

    impl EditorLifecycle for ScriptedEditor {
        fn release_binding(&self) -> bool {
            self.bound
        }

        fn stop(&self) -> Result<(), SessionError> {
            *self.stops.lock().expect("the recorder") += 1;
            match &self.refuses {
                Some(error) => Err(error.clone()),
                None => Ok(()),
            }
        }
    }

    /*
     * Both endings do the bookkeeping; only one of them kills anything.
     *
     * An exit used to return early after closing the run row, skipping the event subscription and
     * the session's task. So after a crash the forwarder kept draining a session that was gone, and
     * the next refusal named the task the dead editor had belonged to rather than the one the
     * window is on — "open the task you are already on" is not a way out of anything.
     */
    #[test]
    fn an_editor_that_exited_on_its_own_does_the_same_bookkeeping_as_a_stop() {
        let _test = godot_session::SESSION_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());

        for ending in ["stopped", "exited"] {
            remember_session_task(Ok::<_, ()>(Some("task-1".to_owned())));
            let editor = ScriptedEditor::stopping();
            let directory = TempDir::new().expect("temporary directory");
            let stager = AddonStager::new(directory.path().join(LEDGER_FILE_NAME));
            let end = if ending == "stopped" {
                SessionEnd::Stopped {
                    worktree: None,
                    stager: &stager,
                }
            } else {
                SessionEnd::Exited
            };

            end_session_with(end, &editor).expect("an editor with nothing wrong ends cleanly");

            assert!(
                *SESSION_TASK.lock().expect("the session task") == SessionOwner::NoTask,
                "a session that has ended cannot still own a task ({ending})"
            );
            assert!(
                EVENT_SUBSCRIPTION
                    .lock()
                    .expect("the subscription")
                    .is_none(),
                "a session that has ended cannot still be forwarding events ({ending})"
            );
            // Only a stop has a process to kill. An editor that exited on its own has nothing left.
            assert_eq!(
                editor.stopped(),
                usize::from(ending == "stopped"),
                "{ending}"
            );
        }
    }

    /*
     * A stop that failed still closes the run row.
     *
     * The row is the only record that the session happened at all, and an editor that would not
     * stop is exactly when somebody goes looking for it. Nothing could reach this branch before:
     * the only adapter was the supervisor's static, which cannot be made to refuse.
     */
    #[test]
    fn an_editor_that_will_not_stop_still_closes_its_run() {
        let _test = godot_session::SESSION_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let directory = TempDir::new().expect("temporary directory");
        let worktree = directory.path().join("worktree");
        std::fs::create_dir(&worktree).expect("create worktree");
        let storage = ProjectStorage::open(&directory.path().join("data"), &worktree)
            .expect("open project storage");

        godot_session::clear_logs();
        godot_session::append_log(
            LogSource::EditorError,
            "ERROR: Gofer scripted editor refused to stop\n",
        );
        start_run_logging(&storage, &session_info("session-3", &worktree), &worktree);

        let stager = AddonStager::new(directory.path().join(LEDGER_FILE_NAME));
        let editor = ScriptedEditor::refusing(SessionError::new(
            "godot_kill_failed",
            "Could not stop the Godot session",
        ));
        let refusal = end_session_with(
            SessionEnd::Stopped {
                worktree: None,
                stager: &stager,
            },
            &editor,
        )
        .expect_err("a stop that did not happen is answered");
        assert_eq!(refusal.code, "godot_kill_failed");

        // The run is closed, so nothing can be appended to it any more — the one thing storage
        // refuses for a run that is not running.
        let run = storage
            .runs()
            .search_logs(&SearchGodotLogsRequest {
                query: "Gofer scripted editor refused to stop".to_owned(),
                limit: None,
            })
            .expect("search recorded output");
        assert_eq!(run.len(), 1, "the session's output reached the row");
        assert_eq!(run[0].session_id.as_deref(), Some("session-3"));
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
        stop_run_logging(RunOutcome::Failed);

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

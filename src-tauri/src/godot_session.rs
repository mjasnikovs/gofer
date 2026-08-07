//! Godot session supervisor.
//!
//! Owns one Gofer-managed Godot 4.7.1 editor session bound to the active task's worktree. The
//! supervisor verifies the engine version, binds the loopback RPC listener, allocates LSP/DAP
//! ports, verifies that the machine-wide LSP remote_host setting is loopback, and launches Godot
//! with the editor, path, LSP, and DAP flags. Only one session is allowed at a time.
//!
//! Public items are consumed by Tauri commands in later integration steps; the allow attribute
//! prevents cdylib/staticlib builds from treating them as dead code until those commands land.
#![allow(dead_code)]

use crate::godot_rpc;
use crate::paths;
use crate::process::{ChildProcess, ProcessSpawner};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::VecDeque;
use std::ffi::{OsStr, OsString};
use std::fs;
use std::io::{BufRead, BufReader};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub const REQUIRED_ENGINE_VERSION: &str = "4.7.1";
pub const REQUIRED_CHANNEL: &str = "stable";
const PORT_RETRIES: usize = 3;
/// Godot 4.7 writes a per-minor-version settings file; older 4.x builds wrote the unversioned one.
const EDITOR_SETTINGS_FILE_NAMES: [&str; 2] =
    ["editor_settings-4.7.tres", "editor_settings-4.tres"];
/// The configuration directory Godot uses, whose case differs by platform.
const EDITOR_SETTINGS_DIRECTORIES: [&str; 2] = ["godot", "Godot"];
const LSP_REMOTE_HOST_KEY: &str = "language_server/remote_host";
/// Godot's own default for that setting.
const DEFAULT_LSP_REMOTE_HOST: &str = "127.0.0.1";
/// How many log lines the session keeps. A long import prints thousands, so the buffer is bounded
/// and reports how many lines it dropped rather than growing without limit.
const MAX_LOG_ENTRIES: usize = 4_000;
/// One log line is truncated past this many characters: a single engine error can carry a whole
/// stack trace, and the 1 MiB envelope is shared with every other line in the page.
const MAX_LOG_LINE_CHARS: usize = 4_000;
const DEFAULT_LOG_PAGE: usize = 200;
const MAX_LOG_PAGE: usize = 1_000;

static ACTIVE_SESSION: Mutex<Option<GodotSession>> = Mutex::new(None);
static SESSION_STARTING: AtomicBool = AtomicBool::new(false);
static LOGS: Mutex<LogBuffer> = Mutex::new(LogBuffer::new());

/// The lifecycle states of a Godot editor session.
#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SessionState {
    #[default]
    Offline,
    Staging,
    Starting,
    Importing,
    Ready,
    Playing,
    DebugPaused,
    Stopping,
    Error,
}

/// A structured, actionable session startup failure.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionError {
    pub code: &'static str,
    pub message: String,
    pub retryable: bool,
    pub details: serde_json::Value,
}

impl SessionError {
    pub(crate) fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            retryable: false,
            details: json!({}),
        }
    }

    fn with_details(mut self, details: serde_json::Value) -> Self {
        self.details = details;
        self
    }

    fn retryable(mut self) -> Self {
        self.retryable = true;
        self
    }
}

/// What a caller must supply to start a session.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchRequest {
    pub worktree: PathBuf,
    /// The editor the user pointed Gofer at in settings, when they have. Gofer finds `godot4` or
    /// `godot` on the path without help; an engine installed anywhere else can only be named.
    #[serde(default)]
    pub binary: Option<String>,
}

/// Summary of a running session returned to callers.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    /// Identifies this editor session for as long as it lives. Stored run logging is keyed by it,
    /// so output that reached the buffer can still be found once the editor is gone.
    pub session_id: String,
    pub state: SessionState,
    pub rpc_address: String,
    pub lsp_port: u16,
    pub dap_port: u16,
    pub godot_version: String,
    pub worktree: String,
}

/// How serious one captured log line is. Godot marks its own lines, so the classification is the
/// engine's, not a guess: anything it did not mark stays informational.
#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LogSeverity {
    #[default]
    Info,
    Warning,
    Error,
}

/// One captured line of session output.
///
/// `source` names the stream, not the producer: the editor spawns the game, the importer, and the
/// language/debug servers as part of its own process tree, so their output arrives on the editor's
/// two pipes. Splitting them further would mean parsing engine prose, which changes between builds.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub sequence: u64,
    pub source: LogSource,
    pub severity: LogSeverity,
    pub message: String,
    pub timestamp: u64,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LogSource {
    /// The editor's standard output, which also carries whatever the game it launched printed.
    Editor,
    /// The editor's standard error, where the engine reports its own failures.
    EditorError,
}

/// What a caller asks for when it reads session logs.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogQuery {
    /// The cursor from the previous page. Absent starts at the oldest line still buffered.
    #[serde(default)]
    pub after: Option<u64>,
    /// Drops anything below this severity.
    #[serde(default)]
    pub min_severity: Option<LogSeverity>,
    #[serde(default)]
    pub source: Option<LogSource>,
    /// Case-insensitive substring filter.
    #[serde(default)]
    pub contains: Option<String>,
    #[serde(default)]
    pub limit: Option<usize>,
}

/// One page of session logs plus the cursor that continues it.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogPage {
    pub entries: Vec<LogEntry>,
    /// Pass back as `after` to continue. Unchanged when the page is empty, so a poller cannot skip
    /// a line that arrives between two reads.
    pub cursor: u64,
    /// How many lines the ring buffer discarded since the session started. A cursor older than the
    /// oldest buffered line silently resumes at that line, and this is how the caller notices.
    pub dropped: u64,
}

struct LogBuffer {
    entries: VecDeque<LogEntry>,
    next_sequence: u64,
    dropped: u64,
}

impl LogBuffer {
    const fn new() -> Self {
        Self {
            entries: VecDeque::new(),
            next_sequence: 1,
            dropped: 0,
        }
    }

    fn push(&mut self, source: LogSource, line: &str) {
        let message = truncate_chars(line.trim_end_matches(['\r', '\n']), MAX_LOG_LINE_CHARS);
        let entry = LogEntry {
            sequence: self.next_sequence,
            source,
            severity: classify_log_line(&message),
            message,
            timestamp: now_millis(),
        };
        self.next_sequence += 1;
        self.entries.push_back(entry);
        while self.entries.len() > MAX_LOG_ENTRIES {
            self.entries.pop_front();
            self.dropped += 1;
        }
    }

    fn read(&self, query: &LogQuery) -> LogPage {
        let limit = query.limit.unwrap_or(DEFAULT_LOG_PAGE).min(MAX_LOG_PAGE);
        let needle = query
            .contains
            .as_ref()
            .map(|contains| contains.to_lowercase());
        let mut cursor = query.after.unwrap_or(0);
        let mut entries = Vec::new();
        for entry in &self.entries {
            if entry.sequence <= query.after.unwrap_or(0) {
                continue;
            }
            cursor = cursor.max(entry.sequence);
            if query
                .min_severity
                .is_some_and(|minimum| entry.severity < minimum)
            {
                continue;
            }
            if query.source.is_some_and(|source| entry.source != source) {
                continue;
            }
            if needle
                .as_ref()
                .is_some_and(|needle| !entry.message.to_lowercase().contains(needle))
            {
                continue;
            }
            entries.push(entry.clone());
            if entries.len() >= limit {
                break;
            }
        }
        LogPage {
            entries,
            cursor,
            dropped: self.dropped,
        }
    }
}

pub struct GodotSession {
    session_id: String,
    state: SessionState,
    rpc_address: String,
    lsp_port: u16,
    dap_port: u16,
    godot_version: String,
    worktree: PathBuf,
    token: String,
    child: Arc<Mutex<Box<dyn ChildProcess>>>,
    pub rpc: godot_rpc::RpcSession,
}

struct StartGuard;

impl Drop for StartGuard {
    fn drop(&mut self) {
        SESSION_STARTING.store(false, Ordering::Release);
    }
}

/// Starts a Godot editor session bound to the given worktree.
pub fn start(request: LaunchRequest) -> Result<SessionInfo, SessionError> {
    start_with(request, &crate::process::SystemProcessSpawner)
}

fn start_with(
    request: LaunchRequest,
    spawner: &impl ProcessSpawner,
) -> Result<SessionInfo, SessionError> {
    if SESSION_STARTING
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Err(SessionError::new(
            "session_already_starting",
            "Another Godot session is already starting",
        ));
    }
    let _guard = StartGuard;

    {
        let mut active = ACTIVE_SESSION
            .lock()
            .map_err(|_| SessionError::new("lock_poisoned", "The session lock is poisoned"))?;
        // A session whose editor has already exited is not one to refuse a new start over: the
        // window it belonged to is gone, and starting another is exactly what the user does next.
        // It stays in the slot until then so the state they read says the editor failed rather
        // than that there was never a session at all.
        if active
            .as_mut()
            .is_some_and(|session| session.child.lock().is_ok_and(has_exited))
            && let Some(dead) = active.take()
        {
            dead.rpc.stop();
        }
        if active.is_some() {
            return Err(SessionError::new(
                "session_already_active",
                "A Godot session is already active",
            ));
        }
    }

    let worktree = canonical_worktree(&request.worktree)?;
    // Godot opens any directory as a project, inventing an empty one where there is none, so a
    // workspace that is not a Godot project fails later as a scene that will not load rather than
    // here as the plain fact it is. Naming the directory is the whole point: Gofer takes its
    // workspace from the directory it was started in, which is not always the one the user meant.
    if !worktree.join(crate::addon::PROJECT_FILE).is_file() {
        return Err(SessionError::new(
            "not_a_godot_project",
            crate::addon::missing_project_message(&worktree),
        ));
    }
    let binary = discover_binary(spawner, request.binary.as_deref())?;
    let godot_version = verify_version(spawner, &binary)?;
    let lsp_remote_host = read_lsp_remote_host()?;
    if !is_loopback_host(&lsp_remote_host) {
        return Err(SessionError::new(
            "lsp_host_not_loopback",
            "Godot's editor setting network/language_server/remote_host is not loopback",
        )
        .with_details(json!({ "remoteHost": lsp_remote_host })));
    }

    let rpc_listener = bind_loopback_listener().map_err(|error| {
        SessionError::new(
            "rpc_bind_failed",
            format!("Could not bind RPC listener: {error}"),
        )
        .retryable()
    })?;
    let rpc_address = rpc_listener
        .local_addr()
        .map(|addr| addr.to_string())
        .map_err(|error| {
            SessionError::new(
                "rpc_address_failed",
                format!("Could not read RPC listener address: {error}"),
            )
        })?;
    let rpc_port = rpc_listener
        .local_addr()
        .map_err(|error| {
            SessionError::new(
                "rpc_address_failed",
                format!("Could not read RPC listener address: {error}"),
            )
        })?
        .port();

    let lsp_port = allocate_loopback_port("LSP")?;
    let dap_port = allocate_loopback_port("DAP")?;
    let token = generate_token();

    let mut arguments = vec![
        OsString::from("--editor"),
        OsString::from("--path"),
        worktree.clone().into_os_string(),
        OsString::from("--lsp-port"),
        OsString::from(lsp_port.to_string()),
        OsString::from("--dap-port"),
        OsString::from(dap_port.to_string()),
    ];
    if cfg!(target_os = "macos") {
        arguments.insert(0, OsString::from("--single-window"));
    }
    // The packaged journey and the final acceptance journey both drive a real editor on machines
    // that have no display. The flag exists only in the WebDriver build and under the acceptance
    // gate, so a shipped Gofer can never start an editor the user cannot see, and neither journey
    // needs a second, differently-launched code path.
    #[cfg(any(feature = "webdriver", all(test, feature = "godot-acceptance")))]
    if std::env::var_os("GOFER_GODOT_HEADLESS").is_some() {
        arguments.insert(0, OsString::from("--headless"));
    }

    let mut child = spawner
        .spawn_with_env(
            OsStr::new(&binary),
            &arguments,
            false,
            &[
                (
                    OsString::from("GOFER_RPC_PORT"),
                    OsString::from(rpc_port.to_string()),
                ),
                (
                    OsString::from("GOFER_RPC_TOKEN"),
                    OsString::from(token.clone()),
                ),
            ],
        )
        .map_err(|error| {
            SessionError::new(
                "godot_spawn_failed",
                format!("Could not launch Godot with '{binary}': {error}"),
            )
            .retryable()
        })?;

    // Both streams are pipes: an unread pipe fills and stalls the editor, so each one is drained
    // by a reader thread into the session log buffer. That buffer is the only place editor,
    // importer, plugin, and game output exists — the game the editor launches inherits these very
    // pipes — so the logs domain reads it instead of re-deriving output from somewhere else.
    let stdout = child
        .take_stdout()
        .ok_or_else(|| SessionError::new("godot_stdout_missing", "Could not read Godot output"))?;
    let stderr = child
        .take_stderr()
        .ok_or_else(|| SessionError::new("godot_stderr_missing", "Could not read Godot errors"))?;
    clear_logs();
    spawn_log_reader(stdout, LogSource::Editor);
    spawn_log_reader(stderr, LogSource::EditorError);

    let child = Arc::new(Mutex::new(child));
    let project_path = worktree.display().to_string();
    let rpc = godot_rpc::RpcSession::start(rpc_listener, token.clone(), project_path);
    let session = GodotSession {
        session_id: uuid::Uuid::now_v7().to_string(),
        state: SessionState::Starting,
        rpc_address,
        lsp_port,
        dap_port,
        godot_version: godot_version.clone(),
        worktree,
        token,
        child,
        rpc,
    };

    let info = session_info(&session);
    *ACTIVE_SESSION
        .lock()
        .map_err(|_| SessionError::new("lock_poisoned", "The session lock is poisoned"))? =
        Some(session);
    Ok(info)
}

/// Returns the current session state without taking a reference.
pub fn current_state() -> SessionState {
    ACTIVE_SESSION
        .lock()
        .ok()
        .and_then(|session| session.as_ref().map(|session| session.state))
        .unwrap_or(SessionState::Offline)
}

/// Whether the editor process has exited on its own, and marks the session as failed if it has.
///
/// Nothing else notices. The transport does — [`godot_rpc::RpcSession::readiness`] answers
/// `Unavailable` once the connection closes, so calls fail with a real error — but the stored state
/// is whatever it last was, and a badge that reads "ready" over an editor that crashed or that the
/// user closed is a lie the panels repeat until something is clicked. The child process is the only
/// thing that knows, so it is what is asked.
///
/// A session already in [`SessionState::Error`] answers `false`: the transition happens once, so a
/// caller polling this does not close the same run row over and over.
/// Whether a child process has ended, asked of the lock guard both callers already hold.
fn has_exited(mut child: std::sync::MutexGuard<'_, Box<dyn ChildProcess>>) -> bool {
    matches!(child.try_wait(), Ok(Some(_)))
}

/// Whether the active session's editor process is gone.
///
/// Unlike [`poll_editor_exit`] this answers the same way however many times it is asked, and
/// whatever state the session is in: it is the question "is there still an editor there", which a
/// caller about to refuse a new start over the old one has to ask.
pub fn editor_has_exited() -> bool {
    ACTIVE_SESSION
        .lock()
        .ok()
        .and_then(|active| {
            active
                .as_ref()
                .map(|session| session.child.lock().is_ok_and(has_exited))
        })
        .unwrap_or(false)
}

pub fn poll_editor_exit() -> bool {
    let Ok(mut active) = ACTIVE_SESSION.lock() else {
        return false;
    };
    let Some(session) = active.as_mut() else {
        return false;
    };
    if session.state == SessionState::Error || session.state == SessionState::Stopping {
        return false;
    }
    let exited = session.child.lock().is_ok_and(has_exited);
    if exited {
        session.state = SessionState::Error;
    }
    exited
}

/// Returns a clone of the current session summary, if any.
pub fn current_info() -> Option<SessionInfo> {
    #[cfg(test)]
    if let Some(info) = TEST_SESSION_INFO.lock().ok().and_then(|slot| slot.clone()) {
        return Some(info);
    }
    ACTIVE_SESSION
        .lock()
        .ok()
        .and_then(|session| session.as_ref().map(session_info))
}

/// The session summary a unit test planted, standing in for a running editor.
///
/// Only a real `start` writes [`ACTIVE_SESSION`], and it wants a child process and a listening
/// socket. Every guard that asks nothing more than "is there a session" — `require_session_task`
/// above all — was therefore reachable in the live sweep and nowhere else. This is what makes it
/// reachable in a test, and it mirrors [`bind_test_rpc`]: a slot [`current_info`] reads first,
/// absent from every non-test build.
#[cfg(test)]
static TEST_SESSION_INFO: Mutex<Option<SessionInfo>> = Mutex::new(None);

#[cfg(test)]
pub(crate) fn bind_test_session_info(info: Option<SessionInfo>) {
    if let Ok(mut slot) = TEST_SESSION_INFO.lock() {
        *slot = info;
    }
}

/// Updates the lifecycle state of the active session.
pub fn set_state(state: SessionState) {
    if let Ok(mut session) = ACTIVE_SESSION.lock()
        && let Some(session) = session.as_mut()
    {
        session.state = state;
    }
}

/// The RPC session an acceptance test started itself, mirroring `script::bind_test_session` and
/// `debug::bind_test_session`: the supervisor launches a windowed editor, which a headless gate
/// cannot run, so the acceptance suite launches the pinned editor and binds its transport here.
/// Absent from every non-test build.
#[cfg(all(test, feature = "godot-acceptance"))]
static TEST_RPC: Mutex<Option<godot_rpc::RpcSession>> = Mutex::new(None);

#[cfg(all(test, feature = "godot-acceptance"))]
pub fn bind_test_rpc(rpc: Option<godot_rpc::RpcSession>) {
    if let Ok(mut slot) = TEST_RPC.lock() {
        *slot = rpc;
    }
}

/// Returns a clone of the active RPC session, if any.
pub fn rpc_session() -> Option<godot_rpc::RpcSession> {
    #[cfg(all(test, feature = "godot-acceptance"))]
    if let Some(rpc) = TEST_RPC.lock().ok().and_then(|slot| slot.clone()) {
        return Some(rpc);
    }
    ACTIVE_SESSION
        .lock()
        .ok()
        .and_then(|session| session.as_ref().map(|session| session.rpc.clone()))
}

/// Reads one page of captured session output.
///
/// The buffer outlives the process that filled it: a crashed editor leaves the lines that explain
/// the crash, which is exactly when they are worth reading.
pub fn read_logs(query: &LogQuery) -> Result<LogPage, SessionError> {
    LOGS.lock()
        .map(|logs| logs.read(query))
        .map_err(|_| SessionError::new("lock_poisoned", "The session log lock is poisoned"))
}

/// Appends one line to the session log buffer. The reader threads own this; the acceptance suite
/// launches its own editor and feeds the same buffer, and unit tests seed it without a process.
pub(crate) fn append_log(source: LogSource, line: &str) {
    if let Ok(mut logs) = LOGS.lock() {
        logs.push(source, line);
    }
}

/// Empties the buffer for a new session, so a page never mixes two editors' output.
pub(crate) fn clear_logs() {
    if let Ok(mut logs) = LOGS.lock() {
        *logs = LogBuffer::new();
    }
}

fn spawn_log_reader(stream: crate::process::ProcessReader, source: LogSource) {
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stream);
        let mut line = String::new();
        // A non-UTF-8 byte in engine output must not stop the drain: the pipe would fill and stall
        // the editor. `read_line` fails the whole read, so the buffer is cleared and reading
        // continues with the next line.
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) => break,
                Ok(_) => append_log(source, &line),
                Err(_) => continue,
            }
        }
    });
}

/// Classifies a captured line the way the engine marked it. Godot prefixes its own diagnostics
/// with `ERROR:`, `SCRIPT ERROR:`, `USER ERROR:`, `WARNING:`, or `USER WARNING:`; a `print()` from
/// the game carries no marker and stays informational.
fn classify_log_line(line: &str) -> LogSeverity {
    let text = line.trim_start();
    if text.starts_with("ERROR:")
        || text.starts_with("SCRIPT ERROR:")
        || text.starts_with("USER ERROR:")
        || text.starts_with("USER SCRIPT ERROR:")
    {
        return LogSeverity::Error;
    }
    if text.starts_with("WARNING:") || text.starts_with("USER WARNING:") {
        return LogSeverity::Warning;
    }
    LogSeverity::Info
}

fn truncate_chars(text: &str, maximum: usize) -> String {
    if text.chars().count() <= maximum {
        return text.to_owned();
    }
    text.chars().take(maximum).collect()
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or_default()
}

/// Serializes every test that touches the process-wide session state or log buffer, including the
/// ones in [`crate::godot_session_api`] that drain that buffer into storage.
#[cfg(test)]
pub(crate) static SESSION_TEST_LOCK: Mutex<()> = Mutex::new(());

/// Stops the active session by killing the Godot child process.
pub fn stop() -> Result<(), SessionError> {
    let active = ACTIVE_SESSION
        .lock()
        .map_err(|_| SessionError::new("lock_poisoned", "The session lock is poisoned"))?
        .take()
        .ok_or_else(|| SessionError::new("session_not_active", "No Godot session is active"))?;
    active.rpc.stop();
    let mut child = active
        .child
        .lock()
        .map_err(|_| SessionError::new("lock_poisoned", "The child process lock is poisoned"))?;
    match child.kill() {
        Ok(()) => Ok(()),
        // An editor that already exited cannot be killed, and on Linux saying so is an error: once
        // `poll_editor_exit` has reaped a crashed or closed editor, `kill` answers "can't kill an
        // exited process". Stopping a session whose editor is already gone is exactly what a user
        // does next, and it has to clean up rather than refuse.
        Err(error) => match child.try_wait() {
            Ok(Some(_)) => Ok(()),
            _ => Err(SessionError::new(
                "godot_kill_failed",
                format!("Could not stop the Godot session: {error}"),
            )),
        },
    }
}

// coverage-critical-start: version
fn verify_version(spawner: &impl ProcessSpawner, binary: &str) -> Result<String, SessionError> {
    let output = command_text(spawner, binary, &["--version"]).map_err(|error| {
        SessionError::new(
            "godot_version_check_failed",
            format!("Could not determine the Godot version: {error}"),
        )
    })?;
    if !is_supported_version(&output) {
        return Err(SessionError::new(
            "unsupported_godot_version",
            format!(
                "Godot version '{output}' is not supported. Gofer requires Godot {REQUIRED_ENGINE_VERSION}.{REQUIRED_CHANNEL}."
            ),
        )
        .with_details(json!({"detected": output, "required": format!("{REQUIRED_ENGINE_VERSION}.{REQUIRED_CHANNEL}")})));
    }
    Ok(output)
}

/// Accepts exactly one engine: 4.7.1-stable.
///
/// `--version` answers `4.7.1.stable` for a build made from source and
/// `4.7.1.stable.official.<hash>` for a release, so the required version and channel are matched as
/// a prefix and the build metadata behind them is ignored. Requiring the whole string to equal
/// `4.7.1.stable` would reject every published release — which is every editor a user actually has.
fn is_supported_version(version: &str) -> bool {
    let version = version.trim();
    let required = format!("{REQUIRED_ENGINE_VERSION}.{REQUIRED_CHANNEL}");
    version == required || version.starts_with(&format!("{required}."))
}
// coverage-critical-end: version

fn discover_binary(
    spawner: &impl ProcessSpawner,
    configured: Option<&str>,
) -> Result<String, SessionError> {
    if let Ok(binary) = std::env::var("GOFER_GODOT_BINARY") {
        if command_text(spawner, &binary, &["--version"]).is_ok() {
            return Ok(binary);
        }
        return Err(SessionError::new(
            "configured_binary_unusable",
            format!("GOFER_GODOT_BINARY points to an unusable executable: {binary}"),
        ));
    }
    if let Some(binary) = configured
        .map(str::trim)
        .filter(|binary| !binary.is_empty())
    {
        if command_text(spawner, binary, &["--version"]).is_ok() {
            return Ok(binary.to_owned());
        }
        return Err(SessionError::new(
            "configured_binary_unusable",
            format!(
                "The Godot editor recorded in Gofer's settings could not be run: {binary}. Choose \
                 it again in the health check."
            ),
        ));
    }
    for binary in ["godot4", "godot"] {
        if command_text(spawner, binary, &["--version"]).is_ok() {
            return Ok(binary.to_owned());
        }
    }
    Err(SessionError::new(
        "godot_not_found",
        format!(
            "Godot was not found on the path. Install Godot \
             {REQUIRED_ENGINE_VERSION}-{REQUIRED_CHANNEL}, or point Gofer at the editor you \
             already have."
        ),
    ))
}

/// What the health check knows about the editor Gofer would launch.
#[derive(Clone, Debug, PartialEq)]
pub struct BinaryProbe {
    pub binary: Option<String>,
    pub version: Option<String>,
    pub error: Option<String>,
}

/// Resolves and version-checks the editor without starting anything.
///
/// The health check answers before the user has a task, and starting a session to find out whether
/// Godot is installed would be a strange way to ask.
pub fn probe_binary(configured: Option<&str>) -> BinaryProbe {
    probe_binary_with(&crate::process::SystemProcessSpawner, configured)
}

fn probe_binary_with(spawner: &impl ProcessSpawner, configured: Option<&str>) -> BinaryProbe {
    let binary = match discover_binary(spawner, configured) {
        Ok(binary) => binary,
        Err(error) => {
            return BinaryProbe {
                binary: None,
                version: None,
                error: Some(error.message),
            };
        }
    };
    match verify_version(spawner, &binary) {
        Ok(version) => BinaryProbe {
            binary: Some(binary),
            version: Some(version),
            error: None,
        },
        Err(error) => BinaryProbe {
            binary: Some(binary),
            version: error
                .details
                .get("detected")
                .and_then(|value| value.as_str())
                .map(str::to_owned),
            error: Some(error.message),
        },
    }
}

/// The editor setting Gofer needs pointed at loopback, and where the user changes it.
pub fn probe_lsp_remote_host() -> Result<String, String> {
    read_lsp_remote_host().map_err(|error| error.message)
}

pub fn is_loopback(host: &str) -> bool {
    is_loopback_host(host)
}

fn command_text(
    spawner: &impl ProcessSpawner,
    binary: &str,
    arguments: &[&str],
) -> Result<String, String> {
    let arguments = arguments.iter().map(OsString::from).collect::<Vec<_>>();
    let output = spawner
        .output(OsStr::new(binary), &arguments)
        .map_err(|error| error.to_string())?;
    if !output.status.success {
        return Err(format!(
            "{binary} exited with {}",
            output.status.description
        ));
    }
    String::from_utf8(output.stdout)
        .map(|value| value.trim().to_owned())
        .map_err(|error| error.to_string())
}

fn canonical_worktree(worktree: &Path) -> Result<PathBuf, SessionError> {
    paths::canonical(worktree)
        .map_err(|error| {
            SessionError::new(
                "worktree_unavailable",
                format!("The worktree could not be resolved: {error}"),
            )
        })
        .and_then(|path| {
            if path.is_dir() {
                Ok(path)
            } else {
                Err(SessionError::new(
                    "worktree_not_directory",
                    format!("{} is not a directory", path.display()),
                ))
            }
        })
}

// coverage-critical-start: network
fn bind_loopback_listener() -> std::io::Result<TcpListener> {
    TcpListener::bind("127.0.0.1:0")
}

fn allocate_loopback_port(purpose: &str) -> Result<u16, SessionError> {
    for attempt in 1..=PORT_RETRIES {
        match bind_loopback_listener() {
            Ok(listener) => {
                let port = listener.local_addr().map_err(|error| {
                    SessionError::new(
                        "port_read_failed",
                        format!("Could not read {purpose} port: {error}"),
                    )
                })?;
                drop(listener);
                return Ok(port.port());
            }
            Err(error) if attempt < PORT_RETRIES => {
                std::thread::sleep(Duration::from_millis(10));
                let _ = error;
            }
            Err(error) => {
                return Err(SessionError::new(
                    "port_bind_failed",
                    format!(
                        "Could not allocate a {purpose} port after {PORT_RETRIES} attempts: {error}"
                    ),
                )
                .retryable());
            }
        }
    }
    unreachable!("the loop always returns inside the for block")
}

fn is_loopback_host(host: &str) -> bool {
    host == "127.0.0.1" || host == "::1" || host == "localhost"
}
// coverage-critical-end: network

fn generate_token() -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
        .hash(&mut hasher);
    std::process::id().hash(&mut hasher);
    format!("{:064x}", hasher.finish())
}

fn session_info(session: &GodotSession) -> SessionInfo {
    SessionInfo {
        session_id: session.session_id.clone(),
        state: session.state,
        rpc_address: session.rpc_address.clone(),
        lsp_port: session.lsp_port,
        dap_port: session.dap_port,
        godot_version: session.godot_version.clone(),
        worktree: session.worktree.display().to_string(),
    }
}

/// Finds the machine-wide editor settings file, if the user has one.
///
/// Godot writes one file per minor version (`editor_settings-4.7.tres`) and used an unversioned
/// name before that, under a configuration directory whose case differs by platform — `godot` on
/// Linux, `Godot` on Windows and macOS. Every candidate is tried rather than one assumed, and an
/// editor that has never been opened simply has no file: that is `Ok(None)`, not a failure, because
/// the setting Gofer reads then holds its engine default.
fn editor_settings_path() -> Result<Option<PathBuf>, SessionError> {
    if let Ok(path) = std::env::var("GOFER_GODOT_EDITOR_SETTINGS") {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Ok(Some(path));
        }
        // An explicit override that names nothing is a mistake worth reporting, unlike a machine
        // that simply has no settings file yet.
        return Err(SessionError::new(
            "editor_settings_missing",
            format!(
                "GOFER_GODOT_EDITOR_SETTINGS points to a missing file: {}",
                path.display()
            ),
        ));
    }

    let mut roots = Vec::new();
    if let Some(config_root) = dirs::config_dir() {
        for directory in EDITOR_SETTINGS_DIRECTORIES {
            roots.push(config_root.join(directory));
        }
    }
    #[cfg(target_os = "macos")]
    if let Some(home) = dirs::home_dir() {
        roots.push(home.join("Library/Application Support/Godot"));
    }

    for root in roots {
        for name in EDITOR_SETTINGS_FILE_NAMES {
            let path = root.join(name);
            if path.is_file() {
                return Ok(Some(path));
            }
        }
    }

    Ok(None)
}

/// Reads the machine-wide LSP remote host the editor will bind.
///
/// `--lsp-port` overrides the port alone, so this is the setting that decides whether the language
/// server listens on loopback. Godot's own default is `127.0.0.1`, which is what an editor with no
/// settings file yet — and one whose settings never mention the key — will use.
fn read_lsp_remote_host() -> Result<String, SessionError> {
    let Some(path) = editor_settings_path()? else {
        return Ok(DEFAULT_LSP_REMOTE_HOST.to_owned());
    };
    let text = fs::read_to_string(&path).map_err(|error| {
        SessionError::new(
            "editor_settings_unreadable",
            format!("Could not read Godot editor settings: {error}"),
        )
        .retryable()
    })?;
    Ok(parse_lsp_remote_host(&text).unwrap_or_else(|| DEFAULT_LSP_REMOTE_HOST.to_owned()))
}

fn parse_lsp_remote_host(text: &str) -> Option<String> {
    for line in text.lines() {
        let line = line.trim();
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        // A real settings file writes the fully qualified `network/language_server/remote_host`
        // with spaces around the separator; the suffix match accepts both that and the bare key,
        // and `network/debug/remote_host` cannot collide with it.
        if !key.trim().ends_with(LSP_REMOTE_HOST_KEY) {
            continue;
        }
        let value = value.trim();
        let value = value.strip_prefix('"').unwrap_or(value);
        let value = value.strip_suffix('"').unwrap_or(value);
        return Some(value.to_owned());
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::process::{
        ChildProcess, ProcessOutput, ProcessReader, ProcessStatus, ProcessWriter,
    };
    use std::ffi::{OsStr, OsString};
    use std::io::{self, Cursor};
    use std::sync::atomic::{AtomicBool, Ordering};
    use tempfile::TempDir;

    struct FakeSpawner {
        version_output: String,
        child: Mutex<Option<FakeChild>>,
        /// Flipped by a test that wants the editor to die the way a crash or a closed window does.
        exited: Arc<AtomicBool>,
        arguments: Arc<Mutex<Vec<OsString>>>,
        env_vars: Arc<Mutex<Vec<(OsString, OsString)>>>,
        fail_spawn: bool,
    }

    impl FakeSpawner {
        fn new(version: &str) -> Self {
            let exited = Arc::new(AtomicBool::new(false));
            Self {
                version_output: version.to_owned(),
                child: Mutex::new(Some(FakeChild {
                    stdout: Some(Box::new(Cursor::new(Vec::new()))),
                    stderr: Some(Box::new(Cursor::new(Vec::new()))),
                    status: ProcessStatus {
                        success: true,
                        code: Some(0),
                        description: "exit status: 0".to_owned(),
                    },
                    killed: Arc::new(AtomicBool::new(false)),
                    exited: Arc::clone(&exited),
                })),
                exited,
                arguments: Arc::new(Mutex::new(Vec::new())),
                env_vars: Arc::new(Mutex::new(Vec::new())),
                fail_spawn: false,
            }
        }
    }

    impl ProcessSpawner for FakeSpawner {
        fn output(&self, _: &OsStr, _: &[OsString]) -> io::Result<ProcessOutput> {
            Ok(ProcessOutput {
                status: ProcessStatus {
                    success: true,
                    code: Some(0),
                    description: "exit status: 0".to_owned(),
                },
                stdout: self.version_output.clone().into_bytes(),
            })
        }

        fn spawn(
            &self,
            program: &OsStr,
            arguments: &[OsString],
            piped_stdin: bool,
        ) -> io::Result<Box<dyn ChildProcess>> {
            self.spawn_with_env(program, arguments, piped_stdin, &[])
        }

        fn spawn_with_env(
            &self,
            _: &OsStr,
            arguments: &[OsString],
            piped_stdin: bool,
            env: &[(OsString, OsString)],
        ) -> io::Result<Box<dyn ChildProcess>> {
            assert!(!piped_stdin);
            *self.arguments.lock().expect("fake arguments") = arguments.to_vec();
            *self.env_vars.lock().expect("fake env") = env.to_vec();
            if self.fail_spawn {
                return Err(io::Error::other("spawn failed"));
            }
            self.child
                .lock()
                .expect("fake child")
                .take()
                .map(|child| Box::new(child) as Box<dyn ChildProcess>)
                .ok_or_else(|| io::Error::other("fake Godot already spawned"))
        }
    }

    struct FakeChild {
        stdout: Option<ProcessReader>,
        stderr: Option<ProcessReader>,
        status: ProcessStatus,
        killed: Arc<AtomicBool>,
        /// Whether the process has ended, which is what `try_wait` is asked. A real editor answers
        /// `None` while it is up, so a fake that always answers `Some` would make every session
        /// look dead the moment anything looked.
        exited: Arc<AtomicBool>,
    }

    impl ChildProcess for FakeChild {
        fn take_stdin(&mut self) -> Option<ProcessWriter> {
            None
        }

        fn take_stdout(&mut self) -> Option<ProcessReader> {
            self.stdout.take()
        }

        fn take_stderr(&mut self) -> Option<ProcessReader> {
            self.stderr.take()
        }

        fn try_wait(&mut self) -> io::Result<Option<ProcessStatus>> {
            Ok(self
                .exited
                .load(Ordering::Acquire)
                .then(|| self.status.clone()))
        }

        fn wait(&mut self) -> io::Result<ProcessStatus> {
            Ok(self.status.clone())
        }

        fn kill(&mut self) -> io::Result<()> {
            self.killed.store(true, Ordering::Release);
            self.exited.store(true, Ordering::Release);
            Ok(())
        }
    }

    /// A worktree a session will open: a directory that is a Godot project, because a session
    /// refuses one that is not.
    fn workspace() -> (TempDir, PathBuf) {
        let directory = TempDir::new().expect("temporary worktree");
        fs::write(
            directory.path().join("project.godot"),
            "config_version=5\n\n[application]\n\nconfig/name=\"Session fixture\"\n",
        )
        .expect("project file");
        let path = paths::canonical(directory.path()).expect("canonicalize");
        (directory, path)
    }

    fn settings_file_with(host: &str) -> (TempDir, PathBuf) {
        let directory = TempDir::new().expect("temporary settings dir");
        let path = directory.path().join(EDITOR_SETTINGS_FILE_NAMES[0]);
        // Written the way a real editor writes it: fully qualified key, spaces around the equals.
        fs::write(
            &path,
            format!("[network]\n\nnetwork/{LSP_REMOTE_HOST_KEY} = \"{host}\"\n"),
        )
        .expect("write editor settings");
        (directory, path)
    }

    #[test]
    fn supported_version_matches_exact_release() {
        assert!(is_supported_version("4.7.1.stable"));
        // What a published release actually reports; rejecting it would reject every real editor.
        assert!(is_supported_version("4.7.1.stable.official"));
        assert!(is_supported_version("4.7.1.stable.official.a13da4feb"));
        assert!(!is_supported_version("4.7.1.dev"));
        assert!(!is_supported_version("4.7.0.stable"));
        assert!(!is_supported_version("4.7.1.stablish.official"));
        assert!(!is_supported_version("4.7.10.stable"));
        assert!(!is_supported_version("4.7.1"));
        assert!(!is_supported_version(""));
    }

    #[test]
    fn loopback_hosts_are_recognized() {
        assert!(is_loopback_host("127.0.0.1"));
        assert!(is_loopback_host("::1"));
        assert!(is_loopback_host("localhost"));
        assert!(!is_loopback_host("0.0.0.0"));
        assert!(!is_loopback_host("192.168.1.1"));
    }

    #[test]
    fn lsp_remote_host_is_parsed_from_tres() {
        assert_eq!(
            parse_lsp_remote_host("[network]\n\nlanguage_server/remote_host=\"127.0.0.1\"\n"),
            Some("127.0.0.1".to_owned())
        );
        assert_eq!(
            parse_lsp_remote_host("language_server/remote_host=\"::1\""),
            Some("::1".to_owned())
        );
        // What Godot 4.7 actually writes: fully qualified, spaced, and next to a sibling key that
        // must not be mistaken for it.
        assert_eq!(
            parse_lsp_remote_host(
                "[network]\n\nnetwork/debug/remote_host = \"10.0.0.5\"\nnetwork/language_server/remote_host = \"127.0.0.1\"\n"
            ),
            Some("127.0.0.1".to_owned())
        );
        assert_eq!(
            parse_lsp_remote_host("[network]\n\nother_setting=\"x\"\n"),
            None
        );
    }

    /// An editor that has never been opened has no settings file, and Gofer must start against it:
    /// the setting it reads then holds the engine's own loopback default. An override that names
    /// nothing is the one case worth refusing, because someone asked for a specific file.
    #[test]
    fn missing_editor_settings_fall_back_to_the_engine_default_host() {
        let _test = SESSION_TEST_LOCK.lock().expect("session test lock");
        let (directory, path) = settings_file_with("::1");
        // SAFETY: the session test lock serializes the process-wide override.
        unsafe { std::env::set_var("GOFER_GODOT_EDITOR_SETTINGS", &path) };
        assert_eq!(read_lsp_remote_host().expect("configured host"), "::1");

        let missing = directory.path().join("absent.tres");
        // SAFETY: still holding the test lock.
        unsafe { std::env::set_var("GOFER_GODOT_EDITOR_SETTINGS", &missing) };
        assert_eq!(
            read_lsp_remote_host()
                .expect_err("a named file must exist")
                .code,
            "editor_settings_missing"
        );

        // SAFETY: restore the process environment while still holding the test lock.
        unsafe { std::env::remove_var("GOFER_GODOT_EDITOR_SETTINGS") };
        // Whatever this machine has — a real settings file or none at all — the answer is a host,
        // never a failure.
        assert!(!read_lsp_remote_host().expect("discovered host").is_empty());
    }

    #[test]
    fn a_workspace_without_a_project_file_is_refused_by_name() {
        let _test = SESSION_TEST_LOCK.lock().expect("session test lock");
        let directory = TempDir::new().expect("temporary worktree");
        let worktree = paths::canonical(directory.path()).expect("canonicalize");
        let spawner = FakeSpawner::new("4.7.1.stable");

        let error = start_with(
            LaunchRequest {
                worktree: worktree.clone(),
                binary: None,
            },
            &spawner,
        )
        .expect_err("a directory that is not a Godot project cannot host a session");

        assert_eq!(error.code, "not_a_godot_project");
        // The directory is what the user has to change, so the message has to name it.
        assert!(error.message.contains(&worktree.display().to_string()));
        assert!(
            spawner.arguments.lock().expect("arguments").is_empty(),
            "no editor is launched for a directory that is not a project"
        );
    }

    #[test]
    fn session_start_passes_version_and_port_checks() {
        let _test = SESSION_TEST_LOCK.lock().expect("session test lock");
        let (_directory, worktree) = workspace();
        let worktree_path = worktree.display().to_string();
        let (_settings_dir, settings_path) = settings_file_with("127.0.0.1");
        unsafe {
            std::env::set_var(
                "GOFER_GODOT_EDITOR_SETTINGS",
                settings_path.display().to_string(),
            )
        };
        let spawner = FakeSpawner::new("4.7.1.stable");

        let info = start_with(
            LaunchRequest {
                worktree,
                binary: None,
            },
            &spawner,
        )
        .expect("start session");

        assert_eq!(info.state, SessionState::Starting);
        assert_eq!(info.godot_version, "4.7.1.stable");
        let arguments = spawner.arguments.lock().expect("arguments");
        assert!(arguments.contains(&OsString::from("--editor")));
        assert!(arguments.contains(&OsString::from("--lsp-port")));
        assert!(arguments.contains(&OsString::from("--dap-port")));
        let path_index = arguments
            .iter()
            .position(|arg| arg == "--path")
            .expect("--path argument");
        assert_eq!(arguments[path_index + 1].to_string_lossy(), worktree_path);

        stop().expect("stop session");
        unsafe { std::env::remove_var("GOFER_GODOT_EDITOR_SETTINGS") };
    }

    /// An editor that exits on its own stops being reported as a live session.
    ///
    /// Reproduced by accident during a live sweep: the user closed the Godot window, and Gofer went
    /// on presenting the session it last had — a ready badge over a process that was gone, with
    /// every call behind it failing. Nothing polled the child, so nothing ever found out.
    #[test]
    fn an_editor_that_exits_on_its_own_is_reported_as_failed() {
        let _test = SESSION_TEST_LOCK.lock().expect("session test lock");
        let (_directory, worktree) = workspace();
        let spawner = FakeSpawner::new("4.7.1.stable");

        start_with(
            LaunchRequest {
                worktree,
                binary: None,
            },
            &spawner,
        )
        .expect("start session");
        // A session whose editor is up says nothing, however often it is asked.
        assert!(!poll_editor_exit());
        assert_eq!(current_state(), SessionState::Starting);

        spawner.exited.store(true, Ordering::Release);
        assert!(poll_editor_exit(), "the exit must be noticed");
        assert_eq!(current_state(), SessionState::Error);
        // Once only: the caller polling this closes a run row on the transition, and closing it
        // again on every later poll would rewrite history that has already been written.
        assert!(!poll_editor_exit());
        assert_eq!(current_state(), SessionState::Error);

        // Stopping a session whose editor already exited is what a user does next, and killing a
        // process that has ended is an error on Linux — so the stop has to see that for what it is.
        stop().expect("stopping a dead session must clean up rather than refuse");
    }

    /// A dead session does not stand in the way of the next one.
    ///
    /// The slot keeps the failed session so the window can say the editor died rather than that
    /// there was never one. That is only right up to the moment the user starts another, which
    /// `session_already_active` would otherwise refuse for as long as the app is open.
    #[test]
    fn a_session_whose_editor_died_is_replaced_by_the_next_start() {
        let _test = SESSION_TEST_LOCK.lock().expect("session test lock");
        let (_directory, worktree) = workspace();
        let first = FakeSpawner::new("4.7.1.stable");
        start_with(
            LaunchRequest {
                worktree: worktree.clone(),
                binary: None,
            },
            &first,
        )
        .expect("start the first session");

        // A live session is still refused, which is the guard this must not remove.
        let second = FakeSpawner::new("4.7.1.stable");
        let refused = start_with(
            LaunchRequest {
                worktree: worktree.clone(),
                binary: None,
            },
            &second,
        )
        .expect_err("a running session must not be replaced");
        assert_eq!(refused.code, "session_already_active");

        assert!(
            !editor_has_exited(),
            "a live editor must not be reported as gone"
        );

        first.exited.store(true, Ordering::Release);
        // The desktop layer asks this before it refuses a start over the session already in the
        // slot, and it has to keep answering the same way however often it is asked.
        assert!(
            editor_has_exited(),
            "a dead editor must be reported as gone"
        );
        assert!(poll_editor_exit(), "the first poll finds the exit");
        assert!(
            editor_has_exited(),
            "and the answer does not change after it"
        );

        let replacement = FakeSpawner::new("4.7.1.stable");
        start_with(
            LaunchRequest {
                worktree,
                binary: None,
            },
            &replacement,
        )
        .expect("a dead session must give way to a new one");
        assert_eq!(current_state(), SessionState::Starting);

        stop().expect("stop session");
    }

    #[test]
    fn unsupported_version_is_rejected() {
        let _test = SESSION_TEST_LOCK.lock().expect("session test lock");
        let (_directory, worktree) = workspace();
        let (_settings_dir, settings_path) = settings_file_with("127.0.0.1");
        unsafe {
            std::env::set_var(
                "GOFER_GODOT_EDITOR_SETTINGS",
                settings_path.display().to_string(),
            )
        };
        let spawner = FakeSpawner::new("4.7.0.stable");

        let error = start_with(
            LaunchRequest {
                worktree,
                binary: None,
            },
            &spawner,
        )
        .expect_err("bad version");
        assert_eq!(error.code, "unsupported_godot_version");

        unsafe { std::env::remove_var("GOFER_GODOT_EDITOR_SETTINGS") };
    }

    #[test]
    fn non_loopback_lsp_host_is_rejected() {
        let _test = SESSION_TEST_LOCK.lock().expect("session test lock");
        let (_directory, worktree) = workspace();
        let (_settings_dir, settings_path) = settings_file_with("0.0.0.0");
        unsafe {
            std::env::set_var(
                "GOFER_GODOT_EDITOR_SETTINGS",
                settings_path.display().to_string(),
            )
        };
        let spawner = FakeSpawner::new("4.7.1.stable");

        let error = start_with(
            LaunchRequest {
                worktree,
                binary: None,
            },
            &spawner,
        )
        .expect_err("non-loopback");
        assert_eq!(error.code, "lsp_host_not_loopback");

        unsafe { std::env::remove_var("GOFER_GODOT_EDITOR_SETTINGS") };
    }

    #[test]
    fn concurrent_start_and_stop_are_guarded() {
        let _test = SESSION_TEST_LOCK.lock().expect("session test lock");
        let (_directory, worktree) = workspace();
        let (_settings_dir, settings_path) = settings_file_with("127.0.0.1");
        unsafe {
            std::env::set_var(
                "GOFER_GODOT_EDITOR_SETTINGS",
                settings_path.display().to_string(),
            )
        };
        let spawner = FakeSpawner::new("4.7.1.stable");

        start_with(
            LaunchRequest {
                worktree,
                binary: None,
            },
            &spawner,
        )
        .expect("start first session");
        assert_eq!(current_state(), SessionState::Starting);

        assert_eq!(
            start_with(
                LaunchRequest {
                    worktree: PathBuf::from("/tmp"),
                    binary: None,
                },
                &spawner
            )
            .expect_err("second start")
            .code,
            "session_already_active"
        );

        stop().expect("stop");
        assert_eq!(current_state(), SessionState::Offline);
        assert_eq!(stop().expect_err("no session").code, "session_not_active");

        unsafe { std::env::remove_var("GOFER_GODOT_EDITOR_SETTINGS") };
    }

    #[test]
    fn captured_output_is_classified_paged_and_bounded() {
        let _test = SESSION_TEST_LOCK.lock().expect("session test lock");
        clear_logs();
        append_log(LogSource::Editor, "Godot Engine v4.7.1.stable\n");
        append_log(LogSource::Editor, "presses: 1 (key)\n");
        append_log(
            LogSource::EditorError,
            "ERROR: Condition \"p_index\" is true.\n",
        );
        append_log(LogSource::EditorError, "WARNING: The scene has no root.\n");
        append_log(
            LogSource::Editor,
            "SCRIPT ERROR: Invalid call on null instance\n",
        );

        let all = read_logs(&LogQuery::default()).expect("read logs");
        assert_eq!(all.entries.len(), 5);
        assert_eq!(all.dropped, 0);
        // The newline is not part of the message, and the engine's own markers set the severity.
        assert_eq!(all.entries[0].message, "Godot Engine v4.7.1.stable");
        assert_eq!(all.entries[0].severity, LogSeverity::Info);
        assert_eq!(all.entries[2].severity, LogSeverity::Error);
        assert_eq!(all.entries[3].severity, LogSeverity::Warning);
        assert_eq!(all.entries[4].severity, LogSeverity::Error);
        assert_eq!(all.cursor, 5);

        let errors = read_logs(&LogQuery {
            min_severity: Some(LogSeverity::Warning),
            ..LogQuery::default()
        })
        .expect("filtered logs");
        assert_eq!(errors.entries.len(), 3);

        let game = read_logs(&LogQuery {
            source: Some(LogSource::Editor),
            contains: Some("PRESSES".to_owned()),
            ..LogQuery::default()
        })
        .expect("game logs");
        assert_eq!(game.entries.len(), 1);
        assert_eq!(game.entries[0].message, "presses: 1 (key)");

        // A cursor resumes exactly after the line it names, and an empty page keeps it put.
        let page = read_logs(&LogQuery {
            after: Some(2),
            limit: Some(1),
            ..LogQuery::default()
        })
        .expect("second page");
        assert_eq!(page.entries.len(), 1);
        assert_eq!(page.entries[0].sequence, 3);
        assert_eq!(page.cursor, 3);
        let tail = read_logs(&LogQuery {
            after: Some(5),
            ..LogQuery::default()
        })
        .expect("tail page");
        assert!(tail.entries.is_empty());
        assert_eq!(tail.cursor, 5);
        clear_logs();
    }

    #[test]
    fn the_log_buffer_drops_the_oldest_lines_and_says_so() {
        let _test = SESSION_TEST_LOCK.lock().expect("session test lock");
        clear_logs();
        for index in 0..(MAX_LOG_ENTRIES + 10) {
            append_log(LogSource::Editor, &format!("line {index}"));
        }

        let page = read_logs(&LogQuery {
            limit: Some(1),
            ..LogQuery::default()
        })
        .expect("read logs");
        assert_eq!(page.dropped, 10);
        assert_eq!(page.entries[0].message, "line 10");

        // One oversized line cannot blow the page budget on its own.
        append_log(LogSource::Editor, &"x".repeat(MAX_LOG_LINE_CHARS * 2));
        let last = read_logs(&LogQuery {
            after: Some(u64::try_from(MAX_LOG_ENTRIES).expect("buffer size fits") + 10),
            ..LogQuery::default()
        })
        .expect("read tail");
        assert_eq!(last.entries[0].message.chars().count(), MAX_LOG_LINE_CHARS);
        clear_logs();
    }
}

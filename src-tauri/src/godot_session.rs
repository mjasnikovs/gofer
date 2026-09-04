//! Godot session supervisor.
//!
//! Owns one Gofer-managed Godot 4.7.2 editor session bound to the active task's worktree. The
//! supervisor verifies the engine version, binds the loopback RPC listener, allocates LSP/DAP
//! ports, verifies that the machine-wide LSP remote_host setting is loopback, and launches Godot
//! with the editor, path, LSP, and DAP flags. Only one session is allowed at a time.
//!
//! Public items are consumed by Tauri commands in later integration steps; the allow attribute
//! prevents cdylib/staticlib builds from treating them as dead code until those commands land.
#![allow(dead_code)]

use crate::ai_tools::ToolFailure;
use crate::godot_rpc;
use crate::paths;
use crate::process::{ChildProcess, ProcessSpawner};
use crate::protocol_v2::Readiness;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::VecDeque;
use std::ffi::{OsStr, OsString};
use std::fs;
use std::io::{BufRead, BufReader};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub const REQUIRED_ENGINE_VERSION: &str = "4.7.2";
pub const REQUIRED_CHANNEL: &str = "stable";
/// When the pinned release was published, from the `4.7.2-stable` tag in `godotengine/godot-builds`.
///
/// Held beside the version because the agent's prompt states it: a release dated after the model's
/// training data is the difference between "look this API up" and "write the name I remember",
/// and a model that is not told the date has no way to tell which of the two it is in.
pub const REQUIRED_ENGINE_RELEASED: &str = "2026-08-18";
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
/// How many lines a read answers with when the caller names no limit.
///
/// `pub(crate)` because `ai_tools` fills a page to this number after taking the editor's own
/// terminal output out of it — see `logs_domain`, which would otherwise read the whole buffer
/// whenever a caller named no limit.
pub(crate) const DEFAULT_LOG_PAGE: usize = 200;
/// The most a read answers with, however large a limit is asked for.
pub(crate) const MAX_LOG_PAGE: usize = 1_000;

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
    /// Whether the user asked for the game to be embedded in the editor.
    ///
    /// It is here, and not only in [`crate::godot_policy`], because on Linux embedding is a
    /// property of the display driver — a launch argument, decided before the editor exists. See
    /// [`wants_wayland_driver`].
    #[serde(default)]
    pub embed_game_window: bool,
}

/// Whether this launch has to ask Godot for its Wayland driver.
///
/// Godot 4.7.2 embeds a running game by hosting a compositor of its own and taking the game's
/// window into it, and on Linux it has exactly one — `platform/linuxbsd/wayland/wayland_embedder`.
/// There is no X11 counterpart, so an editor on X11 answers "Game embedding not available for the
/// Display Server: 'X11'" and opens the game in a window beside itself, however the editor setting
/// reads. Godot still starts on X11 by default even on a Wayland session, so the embed rule is not
/// a setting on its own: without this argument it is a setting the engine cannot honour.
///
/// Only when the user asked to embed, and only when there is a compositor to ask for. Forcing the
/// driver on an X11 session does not fall back — it fails the launch, which trades a game window in
/// the wrong place for no editor at all.
fn wants_wayland_driver(embed_game_window: bool, wayland_display: Option<&OsStr>) -> bool {
    cfg!(target_os = "linux")
        && embed_game_window
        && wayland_display.is_some_and(|display| !display.is_empty())
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

/// Every [`LogSeverity`], as serde spells it on the wire.
///
/// Declared beside the enum rather than recovered from it. `tool_drift` holds the `godot_logs read`
/// summary to the vocabulary its handler really accepts, and it used to do that by finding
/// `enum LogSeverity {` in this file's own source text and reading the lines to the brace that
/// closed it — the last such parser in the crate, and one a rename would have left comparing
/// nothing to nothing. What the enum offers is a fact about the enum, so changing the variants and
/// changing this list is one edit in one place.
#[cfg(test)]
pub const LOG_SEVERITY_NAMES: &[&str] = &["info", "warning", "error"];

/// Every [`LogSource`], as serde spells it on the wire. See [`LOG_SEVERITY_NAMES`].
#[cfg(test)]
pub const LOG_SOURCE_NAMES: &[&str] = &["editor", "editorError"];

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
    /// How many lines either side of a match to answer with. None and zero both mean the match
    /// alone, which is what this call has always answered with.
    #[serde(default)]
    pub context: Option<usize>,
    #[serde(default)]
    pub limit: Option<usize>,
}

/// The fields [`LogQuery`] deserializes, as serde spells them on the wire, and whether a call may
/// leave one out.
///
/// Declared beside the type rather than recovered from it. `tool_drift` holds the catalogue's
/// parameter table to what the handler behind it really reads, and what a query takes is a fact
/// about the query — so changing the struct and changing the list is one edit in one place.
///
/// Optional means what serde means: the type is an `Option`, or the field carries
/// `#[serde(default)]`.
#[cfg(test)]
pub const LOG_QUERY_FIELDS: &[(&str, bool)] = &[
    ("after", true),
    ("minSeverity", true),
    ("source", true),
    ("contains", true),
    ("context", true),
    ("limit", true),
];

/// One page of session logs plus the cursor that continues it.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogPage {
    pub entries: Vec<LogEntry>,
    /// Pass back as `after` to continue. It stops at the last line the page carried, so trailing
    /// context is never handed out twice and a filtered read never swallows lines it did not show.
    /// Unchanged when the page is empty, so a poller cannot skip a line that arrives between two
    /// reads.
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

    /// One page: the lines a query matched, and the lines around them it asked to see.
    ///
    /// `limit` bounds matches rather than lines. Counting the context against it lets a page come
    /// back holding none of what was searched for, which reads exactly like "nothing matched" — the
    /// one answer a filtered read must never fake.
    fn read(&self, query: &LogQuery) -> LogPage {
        let limit = query.limit.unwrap_or(DEFAULT_LOG_PAGE).min(MAX_LOG_PAGE);
        let needle = query
            .contains
            .as_ref()
            .map(|contains| contains.to_lowercase());
        let after = query.after.unwrap_or(0);
        let context = query.context.unwrap_or(0);
        let considered: Vec<&LogEntry> = self
            .entries
            .iter()
            .filter(|entry| entry.sequence > after)
            .collect();
        let mut answered = vec![false; considered.len()];
        for at in considered
            .iter()
            .enumerate()
            .filter(|(_, entry)| matches_filters(query, needle.as_deref(), entry))
            .map(|(at, _)| at)
            .take(limit)
        {
            let first = at.saturating_sub(context);
            let last = (at + context).min(considered.len().saturating_sub(1));
            answered[first..=last].fill(true);
        }
        let entries: Vec<LogEntry> = considered
            .into_iter()
            .zip(&answered)
            .filter(|(_, wanted)| **wanted)
            .map(|(entry, _)| entry.clone())
            .collect();
        let cursor = entries.last().map_or(after, |entry| entry.sequence);
        LogPage {
            entries,
            cursor,
            dropped: self.dropped,
        }
    }

    /// The newest entries a query's filters match, oldest of those first.
    ///
    /// [`read`](Self::read) pages *forward*: it answers with the first matches after its cursor and
    /// stops at the limit, so asking it for a tail means reading the whole buffer and hoping the
    /// limit covers it — and `MAX_LOG_PAGE` is a quarter of `MAX_LOG_ENTRIES`. A game that errors
    /// once per `_process` frame fills that page in seconds, and from then on every failure carried
    /// six lines from the start of the run instead of the ones that had just ended it. Walking
    /// backwards has no page to overflow.
    fn read_newest(&self, query: &LogQuery, wanted: usize) -> Vec<LogEntry> {
        let needle = query
            .contains
            .as_ref()
            .map(|contains| contains.to_lowercase());
        let mut entries: Vec<LogEntry> = self
            .entries
            .iter()
            .rev()
            .filter(|entry| matches_filters(query, needle.as_deref(), entry))
            .take(wanted)
            .cloned()
            .collect();
        entries.reverse();
        entries
    }
}

/// Whether one entry passes a query's filters, with the substring already lowercased.
///
/// The cursor is not one of them. `after` says where a page begins, and the two readers begin at
/// opposite ends of the buffer; everything else a query asks for is a fact about the entry alone.
fn matches_filters(query: &LogQuery, needle: Option<&str>, entry: &LogEntry) -> bool {
    if query
        .min_severity
        .is_some_and(|minimum| entry.severity < minimum)
    {
        return false;
    }
    if query.source.is_some_and(|source| entry.source != source) {
        return false;
    }
    if needle.is_some_and(|needle| !entry.message.to_lowercase().contains(needle)) {
        return false;
    }
    true
}

pub struct GodotSession {
    session_id: String,
    rpc_address: String,
    lsp_port: u16,
    dap_port: u16,
    godot_version: String,
    worktree: PathBuf,
    token: String,
    child: Arc<Mutex<Box<dyn ChildProcess>>>,
    pub rpc: godot_rpc::RpcSession,
    /// Whether the bookkeeping an exited editor needs has already been done.
    ///
    /// Not a state. The state is derived from the child every time it is asked, so it never has to
    /// be remembered; this is only how [`poll_editor_exit`] answers "was this call the one that
    /// found it", so the run row is closed once instead of on every later poll.
    noticed_exit: AtomicBool,
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
    #[cfg(any(feature = "webdriver", all(test, feature = "godot-acceptance")))]
    if std::env::var_os("GOFER_GODOT_HEADLESS").is_some() {
        arguments.insert(0, OsString::from("--headless"));
    }
    if !arguments.iter().any(|argument| argument == "--headless")
        && wants_wayland_driver(
            request.embed_game_window,
            std::env::var_os("WAYLAND_DISPLAY").as_deref(),
        )
    {
        arguments.insert(0, OsString::from("--display-driver"));
        arguments.insert(1, OsString::from("wayland"));
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
                (OsString::from("GOFER_DEBUG_PORT"), OsString::new()),
            ],
        )
        .map_err(|error| {
            SessionError::new(
                "godot_spawn_failed",
                format!("Could not launch Godot with '{binary}': {error}"),
            )
            .retryable()
        })?;

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
        rpc_address,
        lsp_port,
        dap_port,
        godot_version: godot_version.clone(),
        worktree,
        token,
        child,
        rpc,
        noticed_exit: AtomicBool::new(false),
    };

    let info = session_info(&session);
    *ACTIVE_SESSION
        .lock()
        .map_err(|_| SessionError::new("lock_poisoned", "The session lock is poisoned"))? =
        Some(session);
    Ok(info)
}

/// The state of the one Gofer-managed session, worked out from scratch every time it is asked.
///
/// There is no stored state to go stale. Three live facts decide it, and each is owned by the thing
/// that can actually see it:
///
/// - the child process, asked with `try_wait`: an editor that crashed or that the user closed is
///   `Error` from the moment it exits, whether or not anything was listening;
/// - the addon's own readiness, which it announces on every transition and which the transport
///   drops when the connection goes;
/// - whether the editor is playing the project, which the addon polls out of
///   `EditorInterface.is_playing_scene()` every frame, so a game that died is not running.
///
/// Before this, the state was a field written by whatever happened to be draining the event stream.
/// With no subscriber it never moved at all, and the badge read `ready` over a dead process.
fn derive_state(session: &GodotSession) -> SessionState {
    if session.child.lock().is_ok_and(has_exited) {
        return SessionState::Error;
    }
    match session.rpc.readiness() {
        Readiness::Ready if session.rpc.is_playing() => SessionState::Playing,
        Readiness::Ready => SessionState::Ready,
        Readiness::Importing => SessionState::Importing,
        Readiness::Starting => SessionState::Starting,
        Readiness::Unavailable => SessionState::Error,
    }
}

/// Everything the rest of Gofer needs from an editor, whoever started it.
///
/// Two methods, and both may answer `None`, because "there is no editor" is an ordinary answer
/// rather than a failure. Every consumer — the session commands, the language server, the debug
/// adapter — asks through this and nothing else, so what a caller can see does not depend on which
/// of them started the editor.
pub trait Editor: Send + Sync {
    /// The running editor's summary: its ports, its worktree, and what state it is in.
    fn info(&self) -> Option<SessionInfo>;
    /// The transport the addon answers on.
    fn rpc(&self) -> Option<godot_rpc::RpcSession>;
}

/// The editor this process's supervisor started, which is the one production always uses.
struct Supervised;

impl Editor for Supervised {
    fn info(&self) -> Option<SessionInfo> {
        ACTIVE_SESSION
            .lock()
            .ok()
            .and_then(|session| session.as_ref().map(session_info))
    }

    fn rpc(&self) -> Option<godot_rpc::RpcSession> {
        ACTIVE_SESSION
            .lock()
            .ok()
            .and_then(|session| session.as_ref().map(|session| session.rpc.clone()))
    }
}

/// Which editor this process is bound to. `None` means the one the supervisor started.
///
/// This replaced four separate back doors — a session summary slot, an RPC slot, and one editor
/// binding each in `script` and `debug` — that existed because the supervisor launches a windowed
/// editor a headless gate cannot run, so a test had no way to say "this editor" except by reaching
/// past the module that owns the question. One binding is not a test-only fixture: an acceptance
/// suite that launched the pinned editor itself is describing a real editor, and everything that
/// reads an editor should see the same one.
static BOUND_EDITOR: Mutex<Option<Arc<dyn Editor>>> = Mutex::new(None);

/// The editor everything asks. The supervisor's, unless something bound another.
pub fn editor() -> Arc<dyn Editor> {
    BOUND_EDITOR
        .lock()
        .ok()
        .and_then(|bound| bound.clone())
        .unwrap_or_else(|| Arc::new(Supervised))
}

/// Binds an editor something else started, or `None` to go back to the supervisor's.
///
/// Dropping the language server and the debug adapter is part of binding rather than something a
/// caller has to remember: both cache a connection to whichever editor was bound when they first
/// answered, and a cached connection to the previous editor is a connection to the wrong one.
/// Each binding used to carry its own `disconnect()`, which is three places to forget it.
pub fn bind(bound: Option<Arc<dyn Editor>>) {
    crate::script::disconnect();
    crate::debug::disconnect();
    if let Ok(mut slot) = BOUND_EDITOR.lock() {
        *slot = bound;
    }
}

/// Whether something other than the supervisor bound the editor everything is asking.
pub fn is_bound() -> bool {
    BOUND_EDITOR
        .lock()
        .is_ok_and(|bound| bound.as_ref().is_some())
}

/// An editor something other than the supervisor started, described by what it answers with.
///
/// The acceptance suites launch the pinned editor themselves — the supervisor starts a windowed
/// one, which a headless gate cannot run — and this is how they say so.
pub struct ExternalEditor {
    info: Option<SessionInfo>,
    rpc: Option<godot_rpc::RpcSession>,
}

impl ExternalEditor {
    /// An editor reachable at these ports, in this worktree.
    pub fn new(info: SessionInfo) -> Self {
        Self {
            info: Some(info),
            rpc: None,
        }
    }

    /// The transport its addon answers on, when the caller has one.
    #[must_use]
    pub fn with_rpc(mut self, rpc: godot_rpc::RpcSession) -> Self {
        self.rpc = Some(rpc);
        self
    }

    /// An editor listening on these ports for this worktree.
    ///
    /// A port of 0 says the caller launched the editor without that transport, which is how the
    /// script suite says it has a language server and no debug adapter.
    pub fn at(lsp_port: u16, dap_port: u16, worktree: &Path) -> Self {
        Self::new(SessionInfo {
            session_id: "external".to_owned(),
            state: SessionState::Ready,
            rpc_address: String::new(),
            lsp_port,
            dap_port,
            godot_version: REQUIRED_ENGINE_VERSION.to_owned(),
            worktree: worktree.display().to_string(),
        })
    }

    /// An editor that answers nothing: what a caller binds to prove a guard refuses without one.
    pub fn absent() -> Self {
        Self {
            info: None,
            rpc: None,
        }
    }
}

impl Editor for ExternalEditor {
    fn info(&self) -> Option<SessionInfo> {
        self.info.clone()
    }

    fn rpc(&self) -> Option<godot_rpc::RpcSession> {
        self.rpc.clone()
    }
}

/// Returns the current session state without taking a reference.
pub fn current_state() -> SessionState {
    current_info()
        .map(|info| info.state)
        .unwrap_or(SessionState::Offline)
}

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

/// Whether this call is the one that found the editor gone.
///
/// The state no longer needs marking — it is derived — so all this decides is who does the
/// bookkeeping an exited editor leaves behind: closing the run row, dropping the language server
/// and the debug adapter. It answers `true` once and `false` for every later poll, so a caller
/// polling it does not rewrite a run's ending over and over.
pub fn poll_editor_exit() -> bool {
    let Ok(active) = ACTIVE_SESSION.lock() else {
        return false;
    };
    let Some(session) = active.as_ref() else {
        return false;
    };
    if !session.child.lock().is_ok_and(has_exited) {
        return false;
    }
    !session.noticed_exit.swap(true, Ordering::AcqRel)
}

/// Returns a clone of the current session summary, if any.
pub fn current_info() -> Option<SessionInfo> {
    editor().info()
}

/// Returns a clone of the active RPC session, if any.
pub fn rpc_session() -> Option<godot_rpc::RpcSession> {
    editor().rpc()
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

/// Reads the newest captured lines a query matches, oldest of those first.
///
/// The tail rather than a page. Nothing outside this module wants it: paging forward is what a
/// reader of output does, and reading backwards is what the failure messages below do.
fn newest_logs(query: &LogQuery, wanted: usize) -> Vec<LogEntry> {
    LOGS.lock()
        .map(|logs| logs.read_newest(query, wanted))
        .unwrap_or_default()
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

/// Holds the session lock and binds an editor that answers nothing, for a test whose subject is
/// what happens when no session is active.
///
/// The lock on its own is not enough. It serializes the test against the ones that bind an editor,
/// but what it then observes is still whatever the last of those left behind, and a test that
/// asserts "no session" while another has one bound reads a different refusal — or no refusal at
/// all. Binding absent makes the precondition the test's own, so the assertion is about the code
/// under test rather than about cleanup order. The binding is released when the guard drops, before
/// the lock it is holding.
#[cfg(test)]
pub(crate) fn no_editor_bound() -> NoEditorBound {
    let lock = SESSION_TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    bind(Some(Arc::new(ExternalEditor::absent())));
    NoEditorBound { _lock: lock }
}

/// What [`no_editor_bound`] hands back. Unbinds on drop.
#[cfg(test)]
pub(crate) struct NoEditorBound {
    _lock: std::sync::MutexGuard<'static, ()>,
}

#[cfg(test)]
impl Drop for NoEditorBound {
    fn drop(&mut self) {
        bind(None);
    }
}

/// How long the editor gets to close itself before [`stop`] kills it. A headless editor quit in
/// well under a second when this was measured; the budget is for a machine under load.
const QUIT_TIMEOUT: Duration = Duration::from_secs(10);
/// How often the closing editor is checked. Short enough that an ordinary stop still feels instant.
const QUIT_POLL: Duration = Duration::from_millis(100);
/// The editor answers `session.quit` before it acts, so this only covers the round trip.
const QUIT_REQUEST_TIMEOUT_MS: u64 = 2_000;

/// Asks the editor to quit and waits for it to go, up to [`QUIT_TIMEOUT`].
///
/// Says nothing about whether it worked, because there is nothing for the caller to do either way:
/// the kill that follows handles the editor that stayed, and handles the one that never heard the
/// question. The waiting is announced in the session log because it is the one part of stopping
/// that a person can notice.
fn quit_gracefully(session: &GodotSession, child: &mut Box<dyn ChildProcess>) {
    if matches!(child.try_wait(), Ok(Some(_))) || session.rpc.readiness() == Readiness::Unavailable
    {
        return;
    }
    let asked = session.rpc.call(
        godot_rpc::CallRequest::new("session.quit", json!({}))
            .within(Some(QUIT_REQUEST_TIMEOUT_MS)),
    );
    if asked.is_err() {
        return;
    }
    append_log(
        LogSource::Editor,
        "Waiting for Godot to exit gracefully so its editor settings are saved\n",
    );
    let deadline = std::time::Instant::now() + QUIT_TIMEOUT;
    while std::time::Instant::now() < deadline {
        if matches!(child.try_wait(), Ok(Some(_))) {
            return;
        }
        std::thread::sleep(QUIT_POLL);
    }
}

/// Asks the editor to close itself and waits, then kills whatever is left.
///
/// This used to kill outright. Godot writes its machine-wide EditorSettings on its own way out of
/// the editor and on no other path — probed against the pinned 4.7.2, where SIGTERM, SIGINT and
/// SIGKILL each left the settings file untouched, and where a `get_tree().quit()` from inside the
/// editor saved a value the next editor read straight back. So every editor setting an agent
/// changed was applied to the live editor and thrown away here, while `editor.set_setting`
/// answered as though it had been kept.
///
/// The kill stays as the fallback rather than the method. An editor that is wedged, crashed, or
/// already gone still has to be cleaned up, and stopping a session cannot be allowed to fail
/// because the editor would not listen.
pub fn stop() -> Result<(), SessionError> {
    let active = ACTIVE_SESSION
        .lock()
        .map_err(|_| SessionError::new("lock_poisoned", "The session lock is poisoned"))?
        .take()
        .ok_or_else(|| SessionError::new("session_not_active", "No Godot session is active"))?;
    let mut child = active
        .child
        .lock()
        .map_err(|_| SessionError::new("lock_poisoned", "The child process lock is poisoned"))?;
    quit_gracefully(&active, &mut child);
    active.rpc.stop();
    match child.kill() {
        Ok(()) => Ok(()),
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

/// Accepts exactly one engine: 4.7.2-stable.
///
/// `--version` answers `4.7.2.stable` for a build made from source and
/// `4.7.2.stable.official.<hash>` for a release, so the required version and channel are matched as
/// a prefix and the build metadata behind them is ignored. Requiring the whole string to equal
/// `4.7.2.stable` would reject every published release — which is every editor a user actually has.
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
        state: derive_state(session),
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
         godot_logs read.",
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
             call — retrying it will not help. Start a new session with godot_session start.",
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
                "The game is stopped in the debugger, so it runs no frame and godot_runtime {op} \
                 cannot be answered. Waiting will not change that. godot_debug continue lets it \
                 run on, and godot_debug stack_trace says where it is stopped. godot_runtime \
                 capture, get_tree, inspect_node and get_monitors are not refused here — a break \
                 stops the scene tree and not the renderer, so a stopped game still photographs \
                 and still answers a read."
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
         nothing until it runs on. If one is set, godot_debug continue is what lets this call \
         through; godot_debug stack_trace says where it is stopped."
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
    if !facts
        .errors
        .iter()
        .any(|line| line.starts_with("SCRIPT ERROR:"))
    {
        return None;
    }
    Some(
        "The game's own scripts did not compile — the errors below are the engine refusing to run \
         them, not a slow start. Waiting for the helper and reading get_state again will not change \
         that, and stopping and running again reaches the same place. Fix what the errors name and \
         run once more."
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
         session, so it hands them to the next game it plays — including one godot_runtime run \
         starts — and a game stopped at one draws no frame. Clear it with godot_debug \
         set_breakpoints and an empty lines list for that file, then run again.",
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
         merge, or an edit to the file. Restart the editor with godot_session stop then \
         godot_session start, which stages it again."
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
        !is_the_engines_own_epilogue(&entry.message)
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
    LOGS.lock().ok().and_then(|logs| {
        logs.read(&LogQuery {
            after: Some(sequence),
            limit: Some(1),
            ..LogQuery::default()
        })
        .entries
        .into_iter()
        .next()
        .filter(|entry| entry.sequence == sequence + 1)
        .map(|entry| entry.message)
    })
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
    use crate::process::{
        ChildProcess, ProcessOutput, ProcessReader, ProcessStatus, ProcessWriter,
    };
    use std::ffi::{OsStr, OsString};
    use std::io::{self, Cursor};
    use std::sync::atomic::{AtomicBool, Ordering};
    use tempfile::TempDir;

    /// The two declared vocabularies are the words serde really reads and writes.
    ///
    /// A list beside a type is only worth having if it is the type's own spelling, so each name is
    /// run down the wire both ways: deserialize it into the variant, serialize that back, and it
    /// has to be the same word. A misspelled entry would otherwise sit in the catalogue advertising
    /// a filter no query can name.
    #[test]
    fn the_declared_log_vocabularies_are_the_words_serde_reads() {
        for name in LOG_SEVERITY_NAMES {
            let severity: LogSeverity =
                serde_json::from_value(json!(name)).unwrap_or_else(|_| panic!("{name} is read"));
            assert_eq!(serde_json::to_value(severity).unwrap(), json!(name));
        }
        for name in LOG_SOURCE_NAMES {
            let source: LogSource =
                serde_json::from_value(json!(name)).unwrap_or_else(|_| panic!("{name} is read"));
            assert_eq!(serde_json::to_value(source).unwrap(), json!(name));
        }
    }

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
        fs::write(
            &path,
            format!("[network]\n\nnetwork/{LSP_REMOTE_HOST_KEY} = \"{host}\"\n"),
        )
        .expect("write editor settings");
        (directory, path)
    }

    #[test]
    fn supported_version_matches_exact_release() {
        assert!(is_supported_version("4.7.2.stable"));
        assert!(is_supported_version("4.7.2.stable.official"));
        assert!(is_supported_version("4.7.2.stable.official.ed1daf0bf"));
        assert!(!is_supported_version("4.7.2.dev"));
        assert!(!is_supported_version("4.7.0.stable"));
        assert!(!is_supported_version("4.7.2.stablish.official"));
        assert!(!is_supported_version("4.7.20.stable"));
        assert!(!is_supported_version("4.7.2"));
        assert!(!is_supported_version(""));
    }

    /// Everything that asks about an editor asks the bound one, whoever started it.
    ///
    /// This used to be four questions with four answers. `current_info` read one test slot first,
    /// `rpc_session` read another, and `script` and `debug` each kept a third and a fourth, so a
    /// suite that had bound its own editor into two of them could be asked the same question by
    /// two callers and give two answers. There is one binding now, and this is what says so.
    #[test]
    fn every_reader_sees_the_editor_that_is_bound() {
        let _test = SESSION_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let directory = TempDir::new().expect("temporary directory");

        bind(Some(Arc::new(ExternalEditor::at(
            6005,
            6006,
            directory.path(),
        ))));

        let info = current_info().expect("the bound editor is the one that answers");
        assert_eq!(info.lsp_port, 6005);
        assert_eq!(info.dap_port, 6006);
        assert_eq!(info.worktree, directory.path().display().to_string());
        assert_eq!(current_state(), SessionState::Ready);
        assert!(
            rpc_session().is_none(),
            "an editor bound without a transport has none to hand out"
        );

        bind(None);
        assert!(current_info().is_none());
        assert_eq!(current_state(), SessionState::Offline);
    }

    /// An editor bound as absent is not the same as no binding at all.
    ///
    /// A guard that refuses without an editor has to be provable, and the supervisor's own answer
    /// depends on what every other test in the process left behind.
    #[test]
    fn an_absent_editor_answers_nothing() {
        let _test = SESSION_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());

        bind(Some(Arc::new(ExternalEditor::absent())));
        assert!(current_info().is_none());
        assert!(rpc_session().is_none());
        assert_eq!(current_state(), SessionState::Offline);
        bind(None);
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
        assert!(!read_lsp_remote_host().expect("discovered host").is_empty());
    }

    #[test]
    fn a_workspace_without_a_project_file_is_refused_by_name() {
        let _test = SESSION_TEST_LOCK.lock().expect("session test lock");
        let directory = TempDir::new().expect("temporary worktree");
        let worktree = paths::canonical(directory.path()).expect("canonicalize");
        let spawner = FakeSpawner::new("4.7.2.stable");

        let error = start_with(
            LaunchRequest {
                worktree: worktree.clone(),
                binary: None,
                embed_game_window: false,
            },
            &spawner,
        )
        .expect_err("a directory that is not a Godot project cannot host a session");

        assert_eq!(error.code, "not_a_godot_project");
        assert!(error.message.contains(&worktree.display().to_string()));
        assert!(
            spawner.arguments.lock().expect("arguments").is_empty(),
            "no editor is launched for a directory that is not a project"
        );
    }

    /// Embedding is a display driver, not only a setting.
    ///
    /// Found on a live Wayland desktop with `game_embed_mode` already reading 1 in the editor
    /// settings file: the game still opened in a window of its own. Godot 4.7.2 carries one game
    /// embedder on Linux and it is the Wayland one, and Godot starts on X11 by default even inside
    /// a Wayland session — so the rule the user ticked was written to an editor that could not
    /// carry it out.
    #[test]
    fn embedding_asks_for_the_only_linux_driver_that_can_embed() {
        let wayland = Some(OsStr::new("wayland-1"));
        assert_eq!(
            wants_wayland_driver(true, wayland),
            cfg!(target_os = "linux")
        );
        assert!(!wants_wayland_driver(false, wayland));
        assert!(!wants_wayland_driver(true, None));
        assert!(!wants_wayland_driver(true, Some(OsStr::new(""))));
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
        let spawner = FakeSpawner::new("4.7.2.stable");

        let info = start_with(
            LaunchRequest {
                worktree,
                binary: None,
                embed_game_window: false,
            },
            &spawner,
        )
        .expect("start session");

        assert_eq!(info.state, SessionState::Starting);
        assert_eq!(info.godot_version, "4.7.2.stable");
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

    /// The driver the rule needs reaches the launch, and it reaches it as a pair.
    ///
    /// `--display-driver` takes its value as the next argument, so a flag inserted without one
    /// makes Godot read `--editor` as a driver name and refuse to start at all.
    #[cfg(target_os = "linux")]
    #[test]
    fn an_embedding_session_is_launched_on_wayland() {
        let _test = SESSION_TEST_LOCK.lock().expect("session test lock");
        let (_directory, worktree) = workspace();
        let (_settings_dir, settings_path) = settings_file_with("127.0.0.1");
        unsafe {
            std::env::set_var(
                "GOFER_GODOT_EDITOR_SETTINGS",
                settings_path.display().to_string(),
            );
            std::env::set_var("WAYLAND_DISPLAY", "wayland-1");
        };
        let spawner = FakeSpawner::new("4.7.2.stable");

        start_with(
            LaunchRequest {
                worktree,
                binary: None,
                embed_game_window: true,
            },
            &spawner,
        )
        .expect("start session");

        let arguments = spawner.arguments.lock().expect("arguments");
        let driver = arguments
            .iter()
            .position(|argument| argument == "--display-driver")
            .expect("an embedding session names its display driver");
        assert_eq!(arguments[driver + 1], OsString::from("wayland"));
        drop(arguments);

        stop().expect("stop session");
        unsafe {
            std::env::remove_var("GOFER_GODOT_EDITOR_SETTINGS");
            std::env::remove_var("WAYLAND_DISPLAY");
        };
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
        let spawner = FakeSpawner::new("4.7.2.stable");

        start_with(
            LaunchRequest {
                worktree,
                binary: None,
                embed_game_window: false,
            },
            &spawner,
        )
        .expect("start session");
        assert!(!poll_editor_exit());
        assert_eq!(current_state(), SessionState::Starting);

        spawner.exited.store(true, Ordering::Release);
        assert_eq!(current_state(), SessionState::Error);
        assert!(poll_editor_exit(), "the exit must be noticed");
        assert!(!poll_editor_exit());
        assert_eq!(current_state(), SessionState::Error);

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
        let first = FakeSpawner::new("4.7.2.stable");
        start_with(
            LaunchRequest {
                worktree: worktree.clone(),
                binary: None,
                embed_game_window: false,
            },
            &first,
        )
        .expect("start the first session");

        let second = FakeSpawner::new("4.7.2.stable");
        let refused = start_with(
            LaunchRequest {
                worktree: worktree.clone(),
                binary: None,
                embed_game_window: false,
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
        assert!(
            editor_has_exited(),
            "a dead editor must be reported as gone"
        );
        assert!(poll_editor_exit(), "the first poll finds the exit");
        assert!(
            editor_has_exited(),
            "and the answer does not change after it"
        );

        let replacement = FakeSpawner::new("4.7.2.stable");
        start_with(
            LaunchRequest {
                worktree,
                binary: None,
                embed_game_window: false,
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
                embed_game_window: false,
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
        let spawner = FakeSpawner::new("4.7.2.stable");

        let error = start_with(
            LaunchRequest {
                worktree,
                binary: None,
                embed_game_window: false,
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
        let spawner = FakeSpawner::new("4.7.2.stable");

        start_with(
            LaunchRequest {
                worktree,
                binary: None,
                embed_game_window: false,
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
                    embed_game_window: false,
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
        append_log(LogSource::Editor, "Godot Engine v4.7.2.stable\n");
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
        assert_eq!(all.entries[0].message, "Godot Engine v4.7.2.stable");
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

    /// A match comes back with the lines around it, because a match is rarely the whole answer.
    ///
    /// A game's `=== SUMMARY ===` banner is one matching line above four that carry the numbers. A
    /// live turn harvested that block by sending six `contains` entries in one call, one per line
    /// it already knew the wording of — which only works when you know what you are looking for.
    #[test]
    fn a_matching_line_can_come_back_with_the_lines_around_it() {
        let _test = session_test_lock();
        clear_logs();
        for index in 0..10 {
            append_log(LogSource::Editor, &format!("line {index}"));
        }
        append_log(LogSource::Editor, "=== SUMMARY ===");
        for index in 0..4 {
            append_log(LogSource::Editor, &format!("stat {index}"));
        }

        let page = read_logs(&LogQuery {
            contains: Some("SUMMARY".to_owned()),
            context: Some(4),
            ..LogQuery::default()
        })
        .expect("read logs");
        let lines: Vec<&str> = page
            .entries
            .iter()
            .map(|entry| entry.message.as_str())
            .collect();
        assert_eq!(
            lines,
            [
                "line 6",
                "line 7",
                "line 8",
                "line 9",
                "=== SUMMARY ===",
                "stat 0",
                "stat 1",
                "stat 2",
                "stat 3",
            ],
            "the four lines either side of the match must come with it"
        );
        clear_logs();
    }

    /// Two matches close together are one run of lines, not the same lines twice.
    ///
    /// `limit` still counts what comes back rather than what matched: a context window is lines the
    /// caller pays for, and a page that overran its limit would be the cost the parameter exists to
    /// bound.
    #[test]
    fn overlapping_context_windows_answer_each_line_once() {
        let _test = session_test_lock();
        clear_logs();
        for index in 0..8 {
            append_log(LogSource::Editor, &format!("line {index}"));
        }
        append_log(LogSource::Editor, "hit one");
        append_log(LogSource::Editor, "between");
        append_log(LogSource::Editor, "hit two");
        for index in 0..8 {
            append_log(LogSource::Editor, &format!("tail {index}"));
        }

        let page = read_logs(&LogQuery {
            contains: Some("hit".to_owned()),
            context: Some(2),
            ..LogQuery::default()
        })
        .expect("read logs");
        let lines: Vec<&str> = page
            .entries
            .iter()
            .map(|entry| entry.message.as_str())
            .collect();
        assert_eq!(
            lines,
            [
                "line 6", "line 7", "hit one", "between", "hit two", "tail 0", "tail 1",
            ],
            "two windows that overlap are one run of lines"
        );

        // `limit` bounds matches, and the context they asked for rides along. Counting context
        // against the limit lets a page come back holding none of what was searched for, which
        // reads exactly like "no matches" and is the one answer a filtered read must never fake.
        let bounded = read_logs(&LogQuery {
            contains: Some("hit".to_owned()),
            context: Some(2),
            limit: Some(1),
            ..LogQuery::default()
        })
        .expect("read logs");
        let first: Vec<&str> = bounded
            .entries
            .iter()
            .map(|entry| entry.message.as_str())
            .collect();
        assert_eq!(
            first,
            ["line 6", "line 7", "hit one", "between", "hit two"],
            "one match, with the lines around it"
        );
        clear_logs();
    }

    /// A page of context is a page: what it answered does not arrive again behind its cursor.
    ///
    /// Trailing context sits ahead of the match that pulled it in, so a cursor left at the match
    /// hands those lines out twice and a cursor thrown to the end of the buffer swallows lines a
    /// later query wanted. It goes to the last line the page actually carried.
    #[test]
    fn a_context_page_leaves_its_cursor_past_the_lines_it_answered() {
        let _test = session_test_lock();
        clear_logs();
        for index in 0..4 {
            append_log(LogSource::Editor, &format!("line {index}"));
        }
        append_log(LogSource::Editor, "hit one");
        for index in 0..4 {
            append_log(LogSource::Editor, &format!("tail {index}"));
        }
        append_log(LogSource::Editor, "hit two");
        for index in 0..4 {
            append_log(LogSource::Editor, &format!("rest {index}"));
        }

        let page = read_logs(&LogQuery {
            contains: Some("hit".to_owned()),
            context: Some(1),
            limit: Some(1),
            ..LogQuery::default()
        })
        .expect("read logs");
        let answered: Vec<String> = page
            .entries
            .iter()
            .map(|entry| entry.message.clone())
            .collect();
        assert_eq!(answered, ["line 3", "hit one", "tail 0"]);
        assert_eq!(
            page.cursor,
            page.entries.last().expect("a page").sequence,
            "the cursor stops at the last line the page carried"
        );

        let next = read_logs(&LogQuery {
            contains: Some("hit".to_owned()),
            context: Some(1),
            after: Some(page.cursor),
            ..LogQuery::default()
        })
        .expect("read logs");
        let following: Vec<String> = next
            .entries
            .iter()
            .map(|entry| entry.message.clone())
            .collect();
        assert_eq!(following, ["tail 3", "hit two", "rest 0"]);
        assert!(
            following.iter().all(|line| !answered.contains(line)),
            "a second page must not repeat the first: {following:?}"
        );
        clear_logs();
    }

    /// No context asked for is the page this call has always answered with.
    #[test]
    fn a_read_that_asks_for_no_context_answers_only_what_matched() {
        let _test = session_test_lock();
        clear_logs();
        for index in 0..4 {
            append_log(LogSource::Editor, &format!("line {index}"));
        }
        append_log(LogSource::Editor, "=== SUMMARY ===");

        for context in [None, Some(0)] {
            let page = read_logs(&LogQuery {
                contains: Some("SUMMARY".to_owned()),
                context,
                ..LogQuery::default()
            })
            .expect("read logs");
            assert_eq!(page.entries.len(), 1, "{context:?}");
            assert_eq!(page.entries[0].message, "=== SUMMARY ===");
        }
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

        append_log(LogSource::Editor, &"x".repeat(MAX_LOG_LINE_CHARS * 2));
        let last = read_logs(&LogQuery {
            after: Some(u64::try_from(MAX_LOG_ENTRIES).expect("buffer size fits") + 10),
            ..LogQuery::default()
        })
        .expect("read tail");
        assert_eq!(last.entries[0].message.chars().count(), MAX_LOG_LINE_CHARS);
        clear_logs();
    }

    /// Serializes the tests that share the one session log buffer.
    ///
    /// A poisoned lock is taken anyway. The buffer is seeded from scratch by every test that holds
    /// this, so there is no state a panicking test could have left half-written — and refusing the
    /// lock would turn one honest assertion failure into three tests reporting `PoisonError`
    /// instead of what they actually found.
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

    /// Ages everything in the buffer, for the checks that are about how old a line is.
    fn backdated_by(milliseconds: u64) {
        if let Ok(mut logs) = LOGS.lock() {
            for entry in &mut logs.entries {
                entry.timestamp = entry.timestamp.saturating_sub(milliseconds);
            }
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
            carried.message.contains("godot_session start"),
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
            carried.message.contains("godot_session start"),
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
        backdated_by(10 * 60 * 1000);
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
        assert!(
            held.message.contains("godot_debug continue"),
            "{}",
            held.message
        );

        let alone = explaining(
            &a_session_with_nothing_wrong(),
            addon_failure("runtime_timeout", "The game did not answer in time"),
        );
        assert_eq!(alone.message, "The game did not answer in time");
    }

    /// The two operations a halted game cannot serve are the addon's list, not a second copy of it.
    ///
    /// A drift here is silent and costs a working call: an operation this list gained that Rust
    /// never heard of would go on spending its deadline, and one Rust invented would be refused
    /// against a game that could have answered it.
    #[test]
    fn the_process_awaiting_operations_are_the_addons_own() {
        assert_eq!(
            *PROCESS_AWAITING_OPS,
            vec!["input".to_owned(), "wait".to_owned()],
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
            refused.message.contains("godot_debug continue"),
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
        assert!(
            held.message.contains("godot_debug continue"),
            "{}",
            held.message
        );
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
}

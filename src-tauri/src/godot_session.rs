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
use crate::process::{ChildProcess, ProcessSpawner};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::ffi::{OsStr, OsString};
use std::fs;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub const REQUIRED_ENGINE_VERSION: &str = "4.7.1";
pub const REQUIRED_CHANNEL: &str = "stable";
const PORT_RETRIES: usize = 3;
const EDITOR_SETTINGS_FILE_NAME: &str = "editor_settings-4.tres";
const LSP_REMOTE_HOST_KEY: &str = "language_server/remote_host";

static ACTIVE_SESSION: Mutex<Option<GodotSession>> = Mutex::new(None);
static SESSION_STARTING: AtomicBool = AtomicBool::new(false);

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
}

/// Summary of a running session returned to callers.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub state: SessionState,
    pub rpc_address: String,
    pub lsp_port: u16,
    pub dap_port: u16,
    pub godot_version: String,
    pub worktree: String,
}

pub struct GodotSession {
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
        let active = ACTIVE_SESSION
            .lock()
            .map_err(|_| SessionError::new("lock_poisoned", "The session lock is poisoned"))?;
        if active.is_some() {
            return Err(SessionError::new(
                "session_already_active",
                "A Godot session is already active",
            ));
        }
    }

    let worktree = canonical_worktree(&request.worktree)?;
    let binary = discover_binary(spawner)?;
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

    let _stdout = child
        .take_stdout()
        .ok_or_else(|| SessionError::new("godot_stdout_missing", "Could not read Godot output"))?;
    let _stderr = child
        .take_stderr()
        .ok_or_else(|| SessionError::new("godot_stderr_missing", "Could not read Godot errors"))?;

    let child = Arc::new(Mutex::new(child));
    let project_path = worktree.display().to_string();
    let rpc = godot_rpc::RpcSession::start(rpc_listener, token.clone(), project_path);
    let session = GodotSession {
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

/// Returns a clone of the current session summary, if any.
pub fn current_info() -> Option<SessionInfo> {
    ACTIVE_SESSION
        .lock()
        .ok()
        .and_then(|session| session.as_ref().map(session_info))
}

/// Updates the lifecycle state of the active session.
pub fn set_state(state: SessionState) {
    if let Ok(mut session) = ACTIVE_SESSION.lock()
        && let Some(session) = session.as_mut()
    {
        session.state = state;
    }
}

/// Returns a clone of the active RPC session, if any.
pub fn rpc_session() -> Option<godot_rpc::RpcSession> {
    ACTIVE_SESSION
        .lock()
        .ok()
        .and_then(|session| session.as_ref().map(|session| session.rpc.clone()))
}

/// Stops the active session by killing the Godot child process.
pub fn stop() -> Result<(), SessionError> {
    let active = ACTIVE_SESSION
        .lock()
        .map_err(|_| SessionError::new("lock_poisoned", "The session lock is poisoned"))?
        .take()
        .ok_or_else(|| SessionError::new("session_not_active", "No Godot session is active"))?;
    active.rpc.stop();
    active
        .child
        .lock()
        .map_err(|_| SessionError::new("lock_poisoned", "The child process lock is poisoned"))?
        .kill()
        .map_err(|error| {
            SessionError::new(
                "godot_kill_failed",
                format!("Could not stop the Godot session: {error}"),
            )
        })
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

fn is_supported_version(version: &str) -> bool {
    let Some((numbers, channel)) = version.rsplit_once('.') else {
        return false;
    };
    numbers == REQUIRED_ENGINE_VERSION && channel == REQUIRED_CHANNEL
}
// coverage-critical-end: version

fn discover_binary(spawner: &impl ProcessSpawner) -> Result<String, SessionError> {
    if let Ok(binary) = std::env::var("GOFER_GODOT_BINARY") {
        if command_text(spawner, &binary, &["--version"]).is_ok() {
            return Ok(binary);
        }
        return Err(SessionError::new(
            "configured_binary_unusable",
            format!("GOFER_GODOT_BINARY points to an unusable executable: {binary}"),
        ));
    }
    for binary in ["godot4", "godot"] {
        if command_text(spawner, binary, &["--version"]).is_ok() {
            return Ok(binary.to_owned());
        }
    }
    Err(SessionError::new(
        "godot_not_found",
        "Godot was not found. Install Godot 4.7.1-stable or set GOFER_GODOT_BINARY.",
    ))
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
    worktree
        .canonicalize()
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
        state: session.state,
        rpc_address: session.rpc_address.clone(),
        lsp_port: session.lsp_port,
        dap_port: session.dap_port,
        godot_version: session.godot_version.clone(),
        worktree: session.worktree.display().to_string(),
    }
}

fn editor_settings_path() -> Result<PathBuf, SessionError> {
    if let Ok(path) = std::env::var("GOFER_GODOT_EDITOR_SETTINGS") {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Ok(path);
        }
        return Err(SessionError::new(
            "editor_settings_missing",
            format!(
                "GOFER_GODOT_EDITOR_SETTINGS points to a missing file: {}",
                path.display()
            ),
        ));
    }

    let config_root = dirs::config_dir().ok_or_else(|| {
        SessionError::new(
            "config_dir_unavailable",
            "Could not resolve the user configuration directory",
        )
    })?;
    let path = config_root.join("Godot").join(EDITOR_SETTINGS_FILE_NAME);
    if path.is_file() {
        return Ok(path);
    }

    #[cfg(target_os = "macos")]
    {
        let path = dirs::home_dir()
            .ok_or_else(|| {
                SessionError::new(
                    "home_dir_unavailable",
                    "Could not resolve the home directory",
                )
            })?
            .join("Library/Application Support/Godot")
            .join(EDITOR_SETTINGS_FILE_NAME);
        if path.is_file() {
            return Ok(path);
        }
    }

    Err(SessionError::new(
        "editor_settings_missing",
        "Godot editor settings could not be found. Set GOFER_GODOT_EDITOR_SETTINGS.",
    ))
}

fn read_lsp_remote_host() -> Result<String, SessionError> {
    let path = editor_settings_path()?;
    let text = fs::read_to_string(&path).map_err(|error| {
        SessionError::new(
            "editor_settings_unreadable",
            format!("Could not read Godot editor settings: {error}"),
        )
        .retryable()
    })?;
    Ok(parse_lsp_remote_host(&text).unwrap_or_else(|| "127.0.0.1".to_owned()))
}

fn parse_lsp_remote_host(text: &str) -> Option<String> {
    for line in text.lines() {
        let line = line.trim();
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        if key.trim() != LSP_REMOTE_HOST_KEY {
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

    static SESSION_TEST_LOCK: Mutex<()> = Mutex::new(());

    struct FakeSpawner {
        version_output: String,
        child: Mutex<Option<FakeChild>>,
        arguments: Arc<Mutex<Vec<OsString>>>,
        env_vars: Arc<Mutex<Vec<(OsString, OsString)>>>,
        fail_spawn: bool,
    }

    impl FakeSpawner {
        fn new(version: &str) -> Self {
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
                })),
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
            Ok(Some(self.status.clone()))
        }

        fn wait(&mut self) -> io::Result<ProcessStatus> {
            Ok(self.status.clone())
        }

        fn kill(&mut self) -> io::Result<()> {
            self.killed.store(true, Ordering::Release);
            Ok(())
        }
    }

    fn workspace() -> (TempDir, PathBuf) {
        let directory = TempDir::new().expect("temporary worktree");
        let path = directory.path().canonicalize().expect("canonicalize");
        (directory, path)
    }

    fn settings_file_with(host: &str) -> (TempDir, PathBuf) {
        let directory = TempDir::new().expect("temporary settings dir");
        let path = directory.path().join(EDITOR_SETTINGS_FILE_NAME);
        fs::write(
            &path,
            format!("[network]\n\n{LSP_REMOTE_HOST_KEY}=\"{host}\"\n"),
        )
        .expect("write editor settings");
        (directory, path)
    }

    #[test]
    fn supported_version_matches_exact_release() {
        assert!(is_supported_version("4.7.1.stable"));
        assert!(!is_supported_version("4.7.1.dev"));
        assert!(!is_supported_version("4.7.0.stable"));
        assert!(!is_supported_version("4.7.1.stable.official"));
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
        assert_eq!(
            parse_lsp_remote_host("[network]\n\nother_setting=\"x\"\n"),
            None
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

        let info = start_with(LaunchRequest { worktree }, &spawner).expect("start session");

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

        let error = start_with(LaunchRequest { worktree }, &spawner).expect_err("bad version");
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

        let error = start_with(LaunchRequest { worktree }, &spawner).expect_err("non-loopback");
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

        start_with(LaunchRequest { worktree }, &spawner).expect("start first session");
        assert_eq!(current_state(), SessionState::Starting);

        assert_eq!(
            start_with(
                LaunchRequest {
                    worktree: PathBuf::from("/tmp")
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
}

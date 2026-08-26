//! The one place an acceptance test learns how to start a real Godot editor.
//!
//! Five acceptance modules used to carry their own copy of this: the pinned-binary lookup, the
//! fixture worktree, the launch, the pipe drain, the ready poll, and — for the ones that stage the
//! addon — the whole [`Session`]. Two of them were byte-identical and the rest differed only in
//! which transports they asked the editor to open. They agreed until they did not: the editor
//! startup race was found once and fixed in one copy, and the copies that never learned about it
//! kept the flake.
//!
//! This module is the seam they all cross instead. What varies across it is which ports the editor
//! opens and what a suite writes into the worktree before the editor sees it; everything else is
//! the same editor, started the same way, proven ready by the same poll.
//!
//! Gated with the suites it serves, so the fast `cargo test` gate stays process-free.

use crate::addon::AddonStager;
use crate::files::Workspace;
use crate::godot_rpc::{CallRequest, RpcSession};
use crate::godot_session::{self, LogSource};
use crate::process::{ChildProcess, ProcessSpawner, SystemProcessSpawner};
use crate::protocol_v2::Readiness;
use serde_json::{Value, json};
use std::ffi::{OsStr, OsString};
use std::io::{BufRead, BufReader};
use std::net::TcpListener;
use std::path::{Path, PathBuf};

use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tempfile::TempDir;

/// The engine the repository pins. Kept in step with `scripts/godot-binary.mjs`, which reads the
/// same manifest and reports the version with dots where the release tag has a dash.
const ARTIFACTS: &str = include_str!("../../protocol/godot-artifacts.json");
/// How long the editor gets to import the project, enable the plugin, and answer as ready.
pub(crate) const READY_TIMEOUT: Duration = Duration::from_secs(90);
/// How long a command inside a ready editor gets before it counts as hung.
pub(crate) const CALL_TIMEOUT_MS: u64 = 30_000;
/// The poll while the editor is still coming up, where a refusal is the expected answer.
pub(crate) const PROBE_TIMEOUT_MS: u64 = 2_000;
/// How long the game gets to be fully gone after it was told to stop.
const STOP_TIMEOUT: Duration = Duration::from_secs(15);
/// How long an editor asked to close itself gets, matching the budget `godot_session::stop` gives
/// the real one.
const QUIT_TIMEOUT: Duration = Duration::from_secs(10);
/// What base64 PNG bytes begin with, so an icon or a frame can be checked without decoding it.
pub(crate) const PNG_BASE64_PREFIX: &str = "iVBORw0KGgo";

/// The commands that put a different scene in the editor, and so restart the revision at zero. A
/// reload is one of them: it replaces the root with the one on disk, which is a different baseline
/// even though the path did not change.
const SCENE_SWITCHES: [&str; 3] = ["scene.create", "scene.open", "scene.reload"];

/// Retries `attempt` until it answers, and gives up at the editor's ready timeout.
///
/// Every transport this repository opens to a real editor is refused for a while first: the editor
/// imports the project before the language server listens, before the debug adapter listens, and
/// before the addon connects at all. Four suites wrote that wait out by hand — same deadline, same
/// `code: message` record of the last refusal, same panic quoting the editor's output — around four
/// different calls. Only the call varies, so only the call is the caller's.
///
/// The failure is a panic rather than a `Result` because every caller is a test that cannot go on
/// without the answer, and the editor's output is the only thing that explains why it never came.
pub(crate) fn retry_until<T>(
    what: &str,
    editor: &Editor,
    every: Duration,
    mut attempt: impl FnMut() -> Result<T, String>,
) -> T {
    let deadline = Instant::now() + READY_TIMEOUT;
    let mut last = "no attempt".to_owned();
    while Instant::now() < deadline {
        match attempt() {
            Ok(answer) => return answer,
            Err(refusal) => {
                last = refusal;
                thread::sleep(every);
            }
        }
    }
    panic!("{what}: {last}\n--- editor output ---\n{}", editor.output());
}

/// How often a transport that is still coming up is asked again.
pub(crate) const RETRY_EVERY: Duration = Duration::from_millis(500);

/// A pinned Godot editor running as this test's child, with both of its pipes drained.
pub(crate) struct Editor {
    child: Box<dyn ChildProcess>,
    output: Arc<Mutex<String>>,
    /// The throwaway config home this editor was pointed at, alive for as long as the process is.
    /// See [`Launch::start`] for why every editor gets one.
    _config_home: Option<TempDir>,
}

impl Editor {
    /// Everything the editor has printed so far, so a failing assertion can quote it.
    pub(crate) fn output(&self) -> String {
        self.output
            .lock()
            .map(|output| output.clone())
            .unwrap_or_default()
    }

    /// Kills the editor outright, which is what a crash and a closed window both look like from
    /// Gofer's side: nothing is announced, because the addon goes with the process.
    pub(crate) fn kill(&mut self) {
        let _ = self.child.kill();
    }

    /// Waits for an editor that was asked to close itself to actually go.
    fn await_exit(&mut self) {
        let deadline = Instant::now() + QUIT_TIMEOUT;
        while Instant::now() < deadline {
            if matches!(self.child.try_wait(), Ok(Some(_))) {
                return;
            }
            thread::sleep(Duration::from_millis(100));
        }
        panic!(
            "the editor never closed itself\n--- editor output ---\n{}",
            self.output()
        );
    }
}

impl Drop for Editor {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn pinned_version_prefix() -> String {
    let manifest: Value = serde_json::from_str(ARTIFACTS).expect("parse Godot artifact manifest");
    manifest["version"]
        .as_str()
        .expect("manifest version")
        .replace('-', ".")
}

/// Resolves the pinned editor the same way the Node gate does: an absolute `GOFER_GODOT_BINARY`
/// wins, otherwise the pinned version is accepted from `PATH`. The version is always verified, so
/// neither route can silently accept a different engine.
pub(crate) fn pinned_editor() -> String {
    let expected = pinned_version_prefix();
    let reported = |binary: &str| {
        let arguments = [OsString::from("--version")];
        let output = SystemProcessSpawner
            .output(OsStr::new(binary), &arguments)
            .ok()?;
        output
            .status
            .success
            .then(|| String::from_utf8_lossy(&output.stdout).trim().to_owned())
    };

    if let Ok(configured) = std::env::var("GOFER_GODOT_BINARY") {
        assert!(
            Path::new(&configured).is_absolute(),
            "GOFER_GODOT_BINARY must be an absolute path"
        );
        let version = reported(&configured)
            .unwrap_or_else(|| panic!("Could not execute GOFER_GODOT_BINARY at {configured}"));
        assert!(
            version.starts_with(&expected),
            "Expected Godot {expected}, received {version}"
        );
        return configured;
    }
    for candidate in ["godot4", "godot"] {
        if reported(candidate).is_some_and(|version| version.starts_with(&expected)) {
            return candidate.to_owned();
        }
    }
    panic!(
        "Godot {expected} is required. Install it on PATH, or set GOFER_GODOT_BINARY to the \
         absolute path of the pinned binary."
    );
}

/// A loopback port nothing is listening on, for a transport this test is about to open.
///
/// Bound and released rather than picked: the kernel will not hand the same port to the next caller
/// while this one holds it, which is what stops two suites in one process choosing the same number.
pub(crate) fn free_port() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind probe listener");
    let port = listener.local_addr().expect("probe address").port();
    drop(listener);
    port
}

/// The process-wide editor binding, for exactly as long as this value is alive.
///
/// Everything that reaches an editor — the language server, the debug adapter, the addon — asks
/// `godot_session` which one is bound. A suite that binds one and clears it with a statement at the
/// end of the test clears it only when the test passes: a panic on any assertion before that leaves
/// the binding pointing at an editor that is being torn down, and every later test in the process
/// inherits it. Binding is therefore something held, not something done.
pub(crate) struct BoundEditor;

impl BoundEditor {
    /// Binds an editor the suite launched itself, at the ports it chose.
    pub(crate) fn external(lsp_port: u16, dap_port: u16, worktree: &Path) -> Self {
        godot_session::bind(Some(Arc::new(godot_session::ExternalEditor::at(
            lsp_port, dap_port, worktree,
        ))));
        Self
    }

    /// The same, reaching the addon over the session's own transport as well.
    pub(crate) fn with_rpc(
        lsp_port: u16,
        dap_port: u16,
        worktree: &Path,
        rpc: &RpcSession,
    ) -> Self {
        godot_session::bind(Some(Arc::new(
            godot_session::ExternalEditor::at(lsp_port, dap_port, worktree).with_rpc(rpc.clone()),
        )));
        Self
    }
}

impl Drop for BoundEditor {
    fn drop(&mut self) {
        godot_session::bind(None);
    }
}

/// Copies a directory tree, creating what is missing on the way.
pub(crate) fn copy_tree(source: &Path, target: &Path) {
    std::fs::create_dir_all(target).expect("create target directory");
    for entry in std::fs::read_dir(source).expect("read fixture directory") {
        let entry = entry.expect("fixture entry");
        let destination = target.join(entry.file_name());
        if entry.file_type().expect("entry type").is_dir() {
            copy_tree(&entry.path(), &destination);
        } else {
            std::fs::copy(entry.path(), &destination).expect("copy fixture file");
        }
    }
}

/// The checked-in Godot project, copied into a temporary worktree and canonicalised.
///
/// A suite that needs more than the fixture — a probe script, a broken script, an atlas — writes it
/// into the returned worktree before starting the editor, so the editor's first import scan sees
/// it. What is deliberately *not* here is any of those additions: the fixture stays free of a
/// parse error, because the Node journeys scan editor output for script errors.
pub(crate) fn fixture_worktree(directory: &TempDir) -> PathBuf {
    let worktree = directory.path().join("worktree");
    let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("fixtures")
        .join("godot-project");
    copy_tree(&fixture, &worktree);
    crate::paths::canonical(&worktree).expect("canonical worktree")
}

/// Which transports the editor should open, and whether its output feeds the session log.
///
/// One options value rather than five `launch` functions: the suites differ only in this, and a
/// sixth suite wanting a fourth combination would otherwise write a sixth copy.
pub(crate) struct Launch<'a> {
    worktree: &'a Path,
    rpc: Option<(u16, &'a str)>,
    lsp_port: Option<u16>,
    dap_port: Option<u16>,
    tee_session_logs: bool,
    config_home: Option<&'a Path>,
    launch_timeout_ms: Option<u64>,
}

impl<'a> Launch<'a> {
    /// An editor on this worktree with no transport open.
    pub(crate) fn on(worktree: &'a Path) -> Self {
        Self {
            worktree,
            rpc: None,
            lsp_port: None,
            dap_port: None,
            tee_session_logs: false,
            config_home: None,
            launch_timeout_ms: None,
        }
    }

    /// Points the editor at a config home the caller owns, rather than the throwaway one every
    /// launch gets. Only a test that stops an editor and starts another one expecting to read back
    /// what the first wrote needs this — the two have to share the directory to prove anything.
    pub(crate) fn config_home(mut self, home: &'a Path) -> Self {
        self.config_home = Some(home);
        self
    }

    /// Shortens the deadline the addon gives a launch, for the one test that has to outlive one.
    ///
    /// Left unset the editor uses the thirty seconds it ships with. A test asserting what happens
    /// *after* the deadline has to sit through it, and thirty seconds of sitting was the whole
    /// acceptance suite's floor. Four seconds proves the same thing.
    pub(crate) fn launch_timeout_ms(mut self, milliseconds: u64) -> Self {
        self.launch_timeout_ms = Some(milliseconds);
        self
    }

    /// Points the addon at a listener this test already bound, with the token it will present.
    pub(crate) fn rpc(mut self, port: u16, token: &'a str) -> Self {
        self.rpc = Some((port, token));
        self
    }

    /// Opens the editor's native language server on a known port.
    pub(crate) fn lsp(mut self, port: u16) -> Self {
        self.lsp_port = Some(port);
        self
    }

    /// Opens the editor's native debug adapter on a known port.
    pub(crate) fn dap(mut self, port: u16) -> Self {
        self.dap_port = Some(port);
        self
    }

    /// Also feeds both pipes into the session log buffer the `godot_logs` tool reads, so a turn
    /// that asks for the editor's output gets this editor's output.
    pub(crate) fn tee_session_logs(mut self) -> Self {
        self.tee_session_logs = true;
        self
    }

    /// Starts the editor and returns once the process exists — not once it is ready.
    pub(crate) fn start(self) -> Editor {
        let mut arguments = vec![
            OsString::from("--editor"),
            OsString::from("--headless"),
            OsString::from("--path"),
            self.worktree.as_os_str().to_owned(),
        ];
        if let Some(port) = self.lsp_port {
            arguments.push(OsString::from("--lsp-port"));
            arguments.push(OsString::from(port.to_string()));
        }
        if let Some(port) = self.dap_port {
            arguments.push(OsString::from("--dap-port"));
            arguments.push(OsString::from(port.to_string()));
        }
        // A debugger port of this editor's own, because the one Godot ships with is shared.
        //
        // The editor's debug server binds `network/debug/remote_port` — 6007 unless told
        // otherwise — and tells the game it plays to connect to that number. A second editor
        // playing at the same time finds 6007 taken, steps to 6008, and still sends its game to
        // 6007: the game connects to the wrong editor. Nothing errors on either side, so the
        // editor that launched it waits out its whole launch deadline on a session that never
        // becomes active.
        arguments.push(OsString::from("--debug-server"));
        arguments.push(OsString::from(format!("tcp://127.0.0.1:{}", free_port())));

        let mut environment: Vec<(OsString, OsString)> = self
            .rpc
            .map(|(port, token)| {
                vec![
                    (
                        OsString::from("GOFER_RPC_PORT"),
                        OsString::from(port.to_string()),
                    ),
                    (OsString::from("GOFER_RPC_TOKEN"), OsString::from(token)),
                ]
            })
            .unwrap_or_default();

        if let Some(milliseconds) = self.launch_timeout_ms {
            environment.push((
                OsString::from("GOFER_RUNTIME_LAUNCH_TIMEOUT_MS"),
                OsString::from(milliseconds.to_string()),
            ));
        }

        // Every editor gets a throwaway config home, because `editor.set_setting` writes to the
        // machine-wide EditorSettings the developer running this suite uses for their own work. A
        // test that set one and did not put it back would silently change their editor. The
        // engine has no flag for this; the XDG variables are what it reads on Linux, and on the
        // other platforms this is a no-op the acceptance suites do not run on.
        let owned = self.config_home.is_none();
        let temporary = owned.then(|| TempDir::new().expect("temporary editor config home"));
        let home = self
            .config_home
            .unwrap_or_else(|| temporary.as_ref().expect("temporary config home").path());
        for variable in ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME"] {
            let directory = home.join(variable.to_lowercase());
            std::fs::create_dir_all(&directory).expect("create editor config home");
            environment.push((OsString::from(variable), directory.into_os_string()));
        }

        let binary = pinned_editor();
        let mut child = SystemProcessSpawner
            .spawn_with_env(OsStr::new(&binary), &arguments, false, &environment)
            .expect("launch the pinned Godot editor");

        if self.tee_session_logs {
            godot_session::clear_logs();
        }

        // Both of the editor's streams are pipes. An unread pipe fills and stalls the editor long
        // before the addon loads, so they are drained into one buffer that a failure can quote.
        let output = Arc::new(Mutex::new(String::new()));
        for (stream, source) in [
            (child.take_stdout(), LogSource::Editor),
            (child.take_stderr(), LogSource::EditorError),
        ] {
            let Some(stream) = stream else { continue };
            let sink = Arc::clone(&output);
            let tee = self.tee_session_logs;
            thread::spawn(move || {
                let mut reader = BufReader::new(stream);
                let mut line = String::new();
                while reader.read_line(&mut line).unwrap_or(0) > 0 {
                    if tee {
                        godot_session::append_log(source, &line);
                    }
                    if let Ok(mut sink) = sink.lock() {
                        sink.push_str(&line);
                    }
                    line.clear();
                }
            });
        }
        Editor {
            child,
            output,
            _config_home: temporary,
        }
    }
}

/// What a [`Session`]'s editor should open beyond the addon's own transport.
///
/// The default is the addon alone, which is what every suite except the AI turn needs. That one
/// drives the language server and the debug adapter through the same editor, and reads the
/// editor's output back through the `godot_logs` tool, so it asks for all three.
#[derive(Default)]
pub(crate) struct Transports {
    pub(crate) lsp_port: Option<u16>,
    pub(crate) dap_port: Option<u16>,
    pub(crate) tee_session_logs: bool,
    /// Whether this editor should also be the one the process reaches through `godot_session`.
    ///
    /// A suite that drives Gofer's own commands rather than the addon directly needs that, and it
    /// needs the binding to end with the session rather than with the test body — which is why it
    /// is asked for here instead of being done by the caller afterwards.
    pub(crate) bind_editor: bool,
    /// A config home outliving this session, for a test that starts a second editor and expects it
    /// to read back what the first one wrote. Left unset, the editor gets a throwaway of its own.
    pub(crate) editor_config_home: Option<PathBuf>,
    /// A shorter launch deadline, for the one test whose subject is the deadline expiring.
    pub(crate) launch_timeout_ms: Option<u64>,
}

/// A staged addon inside a launched editor, answering over the wire the desktop app uses.
///
/// Owns the revision the edited scene is on, so a mutating command quotes the revision the addon
/// last answered with rather than one the test tracked by hand.
pub(crate) struct Session {
    rpc: RpcSession,
    editor: Editor,
    _directory: Option<TempDir>,
    stager: AddonStager,
    bound: Option<BoundEditor>,
    pub(crate) worktree: PathBuf,
    revision: u64,
}

impl Drop for Session {
    fn drop(&mut self) {
        // The binding goes first. Anything still reaching this editor through `godot_session` —
        // the language server, the debug adapter, the addon — would otherwise be pointed at
        // transports that are being torn down underneath it.
        self.bound.take();
        self.rpc.stop();
        let _ = self.stager.unstage(&self.worktree);
    }
}

impl Session {
    /// Stages the addon into a fresh copy of the fixture project, launches the editor, and waits
    /// for the addon to report that it is ready.
    pub(crate) fn start() -> Self {
        let directory = TempDir::new().expect("temporary directory");
        let worktree = fixture_worktree(&directory);
        let ledger = directory.path().join("ledger.json");
        Self::start_on_worktree(worktree, ledger, Some(directory))
    }

    /// Launches a session against a worktree the caller prepared and keeps alive, so a suite can
    /// write its own probe scripts first, or stop one session and start another against the same
    /// files to prove persistence.
    pub(crate) fn start_on_worktree(
        worktree: PathBuf,
        ledger: PathBuf,
        directory: Option<TempDir>,
    ) -> Self {
        Self::start_on_worktree_with(worktree, ledger, directory, Transports::default())
    }

    /// The same, with the editor opening more than the addon's own transport.
    pub(crate) fn start_on_worktree_with(
        worktree: PathBuf,
        ledger: PathBuf,
        directory: Option<TempDir>,
        transports: Transports,
    ) -> Self {
        let stager = AddonStager::new(ledger);
        let workspace = Workspace::open(&worktree).expect("open worktree");
        stager.stage(&workspace).expect("stage the Gofer addon");
        assert!(
            stager.staged(&worktree).expect("ledger readable"),
            "staging must record the worktree so stopping can revert it"
        );

        let listener = TcpListener::bind("127.0.0.1:0").expect("bind RPC listener");
        let port = listener.local_addr().expect("listener address").port();
        let token = "a1".repeat(32);
        let rpc = RpcSession::start(listener, token.clone(), worktree.display().to_string());
        let mut launch = Launch::on(&worktree).rpc(port, &token);
        if let Some(lsp_port) = transports.lsp_port {
            launch = launch.lsp(lsp_port);
        }
        if let Some(dap_port) = transports.dap_port {
            launch = launch.dap(dap_port);
        }
        if transports.tee_session_logs {
            launch = launch.tee_session_logs();
        }
        if let Some(home) = transports.editor_config_home.as_deref() {
            launch = launch.config_home(home);
        }
        if let Some(milliseconds) = transports.launch_timeout_ms {
            launch = launch.launch_timeout_ms(milliseconds);
        }
        let editor = launch.start();

        let mut session = Self {
            rpc,
            editor,
            _directory: directory,
            stager,
            bound: None,
            worktree,
            revision: 0,
        };
        session.await_ready();
        // Bound after the addon answers as ready, so nothing can reach this editor through
        // `godot_session` while it is still importing the project.
        if transports.bind_editor {
            session.bound = Some(BoundEditor::with_rpc(
                transports.lsp_port.unwrap_or_default(),
                transports.dap_port.unwrap_or_default(),
                &session.worktree,
                &session.rpc,
            ));
        }
        session
    }

    /// The transport, for a suite asking what the session worked out on its own reader thread.
    pub(crate) fn rpc(&self) -> &RpcSession {
        &self.rpc
    }

    /// Everything the editor has printed, so a failing assertion can quote it.
    pub(crate) fn output(&self) -> String {
        self.editor.output()
    }

    /// Kills the editor without telling the session, so a suite can prove what the transport does
    /// when the addon disappears under it.
    pub(crate) fn kill_editor(&mut self) {
        self.editor.kill();
    }

    /// Asks the editor to close itself and waits for it to go, which is what
    /// [`crate::godot_session::stop`] does before it falls back to killing. Dropping the session
    /// instead is a kill, and a kill is what loses everything the editor holds only in memory.
    pub(crate) fn quit_editor(&mut self) {
        let quitting = self.call("session.quit", json!({}));
        assert_eq!(quitting["quitting"], true, "{quitting}");
        self.editor.await_exit();
    }

    /// The revision the edited scene is on, as the addon last reported it.
    pub(crate) fn revision(&self) -> u64 {
        self.revision
    }

    /// Polls until the addon answers as ready. The editor imports the project and enables plugins
    /// before the addon connects, so early probes are expected to fail and use a short timeout.
    fn await_ready(&self) {
        // Asked twice as often as a transport that is still listening for a socket: this probe
        // carries its own short timeout, so the wait is the sleep rather than the call.
        retry_until(
            "the addon never reported a ready session",
            &self.editor,
            Duration::from_millis(250),
            || match self.request("session.get_state", json!({}), None, PROBE_TIMEOUT_MS) {
                Ok(result) if result["state"] == "ready" => Ok(()),
                Ok(result) => Err(result.to_string()),
                Err(error) => Err(error),
            },
        );
    }

    /// Polls until the editor reports the game fully gone. `runtime.stop` answers before the game
    /// process actually exits, and only the debugger session's teardown clears the helper's
    /// readiness, so assertions about the stopped state have to wait for it.
    pub(crate) fn await_stopped(&self) {
        let deadline = Instant::now() + STOP_TIMEOUT;
        while Instant::now() < deadline {
            if let Ok(state) = self.request("runtime.get_state", json!({}), None, PROBE_TIMEOUT_MS)
                && state["running"] == false
                && state["runtimeReady"] == false
            {
                return;
            }
            thread::sleep(Duration::from_millis(200));
        }
        panic!(
            "the game never stopped\n--- editor output ---\n{}",
            self.editor.output()
        );
    }

    /// Polls the session's own view of the editor until it says what is expected.
    ///
    /// This is not `runtime.get_state` asked again. It is what the transport worked out from the
    /// addon's events on its own reader thread, with nothing subscribed to it — and it is what the
    /// window's badge, the Run control and the debugger panel are all derived from. Whether it
    /// agrees with the editor is the whole question.
    pub(crate) fn await_session_view(&self, readiness: Readiness, is_playing: bool) {
        let deadline = Instant::now() + STOP_TIMEOUT;
        while Instant::now() < deadline {
            if self.rpc.readiness() == readiness && self.rpc.is_playing() == is_playing {
                return;
            }
            thread::sleep(Duration::from_millis(50));
        }
        panic!(
            "the session settled on {:?}/playing={} rather than {readiness:?}/playing={is_playing}\n--- editor output ---\n{}",
            self.rpc.readiness(),
            self.rpc.is_playing(),
            self.editor.output()
        );
    }

    fn request(
        &self,
        command: &str,
        params: Value,
        expected_revision: Option<u64>,
        timeout_ms: u64,
    ) -> Result<Value, String> {
        self.rpc
            .call(
                CallRequest::new(command, params)
                    .expecting(expected_revision)
                    .within(Some(timeout_ms)),
            )
            .map(|response| response.result)
            .map_err(|error| format!("{}: {}", error.code, error.message))
    }

    pub(crate) fn try_call(
        &self,
        command: &str,
        params: Value,
        expected_revision: Option<u64>,
    ) -> Result<Value, String> {
        self.request(command, params, expected_revision, CALL_TIMEOUT_MS)
    }

    /// Sends a command on a budget of the caller's choosing, for the operations that legitimately
    /// take longer than an ordinary call — a launch that only answers once the game has rendered.
    pub(crate) fn try_call_within(
        &self,
        command: &str,
        params: Value,
        timeout_ms: u64,
    ) -> Result<Value, String> {
        self.request(command, params, None, timeout_ms)
    }

    pub(crate) fn call(&self, command: &str, params: Value) -> Value {
        self.try_call(command, params, None)
            .unwrap_or_else(|error| panic!("{command} failed: {error}"))
    }

    /// Sends a mutating command carrying the revision the session last observed, and adopts the
    /// revision the addon reports back.
    pub(crate) fn mutate(&mut self, command: &str, params: Value) -> Value {
        let expected = self.revision;
        let response = self
            .rpc
            .call(
                CallRequest::new(command, params)
                    .expecting(Some(expected))
                    .within(Some(CALL_TIMEOUT_MS)),
            )
            .unwrap_or_else(|error| {
                panic!("{command} failed at revision {expected}: {}", error.message)
            });
        let revision = response
            .revision
            .unwrap_or_else(|| panic!("{command} answered without a revision"));
        // A scene switch rebases rather than advances: the addon answers it with revision 0 and
        // every mutation after it counts from there, because a different scene is a different
        // baseline. Only work done *inside* one scene has to move forward.
        assert!(
            revision >= expected || SCENE_SWITCHES.contains(&command),
            "{command} moved the revision backwards: {expected} -> {revision}"
        );
        self.revision = revision;
        response.result
    }

    /// Sends a mutating command the same way, but hands back the refusal instead of panicking, so
    /// a sweep over many node types can report every class that failed rather than only the first.
    /// The revision only moves on success; a refused mutation leaves the scene where it was.
    pub(crate) fn try_mutate(&mut self, command: &str, params: Value) -> Result<Value, String> {
        let expected = self.revision;
        let response = self
            .rpc
            // The id used to be `acceptance-try-{revision}-{command}`, which a sweep of failed
            // mutations at one revision repeats — and a repeated id could hand one call's reply to
            // a different waiter, because a timed-out call leaves its pending entry behind. The
            // session mints it now, so the spelling is not this harness's to get wrong.
            .call(
                CallRequest::new(command, params)
                    .expecting(Some(expected))
                    .within(Some(CALL_TIMEOUT_MS)),
            )
            .map_err(|error| format!("{}: {}", error.code, error.message))?;
        if let Some(revision) = response.revision {
            self.revision = revision;
        }
        Ok(response.result)
    }

    /// Opens a scene and adopts the revision baseline the switch answers with.
    pub(crate) fn open_scene(&mut self, path: &str) {
        let result = self.call("scene.open", json!({"path": path}));
        self.revision = result["revision"]
            .as_u64()
            .unwrap_or_else(|| panic!("scene.open answered without a revision: {result}"));
    }

    pub(crate) fn error(
        &self,
        command: &str,
        params: Value,
        expected_revision: Option<u64>,
    ) -> String {
        self.try_call(command, params, expected_revision)
            .err()
            .unwrap_or_else(|| panic!("{command} was expected to fail"))
    }
}

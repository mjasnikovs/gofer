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

use std::sync::atomic::{AtomicU16, Ordering};
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
///
/// That output is a closure rather than an `&Editor` because the one suite that most needed this
/// never holds an `Editor` value: a journey drives the supervisor's editor, and the supervisor
/// drains it into a buffer of its own. Typing the parameter to the struct excluded the only caller
/// with a different way of answering the same question, so `godot_journey_acceptance` wrote the
/// wait out by hand — the fifth copy, after the four this was extracted to replace.
pub(crate) fn retry_until<T>(
    what: &str,
    output: impl Fn() -> String,
    every: Duration,
    attempt: impl FnMut() -> Result<T, String>,
) -> T {
    retry_within(what, READY_TIMEOUT, output, every, attempt)
}

/// [`retry_until`] for a caller whose wait is not the editor's own.
///
/// A journey boots the supervisor as well as the editor, and gave itself two minutes rather than
/// the editor's ninety seconds. That is a real difference between two waits, so it is a parameter
/// — shortening it to share the helper would have been the helper changing the test.
pub(crate) fn retry_within<T>(
    what: &str,
    within: Duration,
    output: impl Fn() -> String,
    every: Duration,
    mut attempt: impl FnMut() -> Result<T, String>,
) -> T {
    let deadline = Instant::now() + within;
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
    panic!("{what}: {last}\n--- editor output ---\n{}", output());
}

/// The names of a scene root's children, in the order the tree reports them.
///
/// Two suites had this, differing only in what they said when the tree carried no children at all.
/// The one that quoted the tree is the one kept: an assertion that fails here has been handed a
/// shape nobody expected, and the shape is the whole of the evidence.
pub(crate) fn child_names(tree: &serde_json::Value) -> Vec<String> {
    tree["root"]["children"]
        .as_array()
        .unwrap_or_else(|| panic!("a scene tree must carry children: {tree}"))
        .iter()
        .map(|child| child["name"].as_str().expect("child name").to_owned())
        .collect()
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

/// The first port of the band this editor's debug server is dealt out of.
///
/// Below Linux's ephemeral range, so nothing a `bind("127.0.0.1:0")` probe returns is ever in it.
const DEBUG_PORT_BASE: u16 = 20_000;
/// How many live editors one acceptance worker can hold before its lane wraps.
const DEBUG_PORTS_PER_WORKER: u16 = 64;

/// A loopback port for this editor's debug server.
///
/// Dealt rather than probed, because [`free_port`] cannot help here. That probe releases its
/// socket, and the only thing stopping the kernel handing the same number to the next caller is
/// somebody holding it. Every other transport is bound within a second of the probe. This one is
/// bound by Godot's debug server the first time somebody presses play — seconds later, or never —
/// so between probe and bind the number is free for a second test process to be handed, and the
/// collision this port exists to prevent comes straight back.
///
/// So each acceptance worker gets a lane of its own instead. `GOFER_GODOT_WORKER` is its index,
/// set by `scripts/godot-acceptance.mjs`; a run without that variable is one process, and the
/// counter alone keeps its editors apart.
pub(crate) fn debug_port() -> u16 {
    static NEXT: AtomicU16 = AtomicU16::new(0);
    let worker = std::env::var("GOFER_GODOT_WORKER")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(0)
        % 128;
    let slot = NEXT.fetch_add(1, Ordering::Relaxed) % DEBUG_PORTS_PER_WORKER;
    DEBUG_PORT_BASE + worker * DEBUG_PORTS_PER_WORKER + slot
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
///
/// **The addon is dropped, and the reason is a second suite.** `scripts/godot-test.mjs` copies
/// `protocol.gd` and `params.gd` into `fixtures/godot-project/addons/gofer` for the length of its
/// run and removes them afterwards — GDScript resolves a `preload` against `res://` at parse time,
/// so the two have to sit where the shipped addon sits before either can be loaded at all. That
/// directory is this function's source, so a run that copies it while those seconds are passing
/// gets half an addon nothing here staged, and the staging that follows refuses it:
/// `addon_unmanaged: addons/gofer exists but was not installed by Gofer`. One live turn died that
/// way, five seconds in.
///
/// `npm run check` cannot reach it — its Godot lane runs both suites one after the other — and a
/// developer running `npm run test:godot` beside a live turn can. A worktree must hold the addon
/// this run staged and never one another suite left lying about, so it starts with none.
pub(crate) fn fixture_worktree(directory: &TempDir) -> PathBuf {
    let worktree = directory.path().join("worktree");
    let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("fixtures")
        .join("godot-project");
    copy_tree(&fixture, &worktree);
    without_a_foreign_addon(&worktree);
    crate::paths::canonical(&worktree).expect("canonical worktree")
}

/// Takes away an addon this run did not stage, leaving everything else where it is.
///
/// Split out of [`fixture_worktree`] so the rule can be stated against a directory that actually
/// holds one — the fixture in git does not, and a check that passes because the source happens to
/// be clean is not a check.
fn without_a_foreign_addon(worktree: &std::path::Path) {
    let _ = std::fs::remove_dir_all(worktree.join("addons"));
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
    request_timeout_ms: Option<u64>,
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
            request_timeout_ms: None,
        }
    }

    /// Points the editor at a config home the caller owns, rather than the throwaway one every
    /// launch gets. Only a test that stops an editor and starts another one expecting to read back
    /// what the first wrote needs this — the two have to share the directory to prove anything.
    pub(crate) fn config_home(mut self, home: &'a Path) -> Self {
        self.config_home = Some(home);
        self
    }

    /// Shortens the deadline the addon gives a forwarded *request*, which is twenty seconds.
    ///
    /// For a test that has to watch one expire: `input`, `capture` and `wait` cannot answer until
    /// the game draws a frame, and a game that never will spends the whole deadline. Waiting it out
    /// is the entire cost of that test, and four seconds proves the same thing.
    pub(crate) fn request_timeout_ms(mut self, milliseconds: u64) -> Self {
        self.request_timeout_ms = Some(milliseconds);
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
        if let Some(milliseconds) = self.request_timeout_ms {
            environment.push((
                OsString::from("GOFER_RUNTIME_REQUEST_TIMEOUT_MS"),
                OsString::from(milliseconds.to_string()),
            ));
        }

        environment.push((
            OsString::from("GOFER_DEBUG_PORT"),
            OsString::from(debug_port().to_string()),
        ));

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
    /// The forwarded-request deadline, for a suite that has to watch one expire.
    pub(crate) request_timeout_ms: Option<u64>,
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
        if let Some(milliseconds) = transports.request_timeout_ms {
            launch = launch.request_timeout_ms(milliseconds);
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
        retry_until(
            "the addon never reported a ready session",
            || self.editor.output(),
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

#[cfg(test)]
mod tests {
    use super::*;

    /// A worktree holds the addon its own run staged, never one another suite left in the fixture.
    ///
    /// `scripts/godot-test.mjs` copies `protocol.gd` and `params.gd` into
    /// `fixtures/godot-project/addons/gofer` for the length of its run — GDScript resolves a
    /// `preload` against `res://` at parse time, so they have to sit where the shipped addon sits.
    /// That directory is [`fixture_worktree`]'s source. A live turn copied it mid-run and died five
    /// seconds later on `addon_unmanaged: addons/gofer exists but was not installed by Gofer`.
    #[test]
    fn a_worktree_starts_with_no_addon_but_its_own() {
        let directory = TempDir::new().expect("temporary directory");
        let worktree = directory.path().join("worktree");
        let left_behind = worktree.join("addons").join("gofer");
        std::fs::create_dir_all(&left_behind).expect("another suite's staged addon");
        std::fs::write(left_behind.join("params.gd"), "extends Node\n").expect("its half");
        std::fs::write(worktree.join("project.godot"), "config_version=5\n").expect("the project");

        without_a_foreign_addon(&worktree);

        assert!(
            !worktree.join("addons").exists(),
            "an addon this run did not stage must not survive into the worktree"
        );
        assert!(
            worktree.join("project.godot").exists(),
            "and nothing else may go with it"
        );
    }
}

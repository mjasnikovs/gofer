//! Deterministic GDScript formatting through the pinned gdformat sidecar.
//!
//! gdtoolkit is pinned at 4.5.0 — the newest release (2025-10-09), whose changelog stops at
//! 4.5-era grammar. The pin was proven against the Godot 4.7 fixture scripts before adoption:
//! every fixture parses, the formatter's own output is idempotent, and invalid syntax exits
//! non-zero without producing output. The proof fixture and procedure live in
//! `fixtures/gdformat/`.
//!
//! Upstream publishes only wheels and sdists, so the sidecar is a frozen per-platform executable
//! built in CI and shipped as a bundled resource. During development `GOFER_GDFORMAT` points at
//! any local gdformat 4.5.0 binary. A missing or wrong-version binary yields
//! `formatter_unavailable`: formatting is the one feature allowed to ship disabled.
//!
//! The formatter only ever sees the buffer through stdin (`gdformat -`) and its stdout is
//! captured — it never touches the source file. The caller diffs the result and applies it
//! through an explicit workspace write, so a formatter failure provably leaves the buffer
//! untouched.

use crate::process::{ProcessSpawner, ProcessStatus};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::ffi::{OsStr, OsString};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver};
use std::thread;
use std::time::{Duration, Instant};

/// The only gdtoolkit release Gofer accepts. Anything else is reported as unavailable rather
/// than risking a grammar drift that corrupts buffers.
pub const PINNED_VERSION: &str = "4.5.0";
/// Development/CI seam for pointing at a locally built gdformat executable.
pub const ENV_OVERRIDE: &str = "GOFER_GDFORMAT";
/// Matches the protocol v2 JSON payload cap: a script buffer larger than this is rejected
/// before the sidecar is even spawned.
pub const MAX_SOURCE_BYTES: usize = 1024 * 1024;
/// Formatting cannot legitimately quadruple a buffer; a larger stdout means a broken sidecar.
const MAX_OUTPUT_BYTES: usize = 4 * 1024 * 1024;
/// gdformat is single-pass and fast; a run longer than this is hung, not busy.
const FORMAT_TIMEOUT: Duration = Duration::from_secs(30);
const VERSION_TIMEOUT: Duration = Duration::from_secs(10);
const POLL_INTERVAL: Duration = Duration::from_millis(10);

#[cfg(windows)]
fn binary_name() -> &'static str {
    "gdformat.exe"
}

#[cfg(not(windows))]
fn binary_name() -> &'static str {
    "gdformat"
}

/// A structured, actionable formatter failure.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GdformatError {
    pub code: &'static str,
    pub message: String,
    pub retryable: bool,
    pub details: Value,
}

impl GdformatError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            retryable: false,
            details: json!({}),
        }
    }

    fn retryable(mut self) -> Self {
        self.retryable = true;
        self
    }

    fn with_details(mut self, details: Value) -> Self {
        self.details = details;
        self
    }
}

/// The buffer the renderer or the AI agent wants formatted.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FormatRequest {
    pub source: String,
}

/// The formatted buffer. `changed` lets the caller skip the diff/apply flow entirely when the
/// formatter found nothing to do.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FormatResponse {
    pub formatted: String,
    pub changed: bool,
}

/// Resolves the sidecar binary: the `GOFER_GDFORMAT` override wins, then the bundled resource
/// directory. There is deliberately no PATH search — a user-installed gdformat would bypass the
/// pin. When nothing resolves the feature reports itself disabled.
pub fn resolve(
    override_path: Option<OsString>,
    resource_dir: Option<PathBuf>,
) -> Result<PathBuf, GdformatError> {
    if let Some(path) = override_path {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Ok(path);
        }
        return Err(GdformatError::new(
            "formatter_unavailable",
            format!(
                "The {} override does not point at a file: {}",
                ENV_OVERRIDE,
                path.display()
            ),
        )
        .with_details(json!({"override": ENV_OVERRIDE, "path": path.display().to_string()})));
    }
    if let Some(directory) = resource_dir {
        let bundled = directory.join(binary_name());
        if bundled.is_file() {
            return Ok(bundled);
        }
    }
    Err(GdformatError::new(
        "formatter_unavailable",
        "Formatting is disabled: no bundled gdformat sidecar was found",
    )
    .with_details(json!({"expectedVersion": PINNED_VERSION, "override": ENV_OVERRIDE})))
}

/// Proves the resolved binary is the pinned release before any buffer is entrusted to it.
pub fn verify_version(spawner: &dyn ProcessSpawner, binary: &Path) -> Result<(), GdformatError> {
    let output = run(
        spawner,
        binary.as_os_str(),
        &[OsString::from("--version")],
        None,
        VERSION_TIMEOUT,
    )?;
    if !output.status.success {
        return Err(unavailable(binary, "did not answer --version"));
    }
    let version = parse_version(&output.stdout).ok_or_else(|| {
        unavailable(binary, "reported an unparseable version").with_details(json!({
            "stdout": String::from_utf8_lossy(&output.stdout).into_owned(),
        }))
    })?;
    if version != PINNED_VERSION {
        return Err(
            unavailable(binary, "is not the pinned release").with_details(json!({
                "expectedVersion": PINNED_VERSION,
                "actualVersion": version,
            })),
        );
    }
    Ok(())
}

fn unavailable(binary: &Path, reason: &str) -> GdformatError {
    GdformatError::new(
        "formatter_unavailable",
        format!("Formatting is disabled: the gdformat sidecar {reason}"),
    )
    .with_details(json!({
        "binary": binary.display().to_string(),
        "expectedVersion": PINNED_VERSION,
    }))
}

/// Parses the `gdformat X.Y.Z` banner into its version token.
fn parse_version(stdout: &[u8]) -> Option<String> {
    let text = std::str::from_utf8(stdout).ok()?;
    let line = text.lines().next()?.trim();
    let version = line.strip_prefix("gdformat ")?;
    let version = version.trim();
    if version.is_empty() {
        return None;
    }
    Some(version.to_owned())
}

/// Formats a buffer. The result is returned to the caller for diffing; applying it is a
/// separate, explicit write, so a failure here can never mutate the source.
pub fn format_source(
    spawner: &dyn ProcessSpawner,
    binary: &Path,
    source: &str,
) -> Result<FormatResponse, GdformatError> {
    if source.len() > MAX_SOURCE_BYTES {
        return Err(GdformatError::new(
            "payload_too_large",
            format!(
                "The script buffer is {} bytes; the formatter accepts at most {} bytes",
                source.len(),
                MAX_SOURCE_BYTES
            ),
        )
        .with_details(json!({"limitBytes": MAX_SOURCE_BYTES, "actualBytes": source.len()})));
    }
    let output = run(
        spawner,
        binary.as_os_str(),
        &[OsString::from("-")],
        Some(source.as_bytes().to_vec()),
        FORMAT_TIMEOUT,
    )?;
    if !output.status.success {
        return Err(GdformatError::new(
            "formatter_failed",
            "gdformat rejected the buffer; it was left unchanged",
        )
        .with_details(json!({
            "exitCode": output.status.code,
            "diagnostics": output.stderr,
        })));
    }
    let formatted = String::from_utf8(output.stdout).map_err(|_| {
        GdformatError::new(
            "invalid_output",
            "gdformat produced output that is not valid UTF-8; the buffer was left unchanged",
        )
    })?;
    Ok(FormatResponse {
        changed: formatted != source,
        formatted,
    })
}

#[derive(Debug)]
struct RunOutput {
    status: ProcessStatus,
    stdout: Vec<u8>,
    stderr: String,
}

enum StreamEvent {
    Stdout(io::Result<Vec<u8>>),
    Stderr(io::Result<Vec<u8>>),
}

/// Runs the sidecar with stdin/stdout plumbing and a hard deadline. Both streams are drained on
/// their own threads so a chatty child cannot deadlock on a full pipe, and a hung child is
/// killed rather than awaited forever.
fn run(
    spawner: &dyn ProcessSpawner,
    binary: &OsStr,
    arguments: &[OsString],
    input: Option<Vec<u8>>,
    timeout: Duration,
) -> Result<RunOutput, GdformatError> {
    let mut child = spawner
        .spawn(binary, arguments, input.is_some())
        .map_err(|error| {
            GdformatError::new(
                "formatter_spawn_failed",
                format!("The gdformat sidecar could not be started: {error}"),
            )
            .with_details(json!({"binary": binary.to_string_lossy().into_owned()}))
        })?;
    let (sender, receiver) = mpsc::channel();
    if let Some(bytes) = input {
        let mut stdin = match child.take_stdin() {
            Some(stdin) => stdin,
            None => {
                let _ = child.kill();
                return Err(GdformatError::new(
                    "formatter_spawn_failed",
                    "The gdformat sidecar stdin is missing",
                ));
            }
        };
        thread::spawn(move || {
            // A broken pipe just means the formatter rejected the input and exited early; the
            // exit status below carries the real verdict.
            let _ = stdin.write_all(&bytes);
        });
    }
    spawn_reader(child.take_stdout(), sender.clone(), StreamEvent::Stdout);
    spawn_reader(child.take_stderr(), sender, StreamEvent::Stderr);
    let status = wait_with_deadline(child.as_mut(), timeout)?;
    collect(receiver, status)
}

fn spawn_reader(
    stream: Option<crate::process::ProcessReader>,
    sender: mpsc::Sender<StreamEvent>,
    wrap: fn(io::Result<Vec<u8>>) -> StreamEvent,
) {
    let Some(mut stream) = stream else { return };
    thread::spawn(move || {
        let result = read_capped(&mut stream, MAX_OUTPUT_BYTES);
        let _ = sender.send(wrap(result));
    });
}

fn read_capped(stream: &mut dyn Read, cap: usize) -> io::Result<Vec<u8>> {
    let mut buffer = Vec::new();
    let mut chunk = [0_u8; 8192];
    loop {
        let read = stream.read(&mut chunk)?;
        if read == 0 {
            return Ok(buffer);
        }
        buffer.extend_from_slice(&chunk[..read]);
        if buffer.len() > cap {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "the sidecar produced more output than the cap allows",
            ));
        }
    }
}

fn wait_with_deadline(
    child: &mut dyn crate::process::ChildProcess,
    timeout: Duration,
) -> Result<ProcessStatus, GdformatError> {
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status),
            Ok(None) => {}
            Err(error) => {
                return Err(GdformatError::new(
                    "formatter_spawn_failed",
                    format!("The gdformat sidecar could not be monitored: {error}"),
                ));
            }
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(GdformatError::new(
                "formatter_timeout",
                "gdformat did not finish in time; the buffer was left unchanged",
            )
            .retryable());
        }
        thread::sleep(POLL_INTERVAL);
    }
}

fn collect(
    receiver: Receiver<StreamEvent>,
    status: ProcessStatus,
) -> Result<RunOutput, GdformatError> {
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    // The child has exited, so both pipes are closed and the reader threads deliver exactly one
    // event each; a missing event means the stream was never piped, which the empty default
    // already represents.
    for _ in 0..2 {
        match receiver.recv_timeout(POLL_INTERVAL * 100) {
            Ok(StreamEvent::Stdout(Ok(bytes))) => stdout = bytes,
            Ok(StreamEvent::Stderr(Ok(bytes))) => stderr = bytes,
            Ok(StreamEvent::Stdout(Err(error))) | Ok(StreamEvent::Stderr(Err(error))) => {
                return Err(GdformatError::new(
                    "invalid_output",
                    format!("The gdformat sidecar output could not be read: {error}"),
                ));
            }
            Err(_) => break,
        }
    }
    Ok(RunOutput {
        status,
        stdout,
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::process::{ChildProcess, ProcessReader, ProcessWriter};
    use std::io::Cursor;
    use std::sync::{Arc, Mutex};

    struct FakeChild {
        stdin: Option<ProcessWriter>,
        stdout: Option<ProcessReader>,
        stderr: Option<ProcessReader>,
        status: ProcessStatus,
        exits: bool,
        killed: bool,
    }

    impl ChildProcess for FakeChild {
        fn take_stdin(&mut self) -> Option<ProcessWriter> {
            self.stdin.take()
        }

        fn take_stdout(&mut self) -> Option<ProcessReader> {
            self.stdout.take()
        }

        fn take_stderr(&mut self) -> Option<ProcessReader> {
            self.stderr.take()
        }

        fn try_wait(&mut self) -> io::Result<Option<ProcessStatus>> {
            if self.exits || self.killed {
                return Ok(Some(self.status.clone()));
            }
            Ok(None)
        }

        fn wait(&mut self) -> io::Result<ProcessStatus> {
            Ok(self.status.clone())
        }

        fn kill(&mut self) -> io::Result<()> {
            self.killed = true;
            Ok(())
        }
    }

    #[derive(Default)]
    struct FakeSpawner {
        child: Mutex<Option<FakeChild>>,
        spawn_error: Option<io::ErrorKind>,
    }

    impl ProcessSpawner for FakeSpawner {
        fn output(
            &self,
            _program: &OsStr,
            _arguments: &[OsString],
        ) -> io::Result<crate::process::ProcessOutput> {
            unreachable!("the formatter runs through spawn so stdin can be piped")
        }

        fn spawn(
            &self,
            _program: &OsStr,
            _arguments: &[OsString],
            _piped_stdin: bool,
        ) -> io::Result<Box<dyn ChildProcess>> {
            if let Some(kind) = self.spawn_error {
                return Err(io::Error::new(kind, "spawn refused by the test double"));
            }
            self.child
                .lock()
                .expect("fake child lock")
                .take()
                .map(|child| Box::new(child) as Box<dyn ChildProcess>)
                .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "no scripted child"))
        }
    }

    fn success() -> ProcessStatus {
        ProcessStatus {
            success: true,
            code: Some(0),
            description: "exit status: 0".to_owned(),
        }
    }

    fn failure() -> ProcessStatus {
        ProcessStatus {
            success: false,
            code: Some(1),
            description: "exit status: 1".to_owned(),
        }
    }

    fn child(
        stdout: &[u8],
        stderr: &[u8],
        status: ProcessStatus,
    ) -> (FakeChild, Arc<Mutex<Vec<u8>>>) {
        let written = Arc::new(Mutex::new(Vec::new()));
        (
            FakeChild {
                stdin: Some(Box::new(RecordingWriter(Arc::clone(&written)))),
                stdout: Some(Box::new(Cursor::new(stdout.to_vec()))),
                stderr: Some(Box::new(Cursor::new(stderr.to_vec()))),
                status,
                exits: true,
                killed: false,
            },
            written,
        )
    }

    struct RecordingWriter(Arc<Mutex<Vec<u8>>>);

    impl Write for RecordingWriter {
        fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
            self.0
                .lock()
                .expect("recording lock")
                .extend_from_slice(buffer);
            Ok(buffer.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    fn binary() -> PathBuf {
        PathBuf::from("/sidecar/gdformat")
    }

    #[test]
    fn resolve_prefers_the_override() {
        let directory = tempfile::TempDir::new().expect("temp directory");
        let path = directory.path().join("gdformat-local");
        std::fs::write(&path, b"binary").expect("write fake binary");
        let resolved =
            resolve(Some(path.clone().into_os_string()), None).expect("resolve override");
        assert_eq!(resolved, path);
    }

    #[test]
    fn resolve_rejects_a_missing_override() {
        let missing = PathBuf::from("/definitely/missing/gdformat");
        let error = resolve(Some(missing.clone().into_os_string()), None)
            .expect_err("missing override must fail");
        assert_eq!(error.code, "formatter_unavailable");
        assert!(!error.retryable);
        assert_eq!(error.details["path"], json!(missing.display().to_string()));
    }

    #[test]
    fn resolve_falls_back_to_the_bundled_resource() {
        let directory = tempfile::TempDir::new().expect("temp directory");
        std::fs::write(directory.path().join(binary_name()), b"binary").expect("write fake binary");
        let resolved =
            resolve(None, Some(directory.path().to_path_buf())).expect("resolve bundled resource");
        assert_eq!(resolved, directory.path().join(binary_name()));
    }

    #[test]
    fn resolve_reports_disabled_when_nothing_exists() {
        let directory = tempfile::TempDir::new().expect("temp directory");
        let error = resolve(None, Some(directory.path().to_path_buf()))
            .expect_err("empty resource directory must fail");
        assert_eq!(error.code, "formatter_unavailable");
        assert_eq!(error.details["expectedVersion"], json!(PINNED_VERSION));
        let error = resolve(None, None).expect_err("no resource directory must fail");
        assert_eq!(error.code, "formatter_unavailable");
    }

    #[test]
    fn verify_version_accepts_the_pinned_release() {
        let (fake, _) = child(b"gdformat 4.5.0\n", b"", success());
        let spawner = FakeSpawner {
            child: Mutex::new(Some(fake)),
            spawn_error: None,
        };
        verify_version(&spawner, &binary()).expect("pinned version must verify");
    }

    #[test]
    fn verify_version_rejects_other_releases() {
        let (fake, _) = child(b"gdformat 4.4.1\n", b"", success());
        let spawner = FakeSpawner {
            child: Mutex::new(Some(fake)),
            spawn_error: None,
        };
        let error = verify_version(&spawner, &binary()).expect_err("wrong version must fail");
        assert_eq!(error.code, "formatter_unavailable");
        assert_eq!(error.details["expectedVersion"], json!("4.5.0"));
        assert_eq!(error.details["actualVersion"], json!("4.4.1"));
    }

    #[test]
    fn verify_version_rejects_unparseable_banners() {
        for banner in [
            b"garbage\n".as_slice(),
            b"gdformat \n".as_slice(),
            &[0xff, 0xfe],
        ] {
            let (fake, _) = child(banner, b"", success());
            let spawner = FakeSpawner {
                child: Mutex::new(Some(fake)),
                spawn_error: None,
            };
            let error = verify_version(&spawner, &binary()).expect_err("bad banner must fail");
            assert_eq!(error.code, "formatter_unavailable");
        }
    }

    #[test]
    fn verify_version_rejects_a_failing_probe() {
        let (fake, _) = child(b"", b"traceback", failure());
        let spawner = FakeSpawner {
            child: Mutex::new(Some(fake)),
            spawn_error: None,
        };
        let error = verify_version(&spawner, &binary()).expect_err("failing probe must fail");
        assert_eq!(error.code, "formatter_unavailable");
    }

    #[test]
    fn format_pipes_the_buffer_and_reports_changes() {
        let source = "func f():\n    pass\n";
        let formatted = "func f():\n\tpass\n";
        let (fake, written) = child(formatted.as_bytes(), b"", success());
        let spawner = FakeSpawner {
            child: Mutex::new(Some(fake)),
            spawn_error: None,
        };
        let response = format_source(&spawner, &binary(), source).expect("format");
        assert!(response.changed);
        assert_eq!(response.formatted, formatted);
        // The formatter saw exactly the buffer through stdin and nothing else.
        assert_eq!(
            written.lock().expect("written lock").as_slice(),
            source.as_bytes()
        );
    }

    #[test]
    fn format_reports_an_unchanged_buffer() {
        let source = "func f():\n\tpass\n";
        let (fake, _) = child(source.as_bytes(), b"", success());
        let spawner = FakeSpawner {
            child: Mutex::new(Some(fake)),
            spawn_error: None,
        };
        let response = format_source(&spawner, &binary(), source).expect("format");
        assert!(!response.changed);
        assert_eq!(response.formatted, source);
    }

    #[test]
    fn format_surfaces_syntax_errors_without_mutating() {
        let diagnostics = "Unexpected token Token('COLON', ':') at line 1, column 13.";
        let (fake, _) = child(b"", diagnostics.as_bytes(), failure());
        let spawner = FakeSpawner {
            child: Mutex::new(Some(fake)),
            spawn_error: None,
        };
        let error = format_source(&spawner, &binary(), "func broken(:\n")
            .expect_err("invalid syntax must fail");
        assert_eq!(error.code, "formatter_failed");
        assert!(!error.retryable);
        assert_eq!(error.details["exitCode"], json!(1));
        assert_eq!(error.details["diagnostics"], json!(diagnostics));
    }

    #[test]
    fn format_rejects_oversized_buffers_before_spawning() {
        let spawner = FakeSpawner::default();
        let source = "pass\n".repeat(MAX_SOURCE_BYTES);
        let error = format_source(&spawner, &binary(), &source).expect_err("oversized must fail");
        assert_eq!(error.code, "payload_too_large");
        assert!(!error.retryable);
    }

    #[test]
    fn format_rejects_non_utf8_output() {
        let (fake, _) = child(&[0xff, 0xfe, 0xfd], b"", success());
        let spawner = FakeSpawner {
            child: Mutex::new(Some(fake)),
            spawn_error: None,
        };
        let error = format_source(&spawner, &binary(), "pass\n").expect_err("bad output must fail");
        assert_eq!(error.code, "invalid_output");
    }

    #[test]
    fn format_rejects_oversized_output() {
        let stdout = vec![b'x'; MAX_OUTPUT_BYTES + 1];
        let (fake, _) = child(&stdout, b"", success());
        let spawner = FakeSpawner {
            child: Mutex::new(Some(fake)),
            spawn_error: None,
        };
        let error =
            format_source(&spawner, &binary(), "pass\n").expect_err("oversized output must fail");
        assert_eq!(error.code, "invalid_output");
    }

    #[test]
    fn format_kills_a_hung_formatter() {
        let fake = FakeChild {
            stdin: Some(Box::new(RecordingWriter(Arc::new(Mutex::new(Vec::new()))))),
            stdout: Some(Box::new(Cursor::new(Vec::new()))),
            stderr: Some(Box::new(Cursor::new(Vec::new()))),
            status: failure(),
            exits: false,
            killed: false,
        };
        let spawner = FakeSpawner {
            child: Mutex::new(Some(fake)),
            spawn_error: None,
        };
        let started = Instant::now();
        let error = run(
            &spawner,
            binary().as_os_str(),
            &[OsString::from("-")],
            Some(b"pass\n".to_vec()),
            Duration::from_millis(50),
        )
        .expect_err("a hung formatter must time out");
        assert_eq!(error.code, "formatter_timeout");
        assert!(error.retryable);
        assert!(started.elapsed() < FORMAT_TIMEOUT);
    }

    #[test]
    fn format_reports_spawn_failures() {
        let spawner = FakeSpawner {
            child: Mutex::new(None),
            spawn_error: Some(io::ErrorKind::PermissionDenied),
        };
        let error =
            format_source(&spawner, &binary(), "pass\n").expect_err("spawn failure must fail");
        assert_eq!(error.code, "formatter_spawn_failed");
        assert!(!error.retryable);
    }

    #[test]
    fn parse_version_trims_the_banner() {
        assert_eq!(parse_version(b"gdformat 4.5.0\n"), Some("4.5.0".to_owned()));
        assert_eq!(parse_version(b"gdformat 4.5.0"), Some("4.5.0".to_owned()));
        assert_eq!(parse_version(b"gdformat\n"), None);
        assert_eq!(parse_version(b""), None);
    }
}

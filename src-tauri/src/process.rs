use std::ffi::{OsStr, OsString};
use std::io::{self, Read, Write};
use std::process::{Child, Command, Stdio};

pub type ProcessReader = Box<dyn Read + Send>;
pub type ProcessWriter = Box<dyn Write + Send>;

#[derive(Clone, Debug, PartialEq)]
pub struct ProcessStatus {
    pub success: bool,
    pub code: Option<i32>,
    pub description: String,
}

pub struct ProcessOutput {
    pub status: ProcessStatus,
    pub stdout: Vec<u8>,
}

pub trait ChildProcess: Send {
    fn take_stdin(&mut self) -> Option<ProcessWriter>;
    fn take_stdout(&mut self) -> Option<ProcessReader>;
    fn take_stderr(&mut self) -> Option<ProcessReader>;
    fn try_wait(&mut self) -> io::Result<Option<ProcessStatus>>;
    fn wait(&mut self) -> io::Result<ProcessStatus>;
    fn kill(&mut self) -> io::Result<()>;
}

pub trait ProcessSpawner: Send + Sync {
    fn output(&self, program: &OsStr, arguments: &[OsString]) -> io::Result<ProcessOutput>;
    fn spawn(
        &self,
        program: &OsStr,
        arguments: &[OsString],
        piped_stdin: bool,
    ) -> io::Result<Box<dyn ChildProcess>>;

    /// Like [`spawn`], but with additional environment variables set for the child only.
    fn spawn_with_env(
        &self,
        program: &OsStr,
        arguments: &[OsString],
        piped_stdin: bool,
        env: &[(OsString, OsString)],
    ) -> io::Result<Box<dyn ChildProcess>> {
        let _ = env;
        self.spawn(program, arguments, piped_stdin)
    }
}

#[derive(Clone, Copy)]
pub struct SystemProcessSpawner;

impl ProcessSpawner for SystemProcessSpawner {
    fn output(&self, program: &OsStr, arguments: &[OsString]) -> io::Result<ProcessOutput> {
        let output = Command::new(program).args(arguments).output()?;
        Ok(ProcessOutput {
            status: status(output.status),
            stdout: output.stdout,
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
        program: &OsStr,
        arguments: &[OsString],
        piped_stdin: bool,
        env: &[(OsString, OsString)],
    ) -> io::Result<Box<dyn ChildProcess>> {
        let stdin = if piped_stdin {
            Stdio::piped()
        } else {
            Stdio::null()
        };
        let mut command = Command::new(program);
        command
            .args(arguments)
            .stdin(stdin)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for (key, value) in env {
            command.env(key, value);
        }
        let child = command.spawn()?;
        Ok(Box::new(SystemChildProcess(child)))
    }
}

struct SystemChildProcess(Child);

impl ChildProcess for SystemChildProcess {
    fn take_stdin(&mut self) -> Option<ProcessWriter> {
        self.0
            .stdin
            .take()
            .map(|stream| Box::new(stream) as ProcessWriter)
    }

    fn take_stdout(&mut self) -> Option<ProcessReader> {
        self.0
            .stdout
            .take()
            .map(|stream| Box::new(stream) as ProcessReader)
    }

    fn take_stderr(&mut self) -> Option<ProcessReader> {
        self.0
            .stderr
            .take()
            .map(|stream| Box::new(stream) as ProcessReader)
    }

    fn try_wait(&mut self) -> io::Result<Option<ProcessStatus>> {
        self.0.try_wait().map(|value| value.map(status))
    }

    fn wait(&mut self) -> io::Result<ProcessStatus> {
        self.0.wait().map(status)
    }

    fn kill(&mut self) -> io::Result<()> {
        self.0.kill()
    }
}

fn status(status: std::process::ExitStatus) -> ProcessStatus {
    ProcessStatus {
        success: status.success(),
        code: status.code(),
        description: status.to_string(),
    }
}

/// Scripted stand-ins for a real child process, shared by every module that spawns one.
///
/// They live beside the trait rather than inside one module's test file because three modules drive
/// a child — the agent turn, the retrieval sidecar, the editor supervisor — and a fake only one of
/// them can reach is a fake the other two rewrite.
#[cfg(test)]
mod fakes {
    use super::*;
    use std::io::{self, Cursor};
    use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};
    use std::sync::{Arc, Mutex};

    pub(crate) struct FakeProcessSpawner {
        pub(crate) child: Mutex<Option<FakeChildProcess>>,
        pub(crate) fail_spawn: bool,
        /// Everything the backend wrote to the worker: the startup context, then one line per
        /// answered tool call.
        pub(crate) written: Arc<Mutex<Vec<u8>>>,
    }

    /// A stdin pipe the test can read back. `Cursor` would swallow the writes it exists to prove.
    pub(crate) struct SharedWriter(Arc<Mutex<Vec<u8>>>);

    impl Write for SharedWriter {
        fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
            self.0
                .lock()
                .map_err(|_| io::Error::other("fake stdin lock poisoned"))?
                .extend_from_slice(buffer);
            Ok(buffer.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    impl FakeProcessSpawner {
        pub(crate) fn new(stdout: &str, stderr: &str, success: bool) -> Self {
            let written = Arc::new(Mutex::new(Vec::new()));
            Self {
                child: Mutex::new(Some(FakeChildProcess {
                    stdin: Some(Box::new(SharedWriter(Arc::clone(&written)))),
                    stdout: Some(Box::new(Cursor::new(stdout.as_bytes().to_vec()))),
                    stderr: Some(Box::new(Cursor::new(stderr.as_bytes().to_vec()))),
                    status: ProcessStatus {
                        success,
                        code: Some(if success { 0 } else { 1 }),
                        description: if success {
                            "exit status: 0"
                        } else {
                            "exit status: 1"
                        }
                        .to_owned(),
                    },
                    killed: Arc::new(AtomicBool::new(false)),
                })),
                fail_spawn: false,
                written,
            }
        }

        /// The lines the backend sent the worker, decoded.
        pub(crate) fn sent(&self) -> Vec<serde_json::Value> {
            let written = self.written.lock().expect("fake stdin lock");
            String::from_utf8_lossy(&written)
                .lines()
                .filter(|line| !line.is_empty())
                .map(|line| serde_json::from_str(line).expect("worker input line is NDJSON"))
                .collect()
        }
    }

    impl ProcessSpawner for FakeProcessSpawner {
        fn output(&self, _: &OsStr, _: &[OsString]) -> io::Result<ProcessOutput> {
            unreachable!("Node worker tests do not request command output")
        }

        fn spawn(&self, _: &OsStr, _: &[OsString], _: bool) -> io::Result<Box<dyn ChildProcess>> {
            if self.fail_spawn {
                return Err(io::Error::new(io::ErrorKind::NotFound, "fake Node missing"));
            }
            self.child
                .lock()
                .expect("fake child lock")
                .take()
                .map(|child| Box::new(child) as Box<dyn ChildProcess>)
                .ok_or_else(|| io::Error::other("fake process already spawned"))
        }
    }

    pub(crate) struct FakeChildProcess {
        pub(crate) stdin: Option<ProcessWriter>,
        pub(crate) stdout: Option<ProcessReader>,
        pub(crate) stderr: Option<ProcessReader>,
        pub(crate) status: ProcessStatus,
        pub(crate) killed: Arc<AtomicBool>,
    }

    impl ChildProcess for FakeChildProcess {
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
            Ok(Some(self.status.clone()))
        }

        fn wait(&mut self) -> io::Result<ProcessStatus> {
            Ok(self.status.clone())
        }

        fn kill(&mut self) -> io::Result<()> {
            self.killed.store(true, AtomicOrdering::Release);
            Ok(())
        }
    }
}

#[cfg(test)]
pub(crate) use fakes::{FakeChildProcess, FakeProcessSpawner};

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    #[cfg(unix)]
    fn shell(script: &str) -> (OsString, Vec<OsString>) {
        (
            OsString::from("sh"),
            vec![OsString::from("-c"), OsString::from(script)],
        )
    }

    #[cfg(windows)]
    fn shell(script: &str) -> (OsString, Vec<OsString>) {
        (
            OsString::from("cmd"),
            vec![OsString::from("/C"), OsString::from(script)],
        )
    }

    #[test]
    fn system_spawner_captures_output_and_piped_processes() {
        let spawner = SystemProcessSpawner;
        #[cfg(unix)]
        let (program, arguments) = shell("printf version-output");
        #[cfg(windows)]
        let (program, arguments) = shell("<nul set /p =version-output");
        let output = spawner
            .output(&program, &arguments)
            .expect("capture process output");
        assert!(output.status.success);
        assert_eq!(output.stdout, b"version-output");

        #[cfg(unix)]
        let (program, arguments) = shell("read value; printf '%s' \"$value\"; printf error >&2");
        #[cfg(windows)]
        let (program, arguments) =
            shell("set /p value=& <nul set /p =%value% & <nul set /p =error 1>&2");
        let mut child = spawner
            .spawn(&program, &arguments, true)
            .expect("spawn piped process");
        let mut stdin = child.take_stdin().expect("piped stdin");
        stdin.write_all(b"request\n").expect("write child input");
        drop(stdin);
        let mut stdout = String::new();
        child
            .take_stdout()
            .expect("piped stdout")
            .read_to_string(&mut stdout)
            .expect("read stdout");
        let mut stderr = String::new();
        child
            .take_stderr()
            .expect("piped stderr")
            .read_to_string(&mut stderr)
            .expect("read stderr");
        assert_eq!(stdout.trim(), "request");
        assert_eq!(stderr, "error");
        assert!(child.wait().expect("wait for process").success);
        assert!(child.try_wait().expect("poll completed process").is_some());
    }

    #[test]
    fn system_spawner_can_kill_a_running_process() {
        #[cfg(unix)]
        let (program, arguments) = shell("while :; do :; done");
        #[cfg(windows)]
        let (program, arguments) = shell("ping -t 127.0.0.1 >nul");
        let mut child = SystemProcessSpawner
            .spawn(&program, &arguments, false)
            .expect("spawn long-running process");
        assert!(child.take_stdin().is_none());
        child.kill().expect("kill process");
        assert!(!child.wait().expect("wait for killed process").success);
    }
}

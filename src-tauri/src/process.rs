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
        let stdin = if piped_stdin {
            Stdio::piped()
        } else {
            Stdio::null()
        };
        let child = Command::new(program)
            .args(arguments)
            .stdin(stdin)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;
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

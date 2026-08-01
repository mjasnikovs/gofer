use crate::process::{ChildProcess, ProcessSpawner, SystemProcessSpawner};
use crate::storage::{
    AppendGodotLogsRequest, FinishGodotRunRequest, GodotLogEntry, GodotRunRecord, ProjectStorage,
    StartGodotRunRequest,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::ffi::OsString;
use std::io::{BufRead, BufReader};
use std::path::{Component, Path};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Runtime};

static ACTIVE_GODOT: Mutex<Option<ActiveGodot>> = Mutex::new(None);
static GODOT_PROCESS_ACTIVE: AtomicBool = AtomicBool::new(false);

struct ActiveGodot {
    run_id: String,
    child: Arc<Mutex<Box<dyn ChildProcess>>>,
}

struct LaunchReservation;

impl Drop for LaunchReservation {
    fn drop(&mut self) {
        GODOT_PROCESS_ACTIVE.store(false, Ordering::Release);
    }
}

struct RunGuard {
    storage: ProjectStorage,
    run_id: String,
    finished: bool,
}

impl Drop for RunGuard {
    fn drop(&mut self) {
        if self.finished {
            return;
        }
        if let Ok(mut active) = ACTIVE_GODOT.lock()
            && let Some(active) = active.take()
            && let Ok(mut child) = active.child.lock()
        {
            let _ = child.kill();
        }
        let _ = self.storage.finish_godot_run(&FinishGodotRunRequest {
            run_id: self.run_id.clone(),
            status: "failed".to_owned(),
            exit_code: None,
        });
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchGodotRequest {
    pub task_id: Option<String>,
    pub scene: Option<String>,
    #[serde(default)]
    pub editor: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GodotProcessEvent {
    pub run_id: String,
    pub event_type: String,
    pub timestamp: u64,
    pub level: Option<String>,
    pub message: Option<String>,
    pub exit_code: Option<i32>,
}

pub fn launch(
    app: &AppHandle,
    storage: ProjectStorage,
    request: LaunchGodotRequest,
) -> Result<GodotRunRecord, String> {
    launch_with(app, storage, request, &SystemProcessSpawner)
}

fn launch_with<R: Runtime>(
    app: &AppHandle<R>,
    storage: ProjectStorage,
    request: LaunchGodotRequest,
    spawner: &impl ProcessSpawner,
) -> Result<GodotRunRecord, String> {
    if let Some(scene) = request.scene.as_deref() {
        validate_scene(scene)?;
    }
    if GODOT_PROCESS_ACTIVE
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Err("A Godot process is already running".to_owned());
    }
    let _reservation = LaunchReservation;
    let binary = discover_binary(spawner)?;
    let workspace = storage.agent_workspace()?;
    let version = command_text(spawner, &binary, &["--version"]).ok();
    let run = storage.start_godot_run_in(
        &StartGodotRunRequest {
            task_id: request.task_id,
            godot_version: version,
            metadata: json!({"binary": binary, "editor": request.editor, "scene": request.scene}),
        },
        &workspace,
    )?;
    let mut arguments = vec![
        OsString::from("--path"),
        workspace.clone().into_os_string(),
        OsString::from("--verbose"),
    ];
    if request.editor {
        arguments.push(OsString::from("--editor"));
    }
    if let Some(scene) = request
        .scene
        .as_deref()
        .filter(|scene| !scene.trim().is_empty())
    {
        arguments.push(OsString::from(scene));
    }
    let mut child = match spawner.spawn(binary.as_ref(), &arguments, false) {
        Ok(child) => child,
        Err(error) => {
            let _ = storage.finish_godot_run(&FinishGodotRunRequest {
                run_id: run.id.clone(),
                status: "failed".to_owned(),
                exit_code: None,
            });
            return Err(format!("Could not launch Godot with '{binary}': {error}"));
        }
    };
    let stdout = child
        .take_stdout()
        .ok_or_else(|| "Could not read Godot output".to_owned())?;
    let stderr = child
        .take_stderr()
        .ok_or_else(|| "Could not read Godot errors".to_owned())?;
    let child = Arc::new(Mutex::new(child));
    *ACTIVE_GODOT
        .lock()
        .map_err(|_| "The Godot process lock is poisoned".to_owned())? = Some(ActiveGodot {
        run_id: run.id.clone(),
        child: Arc::clone(&child),
    });
    let mut run_guard = RunGuard {
        storage: storage.clone(),
        run_id: run.id.clone(),
        finished: false,
    };
    emit(app, &run.id, "started", None, None, None);
    let (sender, receiver) = mpsc::channel();
    read_lines(stdout, "stdout", sender.clone());
    read_lines(stderr, "stderr", sender);
    let mut batch = Vec::new();
    let process_status = loop {
        match receiver.recv_timeout(Duration::from_millis(50)) {
            Ok((source, line)) => {
                let level = classify_line(&line).to_owned();
                let timestamp = now_millis();
                emit(app, &run.id, "line", Some(&level), Some(&line), None);
                batch.push(GodotLogEntry {
                    timestamp,
                    level,
                    message: line,
                    source: Some(source),
                    stack_trace: None,
                });
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {}
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
        if batch.len() >= 100 {
            storage.append_godot_logs(&AppendGodotLogsRequest {
                run_id: run.id.clone(),
                entries: std::mem::take(&mut batch),
            })?;
        }
        let status = child
            .lock()
            .map_err(|_| "The Godot child process lock is poisoned".to_owned())?
            .try_wait()
            .map_err(|error| format!("Could not monitor Godot: {error}"))?;
        if let Some(status) = status {
            for (source, line) in receiver.try_iter() {
                let level = classify_line(&line).to_owned();
                let timestamp = now_millis();
                emit(app, &run.id, "line", Some(&level), Some(&line), None);
                batch.push(GodotLogEntry {
                    timestamp,
                    level,
                    message: line,
                    source: Some(source),
                    stack_trace: None,
                });
            }
            if !batch.is_empty() {
                storage.append_godot_logs(&AppendGodotLogsRequest {
                    run_id: run.id.clone(),
                    entries: std::mem::take(&mut batch),
                })?;
            }
            break status;
        }
    };
    let was_cancelled = ACTIVE_GODOT
        .lock()
        .map_err(|_| "The Godot process lock is poisoned".to_owned())?
        .take()
        .is_none();
    let final_status = if was_cancelled {
        "aborted"
    } else if process_status.success {
        "completed"
    } else {
        "failed"
    };
    storage.finish_godot_run(&FinishGodotRunRequest {
        run_id: run.id.clone(),
        status: final_status.to_owned(),
        exit_code: process_status.code,
    })?;
    run_guard.finished = true;
    emit(app, &run.id, "finished", None, None, process_status.code);
    Ok(run)
}

// coverage-critical-start: cancellation
pub fn cancel() -> Result<(), String> {
    let active = ACTIVE_GODOT
        .lock()
        .map_err(|_| "The Godot process lock is poisoned".to_owned())?
        .take()
        .ok_or_else(|| "No Godot process is running".to_owned())?;
    active
        .child
        .lock()
        .map_err(|_| "The Godot child process lock is poisoned".to_owned())?
        .kill()
        .map_err(|error| format!("Could not stop Godot run {}: {error}", active.run_id))
}
// coverage-critical-end: cancellation

fn discover_binary(spawner: &impl ProcessSpawner) -> Result<String, String> {
    if let Ok(binary) = std::env::var("GOFER_GODOT_BINARY") {
        if command_text(spawner, &binary, &["--version"]).is_ok() {
            return Ok(binary);
        }
        return Err(format!(
            "GOFER_GODOT_BINARY points to an unusable executable: {binary}"
        ));
    }
    for binary in ["godot4", "godot"] {
        if command_text(spawner, binary, &["--version"]).is_ok() {
            return Ok(binary.to_owned());
        }
    }
    Err("Godot was not found. Install Godot 4 or set GOFER_GODOT_BINARY.".to_owned())
}

fn command_text(
    spawner: &impl ProcessSpawner,
    binary: &str,
    arguments: &[&str],
) -> Result<String, String> {
    let arguments = arguments.iter().map(OsString::from).collect::<Vec<_>>();
    let output = spawner
        .output(binary.as_ref(), &arguments)
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

// coverage-critical-start: path
fn validate_scene(scene: &str) -> Result<(), String> {
    let scene = scene.trim();
    if scene.is_empty() {
        return Ok(());
    }
    if scene.len() > 4_096 || scene.chars().any(char::is_control) {
        return Err("The Godot scene path is invalid".to_owned());
    }
    let relative = scene.strip_prefix("res://").unwrap_or(scene);
    let path = Path::new(relative);
    if relative.is_empty()
        || path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
        || !matches!(
            path.extension().and_then(|value| value.to_str()),
            Some("tscn" | "scn")
        )
    {
        return Err(
            "Godot scenes must be relative .tscn or .scn paths inside the project".to_owned(),
        );
    }
    Ok(())
}
// coverage-critical-end: path

fn read_lines(
    reader: impl std::io::Read + Send + 'static,
    source: &'static str,
    sender: mpsc::Sender<(String, String)>,
) {
    std::thread::spawn(move || {
        for line in BufReader::new(reader).lines().map_while(Result::ok) {
            let _ = sender.send((source.to_owned(), line));
        }
    });
}

fn classify_line(line: &str) -> &'static str {
    let uppercase = line.trim_start().to_ascii_uppercase();
    if uppercase.starts_with("ERROR:") || uppercase.starts_with("SCRIPT ERROR:") {
        "error"
    } else if uppercase.starts_with("WARNING:") || uppercase.starts_with("WARN:") {
        "warning"
    } else {
        "info"
    }
}

fn emit<R: Runtime>(
    app: &AppHandle<R>,
    run_id: &str,
    event_type: &str,
    level: Option<&str>,
    message: Option<&str>,
    exit_code: Option<i32>,
) {
    let _ = app.emit_to(
        "main",
        "godot-process-event",
        GodotProcessEvent {
            run_id: run_id.to_owned(),
            event_type: event_type.to_owned(),
            timestamp: now_millis(),
            level: level.map(str::to_owned),
            message: message.map(str::to_owned),
            exit_code,
        },
    );
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::process::{ProcessOutput, ProcessReader, ProcessStatus, ProcessWriter};
    use std::ffi::{OsStr, OsString};
    use std::fs;
    use std::io::{self, Cursor};
    use tempfile::TempDir;

    static GODOT_TEST_LOCK: Mutex<()> = Mutex::new(());

    struct FakeSpawner {
        child: Mutex<Option<FakeChild>>,
        arguments: Arc<Mutex<Vec<OsString>>>,
        output_success: bool,
    }

    impl FakeSpawner {
        fn new(success: bool) -> Self {
            Self {
                child: Mutex::new(Some(FakeChild {
                    stdout: Some(Box::new(Cursor::new(
                        b"Godot Engine v4\nWARNING: test warning\n",
                    ))),
                    stderr: Some(Box::new(Cursor::new(b"ERROR: test error\n"))),
                    status: ProcessStatus {
                        success,
                        code: Some(if success { 0 } else { 2 }),
                        description: if success {
                            "exit status: 0"
                        } else {
                            "exit status: 2"
                        }
                        .to_owned(),
                    },
                    killed: Arc::new(AtomicBool::new(false)),
                })),
                arguments: Arc::new(Mutex::new(Vec::new())),
                output_success: true,
            }
        }
    }

    impl ProcessSpawner for FakeSpawner {
        fn output(&self, _: &OsStr, _: &[OsString]) -> io::Result<ProcessOutput> {
            Ok(ProcessOutput {
                status: ProcessStatus {
                    success: self.output_success,
                    code: Some(if self.output_success { 0 } else { 1 }),
                    description: if self.output_success {
                        "exit status: 0"
                    } else {
                        "exit status: 1"
                    }
                    .to_owned(),
                },
                stdout: b"4.7.1.stable\n".to_vec(),
            })
        }

        fn spawn(
            &self,
            _: &OsStr,
            arguments: &[OsString],
            piped_stdin: bool,
        ) -> io::Result<Box<dyn ChildProcess>> {
            assert!(!piped_stdin);
            *self.arguments.lock().expect("fake Godot arguments") = arguments.to_vec();
            self.child
                .lock()
                .expect("fake Godot child")
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

    fn storage() -> (TempDir, ProjectStorage) {
        let directory = TempDir::new().expect("temporary Godot storage");
        let workspace = directory.path().join("workspace");
        fs::create_dir(&workspace).expect("create Godot workspace");
        let storage = ProjectStorage::open(&directory.path().join("data"), &workspace)
            .expect("open project storage");
        (directory, storage)
    }

    fn app() -> tauri::App<tauri::test::MockRuntime> {
        let app = tauri::test::mock_builder()
            .build(tauri::generate_context!())
            .expect("build mock Tauri app");
        tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("build mock webview");
        app
    }

    #[test]
    fn classifies_important_godot_lines() {
        assert_eq!(classify_line("ERROR: Invalid call"), "error");
        assert_eq!(classify_line("SCRIPT ERROR: Parse error"), "error");
        assert_eq!(classify_line("WARNING: unused signal"), "warning");
        assert_eq!(classify_line("WARN: legacy warning"), "warning");
        assert_eq!(classify_line("Godot Engine v4"), "info");
    }

    #[test]
    fn validates_project_relative_scene_paths() {
        assert!(validate_scene("").is_ok());
        assert!(validate_scene("res://levels/main.tscn").is_ok());
        assert!(validate_scene("levels/main.scn").is_ok());
        assert!(validate_scene("res://").is_err());
        assert!(validate_scene("level\0main.tscn").is_err());
        assert!(validate_scene(&format!("{}.tscn", "x".repeat(4_096))).is_err());
        assert!(validate_scene("../outside.tscn").is_err());
        assert!(validate_scene("/tmp/outside.tscn").is_err());
        assert!(validate_scene("scripts/bootstrap.gd").is_err());
    }

    #[test]
    fn injected_process_runs_godot_and_records_arguments() {
        let _test = GODOT_TEST_LOCK.lock().expect("Godot test lock");
        let (_directory, storage) = storage();
        let app = app();
        let spawner = FakeSpawner::new(true);
        let run = launch_with(
            app.handle(),
            storage,
            LaunchGodotRequest {
                task_id: None,
                scene: Some("res://levels/main.tscn".to_owned()),
                editor: true,
            },
            &spawner,
        )
        .expect("fake Godot run");

        assert!(!run.id.is_empty());
        let arguments = spawner.arguments.lock().expect("fake Godot arguments");
        assert!(arguments.contains(&OsString::from("--path")));
        assert!(arguments.contains(&OsString::from("--editor")));
        assert!(arguments.contains(&OsString::from("res://levels/main.tscn")));
        assert!(!GODOT_PROCESS_ACTIVE.load(Ordering::Acquire));
    }

    #[test]
    fn cancellation_kills_the_injected_godot_process() {
        let _test = GODOT_TEST_LOCK.lock().expect("Godot test lock");
        let killed = Arc::new(AtomicBool::new(false));
        *ACTIVE_GODOT.lock().expect("active Godot lock") = Some(ActiveGodot {
            run_id: "run-1".to_owned(),
            child: Arc::new(Mutex::new(Box::new(FakeChild {
                stdout: None,
                stderr: None,
                status: ProcessStatus {
                    success: false,
                    code: None,
                    description: "killed".to_owned(),
                },
                killed: Arc::clone(&killed),
            }))),
        });

        cancel().expect("cancel fake Godot");
        assert!(killed.load(Ordering::Acquire));
        assert_eq!(cancel(), Err("No Godot process is running".to_owned()));
    }

    #[test]
    fn injected_process_covers_failed_spawn_exit_and_active_reservation() {
        let _test = GODOT_TEST_LOCK.lock().expect("Godot test lock");
        let app = app();
        let (_directory, storage) = storage();
        let failed = FakeSpawner::new(false);
        launch_with(
            app.handle(),
            storage.clone(),
            LaunchGodotRequest {
                task_id: None,
                scene: None,
                editor: false,
            },
            &failed,
        )
        .expect("failed Godot exit is recorded");

        let missing_child = FakeSpawner {
            child: Mutex::new(None),
            arguments: Arc::new(Mutex::new(Vec::new())),
            output_success: true,
        };
        assert!(
            launch_with(
                app.handle(),
                storage.clone(),
                LaunchGodotRequest {
                    task_id: None,
                    scene: None,
                    editor: false,
                },
                &missing_child,
            )
            .unwrap_err()
            .contains("Could not launch Godot")
        );

        GODOT_PROCESS_ACTIVE.store(true, Ordering::Release);
        assert_eq!(
            launch_with(
                app.handle(),
                storage,
                LaunchGodotRequest {
                    task_id: None,
                    scene: None,
                    editor: false,
                },
                &FakeSpawner::new(true),
            )
            .unwrap_err(),
            "A Godot process is already running"
        );
        GODOT_PROCESS_ACTIVE.store(false, Ordering::Release);
    }

    #[test]
    fn unfinished_run_guard_kills_the_child_and_marks_the_run_failed() {
        let _test = GODOT_TEST_LOCK.lock().expect("Godot test lock");
        let (_directory, storage) = storage();
        let workspace = storage.agent_workspace().expect("agent workspace");
        let run = storage
            .start_godot_run_in(
                &StartGodotRunRequest {
                    task_id: None,
                    godot_version: Some("4.7.1".to_owned()),
                    metadata: json!({}),
                },
                &workspace,
            )
            .expect("start guarded run");
        let killed = Arc::new(AtomicBool::new(false));
        *ACTIVE_GODOT.lock().expect("active Godot lock") = Some(ActiveGodot {
            run_id: run.id.clone(),
            child: Arc::new(Mutex::new(Box::new(FakeChild {
                stdout: None,
                stderr: None,
                status: ProcessStatus {
                    success: false,
                    code: None,
                    description: "unfinished".to_owned(),
                },
                killed: Arc::clone(&killed),
            }))),
        });
        drop(RunGuard {
            storage,
            run_id: run.id,
            finished: false,
        });
        assert!(killed.load(Ordering::Acquire));
        assert!(ACTIVE_GODOT.lock().expect("active Godot lock").is_none());
    }

    #[test]
    fn binary_discovery_and_finished_guards_cover_lifecycle_branches() {
        let _test = GODOT_TEST_LOCK.lock().expect("Godot test lock");
        let mut failing = FakeSpawner::new(true);
        failing.output_success = false;
        assert!(command_text(&failing, "fake-godot", &["--version"]).is_err());

        // SAFETY: the Godot test lock serializes the process-wide binary override.
        unsafe { std::env::set_var("GOFER_GODOT_BINARY", "fake-godot") };
        assert_eq!(
            discover_binary(&FakeSpawner::new(true)).expect("configured fake Godot"),
            "fake-godot"
        );
        // SAFETY: restore the process environment while still holding the test lock.
        unsafe { std::env::remove_var("GOFER_GODOT_BINARY") };

        let (_directory, storage) = storage();
        drop(RunGuard {
            storage,
            run_id: "already-finished".to_owned(),
            finished: true,
        });
    }
}

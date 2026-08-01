use crate::storage::{
    AppendGodotLogsRequest, FinishGodotRunRequest, GodotLogEntry, GodotRunRecord, ProjectStorage,
    StartGodotRunRequest,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::io::{BufRead, BufReader};
use std::path::{Component, Path};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

static ACTIVE_GODOT: Mutex<Option<ActiveGodot>> = Mutex::new(None);
static GODOT_PROCESS_ACTIVE: AtomicBool = AtomicBool::new(false);

struct ActiveGodot {
    run_id: String,
    child: Arc<Mutex<Child>>,
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
    let binary = discover_binary()?;
    let workspace = storage.agent_workspace()?;
    let version = command_text(&binary, &["--version"]).ok();
    let run = storage.start_godot_run_in(
        &StartGodotRunRequest {
            task_id: request.task_id,
            godot_version: version,
            metadata: json!({"binary": binary, "editor": request.editor, "scene": request.scene}),
        },
        &workspace,
    )?;
    let mut command = Command::new(&binary);
    command.arg("--path").arg(&workspace).arg("--verbose");
    if request.editor {
        command.arg("--editor");
    }
    if let Some(scene) = request
        .scene
        .as_deref()
        .filter(|scene| !scene.trim().is_empty())
    {
        command.arg(scene);
    }
    let mut child = match command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
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
        .stdout
        .take()
        .ok_or_else(|| "Could not read Godot output".to_owned())?;
    let stderr = child
        .stderr
        .take()
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
    } else if process_status.success() {
        "completed"
    } else {
        "failed"
    };
    storage.finish_godot_run(&FinishGodotRunRequest {
        run_id: run.id.clone(),
        status: final_status.to_owned(),
        exit_code: process_status.code(),
    })?;
    run_guard.finished = true;
    emit(app, &run.id, "finished", None, None, process_status.code());
    Ok(run)
}

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

fn discover_binary() -> Result<String, String> {
    if let Ok(binary) = std::env::var("GOFER_GODOT_BINARY") {
        if command_text(&binary, &["--version"]).is_ok() {
            return Ok(binary);
        }
        return Err(format!(
            "GOFER_GODOT_BINARY points to an unusable executable: {binary}"
        ));
    }
    for binary in ["godot4", "godot"] {
        if command_text(binary, &["--version"]).is_ok() {
            return Ok(binary.to_owned());
        }
    }
    Err("Godot was not found. Install Godot 4 or set GOFER_GODOT_BINARY.".to_owned())
}

fn command_text(binary: &str, arguments: &[&str]) -> Result<String, String> {
    let output = Command::new(binary)
        .args(arguments)
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(format!("{binary} exited with {}", output.status));
    }
    String::from_utf8(output.stdout)
        .map(|value| value.trim().to_owned())
        .map_err(|error| error.to_string())
}

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

fn emit(
    app: &AppHandle,
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

    #[test]
    fn classifies_important_godot_lines() {
        assert_eq!(classify_line("ERROR: Invalid call"), "error");
        assert_eq!(classify_line("SCRIPT ERROR: Parse error"), "error");
        assert_eq!(classify_line("WARNING: unused signal"), "warning");
        assert_eq!(classify_line("Godot Engine v4"), "info");
    }

    #[test]
    fn validates_project_relative_scene_paths() {
        assert!(validate_scene("res://levels/main.tscn").is_ok());
        assert!(validate_scene("levels/main.scn").is_ok());
        assert!(validate_scene("../outside.tscn").is_err());
        assert!(validate_scene("/tmp/outside.tscn").is_err());
        assert!(validate_scene("scripts/bootstrap.gd").is_err());
    }
}

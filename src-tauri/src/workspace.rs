//! Which folder Gofer is bound to, and where that folder's data lives.
//!
//! Split out of `lib.rs` for the reason `ai_turn` was: every other concern in this crate has a
//! module, this one did not, and so the crate's largest file was where you landed for anything.
//! What sat there was not command dispatch — it is the decision that comes before every command:
//! an environment file the health check writes, two environment variables that override it, and
//! the project database that has to be reopened when either changes.
//!
//! Distinct from [`crate::files::Workspace`], which reads and writes inside the folder this module
//! chooses. Here the question is *which* folder; there it is what may be touched inside one.

use crate::health;
use crate::storage::{self, ProjectStorage, StorageSlot};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Component, Path, PathBuf};
use tauri::{AppHandle, Manager, Runtime};

const ENVIRONMENT_FILE_NAME: &str = "environment.json";
const CHAT_ATTACHMENTS_DIRECTORY: &str = "chat-attachments";
/// Where a project's own data lives, inside the project.
const PROJECT_DATA_DIRECTORY: &str = ".gofer";

/// The workspace folder and Godot executable the user chose in the health check.
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EnvironmentSettings {
    #[serde(default)]
    pub(crate) workspace: Option<String>,
    #[serde(default)]
    pub(crate) godot_binary: Option<String>,
}

/// The workspace Gofer is bound to, and how it came to be that one.
pub(crate) struct WorkspaceBinding {
    pub(crate) path: PathBuf,
    pub(crate) source: health::WorkspaceSource,
}

fn environment_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    if let Some(path) = configured_app_data_path()? {
        return Ok(path.join(ENVIRONMENT_FILE_NAME));
    }
    app.path()
        .app_config_dir()
        .map(|path| path.join(ENVIRONMENT_FILE_NAME))
        .map_err(|error| format!("Could not resolve Gofer's configuration directory: {error}"))
}

/// Reads the recorded environment, treating an unreadable or invalid file as "nothing recorded".
///
/// This file decides which folder Gofer opens. Refusing to start over a corrupt one would strand
/// the user in exactly the state the health check exists to get them out of.
pub(crate) fn read_environment<R: Runtime>(app: &AppHandle<R>) -> EnvironmentSettings {
    let Ok(path) = environment_path(app) else {
        return EnvironmentSettings::default();
    };
    fs::read_to_string(path)
        .ok()
        .and_then(|contents| serde_json::from_str(&contents).ok())
        .unwrap_or_default()
}

/// The editor the user pointed Gofer at, for the session supervisor to launch.
pub(crate) fn configured_godot_binary<R: Runtime>(app: &AppHandle<R>) -> Option<String> {
    read_environment(app).godot_binary
}

pub(crate) fn write_environment<R: Runtime>(
    app: &AppHandle<R>,
    environment: &EnvironmentSettings,
) -> Result<(), String> {
    let path = environment_path(app)?;
    let parent = path
        .parent()
        .ok_or_else(|| format!("Gofer environment path has no parent: {}", path.display()))?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create {}: {error}", parent.display()))?;
    let contents = serde_json::to_string_pretty(environment)
        .map_err(|error| format!("Could not serialize the Gofer environment: {error}"))?;
    fs::write(&path, format!("{contents}\n"))
        .map_err(|error| format!("Could not write {}: {error}", path.display()))
}

pub(crate) fn resolve_workspace<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<WorkspaceBinding, String> {
    // `GOFER_WORKSPACE_DIR` wins so a test harness can point a launched application at a prepared
    // repository regardless of what the user last chose.
    if let Some(configured) = std::env::var_os("GOFER_WORKSPACE_DIR") {
        return Ok(WorkspaceBinding {
            path: validate_configured_directory(
                PathBuf::from(configured),
                "GOFER_WORKSPACE_DIR must be an absolute path without traversal",
            )?,
            source: health::WorkspaceSource::Environment,
        });
    }
    if let Some(chosen) = read_environment(app).workspace {
        let path = PathBuf::from(chosen);
        // A folder that has since been deleted or moved falls back rather than blocking startup;
        // the health check then reports the working directory it landed on.
        if path.is_dir() {
            return Ok(WorkspaceBinding {
                path,
                source: health::WorkspaceSource::Configured,
            });
        }
    }
    Ok(WorkspaceBinding {
        path: std::env::current_dir()
            .map_err(|error| format!("Could not resolve the agent workspace: {error}"))?,
        source: health::WorkspaceSource::WorkingDirectory,
    })
}

pub(crate) fn chat_attachments_path(app: &AppHandle) -> Result<PathBuf, String> {
    app_data_path(app).map(|path| path.join(CHAT_ATTACHMENTS_DIRECTORY))
}

pub(crate) fn configured_app_data_path() -> Result<Option<PathBuf>, String> {
    let Some(configured) = std::env::var_os("GOFER_APP_DATA_DIR") else {
        return Ok(None);
    };
    validate_app_data_path(PathBuf::from(configured)).map(Some)
}

// coverage-critical-start: path
fn validate_app_data_path(path: PathBuf) -> Result<PathBuf, String> {
    validate_configured_directory(
        path,
        "GOFER_APP_DATA_DIR must be an absolute path without traversal",
    )
}

/// One rule for every directory an environment variable may name: absolute, no traversal.
fn validate_configured_directory(path: PathBuf, message: &str) -> Result<PathBuf, String> {
    if !path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, Component::CurDir | Component::ParentDir))
    {
        return Err(message.to_owned());
    }
    Ok(path)
}
// coverage-critical-end: path

pub(crate) fn app_data_path(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(path) = configured_app_data_path()? {
        return Ok(path);
    }
    app.path()
        .app_data_dir()
        .map_err(|error| format!("Could not resolve Gofer's data directory: {error}"))
}

pub(crate) fn project_storage<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<ProjectStorage, crate::command_error::CommandError> {
    app.try_state::<StorageSlot>()
        .ok_or_else(|| "Project storage has not been initialized".to_owned())?
        .get()
}

/// Opens the project database for whatever folder Gofer is currently bound to.
///
/// The workspace is normally the directory Gofer was started in. `GOFER_WORKSPACE_DIR` names it
/// explicitly, which is how the packaged journey points a launched application at a prepared
/// repository instead of at whatever directory the test runner happened to be in; the health check
/// records a folder the user chose. It is validated exactly like `GOFER_APP_DATA_DIR`, because both
/// name a directory Gofer will write.
pub(crate) fn open_project_storage(
    app: &AppHandle,
) -> Result<ProjectStorage, crate::command_error::CommandError> {
    let workspace = resolve_workspace(app)?.path;
    let data_root = project_data_path(&workspace)?;
    if let Ok(legacy_root) = app.path().app_data_dir() {
        storage::migrate_legacy_data(&legacy_root, &workspace, &data_root)?;
    }
    ProjectStorage::open(&data_root, &workspace)
}

/// Where this workspace's own data lives: `.gofer` beside the files it belongs to.
///
/// Keeping it in the workspace is what makes a project portable. Copy the folder and its chats,
/// logs, and worktrees come with it; delete the folder and they are gone, which is what deleting a
/// project should mean. `GOFER_APP_DATA_DIR` overrides the location for a test that needs to hand
/// the directory to something else, and names the project directory itself.
fn project_data_path(workspace: &Path) -> Result<PathBuf, String> {
    if let Some(path) = configured_app_data_path()? {
        return Ok(path);
    }
    Ok(workspace.join(PROJECT_DATA_DIRECTORY))
}

/// Rebinds the project database after the health check changed what it depends on.
pub(crate) fn reopen_storage(
    app: &AppHandle,
) -> Result<ProjectStorage, crate::command_error::CommandError> {
    app.try_state::<StorageSlot>()
        .ok_or_else(|| "Project storage has not been initialized".to_owned())?
        .replace(open_project_storage(app))
}

/// Reports the workspace as it stands, and the one thing outside this module a report needs: how
/// the AI server answered.
///
/// The binding and the database are asked for together because a failure in the first is a failure
/// of the second: a workspace that cannot be resolved has no project database to open, and saying
/// so twice would offer the user two repairs for one problem.
pub(crate) fn report_health(
    app: &AppHandle,
    ai: health::AiHealth,
    formatter_error: Option<String>,
) -> health::HealthReport {
    let binding = resolve_workspace(app);
    let (workspace, source) = match &binding {
        Ok(binding) => (binding.path.clone(), binding.source),
        Err(_) => (PathBuf::new(), health::WorkspaceSource::WorkingDirectory),
    };
    let storage_error = match binding {
        Err(error) => Some(error),
        Ok(_) => project_storage(app).err().map(String::from),
    };
    let environment = read_environment(app);
    health::report(&health::HealthInput {
        workspace,
        workspace_source: source,
        storage_error,
        godot: crate::godot_session::probe_binary(environment.godot_binary.as_deref()),
        ai,
        formatter_error,
    })
}

/// Applies one health remedy, and rebinds whatever it changed.
///
/// Rebinding here rather than at the call site is the invariant this module owns: a chosen folder
/// that is written but not reopened leaves every later command pointed at the old project, and a
/// git repair that is not followed by a reopen leaves the failed open failed. The health check runs
/// before any session, watcher, or task exists, so nothing is left holding the old binding.
pub(crate) fn apply_remedy(
    app: &AppHandle,
    action: health::RemedyAction,
    path: Option<String>,
) -> Result<(), String> {
    match action {
        health::RemedyAction::ChooseWorkspace => {
            let path = chosen_path(path, "a project folder")?;
            if !path.is_dir() {
                return Err(format!("{} is not a folder.", path.display()));
            }
            let mut environment = read_environment(app);
            environment.workspace = Some(path.display().to_string());
            write_environment(app, &environment)?;
            reopen_storage(app).map(|_| ()).map_err(String::from)
        }
        health::RemedyAction::LocateGodotBinary => {
            let path = chosen_path(path, "the Godot executable")?;
            let binary = path.display().to_string();
            let probe = crate::godot_session::probe_binary(Some(&binary));
            if let Some(error) = probe.error {
                return Err(error);
            }
            let mut environment = read_environment(app);
            environment.godot_binary = Some(binary);
            write_environment(app, &environment)
        }
        action => {
            let workspace = resolve_workspace(app)?.path;
            health::apply(&workspace, action)?;
            // Git repairs are exactly what a failed open was waiting for.
            let _ = reopen_storage(app);
            Ok(())
        }
    }
}

fn chosen_path(path: Option<String>, what: &str) -> Result<PathBuf, String> {
    let path = path
        .map(|path| path.trim().to_owned())
        .filter(|path| !path.is_empty())
        .ok_or_else(|| format!("Gofer needs {what} to be chosen first."))?;
    Ok(PathBuf::from(path))
}

#[cfg(test)]
mod tests {
    use super::*;

    /**
     * A remedy the user never answered is a prompt, not a failure of the repair.
     *
     * The file dialog can be dismissed, and on the platforms where it is native it answers with an
     * empty string rather than with nothing at all. Both reach here as "no folder was chosen", and
     * the message has to name what is still being asked for or the health check repeats itself
     * with no explanation.
     */
    #[test]
    fn a_remedy_with_nothing_chosen_says_what_it_is_still_waiting_for() {
        assert_eq!(
            chosen_path(None, "a project folder").unwrap_err(),
            "Gofer needs a project folder to be chosen first."
        );
        assert_eq!(
            chosen_path(Some("   ".to_owned()), "the Godot executable").unwrap_err(),
            "Gofer needs the Godot executable to be chosen first."
        );
        assert_eq!(
            chosen_path(Some("  /projects/game  ".to_owned()), "a project folder")
                .expect("a chosen folder"),
            PathBuf::from("/projects/game")
        );
    }

    #[test]
    fn configured_app_data_paths_must_be_absolute_and_confined() {
        assert!(validate_app_data_path(std::env::temp_dir().join("gofer-data")).is_ok());
        assert!(validate_app_data_path(PathBuf::from("relative-data")).is_err());
        assert!(validate_app_data_path(std::env::temp_dir().join("../escape")).is_err());
    }

    #[test]
    fn a_configured_directory_must_be_absolute_and_free_of_traversal() {
        let message = "must be absolute";
        assert!(validate_configured_directory(PathBuf::from("relative"), message).is_err());
        assert!(
            validate_configured_directory(std::env::temp_dir().join("../up"), message).is_err()
        );
        assert!(validate_configured_directory(std::env::temp_dir(), message).is_ok());
        assert_eq!(
            validate_configured_directory(PathBuf::from("relative"), message).unwrap_err(),
            message
        );
    }
}

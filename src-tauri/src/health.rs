//! The startup health check: everything Gofer needs before it can do any work, and what the user
//! can press to supply what is missing.
//!
//! Gofer refuses a workspace for several unrelated reasons — no Git repository, a repository with
//! no commits, no `project.godot`, no engine, no configured model — and each of those used to be
//! discovered separately, late, and in the vocabulary of whatever subsystem happened to notice.
//! Starting an editor in a folder that was never a Godot project reported "A Godot session can only
//! start for an active task worktree", which names nothing the user has and nothing they can do.
//!
//! This module answers all of it at once, before the workspace opens, and pairs every failure with
//! the operation that repairs it. A check with no remedy is one Gofer genuinely cannot perform on
//! the user's behalf — installing Git, editing the engine's own settings — and those carry the
//! instruction in their detail instead.

use crate::git;
use crate::godot_session;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

/// The name Gofer records when the user asks it to supply a repository-local Git identity.
const FALLBACK_IDENTITY_NAME: &str = "Gofer";
const FALLBACK_IDENTITY_EMAIL: &str = "gofer@localhost";

const STARTER_PROJECT_FILE: &str = "\
; Written by Gofer to make this folder a Godot project.
config_version=5

[application]

config/name=\"{name}\"
run/main_scene=\"res://main.tscn\"

[rendering]

renderer/rendering_method=\"gl_compatibility\"
";

const STARTER_MAIN_SCENE: &str = "\
[gd_scene format=3]

[node name=\"Main\" type=\"Node2D\"]
";

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum HealthStatus {
    /// Nothing to do.
    Ok,
    /// Gofer runs, but something the user will reach for is unavailable.
    Degraded,
    /// Gofer cannot work in this workspace until it is fixed.
    Blocked,
}

/// How the workspace directory was chosen, which is the first thing a confused user needs to know.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum WorkspaceSource {
    /// `GOFER_WORKSPACE_DIR`.
    Environment,
    /// Chosen in Gofer and recorded in its settings.
    Configured,
    /// The directory Gofer was started in — the default, and the one that surprises people.
    WorkingDirectory,
}

/// An operation that repairs one failed check.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RemedyAction {
    ChooseWorkspace,
    InitializeGitRepository,
    SetGitIdentity,
    CommitProjectFiles,
    CreateGodotProject,
    LocateGodotBinary,
}

/// What the renderer must collect from the user before an action can be applied.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RemedyInput {
    /// No input: pressing the button is the whole answer.
    None,
    /// A directory, chosen with the system folder picker.
    Directory,
    /// An executable, chosen with the system file picker.
    File,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Remedy {
    pub action: RemedyAction,
    pub label: String,
    pub description: String,
    pub input: RemedyInput,
}

impl Remedy {
    fn new(action: RemedyAction, label: &str, description: &str, input: RemedyInput) -> Self {
        Self {
            action,
            label: label.to_owned(),
            description: description.to_owned(),
            input,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthCheck {
    pub id: String,
    pub title: String,
    pub status: HealthStatus,
    /// What is true right now, naming the path, version, or setting the user has to act on.
    pub detail: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remedy: Option<Remedy>,
}

impl HealthCheck {
    fn new(id: &str, title: &str, status: HealthStatus, detail: impl Into<String>) -> Self {
        Self {
            id: id.to_owned(),
            title: title.to_owned(),
            status,
            detail: detail.into(),
            remedy: None,
        }
    }

    fn with_remedy(mut self, remedy: Remedy) -> Self {
        self.remedy = Some(remedy);
        self
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthReport {
    pub workspace: String,
    pub workspace_source: WorkspaceSource,
    pub checks: Vec<HealthCheck>,
    /// Whether Gofer can be used at all. False while any check is blocked.
    pub is_ready: bool,
}

/// How the configured AI connection answered, when it was asked.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum AiReachability {
    Connected,
    ModelUnavailable,
    Unauthorized,
    ServerError,
    Unreachable,
}

/// What the AI connection looks like, as far as the health check is concerned.
#[derive(Clone, Debug, PartialEq)]
pub struct AiHealth {
    pub base_url: String,
    pub model: String,
    pub reachability: AiReachability,
    pub message: String,
}

/// Everything the report is assembled from. The caller gathers it, so the checks themselves stay
/// pure enough to test against a temporary directory.
#[derive(Clone, Debug)]
pub struct HealthInput {
    pub workspace: PathBuf,
    pub workspace_source: WorkspaceSource,
    /// Why the project database could not be opened, when it could not be.
    pub storage_error: Option<String>,
    /// The editor recorded in settings, which the probe already took into account.
    pub godot: godot_session::BinaryProbe,
    pub ai: AiHealth,
    /// Why GDScript formatting is unavailable, when it is.
    pub formatter_error: Option<String>,
}

pub fn report(input: &HealthInput) -> HealthReport {
    let repository = git::inspect(&input.workspace);
    let mut checks = vec![workspace_check(input)];
    checks.extend(git_checks(&input.workspace, &repository));
    checks.push(godot_project_check(&input.workspace));
    checks.push(godot_editor_check(&input.godot));
    checks.push(language_server_check());
    checks.push(ai_check(&input.ai));
    checks.push(formatter_check(input.formatter_error.as_deref()));
    let is_ready = !checks
        .iter()
        .any(|check| check.status == HealthStatus::Blocked);
    HealthReport {
        workspace: input.workspace.display().to_string(),
        workspace_source: input.workspace_source,
        checks,
        is_ready,
    }
}

fn workspace_check(input: &HealthInput) -> HealthCheck {
    let path = input.workspace.display();
    let remedy = Remedy::new(
        RemedyAction::ChooseWorkspace,
        "Choose project folder…",
        "Pick the folder holding your game. Gofer records it and reopens on it.",
        RemedyInput::Directory,
    );
    if let Some(error) = &input.storage_error {
        return HealthCheck::new(
            "workspace",
            "Project folder",
            HealthStatus::Blocked,
            format!("Gofer could not open its project database for {path}: {error}"),
        )
        .with_remedy(remedy);
    }
    if !input.workspace.is_dir() {
        return HealthCheck::new(
            "workspace",
            "Project folder",
            HealthStatus::Blocked,
            format!("{path} is not a folder Gofer can open."),
        )
        .with_remedy(remedy);
    }
    let origin = match input.workspace_source {
        WorkspaceSource::Environment => "named by GOFER_WORKSPACE_DIR",
        WorkspaceSource::Configured => "chosen in Gofer",
        // Launched from a desktop icon this is the home directory, or `/`, and nothing in the
        // interface used to say so.
        WorkspaceSource::WorkingDirectory => "the folder Gofer was started in",
    };
    HealthCheck::new(
        "workspace",
        "Project folder",
        HealthStatus::Ok,
        format!("Working in {path} — {origin}."),
    )
    .with_remedy(remedy)
}

fn git_checks(workspace: &Path, repository: &git::RepositoryStatus) -> Vec<HealthCheck> {
    if !repository.is_installed {
        return vec![HealthCheck::new(
            "git-installed",
            "Git",
            HealthStatus::Blocked,
            "Git is not installed, or is not on Gofer's PATH. Gofer gives every task its own Git \
             worktree so the agent never edits your project directly, so it cannot work without \
             it. Install Git from https://git-scm.com/downloads, then run the check again.",
        )];
    }

    let mut checks = vec![HealthCheck::new(
        "git-installed",
        "Git",
        HealthStatus::Ok,
        "Git is installed.",
    )];

    let Some(root) = &repository.root else {
        checks.push(
            HealthCheck::new(
                "git-repository",
                "Git repository",
                HealthStatus::Blocked,
                format!(
                    "{} is not a Git repository. Gofer runs each task in its own worktree branched \
                     from your project's history, so it needs one.",
                    workspace.display()
                ),
            )
            .with_remedy(Remedy::new(
                RemedyAction::InitializeGitRepository,
                "Initialize a Git repository",
                "Runs git init in this folder. Your files are left exactly as they are.",
                RemedyInput::None,
            )),
        );
        return checks;
    };

    // A folder inside someone else's repository is still a repository, and task branches would be
    // cut from that outer project rather than from the game.
    let is_own_root = crate::paths::canonical(root).ok() == crate::paths::canonical(workspace).ok();
    checks.push(if is_own_root {
        HealthCheck::new(
            "git-repository",
            "Git repository",
            HealthStatus::Ok,
            format!("{} is a Git repository.", root.display()),
        )
    } else {
        HealthCheck::new(
            "git-repository",
            "Git repository",
            HealthStatus::Degraded,
            format!(
                "This folder belongs to the repository at {}, so task branches and merges apply to \
                 that whole repository rather than to the game folder alone.",
                root.display()
            ),
        )
    });

    checks.push(if repository.has_identity {
        HealthCheck::new(
            "git-identity",
            "Git identity",
            HealthStatus::Ok,
            "Git knows who to record commits as.",
        )
    } else {
        HealthCheck::new(
            "git-identity",
            "Git identity",
            HealthStatus::Blocked,
            "Git has no user.name or user.email, so it refuses to commit — which is how a finished \
             task is merged back into your project.",
        )
        .with_remedy(Remedy::new(
            RemedyAction::SetGitIdentity,
            "Use a local Gofer identity",
            format!(
                "Records {FALLBACK_IDENTITY_NAME} <{FALLBACK_IDENTITY_EMAIL}> for this repository \
                 only. Your global Git configuration is not touched."
            )
            .as_str(),
            RemedyInput::None,
        ))
    });

    let commit_remedy = || {
        Remedy::new(
            RemedyAction::CommitProjectFiles,
            "Commit the project files",
            "Stages everything in this folder that Git is not ignoring and records it as a commit. \
             Your files themselves are not changed.",
            RemedyInput::None,
        )
    };

    checks.push(if repository.has_commit {
        HealthCheck::new(
            "git-history",
            "Project history",
            HealthStatus::Ok,
            "The repository has a commit to branch tasks from.",
        )
    } else {
        HealthCheck::new(
            "git-history",
            "Project history",
            HealthStatus::Blocked,
            "The repository has no commits yet. A task worktree is branched from a commit, so \
             there is nothing for Gofer to branch from.",
        )
        .with_remedy(commit_remedy())
    });

    // A commit that does not carry the project is a branch point and nothing more: every task
    // worktree is checked out from it, so the editor session opens a directory with no
    // project.godot in it and stops there, long after this report said the workspace was ready.
    if repository.has_commit
        && !repository.tracks_project_file
        && workspace.join(crate::addon::PROJECT_FILE).is_file()
    {
        checks.push(
            HealthCheck::new(
                "git-project-tracked",
                "Project in history",
                HealthStatus::Blocked,
                format!(
                    "{} is in this folder but not in the last commit. Each task runs in a worktree \
                     checked out from that commit, so the task would open a folder with no Godot \
                     project in it.",
                    crate::addon::PROJECT_FILE
                ),
            )
            .with_remedy(commit_remedy()),
        );
    }

    if repository.has_commit && !repository.is_clean {
        checks.push(HealthCheck::new(
            "git-clean",
            "Uncommitted changes",
            HealthStatus::Degraded,
            "The project has uncommitted changes. Tasks still run, but merging a finished task \
             needs a clean project first.",
        ));
    }

    checks
}

fn godot_project_check(workspace: &Path) -> HealthCheck {
    if workspace.join(crate::addon::PROJECT_FILE).is_file() {
        return HealthCheck::new(
            "godot-project",
            "Godot project",
            HealthStatus::Ok,
            format!("{} is present.", crate::addon::PROJECT_FILE),
        );
    }
    HealthCheck::new(
        "godot-project",
        "Godot project",
        HealthStatus::Blocked,
        format!(
            "{} has no {}, so there is no Godot project to open. Godot would silently adopt the \
             folder as an empty project and fail later as a scene that will not load.",
            workspace.display(),
            crate::addon::PROJECT_FILE
        ),
    )
    .with_remedy(Remedy::new(
        RemedyAction::CreateGodotProject,
        "Create a starter Godot project",
        "Writes project.godot and main.tscn here. Existing files are never overwritten.",
        RemedyInput::None,
    ))
}

fn godot_editor_check(probe: &godot_session::BinaryProbe) -> HealthCheck {
    let required = format!(
        "{}-{}",
        godot_session::REQUIRED_ENGINE_VERSION,
        godot_session::REQUIRED_CHANNEL
    );
    let Some(error) = &probe.error else {
        return HealthCheck::new(
            "godot-editor",
            "Godot editor",
            HealthStatus::Ok,
            format!(
                "Godot {} at {}.",
                probe.version.as_deref().unwrap_or(&required),
                probe.binary.as_deref().unwrap_or("godot")
            ),
        );
    };
    HealthCheck::new(
        "godot-editor",
        "Godot editor",
        HealthStatus::Blocked,
        format!(
            "{error} Gofer drives the editor itself, so it needs exactly Godot {required}. \
             Download it from https://godotengine.org/download, then point Gofer at it."
        ),
    )
    .with_remedy(Remedy::new(
        RemedyAction::LocateGodotBinary,
        "Locate Godot…",
        "Pick the Godot executable. Gofer checks its version before recording it.",
        RemedyInput::File,
    ))
}

fn language_server_check() -> HealthCheck {
    let host = match godot_session::probe_lsp_remote_host() {
        Ok(host) => host,
        Err(error) => {
            return HealthCheck::new(
                "godot-language-server",
                "Godot language server",
                HealthStatus::Degraded,
                format!("Godot's editor settings could not be read: {error}"),
            );
        }
    };
    if godot_session::is_loopback(&host) {
        return HealthCheck::new(
            "godot-language-server",
            "Godot language server",
            HealthStatus::Ok,
            format!("Godot's language server answers on {host}."),
        );
    }
    HealthCheck::new(
        "godot-language-server",
        "Godot language server",
        HealthStatus::Blocked,
        format!(
            "Godot's editor setting network/language_server/remote_host is {host}. Gofer only \
             talks to the editor over loopback, so set it back to 127.0.0.1 in Godot under Editor \
             › Editor Settings › Network › Language Server."
        ),
    )
}

fn ai_check(ai: &AiHealth) -> HealthCheck {
    let endpoint = format!("{} · {}", ai.base_url, ai.model);
    match ai.reachability {
        AiReachability::Connected => HealthCheck::new(
            "ai-connection",
            "AI model",
            HealthStatus::Ok,
            format!("Connected to {endpoint}."),
        ),
        // An unreachable server is the ordinary state of a local model that has not been started
        // yet, so it never blocks the workspace — the rest of Gofer still works without it.
        AiReachability::Unreachable | AiReachability::ServerError => HealthCheck::new(
            "ai-connection",
            "AI model",
            HealthStatus::Degraded,
            format!(
                "{} Gofer cannot chat until it answers. Start the server, or change where Gofer \
                 looks under Settings › AI connection. ({endpoint})",
                ai.message
            ),
        ),
        AiReachability::Unauthorized => HealthCheck::new(
            "ai-connection",
            "AI model",
            HealthStatus::Degraded,
            format!(
                "{} Add or correct the API key under Settings › AI connection. ({endpoint})",
                ai.message
            ),
        ),
        AiReachability::ModelUnavailable => HealthCheck::new(
            "ai-connection",
            "AI model",
            HealthStatus::Degraded,
            format!(
                "{} Choose a model this server serves under Settings › AI connection.",
                ai.message
            ),
        ),
    }
}

fn formatter_check(error: Option<&str>) -> HealthCheck {
    let Some(error) = error else {
        return HealthCheck::new(
            "formatter",
            "GDScript formatter",
            HealthStatus::Ok,
            "The gdformat sidecar is available.",
        );
    };
    HealthCheck::new(
        "formatter",
        "GDScript formatter",
        HealthStatus::Degraded,
        format!(
            "{error}. Everything else works; only Format Document is unavailable. Build the \
             sidecar with npm run build:gdformat, or set GOFER_GDFORMAT to a gdformat binary."
        ),
    )
}

/// Applies one of the repairs that only needs the workspace path.
///
/// The remedies that change Gofer's own settings — the workspace folder and the Godot binary —
/// belong to the caller, which owns the settings file.
pub fn apply(workspace: &Path, action: RemedyAction) -> Result<(), String> {
    match action {
        RemedyAction::InitializeGitRepository => git::initialize_repository(workspace),
        RemedyAction::SetGitIdentity => {
            git::set_local_identity(workspace, FALLBACK_IDENTITY_NAME, FALLBACK_IDENTITY_EMAIL)
        }
        RemedyAction::CommitProjectFiles => git::commit_project_files(workspace),
        RemedyAction::CreateGodotProject => create_starter_project(workspace),
        RemedyAction::ChooseWorkspace | RemedyAction::LocateGodotBinary => {
            Err("That fix is applied by Gofer itself, not by the workspace.".to_owned())
        }
    }
}

/// Writes the smallest project Godot will open, plus the scene it names.
///
/// Neither file is written over one that already exists: a folder with a `main.tscn` the user made
/// is a folder whose scene Gofer has no business replacing.
fn create_starter_project(workspace: &Path) -> Result<(), String> {
    let name = workspace
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("Godot Project");
    let project = STARTER_PROJECT_FILE.replace("{name}", &name.replace('"', ""));
    write_new_file(&workspace.join(crate::addon::PROJECT_FILE), &project)?;
    write_new_file(&workspace.join("main.tscn"), STARTER_MAIN_SCENE)
}

fn write_new_file(path: &Path, contents: &str) -> Result<(), String> {
    if path.exists() {
        return Ok(());
    }
    fs::write(path, contents).map_err(|error| {
        format!(
            "Could not write {}: {error}. Check that the folder is writable.",
            path.display()
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;
    use tempfile::TempDir;

    fn input(workspace: &Path) -> HealthInput {
        HealthInput {
            workspace: workspace.to_path_buf(),
            workspace_source: WorkspaceSource::WorkingDirectory,
            storage_error: None,
            godot: godot_session::BinaryProbe {
                binary: Some("godot4".to_owned()),
                version: Some("4.7.1.stable".to_owned()),
                error: None,
            },
            ai: AiHealth {
                base_url: "http://127.0.0.1:8080/v1".to_owned(),
                model: "test-model".to_owned(),
                reachability: AiReachability::Connected,
                message: "Connected.".to_owned(),
            },
            formatter_error: None,
        }
    }

    fn check<'a>(report: &'a HealthReport, id: &str) -> &'a HealthCheck {
        report
            .checks
            .iter()
            .find(|check| check.id == id)
            .unwrap_or_else(|| panic!("the report is missing the {id} check"))
    }

    fn git(directory: &Path, arguments: &[&str]) {
        let status = Command::new("git")
            .args(arguments)
            .current_dir(directory)
            .status()
            .expect("run Git");
        assert!(status.success(), "git {arguments:?}");
    }

    /// The report the user in an empty folder actually sees: every missing piece at once, each with
    /// the button that supplies it.
    #[test]
    fn an_empty_folder_reports_every_missing_piece_with_a_fix() {
        let directory = TempDir::new().expect("temporary directory");

        let report = report(&input(directory.path()));

        assert!(!report.is_ready);
        let repository = check(&report, "git-repository");
        assert_eq!(repository.status, HealthStatus::Blocked);
        assert_eq!(
            repository.remedy.as_ref().map(|remedy| remedy.action),
            Some(RemedyAction::InitializeGitRepository)
        );
        let project = check(&report, "godot-project");
        assert_eq!(project.status, HealthStatus::Blocked);
        assert_eq!(
            project.remedy.as_ref().map(|remedy| remedy.action),
            Some(RemedyAction::CreateGodotProject)
        );
        // Every blocked check has to be answerable from the report itself.
        for blocked in report
            .checks
            .iter()
            .filter(|check| check.status == HealthStatus::Blocked)
        {
            assert!(
                blocked.remedy.is_some() || blocked.detail.contains("http"),
                "the {} check blocks with neither a fix nor an instruction: {}",
                blocked.id,
                blocked.detail
            );
        }
    }

    /// The failure that used to leave the window unopened: a repository with no commit.
    #[test]
    fn a_repository_without_commits_offers_the_first_commit() {
        let directory = TempDir::new().expect("temporary directory");
        git(directory.path(), &["init", "-b", "main"]);
        git(directory.path(), &["config", "user.name", "Test"]);
        git(directory.path(), &["config", "user.email", "test@local"]);

        let report = report(&input(directory.path()));

        let history = check(&report, "git-history");
        assert_eq!(history.status, HealthStatus::Blocked);
        assert_eq!(
            history.remedy.as_ref().map(|remedy| remedy.action),
            Some(RemedyAction::CommitProjectFiles)
        );

        apply(directory.path(), RemedyAction::CommitProjectFiles).expect("first commit");

        let repaired = super::report(&input(directory.path()));
        assert_eq!(check(&repaired, "git-history").status, HealthStatus::Ok);
    }

    /// The report used to call this workspace ready, and every task started in it then failed at
    /// "contains no project.godot" — the worktree was checked out from a commit holding nothing.
    #[test]
    fn a_project_missing_from_the_history_blocks_with_the_commit_fix() {
        let directory = TempDir::new().expect("temporary directory");
        git(directory.path(), &["init", "-b", "main"]);
        git(directory.path(), &["config", "user.name", "Test"]);
        git(directory.path(), &["config", "user.email", "test@local"]);
        git(
            directory.path(),
            &["commit", "--allow-empty", "-m", "Empty"],
        );
        fs::write(
            directory.path().join(crate::addon::PROJECT_FILE),
            "config_version=5\n",
        )
        .expect("project file");

        let report = report(&input(directory.path()));

        assert!(!report.is_ready);
        // On disk, so the Godot project check is satisfied and says nothing about the history.
        assert_eq!(check(&report, "godot-project").status, HealthStatus::Ok);
        let tracked = check(&report, "git-project-tracked");
        assert_eq!(tracked.status, HealthStatus::Blocked);
        assert_eq!(
            tracked.remedy.as_ref().map(|remedy| remedy.action),
            Some(RemedyAction::CommitProjectFiles)
        );

        apply(directory.path(), RemedyAction::CommitProjectFiles).expect("commit the project");

        let repaired = super::report(&input(directory.path()));
        assert!(
            repaired
                .checks
                .iter()
                .all(|check| check.id != "git-project-tracked")
        );
        assert!(repaired.is_ready);
    }

    /// The identity fix has to make committing possible, not merely record two strings.
    #[test]
    fn the_identity_fix_makes_the_first_commit_possible() {
        let directory = TempDir::new().expect("temporary directory");
        git(directory.path(), &["init", "-b", "main"]);
        // Global identity is whatever the machine running the suite has, so the check is only
        // meaningful once this repository is known to have none of its own.
        git(
            directory.path(),
            &["config", "--local", "user.useConfigOnly", "true"],
        );

        apply(directory.path(), RemedyAction::SetGitIdentity).expect("identity");
        apply(directory.path(), RemedyAction::CommitProjectFiles).expect("first commit");

        let report = report(&input(directory.path()));
        assert_eq!(check(&report, "git-identity").status, HealthStatus::Ok);
        assert_eq!(check(&report, "git-history").status, HealthStatus::Ok);
    }

    #[test]
    fn the_starter_project_makes_the_folder_a_godot_project() {
        let directory = TempDir::new().expect("temporary directory");

        apply(directory.path(), RemedyAction::CreateGodotProject).expect("starter project");

        let report = report(&input(directory.path()));
        assert_eq!(check(&report, "godot-project").status, HealthStatus::Ok);
        let project = fs::read_to_string(directory.path().join(crate::addon::PROJECT_FILE))
            .expect("project file");
        assert!(project.contains("run/main_scene=\"res://main.tscn\""));
        assert!(directory.path().join("main.tscn").is_file());
    }

    /// A folder that already holds a game must not have its scene replaced by the starter one.
    #[test]
    fn the_starter_project_never_overwrites_existing_files() {
        let directory = TempDir::new().expect("temporary directory");
        fs::write(directory.path().join("main.tscn"), "the user's scene").expect("scene");

        apply(directory.path(), RemedyAction::CreateGodotProject).expect("starter project");

        assert_eq!(
            fs::read_to_string(directory.path().join("main.tscn")).expect("scene"),
            "the user's scene"
        );
    }

    /// A missing engine is a wall; a missing formatter is an inconvenience. They must not be
    /// reported the same way, or the user cannot tell which one is stopping them.
    #[test]
    fn a_missing_formatter_is_degraded_and_a_missing_engine_blocks() {
        let directory = TempDir::new().expect("temporary directory");
        let mut probe = input(directory.path());
        probe.formatter_error = Some("Formatting is disabled".to_owned());
        probe.godot = godot_session::BinaryProbe {
            binary: None,
            version: None,
            error: Some("Godot was not found on the path.".to_owned()),
        };

        let report = report(&probe);

        assert_eq!(check(&report, "formatter").status, HealthStatus::Degraded);
        let editor = check(&report, "godot-editor");
        assert_eq!(editor.status, HealthStatus::Blocked);
        assert_eq!(
            editor.remedy.as_ref().map(|remedy| remedy.action),
            Some(RemedyAction::LocateGodotBinary)
        );
        assert!(!report.is_ready);
    }

    /// An AI server that is merely not running yet must not lock the user out of the workspace.
    #[test]
    fn an_unreachable_ai_server_does_not_block_the_workspace() {
        let directory = TempDir::new().expect("temporary directory");
        git(directory.path(), &["init", "-b", "main"]);
        git(directory.path(), &["config", "user.name", "Test"]);
        git(directory.path(), &["config", "user.email", "test@local"]);
        apply(directory.path(), RemedyAction::CreateGodotProject).expect("starter project");
        apply(directory.path(), RemedyAction::CommitProjectFiles).expect("first commit");
        let mut probe = input(directory.path());
        probe.ai.reachability = AiReachability::Unreachable;
        probe.ai.message = "The AI server could not be reached.".to_owned();

        let report = report(&probe);

        assert_eq!(
            check(&report, "ai-connection").status,
            HealthStatus::Degraded
        );
        assert!(report.is_ready, "{:?}", report.checks);
    }

    /// Git missing and "this is not a repository" are one answer from `rev-parse`, and opposite
    /// instructions.
    #[test]
    fn a_missing_git_reports_its_own_installation_rather_than_the_repository() {
        let repository = git::RepositoryStatus::default();

        let checks = git_checks(Path::new("/somewhere"), &repository);

        assert_eq!(checks.len(), 1);
        assert_eq!(checks[0].id, "git-installed");
        assert!(checks[0].detail.contains("git-scm.com"));
    }
}

//! The fixtures the six views' tests are written against: a project on disk, a Git worktree, and a
//! recorder that says which workspaces a Switch was asked to release.
//!
//! One file, because a fixture six test modules reach for belongs to none of them. Compiled only
//! under `cfg(test)`, like the modules that use it.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tempfile::TempDir;

use super::*;

/// A Switch with nothing to stop, for the tests that are not about stopping anything.
pub(super) static NOTHING_TO_STOP: fn(&Path) -> Result<(), String> = |_| Ok(());

/// Records every workspace the Switch was asked to release, so a test can assert the order.
#[derive(Default)]
pub(super) struct Released(pub(super) Mutex<Vec<PathBuf>>);

impl Released {
    pub(super) fn recording(&self) -> impl Fn(&Path) -> Result<(), String> + use<'_> {
        move |path| {
            self.0
                .lock()
                .expect("the recorder")
                .push(path.to_path_buf());
            Ok(())
        }
    }

    pub(super) fn paths(&self) -> Vec<PathBuf> {
        self.0.lock().expect("the recorder").clone()
    }
}

pub(super) fn attachment(id: &str) -> StoredAttachment {
    StoredAttachment {
        id: id.to_owned(),
        name: "scene.png".to_owned(),
        mime_type: "image/png".to_owned(),
        size: 2,
    }
}

pub(super) fn storage(directory: &TempDir) -> ProjectStorage {
    let workspace = directory.path().join("workspace");
    fs::create_dir(&workspace).expect("workspace directory");
    ProjectStorage::open(&directory.path().join("data"), &workspace).expect("storage")
}

pub(super) fn git(directory: &Path, arguments: &[&str]) {
    let output = std::process::Command::new("git")
        .args(arguments)
        .current_dir(directory)
        .output()
        .expect("run Git");
    assert!(
        output.status.success(),
        "git {}: {}",
        arguments.join(" "),
        String::from_utf8_lossy(&output.stderr)
    );
}

/// Turns a workspace into the repository the health check's fixes would leave behind.
pub(super) fn make_repository(workspace: &Path) {
    git(workspace, &["init", "-b", "main"]);
    git(workspace, &["config", "user.name", "Gofer"]);
    git(workspace, &["config", "user.email", "gofer@localhost"]);
    fs::write(workspace.join("project.godot"), "config_version=5\n").expect("project file");
    git(workspace, &["add", "--all"]);
    git(workspace, &["commit", "-m", "Add the Godot project"]);
}

pub(super) fn git_text(workspace: &Path, arguments: &[&str]) -> String {
    let output = std::process::Command::new("git")
        .args(arguments)
        .current_dir(workspace)
        .output()
        .expect("run Git");
    assert!(
        output.status.success(),
        "git {arguments:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_owned()
}

/// A workspace a task worktree can actually branch from: a repository with one commit in it.
pub(super) fn committed_repository(root: &Path) -> PathBuf {
    let workspace = root.join("workspace");
    fs::create_dir(&workspace).expect("workspace directory");
    git_text(&workspace, &["init", "-b", "master"]);
    git_text(&workspace, &["config", "user.name", "Gofer Test"]);
    git_text(
        &workspace,
        &["config", "user.email", "gofer@example.invalid"],
    );
    fs::write(workspace.join("project.godot"), "[application]\n").expect("project file");
    git_text(&workspace, &["add", "project.godot"]);
    git_text(&workspace, &["commit", "-m", "Initial"]);
    workspace
}

/// A repository started over where one already was, keeping the files on disk. Answers the
/// commit the new history stands at.
pub(super) fn committed_repository_in_place(workspace: &Path) -> String {
    git_text(workspace, &["init", "-b", "master"]);
    git_text(workspace, &["config", "user.name", "Gofer Test"]);
    git_text(
        workspace,
        &["config", "user.email", "gofer@example.invalid"],
    );
    git_text(workspace, &["add", "--all", "--", "."]);
    git_text(workspace, &["commit", "-m", "Start over"]);
    git_text(workspace, &["rev-parse", "HEAD"])
}

pub(super) fn kept(sketch_id: &str, label: &str, shown: &str, source: &str) -> KeptSketch<'static> {
    // Leaked deliberately and only here: a test fixture that outlives the borrow is cheaper to
    // read than threading four owned strings through every call.
    KeptSketch {
        sketch_id: Box::leak(sketch_id.to_owned().into_boxed_str()),
        question_id: "question-1",
        task_id: None,
        question: "Where does the pause menu go?",
        label: Box::leak(label.to_owned().into_boxed_str()),
        shown_html: Box::leak(shown.to_owned().into_boxed_str()),
        source_html: Box::leak(source.to_owned().into_boxed_str()),
        is_approved: true,
    }
}

/// Cutoffs a fixture is written against: everything already in it is spent.
///
/// A test says what it is about by moving one field off this, rather than by arithmetic on the
/// clock that has to be read twice to see which side of the edge a row is on.
pub(super) fn everything_is_old() -> Cutoffs {
    Cutoffs {
        attachments_before: i64::MAX,
        runs_before: i64::MAX,
        corpus_version: Some("2.0.0".to_owned()),
        backups_kept: 5,
    }
}

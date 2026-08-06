use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

#[derive(Clone, Debug)]
pub struct CreatedWorktree {
    pub branch_name: String,
    pub worktree_path: PathBuf,
    pub base_commit: String,
    pub head_commit: String,
}

#[derive(Clone, Debug)]
pub struct MergeResult {
    pub head_commit: String,
    pub merged_commit: String,
}

pub fn create_task_worktree(
    workspace_path: &Path,
    worktree_path: &Path,
    branch_name: &str,
) -> Result<Option<CreatedWorktree>, String> {
    let Some(repository_root) = repository_root(workspace_path)? else {
        return Ok(None);
    };
    if worktree_path.exists() {
        return Err(format!(
            "The task worktree path already exists: {}",
            worktree_path.display()
        ));
    }
    let base_commit = git_text(&repository_root, &["rev-parse", "HEAD"])?;
    let parent = worktree_path
        .parent()
        .ok_or_else(|| "The task worktree path has no parent".to_owned())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create {}: {error}", parent.display()))?;
    let target = worktree_path
        .to_str()
        .ok_or_else(|| "The task worktree path is not valid UTF-8".to_owned())?;
    let output = git_output(
        &repository_root,
        &["worktree", "add", "-b", branch_name, target, &base_commit],
    )?;
    if !output.status.success() {
        return Err(git_failure("create the task worktree", &output));
    }
    let head_commit = git_text(worktree_path, &["rev-parse", "HEAD"])?;
    Ok(Some(CreatedWorktree {
        branch_name: branch_name.to_owned(),
        worktree_path: worktree_path.to_path_buf(),
        base_commit,
        head_commit,
    }))
}

/// Merges a task branch into the project.
///
/// `staged_project_file` is the content `project.godot` should be *recorded* with, for a task whose
/// editor session is still running: staging the Gofer addon adds two lines to that file, and they
/// belong to Gofer rather than to the user's game. It is committed instead of the working copy,
/// which is left alone — the editor is still reading it.
pub fn merge_task_worktree(
    workspace_path: &Path,
    worktree_path: &Path,
    branch_name: &str,
    staged_project_file: Option<&str>,
) -> Result<MergeResult, String> {
    let repository_root = repository_root(workspace_path)?
        .ok_or_else(|| "The project is not a Git repository".to_owned())?;
    ensure_clean(&repository_root)?;
    commit_pending_task_changes(worktree_path, staged_project_file)?;
    let head_commit = git_text(worktree_path, &["rev-parse", "HEAD"])?;
    let output = git_output(
        &repository_root,
        &["merge", "--no-commit", "--no-ff", branch_name],
    )?;
    if !output.status.success() {
        let _ = git_output(&repository_root, &["merge", "--abort"]);
        return Err(git_failure("merge the task branch", &output));
    }
    // A task whose branch carries no commits of its own is not a failure to merge; it is nothing
    // to merge. Git answers "Already up to date" and stages nothing, and `git commit` then refuses
    // the empty commit — which reached the user as a bare "Git exited with exit status: 1",
    // because that refusal goes to stdout and leaves stderr empty.
    if git_text(&repository_root, &["status", "--porcelain"])?.is_empty() {
        return Ok(MergeResult {
            merged_commit: git_text(&repository_root, &["rev-parse", "HEAD"])?,
            head_commit,
        });
    }
    let message = format!("Merge task branch {branch_name}");
    let commit = git_output(&repository_root, &["commit", "-m", &message])?;
    if !commit.status.success() {
        let _ = git_output(&repository_root, &["merge", "--abort"]);
        return Err(git_failure("commit the task merge", &commit));
    }
    let merged_commit = git_text(&repository_root, &["rev-parse", "HEAD"])?;
    Ok(MergeResult {
        head_commit,
        merged_commit,
    })
}

fn commit_pending_task_changes(
    worktree_path: &Path,
    staged_project_file: Option<&str>,
) -> Result<(), String> {
    let is_clean = git_text(worktree_path, &["status", "--porcelain"])?.is_empty();
    if is_clean && staged_project_file.is_none() {
        return Ok(());
    }
    let add = git_output(worktree_path, &["add", "--all"])?;
    if !add.status.success() {
        return Err(git_failure("stage the task changes", &add));
    }
    if let Some(text) = staged_project_file {
        stage_content(worktree_path, crate::addon::PROJECT_FILE, text)?;
    }
    // Overriding the project file can leave the index identical to HEAD — a task that changed
    // nothing but the addon's own two lines — and Git refuses an empty commit.
    if git_text(worktree_path, &["diff", "--cached", "--name-only"])?.is_empty() {
        return Ok(());
    }
    let commit = git_output(worktree_path, &["commit", "-m", "Complete Gofer task"])?;
    if !commit.status.success() {
        return Err(git_failure("commit the task changes", &commit));
    }
    Ok(())
}

/// Records `text` as the content of `path` in the index, leaving the file on disk untouched.
fn stage_content(worktree_path: &Path, path: &str, text: &str) -> Result<(), String> {
    let mut child = git_command(
        worktree_path,
        &["hash-object", "-w", "--path", path, "--stdin"],
    )
    .stdin(Stdio::piped())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .spawn()
    .map_err(|error| format!("Could not start Git: {error}"))?;
    child
        .stdin
        .take()
        .ok_or_else(|| "Git would not accept the project file".to_owned())?
        .write_all(text.as_bytes())
        .map_err(|error| format!("Could not write the project file to Git: {error}"))?;
    let output = child
        .wait_with_output()
        .map_err(|error| format!("Could not read Git's answer: {error}"))?;
    if !output.status.success() {
        return Err(git_failure("record the project file", &output));
    }
    let hash = output_text(&output)?;
    let entry = format!("100644,{hash},{path}");
    let update = git_output(worktree_path, &["update-index", "--cacheinfo", &entry])?;
    if !update.status.success() {
        return Err(git_failure("stage the project file", &update));
    }
    Ok(())
}

pub fn discard_created_worktree(workspace_path: &Path, worktree_path: &Path, branch_name: &str) {
    let Ok(Some(repository_root)) = repository_root(workspace_path) else {
        return;
    };
    if let Some(target) = worktree_path.to_str() {
        let _ = git_output(&repository_root, &["worktree", "remove", "--force", target]);
    }
    let _ = git_output(&repository_root, &["branch", "-D", branch_name]);
}

/// The Git directory shared by the main checkout and every linked worktree. Per-repository excludes
/// live there, so an entry written for one task worktree is visible to all of them.
pub fn common_directory(path: &Path) -> Option<PathBuf> {
    let output = git_output(path, &["rev-parse", "--git-common-dir"]).ok()?;
    if !output.status.success() {
        return None;
    }
    let text = output_text(&output).ok()?;
    if text.is_empty() {
        return None;
    }
    let directory = PathBuf::from(text);
    if directory.is_absolute() {
        return Some(directory);
    }
    Some(path.join(directory))
}

fn repository_root(path: &Path) -> Result<Option<PathBuf>, String> {
    let output = match git_output(path, &["rev-parse", "--show-toplevel"]) {
        Ok(output) => output,
        Err(error) if error.contains("Could not start Git") => return Ok(None),
        Err(error) => return Err(error),
    };
    if !output.status.success() {
        return Ok(None);
    }
    let root = output_text(&output)?;
    Ok(Some(PathBuf::from(root)))
}

fn ensure_clean(repository_root: &Path) -> Result<(), String> {
    let status = git_text(repository_root, &["status", "--porcelain"])?;
    if !status.is_empty() {
        return Err("The main project worktree must be clean before merging a task".to_owned());
    }
    Ok(())
}

fn git_text(directory: &Path, arguments: &[&str]) -> Result<String, String> {
    let output = git_output(directory, arguments)?;
    if !output.status.success() {
        return Err(git_failure("run Git", &output));
    }
    output_text(&output)
}

fn git_output(directory: &Path, arguments: &[&str]) -> Result<Output, String> {
    git_command(directory, arguments)
        .output()
        .map_err(|error| format!("Could not start Git: {error}"))
}

/// Git, detached from whatever repository the caller's own environment points at.
fn git_command(directory: &Path, arguments: &[&str]) -> Command {
    let mut command = Command::new("git");
    command
        .args(arguments)
        .current_dir(directory)
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE")
        .env_remove("GIT_OBJECT_DIRECTORY")
        .env_remove("GIT_ALTERNATE_OBJECT_DIRECTORIES")
        .env_remove("GIT_COMMON_DIR")
        .env_remove("GIT_PREFIX");
    command
}

fn output_text(output: &Output) -> Result<String, String> {
    String::from_utf8(output.stdout.clone())
        .map(|value| value.trim().to_owned())
        .map_err(|error| format!("Git returned non-UTF-8 output: {error}"))
}

fn git_failure(action: &str, output: &Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    if stderr.is_empty() {
        return format!("Could not {action}: Git exited with {}", output.status);
    }
    format!("Could not {action}: {stderr}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn git(directory: &Path, arguments: &[&str]) {
        let output = git_output(directory, arguments).expect("run Git");
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn repository() -> TempDir {
        let directory = TempDir::new().expect("temporary repository");
        git(directory.path(), &["init", "-b", "master"]);
        git(directory.path(), &["config", "user.name", "Gofer Test"]);
        git(
            directory.path(),
            &["config", "user.email", "gofer@example.invalid"],
        );
        fs::write(directory.path().join("project.godot"), "[application]\n").expect("project file");
        git(directory.path(), &["add", "project.godot"]);
        git(directory.path(), &["commit", "-m", "Initial"]);
        directory
    }

    #[test]
    fn creates_and_merges_an_isolated_task_worktree() {
        let repository = repository();
        let worktree_root = TempDir::new().expect("temporary worktree root");
        let worktree = worktree_root.path().join("task-worktree");
        let created = create_task_worktree(repository.path(), &worktree, "gofer/task-test")
            .expect("create worktree")
            .expect("Git worktree");
        fs::write(worktree.join("player.gd"), "extends Node\n").expect("task change");

        let merged = merge_task_worktree(repository.path(), &worktree, &created.branch_name, None)
            .expect("merge task");

        assert_ne!(merged.head_commit, created.head_commit);
        assert!(repository.path().join("player.gd").is_file());
        assert_eq!(
            git_text(repository.path(), &["rev-parse", "HEAD"]).expect("merged HEAD"),
            merged.merged_commit
        );
    }

    /// A task merged while its editor session runs must not carry Gofer's own two `project.godot`
    /// lines into the project: they are removed when the session stops, and a merge that recorded
    /// them would leave them in the history where nothing ever takes them out again.
    #[test]
    fn the_project_file_is_recorded_without_what_the_addon_added() {
        let repository = repository();
        let worktree_root = TempDir::new().expect("temporary worktree root");
        let worktree = worktree_root.path().join("task-worktree");
        let created = create_task_worktree(repository.path(), &worktree, "gofer/task-staged")
            .expect("create worktree")
            .expect("Git worktree");
        let staged = "[application]\nrun/main_scene=\"res://level.tscn\"\n\n[editor_plugins]\n\nenabled=PackedStringArray(\"res://addons/gofer/plugin.cfg\")\n";
        fs::write(worktree.join("project.godot"), staged).expect("staged project file");
        fs::write(worktree.join("level.tscn"), "[gd_scene]\n").expect("task change");
        let user = "[application]\nrun/main_scene=\"res://level.tscn\"\n";

        merge_task_worktree(
            repository.path(),
            &worktree,
            &created.branch_name,
            Some(user),
        )
        .expect("merge task");

        assert_eq!(
            fs::read_to_string(repository.path().join("project.godot")).expect("merged project"),
            user,
            "the merge must record the project file the user's game has"
        );
        assert_eq!(
            fs::read_to_string(worktree.join("project.godot")).expect("worktree project"),
            staged,
            "the running editor's own copy must be left alone"
        );
        assert!(repository.path().join("level.tscn").is_file());
    }

    #[test]
    fn merge_refuses_a_dirty_main_worktree() {
        let repository = repository();
        let worktree_root = TempDir::new().expect("temporary worktree root");
        let worktree = worktree_root.path().join("task-worktree");
        let created = create_task_worktree(repository.path(), &worktree, "gofer/task-dirty")
            .expect("create worktree")
            .expect("Git worktree");
        fs::write(repository.path().join("untracked.txt"), "dirty").expect("dirty file");

        let error = merge_task_worktree(repository.path(), &worktree, &created.branch_name, None)
            .expect_err("dirty merge must fail");

        assert!(error.contains("must be clean"));
    }

    #[test]
    fn non_repository_and_existing_worktree_paths_are_handled() {
        let directory = TempDir::new().expect("temporary non-repository");
        let target = directory.path().join("target");
        assert!(
            create_task_worktree(directory.path(), &target, "gofer/task-none")
                .expect("non-repository lookup")
                .is_none()
        );
        assert!(
            merge_task_worktree(directory.path(), &target, "gofer/task-none", None)
                .unwrap_err()
                .contains("not a Git repository")
        );
        discard_created_worktree(directory.path(), &target, "gofer/task-none");

        let repository = repository();
        fs::create_dir(&target).expect("existing worktree target");
        assert!(
            create_task_worktree(repository.path(), &target, "gofer/task-existing")
                .unwrap_err()
                .contains("already exists")
        );
    }

    /// A conflicting merge must leave the main checkout exactly as it was. Git stops mid-merge and
    /// keeps the conflict markers in the working tree unless someone aborts it, and the next task
    /// would then merge into that mess — so the abort is the assertion, not the error message.
    #[test]
    fn a_conflicting_merge_is_aborted_and_leaves_the_checkout_clean() {
        let repository = repository();
        let worktree_root = TempDir::new().expect("temporary worktree root");
        let worktree = worktree_root.path().join("task-worktree");
        let created = create_task_worktree(repository.path(), &worktree, "gofer/task-conflict")
            .expect("create worktree")
            .expect("Git worktree");
        fs::write(
            worktree.join("project.godot"),
            "[application]\nname=\"task\"\n",
        )
        .expect("task edit");
        fs::write(
            repository.path().join("project.godot"),
            "[application]\nname=\"main\"\n",
        )
        .expect("main edit");
        git(repository.path(), &["add", "project.godot"]);
        git(repository.path(), &["commit", "-m", "Main edit"]);

        let error = merge_task_worktree(repository.path(), &worktree, &created.branch_name, None)
            .expect_err("two edits to one file must conflict");

        assert!(error.contains("merge the task branch"), "{error}");
        assert_eq!(
            git_text(repository.path(), &["status", "--porcelain"]).expect("status"),
            "",
            "the failed merge must be aborted, not left half-applied"
        );
    }

    /// A task that changed nothing still merges. Two separate places have to notice the emptiness:
    /// `commit_pending_task_changes` must not ask Git to record an empty commit, and the merge
    /// itself must not try to commit a merge Git already called "Already up to date". Before this
    /// was handled, completing a task that edited nothing failed with a bare "Git exited with
    /// exit status: 1".
    #[test]
    fn a_task_that_changed_nothing_merges_without_a_commit() {
        let repository = repository();
        let worktree_root = TempDir::new().expect("temporary worktree root");
        let worktree = worktree_root.path().join("task-worktree");
        let created = create_task_worktree(repository.path(), &worktree, "gofer/task-empty")
            .expect("create worktree")
            .expect("Git worktree");
        let before = git_text(repository.path(), &["rev-parse", "HEAD"]).expect("HEAD");

        let merged = merge_task_worktree(repository.path(), &worktree, &created.branch_name, None)
            .expect("an unchanged task still merges");

        assert_eq!(
            merged.head_commit, created.head_commit,
            "nothing was committed on the task branch"
        );
        assert_eq!(
            merged.merged_commit, before,
            "and nothing was committed on the main branch either"
        );
        assert_eq!(
            git_text(repository.path(), &["status", "--porcelain"]).expect("status"),
            "",
            "the checkout is left exactly as it was found"
        );
    }

    /// The branch name is the one part of a worktree request that Git can reject on its own, and
    /// the failure has to arrive as the named error rather than as a silent `None`.
    #[test]
    fn a_branch_name_already_in_use_is_refused_by_name() {
        let repository = repository();
        let worktree_root = TempDir::new().expect("temporary worktree root");
        create_task_worktree(
            repository.path(),
            &worktree_root.path().join("first"),
            "gofer/task-twice",
        )
        .expect("create worktree")
        .expect("Git worktree");

        let error = create_task_worktree(
            repository.path(),
            &worktree_root.path().join("second"),
            "gofer/task-twice",
        )
        .expect_err("one branch cannot back two worktrees");

        assert!(error.contains("create the task worktree"), "{error}");
    }

    /// Per-repository excludes are written into the common Git directory so one task's entry is
    /// visible from every linked worktree. Outside a repository there is no such directory, and
    /// answering with a path anyway would write the exclude somewhere nobody reads.
    #[test]
    fn the_common_directory_is_absolute_inside_a_repository_and_absent_outside_one() {
        let repository = repository();
        let worktree_root = TempDir::new().expect("temporary worktree root");
        let worktree = worktree_root.path().join("task-worktree");
        create_task_worktree(repository.path(), &worktree, "gofer/task-common")
            .expect("create worktree")
            .expect("Git worktree");

        let from_main = common_directory(repository.path()).expect("common directory");
        let from_worktree = common_directory(&worktree).expect("common directory");

        assert!(from_main.is_absolute(), "{}", from_main.display());
        assert!(from_worktree.is_absolute(), "{}", from_worktree.display());
        assert!(from_main.ends_with(".git"), "{}", from_main.display());
        assert_eq!(
            fs::canonicalize(&from_main).expect("canonical main"),
            fs::canonicalize(&from_worktree).expect("canonical worktree"),
            "a linked worktree shares the main checkout's Git directory"
        );

        let outside = TempDir::new().expect("temporary non-repository");
        assert!(common_directory(outside.path()).is_none());
    }
}

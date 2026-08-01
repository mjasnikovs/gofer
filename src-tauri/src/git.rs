use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

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

pub fn merge_task_worktree(
    workspace_path: &Path,
    worktree_path: &Path,
    branch_name: &str,
) -> Result<MergeResult, String> {
    let repository_root = repository_root(workspace_path)?
        .ok_or_else(|| "The project is not a Git repository".to_owned())?;
    ensure_clean(&repository_root)?;
    commit_pending_task_changes(worktree_path)?;
    let head_commit = git_text(worktree_path, &["rev-parse", "HEAD"])?;
    let output = git_output(
        &repository_root,
        &["merge", "--no-commit", "--no-ff", branch_name],
    )?;
    if !output.status.success() {
        let _ = git_output(&repository_root, &["merge", "--abort"]);
        return Err(git_failure("merge the task branch", &output));
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

fn commit_pending_task_changes(worktree_path: &Path) -> Result<(), String> {
    if git_text(worktree_path, &["status", "--porcelain"])?.is_empty() {
        return Ok(());
    }
    let add = git_output(worktree_path, &["add", "--all"])?;
    if !add.status.success() {
        return Err(git_failure("stage the task changes", &add));
    }
    let commit = git_output(worktree_path, &["commit", "-m", "Complete Gofer task"])?;
    if !commit.status.success() {
        return Err(git_failure("commit the task changes", &commit));
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
    Command::new("git")
        .args(arguments)
        .current_dir(directory)
        .output()
        .map_err(|error| format!("Could not start Git: {error}"))
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

        let merged = merge_task_worktree(repository.path(), &worktree, &created.branch_name)
            .expect("merge task");

        assert_ne!(merged.head_commit, created.head_commit);
        assert!(repository.path().join("player.gd").is_file());
        assert_eq!(
            git_text(repository.path(), &["rev-parse", "HEAD"]).expect("merged HEAD"),
            merged.merged_commit
        );
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

        let error = merge_task_worktree(repository.path(), &worktree, &created.branch_name)
            .expect_err("dirty merge must fail");

        assert!(error.contains("must be clean"));
    }
}

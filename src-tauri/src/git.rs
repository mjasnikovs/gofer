use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

/// Godot's own cache directory, which no repository should be carrying.
///
/// Godot rewrites it whenever the editor opens: import records, folding state, the filesystem scan,
/// a UID map. None of it is the game, all of it differs between machines, and every one of Gofer's
/// checkouts touches it. Tracked, it turns every task switch into a commit of nothing — and a
/// commit of nothing still moves the branch, which is how a merged task comes back asking to be
/// merged again.
const EDITOR_CACHE_DIRECTORY: &str = ".godot";

const IGNORE_FILE: &str = ".gitignore";

/// What is appended to a project's ignore file, first line included: a rule with no reason next to
/// it is a rule the next person deletes.
const EDITOR_CACHE_IGNORE: &str = "\n# Godot's editor cache. Rewritten on every open, and never the same on two machines.\n.godot/\n";

/// A task's branch, as it stood when the task was given one.
///
/// There is no path: every task works in the project's own checkout. Gofer used to give each task a
/// linked worktree, which cost a full copy of the game per task and threw away Godot's import cache
/// with it. One checkout keeps the cache, and Godot reimports only the files a branch actually
/// changed.
#[derive(Clone, Debug)]
pub struct CreatedBranch {
    pub branch_name: String,
    pub base_commit: String,
    pub head_commit: String,
}

#[derive(Clone, Debug)]
pub struct MergeResult {
    pub head_commit: String,
    pub merged_commit: String,
}

/// Creates a task's branch at the tip of `base_branch`, without checking it out.
///
/// The base is a branch and never `HEAD`, for the same reason the merge reads one: by the time a
/// task is created the checkout is sitting on whichever task was opened last, and a branch cut from
/// `HEAD` would inherit that task's work instead of the project's. Open an old task, press New, and
/// the new task starts from a commit the project moved past — every merge since is missing from it,
/// and the files look like the work was never done.
///
/// Falls back to `HEAD` when the base branch names no commit, which is the repository whose first
/// commit is not on it yet.
///
/// Answers `None` outside a repository, and the branch it already found when the task has one, so
/// this is also the repair path for a task whose branch survived a database that forgot it.
pub fn create_task_branch(
    workspace_path: &Path,
    branch_name: &str,
    base_branch: &str,
) -> Result<Option<CreatedBranch>, String> {
    let Some(repository_root) = repository_root(workspace_path)? else {
        return Ok(None);
    };
    let base_commit = match branch_commit(&repository_root, base_branch) {
        Some(commit) => commit,
        None => git_text(&repository_root, &["rev-parse", "HEAD"])?,
    };
    if branch_exists(&repository_root, branch_name) {
        return Ok(Some(CreatedBranch {
            branch_name: branch_name.to_owned(),
            head_commit: git_text(&repository_root, &["rev-parse", branch_name])?,
            base_commit,
        }));
    }
    let output = git_output(&repository_root, &["branch", branch_name, &base_commit])?;
    if !output.status.success() {
        return Err(git_failure("create the task branch", &output));
    }
    Ok(Some(CreatedBranch {
        branch_name: branch_name.to_owned(),
        head_commit: base_commit.clone(),
        base_commit,
    }))
}

/// Whether the workspace is the root of a Git repository of its own.
///
/// A project is opened before it is a repository — the window has to exist for the health check to
/// offer to make one — and everything branch-shaped has to stay optional until then.
pub fn is_repository(workspace_path: &Path) -> bool {
    matches!(repository_root(workspace_path), Ok(Some(_)))
}

/// The branch the checkout is on, or `None` on a detached `HEAD` or outside a repository.
pub fn current_branch(workspace_path: &Path) -> Option<String> {
    let output = git_output(workspace_path, &["symbolic-ref", "--short", "-q", "HEAD"]).ok()?;
    if !output.status.success() {
        return None;
    }
    let name = output_text(&output).ok()?;
    (!name.is_empty()).then_some(name)
}

pub fn branch_exists(workspace_path: &Path, branch_name: &str) -> bool {
    git_output(
        workspace_path,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("refs/heads/{branch_name}"),
        ],
    )
    .is_ok_and(|output| output.status.success())
}

/// Where a branch stands now, or `None` when there is no such branch to ask about.
pub fn branch_commit(workspace_path: &Path, branch_name: &str) -> Option<String> {
    let output = git_output(
        workspace_path,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("refs/heads/{branch_name}"),
        ],
    )
    .ok()?;
    if !output.status.success() {
        return None;
    }
    let commit = output_text(&output).ok()?;
    (!commit.is_empty()).then_some(commit)
}

/// Whether anything in the checkout is uncommitted. Work in the working tree belongs to whichever
/// branch is on disk, and it is work that branch has that its merge did not.
pub fn has_uncommitted_changes(workspace_path: &Path) -> bool {
    git_text(workspace_path, &["status", "--porcelain"]).is_ok_and(|status| !status.is_empty())
}

/// One loose file, and whether Git has ever seen it.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingChange {
    pub path: String,
    /// Untracked. A file the user copied in is always this, and is never anyone's work but theirs.
    pub is_new: bool,
}

/// Everything loose in the checkout, so the user can be told what a task switch is about to take.
pub fn pending_changes(workspace_path: &Path) -> Result<Vec<PendingChange>, String> {
    let status = git_text(workspace_path, &["status", "--porcelain", "-uall"])?;
    Ok(status.lines().filter_map(parse_status_line).collect())
}

fn parse_status_line(line: &str) -> Option<PendingChange> {
    if line.len() < 4 {
        return None;
    }
    let (code, rest) = line.split_at(2);
    let path = rest.trim_start().rsplit(" -> ").next()?.trim_matches('"');
    (!path.is_empty()).then(|| PendingChange {
        path: path.to_owned(),
        is_new: code == "??",
    })
}

/// Moves the checkout onto `branch_name`.
///
/// Git's own refusal is passed through rather than reworded. "Your local changes would be
/// overwritten by checkout" names the files, and the caller has no better sentence for a conflict
/// it did not create.
pub fn checkout_branch(workspace_path: &Path, branch_name: &str) -> Result<(), String> {
    let repository_root = repository_root(workspace_path)?
        .ok_or_else(|| "The project is not a Git repository".to_owned())?;
    if current_branch(&repository_root).as_deref() == Some(branch_name) {
        return Ok(());
    }
    let output = git_output(&repository_root, &["checkout", branch_name])?;
    if !output.status.success() {
        return Err(git_failure("switch to the task branch", &output));
    }
    Ok(())
}

/// Records everything in the checkout as a commit on whichever branch it is on.
///
/// A task keeps its work on its own branch, and the checkout is shared, so nothing may be left
/// loose when the working tree moves: uncommitted files follow a checkout into the next task and
/// arrive as that task's work. Answers whether there was anything to record.
pub fn commit_pending_changes(workspace_path: &Path) -> Result<bool, String> {
    let repository_root = repository_root(workspace_path)?
        .ok_or_else(|| "The project is not a Git repository".to_owned())?;
    commit_pending_task_changes(&repository_root)
}

/// Merges a task branch into the project's base branch, from the one checkout both share.
///
/// The checkout has to visit the base branch to merge into it, so `HEAD` moves twice and comes back
/// where it started. The task branch is fast-forwarded onto the merge before the return trip:
/// without it the task the user is still looking at points at the commit before their own work
/// landed, and the files under the editor would go backwards the moment the merge finished.
///
/// The caller stops the editor session first. That takes the addon's two lines back out of
/// `project.godot`, so there is no longer a working copy that must be committed as something other
/// than what it says.
pub fn merge_task_branch(
    workspace_path: &Path,
    branch_name: &str,
    base_branch: &str,
) -> Result<MergeResult, MergeFailure> {
    let repository_root = repository_root(workspace_path)?
        .ok_or_else(|| "The project is not a Git repository".to_owned())?;
    if current_branch(&repository_root).as_deref() != Some(branch_name) {
        return Err(format!("The project is not on the task branch {branch_name}").into());
    }
    if branch_name == base_branch {
        return Err("A task branch cannot be the project's own branch"
            .to_owned()
            .into());
    }
    let unresolved = unresolved_paths(&repository_root);
    if !unresolved.is_empty() {
        return Err(MergeFailure::Unfinished {
            message: unfinished_merge_message(&unresolved),
            paths: unresolved,
        });
    }
    commit_pending_task_changes(&repository_root)?;
    let head_commit = git_text(&repository_root, &["rev-parse", "HEAD"])?;

    checkout_branch(&repository_root, base_branch)?;
    let merged = merge_into_current(&repository_root, branch_name);
    let merged = match merged {
        Ok(merged) => merged,
        Err(error) => {
            let _ = checkout_branch(&repository_root, branch_name);
            return Err(error);
        }
    };
    let forward = git_output(
        &repository_root,
        &["branch", "-f", branch_name, base_branch],
    )?;
    if !forward.status.success() {
        let _ = checkout_branch(&repository_root, branch_name);
        return Err(git_failure("move the task branch onto the merge", &forward).into());
    }
    checkout_branch(&repository_root, branch_name)?;
    Ok(MergeResult {
        head_commit,
        merged_commit: merged,
    })
}

/// Brings the project's branch into the task's, and leaves whatever clashed for the agent to fix.
///
/// The opposite direction from [`merge_task_branch`], and deliberately: that one visits the base
/// branch, so a conflict there is a half-merged checkout of a branch the user is not looking at,
/// which is why it aborts. This one stays on the task branch, which is the worktree the agent
/// already works in and the files the user already has on screen. Git writes both sides into each
/// clashing file, so resolving one is editing a file — the thing the agent is for — rather than
/// driving a merge.
///
/// Answers the files left conflicted. An empty answer means the two branches merged on their own
/// and the merge is committed: the task now contains the project, and `merge_task_branch` will go
/// through.
pub fn resolve_task_conflicts(
    workspace_path: &Path,
    branch_name: &str,
    base_branch: &str,
) -> Result<Vec<String>, String> {
    let repository_root = repository_root(workspace_path)?
        .ok_or_else(|| "The project is not a Git repository".to_owned())?;
    if current_branch(&repository_root).as_deref() != Some(branch_name) {
        return Err(format!(
            "The project is not on the task branch {branch_name}"
        ));
    }
    if branch_name == base_branch {
        return Err("A task branch cannot be the project's own branch".to_owned());
    }
    if merge_in_progress(&repository_root) {
        return Err(
            "This task already has a merge waiting to be finished. Resolve the files it left \
             behind, or discard the merge, before starting another."
                .to_owned(),
        );
    }
    commit_pending_task_changes(&repository_root)?;
    let output = git_output(
        &repository_root,
        &["merge", "--no-commit", "--no-ff", base_branch],
    )?;
    if !output.status.success() {
        let conflicts = conflicting_paths(&repository_root);
        if conflicts.is_empty() {
            let _ = git_output(&repository_root, &["merge", "--abort"]);
            return Err(git_failure(
                "bring the project branch into the task",
                &output,
            ));
        }
        return Ok(conflicts);
    }
    if !merge_in_progress(&repository_root) {
        return Ok(Vec::new());
    }
    let message = format!("Merge {base_branch} into the task");
    let commit = git_output(&repository_root, &["commit", "-m", &message])?;
    if !commit.status.success() {
        let _ = git_output(&repository_root, &["merge", "--abort"]);
        return Err(git_failure(
            "commit the project branch into the task",
            &commit,
        ));
    }
    Ok(Vec::new())
}

/// Throws away a resolution merge, conflicts and all, and leaves the task as it was.
pub fn abandon_task_conflicts(workspace_path: &Path) -> Result<(), String> {
    let repository_root = repository_root(workspace_path)?
        .ok_or_else(|| "The project is not a Git repository".to_owned())?;
    let output = git_output(&repository_root, &["merge", "--abort"])?;
    if !output.status.success() {
        return Err(git_failure("discard the unfinished merge", &output));
    }
    Ok(())
}

/// Whether a merge has been started here and not yet committed or thrown away.
fn merge_in_progress(repository_root: &Path) -> bool {
    git_output(repository_root, &["rev-parse", "--verify", "MERGE_HEAD"])
        .map(|output| output.status.success())
        .unwrap_or(false)
}

/// The files a merge left that still hold both versions.
///
/// Not the same list as [`conflicting_paths`], and the difference is the whole point. Editing a
/// conflicted file does not clear its unmerged entry — only `git add` does — so an agent that
/// reconciled every file by writing it leaves Git naming all of them still. Asked the cheap way,
/// "the merge is unfinished" and "the work is unfinished" are the same answer, and the merge that
/// followed a perfectly good resolution was refused for files that no longer held a marker.
///
/// A marker in the file is what actually breaks a scene or a script if it is committed, so that is
/// what is looked for. A file Git could not merge and did not leave on disk — a delete against an
/// edit — carries no marker, and `git add --all` stages whichever side survived.
fn unresolved_paths(repository_root: &Path) -> Vec<String> {
    conflicting_paths(repository_root)
        .into_iter()
        .filter(|path| holds_conflict_markers(&repository_root.join(path)))
        .collect()
}

/// Whether a file still carries the markers Git writes around two versions it could not choose
/// between. Both ends, because `=======` alone is an ordinary line in Markdown and in ASCII art.
fn holds_conflict_markers(path: &Path) -> bool {
    let Ok(text) = fs::read_to_string(path) else {
        return false;
    };
    let mut opened = false;
    for line in text.lines() {
        if line.starts_with("<<<<<<<") {
            opened = true;
        } else if opened && line.starts_with(">>>>>>>") {
            return true;
        }
    }
    false
}

/// The files a stopped merge left unresolved. Read before the abort, which clears them.
fn conflicting_paths(repository_root: &Path) -> Vec<String> {
    git_text(repository_root, &["diff", "--name-only", "--diff-filter=U"])
        .map(|listing| {
            listing
                .lines()
                .map(str::trim)
                .filter(|line| !line.is_empty())
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

/// Why a task could not be merged.
///
/// A conflict is not a fault: both branches did legitimate work on the same file and somebody has
/// to say which wins. It carries the paths so the caller can offer that somebody — the agent — the
/// job, instead of handing the user a sentence and no way out of it. Everything else is already a
/// sentence written for the user.
#[derive(Debug)]
pub enum MergeFailure {
    /// Both branches changed the same files, and nothing was merged.
    Conflicted {
        paths: Vec<String>,
        message: String,
    },
    /// A resolution merge is open in the task and some of its files still hold both versions.
    Unfinished {
        paths: Vec<String>,
        message: String,
    },
    Failed(String),
}

/// What a task part-way through a resolution is told, wherever it is noticed.
fn unfinished_merge_message(unresolved: &[String]) -> String {
    format!(
        "This task is part-way through a merge and these files still hold both versions:\n{}\n\
         Resolve them — or discard the merge — before anything is committed.",
        unresolved
            .iter()
            .map(|path| format!("  {path}"))
            .collect::<Vec<_>>()
            .join("\n")
    )
}

impl From<String> for MergeFailure {
    fn from(message: String) -> Self {
        Self::Failed(message)
    }
}

impl From<crate::command_error::CommandError> for MergeFailure {
    /// A merge's own failures carry their own codes; a ledger failure on the way to one arrives
    /// already named, and this keeps its sentence.
    fn from(failure: crate::command_error::CommandError) -> Self {
        Self::Failed(failure.message)
    }
}

impl std::fmt::Display for MergeFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.message())
    }
}

impl MergeFailure {
    pub fn message(&self) -> &str {
        match self {
            Self::Conflicted { message, .. } | Self::Unfinished { message, .. } => message,
            Self::Failed(message) => message,
        }
    }

    /// The files that clashed, or none for a failure that was not a clash.
    pub fn conflicts(&self) -> &[String] {
        match self {
            Self::Conflicted { paths, .. } => paths,
            _ => &[],
        }
    }

    /// The files a stopped resolution left holding both versions, or none for anything else.
    pub fn unfinished(&self) -> &[String] {
        match self {
            Self::Unfinished { paths, .. } => paths,
            _ => &[],
        }
    }
}

/// Merges `branch_name` into whatever is checked out, and answers the commit that came of it.
fn merge_into_current(repository_root: &Path, branch_name: &str) -> Result<String, MergeFailure> {
    let output = git_output(
        repository_root,
        &["merge", "--no-commit", "--no-ff", branch_name],
    )?;
    if !output.status.success() {
        let conflicts = conflicting_paths(repository_root);
        let _ = git_output(repository_root, &["merge", "--abort"]);
        if !conflicts.is_empty() {
            let message = format!(
                "This task and the project both changed the same files, so Git cannot merge them \
                 on its own:\n{}\nNothing was merged and the task is untouched.",
                conflicts
                    .iter()
                    .map(|path| format!("  {path}"))
                    .collect::<Vec<_>>()
                    .join("\n")
            );
            return Err(MergeFailure::Conflicted {
                paths: conflicts,
                message,
            });
        }
        return Err(git_failure("merge the task branch", &output).into());
    }
    if git_text(repository_root, &["status", "--porcelain"])?.is_empty() {
        return Ok(git_text(repository_root, &["rev-parse", "HEAD"])?);
    }
    let message = format!("Merge task branch {branch_name}");
    let commit = git_output(repository_root, &["commit", "-m", &message])?;
    if !commit.status.success() {
        let _ = git_output(repository_root, &["merge", "--abort"]);
        return Err(git_failure("commit the task merge", &commit).into());
    }
    Ok(git_text(repository_root, &["rev-parse", "HEAD"])?)
}

fn commit_pending_task_changes(worktree_path: &Path) -> Result<bool, String> {
    let unresolved = unresolved_paths(worktree_path);
    if !unresolved.is_empty() {
        return Err(unfinished_merge_message(&unresolved));
    }
    let merging = merge_in_progress(worktree_path);
    let is_clean = git_text(worktree_path, &["status", "--porcelain"])?.is_empty();
    if is_clean && !merging {
        return Ok(false);
    }
    let add = git_output(worktree_path, &["add", "--all"])?;
    if !add.status.success() {
        return Err(git_failure("stage the task changes", &add));
    }
    if !merging && git_text(worktree_path, &["diff", "--cached", "--name-only"])?.is_empty() {
        return Ok(false);
    }
    let commit = git_output(worktree_path, &["commit", "-m", "Complete Gofer task"])?;
    if !commit.status.success() {
        return Err(git_failure("commit the task changes", &commit));
    }
    Ok(true)
}

/// Throws away a task's branch, moving off it first when it is the one checked out.
///
/// Git refuses to delete the branch `HEAD` points at, and a task being deleted is exactly the task
/// the user was most likely looking at.
pub fn discard_task_branch(workspace_path: &Path, branch_name: &str, base_branch: &str) {
    let Ok(Some(repository_root)) = repository_root(workspace_path) else {
        return;
    };
    if current_branch(&repository_root).as_deref() == Some(branch_name) {
        let _ = commit_pending_task_changes(&repository_root);
        let _ = checkout_branch(&repository_root, base_branch);
    }
    let _ = git_output(&repository_root, &["branch", "-D", branch_name]);
}

/// The branch a task's work is merged into, recorded the first time the project is opened.
///
/// Read while the project is still on its own branch, before any task has been opened. A project
/// opened while a task branch happened to be checked out must not adopt that as its base, or the
/// first merge would fold one task into another — so the fallback is a branch that exists and is not
/// Gofer's, and only then a name.
pub fn base_branch_candidate(workspace_path: &Path) -> Option<String> {
    let Ok(Some(repository_root)) = repository_root(workspace_path) else {
        return None;
    };
    if let Some(branch) = current_branch(&repository_root)
        && !branch.starts_with(TASK_BRANCH_PREFIX)
    {
        return Some(branch);
    }
    if let Some(default) = configured_default_branch(&repository_root)
        && branch_exists(&repository_root, &default)
    {
        return Some(default);
    }
    if let Ok(listed) = git_text(&repository_root, &["branch", "--format=%(refname:short)"])
        && let Some(branch) = listed
            .lines()
            .map(str::trim)
            .find(|name| !name.is_empty() && !name.starts_with(TASK_BRANCH_PREFIX))
    {
        return Some(branch.to_owned());
    }
    Some(configured_default_branch(&repository_root).unwrap_or_else(|| "master".to_owned()))
}

/// What this repository calls its default branch, when it says. Never a guess that it exists.
fn configured_default_branch(repository_root: &Path) -> Option<String> {
    if let Ok(head) = git_text(
        repository_root,
        &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    ) && let Some(branch) = head.trim().strip_prefix("origin/")
        && !branch.is_empty()
    {
        return Some(branch.to_owned());
    }
    git_text(repository_root, &["config", "--get", "init.defaultBranch"])
        .ok()
        .map(|name| name.trim().to_owned())
        .filter(|name| !name.is_empty())
}

/// The prefix every task branch carries. Kept here so the base-branch guard can recognise one.
pub const TASK_BRANCH_PREFIX: &str = "gofer/task-";

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
    let root = PathBuf::from(output_text(&output)?);
    let same_root = match (root.canonicalize(), path.canonicalize()) {
        (Ok(canonical_root), Ok(canonical_path)) => canonical_root == canonical_path,
        _ => false,
    };
    if !same_root {
        return Ok(None);
    }
    Ok(Some(root))
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

/// What the health check needs to know about the repository behind a workspace.
///
/// Every field is answered even when an earlier one already failed, because the report shows the
/// whole chain at once: a user whose folder is not a repository should still be able to read that
/// their Git is installed and their identity is set, rather than discover each missing piece one
/// restart at a time.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct RepositoryStatus {
    pub is_installed: bool,
    pub root: Option<PathBuf>,
    pub has_commit: bool,
    /// Whether the commit tasks branch from carries `project.godot`. A task worktree is a checkout
    /// of that commit, so a project file that is only on disk is a project the agent never sees.
    pub tracks_project_file: bool,
    /// Whether Godot's cache is in the history. Tracked, it makes every task switch commit a
    /// change no one made, and every merged task ask to be merged again.
    pub tracks_editor_cache: bool,
    pub has_identity: bool,
    pub is_clean: bool,
}

pub fn inspect(workspace: &Path) -> RepositoryStatus {
    if !is_installed() {
        return RepositoryStatus::default();
    }
    let root = repository_root(workspace).ok().flatten();
    let Some(root) = root else {
        return RepositoryStatus {
            is_installed: true,
            has_identity: has_identity(workspace),
            ..RepositoryStatus::default()
        };
    };
    RepositoryStatus {
        is_installed: true,
        has_commit: git_output(&root, &["rev-parse", "--verify", "HEAD"])
            .is_ok_and(|output| output.status.success()),
        tracks_project_file: head_tracks_project_file(workspace),
        tracks_editor_cache: tracks_editor_cache(workspace),
        has_identity: has_identity(&root),
        is_clean: git_text(&root, &["status", "--porcelain"]).is_ok_and(|text| text.is_empty()),
        root: Some(root),
    }
}

/// Whether `HEAD` holds the workspace's `project.godot`.
///
/// The `HEAD:./` form resolves the path against the directory Git runs in, so a game inside a
/// larger repository is asked about at its own place in the tree rather than at the repository root.
fn head_tracks_project_file(workspace: &Path) -> bool {
    let target = format!("HEAD:./{}", crate::addon::PROJECT_FILE);
    git_output(workspace, &["cat-file", "-e", &target]).is_ok_and(|output| output.status.success())
}

/// Whether Git is on the path at all. A missing Git and a directory that is not a repository are
/// the same "no repository root" answer from `rev-parse`, and they need opposite instructions.
pub fn is_installed() -> bool {
    Command::new("git")
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

/// Git refuses to commit without an author, and answers `GIT_COMMITTER_IDENT` only when it has one.
fn has_identity(directory: &Path) -> bool {
    git_output(directory, &["var", "GIT_COMMITTER_IDENT"])
        .is_ok_and(|output| output.status.success())
}

/// Makes `workspace` a repository. Task worktrees branch from the project's history, so a project
/// that has none cannot be worked on at all.
///
/// The ignore rule is written here rather than left to the user, because the very next thing that
/// happens is a commit of everything in the folder — and by then Godot's cache is in the history to
/// stay.
pub fn initialize_repository(workspace: &Path) -> Result<(), String> {
    let output = git_output(workspace, &["init", "-b", "main"])?;
    if !output.status.success() {
        return Err(git_failure("initialize the repository", &output));
    }
    ignore_editor_cache(workspace)?;
    Ok(())
}

/// Whether Git is already ignoring Godot's cache, by whatever rule and from whatever file.
///
/// Asked of Git rather than of the ignore file, so a rule the user wrote themselves, or one that
/// lives in a parent directory or in their global excludes, counts as the job already done.
fn ignores_editor_cache(workspace: &Path) -> bool {
    let target = format!("{EDITOR_CACHE_DIRECTORY}/");
    git_output(workspace, &["check-ignore", "-q", "--", &target])
        .is_ok_and(|output| output.status.success())
}

/// Adds the cache rule to the workspace's ignore file, and answers whether it had to.
///
/// Appended rather than written over: the file is the user's, and a project that arrives with one
/// already has rules in it worth more than this one.
pub fn ignore_editor_cache(workspace: &Path) -> Result<bool, String> {
    if ignores_editor_cache(workspace) {
        return Ok(false);
    }
    let path = workspace.join(IGNORE_FILE);
    let existing = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(format!("Could not read {IGNORE_FILE}: {error}")),
    };
    let mut text = existing.trim_end().to_owned();
    text.push_str(EDITOR_CACHE_IGNORE);
    std::fs::write(&path, text.trim_start_matches('\n'))
        .map_err(|error| format!("Could not write {IGNORE_FILE}: {error}"))?;
    Ok(true)
}

/// Whether the repository is carrying any of Godot's cache in its history.
///
/// An ignore rule does nothing for a file Git already tracks, so this is asked separately: the
/// projects that need the repair most are the ones that were committed before the rule existed.
/// The most of a file listing worth putting in front of a model.
///
/// Every research worker prompt carries this whole list, so it is spent three times over before any
/// of them has read a line of code. Two real projects measure 7.4 KiB and 17 KiB, so this is roughly
/// four times the larger of them — generous for anything hand-written, and a ceiling for the case
/// that is not: a repository with its dependencies or its art committed, where the list would crowd
/// out the work it is supposed to be helping with.
const MAX_INVENTORY_BYTES: usize = 64 * 1024;

/// Every file Git tracks in this worktree, one per line.
///
/// Handed to the brief's research workers so four of them do not each spend their steps discovering
/// the same tree with `find` and `ls` — the answer is identical for all of them and costs one call
/// here. Tracked rather than every file on disk, deliberately: build output, caches and imported
/// assets are not what a task is about, and a worker shown them reads them.
///
/// A worktree Git does not know about answers nothing, which leaves the workers exactly as they were
/// before this existed.
pub fn tracked_files(workspace: &Path) -> Option<String> {
    let listed = git_text(workspace, &["ls-files"]).ok()?;
    let trimmed = listed.trim();
    (!trimmed.is_empty()).then(|| bounded_inventory(trimmed))
}

/// The listing, cut to a size worth sending, and saying so when it was cut.
///
/// Cut at a line rather than at a byte, because half a path is worse than no path — a worker would
/// read it as a file and go looking for it. The count is what makes the truncation honest: a worker
/// told the list is partial can still reach for `find`, where one handed a silently shortened list
/// believes it has seen everything.
fn bounded_inventory(listed: &str) -> String {
    if listed.len() <= MAX_INVENTORY_BYTES {
        return listed.to_owned();
    }
    let mut kept = String::with_capacity(MAX_INVENTORY_BYTES + 128);
    let mut shown = 0usize;
    for line in listed.lines() {
        if kept.len() + line.len() + 1 > MAX_INVENTORY_BYTES {
            break;
        }
        kept.push_str(line);
        kept.push('\n');
        shown += 1;
    }
    let total = listed.lines().count();
    kept.push_str(&format!(
        "(and {} more files this list does not show — use find or ls to reach them)",
        total.saturating_sub(shown)
    ));
    kept
}

pub fn tracks_editor_cache(workspace: &Path) -> bool {
    git_text(workspace, &["ls-files", "--", EDITOR_CACHE_DIRECTORY])
        .is_ok_and(|listing| !listing.is_empty())
}

/// Takes Godot's cache out of the history and adds the rule that keeps it out, as one commit.
///
/// The removal itself leaves every file on disk, because Godot is using them. It does not leave
/// them there forever: the first checkout that crosses this commit takes the cache with it, the way
/// a checkout removes anything the commit it is moving to does not have. That costs one rebuild of
/// the cache the next time the editor opens, and it is the last one.
///
/// Refuses when something is already staged. This writes a commit from the index, and an index the
/// user or the agent had loaded would go into that commit under a message about the editor cache.
pub fn untrack_editor_cache(workspace: &Path) -> Result<(), String> {
    if !tracks_editor_cache(workspace) {
        ignore_editor_cache(workspace)?;
        return Ok(());
    }
    if !git_text(workspace, &["diff", "--cached", "--name-only"])?.is_empty() {
        return Err(
            "Something is already staged in this repository. Commit or unstage it first, so the \
             editor cache is the only thing this records."
                .to_owned(),
        );
    }
    ignore_editor_cache(workspace)?;
    let removed = git_output(
        workspace,
        &[
            "rm",
            "-r",
            "--cached",
            "--quiet",
            "--",
            EDITOR_CACHE_DIRECTORY,
        ],
    )?;
    if !removed.status.success() {
        return Err(git_failure("stop tracking the editor cache", &removed));
    }
    let staged = git_output(workspace, &["add", "--", IGNORE_FILE])?;
    if !staged.status.success() {
        return Err(git_failure("stage the ignore file", &staged));
    }
    let commit = git_output(
        workspace,
        &["commit", "-m", "Stop tracking Godot's editor cache"],
    )?;
    if !commit.status.success() {
        return Err(git_failure("record the editor cache removal", &commit));
    }
    Ok(())
}

/// Records a repository-local identity, so committing works without touching the user's global
/// Git configuration.
pub fn set_local_identity(workspace: &Path, name: &str, email: &str) -> Result<(), String> {
    for (key, value) in [("user.name", name), ("user.email", email)] {
        let output = git_output(workspace, &["config", "--local", key, value])?;
        if !output.status.success() {
            return Err(git_failure("record the Git identity", &output));
        }
    }
    Ok(())
}

/// Records the workspace's files as the commit task worktrees branch from.
///
/// A branch point alone is not enough, which is what an empty first commit used to leave behind: a
/// task worktree is a checkout of that commit, so a `project.godot` that was never committed is
/// absent from every worktree, and the editor session refuses to start in a directory that holds no
/// Godot project. Everything Git is not ignoring is staged, because the game is not one file.
///
/// The commit is allowed to be empty so an empty folder still gets its branch point, and files
/// already committed by an earlier run make this a no-op rather than a failure. Staging is limited
/// to the workspace: a game inside a larger repository is the one thing Gofer was asked about.
pub fn commit_project_files(workspace: &Path) -> Result<(), String> {
    let add = git_output(workspace, &["add", "--all", "--", "."])?;
    if !add.status.success() {
        return Err(git_failure("stage the project files", &add));
    }
    let output = git_output(
        workspace,
        &["commit", "--allow-empty", "-m", "Add the Godot project"],
    )?;
    if !output.status.success() {
        return Err(git_failure("commit the project files", &output));
    }
    Ok(())
}

fn output_text(output: &Output) -> Result<String, String> {
    String::from_utf8(output.stdout.clone())
        .map(|value| value.trim().to_owned())
        .map_err(|error| format!("Git returned non-UTF-8 output: {error}"))
}

/// Both streams, because Git splits one failure across them: a conflicted merge names the files on
/// stdout and leaves stderr to whatever hook or `rerere` happened to be enabled.
fn git_failure(action: &str, output: &Output) -> String {
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    let said: Vec<&str> = [stdout.as_str(), stderr.as_str()]
        .into_iter()
        .filter(|text| !text.is_empty())
        .collect();
    if said.is_empty() {
        return format!("Could not {action}: Git exited with {}", output.status);
    }
    format!("Could not {action}: {}", said.join("\n"))
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_listing_that_fits_is_left_exactly_as_it_is() {
        let listing = "src/main.gd\nsrc/player.tscn";
        assert_eq!(bounded_inventory(listing), listing);
    }

    /// Cut at a line, never mid-path: half a path reads as a file a worker then goes looking for.
    #[test]
    fn an_oversized_listing_is_cut_at_a_whole_path_and_says_how_many_it_dropped() {
        let listing = (0..20_000)
            .map(|index| format!("assets/generated/tile_{index}.png"))
            .collect::<Vec<_>>()
            .join("\n");
        let bounded = bounded_inventory(&listing);

        assert!(bounded.len() < listing.len());
        assert!(bounded.len() <= MAX_INVENTORY_BYTES + 128);
        for line in bounded.lines().filter(|line| line.starts_with("assets/")) {
            assert!(
                listing.lines().any(|whole| whole == line),
                "every path kept has to be a whole path: {line}"
            );
        }

        assert!(
            bounded.contains("more files this list does not show"),
            "a shortened listing has to say so"
        );
    }

    use super::*;
    use std::fs;
    use tempfile::TempDir;

    const TASK: &str = "gofer/task-one";
    const OTHER: &str = "gofer/task-two";

    fn git(directory: &Path, arguments: &[&str]) {
        let output = git_output(directory, arguments).expect("run Git");
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    /// Somewhere that is not a repository has no base to offer, and must not invent one.
    #[test]
    fn a_directory_that_is_not_a_repository_offers_no_base_branch() {
        let directory = TempDir::new().expect("temporary directory");
        assert_eq!(base_branch_candidate(directory.path()), None);
    }

    /**
     * The ignore file is the user's, so the rule is appended and only once.
     *
     * A project that arrives with rules in it has ones worth more than this one, and a second run
     * that appended again would leave the file growing a duplicate on every open.
     */
    #[test]
    fn the_cache_rule_is_added_once_and_leaves_the_rules_already_there() {
        let directory = repository();
        fs::write(directory.path().join(IGNORE_FILE), "*.import").expect("write ignore file");

        assert!(
            ignore_editor_cache(directory.path()).expect("add the rule"),
            "the rule was not there yet"
        );

        let contents = fs::read_to_string(directory.path().join(IGNORE_FILE)).expect("read");
        assert!(contents.starts_with("*.import\n"), "{contents}");
        assert!(contents.contains("\n.godot/\n"), "{contents}");

        assert!(
            !ignore_editor_cache(directory.path()).expect("already ignored"),
            "a repository that already ignores the cache is left alone"
        );
        assert_eq!(
            fs::read_to_string(directory.path().join(IGNORE_FILE)).expect("read"),
            contents,
            "the file must not grow a second copy of the rule"
        );
    }

    /// A repository with no ignore file at all gets one, rather than a read failure.
    #[test]
    fn a_repository_with_no_ignore_file_gets_one() {
        let directory = repository();
        assert!(ignore_editor_cache(directory.path()).expect("add the rule"));

        let contents = fs::read_to_string(directory.path().join(IGNORE_FILE)).expect("read");
        assert!(contents.starts_with("# Godot's editor cache"), "{contents}");
    }

    /**
     * Untracking the cache is one commit, and it must be only the cache.
     *
     * It writes a commit from the index, so an index the user or the agent had already loaded
     * would ride along inside a commit whose message says it is about the editor cache.
     */
    #[test]
    fn untracking_the_cache_refuses_to_bury_work_that_is_already_staged() {
        let directory = repository();
        fs::create_dir_all(directory.path().join(".godot")).expect("cache directory");
        fs::write(directory.path().join(".godot/uid_cache.bin"), "cache").expect("cache file");
        fs::write(directory.path().join("player.gd"), "extends Node\n").expect("script");
        git(directory.path(), &["add", "--all"]);
        git(directory.path(), &["commit", "-m", "with the cache in it"]);

        fs::write(directory.path().join("player.gd"), "extends Node2D\n").expect("edit");
        git(directory.path(), &["add", "--", "player.gd"]);

        let refusal = untrack_editor_cache(directory.path())
            .expect_err("a loaded index may not be committed under this message");
        assert!(refusal.contains("already staged"), "{refusal}");
    }

    /// The cache leaves the history and stays on disk, because Godot is still using it.
    #[test]
    fn untracking_the_cache_removes_it_from_the_history_and_leaves_it_on_disk() {
        let directory = repository();
        fs::create_dir_all(directory.path().join(".godot")).expect("cache directory");
        fs::write(directory.path().join(".godot/uid_cache.bin"), "cache").expect("cache file");
        git(directory.path(), &["add", "--all"]);
        git(directory.path(), &["commit", "-m", "with the cache in it"]);

        untrack_editor_cache(directory.path()).expect("untrack the cache");

        assert!(
            git_text(directory.path(), &["ls-files", "--", ".godot"])
                .expect("list")
                .is_empty(),
            "the cache is no longer tracked"
        );
        assert!(
            directory.path().join(".godot/uid_cache.bin").exists(),
            "the editor is still using the files"
        );
        assert!(
            fs::read_to_string(directory.path().join(IGNORE_FILE))
                .expect("read")
                .contains(".godot/"),
            "and the rule that keeps it out is in place"
        );
    }

    /// A repository that never tracked the cache still gets the rule, and no commit.
    #[test]
    fn a_repository_that_never_tracked_the_cache_only_gains_the_rule() {
        let directory = repository();
        fs::write(directory.path().join("player.gd"), "extends Node\n").expect("script");
        git(directory.path(), &["add", "--all"]);
        git(directory.path(), &["commit", "-m", "the project"]);
        let before = git_text(directory.path(), &["rev-parse", "HEAD"]).expect("head");

        untrack_editor_cache(directory.path()).expect("nothing to untrack");

        assert_eq!(
            git_text(directory.path(), &["rev-parse", "HEAD"]).expect("head"),
            before,
            "nothing to remove means nothing to commit"
        );
        assert!(
            fs::read_to_string(directory.path().join(IGNORE_FILE))
                .expect("read")
                .contains(".godot/")
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

    fn status(directory: &Path) -> String {
        git_text(directory, &["status", "--porcelain"]).expect("status")
    }

    #[test]
    fn a_task_branch_is_created_once_and_found_again() {
        let repository = repository();

        let created = create_task_branch(repository.path(), TASK, "master")
            .expect("create the branch")
            .expect("a repository");

        assert_eq!(created.branch_name, TASK);
        assert_eq!(created.head_commit, created.base_commit);
        assert!(branch_exists(repository.path(), TASK));
        assert_eq!(current_branch(repository.path()).as_deref(), Some("master"));

        let again = create_task_branch(repository.path(), TASK, "master")
            .expect("find the branch")
            .expect("a repository");

        assert_eq!(again.head_commit, created.head_commit);
    }

    /// The shape that made a merged project look unmerged: a task is opened, so the checkout is on
    /// an old task's branch, and the next task is created from there. Cut from `HEAD` that new task
    /// starts before every merge the project has had, and its files are the work as it stood
    /// whenever that old task began.
    #[test]
    fn a_task_branch_starts_from_the_base_branch_and_not_from_the_open_task() {
        let repository = repository();
        create_task_branch(repository.path(), OTHER, "master").expect("create the older task");
        checkout_branch(repository.path(), OTHER).expect("open the older task");
        fs::write(repository.path().join("old.gd"), "extends Node\n").expect("older task change");
        commit_pending_changes(repository.path()).expect("bank the older task");
        let stale = git_text(repository.path(), &["rev-parse", "HEAD"]).expect("stale head");

        git(repository.path(), &["checkout", "master"]);
        fs::write(repository.path().join("merged.gd"), "extends Node\n").expect("merged change");
        git(repository.path(), &["add", "merged.gd"]);
        git(repository.path(), &["commit", "-m", "Merge task branch"]);
        let base_tip = git_text(repository.path(), &["rev-parse", "master"]).expect("master tip");
        checkout_branch(repository.path(), OTHER).expect("back on the older task");

        let created = create_task_branch(repository.path(), TASK, "master")
            .expect("create the new task")
            .expect("a repository");

        assert_eq!(
            created.base_commit, base_tip,
            "a new task must start from the base branch, not from the task that happens to be open"
        );
        assert_ne!(created.base_commit, stale);
        assert!(
            git_text(repository.path(), &["show", &format!("{TASK}:merged.gd")]).is_ok(),
            "the new task must carry work the project has already merged"
        );
    }

    /// A repository whose base branch has no commit yet still has to be able to hold a task.
    #[test]
    fn a_base_branch_that_names_no_commit_falls_back_to_head() {
        let repository = repository();

        let created = create_task_branch(repository.path(), TASK, "no-such-branch")
            .expect("create the branch")
            .expect("a repository");

        assert_eq!(
            created.base_commit,
            git_text(repository.path(), &["rev-parse", "HEAD"]).expect("head")
        );
    }

    #[test]
    fn checking_out_a_task_branch_moves_head_and_is_idempotent() {
        let repository = repository();
        create_task_branch(repository.path(), TASK, "master").expect("create the branch");

        checkout_branch(repository.path(), TASK).expect("switch to the task");
        assert_eq!(current_branch(repository.path()).as_deref(), Some(TASK));

        checkout_branch(repository.path(), TASK).expect("switching to where we already are");
        assert_eq!(current_branch(repository.path()).as_deref(), Some(TASK));
    }

    /// One checkout means loose files follow it. Committing them onto the branch being left is what
    /// keeps one task's half-finished work from arriving in the next task as that task's own.
    #[test]
    fn pending_work_is_banked_on_the_branch_being_left() {
        let repository = repository();
        create_task_branch(repository.path(), TASK, "master").expect("create the branch");
        create_task_branch(repository.path(), OTHER, "master").expect("create the other branch");
        checkout_branch(repository.path(), TASK).expect("open the first task");
        fs::write(repository.path().join("player.gd"), "extends Node\n").expect("task change");

        assert!(commit_pending_changes(repository.path()).expect("bank the work"));
        checkout_branch(repository.path(), OTHER).expect("open the second task");

        assert!(
            !repository.path().join("player.gd").exists(),
            "the first task's file must not follow the checkout into the second"
        );
        checkout_branch(repository.path(), TASK).expect("back to the first task");
        assert!(repository.path().join("player.gd").is_file());
        assert!(
            !commit_pending_changes(repository.path()).expect("nothing left to bank"),
            "a clean checkout records nothing"
        );
    }

    /// Git's refusal has to reach the caller. A checkout that silently did not happen is a task
    /// whose files are another task's.
    #[test]
    fn a_checkout_git_refuses_is_reported_rather_than_swallowed() {
        let repository = repository();
        create_task_branch(repository.path(), TASK, "master").expect("create the branch");
        checkout_branch(repository.path(), TASK).expect("open the task");
        fs::write(
            repository.path().join("project.godot"),
            "[application]\nname=\"task\"\n",
        )
        .expect("task edit");
        git(repository.path(), &["commit", "-am", "Task edit"]);
        checkout_branch(repository.path(), "master").expect("back to the base");
        fs::write(
            repository.path().join("project.godot"),
            "[application]\nname=\"loose\"\n",
        )
        .expect("uncommitted edit");

        let error = checkout_branch(repository.path(), TASK)
            .expect_err("Git must refuse to clobber the local change");

        assert!(error.contains("project.godot"), "{error}");
        assert_eq!(
            current_branch(repository.path()).as_deref(),
            Some("master"),
            "a refused checkout leaves the user where they were"
        );
    }

    #[test]
    fn a_task_branch_merges_and_head_comes_back_to_it() {
        let repository = repository();
        create_task_branch(repository.path(), TASK, "master").expect("create the branch");
        checkout_branch(repository.path(), TASK).expect("open the task");
        fs::write(repository.path().join("player.gd"), "extends Node\n").expect("task change");

        let merged = merge_task_branch(repository.path(), TASK, "master").expect("merge the task");

        assert_eq!(
            current_branch(repository.path()).as_deref(),
            Some(TASK),
            "the user stays on the task they merged"
        );
        assert_eq!(
            git_text(repository.path(), &["rev-parse", "master"]).expect("master"),
            git_text(repository.path(), &["rev-parse", TASK]).expect("task"),
            "the task branch is moved onto the merge, so its files do not go backwards"
        );
        assert_eq!(
            git_text(repository.path(), &["rev-parse", "HEAD"]).expect("HEAD"),
            merged.merged_commit
        );
        assert_ne!(merged.head_commit, merged.merged_commit);
        assert!(repository.path().join("player.gd").is_file());
        assert_eq!(status(repository.path()), "");
    }

    #[test]
    fn a_task_that_changed_nothing_still_merges() {
        let repository = repository();
        create_task_branch(repository.path(), TASK, "master").expect("create the branch");
        checkout_branch(repository.path(), TASK).expect("open the task");
        let before = git_text(repository.path(), &["rev-parse", "HEAD"]).expect("HEAD");

        let merged =
            merge_task_branch(repository.path(), TASK, "master").expect("an unchanged task merges");

        assert_eq!(merged.head_commit, before);
        assert_eq!(merged.merged_commit, before);
        assert_eq!(status(repository.path()), "");
        assert_eq!(current_branch(repository.path()).as_deref(), Some(TASK));
    }

    /// A conflict stops Git mid-merge and leaves the markers in the working tree unless someone
    /// aborts it. With one checkout that mess would be the next task's starting point, and the user
    /// would be looking at the base branch rather than the task they pressed merge on.
    #[test]
    fn a_conflicting_merge_is_aborted_and_puts_the_user_back_on_their_task() {
        let repository = repository();
        create_task_branch(repository.path(), TASK, "master").expect("create the branch");
        fs::write(
            repository.path().join("project.godot"),
            "[application]\nname=\"main\"\n",
        )
        .expect("main edit");
        git(repository.path(), &["commit", "-am", "Main edit"]);
        checkout_branch(repository.path(), TASK).expect("open the task");
        fs::write(
            repository.path().join("project.godot"),
            "[application]\nname=\"task\"\n",
        )
        .expect("task edit");

        let error = merge_task_branch(repository.path(), TASK, "master")
            .expect_err("two edits to one file must conflict");

        assert!(
            error.message().contains("project.godot"),
            "the message must name the files that clashed: {error}"
        );
        assert!(error.message().contains("Nothing was merged"), "{error}");
        assert_eq!(
            current_branch(repository.path()).as_deref(),
            Some(TASK),
            "a failed merge leaves the user on the task they pressed it on"
        );
        assert_eq!(
            status(repository.path()),
            "",
            "the failed merge must be aborted, not left half-applied"
        );
    }

    /// With `rerere` on, Git writes "Recorded preimage for ..." to stderr and the conflict itself
    /// to stdout. Reading stderr alone reported the noise and nothing else.
    #[test]
    fn a_conflict_is_named_even_when_rerere_is_talking_over_it() {
        let repository = repository();
        git(repository.path(), &["config", "rerere.enabled", "true"]);
        create_task_branch(repository.path(), TASK, "master").expect("create the branch");
        fs::write(
            repository.path().join("player.gd"),
            "extends Node # master\n",
        )
        .expect("master edit");
        git(repository.path(), &["add", "player.gd"]);
        git(repository.path(), &["commit", "-m", "Master edit"]);
        checkout_branch(repository.path(), TASK).expect("open the task");
        fs::write(repository.path().join("player.gd"), "extends Node # task\n").expect("task edit");

        let error =
            merge_task_branch(repository.path(), TASK, "master").expect_err("this must conflict");

        assert!(error.message().contains("player.gd"), "{error}");
        assert!(
            !error.message().contains("Recorded preimage"),
            "rerere must not be the whole message: {error}"
        );
    }

    /// A conflict is reported as one, with the files, so the window can offer a way out of it.
    ///
    /// Every merge failure used to be one code and one sentence, so the window could only print it.
    /// The paths are what makes "let Gofer resolve it" an offer rather than a guess.
    #[test]
    fn a_conflict_is_reported_apart_from_every_other_merge_failure() {
        let repository = repository();
        let failure = conflicting_task(&repository);

        assert_eq!(failure.conflicts(), ["player.gd"]);
        assert!(failure.message().contains("player.gd"), "{failure}");
        assert!(
            merge_task_branch(repository.path(), "master", "master")
                .expect_err("a task branch cannot be the project's own")
                .conflicts()
                .is_empty()
        );
    }

    /// The offer itself: the project's branch is brought into the task, and what clashed stays put.
    ///
    /// The opposite direction from the merge, which aborts. Here the conflict has to survive — it
    /// is the thing the agent is being asked to fix, and it has to be in the worktree the agent
    /// works in, on the branch the user is looking at.
    #[test]
    fn resolving_brings_the_project_into_the_task_and_leaves_the_clash_in_place() {
        let repository = repository();
        conflicting_task(&repository);

        let conflicts = resolve_task_conflicts(repository.path(), TASK, "master")
            .expect("starting the resolution is not itself a failure");

        assert_eq!(conflicts, ["player.gd"]);
        assert_eq!(
            current_branch(repository.path()).as_deref(),
            Some(TASK),
            "the user stays on the task they were looking at"
        );
        let contents =
            fs::read_to_string(repository.path().join("player.gd")).expect("the clashing file");
        assert!(
            contents.contains("<<<<<<<")
                && contents.contains("# master")
                && contents.contains("# task"),
            "the file must hold both versions for the agent to reconcile: {contents}"
        );
        assert!(
            resolve_task_conflicts(repository.path(), TASK, "master")
                .expect_err("one merge at a time")
                .contains("already has a merge waiting")
        );
    }

    /// Nothing is committed while a file still holds both versions.
    ///
    /// `git add --all` would stage `<<<<<<<` as ordinary work, and a scene or a script committed
    /// that way does not parse — merged into the project by the one step that was meant to be safe.
    #[test]
    fn an_unresolved_file_stops_everything_that_would_commit_it() {
        let repository = repository();
        conflicting_task(&repository);
        resolve_task_conflicts(repository.path(), TASK, "master").expect("start the resolution");

        let refusal = commit_pending_changes(repository.path())
            .expect_err("a half-resolved merge must not be committed");
        assert!(refusal.contains("player.gd"), "{refusal}");
        assert!(refusal.contains("both versions"), "{refusal}");
        let refused = merge_task_branch(repository.path(), TASK, "master").expect_err("nor merged");
        assert!(refused.message().contains("both versions"), "{refused}");
        assert_eq!(refused.unfinished(), ["player.gd"]);
        assert!(refused.conflicts().is_empty());

        fs::write(
            repository.path().join("player.gd"),
            "extends Node # reconciled\n",
        )
        .expect("resolve the file");
        merge_task_branch(repository.path(), TASK, "master")
            .expect("the merge now has no conflict");
        assert_eq!(status(repository.path()), "");
        assert_eq!(
            fs::read_to_string(repository.path().join("player.gd")).expect("the merged file"),
            "extends Node # reconciled\n",
            "the project ends up with what the agent reconciled"
        );
    }

    /// A resolution that keeps the task's own version still closes the merge.
    ///
    /// The tree is then identical to where the task already was, so every "is there anything to
    /// commit" shortcut says no — and walking away leaves the merge open, for the next checkout to
    /// carry onto another branch.
    #[test]
    fn a_resolution_that_changes_nothing_still_finishes_the_merge() {
        let repository = repository();
        conflicting_task(&repository);
        resolve_task_conflicts(repository.path(), TASK, "master").expect("start the resolution");
        fs::write(repository.path().join("player.gd"), "extends Node # task\n")
            .expect("keep the task's own version");

        merge_task_branch(repository.path(), TASK, "master").expect("the merge goes through");

        assert_eq!(status(repository.path()), "");
        assert!(
            !merge_in_progress(repository.path()),
            "no merge may be left open behind the task"
        );
    }

    /// `=======` on its own is an ordinary line, and a file full of them is not unresolved.
    #[test]
    fn a_markdown_rule_is_not_a_conflict_marker() {
        let directory = TempDir::new().expect("a temporary directory");
        let plain = directory.path().join("README.md");
        fs::write(&plain, "Title\n=======\n\nBody\n").expect("write it");
        assert!(!holds_conflict_markers(&plain));

        let clashed = directory.path().join("player.gd");
        fs::write(
            &clashed,
            "<<<<<<< HEAD\nextends Node\n=======\nextends Node2D\n>>>>>>> master\n",
        )
        .expect("write it");
        assert!(holds_conflict_markers(&clashed));
        assert!(!holds_conflict_markers(&directory.path().join("gone.gd")));
    }

    /// Backing out leaves the task exactly as it was.
    #[test]
    fn discarding_an_unfinished_resolution_puts_the_task_back() {
        let repository = repository();
        conflicting_task(&repository);
        resolve_task_conflicts(repository.path(), TASK, "master").expect("start the resolution");

        abandon_task_conflicts(repository.path()).expect("discard it");

        assert_eq!(status(repository.path()), "");
        assert_eq!(
            fs::read_to_string(repository.path().join("player.gd")).expect("the file"),
            "extends Node # task\n"
        );
    }

    /// A task and the project that both edited `player.gd`, with the merge already attempted.
    fn conflicting_task(repository: &TempDir) -> MergeFailure {
        create_task_branch(repository.path(), TASK, "master").expect("create the branch");
        fs::write(
            repository.path().join("player.gd"),
            "extends Node # master\n",
        )
        .expect("master edit");
        git(repository.path(), &["add", "player.gd"]);
        git(repository.path(), &["commit", "-m", "Master edit"]);
        checkout_branch(repository.path(), TASK).expect("open the task");
        fs::write(repository.path().join("player.gd"), "extends Node # task\n").expect("task edit");
        merge_task_branch(repository.path(), TASK, "master").expect_err("this must conflict")
    }

    #[test]
    fn merging_is_refused_from_anywhere_but_the_task_branch() {
        let repository = repository();
        create_task_branch(repository.path(), TASK, "master").expect("create the branch");

        let error = merge_task_branch(repository.path(), TASK, "master")
            .expect_err("the checkout is on master, not the task");

        assert!(
            error.message().contains("not on the task branch"),
            "{error}"
        );
        assert!(
            merge_task_branch(repository.path(), "master", "master")
                .unwrap_err()
                .message()
                .contains("cannot be the project's own branch")
        );
    }

    /// Git refuses to delete the branch `HEAD` points at, and the task being deleted is the one the
    /// user was most likely looking at.
    #[test]
    fn discarding_the_checked_out_task_branch_moves_off_it_first() {
        let repository = repository();
        create_task_branch(repository.path(), TASK, "master").expect("create the branch");
        checkout_branch(repository.path(), TASK).expect("open the task");
        fs::write(repository.path().join("scratch.gd"), "extends Node\n").expect("loose work");

        discard_task_branch(repository.path(), TASK, "master");

        assert!(!branch_exists(repository.path(), TASK));
        assert_eq!(current_branch(repository.path()).as_deref(), Some("master"));
        assert_eq!(status(repository.path()), "");
        assert!(
            !repository.path().join("scratch.gd").exists(),
            "unmerged work goes with the task, which is what deleting one means"
        );
    }

    #[test]
    fn the_base_branch_is_never_a_task_branch() {
        let repository = repository();
        assert_eq!(
            base_branch_candidate(repository.path()).as_deref(),
            Some("master")
        );

        create_task_branch(repository.path(), TASK, "master").expect("create the branch");
        checkout_branch(repository.path(), TASK).expect("open the task");

        let candidate = base_branch_candidate(repository.path()).expect("a candidate");
        assert_ne!(
            candidate, TASK,
            "a project opened on a task branch must not adopt it as the branch tasks merge into"
        );
        assert!(!candidate.starts_with(TASK_BRANCH_PREFIX), "{candidate}");
    }

    #[test]
    fn a_workspace_inside_a_larger_repository_gets_no_branch() {
        let repository = repository();
        let workspace = repository.path().join("inner-workspace");
        fs::create_dir(&workspace).expect("inner workspace");

        let created =
            create_task_branch(&workspace, "gofer/task-inner", "master").expect("no repository");

        assert!(
            created.is_none(),
            "a workspace inside a larger repository must be treated as having no repository"
        );
        assert_eq!(
            git_text(repository.path(), &["branch", "--list", "gofer/task-inner"])
                .expect("branch list"),
            "",
            "the outer repository must not have grown a task branch"
        );
    }

    #[test]
    fn outside_a_repository_nothing_is_created_merged_or_discarded() {
        let directory = TempDir::new().expect("temporary non-repository");
        assert!(
            create_task_branch(directory.path(), TASK, "master")
                .expect("non-repository lookup")
                .is_none()
        );
        assert!(
            merge_task_branch(directory.path(), TASK, "master")
                .unwrap_err()
                .message()
                .contains("not a Git repository")
        );
        assert!(
            commit_pending_changes(directory.path())
                .unwrap_err()
                .contains("not a Git repository")
        );
        assert!(base_branch_candidate(directory.path()).is_none());
        discard_task_branch(directory.path(), TASK, "master");
    }

    /// Per-repository excludes live in the Git directory the whole repository shares, which is where
    /// the addon's exclude pattern is written.
    #[test]
    fn the_common_directory_is_absolute_inside_a_repository_and_absent_outside_one() {
        let repository = repository();

        let common = common_directory(repository.path()).expect("common directory");

        assert!(common.is_absolute(), "{}", common.display());
        assert!(common.ends_with(".git"), "{}", common.display());

        let outside = TempDir::new().expect("temporary non-repository");
        assert!(common_directory(outside.path()).is_none());
    }

    /// Writes a cache directory the way Godot does, and records it the way a project that predates
    /// the ignore rule already has.
    fn with_tracked_editor_cache(directory: &Path) {
        fs::create_dir_all(directory.join(".godot/editor")).expect("cache directory");
        fs::write(
            directory.join(".godot/editor/filesystem_cache10"),
            "scan 1\n",
        )
        .expect("cache file");
        git(directory, &["add", "--all"]);
        git(directory, &["commit", "-m", "Track everything"]);
    }

    /// The shape that made a merged task ask to be merged again: nobody edited the game, Godot
    /// reopened, and the branch grew a commit anyway.
    #[test]
    fn the_editor_cache_is_kept_out_of_a_new_repository() {
        let directory = TempDir::new().expect("temporary folder");
        fs::write(directory.path().join("project.godot"), "[application]\n").expect("project file");
        fs::create_dir_all(directory.path().join(".godot/editor")).expect("cache directory");
        fs::write(
            directory.path().join(".godot/editor/filesystem_cache10"),
            "scan\n",
        )
        .expect("cache file");

        initialize_repository(directory.path()).expect("initialize");
        git(directory.path(), &["config", "user.name", "Gofer Test"]);
        git(
            directory.path(),
            &["config", "user.email", "gofer@example.invalid"],
        );
        commit_project_files(directory.path()).expect("commit the project");

        assert!(
            !tracks_editor_cache(directory.path()),
            "the first commit must not carry Godot's cache"
        );
        assert!(
            git_text(directory.path(), &["ls-files"])
                .expect("listing")
                .contains("project.godot"),
            "the project itself still has to be committed"
        );

        fs::write(
            directory.path().join(".godot/editor/filesystem_cache10"),
            "scan 2\n",
        )
        .expect("rewrite the cache");
        assert!(!has_uncommitted_changes(directory.path()));
        assert!(!commit_pending_changes(directory.path()).expect("commit pending"));
    }

    /// A rule the user already wrote is left alone, whatever form they wrote it in.
    #[test]
    fn an_ignore_rule_that_already_covers_the_cache_is_not_written_twice() {
        let repository = repository();
        fs::write(repository.path().join(IGNORE_FILE), "*.tmp\n.godot/\n").expect("ignore file");

        assert!(!ignore_editor_cache(repository.path()).expect("ignore"));
        assert_eq!(
            fs::read_to_string(repository.path().join(IGNORE_FILE)).expect("read back"),
            "*.tmp\n.godot/\n"
        );
    }

    /// An ignore file with no trailing newline must not have the rule welded onto its last line,
    /// where Git reads `assets/.godot/` and ignores neither.
    #[test]
    fn the_cache_rule_is_appended_to_an_ignore_file_that_ends_mid_line() {
        let repository = repository();
        fs::write(repository.path().join(IGNORE_FILE), "*.tmp").expect("ignore file");

        assert!(ignore_editor_cache(repository.path()).expect("ignore"));

        let text = fs::read_to_string(repository.path().join(IGNORE_FILE)).expect("read back");
        assert!(text.starts_with("*.tmp\n"), "{text}");
        assert!(text.lines().any(|line| line == ".godot/"), "{text}");
        assert!(ignores_editor_cache(repository.path()));
    }

    /// An ignore rule does nothing for a file Git already tracks, and every project made before
    /// this rule existed is exactly that project.
    #[test]
    fn a_repository_that_already_tracks_the_cache_can_be_repaired() {
        let repository = repository();
        with_tracked_editor_cache(repository.path());
        assert!(tracks_editor_cache(repository.path()));

        untrack_editor_cache(repository.path()).expect("untrack the cache");

        assert!(!tracks_editor_cache(repository.path()));
        assert!(
            repository
                .path()
                .join(".godot/editor/filesystem_cache10")
                .is_file(),
            "the files stay on disk, or Godot reimports the whole project"
        );
        assert!(
            status(repository.path()).is_empty(),
            "the repair leaves nothing loose: {}",
            status(repository.path())
        );
        fs::write(
            repository.path().join(".godot/editor/filesystem_cache10"),
            "scan 2\n",
        )
        .expect("rewrite the cache");
        assert!(!commit_pending_changes(repository.path()).expect("commit pending"));
    }

    /// The repair writes a commit from the index, so an index somebody else loaded is a commit
    /// somebody else's work lands in, under a message about the editor cache.
    #[test]
    fn the_repair_refuses_to_sweep_up_work_that_is_already_staged() {
        let repository = repository();
        with_tracked_editor_cache(repository.path());
        fs::write(repository.path().join("player.gd"), "extends Node\n").expect("work in progress");
        git(repository.path(), &["add", "player.gd"]);

        let error = untrack_editor_cache(repository.path()).expect_err("refuse");

        assert!(error.contains("already staged"), "{error}");
        assert!(
            tracks_editor_cache(repository.path()),
            "a refused repair must change nothing"
        );
    }

    /// A repository with no cache in it still gets the rule, so the first editor open does not put
    /// one there.
    #[test]
    fn a_clean_repository_is_given_the_rule_without_a_commit() {
        let repository = repository();
        let before = git_text(repository.path(), &["rev-parse", "HEAD"]).expect("head");

        untrack_editor_cache(repository.path()).expect("untrack the cache");

        assert!(ignores_editor_cache(repository.path()));
        assert_eq!(
            before,
            git_text(repository.path(), &["rev-parse", "HEAD"]).expect("head"),
            "there was nothing to remove, so there is nothing to commit"
        );
    }
}

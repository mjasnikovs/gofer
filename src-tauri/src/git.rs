use serde::Serialize;
use std::fs;
use std::io::Read;
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
///
/// A repository cloned into the project folder is left out, because the switch leaves it out too:
/// listing it offers the user a choice between two things that both do nothing to it, under a
/// sentence saying it goes with the task being closed.
///
/// Read twice rather than once. `-z` is what spells an exotic path correctly, but it also splits a
/// rename into two records in the opposite order, and this listing names the rename.
pub fn pending_changes(workspace_path: &Path) -> Result<Vec<PendingChange>, String> {
    let embedded = status_records(workspace_path)
        .map(|records| embedded_repositories_in(workspace_path, &records))
        .unwrap_or_default();
    let status = git_text(workspace_path, &["status", "--porcelain", "-uall"])?;
    Ok(status
        .lines()
        .filter_map(parse_status_line)
        .filter(|change| {
            !embedded
                .iter()
                .any(|path| change.path.trim_end_matches('/') == path)
        })
        .collect())
}

/// Every record of `git status -z`, the empty tail of the final separator dropped.
///
/// `-uall` rather than the default: Git otherwise collapses an untracked directory to its own name,
/// and the thing being looked for lives inside one. It also decides the clean check, which without
/// it answers "clean" for a user who set `status.showUntrackedFiles=no`, and their loose files then
/// follow the checkout into the next task.
fn status_records(workspace_path: &Path) -> Result<Vec<String>, String> {
    let output = git_bytes(workspace_path, &["status", "--porcelain", "-uall", "-z"])?;
    Ok(nul_records(&output)
        .into_iter()
        .filter(|record| !record.is_empty())
        .collect())
}

/// The Git repositories sitting inside the checkout, which `git add --all` would otherwise swallow
/// as gitlinks.
///
/// A clone in the project folder is nobody's work: `git add --all` records it as a bare commit
/// pointer, and a commit still moves the branch it lands on, which is how a merged task comes back
/// asking to be merged again. The clone that caused this was an agent's, under a directory that was
/// itself untracked.
///
/// Under `-uall` Git expands every untracked directory except one it will not enter, so a record
/// that still ends in a slash is a repository boundary and nothing else. A registered submodule is
/// tracked and never reported as untracked, so this cannot reach one.
fn embedded_repositories_in(workspace_path: &Path, records: &[String]) -> Vec<String> {
    records
        .iter()
        .filter_map(|record| record.strip_prefix("?? "))
        .filter(|path| path.ends_with('/'))
        // a linked worktree keeps its `.git` as a file, and is gitlinked just the same
        .filter(|path| workspace_path.join(path).join(".git").exists())
        .map(|path| path.trim_end_matches('/').to_owned())
        .collect()
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
///
/// `-z` because these paths are both joined onto disk and compared against the changed-file
/// listing. Git C-quotes anything that is not plain ASCII — `"spelar\303\251.gd"` — and that names
/// no file: the marker check would find nothing and call a conflicted file resolved.
fn conflicting_paths(repository_root: &Path) -> Vec<String> {
    git_bytes(
        repository_root,
        &["diff", "--name-only", "--diff-filter=U", "-z"],
    )
    .map(|listing| {
        nul_records(&listing)
            .into_iter()
            .filter(|path| !path.is_empty())
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
    let records = status_records(worktree_path)?;
    if records.is_empty() && !merging {
        return Ok(false);
    }
    let mut arguments = vec![
        "add".to_owned(),
        "--all".to_owned(),
        "--".to_owned(),
        ".".to_owned(),
    ];
    // `literal` so a clone named `star*dir` cannot also exclude a real `starXdir`; `top` anchors at
    // the root, which `repository_root` has already refused to leave.
    arguments.extend(
        embedded_repositories_in(worktree_path, &records)
            .into_iter()
            .map(|path| format!(":(exclude,literal,top){path}")),
    );
    let borrowed = arguments.iter().map(String::as_str).collect::<Vec<_>>();
    let add = git_output(worktree_path, &borrowed)?;
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
///
/// A refused bank stops the whole thing, branch included. The bank is what keeps the outgoing task's
/// loose files off the branch being moved to, so moving anyway puts them on the base branch as work
/// nobody did — and leaving a branch behind that no task points at costs the user nothing, where
/// that does.
///
/// Answers the refusal rather than swallowing it: the checkout is then still on the branch of a task
/// that is already gone from the database, and a caller that says nothing leaves the user reading
/// one task's files with no task on screen owning them.
pub fn discard_task_branch(
    workspace_path: &Path,
    branch_name: &str,
    base_branch: &str,
) -> Result<(), String> {
    let Ok(Some(repository_root)) = repository_root(workspace_path) else {
        return Ok(());
    };
    if current_branch(&repository_root).as_deref() == Some(branch_name) {
        commit_pending_task_changes(&repository_root)?;
        checkout_branch(&repository_root, base_branch)?;
    }
    let _ = git_output(&repository_root, &["branch", "-D", branch_name]);
    Ok(())
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
    /// Git repositories cloned into the project folder. Never the user's work, and never committed.
    pub embedded_repositories: Vec<String>,
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
        embedded_repositories: status_records(&root)
            .map(|records| embedded_repositories_in(&root, &records))
            .unwrap_or_default(),
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

/// Paths that are never anyone's work, whatever Git thinks of them.
///
/// `.gofer` is the reason this list exists rather than being left to the ignore file: it holds the
/// project database, which is rewritten every turn, and nothing has ever put it in `.gitignore`.
/// The rest are here because a repository committed before Gofer's ignore rule still tracks them.
const NEVER_THE_USERS_WORK: [&str; 4] = [".gofer/", ".godot/", ".git/", "addons/gofer/"];

/// The most rows worth drawing, and the reason is the window rather than Git. Five thousand changed
/// files cost Git a quarter of a second and cost an unvirtualised list far more; the explorer caps
/// its own tree at the same order for the same reason.
const MAX_LISTED_CHANGES: usize = 400;

/// What happened to one file between the task's base and the files on disk.
///
/// `Renamed` is only ever seen for work a task switch already committed. Git pairs a rename from
/// the index, and Gofer leaves the agent's work loose, so a rename made during a task arrives as a
/// `Deleted` and an `Added` — which is what `git status` shows a human for the same tree.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ChangeStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
    /// A file became a symlink, or the other way about. Git calls it `T`.
    TypeChanged,
    /// A letter this build does not know. Named rather than dropped, so a listing never silently
    /// loses a row.
    Other,
}

impl ChangeStatus {
    /// Git writes a similarity score onto the letter — `R100`, `R072` — so only the first byte
    /// carries the kind.
    fn from_code(code: &str) -> Self {
        match code.as_bytes().first() {
            Some(b'A') => Self::Added,
            Some(b'M') => Self::Modified,
            Some(b'D') => Self::Deleted,
            Some(b'R') | Some(b'C') => Self::Renamed,
            Some(b'T') => Self::TypeChanged,
            _ => Self::Other,
        }
    }

    fn pairs_two_paths(code: &str) -> bool {
        matches!(code.as_bytes().first(), Some(b'R') | Some(b'C'))
    }
}

/// One file the task changed.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    pub path: String,
    pub status: ChangeStatus,
    /// Where a renamed file came from, and nothing for every other status.
    pub from_path: Option<String>,
    /// Git's own answer, not a guess from the extension: `--numstat` prints a dash for a file it
    /// will not count lines in.
    pub is_binary: bool,
    pub added: u32,
    pub removed: u32,
    /// Still holding both sides of a merge. The diff of one of these is conflict markers, not work.
    pub is_conflicted: bool,
}

/// Everything the Changes view needs in one answer.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskChanges {
    pub files: Vec<ChangedFile>,
    /// How many rows the cap dropped. Shown, never silent: a listing that is short and says so
    /// still lets someone go looking, where a silently shortened one does not.
    pub dropped: u32,
    /// A resolution merge is open, so some of these files are Git's markers rather than the task's
    /// work.
    pub is_merging: bool,
}

/// One file's two sides, ready for a diff editor.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub path: String,
    pub original: String,
    pub modified: String,
    /// Both sides decoded. A file Git counts lines in can still be Latin-1, and that is not
    /// something a diff editor can show.
    pub is_text: bool,
    pub is_too_large: bool,
    /// A pointer to another repository's commit. Git lists it as an ordinary changed path, and
    /// there is no blob behind it to read.
    pub is_submodule: bool,
}

/// Every file the task changed, from where it branched to the files on disk now.
///
/// `project_file` is `project.godot` with Gofer's own two lines taken back out, or nothing when
/// there are none to take. Without it every diff taken while an editor session is running shows a
/// change to `project.godot` that nobody made.
pub fn changed_files(
    workspace_path: &Path,
    base_commit: &str,
    project_file: Option<&str>,
) -> Result<TaskChanges, String> {
    let files = collect_changes(workspace_path, base_commit, project_file)?;
    let dropped = files.len().saturating_sub(MAX_LISTED_CHANGES);
    let files = within_the_row_budget(files);
    Ok(TaskChanges {
        files,
        dropped: dropped as u32,
        is_merging: merge_in_progress(workspace_path),
    })
}

/// Godot writes one of these beside every asset it imports, so in any listing that touches art
/// they roughly equal the work. `src/models/file-kinds.ts` holds the same two names for the toggle
/// that hides them.
const GENERATED_SIDECARS: [&str; 2] = ["import", "uid"];

fn is_generated_sidecar(path: &str) -> bool {
    let name = path.rsplit('/').next().unwrap_or(path);
    name.rfind('.')
        .filter(|dot| *dot > 0)
        .is_some_and(|dot| GENERATED_SIDECARS.contains(&&name[dot + 1..]))
}

/// Spends the row budget on the user's own files before Godot's sidecars.
///
/// Cut in path order instead, half the budget goes to rows the view hides by default, and the real
/// files past the cut cannot be reached from the listing at all.
fn within_the_row_budget(files: Vec<ChangedFile>) -> Vec<ChangedFile> {
    if files.len() <= MAX_LISTED_CHANGES {
        return files;
    }
    let (sidecars, mut kept): (Vec<_>, Vec<_>) = files
        .into_iter()
        .partition(|file| is_generated_sidecar(&file.path));
    kept.truncate(MAX_LISTED_CHANGES);
    let room = MAX_LISTED_CHANGES - kept.len();
    kept.extend(sidecars.into_iter().take(room));
    kept.sort_by(|left, right| left.path.cmp(&right.path));
    kept
}

/// One changed file by name, found in the whole listing rather than the part of it that fits.
///
/// The cap is a drawing limit, not a boundary: looked up in the truncated listing, the rows past it
/// would be visible in one answer and missing from the other.
pub fn changed_file(
    workspace_path: &Path,
    base_commit: &str,
    project_file: Option<&str>,
    path: &str,
) -> Result<Option<ChangedFile>, String> {
    Ok(collect_changes(workspace_path, base_commit, project_file)?
        .into_iter()
        .find(|file| file.path == path))
}

fn collect_changes(
    workspace_path: &Path,
    base_commit: &str,
    project_file: Option<&str>,
) -> Result<Vec<ChangedFile>, String> {
    let counts = numstat(workspace_path, base_commit)?;
    let conflicted: Vec<String> = conflicting_paths(workspace_path);
    let mut files: Vec<ChangedFile> = Vec::new();

    for (code, path, from_path) in name_status(workspace_path, base_commit)? {
        if is_never_the_users_work(&path) {
            continue;
        }
        let counted = counts.get(&path).copied().unwrap_or((false, 0, 0));
        files.push(ChangedFile {
            is_conflicted: conflicted.contains(&path),
            status: ChangeStatus::from_code(&code),
            is_binary: counted.0,
            added: counted.1,
            removed: counted.2,
            from_path,
            path,
        });
    }

    for path in untracked_files(workspace_path)? {
        if is_never_the_users_work(&path) {
            continue;
        }
        files.push(ChangedFile {
            path,
            status: ChangeStatus::Added,
            from_path: None,
            // Git counts nothing for a file it has never seen, and asking per file would be a
            // process per row. So the row carries no measurement and shows none; whether it is
            // text at all is settled when it is opened, by the read that has the bytes anyway.
            is_binary: false,
            added: 0,
            removed: 0,
            is_conflicted: false,
        });
    }

    if let Some(text) = project_file {
        drop_unchanged_project_file(workspace_path, base_commit, text, &mut files);
    }

    files.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(files)
}

/// Takes `project.godot` out of the listing when the only thing changing it is Gofer.
///
/// The stripped text is what a commit would record, so comparing it against the base is the same
/// question the user is asking: did this task change the project file, or is that just the addon?
fn drop_unchanged_project_file(
    workspace_path: &Path,
    base_commit: &str,
    stripped: &str,
    files: &mut Vec<ChangedFile>,
) {
    let Ok(Some(original)) = blob_at(workspace_path, base_commit, crate::addon::PROJECT_FILE)
    else {
        return;
    };
    if original.as_slice() != stripped.as_bytes() {
        return;
    }
    files.retain(|file| file.path != crate::addon::PROJECT_FILE);
}

fn is_never_the_users_work(path: &str) -> bool {
    NEVER_THE_USERS_WORK
        .iter()
        .any(|prefix| path.starts_with(prefix))
}

/// `--name-status`, as `(code, path, from_path)`.
///
/// `-z` is not a preference. Without it Git C-quotes any path that is not plain ASCII —
/// `"w\303\251ird.gd"` — and that string names no file on disk.
fn name_status(
    workspace_path: &Path,
    base_commit: &str,
) -> Result<Vec<(String, String, Option<String>)>, String> {
    let output = git_bytes(
        workspace_path,
        &["diff", "--name-status", "-M", "-z", base_commit],
    )?;
    let mut records = nul_records(&output).into_iter();
    let mut listed = Vec::new();
    while let Some(code) = records.next() {
        if code.is_empty() {
            continue;
        }
        let paired = ChangeStatus::pairs_two_paths(&code);
        let Some(first) = records.next() else { break };
        if !paired {
            listed.push((code, first, None));
            continue;
        }
        let Some(second) = records.next() else { break };
        listed.push((code, second, Some(first)));
    }
    Ok(listed)
}

/// `--numstat` by path: `(is_binary, added, removed)`.
///
/// Read separately from `--name-status` because only this one answers whether Git considers a file
/// binary, and only `-z` makes the two joinable: without it a rename is one field spelled
/// `src/{old => new}/thing.gd`, which matches no path in the other listing.
fn numstat(
    workspace_path: &Path,
    base_commit: &str,
) -> Result<std::collections::HashMap<String, (bool, u32, u32)>, String> {
    let output = git_bytes(
        workspace_path,
        &["diff", "--numstat", "-M", "-z", base_commit],
    )?;
    let mut records = nul_records(&output).into_iter();
    let mut counted = std::collections::HashMap::new();
    while let Some(record) = records.next() {
        if record.is_empty() {
            continue;
        }
        let mut fields = record.splitn(3, '\t');
        let (Some(added), Some(removed), Some(path)) =
            (fields.next(), fields.next(), fields.next())
        else {
            continue;
        };
        // A rename leaves the path field empty and puts both names in the records that follow.
        let path = if path.is_empty() {
            let Some(_from) = records.next() else { break };
            let Some(to) = records.next() else { break };
            to
        } else {
            path.to_owned()
        };
        let is_binary = added == "-" || removed == "-";
        counted.insert(
            path,
            (
                is_binary,
                added.parse().unwrap_or(0),
                removed.parse().unwrap_or(0),
            ),
        );
    }
    Ok(counted)
}

/// Files Git has never seen. `git diff` against a commit never lists one, so this is the other half
/// of the listing rather than an extra.
///
/// `--full-name` because `ls-files` answers relative to the directory it runs in, where `git diff`
/// answers relative to the repository root.
fn untracked_files(workspace_path: &Path) -> Result<Vec<String>, String> {
    let output = git_bytes(
        workspace_path,
        &[
            "ls-files",
            "--others",
            "--exclude-standard",
            "--full-name",
            "-z",
        ],
    )?;
    Ok(nul_records(&output)
        .into_iter()
        .filter(|path| !path.is_empty())
        .collect())
}

/// Splits Git's `-z` output into its records, the empty tail of the final separator included.
///
/// Lossy on purpose: a path Git cannot spell in UTF-8 is still better shown mangled than dropped
/// from a listing whose whole job is to be complete.
fn nul_records(output: &[u8]) -> Vec<String> {
    output
        .split(|byte| *byte == 0)
        .map(|record| String::from_utf8_lossy(record).into_owned())
        .collect()
}

/// The two sides of one file, as a diff editor needs them.
///
/// `from_path` is where a renamed file came from, and the side at the base has to be read from
/// there rather than from the name it has now.
pub fn file_diff(
    workspace_path: &Path,
    base_commit: &str,
    path: &str,
    from_path: Option<&str>,
    status: ChangeStatus,
    project_file: Option<&str>,
) -> Result<FileDiff, String> {
    let source = from_path.unwrap_or(path);
    if is_submodule(workspace_path, base_commit, source, path) {
        return Ok(FileDiff {
            path: path.to_owned(),
            is_submodule: true,
            ..FileDiff::default()
        });
    }
    let reads_a_base_side = status != ChangeStatus::Added;
    // Asked before either side is read, because answering "too large" by loading the file first is
    // how a packed atlas or an imported video takes the process down instead of a row saying so.
    if reads_a_base_side
        && blob_size(workspace_path, base_commit, source) > crate::files::MAX_FILE_BYTES
    {
        return Ok(too_large(path));
    }
    if status != ChangeStatus::Deleted
        && working_file_size(workspace_path, path) > crate::files::MAX_FILE_BYTES
    {
        return Ok(too_large(path));
    }
    let original = match status {
        // Nothing existed at the base, and asking Git for it fails rather than answering nothing.
        ChangeStatus::Added => Vec::new(),
        _ => match blob_at(workspace_path, base_commit, source)? {
            Some(bytes) => bytes,
            None => return Ok(too_large(path)),
        },
    };
    // The row survived the listing because the task really did edit the project file. Read raw it
    // would still show the addon's own two lines beside that edit, as work nobody did.
    if path == crate::addon::PROJECT_FILE
        && let Some(stripped) = project_file
    {
        return Ok(decoded(path, original, stripped.as_bytes().to_vec()));
    }
    let modified = match status {
        ChangeStatus::Deleted => Vec::new(),
        _ => read_working_file(workspace_path, path)?,
    };
    Ok(decoded(path, original, modified))
}

/// The two sides as a diff editor can take them, or the reason it cannot have them.
///
/// Neither side is turned into text until both are known to fit, and a side that is not UTF-8 is
/// answered as such rather than failing: a Latin-1 script is not binary to Git, so it reaches here.
fn decoded(path: &str, original: Vec<u8>, modified: Vec<u8>) -> FileDiff {
    if original.len() as u64 > crate::files::MAX_FILE_BYTES
        || modified.len() as u64 > crate::files::MAX_FILE_BYTES
    {
        return FileDiff {
            path: path.to_owned(),
            is_too_large: true,
            ..FileDiff::default()
        };
    }
    let (Ok(original), Ok(modified)) = (String::from_utf8(original), String::from_utf8(modified))
    else {
        return FileDiff {
            path: path.to_owned(),
            ..FileDiff::default()
        };
    };
    FileDiff {
        path: path.to_owned(),
        original,
        modified,
        is_text: true,
        is_too_large: false,
        is_submodule: false,
    }
}

fn too_large(path: &str) -> FileDiff {
    FileDiff {
        path: path.to_owned(),
        is_too_large: true,
        ..FileDiff::default()
    }
}

/// Whether this path is another repository rather than a file, at the base or on disk now.
///
/// Git gives a submodule the same `M` and the same line counts as an edited file, so nothing in the
/// listing separates the two. Every read of one fails: `cat-file` is asked for a blob and the tree
/// holds a commit.
fn is_submodule(workspace_path: &Path, commit: &str, source: &str, path: &str) -> bool {
    git_text(workspace_path, &["ls-tree", commit, "--", source])
        .is_ok_and(|entry| entry.starts_with("160000"))
        || workspace_path.join(path).join(".git").exists()
}

/// What the base holds for this path, in bytes, without fetching any of it. Answers zero for a
/// path the base does not have, which the status has already ruled out.
fn blob_size(workspace_path: &Path, commit: &str, path: &str) -> u64 {
    git_text(
        workspace_path,
        &["cat-file", "-s", &format!("{commit}:{path}")],
    )
    .ok()
    .and_then(|size| size.trim().parse().ok())
    .unwrap_or(0)
}

fn working_file_size(workspace_path: &Path, path: &str) -> u64 {
    crate::files::Workspace::open(workspace_path)
        .and_then(|workspace| workspace.resolve(path))
        .ok()
        .and_then(|resolved| fs::metadata(resolved).ok())
        .map_or(0, |metadata| metadata.len())
}

/// One file as the base commit holds it, converted the way a checkout would write it.
///
/// `cat-file --filters` rather than `show`: `show` hands back the stored blob, so on a checkout
/// with `core.autocrlf` on, every line of every file differs from the copy on disk and Git itself
/// reports the file unchanged. This applies the same conversion the working tree got.
///
/// Read with a ceiling rather than into whatever it turns out to be. `cat-file -s` measures the
/// stored object, and a smudge filter — git-lfs, on the art in any large Godot project — turns a
/// 130 byte pointer into the whole asset. Checked only on the stored size, the guard passes and the
/// filter's output arrives in memory anyway. Answers `None` for anything past the ceiling.
fn blob_at(workspace_path: &Path, commit: &str, path: &str) -> Result<Option<Vec<u8>>, String> {
    let mut child = git_command(
        workspace_path,
        &["cat-file", "--filters", &format!("{commit}:{path}")],
    )
    .stdout(Stdio::piped())
    .stderr(Stdio::null())
    .spawn()
    .map_err(|error| format!("Could not start Git: {error}"))?;
    let mut stdout = child.stdout.take().ok_or("Git produced no output")?;
    let mut held = Vec::new();
    let capped = (&mut stdout).take(crate::files::MAX_FILE_BYTES + 1);
    let read = std::io::BufReader::new(capped).read_to_end(&mut held);
    // Killed rather than drained: a filter still writing gigabytes has nothing left to tell us.
    let _ = child.kill();
    let status = child
        .wait()
        .map_err(|error| format!("Could not read from Git: {error}"))?;
    read.map_err(|error| format!("Could not read {path}: {error}"))?;
    if held.len() as u64 > crate::files::MAX_FILE_BYTES {
        return Ok(None);
    }
    if !status.success() && held.is_empty() {
        return Err(format!("Could not read {path} from {commit}"));
    }
    Ok(Some(held))
}

/// The copy on disk, through the workspace's own guard rather than around it.
///
/// `Workspace::resolve` is the single place that refuses a path leaving the worktree, symlinks
/// included. Git lists a symlink as an ordinary added file, so joining the path by hand would read
/// whatever it points at and draw it in the diff editor.
fn read_working_file(workspace_path: &Path, path: &str) -> Result<Vec<u8>, String> {
    let resolved = crate::files::Workspace::open(workspace_path)
        .and_then(|workspace| workspace.resolve(path))
        .map_err(|error| error.message)?;
    fs::read(resolved).map_err(|error| format!("Could not read {path}: {error}"))
}

/// Git's stdout exactly as it came.
///
/// [`git_text`] trims and insists on UTF-8, and a file's own bytes survive neither: trimming eats
/// the trailing newline that every other reader keeps, and a Latin-1 script is not binary to Git
/// but is not UTF-8 either.
fn git_bytes(directory: &Path, arguments: &[&str]) -> Result<Vec<u8>, String> {
    let output = git_output(directory, arguments)?;
    if !output.status.success() {
        return Err(git_failure("read from Git", &output));
    }
    Ok(output.stdout)
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

    /// Git refuses to commit without an author, and a runner has no global one.
    fn identify(directory: &Path) {
        git(directory, &["config", "user.name", "Gofer Test"]);
        git(
            directory,
            &["config", "user.email", "gofer@example.invalid"],
        );
    }

    fn repository() -> TempDir {
        let directory = TempDir::new().expect("temporary repository");
        git(directory.path(), &["init", "-b", "master"]);
        identify(directory.path());
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

    /// The listing behind the New Task dialog must not offer a choice about a clone.
    ///
    /// Both answers there say the files move — into the new task, or into the one being closed — and
    /// neither is true of a folder the switch leaves alone. A user whose only loose thing is an
    /// agent's clone would be asked about work that does not exist.
    #[test]
    fn a_clone_is_not_offered_as_work_to_carry() {
        let repository = repository();
        clone_into(&repository, "profiler_evidence/_godotsrc");
        fs::write(repository.path().join("player.gd"), "extends Node\n").expect("real work");

        let listed = pending_changes(repository.path()).expect("the loose files");

        assert_eq!(
            listed,
            vec![PendingChange {
                path: "player.gd".to_owned(),
                is_new: true
            }]
        );
    }

    /// A Git repository inside the checkout, and a commit in it so it can be gitlinked at all.
    fn clone_into(repository: &TempDir, path: &str) {
        let inner = repository.path().join(path);
        fs::create_dir_all(&inner).expect("the inner directory");
        git(&inner, &["init", "-b", "master"]);
        identify(&inner);
        fs::write(inner.join("source.txt"), "borrowed\n").expect("a file in the clone");
        git(&inner, &["add", "--all"]);
        git(&inner, &["commit", "-m", "the clone"]);
    }

    /**
     * A clone in the project folder is never banked, and the parent it sits under does not matter.
     *
     * The parent was itself untracked in the case this comes from, which is what defeats a scan of
     * plain `git status`: Git collapses the whole directory to its own name, and a look for a `.git`
     * in that name finds nothing while the clone underneath is gitlinked anyway.
     */
    #[test]
    fn a_clone_under_an_untracked_directory_is_left_out_of_the_commit() {
        let repository = repository();
        create_task_branch(repository.path(), TASK, "master").expect("create the branch");
        checkout_branch(repository.path(), TASK).expect("open the task");
        clone_into(&repository, "profiler_evidence/_godotsrc");
        fs::write(repository.path().join("player.gd"), "extends Node\n").expect("real work");

        assert!(commit_pending_changes(repository.path()).expect("bank the work"));

        let listed = git_text(repository.path(), &["ls-files", "--stage"]).expect("the index");
        assert!(listed.contains("player.gd"), "{listed}");
        assert!(
            !listed.contains("_godotsrc"),
            "the clone must not be in the index: {listed}"
        );
        assert!(
            repository
                .path()
                .join("profiler_evidence/_godotsrc/source.txt")
                .exists(),
            "the clone stays on disk"
        );
    }

    /// A clone with nothing committed in it yet. `git add --all` refuses it outright — "does not
    /// have a commit checked out" — and a refusal here is a task the user cannot switch away from.
    #[test]
    fn a_clone_with_no_commit_does_not_block_the_switch() {
        let repository = repository();
        create_task_branch(repository.path(), TASK, "master").expect("create the branch");
        checkout_branch(repository.path(), TASK).expect("open the task");
        let inner = repository.path().join("half_a_clone");
        fs::create_dir_all(&inner).expect("the inner directory");
        git(&inner, &["init", "-b", "master"]);
        fs::write(repository.path().join("player.gd"), "extends Node\n").expect("real work");

        assert!(commit_pending_changes(repository.path()).expect("the switch must go through"));
    }

    /// A clone on its own is not work, so there is nothing to bank and the branch must not move.
    /// A branch that moves after its merge is a merged task asking to be merged again.
    #[test]
    fn a_clone_on_its_own_moves_no_branch() {
        let repository = repository();
        create_task_branch(repository.path(), TASK, "master").expect("create the branch");
        checkout_branch(repository.path(), TASK).expect("open the task");
        let before = git_text(repository.path(), &["rev-parse", "HEAD"]).expect("head");
        clone_into(&repository, "profiler_evidence/_godotsrc");

        assert!(!commit_pending_changes(repository.path()).expect("nothing to bank"));

        assert_eq!(
            git_text(repository.path(), &["rev-parse", "HEAD"]).expect("head"),
            before,
            "the branch must stand exactly where its merge left it"
        );
    }

    /// A path Git would C-quote without `-z`, which names no directory on disk once quoted.
    #[test]
    fn a_clone_whose_path_git_would_quote_is_still_left_out() {
        let repository = repository();
        create_task_branch(repository.path(), TASK, "master").expect("create the branch");
        checkout_branch(repository.path(), TASK).expect("open the task");
        clone_into(&repository, "wéird évidence");
        fs::write(repository.path().join("player.gd"), "extends Node\n").expect("real work");

        assert!(commit_pending_changes(repository.path()).expect("bank the work"));

        let listed = git_text(repository.path(), &["ls-files", "--stage"]).expect("the index");
        assert!(!listed.contains("vidence"), "{listed}");
    }

    /// The exclusion names a path, not a pattern. A clone called `star*dir` that also swallowed a
    /// real `starXdir` would lose the user work it matched, silently and for good.
    #[test]
    fn excluding_a_clone_does_not_exclude_a_directory_its_name_would_match() {
        let repository = repository();
        create_task_branch(repository.path(), TASK, "master").expect("create the branch");
        checkout_branch(repository.path(), TASK).expect("open the task");
        clone_into(&repository, "star*dir");
        let decoy = repository.path().join("starXdir");
        fs::create_dir_all(&decoy).expect("the decoy");
        fs::write(decoy.join("real.gd"), "extends Node\n").expect("real work");

        assert!(commit_pending_changes(repository.path()).expect("bank the work"));

        let listed = git_text(repository.path(), &["ls-files", "--stage"]).expect("the index");
        assert!(listed.contains("starXdir/real.gd"), "{listed}");
        assert!(!listed.contains("star*dir"), "{listed}");
    }

    /// Excluding a clone must not narrow the rest of the commit. `--all` with a pathspec still has
    /// to record a file the user deleted.
    #[test]
    fn a_deleted_file_is_still_banked_while_a_clone_is_left_out() {
        let repository = repository();
        create_task_branch(repository.path(), TASK, "master").expect("create the branch");
        checkout_branch(repository.path(), TASK).expect("open the task");
        fs::write(repository.path().join("player.gd"), "extends Node\n").expect("a file");
        git(repository.path(), &["add", "--all"]);
        git(repository.path(), &["commit", "-m", "with the file"]);
        fs::remove_file(repository.path().join("player.gd")).expect("delete it");
        clone_into(&repository, "profiler_evidence/_godotsrc");

        assert!(commit_pending_changes(repository.path()).expect("bank the work"));

        let listed = git_text(repository.path(), &["ls-files", "--stage"]).expect("the index");
        assert!(!listed.contains("player.gd"), "{listed}");
    }

    /// A submodule the project registered is the user's own dependency, and moving its pointer is
    /// their work. Git tracks it, so it is never reported as untracked and the exclusion cannot
    /// reach it — which is the whole reason this reads Git's status instead of walking the folder
    /// for a `.git`.
    #[test]
    fn a_registered_submodule_is_still_banked_as_the_tasks_work() {
        let outer = repository();
        let inner = repository();
        let url = inner.path().to_string_lossy().to_string();
        git(
            outer.path(),
            &[
                "-c",
                "protocol.file.allow=always",
                "submodule",
                "add",
                &url,
                "addons/dep",
            ],
        );
        git(outer.path(), &["add", "-A"]);
        git(outer.path(), &["commit", "-m", "Vendor a dependency"]);
        create_task_branch(outer.path(), TASK, "master").expect("create the branch");
        checkout_branch(outer.path(), TASK).expect("open the task");

        let dependency = outer.path().join("addons/dep");
        identify(&dependency);
        fs::write(dependency.join("moved.gd"), "extends Node\n").expect("write");
        git(&dependency, &["add", "-A"]);
        git(&dependency, &["commit", "-m", "Move the pointer"]);

        assert!(commit_pending_changes(outer.path()).expect("bank the work"));

        let recorded = git_text(outer.path(), &["show", "--stat", "--format=", "HEAD"])
            .expect("the banked commit");
        assert!(recorded.contains("addons/dep"), "{recorded}");
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
    /// A bank that was refused leaves the checkout where it is, branch and all.
    ///
    /// The bank is what keeps a task's loose files off the branch being moved to. Moving anyway put
    /// them on the base branch as work nobody did, and the refusal was thrown away without ever
    /// reaching the user.
    #[test]
    fn discarding_a_branch_whose_work_cannot_be_banked_moves_nothing() {
        let repository = repository();
        conflicting_task(&repository);
        resolve_task_conflicts(repository.path(), TASK, "master").expect("start the resolution");

        let refusal = discard_task_branch(repository.path(), TASK, "master")
            .expect_err("an unfinished merge cannot be banked");

        assert!(refusal.contains("part-way through a merge"), "{refusal}");

        assert_eq!(
            current_branch(repository.path()).as_deref(),
            Some(TASK),
            "an unfinished merge must not be walked away from"
        );
        assert!(
            branch_exists(repository.path(), TASK),
            "the branch outlives the task rather than the work being moved"
        );
    }

    #[test]
    fn discarding_the_checked_out_task_branch_moves_off_it_first() {
        let repository = repository();
        create_task_branch(repository.path(), TASK, "master").expect("create the branch");
        checkout_branch(repository.path(), TASK).expect("open the task");
        fs::write(repository.path().join("scratch.gd"), "extends Node\n").expect("loose work");

        let _ = discard_task_branch(repository.path(), TASK, "master");

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
        let _ = discard_task_branch(directory.path(), TASK, "master");
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
        identify(directory.path());
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
    /// Everything the working tree holds, whether or not it was ever committed.
    ///
    /// Gofer leaves a task's work loose until a switch, so a listing that read only the index would
    /// be empty for exactly the case the view exists for.
    #[test]
    fn a_task_lists_committed_and_uncommitted_work_alike() {
        let repository = repository();
        let base = git_text(repository.path(), &["rev-parse", "HEAD"]).expect("head");
        fs::write(repository.path().join("banked.gd"), "extends Node\n").expect("banked");
        git(repository.path(), &["add", "--all"]);
        git(repository.path(), &["commit", "-m", "banked"]);
        fs::write(repository.path().join("loose.gd"), "extends Node2D\n").expect("loose");
        fs::write(
            repository.path().join("project.godot"),
            "[application]\nx=1\n",
        )
        .expect("edit");

        let changes = changed_files(repository.path(), &base, None).expect("list the changes");

        let listed: Vec<(&str, ChangeStatus)> = changes
            .files
            .iter()
            .map(|file| (file.path.as_str(), file.status))
            .collect();
        assert_eq!(
            listed,
            [
                ("banked.gd", ChangeStatus::Added),
                ("loose.gd", ChangeStatus::Added),
                ("project.godot", ChangeStatus::Modified),
            ]
        );
        assert_eq!(changes.dropped, 0);
        assert!(!changes.is_merging);
    }

    /// Git's own answer about binary, rather than a guess from the extension: `--numstat` prints a
    /// dash where it will not count lines, and that is the only honest signal there is.
    #[test]
    fn a_binary_file_is_named_binary_and_carries_no_counts() {
        let repository = repository();
        let base = git_text(repository.path(), &["rev-parse", "HEAD"]).expect("head");
        fs::write(repository.path().join("sprite.png"), [0u8, 1, 2, 255, 254]).expect("binary");
        fs::write(repository.path().join("player.gd"), "extends Node\n").expect("script");
        git(repository.path(), &["add", "--all"]);
        git(repository.path(), &["commit", "-m", "assets"]);

        let changes = changed_files(repository.path(), &base, None).expect("list the changes");

        let binary = find(&changes, "sprite.png");
        assert!(binary.is_binary, "Git refused to count its lines");
        assert_eq!((binary.added, binary.removed), (0, 0));
        let script = find(&changes, "player.gd");
        assert!(!script.is_binary);
        assert_eq!(script.added, 1);
    }

    /// A rename made during a task is a delete and an add, because Git pairs a rename from the
    /// index and Gofer never stages one. `git status` tells a human the same thing about the same
    /// tree, so this is the truth rather than a shortfall.
    #[test]
    fn a_rename_the_agent_made_reads_as_a_delete_and_an_add() {
        let repository = repository();
        fs::write(
            repository.path().join("old.gd"),
            "extends Node\nfunc a():\n\tpass\n",
        )
        .expect("script");
        git(repository.path(), &["add", "--all"]);
        git(repository.path(), &["commit", "-m", "script"]);
        let base = git_text(repository.path(), &["rev-parse", "HEAD"]).expect("head");
        fs::rename(
            repository.path().join("old.gd"),
            repository.path().join("new.gd"),
        )
        .expect("rename");

        let changes = changed_files(repository.path(), &base, None).expect("list the changes");

        assert_eq!(find(&changes, "old.gd").status, ChangeStatus::Deleted);
        assert_eq!(find(&changes, "new.gd").status, ChangeStatus::Added);
        assert!(
            changes.files.iter().all(|file| file.from_path.is_none()),
            "nothing may claim to know where an unstaged rename came from"
        );
    }

    /// A rename a task switch already committed is a rename, and carries where it came from.
    #[test]
    fn a_rename_that_was_committed_keeps_the_name_it_had() {
        let repository = repository();
        fs::write(
            repository.path().join("old.gd"),
            "extends Node\nfunc a():\n\tpass\n",
        )
        .expect("script");
        git(repository.path(), &["add", "--all"]);
        git(repository.path(), &["commit", "-m", "script"]);
        let base = git_text(repository.path(), &["rev-parse", "HEAD"]).expect("head");
        git(repository.path(), &["mv", "old.gd", "new.gd"]);
        git(repository.path(), &["commit", "-m", "renamed"]);

        let changes = changed_files(repository.path(), &base, None).expect("list the changes");

        let renamed = find(&changes, "new.gd");
        assert_eq!(renamed.status, ChangeStatus::Renamed);
        assert_eq!(renamed.from_path.as_deref(), Some("old.gd"));
    }

    /// Git spells a rename as one braced field in `--numstat` and as two fields in `--name-status`,
    /// so the two listings are joined by path and the join has to survive it.
    #[test]
    fn a_rename_under_a_shared_directory_still_joins_to_its_counts() {
        let repository = repository();
        fs::create_dir_all(repository.path().join("src/old")).expect("directory");
        fs::write(
            repository.path().join("src/old/thing.gd"),
            "extends Node\nfunc a():\n\tpass\n",
        )
        .expect("script");
        git(repository.path(), &["add", "--all"]);
        git(repository.path(), &["commit", "-m", "script"]);
        let base = git_text(repository.path(), &["rev-parse", "HEAD"]).expect("head");
        fs::create_dir_all(repository.path().join("src/new")).expect("directory");
        git(
            repository.path(),
            &["mv", "src/old/thing.gd", "src/new/thing.gd"],
        );
        git(repository.path(), &["commit", "-m", "moved"]);

        let changes = changed_files(repository.path(), &base, None).expect("list the changes");

        let moved = find(&changes, "src/new/thing.gd");
        assert_eq!(moved.status, ChangeStatus::Renamed);
        assert!(
            !moved.is_binary,
            "the counts joined, so the row is not left looking like a binary"
        );
    }

    /// Git C-quotes any path that is not plain ASCII unless it is asked for `-z`, and a quoted path
    /// names no file on disk.
    #[test]
    fn a_path_that_is_not_ascii_arrives_as_itself() {
        let repository = repository();
        let base = git_text(repository.path(), &["rev-parse", "HEAD"]).expect("head");
        fs::write(repository.path().join("spelar.gd"), "extends Node\n").expect("tracked");
        git(repository.path(), &["add", "--all"]);
        git(repository.path(), &["commit", "-m", "tracked"]);
        git(repository.path(), &["mv", "spelar.gd", "spelaré.gd"]);
        git(repository.path(), &["commit", "-m", "accented"]);
        fs::write(repository.path().join("löse.gd"), "extends Node\n").expect("untracked");

        let changes = changed_files(repository.path(), &base, None).expect("list the changes");

        let paths: Vec<&str> = changes
            .files
            .iter()
            .map(|file| file.path.as_str())
            .collect();
        assert!(paths.contains(&"spelaré.gd"), "{paths:?}");
        assert!(paths.contains(&"löse.gd"), "{paths:?}");
        assert!(
            paths.iter().all(|path| !path.contains('\\')),
            "an octal escape is not a path: {paths:?}"
        );
    }

    /// A file becoming a symlink is `T`, which is neither an add nor a modification, and a listing
    /// that had no arm for it would report something untrue.
    #[test]
    fn a_file_that_changed_type_is_named_rather_than_guessed_at() {
        let repository = repository();
        fs::write(repository.path().join("link.txt"), "text\n").expect("file");
        git(repository.path(), &["add", "--all"]);
        git(repository.path(), &["commit", "-m", "file"]);
        let base = git_text(repository.path(), &["rev-parse", "HEAD"]).expect("head");
        fs::remove_file(repository.path().join("link.txt")).expect("remove");
        std::os::unix::fs::symlink("project.godot", repository.path().join("link.txt"))
            .expect("symlink");

        let changes = changed_files(repository.path(), &base, None).expect("list the changes");

        assert_eq!(find(&changes, "link.txt").status, ChangeStatus::TypeChanged);
    }

    /// Gofer's own directory holds the project database, which is rewritten every turn and is
    /// nobody's work. Nothing has ever put it in an ignore file, so the listing has to.
    #[test]
    fn gofers_own_files_are_never_listed_as_the_tasks_work() {
        let repository = repository();
        let base = git_text(repository.path(), &["rev-parse", "HEAD"]).expect("head");
        for path in [".gofer/project.sqlite", ".godot/uid_cache.bin"] {
            let file = repository.path().join(path);
            fs::create_dir_all(file.parent().expect("parent")).expect("directory");
            fs::write(&file, "not the game").expect("write");
        }
        fs::write(repository.path().join("player.gd"), "extends Node\n").expect("script");

        let changes = changed_files(repository.path(), &base, None).expect("list the changes");

        let paths: Vec<&str> = changes
            .files
            .iter()
            .map(|file| file.path.as_str())
            .collect();
        assert_eq!(paths, ["player.gd"], "{paths:?}");
    }

    /// The addon puts two lines in `project.godot` while a session runs. Left in, every diff taken
    /// during a session shows a change to the project file that nobody made.
    #[test]
    fn the_project_file_is_dropped_when_only_the_addon_changed_it() {
        let repository = repository();
        let base = git_text(repository.path(), &["rev-parse", "HEAD"]).expect("head");
        let staged = "[application]\n[autoload]\nGoferRuntime=\"*res://addons/gofer/runtime.gd\"\n";
        fs::write(repository.path().join("project.godot"), staged).expect("staged project file");

        let with_addon = changed_files(repository.path(), &base, None).expect("list the changes");
        assert_eq!(with_addon.files.len(), 1, "the addon's edit is a change");

        let stripped = changed_files(repository.path(), &base, Some("[application]\n"))
            .expect("list the changes");

        assert!(
            stripped.files.is_empty(),
            "with the addon's lines taken back out the task changed nothing: {:?}",
            stripped.files
        );
    }

    /// A task that also edited the project file keeps it, or the view would hide real work.
    #[test]
    fn the_project_file_stays_when_the_task_changed_it_too() {
        let repository = repository();
        let base = git_text(repository.path(), &["rev-parse", "HEAD"]).expect("head");
        fs::write(
            repository.path().join("project.godot"),
            "[application]\nname=\"the game\"\n[autoload]\nGoferRuntime=\"*res://x.gd\"\n",
        )
        .expect("project file");

        let changes = changed_files(
            repository.path(),
            &base,
            Some("[application]\nname=\"the game\"\n"),
        )
        .expect("list the changes");

        assert_eq!(
            find(&changes, "project.godot").status,
            ChangeStatus::Modified
        );
    }

    /// A listing cut to fit says how many it dropped. A short listing that says so still lets
    /// someone go looking; a silently short one does not.
    #[test]
    fn an_oversized_listing_is_cut_and_says_how_many_it_dropped() {
        let repository = repository();
        let base = git_text(repository.path(), &["rev-parse", "HEAD"]).expect("head");
        for index in 0..MAX_LISTED_CHANGES + 25 {
            fs::write(
                repository.path().join(format!("scene_{index:04}.gd")),
                "extends Node\n",
            )
            .expect("script");
        }

        let changes = changed_files(repository.path(), &base, None).expect("list the changes");

        assert_eq!(changes.files.len(), MAX_LISTED_CHANGES);
        assert_eq!(changes.dropped, 25);
    }

    /// A merge left half-finished puts Git's markers in the working tree. Read as the task's work
    /// they are a diff of something nobody wrote, so the rows say which files they are.
    #[test]
    fn files_a_merge_left_conflicted_are_marked_as_such() {
        let repository = repository();
        create_task_branch(repository.path(), TASK, "master").expect("create the branch");
        fs::write(
            repository.path().join("player.gd"),
            "extends Node # master\n",
        )
        .expect("edit");
        git(repository.path(), &["add", "--all"]);
        git(repository.path(), &["commit", "-m", "master edit"]);
        checkout_branch(repository.path(), TASK).expect("open the task");
        let base = git_text(repository.path(), &["rev-parse", "HEAD"]).expect("head");
        fs::write(repository.path().join("player.gd"), "extends Node # task\n").expect("edit");
        git(repository.path(), &["add", "--all"]);
        git(repository.path(), &["commit", "-m", "task edit"]);
        resolve_task_conflicts(repository.path(), TASK, "master").expect("start the merge");

        let changes = changed_files(repository.path(), &base, None).expect("list the changes");

        assert!(changes.is_merging, "the view has to say a merge is open");
        assert!(
            find(&changes, "player.gd").is_conflicted,
            "the file holds both versions, not the task's work"
        );
    }

    /// The content read must not go through `git_text`, which trims. The side on disk is not
    /// trimmed, so a trimmed original shows a change at the end of every file that has one.
    #[test]
    fn a_files_trailing_newlines_survive_the_read() {
        let repository = repository();
        fs::write(repository.path().join("player.gd"), "extends Node\n\n\n").expect("script");
        git(repository.path(), &["add", "--all"]);
        git(repository.path(), &["commit", "-m", "script"]);
        let base = git_text(repository.path(), &["rev-parse", "HEAD"]).expect("head");
        fs::write(repository.path().join("player.gd"), "extends Node2D\n\n\n").expect("edit");

        let diff = file_diff(
            repository.path(),
            &base,
            "player.gd",
            None,
            ChangeStatus::Modified,
            None,
        )
        .expect("read the diff");

        assert_eq!(diff.original, "extends Node\n\n\n");
        assert_eq!(diff.modified, "extends Node2D\n\n\n");
        assert!(diff.is_text);
    }

    /// An added file has no side at the base, and asking Git for one fails rather than answering
    /// nothing — so the status decides, not an error that gets swallowed.
    #[test]
    fn an_added_file_reads_as_an_empty_original_rather_than_a_failure() {
        let repository = repository();
        let base = git_text(repository.path(), &["rev-parse", "HEAD"]).expect("head");
        fs::write(repository.path().join("fresh.gd"), "extends Node\n").expect("script");

        let diff = file_diff(
            repository.path(),
            &base,
            "fresh.gd",
            None,
            ChangeStatus::Added,
            None,
        )
        .expect("read the diff");

        assert_eq!(diff.original, "");
        assert_eq!(diff.modified, "extends Node\n");
    }

    /// A deleted file has no side on disk, and reading one would fail.
    #[test]
    fn a_deleted_file_reads_as_an_empty_modified_side() {
        let repository = repository();
        fs::write(repository.path().join("gone.gd"), "extends Node\n").expect("script");
        git(repository.path(), &["add", "--all"]);
        git(repository.path(), &["commit", "-m", "script"]);
        let base = git_text(repository.path(), &["rev-parse", "HEAD"]).expect("head");
        fs::remove_file(repository.path().join("gone.gd")).expect("remove");

        let diff = file_diff(
            repository.path(),
            &base,
            "gone.gd",
            None,
            ChangeStatus::Deleted,
            None,
        )
        .expect("read the diff");

        assert_eq!(diff.original, "extends Node\n");
        assert_eq!(diff.modified, "");
    }

    /// A Latin-1 script is not binary to Git — it counts its lines — but it is not UTF-8 either,
    /// and a read that insisted on UTF-8 would fail the whole listing rather than one row.
    #[test]
    fn a_file_that_is_not_utf8_is_reported_rather_than_failing_the_read() {
        let repository = repository();
        fs::write(repository.path().join("latin.gd"), b"# caf\xe9\n").expect("latin-1");
        git(repository.path(), &["add", "--all"]);
        git(repository.path(), &["commit", "-m", "latin"]);
        let base = git_text(repository.path(), &["rev-parse", "HEAD"]).expect("head");
        fs::write(repository.path().join("latin.gd"), b"# caf\xe9 changed\n").expect("edit");

        let diff = file_diff(
            repository.path(),
            &base,
            "latin.gd",
            None,
            ChangeStatus::Modified,
            None,
        )
        .expect("the read answers rather than failing");

        assert!(!diff.is_text, "there is nothing a diff editor can show");
        assert!(!diff.is_too_large);
    }

    /// A file past the workspace's own read ceiling is answered as such, rather than sent to a
    /// diff editor that would have to hold both sides of it.
    #[test]
    fn a_file_over_the_ceiling_says_so_instead_of_answering_its_text() {
        let repository = repository();
        let base = git_text(repository.path(), &["rev-parse", "HEAD"]).expect("head");
        fs::write(
            repository.path().join("huge.txt"),
            vec![b'a'; crate::files::MAX_FILE_BYTES as usize + 1],
        )
        .expect("huge");

        let diff = file_diff(
            repository.path(),
            &base,
            "huge.txt",
            None,
            ChangeStatus::Added,
            None,
        )
        .expect("read the diff");

        assert!(diff.is_too_large);
        assert_eq!(diff.modified, "", "nothing that large may cross the wire");
    }

    /// A rename's side at the base lives under the name it used to have.
    #[test]
    fn a_renamed_files_original_is_read_from_where_it_came_from() {
        let repository = repository();
        fs::write(
            repository.path().join("old.gd"),
            "extends Node\nfunc a():\n\tpass\n",
        )
        .expect("script");
        git(repository.path(), &["add", "--all"]);
        git(repository.path(), &["commit", "-m", "script"]);
        let base = git_text(repository.path(), &["rev-parse", "HEAD"]).expect("head");
        git(repository.path(), &["mv", "old.gd", "new.gd"]);
        git(repository.path(), &["commit", "-m", "renamed"]);

        let diff = file_diff(
            repository.path(),
            &base,
            "new.gd",
            Some("old.gd"),
            ChangeStatus::Renamed,
            None,
        )
        .expect("read the diff");

        assert_eq!(diff.original, "extends Node\nfunc a():\n\tpass\n");
        assert_eq!(diff.modified, diff.original);
    }

    /// `git show` hands back the stored blob, so on a checkout that converts line endings every
    /// line of every file differs from the copy on disk while Git itself reports the file clean.
    /// `cat-file --filters` applies the conversion the working tree got.
    #[test]
    fn a_checkout_that_converts_line_endings_still_reads_as_unchanged() {
        let repository = repository();
        git(repository.path(), &["config", "core.autocrlf", "true"]);
        fs::write(repository.path().join("notes.txt"), b"a\r\nb\r\n").expect("crlf file");
        git(repository.path(), &["add", "--all"]);
        git(repository.path(), &["commit", "-m", "notes"]);
        let base = git_text(repository.path(), &["rev-parse", "HEAD"]).expect("head");

        let diff = file_diff(
            repository.path(),
            &base,
            "notes.txt",
            None,
            ChangeStatus::Modified,
            None,
        )
        .expect("read the diff");

        assert_eq!(
            diff.original, diff.modified,
            "Git calls this file unchanged, so its two sides have to match"
        );
    }

    /// A symlink is an ordinary added file to Git, so the copy on disk has to be read through the
    /// workspace's guard rather than by joining the path: otherwise whatever it points at is what
    /// gets drawn in the diff editor.
    #[test]
    fn a_symlink_out_of_the_worktree_is_refused_rather_than_followed() {
        let repository = repository();
        let outside = TempDir::new().expect("somewhere else");
        let secret = outside.path().join("secret.txt");
        fs::write(&secret, "not the game\n").expect("secret");
        let base = git_text(repository.path(), &["rev-parse", "HEAD"]).expect("head");
        std::os::unix::fs::symlink(&secret, repository.path().join("innocent.gd")).expect("link");

        let refused = file_diff(
            repository.path(),
            &base,
            "innocent.gd",
            None,
            ChangeStatus::Added,
            None,
        )
        .expect_err("the workspace refuses a path that leaves it");

        assert!(!refused.contains("not the game"), "{refused}");
    }

    /// The cap is how many rows are drawn, not which files exist. Looked up in the truncated
    /// listing, everything past it would be a row the user can ask for and never be given.
    #[test]
    fn a_file_past_the_drawing_cap_can_still_be_read() {
        let repository = repository();
        let base = git_text(repository.path(), &["rev-parse", "HEAD"]).expect("head");
        for index in 0..MAX_LISTED_CHANGES + 5 {
            fs::write(
                repository.path().join(format!("scene_{index:04}.gd")),
                "extends Node\n",
            )
            .expect("script");
        }
        let last = format!("scene_{:04}.gd", MAX_LISTED_CHANGES + 4);

        let listed = changed_files(repository.path(), &base, None).expect("list");
        assert!(
            !listed.files.iter().any(|file| file.path == last),
            "this file is past the cap, so the listing does not draw it"
        );

        let found = changed_file(repository.path(), &base, None, &last)
            .expect("look it up")
            .expect("the cap must not decide which files exist");
        assert_eq!(found.status, ChangeStatus::Added);
    }

    /// A task that really did edit the project file keeps its row, and the side on disk still
    /// carries the addon's two lines. Shown raw, they read as work the task did.
    #[test]
    fn the_project_files_diff_leaves_the_addons_lines_out_of_the_task() {
        let repository = repository();
        let base = git_text(repository.path(), &["rev-parse", "HEAD"]).expect("head");
        let edited = "[application]\nname=\"the game\"\n";
        fs::write(
            repository.path().join("project.godot"),
            format!("{edited}[autoload]\nGoferRuntime=\"*res://addons/gofer/runtime.gd\"\n"),
        )
        .expect("staged project file");

        let diff = file_diff(
            repository.path(),
            &base,
            "project.godot",
            None,
            ChangeStatus::Modified,
            Some(edited),
        )
        .expect("read the diff");

        assert_eq!(diff.modified, edited);
        assert!(!diff.modified.contains("GoferRuntime"), "{}", diff.modified);
        assert_eq!(diff.original, "[application]\n");
    }

    /// The ceiling is answered from the sizes, never by loading the file to find out how big it is.
    /// A packed atlas read twice to say "too large" is how the window dies instead of answering.
    #[test]
    fn the_ceiling_is_answered_without_reading_either_side() {
        let repository = repository();
        let base = git_text(repository.path(), &["rev-parse", "HEAD"]).expect("head");
        let huge = repository.path().join("atlas.png");
        fs::write(&huge, vec![0u8; crate::files::MAX_FILE_BYTES as usize + 1]).expect("huge");

        assert!(
            working_file_size(repository.path(), "atlas.png") > crate::files::MAX_FILE_BYTES,
            "the size is known from the metadata alone"
        );
        assert_eq!(
            blob_size(repository.path(), &base, "project.godot"),
            fs::metadata(repository.path().join("project.godot"))
                .expect("metadata")
                .len(),
            "and the base side's size comes from Git rather than from its contents"
        );

        let diff = file_diff(
            repository.path(),
            &base,
            "atlas.png",
            None,
            ChangeStatus::Added,
            None,
        )
        .expect("answer rather than load it");

        assert!(diff.is_too_large);
        assert_eq!(diff.modified, "");
    }

    /// A smudge filter — git-lfs, on the art in any large project — turns a small stored object
    /// into a large working copy. Measured on the stored size alone the guard passes and the
    /// filter's output lands in memory regardless, which is the thing the guard is for.
    #[test]
    fn a_filter_cannot_smuggle_a_huge_file_past_the_ceiling() {
        let repository = repository();
        git(
            repository.path(),
            &[
                "config",
                "filter.balloon.smudge",
                "sh -c 'head -c 9000000 /dev/zero | tr \\\\000 a'",
            ],
        );
        fs::write(
            repository.path().join(".gitattributes"),
            "pointer.bin filter=balloon\n",
        )
        .expect("attributes");
        fs::write(repository.path().join("pointer.bin"), "a tiny pointer\n").expect("pointer");
        git(repository.path(), &["add", "--all"]);
        git(repository.path(), &["commit", "-m", "pointer"]);
        let base = git_text(repository.path(), &["rev-parse", "HEAD"]).expect("head");
        fs::remove_file(repository.path().join("pointer.bin")).expect("delete it");

        assert!(
            blob_size(repository.path(), &base, "pointer.bin") < crate::files::MAX_FILE_BYTES,
            "the stored object is small; only the filter's output is not"
        );

        // Asked of the read, which is what has to refuse it. The answer alone proves less than it
        // looks: `decoded` reports `too_large` from the bytes it is handed either way, and that the
        // read never holds them is a property no assertion here can see.
        assert_eq!(
            blob_at(repository.path(), &base, "pointer.bin").expect("read with a ceiling"),
            None,
            "the read stops at the ceiling rather than holding the filter's whole output"
        );

        let diff = file_diff(
            repository.path(),
            &base,
            "pointer.bin",
            None,
            ChangeStatus::Deleted,
            None,
        )
        .expect("answer rather than hold it all");
        assert!(diff.is_too_large);
        assert_eq!(diff.original, "");
    }

    fn find<'a>(changes: &'a TaskChanges, path: &str) -> &'a ChangedFile {
        changes
            .files
            .iter()
            .find(|file| file.path == path)
            .unwrap_or_else(|| panic!("{path} is not in {:?}", changes.files))
    }

    /// A submodule is not a file, and every read of one fails. It has to be answered rather than
    /// error, the way a binary or an oversized file is.
    #[test]
    fn a_submodule_is_listed_and_says_it_cannot_be_shown() {
        let outer = repository();
        let inner = repository();
        let url = inner.path().to_string_lossy().to_string();
        git(
            outer.path(),
            &[
                "-c",
                "protocol.file.allow=always",
                "submodule",
                "add",
                &url,
                "addons/dep",
            ],
        );
        git(outer.path(), &["add", "-A"]);
        git(outer.path(), &["commit", "-m", "Vendor a dependency"]);
        let base = git_text(outer.path(), &["rev-parse", "HEAD"]).expect("head");

        let dependency = outer.path().join("addons/dep");
        // The submodule is its own clone, so the outer repository's author is not its own.
        identify(&dependency);
        fs::write(dependency.join("moved.gd"), "extends Node\n").expect("write");
        git(&dependency, &["add", "-A"]);
        git(&dependency, &["commit", "-m", "Move the pointer"]);

        let listed = changed_files(outer.path(), &base, None).expect("listing");
        assert_eq!(
            listed
                .files
                .iter()
                .map(|file| file.path.as_str())
                .collect::<Vec<_>>(),
            vec!["addons/dep"],
            "the pointer change is the task's work and has to be listed"
        );

        let diff = file_diff(
            outer.path(),
            &base,
            "addons/dep",
            None,
            ChangeStatus::Modified,
            None,
        )
        .expect("a submodule answers rather than failing");
        assert!(diff.is_submodule);
        assert!(!diff.is_text);
    }

    /// The sidecars are hidden by default, so a budget spent on them is spent on nothing.
    #[test]
    fn the_row_budget_goes_to_the_users_files_before_godots_sidecars() {
        let real = MAX_LISTED_CHANGES - 100;
        let mut files = Vec::new();
        for index in 0..real {
            files.push(changed(&format!("assets/art/tile_{index:04}.png")));
            files.push(changed(&format!("assets/art/tile_{index:04}.png.import")));
        }
        files.push(changed("scripts/zz_last.gd"));
        files.sort_by(|left, right| left.path.cmp(&right.path));

        let kept = within_the_row_budget(files);

        assert_eq!(kept.len(), MAX_LISTED_CHANGES);
        assert_eq!(
            kept.iter()
                .filter(|file| !is_generated_sidecar(&file.path))
                .count(),
            real + 1,
            "every real file fits, and the sidecars take only what is left"
        );
        assert!(
            kept.iter().any(|file| file.path == "scripts/zz_last.gd"),
            "a real file last in path order still has to be reachable"
        );
        assert!(
            kept.windows(2).all(|pair| pair[0].path <= pair[1].path),
            "the listing stays in path order"
        );
    }

    /// The budget is the user's work first, but it is still a budget: past it, real files go too.
    #[test]
    fn a_listing_of_nothing_but_real_files_is_still_cut_at_the_cap() {
        let files = (0..MAX_LISTED_CHANGES + 50)
            .map(|index| changed(&format!("scripts/file_{index:04}.gd")))
            .collect();

        assert_eq!(within_the_row_budget(files).len(), MAX_LISTED_CHANGES);
    }

    #[test]
    fn a_dotfile_named_for_a_sidecar_is_not_one() {
        assert!(is_generated_sidecar("assets/art/tile.png.import"));
        assert!(is_generated_sidecar("scripts/player.gd.uid"));
        assert!(!is_generated_sidecar(".import"));
        assert!(!is_generated_sidecar("scripts/player.gd"));
    }

    fn changed(path: &str) -> ChangedFile {
        ChangedFile {
            path: path.to_owned(),
            status: ChangeStatus::Modified,
            from_path: None,
            is_binary: false,
            added: 1,
            removed: 0,
            is_conflicted: false,
        }
    }
}

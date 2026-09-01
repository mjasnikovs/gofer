//! The tasks in the sidebar, and the git worktrees behind them.

use std::path::PathBuf;

use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde_json::json;
use uuid::Uuid;

use super::*;
use crate::command_error::CommandError;
use crate::git;
use crate::task_switch::Switch;

/// The tasks in the sidebar, and the git worktrees behind them.
///
/// Creating, activating, deleting and merging a task each move a worktree as well as a row, which
/// is why they are one ledger rather than a table and a directory that have to agree.
pub struct Tasks<'a> {
    pub(super) storage: &'a ProjectStorage,
}

impl Tasks<'_> {
    /// Makes a task, banking whatever is loose in the checkout onto the task being left.
    pub fn create(&self, switch: &Switch<'_>) -> Result<StoredChat, CommandError> {
        self.create_record(switch, false)
            .map_err(CommandError::or_coded("task_not_created"))
    }

    /// Makes a task and brings the loose files with it, for work the user started by hand.
    pub fn create_carrying_changes(&self, switch: &Switch<'_>) -> Result<StoredChat, CommandError> {
        self.create_record(switch, true)
            .map_err(CommandError::or_coded("task_not_created"))
    }

    pub(crate) fn create_record(
        &self,
        switch: &Switch<'_>,
        carry_changes: bool,
    ) -> Result<StoredChat, CommandError> {
        let _checkout = self.storage.claim_checkout()?;
        let task_id = Uuid::now_v7().to_string();
        let branch_name = task_branch_name(&task_id);
        let base = if git::is_repository(&self.storage.workspace_path) {
            self.storage.base_branch()?
        } else {
            String::new()
        };
        let created = git::create_task_branch(&self.storage.workspace_path, &branch_name, &base)?;
        let result = self.storage.insert_task(&task_id, created.as_ref());
        if result.is_err() && created.is_some() {
            git::discard_task_branch(&self.storage.workspace_path, &branch_name, &base);
        }
        result?;
        if created.is_some() {
            let moved = if carry_changes {
                switch.carrying(&branch_name)
            } else {
                switch.to(&branch_name)
            };
            if let Err(error) = moved {
                let _ = self.forget_task(&task_id);
                git::discard_task_branch(&self.storage.workspace_path, &branch_name, &base);
                return Err(error.into());
            }
        }
        Ok(StoredChat {
            task_id: Some(task_id),
            messages: Vec::new(),
            agent_messages: Vec::new(),
        })
    }

    /// Opens a task, moving the one checkout onto its branch.
    ///
    /// The [`Switch`] stops the editor before anything moves; see its module for why that is the
    /// whole reason opening a task is more than a row update.
    pub fn activate(&self, task_id: &str, switch: &Switch<'_>) -> Result<StoredChat, CommandError> {
        self.activate_record(task_id, switch)
            .map_err(CommandError::or_coded("task_not_activated"))
    }

    fn activate_record(
        &self,
        task_id: &str,
        switch: &Switch<'_>,
    ) -> Result<StoredChat, CommandError> {
        let _checkout = self.storage.claim_checkout()?;
        {
            let connection = self.storage.connection()?;
            require_task(&connection, task_id)?;
        }
        if git::is_repository(&self.storage.workspace_path) {
            self.storage.task_workspace(task_id)?;
            let branch_name = self.branch_of(task_id)?;
            switch.to(&branch_name)?;
        }
        {
            let (_write_guard, mut connection) = self.storage.write_connection()?;
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(database_error)?;
            require_task(&transaction, task_id)?;
            transaction
                .execute(
                    "UPDATE tasks SET status = 'active', updated_at = ?1 WHERE id = ?2",
                    params![now_millis()?, task_id],
                )
                .map_err(database_error)?;
            set_active_task(&transaction, task_id)?;
            transaction.commit().map_err(database_error)?;
        }
        self.storage.chats().stored_chat()
    }

    fn branch_of(&self, task_id: &str) -> Result<String, CommandError> {
        let connection = self.storage.connection()?;
        connection
            .query_row(
                "SELECT branch_name FROM task_worktrees WHERE task_id = ?1",
                [task_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(database_error)?
            .ok_or_else(|| CommandError::from("The task does not have a branch".to_owned()))
    }

    fn forget_task(&self, task_id: &str) -> Result<(), CommandError> {
        let (_write_guard, connection) = self.storage.write_connection()?;
        connection
            .execute("DELETE FROM tasks WHERE id = ?1", [task_id])
            .map_err(database_error)?;
        Ok(())
    }

    /// Deletes a task with its chat and its isolated worktree, and answers with the chat that takes
    /// its place.
    ///
    /// The [`Switch`] stops the editor before Git is asked to remove the branch. A task whose editor
    /// session is running holds that directory open and Gofer's addon inside it; stopping the session
    /// is what keeps the removal from leaving either behind. It then moves the checkout onto the task
    /// that takes over, because a task is only the active one on paper until its files are on disk.
    ///
    /// Unmerged work on the task branch goes with it — that is what deleting a task means. Project
    /// memory and recorded runs are kept: they outlive the task that produced them, and their task
    /// reference is cleared by the schema instead.
    pub fn delete(&self, task_id: &str, switch: &Switch<'_>) -> Result<StoredChat, CommandError> {
        self.delete_record(task_id, switch)
            .map_err(CommandError::or_coded("task_not_deleted"))
    }

    fn delete_record(
        &self,
        task_id: &str,
        switch: &Switch<'_>,
    ) -> Result<StoredChat, CommandError> {
        let _checkout = self.storage.claim_checkout()?;
        let branch = {
            let connection = self.storage.connection()?;
            require_task(&connection, task_id)?;
            connection
                .query_row(
                    "SELECT branch_name FROM task_worktrees WHERE task_id = ?1",
                    [task_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(database_error)?
        };
        if branch.is_some() {
            switch.release()?;
        }
        {
            let (_write_guard, mut connection) = self.storage.write_connection()?;
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(database_error)?;
            require_task(&transaction, task_id)?;
            transaction
                .execute("DELETE FROM tasks WHERE id = ?1", [task_id])
                .map_err(database_error)?;
            transaction
                .execute(
                    "DELETE FROM project_state WHERE key = ?1",
                    [draft_ui_key(task_id)],
                )
                .map_err(database_error)?;
            if active_task_id(&transaction)?.as_deref() == Some(task_id) {
                match next_task_id(&transaction)? {
                    Some(next) => set_active_task(&transaction, &next)?,
                    None => {
                        transaction
                            .execute("DELETE FROM project_state WHERE key = 'active_task_id'", [])
                            .map_err(database_error)?;
                    }
                }
            }
            transaction.commit().map_err(database_error)?;
        }
        if let Some(branch_name) = branch {
            let base = self.storage.base_branch()?;
            git::discard_task_branch(&self.storage.workspace_path, &branch_name, &base);
        }
        if let Some(next) = active_task_id(&self.storage.connection()?)? {
            self.storage.task_workspace(&next)?;
            let branch_name = self.branch_of(&next)?;
            switch.to(&branch_name).map_err(|error| {
                format!("The task was deleted, but the project could not move to the task that took its place: {error}")
            })?;
        }
        self.storage.chats().stored_chat()
    }

    pub fn agent_workspace(&self) -> Result<PathBuf, CommandError> {
        self.agent_workspace_path()
            .map_err(CommandError::or_coded("task_workspace_unavailable"))
    }

    fn agent_workspace_path(&self) -> Result<PathBuf, CommandError> {
        let connection = self.storage.connection()?;
        let Some(task_id) = active_task_id(&connection)? else {
            return Ok(self.storage.workspace_path.clone());
        };
        drop(connection);
        Ok(self
            .storage
            .task_workspace(&task_id)
            .unwrap_or_else(|_| self.storage.workspace_path.clone()))
    }

    /// Resolves the active task's isolated worktree, failing when no task is active or the
    /// worktree cannot be made usable. The Godot session supervisor uses this instead of
    /// `agent_workspace` so it never installs the addon in the user's main checkout.
    pub fn active_workspace(&self) -> Result<PathBuf, CommandError> {
        self.active_workspace_path()
            .map_err(CommandError::or_coded("task_workspace_unavailable"))
    }

    fn active_workspace_path(&self) -> Result<PathBuf, CommandError> {
        let connection = self.storage.connection()?;
        let Some(task_id) = active_task_id(&connection)? else {
            return Err(CommandError::from("No task is active".to_owned()));
        };
        drop(connection);
        self.storage.task_workspace(&task_id)
    }

    /// Which task the window is on, or `None` when it is on none.
    ///
    /// Cheap on purpose: it reads one row and never restores a checkout, because it is asked on
    /// every call that has to know whether the editor session still belongs to the task in front of
    /// the user. [`Self::active_task_workspace`] is the one that may rebuild a worktree.
    pub fn active(&self) -> Result<Option<String>, CommandError> {
        self.active_task_id()
            .map_err(CommandError::or_coded("tasks_unavailable"))
    }

    /// Where the open task branched from, which is what its whole diff is measured against.
    ///
    /// `None` covers three situations the caller must not tell apart by guessing: no task is open,
    /// the project is not a repository, and a task made before the repository existed that has not
    /// been given its branch yet. All three mean the same thing to a reader — there is no span of
    /// work to show — and none of them is a failure.
    pub fn base_commit(&self) -> Result<Option<String>, CommandError> {
        self.open_task_base_commit()
            .map_err(CommandError::or_coded("tasks_unavailable"))
    }

    fn open_task_base_commit(&self) -> Result<Option<String>, CommandError> {
        let connection = self.storage.connection()?;
        let Some(task_id) = active_task_id(&connection)? else {
            return Ok(None);
        };
        connection
            .query_row(
                "SELECT base_commit FROM task_worktrees WHERE task_id = ?1",
                [&task_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(database_error)
    }

    fn active_task_id(&self) -> Result<Option<String>, CommandError> {
        active_task_id(&self.storage.connection()?)
    }

    /// Merges a task branch into the project.
    ///
    /// The merge visits the base branch and comes back, so the files under the editor change twice;
    /// an editor left running through that saves a scene it read before either move. The [`Switch`]
    /// stops it, which also takes the addon's two lines back out of `project.godot`, so nothing of
    /// Gofer's can reach the user's history.
    pub fn merge(
        &self,
        task_id: &str,
        switch: &Switch<'_>,
    ) -> Result<MergeTaskResult, CommandError> {
        self.merge_record(task_id, switch).map_err(|failure| {
            let conflicts = failure.conflicts();
            if !conflicts.is_empty() {
                return CommandError::new("task_merge_conflicted", failure.message().to_owned())
                    .with_details(json!({"conflicts": conflicts}));
            }
            let unfinished = failure.unfinished();
            if !unfinished.is_empty() {
                return CommandError::new("task_merge_unfinished", failure.message().to_owned())
                    .with_details(json!({"conflicts": unfinished}));
            }
            CommandError::new("task_not_merged", failure.message().to_owned())
        })
    }

    /// Brings the project's branch into this task so the agent can reconcile what clashed.
    ///
    /// The same guards the merge takes — one checkout at a time, only the task the window is on —
    /// because this moves the same files under the same editor.
    pub fn resolve_conflicts(
        &self,
        task_id: &str,
        switch: &Switch<'_>,
    ) -> Result<ResolveTaskResult, CommandError> {
        self.resolve_record(task_id, switch)
            .map_err(CommandError::or_coded("task_not_resolved"))
    }

    fn resolve_record(
        &self,
        task_id: &str,
        switch: &Switch<'_>,
    ) -> Result<ResolveTaskResult, CommandError> {
        let _checkout = self.storage.claim_checkout()?;
        let branch_name = self.branch_of_the_open_task(task_id)?;
        let base = self.storage.base_branch()?;
        switch.onto(&branch_name)?;
        let conflicts =
            git::resolve_task_conflicts(&self.storage.workspace_path, &branch_name, &base)?;
        Ok(ResolveTaskResult {
            task_id: task_id.to_owned(),
            conflicts,
        })
    }

    /// Throws away an unfinished resolution merge and leaves the task exactly as it was.
    pub fn abandon_conflicts(&self, task_id: &str) -> Result<(), CommandError> {
        self.abandon_record(task_id)
            .map_err(CommandError::or_coded("task_merge_not_discarded"))
    }

    fn abandon_record(&self, task_id: &str) -> Result<(), CommandError> {
        let _checkout = self.storage.claim_checkout()?;
        self.branch_of_the_open_task(task_id)?;
        Ok(git::abandon_task_conflicts(&self.storage.workspace_path)?)
    }

    /// reaches them anyway.
    pub fn start_brief(&self, task_id: &str, prompt: &str) -> Result<(), CommandError> {
        let now = now_millis().map_err(CommandError::or_coded("brief_unwritable"))?;
        let connection = self
            .storage
            .connection()
            .map_err(CommandError::or_coded("brief_unwritable"))?;
        connection
            .execute(
                "INSERT OR REPLACE INTO brief_runs \
                 (task_id, status, phase, raw_prompt, created_at, updated_at) \
                 VALUES (?1, 'running', 'refine', ?2, ?3, ?3)",
                rusqlite::params![task_id, prompt, now],
            )
            .map_err(|error| {
                CommandError::new("brief_unwritable", database_error(error).message)
            })?;

        let title: String = prompt.trim().chars().take(80).collect();
        if !title.is_empty() {
            let _ = connection.execute(
                "UPDATE tasks SET title = ?1 WHERE id = ?2 AND title = 'New task'",
                rusqlite::params![title, task_id],
            );
        }
        Ok(())
    }

    /// Records one finished phase.
    ///
    /// `field` names the column, from a closed set, so the caller cannot reach any other part of the
    /// row — the phase names come from the worker over a pipe, and a pipe is not a place to take a
    /// column name from.
    ///
    /// Best-effort on purpose. This runs while a run is in flight, and a write that failed is worth
    /// less than the run continuing: the phase output is already on its way to the screen, and
    /// losing the stored copy costs a resume, not the answer.
    pub fn record_brief_phase(&self, task_id: &str, phase: &str, field: &str, value: &str) {
        let column = match field {
            "refined" => "refined",
            "research" => "research",
            "qa" => "qa",
            "spec" => "spec",
            _ => return,
        };
        let (Ok(connection), Ok(now)) = (self.storage.connection(), now_millis()) else {
            return;
        };
        let _ = connection.execute(
            &format!(
                "UPDATE brief_runs SET {column} = ?1, phase = ?2, updated_at = ?3 \
                 WHERE task_id = ?4"
            ),
            rusqlite::params![value, phase, now, task_id],
        );
    }

    /// Closes a brief, with why it closed when it did not simply finish.
    ///
    /// Only a brief still running is closed, and that is what makes the two paths that call this
    /// exclusive rather than racing. A run that reported its own ending — stopped during research,
    /// failed at compose — has already said so precisely; the caller that closes whatever is left
    /// over afterwards knows only that the worker exited, and must not overwrite the better answer
    /// with `done`.
    pub fn finish_brief(&self, task_id: &str, status: &str, reason: Option<&str>) {
        if !matches!(status, "done" | "failed" | "stopped") {
            return;
        }
        let (Ok(connection), Ok(now)) = (self.storage.connection(), now_millis()) else {
            return;
        };
        let _ = connection.execute(
            "UPDATE brief_runs SET status = ?1, reason = ?2, updated_at = ?3 \
             WHERE task_id = ?4 AND status = 'running'",
            rusqlite::params![status, reason, now, task_id],
        );
    }

    /// A task's brief, or nothing when it never had one. Read for the panel and for a resume.
    pub fn read_brief(&self, task_id: &str) -> Option<BriefRun> {
        self.storage
            .connection()
            .ok()?
            .query_row(
                "SELECT task_id, status, phase, raw_prompt, refined, research, qa, spec, reason \
                 FROM brief_runs WHERE task_id = ?1",
                [task_id],
                |row| {
                    Ok(BriefRun {
                        task_id: row.get(0)?,
                        status: row.get(1)?,
                        phase: row.get(2)?,
                        raw_prompt: row.get(3)?,
                        refined: row.get(4)?,
                        research: row.get(5)?,
                        qa: row.get(6)?,
                        spec: row.get(7)?,
                        reason: row.get(8)?,
                    })
                },
            )
            .optional()
            .ok()
            .flatten()
    }

    /// The branch of the task the window is on, refusing any other.
    ///
    /// Merging and resolving both move the one checkout, so asking about a task the user is not
    /// looking at would leave them reading one task's chat over another task's files — with every
    /// write after it, the agent's included, landing on the wrong branch. A stale sidebar or a
    /// switch that was refused is all it takes to ask.
    fn branch_of_the_open_task(&self, task_id: &str) -> Result<String, CommandError> {
        let connection = self.storage.connection()?;
        require_task(&connection, task_id)?;
        if active_task_id(&connection)?.as_deref() != Some(task_id) {
            return Err(CommandError::from(
                "Only the task you have open can be merged. Open it and try again.".to_owned(),
            ));
        }
        connection
            .query_row(
                "SELECT branch_name FROM task_worktrees WHERE task_id = ?1",
                [task_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(database_error)?
            .ok_or_else(|| CommandError::from("The task does not have a Git branch".to_owned()))
    }

    fn merge_record(
        &self,
        task_id: &str,
        switch: &Switch<'_>,
    ) -> Result<MergeTaskResult, git::MergeFailure> {
        let _checkout = self.storage.claim_checkout()?;
        let branch_name = self.branch_of_the_open_task(task_id)?;
        let base = self.storage.base_branch()?;
        switch.onto(&branch_name)?;
        let merged = git::merge_task_branch(&self.storage.workspace_path, &branch_name, &base)?;
        let now = now_millis()?;
        let (_write_guard, mut connection) = self.storage.write_connection()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(database_error)?;
        transaction
            .execute(
                "UPDATE task_worktrees
                 SET head_commit = ?1, merged_commit = ?2, updated_at = ?3
                 WHERE task_id = ?4",
                params![merged.head_commit, merged.merged_commit, now, task_id],
            )
            .map_err(database_error)?;
        transaction
            .execute(
                "UPDATE tasks SET status = 'completed', updated_at = ?1 WHERE id = ?2",
                params![now, task_id],
            )
            .map_err(database_error)?;
        transaction.commit().map_err(database_error)?;
        Ok(MergeTaskResult {
            task_id: task_id.to_owned(),
            head_commit: merged.head_commit,
            merged_commit: merged.merged_commit,
        })
    }

    pub fn list(&self) -> Result<Vec<TaskRecord>, CommandError> {
        self.list_records()
            .map_err(CommandError::or_coded("tasks_unavailable"))
    }

    fn list_records(&self) -> Result<Vec<TaskRecord>, CommandError> {
        let connection = self.storage.connection()?;
        let current_task_id = active_task_id(&connection)?;
        let mut statement = connection
            .prepare(
                "SELECT t.id, t.title, t.status, t.created_at, t.updated_at,
                        w.branch_name, w.worktree_path, w.base_commit, w.head_commit, w.merged_commit
                 FROM tasks t
                 LEFT JOIN task_worktrees w ON w.task_id = t.id
                 -- Never `updated_at`: opening a task writes it, and the sidebar reorders under
                 -- the click.
                 -- Never `updated_at`: opening a task writes it, and the sidebar reorders under
                 -- the click.
                 ORDER BY t.created_at DESC, t.id DESC",
            )
            .map_err(database_error)?;
        statement
            .query_map([], |row| {
                let worktree = match row.get::<_, Option<String>>(5)? {
                    Some(branch_name) => Some(TaskWorktree {
                        branch_name,
                        worktree_path: row.get(6)?,
                        base_commit: row.get(7)?,
                        head_commit: row.get(8)?,
                        merged_commit: row.get(9)?,
                    }),
                    None => None,
                };
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(4)?,
                    worktree,
                ))
            })
            .map_err(database_error)?
            .map(|row| {
                let row = row.map_err(database_error)?;
                let is_current = current_task_id.as_deref() == Some(row.0.as_str());
                Ok(TaskRecord {
                    is_current,
                    id: row.0,
                    title: row.1,
                    status: row.2,
                    created_at: from_database_u64(row.3, "task creation time")?,
                    updated_at: from_database_u64(row.4, "task update time")?,
                    worktree: row
                        .5
                        .map(|worktree| self.still_merged(worktree, is_current)),
                })
            })
            .collect()
    }

    /// Forgets a merge the branch has since moved past.
    ///
    /// `merged_commit` records that a merge happened, and it is the only thing the window's Merge
    /// control is drawn from. Written once and never cleared, it made the first merge the last one:
    /// the button went, while the agent and the editor carried on committing to the branch. That
    /// work reached the base branch through nothing at all, and there was no way left to ask.
    ///
    /// What the window needs is not whether a merge happened but whether one is owed, so the record
    /// is answered against the branch as it stands. Uncommitted work counts, and only for the task
    /// the checkout is on: one working tree, and whatever is loose in it is that task's.
    fn still_merged(&self, worktree: TaskWorktree, is_current: bool) -> TaskWorktree {
        let Some(merged_commit) = worktree.merged_commit.as_deref() else {
            return worktree;
        };
        let workspace = &self.storage.workspace_path;
        let stands_at = git::branch_commit(workspace, &worktree.branch_name);
        let is_merged = stands_at.as_deref() == Some(merged_commit)
            && !(is_current && git::has_uncommitted_changes(workspace));
        if is_merged {
            return worktree;
        }
        TaskWorktree {
            merged_commit: None,
            ..worktree
        }
    }

    /// Nothing, and the emptiness is a statement rather than an omission.
    ///
    /// A task is removed when the user removes it and on no other occasion: it is the branch their
    /// work is on, so an age is exactly the wrong reason to touch one. Everything that belongs to a
    /// task goes with it under `ON DELETE CASCADE` — its messages, their attachment links, its
    /// brief, its worktree row — and the two rows that deliberately outlive it, a memory and a
    /// sketch, clear their `task_id` instead and are collected by the views that own them.
    ///
    /// So this view has upkeep only if one of those rules changes, and it is written out rather
    /// than left off the fold so that the next person reads a decision instead of guessing at an
    /// absence.
    pub(crate) fn collect(&self, _cutoffs: &Cutoffs) -> Result<Collected, CommandError> {
        Ok(Collected::default())
    }
}

/// The branch a task's worktree is checked out on, derived from the task's own identifier.
///
/// Derived rather than stored so a task whose worktree was never recorded can still be given the
/// branch it would have had, and so adopting one twice cannot invent a second branch.
pub(crate) fn task_branch_name(task_id: &str) -> String {
    let suffix = task_id
        .chars()
        .filter(|character| *character != '-')
        .take(12)
        .collect::<String>();
    format!("gofer/task-{suffix}")
}

pub(crate) fn active_task_id(connection: &Connection) -> Result<Option<String>, CommandError> {
    connection
        .query_row(
            "SELECT value FROM project_state WHERE key = 'active_task_id'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(database_error)
}

pub(crate) fn set_active_task(connection: &Connection, task_id: &str) -> Result<(), CommandError> {
    connection
        .execute(
            "INSERT INTO project_state (key, value) VALUES ('active_task_id', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [task_id],
        )
        .map_err(database_error)?;
    Ok(())
}

/// The task that should take over as the active one: the most recently worked on.
pub(crate) fn next_task_id(connection: &Connection) -> Result<Option<String>, CommandError> {
    connection
        .query_row(
            "SELECT id FROM tasks ORDER BY updated_at DESC, created_at DESC LIMIT 1",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(database_error)
}

pub(crate) fn require_task(connection: &Connection, task_id: &str) -> Result<(), CommandError> {
    let exists = connection
        .query_row("SELECT 1 FROM tasks WHERE id = ?1", [task_id], |_| Ok(()))
        .optional()
        .map_err(database_error)?
        .is_some();
    if !exists {
        return Err(CommandError::new(
            "task_not_found",
            "The task was not found",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::test_support::*;
    use super::*;
    use tempfile::TempDir;

    /// A repository with no commits has no branch point, so no task worktree can be created in it.
    /// That used to fail `open`, which failed Tauri's `setup`, which panics — the user got no
    /// window at all. The database has to open anyway, so the health check can say so and offer the
    /// first commit.
    #[test]
    fn a_repository_without_commits_still_opens_its_project_database() {
        let directory = TempDir::new().expect("temporary directory");
        let workspace = directory.path().join("workspace");
        fs::create_dir(&workspace).expect("workspace directory");
        let status = std::process::Command::new("git")
            .args(["init", "-b", "main"])
            .current_dir(&workspace)
            .output()
            .expect("run Git");
        assert!(status.status.success());

        let storage =
            ProjectStorage::open(&directory.path().join("data"), &workspace).expect("storage");

        assert_eq!(storage.tasks().list().expect("tasks").len(), 0);
    }

    /// The order every new project is opened in: the window first, the repository afterwards.
    ///
    /// Gofer opens a folder that is not a repository yet, so the first task is written without a
    /// branch. The user then presses the health check's fixes, which make the repository and its
    /// first commit but never revisit the task. The task has to pick a branch up on its own here,
    /// or the editor session fails for the life of the project.
    #[test]
    fn a_task_made_before_the_repository_adopts_a_branch_once_there_is_one() {
        let directory = TempDir::new().expect("temporary directory");
        let storage = storage(&directory);
        let task_id = storage
            .tasks()
            .active()
            .expect("read")
            .expect("active task");

        assert!(
            storage.tasks().active_workspace().is_err(),
            "there is no repository yet, so there is nothing to adopt"
        );

        make_repository(&storage.workspace_path);

        let workspace = storage.tasks().active_workspace().expect("adopt a branch");
        assert_eq!(
            workspace, storage.workspace_path,
            "every task works in the project's own checkout"
        );
        assert!(workspace.join("project.godot").is_file());
        assert!(git::branch_exists(
            &storage.workspace_path,
            &task_branch_name(&task_id)
        ));

        let summary = storage
            .tasks()
            .list()
            .expect("list tasks")
            .into_iter()
            .find(|task| task.id == task_id)
            .expect("the active task");
        let recorded = summary.worktree.expect("a recorded branch");
        assert_eq!(PathBuf::from(&recorded.worktree_path), workspace);
        assert_eq!(recorded.branch_name, task_branch_name(&task_id));
        assert_eq!(
            storage.tasks().active_workspace().expect("second call"),
            workspace
        );
    }

    /// Files the user dropped in by hand must not vanish when the next task takes the checkout.
    #[test]
    fn loose_files_can_be_carried_into_a_new_task() {
        let directory = TempDir::new().expect("temporary directory");
        let storage = storage(&directory);
        make_repository(&storage.workspace_path);
        storage
            .tasks()
            .active_workspace()
            .expect("the first task takes a branch");

        let copied = storage.workspace_path.join("assets").join("tile.png");
        fs::create_dir_all(copied.parent().expect("assets directory")).expect("assets directory");
        fs::write(&copied, b"tile").expect("copy a file in by hand");

        storage
            .tasks()
            .create_carrying_changes(&storage.switch_with_no_turn_to_refuse(&NOTHING_TO_STOP))
            .expect("create the second task");

        assert!(
            copied.is_file(),
            "the new task swept the user's copied file onto the previous task's branch"
        );
        assert_eq!(
            git::pending_changes(&storage.workspace_path).expect("read the loose files"),
            vec![git::PendingChange {
                path: "assets/tile.png".to_owned(),
                is_new: true
            }],
            "the file came along loose, so the new task can commit it as its own"
        );
    }

    /// The old behaviour is still a choice: loose files stay with the task the user is leaving.
    #[test]
    fn loose_files_can_be_left_on_the_previous_task() {
        let directory = TempDir::new().expect("temporary directory");
        let storage = storage(&directory);
        make_repository(&storage.workspace_path);
        storage
            .tasks()
            .active_workspace()
            .expect("the first task takes a branch");

        let copied = storage.workspace_path.join("stray.txt");
        fs::write(&copied, b"stray").expect("copy a file in by hand");

        storage
            .tasks()
            .create(&storage.switch_with_no_turn_to_refuse(&NOTHING_TO_STOP))
            .expect("create the second task");

        assert!(!copied.exists(), "the file belongs to the task being left");
        assert!(
            git::pending_changes(&storage.workspace_path)
                .expect("read the loose files")
                .is_empty()
        );
    }

    #[test]
    fn active_task_workspace_fails_instead_of_falling_back_to_root_workspace() {
        let directory = TempDir::new().expect("temporary directory");
        let storage = storage(&directory);

        assert!(
            storage
                .tasks()
                .active_workspace()
                .unwrap_err()
                .message
                .contains("not a Git repository"),
            "active_task_workspace must fail rather than fall back"
        );

        assert!(storage.tasks().agent_workspace().is_ok());
    }

    /// Opening a task must not move any sidebar row, or the next click lands on the wrong task.
    #[test]
    fn the_task_list_keeps_its_order_when_a_task_is_opened() {
        let directory = TempDir::new().expect("temporary directory");
        let storage = storage(&directory);
        for _ in 0..3 {
            storage
                .tasks()
                .create(&storage.switch_with_no_turn_to_refuse(&NOTHING_TO_STOP))
                .expect("create task");
        }
        let before: Vec<String> = storage
            .tasks()
            .list()
            .expect("tasks")
            .into_iter()
            .map(|task| task.id)
            .collect();
        assert_eq!(before.len(), 4);

        let opened = before.last().expect("an oldest task").clone();
        storage
            .tasks()
            .activate(
                &opened,
                &storage.switch_with_no_turn_to_refuse(&NOTHING_TO_STOP),
            )
            .expect("open the oldest task");

        let after: Vec<String> = storage
            .tasks()
            .list()
            .expect("tasks")
            .into_iter()
            .map(|task| task.id)
            .collect();
        assert_eq!(
            before, after,
            "opening a task must not move any row in the sidebar"
        );
    }

    /// Sending a message must not move any sidebar row either. It writes the same column.
    #[test]
    fn the_task_list_keeps_its_order_when_a_chat_is_saved() {
        let directory = TempDir::new().expect("temporary directory");
        let storage = storage(&directory);
        for _ in 0..3 {
            storage
                .tasks()
                .create(&storage.switch_with_no_turn_to_refuse(&NOTHING_TO_STOP))
                .expect("create task");
        }
        let order = |storage: &ProjectStorage| -> Vec<String> {
            storage
                .tasks()
                .list()
                .expect("tasks")
                .into_iter()
                .map(|task| task.id)
                .collect()
        };
        let before = order(&storage);
        let oldest = before.last().expect("an oldest task").clone();
        storage
            .tasks()
            .activate(
                &oldest,
                &storage.switch_with_no_turn_to_refuse(&NOTHING_TO_STOP),
            )
            .expect("open the oldest task");

        let mut chat = storage.chats().load(None).expect("chat");
        chat.messages.push(StoredMessage {
            id: 1,
            sender: "user".to_owned(),
            text: "Hello".to_owned(),
            timestamp: 1,
            attachments: Vec::new(),
            extra: serde_json::Map::new(),
        });
        storage.chats().save(&chat).expect("save the chat");

        assert_eq!(before, order(&storage));
    }

    /// The open task's branch point is what its whole diff is measured against, and a project with
    /// no repository behind it has none to answer — which is an ordinary state, not a failure.
    #[test]
    fn the_open_task_answers_where_it_branched_from() {
        let directory = TempDir::new().expect("temporary directory");
        let workspace = committed_repository(directory.path());
        let storage =
            ProjectStorage::open(&directory.path().join("data"), &workspace).expect("storage");
        storage.chats().load(None).expect("the first task");

        let base = storage
            .tasks()
            .base_commit()
            .expect("ask for the branch point")
            .expect("a task on a repository has one");

        assert_eq!(
            base,
            crate::git::branch_commit(&workspace, "master")
                .or_else(|| crate::git::branch_commit(&workspace, "main"))
                .expect("the project's own branch"),
            "a task branches from the project as it stood"
        );
    }

    /// Somewhere that is not a repository has no branch point, and must not invent one.
    #[test]
    fn a_project_with_no_repository_has_no_branch_point() {
        let directory = TempDir::new().expect("temporary directory");
        let workspace = directory.path().join("loose");
        std::fs::create_dir_all(&workspace).expect("workspace");
        let storage =
            ProjectStorage::open(&directory.path().join("data"), &workspace).expect("storage");
        storage.chats().load(None).expect("the first task");

        assert_eq!(
            storage.tasks().base_commit().expect("ask"),
            None,
            "there is no span of work to measure"
        );
    }

    /// Deleting a task has to take everything Gofer made for it: the chat, the Git worktree, and the
    /// branch. Leaving the branch behind would keep the work findable in a repository the user was
    /// told is rid of it, and leaving the worktree behind would keep the disk it took.
    #[test]
    fn deleting_a_task_removes_its_chat_and_branch() {
        let directory = TempDir::new().expect("temporary directory");
        let workspace = committed_repository(directory.path());
        let storage =
            ProjectStorage::open(&directory.path().join("data"), &workspace).expect("storage");
        let first = storage.chats().load(None).expect("first task");
        storage
            .chats()
            .save(&StoredChat {
                task_id: first.task_id.clone(),
                messages: vec![StoredMessage {
                    id: 1,
                    sender: "user".to_owned(),
                    text: "First task".to_owned(),
                    timestamp: 10,
                    attachments: Vec::new(),
                    extra: serde_json::Map::new(),
                }],
                agent_messages: Vec::new(),
            })
            .expect("save first task");
        let doomed = storage
            .tasks()
            .create(&storage.switch_with_no_turn_to_refuse(&NOTHING_TO_STOP))
            .expect("create task")
            .task_id
            .expect("task ID");
        let worktree = storage
            .tasks()
            .list()
            .expect("tasks")
            .into_iter()
            .find(|task| task.id == doomed)
            .expect("the deleted task")
            .worktree
            .expect("a recorded branch");
        let released = Released::default();
        let recording = released.recording();

        let replacement = storage
            .tasks()
            .delete(&doomed, &storage.switch_with_no_turn_to_refuse(&recording))
            .expect("delete task");

        assert_eq!(released.paths(), vec![workspace.clone(), workspace.clone()]);
        assert!(
            git_text(&workspace, &["branch", "--list", &worktree.branch_name]).is_empty(),
            "the task branch must be gone from the repository"
        );
        let tasks = storage.tasks().list().expect("remaining tasks");
        assert_eq!(tasks.len(), 1);
        assert_eq!(replacement.task_id, first.task_id);
        assert!(tasks[0].is_current);
        assert_eq!(replacement.messages[0].text, "First task");
        assert_eq!(
            git::current_branch(&workspace).as_deref(),
            Some(
                tasks[0]
                    .worktree
                    .as_ref()
                    .expect("a branch")
                    .branch_name
                    .as_str()
            ),
            "the replacement task's files are what the user is looking at"
        );
    }

    #[test]
    fn a_delete_that_cannot_land_on_the_next_task_says_so() {
        let directory = TempDir::new().expect("temporary directory");
        let workspace = committed_repository(directory.path());
        let storage =
            ProjectStorage::open(&directory.path().join("data"), &workspace).expect("storage");
        let first = storage.tasks().active().expect("read").expect("a task");
        let doomed = storage
            .tasks()
            .create(&storage.switch_with_no_turn_to_refuse(&NOTHING_TO_STOP))
            .expect("create task")
            .task_id
            .expect("task ID");

        let stops = Mutex::new(0);
        let refuses_the_second = |_: &Path| {
            let mut count = stops.lock().expect("the counter");
            *count += 1;
            if *count > 1 {
                return Err("an editor would not stop".to_owned());
            }
            Ok(())
        };

        let refusal = storage
            .tasks()
            .delete(
                &doomed,
                &storage.switch_with_no_turn_to_refuse(&refuses_the_second),
            )
            .expect_err("a checkout that would not move is reported");
        assert!(
            refusal.message.contains("The task was deleted"),
            "and the message says the deletion did happen: {}",
            refusal.message
        );

        let tasks = storage.tasks().list().expect("remaining tasks");
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].id, first);
    }

    /// The workspace is never left without a task: deleting the last one leaves the user in a new,
    /// empty task rather than in a window with nothing to type into.
    #[test]
    fn deleting_the_last_task_opens_a_fresh_one() {
        let directory = TempDir::new().expect("temporary directory");
        let storage = storage(&directory);
        let only = storage
            .chats()
            .load(None)
            .expect("only task")
            .task_id
            .expect("task ID");

        let replacement = storage
            .tasks()
            .delete(
                &only,
                &storage.switch_with_no_turn_to_refuse(&NOTHING_TO_STOP),
            )
            .expect("delete task");

        let task_id = replacement.task_id.expect("replacement task ID");
        assert_ne!(task_id, only);
        assert!(replacement.messages.is_empty());
        let tasks = storage.tasks().list().expect("tasks");
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].id, task_id);
        assert!(
            storage
                .tasks()
                .delete(
                    &only,
                    &storage.switch_with_no_turn_to_refuse(&NOTHING_TO_STOP)
                )
                .is_err()
        );
    }

    /// A brief fills in as it goes, because the thing producing it is killed to cancel a run.
    ///
    /// The worker holds every phase output in a process the backend ends with a signal, so anything
    /// not already written here when the user presses Stop is gone. A row that recorded each phase
    /// as it landed says how far the run got; one written at the end would say nothing at all.
    #[test]
    fn a_brief_records_each_phase_as_it_lands_rather_than_at_the_end() {
        let directory = TempDir::new().expect("temporary directory");
        let storage = storage(&directory);
        let tasks = storage.tasks();
        let task_id = tasks
            .create(&storage.switch_with_no_turn_to_refuse(&NOTHING_TO_STOP))
            .expect("create a task")
            .task_id
            .expect("the new task's id");

        tasks
            .start_brief(&task_id, "add a pause menu")
            .expect("start the brief");
        tasks.record_brief_phase(&task_id, "refine", "refined", "GOAL\nA pause menu.");
        tasks.record_brief_phase(&task_id, "research", "research", "FILES\n  a.gd");

        tasks.finish_brief(&task_id, "stopped", Some("the user stopped it"));

        let brief = tasks.read_brief(&task_id).expect("the brief");
        assert_eq!(brief.status, "stopped");
        assert_eq!(brief.phase, "research");
        assert_eq!(brief.refined.as_deref(), Some("GOAL\nA pause menu."));
        assert_eq!(brief.research.as_deref(), Some("FILES\n  a.gd"));
        assert_eq!(brief.qa, None);
        assert_eq!(brief.spec, None);
        assert_eq!(brief.reason.as_deref(), Some("the user stopped it"));
    }

    /// A planned task is named for what was asked, not for what the phases produced.
    ///
    /// Without this every one of them reads "GOAL …" in the sidebar, because a task is named after
    /// its first message and a planned task's first message is the specification.
    #[test]
    fn a_brief_names_its_task_after_the_ask() {
        let directory = TempDir::new().expect("temporary directory");
        let storage = storage(&directory);
        let tasks = storage.tasks();
        let task_id = storage
            .tasks()
            .create(&storage.switch_with_no_turn_to_refuse(&NOTHING_TO_STOP))
            .expect("create a task")
            .task_id
            .expect("the new task's id");

        tasks
            .start_brief(&task_id, "  add a pause menu  ")
            .expect("start the brief");

        let title = storage
            .tasks()
            .list()
            .expect("list tasks")
            .into_iter()
            .find(|task| task.id == task_id)
            .expect("the task")
            .title;
        assert_eq!(title, "add a pause menu");
    }

    /// The phase name arrives over a pipe from a worker process, so it is matched against a closed
    /// set rather than pasted into the statement. Anything else writes nothing at all.
    #[test]
    fn a_phase_name_nobody_recognises_writes_nothing() {
        let directory = TempDir::new().expect("temporary directory");
        let storage = storage(&directory);
        let tasks = storage.tasks();
        let task_id = storage
            .tasks()
            .create(&storage.switch_with_no_turn_to_refuse(&NOTHING_TO_STOP))
            .expect("create a task")
            .task_id
            .expect("the new task's id");
        tasks
            .start_brief(&task_id, "add a pause menu")
            .expect("start");

        tasks.record_brief_phase(&task_id, "refine", "raw_prompt", "overwritten");
        tasks.record_brief_phase(&task_id, "refine", "status = 'done'", "injected");

        let brief = tasks.read_brief(&task_id).expect("the brief");
        assert_eq!(brief.raw_prompt, "add a pause menu");
        assert_eq!(brief.status, "running");
        assert_eq!(brief.phase, "refine");
    }

    /// A brief is meaningless without its task, so removing the task removes it.
    #[test]
    fn deleting_a_task_takes_its_brief_with_it() {
        let directory = TempDir::new().expect("temporary directory");
        let storage = storage(&directory);
        let tasks = storage.tasks();
        let task_id = storage
            .tasks()
            .create(&storage.switch_with_no_turn_to_refuse(&NOTHING_TO_STOP))
            .expect("create a task")
            .task_id
            .expect("the new task's id");
        tasks
            .start_brief(&task_id, "add a pause menu")
            .expect("start");
        assert!(tasks.read_brief(&task_id).is_some());

        tasks
            .storage
            .connection()
            .expect("connection")
            .execute("DELETE FROM tasks WHERE id = ?1", [&task_id])
            .expect("delete the task");

        assert!(tasks.read_brief(&task_id).is_none());
    }

    /// The project's repository was deleted and started over, which leaves every task directory on
    /// disk pointing at Git administration that is gone. Both the agent and the editor session used
    /// to be handed that directory — the session then failed to stage the addon into a checkout of
    /// nothing, naming a path inside Gofer's application data and asking the user to repair it.
    #[test]
    fn a_worktree_git_no_longer_holds_is_rebuilt_for_the_task_that_owns_it() {
        let directory = TempDir::new().expect("temporary directory");
        let workspace = committed_repository(directory.path());
        let storage =
            ProjectStorage::open(&directory.path().join("data"), &workspace).expect("storage");
        let task_id = storage
            .tasks()
            .create(&storage.switch_with_no_turn_to_refuse(&NOTHING_TO_STOP))
            .expect("task")
            .task_id
            .expect("a task with a worktree");
        let worktree = storage.tasks().active_workspace().expect("worktree");
        assert!(worktree.join("project.godot").is_file());

        fs::remove_dir_all(workspace.join(".git")).expect("remove the repository");
        let rebuilt = committed_repository_in_place(&workspace);
        assert!(worktree.is_dir(), "the abandoned directory is still there");

        let repaired = storage
            .tasks()
            .active_workspace()
            .expect("repaired worktree");

        assert_eq!(repaired, worktree, "the task keeps the path it was given");
        assert!(
            repaired.join("project.godot").is_file(),
            "the rebuilt worktree holds the project the session opens"
        );
        assert_eq!(
            storage.tasks().agent_workspace().expect("agent workspace"),
            worktree,
            "the agent writes in the task's worktree rather than the user's checkout"
        );
        let connection = storage.connection().expect("connection");
        let base: String = connection
            .query_row(
                "SELECT base_commit FROM task_worktrees WHERE task_id = ?1",
                [&task_id],
                |row| row.get(0),
            )
            .expect("recorded worktree");
        assert_eq!(
            base, rebuilt,
            "the task branches from the project as it is now"
        );
    }

    /// One checkout means unfinished work is loose in the directory the next task is about to use.
    /// Opening another task banks it on the branch being left, or the next task inherits files it
    /// never made and the user's history says that task wrote them.
    #[test]
    fn opening_another_task_banks_the_outgoing_work_on_its_own_branch() {
        let directory = TempDir::new().expect("temporary directory");
        let workspace = committed_repository(directory.path());
        let storage =
            ProjectStorage::open(&directory.path().join("data"), &workspace).expect("storage");
        let first = storage
            .tasks()
            .active()
            .expect("read")
            .expect("an open project has an active task");
        fs::write(workspace.join("player.gd"), "extends Node\n").expect("unfinished work");

        let second = storage
            .tasks()
            .create(&storage.switch_with_no_turn_to_refuse(&NOTHING_TO_STOP))
            .expect("create the second task")
            .task_id
            .expect("task ID");

        assert!(
            !workspace.join("player.gd").exists(),
            "the first task's file must not follow the checkout into the second"
        );
        assert_eq!(
            git_text(&workspace, &["status", "--porcelain"]),
            "",
            "nothing may be left loose once the checkout has moved"
        );

        storage
            .tasks()
            .activate(
                &first,
                &storage.switch_with_no_turn_to_refuse(&NOTHING_TO_STOP),
            )
            .expect("back to the first task");

        assert!(
            workspace.join("player.gd").is_file(),
            "the work is on the branch it was made on, and comes back with it"
        );
        assert_ne!(first, second);
    }

    /// The editor is stopped before the working tree moves, and it is stopped exactly once per
    /// switch. Godot never rereads a scene a checkout changed underneath it, and saves the copy it
    /// still holds over the branch the user switched to.
    #[test]
    fn opening_another_task_stops_the_session_before_the_checkout() {
        let directory = TempDir::new().expect("temporary directory");
        let workspace = committed_repository(directory.path());
        let storage =
            ProjectStorage::open(&directory.path().join("data"), &workspace).expect("storage");
        let first = storage.tasks().active().expect("read").expect("a task");
        let released = Released::default();
        let recording = released.recording();
        let second = storage
            .tasks()
            .create(&storage.switch_with_no_turn_to_refuse(&recording))
            .expect("create the second task")
            .task_id
            .expect("task ID");
        assert_eq!(released.paths(), vec![workspace.clone()]);

        released.0.lock().expect("the recorder").clear();
        storage
            .tasks()
            .activate(&first, &storage.switch_with_no_turn_to_refuse(&recording))
            .expect("open the first task");
        assert_eq!(released.paths(), vec![workspace.clone()]);

        released.0.lock().expect("the recorder").clear();
        storage
            .tasks()
            .activate(&first, &storage.switch_with_no_turn_to_refuse(&recording))
            .expect("open the task already open");
        assert!(
            released.paths().is_empty(),
            "a switch that is not a switch stops nothing"
        );
        assert_ne!(first, second);
    }

    /// The pointer moves last, and only after the working tree has. Banking the outgoing work is
    /// what makes the checkout itself safe: by the time Git is asked to move, there is nothing local
    /// left for it to refuse over, so a loose edit is carried onto the branch that made it rather
    /// than blocking the user in place.
    #[test]
    fn a_loose_edit_is_banked_rather_than_blocking_the_switch() {
        let directory = TempDir::new().expect("temporary directory");
        let workspace = committed_repository(directory.path());
        let storage =
            ProjectStorage::open(&directory.path().join("data"), &workspace).expect("storage");
        let first = storage.tasks().active().expect("read").expect("a task");
        let second = storage
            .tasks()
            .create(&storage.switch_with_no_turn_to_refuse(&NOTHING_TO_STOP))
            .expect("create the second task")
            .task_id
            .expect("task ID");
        fs::write(
            workspace.join("project.godot"),
            "[application]\nname=\"second\"\n",
        )
        .expect("task edit");
        git_text(&workspace, &["commit", "-am", "Second task edit"]);
        fs::write(
            workspace.join("project.godot"),
            "[application]\nname=\"loose\"\n",
        )
        .expect("loose edit");

        storage
            .tasks()
            .activate(
                &first,
                &storage.switch_with_no_turn_to_refuse(&NOTHING_TO_STOP),
            )
            .expect("the switch banks the loose edit instead of refusing");

        assert_eq!(
            storage.tasks().active().expect("read").as_deref(),
            Some(first.as_str())
        );
        assert_eq!(
            fs::read_to_string(workspace.join("project.godot")).expect("project file"),
            "[application]\n",
            "the first task's own project file is what is on disk"
        );
        storage
            .tasks()
            .activate(
                &second,
                &storage.switch_with_no_turn_to_refuse(&NOTHING_TO_STOP),
            )
            .expect("back to the second task");
        assert_eq!(
            fs::read_to_string(workspace.join("project.godot")).expect("project file"),
            "[application]\nname=\"loose\"\n",
            "the loose edit was banked on the branch that made it"
        );
    }

    #[test]
    fn every_task_operation_that_moves_the_checkout_stops_the_editor_first() {
        for operation in ["create", "activate", "delete", "merge", "resolve"] {
            let directory = TempDir::new().expect("temporary directory");
            let workspace = committed_repository(directory.path());
            let storage =
                ProjectStorage::open(&directory.path().join("data"), &workspace).expect("storage");
            let first = storage.tasks().active().expect("read").expect("a task");
            let second = storage
                .tasks()
                .create(&storage.switch_with_no_turn_to_refuse(&NOTHING_TO_STOP))
                .expect("a second task")
                .task_id
                .expect("task ID");

            let branch_before = git::current_branch(&workspace).expect("a branch");
            let asked = Mutex::new(0);
            let refuses = |_: &Path| {
                *asked.lock().expect("the counter") += 1;
                Err("an editor would not stop".to_owned())
            };
            let switch = storage.switch_with_no_turn_to_refuse(&refuses);

            let refused = match operation {
                "create" => storage.tasks().create(&switch).err().map(|e| e.message),
                "activate" => storage
                    .tasks()
                    .activate(&first, &switch)
                    .err()
                    .map(|e| e.message),
                "delete" => storage
                    .tasks()
                    .delete(&second, &switch)
                    .err()
                    .map(|e| e.message),
                "merge" => storage
                    .tasks()
                    .merge(&second, &switch)
                    .err()
                    .map(|e| e.message),
                _ => storage
                    .tasks()
                    .resolve_conflicts(&second, &switch)
                    .err()
                    .map(|e| e.message),
            };

            assert_eq!(
                *asked.lock().expect("the counter"),
                1,
                "{operation} must stop what is holding the working tree before it moves it"
            );
            assert!(
                refused.is_some_and(|message| message.contains("would not stop")),
                "{operation} must answer the refusal rather than continue past it"
            );
            assert_eq!(
                git::current_branch(&workspace).as_deref(),
                Some(branch_before.as_str()),
                "{operation} moved the checkout past a stop it was refused"
            );
        }
    }

    /// A task that is not there must not move anything. The row is required before the working tree
    /// is touched, so a stale id from the window leaves the user where they were.
    #[test]
    fn activating_a_task_that_does_not_exist_moves_nothing() {
        let directory = TempDir::new().expect("temporary directory");
        let workspace = committed_repository(directory.path());
        let storage =
            ProjectStorage::open(&directory.path().join("data"), &workspace).expect("storage");
        let active = storage.tasks().active().expect("read").expect("a task");
        let branch = git::current_branch(&workspace).expect("a branch");
        let released = Released::default();
        let recording = released.recording();

        let refused = storage
            .tasks()
            .activate(
                "no-such-task",
                &storage.switch_with_no_turn_to_refuse(&recording),
            )
            .expect_err("an unknown task is refused");

        assert_eq!(refused.code, "task_not_found");
        assert!(
            released.paths().is_empty(),
            "nothing is stopped for a task that is not there"
        );
        assert_eq!(
            storage.tasks().active().expect("read").as_deref(),
            Some(active.as_str())
        );
        assert_eq!(
            git::current_branch(&workspace).as_deref(),
            Some(branch.as_str())
        );
    }

    /// Merging visits the base branch and comes back. What the user is looking at afterwards has to
    /// be their own task, holding the merged project rather than the commit before it landed.
    #[test]
    fn merging_lands_on_the_base_branch_and_returns_the_user_to_their_task() {
        let directory = TempDir::new().expect("temporary directory");
        let workspace = committed_repository(directory.path());
        let storage =
            ProjectStorage::open(&directory.path().join("data"), &workspace).expect("storage");
        let task = storage.tasks().active().expect("read").expect("a task");
        fs::write(workspace.join("player.gd"), "extends Node\n").expect("task work");
        let branch = storage
            .tasks()
            .list()
            .expect("tasks")
            .into_iter()
            .find(|row| row.id == task)
            .expect("the active task")
            .worktree
            .expect("a branch")
            .branch_name;
        let released = Released::default();
        let recording = released.recording();

        let merged = storage
            .tasks()
            .merge(&task, &storage.switch_with_no_turn_to_refuse(&recording))
            .expect("merge the task");

        assert_eq!(released.paths(), vec![workspace.clone()]);
        assert_eq!(
            git_text(&workspace, &["rev-parse", "HEAD"]),
            merged.merged_commit
        );
        assert_eq!(
            git::current_branch(&workspace).as_deref(),
            Some(branch.as_str()),
            "the user stays on the task they merged"
        );
        assert_eq!(
            git_text(&workspace, &["rev-parse", "master"]),
            merged.merged_commit,
            "the base branch is where the work landed"
        );
        assert!(workspace.join("player.gd").is_file());
        assert_eq!(git_text(&workspace, &["status", "--porcelain"]), "");
        assert_eq!(
            storage
                .tasks()
                .list()
                .expect("tasks")
                .into_iter()
                .find(|row| row.id == task)
                .expect("the merged task")
                .status,
            "completed"
        );
    }

    /// The sequence that made a finished refactor look like it never happened: merge a task, open
    /// an older one to look at it, then press New. The new task used to be cut from whatever the
    /// checkout was sitting on, so it started before the merge and opened on the old files.
    #[test]
    fn a_new_task_starts_from_the_base_branch_even_when_an_old_task_is_open() {
        let directory = TempDir::new().expect("temporary directory");
        let workspace = committed_repository(directory.path());
        let storage =
            ProjectStorage::open(&directory.path().join("data"), &workspace).expect("storage");
        let refactor = storage.tasks().active().expect("read").expect("a task");
        let older = storage
            .tasks()
            .create(&storage.switch_with_no_turn_to_refuse(&NOTHING_TO_STOP))
            .expect("an older task")
            .task_id
            .expect("its id");

        storage
            .tasks()
            .activate(
                &refactor,
                &storage.switch_with_no_turn_to_refuse(&NOTHING_TO_STOP),
            )
            .expect("open the refactor");
        fs::write(workspace.join("player.gd"), "extends Node\n").expect("the refactor");
        let merged = storage
            .tasks()
            .merge(
                &refactor,
                &storage.switch_with_no_turn_to_refuse(&NOTHING_TO_STOP),
            )
            .expect("merge the refactor");

        storage
            .tasks()
            .activate(
                &older,
                &storage.switch_with_no_turn_to_refuse(&NOTHING_TO_STOP),
            )
            .expect("open the older task");
        assert!(
            !workspace.join("player.gd").exists(),
            "the older task predates the merge, so its own files are the old ones"
        );
        let next = storage
            .tasks()
            .create(&storage.switch_with_no_turn_to_refuse(&NOTHING_TO_STOP))
            .expect("the next task")
            .task_id
            .expect("its id");

        assert!(
            workspace.join("player.gd").is_file(),
            "a new task must open on the merged work, not on the task that happened to be open"
        );
        let base = storage
            .tasks()
            .list()
            .expect("tasks")
            .into_iter()
            .find(|row| row.id == next)
            .expect("the new task")
            .worktree
            .expect("a branch")
            .base_commit;
        assert_eq!(base, merged.merged_commit);
        assert_eq!(git_text(&workspace, &["rev-parse", "master"]), base);
    }

    /// Two switches at once must not meet inside Git.
    ///
    /// One checkout means one index, and `git add` refuses to start while another holds
    /// `index.lock`. A switch stops the editor first, which is a quit request, a ten-second wait and
    /// an unstage — seconds, not microseconds — so a user clicking between two tasks has the second
    /// switch reach Git while the first is still there. Measured: three overlapping activations from
    /// four clicks ten milliseconds apart, and the loser fails with Git's own words:
    /// "Unable to create '.git/index.lock': File exists."
    ///
    /// Either answer is a fix. Both may win, or the loser may be refused in Gofer's own words. What
    /// may not happen is a raw Git message, and what may never happen is the checkout and the
    /// current-task pointer disagreeing afterwards.
    #[test]
    fn two_switches_at_once_do_not_meet_inside_git() {
        let directory = TempDir::new().expect("temporary directory");
        let workspace = committed_repository(directory.path());
        let storage =
            ProjectStorage::open(&directory.path().join("data"), &workspace).expect("storage");
        let first = storage.tasks().active().expect("read").expect("a task");
        let second = storage
            .tasks()
            .create(&storage.switch_with_no_turn_to_refuse(&NOTHING_TO_STOP))
            .expect("create the second task")
            .task_id
            .expect("task ID");
        let third = storage
            .tasks()
            .create(&storage.switch_with_no_turn_to_refuse(&NOTHING_TO_STOP))
            .expect("create the third task")
            .task_id
            .expect("task ID");
        assert_ne!(third, second);

        for round in 0..60u64 {
            for index in 0..300 {
                fs::write(workspace.join(format!("loose{index}.gd")), "extends Node\n")
                    .expect("loose work");
            }
            let (left, right) = std::thread::scope(|scope| {
                let left = scope.spawn(|| {
                    storage.tasks().activate(
                        &first,
                        &storage.switch_with_no_turn_to_refuse(&NOTHING_TO_STOP),
                    )
                });
                let right = scope.spawn(|| {
                    std::thread::sleep(std::time::Duration::from_micros(round * 200));
                    storage.tasks().activate(
                        &second,
                        &storage.switch_with_no_turn_to_refuse(&NOTHING_TO_STOP),
                    )
                });
                (
                    left.join().expect("the first switch"),
                    right.join().expect("the second switch"),
                )
            });

            for outcome in [&left, &right] {
                if let Err(error) = outcome {
                    assert!(
                        !error.message.contains("index.lock"),
                        "round {round}: a switch that lost the race must be refused in Gofer's \
                         own words, not Git's: {}",
                        error.message
                    );
                }
            }
            let active = storage
                .tasks()
                .active()
                .expect("read")
                .expect("a switch leaves a task open");
            let expected = storage
                .tasks()
                .list()
                .expect("tasks")
                .into_iter()
                .find(|row| row.id == active)
                .expect("the open task")
                .worktree
                .expect("a branch")
                .branch_name;
            assert_eq!(
                git::current_branch(&workspace).as_deref(),
                Some(expected.as_str()),
                "round {round}: the checkout and the task the window is on must not disagree"
            );
        }
    }

    /// A merged task the user keeps working in has work to merge again.
    ///
    /// `merged_commit` is written once and never cleared, and it is the only thing the Merge control
    /// is drawn from. So the button goes after the first merge and never comes back, while the agent
    /// and the editor carry on committing to the branch — work that reaches the base branch through
    /// nothing at all. The backend merges it happily when asked; there is simply no way left to ask.
    #[test]
    fn work_done_after_a_merge_can_be_merged_again() {
        let directory = TempDir::new().expect("temporary directory");
        let workspace = committed_repository(directory.path());
        let storage =
            ProjectStorage::open(&directory.path().join("data"), &workspace).expect("storage");
        let task = storage.tasks().active().expect("read").expect("a task");
        fs::write(workspace.join("player.gd"), "extends Node\n").expect("task work");
        let merged = storage
            .tasks()
            .merge(
                &task,
                &storage.switch_with_no_turn_to_refuse(&NOTHING_TO_STOP),
            )
            .expect("merge the task");

        fs::write(workspace.join("enemy.gd"), "extends Node\n").expect("more work");
        git_text(&workspace, &["add", "--all"]);
        git_text(&workspace, &["commit", "-m", "Work done after the merge"]);
        let head = git_text(&workspace, &["rev-parse", "HEAD"]);
        assert_ne!(head, merged.merged_commit, "this fixture moved the branch");

        let row = storage
            .tasks()
            .list()
            .expect("tasks")
            .into_iter()
            .find(|row| row.id == task)
            .expect("the task")
            .worktree
            .expect("a branch");
        assert_eq!(
            row.merged_commit, None,
            "a branch that moved past its merge has work to merge, and the window is drawn from this"
        );
    }

    /// Merging is asked about a task id, and it moves the one checkout onto that task's branch. Ask
    /// it about a task the window is not on — a stale sidebar, a switch that was refused — and the
    /// user is left reading one task's chat over another task's files, with nothing on screen
    /// saying so. Every later write, the agent's included, lands in the wrong branch.
    #[test]
    fn merging_never_leaves_the_checkout_on_a_task_the_window_is_not_on() {
        let directory = TempDir::new().expect("temporary directory");
        let workspace = committed_repository(directory.path());
        let storage =
            ProjectStorage::open(&directory.path().join("data"), &workspace).expect("storage");
        let first = storage.tasks().active().expect("read").expect("a task");
        fs::write(workspace.join("first.gd"), "extends Node\n").expect("the first task's work");
        let second = storage
            .tasks()
            .create(&storage.switch_with_no_turn_to_refuse(&NOTHING_TO_STOP))
            .expect("create the second task")
            .task_id
            .expect("task ID");
        assert_ne!(first, second);

        let _ = storage.tasks().merge(
            &first,
            &storage.switch_with_no_turn_to_refuse(&NOTHING_TO_STOP),
        );

        let active = storage
            .tasks()
            .active()
            .expect("read")
            .expect("a task is still open");
        let expected = storage
            .tasks()
            .list()
            .expect("tasks")
            .into_iter()
            .find(|row| row.id == active)
            .expect("the open task")
            .worktree
            .expect("a branch")
            .branch_name;
        assert_eq!(
            git::current_branch(&workspace).as_deref(),
            Some(expected.as_str()),
            "either the merge refuses, or the window follows the checkout — never neither"
        );
    }

    /// A project that is not a Git repository still has an agent and still has files. What it does
    /// not have is a branch to keep the work on, so the two callers part company: `agent_workspace`
    /// answers the project and lets the user edit it, while `active_workspace` refuses, and the
    /// Godot session supervisor never starts an editor whose changes nothing would record.
    #[test]
    fn a_project_without_a_repository_answers_the_agent_and_refuses_the_session() {
        let directory = TempDir::new().expect("temporary directory");
        let storage = storage(&directory);
        let workspace = storage.workspace_path.clone();
        assert!(
            !git::is_repository(&workspace),
            "this fixture is deliberately not a repository"
        );

        assert_eq!(
            storage.tasks().agent_workspace().expect("agent workspace"),
            workspace,
            "the agent writes in the project whether or not Git is recording it"
        );
        assert!(
            storage
                .tasks()
                .active_workspace()
                .unwrap_err()
                .message
                .contains("not a Git repository"),
            "the session supervisor must name what is missing rather than start anyway"
        );
    }

    /// An agreed layout is still an agreed layout after the task that produced it is deleted.
    ///
    /// A cascade would leave both HTML files on disk with nothing naming them, which is the state
    /// every sketch saved before this table existed is already in.
    #[test]
    fn deleting_a_task_keeps_its_sketches_and_clears_the_task() {
        let directory = TempDir::new().expect("temporary directory");
        let workspace = committed_repository(directory.path());
        let storage =
            ProjectStorage::open(&directory.path().join("data"), &workspace).expect("storage");
        let doomed = storage
            .tasks()
            .create(&storage.switch_with_no_turn_to_refuse(&NOTHING_TO_STOP))
            .expect("create task")
            .task_id
            .expect("task ID");

        storage
            .sketches()
            .keep(&KeptSketch {
                task_id: Some(&doomed),
                ..kept("question-1-run", "Dock", "<p>a</p>", "<p>a</p>")
            })
            .expect("keep the sketch");
        storage
            .tasks()
            .delete(
                &doomed,
                &storage.switch_with_no_turn_to_refuse(&NOTHING_TO_STOP),
            )
            .expect("delete the task");

        let listed = storage.sketches().list(10).expect("list sketches");
        assert_eq!(
            listed.len(),
            1,
            "the layout outlives the task that produced it"
        );
        assert!(
            listed[0].task_id.is_none(),
            "the task it belonged to is cleared"
        );
    }

    /// The tasks view collects nothing, and that has to stay a decision rather than an oversight.
    ///
    /// A task goes when the user removes it and on no other occasion, and everything belonging to
    /// one cascades with it. The two rows that deliberately outlive a task — a memory and a sketch —
    /// clear their `task_id` and are collected by the views that own them.
    #[test]
    fn the_tasks_view_collects_nothing_and_leaves_what_outlives_a_task() {
        let directory = TempDir::new().expect("temporary directory");
        let storage = storage(&directory);
        make_repository(&storage.workspace_path.clone());
        let created = storage
            .tasks()
            .create(&storage.switch_with_no_turn_to_refuse(&NOTHING_TO_STOP))
            .expect("create a task");
        let task_id = created.task_id.expect("the new task");

        let collected = storage
            .tasks()
            .collect(&everything_is_old())
            .expect("collect");

        assert_eq!(collected.attachments_removed, 0);
        assert_eq!(collected.godot_runs_removed, 0);
        assert_eq!(collected.sketches_removed, 0);
        assert_eq!(collected.backups_removed, 0);
        assert!(
            storage
                .tasks()
                .list()
                .expect("list tasks")
                .iter()
                .any(|task| task.id == task_id),
            "no upkeep here touches a task"
        );
    }
}

//! The project itself: how its workspace was left, what its agent is told, and the database's own
//! upkeep.

use std::fs;
use std::path::Path;

use rusqlite::{OptionalExtension, params};

use super::*;
use crate::command_error::CommandError;

/// The project itself: how its workspace was left, what its agent is told, and the database's own
/// upkeep.
pub struct Project<'a> {
    pub(super) storage: &'a ProjectStorage,
}

impl Project<'_> {
    /// Reads one piece of remembered interface state, or `None` when the project has none.
    pub fn read_ui_state(&self, key: &str) -> Result<Option<String>, CommandError> {
        self.stored_ui_state(key)
            .map_err(CommandError::or_coded("project_state_unavailable"))
    }

    fn stored_ui_state(&self, key: &str) -> Result<Option<String>, CommandError> {
        validate_ui_key(key)?;
        self.storage
            .connection()?
            .query_row(
                "SELECT value FROM project_state WHERE key = ?1",
                [key],
                |row| row.get(0),
            )
            .optional()
            .map_err(database_error)
    }

    /// Records one piece of interface state, or forgets it when the renderer sends no value.
    ///
    /// The key is confined to the `ui.` prefix so that the renderer can never write over
    /// `active_task_id`, which lives in the same table and decides which worktree the agent and the
    /// editor session run in.
    pub fn write_ui_state(&self, key: &str, value: Option<&str>) -> Result<(), CommandError> {
        self.store_ui_state(key, value)
            .map_err(CommandError::or_coded("project_state_not_recorded"))
    }

    fn store_ui_state(&self, key: &str, value: Option<&str>) -> Result<(), CommandError> {
        validate_ui_key(key)?;
        let (_write_guard, connection) = self.storage.write_connection()?;
        match value {
            Some(value) => {
                if value.len() > MAX_UI_STATE_BYTES {
                    return Err(CommandError::from(
                        "The interface state is too large to store".to_owned(),
                    ));
                }
                connection
                    .execute(
                        "INSERT INTO project_state (key, value) VALUES (?1, ?2)
                         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                        params![key, value],
                    )
                    .map_err(database_error)?;
            }
            None => {
                connection
                    .execute("DELETE FROM project_state WHERE key = ?1", [key])
                    .map_err(database_error)?;
            }
        }
        Ok(())
    }

    /// The prompt this project sends its agent, or `None` while it follows the shipped one.
    /// A documentation answer already paid for, or nothing.
    ///
    /// Best-effort in both directions: a cache that cannot be read is a miss, not a failure, and a
    /// search that cannot be written is still a search that answered. Neither is worth ending a
    /// turn over.
    pub fn cached_docs_answer(
        &self,
        corpus_version: &str,
        mode: &str,
        question: &str,
    ) -> Option<String> {
        self.storage
            .connection()
            .ok()?
            .query_row(
                "SELECT response_json FROM docs_answers \
                 WHERE corpus_version = ?1 AND mode = ?2 AND question = ?3",
                rusqlite::params![corpus_version, mode, question],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .ok()
            .flatten()
    }

    /// Remembers one answer, so the next task asking the same thing does not pay for it again.
    ///
    /// Only a real answer is stored, and that rule is the whole of why this takes a decision rather
    /// than a response: pi-task recorded 52 cached non-answers re-served to every later sibling
    /// task, with escalation unable to fire because the miss never recurred again. A dead end paid
    /// for once and collected forever is worse than paying for the lookup twice.
    pub fn remember_docs_answer(
        &self,
        corpus_version: &str,
        mode: &str,
        question: &str,
        response_json: &str,
    ) {
        let (Ok(connection), Ok(now)) = (self.storage.connection(), now_millis()) else {
            return;
        };
        let _ = connection.execute(
            "INSERT OR REPLACE INTO docs_answers \
             (corpus_version, mode, question, response_json, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![corpus_version, mode, question, response_json, now],
        );
    }

    /// Opens a brief for one task, or reopens the one it already has.
    ///
    /// `INSERT OR REPLACE` rather than a failure on a second start, because starting again is what a
    /// user does when the first attempt stopped, and the phase columns are rewritten as the new run
    pub fn read_agent_prompt(&self) -> Result<Option<String>, CommandError> {
        self.stored_agent_prompt()
            .map_err(CommandError::or_coded("prompt_unreadable"))
    }

    fn stored_agent_prompt(&self) -> Result<Option<String>, CommandError> {
        self.storage
            .connection()?
            .query_row(
                "SELECT value FROM project_state WHERE key = ?1",
                [AGENT_PROMPT_KEY],
                |row| row.get(0),
            )
            .optional()
            .map_err(database_error)
    }

    /// Stores this project's prompt, or forgets it so the project follows the shipped one again.
    ///
    /// It shares `project_state` with the interface keys but not their prefix, because the renderer
    /// cannot reach it the way it reaches those: it is what the agent is told, so it comes through
    /// a command that checks its size rather than through the general interface-state write.
    pub fn write_agent_prompt(&self, prompt: Option<&str>) -> Result<(), CommandError> {
        self.store_agent_prompt(prompt)
            .map_err(CommandError::or_coded("prompt_unwritable"))
    }

    fn store_agent_prompt(&self, prompt: Option<&str>) -> Result<(), CommandError> {
        let (_write_guard, connection) = self.storage.write_connection()?;
        match prompt {
            Some(prompt) => {
                connection
                    .execute(
                        "INSERT INTO project_state (key, value) VALUES (?1, ?2)
                         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                        params![AGENT_PROMPT_KEY, prompt],
                    )
                    .map_err(database_error)?;
            }
            None => {
                connection
                    .execute(
                        "DELETE FROM project_state WHERE key = ?1",
                        [AGENT_PROMPT_KEY],
                    )
                    .map_err(database_error)?;
            }
        }
        Ok(())
    }

    /// The skills this project has turned off, or an empty list while it has turned off none.
    ///
    /// A row that cannot be parsed reads as nothing turned off, which is the safe direction: a
    /// corrupt value silently hiding the instructions a project relies on is far worse than one
    /// showing a skill the user meant to hide, and the next write repairs it.
    pub fn read_disabled_skills(&self) -> Result<Vec<String>, CommandError> {
        let stored: Option<String> = self
            .storage
            .connection()?
            .query_row(
                "SELECT value FROM project_state WHERE key = ?1",
                [DISABLED_SKILLS_KEY],
                |row| row.get(0),
            )
            .optional()
            .map_err(database_error)
            .map_err(CommandError::or_coded("skills_unreadable"))?;
        Ok(stored
            .and_then(|value| serde_json::from_str::<Vec<String>>(&value).ok())
            .unwrap_or_default())
    }

    /// Records the whole set. An empty set forgets the row, so a project that turned everything
    /// back on is indistinguishable from one that never turned anything off.
    pub fn write_disabled_skills(&self, names: &[String]) -> Result<(), CommandError> {
        self.store_disabled_skills(names)
            .map_err(CommandError::or_coded("skills_unwritable"))
    }

    fn store_disabled_skills(&self, names: &[String]) -> Result<(), CommandError> {
        let (_write_guard, connection) = self.storage.write_connection()?;
        if names.is_empty() {
            connection
                .execute(
                    "DELETE FROM project_state WHERE key = ?1",
                    [DISABLED_SKILLS_KEY],
                )
                .map_err(database_error)?;
            return Ok(());
        }
        let value = serde_json::to_string(names)
            .map_err(|error| CommandError::from(format!("Could not record the skills: {error}")))?;
        connection
            .execute(
                "INSERT INTO project_state (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![DISABLED_SKILLS_KEY, value],
            )
            .map_err(database_error)?;
        Ok(())
    }

    pub fn create_backup(&self) -> Result<BackupResult, CommandError> {
        self.write_backup()
            .map_err(CommandError::or_coded("backup_not_created"))
    }

    fn write_backup(&self) -> Result<BackupResult, CommandError> {
        let _write_guard = self.storage.write_lock()?;
        let created_at = now_millis()?;
        let backup_root = self.storage.data_root.join("backups");
        fs::create_dir_all(&backup_root).map_err(|error| {
            CommandError::from(format!(
                "Could not create {}: {error}",
                backup_root.display()
            ))
        })?;
        let destination = backup_root.join(format!("{created_at}-{}", Uuid::now_v7()));
        fs::create_dir(&destination).map_err(|error| {
            CommandError::from(format!(
                "Could not create {}: {error}",
                destination.display()
            ))
        })?;
        let database = destination.join(PROJECT_DATABASE_FILE_NAME);
        self.storage
            .connection()?
            .execute("VACUUM INTO ?1", [database.to_string_lossy().as_ref()])
            .map_err(database_error)?;
        for directory in ["blobs", "logs"] {
            let source = self.storage.project_directory().join(directory);
            if source.is_dir() {
                copy_directory(&source, &destination.join(directory))?;
            }
        }
        let manifest = serde_json::json!({
            "version": 1,
            "projectId": self.storage.project_id,
            "workspacePath": self.storage.workspace_path,
            "createdAt": created_at
        });
        fs::write(
            destination.join("manifest.json"),
            serde_json::to_vec_pretty(&manifest).map_err(|error| error.to_string())?,
        )
        .map_err(|error| CommandError::from(format!("Could not write backup manifest: {error}")))?;
        Ok(BackupResult {
            path: destination.to_string_lossy().into_owned(),
            created_at: from_database_u64(created_at, "backup creation time")?,
        })
    }

    /// Answers this project has already paid for that came out of a manual it no longer has, and
    /// backups past the fifth.
    ///
    /// `docs_answers` is keyed by `corpus_version` deliberately — the manual ships inside the
    /// gofer-rag package, so the package version *is* the manual, and an answer is only good for the
    /// one it came out of. What that key buys is that an upgrade can never serve an answer from the
    /// old manual; what it costs is that the previous corpus's rows are unreachable the instant the
    /// package moves. Nothing had ever removed them, so every upgrade this project had ever seen was
    /// still in the file.
    ///
    /// Only when the current version is known. `rag::known_corpus_version` learns it from the probe
    /// that runs before a turn, so a process that has not asked the manual anything yet has no
    /// current version to compare against — and deleting everything that fails to match `None` would
    /// throw away the live corpus rather than the dead ones.
    pub(crate) fn collect(&self, cutoffs: &Cutoffs) -> Result<Collected, CommandError> {
        let connection = self.storage.connection()?;
        let docs_answers_removed = match &cutoffs.corpus_version {
            Some(current) => connection
                .execute(
                    "DELETE FROM docs_answers WHERE corpus_version <> ?1",
                    [current],
                )
                .map_err(database_error)?,
            None => 0,
        };
        let backups_removed = prune_backups(
            &self.storage.data_root.join("backups"),
            cutoffs.backups_kept,
        )?;
        Ok(Collected {
            docs_answers_removed,
            backups_removed,
            ..Collected::default()
        })
    }

    /// One pass of upkeep over every view, under the project's one write lock.
    ///
    /// A fold rather than a function that reaches into five other views' tables, which is what this
    /// was: eighty lines on `Project` deleting attachments, runs and log directories that belong to
    /// `Chats` and `Runs`. Two things followed from that and both were real. The result was
    /// incomplete when it was returned — re-embedding needs the memory worker, so the count left
    /// here as a zero and `lib.rs` patched it afterwards — and the two views added since, `sketches`
    /// and the project's own `docs_answers`, were collected by nothing at all, because the one
    /// function that knew how to clean up was somewhere their authors never looked.
    ///
    /// The lock is taken once, here, and held across all six. So a `collect` reads and writes on its
    /// own connection and must never reach for `write_connection`: the write lock is a plain mutex,
    /// it is not reentrant, and a second claim would deadlock against this one. That is also why
    /// [`Memories::collect`] re-embeds through [`Memories::write_embedding`] rather than through
    /// `save_embedding`.
    ///
    /// Held across all six means held for as long as the slowest of them, so nothing that can be
    /// done before it is done under it. The memory backfill is the only piece with anywhere else to
    /// be — its vectors come from a subprocess, two hundred round trips at worst — and it is taken
    /// out of the pass and handed in.
    pub fn run_maintenance(&self) -> Result<MaintenanceResult, CommandError> {
        self.maintain_database()
            .map_err(CommandError::or_coded("storage_not_maintained"))
    }

    fn maintain_database(&self) -> Result<MaintenanceResult, CommandError> {
        let pending = self
            .storage
            .memory()
            .embeddings_to_restore()
            .unwrap_or_default();
        let _write_guard = self.storage.write_lock()?;
        let cutoffs = Cutoffs::current()?;
        let mut collected = MaintenanceResult::default();
        let mut failure = None;
        for view in Upkeep::every() {
            match view.collect(self.storage, &cutoffs, &pending) {
                Ok(view) => collected.absorb(view),
                Err(error) => failure = failure.or(Some(error)),
            }
        }
        match failure {
            Some(error) => Err(error),
            None => Ok(collected),
        }
    }
}

pub(crate) fn copy_directory(source: &Path, destination: &Path) -> Result<(), CommandError> {
    fs::create_dir_all(destination).map_err(|error| {
        CommandError::from(format!(
            "Could not create {}: {error}",
            destination.display()
        ))
    })?;
    for entry in fs::read_dir(source).map_err(|error| {
        CommandError::from(format!("Could not read {}: {error}", source.display()))
    })? {
        let entry = entry.map_err(|error| {
            CommandError::from(format!("Could not read directory entry: {error}"))
        })?;
        let file_type = entry.file_type().map_err(|error| error.to_string())?;
        let target = destination.join(entry.file_name());
        if file_type.is_dir() {
            copy_directory(&entry.path(), &target)?;
        } else if file_type.is_file() {
            fs::copy(entry.path(), &target).map_err(|error| {
                CommandError::from(format!(
                    "Could not copy {}: {error}",
                    entry.path().display()
                ))
            })?;
        }
    }
    Ok(())
}

fn prune_backups(path: &Path, keep: usize) -> Result<usize, CommandError> {
    if !path.is_dir() {
        return Ok(0);
    }
    let mut directories = fs::read_dir(path)
        .map_err(|error| CommandError::from(format!("Could not read {}: {error}", path.display())))?
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .collect::<Vec<_>>();
    directories.sort_by_key(|entry| std::cmp::Reverse(entry.file_name()));
    let mut removed = 0;
    for entry in directories.into_iter().skip(keep) {
        fs::remove_dir_all(entry.path()).map_err(|error| {
            CommandError::from(format!(
                "Could not remove {}: {error}",
                entry.path().display()
            ))
        })?;
        removed += 1;
    }
    Ok(removed)
}

fn validate_ui_key(key: &str) -> Result<(), CommandError> {
    if !key.starts_with(UI_STATE_PREFIX) || key.len() > 128 {
        return Err(CommandError::from(
            "The interface state key is not one Gofer stores".to_owned(),
        ));
    }
    Ok(())
}

/// The key a task's unsent message is kept under. Per task, because the draft belongs to the
/// conversation the user was writing it in.
pub fn draft_ui_key(task_id: &str) -> String {
    format!("{UI_STATE_PREFIX}draft.{task_id}")
}

#[cfg(test)]
mod tests {
    use super::super::test_support::*;
    use super::*;
    use tempfile::TempDir;

    /// Copying the data directory copies the project, which is the whole point of keeping it in the
    /// workspace: a project that is moved, renamed, or copied is still the same project, and a
    /// project whose folder is deleted is gone rather than waiting to reappear.
    #[test]
    fn a_project_travels_with_its_own_directory() {
        let directory = TempDir::new().expect("temporary directory");
        let first = storage(&directory);
        first
            .project()
            .write_ui_state("ui.workspace", Some("carried"))
            .expect("write");
        let project_id = first.project_id.clone();

        let moved_workspace = directory.path().join("elsewhere");
        fs::create_dir(&moved_workspace).expect("second workspace");
        let moved_root = moved_workspace.join(".gofer");
        copy_directory(&directory.path().join("data"), &moved_root).expect("copy");
        let second = ProjectStorage::open(&moved_root, &moved_workspace).expect("storage");

        assert_eq!(
            second
                .project()
                .read_ui_state("ui.workspace")
                .expect("read"),
            Some("carried".to_owned())
        );
        assert_eq!(second.project_id, project_id);
    }

    /// A project that predates the move is carried into its workspace once, and only once.
    #[test]
    fn legacy_project_data_is_carried_into_the_workspace_once() {
        let directory = TempDir::new().expect("temporary directory");
        let legacy_root = directory.path().join("legacy");
        let workspace = directory.path().join("workspace");
        fs::create_dir(&workspace).expect("workspace directory");
        let canonical = paths::canonical(&workspace).expect("canonical");

        let legacy_project =
            ProjectStorage::open(&legacy_root.join("projects").join("old-id"), &workspace)
                .expect("legacy storage");
        legacy_project
            .project()
            .write_ui_state("ui.workspace", Some("remembered"))
            .expect("write");
        let catalog =
            open_connection(&legacy_root.join(LEGACY_CATALOG_FILE_NAME)).expect("catalog");
        catalog
            .execute_batch(
                "CREATE TABLE projects (
                    id TEXT PRIMARY KEY,
                    canonical_path TEXT NOT NULL UNIQUE,
                    display_name TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    last_opened_at INTEGER NOT NULL
                ) STRICT;",
            )
            .expect("legacy schema");
        catalog
            .execute(
                "INSERT INTO projects VALUES (?1, ?2, 'workspace', 1, 1)",
                params!["old-id", canonical.to_string_lossy().into_owned()],
            )
            .expect("legacy row");

        let data_root = workspace.join(".gofer");
        migrate_legacy_data(&legacy_root, &workspace, &data_root).expect("migrate");
        let carried = ProjectStorage::open(&data_root, &workspace).expect("storage");
        assert_eq!(
            carried
                .project()
                .read_ui_state("ui.workspace")
                .expect("read"),
            Some("remembered".to_owned())
        );

        carried
            .project()
            .write_ui_state("ui.workspace", Some("since moved"))
            .expect("write");
        migrate_legacy_data(&legacy_root, &workspace, &data_root).expect("migrate again");
        assert_eq!(
            ProjectStorage::open(&data_root, &workspace)
                .expect("storage")
                .project()
                .read_ui_state("ui.workspace")
                .expect("read"),
            Some("since moved".to_owned())
        );
    }

    /// The interface state is the project's, and only the interface's: a renderer that asked for
    /// `active_task_id` would be asking which worktree the agent writes in.
    #[test]
    fn interface_state_round_trips_and_refuses_keys_it_does_not_own() {
        let directory = TempDir::new().expect("temporary directory");
        let storage = storage(&directory);

        assert_eq!(
            storage
                .project()
                .read_ui_state("ui.workspace")
                .expect("read"),
            None
        );
        storage
            .project()
            .write_ui_state("ui.workspace", Some(r#"{"centerTab":"scripts"}"#))
            .expect("write");
        assert_eq!(
            storage
                .project()
                .read_ui_state("ui.workspace")
                .expect("read"),
            Some(r#"{"centerTab":"scripts"}"#.to_owned())
        );

        storage
            .project()
            .write_ui_state("ui.workspace", Some(r#"{"centerTab":"game"}"#))
            .expect("overwrite");
        assert_eq!(
            storage
                .project()
                .read_ui_state("ui.workspace")
                .expect("read"),
            Some(r#"{"centerTab":"game"}"#.to_owned())
        );

        storage
            .project()
            .write_ui_state("ui.workspace", None)
            .expect("forget");
        assert_eq!(
            storage
                .project()
                .read_ui_state("ui.workspace")
                .expect("read"),
            None
        );

        assert!(storage.project().read_ui_state("active_task_id").is_err());
        assert!(
            storage
                .project()
                .write_ui_state("active_task_id", Some("x"))
                .is_err()
        );
        assert!(
            storage
                .project()
                .write_ui_state("ui.workspace", Some(&"x".repeat(MAX_UI_STATE_BYTES + 1)))
                .is_err()
        );
    }

    /// Off is stored and on is not, so a project that has never opened the tab hides nothing.
    #[test]
    fn the_skills_a_project_turned_off_round_trip_and_can_be_turned_back_on() {
        let directory = TempDir::new().expect("temporary directory");
        let storage = storage(&directory);

        assert!(
            storage
                .project()
                .read_disabled_skills()
                .expect("read")
                .is_empty()
        );
        storage
            .project()
            .write_disabled_skills(&["sound-design".to_owned(), "tile-levels".to_owned()])
            .expect("write");
        assert_eq!(
            storage.project().read_disabled_skills().expect("read"),
            vec!["sound-design".to_owned(), "tile-levels".to_owned()]
        );

        storage
            .project()
            .write_disabled_skills(&[])
            .expect("write none");
        assert!(
            storage
                .project()
                .read_disabled_skills()
                .expect("read")
                .is_empty()
        );
    }

    /// A value nothing can parse reads as "nothing is off", which is the safe direction: a corrupt
    /// row silently hiding the instructions a project relies on is worse than one showing a skill
    /// the user meant to hide, and the next write repairs it.
    #[test]
    fn an_unreadable_disabled_list_hides_nothing() {
        let directory = TempDir::new().expect("temporary directory");
        let storage = storage(&directory);
        storage
            .project()
            .write_ui_state("ui.throwaway", Some("x"))
            .expect("a write connection exists");
        let (_guard, connection) = storage.write_connection().expect("write connection");
        connection
            .execute(
                "INSERT INTO project_state (key, value) VALUES (?1, ?2)",
                rusqlite::params![super::DISABLED_SKILLS_KEY, "not json at all"],
            )
            .expect("write the corrupt row");
        drop(connection);

        assert!(
            storage
                .project()
                .read_disabled_skills()
                .expect("read")
                .is_empty()
        );
    }

    /// A prompt the project stores is the project's; storing none is how it follows the shipped one.
    #[test]
    fn the_agent_prompt_round_trips_and_can_be_given_back() {
        let directory = TempDir::new().expect("temporary directory");
        let storage = storage(&directory);

        assert_eq!(storage.project().read_agent_prompt().expect("read"), None);
        storage
            .project()
            .write_agent_prompt(Some("Answer in Latvian."))
            .expect("write");
        assert_eq!(
            storage.project().read_agent_prompt().expect("read"),
            Some("Answer in Latvian.".to_owned())
        );

        storage
            .project()
            .write_agent_prompt(Some("Answer in Latvian, briefly."))
            .expect("overwrite");
        assert_eq!(
            storage.project().read_agent_prompt().expect("read"),
            Some("Answer in Latvian, briefly.".to_owned())
        );

        storage.project().write_agent_prompt(None).expect("forget");
        assert_eq!(storage.project().read_agent_prompt().expect("read"), None);
        storage
            .project()
            .write_ui_state("ui.workspace", Some("kept"))
            .expect("write interface state");
        storage
            .project()
            .write_agent_prompt(None)
            .expect("forget again");
        assert_eq!(
            storage
                .project()
                .read_ui_state("ui.workspace")
                .expect("read"),
            Some("kept".to_owned())
        );
    }

    /// The unsent message belongs to the conversation, so deleting the conversation takes it.
    #[test]
    fn deleting_a_task_forgets_its_composer_draft() {
        let directory = TempDir::new().expect("temporary directory");
        let workspace = committed_repository(directory.path());
        let storage =
            ProjectStorage::open(&directory.path().join("data"), &workspace).expect("storage");
        let kept = storage
            .chats()
            .load(None)
            .expect("first task")
            .task_id
            .expect("ID");
        let doomed = storage
            .tasks()
            .create(&storage.switch_with_no_turn_to_refuse(&NOTHING_TO_STOP))
            .expect("create task")
            .task_id
            .expect("task ID");
        storage
            .project()
            .write_ui_state(&draft_ui_key(&kept), Some("kept draft"))
            .expect("write the kept draft");
        storage
            .project()
            .write_ui_state(&draft_ui_key(&doomed), Some("doomed draft"))
            .expect("write the doomed draft");

        storage
            .tasks()
            .delete(
                &doomed,
                &storage.switch_with_no_turn_to_refuse(&NOTHING_TO_STOP),
            )
            .expect("delete task");

        assert_eq!(
            storage
                .project()
                .read_ui_state(&draft_ui_key(&doomed))
                .expect("read"),
            None
        );
        assert_eq!(
            storage
                .project()
                .read_ui_state(&draft_ui_key(&kept))
                .expect("read"),
            Some("kept draft".to_owned())
        );
    }

    /// A remembered documentation answer belongs to the manual it came out of. The manual ships
    /// inside the gofer-rag package, so its version is in the key rather than a column checked
    /// afterwards — an upgrade must not be able to serve even one answer out of the old one.
    #[test]
    fn a_remembered_documentation_answer_belongs_to_one_manual() {
        let directory = TempDir::new().expect("temporary directory");
        let storage = storage(&directory);
        let project = storage.project();

        assert_eq!(
            project.cached_docs_answer("0.1.3", "ask", "how do i tween"),
            None
        );

        project.remember_docs_answer("0.1.3", "ask", "how do i tween", "{\"text\":\"use Tween\"}");
        assert_eq!(
            project.cached_docs_answer("0.1.3", "ask", "how do i tween"),
            Some("{\"text\":\"use Tween\"}".to_owned())
        );

        assert_eq!(
            project.cached_docs_answer("0.1.4", "ask", "how do i tween"),
            None
        );
        assert_eq!(
            project.cached_docs_answer("0.1.3", "search", "how do i tween"),
            None
        );
        assert_eq!(
            project.cached_docs_answer("0.1.3", "ask", "how do i animate"),
            None
        );
    }

    #[test]
    fn project_backup_contains_a_consistent_database_and_manifest() {
        let directory = TempDir::new().expect("temporary directory");
        let storage = storage(&directory);
        let backup = storage.project().create_backup().expect("create backup");
        let path = PathBuf::from(backup.path);

        assert!(path.join(PROJECT_DATABASE_FILE_NAME).is_file());
        assert!(path.join("manifest.json").is_file());
        let connection =
            open_connection(&path.join(PROJECT_DATABASE_FILE_NAME)).expect("open backup");
        let tasks = connection
            .query_row("SELECT COUNT(*) FROM tasks", [], |row| row.get::<_, u32>(0))
            .expect("task count");
        assert_eq!(tasks, 1);
    }

    /// The fold visits every view, and nothing after it has to finish the answer.
    ///
    /// `memory_embeddings_restored` was returned as a hardcoded zero and patched by `lib.rs`
    /// afterwards, so a second caller was handed a number that was simply untrue. The count of six
    /// is the other half: a view that is added and not folded over is collected by nothing, which
    /// is exactly what happened to `sketches` and to `docs_answers`.
    #[test]
    fn maintenance_folds_over_every_view_and_needs_no_caller_to_finish_it() {
        let directory = TempDir::new().expect("temporary directory");
        let storage = storage(&directory);
        assert_eq!(Upkeep::every().count(), 6, "one pass, one visit per view");
        assert_eq!(
            Upkeep::every().collect::<Vec<_>>(),
            vec![
                Upkeep::Chats,
                Upkeep::Tasks,
                Upkeep::Runs,
                Upkeep::Sketches,
                Upkeep::Memories,
                Upkeep::Project
            ]
        );

        let result = storage.project().run_maintenance().expect("maintenance");

        assert_eq!(result.memory_embeddings_restored, 0);
        assert_eq!(result.attachments_removed, 0);
        assert_eq!(result.sketches_removed, 0);
        assert_eq!(result.docs_answers_removed, 0);
    }

    /// Answers out of a manual the project no longer has were collected by nothing at all.
    ///
    /// `corpus_version` is part of the key deliberately — the manual ships inside the gofer-rag
    /// package, so a bumped package cannot serve an answer from the old one. What that key costs is
    /// that the previous corpus's rows become unreachable rather than stale, and every upgrade the
    /// project had ever seen was still in the file.
    #[test]
    fn the_project_view_collects_answers_from_a_manual_it_no_longer_has() {
        let directory = TempDir::new().expect("temporary directory");
        let storage = storage(&directory);
        for (corpus, answer) in [
            ("1.4.0", r#"{"text":"old"}"#),
            ("2.0.0", r#"{"text":"new"}"#),
        ] {
            storage
                .project()
                .remember_docs_answer(corpus, "ask", "How do I tween?", answer);
        }

        let collected = storage
            .project()
            .collect(&everything_is_old())
            .expect("collect");

        assert_eq!(collected.docs_answers_removed, 1);
        assert_eq!(
            storage
                .project()
                .cached_docs_answer("1.4.0", "ask", "How do I tween?"),
            None
        );
        assert_eq!(
            storage
                .project()
                .cached_docs_answer("2.0.0", "ask", "How do I tween?"),
            Some(r#"{"text":"new"}"#.to_owned()),
            "the manual in use keeps what it has already paid for"
        );
    }

    /// An unknown corpus version drops nothing, because it cannot tell the live manual from a dead
    /// one. The version is learned from the probe that runs before a turn, so a process that has
    /// not asked the manual anything has no answer to compare against — and everything fails to
    /// match `None`.
    #[test]
    fn the_project_view_keeps_every_answer_while_it_does_not_know_which_manual_is_current() {
        let directory = TempDir::new().expect("temporary directory");
        let storage = storage(&directory);
        storage.project().remember_docs_answer(
            "1.4.0",
            "ask",
            "How do I tween?",
            r#"{"text":"old"}"#,
        );

        let collected = storage
            .project()
            .collect(&Cutoffs {
                corpus_version: None,
                ..everything_is_old()
            })
            .expect("collect");

        assert_eq!(collected.docs_answers_removed, 0);
        assert!(
            storage
                .project()
                .cached_docs_answer("1.4.0", "ask", "How do I tween?")
                .is_some()
        );
    }
}

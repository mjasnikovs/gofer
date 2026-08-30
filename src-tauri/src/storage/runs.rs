//! Editor runs, and the output they produced.

use rusqlite::{OptionalExtension, TransactionBehavior, params};

use super::*;
use crate::command_error::CommandError;

/// Editor runs, and the output they produced.
///
/// A run row is opened when the editor starts and closed when it stops. The lines arrive in
/// batches while it is alive and stay findable once it is gone, which is when they are worth
/// reading.
pub struct Runs<'a> {
    pub(super) storage: &'a ProjectStorage,
}

impl Runs<'_> {
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn start(&self, request: &StartGodotRunRequest) -> Result<GodotRunRecord, CommandError> {
        self.start_record(request)
            .map_err(CommandError::or_coded("run_not_recorded"))
    }

    fn start_record(&self, request: &StartGodotRunRequest) -> Result<GodotRunRecord, CommandError> {
        self.storage
            .runs()
            .start_record_in(request, &self.storage.workspace_path)
    }

    pub fn start_in(
        &self,
        request: &StartGodotRunRequest,
        project_path: &Path,
    ) -> Result<GodotRunRecord, CommandError> {
        self.start_record_in(request, project_path)
            .map_err(CommandError::or_coded("run_not_recorded"))
    }

    fn start_record_in(
        &self,
        request: &StartGodotRunRequest,
        project_path: &Path,
    ) -> Result<GodotRunRecord, CommandError> {
        if !request.metadata.is_object() {
            return Err(CommandError::from(
                "Godot run metadata must be an object".to_owned(),
            ));
        }
        if request.metadata.to_string().len() > 256 * 1024 {
            return Err(CommandError::from(
                "Godot run metadata cannot exceed 256 KiB".to_owned(),
            ));
        }
        let (_write_guard, connection) = self.storage.write_connection()?;
        let task_id = match &request.task_id {
            Some(task_id) => {
                require_task(&connection, task_id)?;
                Some(task_id.clone())
            }
            None => active_task_id(&connection)?,
        };
        let id = Uuid::now_v7().to_string();
        let started_at = now_millis()?;
        let metadata = serde_json::to_string(&request.metadata).map_err(|error| {
            CommandError::from(format!("Could not serialize Godot run metadata: {error}"))
        })?;
        connection
            .execute(
                "INSERT INTO godot_runs
                 (id, task_id, session_id, status, godot_version, project_path, started_at,
                  metadata_json)
                 VALUES (?1, ?2, ?3, 'running', ?4, ?5, ?6, ?7)",
                params![
                    id,
                    task_id,
                    request.session_id,
                    request.godot_version,
                    project_path.to_string_lossy(),
                    started_at,
                    metadata
                ],
            )
            .map_err(database_error)?;
        Ok(GodotRunRecord {
            id,
            task_id,
            session_id: request.session_id.clone(),
            status: "running".to_owned(),
            godot_version: request.godot_version.clone(),
            project_path: project_path.to_string_lossy().into_owned(),
            started_at: from_database_u64(started_at, "Godot run start time")?,
            ended_at: None,
            exit_code: None,
            metadata: request.metadata.clone(),
        })
    }

    pub fn append_logs(
        &self,
        request: &AppendGodotLogsRequest,
    ) -> Result<AppendGodotLogsResult, CommandError> {
        self.append_run_logs(request)
            .map_err(CommandError::or_coded("run_logs_not_recorded"))
    }

    fn append_run_logs(
        &self,
        request: &AppendGodotLogsRequest,
    ) -> Result<AppendGodotLogsResult, CommandError> {
        validate_log_entries(&request.entries)?;
        let segment_id = Uuid::now_v7().to_string();
        let relative_path = PathBuf::from("logs")
            .join(&request.run_id)
            .join(format!("{segment_id}.jsonl.zst"));
        let path = self.storage.project_directory().join(&relative_path);
        let parent = path
            .parent()
            .ok_or_else(|| CommandError::from("The Godot log path has no parent".to_owned()))?;
        fs::create_dir_all(parent).map_err(|error| {
            CommandError::from(format!("Could not create the Godot log directory: {error}"))
        })?;
        let mut json_lines = Vec::new();
        for entry in &request.entries {
            serde_json::to_writer(&mut json_lines, entry).map_err(|error| {
                CommandError::from(format!("Could not serialize a Godot log entry: {error}"))
            })?;
            json_lines.push(b'\n');
        }
        let compressed = zstd::stream::encode_all(json_lines.as_slice(), 3).map_err(|error| {
            CommandError::from(format!("Could not compress Godot logs: {error}"))
        })?;
        let temporary = parent.join(format!(".{segment_id}.tmp"));
        fs::write(&temporary, compressed).map_err(|error| {
            CommandError::from(format!("Could not save {}: {error}", temporary.display()))
        })?;
        fs::rename(&temporary, &path).map_err(|error| {
            CommandError::from(format!("Could not store {}: {error}", path.display()))
        })?;
        let first_timestamp = request
            .entries
            .iter()
            .map(|entry| entry.timestamp)
            .min()
            .ok_or_else(|| {
                CommandError::from("At least one Godot log entry is required".to_owned())
            })?;
        let last_timestamp = request
            .entries
            .iter()
            .map(|entry| entry.timestamp)
            .max()
            .ok_or_else(|| {
                CommandError::from("At least one Godot log entry is required".to_owned())
            })?;
        let (_write_guard, mut connection) = self.storage.write_connection()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(database_error)?;
        let status = transaction
            .query_row(
                "SELECT status FROM godot_runs WHERE id = ?1",
                [&request.run_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(database_error)?
            .ok_or_else(|| CommandError::from("The Godot run was not found".to_owned()))?;
        if status != "running" {
            return Err(CommandError::from(
                "Logs can only be appended to a running Godot session".to_owned(),
            ));
        }
        transaction
            .execute(
                "INSERT INTO godot_log_segments
                 (id, run_id, relative_path, first_timestamp, last_timestamp, entry_count, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    segment_id,
                    request.run_id,
                    relative_path.to_string_lossy(),
                    to_database_integer(first_timestamp, "first log timestamp")?,
                    to_database_integer(last_timestamp, "last log timestamp")?,
                    request.entries.len() as i64,
                    now_millis()?
                ],
            )
            .map_err(database_error)?;
        let mut indexed_event_count = 0;
        for entry in request
            .entries
            .iter()
            .filter(|entry| entry.level == "warning" || entry.level == "error")
        {
            transaction
                .execute(
                    "INSERT INTO godot_log_events
                     (id, run_id, timestamp, level, source, message, stack_trace)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                    params![
                        Uuid::now_v7().to_string(),
                        request.run_id,
                        to_database_integer(entry.timestamp, "log timestamp")?,
                        entry.level,
                        entry.source,
                        entry.message,
                        entry.stack_trace
                    ],
                )
                .map_err(database_error)?;
            indexed_event_count += 1;
        }
        transaction.commit().map_err(database_error)?;
        Ok(AppendGodotLogsResult {
            segment_id,
            entry_count: request.entries.len(),
            indexed_event_count,
        })
    }

    /// Searches the indexed warning and error history of every stored run.
    ///
    /// The live session buffer only holds what the current editor printed, so this is the one way
    /// back to output from a session that has already stopped. The needle is passed to FTS5 as a
    /// quoted phrase: a user typing `ERROR: res://x.gd` is asking for those words, not writing a
    /// match expression whose operators would make the query fail.
    pub fn search_logs(
        &self,
        request: &SearchGodotLogsRequest,
    ) -> Result<Vec<GodotLogSearchHit>, CommandError> {
        self.search_run_logs(request)
            .map_err(CommandError::or_coded("log_history_unavailable"))
    }

    fn search_run_logs(
        &self,
        request: &SearchGodotLogsRequest,
    ) -> Result<Vec<GodotLogSearchHit>, CommandError> {
        let needle = request.query.trim();
        if needle.is_empty() {
            return Err(CommandError::from(
                "A Godot log search needs a query".to_owned(),
            ));
        }
        let phrase = format!("\"{}\"", needle.replace('"', "\"\""));
        let limit = request.limit.unwrap_or(50).clamp(1, 200);
        let connection = self.storage.connection()?;
        let mut statement = connection
            .prepare(
                "SELECT events.run_id, runs.session_id, runs.task_id, events.timestamp,
                        events.level, events.source, events.message
                 FROM godot_log_fts
                 JOIN godot_log_events AS events ON events.rowid = godot_log_fts.rowid
                 JOIN godot_runs AS runs ON runs.id = events.run_id
                 WHERE godot_log_fts MATCH ?1
                 ORDER BY events.timestamp DESC, events.rowid DESC
                 LIMIT ?2",
            )
            .map_err(database_error)?;
        let hits = statement
            .query_map(params![phrase, limit as i64], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, String>(6)?,
                ))
            })
            .map_err(database_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(database_error)?;
        hits.into_iter()
            .map(|hit| {
                Ok(GodotLogSearchHit {
                    run_id: hit.0,
                    session_id: hit.1,
                    task_id: hit.2,
                    timestamp: from_database_u64(hit.3, "log timestamp")?,
                    level: hit.4,
                    source: hit.5,
                    message: hit.6,
                })
            })
            .collect()
    }

    pub fn finish(&self, request: &FinishGodotRunRequest) -> Result<(), CommandError> {
        self.finish_record(request)
            .map_err(CommandError::or_coded("run_not_recorded"))
    }

    fn finish_record(&self, request: &FinishGodotRunRequest) -> Result<(), CommandError> {
        if !["completed", "failed", "aborted"].contains(&request.status.as_str()) {
            return Err(CommandError::from(
                "The final Godot run status is invalid".to_owned(),
            ));
        }
        let (_write_guard, connection) = self.storage.write_connection()?;
        let changed = connection
            .execute(
                "UPDATE godot_runs SET status = ?1, ended_at = ?2, exit_code = ?3
                 WHERE id = ?4 AND status = 'running'",
                params![
                    request.status,
                    now_millis()?,
                    request.exit_code,
                    request.run_id
                ],
            )
            .map_err(database_error)?;
        if changed == 0 {
            return Err(CommandError::from(
                "The running Godot session was not found".to_owned(),
            ));
        }
        Ok(())
    }

    /// Runs that ended a month ago, with everything recorded under them.
    ///
    /// Only a run that has an `ended_at`. A row with none is either still being written to by a live
    /// editor session or was left open by one that died, and `close_abandoned_runs` decides which —
    /// deleting on age here would take the log of the session running now.
    ///
    /// The row goes first and the directory after it. `godot_log_segments` and `godot_log_events`
    /// cascade from the run and the FTS index follows them by trigger, so the delete is one
    /// statement; what does not cascade is `logs/<run_id>`, because a file is not a foreign key.
    /// Removing that first would leave rows naming segments that cannot be read.
    pub(crate) fn collect(&self, cutoffs: &Cutoffs) -> Result<Collected, CommandError> {
        let mut connection = self.storage.connection()?;
        let mut statement = connection
            .prepare("SELECT id FROM godot_runs WHERE ended_at IS NOT NULL AND ended_at < ?1")
            .map_err(database_error)?;
        let old_runs = statement
            .query_map([cutoffs.runs_before], |row| row.get::<_, String>(0))
            .map_err(database_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(database_error)?;
        drop(statement);
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(database_error)?;
        for run_id in &old_runs {
            transaction
                .execute("DELETE FROM godot_runs WHERE id = ?1", [run_id])
                .map_err(database_error)?;
        }
        transaction.commit().map_err(database_error)?;
        for run_id in &old_runs {
            let path = self.storage.project_directory().join("logs").join(run_id);
            if path.is_dir() {
                fs::remove_dir_all(&path).map_err(|error| {
                    CommandError::from(format!("Could not remove {}: {error}", path.display()))
                })?;
            }
        }
        Ok(Collected {
            godot_runs_removed: old_runs.len(),
            ..Collected::default()
        })
    }
}

pub(crate) fn validate_log_entries(entries: &[GodotLogEntry]) -> Result<(), CommandError> {
    if entries.is_empty() || entries.len() > 10_000 {
        return Err(CommandError::from(
            "A Godot log batch must contain between 1 and 10,000 entries".to_owned(),
        ));
    }
    let mut total_bytes = 0_usize;
    for entry in entries {
        if !["debug", "info", "warning", "error"].contains(&entry.level.as_str()) {
            return Err(CommandError::from(
                "A Godot log entry has an invalid level".to_owned(),
            ));
        }
        if entry.message.trim().is_empty() {
            return Err(CommandError::from(
                "Godot log messages cannot be empty".to_owned(),
            ));
        }
        if entry.message.len() > 1024 * 1024 {
            return Err(CommandError::from(
                "Individual Godot log messages cannot exceed 1 MiB".to_owned(),
            ));
        }
        total_bytes = total_bytes
            .saturating_add(entry.message.len())
            .saturating_add(entry.source.as_ref().map_or(0, String::len))
            .saturating_add(entry.stack_trace.as_ref().map_or(0, String::len));
    }
    if total_bytes > 8 * 1024 * 1024 {
        return Err(CommandError::from(
            "A Godot log batch cannot exceed 8 MiB".to_owned(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::test_support::*;
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn godot_logs_are_compressed_and_important_events_are_indexed() {
        let directory = TempDir::new().expect("temporary directory");
        let storage = storage(&directory);
        let run = storage
            .runs()
            .start(&StartGodotRunRequest {
                task_id: None,
                session_id: Some("session-1".to_owned()),
                godot_version: Some("4.7".to_owned()),
                metadata: serde_json::json!({"scene": "main.tscn"}),
            })
            .expect("start Godot run");
        let entries = vec![
            GodotLogEntry {
                timestamp: 10,
                level: "info".to_owned(),
                message: "Game started".to_owned(),
                source: None,
                stack_trace: None,
            },
            GodotLogEntry {
                timestamp: 11,
                level: "warning".to_owned(),
                message: "Missing animation".to_owned(),
                source: Some("player.gd".to_owned()),
                stack_trace: None,
            },
            GodotLogEntry {
                timestamp: 12,
                level: "error".to_owned(),
                message: "Invalid call".to_owned(),
                source: Some("player.gd".to_owned()),
                stack_trace: Some("player.gd:12".to_owned()),
            },
        ];

        let appended = storage
            .runs()
            .append_logs(&AppendGodotLogsRequest {
                run_id: run.id.clone(),
                entries,
            })
            .expect("append logs");

        assert_eq!(appended.entry_count, 3);
        assert_eq!(appended.indexed_event_count, 2);
        let connection = storage.connection().expect("connection");
        let relative_path = connection
            .query_row(
                "SELECT relative_path FROM godot_log_segments WHERE id = ?1",
                [&appended.segment_id],
                |row| row.get::<_, String>(0),
            )
            .expect("log segment path");
        let compressed = fs::read(storage.project_directory().join(relative_path))
            .expect("compressed log segment");
        let decoded = zstd::stream::decode_all(compressed.as_slice()).expect("decoded log segment");
        assert!(
            String::from_utf8(decoded)
                .expect("UTF-8 logs")
                .contains("Game started")
        );
        let indexed = connection
            .query_row(
                "SELECT count(*) FROM godot_log_fts WHERE godot_log_fts MATCH 'animation'",
                [],
                |row| row.get::<_, u32>(0),
            )
            .expect("indexed warnings");
        assert_eq!(indexed, 1);

        let hits = storage
            .runs()
            .search_logs(&SearchGodotLogsRequest {
                query: "Invalid call".to_owned(),
                limit: None,
            })
            .expect("search stored logs");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].run_id, run.id);
        assert_eq!(hits[0].session_id.as_deref(), Some("session-1"));
        assert_eq!(hits[0].level, "error");
        assert!(
            storage
                .runs()
                .search_logs(&SearchGodotLogsRequest {
                    query: "  ".to_owned(),
                    limit: Some(10),
                })
                .is_err()
        );
        assert!(
            storage
                .runs()
                .search_logs(&SearchGodotLogsRequest {
                    query: "player.gd:12 OR".to_owned(),
                    limit: Some(1),
                })
                .expect("an operator-looking phrase is a phrase")
                .is_empty()
        );

        storage
            .runs()
            .finish(&FinishGodotRunRequest {
                run_id: run.id,
                status: "failed".to_owned(),
                exit_code: Some(1),
            })
            .expect("finish run");
    }

    /// A run row cannot say a session is running once the process that owned it is gone.
    ///
    /// The row is closed when the editor stops, and nothing closes it when Gofer itself is killed
    /// or crashes. Nothing ever would: the run belonged to a session of a process that no longer
    /// exists. So the user's own history kept a session that was running right now, forever — the
    /// stale badge, written to disk. The next open is the first moment that can be known, and it
    /// is where the row is ended.
    #[test]
    fn a_run_left_open_by_a_gofer_that_died_is_closed_when_the_project_opens_again() {
        let directory = TempDir::new().expect("temporary directory");
        let workspace = directory.path().join("workspace");
        fs::create_dir(&workspace).expect("workspace directory");
        let data_root = directory.path().join("data");
        let storage = ProjectStorage::open(&data_root, &workspace).expect("storage");
        let run = storage
            .runs()
            .start(&StartGodotRunRequest {
                task_id: None,
                session_id: Some("session-1".to_owned()),
                godot_version: Some("4.7".to_owned()),
                metadata: serde_json::json!({}),
            })
            .expect("start Godot run");
        storage
            .runs()
            .append_logs(&AppendGodotLogsRequest {
                run_id: run.id.clone(),
                entries: vec![GodotLogEntry {
                    timestamp: run.started_at + 5_000,
                    level: "error".to_owned(),
                    message: "SCRIPT ERROR: the last thing this run said".to_owned(),
                    source: None,
                    stack_trace: None,
                }],
            })
            .expect("record output");
        drop(storage);

        let reopened = ProjectStorage::open(&data_root, &workspace).expect("reopen storage");
        let connection = reopened.connection().expect("connection");
        let (status, ended_at) = connection
            .query_row(
                "SELECT status, ended_at FROM godot_runs WHERE id = ?1",
                [&run.id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
            )
            .expect("read the run back");

        assert_eq!(status, "aborted");
        assert_eq!(ended_at, i64::try_from(run.started_at + 5_000).unwrap());
        assert!(
            reopened
                .runs()
                .append_logs(&AppendGodotLogsRequest {
                    run_id: run.id.clone(),
                    entries: vec![GodotLogEntry {
                        timestamp: 20,
                        level: "info".to_owned(),
                        message: "late".to_owned(),
                        source: None,
                        stack_trace: None,
                    }],
                })
                .unwrap_err()
                .message
                .contains("running Godot session")
        );
    }

    /// A run's lifecycle is a state machine, and every transition out of it is refused by name.
    /// These are the answers the log viewer and the session supervisor read when something is
    /// already over: appending to a finished run and finishing it twice are both ordinary races,
    /// not programming errors, so they have to fail as data rather than corrupt the history.
    #[test]
    fn a_finished_godot_run_refuses_further_writes() {
        let directory = TempDir::new().expect("temporary directory");
        let storage = storage(&directory);
        let run = storage
            .runs()
            .start(&StartGodotRunRequest {
                task_id: None,
                session_id: Some("session-1".to_owned()),
                godot_version: Some("4.7".to_owned()),
                metadata: serde_json::json!({}),
            })
            .expect("start Godot run");
        let entry = || GodotLogEntry {
            timestamp: 10,
            level: "info".to_owned(),
            message: "Game started".to_owned(),
            source: None,
            stack_trace: None,
        };

        assert!(
            storage
                .runs()
                .finish(&FinishGodotRunRequest {
                    run_id: run.id.clone(),
                    status: "exploded".to_owned(),
                    exit_code: None,
                })
                .unwrap_err()
                .message
                .contains("status is invalid"),
            "only the three terminal statuses may end a run"
        );
        storage
            .runs()
            .finish(&FinishGodotRunRequest {
                run_id: run.id.clone(),
                status: "completed".to_owned(),
                exit_code: Some(0),
            })
            .expect("finish the run");

        assert!(
            storage
                .runs()
                .finish(&FinishGodotRunRequest {
                    run_id: run.id.clone(),
                    status: "aborted".to_owned(),
                    exit_code: None,
                })
                .unwrap_err()
                .message
                .contains("was not found"),
            "a run only ends once: the second finish matches no running session"
        );
        assert!(
            storage
                .runs()
                .append_logs(&AppendGodotLogsRequest {
                    run_id: run.id.clone(),
                    entries: vec![entry()],
                })
                .unwrap_err()
                .message
                .contains("running Godot session"),
            "output cannot arrive after the run that produced it ended"
        );
        assert!(
            storage
                .runs()
                .append_logs(&AppendGodotLogsRequest {
                    run_id: "018f47aa-09d2-7b34-a2d3-8c4e6f123456".to_owned(),
                    entries: vec![entry()],
                })
                .unwrap_err()
                .message
                .contains("was not found")
        );
        assert!(
            storage
                .runs()
                .search_logs(&SearchGodotLogsRequest {
                    query: "   ".to_owned(),
                    limit: None,
                })
                .unwrap_err()
                .message
                .contains("needs a query"),
            "a blank needle is a mistake, not a request for every log line ever recorded"
        );
    }

    /// A run that ended long ago goes with its segments and its log directory; a live one stays.
    ///
    /// `ended_at` is the whole test. A row without one is either being written to by the editor
    /// running now or was left open by one that died, and deleting on age would take the log of the
    /// session on screen.
    #[test]
    fn the_runs_view_collects_finished_runs_and_the_directories_holding_their_output() {
        let directory = TempDir::new().expect("temporary directory");
        let storage = storage(&directory);
        let finished = storage
            .runs()
            .start(&StartGodotRunRequest {
                task_id: None,
                session_id: None,
                godot_version: Some("4.7.2".to_owned()),
                metadata: serde_json::json!({}),
            })
            .expect("start a run");
        let running = storage
            .runs()
            .start(&StartGodotRunRequest {
                task_id: None,
                session_id: None,
                godot_version: Some("4.7.2".to_owned()),
                metadata: serde_json::json!({}),
            })
            .expect("start a second run");
        for run in [&finished, &running] {
            storage
                .runs()
                .append_logs(&AppendGodotLogsRequest {
                    run_id: run.id.clone(),
                    entries: vec![GodotLogEntry {
                        timestamp: 1,
                        level: "error".to_owned(),
                        message: "Nil scene".to_owned(),
                        source: None,
                        stack_trace: None,
                    }],
                })
                .expect("append logs");
        }
        storage
            .runs()
            .finish(&FinishGodotRunRequest {
                run_id: finished.id.clone(),
                status: "completed".to_owned(),
                exit_code: Some(0),
            })
            .expect("finish the run");
        let logs = storage.project_directory().join("logs");

        let collected = storage
            .runs()
            .collect(&everything_is_old())
            .expect("collect");

        assert_eq!(collected.godot_runs_removed, 1);
        assert!(!logs.join(&finished.id).exists());
        assert!(
            logs.join(&running.id).is_dir(),
            "a run with no end is the session that is still writing"
        );
        let connection = storage.connection().expect("connection");
        let segments = connection
            .query_row("SELECT count(*) FROM godot_log_segments", [], |row| {
                row.get::<_, u32>(0)
            })
            .expect("segment count");
        assert_eq!(segments, 1, "the segments cascade from the run");
    }
}

use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, Once};
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

use crate::git;
use crate::paths;

const CATALOG_FILE_NAME: &str = "catalog.sqlite";
const PROJECTS_DIRECTORY: &str = "projects";
const PROJECT_DATABASE_FILE_NAME: &str = "project.sqlite";
const MEMORY_EMBEDDING_DIMENSIONS: usize = 1024;
const MEMORY_EMBEDDING_MODEL: &str = "onnx-community/Qwen3-Embedding-0.6B-ONNX";
const MAX_STORED_CHAT_BYTES: usize = 32 * 1024 * 1024;
const MAX_STORED_CHAT_MESSAGES: usize = 10_000;
const MAX_STORED_MESSAGE_BYTES: usize = 1024 * 1024;
static SQLITE_VEC_REGISTRATION: Once = Once::new();

const CATALOG_SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    canonical_path TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_opened_at INTEGER NOT NULL
) STRICT;
PRAGMA user_version = 1;
"#;

const PROJECT_SCHEMA_V1: &str = r#"
CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'completed')),
    agent_messages_json TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS project_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS messages (
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    sequence INTEGER NOT NULL,
    message_id INTEGER NOT NULL,
    sender TEXT NOT NULL CHECK (sender IN ('user', 'assistant')),
    text TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    payload_json TEXT NOT NULL,
    PRIMARY KEY (task_id, sequence),
    UNIQUE (task_id, message_id)
) STRICT;
CREATE TABLE IF NOT EXISTS attachments (
    id TEXT PRIMARY KEY,
    content_hash TEXT NOT NULL,
    name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS message_attachments (
    task_id TEXT NOT NULL,
    message_sequence INTEGER NOT NULL,
    attachment_id TEXT NOT NULL REFERENCES attachments(id),
    position INTEGER NOT NULL,
    PRIMARY KEY (task_id, message_sequence, position),
    FOREIGN KEY (task_id, message_sequence) REFERENCES messages(task_id, sequence) ON DELETE CASCADE
) STRICT;
CREATE INDEX IF NOT EXISTS messages_task_timestamp ON messages(task_id, timestamp);
CREATE INDEX IF NOT EXISTS attachments_content_hash ON attachments(content_hash);
PRAGMA user_version = 1;
"#;

const PROJECT_SCHEMA_V2: &str = r#"
BEGIN IMMEDIATE;
CREATE TABLE task_worktrees (
    task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
    branch_name TEXT NOT NULL,
    worktree_path TEXT NOT NULL,
    base_commit TEXT NOT NULL,
    head_commit TEXT,
    merged_commit TEXT,
    updated_at INTEGER NOT NULL
) STRICT;
CREATE TABLE godot_runs (
    id TEXT PRIMARY KEY,
    task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
    status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'aborted')),
    godot_version TEXT,
    project_path TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    exit_code INTEGER,
    metadata_json TEXT NOT NULL DEFAULT '{}'
) STRICT;
CREATE TABLE godot_log_segments (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES godot_runs(id) ON DELETE CASCADE,
    relative_path TEXT NOT NULL UNIQUE,
    first_timestamp INTEGER NOT NULL,
    last_timestamp INTEGER NOT NULL,
    entry_count INTEGER NOT NULL,
    created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE godot_log_events (
    id TEXT NOT NULL UNIQUE,
    run_id TEXT NOT NULL REFERENCES godot_runs(id) ON DELETE CASCADE,
    timestamp INTEGER NOT NULL,
    level TEXT NOT NULL CHECK (level IN ('warning', 'error')),
    source TEXT,
    message TEXT NOT NULL,
    stack_trace TEXT
) STRICT;
CREATE VIRTUAL TABLE godot_log_fts USING fts5(
    message,
    stack_trace,
    content='godot_log_events',
    content_rowid='rowid'
);
CREATE TRIGGER godot_log_events_ai AFTER INSERT ON godot_log_events BEGIN
    INSERT INTO godot_log_fts(rowid, message, stack_trace)
    VALUES (new.rowid, new.message, new.stack_trace);
END;
CREATE TRIGGER godot_log_events_ad AFTER DELETE ON godot_log_events BEGIN
    INSERT INTO godot_log_fts(godot_log_fts, rowid, message, stack_trace)
    VALUES ('delete', old.rowid, old.message, old.stack_trace);
END;
CREATE TABLE memory_items (
    id TEXT PRIMARY KEY,
    task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
    kind TEXT NOT NULL CHECK (kind IN ('decision', 'preference', 'fact', 'issue', 'summary')),
    state TEXT NOT NULL CHECK (state IN ('candidate', 'confirmed', 'superseded')),
    content TEXT NOT NULL,
    provenance_json TEXT NOT NULL,
    superseded_by TEXT REFERENCES memory_items(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
) STRICT;
CREATE VIRTUAL TABLE memory_fts USING fts5(
    content,
    content='memory_items',
    content_rowid='rowid',
    tokenize='unicode61'
);
CREATE TRIGGER memory_items_ai AFTER INSERT ON memory_items BEGIN
    INSERT INTO memory_fts(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER memory_items_ad AFTER DELETE ON memory_items BEGIN
    INSERT INTO memory_fts(memory_fts, rowid, content)
    VALUES ('delete', old.rowid, old.content);
END;
CREATE TRIGGER memory_items_au AFTER UPDATE OF content ON memory_items BEGIN
    INSERT INTO memory_fts(memory_fts, rowid, content)
    VALUES ('delete', old.rowid, old.content);
    INSERT INTO memory_fts(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TABLE memory_embeddings (
    memory_id TEXT PRIMARY KEY REFERENCES memory_items(id) ON DELETE CASCADE,
    model TEXT NOT NULL,
    dimensions INTEGER NOT NULL,
    normalized INTEGER NOT NULL CHECK (normalized IN (0, 1)),
    format_version INTEGER NOT NULL,
    embedding BLOB NOT NULL,
    updated_at INTEGER NOT NULL
) STRICT;
CREATE VIRTUAL TABLE memory_vectors USING vec0(
    memory_id TEXT PRIMARY KEY,
    embedding float[1024] distance_metric=cosine,
    scope_key TEXT partition key
);
CREATE INDEX godot_runs_task_started ON godot_runs(task_id, started_at DESC);
CREATE INDEX godot_log_segments_run ON godot_log_segments(run_id, first_timestamp);
CREATE INDEX godot_log_events_run_timestamp ON godot_log_events(run_id, timestamp);
CREATE INDEX memory_items_task_state ON memory_items(task_id, state, updated_at DESC);
PRAGMA user_version = 2;
COMMIT;
"#;

// `memory_vectors` is a vec0 virtual table, so the `memory_embeddings` foreign key cascade does
// not reach it. Without this trigger a deleted memory would leave its vector searchable forever.
const PROJECT_SCHEMA_V3: &str = r#"
BEGIN;
CREATE TRIGGER memory_items_ad_vectors AFTER DELETE ON memory_items BEGIN
    DELETE FROM memory_vectors WHERE memory_id = old.id;
END;
PRAGMA user_version = 3;
COMMIT;
"#;

// Run logging moved from the retired standalone Godot process to the managed editor session, so a
// stored run now names the session that produced it as well as itself. The column is added rather
// than the table rebuilt: runs recorded before the migration keep their segments and their FTS
// rows, and a NULL `session_id` is exactly what "recorded before Gofer managed sessions" means.
const PROJECT_SCHEMA_V4: &str = r#"
BEGIN;
ALTER TABLE godot_runs ADD COLUMN session_id TEXT;
CREATE INDEX godot_runs_session ON godot_runs(session_id, started_at DESC);
PRAGMA user_version = 4;
COMMIT;
"#;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredAttachment {
    pub id: String,
    pub name: String,
    pub mime_type: String,
    pub size: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredMessage {
    pub id: u64,
    pub sender: String,
    pub text: String,
    pub timestamp: u64,
    #[serde(default)]
    pub attachments: Vec<StoredAttachment>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredChat {
    #[serde(default)]
    pub task_id: Option<String>,
    #[serde(default)]
    pub messages: Vec<StoredMessage>,
    #[serde(default)]
    pub agent_messages: Vec<Value>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskWorktree {
    pub branch_name: String,
    pub worktree_path: String,
    pub base_commit: String,
    pub head_commit: Option<String>,
    pub merged_commit: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskRecord {
    pub id: String,
    pub title: String,
    pub status: String,
    pub is_current: bool,
    pub created_at: u64,
    pub updated_at: u64,
    pub worktree: Option<TaskWorktree>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartGodotRunRequest {
    pub task_id: Option<String>,
    /// The editor session that produced the run. Absent only for runs recorded before Gofer
    /// managed the editor itself.
    #[serde(default)]
    pub session_id: Option<String>,
    pub godot_version: Option<String>,
    #[serde(default = "empty_object")]
    pub metadata: Value,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GodotRunRecord {
    pub id: String,
    pub task_id: Option<String>,
    pub session_id: Option<String>,
    pub status: String,
    pub godot_version: Option<String>,
    pub project_path: String,
    pub started_at: u64,
    pub ended_at: Option<u64>,
    pub exit_code: Option<i32>,
    pub metadata: Value,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GodotLogEntry {
    pub timestamp: u64,
    pub level: String,
    pub message: String,
    pub source: Option<String>,
    pub stack_trace: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppendGodotLogsRequest {
    pub run_id: String,
    pub entries: Vec<GodotLogEntry>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppendGodotLogsResult {
    pub segment_id: String,
    pub entry_count: usize,
    pub indexed_event_count: usize,
}

/// A full-text query over the stored warning and error history of every recorded run.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchGodotLogsRequest {
    pub query: String,
    #[serde(default)]
    pub limit: Option<usize>,
}

/// One indexed log event, reported with the run and session identifiers that produced it. A run
/// recorded before Gofer managed the editor has no session, which is how history predating the
/// migration stays readable instead of being hidden.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GodotLogSearchHit {
    pub run_id: String,
    pub session_id: Option<String>,
    pub task_id: Option<String>,
    pub timestamp: u64,
    pub level: String,
    pub source: Option<String>,
    pub message: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FinishGodotRunRequest {
    pub run_id: String,
    pub status: String,
    pub exit_code: Option<i32>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryRecord {
    pub id: String,
    pub task_id: Option<String>,
    pub kind: String,
    pub state: String,
    pub content: String,
    pub provenance: Value,
    pub superseded_by: Option<String>,
    pub created_at: u64,
    pub updated_at: u64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertMemoryRequest {
    pub id: Option<String>,
    pub task_id: Option<String>,
    pub kind: String,
    pub state: String,
    pub content: String,
    #[serde(default = "empty_object")]
    pub provenance: Value,
    pub superseded_by: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveMemoryEmbeddingRequest {
    pub memory_id: String,
    pub model: String,
    pub vector: Vec<f32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchMemoryRequest {
    pub query: String,
    pub task_id: Option<String>,
    pub vector: Option<Vec<f32>>,
    pub limit: Option<usize>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemorySearchResult {
    pub memory: MemoryRecord,
    pub score: f64,
    pub text_rank: Option<usize>,
    pub vector_distance: Option<f64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeTaskResult {
    pub task_id: String,
    pub head_commit: String,
    pub merged_commit: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupResult {
    pub path: String,
    pub created_at: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MaintenanceResult {
    pub attachments_removed: usize,
    pub blobs_removed: usize,
    pub godot_runs_removed: usize,
    pub backups_removed: usize,
    pub memory_embeddings_restored: usize,
}

#[derive(Default)]
struct SearchScore {
    text_rank: Option<usize>,
    vector_rank: Option<usize>,
    vector_distance: Option<f64>,
}

#[derive(Clone, Debug)]
pub struct ProjectStorage {
    data_root: PathBuf,
    project_id: String,
    workspace_path: PathBuf,
    write_lock: Arc<Mutex<()>>,
}

impl ProjectStorage {
    pub fn open(data_root: &Path, workspace_path: &Path) -> Result<Self, String> {
        fs::create_dir_all(data_root)
            .map_err(|error| format!("Could not create {}: {error}", data_root.display()))?;
        let canonical_path = paths::canonical(workspace_path)
            .map_err(|error| format!("Could not resolve {}: {error}", workspace_path.display()))?;
        let catalog_path = data_root.join(CATALOG_FILE_NAME);
        let catalog = open_connection(&catalog_path)?;
        migrate(&catalog, CATALOG_SCHEMA, 1)?;
        let canonical = canonical_path.to_string_lossy().into_owned();
        let existing = catalog
            .query_row(
                "SELECT id FROM projects WHERE canonical_path = ?1",
                [&canonical],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(database_error)?;
        let project_id = existing.unwrap_or_else(|| Uuid::now_v7().to_string());
        let now = now_millis()?;
        let display_name = canonical_path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("Project");
        catalog
            .execute(
                "INSERT INTO projects (id, canonical_path, display_name, created_at, last_opened_at)
                 VALUES (?1, ?2, ?3, ?4, ?4)
                 ON CONFLICT(canonical_path) DO UPDATE SET last_opened_at = excluded.last_opened_at",
                params![project_id, canonical, display_name, now],
            )
            .map_err(database_error)?;
        let storage = Self {
            data_root: data_root.to_path_buf(),
            project_id,
            workspace_path: canonical_path,
            write_lock: Arc::new(Mutex::new(())),
        };
        fs::create_dir_all(storage.project_directory())
            .map_err(|error| format!("Could not create project storage: {error}"))?;
        let project = storage.connection()?;
        migrate_project(&project)?;
        storage.ensure_active_task(&project)?;
        Ok(storage)
    }

    pub fn load_chat(&self) -> Result<StoredChat, String> {
        let connection = self.connection()?;
        let task_id = self.ensure_active_task(&connection)?;
        let agent_messages_json = connection
            .query_row(
                "SELECT agent_messages_json FROM tasks WHERE id = ?1",
                [&task_id],
                |row| row.get::<_, String>(0),
            )
            .map_err(database_error)?;
        let mut statement = connection
            .prepare("SELECT payload_json FROM messages WHERE task_id = ?1 ORDER BY sequence")
            .map_err(database_error)?;
        let messages = statement
            .query_map([&task_id], |row| row.get::<_, String>(0))
            .map_err(database_error)?
            .map(|row| {
                let payload = row.map_err(database_error)?;
                serde_json::from_str(&payload)
                    .map_err(|error| format!("Stored chat message is invalid: {error}"))
            })
            .collect::<Result<Vec<StoredMessage>, String>>()?;
        let agent_messages = serde_json::from_str(&agent_messages_json)
            .map_err(|error| format!("Stored agent context is invalid: {error}"))?;
        Ok(StoredChat {
            task_id: Some(task_id),
            messages,
            agent_messages,
        })
    }

    pub fn save_chat(&self, chat: &StoredChat) -> Result<(), String> {
        validate_chat(chat)?;
        let message_payloads = chat
            .messages
            .iter()
            .map(|message| {
                serde_json::to_string(message)
                    .map_err(|error| format!("Could not serialize chat message: {error}"))
            })
            .collect::<Result<Vec<_>, _>>()?;
        let agent_messages = serde_json::to_string(&chat.agent_messages)
            .map_err(|error| format!("Could not serialize agent context: {error}"))?;
        let (_write_guard, mut connection) = self.write_connection()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(database_error)?;
        let task_id = match &chat.task_id {
            Some(task_id) => {
                let exists = transaction
                    .query_row("SELECT 1 FROM tasks WHERE id = ?1", [task_id], |_| Ok(()))
                    .optional()
                    .map_err(database_error)?
                    .is_some();
                if !exists {
                    return Err("The chat task no longer exists".to_owned());
                }
                task_id.clone()
            }
            None => self.ensure_active_task(&transaction)?,
        };
        transaction
            .execute("DELETE FROM messages WHERE task_id = ?1", [&task_id])
            .map_err(database_error)?;
        for (sequence, (message, payload)) in chat.messages.iter().zip(message_payloads).enumerate()
        {
            transaction
                .execute(
                    "INSERT INTO messages
                     (task_id, sequence, message_id, sender, text, timestamp, payload_json)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                    params![
                        task_id,
                        sequence as i64,
                        to_database_integer(message.id, "message ID")?,
                        message.sender,
                        message.text,
                        to_database_integer(message.timestamp, "message timestamp")?,
                        payload
                    ],
                )
                .map_err(database_error)?;
            for (position, attachment) in message.attachments.iter().enumerate() {
                let exists = transaction
                    .query_row(
                        "SELECT 1 FROM attachments WHERE id = ?1",
                        [&attachment.id],
                        |_| Ok(()),
                    )
                    .optional()
                    .map_err(database_error)?
                    .is_some();
                if !exists {
                    return Err(format!(
                        "Attachment '{}' has not been stored",
                        attachment.name
                    ));
                }
                transaction
                    .execute(
                        "INSERT INTO message_attachments
                         (task_id, message_sequence, attachment_id, position)
                         VALUES (?1, ?2, ?3, ?4)",
                        params![task_id, sequence as i64, attachment.id, position as i64],
                    )
                    .map_err(database_error)?;
            }
        }
        if let Some(message) = chat
            .messages
            .iter()
            .find(|message| message.sender == "user" && !message.text.trim().is_empty())
        {
            let title = message.text.trim().chars().take(80).collect::<String>();
            transaction
                .execute(
                    "UPDATE tasks SET title = ?1 WHERE id = ?2 AND title = 'New task'",
                    params![title, task_id],
                )
                .map_err(database_error)?;
        }
        transaction
            .execute(
                "UPDATE tasks SET agent_messages_json = ?1, updated_at = ?2 WHERE id = ?3",
                params![agent_messages, now_millis()?, task_id],
            )
            .map_err(database_error)?;
        transaction.commit().map_err(database_error)
    }

    pub fn create_task(&self) -> Result<StoredChat, String> {
        let task_id = Uuid::now_v7().to_string();
        let branch_suffix = task_id
            .chars()
            .filter(|character| *character != '-')
            .take(12)
            .collect::<String>();
        let branch_name = format!("gofer/task-{branch_suffix}");
        let worktree_path = self.project_directory().join("worktrees").join(&task_id);
        let created_worktree =
            git::create_task_worktree(&self.workspace_path, &worktree_path, &branch_name)?;
        let result = self.insert_task(&task_id, created_worktree.as_ref());
        if result.is_err()
            && let Some(worktree) = &created_worktree
        {
            git::discard_created_worktree(
                &self.workspace_path,
                &worktree.worktree_path,
                &worktree.branch_name,
            );
        }
        result?;
        Ok(StoredChat {
            task_id: Some(task_id),
            messages: Vec::new(),
            agent_messages: Vec::new(),
        })
    }

    fn insert_task(
        &self,
        task_id: &str,
        worktree: Option<&git::CreatedWorktree>,
    ) -> Result<(), String> {
        let (_write_guard, mut connection) = self.write_connection()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(database_error)?;
        let now = now_millis()?;
        transaction
            .execute(
                "INSERT INTO tasks (id, title, status, created_at, updated_at)
                 VALUES (?1, 'New task', 'active', ?2, ?2)",
                params![task_id, now],
            )
            .map_err(database_error)?;
        if let Some(worktree) = worktree {
            transaction
                .execute(
                    "INSERT INTO task_worktrees
                     (task_id, branch_name, worktree_path, base_commit, head_commit, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![
                        task_id,
                        worktree.branch_name,
                        worktree.worktree_path.to_string_lossy(),
                        worktree.base_commit,
                        worktree.head_commit,
                        now
                    ],
                )
                .map_err(database_error)?;
        }
        set_active_task(&transaction, task_id)?;
        transaction.commit().map_err(database_error)
    }

    pub fn activate_task(&self, task_id: &str) -> Result<StoredChat, String> {
        {
            let (_write_guard, mut connection) = self.write_connection()?;
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
        self.load_chat()
    }

    pub fn agent_workspace(&self) -> Result<PathBuf, String> {
        let connection = self.connection()?;
        let Some(task_id) = active_task_id(&connection)? else {
            return Ok(self.workspace_path.clone());
        };
        let worktree = connection
            .query_row(
                "SELECT worktree_path FROM task_worktrees WHERE task_id = ?1",
                [&task_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(database_error)?;
        Ok(worktree
            .map(PathBuf::from)
            .filter(|path| path.is_dir())
            .unwrap_or_else(|| self.workspace_path.clone()))
    }

    /// Resolves the active task's isolated worktree, failing when no task is active or the
    /// worktree is missing. The Godot session supervisor uses this instead of `agent_workspace` so
    /// it never installs the addon in the user's main checkout.
    pub fn active_task_workspace(&self) -> Result<PathBuf, String> {
        let connection = self.connection()?;
        let Some(task_id) = active_task_id(&connection)? else {
            return Err("No task is active".to_owned());
        };
        let worktree = connection
            .query_row(
                "SELECT worktree_path FROM task_worktrees WHERE task_id = ?1",
                [&task_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(database_error)?
            .ok_or_else(|| "The active task does not have an isolated Git worktree".to_owned())?;
        let path = PathBuf::from(worktree);
        if !path.is_dir() {
            return Err(format!(
                "The active task worktree does not exist: {}",
                path.display()
            ));
        }
        Ok(path)
    }

    pub fn merge_task(&self, task_id: &str) -> Result<MergeTaskResult, String> {
        let connection = self.connection()?;
        require_task(&connection, task_id)?;
        let (branch_name, worktree_path) = connection
            .query_row(
                "SELECT branch_name, worktree_path FROM task_worktrees WHERE task_id = ?1",
                [task_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()
            .map_err(database_error)?
            .ok_or_else(|| "The task does not have an isolated Git worktree".to_owned())?;
        let merged = git::merge_task_worktree(
            &self.workspace_path,
            Path::new(&worktree_path),
            &branch_name,
        )?;
        let now = now_millis()?;
        drop(connection);
        let (_write_guard, mut connection) = self.write_connection()?;
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

    pub fn list_tasks(&self) -> Result<Vec<TaskRecord>, String> {
        let connection = self.connection()?;
        let current_task_id = active_task_id(&connection)?;
        let mut statement = connection
            .prepare(
                "SELECT t.id, t.title, t.status, t.created_at, t.updated_at,
                        w.branch_name, w.worktree_path, w.base_commit, w.head_commit, w.merged_commit
                 FROM tasks t
                 LEFT JOIN task_worktrees w ON w.task_id = t.id
                 ORDER BY t.updated_at DESC",
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
                Ok(TaskRecord {
                    is_current: current_task_id.as_deref() == Some(row.0.as_str()),
                    id: row.0,
                    title: row.1,
                    status: row.2,
                    created_at: from_database_u64(row.3, "task creation time")?,
                    updated_at: from_database_u64(row.4, "task update time")?,
                    worktree: row.5,
                })
            })
            .collect()
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub fn start_godot_run(
        &self,
        request: &StartGodotRunRequest,
    ) -> Result<GodotRunRecord, String> {
        self.start_godot_run_in(request, &self.workspace_path)
    }

    pub fn start_godot_run_in(
        &self,
        request: &StartGodotRunRequest,
        project_path: &Path,
    ) -> Result<GodotRunRecord, String> {
        if !request.metadata.is_object() {
            return Err("Godot run metadata must be an object".to_owned());
        }
        if request.metadata.to_string().len() > 256 * 1024 {
            return Err("Godot run metadata cannot exceed 256 KiB".to_owned());
        }
        let (_write_guard, connection) = self.write_connection()?;
        let task_id = match &request.task_id {
            Some(task_id) => {
                require_task(&connection, task_id)?;
                Some(task_id.clone())
            }
            None => active_task_id(&connection)?,
        };
        let id = Uuid::now_v7().to_string();
        let started_at = now_millis()?;
        let metadata = serde_json::to_string(&request.metadata)
            .map_err(|error| format!("Could not serialize Godot run metadata: {error}"))?;
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

    pub fn append_godot_logs(
        &self,
        request: &AppendGodotLogsRequest,
    ) -> Result<AppendGodotLogsResult, String> {
        validate_log_entries(&request.entries)?;
        let segment_id = Uuid::now_v7().to_string();
        let relative_path = PathBuf::from("logs")
            .join(&request.run_id)
            .join(format!("{segment_id}.jsonl.zst"));
        let path = self.project_directory().join(&relative_path);
        let parent = path
            .parent()
            .ok_or_else(|| "The Godot log path has no parent".to_owned())?;
        fs::create_dir_all(parent)
            .map_err(|error| format!("Could not create {}: {error}", parent.display()))?;
        let mut json_lines = Vec::new();
        for entry in &request.entries {
            serde_json::to_writer(&mut json_lines, entry)
                .map_err(|error| format!("Could not serialize a Godot log entry: {error}"))?;
            json_lines.push(b'\n');
        }
        let compressed = zstd::stream::encode_all(json_lines.as_slice(), 3)
            .map_err(|error| format!("Could not compress Godot logs: {error}"))?;
        let temporary = parent.join(format!(".{segment_id}.tmp"));
        fs::write(&temporary, compressed)
            .map_err(|error| format!("Could not save {}: {error}", temporary.display()))?;
        fs::rename(&temporary, &path)
            .map_err(|error| format!("Could not store {}: {error}", path.display()))?;
        let first_timestamp = request
            .entries
            .iter()
            .map(|entry| entry.timestamp)
            .min()
            .ok_or_else(|| "At least one Godot log entry is required".to_owned())?;
        let last_timestamp = request
            .entries
            .iter()
            .map(|entry| entry.timestamp)
            .max()
            .ok_or_else(|| "At least one Godot log entry is required".to_owned())?;
        let (_write_guard, mut connection) = self.write_connection()?;
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
            .ok_or_else(|| "The Godot run was not found".to_owned())?;
        if status != "running" {
            return Err("Logs can only be appended to a running Godot session".to_owned());
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
    pub fn search_godot_logs(
        &self,
        request: &SearchGodotLogsRequest,
    ) -> Result<Vec<GodotLogSearchHit>, String> {
        let needle = request.query.trim();
        if needle.is_empty() {
            return Err("A Godot log search needs a query".to_owned());
        }
        let phrase = format!("\"{}\"", needle.replace('"', "\"\""));
        let limit = request.limit.unwrap_or(50).clamp(1, 200);
        let connection = self.connection()?;
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

    pub fn finish_godot_run(&self, request: &FinishGodotRunRequest) -> Result<(), String> {
        if !["completed", "failed", "aborted"].contains(&request.status.as_str()) {
            return Err("The final Godot run status is invalid".to_owned());
        }
        let (_write_guard, connection) = self.write_connection()?;
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
            return Err("The running Godot session was not found".to_owned());
        }
        Ok(())
    }

    pub fn upsert_memory(&self, request: &UpsertMemoryRequest) -> Result<MemoryRecord, String> {
        validate_memory(request)?;
        let (_write_guard, mut connection) = self.write_connection()?;
        if let Some(task_id) = &request.task_id {
            require_task(&connection, task_id)?;
        }
        let id = request
            .id
            .clone()
            .unwrap_or_else(|| Uuid::now_v7().to_string());
        let now = now_millis()?;
        let provenance = serde_json::to_string(&request.provenance)
            .map_err(|error| format!("Could not serialize memory provenance: {error}"))?;
        let previous = connection
            .query_row(
                "SELECT task_id, content FROM memory_items WHERE id = ?1",
                [&id],
                |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()
            .map_err(database_error)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(database_error)?;
        transaction
            .execute(
                "INSERT INTO memory_items
                 (id, task_id, kind, state, content, provenance_json, superseded_by, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
                 ON CONFLICT(id) DO UPDATE SET
                    task_id = excluded.task_id,
                    kind = excluded.kind,
                    state = excluded.state,
                    content = excluded.content,
                    provenance_json = excluded.provenance_json,
                    superseded_by = excluded.superseded_by,
                    updated_at = excluded.updated_at",
                params![
                    id,
                    request.task_id,
                    request.kind,
                    request.state,
                    request.content.trim(),
                    provenance,
                    request.superseded_by,
                    now
                ],
            )
            .map_err(database_error)?;
        if previous.as_ref().is_some_and(|previous| {
            previous.0 != request.task_id || previous.1 != request.content.trim()
        }) {
            transaction
                .execute("DELETE FROM memory_vectors WHERE memory_id = ?1", [&id])
                .map_err(database_error)?;
            transaction
                .execute("DELETE FROM memory_embeddings WHERE memory_id = ?1", [&id])
                .map_err(database_error)?;
        }
        transaction.commit().map_err(database_error)?;
        memory_by_id(&connection, &id)?.ok_or_else(|| "The stored memory was not found".to_owned())
    }

    pub fn save_memory_embedding(
        &self,
        request: &SaveMemoryEmbeddingRequest,
    ) -> Result<(), String> {
        validate_embedding(request)?;
        let (_write_guard, mut connection) = self.write_connection()?;
        let task_id = connection
            .query_row(
                "SELECT task_id FROM memory_items WHERE id = ?1",
                [&request.memory_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()
            .map_err(database_error)?
            .ok_or_else(|| "The memory record was not found".to_owned())?;
        let bytes = vector_bytes(&request.vector);
        let scope_key = task_id.unwrap_or_else(|| "project".to_owned());
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(database_error)?;
        transaction
            .execute(
                "INSERT INTO memory_embeddings
                 (memory_id, model, dimensions, normalized, format_version, embedding, updated_at)
                 VALUES (?1, ?2, ?3, 1, 1, ?4, ?5)
                 ON CONFLICT(memory_id) DO UPDATE SET
                    model = excluded.model,
                    dimensions = excluded.dimensions,
                    normalized = excluded.normalized,
                    format_version = excluded.format_version,
                    embedding = excluded.embedding,
                    updated_at = excluded.updated_at",
                params![
                    request.memory_id,
                    request.model.trim(),
                    MEMORY_EMBEDDING_DIMENSIONS as i64,
                    bytes,
                    now_millis()?
                ],
            )
            .map_err(database_error)?;
        transaction
            .execute(
                "DELETE FROM memory_vectors WHERE memory_id = ?1",
                [&request.memory_id],
            )
            .map_err(database_error)?;
        transaction
            .execute(
                "INSERT INTO memory_vectors (memory_id, embedding, scope_key)
                 VALUES (?1, ?2, ?3)",
                params![request.memory_id, vector_bytes(&request.vector), scope_key],
            )
            .map_err(database_error)?;
        transaction.commit().map_err(database_error)
    }

    /// Memories whose vector is missing, so hybrid search has silently degraded to lexical only.
    ///
    /// A vector is absent when the embedding worker was unavailable while the memory was stored,
    /// or when `upsert_memory` invalidated it after a content or scope change. Nothing else
    /// regenerates one, so maintenance uses this to re-embed them.
    pub fn memories_missing_embeddings(&self, limit: usize) -> Result<Vec<MemoryRecord>, String> {
        let connection = self.connection()?;
        let mut statement = connection
            .prepare(
                "SELECT m.id FROM memory_items m
                 LEFT JOIN memory_embeddings e ON e.memory_id = m.id
                 WHERE e.memory_id IS NULL
                 ORDER BY m.updated_at DESC
                 LIMIT ?1",
            )
            .map_err(database_error)?;
        let ids = statement
            .query_map([limit as i64], |row| row.get::<_, String>(0))
            .map_err(database_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(database_error)?;
        drop(statement);
        let mut records = Vec::with_capacity(ids.len());
        for id in ids {
            if let Some(record) = memory_by_id(&connection, &id)? {
                records.push(record);
            }
        }
        Ok(records)
    }

    pub fn search_memory(
        &self,
        request: &SearchMemoryRequest,
    ) -> Result<Vec<MemorySearchResult>, String> {
        let limit = request.limit.unwrap_or(10).clamp(1, 50);
        if request.query.trim().is_empty() && request.vector.is_none() {
            return Err("Memory search requires text or a query vector".to_owned());
        }
        if let Some(vector) = &request.vector {
            validate_vector(vector)?;
        }
        let connection = self.connection()?;
        if let Some(task_id) = &request.task_id {
            require_task(&connection, task_id)?;
        }
        let mut scores = HashMap::<String, SearchScore>::new();
        let fts_query = fts_query(&request.query);
        if !fts_query.is_empty() {
            let mut statement = connection
                .prepare(
                    "SELECT m.id
                     FROM memory_fts
                     JOIN memory_items m ON m.rowid = memory_fts.rowid
                     WHERE memory_fts MATCH ?1
                       AND m.state = 'confirmed'
                       AND (m.task_id IS NULL OR m.task_id = ?2)
                     ORDER BY bm25(memory_fts)
                     LIMIT ?3",
                )
                .map_err(database_error)?;
            for (rank, id) in statement
                .query_map(
                    params![fts_query, request.task_id, (limit * 4) as i64],
                    |row| row.get::<_, String>(0),
                )
                .map_err(database_error)?
                .enumerate()
            {
                scores
                    .entry(id.map_err(database_error)?)
                    .or_default()
                    .text_rank = Some(rank + 1);
            }
        }
        if let Some(vector) = &request.vector {
            let scopes = match &request.task_id {
                Some(task_id) => vec!["project".to_owned(), task_id.clone()],
                None => vec!["project".to_owned()],
            };
            let query_bytes = vector_bytes(vector);
            let mut vector_rank = 1;
            for scope in scopes {
                let mut statement = connection
                    .prepare(
                        "SELECT memory_id, distance FROM memory_vectors
                         WHERE embedding MATCH ?1 AND k = ?2 AND scope_key = ?3
                         ORDER BY distance",
                    )
                    .map_err(database_error)?;
                let matches = statement
                    .query_map(params![query_bytes, (limit * 4) as i64, scope], |row| {
                        Ok((row.get::<_, String>(0)?, row.get::<_, f64>(1)?))
                    })
                    .map_err(database_error)?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(database_error)?;
                for (id, distance) in matches {
                    let score = scores.entry(id).or_default();
                    score.vector_rank = Some(vector_rank);
                    score.vector_distance = Some(distance);
                    vector_rank += 1;
                }
            }
        }
        let mut results = scores
            .into_iter()
            .filter_map(|(id, ranks)| {
                let memory = memory_by_id(&connection, &id).ok().flatten()?;
                if memory.state != "confirmed"
                    || (memory.task_id.is_some() && memory.task_id != request.task_id)
                {
                    return None;
                }
                let score = ranks.text_rank.map_or(0.0, reciprocal_rank)
                    + ranks.vector_rank.map_or(0.0, reciprocal_rank);
                Some(MemorySearchResult {
                    memory,
                    score,
                    text_rank: ranks.text_rank,
                    vector_distance: ranks.vector_distance,
                })
            })
            .collect::<Vec<_>>();
        results.sort_by(|left, right| right.score.total_cmp(&left.score));
        results.truncate(limit);
        Ok(results)
    }

    pub fn save_attachment(
        &self,
        attachment: &StoredAttachment,
        bytes: &[u8],
    ) -> Result<(), String> {
        validate_attachment(attachment)?;
        if bytes.len() as u64 != attachment.size {
            return Err("The attachment size does not match its contents".to_owned());
        }
        let hash = Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let path = self.blob_path(&hash);
        let parent = path
            .parent()
            .ok_or_else(|| "The blob path has no parent".to_owned())?;
        fs::create_dir_all(parent)
            .map_err(|error| format!("Could not create {}: {error}", parent.display()))?;
        if !path.exists() {
            let temporary = parent.join(format!(".{}.tmp", Uuid::now_v7()));
            fs::write(&temporary, bytes)
                .map_err(|error| format!("Could not save {}: {error}", temporary.display()))?;
            match fs::rename(&temporary, &path) {
                Ok(()) => {}
                Err(_) if path.exists() => {
                    let _ = fs::remove_file(&temporary);
                }
                Err(error) => return Err(format!("Could not store {}: {error}", path.display())),
            }
        }
        let (_write_guard, connection) = self.write_connection()?;
        let existing = connection
            .query_row(
                "SELECT content_hash, name, mime_type, size FROM attachments WHERE id = ?1",
                [&attachment.id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, i64>(3)?,
                    ))
                },
            )
            .optional()
            .map_err(database_error)?;
        if let Some(existing) = existing {
            if existing.0 == hash
                && existing.1 == attachment.name
                && existing.2 == attachment.mime_type
                && u64::try_from(existing.3).ok() == Some(attachment.size)
            {
                return Ok(());
            }
            return Err("The attachment ID is already used by different content".to_owned());
        }
        connection
            .execute(
                "INSERT INTO attachments (id, content_hash, name, mime_type, size, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    attachment.id,
                    hash,
                    attachment.name,
                    attachment.mime_type,
                    to_database_integer(attachment.size, "attachment size")?,
                    now_millis()?
                ],
            )
            .map_err(database_error)?;
        Ok(())
    }

    pub fn read_attachment(&self, attachment: &StoredAttachment) -> Result<Vec<u8>, String> {
        let connection = self.connection()?;
        let stored = connection
            .query_row(
                "SELECT content_hash, name, mime_type, size FROM attachments WHERE id = ?1",
                [&attachment.id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, i64>(3)?,
                    ))
                },
            )
            .optional()
            .map_err(database_error)?
            .ok_or_else(|| format!("Attachment '{}' was not found", attachment.name))?;
        if stored.1 != attachment.name
            || stored.2 != attachment.mime_type
            || u64::try_from(stored.3).ok() != Some(attachment.size)
        {
            return Err(format!(
                "Attachment metadata does not match: {}",
                attachment.name
            ));
        }
        let bytes = fs::read(self.blob_path(&stored.0))
            .map_err(|error| format!("Could not read attachment {}: {error}", attachment.name))?;
        if bytes.len() as u64 != attachment.size {
            return Err(format!(
                "The stored attachment size is invalid: {}",
                attachment.name
            ));
        }
        let actual_hash = Sha256::digest(&bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        if actual_hash != stored.0 {
            return Err(format!(
                "The stored attachment contents are invalid: {}",
                attachment.name
            ));
        }
        Ok(bytes)
    }

    pub fn import_legacy_attachment(
        &self,
        legacy_directory: &Path,
        attachment: &StoredAttachment,
    ) -> Result<(), String> {
        let path = legacy_directory.join(&attachment.id);
        let bytes = fs::read(&path)
            .map_err(|error| format!("Could not import {}: {error}", path.display()))?;
        self.save_attachment(attachment, &bytes)
    }

    pub fn create_backup(&self) -> Result<BackupResult, String> {
        let _write_guard = self.write_lock()?;
        let created_at = now_millis()?;
        let backup_root = self.data_root.join("backups").join(&self.project_id);
        fs::create_dir_all(&backup_root)
            .map_err(|error| format!("Could not create {}: {error}", backup_root.display()))?;
        let destination = backup_root.join(format!("{created_at}-{}", Uuid::now_v7()));
        fs::create_dir(&destination)
            .map_err(|error| format!("Could not create {}: {error}", destination.display()))?;
        let database = destination.join(PROJECT_DATABASE_FILE_NAME);
        self.connection()?
            .execute("VACUUM INTO ?1", [database.to_string_lossy().as_ref()])
            .map_err(database_error)?;
        for directory in ["blobs", "logs"] {
            let source = self.project_directory().join(directory);
            if source.is_dir() {
                copy_directory(&source, &destination.join(directory))?;
            }
        }
        let manifest = serde_json::json!({
            "version": 1,
            "projectId": self.project_id,
            "workspacePath": self.workspace_path,
            "createdAt": created_at
        });
        fs::write(
            destination.join("manifest.json"),
            serde_json::to_vec_pretty(&manifest).map_err(|error| error.to_string())?,
        )
        .map_err(|error| format!("Could not write backup manifest: {error}"))?;
        Ok(BackupResult {
            path: destination.to_string_lossy().into_owned(),
            created_at: from_database_u64(created_at, "backup creation time")?,
        })
    }

    pub fn run_maintenance(&self) -> Result<MaintenanceResult, String> {
        let _write_guard = self.write_lock()?;
        let now = now_millis()?;
        let attachment_cutoff = now.saturating_sub(24 * 60 * 60 * 1_000);
        let log_cutoff = now.saturating_sub(30 * 24 * 60 * 60 * 1_000);
        let mut connection = self.connection()?;
        let mut orphan_statement = connection
            .prepare(
                "SELECT a.id, a.content_hash FROM attachments a
                 LEFT JOIN message_attachments ma ON ma.attachment_id = a.id
                 WHERE ma.attachment_id IS NULL AND a.created_at < ?1",
            )
            .map_err(database_error)?;
        let orphaned = orphan_statement
            .query_map([attachment_cutoff], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(database_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(database_error)?;
        drop(orphan_statement);
        let mut old_runs_statement = connection
            .prepare("SELECT id FROM godot_runs WHERE ended_at IS NOT NULL AND ended_at < ?1")
            .map_err(database_error)?;
        let old_runs = old_runs_statement
            .query_map([log_cutoff], |row| row.get::<_, String>(0))
            .map_err(database_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(database_error)?;
        drop(old_runs_statement);
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(database_error)?;
        for (id, _) in &orphaned {
            transaction
                .execute("DELETE FROM attachments WHERE id = ?1", [id])
                .map_err(database_error)?;
        }
        for run_id in &old_runs {
            transaction
                .execute("DELETE FROM godot_runs WHERE id = ?1", [run_id])
                .map_err(database_error)?;
        }
        transaction.commit().map_err(database_error)?;
        let mut blobs_removed = 0;
        for (_, hash) in &orphaned {
            let references: i64 = connection
                .query_row(
                    "SELECT COUNT(*) FROM attachments WHERE content_hash = ?1",
                    [hash],
                    |row| row.get(0),
                )
                .map_err(database_error)?;
            if references == 0 && fs::remove_file(self.blob_path(hash)).is_ok() {
                blobs_removed += 1;
            }
        }
        for run_id in &old_runs {
            let path = self.project_directory().join("logs").join(run_id);
            if path.is_dir() {
                fs::remove_dir_all(&path)
                    .map_err(|error| format!("Could not remove {}: {error}", path.display()))?;
            }
        }
        let backups_removed =
            prune_backups(&self.data_root.join("backups").join(&self.project_id), 5)?;
        Ok(MaintenanceResult {
            attachments_removed: orphaned.len(),
            blobs_removed,
            godot_runs_removed: old_runs.len(),
            backups_removed,
            // Re-embedding needs the memory worker, so the caller fills this in.
            memory_embeddings_restored: 0,
        })
    }

    fn connection(&self) -> Result<Connection, String> {
        open_connection(&self.project_directory().join(PROJECT_DATABASE_FILE_NAME))
    }

    fn write_connection(&self) -> Result<(MutexGuard<'_, ()>, Connection), String> {
        let guard = self.write_lock()?;
        let connection = self.connection()?;
        Ok((guard, connection))
    }

    fn write_lock(&self) -> Result<MutexGuard<'_, ()>, String> {
        self.write_lock
            .lock()
            .map_err(|_| "The project storage write lock is poisoned".to_owned())
    }

    fn ensure_active_task(&self, connection: &Connection) -> Result<String, String> {
        if let Some(task_id) = active_task_id(connection)? {
            return Ok(task_id);
        }
        self.create_task()?
            .task_id
            .ok_or_else(|| "The new task has no ID".to_owned())
    }

    fn project_directory(&self) -> PathBuf {
        self.data_root
            .join(PROJECTS_DIRECTORY)
            .join(&self.project_id)
    }

    fn blob_path(&self, hash: &str) -> PathBuf {
        self.project_directory()
            .join("blobs")
            .join("sha256")
            .join(&hash[..2])
            .join(hash)
    }
}

fn copy_directory(source: &Path, destination: &Path) -> Result<(), String> {
    fs::create_dir_all(destination)
        .map_err(|error| format!("Could not create {}: {error}", destination.display()))?;
    for entry in fs::read_dir(source)
        .map_err(|error| format!("Could not read {}: {error}", source.display()))?
    {
        let entry = entry.map_err(|error| format!("Could not read directory entry: {error}"))?;
        let file_type = entry.file_type().map_err(|error| error.to_string())?;
        let target = destination.join(entry.file_name());
        if file_type.is_dir() {
            copy_directory(&entry.path(), &target)?;
        } else if file_type.is_file() {
            fs::copy(entry.path(), &target)
                .map_err(|error| format!("Could not copy {}: {error}", entry.path().display()))?;
        }
    }
    Ok(())
}

fn prune_backups(path: &Path, keep: usize) -> Result<usize, String> {
    if !path.is_dir() {
        return Ok(0);
    }
    let mut directories = fs::read_dir(path)
        .map_err(|error| format!("Could not read {}: {error}", path.display()))?
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .collect::<Vec<_>>();
    directories.sort_by_key(|entry| std::cmp::Reverse(entry.file_name()));
    let mut removed = 0;
    for entry in directories.into_iter().skip(keep) {
        fs::remove_dir_all(entry.path())
            .map_err(|error| format!("Could not remove {}: {error}", entry.path().display()))?;
        removed += 1;
    }
    Ok(removed)
}

fn open_connection(path: &Path) -> Result<Connection, String> {
    register_sqlite_vec();
    let connection = Connection::open(path)
        .map_err(|error| format!("Could not open {}: {error}", path.display()))?;
    connection
        .execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA foreign_keys = ON;
             PRAGMA busy_timeout = 5000;
             PRAGMA synchronous = NORMAL;",
        )
        .map_err(database_error)?;
    Ok(connection)
}

fn register_sqlite_vec() {
    SQLITE_VEC_REGISTRATION.call_once(|| unsafe {
        rusqlite::ffi::sqlite3_auto_extension(Some(std::mem::transmute::<
            *const (),
            rusqlite::auto_extension::RawAutoExtension,
        >(
            sqlite_vec::sqlite3_vec_init as *const ()
        )));
    });
}

fn migrate_project(connection: &Connection) -> Result<(), String> {
    let current = connection
        .query_row("PRAGMA user_version", [], |row| row.get::<_, u32>(0))
        .map_err(database_error)?;
    if current > 4 {
        return Err(format!(
            "The database schema version {current} is newer than supported version 4"
        ));
    }
    if current == 0 {
        connection
            .execute_batch(PROJECT_SCHEMA_V1)
            .map_err(database_error)?;
    }
    if current <= 1 {
        connection
            .execute_batch(PROJECT_SCHEMA_V2)
            .map_err(database_error)?;
    }
    if current <= 2 {
        connection
            .execute_batch(PROJECT_SCHEMA_V3)
            .map_err(database_error)?;
    }
    if current <= 3 {
        connection
            .execute_batch(PROJECT_SCHEMA_V4)
            .map_err(database_error)?;
    }
    Ok(())
}

fn migrate(connection: &Connection, schema: &str, version: u32) -> Result<(), String> {
    let current = connection
        .query_row("PRAGMA user_version", [], |row| row.get::<_, u32>(0))
        .map_err(database_error)?;
    if current > version {
        return Err(format!(
            "The database schema version {current} is newer than supported version {version}"
        ));
    }
    if current < version {
        connection.execute_batch(schema).map_err(database_error)?;
    }
    Ok(())
}

fn active_task_id(connection: &Connection) -> Result<Option<String>, String> {
    connection
        .query_row(
            "SELECT value FROM project_state WHERE key = 'active_task_id'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(database_error)
}

fn set_active_task(connection: &Connection, task_id: &str) -> Result<(), String> {
    connection
        .execute(
            "INSERT INTO project_state (key, value) VALUES ('active_task_id', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [task_id],
        )
        .map_err(database_error)?;
    Ok(())
}

fn require_task(connection: &Connection, task_id: &str) -> Result<(), String> {
    let exists = connection
        .query_row("SELECT 1 FROM tasks WHERE id = ?1", [task_id], |_| Ok(()))
        .optional()
        .map_err(database_error)?
        .is_some();
    if !exists {
        return Err("The task was not found".to_owned());
    }
    Ok(())
}

fn validate_log_entries(entries: &[GodotLogEntry]) -> Result<(), String> {
    if entries.is_empty() || entries.len() > 10_000 {
        return Err("A Godot log batch must contain between 1 and 10,000 entries".to_owned());
    }
    let mut total_bytes = 0_usize;
    for entry in entries {
        if !["debug", "info", "warning", "error"].contains(&entry.level.as_str()) {
            return Err("A Godot log entry has an invalid level".to_owned());
        }
        if entry.message.trim().is_empty() {
            return Err("Godot log messages cannot be empty".to_owned());
        }
        if entry.message.len() > 1024 * 1024 {
            return Err("Individual Godot log messages cannot exceed 1 MiB".to_owned());
        }
        total_bytes = total_bytes
            .saturating_add(entry.message.len())
            .saturating_add(entry.source.as_ref().map_or(0, String::len))
            .saturating_add(entry.stack_trace.as_ref().map_or(0, String::len));
    }
    if total_bytes > 8 * 1024 * 1024 {
        return Err("A Godot log batch cannot exceed 8 MiB".to_owned());
    }
    Ok(())
}

fn validate_memory(request: &UpsertMemoryRequest) -> Result<(), String> {
    if !["decision", "preference", "fact", "issue", "summary"].contains(&request.kind.as_str()) {
        return Err("The memory kind is invalid".to_owned());
    }
    if !["candidate", "confirmed", "superseded"].contains(&request.state.as_str()) {
        return Err("The memory state is invalid".to_owned());
    }
    if request.content.trim().is_empty() {
        return Err("Memory content cannot be empty".to_owned());
    }
    if request.content.len() > 64 * 1024 {
        return Err("Memory content cannot exceed 64 KiB".to_owned());
    }
    if !request.provenance.is_object() {
        return Err("Memory provenance must be an object".to_owned());
    }
    if request.provenance.to_string().len() > 256 * 1024 {
        return Err("Memory provenance cannot exceed 256 KiB".to_owned());
    }
    Ok(())
}

fn validate_embedding(request: &SaveMemoryEmbeddingRequest) -> Result<(), String> {
    if request.model.trim() != MEMORY_EMBEDDING_MODEL {
        return Err(format!(
            "Memory embeddings must use {MEMORY_EMBEDDING_MODEL}"
        ));
    }
    validate_vector(&request.vector)
}

fn validate_vector(vector: &[f32]) -> Result<(), String> {
    if vector.len() != MEMORY_EMBEDDING_DIMENSIONS {
        return Err(format!(
            "Memory vectors must contain {MEMORY_EMBEDDING_DIMENSIONS} dimensions"
        ));
    }
    if vector.iter().any(|value| !value.is_finite()) {
        return Err("Memory vectors must contain only finite numbers".to_owned());
    }
    let magnitude = vector
        .iter()
        .map(|value| f64::from(*value) * f64::from(*value))
        .sum::<f64>()
        .sqrt();
    if (magnitude - 1.0).abs() > 0.01 {
        return Err("Memory vectors must be normalized".to_owned());
    }
    Ok(())
}

fn vector_bytes(vector: &[f32]) -> Vec<u8> {
    vector
        .iter()
        .flat_map(|value| value.to_ne_bytes())
        .collect()
}

fn fts_query(query: &str) -> String {
    query
        .split(|character: char| !character.is_alphanumeric() && character != '_')
        .filter(|token| !token.is_empty())
        .map(|token| format!("\"{}\"", token.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" OR ")
}

fn reciprocal_rank(rank: usize) -> f64 {
    1.0 / (60.0 + rank as f64)
}

fn memory_by_id(connection: &Connection, id: &str) -> Result<Option<MemoryRecord>, String> {
    let row = connection
        .query_row(
            "SELECT id, task_id, kind, state, content, provenance_json,
                    superseded_by, created_at, updated_at
             FROM memory_items WHERE id = ?1",
            [id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, i64>(7)?,
                    row.get::<_, i64>(8)?,
                ))
            },
        )
        .optional()
        .map_err(database_error)?;
    row.map(|row| {
        Ok(MemoryRecord {
            id: row.0,
            task_id: row.1,
            kind: row.2,
            state: row.3,
            content: row.4,
            provenance: serde_json::from_str(&row.5)
                .map_err(|error| format!("Stored memory provenance is invalid: {error}"))?,
            superseded_by: row.6,
            created_at: from_database_u64(row.7, "memory creation time")?,
            updated_at: from_database_u64(row.8, "memory update time")?,
        })
    })
    .transpose()
}

fn empty_object() -> Value {
    serde_json::json!({})
}

fn validate_chat(chat: &StoredChat) -> Result<(), String> {
    if chat.messages.len() > MAX_STORED_CHAT_MESSAGES {
        return Err(format!(
            "Stored chats cannot contain more than {MAX_STORED_CHAT_MESSAGES} messages"
        ));
    }
    let serialized_size = serde_json::to_vec(chat)
        .map_err(|_| "Stored chat data is invalid".to_owned())?
        .len();
    if serialized_size > MAX_STORED_CHAT_BYTES {
        return Err("Stored chat data cannot exceed 32 MiB".to_owned());
    }
    for message in &chat.messages {
        if message.sender != "user" && message.sender != "assistant" {
            return Err("Stored chat messages have an invalid sender".to_owned());
        }
        if message.text.len() > MAX_STORED_MESSAGE_BYTES {
            return Err("Stored chat messages cannot exceed 1 MiB".to_owned());
        }
        if message.attachments.len() > 5 {
            return Err("Stored chat messages cannot contain more than 5 images".to_owned());
        }
        for attachment in &message.attachments {
            validate_attachment(attachment)?;
        }
    }
    Ok(())
}

pub fn validate_attachment(attachment: &StoredAttachment) -> Result<(), String> {
    if attachment.id.is_empty()
        || attachment.id.len() > 64
        || !attachment
            .id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-')
    {
        return Err("The attachment ID is invalid".to_owned());
    }
    if attachment.name.trim().is_empty() || attachment.name.len() > 255 {
        return Err("Attachment names must contain between 1 and 255 bytes".to_owned());
    }
    if attachment.size == 0 || attachment.size > 10 * 1024 * 1024 {
        return Err("Images must be between 1 byte and 10 MiB".to_owned());
    }
    if !["image/png", "image/jpeg", "image/webp", "image/gif"]
        .contains(&attachment.mime_type.as_str())
    {
        return Err("Only PNG, JPEG, WebP, and GIF images are supported".to_owned());
    }
    Ok(())
}

fn now_millis() -> Result<i64, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("The system clock is invalid: {error}"))
        .and_then(|duration| {
            i64::try_from(duration.as_millis())
                .map_err(|_| "The current timestamp is too large to store".to_owned())
        })
}

fn to_database_integer(value: u64, name: &str) -> Result<i64, String> {
    i64::try_from(value).map_err(|_| format!("The {name} is too large to store"))
}

fn from_database_u64(value: i64, name: &str) -> Result<u64, String> {
    u64::try_from(value).map_err(|_| format!("The stored {name} is invalid"))
}

fn database_error(error: rusqlite::Error) -> String {
    format!("The Gofer database operation failed: {error}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn attachment(id: &str) -> StoredAttachment {
        StoredAttachment {
            id: id.to_owned(),
            name: "scene.png".to_owned(),
            mime_type: "image/png".to_owned(),
            size: 2,
        }
    }

    fn storage(directory: &TempDir) -> ProjectStorage {
        let workspace = directory.path().join("workspace");
        fs::create_dir(&workspace).expect("workspace directory");
        ProjectStorage::open(&directory.path().join("data"), &workspace).expect("storage")
    }

    #[test]
    fn chat_and_content_addressed_attachments_round_trip() {
        let directory = TempDir::new().expect("temporary directory");
        let storage = storage(&directory);
        let attachment = attachment("018f47aa-09d2-7b34-a2d3-8c4e6f123456");
        storage
            .save_attachment(&attachment, b"hi")
            .expect("save attachment");
        let chat = StoredChat {
            task_id: None,
            messages: vec![StoredMessage {
                id: 1,
                sender: "user".to_owned(),
                text: "Look".to_owned(),
                timestamp: 10,
                attachments: vec![attachment.clone()],
                extra: serde_json::Map::new(),
            }],
            agent_messages: vec![serde_json::json!({"role": "user"})],
        };

        storage.save_chat(&chat).expect("save chat");

        let loaded = storage.load_chat().expect("load chat");
        assert_eq!(loaded.messages.len(), 1);
        assert_eq!(loaded.messages[0].text, "Look");
        assert_eq!(loaded.agent_messages.len(), 1);
        assert_eq!(
            storage
                .read_attachment(&attachment)
                .expect("read attachment"),
            b"hi"
        );
    }

    #[test]
    fn cloned_storage_serializes_writes() {
        let directory = TempDir::new().expect("temporary storage");
        let storage = storage(&directory);
        let chat = storage.load_chat().expect("active chat");
        let clone = storage.clone();
        assert!(Arc::ptr_eq(&storage.write_lock, &clone.write_lock));

        let guard = storage.write_lock().expect("write lock");
        let (started_sender, started_receiver) = std::sync::mpsc::channel();
        let (result_sender, result_receiver) = std::sync::mpsc::channel();
        let writer = std::thread::spawn(move || {
            started_sender.send(()).expect("signal writer start");
            result_sender
                .send(clone.save_chat(&chat))
                .expect("send write result");
        });
        started_receiver.recv().expect("writer started");
        assert!(matches!(
            result_receiver.recv_timeout(std::time::Duration::from_millis(100)),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout)
        ));

        drop(guard);
        result_receiver
            .recv_timeout(std::time::Duration::from_secs(5))
            .expect("writer completed")
            .expect("save chat");
        writer.join().expect("writer thread");
    }

    #[test]
    fn stored_chat_and_attachment_metadata_are_bounded() {
        let oversized = StoredChat {
            task_id: None,
            messages: vec![StoredMessage {
                id: 1,
                sender: "user".to_owned(),
                text: "x".repeat(MAX_STORED_MESSAGE_BYTES + 1),
                timestamp: 1,
                attachments: Vec::new(),
                extra: serde_json::Map::new(),
            }],
            agent_messages: Vec::new(),
        };
        assert!(validate_chat(&oversized).unwrap_err().contains("1 MiB"));

        let mut invalid_attachment = attachment(&"a".repeat(65));
        assert!(validate_attachment(&invalid_attachment).is_err());
        invalid_attachment.id = "valid-id".to_owned();
        invalid_attachment.name = "x".repeat(256);
        assert!(validate_attachment(&invalid_attachment).is_err());
    }

    #[test]
    fn validation_covers_every_storage_boundary_branch() {
        let valid_log = GodotLogEntry {
            timestamp: 1,
            level: "info".to_owned(),
            message: "started".to_owned(),
            source: Some("stdout".to_owned()),
            stack_trace: None,
        };
        assert!(validate_log_entries(std::slice::from_ref(&valid_log)).is_ok());
        assert!(validate_log_entries(&[]).is_err());
        for entry in [
            GodotLogEntry {
                level: "fatal".to_owned(),
                ..valid_log.clone()
            },
            GodotLogEntry {
                message: " ".to_owned(),
                ..valid_log.clone()
            },
            GodotLogEntry {
                message: "x".repeat(1_024 * 1_024 + 1),
                ..valid_log.clone()
            },
        ] {
            assert!(validate_log_entries(&[entry]).is_err());
        }

        let valid_memory = UpsertMemoryRequest {
            id: None,
            task_id: None,
            kind: "fact".to_owned(),
            state: "confirmed".to_owned(),
            content: "Godot uses scenes".to_owned(),
            provenance: serde_json::json!({"source": "test"}),
            superseded_by: None,
        };
        assert!(validate_memory(&valid_memory).is_ok());
        for memory in [
            UpsertMemoryRequest {
                kind: "unknown".to_owned(),
                ..valid_memory.clone()
            },
            UpsertMemoryRequest {
                state: "unknown".to_owned(),
                ..valid_memory.clone()
            },
            UpsertMemoryRequest {
                content: " ".to_owned(),
                ..valid_memory.clone()
            },
            UpsertMemoryRequest {
                content: "x".repeat(64 * 1_024 + 1),
                ..valid_memory.clone()
            },
            UpsertMemoryRequest {
                provenance: serde_json::json!([]),
                ..valid_memory.clone()
            },
        ] {
            assert!(validate_memory(&memory).is_err());
        }

        let mut vector = vec![0.0; MEMORY_EMBEDDING_DIMENSIONS];
        vector[0] = 1.0;
        assert!(validate_vector(&vector).is_ok());
        assert!(validate_vector(&vector[..10]).is_err());
        let mut non_finite = vector.clone();
        non_finite[0] = f32::NAN;
        assert!(validate_vector(&non_finite).is_err());
        let zero = vec![0.0; MEMORY_EMBEDDING_DIMENSIONS];
        assert!(validate_vector(&zero).is_err());
        assert!(
            validate_embedding(&SaveMemoryEmbeddingRequest {
                memory_id: "memory".to_owned(),
                model: "wrong-model".to_owned(),
                vector,
            })
            .is_err()
        );

        let valid_attachment = attachment("valid-id");
        for invalid in [
            StoredAttachment {
                id: String::new(),
                ..valid_attachment.clone()
            },
            StoredAttachment {
                id: "bad/id".to_owned(),
                ..valid_attachment.clone()
            },
            StoredAttachment {
                name: " ".to_owned(),
                ..valid_attachment.clone()
            },
            StoredAttachment {
                size: 0,
                ..valid_attachment.clone()
            },
            StoredAttachment {
                size: 10 * 1_024 * 1_024 + 1,
                ..valid_attachment.clone()
            },
            StoredAttachment {
                mime_type: "application/pdf".to_owned(),
                ..valid_attachment.clone()
            },
        ] {
            assert!(validate_attachment(&invalid).is_err());
        }

        let invalid_sender = StoredChat {
            task_id: None,
            messages: vec![StoredMessage {
                id: 1,
                sender: "system".to_owned(),
                text: String::new(),
                timestamp: 1,
                attachments: Vec::new(),
                extra: serde_json::Map::new(),
            }],
            agent_messages: Vec::new(),
        };
        assert!(validate_chat(&invalid_sender).is_err());
        let mut too_many_attachments = invalid_sender;
        too_many_attachments.messages[0].sender = "user".to_owned();
        too_many_attachments.messages[0].attachments = vec![valid_attachment; 6];
        assert!(validate_chat(&too_many_attachments).is_err());
    }

    #[test]
    fn storage_operations_cover_invalid_state_and_conflict_branches() {
        let directory = TempDir::new().expect("temporary directory");
        let storage = storage(&directory);
        let workspace = storage.agent_workspace().expect("agent workspace");
        assert!(
            storage
                .start_godot_run_in(
                    &StartGodotRunRequest {
                        task_id: None,
                        session_id: None,
                        godot_version: None,
                        metadata: serde_json::json!([]),
                    },
                    &workspace,
                )
                .is_err()
        );
        assert!(
            storage
                .finish_godot_run(&FinishGodotRunRequest {
                    run_id: "missing".to_owned(),
                    status: "running".to_owned(),
                    exit_code: None,
                })
                .is_err()
        );
        assert!(
            storage
                .finish_godot_run(&FinishGodotRunRequest {
                    run_id: "missing".to_owned(),
                    status: "failed".to_owned(),
                    exit_code: None,
                })
                .is_err()
        );
        assert!(
            storage
                .search_memory(&SearchMemoryRequest {
                    query: " ".to_owned(),
                    task_id: None,
                    vector: None,
                    limit: None,
                })
                .is_err()
        );

        let stored = attachment("conflict-id");
        assert!(storage.save_attachment(&stored, b"x").is_err());
        storage
            .save_attachment(&stored, b"hi")
            .expect("save attachment");
        storage
            .save_attachment(&stored, b"hi")
            .expect("idempotent attachment save");
        let renamed = StoredAttachment {
            name: "other.png".to_owned(),
            ..stored.clone()
        };
        assert!(storage.save_attachment(&renamed, b"hi").is_err());
        assert!(storage.read_attachment(&renamed).is_err());

        let mut vector = vec![0.0; MEMORY_EMBEDDING_DIMENSIONS];
        vector[0] = 1.0;
        assert!(
            storage
                .search_memory(&SearchMemoryRequest {
                    query: String::new(),
                    task_id: None,
                    vector: Some(vector),
                    limit: Some(1),
                })
                .expect("empty vector search")
                .is_empty()
        );
    }

    #[test]
    fn active_task_workspace_fails_instead_of_falling_back_to_root_workspace() {
        let directory = TempDir::new().expect("temporary directory");
        let storage = storage(&directory);

        // `ProjectStorage::open` ensures an active task exists, but the plain test workspace is
        // not a Git repository so the task has no isolated worktree.
        assert!(
            storage
                .active_task_workspace()
                .unwrap_err()
                .contains("isolated Git worktree"),
            "active_task_workspace must fail rather than fall back"
        );

        // `agent_workspace` still falls back to the root workspace for existing UI paths.
        assert!(storage.agent_workspace().is_ok());
    }

    #[test]
    fn projects_and_new_tasks_are_isolated() {
        let directory = TempDir::new().expect("temporary directory");
        let storage = storage(&directory);
        storage
            .save_chat(&StoredChat {
                task_id: None,
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

        let previous = storage.load_chat().expect("first task");
        let next = storage.create_task().expect("create task");
        storage.save_chat(&previous).expect("save completed task");

        assert!(next.messages.is_empty());
        assert!(
            storage
                .load_chat()
                .expect("active chat")
                .messages
                .is_empty()
        );
        let tasks = storage.list_tasks().expect("parallel tasks");
        assert_eq!(tasks.len(), 2);
        assert!(tasks.iter().all(|task| task.status == "active"));
        let previous_task_id = previous.task_id.expect("previous task ID");
        let restored = storage
            .activate_task(&previous_task_id)
            .expect("activate previous task");
        assert_eq!(restored.messages[0].text, "First task");
    }

    #[test]
    fn project_schema_registers_fts_and_static_vector_search() {
        let directory = TempDir::new().expect("temporary directory");
        let storage = storage(&directory);
        let connection = storage.connection().expect("connection");

        let version = connection
            .query_row("PRAGMA user_version", [], |row| row.get::<_, u32>(0))
            .expect("schema version");
        let vec_version = connection
            .query_row("SELECT vec_version()", [], |row| row.get::<_, String>(0))
            .expect("sqlite-vec version");

        assert_eq!(version, 4);
        assert_eq!(vec_version, "v0.1.9");
    }

    #[test]
    fn version_one_project_databases_migrate_without_losing_tasks() {
        register_sqlite_vec();
        let connection = Connection::open_in_memory().expect("in-memory database");
        connection
            .execute_batch(PROJECT_SCHEMA_V1)
            .expect("version one schema");
        connection
            .execute(
                "INSERT INTO tasks (id, title, status, created_at, updated_at)
                 VALUES ('task-1', 'Existing task', 'active', 1, 1)",
                [],
            )
            .expect("existing task");

        migrate_project(&connection).expect("migrate project");

        let title = connection
            .query_row("SELECT title FROM tasks WHERE id = 'task-1'", [], |row| {
                row.get::<_, String>(0)
            })
            .expect("migrated task");
        let version = connection
            .query_row("PRAGMA user_version", [], |row| row.get::<_, u32>(0))
            .expect("schema version");
        assert_eq!(title, "Existing task");
        assert_eq!(version, 4);
    }

    /// Run logging moved from the standalone Godot process to the managed editor session. The
    /// history recorded before that move has to stay exactly as searchable as it was, which is why
    /// the migration adds a column instead of rebuilding the table.
    #[test]
    fn recorded_run_history_survives_the_session_identifier_migration() {
        register_sqlite_vec();
        let connection = Connection::open_in_memory().expect("in-memory database");
        for schema in [PROJECT_SCHEMA_V1, PROJECT_SCHEMA_V2, PROJECT_SCHEMA_V3] {
            connection.execute_batch(schema).expect("earlier schema");
        }
        connection
            .execute(
                "INSERT INTO godot_runs (id, task_id, status, project_path, started_at)
                 VALUES ('run-1', NULL, 'completed', '/tmp/project', 1)",
                [],
            )
            .expect("existing run");
        connection
            .execute(
                "INSERT INTO godot_log_events (id, run_id, timestamp, level, source, message)
                 VALUES ('event-1', 'run-1', 2, 'error', NULL, 'Invalid call')",
                [],
            )
            .expect("existing log event");

        migrate_project(&connection).expect("migrate project");

        let (session_id, message) = connection
            .query_row(
                "SELECT session_id, (SELECT message FROM godot_log_events WHERE run_id = runs.id)
                 FROM godot_runs AS runs WHERE runs.id = 'run-1'",
                [],
                |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, String>(1)?)),
            )
            .expect("migrated run");
        assert!(session_id.is_none(), "a run predating sessions has none");
        assert_eq!(message, "Invalid call");
        let indexed = connection
            .query_row(
                "SELECT count(*) FROM godot_log_fts WHERE godot_log_fts MATCH 'Invalid'",
                [],
                |row| row.get::<_, u32>(0),
            )
            .expect("indexed history");
        assert_eq!(indexed, 1, "the full-text index must survive the migration");
    }

    #[test]
    fn task_titles_are_derived_from_the_first_message() {
        let directory = TempDir::new().expect("temporary directory");
        let storage = storage(&directory);
        storage
            .save_chat(&StoredChat {
                task_id: None,
                messages: vec![StoredMessage {
                    id: 1,
                    sender: "user".to_owned(),
                    text: "Build the player controller".to_owned(),
                    timestamp: 10,
                    attachments: Vec::new(),
                    extra: serde_json::Map::new(),
                }],
                agent_messages: Vec::new(),
            })
            .expect("save chat");
        let task = storage.list_tasks().expect("tasks").remove(0);

        assert_eq!(task.title, "Build the player controller");
        // A non-repository workspace records no worktree; git.rs covers the repository path.
        assert!(task.worktree.is_none());
    }

    #[test]
    fn godot_logs_are_compressed_and_important_events_are_indexed() {
        let directory = TempDir::new().expect("temporary directory");
        let storage = storage(&directory);
        let run = storage
            .start_godot_run(&StartGodotRunRequest {
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
            .append_godot_logs(&AppendGodotLogsRequest {
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

        // The stored history is what survives the editor that produced it, so a search names the
        // session as well as the run. A phrase the user typed carries FTS5 operators (`:` and `.`)
        // that would make a bare match expression fail, which is why the needle is quoted.
        let hits = storage
            .search_godot_logs(&SearchGodotLogsRequest {
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
                .search_godot_logs(&SearchGodotLogsRequest {
                    query: "  ".to_owned(),
                    limit: Some(10),
                })
                .is_err()
        );
        assert!(
            storage
                .search_godot_logs(&SearchGodotLogsRequest {
                    query: "player.gd:12 OR".to_owned(),
                    limit: Some(1),
                })
                .expect("an operator-looking phrase is a phrase")
                .is_empty()
        );

        storage
            .finish_godot_run(&FinishGodotRunRequest {
                run_id: run.id,
                status: "failed".to_owned(),
                exit_code: Some(1),
            })
            .expect("finish run");
    }

    #[test]
    fn memory_supports_hybrid_search_and_invalidates_stale_embeddings() {
        let directory = TempDir::new().expect("temporary directory");
        let storage = storage(&directory);
        let memory = storage
            .upsert_memory(&UpsertMemoryRequest {
                id: None,
                task_id: None,
                kind: "decision".to_owned(),
                state: "confirmed".to_owned(),
                content: "Use CharacterBody2D for the player controller".to_owned(),
                provenance: serde_json::json!({"source": "user"}),
                superseded_by: None,
            })
            .expect("save memory");
        let mut vector = vec![0.0; MEMORY_EMBEDDING_DIMENSIONS];
        vector[0] = 1.0;
        storage
            .save_memory_embedding(&SaveMemoryEmbeddingRequest {
                memory_id: memory.id.clone(),
                model: MEMORY_EMBEDDING_MODEL.to_owned(),
                vector: vector.clone(),
            })
            .expect("save embedding");

        let results = storage
            .search_memory(&SearchMemoryRequest {
                query: "CharacterBody2D player".to_owned(),
                task_id: None,
                vector: Some(vector),
                limit: Some(5),
            })
            .expect("search memory");

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].memory.id, memory.id);
        assert_eq!(results[0].text_rank, Some(1));
        assert_eq!(results[0].vector_distance, Some(0.0));

        storage
            .upsert_memory(&UpsertMemoryRequest {
                id: Some(memory.id.clone()),
                task_id: None,
                kind: "decision".to_owned(),
                state: "confirmed".to_owned(),
                content: "Use a custom Node for the player controller".to_owned(),
                provenance: serde_json::json!({"source": "user"}),
                superseded_by: None,
            })
            .expect("update memory");
        let connection = storage.connection().expect("connection");
        let embeddings = connection
            .query_row("SELECT count(*) FROM memory_embeddings", [], |row| {
                row.get::<_, u32>(0)
            })
            .expect("embedding count");
        assert_eq!(embeddings, 0);
    }

    #[test]
    fn memories_without_vectors_are_reported_and_deletions_clear_the_vector_index() {
        let directory = TempDir::new().expect("temporary directory");
        let storage = storage(&directory);
        let memory = storage
            .upsert_memory(&UpsertMemoryRequest {
                id: None,
                task_id: None,
                kind: "fact".to_owned(),
                state: "confirmed".to_owned(),
                content: "The player scene lives in scenes/player.tscn".to_owned(),
                provenance: serde_json::json!({"source": "user"}),
                superseded_by: None,
            })
            .expect("save memory");

        let pending = storage
            .memories_missing_embeddings(10)
            .expect("pending memories");
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].id, memory.id);
        assert_eq!(
            pending[0].content,
            "The player scene lives in scenes/player.tscn"
        );

        let mut vector = vec![0.0; MEMORY_EMBEDDING_DIMENSIONS];
        vector[0] = 1.0;
        storage
            .save_memory_embedding(&SaveMemoryEmbeddingRequest {
                memory_id: memory.id.clone(),
                model: MEMORY_EMBEDDING_MODEL.to_owned(),
                vector,
            })
            .expect("save embedding");
        assert!(
            storage
                .memories_missing_embeddings(10)
                .expect("pending memories")
                .is_empty()
        );

        // Rewriting the content invalidates the vector, which must make it pending again.
        storage
            .upsert_memory(&UpsertMemoryRequest {
                id: Some(memory.id.clone()),
                task_id: None,
                kind: "fact".to_owned(),
                state: "confirmed".to_owned(),
                content: "The player scene moved to scenes/actors/player.tscn".to_owned(),
                provenance: serde_json::json!({"source": "user"}),
                superseded_by: None,
            })
            .expect("update memory");
        assert_eq!(
            storage
                .memories_missing_embeddings(10)
                .expect("pending memories")
                .len(),
            1
        );

        let connection = storage.connection().expect("connection");
        connection
            .execute(
                "INSERT INTO memory_vectors (memory_id, embedding, scope_key)
                 VALUES (?1, ?2, 'project')",
                params![
                    memory.id,
                    vector_bytes(&vec![0.5; MEMORY_EMBEDDING_DIMENSIONS])
                ],
            )
            .expect("orphan vector");
        connection
            .execute("DELETE FROM memory_items WHERE id = ?1", [&memory.id])
            .expect("delete memory");
        let vectors = connection
            .query_row("SELECT count(*) FROM memory_vectors", [], |row| {
                row.get::<_, u32>(0)
            })
            .expect("vector count");
        assert_eq!(vectors, 0);
    }

    #[test]
    fn project_backup_contains_a_consistent_database_and_manifest() {
        let directory = TempDir::new().expect("temporary directory");
        let storage = storage(&directory);
        let backup = storage.create_backup().expect("create backup");
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

    /// A run's lifecycle is a state machine, and every transition out of it is refused by name.
    /// These are the answers the log viewer and the session supervisor read when something is
    /// already over: appending to a finished run and finishing it twice are both ordinary races,
    /// not programming errors, so they have to fail as data rather than corrupt the history.
    #[test]
    fn a_finished_godot_run_refuses_further_writes() {
        let directory = TempDir::new().expect("temporary directory");
        let storage = storage(&directory);
        let run = storage
            .start_godot_run(&StartGodotRunRequest {
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
                .finish_godot_run(&FinishGodotRunRequest {
                    run_id: run.id.clone(),
                    status: "exploded".to_owned(),
                    exit_code: None,
                })
                .unwrap_err()
                .contains("status is invalid"),
            "only the three terminal statuses may end a run"
        );
        storage
            .finish_godot_run(&FinishGodotRunRequest {
                run_id: run.id.clone(),
                status: "completed".to_owned(),
                exit_code: Some(0),
            })
            .expect("finish the run");

        assert!(
            storage
                .finish_godot_run(&FinishGodotRunRequest {
                    run_id: run.id.clone(),
                    status: "aborted".to_owned(),
                    exit_code: None,
                })
                .unwrap_err()
                .contains("was not found"),
            "a run only ends once: the second finish matches no running session"
        );
        assert!(
            storage
                .append_godot_logs(&AppendGodotLogsRequest {
                    run_id: run.id.clone(),
                    entries: vec![entry()],
                })
                .unwrap_err()
                .contains("running Godot session"),
            "output cannot arrive after the run that produced it ended"
        );
        assert!(
            storage
                .append_godot_logs(&AppendGodotLogsRequest {
                    run_id: "018f47aa-09d2-7b34-a2d3-8c4e6f123456".to_owned(),
                    entries: vec![entry()],
                })
                .unwrap_err()
                .contains("was not found")
        );
        assert!(
            storage
                .search_godot_logs(&SearchGodotLogsRequest {
                    query: "   ".to_owned(),
                    limit: None,
                })
                .unwrap_err()
                .contains("needs a query"),
            "a blank needle is a mistake, not a request for every log line ever recorded"
        );
    }

    /// `agent_workspace` answers where the agent may write, and it falls back to the project
    /// workspace whenever the active task has no usable worktree — including when the recorded
    /// worktree has since been deleted, which is what a developer removing a worktree by hand
    /// leaves behind. `active_task_workspace` refuses the same state instead, so the Godot session
    /// supervisor can never stage the addon into the user's main checkout.
    #[test]
    fn a_deleted_worktree_falls_back_for_the_agent_and_fails_for_the_session() {
        let directory = TempDir::new().expect("temporary directory");
        let storage = storage(&directory);
        let workspace = storage.workspace_path.clone();
        let missing = directory.path().join("worktrees").join("gone");
        let connection = storage.connection().expect("connection");
        let task_id = active_task_id(&connection)
            .expect("active task lookup")
            .expect("an open project always has an active task");
        connection
            .execute(
                "INSERT INTO task_worktrees
                 (task_id, branch_name, worktree_path, base_commit, updated_at)
                 VALUES (?1, 'gofer/task', ?2, 'abc123', 0)",
                params![task_id, missing.display().to_string()],
            )
            .expect("record a worktree that no longer exists on disk");

        assert_eq!(
            storage.agent_workspace().expect("agent workspace"),
            workspace,
            "a recorded worktree that is not a directory is not a place to write"
        );
        assert!(
            storage
                .active_task_workspace()
                .unwrap_err()
                .contains("does not exist"),
            "the session supervisor must name the missing worktree rather than fall back"
        );
    }
}

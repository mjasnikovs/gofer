//! The Ledger: one project database, and the six views over it.
//!
//! CONTEXT.md names six interfaces — `chats`, `tasks`, `runs`, `sketches`, `memory`, `project` — and
//! for a long time the filesystem named one file of 7,829 lines. They are six files now, one per
//! view, each holding its own tests. What stays here is what all six sit on: the connection, the
//! schema and its migrations, the slot the workspace binding reopens, the checkout claim, and the
//! handful of primitives every view converts a row through.

mod chats;
mod memories;
mod project;
mod runs;
mod sketches;
mod tasks;

pub use chats::*;
pub use memories::*;
pub(crate) use project::copy_directory;
pub use project::*;
pub use runs::*;
pub use sketches::*;
pub use tasks::*;
pub(crate) use tasks::{active_task_id, require_task, set_active_task, task_branch_name};

use crate::command_error::CommandError;
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::cell::Cell;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, Once, TryLockError};
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

use crate::git;
use crate::paths;
use crate::task_switch::Switch;

const LEGACY_CATALOG_FILE_NAME: &str = "catalog.sqlite";
const LEGACY_PROJECTS_DIRECTORY: &str = "projects";
const PROJECT_DATABASE_FILE_NAME: &str = "project.sqlite";
/// The project's own identity, kept in its own database so that moving the folder moves it too.
const PROJECT_ID_KEY: &str = "project.id";
/// The project's own agent prompt, absent while the project follows the shipped one.
const AGENT_PROMPT_KEY: &str = "agent.system_prompt";

/// Which of this project's skills the user has turned off, as a JSON array of names.
///
/// Off is stored and on is not, so a project that has never opened the Skills tab has no row and
/// every skill it holds is live. It shares `project_state` with the prompt for the same reason the
/// prompt is there: it is what the agent is told, and it is not the renderer's to write blind.
const DISABLED_SKILLS_KEY: &str = "agent.skills.disabled";
const MEMORY_EMBEDDING_DIMENSIONS: usize = 1024;
/// Read from the worker that produces the vectors rather than written again here.
///
/// Two copies of this string had no compile-time tie. `memory_embeddings.model` is checked on write
/// but the vector search never filters on it, and the backfill only finds rows with no embedding at
/// all — so changing the model in one place would leave every old vector in `memory_vectors`,
/// silently ranked in the same cosine search as the new ones.
const MEMORY_EMBEDDING_MODEL: &str = crate::memory::MODEL;
/// How many memories one maintenance pass re-embeds before leaving the rest for the next one.
///
/// A ceiling on how long the write lock is held by a pass that finds a whole project unembedded,
/// not a limit on what gets restored: the next pass takes the next two hundred.
const BACKFILL_LIMIT: usize = 200;
const MAX_STORED_CHAT_BYTES: usize = 32 * 1024 * 1024;
const MAX_STORED_CHAT_MESSAGES: usize = 10_000;
const MAX_STORED_MESSAGE_BYTES: usize = 1024 * 1024;
/// Interface state is small by nature — tabs, sizes, paths, cursors — so this is a ceiling on
/// mistakes rather than a budget anything real is meant to spend.
const MAX_UI_STATE_BYTES: usize = 1024 * 1024;
/// Everything the renderer may write into `project_state`, and nothing else.
const UI_STATE_PREFIX: &str = "ui.";
static SQLITE_VEC_REGISTRATION: Once = Once::new();

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

const PROJECT_SCHEMA_V3: &str = r#"
BEGIN;
CREATE TRIGGER memory_items_ad_vectors AFTER DELETE ON memory_items BEGIN
    DELETE FROM memory_vectors WHERE memory_id = old.id;
END;
PRAGMA user_version = 3;
COMMIT;
"#;

const PROJECT_SCHEMA_V4: &str = r#"
BEGIN;
ALTER TABLE godot_runs ADD COLUMN session_id TEXT;
CREATE INDEX godot_runs_session ON godot_runs(session_id, started_at DESC);
PRAGMA user_version = 4;
COMMIT;
"#;

const PROJECT_SCHEMA_V5: &str = r#"
BEGIN;
CREATE TABLE docs_answers (
    corpus_version TEXT NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('search', 'ask')),
    question TEXT NOT NULL,
    response_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (corpus_version, mode, question)
) STRICT;
PRAGMA user_version = 5;
COMMIT;
"#;

/// One planned task's brief: the phase it reached and what each phase produced.
///
/// A table of its own rather than a `project_state` key, and the deciding reason is the foreign key.
/// A brief belongs to exactly one task and is meaningless without it, so deleting the task has to
/// delete the brief — and `project_state` is a flat key-value store with no task to cascade from,
/// which would leave a brief behind for every task ever removed.
///
/// Every phase column is written the moment that phase produces its output rather than at the end.
/// The worker that produces them is killed to cancel a run, so anything not already across this
/// boundary is gone: a row that filled in as it went says how far a stopped run got, where one
/// written at the end would say nothing at all.
///
/// `phase` is the resume pointer and `status` is what the user is told. They are separate because a
/// run that stopped during research and a run that finished are both "at" a phase, and only one of
/// them is worth offering to continue.
const PROJECT_SCHEMA_V6: &str = r#"
BEGIN;
CREATE TABLE brief_runs (
    task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('running', 'done', 'failed', 'stopped')),
    phase TEXT NOT NULL,
    raw_prompt TEXT NOT NULL,
    refined TEXT,
    research TEXT,
    qa TEXT,
    spec TEXT,
    reason TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
) STRICT;
PRAGMA user_version = 6;
COMMIT;
"#;

/// What the user was shown and agreed, so a layout outlives the card that asked about it.
///
/// The markup itself stays a file. A sketch with the project's own artwork inlined runs to tens of
/// kilobytes of base64, and a list of forty would have to carry all of it across the seam to draw
/// one — so the row is what a list needs to name a sketch, and the bytes are fetched when one is
/// opened.
///
/// `task_id` clears rather than cascades, the same way a memory's does. The layout the user agreed
/// is still the layout they agreed after the task that produced it is deleted, and a cascade would
/// leave its two files on disk with nothing naming them.
///
/// `question_id` is a column and not the key. It says which asking this came from; the key is a
/// sketch identifier that carries a per-run segment, because a question identifier repeats on every
/// launch. See `ask::new_sketch_id`.
const PROJECT_SCHEMA_V7: &str = r#"
BEGIN;
CREATE TABLE sketches (
    id TEXT PRIMARY KEY,
    task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
    question_id TEXT NOT NULL,
    question TEXT NOT NULL,
    label TEXT NOT NULL,
    is_approved INTEGER NOT NULL CHECK (is_approved IN (0, 1)),
    saved_at INTEGER NOT NULL
) STRICT;
CREATE INDEX sketches_saved ON sketches(saved_at DESC);
PRAGMA user_version = 7;
COMMIT;
"#;

/// One task's brief, as the panel and a resume read it.
///
/// Every phase output is optional because a run that stopped part way through has only the ones it
/// reached, and that is exactly what the row is for.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BriefRun {
    pub task_id: String,
    pub status: String,
    pub phase: String,
    pub raw_prompt: String,
    pub refined: Option<String>,
    pub research: Option<String>,
    pub qa: Option<String>,
    pub spec: Option<String>,
    pub reason: Option<String>,
}

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

/// What bringing the project's branch into a task left behind.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveTaskResult {
    pub task_id: String,
    /// The files holding both versions, for the agent to reconcile. Empty means it merged cleanly
    /// and there is nothing to resolve.
    pub conflicts: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupResult {
    pub path: String,
    pub created_at: u64,
}

/// What one maintenance pass removed, and what each view contributed to it.
///
/// The same type on both ends of the fold: a view's [`Collected`] is one of these with only its own
/// counters filled in, and [`Project::run_maintenance`] adds the six together. One field list rather
/// than an accumulator beside a result, so a new counter has one place to be added and a view has
/// nowhere to report something the result would quietly drop.
///
/// `memory_embeddings_restored` was that drop. It left here as a hardcoded zero — re-embedding needs
/// the memory worker, which `storage` cannot reach — and `lib.rs` patched the returned struct
/// afterwards, so any second caller was handed a number that was simply untrue with nothing saying
/// so. [`Memories::collect`] fills it in now, and this result is complete when it is returned.
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MaintenanceResult {
    pub attachments_removed: usize,
    pub blobs_removed: usize,
    pub godot_runs_removed: usize,
    pub sketches_removed: usize,
    pub docs_answers_removed: usize,
    pub memory_vectors_removed: usize,
    /// Vectors that were filed under a scope their memory has left, put back under its current one.
    /// See [`Memories::refile_drifted_vectors`].
    pub memory_vectors_refiled: usize,
    pub backups_removed: usize,
    pub memory_embeddings_restored: usize,
}

impl MaintenanceResult {
    /// Adds one view's collection to the running total.
    fn absorb(&mut self, view: Collected) {
        self.attachments_removed += view.attachments_removed;
        self.blobs_removed += view.blobs_removed;
        self.godot_runs_removed += view.godot_runs_removed;
        self.sketches_removed += view.sketches_removed;
        self.docs_answers_removed += view.docs_answers_removed;
        self.memory_vectors_removed += view.memory_vectors_removed;
        self.memory_vectors_refiled += view.memory_vectors_refiled;
        self.backups_removed += view.backups_removed;
        self.memory_embeddings_restored += view.memory_embeddings_restored;
    }
}

/// What one view's upkeep removed: a [`MaintenanceResult`] carrying only that view's own counters.
pub(crate) type Collected = MaintenanceResult;

/// What one maintenance pass treats as spent, decided once so that the six views agree.
///
/// Read at the top of the fold rather than by each view, because two views that each ask the clock
/// prune to two different edges — a run row deleted against one reading and its log directory kept
/// against another is exactly the inconsistency maintenance is for.
pub(crate) struct Cutoffs {
    /// An attachment unreferenced since before this is rubbish. A day, because the composer stores
    /// an image on paste and the row referring to it only appears on send: anything shorter deletes
    /// the screenshot of somebody who pasted one and went to lunch.
    attachments_before: i64,
    /// A run whose output stopped before this goes, with its segments and its log directory. Thirty
    /// days.
    runs_before: i64,
    /// The manual this process has been answered out of, which is what makes every stored answer
    /// from another corpus superseded. `None` means nothing has asked the manual yet in this
    /// process: an unknown current version cannot tell a stale corpus from the live one, so nothing
    /// is dropped rather than the wrong thing being.
    corpus_version: Option<String>,
    /// How many backups survive a pass, newest first.
    backups_kept: usize,
}

impl Cutoffs {
    fn current() -> Result<Self, CommandError> {
        let now = now_millis()?;
        Ok(Self {
            attachments_before: now.saturating_sub(24 * 60 * 60 * 1_000),
            runs_before: now.saturating_sub(30 * 24 * 60 * 60 * 1_000),
            corpus_version: crate::rag::known_corpus_version(),
            backups_kept: 5,
        })
    }
}

/// A vector computed before the write lock was taken, with the text it was computed from.
///
/// The text is what makes it checkable. Minutes pass between computing one of these and writing it,
/// and an edit in that window deletes the row's vector precisely because the content changed.
pub(crate) struct PendingEmbedding {
    request: SaveMemoryEmbeddingRequest,
    content: String,
}

/// The views maintenance folds over, in the order it visits them.
///
/// A chain rather than an array of six, and the difference is what a seventh view costs. Both
/// matches below stop compiling the moment a variant is added — neither is exhaustive any more — so
/// the view cannot arrive without being given an upkeep *and* a place in the sequence. An array is
/// something you can simply forget to append to, and forgetting is not hypothetical here: the two
/// newest views, `sketches` and the project's `docs_answers`, were collected by nothing at all,
/// because the one function that knew how to clean anything up lived on a different view and nobody
/// was told to add to it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Upkeep {
    Chats,
    Tasks,
    Runs,
    Sketches,
    Memories,
    Project,
}

impl Upkeep {
    /// Every view, once each, in visiting order.
    fn every() -> impl Iterator<Item = Self> {
        std::iter::successors(Some(Self::Chats), |view| view.following())
    }

    /// The view after this one, and nothing after the last.
    fn following(self) -> Option<Self> {
        match self {
            Self::Chats => Some(Self::Tasks),
            Self::Tasks => Some(Self::Runs),
            Self::Runs => Some(Self::Sketches),
            Self::Sketches => Some(Self::Memories),
            Self::Memories => Some(Self::Project),
            Self::Project => None,
        }
    }

    /// Asks one view to collect what it owns.
    ///
    /// `pending` is the one thing a view could not work out for itself under the lock: the vectors
    /// for memories that have none, which come from another process. They are computed before the
    /// lock is taken and handed in, so what happens here is only the write.
    fn collect(
        self,
        storage: &ProjectStorage,
        cutoffs: &Cutoffs,
        pending: &[PendingEmbedding],
    ) -> Result<Collected, CommandError> {
        match self {
            Self::Chats => storage.chats().collect(cutoffs),
            Self::Tasks => storage.tasks().collect(cutoffs),
            Self::Runs => storage.runs().collect(cutoffs),
            Self::Sketches => storage.sketches().collect(cutoffs),
            Self::Memories => storage.memory().collect(cutoffs, pending),
            Self::Project => storage.project().collect(cutoffs),
        }
    }
}

#[derive(Default)]
struct SearchScore {
    text_rank: Option<usize>,
    vector_rank: Option<usize>,
    vector_distance: Option<f64>,
}

/// One project's database, reached through six ledgers.
///
/// The connection, the schema and the migrations are one thing and stay one thing — a chat, a
/// task's worktree and a run's output are written under the same lock and read out of the same
/// file. What is six is the *interface*: [`chats`](Self::chats), [`tasks`](Self::tasks),
/// [`runs`](Self::runs), [`sketches`](Self::sketches), [`memory`](Self::memory) and
/// [`project`](Self::project) each hand back a view over this same handle. `sketches` was the
/// sixth, and it was counted as five here for as long as it existed.
///
/// It was one type with thirty-five methods over five unrelated subjects, which is the other way
/// to be shallow: deep in the body and wide at the mouth. Nothing in the type system said that
/// searching memories and deleting a task were strangers, so the turn runtime, which wants a
/// conversation, was handed the log writer, the embedding index and the backup runner as well.
#[derive(Clone, Debug)]
pub struct ProjectStorage {
    data_root: PathBuf,
    project_id: String,
    workspace_path: PathBuf,
    write_lock: Arc<Mutex<()>>,
    checkout_lock: Arc<Mutex<()>>,
}

thread_local! {
    /// Whether this thread is already inside a task operation. See [`ProjectStorage::claim_checkout`].
    static OWNS_CHECKOUT: Cell<bool> = const { Cell::new(false) };
}

/// The project's one working tree, claimed for the length of a task operation.
///
/// `guard` is `None` for a claim granted to a thread that already held one, so only the outermost
/// claim releases it.
struct CheckoutClaim<'a> {
    guard: Option<MutexGuard<'a, ()>>,
}

impl Drop for CheckoutClaim<'_> {
    fn drop(&mut self) {
        if self.guard.is_some() {
            OWNS_CHECKOUT.with(|owns| owns.set(false));
        }
    }
}

/// The one project database, and why it could not be opened when it could not be.
///
/// Opening depends on the workspace, and the workspace can be wrong: a folder Gofer cannot write,
/// or a repository whose state stops a task from being created. That used to fail Tauri's `setup`,
/// which panics — no window, no message, nothing for the user to act on. Holding the failure here
/// instead lets the interface open, report it, and reopen the database once the health check has
/// repaired what was wrong.
#[derive(Clone)]
pub struct StorageSlot(Arc<Mutex<Result<ProjectStorage, CommandError>>>);

impl StorageSlot {
    pub fn new(storage: Result<ProjectStorage, CommandError>) -> Self {
        Self(Arc::new(Mutex::new(storage)))
    }

    pub fn get(&self) -> Result<ProjectStorage, CommandError> {
        self.0
            .lock()
            .map_err(|_| CommandError::from("The project storage lock is poisoned".to_owned()))?
            .clone()
    }

    pub fn replace(
        &self,
        storage: Result<ProjectStorage, CommandError>,
    ) -> Result<ProjectStorage, CommandError> {
        let mut slot = self
            .0
            .lock()
            .map_err(|_| CommandError::from("The project storage lock is poisoned".to_owned()))?;
        *slot = storage;
        slot.clone()
    }
}

impl ProjectStorage {
    /// Opens the one project whose data lives in `data_root`.
    ///
    /// `data_root` *is* the project directory — normally `.gofer` inside the workspace. There is no
    /// index from a path to a project, because there is nothing to look up: a project's chats, logs,
    /// blobs, and worktrees sit beside its files, so copying or renaming the folder carries them
    /// along and deleting the folder deletes them.
    pub fn open(data_root: &Path, workspace_path: &Path) -> Result<Self, CommandError> {
        fs::create_dir_all(data_root).map_err(|error| {
            CommandError::from(format!(
                "Could not create the Gofer data directory: {error}"
            ))
        })?;
        let canonical_path = paths::canonical(workspace_path).map_err(|error| {
            CommandError::from(format!(
                "Could not resolve the workspace directory: {error}"
            ))
        })?;
        ignore_own_directory(data_root)?;
        let mut storage = Self {
            data_root: data_root.to_path_buf(),
            project_id: String::new(),
            workspace_path: canonical_path,
            write_lock: Arc::new(Mutex::new(())),
            checkout_lock: Arc::new(Mutex::new(())),
        };
        let project = storage.connection()?;
        migrate_project(&project)?;
        close_abandoned_runs(&project)?;
        storage.project_id = ensure_project_id(&project)?;
        let _ = storage.base_branch();
        let _ = storage.ensure_active_task(&project);
        Ok(storage)
    }

    fn insert_task(
        &self,
        task_id: &str,
        worktree: Option<&git::CreatedBranch>,
    ) -> Result<(), CommandError> {
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
                        self.workspace_path.to_string_lossy(),
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

    /// Where a task's files are: the project itself, once the task is known to have a branch.
    ///
    /// Every task shares the one checkout, so this answers the same directory for all of them. What
    /// it guarantees is the branch — created here when the task has none, which is the repair path
    /// for two cases that used to strand a task forever. A project opened before it was a Git
    /// repository, or before it had a commit to branch from, still creates its first task; that task
    /// is written without a branch, and nothing ever went back for it once the user fixed the
    /// repository. A branch the database forgot is the same failure one step later.
    ///
    /// Moving the checkout onto that branch is deliberately *not* done here. This is asked on every
    /// call that needs to know where the agent's files are, and a working tree that moved as a side
    /// effect of a question is how an editor ends up holding a scene from another task. Only a
    /// [`Switch`] moves it.
    fn task_workspace(&self, task_id: &str) -> Result<PathBuf, CommandError> {
        let recorded = {
            let connection = self.connection()?;
            connection
                .query_row(
                    "SELECT branch_name FROM task_worktrees WHERE task_id = ?1",
                    [task_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(database_error)?
        };
        let branch_name = recorded.unwrap_or_else(|| task_branch_name(task_id));
        if git::branch_exists(&self.workspace_path, &branch_name) {
            return Ok(self.workspace_path.clone());
        }
        let base = self.base_branch()?;
        let created = git::create_task_branch(&self.workspace_path, &branch_name, &base)?
            .ok_or_else(|| CommandError::from("The project is not a Git repository".to_owned()))?;
        let (_write_guard, connection) = self.write_connection()?;
        connection
            .execute(
                "INSERT INTO task_worktrees
                 (task_id, branch_name, worktree_path, base_commit, head_commit, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(task_id) DO UPDATE SET
                     branch_name = excluded.branch_name,
                     worktree_path = excluded.worktree_path,
                     base_commit = excluded.base_commit,
                     head_commit = excluded.head_commit,
                     merged_commit = NULL,
                     updated_at = excluded.updated_at",
                params![
                    task_id,
                    branch_name,
                    self.workspace_path.to_string_lossy(),
                    created.base_commit,
                    created.head_commit,
                    now_millis()?
                ],
            )
            .map_err(database_error)?;
        Ok(self.workspace_path.clone())
    }

    /// The branch a task's work merges into, decided once and kept — while Git still has it.
    ///
    /// Read on every merge and every task deletion, so it must not depend on what is checked out at
    /// the time: by then the checkout is on a task branch, and a base read from `HEAD` would fold
    /// one task into another.
    ///
    /// Kept is not trusted. The recorded name is checked against the repository every time, because
    /// a branch that has since been deleted or renamed is a name Git cannot resolve — and the
    /// fallback for a base that names no commit is `HEAD`, which by then *is* the last task's
    /// branch. That is precisely the folding this whole function exists to prevent, arriving
    /// through the back door and saying nothing. A name Git has lost is re-derived instead.
    fn base_branch(&self) -> Result<String, CommandError> {
        let connection = self.connection()?;
        let recorded: Option<String> = connection
            .query_row(
                "SELECT value FROM project_state WHERE key = 'base_branch'",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(database_error)?;
        if let Some(branch) = recorded
            .filter(|branch| !branch.is_empty())
            .filter(|branch| git::branch_exists(&self.workspace_path, branch))
        {
            return Ok(branch);
        }
        drop(connection);
        let branch = git::base_branch_candidate(&self.workspace_path)
            .ok_or_else(|| CommandError::from("The project is not a Git repository".to_owned()))?;
        let (_write_guard, connection) = self.write_connection()?;
        connection
            .execute(
                "INSERT INTO project_state (key, value) VALUES ('base_branch', ?1)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                [&branch],
            )
            .map_err(database_error)?;
        Ok(branch)
    }

    fn connection(&self) -> Result<Connection, CommandError> {
        open_connection(&self.project_directory().join(PROJECT_DATABASE_FILE_NAME))
    }

    fn write_connection(&self) -> Result<(MutexGuard<'_, ()>, Connection), CommandError> {
        let guard = self.write_lock()?;
        let connection = self.connection()?;
        Ok((guard, connection))
    }

    fn write_lock(&self) -> Result<MutexGuard<'_, ()>, CommandError> {
        self.write_lock.lock().map_err(|_| {
            CommandError::from("The project storage write lock is poisoned".to_owned())
        })
    }

    /// Claims the project's one checkout for the length of a task operation.
    ///
    /// Creating, opening, deleting and merging a task each move the working tree, and there is one
    /// of it. They also each stop the Godot editor first — a quit request and a wait of up to ten
    /// seconds — so an operation is slow for a reason the user cannot see, and a second one started
    /// during it used to reach Git while the first was still there. One index, one `index.lock`, and
    /// the loser died on it with Git's own words in front of the user.
    ///
    /// Refused rather than queued. Waiting would leave the window silent for as long as it takes to
    /// stop an editor and then do a thing the user has since changed their mind about; the message
    /// is what they can act on, and the window's own busy state is what stops them asking at all.
    ///
    /// A claim the calling thread already holds is granted again. One task operation reaches
    /// another — deleting the last task creates the one that replaces it — and refusing the inner
    /// call over a claim its own caller is holding would be refusing it to itself.
    fn claim_checkout(&self) -> Result<CheckoutClaim<'_>, CommandError> {
        if OWNS_CHECKOUT.with(Cell::get) {
            return Ok(CheckoutClaim { guard: None });
        }
        match self.checkout_lock.try_lock() {
            Ok(guard) => {
                OWNS_CHECKOUT.with(|owns| owns.set(true));
                Ok(CheckoutClaim { guard: Some(guard) })
            }
            Err(TryLockError::WouldBlock) => Err(CommandError::from(
                "Another task is still opening, merging or closing. Wait for it to finish."
                    .to_owned(),
            )),
            Err(TryLockError::Poisoned(_)) => Err(CommandError::from(
                "The project checkout lock is poisoned".to_owned(),
            )),
        }
    }

    fn ensure_active_task(&self, connection: &Connection) -> Result<String, CommandError> {
        if let Some(task_id) = active_task_id(connection)? {
            return Ok(task_id);
        }
        let nothing_to_stop = |_: &Path| Ok(());
        self.tasks()
            .create_record(&self.switch_with_no_turn_to_refuse(&nothing_to_stop), false)?
            .task_id
            .ok_or_else(|| CommandError::from("The new task has no ID".to_owned()))
    }

    fn project_directory(&self) -> PathBuf {
        self.data_root.clone()
    }

    fn blob_path(&self, hash: &str) -> PathBuf {
        self.project_directory()
            .join("blobs")
            .join("sha256")
            .join(&hash[..2])
            .join(hash)
    }

    /// The conversation the active task holds, and the images in it.
    pub fn chats(&self) -> Chats<'_> {
        Chats { storage: self }
    }

    /// The tasks in the sidebar, and the git worktrees behind them.
    pub fn tasks(&self) -> Tasks<'_> {
        Tasks { storage: self }
    }

    /// The project's one checkout, ready to move, with what has to stop before it does.
    ///
    /// Built once and handed to whichever task operation is running. See `task_switch` for the
    /// order every one of them follows, the failure policy they share, and why building this is
    /// what refuses a turn.
    ///
    /// The refusal is why this answers a `Result`. A Switch is the provider operation for as long
    /// as it lives, so a caller that could not have one never reaches the move.
    pub fn switch<'a>(
        &self,
        release: &'a dyn Fn(&Path) -> Result<(), String>,
    ) -> Result<Switch<'a>, CommandError> {
        Switch::refusing_a_turn(self.workspace_path.clone(), release)
    }

    /// The same checkout for a move no turn can be running during. See
    /// [`Switch::with_no_turn_to_refuse`], which names both callers.
    pub fn switch_with_no_turn_to_refuse<'a>(
        &self,
        release: &'a dyn Fn(&Path) -> Result<(), String>,
    ) -> Switch<'a> {
        Switch::with_no_turn_to_refuse(self.workspace_path.clone(), release)
    }

    /// Editor runs, and the output they produced.
    pub fn runs(&self) -> Runs<'_> {
        Runs { storage: self }
    }

    /// The layouts the agent has shown the user, kept as files.
    pub fn sketches(&self) -> Sketches<'_> {
        Sketches { storage: self }
    }

    /// What the agent has been told to remember, and what finds it again.
    pub fn memory(&self) -> Memories<'_> {
        Memories { storage: self }
    }

    /// The project itself: how it was left, what its agent is told, and the database's upkeep.
    pub fn project(&self) -> Project<'_> {
        Project { storage: self }
    }
}

fn open_connection(path: &Path) -> Result<Connection, CommandError> {
    register_sqlite_vec();
    let connection = Connection::open(path).map_err(|error| {
        CommandError::from(format!("Could not open {}: {error}", path.display()))
    })?;
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

fn migrate_project(connection: &Connection) -> Result<(), CommandError> {
    let current = connection
        .query_row("PRAGMA user_version", [], |row| row.get::<_, u32>(0))
        .map_err(database_error)?;
    if current > 7 {
        return Err(format!(
            "The database schema version {current} is newer than supported version 7"
        )
        .into());
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
    if current <= 4 {
        connection
            .execute_batch(PROJECT_SCHEMA_V5)
            .map_err(database_error)?;
    }
    if current <= 5 {
        connection
            .execute_batch(PROJECT_SCHEMA_V6)
            .map_err(database_error)?;
    }
    if current <= 6 {
        connection
            .execute_batch(PROJECT_SCHEMA_V7)
            .map_err(database_error)?;
    }
    Ok(())
}

/// Closes every run row still marked `running` when the database opens.
///
/// A run belongs to an editor session of one Gofer process, and this runs before that process has
/// one. So a row still open here was left by a Gofer that did not get to close it — killed, crashed,
/// or the machine went down — and there is nothing that will ever close it later. It read as a
/// session running right now in the user's own history, which is the same lie the badge used to
/// tell, kept on disk.
///
/// The ending is taken from the last output the run actually recorded, so the row says how far it
/// got rather than when it was noticed. A run with no output at all ends where it started.
fn close_abandoned_runs(connection: &Connection) -> Result<(), CommandError> {
    connection
        .execute(
            "UPDATE godot_runs
             SET status = 'aborted',
                 ended_at = COALESCE(
                     (SELECT MAX(timestamp) FROM godot_log_events WHERE run_id = godot_runs.id),
                     (SELECT MAX(last_timestamp) FROM godot_log_segments
                      WHERE run_id = godot_runs.id),
                     started_at
                 )
             WHERE status = 'running'",
            [],
        )
        .map_err(database_error)?;
    Ok(())
}

/// Gives the project its identity once, and reads it back on every open after that.
///
/// The identity lives in the project's own database rather than in an index somewhere else, so a
/// folder that is copied keeps naming itself the same thing wherever it lands.
fn ensure_project_id(connection: &Connection) -> Result<String, CommandError> {
    let existing = connection
        .query_row(
            "SELECT value FROM project_state WHERE key = ?1",
            [PROJECT_ID_KEY],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(database_error)?;
    if let Some(project_id) = existing {
        return Ok(project_id);
    }
    let project_id = Uuid::now_v7().to_string();
    connection
        .execute(
            "INSERT INTO project_state (key, value) VALUES (?1, ?2)",
            params![PROJECT_ID_KEY, project_id],
        )
        .map_err(database_error)?;
    Ok(project_id)
}

/// Keeps Gofer's own directory out of the repository it sits in.
///
/// The data root is now inside the workspace, which means Git can see it: databases, logs, and
/// worktrees would all show up as untracked noise in the user's own project. A `.gitignore` that
/// ignores everything, written once, keeps `git status` about the user's work. It is never
/// rewritten, so a user who edits it keeps their edit.
fn ignore_own_directory(data_root: &Path) -> Result<(), CommandError> {
    let path = data_root.join(".gitignore");
    if path.exists() {
        return Ok(());
    }
    fs::write(&path, "*\n")
        .map_err(|error| CommandError::from(format!("Could not write {}: {error}", path.display())))
}

/// Moves a project out of the shared application directory the first time it is opened.
///
/// Gofer used to keep every project's data under one application directory, found through an index
/// keyed by workspace path. That made a project's history invisible from the project, and stranded
/// it whenever the folder moved. This carries the old data across once, and does nothing at all
/// once there is no old data to carry — including for every project created since.
pub fn migrate_legacy_data(
    legacy_root: &Path,
    workspace_path: &Path,
    data_root: &Path,
) -> Result<(), CommandError> {
    if data_root.join(PROJECT_DATABASE_FILE_NAME).exists() {
        return Ok(());
    }
    let catalog_path = legacy_root.join(LEGACY_CATALOG_FILE_NAME);
    if !catalog_path.is_file() {
        return Ok(());
    }
    let canonical = paths::canonical(workspace_path)
        .map_err(|error| {
            CommandError::from(format!(
                "Could not resolve the workspace directory: {error}"
            ))
        })?
        .to_string_lossy()
        .into_owned();
    let catalog = open_connection(&catalog_path)?;
    let project_id = catalog
        .query_row(
            "SELECT id FROM projects WHERE canonical_path = ?1",
            [&canonical],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(database_error)?;
    let Some(project_id) = project_id else {
        return Ok(());
    };
    let source = legacy_root
        .join(LEGACY_PROJECTS_DIRECTORY)
        .join(&project_id);
    if !source.join(PROJECT_DATABASE_FILE_NAME).is_file() {
        return Ok(());
    }
    if let Some(parent) = data_root.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            CommandError::from(format!("Could not create {}: {error}", parent.display()))
        })?;
    }
    if fs::rename(&source, data_root).is_err() {
        copy_directory(&source, data_root)?;
    }
    catalog
        .execute("DELETE FROM projects WHERE id = ?1", [&project_id])
        .map_err(database_error)?;
    Ok(())
}

fn empty_object() -> Value {
    serde_json::json!({})
}

fn now_millis() -> Result<i64, CommandError> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| CommandError::from(format!("The system clock is invalid: {error}")))
        .and_then(|duration| {
            i64::try_from(duration.as_millis()).map_err(|_| {
                CommandError::from("The current timestamp is too large to store".to_owned())
            })
        })
}

fn to_database_integer(value: u64, name: &str) -> Result<i64, CommandError> {
    i64::try_from(value)
        .map_err(|_| CommandError::from(format!("The {name} is too large to store")))
}

fn from_database_u64(value: i64, name: &str) -> Result<u64, CommandError> {
    u64::try_from(value).map_err(|_| CommandError::from(format!("The stored {name} is invalid")))
}

/// A database failure, told apart by what a caller can do about it.
///
/// `database_locked` is another process holding the file — worth trying again as it stands, which
/// is exactly what `retryable` means. Everything else is not, and a renderer that cannot tell them
/// apart offers Retry for a corrupt row and nothing for a busy one.
fn database_error(error: rusqlite::Error) -> CommandError {
    let busy = matches!(
        error.sqlite_error_code(),
        Some(rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked)
    );
    let message = format!("The Gofer database operation failed: {error}");
    if busy {
        CommandError::new("database_locked", message).retryable()
    } else {
        CommandError::new("database_unreadable", message)
    }
}

#[cfg(test)]
mod test_support;

/// The database itself: its schema, its migrations, and the bounds every view's rows are held to.
///
/// The view-shaped tests moved with their views. What is left is what belongs to no one view — a
/// version-one database that has to migrate without losing tasks, and the validation every table
/// crosses.
#[cfg(test)]
mod tests {
    use super::chats::{validate_attachment, validate_chat};
    use super::memories::{validate_embedding, validate_memory, validate_vector};
    use super::runs::validate_log_entries;
    use super::test_support::*;
    use super::*;
    use tempfile::TempDir;

    /// The directory keeps itself out of the repository it now sits in, and never argues with a user
    /// who has edited that decision.
    #[test]
    fn the_data_directory_ignores_itself_without_overwriting_an_edit() {
        let directory = TempDir::new().expect("temporary directory");
        let data_root = directory.path().join("data");
        storage(&directory);
        assert_eq!(
            fs::read_to_string(data_root.join(".gitignore")).expect("ignore file"),
            "*\n"
        );

        fs::write(data_root.join(".gitignore"), "*\n!notes.md\n").expect("edit");
        let workspace = directory.path().join("workspace");
        ProjectStorage::open(&data_root, &workspace).expect("storage");
        assert_eq!(
            fs::read_to_string(data_root.join(".gitignore")).expect("ignore file"),
            "*\n!notes.md\n"
        );
    }

    /// A workspace Gofer has never opened before has no legacy data, and the migration says so by
    /// doing nothing at all rather than by failing.
    #[test]
    fn a_workspace_with_no_legacy_data_is_left_alone() {
        let directory = TempDir::new().expect("temporary directory");
        let workspace = directory.path().join("workspace");
        fs::create_dir(&workspace).expect("workspace directory");
        let data_root = workspace.join(".gofer");

        migrate_legacy_data(&directory.path().join("missing"), &workspace, &data_root)
            .expect("no catalog");
        assert!(!data_root.exists());

        let legacy_root = directory.path().join("legacy");
        fs::create_dir(&legacy_root).expect("legacy directory");
        open_connection(&legacy_root.join(LEGACY_CATALOG_FILE_NAME))
            .expect("catalog")
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
        migrate_legacy_data(&legacy_root, &workspace, &data_root).expect("no row");
        assert!(!data_root.exists());
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
        assert!(
            validate_chat(&oversized)
                .unwrap_err()
                .message
                .contains("1 MiB")
        );

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

        assert_eq!(version, 7);
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
        assert_eq!(version, 7);
        connection
            .execute_batch(
                "INSERT INTO sketches (id, task_id, question_id, question, label, is_approved, saved_at)
                 VALUES ('question-1-run', 'task-1', 'question-1', 'Where?', 'Dock', 1, 1)",
            )
            .expect("the migrated database carries a usable sketches table");
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

    /// The regression: a recorded base branch that Git has since lost must not fold two tasks.
    ///
    /// `base_branch` used to return the recorded name without asking whether it still existed.
    /// `create_task_branch` falls back to `HEAD` for a base that names no commit, and `HEAD` by
    /// then is whichever task was opened last — so deleting or renaming the base silently turned
    /// every new task into a branch off another task's work. Exactly what this function's own
    /// documentation says it exists to prevent, arriving through the back door.
    #[test]
    fn a_base_branch_git_has_lost_is_derived_again_rather_than_trusted() {
        let directory = TempDir::new().expect("temporary directory");
        let workspace = committed_repository(directory.path());
        let storage =
            ProjectStorage::open(&directory.path().join("data"), &workspace).expect("storage");
        assert_eq!(storage.base_branch().expect("a base"), "master");

        git_text(&workspace, &["branch", "-m", "master", "main"]);
        assert!(!git::branch_exists(&workspace, "master"));

        let derived = storage.base_branch().expect("a base");
        assert_eq!(
            derived, "main",
            "a name Git cannot resolve is re-derived, not handed to the HEAD fallback"
        );
        assert!(
            !derived.starts_with(git::TASK_BRANCH_PREFIX),
            "and never a task branch, whatever happens to be checked out"
        );

        git_text(&workspace, &["branch", "stray"]);
        assert_eq!(storage.base_branch().expect("a base"), "main");
    }
}

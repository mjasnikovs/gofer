use crate::command_error::CommandError;
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::cell::Cell;
use std::collections::HashMap;
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

// Documentation answers, kept per project because the project is what owns them: they are deleted
// with it, they are backed up with it, and nothing has to manage a store that outlives every
// project on the machine. The manual itself is the same everywhere, so this does pay for the same
// answer once per project — a deliberate trade of some repeated work for keeping a project's
// traces inside the project.
//
// `corpus_version` is the gofer-rag package version, which is the version of the manual: the
// LanceDB table ships inside the package, so nothing else can change what a question retrieves.
// It is part of the key rather than a column to check, so an upgrade cannot serve one answer out
// of the old manual before anything notices.
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
type Collected = MaintenanceResult;

/// What one maintenance pass treats as spent, decided once so that the six views agree.
///
/// Read at the top of the fold rather than by each view, because two views that each ask the clock
/// prune to two different edges — a run row deleted against one reading and its log directory kept
/// against another is exactly the inconsistency maintenance is for.
struct Cutoffs {
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
enum Upkeep {
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
        // Neither sentence names a path: the data root is Gofer's own directory inside the project
        // and the workspace is the one the user already has open, so a host path in the message is
        // detail the user cannot act on and the renderer has no reason to print.
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
        // Before the first task, because creating one checks out a task branch and the branch tasks
        // merge into can only be read while it is still the branch on disk. Guessing it afterwards
        // is how a deleted task's branch stayed in the repository: the checkout could not be moved
        // off a branch whose base was a name that does not exist, so Git refused to delete it.
        let _ = storage.base_branch();
        // A workspace whose Git repository cannot yet supply a branch — one with no commits, most
        // often — must not stop the database from opening. Failing here failed Tauri's `setup`,
        // which panics: the user got no window at all, in a repository they could have fixed with
        // one commit. The health check reports it instead, and the task is created the moment it is
        // asked for.
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
        // Written as an insert-or-update because this is the one place both cases arrive: a task
        // whose row went stale, and a task that never had a row to update.
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
        // Opening a project runs before any editor session exists, so there is nothing to stop.
        let nothing_to_stop = |_: &Path| Ok(());
        self.tasks()
            .create_record(&self.switch(&nothing_to_stop), false)?
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
    /// order every one of them follows and the failure policy they share.
    pub fn switch<'a>(&self, release: &'a dyn Fn(&Path) -> Result<(), String>) -> Switch<'a> {
        Switch::new(self.workspace_path.clone(), release)
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

/// One saved layout, as a list names it. The markup is not here.
///
/// A sketch drawn with the project's own artwork inlined runs to tens of kilobytes of base64, and a
/// panel listing forty of them would carry all of it across the seam to draw one. So the row says
/// what a list needs — which question, what it was called, whether it was agreed, when — and
/// [`Sketches::read`] fetches the bytes for the one that gets opened.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SketchRecord {
    pub id: String,
    pub task_id: Option<String>,
    pub question_id: String,
    pub question: String,
    pub label: String,
    pub is_approved: bool,
    pub saved_at: i64,
}

/// Both copies of one sketch, which are read by different readers.
///
/// `shown` is what the user was actually looking at: the project's own fonts and sprites are in it,
/// so it is the only copy worth drawing again. `source` is the model's own markup before any of that
/// was inlined, which is the copy worth handing to whoever builds it — the inlined one is base64
/// saying nothing a builder can act on.
///
/// `source` is absent for a sketch kept before the second copy existed. That is a fact about when it
/// was saved, not a failure.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SketchHtml {
    pub shown: String,
    pub source: Option<String>,
}

/// One sketch on its way to being kept, borrowed from wherever the caller already holds it.
///
/// A struct rather than eight parameters, and the two markup fields are named for their readers
/// rather than for their contents: passing them the wrong way round would put base64 in front of a
/// builder and a missing sprite in front of the user, and neither would fail loudly.
pub struct KeptSketch<'a> {
    pub sketch_id: &'a str,
    pub question_id: &'a str,
    pub task_id: Option<&'a str>,
    pub question: &'a str,
    pub label: &'a str,
    /// What the viewer draws: the copy with the project's artwork inlined.
    pub shown_html: &'a str,
    /// What a builder is handed: the model's own markup, before inlining.
    pub source_html: &'a str,
    pub is_approved: bool,
}

/// The layouts the agent has shown the user: a row each, and the markup beside it as files.
///
/// The markup is not content-addressed the way an attachment is, and it is deliberately not a
/// column. A sketch is revised in place — the third draft of a pause menu replaces the second under
/// the same identifier — so what is wanted afterwards is one file holding what was actually agreed,
/// not five near-identical drafts with no way to tell which one the user was looking at when they
/// said yes. The row exists so a list can name that file without opening it.
pub struct Sketches<'a> {
    storage: &'a ProjectStorage,
}

impl Sketches<'_> {
    /// Keeps one revision, replacing whatever was under that identifier before.
    ///
    /// Best effort by design: the caller is a tool call the user is waiting on, and a full disk must
    /// not turn a layout the user just approved into a refused tool call. A failure here loses an
    /// artefact; a failure reported upwards would lose the reaction.
    ///
    /// Files first, then the row. The two orderings fail differently and only one of them is
    /// recoverable: a file with no row is invisible, which is what every sketch saved before this
    /// table existed already is. A row with no file is a list offering something that cannot be
    /// opened.
    ///
    /// Under the write lock, and the lock is taken before the files rather than with the row. It is
    /// what [`collect`](Self::collect) holds for its whole pass, and that pass deletes any file in
    /// this directory with no row behind it — so a sketch kept while maintenance ran had its markup
    /// written, then removed under it, and the insert below produced exactly the row with no file
    /// the ordering above exists to avoid.
    pub fn keep(&self, kept: &KeptSketch<'_>) -> Result<(), CommandError> {
        let (_write_guard, connection) = self.storage.write_connection()?;
        let directory = self.sketch_directory(kept.sketch_id)?;
        fs::create_dir_all(&directory).map_err(|error| {
            CommandError::from(format!("Could not create {}: {error}", directory.display()))
        })?;
        write_sketch_file(
            &directory.join(format!("{}.html", kept.sketch_id)),
            kept.shown_html,
        )?;
        write_sketch_file(
            &directory.join(format!("{}.source.html", kept.sketch_id)),
            kept.source_html,
        )?;
        connection
            .execute(
                "INSERT INTO sketches (id, task_id, question_id, question, label, is_approved, saved_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT(id) DO UPDATE SET
                     task_id = excluded.task_id,
                     question_id = excluded.question_id,
                     question = excluded.question,
                     label = excluded.label,
                     is_approved = excluded.is_approved,
                     saved_at = excluded.saved_at",
                params![
                    kept.sketch_id,
                    kept.task_id,
                    kept.question_id,
                    kept.question,
                    kept.label,
                    i64::from(kept.is_approved),
                    now_millis()?
                ],
            )
            .map_err(database_error)?;
        Ok(())
    }

    /// Every sketch the project has kept, most recently saved first.
    pub fn list(&self, limit: usize) -> Result<Vec<SketchRecord>, CommandError> {
        self.listed_records(limit)
            .map_err(CommandError::or_coded("sketches_unavailable"))
    }

    fn listed_records(&self, limit: usize) -> Result<Vec<SketchRecord>, CommandError> {
        let connection = self.storage.connection()?;
        let mut statement = connection
            .prepare(
                "SELECT id, task_id, question_id, question, label, is_approved, saved_at
                 FROM sketches
                 ORDER BY saved_at DESC, id DESC
                 LIMIT ?1",
            )
            .map_err(database_error)?;
        let rows = statement
            .query_map([limit as i64], |row| {
                Ok(SketchRecord {
                    id: row.get(0)?,
                    task_id: row.get(1)?,
                    question_id: row.get(2)?,
                    question: row.get(3)?,
                    label: row.get(4)?,
                    is_approved: row.get::<_, i64>(5)? != 0,
                    saved_at: row.get(6)?,
                })
            })
            .map_err(database_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(database_error)?;
        Ok(rows)
    }

    /// Both copies of one sketch.
    ///
    /// The identifier is checked before anything touches the filesystem, and that check is the point
    /// of this method rather than an afterthought in it. Until there was a screen for these, the
    /// value came from `ask::new_sketch_id` and could not be anything else; it now arrives from the
    /// renderer as a command argument, which makes it the one string in this feature that could name
    /// a path.
    pub fn read(&self, sketch_id: &str) -> Result<SketchHtml, CommandError> {
        self.read_html(sketch_id)
            .map_err(CommandError::or_coded("sketch_unavailable"))
    }

    fn read_html(&self, sketch_id: &str) -> Result<SketchHtml, CommandError> {
        let directory = self.sketch_directory(sketch_id)?;
        let connection = self.storage.connection()?;
        let known = connection
            .query_row("SELECT 1 FROM sketches WHERE id = ?1", [sketch_id], |row| {
                row.get::<_, i64>(0)
            })
            .optional()
            .map_err(database_error)?;
        if known.is_none() {
            return Err(CommandError::new(
                "sketch_not_found",
                format!("There is no sketch {sketch_id}"),
            ));
        }
        let shown_path = directory.join(format!("{sketch_id}.html"));
        let shown = fs::read_to_string(&shown_path).map_err(|error| {
            CommandError::from(format!("Could not read {}: {error}", shown_path.display()))
        })?;
        // Absent is an age, not a fault: sketches kept before the second copy existed have one file.
        let source = fs::read_to_string(directory.join(format!("{sketch_id}.source.html"))).ok();
        Ok(SketchHtml { shown, source })
    }

    /// Where a sketch's files live, having first proved its identifier cannot name anywhere else.
    fn sketch_directory(&self, sketch_id: &str) -> Result<PathBuf, CommandError> {
        if sketch_id.is_empty() || !sketch_id.bytes().all(is_sketch_id_byte) {
            return Err(CommandError::new(
                "sketch_id_invalid",
                "A sketch identifier may only hold letters, digits and hyphens".to_owned(),
            ));
        }
        Ok(self.storage.project_directory().join("sketches"))
    }

    /// Rows whose markup is gone, and markup no row names.
    ///
    /// Not an age. A sketch is deliberately outlived by nothing: `task_id` clears rather than
    /// cascades because the layout the user agreed to is still the layout they agreed to after the
    /// task that produced it is deleted, so there is no date after which one stops being worth
    /// keeping. What there is instead is the pair coming apart, and [`Sketches::keep`] writes the
    /// files before the row precisely because the two orderings fail differently — so both halves
    /// of that failure are what this collects.
    ///
    /// A row with no file is the worse half and goes first: it is a list offering the user something
    /// that cannot be opened. A file with no row is only invisible, which is what every sketch saved
    /// before this table existed already was — but it is also what a crash between the two writes
    /// leaves behind, and nothing else would ever remove it.
    fn collect(&self, _cutoffs: &Cutoffs) -> Result<Collected, CommandError> {
        let directory = self.storage.project_directory().join("sketches");
        let connection = self.storage.connection()?;
        let mut statement = connection
            .prepare("SELECT id FROM sketches")
            .map_err(database_error)?;
        let kept = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(database_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(database_error)?;
        drop(statement);
        let mut surviving = Vec::with_capacity(kept.len());
        let mut removed = 0;
        for id in kept {
            if directory.join(format!("{id}.html")).is_file() {
                surviving.push(id);
                continue;
            }
            connection
                .execute("DELETE FROM sketches WHERE id = ?1", [&id])
                .map_err(database_error)?;
            // The second copy can outlive the first, and a row that is going takes both with it.
            let _ = fs::remove_file(directory.join(format!("{id}.source.html")));
            removed += 1;
        }
        for path in sketch_files(&directory)? {
            // A name this cannot read is not a sketch, and something that is not ours is not ours
            // to delete.
            let Some(id) = sketch_id_of(&path) else {
                continue;
            };
            if surviving.contains(&id) {
                continue;
            }
            fs::remove_file(&path).map_err(|error| {
                CommandError::from(format!("Could not remove {}: {error}", path.display()))
            })?;
        }
        Ok(Collected {
            sketches_removed: removed,
            ..Collected::default()
        })
    }
}

/// Every file in the sketch directory, or none at all when the project has never kept one.
fn sketch_files(directory: &Path) -> Result<Vec<PathBuf>, CommandError> {
    if !directory.is_dir() {
        return Ok(Vec::new());
    }
    Ok(fs::read_dir(directory)
        .map_err(|error| {
            CommandError::from(format!("Could not read {}: {error}", directory.display()))
        })?
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
        .map(|entry| entry.path())
        .collect())
}

/// Which sketch a file in that directory belongs to, and nothing for a file that is not one.
///
/// Unambiguous because [`is_sketch_id_byte`] allows no dot: `pause-menu.source.html` can only be the
/// source copy of `pause-menu`, never a sketch called `pause-menu.source`.
fn sketch_id_of(path: &Path) -> Option<String> {
    let name = path.file_name()?.to_str()?;
    let stem = name
        .strip_suffix(".source.html")
        .or_else(|| name.strip_suffix(".html"))?;
    if stem.is_empty() || !stem.bytes().all(is_sketch_id_byte) {
        return None;
    }
    Some(stem.to_owned())
}

fn write_sketch_file(path: &Path, html: &str) -> Result<(), CommandError> {
    fs::write(path, html)
        .map_err(|error| CommandError::from(format!("Could not save {}: {error}", path.display())))
}

/// The bytes a sketch identifier may hold, which is what keeps it from naming a path.
///
/// The identifier is minted by `ask::new_sketch_id`, and the window hands it back to ask for the
/// markup, so a value that becomes a filename makes a round trip through code we do not own.
/// Nothing in `question-7-018f…` needs a dot or a separator, so neither is allowed, `..` cannot be
/// spelt at all, and the `.source.html` suffix cannot be forged by an identifier ending in `.source`.
fn is_sketch_id_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'-'
}

/// The conversation the active task holds, and the images in it.
///
/// Attachments are here rather than with the backups because they belong to messages: one is
/// stored by content hash, referred to by the message that carries it, and read back when that
/// message is drawn.
pub struct Chats<'a> {
    storage: &'a ProjectStorage,
}

impl Chats<'_> {
    /// The conversation of the task the caller names, or of the active one when it names none.
    ///
    /// Named rather than assumed, because the window and the backend disagree for as long as a
    /// switch is running and the window is the one that knows which task it is drawing. Answering
    /// about whichever task happened to be active is how a task opened a second time arrived
    /// holding the previous task's conversation: the workspace remounts the moment the route
    /// resolves, and on a route the router had already loaded that is before the switch lands.
    pub fn load(&self, task_id: Option<&str>) -> Result<StoredChat, CommandError> {
        self.chat_of(task_id)
            .map_err(CommandError::or_coded("chat_unavailable"))
    }

    /// The active task's conversation. For the callers that have just made it active themselves.
    fn stored_chat(&self) -> Result<StoredChat, CommandError> {
        self.chat_of(None)
    }

    fn chat_of(&self, requested: Option<&str>) -> Result<StoredChat, CommandError> {
        let connection = self.storage.connection()?;
        let task_id = match requested {
            Some(requested) => {
                require_task(&connection, requested)?;
                requested.to_owned()
            }
            None => self.storage.ensure_active_task(&connection)?,
        };
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
                serde_json::from_str(&payload).map_err(|error| {
                    CommandError::from(format!("Stored chat message is invalid: {error}"))
                })
            })
            .collect::<Result<Vec<StoredMessage>, CommandError>>()?;
        let agent_messages = serde_json::from_str(&agent_messages_json).map_err(|error| {
            CommandError::from(format!("Stored agent context is invalid: {error}"))
        })?;
        Ok(StoredChat {
            task_id: Some(task_id),
            messages,
            agent_messages,
        })
    }

    pub fn save(&self, chat: &StoredChat) -> Result<(), CommandError> {
        self.store_chat(chat)
            .map_err(CommandError::or_coded("chat_not_saved"))
    }

    fn store_chat(&self, chat: &StoredChat) -> Result<(), CommandError> {
        validate_chat(chat)?;
        let message_payloads = chat
            .messages
            .iter()
            .map(|message| {
                serde_json::to_string(message).map_err(|error| {
                    CommandError::from(format!("Could not serialize chat message: {error}"))
                })
            })
            .collect::<Result<Vec<_>, _>>()?;
        let agent_messages = serde_json::to_string(&chat.agent_messages).map_err(|error| {
            CommandError::from(format!("Could not serialize agent context: {error}"))
        })?;
        let (_write_guard, mut connection) = self.storage.write_connection()?;
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
                    return Err(CommandError::from(
                        "The chat task no longer exists".to_owned(),
                    ));
                }
                task_id.clone()
            }
            None => self.storage.ensure_active_task(&transaction)?,
        };
        // A chat is stored by replacing every row the task owns, so a caller holding fewer messages
        // than are on disk deletes the difference. That is never what a save means: the renderer
        // sends the whole conversation, and a short one is a renderer that lost its state — a chat
        // that failed to load, a turn rewritten by hand, a remount that arrived before its read.
        // Losing the user's conversation to any of those is worse than refusing the write, so the
        // write is refused and the message says what it was about to cost.
        let stored_messages: i64 = transaction
            .query_row(
                "SELECT COUNT(*) FROM messages WHERE task_id = ?1",
                [&task_id],
                |row| row.get(0),
            )
            .map_err(database_error)?;
        let saving_messages = chat.messages.len() as i64;
        if saving_messages < stored_messages {
            return Err(format!(
                "Refusing to save {saving_messages} chat messages over the {stored_messages} \
                 already stored: {} would be lost",
                stored_messages - saving_messages
            )
            .into());
        }
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
                    return Err(
                        format!("Attachment '{}' has not been stored", attachment.name).into(),
                    );
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

    pub fn save_attachment(
        &self,
        attachment: &StoredAttachment,
        bytes: &[u8],
    ) -> Result<(), CommandError> {
        self.store_attachment(attachment, bytes)
            .map_err(CommandError::or_coded("attachment_not_stored"))
    }

    fn store_attachment(
        &self,
        attachment: &StoredAttachment,
        bytes: &[u8],
    ) -> Result<(), CommandError> {
        validate_attachment(attachment)?;
        if bytes.len() as u64 != attachment.size {
            return Err(CommandError::from(
                "The attachment size does not match its contents".to_owned(),
            ));
        }
        let hash = Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let path = self.storage.blob_path(&hash);
        let parent = path
            .parent()
            .ok_or_else(|| CommandError::from("The blob path has no parent".to_owned()))?;
        fs::create_dir_all(parent).map_err(|error| {
            CommandError::from(format!("Could not create {}: {error}", parent.display()))
        })?;
        if !path.exists() {
            let temporary = parent.join(format!(".{}.tmp", Uuid::now_v7()));
            fs::write(&temporary, bytes).map_err(|error| {
                CommandError::from(format!("Could not save {}: {error}", temporary.display()))
            })?;
            match fs::rename(&temporary, &path) {
                Ok(()) => {}
                Err(_) if path.exists() => {
                    let _ = fs::remove_file(&temporary);
                }
                Err(error) => {
                    return Err(format!("Could not store {}: {error}", path.display()).into());
                }
            }
        }
        let (_write_guard, connection) = self.storage.write_connection()?;
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
            return Err(CommandError::from(
                "The attachment ID is already used by different content".to_owned(),
            ));
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

    pub fn read_attachment(&self, attachment: &StoredAttachment) -> Result<Vec<u8>, CommandError> {
        self.stored_attachment_bytes(attachment)
            .map_err(CommandError::or_coded("attachment_unavailable"))
    }

    fn stored_attachment_bytes(
        &self,
        attachment: &StoredAttachment,
    ) -> Result<Vec<u8>, CommandError> {
        let connection = self.storage.connection()?;
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
            return Err(format!("Attachment metadata does not match: {}", attachment.name).into());
        }
        let bytes = fs::read(self.storage.blob_path(&stored.0)).map_err(|error| {
            CommandError::from(format!(
                "Could not read attachment {}: {error}",
                attachment.name
            ))
        })?;
        if bytes.len() as u64 != attachment.size {
            return Err(
                format!("The stored attachment size is invalid: {}", attachment.name).into(),
            );
        }
        let actual_hash = Sha256::digest(&bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        if actual_hash != stored.0 {
            return Err(format!(
                "The stored attachment contents are invalid: {}",
                attachment.name
            )
            .into());
        }
        Ok(bytes)
    }

    pub fn import_legacy_attachment(
        &self,
        legacy_directory: &Path,
        attachment: &StoredAttachment,
    ) -> Result<(), CommandError> {
        self.import_attachment(legacy_directory, attachment)
            .map_err(CommandError::or_coded("attachment_not_imported"))
    }

    fn import_attachment(
        &self,
        legacy_directory: &Path,
        attachment: &StoredAttachment,
    ) -> Result<(), CommandError> {
        let path = legacy_directory.join(&attachment.id);
        let bytes = fs::read(&path).map_err(|error| {
            CommandError::from(format!("Could not import {}: {error}", path.display()))
        })?;
        self.storage.chats().store_attachment(attachment, &bytes)
    }

    /// Attachments no message refers to any more, and the blobs left holding their bytes.
    ///
    /// Only after a day unreferenced. The window between an image being stored and the message
    /// carrying it being written is real — the composer stores on paste, the row appears on send —
    /// so anything shorter deletes the screenshot of somebody who pasted one and went to lunch.
    ///
    /// `message_attachments` needs no sweep of its own and that is worth saying rather than leaving
    /// as an absence: it cascades from `messages`, and every connection is opened with foreign keys
    /// on, so what a deleted conversation leaves behind is the `attachments` row that nothing
    /// cascades to. That row is what this looks for.
    ///
    /// The blob goes last, and only when no attachment still hashes to it. Attachments are
    /// content-addressed, so the same screenshot pasted into two tasks is one file on disk, and
    /// deleting it with the first row would blank the image still on screen in the second.
    fn collect(&self, cutoffs: &Cutoffs) -> Result<Collected, CommandError> {
        let mut connection = self.storage.connection()?;
        let mut statement = connection
            .prepare(
                "SELECT a.id, a.content_hash FROM attachments a
                 LEFT JOIN message_attachments ma ON ma.attachment_id = a.id
                 WHERE ma.attachment_id IS NULL AND a.created_at < ?1",
            )
            .map_err(database_error)?;
        let orphaned = statement
            .query_map([cutoffs.attachments_before], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(database_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(database_error)?;
        drop(statement);
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(database_error)?;
        for (id, _) in &orphaned {
            transaction
                .execute("DELETE FROM attachments WHERE id = ?1", [id])
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
            if references == 0 && fs::remove_file(self.storage.blob_path(hash)).is_ok() {
                blobs_removed += 1;
            }
        }
        Ok(Collected {
            attachments_removed: orphaned.len(),
            blobs_removed,
            ..Collected::default()
        })
    }
}

/// The tasks in the sidebar, and the git worktrees behind them.
///
/// Creating, activating, deleting and merging a task each move a worktree as well as a row, which
/// is why they are one ledger rather than a table and a directory that have to agree.
pub struct Tasks<'a> {
    storage: &'a ProjectStorage,
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

    fn create_record(
        &self,
        switch: &Switch<'_>,
        carry_changes: bool,
    ) -> Result<StoredChat, CommandError> {
        let _checkout = self.storage.claim_checkout()?;
        let task_id = Uuid::now_v7().to_string();
        let branch_name = task_branch_name(&task_id);
        // The base is read only once there is a repository to read it from: a project that has no
        // Git yet has no base branch either, and asking for one is an error rather than an absence.
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
        // A new task the checkout never moved to is a task whose files are the previous task's. The
        // switch is what makes it real, and a failure to switch takes the row with it.
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
        // The branch first, then the working tree, then the pointer. Nothing records the new task
        // until its files are the ones on disk, so a refused checkout leaves the user on the task
        // they can still see. A project that is not a repository yet has no working tree to move
        // and no branch to move it to; opening another task there is still just a pointer.
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
            // The unsent message belonged to this conversation, so it goes with it.
            transaction
                .execute(
                    "DELETE FROM project_state WHERE key = ?1",
                    [draft_ui_key(task_id)],
                )
                .map_err(database_error)?;
            // The deleted task cannot stay the active one. The most recently worked-on task left
            // takes over, so the user lands on work they recognize rather than an empty new task.
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
        // The task that took over is only the active one on paper until the checkout is on its
        // branch. Deleting the task in front of the user otherwise leaves them looking at a
        // conversation whose files are the deleted task's.
        //
        // Answered rather than dropped. This used to be `let _ = checkout_branch(..)`, so a checkout
        // that would not move produced exactly that — one task's chat over another task's files,
        // with nothing anywhere saying so. The message says the deletion itself did happen.
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
            // A conflict gets its own code and carries the paths, because it is the one failure the
            // window can offer a way out of: the agent can be asked to reconcile those files. Every
            // other failure is a sentence and nothing to do about it.
            let conflicts = failure.conflicts();
            if !conflicts.is_empty() {
                return CommandError::new("task_merge_conflicted", failure.message().to_owned())
                    .with_details(json!({"conflicts": conflicts}));
            }
            // And a resolution that stopped half-way is the other one: the way out of it is
            // discarding the merge, which nothing offers unless this failure says so by name.
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

    // ─── the brief ───────────────────────────────────────────────────────────
    //
    // A task's plan, kept with the task rather than with the project's backups and its remembered
    // window layout. A brief belongs to exactly one task, is created with it, and is deleted by the
    // same cascade — which is a description of a task's own row, not of the project's.
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

        // Named from the ask, here, before any phase runs.
        //
        // A task is otherwise named after its first message, and a planned task's first message is
        // the specification — so every one of them appeared in the sidebar as "GOAL During active
        // combat, ui_cancel opens PauseMenu above the H…", which names the output rather than the
        // job and is indistinguishable from the next planned task's. The same `'New task'` guard the
        // first-message path uses keeps this from overwriting a name that is already better.
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
        // A task is merged from its own branch. Merging one the user is not on would move the
        // checkout under them and leave them reading another task's files afterwards.
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
    fn collect(&self, _cutoffs: &Cutoffs) -> Result<Collected, CommandError> {
        Ok(Collected::default())
    }
}

/// Editor runs, and the output they produced.
///
/// A run row is opened when the editor starts and closed when it stops. The lines arrive in
/// batches while it is alive and stay findable once it is gone, which is when they are worth
/// reading.
pub struct Runs<'a> {
    storage: &'a ProjectStorage,
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
    fn collect(&self, cutoffs: &Cutoffs) -> Result<Collected, CommandError> {
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

/// What the agent has been told to remember, and the embeddings that find it again.
pub struct Memories<'a> {
    storage: &'a ProjectStorage,
}

impl Memories<'_> {
    pub fn upsert(&self, request: &UpsertMemoryRequest) -> Result<MemoryRecord, CommandError> {
        self.upsert_record(request)
            .map_err(CommandError::or_coded("memory_not_saved"))
    }

    fn upsert_record(&self, request: &UpsertMemoryRequest) -> Result<MemoryRecord, CommandError> {
        validate_memory(request)?;
        let (_write_guard, mut connection) = self.storage.write_connection()?;
        if let Some(task_id) = &request.task_id {
            require_task(&connection, task_id)?;
        }
        let id = request
            .id
            .clone()
            .unwrap_or_else(|| Uuid::now_v7().to_string());
        let now = now_millis()?;
        let provenance = serde_json::to_string(&request.provenance).map_err(|error| {
            CommandError::from(format!("Could not serialize memory provenance: {error}"))
        })?;
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
        memory_by_id(&connection, &id)?
            .ok_or_else(|| CommandError::from("The stored memory was not found".to_owned()))
    }

    pub fn save_embedding(&self, request: &SaveMemoryEmbeddingRequest) -> Result<(), CommandError> {
        self.store_embedding(request)
            .map_err(CommandError::or_coded("memory_embedding_not_saved"))
    }

    fn store_embedding(&self, request: &SaveMemoryEmbeddingRequest) -> Result<(), CommandError> {
        let (_write_guard, mut connection) = self.storage.write_connection()?;
        self.write_embedding(&mut connection, request)
    }

    /// Writes one vector into both tables, on a connection whose write lock the caller already has.
    ///
    /// Split out of [`Memories::save_embedding`] for the backfill in [`Memories::collect`], which
    /// runs inside maintenance's single write lock. The lock is a plain mutex and is not reentrant,
    /// so a re-embed that went through `save_embedding` would deadlock against the pass that asked
    /// for it.
    fn write_embedding(
        &self,
        connection: &mut Connection,
        request: &SaveMemoryEmbeddingRequest,
    ) -> Result<(), CommandError> {
        validate_embedding(request)?;
        let task_id = connection
            .query_row(
                "SELECT task_id FROM memory_items WHERE id = ?1",
                [&request.memory_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()
            .map_err(database_error)?
            .ok_or_else(|| CommandError::from("The memory record was not found".to_owned()))?;
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
    pub fn missing_embeddings(&self, limit: usize) -> Result<Vec<MemoryRecord>, CommandError> {
        self.records_missing_embeddings(limit)
            .map_err(CommandError::or_coded("memory_unavailable"))
    }

    /// Every vector the maintenance backfill is about to write, worked out before the lock.
    ///
    /// None of this needs the write lock and all of it is slow. Reading which memories have no
    /// vector is a read, and turning their text into a vector is a round trip to the memory worker
    /// *subprocess* — up to [`BACKFILL_LIMIT`] of them, one after another. Held under the project's
    /// single write mutex, a project with two hundred unembedded memories blocks every chat save,
    /// sketch keep, memory upsert and task write for the whole pass.
    ///
    /// It stops at the first failure, because a worker that cannot answer for one memory cannot
    /// answer for the next two hundred either, and each attempt would pay the same timeout.
    pub(crate) fn embeddings_to_restore(&self) -> Result<Vec<PendingEmbedding>, CommandError> {
        let mut prepared = Vec::new();
        for memory in self.missing_embeddings(BACKFILL_LIMIT)? {
            let Ok(vector) = crate::project_memory::memory_vector(&memory.content) else {
                break;
            };
            prepared.push(PendingEmbedding {
                request: SaveMemoryEmbeddingRequest {
                    memory_id: memory.id,
                    model: MEMORY_EMBEDDING_MODEL.to_owned(),
                    vector,
                },
                content: memory.content,
            });
        }
        Ok(prepared)
    }

    fn records_missing_embeddings(&self, limit: usize) -> Result<Vec<MemoryRecord>, CommandError> {
        let connection = self.storage.connection()?;
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

    /// One memory by id, or nothing when the project has never held it.
    pub fn get(&self, id: &str) -> Result<Option<MemoryRecord>, CommandError> {
        let connection = self
            .storage
            .connection()
            .map_err(CommandError::or_coded("memory_unavailable"))?;
        memory_by_id(&connection, id)
    }

    /// Every memory the project holds, most recently changed first.
    ///
    /// Search cannot answer this and is not a narrower version of it. Search needs a query, ranks
    /// what it finds, and reads only `confirmed` rows — which is precisely the set a person
    /// reviewing this cannot see past. A memory demoted to `candidate` has been taken away from the
    /// model and still has to be visible to whoever demoted it, or the demotion looks like a delete.
    pub fn list(&self, limit: usize) -> Result<Vec<MemoryRecord>, CommandError> {
        self.listed_records(limit)
            .map_err(CommandError::or_coded("memory_unavailable"))
    }

    fn listed_records(&self, limit: usize) -> Result<Vec<MemoryRecord>, CommandError> {
        let connection = self.storage.connection()?;
        let mut statement = connection
            .prepare(&format!(
                "SELECT {MEMORY_COLUMNS} FROM memory_items
                 ORDER BY updated_at DESC, id DESC
                 LIMIT ?1"
            ))
            .map_err(database_error)?;
        let rows = statement
            .query_map([limit as i64], memory_columns)
            .map_err(database_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(database_error)?;
        rows.into_iter().map(memory_record).collect()
    }

    /// Forgets one memory for good.
    ///
    /// The vector goes with it without being named here: the embedding cascades on the foreign key
    /// and `memory_items_ad_vectors` deletes the `vec0` row the cascade cannot reach. A row that is
    /// not there is reported rather than passed over, because the caller is a person who just
    /// pressed Delete on something the list showed them.
    pub fn delete(&self, id: &str) -> Result<(), CommandError> {
        self.delete_record(id)
            .map_err(CommandError::or_coded("memory_not_deleted"))
    }

    fn delete_record(&self, id: &str) -> Result<(), CommandError> {
        let (_write_guard, connection) = self.storage.write_connection()?;
        let removed = connection
            .execute("DELETE FROM memory_items WHERE id = ?1", [id])
            .map_err(database_error)?;
        if removed == 0 {
            return Err(CommandError::new(
                "memory_not_found",
                format!("There is no memory {id} to delete"),
            ));
        }
        Ok(())
    }

    pub fn search(
        &self,
        request: &SearchMemoryRequest,
    ) -> Result<Vec<MemorySearchResult>, CommandError> {
        self.search_records(request)
            .map_err(CommandError::or_coded("memory_unavailable"))
    }

    fn search_records(
        &self,
        request: &SearchMemoryRequest,
    ) -> Result<Vec<MemorySearchResult>, CommandError> {
        let limit = request.limit.unwrap_or(10).clamp(1, 50);
        if request.query.trim().is_empty() && request.vector.is_none() {
            return Err(CommandError::from(
                "Memory search requires text or a query vector".to_owned(),
            ));
        }
        if let Some(vector) = &request.vector {
            validate_vector(vector)?;
        }
        let connection = self.storage.connection()?;
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

    /// The vectors that should exist and do not, and the ones that exist and should not.
    ///
    /// Restoring is what this view collects rather than what it deletes, and it is the only upkeep
    /// of the six that puts something back. A memory with no vector is not visible as broken: the
    /// hybrid search still answers, having quietly become lexical-only for that row, so nothing
    /// short of this ever notices.
    ///
    /// The embedding itself has to leave the crate — the vector comes from the memory worker, which
    /// `storage` cannot reach — so `project_memory` supplies it and this owns both writes. It used
    /// to be the other way round: the whole backfill lived in `project_memory` and `lib.rs` ran it
    /// after `run_maintenance` returned, which is exactly why the returned result carried a zero the
    /// caller had to overwrite.
    ///
    /// The vectors arrive already computed, from [`embeddings_to_restore`](Self::embeddings_to_restore),
    /// which ran before the write lock was taken. Only the writes belong under it.
    ///
    /// An orphan vector is a row in `memory_vectors` whose memory is gone. Since schema V3 a
    /// trigger removes it — the vec0 virtual table is outside the `ON DELETE CASCADE` that
    /// `memory_embeddings` gets — so what is left is what a database written before V3 kept, and a
    /// vector nothing can delete is a vector the cosine search keeps ranking forever.
    fn collect(
        &self,
        _cutoffs: &Cutoffs,
        pending: &[PendingEmbedding],
    ) -> Result<Collected, CommandError> {
        let mut connection = self.storage.connection()?;
        let mut restored = 0;
        for entry in pending {
            // Re-read under the lock, because the vector was computed without it. A memory deleted
            // in that window has nothing to write; one edited in it had its vector dropped on
            // purpose, and writing this one back would index the row under text it no longer holds
            // while `missing_embeddings` stops reporting it. Both are skipped rather than raised:
            // the backfill is one of six upkeep views and must not take the other five down.
            let current = connection
                .query_row(
                    "SELECT content FROM memory_items WHERE id = ?1",
                    [&entry.request.memory_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(database_error)?;
            if current.as_deref() != Some(entry.content.as_str()) {
                continue;
            }
            if self
                .write_embedding(&mut connection, &entry.request)
                .is_err()
            {
                continue;
            }
            restored += 1;
        }
        let mut statement = connection
            .prepare(
                "SELECT memory_id FROM memory_vectors
                 WHERE memory_id NOT IN (SELECT id FROM memory_items)",
            )
            .map_err(database_error)?;
        let orphaned = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(database_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(database_error)?;
        drop(statement);
        for memory_id in &orphaned {
            connection
                .execute(
                    "DELETE FROM memory_vectors WHERE memory_id = ?1",
                    [memory_id],
                )
                .map_err(database_error)?;
        }
        let refiled = self.refile_drifted_vectors(&connection)?;
        Ok(Collected {
            memory_embeddings_restored: restored,
            memory_vectors_removed: orphaned.len(),
            memory_vectors_refiled: refiled,
            ..Collected::default()
        })
    }

    /// Vectors filed under a scope their memory has left, put back under the one it has now.
    ///
    /// `scope_key` is a partition key: [`Memories::search`] asks for one scope and vec0 answers
    /// only out of that partition, so a vector filed under the wrong one is invisible to search
    /// rather than merely mis-ranked. It is written once, by [`Memories::write_embedding`], and the
    /// only thing that invalidates it on a scope change is [`Memories::upsert`].
    ///
    /// Which leaves the case nothing was watching. `memory_items.task_id` is `ON DELETE SET NULL`,
    /// so deleting a task rewrites its memories to project scope without going through `upsert` at
    /// all: the rows survive, the vectors stay filed under a task id nothing can name any more, and
    /// the memories are lexical-only from then on. Permanently — `missing_embeddings` keys on
    /// `memory_embeddings`, which is still there, so the backfill never looks at them, and the
    /// orphan sweep above only removes vectors whose memory is gone.
    ///
    /// Re-filed from the stored embedding rather than re-embedded: the vector is the same vector,
    /// only the partition it sits in is wrong, and the worker is a subprocess round trip away. A
    /// row with no stored embedding is one the backfill already reports, so its stale vector is
    /// simply dropped.
    fn refile_drifted_vectors(&self, connection: &Connection) -> Result<usize, CommandError> {
        let mut statement = connection
            .prepare("SELECT memory_id, scope_key FROM memory_vectors")
            .map_err(database_error)?;
        let filed = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(database_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(database_error)?;
        drop(statement);
        let mut refiled = 0;
        for (memory_id, scope) in filed {
            let Some(belongs) = connection
                .query_row(
                    "SELECT COALESCE(task_id, 'project') FROM memory_items WHERE id = ?1",
                    [&memory_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(database_error)?
            else {
                // Its memory is gone, which is the orphan sweep's to answer for and it already has.
                continue;
            };
            if belongs == scope {
                continue;
            }
            let embedding = connection
                .query_row(
                    "SELECT embedding FROM memory_embeddings WHERE memory_id = ?1",
                    [&memory_id],
                    |row| row.get::<_, Vec<u8>>(0),
                )
                .optional()
                .map_err(database_error)?;
            connection
                .execute(
                    "DELETE FROM memory_vectors WHERE memory_id = ?1",
                    [&memory_id],
                )
                .map_err(database_error)?;
            let Some(embedding) = embedding else {
                continue;
            };
            connection
                .execute(
                    "INSERT INTO memory_vectors (memory_id, embedding, scope_key)
                     VALUES (?1, ?2, ?3)",
                    params![memory_id, embedding, belongs],
                )
                .map_err(database_error)?;
            refiled += 1;
        }
        Ok(refiled)
    }
}

/// The project itself: how its workspace was left, what its agent is told, and the database's own
/// upkeep.
pub struct Project<'a> {
    storage: &'a ProjectStorage,
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
    fn collect(&self, cutoffs: &Cutoffs) -> Result<Collected, CommandError> {
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
        // Not `?`. This is one view's preparation, and a memory table that cannot be read is not a
        // reason to leave the attachments, the run directories, the stale manual answers and the old
        // backups where they are. Its own view reports the zero it collected.
        let pending = self
            .storage
            .memory()
            .embeddings_to_restore()
            .unwrap_or_default();
        let _write_guard = self.storage.write_lock()?;
        let cutoffs = Cutoffs::current()?;
        let mut collected = MaintenanceResult::default();
        // Every view is asked, whatever the one before it answered. A view's upkeep is its own —
        // one unremovable file under `sketches` has nothing to do with the memory backfill or the
        // backups — and stopping at the first failure meant one such file permanently disabled the
        // other five. The pass still fails, with the first reason, once all six have run.
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

fn copy_directory(source: &Path, destination: &Path) -> Result<(), CommandError> {
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
    // A rename keeps the move atomic and cheap when both sides share a filesystem, which is the
    // common case. When they do not, a copy is the only way across, and the original is left where
    // it was rather than deleted: the copy is the one Gofer will use from now on, and a stale
    // duplicate is a far smaller problem than a half-moved history.
    if fs::rename(&source, data_root).is_err() {
        copy_directory(&source, data_root)?;
    }
    catalog
        .execute("DELETE FROM projects WHERE id = ?1", [&project_id])
        .map_err(database_error)?;
    Ok(())
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

/// The branch a task's worktree is checked out on, derived from the task's own identifier.
///
/// Derived rather than stored so a task whose worktree was never recorded can still be given the
/// branch it would have had, and so adopting one twice cannot invent a second branch.
fn task_branch_name(task_id: &str) -> String {
    let suffix = task_id
        .chars()
        .filter(|character| *character != '-')
        .take(12)
        .collect::<String>();
    format!("gofer/task-{suffix}")
}

fn active_task_id(connection: &Connection) -> Result<Option<String>, CommandError> {
    connection
        .query_row(
            "SELECT value FROM project_state WHERE key = 'active_task_id'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(database_error)
}

fn set_active_task(connection: &Connection, task_id: &str) -> Result<(), CommandError> {
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
fn next_task_id(connection: &Connection) -> Result<Option<String>, CommandError> {
    connection
        .query_row(
            "SELECT id FROM tasks ORDER BY updated_at DESC, created_at DESC LIMIT 1",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(database_error)
}

fn require_task(connection: &Connection, task_id: &str) -> Result<(), CommandError> {
    let exists = connection
        .query_row("SELECT 1 FROM tasks WHERE id = ?1", [task_id], |_| Ok(()))
        .optional()
        .map_err(database_error)?
        .is_some();
    if !exists {
        // Named where it is known. A task that is gone is a task the window should route away
        // from; every method that used to flatten this into its own one code left the renderer
        // unable to tell it from a database it should simply try again.
        return Err(CommandError::new(
            "task_not_found",
            "The task was not found",
        ));
    }
    Ok(())
}

fn validate_log_entries(entries: &[GodotLogEntry]) -> Result<(), CommandError> {
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

fn validate_memory(request: &UpsertMemoryRequest) -> Result<(), CommandError> {
    if !["decision", "preference", "fact", "issue", "summary"].contains(&request.kind.as_str()) {
        return Err(CommandError::from("The memory kind is invalid".to_owned()));
    }
    if !["candidate", "confirmed", "superseded"].contains(&request.state.as_str()) {
        return Err(CommandError::from("The memory state is invalid".to_owned()));
    }
    if request.content.trim().is_empty() {
        return Err(CommandError::from(
            "Memory content cannot be empty".to_owned(),
        ));
    }
    if request.content.len() > 64 * 1024 {
        return Err(CommandError::from(
            "Memory content cannot exceed 64 KiB".to_owned(),
        ));
    }
    if !request.provenance.is_object() {
        return Err(CommandError::from(
            "Memory provenance must be an object".to_owned(),
        ));
    }
    if request.provenance.to_string().len() > 256 * 1024 {
        return Err(CommandError::from(
            "Memory provenance cannot exceed 256 KiB".to_owned(),
        ));
    }
    Ok(())
}

fn validate_embedding(request: &SaveMemoryEmbeddingRequest) -> Result<(), CommandError> {
    if request.model.trim() != MEMORY_EMBEDDING_MODEL {
        return Err(format!("Memory embeddings must use {MEMORY_EMBEDDING_MODEL}").into());
    }
    validate_vector(&request.vector)
}

fn validate_vector(vector: &[f32]) -> Result<(), CommandError> {
    if vector.len() != MEMORY_EMBEDDING_DIMENSIONS {
        return Err(format!(
            "Memory vectors must contain {MEMORY_EMBEDDING_DIMENSIONS} dimensions"
        )
        .into());
    }
    if vector.iter().any(|value| !value.is_finite()) {
        return Err(CommandError::from(
            "Memory vectors must contain only finite numbers".to_owned(),
        ));
    }
    let magnitude = vector
        .iter()
        .map(|value| f64::from(*value) * f64::from(*value))
        .sum::<f64>()
        .sqrt();
    if (magnitude - 1.0).abs() > 0.01 {
        return Err(CommandError::from(
            "Memory vectors must be normalized".to_owned(),
        ));
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

/// The columns every memory read selects, in the order both readers below expect them.
const MEMORY_COLUMNS: &str = "id, task_id, kind, state, content, provenance_json,
                              superseded_by, created_at, updated_at";

/// One row as SQLite hands it over, before the JSON and the timestamps are made sense of.
///
/// Split from [`memory_record`] because the two failures are different: a column rusqlite cannot
/// read is a database fault it reports itself, and provenance that will not parse is ours. Keeping
/// them in one closure meant `query_map` had to carry a `Result` inside a `Result`.
type MemoryColumns = (
    String,
    Option<String>,
    String,
    String,
    String,
    String,
    Option<String>,
    i64,
    i64,
);

fn memory_columns(row: &rusqlite::Row<'_>) -> rusqlite::Result<MemoryColumns> {
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
}

fn memory_record(row: MemoryColumns) -> Result<MemoryRecord, CommandError> {
    Ok(MemoryRecord {
        id: row.0,
        task_id: row.1,
        kind: row.2,
        state: row.3,
        content: row.4,
        provenance: serde_json::from_str(&row.5).map_err(|error| {
            CommandError::from(format!("Stored memory provenance is invalid: {error}"))
        })?,
        superseded_by: row.6,
        created_at: from_database_u64(row.7, "memory creation time")?,
        updated_at: from_database_u64(row.8, "memory update time")?,
    })
}

fn memory_by_id(connection: &Connection, id: &str) -> Result<Option<MemoryRecord>, CommandError> {
    connection
        .query_row(
            &format!("SELECT {MEMORY_COLUMNS} FROM memory_items WHERE id = ?1"),
            [id],
            memory_columns,
        )
        .optional()
        .map_err(database_error)?
        .map(memory_record)
        .transpose()
}

fn empty_object() -> Value {
    serde_json::json!({})
}

fn validate_chat(chat: &StoredChat) -> Result<(), CommandError> {
    if chat.messages.len() > MAX_STORED_CHAT_MESSAGES {
        return Err(format!(
            "Stored chats cannot contain more than {MAX_STORED_CHAT_MESSAGES} messages"
        )
        .into());
    }
    let serialized_size = serde_json::to_vec(chat)
        .map_err(|_| CommandError::from("Stored chat data is invalid".to_owned()))?
        .len();
    if serialized_size > MAX_STORED_CHAT_BYTES {
        return Err(CommandError::from(
            "Stored chat data cannot exceed 32 MiB".to_owned(),
        ));
    }
    for message in &chat.messages {
        if message.sender != "user" && message.sender != "assistant" {
            return Err(CommandError::from(
                "Stored chat messages have an invalid sender".to_owned(),
            ));
        }
        if message.text.len() > MAX_STORED_MESSAGE_BYTES {
            return Err(CommandError::from(
                "Stored chat messages cannot exceed 1 MiB".to_owned(),
            ));
        }
        if message.attachments.len() > 5 {
            return Err(CommandError::from(
                "Stored chat messages cannot contain more than 5 images".to_owned(),
            ));
        }
        for attachment in &message.attachments {
            validate_attachment(attachment)?;
        }
    }
    Ok(())
}

pub fn validate_attachment(attachment: &StoredAttachment) -> Result<(), CommandError> {
    if attachment.id.is_empty()
        || attachment.id.len() > 64
        || !attachment
            .id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-')
    {
        return Err(CommandError::from(
            "The attachment ID is invalid".to_owned(),
        ));
    }
    if attachment.name.trim().is_empty() || attachment.name.len() > 255 {
        return Err(CommandError::from(
            "Attachment names must contain between 1 and 255 bytes".to_owned(),
        ));
    }
    if attachment.size == 0 || attachment.size > 10 * 1024 * 1024 {
        return Err(CommandError::from(
            "Images must be between 1 byte and 10 MiB".to_owned(),
        ));
    }
    if !["image/png", "image/jpeg", "image/webp", "image/gif"]
        .contains(&attachment.mime_type.as_str())
    {
        return Err(CommandError::from(
            "Only PNG, JPEG, WebP, and GIF images are supported".to_owned(),
        ));
    }
    Ok(())
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
mod tests {
    use super::*;
    use tempfile::TempDir;

    /// A Switch with nothing to stop, for the tests that are not about stopping anything.
    static NOTHING_TO_STOP: fn(&Path) -> Result<(), String> = |_| Ok(());

    /// Records every workspace the Switch was asked to release, so a test can assert the order.
    #[derive(Default)]
    struct Released(Mutex<Vec<PathBuf>>);

    impl Released {
        fn recording(&self) -> impl Fn(&Path) -> Result<(), String> + use<'_> {
            move |path| {
                self.0
                    .lock()
                    .expect("the recorder")
                    .push(path.to_path_buf());
                Ok(())
            }
        }

        fn paths(&self) -> Vec<PathBuf> {
            self.0.lock().expect("the recorder").clone()
        }
    }

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

    fn git(directory: &Path, arguments: &[&str]) {
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
    fn make_repository(workspace: &Path) {
        git(workspace, &["init", "-b", "main"]);
        git(workspace, &["config", "user.name", "Gofer"]);
        git(workspace, &["config", "user.email", "gofer@localhost"]);
        fs::write(workspace.join("project.godot"), "config_version=5\n").expect("project file");
        git(workspace, &["add", "--all"]);
        git(workspace, &["commit", "-m", "Add the Godot project"]);
    }

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

        // A second open has nothing left to carry, and must not reach back into the old directory.
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

    fn git_text(workspace: &Path, arguments: &[&str]) -> String {
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
    fn committed_repository(root: &Path) -> PathBuf {
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

        // No task could be created, so nothing claims a worktree the repository cannot supply.
        assert_eq!(storage.tasks().list().expect("tasks").len(), 0);
    }

    #[test]
    fn chat_and_content_addressed_attachments_round_trip() {
        let directory = TempDir::new().expect("temporary directory");
        let storage = storage(&directory);
        let attachment = attachment("018f47aa-09d2-7b34-a2d3-8c4e6f123456");
        storage
            .chats()
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

        storage.chats().save(&chat).expect("save chat");

        let loaded = storage.chats().load(None).expect("load chat");
        assert_eq!(loaded.messages.len(), 1);
        assert_eq!(loaded.messages[0].text, "Look");
        assert_eq!(loaded.agent_messages.len(), 1);
        assert_eq!(
            storage
                .chats()
                .read_attachment(&attachment)
                .expect("read attachment"),
            b"hi"
        );
    }

    /// A save is the whole conversation, so a save holding fewer messages is a caller that lost
    /// some. The renderer used to shorten the array whenever a turn was retried, and this write
    /// deleted the difference from the database with nothing to restore it from.
    #[test]
    fn a_shorter_chat_is_refused_rather_than_saved_over_a_longer_one() {
        let directory = TempDir::new().expect("temporary directory");
        let storage = storage(&directory);
        let message = |id: u64, text: &str| StoredMessage {
            id,
            sender: if id % 2 == 1 { "user" } else { "assistant" }.to_owned(),
            text: text.to_owned(),
            timestamp: id * 10,
            attachments: Vec::new(),
            extra: serde_json::Map::new(),
        };
        let full = StoredChat {
            task_id: None,
            messages: vec![
                message(1, "First"),
                message(2, "First reply"),
                message(3, "Second"),
                message(4, "Second reply"),
            ],
            agent_messages: Vec::new(),
        };
        storage.chats().save(&full).expect("save four messages");
        let task_id = storage.chats().load(None).expect("stored chat").task_id;

        let truncated = StoredChat {
            task_id: task_id.clone(),
            messages: full.messages[..2].to_vec(),
            agent_messages: Vec::new(),
        };
        let refusal = storage
            .chats()
            .save(&truncated)
            .expect_err("a shorter chat is refused");
        assert!(refusal.message.contains("2 would be lost"), "{refusal}");

        let loaded = storage.chats().load(None).expect("load chat");
        assert_eq!(loaded.messages.len(), 4);
        assert_eq!(loaded.messages[3].text, "Second reply");
    }

    /// The retry this refusal exists for: the same number of messages, the last one rewritten.
    #[test]
    fn a_reply_rewritten_in_place_saves_over_the_row_it_kept() {
        let directory = TempDir::new().expect("temporary directory");
        let storage = storage(&directory);
        let message = |id: u64, sender: &str, text: &str| StoredMessage {
            id,
            sender: sender.to_owned(),
            text: text.to_owned(),
            timestamp: id * 10,
            attachments: Vec::new(),
            extra: serde_json::Map::new(),
        };
        let chat = StoredChat {
            task_id: None,
            messages: vec![
                message(1, "user", "Build it"),
                message(2, "assistant", "It failed"),
            ],
            agent_messages: Vec::new(),
        };
        storage.chats().save(&chat).expect("save the failed turn");
        let task_id = storage.chats().load(None).expect("stored chat").task_id;

        storage
            .chats()
            .save(&StoredChat {
                task_id,
                messages: vec![
                    message(1, "user", "Build it"),
                    message(2, "assistant", "It worked"),
                ],
                agent_messages: Vec::new(),
            })
            .expect("save the retried turn");

        let loaded = storage.chats().load(None).expect("load chat");
        assert_eq!(loaded.messages.len(), 2);
        assert_eq!(loaded.messages[1].id, 2);
        assert_eq!(loaded.messages[1].text, "It worked");
    }

    /// The window names the task it is drawing, and gets that task's conversation.
    ///
    /// It used to get whichever task was active, and the two disagree for exactly as long as a
    /// switch takes — which is when the window asks, because the workspace remounts the moment the
    /// route resolves. A task opened a second time arrived holding the conversation of the task it
    /// was opened from.
    #[test]
    fn a_named_chat_is_read_by_name_not_by_which_task_is_active() {
        let directory = TempDir::new().expect("temporary storage");
        let storage = storage(&directory);
        let message = |id: u64, text: &str| StoredMessage {
            id,
            sender: "user".to_owned(),
            text: text.to_owned(),
            timestamp: id * 10,
            attachments: Vec::new(),
            extra: serde_json::Map::new(),
        };
        let first = storage.chats().load(None).expect("first task");
        let first_task_id = first.task_id.clone().expect("first task ID");
        storage
            .chats()
            .save(&StoredChat {
                task_id: Some(first_task_id.clone()),
                messages: vec![message(1, "The first conversation")],
                agent_messages: Vec::new(),
            })
            .expect("save the first conversation");

        // A second task, which creating makes the active one.
        let second = storage
            .tasks()
            .create(&storage.switch(&NOTHING_TO_STOP))
            .expect("create task");
        let second_task_id = second.task_id.expect("second task ID");
        assert_ne!(first_task_id, second_task_id);

        let named = storage
            .chats()
            .load(Some(&first_task_id))
            .expect("the named chat");
        assert_eq!(named.task_id.as_deref(), Some(first_task_id.as_str()));
        assert_eq!(named.messages.len(), 1);
        assert_eq!(named.messages[0].text, "The first conversation");
        // And the active one is still answered when nothing is named.
        let active = storage.chats().load(None).expect("the active chat");
        assert_eq!(active.task_id.as_deref(), Some(second_task_id.as_str()));
        assert!(active.messages.is_empty());
    }

    /*
     * A chat asked for by a name nothing holds is refused rather than answered with another one.
     *
     * And it is refused by the name of what actually went wrong. A missing task, a database another
     * process is holding and a row that will not parse all used to arrive as `chat_unavailable`, so
     * the renderer could not tell one it should route away from from one worth trying again.
     */
    #[test]
    fn a_chat_named_for_a_task_that_is_gone_is_refused() {
        let directory = TempDir::new().expect("temporary storage");
        let storage = storage(&directory);
        let failure = storage
            .chats()
            .load(Some("01000000-0000-7000-8000-000000000000"))
            .expect_err("a task that does not exist");
        assert_eq!(failure.code, "task_not_found");
        assert!(!failure.retryable, "a task that is gone stays gone");
    }

    #[test]
    fn cloned_storage_serializes_writes() {
        let directory = TempDir::new().expect("temporary storage");
        let storage = storage(&directory);
        let chat = storage.chats().load(None).expect("active chat");
        let clone = storage.clone();
        assert!(Arc::ptr_eq(&storage.write_lock, &clone.write_lock));

        let guard = storage.write_lock().expect("write lock");
        let (started_sender, started_receiver) = std::sync::mpsc::channel();
        let (result_sender, result_receiver) = std::sync::mpsc::channel();
        let writer = std::thread::spawn(move || {
            started_sender.send(()).expect("signal writer start");
            result_sender
                .send(clone.chats().save(&chat))
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
    fn storage_operations_cover_invalid_state_and_conflict_branches() {
        let directory = TempDir::new().expect("temporary directory");
        let storage = storage(&directory);
        let workspace = storage.tasks().agent_workspace().expect("agent workspace");
        assert!(
            storage
                .runs()
                .start_in(
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
                .runs()
                .finish(&FinishGodotRunRequest {
                    run_id: "missing".to_owned(),
                    status: "running".to_owned(),
                    exit_code: None,
                })
                .is_err()
        );
        assert!(
            storage
                .runs()
                .finish(&FinishGodotRunRequest {
                    run_id: "missing".to_owned(),
                    status: "failed".to_owned(),
                    exit_code: None,
                })
                .is_err()
        );
        assert!(
            storage
                .memory()
                .search(&SearchMemoryRequest {
                    query: " ".to_owned(),
                    task_id: None,
                    vector: None,
                    limit: None,
                })
                .is_err()
        );

        let stored = attachment("conflict-id");
        assert!(storage.chats().save_attachment(&stored, b"x").is_err());
        storage
            .chats()
            .save_attachment(&stored, b"hi")
            .expect("save attachment");
        storage
            .chats()
            .save_attachment(&stored, b"hi")
            .expect("idempotent attachment save");
        let renamed = StoredAttachment {
            name: "other.png".to_owned(),
            ..stored.clone()
        };
        assert!(storage.chats().save_attachment(&renamed, b"hi").is_err());
        assert!(storage.chats().read_attachment(&renamed).is_err());

        let mut vector = vec![0.0; MEMORY_EMBEDDING_DIMENSIONS];
        vector[0] = 1.0;
        assert!(
            storage
                .memory()
                .search(&SearchMemoryRequest {
                    query: String::new(),
                    task_id: None,
                    vector: Some(vector),
                    limit: Some(1),
                })
                .expect("empty vector search")
                .is_empty()
        );
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

        // Recorded, so the next call answers from the table rather than rebuilding.
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
            .create_carrying_changes(&storage.switch(&NOTHING_TO_STOP))
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
            .create(&storage.switch(&NOTHING_TO_STOP))
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

        // `ProjectStorage::open` ensures an active task exists, but the plain test workspace is
        // not a Git repository, so there is no worktree to give the task and none to adopt.
        assert!(
            storage
                .tasks()
                .active_workspace()
                .unwrap_err()
                .message
                .contains("not a Git repository"),
            "active_task_workspace must fail rather than fall back"
        );

        // `agent_workspace` still falls back to the root workspace for existing UI paths.
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
                .create(&storage.switch(&NOTHING_TO_STOP))
                .expect("create task");
        }
        let before: Vec<String> = storage
            .tasks()
            .list()
            .expect("tasks")
            .into_iter()
            .map(|task| task.id)
            .collect();
        // Three made here, plus the one a new project opens with.
        assert_eq!(before.len(), 4);

        // The oldest one, which is the row furthest from where the reorder would put it.
        let opened = before.last().expect("an oldest task").clone();
        storage
            .tasks()
            .activate(&opened, &storage.switch(&NOTHING_TO_STOP))
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
                .create(&storage.switch(&NOTHING_TO_STOP))
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
            .activate(&oldest, &storage.switch(&NOTHING_TO_STOP))
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

    #[test]
    fn projects_and_new_tasks_are_isolated() {
        let directory = TempDir::new().expect("temporary directory");
        let storage = storage(&directory);
        storage
            .chats()
            .save(&StoredChat {
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

        let previous = storage.chats().load(None).expect("first task");
        let next = storage
            .tasks()
            .create(&storage.switch(&NOTHING_TO_STOP))
            .expect("create task");
        storage
            .chats()
            .save(&previous)
            .expect("save completed task");

        assert!(next.messages.is_empty());
        assert!(
            storage
                .chats()
                .load(None)
                .expect("active chat")
                .messages
                .is_empty()
        );
        let tasks = storage.tasks().list().expect("parallel tasks");
        assert_eq!(tasks.len(), 2);
        assert!(tasks.iter().all(|task| task.status == "active"));
        let previous_task_id = previous.task_id.expect("previous task ID");
        let restored = storage
            .tasks()
            .activate(&previous_task_id, &storage.switch(&NOTHING_TO_STOP))
            .expect("activate previous task");
        assert_eq!(restored.messages[0].text, "First task");
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
            .create(&storage.switch(&NOTHING_TO_STOP))
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
            .delete(&doomed, &storage.switch(&recording))
            .expect("delete task");

        // The session is stopped before the checkout moves off the branch being deleted, and again
        // before it moves onto the task that took over. Deleting a task is two Switches, not one.
        assert_eq!(released.paths(), vec![workspace.clone(), workspace.clone()]);
        assert!(
            git_text(&workspace, &["branch", "--list", &worktree.branch_name]).is_empty(),
            "the task branch must be gone from the repository"
        );
        // The task the user worked on before takes over, with its chat intact, and the checkout is
        // moved onto its branch rather than left on the deleted task's.
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

    /*
     * A checkout that would not move is answered, not dropped.
     *
     * The move onto the task that takes over used to be `let _ = checkout_branch(..)`, so an editor
     * that would not stop produced exactly the state the whole Switch exists to prevent — one task's
     * chat over another task's files — with nothing anywhere saying so.
     */
    #[test]
    fn a_delete_that_cannot_land_on_the_next_task_says_so() {
        let directory = TempDir::new().expect("temporary directory");
        let workspace = committed_repository(directory.path());
        let storage =
            ProjectStorage::open(&directory.path().join("data"), &workspace).expect("storage");
        let first = storage.tasks().active().expect("read").expect("a task");
        let doomed = storage
            .tasks()
            .create(&storage.switch(&NOTHING_TO_STOP))
            .expect("create task")
            .task_id
            .expect("task ID");

        // The stop the delete itself needs is allowed; the one the move onto the next task needs is
        // refused, which is the second Switch a delete performs.
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
            .delete(&doomed, &storage.switch(&refuses_the_second))
            .expect_err("a checkout that would not move is reported");
        assert!(
            refusal.message.contains("The task was deleted"),
            "and the message says the deletion did happen: {}",
            refusal.message
        );

        // The task is gone and the pointer moved; only the files are still the deleted task's, and
        // that is exactly what the user has now been told.
        let tasks = storage.tasks().list().expect("remaining tasks");
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].id, first);
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
        // It shares `project_state` with the interface keys, and forgetting it left them alone.
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
            .create(&storage.switch(&NOTHING_TO_STOP))
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
            .delete(&doomed, &storage.switch(&NOTHING_TO_STOP))
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
            .delete(&only, &storage.switch(&NOTHING_TO_STOP))
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
                .delete(&only, &storage.switch(&NOTHING_TO_STOP))
                .is_err()
        );
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
        // The newest table has to exist on a migrated database, not only on one created today: a
        // project opened since before this feature is the only kind that has sketches to lose.
        connection
            .execute_batch(
                "INSERT INTO sketches (id, task_id, question_id, question, label, is_approved, saved_at)
                 VALUES ('question-1-run', 'task-1', 'question-1', 'Where?', 'Dock', 1, 1)",
            )
            .expect("the migrated database carries a usable sketches table");
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
            .create(&storage.switch(&NOTHING_TO_STOP))
            .expect("create a task")
            .task_id
            .expect("the new task's id");

        tasks
            .start_brief(&task_id, "add a pause menu")
            .expect("start the brief");
        tasks.record_brief_phase(&task_id, "refine", "refined", "GOAL\nA pause menu.");
        tasks.record_brief_phase(&task_id, "research", "research", "FILES\n  a.gd");

        // Stopped during grill: the two phases that finished are still here, and the row says where
        // it stopped rather than only that it did.
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
            .create(&storage.switch(&NOTHING_TO_STOP))
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
            .create(&storage.switch(&NOTHING_TO_STOP))
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
            .create(&storage.switch(&NOTHING_TO_STOP))
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

        // A different manual, the other operation, and a different question are all misses.
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
            .chats()
            .save(&StoredChat {
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
        let task = storage.tasks().list().expect("tasks").remove(0);

        assert_eq!(task.title, "Build the player controller");
        // A non-repository workspace records no worktree; git.rs covers the repository path.
        assert!(task.worktree.is_none());
    }

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

        // The stored history is what survives the editor that produced it, so a search names the
        // session as well as the run. A phrase the user typed carries FTS5 operators (`:` and `.`)
        // that would make a bare match expression fail, which is why the needle is quoted.
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

    #[test]
    fn memory_supports_hybrid_search_and_invalidates_stale_embeddings() {
        let directory = TempDir::new().expect("temporary directory");
        let storage = storage(&directory);
        let memory = storage
            .memory()
            .upsert(&UpsertMemoryRequest {
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
            .memory()
            .save_embedding(&SaveMemoryEmbeddingRequest {
                memory_id: memory.id.clone(),
                model: MEMORY_EMBEDDING_MODEL.to_owned(),
                vector: vector.clone(),
            })
            .expect("save embedding");

        let results = storage
            .memory()
            .search(&SearchMemoryRequest {
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
            .memory()
            .upsert(&UpsertMemoryRequest {
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
            .memory()
            .upsert(&UpsertMemoryRequest {
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
            .memory()
            .missing_embeddings(10)
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
            .memory()
            .save_embedding(&SaveMemoryEmbeddingRequest {
                memory_id: memory.id.clone(),
                model: MEMORY_EMBEDDING_MODEL.to_owned(),
                vector,
            })
            .expect("save embedding");
        assert!(
            storage
                .memory()
                .missing_embeddings(10)
                .expect("pending memories")
                .is_empty()
        );

        // Rewriting the content invalidates the vector, which must make it pending again.
        storage
            .memory()
            .upsert(&UpsertMemoryRequest {
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
                .memory()
                .missing_embeddings(10)
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

        // Gofer is gone and comes back. Nothing stopped the run, because nothing was left to.
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
        // Where it got to, not when it was noticed: the last line it recorded.
        assert_eq!(ended_at, i64::try_from(run.started_at + 5_000).unwrap());
        // And appending to it is refused from here on, like any other run that has ended.
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
            .create(&storage.switch(&NOTHING_TO_STOP))
            .expect("task")
            .task_id
            .expect("a task with a worktree");
        let worktree = storage.tasks().active_workspace().expect("worktree");
        assert!(worktree.join("project.godot").is_file());

        // Started over: the worktree directory survives, the repository behind it does not.
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

    /// A repository started over where one already was, keeping the files on disk. Answers the
    /// commit the new history stands at.
    fn committed_repository_in_place(workspace: &Path) -> String {
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
            .create(&storage.switch(&NOTHING_TO_STOP))
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
            .activate(&first, &storage.switch(&NOTHING_TO_STOP))
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
            .create(&storage.switch(&recording))
            .expect("create the second task")
            .task_id
            .expect("task ID");
        assert_eq!(released.paths(), vec![workspace.clone()]);

        released.0.lock().expect("the recorder").clear();
        storage
            .tasks()
            .activate(&first, &storage.switch(&recording))
            .expect("open the first task");
        assert_eq!(released.paths(), vec![workspace.clone()]);

        // Opening the task that is already open moves nothing, so nothing is stopped.
        released.0.lock().expect("the recorder").clear();
        storage
            .tasks()
            .activate(&first, &storage.switch(&recording))
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
            .create(&storage.switch(&NOTHING_TO_STOP))
            .expect("create the second task")
            .task_id
            .expect("task ID");
        // Both branches touch the same tracked file, which is the shape Git refuses a checkout over.
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
            .activate(&first, &storage.switch(&NOTHING_TO_STOP))
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
            .activate(&second, &storage.switch(&NOTHING_TO_STOP))
            .expect("back to the second task");
        assert_eq!(
            fs::read_to_string(workspace.join("project.godot")).expect("project file"),
            "[application]\nname=\"loose\"\n",
            "the loose edit was banked on the branch that made it"
        );
    }

    /*
     * Every task operation that moves the checkout stops what is holding it first.
     *
     * The rule CONTEXT.md states about a Switch, asserted once for all five rather than once per
     * operation. Each used to spell the order out for itself, and every spelling was a place for it
     * to go missing — which is exactly what happened to delete's second move.
     */
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
                .create(&storage.switch(&NOTHING_TO_STOP))
                .expect("a second task")
                .task_id
                .expect("task ID");

            // Refused, so the operation cannot get past the stop. What is asserted is that it asked
            // at all, and that nothing moved when the answer was no.
            let branch_before = git::current_branch(&workspace).expect("a branch");
            let asked = Mutex::new(0);
            let refuses = |_: &Path| {
                *asked.lock().expect("the counter") += 1;
                Err("an editor would not stop".to_owned())
            };
            let switch = storage.switch(&refuses);

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
            .activate("no-such-task", &storage.switch(&recording))
            .expect_err("an unknown task is refused");

        // The situation, not the method it happened in: `task_not_activated` is what this used
        // to say for a stale id, a locked database and a broken branch alike.
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
            .merge(&task, &storage.switch(&recording))
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
            .create(&storage.switch(&NOTHING_TO_STOP))
            .expect("an older task")
            .task_id
            .expect("its id");

        storage
            .tasks()
            .activate(&refactor, &storage.switch(&NOTHING_TO_STOP))
            .expect("open the refactor");
        fs::write(workspace.join("player.gd"), "extends Node\n").expect("the refactor");
        let merged = storage
            .tasks()
            .merge(&refactor, &storage.switch(&NOTHING_TO_STOP))
            .expect("merge the refactor");

        // The user goes back to an older task to look at it, and only then starts the next one.
        storage
            .tasks()
            .activate(&older, &storage.switch(&NOTHING_TO_STOP))
            .expect("open the older task");
        assert!(
            !workspace.join("player.gd").exists(),
            "the older task predates the merge, so its own files are the old ones"
        );
        let next = storage
            .tasks()
            .create(&storage.switch(&NOTHING_TO_STOP))
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

        // The user renames their default branch, which is a thing Git lets them do at any time.
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

        // And the new answer is what the next read gets, without re-deriving every time.
        git_text(&workspace, &["branch", "stray"]);
        assert_eq!(storage.base_branch().expect("a base"), "main");
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
            .create(&storage.switch(&NOTHING_TO_STOP))
            .expect("create the second task")
            .task_id
            .expect("task ID");
        // A third task, so the checkout sits on neither of the two being switched between. A switch
        // to the branch already checked out returns without touching Git, and would race nothing.
        let third = storage
            .tasks()
            .create(&storage.switch(&NOTHING_TO_STOP))
            .expect("create the third task")
            .task_id
            .expect("task ID");
        assert_ne!(third, second);

        // A race is not proved or disproved by one attempt. The second switch is started a little
        // later each round, which walks it across the first one's whole run.
        for round in 0..60u64 {
            // Enough loose work that staging it takes long enough for the other switch to arrive.
            // Written fresh each round, because the round before it banked what was there.
            for index in 0..300 {
                fs::write(workspace.join(format!("loose{index}.gd")), "extends Node\n")
                    .expect("loose work");
            }
            let (left, right) = std::thread::scope(|scope| {
                let left = scope.spawn(|| {
                    storage
                        .tasks()
                        .activate(&first, &storage.switch(&NOTHING_TO_STOP))
                });
                let right = scope.spawn(|| {
                    std::thread::sleep(std::time::Duration::from_micros(round * 200));
                    storage
                        .tasks()
                        .activate(&second, &storage.switch(&NOTHING_TO_STOP))
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
            .merge(&task, &storage.switch(&NOTHING_TO_STOP))
            .expect("merge the task");

        // The user carries on in the same task, the way the window still lets them.
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
            .create(&storage.switch(&NOTHING_TO_STOP))
            .expect("create the second task")
            .task_id
            .expect("task ID");
        assert_ne!(first, second);

        // The window is on the second task. Something asks to merge the first.
        let _ = storage
            .tasks()
            .merge(&first, &storage.switch(&NOTHING_TO_STOP));

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

    fn kept(sketch_id: &str, label: &str, shown: &str, source: &str) -> KeptSketch<'static> {
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

    /// The whole point of the store: what the user agreed can be found and drawn again.
    #[test]
    fn a_kept_sketch_is_listed_and_read_back_in_both_copies() {
        let directory = TempDir::new().expect("temporary directory");
        let storage = storage(&directory);

        storage
            .sketches()
            .keep(&kept(
                "question-1-run",
                "Centered overlay",
                "<p>inlined</p>",
                "<p>res://ui/panel.png</p>",
            ))
            .expect("keep the sketch");

        let listed = storage.sketches().list(10).expect("list sketches");
        assert_eq!(listed.len(), 1, "one sketch was kept");
        assert_eq!(listed[0].label, "Centered overlay");
        assert_eq!(listed[0].question, "Where does the pause menu go?");
        assert!(listed[0].is_approved, "it was kept as agreed");

        let html = storage.sketches().read("question-1-run").expect("read");
        assert_eq!(
            html.shown, "<p>inlined</p>",
            "the viewer draws the inlined copy"
        );
        assert_eq!(
            html.source.as_deref(),
            Some("<p>res://ui/panel.png</p>"),
            "a builder is handed the model's own markup, not the base64 one"
        );
    }

    /// A design loop is one layout being revised, so its rounds must not pile up as separate rows.
    #[test]
    fn keeping_a_revision_replaces_the_row_rather_than_adding_one() {
        let directory = TempDir::new().expect("temporary directory");
        let storage = storage(&directory);

        storage
            .sketches()
            .keep(&kept("question-1-run", "Draft", "<p>one</p>", "<p>one</p>"))
            .expect("keep the first draft");
        storage
            .sketches()
            .keep(&kept(
                "question-1-run",
                "Revised",
                "<p>two</p>",
                "<p>two</p>",
            ))
            .expect("keep the revision");

        let listed = storage.sketches().list(10).expect("list sketches");
        assert_eq!(
            listed.len(),
            1,
            "a revision replaces its predecessor in place"
        );
        assert_eq!(listed[0].label, "Revised");
        assert_eq!(
            storage
                .sketches()
                .read("question-1-run")
                .expect("read")
                .shown,
            "<p>two</p>",
            "the file is replaced along with the row"
        );
    }

    /// Newest first, because the layout somebody is re-checking is almost always the last one.
    #[test]
    fn sketches_are_listed_newest_first() {
        let directory = TempDir::new().expect("temporary directory");
        let storage = storage(&directory);

        storage
            .sketches()
            .keep(&kept("question-1-run", "Older", "<p>a</p>", "<p>a</p>"))
            .expect("keep the older sketch");
        // The stamp is milliseconds, so two writes in the same millisecond would tie. The index
        // breaks that tie on the identifier, which is what this asserts alongside the order.
        std::thread::sleep(std::time::Duration::from_millis(2));
        storage
            .sketches()
            .keep(&kept("question-2-run", "Newer", "<p>b</p>", "<p>b</p>"))
            .expect("keep the newer sketch");

        let listed = storage.sketches().list(10).expect("list sketches");
        assert_eq!(
            listed
                .iter()
                .map(|row| row.label.as_str())
                .collect::<Vec<_>>(),
            vec!["Newer", "Older"]
        );
    }

    /// The identifier makes a round trip through the window, so it is checked on the way back in.
    ///
    /// Reading is the direction that matters. Keeping has only ever been handed a value minted by
    /// `ask::new_sketch_id`; reading is handed whatever the renderer sends.
    #[test]
    fn a_sketch_identifier_that_could_name_a_path_is_refused_both_ways() {
        let directory = TempDir::new().expect("temporary directory");
        let storage = storage(&directory);

        for identifier in ["", "../secret", "a.b", "a/b", "a.source"] {
            let refused = storage
                .sketches()
                .read(identifier)
                .expect_err("an identifier that could name a path must be refused");
            assert_eq!(
                refused.code, "sketch_id_invalid",
                "{identifier} was allowed through the read guard"
            );
            assert!(
                storage
                    .sketches()
                    .keep(&kept(identifier, "x", "<p>a</p>", "<p>a</p>"))
                    .is_err(),
                "{identifier} was allowed through the keep guard"
            );
        }
    }

    /// Asked for something that was never kept, the store says so rather than reading a stray file.
    #[test]
    fn reading_a_sketch_the_project_never_kept_is_reported() {
        let directory = TempDir::new().expect("temporary directory");
        let storage = storage(&directory);

        let refused = storage
            .sketches()
            .read("question-9-run")
            .expect_err("there is no such sketch");
        assert_eq!(
            refused.code, "sketch_not_found",
            "a sketch nobody kept is named as missing, not as a store that failed"
        );
    }

    /// A sketch kept before the second copy existed has one file, and that is an age, not a fault.
    #[test]
    fn a_sketch_with_no_source_copy_reads_back_without_one() {
        let directory = TempDir::new().expect("temporary directory");
        let storage = storage(&directory);

        storage
            .sketches()
            .keep(&kept(
                "question-1-run",
                "Old",
                "<p>drawn</p>",
                "<p>source</p>",
            ))
            .expect("keep the sketch");
        fs::remove_file(
            storage
                .project_directory()
                .join("sketches")
                .join("question-1-run.source.html"),
        )
        .expect("remove the source copy");

        let html = storage.sketches().read("question-1-run").expect("read");
        assert_eq!(
            html.shown, "<p>drawn</p>",
            "the copy that is there is still drawn"
        );
        assert!(
            html.source.is_none(),
            "a missing source copy is reported as absent rather than as a failure"
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
            .create(&storage.switch(&NOTHING_TO_STOP))
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
            .delete(&doomed, &storage.switch(&NOTHING_TO_STOP))
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

    /// Cutoffs a fixture is written against: everything already in it is spent.
    ///
    /// A test says what it is about by moving one field off this, rather than by arithmetic on the
    /// clock that has to be read twice to see which side of the edge a row is on.
    fn everything_is_old() -> Cutoffs {
        Cutoffs {
            attachments_before: i64::MAX,
            runs_before: i64::MAX,
            corpus_version: Some("2.0.0".to_owned()),
            backups_kept: 5,
        }
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

    /// An attachment nothing refers to goes; a blob two attachments share does not.
    ///
    /// Attachments are content-addressed, so the same screenshot pasted into two tasks is one file
    /// on disk. Deleting it with the first row that stops referring to it would blank the image
    /// still on screen in the second.
    #[test]
    fn the_chats_view_collects_unreferenced_attachments_without_emptying_a_shared_blob() {
        let directory = TempDir::new().expect("temporary directory");
        let storage = storage(&directory);
        let referenced = attachment("018f47aa-09d2-7b34-a2d3-8c4e6f000001");
        let shares_its_bytes = attachment("018f47aa-09d2-7b34-a2d3-8c4e6f000002");
        let alone = attachment("018f47aa-09d2-7b34-a2d3-8c4e6f000003");
        for stored in [&referenced, &shares_its_bytes] {
            storage
                .chats()
                .save_attachment(stored, b"hi")
                .expect("save attachment");
        }
        storage
            .chats()
            .save_attachment(&alone, b"by")
            .expect("save attachment");
        storage
            .chats()
            .save(&StoredChat {
                task_id: None,
                messages: vec![StoredMessage {
                    id: 1,
                    sender: "user".to_owned(),
                    text: "Look".to_owned(),
                    timestamp: 10,
                    attachments: vec![referenced.clone()],
                    extra: serde_json::Map::new(),
                }],
                agent_messages: Vec::new(),
            })
            .expect("save the chat");

        let collected = storage
            .chats()
            .collect(&everything_is_old())
            .expect("collect");

        assert_eq!(collected.attachments_removed, 2);
        assert_eq!(
            collected.blobs_removed, 1,
            "only the bytes nothing else hashes to"
        );
        assert_eq!(
            storage
                .chats()
                .read_attachment(&referenced)
                .expect("the referenced attachment is still readable"),
            b"hi"
        );
        assert!(storage.chats().read_attachment(&alone).is_err());
    }

    /// A day is a floor under the window between a paste and the message that carries it.
    ///
    /// The composer stores an image the moment it is pasted and the row referring to it only
    /// appears when the message is sent, so an attachment is unreferenced for as long as somebody
    /// takes to finish typing.
    #[test]
    fn the_chats_view_leaves_an_attachment_that_has_only_just_been_pasted() {
        let directory = TempDir::new().expect("temporary directory");
        let storage = storage(&directory);
        let pasted = attachment("018f47aa-09d2-7b34-a2d3-8c4e6f000004");
        storage
            .chats()
            .save_attachment(&pasted, b"hi")
            .expect("save attachment");

        let collected = storage
            .chats()
            .collect(&Cutoffs {
                attachments_before: 0,
                ..everything_is_old()
            })
            .expect("collect");

        assert_eq!(collected.attachments_removed, 0);
        assert_eq!(
            storage
                .chats()
                .read_attachment(&pasted)
                .expect("still readable"),
            b"hi"
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

    /// Sketches were collected by nothing at all, and this is the half of them that goes.
    ///
    /// Not an age: `task_id` clears rather than cascades because the layout the user agreed to
    /// outlives the task that produced it, so there is no date after which one stops being worth
    /// keeping. What is collected is the row and its markup coming apart — a row offering the user
    /// something that cannot be opened, and markup no list will ever name again.
    #[test]
    fn the_sketches_view_collects_a_row_with_no_markup_and_markup_with_no_row() {
        let directory = TempDir::new().expect("temporary directory");
        let storage = storage(&directory);
        for id in ["question-1-run", "question-2-run"] {
            storage
                .sketches()
                .keep(&kept(id, "Dock", "<p>a</p>", "<p>a</p>"))
                .expect("keep the sketch");
        }
        let sketches = storage.project_directory().join("sketches");
        fs::remove_file(sketches.join("question-2-run.html")).expect("lose the markup");
        fs::write(sketches.join("question-3-run.html"), "<p>nobody's</p>").expect("orphan markup");
        fs::write(sketches.join("notes.txt"), "not a sketch").expect("a file that is not ours");

        let collected = storage
            .sketches()
            .collect(&everything_is_old())
            .expect("collect");

        assert_eq!(collected.sketches_removed, 1);
        let listed = storage.sketches().list(10).expect("list sketches");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, "question-1-run");
        assert!(
            !sketches.join("question-2-run.source.html").exists(),
            "a row that goes takes both of its copies"
        );
        assert!(!sketches.join("question-3-run.html").exists());
        assert!(sketches.join("question-1-run.html").is_file());
        assert!(sketches.join("question-1-run.source.html").is_file());
        assert!(
            sketches.join("notes.txt").is_file(),
            "a name this cannot read is not a sketch, and not ours to delete"
        );
    }

    /*
     * The vectors are computed before the write lock is taken, so what they came FROM is checked
     * once it is held.
     *
     * Two hundred round trips to the memory worker is a window minutes wide, and both things that
     * can happen in it used to go wrong. A memory deleted in that window made `write_embedding`
     * error and the `?` took the whole maintenance fold down — backups unpruned, stale answers
     * unpurged. A memory EDITED in it had its vector dropped precisely because the content changed,
     * and the stale one was written back against the new text: `missing_embeddings` stopped
     * reporting the row, so nothing would ever notice it was indexed under words it no longer held.
     */
    #[test]
    fn a_vector_is_written_only_if_the_text_it_was_computed_from_is_still_there() {
        let directory = TempDir::new().expect("temporary directory");
        let storage = storage(&directory);
        let remember = |content: &str| {
            storage
                .memory()
                .upsert(&UpsertMemoryRequest {
                    id: None,
                    task_id: None,
                    kind: "fact".to_owned(),
                    state: "confirmed".to_owned(),
                    content: content.to_owned(),
                    provenance: serde_json::json!({"source": "user"}),
                    superseded_by: None,
                })
                .expect("save memory")
        };
        let edited = remember("The pause menu lives in ui/pause.tscn");
        let removed = remember("The player scene lives in scenes/player.tscn");
        let kept = remember("The input map names ui_cancel");
        let mut vector = vec![0.0; MEMORY_EMBEDDING_DIMENSIONS];
        vector[0] = 1.0;
        let computed = |memory: &MemoryRecord| PendingEmbedding {
            request: SaveMemoryEmbeddingRequest {
                memory_id: memory.id.clone(),
                model: MEMORY_EMBEDDING_MODEL.to_owned(),
                vector: vector.clone(),
            },
            content: memory.content.clone(),
        };
        let pending = vec![computed(&edited), computed(&removed), computed(&kept)];

        // The window: one memory rewritten, one deleted, while the worker was busy.
        storage
            .memory()
            .upsert(&UpsertMemoryRequest {
                id: Some(edited.id.clone()),
                task_id: None,
                kind: "fact".to_owned(),
                state: "confirmed".to_owned(),
                content: "The pause menu lives in ui/menus/pause.tscn".to_owned(),
                provenance: serde_json::json!({"source": "user"}),
                superseded_by: None,
            })
            .expect("edit memory");
        let connection = storage.connection().expect("connection");
        connection
            .execute("DELETE FROM memory_items WHERE id = ?1", [&removed.id])
            .expect("delete memory");

        let collected = storage
            .memory()
            .collect(&everything_is_old(), &pending)
            .expect("collect");

        assert_eq!(
            collected.memory_embeddings_restored, 1,
            "only the memory that still holds the text the vector was computed from"
        );
        let still_missing = storage
            .memory()
            .missing_embeddings(10)
            .expect("missing")
            .into_iter()
            .map(|memory| memory.id)
            .collect::<Vec<_>>();
        assert_eq!(
            still_missing,
            vec![edited.id],
            "the edited row keeps no vector, so the next pass computes one for what it now says"
        );
        assert!(!still_missing.contains(&kept.id));
    }

    /// Deleting a task moves its memories to project scope, and the vectors have to move with them.
    ///
    /// `memory_items.task_id` is `ON DELETE SET NULL`, which rewrites the row without going through
    /// `upsert` — the only place that drops a vector on a scope change. `scope_key` is a partition
    /// key, so the vector stays filed under a task id nothing can name any more and the search,
    /// which asks for one scope, never sees it again. Nothing noticed: the embedding row is still
    /// there, so the backfill skips it, and the memory is still there, so the orphan sweep skips it.
    #[test]
    fn the_memories_view_refiles_vectors_whose_task_was_deleted() {
        let directory = TempDir::new().expect("temporary directory");
        let workspace = committed_repository(directory.path());
        let storage =
            ProjectStorage::open(&directory.path().join("data"), &workspace).expect("storage");
        let doomed = storage
            .tasks()
            .create(&storage.switch(&NOTHING_TO_STOP))
            .expect("create task")
            .task_id
            .expect("task ID");
        let memory = storage
            .memory()
            .upsert(&UpsertMemoryRequest {
                id: None,
                task_id: Some(doomed.clone()),
                kind: "fact".to_owned(),
                state: "confirmed".to_owned(),
                content: "The player scene lives in scenes/player.tscn".to_owned(),
                provenance: serde_json::json!({"source": "user"}),
                superseded_by: None,
            })
            .expect("save memory");
        let mut vector = vec![0.0; MEMORY_EMBEDDING_DIMENSIONS];
        vector[0] = 1.0;
        storage
            .memory()
            .save_embedding(&SaveMemoryEmbeddingRequest {
                memory_id: memory.id.clone(),
                model: MEMORY_EMBEDDING_MODEL.to_owned(),
                vector: vector.clone(),
            })
            .expect("save embedding");
        storage
            .tasks()
            .delete(&doomed, &storage.switch(&NOTHING_TO_STOP))
            .expect("delete the task");

        let found = |storage: &ProjectStorage| {
            storage
                .memory()
                .search(&SearchMemoryRequest {
                    query: "player scene".to_owned(),
                    task_id: None,
                    vector: Some(vector.clone()),
                    limit: Some(5),
                })
                .expect("search")
        };
        let stranded = found(&storage);
        assert_eq!(stranded.len(), 1, "the memory itself survived the task");
        assert!(
            stranded[0].vector_distance.is_none(),
            "and its vector is filed where the search cannot reach it"
        );

        let collected = storage
            .memory()
            .collect(&everything_is_old(), &[])
            .expect("collect");

        assert_eq!(collected.memory_vectors_refiled, 1);
        assert_eq!(
            collected.memory_vectors_removed, 0,
            "the vector was moved rather than thrown away"
        );
        assert!(
            found(&storage)[0].vector_distance.is_some(),
            "the same vector, under the scope the memory is in now"
        );
    }

    /// A vector whose memory is gone is a vector the cosine search keeps ranking forever.
    ///
    /// `memory_vectors` is a vec0 virtual table, so it is outside the `ON DELETE CASCADE` that
    /// `memory_embeddings` gets. Since schema V3 a trigger removes it, which leaves what a database
    /// written before V3 kept — and nothing else would ever look.
    #[test]
    fn the_memories_view_collects_vectors_whose_memory_is_gone() {
        let directory = TempDir::new().expect("temporary directory");
        let storage = storage(&directory);
        let memory = storage
            .memory()
            .upsert(&UpsertMemoryRequest {
                id: None,
                task_id: None,
                kind: "fact".to_owned(),
                state: "confirmed".to_owned(),
                content: "The player scene lives in scenes/player.tscn".to_owned(),
                provenance: serde_json::json!({"source": "user"}),
                superseded_by: None,
            })
            .expect("save memory");
        let mut vector = vec![0.0; MEMORY_EMBEDDING_DIMENSIONS];
        vector[0] = 1.0;
        storage
            .memory()
            .save_embedding(&SaveMemoryEmbeddingRequest {
                memory_id: memory.id.clone(),
                model: MEMORY_EMBEDDING_MODEL.to_owned(),
                vector: vector.clone(),
            })
            .expect("save embedding");
        // What a pre-V3 database is left holding: the memory deleted, the vector not.
        let connection = storage.connection().expect("connection");
        connection
            .execute(
                "INSERT INTO memory_vectors (memory_id, embedding, scope_key)
                 VALUES ('01a0-gone', ?1, 'project')",
                params![vector_bytes(&vector)],
            )
            .expect("orphan vector");

        let collected = storage
            .memory()
            .collect(&everything_is_old(), &[])
            .expect("collect");

        assert_eq!(collected.memory_vectors_removed, 1);
        assert_eq!(
            collected.memory_embeddings_restored, 0,
            "every memory here already has its vector, so the worker is never reached"
        );
        let vectors = connection
            .query_row("SELECT count(*) FROM memory_vectors", [], |row| {
                row.get::<_, u32>(0)
            })
            .expect("vector count");
        assert_eq!(vectors, 1, "the memory that is still here keeps its vector");
        assert_eq!(
            storage
                .memory()
                .search(&SearchMemoryRequest {
                    query: "player scene".to_owned(),
                    task_id: None,
                    vector: Some(vector),
                    limit: Some(5),
                })
                .expect("search")
                .len(),
            1
        );
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
            .create(&storage.switch(&NOTHING_TO_STOP))
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

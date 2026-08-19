//! Gofer RAG model cache and warmup.
//!
//! Owns where the embedding and reranking models live, whether they are complete, and the single
//! coalesced warmup that downloads them. Tauri commands stay in `lib.rs` and call in here.

use crate::process::{ProcessSpawner, SystemProcessSpawner};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use tauri::{AppHandle, Emitter, Runtime};

const EVENT_PREFIX: &str = "GOFER_RAG_EVENT:";

static INITIALIZING: AtomicBool = AtomicBool::new(false);
static ACTIVE_INITIALIZATION: Mutex<Option<Arc<Initialization>>> = Mutex::new(None);

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CacheState {
    Installed,
    Incomplete,
    NotInstalled,
    Busy,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheStatus {
    path: String,
    size_bytes: u64,
    state: CacheState,
}

/// Releases the busy flag when a cache operation ends, including on an early return.
struct InitializationGuard;

impl Drop for InitializationGuard {
    fn drop(&mut self) {
        INITIALIZING.store(false, Ordering::Release);
    }
}

struct Initialization {
    result: Mutex<Option<Result<(), String>>>,
    completed: Condvar,
}

impl Initialization {
    fn new() -> Self {
        Self {
            result: Mutex::new(None),
            completed: Condvar::new(),
        }
    }

    fn wait(&self) -> Result<(), String> {
        let mut stored = self
            .result
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        while stored.is_none() {
            stored = self
                .completed
                .wait(stored)
                .unwrap_or_else(|error| error.into_inner());
        }
        stored
            .clone()
            .expect("completed RAG initialization must have a result")
    }
}

struct ActiveInitializationGuard {
    initialization: Arc<Initialization>,
    finished: bool,
}

impl ActiveInitializationGuard {
    fn finish(mut self, result: Result<(), String>) {
        self.finish_with(result);
        self.finished = true;
    }

    fn finish_with(&self, completion: Result<(), String>) {
        let mut active = ACTIVE_INITIALIZATION
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let mut result = self
            .initialization
            .result
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        *result = Some(completion);
        if active
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(current, &self.initialization))
        {
            *active = None;
        }
        INITIALIZING.store(false, Ordering::Release);
        drop(active);
        drop(result);
        self.initialization.completed.notify_all();
    }
}

impl Drop for ActiveInitializationGuard {
    fn drop(&mut self) {
        if self.finished {
            return;
        }
        self.finish_with(Err(
            "Gofer RAG initialization ended before producing a result".to_owned(),
        ));
    }
}

/// Runs `operation` once even when several callers ask at the same time.
///
/// The first caller leads and the rest block on its result, so a concurrent renderer and agent
/// cannot start two model downloads into the same cache.
pub fn run_initialization(operation: impl FnOnce() -> Result<(), String>) -> Result<(), String> {
    let (initialization, is_leader) = {
        let mut active = ACTIVE_INITIALIZATION
            .lock()
            .map_err(|_| "The RAG initialization lock is poisoned".to_owned())?;
        if let Some(initialization) = active.as_ref() {
            (Arc::clone(initialization), false)
        } else {
            INITIALIZING
                .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                .map_err(|_| "Another model operation is already running".to_owned())?;
            let initialization = Arc::new(Initialization::new());
            *active = Some(Arc::clone(&initialization));
            (initialization, true)
        }
    };

    if !is_leader {
        return initialization.wait();
    }

    let guard = ActiveInitializationGuard {
        initialization,
        finished: false,
    };
    let result = operation();
    guard.finish(result.clone());
    result
}

/// Deletes the cache, refusing while any other model operation holds the busy flag.
pub fn delete_cache() -> Result<CacheStatus, String> {
    if INITIALIZING
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Err(
            "The model cache cannot be deleted while another model operation is running".to_owned(),
        );
    }
    let operation = InitializationGuard;

    let path = cache_path()?;
    delete_cache_path(&path)?;
    drop(operation);
    cache_status()
}

pub fn cache_path() -> Result<PathBuf, String> {
    if let Some(configured) = std::env::var_os("GOFER_RAG_CACHE_DIR") {
        let path = PathBuf::from(configured);
        if !path.is_absolute() {
            return Err("GOFER_RAG_CACHE_DIR must be an absolute path".to_owned());
        }
        validate_cache_path(path)
    } else {
        let cache_root = dirs::cache_dir().ok_or_else(|| {
            "The operating system user cache directory could not be resolved".to_owned()
        })?;
        validate_cache_path(cache_root.join("gofer-rag"))
    }
}

// coverage-critical-start: cache
fn validate_cache_path(path: PathBuf) -> Result<PathBuf, String> {
    if path
        .components()
        .any(|component| matches!(component, Component::CurDir | Component::ParentDir))
    {
        return Err(format!(
            "Refusing to use a cache path containing traversal components: {}",
            path.display()
        ));
    }
    if path.parent().is_none() || path.parent() == Some(Path::new("")) {
        return Err(format!(
            "Refusing to use an unsafe cache path: {}",
            path.display()
        ));
    }
    let safety_path = crate::paths::canonical(&path).unwrap_or_else(|_| path.clone());
    let home = dirs::home_dir().and_then(|home| crate::paths::canonical(&home).ok());
    if home.as_deref() == Some(safety_path.as_path()) {
        return Err("Refusing to use the home directory as the Gofer RAG cache".to_owned());
    }
    Ok(path)
}

pub fn cache_status() -> Result<CacheStatus, String> {
    let path = cache_path()?;
    let busy = INITIALIZING.load(Ordering::Acquire);
    cache_status_for_path(&path, busy)
}

fn cache_status_for_path(path: &Path, busy: bool) -> Result<CacheStatus, String> {
    let state = if busy {
        CacheState::Busy
    } else if !path.exists() {
        CacheState::NotInstalled
    } else if required_model_files(path).iter().all(|file| file.is_file()) {
        CacheState::Installed
    } else {
        CacheState::Incomplete
    };
    let size_bytes = if path.exists() {
        directory_size(path)?
    } else {
        0
    };
    Ok(CacheStatus {
        path: path.display().to_string(),
        size_bytes,
        state,
    })
}

fn delete_cache_path(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    // The sentences below name the cache, not its path. `cache_status` already reports the
    // location as a field the renderer can show deliberately; an error message is not the place to
    // put a host path the user did not ask for.
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("Could not inspect the Gofer RAG cache: {error}"))?;
    if metadata.file_type().is_symlink() {
        return Err("Refusing to delete the Gofer RAG cache: it is a symbolic link".to_owned());
    }
    if !metadata.is_dir() {
        return Err("The Gofer RAG cache path is not a directory".to_owned());
    }
    fs::remove_dir_all(path)
        .map_err(|error| format!("Could not delete the Gofer RAG cache: {error}"))
}
// coverage-critical-end: cache

/// Mirrors the model definitions gofer-rag downloads, so a cache missing any of
/// them reads as `Incomplete` rather than claiming a retrieval that cannot run.
/// Keep this in step with `dist/ai/downloads.js` when the package moves.
fn required_model_files(cache: &Path) -> [PathBuf; 10] {
    [
        cache.join("onnx-community/Qwen3-Embedding-0.6B-ONNX/config.json"),
        cache.join("onnx-community/Qwen3-Embedding-0.6B-ONNX/tokenizer.json"),
        cache.join("onnx-community/Qwen3-Embedding-0.6B-ONNX/onnx/model_fp16.onnx"),
        cache.join("onnx-community/Qwen3-Embedding-0.6B-ONNX/onnx/model_fp16.onnx_data"),
        cache.join("onnx-community/bge-reranker-v2-m3-ONNX/config.json"),
        cache.join("onnx-community/bge-reranker-v2-m3-ONNX/tokenizer.json"),
        cache.join("onnx-community/bge-reranker-v2-m3-ONNX/onnx/model_quantized.onnx"),
        // The prefilter that skims the pool before the reranker scores it.
        cache.join("Xenova/ms-marco-MiniLM-L-6-v2/config.json"),
        cache.join("Xenova/ms-marco-MiniLM-L-6-v2/tokenizer.json"),
        cache.join("Xenova/ms-marco-MiniLM-L-6-v2/onnx/model_quantized.onnx"),
    ]
}

fn directory_size(path: &Path) -> Result<u64, String> {
    let mut total = 0;
    for entry in fs::read_dir(path)
        .map_err(|error| format!("Could not read the Gofer RAG cache directory: {error}"))?
    {
        let entry = entry.map_err(|error| {
            format!("Could not inspect an entry in the Gofer RAG cache: {error}")
        })?;
        let metadata = entry.path().symlink_metadata().map_err(|error| {
            format!("Could not inspect an entry in the Gofer RAG cache: {error}")
        })?;
        if metadata.file_type().is_symlink() {
            continue;
        }
        if metadata.is_dir() {
            total += directory_size(&entry.path())?;
        } else if metadata.is_file() {
            total += metadata.len();
        }
    }
    Ok(total)
}

pub fn run_warmup(app: &AppHandle) -> Result<(), String> {
    run_warmup_with(app, &SystemProcessSpawner)
}

pub fn run_warmup_with<R: Runtime>(
    app: &AppHandle<R>,
    spawner: &impl ProcessSpawner,
) -> Result<(), String> {
    #[cfg(feature = "webdriver")]
    if std::env::var_os("GOFER_WEBDRIVER_RAG_READY").is_some() {
        return Ok(());
    }

    let worker = worker_path()?;
    let node = std::env::var("GOFER_NODE_BINARY").unwrap_or_else(|_| "node".to_owned());
    let mut child = spawner
        .spawn(node.as_ref(), &[worker.into_os_string()], false)
        .map_err(|error| {
            format!(
                "Could not start Node.js with '{node}': {error}. Install Node.js 22 or newer, or set GOFER_NODE_BINARY."
            )
        })?;
    let stdout = child
        .take_stdout()
        .ok_or_else(|| "Could not read Gofer RAG worker output".to_owned())?;
    let stderr = child
        .take_stderr()
        .ok_or_else(|| "Could not read Gofer RAG worker errors".to_owned())?;
    let stderr_reader = std::thread::spawn(move || {
        let mut output = String::new();
        let _ = BufReader::new(stderr).read_to_string(&mut output);
        output
    });

    for line in BufReader::new(stdout).lines() {
        let line = line.map_err(|error| format!("Could not read Gofer RAG progress: {error}"))?;
        let Some(payload) = line.strip_prefix(EVENT_PREFIX) else {
            continue;
        };
        let progress: serde_json::Value = serde_json::from_str(payload)
            .map_err(|error| format!("Gofer RAG returned invalid progress data: {error}"))?;
        app.emit_to("main", "rag-download-progress", progress)
            .map_err(|error| format!("Could not report Gofer RAG progress: {error}"))?;
    }

    let status = child
        .wait()
        .map_err(|error| format!("Could not wait for Gofer RAG initialization: {error}"))?;
    let stderr = stderr_reader
        .join()
        .map_err(|_| "Could not collect Gofer RAG worker errors".to_owned())?;

    if status.success {
        return Ok(());
    }

    let detail = stderr.trim();
    if detail.is_empty() {
        return Err(format!(
            "Gofer RAG initialization exited with {}",
            status.description
        ));
    }
    Err(format!("Gofer RAG initialization failed: {detail}"))
}

fn worker_path() -> Result<PathBuf, String> {
    let configured = std::env::var_os("GOFER_RAG_WORKER").map(PathBuf::from);
    let path = configured.unwrap_or_else(|| {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("scripts")
            .join("rag-warmup.mjs")
    });

    if path.is_file() {
        return Ok(path);
    }
    Err(format!(
        "Gofer RAG worker was not found at {}. Run npm install, or set GOFER_RAG_WORKER.",
        path.display()
    ))
}

const RETRIEVE_RESPONSE_PREFIX: &str = "GOFER_RAG_RESULT:";
/// The sidecar asks to store a rotated ChatGPT credential on the same channel the agent worker
/// uses, so both sides of that exchange have one implementation.
const CREDENTIAL_REQUEST_PREFIX: &str = "GOFER_AI_CREDENTIAL:";

#[derive(Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GodotDocsQuery {
    pub question: String,
    /// How many passages to keep, or `None` for the shipped default.
    ///
    /// Absent rather than defaulted, because a serde default cannot tell a caller who wrote the
    /// same number from one who wrote nothing, and one of them has to win. The desktop Docs panel
    /// names its own; the agent's `search` and `ask` do not.
    #[serde(default)]
    pub max_passages: Option<usize>,
    #[serde(default = "default_max_text_chars")]
    pub max_text_chars: usize,
}

/// How many passages a query gets when the caller names no number.
///
/// It used to be ten, which never bound anything: gofer-rag keeps five and pins up to three more,
/// and 130 cached searches from a live project never returned more than six. So the cap was a cap
/// in name only, and `godot_docs_search` was 23.5% of every byte the model read from a tool. Rank
/// by rank across those searches the scores were 2.41, 1.58, 1.01, 0.50, 0.08, −1.20 — ranks four
/// to six are 40% of all the bytes, at or below zero about half the time.
///
/// Four rather than three, and measured rather than read off that histogram. gofer-rag 0.2.0 takes
/// the number as `maxPassages` and applies it before pinning, and replaying its 83 labelled eval
/// questions through every ceiling on frozen pools gave: 5 keeps 99% of the bytes and loses
/// nothing, 4 keeps 79% and loses nothing, 3 keeps 60% and loses two, 2 keeps 40% and loses six.
/// Four is free; three is a trade worth making knowingly rather than by default.
///
/// One number for both operations. `ask` reads the same list to write prose from, and the two cases
/// a ceiling of three costs are exactly the questions it would have had to abstain on — so what
/// makes four safe for a search is what makes it safe for an ask.
const DEFAULT_PASSAGES: usize = 4;

/// How many passages this query gets: what it asked for, or the shipped default.
fn passages_for(query: &GodotDocsQuery) -> usize {
    query.max_passages.unwrap_or(DEFAULT_PASSAGES)
}

fn default_max_text_chars() -> usize {
    2000
}

#[derive(Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RankedPassage {
    pub text: String,
    pub chapter: String,
    pub order: u32,
    pub score: f64,
    /// Whether this passage is a rescue rather than a rank.
    ///
    /// gofer-rag pins the best chunk of a chapter the question named verbatim when the reranker
    /// left it out, which is why a pin's mean score is below every kept rank's. Carried through and
    /// stored so how often a pin was the passage that answered is a query over `docs_answers`
    /// rather than a guess. Absent from an older cached row, which is what the option allows for.
    #[serde(default)]
    pub pinned: Option<bool>,
}

/// One chapter an answer rested on, without its text.
#[derive(Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnsweredChapter {
    pub chapter: String,
    pub score: f64,
}

#[derive(Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GodotDocsResponse {
    /// The ranked passages. Empty for an `ask`, which returns prose instead.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub passages: Vec<RankedPassage>,
    /// The written answer with its quote. Absent for a `search`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// Whether the quote in `text` was found verbatim in what was retrieved. `false` is the one
    /// visible sign of an answer written from memory, so it is carried rather than dropped.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub excerpt_verified: Option<bool>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub chapters: Vec<AnsweredChapter>,
    /// The reader found the chapters were about something else.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub coverage_miss: Option<bool>,
    /// The reader had the chapters and could not settle what they say.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub abstained: Option<bool>,
    /// Which manual answered. Not shown to the model; it is what a cached answer is keyed on.
    #[serde(default, skip_serializing)]
    pub corpus_version: Option<String>,
}

impl GodotDocsResponse {
    /// Whether this is an answer worth keeping, rather than a dead end that will be re-served.
    ///
    /// Every `false` here is a state the next asker should be allowed to pay to retry: a retrieval
    /// that found nothing, a reader that could not settle it, chapters about something else, and —
    /// the one that matters most — an answer whose quote is not in the manual, which is an answer
    /// written from memory and must never become the cached truth.
    pub fn is_worth_remembering(&self) -> bool {
        if self.coverage_miss == Some(true) || self.abstained == Some(true) {
            return false;
        }
        if self.excerpt_verified == Some(false) {
            return false;
        }
        // A search answers with passages and a read answers with prose. Neither is an answer empty.
        self.text.is_some() || !self.passages.is_empty()
    }
}

/// How the retrieve sidecar reaches a model, when there is one to reach.
///
/// gofer-rag makes two model calls of its own — it expands a plain-words question into Godot class
/// names before searching, and it can write the answer. Left alone it opens its own connection to
/// an address nobody configured. This is the connection the user actually set, carried down so both
/// calls go where their sub-agent goes; the prompts stay in the package.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetrieveConnection {
    /// `openai-compatible` or `openai-codex`. ChatGPT is addressed by provider, not by URL, so the
    /// sidecar has to be told which of the two it is holding rather than inferring it.
    pub connection_type: String,
    /// The ChatGPT credential, for a codex connection only. It rotates when it is used, which is
    /// what the credential channel below exists to carry back.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub oauth_credential: Option<serde_json::Value>,
    pub base_url: String,
    pub model: String,
    pub model_name: String,
    pub api_key: Option<String>,
    pub thinking_level: String,
    pub context_window: u64,
    pub max_tokens: u64,
    pub reasoning: bool,
    pub supports_reasoning_effort: bool,
    pub timeout_ms: u64,
    pub max_retries: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RetrieveWorkerRequest {
    /// `search` hands back the ranked passages; `ask` reads them and hands back one answer with a
    /// quote. The retrieval is identical, so it is one request with two endings rather than two
    /// spawns of the same sidecar.
    mode: &'static str,
    question: String,
    cache_dir: String,
    max_passages: usize,
    max_text_chars: usize,
    /// Absent is an ordinary state: a ChatGPT-only install has no address to hand over, so the
    /// search runs unexpanded rather than failing.
    #[serde(skip_serializing_if = "Option::is_none")]
    connection: Option<RetrieveConnection>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RetrieveWorkerResponse {
    #[serde(default)]
    passages: Vec<RankedPassage>,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    excerpt_verified: Option<bool>,
    #[serde(default)]
    chapters: Vec<AnsweredChapter>,
    #[serde(default)]
    coverage_miss: Option<bool>,
    #[serde(default)]
    abstained: Option<bool>,
    #[serde(default)]
    corpus_version: Option<String>,
    #[serde(default)]
    error: Option<String>,
}

/// Queries the local Godot documentation through the gofer-rag retrieve sidecar.
///
/// Returns ranked passages without raw embedding vectors. Models must already be cached; run
/// `initialize_rag` first.
/// The connection a search's own model calls should use, read fresh for each search.
///
/// Absent whenever the settings cannot be read or the sub-agent is on ChatGPT. Both cost the
/// question its expansion and nothing else, so neither is reported as a failure.
pub fn expansion_connection<R: Runtime>(app: &AppHandle<R>) -> Option<RetrieveConnection> {
    let settings = crate::settings::read_settings(app).ok()?;
    let key = crate::settings::ai_worker_api_key().ok().flatten();
    let credential = crate::settings::stored_chatgpt_credential().ok().flatten();
    crate::settings::docs_expansion_connection(&settings.ai, key, credential)
}

pub fn retrieve_query(
    query: GodotDocsQuery,
    connection: Option<RetrieveConnection>,
) -> Result<GodotDocsResponse, String> {
    retrieve_query_with(query, connection, false, &SystemProcessSpawner)
}

/// Reads the same passages a search would return and answers the question from them.
pub fn ask_query(
    query: GodotDocsQuery,
    connection: Option<RetrieveConnection>,
) -> Result<GodotDocsResponse, String> {
    retrieve_query_with(query, connection, true, &SystemProcessSpawner)
}

pub fn retrieve_query_with(
    query: GodotDocsQuery,
    connection: Option<RetrieveConnection>,
    ask: bool,
    spawner: &impl ProcessSpawner,
) -> Result<GodotDocsResponse, String> {
    let worker = retrieve_worker_path()?;
    let node = std::env::var("GOFER_NODE_BINARY").unwrap_or_else(|_| "node".to_owned());
    let mut child = spawner
        .spawn(node.as_ref(), &[worker.into_os_string()], true)
        .map_err(|error| {
            format!(
                "Could not start the Gofer RAG retrieve worker with '{node}': {error}. Install Node.js 22 or newer, or set GOFER_NODE_BINARY."
            )
        })?;
    let mut stdin = child
        .take_stdin()
        .ok_or_else(|| "Could not write to the Gofer RAG retrieve worker".to_owned())?;
    let max_passages = passages_for(&query);
    let request = RetrieveWorkerRequest {
        mode: if ask { "ask" } else { "search" },
        question: query.question,
        cache_dir: cache_path()?.display().to_string(),
        max_passages,
        max_text_chars: query.max_text_chars,
        connection,
    };
    let mut payload = serde_json::to_vec(&request)
        .map_err(|error| format!("Could not serialize the Gofer RAG query: {error}"))?;
    // The worker reads one request per line.
    payload.push(b'\n');
    stdin
        .write_all(&payload)
        .map_err(|error| format!("Could not send the Gofer RAG query: {error}"))?;
    // Held open rather than dropped here, and closed the moment the answer is in. A ChatGPT
    // expansion may rotate its refresh token, and the acknowledgement for the keyring write goes
    // back down this pipe — but a sidecar reading stdin until EOF will not exit while it is open,
    // and the `wait` below would then never return. Closing it is what ends the exchange, and it
    // is the reader's own end-of-input rather than a shutdown the reader has to be taught.
    let mut stdin = Some(stdin);

    let stdout = child
        .take_stdout()
        .ok_or_else(|| "Could not read Gofer RAG retrieve worker output".to_owned())?;
    let stderr = child
        .take_stderr()
        .ok_or_else(|| "Could not read Gofer RAG retrieve worker errors".to_owned())?;
    let stderr_reader = std::thread::spawn(move || {
        let mut output = String::new();
        let _ = BufReader::new(stderr).read_to_string(&mut output);
        output
    });

    for line in BufReader::new(stdout).lines() {
        let line = line
            .map_err(|error| format!("Could not read Gofer RAG retrieve worker output: {error}"))?;
        if let Some(payload) = line.strip_prefix(CREDENTIAL_REQUEST_PREFIX) {
            let mut answer = crate::ai_turn::credential_answer(payload)?;
            answer.push(b'\n');
            let writer = stdin.as_mut().ok_or_else(|| {
                "The Gofer RAG retrieve worker asked to store a credential after it had answered"
                    .to_owned()
            })?;
            writer
                .write_all(&answer)
                .and_then(|()| writer.flush())
                .map_err(|error| {
                    format!("Could not answer the Gofer RAG credential request: {error}")
                })?;
            continue;
        }
        let Some(payload) = line.strip_prefix(RETRIEVE_RESPONSE_PREFIX) else {
            continue;
        };
        let response: RetrieveWorkerResponse = serde_json::from_str(payload)
            .map_err(|error| format!("Gofer RAG retrieve worker returned invalid data: {error}"))?;
        if let Some(error) = response.error {
            return Err(error);
        }
        // The answer is in, so nothing more will be asked of this pipe. Its closing is what tells a
        // sidecar looping on stdin that it is finished.
        drop(stdin.take());
        let status = child.wait().map_err(|error| {
            format!("Could not wait for the Gofer RAG retrieve worker: {error}")
        })?;
        let _ = stderr_reader
            .join()
            .map_err(|_| "Could not collect Gofer RAG retrieve worker errors".to_owned())?;
        if !status.success {
            return Err(format!(
                "Gofer RAG retrieve worker exited with {}",
                status.description
            ));
        }
        note_corpus_version(response.corpus_version.as_deref());
        return Ok(GodotDocsResponse {
            passages: response.passages,
            text: response.text,
            excerpt_verified: response.excerpt_verified,
            chapters: response.chapters,
            coverage_miss: response.coverage_miss,
            abstained: response.abstained,
            corpus_version: response.corpus_version,
        });
    }

    // The same close on the path where no answer ever arrived: the sidecar may still be waiting on
    // input, and a `wait` for a child that is waiting for us is a deadlock either way.
    drop(stdin.take());
    let status = child
        .wait()
        .map_err(|error| format!("Could not wait for the Gofer RAG retrieve worker: {error}"))?;
    let stderr = stderr_reader
        .join()
        .map_err(|_| "Could not collect Gofer RAG retrieve worker errors".to_owned())?;
    if !status.success {
        let detail = stderr.trim();
        if detail.is_empty() {
            return Err(format!(
                "Gofer RAG retrieve worker exited with {}",
                status.description
            ));
        }
        return Err(format!("Gofer RAG retrieve worker failed: {detail}"));
    }
    Err("Gofer RAG retrieve worker exited without returning a result".to_owned())
}

/// Proves a documentation search could answer, before the model is told the tool exists.
///
/// Both halves of this tool live outside the binary: the sidecar script the retrieval runs in, and
/// the models it loads. Either one missing makes every `godot_docs_search` call fail, and a tool
/// the agent is told about and cannot use is a tool it silently never calls.
pub fn probe_retrieval() -> Result<String, String> {
    probe_retrieval_with(&SystemProcessSpawner)
}

/// The word the sidecar's own probe answers with. `PROBE_ANSWER` in `scripts/rag-retrieve.mjs`.
const PROBE_ANSWER: &str = "docs-ask-reachable";

/// Which manual this process has seen answer, learned from the probe that runs before every turn.
///
/// A cached answer is only good for the manual it came out of, and the manual ships inside the
/// gofer-rag package — so the package version is the key. Knowing it BEFORE the first search is
/// what stops an upgrade from serving one answer out of the old manual: without the probe, the
/// version would only arrive with the very response the cache had already been asked for.
static CORPUS_VERSION: Mutex<Option<String>> = Mutex::new(None);

pub fn known_corpus_version() -> Option<String> {
    CORPUS_VERSION
        .lock()
        .ok()
        .and_then(|version| version.clone())
}

fn note_corpus_version(version: Option<&str>) {
    let Some(version) = version else { return };
    if let Ok(mut held) = CORPUS_VERSION.lock() {
        *held = Some(version.to_owned());
    }
}

pub fn probe_retrieval_with(spawner: &impl ProcessSpawner) -> Result<String, String> {
    let worker = retrieve_worker_path()?;
    let cache = cache_path()?;
    probe_models(&cache)?;
    probe_reader(spawner)?;
    Ok(worker.display().to_string())
}

/// Proves the half that reads the passages, as well as the half that finds them.
///
/// `search` needs the sidecar and the models, which the two checks above settle without running
/// anything. `ask` needs the reader on top, and the reader is code in the sidecar rather than a
/// file on disk — a missing module or a broken import is invisible until the first call, which is
/// the shape of dead tool this whole probe exists to catch.
///
/// The sidecar answers this one from a canned passage and a canned reader, so nothing is asked of a
/// model. That is deliberate and it is the same line `web_fetch` draws: a real call would put a
/// model request — a paid one, on a ChatGPT sub-agent — in front of every turn the user takes, and
/// would refuse the whole turn for a connection that has nothing to do with the work being done.
/// Measured at about 170ms, because the sidecar imports gofer-rag on demand rather than at load.
fn probe_reader(spawner: &impl ProcessSpawner) -> Result<(), String> {
    let worker = retrieve_worker_path()?;
    let node = std::env::var("GOFER_NODE_BINARY").unwrap_or_else(|_| "node".to_owned());
    let mut child = spawner
        .spawn(node.as_ref(), &[worker.into_os_string()], true)
        .map_err(|error| format!("Could not start the Gofer RAG retrieve worker: {error}"))?;
    let mut stdin = child
        .take_stdin()
        .ok_or_else(|| "Could not write to the Gofer RAG retrieve worker".to_owned())?;
    stdin
        .write_all(b"{\"probe\":true}\n")
        .map_err(|error| format!("Could not send the Gofer RAG probe: {error}"))?;
    drop(stdin);
    let stdout = child
        .take_stdout()
        .ok_or_else(|| "Could not read Gofer RAG retrieve worker output".to_owned())?;
    for line in BufReader::new(stdout).lines() {
        let line = line.map_err(|error| format!("Could not read the Gofer RAG probe: {error}"))?;
        let Some(payload) = line.strip_prefix(RETRIEVE_RESPONSE_PREFIX) else {
            continue;
        };
        if payload.contains(PROBE_ANSWER) {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct ProbeAnswer {
                #[serde(default)]
                corpus_version: Option<String>,
            }
            if let Ok(answer) = serde_json::from_str::<ProbeAnswer>(payload) {
                note_corpus_version(answer.corpus_version.as_deref());
            }
            let _ = child.wait();
            return Ok(());
        }
        return Err(format!(
            "The documentation reader answered its probe with something else: {payload}"
        ));
    }
    let _ = child.wait();
    Err("The documentation reader did not answer its probe, so `ask` cannot be used".to_owned())
}

/// Fills `cache` with the file names the documentation probe looks for.
///
/// For the suites that drive a real turn: the probe reads this directory, and downloading three
/// gigabytes of models before a test can start is not something anybody would run.
#[cfg(all(test, feature = "godot-acceptance"))]
pub fn stage_probe_cache(cache: &Path) -> std::io::Result<()> {
    for file in required_model_files(cache) {
        fs::create_dir_all(file.parent().expect("every model file has a parent"))?;
        fs::write(file, [])?;
    }
    Ok(())
}

fn probe_models(cache: &Path) -> Result<(), String> {
    let required = required_model_files(cache);
    let missing = required.iter().filter(|file| !file.is_file()).count();
    if missing == 0 {
        return Ok(());
    }
    Err(format!(
        "The Godot documentation models are not installed: {missing} of {} files are missing from the model cache. Download them from Settings.",
        required.len()
    ))
}

fn retrieve_worker_path() -> Result<PathBuf, String> {
    let configured = std::env::var_os("GOFER_RAG_RETRIEVE_WORKER").map(PathBuf::from);
    let path = configured.unwrap_or_else(|| {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("scripts")
            // `rag-retrieve.mjs` holds the injectable request handling; only the worker reads
            // stdin and loads gofer-rag, so spawning the module itself would produce no output.
            .join("rag-retrieve-worker.mjs")
    });

    if path.is_file() {
        return Ok(path);
    }
    Err(format!(
        "Gofer RAG retrieve worker was not found at {}. Run npm install, or set GOFER_RAG_RETRIEVE_WORKER.",
        path.display()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::process::{
        ChildProcess, ProcessOutput, ProcessReader, ProcessSpawner, ProcessStatus, ProcessWriter,
    };
    use std::ffi::{OsStr, OsString};
    use std::io::{self, Cursor};
    use std::thread;
    use std::time::Duration;
    use tempfile::TempDir;

    fn answered(text: &str) -> GodotDocsResponse {
        GodotDocsResponse {
            text: Some(text.to_owned()),
            excerpt_verified: Some(true),
            ..GodotDocsResponse::default()
        }
    }

    /// A cache that also keeps dead ends hands the same dead end to every later task, and nothing
    /// ever asks again. Every state below is one the next asker should be allowed to pay to retry.
    #[test]
    fn only_a_real_answer_is_worth_remembering() {
        assert!(answered("It takes four arguments.").is_worth_remembering());
        assert!(
            GodotDocsResponse {
                passages: vec![RankedPassage {
                    text: "Tween".to_owned(),
                    chapter: "Tween".to_owned(),
                    order: 1,
                    score: 1.0,
                    pinned: None,
                }],
                ..GodotDocsResponse::default()
            }
            .is_worth_remembering(),
            "a search that found chapters answered"
        );

        assert!(
            !GodotDocsResponse::default().is_worth_remembering(),
            "nothing retrieved and nothing written is not an answer"
        );
        assert!(
            !GodotDocsResponse {
                coverage_miss: Some(true),
                ..answered("not covered by this documentation")
            }
            .is_worth_remembering(),
            "chapters about something else are a dead end, and the next asker may find better ones"
        );
        assert!(
            !GodotDocsResponse {
                abstained: Some(true),
                ..answered("unclear from this documentation")
            }
            .is_worth_remembering(),
            "an unsettled reading must not become the settled one"
        );
        assert!(
            !GodotDocsResponse {
                excerpt_verified: Some(false),
                ..answered("It takes four arguments.")
            }
            .is_worth_remembering(),
            "an answer whose quote is not in the manual was written from memory"
        );
    }

    #[test]
    fn cache_path_rejects_unsafe_targets() {
        assert!(validate_cache_path(std::env::temp_dir().join("gofer-safe-cache")).is_ok());
        assert!(
            validate_cache_path(PathBuf::from("/"))
                .unwrap_err()
                .contains("unsafe cache path")
        );
        assert!(
            validate_cache_path(PathBuf::from("/tmp/gofer/../other"))
                .unwrap_err()
                .contains("traversal components")
        );
        assert!(
            validate_cache_path(PathBuf::from("relative-cache"))
                .unwrap_err()
                .contains("unsafe cache path")
        );
        if let Some(home) = dirs::home_dir() {
            assert!(
                validate_cache_path(home)
                    .unwrap_err()
                    .contains("home directory")
            );
        }
    }

    #[test]
    fn cache_status_distinguishes_missing_incomplete_installed_and_busy() {
        let directory = TempDir::new().expect("temporary directory");
        let cache = directory.path().join("cache");
        let missing = cache_status_for_path(&cache, false).expect("missing status");
        assert_eq!(missing.state, CacheState::NotInstalled);
        assert_eq!(missing.size_bytes, 0);

        fs::create_dir(&cache).expect("create cache");
        fs::write(cache.join("partial.bin"), [1_u8, 2, 3]).expect("write partial cache");
        let incomplete = cache_status_for_path(&cache, false).expect("incomplete status");
        assert_eq!(incomplete.state, CacheState::Incomplete);
        assert_eq!(incomplete.size_bytes, 3);

        for file in required_model_files(&cache) {
            fs::create_dir_all(file.parent().expect("model parent")).expect("create model parent");
            fs::write(file, [0_u8; 2]).expect("write model file");
        }
        assert_eq!(
            cache_status_for_path(&cache, false)
                .expect("installed status")
                .state,
            CacheState::Installed
        );
        assert_eq!(
            cache_status_for_path(&cache, true)
                .expect("busy status")
                .state,
            CacheState::Busy
        );
    }

    #[test]
    fn concurrent_rag_initialization_joins_the_active_operation() {
        let (started_sender, started_receiver) = std::sync::mpsc::channel();
        let (release_sender, release_receiver) = std::sync::mpsc::channel();
        let leader = thread::spawn(move || {
            run_initialization(|| {
                started_sender
                    .send(())
                    .expect("report initialization start");
                release_receiver.recv().expect("release initialization");
                Err("warmup failed".to_owned())
            })
        });
        started_receiver.recv().expect("initialization start");

        let follower_operation_ran = Arc::new(AtomicBool::new(false));
        let follower_flag = Arc::clone(&follower_operation_ran);
        let follower = thread::spawn(move || {
            run_initialization(|| {
                follower_flag.store(true, Ordering::Release);
                Ok(())
            })
        });

        let follower_joined = (0..1_000).any(|_| {
            let reference_count = ACTIVE_INITIALIZATION
                .lock()
                .expect("active initialization")
                .as_ref()
                .map(Arc::strong_count)
                .unwrap_or_default();
            if reference_count >= 3 {
                return true;
            }
            thread::sleep(Duration::from_millis(1));
            false
        });
        assert!(
            follower_joined,
            "follower did not join active initialization"
        );

        release_sender.send(()).expect("release leader");
        assert_eq!(
            leader.join().expect("leader result"),
            Err("warmup failed".to_owned())
        );
        assert_eq!(
            follower.join().expect("follower result"),
            Err("warmup failed".to_owned())
        );
        assert!(!follower_operation_ran.load(Ordering::Acquire));
        assert!(!INITIALIZING.load(Ordering::Acquire));
    }

    #[cfg(unix)]
    #[test]
    fn directory_size_ignores_symlinks() {
        use std::os::unix::fs::symlink;

        let directory = TempDir::new().expect("temporary directory");
        let cache = directory.path().join("cache");
        let outside = directory.path().join("outside.bin");
        fs::create_dir(&cache).expect("create cache");
        fs::write(cache.join("inside.bin"), [0_u8; 4]).expect("write inside file");
        fs::write(&outside, [0_u8; 20]).expect("write outside file");
        symlink(&outside, cache.join("link.bin")).expect("create symlink");

        assert_eq!(directory_size(&cache).expect("cache size"), 4);
    }

    #[test]
    fn cache_deletion_is_safe_and_idempotent() {
        let directory = TempDir::new().expect("temporary directory");
        let cache = directory.path().join("cache");
        delete_cache_path(&cache).expect("missing cache deletion");
        fs::create_dir(&cache).expect("create cache");
        fs::write(cache.join("model.bin"), [0_u8; 4]).expect("write cache file");
        delete_cache_path(&cache).expect("cache deletion");
        assert!(!cache.exists());

        let file = directory.path().join("file");
        fs::write(&file, []).expect("write regular file");
        assert!(
            delete_cache_path(&file)
                .unwrap_err()
                .contains("not a directory")
        );
    }

    #[cfg(unix)]
    #[test]
    fn cache_deletion_refuses_symlink() {
        use std::os::unix::fs::symlink;

        let directory = TempDir::new().expect("temporary directory");
        let target = directory.path().join("target");
        let link = directory.path().join("cache");
        fs::create_dir(&target).expect("create target");
        symlink(&target, &link).expect("create cache symlink");

        assert!(
            delete_cache_path(&link)
                .unwrap_err()
                .contains("it is a symbolic link")
        );
        assert!(target.exists());
    }

    struct FakeRetrieveSpawner {
        child: Mutex<Option<FakeRetrieveChild>>,
        fail_spawn: bool,
    }

    struct FakeRetrieveChild {
        stdin: Option<ProcessWriter>,
        stdout: Option<ProcessReader>,
        stderr: Option<ProcessReader>,
        status: ProcessStatus,
    }

    impl FakeRetrieveSpawner {
        fn new(stdout: &str, stderr: &str, success: bool) -> Self {
            Self {
                child: Mutex::new(Some(FakeRetrieveChild {
                    stdin: Some(Box::new(Cursor::new(Vec::new()))),
                    stdout: Some(Box::new(Cursor::new(stdout.as_bytes().to_vec()))),
                    stderr: Some(Box::new(Cursor::new(stderr.as_bytes().to_vec()))),
                    status: ProcessStatus {
                        success,
                        code: Some(if success { 0 } else { 1 }),
                        description: if success {
                            "exit status: 0"
                        } else {
                            "exit status: 1"
                        }
                        .to_owned(),
                    },
                })),
                fail_spawn: false,
            }
        }
    }

    impl ProcessSpawner for FakeRetrieveSpawner {
        fn output(&self, _: &OsStr, _: &[OsString]) -> io::Result<ProcessOutput> {
            unreachable!("retrieve tests do not request command output")
        }

        fn spawn(&self, _: &OsStr, _: &[OsString], _: bool) -> io::Result<Box<dyn ChildProcess>> {
            if self.fail_spawn {
                return Err(io::Error::new(io::ErrorKind::NotFound, "fake Node missing"));
            }
            self.child
                .lock()
                .expect("fake child lock")
                .take()
                .map(|child| Box::new(child) as Box<dyn ChildProcess>)
                .ok_or_else(|| std::io::Error::other("fake process already spawned"))
        }
    }

    impl ChildProcess for FakeRetrieveChild {
        fn take_stdin(&mut self) -> Option<ProcessWriter> {
            self.stdin.take()
        }

        fn take_stdout(&mut self) -> Option<ProcessReader> {
            self.stdout.take()
        }

        fn take_stderr(&mut self) -> Option<ProcessReader> {
            self.stderr.take()
        }

        fn try_wait(&mut self) -> io::Result<Option<ProcessStatus>> {
            Ok(Some(self.status.clone()))
        }

        fn wait(&mut self) -> io::Result<ProcessStatus> {
            Ok(self.status.clone())
        }

        fn kill(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn sidecar_paths_resolve_to_executable_workers() {
        // Both modules split injectable request handling from the entry point that reads stdin.
        // Spawning the handling half would exit silently without ever answering.
        for path in [
            worker_path().expect("warmup worker"),
            retrieve_worker_path().expect("retrieve worker"),
        ] {
            let source = fs::read_to_string(&path).expect("read worker");
            assert!(
                source.contains("process.stdout"),
                "{} does not write a response, so it is not the entry point",
                path.display()
            );
        }
    }

    #[test]
    fn the_documentation_probe_counts_the_model_files_that_are_missing() {
        let directory = TempDir::new().expect("temporary directory");
        let cache = directory.path().join("cache");
        fs::create_dir(&cache).expect("create cache");

        let empty = probe_models(&cache).expect_err("an empty cache cannot answer a search");
        assert!(empty.contains("10 of 10 files are missing"), "{empty}");

        let required = required_model_files(&cache);
        for file in required.iter().skip(1) {
            fs::create_dir_all(file.parent().expect("model parent")).expect("create model parent");
            fs::write(file, [0_u8; 2]).expect("write model file");
        }
        let partial = probe_models(&cache).expect_err("a partial cache cannot answer a search");
        assert!(partial.contains("1 of 10 files are missing"), "{partial}");

        fs::create_dir_all(required[0].parent().expect("model parent")).expect("create parent");
        fs::write(&required[0], [0_u8; 2]).expect("write model file");
        probe_models(&cache).expect("a complete cache can answer a search");
    }

    #[test]
    fn retrieve_query_parses_worker_response_and_strips_vectors() {
        let directory = TempDir::new().expect("temporary directory");
        let cache = directory.path().join("cache");
        fs::create_dir(&cache).expect("create cache");
        // SAFETY: tests own the process environment while they execute.
        unsafe { std::env::set_var("GOFER_RAG_CACHE_DIR", cache.as_os_str()) };

        let response = serde_json::json!({
            "passages": [
                {"text": "Tween interpolation", "chapter": "Tween", "order": 3, "score": 0.95},
                {"text": "AnimationPlayer", "chapter": "Animation", "order": 7, "score": 0.88}
            ]
        });
        let stdout = format!(
            "{RETRIEVE_RESPONSE_PREFIX}{}\n",
            serde_json::to_string(&response).unwrap()
        );
        let spawner = FakeRetrieveSpawner::new(&stdout, "", true);

        let result = retrieve_query_with(
            GodotDocsQuery {
                question: "how do I tween?".to_owned(),
                max_passages: Some(2),
                max_text_chars: 2000,
            },
            None,
            false,
            &spawner,
        )
        .expect("retrieve query");

        assert_eq!(result.passages.len(), 2);
        assert_eq!(result.passages[0].chapter, "Tween");
        assert_eq!(result.passages[1].score, 0.88);

        // SAFETY: tests own the process environment while they execute.
        unsafe { std::env::remove_var("GOFER_RAG_CACHE_DIR") };
    }

    /// The default is a measured number, and a caller who names one outranks it.
    ///
    /// It used to be ten, which bound nothing: gofer-rag keeps five and pins up to three more, and
    /// 130 cached searches from a live project never returned more than six. So `godot_docs_search`
    /// was 23.5% of every byte the model read from a tool. Four is what replaying gofer-rag's 83
    /// labelled eval questions through every ceiling showed to be free — 79% of the bytes and no
    /// case lost, where three costs two cases for another 19 points.
    #[test]
    fn the_passage_default_is_four_and_a_caller_who_names_one_outranks_it() {
        let asked = |max_passages| GodotDocsQuery {
            question: "how do I tween?".to_owned(),
            max_passages,
            max_text_chars: 2000,
        };

        // One number for both operations: an `ask` reads the same list to write prose from, and the
        // cases a tighter ceiling costs are the ones it would have had to abstain on.
        assert_eq!(passages_for(&asked(None)), 4);

        // The desktop Docs panel names its own bound, and nothing here may override it.
        assert_eq!(passages_for(&asked(Some(8))), 8);
        assert_eq!(passages_for(&asked(Some(1))), 1);

        // Absent is absent: a query that names nothing deserializes to `None` rather than to a
        // number no caller wrote.
        let parsed: GodotDocsQuery =
            serde_json::from_value(serde_json::json!({"question": "how do I tween?"}))
                .expect("parse a query");
        assert_eq!(parsed.max_passages, None);
        assert_eq!(passages_for(&parsed), 4);
    }

    #[test]
    fn retrieve_query_propagates_worker_errors_and_failures() {
        let directory = TempDir::new().expect("temporary directory");
        let cache = directory.path().join("cache");
        fs::create_dir(&cache).expect("create cache");
        // SAFETY: tests own the process environment while they execute.
        unsafe { std::env::set_var("GOFER_RAG_CACHE_DIR", cache.as_os_str()) };

        let error_response = serde_json::json!({"error": "models are not cached"});
        let stdout = format!(
            "{RETRIEVE_RESPONSE_PREFIX}{}\n",
            serde_json::to_string(&error_response).unwrap()
        );
        let spawner = FakeRetrieveSpawner::new(&stdout, "", true);
        assert_eq!(
            retrieve_query_with(
                GodotDocsQuery {
                    question: "x".to_owned(),
                    max_passages: Some(1),
                    max_text_chars: 100,
                },
                None,
                false,
                &spawner,
            )
            .unwrap_err(),
            "models are not cached"
        );

        let silent = FakeRetrieveSpawner::new("", "", false);
        assert!(
            retrieve_query_with(
                GodotDocsQuery {
                    question: "x".to_owned(),
                    max_passages: Some(1),
                    max_text_chars: 100,
                },
                None,
                false,
                &silent,
            )
            .unwrap_err()
            .contains("exited with")
        );

        // SAFETY: tests own the process environment while they execute.
        unsafe { std::env::remove_var("GOFER_RAG_CACHE_DIR") };
    }
}

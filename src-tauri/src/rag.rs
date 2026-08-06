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
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("Could not inspect {}: {error}", path.display()))?;
    if metadata.file_type().is_symlink() {
        return Err(format!(
            "Refusing to delete the symlink at {}",
            path.display()
        ));
    }
    if !metadata.is_dir() {
        return Err(format!(
            "The Gofer RAG cache path is not a directory: {}",
            path.display()
        ));
    }
    fs::remove_dir_all(path)
        .map_err(|error| format!("Could not delete {}: {error}", path.display()))
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
        .map_err(|error| format!("Could not read cache directory {}: {error}", path.display()))?
    {
        let entry =
            entry.map_err(|error| format!("Could not inspect {}: {error}", path.display()))?;
        let metadata = entry
            .path()
            .symlink_metadata()
            .map_err(|error| format!("Could not inspect {}: {error}", entry.path().display()))?;
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

#[derive(Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GodotDocsQuery {
    pub question: String,
    #[serde(default = "default_max_passages")]
    pub max_passages: usize,
    #[serde(default = "default_max_text_chars")]
    pub max_text_chars: usize,
}

fn default_max_passages() -> usize {
    10
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
}

#[derive(Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GodotDocsResponse {
    pub passages: Vec<RankedPassage>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RetrieveWorkerRequest {
    question: String,
    cache_dir: String,
    max_passages: usize,
    max_text_chars: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RetrieveWorkerResponse {
    #[serde(default)]
    passages: Vec<RankedPassage>,
    #[serde(default)]
    error: Option<String>,
}

/// Queries the local Godot documentation through the gofer-rag retrieve sidecar.
///
/// Returns ranked passages without raw embedding vectors. Models must already be cached; run
/// `initialize_rag` first.
pub fn retrieve_query(query: GodotDocsQuery) -> Result<GodotDocsResponse, String> {
    retrieve_query_with(query, &SystemProcessSpawner)
}

pub fn retrieve_query_with(
    query: GodotDocsQuery,
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
    let request = RetrieveWorkerRequest {
        question: query.question,
        cache_dir: cache_path()?.display().to_string(),
        max_passages: query.max_passages,
        max_text_chars: query.max_text_chars,
    };
    let mut payload = serde_json::to_vec(&request)
        .map_err(|error| format!("Could not serialize the Gofer RAG query: {error}"))?;
    // The worker reads one request per line.
    payload.push(b'\n');
    stdin
        .write_all(&payload)
        .map_err(|error| format!("Could not send the Gofer RAG query: {error}"))?;
    drop(stdin);

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
        let Some(payload) = line.strip_prefix(RETRIEVE_RESPONSE_PREFIX) else {
            continue;
        };
        let response: RetrieveWorkerResponse = serde_json::from_str(payload)
            .map_err(|error| format!("Gofer RAG retrieve worker returned invalid data: {error}"))?;
        if let Some(error) = response.error {
            return Err(error);
        }
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
        return Ok(GodotDocsResponse {
            passages: response.passages,
        });
    }

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
                .contains("Refusing to delete the symlink")
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
                max_passages: 2,
                max_text_chars: 2000,
            },
            &spawner,
        )
        .expect("retrieve query");

        assert_eq!(result.passages.len(), 2);
        assert_eq!(result.passages[0].chapter, "Tween");
        assert_eq!(result.passages[1].score, 0.88);

        // SAFETY: tests own the process environment while they execute.
        unsafe { std::env::remove_var("GOFER_RAG_CACHE_DIR") };
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
                    max_passages: 1,
                    max_text_chars: 100,
                },
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
                    max_passages: 1,
                    max_text_chars: 100,
                },
                &silent,
            )
            .unwrap_err()
            .contains("exited with")
        );

        // SAFETY: tests own the process environment while they execute.
        unsafe { std::env::remove_var("GOFER_RAG_CACHE_DIR") };
    }
}

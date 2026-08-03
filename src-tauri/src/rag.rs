//! Gofer RAG model cache and warmup.
//!
//! Owns where the embedding and reranking models live, whether they are complete, and the single
//! coalesced warmup that downloads them. Tauri commands stay in `lib.rs` and call in here.

use crate::process::{ProcessSpawner, SystemProcessSpawner};
use serde::Serialize;
use std::fs;
use std::io::{BufRead, BufReader, Read};
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
    let safety_path = path.canonicalize().unwrap_or_else(|_| path.clone());
    let home = dirs::home_dir().and_then(|home| home.canonicalize().ok());
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

fn required_model_files(cache: &Path) -> [PathBuf; 7] {
    [
        cache.join("onnx-community/Qwen3-Embedding-0.6B-ONNX/config.json"),
        cache.join("onnx-community/Qwen3-Embedding-0.6B-ONNX/tokenizer.json"),
        cache.join("onnx-community/Qwen3-Embedding-0.6B-ONNX/onnx/model_fp16.onnx"),
        cache.join("onnx-community/Qwen3-Embedding-0.6B-ONNX/onnx/model_fp16.onnx_data"),
        cache.join("onnx-community/bge-reranker-v2-m3-ONNX/config.json"),
        cache.join("onnx-community/bge-reranker-v2-m3-ONNX/tokenizer.json"),
        cache.join("onnx-community/bge-reranker-v2-m3-ONNX/onnx/model_quantized.onnx"),
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

#[cfg(test)]
mod tests {
    use super::*;
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
}

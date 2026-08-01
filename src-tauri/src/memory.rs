use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

const RESPONSE_PREFIX: &str = "GOFER_MEMORY_RESPONSE:";
pub const MODEL: &str = "onnx-community/Qwen3-Embedding-0.6B-ONNX";
static NEXT_REQUEST_ID: AtomicU64 = AtomicU64::new(1);
static WORKER: Mutex<Option<MemoryWorker>> = Mutex::new(None);

struct MemoryWorker {
    _child: Child,
    stdin: BufWriter<ChildStdin>,
    stdout: BufReader<ChildStdout>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkerRequest<'a> {
    id: u64,
    mode: &'a str,
    texts: &'a [String],
    cache_dir: &'a Path,
}

#[derive(Deserialize)]
struct WorkerResponse {
    id: Option<u64>,
    vectors: Option<Vec<Vec<f32>>>,
    error: Option<String>,
}

pub fn embed_query(text: &str, cache_dir: &Path) -> Result<Vec<f32>, String> {
    embed("query", &[text.to_owned()], cache_dir)?
        .into_iter()
        .next()
        .ok_or_else(|| "The memory worker returned no query vector".to_owned())
}

pub fn embed_documents(texts: &[String], cache_dir: &Path) -> Result<Vec<Vec<f32>>, String> {
    embed("documents", texts, cache_dir)
}

fn embed(mode: &str, texts: &[String], cache_dir: &Path) -> Result<Vec<Vec<f32>>, String> {
    if texts.is_empty() {
        return Ok(Vec::new());
    }
    let id = NEXT_REQUEST_ID.fetch_add(1, Ordering::Relaxed);
    let mut worker = WORKER
        .lock()
        .map_err(|_| "The memory worker lock is poisoned".to_owned())?;
    if worker.is_none() {
        *worker = Some(start_worker()?);
    }
    let active = worker.as_mut().expect("memory worker initialized");
    let payload = serde_json::to_string(&WorkerRequest {
        id,
        mode,
        texts,
        cache_dir,
    })
    .map_err(|error| format!("Could not serialize the memory embedding request: {error}"))?;
    writeln!(active.stdin, "{payload}")
        .and_then(|_| active.stdin.flush())
        .map_err(|error| format!("Could not write to the memory worker: {error}"))?;
    loop {
        let mut line = String::new();
        let count = active
            .stdout
            .read_line(&mut line)
            .map_err(|error| format!("Could not read the memory worker: {error}"))?;
        if count == 0 {
            *worker = None;
            return Err("The memory worker exited unexpectedly".to_owned());
        }
        let Some(response) = line.trim().strip_prefix(RESPONSE_PREFIX) else {
            continue;
        };
        let response: WorkerResponse = serde_json::from_str(response)
            .map_err(|error| format!("The memory worker returned invalid JSON: {error}"))?;
        if let Some(error) = response.error {
            return Err(format!("Memory embedding failed: {error}"));
        }
        if response.id != Some(id) {
            continue;
        }
        return response
            .vectors
            .ok_or_else(|| "The memory worker returned no vectors".to_owned());
    }
}

fn start_worker() -> Result<MemoryWorker, String> {
    let node = std::env::var("GOFER_NODE_BINARY").unwrap_or_else(|_| "node".to_owned());
    let script = worker_path();
    let mut child = Command::new(&node)
        .arg(&script)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|error| format!("Could not start the memory worker with '{node}': {error}"))?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Could not open memory worker input".to_owned())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Could not open memory worker output".to_owned())?;
    Ok(MemoryWorker {
        _child: child,
        stdin: BufWriter::new(stdin),
        stdout: BufReader::new(stdout),
    })
}

fn worker_path() -> PathBuf {
    std::env::var_os("GOFER_MEMORY_WORKER")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("..")
                .join("scripts")
                .join("memory-worker.mjs")
        })
}

use crate::process::{
    ChildProcess, ProcessReader, ProcessSpawner, ProcessWriter, SystemProcessSpawner,
};
use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

const RESPONSE_PREFIX: &str = "GOFER_MEMORY_RESPONSE:";
pub const MODEL: &str = "onnx-community/Qwen3-Embedding-0.6B-ONNX";
static NEXT_REQUEST_ID: AtomicU64 = AtomicU64::new(1);
static WORKER: Mutex<Option<MemoryWorker>> = Mutex::new(None);

struct MemoryWorker {
    _child: Box<dyn ChildProcess>,
    stdin: BufWriter<ProcessWriter>,
    stdout: BufReader<ProcessReader>,
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
    embed_with(mode, texts, cache_dir, &WORKER, &SystemProcessSpawner)
}

// coverage-critical-start: protocol
fn embed_with(
    mode: &str,
    texts: &[String],
    cache_dir: &Path,
    workers: &Mutex<Option<MemoryWorker>>,
    spawner: &impl ProcessSpawner,
) -> Result<Vec<Vec<f32>>, String> {
    if texts.is_empty() {
        return Ok(Vec::new());
    }
    let id = NEXT_REQUEST_ID.fetch_add(1, Ordering::Relaxed);
    let mut worker = workers
        .lock()
        .map_err(|_| "The memory worker lock is poisoned".to_owned())?;
    if worker.is_none() {
        *worker = Some(start_worker(spawner)?);
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
        // A response carrying a different id belongs to an earlier request, so skip it before
        // reading its error. Only a line the worker could not correlate at all answers without
        // an id, and that failure does belong to this request.
        if response.id.is_some_and(|received| received != id) {
            continue;
        }
        if let Some(error) = response.error {
            return Err(format!("Memory embedding failed: {error}"));
        }
        return response
            .vectors
            .ok_or_else(|| "The memory worker returned no vectors".to_owned());
    }
}
// coverage-critical-end: protocol

fn start_worker(spawner: &impl ProcessSpawner) -> Result<MemoryWorker, String> {
    let node = crate::workers::node_binary();
    let script = worker_path()?;
    let mut child = spawner
        .spawn(node.as_ref(), &[script.into_os_string()], true)
        .map_err(|error| {
            format!(
                "Could not start the memory worker with '{}': {error}",
                node.display()
            )
        })?;
    let stdin = child
        .take_stdin()
        .ok_or_else(|| "Could not open memory worker input".to_owned())?;
    let stdout = child
        .take_stdout()
        .ok_or_else(|| "Could not open memory worker output".to_owned())?;
    Ok(MemoryWorker {
        _child: child,
        stdin: BufWriter::new(stdin),
        stdout: BufReader::new(stdout),
    })
}

fn worker_path() -> Result<PathBuf, String> {
    crate::workers::resolve(
        "The memory worker",
        "GOFER_MEMORY_WORKER",
        "memory-worker.mjs",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::process::{ProcessOutput, ProcessStatus};
    use std::ffi::{OsStr, OsString};
    use std::io::{self, Cursor};
    use std::sync::Arc;

    static MEMORY_TEST_LOCK: Mutex<()> = Mutex::new(());

    struct FakeSpawner {
        stdout: String,
        input: Arc<Mutex<Vec<u8>>>,
    }

    impl ProcessSpawner for FakeSpawner {
        fn output(&self, _: &OsStr, _: &[OsString]) -> io::Result<ProcessOutput> {
            unreachable!("memory workers do not request command output")
        }

        fn spawn(
            &self,
            _: &OsStr,
            _: &[OsString],
            piped_stdin: bool,
        ) -> io::Result<Box<dyn ChildProcess>> {
            assert!(piped_stdin);
            Ok(Box::new(FakeChild {
                stdin: Some(Box::new(SharedWriter(Arc::clone(&self.input)))),
                stdout: Some(Box::new(Cursor::new(self.stdout.clone().into_bytes()))),
            }))
        }
    }

    struct SharedWriter(Arc<Mutex<Vec<u8>>>);

    impl Write for SharedWriter {
        fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
            self.0.lock().expect("captured worker input").extend(buffer);
            Ok(buffer.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    struct FakeChild {
        stdin: Option<ProcessWriter>,
        stdout: Option<ProcessReader>,
    }

    impl ChildProcess for FakeChild {
        fn take_stdin(&mut self) -> Option<ProcessWriter> {
            self.stdin.take()
        }

        fn take_stdout(&mut self) -> Option<ProcessReader> {
            self.stdout.take()
        }

        fn take_stderr(&mut self) -> Option<ProcessReader> {
            None
        }

        fn try_wait(&mut self) -> io::Result<Option<ProcessStatus>> {
            unreachable!("memory workers are persistent")
        }

        fn wait(&mut self) -> io::Result<ProcessStatus> {
            unreachable!("memory workers are persistent")
        }

        fn kill(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    fn worker(stdout: String) -> (MemoryWorker, Arc<Mutex<Vec<u8>>>) {
        let input = Arc::new(Mutex::new(Vec::new()));
        let spawner = FakeSpawner {
            stdout,
            input: Arc::clone(&input),
        };
        (start_worker(&spawner).expect("fake memory worker"), input)
    }

    #[test]
    fn fake_worker_covers_query_documents_and_protocol_filtering() {
        let _test = MEMORY_TEST_LOCK.lock().expect("memory test lock");
        let cache = Path::new("/tmp/cache");
        let id = NEXT_REQUEST_ID.load(Ordering::Relaxed);
        let output = format!(
            "worker noise\n{RESPONSE_PREFIX}{{\"id\":{},\"vectors\":[[9.0]]}}\n{RESPONSE_PREFIX}{{\"id\":{id},\"vectors\":[[1.0,2.0]]}}\n",
            id + 1
        );
        let (fake, input) = worker(output);
        *WORKER.lock().expect("memory worker lock") = Some(fake);

        assert_eq!(
            embed_query("hello", cache).expect("query vector"),
            vec![1.0, 2.0]
        );
        let request =
            String::from_utf8(input.lock().expect("worker input").clone()).expect("UTF-8");
        assert!(request.contains("\"mode\":\"query\""));
        assert!(request.contains("\"texts\":[\"hello\"]"));

        assert!(
            embed_documents(&[], cache)
                .expect("empty documents")
                .is_empty()
        );
    }

    #[test]
    fn injected_spawner_starts_the_worker_on_first_embedding() {
        let _test = MEMORY_TEST_LOCK.lock().expect("memory test lock");
        let id = NEXT_REQUEST_ID.load(Ordering::Relaxed);
        let input = Arc::new(Mutex::new(Vec::new()));
        let spawner = FakeSpawner {
            stdout: format!("{RESPONSE_PREFIX}{{\"id\":{id},\"vectors\":[[3.0]]}}\n"),
            input,
        };
        let workers = Mutex::new(None);
        assert_eq!(
            embed_with(
                "documents",
                &["first".to_owned()],
                Path::new("/tmp/cache"),
                &workers,
                &spawner,
            )
            .expect("first embedding"),
            vec![vec![3.0]]
        );
        assert!(workers.lock().expect("local workers").is_some());
    }

    #[test]
    fn fake_worker_reports_remote_invalid_and_missing_responses() {
        let _test = MEMORY_TEST_LOCK.lock().expect("memory test lock");
        let cache = Path::new("/tmp/cache");
        for (kind, expected) in [
            ("remote", "Memory embedding failed: model failed"),
            ("invalid", "invalid JSON"),
            ("missing", "returned no vectors"),
            ("exit", "exited unexpectedly"),
        ] {
            let id = NEXT_REQUEST_ID.load(Ordering::Relaxed);
            let output = match kind {
                "remote" => {
                    format!("{RESPONSE_PREFIX}{{\"id\":{id},\"error\":\"model failed\"}}\n")
                }
                "invalid" => format!("{RESPONSE_PREFIX}not-json\n"),
                "missing" => format!("{RESPONSE_PREFIX}{{\"id\":{id}}}\n"),
                _ => String::new(),
            };
            let (fake, _) = worker(output);
            *WORKER.lock().expect("memory worker lock") = Some(fake);
            assert!(
                embed_documents(&["text".to_owned()], cache)
                    .unwrap_err()
                    .contains(expected)
            );
        }
    }

    #[test]
    fn a_stale_error_is_skipped_while_an_uncorrelated_error_is_reported() {
        let _test = MEMORY_TEST_LOCK.lock().expect("memory test lock");
        let cache = Path::new("/tmp/cache");

        // An error answering an earlier request must not fail the request in flight.
        let id = NEXT_REQUEST_ID.load(Ordering::Relaxed);
        let (fake, _) = worker(format!(
            "{RESPONSE_PREFIX}{{\"id\":{},\"error\":\"stale failure\"}}\n{RESPONSE_PREFIX}{{\"id\":{id},\"vectors\":[[4.0]]}}\n",
            id.wrapping_sub(1)
        ));
        *WORKER.lock().expect("memory worker lock") = Some(fake);
        assert_eq!(
            embed_documents(&["text".to_owned()], cache).expect("current vector"),
            vec![vec![4.0]]
        );

        // A failure the worker could not correlate has no id and does belong to this request.
        let (fake, _) = worker(format!(
            "{RESPONSE_PREFIX}{{\"error\":\"unparseable request\"}}\n"
        ));
        *WORKER.lock().expect("memory worker lock") = Some(fake);
        assert!(
            embed_documents(&["text".to_owned()], cache)
                .unwrap_err()
                .contains("unparseable request")
        );
    }

    #[test]
    fn worker_path_can_be_overridden() {
        let directory = tempfile::TempDir::new().expect("override directory");
        let expected = directory.path().join("fake-memory-worker.mjs");
        std::fs::write(&expected, b"override").expect("write the override worker");
        // SAFETY: this test owns the process-wide override while it executes.
        unsafe { std::env::set_var("GOFER_MEMORY_WORKER", &expected) };
        let resolved = worker_path();
        // SAFETY: restore the test process environment before the assertion can unwind.
        unsafe { std::env::remove_var("GOFER_MEMORY_WORKER") };
        assert_eq!(resolved.expect("the overridden worker"), expected);
    }
}

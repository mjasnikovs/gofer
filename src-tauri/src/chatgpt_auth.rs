//! ChatGPT subscription login through Pi's OpenAI Codex provider.
//!
//! The Node worker owns OAuth protocol details; this boundary owns process lifetime and the OS
//! credential store. Secrets use their own stdout prefix and never cross the renderer channel.

use crate::settings::store_chatgpt_credential;
use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use tauri::ipc::Channel;

const EVENT_PREFIX: &str = "GOFER_CODEX_EVENT:";
const CREDENTIAL_PREFIX: &str = "GOFER_CODEX_CREDENTIAL:";
static LOGIN: Mutex<Option<ActiveLogin>> = Mutex::new(None);

struct ActiveLogin {
    child: Arc<Mutex<Child>>,
    stdin: Arc<Mutex<ChildStdin>>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChatGptLoginPayload {
    event: serde_json::Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ChatGptLoginMethod {
    Browser,
    DeviceCode,
}

impl ChatGptLoginMethod {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Browser => "browser",
            Self::DeviceCode => "device_code",
        }
    }
}

/// Where the ChatGPT worker lives, for signing in and for asking Pi what it can run.
///
/// One of the two workers Gofer bundles, so `workers` finds it in the application's resources
/// rather than beside the source that was compiled. Still overridable, which is how a test run
/// puts a stub in its place.
pub(crate) fn worker_path() -> Result<PathBuf, String> {
    crate::workers::resolve(
        "The ChatGPT worker",
        "GOFER_CHATGPT_WORKER",
        "ai-codex-auth.mjs",
    )
}

/// Runs one short ChatGPT worker operation and hands back the events it reported.
///
/// Sign-in streams and needs its stdin held open; asking for the model catalogue or checking a
/// stored token does not, so those close the input and read to the end.
pub(crate) fn run_worker(request: &serde_json::Value) -> Result<Vec<serde_json::Value>, String> {
    let node = crate::workers::node_binary();
    let mut child = Command::new(&node)
        .arg(worker_path()?)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| {
            format!(
                "Could not start the Pi ChatGPT worker with '{}': {error}",
                node.display()
            )
        })?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Could not write to the Pi ChatGPT worker".to_owned())?;
    serde_json::to_writer(&mut stdin, request)
        .map_err(|error| format!("Could not serialize the ChatGPT worker request: {error}"))?;
    stdin
        .write_all(b"\n")
        .map_err(|error| format!("Could not send the ChatGPT worker request: {error}"))?;
    drop(stdin);

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Could not read the Pi ChatGPT worker".to_owned())?;
    let mut events = Vec::new();
    for line in BufReader::new(stdout).lines() {
        let line =
            line.map_err(|error| format!("Could not read ChatGPT worker output: {error}"))?;
        if let Some(payload) = line.strip_prefix(CREDENTIAL_PREFIX) {
            let credential = serde_json::from_str(payload)
                .map_err(|error| format!("ChatGPT returned an invalid credential: {error}"))?;
            store_chatgpt_credential(&credential)?;
            continue;
        }
        if let Some(payload) = line.strip_prefix(EVENT_PREFIX) {
            events.push(
                serde_json::from_str(payload)
                    .map_err(|error| format!("ChatGPT returned an invalid event: {error}"))?,
            );
        }
    }
    let output = child
        .wait_with_output()
        .map_err(|error| format!("Could not wait for the ChatGPT worker: {error}"))?;
    if output.status.success() {
        return Ok(events);
    }
    let detail = String::from_utf8_lossy(&output.stderr);
    Err(if detail.trim().is_empty() {
        "The ChatGPT worker did not complete".to_owned()
    } else {
        detail.trim().to_owned()
    })
}

fn write_line(stdin: &Arc<Mutex<ChildStdin>>, value: &serde_json::Value) -> Result<(), String> {
    let mut stdin = stdin
        .lock()
        .map_err(|_| "The ChatGPT login input lock is poisoned".to_owned())?;
    serde_json::to_writer(&mut *stdin, value)
        .map_err(|error| format!("Could not serialize the ChatGPT login input: {error}"))?;
    stdin
        .write_all(b"\n")
        .and_then(|()| stdin.flush())
        .map_err(|error| format!("Could not write to the ChatGPT login worker: {error}"))
}

pub(crate) fn login(
    method: ChatGptLoginMethod,
    events: Channel<ChatGptLoginPayload>,
) -> Result<(), String> {
    let _provider_operation = crate::ai_turn::begin_provider_operation()?;
    let mut active = LOGIN
        .lock()
        .map_err(|_| "The ChatGPT login lock is poisoned".to_owned())?;
    if active.is_some() {
        return Err("A ChatGPT login is already in progress".to_owned());
    }

    let node = crate::workers::node_binary();
    let mut child = Command::new(&node)
        .arg(worker_path()?)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| {
            format!(
                "Could not start ChatGPT login with '{}': {error}",
                node.display()
            )
        })?;
    let stdin =
        Arc::new(Mutex::new(child.stdin.take().ok_or_else(|| {
            "Could not write to the ChatGPT login worker".to_owned()
        })?));
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Could not read the ChatGPT login worker".to_owned())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Could not read ChatGPT login errors".to_owned())?;
    let child = Arc::new(Mutex::new(child));
    write_line(
        &stdin,
        &serde_json::json!({"operation": "login", "method": method.as_str()}),
    )?;
    *active = Some(ActiveLogin {
        child: Arc::clone(&child),
        stdin: Arc::clone(&stdin),
    });
    drop(active);
    let stderr_reader = std::thread::spawn(move || {
        let mut output = String::new();
        let _ = BufReader::new(stderr).read_to_string(&mut output);
        output
    });
    let outcome = (|| {
        let mut received_credential = false;
        for line in BufReader::new(stdout).lines() {
            let line =
                line.map_err(|error| format!("Could not read ChatGPT login output: {error}"))?;
            if let Some(payload) = line.strip_prefix(CREDENTIAL_PREFIX) {
                let credential = serde_json::from_str(payload)
                    .map_err(|error| format!("ChatGPT returned an invalid credential: {error}"))?;
                store_chatgpt_credential(&credential)?;
                received_credential = true;
                continue;
            }
            let Some(payload) = line.strip_prefix(EVENT_PREFIX) else {
                continue;
            };
            let event = serde_json::from_str(payload)
                .map_err(|error| format!("ChatGPT returned an invalid login event: {error}"))?;
            events
                .send(ChatGptLoginPayload { event })
                .map_err(|error| format!("Could not report ChatGPT login progress: {error}"))?;
        }
        let status = child
            .lock()
            .map_err(|_| "The ChatGPT login process lock is poisoned".to_owned())?
            .wait()
            .map_err(|error| format!("Could not wait for ChatGPT login: {error}"))?;
        let stderr = stderr_reader
            .join()
            .map_err(|_| "Could not collect ChatGPT login errors".to_owned())?;
        if !status.success() {
            let detail = stderr.trim();
            return Err(if detail.is_empty() {
                "ChatGPT login did not complete".to_owned()
            } else {
                format!("ChatGPT login failed: {detail}")
            });
        }
        if !received_credential {
            return Err("ChatGPT login completed without a credential".to_owned());
        }
        Ok(())
    })();
    if let Ok(mut active) = LOGIN.lock() {
        *active = None;
    }
    outcome
}

pub(crate) fn respond(value: String) -> Result<(), String> {
    let active = LOGIN
        .lock()
        .map_err(|_| "The ChatGPT login lock is poisoned".to_owned())?;
    let login = active
        .as_ref()
        .ok_or_else(|| "No ChatGPT login is waiting for a response".to_owned())?;
    write_line(
        &login.stdin,
        &serde_json::json!({"type": "prompt-response", "value": value}),
    )
}

pub(crate) fn cancel() -> Result<bool, String> {
    let active = LOGIN
        .lock()
        .map_err(|_| "The ChatGPT login lock is poisoned".to_owned())?;
    let Some(login) = active.as_ref() else {
        return Ok(false);
    };
    login
        .child
        .lock()
        .map_err(|_| "The ChatGPT login process lock is poisoned".to_owned())?
        .kill()
        .map_err(|error| format!("Could not cancel ChatGPT login: {error}"))?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::{cancel, respond, run_worker, worker_path};
    use std::fs;
    use std::path::PathBuf;
    use std::sync::Mutex;
    use tempfile::TempDir;

    /// `GOFER_NODE_BINARY`, `GOFER_CHATGPT_WORKER` and `LOGIN` are process-wide, so these take
    /// turns rather than racing each other for them.
    static CHATGPT_TEST_LOCK: Mutex<()> = Mutex::new(());

    /// Puts a Node worker of the test's own writing where the real one is looked up.
    ///
    /// The worker contract is a line protocol over a child process, and a stub is what lets the
    /// prefixes, the exit status and the stderr fallback be driven one at a time. It reads the
    /// request first, because a worker that never drains stdin would deadlock a large one.
    fn stub_worker(directory: &TempDir, body: &str) -> PathBuf {
        let path = directory.path().join("stub-codex-auth.mjs");
        fs::write(
            &path,
            format!(
                "let request = ''\n\
                 process.stdin.setEncoding('utf8')\n\
                 process.stdin.on('data', chunk => {{ request += chunk }})\n\
                 process.stdin.on('end', () => {{\n{body}\n}})\n"
            ),
        )
        .expect("write the stub worker");
        // SAFETY: the test holds `CHATGPT_TEST_LOCK` for as long as this override is in place.
        unsafe { std::env::set_var("GOFER_CHATGPT_WORKER", &path) };
        path
    }

    /// Restores the process environment the stub borrowed.
    fn clear_overrides() {
        // SAFETY: as above; the lock is still held by the calling test.
        unsafe {
            std::env::remove_var("GOFER_CHATGPT_WORKER");
            std::env::remove_var("GOFER_NODE_BINARY");
        }
    }

    #[test]
    fn the_worker_path_can_be_overridden_and_says_so_when_it_is_wrong() {
        let _guard = CHATGPT_TEST_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let existing = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("scripts")
            .join("ai-codex-auth.mjs");
        // SAFETY: this test owns the process-wide override while it executes.
        unsafe { std::env::set_var("GOFER_CHATGPT_WORKER", &existing) };
        assert_eq!(worker_path().expect("overridden worker"), existing);

        // SAFETY: as above; the override is removed before the test returns.
        unsafe { std::env::set_var("GOFER_CHATGPT_WORKER", "/nowhere/ai-codex-auth.mjs") };
        let failure = worker_path().expect_err("a path that is not a file");
        assert!(failure.contains("/nowhere/ai-codex-auth.mjs"), "{failure}");
        assert!(failure.contains("GOFER_CHATGPT_WORKER"), "{failure}");

        clear_overrides();
    }

    /**
     * The request has to arrive, and only the prefixed lines are events.
     *
     * A worker prints progress of its own — Node warnings land on stdout too — so a boundary that
     * parsed every line would fail a sign-in over a deprecation notice. The prefix is the contract,
     * and everything without it is output the renderer never sees.
     */
    #[test]
    fn only_the_prefixed_lines_come_back_and_the_request_reaches_the_worker() {
        let _guard = CHATGPT_TEST_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let directory = TempDir::new().expect("temporary directory");
        stub_worker(
            &directory,
            "  console.log('a plain line the worker printed')\n\
             \x20 console.log('GOFER_CODEX_EVENT:' + JSON.stringify({seen: JSON.parse(request)}))\n\
             \x20 console.log('GOFER_CODEX_EVENT:' + JSON.stringify({type: 'done'}))\n",
        );

        let events =
            run_worker(&serde_json::json!({"operation": "models"})).expect("worker events");

        assert_eq!(events.len(), 2, "{events:?}");
        assert_eq!(events[0]["seen"]["operation"], "models");
        assert_eq!(events[1]["type"], "done");
        clear_overrides();
    }

    /// A worker that fails says why, in the words it printed rather than in an exit code.
    #[test]
    fn a_worker_that_fails_reports_what_it_printed() {
        let _guard = CHATGPT_TEST_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let directory = TempDir::new().expect("temporary directory");
        stub_worker(
            &directory,
            "  console.error('the account has no ChatGPT subscription')\n\
             \x20 process.exit(3)\n",
        );

        let failure = run_worker(&serde_json::json!({"operation": "models"}))
            .expect_err("a worker that exits non-zero");

        assert_eq!(failure, "the account has no ChatGPT subscription");
        clear_overrides();
    }

    /// A silent failure still has to say something, or the window reports an empty error.
    #[test]
    fn a_worker_that_fails_silently_still_says_it_did_not_complete() {
        let _guard = CHATGPT_TEST_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let directory = TempDir::new().expect("temporary directory");
        stub_worker(&directory, "  process.exit(1)\n");

        let failure = run_worker(&serde_json::json!({"operation": "models"}))
            .expect_err("a worker that exits non-zero");

        assert_eq!(failure, "The ChatGPT worker did not complete");
        clear_overrides();
    }

    /// A prefixed line that is not JSON is the worker's fault, and is named as such.
    #[test]
    fn an_event_that_is_not_json_is_refused() {
        let _guard = CHATGPT_TEST_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let directory = TempDir::new().expect("temporary directory");
        stub_worker(&directory, "  console.log('GOFER_CODEX_EVENT:{')\n");

        let failure =
            run_worker(&serde_json::json!({"operation": "models"})).expect_err("a malformed event");

        assert!(
            failure.starts_with("ChatGPT returned an invalid event"),
            "{failure}"
        );
        clear_overrides();
    }

    /// The interpreter that could not be started is named, because it is the thing to fix.
    #[test]
    fn a_node_binary_that_cannot_be_started_is_named() {
        let _guard = CHATGPT_TEST_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let directory = TempDir::new().expect("temporary directory");
        stub_worker(&directory, "  process.exit(0)\n");
        // SAFETY: the test holds the lock, and `clear_overrides` removes this before it returns.
        unsafe { std::env::set_var("GOFER_NODE_BINARY", "/nowhere/node") };

        let failure =
            run_worker(&serde_json::json!({"operation": "models"})).expect_err("no interpreter");

        assert!(failure.contains("/nowhere/node"), "{failure}");
        clear_overrides();
    }

    /**
     * Nothing is signing in, and both controls have to survive that.
     *
     * The window can ask to cancel or answer a prompt after the login has already ended — a click
     * lands after the worker exits — so neither may reach into a login that is not there.
     */
    #[test]
    fn the_login_controls_answer_when_no_login_is_running() {
        let _guard = CHATGPT_TEST_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());

        assert!(!cancel().expect("cancelling nothing is not a failure"));
        let failure = respond("code".to_owned()).expect_err("no login to answer");
        assert_eq!(failure, "No ChatGPT login is waiting for a response");
    }
}

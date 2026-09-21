//! An addon that answers from inside this process.
//!
//! [`crate::godot_session::Editor`] had two implementations and neither of them answered a
//! command. `Supervised` reads a real editor and `ExternalEditor::absent` answers `None` to
//! everything, so the 61 catalogue operations [`crate::tool_params::Answers::Addon`] routes — 56%
//! of what the model is offered — could be proven only by booting Godot under xvfb, at about four
//! and a half seconds a test.
//!
//! The transport is where the second adapter fits. [`godot_rpc::RpcSession`] speaks
//! line-delimited JSON over loopback to whatever connects and presents its token, and a thread in
//! this process can do that as well as an editor can. `godot_rpc`'s own tests have scripted that
//! peer for as long as they have existed; what was missing was a way to bind one as the process's
//! editor, so that the router, the refusals and the read ledger meet an addon rather than a
//! `session_not_active`.
//!
//! What this is not: a simulation of Godot. A scripted answer is a recorded one, so it proves what
//! Gofer does with an answer and never what the editor would have said. The addon's own behaviour
//! stays where it is provable — the 91 GDScript acceptance tests against the pinned engine.
//!
//! A scripted answer cannot drift from the declaration either way: a debug build deserializes
//! every answer off this socket into the command's [`crate::tool_results`] struct, exactly as it
//! does a real editor's, so a script that answers a shape `params.json` does not declare fails
//! here by name.
#![cfg(test)]

use crate::godot_rpc::RpcSession;
use crate::godot_session::{ExternalEditor, SESSION_TEST_LOCK, bind};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

/// One command the router sent, as the addon received it.
#[derive(Clone, Debug)]
pub(crate) struct Asked {
    pub(crate) command: String,
    pub(crate) params: Value,
}

/// An addon bound as the process's editor for as long as this is held.
///
/// Holds [`SESSION_TEST_LOCK`] for the same reason [`crate::godot_session::no_editor_bound`] does:
/// the binding is process-wide, so a test that did not take it would read whichever editor the
/// last one left behind.
pub(crate) struct ScriptedAddon {
    session: RpcSession,
    asked: Arc<Mutex<Vec<Asked>>>,
    stopping: Arc<AtomicBool>,
    _lock: MutexGuard<'static, ()>,
}

impl ScriptedAddon {
    /// Binds an addon that answers each of these commands with the value beside it, as often as it
    /// is asked, and refuses anything else by name.
    ///
    /// The worktree is the caller's, because the operations worth driving through here are the
    /// ones that name a file and are held to the worktree for it.
    pub(crate) fn answering(worktree: &std::path::Path, script: &[(&str, Value)]) -> Self {
        let lock = SESSION_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let answers: HashMap<String, Value> = script
            .iter()
            .map(|(command, answer)| ((*command).to_owned(), answer.clone()))
            .collect();
        let project_path = worktree.display().to_string();
        let token = "a1".repeat(32);

        let listener = TcpListener::bind("127.0.0.1:0").expect("a loopback listener");
        let address = listener.local_addr().expect("the listener's address");
        let session = RpcSession::start(listener, token.clone(), project_path.clone());

        let asked = Arc::new(Mutex::new(Vec::new()));
        let stopping = Arc::new(AtomicBool::new(false));
        // The peer reports the handshake back rather than the caller waiting a guessed interval
        // for it: a connection is an event, and this is the event.
        let (settled, handshaken) = std::sync::mpsc::channel::<Result<(), String>>();
        std::thread::spawn({
            let asked = Arc::clone(&asked);
            let stopping = Arc::clone(&stopping);
            move || match connect_and_handshake(address, &token, &project_path) {
                Ok(addon) => {
                    let _ = settled.send(Ok(()));
                    answer_until_stopped(addon, &answers, &asked, &stopping);
                }
                Err(why) => {
                    let _ = settled.send(Err(why));
                }
            }
        });
        handshaken
            .recv()
            .expect("the scripted addon reported its handshake")
            .expect("the scripted addon completed its handshake");

        bind(Some(Arc::new(
            ExternalEditor::at(0, 0, worktree).with_rpc(session.clone()),
        )));
        Self {
            session,
            asked,
            stopping,
            _lock: lock,
        }
    }

    /// Every command the router sent, in the order it sent them.
    ///
    /// Everything the *process* sent: the binding is process-wide, so a test running beside this
    /// one reaches the same addon. A caller asserts about the commands it sent itself, which is
    /// what [`Self::asked_about`] is for.
    pub(crate) fn asked(&self) -> Vec<Asked> {
        self.asked
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    /// The commands whose name starts with this, in the order they were sent.
    pub(crate) fn asked_about(&self, prefix: &str) -> Vec<Asked> {
        self.asked()
            .into_iter()
            .filter(|one| one.command.starts_with(prefix))
            .collect()
    }
}

impl Drop for ScriptedAddon {
    fn drop(&mut self) {
        self.stopping.store(true, Ordering::SeqCst);
        bind(None);
        self.session.stop();
    }
}

/// Connects as the addon does and presents the token the session was started with.
fn connect_and_handshake(
    address: std::net::SocketAddr,
    token: &str,
    project_path: &str,
) -> Result<TcpStream, String> {
    let mut addon = TcpStream::connect(address).map_err(|why| why.to_string())?;
    let hello = json!({
        "protocolVersion": 2,
        "kind": "handshake",
        "id": "scripted-handshake",
        "token": token,
        "acceptedVersions": [2],
        "client": {
            "name": "gofer-godot-addon",
            "addonVersion": "2.0.0",
            "engineVersion": format!("{}.stable", crate::godot_session::REQUIRED_ENGINE_VERSION),
            "projectPath": project_path,
            "capabilities": ["session", "scene"]
        }
    });
    writeln!(addon, "{hello}").map_err(|why| why.to_string())?;
    let mut reader = BufReader::new(addon.try_clone().map_err(|why| why.to_string())?);
    let mut answered = String::new();
    reader
        .read_line(&mut answered)
        .map_err(|why| why.to_string())?;
    let answered: Value = serde_json::from_str(&answered).map_err(|why| why.to_string())?;
    match answered["kind"].as_str() {
        Some("response") => Ok(addon),
        _ => Err(format!("the session refused the handshake: {answered}")),
    }
}

/// Reads requests and answers them from the script until the connection or the binding ends.
fn answer_until_stopped(
    addon: TcpStream,
    answers: &HashMap<String, Value>,
    asked: &Arc<Mutex<Vec<Asked>>>,
    stopping: &Arc<AtomicBool>,
) {
    let mut writer = match addon.try_clone() {
        Ok(writer) => writer,
        Err(_) => return,
    };
    let mut reader = BufReader::new(addon);
    let mut line = String::new();
    while !stopping.load(Ordering::SeqCst) {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) | Err(_) => return,
            Ok(_) => (),
        }
        let Ok(request) = serde_json::from_str::<Value>(&line) else {
            return;
        };
        // The transport's own traffic belongs to nobody, and answering it would put a heartbeat in
        // the record of what the router asked for.
        let Some(command) = request["command"].as_str() else {
            continue;
        };
        if let Ok(mut recorded) = asked.lock() {
            recorded.push(Asked {
                command: command.to_owned(),
                params: request["params"].clone(),
            });
        }
        let answer = match answers.get(command) {
            Some(answer) => json!({
                "protocolVersion": 2,
                "kind": "response",
                "id": request["id"],
                "result": answer,
            }),
            None => json!({
                "protocolVersion": 2,
                "kind": "error",
                "id": request["id"],
                "error": {
                    "code": "unknown_command",
                    "message": format!("{command} is not in this addon's script"),
                    "retryable": false,
                    "readiness": "ready",
                    "details": {}
                }
            }),
        };
        if writeln!(writer, "{answer}").is_err() {
            return;
        }
    }
}

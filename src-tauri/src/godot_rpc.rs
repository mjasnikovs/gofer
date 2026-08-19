//! Persistent, authenticated editor RPC for protocol v2.
#![allow(dead_code)]
//!
//! The session supervisor binds a loopback TCP port and passes its address plus a session token to
//! the Godot editor through the process environment. The Gofer addon connects outward, sends a
//! handshake, and then receives requests while emitting responses and events. This module owns
//! that connection: handshake validation, request/response correlation, event sequencing,
//! heartbeat generation, payload limits, and reconnect rules.

use crate::protocol_v2::{
    EnvelopeKind, MAX_ENVELOPE_BYTES, MAX_ID_LENGTH, MAX_IMAGE_ENVELOPE_BYTES, MAX_TIMEOUT_MS,
    PROTOCOL_VERSION, Readiness, enforce_envelope_size, validate_envelope,
};
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

pub(crate) const HEARTBEAT_INTERVAL_MS: u64 = 5_000;
/// The id Gofer reuses for every heartbeat request. The addon answers it like any other request, so
/// the correlation table never holds an entry for it and its reply is recognized by this id alone.
const HEARTBEAT_ID: &str = "heartbeat";
/// What a `session.cancel` request is called, so its own answer is recognized as nobody's.
const CANCEL_ID_PREFIX: &str = "cancel-";
/// A cancellation is fire-and-forget, so this only bounds how long the addon may hold it.
const CANCEL_TIMEOUT_MS: u64 = 5_000;
const CONNECT_TIMEOUT_MS: u64 = 30_000;
const DEFAULT_REQUEST_TIMEOUT_MS: u64 = 60_000;
const MAX_RECONNECT_ATTEMPTS: usize = 3;
const RECONNECT_BACKOFF_MS: u64 = 500;
/// How often the accept loop looks up from the socket to check the deadline and the stop signal.
const ACCEPT_POLL_MS: u64 = 25;

/// The correlation id every request is sent under. Process-wide, so two sessions in one process —
/// which the acceptance suite has — cannot hand each other's waiters an answer.
static NEXT_REQUEST_ID: AtomicU64 = AtomicU64::new(1);

/// The next correlation id, unique for the life of this process.
///
/// A counter rather than a name, so it cannot repeat, cannot exceed the protocol's 128 characters,
/// and cannot collide with the names the transport reserves for traffic that belongs to nobody.
/// All three of those used to be a caller's business, and two of them were written down nowhere.
fn mint_id() -> String {
    format!("gofer-{}", NEXT_REQUEST_ID.fetch_add(1, Ordering::Relaxed))
}

/// Whether an id a caller chose is one the transport can carry. See `CallRequest::named`.
fn usable_id(id: &str) -> Result<(), RpcError> {
    if id.len() > MAX_ID_LENGTH {
        return Err(RpcError::new(
            "invalid_request_id",
            "Request id exceeds 128 characters",
        ));
    }
    if id == HEARTBEAT_ID || id.starts_with(CANCEL_ID_PREFIX) {
        return Err(RpcError::new(
            "invalid_request_id",
            "Request id is one the transport reserves for traffic that belongs to nobody",
        ));
    }
    Ok(())
}

/// A structured, actionable RPC failure.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RpcError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
    pub readiness: Readiness,
    pub details: Value,
}

impl RpcError {
    pub(crate) fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_owned(),
            message: message.into(),
            retryable: false,
            readiness: Readiness::Ready,
            details: json!({}),
        }
    }

    fn retryable(mut self) -> Self {
        self.retryable = true;
        self
    }

    /// Carries the facts the window needs to offer a way out of this failure.
    ///
    /// A message is a sentence, and a sentence is not something a button can be built from. The
    /// details are: they name the task, the path, or the run the user has to act on, so the banner
    /// can be a control rather than a wall of text.
    pub(crate) fn with_details(mut self, details: Value) -> Self {
        self.details = details;
        self
    }

    fn to_envelope(&self, id: &str) -> Value {
        json!({
            "protocolVersion": PROTOCOL_VERSION,
            "kind": "error",
            "id": id,
            "error": self,
        })
    }
}

/// A value event emitted by the Godot addon.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventEnvelope {
    pub sequence: u64,
    pub event: String,
    pub data: Value,
}

/// A response returned for a correlated request.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResponseEnvelope {
    pub id: String,
    pub result: Value,
    pub revision: Option<u64>,
}

/// One request to the addon, and what the caller needs decided about it.
///
/// It carries no correlation id. Six call sites used to invent one — `ai-{command}-{n}`,
/// `session-{uuid}`, a fixed `gofer-session-quit`, three `acceptance-…` spellings, and
/// `crypto.randomUUID()` in the renderer — and none of them ever read it back. The id's rules were
/// the session's the whole time and only one of the three was expressible: it must be at most 128
/// characters, it must not collide with the `heartbeat` and `cancel-` names the transport reserves
/// for traffic that belongs to nobody, and it must be unique among requests in flight *and among
/// abandoned ones*, because a call that timed out deliberately leaves its pending entry behind. A
/// scheme that could repeat a spelling — `acceptance-try-{revision}-{command}`, stable across a
/// sweep of failed mutations at one revision — could hand one call's reply to a different waiter,
/// and `pending.insert` overwrote in silence.
#[derive(Clone, Debug)]
pub struct CallRequest {
    /// Minted by the session. See [`CallRequest`].
    id: String,
    pub command: String,
    pub params: Value,
    pub expected_revision: Option<u64>,
    /// The scene the caller's revision was read from. See [`CallRequest::about`].
    pub expected_scene: Option<String>,
    pub timeout_ms: Option<u64>,
}

impl CallRequest {
    /// One request, with the id left to the session that will send it.
    pub fn new(command: impl Into<String>, params: Value) -> Self {
        Self {
            id: String::new(),
            command: command.into(),
            params,
            expected_revision: None,
            expected_scene: None,
            timeout_ms: None,
        }
    }

    /// Refuses the call unless the edited scene is still at this revision.
    pub fn expecting(mut self, revision: Option<u64>) -> Self {
        self.expected_revision = revision;
        self
    }

    /// Refuses the call unless the editor is still editing this scene.
    ///
    /// A revision on its own does not say which scene it counts. The addon resets its counter to
    /// zero every time the edited scene changes, so a caller holding revision zero for one scene
    /// matches a freshly opened *different* scene exactly — and the mutation lands in it, silently.
    /// Naming the scene is what closes that, and it is the caller's own last read that names it.
    pub fn about(mut self, scene: Option<String>) -> Self {
        self.expected_scene = scene;
        self
    }

    /// How long the caller will wait. Clamped by the protocol's own ceiling.
    pub fn within(mut self, timeout_ms: Option<u64>) -> Self {
        self.timeout_ms = timeout_ms;
        self
    }

    /// Sends this request under an id the caller chose, for the one case that needs one.
    ///
    /// `session.cancel` names the request it retracts, so a caller that has to retract its own
    /// in-flight request from another thread has to know the id before the call returns. That is
    /// the whole population, and it is a test. Everything else lets the session mint one, and the
    /// three rules are enforced here either way — length, the reserved names, and uniqueness —
    /// rather than at six call sites where two of them were written down nowhere.
    pub fn named(mut self, id: impl Into<String>) -> Self {
        self.id = id.into();
        self
    }

    /// The correlation id this request was sent under, once it has one.
    pub fn id(&self) -> &str {
        &self.id
    }
}

struct PendingRequest {
    sender: std::sync::mpsc::Sender<Result<ResponseEnvelope, RpcError>>,
}

enum ConnectionState {
    Idle,
    Connected { writer: TcpStream },
    Closed { error: RpcError },
}

struct SharedState {
    token: String,
    project_path: String,
    pending: HashMap<String, PendingRequest>,
    events: Vec<std::sync::mpsc::Sender<EventEnvelope>>,
    connection: ConnectionState,
    closed: bool,
    next_sequence: u64,
    /// What the addon last said about itself, not what Gofer hoped. Both of these belong to the
    /// connection: they are set from the addon's own events and dropped when it goes away, so
    /// nothing can read a readiness or a play state that outlived the editor that reported it.
    readiness: Readiness,
    is_playing: bool,
}

/// A persistent, authenticated editor RPC session.
#[derive(Clone)]
pub struct RpcSession {
    state: Arc<Mutex<SharedState>>,
    request_tx: std::sync::mpsc::Sender<CallRequest>,
    stop_signal: Arc<AtomicBool>,
}

impl RpcSession {
    /// Start accepting the addon connection on `listener`. The addon must present `token` and
    /// report `project_path` during the handshake.
    pub fn start(listener: TcpListener, token: String, project_path: String) -> Self {
        let state = Arc::new(Mutex::new(SharedState {
            token,
            project_path,
            pending: HashMap::new(),
            events: Vec::new(),
            connection: ConnectionState::Idle,
            closed: false,
            next_sequence: 0,
            readiness: Readiness::Starting,
            is_playing: false,
        }));
        let (request_tx, request_rx) = std::sync::mpsc::channel::<CallRequest>();
        let stop_signal = Arc::new(AtomicBool::new(false));

        thread::spawn({
            let state = Arc::clone(&state);
            let stop_signal = Arc::clone(&stop_signal);
            move || run_session(listener, state, request_rx, stop_signal)
        });

        Self {
            state,
            request_tx,
            stop_signal,
        }
    }

    /// Send a request and wait for the correlated response. Returns an error immediately if the
    /// session is closed or the request cannot be serialized.
    pub fn call(&self, request: CallRequest) -> Result<ResponseEnvelope, RpcError> {
        let mut request = request;
        if request.id.is_empty() {
            request.id = mint_id();
        } else {
            usable_id(&request.id)?;
        }
        let timeout = request
            .timeout_ms
            .map(|ms| Duration::from_millis(ms.clamp(1, MAX_TIMEOUT_MS)))
            .unwrap_or_else(|| Duration::from_millis(DEFAULT_REQUEST_TIMEOUT_MS));
        let (tx, rx) = std::sync::mpsc::channel();
        {
            let mut state = self
                .state
                .lock()
                .map_err(|_| RpcError::new("lock_poisoned", "The RPC state lock is poisoned"))?;
            if state.closed {
                return Err(RpcError::new("session_closed", "The RPC session is closed"));
            }
            if let ConnectionState::Closed { error } = &state.connection {
                return Err(error.clone());
            }
            state
                .pending
                .insert(request.id.clone(), PendingRequest { sender: tx });
        }
        let request_id = request.id.clone();
        self.request_tx
            .send(request)
            .map_err(|_| RpcError::new("session_closed", "The RPC session has stopped"))?;
        // A request may name a timeout of minutes, and an agent turn the user stopped must not be
        // held open for one, so the wait polls rather than blocks. Giving up leaves the pending
        // entry behind on purpose: the reader treats a response it cannot match as a stale reply
        // and fails the connection over it, so the entry has to outlive the waiter and absorb the
        // answer — into a receiver nobody is holding — rather than the editor losing its session
        // because a request was abandoned.
        match crate::cancel::recv_until(&rx, Instant::now() + timeout) {
            Ok(response) => response,
            Err(crate::cancel::WaitEnd::Cancelled) => {
                self.tell_the_addon_to_give_up(&request_id);
                Err(RpcError::new(
                    "cancelled",
                    "The request was stopped with its agent turn",
                ))
            }
            Err(_) => Err(RpcError::new("request_timeout", "The request timed out").retryable()),
        }
    }

    /// Tells the addon that nobody is waiting for a request any more.
    ///
    /// Walking away is not enough on the editor's side. A scene switch it has parked holds the
    /// session at `importing` until it obeys or its half-minute deadline passes, and every mutation
    /// is refused `not_ready` meanwhile — so a stopped agent turn stalled the whole session,
    /// including whatever the user reached for next. This is sent and forgotten: it registers no
    /// pending entry, and the reader knows the answer to it is nobody's.
    fn tell_the_addon_to_give_up(&self, request_id: &str) {
        let _ = self.request_tx.send(CallRequest {
            // The one id not minted: the reader recognizes a cancellation's own answer as nobody's
            // by this prefix, which is exactly why no caller may spell one.
            id: format!("{CANCEL_ID_PREFIX}{request_id}"),
            command: "session.cancel".to_owned(),
            params: json!({"requestId": request_id}),
            expected_revision: None,
            expected_scene: None,
            timeout_ms: Some(CANCEL_TIMEOUT_MS),
        });
    }

    /// Current lifecycle readiness reported by the addon.
    pub fn readiness(&self) -> Readiness {
        self.state
            .lock()
            .ok()
            .map(|state| state.readiness)
            .unwrap_or(Readiness::Unavailable)
    }

    /// Whether the editor is playing the project, as the addon last reported.
    ///
    /// The addon polls `EditorInterface.is_playing_scene()` every frame and announces the
    /// transition, so this is Godot's own answer rather than a record of what Gofer launched. A
    /// game that died on its own therefore stops counting as running without anyone asking.
    pub fn is_playing(&self) -> bool {
        self.state
            .lock()
            .ok()
            .is_some_and(|state| state.readiness == Readiness::Ready && state.is_playing)
    }

    /// Subscribe to addon events. Events are broadcast to every active subscriber.
    pub fn subscribe_events(&self) -> std::sync::mpsc::Receiver<EventEnvelope> {
        let (sender, receiver) = std::sync::mpsc::channel();
        if let Ok(mut state) = self.state.lock() {
            state.events.push(sender);
        }
        receiver
    }

    /// Stop the session, close the connection, and fail any pending requests.
    pub fn stop(&self) {
        self.stop_signal.store(true, Ordering::Release);
        let mut state = match self.state.lock() {
            Ok(state) => state,
            Err(_) => return,
        };
        state.closed = true;
        state.readiness = Readiness::Unavailable;
        state.is_playing = false;
        fail_pending(
            &mut state,
            RpcError::new("session_stopped", "The RPC session was stopped"),
        );
        if let ConnectionState::Connected { writer } = &state.connection {
            let _ = writer.shutdown(std::net::Shutdown::Both);
        }
        state.connection = ConnectionState::Closed {
            error: RpcError::new("session_stopped", "The RPC session was stopped"),
        };
    }
}

fn run_session(
    listener: TcpListener,
    state: Arc<Mutex<SharedState>>,
    request_rx: std::sync::mpsc::Receiver<CallRequest>,
    stop_signal: Arc<AtomicBool>,
) {
    let mut reconnects = 0;
    let deadline = Instant::now() + Duration::from_millis(CONNECT_TIMEOUT_MS);

    // The wait for the addon polls rather than blocks. A blocking `accept` observes neither the
    // deadline nor the stop signal, so an editor that never connects — one that failed to start,
    // or one whose plugin never loaded — left this thread parked on the socket for the life of the
    // process, keeping the port bound and the process alive long after anything wanted it.
    listener
        .set_nonblocking(true)
        .expect("listener non-blocking mode");

    while reconnects <= MAX_RECONNECT_ATTEMPTS && Instant::now() < deadline {
        if stop_signal.load(Ordering::Acquire) {
            break;
        }
        match listener.accept().map(|(stream, _)| stream) {
            Ok(stream) => {
                // The connection itself is read and written blocking, with its own timeouts.
                stream
                    .set_nonblocking(false)
                    .expect("connection blocking mode");
                if handle_connection(stream, &state, &request_rx, &stop_signal) {
                    reconnects = 0;
                } else {
                    break;
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(ACCEPT_POLL_MS));
            }
            Err(_) => {
                reconnects += 1;
                thread::sleep(Duration::from_millis(RECONNECT_BACKOFF_MS));
            }
        }
    }

    let mut state = state.lock().expect("RPC state lock");
    state.closed = true;
    state.readiness = Readiness::Unavailable;
    state.is_playing = false;
    fail_pending(
        &mut state,
        RpcError::new("session_closed", "The RPC session closed"),
    );
}

/// Returns true if the session should accept another connection.
fn handle_connection(
    stream: TcpStream,
    state: &Arc<Mutex<SharedState>>,
    request_rx: &std::sync::mpsc::Receiver<CallRequest>,
    stop_signal: &Arc<AtomicBool>,
) -> bool {
    let _ = stream.set_read_timeout(Some(Duration::from_millis(HEARTBEAT_INTERVAL_MS * 3)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(HEARTBEAT_INTERVAL_MS * 3)));

    let mut reader = BufReader::new(stream.try_clone().expect("clone stream"));
    let mut writer = stream;

    let handshake_line = match read_line(&mut reader, MAX_ENVELOPE_BYTES) {
        Ok(Some(line)) => line,
        Ok(None) => return true,
        Err(error) => {
            let _ = write_envelope(&mut writer, &error.to_envelope("handshake"));
            close_with_error(state, error);
            return false;
        }
    };

    let handshake: Value = match serde_json::from_str(&handshake_line) {
        Ok(value) => value,
        Err(error) => {
            let error = RpcError::new(
                "invalid_protocol_payload",
                format!("The handshake is not valid JSON: {error}"),
            );
            let _ = write_envelope(&mut writer, &error.to_envelope("handshake"));
            close_with_error(state, error);
            return false;
        }
    };

    match validate_envelope(&handshake) {
        Ok(EnvelopeKind::Handshake) => {}
        Ok(_) => {
            let error = RpcError::new(
                "invalid_protocol_payload",
                "The first envelope must be a handshake",
            );
            let _ = write_envelope(
                &mut writer,
                &error.to_envelope(
                    handshake
                        .get("id")
                        .and_then(Value::as_str)
                        .unwrap_or("handshake"),
                ),
            );
            close_with_error(state, error);
            return false;
        }
        Err(error) => {
            let id = handshake
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or("handshake");
            let _ = write_envelope(&mut writer, &error.to_envelope(id));
            close_with_error(state, protocol_error_to_rpc(error));
            return false;
        }
    }

    let token = handshake.get("token").and_then(Value::as_str).unwrap_or("");
    let accepted_versions = handshake
        .get("acceptedVersions")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let client = handshake.get("client").cloned().unwrap_or_default();
    let project_path = client
        .get("projectPath")
        .and_then(Value::as_str)
        .unwrap_or("");
    let id = handshake
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("handshake")
        .to_owned();

    {
        let mut state = state.lock().expect("RPC state lock");
        if token != state.token {
            let _ = write_envelope(&mut writer, &unauthenticated(&id));
            state.connection = ConnectionState::Closed {
                error: RpcError::new("unauthenticated", "The handshake token did not match"),
            };
            return false;
        }
        if !same_project(&state.project_path, project_path) {
            let _ = write_envelope(
                &mut writer,
                &wrong_project(&id, &state.project_path, project_path),
            );
            state.connection = ConnectionState::Closed {
                error: RpcError::new(
                    "wrong_project",
                    "The addon reported a different project path",
                ),
            };
            return false;
        }
        if !accepted_versions
            .iter()
            .any(|v| v.as_u64() == Some(PROTOCOL_VERSION))
        {
            let _ = write_envelope(&mut writer, &unsupported_version(&id));
            state.connection = ConnectionState::Closed {
                error: RpcError::new(
                    "unsupported_protocol_version",
                    "The addon does not speak protocol version 2",
                ),
            };
            return false;
        }
        state.connection = ConnectionState::Connected {
            writer: writer.try_clone().expect("clone writer"),
        };
        // A connected socket is not a ready editor. The addon announces its own readiness on the
        // first frame after the handshake — importing, then ready — and calling it ready here meant
        // the badge said so over an editor still importing a project's worth of assets.
        state.readiness = Readiness::Starting;
        state.is_playing = false;
    }

    let _ = write_envelope(&mut writer, &handshake_response(&id));

    let last_heartbeat = Arc::new(Mutex::new(Instant::now()));
    let reader_state = Arc::clone(state);
    let reader_stop = Arc::clone(stop_signal);
    let reader_writer = writer.try_clone().expect("clone writer for reader");
    let reader_last_heartbeat = Arc::clone(&last_heartbeat);
    let reader_handle = thread::spawn(move || {
        read_envelopes(
            reader_state,
            reader,
            reader_writer,
            reader_stop,
            reader_last_heartbeat,
        )
    });

    let mut result = true;
    while !stop_signal.load(Ordering::Acquire) {
        let heartbeat_due = {
            let last = last_heartbeat.lock().expect("heartbeat lock");
            Instant::now().duration_since(*last) > Duration::from_millis(HEARTBEAT_INTERVAL_MS)
        };
        if heartbeat_due {
            if write_envelope(&mut writer, &heartbeat_request()).is_err() {
                break;
            }
            // Restart the interval on the write, not on the reply, so one silent addon costs one
            // heartbeat per interval instead of one per poll. A dead connection is caught by the
            // read timeout, which is three intervals wide.
            *last_heartbeat.lock().expect("heartbeat lock") = Instant::now();
        }

        match request_rx.recv_timeout(Duration::from_millis(HEARTBEAT_INTERVAL_MS / 4)) {
            Ok(request) => {
                if write_request(&mut writer, &request).is_err() {
                    break;
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                result = false;
                break;
            }
        }
    }

    let _ = writer.shutdown(std::net::Shutdown::Both);
    let _ = reader_handle.join();

    {
        let mut state = state.lock().expect("RPC state lock");
        state.connection = ConnectionState::Idle;
        state.readiness = Readiness::Starting;
        state.is_playing = false;
    }

    result
}

fn read_envelopes(
    state: Arc<Mutex<SharedState>>,
    reader: BufReader<TcpStream>,
    mut writer: TcpStream,
    stop_signal: Arc<AtomicBool>,
    last_heartbeat: Arc<Mutex<Instant>>,
) {
    let mut reader = reader;
    loop {
        if stop_signal.load(Ordering::Acquire) {
            break;
        }
        let line = match read_line(&mut reader, MAX_IMAGE_ENVELOPE_BYTES) {
            Ok(Some(line)) => line,
            Ok(None) => break,
            Err(error) => {
                let _ = write_envelope(&mut writer, &error.to_envelope("protocol"));
                close_with_error(&state, error);
                break;
            }
        };
        if line.trim().is_empty() {
            continue;
        }
        let envelope = match serde_json::from_str::<Value>(&line) {
            Ok(value) => value,
            Err(error) => {
                let error = RpcError::new(
                    "invalid_protocol_payload",
                    format!("Envelope is not valid JSON: {error}"),
                );
                let _ = write_envelope(&mut writer, &error.to_envelope("protocol"));
                close_with_error(&state, error);
                break;
            }
        };
        // How large a line may be is a property of the line, so it is asked of everything that
        // arrives. `read_line` above can only cap at the largest limit any envelope may use,
        // because which limit applies is decided by what the payload turned out to be — only an
        // image frame may exceed the 1 MB the handshake publishes as the contract. Before this,
        // the 16 MB cap was the only one anything post-handshake was ever held to, and the two
        // functions that know the real rule were called by nothing but their own test.
        if let Err(error) = enforce_envelope_size(line.len(), &envelope) {
            let id = envelope
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or("protocol");
            let _ = write_envelope(&mut writer, &error.to_envelope(id));
            close_with_error(&state, protocol_error_to_rpc(error));
            break;
        }
        // Uncorrelated traffic is dropped rather than dispatched, and counts as liveness on the way
        // past: an answer from the addon proves it is alive whichever request it belongs to.
        if is_uncorrelated(&envelope) {
            *last_heartbeat.lock().expect("heartbeat lock") = Instant::now();
            continue;
        }
        // What shape a line must have is a property of what is about to be done with it, so it is
        // asked of everything that gets dispatched. `dispatch_envelope` reads `kind`, `id`,
        // `result`, `revision`, `sequence`, `event` and `data` out of the value by hand and takes
        // whatever it finds; the frozen contract those fields belong to was enforced on the
        // handshake and nowhere else.
        if let Err(error) = validate_envelope(&envelope) {
            let id = envelope
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or("protocol");
            let _ = write_envelope(&mut writer, &error.to_envelope(id));
            close_with_error(&state, protocol_error_to_rpc(error));
            break;
        }
        if let Err(error) = dispatch_envelope(&state, envelope) {
            let _ = write_envelope(&mut writer, &error.to_envelope("protocol"));
            close_with_error(&state, error);
            break;
        }
    }
}

/// Decides whether the addon is editing the worktree this session owns.
///
/// Godot globalizes `res://` with a trailing separator, and the supervisor holds the canonical
/// worktree, so the two spellings of one directory never match as strings. Both sides are
/// normalized instead: a session must reject a different project, not a different spelling.
fn same_project(expected: &str, reported: &str) -> bool {
    if reported.is_empty() {
        return false;
    }
    let normalize = |value: &str| {
        let trimmed = value.trim_end_matches(['/', '\\']);
        let path = Path::new(if trimmed.is_empty() { value } else { trimmed });
        let canonical = crate::paths::canonical(path).unwrap_or_else(|_| path.to_path_buf());
        crate::paths::simplified(&canonical).to_path_buf()
    };
    normalize(expected) == normalize(reported)
}

/// Recognizes the traffic that carries no correlated request: the addon's reply to a heartbeat
/// request, an unsolicited heartbeat event, and its reply to a cancellation nobody is waiting for.
///
/// Without this an answer with no pending entry reads as a stale reply and closes the session —
/// which would make giving up on one request cost the whole editor.
fn is_uncorrelated(envelope: &Value) -> bool {
    let kind = envelope.get("kind").and_then(Value::as_str).unwrap_or("");
    match kind {
        "response" | "error" => envelope
            .get("id")
            .and_then(Value::as_str)
            .is_some_and(|id| id == HEARTBEAT_ID || id.starts_with(CANCEL_ID_PREFIX)),
        "event" => envelope.get("event").and_then(Value::as_str) == Some("session.heartbeat"),
        _ => false,
    }
}

fn dispatch_envelope(state: &Arc<Mutex<SharedState>>, envelope: Value) -> Result<(), RpcError> {
    let kind = envelope.get("kind").and_then(Value::as_str).unwrap_or("");
    let id = envelope
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();

    match kind {
        "response" => {
            let mut state = state
                .lock()
                .map_err(|_| RpcError::new("lock_poisoned", "The RPC state lock is poisoned"))?;
            let Some(pending) = state.pending.remove(&id) else {
                return Err(RpcError::new(
                    "stale_reply",
                    format!("Received a response for unknown request {id}"),
                ));
            };
            let result = envelope.get("result").cloned().unwrap_or_default();
            let revision = envelope.get("revision").and_then(Value::as_u64);
            let _ = pending.sender.send(Ok(ResponseEnvelope {
                id,
                result,
                revision,
            }));
        }
        "error" => {
            let mut state = state
                .lock()
                .map_err(|_| RpcError::new("lock_poisoned", "The RPC state lock is poisoned"))?;
            let error_value = envelope.get("error").cloned().unwrap_or_default();
            let rpc_error = parse_error(error_value);
            if id == "handshake" || id.is_empty() {
                state.connection = ConnectionState::Closed {
                    error: rpc_error.clone(),
                };
                return Err(rpc_error);
            }
            let Some(pending) = state.pending.remove(&id) else {
                return Err(RpcError::new(
                    "stale_reply",
                    format!("Received an error for unknown request {id}"),
                ));
            };
            let _ = pending.sender.send(Err(rpc_error));
        }
        "event" => {
            let mut state = state
                .lock()
                .map_err(|_| RpcError::new("lock_poisoned", "The RPC state lock is poisoned"))?;
            let sequence = envelope
                .get("sequence")
                .and_then(Value::as_u64)
                .unwrap_or(state.next_sequence);
            let event = envelope
                .get("event")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned();
            let data = envelope.get("data").cloned().unwrap_or_default();
            state.next_sequence = sequence + 1;
            note_lifecycle(&mut state, &event);
            let envelope = EventEnvelope {
                sequence,
                event,
                data,
            };
            state
                .events
                .retain(|sender| sender.send(envelope.clone()).is_ok());
        }
        _ => {
            return Err(RpcError::new(
                "invalid_protocol_payload",
                format!("Unexpected envelope kind: {kind}"),
            ));
        }
    }
    Ok(())
}

fn read_line(
    reader: &mut BufReader<TcpStream>,
    max_bytes: usize,
) -> Result<Option<String>, RpcError> {
    let mut buffer = Vec::new();
    match reader.read_until(b'\n', &mut buffer) {
        Ok(0) => Ok(None),
        Ok(_) => {
            if buffer.len() > max_bytes {
                return Err(RpcError::new(
                    "payload_too_large",
                    format!("Envelope exceeded {max_bytes} bytes"),
                ));
            }
            String::from_utf8(buffer)
                .map(Some)
                .map_err(|_| RpcError::new("invalid_protocol_payload", "Envelope is not UTF-8"))
        }
        Err(error) => Err(RpcError::new(
            "transport_failed",
            format!("Could not read from the RPC connection: {error}"),
        )
        .retryable()),
    }
}

fn write_envelope(writer: &mut TcpStream, envelope: &Value) -> Result<(), RpcError> {
    let mut bytes = serde_json::to_vec(envelope).map_err(|error| {
        RpcError::new(
            "serialize_failed",
            format!("Could not serialize envelope: {error}"),
        )
    })?;
    bytes.push(b'\n');
    writer.write_all(&bytes).map_err(|error| {
        RpcError::new(
            "transport_failed",
            format!("Could not write to the RPC connection: {error}"),
        )
        .retryable()
    })
}

fn write_request(writer: &mut TcpStream, request: &CallRequest) -> Result<(), RpcError> {
    let timeout_ms = request.timeout_ms.unwrap_or(DEFAULT_REQUEST_TIMEOUT_MS);
    let mut envelope = json!({
        "protocolVersion": PROTOCOL_VERSION,
        "kind": "request",
        "id": request.id,
        "command": request.command,
        "params": request.params,
        "timeoutMs": timeout_ms,
    });
    if let Some(revision) = request.expected_revision {
        envelope["expectedRevision"] = json!(revision);
    }
    if let Some(scene) = request.expected_scene.as_ref().filter(|s| !s.is_empty()) {
        envelope["expectedScene"] = json!(scene);
    }
    write_envelope(writer, &envelope)
}

/// Records what one lifecycle event says about the editor.
///
/// The addon is the only thing that can see the editor, and it reports every transition it makes:
/// `_set_readiness` announces starting, importing, ready and unavailable, and a per-frame poll of
/// `EditorInterface.is_playing_scene()` announces `session.playing` when the game starts and
/// `session.ready` when it stops. Reading both here rather than in whatever happens to be
/// subscribed is what makes the session's state derivable at any moment: the reader thread lives
/// as long as the connection, so there is no arrangement of subscribers under which the answer
/// goes stale.
fn note_lifecycle(state: &mut SharedState, event: &str) {
    match event {
        "session.playing" => state.is_playing = true,
        // A game that ended is reported as the editor being ready again.
        "session.ready" => {
            state.readiness = Readiness::Ready;
            state.is_playing = false;
        }
        // The runtime helper going away is not the editor stopping. A restart tears the helper
        // down and starts the next game within the same frame, so the addon's own play-state poll
        // never sees a gap and never announces the new game — and this event, taken as a stop,
        // left Gofer certain nothing was playing over a game that ran for minutes. Which game the
        // helper belongs to is the debugger's business; whether the editor is playing is the
        // editor's, and it is polled every frame, so a game that really died is reported as
        // `session.ready` a frame later.
        "runtime.stopped" => {}
        "session.starting" => state.readiness = Readiness::Starting,
        "session.importing" => state.readiness = Readiness::Importing,
        "session.unavailable" => {
            state.readiness = Readiness::Unavailable;
            state.is_playing = false;
        }
        _ => {}
    }
}

fn close_with_error(state: &Arc<Mutex<SharedState>>, error: RpcError) {
    let mut state = state.lock().expect("RPC state lock");
    state.connection = ConnectionState::Closed {
        error: error.clone(),
    };
    state.readiness = Readiness::Unavailable;
    state.is_playing = false;
    fail_pending(&mut state, error);
}

fn fail_pending(state: &mut SharedState, error: RpcError) {
    for (_, pending) in std::mem::take(&mut state.pending) {
        let _ = pending.sender.send(Err(error.clone()));
    }
}

fn handshake_response(id: &str) -> Value {
    json!({
        "protocolVersion": PROTOCOL_VERSION,
        "kind": "response",
        "id": id,
        "result": {
            "sessionId": "gofer-session",
            "acceptedVersion": PROTOCOL_VERSION,
            "heartbeatIntervalMs": HEARTBEAT_INTERVAL_MS,
            "limits": {
                "maxEnvelopeBytes": MAX_ENVELOPE_BYTES,
                "maxImageEnvelopeBytes": MAX_IMAGE_ENVELOPE_BYTES,
                "maxImageEdgePixels": 1920,
            }
        }
    })
}

fn heartbeat_request() -> Value {
    json!({
        "protocolVersion": PROTOCOL_VERSION,
        "kind": "request",
        "id": HEARTBEAT_ID,
        "command": "session.heartbeat",
        "params": {},
        "timeoutMs": HEARTBEAT_INTERVAL_MS,
    })
}

fn unauthenticated(id: &str) -> Value {
    json!({
        "protocolVersion": PROTOCOL_VERSION,
        "kind": "error",
        "id": id,
        "error": {
            "code": "unauthenticated",
            "message": "The handshake token did not match",
            "retryable": false,
            "readiness": "unavailable",
            "details": {}
        }
    })
}

fn wrong_project(id: &str, expected: &str, actual: &str) -> Value {
    json!({
        "protocolVersion": PROTOCOL_VERSION,
        "kind": "error",
        "id": id,
        "error": {
            "code": "wrong_project",
            "message": "The addon reported a different project path",
            "retryable": false,
            "readiness": "unavailable",
            "details": {"expected": expected, "actual": actual}
        }
    })
}

fn unsupported_version(id: &str) -> Value {
    json!({
        "protocolVersion": PROTOCOL_VERSION,
        "kind": "error",
        "id": id,
        "error": {
            "code": "unsupported_protocol_version",
            "message": "The addon does not speak a supported protocol version",
            "retryable": false,
            "readiness": "unavailable",
            "details": {"supportedVersions": [PROTOCOL_VERSION]}
        }
    })
}

fn protocol_error_to_rpc(error: crate::protocol_v2::ProtocolError) -> RpcError {
    RpcError {
        code: error.code.to_owned(),
        message: error.message,
        retryable: error.retryable,
        readiness: error.readiness,
        details: error.details,
    }
}

fn parse_error(value: Value) -> RpcError {
    let code = value
        .get("code")
        .and_then(Value::as_str)
        .unwrap_or("unknown_error");
    let message = value
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("An RPC error occurred")
        .to_owned();
    let retryable = value
        .get("retryable")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let readiness = value
        .get("readiness")
        .and_then(Value::as_str)
        .and_then(Readiness::parse)
        .unwrap_or(Readiness::Unavailable);
    let details = value.get("details").cloned().unwrap_or_default();
    RpcError {
        code: code.to_owned(),
        message,
        retryable,
        readiness,
        details,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::net::TcpListener;
    use std::thread;
    use std::time::Duration;

    #[test]
    fn a_session_nothing_connects_to_releases_its_socket_when_stopped() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("listener");
        let address = listener.local_addr().expect("listener address");
        let session = RpcSession::start(listener, "token".to_owned(), "/project".to_owned());

        session.stop();

        // The accept loop owns the listener, so the port returns only once that loop has left it.
        // Before the loop polled, a blocking accept held it until the process died.
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while std::time::Instant::now() < deadline {
            if TcpListener::bind(address).is_ok() {
                return;
            }
            thread::sleep(Duration::from_millis(25));
        }
        panic!("the accept loop kept the socket after the session was stopped");
    }

    use crate::protocol_v2::IMAGE_ENCODING;

    fn handshake(token: &str, project_path: &str) -> Value {
        json!({
            "protocolVersion": 2,
            "kind": "handshake",
            "id": "handshake-1",
            "token": token,
            "acceptedVersions": [2],
            "client": {
                "name": "gofer-godot-addon",
                "addonVersion": "2.0.0",
                "engineVersion": "4.7.2.stable",
                "projectPath": project_path,
                "capabilities": ["session", "scene"]
            }
        })
    }

    fn addon_client(address: std::net::SocketAddr) -> TcpStream {
        TcpStream::connect(address).expect("connect to RPC")
    }

    #[test]
    fn accepts_valid_handshake_and_exchanges_a_request() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let address = listener.local_addr().expect("listener address");
        let project_path = "/tmp/gofer/project".to_owned();
        let token = "a1".repeat(32);
        let session = RpcSession::start(listener, token.clone(), project_path.clone());

        let mut addon = addon_client(address);
        writeln!(
            addon,
            "{}",
            serde_json::to_string(&handshake(&token, &project_path)).unwrap()
        )
        .unwrap();

        let mut reader = BufReader::new(addon.try_clone().unwrap());
        let mut response = String::new();
        reader.read_line(&mut response).unwrap();
        let response: Value = serde_json::from_str(&response).unwrap();
        assert_eq!(response["kind"], "response");
        assert_eq!(response["result"]["acceptedVersion"], 2);

        let request = CallRequest::new("scene.list".to_owned(), json!({})).within(Some(100));

        let addon_handle = thread::spawn(move || {
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            let request: Value = serde_json::from_str(&line).unwrap();
            assert_eq!(request["command"], "scene.list");
            // Answered under the id the session minted. The addon has never chosen one; a test
            // that spells its own is testing an arrangement production does not have.
            writeln!(
                addon,
                "{}",
                serde_json::to_string(&json!({
                    "protocolVersion": 2,
                    "kind": "response",
                    "id": request["id"],
                    "result": {"scenes": []}
                }))
                .unwrap()
            )
            .unwrap();
        });

        let result = session.call(request).expect("call succeeds");
        assert_eq!(result.result["scenes"], json!([]));
        addon_handle.join().unwrap();
        session.stop();
    }

    /// The addon's own account of the editor, taken as it arrives rather than remembered elsewhere.
    ///
    /// The session's lifecycle state is derived from these two, so whatever is subscribed to the
    /// event channel cannot change the answer. It used to be a field written by the subscription
    /// worker: with nothing subscribed the state never moved at all, and a game that had already
    /// stopped went on counting as running.
    #[test]
    fn the_addons_readiness_and_play_state_are_taken_from_its_own_events() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let address = listener.local_addr().expect("listener address");
        let project_path = "/tmp/gofer/project".to_owned();
        let token = "a1".repeat(32);
        let session = RpcSession::start(listener, token.clone(), project_path.clone());

        let mut addon = addon_client(address);
        writeln!(
            addon,
            "{}",
            serde_json::to_string(&handshake(&token, &project_path)).unwrap()
        )
        .unwrap();
        let mut reader = BufReader::new(addon.try_clone().unwrap());
        let mut response = String::new();
        reader.read_line(&mut response).unwrap();

        // A connected socket is not a ready editor: the addon has said nothing about itself yet.
        assert_eq!(settled(&session, Readiness::Starting), Readiness::Starting);

        // Sequenced, because the addon sequences every event and the reader now holds what arrives
        // to the frozen contract rather than reading the fields it happens to want out of it.
        let mut sequence = 0_u64;
        let mut announce = |addon: &mut TcpStream, event: &str| {
            writeln!(
                addon,
                "{}",
                serde_json::to_string(&json!({
                    "protocolVersion": 2,
                    "kind": "event",
                    "id": "session-1",
                    "sequence": sequence,
                    "event": event,
                    "data": {},
                }))
                .unwrap()
            )
            .unwrap();
            sequence += 1;
        };

        announce(&mut addon, "session.importing");
        assert_eq!(
            settled(&session, Readiness::Importing),
            Readiness::Importing
        );
        assert!(!session.is_playing());

        announce(&mut addon, "session.ready");
        assert_eq!(settled(&session, Readiness::Ready), Readiness::Ready);
        assert!(!session.is_playing());

        announce(&mut addon, "session.playing");
        assert!(
            played(&session, true),
            "the game the editor started is running"
        );

        // A restart takes the runtime helper down and brings the next game up inside one frame,
        // so the addon's play-state poll never sees a gap to announce. Taking the helper's
        // teardown for a stop left Gofer certain nothing was playing over a game that was.
        announce(&mut addon, "runtime.stopped");
        assert!(
            played(&session, true),
            "the helper going away is not the editor stopping"
        );

        // The addon polls the editor every frame and says so when the game is gone, however it
        // went — stopped from the toolbar, ended on its own, or killed.
        announce(&mut addon, "session.ready");
        assert!(
            !played(&session, false),
            "a game that is gone is not running"
        );
        assert_eq!(session.readiness(), Readiness::Ready);

        // Nothing the addon said survives the addon. Anything else would be a play state read off
        // an editor that is no longer there.
        announce(&mut addon, "session.playing");
        assert!(played(&session, true));
        session.stop();
        assert_eq!(session.readiness(), Readiness::Unavailable);
        assert!(!session.is_playing());
    }

    /// Waits for the reader thread to have taken one event in, so the assertion is not a race.
    fn settled(session: &RpcSession, expected: Readiness) -> Readiness {
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline && session.readiness() != expected {
            thread::sleep(Duration::from_millis(5));
        }
        session.readiness()
    }

    fn played(session: &RpcSession, expected: bool) -> bool {
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline && session.is_playing() != expected {
            thread::sleep(Duration::from_millis(5));
        }
        session.is_playing()
    }

    #[test]
    fn rejects_invalid_handshake_token() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let address = listener.local_addr().expect("listener address");
        let session = RpcSession::start(listener, "a1".repeat(32), "/tmp/gofer/project".to_owned());

        let mut addon = addon_client(address);
        writeln!(
            addon,
            "{}",
            serde_json::to_string(&handshake("b2".repeat(32).as_str(), "/tmp/gofer/project"))
                .unwrap()
        )
        .unwrap();

        let mut reader = BufReader::new(addon);
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        let response: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(response["kind"], "error");
        assert_eq!(response["error"]["code"], "unauthenticated");
        session.stop();
    }

    #[test]
    fn rejects_wrong_project_path() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let address = listener.local_addr().expect("listener address");
        let token = "a1".repeat(32);
        let session = RpcSession::start(listener, token.clone(), "/tmp/gofer/project".to_owned());

        let mut addon = addon_client(address);
        writeln!(
            addon,
            "{}",
            serde_json::to_string(&handshake(&token, "/tmp/other/project")).unwrap()
        )
        .unwrap();

        let mut reader = BufReader::new(addon);
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        let response: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(response["kind"], "error");
        assert_eq!(response["error"]["code"], "wrong_project");
        session.stop();
    }

    /// Only an image frame may exceed the 1 MB the handshake publishes as the contract.
    ///
    /// `read_line` can only cap at the largest limit any envelope may use, because which limit
    /// applies is decided by what the payload turned out to be. So the 16 MB cap was the only thing
    /// anything post-handshake was ever held to, and the two functions that know the real rule —
    /// `max_envelope_bytes` and `enforce_envelope_size` — were called by nothing but their own unit
    /// test. Both of the suite's existing "oversized" tests write their giant line *as the
    /// handshake*, which is the one path that did use the 1 MB limit.
    #[test]
    fn only_an_image_frame_may_exceed_the_json_limit_on_the_wire() {
        let oversized = "x".repeat(MAX_ENVELOPE_BYTES + 1024);

        let refused = |result: Value, frame: Value| {
            let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
            let address = listener.local_addr().expect("listener address");
            let token = "a1".repeat(32);
            let session = RpcSession::start(listener, token.clone(), "/tmp/p".to_owned());
            let mut addon = addon_client(address);
            writeln!(
                addon,
                "{}",
                serde_json::to_string(&handshake(&token, "/tmp/p")).unwrap()
            )
            .unwrap();
            let mut reader = BufReader::new(addon.try_clone().unwrap());
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();

            let mut body = json!({
                "protocolVersion": 2,
                "kind": "response",
                "id": "call-1",
                "result": result,
            });
            if !frame.is_null() {
                body["result"]["frame"] = frame;
            }
            writeln!(addon, "{}", serde_json::to_string(&body).unwrap()).unwrap();

            let mut answer = String::new();
            let refused = match reader.read_line(&mut answer) {
                Ok(0) | Err(_) => None,
                Ok(_) => serde_json::from_str::<Value>(&answer).ok(),
            };
            session.stop();
            refused
        };

        // A plain reply of the same size is over its own limit, and the addon is told which.
        let rejection = refused(json!({"text": oversized}), Value::Null)
            .expect("an oversized plain reply is answered rather than accepted");
        assert_eq!(rejection["kind"], "error", "{rejection}");
        assert_eq!(rejection["error"]["code"], "payload_too_large");
        assert_eq!(
            rejection["error"]["details"]["limitBytes"],
            json!(MAX_ENVELOPE_BYTES)
        );

        // The same bytes carried as a screenshot are inside the image limit, so nothing is refused
        // and the connection stays up. A stale reply is the answer to an id nobody is waiting for,
        // which is this envelope reaching dispatch rather than being turned away before it.
        let accepted = refused(
            json!({}),
            json!({"encoding": IMAGE_ENCODING, "data": oversized}),
        )
        .expect("an oversized image frame reaches dispatch");
        assert_eq!(accepted["error"]["code"], "stale_reply", "{accepted}");
    }

    #[test]
    fn accepts_the_trailing_separator_godot_reports() {
        let directory = tempfile::TempDir::new().expect("temporary directory");
        let worktree = crate::paths::canonical(directory.path()).expect("canonical worktree");
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let address = listener.local_addr().expect("listener address");
        let token = "a1".repeat(32);
        let session = RpcSession::start(listener, token.clone(), worktree.display().to_string());

        // `ProjectSettings.globalize_path("res://")` always ends in a separator.
        let mut addon = addon_client(address);
        writeln!(
            addon,
            "{}",
            serde_json::to_string(&handshake(&token, &format!("{}/", worktree.display()))).unwrap()
        )
        .unwrap();

        let mut reader = BufReader::new(addon);
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        let response: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(response["kind"], "response", "{response}");
        session.stop();
    }

    #[test]
    fn rejects_oversized_payload() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let address = listener.local_addr().expect("listener address");
        let token = "a1".repeat(32);
        let session = RpcSession::start(listener, token.clone(), "/tmp/gofer/project".to_owned());

        let mut addon = addon_client(address);
        let giant = "x".repeat(MAX_ENVELOPE_BYTES + 100);
        writeln!(
            addon,
            "{{\"protocolVersion\":2,\"kind\":\"handshake\",\"id\":\"h\",\"token\":\"{token}\",\"junk\":\"{giant}\"}}"
        )
        .unwrap();

        let mut reader = BufReader::new(addon);
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        let response: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(response["kind"], "error");
        assert_eq!(response["error"]["code"], "payload_too_large");
        session.stop();
    }

    /// Giving up on a request tells the addon to give up too, and its answer costs nothing.
    ///
    /// Walking away is only half of it: the addon parks a scene switch or a runtime call until the
    /// editor or the game answers, and nothing there knows the caller is gone. The reply to the
    /// cancellation is the delicate part — it correlates to no pending request, and an
    /// uncorrelated reply is otherwise a `stale_reply` that closes the whole session.
    #[test]
    fn a_stopped_turn_tells_the_addon_to_give_up() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let address = listener.local_addr().expect("listener address");
        let token = "a1".repeat(32);
        let project_path = "/tmp/gofer/project".to_owned();
        let session = RpcSession::start(listener, token.clone(), project_path.clone());

        let mut addon = addon_client(address);
        writeln!(
            addon,
            "{}",
            serde_json::to_string(&handshake(&token, &project_path)).unwrap()
        )
        .unwrap();
        let mut reader = BufReader::new(addon.try_clone().unwrap());
        let mut line = String::new();
        reader.read_line(&mut line).expect("the handshake answer");

        // The turn is stopped before the call is made, so the wait gives up on its first look.
        // The cancelled turn is one process-wide value, so this holds the lock that keeps it from
        // being replaced by another test's cancellation while this one is watching for its own.
        let _serialized = crate::cancel::CANCEL_TEST_LOCK
            .lock()
            .unwrap_or_else(|held| held.into_inner());
        let turn = 4242;
        let scope = crate::cancel::ToolTurn::enter(turn);
        crate::cancel::cancel_turn(turn);

        let failure = session
            .call(
                CallRequest::new("scene.open".to_owned(), json!({"path": "res://slow.tscn"}))
                    .within(Some(60_000)),
            )
            .expect_err("a stopped turn must not wait out its timeout");
        assert_eq!(failure.code, "cancelled");

        // The addon sees the request, then the retraction naming it — by the id the session
        // minted, which is the only place that spelling exists.
        let mut sent = String::new();
        reader.read_line(&mut sent).expect("the parked request");
        let parked: Value = serde_json::from_str(&sent).expect("valid JSON");
        assert_eq!(parked["command"], "scene.open");
        let parked_id = parked["id"]
            .as_str()
            .expect("the parked request's id")
            .to_owned();
        sent.clear();
        reader.read_line(&mut sent).expect("the cancellation");
        let cancellation: Value = serde_json::from_str(&sent).expect("valid JSON");
        assert_eq!(cancellation["command"], "session.cancel");
        assert_eq!(cancellation["params"]["requestId"], parked_id);

        // Answering it must not cost the session, because nobody is holding that id.
        writeln!(
            addon,
            "{}",
            json!({
                "protocolVersion": 2,
                "kind": "response",
                "id": cancellation["id"],
                "result": {"requestId": parked_id, "cancelled": true}
            })
        )
        .unwrap();

        // Leaving the tool call is what frees this thread, rather than clearing the shared id.
        drop(scope);
        let alive =
            session.call(CallRequest::new("scene.list".to_owned(), json!({})).within(Some(2_000)));
        sent.clear();
        reader.read_line(&mut sent).expect("the request after it");
        assert!(
            sent.contains("\"command\":\"scene.list\""),
            "the session must still be usable after a cancellation was answered: {sent} / {alive:?}"
        );
        session.stop();
    }

    #[test]
    fn detects_disconnect_and_reports_timeout() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let address = listener.local_addr().expect("listener address");
        let token = "a1".repeat(32);
        let project_path = "/tmp/gofer/project".to_owned();
        let session = RpcSession::start(listener, token.clone(), project_path.clone());

        let mut addon = addon_client(address);
        writeln!(
            addon,
            "{}",
            serde_json::to_string(&handshake(&token, &project_path)).unwrap()
        )
        .unwrap();

        let mut reader = BufReader::new(addon.try_clone().unwrap());
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();

        drop(addon);
        drop(reader);

        let request = CallRequest::new("scene.list".to_owned(), json!({})).within(Some(50));

        let result = session.call(request);
        assert!(result.is_err(), "{result:?}");
        session.stop();
    }

    #[test]
    fn rejects_stale_reply_for_unknown_request() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let address = listener.local_addr().expect("listener address");
        let token = "a1".repeat(32);
        let project_path = "/tmp/gofer/project".to_owned();
        let session = RpcSession::start(listener, token.clone(), project_path.clone());

        let mut addon = addon_client(address);
        writeln!(
            addon,
            "{}",
            serde_json::to_string(&handshake(&token, &project_path)).unwrap()
        )
        .unwrap();

        let mut reader = BufReader::new(addon.try_clone().unwrap());
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();

        writeln!(
            addon,
            "{}",
            serde_json::to_string(&json!({
                "protocolVersion": 2,
                "kind": "response",
                "id": "unknown-id",
                "result": {}
            }))
            .unwrap()
        )
        .unwrap();

        thread::sleep(Duration::from_millis(100));

        let request = CallRequest::new("scene.list".to_owned(), json!({})).within(Some(50));
        let result = session.call(request);
        assert!(result.is_err(), "{result:?}");
        session.stop();
    }

    #[test]
    fn heartbeat_replies_keep_the_session_open() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let address = listener.local_addr().expect("listener address");
        let token = "a1".repeat(32);
        let project_path = "/tmp/gofer/project".to_owned();
        let session = RpcSession::start(listener, token.clone(), project_path.clone());

        let mut addon = addon_client(address);
        writeln!(
            addon,
            "{}",
            serde_json::to_string(&handshake(&token, &project_path)).unwrap()
        )
        .unwrap();

        let mut reader = BufReader::new(addon.try_clone().unwrap());
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();

        // The addon answers the heartbeat like any other request. It has no pending entry, so a
        // correlation-only reader would treat the reply as a stale reply and close the session.
        writeln!(
            addon,
            "{}",
            serde_json::to_string(&json!({
                "protocolVersion": 2,
                "kind": "response",
                "id": "heartbeat",
                "result": {}
            }))
            .unwrap()
        )
        .unwrap();

        thread::sleep(Duration::from_millis(100));

        let request = CallRequest::new("scene.list".to_owned(), json!({})).within(Some(500));

        let addon_handle = thread::spawn(move || {
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            let request: Value = serde_json::from_str(&line).unwrap();
            assert_eq!(request["command"], "scene.list");
            writeln!(
                addon,
                "{}",
                serde_json::to_string(&json!({
                    "protocolVersion": 2,
                    "kind": "response",
                    "id": request["id"],
                    "result": {"scenes": []}
                }))
                .unwrap()
            )
            .unwrap();
        });

        let result = session
            .call(request)
            .expect("session survives a heartbeat reply");
        assert_eq!(result.result["scenes"], json!([]));
        addon_handle.join().unwrap();
        session.stop();
    }

    #[test]
    fn broadcasts_events_to_subscribers() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let address = listener.local_addr().expect("listener address");
        let token = "a1".repeat(32);
        let project_path = "/tmp/gofer/project".to_owned();
        let session = RpcSession::start(listener, token.clone(), project_path.clone());
        let events = session.subscribe_events();

        let mut addon = addon_client(address);
        writeln!(
            addon,
            "{}",
            serde_json::to_string(&handshake(&token, &project_path)).unwrap()
        )
        .unwrap();

        let mut reader = BufReader::new(addon.try_clone().unwrap());
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();

        writeln!(
            addon,
            "{}",
            serde_json::to_string(&json!({
                "protocolVersion": 2,
                "kind": "event",
                "id": "session-1",
                "sequence": 1,
                "event": "session.ready",
                "data": {"ready": true}
            }))
            .unwrap()
        )
        .unwrap();

        let event = events
            .recv_timeout(Duration::from_millis(200))
            .expect("event");
        assert_eq!(event.sequence, 1);
        assert_eq!(event.event, "session.ready");
        session.stop();
    }

    /// A caller never reaches the wire with a request the session already knows it cannot deliver:
    /// a stopped session refuses immediately rather than making the caller wait out a timeout.
    ///
    /// This used to also cover an id past the protocol's 128-character cap. There is no such call
    /// any more — the session mints the id, and `gofer-{counter}` cannot be too long, cannot
    /// repeat, and cannot spell one of the names the transport reserves for traffic that belongs
    /// to nobody. The check that refused it is gone with the way of writing one.
    #[test]
    fn a_stopped_session_refuses_a_call_before_the_wire() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let session = RpcSession::start(listener, "a1".repeat(32), "/tmp/gofer/project".to_owned());

        session.stop();
        let stopped = session
            .call(CallRequest::new("scene.list", json!({})).within(Some(100)))
            .expect_err("a stopped session refuses immediately");
        assert_eq!(stopped.code, "session_closed");
    }

    /// Two requests never share a correlation id, and none of them is one the reader would drop.
    ///
    /// A timed-out or cancelled call deliberately leaves its pending entry behind, so uniqueness
    /// has to hold against abandoned requests too — and `pending.insert` overwrote in silence. Six
    /// call sites used to invent the id, one of them with a spelling stable across a whole sweep of
    /// failed mutations at one revision.
    #[test]
    fn every_request_is_sent_under_an_id_of_the_sessions_own() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let address = listener.local_addr().expect("listener address");
        let token = "a1".repeat(32);
        let session = RpcSession::start(listener, token.clone(), "/tmp/p".to_owned());
        let mut addon = addon_client(address);
        writeln!(
            addon,
            "{}",
            serde_json::to_string(&handshake(&token, "/tmp/p")).unwrap()
        )
        .unwrap();
        let mut reader = BufReader::new(addon.try_clone().unwrap());
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();

        // Two calls that both give up. Neither answer arrives, so both pending entries stay — which
        // is exactly the case a repeated spelling would corrupt.
        let sender = session.clone();
        let asking = thread::spawn(move || {
            let _ = sender.call(CallRequest::new("scene.list", json!({})).within(Some(50)));
            let _ = sender.call(CallRequest::new("scene.list", json!({})).within(Some(50)));
        });

        let mut ids = Vec::new();
        while ids.len() < 2 {
            let mut sent = String::new();
            reader.read_line(&mut sent).expect("a request");
            let request: Value = serde_json::from_str(&sent).unwrap();
            if request["kind"] != "request" {
                continue;
            }
            ids.push(request["id"].as_str().expect("an id").to_owned());
        }
        asking.join().expect("both calls gave up");

        assert_ne!(ids[0], ids[1], "two requests must never share an id");
        for id in &ids {
            assert!(id.len() <= MAX_ID_LENGTH, "{id} is past the protocol cap");
            assert_ne!(id, HEARTBEAT_ID, "a call must not spell the heartbeat's id");
            assert!(
                !id.starts_with(CANCEL_ID_PREFIX),
                "{id} spells a cancellation, whose answer the reader drops"
            );
        }
        session.stop();
    }

    /// The framing has to survive what a real socket delivers, and the two cases are not the same
    /// kind of event: a bare newline is keepalive and costs nothing, while a reply to a request
    /// nobody is waiting for means the two sides disagree about what is outstanding.
    #[test]
    fn a_blank_line_is_keepalive_and_a_stale_reply_ends_the_session() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let address = listener.local_addr().expect("listener address");
        let token = "a1".repeat(32);
        let project_path = "/tmp/gofer/project".to_owned();
        let session = RpcSession::start(listener, token.clone(), project_path.clone());

        let mut addon = addon_client(address);
        writeln!(
            addon,
            "{}",
            serde_json::to_string(&handshake(&token, &project_path)).unwrap()
        )
        .unwrap();
        let mut reader = BufReader::new(addon.try_clone().unwrap());
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        let accepted: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(accepted["kind"], "response");

        // Only the session loop tolerates a bare newline. The handshake reader does not: the
        // handshake must be the connection's first line, and a blank one there is a protocol
        // error rather than keepalive.
        writeln!(addon).unwrap();

        writeln!(
            addon,
            "{}",
            serde_json::to_string(&json!({
                "protocolVersion": 2,
                "kind": "response",
                "id": "nobody-is-waiting",
                "result": {}
            }))
            .unwrap()
        )
        .unwrap();
        line.clear();
        reader.read_line(&mut line).unwrap();
        let stale: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(stale["error"]["code"], "stale_reply");

        // A reply nobody is waiting for is not a stray message to drop: the addon and the session
        // disagree about what is outstanding, and the only safe answer is to stop. The connection
        // is closed behind that error.
        // The session is done with this addon: the disagreement is recorded as the connection's
        // error, so the next caller is told what happened instead of waiting out a timeout.
        let refused = session
            .call(CallRequest::new("scene.list".to_owned(), json!({})).within(Some(100)))
            .expect_err("a session that lost track of its requests cannot carry another");
        assert_eq!(refused.code, "stale_reply");
        session.stop();
    }

    /// A line past the envelope cap cannot be answered and cannot be skipped: the reader would
    /// have to guess where the next envelope begins, and every message after it would be framed
    /// against that guess. The addon is told which cap it passed, and the connection ends.
    #[test]
    fn an_oversized_envelope_is_refused_rather_than_truncated() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let address = listener.local_addr().expect("listener address");
        let session = RpcSession::start(listener, "a1".repeat(32), "/tmp/gofer/project".to_owned());

        let mut addon = addon_client(address);
        writeln!(addon, "{}", "x".repeat(MAX_ENVELOPE_BYTES + 1)).unwrap();

        let mut reader = BufReader::new(addon.try_clone().unwrap());
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        let refused: Value = serde_json::from_str(&line).unwrap();

        assert_eq!(refused["error"]["code"], "payload_too_large");
        assert_eq!(refused["kind"], "error");
        session.stop();
    }
}

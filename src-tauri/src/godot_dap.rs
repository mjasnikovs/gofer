//! Client for Godot's native debug adapter.
//!
//! The editor started by the session supervisor listens for DAP over loopback TCP on the port
//! passed through `--dap-port`. This module owns that connection: Content-Length framing, request
//! correlation, event broadcast, and the exact sequence Godot 4.7 expects — `initialize`,
//! `launch`/`attach`, `setBreakpoints`, `configurationDone` — followed by the debug control flow
//! (pause/continue, stepping, stack/scopes/variables, evaluate, restart/terminate, disconnect).
//!
//! Five Godot behaviors shape the design:
//!
//! - Some responses are deferred, not just slow. `launch` is only answered once
//!   `configurationDone` actually spawns the game (the response keeps the launch `request_seq`),
//!   and `stackTrace`/`evaluate` are held until the debuggee answers over the remote debugger
//!   channel. Timeouts are generous and every call site can widen them.
//! - `variables` is the exception: rather than hold the request, Godot rejects a reference it has
//!   not received from the debuggee yet with a plain error. `scopes` answers straight from the
//!   stack dump and only *starts* the remote scope fetch, so the very next `variables` loses that
//!   race. [`DapClient::variables`] therefore retries a rejection for [`SETTLE_TIMEOUT`] before
//!   surfacing it.
//! - Godot has no `stepOut` handler, so [`DapClient::step_out`] emulates it with bounded
//!   step-over requests until the stack depth decreases. It stops immediately on another
//!   breakpoint, an exception, a pause, termination, or the safety limit.
//! - The stopped reasons Godot sends are `breakpoint`, `step`, `exception`, and `paused`, always
//!   on thread 1: the engine only debugs one thread.
//! - `disconnect` detaches an attached session, but stops a launched game regardless of
//!   `terminateDebuggee` — Godot ignores the flag. The flag is still sent so other adapters see
//!   the caller's intent.
//!
//! Public items are consumed by Tauri commands in later integration steps; the allow attribute
//! prevents cdylib/staticlib builds from treating them as dead code until those commands land.
#![allow(dead_code)]

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Shutdown, SocketAddr, TcpStream};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

/// The debuggee answers over the remote debugger channel after the editor polls it, so a
/// request's latency tracks both editor and game load. Thirty seconds is deliberate: a faster
/// default would turn a heavy frame into a spurious failure.
pub const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// Launching additionally waits out the game process spawn, which only happens when
/// `configurationDone` arrives.
pub const LAUNCH_TIMEOUT: Duration = Duration::from_secs(60);
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_MESSAGE_BYTES: usize = 16 * 1024 * 1024;
const MAX_HEADER_LINES: usize = 32;
/// Step-out is emulated through repeated `next` requests; without a bound, a function that never
/// returns (an endless loop the user is debugging, say) would spin the client forever.
pub const MAX_STEP_OUT_STEPS: u32 = 256;
/// Godot only supports debugging one thread and hardcodes it to id 1.
pub const MAIN_THREAD_ID: i64 = 1;
/// How long a request that depends on the debuggee's scope dump keeps retrying a rejection.
pub const SETTLE_TIMEOUT: Duration = Duration::from_secs(5);
const SETTLE_INTERVAL: Duration = Duration::from_millis(25);

/// A structured, actionable debug-adapter failure.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DapError {
    pub code: &'static str,
    pub message: String,
    pub retryable: bool,
    pub details: Value,
}

impl DapError {
    pub(crate) fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            retryable: false,
            details: json!({}),
        }
    }

    pub(crate) fn retryable(mut self) -> Self {
        self.retryable = true;
        self
    }

    fn with_details(mut self, details: Value) -> Self {
        self.details = details;
        self
    }

    fn poisoned() -> Self {
        Self::new("lock_poisoned", "The DAP state lock is poisoned")
    }

    fn closed() -> Self {
        Self::new("session_closed", "The DAP session is closed")
    }
}

/// The capabilities Godot reports during initialize. Unknown fields are kept in `extra` so a
/// newer engine can advertise more without a client change.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DapCapabilities {
    pub supports_configuration_done_request: bool,
    pub supports_breakpoint_locations_request: bool,
    pub supports_restart_request: bool,
    pub supports_terminate_request: bool,
    pub support_terminate_debuggee: bool,
    pub support_suspend_debuggee: bool,
    pub supports_set_variable: bool,
    pub supports_evaluate_for_hovers: bool,
    #[serde(flatten)]
    pub extra: HashMap<String, Value>,
}

/// One breakpoint as the adapter reports it after `setBreakpoints`.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Breakpoint {
    pub id: i64,
    pub verified: bool,
    pub line: Option<i64>,
    pub message: Option<String>,
}

/// One line the adapter accepts as a breakpoint candidate.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BreakpointLocation {
    pub line: i64,
    pub end_line: Option<i64>,
}

/// A debuggable thread. Godot reports exactly one, named "Main".
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DebugThread {
    pub id: i64,
    pub name: String,
}

/// One frame of the stopped stack.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct StackFrame {
    pub id: i64,
    pub name: String,
    pub line: i64,
    pub column: i64,
    pub source_path: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct WireStackFrame {
    id: i64,
    name: String,
    line: i64,
    column: i64,
    source: Option<WireSource>,
}

#[derive(Deserialize, Default)]
struct WireSource {
    path: Option<String>,
}

/// One variable scope of a stack frame. Godot always reports Locals, Members, and Globals.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Scope {
    pub name: String,
    pub presentation_hint: Option<String>,
    pub variables_reference: i64,
    pub expensive: bool,
}

/// One variable inside a scope or object.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Variable {
    pub name: String,
    pub value: String,
    #[serde(rename = "type")]
    pub value_type: Option<String>,
    pub variables_reference: i64,
}

/// The result of evaluating an expression in the debuggee.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct EvaluateResult {
    pub result: String,
    #[serde(rename = "type")]
    pub value_type: Option<String>,
    pub variables_reference: i64,
}

/// One event the adapter pushed. The body stays raw: later integration steps forward it to the
/// renderer, and a typed envelope per event kind would only duplicate the DAP specification.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DapEvent {
    pub seq: u64,
    pub event: String,
    pub body: Value,
}

/// The parsed body of a `stopped` event.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct StoppedDetails {
    pub reason: String,
    pub thread_id: Option<i64>,
    pub description: Option<String>,
    pub text: Option<String>,
    pub all_threads_stopped: bool,
}

impl StoppedDetails {
    /// Parses a `stopped` event body. Returns `None` when the body is not an object, which a
    /// conforming adapter never sends.
    pub fn from_event_body(body: &Value) -> Option<Self> {
        if !body.is_object() {
            return None;
        }
        serde_json::from_value(body.clone()).ok()
    }
}

/// How an emulated step-out ended.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum StepOutcome {
    /// A step-over landed at a shallower stack depth: the frame was escaped.
    SteppedOut { stop: StoppedDetails },
    /// A breakpoint, exception, or pause interrupted the emulation before the escape.
    Interrupted { stop: StoppedDetails },
    /// The debuggee terminated mid-emulation.
    Terminated,
}

struct Shared {
    writer: TcpStream,
    pending: HashMap<u64, Sender<Result<Value, DapError>>>,
    events: Vec<Sender<DapEvent>>,
    closed: bool,
}

/// A connected Godot debug adapter session.
pub struct DapClient {
    shared: Arc<Mutex<Shared>>,
    next_seq: Arc<AtomicU64>,
    reader: Mutex<Option<JoinHandle<()>>>,
    capabilities: DapCapabilities,
    launch_arguments: Mutex<Option<Value>>,
}

impl DapClient {
    /// Connects to a loopback debug adapter. Non-loopback transports are refused outright. The
    /// handshake is a separate [`Self::initialize`] call so the caller can subscribe to events
    /// first: the `initialized` event rides out with the initialize response.
    pub fn connect(address: SocketAddr) -> Result<Self, DapError> {
        if !address.ip().is_loopback() {
            return Err(DapError::new(
                "transport_not_loopback",
                "The debug adapter must be reached over loopback",
            )
            .with_details(json!({"address": address.to_string()})));
        }
        let stream = TcpStream::connect(address).map_err(|error| {
            DapError::new(
                "connect_failed",
                format!("Could not reach the debug adapter at {address}: {error}"),
            )
            .retryable()
        })?;
        let _ = stream.set_write_timeout(Some(DEFAULT_REQUEST_TIMEOUT));
        let reader_stream = stream.try_clone().map_err(|error| {
            DapError::new(
                "connect_failed",
                format!("Could not clone the debug adapter socket: {error}"),
            )
        })?;

        let shared = Arc::new(Mutex::new(Shared {
            writer: stream,
            pending: HashMap::new(),
            events: Vec::new(),
            closed: false,
        }));
        let next_seq = Arc::new(AtomicU64::new(1));
        let reader = thread::spawn({
            let shared = Arc::clone(&shared);
            let next_seq = Arc::clone(&next_seq);
            move || read_loop(BufReader::new(reader_stream), shared, next_seq)
        });

        Ok(Self {
            shared,
            next_seq,
            reader: Mutex::new(Some(reader)),
            capabilities: DapCapabilities::default(),
            launch_arguments: Mutex::new(None),
        })
    }

    /// Completes the DAP handshake and records the capabilities. Lines and columns are declared
    /// 1-based, matching both Godot's editor UI and Monaco.
    pub fn initialize(&mut self) -> Result<DapCapabilities, DapError> {
        let body = self.request_with_timeout(
            "initialize",
            json!({
                "clientID": "gofer",
                "clientName": format!("Gofer {}", env!("CARGO_PKG_VERSION")),
                "adapterID": "godot",
                "linesStartAt1": true,
                "columnsStartAt1": true,
                "pathFormat": "path",
                "supportsVariableType": true,
                "supportsVariablePaging": false,
                "supportsRunInTerminalRequest": false,
                "supportsMemoryReferences": false,
                "supportsInvalidatedEvent": false
            }),
            DEFAULT_REQUEST_TIMEOUT,
        )?;
        let capabilities = serde_json::from_value::<DapCapabilities>(body).map_err(|error| {
            DapError::new(
                "invalid_response",
                format!("The initialize answer is not a capabilities object: {error}"),
            )
        })?;
        self.capabilities = capabilities.clone();
        Ok(capabilities)
    }

    /// The capabilities the adapter reported during initialize.
    pub fn capabilities(&self) -> &DapCapabilities {
        &self.capabilities
    }

    /// Subscribes to every event the adapter pushes: stopped, continued, terminated, exited,
    /// output, process, breakpoint, and Godot's `godot/custom_data`.
    pub fn subscribe_events(&self) -> Receiver<DapEvent> {
        let (sender, receiver) = channel();
        if let Ok(mut shared) = self.shared.lock() {
            shared.events.push(sender);
        }
        receiver
    }

    /// Queues the game launch. Godot defers the response until [`Self::configuration_done`]
    /// actually spawns the process, so this call blocks across that boundary; callers send
    /// `configuration_done` from another thread or task. `project` must be the editor's own
    /// project path — Godot rejects anything outside it with `wrong_path`. `play_args` are
    /// forwarded to the game process verbatim, which is how a headless editor passes `--headless`
    /// on to the game: Godot does not forward it itself.
    pub fn launch(&self, project: &Path, play_args: &[String]) -> Result<(), DapError> {
        let arguments = json!({
            "project": project.to_string_lossy(),
            "scene": "main",
            "playArgs": play_args,
        });
        *self
            .launch_arguments
            .lock()
            .map_err(|_| DapError::poisoned())? = Some(arguments.clone());
        self.request_with_timeout("launch", arguments, LAUNCH_TIMEOUT)?;
        Ok(())
    }

    /// Attaches to the game the editor is already running. Godot answers `not_running` when no
    /// debug session is active.
    pub fn attach(&self) -> Result<(), DapError> {
        *self
            .launch_arguments
            .lock()
            .map_err(|_| DapError::poisoned())? = Some(json!({}));
        self.request("attach", json!({}))?;
        Ok(())
    }

    /// Replaces every breakpoint in one source file. `source_path` must be absolute and inside
    /// the editor's project; Godot rejects anything else with `wrong_path`. The response lists
    /// the file's breakpoints after the update, each with its verified flag and effective line —
    /// the values later steps reflect back into Monaco and the agent. Changes take effect on a
    /// running debuggee, but Godot only broadcasts `breakpoint` events for editor-side toggles,
    /// not for DAP-driven ones, so the response is the source of truth.
    pub fn set_breakpoints(
        &self,
        source_path: &Path,
        lines: &[i64],
    ) -> Result<Vec<Breakpoint>, DapError> {
        let breakpoints: Vec<Value> = lines.iter().map(|line| json!({"line": line})).collect();
        let body = self.request(
            "setBreakpoints",
            json!({
                "source": source_json(source_path),
                "breakpoints": breakpoints,
                "sourceModified": false
            }),
        )?;
        parse_body(&body, "breakpoints")
    }

    /// Asks which lines near `line` can hold a breakpoint. Godot answers with a `breakpoints` key
    /// instead of the specification's `breakpointLocations`, so both are accepted.
    pub fn breakpoint_locations(
        &self,
        source_path: &Path,
        line: i64,
    ) -> Result<Vec<BreakpointLocation>, DapError> {
        let body = self.request(
            "breakpointLocations",
            json!({"source": source_json(source_path), "line": line}),
        )?;
        let key = if body.get("breakpointLocations").is_some() {
            "breakpointLocations"
        } else {
            "breakpoints"
        };
        parse_body(&body, key)
    }

    /// Signals that configuration is complete. Godot runs the deferred launch at exactly this
    /// point, which is also when the launch response is finally sent.
    pub fn configuration_done(&self) -> Result<(), DapError> {
        self.request("configurationDone", json!({}))?;
        Ok(())
    }

    /// Lists debuggable threads. Godot reports exactly one: id 1, "Main".
    pub fn threads(&self) -> Result<Vec<DebugThread>, DapError> {
        let body = self.request("threads", json!({}))?;
        parse_body(&body, "threads")
    }

    /// Reads the stopped stack of a thread, innermost frame first.
    pub fn stack_trace(&self, thread_id: i64) -> Result<Vec<StackFrame>, DapError> {
        let body = self.request("stackTrace", json!({"threadId": thread_id}))?;
        let frames = body
            .get("stackFrames")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mut parsed = Vec::with_capacity(frames.len());
        for frame in &frames {
            let wire: WireStackFrame = serde_json::from_value(frame.clone()).map_err(|error| {
                DapError::new(
                    "invalid_response",
                    format!("A stack frame did not match the protocol: {error}"),
                )
            })?;
            parsed.push(StackFrame {
                id: wire.id,
                name: wire.name,
                line: wire.line,
                column: wire.column,
                source_path: wire.source.and_then(|source| source.path),
            });
        }
        Ok(parsed)
    }

    /// The number of frames on the thread's stack. Step-out compares depths across steps.
    pub fn stack_depth(&self, thread_id: i64) -> Result<usize, DapError> {
        Ok(self.stack_trace(thread_id)?.len())
    }

    /// Lists the scopes of a stack frame. Godot always reports Locals, Members, and Globals.
    pub fn scopes(&self, frame_id: i64) -> Result<Vec<Scope>, DapError> {
        let body = self.request("scopes", json!({"frameId": frame_id}))?;
        parse_body(&body, "scopes")
    }

    /// Lists the variables under a scope or structured variable reference.
    ///
    /// A reference the debuggee has not dumped yet is rejected rather than held, and `scopes`
    /// hands out references before that dump lands, so the rejection is retried for
    /// [`SETTLE_TIMEOUT`]. A reference that is genuinely wrong keeps failing and surfaces the
    /// adapter's own error once the window closes.
    pub fn variables(&self, variables_reference: i64) -> Result<Vec<Variable>, DapError> {
        let arguments = json!({"variablesReference": variables_reference});
        let deadline = Instant::now() + SETTLE_TIMEOUT;
        loop {
            match self.request("variables", arguments.clone()) {
                Ok(body) => return parse_body(&body, "variables"),
                Err(error) if error.code == "dap_server_error" && Instant::now() < deadline => {
                    thread::sleep(SETTLE_INTERVAL);
                }
                Err(error) => return Err(error),
            }
        }
    }

    /// Evaluates an expression in the debuggee, in the context of `frame_id` when given (the most
    /// recent frame Godot reported otherwise). The response is deferred until the debuggee
    /// computes the value, so the default timeout applies on top of a stopped game.
    pub fn evaluate(
        &self,
        expression: &str,
        frame_id: Option<i64>,
    ) -> Result<EvaluateResult, DapError> {
        let mut arguments = json!({"expression": expression});
        if let Some(frame_id) = frame_id {
            arguments["frameId"] = json!(frame_id);
        }
        let body = self.request("evaluate", arguments)?;
        serde_json::from_value(body).map_err(|error| {
            DapError::new(
                "invalid_response",
                format!("The evaluate answer did not match the protocol: {error}"),
            )
        })
    }

    /// Resumes the debuggee. Returns whether every thread continued; Godot sends no body, which
    /// the specification treats as true.
    pub fn continue_execution(&self, thread_id: i64) -> Result<bool, DapError> {
        let body = self.request("continue", json!({"threadId": thread_id}))?;
        Ok(body
            .get("allThreadsContinued")
            .and_then(Value::as_bool)
            .unwrap_or(true))
    }

    /// Pauses the debuggee. A `stopped` event with reason `paused` follows.
    pub fn pause(&self, thread_id: i64) -> Result<(), DapError> {
        self.request("pause", json!({"threadId": thread_id}))?;
        Ok(())
    }

    /// Steps over the next statement. A `stopped` event with reason `step` follows.
    pub fn next(&self, thread_id: i64) -> Result<(), DapError> {
        self.request("next", json!({"threadId": thread_id}))?;
        Ok(())
    }

    /// Steps into the next call. A `stopped` event with reason `step` follows.
    pub fn step_in(&self, thread_id: i64) -> Result<(), DapError> {
        self.request("stepIn", json!({"threadId": thread_id}))?;
        Ok(())
    }

    /// Emulates step-out, which Godot 4.7 does not implement: bounded `next` requests until the
    /// stack depth drops below the depth the frame started at. The loop stops immediately when a
    /// breakpoint, exception, or pause interrupts it, when the debuggee terminates, or when the
    /// safety limit is reached without escaping.
    pub fn step_out(&self, thread_id: i64) -> Result<StepOutcome, DapError> {
        let initial_depth = self.stack_depth(thread_id)?;
        let events = self.subscribe_events();
        for _ in 0..MAX_STEP_OUT_STEPS {
            self.next(thread_id)?;
            let Some(stop) = self.await_stop(&events, thread_id, DEFAULT_REQUEST_TIMEOUT)? else {
                return Ok(StepOutcome::Terminated);
            };
            if stop.reason != "step" {
                return Ok(StepOutcome::Interrupted { stop });
            }
            if self.stack_depth(thread_id)? < initial_depth {
                return Ok(StepOutcome::SteppedOut { stop });
            }
        }
        Err(DapError::new(
            "step_out_limit",
            format!("Step-out did not escape the frame within {MAX_STEP_OUT_STEPS} steps"),
        )
        .with_details(json!({"threadId": thread_id, "limit": MAX_STEP_OUT_STEPS})))
    }

    /// Relaunches the game with the arguments of the last launch or attach, nested the way
    /// Godot's restart handler expects (`arguments.arguments`).
    pub fn restart(&self) -> Result<(), DapError> {
        let arguments = self
            .launch_arguments
            .lock()
            .map_err(|_| DapError::poisoned())?
            .clone()
            .unwrap_or_else(|| json!({}));
        self.request_with_timeout("restart", json!({"arguments": arguments}), LAUNCH_TIMEOUT)?;
        Ok(())
    }

    /// Stops the game but keeps the adapter session. `exited` and `terminated` events follow.
    pub fn terminate(&self) -> Result<(), DapError> {
        self.request("terminate", json!({}))?;
        Ok(())
    }

    /// Ends the adapter session. Godot ignores `terminateDebuggee` for launched games — a
    /// disconnect always stops them — and only attached sessions genuinely detach, so the flag
    /// records intent rather than guaranteeing behavior.
    pub fn disconnect(&self, terminate_debuggee: bool) -> Result<(), DapError> {
        self.request(
            "disconnect",
            json!({"terminateDebuggee": terminate_debuggee}),
        )?;
        Ok(())
    }

    /// Waits for the next `stopped` event on `thread_id` (a missing thread id matches, since
    /// Godot only has one thread). Returns `None` when the debuggee terminates or exits first.
    /// Output, process, and breakpoint events are skipped; a subscriber that wants them holds its
    /// own receiver.
    pub fn await_stop(
        &self,
        events: &Receiver<DapEvent>,
        thread_id: i64,
        timeout: Duration,
    ) -> Result<Option<StoppedDetails>, DapError> {
        let deadline = Instant::now() + timeout;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(DapError::new(
                    "stop_timeout",
                    format!("No stopped event arrived within {timeout:?}"),
                )
                .retryable());
            }
            let event = events.recv_timeout(remaining).map_err(|_| {
                DapError::new(
                    "stop_timeout",
                    format!("No stopped event arrived within {timeout:?}"),
                )
                .retryable()
            })?;
            match event.event.as_str() {
                "stopped" => {
                    let Some(stop) = StoppedDetails::from_event_body(&event.body) else {
                        continue;
                    };
                    if stop.thread_id.is_none_or(|id| id == thread_id) {
                        return Ok(Some(stop));
                    }
                }
                "terminated" | "exited" => return Ok(None),
                _ => {}
            }
        }
    }

    /// Registers a request, writes it, and returns its sequence number plus the response
    /// receiver. Split from [`Self::await_response`] so callers can overlap requests: Godot's
    /// deferred launch response only arrives after a later `configurationDone` request.
    pub fn start_request(
        &self,
        command: &str,
        arguments: Value,
    ) -> Result<(u64, Receiver<Result<Value, DapError>>), DapError> {
        let seq = self.next_seq.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = channel();
        let mut shared = self.lock_shared()?;
        if shared.closed {
            return Err(DapError::closed());
        }
        shared.pending.insert(seq, sender);
        let message =
            json!({"seq": seq, "type": "request", "command": command, "arguments": arguments});
        if let Err(error) = write_message(&mut shared.writer, &message) {
            shared.pending.remove(&seq);
            return Err(error);
        }
        Ok((seq, receiver))
    }

    /// Waits for the response to a request made with [`Self::start_request`]. A late response
    /// after a timeout is dropped by the reader, which no longer finds a pending entry.
    pub fn await_response(
        &self,
        seq: u64,
        receiver: &Receiver<Result<Value, DapError>>,
        timeout: Duration,
    ) -> Result<Value, DapError> {
        match receiver.recv_timeout(timeout) {
            Ok(result) => result,
            Err(_) => {
                if let Ok(mut shared) = self.shared.lock() {
                    shared.pending.remove(&seq);
                }
                Err(DapError::new(
                    "request_timeout",
                    format!("The debug adapter did not answer within {timeout:?}"),
                )
                .retryable())
            }
        }
    }

    fn request(&self, command: &str, arguments: Value) -> Result<Value, DapError> {
        self.request_with_timeout(command, arguments, DEFAULT_REQUEST_TIMEOUT)
    }

    fn request_with_timeout(
        &self,
        command: &str,
        arguments: Value,
        timeout: Duration,
    ) -> Result<Value, DapError> {
        let (seq, receiver) = self.start_request(command, arguments)?;
        let response = self.await_response(seq, &receiver, timeout)?;
        if !response
            .get("success")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            return Err(server_error(&response));
        }
        Ok(response.get("body").cloned().unwrap_or(Value::Null))
    }

    fn lock_shared(&self) -> Result<MutexGuard<'_, Shared>, DapError> {
        self.shared.lock().map_err(|_| DapError::poisoned())
    }

    /// Disconnects the way the protocol expects — `disconnect` terminating the debuggee — and
    /// closes the transport. Repeated calls are no-ops.
    pub fn shutdown(&self) {
        if self
            .shared
            .lock()
            .map(|shared| shared.closed)
            .unwrap_or(true)
        {
            return;
        }
        let _ = self.request_with_timeout(
            "disconnect",
            json!({"terminateDebuggee": true}),
            SHUTDOWN_TIMEOUT,
        );
        self.close(DapError::closed());
    }

    fn close(&self, error: DapError) {
        {
            let Ok(mut shared) = self.shared.lock() else {
                return;
            };
            shared.closed = true;
            fail_pending(&mut shared, error);
            let _ = shared.writer.shutdown(Shutdown::Both);
        }
        if let Ok(mut reader) = self.reader.lock()
            && let Some(handle) = reader.take()
        {
            let _ = handle.join();
        }
    }
}

impl Drop for DapClient {
    fn drop(&mut self) {
        // Best effort only: the editor may already be dead, so no disconnect handshake here.
        self.close(DapError::closed());
    }
}

/// Builds the DAP source object for a file. Godot reads `name` and `checksums` unconditionally
/// and logs engine errors when they are missing, so both ride along with the path.
fn source_json(source_path: &Path) -> Value {
    let name = source_path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    json!({"name": name, "path": source_path.to_string_lossy(), "checksums": []})
}

/// Parses a typed list out of a response body, rejecting bodies that name the key without an
/// array.
fn parse_body<T: serde::de::DeserializeOwned>(body: &Value, key: &str) -> Result<Vec<T>, DapError> {
    let items = body.get(key).cloned().unwrap_or_else(|| json!([]));
    serde_json::from_value(items).map_err(|error| {
        DapError::new(
            "invalid_response",
            format!("The {key} answer did not match the protocol: {error}"),
        )
    })
}

fn server_error(response: &Value) -> DapError {
    let error = response
        .get("body")
        .and_then(|body| body.get("error"))
        .cloned()
        .unwrap_or(Value::Null);
    let format = error
        .get("format")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let label = response
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let message = if format.is_empty() {
        format!("The debug adapter reported an error: {label}")
    } else {
        format!("{format} ({label})")
    };
    DapError::new("dap_server_error", message).with_details(json!({
        "adapterMessage": label,
        "command": response.get("command").cloned().unwrap_or(Value::Null),
        "error": error,
    }))
}

fn read_loop(reader: BufReader<TcpStream>, shared: Arc<Mutex<Shared>>, next_seq: Arc<AtomicU64>) {
    let mut reader = reader;
    let mut failure = None;
    loop {
        match read_message(&mut reader) {
            Ok(Some(message)) => dispatch(&shared, &next_seq, message),
            Ok(None) => break,
            Err(error) => {
                failure = Some(error);
                break;
            }
        }
    }
    let error = failure.unwrap_or_else(|| {
        DapError::new(
            "transport_closed",
            "The debug adapter closed the connection",
        )
        .retryable()
    });
    if let Ok(mut shared) = shared.lock() {
        shared.closed = true;
        fail_pending(&mut shared, error);
    }
}

fn dispatch(shared: &Arc<Mutex<Shared>>, next_seq: &AtomicU64, message: Value) {
    match message.get("type").and_then(Value::as_str) {
        Some("response") => {
            let Some(seq) = message.get("request_seq").and_then(Value::as_u64) else {
                return;
            };
            let Ok(mut shared) = shared.lock() else {
                return;
            };
            let Some(pending) = shared.pending.remove(&seq) else {
                // A response to a timed-out request: expected, not an error.
                return;
            };
            let _ = pending.send(Ok(message));
        }
        Some("event") => {
            let Some(name) = message.get("event").and_then(Value::as_str) else {
                return;
            };
            let event = DapEvent {
                seq: message.get("seq").and_then(Value::as_u64).unwrap_or(0),
                event: name.to_owned(),
                body: message.get("body").cloned().unwrap_or(Value::Null),
            };
            if let Ok(mut shared) = shared.lock() {
                shared
                    .events
                    .retain(|sender| sender.send(event.clone()).is_ok());
            }
        }
        // A reverse request (runInTerminal, startDebugging) gets a failure reply rather than
        // silence: some adapters wait on the reply before answering anything else. Godot 4.7
        // never sends one, but a conforming adapter may.
        Some("request") => {
            if let Ok(mut shared) = shared.lock() {
                let reply = json!({
                    "seq": next_seq.fetch_add(1, Ordering::Relaxed),
                    "type": "response",
                    "request_seq": message.get("seq").cloned().unwrap_or(Value::Null),
                    "command": message.get("command").cloned().unwrap_or(Value::Null),
                    "success": false,
                    "message": "gofer does not handle reverse requests"
                });
                let _ = write_message(&mut shared.writer, &reply);
            }
        }
        _ => {}
    }
}

fn fail_pending(shared: &mut Shared, error: DapError) {
    for (_, pending) in std::mem::take(&mut shared.pending) {
        let _ = pending.send(Err(error.clone()));
    }
}

fn read_message(reader: &mut BufReader<TcpStream>) -> Result<Option<Value>, DapError> {
    let mut content_length = None;
    for _ in 0..MAX_HEADER_LINES {
        let mut line = String::new();
        let bytes = reader.read_line(&mut line).map_err(|error| {
            DapError::new(
                "transport_failed",
                format!("Could not read from the debug adapter: {error}"),
            )
            .retryable()
        })?;
        if bytes == 0 {
            return Ok(None);
        }
        let line = line.trim_end();
        if line.is_empty() {
            if content_length.is_some() {
                break;
            }
            continue;
        }
        if let Some((name, value)) = line.split_once(':')
            && name.trim().eq_ignore_ascii_case("content-length")
        {
            content_length = value.trim().parse::<usize>().ok();
        }
    }
    let length = content_length.ok_or_else(|| {
        DapError::new(
            "invalid_frame",
            "The debug adapter sent a message without a Content-Length header",
        )
    })?;
    if length == 0 || length > MAX_MESSAGE_BYTES {
        return Err(DapError::new(
            "payload_too_large",
            format!("The debug adapter message is {length} bytes"),
        ));
    }
    let mut body = vec![0u8; length];
    reader.read_exact(&mut body).map_err(|error| {
        DapError::new(
            "transport_failed",
            format!("Could not read the debug adapter message: {error}"),
        )
        .retryable()
    })?;
    serde_json::from_slice(&body).map(Some).map_err(|error| {
        DapError::new("invalid_frame", format!("The message is not JSON: {error}"))
    })
}

fn write_message(writer: &mut TcpStream, message: &Value) -> Result<(), DapError> {
    let body = serde_json::to_vec(message)
        .map_err(|error| DapError::new("serialize_failed", format!("{error}")))?;
    let mut frame = format!("Content-Length: {}\r\n\r\n", body.len()).into_bytes();
    frame.extend_from_slice(&body);
    writer
        .write_all(&frame)
        .and_then(|()| writer.flush())
        .map_err(|error| {
            DapError::new(
                "transport_failed",
                format!("Could not write to the debug adapter: {error}"),
            )
            .retryable()
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::path::PathBuf;
    use std::sync::mpsc::Receiver as MpscReceiver;

    /// What the fake adapter does with one incoming request.
    enum FakeAction {
        /// Answers `success: true` with the given body.
        Result(Value),
        /// Answers `success: false` with the given message and a DAP error object.
        Error(&'static str),
        /// Sends no response at all: the deferred-answer path Godot uses for launch and
        /// mid-dump variable requests.
        Ignore,
    }

    struct FakeServer {
        address: SocketAddr,
        received: MpscReceiver<Value>,
        join: JoinHandle<()>,
    }

    /// Runs a loopback DAP server that records every request and answers through `handler`. The
    /// handler also receives the writer so it can push events and out-of-order responses.
    fn start_fake_server<F>(mut handler: F) -> FakeServer
    where
        F: FnMut(&Value, &mut TcpStream) -> FakeAction + Send + 'static,
    {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind fake server");
        let address = listener.local_addr().expect("fake server address");
        let (sender, receiver) = channel();
        let join = thread::spawn(move || {
            let (stream, _) = listener.accept().expect("accept client");
            let _ = stream.set_nodelay(true);
            let mut reader = BufReader::new(stream.try_clone().expect("clone stream"));
            let mut writer = stream;
            let mut server_seq = 100u64;
            while let Ok(Some(message)) = read_message(&mut reader) {
                let _ = sender.send(message.clone());
                if message.get("type").and_then(Value::as_str) != Some("request") {
                    continue;
                }
                // Teardown is answered for every handler: a silent `disconnect` would make each
                // test pay the full shutdown timeout for nothing.
                let action = if message["command"] == "disconnect" {
                    FakeAction::Result(json!({}))
                } else {
                    handler(&message, &mut writer)
                };
                match action {
                    FakeAction::Result(body) => {
                        server_seq += 1;
                        let reply = json!({
                            "seq": server_seq,
                            "type": "response",
                            "request_seq": message["seq"],
                            "command": message["command"],
                            "success": true,
                            "body": body
                        });
                        write_message(&mut writer, &reply).expect("write reply");
                    }
                    FakeAction::Error(label) => {
                        server_seq += 1;
                        let reply = json!({
                            "seq": server_seq,
                            "type": "response",
                            "request_seq": message["seq"],
                            "command": message["command"],
                            "success": false,
                            "message": label,
                            "body": {"error": {"id": 1, "format": format!("adapter says {label}")}}
                        });
                        write_message(&mut writer, &reply).expect("write error reply");
                    }
                    FakeAction::Ignore => {}
                }
            }
        });
        FakeServer {
            address,
            received: receiver,
            join,
        }
    }

    /// A handler that answers initialize with Godot's real capability shape and everything else
    /// with an empty body.
    fn handshake_handler(_message: &Value, _writer: &mut TcpStream) -> FakeAction {
        FakeAction::Result(json!({}))
    }

    fn recv_recorded(server: &FakeServer) -> Value {
        server
            .received
            .recv_timeout(Duration::from_secs(2))
            .expect("server received a message")
    }

    /// Drains recorded messages until one with `command` arrives, ignoring the rest.
    fn recv_command(server: &FakeServer, command: &str) -> Value {
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            if let Ok(message) = server.received.recv_timeout(Duration::from_millis(200))
                && message["command"] == command
            {
                return message;
            }
        }
        panic!("the server never received {command}");
    }

    fn connected_client(server: &FakeServer) -> DapClient {
        let mut client = DapClient::connect(server.address).expect("connect");
        client.initialize().expect("initialize");
        client
    }

    #[test]
    fn connects_and_completes_the_initialize_handshake() {
        let server = start_fake_server(|message, _writer| {
            match message["command"].as_str().unwrap_or_default() {
                "initialize" => FakeAction::Result(json!({
                    "supportsConfigurationDoneRequest": true,
                    "supportsEvaluateForHovers": true,
                    "supportsSetVariable": true,
                    "supportedChecksumAlgorithms": ["MD5", "SHA256"],
                    "supportsRestartRequest": true,
                    "supportsValueFormattingOptions": true,
                    "supportTerminateDebuggee": true,
                    "supportSuspendDebuggee": true,
                    "supportsTerminateRequest": true,
                    "supportsBreakpointLocationsRequest": true
                })),
                _ => FakeAction::Ignore,
            }
        });
        let mut client = DapClient::connect(server.address).expect("connect");
        let capabilities = client.initialize().expect("initialize");

        assert!(capabilities.supports_configuration_done_request);
        assert!(capabilities.supports_breakpoint_locations_request);
        assert!(capabilities.supports_restart_request);
        assert!(capabilities.supports_terminate_request);
        assert!(capabilities.support_terminate_debuggee);
        assert_eq!(
            capabilities.extra["supportedChecksumAlgorithms"],
            json!(["MD5", "SHA256"])
        );
        assert!(client.capabilities().supports_set_variable);

        let initialize = recv_recorded(&server);
        assert_eq!(initialize["seq"], 1);
        assert_eq!(initialize["type"], "request");
        assert_eq!(initialize["command"], "initialize");
        assert_eq!(initialize["arguments"]["clientID"], "gofer");
        assert_eq!(initialize["arguments"]["linesStartAt1"], true);
        assert_eq!(initialize["arguments"]["pathFormat"], "path");

        client.shutdown();
        let disconnect = recv_command(&server, "disconnect");
        assert_eq!(disconnect["arguments"]["terminateDebuggee"], true);
        server.join.join().expect("server thread");
    }

    #[test]
    fn refuses_a_non_loopback_transport() {
        let address: SocketAddr = "192.0.2.1:6006".parse().expect("address");
        let error = match DapClient::connect(address) {
            Ok(_) => panic!("a non-loopback transport must be refused"),
            Err(error) => error,
        };
        assert_eq!(error.code, "transport_not_loopback");
    }

    #[test]
    fn drives_the_godot_launch_sequence_with_a_deferred_launch_response() {
        let launch_seq = Arc::new(Mutex::new(None));
        let server_launch_seq = Arc::clone(&launch_seq);
        let server = start_fake_server(move |message, writer| {
            match message["command"].as_str().unwrap_or_default() {
                "initialize" => handshake_handler(message, writer),
                // Godot answers launch only once configurationDone spawns the game, and the
                // response keeps the launch request_seq.
                "launch" => {
                    *server_launch_seq.lock().expect("launch seq") =
                        Some(message["seq"].as_u64().expect("seq"));
                    FakeAction::Ignore
                }
                "configurationDone" => {
                    let seq = server_launch_seq
                        .lock()
                        .expect("launch seq")
                        .expect("launch arrived first");
                    let launch_reply = json!({
                        "seq": 900,
                        "type": "response",
                        "request_seq": seq,
                        "command": "launch",
                        "success": true
                    });
                    write_message(writer, &launch_reply).expect("write launch reply");
                    FakeAction::Result(json!({}))
                }
                _ => FakeAction::Result(json!({})),
            }
        });
        let mut client = DapClient::connect(server.address).expect("connect");
        client.initialize().expect("initialize");
        let script = PathBuf::from("/project/scripts/main.gd");

        // launch blocks until configurationDone, so it runs on its own thread.
        let client = Arc::new(client);
        let launch_handle = thread::spawn({
            let client = Arc::clone(&client);
            move || client.launch(Path::new("/project"), &["--headless".to_owned()])
        });
        // Let launch reach the server before configuration is marked done.
        let launch = recv_command(&server, "launch");
        let breakpoints = client
            .set_breakpoints(&script, &[4, 7])
            .expect("set breakpoints");
        assert!(
            breakpoints.is_empty(),
            "the canned handler sends an empty list"
        );
        client.configuration_done().expect("configuration done");
        launch_handle
            .join()
            .expect("launch thread")
            .expect("launch succeeds once configurationDone arrives");

        assert_eq!(launch["arguments"]["project"], "/project");
        assert_eq!(launch["arguments"]["scene"], "main");
        assert_eq!(launch["arguments"]["playArgs"], json!(["--headless"]));
        let set_breakpoints = recv_command(&server, "setBreakpoints");
        assert_eq!(
            set_breakpoints["arguments"]["source"]["path"],
            "/project/scripts/main.gd"
        );
        assert_eq!(
            set_breakpoints["arguments"]["breakpoints"],
            json!([{"line": 4}, {"line": 7}])
        );
        assert_eq!(set_breakpoints["arguments"]["sourceModified"], false);
        recv_command(&server, "configurationDone");
        client.shutdown();
        server.join.join().expect("server thread");
    }

    #[test]
    fn correlates_out_of_order_responses() {
        let server = start_fake_server(|message, writer| {
            match message["command"].as_str().unwrap_or_default() {
                "initialize" => handshake_handler(message, writer),
                // Answer threads first, then the stashed stackTrace with its older seq.
                "stackTrace" => {
                    let threads = json!({
                        "seq": 901,
                        "type": "response",
                        "request_seq": message["seq"].as_u64().expect("seq") + 1,
                        "command": "threads",
                        "success": true,
                        "body": {"threads": [{"id": 1, "name": "Main"}]}
                    });
                    write_message(writer, &threads).expect("write threads reply");
                    FakeAction::Result(json!({"stackFrames": [
                        {"id": 10, "name": "_tick", "line": 9, "column": 2,
                         "source": {"path": "/project/scripts/main.gd"}},
                        {"id": 11, "name": "_process", "line": 6, "column": 2}
                    ]}))
                }
                _ => FakeAction::Ignore,
            }
        });
        let client = connected_client(&server);

        let (trace_seq, trace_rx) = client
            .start_request("stackTrace", json!({"threadId": 1}))
            .expect("stack trace request");
        let (threads_seq, threads_rx) = client
            .start_request("threads", json!({}))
            .expect("threads request");
        assert_eq!(threads_seq, trace_seq + 1);

        let threads_body = client
            .await_response(threads_seq, &threads_rx, Duration::from_secs(2))
            .expect("threads response");
        let threads: Vec<DebugThread> =
            serde_json::from_value(threads_body["body"]["threads"].clone()).expect("threads");
        assert_eq!(threads[0].name, "Main");

        let trace_body = client
            .await_response(trace_seq, &trace_rx, Duration::from_secs(2))
            .expect("stack trace response");
        let frames: Vec<WireStackFrame> =
            serde_json::from_value(trace_body["body"]["stackFrames"].clone()).expect("frames");
        assert_eq!(frames.len(), 2);
        client.shutdown();
        server.join.join().expect("server thread");
    }

    #[test]
    fn maps_error_responses_with_the_adapter_details() {
        let server = start_fake_server(|message, writer| {
            match message["command"].as_str().unwrap_or_default() {
                "initialize" => handshake_handler(message, writer),
                "attach" => FakeAction::Error("not_running"),
                _ => FakeAction::Ignore,
            }
        });
        let client = connected_client(&server);

        let error = client.attach().expect_err("attach without a game");
        assert_eq!(error.code, "dap_server_error");
        assert!(error.message.contains("adapter says not_running"));
        assert!(error.message.contains("(not_running)"));
        assert_eq!(error.details["adapterMessage"], "not_running");
        assert_eq!(error.details["command"], "attach");
        assert_eq!(error.details["error"]["id"], 1);
        client.shutdown();
        server.join.join().expect("server thread");
    }

    #[test]
    fn times_out_a_silent_server_and_recovers() {
        let server = start_fake_server(|message, writer| {
            match message["command"].as_str().unwrap_or_default() {
                "initialize" => handshake_handler(message, writer),
                "threads" => FakeAction::Result(json!({"threads": [{"id": 1, "name": "Main"}]})),
                // stackTrace never gets an answer; a later request still does, proving one silent
                // request does not wedge the session.
                _ => FakeAction::Ignore,
            }
        });
        let client = connected_client(&server);

        let (seq, receiver) = client
            .start_request("stackTrace", json!({"threadId": 1}))
            .expect("stack trace request");
        let error = client
            .await_response(seq, &receiver, Duration::from_millis(150))
            .expect_err("timeout");
        assert_eq!(error.code, "request_timeout");
        assert!(error.retryable);

        let threads = client.threads().expect("session still works");
        assert_eq!(threads[0].id, MAIN_THREAD_ID);
        client.shutdown();
        server.join.join().expect("server thread");
    }

    #[test]
    fn reads_breakpoints_scopes_variables_and_evaluations() {
        let server = start_fake_server(|message, writer| {
            match message["command"].as_str().unwrap_or_default() {
                "initialize" => handshake_handler(message, writer),
                "setBreakpoints" => FakeAction::Result(json!({"breakpoints": [
                    {"id": 1, "verified": true, "line": 9,
                     "source": {"path": "/project/scripts/main.gd"}},
                    {"id": 2, "verified": false, "line": 12, "message": "not a statement"}
                ]})),
                // Godot answers with a `breakpoints` key where the specification says
                // `breakpointLocations`; the client accepts both.
                "breakpointLocations" => FakeAction::Result(json!({"breakpoints": [
                    {"line": 9, "endLine": 11}
                ]})),
                "scopes" => FakeAction::Result(json!({"scopes": [
                    {"name": "Locals", "presentationHint": "locals", "variablesReference": 100,
                     "expensive": false},
                    {"name": "Members", "presentationHint": "members", "variablesReference": 101,
                     "expensive": false},
                    {"name": "Globals", "presentationHint": "globals", "variablesReference": 102,
                     "expensive": false}
                ]})),
                "variables" => FakeAction::Result(json!({"variables": [
                    {"name": "amount", "value": "1", "type": "int", "variablesReference": 0},
                    {"name": "items", "value": "[1, 2]", "type": "Array",
                     "variablesReference": 200}
                ]})),
                "evaluate" => FakeAction::Result(json!({
                    "result": "3", "type": "int", "variablesReference": 0
                })),
                _ => FakeAction::Ignore,
            }
        });
        let client = connected_client(&server);
        let script = PathBuf::from("/project/scripts/main.gd");

        let breakpoints = client
            .set_breakpoints(&script, &[9, 12])
            .expect("set breakpoints");
        assert_eq!(breakpoints.len(), 2);
        assert!(breakpoints[0].verified);
        assert_eq!(breakpoints[0].line, Some(9));
        assert!(!breakpoints[1].verified);
        assert_eq!(breakpoints[1].message.as_deref(), Some("not a statement"));

        let locations = client.breakpoint_locations(&script, 9).expect("locations");
        assert_eq!(locations.len(), 1);
        assert_eq!(locations[0].line, 9);
        assert_eq!(locations[0].end_line, Some(11));

        let scopes = client.scopes(10).expect("scopes");
        assert_eq!(scopes.len(), 3);
        assert_eq!(scopes[0].name, "Locals");
        assert_eq!(scopes[0].presentation_hint.as_deref(), Some("locals"));
        assert_eq!(scopes[2].name, "Globals");

        let variables = client.variables(100).expect("variables");
        assert_eq!(variables[0].name, "amount");
        assert_eq!(variables[0].value_type.as_deref(), Some("int"));
        assert_eq!(variables[1].variables_reference, 200);

        let evaluate = client.evaluate("amount + 2", Some(10)).expect("evaluate");
        assert_eq!(evaluate.result, "3");
        assert_eq!(evaluate.value_type.as_deref(), Some("int"));
        let request = recv_command(&server, "evaluate");
        assert_eq!(request["arguments"]["expression"], "amount + 2");
        assert_eq!(request["arguments"]["frameId"], 10);
        client.shutdown();
        server.join.join().expect("server thread");
    }

    #[test]
    fn variables_retries_until_the_debuggee_dump_lands() {
        // Godot hands out scope references from the stack dump but rejects them until the
        // debuggee has answered the remote scope fetch that `scopes` only started.
        let attempts = Arc::new(Mutex::new(0u32));
        let server_attempts = Arc::clone(&attempts);
        let server = start_fake_server(move |message, writer| {
            match message["command"].as_str().unwrap_or_default() {
                "initialize" => handshake_handler(message, writer),
                "variables" => {
                    let mut attempts = server_attempts.lock().expect("attempts");
                    *attempts += 1;
                    if *attempts < 3 {
                        return FakeAction::Error("unknown");
                    }
                    FakeAction::Result(json!({"variables": [
                        {"name": "amount", "value": "1", "type": "int", "variablesReference": 0}
                    ]}))
                }
                _ => FakeAction::Ignore,
            }
        });
        let client = connected_client(&server);

        let variables = client.variables(100).expect("variables settle");
        assert_eq!(variables[0].name, "amount");
        assert_eq!(*attempts.lock().expect("attempts"), 3);
        client.shutdown();
        server.join.join().expect("server thread");
    }

    #[test]
    fn variables_surfaces_a_reference_that_never_settles() {
        let server = start_fake_server(|message, writer| {
            match message["command"].as_str().unwrap_or_default() {
                "initialize" => handshake_handler(message, writer),
                "variables" => FakeAction::Error("unknown"),
                _ => FakeAction::Ignore,
            }
        });
        let client = connected_client(&server);

        let started = Instant::now();
        let error = client
            .variables(999)
            .expect_err("a bad reference must surface");
        assert_eq!(error.code, "dap_server_error");
        assert!(
            started.elapsed() >= SETTLE_TIMEOUT,
            "the retry window must be exhausted first"
        );
        client.shutdown();
        server.join.join().expect("server thread");
    }

    #[test]
    fn writes_each_message_as_one_frame() {
        // Header and body in separate writes make Nagle hold the body until the peer's delayed
        // ACK, which costs tens of milliseconds on every single request.
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let address = listener.local_addr().expect("address");
        let receiver = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .expect("read timeout");
            let mut buffer = [0u8; 512];
            let read = stream.read(&mut buffer).expect("read");
            String::from_utf8_lossy(&buffer[..read]).into_owned()
        });
        let mut stream = TcpStream::connect(address).expect("connect");
        write_message(&mut stream, &json!({"seq": 1, "type": "request"})).expect("write");

        let frame = receiver.join().expect("receiver");
        let (header, body) = frame
            .split_once("\r\n\r\n")
            .expect("one frame, headers and body");
        assert_eq!(header, format!("Content-Length: {}", body.len()));
        assert_eq!(body, r#"{"seq":1,"type":"request"}"#);
    }

    #[test]
    fn parses_stack_frames_and_the_continue_answer() {
        let server = start_fake_server(|message, writer| {
            match message["command"].as_str().unwrap_or_default() {
                "initialize" => handshake_handler(message, writer),
                "stackTrace" => FakeAction::Result(json!({"stackFrames": [
                    {"id": 10, "name": "_tick", "line": 9, "column": 2,
                     "source": {"path": "/project/scripts/main.gd"}},
                    {"id": 11, "name": "_ready", "line": 5, "column": 1}
                ]})),
                "continue" => FakeAction::Result(json!({"allThreadsContinued": true})),
                _ => FakeAction::Result(json!({})),
            }
        });
        let client = connected_client(&server);

        let frames = client.stack_trace(MAIN_THREAD_ID).expect("stack trace");
        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0].name, "_tick");
        assert_eq!(
            frames[0].source_path.as_deref(),
            Some("/project/scripts/main.gd")
        );
        assert!(frames[1].source_path.is_none());
        assert_eq!(client.stack_depth(MAIN_THREAD_ID).expect("depth"), 2);

        assert!(client.continue_execution(MAIN_THREAD_ID).expect("continue"));
        client.pause(MAIN_THREAD_ID).expect("pause");
        client.next(MAIN_THREAD_ID).expect("next");
        client.step_in(MAIN_THREAD_ID).expect("step in");

        let continued = recv_command(&server, "continue");
        assert_eq!(continued["arguments"]["threadId"], 1);
        recv_command(&server, "pause");
        recv_command(&server, "next");
        recv_command(&server, "stepIn");
        client.shutdown();
        server.join.join().expect("server thread");
    }

    #[test]
    fn broadcasts_events_and_awaits_the_matching_stop() {
        let server = start_fake_server(|message, writer| {
            match message["command"].as_str().unwrap_or_default() {
                "initialize" => handshake_handler(message, writer),
                "continue" => {
                    for event in [
                        json!({"seq": 901, "type": "event", "event": "output",
                           "body": {"category": "stdout", "output": "tick\r\n"}}),
                        json!({"seq": 902, "type": "event", "event": "continued",
                           "body": {"threadId": 1}}),
                        // A stop on another thread must not satisfy a waiter on thread 1.
                        json!({"seq": 903, "type": "event", "event": "stopped",
                           "body": {"reason": "step", "threadId": 2}}),
                        json!({"seq": 904, "type": "event", "event": "stopped",
                           "body": {"reason": "breakpoint", "threadId": 1,
                                    "description": "Breakpoint", "allThreadsStopped": true}}),
                    ] {
                        write_message(writer, &event).expect("push event");
                    }
                    FakeAction::Result(json!({}))
                }
                _ => FakeAction::Ignore,
            }
        });
        let client = connected_client(&server);
        let events = client.subscribe_events();

        client.continue_execution(MAIN_THREAD_ID).expect("continue");
        let stop = client
            .await_stop(&events, MAIN_THREAD_ID, Duration::from_secs(2))
            .expect("await stop")
            .expect("a stop, not a termination");
        assert_eq!(stop.reason, "breakpoint");
        assert_eq!(stop.thread_id, Some(1));
        assert_eq!(stop.description.as_deref(), Some("Breakpoint"));
        assert!(stop.all_threads_stopped);
        client.shutdown();
        server.join.join().expect("server thread");
    }

    #[test]
    fn await_stop_reports_termination_as_none() {
        let server = start_fake_server(|message, writer| {
            match message["command"].as_str().unwrap_or_default() {
                "initialize" => handshake_handler(message, writer),
                "continue" => {
                    let event = json!({"seq": 901, "type": "event", "event": "terminated"});
                    write_message(writer, &event).expect("push terminated");
                    FakeAction::Result(json!({}))
                }
                _ => FakeAction::Ignore,
            }
        });
        let client = connected_client(&server);
        let events = client.subscribe_events();

        client.continue_execution(MAIN_THREAD_ID).expect("continue");
        let outcome = client
            .await_stop(&events, MAIN_THREAD_ID, Duration::from_secs(2))
            .expect("await stop");
        assert!(outcome.is_none());
        client.shutdown();
        server.join.join().expect("server thread");
    }

    /// A fake debuggee whose stack depth follows a scripted step counter: every `next` pushes a
    /// `stopped` step event, and `stackTrace` answers with as many frames as the depth says.
    fn stepping_server<F>(initial_depth: i64, mut depth_after_step: F) -> FakeServer
    where
        F: FnMut(u32, i64) -> i64 + Send + 'static,
    {
        let depth = Arc::new(Mutex::new(initial_depth));
        let steps = Arc::new(Mutex::new(0u32));
        start_fake_server(move |message, writer| {
            let depth = Arc::clone(&depth);
            let steps = Arc::clone(&steps);
            match message["command"].as_str().unwrap_or_default() {
                "initialize" => handshake_handler(message, writer),
                "next" => {
                    let mut steps = steps.lock().expect("steps");
                    *steps += 1;
                    let mut depth = depth.lock().expect("depth");
                    *depth = depth_after_step(*steps, *depth);
                    let event = json!({"seq": 900 + *steps, "type": "event", "event": "stopped",
                        "body": {"reason": "step", "threadId": 1}});
                    write_message(writer, &event).expect("push stopped");
                    FakeAction::Result(json!({}))
                }
                "stackTrace" => {
                    let depth = *depth.lock().expect("depth");
                    let frames: Vec<Value> = (0..depth)
                        .map(|id| json!({"id": id, "name": format!("frame{id}"), "line": 1, "column": 1}))
                        .collect();
                    FakeAction::Result(json!({"stackFrames": frames}))
                }
                _ => FakeAction::Ignore,
            }
        })
    }

    #[test]
    fn step_out_stops_once_the_stack_shrinks() {
        // Start at depth 2; the first two steps stay inside the frame, the third escapes.
        let server = stepping_server(2, |steps, _depth| if steps >= 3 { 1 } else { 2 });
        let client = connected_client(&server);

        let outcome = client.step_out(MAIN_THREAD_ID).expect("step out");
        let StepOutcome::SteppedOut { stop } = outcome else {
            panic!("expected a clean escape, got {outcome:?}");
        };
        assert_eq!(stop.reason, "step");
        client.shutdown();
        server.join.join().expect("server thread");
    }

    #[test]
    fn step_out_interrupts_on_a_breakpoint() {
        let server = start_fake_server(|message, writer| {
            match message["command"].as_str().unwrap_or_default() {
                "initialize" => handshake_handler(message, writer),
                "next" => {
                    let event = json!({"seq": 901, "type": "event", "event": "stopped",
                    "body": {"reason": "breakpoint", "threadId": 1, "hitBreakpointIds": [1]}});
                    write_message(writer, &event).expect("push stopped");
                    FakeAction::Result(json!({}))
                }
                "stackTrace" => FakeAction::Result(json!({"stackFrames": [
                    {"id": 1, "name": "_tick", "line": 9, "column": 1},
                    {"id": 2, "name": "_process", "line": 6, "column": 1}
                ]})),
                _ => FakeAction::Ignore,
            }
        });
        let client = connected_client(&server);

        let outcome = client.step_out(MAIN_THREAD_ID).expect("step out");
        let StepOutcome::Interrupted { stop } = outcome else {
            panic!("expected an interruption, got {outcome:?}");
        };
        assert_eq!(stop.reason, "breakpoint");
        client.shutdown();
        server.join.join().expect("server thread");
    }

    #[test]
    fn step_out_reports_termination() {
        let server = start_fake_server(|message, writer| {
            match message["command"].as_str().unwrap_or_default() {
                "initialize" => handshake_handler(message, writer),
                "next" => {
                    let event = json!({"seq": 901, "type": "event", "event": "terminated"});
                    write_message(writer, &event).expect("push terminated");
                    FakeAction::Result(json!({}))
                }
                "stackTrace" => FakeAction::Result(json!({"stackFrames": [
                    {"id": 1, "name": "_tick", "line": 9, "column": 1},
                    {"id": 2, "name": "_process", "line": 6, "column": 1}
                ]})),
                _ => FakeAction::Ignore,
            }
        });
        let client = connected_client(&server);

        let outcome = client.step_out(MAIN_THREAD_ID).expect("step out");
        assert_eq!(outcome, StepOutcome::Terminated);
        client.shutdown();
        server.join.join().expect("server thread");
    }

    #[test]
    fn step_out_enforces_the_safety_limit() {
        // The depth never shrinks: a function stuck in a loop must not spin the client forever.
        let server = stepping_server(2, |_steps, _depth| 2);
        let client = connected_client(&server);

        let error = client.step_out(MAIN_THREAD_ID).expect_err("safety limit");
        assert_eq!(error.code, "step_out_limit");
        assert_eq!(error.details["limit"], json!(MAX_STEP_OUT_STEPS));
        client.shutdown();
        server.join.join().expect("server thread");
    }

    #[test]
    fn restart_nests_the_last_launch_arguments() {
        let server = start_fake_server(|message, writer| {
            match message["command"].as_str().unwrap_or_default() {
                "initialize" => handshake_handler(message, writer),
                _ => FakeAction::Result(json!({})),
            }
        });
        let client = connected_client(&server);
        client
            .launch(Path::new("/project"), &["--headless".to_owned()])
            .expect("launch");
        client.restart().expect("restart");
        client.terminate().expect("terminate");
        client.disconnect(false).expect("disconnect");

        let restart = recv_command(&server, "restart");
        assert_eq!(restart["arguments"]["arguments"]["project"], "/project");
        assert_eq!(
            restart["arguments"]["arguments"]["playArgs"],
            json!(["--headless"])
        );
        recv_command(&server, "terminate");
        let disconnect = recv_command(&server, "disconnect");
        assert_eq!(disconnect["arguments"]["terminateDebuggee"], false);
        client.shutdown();
        server.join.join().expect("server thread");
    }

    #[test]
    fn answers_reverse_requests_with_failure() {
        let server = start_fake_server(|message, writer| {
            match message["command"].as_str().unwrap_or_default() {
                "initialize" => {
                    // Push a reverse request before answering initialize.
                    let reverse = json!({"seq": 950, "type": "request", "command": "runInTerminal",
                        "arguments": {"kind": "integrated", "title": "game", "cwd": "/project",
                                      "args": []}});
                    write_message(writer, &reverse).expect("push reverse request");
                    handshake_handler(message, writer)
                }
                _ => FakeAction::Ignore,
            }
        });
        let mut client = DapClient::connect(server.address).expect("connect");
        client.initialize().expect("initialize");

        let mut reply = recv_recorded(&server);
        while reply["type"] != "response" {
            reply = recv_recorded(&server);
        }
        assert_eq!(reply["type"], "response");
        assert_eq!(reply["request_seq"], 950);
        assert_eq!(reply["command"], "runInTerminal");
        assert_eq!(reply["success"], false);
        assert!(reply["seq"].as_u64().expect("reply seq") >= 2);
        client.shutdown();
        server.join.join().expect("server thread");
    }

    #[test]
    fn reports_closed_transport_to_pending_callers() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let address = listener.local_addr().expect("address");
        let server = thread::spawn(move || {
            let (stream, _) = listener.accept().expect("accept");
            // Read the initialize request, then hang up without answering.
            let mut reader = BufReader::new(stream);
            let _ = read_message(&mut reader);
        });
        let mut client = DapClient::connect(address).expect("connect");
        let error = client.initialize().expect_err("server hung up");
        assert_eq!(error.code, "transport_closed");
        assert!(error.retryable);
        server.join().expect("server");
    }

    #[test]
    fn rejects_oversized_payloads() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let address = listener.local_addr().expect("address");
        let sender = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            let header = format!("Content-Length: {}\r\n\r\n", MAX_MESSAGE_BYTES + 1);
            stream.write_all(header.as_bytes()).expect("write header");
            // Keep the socket open until the reader has rejected the frame.
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .expect("read timeout");
            let mut sink = [0u8; 1];
            let _ = stream.read(&mut sink);
        });
        let stream = TcpStream::connect(address).expect("connect");
        let mut reader = BufReader::new(stream);
        let error = read_message(&mut reader).expect_err("oversized frame");
        assert_eq!(error.code, "payload_too_large");
        sender.join().expect("sender");
    }

    #[test]
    fn reads_frames_with_extra_headers_and_skips_stray_blanks() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let address = listener.local_addr().expect("address");
        let sender = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            let body = serde_json::to_vec(&json!({
                "seq": 1, "type": "event", "event": "output", "body": {}
            }))
            .expect("body");
            let frame = format!(
                "\r\nContent-Type: application/debugadapter+json; charset=utf-8\r\ncontent-length: {}\r\n\r\n",
                body.len()
            );
            stream.write_all(frame.as_bytes()).expect("write headers");
            stream.write_all(&body).expect("write body");
            stream.flush().expect("flush");
        });
        let stream = TcpStream::connect(address).expect("connect");
        let mut reader = BufReader::new(stream);
        let message = read_message(&mut reader).expect("message").expect("some");
        assert_eq!(message["event"], "output");
        sender.join().expect("sender");
    }

    #[test]
    fn parses_stopped_details_and_step_outcomes() {
        let stop = StoppedDetails::from_event_body(&json!({
            "reason": "exception",
            "threadId": 1,
            "description": "Exception",
            "text": "Division by zero"
        }))
        .expect("stopped body");
        assert_eq!(stop.reason, "exception");
        assert_eq!(stop.text.as_deref(), Some("Division by zero"));

        assert!(StoppedDetails::from_event_body(&Value::Null).is_none());
        assert!(StoppedDetails::from_event_body(&json!([])).is_none());

        // The tagged outcome crosses to the renderer as a discriminated union.
        let serialized = serde_json::to_value(StepOutcome::SteppedOut { stop: stop.clone() })
            .expect("serialize outcome");
        assert_eq!(serialized["kind"], "steppedOut");
        assert_eq!(serialized["stop"]["reason"], "exception");
        let serialized = serde_json::to_value(StepOutcome::Terminated).expect("serialize");
        assert_eq!(serialized, json!({"kind": "terminated"}));
    }
}

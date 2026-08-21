//! One agent turn: the worker that runs it, the tools it calls, and what it remembers afterwards.
//!
//! Split out of `lib.rs`, where the whole runtime sat among the fifty-odd command registrations it
//! is reached through. Every other concern in this crate has a module; this one did not, so the
//! crate's largest file was where you landed for anything.
//!
//! The command surface stays in `lib.rs` and delegates here. What crosses the seam is a request, a
//! stream channel, and a process spawner — which is what lets the acceptance suite run a real turn
//! against a real editor without a window.

use crate::command_error::CommandError;
use crate::process::{ProcessSpawner, SystemProcessSpawner};
use crate::settings::AiSettings;
use crate::storage::{ProjectStorage, StoredAttachment};
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Runtime};

const AI_EVENT_PREFIX: &str = "GOFER_AI_EVENT:";
/// The worker's half of the duplex channel: agent events keep their prefix, tool requests get
/// their own, and anything unprefixed on stdout stays diagnostic output rather than protocol.
const AI_TOOL_PREFIX: &str = "GOFER_AI_TOOL:";
const AI_CREDENTIAL_PREFIX: &str = "GOFER_AI_CREDENTIAL:";

const MAX_CHAT_ATTACHMENT_BYTES: usize = 10 * 1024 * 1024;
const MAX_CHAT_ATTACHMENT_BASE64_BYTES: usize = MAX_CHAT_ATTACHMENT_BYTES.div_ceil(3) * 4;
const MAX_CHAT_MESSAGES: usize = 200;
const MAX_CHAT_MESSAGE_BYTES: usize = 256 * 1024;
const MAX_CHAT_TEXT_BYTES: usize = 4 * 1024 * 1024;
const MAX_AGENT_MESSAGES_BYTES: usize = 8 * 1024 * 1024;

/// Admits one provider operation at a time: an AI turn, or a ChatGPT sign-in. Never both.
///
/// One flag rather than two, because the two cannot overlap. A sign-in rewrites the credential an
/// in-flight turn is refreshing, and a turn holds the worker the sign-in would have to talk to.
static AI_PROVIDER_OPERATION_RUNNING: AtomicBool = AtomicBool::new(false);
static AI_REQUEST_CANCELLED: AtomicBool = AtomicBool::new(false);
static ACTIVE_AI_REQUEST_ID: AtomicU64 = AtomicU64::new(0);
type SharedChildProcess = Arc<Mutex<Box<dyn crate::process::ChildProcess>>>;
static AI_CHILD: Mutex<Option<SharedChildProcess>> = Mutex::new(None);
/// The stream the running turn writes to. Held here so that `cancel_ai_request` — a command of its
/// own, with no channel of its own — can report the abort down the same ordered stream the deltas
/// rode, rather than out of band where it could arrive before the text it ends.
static AI_STREAM: Mutex<Option<tauri::ipc::Channel<AiStreamPayload>>> = Mutex::new(None);

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChatMessageInput {
    sender: ChatSender,
    text: String,
    timestamp: u64,
    #[serde(default)]
    attachments: Vec<ChatAttachment>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChatAttachment {
    id: String,
    name: String,
    mime_type: String,
    size: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChatAttachmentUpload {
    attachment: ChatAttachment,
    data: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiWorkerImage {
    pub(crate) data: String,
    pub(crate) mime_type: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiWorkerMessage {
    pub(crate) sender: ChatSender,
    pub(crate) text: String,
    pub(crate) timestamp: u64,
    pub(crate) images: Vec<AiWorkerImage>,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ChatSender {
    User,
    Assistant,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChatRequest {
    request_id: u64,
    task_id: Option<String>,
    messages: Vec<ChatMessageInput>,
    #[serde(default)]
    agent_messages: Option<serde_json::Value>,
    /// Set when this turn replaces one that already ran. The worker takes the failed prompt and
    /// its half-finished work back off the transcript before asking again.
    #[serde(default)]
    is_retry: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiWorkerRequest {
    pub(crate) settings: AiSettings,
    pub(crate) api_key: Option<String>,
    /// The Brave Search key, when the user has set one. Absent is ordinary: the two other engines
    /// need no key, and `web_search` says so itself when Brave is chosen without one.
    pub(crate) brave_api_key: Option<String>,
    pub(crate) oauth_credential: Option<serde_json::Value>,
    /// The prompt cache key, which the provider sends so the server can route an ask back to the
    /// machine already holding this story's prefix. The task, not the turn: what a turn re-sends is
    /// the system prompt, the tool catalog and the transcript, and all three are the task's.
    pub(crate) session_id: Option<String>,
    pub(crate) workspace_path: String,
    /// The domain tools the worker registers. Generated from the router's own catalog, so the
    /// tools the model is offered and the operations Rust will accept cannot drift apart.
    pub(crate) tools: &'static [crate::ai_tools::ToolDomain],
    /// Which job this worker was started to do, and everything that belongs to that job alone.
    /// Flattened, so `mode` and its fields sit at the top of the request the way the rest do.
    #[serde(flatten)]
    pub(crate) job: WorkerJob,
}

/// The two things the AI worker can be started for, and what each of them carries.
///
/// A chat turn carries a conversation and answers into it. A brief carries one ask and produces a
/// specification, running four phases as delegations without ever building a parent agent. They
/// share the process, the tool channel and the event stream, and nothing else.
///
/// The turn's own five fields live here rather than beside the shared ones. A brief used to fill
/// every one of them with an empty value, and a reader of the request could not tell which fields
/// belonged to which mode: two doc comments 340 lines apart said opposite things about
/// `system_prompt`, and the one that was wrong was only harmless because the brief's host loop
/// never read it.
/// `rename_all_fields`, not `rename_all` alone.
///
/// `rename_all` on an enum renames the *variants*; the fields inside a struct variant keep the
/// names Rust gave them. Every other request type here is a struct, where `rename_all` does rename
/// the fields, so moving the turn's five fields into a variant silently renamed four of them back
/// to snake_case on the wire — and the worker reads `agentMessages`, `isRetry`, `memoryContext` and
/// `systemPrompt`. Nothing failed: JavaScript answers `undefined` for a key that is not there, and
/// every one of the four has a defaulting branch behind it. The turn ran with no transcript, no
/// memory, no system prompt, and `isRetry` false forever.
#[derive(Clone, Debug, Serialize)]
#[serde(
    tag = "mode",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum WorkerJob {
    Turn {
        messages: Vec<AiWorkerMessage>,
        agent_messages: Option<serde_json::Value>,
        is_retry: bool,
        /// What the project remembers that bears on this ask. See `project_memory`.
        memory_context: Option<String>,
        /// The whole system prompt, sent as it stands.
        ///
        /// `None` means the shipped one, which [`run_ai_worker_with`] fills in — so an acceptance
        /// suite or a test that builds a request without a prompt still runs the agent Gofer
        /// ships. It is an `Option` rather than an empty string because "I have none" and "this
        /// one, which happens to be empty" are different things to say, and only one of them is
        /// ever meant.
        system_prompt: Option<String>,
    },
    Brief {
        /// The raw ask, as the user typed it when they made the task.
        prompt: String,
        /// The pictures the ask came with, if any.
        ///
        /// Only the phase that reads the raw ask is shown them; every phase after it reads that
        /// phase's text. That is the whole of the plumbing, and it is enough: a screenshot is
        /// something the ask is ABOUT, so the worker sharpening the ask is the one that has to see
        /// it, and what it writes down is what the rest of the run works from.
        images: Vec<AiWorkerImage>,
        /// The project's tracked files, so four workers do not each spend steps discovering them.
        inventory: Option<String>,
    },
    /// One stored memory, put to a read-only child that says whether it is still true.
    ///
    /// The whole memory travels rather than its id. The worker has no database handle — nothing in
    /// Node does — and reading the row here is also what refuses a judgement of a memory that was
    /// deleted between the click and the spawn.
    Judge {
        memory_id: String,
        memory: JudgedMemory,
    },
}

/// The memory a judgement is about, as the worker is given it.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct JudgedMemory {
    pub id: String,
    pub content: String,
    /// What the path check already settled, so the child does not spend steps rediscovering it.
    pub anchors: Vec<crate::project_memory::MemoryAnchor>,
}

impl WorkerJob {
    /// The phase outputs this job writes, or none for a turn.
    fn is_brief(&self) -> bool {
        matches!(self, Self::Brief { .. })
    }

    /// Which memory this job is judging, or none for every other job.
    fn judged_memory(&self) -> Option<&str> {
        match self {
            Self::Judge { memory_id, .. } => Some(memory_id),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiStreamPayload {
    request_id: u64,
    event: serde_json::Value,
}

/// One AI turn: the thing that is running, and everything that has to be put back when it stops.
///
/// A turn was eight process-wide values across three modules, and the order they moved in was
/// written out four times — a guard that reset five of them, an open and a close inside the worker
/// loop, a cancellation command that did a fourth ordering of its own, and an acceptance harness
/// that re-enacted the lifecycle by hand because there was no turn to enter. What bound them was
/// not in any signature: `approvals`' interface included "someone opens the gate when a turn starts
/// and cancels every prompt when it ends, in that order relative to joining the tool threads", and
/// nothing said so but a comment at one of the call sites.
///
/// So the gate was left open on every error path between the two. `take_stdin`, `take_stdout`,
/// `take_stderr`, serializing the request, writing it, and locking the child all return `Err`
/// between `open()` and `cancel_all()`, and the guard could not close what it did not know about.
/// A gate left open is a prompt registered into a turn that has already ended, waiting out its
/// whole timeout for an agent that is gone.
///
/// It is one value now, and ending is one `Drop`. This is what `end_session` already is for the
/// editor: an order, held in one place, rather than a habit several functions have.
///
/// `cancel::CANCELLED_TURN` is deliberately not reset when a turn *ends*. That module identifies
/// turns rather than flagging them, precisely so no reset has to race the tool threads still
/// reading it. A turn that *begins* under an id that was already stopped is a different question,
/// and is cleared — see `cancel::clear_if_cancelled`.
pub(crate) struct AiTurn {
    request_id: u64,
    _provider_operation: AiProviderOperation,
}

pub(crate) struct AiProviderOperation;

impl Drop for AiProviderOperation {
    fn drop(&mut self) {
        AI_PROVIDER_OPERATION_RUNNING.store(false, Ordering::Release);
    }
}

pub(crate) fn begin_provider_operation() -> Result<AiProviderOperation, String> {
    AI_PROVIDER_OPERATION_RUNNING
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .map(|_| AiProviderOperation)
        .map_err(|_| "Another AI response or ChatGPT login is already in progress".to_owned())
}

impl AiTurn {
    /// Begins a turn, or refuses because one is already running.
    ///
    /// Everything a turn owns is taken here, so every later failure — including one before the
    /// worker is even spawned — unwinds through [`Drop`] rather than past it.
    pub(crate) fn begin(
        request_id: u64,
        stream: tauri::ipc::Channel<AiStreamPayload>,
    ) -> Result<Self, CommandError> {
        // A turn already running is a state, not a fault: the renderer draws it as the composer
        // being busy rather than as a failed request, which is what the code is for.
        let provider_operation = begin_provider_operation()
            .map_err(|message| CommandError::new("ai_request_in_progress", message).retryable())?;
        // Held from here on, so a failure below puts the running flag back.
        let turn = Self {
            request_id,
            _provider_operation: provider_operation,
        };
        ACTIVE_AI_REQUEST_ID.store(request_id, Ordering::Release);
        AI_REQUEST_CANCELLED.store(false, Ordering::Release);
        // The renderer mints the id and can start counting again without this process restarting.
        // A turn that inherited a stopped turn's id had every tool call refused as cancelled — the
        // reachability pass named all eleven and stopped the turn before the model was asked.
        crate::cancel::clear_if_cancelled(request_id);
        // Approvals belong to a turn: the gate opens with it and closes with it, so a gated tool
        // call always has an agent waiting for its answer, and a prompt that arrives after the end
        // is refused rather than left waiting.
        crate::approvals::open();
        // And so do questions, for the same reason and on the same schedule. Two gates rather than
        // one because they are two registries — an approval and a question are different answers —
        // but there is no run in which one of them should be open and the other shut.
        crate::ask::open_user_prompts();
        *AI_STREAM
            .lock()
            .map_err(|_| CommandError::new("lock_poisoned", "The AI stream lock is poisoned"))? =
            Some(stream);
        Ok(turn)
    }

    pub(crate) fn request_id(&self) -> u64 {
        self.request_id
    }

    /// The stream this turn's events ride, or `None` if the lock is poisoned.
    fn stream(&self) -> Option<tauri::ipc::Channel<AiStreamPayload>> {
        AI_STREAM.lock().ok()?.clone()
    }

    /// Records the worker process, so a cancellation can reach it.
    fn register_child(&self, child: SharedChildProcess) -> Result<(), String> {
        *AI_CHILD
            .lock()
            .map_err(|_| "The AI process lock is poisoned".to_owned())? = Some(child);
        Ok(())
    }

    fn is_cancelled(&self) -> bool {
        AI_REQUEST_CANCELLED.load(Ordering::Acquire)
    }

    /// Closes the gate before the tool threads are joined.
    ///
    /// The join is what keeps a tool that outlived the worker from writing into the next turn's
    /// channel, and closing the gate first is what makes it finite. `Drop` closes it too — this is
    /// the one place the *order* matters rather than the fact.
    fn close_gate_before_draining(&self) {
        crate::approvals::cancel_all();
        crate::ask::cancel_user_prompts();
    }

    /// Marks this turn cancelled, for the tests that drive the worker's cancelled exit directly.
    #[cfg(test)]
    fn mark_cancelled(&self, cancelled: bool) {
        AI_REQUEST_CANCELLED.store(cancelled, Ordering::Release);
    }
}

impl Drop for AiTurn {
    fn drop(&mut self) {
        // First, because it is the one that was being missed: no gated call may outlive the agent
        // that asked for it, whichever way the turn ended.
        crate::approvals::cancel_all();
        crate::ask::cancel_user_prompts();
        ACTIVE_AI_REQUEST_ID.store(0, Ordering::Release);
        AI_REQUEST_CANCELLED.store(false, Ordering::Release);
        if let Ok(mut active) = AI_CHILD.lock() {
            *active = None;
        }
        if let Ok(mut stream) = AI_STREAM.lock() {
            *stream = None;
        }
        // The flag that admits the next turn is `_provider_operation`, and a field is dropped after
        // the body that owns it: it is released once everything it would collide with is back.
    }
}

/// Streams one turn of the conversation.
///
/// The deltas ride a channel rather than an event: they are high-rate, they are tied to this one
/// invocation, and text assembled out of order is corrupt text.
pub(crate) async fn run_turn(
    app: AppHandle,
    request: ChatRequest,
    stream: tauri::ipc::Channel<AiStreamPayload>,
) -> Result<(), CommandError> {
    let turn = AiTurn::begin(request.request_id, stream)?;
    tauri::async_runtime::spawn_blocking(move || {
        // Moved in, so the turn ends when this closure does — however it does.
        let turn = turn;
        validate_agent_messages(&request.agent_messages)?;
        let messages = hydrate_chat_messages(&app, validate_chat_messages(request.messages)?)?;
        let prompt = messages
            .last()
            .map(|message| message.text.clone())
            .unwrap_or_default();
        let settings = crate::settings::read_settings(&app)?;
        let api_key = crate::settings::ai_worker_api_key()?;
        let oauth_credential = crate::settings::stored_chatgpt_credential()?;
        let brave_api_key = crate::settings::stored_brave_api_key()?;
        let storage = crate::workspace::project_storage(&app)?;
        let workspace_path = storage
            .tasks()
            .agent_workspace()
            .map_err(|failure| failure.message)?
            .display()
            .to_string();
        let task_id = request.task_id;
        let memory_context =
            crate::project_memory::retrieve_memory_context(&storage, &prompt, task_id.as_deref())
                .ok();
        let completion = run_ai_worker(
            &app,
            &turn,
            AiWorkerRequest {
                settings: settings.ai,
                api_key,
                brave_api_key,
                oauth_credential,
                session_id: task_id.clone(),
                workspace_path,
                tools: crate::ai_tools::CATALOG,
                job: WorkerJob::Turn {
                    messages,
                    agent_messages: request.agent_messages,
                    is_retry: request.is_retry,
                    memory_context,
                    system_prompt: Some(crate::agent_prompt::resolve(
                        storage
                            .project()
                            .read_agent_prompt()
                            .map_err(|failure| failure.message)?
                            .as_deref(),
                        crate::ai_tools::CATALOG,
                    )),
                },
            },
        )?;
        let _ = crate::project_memory::remember_completed_turn(
            &storage,
            task_id.as_deref(),
            &prompt,
            &completion,
        );
        Ok(())
    })
    .await
    .map_err(|error| format!("AI response task failed: {error}"))?
    .map_err(CommandError::coded("ai_request_failed"))
}

/// What starting a brief needs: which task it is for, and the ask it starts from.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BriefRequest {
    pub request_id: u64,
    pub task_id: String,
    pub prompt: String,
    /// The pictures the ask was written beside, already saved by `save_chat_attachment`.
    ///
    /// Defaulted, because a plan without one is the ordinary case and every request written before
    /// this field existed means exactly that.
    #[serde(default)]
    pub attachments: Vec<ChatAttachment>,
}

/// What judging a memory needs: which turn it runs as, and which memory it is about.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct JudgeRequest {
    pub request_id: u64,
    pub memory_id: String,
}

/// Puts one stored memory to a read-only child and files what it says.
///
/// It begins an `AiTurn` for the same two reasons a brief does, and neither is a convenience. The
/// turn is what Stop can reach, because cancelling kills whatever `register_child` registered; and
/// it is what holds the single provider operation, so a judgement cannot run beside a chat turn on
/// the one connection or have the shared checkout switched out from under the child reading it.
///
/// The verdict is not returned by the worker to here — it crosses on `judge-verdict` and is filed
/// by [`handle_judge_event`], which is the only side that survives the worker being killed. What
/// this answers with is the memory read back afterwards, so the window draws what was stored rather
/// than what was reported.
pub(crate) async fn run_judge(
    app: AppHandle,
    request: JudgeRequest,
    stream: tauri::ipc::Channel<AiStreamPayload>,
) -> Result<crate::project_memory::CheckedMemory, CommandError> {
    let turn = AiTurn::begin(request.request_id, stream)?;
    tauri::async_runtime::spawn_blocking(move || {
        let turn = turn;
        let settings = crate::settings::read_settings(&app)?;
        let api_key = crate::settings::ai_worker_api_key()?;
        let oauth_credential = crate::settings::stored_chatgpt_credential()?;
        let storage = crate::workspace::project_storage(&app)?;
        let workspace_path = storage
            .tasks()
            .agent_workspace()
            .map_err(|failure| failure.message)?
            .display()
            .to_string();
        // Read here rather than in the worker, which holds no database. It is also what refuses a
        // memory deleted between the click and the spawn, before a model is paid for.
        let record = storage
            .memory()
            .get(&request.memory_id)
            .map_err(|failure| failure.message)?
            .ok_or_else(|| "That memory is no longer stored".to_owned())?;
        let snapshot = crate::files::scan(std::path::Path::new(&workspace_path));
        let index = crate::project_memory::basename_index(&snapshot);
        let checked = crate::project_memory::check_memory(record, Some(&snapshot), Some(&index));

        let outcome = run_ai_worker(
            &app,
            &turn,
            AiWorkerRequest {
                settings: settings.ai,
                api_key,
                // The child holds `read` and `bash`. Neither reaches the web, so a search key it
                // cannot use is a key with no reason to be in the request.
                brave_api_key: None,
                oauth_credential,
                // No cache key. A judgement is one question about one row, so there is no prefix a
                // later ask would reuse, and keying it per memory would fragment the cache the
                // conversation depends on.
                session_id: None,
                workspace_path,
                tools: crate::ai_tools::CATALOG,
                job: WorkerJob::Judge {
                    memory_id: request.memory_id.clone(),
                    memory: JudgedMemory {
                        id: checked.memory.id.clone(),
                        content: checked.memory.content.clone(),
                        anchors: checked.anchors,
                    },
                },
            },
        );

        // A worker that broke before its own handler ran emits nothing, and a row left spinning is
        // the failure the brief's ending contract was written for. Said here so every ending is
        // said once, whether or not the worker lived long enough to say it.
        if outcome.is_err() || turn.is_cancelled() {
            let ending = if turn.is_cancelled() {
                serde_json::json!({"type": "judge-stopped", "memoryId": request.memory_id})
            } else {
                serde_json::json!({
                    "type": "judge-failed",
                    "memoryId": request.memory_id,
                    "reason": outcome.as_ref().err().map_or("", String::as_str),
                })
            };
            let _ = app.emit_to(crate::ask::MAIN_WINDOW, JUDGE_EVENT, ending);
        }
        outcome?;

        let record = storage
            .memory()
            .get(&request.memory_id)
            .map_err(|failure| failure.message)?
            .ok_or_else(|| "That memory is no longer stored".to_owned())?;
        Ok(crate::project_memory::check_memory(
            record,
            Some(&snapshot),
            Some(&index),
        ))
    })
    .await
    .map_err(|error| format!("The memory judgement failed: {error}"))?
    .map_err(CommandError::coded("memory_judge_failed"))
}

/// Runs the four phases that produce a task's brief.
///
/// It begins an `AiTurn` like an ordinary turn does, and that is the load-bearing part rather than a
/// convenience. The turn is what Stop can reach — cancellation kills whatever `register_child`
/// registered — and it is what holds the single provider operation, which is what stops the user
/// switching tasks and moving the one shared checkout out from under four research workers that are
/// reading it.
///
/// A brief's own progress does not ride the stream channel; see [`handle_brief_event`]. The channel
/// is still required, because a turn is what owns it.
pub(crate) async fn run_brief(
    app: AppHandle,
    request: BriefRequest,
    stream: tauri::ipc::Channel<AiStreamPayload>,
) -> Result<(), CommandError> {
    let prompt = request.prompt.trim().to_owned();
    if prompt.is_empty() {
        return Err(CommandError::new(
            "brief_without_prompt",
            "A planned task needs something to plan.",
        ));
    }
    // Held to the same bound a chat message is, and refused before a turn is begun: a request the
    // run cannot serve should not first take the one provider operation away from everything else.
    validate_brief_attachments(&request.attachments)
        .map_err(CommandError::coded("brief_attachments_invalid"))?;
    let turn = AiTurn::begin(request.request_id, stream)?;
    tauri::async_runtime::spawn_blocking(move || {
        let turn = turn;
        let settings = crate::settings::read_settings(&app)?;
        let api_key = crate::settings::ai_worker_api_key()?;
        let oauth_credential = crate::settings::stored_chatgpt_credential()?;
        let brave_api_key = crate::settings::stored_brave_api_key()?;
        let storage = crate::workspace::project_storage(&app)?;
        let workspace_path = storage
            .tasks()
            .agent_workspace()
            .map_err(|failure| failure.message)?
            .display()
            .to_string();
        let inventory_root = workspace_path.clone();
        let images = hydrate_chat_attachments(&app, &request.attachments)?;

        // Opened before the worker starts, so a run killed at its first phase still leaves a row
        // saying what was asked and how far it got.
        storage
            .tasks()
            .start_brief(&request.task_id, &prompt)
            .map_err(|failure| failure.message)?;

        let outcome = run_ai_worker(
            &app,
            &turn,
            // The phases carry their own instructions, in full, and none of them is the chat
            // agent, so a brief carries no system prompt at all — nor a transcript, nor project
            // memory. It used to fill all five with empty values and be sent the shipped agent
            // prompt anyway, which would have put a Godot editor's tool guidance in front of a
            // worker listing file paths if the host loop had ever read it.
            AiWorkerRequest {
                settings: settings.ai,
                api_key,
                brave_api_key,
                oauth_credential,
                session_id: Some(request.task_id.clone()),
                workspace_path,
                tools: crate::ai_tools::CATALOG,
                job: WorkerJob::Brief {
                    prompt,
                    images,
                    inventory: crate::git::tracked_files(std::path::Path::new(&inventory_root)),
                },
            },
        );

        // A run that reported its own ending has already recorded it, and `finish_brief` only moves
        // a row that is still running — so everything below closes the rows nothing reported.
        //
        // "Done" means there is a specification, and nothing else. A worker exiting without an error
        // is NOT the same fact: a run cancelled mid-phase is killed, which the process reports as an
        // ordinary end, so keying on the exit alone recorded a stopped run and a run that never
        // reached compose as `done` — a row claiming a brief that finished, with no spec in it.
        let finished = storage
            .tasks()
            .read_brief(&request.task_id)
            .and_then(|brief| brief.spec)
            .is_some_and(|spec| !spec.trim().is_empty());
        let tasks = storage.tasks();
        let phase = tasks
            .read_brief(&request.task_id)
            .map_or_else(|| "compose".to_owned(), |brief| brief.phase);
        const WORDLESS: &str = "the plan ended before it wrote a specification";
        let (status, reason) = match &outcome {
            Err(reason) => ("failed", Some(reason.as_str())),
            Ok(_) if finished => ("done", None),
            // The worker ended without a specification and without saying why. A cancellation is the
            // ordinary way that happens and is the user's doing; anything else is not.
            Ok(_) if turn.is_cancelled() => ("stopped", None),
            Ok(_) => ("failed", Some(WORDLESS)),
        };
        tasks.finish_brief(&request.task_id, status, reason);

        // The window is told how it ended, and not only when the worker said so. A killed worker,
        // or one that broke before its own handler ran, emits nothing — and a panel with no ending
        // sits on a spinner and then unmounts, taking the way out of a failed plan with it. The
        // renderer keeps the first ending it hears, so saying it twice costs nothing.
        if status != "done" {
            let ending = if status == "stopped" {
                serde_json::json!({"type": "brief-stopped", "phase": phase})
            } else {
                serde_json::json!({
                    "type": "brief-failed",
                    "phase": phase,
                    "reason": reason.unwrap_or(WORDLESS),
                })
            };
            let _ = app.emit_to(crate::ask::MAIN_WINDOW, BRIEF_EVENT, ending);
        }
        outcome.map(|_| ())
    })
    .await
    .map_err(|error| format!("The brief task failed: {error}"))?
    .map_err(CommandError::coded("brief_failed"))
}

// coverage-critical-start: attachment
pub(crate) fn save_chat_attachment_in(
    storage: &ProjectStorage,
    request: ChatAttachmentUpload,
) -> Result<(), CommandError> {
    validate_chat_attachment(&request.attachment)
        .map_err(CommandError::coded("attachment_not_stored"))?;
    if request.data.len() > MAX_CHAT_ATTACHMENT_BASE64_BYTES {
        return Err(CommandError::new(
            "attachment_too_large",
            "Images cannot be larger than 10 MiB",
        ));
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&request.data)
        .map_err(|error| {
            CommandError::new(
                "attachment_not_stored",
                format!("The attachment data is not valid base64: {error}"),
            )
        })?;
    if bytes.len() as u64 != request.attachment.size {
        return Err(CommandError::new(
            "attachment_not_stored",
            "The attachment size does not match its contents",
        ));
    }
    storage
        .chats()
        .save_attachment(&request.attachment.as_stored(), &bytes)
}
// coverage-critical-end: attachment

pub(crate) fn read_chat_attachment_in(
    storage: &ProjectStorage,
    attachment: ChatAttachment,
) -> Result<String, CommandError> {
    validate_chat_attachment(&attachment).map_err(CommandError::coded("attachment_unreadable"))?;
    let bytes = storage.chats().read_attachment(&attachment.as_stored())?;
    Ok(format!(
        "data:{};base64,{}",
        attachment.mime_type,
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

// coverage-critical-start: cancellation
pub(crate) fn cancel_ai_request_with(request_id: u64) -> Result<bool, String> {
    if ACTIVE_AI_REQUEST_ID.load(Ordering::Acquire) != request_id {
        return Ok(false);
    }
    AI_REQUEST_CANCELLED.store(true, Ordering::Release);
    // A tool call waiting for the user belongs to the turn being cancelled: left waiting, it would
    // hold a tool worker open long after the agent that asked for it is gone.
    crate::approvals::cancel_all();
    crate::ask::cancel_user_prompts();
    // So does one waiting on the editor. Killing the worker below ends the conversation, but the
    // calls already dispatched into Rust wait on their own timeouts — minutes, for an addon request
    // that names one — and the turn is not over until they return.
    crate::cancel::cancel_turn(request_id);
    let active = AI_CHILD
        .lock()
        .map_err(|_| "The AI process lock is poisoned".to_owned())?
        .clone();
    if let Some(child) = active {
        child
            .lock()
            .map_err(|_| "The AI child process lock is poisoned".to_owned())?
            .kill()
            .map_err(|error| format!("Could not stop the AI agent: {error}"))?;
    }
    // No stream means no turn is streaming — a cancellation with nobody left to tell is not a
    // failure, it is the idle case the test suite exercises.
    let stream = AI_STREAM
        .lock()
        .map_err(|_| "The AI stream lock is poisoned".to_owned())?
        .clone();
    if let Some(stream) = stream {
        stream
            .send(AiStreamPayload {
                request_id,
                event: serde_json::json!({"type": "aborted"}),
            })
            .map_err(|error| format!("Could not report the cancelled AI request: {error}"))?;
    }
    Ok(true)
}
// coverage-critical-end: cancellation

// coverage-critical-start: attachment
fn validate_chat_attachment(attachment: &ChatAttachment) -> Result<(), String> {
    if attachment.name.trim().is_empty() || attachment.name.len() > 255 {
        return Err("Attachment names must contain between 1 and 255 bytes".to_owned());
    }
    if attachment.size == 0 || attachment.size > MAX_CHAT_ATTACHMENT_BYTES as u64 {
        return Err("Images must be between 1 byte and 10 MiB".to_owned());
    }
    if !["image/png", "image/jpeg", "image/webp", "image/gif"]
        .contains(&attachment.mime_type.as_str())
    {
        return Err("Only PNG, JPEG, WebP, and GIF images are supported".to_owned());
    }
    validate_chat_attachment_id(&attachment.id)
}

impl ChatAttachment {
    fn as_stored(&self) -> StoredAttachment {
        StoredAttachment {
            id: self.id.clone(),
            name: self.name.clone(),
            mime_type: self.mime_type.clone(),
            size: self.size,
        }
    }
}

/// The pictures one ask may carry, whether it is sent or planned.
///
/// The same ceiling a chat message is held to, and named once so the two cannot drift: a plan is
/// the first message of a task by another route, and a route that accepted more would be a way
/// round the limit rather than a feature.
const MAX_MESSAGE_ATTACHMENTS: usize = 5;

/// The pictures a plan was asked about, checked before a turn is begun for it.
fn validate_brief_attachments(attachments: &[ChatAttachment]) -> Result<(), String> {
    if attachments.len() > MAX_MESSAGE_ATTACHMENTS {
        return Err(format!(
            "A plan cannot be asked about more than {MAX_MESSAGE_ATTACHMENTS} images"
        ));
    }
    for attachment in attachments {
        validate_chat_attachment(attachment)?;
    }
    Ok(())
}

fn validate_chat_attachment_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 64
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err("The attachment ID is invalid".to_owned());
    }
    Ok(())
}
// coverage-critical-end: attachment

fn read_chat_attachment_bytes(
    app: &AppHandle,
    attachment: &ChatAttachment,
) -> Result<Vec<u8>, String> {
    crate::workspace::project_storage(app)?
        .chats()
        .read_attachment(&attachment.as_stored())
        .map_err(|failure| failure.message)
}

/// The stored bytes of each attachment, as the worker wants them.
///
/// One reader for both jobs. A turn hydrates the attachments hanging off each message and a brief
/// hydrates the ones hanging off its ask, and neither should own a second copy of "read it, then
/// base64 it".
fn hydrate_chat_attachments(
    app: &AppHandle,
    attachments: &[ChatAttachment],
) -> Result<Vec<AiWorkerImage>, String> {
    attachments
        .iter()
        .map(|attachment| {
            validate_chat_attachment(attachment)?;
            let bytes = read_chat_attachment_bytes(app, attachment)?;
            Ok(AiWorkerImage {
                data: base64::engine::general_purpose::STANDARD.encode(bytes),
                mime_type: attachment.mime_type.clone(),
            })
        })
        .collect()
}

fn hydrate_chat_messages(
    app: &AppHandle,
    messages: Vec<ChatMessageInput>,
) -> Result<Vec<AiWorkerMessage>, String> {
    messages
        .into_iter()
        .map(|message| {
            let images = hydrate_chat_attachments(app, &message.attachments)?;
            Ok(AiWorkerMessage {
                sender: message.sender,
                text: message.text,
                timestamp: message.timestamp,
                images,
            })
        })
        .collect()
}

fn validate_chat_messages(
    messages: Vec<ChatMessageInput>,
) -> Result<Vec<ChatMessageInput>, String> {
    if messages.is_empty() || messages.len() > MAX_CHAT_MESSAGES {
        return Err(format!(
            "Chat requests must contain between 1 and {MAX_CHAT_MESSAGES} messages"
        ));
    }
    if !matches!(
        messages.last().map(|message| message.sender),
        Some(ChatSender::User)
    ) {
        return Err("The last chat message must come from the user".to_owned());
    }
    if messages.iter().any(|message| {
        message.text.trim().is_empty()
            && (message.sender != ChatSender::User || message.attachments.is_empty())
    }) {
        return Err("Chat messages must contain text or an image".to_owned());
    }
    if messages
        .iter()
        .any(|message| message.attachments.len() > MAX_MESSAGE_ATTACHMENTS)
    {
        return Err(format!(
            "Chat messages cannot contain more than {MAX_MESSAGE_ATTACHMENTS} images"
        ));
    }
    let mut total_text_bytes = 0_usize;
    for message in &messages {
        if message.text.len() > MAX_CHAT_MESSAGE_BYTES {
            return Err("Individual chat messages cannot exceed 256 KiB".to_owned());
        }
        total_text_bytes = total_text_bytes.saturating_add(message.text.len());
    }
    if total_text_bytes > MAX_CHAT_TEXT_BYTES {
        return Err("Chat request text cannot exceed 4 MiB".to_owned());
    }
    for attachment in messages
        .iter()
        .flat_map(|message| message.attachments.iter())
    {
        validate_chat_attachment(attachment)?;
    }
    Ok(messages)
}

fn validate_agent_messages(messages: &Option<serde_json::Value>) -> Result<(), String> {
    let Some(messages) = messages else {
        return Ok(());
    };
    if !messages.is_array() {
        return Err("Agent message history must be an array".to_owned());
    }
    let size = serde_json::to_vec(messages)
        .map_err(|_| "Agent message history is invalid".to_owned())?
        .len();
    if size > MAX_AGENT_MESSAGES_BYTES {
        return Err("Agent message history cannot exceed 8 MiB".to_owned());
    }
    Ok(())
}

fn run_ai_worker(
    app: &AppHandle,
    turn: &AiTurn,
    request: AiWorkerRequest,
) -> Result<String, String> {
    run_ai_worker_with(app, turn, request, &SystemProcessSpawner)
}

/// The window event every brief update reaches the renderer on.
const BRIEF_EVENT: &str = "ai-brief";

/// Records one brief event and passes it to the window.
///
/// Recording happens here, on the Rust side of the pipe, because it is the only side that survives
/// the ending. A run is cancelled by killing the worker, so anything the worker was still holding —
/// the refined ask, three of four research sections — goes with it. A phase that has crossed this
/// line is a phase a stopped run can still show.
///
/// Best-effort throughout: a storage write that failed is not worth ending a run over, and a window
/// that is not listening is not a failure either.
fn handle_brief_event<R: Runtime>(
    app: &AppHandle<R>,
    task_id: Option<&str>,
    kind: &str,
    event: &serde_json::Value,
) {
    let text = |key: &str| event.get(key).and_then(serde_json::Value::as_str);
    if let Some(task_id) = task_id
        && let Ok(storage) = crate::workspace::project_storage(app)
    {
        let tasks = storage.tasks();
        match kind {
            "brief-phase" => {
                if let (Some(phase), Some(field), Some(value)) =
                    (text("phase"), text("field"), text("value"))
                {
                    tasks.record_brief_phase(task_id, phase, field, value);
                }
            }
            "brief-failed" => tasks.finish_brief(task_id, "failed", text("reason")),
            "brief-stopped" => tasks.finish_brief(task_id, "stopped", None),
            _ => {}
        }
    }
    let _ = app.emit_to(crate::ask::MAIN_WINDOW, BRIEF_EVENT, event);
}

/// The window event every memory judgement reaches the renderer on.
const JUDGE_EVENT: &str = "ai-memory-judge";

/// Files one judgement and passes every update to the window.
///
/// The filing happens on this side of the pipe for the reason the brief's does: a run is cancelled
/// by killing the worker, so a verdict still held in Node goes with it. A verdict that has crossed
/// this line is one a stopped run still leaves behind.
///
/// Best-effort: a storage write that failed is not worth ending a judgement over, and a window that
/// is not listening is not a failure either.
fn handle_judge_event<R: Runtime>(
    app: &AppHandle<R>,
    memory_id: &str,
    kind: &str,
    event: &serde_json::Value,
) {
    let text = |key: &str| event.get(key).and_then(serde_json::Value::as_str);
    if kind == "judge-verdict"
        && let Some(verdict) = text("verdict")
        && let Ok(storage) = crate::workspace::project_storage(app)
    {
        let _ = crate::project_memory::record_judgement(
            &storage,
            memory_id,
            verdict,
            text("reason").unwrap_or_default(),
            text("model").unwrap_or_default(),
        );
    }
    let mut event = event.clone();
    if let Some(fields) = event.as_object_mut() {
        fields.insert("memoryId".to_owned(), serde_json::json!(memory_id));
    }
    let _ = app.emit_to(crate::ask::MAIN_WINDOW, JUDGE_EVENT, event);
}

/// Runs one worker for a turn that has already begun.
///
/// It takes the turn rather than a request id and a channel because both belong to it, and because
/// what used to be missing here is not a value but a lifetime: the gate this opens is closed by the
/// turn's own `Drop`, so no path out of this function can leave it open.
pub(crate) fn run_ai_worker_with<R: Runtime>(
    app: &AppHandle<R>,
    turn: &AiTurn,
    mut request: AiWorkerRequest,
    spawner: &impl ProcessSpawner,
) -> Result<String, String> {
    let request_id = turn.request_id();
    let stream = turn
        .stream()
        .ok_or_else(|| "The AI stream lock is poisoned".to_owned())?;
    // The one place every turn passes through, so a request built without a prompt — an acceptance
    // suite, a test — still runs the agent Gofer ships rather than one with nothing said to it. A
    // brief is not filled in: its phases carry their own instructions and read no system prompt.
    if let WorkerJob::Turn { system_prompt, .. } = &mut request.job {
        *system_prompt = Some(crate::agent_prompt::resolve(
            system_prompt.as_deref(),
            request.tools,
        ));
    }
    let worker = ai_worker_path()?;
    let node = std::env::var("GOFER_NODE_BINARY").unwrap_or_else(|_| "node".to_owned());
    let mut child = spawner
        .spawn(node.as_ref(), &[worker.into_os_string()], true)
        .map_err(|error| {
            format!(
                "Could not start the Pi AI worker with '{node}': {error}. Install Node.js 22.19 or newer, or set GOFER_NODE_BINARY."
            )
        })?;
    let stdin = child
        .take_stdin()
        .ok_or_else(|| "Could not write to the Pi AI worker".to_owned())?;
    // The channel is duplex for the whole turn: the startup context is the first line, and every
    // later line answers a tool request. Closing stdin here — as the one-shot protocol did — would
    // leave the worker with tools it can call but no way to receive their results.
    let stdin = Arc::new(Mutex::new(stdin));
    let payload = serde_json::to_vec(&request)
        .map_err(|error| format!("Could not serialize the AI request: {error}"))?;
    write_worker_line(&stdin, &payload)
        .map_err(|error| format!("Could not send the request to the Pi AI worker: {error}"))?;

    let stdout = child
        .take_stdout()
        .ok_or_else(|| "Could not read Pi AI worker output".to_owned())?;
    let stderr = child
        .take_stderr()
        .ok_or_else(|| "Could not read Pi AI worker errors".to_owned())?;
    let child = Arc::new(Mutex::new(child));
    turn.register_child(Arc::clone(&child))?;
    let stderr_reader = std::thread::spawn(move || {
        let mut output = String::new();
        let _ = BufReader::new(stderr).read_to_string(&mut output);
        output
    });
    let mut completed = false;
    let mut completion_text = String::new();
    let mut tool_workers: Vec<std::thread::JoinHandle<()>> = Vec::new();
    // Which task's brief this worker is filling in, or `None` for an ordinary turn. The task is the
    // session id: a brief belongs to exactly one task and that is already what the field means.
    let brief_task = request
        .job
        .is_brief()
        .then(|| request.session_id.clone())
        .flatten();
    // Which memory this worker is judging, or `None` for every other job.
    let judged_memory = request.job.judged_memory().map(str::to_owned);

    // The stream is read in a closure so that a malformed line leaves the turn the same way a
    // clean end does: through the cancel-and-join below, rather than past it.
    let read_stream = || -> Result<(), String> {
        for line in BufReader::new(stdout).lines() {
            let line = line.map_err(|error| format!("Could not read Pi AI output: {error}"))?;
            if let Some(payload) = line.strip_prefix(AI_TOOL_PREFIX) {
                tool_workers.push(spawn_tool_worker(app, request_id, &stdin, payload)?);
                continue;
            }
            if let Some(payload) = line.strip_prefix(AI_CREDENTIAL_PREFIX) {
                persist_worker_credential(&stdin, payload)?;
                continue;
            }
            let Some(payload) = line.strip_prefix(AI_EVENT_PREFIX) else {
                continue;
            };
            let event: serde_json::Value = serde_json::from_str(payload)
                .map_err(|error| format!("Pi AI returned an invalid event: {error}"))?;
            // A brief's progress is not part of an assistant message, so it does not ride the
            // turn's stream — the renderer's timeline drops every event it does not recognise, by
            // design, and a phase is not one of the things it draws. It goes out as a window event
            // instead, and anything worth surviving a stop is written to the database on the way.
            if brief_task.is_some()
                && let Some(kind) = event.get("type").and_then(serde_json::Value::as_str)
                && kind.starts_with("brief-")
            {
                handle_brief_event(app, brief_task.as_deref(), kind, &event);
                continue;
            }
            // A judgement's progress is not part of an assistant message either, and the panel
            // reading it is not the chat. Same rule, same reason: the timeline drops what it does
            // not draw, so this goes out as a window event and its verdict is filed on the way.
            if let Some(memory_id) = judged_memory.as_deref()
                && let Some(kind) = event.get("type").and_then(serde_json::Value::as_str)
                && kind.starts_with("judge-")
            {
                handle_judge_event(app, memory_id, kind, &event);
                continue;
            }
            let is_done = event.get("type").and_then(serde_json::Value::as_str) == Some("done");
            if is_done {
                completed = true;
                completion_text = event
                    .get("text")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default()
                    .to_owned();
            }
            stream
                .send(AiStreamPayload { request_id, event })
                .map_err(|error| format!("Could not stream the AI response: {error}"))?;
            // The completion is the worker's last word, so the turn ends on it rather than on the
            // pipe closing. Those are not the same moment: the provider parks the connection it
            // just used — the Codex WebSocket is cached per session for five minutes — and an open
            // socket keeps the worker alive long after it has finished. Waiting for EOF left the
            // answer on screen, nothing running, and the composer still saying Gofer is working.
            if is_done {
                break;
            }
        }
        Ok(())
    };
    let streamed = read_stream();

    // The worker exited, so nothing is left to answer; joining keeps a tool that outlived it from
    // writing into the next turn's channel. Closing the approval gate first is what makes that join
    // finite: a tool call still waiting for the user has lost the agent that asked, and a prompt
    // registered after this point is refused rather than left waiting for the whole timeout.
    turn.close_gate_before_draining();
    drain_tool_workers(tool_workers);
    streamed?;

    // The answer is in, so the turn is over, and the worker is let go of rather than waited for.
    // What it spends its last moments on is its own business — closing the connection the provider
    // cached, exiting — and measured against the real endpoint that is about three seconds. Three
    // seconds of a composer that says Gofer is working after Gofer has answered.
    if completed {
        reap_worker(Arc::clone(&child), stderr_reader);
        return Ok(completion_text);
    }

    let status = stop_worker(&child)?;
    let stderr = stderr_reader
        .join()
        .map_err(|_| "Could not collect Pi AI worker errors".to_owned())?;
    if !status.success {
        if turn.is_cancelled() {
            return Ok(String::new());
        }
        let detail = stderr.trim();
        if detail.is_empty() {
            return Err(format!("Pi AI worker exited with {}", status.description));
        }
        return Err(format!("Pi AI request failed: {detail}"));
    }
    if !completed {
        return Err("Pi AI worker exited without completing the response".to_owned());
    }
    Ok(completion_text)
}

/// How long a worker that has finished is given to exit on its own before it is stopped.
///
/// Nobody waits this out — it is spent on a thread of its own, after the turn has already answered.
/// It is long enough that a worker closing its own sockets is never killed for taking a moment, and
/// short enough that one holding a cached connection for its full five minutes does not sit there.
const WORKER_EXIT_GRACE: Duration = Duration::from_secs(10);
const WORKER_EXIT_POLL: Duration = Duration::from_millis(25);

/// Lets go of a worker whose turn has ended, and reaps it whenever it goes.
///
/// Detached, because the answer has been streamed and the composer is free the moment this command
/// returns. The stderr reader is joined here rather than dropped so the thread ends with the
/// process it was reading.
fn reap_worker(child: SharedChildProcess, stderr: std::thread::JoinHandle<String>) {
    std::thread::spawn(move || {
        let _ = stop_worker(&child);
        let _ = stderr.join();
    });
}

/// Ends the worker: a moment to leave on its own, then a kill.
///
/// `wait` alone was what tied the turn to the worker's lifetime rather than to its answer. A
/// worker holding a cached connection open sits there for five minutes, and every one of those
/// minutes was a turn the renderer still drew as running.
fn stop_worker(child: &SharedChildProcess) -> Result<crate::process::ProcessStatus, String> {
    let deadline = std::time::Instant::now() + WORKER_EXIT_GRACE;
    loop {
        {
            let mut child = child
                .lock()
                .map_err(|_| "The AI child process lock is poisoned".to_owned())?;
            if let Some(status) = child
                .try_wait()
                .map_err(|error| format!("Could not wait for the Pi AI worker: {error}"))?
            {
                return Ok(status);
            }
            if std::time::Instant::now() >= deadline {
                child
                    .kill()
                    .map_err(|error| format!("Could not stop the Pi AI worker: {error}"))?;
                return child
                    .wait()
                    .map_err(|error| format!("Could not wait for the Pi AI worker: {error}"));
            }
        }
        std::thread::sleep(WORKER_EXIT_POLL);
    }
}

fn persist_worker_credential(
    stdin: &Arc<Mutex<crate::process::ProcessWriter>>,
    payload: &str,
) -> Result<(), String> {
    let answer = credential_answer(payload)?;
    write_worker_line(stdin, &answer)
        .map_err(|error| format!("Could not answer the credential request: {error}"))
}

/// Stores one rotated credential and returns the reply line its asker is waiting on.
///
/// Split out from the writing because two different children ask: the agent worker, whose stdin is
/// shared with its tool calls behind a mutex, and the documentation sidecar, which owns its own.
/// What the request means is the same for both, and it is decided here only.
pub(crate) fn credential_answer(payload: &str) -> Result<Vec<u8>, String> {
    #[derive(Deserialize)]
    struct CredentialCall {
        id: String,
        tool: String,
        params: CredentialParams,
    }
    #[derive(Deserialize)]
    struct CredentialParams {
        /// Absent for `clear`, which names no credential because it is removing the only one.
        #[serde(default)]
        credential: serde_json::Value,
    }

    let call: CredentialCall = serde_json::from_str(payload)
        .map_err(|error| format!("Pi AI returned an invalid credential request: {error}"))?;
    let result = match call.tool.as_str() {
        "store" => crate::settings::store_chatgpt_credential(&call.params.credential),
        "clear" => crate::settings::clear_chatgpt_credential(),
        other => Err(format!("Unknown credential operation '{other}'")),
    };
    let answer = match result {
        Ok(()) => serde_json::json!({"type": "tool-result", "id": call.id, "ok": true}),
        Err(error) => serde_json::json!({
            "type": "tool-result",
            "id": call.id,
            "ok": false,
            "error": {"code": "credential_not_stored", "message": error}
        }),
    };
    // No trailing newline: `write_worker_line` adds one, and the sidecar's own writer does too.
    serde_json::to_vec(&answer)
        .map_err(|error| format!("Could not serialize the credential response: {error}"))
}

/// How long a cancelled turn waits for its tool calls to notice before giving up on them.
///
/// A cancellation-aware wait ends within a poll, so this is not the normal cost of stopping: it
/// bounds the calls that cannot be interrupted — starting an editor, retrieving documentation.
const TOOL_DRAIN_TIMEOUT: Duration = Duration::from_secs(5);

// coverage-critical-start: cancellation
/// Waits for the turn's tool calls to finish before the turn is declared over.
///
/// A turn that ended normally waits as long as it takes: the calls are the work it was asked to do,
/// and letting the next turn start on top of a half-applied scene edit would be worse than a slow
/// finish. A turn the user stopped is the opposite case — the wait is what the user asked to end —
/// so it is bounded, and what has not noticed by then is left to finish on its own. A detached call
/// can only write into its own turn's channel, which the killed worker already closed, so the cost
/// of giving up on it is a side effect landing late, never one landing in the next turn's stream.
fn drain_tool_workers(workers: Vec<std::thread::JoinHandle<()>>) {
    drain_tool_workers_within(workers, TOOL_DRAIN_TIMEOUT);
}

fn drain_tool_workers_within(workers: Vec<std::thread::JoinHandle<()>>, limit: Duration) {
    if workers.is_empty() {
        return;
    }
    let (drained, wait) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        for worker in workers {
            let _ = worker.join();
        }
        let _ = drained.send(());
    });
    if AI_REQUEST_CANCELLED.load(Ordering::Acquire) {
        let _ = wait.recv_timeout(limit);
    } else {
        let _ = wait.recv();
    }
}
// coverage-critical-end: cancellation

/// Runs one tool request off the stdout loop and answers it on the duplex channel.
///
/// Off the loop because the agent executes tool calls in parallel and the loop must stay free to
/// read the next line: a dispatch that blocked it — a debugger wait, a documentation retrieval —
/// would stall every event behind it, including the ones that prove the tool is working.
fn spawn_tool_worker<R: Runtime>(
    app: &AppHandle<R>,
    request_id: u64,
    stdin: &Arc<Mutex<crate::process::ProcessWriter>>,
    payload: &str,
) -> Result<std::thread::JoinHandle<()>, String> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct WorkerToolCall {
        id: String,
        #[serde(flatten)]
        request: crate::ai_tools::ToolRequest,
    }

    let call: WorkerToolCall = serde_json::from_str(payload)
        .map_err(|error| format!("Pi AI returned an invalid tool request: {error}"))?;
    let app = app.clone();
    let stdin = Arc::clone(stdin);
    Ok(std::thread::spawn(move || {
        // The waits this dispatch makes are the turn's, not the renderer's: stopping the turn ends
        // them early instead of leaving the user's Stop waiting on a ten-minute addon timeout.
        let _turn = crate::cancel::ToolTurn::enter(request_id);
        let answer = match crate::ai_tools::dispatch(&app, call.request) {
            Ok(result) => serde_json::json!({
                "type": "tool-result",
                "id": call.id,
                "ok": true,
                "result": result,
            }),
            Err(failure) => serde_json::json!({
                "type": "tool-result",
                "id": call.id,
                "ok": false,
                "error": failure,
            }),
        };
        if let Ok(line) = serde_json::to_vec(&answer) {
            // A closed channel means the turn ended — cancelled, or the worker exited. There is
            // nobody left to tell, and the tool result is not worth failing the turn over.
            let _ = write_worker_line(&stdin, &line);
        }
    }))
}

/// Writes one NDJSON line to the worker. The lock spans the newline so two tool answers written
/// from different threads cannot interleave into one unparsable line.
fn write_worker_line(
    stdin: &Arc<Mutex<crate::process::ProcessWriter>>,
    payload: &[u8],
) -> std::io::Result<()> {
    let mut writer = stdin
        .lock()
        .map_err(|_| std::io::Error::other("The AI worker input lock is poisoned"))?;
    writer.write_all(payload)?;
    writer.write_all(b"\n")?;
    writer.flush()
}

fn ai_worker_path() -> Result<PathBuf, String> {
    crate::workers::resolve("The Pi AI worker", "GOFER_AI_WORKER", "ai-worker.mjs")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::process::{FakeChildProcess, FakeProcessSpawner, ProcessStatus};
    use crate::{ai_tools, cancel};
    use std::fs;

    use std::sync::atomic::Ordering as AtomicOrdering;
    use tempfile::TempDir;

    /// The turn's statics are process-wide, so the tests that move them take turns.
    static AI_TEST_LOCK: Mutex<()> = Mutex::new(());

    fn mock_app() -> tauri::App<tauri::test::MockRuntime> {
        let app = tauri::test::mock_builder()
            .build(crate::app_context())
            .expect("build mock Tauri app");
        tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("build mock webview");
        app
    }

    /// A mock app with project storage behind it, and the task a brief is recorded against.
    fn app_with_a_task(directory: &TempDir) -> (tauri::App<tauri::test::MockRuntime>, String) {
        let app = mock_app();
        let workspace = directory.path().join("workspace");
        fs::create_dir_all(&workspace).expect("workspace");
        let storage =
            crate::storage::ProjectStorage::open(&directory.path().join("data"), &workspace)
                .expect("open project storage");
        let task_id = storage
            .tasks()
            .create(&storage.switch(&|_| Ok(())))
            .expect("create a task")
            .task_id
            .expect("the new task's id");
        tauri::Manager::manage(&app, crate::storage::StorageSlot::new(Ok(storage)));
        (app, task_id)
    }

    /*
     * The whole of the crash-safety story, and the reason it is on this side of the pipe.
     *
     * A run is cancelled by killing the worker, so anything the worker was still holding goes with
     * it — and Node cannot write to the database at all. A phase that has crossed this line is a
     * phase a stopped run can still show; one that has not is gone.
     */
    #[test]
    fn a_phase_is_recorded_as_its_event_crosses_the_pipe() {
        let directory = TempDir::new().expect("temporary directory");
        let (app, task_id) = app_with_a_task(&directory);
        let storage = crate::workspace::project_storage(app.handle()).expect("storage");
        storage
            .tasks()
            .start_brief(&task_id, "add a pause menu")
            .expect("start the brief");

        handle_brief_event(
            app.handle(),
            Some(&task_id),
            "brief-phase",
            &serde_json::json!({
                "type": "brief-phase",
                "phase": "refine",
                "field": "refined",
                "value": "GOAL\nA pause menu."
            }),
        );

        let brief = storage.tasks().read_brief(&task_id).expect("the brief");
        assert_eq!(brief.phase, "refine");
        assert_eq!(brief.refined.as_deref(), Some("GOAL\nA pause menu."));
        assert_eq!(brief.status, "running");
    }

    /*
     * "Done" means there is a specification, and nothing else.
     *
     * A worker exiting without an error is not the same fact: a run cancelled mid-phase is killed,
     * which the process reports as an ordinary end. Keyed on the exit alone, a stopped run and a run
     * that never reached compose were both recorded `done` — a row claiming a finished brief with no
     * specification in it, which is the one thing the row exists to be trusted about.
     */
    #[test]
    fn a_brief_with_no_specification_is_not_done() {
        let directory = TempDir::new().expect("temporary directory");
        let (app, task_id) = app_with_a_task(&directory);
        let storage = crate::workspace::project_storage(app.handle()).expect("storage");
        let tasks = storage.tasks();
        tasks
            .start_brief(&task_id, "asdf ;;;; ????")
            .expect("start");
        tasks.record_brief_phase(&task_id, "research", "research", "FILES");

        // What the close does when the worker ended cleanly with nothing to show for it.
        let finished = tasks
            .read_brief(&task_id)
            .and_then(|brief| brief.spec)
            .is_some_and(|spec| !spec.trim().is_empty());
        assert!(
            !finished,
            "there is no specification, so the run did not finish"
        );

        tasks.finish_brief(
            &task_id,
            "failed",
            Some("the plan ended before it wrote a specification"),
        );
        let brief = tasks.read_brief(&task_id).expect("the brief");
        assert_eq!(brief.status, "failed");
        assert_eq!(brief.phase, "research", "and it says how far it got");
    }

    /// A run that did produce one is done, and says so.
    #[test]
    fn a_brief_that_wrote_a_specification_is_done() {
        let directory = TempDir::new().expect("temporary directory");
        let (app, task_id) = app_with_a_task(&directory);
        let storage = crate::workspace::project_storage(app.handle()).expect("storage");
        let tasks = storage.tasks();
        tasks
            .start_brief(&task_id, "add a pause menu")
            .expect("start");
        tasks.record_brief_phase(&task_id, "compose", "spec", "GOAL\nA menu.\n\nVERIFY\n");

        let finished = tasks
            .read_brief(&task_id)
            .and_then(|brief| brief.spec)
            .is_some_and(|spec| !spec.trim().is_empty());
        assert!(finished);
    }

    /// A run that reported its own ending says which, and says where it got to.
    #[test]
    fn a_run_that_ended_records_how() {
        let directory = TempDir::new().expect("temporary directory");
        let (app, task_id) = app_with_a_task(&directory);
        let storage = crate::workspace::project_storage(app.handle()).expect("storage");
        storage
            .tasks()
            .start_brief(&task_id, "anything")
            .expect("start");

        handle_brief_event(
            app.handle(),
            Some(&task_id),
            "brief-failed",
            &serde_json::json!({"type": "brief-failed", "phase": "compose", "reason": "no verify"}),
        );

        let brief = storage.tasks().read_brief(&task_id).expect("the brief");
        assert_eq!(brief.status, "failed");
        assert_eq!(brief.reason.as_deref(), Some("no verify"));
    }

    /*
     * The verdict is filed as its event crosses the pipe, for the same reason a phase is.
     *
     * A judgement is cancelled by killing the worker, and Node cannot reach the database at all. A
     * verdict that has crossed this line survives a stop; one still held in the worker does not —
     * and it cost a model request and a minute, so losing it is not a small thing.
     */
    #[test]
    fn a_verdict_is_filed_as_its_event_crosses_the_pipe() {
        let directory = TempDir::new().expect("temporary directory");
        let (app, _task_id) = app_with_a_task(&directory);
        let storage = crate::workspace::project_storage(app.handle()).expect("storage");
        let stored = storage
            .memory()
            .upsert(&crate::storage::UpsertMemoryRequest {
                id: None,
                task_id: None,
                kind: "summary".to_owned(),
                state: "confirmed".to_owned(),
                content: "Deleted GRAYZONE.md.".to_owned(),
                provenance: serde_json::json!({"source": "completed-ai-turn"}),
                superseded_by: None,
            })
            .expect("store a memory");

        handle_judge_event(
            app.handle(),
            &stored.id,
            "judge-verdict",
            &serde_json::json!({
                "type": "judge-verdict",
                "verdict": "holds",
                "reason": "the file is still absent",
                "model": "qwen3",
            }),
        );

        let filed = crate::project_memory::check_memory(
            storage.memory().get(&stored.id).expect("read").expect("it"),
            None,
            None,
        );
        let judgement = filed.judgement.expect("a verdict was filed");
        assert_eq!(judgement.verdict, "holds");
        assert_eq!(judgement.reason, "the file is still absent");
        assert_eq!(judgement.model, "qwen3");
        assert!(judgement.is_current);
        // The row keeps everything the verdict was not about.
        assert_eq!(filed.memory.provenance["source"], "completed-ai-turn");
    }

    /// Progress crosses the pipe without touching the row: only a verdict is worth storing.
    #[test]
    fn a_running_judgement_reports_itself_without_filing_anything() {
        let directory = TempDir::new().expect("temporary directory");
        let (app, _task_id) = app_with_a_task(&directory);
        let storage = crate::workspace::project_storage(app.handle()).expect("storage");
        let stored = storage
            .memory()
            .upsert(&crate::storage::UpsertMemoryRequest {
                id: None,
                task_id: None,
                kind: "summary".to_owned(),
                state: "confirmed".to_owned(),
                content: "Deleted GRAYZONE.md.".to_owned(),
                provenance: serde_json::json!({}),
                superseded_by: None,
            })
            .expect("store a memory");

        handle_judge_event(
            app.handle(),
            &stored.id,
            "judge-step",
            &serde_json::json!({"type": "judge-step", "line": "read: main.gd"}),
        );

        let filed = crate::project_memory::check_memory(
            storage.memory().get(&stored.id).expect("read").expect("it"),
            None,
            None,
        );
        assert!(filed.judgement.is_none(), "nothing was filed");
    }

    /*
     * The job says which memory it is about, where the worker reads it.
     *
     * `rename_all_fields` is what makes this true, and it has been wrong before: a variant's fields
     * keep their Rust names without it, and the worker reads `memoryId`. Nothing fails when it is
     * wrong — JavaScript answers `undefined` for a key that is not there — so the judgement would
     * run against a memory with no id and file its verdict nowhere.
     */
    #[test]
    fn a_judgement_names_its_memory_where_the_worker_reads_it() {
        let request = AiWorkerRequest {
            job: WorkerJob::Judge {
                memory_id: "01a0".to_owned(),
                memory: JudgedMemory {
                    id: "01a0".to_owned(),
                    content: "Deleted GRAYZONE.md.".to_owned(),
                    anchors: Vec::new(),
                },
            },
            ..worker_request()
        };
        let encoded = serde_json::to_value(&request).expect("serialize the request");

        assert_eq!(encoded["mode"], serde_json::json!("judge"));
        assert_eq!(encoded["memoryId"], serde_json::json!("01a0"));
        assert_eq!(
            encoded["memory"]["content"],
            serde_json::json!("Deleted GRAYZONE.md.")
        );
        assert_eq!(encoded["memory"]["anchors"], serde_json::json!([]));
        // A judgement carries none of a turn's own fields: its child has one question and its own
        // system prompt, and no transcript to be given.
        assert!(encoded.get("systemPrompt").is_none(), "{encoded}");
        assert!(encoded.get("messages").is_none(), "{encoded}");
    }

    /*
     * A brief's progress is not part of an assistant message.
     *
     * The renderer's timeline drops every event it does not draw, by design, so a phase sent down
     * the turn's channel would vanish silently. `mode` travels flattened beside the other fields,
     * which is the shape the worker reads it in — a rename here is a worker that runs a chat turn
     * when it was asked for a brief.
     */
    #[test]
    fn a_brief_request_names_its_job_where_the_worker_reads_it() {
        let request = AiWorkerRequest {
            job: WorkerJob::Brief {
                prompt: "add a pause menu".to_owned(),
                images: Vec::new(),
                inventory: None,
            },
            ..worker_request()
        };
        let encoded = serde_json::to_value(&request).expect("serialize the request");
        assert_eq!(encoded["mode"], serde_json::json!("brief"));
        assert_eq!(encoded["prompt"], serde_json::json!("add a pause menu"));
        // Empty is still sent, so the worker reads a list either way rather than a list or nothing.
        assert_eq!(encoded["images"], serde_json::json!([]));

        // A brief carries none of the turn's own fields — no transcript, no memory, and above
        // all no system prompt: its phases carry their own instructions, and the request used to
        // say so in a comment while sending the shipped agent prompt anyway.
        assert!(encoded.get("systemPrompt").is_none(), "{encoded}");
        assert!(encoded.get("messages").is_none(), "{encoded}");
        assert!(encoded.get("memoryContext").is_none(), "{encoded}");

        // And an ordinary turn says so too, rather than leaving the worker to infer it.
        let turn = serde_json::to_value(worker_request()).expect("serialize the request");
        assert_eq!(turn["mode"], serde_json::json!("turn"));
        assert!(turn.get("messages").is_some(), "{turn}");
    }

    /*
     * The pictures the ask was written beside, spelled the way the worker reads them.
     *
     * A screenshot is what a plan is often ABOUT. Sent under a name the worker does not read, the
     * phases run on the sentence alone — and nothing anywhere reports that the picture was dropped,
     * because a missing key is `undefined` and every reader has a branch for that.
     */
    #[test]
    fn a_brief_carries_the_pictures_its_ask_came_with() {
        let request = AiWorkerRequest {
            job: WorkerJob::Brief {
                prompt: "why is this menu off centre".to_owned(),
                images: vec![AiWorkerImage {
                    data: "aGk=".to_owned(),
                    mime_type: "image/png".to_owned(),
                }],
                inventory: None,
            },
            ..worker_request()
        };

        let encoded = serde_json::to_value(&request).expect("serialize the request");
        assert_eq!(
            encoded["images"],
            serde_json::json!([{"data": "aGk=", "mimeType": "image/png"}])
        );
    }

    /// Every turn-only field, spelled the way the worker reads it.
    ///
    /// The test above asserts a brief does *not* carry these, and passed while a turn did not carry
    /// them either. `#[serde(rename_all)]` on an enum renames the variants, not the fields inside
    /// them, so all four went out as snake_case and the worker — which reads `agentMessages`,
    /// `isRetry`, `memoryContext` and `systemPrompt` — got `undefined` for every one. Each has a
    /// defaulting branch, so nothing failed: the turn ran with no transcript, no project memory and
    /// no system prompt, and rebuilt its context from the screen on every message.
    #[test]
    fn a_turn_names_every_field_where_the_worker_reads_it() {
        let request = AiWorkerRequest {
            job: WorkerJob::Turn {
                messages: Vec::new(),
                agent_messages: Some(serde_json::json!([{"role": "user"}])),
                is_retry: true,
                memory_context: Some("what the project remembers".to_owned()),
                system_prompt: Some("the shipped agent prompt".to_owned()),
            },
            ..worker_request()
        };
        let encoded = serde_json::to_value(&request).expect("serialize the request");

        assert_eq!(
            encoded["agentMessages"],
            serde_json::json!([{"role": "user"}])
        );
        assert_eq!(encoded["isRetry"], serde_json::json!(true));
        assert_eq!(
            encoded["memoryContext"],
            serde_json::json!("what the project remembers")
        );
        assert_eq!(
            encoded["systemPrompt"],
            serde_json::json!("the shipped agent prompt")
        );
        // Named once, not twice: a snake_case key beside the camelCase one is a worker reading the
        // one it understands while the other rides along unused.
        for stale in [
            "agent_messages",
            "is_retry",
            "memory_context",
            "system_prompt",
        ] {
            assert!(
                encoded.get(stale).is_none(),
                "{stale} is still sent: {encoded}"
            );
        }
    }

    fn worker_request() -> AiWorkerRequest {
        AiWorkerRequest {
            settings: AiSettings::default(),
            api_key: None,
            brave_api_key: None,
            oauth_credential: None,
            session_id: Some("task-1".to_owned()),
            workspace_path: "/tmp/workspace".to_owned(),
            tools: ai_tools::CATALOG,
            job: WorkerJob::Turn {
                messages: vec![AiWorkerMessage {
                    sender: ChatSender::User,
                    text: "hello".to_owned(),
                    timestamp: 1,
                    images: Vec::new(),
                }],
                agent_messages: None,
                is_retry: false,
                memory_context: None,
                system_prompt: None,
            },
        }
    }

    /// Stands in for the renderer's channel, keeping what the turn streamed so a test can read it
    /// back in the order it was sent.
    fn recording_stream() -> (
        tauri::ipc::Channel<AiStreamPayload>,
        Arc<Mutex<Vec<serde_json::Value>>>,
    ) {
        let sent = Arc::new(Mutex::new(Vec::new()));
        let recorded = Arc::clone(&sent);
        let channel = tauri::ipc::Channel::new(move |body| {
            if let tauri::ipc::InvokeResponseBody::Json(json) = body
                && let Ok(value) = serde_json::from_str::<serde_json::Value>(&json)
            {
                recorded.lock().expect("stream record lock").push(value);
            }
            Ok(())
        });
        (channel, sent)
    }

    /// One turn, for a test that drives the worker directly.
    ///
    /// A test used to assign to five statics by hand and put them back at the bottom, with no RAII
    /// — so a failing assertion left the process dirty for whatever ran next. Beginning a turn is
    /// what production does, and dropping it is what puts everything back, including on a panic.
    fn a_turn(request_id: u64, stream: &tauri::ipc::Channel<AiStreamPayload>) -> AiTurn {
        AiTurn::begin(request_id, stream.clone()).expect("no other turn is running")
    }

    #[test]
    fn injected_node_worker_streams_events_and_reports_lifecycle_failures() {
        let _test = AI_TEST_LOCK.lock().expect("AI test lock");
        // A turn closes the process-wide approval gate when it ends, so this waits its turn
        // behind the `approvals` tests rather than settling a prompt one of them is waiting on.
        let _gate = crate::approvals::serialize_gate_tests();
        let app = mock_app();
        let output = [
            "worker diagnostic",
            r#"GOFER_AI_EVENT:{"type":"text-delta","delta":"Hello"}"#,
            r#"GOFER_AI_EVENT:{"type":"tool-start","id":"tool-1","name":"write_file","startedAt":1}"#,
            r#"GOFER_AI_EVENT:{"type":"tool-end","id":"tool-1","output":"saved","isError":false,"endedAt":2}"#,
            r#"GOFER_AI_EVENT:{"type":"done","text":"Hello","agentMessages":[],"usage":{},"model":"fake"}"#,
            "",
        ]
        .join("\n");
        let spawner = FakeProcessSpawner::new(&output, "", true);
        let (stream, streamed) = recording_stream();
        assert_eq!(
            run_ai_worker_with(
                app.handle(),
                &a_turn(7, &stream),
                worker_request(),
                &spawner
            )
            .expect("fake AI completion"),
            "Hello"
        );
        // The deltas ride the channel, in the order the worker wrote them and tagged with the turn
        // they belong to — the whole reason they are not on the event bus.
        let sent = streamed.lock().expect("stream record lock").clone();
        let types: Vec<&str> = sent
            .iter()
            .map(|payload| payload["event"]["type"].as_str().unwrap_or_default())
            .collect();
        assert_eq!(types, ["text-delta", "tool-start", "tool-end", "done"]);
        assert!(sent.iter().all(|payload| payload["requestId"] == 7));

        let incomplete = FakeProcessSpawner::new("unrelated output\n", "", true);
        assert_eq!(
            run_ai_worker_with(
                app.handle(),
                &a_turn(8, &stream),
                worker_request(),
                &incomplete
            )
            .unwrap_err(),
            "Pi AI worker exited without completing the response"
        );

        let invalid = FakeProcessSpawner::new("GOFER_AI_EVENT:not-json\n", "", true);
        assert!(
            run_ai_worker_with(
                app.handle(),
                &a_turn(9, &stream),
                worker_request(),
                &invalid
            )
            .unwrap_err()
            .contains("invalid event")
        );

        let failed = FakeProcessSpawner::new("", "provider failed\n", false);
        assert_eq!(
            run_ai_worker_with(
                app.handle(),
                &a_turn(10, &stream),
                worker_request(),
                &failed
            )
            .unwrap_err(),
            "Pi AI request failed: provider failed"
        );
        let silent_failure = FakeProcessSpawner::new("", "", false);
        assert!(
            run_ai_worker_with(
                app.handle(),
                &a_turn(10, &stream),
                worker_request(),
                &silent_failure
            )
            .unwrap_err()
            .contains("exit status: 1")
        );

        // A spawn that fails is one of the paths that used to return between opening the approval
        // gate and closing it, leaving it open for whatever came next.
        let missing = FakeProcessSpawner {
            child: Mutex::new(None),
            fail_spawn: true,
            written: Arc::new(Mutex::new(Vec::new())),
        };
        assert!(
            run_ai_worker_with(
                app.handle(),
                &a_turn(10, &stream),
                worker_request(),
                &missing
            )
            .unwrap_err()
            .contains("Could not start the Pi AI worker")
        );

        let cancelled = FakeProcessSpawner::new("", "killed", false);
        let turn = a_turn(11, &stream);
        turn.mark_cancelled(true);
        assert_eq!(
            run_ai_worker_with(app.handle(), &turn, worker_request(), &cancelled)
                .expect("cancelled worker"),
            ""
        );
    }

    /// A worker that has said everything and then holds its pipe open.
    ///
    /// This is what a remote turn really leaves behind: the answer is written, the agent is done,
    /// and the process stays alive because the provider cached the connection it just used. The
    /// pipe is open, so a reader waiting for EOF waits with it.
    struct LingeringWorkerOutput {
        remaining: Vec<u8>,
        released: std::sync::mpsc::Receiver<()>,
    }

    impl Read for LingeringWorkerOutput {
        fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
            if self.remaining.is_empty() {
                // EOF arrives only when the test lets go, which is the whole point: nothing about
                // the turn's own ending is allowed to depend on it.
                let _ = self.released.recv();
                return Ok(0);
            }
            let taken = self.remaining.len().min(buffer.len());
            buffer[..taken].copy_from_slice(&self.remaining[..taken]);
            self.remaining.drain(..taken);
            Ok(taken)
        }
    }

    fn lingering_spawner(
        stdout: &str,
        released: std::sync::mpsc::Receiver<()>,
    ) -> FakeProcessSpawner {
        FakeProcessSpawner {
            child: Mutex::new(Some(FakeChildProcess {
                // What the backend writes is another test's subject; this one is about when the
                // turn ends.
                stdin: Some(Box::new(std::io::sink())),
                stdout: Some(Box::new(LingeringWorkerOutput {
                    remaining: stdout.as_bytes().to_vec(),
                    released,
                })),
                stderr: Some(Box::new(std::io::Cursor::new(Vec::new()))),
                status: ProcessStatus {
                    success: true,
                    code: Some(0),
                    description: "exit status: 0".to_owned(),
                },
                killed: Arc::new(AtomicBool::new(false)),
            })),
            fail_spawn: false,
            written: Arc::new(Mutex::new(Vec::new())),
        }
    }

    /*
     * The turn ends when the answer ends, not when the worker gets around to exiting.
     *
     * The backend reads the worker's stdout until it closes, and the renderer's composer stays busy
     * until this command returns. A remote turn leaves a cached connection behind — the Codex
     * WebSocket, parked per session for five minutes — and an open socket keeps Node alive. So the
     * answer lands on screen, the model is finished, nothing is running, and Gofer still says it is
     * working until the user presses Stop. Waiting for EOF is what tied the two together.
     */
    #[test]
    fn a_worker_that_lingers_after_its_answer_does_not_hold_the_turn_open() {
        // Held in named guards and dropped by hand below: this test is meant to fail until the turn
        // stops waiting on EOF, and a panic while holding the lock poisons it for every other test
        // that takes it. What fails here has to fail here alone.
        let test_lock = AI_TEST_LOCK.lock().expect("AI test lock");
        let gate = crate::approvals::serialize_gate_tests();
        let app = mock_app();
        let (release, released) = std::sync::mpsc::channel();
        let spawner = lingering_spawner(
            r#"GOFER_AI_EVENT:{"type":"done","text":"Hello","agentMessages":[],"usage":{},"model":"fake"}
"#,
            released,
        );
        let (stream, streamed) = recording_stream();

        // The escape hatch, so a turn that does wait for EOF fails this test rather than hanging
        // the suite. Reaching it is the failure.
        let (ended, ending) = std::sync::mpsc::channel();
        let had_to_let_go = Arc::new(AtomicBool::new(false));
        let rescue = {
            let had_to_let_go = Arc::clone(&had_to_let_go);
            std::thread::spawn(move || {
                if ending.recv_timeout(Duration::from_secs(5)).is_err() {
                    had_to_let_go.store(true, Ordering::Release);
                    let _ = release.send(());
                }
            })
        };

        let at = std::time::Instant::now();
        let completion = run_ai_worker_with(
            app.handle(),
            &a_turn(41, &stream),
            worker_request(),
            &spawner,
        );
        let took = at.elapsed();
        let _ = ended.send(());
        rescue.join().expect("the rescue thread ends");
        let sent = streamed.lock().expect("stream record lock").clone();
        let waited = had_to_let_go.load(Ordering::Acquire);
        drop(gate);
        drop(test_lock);

        assert!(
            !waited,
            "the turn ended only because the test closed the worker's pipe for it"
        );
        // Not "eventually". A grace period spent before answering is a grace period the user spends
        // watching a finished turn, which is the bug in slower clothing.
        assert!(
            took < Duration::from_secs(1),
            "the turn took {took:?} to end on an answer it already had"
        );
        assert_eq!(completion.expect("the answer is complete"), "Hello");
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0]["event"]["type"], "done");
    }

    /// No turn, no gate — on every way out of one, not only the clean one.
    ///
    /// The gate used to be opened inside the worker and closed a hundred lines later, just before
    /// the tool threads were joined. Six things between those two lines return `Err`: taking the
    /// child's three pipes, serializing the request, writing it, and locking the child. Each left
    /// the gate open behind it, and the guard that reset the turn's other five values knew nothing
    /// about it. An open gate with no turn is a prompt that registers, waits out its whole timeout,
    /// and is answered by nobody.
    ///
    /// A spawn that fails is the earliest of those paths and the easiest to provoke; the assertion
    /// is about the turn ending, not about which failure ended it.
    #[test]
    fn a_turn_that_fails_before_its_worker_starts_still_closes_the_approval_gate() {
        let _test = AI_TEST_LOCK.lock().expect("AI test lock");
        // A turn closes the process-wide approval gate when it ends, so this waits its turn
        // behind the `approvals` tests rather than settling a prompt one of them is waiting on.
        let _gate = crate::approvals::serialize_gate_tests();
        let app = mock_app();
        let (stream, _streamed) = recording_stream();
        let missing = FakeProcessSpawner {
            child: Mutex::new(None),
            fail_spawn: true,
            written: Arc::new(Mutex::new(Vec::new())),
        };

        {
            let turn = a_turn(31, &stream);
            assert!(
                crate::approvals::is_open(),
                "beginning a turn is what opens the gate"
            );
            assert!(
                run_ai_worker_with(app.handle(), &turn, worker_request(), &missing).is_err(),
                "the worker cannot start"
            );
            assert!(
                crate::approvals::is_open(),
                "the turn has not ended yet, so a tool call may still ask"
            );
        }

        assert!(
            !crate::approvals::is_open(),
            "the turn ended, so nothing may still be waiting on the user"
        );
    }

    #[test]
    fn the_worker_channel_carries_the_tool_catalog_and_answers_tool_requests() {
        let _test = AI_TEST_LOCK.lock().expect("AI test lock");
        // A turn closes the process-wide approval gate when it ends, so this waits its turn
        // behind the `approvals` tests rather than settling a prompt one of them is waiting on.
        let _gate = crate::approvals::serialize_gate_tests();
        // `get_tree` is answered by the real session door, so the refusal it must produce is only
        // this test's to assert while nothing else has an editor bound.
        let _no_editor = crate::godot_session::no_editor_bound();
        let app = mock_app();
        // Two calls: one the router rejects outright, one that reaches a handler with no session.
        // Both must come back as structured failures on the same channel the events ride.
        let output = [
            r#"GOFER_AI_TOOL:{"id":"call-1","tool":"godot_scene","params":{"ops":[{"op":"get_tree"}]}}"#,
            r#"GOFER_AI_TOOL:{"id":"call-2","tool":"godot_scene","params":{"ops":[{"op":"detonate"}]}}"#,
            r#"GOFER_AI_EVENT:{"type":"done","text":"Done","agentMessages":[],"usage":{},"model":"fake"}"#,
            "",
        ]
        .join("\n");
        let spawner = FakeProcessSpawner::new(&output, "", true);
        let (stream, _streamed) = recording_stream();

        assert_eq!(
            run_ai_worker_with(
                app.handle(),
                &a_turn(21, &stream),
                worker_request(),
                &spawner
            )
            .expect("fake AI completion"),
            "Done"
        );

        let sent = spawner.sent();
        // The prompt cache key rides the same startup context. It was read from a settings field
        // that has never existed, so the worker sent every ask without one and the server had
        // nothing to route on; the name is asserted here because nothing else fails when it is
        // wrong — the turn works, it just pays for the whole story again.
        assert_eq!(sent[0]["sessionId"], "task-1");
        let catalog = sent[0]["tools"]
            .as_array()
            .expect("the startup context carries the tool catalog");
        assert_eq!(catalog.len(), ai_tools::CATALOG.len());
        assert_eq!(catalog[0]["name"], "godot_session");
        // Answers may be written in either order: the two dispatches run on their own threads.
        let mut answers: Vec<&serde_json::Value> = sent[1..].iter().collect();
        answers.sort_by_key(|answer| answer["id"].as_str().unwrap_or_default().to_owned());
        assert_eq!(answers.len(), 2);
        assert_eq!(answers[0]["ok"], false);
        assert_eq!(answers[0]["error"]["code"], "session_not_active");
        assert_eq!(answers[1]["ok"], false);
        assert_eq!(answers[1]["error"]["code"], "unknown_operation");
        *AI_CHILD.lock().expect("AI child lock") = None;
    }

    #[test]
    fn a_gated_tool_call_left_unanswered_is_settled_with_its_turn() {
        let _test = AI_TEST_LOCK.lock().expect("AI test lock");
        // A turn closes the process-wide approval gate when it ends, so this waits its turn
        // behind the `approvals` tests rather than settling a prompt one of them is waiting on.
        let _gate = crate::approvals::serialize_gate_tests();
        let app = mock_app();
        // A machine-wide editor setting always asks the user. Nobody answers this one, so the turn
        // ends with the prompt still up: the tool worker must be released rather than hold the join
        // open for the whole approval timeout.
        let output = [
            r#"GOFER_AI_TOOL:{"id":"call-1","tool":"godot_project","params":{"ops":[{"op":"set_editor_setting","name":"interface/editor/single_window_mode","value":{"type":"bool","value":true}}]}}"#,
            r#"GOFER_AI_EVENT:{"type":"done","text":"Asked","agentMessages":[],"usage":{},"model":"fake"}"#,
            "",
        ]
        .join("\n");
        let spawner = FakeProcessSpawner::new(&output, "", true);
        let (stream, _streamed) = recording_stream();

        let started = std::time::Instant::now();
        assert_eq!(
            run_ai_worker_with(
                app.handle(),
                &a_turn(23, &stream),
                worker_request(),
                &spawner
            )
            .expect("fake AI completion"),
            "Asked"
        );
        assert!(started.elapsed() < Duration::from_secs(30));

        let sent = spawner.sent();
        let answer = sent.last().expect("the tool call was answered");
        assert_eq!(answer["ok"], false);
        assert_eq!(answer["error"]["code"], "approval_cancelled");
        *AI_CHILD.lock().expect("AI child lock") = None;
    }

    #[test]
    fn an_unparsable_tool_request_fails_the_turn() {
        let _test = AI_TEST_LOCK.lock().expect("AI test lock");
        // A turn closes the process-wide approval gate when it ends, so this waits its turn
        // behind the `approvals` tests rather than settling a prompt one of them is waiting on.
        let _gate = crate::approvals::serialize_gate_tests();
        let app = mock_app();
        let spawner = FakeProcessSpawner::new("GOFER_AI_TOOL:not-json\n", "", true);
        let (stream, _streamed) = recording_stream();

        assert!(
            run_ai_worker_with(
                app.handle(),
                &a_turn(22, &stream),
                worker_request(),
                &spawner
            )
            .unwrap_err()
            .contains("invalid tool request")
        );
        *AI_CHILD.lock().expect("AI child lock") = None;
    }

    #[test]
    fn cancellation_handles_mismatched_idle_and_active_ai_requests() {
        let _test = AI_TEST_LOCK.lock().expect("AI test lock");
        ACTIVE_AI_REQUEST_ID.store(40, Ordering::Release);
        assert!(!cancel_ai_request_with(41).expect("mismatched cancellation"));

        // No turn is streaming, so there is no channel to report the abort on: cancelling anyway
        // has to succeed rather than fail on the missing stream.
        *AI_STREAM.lock().expect("AI stream lock") = None;
        *AI_CHILD.lock().expect("AI child lock") = None;
        assert!(cancel_ai_request_with(40).expect("idle cancellation"));

        let (stream, streamed) = recording_stream();
        *AI_STREAM.lock().expect("AI stream lock") = Some(stream);

        let killed = Arc::new(AtomicBool::new(false));
        *AI_CHILD.lock().expect("AI child lock") =
            Some(Arc::new(Mutex::new(Box::new(FakeChildProcess {
                stdin: None,
                stdout: None,
                stderr: None,
                status: ProcessStatus {
                    success: false,
                    code: None,
                    description: "killed".to_owned(),
                },
                killed: Arc::clone(&killed),
            }))));
        assert!(cancel_ai_request_with(40).expect("active cancellation"));
        assert!(killed.load(AtomicOrdering::Acquire));
        assert!(AI_REQUEST_CANCELLED.load(Ordering::Acquire));
        // The abort goes down the turn's own stream, behind whatever text it interrupted.
        let sent = streamed.lock().expect("stream record lock").clone();
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0]["requestId"], 40);
        assert_eq!(sent[0]["event"]["type"], "aborted");
        *AI_STREAM.lock().expect("AI stream lock") = None;
        *AI_CHILD.lock().expect("AI child lock") = None;
        ACTIVE_AI_REQUEST_ID.store(0, Ordering::Release);
        AI_REQUEST_CANCELLED.store(false, Ordering::Release);
    }

    /// The stop the user pressed has to end the turn, not queue behind it. A tool call that cannot
    /// notice the cancellation — one starting an editor, one retrieving documentation — is left to
    /// finish on its own rather than holding the whole turn, and with it the composer, open.
    #[test]
    fn a_stopped_turn_stops_waiting_for_a_tool_call_that_cannot_be_interrupted() {
        let _test = AI_TEST_LOCK.lock().expect("AI test lock");
        let limit = Duration::from_millis(200);

        // Nothing ran, so there is nothing to wait for either way.
        AI_REQUEST_CANCELLED.store(false, Ordering::Release);
        drain_tool_workers_within(Vec::new(), limit);

        // A turn that ended on its own waits for its calls however long they take.
        let finished = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&finished);
        drain_tool_workers_within(
            vec![std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(50));
                flag.store(true, Ordering::Release);
            })],
            limit,
        );
        assert!(
            finished.load(Ordering::Acquire),
            "an uncancelled turn must not declare itself over while a tool call is running"
        );

        // A stopped one gives the same call a bounded chance and then leaves it behind.
        AI_REQUEST_CANCELLED.store(true, Ordering::Release);
        let stuck = Arc::new(AtomicBool::new(false));
        let release = Arc::clone(&stuck);
        let started = std::time::Instant::now();
        drain_tool_workers_within(
            vec![std::thread::spawn(move || {
                while !release.load(Ordering::Acquire) {
                    std::thread::sleep(Duration::from_millis(10));
                }
            })],
            limit,
        );
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "a stopped turn must not wait out an uninterruptible tool call"
        );
        stuck.store(true, Ordering::Release);
        AI_REQUEST_CANCELLED.store(false, Ordering::Release);
    }

    /// Cancellation is scoped to the turn's own tool threads: the renderer calls the same addon
    /// through the same functions, and a stop must never abort what the user clicked.
    #[test]
    fn cancelling_a_turn_refuses_its_queued_tool_calls_and_leaves_the_renderer_alone() {
        let _test = AI_TEST_LOCK.lock().expect("AI test lock");
        let app = mock_app();
        let call = ai_tools::ToolRequest {
            tool: "godot_scene".to_owned(),
            params: serde_json::json!({"ops": [{"op": "get_tree"}]}),
        };

        cancel::cancel_turn(4_242);
        // The renderer's thread never entered the turn, so the same call still runs — and fails on
        // the missing session, not on the cancellation.
        let renderer = ai_tools::dispatch(app.handle(), call.clone()).unwrap_err();
        assert_ne!(renderer.code, "cancelled");

        let worker = std::thread::spawn(move || {
            let _turn = cancel::ToolTurn::enter(4_242);
            ai_tools::dispatch(app.handle(), call).unwrap_err()
        });
        assert_eq!(
            worker.join().expect("tool worker thread").code,
            "cancelled",
            "a queued call has no agent left to answer"
        );
        cancel::cancel_turn(0);
    }

    fn chat_attachment() -> ChatAttachment {
        ChatAttachment {
            id: "018f47aa-09d2-7b34-a2d3-8c4e6f123456".to_owned(),
            name: "scene.png".to_owned(),
            mime_type: "image/png".to_owned(),
            size: 2,
        }
    }

    #[test]
    fn image_only_user_messages_are_valid() {
        let messages = vec![ChatMessageInput {
            sender: ChatSender::User,
            text: String::new(),
            timestamp: 1,
            attachments: vec![chat_attachment()],
        }];

        assert!(validate_chat_messages(messages).is_ok());
    }

    #[test]
    fn chat_and_agent_payloads_are_bounded() {
        let oversized_message = vec![ChatMessageInput {
            sender: ChatSender::User,
            text: "x".repeat(MAX_CHAT_MESSAGE_BYTES + 1),
            timestamp: 1,
            attachments: Vec::new(),
        }];
        assert!(
            validate_chat_messages(oversized_message)
                .unwrap_err()
                .contains("256 KiB")
        );
        assert!(validate_agent_messages(&Some(serde_json::json!({"role": "user"}))).is_err());
    }

    /*
     * A plan is the first message of a task by another route, so it is held to the same ceiling.
     *
     * A route that took more pictures than Send does would not be a feature — it would be the way
     * round the limit, reached by pressing the other button.
     */
    #[test]
    fn a_plan_is_asked_about_no_more_pictures_than_a_message_carries() {
        let five = vec![chat_attachment(); MAX_MESSAGE_ATTACHMENTS];
        assert!(validate_brief_attachments(&five).is_ok());

        let six = vec![chat_attachment(); MAX_MESSAGE_ATTACHMENTS + 1];
        assert!(
            validate_brief_attachments(&six)
                .unwrap_err()
                .contains("more than 5 images")
        );

        // And each of them is the same untrusted metadata a message's is, checked the same way.
        let mut unsafe_id = chat_attachment();
        unsafe_id.id = "../scene".to_owned();
        assert!(
            validate_brief_attachments(&[unsafe_id])
                .unwrap_err()
                .contains("ID is invalid")
        );
    }

    #[test]
    fn chat_attachment_metadata_is_validated() {
        let mut invalid_type = chat_attachment();
        invalid_type.mime_type = "application/pdf".to_owned();
        assert!(
            validate_chat_attachment(&invalid_type)
                .unwrap_err()
                .contains("Only PNG")
        );

        let mut unsafe_id = chat_attachment();
        unsafe_id.id = "../scene".to_owned();
        assert!(
            validate_chat_attachment(&unsafe_id)
                .unwrap_err()
                .contains("ID is invalid")
        );
    }

    #[test]
    fn injected_storage_covers_attachment_round_trip_and_rejections() {
        let directory = TempDir::new().expect("temporary application data");
        let workspace = directory.path().join("workspace");
        fs::create_dir(&workspace).expect("create workspace");
        let storage = ProjectStorage::open(&directory.path().join("data"), &workspace)
            .expect("open project storage");
        let attachment = chat_attachment();
        save_chat_attachment_in(
            &storage,
            ChatAttachmentUpload {
                attachment: attachment.clone(),
                data: "aGk=".to_owned(),
            },
        )
        .expect("save attachment");
        assert_eq!(
            read_chat_attachment_in(&storage, attachment.clone()).expect("read attachment"),
            "data:image/png;base64,aGk="
        );

        assert!(
            save_chat_attachment_in(
                &storage,
                ChatAttachmentUpload {
                    attachment: attachment.clone(),
                    data: "not-base64".to_owned(),
                },
            )
            .unwrap_err()
            .message
            .contains("not valid base64")
        );
        let mut wrong_size = attachment.clone();
        wrong_size.size = 1;
        assert_eq!(
            save_chat_attachment_in(
                &storage,
                ChatAttachmentUpload {
                    attachment: wrong_size,
                    data: "aGk=".to_owned(),
                },
            )
            .unwrap_err()
            .message,
            "The attachment size does not match its contents"
        );

        assert!(
            save_chat_attachment_in(
                &storage,
                ChatAttachmentUpload {
                    attachment: attachment.clone(),
                    data: "x".repeat(MAX_CHAT_ATTACHMENT_BASE64_BYTES + 1),
                },
            )
            .unwrap_err()
            .message
            .contains("10 MiB")
        );
    }

    #[test]
    fn validation_rejects_every_bounded_chat_shape() {
        let attachment = chat_attachment();
        for invalid in [
            ChatAttachment {
                name: " ".to_owned(),
                ..attachment.clone()
            },
            ChatAttachment {
                name: "x".repeat(256),
                ..attachment.clone()
            },
            ChatAttachment {
                size: 0,
                ..attachment.clone()
            },
            ChatAttachment {
                size: MAX_CHAT_ATTACHMENT_BYTES as u64 + 1,
                ..attachment.clone()
            },
            ChatAttachment {
                id: String::new(),
                ..attachment.clone()
            },
            ChatAttachment {
                id: "x".repeat(65),
                ..attachment.clone()
            },
        ] {
            assert!(validate_chat_attachment(&invalid).is_err());
        }

        assert!(validate_chat_messages(Vec::new()).is_err());
        assert!(
            validate_chat_messages(
                (0..=MAX_CHAT_MESSAGES)
                    .map(|_| ChatMessageInput {
                        sender: ChatSender::User,
                        text: "message".to_owned(),
                        timestamp: 1,
                        attachments: Vec::new(),
                    })
                    .collect(),
            )
            .is_err()
        );
        assert!(
            validate_chat_messages(vec![ChatMessageInput {
                sender: ChatSender::Assistant,
                text: "answer".to_owned(),
                timestamp: 1,
                attachments: Vec::new(),
            }])
            .is_err()
        );
        assert!(
            validate_chat_messages(vec![ChatMessageInput {
                sender: ChatSender::User,
                text: " ".to_owned(),
                timestamp: 1,
                attachments: Vec::new(),
            }])
            .is_err()
        );
        assert!(
            validate_chat_messages(vec![ChatMessageInput {
                sender: ChatSender::User,
                text: "image set".to_owned(),
                timestamp: 1,
                attachments: vec![attachment; 6],
            }])
            .is_err()
        );
        assert!(validate_agent_messages(&None).is_ok());
        assert!(validate_agent_messages(&Some(serde_json::json!([]))).is_ok());
        assert!(
            validate_agent_messages(&Some(serde_json::json!([
                "x".repeat(MAX_AGENT_MESSAGES_BYTES)
            ])))
            .is_err()
        );
    }
}

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
use crate::settings::{AiSettings, Secret, Secrets, SystemSecrets};
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

/// The one line this side sends that is not an answer to something the worker asked for.
///
/// Stopping a turn was a kill and nothing else, so every abort branch in `scripts/ai-provider.mjs`
/// — the listener that calls `agent.abort()`, the `aborted` completion, the interruptible retry
/// wait — was reachable from its tests and from nothing in a running Gofer: the worker never built
/// an `AbortController` to pass them. The kill is still here and still ends a worker that will not
/// answer, but it is the second ask. This line is the first, and answering it is what lets the turn
/// checkpoint the assistant message that was in flight instead of losing it with the process.
///
/// Spelled once, and `scripts/ai-host.mjs` spells it once as `CANCEL_TYPE`; the two are held
/// together by `scripts/check-command-surface.mjs`.
const AI_CANCEL_LINE: &str = r#"{"type":"cancel"}"#;

/// How each job mode says it has finished, one name per mode.
///
/// It was one name for all three. `done` came off a chat turn carrying `{text, usage, model,
/// agentMessages}`, off a brief carrying `{spec}`, and off a judgement carrying `{verdict}` — and
/// this loop read every one of them as "the turn completed" and took `event["text"]`, which two of
/// the three have never had. A brief and a judgement are spelled out now, so a completion is routed
/// by what it is rather than by not looking like a `brief-` or a `judge-`.
///
/// The turn's own is still `done`: it is the completion that was always this event, and the other
/// two were the impostors sharing its name. `scripts/ai-events.mjs` owns the list and
/// `scripts/check-command-surface.mjs` holds this copy to it.
const AI_COMPLETION_EVENTS: [&str; 3] = ["done", "brief-done", "judge-done"];

/// What a `done` event's `stopReason` says when the worker's turn was stopped rather than finished.
///
/// The word is minted in `scripts/ai-provider.mjs` and read in `src/models/chat-timeline.ts`, which
/// is why it is read here too: the renderer decides `aborted` against `complete` from this field, so
/// deciding whether to file the answer from anything else is two sides disagreeing about one turn.
const AI_STOPPED_REASON: &str = "aborted";

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
/// The running worker's stdin, the same handle the tool answers are written on.
///
/// Held beside the child because a cancellation needs both: the line that asks the worker to stop
/// itself, and the process to kill if it does not. `take_stdin` moves the handle out of the child,
/// so the child alone is not enough to reach it.
type SharedWorkerInput = Arc<Mutex<crate::process::ProcessWriter>>;
static AI_WORKER_INPUT: Mutex<Option<SharedWorkerInput>> = Mutex::new(None);
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
    /// OpenRouter's key, from its own keyring slot. Both keys travel because the parent and the
    /// sub-agent can be on different key-based drivers in the same turn.
    pub(crate) openrouter_api_key: Option<String>,
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
        /// Filled by [`JobContext::request`], from the one resolve its context did when it was
        /// read — so a turn the acceptance suite runs is composed the way a turn in the
        /// application is. It is an `Option` rather than an empty string because "I have none" and
        /// "this one, which happens to be empty" are different things to say, and only one of them
        /// is ever meant.
        system_prompt: Option<String>,
        /// What the editor session is, in the sentence the prompt tells the model to read.
        ///
        /// The prompt used to say "call godot_session status first, every time", and the model
        /// did: 58 of 72 recorded turns opened with that call, and in 54 it was the only call of
        /// the ask that issued it. One round trip per turn — 4.2s median of waiting — for a state
        /// this process already holds and can simply say. Filled by [`JobContext::request`], for
        /// the same reason the prompt is.
        session_context: Option<String>,
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

/// What one caller wants a worker started for, and nothing besides.
///
/// Distinct from [`WorkerJob`], which is the shape that crosses the pipe. Everything a job of a
/// kind always carries — the tool catalogue, the system prompt, the session line, which
/// credentials it is given, which cache key it uses — belongs to [`JobContext`] instead, so four
/// assemblers cannot differ from one another by each naming those fields for itself. They did:
/// nine fields spelled out at five construction sites, three of them carrying a comment to justify
/// a `None`, and `tools` written out at every one of them for the single value it has ever had.
pub(crate) enum Job {
    /// A chat turn, answering into a conversation.
    Turn {
        /// The task this conversation belongs to, which is also its prompt cache key.
        task_id: Option<String>,
        messages: Vec<AiWorkerMessage>,
        agent_messages: Option<serde_json::Value>,
        is_retry: bool,
        memory_context: Option<String>,
    },
    /// The four phases that turn one ask into a specification.
    Brief {
        /// The task the specification is being written for, and its cache key.
        task_id: String,
        prompt: String,
        images: Vec<AiWorkerImage>,
        inventory: Option<String>,
    },
    /// One stored memory, put to a read-only child that says whether it is still true.
    Judge {
        memory_id: String,
        memory: JudgedMemory,
    },
}

/// The four secrets a worker may be sent, read in one place.
///
/// One value rather than four calls in each of four assemblers, because they are read together or
/// not at all — and because where a secret is kept is one decision, not four. The default is
/// nothing stored, which is what a suite driving its own model server sends.
#[derive(Clone, Debug, Default)]
struct Credentials {
    api_key: Option<String>,
    openrouter_api_key: Option<String>,
    brave_api_key: Option<String>,
    oauth_credential: Option<serde_json::Value>,
}

impl Credentials {
    /// Everything this machine has stored. Three of the four are the same read under a different
    /// slot, so they are the same call with a different [`Secret`]. The ChatGPT one stays a helper
    /// because it parses what it read rather than handing back the string.
    fn read() -> Result<Self, String> {
        let secrets = SystemSecrets;
        Ok(Self {
            api_key: secrets.read(Secret::AiDefault)?,
            openrouter_api_key: secrets.read(Secret::OpenRouter)?,
            brave_api_key: secrets.read(Secret::Brave)?,
            oauth_credential: crate::settings::stored_chatgpt_credential()?,
        })
    }

    /// The one credential a suite was handed, in the slot the driver it names actually reads.
    ///
    /// A suite is given a single key on the command line and the host looks one up per provider,
    /// so a key in the wrong slot is no key at all — `scripts/ai-provider.mjs` resolves the
    /// OpenRouter connection from `openrouterApiKey` and every other one from `apiKey`. Filling
    /// both would authenticate a local server with an OpenRouter key, which is the mistake in the
    /// other direction.
    #[cfg(all(test, feature = "godot-acceptance"))]
    fn for_driver(
        driver: crate::settings::AiConnectionType,
        api_key: Option<String>,
        oauth_credential: Option<serde_json::Value>,
    ) -> Self {
        let openrouter = driver == crate::settings::AiConnectionType::Openrouter;
        Self {
            api_key: if openrouter { None } else { api_key.clone() },
            openrouter_api_key: if openrouter { api_key } else { None },
            oauth_credential,
            ..Self::default()
        }
    }
}

/// The prompt this project sends: its own text where it stored one, the shipped one where it did
/// not. Resolved once, when a context is read, and never again.
fn resolve_prompt(storage: &ProjectStorage, strict_typing: bool) -> Result<String, String> {
    Ok(crate::agent_prompt::resolve(
        storage
            .project()
            .read_agent_prompt()
            .map_err(|failure| failure.message)?
            .as_deref(),
        crate::ai_tools::CATALOG,
        strict_typing,
    ))
}

/// Everything a job needs that is the same for every job, and the one place that reads it.
///
/// It sits between the four job assemblers and [`run_ai_worker_with`], which is where the seam was
/// missing. `run_ai_worker_with` takes an injected spawner and is tested; everything above it read
/// four credentials off the machine, so none of it could be driven at all. Three of the four
/// assemblers opened with the same seven lines — settings, four credentials, storage, workspace
/// path — and the fourth was a `JudgeContext` that existed to hoist exactly those for the two jobs
/// that share a turn.
///
/// The system prompt is resolved here, once. It used to be resolved twice: `run_turn` composed it
/// from the project's stored text, and `run_ai_worker_with` composed it again from what it was
/// handed. The second call always took the "it already has one" branch, so its `strict_typing`
/// argument — read from a second settings function with a second error policy — decided nothing,
/// and the branch it was written for was reached only by the two acceptance harnesses. The suite
/// composed a turn the application never composed, which is the one thing an acceptance suite may
/// not do.
pub(crate) struct JobContext {
    ai: AiSettings,
    credentials: Credentials,
    storage: ProjectStorage,
    workspace_path: String,
    /// The whole system prompt, as this project sends it, or `None` for a job that sends none.
    ///
    /// See the note above for why it is resolved here. `None` is the brief and the memory sweep:
    /// both compose their own prompt inside the worker and `request` drops this field for them, so
    /// resolving it was a project-row read and a walk of the whole tool catalogue spent on a string
    /// nothing sends — and a corrupt or locked `project` row aborted two jobs that never read it.
    system_prompt: Option<String>,
    /// What the editor session is, in the sentence the prompt tells the model to read.
    session_context: String,
}

impl JobContext {
    /// Reads everything a job needs off this machine.
    pub(crate) fn read<R: Runtime>(app: &AppHandle<R>) -> Result<Self, String> {
        Self::read_with(app, true)
    }

    /// The same context for a job that sends no system prompt: a brief, or a memory sweep.
    pub(crate) fn read_without_prompt<R: Runtime>(app: &AppHandle<R>) -> Result<Self, String> {
        Self::read_with(app, false)
    }

    fn read_with<R: Runtime>(app: &AppHandle<R>, composes: bool) -> Result<Self, String> {
        let settings = crate::settings::read_settings(app)?;
        let storage = crate::workspace::project_storage(app)?;
        let workspace_path = storage
            .tasks()
            .agent_workspace()
            .map_err(|failure| failure.message)?
            .display()
            .to_string();
        // The one read of the typing rule a job makes, from the settings it already has, rather
        // than a second read further down with an error policy of its own.
        let system_prompt = if composes {
            Some(resolve_prompt(&storage, settings.godot.strict_typing)?)
        } else {
            None
        };
        Ok(Self {
            ai: settings.ai,
            credentials: Credentials::read()?,
            storage,
            workspace_path,
            system_prompt,
            session_context: describe_session(app),
        })
    }

    /// The same context, for a suite that drives its own model against its own checkout.
    ///
    /// The suites used to build the request by hand, and were the only callers that ever left the
    /// system prompt unset — so the branch they took was one nothing in the application took. They
    /// compose a turn here the way the application composes one; what a suite still chooses for
    /// itself is where the model is, which credential — if any — is sent, and which checkout the
    /// editor it started is bound to.
    ///
    /// The keyring is never read here. A suite's credentials have to be named on the command line:
    /// `GOFER_LIVE_API_KEY` fills the slot the named driver reads — see [`Credentials::for_driver`],
    /// which is where that decision lives — and `GOFER_LIVE_OAUTH` carries the
    /// stored ChatGPT credential as the JSON the keyring holds. That is what lets a live turn be
    /// put to a hosted endpoint — OpenRouter, or a ChatGPT subscription — and not only to a local
    /// server. A credential the run was not given is simply absent, which is what a run against
    /// `127.0.0.1` wants.
    ///
    /// A refresh Pi performs mid-run is lost, because there is nowhere here to write it back to.
    /// A suite is a single turn and the stored access token outlives one, so the cost of that is a
    /// run started on an expired token failing at its first request rather than silently later.
    /// Unset, the suite sends nothing, which is what a run against `127.0.0.1` wants.
    // Gated exactly where its callers are: the two acceptance harnesses are `cfg(all(test,
    // feature = "godot-acceptance"))` modules, and a build without the engine has no suite to
    // build a context for.
    #[cfg(all(test, feature = "godot-acceptance"))]
    pub(crate) fn for_suite<R: Runtime>(
        app: &AppHandle<R>,
        ai: AiSettings,
        workspace_path: String,
    ) -> Result<Self, String> {
        let storage = crate::workspace::project_storage(app)?;
        let system_prompt = Some(resolve_prompt(
            &storage,
            crate::settings::read_godot_settings(app)
                .unwrap_or_default()
                .strict_typing,
        )?);
        let driver = ai.connection_type;
        Ok(Self {
            ai,
            credentials: Credentials::for_driver(
                driver,
                std::env::var("GOFER_LIVE_API_KEY")
                    .ok()
                    .filter(|key| !key.is_empty()),
                std::env::var("GOFER_LIVE_OAUTH")
                    .ok()
                    .filter(|stored| !stored.is_empty())
                    .map(|stored| {
                        serde_json::from_str(&stored)
                            .expect("GOFER_LIVE_OAUTH holds the JSON the keyring stores")
                    }),
            ),
            storage,
            workspace_path,
            system_prompt,
            session_context: describe_session(app),
        })
    }

    /// The project database this job reads and writes through.
    fn storage(&self) -> &ProjectStorage {
        &self.storage
    }

    /// The checkout the worker runs in.
    fn workspace_path(&self) -> &str {
        &self.workspace_path
    }

    /// The request one job is sent as.
    ///
    /// Every field the worker reads is filled in here and nowhere else. `tools` is the router's own
    /// catalogue, which is the only value it has ever had; the prompt and the session line are this
    /// context's, already resolved; and which credentials a job is given, and which cache key it
    /// uses, are properties of the job rather than of the place it was assembled.
    pub(crate) fn request(&self, job: Job) -> AiWorkerRequest {
        let (session_id, job) = match job {
            Job::Turn {
                task_id,
                messages,
                agent_messages,
                is_retry,
                memory_context,
            } => (
                task_id,
                WorkerJob::Turn {
                    messages,
                    agent_messages,
                    is_retry,
                    memory_context,
                    system_prompt: self.system_prompt.clone(),
                    session_context: Some(self.session_context.clone()),
                },
            ),
            Job::Brief {
                task_id,
                prompt,
                images,
                inventory,
            } => (
                Some(task_id),
                WorkerJob::Brief {
                    prompt,
                    images,
                    inventory,
                },
            ),
            // No cache key. A judgement is one question about one row, so there is no prefix a
            // later ask would reuse, and keying it per memory would fragment the cache the
            // conversation depends on.
            Job::Judge { memory_id, memory } => (None, WorkerJob::Judge { memory_id, memory }),
        };
        // A judging child holds `read` and `bash`. Neither reaches the web, so a search key it
        // cannot use is a key with no reason to be in the request.
        let brave_api_key = if matches!(job, WorkerJob::Judge { .. }) {
            None
        } else {
            self.credentials.brave_api_key.clone()
        };
        AiWorkerRequest {
            settings: self.ai.clone(),
            api_key: self.credentials.api_key.clone(),
            openrouter_api_key: self.credentials.openrouter_api_key.clone(),
            brave_api_key,
            oauth_credential: self.credentials.oauth_credential.clone(),
            session_id,
            workspace_path: self.workspace_path.clone(),
            tools: crate::ai_tools::CATALOG,
            job,
        }
    }
}

/// How one job ended: the three words for it, and the one place that decides which.
///
/// The contract was written four times over — a brief that read its row back and matched four
/// arms, a judgement that decided its own in two, a sweep choosing between two strings, and a
/// fourth in the renderer's `finally`. All four exist for one reason: a worker that is killed
/// narrates nothing, so the side holding the knife is the only side that can say what happened. A
/// cancellation asks before it kills now — see [`AI_CANCEL_LINE`] — and a worker that answers does
/// narrate its own stop; the ask is best-effort and the kill is what remains for the one that does
/// not, so this stays the side that decides. Three of them live here now; the renderer's is its own.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Ending<'a> {
    /// It produced what it was started for: a specification with words in it, a filed verdict, a
    /// list judged to the end.
    Finished,
    /// Stop was pressed. The user's doing, and not a failure to report as one.
    Stopped,
    /// It did not produce it, and this is why.
    Failed(&'a str),
}

impl<'a> Ending<'a> {
    /// The ending a worker's exit means.
    ///
    /// The `Ok` side says what the job has to show for it: `None` where what it was paid for is
    /// there, and the sentence to report it by where it is not. A worker exiting without an error
    /// is NOT by itself a finished job — a run cancelled mid-phase is killed, which the process
    /// reports as an ordinary end, so keying on the exit alone recorded a stopped run and a run
    /// that never reached compose as `done`: a row claiming a brief that finished, with no spec in
    /// it.
    ///
    /// Stop wins over a failure, which is the one point the four contracts disagreed on. A killed
    /// worker's broken pipe is an error, and the brief reported it as a failed plan while the
    /// judgement — whose worker is killed exactly the same way — called it stopped.
    fn settle(outcome: Result<Option<&'a str>, &'a str>, cancelled: bool) -> Self {
        match outcome {
            Err(_) | Ok(Some(_)) if cancelled => Self::Stopped,
            Err(reason) | Ok(Some(reason)) => Self::Failed(reason),
            Ok(None) => Self::Finished,
        }
    }

    /// The word this ending is spelled with on the wire.
    fn word(self) -> &'static str {
        match self {
            Self::Finished => "finished",
            Self::Stopped => "stopped",
            Self::Failed(_) => "failed",
        }
    }

    /// Why it failed, where that is something somebody is owed.
    fn reason(self) -> Option<&'a str> {
        match self {
            Self::Failed(reason) => Some(reason),
            _ => None,
        }
    }

    /// The event this ending is said with on `job`'s own window event, or nothing where the job's
    /// own answer has already said it.
    ///
    /// `about` is what that job's panel needs beside the ending to find the row it belongs to.
    fn event(self, job: &str, about: &[(&str, &str)]) -> Option<serde_json::Value> {
        if matches!(self, Self::Finished) {
            return None;
        }
        let mut event = serde_json::Map::new();
        event.insert(
            "type".to_owned(),
            serde_json::Value::from(format!("{job}-{}", self.word())),
        );
        for (key, value) in about {
            event.insert((*key).to_owned(), serde_json::Value::from(*value));
        }
        if let Some(reason) = self.reason() {
            event.insert("reason".to_owned(), serde_json::Value::from(reason));
        }
        Some(serde_json::Value::Object(event))
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
/// What it holds is what a *turn* lasts: the request id, the cancellation flag, the stream, and the
/// one provider operation. The gate pair and the worker process are [`WorkerRun`]'s, because those
/// last one *worker* — and a sweep is one turn holding eighty of them. Opening them here is what
/// made `run_sweep` copy the two `open()` calls into its own loop to get the second memory's child
/// a gate, which is the hand-written lifecycle this type exists to end.
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

    fn is_cancelled(&self) -> bool {
        AI_REQUEST_CANCELLED.load(Ordering::Acquire)
    }

    /// Marks this turn cancelled, for the tests that drive the worker's cancelled exit directly.
    #[cfg(test)]
    fn mark_cancelled(&self, cancelled: bool) {
        AI_REQUEST_CANCELLED.store(cancelled, Ordering::Release);
    }
}

impl Drop for AiTurn {
    fn drop(&mut self) {
        ACTIVE_AI_REQUEST_ID.store(0, Ordering::Release);
        AI_REQUEST_CANCELLED.store(false, Ordering::Release);
        if let Ok(mut stream) = AI_STREAM.lock() {
            *stream = None;
        }
        // The flag that admits the next turn is `_provider_operation`, and a field is dropped after
        // the body that owns it: it is released once everything it would collide with is back.
    }
}

/// One spawned worker inside a turn: the gate pair its tool calls may ask through, and the child
/// process a cancellation has to reach.
///
/// Split out of [`AiTurn`] because this is the lifetime those two things actually have. A turn is
/// one command; a worker is one process, and a sweep is one turn holding eighty of them, each
/// spawned and reaped in its own iteration. Held at turn scope, the gate a finished worker closed
/// on its way out stayed shut for every worker after it — so `run_sweep` re-opened both gates at
/// the top of its loop, by hand, with a comment explaining why. That is a lifecycle re-enacted at a
/// call site, which is the exact failure `AiTurn` was written to end; `register_worker` was the same
/// shape, a turn-scoped field overwritten once per memory.
///
/// Approvals belong to a worker: the gate opens with it and closes with it, so a gated tool call
/// always has an agent waiting for its answer, and a prompt that arrives after the end is refused
/// rather than left waiting. And so do questions, for the same reason and on the same schedule.
/// They are two registries — an approval and a question are different answers — but there is no run
/// in which one of them should be open and the other shut, so one call opens both and one closes
/// both: see [`crate::ask::open_user_prompts`].
pub(crate) struct WorkerRun;

impl WorkerRun {
    /// Opens the gate pair for one worker.
    ///
    /// It takes the turn rather than reading one, because a worker only ever runs inside a turn and
    /// a signature says so where a comment is only read afterwards. Nothing is taken out of it:
    /// what a run owns is process-wide, exactly as what a turn owns is.
    pub(crate) fn enter(_turn: &AiTurn) -> Self {
        crate::ask::open_user_prompts();
        Self
    }

    /// Records the worker process and the channel into it, so a cancellation can reach both.
    ///
    /// Both, and in one call, because a stop is two asks and it needs one of them for each: the
    /// line that lets the worker end its own turn, and the process to kill if it does not answer.
    /// Registered together so no window exists in which a cancellation can ask but not enforce.
    fn register_worker(
        &self,
        child: SharedChildProcess,
        input: SharedWorkerInput,
    ) -> Result<(), String> {
        *AI_WORKER_INPUT
            .lock()
            .map_err(|_| "The AI worker input lock is poisoned".to_owned())? = Some(input);
        *AI_CHILD
            .lock()
            .map_err(|_| "The AI process lock is poisoned".to_owned())? = Some(child);
        Ok(())
    }

    /// Closes the gate before the tool threads are joined.
    ///
    /// The join is what keeps a tool that outlived the worker from writing into the next turn's
    /// channel, and closing the gate first is what makes it finite. `Drop` closes it too — this is
    /// the one place the *order* matters rather than the fact.
    fn close_gate_before_draining(&self) {
        crate::ask::cancel_user_prompts();
    }
}

impl Drop for WorkerRun {
    fn drop(&mut self) {
        // First, because it is the one that was being missed: no gated call may outlive the agent
        // that asked for it, whichever way the worker ended.
        crate::ask::cancel_user_prompts();
        if let Ok(mut active) = AI_CHILD.lock() {
            *active = None;
        }
        if let Ok(mut input) = AI_WORKER_INPUT.lock() {
            *input = None;
        }
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
        let context = JobContext::read(&app)?;
        let task_id = request.task_id;
        let memory_context = crate::project_memory::retrieve_memory_context(
            context.storage(),
            &prompt,
            task_id.as_deref(),
        )
        .ok();
        let completion = run_ai_worker(
            &app,
            &turn,
            context.request(Job::Turn {
                task_id: task_id.clone(),
                messages,
                agent_messages: request.agent_messages,
                is_retry: request.is_retry,
                memory_context,
            }),
        )?;
        let _ = crate::project_memory::remember_completed_turn(
            context.storage(),
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

/// What sweeping needs: the turn, and the rows the window decided are worth paying for.
///
/// The list comes from the window rather than being computed here, because which rows are worth a
/// minute each is a policy the person pressing the button can see and this side cannot. The panel
/// sends what it is showing, minus anything already carrying a current verdict.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SweepRequest {
    pub request_id: u64,
    pub memory_ids: Vec<String>,
}

/// Everything a judgement needs that does not change between one memory and the next.
///
/// Built once and reused, which is the whole reason a sweep is not a loop of `run_judge`: settings,
/// credentials and the worktree scan are the same for every row, and the scan in particular is a
/// full directory walk that would otherwise be repeated once a minute for an hour.
struct JudgeContext {
    job: JobContext,
    snapshot: crate::files::Snapshot,
}

impl JudgeContext {
    fn read(app: &AppHandle) -> Result<Self, String> {
        let job = JobContext::read_without_prompt(app)?;
        let snapshot = crate::files::scan(std::path::Path::new(job.workspace_path()));
        Ok(Self { job, snapshot })
    }
}

/// Judges one memory inside a turn that has already begun, and says exactly one ending about it.
///
/// The ending is said here rather than left to the worker because a worker that broke before its
/// own handler ran emits nothing, and a row left spinning is the failure the brief's ending
/// contract was written for. Every path out of this function has said one of `judge-verdict`,
/// `judge-failed` or `judge-stopped` about this memory — the first two from the worker, the third
/// and any duplicate from here.
///
/// The verdict itself is not returned. It crosses on `judge-verdict` and is filed by
/// [`handle_judge_event`], which is the only side that survives the worker being killed, so what
/// comes back is the row read afterwards: what was stored, not what was reported.
fn judge_one(
    app: &AppHandle,
    turn: &AiTurn,
    context: &JudgeContext,
    memory_id: &str,
) -> Result<crate::project_memory::CheckedMemory, String> {
    // Read here rather than in the worker, which holds no database. It is also what refuses a
    // memory deleted between the click and the spawn, before a model is paid for.
    let record = context
        .job
        .storage()
        .memory()
        .get(memory_id)
        .map_err(|failure| failure.message)?
        .ok_or_else(|| "That memory is no longer stored".to_owned())?;
    let index = crate::project_memory::basename_index(&context.snapshot);
    let checked =
        crate::project_memory::check_memory(record, Some(&context.snapshot), Some(&index));

    let outcome = run_ai_worker(
        app,
        turn,
        context.job.request(Job::Judge {
            memory_id: memory_id.to_owned(),
            memory: JudgedMemory {
                id: checked.memory.id.clone(),
                content: checked.memory.content.clone(),
                anchors: checked.anchors,
            },
        }),
    );

    // A judgement has exactly one ending, and a verdict is one of them. Stop and a finished worker
    // can land in the same instant, and the row was then sent `judge-stopped` *and* pushed into
    // the sweep's answer: the panel drew it as stopped while the list it was handed carried its
    // verdict. What the model was paid for is what is reported, and only a judgement with no
    // verdict has an ending of its own to send — a worker that returned is a worker whose verdict
    // crossed `judge-verdict` and was filed on this side of the pipe.
    let ending = Ending::settle(
        outcome.as_ref().map(|_| None).map_err(String::as_str),
        turn.is_cancelled(),
    );
    if let Some(event) = ending.event("judge", &[("memoryId", memory_id)]) {
        let _ = app.emit_to(crate::ask::MAIN_WINDOW, JUDGE_EVENT, event);
    }
    outcome?;

    let record = context
        .job
        .storage()
        .memory()
        .get(memory_id)
        .map_err(|failure| failure.message)?
        .ok_or_else(|| "That memory is no longer stored".to_owned())?;
    Ok(crate::project_memory::check_memory(
        record,
        Some(&context.snapshot),
        Some(&index),
    ))
}

/// Puts one stored memory to a read-only child and files what it says.
///
/// It begins an `AiTurn` for the same two reasons a brief does, and neither is a convenience. The
/// turn is what Stop can reach, because cancelling reaches whatever `register_worker` registered; and
/// it is what holds the single provider operation, so a judgement cannot run beside a chat turn on
/// the one connection or have the shared checkout switched out from under the child reading it.
pub(crate) async fn run_judge(
    app: AppHandle,
    request: JudgeRequest,
    stream: tauri::ipc::Channel<AiStreamPayload>,
) -> Result<crate::project_memory::CheckedMemory, CommandError> {
    let turn = AiTurn::begin(request.request_id, stream)?;
    tauri::async_runtime::spawn_blocking(move || {
        let turn = turn;
        let context = JudgeContext::read(&app)?;
        judge_one(&app, &turn, &context, &request.memory_id)
    })
    .await
    .map_err(|error| format!("The memory judgement failed: {error}"))?
    .map_err(CommandError::coded("memory_judge_failed"))
}

/// The window event a sweep's own progress reaches the renderer on.
///
/// Separate from `JUDGE_EVENT`, which stays per-memory: a panel drawing a spinner on one row and a
/// panel drawing "31 of 84" are asking different questions, and folding both onto one event would
/// make every row listener re-derive which of the two it was looking at.
const SWEEP_EVENT: &str = "ai-memory-sweep";

/// Judges a list of memories, one after another, inside a single turn.
///
/// One turn for the whole list rather than one per memory, and that is the point. A judgement is a
/// model request and about a minute; eighty of them is over an hour, and eighty turns is eighty
/// chances for a chat message to win the provider operation in a gap and leave the sweep half done
/// with no way to say so. Holding the turn for the run means Stop reaches the sweep rather than
/// whichever memory happened to be in flight, and the person watching is told a real total.
///
/// It answers with every row it judged, read back from the database. A row that failed or was
/// deleted mid-run is left out rather than reported as unjudged — the panel has the ids it sent and
/// can see what did not come back.
pub(crate) async fn run_sweep(
    app: AppHandle,
    request: SweepRequest,
    stream: tauri::ipc::Channel<AiStreamPayload>,
) -> Result<Vec<crate::project_memory::CheckedMemory>, CommandError> {
    if request.memory_ids.is_empty() {
        return Err(CommandError::new(
            "sweep_without_memories",
            "There is nothing to check.",
        ));
    }
    let turn = AiTurn::begin(request.request_id, stream)?;
    tauri::async_runtime::spawn_blocking(move || {
        let turn = turn;
        let context = JudgeContext::read(&app)?;
        let total = request.memory_ids.len();
        let mut judged = Vec::with_capacity(total);
        let mut stopped = false;

        for (done, memory_id) in request.memory_ids.iter().enumerate() {
            if turn.is_cancelled() {
                stopped = true;
                break;
            }
            let _ = app.emit_to(
                crate::ask::MAIN_WINDOW,
                SWEEP_EVENT,
                serde_json::json!({
                    "type": "sweep-progress",
                    "memoryId": memory_id,
                    "done": done,
                    "total": total,
                }),
            );
            // A row that could not be judged does not end the sweep. Its own `judge-failed` has
            // already gone out, the panel draws it against that row, and the remaining seventy
            // memories are still worth the minutes they were going to cost.
            match judge_one(&app, &turn, &context, memory_id) {
                Ok(memory) => judged.push(memory),
                Err(reason) => {
                    eprintln!("Judging memory {memory_id} failed, the sweep continues: {reason}");
                }
            }
        }

        // A sweep has no worker of its own to settle: every row already said its own ending. What
        // is left is which of the two this run had — and a sweep says it even where it finished,
        // because the panel is drawing "31 of 84" and has to be told to stop.
        let ending = if stopped || turn.is_cancelled() {
            Ending::Stopped
        } else {
            Ending::Finished
        };
        let _ = app.emit_to(
            crate::ask::MAIN_WINDOW,
            SWEEP_EVENT,
            serde_json::json!({
                "type": format!("sweep-{}", ending.word()),
                "done": judged.len(),
                "total": total,
            }),
        );
        Ok(judged)
    })
    .await
    .map_err(|error| format!("The memory sweep failed: {error}"))?
    .map_err(CommandError::coded("memory_sweep_failed"))
}

/// Runs the four phases that produce a task's brief.
///
/// It begins an `AiTurn` like an ordinary turn does, and that is the load-bearing part rather than a
/// convenience. The turn is what Stop can reach — cancellation reaches whatever `register_worker`
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
        let context = JobContext::read_without_prompt(&app)?;
        let inventory_root = context.workspace_path().to_owned();
        let images = hydrate_chat_attachments(&app, &request.attachments)?;

        // Opened before the worker starts, so a run killed at its first phase still leaves a row
        // saying what was asked and how far it got.
        context
            .storage()
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
            // worker listing file paths if the host loop had ever read it. Which fields a job
            // carries is the context's to know now, so no assembler can answer that differently.
            context.request(Job::Brief {
                task_id: request.task_id.clone(),
                prompt,
                images,
                inventory: crate::git::tracked_files(std::path::Path::new(&inventory_root)),
            }),
        );

        // A run that reported its own ending has already recorded it, and `finish_brief` only moves
        // a row that is still running — so everything below closes the rows nothing reported.
        //
        // "Done" means there is a specification, and nothing else. A worker exiting without an error
        // is NOT the same fact: a run cancelled mid-phase is killed, which the process reports as an
        // ordinary end, so keying on the exit alone recorded a stopped run and a run that never
        // reached compose as `done` — a row claiming a brief that finished, with no spec in it.
        let finished = context
            .storage()
            .tasks()
            .read_brief(&request.task_id)
            .and_then(|brief| brief.spec)
            .is_some_and(|spec| !spec.trim().is_empty());
        let tasks = context.storage().tasks();
        let phase = tasks
            .read_brief(&request.task_id)
            .map_or_else(|| "compose".to_owned(), |brief| brief.phase);
        const WORDLESS: &str = "the plan ended before it wrote a specification";
        // The specification is what a plan was paid for, and a worker that ended without one and
        // without saying why has `WORDLESS` said for it. A cancellation is the ordinary way that
        // happens and is the user's doing; anything else is not.
        let ending = Ending::settle(
            outcome
                .as_ref()
                .map(|_| (!finished).then_some(WORDLESS))
                .map_err(String::as_str),
            turn.is_cancelled(),
        );
        // `done` rather than `finished`: that is the word the row has always been closed with, and
        // the one the panel reads back.
        let status = if matches!(ending, Ending::Finished) {
            "done"
        } else {
            ending.word()
        };
        tasks.finish_brief(&request.task_id, status, ending.reason());

        // The window is told how it ended, and not only when the worker said so. A killed worker,
        // or one that broke before its own handler ran, emits nothing — and a panel with no ending
        // sits on a spinner and then unmounts, taking the way out of a failed plan with it. The
        // renderer keeps the first ending it hears, so saying it twice costs nothing.
        if let Some(event) = ending.event("brief", &[("phase", &phase)]) {
            let _ = app.emit_to(crate::ask::MAIN_WINDOW, BRIEF_EVENT, event);
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

/// How long a worker is given to answer the cancel line before it is killed anyway.
///
/// Nobody waits this out from a command: the line is written, the watch is handed to a thread, and
/// `cancel_ai_request` returns. What it costs when a worker ignores the line is the seconds before
/// the provider operation is free again, which is why it is short — a worker that is going to
/// answer answers in the time it takes to read one line.
const WORKER_CANCEL_GRACE: Duration = Duration::from_secs(5);

/// How long the ask itself is given before the caller stops waiting for it and kills.
///
/// Small, because it is not the worker's thinking time — that is [`WORKER_CANCEL_GRACE`], and it
/// only starts once the line is out. This is the time to put one short line down a pipe, which a
/// healthy worker takes no measurable time over.
const WORKER_ASK_TIMEOUT: Duration = Duration::from_secs(1);

/// Asks the running worker to stop itself, and says whether the ask went out.
///
/// `false` is not a failure, it is the case where there is nothing to ask: no worker registered, a
/// channel already closed, a poisoned lock, or a write that did not go through in time. The caller
/// kills instead, which is what stopping a turn has always been.
///
/// Two things are kept away from the calling thread, and both used to wedge Stop on exactly the
/// worker the kill exists for. The `AI_WORKER_INPUT` guard is dropped before anything is written —
/// it used to be shadowed, so it was held across the write. And the write runs on a thread with a
/// deadline on it, because `write_worker_line` takes the shared `ProcessWriter` mutex that every
/// tool-answer thread takes, and a thread parked in `write_all` against a worker that stopped
/// reading its stdin holds that mutex for as long as the worker lives. Waited on rather than
/// forgotten: whether the line went out is what decides between granting the grace and killing now.
fn ask_worker_to_stop() -> bool {
    // The clone is taken in a block of its own so the guard is dropped at its end. Shadowing it
    // with the clone, which is what this used to do, keeps it alive to the end of the function.
    let registered = {
        let Ok(input) = AI_WORKER_INPUT.lock() else {
            return false;
        };
        input.clone()
    };
    let Some(input) = registered else {
        return false;
    };
    let (wrote, written) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = wrote.send(write_worker_line(&input, AI_CANCEL_LINE.as_bytes()).is_ok());
    });
    written.recv_timeout(WORKER_ASK_TIMEOUT).unwrap_or(false)
}

// coverage-critical-start: cancellation
pub(crate) fn cancel_ai_request_with(request_id: u64) -> Result<bool, String> {
    if ACTIVE_AI_REQUEST_ID.load(Ordering::Acquire) != request_id {
        return Ok(false);
    }
    AI_REQUEST_CANCELLED.store(true, Ordering::Release);
    // A tool call waiting for the user belongs to the turn being cancelled: left waiting, it would
    // hold a tool worker open long after the agent that asked for it is gone.
    crate::ask::cancel_user_prompts();
    // So does one waiting on the editor. Ending the worker below ends the conversation, but the
    // calls already dispatched into Rust wait on their own timeouts — minutes, for an addon request
    // that names one — and the turn is not over until they return.
    crate::cancel::cancel_turn(request_id);
    let active = AI_CHILD
        .lock()
        .map_err(|_| "The AI process lock is poisoned".to_owned())?
        .clone();
    if let Some(child) = active {
        // Asked before it is killed, and killed only if the ask could not be made or was ignored.
        // A killed worker narrates nothing: the assistant message it was part-way through never
        // reaches a `turn-state` checkpoint, so the model's memory of the stopped turn ends at the
        // last step that finished while the screen shows everything after it. A worker that answers
        // the line aborts its own agent, emits that checkpoint and its own completion, and exits.
        if ask_worker_to_stop() {
            std::thread::spawn(move || {
                let _ = stop_worker_within(&child, WORKER_CANCEL_GRACE);
            });
        } else {
            child
                .lock()
                .map_err(|_| "The AI child process lock is poisoned".to_owned())?
                .kill()
                .map_err(|error| format!("Could not stop the AI agent: {error}"))?;
        }
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
/// Recording happens here, on the Rust side of the pipe, because it is the only side that always
/// survives the ending. A cancellation asks the worker to stop and kills the one that does not
/// answer, so anything a killed worker was still holding — the refined ask, three of four research
/// sections — goes with it. A phase that has crossed this line is a phase a stopped run can still
/// show.
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
/// The filing happens on this side of the pipe for the reason the brief's does: a cancellation ends
/// with a kill for a worker that will not stop itself, and a verdict still held in Node goes with
/// it. A verdict that has crossed this line is one a stopped run still leaves behind.
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

/// The editor session, in the sentence the prompt sends the model to read.
///
/// Every field here is one the model would otherwise have spent a call to learn, and the sentence
/// is written the way the `godot_session status` answer reads so that a model which has seen one
/// recognises the other. An unreadable session is reported as offline rather than omitted: the
/// prompt tells the model to start one when it says offline, and starting one that is already
/// running answers `already_running`, which is a cheaper wrong turn than a silence it has to
/// resolve with the call this replaces.
///
/// The worktree's own path is the one field that is not here, and it used to be. It is the only
/// place a model can learn the absolute path of a checkout named after a task id, and every tool
/// that takes a path refuses one: `scripts/workspace-confinement.mjs` refuses an absolute path in
/// a shell command outright, including one that points inside the worktree, because a command is a
/// string and nothing tells that path from one that only starts the same way. So the sentence was
/// handing the model a string the rest of Gofer will not accept, and the model used it.
///
/// Measured by `scripts/bench-prompt-line.mjs` against the local Qwen3.6-27B, with the real tool
/// list — this file's catalogue plus pi's own read, write, edit and bash, whose descriptions say
/// "(relative or absolute)" and are right about the first three. Twenty seeds an arm, arms
/// interleaved inside one process, which is the only comparison that means anything here.
///
/// Asked to count the project's GDScript lines with the shell — work the worktree plainly holds —
/// the arm with no path wrote a command the confinement rule refuses **0 of 20** times, in every
/// run. The shipped sentence wrote one 7 to 20 times of 20, and every one of those named this path.
/// Keeping the path and adding the rule beside it does not rescue it: 5 to 16. In the harder
/// scenario, where the project genuinely lacks what was asked for, 19–20/20 falls to 12–16/20 —
/// what is left there is the model searching wider with `find /`, a different mistake that no
/// sentence about this session can make.
///
/// The rate moves with how the path is spelled, and the two spellings measured are a hair apart in
/// the hard scenario and three times apart in the easy one. The sign never moves. Read the sign.
pub(crate) fn describe_session<R: Runtime>(app: &AppHandle<R>) -> String {
    let Ok(Some(session)) = crate::godot_session_api::get_session(app) else {
        return "Editor session: offline. No editor is running.".to_owned();
    };
    let version = session
        .godot_version
        .as_deref()
        .unwrap_or("unknown version");
    format!(
        "Editor session: {}. Godot {version}. Every tool runs in the project root and takes paths \
         the way the project spells them, never an absolute one.",
        serde_json::to_value(session.state)
            .ok()
            .and_then(|state| state.as_str().map(str::to_owned))
            .unwrap_or_else(|| "unknown".to_owned()),
    )
}

/// Runs one worker for a turn that has already begun.
///
/// It takes the turn rather than a request id and a channel because both belong to it, and because
/// what used to be missing here is not a value but a lifetime: the gate this opens is closed by the
/// run's own `Drop`, so no path out of this function can leave it open.
///
/// It takes the request as it stands. It used to compose half of one — the system prompt and the
/// session line — for every turn that passed through, which is a second composition of something
/// [`JobContext`] had already done, and the only callers that reached the branch it was written
/// for were the two acceptance harnesses.
pub(crate) fn run_ai_worker_with<R: Runtime>(
    app: &AppHandle<R>,
    turn: &AiTurn,
    request: AiWorkerRequest,
    spawner: &impl ProcessSpawner,
) -> Result<String, String> {
    // The gate pair and the child process are this worker's, not the turn's. Entered here, so no
    // caller can spawn a worker without them — which is what `run_sweep` was doing by copying the
    // two `open()` calls into its loop, once per memory, to get the next child a gate.
    let run = WorkerRun::enter(turn);
    let request_id = turn.request_id();
    let stream = turn
        .stream()
        .ok_or_else(|| "The AI stream lock is poisoned".to_owned())?;
    let worker = ai_worker_path()?;
    let node = crate::workers::node_binary();
    let mut child = spawner
        .spawn(node.as_ref(), &[worker.into_os_string()], true)
        .map_err(|error| {
            format!(
                "Could not start the Pi AI worker with '{}': {error}. Install Node.js 22.19 or newer, or set GOFER_NODE_BINARY.",
                node.display()
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
    run.register_worker(Arc::clone(&child), Arc::clone(&stdin))?;
    let stderr_reader = std::thread::spawn(move || {
        let mut output = String::new();
        let _ = BufReader::new(stderr).read_to_string(&mut output);
        output
    });
    let mut completed = false;
    let mut completion_text = String::new();
    // The reason the worker gave for stopping. `None` for a completion that has no such field — a
    // brief and a judgement are their own events — and then the turn's own flag answers instead.
    let mut completion_reason: Option<String> = None;
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
            let kind = event
                .get("type")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default();
            // Read by name, and read first: `brief-done` and `judge-done` are prefixed like the
            // progress below them and are not progress. See [`AI_COMPLETION_EVENTS`].
            let is_done = AI_COMPLETION_EVENTS.contains(&kind);
            // A brief's progress is not part of an assistant message, so it does not ride the
            // turn's stream — the renderer's timeline drops every event it does not recognise, by
            // design, and a phase is not one of the things it draws. It goes out as a window event
            // instead, and anything worth surviving a stop is written to the database on the way.
            if !is_done && brief_task.is_some() && kind.starts_with("brief-") {
                handle_brief_event(app, brief_task.as_deref(), kind, &event);
                continue;
            }
            // A judgement's progress is not part of an assistant message either, and the panel
            // reading it is not the chat. Same rule, same reason: the timeline drops what it does
            // not draw, so this goes out as a window event and its verdict is filed on the way.
            if !is_done
                && let Some(memory_id) = judged_memory.as_deref()
                && kind.starts_with("judge-")
            {
                handle_judge_event(app, memory_id, kind, &event);
                continue;
            }
            if is_done {
                completed = true;
                completion_text = event
                    .get("text")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default()
                    .to_owned();
                completion_reason = event
                    .get("stopReason")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned);
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
    run.close_gate_before_draining();
    drain_tool_workers(tool_workers);
    streamed?;

    // The answer is in, so the turn is over, and the worker is let go of rather than waited for.
    // What it spends its last moments on is its own business — closing the connection the provider
    // cached, exiting — and measured against the real endpoint that is about three seconds. Three
    // seconds of a composer that says Gofer is working after Gofer has answered.
    if completed {
        reap_worker(Arc::clone(&child), stderr_reader);
        // A stopped turn is not a completed one, whatever the worker managed to write on its way
        // out. The half-answer has already been streamed and the transcript already checkpointed —
        // what is refused here is the caller filing it as what the task achieved.
        if the_worker_says_it_was_stopped(completion_reason.as_deref(), turn) {
            return Ok(String::new());
        }
        return Ok(completion_text);
    }

    let status = stop_worker(&child)?;
    let stderr = stderr_reader
        .join()
        .map_err(|_| "Could not collect Pi AI worker errors".to_owned())?;
    // Read before the exit status, because a stop now has two ways out and they report differently:
    // a worker that answered the cancel line ends its own turn and exits cleanly, and one that had
    // to be killed does not. Both are the user pressing Stop, and neither is a failure to show the
    // user — a killed process names its signal on stderr and that is not a fault they can act on.
    //
    // The stderr is not thrown away with it, though. A worker can also die of something else in the
    // seconds after Stop — an out-of-memory kill, a Node fault — and that arrives here looking
    // exactly the same. Filed silently, the one diagnostic of it was gone; logged, it is still
    // somewhere to look when a stop is followed by a session that will not start.
    if turn.is_cancelled() {
        if !status.success {
            let detail = stderr.trim();
            eprintln!(
                "The stopped AI worker exited with {}{}",
                status.description,
                if detail.is_empty() {
                    String::new()
                } else {
                    format!(": {detail}")
                }
            );
        }
        return Ok(String::new());
    }
    if !status.success {
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

/// Whether a completed turn is one the user stopped, asking the worker before the flag.
///
/// The worker's own `stopReason` decides, because it is what the renderer decides from. The two used
/// to answer different questions: the screen read the reason on the completion, and this read a flag
/// set the moment Stop was pressed. Since a worker answers the cancel line and finishes its turn
/// rather than being killed, the window between them is reachable — a `done` carrying `stop`, and a
/// Stop that arrived microseconds before it. The turn then returned nothing, `remember_completed_turn`
/// filed nothing, and the screen showed the same message complete.
///
/// The flag is still the answer for a completion with no reason to give: `brief-done` and
/// `judge-done` carry a spec and a verdict, not a stop reason.
fn the_worker_says_it_was_stopped(reason: Option<&str>, turn: &AiTurn) -> bool {
    reason.map_or_else(|| turn.is_cancelled(), |reason| reason == AI_STOPPED_REASON)
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
    stop_worker_within(child, WORKER_EXIT_GRACE)
}

/// The same ending, with the moment named by the caller.
///
/// Two callers want different moments for the same reason from opposite ends. A finished worker is
/// closing the connection it cached and is worth waiting out; a cancelled one has been asked to
/// stop and is holding the provider operation while it does not answer.
fn stop_worker_within(
    child: &SharedChildProcess,
    grace: Duration,
) -> Result<crate::process::ProcessStatus, String> {
    let deadline = std::time::Instant::now() + grace;
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
    use std::ffi::{OsStr, OsString};
    use std::fs;

    use std::sync::atomic::Ordering as AtomicOrdering;
    use tempfile::TempDir;

    /// One key on the command line has to land in the slot its driver reads.
    ///
    /// The failure this pins ran four live turns into `No API key for provider: openrouter` in
    /// 0.6 seconds each. Naming the OpenRouter driver became possible before the credential
    /// followed it, so `GOFER_LIVE_API_KEY` kept filling the OpenAI-compatible slot and the host
    /// looked up a slot nothing had written.
    #[cfg(feature = "godot-acceptance")]
    #[test]
    fn a_suite_key_fills_the_slot_its_driver_reads() {
        use crate::settings::AiConnectionType;

        let openrouter = Credentials::for_driver(
            AiConnectionType::Openrouter,
            Some("or-key".to_owned()),
            None,
        );
        assert_eq!(openrouter.openrouter_api_key.as_deref(), Some("or-key"));
        // Not both: filling the default slot too would authenticate a local server with a key
        // meant for OpenRouter.
        assert_eq!(openrouter.api_key, None);

        let local = Credentials::for_driver(
            AiConnectionType::OpenaiCompatible,
            Some("local-key".to_owned()),
            None,
        );
        assert_eq!(local.api_key.as_deref(), Some("local-key"));
        assert_eq!(local.openrouter_api_key, None);

        // ChatGPT carries an OAuth blob rather than a key, and it travels whatever the driver.
        let chatgpt = Credentials::for_driver(
            AiConnectionType::OpenaiCodex,
            None,
            Some(serde_json::json!({"access_token": "t"})),
        );
        assert_eq!(chatgpt.api_key, None);
        assert_eq!(chatgpt.openrouter_api_key, None);
        assert!(chatgpt.oauth_credential.is_some());
    }

    /// The turn's statics are process-wide, so the tests that move them take turns.
    static AI_TEST_LOCK: Mutex<()> = Mutex::new(());

    /// A judgement has exactly one ending, and a verdict is one of them.
    ///
    /// Stop and a finished judgement can land in the same instant: the worker answered, the turn
    /// was cancelled, and the row was sent `judge-stopped` *and* pushed into the sweep's answer.
    /// The panel drew it as stopped while the list it was handed carried its verdict.
    #[test]
    fn a_judgement_that_produced_a_verdict_reports_no_ending() {
        let ending = |failure: Option<&'static str>, cancelled: bool| {
            Ending::settle(failure.map_or(Ok(None), Err), cancelled)
                .event("judge", &[("memoryId", "m1")])
        };
        assert_eq!(ending(None, false), None);
        assert_eq!(
            ending(None, true),
            None,
            "cancelled the instant it finished is still finished"
        );
        assert_eq!(
            ending(Some("it used all of its steps"), false),
            Some(serde_json::json!({
                "type": "judge-failed",
                "memoryId": "m1",
                "reason": "it used all of its steps",
            }))
        );
        assert_eq!(
            ending(Some("the turn was stopped"), true),
            Some(serde_json::json!({"type": "judge-stopped", "memoryId": "m1"}))
        );
    }

    /// The ending contract, in the one place it is now decided for all three jobs.
    ///
    /// It was written three times in this file and read three different ways. A worker exiting
    /// without an error is not a finished job — cancelling kills it, and a killed process reports
    /// an ordinary end — so what a run has to show for itself is the fact that decides, and Stop
    /// beats a failure because a broken pipe is what killing a worker looks like from here.
    #[test]
    fn one_settlement_decides_every_job_ending() {
        const WORDLESS: &str = "the plan ended before it wrote a specification";
        assert_eq!(Ending::settle(Ok(None), false), Ending::Finished);
        assert_eq!(
            Ending::settle(Ok(None), true),
            Ending::Finished,
            "what it was paid for is there, whenever Stop arrived"
        );
        assert_eq!(Ending::settle(Ok(Some(WORDLESS)), true), Ending::Stopped);
        assert_eq!(
            Ending::settle(Ok(Some(WORDLESS)), false),
            Ending::Failed(WORDLESS),
            "it produced nothing and said nothing about why"
        );
        assert_eq!(
            Ending::settle(Err("the provider refused"), false),
            Ending::Failed("the provider refused")
        );
        assert_eq!(
            Ending::settle(Err("Could not read Pi AI output"), true),
            Ending::Stopped,
            "the pipe broke because the user killed the worker"
        );

        // The two words a brief closes its row with, which are not the two the wire uses.
        assert_eq!(Ending::Failed(WORDLESS).reason(), Some(WORDLESS));
        assert_eq!(Ending::Stopped.reason(), None);
        assert_eq!(
            Ending::Stopped.event("brief", &[("phase", "research")]),
            Some(serde_json::json!({"type": "brief-stopped", "phase": "research"}))
        );
        assert_eq!(
            format!("sweep-{}", Ending::Finished.word()),
            "sweep-finished"
        );
        assert_eq!(format!("sweep-{}", Ending::Stopped.word()), "sweep-stopped");
    }

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
            .create(&storage.switch_with_no_turn_to_refuse(&|_| Ok(())))
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
                session_context: Some("Editor session: offline. No editor is running.".to_owned()),
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
        assert_eq!(
            encoded["sessionContext"],
            serde_json::json!("Editor session: offline. No editor is running.")
        );
        // Named once, not twice: a snake_case key beside the camelCase one is a worker reading the
        // one it understands while the other rides along unused.
        for stale in [
            "agent_messages",
            "is_retry",
            "memory_context",
            "session_context",
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
            openrouter_api_key: None,
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
                session_context: None,
            },
        }
    }

    /// A job context from parts: injected settings, injected storage, and no keyring anywhere.
    ///
    /// This is the seam the four assemblers were missing. `run_ai_worker_with` has taken an
    /// injected spawner for as long as it has been tested; everything above it read four
    /// credentials off the machine, so not one of the four could be driven at all — and the two
    /// tests that looked like coverage built the request by hand and asserted its JSON, which is
    /// the serde attributes rather than the code that fills it in.
    ///
    /// The prompt is injected verbatim rather than resolved, so that a second composition anywhere
    /// downstream is visible in what the worker is sent.
    fn a_context<R: Runtime>(
        app: &AppHandle<R>,
        directory: &TempDir,
        credentials: Credentials,
        system_prompt: &str,
    ) -> JobContext {
        let workspace = directory.path().join("workspace");
        fs::create_dir_all(&workspace).expect("workspace");
        let storage =
            crate::storage::ProjectStorage::open(&directory.path().join("data"), &workspace)
                .expect("open project storage");
        JobContext {
            ai: AiSettings::default(),
            credentials,
            storage,
            workspace_path: workspace.display().to_string(),
            system_prompt: Some(system_prompt.to_owned()),
            session_context: describe_session(app),
        }
    }

    /// Everything this machine could have stored, so a job that must not carry one is visible.
    fn every_credential() -> Credentials {
        Credentials {
            api_key: Some("ai-default-key".to_owned()),
            openrouter_api_key: Some("openrouter-key".to_owned()),
            brave_api_key: Some("brave-key".to_owned()),
            oauth_credential: Some(serde_json::json!({"type": "oauth", "access": "token"})),
        }
    }

    /// A brief is not a chat turn, and the context is what makes that true.
    ///
    /// The phases carry their own instructions, in full, and none of them is the chat agent — so a
    /// brief carries no system prompt, no transcript and no project memory. That was a property of
    /// four hand-built requests until now, and the assembler that got it wrong would have put a
    /// Godot editor's tool guidance in front of a worker listing file paths with nothing failing.
    #[test]
    fn a_brief_carries_no_system_prompt_and_no_memory() {
        let directory = TempDir::new().expect("temporary directory");
        let app = mock_app();
        let context = a_context(
            app.handle(),
            &directory,
            every_credential(),
            "the project's own prompt",
        );

        let encoded = serde_json::to_value(context.request(Job::Brief {
            task_id: "task-9".to_owned(),
            prompt: "add a pause menu".to_owned(),
            images: Vec::new(),
            inventory: None,
        }))
        .expect("serialize the request");

        assert_eq!(encoded["mode"], "brief");
        assert!(encoded.get("systemPrompt").is_none(), "{encoded}");
        assert!(encoded.get("sessionContext").is_none(), "{encoded}");
        assert!(encoded.get("memoryContext").is_none(), "{encoded}");
        assert!(encoded.get("agentMessages").is_none(), "{encoded}");
        assert!(encoded.get("messages").is_none(), "{encoded}");
        // The task is the cache key: what is re-sent belongs to the task, not to the phase.
        assert_eq!(encoded["sessionId"], "task-9");
        // The catalogue is the router's own, at every construction site, because it only ever had
        // one legal value and no caller was left to name it.
        assert_eq!(
            encoded["tools"].as_array().expect("the catalogue").len(),
            ai_tools::CATALOG.len()
        );
    }

    /// A judging child holds `read` and `bash`, and asks one question about one row.
    ///
    /// So it is sent no search key — nothing it holds reaches the web — and no cache key: there is
    /// no prefix a later ask would reuse, and keying it per memory would fragment the cache the
    /// conversation depends on. Both were comments beside a hand-written `None`, at one of the
    /// five sites that spelled every field out.
    #[test]
    fn a_judgement_carries_no_search_key_and_no_cache_key() {
        let directory = TempDir::new().expect("temporary directory");
        let app = mock_app();
        let context = a_context(
            app.handle(),
            &directory,
            every_credential(),
            "the project's own prompt",
        );

        let judgement = serde_json::to_value(context.request(Job::Judge {
            memory_id: "01a0".to_owned(),
            memory: JudgedMemory {
                id: "01a0".to_owned(),
                content: "Deleted GRAYZONE.md.".to_owned(),
                anchors: Vec::new(),
            },
        }))
        .expect("serialize the request");

        assert_eq!(judgement["mode"], "judge");
        assert_eq!(judgement["braveApiKey"], serde_json::Value::Null);
        assert_eq!(judgement["sessionId"], serde_json::Value::Null);
        // The keys it can use still travel: the child is read-only, not credential-less.
        assert_eq!(judgement["apiKey"], "ai-default-key");
        assert_eq!(judgement["openrouterApiKey"], "openrouter-key");

        // And the same context sends both to a chat turn, so what is withheld is the job's doing
        // rather than an empty keyring's.
        let turn = serde_json::to_value(context.request(Job::Turn {
            task_id: Some("task-1".to_owned()),
            messages: Vec::new(),
            agent_messages: None,
            is_retry: false,
            memory_context: None,
        }))
        .expect("serialize the request");
        assert_eq!(turn["braveApiKey"], "brave-key");
        assert_eq!(turn["sessionId"], "task-1");
    }

    /// The prompt is composed once, and what the context composed is what the worker is sent.
    ///
    /// It used to be composed twice: `run_turn` resolved the project's stored text, and
    /// `run_ai_worker_with` resolved it again from what it was handed. The second call took the
    /// "it already has one" branch every time, so its `strict_typing` argument — read from a
    /// second settings function with a second error policy — decided nothing, and the branch it
    /// was written for was reached only by the two acceptance harnesses.
    ///
    /// The stale engine line is what makes a second composition visible: resolving refreshes it to
    /// the version this build pins, so a prompt that arrives at the worker unrefreshed is a prompt
    /// nothing composed on the way out.
    #[test]
    fn a_chat_turn_sends_the_prompt_its_context_composed_and_no_other() {
        let _test = AI_TEST_LOCK.lock().expect("AI test lock");
        // A turn closes the process-wide approval gate when it ends, so this waits its turn
        // behind the `approvals` tests rather than settling a prompt one of them is waiting on.
        let _gate = crate::approvals::serialize_gate_tests();
        let directory = TempDir::new().expect("temporary directory");
        let app = mock_app();
        let composed = concat!(
            "You are Gofer, and this is my project.\n",
            "- Version 4.6.0 stable, released 2025-01-01 — newer than your training data\n",
        );
        let context = a_context(app.handle(), &directory, Credentials::default(), composed);
        let spawner = FakeProcessSpawner::new(
            "GOFER_AI_EVENT:{\"type\":\"done\",\"text\":\"Hi\",\"agentMessages\":[],\"usage\":{},\"model\":\"fake\"}\n",
            "",
            true,
        );
        let (stream, _streamed) = recording_stream();

        run_ai_worker_with(
            app.handle(),
            &a_turn(51, &stream),
            context.request(Job::Turn {
                task_id: Some("task-1".to_owned()),
                messages: Vec::new(),
                agent_messages: None,
                is_retry: false,
                memory_context: None,
            }),
            &spawner,
        )
        .expect("fake AI completion");

        assert_eq!(
            spawner.sent()[0]["systemPrompt"],
            composed,
            "the turn sent a prompt somebody composed a second time"
        );

        // And the one composition the context does is the project's own text with that line put
        // right — the read `run_turn` used to make inline, on its way to the same string.
        context
            .storage()
            .project()
            .write_agent_prompt(Some(composed))
            .expect("store the project's own prompt");
        let resolved = resolve_prompt(context.storage(), true).expect("resolve the prompt");
        assert!(
            resolved.starts_with("You are Gofer, and this is my project."),
            "the project's own text is what it sends: {resolved}"
        );
        assert!(
            resolved.contains(crate::godot_session::REQUIRED_ENGINE_VERSION),
            "the pinned engine has to reach the model: {resolved}"
        );
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

    /// A completion decides whether it was stopped, and the screen reads the same field it does.
    ///
    /// Since a worker answers the cancel line and ends its own turn rather than being killed, Stop
    /// and a finished turn can land microseconds apart. The flag said stopped, the worker's own
    /// `done` said `stop` — and the two sides then disagreed about one message: nothing was filed as
    /// what the task achieved, while `chat-timeline.ts` drew it complete from the very same event.
    #[test]
    fn a_turn_that_finished_a_hair_before_stop_is_still_filed_as_finished() {
        let _test = AI_TEST_LOCK.lock().expect("AI test lock");
        let _gate = crate::approvals::serialize_gate_tests();
        let app = mock_app();
        let (stream, _streamed) = recording_stream();

        let finished = FakeProcessSpawner::new(
            concat!(
                r#"GOFER_AI_EVENT:{"type":"done","text":"Hello","stopReason":"stop","#,
                r#""agentMessages":[],"usage":{},"model":"fake"}"#,
                "\n"
            ),
            "",
            true,
        );
        let turn = a_turn(20, &stream);
        turn.mark_cancelled(true);
        assert_eq!(
            run_ai_worker_with(app.handle(), &turn, worker_request(), &finished)
                .expect("a completed turn"),
            "Hello",
            "the worker finished this turn, whenever the flag was set"
        );
        drop(turn);

        // And a worker that really was cut off says so in the same field, and keeps nothing.
        let stopped = FakeProcessSpawner::new(
            concat!(
                r#"GOFER_AI_EVENT:{"type":"done","text":"Half an ans","stopReason":"aborted","#,
                r#""agentMessages":[],"usage":{},"model":"fake"}"#,
                "\n"
            ),
            "",
            true,
        );
        let turn = a_turn(21, &stream);
        assert_eq!(
            run_ai_worker_with(app.handle(), &turn, worker_request(), &stopped)
                .expect("a stopped turn"),
            "",
            "a half-answer is not what the task achieved"
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

    /// Both gates are open, or neither is. Whichever half a caller remembers is not the question.
    ///
    /// The pair was opened by hand at seven sites and the harness that copied it got it wrong: it
    /// took the approval half and left the question half shut, so every `ask_user` inside a journey
    /// was refused by a gate nothing had opened. `WorkerRun` is what makes that unspellable — there
    /// is one call in, one call out, and a test that watches both registries rather than the one it
    /// happened to be about.
    #[test]
    fn a_worker_run_opens_both_gates_and_its_drop_closes_both() {
        let _test = AI_TEST_LOCK.lock().expect("AI test lock");
        let _gate = crate::approvals::serialize_gate_tests();
        let (stream, _streamed) = recording_stream();
        let turn = a_turn(33, &stream);

        assert!(
            !crate::approvals::is_open() && !crate::ask::questions_open(),
            "a turn is not a worker: nothing is waiting on a user until one is running"
        );

        {
            let _run = WorkerRun::enter(&turn);
            assert!(
                crate::approvals::is_open() && crate::ask::questions_open(),
                "entering a run is what opens both gates"
            );
        }

        assert!(
            !crate::approvals::is_open() && !crate::ask::questions_open(),
            "the worker ended, so nothing may still be waiting on the user"
        );

        // And the next worker of the same turn gets them back, which is the sweep: one turn, one
        // provider operation, eighty children, each spawned after the last one's exit shut the
        // gates behind it. `run_sweep` used to raise them again by hand at the top of its loop.
        let _second = WorkerRun::enter(&turn);
        assert!(
            crate::approvals::is_open() && crate::ask::questions_open(),
            "a second worker in the same turn has its own gates"
        );
    }

    /// No worker, no gate — on every way out of one, not only the clean one.
    ///
    /// The gate used to be opened inside the worker and closed a hundred lines later, just before
    /// the tool threads were joined. Six things between those two lines return `Err`: taking the
    /// child's three pipes, serializing the request, writing it, and locking the child. Each left
    /// the gate open behind it, and the guard that reset the turn's other five values knew nothing
    /// about it. An open gate with no turn is a prompt that registers, waits out its whole timeout,
    /// and is answered by nobody.
    ///
    /// A spawn that fails is the earliest of those paths and the easiest to provoke; the assertion
    /// is about the run ending, not about which failure ended it.
    #[test]
    fn a_turn_that_fails_before_its_worker_starts_still_closes_both_gates() {
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
                run_ai_worker_with(app.handle(), &turn, worker_request(), &missing).is_err(),
                "the worker cannot start"
            );
            assert!(
                !crate::approvals::is_open() && !crate::ask::questions_open(),
                "the worker never started, so nothing may be left waiting on the user"
            );
        }

        assert!(
            !crate::approvals::is_open() && !crate::ask::questions_open(),
            "the turn ended, so nothing may still be waiting on the user"
        );
    }

    /// What the gates were when a worker was spawned, so a run can be watched from where it
    /// starts rather than from outside it.
    ///
    /// Recorded at the spawn because that is the edge that matters: everything the worker does
    /// afterwards — asking, answering, exiting — happens on threads of its own, and a fake worker
    /// whose whole output is already buffered can finish before its own tool thread reaches the
    /// gate. Watching the tool call's answer would time that race rather than the fact.
    struct WatchedSpawner {
        inner: FakeProcessSpawner,
        gates: Arc<Mutex<Vec<(bool, bool)>>>,
    }

    impl ProcessSpawner for WatchedSpawner {
        fn output(
            &self,
            program: &OsStr,
            arguments: &[OsString],
        ) -> std::io::Result<crate::process::ProcessOutput> {
            self.inner.output(program, arguments)
        }

        fn spawn(
            &self,
            program: &OsStr,
            arguments: &[OsString],
            piped_stdin: bool,
        ) -> std::io::Result<Box<dyn crate::process::ChildProcess>> {
            self.gates
                .lock()
                .expect("recorded gates")
                .push((crate::approvals::is_open(), crate::ask::questions_open()));
            self.inner.spawn(program, arguments, piped_stdin)
        }
    }

    /**
     * A sweep is one turn holding many workers, and every one of them is spawned into open gates.
     *
     * This is the failure the two hand-copied `open()` calls at the top of `run_sweep`'s loop were
     * papering over: the first memory's worker closed both gates on its way out, `AiTurn` only
     * opened them once, and the seventy-nine children after it would have had every approval and
     * every question refused the moment they asked. Take the two calls out without moving the
     * lifetime and this is what is left — which is why it is asserted per worker rather than once.
     */
    #[test]
    fn every_worker_in_one_turn_is_spawned_into_open_gates() {
        let _test = AI_TEST_LOCK.lock().expect("AI test lock");
        let _gate = crate::approvals::serialize_gate_tests();
        let app = mock_app();
        let (stream, _streamed) = recording_stream();
        let turn = a_turn(34, &stream);
        let gates = Arc::new(Mutex::new(Vec::new()));

        for _ in 0..2 {
            let spawner = WatchedSpawner {
                inner: FakeProcessSpawner::new(
                    "GOFER_AI_EVENT:{\"type\":\"done\",\"text\":\"Judged\",\"agentMessages\":[],\"usage\":{},\"model\":\"fake\"}\n",
                    "",
                    true,
                ),
                gates: Arc::clone(&gates),
            };
            assert_eq!(
                run_ai_worker_with(app.handle(), &turn, worker_request(), &spawner)
                    .expect("fake AI completion"),
                "Judged"
            );
        }

        assert_eq!(
            gates.lock().expect("recorded gates").as_slice(),
            [(true, true), (true, true)],
            "every worker of a turn is spawned with both gates open"
        );
        assert!(
            !crate::approvals::is_open() && !crate::ask::questions_open(),
            "and the last one closed them behind it"
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
        let directory = TempDir::new().expect("temporary directory");
        let app = mock_app();
        // Composed the way the application composes one, rather than assembled here: the session
        // line and the catalogue asserted below are the context's, and this is the only test that
        // watches them cross the pipe.
        let context = a_context(
            app.handle(),
            &directory,
            Credentials::default(),
            "the project's own prompt",
        );
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
                context.request(Job::Turn {
                    task_id: Some("task-1".to_owned()),
                    messages: Vec::new(),
                    agent_messages: None,
                    is_retry: false,
                    memory_context: None,
                }),
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
        // The state the prompt sends the model to read, rather than the call it used to make: 58
        // of 72 recorded turns opened with `godot_session status`, and in 54 it was the only call
        // of the ask that issued it. Nothing is bound here, so what it must say is offline.
        assert_eq!(
            sent[0]["sessionContext"],
            "Editor session: offline. No editor is running."
        );
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

    /// A stdin the test can read back, because what is being proved is what was written on it.
    struct RecordingWriter(Arc<Mutex<Vec<u8>>>);

    impl Write for RecordingWriter {
        fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
            self.0
                .lock()
                .map_err(|_| std::io::Error::other("recording stdin lock poisoned"))?
                .extend_from_slice(buffer);
            Ok(buffer.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    /// A child that will not go until it is made to.
    ///
    /// The fakes beside the trait answer `try_wait` with a status the first time they are asked,
    /// which is the one thing the backstop cannot be proved against: a worker that has already
    /// exited is never killed, so a kill that never happens looks exactly like one that was not
    /// needed.
    struct StubbornChild(Arc<AtomicBool>);

    impl StubbornChild {
        fn status(&self) -> ProcessStatus {
            ProcessStatus {
                success: false,
                code: None,
                description: "killed".to_owned(),
            }
        }
    }

    impl crate::process::ChildProcess for StubbornChild {
        fn take_stdin(&mut self) -> Option<crate::process::ProcessWriter> {
            None
        }

        fn take_stdout(&mut self) -> Option<crate::process::ProcessReader> {
            None
        }

        fn take_stderr(&mut self) -> Option<crate::process::ProcessReader> {
            None
        }

        fn try_wait(&mut self) -> std::io::Result<Option<ProcessStatus>> {
            Ok(self.0.load(AtomicOrdering::Acquire).then(|| self.status()))
        }

        fn wait(&mut self) -> std::io::Result<ProcessStatus> {
            Ok(self.status())
        }

        fn kill(&mut self) -> std::io::Result<()> {
            self.0.store(true, AtomicOrdering::Release);
            Ok(())
        }
    }

    /// Hands out one child that was built before the run started.
    ///
    /// `FakeProcessSpawner` scripts stdout from a string, which is a worker that has already said
    /// everything it will ever say. A cancellation has to reach a worker that is still running, so
    /// this one's stdout is a pipe the test writes into while the loop reads it.
    struct PreparedSpawner(Mutex<Option<FakeChildProcess>>);

    impl crate::process::ProcessSpawner for PreparedSpawner {
        fn output(
            &self,
            _: &OsStr,
            _: &[OsString],
        ) -> std::io::Result<crate::process::ProcessOutput> {
            unreachable!("a prepared worker is never asked for command output")
        }

        fn spawn(
            &self,
            _: &OsStr,
            _: &[OsString],
            _: bool,
        ) -> std::io::Result<Box<dyn crate::process::ChildProcess>> {
            self.0
                .lock()
                .expect("prepared child lock")
                .take()
                .map(|child| Box::new(child) as Box<dyn crate::process::ChildProcess>)
                .ok_or_else(|| std::io::Error::other("the prepared worker was already spawned"))
        }
    }

    /// A stream that a test can block on rather than poll.
    ///
    /// The recorder above answers "what has arrived", which cannot be asked before something has.
    /// Waiting for the first event is how this test knows the run has registered its worker without
    /// guessing at a moment.
    fn signalling_stream() -> (
        tauri::ipc::Channel<AiStreamPayload>,
        std::sync::mpsc::Receiver<serde_json::Value>,
    ) {
        let (sender, receiver) = std::sync::mpsc::channel();
        let channel = tauri::ipc::Channel::new(move |body| {
            if let tauri::ipc::InvokeResponseBody::Json(json) = body
                && let Ok(value) = serde_json::from_str::<serde_json::Value>(&json)
            {
                let _ = sender.send(value);
            }
            Ok(())
        });
        (channel, receiver)
    }

    /// Stopping a turn is two asks, and this is the first one.
    ///
    /// It was one: `kill()`, and nothing else. So every abort branch in the worker — the listener
    /// that calls `agent.abort()`, the `aborted` completion it builds, the interruptible retry wait
    /// — was threaded through fifteen functions and reached by no running Gofer, because nothing
    /// ever built the `AbortController` they read. What a killed worker loses is the assistant
    /// message that was in flight: no `turn-state` checkpoint is emitted for it, so the model's
    /// memory of a stopped turn ends at the last step that finished while the screen shows
    /// everything after it.
    ///
    /// Driven against a worker that is still running, because that is the only state a cancellation
    /// happens in and a scripted stdout is a worker that has already finished.
    #[test]
    fn cancelling_a_running_turn_asks_the_worker_to_stop_on_its_own_channel() {
        let _test = AI_TEST_LOCK.lock().expect("AI test lock");
        // A turn closes the process-wide approval gate when it ends, so this waits its turn
        // behind the `approvals` tests rather than settling a prompt one of them is waiting on.
        let _gate = crate::approvals::serialize_gate_tests();
        let app = mock_app();
        let (stream, events) = signalling_stream();

        let (worker_stdout, mut say) = std::io::pipe().expect("worker stdout pipe");
        let (worker_stderr, quiet) = std::io::pipe().expect("worker stderr pipe");
        drop(quiet);
        let written = Arc::new(Mutex::new(Vec::new()));
        let killed = Arc::new(AtomicBool::new(false));
        let spawner = PreparedSpawner(Mutex::new(Some(FakeChildProcess {
            stdin: Some(Box::new(RecordingWriter(Arc::clone(&written)))),
            stdout: Some(Box::new(worker_stdout)),
            stderr: Some(Box::new(worker_stderr)),
            status: ProcessStatus {
                success: true,
                code: Some(0),
                description: "exit status: 0".to_owned(),
            },
            killed: Arc::clone(&killed),
        })));

        let turn = a_turn(91, &stream);
        let handle = app.handle().clone();
        let answer = std::thread::scope(|scope| {
            let running =
                scope.spawn(|| run_ai_worker_with(&handle, &turn, worker_request(), &spawner));
            // The worker has started to answer, which is what says the run is past the point where
            // it registered its channel. Waited for rather than assumed: nothing else in this test
            // knows when the reading loop began.
            say.write_all(b"GOFER_AI_EVENT:{\"type\":\"text-delta\",\"delta\":\"Half an \"}\n")
                .expect("stream a delta");
            let first = events.recv().expect("the turn streams its first delta");
            assert_eq!(first["event"]["type"], "text-delta");

            assert!(cancel_ai_request_with(91).expect("cancel the running turn"));

            // The worker answers the way a worker does: its own last events, then its own exit.
            say.write_all(
                b"GOFER_AI_EVENT:{\"type\":\"turn-state\",\"agentMessages\":[{\"role\":\"assistant\"}]}\n",
            )
            .expect("stream the checkpoint");
            say.write_all(
                b"GOFER_AI_EVENT:{\"type\":\"done\",\"text\":\"Half an \",\"thinking\":\"\",\"stopReason\":\"aborted\",\"agentMessages\":[],\"usage\":{},\"model\":\"fake\"}\n",
            )
            .expect("stream the completion");
            drop(say);
            running.join().expect("the worker run ends")
        });

        // The whole finding, in one assertion: the stop reached the worker as a line on the channel
        // it was already reading, ahead of the kill that used to be all there was.
        let sent = String::from_utf8(written.lock().expect("recorded stdin").clone())
            .expect("the worker channel is UTF-8");
        let lines: Vec<&str> = sent.lines().collect();
        assert_eq!(
            lines.get(1).copied(),
            Some(AI_CANCEL_LINE),
            "the cancel line follows the startup context on the worker's own channel"
        );
        assert!(
            !killed.load(AtomicOrdering::Acquire),
            "a worker that was asked to stop is given the chance to answer before it is killed"
        );
        // What it managed to say still reached the renderer, in the order it was said: the abort
        // the cancellation minted, then the worker's own checkpoint and completion behind it. That
        // checkpoint is what a bare kill loses.
        let rest: Vec<String> = events
            .try_iter()
            .map(|value| {
                value["event"]["type"]
                    .as_str()
                    .unwrap_or_default()
                    .to_owned()
            })
            .collect();
        assert_eq!(rest, ["aborted", "turn-state", "done"]);
        // And the turn reports nothing to remember: a half answer is not what the task achieved.
        assert_eq!(answer.expect("a stopped turn is not a failed one"), "");

        crate::cancel::clear_if_cancelled(91);
    }

    /// The backstop, which the ask does not replace: a worker that will not answer still dies.
    #[test]
    fn a_worker_that_does_not_answer_the_cancel_line_is_still_killed() {
        let killed = Arc::new(AtomicBool::new(false));
        let child: SharedChildProcess =
            Arc::new(Mutex::new(Box::new(StubbornChild(Arc::clone(&killed)))));
        // No grace at all, so the deadline is already past on the first poll and the kill is the
        // first thing that happens rather than something this test sits through.
        let status = stop_worker_within(&child, Duration::ZERO).expect("stop a stubborn worker");
        assert!(killed.load(AtomicOrdering::Acquire));
        assert!(!status.success);
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

use base64::Engine;
use keyring::{Entry, Error as KeyringError};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, Runtime};

pub mod addon;
mod ai_tools;
mod approvals;
mod debug;
mod files;
mod gdformat;
mod git;
mod godot_dap;
mod godot_lsp;
mod godot_rpc;
mod godot_session;
mod godot_session_api;
mod health;
// Drives the staged addon inside a real editor. Gated so the default gate needs no Godot binary.
#[cfg(all(test, feature = "godot-acceptance"))]
mod godot_addon_acceptance;
// Drives the native language server inside a real editor, under the same gate.
#[cfg(all(test, feature = "godot-acceptance"))]
mod godot_lsp_acceptance;
// Drives the script commands Monaco calls against that same editor.
#[cfg(all(test, feature = "godot-acceptance"))]
mod godot_script_acceptance;
// Drives the native debug adapter inside a real editor running the fixture game, same gate.
#[cfg(all(test, feature = "godot-acceptance"))]
mod godot_dap_acceptance;
#[cfg(all(test, feature = "godot-acceptance"))]
mod godot_runtime_acceptance;
// Drives one AI turn through the router into that same editor: the step 14 done-criteria.
#[cfg(all(test, feature = "godot-acceptance"))]
mod godot_ai_acceptance;
// Drives the final journey: one task worktree from connect to task switch, through the supervisor
// the renderer starts and the router the agent calls, with no transport bound by the test itself.
#[cfg(all(test, feature = "godot-acceptance"))]
mod godot_journey_acceptance;
mod memory;
mod paths;
mod process;
pub mod protocol_v2;
mod rag;
mod script;
mod storage;

use process::{ProcessSpawner, SystemProcessSpawner};
use storage::{
    BackupResult, MaintenanceResult, MergeTaskResult, ProjectStorage, SaveMemoryEmbeddingRequest,
    SearchMemoryRequest, StorageSlot, StoredAttachment, StoredChat, TaskRecord,
    UpsertMemoryRequest,
};

const API_KEY_SERVICE: &str = "com.gofer.desktop";
const API_KEY_USERNAME: &str = "ai-default";
const AI_EVENT_PREFIX: &str = "GOFER_AI_EVENT:";
/// The worker's half of the duplex channel: agent events keep their prefix, tool requests get
/// their own, and anything unprefixed on stdout stays diagnostic output rather than protocol.
const AI_TOOL_PREFIX: &str = "GOFER_AI_TOOL:";
const SETTINGS_FILE_NAME: &str = "settings.json";
/// Where the workspace folder and the Godot executable the user chose are recorded.
///
/// Deliberately not part of `settings.json`: the renderer round-trips that whole document when it
/// saves the AI connection, and a field it does not know about would be erased by the next save.
const ENVIRONMENT_FILE_NAME: &str = "environment.json";
const CHAT_ATTACHMENTS_DIRECTORY: &str = "chat-attachments";
const SETTINGS_VERSION: u32 = 1;
const MAX_CHAT_ATTACHMENT_BYTES: usize = 10 * 1024 * 1024;
const MAX_CHAT_ATTACHMENT_BASE64_BYTES: usize = MAX_CHAT_ATTACHMENT_BYTES.div_ceil(3) * 4;
const MAX_CHAT_MESSAGES: usize = 200;
const MAX_CHAT_MESSAGE_BYTES: usize = 256 * 1024;
const MAX_CHAT_TEXT_BYTES: usize = 4 * 1024 * 1024;
const MAX_AGENT_MESSAGES_BYTES: usize = 8 * 1024 * 1024;
const MAX_API_KEY_BYTES: usize = 16 * 1024;
const MEMORY_BACKFILL_LIMIT: usize = 200;
/// How often the worktree is polled for changes Gofer did not make itself.
const WORKSPACE_WATCH_INTERVAL: Duration = Duration::from_millis(750);
static WORKSPACE_WATCH: Mutex<Option<files::WatchHandle>> = Mutex::new(None);
static AI_REQUEST_RUNNING: AtomicBool = AtomicBool::new(false);
static AI_REQUEST_CANCELLED: AtomicBool = AtomicBool::new(false);
static ACTIVE_AI_REQUEST_ID: AtomicU64 = AtomicU64::new(0);
type SharedChildProcess = Arc<Mutex<Box<dyn process::ChildProcess>>>;
static AI_CHILD: Mutex<Option<SharedChildProcess>> = Mutex::new(None);
static KEYRING_INITIALIZATION: Mutex<()> = Mutex::new(());

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct GoferSettings {
    version: u32,
    ai: AiSettings,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct AiSettings {
    connection_type: AiConnectionType,
    name: String,
    base_url: String,
    model: String,
    api: ApiDialect,
    #[serde(default)]
    model_name: String,
    #[serde(default = "default_context_window")]
    context_window: u64,
    #[serde(default = "default_context_window")]
    max_tokens: u64,
    #[serde(default)]
    reasoning: bool,
    #[serde(default)]
    supports_reasoning_effort: bool,
    #[serde(default = "default_model_input")]
    input: Vec<String>,
    #[serde(default = "default_thinking_level")]
    thinking_level: String,
    #[serde(default = "default_max_retries")]
    max_retries: u32,
    #[serde(default = "default_timeout_ms")]
    timeout_ms: u64,
    #[serde(default)]
    system_prompt: String,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum AiConnectionType {
    OpenaiCompatible,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum ApiDialect {
    OpenaiCompletions,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct SettingsResponse {
    settings: GoferSettings,
    has_api_key: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    credential_store_error: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SettingsRequest {
    settings: GoferSettings,
    api_key: ApiKeyUpdate,
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "camelCase")]
enum ApiKeyUpdate {
    Keep,
    Set { value: String },
    Clear,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum ConnectionTestStatus {
    Connected,
    ModelUnavailable,
    Unauthorized,
    ServerError,
    ServerUnreachable,
}

#[derive(Debug, PartialEq, Serialize)]
struct ConnectionTestResult {
    status: ConnectionTestStatus,
    message: String,
}

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
struct ChatAttachment {
    id: String,
    name: String,
    mime_type: String,
    size: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatAttachmentUpload {
    attachment: ChatAttachment,
    data: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AiWorkerImage {
    data: String,
    mime_type: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AiWorkerMessage {
    sender: ChatSender,
    text: String,
    timestamp: u64,
    images: Vec<AiWorkerImage>,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum ChatSender {
    User,
    Assistant,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatRequest {
    request_id: u64,
    task_id: Option<String>,
    messages: Vec<ChatMessageInput>,
    #[serde(default)]
    agent_messages: Option<serde_json::Value>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AiWorkerRequest {
    settings: AiSettings,
    api_key: Option<String>,
    messages: Vec<AiWorkerMessage>,
    agent_messages: Option<serde_json::Value>,
    workspace_path: String,
    memory_context: Option<String>,
    /// The domain tools the worker registers. Generated from the router's own catalog, so the
    /// tools the model is offered and the operations Rust will accept cannot drift apart.
    tools: &'static [ai_tools::ToolDomain],
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct AiModelOption {
    id: String,
    name: String,
    context_window: u64,
    max_tokens: u64,
    reasoning: bool,
    supports_reasoning_effort: bool,
    input: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AiStreamPayload {
    request_id: u64,
    event: serde_json::Value,
}

#[derive(Deserialize)]
struct ModelsResponse {
    data: Vec<Model>,
}

#[derive(Deserialize)]
struct Model {
    id: String,
    #[serde(default)]
    meta: Option<ModelMeta>,
}

#[derive(Deserialize)]
struct ModelMeta {
    #[serde(default)]
    n_ctx: Option<u64>,
}

#[derive(Deserialize)]
struct PiModelsFile {
    providers: HashMap<String, PiProvider>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PiProvider {
    base_url: String,
    #[serde(default)]
    compat: PiCompat,
    models: Vec<PiModel>,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PiCompat {
    #[serde(default)]
    supports_reasoning_effort: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PiModel {
    id: String,
    name: String,
    #[serde(default = "default_context_window")]
    context_window: u64,
    #[serde(default = "default_context_window")]
    max_tokens: u64,
    #[serde(default = "default_model_input")]
    input: Vec<String>,
}

struct AiRequestGuard;

impl Drop for AiRequestGuard {
    fn drop(&mut self) {
        ACTIVE_AI_REQUEST_ID.store(0, Ordering::Release);
        AI_REQUEST_CANCELLED.store(false, Ordering::Release);
        if let Ok(mut active) = AI_CHILD.lock() {
            *active = None;
        }
        AI_REQUEST_RUNNING.store(false, Ordering::Release);
    }
}

fn default_context_window() -> u64 {
    120_064
}

fn default_model_input() -> Vec<String> {
    vec!["text".to_owned(), "image".to_owned()]
}

fn default_thinking_level() -> String {
    "off".to_owned()
}

fn default_max_retries() -> u32 {
    2
}

fn default_timeout_ms() -> u64 {
    120_000
}

impl Default for GoferSettings {
    fn default() -> Self {
        Self {
            version: SETTINGS_VERSION,
            ai: AiSettings::default(),
        }
    }
}

impl Default for AiSettings {
    fn default() -> Self {
        Self {
            connection_type: AiConnectionType::OpenaiCompatible,
            name: "Local AI".to_owned(),
            base_url: "http://127.0.0.1:8080/v1".to_owned(),
            model: "Qwen3.6-27B-UD-Q4_K_XL.gguf".to_owned(),
            api: ApiDialect::OpenaiCompletions,
            model_name: "Qwen3.6 27B".to_owned(),
            context_window: default_context_window(),
            max_tokens: default_context_window(),
            reasoning: false,
            supports_reasoning_effort: false,
            input: default_model_input(),
            thinking_level: default_thinking_level(),
            max_retries: default_max_retries(),
            timeout_ms: default_timeout_ms(),
            system_prompt: String::new(),
        }
    }
}

#[tauri::command]
async fn load_settings(app: AppHandle) -> Result<SettingsResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let settings = read_settings(&app)?;
        Ok(settings_response(settings))
    })
    .await
    .map_err(|error| format!("Could not load Gofer settings: {error}"))?
}

#[tauri::command]
async fn save_settings(
    app: AppHandle,
    request: SettingsRequest,
) -> Result<SettingsResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let settings = validate_settings(request.settings)?;
        if matches!(&request.api_key, ApiKeyUpdate::Keep) {
            write_settings(&app, &settings)?;
            return Ok(settings_response(settings));
        }

        let previous_api_key = stored_api_key()?;
        apply_api_key_update(&request.api_key)?;
        if let Err(error) = write_settings(&app, &settings) {
            restore_api_key(previous_api_key.as_deref())?;
            return Err(error);
        }

        Ok(settings_response(settings))
    })
    .await
    .map_err(|error| format!("Could not save Gofer settings: {error}"))?
}

/// A validated settings payload paired with a ready-to-send request to its models endpoint.
struct ModelsRequest {
    settings: GoferSettings,
    builder: reqwest::RequestBuilder,
}

/// How long a user-initiated connection test waits for the AI server.
const AI_REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
/// How long the startup health check waits for it.
///
/// Deliberately shorter: the report is what stands between the user and their project, and a
/// server that is simply not running yet must not hold the window blank while it is waited for.
const AI_HEALTH_TIMEOUT: Duration = Duration::from_secs(3);

/// Validates settings, resolves the credential, and builds the models-endpoint request.
///
/// Sending is left to the caller because the two commands classify transport failures
/// differently: the connection test reports them as a status, model listing as an error.
async fn prepare_models_request(
    request: SettingsRequest,
    timeout: Duration,
) -> Result<ModelsRequest, String> {
    let (settings, api_key) = tauri::async_runtime::spawn_blocking(move || {
        let settings = validate_settings(request.settings)?;
        let api_key = resolve_api_key(&request.api_key)?;
        Ok::<_, String>((settings, api_key))
    })
    .await
    .map_err(|error| format!("AI settings validation task failed: {error}"))??;
    let base_url = format!("{}/", settings.ai.base_url.trim_end_matches('/'));
    let models_url = reqwest::Url::parse(&base_url)
        .and_then(|url| url.join("models"))
        .map_err(|error| format!("Could not construct the models endpoint: {error}"))?;
    let client = reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|error| format!("Could not create the AI connection client: {error}"))?;
    let mut builder = client.get(models_url);
    if let Some(api_key) = api_key {
        builder = builder.bearer_auth(api_key);
    }
    Ok(ModelsRequest { settings, builder })
}

#[tauri::command]
async fn test_ai_connection(request: SettingsRequest) -> Result<ConnectionTestResult, String> {
    run_connection_test(request, AI_REQUEST_TIMEOUT).await
}

async fn run_connection_test(
    request: SettingsRequest,
    timeout: Duration,
) -> Result<ConnectionTestResult, String> {
    let ModelsRequest { settings, builder } = prepare_models_request(request, timeout).await?;

    let response = match builder.send().await {
        Ok(response) => response,
        Err(error) => {
            return Ok(ConnectionTestResult {
                status: ConnectionTestStatus::ServerUnreachable,
                message: format!("The AI server could not be reached: {error}"),
            });
        }
    };

    if response.status() == reqwest::StatusCode::UNAUTHORIZED
        || response.status() == reqwest::StatusCode::FORBIDDEN
    {
        return Ok(ConnectionTestResult {
            status: ConnectionTestStatus::Unauthorized,
            message: "The server rejected the API key.".to_owned(),
        });
    }
    if !response.status().is_success() {
        return Ok(ConnectionTestResult {
            status: ConnectionTestStatus::ServerError,
            message: format!(
                "The server returned HTTP {} from its models endpoint.",
                response.status()
            ),
        });
    }

    let models = response.json::<ModelsResponse>().await.map_err(|error| {
        format!("The server returned an invalid OpenAI models response: {error}")
    })?;
    if models
        .data
        .iter()
        .any(|model| model.id == settings.ai.model)
    {
        return Ok(ConnectionTestResult {
            status: ConnectionTestStatus::Connected,
            message: format!("Connected. Model '{}' is available.", settings.ai.model),
        });
    }

    Ok(ConnectionTestResult {
        status: ConnectionTestStatus::ModelUnavailable,
        message: format!(
            "Connected, but model '{}' is not available on this server.",
            settings.ai.model
        ),
    })
}

#[tauri::command]
async fn list_ai_models(request: SettingsRequest) -> Result<Vec<AiModelOption>, String> {
    let ModelsRequest { settings, builder } =
        prepare_models_request(request, AI_REQUEST_TIMEOUT).await?;
    let response = builder
        .send()
        .await
        .map_err(|error| format!("The AI server could not be reached: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "The server returned HTTP {} from its models endpoint.",
            response.status()
        ));
    }
    let models = response.json::<ModelsResponse>().await.map_err(|error| {
        format!("The server returned an invalid OpenAI models response: {error}")
    })?;
    let catalog = pi_model_catalog().unwrap_or_default();
    Ok(models
        .data
        .into_iter()
        .map(|remote| {
            let known = catalog.iter().find(|model| model.id == remote.id);
            let context_window = remote
                .meta
                .and_then(|meta| meta.n_ctx)
                .or_else(|| known.map(|model| model.context_window))
                .unwrap_or(settings.ai.context_window);
            AiModelOption {
                id: remote.id.clone(),
                name: known
                    .map(|model| model.name.clone())
                    .unwrap_or_else(|| remote.id.clone()),
                context_window,
                max_tokens: known
                    .map(|model| model.max_tokens)
                    .unwrap_or(context_window),
                reasoning: known.map(|model| model.reasoning).unwrap_or(false),
                supports_reasoning_effort: known
                    .map(|model| model.supports_reasoning_effort)
                    .unwrap_or(false),
                input: known
                    .map(|model| model.input.clone())
                    .unwrap_or_else(|| settings.ai.input.clone()),
            }
        })
        .collect())
}

#[tauri::command]
async fn send_ai_message(app: AppHandle, request: ChatRequest) -> Result<(), String> {
    if AI_REQUEST_RUNNING
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Err("Another AI response is already in progress".to_owned());
    }
    let guard = AiRequestGuard;
    ACTIVE_AI_REQUEST_ID.store(request.request_id, Ordering::Release);
    AI_REQUEST_CANCELLED.store(false, Ordering::Release);
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        validate_agent_messages(&request.agent_messages)?;
        let messages = hydrate_chat_messages(&app, validate_chat_messages(request.messages)?)?;
        let prompt = messages
            .last()
            .map(|message| message.text.clone())
            .unwrap_or_default();
        let settings = read_settings(&app)?;
        let api_key = ai_worker_api_key()?;
        let storage = project_storage(&app)?;
        let workspace_path = storage.agent_workspace()?.display().to_string();
        let task_id = request.task_id;
        let memory_context = retrieve_memory_context(&storage, &prompt, task_id.as_deref()).ok();
        let completion = run_ai_worker(
            &app,
            request.request_id,
            AiWorkerRequest {
                settings: settings.ai,
                api_key,
                messages,
                agent_messages: request.agent_messages,
                workspace_path,
                memory_context,
                tools: ai_tools::CATALOG,
            },
        )?;
        let _ = remember_completed_turn(&storage, task_id.as_deref(), &prompt, &completion);
        Ok(())
    })
    .await
    .map_err(|error| format!("AI response task failed: {error}"))?
}

#[tauri::command(async)]
fn save_chat_attachment(app: AppHandle, request: ChatAttachmentUpload) -> Result<(), String> {
    save_chat_attachment_in(&project_storage(&app)?, request)
}

// coverage-critical-start: attachment
fn save_chat_attachment_in(
    storage: &ProjectStorage,
    request: ChatAttachmentUpload,
) -> Result<(), String> {
    validate_chat_attachment(&request.attachment)?;
    if request.data.len() > MAX_CHAT_ATTACHMENT_BASE64_BYTES {
        return Err("Images cannot be larger than 10 MiB".to_owned());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&request.data)
        .map_err(|error| format!("The attachment data is not valid base64: {error}"))?;
    if bytes.len() as u64 != request.attachment.size {
        return Err("The attachment size does not match its contents".to_owned());
    }
    storage.save_attachment(&request.attachment.as_stored(), &bytes)
}
// coverage-critical-end: attachment

#[tauri::command(async)]
fn read_chat_attachment(app: AppHandle, attachment: ChatAttachment) -> Result<String, String> {
    read_chat_attachment_in(&project_storage(&app)?, attachment)
}

fn read_chat_attachment_in(
    storage: &ProjectStorage,
    attachment: ChatAttachment,
) -> Result<String, String> {
    validate_chat_attachment(&attachment)?;
    let bytes = storage.read_attachment(&attachment.as_stored())?;
    Ok(format!(
        "data:{};base64,{}",
        attachment.mime_type,
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

#[tauri::command(async)]
fn load_chat(app: AppHandle) -> Result<StoredChat, String> {
    project_storage(&app)?.load_chat()
}

#[tauri::command(async)]
fn save_chat(app: AppHandle, chat: StoredChat) -> Result<(), String> {
    project_storage(&app)?.save_chat(&chat)
}

#[tauri::command(async)]
fn create_chat_task(app: AppHandle) -> Result<StoredChat, String> {
    project_storage(&app)?.create_task()
}

#[tauri::command(async)]
fn activate_chat_task(app: AppHandle, task_id: String) -> Result<StoredChat, String> {
    project_storage(&app)?.activate_task(&task_id)
}

#[tauri::command(async)]
fn delete_chat_task(app: AppHandle, task_id: String) -> Result<StoredChat, String> {
    let storage = project_storage(&app)?;
    // Deleting the task the editor is editing stops that editor first, so its worktree can be
    // removed and the staged addon comes out with it.
    storage.delete_task(&task_id, |worktree| {
        godot_session_api::release_worktree(&app, worktree);
    })
}

#[tauri::command(async)]
fn import_legacy_chat(app: AppHandle, chat: StoredChat) -> Result<StoredChat, String> {
    let storage = project_storage(&app)?;
    let legacy_directory = chat_attachments_path(&app)?;
    for attachment in chat
        .messages
        .iter()
        .flat_map(|message| message.attachments.iter())
    {
        storage.import_legacy_attachment(&legacy_directory, attachment)?;
    }
    storage.save_chat(&chat)?;
    storage.load_chat()
}

#[tauri::command(async)]
fn list_project_tasks(app: AppHandle) -> Result<Vec<TaskRecord>, String> {
    project_storage(&app)?.list_tasks()
}

#[tauri::command(async)]
fn merge_task_worktree(app: AppHandle, task_id: String) -> Result<MergeTaskResult, String> {
    // The addon ledger knows what Gofer added to this worktree's `project.godot`; the merge records
    // the file without it, so a task merged while its editor is running leaves nothing of Gofer's
    // behind in the project.
    let stager = godot_session_api::addon_stager(&app);
    project_storage(&app)?.merge_task(&task_id, |worktree| {
        stager.project_file_for_git(worktree).ok().flatten()
    })
}

#[tauri::command(async)]
fn create_project_backup(app: AppHandle) -> Result<BackupResult, String> {
    project_storage(&app)?.create_backup()
}

#[tauri::command(async)]
fn run_storage_maintenance(app: AppHandle) -> Result<MaintenanceResult, String> {
    let storage = project_storage(&app)?;
    let mut result = storage.run_maintenance()?;
    result.memory_embeddings_restored = backfill_memory_embeddings(&storage);
    Ok(result)
}

/// Searches the stored warning and error history of every recorded run.
///
/// `read_godot_logs` answers from the live session buffer, which holds only what the editor now
/// running has printed. This reaches the durable index behind it, so output from a session that
/// has already stopped is still findable.
#[tauri::command(async)]
fn search_godot_log_history(
    app: AppHandle,
    request: storage::SearchGodotLogsRequest,
) -> Result<Vec<storage::GodotLogSearchHit>, String> {
    project_storage(&app)?.search_godot_logs(&request)
}

/// Starts a Godot editor session bound to the active task's isolated worktree.
#[tauri::command]
async fn start_godot_session<R: Runtime>(
    app: AppHandle<R>,
    request: godot_session_api::StartGodotSessionRequest,
) -> Result<godot_session_api::GodotSessionResponse, godot_session::SessionError> {
    tauri::async_runtime::spawn_blocking(move || godot_session_api::start_session(&app, request))
        .await
        .map_err(|error| {
            godot_session::SessionError::new(
                "start_task_failed",
                format!("Godot session start task failed: {error}"),
            )
        })?
}

/// Stops the active Godot editor session and cleans up the staged addon.
#[tauri::command]
async fn stop_godot_session<R: Runtime>(
    app: AppHandle<R>,
) -> Result<(), godot_session::SessionError> {
    tauri::async_runtime::spawn_blocking(move || godot_session_api::stop_session(&app))
        .await
        .map_err(|error| {
            godot_session::SessionError::new(
                "stop_task_failed",
                format!("Godot session stop task failed: {error}"),
            )
        })?
}

/// Returns the active Godot editor session, if any.
#[tauri::command]
async fn get_godot_session()
-> Result<Option<godot_session_api::GodotSessionResponse>, godot_session::SessionError> {
    tauri::async_runtime::spawn_blocking(godot_session_api::get_session)
        .await
        .map_err(|error| {
            godot_session::SessionError::new(
                "get_session_task_failed",
                format!("Godot session query task failed: {error}"),
            )
        })?
}

/// Sends one tagged RPC call to the connected Godot addon.
#[tauri::command]
async fn call_godot(
    request: godot_session_api::CallGodotRequest,
) -> Result<godot_session_api::CallGodotResponse, godot_rpc::RpcError> {
    tauri::async_runtime::spawn_blocking(move || godot_session_api::call_godot(request))
        .await
        .map_err(|error| {
            godot_rpc::RpcError::new(
                "call_task_failed",
                format!("Godot RPC call task failed: {error}"),
            )
        })?
}

/// Subscribes to addon events through a Tauri channel.
#[tauri::command]
async fn subscribe_godot_events<R: Runtime>(
    app: AppHandle<R>,
    events: tauri::ipc::Channel<godot_session_api::SessionEvent>,
) -> Result<(), godot_session::SessionError> {
    tauri::async_runtime::spawn_blocking(move || {
        godot_session_api::subscribe_godot_events(&app, events)
    })
    .await
    .map_err(|error| {
        godot_session::SessionError::new(
            "subscribe_task_failed",
            format!("Godot event subscription task failed: {error}"),
        )
    })?
}

/// Stops the active event subscription.
#[tauri::command]
async fn unsubscribe_godot_events() -> Result<(), godot_session::SessionError> {
    tauri::async_runtime::spawn_blocking(godot_session_api::unsubscribe_godot_events)
        .await
        .map_err(|error| {
            godot_session::SessionError::new(
                "unsubscribe_task_failed",
                format!("Godot event unsubscription task failed: {error}"),
            )
        })?
}

/// Answers one AI tool call the safety model stopped and put in front of the user.
#[tauri::command]
async fn respond_tool_approval(
    request: godot_session_api::ToolApprovalRequest,
) -> Result<(), approvals::ApprovalError> {
    tauri::async_runtime::spawn_blocking(move || godot_session_api::respond_tool_approval(request))
        .await
        .map_err(|error| {
            approvals::ApprovalError::task_failed(format!("Tool approval task failed: {error}"))
        })?
}

/// One debugger operation against the active session's adapter. The debugger panel and the
/// agent's `godot_debug` tool both land here, so a breakpoint the user set and one the agent set
/// are the same breakpoint.
#[tauri::command]
async fn call_godot_debug(
    request: debug::DebugRequest,
) -> Result<debug::DebugResponse, godot_dap::DapError> {
    tauri::async_runtime::spawn_blocking(move || debug::call(request))
        .await
        .map_err(|error| {
            godot_dap::DapError::new(
                "debug_task_failed",
                format!("The debug request task failed: {error}"),
            )
        })?
}

/// Reads one page of captured session output: editor, importer, plugin, and the game the editor
/// launched, since they share the editor's two pipes.
#[tauri::command]
async fn read_godot_logs(
    query: godot_session::LogQuery,
) -> Result<godot_session::LogPage, godot_session::SessionError> {
    tauri::async_runtime::spawn_blocking(move || godot_session::read_logs(&query))
        .await
        .map_err(|error| {
            godot_session::SessionError::new(
                "logs_task_failed",
                format!("The session log task failed: {error}"),
            )
        })?
}

/// Typed workspace file access. Every caller — the renderer, the AI agent, and the Godot addon —
/// reaches the worktree through these commands so that path validation, atomic replacement, and
/// optimistic concurrency exist exactly once.
#[tauri::command(async)]
fn read_workspace_file(
    app: AppHandle,
    path: String,
) -> Result<files::FileContents, files::FileError> {
    active_workspace(&app)?.read(&path)
}

#[tauri::command(async)]
fn write_workspace_file(
    app: AppHandle,
    request: files::WriteFileRequest,
) -> Result<files::FileStamp, files::FileError> {
    active_workspace(&app)?.write(
        &request.path,
        &request.text,
        request.expected_hash.as_deref(),
    )
}

#[tauri::command(async)]
fn edit_workspace_file(
    app: AppHandle,
    request: files::EditFileRequest,
) -> Result<files::FileStamp, files::FileError> {
    active_workspace(&app)?.edit(
        &request.path,
        &request.expected_hash,
        &request.find,
        &request.replace,
    )
}

#[tauri::command(async)]
fn move_workspace_path(
    app: AppHandle,
    request: files::MovePathRequest,
) -> Result<(), files::FileError> {
    active_workspace(&app)?.move_path(&request.from, &request.to)
}

#[tauri::command(async)]
fn delete_workspace_path(
    app: AppHandle,
    request: files::DeletePathRequest,
) -> Result<(), files::FileError> {
    active_workspace(&app)?.delete(&request.path, request.expected_hash.as_deref())
}

/// Streams settled batches of changes made by Godot, the user, or a confined shell command.
#[tauri::command(async)]
fn watch_workspace_files(
    app: AppHandle,
    changes: tauri::ipc::Channel<Vec<files::FileChange>>,
) -> Result<(), files::FileError> {
    let workspace = active_workspace(&app)?;
    let mut slot = workspace_watch()?;
    if let Some(previous) = slot.take() {
        previous.stop();
    }
    *slot = Some(files::spawn_watcher(
        workspace,
        WORKSPACE_WATCH_INTERVAL,
        move |batch| {
            let _ = changes.send(batch);
        },
    ));
    Ok(())
}

#[tauri::command(async)]
fn unwatch_workspace_files() -> Result<(), files::FileError> {
    if let Some(watch) = workspace_watch()?.take() {
        watch.stop();
    }
    Ok(())
}

/// Lists every watchable file in the active task worktree so the renderer can offer them for
/// editing. Sizes come from the same scan the watcher uses; content hashes stay absent because a
/// worktree holds game assets and the editor re-reads a file when it opens it.
#[tauri::command(async)]
fn list_workspace_files(app: AppHandle) -> Result<Vec<WorkspaceEntry>, files::FileError> {
    let workspace = active_workspace(&app)?;
    Ok(files::scan(workspace.root())
        .into_iter()
        .map(|(path, stamp)| WorkspaceEntry {
            path,
            bytes: stamp.bytes,
        })
        .collect())
}

/// One workspace file offered to the renderer's script picker.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceEntry {
    path: String,
    bytes: u64,
}

/// Script intelligence for the renderer's Monaco editor. Every command binds to the active
/// session's language server, so the editor and the AI agent share one document version per file.
#[tauri::command(async)]
fn open_script_document(
    request: script::OpenScriptRequest,
) -> Result<script::ScriptDocument, godot_lsp::LspError> {
    script::open_document(request)
}

#[tauri::command(async)]
fn update_script_document(
    request: script::UpdateScriptRequest,
) -> Result<script::ScriptStamp, godot_lsp::LspError> {
    script::update_document(request)
}

#[tauri::command(async)]
fn save_script_document(
    request: script::SaveScriptRequest,
) -> Result<script::ScriptStamp, godot_lsp::LspError> {
    script::save_document(request)
}

#[tauri::command(async)]
fn close_script_document(request: script::OpenScriptRequest) -> Result<(), godot_lsp::LspError> {
    script::close_document(request)
}

#[tauri::command(async)]
fn call_script_language(
    request: script::ScriptRequest,
) -> Result<script::ScriptResponse, godot_lsp::LspError> {
    script::call(request)
}

#[tauri::command(async)]
fn apply_script_rename(
    request: script::ApplyRenameRequest,
) -> Result<Vec<script::ScriptStamp>, godot_lsp::LspError> {
    script::apply_rename(request)
}

#[tauri::command(async)]
fn subscribe_script_diagnostics(
    diagnostics: tauri::ipc::Channel<script::ScriptDiagnostics>,
) -> Result<(), godot_lsp::LspError> {
    script::subscribe_diagnostics(diagnostics)
}

#[tauri::command(async)]
fn unsubscribe_script_diagnostics() -> Result<(), godot_lsp::LspError> {
    script::unsubscribe_diagnostics()
}

/// Formats a GDScript buffer through the pinned gdformat sidecar. The formatted text is returned
/// for the caller to diff; applying it is a separate, explicit workspace write, so a formatter
/// failure can never mutate the source. A missing or wrong-version sidecar reports
/// `formatter_unavailable` — formatting is the one feature allowed to ship disabled.
#[tauri::command(async)]
fn format_gdscript(
    app: AppHandle,
    request: gdformat::FormatRequest,
) -> Result<gdformat::FormatResponse, gdformat::GdformatError> {
    let binary = gdformat_binary(&app)?;
    gdformat::format_source(&SystemProcessSpawner, &binary, &request.source)
}

/// Resolves the sidecar once per binary path so each format call does not pay for a second
/// process spawn just to re-prove the pin.
fn gdformat_binary<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<std::path::PathBuf, gdformat::GdformatError> {
    let resource_dir = app.path().resource_dir().ok();
    let binary = gdformat::resolve(std::env::var_os(gdformat::ENV_OVERRIDE), resource_dir)?;
    let mut verified = GDFORMAT_VERIFIED
        .lock()
        .map_err(|_| gdformat_lock_error())?;
    if verified.as_deref() == Some(binary.as_path()) {
        return Ok(binary);
    }
    gdformat::verify_version(&SystemProcessSpawner, &binary)?;
    *verified = Some(binary.clone());
    Ok(binary)
}

fn gdformat_lock_error() -> gdformat::GdformatError {
    gdformat::GdformatError {
        code: "formatter_unavailable",
        message: "The gdformat sidecar state lock is poisoned".to_owned(),
        retryable: false,
        details: serde_json::json!({}),
    }
}

static GDFORMAT_VERIFIED: Mutex<Option<std::path::PathBuf>> = Mutex::new(None);

fn workspace_watch()
-> Result<std::sync::MutexGuard<'static, Option<files::WatchHandle>>, files::FileError> {
    WORKSPACE_WATCH
        .lock()
        .map_err(|_| files::FileError::unavailable("The workspace watch lock is poisoned"))
}

/// Binds file access to the active task's worktree, which `agent_workspace` resolves.
fn active_workspace<R: Runtime>(app: &AppHandle<R>) -> Result<files::Workspace, files::FileError> {
    let storage = project_storage(app).map_err(files::FileError::unavailable)?;
    let root = storage
        .agent_workspace()
        .map_err(files::FileError::unavailable)?;
    files::Workspace::open(&root)
}

#[tauri::command(async)]
fn cancel_ai_request(app: AppHandle, request_id: u64) -> Result<bool, String> {
    cancel_ai_request_with(&app, request_id)
}

// coverage-critical-start: cancellation
fn cancel_ai_request_with<R: Runtime>(app: &AppHandle<R>, request_id: u64) -> Result<bool, String> {
    if ACTIVE_AI_REQUEST_ID.load(Ordering::Acquire) != request_id {
        return Ok(false);
    }
    AI_REQUEST_CANCELLED.store(true, Ordering::Release);
    // A tool call waiting for the user belongs to the turn being cancelled: left waiting, it would
    // hold a tool worker open long after the agent that asked for it is gone.
    approvals::cancel_all();
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
    app.emit_to(
        "main",
        "ai-stream-event",
        AiStreamPayload {
            request_id,
            event: serde_json::json!({"type": "aborted"}),
        },
    )
    .map_err(|error| format!("Could not report the cancelled AI request: {error}"))?;
    Ok(true)
}
// coverage-critical-end: cancellation

#[tauri::command]
async fn get_rag_cache_status() -> Result<rag::CacheStatus, String> {
    tauri::async_runtime::spawn_blocking(rag::cache_status)
        .await
        .map_err(|error| format!("Could not inspect the Gofer RAG cache: {error}"))?
}

#[tauri::command]
async fn delete_rag_cache() -> Result<rag::CacheStatus, String> {
    tauri::async_runtime::spawn_blocking(rag::delete_cache)
        .await
        .map_err(|error| format!("Could not delete the Gofer RAG cache: {error}"))?
}

#[tauri::command]
async fn initialize_rag(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || rag::run_initialization(|| rag::run_warmup(&app)))
        .await
        .map_err(|error| format!("Gofer RAG initialization task failed: {error}"))?
}

#[tauri::command]
async fn query_godot_docs(request: rag::GodotDocsQuery) -> Result<rag::GodotDocsResponse, String> {
    tauri::async_runtime::spawn_blocking(move || rag::retrieve_query(request))
        .await
        .map_err(|error| format!("Gofer RAG query task failed: {error}"))?
}

/// The workspace folder and Godot executable the user chose in the health check.
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct EnvironmentSettings {
    #[serde(default)]
    workspace: Option<String>,
    #[serde(default)]
    godot_binary: Option<String>,
}

/// The workspace Gofer is bound to, and how it came to be that one.
struct WorkspaceBinding {
    path: PathBuf,
    source: health::WorkspaceSource,
}

fn environment_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    if let Some(path) = configured_app_data_path()? {
        return Ok(path.join(ENVIRONMENT_FILE_NAME));
    }
    app.path()
        .app_config_dir()
        .map(|path| path.join(ENVIRONMENT_FILE_NAME))
        .map_err(|error| format!("Could not resolve Gofer's configuration directory: {error}"))
}

/// Reads the recorded environment, treating an unreadable or invalid file as "nothing recorded".
///
/// This file decides which folder Gofer opens. Refusing to start over a corrupt one would strand
/// the user in exactly the state the health check exists to get them out of.
fn read_environment<R: Runtime>(app: &AppHandle<R>) -> EnvironmentSettings {
    let Ok(path) = environment_path(app) else {
        return EnvironmentSettings::default();
    };
    fs::read_to_string(path)
        .ok()
        .and_then(|contents| serde_json::from_str(&contents).ok())
        .unwrap_or_default()
}

/// The editor the user pointed Gofer at, for the session supervisor to launch.
pub(crate) fn configured_godot_binary<R: Runtime>(app: &AppHandle<R>) -> Option<String> {
    read_environment(app).godot_binary
}

fn write_environment<R: Runtime>(
    app: &AppHandle<R>,
    environment: &EnvironmentSettings,
) -> Result<(), String> {
    let path = environment_path(app)?;
    let parent = path
        .parent()
        .ok_or_else(|| format!("Gofer environment path has no parent: {}", path.display()))?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create {}: {error}", parent.display()))?;
    let contents = serde_json::to_string_pretty(environment)
        .map_err(|error| format!("Could not serialize the Gofer environment: {error}"))?;
    fs::write(&path, format!("{contents}\n"))
        .map_err(|error| format!("Could not write {}: {error}", path.display()))
}

fn resolve_workspace<R: Runtime>(app: &AppHandle<R>) -> Result<WorkspaceBinding, String> {
    // `GOFER_WORKSPACE_DIR` wins so a test harness can point a launched application at a prepared
    // repository regardless of what the user last chose.
    if let Some(configured) = std::env::var_os("GOFER_WORKSPACE_DIR") {
        return Ok(WorkspaceBinding {
            path: validate_configured_directory(
                PathBuf::from(configured),
                "GOFER_WORKSPACE_DIR must be an absolute path without traversal",
            )?,
            source: health::WorkspaceSource::Environment,
        });
    }
    if let Some(chosen) = read_environment(app).workspace {
        let path = PathBuf::from(chosen);
        // A folder that has since been deleted or moved falls back rather than blocking startup;
        // the health check then reports the working directory it landed on.
        if path.is_dir() {
            return Ok(WorkspaceBinding {
                path,
                source: health::WorkspaceSource::Configured,
            });
        }
    }
    Ok(WorkspaceBinding {
        path: std::env::current_dir()
            .map_err(|error| format!("Could not resolve the agent workspace: {error}"))?,
        source: health::WorkspaceSource::WorkingDirectory,
    })
}

/// Reports everything Gofer needs in order to work here, and what repairs each missing piece.
#[tauri::command]
async fn check_workspace_health(app: AppHandle) -> Result<health::HealthReport, String> {
    let ai = ai_health(&app).await;
    tauri::async_runtime::spawn_blocking(move || workspace_health(&app, ai))
        .await
        .map_err(|error| format!("The health check task failed: {error}"))
}

/// Applies one repair and answers with the report as it stands afterwards, so the interface never
/// shows a fix that has already been applied.
#[tauri::command]
async fn apply_health_remedy(
    app: AppHandle,
    request: HealthRemedyRequest,
) -> Result<health::HealthReport, String> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || apply_remedy(&handle, request))
        .await
        .map_err(|error| format!("The health repair task failed: {error}"))??;
    check_workspace_health(app).await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HealthRemedyRequest {
    action: health::RemedyAction,
    /// The folder or executable the user picked, for the remedies that need one.
    #[serde(default)]
    path: Option<String>,
}

fn apply_remedy(app: &AppHandle, request: HealthRemedyRequest) -> Result<(), String> {
    match request.action {
        health::RemedyAction::ChooseWorkspace => {
            let path = chosen_path(request.path, "a project folder")?;
            if !path.is_dir() {
                return Err(format!("{} is not a folder.", path.display()));
            }
            let mut environment = read_environment(app);
            environment.workspace = Some(path.display().to_string());
            write_environment(app, &environment)?;
            // Reopening binds every later command to the new folder without a restart. The health
            // check runs before any session, watcher, or task exists, so nothing is left pointing
            // at the old one.
            reopen_storage(app).map(|_| ())
        }
        health::RemedyAction::LocateGodotBinary => {
            let path = chosen_path(request.path, "the Godot executable")?;
            let binary = path.display().to_string();
            let probe = godot_session::probe_binary(Some(&binary));
            if let Some(error) = probe.error {
                return Err(error);
            }
            let mut environment = read_environment(app);
            environment.godot_binary = Some(binary);
            write_environment(app, &environment)
        }
        action => {
            let workspace = resolve_workspace(app)?.path;
            health::apply(&workspace, action)?;
            // Git repairs are exactly what a failed open was waiting for.
            let _ = reopen_storage(app);
            Ok(())
        }
    }
}

fn chosen_path(path: Option<String>, what: &str) -> Result<PathBuf, String> {
    let path = path
        .map(|path| path.trim().to_owned())
        .filter(|path| !path.is_empty())
        .ok_or_else(|| format!("Gofer needs {what} to be chosen first."))?;
    Ok(PathBuf::from(path))
}

fn workspace_health(app: &AppHandle, ai: health::AiHealth) -> health::HealthReport {
    let binding = resolve_workspace(app);
    let (workspace, source) = match &binding {
        Ok(binding) => (binding.path.clone(), binding.source),
        Err(_) => (PathBuf::new(), health::WorkspaceSource::WorkingDirectory),
    };
    let storage_error = match binding {
        Err(error) => Some(error),
        Ok(_) => project_storage(app).err(),
    };
    let environment = read_environment(app);
    health::report(&health::HealthInput {
        workspace,
        workspace_source: source,
        storage_error,
        godot: godot_session::probe_binary(environment.godot_binary.as_deref()),
        ai,
        formatter_error: gdformat_binary(app).err().map(|error| error.message),
    })
}

/// Asks the configured AI server whether it is there and serving the configured model.
///
/// Unreachable is reported, never fatal: a local model the user has not started yet is the ordinary
/// case, and it must not stand between them and their project.
async fn ai_health(app: &AppHandle) -> health::AiHealth {
    let loaded = tauri::async_runtime::spawn_blocking({
        let app = app.clone();
        move || read_settings(&app)
    })
    .await
    .map_err(|error| error.to_string())
    .and_then(|settings| settings);
    let settings = match loaded {
        Ok(settings) => settings,
        Err(error) => {
            return health::AiHealth {
                base_url: String::new(),
                model: String::new(),
                reachability: health::AiReachability::ServerError,
                message: format!("Gofer's AI settings could not be read: {error}"),
            };
        }
    };
    let base_url = settings.ai.base_url.clone();
    let model = settings.ai.model.clone();
    let result = run_connection_test(
        SettingsRequest {
            settings,
            api_key: ApiKeyUpdate::Keep,
        },
        AI_HEALTH_TIMEOUT,
    )
    .await;
    let (reachability, message) = match result {
        Ok(result) => (
            match result.status {
                ConnectionTestStatus::Connected => health::AiReachability::Connected,
                ConnectionTestStatus::ModelUnavailable => health::AiReachability::ModelUnavailable,
                ConnectionTestStatus::Unauthorized => health::AiReachability::Unauthorized,
                ConnectionTestStatus::ServerError => health::AiReachability::ServerError,
                ConnectionTestStatus::ServerUnreachable => health::AiReachability::Unreachable,
            },
            result.message,
        ),
        Err(error) => (health::AiReachability::ServerError, error),
    };
    health::AiHealth {
        base_url,
        model,
        reachability,
        message,
    }
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(path) = configured_app_data_path()? {
        return Ok(path.join(SETTINGS_FILE_NAME));
    }
    app.path()
        .app_config_dir()
        .map(|path| path.join(SETTINGS_FILE_NAME))
        .map_err(|error| format!("Could not resolve Gofer's configuration directory: {error}"))
}

fn chat_attachments_path(app: &AppHandle) -> Result<PathBuf, String> {
    app_data_path(app).map(|path| path.join(CHAT_ATTACHMENTS_DIRECTORY))
}

fn configured_app_data_path() -> Result<Option<PathBuf>, String> {
    let Some(configured) = std::env::var_os("GOFER_APP_DATA_DIR") else {
        return Ok(None);
    };
    validate_app_data_path(PathBuf::from(configured)).map(Some)
}

// coverage-critical-start: path
fn validate_app_data_path(path: PathBuf) -> Result<PathBuf, String> {
    validate_configured_directory(
        path,
        "GOFER_APP_DATA_DIR must be an absolute path without traversal",
    )
}

/// One rule for every directory an environment variable may name: absolute, no traversal.
fn validate_configured_directory(path: PathBuf, message: &str) -> Result<PathBuf, String> {
    if !path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, Component::CurDir | Component::ParentDir))
    {
        return Err(message.to_owned());
    }
    Ok(path)
}
// coverage-critical-end: path

pub(crate) fn app_data_path(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(path) = configured_app_data_path()? {
        return Ok(path);
    }
    app.path()
        .app_data_dir()
        .map_err(|error| format!("Could not resolve Gofer's data directory: {error}"))
}

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
    project_storage(app)?.read_attachment(&attachment.as_stored())
}

fn project_storage<R: Runtime>(app: &AppHandle<R>) -> Result<ProjectStorage, String> {
    app.try_state::<StorageSlot>()
        .ok_or_else(|| "Project storage has not been initialized".to_owned())?
        .get()
}

/// Opens the project database for whatever folder Gofer is currently bound to.
///
/// The workspace is normally the directory Gofer was started in. `GOFER_WORKSPACE_DIR` names it
/// explicitly, which is how the packaged journey points a launched application at a prepared
/// repository instead of at whatever directory the test runner happened to be in; the health check
/// records a folder the user chose. It is validated exactly like `GOFER_APP_DATA_DIR`, because both
/// name a directory Gofer will write.
fn open_project_storage(app: &AppHandle) -> Result<ProjectStorage, String> {
    let data_root = app_data_path(app)?;
    let workspace = resolve_workspace(app)?.path;
    ProjectStorage::open(&data_root, &workspace)
}

/// Rebinds the project database after the health check changed what it depends on.
fn reopen_storage(app: &AppHandle) -> Result<ProjectStorage, String> {
    app.try_state::<StorageSlot>()
        .ok_or_else(|| "Project storage has not been initialized".to_owned())?
        .replace(open_project_storage(app))
}

fn hydrate_chat_messages(
    app: &AppHandle,
    messages: Vec<ChatMessageInput>,
) -> Result<Vec<AiWorkerMessage>, String> {
    messages
        .into_iter()
        .map(|message| {
            let images = message
                .attachments
                .iter()
                .map(|attachment| {
                    validate_chat_attachment(attachment)?;
                    let bytes = read_chat_attachment_bytes(app, attachment)?;
                    Ok(AiWorkerImage {
                        data: base64::engine::general_purpose::STANDARD.encode(bytes),
                        mime_type: attachment.mime_type.clone(),
                    })
                })
                .collect::<Result<Vec<_>, String>>()?;
            Ok(AiWorkerMessage {
                sender: message.sender,
                text: message.text,
                timestamp: message.timestamp,
                images,
            })
        })
        .collect()
}

fn read_settings(app: &AppHandle) -> Result<GoferSettings, String> {
    let path = settings_path(app)?;
    read_settings_from_path(&path)
}

fn read_settings_from_path(path: &Path) -> Result<GoferSettings, String> {
    if !path.exists() {
        return Ok(default_settings_from_pi().unwrap_or_default());
    }
    let contents = fs::read_to_string(path)
        .map_err(|error| format!("Could not read {}: {error}", path.display()))?;
    let settings = serde_json::from_str(&contents)
        .map_err(|error| format!("Gofer settings in {} are invalid: {error}", path.display()))?;
    validate_settings(settings)
}

fn pi_models_path() -> Result<PathBuf, String> {
    dirs::home_dir()
        .map(|path| path.join(".pi").join("agent").join("models.json"))
        .ok_or_else(|| "The home directory could not be resolved".to_owned())
}

fn pi_model_catalog() -> Result<Vec<AiModelOption>, String> {
    let path = pi_models_path()?;
    pi_model_catalog_from_path(&path)
}

fn pi_model_catalog_from_path(path: &Path) -> Result<Vec<AiModelOption>, String> {
    let contents = fs::read_to_string(path)
        .map_err(|error| format!("Could not read {}: {error}", path.display()))?;
    let configured: PiModelsFile = serde_json::from_str(&contents)
        .map_err(|error| format!("Pi models in {} are invalid: {error}", path.display()))?;
    Ok(configured
        .providers
        .values()
        .flat_map(|provider| {
            provider.models.iter().map(|model| AiModelOption {
                id: model.id.clone(),
                name: model.name.clone(),
                context_window: model.context_window,
                max_tokens: model.max_tokens,
                reasoning: provider.compat.supports_reasoning_effort,
                supports_reasoning_effort: provider.compat.supports_reasoning_effort,
                input: model.input.clone(),
            })
        })
        .collect())
}

fn default_settings_from_pi() -> Option<GoferSettings> {
    let path = pi_models_path().ok()?;
    default_settings_from_pi_path(&path)
}

fn default_settings_from_pi_path(path: &Path) -> Option<GoferSettings> {
    let contents = fs::read_to_string(path).ok()?;
    let configured: PiModelsFile = serde_json::from_str(&contents).ok()?;
    let provider = configured.providers.values().next()?;
    let model = provider.models.first()?;
    Some(GoferSettings {
        version: SETTINGS_VERSION,
        ai: AiSettings {
            connection_type: AiConnectionType::OpenaiCompatible,
            name: "Local AI".to_owned(),
            base_url: provider.base_url.clone(),
            model: model.id.clone(),
            api: ApiDialect::OpenaiCompletions,
            model_name: model.name.clone(),
            context_window: model.context_window,
            max_tokens: model.max_tokens,
            reasoning: provider.compat.supports_reasoning_effort,
            supports_reasoning_effort: provider.compat.supports_reasoning_effort,
            input: model.input.clone(),
            thinking_level: default_thinking_level(),
            max_retries: default_max_retries(),
            timeout_ms: default_timeout_ms(),
            system_prompt: String::new(),
        },
    })
}

fn write_settings(app: &AppHandle, settings: &GoferSettings) -> Result<(), String> {
    let path = settings_path(app)?;
    write_settings_to_path(&path, settings)
}

fn write_settings_to_path(path: &Path, settings: &GoferSettings) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("Gofer settings path has no parent: {}", path.display()))?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create {}: {error}", parent.display()))?;
    let contents = serde_json::to_string_pretty(settings)
        .map_err(|error| format!("Could not serialize Gofer settings: {error}"))?;
    fs::write(path, format!("{contents}\n"))
        .map_err(|error| format!("Could not write {}: {error}", path.display()))
}

fn validate_settings(mut settings: GoferSettings) -> Result<GoferSettings, String> {
    if settings.version != SETTINGS_VERSION {
        return Err(format!(
            "Unsupported settings version {}. This Gofer build supports version {SETTINGS_VERSION}.",
            settings.version
        ));
    }
    settings.ai.name = required_value("Connection name", settings.ai.name)?;
    settings.ai.model = required_value("Model ID", settings.ai.model)?;
    if settings.ai.name.len() > 100 {
        return Err("Connection names cannot exceed 100 bytes".to_owned());
    }
    if settings.ai.model.len() > 512 {
        return Err("Model IDs cannot exceed 512 bytes".to_owned());
    }
    if settings.ai.model_name.trim().is_empty() {
        settings.ai.model_name = settings.ai.model.clone();
    } else {
        settings.ai.model_name = settings.ai.model_name.trim().to_owned();
    }
    if settings.ai.model_name.len() > 512 {
        return Err("Model names cannot exceed 512 bytes".to_owned());
    }
    if settings.ai.system_prompt.len() > 64 * 1024 {
        return Err("System prompts cannot exceed 64 KiB".to_owned());
    }
    if settings.ai.input.is_empty()
        || settings.ai.input.len() > 16
        || settings
            .ai
            .input
            .iter()
            .any(|input| input.is_empty() || input.len() > 64)
    {
        return Err("Model input types are invalid".to_owned());
    }
    if settings.ai.context_window == 0 || settings.ai.max_tokens == 0 {
        return Err(
            "Context window and maximum output tokens must be greater than zero".to_owned(),
        );
    }
    if settings.ai.max_retries > 10 {
        return Err("Maximum retries cannot exceed 10".to_owned());
    }
    if !(1_000..=3_600_000).contains(&settings.ai.timeout_ms) {
        return Err("Request timeout must be between 1,000 and 3,600,000 milliseconds".to_owned());
    }
    if !["off", "minimal", "low", "medium", "high", "xhigh", "max"]
        .contains(&settings.ai.thinking_level.as_str())
    {
        return Err("Reasoning level is invalid".to_owned());
    }
    if !settings.ai.reasoning {
        settings.ai.thinking_level = "off".to_owned();
    }
    settings.ai.base_url = settings.ai.base_url.trim().trim_end_matches('/').to_owned();
    let url = reqwest::Url::parse(&settings.ai.base_url)
        .map_err(|error| format!("Base URL must be a valid absolute URL: {error}"))?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err("Base URL must use http or https".to_owned());
    }
    if url.cannot_be_a_base()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || settings.ai.base_url.len() > 2_048
    {
        return Err("Base URL cannot contain credentials, a query, or a fragment".to_owned());
    }
    Ok(settings)
}

fn required_value(name: &str, value: String) -> Result<String, String> {
    let value = value.trim().to_owned();
    if value.is_empty() {
        return Err(format!("{name} is required"));
    }
    Ok(value)
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
    if messages.iter().any(|message| message.attachments.len() > 5) {
        return Err("Chat messages cannot contain more than 5 images".to_owned());
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

fn credential_entry() -> Result<Entry, String> {
    let _initialization = KEYRING_INITIALIZATION
        .lock()
        .map_err(|_| "The credential-store initialization lock is poisoned".to_owned())?;
    Entry::new(API_KEY_SERVICE, API_KEY_USERNAME)
        .map_err(|error| format!("Could not access the operating system credential store: {error}"))
}

trait CredentialStore {
    fn clear(&self) -> Result<(), String>;
    fn load(&self) -> Result<Option<String>, String>;
    fn store(&self, value: &str) -> Result<(), String>;
}

struct SystemCredentialStore;

impl CredentialStore for SystemCredentialStore {
    fn clear(&self) -> Result<(), String> {
        match credential_entry()?.delete_credential() {
            Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
            Err(error) => Err(format!("Could not remove the AI API key: {error}")),
        }
    }

    fn load(&self) -> Result<Option<String>, String> {
        match credential_entry()?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(KeyringError::NoEntry) => Ok(None),
            Err(error) => Err(format!(
                "Could not read the AI API key from the credential store: {error}"
            )),
        }
    }

    fn store(&self, value: &str) -> Result<(), String> {
        credential_entry()?
            .set_password(value)
            .map_err(|error| format!("Could not store the AI API key: {error}"))
    }
}

fn stored_api_key() -> Result<Option<String>, String> {
    SystemCredentialStore.load()
}

fn ai_worker_api_key() -> Result<Option<String>, String> {
    #[cfg(feature = "webdriver")]
    if std::env::var_os("GOFER_WEBDRIVER_SKIP_CREDENTIAL_STORE").is_some() {
        return Ok(None);
    }
    stored_api_key()
}

fn settings_response(settings: GoferSettings) -> SettingsResponse {
    #[cfg(feature = "webdriver")]
    if std::env::var_os("GOFER_WEBDRIVER_RAG_READY").is_some() {
        return SettingsResponse {
            settings,
            has_api_key: false,
            credential_store_error: None,
        };
    }
    settings_response_with(&SystemCredentialStore, settings)
}

fn settings_response_with(
    store: &impl CredentialStore,
    settings: GoferSettings,
) -> SettingsResponse {
    match store.load() {
        Ok(api_key) => SettingsResponse {
            settings,
            has_api_key: api_key.is_some(),
            credential_store_error: None,
        },
        Err(error) => SettingsResponse {
            settings,
            has_api_key: false,
            credential_store_error: Some(error),
        },
    }
}

fn apply_api_key_update(update: &ApiKeyUpdate) -> Result<(), String> {
    apply_api_key_update_with(&SystemCredentialStore, update)
}

// coverage-critical-start: credential
fn apply_api_key_update_with(
    store: &impl CredentialStore,
    update: &ApiKeyUpdate,
) -> Result<(), String> {
    match update {
        ApiKeyUpdate::Keep => Ok(()),
        ApiKeyUpdate::Set { value } => {
            let value = value.trim();
            if value.is_empty() {
                return Err("API key cannot be empty when setting a credential".to_owned());
            }
            if value.len() > MAX_API_KEY_BYTES {
                return Err("API keys cannot exceed 16 KiB".to_owned());
            }
            store.store(value)
        }
        ApiKeyUpdate::Clear => store.clear(),
    }
}

fn restore_api_key(value: Option<&str>) -> Result<(), String> {
    restore_api_key_with(&SystemCredentialStore, value)
}

fn restore_api_key_with(store: &impl CredentialStore, value: Option<&str>) -> Result<(), String> {
    match value {
        Some(value) => store
            .store(value)
            .map_err(|error| format!("Could not restore the previous AI API key: {error}")),
        None => store.clear(),
    }
}

fn resolve_api_key(update: &ApiKeyUpdate) -> Result<Option<String>, String> {
    match update {
        ApiKeyUpdate::Keep => Ok(stored_api_key().unwrap_or(None)),
        ApiKeyUpdate::Set { value } => {
            let value = value.trim();
            if value.is_empty() {
                return Err("API key cannot be empty when testing a credential".to_owned());
            }
            if value.len() > MAX_API_KEY_BYTES {
                return Err("API keys cannot exceed 16 KiB".to_owned());
            }
            Ok(Some(value.to_owned()))
        }
        ApiKeyUpdate::Clear => Ok(None),
    }
}
// coverage-critical-end: credential

fn run_ai_worker(
    app: &AppHandle,
    request_id: u64,
    request: AiWorkerRequest,
) -> Result<String, String> {
    run_ai_worker_with(app, request_id, request, &SystemProcessSpawner)
}

fn run_ai_worker_with<R: Runtime>(
    app: &AppHandle<R>,
    request_id: u64,
    request: AiWorkerRequest,
    spawner: &impl ProcessSpawner,
) -> Result<String, String> {
    let worker = ai_worker_path()?;
    // Approvals belong to a turn: the gate opens here and closes when this one ends, so a gated
    // tool call always has an agent waiting for its answer.
    approvals::open();
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
    *AI_CHILD
        .lock()
        .map_err(|_| "The AI process lock is poisoned".to_owned())? = Some(Arc::clone(&child));
    let stderr_reader = std::thread::spawn(move || {
        let mut output = String::new();
        let _ = BufReader::new(stderr).read_to_string(&mut output);
        output
    });
    let mut completed = false;
    let mut completion_text = String::new();
    let mut tool_workers: Vec<std::thread::JoinHandle<()>> = Vec::new();

    // The stream is read in a closure so that a malformed line leaves the turn the same way a
    // clean end does: through the cancel-and-join below, rather than past it.
    let stream = || -> Result<(), String> {
        for line in BufReader::new(stdout).lines() {
            let line = line.map_err(|error| format!("Could not read Pi AI output: {error}"))?;
            if let Some(payload) = line.strip_prefix(AI_TOOL_PREFIX) {
                tool_workers.push(spawn_tool_worker(app, &stdin, payload)?);
                continue;
            }
            let Some(payload) = line.strip_prefix(AI_EVENT_PREFIX) else {
                continue;
            };
            let event: serde_json::Value = serde_json::from_str(payload)
                .map_err(|error| format!("Pi AI returned an invalid event: {error}"))?;
            if event.get("type").and_then(serde_json::Value::as_str) == Some("done") {
                completed = true;
                completion_text = event
                    .get("text")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default()
                    .to_owned();
            }
            app.emit_to(
                "main",
                "ai-stream-event",
                AiStreamPayload { request_id, event },
            )
            .map_err(|error| format!("Could not stream the AI response: {error}"))?;
        }
        Ok(())
    };
    let streamed = stream();

    // The worker exited, so nothing is left to answer; joining keeps a tool that outlived it from
    // writing into the next turn's channel. Closing the approval gate first is what makes that join
    // finite: a tool call still waiting for the user has lost the agent that asked, and a prompt
    // registered after this point is refused rather than left waiting for the whole timeout.
    approvals::cancel_all();
    for worker in tool_workers {
        let _ = worker.join();
    }
    streamed?;

    let status = child
        .lock()
        .map_err(|_| "The AI child process lock is poisoned".to_owned())?
        .wait()
        .map_err(|error| format!("Could not wait for the Pi AI worker: {error}"))?;
    let stderr = stderr_reader
        .join()
        .map_err(|_| "Could not collect Pi AI worker errors".to_owned())?;
    if !status.success {
        if AI_REQUEST_CANCELLED.load(Ordering::Acquire) {
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

/// Runs one tool request off the stdout loop and answers it on the duplex channel.
///
/// Off the loop because the agent executes tool calls in parallel and the loop must stay free to
/// read the next line: a dispatch that blocked it — a debugger wait, a documentation retrieval —
/// would stall every event behind it, including the ones that prove the tool is working.
fn spawn_tool_worker<R: Runtime>(
    app: &AppHandle<R>,
    stdin: &Arc<Mutex<process::ProcessWriter>>,
    payload: &str,
) -> Result<std::thread::JoinHandle<()>, String> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct WorkerToolCall {
        id: String,
        #[serde(flatten)]
        request: ai_tools::ToolRequest,
    }

    let call: WorkerToolCall = serde_json::from_str(payload)
        .map_err(|error| format!("Pi AI returned an invalid tool request: {error}"))?;
    let app = app.clone();
    let stdin = Arc::clone(stdin);
    Ok(std::thread::spawn(move || {
        let answer = match ai_tools::dispatch(&app, call.request) {
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
    stdin: &Arc<Mutex<process::ProcessWriter>>,
    payload: &[u8],
) -> std::io::Result<()> {
    let mut writer = stdin
        .lock()
        .map_err(|_| std::io::Error::other("The AI worker input lock is poisoned"))?;
    writer.write_all(payload)?;
    writer.write_all(b"\n")?;
    writer.flush()
}

fn retrieve_memory_context(
    storage: &ProjectStorage,
    prompt: &str,
    task_id: Option<&str>,
) -> Result<String, String> {
    #[cfg(feature = "webdriver")]
    if std::env::var_os("GOFER_WEBDRIVER_RAG_READY").is_some() {
        return Err("Memory retrieval is disabled for the prepared WebDriver cache".to_owned());
    }

    if prompt.trim().is_empty() {
        return Err("No text is available for memory retrieval".to_owned());
    }
    let vector = memory::embed_query(prompt, &rag::cache_path()?).ok();
    let results = storage.search_memory(&SearchMemoryRequest {
        query: prompt.to_owned(),
        task_id: task_id.map(str::to_owned),
        vector,
        limit: Some(6),
    })?;
    if results.is_empty() {
        return Err("No relevant project memories were found".to_owned());
    }
    Ok(results
        .into_iter()
        .map(|result| format!("- [{}] {}", result.memory.kind, result.memory.content))
        .collect::<Vec<_>>()
        .join("\n"))
}

fn remember_completed_turn(
    storage: &ProjectStorage,
    task_id: Option<&str>,
    prompt: &str,
    completion: &str,
) -> Result<(), String> {
    #[cfg(feature = "webdriver")]
    if std::env::var_os("GOFER_WEBDRIVER_RAG_READY").is_some() {
        return Ok(());
    }

    if prompt.trim().is_empty() || completion.trim().is_empty() {
        return Ok(());
    }
    let content = format!(
        "User request: {}\nOutcome: {}",
        truncate_text(prompt.trim(), 1_000),
        truncate_text(completion.trim(), 2_000)
    );
    let record = storage.upsert_memory(&UpsertMemoryRequest {
        id: None,
        task_id: task_id.map(str::to_owned),
        kind: "summary".to_owned(),
        state: "confirmed".to_owned(),
        content: content.clone(),
        provenance: serde_json::json!({"source": "completed-ai-turn"}),
        superseded_by: None,
    })?;
    // A failure here must not fail the AI turn, but it must not vanish either: the memory stays
    // lexical-only until maintenance re-embeds it, so say so instead of silently degrading.
    match embed_memory(storage, &record.id, &content) {
        Ok(()) => Ok(()),
        Err(error) => {
            eprintln!(
                "Storing the memory embedding failed, retry with storage maintenance: {error}"
            );
            Err(error)
        }
    }
}

fn embed_memory(storage: &ProjectStorage, memory_id: &str, content: &str) -> Result<(), String> {
    let vector = memory::embed_documents(&[content.to_owned()], &rag::cache_path()?)?
        .pop()
        .ok_or_else(|| "The memory worker returned no document vector".to_owned())?;
    storage.save_memory_embedding(&SaveMemoryEmbeddingRequest {
        memory_id: memory_id.to_owned(),
        model: memory::MODEL.to_owned(),
        vector,
    })
}

/// Re-embeds memories that lost or never received a vector, returning how many were restored.
///
/// Embedding needs the memory worker, so this cannot live in `storage`. It stops at the first
/// failure because every remaining memory would fail the same way when the worker is unavailable.
fn backfill_memory_embeddings(storage: &ProjectStorage) -> usize {
    let Ok(pending) = storage.memories_missing_embeddings(MEMORY_BACKFILL_LIMIT) else {
        return 0;
    };
    let mut restored = 0;
    for memory in pending {
        if embed_memory(storage, &memory.id, &memory.content).is_err() {
            break;
        }
        restored += 1;
    }
    restored
}

fn truncate_text(text: &str, maximum: usize) -> String {
    text.chars().take(maximum).collect()
}

fn ai_worker_path() -> Result<PathBuf, String> {
    let configured = std::env::var_os("GOFER_AI_WORKER").map(PathBuf::from);
    let path = configured.unwrap_or_else(|| {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("scripts")
            .join("ai-worker.mjs")
    });

    if path.is_file() {
        return Ok(path);
    }
    Err(format!(
        "The Pi AI worker was not found at {}. Run npm install, or set GOFER_AI_WORKER.",
        path.display()
    ))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "linux")]
    // SAFETY: this runs at process startup, before Tauri or WebKit creates worker threads.
    unsafe {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }

    let builder = tauri::Builder::default();
    #[cfg(feature = "webdriver")]
    let builder = builder
        .plugin(tauri_plugin_wdio::init())
        .plugin(tauri_plugin_wdio_webdriver::init());

    let builder = builder.plugin(tauri_plugin_dialog::init());

    // A workspace Gofer cannot open is the health check's problem, not a reason to refuse to
    // start: failing here fails `build`, which panics, and the user is left with no window and no
    // way to point Gofer at a folder that would have worked.
    let builder = builder.setup(|app| {
        app.manage(StorageSlot::new(open_project_storage(app.handle())));
        Ok(())
    });

    let builder = builder.invoke_handler(tauri::generate_handler![
        activate_chat_task,
        apply_health_remedy,
        apply_script_rename,
        call_godot,
        check_workspace_health,
        call_godot_debug,
        call_script_language,
        cancel_ai_request,
        close_script_document,
        create_chat_task,
        create_project_backup,
        delete_chat_task,
        delete_rag_cache,
        delete_workspace_path,
        edit_workspace_file,
        format_gdscript,
        get_godot_session,
        get_rag_cache_status,
        import_legacy_chat,
        initialize_rag,
        list_ai_models,
        list_project_tasks,
        list_workspace_files,
        load_chat,
        load_settings,
        merge_task_worktree,
        move_workspace_path,
        open_script_document,
        query_godot_docs,
        read_chat_attachment,
        read_godot_logs,
        read_workspace_file,
        respond_tool_approval,
        run_storage_maintenance,
        save_chat,
        save_script_document,
        save_settings,
        save_chat_attachment,
        search_godot_log_history,
        send_ai_message,
        start_godot_session,
        stop_godot_session,
        subscribe_godot_events,
        subscribe_script_diagnostics,
        test_ai_connection,
        unsubscribe_godot_events,
        unsubscribe_script_diagnostics,
        unwatch_workspace_files,
        update_script_document,
        watch_workspace_files,
        write_workspace_file,
    ]);

    builder
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // The editor is Gofer's own child, and the addon it staged lives in the user's
            // worktree. Closing the window without this leaves both behind: a Godot process the
            // user did not start, editing files Gofer promised to clean up.
            if matches!(event, tauri::RunEvent::Exit) {
                let _ = godot_session_api::stop_session(app);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::process::{
        ChildProcess, ProcessOutput, ProcessReader, ProcessStatus, ProcessWriter,
    };
    use std::ffi::{OsStr, OsString};
    use std::io::{self, Cursor, Read, Write};
    use std::net::TcpListener;
    use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};
    use std::thread;
    use tempfile::TempDir;

    static AI_TEST_LOCK: Mutex<()> = Mutex::new(());

    struct FakeProcessSpawner {
        child: Mutex<Option<FakeChildProcess>>,
        fail_spawn: bool,
        /// Everything the backend wrote to the worker: the startup context, then one line per
        /// answered tool call.
        written: Arc<Mutex<Vec<u8>>>,
    }

    /// A stdin pipe the test can read back. `Cursor` would swallow the writes it exists to prove.
    struct SharedWriter(Arc<Mutex<Vec<u8>>>);

    impl Write for SharedWriter {
        fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
            self.0
                .lock()
                .map_err(|_| io::Error::other("fake stdin lock poisoned"))?
                .extend_from_slice(buffer);
            Ok(buffer.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    impl FakeProcessSpawner {
        fn new(stdout: &str, stderr: &str, success: bool) -> Self {
            let written = Arc::new(Mutex::new(Vec::new()));
            Self {
                child: Mutex::new(Some(FakeChildProcess {
                    stdin: Some(Box::new(SharedWriter(Arc::clone(&written)))),
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
                    killed: Arc::new(AtomicBool::new(false)),
                })),
                fail_spawn: false,
                written,
            }
        }

        /// The lines the backend sent the worker, decoded.
        fn sent(&self) -> Vec<serde_json::Value> {
            let written = self.written.lock().expect("fake stdin lock");
            String::from_utf8_lossy(&written)
                .lines()
                .filter(|line| !line.is_empty())
                .map(|line| serde_json::from_str(line).expect("worker input line is NDJSON"))
                .collect()
        }
    }

    impl ProcessSpawner for FakeProcessSpawner {
        fn output(&self, _: &OsStr, _: &[OsString]) -> io::Result<ProcessOutput> {
            unreachable!("Node worker tests do not request command output")
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
                .ok_or_else(|| io::Error::other("fake process already spawned"))
        }
    }

    struct FakeChildProcess {
        stdin: Option<ProcessWriter>,
        stdout: Option<ProcessReader>,
        stderr: Option<ProcessReader>,
        status: ProcessStatus,
        killed: Arc<AtomicBool>,
    }

    impl ChildProcess for FakeChildProcess {
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
            self.killed.store(true, AtomicOrdering::Release);
            Ok(())
        }
    }

    fn mock_app() -> tauri::App<tauri::test::MockRuntime> {
        let app = tauri::test::mock_builder()
            .build(tauri::generate_context!())
            .expect("build mock Tauri app");
        tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("build mock webview");
        app
    }

    fn worker_request() -> AiWorkerRequest {
        AiWorkerRequest {
            settings: AiSettings::default(),
            api_key: None,
            messages: vec![AiWorkerMessage {
                sender: ChatSender::User,
                text: "hello".to_owned(),
                timestamp: 1,
                images: Vec::new(),
            }],
            agent_messages: None,
            workspace_path: "/tmp/workspace".to_owned(),
            memory_context: None,
            tools: ai_tools::CATALOG,
        }
    }

    #[derive(Default)]
    struct FakeCredentialStore {
        value: Mutex<Option<String>>,
        fail_clear: bool,
        fail_load: bool,
        fail_store: bool,
    }

    impl CredentialStore for FakeCredentialStore {
        fn clear(&self) -> Result<(), String> {
            if self.fail_clear {
                return Err("fake clear failure".to_owned());
            }
            *self.value.lock().expect("fake credential lock") = None;
            Ok(())
        }

        fn load(&self) -> Result<Option<String>, String> {
            if self.fail_load {
                return Err("fake load failure".to_owned());
            }
            Ok(self.value.lock().expect("fake credential lock").clone())
        }

        fn store(&self, value: &str) -> Result<(), String> {
            if self.fail_store {
                return Err("fake store failure".to_owned());
            }
            *self.value.lock().expect("fake credential lock") = Some(value.to_owned());
            Ok(())
        }
    }

    fn settings(base_url: impl Into<String>, model: impl Into<String>) -> GoferSettings {
        GoferSettings {
            version: SETTINGS_VERSION,
            ai: AiSettings {
                connection_type: AiConnectionType::OpenaiCompatible,
                name: " Test connection ".to_owned(),
                base_url: base_url.into(),
                model: model.into(),
                api: ApiDialect::OpenaiCompletions,
                ..AiSettings::default()
            },
        }
    }

    fn request(base_url: impl Into<String>, model: impl Into<String>) -> SettingsRequest {
        SettingsRequest {
            settings: settings(base_url, model),
            api_key: ApiKeyUpdate::Set {
                value: " secret-token ".to_owned(),
            },
        }
    }

    #[test]
    fn injected_node_worker_streams_events_and_reports_lifecycle_failures() {
        let _test = AI_TEST_LOCK.lock().expect("AI test lock");
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
        assert_eq!(
            run_ai_worker_with(app.handle(), 7, worker_request(), &spawner)
                .expect("fake AI completion"),
            "Hello"
        );

        let incomplete = FakeProcessSpawner::new("unrelated output\n", "", true);
        assert_eq!(
            run_ai_worker_with(app.handle(), 8, worker_request(), &incomplete).unwrap_err(),
            "Pi AI worker exited without completing the response"
        );

        let invalid = FakeProcessSpawner::new("GOFER_AI_EVENT:not-json\n", "", true);
        assert!(
            run_ai_worker_with(app.handle(), 9, worker_request(), &invalid)
                .unwrap_err()
                .contains("invalid event")
        );

        AI_REQUEST_CANCELLED.store(false, Ordering::Release);
        let failed = FakeProcessSpawner::new("", "provider failed\n", false);
        assert_eq!(
            run_ai_worker_with(app.handle(), 10, worker_request(), &failed).unwrap_err(),
            "Pi AI request failed: provider failed"
        );
        let silent_failure = FakeProcessSpawner::new("", "", false);
        assert!(
            run_ai_worker_with(app.handle(), 10, worker_request(), &silent_failure)
                .unwrap_err()
                .contains("exit status: 1")
        );

        let missing = FakeProcessSpawner {
            child: Mutex::new(None),
            fail_spawn: true,
            written: Arc::new(Mutex::new(Vec::new())),
        };
        assert!(
            run_ai_worker_with(app.handle(), 10, worker_request(), &missing)
                .unwrap_err()
                .contains("Could not start the Pi AI worker")
        );

        AI_REQUEST_CANCELLED.store(true, Ordering::Release);
        let cancelled = FakeProcessSpawner::new("", "killed", false);
        assert_eq!(
            run_ai_worker_with(app.handle(), 11, worker_request(), &cancelled)
                .expect("cancelled worker"),
            ""
        );
        AI_REQUEST_CANCELLED.store(false, Ordering::Release);
        *AI_CHILD.lock().expect("AI child lock") = None;
    }

    #[test]
    fn the_worker_channel_carries_the_tool_catalog_and_answers_tool_requests() {
        let _test = AI_TEST_LOCK.lock().expect("AI test lock");
        let app = mock_app();
        // Two calls: one the router rejects outright, one that reaches a handler with no session.
        // Both must come back as structured failures on the same channel the events ride.
        let output = [
            r#"GOFER_AI_TOOL:{"id":"call-1","tool":"godot_scene","params":{"op":"get_tree"}}"#,
            r#"GOFER_AI_TOOL:{"id":"call-2","tool":"godot_scene","params":{"op":"detonate"}}"#,
            r#"GOFER_AI_EVENT:{"type":"done","text":"Done","agentMessages":[],"usage":{},"model":"fake"}"#,
            "",
        ]
        .join("\n");
        let spawner = FakeProcessSpawner::new(&output, "", true);

        assert_eq!(
            run_ai_worker_with(app.handle(), 21, worker_request(), &spawner)
                .expect("fake AI completion"),
            "Done"
        );

        let sent = spawner.sent();
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
        let app = mock_app();
        // A machine-wide editor setting always asks the user. Nobody answers this one, so the turn
        // ends with the prompt still up: the tool worker must be released rather than hold the join
        // open for the whole approval timeout.
        let output = [
            r#"GOFER_AI_TOOL:{"id":"call-1","tool":"godot_project","params":{"op":"set_editor_setting","params":{"setting":"interface/editor/single_window_mode","value":true}}}"#,
            r#"GOFER_AI_EVENT:{"type":"done","text":"Asked","agentMessages":[],"usage":{},"model":"fake"}"#,
            "",
        ]
        .join("\n");
        let spawner = FakeProcessSpawner::new(&output, "", true);

        let started = std::time::Instant::now();
        assert_eq!(
            run_ai_worker_with(app.handle(), 23, worker_request(), &spawner)
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
        let app = mock_app();
        let spawner = FakeProcessSpawner::new("GOFER_AI_TOOL:not-json\n", "", true);

        assert!(
            run_ai_worker_with(app.handle(), 22, worker_request(), &spawner)
                .unwrap_err()
                .contains("invalid tool request")
        );
        *AI_CHILD.lock().expect("AI child lock") = None;
    }

    #[test]
    fn cancellation_handles_mismatched_idle_and_active_ai_requests() {
        let _test = AI_TEST_LOCK.lock().expect("AI test lock");
        let app = mock_app();
        ACTIVE_AI_REQUEST_ID.store(40, Ordering::Release);
        assert!(!cancel_ai_request_with(app.handle(), 41).expect("mismatched cancellation"));

        *AI_CHILD.lock().expect("AI child lock") = None;
        assert!(cancel_ai_request_with(app.handle(), 40).expect("idle cancellation"));

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
        assert!(cancel_ai_request_with(app.handle(), 40).expect("active cancellation"));
        assert!(killed.load(AtomicOrdering::Acquire));
        assert!(AI_REQUEST_CANCELLED.load(Ordering::Acquire));
        *AI_CHILD.lock().expect("AI child lock") = None;
        ACTIVE_AI_REQUEST_ID.store(0, Ordering::Release);
        AI_REQUEST_CANCELLED.store(false, Ordering::Release);
    }

    #[test]
    fn injected_rag_worker_streams_progress_and_classifies_failures() {
        let app = mock_app();
        let success = FakeProcessSpawner::new(
            "diagnostic\nGOFER_RAG_EVENT:{\"phase\":\"download\",\"progress\":0.5}\n",
            "",
            true,
        );
        rag::run_warmup_with(app.handle(), &success).expect("fake RAG warmup");

        let invalid = FakeProcessSpawner::new("GOFER_RAG_EVENT:not-json\n", "", true);
        assert!(
            rag::run_warmup_with(app.handle(), &invalid)
                .unwrap_err()
                .contains("invalid progress data")
        );

        let failed = FakeProcessSpawner::new("", "download failed\n", false);
        assert_eq!(
            rag::run_warmup_with(app.handle(), &failed).unwrap_err(),
            "Gofer RAG initialization failed: download failed"
        );

        let silent = FakeProcessSpawner::new("", "", false);
        assert!(
            rag::run_warmup_with(app.handle(), &silent)
                .unwrap_err()
                .contains("exit status: 1")
        );
    }

    #[test]
    fn credential_updates_use_the_injected_store() {
        let store = FakeCredentialStore::default();
        apply_api_key_update_with(
            &store,
            &ApiKeyUpdate::Set {
                value: " secret ".to_owned(),
            },
        )
        .expect("set credential");
        assert_eq!(
            store.load().expect("load set credential").as_deref(),
            Some("secret")
        );

        apply_api_key_update_with(&store, &ApiKeyUpdate::Keep).expect("keep credential");
        assert_eq!(
            store.load().expect("load kept credential").as_deref(),
            Some("secret")
        );

        apply_api_key_update_with(&store, &ApiKeyUpdate::Clear).expect("clear credential");
        assert_eq!(store.load().expect("load cleared credential"), None);
    }

    #[test]
    fn configured_app_data_paths_must_be_absolute_and_confined() {
        assert!(validate_app_data_path(std::env::temp_dir().join("gofer-data")).is_ok());
        assert!(validate_app_data_path(PathBuf::from("relative-data")).is_err());
        assert!(validate_app_data_path(std::env::temp_dir().join("../escape")).is_err());
    }

    #[test]
    fn credential_updates_validate_before_using_the_store() {
        let store = FakeCredentialStore {
            fail_store: true,
            ..Default::default()
        };
        assert_eq!(
            apply_api_key_update_with(
                &store,
                &ApiKeyUpdate::Set {
                    value: "  ".to_owned()
                }
            ),
            Err("API key cannot be empty when setting a credential".to_owned())
        );
        assert_eq!(
            apply_api_key_update_with(
                &store,
                &ApiKeyUpdate::Set {
                    value: "x".repeat(MAX_API_KEY_BYTES + 1)
                }
            ),
            Err("API keys cannot exceed 16 KiB".to_owned())
        );
        assert_eq!(
            apply_api_key_update_with(
                &store,
                &ApiKeyUpdate::Set {
                    value: "secret".to_owned()
                }
            ),
            Err("fake store failure".to_owned())
        );
    }

    #[test]
    fn credential_clear_and_restore_errors_are_propagated() {
        let clear_failure = FakeCredentialStore {
            fail_clear: true,
            ..Default::default()
        };
        assert_eq!(
            apply_api_key_update_with(&clear_failure, &ApiKeyUpdate::Clear),
            Err("fake clear failure".to_owned())
        );
        assert_eq!(
            restore_api_key_with(&clear_failure, None),
            Err("fake clear failure".to_owned())
        );

        let store_failure = FakeCredentialStore {
            fail_store: true,
            ..Default::default()
        };
        assert_eq!(
            restore_api_key_with(&store_failure, Some("previous")),
            Err("Could not restore the previous AI API key: fake store failure".to_owned())
        );

        let load_failure = FakeCredentialStore {
            fail_load: true,
            ..Default::default()
        };
        let response = settings_response_with(&load_failure, settings("http://localhost", "model"));
        assert!(!response.has_api_key);
        assert_eq!(
            response.credential_store_error.as_deref(),
            Some("fake load failure")
        );
    }

    #[test]
    fn tauri_mock_runtime_exposes_godot_session_commands() {
        use tauri::Manager;
        use tauri::ipc::{CallbackFn, InvokeBody};
        use tauri::test::{INVOKE_KEY, get_ipc_response, mock_builder};
        use tauri::webview::InvokeRequest;

        let directory = TempDir::new().expect("temporary application data");
        let workspace = directory.path().join("workspace");
        fs::create_dir(&workspace).expect("create workspace");
        let storage = ProjectStorage::open(&directory.path().join("data"), &workspace)
            .expect("open project storage");

        let app = mock_builder()
            .invoke_handler(tauri::generate_handler![
                start_godot_session,
                stop_godot_session,
                get_godot_session,
                call_godot,
                respond_tool_approval
            ])
            .build(tauri::generate_context!())
            .expect("build mock Tauri app");
        app.manage(StorageSlot::new(Ok(storage)));
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("build mock webview");

        let get_response = get_ipc_response(
            &webview,
            InvokeRequest {
                cmd: "get_godot_session".into(),
                callback: CallbackFn(0),
                error: CallbackFn(1),
                url: "tauri://localhost".parse().expect("mock URL"),
                body: InvokeBody::Json(serde_json::json!({})),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.to_owned(),
            },
        )
        .expect("invoke get_godot_session")
        .deserialize::<Option<godot_session_api::GodotSessionResponse>>()
        .expect("deserialize session response");
        assert!(get_response.is_none());

        let start_error = get_ipc_response(
            &webview,
            InvokeRequest {
                cmd: "start_godot_session".into(),
                callback: CallbackFn(0),
                error: CallbackFn(1),
                url: "tauri://localhost".parse().expect("mock URL"),
                body: InvokeBody::Json(serde_json::json!({"request": {}})),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.to_owned(),
            },
        )
        .unwrap_err();
        assert!(start_error.to_string().contains("no_active_task_workspace"));

        let call_error = get_ipc_response(
            &webview,
            InvokeRequest {
                cmd: "call_godot".into(),
                callback: CallbackFn(0),
                error: CallbackFn(1),
                url: "tauri://localhost".parse().expect("mock URL"),
                body: InvokeBody::Json(serde_json::json!({
                    "request": {
                        "id": "call-1",
                        "command": "session.get_state",
                        "params": {}
                    }
                })),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.to_owned(),
            },
        )
        .unwrap_err();
        assert!(call_error.to_string().contains("session_not_active"));

        let approval_error = get_ipc_response(
            &webview,
            InvokeRequest {
                cmd: "respond_tool_approval".into(),
                callback: CallbackFn(0),
                error: CallbackFn(1),
                url: "tauri://localhost".parse().expect("mock URL"),
                body: InvokeBody::Json(serde_json::json!({
                    "request": {
                        "approvalId": "approval-1",
                        "approved": true
                    }
                })),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.to_owned(),
            },
        )
        .unwrap_err();
        // Nothing is waiting: an answer to a prompt that no longer exists must not silently pass
        // for approval of the next one.
        assert!(approval_error.to_string().contains("unknown_approval"));
    }

    fn chat_attachment() -> ChatAttachment {
        ChatAttachment {
            id: "018f47aa-09d2-7b34-a2d3-8c4e6f123456".to_owned(),
            name: "scene.png".to_owned(),
            mime_type: "image/png".to_owned(),
            size: 2,
        }
    }

    fn mock_server(status: &str, body: &str) -> (String, thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock server");
        let address = listener.local_addr().expect("mock server address");
        let status = status.to_owned();
        let body = body.to_owned();
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept request");
            let mut request = [0_u8; 4096];
            let length = stream.read(&mut request).expect("read request");
            let response = format!(
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            stream
                .write_all(response.as_bytes())
                .expect("write response");
            String::from_utf8_lossy(&request[..length]).into_owned()
        });
        (format!("http://{address}/v1/"), handle)
    }

    #[test]
    fn settings_defaults_when_file_is_missing() {
        let directory = TempDir::new().expect("temporary directory");
        let loaded = read_settings_from_path(&directory.path().join("settings.json"))
            .expect("default settings");

        assert_eq!(loaded, GoferSettings::default());
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
    fn settings_round_trip_and_normalize_values() {
        let directory = TempDir::new().expect("temporary directory");
        let path = directory.path().join("nested/settings.json");
        let normalized = validate_settings(settings(" http://localhost:8080/v1/// ", " model "))
            .expect("valid settings");

        write_settings_to_path(&path, &normalized).expect("write settings");
        let loaded = read_settings_from_path(&path).expect("read settings");

        assert_eq!(loaded.ai.name, "Test connection");
        assert_eq!(loaded.ai.model, "model");
        assert_eq!(loaded.ai.base_url, "http://localhost:8080/v1");
        assert!(
            fs::read_to_string(path)
                .expect("settings contents")
                .ends_with('\n')
        );
    }

    #[test]
    fn invalid_settings_are_rejected() {
        let mut unsupported = settings("http://localhost/v1", "model");
        unsupported.version = SETTINGS_VERSION + 1;
        assert!(
            validate_settings(unsupported)
                .unwrap_err()
                .contains("Unsupported settings version")
        );

        let mut blank_name = settings("http://localhost/v1", "model");
        blank_name.ai.name = "  ".to_owned();
        assert_eq!(
            validate_settings(blank_name).unwrap_err(),
            "Connection name is required"
        );

        assert_eq!(
            validate_settings(settings("http://localhost/v1", "  ")).unwrap_err(),
            "Model ID is required"
        );
        assert!(
            validate_settings(settings("relative/path", "model"))
                .unwrap_err()
                .contains("valid absolute URL")
        );
        assert_eq!(
            validate_settings(settings("file:///tmp/server", "model")).unwrap_err(),
            "Base URL must use http or https"
        );
        assert!(
            validate_settings(settings("https://user:secret@example.com/v1", "model"))
                .unwrap_err()
                .contains("credentials")
        );
        assert!(
            validate_settings(settings("https://example.com/v1?token=secret", "model"))
                .unwrap_err()
                .contains("query")
        );
    }

    #[test]
    fn validation_rejects_every_bounded_settings_and_chat_shape() {
        let invalid_settings = [
            {
                let mut value = settings("http://localhost", "model");
                value.ai.name = "x".repeat(101);
                value
            },
            {
                let mut value = settings("http://localhost", "model");
                value.ai.model = "x".repeat(513);
                value
            },
            {
                let mut value = settings("http://localhost", "model");
                value.ai.model_name = "x".repeat(513);
                value
            },
            {
                let mut value = settings("http://localhost", "model");
                value.ai.system_prompt = "x".repeat(64 * 1_024 + 1);
                value
            },
            {
                let mut value = settings("http://localhost", "model");
                value.ai.input = Vec::new();
                value
            },
            {
                let mut value = settings("http://localhost", "model");
                value.ai.input = vec!["text".to_owned(); 17];
                value
            },
            {
                let mut value = settings("http://localhost", "model");
                value.ai.input = vec![String::new()];
                value
            },
            {
                let mut value = settings("http://localhost", "model");
                value.ai.context_window = 0;
                value
            },
            {
                let mut value = settings("http://localhost", "model");
                value.ai.max_tokens = 0;
                value
            },
            {
                let mut value = settings("http://localhost", "model");
                value.ai.max_retries = 11;
                value
            },
            {
                let mut value = settings("http://localhost", "model");
                value.ai.timeout_ms = 999;
                value
            },
            {
                let mut value = settings("http://localhost", "model");
                value.ai.thinking_level = "impossible".to_owned();
                value
            },
            settings("https://example.com/v1#fragment", "model"),
            settings("https://user:password@example.com/v1", "model"),
            settings(
                format!("https://example.com/{}", "x".repeat(2_048)),
                "model",
            ),
        ];
        for value in invalid_settings {
            assert!(validate_settings(value).is_err());
        }

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
        assert_eq!(resolve_api_key(&ApiKeyUpdate::Clear), Ok(None));
        assert!(
            resolve_api_key(&ApiKeyUpdate::Set {
                value: " ".to_owned()
            })
            .is_err()
        );
        assert!(
            resolve_api_key(&ApiKeyUpdate::Set {
                value: "x".repeat(MAX_API_KEY_BYTES + 1)
            })
            .is_err()
        );
    }

    #[test]
    fn pi_model_file_drives_catalog_and_default_settings() {
        let directory = TempDir::new().expect("temporary Pi settings");
        let path = directory.path().join("models.json");
        fs::write(
            &path,
            r#"{
                "providers": {
                    "local": {
                        "baseUrl": "http://127.0.0.1:11434/v1",
                        "compat": {"supportsReasoningEffort": true},
                        "models": [{
                            "id": "vision-model",
                            "name": "Vision Model",
                            "contextWindow": 8192,
                            "maxTokens": 2048,
                            "input": ["text", "image"]
                        }]
                    }
                }
            }"#,
        )
        .expect("write Pi models");

        let catalog = pi_model_catalog_from_path(&path).expect("Pi catalog");
        assert_eq!(catalog.len(), 1);
        assert_eq!(catalog[0].name, "Vision Model");
        assert!(catalog[0].reasoning);
        assert_eq!(catalog[0].input, ["text", "image"]);
        let defaults = default_settings_from_pi_path(&path).expect("Pi defaults");
        assert_eq!(defaults.ai.model, "vision-model");
        assert_eq!(defaults.ai.context_window, 8_192);
        assert!(defaults.ai.supports_reasoning_effort);

        fs::write(&path, "not-json").expect("write invalid Pi models");
        assert!(
            pi_model_catalog_from_path(&path)
                .unwrap_err()
                .contains("invalid")
        );
        assert!(default_settings_from_pi_path(&path).is_none());
    }

    #[test]
    fn corrupt_settings_file_is_rejected() {
        let directory = TempDir::new().expect("temporary directory");
        let path = directory.path().join("settings.json");
        fs::write(&path, "not json").expect("write corrupt settings");

        assert!(
            read_settings_from_path(&path)
                .unwrap_err()
                .contains("are invalid")
        );
    }
    #[tokio::test]
    async fn connection_test_reports_available_model_and_sends_bearer_key() {
        let (base_url, server) = mock_server("200 OK", r#"{"data":[{"id":"wanted"}]}"#);
        let result = test_ai_connection(request(base_url, "wanted"))
            .await
            .expect("connection result");
        let received = server.join().expect("mock server request");

        assert_eq!(result.status, ConnectionTestStatus::Connected);
        assert!(received.starts_with("GET /v1/models HTTP/1.1"));
        assert!(
            received
                .to_ascii_lowercase()
                .contains("authorization: bearer secret-token")
        );
    }

    #[tokio::test]
    async fn connection_test_classifies_model_auth_and_server_failures() {
        let (base_url, server) = mock_server("200 OK", r#"{"data":[{"id":"other"}]}"#);
        let result = test_ai_connection(request(base_url, "wanted"))
            .await
            .expect("model result");
        server.join().expect("model request");
        assert_eq!(result.status, ConnectionTestStatus::ModelUnavailable);

        for status in ["401 Unauthorized", "403 Forbidden"] {
            let (base_url, server) = mock_server(status, "{}");
            let result = test_ai_connection(request(base_url, "wanted"))
                .await
                .expect("auth result");
            server.join().expect("auth request");
            assert_eq!(result.status, ConnectionTestStatus::Unauthorized);
        }

        let (base_url, server) = mock_server("500 Internal Server Error", "{}");
        let result = test_ai_connection(request(base_url, "wanted"))
            .await
            .expect("server result");
        server.join().expect("server request");
        assert_eq!(result.status, ConnectionTestStatus::ServerError);
    }

    #[tokio::test]
    async fn connection_test_rejects_invalid_models_response() {
        let (base_url, server) = mock_server("200 OK", "not-json");
        let error = test_ai_connection(request(base_url, "wanted"))
            .await
            .unwrap_err();
        server.join().expect("invalid response request");

        assert!(error.contains("invalid OpenAI models response"));
    }

    #[tokio::test]
    async fn connection_test_reports_unreachable_server() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("reserve address");
        let address = listener.local_addr().expect("reserved address");
        drop(listener);

        let result = test_ai_connection(request(format!("http://{address}/v1"), "wanted"))
            .await
            .expect("unreachable result");

        assert_eq!(result.status, ConnectionTestStatus::ServerUnreachable);
    }

    #[tokio::test]
    async fn model_listing_maps_remote_metadata_and_reports_failures() {
        let (base_url, server) = mock_server(
            "200 OK",
            r#"{"data":[{"id":"custom","meta":{"n_ctx":4096}},{"id":"plain"}]}"#,
        );
        let models = list_ai_models(request(base_url, "custom"))
            .await
            .expect("model list");
        server.join().expect("model list request");
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].id, "custom");
        assert_eq!(models[0].context_window, 4_096);
        assert_eq!(models[0].max_tokens, 4_096);
        assert_eq!(models[1].name, "plain");

        let (base_url, server) = mock_server("500 Internal Server Error", "{}");
        assert!(
            list_ai_models(request(base_url, "custom"))
                .await
                .unwrap_err()
                .contains("HTTP 500")
        );
        server.join().expect("failed model list request");

        let (base_url, server) = mock_server("200 OK", "not-json");
        assert!(
            list_ai_models(request(base_url, "custom"))
                .await
                .unwrap_err()
                .contains("invalid OpenAI models response")
        );
        server.join().expect("invalid model list request");
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
            .unwrap_err(),
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
            .contains("10 MiB")
        );
    }

    /// A command the main window cannot call is a command that does not exist, and nothing says so
    /// until the window invokes it: Tauri's ACL is enforced at runtime, so registering a command
    /// without allowing it fails only in front of the user. This compares the two lists directly.
    #[test]
    fn every_registered_command_is_allowed_for_the_main_window() {
        use std::collections::BTreeSet;

        let source = include_str!("lib.rs");
        let handler = source
            .split_once("invoke_handler(tauri::generate_handler![")
            .expect("the invoke handler is registered")
            .1
            .split_once("]);")
            .expect("the invoke handler list is closed")
            .0;
        let registered: BTreeSet<&str> = handler
            .lines()
            .map(|line| line.trim().trim_end_matches(','))
            .filter(|name| !name.is_empty() && !name.starts_with("//"))
            .collect();

        let permissions = include_str!("../permissions/main-window-commands.toml");
        let allowed: BTreeSet<&str> = permissions
            .lines()
            .filter_map(|line| line.trim().strip_prefix('"'))
            .filter_map(|line| line.split_once('"'))
            .map(|(name, _)| name)
            .collect();

        assert_eq!(
            registered.difference(&allowed).collect::<Vec<_>>(),
            Vec::<&&str>::new(),
            "these commands are registered but the main window may not call them; \
             add them to src-tauri/permissions/main-window-commands.toml"
        );
        assert_eq!(
            allowed.difference(&registered).collect::<Vec<_>>(),
            Vec::<&&str>::new(),
            "these commands are allowed but no longer registered; remove them from \
             src-tauri/permissions/main-window-commands.toml"
        );
    }
}

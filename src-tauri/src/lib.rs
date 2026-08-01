use base64::Engine;
use keyring::{Entry, Error as KeyringError};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

mod git;
mod godot;
mod memory;
mod storage;

use storage::{
    BackupResult, GodotRunRecord, MaintenanceResult, MergeTaskResult, ProjectStorage,
    SaveMemoryEmbeddingRequest, SearchMemoryRequest, StoredAttachment, StoredChat, TaskRecord,
    UpsertMemoryRequest,
};

const API_KEY_SERVICE: &str = "com.gofer.desktop";
const API_KEY_USERNAME: &str = "ai-default";
const AI_EVENT_PREFIX: &str = "GOFER_AI_EVENT:";
const RAG_EVENT_PREFIX: &str = "GOFER_RAG_EVENT:";
const SETTINGS_FILE_NAME: &str = "settings.json";
const CHAT_ATTACHMENTS_DIRECTORY: &str = "chat-attachments";
const SETTINGS_VERSION: u32 = 1;
const MAX_CHAT_ATTACHMENT_BYTES: usize = 10 * 1024 * 1024;
const MAX_CHAT_ATTACHMENT_BASE64_BYTES: usize = MAX_CHAT_ATTACHMENT_BYTES.div_ceil(3) * 4;
const MAX_CHAT_MESSAGES: usize = 200;
const MAX_CHAT_MESSAGE_BYTES: usize = 256 * 1024;
const MAX_CHAT_TEXT_BYTES: usize = 4 * 1024 * 1024;
const MAX_AGENT_MESSAGES_BYTES: usize = 8 * 1024 * 1024;
const MAX_API_KEY_BYTES: usize = 16 * 1024;
static RAG_INITIALIZING: AtomicBool = AtomicBool::new(false);
static ACTIVE_RAG_INITIALIZATION: Mutex<Option<Arc<RagInitialization>>> = Mutex::new(None);
static AI_REQUEST_RUNNING: AtomicBool = AtomicBool::new(false);
static AI_REQUEST_CANCELLED: AtomicBool = AtomicBool::new(false);
static ACTIVE_AI_REQUEST_ID: AtomicU64 = AtomicU64::new(0);
static AI_CHILD: Mutex<Option<Arc<Mutex<Child>>>> = Mutex::new(None);
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

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum CacheState {
    Installed,
    Incomplete,
    NotInstalled,
    Busy,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CacheStatus {
    path: String,
    size_bytes: u64,
    state: CacheState,
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

struct InitializationGuard;

impl Drop for InitializationGuard {
    fn drop(&mut self) {
        RAG_INITIALIZING.store(false, Ordering::Release);
    }
}

struct RagInitialization {
    result: Mutex<Option<Result<(), String>>>,
    completed: Condvar,
}

impl RagInitialization {
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

struct ActiveRagInitializationGuard {
    initialization: Arc<RagInitialization>,
    finished: bool,
}

impl ActiveRagInitializationGuard {
    fn finish(mut self, result: Result<(), String>) {
        self.finish_with(result);
        self.finished = true;
    }

    fn finish_with(&self, completion: Result<(), String>) {
        let mut active = ACTIVE_RAG_INITIALIZATION
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
        RAG_INITIALIZING.store(false, Ordering::Release);
        drop(active);
        drop(result);
        self.initialization.completed.notify_all();
    }
}

impl Drop for ActiveRagInitializationGuard {
    fn drop(&mut self) {
        if self.finished {
            return;
        }
        self.finish_with(Err(
            "Gofer RAG initialization ended before producing a result".to_owned(),
        ));
    }
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

#[tauri::command]
async fn test_ai_connection(request: SettingsRequest) -> Result<ConnectionTestResult, String> {
    let (settings, api_key) = tauri::async_runtime::spawn_blocking(move || {
        let settings = validate_settings(request.settings)?;
        let api_key = resolve_api_key(&request.api_key)?;
        Ok::<_, String>((settings, api_key))
    })
    .await
    .map_err(|error| format!("AI connection validation task failed: {error}"))??;
    let base_url = format!("{}/", settings.ai.base_url.trim_end_matches('/'));
    let models_url = reqwest::Url::parse(&base_url)
        .and_then(|url| url.join("models"))
        .map_err(|error| format!("Could not construct the models endpoint: {error}"))?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|error| format!("Could not create the AI connection client: {error}"))?;
    let mut request_builder = client.get(models_url);
    if let Some(api_key) = api_key {
        request_builder = request_builder.bearer_auth(api_key);
    }

    let response = match request_builder.send().await {
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
    let (settings, api_key) = tauri::async_runtime::spawn_blocking(move || {
        let settings = validate_settings(request.settings)?;
        let api_key = resolve_api_key(&request.api_key)?;
        Ok::<_, String>((settings, api_key))
    })
    .await
    .map_err(|error| format!("AI model validation task failed: {error}"))??;
    let base_url = format!("{}/", settings.ai.base_url.trim_end_matches('/'));
    let models_url = reqwest::Url::parse(&base_url)
        .and_then(|url| url.join("models"))
        .map_err(|error| format!("Could not construct the models endpoint: {error}"))?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|error| format!("Could not create the AI connection client: {error}"))?;
    let mut request_builder = client.get(models_url);
    if let Some(api_key) = api_key {
        request_builder = request_builder.bearer_auth(api_key);
    }
    let response = request_builder
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
        let api_key = stored_api_key()?;
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
    validate_chat_attachment(&request.attachment)?;
    if request.data.len() > MAX_CHAT_ATTACHMENT_BASE64_BYTES {
        return Err("Images cannot be larger than 10 MiB".to_owned());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&request.data)
        .map_err(|error| format!("The attachment data is not valid base64: {error}"))?;
    if bytes.len() > MAX_CHAT_ATTACHMENT_BYTES {
        return Err("Images cannot be larger than 10 MiB".to_owned());
    }
    if bytes.len() as u64 != request.attachment.size {
        return Err("The attachment size does not match its contents".to_owned());
    }
    project_storage(&app)?.save_attachment(&request.attachment.as_stored(), &bytes)
}

#[tauri::command(async)]
fn read_chat_attachment(app: AppHandle, attachment: ChatAttachment) -> Result<String, String> {
    validate_chat_attachment(&attachment)?;
    let bytes = project_storage(&app)?.read_attachment(&attachment.as_stored())?;
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
    project_storage(&app)?.merge_task(&task_id)
}

#[tauri::command(async)]
fn create_project_backup(app: AppHandle) -> Result<BackupResult, String> {
    project_storage(&app)?.create_backup()
}

#[tauri::command(async)]
fn run_storage_maintenance(app: AppHandle) -> Result<MaintenanceResult, String> {
    project_storage(&app)?.run_maintenance()
}

#[tauri::command]
async fn launch_godot(
    app: AppHandle,
    request: godot::LaunchGodotRequest,
) -> Result<GodotRunRecord, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let storage = project_storage(&app)?;
        godot::launch(&app, storage, request)
    })
    .await
    .map_err(|error| format!("Godot process task failed: {error}"))?
}

#[tauri::command(async)]
fn cancel_godot() -> Result<(), String> {
    godot::cancel()
}

#[tauri::command(async)]
fn cancel_ai_request(app: AppHandle, request_id: u64) -> Result<bool, String> {
    if ACTIVE_AI_REQUEST_ID.load(Ordering::Acquire) != request_id {
        return Ok(false);
    }
    AI_REQUEST_CANCELLED.store(true, Ordering::Release);
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

#[tauri::command]
async fn get_rag_cache_status() -> Result<CacheStatus, String> {
    tauri::async_runtime::spawn_blocking(cache_status)
        .await
        .map_err(|error| format!("Could not inspect the Gofer RAG cache: {error}"))?
}

#[tauri::command]
async fn delete_rag_cache() -> Result<CacheStatus, String> {
    tauri::async_runtime::spawn_blocking(|| {
        if RAG_INITIALIZING
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Err(
                "The model cache cannot be deleted while another model operation is running"
                    .to_owned(),
            );
        }
        let operation = InitializationGuard;

        let path = rag_cache_path()?;
        delete_cache_path(&path)?;
        drop(operation);
        cache_status()
    })
    .await
    .map_err(|error| format!("Could not delete the Gofer RAG cache: {error}"))?
}

#[tauri::command]
async fn initialize_rag(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || run_rag_initialization(|| run_rag_warmup(&app)))
        .await
        .map_err(|error| format!("Gofer RAG initialization task failed: {error}"))?
}

fn run_rag_initialization(operation: impl FnOnce() -> Result<(), String>) -> Result<(), String> {
    let (initialization, is_leader) = {
        let mut active = ACTIVE_RAG_INITIALIZATION
            .lock()
            .map_err(|_| "The RAG initialization lock is poisoned".to_owned())?;
        if let Some(initialization) = active.as_ref() {
            (Arc::clone(initialization), false)
        } else {
            RAG_INITIALIZING
                .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                .map_err(|_| "Another model operation is already running".to_owned())?;
            let initialization = Arc::new(RagInitialization::new());
            *active = Some(Arc::clone(&initialization));
            (initialization, true)
        }
    };

    if !is_leader {
        return initialization.wait();
    }

    let guard = ActiveRagInitializationGuard {
        initialization,
        finished: false,
    };
    let result = operation();
    guard.finish(result.clone());
    result
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|path| path.join(SETTINGS_FILE_NAME))
        .map_err(|error| format!("Could not resolve Gofer's configuration directory: {error}"))
}

fn chat_attachments_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join(CHAT_ATTACHMENTS_DIRECTORY))
        .map_err(|error| format!("Could not resolve Gofer's data directory: {error}"))
}

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

fn read_chat_attachment_bytes(
    app: &AppHandle,
    attachment: &ChatAttachment,
) -> Result<Vec<u8>, String> {
    project_storage(app)?.read_attachment(&attachment.as_stored())
}

fn project_storage(app: &AppHandle) -> Result<ProjectStorage, String> {
    let data_root = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not resolve Gofer's data directory: {error}"))?;
    let workspace = std::env::current_dir()
        .map_err(|error| format!("Could not resolve the agent workspace: {error}"))?;
    ProjectStorage::open(&data_root, &workspace)
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
    let contents = fs::read_to_string(&path)
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

fn stored_api_key() -> Result<Option<String>, String> {
    match credential_entry()?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(KeyringError::NoEntry) => Ok(None),
        Err(error) => Err(format!(
            "Could not read the AI API key from the credential store: {error}"
        )),
    }
}

fn settings_response(settings: GoferSettings) -> SettingsResponse {
    match stored_api_key() {
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
            credential_entry()?
                .set_password(value)
                .map_err(|error| format!("Could not store the AI API key: {error}"))
        }
        ApiKeyUpdate::Clear => delete_api_key(),
    }
}

fn delete_api_key() -> Result<(), String> {
    match credential_entry()?.delete_credential() {
        Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
        Err(error) => Err(format!("Could not remove the AI API key: {error}")),
    }
}

fn restore_api_key(value: Option<&str>) -> Result<(), String> {
    match value {
        Some(value) => credential_entry()?
            .set_password(value)
            .map_err(|error| format!("Could not restore the previous AI API key: {error}")),
        None => delete_api_key(),
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

fn rag_cache_path() -> Result<PathBuf, String> {
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

fn cache_status() -> Result<CacheStatus, String> {
    let path = rag_cache_path()?;
    let busy = RAG_INITIALIZING.load(Ordering::Acquire);
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

fn run_rag_warmup(app: &AppHandle) -> Result<(), String> {
    let worker = rag_worker_path()?;
    let node = std::env::var("GOFER_NODE_BINARY").unwrap_or_else(|_| "node".to_owned());
    let mut child = Command::new(&node)
        .arg(&worker)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| {
            format!(
                "Could not start Node.js with '{node}': {error}. Install Node.js 22 or newer, or set GOFER_NODE_BINARY."
            )
        })?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Could not read Gofer RAG worker output".to_owned())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Could not read Gofer RAG worker errors".to_owned())?;
    let stderr_reader = std::thread::spawn(move || {
        let mut output = String::new();
        let _ = BufReader::new(stderr).read_to_string(&mut output);
        output
    });

    for line in BufReader::new(stdout).lines() {
        let line = line.map_err(|error| format!("Could not read Gofer RAG progress: {error}"))?;
        let Some(payload) = line.strip_prefix(RAG_EVENT_PREFIX) else {
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

    if status.success() {
        return Ok(());
    }

    let detail = stderr.trim();
    if detail.is_empty() {
        return Err(format!("Gofer RAG initialization exited with {status}"));
    }
    Err(format!("Gofer RAG initialization failed: {detail}"))
}

fn run_ai_worker(
    app: &AppHandle,
    request_id: u64,
    request: AiWorkerRequest,
) -> Result<String, String> {
    let worker = ai_worker_path()?;
    let node = std::env::var("GOFER_NODE_BINARY").unwrap_or_else(|_| "node".to_owned());
    let mut child = Command::new(&node)
        .arg(&worker)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| {
            format!(
                "Could not start the Pi AI worker with '{node}': {error}. Install Node.js 22.19 or newer, or set GOFER_NODE_BINARY."
            )
        })?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Could not write to the Pi AI worker".to_owned())?;
    let payload = serde_json::to_vec(&request)
        .map_err(|error| format!("Could not serialize the AI request: {error}"))?;
    stdin
        .write_all(&payload)
        .map_err(|error| format!("Could not send the request to the Pi AI worker: {error}"))?;
    drop(stdin);

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Could not read Pi AI worker output".to_owned())?;
    let stderr = child
        .stderr
        .take()
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

    for line in BufReader::new(stdout).lines() {
        let line = line.map_err(|error| format!("Could not read Pi AI output: {error}"))?;
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

    let status = child
        .lock()
        .map_err(|_| "The AI child process lock is poisoned".to_owned())?
        .wait()
        .map_err(|error| format!("Could not wait for the Pi AI worker: {error}"))?;
    let stderr = stderr_reader
        .join()
        .map_err(|_| "Could not collect Pi AI worker errors".to_owned())?;
    if !status.success() {
        if AI_REQUEST_CANCELLED.load(Ordering::Acquire) {
            return Ok(String::new());
        }
        let detail = stderr.trim();
        if detail.is_empty() {
            return Err(format!("Pi AI worker exited with {status}"));
        }
        return Err(format!("Pi AI request failed: {detail}"));
    }
    if !completed {
        return Err("Pi AI worker exited without completing the response".to_owned());
    }
    Ok(completion_text)
}

fn retrieve_memory_context(
    storage: &ProjectStorage,
    prompt: &str,
    task_id: Option<&str>,
) -> Result<String, String> {
    if prompt.trim().is_empty() {
        return Err("No text is available for memory retrieval".to_owned());
    }
    let vector = memory::embed_query(prompt, &rag_cache_path()?).ok();
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
    if let Ok(mut vectors) = memory::embed_documents(&[content], &rag_cache_path()?)
        && let Some(vector) = vectors.pop()
    {
        storage.save_memory_embedding(&SaveMemoryEmbeddingRequest {
            memory_id: record.id,
            model: memory::MODEL.to_owned(),
            vector,
        })?;
    }
    Ok(())
}

fn truncate_text(text: &str, maximum: usize) -> String {
    text.chars().take(maximum).collect()
}

fn rag_worker_path() -> Result<PathBuf, String> {
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

    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            activate_chat_task,
            cancel_ai_request,
            cancel_godot,
            create_chat_task,
            create_project_backup,
            delete_rag_cache,
            get_rag_cache_status,
            import_legacy_chat,
            initialize_rag,
            list_ai_models,
            list_project_tasks,
            launch_godot,
            load_chat,
            load_settings,
            merge_task_worktree,
            read_chat_attachment,
            run_storage_maintenance,
            save_chat,
            save_settings,
            save_chat_attachment,
            send_ai_message,
            test_ai_connection,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;
    use tempfile::TempDir;

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

    #[test]
    fn cache_path_rejects_unsafe_targets() {
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
            run_rag_initialization(|| {
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
            run_rag_initialization(|| {
                follower_flag.store(true, Ordering::Release);
                Ok(())
            })
        });

        let follower_joined = (0..1_000).any(|_| {
            let reference_count = ACTIVE_RAG_INITIALIZATION
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
        assert!(!RAG_INITIALIZING.load(Ordering::Acquire));
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
}

use keyring::{Entry, Error as KeyringError};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

const API_KEY_SERVICE: &str = "com.gofer.desktop";
const API_KEY_USERNAME: &str = "ai-default";
const RAG_EVENT_PREFIX: &str = "GOFER_RAG_EVENT:";
const SETTINGS_FILE_NAME: &str = "settings.json";
const SETTINGS_VERSION: u32 = 1;
static RAG_INITIALIZING: AtomicBool = AtomicBool::new(false);
static KEYRING_INITIALIZATION: Mutex<()> = Mutex::new(());

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct GoferSettings {
    version: u32,
    ai: AiSettings,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AiSettings {
    connection_type: AiConnectionType,
    name: String,
    base_url: String,
    model: String,
    api: ApiDialect,
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
enum AiConnectionType {
    OpenaiCompatible,
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
enum ApiDialect {
    OpenaiCompletions,
}

#[derive(Serialize)]
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

#[derive(Serialize)]
#[serde(rename_all = "kebab-case")]
enum ConnectionTestStatus {
    Connected,
    ModelUnavailable,
    Unauthorized,
    ServerError,
    ServerUnreachable,
}

#[derive(Serialize)]
struct ConnectionTestResult {
    status: ConnectionTestStatus,
    message: String,
}

#[derive(Serialize)]
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
}

struct InitializationGuard;

impl Drop for InitializationGuard {
    fn drop(&mut self) {
        RAG_INITIALIZING.store(false, Ordering::Release);
    }
}

impl Default for GoferSettings {
    fn default() -> Self {
        Self {
            version: SETTINGS_VERSION,
            ai: AiSettings {
                connection_type: AiConnectionType::OpenaiCompatible,
                name: "Local AI".to_owned(),
                base_url: "http://127.0.0.1:8080/v1".to_owned(),
                model: "Qwen3.6-27B-UD-Q4_K_XL.gguf".to_owned(),
                api: ApiDialect::OpenaiCompletions,
            },
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
    let settings = validate_settings(request.settings)?;
    let api_key = resolve_api_key(&request.api_key)?;
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
        if path.exists() {
            let metadata = fs::symlink_metadata(&path)
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
            fs::remove_dir_all(&path)
                .map_err(|error| format!("Could not delete {}: {error}", path.display()))?;
        }
        drop(operation);
        cache_status()
    })
    .await
    .map_err(|error| format!("Could not delete the Gofer RAG cache: {error}"))?
}

#[tauri::command]
async fn initialize_rag(app: AppHandle) -> Result<(), String> {
    if RAG_INITIALIZING
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Err("Gofer RAG initialization is already running".to_owned());
    }

    tauri::async_runtime::spawn_blocking(move || {
        let _guard = InitializationGuard;
        run_rag_warmup(&app)
    })
    .await
    .map_err(|error| format!("Gofer RAG initialization task failed: {error}"))?
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|path| path.join(SETTINGS_FILE_NAME))
        .map_err(|error| format!("Could not resolve Gofer's configuration directory: {error}"))
}

fn read_settings(app: &AppHandle) -> Result<GoferSettings, String> {
    let path = settings_path(app)?;
    if !path.exists() {
        return Ok(GoferSettings::default());
    }
    let contents = fs::read_to_string(&path)
        .map_err(|error| format!("Could not read {}: {error}", path.display()))?;
    let settings = serde_json::from_str(&contents)
        .map_err(|error| format!("Gofer settings in {} are invalid: {error}", path.display()))?;
    validate_settings(settings)
}

fn write_settings(app: &AppHandle, settings: &GoferSettings) -> Result<(), String> {
    let path = settings_path(app)?;
    let parent = path
        .parent()
        .ok_or_else(|| format!("Gofer settings path has no parent: {}", path.display()))?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create {}: {error}", parent.display()))?;
    let contents = serde_json::to_string_pretty(settings)
        .map_err(|error| format!("Could not serialize Gofer settings: {error}"))?;
    fs::write(&path, format!("{contents}\n"))
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
    settings.ai.base_url = settings.ai.base_url.trim().trim_end_matches('/').to_owned();
    let url = reqwest::Url::parse(&settings.ai.base_url)
        .map_err(|error| format!("Base URL must be a valid absolute URL: {error}"))?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err("Base URL must use http or https".to_owned());
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
    let state = if busy {
        CacheState::Busy
    } else if !path.exists() {
        CacheState::NotInstalled
    } else if required_model_files(&path)
        .iter()
        .all(|file| file.is_file())
    {
        CacheState::Installed
    } else {
        CacheState::Incomplete
    };
    let size_bytes = if path.exists() {
        directory_size(&path)?
    } else {
        0
    };
    Ok(CacheStatus {
        path: path.display().to_string(),
        size_bytes,
        state,
    })
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
        app.emit("rag-download-progress", progress)
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "linux")]
    // SAFETY: this runs at process startup, before Tauri or WebKit creates worker threads.
    unsafe {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            delete_rag_cache,
            get_rag_cache_status,
            initialize_rag,
            load_settings,
            save_settings,
            test_ai_connection
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

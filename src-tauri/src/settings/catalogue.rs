//! Every vendor catalogue Gofer asks a question of, and the one client it asks with.
//!
//! Four drivers, four endpoints, four answers about what a model can do — and one HTTP client
//! shared between them. Split out of `settings.rs`, where it was the largest of six subjects in one
//! file and the only one that leaves the machine.
//!
//! This is the second of Gofer's two provider seams and it is worth saying which. The turn is put
//! to a model by `scripts/ai-provider.mjs`, over pi-ai, in the worker process. Nothing here ever
//! runs a turn: this answers "which models may be picked, and is this key any good", which the
//! renderer asks before a turn exists and pi-ai has no shape for. The two are held to the same
//! closed set of drivers by `check-command-surface.mjs`, which reconciles the Rust enum, the
//! TypeScript union and the worker's `DRIVERS` list — because a model this offers that the worker
//! cannot register fails mid-turn, as "The selected model … is unavailable".
//!
//! The seam is the `RequestBuilder`: `prepare_models_request` builds one and the two callers send
//! it, so a test drives the real per-driver decisions without a network.

use super::*;

/// A validated settings payload paired with a ready-to-send request to its models endpoint.
pub(super) struct ModelsRequest {
    settings: GoferSettings,
    builder: reqwest::RequestBuilder,
}

/// How long a user-initiated connection test waits for the AI server.
pub(crate) const AI_REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
/// How long the startup health check waits for it.
///
/// Deliberately shorter: the report is what stands between the user and their project, and a
/// server that is simply not running yet must not hold the window blank while it is waited for.
pub(crate) const AI_HEALTH_TIMEOUT: Duration = Duration::from_secs(3);

/// Validates settings, resolves the credential, and builds the models-endpoint request.
///
/// Sending is left to the caller because the two commands classify transport failures
/// differently: the connection test reports them as a status, model listing as an error.
async fn prepare_models_request(
    request: SettingsRequest,
    timeout: Duration,
    path: &str,
) -> Result<ModelsRequest, String> {
    let (settings, api_key) = tauri::async_runtime::spawn_blocking(move || {
        let settings = validate_settings(request.settings)?;
        // The driver decides which credential is sent, because each has its own keyring slot. The
        // local driver's key must never reach openrouter.ai or api.cerebras.ai, and neither of
        // theirs must ever reach a server on this machine.
        let api_key = match settings.ai.connection_type {
            AiConnectionType::Openrouter => resolve(
                &request.openrouter_api_key,
                Secret::OpenRouter,
                &SystemSecrets,
            )?,
            AiConnectionType::Cerebras => {
                resolve(&request.cerebras_api_key, Secret::Cerebras, &SystemSecrets)?
            }
            _ => resolve(&request.api_key, Secret::AiDefault, &SystemSecrets)?,
        };
        Ok::<_, String>((settings, api_key))
    })
    .await
    .map_err(|error| format!("AI settings validation task failed: {error}"))??;
    // Validated above, so the live driver has a connection: the address is read off it rather
    // than off a second copy beside it.
    let base_url = format!("{}/", active_endpoint(&settings.ai).0.trim_end_matches('/'));
    let models_url = reqwest::Url::parse(&base_url)
        .and_then(|url| url.join(path))
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

pub(crate) async fn run_connection_test(
    request: SettingsRequest,
    timeout: Duration,
) -> Result<ConnectionTestResult, String> {
    if matches!(
        request.settings.ai.connection_type,
        AiConnectionType::OpenaiCodex
    ) {
        let settings = validate_settings(request.settings)?;
        let chosen = active_endpoint(&settings.ai).1;
        return tauri::async_runtime::spawn_blocking(move || {
            check_chatgpt_credential()?;
            let models = chatgpt_models()?;
            let available = models.iter().any(|model| model.id == chosen);
            Ok(if available {
                ConnectionTestResult {
                    status: ConnectionTestStatus::Connected,
                    message: format!("Signed in with ChatGPT. Model '{chosen}' is available."),
                }
            } else {
                ConnectionTestResult {
                    status: ConnectionTestStatus::ModelUnavailable,
                    message: format!(
                        "Signed in with ChatGPT, but model '{chosen}' is not in this Pi release."
                    ),
                }
            })
        })
        .await
        .map_err(|error| format!("ChatGPT connection test failed: {error}"))?;
    }
    // OpenRouter is asked `/key`, not `/models`. Its catalogue is public — it answers HTTP 200
    // with no credential at all — so a test through `/models` reports a healthy connection for a
    // key that does not exist. `/key` is the only cheap endpoint that refuses a bad one.
    let openrouter = matches!(
        request.settings.ai.connection_type,
        AiConnectionType::Openrouter
    );
    // Cerebras is asked `/models` like the local driver, not `/key` like OpenRouter. Its catalogue
    // is not public: a wrong key answers HTTP 401 `wrong_api_key`, so the ordinary endpoint already
    // refuses a credential that does not exist and there is nothing a second one would add.
    let cerebras = matches!(
        request.settings.ai.connection_type,
        AiConnectionType::Cerebras
    );
    let path = if openrouter { "key" } else { "models" };
    let ModelsRequest { settings, builder } =
        prepare_models_request(request, timeout, path).await?;

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

    // The key is good. Whether the chosen model is still in the catalogue is a second question,
    // and a public endpoint answers it without spending the credential again.
    if openrouter {
        return Ok(openrouter_model_available(&active_endpoint(&settings.ai).1, timeout).await);
    }

    let models = response.json::<ModelsResponse>().await.map_err(|error| {
        format!("The server returned an invalid OpenAI models response: {error}")
    })?;
    let chosen = active_endpoint(&settings.ai).1;
    // Narrowed the same way the picker is, and for the reason the picker is narrowed: a model
    // Cerebras serves that the shipped table has never seen is one no screen will ever offer, so
    // reporting a healthy connection to it would be reporting a connection nobody can select.
    if cerebras {
        return Ok(
            if cerebras_model_options(&models.data)
                .iter()
                .any(|option| option.id == chosen)
            {
                ConnectionTestResult {
                    status: ConnectionTestStatus::Connected,
                    message: format!("Connected to Cerebras. Model '{chosen}' is available."),
                }
            } else {
                ConnectionTestResult {
                    status: ConnectionTestStatus::ModelUnavailable,
                    message: format!(
                        "Connected to Cerebras, but model '{chosen}' is not one Gofer holds capabilities for."
                    ),
                }
            },
        );
    }
    if models.data.iter().any(|model| model.id == chosen) {
        return Ok(ConnectionTestResult {
            status: ConnectionTestStatus::Connected,
            message: format!("Connected. Model '{chosen}' is available."),
        });
    }

    Ok(ConnectionTestResult {
        status: ConnectionTestStatus::ModelUnavailable,
        message: format!("Connected, but model '{chosen}' is not available on this server."),
    })
}

/// Whether OpenRouter still lists the chosen model, asked of the public catalogue.
///
/// A second request rather than a reuse of the first: `/key` answers about the credential and says
/// nothing about models. Anything that goes wrong here is reported as connected rather than as a
/// failure — the credential has already been proven, and a catalogue that could not be read is not
/// a reason to tell the user their key is bad.
async fn openrouter_model_available(model: &str, timeout: Duration) -> ConnectionTestResult {
    let connected = ConnectionTestResult {
        status: ConnectionTestStatus::Connected,
        message: format!("Connected to OpenRouter. Model '{model}' is available."),
    };
    let Ok(client) = reqwest::Client::builder().timeout(timeout).build() else {
        return connected;
    };
    let url = format!("{OPENROUTER_BASE_URL}/models");
    let Ok(response) = client.get(url).send().await else {
        return connected;
    };
    let Ok(catalog) = response.json::<OpenrouterModelsResponse>().await else {
        return connected;
    };
    let options = openrouter_model_options(catalog.data);
    if options.iter().any(|option| option.id == model) {
        return connected;
    }
    ConnectionTestResult {
        status: ConnectionTestStatus::ModelUnavailable,
        message: format!(
            "Connected to OpenRouter, but model '{model}' is not one it offers with tool support."
        ),
    }
}

pub(crate) async fn list_ai_models_with(
    request: SettingsRequest,
) -> Result<Vec<AiModelOption>, String> {
    if matches!(
        request.settings.ai.connection_type,
        AiConnectionType::OpenaiCodex
    ) {
        validate_settings(request.settings)?;
        return tauri::async_runtime::spawn_blocking(chatgpt_models)
            .await
            .map_err(|error| format!("ChatGPT model listing failed: {error}"))?;
    }
    let openrouter = matches!(
        request.settings.ai.connection_type,
        AiConnectionType::Openrouter
    );
    let cerebras = matches!(
        request.settings.ai.connection_type,
        AiConnectionType::Cerebras
    );
    let ModelsRequest { settings, builder } =
        prepare_models_request(request, AI_REQUEST_TIMEOUT, "models").await?;
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
    if openrouter {
        let catalog = response
            .json::<OpenrouterModelsResponse>()
            .await
            .map_err(|error| format!("OpenRouter returned an invalid models response: {error}"))?;
        return Ok(openrouter_model_options(catalog.data));
    }
    let models = response.json::<ModelsResponse>().await.map_err(|error| {
        format!("The server returned an invalid OpenAI models response: {error}")
    })?;
    // The plain OpenAI shape, which is all Cerebras answers — ids and nothing else. What those ids
    // can do is the shipped table's answer, so the live list is only ever used to narrow it.
    if cerebras {
        return Ok(cerebras_model_options(&models.data));
    }
    let connection = settings
        .ai
        .connection()
        .ok_or_else(|| "The chosen AI driver has no connection configured".to_owned())?;
    Ok(local_model_options(
        models.data,
        &pi_catalog().unwrap_or_default(),
        connection,
        crate::model_server::served_model(&connection.base_url).as_ref(),
    ))
}

/// What a local server's models endpoint means, read through Pi's catalogue.
///
/// A separate function because the catalogue it reads is a file in the user's home, and a test that
/// went through the network call would answer differently on every machine.
///
/// Two facts come from two places. What a *named* model can do is the catalogue's answer. What an
/// unnamed one can do is its *server's* answer — llama.cpp reports the file it was started with,
/// under that file's own path, which is almost never the id Pi names the same model by. Falling
/// back to `false` instead is what wrote `reasoning: false` into settings for a model that thinks,
/// and left its reasoning menu offering nothing but `off`.
pub(super) fn local_model_options(
    remote: Vec<Model>,
    catalog: &PiCatalog,
    connection: &AiConnectionProfile,
    served: Option<&ServedModel>,
) -> Vec<AiModelOption> {
    let server_reasoning = catalog
        .servers
        .get(&server_key(&connection.base_url))
        .copied()
        .unwrap_or(false);
    remote
        .into_iter()
        .map(|remote| {
            let known = catalog.models.iter().find(|model| model.id == remote.id);
            let context_window = remote
                .meta
                .and_then(|meta| meta.n_ctx)
                .or_else(|| known.map(|model| model.context_window))
                .unwrap_or(connection.model.context_window);
            // And the server outranks both, for the model it says it has loaded. It is the only
            // one of the three that changes when the user swaps the file it was started with.
            let loaded = served.filter(|model| model.id == remote.id);
            AiModelOption {
                id: remote.id.clone(),
                name: known
                    .map(|model| model.name.clone())
                    .unwrap_or_else(|| remote.id.clone()),
                context_window,
                // Through the same clamp OpenRouter's rows take. A model Pi's catalogue does
                // not know used to be given the whole window as its ceiling, which is the runaway
                // `default_max_tokens` was written for — and that runaway was measured *here*, on
                // the local Qwen3.6-27B, not on a billed endpoint.
                max_tokens: ceiling_within(context_window, known.map(|model| model.max_tokens)),
                reasoning: loaded.map_or_else(
                    || known.map_or(server_reasoning, |model| model.reasoning),
                    |model| model.reasoning,
                ),
                supports_reasoning_effort: loaded.map_or_else(
                    || known.map_or(server_reasoning, |model| model.supports_reasoning_effort),
                    |model| !model.efforts.is_empty(),
                ),
                // A local server is never one of these. `off` is how a chat template is told not
                // to think, and a template that has a switch has both of its positions.
                reasoning_mandatory: false,
                thinking_levels: loaded
                    .map(|model| model.efforts.clone())
                    .unwrap_or_default(),
                input: loaded
                    .and_then(|model| model.input.clone())
                    .or_else(|| known.map(|model| model.input.clone()))
                    .unwrap_or_else(|| connection.model.input.clone()),
                // A chat template is told not to think by leaving the effort out, never by being
                // handed a word for it. Only Cerebras' shipped table names one.
                off_effort: None,
            }
        })
        .collect()
}

/// What OpenRouter's catalogue means, model by model.
///
/// Every rule here was read off a live response rather than assumed, and each one has a reason it
/// cannot be simplified away:
///
/// * Models without `tools` are dropped. 70 of 422 have no tool support, and a model that cannot
///   call a tool cannot run Gofer at all — offering it is offering a broken choice.
/// * Every ceiling here goes through `ceiling_within`, declared or not — as `local_model_options`'
///   do, for the same reason. `max_completion_tokens` is null on 52 models, and larger than the
///   compaction reserve on 188 more; neither may become the window, and neither may become zero,
///   which fails validation.
/// * Efforts are kept only if `NAMED_EFFORTS` knows them, rather than dropping the one word that
///   is known not to be an effort. `supported_efforts` carries `none` today, which is OpenRouter's
///   word for "thinking can be switched off" — `thinking_levels_for` prepends `off` on its own, so
///   it is redundant as well as unknown. An allowlist also holds for whatever the catalogue names
///   next: an effort Gofer has no word for reaches the reasoning picker, and choosing it makes
///   `validate_settings` refuse the save with "Reasoning level is invalid" and no field named.
/// * Input modalities are narrowed to text and image. Pi types a model's input as exactly those
///   two, so `video`, `audio` and `file` have nowhere to go.
pub(super) fn openrouter_model_options(remote: Vec<OpenrouterModel>) -> Vec<AiModelOption> {
    remote
        .into_iter()
        .filter(|model| model.supported_parameters.iter().any(|p| p == "tools"))
        .map(|model| {
            let context_window = model.context_length.unwrap_or_else(default_context_window);
            let thinking_levels: Vec<String> = model
                .reasoning
                .as_ref()
                .map(|reasoning| {
                    reasoning
                        .supported_efforts
                        .iter()
                        .filter(|effort| NAMED_EFFORTS.contains(&effort.as_str()))
                        .cloned()
                        .collect()
                })
                .unwrap_or_default();
            let input: Vec<String> = model
                .architecture
                .as_ref()
                .map(|architecture| {
                    architecture
                        .input_modalities
                        .iter()
                        .filter(|modality| matches!(modality.as_str(), "text" | "image"))
                        .cloned()
                        .collect()
                })
                .unwrap_or_default();
            AiModelOption {
                name: model.name.unwrap_or_else(|| model.id.clone()),
                id: model.id,
                context_window,
                max_tokens: ceiling_within(
                    context_window,
                    model
                        .top_provider
                        .and_then(|provider| provider.max_completion_tokens),
                ),
                reasoning: model.reasoning.is_some(),
                // Named efforts are the only evidence that an effort field will be read. A model
                // that reasons without naming any takes no effort, which is the `on`/`off` case.
                supports_reasoning_effort: !thinking_levels.is_empty(),
                reasoning_mandatory: model
                    .reasoning
                    .as_ref()
                    .is_some_and(|reasoning| reasoning.mandatory),
                thinking_levels,
                // Never empty: `validate_settings` refuses an empty input list, and every model in
                // the catalogue takes text.
                input: if input.is_empty() {
                    vec!["text".to_owned()]
                } else {
                    input
                },
                // OpenRouter's catalogue names no such word, and `off` there is already a shape of
                // its own — `reasoning: {enabled: false}` — rather than an effort.
                off_effort: None,
            }
        })
        .collect()
}

pub(super) fn check_chatgpt_credential() -> Result<(), String> {
    let credential = stored_chatgpt_credential()?
        .ok_or_else(|| "Sign in with ChatGPT before testing this connection".to_owned())?;
    crate::chatgpt_auth::run_worker(
        &serde_json::json!({"operation": "check", "credential": credential}),
    )?;
    Ok(())
}

pub(super) fn chatgpt_models() -> Result<Vec<AiModelOption>, String> {
    let events = crate::chatgpt_auth::run_worker(&serde_json::json!({"operation": "models"}))?;
    let models = events
        .into_iter()
        .find(|event| event.get("type").and_then(serde_json::Value::as_str) == Some("models"))
        .and_then(|event| event.get("models").cloned())
        .ok_or_else(|| "Pi returned no ChatGPT model catalogue".to_owned())?;
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct CodexModel {
        id: String,
        name: String,
        context_window: u64,
        max_tokens: u64,
        reasoning: bool,
        input: Vec<String>,
        #[serde(default)]
        thinking_level_map: HashMap<String, String>,
    }
    serde_json::from_value::<Vec<CodexModel>>(models)
        .map_err(|error| format!("Pi returned an invalid ChatGPT model catalogue: {error}"))
        .map(|models| {
            models
                .into_iter()
                .map(|model| AiModelOption {
                    id: model.id,
                    name: model.name,
                    context_window: model.context_window,
                    max_tokens: model.max_tokens,
                    reasoning: model.reasoning,
                    supports_reasoning_effort: !model.thinking_level_map.is_empty(),
                    reasoning_mandatory: false,
                    // ChatGPT names no efforts of its own — the seven Gofer knows are what it
                    // takes, which is what an empty list here means.
                    thinking_levels: Vec::new(),
                    input: model.input,
                    // The Codex driver owns its own reasoning field; nothing here becomes an
                    // effort word on the wire.
                    off_effort: None,
                })
                .collect()
        })
}

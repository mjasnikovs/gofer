//! Gofer's own settings: the AI connection, the model catalogue, and the API key.
//!
//! Split out of `lib.rs`, where it sat beside the command surface it answers and the agent turn it
//! configures. It is one concern: what the user chose, what is legal to choose, where it is kept,
//! and — because a key belongs in the OS credential store rather than in a JSON file — how the
//! secret half of it is kept somewhere else.
//!
//! The seam is the file and the keyring. Everything with a path or a store in its signature has a
//! twin that takes it, so a test drives the real logic against a temporary file and a fake store.

use keyring::{Entry, Error as KeyringError};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager, Runtime};

const API_KEY_SERVICE: &str = "com.gofer.desktop";
const API_KEY_USERNAME: &str = "ai-default";
const CHATGPT_CREDENTIAL_USERNAME: &str = "ai-openai-codex";
/// A second username under the one service, which is how this keyring holds more than one secret.
const BRAVE_KEY_USERNAME: &str = "web-brave-search";

const SETTINGS_FILE_NAME: &str = "settings.json";

const SETTINGS_VERSION: u32 = 1;

const MAX_API_KEY_BYTES: usize = 16 * 1024;

static KEYRING_INITIALIZATION: Mutex<()> = Mutex::new(());

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GoferSettings {
    version: u32,
    pub(crate) ai: AiSettings,
    /// Absent from every settings file written before this field existed, which is why it defaults
    /// rather than being required: an older file must keep loading, and it must load with the rules
    /// on, because that is what a project opened for the first time gets.
    #[serde(default)]
    pub(crate) godot: GodotSettings,
}

/// The rules Gofer holds a Godot project to, re-applied every time an editor session goes ready.
///
/// Both are on by default and both are the user's to turn off. Neither is applied from here: this
/// is only what was chosen. `godot_policy` turns a choice into the settings the editor is told.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GodotSettings {
    /// Untyped and Variant-based GDScript is a parse error rather than a warning.
    #[serde(default = "rule_is_enforced")]
    pub(crate) strict_typing: bool,
    /// The running game is embedded in the editor rather than given a window of its own.
    #[serde(default = "rule_is_enforced")]
    pub(crate) embed_game_window: bool,
}

fn rule_is_enforced() -> bool {
    true
}

impl Default for GodotSettings {
    fn default() -> Self {
        Self {
            strict_typing: rule_is_enforced(),
            embed_game_window: rule_is_enforced(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiSettings {
    pub(crate) connection_type: AiConnectionType,
    pub(crate) name: String,
    pub(crate) base_url: String,
    pub(crate) model: String,
    pub(crate) api: ApiDialect,
    #[serde(default)]
    pub(crate) model_name: String,
    #[serde(default = "default_context_window")]
    pub(crate) context_window: u64,
    #[serde(default = "default_context_window")]
    pub(crate) max_tokens: u64,
    #[serde(default)]
    pub(crate) reasoning: bool,
    #[serde(default)]
    pub(crate) supports_reasoning_effort: bool,
    #[serde(default = "default_model_input")]
    pub(crate) input: Vec<String>,
    #[serde(default = "default_thinking_level")]
    pub(crate) thinking_level: String,
    #[serde(default = "default_max_retries")]
    pub(crate) max_retries: u32,
    #[serde(default = "default_timeout_ms")]
    pub(crate) timeout_ms: u64,
    #[serde(default = "default_compaction_percent")]
    pub(crate) compaction_percent: u32,
    #[serde(default)]
    pub(crate) subagent: SubagentSettings,
    #[serde(default)]
    pub(crate) web: WebSettings,
    /// Absent until the user has configured a local server, which a ChatGPT-only install never does.
    #[serde(default)]
    pub(crate) local: Option<AiConnectionProfile>,
    /// Always present, so the renderer never has to know what a ChatGPT connection looks like.
    #[serde(default = "default_chatgpt_profile")]
    pub(crate) chatgpt: AiConnectionProfile,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiConnectionProfile {
    name: String,
    base_url: String,
    model: String,
    api: ApiDialect,
    model_name: String,
    context_window: u64,
    max_tokens: u64,
    reasoning: bool,
    supports_reasoning_effort: bool,
    input: Vec<String>,
    thinking_level: String,
}

/// What the agent's two outward-facing tools are configured with.
///
/// Only the engine is stored here. The Brave key is not: it goes in the OS keyring beside the AI
/// key, because this file is plain text on disk and a search key is a credential like any other.
///
/// The engine is a choice rather than a fallback chain, and the search itself is strict about it.
/// An engine that fails is reported as having failed — never quietly answered by a different one —
/// because results sourced from somewhere other than the setting says are worse than no results:
/// nothing on screen would say the choice had been ignored.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WebSettings {
    /// `exa`, `ddg` or `brave`. The first two need no key; Brave does.
    #[serde(default = "default_search_provider")]
    pub(crate) search_provider: String,
}

impl Default for WebSettings {
    fn default() -> Self {
        Self {
            search_provider: default_search_provider(),
        }
    }
}

/// Exa, because it is keyless and a fresh install can search with it immediately. DuckDuckGo is the
/// other keyless engine and is one setting away; Brave is the one that holds up under load, and
/// needs a key to do it.
fn default_search_provider() -> String {
    "exa".to_owned()
}

/// The engines the settings file may name. A file naming anything else is corrected to the default
/// rather than refused: a typo in one field must not make the whole settings file unloadable.
pub(crate) const SEARCH_PROVIDERS: [&str; 3] = ["exa", "ddg", "brave"];

/// What bounds the sub-agent, the second agent the main one delegates reading to.
///
/// Every field is a ceiling that used to be a constant in `scripts/ai-subagent.mjs`. They are here
/// because none of them is a fact about Gofer: they are facts about the machine the model runs on.
/// A ceiling that suits a 27B model on a workstation starves the same model on a laptop, and the
/// only person who knows which is which is the one whose machine it is.
///
/// The two clocks are deliberately separate, because they catch failures that hide each other. A
/// command that never returns holds a perfectly healthy stream; a stream that goes silent holds a
/// perfectly healthy machine. So one clock bounds a single tool call, and the other bounds silence
/// from the model — and the second is paused while a tool runs, or every long command would read as
/// a hang. What neither can see is a sub-agent that is busy and getting nowhere, which is what the
/// step ceiling is for.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SubagentSettings {
    /// Ceiling on one tool call, in minutes. 0 turns the command watchdog off.
    #[serde(default = "default_subagent_command_timeout_minutes")]
    pub(crate) command_timeout_minutes: u32,
    /// Ceiling on silence from the model stream, in minutes, ignoring time spent inside tools.
    /// 0 turns it off.
    #[serde(default = "default_subagent_stream_inactivity_minutes")]
    pub(crate) stream_inactivity_minutes: u32,
    /// Ceiling on model requests one delegation may make. 0 turns it off.
    #[serde(default = "default_subagent_max_turns")]
    pub(crate) max_turns: u32,
    /// Ceiling on the answer handed back. 0 turns it off.
    #[serde(default = "default_subagent_max_answer_chars")]
    pub(crate) max_answer_chars: u32,
    /// How many times a delegation that failed transiently is asked again. 0 turns retry off.
    #[serde(default = "default_subagent_retry_attempts")]
    pub(crate) retry_attempts: u32,
    /// The first wait before asking again, in seconds. Each further attempt doubles it.
    #[serde(default = "default_subagent_retry_base_delay_seconds")]
    pub(crate) retry_base_delay_seconds: u32,
    /// Which model answers a delegation, when it is not the one the parent is using.
    ///
    /// Absent is the shipped answer and means the child borrows everything: the connection, the
    /// model and the reasoning level. Present means the child is given a model of its own — a small
    /// one for reading, while the parent keeps the large one for planning.
    #[serde(default)]
    pub(crate) connection: Option<SubagentConnection>,
}

/// The model a delegation is answered by, and which of the two configured connections serves it.
///
/// Deliberately not a second connection. It names one of the connections the settings file already
/// holds — `local` or `chatgpt` — and carries only what is the model's own: the id, its limits and
/// the reasoning level it is asked at. The address, the dialect and the credential belong to the
/// connection, are configured in one place, and are never copied here to drift out of step.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SubagentConnection {
    /// Which stored connection serves this model. Independent of the parent's choice.
    pub(crate) connection_type: AiConnectionType,
    pub(crate) model: String,
    #[serde(default)]
    pub(crate) model_name: String,
    #[serde(default = "default_context_window")]
    pub(crate) context_window: u64,
    #[serde(default = "default_context_window")]
    pub(crate) max_tokens: u64,
    #[serde(default)]
    pub(crate) reasoning: bool,
    #[serde(default)]
    pub(crate) supports_reasoning_effort: bool,
    #[serde(default = "default_model_input")]
    pub(crate) input: Vec<String>,
    #[serde(default = "default_thinking_level")]
    pub(crate) thinking_level: String,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum AiConnectionType {
    OpenaiCompatible,
    OpenaiCodex,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ApiDialect {
    OpenaiCompletions,
    OpenaiCodexResponses,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SettingsResponse {
    settings: GoferSettings,
    has_api_key: bool,
    has_chat_gpt_credential: bool,
    has_brave_api_key: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    credential_store_error: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SettingsRequest {
    pub(crate) settings: GoferSettings,
    pub(crate) api_key: ApiKeyUpdate,
    /// The Brave Search key, updated by the same three-way rule as the AI key: a page that never
    /// shows a stored secret cannot send one back, so "leave it alone" has to be sayable.
    #[serde(default)]
    pub(crate) brave_api_key: ApiKeyUpdate,
}

#[derive(Default, Deserialize)]
#[serde(tag = "action", rename_all = "camelCase")]
pub(crate) enum ApiKeyUpdate {
    /// The default, and the only safe one: a request that says nothing about a key must not clear
    /// it. Every field here is a secret the page cannot read back before it writes.
    #[default]
    Keep,
    Set {
        value: String,
    },
    Clear,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ConnectionTestStatus {
    Connected,
    ModelUnavailable,
    Unauthorized,
    ServerError,
    ServerUnreachable,
}

#[derive(Debug, PartialEq, Serialize)]
pub(crate) struct ConnectionTestResult {
    pub(crate) status: ConnectionTestStatus,
    pub(crate) message: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiModelOption {
    id: String,
    name: String,
    context_window: u64,
    max_tokens: u64,
    reasoning: bool,
    supports_reasoning_effort: bool,
    input: Vec<String>,
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
    /// Whether this model thinks. Absent means the provider answers for it.
    #[serde(default)]
    reasoning: Option<bool>,
}

/// What Pi's catalogue answers, as the two different questions Gofer asks of it.
///
/// A server names models Pi has never been told about — a llama.cpp host serves whatever file it
/// was started with, under whatever path that file is at. Asking only the first question is what
/// left such a model reported as unable to think, which took its reasoning menu down to `off` and
/// left it there.
#[derive(Debug, Default)]
struct PiCatalog {
    /// The models Pi names, with the facts it names them with.
    models: Vec<AiModelOption>,
    /// Whether a server takes a reasoning effort at all, by the base URL it is reached at.
    servers: HashMap<String, bool>,
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

/// How full the context may get before the worker summarises the old part of it away.
///
/// Pi draws the same line as a 16,384-token reserve on a 120,064-token window, which is 86.4% full.
/// 100 turns compaction off.
fn default_compaction_percent() -> u32 {
    86
}

/// Longest one of the sub-agent's tool calls may run, in minutes.
///
/// The bash tool takes an optional timeout and has no default, so a command the model did not bound
/// runs until the machine is rebooted. Five minutes is short because the sub-agent is a reader: it
/// greps, it reads, it summarises output someone else produced. Nothing it is meant to do takes
/// longer, and a command that does is a command it should have bounded itself.
fn default_subagent_command_timeout_minutes() -> u32 {
    5
}

/// Longest the model stream may say nothing while no tool is running, in minutes.
///
/// Generous on purpose. A local model processing a long prompt emits nothing for minutes, and that
/// is work, not a hang. This exists to turn hours of dead air into minutes, not to police slowness.
fn default_subagent_stream_inactivity_minutes() -> u32 {
    10
}

/// How many model requests one delegation may make.
///
/// The clocks bound a child that has stopped. This bounds one that has not: a child happily reading
/// its way through a repository is making progress by every other measure. Two to four requests is
/// what the work is for — read and answer, or grep, read the hits, answer — so twenty-four leaves
/// room to guess wrong several times and still land.
fn default_subagent_max_turns() -> u32 {
    24
}

/// Longest answer the sub-agent may hand back.
///
/// The whole point is that the raw material stays with the child. Other tool results are bounded at
/// 24,000 characters, so an answer needing more than half of that was never distilled.
fn default_subagent_max_answer_chars() -> u32 {
    12_000
}

/// How many times a delegation that failed transiently is asked again.
fn default_subagent_retry_attempts() -> u32 {
    2
}

/// The first wait before a delegation is asked again, in seconds, doubled per attempt.
///
/// Short, because the failure it absorbs is short: one local server with one slot, briefly
/// saturated by the parent and its own child, refusing a connection the next request will get.
fn default_subagent_retry_base_delay_seconds() -> u32 {
    1
}

impl Default for SubagentSettings {
    fn default() -> Self {
        Self {
            command_timeout_minutes: default_subagent_command_timeout_minutes(),
            stream_inactivity_minutes: default_subagent_stream_inactivity_minutes(),
            max_turns: default_subagent_max_turns(),
            max_answer_chars: default_subagent_max_answer_chars(),
            retry_attempts: default_subagent_retry_attempts(),
            retry_base_delay_seconds: default_subagent_retry_base_delay_seconds(),
            connection: None,
        }
    }
}

impl Default for GoferSettings {
    fn default() -> Self {
        Self {
            version: SETTINGS_VERSION,
            ai: AiSettings::default(),
            godot: GodotSettings::default(),
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
            compaction_percent: default_compaction_percent(),
            subagent: SubagentSettings::default(),
            web: WebSettings::default(),
            local: None,
            chatgpt: default_chatgpt_profile(),
        }
    }
}

/// What a ChatGPT connection is, before the user has picked anything.
///
/// The single home for these values: the renderer reads them off the settings it is sent rather
/// than keeping a second copy. The model and its limits are a seed — the first listing from Pi's
/// catalogue replaces them — but the driver, its dialect and its address are what make it ChatGPT.
fn default_chatgpt_profile() -> AiConnectionProfile {
    AiConnectionProfile {
        name: "ChatGPT subscription".to_owned(),
        base_url: "https://chatgpt.com/backend-api".to_owned(),
        model: "gpt-5.6-terra".to_owned(),
        api: ApiDialect::OpenaiCodexResponses,
        model_name: "GPT-5.6 Terra".to_owned(),
        context_window: 272_000,
        max_tokens: 128_000,
        reasoning: true,
        supports_reasoning_effort: true,
        input: vec!["text".to_owned(), "image".to_owned()],
        thinking_level: "high".to_owned(),
    }
}

/// The connection the documentation search's own model calls should go to.
///
/// It follows the sub-agent exactly — same connection, same model, same reasoning level — because
/// expanding a question into class names is the same size of job as reading a file, and a second
/// set of sliders for it would be a second thing to keep in step. A sub-agent on ChatGPT is
/// followed there too: the credential travels with the connection and the sidecar hands every
/// rotation of it back through `credential_answer`, so the keyring stays the one owner of the
/// token. Absent means the child borrows the parent's, which is what a settings file written
/// before the field says.
///
/// `None` is the one case nothing can be done about: a ChatGPT-only install with no local
/// connection and no stored credential has no model to reach. The search then runs unexpanded,
/// which is what gofer-rag does by itself when it can reach nothing.
pub(crate) fn docs_expansion_connection(
    settings: &AiSettings,
    api_key: Option<String>,
    oauth_credential: Option<serde_json::Value>,
) -> Option<crate::rag::RetrieveConnection> {
    let chosen = settings.subagent.connection.as_ref();
    let driver = chosen.map_or(settings.connection_type, |c| c.connection_type);
    // The address, the dialect and the credential are the connection's; the model and the level it
    // is asked at are the child's own. Exactly how `subagentModelFor` splits them in the worker.
    let profile = match driver {
        AiConnectionType::OpenaiCodex => settings.chatgpt.clone(),
        AiConnectionType::OpenaiCompatible => match settings.connection_type {
            AiConnectionType::OpenaiCompatible => profile_of(settings),
            AiConnectionType::OpenaiCodex => settings.local.clone()?,
        },
    };
    let codex = driver == AiConnectionType::OpenaiCodex;
    if codex && oauth_credential.is_none() {
        return None;
    }
    Some(crate::rag::RetrieveConnection {
        connection_type: if codex {
            "openai-codex".to_owned()
        } else {
            "openai-compatible".to_owned()
        },
        oauth_credential: if codex { oauth_credential } else { None },
        base_url: profile.base_url.clone(),
        model: chosen.map_or_else(|| profile.model.clone(), |c| c.model.clone()),
        model_name: chosen.map_or_else(|| profile.model_name.clone(), |c| c.model_name.clone()),
        // Only a local server takes one. ChatGPT authenticates with the credential above.
        api_key: if codex { None } else { api_key },
        thinking_level: chosen.map_or_else(
            || settings.thinking_level.clone(),
            |c| c.thinking_level.clone(),
        ),
        context_window: chosen.map_or(profile.context_window, |c| c.context_window),
        max_tokens: chosen.map_or(profile.max_tokens, |c| c.max_tokens),
        reasoning: chosen.map_or(profile.reasoning, |c| c.reasoning),
        supports_reasoning_effort: chosen.map_or(profile.supports_reasoning_effort, |c| {
            c.supports_reasoning_effort
        }),
        timeout_ms: settings.timeout_ms,
        max_retries: settings.max_retries,
    })
}

/// What a model can do, as the catalogue answers it. Never a stored fact — always a derived one.
///
/// The line this draws is the whole point of the type. A model *owns* whether it reasons, whether
/// it can be told how hard, what it accepts and what it is called. The user owns which model, at
/// which level, in how big a window. Storing the first four is what let three separate copies of
/// them drift, each written once at pick-time and never corrected: a settings file written before
/// the catalogue could be read said `reasoning: false` about a model that thinks, and went on
/// saying it forever, because nothing ever asked again.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ModelFacts {
    /// Absent for a model the catalogue does not name: its name is then whatever it was called.
    model_name: Option<String>,
    reasoning: bool,
    supports_reasoning_effort: bool,
    /// Absent for the same reason. A server's declared reasoning says nothing about what a model
    /// it has never described accepts, and answering `["text", "image"]` anyway would turn the
    /// composer's image control on and ship pictures to a server that refuses them.
    input: Option<Vec<String>>,
}

/// What the catalogue says about one model on one server, or nothing when it has no answer.
///
/// Nothing is not `false`. A server the catalogue has never heard of is a question it cannot
/// answer, and answering it `false` anyway is exactly the mistake this replaces — so the caller
/// keeps what it had rather than being told the model cannot think.
fn model_facts(catalog: &PiCatalog, base_url: &str, model_id: &str) -> Option<ModelFacts> {
    let server = catalog.servers.get(&server_key(base_url))?;
    // A named model answers for itself. One the catalogue does not name — the file a llama.cpp host
    // was started with, under that file's own path — gets its server's answer, which is the most
    // that can honestly be said about it.
    let known = catalog.models.iter().find(|model| model.id == model_id);
    Some(ModelFacts {
        model_name: known.map(|model| model.name.clone()),
        reasoning: known.map_or(*server, |model| model.reasoning),
        supports_reasoning_effort: known.map_or(*server, |model| model.supports_reasoning_effort),
        input: known.map(|model| model.input.clone()),
    })
}

/// Re-derives every model-owned fact in a settings file from the catalogue.
///
/// Called on every read and every save, so what is on disk is never the authority — it is a copy
/// the next load overwrites. Only the local driver is resolvable here: Pi's `models.json` is a file
/// on this machine, while ChatGPT's catalogue lives behind a sidecar process that a settings read
/// cannot afford to start. The ChatGPT half keeps what it has and is refreshed by the model lister
/// instead, which is the only other writer of these fields.
fn resolve_model_facts(settings: &mut AiSettings, catalog: &PiCatalog) {
    if matches!(settings.connection_type, AiConnectionType::OpenaiCompatible)
        && let Some(facts) = model_facts(catalog, &settings.base_url, &settings.model)
    {
        if let Some(model_name) = facts.model_name {
            settings.model_name = model_name;
        }
        settings.reasoning = facts.reasoning;
        settings.supports_reasoning_effort = facts.supports_reasoning_effort;
        if let Some(input) = facts.input {
            settings.input = input;
        }
    }
    if let Some(local) = settings.local.as_mut()
        && let Some(facts) = model_facts(catalog, &local.base_url, &local.model)
    {
        if let Some(model_name) = facts.model_name {
            local.model_name = model_name;
        }
        local.reasoning = facts.reasoning;
        local.supports_reasoning_effort = facts.supports_reasoning_effort;
        if let Some(input) = facts.input {
            local.input = input;
        }
    }
    // The sub-agent has no address of its own — it borrows the connection it names. So the server
    // its model is resolved against is that connection's, not the parent's.
    let local_base_url = settings
        .local
        .as_ref()
        .map(|local| local.base_url.clone())
        .or_else(|| {
            matches!(settings.connection_type, AiConnectionType::OpenaiCompatible)
                .then(|| settings.base_url.clone())
        });
    if let Some(child) = settings.subagent.connection.as_mut()
        && matches!(child.connection_type, AiConnectionType::OpenaiCompatible)
        && let Some(base_url) = local_base_url
        && let Some(facts) = model_facts(catalog, &base_url, &child.model)
    {
        if let Some(model_name) = facts.model_name {
            child.model_name = model_name;
        }
        child.reasoning = facts.reasoning;
        child.supports_reasoning_effort = facts.supports_reasoning_effort;
        if let Some(input) = facts.input {
            child.input = input;
        }
    }
    // The level a model that cannot think is asked at, re-applied: resolution can take reasoning
    // away, and a level left pointing at nothing is what `validate_settings` already refuses.
    if !settings.reasoning {
        settings.thinking_level = "off".to_owned();
    }
    if let Some(local) = settings.local.as_mut()
        && !local.reasoning
    {
        local.thinking_level = "off".to_owned();
    }
    if let Some(child) = settings.subagent.connection.as_mut()
        && !child.reasoning
    {
        child.thinking_level = "off".to_owned();
    }
}

fn profile_of(settings: &AiSettings) -> AiConnectionProfile {
    AiConnectionProfile {
        name: settings.name.clone(),
        base_url: settings.base_url.clone(),
        model: settings.model.clone(),
        api: settings.api,
        model_name: settings.model_name.clone(),
        context_window: settings.context_window,
        max_tokens: settings.max_tokens,
        reasoning: settings.reasoning,
        supports_reasoning_effort: settings.supports_reasoning_effort,
        input: settings.input.clone(),
        thinking_level: settings.thinking_level.clone(),
    }
}

/// A validated settings payload paired with a ready-to-send request to its models endpoint.
struct ModelsRequest {
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

pub(crate) async fn run_connection_test(
    request: SettingsRequest,
    timeout: Duration,
) -> Result<ConnectionTestResult, String> {
    if matches!(
        request.settings.ai.connection_type,
        AiConnectionType::OpenaiCodex
    ) {
        let settings = validate_settings(request.settings)?;
        return tauri::async_runtime::spawn_blocking(move || {
            check_chatgpt_credential()?;
            let models = chatgpt_models()?;
            let available = models.iter().any(|model| model.id == settings.ai.model);
            Ok(if available {
                ConnectionTestResult {
                    status: ConnectionTestStatus::Connected,
                    message: format!(
                        "Signed in with ChatGPT. Model '{}' is available.",
                        settings.ai.model
                    ),
                }
            } else {
                ConnectionTestResult {
                    status: ConnectionTestStatus::ModelUnavailable,
                    message: format!(
                        "Signed in with ChatGPT, but model '{}' is not in this Pi release.",
                        settings.ai.model
                    ),
                }
            })
        })
        .await
        .map_err(|error| format!("ChatGPT connection test failed: {error}"))?;
    }
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
    Ok(local_model_options(
        models.data,
        &pi_catalog().unwrap_or_default(),
        &settings.ai,
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
fn local_model_options(
    remote: Vec<Model>,
    catalog: &PiCatalog,
    ai: &AiSettings,
) -> Vec<AiModelOption> {
    let server_reasoning = catalog
        .servers
        .get(&server_key(&ai.base_url))
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
                .unwrap_or(ai.context_window);
            AiModelOption {
                id: remote.id.clone(),
                name: known
                    .map(|model| model.name.clone())
                    .unwrap_or_else(|| remote.id.clone()),
                context_window,
                max_tokens: known
                    .map(|model| model.max_tokens)
                    .unwrap_or(context_window),
                reasoning: known
                    .map(|model| model.reasoning)
                    .unwrap_or(server_reasoning),
                supports_reasoning_effort: known
                    .map(|model| model.supports_reasoning_effort)
                    .unwrap_or(server_reasoning),
                input: known
                    .map(|model| model.input.clone())
                    .unwrap_or_else(|| ai.input.clone()),
            }
        })
        .collect()
}

fn check_chatgpt_credential() -> Result<(), String> {
    let credential = stored_chatgpt_credential()?
        .ok_or_else(|| "Sign in with ChatGPT before testing this connection".to_owned())?;
    crate::chatgpt_auth::run_worker(
        &serde_json::json!({"operation": "check", "credential": credential}),
    )?;
    Ok(())
}

fn chatgpt_models() -> Result<Vec<AiModelOption>, String> {
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
                    input: model.input,
                })
                .collect()
        })
}

fn settings_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    if let Some(path) = crate::workspace::configured_app_data_path()? {
        return Ok(path.join(SETTINGS_FILE_NAME));
    }
    app.path()
        .app_config_dir()
        .map(|path| path.join(SETTINGS_FILE_NAME))
        .map_err(|error| format!("Could not resolve Gofer's configuration directory: {error}"))
}

/// Generic over the runtime because the settings are read from two very different places: a Tauri
/// command, which always has the real handle, and the session event loop, which is generic so a
/// test can drive it on a mock one.
pub(crate) fn read_settings<R: Runtime>(app: &AppHandle<R>) -> Result<GoferSettings, String> {
    let path = settings_path(app)?;
    read_settings_from_path(&path)
}

fn read_settings_from_path(path: &Path) -> Result<GoferSettings, String> {
    read_settings_from_paths(path, pi_models_path().ok().as_deref())
}

/// The same read with the Pi catalogue named rather than found.
///
/// A first run has no settings file and falls back to whatever `pi` is already configured with, so
/// what this returns depends on a file in the user's home. That made the missing-file test pass or
/// fail by machine: it asserted the shipped defaults, and any developer with `~/.pi/agent/
/// models.json` got the Pi-derived ones instead. Both are correct answers to different questions,
/// so the question is the parameter.
fn read_settings_from_paths(path: &Path, pi: Option<&Path>) -> Result<GoferSettings, String> {
    if !path.exists() {
        return Ok(pi
            .and_then(default_settings_from_pi_path)
            .unwrap_or_default());
    }
    let contents = fs::read_to_string(path)
        .map_err(|error| format!("Could not read {}: {error}", path.display()))?;
    let settings = serde_json::from_str(&contents)
        .map_err(|error| format!("Gofer settings in {} are invalid: {error}", path.display()))?;
    let mut settings = validate_settings(settings)?;
    // After validation rather than inside it, because the catalogue is a file on this machine and
    // `validate_settings` is the pure half — the half a test can drive without one. This is the
    // funnel every read passes through, so what is on disk is never the authority on what a model
    // can do. It is a copy, and this is where the copy is replaced.
    resolve_model_facts(
        &mut settings.ai,
        &pi.and_then(|path| pi_catalog_from_path(path).ok())
            .unwrap_or_default(),
    );
    Ok(settings)
}

fn pi_models_path() -> Result<PathBuf, String> {
    dirs::home_dir()
        .map(|path| path.join(".pi").join("agent").join("models.json"))
        .ok_or_else(|| "The home directory could not be resolved".to_owned())
}

fn pi_catalog() -> Result<PiCatalog, String> {
    let path = pi_models_path()?;
    pi_catalog_from_path(&path)
}

fn pi_catalog_from_path(path: &Path) -> Result<PiCatalog, String> {
    let contents = fs::read_to_string(path)
        .map_err(|error| format!("Could not read {}: {error}", path.display()))?;
    let configured: PiModelsFile = serde_json::from_str(&contents)
        .map_err(|error| format!("Pi models in {} are invalid: {error}", path.display()))?;
    Ok(PiCatalog {
        models: configured
            .providers
            .values()
            .flat_map(|provider| {
                provider
                    .models
                    .iter()
                    .map(|model| pi_model_option(provider, model))
            })
            .collect(),
        servers: configured
            .providers
            .values()
            .map(|provider| {
                (
                    server_key(&provider.base_url),
                    provider.compat.supports_reasoning_effort,
                )
            })
            .collect(),
    })
}

/// One Pi model as Gofer describes a model.
///
/// Reasoning is the model's own answer, not the provider's. The provider only says whether the
/// server accepts an effort to be named — a model that does not think has no effort to name, so the
/// two are combined rather than copied.
fn pi_model_option(provider: &PiProvider, model: &PiModel) -> AiModelOption {
    let reasoning = model
        .reasoning
        .unwrap_or(provider.compat.supports_reasoning_effort);
    AiModelOption {
        id: model.id.clone(),
        name: model.name.clone(),
        context_window: model.context_window,
        max_tokens: model.max_tokens,
        reasoning,
        supports_reasoning_effort: reasoning && provider.compat.supports_reasoning_effort,
        input: model.input.clone(),
    }
}

/// How two base URLs are compared: the same way the settings are stored, minus the trailing slash.
fn server_key(base_url: &str) -> String {
    base_url.trim().trim_end_matches('/').to_owned()
}

fn default_settings_from_pi_path(path: &Path) -> Option<GoferSettings> {
    let contents = fs::read_to_string(path).ok()?;
    let configured: PiModelsFile = serde_json::from_str(&contents).ok()?;
    let provider = configured.providers.values().next()?;
    let model = provider.models.first()?;
    let known = pi_model_option(provider, model);
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
            reasoning: known.reasoning,
            supports_reasoning_effort: known.supports_reasoning_effort,
            input: model.input.clone(),
            thinking_level: default_thinking_level(),
            max_retries: default_max_retries(),
            timeout_ms: default_timeout_ms(),
            compaction_percent: default_compaction_percent(),
            subagent: SubagentSettings::default(),
            web: WebSettings::default(),
            local: None,
            chatgpt: default_chatgpt_profile(),
        },
        godot: GodotSettings::default(),
    })
}

pub(crate) fn write_settings(app: &AppHandle, settings: &GoferSettings) -> Result<(), String> {
    let path = settings_path(app)?;
    write_settings_to_path(&path, settings)
}

/// Stores the Godot rules alone, leaving everything else in the file as it was.
///
/// It re-reads before it writes rather than taking a whole settings object from the renderer, which
/// is the difference between this and `write_settings`. The Godot tab has no Save button — a
/// checkbox writes the moment it is ticked — so sending the page's whole draft would have written
/// half-typed connection edits from another tab as a side effect of ticking a box.
pub(crate) fn save_godot_settings(
    app: &AppHandle,
    godot: GodotSettings,
) -> Result<GoferSettings, String> {
    let path = settings_path(app)?;
    save_godot_settings_at(&path, godot)
}

fn save_godot_settings_at(path: &Path, godot: GodotSettings) -> Result<GoferSettings, String> {
    let mut settings = read_settings_from_path(path)?;
    settings.godot = godot;
    write_settings_to_path(path, &settings)?;
    Ok(settings)
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

pub(crate) fn validate_settings(mut settings: GoferSettings) -> Result<GoferSettings, String> {
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
    // The floor is not taste: what is left above the line is the room the summary request and the
    // answer after it both have to fit in, and a line drawn too high leaves neither enough to work.
    if !(50..=100).contains(&settings.ai.compaction_percent) {
        return Err("Compaction threshold must be between 50 and 100 percent".to_owned());
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
    // After the parent's rules, because whether a local connection exists depends on the parent: a
    // file whose driver is local carries it in the flat fields and has no `local` profile until the
    // mirror below writes one.
    let has_local = matches!(
        settings.ai.connection_type,
        AiConnectionType::OpenaiCompatible
    ) || settings.ai.local.is_some();
    if let Some(connection) = settings.ai.subagent.connection.take() {
        settings.ai.subagent.connection =
            Some(validate_subagent_connection(connection, has_local)?);
    }
    // Corrected rather than refused. An engine name nobody recognises is one field of one tool, and
    // failing the whole load over it would take the user's model, worktree and prompt down with it.
    if !SEARCH_PROVIDERS.contains(&settings.ai.web.search_provider.as_str()) {
        settings.ai.web.search_provider = default_search_provider();
    }
    let active_profile = profile_of(&settings.ai);
    match settings.ai.connection_type {
        AiConnectionType::OpenaiCompatible => settings.ai.local = Some(active_profile),
        AiConnectionType::OpenaiCodex => settings.ai.chatgpt = active_profile,
    }
    Ok(settings)
}

/// The same rules the parent's model is held to, applied to the sub-agent's.
///
/// Everything the child could get wrong is a model, not a server, because it has no server of its
/// own. The one extra rule is the driver: a child pointed at a local connection nobody has
/// configured has nowhere to run, and saying so here is the difference between a settings screen
/// that refuses and a turn that dies on its first delegation.
fn validate_subagent_connection(
    mut connection: SubagentConnection,
    has_local: bool,
) -> Result<SubagentConnection, String> {
    if matches!(
        connection.connection_type,
        AiConnectionType::OpenaiCompatible
    ) && !has_local
    {
        return Err(
            "The sub-agent cannot use the local connection until one is configured".to_owned(),
        );
    }
    connection.model = required_value("Sub-agent model ID", connection.model)?;
    if connection.model.len() > 512 {
        return Err("Model IDs cannot exceed 512 bytes".to_owned());
    }
    if connection.model_name.trim().is_empty() {
        connection.model_name = connection.model.clone();
    } else {
        connection.model_name = connection.model_name.trim().to_owned();
    }
    if connection.model_name.len() > 512 {
        return Err("Model names cannot exceed 512 bytes".to_owned());
    }
    if connection.input.is_empty()
        || connection.input.len() > 16
        || connection
            .input
            .iter()
            .any(|input| input.is_empty() || input.len() > 64)
    {
        return Err("Model input types are invalid".to_owned());
    }
    if connection.context_window == 0 || connection.max_tokens == 0 {
        return Err(
            "Context window and maximum output tokens must be greater than zero".to_owned(),
        );
    }
    if !["off", "minimal", "low", "medium", "high", "xhigh", "max"]
        .contains(&connection.thinking_level.as_str())
    {
        return Err("Reasoning level is invalid".to_owned());
    }
    if !connection.reasoning {
        connection.thinking_level = "off".to_owned();
    }
    Ok(connection)
}

fn required_value(name: &str, value: String) -> Result<String, String> {
    let value = value.trim().to_owned();
    if value.is_empty() {
        return Err(format!("{name} is required"));
    }
    Ok(value)
}

fn credential_entry(username: &str) -> Result<Entry, String> {
    let _initialization = KEYRING_INITIALIZATION
        .lock()
        .map_err(|_| "The credential-store initialization lock is poisoned".to_owned())?;
    Entry::new(API_KEY_SERVICE, username)
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
        match credential_entry(API_KEY_USERNAME)?.delete_credential() {
            Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
            Err(error) => Err(format!("Could not remove the AI API key: {error}")),
        }
    }

    fn load(&self) -> Result<Option<String>, String> {
        match credential_entry(API_KEY_USERNAME)?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(KeyringError::NoEntry) => Ok(None),
            Err(error) => Err(format!(
                "Could not read the AI API key from the credential store: {error}"
            )),
        }
    }

    fn store(&self, value: &str) -> Result<(), String> {
        credential_entry(API_KEY_USERNAME)?
            .set_password(value)
            .map_err(|error| format!("Could not store the AI API key: {error}"))
    }
}

pub(crate) fn stored_api_key() -> Result<Option<String>, String> {
    SystemCredentialStore.load()
}

pub(crate) fn ai_worker_api_key() -> Result<Option<String>, String> {
    #[cfg(feature = "webdriver")]
    if std::env::var_os("GOFER_WEBDRIVER_SKIP_CREDENTIAL_STORE").is_some() {
        return Ok(None);
    }
    stored_api_key()
}

/// The Brave Search key, or nothing when the user has not set one.
///
/// In the keyring rather than in `settings.json`, on the same reasoning as the AI key: the settings
/// file is plain text a person may copy, diff or paste into a bug report, and a search key is a
/// credential. Nothing is an ordinary state, not a fault — the two other engines need no key, and
/// `web_search` says so itself when Brave is chosen without one.
pub(crate) fn stored_brave_api_key() -> Result<Option<String>, String> {
    match credential_entry(BRAVE_KEY_USERNAME)?.get_password() {
        Ok(value) if value.trim().is_empty() => Ok(None),
        Ok(value) => Ok(Some(value)),
        Err(KeyringError::NoEntry) => Ok(None),
        Err(error) => Err(format!("Could not read the Brave Search key: {error}")),
    }
}

/// Stores the Brave key, or removes it when the text is blank.
///
/// Blank means remove rather than store-an-empty-string, so that clearing the field in the settings
/// page and saving actually takes the key off the machine. An empty entry left behind would read as
/// a configured key that every request is then rejected for.
pub(crate) fn store_brave_api_key(key: &str) -> Result<(), String> {
    let entry = credential_entry(BRAVE_KEY_USERNAME)?;
    if key.trim().is_empty() {
        return match entry.delete_credential() {
            Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
            Err(error) => Err(format!("Could not remove the Brave Search key: {error}")),
        };
    }
    entry
        .set_password(key)
        .map_err(|error| format!("Could not save the Brave Search key: {error}"))
}

pub(crate) fn stored_chatgpt_credential() -> Result<Option<serde_json::Value>, String> {
    let value = match credential_entry(CHATGPT_CREDENTIAL_USERNAME)?.get_password() {
        Ok(value) => value,
        Err(KeyringError::NoEntry) => return Ok(None),
        Err(error) => return Err(format!("Could not read the ChatGPT credential: {error}")),
    };
    serde_json::from_str(&value).map(Some).map_err(|error| {
        format!("The stored ChatGPT credential is invalid and must be replaced: {error}")
    })
}

pub(crate) fn store_chatgpt_credential(credential: &serde_json::Value) -> Result<(), String> {
    let object = credential
        .as_object()
        .ok_or_else(|| "The ChatGPT credential is invalid".to_owned())?;
    if object.get("type").and_then(serde_json::Value::as_str) != Some("oauth")
        || object
            .get("access")
            .and_then(serde_json::Value::as_str)
            .is_none()
        || object
            .get("refresh")
            .and_then(serde_json::Value::as_str)
            .is_none()
        || object
            .get("expires")
            .and_then(serde_json::Value::as_f64)
            .is_none()
    {
        return Err("The ChatGPT credential is missing OAuth fields".to_owned());
    }
    let serialized = serde_json::to_string(credential)
        .map_err(|error| format!("Could not serialize the ChatGPT credential: {error}"))?;
    if serialized.len() > MAX_API_KEY_BYTES {
        return Err("The ChatGPT credential cannot exceed 16 KiB".to_owned());
    }
    credential_entry(CHATGPT_CREDENTIAL_USERNAME)?
        .set_password(&serialized)
        .map_err(|error| format!("Could not store the ChatGPT credential: {error}"))
}

pub(crate) fn clear_chatgpt_credential() -> Result<(), String> {
    match credential_entry(CHATGPT_CREDENTIAL_USERNAME)?.delete_credential() {
        Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
        Err(error) => Err(format!("Could not remove the ChatGPT credential: {error}")),
    }
}

pub(crate) fn settings_response(settings: GoferSettings) -> SettingsResponse {
    #[cfg(feature = "webdriver")]
    if std::env::var_os("GOFER_WEBDRIVER_RAG_READY").is_some() {
        return SettingsResponse {
            settings,
            has_api_key: false,
            has_chat_gpt_credential: false,
            has_brave_api_key: false,
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
            has_chat_gpt_credential: stored_chatgpt_credential().ok().flatten().is_some(),
            has_brave_api_key: stored_brave_api_key().ok().flatten().is_some(),
            credential_store_error: None,
        },
        Err(error) => SettingsResponse {
            settings,
            has_api_key: false,
            has_chat_gpt_credential: false,
            has_brave_api_key: false,
            credential_store_error: Some(error),
        },
    }
}

pub(crate) fn apply_api_key_update(update: &ApiKeyUpdate) -> Result<(), String> {
    apply_api_key_update_with(&SystemCredentialStore, update)
}

/// The same three-way rule as the AI key, against the Brave entry.
///
/// `Set` with blank text is a clear rather than an error, unlike the AI key: emptying the field and
/// saving is how a person takes a key off the machine, and refusing it would leave the old key in
/// the keyring while the page showed an empty box.
pub(crate) fn apply_brave_key_update(update: &ApiKeyUpdate) -> Result<(), String> {
    match update {
        ApiKeyUpdate::Keep => Ok(()),
        ApiKeyUpdate::Set { value } => {
            if value.len() > MAX_API_KEY_BYTES {
                return Err("API keys cannot exceed 16 KiB".to_owned());
            }
            store_brave_api_key(value)
        }
        ApiKeyUpdate::Clear => store_brave_api_key(""),
    }
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

pub(crate) fn restore_api_key(value: Option<&str>) -> Result<(), String> {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{list_ai_models, test_ai_connection};
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;
    use tempfile::TempDir;

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
            godot: GodotSettings::default(),
        }
    }

    fn request(base_url: impl Into<String>, model: impl Into<String>) -> SettingsRequest {
        SettingsRequest {
            settings: settings(base_url, model),
            api_key: ApiKeyUpdate::Set {
                value: " secret-token ".to_owned(),
            },
            brave_api_key: ApiKeyUpdate::Keep,
        }
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
        let missing = directory.path().join("settings.json");

        // No settings and no Pi catalogue: the shipped defaults, and nothing read off this machine.
        let shipped = read_settings_from_paths(&missing, None).expect("default settings");
        assert_eq!(shipped, GoferSettings::default());

        // A Pi catalogue is what a first run is supposed to inherit from, so it wins over the
        // shipped model. This is the branch that used to make the assertion above machine-dependent.
        let pi = directory.path().join("models.json");
        fs::write(
            &pi,
            serde_json::json!({
                "providers": {
                    "local": {
                        "baseUrl": "http://127.0.0.1:9099/v1",
                        "compat": {"supportsReasoningEffort": true},
                        "models": [{
                            "id": "inherited.gguf",
                            "name": "Inherited",
                            "contextWindow": 4096,
                            "maxTokens": 2048,
                            "input": ["text"]
                        }]
                    }
                }
            })
            .to_string(),
        )
        .expect("write pi catalogue");

        let inherited = read_settings_from_paths(&missing, Some(&pi)).expect("pi settings");
        assert_eq!(inherited.ai.model, "inherited.gguf");
        assert_eq!(inherited.ai.base_url, "http://127.0.0.1:9099/v1");

        // An unreadable or unparseable catalogue is not a failure, it is simply no inheritance.
        let broken = directory.path().join("broken.json");
        fs::write(&broken, "{not json").expect("write broken catalogue");
        assert_eq!(
            read_settings_from_paths(&missing, Some(&broken)).expect("broken falls back"),
            GoferSettings::default()
        );
    }

    /// A settings file written before the sub-agent section existed must still open, with every
    /// bound at its shipped value. The section is all ceilings, and a ceiling read back as zero is
    /// not a conservative default — it is no ceiling at all.
    #[test]
    fn a_settings_file_that_predates_the_web_tools_gets_the_keyless_engine() {
        let directory = TempDir::new().expect("temporary directory");
        let path = directory.path().join("settings.json");
        let mut older = serde_json::to_value(GoferSettings::default()).expect("settings as json");
        older["ai"]
            .as_object_mut()
            .expect("ai settings")
            .remove("web");
        fs::write(&path, older.to_string()).expect("write older settings");

        let loaded = read_settings_from_path(&path).expect("read settings");

        // Exa, because a fresh install has no key and must still be able to search.
        assert_eq!(loaded.ai.web, WebSettings::default());
        assert_eq!(loaded.ai.web.search_provider, "exa");
    }

    #[test]
    fn an_engine_nobody_recognises_is_corrected_rather_than_refused() {
        // One field of one tool must not take the user's model, worktree and prompt down with it.
        let mut settings = GoferSettings::default();
        settings.ai.web.search_provider = "askjeeves".to_owned();

        let validated = validate_settings(settings).expect("settings validate");

        assert_eq!(validated.ai.web.search_provider, "exa");

        // Every engine this build knows survives validation unchanged.
        for provider in SEARCH_PROVIDERS {
            let mut settings = GoferSettings::default();
            settings.ai.web.search_provider = provider.to_owned();
            let validated = validate_settings(settings).expect("settings validate");
            assert_eq!(validated.ai.web.search_provider, provider);
        }
    }

    #[test]
    fn a_request_that_says_nothing_about_a_key_leaves_it_alone() {
        // The default matters more than it looks: the settings page never reads a stored secret
        // back, so it cannot send one. A request with no `braveApiKey` field at all must mean
        // "leave it", never "clear it".
        let request: SettingsRequest = serde_json::from_value(serde_json::json!({
            "settings": serde_json::to_value(GoferSettings::default()).expect("settings as json"),
            "apiKey": {"action": "keep"}
        }))
        .expect("a request with no brave key parses");

        assert!(matches!(request.brave_api_key, ApiKeyUpdate::Keep));
    }

    /// The documentation search's model calls follow the sub-agent wherever it is pointed,
    /// including at ChatGPT, and say nothing only when there is no model to reach at all.
    #[test]
    fn the_docs_expansion_connection_follows_the_subagent() {
        let borrowed =
            docs_expansion_connection(&AiSettings::default(), Some("k".to_owned()), None)
                .expect("a local parent with no sub-agent connection lends its own");
        assert_eq!(borrowed.connection_type, "openai-compatible");
        assert_eq!(borrowed.base_url, AiSettings::default().base_url);
        assert_eq!(borrowed.model, AiSettings::default().model);
        assert_eq!(borrowed.api_key.as_deref(), Some("k"));
        assert_eq!(borrowed.oauth_credential, None);

        let local_child = SubagentConnection {
            connection_type: AiConnectionType::OpenaiCompatible,
            model: "small.gguf".to_owned(),
            model_name: "Small".to_owned(),
            context_window: 8_192,
            max_tokens: 4_096,
            reasoning: true,
            supports_reasoning_effort: true,
            input: default_model_input(),
            thinking_level: "low".to_owned(),
        };
        let mut own = AiSettings::default();
        own.subagent.connection = Some(local_child.clone());
        let child =
            docs_expansion_connection(&own, None, None).expect("a local sub-agent is reachable");
        // The address stays the connection's; the model and its level are the child's own.
        assert_eq!(child.base_url, AiSettings::default().base_url);
        assert_eq!(child.model, "small.gguf");
        assert_eq!(child.thinking_level, "low");
        assert_eq!(child.max_tokens, 4_096);

        let mut chatgpt = AiSettings::default();
        chatgpt.subagent.connection = Some(SubagentConnection {
            connection_type: AiConnectionType::OpenaiCodex,
            model: "gpt-5.6-luna".to_owned(),
            ..local_child
        });
        let credential = serde_json::json!({"type": "oauth", "refresh": "r"});
        let followed =
            docs_expansion_connection(&chatgpt, Some("k".to_owned()), Some(credential.clone()))
                .expect("a ChatGPT sub-agent is followed to ChatGPT");
        assert_eq!(followed.connection_type, "openai-codex");
        assert_eq!(followed.model, "gpt-5.6-luna");
        assert_eq!(followed.base_url, default_chatgpt_profile().base_url);
        assert_eq!(followed.oauth_credential, Some(credential));
        // The local server's key is not ChatGPT's, and must not travel with a ChatGPT connection.
        assert_eq!(followed.api_key, None);

        assert_eq!(
            docs_expansion_connection(&chatgpt, None, None),
            None,
            "a ChatGPT sub-agent with no stored credential has nothing to authenticate with"
        );

        let codex_only = AiSettings {
            connection_type: AiConnectionType::OpenaiCodex,
            local: None,
            ..AiSettings::default()
        };
        assert_eq!(
            docs_expansion_connection(&codex_only, None, None),
            None,
            "a ChatGPT-only install with no credential has no model to reach"
        );
    }

    #[test]
    fn subagent_bounds_fill_in_for_a_settings_file_that_predates_them() {
        let directory = TempDir::new().expect("temporary directory");
        let path = directory.path().join("settings.json");
        let mut older = serde_json::to_value(GoferSettings::default()).expect("settings as json");
        older["ai"]
            .as_object_mut()
            .expect("ai settings")
            .remove("subagent");
        fs::write(&path, older.to_string()).expect("write older settings");

        let loaded = read_settings_from_path(&path).expect("read settings");

        assert_eq!(loaded.ai.subagent, SubagentSettings::default());
        assert_eq!(loaded.ai.subagent.command_timeout_minutes, 5);
        assert_eq!(loaded.ai.subagent.max_turns, 24);

        // And one bound dropped by hand fills in on its own, without taking the rest with it.
        let mut partial = serde_json::to_value(GoferSettings::default()).expect("settings as json");
        partial["ai"]["subagent"]
            .as_object_mut()
            .expect("subagent settings")
            .remove("streamInactivityMinutes");
        partial["ai"]["subagent"]["maxTurns"] = serde_json::json!(3);
        fs::write(&path, partial.to_string()).expect("write partial settings");

        let loaded = read_settings_from_path(&path).expect("read settings");

        assert_eq!(loaded.ai.subagent.stream_inactivity_minutes, 10);
        assert_eq!(loaded.ai.subagent.max_turns, 3);
    }

    /// Absent is what every existing settings file says, and it has to keep meaning "the child uses
    /// whatever the parent uses" rather than becoming a model nobody chose.
    #[test]
    fn a_settings_file_with_no_subagent_connection_gives_the_child_none() {
        let directory = TempDir::new().expect("temporary directory");
        let path = directory.path().join("settings.json");
        let stored = serde_json::to_value(GoferSettings::default()).expect("settings as json");
        assert!(stored["ai"]["subagent"]["connection"].is_null());
        fs::write(&path, stored.to_string()).expect("write settings");

        let loaded = read_settings_from_path(&path).expect("read settings");

        assert_eq!(loaded.ai.subagent.connection, None);
    }

    #[test]
    fn a_subagent_model_is_held_to_the_same_rules_as_the_parents() {
        let connection = SubagentConnection {
            connection_type: AiConnectionType::OpenaiCodex,
            model: "  gpt-5.4-mini  ".to_owned(),
            model_name: String::new(),
            context_window: 272_000,
            max_tokens: 128_000,
            reasoning: true,
            supports_reasoning_effort: true,
            input: default_model_input(),
            thinking_level: "low".to_owned(),
        };
        let mut settings = GoferSettings::default();
        settings.ai.subagent.connection = Some(connection.clone());

        let validated = validate_settings(settings).expect("validated settings");
        let stored = validated
            .ai
            .subagent
            .connection
            .expect("the sub-agent connection");

        // Trimmed, and named after itself when the name was left blank — exactly what the parent's
        // model gets.
        assert_eq!(stored.model, "gpt-5.4-mini");
        assert_eq!(stored.model_name, "gpt-5.4-mini");
        assert_eq!(stored.thinking_level, "low");

        // A model that cannot reason has no level to keep, so the level is dropped rather than left
        // pointing at nothing.
        let mut settings = GoferSettings::default();
        settings.ai.subagent.connection = Some(SubagentConnection {
            reasoning: false,
            ..connection.clone()
        });

        let validated = validate_settings(settings).expect("validated settings");

        assert_eq!(
            validated
                .ai
                .subagent
                .connection
                .expect("the sub-agent connection")
                .thinking_level,
            "off"
        );

        let mut settings = GoferSettings::default();
        settings.ai.subagent.connection = Some(SubagentConnection {
            model: "   ".to_owned(),
            ..connection
        });

        assert_eq!(
            validate_settings(settings).expect_err("an empty model is refused"),
            "Sub-agent model ID is required"
        );
    }

    /// The child names one of the two connections the file already holds. Pointing it at a local
    /// connection nobody has configured is refused here, where it can be read, rather than becoming
    /// a turn that dies on its first delegation.
    #[test]
    fn a_subagent_on_a_local_connection_that_does_not_exist_is_refused() {
        let local = SubagentConnection {
            connection_type: AiConnectionType::OpenaiCompatible,
            model: "Qwen3.6-27B-UD-Q4_K_XL.gguf".to_owned(),
            model_name: String::new(),
            context_window: default_context_window(),
            max_tokens: default_context_window(),
            reasoning: false,
            supports_reasoning_effort: false,
            input: default_model_input(),
            thinking_level: "off".to_owned(),
        };

        let mut settings = GoferSettings::default();
        settings.ai.connection_type = AiConnectionType::OpenaiCodex;
        settings.ai.api = ApiDialect::OpenaiCodexResponses;
        settings.ai.local = None;
        settings.ai.subagent.connection = Some(local.clone());

        assert_eq!(
            validate_settings(settings).expect_err("a local child with no local connection"),
            "The sub-agent cannot use the local connection until one is configured"
        );

        // The same child is fine the moment a local connection exists — including the case where it
        // is the parent's own, which lives in the flat fields until the mirror below writes it.
        let mut settings = GoferSettings::default();
        settings.ai.subagent.connection = Some(local);

        let validated = validate_settings(settings).expect("validated settings");

        assert!(validated.ai.subagent.connection.is_some());
    }

    /// A settings file written before the Godot tab existed has no `godot` section at all, and the
    /// build that reads it must not treat "never chosen" as "turned off". Both rules are on for a
    /// project opened for the first time, so both are on for a file that predates the question.
    #[test]
    fn godot_rules_are_enforced_for_a_settings_file_that_predates_them() {
        let directory = TempDir::new().expect("temporary directory");
        let path = directory.path().join("settings.json");
        let mut older = serde_json::to_value(GoferSettings::default()).expect("settings as json");
        older
            .as_object_mut()
            .expect("settings object")
            .remove("godot");
        fs::write(&path, older.to_string()).expect("write older settings");

        let loaded = read_settings_from_path(&path).expect("read settings");

        assert!(loaded.godot.strict_typing);
        assert!(loaded.godot.embed_game_window);

        // And one rule dropped by hand fills in on its own, without dragging the other with it.
        let mut partial = serde_json::to_value(GoferSettings::default()).expect("settings as json");
        partial["godot"]
            .as_object_mut()
            .expect("godot settings")
            .remove("strictTyping");
        partial["godot"]["embedGameWindow"] = serde_json::json!(false);
        fs::write(&path, partial.to_string()).expect("write partial settings");

        let loaded = read_settings_from_path(&path).expect("read settings");

        assert!(loaded.godot.strict_typing);
        assert!(!loaded.godot.embed_game_window);
    }

    /// The Godot tab writes on every tick of a checkbox, with no Save of its own. It must therefore
    /// write the two rules and nothing else: a connection half-typed on another tab is still a
    /// draft, and ticking a box is not the user asking for it to be stored.
    #[test]
    fn saving_the_godot_rules_leaves_the_rest_of_the_file_alone() {
        let directory = TempDir::new().expect("temporary directory");
        let path = directory.path().join("settings.json");
        let stored =
            validate_settings(settings("http://localhost:9999/v1", "stored-model")).expect("valid");
        write_settings_to_path(&path, &stored).expect("write settings");

        let saved = save_godot_settings_at(
            &path,
            GodotSettings {
                strict_typing: false,
                embed_game_window: true,
            },
        )
        .expect("save godot settings");

        assert!(!saved.godot.strict_typing);
        assert!(saved.godot.embed_game_window);
        assert_eq!(saved.ai.model, "stored-model");

        // What came back is what landed on disk, not just what was computed in memory.
        let loaded = read_settings_from_path(&path).expect("read settings");
        assert_eq!(loaded, saved);
        assert_eq!(loaded.ai.base_url, "http://localhost:9999/v1");
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
        let local = loaded.ai.local.as_ref().expect("saved local profile");
        assert_eq!(local.name, "Test connection");
        assert_eq!(local.model, "model");
        assert_eq!(local.base_url, "http://localhost:8080/v1");
        assert_eq!(loaded.ai.chatgpt, default_chatgpt_profile());
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

        let catalog = pi_catalog_from_path(&path).expect("Pi catalog");
        assert_eq!(catalog.models.len(), 1);
        assert_eq!(catalog.models[0].name, "Vision Model");
        assert!(catalog.models[0].reasoning);
        assert_eq!(catalog.models[0].input, ["text", "image"]);
        // Read back without the trailing slash, because that is how the settings store a base URL.
        assert_eq!(
            catalog.servers.get("http://127.0.0.1:11434/v1"),
            Some(&true)
        );
        let defaults = default_settings_from_pi_path(&path).expect("Pi defaults");
        assert_eq!(defaults.ai.model, "vision-model");
        assert_eq!(defaults.ai.context_window, 8_192);
        assert!(defaults.ai.supports_reasoning_effort);

        fs::write(&path, "not-json").expect("write invalid Pi models");
        assert!(pi_catalog_from_path(&path).unwrap_err().contains("invalid"));
        assert!(default_settings_from_pi_path(&path).is_none());
    }

    /// The catalogue answers for the model, not for the server it happens to sit behind.
    ///
    /// A provider that takes a reasoning effort does not make every model under it a thinking one,
    /// and a model that cannot think has no effort to be asked at. Both halves used to be copied
    /// straight off the provider, which reported a plain model as one with seven reasoning levels.
    #[test]
    fn a_model_answers_for_its_own_reasoning() {
        let directory = TempDir::new().expect("temporary Pi settings");
        let path = directory.path().join("models.json");
        fs::write(
            &path,
            r#"{
                "providers": {
                    "local": {
                        "baseUrl": "http://127.0.0.1:8080/v1/",
                        "compat": {"supportsReasoningEffort": true},
                        "models": [
                            {"id": "thinker", "name": "Thinker", "reasoning": true},
                            {"id": "plain", "name": "Plain", "reasoning": false}
                        ]
                    },
                    "dumb-server": {
                        "baseUrl": "http://127.0.0.1:9090/v1",
                        "models": [{"id": "hopeful", "name": "Hopeful", "reasoning": true}]
                    }
                }
            }"#,
        )
        .expect("write Pi models");

        let catalog = pi_catalog_from_path(&path).expect("Pi catalog");
        let model = |id: &str| {
            catalog
                .models
                .iter()
                .find(|model| model.id == id)
                .expect("catalogued model")
                .clone()
        };
        assert!(model("thinker").reasoning);
        assert!(model("thinker").supports_reasoning_effort);
        assert!(!model("plain").reasoning);
        assert!(!model("plain").supports_reasoning_effort);
        // A thinking model on a server that cannot be told an effort still thinks. It just cannot
        // be told how hard, which is what leaves its level at `off`.
        assert!(model("hopeful").reasoning);
        assert!(!model("hopeful").supports_reasoning_effort);
        assert_eq!(catalog.servers.get("http://127.0.0.1:8080/v1"), Some(&true));
        assert_eq!(
            catalog.servers.get("http://127.0.0.1:9090/v1"),
            Some(&false)
        );
    }

    /// The regression: a served model Pi has never named still gets its server's answer.
    ///
    /// llama.cpp reports the file it was started with — `/models/Qwen3.8-27B-NVFP4.gguf` — while
    /// Pi's catalogue names the same model `Qwen3.8-27B-UD-Q4_K_XL.gguf`. The ids do not match, and
    /// an unmatched model used to be reported as unable to think. That wrote `reasoning: false`
    /// into the settings file, which took the reasoning menu down to `off` and left it there.
    #[test]
    fn an_unnamed_local_model_inherits_what_its_server_can_do() {
        let directory = TempDir::new().expect("temporary Pi settings");
        let path = directory.path().join("models.json");
        fs::write(
            &path,
            r#"{
                "providers": {
                    "local": {
                        "baseUrl": "http://127.0.0.1:8080/v1",
                        "compat": {"supportsReasoningEffort": true},
                        "models": [{
                            "id": "Qwen3.8-27B-UD-Q4_K_XL.gguf",
                            "name": "Qwen3.8 27B",
                            "reasoning": true,
                            "contextWindow": 120064,
                            "maxTokens": 120064
                        }]
                    }
                }
            }"#,
        )
        .expect("write Pi models");
        let catalog = pi_catalog_from_path(&path).expect("Pi catalog");
        let ai = settings("http://127.0.0.1:8080/v1", "/models/Qwen3.8-27B-NVFP4.gguf").ai;

        let served = local_model_options(
            vec![
                Model {
                    id: "/models/Qwen3.8-27B-NVFP4.gguf".to_owned(),
                    meta: Some(ModelMeta {
                        n_ctx: Some(120_064),
                    }),
                },
                Model {
                    id: "Qwen3.8-27B-UD-Q4_K_XL.gguf".to_owned(),
                    meta: None,
                },
            ],
            &catalog,
            &ai,
        );

        // The file the server was started with: not in the catalogue, and it thinks anyway.
        assert_eq!(served[0].id, "/models/Qwen3.8-27B-NVFP4.gguf");
        assert!(served[0].reasoning);
        assert!(served[0].supports_reasoning_effort);
        assert_eq!(served[0].context_window, 120_064);
        // The one Pi does name is unaffected: its own answer, not its server's.
        assert!(served[1].reasoning);
        assert_eq!(served[1].name, "Qwen3.8 27B");

        // And a server Pi says nothing about grants nothing. Silence is not a capability.
        let elsewhere = settings("http://127.0.0.1:9999/v1", "mystery.gguf").ai;
        let unknown = local_model_options(
            vec![Model {
                id: "mystery.gguf".to_owned(),
                meta: None,
            }],
            &catalog,
            &elsewhere,
        );
        assert!(!unknown[0].reasoning);
        assert!(!unknown[0].supports_reasoning_effort);
    }

    /// The whole point of the resolver: nothing on disk is the authority on what a model can do.
    ///
    /// This is the shape the user hit. A settings file written before the catalogue could be read
    /// says `reasoning: false` in three separate places — the flat fields, the saved local profile,
    /// and the sub-agent's own connection — about a model that reasons. Each was copied once at
    /// pick-time and nothing ever asked again, so all three reasoning menus offered `off` and
    /// nothing else, permanently. A read now re-derives all three.
    #[test]
    fn every_stored_copy_of_a_model_fact_is_replaced_on_read() {
        let directory = TempDir::new().expect("temporary directory");
        let pi = directory.path().join("models.json");
        fs::write(
            &pi,
            r#"{
                "providers": {
                    "local": {
                        "baseUrl": "http://127.0.0.1:8080/v1",
                        "compat": {"supportsReasoningEffort": true},
                        "models": [{"id": "named.gguf", "name": "Named", "reasoning": true}]
                    }
                }
            }"#,
        )
        .expect("write Pi models");

        let path = directory.path().join("settings.json");
        let mut stale = settings("http://127.0.0.1:8080/v1", "/models/served.gguf");
        stale.ai.reasoning = false;
        stale.ai.supports_reasoning_effort = false;
        stale.ai.thinking_level = "off".to_owned();
        stale.ai.subagent.connection = Some(SubagentConnection {
            connection_type: AiConnectionType::OpenaiCompatible,
            model: "/models/served.gguf".to_owned(),
            model_name: "/models/served.gguf".to_owned(),
            context_window: 120_064,
            max_tokens: 120_064,
            reasoning: false,
            supports_reasoning_effort: false,
            input: vec!["text".to_owned()],
            thinking_level: "off".to_owned(),
        });
        fs::write(
            &path,
            serde_json::to_string(&stale).expect("serialize settings"),
        )
        .expect("write settings");

        let loaded = read_settings_from_paths(&path, Some(&pi)).expect("read settings");

        // The flat fields.
        assert!(loaded.ai.reasoning);
        assert!(loaded.ai.supports_reasoning_effort);
        // The saved local profile.
        let local = loaded.ai.local.as_ref().expect("local profile");
        assert!(local.reasoning);
        assert!(local.supports_reasoning_effort);
        // And the sub-agent's own connection, which is the copy that outlived the other two.
        let child = loaded
            .ai
            .subagent
            .connection
            .as_ref()
            .expect("sub-agent connection");
        assert!(child.reasoning);
        assert!(child.supports_reasoning_effort);

        // What the user owns is untouched. Only what the model decides is re-derived.
        assert_eq!(loaded.ai.model, "/models/served.gguf");
        assert_eq!(loaded.ai.context_window, stale.ai.context_window);
        // And what the catalogue does not know, it does not answer. A server's declared reasoning
        // says nothing about what a model it has never described accepts, so the stored input
        // stands — inventing `["text", "image"]` here turns the composer's image control on and
        // ships pictures to a server that refuses them.
        assert_eq!(loaded.ai.input, stale.ai.input);
        assert_eq!(loaded.ai.model_name, stale.ai.model_name);
    }

    /// A model the catalogue names answers for itself, even when its server would say otherwise.
    #[test]
    fn resolution_takes_a_level_away_from_a_model_that_cannot_think() {
        let directory = TempDir::new().expect("temporary directory");
        let pi = directory.path().join("models.json");
        fs::write(
            &pi,
            r#"{
                "providers": {
                    "local": {
                        "baseUrl": "http://127.0.0.1:8080/v1",
                        "compat": {"supportsReasoningEffort": true},
                        "models": [{"id": "plain.gguf", "name": "Plain", "reasoning": false}]
                    }
                }
            }"#,
        )
        .expect("write Pi models");

        let path = directory.path().join("settings.json");
        let mut stale = settings("http://127.0.0.1:8080/v1", "plain.gguf");
        stale.ai.reasoning = true;
        stale.ai.supports_reasoning_effort = true;
        stale.ai.thinking_level = "high".to_owned();
        fs::write(
            &path,
            serde_json::to_string(&stale).expect("serialize settings"),
        )
        .expect("write settings");

        let loaded = read_settings_from_paths(&path, Some(&pi)).expect("read settings");

        assert!(!loaded.ai.reasoning);
        assert!(!loaded.ai.supports_reasoning_effort);
        // A level pointing at nothing is not left standing.
        assert_eq!(loaded.ai.thinking_level, "off");
        assert_eq!(loaded.ai.model_name, "Plain");
    }

    /// Silence is not an answer. A catalogue that says nothing leaves the stored copy alone.
    ///
    /// This is the half that must not regress: a ChatGPT connection has no entry in Pi's file, and
    /// resolving it to `false` would take the reasoning away from every model that has one.
    #[test]
    fn a_catalogue_with_no_answer_changes_nothing() {
        let directory = TempDir::new().expect("temporary directory");
        let pi = directory.path().join("models.json");
        fs::write(&pi, r#"{"providers": {}}"#).expect("write Pi models");

        let path = directory.path().join("settings.json");
        let mut stored = settings("http://127.0.0.1:8080/v1", "thinker.gguf");
        stored.ai.reasoning = true;
        stored.ai.supports_reasoning_effort = true;
        stored.ai.thinking_level = "high".to_owned();
        fs::write(
            &path,
            serde_json::to_string(&stored).expect("serialize settings"),
        )
        .expect("write settings");

        let loaded = read_settings_from_paths(&path, Some(&pi)).expect("read settings");

        assert!(loaded.ai.reasoning);
        assert_eq!(loaded.ai.thinking_level, "high");
        // And the ChatGPT profile, which Pi's file never describes, keeps everything it had.
        assert!(loaded.ai.chatgpt.reasoning);
        assert!(loaded.ai.chatgpt.supports_reasoning_effort);
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

        assert_eq!(error.code, "ai_unreachable");
        assert!(
            error.retryable,
            "the server can be fixed and the button pressed again"
        );
        assert!(error.message.contains("invalid OpenAI models response"));
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
                .message
                .contains("HTTP 500")
        );
        server.join().expect("failed model list request");

        let (base_url, server) = mock_server("200 OK", "not-json");
        assert!(
            list_ai_models(request(base_url, "custom"))
                .await
                .unwrap_err()
                .message
                .contains("invalid OpenAI models response")
        );
        server.join().expect("invalid model list request");
    }

    #[test]
    fn validation_rejects_every_bounded_settings_shape() {
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
            // A line drawn this low summarises a conversation that has barely started; drawn above
            // 100 it never fires at all, which the 100 case already expresses honestly.
            {
                let mut value = settings("http://localhost", "model");
                value.ai.compaction_percent = 49;
                value
            },
            {
                let mut value = settings("http://localhost", "model");
                value.ai.compaction_percent = 101;
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
}

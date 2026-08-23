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

use crate::model_server::ServedModel;

const API_KEY_SERVICE: &str = "com.gofer.desktop";
const API_KEY_USERNAME: &str = "ai-default";
/// OpenRouter's key, under its own username. Sharing `ai-default` with the local driver would mean
/// configuring one wipes the other, and would send a key meant for openrouter.ai as bearer to
/// whatever is listening on the user's own machine.
const OPENROUTER_KEY_USERNAME: &str = "ai-openrouter";
/// OpenRouter's address, which the user never types. Mirrors `OPENROUTER_BASE_URL` in settings.ts.
const OPENROUTER_BASE_URL: &str = "https://openrouter.ai/api/v1";
const CHATGPT_CREDENTIAL_USERNAME: &str = "ai-openai-codex";
/// A second username under the one service, which is how this keyring holds more than one secret.
const BRAVE_KEY_USERNAME: &str = "web-brave-search";

const SETTINGS_FILE_NAME: &str = "settings.json";

const SETTINGS_VERSION: u32 = 1;

/// The levels a model with named efforts can be asked at.
const EFFORT_THINKING_LEVELS: &[&str] =
    &["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/// Every level a settings file may legally name. `on` belongs to a model that thinks and has no
/// efforts to name; the rest belong to one that has. Which of them a given model actually offers is
/// `thinking_levels`, and this is only what is not a typo.
const ALL_THINKING_LEVELS: &[&str] = &[
    "off", "on", "minimal", "low", "medium", "high", "xhigh", "max",
];

/// Every word that names an effort, which is `ALL_THINKING_LEVELS` without the two that do not.
///
/// `off` is the absence of an effort and `on` belongs to a template with none to name, so neither
/// can arrive from a catalogue. The same list, in the same order, is `KNOWN_EFFORTS` in
/// `model_server.rs` and in `thinking-level.mjs`.
const NAMED_EFFORTS: &[&str] = &["minimal", "low", "medium", "high", "xhigh", "max"];

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
    #[serde(default = "default_max_tokens")]
    pub(crate) max_tokens: u64,
    #[serde(default)]
    pub(crate) reasoning: bool,
    #[serde(default)]
    pub(crate) supports_reasoning_effort: bool,
    /// Whether thinking is turned on by a chat-template argument rather than by an effort field.
    ///
    /// True for a llama.cpp host: it takes `chat_template_kwargs.enable_thinking` and silently
    /// ignores `reasoning_effort`, so a build that sent only the effort field never turned thinking
    /// on or off for one of these at all. Derived from the server, never typed.
    #[serde(default)]
    pub(crate) chat_template_thinking: bool,
    /// The efforts this model's server said it will accept, or empty when nothing has said.
    ///
    /// The menu, in other words. Empty is not "none" — it is "unasked", and the reasoning flags
    /// answer instead. A list rather than a flag because a chat template refuses the efforts it
    /// does not know, loudly: one Qwen build accepts three of Gofer's seven levels and answers the
    /// other two with HTTP 500 on every request of the turn.
    #[serde(default)]
    pub(crate) thinking_levels: Vec<String>,
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
    /// Always present, for a reason the local profile does not share: a driver with no profile is
    /// not offered in the picker, and a driver that is not offered can never be selected in order
    /// to be configured. OpenRouter's address and dialect are constants, so there is nothing to
    /// wait for.
    #[serde(default = "default_openrouter_profile")]
    pub(crate) openrouter: AiConnectionProfile,
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
    /// Whether thinking is turned on by a chat-template argument rather than by an effort field.
    ///
    /// True for a llama.cpp host: it takes `chat_template_kwargs.enable_thinking` and silently
    /// ignores `reasoning_effort`, so a build that sent only the effort field never turned thinking
    /// on or off for one of these at all. Derived from the server, never typed.
    #[serde(default)]
    chat_template_thinking: bool,
    /// The efforts this model's server said it will accept, or empty when nothing has said.
    ///
    /// The menu, in other words. Empty is not "none" — it is "unasked", and the reasoning flags
    /// answer instead. A list rather than a flag because a chat template refuses the efforts it
    /// does not know, loudly: one Qwen build accepts three of Gofer's seven levels and answers the
    /// other two with HTTP 500 on every request of the turn.
    #[serde(default)]
    thinking_levels: Vec<String>,
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
    /// How many times one delegation may stop the user to show them something. 0 turns showing off.
    #[serde(default = "default_subagent_max_shows")]
    pub(crate) max_shows: u32,
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
    #[serde(default = "default_max_tokens")]
    pub(crate) max_tokens: u64,
    #[serde(default)]
    pub(crate) reasoning: bool,
    #[serde(default)]
    pub(crate) supports_reasoning_effort: bool,
    /// The efforts this model's server said it will accept, or empty when nothing has said.
    ///
    /// The menu, in other words. Empty is not "none" — it is "unasked", and the reasoning flags
    /// answer instead. A list rather than a flag because a chat template refuses the efforts it
    /// does not know, loudly: one Qwen build accepts three of Gofer's seven levels and answers the
    /// other two with HTTP 500 on every request of the turn.
    #[serde(default)]
    pub(crate) thinking_levels: Vec<String>,
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
    Openrouter,
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
    has_openrouter_api_key: bool,
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
    /// OpenRouter's key, by the same three-way rule, into its own keyring slot.
    #[serde(default)]
    pub(crate) openrouter_api_key: ApiKeyUpdate,
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
    /// The efforts this model's own server named, or empty when nothing named any. See
    /// `AiSettings::thinking_levels` — this is the same list, on its way to the settings page.
    #[serde(default)]
    thinking_levels: Vec<String>,
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

/// One model as OpenRouter's catalogue describes it.
///
/// Deliberately not the `Model` struct above. That one is llama.cpp's shape — an id and an
/// `n_ctx` — and every field here is one llama.cpp has never heard of.
#[derive(Deserialize)]
struct OpenrouterModel {
    id: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    context_length: Option<u64>,
    #[serde(default)]
    architecture: Option<OpenrouterArchitecture>,
    #[serde(default)]
    top_provider: Option<OpenrouterTopProvider>,
    #[serde(default)]
    supported_parameters: Vec<String>,
    #[serde(default)]
    reasoning: Option<OpenrouterReasoning>,
}

#[derive(Deserialize)]
struct OpenrouterArchitecture {
    #[serde(default)]
    input_modalities: Vec<String>,
}

#[derive(Deserialize)]
struct OpenrouterTopProvider {
    #[serde(default)]
    max_completion_tokens: Option<u64>,
}

#[derive(Deserialize)]
struct OpenrouterReasoning {
    #[serde(default)]
    supported_efforts: Vec<String>,
}

#[derive(Deserialize)]
struct OpenrouterModelsResponse {
    data: Vec<OpenrouterModel>,
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

/// How long one response may be before the server cuts it off.
///
/// It used to be the context window, which is the same as no ceiling at all: a model that will not
/// stop is allowed to fill the whole turn with one answer. Measured over fifteen live turns against
/// the local Qwen3.6-27B — a collect-the-coin game, a platformer, a tilemap arena, a menu, two
/// debugger sessions, a broken project, a 195-call arcade game and a 3D scene — the longest real
/// response any of them produced was **810 tokens**. Two turns ran away instead: one decoded 89,311
/// tokens in a single answer before the context stopped it, and the next decoded past 48,000 and
/// was still going. At the speed that machine generates, a runaway costs three quarters of an hour
/// and leaves no context to recover in.
///
/// So: twenty times the longest answer anyone has needed, and a seventh of the window. A whole
/// GDScript file of thirteen hundred lines still fits in one `godot_script save`. What changes is
/// what a degenerate answer costs — the worker already tells the model its response was cut off and
/// to re-issue the call, and one live turn recovered from exactly that message.
///
/// The number is also the one the rest of the worker was already built around.
/// [`default_compaction_percent`] leaves a reserve of `120_064 - 103_255` = 16,809 tokens above the
/// compaction line, and that reserve is what the summary request *and* the answer after it have to
/// fit inside. A ceiling of 16,384 fits; a ceiling of 120,064 is an answer that can eat the reserve
/// whole, which is what run13 and run15 did.
///
/// A user who has stored their own ceiling keeps it: this is the default for a setting nobody has
/// chosen, not a clamp on one somebody has.
fn default_max_tokens() -> u64 {
    16_384
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

/// How many times one delegation may stop the user to show them something.
///
/// The only ceiling here that is measured in the user's attention rather than the machine's time,
/// and the only one whose cost nothing else can see: the parent never learns that a dialog opened,
/// and no clock ticks while a person is looking at it. Six is two or three revisions of one layout
/// plus room to be wrong once — past that the conversation has stopped converging and belongs back
/// in the chat.
fn default_subagent_max_shows() -> u32 {
    6
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
            max_shows: default_subagent_max_shows(),
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
            max_tokens: default_max_tokens(),
            reasoning: false,
            supports_reasoning_effort: false,
            chat_template_thinking: false,
            thinking_levels: Vec::new(),
            input: default_model_input(),
            thinking_level: default_thinking_level(),
            max_retries: default_max_retries(),
            timeout_ms: default_timeout_ms(),
            compaction_percent: default_compaction_percent(),
            subagent: SubagentSettings::default(),
            web: WebSettings::default(),
            local: None,
            chatgpt: default_chatgpt_profile(),
            openrouter: default_openrouter_profile(),
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
        // ChatGPT takes a reasoning effort like any OpenAI endpoint. Nothing about a chat template
        // reaches it, and there is no `/props` behind that address to say otherwise.
        chat_template_thinking: false,
        thinking_levels: Vec::new(),
        input: vec!["text".to_owned(), "image".to_owned()],
        thinking_level: "high".to_owned(),
    }
}

/// The connection a driver runs on, or nothing when that driver has never been configured.
///
/// The active driver is read from the flat fields, not from its slot: the flat fields are what the
/// settings page validated, and the slot is the copy it mirrored. Reading the mirror for the driver
/// that is switched on would be trusting a copy over the original. Mirrors `connectionProfile` in
/// settings.ts, which draws the same line for the same reason.
fn driver_profile(settings: &AiSettings, driver: AiConnectionType) -> Option<AiConnectionProfile> {
    if settings.connection_type == driver {
        return Some(profile_of(settings));
    }
    match driver {
        AiConnectionType::OpenaiCompatible => settings.local.clone(),
        AiConnectionType::OpenaiCodex => Some(settings.chatgpt.clone()),
        AiConnectionType::Openrouter => Some(settings.openrouter.clone()),
    }
}

/// The word a driver is written down as, on the wire and in the settings file.
///
/// Never the display label: a file holding `OpenRouter` matches no driver this build knows.
fn driver_id(driver: AiConnectionType) -> &'static str {
    match driver {
        AiConnectionType::OpenaiCompatible => "openai-compatible",
        AiConnectionType::OpenaiCodex => "openai-codex",
        AiConnectionType::Openrouter => "openrouter",
    }
}

/// OpenRouter, as it looks before the user has chosen anything.
///
/// The address is fixed and the dialect is the ordinary chat-completions one — measured, not
/// assumed: a real turn ran through this exact address and dialect and called a tool. The model is
/// a starting point, not a promise; the catalogue is read on every open and reconciles it.
fn default_openrouter_profile() -> AiConnectionProfile {
    AiConnectionProfile {
        name: "OpenRouter".to_owned(),
        base_url: OPENROUTER_BASE_URL.to_owned(),
        model: "nvidia/nemotron-3.5-lightning:free".to_owned(),
        api: ApiDialect::OpenaiCompletions,
        model_name: "NVIDIA: Nemotron 3.5 Lightning".to_owned(),
        context_window: 1_000_000,
        max_tokens: 1_000_000,
        reasoning: false,
        supports_reasoning_effort: false,
        // A chat template is a llama.cpp mechanism. There is no `/props` behind this address.
        chat_template_thinking: false,
        thinking_levels: Vec::new(),
        input: vec!["text".to_owned()],
        thinking_level: "off".to_owned(),
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
    openrouter_api_key: Option<String>,
    oauth_credential: Option<serde_json::Value>,
) -> Option<crate::rag::RetrieveConnection> {
    let chosen = settings.subagent.connection.as_ref();
    let driver = chosen.map_or(settings.connection_type, |c| c.connection_type);
    // The address, the dialect and the credential are the connection's; the model and the level it
    // is asked at are the child's own. Exactly how `subagentModelFor` splits them in the worker.
    let profile = driver_profile(settings, driver)?;
    let codex = driver == AiConnectionType::OpenaiCodex;
    if codex && oauth_credential.is_none() {
        return None;
    }
    Some(crate::rag::RetrieveConnection {
        connection_type: driver_id(driver).to_owned(),
        oauth_credential: if codex { oauth_credential } else { None },
        base_url: profile.base_url.clone(),
        model: chosen.map_or_else(|| profile.model.clone(), |c| c.model.clone()),
        model_name: chosen.map_or_else(|| profile.model_name.clone(), |c| c.model_name.clone()),
        // ChatGPT authenticates with the credential above and takes no key. The other two each
        // take their own, from their own keyring slot — a key sent to the wrong address is a key
        // handed to a machine that was never meant to see it.
        api_key: match driver {
            AiConnectionType::OpenaiCodex => None,
            AiConnectionType::OpenaiCompatible => api_key,
            AiConnectionType::Openrouter => openrouter_api_key,
        },
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
        thinking_levels: chosen.map_or_else(
            || profile.thinking_levels.clone(),
            |c| c.thinking_levels.clone(),
        ),
        // The connection's, never the child's: the child borrows an address, and how thinking is
        // turned on is a fact about the server at that address.
        chat_template_thinking: profile.chat_template_thinking,
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

/// Every field a connection holds about its model, borrowed from whichever connection it is.
///
/// Three shapes hold the same facts — the flat settings, the saved local profile and the sub-agent's
/// connection — and all three are corrected by the same rules. Borrowed rather than copied so the
/// correction lands on the real thing, and written once rather than three times because the last
/// build's copies drifted apart.
struct ModelFields<'a> {
    /// The address the model is resolved against. The sub-agent has none of its own — it borrows
    /// the connection it names — so this is passed in rather than read off the connection.
    base_url: String,
    model: &'a mut String,
    model_name: &'a mut String,
    context_window: &'a mut u64,
    max_tokens: &'a mut u64,
    reasoning: &'a mut bool,
    supports_reasoning_effort: &'a mut bool,
    /// Absent for the sub-agent, which has no connection of its own to describe. It borrows the
    /// local one, and the local one's copy of this is the one the worker reads.
    chat_template_thinking: Option<&'a mut bool>,
    thinking_levels: &'a mut Vec<String>,
    input: &'a mut Vec<String>,
    thinking_level: &'a mut String,
}

/// The levels one model may be asked at, which is not one list.
///
/// Four cases. `levels` is what the model's own server said it accepts, and it wins outright: a
/// chat template raises on an effort it does not know, and llama.cpp turns that into an HTTP 500
/// on every request of the turn. Empty means nobody has asked — a ChatGPT model, or a local one
/// resolved before its server was reachable — and then the two flags answer instead.
///
/// The middle case is why this is not a constant. A template can have a place for thinking and no
/// effort to name, and the honest control there is on or off, not seven words that all mean on.
fn thinking_levels(
    reasoning: bool,
    supports_reasoning_effort: bool,
    levels: &[String],
) -> Vec<String> {
    // Reasoning first, and it is not redundant: a model can be marked as taking an effort and as
    // not thinking at all, and a model that does not think has nothing to spend an effort on.
    if !reasoning {
        return vec!["off".to_owned()];
    }
    if !levels.is_empty() {
        return std::iter::once("off".to_owned())
            .chain(levels.iter().cloned())
            .collect();
    }
    if supports_reasoning_effort {
        return EFFORT_THINKING_LEVELS
            .iter()
            .map(|level| (*level).to_owned())
            .collect();
    }
    vec!["off".to_owned(), "on".to_owned()]
}

/// The stored level, kept if the model still offers it and dropped to `off` if it does not.
fn keep_level(
    level: &str,
    reasoning: bool,
    supports_reasoning_effort: bool,
    levels: &[String],
) -> String {
    if thinking_levels(reasoning, supports_reasoning_effort, levels)
        .iter()
        .any(|offered| offered == level)
    {
        level.to_owned()
    } else {
        "off".to_owned()
    }
}

/// Re-derives every model-owned fact in a settings file, from the catalogue and from the server.
///
/// Called on every read and every save, so what is on disk is never the authority — it is a copy
/// the next load overwrites. Only the local driver is resolvable here: Pi's `models.json` is a file
/// on this machine, while ChatGPT's catalogue lives behind a sidecar process that a settings read
/// cannot afford to start. The ChatGPT half keeps what it has and is refreshed by the model lister
/// instead, which is the only other writer of these fields.
///
/// Two sources, in order. The catalogue is a file written once and it names models by ids a
/// llama.cpp host has never heard of, so it answers first and loosely. The server answers last and
/// exactly: it is the only one of the two that changes when the user swaps the loaded `.gguf`,
/// which they may do at any time and without telling anybody.
fn resolve_model_facts(
    settings: &mut AiSettings,
    catalog: &PiCatalog,
    served: &HashMap<String, ServedModel>,
) {
    if matches!(settings.connection_type, AiConnectionType::OpenaiCompatible) {
        let base_url = settings.base_url.clone();
        resolve_connection(
            ModelFields {
                base_url,
                model: &mut settings.model,
                model_name: &mut settings.model_name,
                context_window: &mut settings.context_window,
                max_tokens: &mut settings.max_tokens,
                reasoning: &mut settings.reasoning,
                supports_reasoning_effort: &mut settings.supports_reasoning_effort,
                chat_template_thinking: Some(&mut settings.chat_template_thinking),
                thinking_levels: &mut settings.thinking_levels,
                input: &mut settings.input,
                thinking_level: &mut settings.thinking_level,
            },
            catalog,
            served,
        );
    }
    // The sub-agent has no address of its own — it borrows the connection it names. So the server
    // its model is resolved against is that connection's, not the parent's. Read before the local
    // profile is borrowed, because after that it cannot be.
    let local_base_url = settings
        .local
        .as_ref()
        .map(|local| local.base_url.clone())
        .or_else(|| {
            matches!(settings.connection_type, AiConnectionType::OpenaiCompatible)
                .then(|| settings.base_url.clone())
        });
    if let Some(local) = settings.local.as_mut() {
        let base_url = local.base_url.clone();
        resolve_connection(
            ModelFields {
                base_url,
                model: &mut local.model,
                model_name: &mut local.model_name,
                context_window: &mut local.context_window,
                max_tokens: &mut local.max_tokens,
                reasoning: &mut local.reasoning,
                supports_reasoning_effort: &mut local.supports_reasoning_effort,
                chat_template_thinking: Some(&mut local.chat_template_thinking),
                thinking_levels: &mut local.thinking_levels,
                input: &mut local.input,
                thinking_level: &mut local.thinking_level,
            },
            catalog,
            served,
        );
    }
    if let Some(child) = settings.subagent.connection.as_mut()
        && matches!(child.connection_type, AiConnectionType::OpenaiCompatible)
        && let Some(base_url) = local_base_url
    {
        resolve_connection(
            ModelFields {
                base_url,
                model: &mut child.model,
                model_name: &mut child.model_name,
                context_window: &mut child.context_window,
                max_tokens: &mut child.max_tokens,
                reasoning: &mut child.reasoning,
                supports_reasoning_effort: &mut child.supports_reasoning_effort,
                chat_template_thinking: None,
                thinking_levels: &mut child.thinking_levels,
                input: &mut child.input,
                thinking_level: &mut child.thinking_level,
            },
            catalog,
            served,
        );
    }
}

/// One connection, corrected by the catalogue and then by its own server.
fn resolve_connection(
    fields: ModelFields<'_>,
    catalog: &PiCatalog,
    served: &HashMap<String, ServedModel>,
) {
    if let Some(facts) = model_facts(catalog, &fields.base_url, fields.model) {
        if let Some(model_name) = facts.model_name {
            *fields.model_name = model_name;
        }
        *fields.reasoning = facts.reasoning;
        *fields.supports_reasoning_effort = facts.supports_reasoning_effort;
        if let Some(input) = facts.input {
            *fields.input = input;
        }
    }
    if let Some(model) = served.get(&server_key(&fields.base_url)) {
        // The id too, not only the facts about it — but only where there is one model to be. A
        // host serving one file answers to its path, and a stored id naming the file before it was
        // swapped names nothing at all. A router serving a directory of them is the other case:
        // there the id is the user's choice among several, `/props` describes only one of those,
        // and adopting it would move them onto a model they did not pick. So a router's answer is
        // taken only for the model it is actually about.
        if !model.sole && *fields.model != model.id {
            return;
        }
        if *fields.model != model.id {
            *fields.model = model.id.clone();
            *fields.model_name = model.id.clone();
        }
        if let Some(window) = model.context_window {
            *fields.context_window = window;
            // The output ceiling cannot outlive the window it is spent inside. Clamped rather than
            // replaced, so a user who chose a smaller one keeps it.
            *fields.max_tokens = (*fields.max_tokens).min(window);
        }
        *fields.reasoning = model.reasoning;
        *fields.supports_reasoning_effort = !model.efforts.is_empty();
        *fields.thinking_levels = model.efforts.clone();
        // A server that answered `/props` is a llama.cpp host, and thinking is turned on there by
        // a chat-template argument. The effort field it also accepts does nothing.
        if let Some(chat_template_thinking) = fields.chat_template_thinking {
            *chat_template_thinking = model.reasoning;
        }
        if let Some(input) = model.input.clone() {
            *fields.input = input;
        }
    }
    // The level, re-applied against what the model turned out to offer. Resolution can take
    // reasoning away entirely, and it can take the levels away while leaving the thinking — a
    // stored `medium` means nothing to a template whose only answers are on and off.
    *fields.thinking_level = keep_level(
        fields.thinking_level,
        *fields.reasoning,
        *fields.supports_reasoning_effort,
        fields.thinking_levels,
    );
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
        chat_template_thinking: settings.chat_template_thinking,
        thinking_levels: settings.thinking_levels.clone(),
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
    path: &str,
) -> Result<ModelsRequest, String> {
    let (settings, api_key) = tauri::async_runtime::spawn_blocking(move || {
        let settings = validate_settings(request.settings)?;
        // The driver decides which credential is sent, because each has its own keyring slot. The
        // local driver's key must never reach openrouter.ai, and OpenRouter's must never reach a
        // server on this machine.
        let api_key = match settings.ai.connection_type {
            AiConnectionType::Openrouter => {
                resolve_openrouter_api_key(&request.openrouter_api_key)?
            }
            _ => resolve_api_key(&request.api_key)?,
        };
        Ok::<_, String>((settings, api_key))
    })
    .await
    .map_err(|error| format!("AI settings validation task failed: {error}"))??;
    let base_url = format!("{}/", settings.ai.base_url.trim_end_matches('/'));
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
    // OpenRouter is asked `/key`, not `/models`. Its catalogue is public — it answers HTTP 200
    // with no credential at all — so a test through `/models` reports a healthy connection for a
    // key that does not exist. `/key` is the only cheap endpoint that refuses a bad one.
    let openrouter = matches!(
        request.settings.ai.connection_type,
        AiConnectionType::Openrouter
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
        return Ok(openrouter_model_available(&settings.ai.model, timeout).await);
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
    Ok(local_model_options(
        models.data,
        &pi_catalog().unwrap_or_default(),
        &settings.ai,
        crate::model_server::served_model(&settings.ai.base_url).as_ref(),
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
    served: Option<&ServedModel>,
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
            // And the server outranks both, for the model it says it has loaded. It is the only
            // one of the three that changes when the user swaps the file it was started with.
            let loaded = served.filter(|model| model.id == remote.id);
            AiModelOption {
                id: remote.id.clone(),
                name: known
                    .map(|model| model.name.clone())
                    .unwrap_or_else(|| remote.id.clone()),
                context_window,
                max_tokens: known
                    .map(|model| model.max_tokens)
                    .unwrap_or(context_window),
                reasoning: loaded.map_or_else(
                    || known.map_or(server_reasoning, |model| model.reasoning),
                    |model| model.reasoning,
                ),
                supports_reasoning_effort: loaded.map_or_else(
                    || known.map_or(server_reasoning, |model| model.supports_reasoning_effort),
                    |model| !model.efforts.is_empty(),
                ),
                thinking_levels: loaded
                    .map(|model| model.efforts.clone())
                    .unwrap_or_default(),
                input: loaded
                    .and_then(|model| model.input.clone())
                    .or_else(|| known.map(|model| model.input.clone()))
                    .unwrap_or_else(|| ai.input.clone()),
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
/// * `max_completion_tokens` is null on 52 models, so the context window stands in. The same
///   fallback `local_model_options` makes, for the same reason: a zero there fails validation.
/// * Efforts are kept only if `NAMED_EFFORTS` knows them, rather than dropping the one word that
///   is known not to be an effort. `supported_efforts` carries `none` today, which is OpenRouter's
///   word for "thinking can be switched off" — `thinking_levels_for` prepends `off` on its own, so
///   it is redundant as well as unknown. An allowlist also holds for whatever the catalogue names
///   next: an effort Gofer has no word for reaches the reasoning picker, and choosing it makes
///   `validate_settings` refuse the save with "Reasoning level is invalid" and no field named.
/// * Input modalities are narrowed to text and image. Pi types a model's input as exactly those
///   two, so `video`, `audio` and `file` have nowhere to go.
fn openrouter_model_options(remote: Vec<OpenrouterModel>) -> Vec<AiModelOption> {
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
                max_tokens: model
                    .top_provider
                    .and_then(|provider| provider.max_completion_tokens)
                    .unwrap_or(context_window),
                reasoning: model.reasoning.is_some(),
                // Named efforts are the only evidence that an effort field will be read. A model
                // that reasons without naming any takes no effort, which is the `on`/`off` case.
                supports_reasoning_effort: !thinking_levels.is_empty(),
                thinking_levels,
                // Never empty: `validate_settings` refuses an empty input list, and every model in
                // the catalogue takes text.
                input: if input.is_empty() {
                    vec!["text".to_owned()]
                } else {
                    input
                },
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
                    // ChatGPT names no efforts of its own — the seven Gofer knows are what it
                    // takes, which is what an empty list here means.
                    thinking_levels: Vec::new(),
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

/// The read every caller in the app makes: the file, the catalogue, and then the server itself.
///
/// The server is asked here rather than inside the resolver so the resolver stays drivable without
/// one. Asking is cheap and cached — see `model_server` — and asking on *every* read is the point:
/// the loaded model can change between any two of them.
/// The Godot rules alone, without asking any model server what it is serving.
///
/// Every read below asks the server, and the answer only ever changes fields under `ai`. The rules
/// are read on paths that are hot and that never look at those fields: `ai_tools::dispatch` reads
/// them for every single tool the model calls, and the session watch reads them on the editor
/// becoming ready. A server that accepts a connection and then says nothing — a VPN that dropped, a
/// container still starting — stalls each of those for the whole probe timeout, for an answer none
/// of them was going to read.
///
/// Narrowed to `GodotSettings` rather than left as a second way to read all of them, so no caller
/// can quietly take a stale model off this path.
pub(crate) fn read_godot_settings<R: Runtime>(app: &AppHandle<R>) -> Result<GodotSettings, String> {
    let path = settings_path(app)?;
    Ok(read_settings_unprobed_from_path(&path)?.godot)
}

/// The file and the catalogue, and nothing over the network.
fn read_settings_unprobed_from_path(path: &Path) -> Result<GoferSettings, String> {
    read_settings_from_paths(path, pi_models_path().ok().as_deref())
}

fn read_settings_from_path(path: &Path) -> Result<GoferSettings, String> {
    let pi = pi_models_path().ok();
    let settings = read_settings_from_paths(path, pi.as_deref())?;
    let served = ask_servers(&settings.ai);
    if served.is_empty() {
        return Ok(settings);
    }
    let mut settings = settings;
    resolve_model_facts(
        &mut settings.ai,
        &pi.and_then(|path| pi_catalog_from_path(&path).ok())
            .unwrap_or_default(),
        &served,
    );
    Ok(settings)
}

/// Asks every local server this settings file points at what it is serving.
///
/// Two addresses at most, and usually the same one twice: the connection the parent is on and the
/// saved local profile. ChatGPT has no `/props` and is not asked.
fn ask_servers(ai: &AiSettings) -> HashMap<String, ServedModel> {
    let addresses = [
        matches!(ai.connection_type, AiConnectionType::OpenaiCompatible)
            .then(|| ai.base_url.clone()),
        ai.local.as_ref().map(|local| local.base_url.clone()),
    ];
    let mut served = HashMap::new();
    for base_url in addresses.into_iter().flatten() {
        let key = server_key(&base_url);
        if served.contains_key(&key) {
            continue;
        }
        if let Some(model) = crate::model_server::served_model(&base_url) {
            served.insert(key, model);
        }
    }
    served
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
        &HashMap::new(),
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
        // The catalogue is a file. Only the server that has the model loaded can name its efforts.
        thinking_levels: Vec::new(),
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
            chat_template_thinking: false,
            thinking_levels: Vec::new(),
            input: model.input.clone(),
            thinking_level: default_thinking_level(),
            max_retries: default_max_retries(),
            timeout_ms: default_timeout_ms(),
            compaction_percent: default_compaction_percent(),
            subagent: SubagentSettings::default(),
            web: WebSettings::default(),
            local: None,
            chatgpt: default_chatgpt_profile(),
            openrouter: default_openrouter_profile(),
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
    if !ALL_THINKING_LEVELS.contains(&settings.ai.thinking_level.as_str()) {
        return Err("Reasoning level is invalid".to_owned());
    }
    settings.ai.thinking_level = keep_level(
        &settings.ai.thinking_level,
        settings.ai.reasoning,
        settings.ai.supports_reasoning_effort,
        &settings.ai.thinking_levels,
    );
    // OpenRouter's address and dialect are not the user's to set, so they are corrected rather
    // than validated. A settings file hand-edited to point this driver somewhere else would send
    // the OpenRouter key to that address, and the catalogue parser to a server that answers a
    // different shape.
    if matches!(settings.ai.connection_type, AiConnectionType::Openrouter) {
        settings.ai.base_url = OPENROUTER_BASE_URL.to_owned();
        settings.ai.api = ApiDialect::OpenaiCompletions;
        settings.ai.chat_template_thinking = false;
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
        AiConnectionType::Openrouter => settings.ai.openrouter = active_profile,
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
    if !ALL_THINKING_LEVELS.contains(&connection.thinking_level.as_str()) {
        return Err("Reasoning level is invalid".to_owned());
    }
    connection.thinking_level = keep_level(
        &connection.thinking_level,
        connection.reasoning,
        connection.supports_reasoning_effort,
        &connection.thinking_levels,
    );
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
    entry_in_a_store(username)?.ok_or_else(|| NO_CREDENTIAL_STORE.to_owned())
}

/// What a machine with no credential store at all is reported as: `Ok(None)`.
///
/// A GitHub runner has no Secret Service, so `Entry::new` fails before any entry is looked at —
/// the keyring crate registers no default store and says so. Every reader turned that into an
/// error, and a turn reads three credentials, so on such a machine *every* AI turn ended as "The
/// AI response could not be completed." even with a local model that needs no key at all. The
/// packaged journey has failed on exactly this since it started running.
///
/// No store is not a failed read: it is a machine where nothing was ever saved, which is what
/// `None` already means everywhere below. A store that exists and refuses — locked, denied, an
/// entry that will not decode — still errors, because that is a key the user did save and cannot
/// get back.
fn entry_in_a_store(username: &str) -> Result<Option<Entry>, String> {
    let _initialization = KEYRING_INITIALIZATION
        .lock()
        .map_err(|_| "The credential-store initialization lock is poisoned".to_owned())?;
    match Entry::new(API_KEY_SERVICE, username) {
        Ok(entry) => Ok(Some(entry)),
        // The keyring crate builds the platform store on the first `Entry::new` of the process and
        // never tries again, so the first failure carries the platform's own words and the second
        // call says what was left behind: `NoDefaultStore` means nothing was, and there is nowhere
        // on this machine to keep a credential. A store that did register and refused this entry —
        // locked, prompted, denied — fails the same way twice and stays an error.
        Err(first) => match Entry::new(API_KEY_SERVICE, username) {
            Ok(entry) => Ok(Some(entry)),
            Err(KeyringError::NoDefaultStore) => Ok(None),
            Err(_) => Err(format!(
                "Could not access the operating system credential store: {first}"
            )),
        },
    }
}

/// What saving says when there is nowhere to save to. Reading answers `None` instead.
const NO_CREDENTIAL_STORE: &str = "This machine has no credential store, so Gofer cannot keep a key on it. On Linux that is a \
     Secret Service provider — GNOME Keyring or KWallet — and Gofer needs one running to hold a \
     key.";

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
        let Some(entry) = entry_in_a_store(API_KEY_USERNAME)? else {
            return Ok(None);
        };
        match entry.get_password() {
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

/// OpenRouter's key, or nothing when the user has not set one.
///
/// Its own slot, not `ai-default`. Two key-based drivers sharing one entry means configuring the
/// second wipes the first, and — worse — a key meant for openrouter.ai being sent as bearer to
/// whatever `http://127.0.0.1:8080` happens to be.
pub(crate) fn stored_openrouter_api_key() -> Result<Option<String>, String> {
    let Some(entry) = entry_in_a_store(OPENROUTER_KEY_USERNAME)? else {
        return Ok(None);
    };
    match entry.get_password() {
        Ok(value) if value.trim().is_empty() => Ok(None),
        Ok(value) => Ok(Some(value)),
        Err(KeyringError::NoEntry) => Ok(None),
        Err(error) => Err(format!("Could not read the OpenRouter API key: {error}")),
    }
}

/// Stores OpenRouter's key, or removes it when the text is blank. The same rule as the Brave key:
/// an empty entry left behind reads as a configured key that every request is then rejected for.
pub(crate) fn store_openrouter_api_key(key: &str) -> Result<(), String> {
    let entry = credential_entry(OPENROUTER_KEY_USERNAME)?;
    if key.trim().is_empty() {
        return match entry.delete_credential() {
            Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
            Err(error) => Err(format!("Could not remove the OpenRouter API key: {error}")),
        };
    }
    entry
        .set_password(key)
        .map_err(|error| format!("Could not store the OpenRouter API key: {error}"))
}

/// The Brave Search key, or nothing when the user has not set one.
///
/// In the keyring rather than in `settings.json`, on the same reasoning as the AI key: the settings
/// file is plain text a person may copy, diff or paste into a bug report, and a search key is a
/// credential. Nothing is an ordinary state, not a fault — the two other engines need no key, and
/// `web_search` says so itself when Brave is chosen without one.
pub(crate) fn stored_brave_api_key() -> Result<Option<String>, String> {
    let Some(entry) = entry_in_a_store(BRAVE_KEY_USERNAME)? else {
        return Ok(None);
    };
    match entry.get_password() {
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
    let Some(entry) = entry_in_a_store(CHATGPT_CREDENTIAL_USERNAME)? else {
        return Ok(None);
    };
    let value = match entry.get_password() {
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
            has_openrouter_api_key: false,
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
            has_openrouter_api_key: stored_openrouter_api_key().ok().flatten().is_some(),
            credential_store_error: None,
        },
        Err(error) => SettingsResponse {
            settings,
            has_api_key: false,
            has_chat_gpt_credential: false,
            has_brave_api_key: false,
            has_openrouter_api_key: false,
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

/// The same three-way rule again, against the OpenRouter entry. Blank clears, as with Brave.
pub(crate) fn apply_openrouter_key_update(update: &ApiKeyUpdate) -> Result<(), String> {
    match update {
        ApiKeyUpdate::Keep => Ok(()),
        ApiKeyUpdate::Set { value } => {
            if value.len() > MAX_API_KEY_BYTES {
                return Err("API keys cannot exceed 16 KiB".to_owned());
            }
            store_openrouter_api_key(value)
        }
        ApiKeyUpdate::Clear => store_openrouter_api_key(""),
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

/// The same three-way read against OpenRouter's slot. Separate from `resolve_api_key` because the
/// stored value it falls back to is a different credential in a different keyring entry.
fn resolve_openrouter_api_key(update: &ApiKeyUpdate) -> Result<Option<String>, String> {
    match update {
        ApiKeyUpdate::Keep => Ok(stored_openrouter_api_key().unwrap_or(None)),
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
            openrouter_api_key: ApiKeyUpdate::Keep,
        }
    }

    /// A response may not be as long as the whole conversation.
    ///
    /// The default used to be the context window, which is no ceiling: a model that will not stop
    /// fills the turn with one answer and leaves nothing to recover in. Measured over fifteen live
    /// turns against the local Qwen3.6-27B the longest real response was 810 tokens; two runaways
    /// decoded 89,311 and past 48,000.
    #[test]
    fn a_response_may_not_be_as_long_as_the_whole_window() {
        let shipped = AiSettings::default();
        assert!(
            shipped.max_tokens < shipped.context_window / 4,
            "the output ceiling has to be a ceiling: {} of {}",
            shipped.max_tokens,
            shipped.context_window
        );
        assert!(
            shipped.max_tokens >= 8_192,
            "and still hold a whole file in one write: {}",
            shipped.max_tokens
        );
        // And it fits inside the room compaction leaves above its own line, which is what the
        // summary request and the answer after it share. An answer that can eat the whole reserve
        // is the failure this ceiling exists for.
        let reserve = shipped.context_window
            - (shipped.context_window * u64::from(default_compaction_percent())) / 100;
        assert!(
            shipped.max_tokens <= reserve,
            "the ceiling has to fit the compaction reserve: {} in {reserve}",
            shipped.max_tokens
        );

        // A stored ceiling is the user's, and reading their settings never replaces it.
        let chosen: AiSettings = serde_json::from_value(serde_json::json!({
            "connectionType": "openai-compatible",
            "name": "Local AI",
            "baseUrl": "http://127.0.0.1:8080/v1",
            "model": "m.gguf",
            "api": "openai-completions",
            "maxTokens": 120_064
        }))
        .expect("settings");
        assert_eq!(chosen.max_tokens, 120_064);
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
            docs_expansion_connection(&AiSettings::default(), Some("k".to_owned()), None, None)
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
            thinking_levels: Vec::new(),
            input: default_model_input(),
            thinking_level: "low".to_owned(),
        };
        let mut own = AiSettings::default();
        own.subagent.connection = Some(local_child.clone());
        let child = docs_expansion_connection(&own, None, None, None)
            .expect("a local sub-agent is reachable");
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
        let followed = docs_expansion_connection(
            &chatgpt,
            Some("k".to_owned()),
            None,
            Some(credential.clone()),
        )
        .expect("a ChatGPT sub-agent is followed to ChatGPT");
        assert_eq!(followed.connection_type, "openai-codex");
        assert_eq!(followed.model, "gpt-5.6-luna");
        assert_eq!(followed.base_url, default_chatgpt_profile().base_url);
        assert_eq!(followed.oauth_credential, Some(credential));
        // The local server's key is not ChatGPT's, and must not travel with a ChatGPT connection.
        assert_eq!(followed.api_key, None);

        assert_eq!(
            docs_expansion_connection(&chatgpt, None, None, None),
            None,
            "a ChatGPT sub-agent with no stored credential has nothing to authenticate with"
        );

        let codex_only = AiSettings {
            connection_type: AiConnectionType::OpenaiCodex,
            local: None,
            ..AiSettings::default()
        };
        assert_eq!(
            docs_expansion_connection(&codex_only, None, None, None),
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
            thinking_levels: Vec::new(),
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
            thinking_levels: Vec::new(),
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

    /// Every rule in `openrouter_model_options`, against the shapes the live catalogue really has.
    ///
    /// The fixture is trimmed from a real response. Each model in it is one of the cases that was
    /// measured across all 422: a plain one, a null `max_completion_tokens` (52 of them), a
    /// mandatory reasoner whose efforts never include `none` (90), one that lists `none` because
    /// its thinking can be switched off, one with no `tools` (70), and one that takes video.
    #[test]
    fn the_openrouter_catalog_is_read_as_gofer_states_a_model() {
        let catalog: OpenrouterModelsResponse = serde_json::from_str(
            r#"{"data": [
                {
                    "id": "nvidia/nemotron-3.5-lightning:free",
                    "name": "NVIDIA: Nemotron 3.5 Lightning",
                    "context_length": 1000000,
                    "architecture": {"input_modalities": ["text"]},
                    "top_provider": {"max_completion_tokens": 131072},
                    "supported_parameters": ["tools", "max_tokens"]
                },
                {
                    "id": "no-ceiling/model",
                    "name": "No Ceiling",
                    "context_length": 256000,
                    "architecture": {"input_modalities": ["text", "image"]},
                    "top_provider": {"max_completion_tokens": null},
                    "supported_parameters": ["tools"]
                },
                {
                    "id": "always/thinks",
                    "name": "Always Thinks",
                    "context_length": 200000,
                    "architecture": {"input_modalities": ["text"]},
                    "top_provider": {"max_completion_tokens": 64000},
                    "supported_parameters": ["tools", "reasoning", "reasoning_effort"],
                    "reasoning": {
                        "mandatory": true,
                        "supported_efforts": ["xhigh", "high", "medium", "low", "minimal"],
                        "default_effort": "medium"
                    }
                },
                {
                    "id": "can/stop-thinking",
                    "name": "Can Stop Thinking",
                    "context_length": 262144,
                    "architecture": {"input_modalities": ["text", "video", "file"]},
                    "top_provider": {"max_completion_tokens": 32000},
                    "supported_parameters": ["tools", "reasoning", "reasoning_effort"],
                    "reasoning": {
                        "mandatory": false,
                        "supported_efforts": ["max", "high", "low", "none"],
                        "default_effort": "high"
                    }
                },
                {
                    "id": "cannot/call-tools",
                    "name": "Cannot Call Tools",
                    "context_length": 128000,
                    "architecture": {"input_modalities": ["text"]},
                    "top_provider": {"max_completion_tokens": 4096},
                    "supported_parameters": ["max_tokens", "temperature"]
                }
            ]}"#,
        )
        .expect("the catalogue fixture parses");

        let options = openrouter_model_options(catalog.data);
        let ids: Vec<&str> = options.iter().map(|o| o.id.as_str()).collect();
        // The model with no `tools` is gone. It could never have run a turn.
        assert_eq!(
            ids,
            [
                "nvidia/nemotron-3.5-lightning:free",
                "no-ceiling/model",
                "always/thinks",
                "can/stop-thinking"
            ]
        );

        let plain = &options[0];
        assert_eq!(plain.name, "NVIDIA: Nemotron 3.5 Lightning");
        assert_eq!(plain.context_window, 1_000_000);
        assert_eq!(plain.max_tokens, 131_072);
        assert!(!plain.reasoning);
        assert!(!plain.supports_reasoning_effort);
        assert!(plain.thinking_levels.is_empty());
        assert_eq!(plain.input, ["text"]);

        // A null ceiling falls back to the window rather than to zero, which would fail validation.
        assert_eq!(options[1].max_tokens, 256_000);
        assert_eq!(options[1].input, ["text", "image"]);

        // A mandatory reasoner names its efforts and never names `none`.
        let mandatory = &options[2];
        assert!(mandatory.reasoning);
        assert!(mandatory.supports_reasoning_effort);
        assert_eq!(
            mandatory.thinking_levels,
            ["xhigh", "high", "medium", "low", "minimal"]
        );

        // `none` is OpenRouter's word for "can be switched off", not an effort. `off` is prepended
        // by the menu itself, and passing `none` through would put a level in the settings file
        // that `ALL_THINKING_LEVELS` does not contain.
        let optional = &options[3];
        assert_eq!(optional.thinking_levels, ["max", "high", "low"]);
        // Pi types a model's input as text or image and nothing else. Video and file have nowhere
        // to go, and an empty list would fail validation.
        assert_eq!(optional.input, ["text"]);
    }

    /// OpenRouter's address is corrected, not trusted, and saving it leaves the others alone.
    #[test]
    fn an_openrouter_connection_is_pinned_and_kept_beside_the_others() {
        let mut settings = GoferSettings::default();
        settings.ai.connection_type = AiConnectionType::Openrouter;
        settings.ai.name = "OpenRouter".to_owned();
        settings.ai.model = "nvidia/nemotron-3.5-lightning:free".to_owned();
        // A hand-edited file pointing this driver at somebody else's server would send the
        // OpenRouter key there. It is put back rather than refused.
        settings.ai.base_url = "https://not-openrouter.example/v1".to_owned();
        settings.ai.api = ApiDialect::OpenaiCodexResponses;
        settings.ai.chat_template_thinking = true;

        let saved = validate_settings(settings).expect("an OpenRouter connection is valid");
        assert_eq!(saved.ai.base_url, OPENROUTER_BASE_URL);
        assert_eq!(saved.ai.api, ApiDialect::OpenaiCompletions);
        assert!(!saved.ai.chat_template_thinking);
        // Mirrored into its own slot, and the local one is untouched.
        assert_eq!(
            saved.ai.openrouter.model,
            "nvidia/nemotron-3.5-lightning:free"
        );
        assert_eq!(saved.ai.local, None);
        assert_eq!(saved.ai.chatgpt.model, default_chatgpt_profile().model);
    }

    /// The sub-agent may run on OpenRouter, and it takes OpenRouter's key rather than the AI one.
    #[test]
    fn a_subagent_on_openrouter_is_reached_with_its_own_key() {
        let mut settings = AiSettings::default();
        settings.subagent.connection = Some(SubagentConnection {
            connection_type: AiConnectionType::Openrouter,
            model: "z-ai/glm-5.2:free".to_owned(),
            model_name: "GLM 5.2".to_owned(),
            context_window: 256_000,
            max_tokens: 8_000,
            reasoning: true,
            supports_reasoning_effort: true,
            thinking_levels: vec!["xhigh".to_owned(), "high".to_owned()],
            input: vec!["text".to_owned()],
            thinking_level: "high".to_owned(),
        });

        let connection = docs_expansion_connection(
            &settings,
            Some("local-key".to_owned()),
            Some("openrouter-key".to_owned()),
            None,
        )
        .expect("an OpenRouter child is reachable");

        assert_eq!(connection.connection_type, "openrouter");
        assert_eq!(connection.base_url, OPENROUTER_BASE_URL);
        assert_eq!(connection.model, "z-ai/glm-5.2:free");
        // The local server's key must never reach openrouter.ai, and this is where they cross.
        assert_eq!(connection.api_key.as_deref(), Some("openrouter-key"));
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
            None,
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
            None,
        );
        assert!(!unknown[0].reasoning);
        assert!(!unknown[0].supports_reasoning_effort);
    }

    /// The server outranks the catalogue, in every copy, including the one the user picked.
    ///
    /// This is the shape the user hit. The catalogue names one `.gguf`; the host was restarted with
    /// a different one. Nothing named the loaded file, so its *server's* flag answered for it — and
    /// a server-wide flag is a fact about the address, not about the model at it. The menu went on
    /// offering seven reasoning levels to a template that has none.
    #[test]
    fn the_loaded_model_outranks_every_written_copy_of_it() {
        let mut ai = settings("http://127.0.0.1:8080/v1", "old.gguf").ai;
        ai.model_name = "Old Model".to_owned();
        ai.reasoning = true;
        ai.supports_reasoning_effort = true;
        ai.thinking_level = "medium".to_owned();
        ai.max_tokens = 200_000;
        ai.local = Some(profile_of(&ai));
        ai.subagent.connection = Some(SubagentConnection {
            connection_type: AiConnectionType::OpenaiCompatible,
            model: "old.gguf".to_owned(),
            model_name: "Old Model".to_owned(),
            context_window: 200_000,
            max_tokens: 200_000,
            reasoning: true,
            supports_reasoning_effort: true,
            thinking_levels: Vec::new(),
            input: vec!["text".to_owned(), "image".to_owned()],
            thinking_level: "high".to_owned(),
        });

        let served = HashMap::from([(
            "http://127.0.0.1:8080/v1".to_owned(),
            ServedModel {
                id: "/models/new.gguf".to_owned(),
                context_window: Some(120_064),
                reasoning: true,
                efforts: Vec::new(),
                input: Some(vec!["text".to_owned()]),
                sole: true,
            },
        )]);
        resolve_model_facts(&mut ai, &PiCatalog::default(), &served);

        let local = ai.local.as_ref().expect("the saved local profile");
        let child = ai.subagent.connection.as_ref().expect("the sub-agent");
        for (model, name, effort, level, window, tokens, input) in [
            (
                &ai.model,
                &ai.model_name,
                ai.supports_reasoning_effort,
                &ai.thinking_level,
                ai.context_window,
                ai.max_tokens,
                &ai.input,
            ),
            (
                &local.model,
                &local.model_name,
                local.supports_reasoning_effort,
                &local.thinking_level,
                local.context_window,
                local.max_tokens,
                &local.input,
            ),
            (
                &child.model,
                &child.model_name,
                child.supports_reasoning_effort,
                &child.thinking_level,
                child.context_window,
                child.max_tokens,
                &child.input,
            ),
        ] {
            assert_eq!(model, "/models/new.gguf", "the id the server answers to");
            assert_eq!(name, "/models/new.gguf");
            assert!(!effort, "the loaded template takes no effort");
            assert_eq!(level, "off", "so there is no level to be asked at");
            assert_eq!(window, 120_064, "the window the host was started with");
            assert_eq!(tokens, 120_064, "clamped into it");
            assert_eq!(input, &["text".to_owned()], "and no pictures");
        }
        assert!(
            ai.reasoning,
            "it still thinks, it just cannot be told how hard"
        );
    }

    /// A server with more than one model does not get to choose which one the user is on.
    ///
    /// llama.cpp has a router mode that serves a whole directory. `/props` describes one of them,
    /// and it is not necessarily the one that was picked — so its answer applies to that model and
    /// to no other.
    #[test]
    fn a_router_answers_only_for_the_model_it_named() {
        let mut ai = settings("http://127.0.0.1:8080/v1", "chosen.gguf").ai;
        ai.reasoning = true;
        ai.supports_reasoning_effort = true;
        ai.thinking_level = "medium".to_owned();
        let before = ai.clone();
        let served = HashMap::from([(
            "http://127.0.0.1:8080/v1".to_owned(),
            ServedModel {
                id: "another.gguf".to_owned(),
                context_window: Some(4_096),
                reasoning: false,
                efforts: Vec::new(),
                input: Some(vec!["text".to_owned()]),
                sole: false,
            },
        )]);
        resolve_model_facts(&mut ai, &PiCatalog::default(), &served);
        assert_eq!(ai, before, "another model's facts are not this model's");
    }

    /// A server that does not answer `/props` leaves every written copy exactly as it was.
    #[test]
    fn a_server_with_nothing_to_say_changes_nothing() {
        let mut ai = settings("http://127.0.0.1:8080/v1", "old.gguf").ai;
        ai.reasoning = true;
        ai.supports_reasoning_effort = true;
        ai.thinking_level = "medium".to_owned();
        let before = ai.clone();
        resolve_model_facts(&mut ai, &PiCatalog::default(), &HashMap::new());
        assert_eq!(ai, before);
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
            thinking_levels: Vec::new(),
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

/// What a settings read costs when the address in it does not answer.
#[cfg(test)]
mod probe_cost_tests {
    use super::*;
    use std::net::TcpListener;
    use std::thread;
    use std::time::Instant;
    use tempfile::TempDir;

    /// An address that accepts a connection and then says nothing at all — the one case the probe
    /// timeout exists to bound. A VPN that dropped, a container still starting, a port taken by
    /// something else entirely.
    fn black_hole() -> String {
        let listener = TcpListener::bind("127.0.0.1:0").expect("a port");
        let address = listener.local_addr().expect("an address").to_string();
        thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { continue };
                // Held, never answered, never closed.
                thread::sleep(std::time::Duration::from_secs(30));
                drop(stream);
            }
        });
        format!("http://{address}/v1")
    }

    fn settings_at(directory: &TempDir, base_url: &str) -> PathBuf {
        let path = directory.path().join("settings.json");
        let mut settings = GoferSettings::default();
        settings.ai.connection_type = AiConnectionType::OpenaiCompatible;
        settings.ai.base_url = base_url.to_owned();
        settings.ai.local = None;
        fs::write(
            &path,
            serde_json::to_string(&settings).expect("settings as json"),
        )
        .expect("write settings");
        path
    }

    /**
    The Godot rules are read on paths that are hot, and they cost a round trip they never use.

    `read_settings` asks the model server what it is serving on every read, and the answer only ever
    changes fields under `ai`. Every tool the model calls goes through `ai_tools::dispatch`, which
    reads the settings for `settings.godot` alone — so a server that accepts and then says nothing
    stalls a Godot operation for the whole probe timeout, once per cache period, forever.
    */
    #[test]
    fn reading_the_godot_rules_never_waits_on_a_model_server() {
        let directory = TempDir::new().expect("temporary directory");
        let path = settings_at(&directory, &black_hole());

        let started = Instant::now();
        let rules = read_settings_unprobed_from_path(&path).expect("read settings");
        let elapsed = started.elapsed();

        assert_eq!(rules.godot, GodotSettings::default());
        assert!(
            elapsed < crate::model_server::PROBE_TIMEOUT,
            "waited {elapsed:?} for rules that no server has a say in"
        );
    }

    /// And the read that does want the served model still pays for it, so the two are not the same
    /// call by another name.
    #[test]
    fn the_read_that_wants_the_served_model_still_asks_for_it() {
        let directory = TempDir::new().expect("temporary directory");
        let path = settings_at(&directory, &black_hole());

        let started = Instant::now();
        read_settings_from_path(&path).expect("read settings");

        assert!(
            started.elapsed() >= crate::model_server::PROBE_TIMEOUT,
            "the probe was skipped on the path that needs it"
        );
    }
}

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
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager, Runtime};

use crate::model_server::ServedModel;

mod catalogue;
mod legacy;
// Only `mod tests` reads the rest of it: the catalogue's per-driver decisions are the parent's
// tests, and moving 2,800 lines of them was not part of the split.
#[cfg(test)]
use catalogue::*;
pub(crate) use catalogue::{
    AI_HEALTH_TIMEOUT, AI_REQUEST_TIMEOUT, list_ai_models_with, run_connection_test,
};
mod secrets;
use legacy::*;
// Imported rather than re-exported: `mod tests` reads these through `use super::*`, and a private
// `use` is visible to a module's descendants. The names the rest of the crate calls are re-exported
// below, by name, so the crate's view of this module does not change with the split.
use secrets::*;
pub(crate) use secrets::{
    Secret, Secrets, SystemSecrets, apply_saved_secrets, clear_chatgpt_credential,
    restore_saved_secrets, settings_response, store_chatgpt_credential, stored_chatgpt_credential,
};

/// The one service every secret is kept under. Which of them a slot holds is `Secret::username`.
const API_KEY_SERVICE: &str = "com.gofer.desktop";
/// OpenRouter's address, which the user never types. Mirrors `OPENROUTER_BASE_URL` in settings.ts.
const OPENROUTER_BASE_URL: &str = "https://openrouter.ai/api/v1";
/// Cerebras' address, which the user never types. Mirrors `CEREBRAS_BASE_URL` in settings.ts.
const CEREBRAS_BASE_URL: &str = "https://api.cerebras.ai/v1";

const SETTINGS_FILE_NAME: &str = "settings.json";

const SETTINGS_VERSION: u32 = 1;

/// The levels a model with named efforts can be asked at. The menu, not the validation set: it is
/// `EFFORT_LEVELS` in `settings.ts` too, and neither of them holds `on`.
const EFFORT_LEVELS: &[&str] = &["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/// `off` as an owned value, so `thinking_levels` can hand back a slice of it or an empty one.
static OFF_LEVEL: std::sync::LazyLock<String> = std::sync::LazyLock::new(|| "off".to_owned());

/// Every level a settings file may legally name. `on` belongs to a model that thinks and has no
/// efforts to name; the rest belong to one that has. Which of them a given model actually offers is
/// `thinking_levels`, and this is only what is not a typo.
const EVERY_LEVEL: &[&str] = &[
    "off", "on", "minimal", "low", "medium", "high", "xhigh", "max",
];

/// Every word that names an effort, which is `EVERY_LEVEL` without the two that do not.
///
/// `off` is the absence of an effort and `on` belongs to a template with none to name, so neither
/// can arrive from a catalogue. The same list, in the same order, is `KNOWN_EFFORTS` in
/// `model_server.rs` and in `thinking-level.mjs`, and `check-command-surface.mjs` holds all five
/// copies to each other rather than leaving this sentence to be believed.
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

/// What the user chose: which driver is live, the connections they configured, and the tuning.
///
/// The live connection is stored once, in `connections`, under the driver that runs it. It used to
/// be stored twice — flattened here and mirrored into a slot — and the invariant "flat is the
/// original, slot is the copy" had to be restated by hand at every write and in three languages.
/// The three copies of that paragraph had already drifted: Rust matched the driver exactly while
/// the worker treated anything that was not ChatGPT or OpenRouter as the local one.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", from = "AiSettingsFile")]
pub(crate) struct AiSettings {
    /// Which of the connections below is live. The only thing that decides.
    pub(crate) connection_type: AiConnectionType,
    /// Every connection this settings file holds, by the driver that runs it.
    ///
    /// One entry per driver and no second copy of any of them, so "which one is live" is a lookup
    /// rather than a rule. A driver with no entry has never been configured — which a ChatGPT-only
    /// install's local driver never is — and a driver with no entry is not offered in the picker.
    ///
    /// Ordered rather than hashed so the file this is written into does not shuffle its own keys
    /// between two saves that changed nothing.
    connections: BTreeMap<AiConnectionType, AiConnectionProfile>,
    pub(crate) max_retries: u32,
    pub(crate) timeout_ms: u64,
    pub(crate) compaction_percent: u32,
    pub(crate) subagent: SubagentSettings,
    pub(crate) web: WebSettings,
}

/// One connection and the model chosen on it: an address half, and a `ModelChoice`.
///
/// The split is the point. The address is the connection's — where it is, which dialect it speaks,
/// how thinking is turned on there — and the model half is what a catalogue can answer for and a
/// sub-agent can override. `SubagentConnection` borrows the first and replaces the second, which is
/// one field rather than nine `map_or` lines.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", from = "AiConnectionProfileFile")]
pub(crate) struct AiConnectionProfile {
    name: String,
    base_url: String,
    api: ApiDialect,
    /// Whether thinking is turned on by a chat-template argument rather than by an effort field.
    ///
    /// True for a llama.cpp host: it takes `chat_template_kwargs.enable_thinking` and silently
    /// ignores `reasoning_effort`, so a build that sent only the effort field never turned thinking
    /// on or off for one of these at all. Derived from the server, never typed.
    chat_template_thinking: bool,
    model: ModelChoice,
}

/// A model, as the user chose it: which one, what it can do, and the level it is asked at.
///
/// The same nine facts wherever a model is chosen — on a connection, or by the sub-agent — so the
/// rules that correct them are written once. Everything but the level is the model's own and is
/// re-derived from the catalogue and the server on every read; the level is the user's.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelChoice {
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default = "default_context_window")]
    context_window: u64,
    #[serde(default = "default_max_tokens")]
    max_tokens: u64,
    #[serde(default)]
    reasoning: bool,
    #[serde(default)]
    supports_reasoning_effort: bool,
    /// The efforts this model's server said it will accept, or empty when nothing has said.
    ///
    /// The menu, in other words. Empty is not "none" — it is "unasked", and the reasoning flags
    /// answer instead. A list rather than a flag because a chat template refuses the efforts it
    /// does not know, loudly: one Qwen build accepts three of Gofer's seven levels and answers the
    /// other two with HTTP 500 on every request of the turn.
    #[serde(default)]
    thinking_levels: Vec<String>,
    /// Whether this model refuses to be asked not to think, which is what makes `off` unavailable
    /// rather than merely unhelpful. See `OpenrouterReasoning::mandatory`.
    ///
    /// Defaulted, so a settings file written before this field reads as "not mandatory" — which is
    /// what every local server is, and what a hosted model is until its catalogue is read again.
    #[serde(default)]
    reasoning_mandatory: bool,
    #[serde(default = "default_model_input")]
    input: Vec<String>,
    /// The word this model answers to for "stop thinking", where it has one. See
    /// `CerebrasModel::off_effort`.
    ///
    /// Defaulted and skipped when absent, so every settings file written before this field — and
    /// every model on every other driver — reads as "no such word", which sends no effort field at
    /// all. That is what `off` has always meant here.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    off_effort: Option<String>,
    #[serde(default = "default_thinking_level")]
    thinking_level: String,
}

impl AiSettings {
    /// The connection the live driver runs on, or nothing when that driver has none.
    pub(crate) fn connection(&self) -> Option<&AiConnectionProfile> {
        self.connection_for(self.connection_type)
    }

    /// Which stored connection serves a driver. One lookup, and the only one there is.
    pub(crate) fn connection_for(&self, driver: AiConnectionType) -> Option<&AiConnectionProfile> {
        self.connections.get(&driver)
    }

    /// The shipped settings, pointed at one connection with one model on it, for a suite that
    /// brings its own. Which driver answers, where it is, which model, and how hard it is asked to
    /// think is all an acceptance run chooses; the rest of the turn is the one the application
    /// composes. A failed request is never asked again, because a suite counts errors.
    ///
    /// `base_url` is optional because only one of the three drivers has an address a run picks.
    /// ChatGPT's is a constant and OpenRouter's is a constant; overwriting either from a default
    /// meant for a local server is how a run ends up asking `127.0.0.1` for a subscription model.
    #[cfg(all(test, feature = "godot-acceptance"))]
    pub(crate) fn served_by(
        driver: AiConnectionType,
        base_url: Option<String>,
        model: String,
        thinking_level: Option<String>,
    ) -> Self {
        let mut settings = Self {
            connection_type: driver,
            max_retries: 0,
            ..Self::default()
        };
        if let Some(connection) = settings.connections.get_mut(&driver) {
            if let Some(base_url) = base_url {
                connection.base_url = base_url;
            }
            // Named before the level is applied, because naming a model replaces the whole row and
            // the level is the one fact on it a run chose.
            connection.model.name.clone_from(&model);
            if let Some(facts) = shipped_model_facts(driver, &model) {
                connection.model.name = facts.name;
                connection.model.context_window = facts.context_window;
                connection.model.max_tokens = facts.max_tokens;
                connection.model.reasoning = facts.reasoning;
                connection.model.supports_reasoning_effort = facts.supports_reasoning_effort;
                connection.model.reasoning_mandatory = facts.reasoning_mandatory;
                connection.model.thinking_levels = facts.thinking_levels;
                connection.model.input = facts.input;
                connection.model.off_effort = facts.off_effort;
            }
            connection.model.id = model;
            if let Some(level) = thinking_level {
                // A named level has to reach the wire, and for a llama.cpp host it only reaches it
                // as a chat-template argument: the server takes `chat_template_kwargs`, ignores
                // `reasoning_effort` without a word, and `default_local_profile` starts every flag
                // that carries one at `false` because the application derives them from `/props`
                // and a suite has no `/props` read to derive them from.
                //
                // Measured through a logging proxy on 2026-08-27: a live turn started with
                // `GOFER_LIVE_THINKING=medium` sent a request body carrying `model`, `messages`,
                // `stream`, `stream_options`, `store`, `max_completion_tokens` and `tools`, and no
                // thinking field of any kind. It thought at whatever the server was started with,
                // which made the knob look like it worked and made any A/B across levels a
                // comparison of one level with itself.
                connection.chat_template_thinking = driver == AiConnectionType::OpenaiCompatible;
                connection.model.reasoning = true;
                connection.model.supports_reasoning_effort = true;
                // The level a run named is the only one it offers, so pi-ai's own clamp cannot
                // move it: `piThinkingLevelMap` maps a named effort to itself and everything else
                // to null, and an unmapped level is silently rewritten — `xhigh` went out as
                // `high` against a template that raises on anything but its own three words. A
                // level that is not one of the six is left unlisted, because listing a word pi-ai
                // has no effort for clamps every request to `off`.
                if NAMED_EFFORTS.contains(&level.as_str()) {
                    connection.model.thinking_levels = vec![level.clone()];
                }
                connection.model.thinking_level = level;
            }
        }
        settings
    }

    /// The same settings with the active connection's model declared to take text and nothing else.
    ///
    /// A local server answers `/props` with what it can take, and `parse_props` believes it — which
    /// is right, because nothing else knows. A server that advertises `vision` and cannot do it is
    /// therefore sent a frame, and one llama.cpp build here **dies on every image request**: a
    /// 16x16 PNG closed the connection and restarted the process, twice out of two, where two
    /// text requests either side of them answered normally. Inside a turn that is the whole turn —
    /// `godot_runtime run` answers with a frame, the request carrying it kills the server, and each
    /// of the ten retries resends the same frame and kills it again.
    ///
    /// A suite cannot fix that server, and it should not have to stop measuring everything else
    /// because of it. `withoutPictures` already exists for a model with no eyes, so saying the
    /// model has none is all this needs to be — and, unlike the user's settings file, it is written
    /// down in the run rather than inherited from a machine.
    #[cfg(all(test, feature = "godot-acceptance"))]
    pub(crate) fn without_pictures(mut self) -> Self {
        if let Some(connection) = self.connections.get_mut(&self.connection_type) {
            connection.model.input = vec!["text".to_owned()];
        }
        self
    }
}

/// Where the live connection points and which model it names, as one line for a report.
///
/// Here rather than at the call site because the caller has a health check to write and no reason
/// to know that a settings file holds more than one connection.
pub(crate) fn active_endpoint(ai: &AiSettings) -> (String, String) {
    ai.connection().map_or_else(
        || (String::new(), String::new()),
        |connection| (connection.base_url.clone(), connection.model.id.clone()),
    )
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
#[serde(rename_all = "camelCase", from = "SubagentConnectionFile")]
pub(crate) struct SubagentConnection {
    /// Which stored connection serves this model. Independent of the parent's choice.
    pub(crate) connection_type: AiConnectionType,
    /// The model half of that connection, replaced. The address half is borrowed as it stands.
    pub(crate) model: ModelChoice,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum AiConnectionType {
    OpenaiCompatible,
    OpenaiCodex,
    Openrouter,
    Cerebras,
}

impl AiConnectionType {
    /// The one stored key this driver authenticates with, or `None` when it takes none.
    ///
    /// A key sent to the wrong address is a key handed to a machine that was never meant to see
    /// it, so this is the only place the pairing is written down. ChatGPT is the `None`: it
    /// authenticates with an OAuth credential and reads no key at all, which is why a missing
    /// credential there reads as "Sign in with ChatGPT" rather than as an error.
    ///
    /// `Credentials::for_driver` is this rule inverted — one key placed into the slot its driver
    /// reads — and the acceptance suites are what hold the two to each other.
    pub(crate) fn key_from(
        self,
        api_key: Option<String>,
        openrouter_api_key: Option<String>,
        cerebras_api_key: Option<String>,
    ) -> Option<String> {
        match self {
            Self::OpenaiCodex => None,
            Self::OpenaiCompatible => api_key,
            Self::Openrouter => openrouter_api_key,
            Self::Cerebras => cerebras_api_key,
        }
    }
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
    has_cerebras_api_key: bool,
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
    /// Cerebras' key, by the same three-way rule, into its own keyring slot again.
    #[serde(default)]
    pub(crate) cerebras_api_key: ApiKeyUpdate,
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
    /// Whether `off` is a level this model has. See `OpenrouterReasoning::mandatory`.
    #[serde(default)]
    reasoning_mandatory: bool,
    /// The efforts this model's own server named, or empty when nothing named any. See
    /// `AiSettings::thinking_levels` — this is the same list, on its way to the settings page.
    #[serde(default)]
    thinking_levels: Vec<String>,
    input: Vec<String>,
    /// The word this model answers to for "stop thinking", where its catalogue named one.
    ///
    /// Absent for every driver but Cerebras, whose shipped table is the only catalogue that carries
    /// it — so `off` keeps meaning "send no effort field" everywhere it always did. See
    /// `CerebrasModel::off_effort`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    off_effort: Option<String>,
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
    /// Whether this model refuses to be asked not to think.
    ///
    /// 90 of the 287 reasoning models the catalogue listed on 2026-08-25 set this, and they are not
    /// the obscure ones: GPT-5, Gemini 3.x, Grok 4.x, Claude Fable 5, DeepSeek R1, gpt-oss. Sent
    /// `reasoning: {enabled: false}` — which is what the `off` level resolves to — every one of them
    /// answers HTTP 400 `Reasoning is mandatory for this endpoint and cannot be disabled`.
    #[serde(default)]
    mandatory: bool,
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

/// The same ceiling, for a window this build did not pick.
///
/// [`default_max_tokens`] is one number chosen for one window. A remote catalogue names hundreds of
/// windows and names its own ceilings beside them, and those ceilings are not ceilings: measured
/// across OpenRouter's 348 tool-capable models on 2026-08-26, **188** name an output ceiling larger
/// than the room compaction leaves above its own line, and three name the whole window.
///
/// Taken as written they are the runaway that doc comment describes, and one more that only a paid
/// endpoint has: OpenRouter reserves credit for `max_tokens` before it generates anything, so the
/// ceiling alone decides whether the request is affordable. `x-ai/grok-4.6` at its declared 450,000
/// is *"you requested up to 449998 tokens, but can only afford 5295"*. The same model asked for a
/// sentence would have cost a fraction of a cent.
///
/// So a declared ceiling is honoured only as far as it fits: never past the compaction reserve,
/// never past a quarter of the window, and never zero, which [`validate_settings`] refuses.
fn ceiling_within(context_window: u64, declared: Option<u64>) -> u64 {
    let reserve = context_window - (context_window * u64::from(default_compaction_percent())) / 100;
    // The reserve is 14% of the window, and below about 117,000 that is less than one whole
    // GDScript file — a `godot_script save` cut off mid-file for want of a ceiling nobody chose.
    // So the cap is raised to what [`default_max_tokens`] holds, as far as a quarter of the window
    // allows: past that the ceiling stops being a ceiling, which is the failure this exists for.
    // The floor lifts the *cap*, never a declared ceiling: a model that really stops at 4,096 is
    // one whose 4,096 has to survive, or every answer from it is an HTTP 400.
    let cap = reserve
        .min(context_window / 4)
        .max(default_max_tokens().min(context_window / 4));
    declared.unwrap_or(cap).min(cap).max(1)
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
            connections: default_connections(default_local_profile()),
            max_retries: default_max_retries(),
            timeout_ms: default_timeout_ms(),
            compaction_percent: default_compaction_percent(),
            subagent: SubagentSettings::default(),
            web: WebSettings::default(),
        }
    }
}

/// The four connections a settings file starts life with, around whichever local one is known.
///
/// The three hosted ones are always there for a reason the local one used to have to earn: a
/// driver with no connection is not offered in the picker, and a driver that is not offered can
/// never be selected in order to be configured. Every one of their addresses and dialects is a
/// constant, so there is nothing to wait for.
fn default_connections(
    local: AiConnectionProfile,
) -> BTreeMap<AiConnectionType, AiConnectionProfile> {
    BTreeMap::from([
        (AiConnectionType::OpenaiCompatible, local),
        (AiConnectionType::OpenaiCodex, default_chatgpt_profile()),
        (AiConnectionType::Openrouter, default_openrouter_profile()),
        (AiConnectionType::Cerebras, default_cerebras_profile()),
    ])
}

/// What a local connection is before Pi's catalogue or the server itself has said anything.
fn default_local_profile() -> AiConnectionProfile {
    AiConnectionProfile {
        name: "Local AI".to_owned(),
        base_url: "http://127.0.0.1:8080/v1".to_owned(),
        api: ApiDialect::OpenaiCompletions,
        chat_template_thinking: false,
        model: ModelChoice {
            id: "Qwen3.6-27B-UD-Q4_K_XL.gguf".to_owned(),
            name: "Qwen3.6 27B".to_owned(),
            context_window: default_context_window(),
            max_tokens: default_max_tokens(),
            reasoning: false,
            supports_reasoning_effort: false,
            reasoning_mandatory: false,
            thinking_levels: Vec::new(),
            input: default_model_input(),
            off_effort: None,
            thinking_level: default_thinking_level(),
        },
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
        api: ApiDialect::OpenaiCodexResponses,
        // ChatGPT takes a reasoning effort like any OpenAI endpoint. Nothing about a chat template
        // reaches it, and there is no `/props` behind that address to say otherwise.
        chat_template_thinking: false,
        model: ModelChoice {
            id: "gpt-5.6-terra".to_owned(),
            name: "GPT-5.6 Terra".to_owned(),
            context_window: 272_000,
            max_tokens: 128_000,
            reasoning: true,
            supports_reasoning_effort: true,
            // The Codex driver owns its own reasoning field; nothing here resolves to
            // `reasoning: {enabled: false}` on the wire.
            reasoning_mandatory: false,
            thinking_levels: Vec::new(),
            input: vec!["text".to_owned(), "image".to_owned()],
            off_effort: None,
            thinking_level: "high".to_owned(),
        },
    }
}

// GENERATED-BEGIN drivers sha256:f77507ddfffd3ea8
/// The word a driver is written down as, on the wire and in the settings file.
///
/// Never the display label: a file holding `OpenRouter` matches no driver this build
/// knows.
fn driver_id(driver: AiConnectionType) -> &'static str {
    match driver {
        AiConnectionType::OpenaiCompatible => "openai-compatible",
        AiConnectionType::OpenaiCodex => "openai-codex",
        AiConnectionType::Openrouter => "openrouter",
        AiConnectionType::Cerebras => "cerebras",
    }
}

/// Every driver a build knows, in the order the pickers offer them.
///
/// Read only by the test that round-trips each id through serde and back through
/// `driver_id`. Rust itself needs no list: the enum is the list, and the match above is
/// exhaustive over it.
#[cfg(test)]
const DRIVER_IDS: [&str; 4] = [
    "openai-compatible",
    "openai-codex",
    "openrouter",
    "cerebras",
];
// GENERATED-END drivers

/// OpenRouter, as it looks before the user has chosen anything.
///
/// The address is fixed and the dialect is the ordinary chat-completions one — measured, not
/// assumed: a real turn ran through this exact address and dialect and called a tool. The model is
/// a starting point, not a promise; the catalogue is read on every open and reconciles it.
fn default_openrouter_profile() -> AiConnectionProfile {
    AiConnectionProfile {
        name: "OpenRouter".to_owned(),
        base_url: OPENROUTER_BASE_URL.to_owned(),
        api: ApiDialect::OpenaiCompletions,
        // A chat template is a llama.cpp mechanism. There is no `/props` behind this address.
        chat_template_thinking: false,
        model: ModelChoice {
            id: "nvidia/nemotron-3.5-lightning:free".to_owned(),
            name: "NVIDIA: Nemotron 3.5 Lightning".to_owned(),
            context_window: 1_000_000,
            // A seed the first catalogue read replaces, so it is the safe one rather than the
            // model's own: this connection is billed, and OpenRouter reserves credit for the
            // ceiling before it generates a token. See `ceiling_within`.
            max_tokens: default_max_tokens(),
            reasoning: false,
            supports_reasoning_effort: false,
            // A seed, replaced by the first catalogue read. The model it names does not reason at
            // all, so it cannot be one that refuses to stop.
            reasoning_mandatory: false,
            thinking_levels: Vec::new(),
            input: vec!["text".to_owned()],
            off_effort: None,
            thinking_level: "off".to_owned(),
        },
    }
}

/// Cerebras, as it looks before the user has chosen anything.
///
/// The address is fixed and the dialect is the ordinary chat-completions one, measured against the
/// live endpoint rather than assumed. The model seed is the one of the two shipped models that
/// takes no image, because a seed that promises a modality is a seed that can be believed.
fn default_cerebras_profile() -> AiConnectionProfile {
    let seed = &CEREBRAS_MODELS[0];
    AiConnectionProfile {
        name: "Cerebras".to_owned(),
        base_url: CEREBRAS_BASE_URL.to_owned(),
        api: ApiDialect::OpenaiCompletions,
        // A chat template is a llama.cpp mechanism. There is no `/props` behind this address.
        chat_template_thinking: false,
        model: ModelChoice {
            id: seed.id.to_owned(),
            name: seed.name.to_owned(),
            context_window: seed.context_window,
            max_tokens: ceiling_within(seed.context_window, Some(seed.max_tokens)),
            reasoning: true,
            supports_reasoning_effort: true,
            reasoning_mandatory: seed.reasoning_mandatory,
            thinking_levels: seed.thinking_levels.iter().map(|&s| s.to_owned()).collect(),
            input: seed.input.iter().map(|&s| s.to_owned()).collect(),
            off_effort: seed.off_effort.map(str::to_owned),
            // Never `off` for a seed that cannot stop thinking: that is the one value which makes
            // its every request fail, reached by nothing more than opening a settings file that
            // had never named a level here. See `thinking_levels_for`.
            thinking_level: if seed.reasoning_mandatory {
                "medium"
            } else {
                "off"
            }
            .to_owned(),
        },
    }
}

/// What Gofer knows about one Cerebras model, which is everything its endpoint declines to say.
///
/// `GET /v1/models` there answers `{id, object, created, owned_by}` and no more — no window, no
/// output ceiling, no tool support, no reasoning. Every other driver reads those facts off a
/// catalogue. This one has none to read, so they are measured by hand and shipped, and the row is
/// emitted from `protocol/cerebras-models.json` rather than typed here.
struct CerebrasModel {
    id: &'static str,
    name: &'static str,
    context_window: u64,
    max_tokens: u64,
    input: &'static [&'static str],
    thinking_levels: &'static [&'static str],
    /// Whether the model refuses to be asked not to think. See `AiModelOption::reasoning_mandatory`.
    reasoning_mandatory: bool,
    /// The word this model answers to for "stop thinking", where it has one.
    ///
    /// Not every model does, and the two shipped ones differ: `gemma-4-31b` takes
    /// `reasoning_effort: "none"` and comes back with no reasoning at all, while `gpt-oss-120b`
    /// passes the same value through the validator and is then refused by its own chat template.
    /// Nothing here means `off` sends no effort field, which is what every other driver does.
    off_effort: Option<&'static str>,
}

// GENERATED-BEGIN cerebras-models sha256:67ea66a53c1f1124
const CEREBRAS_MODELS: [CerebrasModel; 2] = [
    // Measured on 2026-08-27. The window is the number the endpoint names itself: a 300,000-token
    // prompt answers HTTP 400 `context_length_exceeded`, "Current length is 300068 while limit is
    // 131000". Not 131,072 — the two models on this endpoint do not share a window. Output has no
    // ceiling of its own and shares that window, so `maxTokens` repeats it and `ceiling_within`
    // cuts it down. `image_url` answers 400 "Content type 'image_url' is not supported by selected
    // model", so text only. Reasoning is mandatory: the API validator accepts `reasoning_effort:
    // "none"` and the chat template then refuses it with "Unsupported reasoning effort: none.
    // Supported values are 'low', 'medium', and 'high'." So this model has no word for stopping and
    // carries no `offEffort`.
    CerebrasModel {
        id: "gpt-oss-120b",
        name: "GPT OSS 120B",
        context_window: 131_000,
        max_tokens: 131_000,
        input: &["text"],
        thinking_levels: &["low", "medium", "high"],
        reasoning_mandatory: true,
        off_effort: None,
    },
    // Measured on 2026-08-27. The window is the endpoint's own number, "limit is 131072", and
    // output shares it. `image_url` is accepted, so text and image. `reasoning_effort: "none"` is
    // accepted by both the validator and the template, and the reply comes back with no `reasoning`
    // field at all — so unlike its neighbour this model has a real word for stopping, and `off`
    // sends it rather than sending nothing.
    CerebrasModel {
        id: "gemma-4-31b",
        name: "Gemma 4 31B IT",
        context_window: 131_072,
        max_tokens: 131_072,
        input: &["text", "image"],
        thinking_levels: &["low", "medium", "high"],
        reasoning_mandatory: false,
        off_effort: Some("none"),
    },
];
// GENERATED-END cerebras-models

/// One row of the shipped table, as the rest of Gofer states a model.
fn cerebras_model_option(model: &CerebrasModel) -> AiModelOption {
    AiModelOption {
        id: model.id.to_owned(),
        name: model.name.to_owned(),
        context_window: model.context_window,
        // Cerebras has no output ceiling of its own — a request may name the whole window and is
        // answered — so the table repeats the window and this is what actually bounds it.
        max_tokens: ceiling_within(model.context_window, Some(model.max_tokens)),
        reasoning: true,
        // Named efforts are the only evidence an effort field will be read, and both shipped models
        // name three. Same rule as `openrouter_model_options`.
        supports_reasoning_effort: !model.thinking_levels.is_empty(),
        reasoning_mandatory: model.reasoning_mandatory,
        thinking_levels: model
            .thinking_levels
            .iter()
            .map(|&s| s.to_owned())
            .collect(),
        input: model.input.iter().map(|&s| s.to_owned()).collect(),
        off_effort: model.off_effort.map(str::to_owned),
    }
}

/// What Gofer already knows about a model an acceptance run named, where it knows anything.
///
/// `served_by` starts from the shipped settings, so every fact on the live connection is the seed
/// model's until something replaces it — and only the id and the label ever were. In the
/// application that gap does not exist: a model arrives from a picker filled by `chatgpt_models`,
/// `openrouter_model_options` or `cerebras_model_options`, and the whole row travels with it. A
/// run names a bare string and has no picker to have chosen from.
///
/// What that cost: every Cerebras turn in this repo's measurement log ran as `gemma-4-31b` and
/// inherited `CEREBRAS_MODELS[0]` — gpt-oss-120b's text-only input, its 131,000-token window and
/// its missing `offEffort`. Gemma reads images, so each captured frame reached the model as
/// `[a image/png you cannot see: this model takes text only]`, and `off` sent no effort field
/// where that model has a word for it.
///
/// Cerebras is the only driver with an answer here, and that is the point rather than an omission:
/// its endpoint publishes no capabilities, so the table in this file is the catalogue. The other
/// three read theirs off the wire, which an offline `served_by` cannot do.
#[cfg(all(test, feature = "godot-acceptance"))]
fn shipped_model_facts(driver: AiConnectionType, id: &str) -> Option<AiModelOption> {
    if driver != AiConnectionType::Cerebras {
        return None;
    }
    CEREBRAS_MODELS
        .iter()
        .find(|known| known.id == id)
        .map(cerebras_model_option)
}

/// The Cerebras models this key can reach, which is the live list narrowed to the ones Gofer knows.
///
/// An intersection, and deliberately in that direction. The endpoint is the authority on which
/// models a key may use — it lists what the organisation has, and answers HTTP 404
/// `model_archived` for one it has retired — and the shipped table is the authority on what they
/// can do. A model in the table that the key cannot reach is not offered, and a model the key can
/// reach that the table has never seen is not offered either: every fact a picker needs about it
/// would have to be guessed, and a guessed ceiling is a connection whose every request fails on a
/// number nobody checked.
fn cerebras_model_options(remote: &[Model]) -> Vec<AiModelOption> {
    CEREBRAS_MODELS
        .iter()
        .filter(|known| remote.iter().any(|model| model.id == known.id))
        .map(cerebras_model_option)
        .collect()
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
    cerebras_api_key: Option<String>,
    oauth_credential: Option<serde_json::Value>,
) -> Option<crate::rag::RetrieveConnection> {
    let chosen = settings.subagent.connection.as_ref();
    let driver = chosen.map_or(settings.connection_type, |c| c.connection_type);
    // The address, the dialect and the credential are the connection's; the model and the level it
    // is asked at are the child's own. Two typed halves merged, which is what the child *is*, and
    // exactly how `subagentModelFor` splits them in the worker.
    let connection = settings.connection_for(driver)?;
    let model = chosen.map_or(&connection.model, |c| &c.model);
    let codex = driver == AiConnectionType::OpenaiCodex;
    if codex && oauth_credential.is_none() {
        return None;
    }
    Some(crate::rag::RetrieveConnection {
        connection_type: driver_id(driver).to_owned(),
        oauth_credential: if codex { oauth_credential } else { None },
        base_url: connection.base_url.clone(),
        model: model.id.clone(),
        model_name: model.name.clone(),
        api_key: driver.key_from(api_key, openrouter_api_key, cerebras_api_key),
        thinking_level: model.thinking_level.clone(),
        context_window: model.context_window,
        max_tokens: model.max_tokens,
        reasoning: model.reasoning,
        supports_reasoning_effort: model.supports_reasoning_effort,
        reasoning_mandatory: model.reasoning_mandatory,
        thinking_levels: model.thinking_levels.clone(),
        off_effort: model.off_effort.clone(),
        // The connection's, never the child's: the child borrows an address, and how thinking is
        // turned on is a fact about the server at that address.
        chat_template_thinking: connection.chat_template_thinking,
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
    mandatory: bool,
    levels: &[String],
) -> Vec<String> {
    // Reasoning first, and it is not redundant: a model can be marked as taking an effort and as
    // not thinking at all, and a model that does not think has nothing to spend an effort on.
    if !reasoning {
        return vec!["off".to_owned()];
    }
    // And then whether it may be turned off at all. `off` resolves to `reasoning: {enabled: false}`
    // on the wire, which a model whose reasoning is mandatory answers with HTTP 400. The same rule
    // as `thinkingLevelsFor` in `src/models/settings.ts`; the two are one rule in two languages.
    let off: &[String] = if mandatory {
        &[]
    } else {
        std::slice::from_ref(&OFF_LEVEL)
    };
    if !levels.is_empty() {
        return off.iter().cloned().chain(levels.iter().cloned()).collect();
    }
    if supports_reasoning_effort {
        return EFFORT_LEVELS
            .iter()
            .filter(|level| !mandatory || **level != "off")
            .map(|level| (*level).to_owned())
            .collect();
    }
    off.iter()
        .cloned()
        .chain(std::iter::once("on".to_owned()))
        .collect()
}

/// The stored level, kept if the model still offers it and replaced by the cheapest one it does.
///
/// Cheapest by `EFFORT_LEVELS`, which is ascending and begins with `off` — so wherever `off` is
/// offered this is the answer it always gave. Never by the model's own list, which is the
/// provider's order: OpenRouter answers `["max", "high", "low"]`, and taking the first of that
/// would answer a stored request for no thinking with the most expensive setting there is.
/// `keepThinkingLevel` in `src/models/settings.ts` makes the same choice for the same reason.
fn keep_level(
    level: &str,
    reasoning: bool,
    supports_reasoning_effort: bool,
    mandatory: bool,
    levels: &[String],
) -> String {
    let offered = thinking_levels(reasoning, supports_reasoning_effort, mandatory, levels);
    if offered.iter().any(|one| one == level) {
        return level.to_owned();
    }
    EFFORT_LEVELS
        .iter()
        .find(|cheapest| offered.iter().any(|one| one == *cheapest))
        .map_or_else(
            || offered.first().cloned().unwrap_or_else(|| "off".to_owned()),
            |cheapest| (*cheapest).to_owned(),
        )
}

/// Re-derives every model-owned fact in a settings file, from the catalogue and from the server.
///
/// Called on every read and every save, so what is on disk is never the authority — it is a copy
/// the next load overwrites. The local driver's connection, and no other. Both sources describe
/// servers on this machine: Pi's `models.json` is a file naming local providers, and `served` is
/// what a llama.cpp host answered when it was asked. ChatGPT, OpenRouter and Cerebras keep what
/// they have and are refreshed by the model lister instead, which is the only other writer of these
/// fields. They are excluded by construction rather than by a filter: this names the local driver.
///
/// Offering the other two would not merely be useless. Both sources are keyed by address alone, and
/// nothing stops a `~/.pi/agent/models.json` from naming a provider at OpenRouter's — which
/// `validate_settings` has just pinned to a constant, so the collision is exact and permanent. Pi's
/// answers would then be written over the user's OpenRouter model on every read and every save,
/// collapsing an unnamed model's thinking to the provider's single boolean and letting `keep_level`
/// drop the level they chose.
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
    // The sub-agent has no address of its own — it borrows the connection it names. So the server
    // its model is resolved against is that connection's, not the parent's. Read before the
    // connections are borrowed, because after that it cannot be.
    let local_base_url = settings
        .connection_for(AiConnectionType::OpenaiCompatible)
        .map(|local| local.base_url.clone());
    if let Some(local) = settings
        .connections
        .get_mut(&AiConnectionType::OpenaiCompatible)
    {
        resolve_connection(local, catalog, served);
    }
    if let Some(child) = settings.subagent.connection.as_mut()
        && matches!(child.connection_type, AiConnectionType::OpenaiCompatible)
        && let Some(base_url) = local_base_url
    {
        resolve_model(&mut child.model, &base_url, None, catalog, served);
    }
}

/// One connection, corrected by the catalogue and then by its own server.
fn resolve_connection(
    connection: &mut AiConnectionProfile,
    catalog: &PiCatalog,
    served: &HashMap<String, ServedModel>,
) {
    let base_url = connection.base_url.clone();
    resolve_model(
        &mut connection.model,
        &base_url,
        Some(&mut connection.chat_template_thinking),
        catalog,
        served,
    );
}

/// One chosen model, corrected by the catalogue and then by the server it is resolved against.
///
/// The address is passed in rather than read off anything, because the sub-agent's model has none
/// of its own: it borrows the connection it names. `chat_template_thinking` is absent for the same
/// reason — it describes a server, so it belongs to the connection, and the child's answer to it is
/// the one that connection already holds.
fn resolve_model(
    choice: &mut ModelChoice,
    base_url: &str,
    chat_template_thinking: Option<&mut bool>,
    catalog: &PiCatalog,
    served: &HashMap<String, ServedModel>,
) {
    if let Some(facts) = model_facts(catalog, base_url, &choice.id) {
        if let Some(model_name) = facts.model_name {
            choice.name = model_name;
        }
        choice.reasoning = facts.reasoning;
        choice.supports_reasoning_effort = facts.supports_reasoning_effort;
        if let Some(input) = facts.input {
            choice.input = input;
        }
    }
    if let Some(model) = served.get(&server_key(base_url)) {
        // The id too, not only the facts about it — but only where there is one model to be. A
        // host serving one file answers to its path, and a stored id naming the file before it was
        // swapped names nothing at all. A router serving a directory of them is the other case:
        // there the id is the user's choice among several, `/props` describes only one of those,
        // and adopting it would move them onto a model they did not pick. So a router's answer is
        // taken only for the model it is actually about.
        if !model.sole && choice.id != model.id {
            return;
        }
        if choice.id != model.id {
            choice.id = model.id.clone();
            choice.name = model.id.clone();
        }
        if let Some(window) = model.context_window {
            choice.context_window = window;
            // The output ceiling cannot outlive the window it is spent inside, and it may not be
            // the whole of it either — a server that answers `/props` with a window smaller than
            // the stored ceiling used to turn that ceiling into the window exactly. Clamped rather
            // than replaced, so a user who chose a smaller one keeps it.
            choice.max_tokens = ceiling_within(window, Some(choice.max_tokens));
        }
        choice.reasoning = model.reasoning;
        choice.supports_reasoning_effort = !model.efforts.is_empty();
        choice.thinking_levels = model.efforts.clone();
        // A server that answered `/props` is a llama.cpp host, and thinking is turned on there by
        // a chat-template argument. The effort field it also accepts does nothing.
        if let Some(chat_template_thinking) = chat_template_thinking {
            *chat_template_thinking = model.reasoning;
        }
        if let Some(input) = model.input.clone() {
            choice.input = input;
        }
    }
    // The level, re-applied against what the model turned out to offer. Resolution can take
    // reasoning away entirely, and it can take the levels away while leaving the thinking — a
    // stored `medium` means nothing to a template whose only answers are on and off.
    choice.thinking_level = keep_level(
        &choice.thinking_level,
        choice.reasoning,
        choice.supports_reasoning_effort,
        choice.reasoning_mandatory,
        &choice.thinking_levels,
    );
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

/// Asks the local server this settings file points at what it is serving.
///
/// One address, because there is one local connection. It used to be two — the connection the
/// parent was on and the saved local profile, which were the same one written down twice — and the
/// second was asked only to be told what the first had already answered. ChatGPT and OpenRouter
/// have no `/props` and are not asked.
fn ask_servers(ai: &AiSettings) -> HashMap<String, ServedModel> {
    let mut served = HashMap::new();
    let Some(local) = ai.connection_for(AiConnectionType::OpenaiCompatible) else {
        return served;
    };
    if let Some(model) = crate::model_server::served_model(&local.base_url) {
        served.insert(server_key(&local.base_url), model);
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
        // The catalogue is a file, and no file has ever carried this. Only a live catalogue says.
        reasoning_mandatory: false,
        // The catalogue is a file. Only the server that has the model loaded can name its efforts.
        thinking_levels: Vec::new(),
        input: model.input.clone(),
        // The catalogue is a file, and no file has ever carried this either.
        off_effort: None,
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
            connections: default_connections(AiConnectionProfile {
                name: "Local AI".to_owned(),
                base_url: provider.base_url.clone(),
                api: ApiDialect::OpenaiCompletions,
                chat_template_thinking: false,
                model: ModelChoice {
                    id: model.id.clone(),
                    name: model.name.clone(),
                    context_window: model.context_window,
                    max_tokens: model.max_tokens,
                    reasoning: known.reasoning,
                    supports_reasoning_effort: known.supports_reasoning_effort,
                    reasoning_mandatory: known.reasoning_mandatory,
                    thinking_levels: Vec::new(),
                    input: model.input.clone(),
                    off_effort: None,
                    thinking_level: default_thinking_level(),
                },
            }),
            max_retries: default_max_retries(),
            timeout_ms: default_timeout_ms(),
            compaction_percent: default_compaction_percent(),
            subagent: SubagentSettings::default(),
            web: WebSettings::default(),
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
    // A hosted driver's address and dialect are not the user's to set, so they are corrected rather
    // than validated. A settings file hand-edited to point one of these somewhere else would send
    // that driver's key to that address, and the catalogue parser to a server that answers a
    // different shape.
    for (driver, address) in [
        (AiConnectionType::Openrouter, OPENROUTER_BASE_URL),
        (AiConnectionType::Cerebras, CEREBRAS_BASE_URL),
    ] {
        if let Some(pinned) = settings.ai.connections.get_mut(&driver) {
            pinned.base_url = address.to_owned();
            pinned.api = ApiDialect::OpenaiCompletions;
            pinned.chat_template_thinking = false;
        }
    }
    // Every connection, not only the live one. They are all the user's to save and any of them can
    // be the one a sub-agent runs on, so a rule that held for whichever was switched on was a rule
    // the other two were exempt from.
    for connection in settings.ai.connections.values_mut() {
        validate_connection(connection)?;
    }
    if settings.ai.connection().is_none() {
        return Err("The chosen AI driver has no connection configured".to_owned());
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
    validate_subagent_bounds(&settings.ai.subagent)?;
    let has_local = settings
        .ai
        .connection_for(AiConnectionType::OpenaiCompatible)
        .is_some();
    if let Some(connection) = settings.ai.subagent.connection.take() {
        settings.ai.subagent.connection =
            Some(validate_subagent_connection(connection, has_local)?);
    }
    // Corrected rather than refused. An engine name nobody recognises is one field of one tool, and
    // failing the whole load over it would take the user's model, worktree and prompt down with it.
    if !SEARCH_PROVIDERS.contains(&settings.ai.web.search_provider.as_str()) {
        settings.ai.web.search_provider = default_search_provider();
    }
    Ok(settings)
}

/// One connection held to its own rules: the address it points at, and the model chosen on it.
fn validate_connection(connection: &mut AiConnectionProfile) -> Result<(), String> {
    connection.name = required_value("Connection name", std::mem::take(&mut connection.name))?;
    if connection.name.len() > 100 {
        return Err("Connection names cannot exceed 100 bytes".to_owned());
    }
    validate_model_choice(&mut connection.model, "Model ID")?;
    connection.base_url = connection.base_url.trim().trim_end_matches('/').to_owned();
    let url = reqwest::Url::parse(&connection.base_url)
        .map_err(|error| format!("Base URL must be a valid absolute URL: {error}"))?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err("Base URL must use http or https".to_owned());
    }
    if url.cannot_be_a_base()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || connection.base_url.len() > 2_048
    {
        return Err("Base URL cannot contain credentials, a query, or a fragment".to_owned());
    }
    Ok(())
}

/// Everything a chosen model can be wrong about, wherever it was chosen.
///
/// One function because there is one rule. It used to be two, kept in step by hand — the parent's
/// written against the flat settings and the sub-agent's against its own shape — and the only thing
/// they differed in is what a missing model id is called on screen, which is the argument.
fn validate_model_choice(choice: &mut ModelChoice, id_name: &str) -> Result<(), String> {
    // A ceiling that is the whole window is not a ceiling, and it is not a choice either: no field
    // in the app offers one, and the only way a settings file holds one is that a shipped default
    // put it there. `default_openrouter_profile` did, `max_tokens: 1_000_000` against a
    // `context_window: 1_000_000`, and every file written while it did still holds it — OpenRouter
    // reserves credit for the ceiling before it generates anything, so those users go on being
    // answered HTTP 402 whatever this build ships.
    //
    // Repaired rather than refused, and only in this one shape. A stored ceiling that is a ceiling
    // is the user's and is left exactly as they set it, which is what `default_max_tokens` says
    // and what `a_response_may_not_be_as_long_as_the_whole_window` holds this to.
    if choice.max_tokens >= choice.context_window && choice.context_window > 0 {
        choice.max_tokens = ceiling_within(choice.context_window, None);
    }
    choice.id = required_value(id_name, std::mem::take(&mut choice.id))?;
    if choice.id.len() > 512 {
        return Err("Model IDs cannot exceed 512 bytes".to_owned());
    }
    if choice.name.trim().is_empty() {
        choice.name = choice.id.clone();
    } else {
        choice.name = choice.name.trim().to_owned();
    }
    if choice.name.len() > 512 {
        return Err("Model names cannot exceed 512 bytes".to_owned());
    }
    if choice.input.is_empty()
        || choice.input.len() > 16
        || choice
            .input
            .iter()
            .any(|input| input.is_empty() || input.len() > 64)
    {
        return Err("Model input types are invalid".to_owned());
    }
    if choice.context_window == 0 || choice.max_tokens == 0 {
        return Err(
            "Context window and maximum output tokens must be greater than zero".to_owned(),
        );
    }
    // Dropped rather than refused, and dropped in two shapes. A blank word is a word nothing can
    // send, and a word on a model that takes no effort field is a word nothing will read — both
    // are settings files hand-edited to say something the catalogue never said. Left in place they
    // would put a provider's private vocabulary onto the wire for a connection that has no use for
    // it. See `CerebrasModel::off_effort`.
    if choice
        .off_effort
        .as_ref()
        .is_some_and(|word| word.trim().is_empty() || word.len() > 64)
        || !choice.supports_reasoning_effort
    {
        choice.off_effort = None;
    }
    if !EVERY_LEVEL.contains(&choice.thinking_level.as_str()) {
        return Err("Reasoning level is invalid".to_owned());
    }
    choice.thinking_level = keep_level(
        &choice.thinking_level,
        choice.reasoning,
        choice.supports_reasoning_effort,
        choice.reasoning_mandatory,
        &choice.thinking_levels,
    );
    Ok(())
}

/// One ceiling: the name a settings file spells it with, how to read it, and the range it may hold.
type SubagentBound = (&'static str, fn(&SubagentSettings) -> u32, u32, u32);

/// What each of the sub-agent's ceilings ships as, and what it may be set to.
///
/// Emitted from `protocol/subagent-bounds.json`, together with the six functions serde fills a
/// missing field from. They were twenty-four numbers written here and twenty-four more written in
/// `settings.ts`, and the ranges were reconciled by a checker that read both files as text while
/// the defaults were reconciled by nobody. A default and a range are one fact about one ceiling, so
/// they are one row.
///
/// The slider was the only thing enforcing the ranges for years: `validate_settings` never looked
/// at `SubagentSettings` at all, so a hand-edited `settings.json` saying `maxTurns: 100000` loaded,
/// was validated, and was obeyed. The top of each range is the largest value that is still a
/// ceiling rather than an absence of one, and every range starts where "off" is a real answer —
/// except the retry wait, which is only read when a retry happens and has no meaning at zero.
// GENERATED-BEGIN subagent-bounds sha256:7b34b4c670eb5c90
const SUBAGENT_BOUNDS: [SubagentBound; 6] = [
    (
        "commandTimeoutMinutes",
        |s| s.command_timeout_minutes,
        0,
        30,
    ),
    (
        "streamInactivityMinutes",
        |s| s.stream_inactivity_minutes,
        0,
        30,
    ),
    ("maxTurns", |s| s.max_turns, 0, 40),
    ("maxAnswerChars", |s| s.max_answer_chars, 0, 24_000),
    ("retryAttempts", |s| s.retry_attempts, 0, 5),
    (
        "retryBaseDelaySeconds",
        |s| s.retry_base_delay_seconds,
        1,
        10,
    ),
];

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
// GENERATED-END subagent-bounds

/// Every ceiling held to its own range, named the way the file that carries it names it.
///
/// The name in the message is the settings file's own spelling rather than a prose label, because
/// the only way past the slider is to have typed that key by hand.
fn validate_subagent_bounds(subagent: &SubagentSettings) -> Result<(), String> {
    for (name, chosen, low, high) in SUBAGENT_BOUNDS {
        let value = chosen(subagent);
        if !(low..=high).contains(&value) {
            return Err(format!(
                "The sub-agent's {name} must be between {low} and {high}"
            ));
        }
    }
    Ok(())
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
    validate_model_choice(&mut connection.model, "Sub-agent model ID")?;
    Ok(connection)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The word serde writes a driver as is the word `driver_id` says it is.
    ///
    /// Two spellings of one thing, and only one of them is generated. `AiConnectionType` carries
    /// `#[serde(rename_all = "kebab-case")]`, so the settings file's word comes out of the variant
    /// name; `driver_id` is emitted from `protocol/drivers.json` and is what every other language
    /// is emitted from. Nothing compared them. A variant whose kebab-case is not its declared id —
    /// `OpenAiCodex` rather than `OpenaiCodex`, one capital — would write a settings file this
    /// build cannot read back, and both halves would still compile.
    ///
    /// Round-tripped rather than asserted against a list, so it fails on the id and on the variant
    /// alike: every declared id must parse to a driver, and that driver must write itself back as
    /// the same id.
    #[test]
    fn the_word_serde_writes_is_the_word_the_catalogue_declares() {
        for id in DRIVER_IDS {
            let driver: AiConnectionType = serde_json::from_str(&format!("\"{id}\""))
                .unwrap_or_else(|error| {
                    panic!("{id} is declared but parses to no driver: {error}")
                });
            assert_eq!(
                driver_id(driver),
                id,
                "{id} parses to a driver that names itself differently"
            );
            let written = serde_json::to_string(&driver).expect("a driver serializes");
            assert_eq!(
                written,
                format!("\"{id}\""),
                "serde writes {id} as {written}"
            );
        }
        // And no driver is missing from the catalogue: the map every settings file is built with
        // has one connection per driver, so its length is the count the enum really has.
        assert_eq!(
            default_connections(default_local_profile()).len(),
            DRIVER_IDS.len(),
            "a driver has a default connection and no row in protocol/drivers.json, or the reverse"
        );
    }

    /// The one file that leaves this machine is `catalogue.rs`.
    ///
    /// That is the whole claim behind the split: `settings.rs` held six subjects, and only one of
    /// them asks a vendor anything. A `reqwest` call appearing in `mod.rs` — a validator that
    /// checks a model by fetching it, a read that probes an endpoint — puts the network back in
    /// front of every caller that only wanted to read a file, and nothing about the module tree
    /// would say so.
    ///
    /// Read off the source, because there is no type that carries it. The client and the builder
    /// are what leave the machine; `reqwest::Url` is a URL parser, and `validate_connection` uses
    /// it to refuse a base address without asking anyone about it. `model_server.rs` reaches a
    /// local llama over a bare socket and is a third seam again; this says nothing about it, only
    /// that this module has one door.
    #[test]
    fn only_the_catalogue_asks_a_vendor_anything() {
        let here = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/settings");
        for name in ["mod.rs", "secrets.rs", "legacy.rs"] {
            let body = std::fs::read_to_string(here.join(name)).expect("read a settings module");
            // The test modules are exempt: `mod tests` in `mod.rs` drives the real per-driver
            // decisions, and it holds this very sentence.
            //
            // Anchored on the `mod` and not on the attribute alone, which is what this was and is
            // why it went quietly vacuous: `#[cfg(test)] use catalogue::*;` sits at the top of this
            // file, so splitting on the first attribute left 25 of 4,800 lines to search and the
            // test went on passing. A source-reading test that cannot say how much source it read
            // is a test that can be switched off by an unrelated edit, so it says.
            let production = body
                .split("\n#[cfg(test)]\nmod ")
                .next()
                .unwrap_or_default();
            let read = production.lines().count();
            let whole = body.lines().count();
            assert!(
                read * 4 > whole,
                "settings/{name}: only {read} of {whole} lines were searched, so this proves nothing"
            );
            for reaching in ["reqwest::Client", "RequestBuilder", ".send()"] {
                assert!(
                    !production.contains(reaching),
                    "settings/{name} holds {reaching}; reaching a vendor belongs in catalogue.rs"
                );
            }
        }
        let catalogue = std::fs::read_to_string(here.join("catalogue.rs")).expect("read catalogue");
        assert!(
            catalogue.contains("reqwest::Client"),
            "catalogue.rs is the module that asks a vendor, and no longer does"
        );
    }

    /// Every driver reads exactly one key, and it is the one its own keyring slot holds.
    ///
    /// The rule is written once, on the enum, because a key sent to the wrong address is a key
    /// handed to a machine that was never meant to see it. This states the whole table so that
    /// adding a fifth driver has to say which key it reads rather than silently reading none.
    #[test]
    fn a_driver_reads_the_key_its_own_slot_holds() {
        let keys = || {
            (
                Some("local".to_owned()),
                Some("openrouter".to_owned()),
                Some("cerebras".to_owned()),
            )
        };
        let read = |driver: AiConnectionType| {
            let (api, openrouter, cerebras) = keys();
            driver.key_from(api, openrouter, cerebras)
        };
        assert_eq!(
            read(AiConnectionType::OpenaiCompatible),
            Some("local".to_owned())
        );
        assert_eq!(
            read(AiConnectionType::Openrouter),
            Some("openrouter".to_owned())
        );
        assert_eq!(
            read(AiConnectionType::Cerebras),
            Some("cerebras".to_owned())
        );
        // ChatGPT authenticates with an OAuth credential and takes no key at all.
        assert_eq!(read(AiConnectionType::OpenaiCodex), None);
    }
    use crate::{list_ai_models, test_ai_connection};
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;
    use tempfile::TempDir;

    /// Four slots, in memory. The point of the slot being an argument: every secret is reachable.
    #[derive(Default)]
    struct FakeSecrets {
        slots: Mutex<BTreeMap<&'static str, String>>,
        fail_clear: bool,
        fail_load: bool,
        fail_store: bool,
    }

    impl FakeSecrets {
        fn put(&self, secret: Secret, value: &str) {
            self.slots
                .lock()
                .expect("fake credential lock")
                .insert(secret.username(), value.to_owned());
        }
    }

    impl Secrets for FakeSecrets {
        fn clear(&self, secret: Secret) -> Result<(), String> {
            if self.fail_clear {
                return Err("fake clear failure".to_owned());
            }
            self.slots
                .lock()
                .expect("fake credential lock")
                .remove(secret.username());
            Ok(())
        }

        fn read(&self, secret: Secret) -> Result<Option<String>, String> {
            if self.fail_load {
                return Err("fake load failure".to_owned());
            }
            Ok(self
                .slots
                .lock()
                .expect("fake credential lock")
                .get(secret.username())
                .cloned())
        }

        fn write(&self, secret: Secret, value: &str) -> Result<(), String> {
            if self.fail_store {
                return Err("fake store failure".to_owned());
            }
            self.put(secret, value);
            Ok(())
        }
    }

    /// One local connection, named and pointed somewhere, with everything else shipped.
    fn connection(base_url: impl Into<String>, model: impl Into<String>) -> AiConnectionProfile {
        let mut connection = default_local_profile();
        connection.name = " Test connection ".to_owned();
        connection.base_url = base_url.into();
        connection.model.id = model.into();
        connection.model.name = connection.model.id.clone();
        connection
    }

    fn settings(base_url: impl Into<String>, model: impl Into<String>) -> GoferSettings {
        settings_on(
            AiConnectionType::OpenaiCompatible,
            connection(base_url, model),
        )
    }

    /// The shipped settings with one driver live and one connection under it.
    fn settings_on(driver: AiConnectionType, connection: AiConnectionProfile) -> GoferSettings {
        let mut settings = GoferSettings::default();
        settings.ai.connection_type = driver;
        settings.ai.connections.insert(driver, connection);
        settings
    }

    /// A settings file holding one connection and no other, which is what a ChatGPT-only install
    /// that has never configured a local server has.
    fn settings_only_on(
        driver: AiConnectionType,
        connection: AiConnectionProfile,
    ) -> GoferSettings {
        let mut settings = settings_on(driver, connection);
        settings
            .ai
            .connections
            .retain(|stored, _| *stored == driver);
        settings
    }

    /// The connection the live driver runs on, in a test that already knows there is one.
    fn live(settings: &GoferSettings) -> &AiConnectionProfile {
        settings.ai.connection().expect("a live connection")
    }

    /// The same one, to be edited into whatever shape the test is about.
    fn live_mut(settings: &mut GoferSettings) -> &mut AiConnectionProfile {
        let driver = settings.ai.connection_type;
        settings
            .ai
            .connections
            .get_mut(&driver)
            .expect("a live connection")
    }

    fn request(base_url: impl Into<String>, model: impl Into<String>) -> SettingsRequest {
        SettingsRequest {
            settings: settings(base_url, model),
            api_key: ApiKeyUpdate::Set {
                value: " secret-token ".to_owned(),
            },
            brave_api_key: ApiKeyUpdate::Keep,
            openrouter_api_key: ApiKeyUpdate::Keep,
            cerebras_api_key: ApiKeyUpdate::Keep,
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
        let shipped = default_local_profile().model;
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

        // A stored ceiling is the user's, and reading their settings never replaces it — even out
        // of a settings file written in the flat shape, which is what this one is.
        let chosen: AiSettings = serde_json::from_value(serde_json::json!({
            "connectionType": "openai-compatible",
            "name": "Local AI",
            "baseUrl": "http://127.0.0.1:8080/v1",
            "model": "m.gguf",
            "api": "openai-completions",
            "maxTokens": 120_064
        }))
        .expect("settings");
        assert_eq!(
            chosen
                .connection()
                .expect("a live connection")
                .model
                .max_tokens,
            120_064
        );
    }

    /// And the shipped OpenRouter connection obeys the same rule as the shipped local one.
    ///
    /// It did not. It shipped `max_tokens: 1_000_000` against a `context_window: 1_000_000`, which
    /// is the failure the test above exists to prevent, plus one that only a paid endpoint has:
    /// OpenRouter reserves credit for the ceiling before it generates a token, so the first live
    /// turn on a fresh OpenRouter connection was answered HTTP 402 — *"You requested up to 978938
    /// tokens, but can only afford 63556"* — on a balance that would have paid for the real answer
    /// many times over. Measured, not argued: the same prompt to the same model in the same minute
    /// was refused at `max_tokens: 1000000` and answered at `max_tokens: 16384`.
    ///
    /// The ChatGPT profile is deliberately not here. Its numbers never reach the wire — the Codex
    /// driver takes the model out of Pi's own catalogue and ignores the profile's ceiling.
    #[test]
    fn the_openrouter_connection_ships_a_ceiling_too() {
        let shipped = default_openrouter_profile().model;
        let reserve = shipped.context_window
            - (shipped.context_window * u64::from(default_compaction_percent())) / 100;
        assert!(
            shipped.max_tokens <= reserve,
            "the seed ceiling has to fit the compaction reserve: {} in {reserve}",
            shipped.max_tokens
        );
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
    }

    /// A settings file already holding the ceiling that could not be afforded is repaired.
    ///
    /// Shipping a better seed fixes nobody's file. `max_tokens` is `#[serde(default)]`, so it
    /// defaults only when absent, and every file written while `default_openrouter_profile` said
    /// `1_000_000` still holds `1_000_000` — HTTP 402 on every turn, whatever this build ships.
    ///
    /// The repair is narrow on purpose: only a ceiling that is the whole window, which no field in
    /// the app can produce and only a shipped default ever wrote. A stored ceiling that is a
    /// ceiling is the user's and is left exactly as they set it.
    #[test]
    fn a_stored_ceiling_that_is_the_whole_window_is_repaired_and_a_real_one_is_not() {
        let mut settings = GoferSettings::default();
        let openrouter = settings
            .ai
            .connections
            .get_mut(&AiConnectionType::Openrouter)
            .expect("the OpenRouter connection");
        openrouter.model.context_window = 1_000_000;
        openrouter.model.max_tokens = 1_000_000;
        let local = settings
            .ai
            .connections
            .get_mut(&AiConnectionType::OpenaiCompatible)
            .expect("the local connection");
        local.model.context_window = 120_064;
        local.model.max_tokens = 32_768;

        let saved = validate_settings(settings).expect("valid");

        assert_eq!(
            saved
                .ai
                .connection_for(AiConnectionType::Openrouter)
                .expect("openrouter")
                .model
                .max_tokens,
            140_000,
            "a ceiling that is the whole window is not a ceiling and was never a choice"
        );
        assert_eq!(
            saved
                .ai
                .connection_for(AiConnectionType::OpenaiCompatible)
                .expect("local")
                .model
                .max_tokens,
            32_768,
            "and one the user really set is theirs"
        );
    }

    /// A ceiling the catalogue names is taken only as far as it fits.
    ///
    /// Measured against the live catalogue on 2026-08-26: of the 348 tool-capable models, **188**
    /// name an output ceiling larger than the room compaction leaves above its own line, and three
    /// name the whole window. Adopted as written, `x-ai/grok-4.6` sends `max_tokens: 450000` and is
    /// answered *"you requested up to 449998 tokens, but can only afford 5295"* — a refusal
    /// produced by the ceiling alone, before the model is asked for anything.
    #[test]
    fn a_catalog_ceiling_is_taken_only_as_far_as_it_fits() {
        // window 262,144 -> reserve 36,701. A declared 32,000 is under it and survives whole.
        assert_eq!(ceiling_within(262_144, Some(32_000)), 32_000);
        // The same window, a ceiling the model would be glad to fill: cut to the reserve.
        assert_eq!(ceiling_within(262_144, Some(235_929)), 36_701);
        // Nothing declared is not licence to use the window. 52 models declare nothing.
        assert_eq!(ceiling_within(256_000, None), 35_840);
        // A window small enough that a quarter of it is the tighter of the two — and it is a
        // quarter, not the 14% reserve, because 14% of a window this size is not one whole file.
        assert_eq!(ceiling_within(8_000, Some(8_000)), 2_000);
        assert_eq!(ceiling_within(32_768, None), 8_192);
        // The floor lifts the cap, never a ceiling the model declared for itself. A model that
        // really stops at 4,096 keeps its 4,096, or every answer from it is an HTTP 400.
        assert_eq!(ceiling_within(32_768, Some(4_096)), 4_096);
        // And a window of zero cannot underflow into a ceiling of zero, which fails validation.
        assert_eq!(ceiling_within(0, Some(4_096)), 1);
    }

    #[test]
    fn credential_updates_use_the_injected_store() {
        let store = FakeSecrets::default();
        apply(
            &ApiKeyUpdate::Set {
                value: " secret ".to_owned(),
            },
            Secret::AiDefault,
            &store,
        )
        .expect("set credential");
        assert_eq!(
            store
                .read(Secret::AiDefault)
                .expect("load set credential")
                .as_deref(),
            Some("secret")
        );

        apply(&ApiKeyUpdate::Keep, Secret::AiDefault, &store).expect("keep credential");
        assert_eq!(
            store
                .read(Secret::AiDefault)
                .expect("load kept credential")
                .as_deref(),
            Some("secret")
        );

        apply(&ApiKeyUpdate::Clear, Secret::AiDefault, &store).expect("clear credential");
        assert_eq!(
            store
                .read(Secret::AiDefault)
                .expect("load cleared credential"),
            None
        );
    }

    /// The rule the two untested copies held, and the one thing the four secrets do not share.
    ///
    /// Blank typed text is a removal for the two search-and-router keys and a refusal for the AI
    /// key, because emptying the box is how a person takes a key they typed off the machine, while
    /// the AI key's box is a field of the connection being saved. Both halves are asserted here, so
    /// a `Secret` given the wrong `blank()` fails rather than quietly changing what saving does.
    #[test]
    fn a_blank_box_clears_the_keys_it_is_meant_to_and_is_refused_where_it_is_not() {
        let store = FakeSecrets::default();
        for secret in [Secret::Brave, Secret::OpenRouter, Secret::Cerebras] {
            store.put(secret, "already-stored");
            apply(
                &ApiKeyUpdate::Set {
                    value: "   ".to_owned(),
                },
                secret,
                &store,
            )
            .expect("a blank box removes these");
            assert_eq!(store.read(secret).expect("read cleared slot"), None);
        }

        store.put(Secret::AiDefault, "already-stored");
        assert_eq!(
            apply(
                &ApiKeyUpdate::Set {
                    value: "   ".to_owned()
                },
                Secret::AiDefault,
                &store,
            ),
            Err("API key cannot be empty when setting a credential".to_owned())
        );
        // Refused *before* the store is touched: a rejected save must leave the key it was going
        // to replace exactly where it was.
        assert_eq!(
            store
                .read(Secret::AiDefault)
                .expect("read untouched slot")
                .as_deref(),
            Some("already-stored")
        );
    }

    /// One slot written never touches another. Five secrets, five keyring usernames.
    #[test]
    fn every_secret_is_written_to_its_own_slot() {
        let store = FakeSecrets::default();
        for secret in [
            Secret::AiDefault,
            Secret::Brave,
            Secret::OpenRouter,
            Secret::Cerebras,
            Secret::ChatGpt,
        ] {
            apply(
                &ApiKeyUpdate::Set {
                    value: format!("  {}-key  ", secret.username()),
                },
                secret,
                &store,
            )
            .expect("set one secret");
        }
        for secret in [
            Secret::AiDefault,
            Secret::Brave,
            Secret::OpenRouter,
            Secret::Cerebras,
            Secret::ChatGpt,
        ] {
            assert_eq!(
                store.read(secret).expect("read one secret"),
                Some(format!("{}-key", secret.username()))
            );
        }

        apply(&ApiKeyUpdate::Clear, Secret::Brave, &store).expect("clear one secret");
        assert_eq!(store.read(Secret::Brave).expect("read cleared"), None);
        assert!(
            store
                .read(Secret::OpenRouter)
                .expect("read neighbour")
                .is_some()
        );
    }

    /// Every one of the five flags, answered by the injected store.
    ///
    /// Three of them used to reach past it to the real keyring, which is why nothing could say what
    /// they reported. The ChatGPT flag is the one that is not simply "something is there": an
    /// OAuth grant that will not parse is not a credential the user is signed in with.
    #[test]
    fn the_response_reports_all_five_secrets_through_the_one_store() {
        let store = FakeSecrets::default();
        let empty = settings_response_with(&store, settings("http://localhost", "model"));
        assert!(!empty.has_api_key);
        assert!(!empty.has_brave_api_key);
        assert!(!empty.has_openrouter_api_key);
        assert!(!empty.has_cerebras_api_key);
        assert!(!empty.has_chat_gpt_credential);

        store.put(Secret::AiDefault, "sk-1");
        store.put(Secret::Brave, "brave-1");
        store.put(Secret::OpenRouter, "sk-or-1");
        store.put(Secret::Cerebras, "csk-1");
        store.put(Secret::ChatGpt, "not json");
        let partial = settings_response_with(&store, settings("http://localhost", "model"));
        assert!(partial.has_api_key);
        assert!(partial.has_brave_api_key);
        assert!(partial.has_openrouter_api_key);
        assert!(partial.has_cerebras_api_key);
        assert!(!partial.has_chat_gpt_credential);

        store.put(
            Secret::ChatGpt,
            &serde_json::json!({"type": "oauth", "access": "a", "refresh": "r", "expires": 1.0})
                .to_string(),
        );
        let full = settings_response_with(&store, settings("http://localhost", "model"));
        assert!(full.has_chat_gpt_credential);
    }

    /// The rollback window, which now holds every slot a save wrote rather than the AI key alone.
    ///
    /// A settings file that will not write must leave the machine as it found it. It used to leave
    /// a cleared Brave key cleared and a rotated OpenRouter key rotated, because the restore was
    /// the AI key's own function and could not name another slot; two hand-written comments in
    /// `save_settings` explained that as a decision.
    #[test]
    fn a_failed_settings_write_puts_back_every_slot_the_save_wrote() {
        let store = FakeSecrets::default();
        store.put(Secret::AiDefault, "old-ai");
        store.put(Secret::Brave, "old-brave");

        let request = SettingsRequest {
            settings: settings("http://localhost", "model"),
            api_key: ApiKeyUpdate::Set {
                value: "new-ai".to_owned(),
            },
            brave_api_key: ApiKeyUpdate::Clear,
            // Untouched, so it is never read and never put back.
            openrouter_api_key: ApiKeyUpdate::Keep,
            cerebras_api_key: ApiKeyUpdate::Keep,
        };
        let written = apply_saved_secrets_with(&store, &request).expect("write the save's secrets");
        assert_eq!(written.len(), 2);
        assert_eq!(
            store.read(Secret::AiDefault).expect("read ai").as_deref(),
            Some("new-ai")
        );
        assert_eq!(store.read(Secret::Brave).expect("read brave"), None);

        restore_saved_secrets_with(&store, &written).expect("roll the save back");
        assert_eq!(
            store.read(Secret::AiDefault).expect("read ai").as_deref(),
            Some("old-ai")
        );
        assert_eq!(
            store.read(Secret::Brave).expect("read brave").as_deref(),
            Some("old-brave")
        );
    }

    /// A slot that will not write puts back the ones that already did, before it answers.
    ///
    /// The rollback window travels with the answer, and a failure carries no window: the caller gets
    /// an `Err`, propagates it, and never writes the settings file. So a keyring failure on the
    /// second of three slots left the first one changed, the file as it was, and nothing anywhere
    /// holding what had been taken out of it.
    #[test]
    fn a_secret_that_will_not_write_puts_back_the_ones_that_already_did() {
        let store = FakeSecrets {
            fail_clear: true,
            ..Default::default()
        };
        store.put(Secret::AiDefault, "old-ai");

        let request = SettingsRequest {
            settings: settings("http://localhost", "model"),
            api_key: ApiKeyUpdate::Set {
                value: "new-ai".to_owned(),
            },
            // The second slot, and the one the keyring refuses.
            brave_api_key: ApiKeyUpdate::Clear,
            openrouter_api_key: ApiKeyUpdate::Keep,
            cerebras_api_key: ApiKeyUpdate::Keep,
        };

        // `err()` rather than `unwrap_err()`: the window holds the keys that were taken out, and a
        // type that can print itself is one an assertion can print them with.
        assert_eq!(
            apply_saved_secrets_with(&store, &request).err(),
            Some("fake clear failure".to_owned())
        );
        assert_eq!(
            store.read(Secret::AiDefault).expect("read ai").as_deref(),
            Some("old-ai"),
            "the slot that wrote first was left changed with nothing to put it back"
        );
    }

    /// A save that says nothing about any key touches nothing, so there is nothing to roll back.
    #[test]
    fn a_save_that_keeps_every_key_reads_no_slot_at_all() {
        let unreadable = FakeSecrets {
            fail_load: true,
            fail_store: true,
            fail_clear: true,
            ..Default::default()
        };
        let request = SettingsRequest {
            settings: settings("http://localhost", "model"),
            api_key: ApiKeyUpdate::Keep,
            brave_api_key: ApiKeyUpdate::Keep,
            openrouter_api_key: ApiKeyUpdate::Keep,
            cerebras_api_key: ApiKeyUpdate::Keep,
        };
        let written = apply_saved_secrets_with(&unreadable, &request).expect("nothing to write");
        assert!(written.is_empty());
        restore_saved_secrets_with(&unreadable, &written).expect("nothing to restore");
    }

    #[test]
    fn credential_updates_validate_before_using_the_store() {
        let store = FakeSecrets {
            fail_store: true,
            ..Default::default()
        };
        assert_eq!(
            apply(
                &ApiKeyUpdate::Set {
                    value: "  ".to_owned()
                },
                Secret::AiDefault,
                &store,
            ),
            Err("API key cannot be empty when setting a credential".to_owned())
        );
        assert_eq!(
            apply(
                &ApiKeyUpdate::Set {
                    value: "x".repeat(MAX_API_KEY_BYTES + 1)
                },
                Secret::AiDefault,
                &store,
            ),
            Err("API keys cannot exceed 16 KiB".to_owned())
        );
        assert_eq!(
            apply(
                &ApiKeyUpdate::Set {
                    value: "secret".to_owned()
                },
                Secret::AiDefault,
                &store,
            ),
            Err("fake store failure".to_owned())
        );
    }

    #[test]
    fn credential_clear_and_restore_errors_are_propagated() {
        let clear_failure = FakeSecrets {
            fail_clear: true,
            ..Default::default()
        };
        assert_eq!(
            apply(&ApiKeyUpdate::Clear, Secret::AiDefault, &clear_failure),
            Err("fake clear failure".to_owned())
        );
        assert_eq!(
            restore(Secret::AiDefault, None, &clear_failure),
            Err("fake clear failure".to_owned())
        );

        let store_failure = FakeSecrets {
            fail_store: true,
            ..Default::default()
        };
        assert_eq!(
            restore(Secret::AiDefault, Some("previous"), &store_failure),
            Err("Could not restore the previous AI API key: fake store failure".to_owned())
        );
        // The same sentence, about the slot it is actually about.
        assert_eq!(
            restore(Secret::Brave, Some("previous"), &store_failure),
            Err("Could not restore the previous Brave Search key: fake store failure".to_owned())
        );

        // And the way round it is meant to work: a slot that held something gets it back, and a
        // slot that held nothing is emptied.
        let store = FakeSecrets::default();
        store.put(Secret::AiDefault, "written-by-the-save");
        restore(Secret::AiDefault, Some("previous"), &store).expect("restore a previous key");
        assert_eq!(
            store
                .read(Secret::AiDefault)
                .expect("read restored")
                .as_deref(),
            Some("previous")
        );
        restore(Secret::AiDefault, None, &store).expect("restore an empty slot");
        assert_eq!(store.read(Secret::AiDefault).expect("read emptied"), None);

        let load_failure = FakeSecrets {
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
        assert_eq!(live(&inherited).model.id, "inherited.gguf");
        assert_eq!(live(&inherited).base_url, "http://127.0.0.1:9099/v1");

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
        let borrowed = docs_expansion_connection(
            &AiSettings::default(),
            Some("k".to_owned()),
            None,
            None,
            None,
        )
        .expect("a local parent with no sub-agent connection lends its own");
        assert_eq!(borrowed.connection_type, "openai-compatible");
        assert_eq!(borrowed.base_url, default_local_profile().base_url);
        assert_eq!(borrowed.model, default_local_profile().model.id);
        assert_eq!(borrowed.api_key.as_deref(), Some("k"));
        assert_eq!(borrowed.oauth_credential, None);

        let local_child = SubagentConnection {
            connection_type: AiConnectionType::OpenaiCompatible,
            model: ModelChoice {
                id: "small.gguf".to_owned(),
                name: "Small".to_owned(),
                context_window: 8_192,
                max_tokens: 4_096,
                reasoning: true,
                supports_reasoning_effort: true,
                reasoning_mandatory: false,
                thinking_levels: Vec::new(),
                input: default_model_input(),
                off_effort: None,
                thinking_level: "low".to_owned(),
            },
        };
        let mut own = AiSettings::default();
        own.subagent.connection = Some(local_child.clone());
        let child = docs_expansion_connection(&own, None, None, None, None)
            .expect("a local sub-agent is reachable");
        // The address stays the connection's; the model and its level are the child's own.
        assert_eq!(child.base_url, default_local_profile().base_url);
        assert_eq!(child.model, "small.gguf");
        assert_eq!(child.thinking_level, "low");
        assert_eq!(child.max_tokens, 4_096);

        let mut chatgpt = AiSettings::default();
        chatgpt.subagent.connection = Some(SubagentConnection {
            connection_type: AiConnectionType::OpenaiCodex,
            model: ModelChoice {
                id: "gpt-5.6-luna".to_owned(),
                ..local_child.model
            },
        });
        let credential = serde_json::json!({"type": "oauth", "refresh": "r"});
        let followed = docs_expansion_connection(
            &chatgpt,
            Some("k".to_owned()),
            None,
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
            docs_expansion_connection(&chatgpt, None, None, None, None),
            None,
            "a ChatGPT sub-agent with no stored credential has nothing to authenticate with"
        );

        let codex_only =
            settings_only_on(AiConnectionType::OpenaiCodex, default_chatgpt_profile()).ai;
        assert_eq!(
            docs_expansion_connection(&codex_only, None, None, None, None),
            None,
            "a ChatGPT-only install with no credential has no model to reach"
        );
    }

    /// A suite may drive any of the three drivers, and only the local one takes an address.
    ///
    /// The failure this pins is the one the signature used to make unavoidable: `served_by` filled
    /// the OpenAI-compatible slot whatever it was handed, so a run naming a subscription model
    /// pointed a ChatGPT model id at a local server and authenticated with nothing. The ChatGPT
    /// and OpenRouter addresses are constants — a run must not be able to overwrite either from a
    /// default meant for `127.0.0.1`.
    #[cfg(feature = "godot-acceptance")]
    #[test]
    fn a_suite_can_be_pointed_at_any_of_the_three_connections() {
        let local = AiSettings::served_by(
            AiConnectionType::OpenaiCompatible,
            Some("http://127.0.0.1:9099/v1".to_owned()),
            "local".to_owned(),
            None,
        );
        assert_eq!(local.connection_type, AiConnectionType::OpenaiCompatible);
        let profile = local.connection().expect("the local connection is live");
        assert_eq!(profile.base_url, "http://127.0.0.1:9099/v1");
        assert_eq!(profile.model.id, "local");
        // No level named, so nothing is claimed about thinking and the scripted acceptance suite
        // that passes `None` here sends exactly what it always sent.
        assert!(!profile.chat_template_thinking);
        assert!(!profile.model.reasoning);

        // A level named for a local server has to arrive as a chat-template argument, because that
        // is the only thing llama.cpp reads. A build that left these three flags at their defaults
        // sent no thinking field at all and the level did nothing — see `served_by`.
        let asked = AiSettings::served_by(
            AiConnectionType::OpenaiCompatible,
            Some("http://127.0.0.1:9099/v1".to_owned()),
            "local".to_owned(),
            Some("medium".to_owned()),
        );
        let profile = asked.connection().expect("the local connection is live");
        assert!(profile.chat_template_thinking, "{profile:?}");
        assert!(profile.model.reasoning, "{profile:?}");
        assert!(profile.model.supports_reasoning_effort, "{profile:?}");
        assert_eq!(profile.model.thinking_level, "medium");
        assert_eq!(profile.model.thinking_levels, vec!["medium".to_owned()]);

        // `on` is Gofer's word for a template that thinks and names no efforts. It is not an
        // effort, and listing it as one puts every effort out of pi-ai's reach and clamps the
        // request to `off` — the opposite of what was asked for.
        let switched = AiSettings::served_by(
            AiConnectionType::OpenaiCompatible,
            None,
            "local".to_owned(),
            Some("on".to_owned()),
        );
        let profile = switched.connection().expect("the local connection is live");
        assert!(profile.model.thinking_levels.is_empty(), "{profile:?}");
        assert_eq!(profile.model.thinking_level, "on");

        let chatgpt = AiSettings::served_by(
            AiConnectionType::OpenaiCodex,
            None,
            "gpt-5.6-luna".to_owned(),
            Some("medium".to_owned()),
        );
        assert_eq!(chatgpt.connection_type, AiConnectionType::OpenaiCodex);
        let profile = chatgpt
            .connection()
            .expect("the ChatGPT connection is live");
        assert_eq!(profile.base_url, default_chatgpt_profile().base_url);
        assert_eq!(profile.api, ApiDialect::OpenaiCodexResponses);
        // Id and label both, because a run names one model and the report prints whichever it
        // reaches for. A suite has no second string to give and no picker to have chosen from.
        assert_eq!(profile.model.id, "gpt-5.6-luna");
        assert_eq!(profile.model.name, "gpt-5.6-luna");
        // Named rather than inherited: the shipped ChatGPT profile asks at `high`, and two runs
        // are only comparable if the level each was asked at is the level the run wrote down.
        assert_eq!(profile.model.thinking_level, "medium");
        // A chat template is a llama.cpp mechanism, and there is none behind this address.
        assert!(!profile.chat_template_thinking);

        let openrouter = AiSettings::served_by(
            AiConnectionType::Openrouter,
            None,
            "stealth/ox-alpha".to_owned(),
            None,
        );
        let profile = openrouter
            .connection()
            .expect("the OpenRouter connection is live");
        assert_eq!(profile.base_url, OPENROUTER_BASE_URL);
        assert_eq!(profile.model.id, "stealth/ox-alpha");
    }

    /// Naming a model a run wants replaces the whole row, not the two strings a report prints.
    ///
    /// The failure this pins is measured, and it is in this repo's own log: every Cerebras turn
    /// recorded here ran as `gemma-4-31b` and carried `CEREBRAS_MODELS[0]`'s facts. Gemma reads
    /// images and gpt-oss-120b does not, so each captured frame reached the model as
    /// `[a image/png you cannot see: this model takes text only]` — the one thing a run watching a
    /// game cannot afford to get wrong — and `off` sent no effort field where Gemma has a word for
    /// it. Nothing about the report said so, because the id and the name were right.
    ///
    /// The two shipped models differ on every fact asserted below, which is what makes the seed
    /// visible. See `shipped_model_facts`.
    #[cfg(feature = "godot-acceptance")]
    #[test]
    fn a_named_model_brings_the_facts_shipped_with_it() {
        let seed = AiSettings::served_by(
            AiConnectionType::Cerebras,
            None,
            "gpt-oss-120b".to_owned(),
            None,
        );
        let profile = seed.connection().expect("the Cerebras connection is live");
        assert_eq!(profile.model.input, vec!["text".to_owned()]);
        assert_eq!(profile.model.off_effort, None);
        assert!(profile.model.reasoning_mandatory);
        assert_eq!(profile.model.context_window, 131_000);

        let other = AiSettings::served_by(
            AiConnectionType::Cerebras,
            None,
            "gemma-4-31b".to_owned(),
            None,
        );
        let profile = other.connection().expect("the Cerebras connection is live");
        assert_eq!(
            profile.model.input,
            vec!["text".to_owned(), "image".to_owned()],
            "a model with eyes is told it has them"
        );
        assert_eq!(profile.model.off_effort.as_deref(), Some("none"));
        assert!(!profile.model.reasoning_mandatory);
        assert_eq!(profile.model.context_window, 131_072);
        assert_eq!(profile.model.name, "Gemma 4 31B IT");

        // The level a run named still wins. It is the one fact on the row the run chose itself,
        // and the catalogue's own three efforts would put it back out of pi-ai's reach — the clamp
        // `served_by` already writes at length about.
        let asked = AiSettings::served_by(
            AiConnectionType::Cerebras,
            None,
            "gemma-4-31b".to_owned(),
            Some("high".to_owned()),
        );
        let profile = asked.connection().expect("the Cerebras connection is live");
        assert_eq!(profile.model.thinking_levels, vec!["high".to_owned()]);
        assert_eq!(profile.model.thinking_level, "high");
        assert_eq!(
            profile.model.input,
            vec!["text".to_owned(), "image".to_owned()]
        );

        // A model the table has never seen keeps the seed's facts, because nothing knows better.
        // The run still reaches it: the endpoint is the authority on what a key may ask for.
        let unknown = AiSettings::served_by(
            AiConnectionType::Cerebras,
            None,
            "something-unshipped".to_owned(),
            None,
        );
        let profile = unknown
            .connection()
            .expect("the Cerebras connection is live");
        assert_eq!(profile.model.id, "something-unshipped");
        assert_eq!(profile.model.name, "something-unshipped");
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
            model: ModelChoice {
                id: "  gpt-5.4-mini  ".to_owned(),
                name: String::new(),
                context_window: 272_000,
                max_tokens: 128_000,
                reasoning: true,
                supports_reasoning_effort: true,
                reasoning_mandatory: false,
                thinking_levels: Vec::new(),
                input: default_model_input(),
                off_effort: None,
                thinking_level: "low".to_owned(),
            },
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
        assert_eq!(stored.model.id, "gpt-5.4-mini");
        assert_eq!(stored.model.name, "gpt-5.4-mini");
        assert_eq!(stored.model.thinking_level, "low");

        // A model that cannot reason has no level to keep, so the level is dropped rather than left
        // pointing at nothing.
        let mut settings = GoferSettings::default();
        settings.ai.subagent.connection = Some(SubagentConnection {
            model: ModelChoice {
                reasoning: false,
                ..connection.model.clone()
            },
            ..connection.clone()
        });

        let validated = validate_settings(settings).expect("validated settings");

        assert_eq!(
            validated
                .ai
                .subagent
                .connection
                .expect("the sub-agent connection")
                .model
                .thinking_level,
            "off"
        );

        let mut settings = GoferSettings::default();
        settings.ai.subagent.connection = Some(SubagentConnection {
            model: ModelChoice {
                id: "   ".to_owned(),
                ..connection.model
            },
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
            model: ModelChoice {
                id: "Qwen3.6-27B-UD-Q4_K_XL.gguf".to_owned(),
                name: String::new(),
                context_window: default_context_window(),
                max_tokens: default_context_window(),
                reasoning: false,
                supports_reasoning_effort: false,
                reasoning_mandatory: false,
                thinking_levels: Vec::new(),
                input: default_model_input(),
                off_effort: None,
                thinking_level: "off".to_owned(),
            },
        };

        let mut settings =
            settings_only_on(AiConnectionType::OpenaiCodex, default_chatgpt_profile());
        settings.ai.subagent.connection = Some(local.clone());

        assert_eq!(
            validate_settings(settings).expect_err("a local child with no local connection"),
            "The sub-agent cannot use the local connection until one is configured"
        );

        // The same child is fine the moment a local connection exists — including the case where
        // it is the parent's own.
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
        assert_eq!(live(&saved).model.id, "stored-model");

        // What came back is what landed on disk, not just what was computed in memory.
        let loaded = read_settings_from_path(&path).expect("read settings");
        assert_eq!(loaded, saved);
        assert_eq!(live(&loaded).base_url, "http://localhost:9999/v1");
    }

    #[test]
    fn settings_round_trip_and_normalize_values() {
        let directory = TempDir::new().expect("temporary directory");
        let path = directory.path().join("nested/settings.json");
        let normalized = validate_settings(settings(" http://localhost:8080/v1/// ", " model "))
            .expect("valid settings");

        write_settings_to_path(&path, &normalized).expect("write settings");
        let loaded = read_settings_from_path(&path).expect("read settings");

        // One connection under the live driver, and no second copy of it anywhere.
        let local = live(&loaded);
        assert_eq!(local.name, "Test connection");
        assert_eq!(local.model.id, "model");
        assert_eq!(local.base_url, "http://localhost:8080/v1");
        assert_eq!(
            loaded.ai.connection_for(AiConnectionType::OpenaiCodex),
            Some(&default_chatgpt_profile())
        );
        assert!(
            fs::read_to_string(path)
                .expect("settings contents")
                .ends_with('\n')
        );
    }

    /// A settings file written before the connections map opens, and comes out as one map.
    ///
    /// The whole of the old shape in one file: the live connection flattened onto `ai`, the mirror
    /// of it in `local`, the two drivers it is not on in their own slots, and a sub-agent whose
    /// model is an id with its facts scattered beside it. Everything the user chose has to survive,
    /// the mirror has to lose to the original it was a copy of, and what is written back has to be
    /// the new shape — this is somebody's real settings.json, and it may not break.
    #[test]
    fn a_settings_file_from_before_the_connections_map_still_opens() {
        let directory = TempDir::new().expect("temporary directory");
        let path = directory.path().join("settings.json");
        fs::write(
            &path,
            r#"{
                "version": 1,
                "ai": {
                    "connectionType": "openai-compatible",
                    "name": "My server",
                    "baseUrl": "http://127.0.0.1:8080/v1",
                    "model": "chosen.gguf",
                    "api": "openai-completions",
                    "modelName": "Chosen",
                    "contextWindow": 65536,
                    "maxTokens": 8192,
                    "reasoning": true,
                    "supportsReasoningEffort": true,
                    "chatTemplateThinking": true,
                    "thinkingLevels": ["low", "medium", "high"],
                    "input": ["text", "image"],
                    "thinkingLevel": "medium",
                    "maxRetries": 1,
                    "timeoutMs": 90000,
                    "compactionPercent": 75,
                    "subagent": {
                        "maxTurns": 9,
                        "connection": {
                            "connectionType": "openai-codex",
                            "model": "gpt-5.4-mini",
                            "modelName": "GPT-5.4 mini",
                            "contextWindow": 272000,
                            "maxTokens": 128000,
                            "reasoning": true,
                            "supportsReasoningEffort": true,
                            "thinkingLevels": [],
                            "input": ["text"],
                            "thinkingLevel": "low"
                        }
                    },
                    "web": {"searchProvider": "brave"},
                    "local": {
                        "name": "My server",
                        "baseUrl": "http://127.0.0.1:8080/v1",
                        "model": "stale.gguf",
                        "api": "openai-completions",
                        "modelName": "Stale",
                        "contextWindow": 4096,
                        "maxTokens": 4096,
                        "reasoning": false,
                        "supportsReasoningEffort": false,
                        "chatTemplateThinking": false,
                        "thinkingLevels": [],
                        "input": ["text"],
                        "thinkingLevel": "off"
                    },
                    "chatgpt": {
                        "name": "ChatGPT subscription",
                        "baseUrl": "https://chatgpt.com/backend-api",
                        "model": "gpt-5.6-terra",
                        "api": "openai-codex-responses",
                        "modelName": "GPT-5.6 Terra",
                        "contextWindow": 272000,
                        "maxTokens": 128000,
                        "reasoning": true,
                        "supportsReasoningEffort": true,
                        "thinkingLevels": [],
                        "input": ["text", "image"],
                        "thinkingLevel": "high"
                    },
                    "openrouter": {
                        "name": "OpenRouter",
                        "baseUrl": "https://openrouter.ai/api/v1",
                        "model": "z-ai/glm-5.2:free",
                        "api": "openai-completions",
                        "modelName": "GLM 5.2",
                        "contextWindow": 256000,
                        "maxTokens": 8000,
                        "reasoning": false,
                        "supportsReasoningEffort": false,
                        "thinkingLevels": [],
                        "input": ["text"],
                        "thinkingLevel": "off"
                    }
                },
                "godot": {"strictTyping": false, "embedGameWindow": true}
            }"#,
        )
        .expect("write an older settings file");

        let loaded = read_settings_from_paths(&path, None).expect("an older file still opens");

        // The flat fields were the original and the slot was the copy, so the original wins.
        let local = live(&loaded);
        assert_eq!(local.name, "My server");
        assert_eq!(local.base_url, "http://127.0.0.1:8080/v1");
        assert_eq!(local.model.id, "chosen.gguf");
        assert_eq!(local.model.name, "Chosen");
        assert_eq!(local.model.context_window, 65_536);
        assert_eq!(local.model.max_tokens, 8_192);
        assert!(local.model.reasoning);
        assert!(local.chat_template_thinking);
        assert_eq!(local.model.thinking_levels, ["low", "medium", "high"]);
        assert_eq!(local.model.input, ["text", "image"]);
        assert_eq!(local.model.thinking_level, "medium");

        // The two drivers it was not on came out of their slots unchanged.
        let openrouter = loaded
            .ai
            .connection_for(AiConnectionType::Openrouter)
            .expect("the OpenRouter connection");
        assert_eq!(openrouter.model.id, "z-ai/glm-5.2:free");
        assert_eq!(openrouter.model.context_window, 256_000);
        assert_eq!(
            loaded.ai.connection_for(AiConnectionType::OpenaiCodex),
            Some(&default_chatgpt_profile())
        );

        // The sub-agent's model was an id with its facts beside it, and is a `ModelChoice` now.
        let child = loaded
            .ai
            .subagent
            .connection
            .as_ref()
            .expect("the sub-agent connection");
        assert_eq!(child.connection_type, AiConnectionType::OpenaiCodex);
        assert_eq!(child.model.id, "gpt-5.4-mini");
        assert_eq!(child.model.name, "GPT-5.4 mini");
        assert_eq!(child.model.max_tokens, 128_000);
        assert_eq!(child.model.thinking_level, "low");

        // And nothing else the user chose moved.
        assert_eq!(loaded.ai.max_retries, 1);
        assert_eq!(loaded.ai.timeout_ms, 90_000);
        assert_eq!(loaded.ai.compaction_percent, 75);
        assert_eq!(loaded.ai.subagent.max_turns, 9);
        assert_eq!(loaded.ai.subagent.stream_inactivity_minutes, 10);
        assert_eq!(loaded.ai.web.search_provider, "brave");
        assert!(!loaded.godot.strict_typing);

        // Written back in the new shape — one map, and no flat copy of anything in it — and read
        // back as the very same value.
        write_settings_to_path(&path, &loaded).expect("write the migrated settings");
        let written: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).expect("settings contents"))
                .expect("settings as json");
        let ai = written["ai"].as_object().expect("the ai settings");
        assert!(ai.contains_key("connections"));
        for gone in [
            "name",
            "baseUrl",
            "model",
            "api",
            "modelName",
            "local",
            "chatgpt",
        ] {
            assert!(!ai.contains_key(gone), "{gone} is still written to disk");
        }
        assert_eq!(
            read_settings_from_paths(&path, None).expect("the migrated file reopens"),
            loaded
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
        blank_name
            .ai
            .connections
            .get_mut(&AiConnectionType::OpenaiCompatible)
            .expect("the local connection")
            .name = "  ".to_owned();
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

    /// One rule in three languages, held to itself here.
    ///
    /// `thinking_levels` and `keep_level` are the Rust copies of `thinkingLevelsFor` and
    /// `keepThinkingLevel` in `src/models/settings.ts`, and they run on every read and every save.
    /// Left un-taught about `reasoning_mandatory`, this copy went on offering `off` for a model
    /// that answers HTTP 400 to it and went on preserving a stored `off` the settings page would
    /// no longer show — three copies of one rule, one of them quietly disagreeing.
    #[test]
    fn a_model_that_cannot_stop_thinking_is_never_offered_off() {
        let named = ["max".to_owned(), "high".to_owned(), "low".to_owned()];

        assert_eq!(
            thinking_levels(true, true, false, &named),
            ["off", "max", "high", "low"]
        );
        assert_eq!(
            thinking_levels(true, true, true, &named),
            ["max", "high", "low"]
        );
        // And with nothing named, the whole scale minus the one position it does not have.
        assert!(
            !thinking_levels(true, true, true, &[])
                .iter()
                .any(|l| l == "off")
        );
        assert_eq!(thinking_levels(true, false, true, &[]), ["on"]);
        // A model that does not reason at all is `off` and nothing else, mandatory or not: there
        // is no reasoning for the flag to be about.
        assert_eq!(thinking_levels(false, true, true, &named), ["off"]);

        // The stored level a mandatory model cannot use becomes the cheapest one it can — `low`,
        // not `max`, which is what its own list happens to put first.
        assert_eq!(keep_level("off", true, true, true, &named), "low");
        assert_eq!(keep_level("medium", true, true, true, &named), "low");
        assert_eq!(keep_level("high", true, true, true, &named), "high");
        // Wherever `off` is offered, this is the answer it always gave.
        assert_eq!(keep_level("medium", true, true, false, &named), "off");
        assert_eq!(keep_level("off", true, true, false, &named), "off");
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
        // Under the reserve its window leaves, so the catalogue's own number stands.
        assert_eq!(plain.max_tokens, 131_072);
        assert!(!plain.reasoning);
        assert!(!plain.supports_reasoning_effort);
        assert!(plain.thinking_levels.is_empty());
        assert_eq!(plain.input, ["text"]);

        // A null ceiling falls back to what the window leaves, not to the window — and never to
        // zero, which would fail validation. See `ceiling_within`.
        assert_eq!(options[1].max_tokens, 35_840);
        assert_eq!(options[1].input, ["text", "image"]);

        // A mandatory reasoner names its efforts and never names `none`.
        let mandatory = &options[2];
        assert!(mandatory.reasoning);
        assert!(mandatory.supports_reasoning_effort);
        assert_eq!(
            mandatory.thinking_levels,
            ["xhigh", "high", "medium", "low", "minimal"]
        );
        // And it says so, which is the whole difference between `off` being a quieter setting and
        // `off` being a connection that answers HTTP 400 to every request it makes.
        assert!(mandatory.reasoning_mandatory);

        // `none` is OpenRouter's word for "can be switched off", not an effort. `off` is prepended
        // by the menu itself, and passing `none` through would put a level in the settings file
        // that `EVERY_LEVEL` does not contain.
        let optional = &options[3];
        assert_eq!(optional.thinking_levels, ["max", "high", "low"]);
        assert!(!optional.reasoning_mandatory);
        // A model with no reasoning block at all is not mandatory either — the field is read off
        // the block, and `is_some_and` on an absent one is false rather than a panic.
        assert!(!plain.reasoning_mandatory);
        // Pi types a model's input as text or image and nothing else. Video and file have nowhere
        // to go, and an empty list would fail validation.
        assert_eq!(optional.input, ["text"]);
    }

    /// OpenRouter's address is corrected, not trusted, and saving it leaves the others alone.
    #[test]
    fn an_openrouter_connection_is_pinned_and_kept_beside_the_others() {
        let mut settings = GoferSettings::default();
        settings.ai.connection_type = AiConnectionType::Openrouter;
        let stored = settings
            .ai
            .connections
            .get_mut(&AiConnectionType::Openrouter)
            .expect("the OpenRouter connection");
        stored.name = "OpenRouter".to_owned();
        stored.model.id = "nvidia/nemotron-3.5-lightning:free".to_owned();
        // A hand-edited file pointing this driver at somebody else's server would send the
        // OpenRouter key there. It is put back rather than refused.
        stored.base_url = "https://not-openrouter.example/v1".to_owned();
        stored.api = ApiDialect::OpenaiCodexResponses;
        stored.chat_template_thinking = true;

        let saved = validate_settings(settings).expect("an OpenRouter connection is valid");
        assert_eq!(live(&saved).base_url, OPENROUTER_BASE_URL);
        assert_eq!(live(&saved).api, ApiDialect::OpenaiCompletions);
        assert!(!live(&saved).chat_template_thinking);
        // Stored under its own driver, and the other two are untouched.
        assert_eq!(live(&saved).model.id, "nvidia/nemotron-3.5-lightning:free");
        assert_eq!(
            saved.ai.connection_for(AiConnectionType::OpenaiCompatible),
            Some(&default_local_profile())
        );
        assert_eq!(
            saved.ai.connection_for(AiConnectionType::OpenaiCodex),
            Some(&default_chatgpt_profile())
        );
    }

    /// The Cerebras catalogue, which is the live list narrowed by the table Gofer ships.
    ///
    /// Narrowed in both directions, and both are the point. A model the endpoint serves that the
    /// table has never measured is dropped — every fact a picker needs about it would have to be
    /// guessed, and a guessed ceiling is a connection whose every request fails on a number nobody
    /// checked. A model the table names that the key cannot reach is not invented: pi-ai's own
    /// bundled Cerebras file still lists `zai-glm-4.7`, which answers HTTP 404 `model_archived`,
    /// and a picker offering it would offer a model no request can use.
    #[test]
    fn the_cerebras_catalogue_is_narrowed_to_what_gofer_has_facts_for() {
        let live: ModelsResponse = serde_json::from_str(
            r#"{"data": [
                {"id": "gpt-oss-120b"},
                {"id": "gemma-4-31b"},
                {"id": "some-model-shipped-after-this-build"}
            ]}"#,
        )
        .expect("Cerebras answers the plain OpenAI shape");
        let options = cerebras_model_options(&live.data);

        // The unmeasured one is gone, and the two measured ones are in the table's order.
        let ids: Vec<&str> = options.iter().map(|o| o.id.as_str()).collect();
        assert_eq!(ids, vec!["gpt-oss-120b", "gemma-4-31b"]);

        let oss = &options[0];
        assert_eq!(oss.name, "GPT OSS 120B");
        // The endpoint's own number, from the body it refuses an oversized prompt with. Not
        // 131,072: the two models on this endpoint do not share a window.
        assert_eq!(oss.context_window, 131_000);
        // Cerebras declares no output ceiling, so the table repeats the window and this is what
        // actually bounds a reply. A ceiling that is the whole window is not a ceiling.
        assert_eq!(oss.max_tokens, ceiling_within(131_000, Some(131_000)));
        assert!(oss.max_tokens < oss.context_window);
        assert_eq!(oss.input, vec!["text".to_owned()]);
        assert!(oss.reasoning);
        assert!(oss.supports_reasoning_effort);
        // Its chat template refuses `reasoning_effort: "none"`, so it cannot be told to stop and
        // has no word for stopping either. The two facts travel together or `off` is offered for a
        // model that would ignore it.
        assert!(oss.reasoning_mandatory);
        assert_eq!(oss.off_effort, None);
        assert_eq!(
            oss.thinking_levels,
            vec!["low".to_owned(), "medium".to_owned(), "high".to_owned()]
        );

        let gemma = &options[1];
        assert_eq!(gemma.context_window, 131_072);
        assert_eq!(gemma.input, vec!["text".to_owned(), "image".to_owned()]);
        // The other half of the pair: this one honours `none`, so `off` sends it and means it.
        assert!(!gemma.reasoning_mandatory);
        assert_eq!(gemma.off_effort.as_deref(), Some("none"));

        // A table row the key cannot reach is not offered either.
        let one: ModelsResponse =
            serde_json::from_str(r#"{"data": [{"id": "gemma-4-31b"}]}"#).expect("one model");
        let narrowed = cerebras_model_options(&one.data);
        assert_eq!(narrowed.len(), 1);
        assert_eq!(narrowed[0].id, "gemma-4-31b");

        // And a key that reaches nothing Gofer knows offers nothing rather than everything.
        let none: ModelsResponse =
            serde_json::from_str(r#"{"data": [{"id": "unknown"}]}"#).expect("one unknown model");
        assert!(cerebras_model_options(&none.data).is_empty());
    }

    /// A driver added after a settings file was written is still offered to that file.
    ///
    /// The bug this pins: `default_connections` runs only for a file that has none, and the legacy
    /// mirror block only for a file whose `connections` map is empty. So an install written before
    /// Cerebras existed loaded three connections, `driverOptions` offered three drivers, and the
    /// fourth could never be selected in order to be configured — invisible on every machine that
    /// had ever saved settings, and visible only on a fresh one. Measured against the developer's
    /// own file, which held exactly `openai-compatible`, `openai-codex` and `openrouter`.
    #[test]
    fn a_settings_file_written_before_a_driver_existed_still_offers_it() {
        let older = serde_json::json!({
            "connectionType": "openai-compatible",
            "connections": {
                "openai-compatible": {
                    "name": "My server",
                    "baseUrl": "http://127.0.0.1:9999/v1",
                    "api": "openai-completions",
                    "chatTemplateThinking": false,
                    "model": {"id": "mine", "contextWindow": 8192, "maxTokens": 1024}
                },
                "openai-codex": {
                    "name": "My ChatGPT",
                    "baseUrl": "https://chatgpt.com/backend-api",
                    "api": "openai-codex-responses",
                    "chatTemplateThinking": false,
                    "model": {"id": "gpt-5.6-terra", "contextWindow": 272000, "maxTokens": 128000}
                }
            }
        });
        let ai: AiSettings = serde_json::from_value::<AiSettingsFile>(older)
            .expect("an older settings file parses")
            .into();

        assert_eq!(
            ai.connection_for(AiConnectionType::Cerebras),
            Some(&default_cerebras_profile())
        );
        assert_eq!(
            ai.connection_for(AiConnectionType::Openrouter),
            Some(&default_openrouter_profile())
        );
        // What the file did say is left exactly as it said it. The fill-in must never overwrite a
        // connection the user configured, which is the whole risk of filling any in.
        let local = ai
            .connection_for(AiConnectionType::OpenaiCompatible)
            .expect("the file's own local connection");
        assert_eq!(local.name, "My server");
        assert_eq!(local.base_url, "http://127.0.0.1:9999/v1");
        assert_eq!(local.model.id, "mine");
        // And a hosted one the file *did* name is its own, not the shipped seed.
        assert_eq!(
            ai.connection_for(AiConnectionType::OpenaiCodex)
                .expect("the file's own ChatGPT connection")
                .name,
            "My ChatGPT"
        );
    }

    /// Cerebras' address is pinned the same way OpenRouter's is, and for the same reason.
    #[test]
    fn a_cerebras_connection_is_pinned_and_kept_beside_the_others() {
        let mut settings = GoferSettings::default();
        settings.ai.connection_type = AiConnectionType::Cerebras;
        let stored = settings
            .ai
            .connections
            .get_mut(&AiConnectionType::Cerebras)
            .expect("the Cerebras connection");
        // A hand-edited file pointing this driver at somebody else's server would send the Cerebras
        // key there. It is put back rather than refused.
        stored.base_url = "https://not-cerebras.example/v1".to_owned();
        stored.api = ApiDialect::OpenaiCodexResponses;
        stored.chat_template_thinking = true;

        let saved = validate_settings(settings).expect("a Cerebras connection is valid");
        assert_eq!(live(&saved).base_url, CEREBRAS_BASE_URL);
        assert_eq!(live(&saved).api, ApiDialect::OpenaiCompletions);
        assert!(!live(&saved).chat_template_thinking);
        // The other three are untouched, OpenRouter's own pinning included.
        assert_eq!(
            saved.ai.connection_for(AiConnectionType::OpenaiCompatible),
            Some(&default_local_profile())
        );
        assert_eq!(
            saved.ai.connection_for(AiConnectionType::Openrouter),
            Some(&default_openrouter_profile())
        );
    }

    /// The shipped Cerebras seed survives its own validation, which is not a given.
    ///
    /// A default that trips a repair is a settings file that is rewritten the first time it is
    /// read. Two ways this one could: a ceiling that is the whole window, and — because this seed
    /// is the model that cannot stop thinking — a stored level of `off`, which is the one value
    /// that makes its every request fail.
    #[test]
    fn the_shipped_cerebras_seed_is_one_its_own_rules_accept() {
        let seed = default_cerebras_profile();
        let mut validated = seed.clone();
        validate_connection(&mut validated).expect("the shipped seed is valid");
        assert_eq!(validated, seed);
        assert!(seed.model.max_tokens < seed.model.context_window);
        let offered = thinking_levels(
            seed.model.reasoning,
            seed.model.supports_reasoning_effort,
            seed.model.reasoning_mandatory,
            &seed.model.thinking_levels,
        );
        assert!(!offered.contains(&"off".to_owned()));
        assert!(offered.contains(&seed.model.thinking_level));
    }

    /// A word for not thinking is dropped where nothing could send it.
    ///
    /// The only new thing a hand-edited settings file can put here. Left in place, a blank word is
    /// one nothing can write, and a word on a model that takes no effort field at all is one
    /// nothing will read — both would put a provider's private vocabulary on the wire for a
    /// connection that has no use for it.
    #[test]
    fn a_word_for_not_thinking_survives_only_where_it_can_be_sent() {
        let mut kept = default_cerebras_profile().model;
        kept.off_effort = Some("none".to_owned());
        kept.supports_reasoning_effort = true;
        validate_model_choice(&mut kept, "Model").expect("a sendable word is kept");
        assert_eq!(kept.off_effort.as_deref(), Some("none"));

        let mut blank = kept.clone();
        blank.off_effort = Some("   ".to_owned());
        validate_model_choice(&mut blank, "Model").expect("a blank word is dropped, not refused");
        assert_eq!(blank.off_effort, None);

        let mut unreadable = kept.clone();
        unreadable.supports_reasoning_effort = false;
        validate_model_choice(&mut unreadable, "Model").expect("an unreadable word is dropped");
        assert_eq!(unreadable.off_effort, None);
    }

    /// The sub-agent may run on OpenRouter, and it takes OpenRouter's key rather than the AI one.
    #[test]
    fn a_subagent_on_openrouter_is_reached_with_its_own_key() {
        let mut settings = AiSettings::default();
        settings.subagent.connection = Some(SubagentConnection {
            connection_type: AiConnectionType::Openrouter,
            model: ModelChoice {
                id: "z-ai/glm-5.2:free".to_owned(),
                name: "GLM 5.2".to_owned(),
                context_window: 256_000,
                max_tokens: 8_000,
                reasoning: true,
                supports_reasoning_effort: true,
                reasoning_mandatory: false,
                thinking_levels: vec!["xhigh".to_owned(), "high".to_owned()],
                input: vec!["text".to_owned()],
                off_effort: None,
                thinking_level: "high".to_owned(),
            },
        });

        let connection = docs_expansion_connection(
            &settings,
            Some("local-key".to_owned()),
            Some("openrouter-key".to_owned()),
            None,
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
        assert_eq!(live(&defaults).model.id, "vision-model");
        assert_eq!(live(&defaults).model.context_window, 8_192);
        assert!(live(&defaults).model.supports_reasoning_effort);

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
        let ai = connection("http://127.0.0.1:8080/v1", "/models/Qwen3.8-27B-NVFP4.gguf");

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
        let elsewhere = connection("http://127.0.0.1:9999/v1", "mystery.gguf");
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
        let mut local = connection("http://127.0.0.1:8080/v1", "old.gguf");
        local.model.name = "Old Model".to_owned();
        local.model.reasoning = true;
        local.model.supports_reasoning_effort = true;
        local.model.thinking_level = "medium".to_owned();
        local.model.max_tokens = 200_000;
        let mut ai = settings_on(AiConnectionType::OpenaiCompatible, local).ai;
        ai.subagent.connection = Some(SubagentConnection {
            connection_type: AiConnectionType::OpenaiCompatible,
            model: ModelChoice {
                id: "old.gguf".to_owned(),
                name: "Old Model".to_owned(),
                context_window: 200_000,
                max_tokens: 200_000,
                reasoning: true,
                supports_reasoning_effort: true,
                reasoning_mandatory: false,
                thinking_levels: Vec::new(),
                input: vec!["text".to_owned(), "image".to_owned()],
                off_effort: None,
                thinking_level: "high".to_owned(),
            },
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

        let local = ai
            .connection_for(AiConnectionType::OpenaiCompatible)
            .expect("the local connection");
        let child = ai.subagent.connection.as_ref().expect("the sub-agent");
        for model in [&local.model, &child.model] {
            assert_eq!(model.id, "/models/new.gguf", "the id the server answers to");
            assert_eq!(model.name, "/models/new.gguf");
            assert!(
                !model.supports_reasoning_effort,
                "the loaded template takes no effort"
            );
            assert_eq!(
                model.thinking_level, "off",
                "so there is no level to be asked at"
            );
            assert_eq!(
                model.context_window, 120_064,
                "the window the host was started with"
            );
            assert_eq!(
                model.max_tokens, 16_809,
                "and a ceiling inside it — clamping to the window itself is no ceiling at all"
            );
            assert_eq!(model.input, ["text".to_owned()], "and no pictures");
        }
        assert!(
            local.model.reasoning,
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
        let mut chosen = connection("http://127.0.0.1:8080/v1", "chosen.gguf");
        chosen.model.reasoning = true;
        chosen.model.supports_reasoning_effort = true;
        chosen.model.thinking_level = "medium".to_owned();
        let mut ai = settings_on(AiConnectionType::OpenaiCompatible, chosen).ai;
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

    /// A local catalogue at OpenRouter's address does not get to answer for OpenRouter's model.
    ///
    /// Both sources here are keyed by address and nothing else, and `validate_settings` pins the
    /// OpenRouter connection's address to a constant — so a `~/.pi/agent/models.json` naming a
    /// provider there collides exactly, on every read and every save. Resolving it would collapse
    /// an unnamed model's two thinking flags to that provider's single boolean, and `keep_level`
    /// would then drop the level the user chose down to `off`.
    #[test]
    fn a_local_catalogue_does_not_answer_for_a_hosted_model() {
        let mut hosted = default_openrouter_profile();
        hosted.model.id = "z-ai/glm-5.2".to_owned();
        hosted.model.name = "GLM 5.2".to_owned();
        hosted.model.reasoning = true;
        hosted.model.supports_reasoning_effort = true;
        hosted.model.thinking_level = "high".to_owned();
        let mut ai = settings_on(AiConnectionType::Openrouter, hosted).ai;
        let before = ai.clone();

        // A Pi provider that happens to sit at the address OpenRouter is pinned to, and a llama.cpp
        // host answering at the same one. Neither knows this model.
        let catalog = PiCatalog {
            models: Vec::new(),
            servers: HashMap::from([(OPENROUTER_BASE_URL.to_owned(), false)]),
        };
        let served = HashMap::from([(
            OPENROUTER_BASE_URL.to_owned(),
            ServedModel {
                id: "z-ai/glm-5.2".to_owned(),
                context_window: Some(4_096),
                reasoning: false,
                efforts: Vec::new(),
                input: Some(vec!["text".to_owned()]),
                sole: true,
            },
        )]);

        resolve_model_facts(&mut ai, &catalog, &served);

        assert_eq!(ai, before, "a local catalogue answered for a hosted model");
    }

    /// A server that does not answer `/props` leaves every written copy exactly as it was.
    #[test]
    fn a_server_with_nothing_to_say_changes_nothing() {
        let mut stale = connection("http://127.0.0.1:8080/v1", "old.gguf");
        stale.model.reasoning = true;
        stale.model.supports_reasoning_effort = true;
        stale.model.thinking_level = "medium".to_owned();
        let mut ai = settings_on(AiConnectionType::OpenaiCompatible, stale).ai;
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
        let stored = live_mut(&mut stale);
        stored.model.reasoning = false;
        stored.model.supports_reasoning_effort = false;
        stored.model.thinking_level = "off".to_owned();
        let stored = stored.model.clone();
        stale.ai.subagent.connection = Some(SubagentConnection {
            connection_type: AiConnectionType::OpenaiCompatible,
            model: ModelChoice {
                name: "/models/served.gguf".to_owned(),
                context_window: 120_064,
                max_tokens: 120_064,
                input: vec!["text".to_owned()],
                ..stored.clone()
            },
        });
        fs::write(
            &path,
            serde_json::to_string(&stale).expect("serialize settings"),
        )
        .expect("write settings");

        let loaded = read_settings_from_paths(&path, Some(&pi)).expect("read settings");

        // The connection the driver runs on.
        let local = live(&loaded);
        assert!(local.model.reasoning);
        assert!(local.model.supports_reasoning_effort);
        // And the sub-agent's own, which is a second model rather than a second copy of this one.
        let child = loaded
            .ai
            .subagent
            .connection
            .as_ref()
            .expect("sub-agent connection");
        assert!(child.model.reasoning);
        assert!(child.model.supports_reasoning_effort);

        // What the user owns is untouched. Only what the model decides is re-derived.
        assert_eq!(local.model.id, "/models/served.gguf");
        assert_eq!(local.model.context_window, stored.context_window);
        // And what the catalogue does not know, it does not answer. A server's declared reasoning
        // says nothing about what a model it has never described accepts, so the stored input
        // stands — inventing `["text", "image"]` here turns the composer's image control on and
        // ships pictures to a server that refuses them.
        assert_eq!(local.model.input, stored.input);
        assert_eq!(local.model.name, stored.name);
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
        let stored = live_mut(&mut stale);
        stored.model.reasoning = true;
        stored.model.supports_reasoning_effort = true;
        stored.model.thinking_level = "high".to_owned();
        fs::write(
            &path,
            serde_json::to_string(&stale).expect("serialize settings"),
        )
        .expect("write settings");

        let loaded = read_settings_from_paths(&path, Some(&pi)).expect("read settings");

        assert!(!live(&loaded).model.reasoning);
        assert!(!live(&loaded).model.supports_reasoning_effort);
        // A level pointing at nothing is not left standing.
        assert_eq!(live(&loaded).model.thinking_level, "off");
        assert_eq!(live(&loaded).model.name, "Plain");
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
        let chosen = live_mut(&mut stored);
        chosen.model.reasoning = true;
        chosen.model.supports_reasoning_effort = true;
        chosen.model.thinking_level = "high".to_owned();
        fs::write(
            &path,
            serde_json::to_string(&stored).expect("serialize settings"),
        )
        .expect("write settings");

        let loaded = read_settings_from_paths(&path, Some(&pi)).expect("read settings");

        assert!(live(&loaded).model.reasoning);
        assert_eq!(live(&loaded).model.thinking_level, "high");
        // And the ChatGPT connection, which Pi's file never describes, keeps everything it had.
        let chatgpt = loaded
            .ai
            .connection_for(AiConnectionType::OpenaiCodex)
            .expect("the ChatGPT connection");
        assert!(chatgpt.model.reasoning);
        assert!(chatgpt.model.supports_reasoning_effort);
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
        // And not 4,096. A ceiling equal to the window is no ceiling, and this is the endpoint the
        // runaway was measured on.
        assert_eq!(models[0].max_tokens, 1_024);
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
                live_mut(&mut value).name = "x".repeat(101);
                value
            },
            {
                let mut value = settings("http://localhost", "model");
                live_mut(&mut value).model.id = "x".repeat(513);
                value
            },
            {
                let mut value = settings("http://localhost", "model");
                live_mut(&mut value).model.name = "x".repeat(513);
                value
            },
            {
                let mut value = settings("http://localhost", "model");
                live_mut(&mut value).model.input = Vec::new();
                value
            },
            {
                let mut value = settings("http://localhost", "model");
                live_mut(&mut value).model.input = vec!["text".to_owned(); 17];
                value
            },
            {
                let mut value = settings("http://localhost", "model");
                live_mut(&mut value).model.input = vec![String::new()];
                value
            },
            {
                let mut value = settings("http://localhost", "model");
                live_mut(&mut value).model.context_window = 0;
                value
            },
            {
                let mut value = settings("http://localhost", "model");
                live_mut(&mut value).model.max_tokens = 0;
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
                live_mut(&mut value).model.thinking_level = "impossible".to_owned();
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
            // The sub-agent's seven ceilings, which nothing in Rust bounded: the slider was the
            // only thing enforcing them, and a hand-edited settings file never touches a slider.
            {
                let mut value = settings("http://localhost", "model");
                value.ai.subagent.command_timeout_minutes = 31;
                value
            },
            {
                let mut value = settings("http://localhost", "model");
                value.ai.subagent.stream_inactivity_minutes = 31;
                value
            },
            {
                let mut value = settings("http://localhost", "model");
                value.ai.subagent.max_turns = 100_000;
                value
            },
            {
                let mut value = settings("http://localhost", "model");
                value.ai.subagent.max_answer_chars = 24_001;
                value
            },
            {
                let mut value = settings("http://localhost", "model");
                value.ai.subagent.retry_attempts = 6;
                value
            },
            // Zero is the one floor that is not zero: the wait is read only when a retry happens,
            // and a retry that waits for nothing is not a retry policy.
            {
                let mut value = settings("http://localhost", "model");
                value.ai.subagent.retry_base_delay_seconds = 0;
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

        // The four answers a connection test's key is read by, held once against every slot rather
        // than written out per slot. OpenRouter's copy of this used to be its own function, which
        // is what made it the credential module's coverage gap in the first place.
        let store = FakeSecrets::default();
        for secret in [
            Secret::AiDefault,
            Secret::OpenRouter,
            Secret::Cerebras,
            Secret::Brave,
        ] {
            assert_eq!(resolve(&ApiKeyUpdate::Clear, secret, &store), Ok(None));
            assert_eq!(
                resolve(
                    &ApiKeyUpdate::Set {
                        value: "  sk-or-v1-key  ".to_owned()
                    },
                    secret,
                    &store,
                ),
                Ok(Some("sk-or-v1-key".to_owned()))
            );
            assert!(
                resolve(
                    &ApiKeyUpdate::Set {
                        value: " ".to_owned()
                    },
                    secret,
                    &store,
                )
                .is_err()
            );
            assert!(
                resolve(
                    &ApiKeyUpdate::Set {
                        value: "x".repeat(MAX_API_KEY_BYTES + 1)
                    },
                    secret,
                    &store,
                )
                .is_err()
            );
            // `Keep` is the stored key of *that* slot, which is the whole reason the slot is an
            // argument: a test that sent the local key to openrouter.ai would pass without it.
            store.put(secret, secret.username());
            assert_eq!(
                resolve(&ApiKeyUpdate::Keep, secret, &store),
                Ok(Some(secret.username().to_owned()))
            );
        }
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
        settings
            .ai
            .connections
            .get_mut(&AiConnectionType::OpenaiCompatible)
            .expect("the local connection")
            .base_url = base_url.to_owned();
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

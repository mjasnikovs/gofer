//! The shapes a settings file has been written in, and what each one becomes.
//!
//! No build writes any of this. Every type here is a `Deserialize`-only mirror of a live type in
//! the parent, kept so that a file written by an older Gofer still opens — and the `From` impls
//! beside them are the whole of the migration.
//!
//! Split out for one reason: sitting forty lines under `AiSettings` and `AiConnectionProfile`,
//! `AiSettingsFile` and `AiConnectionProfileFile` read as the live types at a glance, and a field
//! added to one of them has to be added to its twin here or it is silently dropped on the next
//! read. A file of its own says which half of the pair a reader is looking at.

use super::*;

/// A model as a settings file names it, in either of the two shapes one has ever been written in.
///
/// The shape this build writes is the model and its facts together. The shape before it was an id
/// with its facts scattered beside it, in whichever struct the id happened to sit in — which is why
/// this is one type rather than three: the reading is the same wherever it happens.
#[derive(Deserialize)]
#[serde(untagged)]
pub(super) enum StoredModel {
    Chosen(ModelChoice),
    Id(String),
}

/// The facts a flat settings file scattered beside a model id, all of them optional.
///
/// Read, never written. `AiSettings`, `AiConnectionProfile` and `SubagentConnection` all serialize
/// as themselves; this is only what an older file has to be understood as.
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ModelChoiceFile {
    model_name: Option<String>,
    context_window: Option<u64>,
    max_tokens: Option<u64>,
    reasoning: Option<bool>,
    supports_reasoning_effort: Option<bool>,
    thinking_levels: Option<Vec<String>>,
    input: Option<Vec<String>>,
    thinking_level: Option<String>,
}

impl ModelChoiceFile {
    /// The model this file names, whichever of the two shapes it named it in.
    fn choice(self, model: StoredModel) -> ModelChoice {
        match model {
            StoredModel::Chosen(chosen) => chosen,
            StoredModel::Id(id) => ModelChoice {
                name: self
                    .model_name
                    .filter(|name| !name.trim().is_empty())
                    .unwrap_or_else(|| id.clone()),
                id,
                context_window: self.context_window.unwrap_or_else(default_context_window),
                max_tokens: self.max_tokens.unwrap_or_else(default_max_tokens),
                reasoning: self.reasoning.unwrap_or_default(),
                supports_reasoning_effort: self.supports_reasoning_effort.unwrap_or_default(),
                // A file written before the field. Nothing in that shape ever named a hosted
                // catalogue, so nothing it can hold refuses to stop thinking.
                reasoning_mandatory: false,
                thinking_levels: self.thinking_levels.unwrap_or_default(),
                input: self.input.unwrap_or_else(default_model_input),
                off_effort: None,
                thinking_level: self.thinking_level.unwrap_or_else(default_thinking_level),
            },
        }
    }
}

/// One connection as a settings file holds it, in either shape.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AiConnectionProfileFile {
    name: String,
    base_url: String,
    api: ApiDialect,
    #[serde(default)]
    chat_template_thinking: bool,
    model: StoredModel,
    #[serde(flatten)]
    model_fields: ModelChoiceFile,
}

impl From<AiConnectionProfileFile> for AiConnectionProfile {
    fn from(file: AiConnectionProfileFile) -> Self {
        Self {
            name: file.name,
            base_url: file.base_url,
            api: file.api,
            chat_template_thinking: file.chat_template_thinking,
            model: file.model_fields.choice(file.model),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SubagentConnectionFile {
    connection_type: AiConnectionType,
    model: StoredModel,
    #[serde(flatten)]
    model_fields: ModelChoiceFile,
}

impl From<SubagentConnectionFile> for SubagentConnection {
    fn from(file: SubagentConnectionFile) -> Self {
        Self {
            connection_type: file.connection_type,
            model: file.model_fields.choice(file.model),
        }
    }
}

/// The settings file as every Gofer before the connections map wrote it.
///
/// The live connection was flattened onto `ai` and mirrored into a slot named after its driver, and
/// the flat half was the original: a save wrote it first and copied it second. So the flat half is
/// read last here, over the slot it was mirrored into, and the mirror is dropped rather than
/// merged. This is the only code left that knows either shape existed.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AiSettingsFile {
    connection_type: AiConnectionType,
    /// Present in every file this build writes, and in none written before it.
    #[serde(default)]
    connections: Option<BTreeMap<AiConnectionType, AiConnectionProfile>>,
    name: Option<String>,
    base_url: Option<String>,
    api: Option<ApiDialect>,
    #[serde(default)]
    chat_template_thinking: bool,
    model: Option<StoredModel>,
    #[serde(default)]
    local: Option<AiConnectionProfile>,
    #[serde(default)]
    chatgpt: Option<AiConnectionProfile>,
    #[serde(default)]
    openrouter: Option<AiConnectionProfile>,
    #[serde(default)]
    cerebras: Option<AiConnectionProfile>,
    #[serde(default = "default_max_retries")]
    max_retries: u32,
    #[serde(default = "default_timeout_ms")]
    timeout_ms: u64,
    #[serde(default = "default_compaction_percent")]
    compaction_percent: u32,
    #[serde(default)]
    subagent: SubagentSettings,
    #[serde(default)]
    web: WebSettings,
    #[serde(flatten)]
    model_fields: ModelChoiceFile,
}

impl From<AiSettingsFile> for AiSettings {
    fn from(file: AiSettingsFile) -> Self {
        let mut connections = file.connections.unwrap_or_default();
        if connections.is_empty() {
            for (driver, mirrored) in [
                (AiConnectionType::OpenaiCompatible, file.local),
                (AiConnectionType::OpenaiCodex, file.chatgpt),
                (AiConnectionType::Openrouter, file.openrouter),
                (AiConnectionType::Cerebras, file.cerebras),
            ] {
                if let Some(profile) = mirrored {
                    connections.insert(driver, profile);
                }
            }
            // Last, so the original wins over the copy of itself. See the note above.
            if let Some(model) = file.model {
                connections.insert(
                    file.connection_type,
                    AiConnectionProfile {
                        name: file.name.unwrap_or_default(),
                        base_url: file.base_url.unwrap_or_default(),
                        api: file.api.unwrap_or(ApiDialect::OpenaiCompletions),
                        chat_template_thinking: file.chat_template_thinking,
                        model: file.model_fields.choice(model),
                    },
                );
            }
        }
        // Every hosted driver this build knows, filled in where the file names none.
        //
        // Not only for a file that has no connections at all. A driver with no connection is not
        // offered in the picker, and a driver that is not offered can never be selected in order
        // to be configured — so a driver added after a settings file was written would be
        // permanently invisible to every existing install, which is what happened the first time
        // this was left to `default_connections` alone. Insert only where absent: what the user
        // has configured is theirs, and this must never write over it.
        for (driver, shipped) in [
            (
                AiConnectionType::OpenaiCodex,
                default_chatgpt_profile as fn() -> _,
            ),
            (AiConnectionType::Openrouter, default_openrouter_profile),
            (AiConnectionType::Cerebras, default_cerebras_profile),
        ] {
            connections.entry(driver).or_insert_with(shipped);
        }
        Self {
            connection_type: file.connection_type,
            connections,
            max_retries: file.max_retries,
            timeout_ms: file.timeout_ms,
            compaction_percent: file.compaction_percent,
            subagent: file.subagent,
            web: file.web,
        }
    }
}

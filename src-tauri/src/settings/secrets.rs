//! The secret half of the settings: the OS credential store, and what crosses to the renderer.
//!
//! Split out of `settings.rs`, which held six subjects in one file. This is the one with a seam of
//! its own: [`Secrets`] is the store, [`SystemSecrets`] is the machine's, and every function that
//! reads or writes a key has a twin taking one — so the tests drive the real rules against a fake
//! store and never touch the keyring of the machine they run on.
//!
//! `settings_response` and the two `saved_secrets` halves are here rather than beside the other
//! wire types because all three are about what a key *is not*: the renderer is told whether a slot
//! is filled, never what fills it, and a failed save has to put back exactly what it displaced.
//!
//! Most of this is `pub(super)`. The tests are the parent's, and moving 2,800 lines of them was not
//! part of the split; what is `pub(crate)` is what the rest of the crate really calls.

use super::*;

// GENERATED-BEGIN secrets sha256:634582cff522bced
impl Secret {
    /// The word a request and a response key this secret by.
    pub(crate) const fn id(self) -> &'static str {
        match self {
            Self::AiDefault => "ai-default",
            Self::Brave => "brave",
            Self::OpenRouter => "openrouter",
            Self::Cerebras => "cerebras",
            Self::ChatGpt => "chat-gpt",
        }
    }

    /// The username this secret is stored under, beneath the one service. A second
    /// username is how one keyring holds more than one secret.
    pub(super) const fn username(self) -> &'static str {
        match self {
            Self::AiDefault => "ai-default",
            Self::Brave => "web-brave-search",
            Self::OpenRouter => "ai-openrouter",
            Self::Cerebras => "ai-cerebras",
            Self::ChatGpt => "ai-openai-codex",
        }
    }

    /// What this secret is called in the one sentence a user ever reads about it.
    pub(super) const fn noun(self) -> &'static str {
        match self {
            Self::AiDefault => "AI API key",
            Self::Brave => "Brave Search key",
            Self::OpenRouter => "OpenRouter API key",
            Self::Cerebras => "Cerebras API key",
            Self::ChatGpt => "ChatGPT credential",
        }
    }

    /// What an empty box means, which is not the same answer for all of them.
    pub(super) const fn blank(self) -> Blank {
        match self {
            Self::AiDefault => Blank::Refused,
            Self::Brave => Blank::Clears,
            Self::OpenRouter => Blank::Clears,
            Self::Cerebras => Blank::Clears,
            Self::ChatGpt => Blank::Refused,
        }
    }

    /// Whether a request carries a bearer token from this, or a login writes it.
    pub(crate) const fn is_api_key(self) -> bool {
        match self {
            Self::AiDefault => true,
            Self::Brave => true,
            Self::OpenRouter => true,
            Self::Cerebras => true,
            Self::ChatGpt => false,
        }
    }

    /// The secret one wire word names, or nothing when the word names none.
    pub(crate) fn from_id(word: &str) -> Option<Self> {
        match word {
            "ai-default" => Some(Self::AiDefault),
            "brave" => Some(Self::Brave),
            "openrouter" => Some(Self::OpenRouter),
            "cerebras" => Some(Self::Cerebras),
            "chat-gpt" => Some(Self::ChatGpt),
            _ => None,
        }
    }

    /// Every secret Gofer keeps, in the order a save writes them.
    pub(crate) const ORDER: [Self; 5] = [
        Self::AiDefault,
        Self::Brave,
        Self::OpenRouter,
        Self::Cerebras,
        Self::ChatGpt,
    ];
}

/// The one credential a driver authenticates with.
///
/// A key sent to the wrong address is a key handed to a machine that was never meant to
/// see it. This pairing was a match here, a second match in `catalogue.rs`, a table in a
/// React file and two record literals in a hook; it is one row of `protocol/drivers.json`
/// now, and every one of those is a lookup.
pub(crate) const fn driver_secret(driver: AiConnectionType) -> Secret {
    match driver {
        AiConnectionType::OpenaiCompatible => Secret::AiDefault,
        AiConnectionType::OpenaiCodex => Secret::ChatGpt,
        AiConnectionType::Openrouter => Secret::OpenRouter,
        AiConnectionType::Cerebras => Secret::Cerebras,
    }
}
// GENERATED-END secrets

/// One spelling on the wire, and it is the generated one — so a key sent in a request and a slot
/// reported in a response are the same word as the row they both come from.
impl Serialize for Secret {
    fn serialize<S: serde::Serializer>(&self, out: S) -> Result<S::Ok, S::Error> {
        out.serialize_str(self.id())
    }
}

impl<'de> Deserialize<'de> for Secret {
    fn deserialize<D: serde::Deserializer<'de>>(input: D) -> Result<Self, D::Error> {
        let word = String::deserialize(input)?;
        Self::from_id(&word)
            .ok_or_else(|| serde::de::Error::custom(format!("{word} names no secret Gofer keeps")))
    }
}

pub(super) fn required_value(name: &str, value: String) -> Result<String, String> {
    let value = value.trim().to_owned();
    if value.is_empty() {
        return Err(format!("{name} is required"));
    }
    Ok(value)
}

pub(super) fn credential_entry(username: &str) -> Result<Entry, String> {
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
pub(super) fn entry_in_a_store(username: &str) -> Result<Option<Entry>, String> {
    let _initialization = KEYRING_INITIALIZATION
        .lock()
        .map_err(|_| "The credential-store initialization lock is poisoned".to_owned())?;
    match Entry::new(API_KEY_SERVICE, username) {
        Ok(entry) => Ok(Some(entry)),
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
pub(super) const NO_CREDENTIAL_STORE: &str = "This machine has no credential store, so Gofer cannot keep a key on it. On Linux that is a \
     Secret Service provider — GNOME Keyring or KWallet — and Gofer needs one running to hold a \
     key.";

/// One secret Gofer keeps, and everything that is particular to it.
///
/// Four secrets used to be four hand-copied implementations of one idea: a keyring slot, a noun for
/// the sentence a failure is reported in, and what an empty box means. Only one of them went
/// through a seam a test could drive, so the two with the *other* blank rule were the two nothing
/// held to it. This carries the three differences, and everything else is written once.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub(crate) enum Secret {
    /// The AI key of the local, OpenAI-compatible driver.
    AiDefault,
    /// The Brave Search key. In the keyring rather than in `settings.json`, on the same reasoning
    /// as the AI key: the settings file is plain text a person may copy, diff or paste into a bug
    /// report, and a search key is a credential. Nothing is an ordinary state, not a fault — the
    /// two other engines need no key, and `web_search` says so itself when Brave is chosen
    /// without one.
    Brave,
    OpenRouter,
    Cerebras,
    ChatGpt,
}

/// What empty text means for one secret, which is not the same answer for all five.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum Blank {
    /// Refused. The AI key's box is the connection's own field, and saving a connection with a
    /// blank key would silently take the key off a server that needs one.
    Refused,
    /// Takes the key off the machine. Emptying the field and saving is how a person removes a key
    /// they typed, and an empty entry left behind reads as a configured key every request is then
    /// rejected for.
    Clears,
}

/// Where the five secrets are kept. The seam, and it takes the slot.
///
/// It used to take none: one implementation was hardcoded to `ai-default` and the other three
/// reached past it to the keyring, so a test could drive one flag of the four.
pub(crate) trait Secrets {
    fn clear(&self, secret: Secret) -> Result<(), String>;
    fn read(&self, secret: Secret) -> Result<Option<String>, String>;
    fn write(&self, secret: Secret, value: &str) -> Result<(), String>;
}

pub(crate) struct SystemSecrets;

/// Whether this build is under a driver that has been told to leave the real store alone.
///
/// All three methods, not just the read. A skip on one half is worse than no skip at all: the run
/// writes its own test key into the developer's `ai-default` slot and then reads back nothing, so
/// `write_one_secret` records no previous value — and a settings save that fails afterwards
/// restores by *clearing* the slot. The developer's own key is gone, from a test that was supposed
/// not to touch it.
#[cfg(feature = "webdriver")]
pub(super) fn store_is_skipped(secret: Secret) -> bool {
    matches!(secret, Secret::AiDefault)
        && std::env::var_os("GOFER_WEBDRIVER_SKIP_CREDENTIAL_STORE").is_some()
}

impl Secrets for SystemSecrets {
    fn clear(&self, secret: Secret) -> Result<(), String> {
        #[cfg(feature = "webdriver")]
        if store_is_skipped(secret) {
            return Ok(());
        }
        match credential_entry(secret.username())?.delete_credential() {
            Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
            Err(error) => Err(format!("Could not remove the {}: {error}", secret.noun())),
        }
    }

    fn read(&self, secret: Secret) -> Result<Option<String>, String> {
        #[cfg(feature = "webdriver")]
        if store_is_skipped(secret) {
            return Ok(None);
        }
        let Some(entry) = entry_in_a_store(secret.username())? else {
            return Ok(None);
        };
        match entry.get_password() {
            Ok(value) if matches!(secret.blank(), Blank::Clears) && value.trim().is_empty() => {
                Ok(None)
            }
            Ok(value) => Ok(Some(value)),
            Err(KeyringError::NoEntry) => Ok(None),
            Err(error) => Err(format!(
                "Could not read the {} from the credential store: {error}",
                secret.noun()
            )),
        }
    }

    fn write(&self, secret: Secret, value: &str) -> Result<(), String> {
        #[cfg(feature = "webdriver")]
        if store_is_skipped(secret) {
            return Ok(());
        }
        credential_entry(secret.username())?
            .set_password(value)
            .map_err(|error| format!("Could not store the {}: {error}", secret.noun()))
    }
}

pub(crate) fn stored_chatgpt_credential() -> Result<Option<serde_json::Value>, String> {
    chatgpt_credential_in(&SystemSecrets)
}

/// The stored ChatGPT credential, parsed. The one secret that is not a key: it is an OAuth grant,
/// so what comes out of the slot has to be readable as one before it counts as stored at all.
pub(super) fn chatgpt_credential_in(
    secrets: &impl Secrets,
) -> Result<Option<serde_json::Value>, String> {
    let Some(value) = secrets.read(Secret::ChatGpt)? else {
        return Ok(None);
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
    SystemSecrets.write(Secret::ChatGpt, &serialized)
}

pub(crate) fn clear_chatgpt_credential() -> Result<(), String> {
    SystemSecrets.clear(Secret::ChatGpt)
}

pub(crate) fn settings_response(settings: GoferSettings) -> SettingsResponse {
    #[cfg(feature = "webdriver")]
    if std::env::var_os("GOFER_WEBDRIVER_RAG_READY").is_some() {
        return SettingsResponse {
            settings,
            stored_secrets: nothing_is_held(),
            credential_store_error: None,
        };
    }
    settings_response_with(&SystemSecrets, settings)
}

/// Which of the four the machine is holding, every one of them read through the one store.
///
/// Three of these flags used to reach past the injected store to the real keyring, so a test could
/// drive one of the four — and not either of the two whose blank rule differs.
pub(super) fn settings_response_with(
    secrets: &impl Secrets,
    settings: GoferSettings,
) -> SettingsResponse {
    let ai_default = match secrets.read(Secret::AiDefault) {
        Err(error) => {
            return SettingsResponse {
                settings,
                stored_secrets: nothing_is_held(),
                credential_store_error: Some(error),
            };
        }
        Ok(held) => held.is_some(),
    };
    SettingsResponse {
        settings,
        stored_secrets: Secret::ORDER
            .into_iter()
            .map(|secret| {
                let held = match secret {
                    Secret::ChatGpt => chatgpt_credential_in(secrets).ok().flatten().is_some(),
                    Secret::AiDefault => ai_default,
                    _ => secrets.read(secret).ok().flatten().is_some(),
                };
                (secret, held)
            })
            .collect(),
        credential_store_error: None,
    }
}

/// Every slot reported empty, which is what a machine with no credential store can honestly say.
fn nothing_is_held() -> BTreeMap<Secret, bool> {
    Secret::ORDER
        .into_iter()
        .map(|secret| (secret, false))
        .collect()
}

/// Every API key the machine is holding, keyed by its slot.
///
/// A caller that needs one asks the pairing which, rather than reading three named keys and
/// handing all three to a function that picks. A slot the store cannot answer for is absent, which
/// is the same thing as empty to everything that reads this.
pub(crate) fn stored_api_keys(secrets: &impl Secrets) -> BTreeMap<Secret, String> {
    Secret::ORDER
        .into_iter()
        .filter(|secret| secret.is_api_key())
        .filter_map(|secret| Some((secret, secrets.read(secret).ok().flatten()?)))
        .collect()
}

/// One slot a save wrote, and what was in it beforehand. See [`apply_saved_secrets`].
pub(crate) struct WrittenSecret {
    secret: Secret,
    previous: Option<String>,
}

/// The secrets a settings save carries, in the order they are written.
///
/// Every slot but the OAuth one: a ChatGPT credential is written by its login rather than typed
/// into a box, so a save that named it would be saying something the settings page cannot mean.
pub(super) fn saved_secrets(request: &SettingsRequest) -> Vec<(Secret, &ApiKeyUpdate)> {
    Secret::ORDER
        .into_iter()
        .filter(|secret| secret.is_api_key())
        .map(|secret| (secret, request.update(secret)))
        .collect()
}

/// Writes every secret a save carries, and answers with the slots it actually wrote.
///
/// The answer is the rollback window: a settings file that then fails to write must leave the
/// machine as it found it, and what has to be put back is exactly what was taken out. It used to be
/// the AI key alone, with the other two written before the window and two hand-written comments
/// explaining why the AI key's restore could not put them back. It could not because it was the AI
/// key's; a restore that names its slot has no such problem.
pub(crate) fn apply_saved_secrets(request: &SettingsRequest) -> Result<Vec<WrittenSecret>, String> {
    apply_saved_secrets_with(&SystemSecrets, request)
}

pub(super) fn apply_saved_secrets_with(
    secrets: &impl Secrets,
    request: &SettingsRequest,
) -> Result<Vec<WrittenSecret>, String> {
    let mut written = Vec::new();
    for (secret, update) in saved_secrets(request) {
        if matches!(update, ApiKeyUpdate::Keep) {
            continue;
        }
        match write_one_secret(secret, update, secrets) {
            Ok(slot) => written.push(slot),
            Err(failure) => {
                let _ = restore_saved_secrets_with(secrets, &written);
                return Err(failure);
            }
        }
    }
    Ok(written)
}

/// One slot: what was in it, and what the save puts there.
pub(super) fn write_one_secret(
    secret: Secret,
    update: &ApiKeyUpdate,
    secrets: &impl Secrets,
) -> Result<WrittenSecret, String> {
    let previous = secrets.read(secret)?;
    apply(update, secret, secrets)?;
    Ok(WrittenSecret { secret, previous })
}

/// Puts back what [`apply_saved_secrets`] took out, slot by slot.
pub(crate) fn restore_saved_secrets(written: &[WrittenSecret]) -> Result<(), String> {
    restore_saved_secrets_with(&SystemSecrets, written)
}

pub(super) fn restore_saved_secrets_with(
    secrets: &impl Secrets,
    written: &[WrittenSecret],
) -> Result<(), String> {
    for slot in written {
        restore(slot.secret, slot.previous.as_deref(), secrets)?;
    }
    Ok(())
}

// coverage-critical-start: credential
/// The three-way rule a settings page's key box is saved by, for any of the four secrets.
///
/// `Keep` is what an untouched box means, because the page never reads a stored secret back and so
/// cannot send one. `Clear` is the removal button. `Set` is typed text — and blank typed text is
/// the one place the four differ: see [`Blank`].
pub(super) fn apply(
    update: &ApiKeyUpdate,
    secret: Secret,
    secrets: &impl Secrets,
) -> Result<(), String> {
    match update {
        ApiKeyUpdate::Keep => Ok(()),
        ApiKeyUpdate::Set { value } => {
            let value = value.trim();
            if value.is_empty() {
                return match secret.blank() {
                    Blank::Refused => {
                        Err("API key cannot be empty when setting a credential".to_owned())
                    }
                    Blank::Clears => secrets.clear(secret),
                };
            }
            if value.len() > MAX_API_KEY_BYTES {
                return Err("API keys cannot exceed 16 KiB".to_owned());
            }
            secrets.write(secret, value)
        }
        ApiKeyUpdate::Clear => secrets.clear(secret),
    }
}

/// Puts one slot back the way it was, which for a slot that held nothing is emptying it.
pub(super) fn restore(
    secret: Secret,
    value: Option<&str>,
    secrets: &impl Secrets,
) -> Result<(), String> {
    match value {
        Some(value) => secrets
            .write(secret, value)
            .map_err(|error| format!("Could not restore the previous {}: {error}", secret.noun())),
        None => secrets.clear(secret),
    }
}

/// The key a connection test should send, which is the typed one or the stored one.
///
/// Not [`apply`]: nothing is written here. Blank typed text is refused for every secret, because a
/// test of a blank credential is a test of nothing — the removal button is what says "no key".
pub(super) fn resolve(
    update: &ApiKeyUpdate,
    secret: Secret,
    secrets: &impl Secrets,
) -> Result<Option<String>, String> {
    match update {
        ApiKeyUpdate::Keep => Ok(secrets.read(secret).unwrap_or(None)),
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

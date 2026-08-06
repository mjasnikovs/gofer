//! The one shape a failed command comes back in.
//!
//! A command that rejects with a bare string tells the renderer that something went wrong and
//! nothing else. It cannot tell an ordinary state — no session yet, a turn already running — from a
//! fault, so every failure is drawn the same way: as an error the user is expected to do something
//! about. The session, RPC, debug-adapter and approval surfaces have carried a code since they were
//! written, and the renderer already branches on it; this is that same wire shape, for the
//! commands that were still answering in prose.
//!
//! `From<String>` keeps the internals as they are. A helper deep in storage or retrieval still
//! returns a sentence, `?` lifts it here, and the command that owns the boundary is where the code
//! is chosen — because that is the only place that knows which situation the sentence describes.

use serde::Serialize;
use serde_json::{Value, json};

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandError {
    /// A stable, machine-readable name for the situation. Never shown to the user.
    pub code: &'static str,
    /// One sentence for the user. It names what failed, not where on the disk it lives.
    pub message: String,
    /// Whether running the same command again could succeed without the user changing anything.
    pub retryable: bool,
    pub details: Value,
}

impl CommandError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            retryable: false,
            details: json!({}),
        }
    }

    /// Marks a failure worth trying again as it stands — a timeout, a server that was not up yet.
    pub fn retryable(mut self) -> Self {
        self.retryable = true;
        self
    }

    /// Lifts a helper's sentence into a coded failure at the command that owns it.
    pub fn coded(code: &'static str) -> impl Fn(String) -> Self {
        move |message| Self::new(code, message)
    }
}

impl From<String> for CommandError {
    /// The fallback for a sentence nobody has classified yet: still one shape, still parseable,
    /// and still honest about carrying no more information than the prose did.
    fn from(message: String) -> Self {
        Self::new("command_failed", message)
    }
}

impl std::fmt::Display for CommandError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_unclassified_sentence_keeps_its_words_and_gains_a_code() {
        let error = CommandError::from("The cache could not be read".to_owned());
        assert_eq!(error.code, "command_failed");
        assert_eq!(error.message, "The cache could not be read");
        assert!(!error.retryable);
    }

    #[test]
    fn a_command_names_the_situation_its_helper_could_not() {
        let error = CommandError::coded("models_unavailable")("No cache".to_owned()).retryable();
        assert_eq!(error.code, "models_unavailable");
        assert!(error.retryable);
    }

    #[test]
    fn the_renderer_receives_the_same_four_fields_the_session_surface_sends() {
        let json = serde_json::to_value(CommandError::new("settings_unreadable", "Nope"))
            .expect("a command error serializes");
        assert_eq!(json["code"], "settings_unreadable");
        assert_eq!(json["message"], "Nope");
        assert_eq!(json["retryable"], false);
        assert_eq!(json["details"], json!({}));
    }
}

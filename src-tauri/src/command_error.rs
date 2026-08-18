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
//! returns a sentence, and `?` lifts it here.
//!
//! What chooses the code is whatever last knew which situation the sentence describes, and that is
//! not always the command. The Ledger's five views answer with this type themselves: a command
//! reading a chat can say the read failed, but only `Chats` knows the read was a chat's. Eighteen
//! `map_err(coded(…))` calls in `lib.rs` were that knowledge written at the caller, one guess per
//! command; they are `?` now. A command still chooses the code for the work it does itself.
//!
//! Every registered command now rejects with one of the eight coded types, and
//! `scripts/check-command-surface.mjs` refuses a new one that rejects with a bare `String`. So
//! `command_failed` has stopped meaning "one of ours that did not say" and means only what the
//! renderer invents for a transport fault or a thrown `Error` — something that never reached a
//! command at all.

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

    /// Names a failure that arrived as prose, and leaves alone one that already named itself.
    ///
    /// The Ledger's internals answer with this type now, so most failures arrive classified where
    /// they happened: a task that is not there is `task_not_found`, a database another process is
    /// holding is `database_locked`. A method used to choose one code for all of them — a missing
    /// task, a locked file and a corrupt row all reached the renderer as `chat_unavailable` — so
    /// the renderer could not tell a task to route away from one worth trying again.
    pub fn or_coded(code: &'static str) -> impl Fn(Self) -> Self {
        move |failure| {
            if failure.code == UNCLASSIFIED {
                Self { code, ..failure }
            } else {
                failure
            }
        }
    }

    /// Attaches what the renderer needs to offer a way out, rather than only a sentence about it.
    pub fn with_details(mut self, details: Value) -> Self {
        self.details = details;
        self
    }
}

/// The code a sentence nobody has classified carries. [`CommandError::or_coded`] replaces it.
pub const UNCLASSIFIED: &str = "command_failed";

impl From<String> for CommandError {
    /// The fallback for a sentence nobody has classified yet: still one shape, still parseable,
    /// and still honest about carrying no more information than the prose did.
    fn from(message: String) -> Self {
        Self::new(UNCLASSIFIED, message)
    }
}

impl From<CommandError> for String {
    /// For the callers that still answer in prose. The code is dropped deliberately: a `String` has
    /// nowhere to keep it, and pretending otherwise by folding it into the sentence would put a
    /// machine name in front of the user.
    fn from(failure: CommandError) -> Self {
        failure.message
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

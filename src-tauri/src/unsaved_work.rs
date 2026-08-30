//! What the editor is still holding, and what the user decided to do about it.
//!
//! Every operation that moves the project's one checkout stops the editor first, and stopping it is
//! `get_tree().quit()` — the editor's own quit, which neither asks about unsaved scenes nor writes
//! them. A person who had been painting a tilemap and pressed Merge lost that work with nothing
//! anywhere saying so. Gofer's own `dirty` flag could not have warned them either: it counts the
//! mutations Gofer made, so a scene edited by hand in the editor is clean by it.
//!
//! `EditorInterface.get_unsaved_scenes` is the editor's own answer and the only one that covers
//! both. This module asks it, and turns the user's answer into either a save, a refusal that names
//! the scenes, or nothing at all.
//!
//! Scenes, and only scenes. A `.tres` open in the inspector or an unsaved script in Godot's own
//! script editor is not in that list, and no editor API offers one.

use serde::Deserialize;
use serde_json::{Value, json};

use crate::command_error::CommandError;
use crate::godot_rpc::{CallRequest, RpcError, RpcSession};
use crate::godot_session;

/// The code a refusal carries, and what the window branches on to open its dialog.
pub const UNSAVED_WORK: &str = "godot_unsaved_scenes";

/// Saving every open scene of a large project writes real files; the default request timeout is for
/// commands that only read the tree.
const SAVE_TIMEOUT_MS: u64 = 30_000;

/// What the user said to do about work the editor has not written.
///
/// `Ask` is the default because it is what a press of Merge means before anyone has been asked: the
/// merge is refused, the scenes are named, and the window puts the question. The other two are the
/// answers to that question coming back.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum UnsavedWork {
    #[default]
    Ask,
    Save,
    Discard,
}

/// What settling the editor takes, given the answer and what the editor is holding.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Settlement {
    /// Nothing is being held, or the user chose to lose it. Carry on.
    Proceed,
    /// Write every open scene before anything moves.
    Save,
    /// Refuse, and name the scenes so the window can ask about them.
    Refuse(Vec<String>),
}

/// The decision, with no editor in it.
///
/// Separated from the call so the rule can be tested without a Godot process: which answer leads
/// where is the part that decides whether work is lost.
pub(crate) fn settlement(answer: UnsavedWork, holding: &[String]) -> Settlement {
    if holding.is_empty() {
        return Settlement::Proceed;
    }
    match answer {
        UnsavedWork::Ask => Settlement::Refuse(holding.to_vec()),
        UnsavedWork::Save => Settlement::Save,
        UnsavedWork::Discard => Settlement::Proceed,
    }
}

/// The sentence the user reads when a merge is refused for work the editor is holding.
fn refusal(scenes: &[String]) -> String {
    format!(
        "The Godot editor is still holding changes you have not saved:\n{}\nMerging stops the \
         editor, and the editor does not save on its way out — so this work would be lost.",
        scenes
            .iter()
            .map(|scene| format!("  {scene}"))
            .collect::<Vec<_>>()
            .join("\n")
    )
}

/// Settles the editor's unsaved work, or refuses with the scenes it is holding.
///
/// An answer of `Discard` never asks the editor anything. It is the one answer that needs no
/// reading and no writing, and an editor that has stopped answering is exactly when a user says to
/// throw the work away — a refusal on the way to a discard would be a wedged editor blocking the
/// only escape from it.
pub fn settle(answer: UnsavedWork) -> Result<(), CommandError> {
    if answer == UnsavedWork::Discard {
        return Ok(());
    }
    let Some(rpc) = godot_session::rpc_session() else {
        return Ok(());
    };
    let holding = unsaved_scenes(&rpc).map_err(unreachable_editor)?;
    match settlement(answer, &holding) {
        Settlement::Proceed => Ok(()),
        Settlement::Save => {
            save_all_scenes(&rpc).map_err(unreachable_editor)?;
            Ok(())
        }
        Settlement::Refuse(scenes) => Err(CommandError::new(UNSAVED_WORK, refusal(&scenes))
            .with_details(json!({"scenes": scenes}))),
    }
}

/// An editor that would not answer is not permission to move the checkout: whatever it is holding
/// is still in there, and the reply the window gets has to say so rather than name a transport.
fn unreachable_editor(error: RpcError) -> CommandError {
    CommandError::new(
        "godot_unsaved_scenes_unknown",
        format!(
            "The Godot editor did not answer about unsaved work, so nothing was moved: {}",
            error.message
        ),
    )
}

/// The scenes the editor is holding changes to.
fn unsaved_scenes(rpc: &RpcSession) -> Result<Vec<String>, RpcError> {
    let answer = rpc.call(CallRequest::new("session.get_unsaved_scenes", json!({})))?;
    Ok(scene_list(&answer.result, "scenes"))
}

/// Writes them, and answers with what was written. The addon reads the editor back before it says
/// so, which is why an error here means nothing landed rather than that the report was lost.
fn save_all_scenes(rpc: &RpcSession) -> Result<Vec<String>, RpcError> {
    let answer = rpc.call(
        CallRequest::new("session.save_all_scenes", json!({})).within(Some(SAVE_TIMEOUT_MS)),
    )?;
    Ok(scene_list(&answer.result, "saved"))
}

fn scene_list(result: &Value, key: &str) -> Vec<String> {
    result
        .get(key)
        .and_then(Value::as_array)
        .map(|scenes| {
            scenes
                .iter()
                .filter_map(|scene| scene.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn holding() -> Vec<String> {
        vec!["res://levels/forest.tscn".to_owned()]
    }

    /// The question is only worth putting when there is something to lose.
    #[test]
    fn an_editor_holding_nothing_settles_whatever_the_answer_is() {
        for answer in [UnsavedWork::Ask, UnsavedWork::Save, UnsavedWork::Discard] {
            assert_eq!(settlement(answer, &[]), Settlement::Proceed, "{answer:?}");
        }
    }

    /// Nobody has been asked yet, so the merge stops and the scenes come back with it.
    #[test]
    fn work_nobody_has_been_asked_about_refuses_and_names_it() {
        assert_eq!(
            settlement(UnsavedWork::Ask, &holding()),
            Settlement::Refuse(holding())
        );
    }

    #[test]
    fn the_two_answers_either_write_the_work_or_let_it_go() {
        assert_eq!(settlement(UnsavedWork::Save, &holding()), Settlement::Save);
        assert_eq!(
            settlement(UnsavedWork::Discard, &holding()),
            Settlement::Proceed
        );
    }

    /// The refusal is what the user reads, so it has to name the files rather than count them.
    #[test]
    fn the_refusal_names_every_scene() {
        let message = refusal(&["res://a.tscn".to_owned(), "res://b.tscn".to_owned()]);
        assert!(message.contains("res://a.tscn"), "{message}");
        assert!(message.contains("res://b.tscn"), "{message}");
    }

    /// An addon reply that is not the shape this expects is no scenes, not a panic.
    #[test]
    fn a_reply_without_a_list_is_no_scenes() {
        assert!(scene_list(&json!({}), "scenes").is_empty());
        assert!(scene_list(&json!({"scenes": "res://a.tscn"}), "scenes").is_empty());
        assert_eq!(
            scene_list(&json!({"scenes": ["res://a.tscn", 7]}), "scenes"),
            vec!["res://a.tscn".to_owned()]
        );
    }

    /// The wire spelling the window sends, which is the whole contract with `merge_task_branch`.
    #[test]
    fn the_answers_are_spelled_as_the_window_sends_them() {
        for (spelling, answer) in [
            ("\"ask\"", UnsavedWork::Ask),
            ("\"save\"", UnsavedWork::Save),
            ("\"discard\"", UnsavedWork::Discard),
        ] {
            assert_eq!(
                serde_json::from_str::<UnsavedWork>(spelling).expect(spelling),
                answer
            );
        }
        assert!(serde_json::from_str::<UnsavedWork>("\"keep\"").is_err());
    }
}

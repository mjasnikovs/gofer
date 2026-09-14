//! The project board's three doors: the window's commands, the worker's `board` tool, and the
//! one event that tells the window something changed through any of them.
//!
//! Like `remember`, deliberately not a [`crate::ai_tools::CATALOG`] domain: the catalogue is
//! Godot domains with an addon handler, and this is a host operation over the Ledger.

use serde::Deserialize;
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Runtime};

use crate::ai_tools::ToolFailure;
use crate::ask::MAIN_WINDOW;
use crate::command_error::CommandError;
use crate::storage::{Actor, CardDetail, CardEdit, CardRecord, CardStatus, NewCard};

/// The board, by the name the worker sends it under.
pub const BOARD_TOOL: &str = "board";

/// Who Gofer's own worker is on a card. The window writes as `user`.
pub const WORKER_OWNER: &str = "gofer";
const USER_OWNER: &str = "user";

/// Fired after any write through any door, with no payload: the window refetches.
pub const CHANGED_EVENT: &str = "board-changed";

pub(crate) fn announce_change<R: Runtime>(app: &AppHandle<R>) {
    let _ = app.emit_to(MAIN_WINDOW, CHANGED_EVENT, ());
}

/// The worker as an actor. It is the turn, so nothing is in progress from where it stands.
const WORKER: Actor = Actor::Tool {
    turn_running: false,
};

/// A client of the MCP door, which is locked out of a card the model is working on right now.
pub(crate) fn outside_actor() -> Actor {
    Actor::Tool {
        turn_running: crate::ai_turn::provider_operation_running(),
    }
}

/// One call from the worker's `board` tool.
#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "lowercase")]
enum BoardCall {
    List,
    Read {
        id: String,
    },
    Create {
        title: String,
        #[serde(default)]
        body: String,
        status: Option<CardStatus>,
    },
    Move {
        id: String,
        status: CardStatus,
    },
    Comment {
        id: String,
        body: String,
    },
    Edit {
        id: String,
        title: Option<String>,
        body: Option<String>,
    },
}

/// Answers the worker's `board` tool, or refuses in a sentence the model can act on.
pub(crate) fn board_tool<R: Runtime>(
    app: &AppHandle<R>,
    params: &Value,
) -> Result<Value, ToolFailure> {
    if params
        .get(crate::ai_tools::PROBE_KEY)
        .and_then(Value::as_bool)
        == Some(true)
    {
        return crate::ai_tools::probe(BOARD_TOOL);
    }
    let call: BoardCall = serde_json::from_value(params.clone()).map_err(|error| {
        ToolFailure::new(
            "invalid_params",
            format!("board needs an `op` of list, read, create, move, comment or edit: {error}"),
        )
    })?;
    let storage = crate::workspace::project_storage(app)
        .map_err(|failure| ToolFailure::new("board_unavailable", failure.message))?;
    let board = storage.board();
    let reads = matches!(call, BoardCall::List | BoardCall::Read { .. });
    let answer = match call {
        BoardCall::List => json!({"cards": board.list()?}),
        BoardCall::Read { id } => json!(board.read(&id)?),
        BoardCall::Create {
            title,
            body,
            status,
        } => {
            let card = NewCard {
                title,
                body,
                owner: WORKER_OWNER.to_owned(),
                status: status.unwrap_or(CardStatus::Backlog),
            };
            json!(board.create(&card, WORKER)?)
        }
        BoardCall::Move { id, status } => json!(board.move_to(&id, status, WORKER)?),
        BoardCall::Comment { id, body } => {
            json!(board.comment(&id, WORKER_OWNER, &body, WORKER)?)
        }
        BoardCall::Edit { id, title, body } => {
            let edit = CardEdit {
                title,
                body,
                owner: None,
            };
            json!(board.edit(&id, &edit, WORKER)?)
        }
    };
    if !reads {
        announce_change(app);
    }
    Ok(answer)
}

#[tauri::command(async)]
pub(crate) fn board_list(app: AppHandle) -> Result<Vec<CardRecord>, CommandError> {
    crate::workspace::project_storage(&app)?.board().list()
}

#[tauri::command(async)]
pub(crate) fn card_read(app: AppHandle, id: String) -> Result<CardDetail, CommandError> {
    crate::workspace::project_storage(&app)?.board().read(&id)
}

/// Makes a card the user wrote. The owner is always the user; the window does not get to say.
#[tauri::command(async)]
pub(crate) fn card_create(
    app: AppHandle,
    title: String,
    body: String,
    status: CardStatus,
) -> Result<CardRecord, CommandError> {
    let card = NewCard {
        title,
        body,
        owner: USER_OWNER.to_owned(),
        status,
    };
    let created = crate::workspace::project_storage(&app)?
        .board()
        .create(&card, Actor::User)?;
    announce_change(&app);
    Ok(created)
}

#[tauri::command(async)]
pub(crate) fn card_move(
    app: AppHandle,
    id: String,
    status: CardStatus,
) -> Result<CardRecord, CommandError> {
    let moved =
        crate::workspace::project_storage(&app)?
            .board()
            .move_to(&id, status, Actor::User)?;
    announce_change(&app);
    Ok(moved)
}

#[tauri::command(async)]
pub(crate) fn card_edit(
    app: AppHandle,
    id: String,
    edit: CardEdit,
) -> Result<CardRecord, CommandError> {
    let edited = crate::workspace::project_storage(&app)?
        .board()
        .edit(&id, &edit, Actor::User)?;
    announce_change(&app);
    Ok(edited)
}

#[tauri::command(async)]
pub(crate) fn card_comment(
    app: AppHandle,
    id: String,
    body: String,
) -> Result<crate::storage::CardComment, CommandError> {
    let comment = crate::workspace::project_storage(&app)?.board().comment(
        &id,
        USER_OWNER,
        &body,
        Actor::User,
    )?;
    announce_change(&app);
    Ok(comment)
}

/// Opens a task for a card and hands the card to it.
///
/// The card is checked before the task is made, so a card that already has one refuses without
/// leaving a task behind. Everything `create_chat_task` says about a running turn and about
/// `bring_changes` holds here too — it is the same switch.
#[tauri::command(async)]
pub(crate) fn card_post_to_gofer(
    app: AppHandle,
    id: String,
    bring_changes: bool,
) -> Result<crate::storage::StoredChat, CommandError> {
    let storage = crate::workspace::project_storage(&app)?;
    let card = storage.board().read(&id)?.card;
    if card.task_id.is_some() {
        return Err(CommandError::new(
            "card_has_task",
            "The card already has a task",
        ));
    }
    if card.status == CardStatus::Done {
        return Err(CommandError::new(
            "card_locked",
            "A finished card is not posted again",
        ));
    }
    let release = crate::switch_for(&app);
    let switch = storage.switch(&release)?;
    let chat = if bring_changes {
        storage.tasks().create_carrying_changes(&switch)?
    } else {
        storage.tasks().create(&switch)?
    };
    let task_id = chat
        .task_id
        .clone()
        .ok_or_else(|| CommandError::from("The new task has no identifier".to_owned()))?;
    storage.board().hand_to_task(&id, &task_id)?;
    announce_change(&app);
    Ok(chat)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai_tools::CATALOG;

    fn mock_app() -> tauri::App<tauri::test::MockRuntime> {
        tauri::test::mock_builder()
            .build(crate::app_context())
            .expect("build mock Tauri app")
    }

    #[test]
    fn the_board_is_not_a_catalog_domain() {
        assert!(
            !CATALOG.iter().any(|domain| domain.name == BOARD_TOOL),
            "board must not be a catalog domain"
        );
        crate::ai_tools::probe(BOARD_TOOL).expect("board answers its own probe");
    }

    #[test]
    fn a_probe_is_answered_without_a_workspace() {
        let app = mock_app();
        let answer =
            board_tool(app.handle(), &json!({"probe": true})).expect("a probe is answered");
        assert_eq!(answer["reachable"], json!(true));
    }

    #[test]
    fn a_call_without_a_known_op_is_refused_before_the_store_is_reached() {
        let app = mock_app();
        let failure = board_tool(app.handle(), &json!({"op": "archive", "id": "x"}))
            .expect_err("archive is not an op");
        assert_eq!(failure.code, "invalid_params");
        assert!(
            failure
                .message
                .contains("list, read, create, move, comment or edit"),
            "the refusal names the ops that do work: {}",
            failure.message
        );
        let missing = board_tool(app.handle(), &json!({"op": "move", "id": "x"}))
            .expect_err("move needs a status");
        assert_eq!(missing.code, "invalid_params");
    }
}

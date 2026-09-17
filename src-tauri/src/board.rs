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
use crate::storage::{Actor, CardComment, CardDetail, CardEdit, CardRecord, CardStatus, NewCard};

/// The board, by the name the worker sends it under.
pub const BOARD_TOOL: &str = "board";

/// Who Gofer's own worker is on a card. The window writes as `user`.
pub const WORKER_OWNER: &str = "gofer";
const USER_OWNER: &str = "user";

/// Fired after any write through any door, with no payload: the window refetches.
pub const CHANGED_EVENT: &str = "board-changed";

/// Fired when a task was made or moved onto by something other than the window — the door
/// opening a card's task — so the task list refetches.
pub const TASKS_EVENT: &str = "tasks-changed";

pub(crate) fn announce_change<R: Runtime>(app: &AppHandle<R>) {
    let _ = app.emit_to(MAIN_WINDOW, CHANGED_EVENT, ());
}

pub(crate) fn announce_tasks_change<R: Runtime>(app: &AppHandle<R>) {
    let _ = app.emit_to(MAIN_WINDOW, TASKS_EVENT, ());
}

/// The worker as an actor. It is the turn, so nothing is in progress from where it stands.
const WORKER: Actor = Actor::Tool {
    turn_running: false,
};

/// A client of the agent door, which is locked out of a card the model is working on right now.
pub(crate) fn outside_actor() -> Actor {
    Actor::Tool {
        turn_running: crate::ai_turn::provider_operation_running(),
    }
}

/// One call from the worker's `board` tool. An `id` left out means the task's own card.
#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "lowercase")]
enum BoardCall {
    List,
    Read {
        id: Option<Value>,
    },
    Create {
        title: String,
        #[serde(default)]
        body: String,
        status: Option<CardStatus>,
    },
    Move {
        id: Option<Value>,
        status: CardStatus,
    },
    Comment {
        id: Option<Value>,
        body: String,
    },
    Edit {
        id: Option<Value>,
        title: Option<String>,
        body: Option<String>,
    },
}

/// The card a tool named, as text for [`crate::storage::Board::resolve`], or `None` when it named
/// none. A blank id counts as none, so a model that fills the field with nothing still means its
/// own card.
pub(crate) fn given_reference(id: Option<&Value>) -> Result<Option<String>, CommandError> {
    match id {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(number)) => Ok(Some(number.to_string())),
        Some(Value::String(text)) if text.trim().is_empty() => Ok(None),
        Some(Value::String(text)) => Ok(Some(text.clone())),
        Some(_) => Err(CommandError::new(
            "invalid_params",
            "`id` is a card's number",
        )),
    }
}

/// A card as a tool reads it: named by its number, without the ids only the window needs.
fn card_view(card: &CardRecord, own: Option<&CardRecord>, with_body: bool) -> Value {
    let mut view = json!({
        "id": card.number,
        "title": card.title,
        "owner": card.owner,
        "status": card.status,
        "commentCount": card.comment_count,
    });
    if with_body {
        view["body"] = json!(card.body);
    }
    if own.is_some_and(|own| own.id == card.id) {
        view["yours"] = json!(true);
    }
    view
}

pub(crate) fn tool_card(card: &CardRecord, own: Option<&CardRecord>) -> Value {
    card_view(card, own, true)
}

/// Bodies stay out: nine full cards already overran the worker's tool-answer cap.
pub(crate) fn tool_list(cards: &[CardRecord], own: Option<&CardRecord>) -> Value {
    let cards: Vec<Value> = cards
        .iter()
        .map(|card| card_view(card, own, false))
        .collect();
    json!({"cards": cards})
}

pub(crate) fn tool_detail(detail: &CardDetail, own: Option<&CardRecord>) -> Value {
    let comments: Vec<Value> = detail
        .comments
        .iter()
        .map(|comment| json!({"author": comment.author, "body": comment.body}))
        .collect();
    json!({
        "card": card_view(&detail.card, own, true),
        "comments": comments,
        "attachments": detail.attachments,
    })
}

pub(crate) fn tool_comment(card: &CardRecord, comment: &CardComment) -> Value {
    json!({"card": card.number, "author": comment.author, "body": comment.body})
}

fn no_card_for_task() -> CommandError {
    CommandError::new(
        "no_card_for_task",
        "This task was not opened from a card: pass the id of a card from list",
    )
}

/// Who writes a card through the tool: the worker as itself, or an outside agent by the name it
/// gave. The name is not a parameter the model sees; the door alone requires it.
enum Writer {
    Worker,
    Outside { owner: String },
}

impl Writer {
    fn owner(&self) -> &str {
        match self {
            Writer::Worker => WORKER_OWNER,
            Writer::Outside { owner } => owner,
        }
    }

    fn actor(&self) -> Actor {
        match self {
            Writer::Worker => WORKER,
            Writer::Outside { .. } => outside_actor(),
        }
    }
}

/// Answers the worker's `board` tool, or refuses in a sentence the model can act on.
pub(crate) fn board_tool<R: Runtime>(
    app: &AppHandle<R>,
    params: &Value,
) -> Result<Value, ToolFailure> {
    board_tool_as(app, params, Writer::Worker)
}

/// The same tool for an agent at the door, which names itself in `owner` on every write.
pub(crate) fn board_tool_from_outside<R: Runtime>(
    app: &AppHandle<R>,
    params: &Value,
) -> Result<Value, ToolFailure> {
    let op = params.get("op").and_then(Value::as_str);
    let reads = matches!(op, Some("list" | "read"));
    // An omitted id means the active task's card to the worker, which is on that task. An outside
    // agent is on no task, and would be writing on whatever card the worker happens to hold.
    if !matches!(op, Some("list" | "create")) && params.get("id").is_none_or(Value::is_null) {
        return Err(ToolFailure::new(
            "invalid_params",
            "`id` is required: the card's number",
        ));
    }
    let owner = params
        .get("owner")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|owner| !owner.is_empty());
    let writer = match owner {
        Some(owner) => Writer::Outside {
            owner: owner.to_owned(),
        },
        None if reads => Writer::Outside {
            owner: String::new(),
        },
        None => {
            return Err(ToolFailure::new(
                "invalid_params",
                "`owner` is required: name yourself on every write",
            ));
        }
    };
    if op == Some("move") && params.get("status").and_then(Value::as_str) == Some("doing") {
        let storage = crate::workspace::project_storage(app)
            .map_err(|failure| ToolFailure::new("board_unavailable", failure.message))?;
        let reference = given_reference(params.get("id"))?
            .ok_or_else(|| ToolFailure::new("invalid_params", "`id` is required"))?;
        let card = storage.board().resolve(&reference)?;
        let bring_changes = params
            .get("bringChanges")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let task = on_the_cards_task(app, &storage, &card, bring_changes)?;
        let mut moved = board_tool_as(app, params, writer)?;
        // The answer says which task the door is in now, so a caller need not ask git.
        if let Some(object) = moved.as_object_mut() {
            object.insert("task".to_owned(), task);
        }
        return Ok(moved);
    }
    board_tool_as(app, params, writer)
}

fn board_tool_as<R: Runtime>(
    app: &AppHandle<R>,
    params: &Value,
    writer: Writer,
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
    let own = board.own_card()?;
    let target = |id: Option<Value>| match given_reference(id.as_ref())? {
        Some(reference) => board.resolve(&reference),
        None => own.clone().ok_or_else(no_card_for_task),
    };
    let reads = matches!(call, BoardCall::List | BoardCall::Read { .. });
    let actor = writer.actor();
    let answer = match call {
        BoardCall::List => tool_list(&board.list()?, own.as_ref()),
        BoardCall::Read { id } => tool_detail(&board.read(&target(id)?.id)?, own.as_ref()),
        BoardCall::Create {
            title,
            body,
            status,
        } => {
            let card = NewCard {
                title,
                body,
                owner: writer.owner().to_owned(),
                status: status.unwrap_or(CardStatus::Backlog),
                attachments: Vec::new(),
            };
            tool_card(&board.create(&card, actor)?, own.as_ref())
        }
        BoardCall::Move { id, status } => tool_card(
            &board.move_to(&target(id)?.id, status, actor)?,
            own.as_ref(),
        ),
        BoardCall::Comment { id, body } => {
            let card = target(id)?;
            tool_comment(
                &card,
                &board.comment(&card.id, writer.owner(), &body, actor)?,
            )
        }
        BoardCall::Edit { id, title, body } => {
            let edit = CardEdit {
                title,
                body,
                owner: None,
                attachments: None,
            };
            tool_card(&board.edit(&target(id)?.id, &edit, actor)?, own.as_ref())
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
    attachments: Vec<crate::storage::StoredAttachment>,
) -> Result<CardRecord, CommandError> {
    let card = NewCard {
        title,
        body,
        owner: USER_OWNER.to_owned(),
        status,
        attachments,
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

/// Only the window deletes: a card is the user's ask, and no tool gets to lose one.
#[tauri::command(async)]
pub(crate) fn card_delete(app: AppHandle, id: String) -> Result<(), CommandError> {
    crate::workspace::project_storage(&app)?
        .board()
        .delete(&id)?;
    announce_change(&app);
    Ok(())
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
    let chat = open_task_for_card(&app, &storage, &id, bring_changes)?;
    announce_change(&app);
    Ok(chat)
}

/// Makes a task for a card and hands the card to it: the one way a card gets a branch.
fn open_task_for_card<R: Runtime>(
    app: &AppHandle<R>,
    storage: &crate::storage::ProjectStorage,
    card_id: &str,
    bring_changes: bool,
) -> Result<crate::storage::StoredChat, CommandError> {
    let release = |workspace: &std::path::Path| crate::leave_task(app, workspace);
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
    storage.board().hand_to_task(card_id, &task_id)?;
    Ok(chat)
}

/// Puts the checkout on the card's task before an outside agent starts on it, making the task
/// when the card has none. Without this the door edited whatever branch was checked out, and the
/// work had no task to review, no diff to read and nothing to merge or abandon.
fn on_the_cards_task<R: Runtime>(
    app: &AppHandle<R>,
    storage: &crate::storage::ProjectStorage,
    card: &CardRecord,
    bring_changes: bool,
) -> Result<Value, ToolFailure> {
    let (task_id, opened) = match &card.task_id {
        None => {
            let chat = open_task_for_card(app, storage, &card.id, bring_changes)?;
            (chat.task_id.unwrap_or_default(), true)
        }
        Some(task_id) => {
            if storage.tasks().active()?.as_deref() != Some(task_id.as_str()) {
                let release = |workspace: &std::path::Path| crate::leave_task(app, workspace);
                let switch = storage.switch(&release)?;
                storage.tasks().activate(task_id, &switch)?;
            }
            (task_id.clone(), false)
        }
    };
    announce_tasks_change(app);
    Ok(json!({
        "id": task_id,
        "opened": opened,
        "broughtChanges": opened && bring_changes,
    }))
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

    #[test]
    fn a_call_with_no_id_works_the_card_its_task_was_opened_from() {
        let directory = tempfile::TempDir::new().expect("temporary directory");
        let app = crate::agent_door::tests::app_with_storage(&directory);
        let storage = crate::workspace::project_storage(app.handle()).expect("storage");
        let refused = board_tool(app.handle(), &json!({"op": "comment", "body": "Done"}))
            .expect_err("no task yet");
        assert_eq!(refused.code, "no_card_for_task");

        let nothing_to_stop = |_: &std::path::Path| Ok(());
        let switch = storage.switch_with_no_turn_to_refuse(&nothing_to_stop);
        let task_id = storage
            .tasks()
            .create(&switch)
            .expect("task")
            .task_id
            .expect("task id");
        let cardless = board_tool(app.handle(), &json!({"op": "move", "status": "review"}))
            .expect_err("a task not opened from a card");
        assert_eq!(cardless.code, "no_card_for_task");
        let new_card = |title: &str| NewCard {
            title: title.to_owned(),
            body: String::new(),
            owner: USER_OWNER.to_owned(),
            status: CardStatus::Backlog,
            attachments: Vec::new(),
        };
        let board = storage.board();
        let other = board.create(&new_card("Other"), Actor::User).expect("card");
        let card = board.create(&new_card("Jump"), Actor::User).expect("card");
        board.attach_task(&card.id, &task_id).expect("attach");

        let listed = board_tool(app.handle(), &json!({"op": "list"})).expect("list");
        assert_eq!(
            listed,
            json!({"cards": [
                {"id": 1, "title": "Other", "owner": "user", "status": "backlog", "commentCount": 0},
                {"id": 2, "title": "Jump", "owner": "user", "status": "doing", "commentCount": 0, "yours": true}
            ]})
        );
        let comment = board_tool(
            app.handle(),
            &json!({"op": "comment", "id": "", "body": "Done"}),
        )
        .expect("comment on the own card");
        assert_eq!(
            comment,
            json!({"card": 2, "author": "gofer", "body": "Done"})
        );
        let edited = board_tool(app.handle(), &json!({"op": "edit", "body": "Higher"}))
            .expect("edit the own card");
        assert_eq!(
            (edited["id"].clone(), edited["body"].clone()),
            (json!(2), json!("Higher"))
        );
        let reviewed = board_tool(app.handle(), &json!({"op": "move", "status": "review"}))
            .expect("move the own card");
        assert_eq!(
            (reviewed["id"].clone(), reviewed["status"].clone()),
            (json!(2), json!("review"))
        );
        let as_text = board_tool(app.handle(), &json!({"op": "read", "id": "true"}))
            .expect_err("pi hands a boolean id over as text");
        assert_eq!(as_text.code, "card_not_found");
        let wrong_type = board_tool(app.handle(), &json!({"op": "read", "id": true}))
            .expect_err("not a card reference");
        assert_eq!(wrong_type.code, "invalid_params");

        let moved = board_tool(
            app.handle(),
            &json!({"op": "move", "id": "#1", "status": "ready"}),
        )
        .expect("move by number");
        assert_eq!(moved["id"], json!(other.number));
        let read = board_tool(app.handle(), &json!({"op": "read", "id": card.id}))
            .expect("an id from before numbers");
        assert_eq!(read["card"]["yours"], json!(true));
        assert_eq!(
            read["comments"],
            json!([{"author": "gofer", "body": "Done"}])
        );
    }
}

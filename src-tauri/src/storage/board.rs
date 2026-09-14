//! The project board: cards in five columns, and the comments under them.

use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::*;
use crate::command_error::CommandError;

/// The five columns, in board order.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CardStatus {
    Backlog,
    Ready,
    Doing,
    Review,
    Done,
}

impl CardStatus {
    pub const ALL: [CardStatus; 5] = [
        Self::Backlog,
        Self::Ready,
        Self::Doing,
        Self::Review,
        Self::Done,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Backlog => "backlog",
            Self::Ready => "ready",
            Self::Doing => "doing",
            Self::Review => "review",
            Self::Done => "done",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|status| status.as_str() == text)
    }
}

/// One card, as a column lists it.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CardRecord {
    pub id: String,
    pub title: String,
    pub body: String,
    pub owner: String,
    pub status: CardStatus,
    pub task_id: Option<String>,
    pub comment_count: u64,
    pub created_at: u64,
    pub updated_at: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CardComment {
    pub id: String,
    pub card_id: String,
    pub author: String,
    pub body: String,
    pub created_at: u64,
}

/// One card opened: the row and everything said under it.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CardDetail {
    pub card: CardRecord,
    pub comments: Vec<CardComment>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewCard {
    pub title: String,
    #[serde(default)]
    pub body: String,
    pub owner: String,
    #[serde(default = "NewCard::default_status")]
    pub status: CardStatus,
}

impl NewCard {
    fn default_status() -> CardStatus {
        CardStatus::Backlog
    }
}

/// What an edit may change. A field left out is left alone.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CardEdit {
    pub title: Option<String>,
    pub body: Option<String>,
    pub owner: Option<String>,
}

/// Who is asking, which is what decides what a card refuses.
///
/// The user's own commands may touch anything. A tool — Gofer's worker or a client of the MCP
/// door — may not touch a card that is done, nor one whose task the model is working on right now.
/// The second rule needs one fact the ledger does not have, whether a turn is running, so the
/// caller brings it.
#[derive(Clone, Copy, Debug)]
pub enum Actor {
    User,
    Tool { turn_running: bool },
}

/// A name fits on one line of a card row; anything longer is not a name.
pub const MAX_OWNER_CHARS: usize = 64;

/// The project board: cards, and the comments under them.
pub struct Board<'a> {
    pub(super) storage: &'a ProjectStorage,
}

impl Board<'_> {
    /// Every card, column by column, in the order each column keeps.
    pub fn list(&self) -> Result<Vec<CardRecord>, CommandError> {
        self.listed()
            .map_err(CommandError::or_coded("cards_unavailable"))
    }

    fn listed(&self) -> Result<Vec<CardRecord>, CommandError> {
        let connection = self.storage.connection()?;
        let mut statement = connection
            .prepare(&format!(
                "{CARD_SELECT} ORDER BY {BOARD_ORDER}, cards.position, cards.created_at"
            ))
            .map_err(database_error)?;
        let rows = statement
            .query_map([], card_from_row)
            .map_err(database_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(database_error)?;
        rows.into_iter().collect()
    }

    pub fn read(&self, card_id: &str) -> Result<CardDetail, CommandError> {
        let connection = self.storage.connection()?;
        let card = require_card(&connection, card_id)?;
        let mut statement = connection
            .prepare(
                "SELECT id, card_id, author, body, created_at
                 FROM card_comments WHERE card_id = ?1
                 ORDER BY created_at, id",
            )
            .map_err(database_error)?;
        let comments = statement
            .query_map([card_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                ))
            })
            .map_err(database_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(database_error)?
            .into_iter()
            .map(|(id, card_id, author, body, created_at)| {
                Ok(CardComment {
                    id,
                    card_id,
                    author,
                    body,
                    created_at: from_database_u64(created_at, "comment time")?,
                })
            })
            .collect::<Result<Vec<_>, CommandError>>()?;
        Ok(CardDetail { card, comments })
    }

    pub fn create(&self, card: &NewCard, actor: Actor) -> Result<CardRecord, CommandError> {
        let title = checked_title(&card.title)?;
        checked_text(&card.body, "body")?;
        let owner = checked_owner(&card.owner)?;
        if let Actor::Tool { .. } = actor
            && card.status == CardStatus::Done
        {
            return Err(done_is_locked());
        }
        let now = now_millis()?;
        let id = Uuid::now_v7().to_string();
        let (_write_guard, connection) = self.storage.write_connection()?;
        let position = next_position(&connection, card.status)?;
        connection
            .execute(
                "INSERT INTO cards (id, title, body, owner, status, task_id, position, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, ?7, ?7)",
                params![id, title, card.body, owner, card.status.as_str(), position, now],
            )
            .map_err(database_error)?;
        require_card(&connection, &id)
    }

    pub fn move_to(
        &self,
        card_id: &str,
        status: CardStatus,
        actor: Actor,
    ) -> Result<CardRecord, CommandError> {
        let (_write_guard, mut connection) = self.storage.write_connection()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(database_error)?;
        let card = require_card(&transaction, card_id)?;
        refuse_if_locked(&transaction, &card, actor)?;
        if status == CardStatus::Done
            && let Actor::Tool { .. } = actor
        {
            return Err(done_is_locked());
        }
        let position = next_position(&transaction, status)?;
        transaction
            .execute(
                "UPDATE cards SET status = ?1, position = ?2, updated_at = ?3 WHERE id = ?4",
                params![status.as_str(), position, now_millis()?, card_id],
            )
            .map_err(database_error)?;
        let moved = require_card(&transaction, card_id)?;
        transaction.commit().map_err(database_error)?;
        Ok(moved)
    }

    pub fn edit(
        &self,
        card_id: &str,
        edit: &CardEdit,
        actor: Actor,
    ) -> Result<CardRecord, CommandError> {
        let title = edit.title.as_deref().map(checked_title).transpose()?;
        if let Some(body) = &edit.body {
            checked_text(body, "body")?;
        }
        let owner = edit.owner.as_deref().map(checked_owner).transpose()?;
        let (_write_guard, mut connection) = self.storage.write_connection()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(database_error)?;
        let card = require_card(&transaction, card_id)?;
        refuse_if_locked(&transaction, &card, actor)?;
        transaction
            .execute(
                "UPDATE cards SET title = ?1, body = ?2, owner = ?3, updated_at = ?4 WHERE id = ?5",
                params![
                    title.unwrap_or(card.title),
                    edit.body.clone().unwrap_or(card.body),
                    owner.unwrap_or(card.owner),
                    now_millis()?,
                    card_id
                ],
            )
            .map_err(database_error)?;
        let edited = require_card(&transaction, card_id)?;
        transaction.commit().map_err(database_error)?;
        Ok(edited)
    }

    pub fn comment(
        &self,
        card_id: &str,
        author: &str,
        body: &str,
        actor: Actor,
    ) -> Result<CardComment, CommandError> {
        let author = checked_owner(author)?;
        checked_text(body, "comment")?;
        if body.trim().is_empty() {
            return Err(CommandError::new(
                "card_invalid",
                "A comment needs some text",
            ));
        }
        let (_write_guard, mut connection) = self.storage.write_connection()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(database_error)?;
        let card = require_card(&transaction, card_id)?;
        refuse_if_locked(&transaction, &card, actor)?;
        let now = now_millis()?;
        let id = Uuid::now_v7().to_string();
        transaction
            .execute(
                "INSERT INTO card_comments (id, card_id, author, body, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![id, card_id, author, body, now],
            )
            .map_err(database_error)?;
        transaction
            .execute(
                "UPDATE cards SET updated_at = ?1 WHERE id = ?2",
                params![now, card_id],
            )
            .map_err(database_error)?;
        transaction.commit().map_err(database_error)?;
        Ok(CardComment {
            id,
            card_id: card_id.to_owned(),
            author: author.to_owned(),
            body: body.to_owned(),
            created_at: from_database_u64(now, "comment time")?,
        })
    }

    /// Hands a card to a task the user just opened for it: the card moves to `doing` and remembers
    /// the task, so merging the task is what finishes the card.
    pub fn attach_task(&self, card_id: &str, task_id: &str) -> Result<CardRecord, CommandError> {
        let (_write_guard, mut connection) = self.storage.write_connection()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(database_error)?;
        let card = require_card(&transaction, card_id)?;
        if card.task_id.is_some() {
            return Err(CommandError::new(
                "card_has_task",
                "The card already has a task",
            ));
        }
        if card.status == CardStatus::Done {
            return Err(done_is_locked());
        }
        require_task(&transaction, task_id)?;
        let position = next_position(&transaction, CardStatus::Doing)?;
        transaction
            .execute(
                "UPDATE cards SET task_id = ?1, status = 'doing', position = ?2, updated_at = ?3
                 WHERE id = ?4",
                params![task_id, position, now_millis()?, card_id],
            )
            .map_err(database_error)?;
        let attached = require_card(&transaction, card_id)?;
        transaction.commit().map_err(database_error)?;
        Ok(attached)
    }

    /// Hands a card to the task the user just opened for it, and leaves the ask in that task's
    /// composer. Drafted, not sent: the user reads what is about to be asked before it goes.
    ///
    /// The draft is JSON-encoded because that is how the renderer's own writer stores every
    /// remembered value, and the composer reads it back through the same decoder.
    pub fn hand_to_task(&self, card_id: &str, task_id: &str) -> Result<CardRecord, CommandError> {
        let attached = self.attach_task(card_id, task_id)?;
        let draft = serde_json::to_string(&first_message(&attached)).map_err(|error| {
            CommandError::from(format!("The card could not be encoded: {error}"))
        })?;
        self.storage
            .project()
            .write_ui_state(&draft_ui_key(task_id), Some(&draft))?;
        Ok(attached)
    }

    /// Nothing to collect. A card outlives its task on purpose, and the task ledger puts it back
    /// on the board in the same transaction that deletes the task, so no pass can find one adrift.
    /// Written out rather than left off the fold for the reason `Tasks::collect` gives.
    pub(crate) fn collect(&self, _cutoffs: &Cutoffs) -> Result<Collected, CommandError> {
        Ok(Collected::default())
    }
}

/// What the composer is handed: the title as the ask, and the body under it when there is one.
fn first_message(card: &CardRecord) -> String {
    if card.body.trim().is_empty() {
        return card.title.clone();
    }
    format!("{}\n\n{}", card.title, card.body.trim())
}

/// The columns as the board draws them. `status` is text, and text sorts `doing` before `ready`.
const BOARD_ORDER: &str = "CASE cards.status
        WHEN 'backlog' THEN 0 WHEN 'ready' THEN 1 WHEN 'doing' THEN 2 WHEN 'review' THEN 3 ELSE 4
    END";

const CARD_SELECT: &str =
    "SELECT cards.id, cards.title, cards.body, cards.owner, cards.status, cards.task_id,
        (SELECT COUNT(*) FROM card_comments WHERE card_comments.card_id = cards.id),
        cards.created_at, cards.updated_at
     FROM cards";

fn card_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Result<CardRecord, CommandError>> {
    let status: String = row.get(4)?;
    let comment_count: i64 = row.get(6)?;
    let created_at: i64 = row.get(7)?;
    let updated_at: i64 = row.get(8)?;
    let id: String = row.get(0)?;
    let title: String = row.get(1)?;
    let body: String = row.get(2)?;
    let owner: String = row.get(3)?;
    let task_id: Option<String> = row.get(5)?;
    Ok((|| {
        Ok(CardRecord {
            id,
            title,
            body,
            owner,
            status: CardStatus::parse(&status).ok_or_else(|| {
                CommandError::from(format!("The stored card status {status} is invalid"))
            })?,
            task_id,
            comment_count: from_database_u64(comment_count, "comment count")?,
            created_at: from_database_u64(created_at, "card time")?,
            updated_at: from_database_u64(updated_at, "card time")?,
        })
    })())
}

fn require_card(connection: &Connection, card_id: &str) -> Result<CardRecord, CommandError> {
    connection
        .query_row(
            &format!("{CARD_SELECT} WHERE cards.id = ?1"),
            [card_id],
            card_from_row,
        )
        .optional()
        .map_err(database_error)?
        .ok_or_else(|| CommandError::new("card_not_found", "The card was not found"))?
}

/// Where the next card in a column goes: after every card already there.
fn next_position(connection: &Connection, status: CardStatus) -> Result<i64, CommandError> {
    connection
        .query_row(
            "SELECT COALESCE(MAX(position), 0) + 1 FROM cards WHERE status = ?1",
            [status.as_str()],
            |row| row.get(0),
        )
        .map_err(database_error)
}

/// Finishes every card that was handed to this task, at the end of Done. The user's merge is
/// what calls it.
pub(crate) fn finish_cards_of_task(
    connection: &Connection,
    task_id: &str,
) -> Result<(), CommandError> {
    let position = next_position(connection, CardStatus::Done)?;
    connection
        .execute(
            "UPDATE cards SET status = 'done', position = ?1, updated_at = ?2
             WHERE task_id = ?3 AND status != 'done'",
            params![position, now_millis()?, task_id],
        )
        .map_err(database_error)?;
    Ok(())
}

/// Puts this task's cards back on the board before the task row goes.
///
/// The foreign key would clear `task_id` on its own; what it would not do is move the card, and a
/// card in `doing` with nothing doing it is the lie this exists to prevent. Only this task's cards:
/// a card the user parked in `doing` by hand has no task and is theirs to leave there.
pub(crate) fn release_cards_of_task(
    connection: &Connection,
    task_id: &str,
) -> Result<(), CommandError> {
    let position = next_position(connection, CardStatus::Ready)?;
    connection
        .execute(
            "UPDATE cards
             SET task_id = NULL,
                 position = CASE WHEN status IN ('doing', 'review') THEN ?1 ELSE position END,
                 status = CASE WHEN status IN ('doing', 'review') THEN 'ready' ELSE status END,
                 updated_at = ?2
             WHERE task_id = ?3",
            params![position, now_millis()?, task_id],
        )
        .map_err(database_error)?;
    Ok(())
}

fn refuse_if_locked(
    connection: &Connection,
    card: &CardRecord,
    actor: Actor,
) -> Result<(), CommandError> {
    let Actor::Tool { turn_running, .. } = actor else {
        return Ok(());
    };
    if card.status == CardStatus::Done {
        return Err(done_is_locked());
    }
    if turn_running && card.task_id.is_some() && card.task_id == active_task_id(connection)? {
        return Err(CommandError::new(
            "card_in_progress",
            "The card's task is being worked on right now",
        ));
    }
    Ok(())
}

fn done_is_locked() -> CommandError {
    CommandError::new(
        "card_locked",
        "A finished card is only the user's to change",
    )
}

fn checked_title(title: &str) -> Result<String, CommandError> {
    let title = title.trim();
    if title.is_empty() {
        return Err(CommandError::new("card_invalid", "A card needs a title"));
    }
    if title.contains('\n') {
        return Err(CommandError::new(
            "card_invalid",
            "A card title is one line",
        ));
    }
    checked_text(title, "title")?;
    Ok(title.to_owned())
}

fn checked_owner(owner: &str) -> Result<String, CommandError> {
    let owner = owner.trim();
    if owner.is_empty() {
        return Err(CommandError::new(
            "card_owner_missing",
            "Say who is writing: an owner name is required",
        ));
    }
    if owner.contains('\n') || owner.chars().count() > MAX_OWNER_CHARS {
        return Err(CommandError::new(
            "card_owner_missing",
            format!("An owner is a name: one line, at most {MAX_OWNER_CHARS} characters"),
        ));
    }
    Ok(owner.to_owned())
}

/// The same ceiling a chat message has: nothing on the board should be bigger than one.
fn checked_text(text: &str, what: &str) -> Result<(), CommandError> {
    if text.len() > MAX_STORED_MESSAGE_BYTES {
        return Err(CommandError::new(
            "card_invalid",
            format!("The card {what} is too large to store"),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::test_support::*;
    use super::*;
    use tempfile::TempDir;

    const AGENT: Actor = Actor::Tool {
        turn_running: false,
    };

    fn new_card(title: &str) -> NewCard {
        NewCard {
            title: title.to_owned(),
            body: "Make the hero jump higher".to_owned(),
            owner: "user".to_owned(),
            status: CardStatus::Backlog,
        }
    }

    #[test]
    fn a_card_is_created_moved_edited_and_read_back_with_its_comments() {
        let directory = TempDir::new().expect("temporary directory");
        let storage = storage(&directory);
        let board = storage.board();

        let card = board
            .create(&new_card("Jump"), Actor::User)
            .expect("create");
        assert_eq!(card.status, CardStatus::Backlog);
        assert_eq!(card.comment_count, 0);

        let moved = board
            .move_to(&card.id, CardStatus::Ready, AGENT)
            .expect("move");
        assert_eq!(moved.status, CardStatus::Ready);

        let edit = CardEdit {
            body: Some("Jump twice as high".to_owned()),
            ..CardEdit::default()
        };
        let edited = board.edit(&card.id, &edit, AGENT).expect("edit");
        assert_eq!(edited.title, "Jump", "a field left out is left alone");
        assert_eq!(edited.body, "Jump twice as high");

        board
            .comment(&card.id, "claude", "Looks doable", AGENT)
            .expect("comment");
        let detail = board.read(&card.id).expect("read");
        assert_eq!(detail.comments.len(), 1);
        assert_eq!(detail.comments[0].author, "claude");
        assert_eq!(detail.card.comment_count, 1);

        let listed = board.list().expect("list");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].status, CardStatus::Ready);
    }

    #[test]
    fn columns_keep_the_order_cards_arrived_in() {
        let directory = TempDir::new().expect("temporary directory");
        let storage = storage(&directory);
        let board = storage.board();
        for title in ["one", "two", "three"] {
            board.create(&new_card(title), Actor::User).expect("create");
        }
        let first = &board.list().expect("list")[0];
        board
            .move_to(&first.id, CardStatus::Ready, Actor::User)
            .expect("move");
        board
            .move_to(&first.id, CardStatus::Backlog, Actor::User)
            .expect("move back");
        let titles: Vec<String> = board
            .list()
            .expect("list")
            .into_iter()
            .map(|card| card.title)
            .collect();
        assert_eq!(
            titles,
            ["two", "three", "one"],
            "a card that leaves and comes back joins the end"
        );
    }

    #[test]
    fn a_card_needs_a_one_line_title_and_a_named_owner() {
        let directory = TempDir::new().expect("temporary directory");
        let storage = storage(&directory);
        let board = storage.board();

        let untitled = board
            .create(&new_card("  "), Actor::User)
            .expect_err("no title");
        assert_eq!(untitled.code, "card_invalid");

        let two_lines = board
            .create(&new_card("a\nb"), Actor::User)
            .expect_err("two lines");
        assert_eq!(two_lines.code, "card_invalid");

        let mut unowned = new_card("Jump");
        unowned.owner = " ".to_owned();
        let refused = board.create(&unowned, AGENT).expect_err("no owner");
        assert_eq!(refused.code, "card_owner_missing");

        let card = board
            .create(&new_card("Jump"), Actor::User)
            .expect("create");
        let empty = board
            .comment(&card.id, "claude", "   ", AGENT)
            .expect_err("empty comment");
        assert_eq!(empty.code, "card_invalid");
    }

    #[test]
    fn a_tool_cannot_touch_a_done_card_and_the_user_can() {
        let directory = TempDir::new().expect("temporary directory");
        let storage = storage(&directory);
        let board = storage.board();
        let card = board
            .create(&new_card("Jump"), Actor::User)
            .expect("create");

        let refused = board
            .move_to(&card.id, CardStatus::Done, AGENT)
            .expect_err("a tool cannot finish a card");
        assert_eq!(refused.code, "card_locked");

        board
            .move_to(&card.id, CardStatus::Done, Actor::User)
            .expect("the user can");

        for failure in [
            board
                .edit(&card.id, &CardEdit::default(), AGENT)
                .expect_err("edit")
                .code,
            board
                .comment(&card.id, "claude", "late", AGENT)
                .expect_err("comment")
                .code,
            board
                .move_to(&card.id, CardStatus::Review, AGENT)
                .expect_err("move")
                .code,
        ] {
            assert_eq!(failure, "card_locked");
        }
        let reopened = board
            .move_to(&card.id, CardStatus::Review, Actor::User)
            .expect("the user reopens it");
        assert_eq!(reopened.status, CardStatus::Review);

        let mut finished = new_card("Already done");
        finished.status = CardStatus::Done;
        let refused = board.create(&finished, AGENT).expect_err("create as done");
        assert_eq!(refused.code, "card_locked");
    }

    #[test]
    fn a_card_whose_task_is_being_worked_on_is_read_only_for_tools() {
        let directory = TempDir::new().expect("temporary directory");
        let storage = storage(&directory);
        let released = Released::default();
        let recording = released.recording();
        let switch = storage.switch_with_no_turn_to_refuse(&recording);
        let task = storage.tasks().create(&switch).expect("task");
        let task_id = task.task_id.expect("task id");
        let board = storage.board();
        let card = board
            .create(&new_card("Jump"), Actor::User)
            .expect("create");

        let attached = board.attach_task(&card.id, &task_id).expect("attach");
        assert_eq!(attached.status, CardStatus::Doing);
        assert_eq!(attached.task_id.as_deref(), Some(task_id.as_str()));
        let twice = board
            .attach_task(&card.id, &task_id)
            .expect_err("attach twice");
        assert_eq!(twice.code, "card_has_task");

        let busy = Actor::Tool { turn_running: true };
        let refused = board
            .comment(&card.id, "claude", "hurry", busy)
            .expect_err("mid-turn");
        assert_eq!(refused.code, "card_in_progress");
        board
            .comment(&card.id, "claude", "later", AGENT)
            .expect("between turns it is open");

        let other = board
            .create(&new_card("Other"), Actor::User)
            .expect("create");
        board
            .comment(&other.id, "claude", "unrelated", busy)
            .expect("a card on another task is not in progress");
    }

    #[test]
    fn merging_a_task_finishes_its_cards_and_deleting_one_returns_them() {
        let directory = TempDir::new().expect("temporary directory");
        let storage = storage(&directory);
        make_repository(&directory.path().join("workspace"));
        let board = storage.board();
        let card = board
            .create(&new_card("Jump"), Actor::User)
            .expect("create");
        let other = board
            .create(&new_card("Other"), Actor::User)
            .expect("create");
        let released = Released::default();
        let recording = released.recording();
        let switch = storage.switch_with_no_turn_to_refuse(&recording);
        let task_id = storage
            .tasks()
            .create(&switch)
            .expect("task")
            .task_id
            .expect("task id");
        board.attach_task(&card.id, &task_id).expect("attach");

        {
            let connection = storage.connection().expect("connection");
            finish_cards_of_task(&connection, &task_id).expect("finish");
        }
        assert_eq!(
            board.read(&card.id).expect("read").card.status,
            CardStatus::Done
        );
        assert_eq!(
            board.read(&other.id).expect("read").card.status,
            CardStatus::Backlog,
            "a card on no task is untouched"
        );

        board
            .move_to(&card.id, CardStatus::Review, Actor::User)
            .expect("back to review");
        storage.tasks().delete(&task_id, &switch).expect("delete");
        let returned = board.read(&card.id).expect("read").card;
        assert_eq!(returned.task_id, None);
        assert_eq!(
            returned.status,
            CardStatus::Ready,
            "a card whose task is gone is asked again"
        );
    }

    /// Claim 2 and 3 of the review: a card the user parked in Doing by hand, with no task,
    /// is theirs to leave there — neither deleting an unrelated task nor maintenance may move it.
    #[test]
    fn a_card_parked_by_hand_stays_where_the_user_put_it() {
        let directory = TempDir::new().expect("temporary directory");
        let storage = storage(&directory);
        make_repository(&directory.path().join("workspace"));
        let board = storage.board();
        let parked = board
            .create(&new_card("Parked"), Actor::User)
            .expect("create");
        board
            .move_to(&parked.id, CardStatus::Doing, Actor::User)
            .expect("doing by hand");
        let posted = board
            .create(&new_card("Posted"), Actor::User)
            .expect("create");
        let released = Released::default();
        let recording = released.recording();
        let switch = storage.switch_with_no_turn_to_refuse(&recording);
        let task_id = storage
            .tasks()
            .create(&switch)
            .expect("task")
            .task_id
            .expect("task id");
        board.attach_task(&posted.id, &task_id).expect("attach");

        let collected = board
            .collect(&Cutoffs::current().expect("cutoffs"))
            .expect("collect");
        assert_eq!(
            collected.sketches_removed + collected.attachments_removed,
            0,
            "maintenance has nothing to return"
        );
        storage.tasks().delete(&task_id, &switch).expect("delete");

        assert_eq!(
            board.read(&posted.id).expect("read").card.status,
            CardStatus::Ready
        );
        assert_eq!(
            board.read(&parked.id).expect("read").card.status,
            CardStatus::Doing,
            "the card on no task was not the deleted task's to return"
        );
    }

    /// Claim 17: `list` answers in board order, and the model reads that array as it comes.
    #[test]
    fn the_list_is_in_board_order_not_alphabetical() {
        let directory = TempDir::new().expect("temporary directory");
        let storage = storage(&directory);
        let board = storage.board();
        for (title, status) in [
            ("doing", CardStatus::Doing),
            ("ready", CardStatus::Ready),
            ("done", CardStatus::Done),
            ("backlog", CardStatus::Backlog),
            ("review", CardStatus::Review),
        ] {
            let mut card = new_card(title);
            card.status = status;
            board.create(&card, Actor::User).expect("create");
        }
        let titles: Vec<String> = board
            .list()
            .expect("list")
            .into_iter()
            .map(|card| card.title)
            .collect();
        assert_eq!(titles, ["backlog", "ready", "doing", "review", "done"]);
    }

    /// Claim 15: a card finished by a merge joins the end of Done, after cards finished earlier.
    #[test]
    fn a_merged_card_joins_the_end_of_done() {
        let directory = TempDir::new().expect("temporary directory");
        let storage = storage(&directory);
        let board = storage.board();
        let later = board
            .create(&new_card("later"), Actor::User)
            .expect("create");
        let earlier = board
            .create(&new_card("earlier"), Actor::User)
            .expect("create");
        board
            .move_to(&earlier.id, CardStatus::Done, Actor::User)
            .expect("done by hand");
        let released = Released::default();
        let recording = released.recording();
        let switch = storage.switch_with_no_turn_to_refuse(&recording);
        let task_id = storage
            .tasks()
            .create(&switch)
            .expect("task")
            .task_id
            .expect("task id");
        board.attach_task(&later.id, &task_id).expect("attach");
        {
            let connection = storage.connection().expect("connection");
            finish_cards_of_task(&connection, &task_id).expect("finish");
        }
        let titles: Vec<String> = board
            .list()
            .expect("list")
            .into_iter()
            .filter(|card| card.status == CardStatus::Done)
            .map(|card| card.title)
            .collect();
        assert_eq!(titles, ["earlier", "later"]);
    }

    /// Claim 21: an owner is a name, one short line, not a document.
    #[test]
    fn an_owner_is_one_line() {
        let directory = TempDir::new().expect("temporary directory");
        let storage = storage(&directory);
        let board = storage.board();
        let mut two_lines = new_card("Jump");
        two_lines.owner = "claude\nand friends".to_owned();
        assert_eq!(
            board
                .create(&two_lines, Actor::User)
                .expect_err("two lines")
                .code,
            "card_owner_missing"
        );
        let mut long = new_card("Jump");
        long.owner = "x".repeat(MAX_OWNER_CHARS + 1);
        assert_eq!(
            board.create(&long, Actor::User).expect_err("too long").code,
            "card_owner_missing"
        );
        let card = board
            .create(&new_card("Jump"), Actor::User)
            .expect("create");
        assert_eq!(
            board
                .comment(&card.id, "a\nb", "hi", Actor::User)
                .expect_err("author")
                .code,
            "card_owner_missing"
        );
    }

    /// Claim 22: handing a card to a task leaves the ask in the task's composer, JSON-encoded the
    /// way the renderer's own writer encodes a draft, and never starts anything.
    #[test]
    fn handing_a_card_to_a_task_drafts_the_ask_in_its_composer() {
        let directory = TempDir::new().expect("temporary directory");
        let storage = storage(&directory);
        let board = storage.board();
        let card = board
            .create(&new_card("Jump"), Actor::User)
            .expect("create");
        let released = Released::default();
        let recording = released.recording();
        let switch = storage.switch_with_no_turn_to_refuse(&recording);
        let task_id = storage
            .tasks()
            .create(&switch)
            .expect("task")
            .task_id
            .expect("task id");

        let handed = board.hand_to_task(&card.id, &task_id).expect("hand over");
        assert_eq!(handed.status, CardStatus::Doing);
        let draft = storage
            .project()
            .read_ui_state(&draft_ui_key(&task_id))
            .expect("read")
            .expect("a draft");
        assert_eq!(draft, "\"Jump\\n\\nMake the hero jump higher\"");
    }

    #[test]
    fn a_missing_card_is_named() {
        let directory = TempDir::new().expect("temporary directory");
        let storage = storage(&directory);
        let missing = storage.board().read("nope").expect_err("missing");
        assert_eq!(missing.code, "card_not_found");
        let status = CardStatus::parse("review");
        assert_eq!(status, Some(CardStatus::Review));
        assert_eq!(CardStatus::parse("archived"), None);
    }
}

//! The conversation the active task holds, and the images in it.

use std::fs;

use rusqlite::{OptionalExtension, TransactionBehavior, params};
use sha2::{Digest, Sha256};

use super::*;
use crate::command_error::CommandError;

/// The conversation the active task holds, and the images in it.
///
/// Attachments are here rather than with the backups because they belong to messages: one is
/// stored by content hash, referred to by the message that carries it, and read back when that
/// message is drawn.
pub struct Chats<'a> {
    pub(super) storage: &'a ProjectStorage,
}

impl Chats<'_> {
    /// The conversation of the task the caller names, or of the active one when it names none.
    ///
    /// Named rather than assumed, because the window and the backend disagree for as long as a
    /// switch is running and the window is the one that knows which task it is drawing. Answering
    /// about whichever task happened to be active is how a task opened a second time arrived
    /// holding the previous task's conversation: the workspace remounts the moment the route
    /// resolves, and on a route the router had already loaded that is before the switch lands.
    pub fn load(&self, task_id: Option<&str>) -> Result<StoredChat, CommandError> {
        self.chat_of(task_id)
            .map_err(CommandError::or_coded("chat_unavailable"))
    }

    /// The active task's conversation. For the callers that have just made it active themselves.
    pub(crate) fn stored_chat(&self) -> Result<StoredChat, CommandError> {
        self.chat_of(None)
    }

    fn chat_of(&self, requested: Option<&str>) -> Result<StoredChat, CommandError> {
        let connection = self.storage.connection()?;
        let task_id = match requested {
            Some(requested) => {
                require_task(&connection, requested)?;
                requested.to_owned()
            }
            None => self.storage.ensure_active_task(&connection)?,
        };
        let agent_messages_json = connection
            .query_row(
                "SELECT agent_messages_json FROM tasks WHERE id = ?1",
                [&task_id],
                |row| row.get::<_, String>(0),
            )
            .map_err(database_error)?;
        let mut statement = connection
            .prepare("SELECT payload_json FROM messages WHERE task_id = ?1 ORDER BY sequence")
            .map_err(database_error)?;
        let messages = statement
            .query_map([&task_id], |row| row.get::<_, String>(0))
            .map_err(database_error)?
            .map(|row| {
                let payload = row.map_err(database_error)?;
                serde_json::from_str(&payload).map_err(|error| {
                    CommandError::from(format!("Stored chat message is invalid: {error}"))
                })
            })
            .collect::<Result<Vec<StoredMessage>, CommandError>>()?;
        let agent_messages = serde_json::from_str(&agent_messages_json).map_err(|error| {
            CommandError::from(format!("Stored agent context is invalid: {error}"))
        })?;
        Ok(StoredChat {
            task_id: Some(task_id),
            messages,
            agent_messages,
        })
    }

    pub fn save(&self, chat: &StoredChat) -> Result<(), CommandError> {
        self.store_chat(chat)
            .map_err(CommandError::or_coded("chat_not_saved"))
    }

    fn store_chat(&self, chat: &StoredChat) -> Result<(), CommandError> {
        validate_chat(chat)?;
        let message_payloads = chat
            .messages
            .iter()
            .map(|message| {
                serde_json::to_string(message).map_err(|error| {
                    CommandError::from(format!("Could not serialize chat message: {error}"))
                })
            })
            .collect::<Result<Vec<_>, _>>()?;
        let agent_messages = serde_json::to_string(&chat.agent_messages).map_err(|error| {
            CommandError::from(format!("Could not serialize agent context: {error}"))
        })?;
        let (_write_guard, mut connection) = self.storage.write_connection()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(database_error)?;
        let task_id = match &chat.task_id {
            Some(task_id) => {
                let exists = transaction
                    .query_row("SELECT 1 FROM tasks WHERE id = ?1", [task_id], |_| Ok(()))
                    .optional()
                    .map_err(database_error)?
                    .is_some();
                if !exists {
                    return Err(CommandError::from(
                        "The chat task no longer exists".to_owned(),
                    ));
                }
                task_id.clone()
            }
            None => self.storage.ensure_active_task(&transaction)?,
        };
        // A chat is stored by replacing every row the task owns, so a caller holding fewer messages
        // than are on disk deletes the difference. That is never what a save means: the renderer
        // sends the whole conversation, and a short one is a renderer that lost its state — a chat
        // that failed to load, a turn rewritten by hand, a remount that arrived before its read.
        // Losing the user's conversation to any of those is worse than refusing the write, so the
        // write is refused and the message says what it was about to cost.
        let stored_messages: i64 = transaction
            .query_row(
                "SELECT COUNT(*) FROM messages WHERE task_id = ?1",
                [&task_id],
                |row| row.get(0),
            )
            .map_err(database_error)?;
        let saving_messages = chat.messages.len() as i64;
        if saving_messages < stored_messages {
            return Err(format!(
                "Refusing to save {saving_messages} chat messages over the {stored_messages} \
                 already stored: {} would be lost",
                stored_messages - saving_messages
            )
            .into());
        }
        transaction
            .execute("DELETE FROM messages WHERE task_id = ?1", [&task_id])
            .map_err(database_error)?;
        for (sequence, (message, payload)) in chat.messages.iter().zip(message_payloads).enumerate()
        {
            transaction
                .execute(
                    "INSERT INTO messages
                     (task_id, sequence, message_id, sender, text, timestamp, payload_json)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                    params![
                        task_id,
                        sequence as i64,
                        to_database_integer(message.id, "message ID")?,
                        message.sender,
                        message.text,
                        to_database_integer(message.timestamp, "message timestamp")?,
                        payload
                    ],
                )
                .map_err(database_error)?;
            for (position, attachment) in message.attachments.iter().enumerate() {
                let exists = transaction
                    .query_row(
                        "SELECT 1 FROM attachments WHERE id = ?1",
                        [&attachment.id],
                        |_| Ok(()),
                    )
                    .optional()
                    .map_err(database_error)?
                    .is_some();
                if !exists {
                    return Err(
                        format!("Attachment '{}' has not been stored", attachment.name).into(),
                    );
                }
                transaction
                    .execute(
                        "INSERT INTO message_attachments
                         (task_id, message_sequence, attachment_id, position)
                         VALUES (?1, ?2, ?3, ?4)",
                        params![task_id, sequence as i64, attachment.id, position as i64],
                    )
                    .map_err(database_error)?;
            }
        }
        if let Some(message) = chat
            .messages
            .iter()
            .find(|message| message.sender == "user" && !message.text.trim().is_empty())
        {
            let title = message.text.trim().chars().take(80).collect::<String>();
            transaction
                .execute(
                    "UPDATE tasks SET title = ?1 WHERE id = ?2 AND title = 'New task'",
                    params![title, task_id],
                )
                .map_err(database_error)?;
        }
        transaction
            .execute(
                "UPDATE tasks SET agent_messages_json = ?1, updated_at = ?2 WHERE id = ?3",
                params![agent_messages, now_millis()?, task_id],
            )
            .map_err(database_error)?;
        transaction.commit().map_err(database_error)
    }

    pub fn save_attachment(
        &self,
        attachment: &StoredAttachment,
        bytes: &[u8],
    ) -> Result<(), CommandError> {
        self.store_attachment(attachment, bytes)
            .map_err(CommandError::or_coded("attachment_not_stored"))
    }

    fn store_attachment(
        &self,
        attachment: &StoredAttachment,
        bytes: &[u8],
    ) -> Result<(), CommandError> {
        validate_attachment(attachment)?;
        if bytes.len() as u64 != attachment.size {
            return Err(CommandError::from(
                "The attachment size does not match its contents".to_owned(),
            ));
        }
        let hash = Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let path = self.storage.blob_path(&hash);
        let parent = path
            .parent()
            .ok_or_else(|| CommandError::from("The blob path has no parent".to_owned()))?;
        fs::create_dir_all(parent).map_err(|error| {
            CommandError::from(format!("Could not create {}: {error}", parent.display()))
        })?;
        if !path.exists() {
            let temporary = parent.join(format!(".{}.tmp", Uuid::now_v7()));
            fs::write(&temporary, bytes).map_err(|error| {
                CommandError::from(format!("Could not save {}: {error}", temporary.display()))
            })?;
            match fs::rename(&temporary, &path) {
                Ok(()) => {}
                Err(_) if path.exists() => {
                    let _ = fs::remove_file(&temporary);
                }
                Err(error) => {
                    return Err(format!("Could not store {}: {error}", path.display()).into());
                }
            }
        }
        let (_write_guard, connection) = self.storage.write_connection()?;
        let existing = connection
            .query_row(
                "SELECT content_hash, name, mime_type, size FROM attachments WHERE id = ?1",
                [&attachment.id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, i64>(3)?,
                    ))
                },
            )
            .optional()
            .map_err(database_error)?;
        if let Some(existing) = existing {
            if existing.0 == hash
                && existing.1 == attachment.name
                && existing.2 == attachment.mime_type
                && u64::try_from(existing.3).ok() == Some(attachment.size)
            {
                return Ok(());
            }
            return Err(CommandError::from(
                "The attachment ID is already used by different content".to_owned(),
            ));
        }
        connection
            .execute(
                "INSERT INTO attachments (id, content_hash, name, mime_type, size, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    attachment.id,
                    hash,
                    attachment.name,
                    attachment.mime_type,
                    to_database_integer(attachment.size, "attachment size")?,
                    now_millis()?
                ],
            )
            .map_err(database_error)?;
        Ok(())
    }

    pub fn read_attachment(&self, attachment: &StoredAttachment) -> Result<Vec<u8>, CommandError> {
        self.stored_attachment_bytes(attachment)
            .map_err(CommandError::or_coded("attachment_unavailable"))
    }

    fn stored_attachment_bytes(
        &self,
        attachment: &StoredAttachment,
    ) -> Result<Vec<u8>, CommandError> {
        let connection = self.storage.connection()?;
        let stored = connection
            .query_row(
                "SELECT content_hash, name, mime_type, size FROM attachments WHERE id = ?1",
                [&attachment.id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, i64>(3)?,
                    ))
                },
            )
            .optional()
            .map_err(database_error)?
            .ok_or_else(|| format!("Attachment '{}' was not found", attachment.name))?;
        if stored.1 != attachment.name
            || stored.2 != attachment.mime_type
            || u64::try_from(stored.3).ok() != Some(attachment.size)
        {
            return Err(format!("Attachment metadata does not match: {}", attachment.name).into());
        }
        let bytes = fs::read(self.storage.blob_path(&stored.0)).map_err(|error| {
            CommandError::from(format!(
                "Could not read attachment {}: {error}",
                attachment.name
            ))
        })?;
        if bytes.len() as u64 != attachment.size {
            return Err(
                format!("The stored attachment size is invalid: {}", attachment.name).into(),
            );
        }
        let actual_hash = Sha256::digest(&bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        if actual_hash != stored.0 {
            return Err(format!(
                "The stored attachment contents are invalid: {}",
                attachment.name
            )
            .into());
        }
        Ok(bytes)
    }

    pub fn import_legacy_attachment(
        &self,
        legacy_directory: &Path,
        attachment: &StoredAttachment,
    ) -> Result<(), CommandError> {
        self.import_attachment(legacy_directory, attachment)
            .map_err(CommandError::or_coded("attachment_not_imported"))
    }

    fn import_attachment(
        &self,
        legacy_directory: &Path,
        attachment: &StoredAttachment,
    ) -> Result<(), CommandError> {
        let path = legacy_directory.join(&attachment.id);
        let bytes = fs::read(&path).map_err(|error| {
            CommandError::from(format!("Could not import {}: {error}", path.display()))
        })?;
        self.storage.chats().store_attachment(attachment, &bytes)
    }

    /// Attachments no message refers to any more, and the blobs left holding their bytes.
    ///
    /// Only after a day unreferenced. The window between an image being stored and the message
    /// carrying it being written is real — the composer stores on paste, the row appears on send —
    /// so anything shorter deletes the screenshot of somebody who pasted one and went to lunch.
    ///
    /// `message_attachments` needs no sweep of its own and that is worth saying rather than leaving
    /// as an absence: it cascades from `messages`, and every connection is opened with foreign keys
    /// on, so what a deleted conversation leaves behind is the `attachments` row that nothing
    /// cascades to. That row is what this looks for.
    ///
    /// The blob goes last, and only when no attachment still hashes to it. Attachments are
    /// content-addressed, so the same screenshot pasted into two tasks is one file on disk, and
    /// deleting it with the first row would blank the image still on screen in the second.
    pub(crate) fn collect(&self, cutoffs: &Cutoffs) -> Result<Collected, CommandError> {
        let mut connection = self.storage.connection()?;
        let mut statement = connection
            .prepare(
                "SELECT a.id, a.content_hash FROM attachments a
                 LEFT JOIN message_attachments ma ON ma.attachment_id = a.id
                 WHERE ma.attachment_id IS NULL AND a.created_at < ?1",
            )
            .map_err(database_error)?;
        let orphaned = statement
            .query_map([cutoffs.attachments_before], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(database_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(database_error)?;
        drop(statement);
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(database_error)?;
        for (id, _) in &orphaned {
            transaction
                .execute("DELETE FROM attachments WHERE id = ?1", [id])
                .map_err(database_error)?;
        }
        transaction.commit().map_err(database_error)?;
        let mut blobs_removed = 0;
        for (_, hash) in &orphaned {
            let references: i64 = connection
                .query_row(
                    "SELECT COUNT(*) FROM attachments WHERE content_hash = ?1",
                    [hash],
                    |row| row.get(0),
                )
                .map_err(database_error)?;
            if references == 0 && fs::remove_file(self.storage.blob_path(hash)).is_ok() {
                blobs_removed += 1;
            }
        }
        Ok(Collected {
            attachments_removed: orphaned.len(),
            blobs_removed,
            ..Collected::default()
        })
    }
}

pub(crate) fn validate_chat(chat: &StoredChat) -> Result<(), CommandError> {
    if chat.messages.len() > MAX_STORED_CHAT_MESSAGES {
        return Err(format!(
            "Stored chats cannot contain more than {MAX_STORED_CHAT_MESSAGES} messages"
        )
        .into());
    }
    let serialized_size = serde_json::to_vec(chat)
        .map_err(|_| CommandError::from("Stored chat data is invalid".to_owned()))?
        .len();
    if serialized_size > MAX_STORED_CHAT_BYTES {
        return Err(CommandError::from(
            "Stored chat data cannot exceed 32 MiB".to_owned(),
        ));
    }
    for message in &chat.messages {
        if message.sender != "user" && message.sender != "assistant" {
            return Err(CommandError::from(
                "Stored chat messages have an invalid sender".to_owned(),
            ));
        }
        if message.text.len() > MAX_STORED_MESSAGE_BYTES {
            return Err(CommandError::from(
                "Stored chat messages cannot exceed 1 MiB".to_owned(),
            ));
        }
        if message.attachments.len() > 5 {
            return Err(CommandError::from(
                "Stored chat messages cannot contain more than 5 images".to_owned(),
            ));
        }
        for attachment in &message.attachments {
            validate_attachment(attachment)?;
        }
    }
    Ok(())
}

pub fn validate_attachment(attachment: &StoredAttachment) -> Result<(), CommandError> {
    if attachment.id.is_empty()
        || attachment.id.len() > 64
        || !attachment
            .id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-')
    {
        return Err(CommandError::from(
            "The attachment ID is invalid".to_owned(),
        ));
    }
    if attachment.name.trim().is_empty() || attachment.name.len() > 255 {
        return Err(CommandError::from(
            "Attachment names must contain between 1 and 255 bytes".to_owned(),
        ));
    }
    if attachment.size == 0 || attachment.size > 10 * 1024 * 1024 {
        return Err(CommandError::from(
            "Images must be between 1 byte and 10 MiB".to_owned(),
        ));
    }
    if !["image/png", "image/jpeg", "image/webp", "image/gif"]
        .contains(&attachment.mime_type.as_str())
    {
        return Err(CommandError::from(
            "Only PNG, JPEG, WebP, and GIF images are supported".to_owned(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::test_support::*;
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn chat_and_content_addressed_attachments_round_trip() {
        let directory = TempDir::new().expect("temporary directory");
        let storage = storage(&directory);
        let attachment = attachment("018f47aa-09d2-7b34-a2d3-8c4e6f123456");
        storage
            .chats()
            .save_attachment(&attachment, b"hi")
            .expect("save attachment");
        let chat = StoredChat {
            task_id: None,
            messages: vec![StoredMessage {
                id: 1,
                sender: "user".to_owned(),
                text: "Look".to_owned(),
                timestamp: 10,
                attachments: vec![attachment.clone()],
                extra: serde_json::Map::new(),
            }],
            agent_messages: vec![serde_json::json!({"role": "user"})],
        };

        storage.chats().save(&chat).expect("save chat");

        let loaded = storage.chats().load(None).expect("load chat");
        assert_eq!(loaded.messages.len(), 1);
        assert_eq!(loaded.messages[0].text, "Look");
        assert_eq!(loaded.agent_messages.len(), 1);
        assert_eq!(
            storage
                .chats()
                .read_attachment(&attachment)
                .expect("read attachment"),
            b"hi"
        );
    }

    /// A save is the whole conversation, so a save holding fewer messages is a caller that lost
    /// some. The renderer used to shorten the array whenever a turn was retried, and this write
    /// deleted the difference from the database with nothing to restore it from.
    #[test]
    fn a_shorter_chat_is_refused_rather_than_saved_over_a_longer_one() {
        let directory = TempDir::new().expect("temporary directory");
        let storage = storage(&directory);
        let message = |id: u64, text: &str| StoredMessage {
            id,
            sender: if id % 2 == 1 { "user" } else { "assistant" }.to_owned(),
            text: text.to_owned(),
            timestamp: id * 10,
            attachments: Vec::new(),
            extra: serde_json::Map::new(),
        };
        let full = StoredChat {
            task_id: None,
            messages: vec![
                message(1, "First"),
                message(2, "First reply"),
                message(3, "Second"),
                message(4, "Second reply"),
            ],
            agent_messages: Vec::new(),
        };
        storage.chats().save(&full).expect("save four messages");
        let task_id = storage.chats().load(None).expect("stored chat").task_id;

        let truncated = StoredChat {
            task_id: task_id.clone(),
            messages: full.messages[..2].to_vec(),
            agent_messages: Vec::new(),
        };
        let refusal = storage
            .chats()
            .save(&truncated)
            .expect_err("a shorter chat is refused");
        assert!(refusal.message.contains("2 would be lost"), "{refusal}");

        let loaded = storage.chats().load(None).expect("load chat");
        assert_eq!(loaded.messages.len(), 4);
        assert_eq!(loaded.messages[3].text, "Second reply");
    }

    /// The retry this refusal exists for: the same number of messages, the last one rewritten.
    #[test]
    fn a_reply_rewritten_in_place_saves_over_the_row_it_kept() {
        let directory = TempDir::new().expect("temporary directory");
        let storage = storage(&directory);
        let message = |id: u64, sender: &str, text: &str| StoredMessage {
            id,
            sender: sender.to_owned(),
            text: text.to_owned(),
            timestamp: id * 10,
            attachments: Vec::new(),
            extra: serde_json::Map::new(),
        };
        let chat = StoredChat {
            task_id: None,
            messages: vec![
                message(1, "user", "Build it"),
                message(2, "assistant", "It failed"),
            ],
            agent_messages: Vec::new(),
        };
        storage.chats().save(&chat).expect("save the failed turn");
        let task_id = storage.chats().load(None).expect("stored chat").task_id;

        storage
            .chats()
            .save(&StoredChat {
                task_id,
                messages: vec![
                    message(1, "user", "Build it"),
                    message(2, "assistant", "It worked"),
                ],
                agent_messages: Vec::new(),
            })
            .expect("save the retried turn");

        let loaded = storage.chats().load(None).expect("load chat");
        assert_eq!(loaded.messages.len(), 2);
        assert_eq!(loaded.messages[1].id, 2);
        assert_eq!(loaded.messages[1].text, "It worked");
    }

    /// The window names the task it is drawing, and gets that task's conversation.
    ///
    /// It used to get whichever task was active, and the two disagree for exactly as long as a
    /// switch takes — which is when the window asks, because the workspace remounts the moment the
    /// route resolves. A task opened a second time arrived holding the conversation of the task it
    /// was opened from.
    #[test]
    fn a_named_chat_is_read_by_name_not_by_which_task_is_active() {
        let directory = TempDir::new().expect("temporary storage");
        let storage = storage(&directory);
        let message = |id: u64, text: &str| StoredMessage {
            id,
            sender: "user".to_owned(),
            text: text.to_owned(),
            timestamp: id * 10,
            attachments: Vec::new(),
            extra: serde_json::Map::new(),
        };
        let first = storage.chats().load(None).expect("first task");
        let first_task_id = first.task_id.clone().expect("first task ID");
        storage
            .chats()
            .save(&StoredChat {
                task_id: Some(first_task_id.clone()),
                messages: vec![message(1, "The first conversation")],
                agent_messages: Vec::new(),
            })
            .expect("save the first conversation");

        // A second task, which creating makes the active one.
        let second = storage
            .tasks()
            .create(&storage.switch_with_no_turn_to_refuse(&NOTHING_TO_STOP))
            .expect("create task");
        let second_task_id = second.task_id.expect("second task ID");
        assert_ne!(first_task_id, second_task_id);

        let named = storage
            .chats()
            .load(Some(&first_task_id))
            .expect("the named chat");
        assert_eq!(named.task_id.as_deref(), Some(first_task_id.as_str()));
        assert_eq!(named.messages.len(), 1);
        assert_eq!(named.messages[0].text, "The first conversation");
        // And the active one is still answered when nothing is named.
        let active = storage.chats().load(None).expect("the active chat");
        assert_eq!(active.task_id.as_deref(), Some(second_task_id.as_str()));
        assert!(active.messages.is_empty());
    }

    /*
     * A chat asked for by a name nothing holds is refused rather than answered with another one.
     *
     * And it is refused by the name of what actually went wrong. A missing task, a database another
     * process is holding and a row that will not parse all used to arrive as `chat_unavailable`, so
     * the renderer could not tell one it should route away from from one worth trying again.
     */
    #[test]
    fn a_chat_named_for_a_task_that_is_gone_is_refused() {
        let directory = TempDir::new().expect("temporary storage");
        let storage = storage(&directory);
        let failure = storage
            .chats()
            .load(Some("01000000-0000-7000-8000-000000000000"))
            .expect_err("a task that does not exist");
        assert_eq!(failure.code, "task_not_found");
        assert!(!failure.retryable, "a task that is gone stays gone");
    }

    #[test]
    fn cloned_storage_serializes_writes() {
        let directory = TempDir::new().expect("temporary storage");
        let storage = storage(&directory);
        let chat = storage.chats().load(None).expect("active chat");
        let clone = storage.clone();
        assert!(Arc::ptr_eq(&storage.write_lock, &clone.write_lock));

        let guard = storage.write_lock().expect("write lock");
        let (started_sender, started_receiver) = std::sync::mpsc::channel();
        let (result_sender, result_receiver) = std::sync::mpsc::channel();
        let writer = std::thread::spawn(move || {
            started_sender.send(()).expect("signal writer start");
            result_sender
                .send(clone.chats().save(&chat))
                .expect("send write result");
        });
        started_receiver.recv().expect("writer started");
        assert!(matches!(
            result_receiver.recv_timeout(std::time::Duration::from_millis(100)),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout)
        ));

        drop(guard);
        result_receiver
            .recv_timeout(std::time::Duration::from_secs(5))
            .expect("writer completed")
            .expect("save chat");
        writer.join().expect("writer thread");
    }

    #[test]
    fn storage_operations_cover_invalid_state_and_conflict_branches() {
        let directory = TempDir::new().expect("temporary directory");
        let storage = storage(&directory);
        let workspace = storage.tasks().agent_workspace().expect("agent workspace");
        assert!(
            storage
                .runs()
                .start_in(
                    &StartGodotRunRequest {
                        task_id: None,
                        session_id: None,
                        godot_version: None,
                        metadata: serde_json::json!([]),
                    },
                    &workspace,
                )
                .is_err()
        );
        assert!(
            storage
                .runs()
                .finish(&FinishGodotRunRequest {
                    run_id: "missing".to_owned(),
                    status: "running".to_owned(),
                    exit_code: None,
                })
                .is_err()
        );
        assert!(
            storage
                .runs()
                .finish(&FinishGodotRunRequest {
                    run_id: "missing".to_owned(),
                    status: "failed".to_owned(),
                    exit_code: None,
                })
                .is_err()
        );
        assert!(
            storage
                .memory()
                .search(&SearchMemoryRequest {
                    query: " ".to_owned(),
                    task_id: None,
                    vector: None,
                    limit: None,
                })
                .is_err()
        );

        let stored = attachment("conflict-id");
        assert!(storage.chats().save_attachment(&stored, b"x").is_err());
        storage
            .chats()
            .save_attachment(&stored, b"hi")
            .expect("save attachment");
        storage
            .chats()
            .save_attachment(&stored, b"hi")
            .expect("idempotent attachment save");
        let renamed = StoredAttachment {
            name: "other.png".to_owned(),
            ..stored.clone()
        };
        assert!(storage.chats().save_attachment(&renamed, b"hi").is_err());
        assert!(storage.chats().read_attachment(&renamed).is_err());

        let mut vector = vec![0.0; MEMORY_EMBEDDING_DIMENSIONS];
        vector[0] = 1.0;
        assert!(
            storage
                .memory()
                .search(&SearchMemoryRequest {
                    query: String::new(),
                    task_id: None,
                    vector: Some(vector),
                    limit: Some(1),
                })
                .expect("empty vector search")
                .is_empty()
        );
    }

    #[test]
    fn projects_and_new_tasks_are_isolated() {
        let directory = TempDir::new().expect("temporary directory");
        let storage = storage(&directory);
        storage
            .chats()
            .save(&StoredChat {
                task_id: None,
                messages: vec![StoredMessage {
                    id: 1,
                    sender: "user".to_owned(),
                    text: "First task".to_owned(),
                    timestamp: 10,
                    attachments: Vec::new(),
                    extra: serde_json::Map::new(),
                }],
                agent_messages: Vec::new(),
            })
            .expect("save first task");

        let previous = storage.chats().load(None).expect("first task");
        let next = storage
            .tasks()
            .create(&storage.switch_with_no_turn_to_refuse(&NOTHING_TO_STOP))
            .expect("create task");
        storage
            .chats()
            .save(&previous)
            .expect("save completed task");

        assert!(next.messages.is_empty());
        assert!(
            storage
                .chats()
                .load(None)
                .expect("active chat")
                .messages
                .is_empty()
        );
        let tasks = storage.tasks().list().expect("parallel tasks");
        assert_eq!(tasks.len(), 2);
        assert!(tasks.iter().all(|task| task.status == "active"));
        let previous_task_id = previous.task_id.expect("previous task ID");
        let restored = storage
            .tasks()
            .activate(
                &previous_task_id,
                &storage.switch_with_no_turn_to_refuse(&NOTHING_TO_STOP),
            )
            .expect("activate previous task");
        assert_eq!(restored.messages[0].text, "First task");
    }

    #[test]
    fn task_titles_are_derived_from_the_first_message() {
        let directory = TempDir::new().expect("temporary directory");
        let storage = storage(&directory);
        storage
            .chats()
            .save(&StoredChat {
                task_id: None,
                messages: vec![StoredMessage {
                    id: 1,
                    sender: "user".to_owned(),
                    text: "Build the player controller".to_owned(),
                    timestamp: 10,
                    attachments: Vec::new(),
                    extra: serde_json::Map::new(),
                }],
                agent_messages: Vec::new(),
            })
            .expect("save chat");
        let task = storage.tasks().list().expect("tasks").remove(0);

        assert_eq!(task.title, "Build the player controller");
        // A non-repository workspace records no worktree; git.rs covers the repository path.
        assert!(task.worktree.is_none());
    }

    /// An attachment nothing refers to goes; a blob two attachments share does not.
    ///
    /// Attachments are content-addressed, so the same screenshot pasted into two tasks is one file
    /// on disk. Deleting it with the first row that stops referring to it would blank the image
    /// still on screen in the second.
    #[test]
    fn the_chats_view_collects_unreferenced_attachments_without_emptying_a_shared_blob() {
        let directory = TempDir::new().expect("temporary directory");
        let storage = storage(&directory);
        let referenced = attachment("018f47aa-09d2-7b34-a2d3-8c4e6f000001");
        let shares_its_bytes = attachment("018f47aa-09d2-7b34-a2d3-8c4e6f000002");
        let alone = attachment("018f47aa-09d2-7b34-a2d3-8c4e6f000003");
        for stored in [&referenced, &shares_its_bytes] {
            storage
                .chats()
                .save_attachment(stored, b"hi")
                .expect("save attachment");
        }
        storage
            .chats()
            .save_attachment(&alone, b"by")
            .expect("save attachment");
        storage
            .chats()
            .save(&StoredChat {
                task_id: None,
                messages: vec![StoredMessage {
                    id: 1,
                    sender: "user".to_owned(),
                    text: "Look".to_owned(),
                    timestamp: 10,
                    attachments: vec![referenced.clone()],
                    extra: serde_json::Map::new(),
                }],
                agent_messages: Vec::new(),
            })
            .expect("save the chat");

        let collected = storage
            .chats()
            .collect(&everything_is_old())
            .expect("collect");

        assert_eq!(collected.attachments_removed, 2);
        assert_eq!(
            collected.blobs_removed, 1,
            "only the bytes nothing else hashes to"
        );
        assert_eq!(
            storage
                .chats()
                .read_attachment(&referenced)
                .expect("the referenced attachment is still readable"),
            b"hi"
        );
        assert!(storage.chats().read_attachment(&alone).is_err());
    }

    /// A day is a floor under the window between a paste and the message that carries it.
    ///
    /// The composer stores an image the moment it is pasted and the row referring to it only
    /// appears when the message is sent, so an attachment is unreferenced for as long as somebody
    /// takes to finish typing.
    #[test]
    fn the_chats_view_leaves_an_attachment_that_has_only_just_been_pasted() {
        let directory = TempDir::new().expect("temporary directory");
        let storage = storage(&directory);
        let pasted = attachment("018f47aa-09d2-7b34-a2d3-8c4e6f000004");
        storage
            .chats()
            .save_attachment(&pasted, b"hi")
            .expect("save attachment");

        let collected = storage
            .chats()
            .collect(&Cutoffs {
                attachments_before: 0,
                ..everything_is_old()
            })
            .expect("collect");

        assert_eq!(collected.attachments_removed, 0);
        assert_eq!(
            storage
                .chats()
                .read_attachment(&pasted)
                .expect("still readable"),
            b"hi"
        );
    }
}

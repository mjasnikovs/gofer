//! What a project remembers, and what a finished turn deposits there.
//!
//! Lifted out of `ai_turn`, where it read as part of a turn's lifetime rather than as a subject of
//! its own. It is not: a memory outlives the turn that wrote it, the backfill runs from maintenance
//! with no turn anywhere, and the retrieval is a search. What kept it there is that embedding needs
//! the memory worker, which `storage` cannot reach — so this sits between the two and belongs to
//! neither.

use crate::storage::{
    ProjectStorage, SaveMemoryEmbeddingRequest, SearchMemoryRequest, UpsertMemoryRequest,
};

/// How many memories one backfill will re-embed before leaving the rest for the next run.
const BACKFILL_LIMIT: usize = 200;

pub(crate) fn retrieve_memory_context(
    storage: &ProjectStorage,
    prompt: &str,
    task_id: Option<&str>,
) -> Result<String, String> {
    #[cfg(feature = "webdriver")]
    if std::env::var_os("GOFER_WEBDRIVER_RAG_READY").is_some() {
        return Err("Memory retrieval is disabled for the prepared WebDriver cache".to_owned());
    }

    if prompt.trim().is_empty() {
        return Err("No text is available for memory retrieval".to_owned());
    }
    let vector = crate::memory::embed_query(prompt, &crate::rag::cache_path()?).ok();
    let results = storage
        .memory()
        .search(&SearchMemoryRequest {
            query: prompt.to_owned(),
            task_id: task_id.map(str::to_owned),
            vector,
            limit: Some(6),
        })
        .map_err(|failure| failure.message)?;
    if results.is_empty() {
        return Err("No relevant project memories were found".to_owned());
    }
    Ok(results
        .into_iter()
        .map(|result| format!("- [{}] {}", result.memory.kind, result.memory.content))
        .collect::<Vec<_>>()
        .join("\n"))
}

pub(crate) fn remember_completed_turn(
    storage: &ProjectStorage,
    task_id: Option<&str>,
    prompt: &str,
    completion: &str,
) -> Result<(), String> {
    #[cfg(feature = "webdriver")]
    if std::env::var_os("GOFER_WEBDRIVER_RAG_READY").is_some() {
        return Ok(());
    }

    if prompt.trim().is_empty() || completion.trim().is_empty() {
        return Ok(());
    }
    let content = format!(
        "User request: {}\nOutcome: {}",
        truncate_text(prompt.trim(), 1_000),
        truncate_text(completion.trim(), 2_000)
    );
    let record = storage
        .memory()
        .upsert(&UpsertMemoryRequest {
            id: None,
            task_id: task_id.map(str::to_owned),
            kind: "summary".to_owned(),
            state: "confirmed".to_owned(),
            content: content.clone(),
            provenance: serde_json::json!({"source": "completed-ai-turn"}),
            superseded_by: None,
        })
        .map_err(|failure| failure.message)?;
    // A failure here must not fail the AI turn, but it must not vanish either: the memory stays
    // lexical-only until maintenance re-embeds it, so say so instead of silently degrading.
    match embed_memory(storage, &record.id, &content) {
        Ok(()) => Ok(()),
        Err(error) => {
            eprintln!(
                "Storing the memory embedding failed, retry with storage maintenance: {error}"
            );
            Err(error)
        }
    }
}

fn embed_memory(storage: &ProjectStorage, memory_id: &str, content: &str) -> Result<(), String> {
    let vector = crate::memory::embed_documents(&[content.to_owned()], &crate::rag::cache_path()?)?
        .pop()
        .ok_or_else(|| "The memory worker returned no document vector".to_owned())?;
    storage
        .memory()
        .save_embedding(&SaveMemoryEmbeddingRequest {
            memory_id: memory_id.to_owned(),
            model: crate::memory::MODEL.to_owned(),
            vector,
        })
        .map_err(|failure| failure.message)
}

/// Re-embeds memories that lost or never received a vector, returning how many were restored.
///
/// Embedding needs the memory worker, so this cannot live in `storage`. It stops at the first
/// failure because every remaining memory would fail the same way when the worker is unavailable.
pub(crate) fn backfill_memory_embeddings(storage: &ProjectStorage) -> usize {
    let Ok(pending) = storage.memory().missing_embeddings(BACKFILL_LIMIT) else {
        return 0;
    };
    let mut restored = 0;
    for memory in pending {
        if embed_memory(storage, &memory.id, &memory.content).is_err() {
            break;
        }
        restored += 1;
    }
    restored
}

fn truncate_text(text: &str, maximum: usize) -> String {
    text.chars().take(maximum).collect()
}

#[cfg(test)]
mod tests {
    use super::{backfill_memory_embeddings, remember_completed_turn, retrieve_memory_context};
    use crate::storage::ProjectStorage;
    use std::fs;
    use tempfile::TempDir;

    fn storage(directory: &TempDir) -> ProjectStorage {
        let workspace = directory.path().join("workspace");
        fs::create_dir_all(&workspace).expect("workspace");
        ProjectStorage::open(&directory.path().join("data"), &workspace).expect("storage")
    }

    /**
     * Nothing to search with is not a search that found nothing.
     *
     * The retrieval runs on whatever the turn is about, and a turn can be started from an empty
     * composer or from a prompt that is only whitespace. Embedding that would spend the worker on
     * nothing and hand the model six unrelated memories as context for a request it does not have.
     */
    #[test]
    fn a_prompt_with_no_text_in_it_is_refused_before_the_worker_is_reached() {
        let directory = TempDir::new().expect("temporary directory");
        let failure = retrieve_memory_context(&storage(&directory), "   \n\t ", None)
            .expect_err("nothing to retrieve against");

        assert_eq!(failure, "No text is available for memory retrieval");
    }

    /**
     * A half-empty turn deposits nothing, and that is a success.
     *
     * A turn that was cancelled before the model answered has a prompt and no completion; a turn
     * started from an empty composer has the reverse. Storing either writes a memory that says
     * only what was asked or only what came back, and the retrieval later offers it as precedent.
     * Refusing it would fail the turn over housekeeping the turn does not depend on.
     */
    #[test]
    fn a_turn_missing_either_half_is_not_remembered_and_is_not_a_failure() {
        let directory = TempDir::new().expect("temporary directory");
        let storage = storage(&directory);

        remember_completed_turn(&storage, None, "  ", "a menu was added").expect("no prompt");
        remember_completed_turn(&storage, None, "add a pause menu", "\n").expect("no completion");

        assert_eq!(
            backfill_memory_embeddings(&storage),
            0,
            "nothing was stored"
        );
    }
}

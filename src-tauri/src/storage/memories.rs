//! What the agent has been told to remember, and the embeddings that find it again.

use std::collections::HashMap;

use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use uuid::Uuid;

use super::*;
use crate::command_error::CommandError;

/// What the agent has been told to remember, and the embeddings that find it again.
pub struct Memories<'a> {
    pub(super) storage: &'a ProjectStorage,
}

impl Memories<'_> {
    pub fn upsert(&self, request: &UpsertMemoryRequest) -> Result<MemoryRecord, CommandError> {
        self.upsert_record(request)
            .map_err(CommandError::or_coded("memory_not_saved"))
    }

    fn upsert_record(&self, request: &UpsertMemoryRequest) -> Result<MemoryRecord, CommandError> {
        validate_memory(request)?;
        let (_write_guard, mut connection) = self.storage.write_connection()?;
        if let Some(task_id) = &request.task_id {
            require_task(&connection, task_id)?;
        }
        let id = request
            .id
            .clone()
            .unwrap_or_else(|| Uuid::now_v7().to_string());
        let now = now_millis()?;
        let provenance = serde_json::to_string(&request.provenance).map_err(|error| {
            CommandError::from(format!("Could not serialize memory provenance: {error}"))
        })?;
        let previous = connection
            .query_row(
                "SELECT task_id, content FROM memory_items WHERE id = ?1",
                [&id],
                |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()
            .map_err(database_error)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(database_error)?;
        transaction
            .execute(
                "INSERT INTO memory_items
                 (id, task_id, kind, state, content, provenance_json, superseded_by, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
                 ON CONFLICT(id) DO UPDATE SET
                    task_id = excluded.task_id,
                    kind = excluded.kind,
                    state = excluded.state,
                    content = excluded.content,
                    provenance_json = excluded.provenance_json,
                    superseded_by = excluded.superseded_by,
                    updated_at = excluded.updated_at",
                params![
                    id,
                    request.task_id,
                    request.kind,
                    request.state,
                    request.content.trim(),
                    provenance,
                    request.superseded_by,
                    now
                ],
            )
            .map_err(database_error)?;
        if previous.as_ref().is_some_and(|previous| {
            previous.0 != request.task_id || previous.1 != request.content.trim()
        }) {
            transaction
                .execute("DELETE FROM memory_vectors WHERE memory_id = ?1", [&id])
                .map_err(database_error)?;
            transaction
                .execute("DELETE FROM memory_embeddings WHERE memory_id = ?1", [&id])
                .map_err(database_error)?;
        }
        transaction.commit().map_err(database_error)?;
        memory_by_id(&connection, &id)?
            .ok_or_else(|| CommandError::from("The stored memory was not found".to_owned()))
    }

    pub fn save_embedding(&self, request: &SaveMemoryEmbeddingRequest) -> Result<(), CommandError> {
        self.store_embedding(request)
            .map_err(CommandError::or_coded("memory_embedding_not_saved"))
    }

    fn store_embedding(&self, request: &SaveMemoryEmbeddingRequest) -> Result<(), CommandError> {
        let (_write_guard, mut connection) = self.storage.write_connection()?;
        self.write_embedding(&mut connection, request)
    }

    /// Writes one vector into both tables, on a connection whose write lock the caller already has.
    ///
    /// Split out of [`Memories::save_embedding`] for the backfill in [`Memories::collect`], which
    /// runs inside maintenance's single write lock. The lock is a plain mutex and is not reentrant,
    /// so a re-embed that went through `save_embedding` would deadlock against the pass that asked
    /// for it.
    fn write_embedding(
        &self,
        connection: &mut Connection,
        request: &SaveMemoryEmbeddingRequest,
    ) -> Result<(), CommandError> {
        validate_embedding(request)?;
        let task_id = connection
            .query_row(
                "SELECT task_id FROM memory_items WHERE id = ?1",
                [&request.memory_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()
            .map_err(database_error)?
            .ok_or_else(|| CommandError::from("The memory record was not found".to_owned()))?;
        let bytes = vector_bytes(&request.vector);
        let scope_key = task_id.unwrap_or_else(|| "project".to_owned());
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(database_error)?;
        transaction
            .execute(
                "INSERT INTO memory_embeddings
                 (memory_id, model, dimensions, normalized, format_version, embedding, updated_at)
                 VALUES (?1, ?2, ?3, 1, 1, ?4, ?5)
                 ON CONFLICT(memory_id) DO UPDATE SET
                    model = excluded.model,
                    dimensions = excluded.dimensions,
                    normalized = excluded.normalized,
                    format_version = excluded.format_version,
                    embedding = excluded.embedding,
                    updated_at = excluded.updated_at",
                params![
                    request.memory_id,
                    request.model.trim(),
                    MEMORY_EMBEDDING_DIMENSIONS as i64,
                    bytes,
                    now_millis()?
                ],
            )
            .map_err(database_error)?;
        transaction
            .execute(
                "DELETE FROM memory_vectors WHERE memory_id = ?1",
                [&request.memory_id],
            )
            .map_err(database_error)?;
        transaction
            .execute(
                "INSERT INTO memory_vectors (memory_id, embedding, scope_key)
                 VALUES (?1, ?2, ?3)",
                params![request.memory_id, vector_bytes(&request.vector), scope_key],
            )
            .map_err(database_error)?;
        transaction.commit().map_err(database_error)
    }

    /// Memories whose vector is missing, so hybrid search has silently degraded to lexical only.
    ///
    /// A vector is absent when the embedding worker was unavailable while the memory was stored,
    /// or when `upsert_memory` invalidated it after a content or scope change. Nothing else
    /// regenerates one, so maintenance uses this to re-embed them.
    pub fn missing_embeddings(&self, limit: usize) -> Result<Vec<MemoryRecord>, CommandError> {
        self.records_missing_embeddings(limit)
            .map_err(CommandError::or_coded("memory_unavailable"))
    }

    /// Every vector the maintenance backfill is about to write, worked out before the lock.
    ///
    /// None of this needs the write lock and all of it is slow. Reading which memories have no
    /// vector is a read, and turning their text into a vector is a round trip to the memory worker
    /// *subprocess* — up to [`BACKFILL_LIMIT`] of them, one after another. Held under the project's
    /// single write mutex, a project with two hundred unembedded memories blocks every chat save,
    /// sketch keep, memory upsert and task write for the whole pass.
    ///
    /// It stops at the first failure, because a worker that cannot answer for one memory cannot
    /// answer for the next two hundred either, and each attempt would pay the same timeout.
    pub(crate) fn embeddings_to_restore(&self) -> Result<Vec<PendingEmbedding>, CommandError> {
        let mut prepared = Vec::new();
        for memory in self.missing_embeddings(BACKFILL_LIMIT)? {
            let Ok(vector) = crate::project_memory::memory_vector(&memory.content) else {
                break;
            };
            prepared.push(PendingEmbedding {
                request: SaveMemoryEmbeddingRequest {
                    memory_id: memory.id,
                    model: MEMORY_EMBEDDING_MODEL.to_owned(),
                    vector,
                },
                content: memory.content,
            });
        }
        Ok(prepared)
    }

    fn records_missing_embeddings(&self, limit: usize) -> Result<Vec<MemoryRecord>, CommandError> {
        let connection = self.storage.connection()?;
        let mut statement = connection
            .prepare(
                "SELECT m.id FROM memory_items m
                 LEFT JOIN memory_embeddings e ON e.memory_id = m.id
                 WHERE e.memory_id IS NULL
                 ORDER BY m.updated_at DESC
                 LIMIT ?1",
            )
            .map_err(database_error)?;
        let ids = statement
            .query_map([limit as i64], |row| row.get::<_, String>(0))
            .map_err(database_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(database_error)?;
        drop(statement);
        let mut records = Vec::with_capacity(ids.len());
        for id in ids {
            if let Some(record) = memory_by_id(&connection, &id)? {
                records.push(record);
            }
        }
        Ok(records)
    }

    /// One memory by id, or nothing when the project has never held it.
    pub fn get(&self, id: &str) -> Result<Option<MemoryRecord>, CommandError> {
        let connection = self
            .storage
            .connection()
            .map_err(CommandError::or_coded("memory_unavailable"))?;
        memory_by_id(&connection, id)
    }

    /// Every memory the project holds, most recently changed first.
    ///
    /// Search cannot answer this and is not a narrower version of it. Search needs a query, ranks
    /// what it finds, and reads only `confirmed` rows — which is precisely the set a person
    /// reviewing this cannot see past. A memory demoted to `candidate` has been taken away from the
    /// model and still has to be visible to whoever demoted it, or the demotion looks like a delete.
    pub fn list(&self, limit: usize) -> Result<Vec<MemoryRecord>, CommandError> {
        self.listed_records(limit)
            .map_err(CommandError::or_coded("memory_unavailable"))
    }

    fn listed_records(&self, limit: usize) -> Result<Vec<MemoryRecord>, CommandError> {
        let connection = self.storage.connection()?;
        let mut statement = connection
            .prepare(&format!(
                "SELECT {MEMORY_COLUMNS} FROM memory_items
                 ORDER BY updated_at DESC, id DESC
                 LIMIT ?1"
            ))
            .map_err(database_error)?;
        let rows = statement
            .query_map([limit as i64], memory_columns)
            .map_err(database_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(database_error)?;
        rows.into_iter().map(memory_record).collect()
    }

    /// Forgets one memory for good.
    ///
    /// The vector goes with it without being named here: the embedding cascades on the foreign key
    /// and `memory_items_ad_vectors` deletes the `vec0` row the cascade cannot reach. A row that is
    /// not there is reported rather than passed over, because the caller is a person who just
    /// pressed Delete on something the list showed them.
    pub fn delete(&self, id: &str) -> Result<(), CommandError> {
        self.delete_record(id)
            .map_err(CommandError::or_coded("memory_not_deleted"))
    }

    fn delete_record(&self, id: &str) -> Result<(), CommandError> {
        let (_write_guard, connection) = self.storage.write_connection()?;
        let removed = connection
            .execute("DELETE FROM memory_items WHERE id = ?1", [id])
            .map_err(database_error)?;
        if removed == 0 {
            return Err(CommandError::new(
                "memory_not_found",
                format!("There is no memory {id} to delete"),
            ));
        }
        Ok(())
    }

    pub fn search(
        &self,
        request: &SearchMemoryRequest,
    ) -> Result<Vec<MemorySearchResult>, CommandError> {
        self.search_records(request)
            .map_err(CommandError::or_coded("memory_unavailable"))
    }

    fn search_records(
        &self,
        request: &SearchMemoryRequest,
    ) -> Result<Vec<MemorySearchResult>, CommandError> {
        let limit = request.limit.unwrap_or(10).clamp(1, 50);
        if request.query.trim().is_empty() && request.vector.is_none() {
            return Err(CommandError::from(
                "Memory search requires text or a query vector".to_owned(),
            ));
        }
        if let Some(vector) = &request.vector {
            validate_vector(vector)?;
        }
        let connection = self.storage.connection()?;
        if let Some(task_id) = &request.task_id {
            require_task(&connection, task_id)?;
        }
        let mut scores = HashMap::<String, SearchScore>::new();
        let fts_query = fts_query(&request.query);
        if !fts_query.is_empty() {
            let mut statement = connection
                .prepare(
                    "SELECT m.id
                     FROM memory_fts
                     JOIN memory_items m ON m.rowid = memory_fts.rowid
                     WHERE memory_fts MATCH ?1
                       AND m.state = 'confirmed'
                       AND (m.task_id IS NULL OR m.task_id = ?2)
                     ORDER BY bm25(memory_fts)
                     LIMIT ?3",
                )
                .map_err(database_error)?;
            for (rank, id) in statement
                .query_map(
                    params![fts_query, request.task_id, (limit * 4) as i64],
                    |row| row.get::<_, String>(0),
                )
                .map_err(database_error)?
                .enumerate()
            {
                scores
                    .entry(id.map_err(database_error)?)
                    .or_default()
                    .text_rank = Some(rank + 1);
            }
        }
        if let Some(vector) = &request.vector {
            let scopes = match &request.task_id {
                Some(task_id) => vec!["project".to_owned(), task_id.clone()],
                None => vec!["project".to_owned()],
            };
            let query_bytes = vector_bytes(vector);
            let mut vector_rank = 1;
            for scope in scopes {
                let mut statement = connection
                    .prepare(
                        "SELECT memory_id, distance FROM memory_vectors
                         WHERE embedding MATCH ?1 AND k = ?2 AND scope_key = ?3
                         ORDER BY distance",
                    )
                    .map_err(database_error)?;
                let matches = statement
                    .query_map(params![query_bytes, (limit * 4) as i64, scope], |row| {
                        Ok((row.get::<_, String>(0)?, row.get::<_, f64>(1)?))
                    })
                    .map_err(database_error)?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(database_error)?;
                for (id, distance) in matches {
                    let score = scores.entry(id).or_default();
                    score.vector_rank = Some(vector_rank);
                    score.vector_distance = Some(distance);
                    vector_rank += 1;
                }
            }
        }
        let mut results = scores
            .into_iter()
            .filter_map(|(id, ranks)| {
                let memory = memory_by_id(&connection, &id).ok().flatten()?;
                if memory.state != "confirmed"
                    || (memory.task_id.is_some() && memory.task_id != request.task_id)
                {
                    return None;
                }
                let score = ranks.text_rank.map_or(0.0, reciprocal_rank)
                    + ranks.vector_rank.map_or(0.0, reciprocal_rank);
                Some(MemorySearchResult {
                    memory,
                    score,
                    text_rank: ranks.text_rank,
                    vector_distance: ranks.vector_distance,
                })
            })
            .collect::<Vec<_>>();
        results.sort_by(|left, right| right.score.total_cmp(&left.score));
        results.truncate(limit);
        Ok(results)
    }

    /// The vectors that should exist and do not, and the ones that exist and should not.
    ///
    /// Restoring is what this view collects rather than what it deletes, and it is the only upkeep
    /// of the six that puts something back. A memory with no vector is not visible as broken: the
    /// hybrid search still answers, having quietly become lexical-only for that row, so nothing
    /// short of this ever notices.
    ///
    /// The embedding itself has to leave the crate — the vector comes from the memory worker, which
    /// `storage` cannot reach — so `project_memory` supplies it and this owns both writes. It used
    /// to be the other way round: the whole backfill lived in `project_memory` and `lib.rs` ran it
    /// after `run_maintenance` returned, which is exactly why the returned result carried a zero the
    /// caller had to overwrite.
    ///
    /// The vectors arrive already computed, from [`embeddings_to_restore`](Self::embeddings_to_restore),
    /// which ran before the write lock was taken. Only the writes belong under it.
    ///
    /// An orphan vector is a row in `memory_vectors` whose memory is gone. Since schema V3 a
    /// trigger removes it — the vec0 virtual table is outside the `ON DELETE CASCADE` that
    /// `memory_embeddings` gets — so what is left is what a database written before V3 kept, and a
    /// vector nothing can delete is a vector the cosine search keeps ranking forever.
    pub(crate) fn collect(
        &self,
        _cutoffs: &Cutoffs,
        pending: &[PendingEmbedding],
    ) -> Result<Collected, CommandError> {
        let mut connection = self.storage.connection()?;
        let mut restored = 0;
        for entry in pending {
            // Re-read under the lock, because the vector was computed without it. A memory deleted
            // in that window has nothing to write; one edited in it had its vector dropped on
            // purpose, and writing this one back would index the row under text it no longer holds
            // while `missing_embeddings` stops reporting it. Both are skipped rather than raised:
            // the backfill is one of six upkeep views and must not take the other five down.
            let current = connection
                .query_row(
                    "SELECT content FROM memory_items WHERE id = ?1",
                    [&entry.request.memory_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(database_error)?;
            if current.as_deref() != Some(entry.content.as_str()) {
                continue;
            }
            if self
                .write_embedding(&mut connection, &entry.request)
                .is_err()
            {
                continue;
            }
            restored += 1;
        }
        let mut statement = connection
            .prepare(
                "SELECT memory_id FROM memory_vectors
                 WHERE memory_id NOT IN (SELECT id FROM memory_items)",
            )
            .map_err(database_error)?;
        let orphaned = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(database_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(database_error)?;
        drop(statement);
        for memory_id in &orphaned {
            connection
                .execute(
                    "DELETE FROM memory_vectors WHERE memory_id = ?1",
                    [memory_id],
                )
                .map_err(database_error)?;
        }
        let refiled = self.refile_drifted_vectors(&connection)?;
        Ok(Collected {
            memory_embeddings_restored: restored,
            memory_vectors_removed: orphaned.len(),
            memory_vectors_refiled: refiled,
            ..Collected::default()
        })
    }

    /// Vectors filed under a scope their memory has left, put back under the one it has now.
    ///
    /// `scope_key` is a partition key: [`Memories::search`] asks for one scope and vec0 answers
    /// only out of that partition, so a vector filed under the wrong one is invisible to search
    /// rather than merely mis-ranked. It is written once, by [`Memories::write_embedding`], and the
    /// only thing that invalidates it on a scope change is [`Memories::upsert`].
    ///
    /// Which leaves the case nothing was watching. `memory_items.task_id` is `ON DELETE SET NULL`,
    /// so deleting a task rewrites its memories to project scope without going through `upsert` at
    /// all: the rows survive, the vectors stay filed under a task id nothing can name any more, and
    /// the memories are lexical-only from then on. Permanently — `missing_embeddings` keys on
    /// `memory_embeddings`, which is still there, so the backfill never looks at them, and the
    /// orphan sweep above only removes vectors whose memory is gone.
    ///
    /// Re-filed from the stored embedding rather than re-embedded: the vector is the same vector,
    /// only the partition it sits in is wrong, and the worker is a subprocess round trip away. A
    /// row with no stored embedding is one the backfill already reports, so its stale vector is
    /// simply dropped.
    fn refile_drifted_vectors(&self, connection: &Connection) -> Result<usize, CommandError> {
        let mut statement = connection
            .prepare("SELECT memory_id, scope_key FROM memory_vectors")
            .map_err(database_error)?;
        let filed = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(database_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(database_error)?;
        drop(statement);
        let mut refiled = 0;
        for (memory_id, scope) in filed {
            let Some(belongs) = connection
                .query_row(
                    "SELECT COALESCE(task_id, 'project') FROM memory_items WHERE id = ?1",
                    [&memory_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(database_error)?
            else {
                // Its memory is gone, which is the orphan sweep's to answer for and it already has.
                continue;
            };
            if belongs == scope {
                continue;
            }
            let embedding = connection
                .query_row(
                    "SELECT embedding FROM memory_embeddings WHERE memory_id = ?1",
                    [&memory_id],
                    |row| row.get::<_, Vec<u8>>(0),
                )
                .optional()
                .map_err(database_error)?;
            connection
                .execute(
                    "DELETE FROM memory_vectors WHERE memory_id = ?1",
                    [&memory_id],
                )
                .map_err(database_error)?;
            let Some(embedding) = embedding else {
                continue;
            };
            connection
                .execute(
                    "INSERT INTO memory_vectors (memory_id, embedding, scope_key)
                     VALUES (?1, ?2, ?3)",
                    params![memory_id, embedding, belongs],
                )
                .map_err(database_error)?;
            refiled += 1;
        }
        Ok(refiled)
    }
}

pub(crate) fn validate_memory(request: &UpsertMemoryRequest) -> Result<(), CommandError> {
    if !["decision", "preference", "fact", "issue", "summary"].contains(&request.kind.as_str()) {
        return Err(CommandError::from("The memory kind is invalid".to_owned()));
    }
    if !["candidate", "confirmed", "superseded"].contains(&request.state.as_str()) {
        return Err(CommandError::from("The memory state is invalid".to_owned()));
    }
    if request.content.trim().is_empty() {
        return Err(CommandError::from(
            "Memory content cannot be empty".to_owned(),
        ));
    }
    if request.content.len() > 64 * 1024 {
        return Err(CommandError::from(
            "Memory content cannot exceed 64 KiB".to_owned(),
        ));
    }
    if !request.provenance.is_object() {
        return Err(CommandError::from(
            "Memory provenance must be an object".to_owned(),
        ));
    }
    if request.provenance.to_string().len() > 256 * 1024 {
        return Err(CommandError::from(
            "Memory provenance cannot exceed 256 KiB".to_owned(),
        ));
    }
    Ok(())
}

pub(crate) fn validate_embedding(request: &SaveMemoryEmbeddingRequest) -> Result<(), CommandError> {
    if request.model.trim() != MEMORY_EMBEDDING_MODEL {
        return Err(format!("Memory embeddings must use {MEMORY_EMBEDDING_MODEL}").into());
    }
    validate_vector(&request.vector)
}

pub(crate) fn validate_vector(vector: &[f32]) -> Result<(), CommandError> {
    if vector.len() != MEMORY_EMBEDDING_DIMENSIONS {
        return Err(format!(
            "Memory vectors must contain {MEMORY_EMBEDDING_DIMENSIONS} dimensions"
        )
        .into());
    }
    if vector.iter().any(|value| !value.is_finite()) {
        return Err(CommandError::from(
            "Memory vectors must contain only finite numbers".to_owned(),
        ));
    }
    let magnitude = vector
        .iter()
        .map(|value| f64::from(*value) * f64::from(*value))
        .sum::<f64>()
        .sqrt();
    if (magnitude - 1.0).abs() > 0.01 {
        return Err(CommandError::from(
            "Memory vectors must be normalized".to_owned(),
        ));
    }
    Ok(())
}

fn vector_bytes(vector: &[f32]) -> Vec<u8> {
    vector
        .iter()
        .flat_map(|value| value.to_ne_bytes())
        .collect()
}

fn fts_query(query: &str) -> String {
    query
        .split(|character: char| !character.is_alphanumeric() && character != '_')
        .filter(|token| !token.is_empty())
        .map(|token| format!("\"{}\"", token.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" OR ")
}

fn reciprocal_rank(rank: usize) -> f64 {
    1.0 / (60.0 + rank as f64)
}

/// The columns every memory read selects, in the order both readers below expect them.
const MEMORY_COLUMNS: &str = "id, task_id, kind, state, content, provenance_json,
                              superseded_by, created_at, updated_at";

/// One row as SQLite hands it over, before the JSON and the timestamps are made sense of.
///
/// Split from [`memory_record`] because the two failures are different: a column rusqlite cannot
/// read is a database fault it reports itself, and provenance that will not parse is ours. Keeping
/// them in one closure meant `query_map` had to carry a `Result` inside a `Result`.
type MemoryColumns = (
    String,
    Option<String>,
    String,
    String,
    String,
    String,
    Option<String>,
    i64,
    i64,
);

fn memory_columns(row: &rusqlite::Row<'_>) -> rusqlite::Result<MemoryColumns> {
    Ok((
        row.get::<_, String>(0)?,
        row.get::<_, Option<String>>(1)?,
        row.get::<_, String>(2)?,
        row.get::<_, String>(3)?,
        row.get::<_, String>(4)?,
        row.get::<_, String>(5)?,
        row.get::<_, Option<String>>(6)?,
        row.get::<_, i64>(7)?,
        row.get::<_, i64>(8)?,
    ))
}

fn memory_record(row: MemoryColumns) -> Result<MemoryRecord, CommandError> {
    Ok(MemoryRecord {
        id: row.0,
        task_id: row.1,
        kind: row.2,
        state: row.3,
        content: row.4,
        provenance: serde_json::from_str(&row.5).map_err(|error| {
            CommandError::from(format!("Stored memory provenance is invalid: {error}"))
        })?,
        superseded_by: row.6,
        created_at: from_database_u64(row.7, "memory creation time")?,
        updated_at: from_database_u64(row.8, "memory update time")?,
    })
}

fn memory_by_id(connection: &Connection, id: &str) -> Result<Option<MemoryRecord>, CommandError> {
    connection
        .query_row(
            &format!("SELECT {MEMORY_COLUMNS} FROM memory_items WHERE id = ?1"),
            [id],
            memory_columns,
        )
        .optional()
        .map_err(database_error)?
        .map(memory_record)
        .transpose()
}

#[cfg(test)]
mod tests {
    use super::super::test_support::*;
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn memory_supports_hybrid_search_and_invalidates_stale_embeddings() {
        let directory = TempDir::new().expect("temporary directory");
        let storage = storage(&directory);
        let memory = storage
            .memory()
            .upsert(&UpsertMemoryRequest {
                id: None,
                task_id: None,
                kind: "decision".to_owned(),
                state: "confirmed".to_owned(),
                content: "Use CharacterBody2D for the player controller".to_owned(),
                provenance: serde_json::json!({"source": "user"}),
                superseded_by: None,
            })
            .expect("save memory");
        let mut vector = vec![0.0; MEMORY_EMBEDDING_DIMENSIONS];
        vector[0] = 1.0;
        storage
            .memory()
            .save_embedding(&SaveMemoryEmbeddingRequest {
                memory_id: memory.id.clone(),
                model: MEMORY_EMBEDDING_MODEL.to_owned(),
                vector: vector.clone(),
            })
            .expect("save embedding");

        let results = storage
            .memory()
            .search(&SearchMemoryRequest {
                query: "CharacterBody2D player".to_owned(),
                task_id: None,
                vector: Some(vector),
                limit: Some(5),
            })
            .expect("search memory");

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].memory.id, memory.id);
        assert_eq!(results[0].text_rank, Some(1));
        assert_eq!(results[0].vector_distance, Some(0.0));

        storage
            .memory()
            .upsert(&UpsertMemoryRequest {
                id: Some(memory.id.clone()),
                task_id: None,
                kind: "decision".to_owned(),
                state: "confirmed".to_owned(),
                content: "Use a custom Node for the player controller".to_owned(),
                provenance: serde_json::json!({"source": "user"}),
                superseded_by: None,
            })
            .expect("update memory");
        let connection = storage.connection().expect("connection");
        let embeddings = connection
            .query_row("SELECT count(*) FROM memory_embeddings", [], |row| {
                row.get::<_, u32>(0)
            })
            .expect("embedding count");
        assert_eq!(embeddings, 0);
    }

    #[test]
    fn memories_without_vectors_are_reported_and_deletions_clear_the_vector_index() {
        let directory = TempDir::new().expect("temporary directory");
        let storage = storage(&directory);
        let memory = storage
            .memory()
            .upsert(&UpsertMemoryRequest {
                id: None,
                task_id: None,
                kind: "fact".to_owned(),
                state: "confirmed".to_owned(),
                content: "The player scene lives in scenes/player.tscn".to_owned(),
                provenance: serde_json::json!({"source": "user"}),
                superseded_by: None,
            })
            .expect("save memory");

        let pending = storage
            .memory()
            .missing_embeddings(10)
            .expect("pending memories");
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].id, memory.id);
        assert_eq!(
            pending[0].content,
            "The player scene lives in scenes/player.tscn"
        );

        let mut vector = vec![0.0; MEMORY_EMBEDDING_DIMENSIONS];
        vector[0] = 1.0;
        storage
            .memory()
            .save_embedding(&SaveMemoryEmbeddingRequest {
                memory_id: memory.id.clone(),
                model: MEMORY_EMBEDDING_MODEL.to_owned(),
                vector,
            })
            .expect("save embedding");
        assert!(
            storage
                .memory()
                .missing_embeddings(10)
                .expect("pending memories")
                .is_empty()
        );

        // Rewriting the content invalidates the vector, which must make it pending again.
        storage
            .memory()
            .upsert(&UpsertMemoryRequest {
                id: Some(memory.id.clone()),
                task_id: None,
                kind: "fact".to_owned(),
                state: "confirmed".to_owned(),
                content: "The player scene moved to scenes/actors/player.tscn".to_owned(),
                provenance: serde_json::json!({"source": "user"}),
                superseded_by: None,
            })
            .expect("update memory");
        assert_eq!(
            storage
                .memory()
                .missing_embeddings(10)
                .expect("pending memories")
                .len(),
            1
        );

        let connection = storage.connection().expect("connection");
        connection
            .execute(
                "INSERT INTO memory_vectors (memory_id, embedding, scope_key)
                 VALUES (?1, ?2, 'project')",
                params![
                    memory.id,
                    vector_bytes(&vec![0.5; MEMORY_EMBEDDING_DIMENSIONS])
                ],
            )
            .expect("orphan vector");
        connection
            .execute("DELETE FROM memory_items WHERE id = ?1", [&memory.id])
            .expect("delete memory");
        let vectors = connection
            .query_row("SELECT count(*) FROM memory_vectors", [], |row| {
                row.get::<_, u32>(0)
            })
            .expect("vector count");
        assert_eq!(vectors, 0);
    }

    /*
     * The vectors are computed before the write lock is taken, so what they came FROM is checked
     * once it is held.
     *
     * Two hundred round trips to the memory worker is a window minutes wide, and both things that
     * can happen in it used to go wrong. A memory deleted in that window made `write_embedding`
     * error and the `?` took the whole maintenance fold down — backups unpruned, stale answers
     * unpurged. A memory EDITED in it had its vector dropped precisely because the content changed,
     * and the stale one was written back against the new text: `missing_embeddings` stopped
     * reporting the row, so nothing would ever notice it was indexed under words it no longer held.
     */
    #[test]
    fn a_vector_is_written_only_if_the_text_it_was_computed_from_is_still_there() {
        let directory = TempDir::new().expect("temporary directory");
        let storage = storage(&directory);
        let remember = |content: &str| {
            storage
                .memory()
                .upsert(&UpsertMemoryRequest {
                    id: None,
                    task_id: None,
                    kind: "fact".to_owned(),
                    state: "confirmed".to_owned(),
                    content: content.to_owned(),
                    provenance: serde_json::json!({"source": "user"}),
                    superseded_by: None,
                })
                .expect("save memory")
        };
        let edited = remember("The pause menu lives in ui/pause.tscn");
        let removed = remember("The player scene lives in scenes/player.tscn");
        let kept = remember("The input map names ui_cancel");
        let mut vector = vec![0.0; MEMORY_EMBEDDING_DIMENSIONS];
        vector[0] = 1.0;
        let computed = |memory: &MemoryRecord| PendingEmbedding {
            request: SaveMemoryEmbeddingRequest {
                memory_id: memory.id.clone(),
                model: MEMORY_EMBEDDING_MODEL.to_owned(),
                vector: vector.clone(),
            },
            content: memory.content.clone(),
        };
        let pending = vec![computed(&edited), computed(&removed), computed(&kept)];

        // The window: one memory rewritten, one deleted, while the worker was busy.
        storage
            .memory()
            .upsert(&UpsertMemoryRequest {
                id: Some(edited.id.clone()),
                task_id: None,
                kind: "fact".to_owned(),
                state: "confirmed".to_owned(),
                content: "The pause menu lives in ui/menus/pause.tscn".to_owned(),
                provenance: serde_json::json!({"source": "user"}),
                superseded_by: None,
            })
            .expect("edit memory");
        let connection = storage.connection().expect("connection");
        connection
            .execute("DELETE FROM memory_items WHERE id = ?1", [&removed.id])
            .expect("delete memory");

        let collected = storage
            .memory()
            .collect(&everything_is_old(), &pending)
            .expect("collect");

        assert_eq!(
            collected.memory_embeddings_restored, 1,
            "only the memory that still holds the text the vector was computed from"
        );
        let still_missing = storage
            .memory()
            .missing_embeddings(10)
            .expect("missing")
            .into_iter()
            .map(|memory| memory.id)
            .collect::<Vec<_>>();
        assert_eq!(
            still_missing,
            vec![edited.id],
            "the edited row keeps no vector, so the next pass computes one for what it now says"
        );
        assert!(!still_missing.contains(&kept.id));
    }

    /// Deleting a task moves its memories to project scope, and the vectors have to move with them.
    ///
    /// `memory_items.task_id` is `ON DELETE SET NULL`, which rewrites the row without going through
    /// `upsert` — the only place that drops a vector on a scope change. `scope_key` is a partition
    /// key, so the vector stays filed under a task id nothing can name any more and the search,
    /// which asks for one scope, never sees it again. Nothing noticed: the embedding row is still
    /// there, so the backfill skips it, and the memory is still there, so the orphan sweep skips it.
    #[test]
    fn the_memories_view_refiles_vectors_whose_task_was_deleted() {
        let directory = TempDir::new().expect("temporary directory");
        let workspace = committed_repository(directory.path());
        let storage =
            ProjectStorage::open(&directory.path().join("data"), &workspace).expect("storage");
        let doomed = storage
            .tasks()
            .create(&storage.switch_with_no_turn_to_refuse(&NOTHING_TO_STOP))
            .expect("create task")
            .task_id
            .expect("task ID");
        let memory = storage
            .memory()
            .upsert(&UpsertMemoryRequest {
                id: None,
                task_id: Some(doomed.clone()),
                kind: "fact".to_owned(),
                state: "confirmed".to_owned(),
                content: "The player scene lives in scenes/player.tscn".to_owned(),
                provenance: serde_json::json!({"source": "user"}),
                superseded_by: None,
            })
            .expect("save memory");
        let mut vector = vec![0.0; MEMORY_EMBEDDING_DIMENSIONS];
        vector[0] = 1.0;
        storage
            .memory()
            .save_embedding(&SaveMemoryEmbeddingRequest {
                memory_id: memory.id.clone(),
                model: MEMORY_EMBEDDING_MODEL.to_owned(),
                vector: vector.clone(),
            })
            .expect("save embedding");
        storage
            .tasks()
            .delete(
                &doomed,
                &storage.switch_with_no_turn_to_refuse(&NOTHING_TO_STOP),
            )
            .expect("delete the task");

        let found = |storage: &ProjectStorage| {
            storage
                .memory()
                .search(&SearchMemoryRequest {
                    query: "player scene".to_owned(),
                    task_id: None,
                    vector: Some(vector.clone()),
                    limit: Some(5),
                })
                .expect("search")
        };
        let stranded = found(&storage);
        assert_eq!(stranded.len(), 1, "the memory itself survived the task");
        assert!(
            stranded[0].vector_distance.is_none(),
            "and its vector is filed where the search cannot reach it"
        );

        let collected = storage
            .memory()
            .collect(&everything_is_old(), &[])
            .expect("collect");

        assert_eq!(collected.memory_vectors_refiled, 1);
        assert_eq!(
            collected.memory_vectors_removed, 0,
            "the vector was moved rather than thrown away"
        );
        assert!(
            found(&storage)[0].vector_distance.is_some(),
            "the same vector, under the scope the memory is in now"
        );
    }

    /// A vector whose memory is gone is a vector the cosine search keeps ranking forever.
    ///
    /// `memory_vectors` is a vec0 virtual table, so it is outside the `ON DELETE CASCADE` that
    /// `memory_embeddings` gets. Since schema V3 a trigger removes it, which leaves what a database
    /// written before V3 kept — and nothing else would ever look.
    #[test]
    fn the_memories_view_collects_vectors_whose_memory_is_gone() {
        let directory = TempDir::new().expect("temporary directory");
        let storage = storage(&directory);
        let memory = storage
            .memory()
            .upsert(&UpsertMemoryRequest {
                id: None,
                task_id: None,
                kind: "fact".to_owned(),
                state: "confirmed".to_owned(),
                content: "The player scene lives in scenes/player.tscn".to_owned(),
                provenance: serde_json::json!({"source": "user"}),
                superseded_by: None,
            })
            .expect("save memory");
        let mut vector = vec![0.0; MEMORY_EMBEDDING_DIMENSIONS];
        vector[0] = 1.0;
        storage
            .memory()
            .save_embedding(&SaveMemoryEmbeddingRequest {
                memory_id: memory.id.clone(),
                model: MEMORY_EMBEDDING_MODEL.to_owned(),
                vector: vector.clone(),
            })
            .expect("save embedding");
        // What a pre-V3 database is left holding: the memory deleted, the vector not.
        let connection = storage.connection().expect("connection");
        connection
            .execute(
                "INSERT INTO memory_vectors (memory_id, embedding, scope_key)
                 VALUES ('01a0-gone', ?1, 'project')",
                params![vector_bytes(&vector)],
            )
            .expect("orphan vector");

        let collected = storage
            .memory()
            .collect(&everything_is_old(), &[])
            .expect("collect");

        assert_eq!(collected.memory_vectors_removed, 1);
        assert_eq!(
            collected.memory_embeddings_restored, 0,
            "every memory here already has its vector, so the worker is never reached"
        );
        let vectors = connection
            .query_row("SELECT count(*) FROM memory_vectors", [], |row| {
                row.get::<_, u32>(0)
            })
            .expect("vector count");
        assert_eq!(vectors, 1, "the memory that is still here keeps its vector");
        assert_eq!(
            storage
                .memory()
                .search(&SearchMemoryRequest {
                    query: "player scene".to_owned(),
                    task_id: None,
                    vector: Some(vector),
                    limit: Some(5),
                })
                .expect("search")
                .len(),
            1
        );
    }
}

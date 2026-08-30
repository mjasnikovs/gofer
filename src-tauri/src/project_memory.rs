//! What a project remembers, and what a finished turn deposits there.
//!
//! Lifted out of `ai_turn`, where it read as part of a turn's lifetime rather than as a subject of
//! its own. It is not: a memory outlives the turn that wrote it, the backfill runs from maintenance
//! with no turn anywhere, and the retrieval is a search. What kept it there is that embedding needs
//! the memory worker, which `storage` cannot reach — so this sits between the two and belongs to
//! neither.
//!
//! The backfill itself has since gone the other way. It is `Memories`' own upkeep now, collected
//! with everything else the memory view owns, and it reaches back here through [`memory_vector`]
//! for the one step that needs the worker. What is on this side is what has to leave the process.

use crate::command_error::CommandError;
use crate::files::Snapshot;
use crate::storage::{
    MemoryRecord, ProjectStorage, SaveMemoryEmbeddingRequest, SearchMemoryRequest,
    UpsertMemoryRequest,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// How many memories one listing hands the window.
///
/// A ceiling rather than a page, because the list is read by a person deciding what to throw away
/// and 500 rows is already more reviewing than anyone does in a sitting. The rows are newest first,
/// so what falls off the end is the oldest — and a project with more than this has a bigger problem
/// than paging.
const LIST_LIMIT: usize = 500;

/// How many paths one memory is checked on.
///
/// One row measured at 2,146 characters of ASCII layout mock-up, and a memory that long can name
/// dozens of files without any of them being what it is about.
const MAX_ANCHORS: usize = 20;

/// The file extensions a path in a memory is recognised by.
///
/// A closed list, not "any dot followed by letters". The text being scanned is prose a model wrote:
/// a version — `4.7.1` — and an abbreviation — `e.g.` — are both indistinguishable from a filename
/// under the looser rule, and each one would then be reported to the user as a file the project has
/// lost. Every entry here is something a Godot workspace actually holds.
const ANCHOR_EXTENSIONS: [&str; 30] = [
    "gd",
    "gdshader",
    "gdextension",
    "tscn",
    "scn",
    "tres",
    "res",
    "godot",
    "cfg",
    "import",
    "png",
    "jpg",
    "jpeg",
    "svg",
    "webp",
    "bmp",
    "tga",
    "exr",
    "ttf",
    "otf",
    "wav",
    "ogg",
    "mp3",
    "glb",
    "gltf",
    "obj",
    "json",
    "csv",
    "md",
    "txt",
];

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
    let vector = memory_vector(content)?;
    storage
        .memory()
        .save_embedding(&SaveMemoryEmbeddingRequest {
            memory_id: memory_id.to_owned(),
            model: crate::memory::MODEL.to_owned(),
            vector,
        })
        .map_err(|failure| failure.message)
}

/// The vector for one memory's text, from the worker that makes them.
///
/// The one step of remembering that `storage` cannot do for itself, which is the whole reason this
/// module sits between the two. The re-embedding backfill it used to own now runs as `Memories`'
/// own upkeep, under the single write lock maintenance takes — so what is left here is the part
/// that has to reach a subprocess, and storage reaches back through this for it.
pub(crate) fn memory_vector(content: &str) -> Result<Vec<f32>, String> {
    crate::memory::embed_documents(&[content.to_owned()], &crate::rag::cache_path()?)?
        .pop()
        .ok_or_else(|| "The memory worker returned no document vector".to_owned())
}

fn truncate_text(text: &str, maximum: usize) -> String {
    text.chars().take(maximum).collect()
}

/// What checking a memory's paths found.
///
/// `Stale` is deliberately not called wrong. The check knows one thing — whether a file this memory
/// names is in the workspace — and a memory whose whole subject is a deletion names a file that is
/// correctly gone. So the verdict says what was measured and the window says the same, leaving the
/// judgement to the person reading it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum MemoryCheck {
    /// The workspace could not be read, so nothing was compared against anything.
    Unchecked,
    /// The memory names no file, so there is nothing here this check can see.
    Unanchored,
    /// Every file it names is in the workspace.
    Intact,
    /// At least one file it names is not.
    Stale,
}

/// One path a memory names, and where — if anywhere — the workspace keeps it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MemoryAnchor {
    /// The path as the memory spells it, `res://` already stripped.
    pub named: String,
    /// The workspace path it resolved to. Absent is the whole finding.
    ///
    /// Left out rather than sent as `null`, because the renderer tells the two apart and only one
    /// of them is a field it declared. Sent as `null` this read as a path that had resolved to
    /// nothing, and every stale memory drew as naming zero missing files.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved: Option<String>,
}

/// What a model judge said about a memory, and whether it is still about this memory.
///
/// Stored, unlike the path check, and the difference is cost rather than principle. The path check
/// is a directory walk, so recomputing it on every read is what stops a verdict outliving the thing
/// it was about. A judgement is a model request and about a minute; it cannot be recomputed on a
/// read and so it can go stale, which means the two facts that let a reader discount it have to
/// travel with it: when it was made, and whether the text it was made about is the text stored now.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MemoryJudgement {
    /// `holds`, `broken` or `unclear`. Never anything else — see `parseVerdict`.
    pub verdict: String,
    pub reason: String,
    pub at: u64,
    /// The model that said it, because a verdict with no model against it cannot be weighed.
    pub model: String,
    /// Whether the memory still says what it said when this was written.
    ///
    /// Computed on read by comparing hashes, so an edited memory shows its old verdict as old
    /// instead of showing it as current. A judgement kept through an edit is worth keeping — the
    /// user usually edits BECAUSE of it — and worth marking.
    pub is_current: bool,
}

/// The key a judgement is filed under inside a memory's provenance.
///
/// Provenance rather than a column: the row already carries free-form JSON about where it came
/// from, and a judgement is exactly that. No migration, and `save_memory` already copies the object
/// across an edit, so the verdict survives the correction it prompted.
const JUDGEMENT_KEY: &str = "judged";

/// Files one judge's verdict against the memory it is about.
pub(crate) fn record_judgement(
    storage: &ProjectStorage,
    memory_id: &str,
    verdict: &str,
    reason: &str,
    model: &str,
) -> Result<(), CommandError> {
    let record = storage.memory().get(memory_id)?.ok_or_else(|| {
        CommandError::new(
            "memory_not_found",
            format!("There is no memory {memory_id} to judge"),
        )
    })?;
    let mut provenance = match record.provenance {
        serde_json::Value::Object(fields) => fields,
        _ => serde_json::Map::new(),
    };
    provenance.insert(
        JUDGEMENT_KEY.to_owned(),
        serde_json::json!({
            "verdict": verdict,
            "reason": reason,
            "model": model,
            "at": now_millis(),
            "contentSha": content_sha(&record.content),
        }),
    );
    storage
        .memory()
        .upsert(&UpsertMemoryRequest {
            id: Some(record.id),
            task_id: record.task_id,
            kind: record.kind,
            state: record.state,
            content: record.content,
            provenance: serde_json::Value::Object(provenance),
            superseded_by: record.superseded_by,
        })
        .map(|_| ())
}

/// The judgement filed against a memory, if one was ever made and can still be read.
fn judgement_of(record: &MemoryRecord) -> Option<MemoryJudgement> {
    let judged = record.provenance.get(JUDGEMENT_KEY)?;
    let text = |key: &str| judged.get(key).and_then(serde_json::Value::as_str);
    Some(MemoryJudgement {
        verdict: text("verdict")?.to_owned(),
        reason: text("reason").unwrap_or_default().to_owned(),
        at: judged.get("at").and_then(serde_json::Value::as_u64)?,
        model: text("model").unwrap_or_default().to_owned(),
        is_current: text("contentSha") == Some(content_sha(&record.content).as_str()),
    })
}

fn content_sha(content: &str) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(content.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Now, in milliseconds. Zero when the clock is before the epoch, which nothing here can act on.
fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as u64)
}

/// A stored memory with the result of checking it, which is computed and never stored.
///
/// Kept out of `memory_items` on purpose. A verdict written into the row is a second thing that can
/// go stale — the file comes back, the row still says it is gone — and there is nothing to re-run
/// it. Derived on every read, it cannot disagree with the workspace.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CheckedMemory {
    #[serde(flatten)]
    pub memory: MemoryRecord,
    pub check: MemoryCheck,
    pub anchors: Vec<MemoryAnchor>,
    /// What a model said about this memory, when one was ever asked. See [`MemoryJudgement`].
    #[serde(skip_serializing_if = "Option::is_none")]
    pub judgement: Option<MemoryJudgement>,
}

/// Every memory the project holds, each checked against the files the workspace has now.
pub(crate) fn list_checked_memories(
    storage: &ProjectStorage,
    workspace: Option<&Snapshot>,
) -> Result<Vec<CheckedMemory>, CommandError> {
    let records = storage.memory().list(LIST_LIMIT)?;
    let index = workspace.map(basename_index);
    Ok(records
        .into_iter()
        .map(|memory| check_memory(memory, workspace, index.as_ref()))
        .collect())
}

/// What the window may change about a memory. Everything else about the row is not its business.
///
/// Deliberately not [`UpsertMemoryRequest`]. That one carries `provenance`, `task_id` and
/// `superseded_by`, and the upsert overwrites all three with whatever it is handed — so a window
/// sending only what the user typed would silently replace `{"source":"completed-ai-turn"}` with an
/// empty object and cut every memory loose from the task it came out of. The record on disk is read
/// first and those three are carried across; the user gets the three fields they are editing.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MemoryEdit {
    /// Absent when the user is writing a memory that did not exist.
    pub id: Option<String>,
    pub kind: String,
    pub state: String,
    pub content: String,
}

/// Moves a list of memories to one state, and answers with them checked.
///
/// Triage, not editing. A sweep leaves eighty rows carrying a verdict and the only thing worth
/// doing about `broken` in bulk is to stop retrieval reading it — one press, having read the
/// reasons, rather than eighty trips through the editor.
///
/// It does not re-embed. `save_memory` does, because a person changing the text changes what the
/// row should be found by; here the content is untouched, `upsert` keeps the vector precisely
/// because it can see that, and re-embedding eighty unchanged sentences would be paying the model
/// worker for a result it already stored.
///
/// A row that has been deleted since the list was drawn is skipped rather than failing the batch.
/// The caller gets back what it moved and can see what did not come.
pub(crate) fn set_memory_states(
    storage: &ProjectStorage,
    ids: &[String],
    state: &str,
    workspace: Option<&Snapshot>,
) -> Result<Vec<CheckedMemory>, CommandError> {
    let index = workspace.map(basename_index);
    let mut moved = Vec::with_capacity(ids.len());
    for id in ids {
        let Some(existing) = storage.memory().get(id)? else {
            continue;
        };
        let record = storage.memory().upsert(&UpsertMemoryRequest {
            id: Some(existing.id.clone()),
            task_id: existing.task_id.clone(),
            kind: existing.kind.clone(),
            state: state.to_owned(),
            content: existing.content.clone(),
            provenance: edited_by_user(Some(&existing.provenance)),
            superseded_by: existing.superseded_by.clone(),
        })?;
        moved.push(check_memory(record, workspace, index.as_ref()));
    }
    Ok(moved)
}

/// Stores one memory a person wrote or corrected, and answers with it checked.
///
/// The re-embedding is attempted and its failure is swallowed, which is the opposite of what
/// `remember_completed_turn` does with the same call. The difference is what is at stake: there,
/// the embedding is the only reason the turn's memory was worth storing, and a caller that is not
/// told has no way to find out. Here the row is already saved, the user is watching, and the vector
/// is restored by the next maintenance run — so reporting it would refuse an edit that succeeded.
pub(crate) fn save_memory(
    storage: &ProjectStorage,
    edit: &MemoryEdit,
    workspace: Option<&Snapshot>,
) -> Result<CheckedMemory, CommandError> {
    let existing = match &edit.id {
        Some(id) => storage.memory().get(id)?,
        None => None,
    };
    let request = UpsertMemoryRequest {
        id: edit.id.clone(),
        task_id: existing.as_ref().and_then(|record| record.task_id.clone()),
        kind: edit.kind.clone(),
        state: edit.state.clone(),
        content: edit.content.clone(),
        provenance: edited_by_user(existing.as_ref().map(|record| &record.provenance)),
        superseded_by: existing.and_then(|record| record.superseded_by),
    };
    let record = storage.memory().upsert(&request)?;
    if let Err(error) = embed_memory(storage, &record.id, &record.content) {
        eprintln!("Re-embedding the edited memory failed, storage maintenance will retry: {error}");
    }
    let index = workspace.map(basename_index);
    Ok(check_memory(record, workspace, index.as_ref()))
}

/// The row's own provenance, with a note that a person has had their hands on it.
///
/// No timestamp: `updated_at` is set by the same write and already says when. What this adds is the
/// one thing the row would otherwise lose — that its text is no longer only what the turn deposited.
fn edited_by_user(existing: Option<&serde_json::Value>) -> serde_json::Value {
    let mut provenance = match existing {
        Some(serde_json::Value::Object(fields)) => fields.clone(),
        _ => serde_json::Map::new(),
    };
    provenance.insert("editedBy".to_owned(), serde_json::json!("user"));
    serde_json::Value::Object(provenance)
}

/// Checks one memory. Public to the crate so a save can answer with the same shape a list does.
pub(crate) fn check_memory(
    memory: MemoryRecord,
    workspace: Option<&Snapshot>,
    index: Option<&HashMap<&str, Vec<&str>>>,
) -> CheckedMemory {
    let named = anchors_in(&memory.content);
    let (Some(workspace), Some(index)) = (workspace, index) else {
        return CheckedMemory {
            judgement: judgement_of(&memory),
            memory,
            check: MemoryCheck::Unchecked,
            anchors: named
                .into_iter()
                .map(|named| MemoryAnchor {
                    named,
                    resolved: None,
                })
                .collect(),
        };
    };
    let anchors: Vec<MemoryAnchor> = named
        .into_iter()
        .map(|named| {
            let resolved = resolve_anchor(&named, workspace, index);
            MemoryAnchor { named, resolved }
        })
        .collect();
    let check = if anchors.is_empty() {
        MemoryCheck::Unanchored
    } else if anchors.iter().all(|anchor| anchor.resolved.is_some()) {
        MemoryCheck::Intact
    } else {
        MemoryCheck::Stale
    };
    CheckedMemory {
        judgement: judgement_of(&memory),
        memory,
        check,
        anchors,
    }
}

/// Every workspace path, grouped by the last segment of its name.
///
/// A memory writes `main.gd` as often as it writes `scripts/main.gd`, and scanning every path for
/// every anchor is what turns a 500-row list into a linear scan of the worktree five hundred times.
pub(crate) fn basename_index(workspace: &Snapshot) -> HashMap<&str, Vec<&str>> {
    let mut index: HashMap<&str, Vec<&str>> = HashMap::new();
    for path in workspace.keys() {
        let base = path.rsplit('/').next().unwrap_or(path);
        index.entry(base).or_default().push(path.as_str());
    }
    index
}

/// The workspace path an anchor names, if the workspace has one.
///
/// Exact first, then by last segment. The second pass is what a bare `main.gd` needs, and it is
/// held to the whole of what the memory wrote: `shaders/palette.gd` matching a `scripts/palette.gd`
/// would report a file as present under a path the memory never claimed.
fn resolve_anchor<'a>(
    named: &str,
    workspace: &'a Snapshot,
    index: &HashMap<&'a str, Vec<&'a str>>,
) -> Option<String> {
    if workspace.contains_key(named) {
        return Some(named.to_owned());
    }
    let base = named.rsplit('/').next().unwrap_or(named);
    let candidates = index.get(base)?;
    if !named.contains('/') {
        return candidates.first().map(|path| (*path).to_owned());
    }
    let suffix = format!("/{named}");
    candidates
        .iter()
        .find(|path| path.ends_with(&suffix))
        .map(|path| (*path).to_owned())
}

/// The paths a memory's text names, in the order it names them and without repeats.
fn anchors_in(content: &str) -> Vec<String> {
    let mut found: Vec<String> = Vec::new();
    for token in content.split(|character: char| !is_path_character(character)) {
        let Some(path) = anchor_path(token) else {
            continue;
        };
        if !found.contains(&path) {
            found.push(path);
        }
        if found.len() == MAX_ANCHORS {
            break;
        }
    }
    found
}

fn is_path_character(character: char) -> bool {
    character.is_ascii_alphanumeric() || matches!(character, '_' | '-' | '.' | '/' | ':')
}

/// One token read as a path, or nothing when it is only prose that looked like one.
fn anchor_path(token: &str) -> Option<String> {
    let path = match token.split_once("://") {
        Some(("res", rest)) => rest,
        Some(_) => return None,
        None => token,
    };
    let path = path
        .trim_end_matches(['.', ':', '/', '-'])
        .trim_start_matches("./")
        .trim_start_matches('/');
    let (stem, extension) = path.rsplit_once('.')?;
    if stem.is_empty() {
        return None;
    }
    let extension = extension.to_ascii_lowercase();
    if !ANCHOR_EXTENSIONS.contains(&extension.as_str()) {
        return None;
    }
    Some(path.to_owned())
}

#[cfg(test)]
mod tests {
    use super::{
        MemoryCheck, basename_index, check_memory, list_checked_memories, record_judgement,
        remember_completed_turn, retrieve_memory_context, save_memory, set_memory_states,
    };
    use crate::files::Snapshot;
    use crate::storage::{MemoryRecord, ProjectStorage, UpsertMemoryRequest};
    use std::fs;
    use tempfile::TempDir;

    fn storage(directory: &TempDir) -> ProjectStorage {
        let workspace = directory.path().join("workspace");
        fs::create_dir_all(&workspace).expect("workspace");
        ProjectStorage::open(&directory.path().join("data"), &workspace).expect("storage")
    }

    /// A real worktree holding `paths`, scanned the way the command scans one.
    fn worktree(directory: &TempDir, paths: &[&str]) -> Snapshot {
        let root = directory.path().join("worktree");
        for path in paths {
            let file = root.join(path);
            fs::create_dir_all(file.parent().expect("a parent")).expect("create directories");
            fs::write(&file, b"x").expect("write the file");
        }
        fs::create_dir_all(&root).expect("create the worktree");
        crate::files::scan(&root)
    }

    fn memory(content: &str) -> MemoryRecord {
        MemoryRecord {
            id: "01a0".to_owned(),
            task_id: None,
            kind: "summary".to_owned(),
            state: "confirmed".to_owned(),
            content: content.to_owned(),
            provenance: serde_json::json!({}),
            superseded_by: None,
            created_at: 1,
            updated_at: 1,
        }
    }

    fn checked(content: &str, workspace: &Snapshot) -> super::CheckedMemory {
        let index = basename_index(workspace);
        check_memory(memory(content), Some(workspace), Some(&index))
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

        assert!(
            storage
                .memory()
                .missing_embeddings(10)
                .expect("pending memories")
                .is_empty(),
            "nothing was stored, so maintenance has nothing to re-embed"
        );
    }

    /**
     * The check reports what it measured, which is where a file is, not whether a sentence is true.
     *
     * Both memories below are accurate. One describes a file that is there and one describes having
     * deleted a file, so the second names a path the workspace correctly no longer has. They are
     * told apart as `intact` and `stale` — and `stale` has to keep meaning "a file this names is
     * gone" rather than "this is wrong", because on this evidence there is no way to tell.
     */
    #[test]
    fn a_memory_is_checked_on_where_its_files_are_and_not_on_whether_it_is_right() {
        let directory = TempDir::new().expect("temporary directory");
        let workspace = worktree(&directory, &["scripts/placement.gd", "main.tscn"]);

        let intact = checked("Built the roster in `scripts/placement.gd`.", &workspace);
        assert_eq!(intact.check, MemoryCheck::Intact);

        let stale = checked("Deleted `GRAYZONE.md`, as asked.", &workspace);
        assert_eq!(stale.check, MemoryCheck::Stale);
        assert_eq!(stale.anchors.len(), 1);
        assert_eq!(stale.anchors[0].named, "GRAYZONE.md");
        assert_eq!(stale.anchors[0].resolved, None);
    }

    /**
     * Prose that looks like a path is not one, and the closed extension list is what says so.
     *
     * Measured against 87 real memories: a rule that took any dot followed by letters read `4.7.1`
     * and `e.g.` as filenames, and every memory carrying either would have been drawn to the user
     * as naming a file the project had lost.
     */
    #[test]
    fn a_version_number_and_an_abbreviation_are_not_files_that_went_missing() {
        let directory = TempDir::new().expect("temporary directory");
        let workspace = worktree(&directory, &["main.tscn"]);

        let prose = checked(
            "Godot 4.7.1 handles this, e.g. when the node is freed.",
            &workspace,
        );

        assert_eq!(prose.check, MemoryCheck::Unanchored);
        assert!(prose.anchors.is_empty(), "{:?}", prose.anchors);
    }

    /**
     * `res://` is the project root; every other scheme names something that is not in the worktree.
     *
     * `user://` is the player's save directory on the machine that ran the game, and checking the
     * worktree for it would report a file as lost that was never supposed to be there.
     */
    #[test]
    fn only_the_resource_scheme_names_a_file_the_workspace_can_be_asked_about() {
        let directory = TempDir::new().expect("temporary directory");
        let workspace = worktree(&directory, &["scenes/main.tscn"]);

        let resource = checked("Opened res://scenes/main.tscn.", &workspace);
        assert_eq!(resource.check, MemoryCheck::Intact);
        assert_eq!(resource.anchors[0].named, "scenes/main.tscn");

        let user = checked(
            "Settings are written to user://menu_settings.cfg.",
            &workspace,
        );
        assert_eq!(user.check, MemoryCheck::Unanchored);
    }

    /**
     * A bare filename is resolved by its last segment, and a rooted one is held to the whole path.
     *
     * Memories write both. `main.gd` has to find the file wherever it lives, or two thirds of the
     * anchors measured on a real project would read as missing. `shaders/palette.gd` must not be
     * satisfied by `scripts/palette.gd`: reporting that as present claims the memory was right
     * about a location it was wrong about.
     */
    #[test]
    fn a_bare_name_is_found_anywhere_and_a_rooted_one_is_held_to_its_directory() {
        let directory = TempDir::new().expect("temporary directory");
        let workspace = worktree(&directory, &["scripts/palette.gd"]);

        let bare = checked("Rewrote palette.gd.", &workspace);
        assert_eq!(bare.check, MemoryCheck::Intact);
        assert_eq!(
            bare.anchors[0].resolved.as_deref(),
            Some("scripts/palette.gd")
        );

        let elsewhere = checked("Rewrote shaders/palette.gd.", &workspace);
        assert_eq!(elsewhere.check, MemoryCheck::Stale);
    }

    /**
     * No worktree is not every file being gone.
     *
     * There is no active task before the first one is made, and `active_workspace` fails there.
     * Treating that as a failed lookup per path would draw the project's whole memory as broken at
     * the one moment the user has no way to act on it.
     */
    #[test]
    fn a_workspace_that_cannot_be_read_leaves_every_memory_unchecked() {
        let unchecked = check_memory(memory("Built `scripts/placement.gd`."), None, None);

        assert_eq!(unchecked.check, MemoryCheck::Unchecked);
        assert_eq!(unchecked.anchors.len(), 1, "the path is still named");
        assert_eq!(unchecked.anchors[0].resolved, None);
    }

    /**
     * The list shows what retrieval hides, which is the whole reason it is not a search.
     *
     * Memory search reads `state = 'confirmed'`. That is the lever the window offers — demoting a
     * row to `candidate` takes it away from the model without deleting it — so a list built on
     * search would make every demotion look like the row had been thrown away.
     */
    #[test]
    fn a_memory_taken_away_from_the_model_is_still_shown_to_the_person_who_took_it() {
        let directory = TempDir::new().expect("temporary directory");
        let storage = storage(&directory);
        for (state, content) in [
            ("confirmed", "a kept memory"),
            ("candidate", "a muted memory"),
        ] {
            storage
                .memory()
                .upsert(&UpsertMemoryRequest {
                    id: None,
                    task_id: None,
                    kind: "fact".to_owned(),
                    state: state.to_owned(),
                    content: content.to_owned(),
                    provenance: serde_json::json!({}),
                    superseded_by: None,
                })
                .expect("store the memory");
        }

        let listed = list_checked_memories(&storage, None).expect("list the memories");

        assert_eq!(listed.len(), 2);
        assert!(listed.iter().any(|entry| entry.memory.state == "candidate"));
    }

    /**
     * An edit changes the three fields the user is editing and nothing else about the row.
     *
     * The upsert overwrites `provenance`, `task_id` and `superseded_by` with whatever it is handed.
     * A window sending only the typed fields would blank all three — the memory would forget that a
     * finished turn deposited it and come loose from the task it came out of — and nothing would
     * report that, because the save would succeed.
     */
    #[test]
    fn editing_a_memory_keeps_everything_about_it_the_user_was_not_editing() {
        let directory = TempDir::new().expect("temporary directory");
        let storage = storage(&directory);
        remember_completed_turn(&storage, None, "add a pause menu", "added it").ok();
        let stored = list_checked_memories(&storage, None).expect("list")[0]
            .memory
            .clone();
        assert_eq!(stored.provenance["source"], "completed-ai-turn");

        let edited = save_memory(
            &storage,
            &super::MemoryEdit {
                id: Some(stored.id.clone()),
                kind: "decision".to_owned(),
                state: "candidate".to_owned(),
                content: "The pause menu is 1280x720.".to_owned(),
            },
            None,
        )
        .expect("save the edit");

        assert_eq!(edited.memory.kind, "decision");
        assert_eq!(edited.memory.state, "candidate");
        assert_eq!(edited.memory.content, "The pause menu is 1280x720.");
        assert_eq!(
            edited.memory.provenance["source"], "completed-ai-turn",
            "where the memory came from survives the edit"
        );
        assert_eq!(edited.memory.provenance["editedBy"], "user");
    }

    /**
     * A path that resolved to nothing is left out of the answer, not sent as `null`.
     *
     * The renderer counts the anchors with no `resolved` field. Serialized as `null` the field is
     * present, the count is zero, and every stale memory drew on screen as naming zero missing
     * files — with the warning dot beside it, because the verdict itself was right.
     */
    #[test]
    fn a_path_the_workspace_does_not_have_is_absent_from_the_answer_rather_than_null() {
        let directory = TempDir::new().expect("temporary directory");
        let workspace = worktree(&directory, &["main.tscn"]);

        let answer = serde_json::to_value(checked("Deleted `GRAYZONE.md`.", &workspace))
            .expect("serialize the checked memory");

        assert_eq!(answer["check"], "stale");
        assert_eq!(answer["anchors"][0]["named"], "GRAYZONE.md");
        assert!(
            answer["anchors"][0].get("resolved").is_none(),
            "{}",
            answer["anchors"][0]
        );
    }

    /**
     * A verdict is filed against the memory it was about, and it says so when that stops being true.
     *
     * It is the one thing here that is stored rather than recomputed, because it costs a model
     * request and a minute. That makes it the one thing that can outlive its subject: the user
     * reads `broken`, edits the memory, and the verdict now vouches for a sentence no model ever
     * saw. Keeping it is still right — the edit usually happens BECAUSE of it — so it is kept and
     * marked, by hashing the text it was made about.
     */
    #[test]
    fn a_verdict_stops_being_current_when_the_memory_it_judged_is_edited() {
        let directory = TempDir::new().expect("temporary directory");
        let storage = storage(&directory);
        remember_completed_turn(&storage, None, "delete GRAYZONE.md", "deleted it").ok();
        let stored = list_checked_memories(&storage, None).expect("list")[0]
            .memory
            .clone();

        record_judgement(&storage, &stored.id, "holds", "the file is gone", "qwen3")
            .expect("file the verdict");
        let judged = &list_checked_memories(&storage, None).expect("list")[0];
        let verdict = judged.judgement.as_ref().expect("a verdict");
        assert_eq!(verdict.verdict, "holds");
        assert_eq!(verdict.reason, "the file is gone");
        assert_eq!(verdict.model, "qwen3");
        assert!(verdict.is_current);

        save_memory(
            &storage,
            &super::MemoryEdit {
                id: Some(stored.id.clone()),
                kind: stored.kind.clone(),
                state: stored.state.clone(),
                content: "GRAYZONE.md was deleted, and so was VALIDATION-1-7.md.".to_owned(),
            },
            None,
        )
        .expect("edit the memory");

        let edited = &list_checked_memories(&storage, None).expect("list")[0];
        let kept = edited
            .judgement
            .as_ref()
            .expect("the verdict survives the edit");
        assert_eq!(kept.verdict, "holds");
        assert!(
            !kept.is_current,
            "the verdict is about text the memory no longer holds"
        );
    }

    /// Judging a memory that was deleted between the click and the spawn is refused, not invented.
    #[test]
    fn a_verdict_for_a_memory_that_is_gone_is_refused() {
        let directory = TempDir::new().expect("temporary directory");
        let storage = storage(&directory);

        let failure = record_judgement(&storage, "01a0", "holds", "nothing", "qwen3")
            .expect_err("there is no such memory");

        assert_eq!(failure.code, "memory_not_found");
    }

    /// Deleting is final, and deleting one that is not there says so rather than passing quietly.
    #[test]
    fn a_deleted_memory_is_gone_and_a_missing_one_is_reported() {
        let directory = TempDir::new().expect("temporary directory");
        let storage = storage(&directory);
        let stored = storage
            .memory()
            .upsert(&UpsertMemoryRequest {
                id: None,
                task_id: None,
                kind: "fact".to_owned(),
                state: "confirmed".to_owned(),
                content: "a memory to forget".to_owned(),
                provenance: serde_json::json!({}),
                superseded_by: None,
            })
            .expect("store the memory");

        storage.memory().delete(&stored.id).expect("delete it");

        assert!(
            list_checked_memories(&storage, None)
                .expect("list the memories")
                .is_empty()
        );
        assert_eq!(
            storage.memory().delete(&stored.id).unwrap_err().code,
            "memory_not_found"
        );
    }

    #[test]
    fn holding_memories_back_keeps_their_words_and_their_verdict() {
        let directory = TempDir::new().expect("temporary directory");
        let storage = storage(&directory);
        let stored = storage
            .memory()
            .upsert(&UpsertMemoryRequest {
                id: None,
                task_id: None,
                kind: "summary".to_owned(),
                state: "confirmed".to_owned(),
                content: "Built the pause menu in scripts/pause.gd.".to_owned(),
                provenance: serde_json::json!({"source": "completed-ai-turn"}),
                superseded_by: None,
            })
            .expect("store a memory");
        record_judgement(
            &storage,
            &stored.id,
            "broken",
            "it is a settings screen now",
            "qwen3",
        )
        .expect("file a verdict");

        let moved = set_memory_states(
            &storage,
            std::slice::from_ref(&stored.id),
            "candidate",
            None,
        )
        .expect("hold it back");

        assert_eq!(moved.len(), 1);
        let held = &moved[0];
        assert_eq!(held.memory.state, "candidate");
        assert_eq!(
            held.memory.content,
            "Built the pause menu in scripts/pause.gd."
        );
        let verdict = held.judgement.as_ref().expect("the verdict survived");
        assert_eq!(verdict.reason, "it is a settings screen now");
        assert_eq!(
            held.memory.provenance.get("source"),
            Some(&serde_json::json!("completed-ai-turn"))
        );
    }

    #[test]
    fn holding_back_skips_a_memory_that_is_no_longer_stored() {
        let directory = TempDir::new().expect("temporary directory");
        let storage = storage(&directory);
        let stored = storage
            .memory()
            .upsert(&UpsertMemoryRequest {
                id: None,
                task_id: None,
                kind: "summary".to_owned(),
                state: "confirmed".to_owned(),
                content: "Added an audio autoload.".to_owned(),
                provenance: serde_json::json!({}),
                superseded_by: None,
            })
            .expect("store a memory");

        let moved = set_memory_states(
            &storage,
            &["gone".to_owned(), stored.id.clone()],
            "candidate",
            None,
        )
        .expect("hold back what is there");

        assert_eq!(moved.len(), 1);
        assert_eq!(moved[0].memory.id, stored.id);
    }
}

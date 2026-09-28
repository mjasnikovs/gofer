//! The hash the agent's last read of a file answered with, remembered so the agent never carries it.
//!
//! `expectedHash` was built for Monaco. A buffer open in the UI can go stale while the Godot editor
//! or the worktree watcher rewrites the file underneath, and a whole-buffer save has no anchor text
//! to match on, so it needs a token. The AI router inherited the parameter by calling the same
//! `Workspace::write`, and nobody decided that a model should copy sixty-four hex characters by
//! hand — it came with the door.
//!
//! A model duly copied sixty-three of them. The write was refused as `changed since it was read`,
//! which was false; it re-read, copied the hash wrong the same way, was refused again, and after
//! three rounds abandoned the domain and wrote the file with the raw `write` tool — around the
//! language server the domain exists to keep in the loop.
//!
//! So the router keeps the token instead. Every read it forwards records the hash beside the path;
//! every save and delete that names no hash is filled in from that record. The guarantee is
//! unchanged, because the value used is exactly the one the agent's own last read answered with: a
//! file that really did change since then still conflicts, and now truthfully.
//!
//! Nothing here is a cache of file contents. It is a record of what this agent has been told, keyed
//! by worktree so two tasks never answer for each other, and it is allowed to be wrong in only one
//! direction — a missing entry means "pass nothing", which is what an unread file already meant.
//!
//! The edited scene's revision is kept the same way, for the same reason and with one difference:
//! it belongs to the worktree rather than to a path, because the editor edits one scene at a time.
//! `expectedRevision` cost a measured turn 28,067 of its 328,533 tokens — one refusal, then a
//! second `scene.get_tree` whose answer was byte-identical to the first, asked only to read a
//! number back out of it.
//!
//! Recording it is safe because the addon moves that number in exactly three places, and all three
//! are Gofer commands: `_advance_revision` for a mutation and for an undo or redo, and the two
//! assignments that restart it at zero when a different scene is opened. A person editing the scene
//! in the editor does not move it. So `expectedRevision` never guarded against the user, and the
//! record cannot fall behind a change the router did not see. What it still guards is the original
//! case: an answer the agent never received — a timeout, a killed turn — leaves the record behind
//! the editor, and the next mutation is refused rather than applied to a scene that moved on.
//!
//! The router asks three things of it: [`note_a_read`] for a file the worker showed, [`through`]
//! around every file-touching call, and [`through_the_editor`] around every addon call. Every rule
//! about filling, recording and forgetting lives behind those.

use crate::ai_tools::ToolFailure;
use crate::files::{FileError, Workspace};
use crate::godot_rpc::RpcError;
use crate::godot_session_api::{CallGodotRequest, CallGodotResponse};
use crate::tool_params::{self, Operation};
use crate::tool_paths::{declares_a_path, paths_named};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

/// The host call the worker's `read` tool makes after showing the model a whole file.
pub const NOTED_READ_TOOL: &str = "noted_read";

/// Arms a save over a file the worker's own `read` tool showed the model; answers whether it did.
///
/// A `read` runs in the worker, out of the router's sight: 94 of 195 live runs read a script that
/// way, and every `file_conflict` a save ever met was over a file shown exactly so. The hash is
/// taken from the disk: the read answered these bytes a moment ago, and a file that changes in
/// between is a conflict the save should meet.
pub(crate) fn note_a_read(workspace: &Workspace, path: &str) -> Result<bool, FileError> {
    let path = path.strip_prefix("res://").unwrap_or(path);
    if workspace.resolve(path)?.is_dir() {
        return Ok(false);
    }
    let hash = workspace.hash_of(path)?;
    if let Some(hash) = &hash {
        remember(workspace.root(), path, hash);
    }
    Ok(hash.is_some())
}

/// Runs one file-touching call: fills `expectedHash` on the way in, records and strips what the
/// answer says on the way out, and drops a record the refusal says outlived its file.
///
/// Which calls it covers is the operation's own row: one that declares a path touches a file, and
/// one that declares a [`tool_params::Kind::Hash`] parameter is one the ledger fills. `root` is
/// asked only for those; with none, the answer is still stripped and nothing is recorded.
pub(crate) fn through(
    operation: &Operation,
    root: impl FnOnce() -> Option<PathBuf>,
    params: Value,
    run: impl FnOnce(Value) -> Result<Value, ToolFailure>,
) -> Result<Value, ToolFailure> {
    if !touches_a_file(operation.params) {
        return run(params);
    }
    let root = root();
    let params = match &root {
        Some(root) if fills_a_hash(operation) => with_remembered_hash(root, params),
        _ => params,
    };
    let named = paths_named(operation, &params);
    match run(params) {
        Ok(answer) => Ok(reconcile(root.as_deref(), answer)),
        Err(failure) => {
            if let Some(root) = &root {
                for path in &named {
                    forget_a_vanished_file(root, path, &failure);
                }
            }
            Err(failure)
        }
    }
}

/// Sends one addon call under the scene-revision guard, through `send`, the editor's port.
///
/// A call that names no revision is given the one the last answer reported, with the scene it
/// counted. A caller that named its own is left alone: the renderer holds a view the router has no
/// business overruling. The answer's revision is merged into its body and recorded.
pub(crate) fn through_the_editor(
    root: Option<&Path>,
    request: CallGodotRequest,
    mut send: impl FnMut(CallGodotRequest) -> Result<CallGodotResponse, RpcError>,
) -> Result<Value, RpcError> {
    let request = match (request.expected_revision, root.and_then(recall_revision)) {
        (None, Some(held)) => CallGodotRequest {
            expected_revision: Some(held.revision),
            expected_scene: Some(held.scene),
            ..request
        },
        _ => request,
    };
    let supplied = request.expected_revision;
    let response = match send(request.clone()) {
        Ok(answered) => answered,
        Err(refusal) => {
            let revision =
                the_revision_a_first_mutation_was_refused_for(&refusal, supplied).ok_or(refusal)?;
            send(CallGodotRequest {
                expected_revision: Some(revision),
                ..request
            })?
        }
    };
    let mut result = response.result;
    if let (Some(revision), Some(object)) = (response.revision, result.as_object_mut()) {
        object.insert("revision".to_owned(), json!(revision));
    }
    if let Some(root) = root {
        record_revision(root, &result);
    }
    Ok(result)
}

/// Drops the remembered revision alone. A fresh editor counts from zero, so a revision remembered
/// from the editor before it is a claim about a scene that no longer exists: the first mutation
/// after a restart was refused as `revision_conflict`, "13 expected, at 0", for a number the caller
/// never sent. The file hashes stay; the files did not change because the editor did.
pub fn forget_revision(root: &Path) {
    if let Ok(mut held) = revisions().lock() {
        held.remove(root);
    }
}

/// Drops a whole worktree, so a task that ends does not answer for the one that reuses its paths.
pub fn forget_worktree(root: &Path) {
    if let Ok(mut held) = ledger().lock() {
        held.retain(|(held_root, _), _| held_root != root);
    }
    if let Ok(mut held) = revisions().lock() {
        held.remove(root);
    }
}

/// The hash this agent was last given for a file, if it has ever been told.
pub(crate) fn recall(root: &Path, path: &str) -> Option<String> {
    ledger()
        .lock()
        .ok()?
        .get(&(root.to_owned(), path.to_owned()))
        .cloned()
}

/// Every path this agent has read, and the hash it was given for it.
fn ledger() -> &'static Mutex<HashMap<(PathBuf, String), String>> {
    static LEDGER: OnceLock<Mutex<HashMap<(PathBuf, String), String>>> = OnceLock::new();
    LEDGER.get_or_init(|| Mutex::new(HashMap::new()))
}

fn remember(root: &Path, path: &str, hash: &str) {
    if hash.is_empty() {
        return;
    }
    if let Ok(mut held) = ledger().lock() {
        held.insert((root.to_owned(), path.to_owned()), hash.to_owned());
    }
}

fn forget(root: &Path, path: &str) {
    if let Ok(mut held) = ledger().lock() {
        held.remove(&(root.to_owned(), path.to_owned()));
    }
}

/// Read off the parameters rather than listed: `under` counts, because a listing is the read that
/// fills the ledger for every file it reports.
fn touches_a_file(params: &[tool_params::Param]) -> bool {
    params
        .iter()
        .any(|param| declares_a_path(param) || touches_a_file(param.entry))
}

fn fills_a_hash(operation: &Operation) -> bool {
    operation
        .params
        .iter()
        .any(|param| param.kind == tool_params::Kind::Hash)
}

/// A hash the caller passed itself is left alone, and so is a path with no record — which is what
/// an unread file already meant: `Workspace::write` reads that as "creating this file".
fn with_remembered_hash(root: &Path, params: Value) -> Value {
    let mut params = params;
    let Some(object) = params.as_object_mut() else {
        return params;
    };
    if object.contains_key("expectedHash") {
        return params;
    }
    let hash = object
        .get("path")
        .and_then(Value::as_str)
        .and_then(|path| recall(root, path));
    if let Some(hash) = hash {
        object.insert("expectedHash".to_owned(), json!(hash));
    }
    params
}

/// Drops a record when a refusal reports its file as gone.
///
/// The caller can neither see the hash nor clear it, because `expectedHash` is hidden from the
/// tool; left in place, the next save carries the same dead record and is refused identically.
fn forget_a_vanished_file(root: &Path, path: &str, failure: &ToolFailure) {
    if failure.code == "file_conflict" && failure.details["actualHash"].is_null() {
        forget(root, path);
    }
}

/// Records every path/hash pair in an answer, and takes the bookkeeping back out of it.
///
/// Every operation that touches a file answers with one stamp, or a `files` list of them, so this
/// is the whole of "the ledger is up to date and the model never sees a hash". `apply_rename` once
/// left the ledger holding hashes for files it had just rewritten, and the next save over a renamed
/// file was refused `file_conflict` with no call the model could make to escape.
///
/// `version` goes too: it is the language server's document counter, which no operation accepts.
/// A stamp says what a file now holds; an answer can also say a file is gone or has moved, and
/// both are read here for the same reason.
fn reconcile(root: Option<&Path>, answer: Value) -> Value {
    let mut answer = answer;
    if let Value::Array(entries) = &mut answer {
        for entry in entries.iter_mut() {
            what_became_of_the_file(root, entry);
            reconcile_in_place(root, entry);
        }
    } else {
        what_became_of_the_file(root, &answer);
        reconcile_in_place(root, &mut answer);
    }
    answer
}

/// Takes a deleted file's record out, and carries a moved file's record with it.
///
/// Read off the answer, keyed on the path the answer names rather than the string the caller
/// wrote: `res://levels/level.tscn` once reached neither record. The content did not change when a
/// file moved, only where it lives, so the record follows it.
fn what_became_of_the_file(root: Option<&Path>, answer: &Value) {
    let (Some(root), Some(fields)) = (root, answer.as_object()) else {
        return;
    };
    if fields.get("deleted").and_then(Value::as_bool) == Some(true)
        && let Some(path) = fields.get("path").and_then(Value::as_str)
    {
        forget(root, path);
    }
    if fields.get("moved").and_then(Value::as_bool) == Some(true)
        && let Some((from, to)) = fields
            .get("from")
            .and_then(Value::as_str)
            .zip(fields.get("to").and_then(Value::as_str))
    {
        if let Some(hash) = recall(root, from) {
            remember(root, to, &hash);
        }
        forget(root, from);
    }
}

/// One stamp, or the `files` list an operation answers with. Nothing deeper: a recursive walk
/// would strip `hash` out of a diagnostic or a search hit that happens to carry one.
fn reconcile_in_place(root: Option<&Path>, entry: &mut Value) {
    let Some(fields) = entry.as_object_mut() else {
        return;
    };
    if let Some(files) = fields.get_mut("files").and_then(Value::as_array_mut) {
        for file in files.iter_mut() {
            reconcile_in_place(root, file);
        }
        return;
    }
    let stamp = fields
        .get("path")
        .and_then(Value::as_str)
        .zip(fields.get("hash").and_then(Value::as_str));
    if let (Some(root), Some((path, hash))) = (root, stamp) {
        remember(root, path, hash);
    }
    fields.remove("hash");
    fields.remove("version");
}

/// Which scene a remembered revision counts, and what it was last reported to be at.
///
/// The pair is the point. The addon resets its counter to zero every time the edited scene
/// changes, so a remembered bare zero for one scene matched a freshly opened *different* scene
/// exactly, and the agent's next mutation landed in the scene the user had just opened.
#[derive(Clone, Debug, PartialEq)]
struct SceneRevision {
    scene: String,
    revision: u64,
}

/// The scene and revision each worktree's editor was last reported at.
fn revisions() -> &'static Mutex<HashMap<PathBuf, SceneRevision>> {
    static REVISIONS: OnceLock<Mutex<HashMap<PathBuf, SceneRevision>>> = OnceLock::new();
    REVISIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn recall_revision(root: &Path) -> Option<SceneRevision> {
    revisions().lock().ok()?.get(root).cloned()
}

/// Records the revision an answer carries. A mutation reports it on the envelope and names no
/// scene, which keeps the scene already remembered rather than meaning there is none.
fn record_revision(root: &Path, answer: &Value) {
    let Some(revision) = answer.get("revision").and_then(Value::as_u64) else {
        return;
    };
    let named = answer
        .get("scene")
        .and_then(Value::as_str)
        .filter(|scene| !scene.is_empty());
    if let Ok(mut held) = revisions().lock() {
        let scene = named
            .map(str::to_owned)
            .or_else(|| held.get(root).map(|held| held.scene.clone()))
            .unwrap_or_default();
        held.insert(root.to_owned(), SceneRevision { scene, revision });
    }
}

/// The revision to retry at, when nothing was supplied and the addon refused for it.
///
/// The first call of a session follows no read, so nothing is supplied and the addon refuses; the
/// catalog tells the model never to read the tree for that number. A revision that *was* supplied
/// is a read this turn really made, and a conflict against it is the concurrent edit the guard
/// exists to catch — retrying that would overwrite whatever moved the scene on.
fn the_revision_a_first_mutation_was_refused_for(
    refusal: &RpcError,
    supplied: Option<u64>,
) -> Option<u64> {
    if supplied.is_some() || refusal.code != "revision_conflict" {
        return None;
    }
    refusal
        .details
        .get("currentRevision")
        .and_then(Value::as_u64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn operation(domain: &str, op: &str) -> &'static Operation {
        tool_params::operation_of(domain, op).expect("a catalogue operation")
    }

    /// A worktree of its own, so no other test's records can answer for it.
    fn worktree() -> TempDir {
        TempDir::new().expect("a temporary worktree")
    }

    /// Runs a listing that answers `answer`, the way any file-touching arm answers.
    fn answered(root: &Path, answer: Value) -> Value {
        through(
            operation("godot_resource", "list"),
            || Some(root.to_owned()),
            json!({}),
            |_| Ok(answer),
        )
        .expect("a listing that answers")
    }

    /// The `expectedHash` a delete naming these parameters is sent with.
    fn hash_a_delete_is_sent(root: &Path, params: Value) -> Option<Value> {
        let mut sent = None;
        through(
            operation("godot_resource", "delete"),
            || Some(root.to_owned()),
            params,
            |params| {
                sent = params.get("expectedHash").cloned();
                Ok(json!({}))
            },
        )
        .expect("a delete that answers");
        sent
    }

    fn told(root: &Path, path: &str) -> Option<Value> {
        hash_a_delete_is_sent(root, json!({"path": path}))
    }

    #[test]
    fn a_save_is_held_to_the_hash_its_file_was_last_answered_with() {
        let tree = worktree();
        assert_eq!(
            told(tree.path(), "a.gd"),
            None,
            "an unread file is held to nothing"
        );
        answered(tree.path(), json!({"path": "a.gd", "hash": "aaaa"}));
        assert_eq!(told(tree.path(), "a.gd"), Some(json!("aaaa")));
        answered(tree.path(), json!({"path": "a.gd", "hash": "bbbb"}));
        assert_eq!(told(tree.path(), "a.gd"), Some(json!("bbbb")));
    }

    /// The renderer holds its own buffer and token, and the ledger does not overrule it.
    #[test]
    fn a_hash_the_caller_passed_is_left_alone() {
        let tree = worktree();
        answered(tree.path(), json!({"path": "a.gd", "hash": "aaaa"}));
        assert_eq!(
            hash_a_delete_is_sent(tree.path(), json!({"path": "a.gd", "expectedHash": "mine"})),
            Some(json!("mine"))
        );
    }

    /// Two worktrees hold the same relative paths, and one must never answer for the other.
    #[test]
    fn two_worktrees_keep_their_own_records() {
        let (one, two) = (worktree(), worktree());
        answered(one.path(), json!({"path": "player.gd", "hash": "1111"}));
        answered(two.path(), json!({"path": "player.gd", "hash": "2222"}));
        assert_eq!(told(one.path(), "player.gd"), Some(json!("1111")));
        assert_eq!(told(two.path(), "player.gd"), Some(json!("2222")));
        forget_worktree(one.path());
        assert_eq!(told(one.path(), "player.gd"), None);
        assert_eq!(told(two.path(), "player.gd"), Some(json!("2222")));
    }

    /// A workspace that cannot be read is no reason to hand the model a hash.
    #[test]
    fn without_a_worktree_the_answer_is_still_stripped() {
        let answer = through(
            operation("godot_resource", "list"),
            || None,
            json!({}),
            |_| Ok(json!({"path": "a.gd", "hash": "aaaa", "version": 2})),
        )
        .expect("a listing that answers");
        assert_eq!(answer, json!({"path": "a.gd"}));
    }

    #[test]
    fn an_operation_that_names_no_file_is_left_alone() {
        let answer = through(
            operation("godot_session", "status"),
            || unreachable!("no file is named, so no worktree is asked for"),
            json!({}),
            |_| Ok(json!({"hash": "not a file's"})),
        )
        .expect("an answer");
        assert_eq!(answer, json!({"hash": "not a file's"}));
    }

    #[test]
    fn reconciling_records_every_stamp_and_hands_back_none_of_them() {
        let tree = worktree();
        let answer = answered(
            tree.path(),
            json!({"path": "player.gd", "hash": "aaaa", "version": 3, "bytes": 12}),
        );

        assert_eq!(told(tree.path(), "player.gd"), Some(json!("aaaa")));
        assert_eq!(answer, json!({"path": "player.gd", "bytes": 12}));
    }

    #[test]
    fn a_verdict_that_carries_no_hash_still_loses_its_document_counter() {
        let tree = worktree();
        let answer = answered(
            tree.path(),
            json!({
                "path": "player.gd",
                "version": 7,
                "published": true,
                "diagnostics": [{"line": 3, "message": "Parse Error"}]
            }),
        );

        assert_eq!(answer["path"], "player.gd");
        assert_eq!(answer["published"], true);
        assert_eq!(answer["diagnostics"][0]["message"], "Parse Error");
        assert!(answer.get("version").is_none(), "{answer}");
    }

    /// One rule over a stamp and a `files` list, so a batched arm cannot leak what a single one
    /// does not.
    #[test]
    fn reconciling_reaches_every_file_in_a_batch() {
        let tree = worktree();
        let answer = answered(
            tree.path(),
            json!({"files": [
                {"path": "a.gd", "hash": "1111", "version": 1},
                {"path": "b.gd", "hash": "2222", "version": 2}
            ]}),
        );

        assert_eq!(told(tree.path(), "a.gd"), Some(json!("1111")));
        assert_eq!(told(tree.path(), "b.gd"), Some(json!("2222")));
        assert!(
            !answer.to_string().contains("hash"),
            "no answer the model reads may carry one: {answer}"
        );
    }

    /// A `list` with hashing off answers `null`, which is not a record and not a field either.
    #[test]
    fn reconciling_an_answer_with_no_hash_records_nothing() {
        let tree = worktree();
        let answer = answered(
            tree.path(),
            json!({"files": [{"path": "art.png", "bytes": 40, "hash": null}]}),
        );

        assert_eq!(told(tree.path(), "art.png"), None);
        assert_eq!(answer, json!({"files": [{"path": "art.png", "bytes": 40}]}));
    }

    /// A file whose text was withheld leaves the ledger alone, so a later write is refused.
    ///
    /// `godot_script open` stops carrying text once a batched call has spent its budget. Recording
    /// its hash would let the next `save` replace a whole file out of text nobody was shown.
    #[test]
    fn a_file_answered_without_its_text_is_not_recorded_as_read() {
        let tree = worktree();
        answered(
            tree.path(),
            json!({"path": "kept.gd", "hash": "an-older-hash"}),
        );

        let answer = answered(
            tree.path(),
            json!({"files": [
                {"path": "kept.gd", "bytes": 12, "hash": "shown"},
                {"path": "withheld.gd", "bytes": 900, "version": 3, "omitted": "no room left"},
            ]}),
        );

        assert_eq!(told(tree.path(), "kept.gd"), Some(json!("shown")));
        assert_eq!(told(tree.path(), "withheld.gd"), None);
        assert_eq!(answer["files"][1]["omitted"], "no room left");
    }

    #[test]
    fn reconciling_reaches_every_entry_of_a_list_shaped_answer() {
        let tree = worktree();
        let answer = answered(
            tree.path(),
            json!([
                {"path": "one.gd", "hash": "1111", "version": 1},
                {"path": "two.gd", "hash": "2222"}
            ]),
        );

        assert_eq!(told(tree.path(), "one.gd"), Some(json!("1111")));
        assert_eq!(told(tree.path(), "two.gd"), Some(json!("2222")));
        assert!(!answer.to_string().contains("hash"), "{answer}");
    }

    /// A recursive strip would take `hash` out of a search hit that carries one.
    #[test]
    fn an_answer_that_is_not_a_stamp_is_handed_back_as_it_is() {
        let tree = worktree();
        assert_eq!(answered(tree.path(), json!("ok")), json!("ok"));
        assert_eq!(answered(tree.path(), json!([1, 2])), json!([1, 2]));
    }

    /// Keeping a deleted file's record would refuse the save that recreates it — the one case
    /// where naming no hash is the point.
    #[test]
    fn a_deleted_file_loses_its_record_without_the_arm_saying_so() {
        let tree = worktree();
        answered(
            tree.path(),
            json!({"path": "levels/level.tscn", "hash": "aaaa"}),
        );
        let answer = answered(
            tree.path(),
            json!({"path": "levels/level.tscn", "deleted": true}),
        );
        assert_eq!(told(tree.path(), "levels/level.tscn"), None);
        assert_eq!(answer["deleted"], true);
    }

    #[test]
    fn a_moved_file_carries_its_record_to_where_it_went() {
        let tree = worktree();
        answered(
            tree.path(),
            json!({"path": "levels/level.tscn", "hash": "bbbb"}),
        );
        let answer = answered(
            tree.path(),
            json!({"from": "levels/level.tscn", "to": "levels/one.tscn", "moved": true}),
        );
        assert_eq!(told(tree.path(), "levels/level.tscn"), None);
        assert_eq!(told(tree.path(), "levels/one.tscn"), Some(json!("bbbb")));
        assert_eq!(answer["moved"], true);
    }

    #[test]
    fn moving_an_unread_file_records_nothing_at_the_destination() {
        let tree = worktree();
        answered(
            tree.path(),
            json!({"from": "art/a.png", "to": "art/b.png", "moved": true}),
        );
        assert_eq!(told(tree.path(), "art/b.png"), None);
    }

    #[test]
    fn an_empty_hash_is_not_a_record() {
        let tree = worktree();
        answered(tree.path(), json!({"path": "b.gd", "hash": ""}));
        assert_eq!(told(tree.path(), "b.gd"), None);
    }

    /// A record that outlives its file must not refuse every save of that path forever.
    ///
    /// The file goes away outside the router — the editor deletes it, a checkout reverts it — and
    /// the refusal tells the agent to save again. Without this the next save carries the same dead
    /// record and is refused the same way, over a parameter the agent cannot see.
    #[test]
    fn a_record_that_outlived_its_file_is_dropped_so_the_next_save_creates_it() {
        let tree = worktree();
        let workspace = Workspace::open(tree.path()).expect("a workspace");
        let save = |text: &str| {
            through(
                operation("godot_script", "save"),
                || Some(workspace.root().to_owned()),
                json!({"path": "hud.gd", "text": text}),
                |params| {
                    let expected = params.get("expectedHash").and_then(Value::as_str);
                    let stamp = workspace
                        .write("hud.gd", text, expected)
                        .map_err(ToolFailure::from)?;
                    Ok(json!({"path": stamp.path, "hash": stamp.hash}))
                },
            )
        };
        save("extends Node\n").expect("the first save creates the file");

        std::fs::write(tree.path().join("hud.gd"), "extends Node2D\n").expect("someone edits it");
        let changed = save("extends Control\n").expect_err("a file that changed is refused");
        assert_eq!(changed.code, "file_conflict");
        assert!(
            save("extends Control\n").is_err(),
            "a file that merely changed keeps its record"
        );

        std::fs::remove_file(tree.path().join("hud.gd")).expect("the file goes away outside us");
        let gone = save("extends Control\n").expect_err("there is nothing there to match");
        assert!(
            gone.message.contains("Save it again to create the file"),
            "the refusal has to name the call that works: {}",
            gone.message
        );
        save("extends Control\n").expect("saving again creates the file");
    }

    #[test]
    fn a_read_the_worker_made_arms_the_save_over_what_it_showed() {
        let tree = worktree();
        let workspace = Workspace::open(tree.path()).expect("a workspace");
        let stamp = workspace
            .write("scripts/player.gd", "extends Node2D\n", None)
            .expect("write the script");
        forget_worktree(workspace.root());

        assert!(note_a_read(&workspace, "res://scripts/player.gd").expect("note the read"));
        assert_eq!(
            told(tree.path(), "scripts/player.gd"),
            Some(json!(stamp.hash)),
            "the record is keyed the way a save names the file, scheme off"
        );
        assert!(!note_a_read(&workspace, "scripts").expect("a directory is not a file shown"));
        assert_eq!(told(tree.path(), "scripts"), None);
    }

    /// What the editor was sent, in order.
    type Sent = std::rc::Rc<std::cell::RefCell<Vec<CallGodotRequest>>>;

    /// An editor that answers each call with the next of `answers`, and keeps what it was sent.
    fn editor(
        answers: Vec<Result<CallGodotResponse, RpcError>>,
    ) -> (
        Sent,
        impl FnMut(CallGodotRequest) -> Result<CallGodotResponse, RpcError>,
    ) {
        let sent = std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
        let mut answers = answers.into_iter();
        let seen = std::rc::Rc::clone(&sent);
        (sent, move |request| {
            seen.borrow_mut().push(request);
            answers.next().expect("the editor was asked once too often")
        })
    }

    fn at(revision: Option<u64>, result: Value) -> Result<CallGodotResponse, RpcError> {
        Ok(CallGodotResponse {
            id: "1".to_owned(),
            result,
            revision,
        })
    }

    fn conflict(current: u64) -> Result<CallGodotResponse, RpcError> {
        Err(RpcError {
            details: json!({"currentRevision": current}),
            ..RpcError::new("revision_conflict", "The scene moved on")
        })
    }

    fn call(expected_revision: Option<u64>) -> CallGodotRequest {
        CallGodotRequest {
            command: "scene.add_node".to_owned(),
            params: json!({}),
            expected_revision,
            expected_scene: None,
            timeout_ms: None,
        }
    }

    /// What the next call naming no revision is sent with.
    fn expected_next(root: &Path) -> (Option<u64>, Option<String>) {
        let (sent, send) = editor(vec![at(None, json!({}))]);
        through_the_editor(Some(root), call(None), send).expect("an answer");
        let request = sent.borrow()[0].clone();
        (request.expected_revision, request.expected_scene)
    }

    #[test]
    fn a_call_naming_no_revision_is_sent_the_one_the_last_answer_reported() {
        let tree = worktree();
        let (_, send) = editor(vec![at(
            None,
            json!({"scene": "res://a.tscn", "revision": 3}),
        )]);
        through_the_editor(Some(tree.path()), call(None), send).expect("a read");
        assert_eq!(
            expected_next(tree.path()),
            (Some(3), Some("res://a.tscn".to_owned()))
        );

        let (sent, send) = editor(vec![at(Some(4), json!({}))]);
        let answer = through_the_editor(Some(tree.path()), call(Some(9)), send)
            .expect("a mutation at the caller's own revision");
        assert_eq!(sent.borrow()[0].expected_revision, Some(9));
        assert_eq!(sent.borrow()[0].expected_scene, None);
        assert_eq!(
            answer["revision"], 4,
            "the envelope's revision is the model's to read"
        );
        assert_eq!(
            expected_next(tree.path()),
            (Some(4), Some("res://a.tscn".to_owned())),
            "a mutation names no scene, which keeps the one remembered"
        );
    }

    /// Zero is the revision a freshly opened scene is at, so it has to survive being recorded, and a
    /// revision has to say which scene it counts: a bare zero for `a.tscn` matched a freshly opened
    /// `b.tscn` exactly, and the mutation landed in the scene the user had just opened.
    #[test]
    fn a_revision_carries_the_scene_it_counts_from_zero() {
        let tree = worktree();
        for (scene, revision) in [("res://a.tscn", 0), ("res://b.tscn", 0)] {
            let (_, send) = editor(vec![at(
                None,
                json!({"scene": scene, "revision": revision}),
            )]);
            through_the_editor(Some(tree.path()), call(None), send).expect("a read");
            assert_eq!(
                expected_next(tree.path()),
                (Some(revision), Some(scene.to_owned()))
            );
        }
    }

    /// The first mutation of a session follows no read, so it is retried at the revision the
    /// refusal names rather than sending the model to read the tree for a number.
    #[test]
    fn the_first_mutation_of_a_session_is_retried_at_the_revision_it_was_refused_for() {
        let tree = worktree();
        let (sent, send) = editor(vec![conflict(5), at(Some(6), json!({}))]);
        let answer = through_the_editor(Some(tree.path()), call(None), send).expect("the retry");
        let asked: Vec<Option<u64>> = sent.borrow().iter().map(|r| r.expected_revision).collect();
        assert_eq!(asked, [None, Some(5)]);
        assert_eq!(answer["revision"], 6);
    }

    /// A revision a read or a caller supplied is the guard doing its job, and is never retried.
    #[test]
    fn a_conflict_against_a_supplied_revision_is_not_retried() {
        let tree = worktree();
        let (sent, send) = editor(vec![conflict(5)]);
        let refused = through_the_editor(Some(tree.path()), call(Some(2)), send)
            .expect_err("the caller's own revision conflicts");
        assert_eq!(refused.code, "revision_conflict");
        assert_eq!(sent.borrow().len(), 1);

        let (_, send) = editor(vec![at(
            None,
            json!({"scene": "res://a.tscn", "revision": 1}),
        )]);
        through_the_editor(Some(tree.path()), call(None), send).expect("a read");
        let (sent, send) = editor(vec![conflict(5)]);
        through_the_editor(Some(tree.path()), call(None), send)
            .expect_err("the remembered revision conflicts");
        assert_eq!(sent.borrow().len(), 1);
    }

    /// A fresh editor counts from zero, so a session start forgets the revision; the files did not
    /// change because the editor did, so the hashes stay.
    #[test]
    fn a_session_start_forgets_the_revision_and_keeps_the_hashes() {
        let tree = worktree();
        answered(tree.path(), json!({"path": "a.gd", "hash": "hash-a"}));
        let (_, send) = editor(vec![at(
            None,
            json!({"scene": "res://main.tscn", "revision": 13}),
        )]);
        through_the_editor(Some(tree.path()), call(None), send).expect("a read");

        forget_revision(tree.path());
        assert_eq!(expected_next(tree.path()), (None, None));
        assert_eq!(told(tree.path(), "a.gd"), Some(json!("hash-a")));
    }

    /// A task that ends must not answer for the one that reuses its directory.
    #[test]
    fn a_worktree_forgotten_forgets_its_revision_and_no_other() {
        let (one, two) = (worktree(), worktree());
        for (tree, revision) in [(&one, 3), (&two, 11)] {
            let (_, send) = editor(vec![at(
                None,
                json!({"scene": "res://a.tscn", "revision": revision}),
            )]);
            through_the_editor(Some(tree.path()), call(None), send).expect("a read");
        }
        forget_worktree(one.path());
        assert_eq!(expected_next(one.path()).0, None);
        assert_eq!(expected_next(two.path()).0, Some(11));
    }
}

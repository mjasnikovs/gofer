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

use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

/// Every path this agent has read, and the hash it was given for it.
fn ledger() -> &'static Mutex<HashMap<(PathBuf, String), String>> {
    static LEDGER: OnceLock<Mutex<HashMap<(PathBuf, String), String>>> = OnceLock::new();
    LEDGER.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Records what a read — or a write, which answers with the hash it just stored — reported.
pub fn remember(root: &Path, path: &str, hash: &str) {
    if hash.is_empty() {
        return;
    }
    if let Ok(mut held) = ledger().lock() {
        held.insert((root.to_owned(), path.to_owned()), hash.to_owned());
    }
}

/// The hash this agent was last given for a file, if it has ever been told.
pub fn recall(root: &Path, path: &str) -> Option<String> {
    ledger()
        .lock()
        .ok()?
        .get(&(root.to_owned(), path.to_owned()))
        .cloned()
}

/// Drops one path, for a delete or a move that makes the record a claim about nothing.
pub fn forget(root: &Path, path: &str) {
    if let Ok(mut held) = ledger().lock() {
        held.remove(&(root.to_owned(), path.to_owned()));
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

/// Records every path/hash pair in an answer, and takes the bookkeeping back out of it.
///
/// One step where the pairs are produced, rather than a five-part ritual re-enacted per router arm.
/// Every operation that touches a file answers with the same two shapes — one stamp, or a `files`
/// list of them — so this is the whole of "the ledger is up to date and the model never sees a
/// hash", and an operation cannot forget half of it.
///
/// It used to be prose. `apply_rename` did not enact it at all: a rename left the ledger holding
/// hashes for files it had just rewritten, and the model cannot clear them — `expectedHash` is
/// hidden from the signature — so the next save over a renamed file was refused `file_conflict`
/// with no call it could make to escape.
///
/// `version` goes too. It is the language server's document counter, which no operation accepts as
/// a parameter at all: a field a caller cannot pass anywhere is context it pays for and cannot
/// spend. The renderer's own Tauri commands still get both — Monaco holds a buffer and a token, and
/// an agent holds neither.
pub fn reconcile(root: &Path, answer: Value) -> Value {
    let mut answer = answer;
    if let Value::Array(entries) = &mut answer {
        for entry in entries.iter_mut() {
            reconcile_in_place(root, entry);
        }
    } else {
        reconcile_in_place(root, &mut answer);
    }
    answer
}

/// One stamp, or the `files` list an operation answers with. Nothing deeper: the shapes a file
/// operation answers with are flat by design, and a recursive walk would strip `hash` out of a
/// diagnostic or a search hit that happens to carry one.
fn reconcile_in_place(root: &Path, entry: &mut Value) {
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
        .zip(fields.get("hash").and_then(Value::as_str))
        .map(|(path, hash)| (path.to_owned(), hash.to_owned()));
    if let Some((path, hash)) = stamp {
        remember(root, &path, &hash);
    }
    fields.remove("hash");
    fields.remove("version");
}

/// Which scene a remembered revision counts, and what it was last reported to be at.
///
/// The pair is the point. A revision on its own says nothing about which scene it belongs to, and
/// the addon resets its counter to zero every time the edited scene changes — so a remembered zero
/// for one scene matched a freshly opened *different* scene exactly, and the agent's next mutation
/// went out unguarded and landed in the scene the user had just opened. Nothing said so.
#[derive(Clone, Debug, PartialEq)]
pub struct SceneRevision {
    pub scene: String,
    pub revision: u64,
}

/// The scene and revision each worktree's editor was last reported at.
fn revisions() -> &'static Mutex<HashMap<PathBuf, SceneRevision>> {
    static REVISIONS: OnceLock<Mutex<HashMap<PathBuf, SceneRevision>>> = OnceLock::new();
    REVISIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Records the revision an answer reported, and the scene it counted.
///
/// An answer that names no scene keeps the scene already remembered: a mutation reports its
/// revision on the envelope and names nothing, which is not the same as there being no scene.
pub fn remember_revision(root: &Path, scene: Option<&str>, revision: u64) {
    if let Ok(mut held) = revisions().lock() {
        let scene = scene
            .map(str::to_owned)
            .or_else(|| held.get(root).map(|held| held.scene.clone()))
            .unwrap_or_default();
        held.insert(root.to_owned(), SceneRevision { scene, revision });
    }
}

/// The scene and revision this agent was last told about, if it has ever been told.
pub fn recall_revision(root: &Path) -> Option<SceneRevision> {
    revisions().lock().ok()?.get(root).cloned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root(name: &str) -> PathBuf {
        PathBuf::from(format!("/tmp/gofer-read-ledger/{name}"))
    }

    #[test]
    fn a_path_answers_with_the_hash_it_was_last_told() {
        let tree = root("told");
        assert_eq!(recall(&tree, "a.gd"), None);
        remember(&tree, "a.gd", "aaaa");
        assert_eq!(recall(&tree, "a.gd").as_deref(), Some("aaaa"));
        remember(&tree, "a.gd", "bbbb");
        assert_eq!(recall(&tree, "a.gd").as_deref(), Some("bbbb"));
    }

    /// Two worktrees hold the same relative paths, and one must never answer for the other.
    #[test]
    fn two_worktrees_keep_their_own_records() {
        let (one, two) = (root("one"), root("two"));
        remember(&one, "player.gd", "1111");
        remember(&two, "player.gd", "2222");
        assert_eq!(recall(&one, "player.gd").as_deref(), Some("1111"));
        assert_eq!(recall(&two, "player.gd").as_deref(), Some("2222"));
        forget_worktree(&one);
        assert_eq!(recall(&one, "player.gd"), None);
        assert_eq!(recall(&two, "player.gd").as_deref(), Some("2222"));
    }

    /// A deleted file's record is a claim about nothing, and keeping it would refuse the save that
    /// recreates the file — the one case where passing no hash is the whole point.
    #[test]
    fn a_forgotten_path_reads_as_never_told() {
        let tree = root("forgotten");
        remember(&tree, "gone.gd", "cccc");
        forget(&tree, "gone.gd");
        assert_eq!(recall(&tree, "gone.gd"), None);
    }

    /// One record per worktree, and a task that ends must not answer for the one that reuses its
    /// directory — a stale number there refuses every mutation.
    #[test]
    fn a_worktree_answers_with_the_revision_it_was_last_told() {
        let (one, two) = (root("rev-one"), root("rev-two"));
        assert_eq!(recall_revision(&one), None);
        remember_revision(&one, Some("res://a.tscn"), 3);
        remember_revision(&two, Some("res://b.tscn"), 11);
        assert_eq!(recall_revision(&one).map(|held| held.revision), Some(3));
        remember_revision(&one, Some("res://a.tscn"), 4);
        assert_eq!(recall_revision(&one).map(|held| held.revision), Some(4));
        assert_eq!(recall_revision(&two).map(|held| held.revision), Some(11));
        forget_worktree(&one);
        assert_eq!(recall_revision(&one), None);
        assert_eq!(recall_revision(&two).map(|held| held.revision), Some(11));
    }

    /// Zero is the revision a freshly opened scene is at, so it has to survive being recorded —
    /// an `unwrap_or_default` anywhere on this path reads it as "never told" and passes nothing.
    #[test]
    fn revision_zero_is_a_record_like_any_other() {
        let tree = root("rev-zero");
        remember_revision(&tree, Some("res://main.tscn"), 0);
        assert_eq!(recall_revision(&tree).map(|held| held.revision), Some(0));
    }

    /// The regression this pair exists for: a revision has to say which scene it counts.
    ///
    /// The addon resets its counter to zero whenever the edited scene changes. A ledger holding a
    /// bare `0` for `a.tscn` therefore matched a freshly opened `b.tscn` exactly, the mutation's
    /// guard passed, and the change landed in the scene the user had just opened. Nothing said so.
    #[test]
    fn a_revision_carries_the_scene_it_counts() {
        let tree = root("rev-scene");
        remember_revision(&tree, Some("res://a.tscn"), 0);
        let held = recall_revision(&tree).expect("a recorded revision");
        assert_eq!(held.scene, "res://a.tscn");
        assert_eq!(held.revision, 0);

        // A mutation reports its revision on the envelope and names no scene. That is not the same
        // as there being no scene, so the one already recorded is kept.
        remember_revision(&tree, None, 1);
        let after = recall_revision(&tree).expect("a recorded revision");
        assert_eq!(after.scene, "res://a.tscn");
        assert_eq!(after.revision, 1);

        // And a read of a different scene moves both halves together.
        remember_revision(&tree, Some("res://b.tscn"), 0);
        let switched = recall_revision(&tree).expect("a recorded revision");
        assert_eq!(switched.scene, "res://b.tscn");
        assert_eq!(switched.revision, 0);
    }

    /*
     * The whole of "the ledger is up to date and the model never sees a hash", in one step.
     *
     * It used to be five steps re-enacted per router arm, and `apply_rename` enacted none of them:
     * a rename left records for text it had just rewritten, and the next save over one was refused
     * `file_conflict` with no call the model could make to escape — `expectedHash` is hidden from
     * the signature, so it cannot clear a record it is never shown.
     */
    #[test]
    fn reconciling_records_every_stamp_and_hands_back_none_of_them() {
        let tree = root("reconcile");
        let answer = reconcile(
            &tree,
            serde_json::json!({"path": "player.gd", "hash": "aaaa", "version": 3, "bytes": 12}),
        );

        assert_eq!(recall(&tree, "player.gd").as_deref(), Some("aaaa"));
        assert_eq!(answer["path"], "player.gd");
        assert_eq!(answer["bytes"], 12);
        assert!(answer.get("hash").is_none(), "{answer}");
        assert!(answer.get("version").is_none(), "{answer}");
    }

    /// The other shape every file-touching operation answers with: a `files` list of the same
    /// stamps. One rule over both, so a batched arm cannot leak what a single one does not.
    #[test]
    fn reconciling_reaches_every_file_in_a_batch() {
        let tree = root("reconcile-batch");
        let answer = reconcile(
            &tree,
            serde_json::json!({"files": [
                {"path": "a.gd", "hash": "1111", "version": 1},
                {"path": "b.gd", "hash": "2222", "version": 2}
            ]}),
        );

        assert_eq!(recall(&tree, "a.gd").as_deref(), Some("1111"));
        assert_eq!(recall(&tree, "b.gd").as_deref(), Some("2222"));
        assert!(
            !answer.to_string().contains("hash"),
            "no answer the model reads may carry one: {answer}"
        );
    }

    /// A `list` with hashing off answers `null`, which is not a record and not a field either.
    #[test]
    fn reconciling_an_answer_with_no_hash_records_nothing() {
        let tree = root("reconcile-none");
        let answer = reconcile(
            &tree,
            serde_json::json!({"files": [{"path": "art.png", "bytes": 40, "hash": null}]}),
        );

        assert_eq!(recall(&tree, "art.png"), None);
        assert!(answer["files"][0].get("hash").is_none(), "{answer}");
        assert_eq!(answer["files"][0]["bytes"], 40);
    }

    /// A file whose text was withheld leaves the ledger alone, so a later write is refused.
    ///
    /// `godot_script open` stops carrying text once a batched call has spent its budget, and it
    /// answers with the path so the model knows what it is missing. Answering with the hash as well
    /// would record the file as read: the next `save` is handed that hash as its `expectedHash`,
    /// the workspace finds it current, and a whole file is replaced out of text nobody was shown.
    #[test]
    fn a_file_answered_without_its_text_is_not_recorded_as_read() {
        let tree = root("reconcile-withheld");
        remember(&tree, "kept.gd", "an-older-hash");

        let answer = reconcile(
            &tree,
            serde_json::json!({"files": [
                {"path": "kept.gd", "bytes": 12, "hash": "shown"},
                {"path": "withheld.gd", "bytes": 900, "version": 3, "omitted": "no room left"},
            ]}),
        );

        // The file that came with its text is recorded, as always.
        assert_eq!(recall(&tree, "kept.gd").as_deref(), Some("shown"));
        // The withheld one is not — not recorded now, and not refreshed from what it used to be.
        assert_eq!(recall(&tree, "withheld.gd"), None);
        assert_eq!(answer["files"][1]["omitted"], "no room left");
    }

    /// A batch operation answers with a list of stamps rather than one, and every one is recorded.
    #[test]
    fn reconciling_reaches_every_entry_of_a_list_shaped_answer() {
        let tree = root("reconcile-list");
        let answer = reconcile(
            &tree,
            serde_json::json!([
                {"path": "one.gd", "hash": "1111", "version": 1},
                {"path": "two.gd", "hash": "2222"}
            ]),
        );

        assert_eq!(recall(&tree, "one.gd").as_deref(), Some("1111"));
        assert_eq!(recall(&tree, "two.gd").as_deref(), Some("2222"));
        assert!(!answer.to_string().contains("hash"), "{answer}");
    }

    /// Not every answer is a stamp. One that is not an object is handed back untouched rather than
    /// walked, because a recursive strip would take `hash` out of a search hit that carries one.
    #[test]
    fn an_answer_that_is_not_a_stamp_is_handed_back_as_it_is() {
        let tree = root("reconcile-scalar");
        assert_eq!(
            reconcile(&tree, serde_json::json!("ok")),
            serde_json::json!("ok")
        );
        assert_eq!(
            reconcile(&tree, serde_json::json!([1, 2])),
            serde_json::json!([1, 2])
        );
    }

    #[test]
    fn an_empty_hash_is_not_a_record() {
        let tree = root("empty");
        remember(&tree, "b.gd", "");
        assert_eq!(recall(&tree, "b.gd"), None);
    }
}

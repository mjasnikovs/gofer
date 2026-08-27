//! Acceptance coverage for the script commands the renderer's Monaco editor calls.
//!
//! Step 8 proved the language-server client against a real editor. This module proves the layer
//! above it — the document lifecycle Monaco drives — against the same real editor: opening a file,
//! reporting buffer changes, saving with optimistic concurrency, and applying a cross-file rename
//! as one transaction.
//!
//! The one thing it deliberately does not reuse is the session supervisor's launch: that starts a
//! windowed editor, which no headless gate can run, so the pinned editor is launched here with
//! `--headless --lsp-port` and bound through [`crate::godot_session::bind`].

use crate::files::Workspace;
use crate::godot_editor_harness::{BoundEditor, Editor, RETRY_EVERY, free_port, retry_until};
use crate::godot_lsp_acceptance::{
    MATH_UTILS, SCORE_KEEPER, launch, position_of, worktree_with_probes,
};
use crate::script::{
    self, ApplyRenameRequest, EditScriptRequest, OpenScriptRequest, SaveScriptRequest,
    ScriptDocument, ScriptEdit, ScriptFileEdit, ScriptRequest, ScriptResponse, UpdateScriptRequest,
};
use lsp_types::{DiagnosticSeverity, Position};
use std::path::Path;
use tempfile::TempDir;

const MATH_PATH: &str = "scripts/math_utils.gd";
const KEEPER_PATH: &str = "scripts/score_keeper.gd";

/// Opens a document, retrying while the editor is still importing the project. The commands
/// connect lazily, so the first call is also what proves the editor answered at all.
fn open_when_ready(path: &str, editor: &Editor) -> ScriptDocument {
    retry_until(
        &format!("the language server never accepted {path}"),
        || editor.output(),
        RETRY_EVERY,
        || {
            script::open_document(OpenScriptRequest {
                path: path.to_owned(),
            })
            .map_err(|error| format!("{}: {}", error.code, error.message))
        },
    )
}

fn script_position(text: &str, needle: &str) -> Position {
    position_of(text, needle)
}

fn script_edit(old_text: &str, new_text: &str) -> ScriptEdit {
    ScriptEdit {
        old_text: old_text.to_owned(),
        new_text: new_text.to_owned(),
    }
}

fn read(worktree: &Path, path: &str) -> String {
    Workspace::open(worktree)
        .expect("open worktree")
        .read(path)
        .expect("read script")
        .text
}

#[test]
fn the_editor_serves_monaco_through_the_script_commands() {
    let directory = TempDir::new().expect("temporary directory");
    let worktree = worktree_with_probes(&directory);
    let lsp_port = free_port();
    let editor = launch(&worktree, lsp_port);
    // Held rather than cleared at the end: an assertion below panicking would otherwise leave this
    // editor bound for every later test in the process, long after it has been torn down.
    let _bound = BoundEditor::external(lsp_port, 0, &worktree);

    // Opening is the renderer's first contact: it returns the text, the hash the next write must
    // replace, and the document version the server assigned.
    let opened = open_when_ready(MATH_PATH, &editor);
    assert_eq!(opened.text, MATH_UTILS);
    assert_eq!(opened.version, 1);
    assert!(!opened.hash.is_empty());

    // A buffer change bumps exactly one version. Rust owns the counter, so a UI edit and an AI
    // edit of the same file can never disagree about which version the server holds.
    let edited =
        format!("{MATH_UTILS}\n\nstatic func doubled(value: int) -> int:\n\treturn value * 2\n");
    let changed = script::update_document(UpdateScriptRequest {
        path: MATH_PATH.to_owned(),
        text: edited.clone(),
    })
    .expect("report the buffer change");
    assert_eq!(changed.version, 2);
    assert!(changed.hash.is_none(), "an in-memory change writes nothing");
    assert_eq!(read(&worktree, MATH_PATH), MATH_UTILS);

    // Saving writes through the workspace transaction and reports the save to the server.
    let saved = script::save_document(SaveScriptRequest {
        path: MATH_PATH.to_owned(),
        text: edited.clone(),
        expected_hash: Some(opened.hash.clone()),
    })
    .expect("save the buffer");
    assert_eq!(read(&worktree, MATH_PATH), edited);
    assert!(saved.version > changed.version);
    let saved_hash = saved.hash.expect("a save reports the new hash");
    assert_ne!(saved_hash, opened.hash);

    // The stale hash is exactly what a second editor of the same file would send.
    let conflict = script::save_document(SaveScriptRequest {
        path: MATH_PATH.to_owned(),
        text: "extends RefCounted\n".to_owned(),
        expected_hash: Some(opened.hash.clone()),
    })
    .expect_err("a stale save must be refused");
    assert_eq!(conflict.code, "file_conflict");
    assert_eq!(read(&worktree, MATH_PATH), edited);

    // Re-opening the same file re-synchronizes one document instead of stacking a second one.
    let reopened = open_when_ready(MATH_PATH, &editor);
    assert_eq!(reopened.hash, saved_hash);
    assert!(reopened.version > saved.version);

    // An edit writes both files in one call and answers with what the real server published for
    // each, which is the whole reason the operation exists: the caller sends the lines it is
    // changing and needs no second call to learn whether they parse.
    let edits = script::edit_documents(EditScriptRequest {
        files: vec![
            ScriptFileEdit {
                path: MATH_PATH.to_owned(),
                edits: vec![script_edit("return value * 2", "return value * 3")],
            },
            ScriptFileEdit {
                path: KEEPER_PATH.to_owned(),
                edits: vec![script_edit("var total := 0", "var total: int = 0")],
            },
        ],
    })
    .expect("edit both scripts");
    assert_eq!(edits.len(), 2);
    for file in &edits {
        assert_eq!(file.replaced, 1, "{}: {file:?}", file.path);
        assert!(file.published, "{} answered no verdict", file.path);
    }
    assert!(read(&worktree, MATH_PATH).contains("return value * 3"));
    assert!(read(&worktree, KEEPER_PATH).contains("var total: int = 0"));

    // An anchor quoted from text the last edit replaced is how a stale edit presents itself, and
    // it is refused before anything is written.
    let stale = script::edit_documents(EditScriptRequest {
        files: vec![ScriptFileEdit {
            path: MATH_PATH.to_owned(),
            edits: vec![script_edit("return value * 2", "return value * 4")],
        }],
    })
    .expect_err("an anchor that is no longer there must be refused");
    assert_eq!(stale.code, "anchor_not_found");
    assert!(read(&worktree, MATH_PATH).contains("return value * 3"));

    // The verdict is the server's, not Gofer's: breaking the file has to come back as a real
    // diagnostic on the same call that broke it.
    let broken = script::edit_documents(EditScriptRequest {
        files: vec![ScriptFileEdit {
            path: MATH_PATH.to_owned(),
            edits: vec![script_edit("return value * 3", "return value *")],
        }],
    })
    .expect("write the broken text");
    assert!(
        broken[0]
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.severity == Some(DiagnosticSeverity::ERROR)),
        "the parse error must come back with the edit: {:?}",
        broken[0].diagnostics
    );

    let repaired = script::edit_documents(EditScriptRequest {
        files: vec![ScriptFileEdit {
            path: MATH_PATH.to_owned(),
            edits: vec![script_edit("return value *", "return value * 3")],
        }],
    })
    .expect("repair the script");
    assert!(
        repaired[0]
            .diagnostics
            .iter()
            .all(|diagnostic| diagnostic.severity != Some(DiagnosticSeverity::ERROR)),
        "the repair must clear the parse error: {:?}",
        repaired[0].diagnostics
    );

    // A whole-file write earns the same answer an anchor edit does. Creating a script is the one
    // way a caller reaches a file that does not exist yet, and the question it has afterwards is
    // the question an edit is already answered: does this parse. Answering only with the byte
    // count spends a second call and a second wait to learn what this call already knew.
    let created_path = "scripts/created_by_save.gd";
    let broken_save = script::save_and_publish(SaveScriptRequest {
        path: created_path.to_owned(),
        text: "extends RefCounted\n\nfunc broken() -> int:\n\treturn 1 +\n".to_owned(),
        expected_hash: None,
    })
    .expect("create the script");
    assert_eq!(broken_save.path, created_path);
    assert!(broken_save.bytes > 0, "a save reports what it wrote");
    assert!(
        broken_save.published,
        "the server said nothing about the text this save wrote: {broken_save:?}"
    );
    assert!(
        broken_save
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.severity == Some(DiagnosticSeverity::ERROR)),
        "the parse error must come back with the save that wrote it: {:?}",
        broken_save.diagnostics
    );

    // And the repair clears it on the same call, so a caller never has to ask twice.
    let fixed_save = script::save_and_publish(SaveScriptRequest {
        path: created_path.to_owned(),
        text: "extends RefCounted\n\nfunc broken() -> int:\n\treturn 1 + 1\n".to_owned(),
        expected_hash: Some(broken_save.hash.clone()),
    })
    .expect("repair the script");
    assert!(
        fixed_save
            .diagnostics
            .iter()
            .all(|diagnostic| diagnostic.severity != Some(DiagnosticSeverity::ERROR)),
        "the repair must clear the parse error on the save itself: {:?}",
        fixed_save.diagnostics
    );

    let keeper = open_when_ready(KEEPER_PATH, &editor);
    assert!(keeper.text.contains("var total: int = 0"));

    // Renaming plans across both scripts and writes nothing until the plan is applied.
    let usage = script_position(SCORE_KEEPER, "add_score");
    let planned = script::call(ScriptRequest::Rename {
        path: KEEPER_PATH.to_owned(),
        position: usage,
        new_name: "sum_score".to_owned(),
    })
    .expect("plan the rename");
    let ScriptResponse::Rename { files } = planned else {
        panic!("a rename must answer with a plan");
    };
    assert!(
        files.len() >= 2,
        "the rename must touch both scripts, got {files:?}"
    );
    assert!(read(&worktree, KEEPER_PATH).contains("add_score"));

    let stamps = script::apply_rename(ApplyRenameRequest {
        files: files.clone(),
    })
    .expect("apply the rename");
    assert_eq!(stamps.len(), files.len());
    for path in [MATH_PATH, KEEPER_PATH] {
        let text = read(&worktree, path);
        assert!(text.contains("sum_score"), "{path}: {text}");
        assert!(!text.contains("add_score"), "{path}: {text}");
    }

    // Navigation answers in workspace-relative paths, never in engine-owned file URIs.
    let located = script::call(ScriptRequest::Definition {
        path: KEEPER_PATH.to_owned(),
        position: script_position(&read(&worktree, KEEPER_PATH), "sum_score"),
    })
    .expect("definition request");
    let ScriptResponse::Locations { locations } = located else {
        panic!("a definition must answer with locations");
    };
    assert!(
        locations
            .iter()
            .all(|location| !location.path.starts_with('/')),
        "locations must stay workspace-relative, got {locations:?}"
    );

    script::close_document(OpenScriptRequest {
        path: KEEPER_PATH.to_owned(),
    })
    .expect("close the document");
    // Closing a document the server no longer holds is not an error: tabs outlive sessions.
    script::close_document(OpenScriptRequest {
        path: KEEPER_PATH.to_owned(),
    })
    .expect("closing twice is harmless");
}

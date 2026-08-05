//! Acceptance coverage for the script commands the renderer's Monaco editor calls.
//!
//! Step 8 proved the language-server client against a real editor. This module proves the layer
//! above it — the document lifecycle Monaco drives — against the same real editor: opening a file,
//! reporting buffer changes, saving with optimistic concurrency, and applying a cross-file rename
//! as one transaction.
//!
//! The one thing it deliberately does not reuse is the session supervisor's launch: that starts a
//! windowed editor, which no headless gate can run, so the pinned editor is launched here with
//! `--headless --lsp-port` and bound through [`crate::script::bind_test_session`].

use crate::files::Workspace;
use crate::godot_lsp_acceptance::{
    Editor, MATH_UTILS, READY_TIMEOUT, SCORE_KEEPER, fixture_worktree, launch, position_of,
};
use crate::script::{
    self, ApplyRenameRequest, OpenScriptRequest, SaveScriptRequest, ScriptDocument, ScriptRequest,
    ScriptResponse, UpdateScriptRequest,
};
use lsp_types::Position;
use std::net::TcpListener;
use std::path::Path;
use std::thread;
use std::time::{Duration, Instant};
use tempfile::TempDir;

const MATH_PATH: &str = "scripts/math_utils.gd";
const KEEPER_PATH: &str = "scripts/score_keeper.gd";

/// Opens a document, retrying while the editor is still importing the project. The commands
/// connect lazily, so the first call is also what proves the editor answered at all.
fn open_when_ready(path: &str, editor: &Editor) -> ScriptDocument {
    let deadline = Instant::now() + READY_TIMEOUT;
    let mut last = "no attempt".to_owned();
    while Instant::now() < deadline {
        match script::open_document(OpenScriptRequest {
            path: path.to_owned(),
        }) {
            Ok(document) => return document,
            Err(error) => {
                last = format!("{}: {}", error.code, error.message);
                thread::sleep(Duration::from_millis(500));
            }
        }
    }
    panic!(
        "the language server never accepted {path}: {last}\n--- editor output ---\n{}",
        editor.output()
    );
}

fn script_position(text: &str, needle: &str) -> Position {
    position_of(text, needle)
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
    let worktree = fixture_worktree(&directory);
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind probe listener");
    let lsp_port = listener.local_addr().expect("probe address").port();
    drop(listener);
    let editor = launch(&worktree, lsp_port);
    script::bind_test_session(lsp_port, &worktree.display().to_string());

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

    let keeper = open_when_ready(KEEPER_PATH, &editor);
    assert_eq!(keeper.text, SCORE_KEEPER);

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

    script::clear_test_session();
}

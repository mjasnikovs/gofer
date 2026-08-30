//! Acceptance coverage for the language-server boundary: a real pinned Godot editor answering the
//! real [`LspClient`] about real fixture scripts.
//!
//! The unit suite in `godot_lsp` plays both sides of the wire — the same author wrote the client
//! and the fake server, which is how a green suite ships a framing the real server never speaks.
//! This module removes the stand-in: it launches the pinned editor with `--lsp-port`, connects
//! over loopback TCP, and proves diagnostics, navigation, and a multi-file rename across several
//! scripts. Gated behind the `godot-acceptance` feature so the fast gate needs no engine.

use crate::files::Workspace;
use crate::godot_editor_harness::{self, Editor, Launch, RETRY_EVERY, free_port, retry_until};
use crate::godot_lsp::{LspClient, commit_planned_edit, file_uri, plan_workspace_edit};
use lsp_types::{
    DiagnosticSeverity, DocumentSymbolResponse, GotoDefinitionResponse, Position,
    PrepareRenameResponse, Url,
};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use tempfile::TempDir;

const DIAGNOSTICS_TIMEOUT: Duration = Duration::from_secs(30);

pub(crate) const MATH_UTILS: &str = "class_name MathUtils\nextends RefCounted\n\n\nstatic func add_score(base: int, bonus: int) -> int:\n\treturn base + bonus\n";
pub(crate) const SCORE_KEEPER: &str = "extends Node\n\nvar total := 0\n\n\nfunc award(bonus: int) -> void:\n\ttotal = MathUtils.add_score(total, bonus)\n";
const BROKEN: &str = "extends Node\n\nfunc explode( -> void:\n\tpass\n";

/// Copies the fixture project and adds the scripts this suite navigates. The checked-in fixture
/// deliberately stays free of them: the parse error in `broken.gd` must never reach the Node
/// journeys, which scan editor output for script errors.
pub(crate) fn worktree_with_probes(directory: &TempDir) -> PathBuf {
    let worktree = godot_editor_harness::fixture_worktree(directory);
    let scripts = worktree.join("scripts");
    std::fs::create_dir_all(&scripts).expect("create scripts directory");
    std::fs::write(scripts.join("math_utils.gd"), MATH_UTILS).expect("write math_utils.gd");
    std::fs::write(scripts.join("score_keeper.gd"), SCORE_KEEPER).expect("write score_keeper.gd");
    std::fs::write(scripts.join("broken.gd"), BROKEN).expect("write broken.gd");
    worktree
}

/// Launches the pinned editor with its language server on a known port.
pub(crate) fn launch(worktree: &Path, lsp_port: u16) -> Editor {
    Launch::on(worktree).lsp(lsp_port).start()
}

/// Polls until the editor's language server accepts a connection and answers initialize. The
/// editor imports the project first, so early connection attempts are expected to fail.
fn connect(worktree: &Path, lsp_port: u16, editor: &Editor) -> LspClient {
    let address = SocketAddr::from(([127, 0, 0, 1], lsp_port));
    retry_until(
        "the language server never answered",
        || editor.output(),
        RETRY_EVERY,
        || {
            LspClient::connect(address, worktree)
                .map_err(|error| format!("{}: {}", error.code, error.message))
        },
    )
}

/// The position one character inside `needle`, which is where language servers like the cursor
/// for navigation requests.
pub(crate) fn position_of(text: &str, needle: &str) -> Position {
    let offset = text
        .find(needle)
        .unwrap_or_else(|| panic!("{needle} must exist in the fixture script"));
    let before = &text[..offset];
    let line = before.matches('\n').count() as u32;
    let character = before.rsplit('\n').next().expect("a line").len() as u32;
    Position::new(line, character + 1)
}

fn definition_uris(response: Option<GotoDefinitionResponse>) -> Vec<Url> {
    match response {
        Some(GotoDefinitionResponse::Scalar(location)) => vec![location.uri],
        Some(GotoDefinitionResponse::Array(locations)) => {
            locations.into_iter().map(|location| location.uri).collect()
        }
        Some(GotoDefinitionResponse::Link(links)) => {
            links.into_iter().map(|link| link.target_uri).collect()
        }
        None => Vec::new(),
    }
}

#[test]
fn the_editor_reports_diagnostics_and_navigation_across_scripts() {
    let directory = TempDir::new().expect("temporary directory");
    let worktree = worktree_with_probes(&directory);
    let workspace = Workspace::open(&worktree).expect("open worktree");

    let lsp_port = free_port();
    let editor = launch(&worktree, lsp_port);
    let client = connect(&worktree, lsp_port, &editor);

    let math = file_uri(&workspace, "scripts/math_utils.gd").expect("math uri");
    let keeper = file_uri(&workspace, "scripts/score_keeper.gd").expect("keeper uri");
    let broken = file_uri(&workspace, "scripts/broken.gd").expect("broken uri");

    let diagnostics = client.subscribe_diagnostics();
    client
        .open_document(&broken, BROKEN)
        .expect("open broken.gd");
    let deadline = Instant::now() + DIAGNOSTICS_TIMEOUT;
    let reported = loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        let params = diagnostics.recv_timeout(remaining).unwrap_or_else(|_| {
            panic!(
                "no diagnostics for broken.gd arrived\n--- editor output ---\n{}",
                editor.output()
            )
        });
        if params.uri == broken && !params.diagnostics.is_empty() {
            break params;
        }
    };
    assert!(
        reported
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.severity == Some(DiagnosticSeverity::ERROR)),
        "broken.gd must report an error, got {:?}",
        reported.diagnostics
    );

    client
        .open_document(&math, MATH_UTILS)
        .expect("open math_utils.gd");
    client
        .open_document(&keeper, SCORE_KEEPER)
        .expect("open score_keeper.gd");

    let symbols = client
        .document_symbols(&math)
        .expect("document symbols")
        .expect("math_utils.gd has symbols");
    let DocumentSymbolResponse::Nested(items) = symbols else {
        panic!("expected hierarchical document symbols");
    };
    let names: Vec<&str> = items
        .iter()
        .flat_map(|item| {
            let mut names = vec![item.name.as_str()];
            if let Some(children) = &item.children {
                names.extend(children.iter().map(|child| child.name.as_str()));
            }
            names
        })
        .collect();
    assert!(
        names.contains(&"add_score"),
        "add_score must be outlined, got {names:?}"
    );

    let usage = position_of(SCORE_KEEPER, "add_score");
    let targets = definition_uris(
        client
            .definition(&keeper, usage)
            .expect("definition request"),
    );
    assert!(
        targets.iter().any(|uri| uri == &math),
        "add_score must resolve into math_utils.gd, got {targets:?}\n--- editor output ---\n{}",
        editor.output()
    );

    let hover = client.hover(&math, position_of(MATH_UTILS, "add_score"));
    assert!(hover.is_ok(), "hover must answer: {hover:?}");

    let prepared = client
        .prepare_rename(&keeper, usage)
        .expect("prepare rename request");
    assert!(
        matches!(
            prepared,
            Some(
                PrepareRenameResponse::Range(_)
                    | PrepareRenameResponse::RangeWithPlaceholder { .. }
            )
        ),
        "add_score must be renameable, got {prepared:?}"
    );
    let edit = client
        .rename(&keeper, usage, "sum_score")
        .expect("rename request");
    let planned = plan_workspace_edit(&workspace, &edit).expect("plan the rename");
    assert!(
        planned.len() >= 2,
        "the rename must touch both scripts, got {planned:?}"
    );
    commit_planned_edit(&workspace, &planned).expect("commit the rename");

    let renamed_math = workspace
        .read("scripts/math_utils.gd")
        .expect("read math_utils.gd")
        .text;
    let renamed_keeper = workspace
        .read("scripts/score_keeper.gd")
        .expect("read score_keeper.gd")
        .text;
    assert!(renamed_math.contains("sum_score"), "{renamed_math}");
    assert!(renamed_keeper.contains("sum_score"), "{renamed_keeper}");
    assert!(!renamed_math.contains("add_score"), "{renamed_math}");
    assert!(!renamed_keeper.contains("add_score"), "{renamed_keeper}");

    let server_provides_symbols = matches!(
        client.server_capabilities().workspace_symbol_provider,
        Some(lsp_types::OneOf::Left(true)) | Some(lsp_types::OneOf::Right(_))
    );
    assert!(
        !server_provides_symbols,
        "this test only makes sense while Godot lacks workspace symbols"
    );
    let matches = client
        .workspace_symbols(&workspace, "mathutils")
        .expect("workspace symbols");
    assert!(
        matches.iter().any(|symbol| symbol.name == "MathUtils"),
        "the synthesized index must find MathUtils, got {matches:?}"
    );

    client.shutdown();
}

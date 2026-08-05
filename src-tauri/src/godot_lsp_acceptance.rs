//! Acceptance coverage for the language-server boundary: a real pinned Godot editor answering the
//! real [`LspClient`] about real fixture scripts.
//!
//! The unit suite in `godot_lsp` plays both sides of the wire — the same author wrote the client
//! and the fake server, which is how a green suite ships a framing the real server never speaks.
//! This module removes the stand-in: it launches the pinned editor with `--lsp-port`, connects
//! over loopback TCP, and proves diagnostics, navigation, and a multi-file rename across several
//! scripts. Gated behind the `godot-acceptance` feature so the fast gate needs no engine.

use crate::files::Workspace;
use crate::godot_lsp::{LspClient, commit_planned_edit, file_uri, plan_workspace_edit};
use crate::process::{ChildProcess, ProcessSpawner, SystemProcessSpawner};
use lsp_types::{
    DiagnosticSeverity, DocumentSymbolResponse, GotoDefinitionResponse, Position,
    PrepareRenameResponse, Url,
};
use serde_json::Value;
use std::ffi::{OsStr, OsString};
use std::io::{BufRead, BufReader};
use std::net::{SocketAddr, TcpListener};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tempfile::TempDir;

/// The engine the repository pins. Kept in step with `scripts/godot-binary.mjs`, which reads the
/// same manifest and reports the version with dots where the release tag has a dash.
const ARTIFACTS: &str = include_str!("../../protocol/godot-artifacts.json");
pub const READY_TIMEOUT: Duration = Duration::from_secs(90);
const DIAGNOSTICS_TIMEOUT: Duration = Duration::from_secs(30);

pub const MATH_UTILS: &str = "class_name MathUtils\nextends RefCounted\n\n\nstatic func add_score(base: int, bonus: int) -> int:\n\treturn base + bonus\n";
pub const SCORE_KEEPER: &str = "extends Node\n\nvar total := 0\n\n\nfunc award(bonus: int) -> void:\n\ttotal = MathUtils.add_score(total, bonus)\n";
const BROKEN: &str = "extends Node\n\nfunc explode( -> void:\n\tpass\n";

pub struct Editor {
    child: Box<dyn ChildProcess>,
    output: Arc<Mutex<String>>,
}

impl Editor {
    pub fn output(&self) -> String {
        self.output
            .lock()
            .map(|output| output.clone())
            .unwrap_or_default()
    }
}

impl Drop for Editor {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn pinned_version_prefix() -> String {
    let manifest: Value = serde_json::from_str(ARTIFACTS).expect("parse Godot artifact manifest");
    manifest["version"]
        .as_str()
        .expect("manifest version")
        .replace('-', ".")
}

/// Resolves the pinned editor the same way the Node gate does: an absolute `GOFER_GODOT_BINARY`
/// wins, otherwise the pinned version is accepted from `PATH`. The version is always verified.
pub fn pinned_editor() -> String {
    let expected = pinned_version_prefix();
    let reported = |binary: &str| {
        let arguments = [OsString::from("--version")];
        let output = SystemProcessSpawner
            .output(OsStr::new(binary), &arguments)
            .ok()?;
        output
            .status
            .success
            .then(|| String::from_utf8_lossy(&output.stdout).trim().to_owned())
    };

    if let Ok(configured) = std::env::var("GOFER_GODOT_BINARY") {
        assert!(
            Path::new(&configured).is_absolute(),
            "GOFER_GODOT_BINARY must be an absolute path"
        );
        let version = reported(&configured)
            .unwrap_or_else(|| panic!("Could not execute GOFER_GODOT_BINARY at {configured}"));
        assert!(
            version.starts_with(&expected),
            "Expected Godot {expected}, received {version}"
        );
        return configured;
    }
    for candidate in ["godot4", "godot"] {
        if reported(candidate).is_some_and(|version| version.starts_with(&expected)) {
            return candidate.to_owned();
        }
    }
    panic!(
        "Godot {expected} is required. Install it on PATH, or set GOFER_GODOT_BINARY to the \
         absolute path of the pinned binary."
    );
}

fn copy_tree(source: &Path, target: &Path) {
    std::fs::create_dir_all(target).expect("create target directory");
    for entry in std::fs::read_dir(source).expect("read fixture directory") {
        let entry = entry.expect("fixture entry");
        let destination = target.join(entry.file_name());
        if entry.file_type().expect("entry type").is_dir() {
            copy_tree(&entry.path(), &destination);
        } else {
            std::fs::copy(entry.path(), &destination).expect("copy fixture file");
        }
    }
}

/// Copies the fixture project and adds the scripts this suite navigates. The checked-in fixture
/// deliberately stays free of them: the parse error in `broken.gd` must never reach the Node
/// journeys, which scan editor output for script errors.
pub fn fixture_worktree(directory: &TempDir) -> PathBuf {
    let worktree = directory.path().join("worktree");
    let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("fixtures")
        .join("godot-project");
    copy_tree(&fixture, &worktree);
    let scripts = worktree.join("scripts");
    std::fs::create_dir_all(&scripts).expect("create scripts directory");
    std::fs::write(scripts.join("math_utils.gd"), MATH_UTILS).expect("write math_utils.gd");
    std::fs::write(scripts.join("score_keeper.gd"), SCORE_KEEPER).expect("write score_keeper.gd");
    std::fs::write(scripts.join("broken.gd"), BROKEN).expect("write broken.gd");
    worktree.canonicalize().expect("canonical worktree")
}

pub fn launch(worktree: &Path, lsp_port: u16) -> Editor {
    let arguments = [
        OsString::from("--editor"),
        OsString::from("--headless"),
        OsString::from("--path"),
        worktree.as_os_str().to_owned(),
        OsString::from("--lsp-port"),
        OsString::from(lsp_port.to_string()),
    ];
    let binary = pinned_editor();
    let mut child = SystemProcessSpawner
        .spawn_with_env(OsStr::new(&binary), &arguments, false, &[])
        .expect("launch the pinned Godot editor");

    // Both of the editor's streams are pipes. An unread pipe fills and stalls the editor, so they
    // are drained into one buffer that a failure can quote.
    let output = Arc::new(Mutex::new(String::new()));
    for stream in [child.take_stdout(), child.take_stderr()] {
        let Some(stream) = stream else { continue };
        let sink = Arc::clone(&output);
        thread::spawn(move || {
            let mut reader = BufReader::new(stream);
            let mut line = String::new();
            while reader.read_line(&mut line).unwrap_or(0) > 0 {
                if let Ok(mut sink) = sink.lock() {
                    sink.push_str(&line);
                }
                line.clear();
            }
        });
    }
    Editor { child, output }
}

/// Polls until the editor's language server accepts a connection and answers initialize. The
/// editor imports the project first, so early connection attempts are expected to fail.
fn connect(worktree: &Path, lsp_port: u16, editor: &Editor) -> LspClient {
    let address = SocketAddr::from(([127, 0, 0, 1], lsp_port));
    let deadline = Instant::now() + READY_TIMEOUT;
    let mut last = "no attempt".to_owned();
    while Instant::now() < deadline {
        match LspClient::connect(address, worktree) {
            Ok(client) => return client,
            Err(error) => {
                last = format!("{}: {}", error.code, error.message);
                thread::sleep(Duration::from_millis(500));
            }
        }
    }
    panic!(
        "the language server never answered: {last}\n--- editor output ---\n{}",
        editor.output()
    );
}

/// The position one character inside `needle`, which is where language servers like the cursor
/// for navigation requests.
pub fn position_of(text: &str, needle: &str) -> Position {
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
    let worktree = fixture_worktree(&directory);
    let workspace = Workspace::open(&worktree).expect("open worktree");

    let listener = TcpListener::bind("127.0.0.1:0").expect("bind probe listener");
    let lsp_port = listener.local_addr().expect("probe address").port();
    drop(listener);
    let editor = launch(&worktree, lsp_port);
    let client = connect(&worktree, lsp_port, &editor);

    let math = file_uri(&workspace, "scripts/math_utils.gd").expect("math uri");
    let keeper = file_uri(&workspace, "scripts/score_keeper.gd").expect("keeper uri");
    let broken = file_uri(&workspace, "scripts/broken.gd").expect("broken uri");

    // Diagnostics: subscribing before didOpen, then waiting out the parser, must deliver the
    // syntax error the broken script carries.
    let diagnostics = client.subscribe_diagnostics();
    client
        .open_document(&broken, BROKEN)
        .expect("open broken.gd");
    // The budget is for broken.gd's diagnostics, not for each notification: a chatty editor that
    // never mentions broken.gd must fail on time, and with the editor output attached.
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

    // Outline: the class and its static function must both appear.
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

    // Navigation: a static call through a global class must resolve across files.
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

    // Rename across both files: the server proposes the edit, the workspace applies it as one
    // validated transaction.
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

    // Workspace-wide symbols are synthesized from document symbols because Godot reports
    // `workspaceSymbolProvider: false`. The good scripts still hold `MathUtils` after the rename.
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

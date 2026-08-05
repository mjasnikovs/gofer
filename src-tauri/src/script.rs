//! Script intelligence for the renderer's Monaco editor.
//!
//! Monaco never speaks LSP itself: every provider it registers becomes one Tauri command handled
//! here, so the editor and the AI agent reach Godot's language server through the same client and
//! the same document versions. The server is reached lazily — the first script the renderer opens
//! connects to the port the session supervisor passed to `--lsp-port`, and a restarted editor
//! (new random port) invalidates the cached connection.
//!
//! Saving is deliberately two operations in one command: the workspace write is the authority for
//! what is on disk, and `didSave` carries the document text because Godot reads `text` from those
//! parameters. Godot's own `didSave` handler reloads the script and refreshes its exports, so only
//! non-script files ask the addon to rescan.

use crate::files::{FileError, Workspace};
use crate::godot_lsp::{self, LspClient, LspError, PlannedFile, WorkspaceSymbol};
use crate::godot_rpc::CallRequest;
use crate::godot_session;
use lsp_types::{
    CompletionItem, CompletionResponse, Diagnostic, DocumentHighlight, DocumentSymbolResponse,
    GotoDefinitionResponse, Hover, Location, Position, PrepareRenameResponse, Range, SignatureHelp,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::RecvTimeoutError;
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

/// How long the diagnostics forwarder waits for a notification before re-checking its stop flag.
const DIAGNOSTICS_POLL_INTERVAL: Duration = Duration::from_millis(100);
/// How long a diagnostics pull waits for the server's first publication for a document, and the
/// ceiling a caller may ask for. Godot answers from the editor's main loop in 100 ms slices, so a
/// freshly opened document is routinely a few slices ahead of its diagnostics.
const DEFAULT_DIAGNOSTICS_WAIT_MS: u64 = 5_000;
const MAX_DIAGNOSTICS_WAIT_MS: u64 = 30_000;
const SCRIPT_EXTENSION: &str = ".gd";

/// One open script buffer as the renderer first receives it.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptDocument {
    pub path: String,
    pub text: String,
    pub hash: String,
    pub bytes: u64,
    pub version: i32,
}

/// The result of a write or an in-memory change: what the renderer must record so its next write
/// and its next language request both stay current.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptStamp {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bytes: Option<u64>,
    pub version: i32,
}

/// Diagnostics for one file, forwarded to the renderer's Tauri channel as the server publishes
/// them. Paths are workspace-relative because that is what every other file command speaks.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptDiagnostics {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<i32>,
    pub diagnostics: Vec<Diagnostic>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenScriptRequest {
    pub path: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateScriptRequest {
    pub path: String,
    pub text: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveScriptRequest {
    pub path: String,
    pub text: String,
    /// The hash the renderer believes is on disk. Absent means "this file is new"; a mismatch
    /// fails with `file_conflict` rather than overwriting an external edit.
    #[serde(default)]
    pub expected_hash: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyRenameRequest {
    pub files: Vec<PlannedFile>,
}

/// A language request from one Monaco provider. Tagged by operation so the renderer cannot send a
/// position to a query that takes none.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "op")]
pub enum ScriptRequest {
    Hover {
        path: String,
        position: Position,
    },
    Completion {
        path: String,
        position: Position,
    },
    ResolveCompletion {
        item: Box<CompletionItem>,
    },
    SignatureHelp {
        path: String,
        position: Position,
    },
    Definition {
        path: String,
        position: Position,
    },
    Declaration {
        path: String,
        position: Position,
    },
    References {
        path: String,
        position: Position,
        #[serde(default)]
        include_declaration: bool,
    },
    Highlights {
        path: String,
        position: Position,
    },
    DocumentSymbols {
        path: String,
    },
    PrepareRename {
        path: String,
        position: Position,
    },
    /// Asks the server for the rename edit and plans it against the worktree. Nothing is written:
    /// the renderer previews the plan and applies it with `apply_script_rename`.
    Rename {
        path: String,
        position: Position,
        new_name: String,
    },
    WorkspaceSymbols {
        query: String,
    },
    /// Reads the diagnostics the server last published for one document. Monaco subscribes to
    /// them instead; this exists because a pull is the only way a caller without a channel — the
    /// AI agent — can read them at all.
    Diagnostics {
        path: String,
        #[serde(default)]
        timeout_ms: Option<u64>,
    },
}

/// The answer to one [`ScriptRequest`], tagged with the operation that produced it.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "op")]
pub enum ScriptResponse {
    Hover {
        hover: Option<Hover>,
    },
    Completion {
        items: Vec<CompletionItem>,
        is_incomplete: bool,
    },
    ResolveCompletion {
        item: Box<CompletionItem>,
    },
    SignatureHelp {
        signature_help: Option<SignatureHelp>,
    },
    /// Definition, declaration, and references all collapse to plain locations: Monaco takes the
    /// same shape for all three, and link responses carry no target Monaco can use for GDScript.
    Locations {
        locations: Vec<ScriptLocation>,
    },
    Highlights {
        highlights: Vec<DocumentHighlight>,
    },
    DocumentSymbols {
        symbols: DocumentSymbolResponse,
    },
    PrepareRename {
        #[serde(skip_serializing_if = "Option::is_none")]
        range: Option<Range>,
        #[serde(skip_serializing_if = "Option::is_none")]
        placeholder: Option<String>,
    },
    Rename {
        files: Vec<PlannedFile>,
    },
    WorkspaceSymbols {
        symbols: Vec<WorkspaceSymbol>,
    },
    Diagnostics {
        path: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        version: Option<i32>,
        diagnostics: Vec<Diagnostic>,
        /// False when the server published nothing for the document's current text within the
        /// timeout. An empty list with `published: true` is a clean file; with `published: false`
        /// it is an unanswered question, and the caller must ask again rather than report success.
        published: bool,
    },
}

/// A location the renderer can open: workspace-relative, because a `file://` URI would send
/// Monaco outside the worktree binding every other command enforces.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptLocation {
    pub path: String,
    pub range: Range,
}

struct Connection {
    key: String,
    client: Arc<LspClient>,
    workspace: Workspace,
}

struct DiagnosticsSubscription {
    stop: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}

impl DiagnosticsSubscription {
    fn stop(mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

static CONNECTION: Mutex<Option<Connection>> = Mutex::new(None);
static DIAGNOSTICS: Mutex<Option<DiagnosticsSubscription>> = Mutex::new(None);
/// The editor an acceptance test launched itself. The session supervisor starts a windowed
/// editor, which a headless gate cannot run, so the acceptance suite launches the pinned editor
/// with `--lsp-port --headless` and binds it here. Absent from every non-test build.
#[cfg(all(test, feature = "godot-acceptance"))]
static TEST_SESSION: Mutex<Option<(u16, String)>> = Mutex::new(None);

#[cfg(all(test, feature = "godot-acceptance"))]
pub fn bind_test_session(lsp_port: u16, worktree: &str) {
    disconnect();
    if let Ok(mut slot) = TEST_SESSION.lock() {
        *slot = Some((lsp_port, worktree.to_owned()));
    }
}

/// Opens a workspace file as an LSP document and returns its current contents. Re-opening a file
/// the renderer already holds re-synchronizes the server with what is on disk rather than
/// stacking a second document.
pub fn open_document(request: OpenScriptRequest) -> Result<ScriptDocument, LspError> {
    let (client, workspace) = connection()?;
    let contents = workspace.read(&request.path).map_err(file_error)?;
    let uri = godot_lsp::file_uri(&workspace, &request.path)?;
    let version = if client.is_open(&uri) {
        client.change_document(&uri, &contents.text)?
    } else {
        client.open_document(&uri, &contents.text)?
    };
    Ok(ScriptDocument {
        path: request.path,
        text: contents.text,
        hash: contents.hash,
        bytes: contents.bytes,
        version,
    })
}

/// Reports an in-memory buffer change. The server's document version is authoritative, so the
/// renderer never invents one and a stale buffer cannot answer a newer request.
pub fn update_document(request: UpdateScriptRequest) -> Result<ScriptStamp, LspError> {
    let (client, workspace) = connection()?;
    let uri = godot_lsp::file_uri(&workspace, &request.path)?;
    let version = client.change_document(&uri, &request.text)?;
    Ok(ScriptStamp {
        path: request.path,
        hash: None,
        bytes: None,
        version,
    })
}

/// Writes the buffer through the workspace transaction, then reports the save to the server with
/// the saved text. A file the renderer never opened is opened first, so the notification is legal.
pub fn save_document(request: SaveScriptRequest) -> Result<ScriptStamp, LspError> {
    let (client, workspace) = connection()?;
    let stamp = workspace
        .write(
            &request.path,
            &request.text,
            request.expected_hash.as_deref(),
        )
        .map_err(file_error)?;
    let uri = godot_lsp::file_uri(&workspace, &request.path)?;
    let version = if client.is_open(&uri) {
        client.change_document(&uri, &request.text)?
    } else {
        client.open_document(&uri, &request.text)?
    };
    client.save_document(&uri, &request.text)?;
    request_rescan(&request.path);
    Ok(ScriptStamp {
        path: request.path,
        hash: Some(stamp.hash),
        bytes: Some(stamp.bytes),
        version,
    })
}

/// Closes a document. A file the server does not hold open is not an error: the renderer closes
/// tabs after a session restart too.
pub fn close_document(request: OpenScriptRequest) -> Result<(), LspError> {
    let (client, workspace) = connection()?;
    let uri = godot_lsp::file_uri(&workspace, &request.path)?;
    if !client.is_open(&uri) {
        return Ok(());
    }
    client.close_document(&uri)
}

/// Answers one Monaco provider request.
pub fn call(request: ScriptRequest) -> Result<ScriptResponse, LspError> {
    let (client, workspace) = connection()?;
    match request {
        ScriptRequest::Hover { path, position } => {
            let uri = godot_lsp::file_uri(&workspace, &path)?;
            Ok(ScriptResponse::Hover {
                hover: client.hover(&uri, position)?,
            })
        }
        ScriptRequest::Completion { path, position } => {
            let uri = godot_lsp::file_uri(&workspace, &path)?;
            let (items, is_incomplete) = match client.completion(&uri, position)? {
                Some(CompletionResponse::Array(items)) => (items, false),
                Some(CompletionResponse::List(list)) => (list.items, list.is_incomplete),
                None => (Vec::new(), false),
            };
            Ok(ScriptResponse::Completion {
                items,
                is_incomplete,
            })
        }
        ScriptRequest::ResolveCompletion { item } => Ok(ScriptResponse::ResolveCompletion {
            item: Box::new(client.resolve_completion(&item)?),
        }),
        ScriptRequest::SignatureHelp { path, position } => {
            let uri = godot_lsp::file_uri(&workspace, &path)?;
            Ok(ScriptResponse::SignatureHelp {
                signature_help: client.signature_help(&uri, position)?,
            })
        }
        ScriptRequest::Definition { path, position } => {
            let uri = godot_lsp::file_uri(&workspace, &path)?;
            let response = client.definition(&uri, position)?;
            Ok(ScriptResponse::Locations {
                locations: to_locations(&workspace, response),
            })
        }
        ScriptRequest::Declaration { path, position } => {
            let uri = godot_lsp::file_uri(&workspace, &path)?;
            let response = client.declaration(&uri, position)?;
            Ok(ScriptResponse::Locations {
                locations: to_locations(&workspace, response),
            })
        }
        ScriptRequest::References {
            path,
            position,
            include_declaration,
        } => {
            let uri = godot_lsp::file_uri(&workspace, &path)?;
            let locations = client
                .references(&uri, position, include_declaration)?
                .unwrap_or_default();
            Ok(ScriptResponse::Locations {
                locations: workspace_locations(&workspace, locations),
            })
        }
        ScriptRequest::Highlights { path, position } => {
            let uri = godot_lsp::file_uri(&workspace, &path)?;
            Ok(ScriptResponse::Highlights {
                highlights: client
                    .document_highlight(&uri, position)?
                    .unwrap_or_default(),
            })
        }
        ScriptRequest::DocumentSymbols { path } => {
            let uri = godot_lsp::file_uri(&workspace, &path)?;
            Ok(ScriptResponse::DocumentSymbols {
                symbols: client
                    .document_symbols(&uri)?
                    .unwrap_or_else(|| DocumentSymbolResponse::Nested(Vec::new())),
            })
        }
        ScriptRequest::PrepareRename { path, position } => {
            let uri = godot_lsp::file_uri(&workspace, &path)?;
            Ok(prepare_rename_response(
                client.prepare_rename(&uri, position)?,
            ))
        }
        ScriptRequest::Rename {
            path,
            position,
            new_name,
        } => {
            let uri = godot_lsp::file_uri(&workspace, &path)?;
            let edit = client.rename(&uri, position, &new_name)?;
            Ok(ScriptResponse::Rename {
                files: godot_lsp::plan_workspace_edit(&workspace, &edit)?,
            })
        }
        ScriptRequest::WorkspaceSymbols { query } => Ok(ScriptResponse::WorkspaceSymbols {
            symbols: client.workspace_symbols(&workspace, &query)?,
        }),
        ScriptRequest::Diagnostics { path, timeout_ms } => {
            let uri = godot_lsp::file_uri(&workspace, &path)?;
            let wait = Duration::from_millis(
                timeout_ms
                    .unwrap_or(DEFAULT_DIAGNOSTICS_WAIT_MS)
                    .min(MAX_DIAGNOSTICS_WAIT_MS),
            );
            let published = client.diagnostics(&uri, wait)?;
            Ok(ScriptResponse::Diagnostics {
                path,
                version: published.as_ref().and_then(|published| published.version),
                published: published.is_some(),
                diagnostics: published
                    .map(|published| published.diagnostics)
                    .unwrap_or_default(),
            })
        }
    }
}

/// Applies a previously planned rename as one validated transaction, then re-synchronizes every
/// document the server still holds open so no buffer answers from pre-rename text.
pub fn apply_rename(request: ApplyRenameRequest) -> Result<Vec<ScriptStamp>, LspError> {
    let (client, workspace) = connection()?;
    let stamps = godot_lsp::commit_planned_edit(&workspace, &request.files)?;
    let mut result = Vec::with_capacity(stamps.len());
    for (file, stamp) in request.files.iter().zip(stamps) {
        let uri = godot_lsp::file_uri(&workspace, &file.path)?;
        let version = if client.is_open(&uri) {
            let version = client.change_document(&uri, &file.updated_text)?;
            client.save_document(&uri, &file.updated_text)?;
            version
        } else {
            0
        };
        request_rescan(&file.path);
        result.push(ScriptStamp {
            path: file.path.clone(),
            hash: Some(stamp.hash),
            bytes: Some(stamp.bytes),
            version,
        });
    }
    Ok(result)
}

/// Streams published diagnostics until the renderer unsubscribes or the session ends.
pub fn subscribe_diagnostics(
    channel: tauri::ipc::Channel<ScriptDiagnostics>,
) -> Result<(), LspError> {
    unsubscribe_diagnostics()?;
    let (client, workspace) = connection()?;
    let events = client.subscribe_diagnostics();
    let stop = Arc::new(AtomicBool::new(false));
    let flag = Arc::clone(&stop);
    let worker = thread::spawn(move || {
        while !flag.load(Ordering::Acquire) {
            match events.recv_timeout(DIAGNOSTICS_POLL_INTERVAL) {
                Ok(published) => {
                    // A file outside the worktree cannot be shown in the renderer, and its path
                    // would escape the binding every other command enforces, so it is dropped.
                    let Ok(path) = godot_lsp::relative_path(&workspace, &published.uri) else {
                        continue;
                    };
                    let _ = channel.send(ScriptDiagnostics {
                        path,
                        version: published.version,
                        diagnostics: published.diagnostics,
                    });
                }
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => break,
            }
        }
    });
    *DIAGNOSTICS.lock().map_err(|_| lock_poisoned())? = Some(DiagnosticsSubscription {
        stop,
        worker: Some(worker),
    });
    Ok(())
}

/// Stops the active diagnostics subscription, if any.
pub fn unsubscribe_diagnostics() -> Result<(), LspError> {
    if let Some(subscription) = DIAGNOSTICS.lock().map_err(|_| lock_poisoned())?.take() {
        subscription.stop();
    }
    Ok(())
}

/// Drops the cached language-server connection. The session supervisor calls this when a session
/// stops so the next script open reconnects instead of writing into a dead socket.
pub fn disconnect() {
    let _ = unsubscribe_diagnostics();
    let previous = CONNECTION.lock().ok().and_then(|mut slot| slot.take());
    if let Some(connection) = previous {
        connection.client.shutdown();
    }
}

/// Returns the connection for the active session, connecting on first use. A restarted editor
/// binds a new random RPC port, so the key changes and the stale client is shut down.
fn connection() -> Result<(Arc<LspClient>, Workspace), LspError> {
    let (lsp_port, worktree) = active_session().ok_or_else(|| {
        LspError::new(
            "session_not_active",
            "No Godot session is active, so no language server is reachable",
        )
        .retryable()
    })?;
    let key = format!("{lsp_port}|{worktree}");
    let mut slot = CONNECTION.lock().map_err(|_| lock_poisoned())?;
    if let Some(existing) = slot.as_ref()
        && existing.key == key
        && !existing.client.is_closed()
    {
        return Ok((Arc::clone(&existing.client), existing.workspace.clone()));
    }
    if let Some(previous) = slot.take() {
        previous.client.shutdown();
    }
    let workspace = Workspace::open(&PathBuf::from(&worktree)).map_err(file_error)?;
    let address = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), lsp_port);
    let client = Arc::new(LspClient::connect(address, workspace.root())?);
    *slot = Some(Connection {
        key,
        client: Arc::clone(&client),
        workspace: workspace.clone(),
    });
    Ok((client, workspace))
}

/// The editor the script commands bind to: the active session's language-server port and the
/// worktree it is bound to.
fn active_session() -> Option<(u16, String)> {
    #[cfg(all(test, feature = "godot-acceptance"))]
    if let Some(target) = TEST_SESSION.lock().ok().and_then(|slot| slot.clone()) {
        return Some(target);
    }
    godot_session::current_info().map(|info| (info.lsp_port, info.worktree))
}

/// Godot's own `didSave` handler reloads a script and refreshes its exports, so only other
/// resources need the editor filesystem told. Best effort: a save must not fail because the addon
/// is busy importing.
fn request_rescan(path: &str) {
    if path.ends_with(SCRIPT_EXTENSION) {
        return;
    }
    let Some(rpc) = godot_session::rpc_session() else {
        return;
    };
    let _ = rpc.call(CallRequest {
        id: format!("rescan-{path}"),
        command: "resource.rescan".to_owned(),
        params: json!({"path": path}),
        expected_revision: None,
        timeout_ms: None,
    });
}

fn prepare_rename_response(response: Option<PrepareRenameResponse>) -> ScriptResponse {
    match response {
        Some(PrepareRenameResponse::Range(range)) => ScriptResponse::PrepareRename {
            range: Some(range),
            placeholder: None,
        },
        Some(PrepareRenameResponse::RangeWithPlaceholder { range, placeholder }) => {
            ScriptResponse::PrepareRename {
                range: Some(range),
                placeholder: Some(placeholder),
            }
        }
        // `defaultBehavior` leaves the renamed span to the client; Monaco falls back to the word
        // at the cursor, which is exactly what an absent range asks it to do.
        Some(PrepareRenameResponse::DefaultBehavior { .. }) | None => {
            ScriptResponse::PrepareRename {
                range: None,
                placeholder: None,
            }
        }
    }
}

fn to_locations(
    workspace: &Workspace,
    response: Option<GotoDefinitionResponse>,
) -> Vec<ScriptLocation> {
    let locations = match response {
        Some(GotoDefinitionResponse::Scalar(location)) => vec![location],
        Some(GotoDefinitionResponse::Array(locations)) => locations,
        Some(GotoDefinitionResponse::Link(links)) => links
            .into_iter()
            .map(|link| Location {
                uri: link.target_uri,
                range: link.target_selection_range,
            })
            .collect(),
        None => Vec::new(),
    };
    workspace_locations(workspace, locations)
}

/// Keeps only the locations inside the task worktree. Godot answers with `res://` paths resolved
/// against the project it opened, so anything else is an engine-owned file the renderer cannot
/// open through the workspace commands.
fn workspace_locations(workspace: &Workspace, locations: Vec<Location>) -> Vec<ScriptLocation> {
    locations
        .into_iter()
        .filter_map(|location| {
            godot_lsp::relative_path(workspace, &location.uri)
                .ok()
                .map(|path| ScriptLocation {
                    path,
                    range: location.range,
                })
        })
        .collect()
}

/// Keeps the workspace's own code, so a stale save still reaches the renderer as `file_conflict`
/// rather than being flattened into a generic language-server failure.
fn file_error(error: FileError) -> LspError {
    LspError {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        details: error.details,
    }
}

fn lock_poisoned() -> LspError {
    LspError::new("lock_poisoned", "The script session lock is poisoned")
}

#[cfg(test)]
mod tests {
    use super::*;
    use lsp_types::{LocationLink, Position, Range, Url};
    use std::fs;

    fn workspace(root: &std::path::Path) -> Workspace {
        Workspace::open(root).expect("open workspace")
    }

    fn range(line: u32) -> Range {
        Range {
            start: Position { line, character: 0 },
            end: Position { line, character: 4 },
        }
    }

    #[test]
    fn definitions_outside_the_worktree_are_dropped() {
        let temporary = tempfile::tempdir().expect("temporary worktree");
        let workspace = workspace(temporary.path());
        fs::write(temporary.path().join("player.gd"), "extends Node\n").expect("write script");
        let inside = Url::from_file_path(temporary.path().join("player.gd")).expect("inside uri");
        let outside = Url::parse("file:///usr/share/godot/core.gd").expect("outside uri");

        let locations = to_locations(
            &workspace,
            Some(GotoDefinitionResponse::Array(vec![
                Location {
                    uri: inside,
                    range: range(2),
                },
                Location {
                    uri: outside,
                    range: range(9),
                },
            ])),
        );

        assert_eq!(
            locations,
            vec![ScriptLocation {
                path: "player.gd".to_owned(),
                range: range(2),
            }]
        );
    }

    #[test]
    fn definition_links_collapse_to_their_selection_range() {
        let temporary = tempfile::tempdir().expect("temporary worktree");
        let workspace = workspace(temporary.path());
        fs::write(temporary.path().join("player.gd"), "extends Node\n").expect("write script");
        let uri = Url::from_file_path(temporary.path().join("player.gd")).expect("uri");

        let locations = to_locations(
            &workspace,
            Some(GotoDefinitionResponse::Link(vec![LocationLink {
                origin_selection_range: None,
                target_uri: uri,
                target_range: range(0),
                target_selection_range: range(3),
            }])),
        );

        assert_eq!(
            locations,
            vec![ScriptLocation {
                path: "player.gd".to_owned(),
                range: range(3),
            }]
        );
    }

    #[test]
    fn missing_definitions_answer_with_no_locations() {
        let temporary = tempfile::tempdir().expect("temporary worktree");
        let workspace = workspace(temporary.path());

        assert!(to_locations(&workspace, None).is_empty());
    }

    #[test]
    fn prepare_rename_keeps_the_server_range_and_placeholder() {
        assert_eq!(
            prepare_rename_response(Some(PrepareRenameResponse::RangeWithPlaceholder {
                range: range(1),
                placeholder: "speed".to_owned(),
            })),
            ScriptResponse::PrepareRename {
                range: Some(range(1)),
                placeholder: Some("speed".to_owned()),
            }
        );
        assert_eq!(
            prepare_rename_response(Some(PrepareRenameResponse::Range(range(2)))),
            ScriptResponse::PrepareRename {
                range: Some(range(2)),
                placeholder: None,
            }
        );
    }

    #[test]
    fn default_rename_behavior_leaves_the_span_to_monaco() {
        assert_eq!(
            prepare_rename_response(Some(PrepareRenameResponse::DefaultBehavior {
                default_behavior: true,
            })),
            ScriptResponse::PrepareRename {
                range: None,
                placeholder: None,
            }
        );
        assert_eq!(
            prepare_rename_response(None),
            ScriptResponse::PrepareRename {
                range: None,
                placeholder: None,
            }
        );
    }

    #[test]
    fn language_requests_without_a_session_are_retryable() {
        disconnect();
        let error = call(ScriptRequest::WorkspaceSymbols {
            query: String::new(),
        })
        .expect_err("no session");

        assert_eq!(error.code, "session_not_active");
        assert!(error.retryable);
    }

    #[test]
    fn requests_are_tagged_by_operation() {
        let request: ScriptRequest = serde_json::from_value(json!({
            "op": "references",
            "path": "player.gd",
            "position": {"line": 3, "character": 7},
            "includeDeclaration": true,
        }))
        .expect("decode request");

        match request {
            ScriptRequest::References {
                path,
                position,
                include_declaration,
            } => {
                assert_eq!(path, "player.gd");
                assert_eq!(position.line, 3);
                assert!(include_declaration);
            }
            other => panic!("unexpected request: {other:?}"),
        }
    }

    #[test]
    fn responses_are_tagged_by_operation() {
        let response = ScriptResponse::Locations {
            locations: vec![ScriptLocation {
                path: "player.gd".to_owned(),
                range: range(4),
            }],
        };

        let encoded = serde_json::to_value(&response).expect("encode response");
        assert_eq!(encoded["op"], "locations");
        assert_eq!(encoded["locations"][0]["path"], "player.gd");
    }

    #[test]
    fn stamps_omit_hashes_for_in_memory_changes() {
        let encoded = serde_json::to_value(ScriptStamp {
            path: "player.gd".to_owned(),
            hash: None,
            bytes: None,
            version: 4,
        })
        .expect("encode stamp");

        assert_eq!(encoded, json!({"path": "player.gd", "version": 4}));
    }
}

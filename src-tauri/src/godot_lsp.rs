//! Client for Godot's native GDScript language server.
//!
//! The editor started by the session supervisor listens for LSP over loopback TCP on the port
//! passed through `--lsp-port`. This module owns that connection: Content-Length framing, request
//! correlation, cancellation, diagnostics broadcast, and the document lifecycle that Monaco and
//! the AI agent drive in later steps.
//!
//! Two Godot behaviors shape the design:
//!
//! - The server answers from the editor main loop: `network/language_server/use_thread` defaults
//!   to false and `poll_limit_usec` to 100 ms, so responsiveness tracks editor load. Timeouts are
//!   generous and every call site can widen them.
//! - Godot 4.7 reports `workspaceSymbolProvider: false`, so workspace-wide symbol search is
//!   synthesized here by indexing each script's document symbols through [`Workspace`].
//!
//! Public items are consumed by Tauri commands in later integration steps; the allow attribute
//! prevents cdylib/staticlib builds from treating them as dead code until those commands land.
#![allow(dead_code)]

use crate::files::{FileError, FileStamp, Workspace};
use lsp_types::{
    AnnotatedTextEdit, CompletionItem, CompletionResponse, DocumentChangeOperation,
    DocumentChanges, DocumentHighlight, DocumentSymbol, DocumentSymbolResponse,
    GotoDefinitionResponse, Hover, Location, OneOf, Position, PrepareRenameResponse,
    PublishDiagnosticsParams, Range, ServerCapabilities, SignatureHelp, SymbolKind, TextEdit, Url,
    WorkspaceEdit,
};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Shutdown, SocketAddr, TcpStream};
use std::path::{Component, Path};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

/// The server answers from the editor main loop in 100 ms poll slices, so a request's latency
/// tracks how busy the editor is. Thirty seconds is deliberate: a faster default would turn a
/// heavy import into a spurious failure.
pub const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// Initialization additionally waits out project import and plugin enablement.
pub const INITIALIZE_TIMEOUT: Duration = Duration::from_secs(60);
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_MESSAGE_BYTES: usize = 16 * 1024 * 1024;
const MAX_HEADER_LINES: usize = 32;
const LANGUAGE_ID: &str = "gdscript";
const LSP_REQUEST_CANCELLED: i64 = -32800;
/// How often a diagnostics pull re-checks the cache while it waits for a first publication.
const DIAGNOSTICS_POLL: Duration = Duration::from_millis(25);

/// A structured, actionable language-server failure.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LspError {
    pub code: &'static str,
    pub message: String,
    pub retryable: bool,
    pub details: Value,
}

impl LspError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            retryable: false,
            details: json!({}),
        }
    }

    pub fn retryable(mut self) -> Self {
        self.retryable = true;
        self
    }

    pub fn with_details(mut self, details: Value) -> Self {
        self.details = details;
        self
    }

    fn poisoned() -> Self {
        Self::new("lock_poisoned", "The LSP state lock is poisoned")
    }

    fn closed() -> Self {
        Self::new("session_closed", "The LSP session is closed")
    }
}

/// One file a [`WorkspaceEdit`] would change, with everything needed to apply it optimistically
/// and to roll it back. Produced by [`plan_workspace_edit`], applied by [`commit_planned_edit`].
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannedFile {
    pub path: String,
    pub original_text: String,
    pub original_hash: String,
    pub updated_text: String,
}

/// One workspace-wide symbol from the synthesized index. Godot does not implement
/// `workspace/symbol`, so Gofer flattens every script's document symbols into this shape.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSymbol {
    pub name: String,
    pub kind: SymbolKind,
    pub uri: Url,
    pub range: Range,
    pub container: Option<String>,
}

struct Shared {
    writer: TcpStream,
    pending: HashMap<u64, Sender<Result<Value, LspError>>>,
    diagnostics: Vec<Sender<PublishDiagnosticsParams>>,
    /// The last diagnostics published per document. Monaco subscribes and never needs this, but a
    /// pull is the only way an agent can read diagnostics: it has no channel to listen on, and a
    /// publication that arrived before it asked would otherwise be lost.
    published: HashMap<Url, PublishDiagnosticsParams>,
    closed: bool,
}

/// A connected GDScript language server session.
/// One open document, as this client last sent it. See [`LspClient::documents`].
#[derive(Clone)]
struct Document {
    version: i32,
    text: String,
}

pub struct LspClient {
    shared: Arc<Mutex<Shared>>,
    next_id: AtomicU64,
    reader: Mutex<Option<JoinHandle<()>>>,
    capabilities: ServerCapabilities,
    /// The open documents, each with the version and the text this client last sent for it.
    ///
    /// The text, because the buffer the server holds is not the file: the renderer pushes every
    /// debounced keystroke through `change_document`, so a document open in Gofer's editor is
    /// usually ahead of what is on disk. Anything that has to make the server read a document
    /// again — see `script::reparse_open_documents` — has to hand back *that* text, or it silently
    /// replaces what the user is typing with the last thing they saved.
    documents: Mutex<HashMap<Url, Document>>,
}

impl LspClient {
    /// Connects to a loopback language server and completes the initialize handshake rooted at
    /// `root` (the canonical worktree). Non-loopback transports are refused outright.
    pub fn connect(address: SocketAddr, root: &Path) -> Result<Self, LspError> {
        if !address.ip().is_loopback() {
            return Err(LspError::new(
                "transport_not_loopback",
                "The language server must be reached over loopback",
            )
            .with_details(json!({"address": address.to_string()})));
        }
        let stream = TcpStream::connect(address).map_err(|error| {
            LspError::new(
                "connect_failed",
                format!("Could not reach the language server at {address}: {error}"),
            )
            .retryable()
        })?;
        let _ = stream.set_write_timeout(Some(DEFAULT_REQUEST_TIMEOUT));
        let reader_stream = stream.try_clone().map_err(|error| {
            LspError::new(
                "connect_failed",
                format!("Could not clone the language server socket: {error}"),
            )
        })?;

        let shared = Arc::new(Mutex::new(Shared {
            writer: stream,
            pending: HashMap::new(),
            diagnostics: Vec::new(),
            published: HashMap::new(),
            closed: false,
        }));
        let reader = thread::spawn({
            let shared = Arc::clone(&shared);
            move || read_loop(BufReader::new(reader_stream), shared)
        });

        let mut client = Self {
            shared,
            next_id: AtomicU64::new(1),
            reader: Mutex::new(Some(reader)),
            capabilities: ServerCapabilities::default(),
            documents: Mutex::new(HashMap::new()),
        };

        let root_uri = Url::from_directory_path(root).map_err(|_| {
            LspError::new(
                "invalid_root",
                format!("{} cannot be expressed as a file URI", root.display()),
            )
        })?;
        let result = client.request_with_timeout(
            "initialize",
            json!({
                "processId": std::process::id(),
                "clientInfo": {"name": "gofer", "version": env!("CARGO_PKG_VERSION")},
                "rootUri": root_uri,
                "capabilities": {
                    "textDocument": {
                        "synchronization": {"didSave": true},
                        "publishDiagnostics": {},
                        "hover": {},
                        "completion": {
                            "completionItem": {"documentationFormat": ["plaintext", "markdown"]}
                        },
                        "signatureHelp": {},
                        "definition": {},
                        "declaration": {},
                        "references": {},
                        "documentHighlight": {},
                        "documentSymbol": {"hierarchicalDocumentSymbolSupport": true},
                        "rename": {"prepareSupport": true}
                    }
                },
                "workspaceFolders": [{"uri": root_uri, "name": "worktree"}]
            }),
            INITIALIZE_TIMEOUT,
        );
        let result = match result {
            Ok(result) => result,
            Err(error) => {
                client.close(LspError::closed());
                return Err(error);
            }
        };
        let capabilities = result
            .get("capabilities")
            .cloned()
            .and_then(|value| serde_json::from_value::<ServerCapabilities>(value).ok());
        let Some(capabilities) = capabilities else {
            client.close(LspError::closed());
            return Err(LspError::new(
                "invalid_response",
                "The language server answered initialize without capabilities",
            ));
        };
        client.capabilities = capabilities;
        client.notify("initialized", json!({}))?;
        Ok(client)
    }

    /// The capabilities the server reported during initialize.
    pub fn server_capabilities(&self) -> &ServerCapabilities {
        &self.capabilities
    }

    /// Whether the transport has been closed — by `shutdown`, by a dead editor, or by a framing
    /// failure. The renderer's script bridge reconnects instead of reusing a dead client.
    pub fn is_closed(&self) -> bool {
        self.shared
            .lock()
            .map(|shared| shared.closed)
            .unwrap_or(true)
    }

    /// Whether this client currently holds the document open.
    pub fn is_open(&self, uri: &Url) -> bool {
        self.documents
            .lock()
            .map(|documents| documents.contains_key(uri))
            .unwrap_or(false)
    }

    /// Opens a document at version 1, or bumps the version of one already open.
    pub fn open_document(&self, uri: &Url, text: &str) -> Result<i32, LspError> {
        let version = {
            let mut documents = self.documents.lock().map_err(|_| LspError::poisoned())?;
            let held = documents.entry(uri.clone()).or_insert(Document {
                version: 0,
                text: String::new(),
            });
            held.version += 1;
            held.text = text.to_owned();
            held.version
        };
        self.invalidate_diagnostics(uri);
        self.notify(
            "textDocument/didOpen",
            json!({"textDocument": {"uri": uri, "languageId": LANGUAGE_ID, "version": version, "text": text}}),
        )?;
        Ok(version)
    }

    /// Replaces the whole document text. Godot's server only supports full synchronization.
    pub fn change_document(&self, uri: &Url, text: &str) -> Result<i32, LspError> {
        let version = {
            let mut documents = self.documents.lock().map_err(|_| LspError::poisoned())?;
            let Some(held) = documents.get_mut(uri) else {
                return Err(LspError::new(
                    "document_not_open",
                    "The document is not open in this LSP session",
                ));
            };
            held.version += 1;
            held.text = text.to_owned();
            held.version
        };
        self.invalidate_diagnostics(uri);
        self.notify(
            "textDocument/didChange",
            json!({
                "textDocument": {"uri": uri, "version": version},
                "contentChanges": [{"text": text}]
            }),
        )?;
        Ok(version)
    }

    /// Reports a save. The text rides along because Godot's didSave handler reads `text` from the
    /// parameters; without it the server would reload stale content from disk.
    pub fn save_document(&self, uri: &Url, text: &str) -> Result<(), LspError> {
        if !self.is_open(uri) {
            return Err(LspError::new(
                "document_not_open",
                "The document is not open in this LSP session",
            ));
        }
        self.invalidate_diagnostics(uri);
        self.notify(
            "textDocument/didSave",
            json!({"textDocument": {"uri": uri}, "text": text}),
        )
    }

    /// Every open document with the text this client last sent for it, so a caller that has
    /// changed something *outside* the documents can ask the server to read them again.
    ///
    /// The text rather than the path, because the file is not what the server holds: a document
    /// open in Gofer's editor carries every keystroke since the last save. See
    /// `script::reparse_open_documents`.
    pub fn open_documents(&self) -> Vec<(Url, String)> {
        self.documents
            .lock()
            .map(|documents| {
                documents
                    .iter()
                    .map(|(uri, held)| (uri.clone(), held.text.clone()))
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Forgets the cached diagnostics of a document whose text just changed, so the next pull
    /// waits for the server's verdict on the new text instead of repeating the old one.
    fn invalidate_diagnostics(&self, uri: &Url) {
        if let Ok(mut shared) = self.shared.lock() {
            shared.published.remove(uri);
        }
    }

    pub fn close_document(&self, uri: &Url) -> Result<(), LspError> {
        {
            let mut documents = self.documents.lock().map_err(|_| LspError::poisoned())?;
            if documents.remove(uri).is_none() {
                return Err(LspError::new(
                    "document_not_open",
                    "The document is not open in this LSP session",
                ));
            }
        }
        self.notify(
            "textDocument/didClose",
            json!({"textDocument": {"uri": uri}}),
        )
    }

    /// Subscribes to `textDocument/publishDiagnostics` notifications.
    pub fn subscribe_diagnostics(&self) -> Receiver<PublishDiagnosticsParams> {
        let (sender, receiver) = channel();
        if let Ok(mut shared) = self.shared.lock() {
            shared.diagnostics.push(sender);
        }
        receiver
    }

    /// Reads the diagnostics the server published for the document's current text, waiting up to
    /// `timeout` for them. `None` means the server said nothing in time — which is not the same as
    /// a clean file, because Godot publishes an empty list for that.
    pub fn diagnostics(
        &self,
        uri: &Url,
        timeout: Duration,
    ) -> Result<Option<PublishDiagnosticsParams>, LspError> {
        let deadline = Instant::now() + timeout;
        loop {
            {
                let shared = self.shared.lock().map_err(|_| LspError::poisoned())?;
                if let Some(published) = shared.published.get(uri) {
                    return Ok(Some(published.clone()));
                }
                if shared.closed {
                    return Err(LspError::closed());
                }
            }
            // Nothing published yet is a legitimate answer, so a stopped turn ends the wait the
            // same way its deadline would rather than failing the call.
            if Instant::now() >= deadline || crate::cancel::is_cancelled() {
                return Ok(None);
            }
            thread::sleep(DIAGNOSTICS_POLL);
        }
    }

    pub fn hover(&self, uri: &Url, position: Position) -> Result<Option<Hover>, LspError> {
        self.request("textDocument/hover", position_params(uri, position))
    }

    pub fn completion(
        &self,
        uri: &Url,
        position: Position,
    ) -> Result<Option<CompletionResponse>, LspError> {
        self.request("textDocument/completion", position_params(uri, position))
    }

    pub fn resolve_completion(&self, item: &CompletionItem) -> Result<CompletionItem, LspError> {
        let params = serde_json::to_value(item)
            .map_err(|error| LspError::new("serialize_failed", format!("{error}")))?;
        self.request("completionItem/resolve", params)
    }

    pub fn signature_help(
        &self,
        uri: &Url,
        position: Position,
    ) -> Result<Option<SignatureHelp>, LspError> {
        self.request("textDocument/signatureHelp", position_params(uri, position))
    }

    pub fn definition(
        &self,
        uri: &Url,
        position: Position,
    ) -> Result<Option<GotoDefinitionResponse>, LspError> {
        self.request("textDocument/definition", position_params(uri, position))
    }

    pub fn declaration(
        &self,
        uri: &Url,
        position: Position,
    ) -> Result<Option<GotoDefinitionResponse>, LspError> {
        self.request("textDocument/declaration", position_params(uri, position))
    }

    pub fn references(
        &self,
        uri: &Url,
        position: Position,
        include_declaration: bool,
    ) -> Result<Option<Vec<Location>>, LspError> {
        let mut params = position_params(uri, position);
        params["context"] = json!({"includeDeclaration": include_declaration});
        self.request("textDocument/references", params)
    }

    pub fn document_highlight(
        &self,
        uri: &Url,
        position: Position,
    ) -> Result<Option<Vec<DocumentHighlight>>, LspError> {
        self.request(
            "textDocument/documentHighlight",
            position_params(uri, position),
        )
    }

    pub fn document_symbols(&self, uri: &Url) -> Result<Option<DocumentSymbolResponse>, LspError> {
        self.request(
            "textDocument/documentSymbol",
            json!({"textDocument": {"uri": uri}}),
        )
    }

    pub fn prepare_rename(
        &self,
        uri: &Url,
        position: Position,
    ) -> Result<Option<PrepareRenameResponse>, LspError> {
        self.request("textDocument/prepareRename", position_params(uri, position))
    }

    /// Asks the server for the rename edit without applying it. Apply the result through
    /// [`plan_workspace_edit`] and [`commit_planned_edit`] so multi-file renames stay one
    /// validated filesystem transaction.
    pub fn rename(
        &self,
        uri: &Url,
        position: Position,
        new_name: &str,
    ) -> Result<WorkspaceEdit, LspError> {
        let mut params = position_params(uri, position);
        params["newName"] = json!(new_name);
        let result: Value = self.request("textDocument/rename", params)?;
        if result.is_null() {
            return Ok(WorkspaceEdit::default());
        }
        serde_json::from_value(result).map_err(|error| {
            LspError::new(
                "invalid_response",
                format!("The rename answer is not a workspace edit: {error}"),
            )
        })
    }

    /// Synthesizes `workspace/symbol`, which Godot 4.7 does not implement: every `.gd` file in
    /// the worktree is opened, indexed through `textDocument/documentSymbol`, and closed again
    /// (documents the caller already opened stay open). An empty query returns every symbol.
    pub fn workspace_symbols(
        &self,
        workspace: &Workspace,
        query: &str,
    ) -> Result<Vec<WorkspaceSymbol>, LspError> {
        let snapshot = crate::files::scan(workspace.root());
        let mut symbols = Vec::new();
        for path in snapshot.keys().filter(|path| path.ends_with(".gd")) {
            let contents = workspace.read(path).map_err(file_error)?;
            let uri = file_uri(workspace, path)?;
            let already_open = self.is_open(&uri);
            if !already_open {
                self.open_document(&uri, &contents.text)?;
            }
            let response = self.document_symbols(&uri);
            if !already_open {
                self.close_document(&uri)?;
            }
            if let Some(response) = response? {
                match response {
                    DocumentSymbolResponse::Nested(items) => {
                        flatten_nested(&mut symbols, &uri, &items, None);
                    }
                    DocumentSymbolResponse::Flat(items) => {
                        for item in items {
                            symbols.push(WorkspaceSymbol {
                                name: item.name,
                                kind: item.kind,
                                uri: item.location.uri,
                                range: item.location.range,
                                container: item.container_name,
                            });
                        }
                    }
                }
            }
        }
        let query = query.to_lowercase();
        if !query.is_empty() {
            symbols.retain(|symbol| symbol.name.to_lowercase().contains(&query));
        }
        Ok(symbols)
    }

    /// Registers a request, writes it, and returns its id plus the response receiver. Split from
    /// [`Self::await_response`] so callers can overlap requests or cancel them.
    pub fn start_request(
        &self,
        method: &str,
        params: Value,
    ) -> Result<(u64, Receiver<Result<Value, LspError>>), LspError> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = channel();
        let mut shared = self.lock_shared()?;
        if shared.closed {
            return Err(LspError::closed());
        }
        shared.pending.insert(id, sender);
        let message = json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params});
        if let Err(error) = write_message(&mut shared.writer, &message) {
            shared.pending.remove(&id);
            return Err(error);
        }
        Ok((id, receiver))
    }

    /// Waits for the response to a request made with [`Self::start_request`]. A late response
    /// after a timeout is dropped by the reader, which no longer finds a pending entry.
    pub fn await_response(
        &self,
        id: u64,
        receiver: &Receiver<Result<Value, LspError>>,
        timeout: Duration,
    ) -> Result<Value, LspError> {
        match crate::cancel::recv_until(receiver, Instant::now() + timeout) {
            Ok(result) => result,
            Err(end) => {
                if let Ok(mut shared) = self.shared.lock() {
                    shared.pending.remove(&id);
                }
                Err(match end {
                    crate::cancel::WaitEnd::Cancelled => LspError::new(
                        "cancelled",
                        "The language server request was stopped with its agent turn",
                    ),
                    _ => LspError::new(
                        "request_timeout",
                        format!("The language server did not answer within {timeout:?}"),
                    )
                    .retryable(),
                })
            }
        }
    }

    /// Cancels a request started with [`Self::start_request`]: the waiter fails with `cancelled`
    /// and the server receives `$/cancelRequest`. A response that still arrives is ignored.
    pub fn cancel(&self, id: u64) -> Result<(), LspError> {
        let mut shared = self.lock_shared()?;
        let Some(pending) = shared.pending.remove(&id) else {
            return Ok(());
        };
        let _ = pending.send(Err(LspError::new(
            "cancelled",
            "The request was cancelled by the client",
        )));
        let message = json!({"jsonrpc": "2.0", "method": "$/cancelRequest", "params": {"id": id}});
        write_message(&mut shared.writer, &message)
    }

    fn request<R: DeserializeOwned>(&self, method: &str, params: Value) -> Result<R, LspError> {
        let value = self.request_with_timeout(method, params, DEFAULT_REQUEST_TIMEOUT)?;
        serde_json::from_value(value).map_err(|error| {
            LspError::new(
                "invalid_response",
                format!("The answer to {method} did not match the protocol: {error}"),
            )
        })
    }

    fn request_with_timeout(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, LspError> {
        let (id, receiver) = self.start_request(method, params)?;
        self.await_response(id, &receiver, timeout)
    }

    fn notify(&self, method: &str, params: Value) -> Result<(), LspError> {
        let mut shared = self.lock_shared()?;
        if shared.closed {
            return Err(LspError::closed());
        }
        let message = json!({"jsonrpc": "2.0", "method": method, "params": params});
        write_message(&mut shared.writer, &message)
    }

    fn lock_shared(&self) -> Result<MutexGuard<'_, Shared>, LspError> {
        self.shared.lock().map_err(|_| LspError::poisoned())
    }

    /// Shuts the session down the way the protocol expects — `shutdown`, then `exit` — and closes
    /// the transport. Repeated calls are no-ops.
    pub fn shutdown(&self) {
        if self
            .shared
            .lock()
            .map(|shared| shared.closed)
            .unwrap_or(true)
        {
            return;
        }
        let _ = self.request_with_timeout("shutdown", Value::Null, SHUTDOWN_TIMEOUT);
        let _ = self.notify("exit", Value::Null);
        self.close(LspError::closed());
    }

    fn close(&self, error: LspError) {
        {
            let Ok(mut shared) = self.shared.lock() else {
                return;
            };
            shared.closed = true;
            fail_pending(&mut shared, error);
            let _ = shared.writer.shutdown(Shutdown::Both);
        }
        if let Ok(mut reader) = self.reader.lock()
            && let Some(handle) = reader.take()
        {
            let _ = handle.join();
        }
    }
}

impl Drop for LspClient {
    fn drop(&mut self) {
        // Best effort only: the editor may already be dead, so no shutdown handshake here.
        self.close(LspError::closed());
    }
}

/// Resolves a workspace-relative path to the `file://` URI the language server expects.
pub fn file_uri(workspace: &Workspace, relative: &str) -> Result<Url, LspError> {
    let path = workspace.resolve(relative).map_err(file_error)?;
    Url::from_file_path(&path).map_err(|_| {
        LspError::new(
            "invalid_uri",
            format!("{} cannot be expressed as a file URI", path.display()),
        )
    })
}

/// Reads every file a [`WorkspaceEdit`] touches, applies the edits in memory, and returns the
/// plan. Nothing is written: [`commit_planned_edit`] performs the validated transaction, so a
/// rename that cannot apply leaves every buffer untouched.
pub fn plan_workspace_edit(
    workspace: &Workspace,
    edit: &WorkspaceEdit,
) -> Result<Vec<PlannedFile>, LspError> {
    // `documentChanges` wins outright when the server sends both: the protocol says so, and
    // merging the two would plan the same file twice and fail its own concurrency check.
    let mut changes: Vec<(Url, Vec<TextEdit>)> = Vec::new();
    match &edit.document_changes {
        Some(DocumentChanges::Edits(edits)) => {
            for text in edits {
                changes.push((text.text_document.uri.clone(), text_edits(&text.edits)));
            }
        }
        Some(DocumentChanges::Operations(operations)) => {
            for operation in operations {
                match operation {
                    DocumentChangeOperation::Edit(text) => {
                        changes.push((text.text_document.uri.clone(), text_edits(&text.edits)));
                    }
                    // File creation, rename, and deletion have no typed counterpart in the
                    // workspace transaction yet, so they are refused rather than half-applied.
                    DocumentChangeOperation::Op(_) => {
                        return Err(unsupported_resource_operations());
                    }
                }
            }
        }
        None => {
            if let Some(map) = &edit.changes {
                for (uri, edits) in map {
                    changes.push((uri.clone(), edits.clone()));
                }
            }
        }
    }

    let mut planned: Vec<PlannedFile> = Vec::with_capacity(changes.len());
    for (uri, mut edits) in changes {
        let relative = relative_path(workspace, &uri)?;
        // Two entries for one file would each claim the pre-edit hash, so the second write would
        // lose to the first and roll the whole rename back. Refuse it while it is still explicable.
        if planned.iter().any(|file| file.path == relative) {
            return Err(
                LspError::new("duplicate_edit_target", "The edit names one file twice")
                    .with_details(json!({"path": relative})),
            );
        }
        let contents = workspace.read(&relative).map_err(file_error)?;
        // Apply right-to-left so earlier offsets stay valid as later text shifts.
        edits.sort_by(|a, b| {
            (b.range.start.line, b.range.start.character)
                .cmp(&(a.range.start.line, a.range.start.character))
        });
        let mut spans = Vec::with_capacity(edits.len());
        for edit in &edits {
            let start = byte_offset(&contents.text, edit.range.start)?;
            let end = byte_offset(&contents.text, edit.range.end)?;
            if start > end {
                return Err(
                    LspError::new("invalid_range", "An edit range ends before it starts")
                        .with_details(json!({"path": relative, "range": edit.range})),
                );
            }
            spans.push((start, end, edit.new_text.as_str()));
        }
        for window in spans.windows(2) {
            if window[0].0 < window[1].1 {
                return Err(LspError::new(
                    "overlapping_edits",
                    "The server returned overlapping edits",
                )
                .with_details(json!({"path": relative})));
            }
        }
        let mut text = contents.text.clone();
        for (start, end, new_text) in &spans {
            text.replace_range(start..end, new_text);
        }
        planned.push(PlannedFile {
            path: relative,
            original_text: contents.text,
            original_hash: contents.hash,
            updated_text: text,
        });
    }
    planned.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(planned)
}

/// Applies a plan through the workspace's optimistic-concurrency writes. If any file conflicts,
/// every file written so far is restored, so a failed multi-file rename never leaves the tree
/// half-renamed.
pub fn commit_planned_edit(
    workspace: &Workspace,
    planned: &[PlannedFile],
) -> Result<Vec<FileStamp>, LspError> {
    let mut applied: Vec<(&PlannedFile, FileStamp)> = Vec::with_capacity(planned.len());
    for file in planned {
        match workspace.write(&file.path, &file.updated_text, Some(&file.original_hash)) {
            Ok(stamp) => applied.push((file, stamp)),
            Err(error) => {
                let mut rolled_back = true;
                for (done, stamp) in applied.iter().rev() {
                    if workspace
                        .write(&done.path, &done.original_text, Some(&stamp.hash))
                        .is_err()
                    {
                        rolled_back = false;
                    }
                }
                return Err(LspError::new(
                    "edit_apply_failed",
                    format!("The edit could not be applied: {}", error.message),
                )
                .with_details(json!({
                    "path": file.path,
                    "cause": error,
                    "rolledBack": rolled_back,
                })));
            }
        }
    }
    Ok(applied.into_iter().map(|(_, stamp)| stamp).collect())
}

/// Maps an LSP position (line plus UTF-16 code units) onto a byte offset. Godot scripts are
/// UTF-8, and astral characters occupy two code units, so a naive char count corrupts offsets.
fn byte_offset(text: &str, position: Position) -> Result<usize, LspError> {
    let mut line_start = 0usize;
    for _ in 0..position.line {
        let Some(newline) = text[line_start..].find('\n') else {
            return Err(position_out_of_range(text, position));
        };
        line_start += newline + 1;
    }
    let line_end = text[line_start..]
        .find('\n')
        .map(|index| line_start + index)
        .unwrap_or(text.len());
    let line = &text[line_start..line_end];
    let mut units = 0u32;
    for (index, character) in line.char_indices() {
        if units == position.character {
            return Ok(line_start + index);
        }
        units += character.len_utf16() as u32;
        if units > position.character {
            return Err(position_out_of_range(text, position));
        }
    }
    if units == position.character {
        return Ok(line_end);
    }
    Err(position_out_of_range(text, position))
}

fn position_out_of_range(text: &str, position: Position) -> LspError {
    LspError::new(
        "position_out_of_range",
        format!(
            "Position {}:{} does not exist in the document",
            position.line, position.character
        ),
    )
    .with_details(json!({"position": position, "bytes": text.len()}))
}

pub fn relative_path(workspace: &Workspace, uri: &Url) -> Result<String, LspError> {
    let path = uri.to_file_path().map_err(|_| {
        LspError::new("invalid_uri", format!("{uri} is not a file URI"))
            .with_details(json!({"uri": uri.as_str()}))
    })?;
    let relative = path.strip_prefix(workspace.root()).map_err(|_| {
        LspError::new(
            "path_outside_workspace",
            "The edit targets a file outside the task worktree",
        )
        .with_details(json!({"uri": uri.as_str()}))
    })?;
    let mut label = String::new();
    for component in relative.components() {
        let Component::Normal(part) = component else {
            return Err(LspError::new(
                "path_outside_workspace",
                "The edit targets a file outside the task worktree",
            )
            .with_details(json!({"uri": uri.as_str()})));
        };
        if !label.is_empty() {
            label.push('/');
        }
        label.push_str(&part.to_string_lossy());
    }
    if label.is_empty() {
        return Err(
            LspError::new("invalid_uri", format!("{uri} names the worktree root"))
                .with_details(json!({"uri": uri.as_str()})),
        );
    }
    Ok(label)
}

/// Drops the change annotations Gofer has no use for, leaving plain text edits.
fn text_edits(edits: &[OneOf<TextEdit, AnnotatedTextEdit>]) -> Vec<TextEdit> {
    edits
        .iter()
        .map(|edit| match edit {
            OneOf::Left(edit) => edit.clone(),
            OneOf::Right(annotated) => annotated.text_edit.clone(),
        })
        .collect()
}

fn flatten_nested(
    symbols: &mut Vec<WorkspaceSymbol>,
    uri: &Url,
    items: &[DocumentSymbol],
    container: Option<&str>,
) {
    for item in items {
        symbols.push(WorkspaceSymbol {
            name: item.name.clone(),
            kind: item.kind,
            uri: uri.clone(),
            range: item.range,
            container: container.map(str::to_owned),
        });
        if let Some(children) = &item.children {
            flatten_nested(symbols, uri, children, Some(&item.name));
        }
    }
}

fn position_params(uri: &Url, position: Position) -> Value {
    json!({"textDocument": {"uri": uri}, "position": position})
}

fn unsupported_resource_operations() -> LspError {
    LspError::new(
        "unsupported_resource_operations",
        "The edit creates, renames, or deletes files; only text edits are supported",
    )
}

fn file_error(error: FileError) -> LspError {
    LspError {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        details: error.details,
    }
}

fn read_loop(reader: BufReader<TcpStream>, shared: Arc<Mutex<Shared>>) {
    let mut reader = reader;
    let mut failure = None;
    loop {
        match read_message(&mut reader) {
            Ok(Some(message)) => dispatch(&shared, message),
            Ok(None) => break,
            Err(error) => {
                failure = Some(error);
                break;
            }
        }
    }
    let error = failure.unwrap_or_else(|| {
        LspError::new(
            "transport_closed",
            "The language server closed the connection",
        )
        .retryable()
    });
    if let Ok(mut shared) = shared.lock() {
        shared.closed = true;
        fail_pending(&mut shared, error);
    }
}

/// Rewrites every file URI in a server message into the spelling [`file_uri`] produces.
///
/// Godot builds its URIs by percent-encoding each path segment on its own, and its encoder keeps
/// only the unreserved characters. A Windows drive letter therefore arrives as `file:///C%3A/…`
/// where `Url::from_file_path` writes `file:///C:/…`. The two name one file and compare unequal,
/// and `Url` equality is what routes a published diagnostic to its document and what a navigation
/// answer is checked against — so on Windows every diagnostic and every jump silently missed.
/// Round-tripping through the platform's path type settles the spelling once, at the edge, so
/// nothing downstream has to know that two of them exist. Elsewhere the round trip is an identity.
fn normalize_uris(value: &mut Value) {
    match value {
        Value::Object(map) => {
            for (key, child) in map.iter_mut() {
                if matches!(key.as_str(), "uri" | "targetUri")
                    && let Some(text) = child.as_str()
                    && let Some(normalized) = normalized_file_uri(text)
                {
                    *child = Value::String(normalized);
                } else {
                    normalize_uris(child);
                }
            }
        }
        Value::Array(items) => items.iter_mut().for_each(normalize_uris),
        _ => {}
    }
}

/// The canonical spelling of a `file://` URI, or `None` for anything this client cannot turn into
/// a local path — a non-file scheme, or a URI naming a file on another host — which is left alone
/// for the call site that rejects it to report.
fn normalized_file_uri(text: &str) -> Option<String> {
    let uri = Url::parse(text).ok()?;
    if uri.scheme() != "file" {
        return None;
    }
    let path = uri.to_file_path().ok()?;
    Some(Url::from_file_path(path).ok()?.into())
}

fn dispatch(shared: &Arc<Mutex<Shared>>, message: Value) {
    let mut message = message;
    normalize_uris(&mut message);
    let method = message.get("method").and_then(Value::as_str);
    let id = message.get("id").cloned();
    match (method, id) {
        (Some("textDocument/publishDiagnostics"), _) => {
            let Some(params) = message.get("params").cloned() else {
                return;
            };
            let Ok(params) = serde_json::from_value::<PublishDiagnosticsParams>(params) else {
                return;
            };
            if let Ok(mut shared) = shared.lock() {
                shared.published.insert(params.uri.clone(), params.clone());
                shared
                    .diagnostics
                    .retain(|sender| sender.send(params.clone()).is_ok());
            }
        }
        // A server-to-client request (e.g. workspace/configuration) gets an empty result rather
        // than silence: some servers wait on the reply before answering anything else.
        (Some(_), Some(id)) => {
            if let Ok(mut shared) = shared.lock() {
                let reply = json!({"jsonrpc": "2.0", "id": id, "result": Value::Null});
                let _ = write_message(&mut shared.writer, &reply);
            }
        }
        (Some(_), None) => {}
        (None, Some(id)) => {
            let Some(id) = id.as_u64() else {
                return;
            };
            let Ok(mut shared) = shared.lock() else {
                return;
            };
            let Some(pending) = shared.pending.remove(&id) else {
                // A response to a timed-out or cancelled request: expected, not an error.
                return;
            };
            if let Some(error) = message.get("error") {
                let _ = pending.send(Err(server_error(error)));
            } else {
                let result = message.get("result").cloned().unwrap_or(Value::Null);
                let _ = pending.send(Ok(result));
            }
        }
        (None, None) => {}
    }
}

fn server_error(error: &Value) -> LspError {
    let code = error.get("code").and_then(Value::as_i64).unwrap_or(0);
    let message = error
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("The language server reported an error")
        .to_owned();
    if code == LSP_REQUEST_CANCELLED {
        return LspError::new("cancelled", message);
    }
    LspError::new("lsp_server_error", message).with_details(json!({
        "serverCode": code,
        "data": error.get("data").cloned().unwrap_or(Value::Null),
    }))
}

fn fail_pending(shared: &mut Shared, error: LspError) {
    for (_, pending) in std::mem::take(&mut shared.pending) {
        let _ = pending.send(Err(error.clone()));
    }
}

fn read_message(reader: &mut BufReader<TcpStream>) -> Result<Option<Value>, LspError> {
    let mut content_length = None;
    for _ in 0..MAX_HEADER_LINES {
        let mut line = String::new();
        let bytes = reader.read_line(&mut line).map_err(|error| {
            LspError::new(
                "transport_failed",
                format!("Could not read from the language server: {error}"),
            )
            .retryable()
        })?;
        if bytes == 0 {
            return Ok(None);
        }
        let line = line.trim_end();
        if line.is_empty() {
            if content_length.is_some() {
                break;
            }
            continue;
        }
        if let Some((name, value)) = line.split_once(':')
            && name.trim().eq_ignore_ascii_case("content-length")
        {
            content_length = value.trim().parse::<usize>().ok();
        }
    }
    let length = content_length.ok_or_else(|| {
        LspError::new(
            "invalid_frame",
            "The language server sent a message without a Content-Length header",
        )
    })?;
    if length == 0 || length > MAX_MESSAGE_BYTES {
        return Err(LspError::new(
            "payload_too_large",
            format!("The language server message is {length} bytes"),
        ));
    }
    let mut body = vec![0u8; length];
    reader.read_exact(&mut body).map_err(|error| {
        LspError::new(
            "transport_failed",
            format!("Could not read the language server message: {error}"),
        )
        .retryable()
    })?;
    serde_json::from_slice(&body).map(Some).map_err(|error| {
        LspError::new("invalid_frame", format!("The message is not JSON: {error}"))
    })
}

fn write_message(writer: &mut TcpStream, message: &Value) -> Result<(), LspError> {
    let body = serde_json::to_vec(message)
        .map_err(|error| LspError::new("serialize_failed", format!("{error}")))?;
    let header = format!("Content-Length: {}\r\n\r\n", body.len());
    writer
        .write_all(header.as_bytes())
        .and_then(|()| writer.write_all(&body))
        .and_then(|()| writer.flush())
        .map_err(|error| {
            LspError::new(
                "transport_failed",
                format!("Could not write to the language server: {error}"),
            )
            .retryable()
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use lsp_types::HoverContents;
    use std::net::TcpListener;
    use std::sync::atomic::AtomicBool;
    use std::sync::mpsc::Receiver as MpscReceiver;
    use std::time::{Duration, Instant};
    use tempfile::TempDir;

    /// What the fake server does with one incoming request.
    enum FakeAction {
        Result(Value),
        Error(i64, &'static str),
        Ignore,
    }

    struct FakeServer {
        address: SocketAddr,
        received: MpscReceiver<Value>,
        join: JoinHandle<()>,
    }

    /// Runs a loopback JSON-RPC server that records every message and answers requests through
    /// `handler`. The handler also receives the writer so it can push notifications unprompted.
    fn start_fake_server<F>(mut handler: F) -> FakeServer
    where
        F: FnMut(&Value, &mut TcpStream) -> FakeAction + Send + 'static,
    {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind fake server");
        let address = listener.local_addr().expect("fake server address");
        let (sender, receiver) = channel();
        let join = thread::spawn(move || {
            let (stream, _) = listener.accept().expect("accept client");
            let mut reader = BufReader::new(stream.try_clone().expect("clone stream"));
            let mut writer = stream;
            while let Ok(Some(message)) = read_message(&mut reader) {
                let _ = sender.send(message.clone());
                if message.get("method").and_then(Value::as_str) == Some("exit") {
                    break;
                }
                let is_request = message.get("id").is_some() && message.get("method").is_some();
                match handler(&message, &mut writer) {
                    FakeAction::Result(result) if is_request => {
                        let reply =
                            json!({"jsonrpc": "2.0", "id": message["id"], "result": result});
                        write_message(&mut writer, &reply).expect("write reply");
                    }
                    FakeAction::Error(code, text) if is_request => {
                        let reply = json!({
                            "jsonrpc": "2.0",
                            "id": message["id"],
                            "error": {"code": code, "message": text}
                        });
                        write_message(&mut writer, &reply).expect("write error reply");
                    }
                    _ => {}
                }
            }
        });
        FakeServer {
            address,
            received: receiver,
            join,
        }
    }

    /// A handler that answers initialize and shutdown with canned results and ignores the rest.
    fn handshake_handler(message: &Value, _writer: &mut TcpStream) -> FakeAction {
        match message.get("method").and_then(Value::as_str) {
            Some("initialize") => FakeAction::Result(json!({
                "capabilities": {"hoverProvider": true, "workspaceSymbolProvider": false},
                "serverInfo": {"name": "fake-godot"}
            })),
            Some("shutdown") => FakeAction::Result(Value::Null),
            _ => FakeAction::Ignore,
        }
    }

    fn workspace() -> (TempDir, Workspace) {
        let directory = TempDir::new().expect("temporary directory");
        let workspace = Workspace::open(directory.path()).expect("open workspace");
        (directory, workspace)
    }

    fn recv_recorded(server: &FakeServer) -> Value {
        server
            .received
            .recv_timeout(Duration::from_secs(2))
            .expect("server received a message")
    }

    /// Drains recorded messages until one with `method` arrives, ignoring the rest.
    fn recv_method(server: &FakeServer, method: &str) -> Value {
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            if let Ok(message) = server.received.recv_timeout(Duration::from_millis(200))
                && message["method"] == method
            {
                return message;
            }
        }
        panic!("the server never received {method}");
    }

    #[test]
    fn connects_and_completes_the_initialize_handshake() {
        let (_directory, root) = workspace();
        let server = start_fake_server(handshake_handler);
        let client = LspClient::connect(server.address, root.root()).expect("connect");

        assert_eq!(
            client.server_capabilities().hover_provider,
            Some(lsp_types::HoverProviderCapability::Simple(true))
        );

        let initialize = recv_recorded(&server);
        assert_eq!(initialize["method"], "initialize");
        assert_eq!(initialize["id"], 1);
        assert_eq!(
            initialize["params"]["capabilities"]["textDocument"]["documentSymbol"]["hierarchicalDocumentSymbolSupport"],
            true
        );
        let root_uri = initialize["params"]["rootUri"].as_str().expect("rootUri");
        let expected = root.root().display().to_string().replace('\\', "/");
        assert!(
            root_uri.trim_end_matches('/').ends_with(&expected),
            "{root_uri}"
        );
        let initialized = recv_recorded(&server);
        assert_eq!(initialized["method"], "initialized");

        client.shutdown();
        let shutdown = recv_recorded(&server);
        assert_eq!(shutdown["method"], "shutdown");
        let exit = recv_recorded(&server);
        assert_eq!(exit["method"], "exit");
        server.join.join().expect("server thread");
    }

    #[test]
    fn refuses_a_non_loopback_transport() {
        let (_directory, root) = workspace();
        let address: SocketAddr = "192.0.2.1:6005".parse().expect("address");
        let error = match LspClient::connect(address, root.root()) {
            Ok(_) => panic!("a non-loopback transport must be refused"),
            Err(error) => error,
        };
        assert_eq!(error.code, "transport_not_loopback");
    }

    #[test]
    fn correlates_out_of_order_responses() {
        let (_directory, root) = workspace();
        let server = start_fake_server(|message, writer| {
            match message.get("method").and_then(Value::as_str) {
                Some("initialize") | Some("shutdown") => handshake_handler(message, writer),
                // Answer the second request first, then the stashed first one.
                Some("textDocument/documentSymbol") => {
                    let symbol = json!({"jsonrpc": "2.0", "id": message["id"], "result": null});
                    write_message(writer, &symbol).expect("write symbol reply");
                    let hover = json!({
                        "jsonrpc": "2.0",
                        "id": message["id"].as_u64().expect("id") - 1,
                        "result": {"contents": {"kind": "plaintext", "value": "late hover"}}
                    });
                    write_message(writer, &hover).expect("write hover reply");
                    FakeAction::Ignore
                }
                _ => FakeAction::Ignore,
            }
        });
        let client = LspClient::connect(server.address, root.root()).expect("connect");
        let uri = Url::parse("file:///tmp/fake.gd").expect("uri");

        let (hover_id, hover_rx) = client
            .start_request(
                "textDocument/hover",
                position_params(&uri, Position::new(0, 0)),
            )
            .expect("hover request");
        let (symbols_id, symbols_rx) = client
            .start_request(
                "textDocument/documentSymbol",
                json!({"textDocument": {"uri": uri}}),
            )
            .expect("symbols request");

        let symbols = client
            .await_response(symbols_id, &symbols_rx, Duration::from_secs(2))
            .expect("symbols response");
        assert_eq!(symbols, Value::Null);
        let hover = client
            .await_response(hover_id, &hover_rx, Duration::from_secs(2))
            .expect("hover response");
        assert_eq!(hover["contents"]["value"], "late hover");
        client.shutdown();
        server.join.join().expect("server thread");
    }

    #[test]
    fn typed_requests_serialize_and_parse() {
        let (_directory, root) = workspace();
        let server = start_fake_server(|message, writer| {
            match message.get("method").and_then(Value::as_str) {
                Some("initialize") | Some("shutdown") => handshake_handler(message, writer),
                Some("textDocument/hover") => FakeAction::Result(json!({
                    "contents": {"kind": "markdown", "value": "**docs**"}
                })),
                Some("textDocument/references") => FakeAction::Result(json!([{
                    "uri": "file:///tmp/fake.gd",
                    "range": {"start": {"line": 1, "character": 2}, "end": {"line": 1, "character": 5}}
                }])),
                Some("textDocument/definition") => FakeAction::Result(Value::Null),
                Some("textDocument/prepareRename") => FakeAction::Result(json!({
                    "range": {"start": {"line": 0, "character": 4}, "end": {"line": 0, "character": 9}},
                    "placeholder": "total"
                })),
                Some("textDocument/rename") => FakeAction::Result(json!({
                    "changes": {"file:///tmp/fake.gd": [{
                        "range": {"start": {"line": 0, "character": 4}, "end": {"line": 0, "character": 9}},
                        "newText": "score"
                    }]}
                })),
                _ => FakeAction::Ignore,
            }
        });
        let client = LspClient::connect(server.address, root.root()).expect("connect");
        let uri = Url::parse("file:///tmp/fake.gd").expect("uri");
        let position = Position::new(0, 5);

        let hover = client.hover(&uri, position).expect("hover").expect("some");
        assert!(format!("{:?}", hover.contents).contains("docs"));

        let references = client
            .references(&uri, position, true)
            .expect("references")
            .expect("some");
        assert_eq!(references.len(), 1);
        assert_eq!(references[0].range.start.line, 1);

        assert!(
            client
                .definition(&uri, position)
                .expect("definition")
                .is_none()
        );

        let prepared = client
            .prepare_rename(&uri, position)
            .expect("prepare rename")
            .expect("some");
        let PrepareRenameResponse::RangeWithPlaceholder { placeholder, .. } = prepared else {
            panic!("expected a placeholder range");
        };
        assert_eq!(placeholder, "total");

        let edit = client.rename(&uri, position, "score").expect("rename");
        let changes = edit.changes.expect("changes");
        assert_eq!(changes[&uri][0].new_text, "score");

        // initialize, initialized, and the five typed requests were all recorded.
        let mut methods = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline && methods.len() < 7 {
            if let Ok(message) = server.received.recv_timeout(Duration::from_millis(200))
                && let Some(method) = message["method"].as_str()
            {
                methods.push(method.to_owned());
            }
        }
        for expected in [
            "textDocument/hover",
            "textDocument/references",
            "textDocument/definition",
            "textDocument/prepareRename",
            "textDocument/rename",
        ] {
            assert!(
                methods.iter().any(|method| method == expected),
                "{expected} in {methods:?}"
            );
        }
        client.shutdown();
        server.join.join().expect("server thread");
    }

    #[test]
    fn maps_server_errors_and_cancellation_codes() {
        let (_directory, root) = workspace();
        let server = start_fake_server(|message, writer| {
            match message.get("method").and_then(Value::as_str) {
                Some("initialize") | Some("shutdown") => handshake_handler(message, writer),
                Some("textDocument/hover") => FakeAction::Error(-32602, "bad params"),
                Some("textDocument/definition") => {
                    FakeAction::Error(LSP_REQUEST_CANCELLED, "cancelled by server")
                }
                _ => FakeAction::Ignore,
            }
        });
        let client = LspClient::connect(server.address, root.root()).expect("connect");
        let uri = Url::parse("file:///tmp/fake.gd").expect("uri");
        let position = Position::new(0, 0);

        let error = client.hover(&uri, position).expect_err("server error");
        assert_eq!(error.code, "lsp_server_error");
        assert_eq!(error.message, "bad params");
        assert_eq!(error.details["serverCode"], -32602);

        let error = client.definition(&uri, position).expect_err("cancelled");
        assert_eq!(error.code, "cancelled");
        client.shutdown();
        server.join.join().expect("server thread");
    }

    #[test]
    fn times_out_a_silent_server_and_recovers() {
        let (_directory, root) = workspace();
        let server = start_fake_server(|message, writer| {
            match message.get("method").and_then(Value::as_str) {
                Some("initialize") | Some("shutdown") => handshake_handler(message, writer),
                // Hover never gets an answer; a later definition still does, proving one silent
                // request does not wedge the session.
                Some("textDocument/definition") => FakeAction::Result(Value::Null),
                _ => FakeAction::Ignore,
            }
        });
        let client = LspClient::connect(server.address, root.root()).expect("connect");
        let uri = Url::parse("file:///tmp/fake.gd").expect("uri");
        let position = Position::new(0, 0);

        let (id, receiver) = client
            .start_request("textDocument/hover", position_params(&uri, position))
            .expect("hover request");
        let error = client
            .await_response(id, &receiver, Duration::from_millis(150))
            .expect_err("timeout");
        assert_eq!(error.code, "request_timeout");
        assert!(error.retryable);

        assert!(
            client
                .definition(&uri, position)
                .expect("session still works")
                .is_none()
        );
        client.shutdown();
        server.join.join().expect("server thread");
    }

    /// What `open_documents` reports is what the server was last told, never what is on disk.
    ///
    /// The renderer pushes every debounced keystroke through `change_document`, so a document open
    /// in Gofer's editor is normally ahead of the file. `script::reparse_open_documents` re-sends
    /// this text to make the server read a document again after something outside it changed —
    /// and re-sending the *file* there would replace what the user is typing with the last thing
    /// they saved, then clear the diagnostics cache so the next answer described it.
    #[test]
    fn an_open_document_reports_the_text_the_server_was_last_given() {
        let (_directory, root) = workspace();
        let server = start_fake_server(|message, writer| {
            match message.get("method").and_then(Value::as_str) {
                Some("initialize") | Some("shutdown") => handshake_handler(message, writer),
                _ => FakeAction::Ignore,
            }
        });
        let client = LspClient::connect(server.address, root.root()).expect("connect");
        let uri = Url::parse("file:///tmp/typing.gd").expect("uri");

        client.open_document(&uri, "extends Node\n").expect("open");
        assert_eq!(
            client.open_documents(),
            vec![(uri.clone(), "extends Node\n".to_owned())]
        );

        client
            .change_document(&uri, "extends Node\n\nvar unsaved := 1\n")
            .expect("change");
        assert_eq!(
            client.open_documents(),
            vec![(uri.clone(), "extends Node\n\nvar unsaved := 1\n".to_owned())],
            "the buffer the user is typing is what the server holds"
        );

        client.close_document(&uri).expect("close");
        assert!(client.open_documents().is_empty());
        client.shutdown();
        server.join.join().expect("server thread");
    }

    #[test]
    fn broadcasts_diagnostics_to_subscribers() {
        let (_directory, root) = workspace();
        let server = start_fake_server(|message, writer| {
            match message.get("method").and_then(Value::as_str) {
                Some("initialize") | Some("shutdown") => handshake_handler(message, writer),
                Some("initialized") => {
                    let notification = json!({
                        "jsonrpc": "2.0",
                        "method": "textDocument/publishDiagnostics",
                        "params": {
                            "uri": "file:///tmp/broken.gd",
                            "diagnostics": [{
                                "range": {
                                    "start": {"line": 2, "character": 0},
                                    "end": {"line": 2, "character": 10}
                                },
                                "severity": 1,
                                "source": "gdscript",
                                "message": "Expected ')'"
                            }]
                        }
                    });
                    write_message(writer, &notification).expect("push diagnostics");
                    FakeAction::Ignore
                }
                _ => FakeAction::Ignore,
            }
        });
        let client = LspClient::connect(server.address, root.root()).expect("connect");
        let diagnostics = client.subscribe_diagnostics();

        let params = diagnostics
            .recv_timeout(Duration::from_secs(2))
            .expect("diagnostics");
        assert_eq!(params.uri.as_str(), "file:///tmp/broken.gd");
        assert_eq!(params.diagnostics.len(), 1);
        assert_eq!(params.diagnostics[0].message, "Expected ')'");
        client.shutdown();
        server.join.join().expect("server thread");
    }

    /// Godot percent-encodes each path segment separately, so a Windows drive letter reaches the
    /// client as `C%3A` while every URI the client builds spells it `C:`. Both spellings have to
    /// arrive as the one the caller compares against, or a diagnostic is published for a document
    /// nobody is watching and a definition lands in a file nobody asked about.
    #[test]
    fn a_percent_encoded_drive_letter_arrives_spelled_the_way_the_client_writes_it() {
        let (_directory, root) = workspace();
        let server = start_fake_server(|message, writer| {
            match message.get("method").and_then(Value::as_str) {
                Some("initialize") | Some("shutdown") => handshake_handler(message, writer),
                Some("initialized") => {
                    let notification = json!({
                        "jsonrpc": "2.0",
                        "method": "textDocument/publishDiagnostics",
                        "params": {
                            "uri": "file:///C%3A/work/broken.gd",
                            "diagnostics": [{
                                "range": {
                                    "start": {"line": 2, "character": 0},
                                    "end": {"line": 2, "character": 10}
                                },
                                "severity": 1,
                                "message": "Expected ')'"
                            }]
                        }
                    });
                    write_message(writer, &notification).expect("push diagnostics");
                    FakeAction::Ignore
                }
                Some("textDocument/definition") => FakeAction::Result(json!({
                    "uri": "file:///C%3A/work/math_utils.gd",
                    "range": {
                        "start": {"line": 4, "character": 12},
                        "end": {"line": 4, "character": 21}
                    }
                })),
                _ => FakeAction::Ignore,
            }
        });
        let client = LspClient::connect(server.address, root.root()).expect("connect");
        let diagnostics = client.subscribe_diagnostics();

        let params = diagnostics
            .recv_timeout(Duration::from_secs(2))
            .expect("diagnostics");
        assert_eq!(params.uri.as_str(), "file:///C:/work/broken.gd");
        // The pull reads the same cache the broadcast filled, and it is keyed by URI.
        let cached = client
            .diagnostics(&params.uri, Duration::from_secs(2))
            .expect("cached diagnostics")
            .expect("a verdict was published");
        assert_eq!(cached.diagnostics.len(), 1);

        let uri = Url::parse("file:///C:/work/one.gd").expect("uri");
        let Some(GotoDefinitionResponse::Scalar(location)) = client
            .definition(&uri, Position::new(6, 10))
            .expect("definition")
        else {
            panic!("expected a single definition location");
        };
        assert_eq!(location.uri.as_str(), "file:///C:/work/math_utils.gd");
        client.shutdown();
        server.join.join().expect("server thread");
    }

    #[test]
    fn cancel_fails_the_waiter_and_notifies_the_server() {
        let (_directory, root) = workspace();
        let server = start_fake_server(|message, writer| {
            match message.get("method").and_then(Value::as_str) {
                Some("initialize") | Some("shutdown") => handshake_handler(message, writer),
                _ => FakeAction::Ignore,
            }
        });
        let client = Arc::new(LspClient::connect(server.address, root.root()).expect("connect"));
        let uri = Url::parse("file:///tmp/fake.gd").expect("uri");

        let (id, receiver) = client
            .start_request(
                "textDocument/hover",
                position_params(&uri, Position::new(0, 0)),
            )
            .expect("hover request");
        let waiting = Arc::clone(&client);
        let waiter =
            thread::spawn(move || waiting.await_response(id, &receiver, Duration::from_secs(10)));

        // Give the waiter a moment to block, then cancel.
        thread::sleep(Duration::from_millis(50));
        client.cancel(id).expect("cancel");
        let error = waiter.join().expect("waiter").expect_err("cancelled");
        assert_eq!(error.code, "cancelled");

        let notification = recv_method(&server, "$/cancelRequest");
        assert_eq!(notification["params"]["id"], id);
        client.shutdown();
        server.join.join().expect("server thread");
    }

    #[test]
    fn drives_the_document_lifecycle_with_versions() {
        let (_directory, root) = workspace();
        let server = start_fake_server(handshake_handler);
        let client = LspClient::connect(server.address, root.root()).expect("connect");
        let uri = Url::parse("file:///tmp/fake.gd").expect("uri");

        let version = client.open_document(&uri, "extends Node\n").expect("open");
        assert_eq!(version, 1);
        let version = client
            .change_document(&uri, "extends Node2D\n")
            .expect("change");
        assert_eq!(version, 2);
        client
            .save_document(&uri, "extends Node2D\n")
            .expect("save");
        client.close_document(&uri).expect("close");

        let error = client
            .change_document(&uri, "extends Control\n")
            .expect_err("closed document");
        assert_eq!(error.code, "document_not_open");
        let error = client
            .save_document(&uri, "extends Control\n")
            .expect_err("closed document");
        assert_eq!(error.code, "document_not_open");

        let did_open = recv_method(&server, "textDocument/didOpen");
        assert_eq!(did_open["params"]["textDocument"]["version"], 1);
        assert_eq!(did_open["params"]["textDocument"]["languageId"], "gdscript");

        let did_change = recv_method(&server, "textDocument/didChange");
        assert_eq!(did_change["params"]["textDocument"]["version"], 2);
        assert_eq!(
            did_change["params"]["contentChanges"][0]["text"],
            "extends Node2D\n"
        );
        assert!(
            did_change["params"]["contentChanges"][0]
                .get("range")
                .is_none()
        );

        let did_save = recv_method(&server, "textDocument/didSave");
        assert_eq!(did_save["params"]["text"], "extends Node2D\n");

        recv_method(&server, "textDocument/didClose");
        client.shutdown();
        server.join.join().expect("server thread");
    }

    #[test]
    fn maps_utf16_positions_to_byte_offsets() {
        let text = "ab\ncd\n";
        assert_eq!(byte_offset(text, Position::new(0, 0)).expect("offset"), 0);
        assert_eq!(byte_offset(text, Position::new(0, 2)).expect("offset"), 2);
        assert_eq!(byte_offset(text, Position::new(1, 0)).expect("offset"), 3);
        assert_eq!(byte_offset(text, Position::new(1, 2)).expect("offset"), 5);

        // An astral character occupies two UTF-16 code units but four bytes.
        let text = "a\u{1F600}b\n";
        assert_eq!(byte_offset(text, Position::new(0, 1)).expect("offset"), 1);
        assert_eq!(byte_offset(text, Position::new(0, 3)).expect("offset"), 5);
        assert_eq!(byte_offset(text, Position::new(0, 4)).expect("offset"), 6);

        // The middle of the surrogate pair is not a valid position.
        let error = byte_offset(text, Position::new(0, 2)).expect_err("mid-surrogate");
        assert_eq!(error.code, "position_out_of_range");
        let error = byte_offset(text, Position::new(0, 5)).expect_err("past end");
        assert_eq!(error.code, "position_out_of_range");
        let error = byte_offset(text, Position::new(3, 0)).expect_err("past lines");
        assert_eq!(error.code, "position_out_of_range");
    }

    #[test]
    fn plans_and_commits_a_multi_file_edit() {
        let (_directory, workspace) = workspace();
        let one = workspace
            .write("one.gd", "var total := 0\n", None)
            .expect("write one");
        let two = workspace
            .write("two.gd", "extends Node\nvar total := 1\n", None)
            .expect("write two");
        let edit: WorkspaceEdit = serde_json::from_value(json!({
            "changes": {
                file_uri(&workspace, "one.gd").expect("uri").as_str(): [{
                    "range": {"start": {"line": 0, "character": 4}, "end": {"line": 0, "character": 9}},
                    "newText": "score"
                }],
                file_uri(&workspace, "two.gd").expect("uri").as_str(): [{
                    "range": {"start": {"line": 1, "character": 4}, "end": {"line": 1, "character": 9}},
                    "newText": "score"
                }]
            }
        }))
        .expect("parse edit");

        let planned = plan_workspace_edit(&workspace, &edit).expect("plan");
        assert_eq!(planned.len(), 2);
        assert_eq!(planned[0].original_hash, one.hash);
        assert_eq!(planned[1].original_hash, two.hash);

        let stamps = commit_planned_edit(&workspace, &planned).expect("commit");
        assert_eq!(stamps.len(), 2);
        assert_eq!(
            workspace.read("one.gd").expect("read one").text,
            "var score := 0\n"
        );
        assert_eq!(
            workspace.read("two.gd").expect("read two").text,
            "extends Node\nvar score := 1\n"
        );
    }

    #[test]
    fn plans_document_changes_and_refuses_resource_operations() {
        let (_directory, workspace) = workspace();
        workspace
            .write("one.gd", "var total := 0\n", None)
            .expect("write");
        let uri = file_uri(&workspace, "one.gd").expect("uri");
        let edit: WorkspaceEdit = serde_json::from_value(json!({
            "documentChanges": [{
                "textDocument": {"uri": uri, "version": 3},
                "edits": [{
                    "range": {"start": {"line": 0, "character": 4}, "end": {"line": 0, "character": 9}},
                    "newText": "score"
                }]
            }]
        }))
        .expect("parse edit");
        let planned = plan_workspace_edit(&workspace, &edit).expect("plan");
        assert_eq!(planned[0].updated_text, "var score := 0\n");

        // An edit-only `documentChanges` array in the operations form is still just text edits.
        let edit: WorkspaceEdit = serde_json::from_value(json!({
            "documentChanges": [
                {
                    "textDocument": {"uri": uri, "version": 3},
                    "edits": [{
                        "range": {"start": {"line": 0, "character": 4}, "end": {"line": 0, "character": 9}},
                        "newText": "score"
                    }]
                },
                {"kind": "create", "uri": uri}
            ]
        }))
        .expect("parse edit");
        let error = plan_workspace_edit(&workspace, &edit).expect_err("resource op");
        assert_eq!(error.code, "unsupported_resource_operations");

        let edit: WorkspaceEdit = serde_json::from_value(json!({
            "documentChanges": [{"kind": "create", "uri": uri}]
        }))
        .expect("parse edit");
        let error = plan_workspace_edit(&workspace, &edit).expect_err("resource op");
        assert_eq!(error.code, "unsupported_resource_operations");
    }

    #[test]
    fn prefers_document_changes_and_refuses_a_file_named_twice() {
        let (_directory, workspace) = workspace();
        workspace
            .write("one.gd", "var total := 0\n", None)
            .expect("write");
        let uri = file_uri(&workspace, "one.gd").expect("uri");
        let rename = json!([{
            "range": {"start": {"line": 0, "character": 4}, "end": {"line": 0, "character": 9}},
            "newText": "score"
        }]);

        // A server that sends both forms describes the same rename twice. Merging them would plan
        // one.gd twice and lose the second write to the first, so documentChanges wins alone.
        let both: WorkspaceEdit = serde_json::from_value(json!({
            "changes": {uri.as_str(): rename},
            "documentChanges": [{
                "textDocument": {"uri": uri, "version": 3},
                "edits": rename
            }]
        }))
        .expect("parse edit");
        let planned = plan_workspace_edit(&workspace, &both).expect("plan");
        assert_eq!(planned.len(), 1);
        assert_eq!(planned[0].updated_text, "var score := 0\n");
        commit_planned_edit(&workspace, &planned).expect("commit");
        assert_eq!(
            workspace.read("one.gd").expect("read").text,
            "var score := 0\n"
        );

        let twice: WorkspaceEdit = serde_json::from_value(json!({
            "documentChanges": [
                {"textDocument": {"uri": uri, "version": 3}, "edits": rename},
                {"textDocument": {"uri": uri, "version": 3}, "edits": rename}
            ]
        }))
        .expect("parse edit");
        let error = plan_workspace_edit(&workspace, &twice).expect_err("duplicate target");
        assert_eq!(error.code, "duplicate_edit_target");
        assert_eq!(error.details["path"], "one.gd");
    }

    #[test]
    fn rejects_overlapping_inverted_and_out_of_bounds_edits() {
        let (_directory, workspace) = workspace();
        workspace
            .write("one.gd", "var total := 0\n", None)
            .expect("write");
        let uri = file_uri(&workspace, "one.gd").expect("uri");
        let edit_with = |edits: Value| {
            serde_json::from_value::<WorkspaceEdit>(json!({"changes": {uri.as_str(): edits}}))
                .expect("parse edit")
        };

        let overlapping = edit_with(json!([
            {"range": {"start": {"line": 0, "character": 0}, "end": {"line": 0, "character": 8}}, "newText": "a"},
            {"range": {"start": {"line": 0, "character": 4}, "end": {"line": 0, "character": 9}}, "newText": "b"}
        ]));
        let error = plan_workspace_edit(&workspace, &overlapping).expect_err("overlapping");
        assert_eq!(error.code, "overlapping_edits");

        let inverted = edit_with(json!([{
            "range": {"start": {"line": 0, "character": 9}, "end": {"line": 0, "character": 4}},
            "newText": "b"
        }]));
        let error = plan_workspace_edit(&workspace, &inverted).expect_err("inverted");
        assert_eq!(error.code, "invalid_range");

        let out_of_bounds = edit_with(json!([{
            "range": {"start": {"line": 7, "character": 0}, "end": {"line": 7, "character": 1}},
            "newText": "b"
        }]));
        let error = plan_workspace_edit(&workspace, &out_of_bounds).expect_err("out of bounds");
        assert_eq!(error.code, "position_out_of_range");

        let outside: WorkspaceEdit = serde_json::from_value(json!({
            "changes": {"file:///etc/passwd": [{
                "range": {"start": {"line": 0, "character": 0}, "end": {"line": 0, "character": 1}},
                "newText": "b"
            }]}
        }))
        .expect("parse edit");
        let error = plan_workspace_edit(&workspace, &outside).expect_err("outside");
        assert_eq!(error.code, "path_outside_workspace");
    }

    #[test]
    fn rolls_back_earlier_files_when_a_later_file_conflicts() {
        let (_directory, workspace) = workspace();
        let one = workspace.write("one.gd", "one\n", None).expect("write one");
        workspace.write("two.gd", "two\n", None).expect("write two");
        let planned = vec![
            PlannedFile {
                path: "one.gd".to_owned(),
                original_text: "one\n".to_owned(),
                original_hash: one.hash.clone(),
                updated_text: "ONE\n".to_owned(),
            },
            PlannedFile {
                path: "two.gd".to_owned(),
                original_text: "two\n".to_owned(),
                // The hash no longer matches the file: somebody edited it after the plan.
                original_hash: "stale".to_owned(),
                updated_text: "TWO\n".to_owned(),
            },
        ];

        let error = commit_planned_edit(&workspace, &planned).expect_err("conflict");
        assert_eq!(error.code, "edit_apply_failed");
        assert_eq!(error.details["rolledBack"], true);
        assert_eq!(error.details["path"], "two.gd");
        assert_eq!(
            workspace.read("one.gd").expect("read one").text,
            "one\n",
            "the file that did apply must be rolled back"
        );
        assert_eq!(workspace.read("two.gd").expect("read two").text, "two\n");
    }

    #[test]
    fn applies_an_edit_around_astral_characters() {
        let (_directory, workspace) = workspace();
        workspace
            .write(
                "emoji.gd",
                "var icon := \"\u{1F600}\"\nvar total := 0\n",
                None,
            )
            .expect("write");
        let uri = file_uri(&workspace, "emoji.gd").expect("uri");
        let edit: WorkspaceEdit = serde_json::from_value(json!({
            "changes": {uri.as_str(): [{
                "range": {"start": {"line": 1, "character": 4}, "end": {"line": 1, "character": 9}},
                "newText": "score"
            }]}
        }))
        .expect("parse edit");
        let planned = plan_workspace_edit(&workspace, &edit).expect("plan");
        commit_planned_edit(&workspace, &planned).expect("commit");
        assert_eq!(
            workspace.read("emoji.gd").expect("read").text,
            "var icon := \"\u{1F600}\"\nvar score := 0\n"
        );
    }

    #[test]
    fn synthesizes_workspace_symbols_from_document_symbols() {
        let (_directory, workspace) = workspace();
        workspace
            .write(
                "math_utils.gd",
                "class_name MathUtils\nstatic func add_score(a: int, b: int) -> int:\n\treturn a + b\n",
                None,
            )
            .expect("write math");
        workspace
            .write("score_keeper.gd", "extends Node\nvar total := 0\n", None)
            .expect("write keeper");

        let math_uri = file_uri(&workspace, "math_utils.gd").expect("math uri");
        let keeper_uri = file_uri(&workspace, "score_keeper.gd").expect("keeper uri");
        let server = start_fake_server(move |message, writer| {
            match message.get("method").and_then(Value::as_str) {
                Some("initialize") | Some("shutdown") => handshake_handler(message, writer),
                Some("textDocument/documentSymbol") => {
                    let uri = message["params"]["textDocument"]["uri"]
                        .as_str()
                        .unwrap_or_default();
                    if uri == math_uri.as_str() {
                        return FakeAction::Result(json!([{
                            "name": "MathUtils",
                            "kind": 5,
                            "range": {
                                "start": {"line": 0, "character": 0},
                                "end": {"line": 2, "character": 12}
                            },
                            "selectionRange": {
                                "start": {"line": 0, "character": 11},
                                "end": {"line": 0, "character": 20}
                            },
                            "children": [{
                                "name": "add_score",
                                "kind": 6,
                                "range": {
                                    "start": {"line": 1, "character": 0},
                                    "end": {"line": 2, "character": 12}
                                },
                                "selectionRange": {
                                    "start": {"line": 1, "character": 12},
                                    "end": {"line": 1, "character": 21}
                                }
                            }]
                        }]));
                    }
                    if uri == keeper_uri.as_str() {
                        return FakeAction::Result(json!([{
                            "name": "total",
                            "kind": 13,
                            "location": {
                                "uri": keeper_uri,
                                "range": {
                                    "start": {"line": 1, "character": 4},
                                    "end": {"line": 1, "character": 9}
                                }
                            }
                        }]));
                    }
                    FakeAction::Result(Value::Null)
                }
                _ => FakeAction::Ignore,
            }
        });
        let client = LspClient::connect(server.address, workspace.root()).expect("connect");

        let all = client
            .workspace_symbols(&workspace, "")
            .expect("all symbols");
        assert_eq!(all.len(), 3, "{all:?}");

        let matches = client
            .workspace_symbols(&workspace, "ADD")
            .expect("query is case-insensitive");
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].name, "add_score");
        assert_eq!(matches[0].kind, SymbolKind::METHOD);
        assert_eq!(matches[0].container.as_deref(), Some("MathUtils"));

        let none = client
            .workspace_symbols(&workspace, "missing")
            .expect("no match");
        assert!(none.is_empty());

        // The client opened both documents itself, so it must have closed them again.
        let mut closes = 0;
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline && closes < 2 {
            if let Ok(message) = server.received.recv_timeout(Duration::from_millis(200))
                && message["method"] == "textDocument/didClose"
            {
                closes += 1;
            }
        }
        assert_eq!(closes, 2);
        client.shutdown();
        server.join.join().expect("server thread");
    }

    #[test]
    fn reads_frames_with_extra_headers_and_skips_stray_blanks() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let address = listener.local_addr().expect("address");
        let sender = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            let body = serde_json::to_vec(&json!({"jsonrpc": "2.0", "id": 1, "result": {}}))
                .expect("body");
            let frame = format!(
                "\r\nContent-Type: application/vscode-jsonrpc; charset=utf-8\r\ncontent-length: {}\r\n\r\n",
                body.len()
            );
            stream.write_all(frame.as_bytes()).expect("write headers");
            stream.write_all(&body).expect("write body");
            stream.flush().expect("flush");
        });
        let stream = TcpStream::connect(address).expect("connect");
        let mut reader = BufReader::new(stream);
        let message = read_message(&mut reader).expect("message").expect("some");
        assert_eq!(message["id"], 1);
        sender.join().expect("sender");
    }

    #[test]
    fn reports_closed_transport_to_pending_callers() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let address = listener.local_addr().expect("address");
        let server = thread::spawn(move || {
            let (stream, _) = listener.accept().expect("accept");
            // Read the initialize request, then hang up without answering.
            let mut reader = BufReader::new(stream);
            let _ = read_message(&mut reader);
        });
        let (_directory, root) = workspace();
        let started = Instant::now();
        let error = match LspClient::connect(address, root.root()) {
            Ok(_) => panic!("a server that hangs up must fail the handshake"),
            Err(error) => error,
        };
        assert_eq!(error.code, "transport_closed");
        assert!(error.retryable);
        assert!(started.elapsed() < INITIALIZE_TIMEOUT);
        server.join().expect("server");
    }

    /// A server that answers initialize without capabilities is not a server this client can use:
    /// every later request would be sent on a guess about what it supports.
    #[test]
    fn refuses_a_handshake_without_capabilities() {
        let (_directory, root) = workspace();
        let server = start_fake_server(|message, _writer| {
            match message.get("method").and_then(Value::as_str) {
                Some("initialize") => FakeAction::Result(json!({"serverInfo": {"name": "fake"}})),
                _ => FakeAction::Ignore,
            }
        });

        let error = match LspClient::connect(server.address, root.root()) {
            Ok(_) => panic!("initialize without capabilities must not produce a client"),
            Err(error) => error,
        };

        assert_eq!(error.code, "invalid_response");
    }

    /// The document lifecycle is a state machine, and the three operations that require an open
    /// document say so rather than notifying the server about a document it has never seen.
    #[test]
    fn refuses_lifecycle_operations_on_a_document_that_is_not_open() {
        let (_directory, root) = workspace();
        let server = start_fake_server(handshake_handler);
        let client = LspClient::connect(server.address, root.root()).expect("connect");
        let uri = Url::parse("file:///worktree/scripts/absent.gd").expect("uri");

        for error in [
            client.change_document(&uri, "extends Node\n").unwrap_err(),
            client.save_document(&uri, "extends Node\n").unwrap_err(),
            client.close_document(&uri).unwrap_err(),
        ] {
            assert_eq!(error.code, "document_not_open");
        }

        client.shutdown();
        server.join.join().expect("server thread");
    }

    /// A diagnostics pull answers three different questions, and the caller has to be able to tell
    /// them apart: nothing published yet, a published verdict, and a session that is gone. Only the
    /// middle one carries diagnostics, and `None` is not the same as a clean file.
    #[test]
    fn diagnostics_separate_silence_from_a_verdict_and_from_a_dead_session() {
        let (_directory, root) = workspace();
        let published = Arc::new(AtomicBool::new(false));
        let publishing = Arc::clone(&published);
        let server = start_fake_server(move |message, writer| {
            if message.get("method").and_then(Value::as_str) == Some("textDocument/didOpen")
                && publishing.load(Ordering::SeqCst)
            {
                let notification = json!({
                    "jsonrpc": "2.0",
                    "method": "textDocument/publishDiagnostics",
                    "params": {
                        "uri": message["params"]["textDocument"]["uri"],
                        "diagnostics": [{
                            "range": {
                                "start": {"line": 0, "character": 0},
                                "end": {"line": 0, "character": 4}
                            },
                            "message": "Expected ')'",
                            "severity": 1
                        }]
                    }
                });
                write_message(writer, &notification).expect("publish diagnostics");
            }
            handshake_handler(message, writer)
        });
        let client = LspClient::connect(server.address, root.root()).expect("connect");
        let uri = Url::parse("file:///worktree/scripts/quiet.gd").expect("uri");

        client.open_document(&uri, "extends Node\n").expect("open");
        assert!(
            client
                .diagnostics(&uri, Duration::from_millis(150))
                .expect("a silent server is not an error")
                .is_none(),
            "nothing published yet must not be reported as a clean file"
        );

        published.store(true, Ordering::SeqCst);
        client
            .open_document(&uri, "extends Node\n")
            .expect("reopen");
        let answer = client
            .diagnostics(&uri, Duration::from_secs(2))
            .expect("published diagnostics")
            .expect("the publication must be readable");
        assert_eq!(answer.diagnostics.len(), 1);
        assert_eq!(answer.diagnostics[0].message, "Expected ')'");

        client.shutdown();
        assert!(
            client
                .diagnostics(&uri, Duration::from_secs(2))
                .expect("the cache is read before the session state")
                .is_some(),
            "a verdict already published outlives the session that published it"
        );
        let unanswered = Url::parse("file:///worktree/scripts/other.gd").expect("uri");
        let error = client
            .diagnostics(&unanswered, Duration::from_secs(2))
            .expect_err("a closed session can no longer produce a first verdict");
        assert_eq!(error.code, "session_closed");
        server.join.join().expect("server thread");
    }

    /// Godot answers `textDocument/rename` with null when the symbol under the cursor cannot be
    /// renamed. That is an empty edit, not a malformed answer.
    #[test]
    fn a_null_rename_answer_is_an_empty_edit() {
        let (_directory, root) = workspace();
        let server = start_fake_server(|message, writer| {
            match message.get("method").and_then(Value::as_str) {
                Some("textDocument/rename") => FakeAction::Result(Value::Null),
                _ => handshake_handler(message, writer),
            }
        });
        let client = LspClient::connect(server.address, root.root()).expect("connect");
        let uri = Url::parse("file:///worktree/scripts/player.gd").expect("uri");

        let edit = client
            .rename(&uri, Position::new(0, 0), "renamed")
            .expect("a null answer is not a failure");

        assert_eq!(edit, WorkspaceEdit::default());
        client.shutdown();
        server.join.join().expect("server thread");
    }

    /// The synthesized workspace symbols index every `.gd` file, and a document the caller already
    /// opened has to survive the indexing: closing it would silently drop the caller's buffer
    /// version and leave the server answering from disk.
    #[test]
    fn workspace_symbols_filter_by_query_and_leave_open_documents_open() {
        let (directory, root) = workspace();
        std::fs::create_dir_all(directory.path().join("scripts")).expect("scripts directory");
        std::fs::write(
            directory.path().join("scripts/player.gd"),
            "extends Node\n\nfunc jump() -> void:\n\tpass\n",
        )
        .expect("write script");
        let server = start_fake_server(|message, writer| {
            match message.get("method").and_then(Value::as_str) {
                Some("textDocument/documentSymbol") => FakeAction::Result(json!([
                    {
                        "name": "jump",
                        "kind": 12,
                        "range": {
                            "start": {"line": 2, "character": 0},
                            "end": {"line": 3, "character": 5}
                        },
                        "selectionRange": {
                            "start": {"line": 2, "character": 5},
                            "end": {"line": 2, "character": 9}
                        }
                    },
                    {
                        "name": "walk",
                        "kind": 12,
                        "range": {
                            "start": {"line": 4, "character": 0},
                            "end": {"line": 5, "character": 5}
                        },
                        "selectionRange": {
                            "start": {"line": 4, "character": 5},
                            "end": {"line": 4, "character": 9}
                        }
                    }
                ])),
                _ => handshake_handler(message, writer),
            }
        });
        let client = LspClient::connect(server.address, root.root()).expect("connect");
        let uri = file_uri(&root, "scripts/player.gd").expect("uri");
        client.open_document(&uri, "extends Node\n").expect("open");

        let matched = client
            .workspace_symbols(&root, "JUM")
            .expect("workspace symbols");

        assert_eq!(matched.len(), 1, "the query filters case-insensitively");
        assert_eq!(matched[0].name, "jump");
        assert!(
            client.is_open(&uri),
            "indexing must not close a document the caller opened"
        );
        assert_eq!(
            client
                .workspace_symbols(&root, "")
                .expect("workspace symbols")
                .len(),
            2,
            "an empty query returns every symbol"
        );

        client.shutdown();
        server.join.join().expect("server thread");
    }

    /// Nothing a server sends may take the client down. Each of these is discarded on the reader
    /// thread, and the request that follows still gets its answer.
    #[test]
    fn ignores_unusable_server_messages_and_keeps_serving() {
        let (_directory, root) = workspace();
        let server = start_fake_server(|message, writer| {
            if message.get("method").and_then(Value::as_str) == Some("initialized") {
                for junk in [
                    // A notification the client parses but cannot use.
                    json!({"jsonrpc": "2.0", "method": "textDocument/publishDiagnostics"}),
                    json!({
                        "jsonrpc": "2.0",
                        "method": "textDocument/publishDiagnostics",
                        "params": {"uri": 42}
                    }),
                    // Answers to requests nobody is waiting for.
                    json!({"jsonrpc": "2.0", "id": "not-a-number", "result": null}),
                    json!({"jsonrpc": "2.0", "id": 4242, "result": {"ok": true}}),
                ] {
                    write_message(writer, &junk).expect("write junk");
                }
            }
            match message.get("method").and_then(Value::as_str) {
                Some("textDocument/hover") => FakeAction::Result(json!({
                    "contents": {"kind": "plaintext", "value": "still here"}
                })),
                _ => handshake_handler(message, writer),
            }
        });
        let client = LspClient::connect(server.address, root.root()).expect("connect");
        let uri = Url::parse("file:///worktree/scripts/player.gd").expect("uri");

        let hover = client
            .hover(&uri, Position::new(0, 0))
            .expect("the client survived every unusable message")
            .expect("hover contents");

        assert!(matches!(hover.contents, HoverContents::Markup(_)));
        client.shutdown();
        server.join.join().expect("server thread");
    }
}

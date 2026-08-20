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

use crate::files::{FileError, FileStamp, Workspace};
use crate::godot_lsp::{self, LspClient, LspError, PlannedFile, WorkspaceSymbol};
use crate::godot_rpc::CallRequest;
use crate::godot_session;
use lsp_types::{
    CompletionItem, CompletionResponse, Diagnostic, DocumentHighlight, DocumentSymbolResponse,
    GotoDefinitionResponse, Hover, Location, Position, PrepareRenameResponse,
    PublishDiagnosticsParams, Range, SignatureHelp, Url,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::RecvTimeoutError;
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

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

/// One targeted replacement. `old_text` is the anchor, and it is the whole conflict guard an edit
/// needs: a whole-buffer save has no anchor and needs a hash, but text that is no longer there
/// cannot be matched, so a stale edit fails on its own terms rather than on a token.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptEdit {
    pub old_text: String,
    pub new_text: String,
}

/// Every replacement one file receives in a single call.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptFileEdit {
    pub path: String,
    pub edits: Vec<ScriptEdit>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditScriptRequest {
    pub files: Vec<ScriptFileEdit>,
}

/// One edited file, answered with what a caller would otherwise spend two more calls asking for:
/// the stamp a later write needs, and the verdict the language server published for the text this
/// call just saved.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditedScript {
    pub path: String,
    pub hash: String,
    pub bytes: u64,
    pub version: i32,
    /// How many anchors were replaced, so a caller can tell a real edit from one that asked for
    /// text the file already held.
    pub replaced: usize,
    pub diagnostics: Vec<Diagnostic>,
    /// False when the server published nothing for the saved text within the timeout, exactly as
    /// in a `diagnostics` pull: an empty list here is silence, not a clean file.
    pub published: bool,
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

/// How much of the file one refused anchor quotes back before it stops quoting.
///
/// The number is measured, not chosen. Over a week of one project seven anchors were refused, and
/// the text a near miss would have quoted was 136 bytes at the median and 950 at the worst. A
/// thousand covers every one of them and still costs two orders of magnitude less than the recovery
/// it replaces, which ran to 17,634 bytes of calls and answers per anchor. Past the cap the region
/// is named by its lines rather than quoted, because a block cut in half is the failure
/// `OPEN_TEXT_BUDGET` exists to prevent: the model pastes back the half it was shown and is refused
/// again for the same reason.
const MAX_NEAR_MISS_BYTES: usize = 1_000;

/// One text with every whitespace character removed, and the map back to where each surviving byte
/// came from.
///
/// `starts[i]` and `ends[i]` are the original byte range of the character that produced squeezed
/// byte `i`, so a match over `squeezed[a..b]` names the original span `starts[a]..ends[b - 1]`. Two
/// maps rather than one: the end of the last matched character is not the start of the next one,
/// and the difference between them is exactly the whitespace a near miss exists to forgive.
struct Squeezed {
    text: String,
    starts: Vec<usize>,
    ends: Vec<usize>,
}

fn squeeze(text: &str) -> Squeezed {
    let mut squeezed = Squeezed {
        text: String::with_capacity(text.len()),
        starts: Vec::with_capacity(text.len()),
        ends: Vec::with_capacity(text.len()),
    };
    for (index, character) in text.char_indices() {
        if character.is_whitespace() {
            continue;
        }
        squeezed.text.push(character);
        while squeezed.starts.len() < squeezed.text.len() {
            squeezed.starts.push(index);
            squeezed.ends.push(index + character.len_utf8());
        }
    }
    squeezed
}

/// What a refused anchor says, once the file has been asked whether it holds the same text under
/// different whitespace.
///
/// The failure this closes, measured over a week of one project: an anchor that differed from the
/// file by a single tab was refused with "read the file and anchor on text it currently has", and
/// the model sent the identical call again rather than reading anything. Three of seven refusals
/// were byte-identical retries and every one of them was refused a second time. Recovery cost
/// 17,634 bytes of calls and answers at the median, against the 136 the file's own bytes would have
/// cost. Zero of four distinct anchors recovered in one call.
///
/// Whitespace is squeezed out of both sides only to FIND the region. What is quoted back is the
/// file's own bytes, never the squeezed form, and nothing here writes: GDScript indentation is
/// semantic, so a region found without it is a thing to show the model, not a thing to apply.
/// Silence is the fallback on purpose. Over those same seven refusals this answered with a region
/// three times and with nothing four times, and never once with the wrong region — the two it
/// could not reach were a stale idea of the file's content, which no amount of whitespace
/// forgiveness reaches.
fn anchor_not_found(path: &str, text: &str, old_text: &str) -> LspError {
    let unmatched = format!(
        "`oldText` is not in {path}. The file may already hold the change, or the anchor may \
         differ in whitespace. Read the file and anchor on text it currently has."
    );
    let haystack = squeeze(text);
    let needle = squeeze(old_text);
    if needle.text.is_empty() {
        return LspError::new("anchor_not_found", unmatched);
    }
    let mut found = haystack.text.match_indices(needle.text.as_str());
    let Some((first, _)) = found.next() else {
        return LspError::new("anchor_not_found", unmatched);
    };
    // A line is counted rather than indexed: the alternative is a second table over the file, and
    // this runs once, on the way out of a call that has already failed.
    let line_of = |offset: usize| text[..offset].matches('\n').count() + 1;
    let others: Vec<usize> = found.map(|(start, _)| start).collect();
    if !others.is_empty() {
        let lines: Vec<String> = std::iter::once(first)
            .chain(others)
            .map(|start| line_of(haystack.starts[start]).to_string())
            .collect();
        return LspError::new(
            "anchor_not_found",
            format!(
                "`oldText` is not in {path}. Apart from whitespace it matches {} regions, at lines \
                 {}, so it still names no single region. Quote one of them from the file, with a \
                 neighbouring line.",
                lines.len(),
                lines.join(", ")
            ),
        );
    }
    let start = haystack.starts[first];
    let last = first + needle.text.len() - 1;
    let held = &text[start..haystack.ends[last]];
    let first_line = line_of(start);
    // The last character's start, not the region's end: an end offset can fall inside a character,
    // and slicing there panics.
    let last_line = line_of(haystack.starts[last]);
    if held.len() > MAX_NEAR_MISS_BYTES {
        let opening = held.lines().next().unwrap_or_default().trim();
        return LspError::new(
            "anchor_not_found",
            format!(
                "`oldText` is not in {path}, but apart from whitespace it matches lines \
                 {first_line} to {last_line}, which are too long to quote here. They open with \
                 `{opening}`. Read those lines and anchor on what they hold."
            ),
        );
    }
    LspError::new(
        "anchor_not_found",
        format!(
            "`oldText` is not in {path}. Apart from whitespace it matches lines {first_line} to \
             {last_line}, which the file holds as:\n\n{held}\n\nAnchor on that text exactly, or \
             read the file again if it is not the region you meant."
        ),
    )
}

/// Replaces every anchor in one file's text, and refuses anything it cannot do exactly once.
///
/// Offsets are taken against the original text and applied back to front, so an earlier
/// replacement never moves a later anchor. Ambiguity is refused rather than resolved: an anchor
/// that matches twice names two regions, and picking one would be a guess about which.
fn apply_edits(path: &str, text: &str, edits: &[ScriptEdit]) -> Result<String, LspError> {
    if edits.is_empty() {
        return Err(LspError::new(
            "no_edits",
            format!("{path} carries an empty `edits` list, so the call asks for nothing."),
        ));
    }
    let mut spans = Vec::with_capacity(edits.len());
    for edit in edits {
        if edit.old_text.is_empty() {
            return Err(LspError::new(
                "empty_anchor",
                format!(
                    "An edit of {path} has an empty `oldText`. An anchor is the text being \
                     replaced; to add a line, anchor on the line it goes next to and put both in \
                     `newText`."
                ),
            ));
        }
        let mut found = text.match_indices(edit.old_text.as_str());
        let Some((start, _)) = found.next() else {
            return Err(anchor_not_found(path, text, &edit.old_text));
        };
        if found.next().is_some() {
            return Err(LspError::new(
                "anchor_not_unique",
                format!(
                    "`oldText` appears more than once in {path}, so it names no single region. \
                     Extend the anchor with a surrounding line until it is unique."
                ),
            ));
        }
        spans.push((start, start + edit.old_text.len(), edit.new_text.as_str()));
    }
    spans.sort_by_key(|&(start, _, _)| start);
    if let Some(overlap) = spans
        .windows(2)
        .find(|pair| pair[0].1 > pair[1].0)
        .map(|pair| pair[0].1)
    {
        return Err(LspError::new(
            "overlapping_edits",
            format!(
                "Two edits of {path} cover the same text, around byte {overlap}. Merge them into \
                 one edit whose `oldText` spans both."
            ),
        ));
    }
    let mut updated = String::with_capacity(text.len());
    let mut cursor = 0;
    for (start, end, new_text) in spans {
        updated.push_str(&text[cursor..start]);
        updated.push_str(new_text);
        cursor = end;
    }
    updated.push_str(&text[cursor..]);
    Ok(updated)
}

/// Applies targeted replacements across one or more scripts, then answers with the diagnostics the
/// server published for what was written.
///
/// The hash guard a save needs is absent on purpose. Every file is read inside this call and the
/// anchors are matched against that read, so the window a token would protect is the microseconds
/// between the read and the write — and an anchor edit preserves every line it did not match,
/// which a whole-buffer save cannot claim.
///
/// Every document is synchronized before any diagnostics are pulled, so the publications for a
/// nine-file edit arrive while the first wait is still running. That is what makes a single
/// deadline for the whole batch the right one: a file reached after the deadline has passed is
/// answered as unpublished rather than waited on again, because the server had the whole window to
/// speak about it and did not.
pub fn edit_documents(request: EditScriptRequest) -> Result<Vec<EditedScript>, LspError> {
    let (client, workspace) = connection()?;
    if request.files.is_empty() {
        return Err(LspError::new(
            "no_files",
            "`files` is empty, so the call asks for nothing.",
        ));
    }
    if let Some(repeated) = request
        .files
        .iter()
        .enumerate()
        .find(|(index, file)| {
            request.files[..*index]
                .iter()
                .any(|earlier| earlier.path == file.path)
        })
        .map(|(_, file)| file.path.clone())
    {
        return Err(LspError::new(
            "repeated_file",
            format!(
                "{repeated} is named twice. Every file is read once, so the second entry would \
                 anchor against text the first entry already replaced. Put both sets of edits in \
                 one entry."
            ),
        ));
    }
    let mut planned = Vec::with_capacity(request.files.len());
    for file in &request.files {
        let contents = workspace.read(&file.path).map_err(file_error)?;
        let updated_text = apply_edits(&file.path, &contents.text, &file.edits)?;
        planned.push(PlannedFile {
            path: file.path.clone(),
            original_hash: contents.hash,
            original_text: contents.text,
            updated_text,
        });
    }
    let stamps = godot_lsp::commit_planned_edit(&workspace, &planned)?;
    let mut synchronized = Vec::with_capacity(planned.len());
    for ((file, plan), stamp) in request.files.iter().zip(&planned).zip(stamps) {
        let uri = godot_lsp::file_uri(&workspace, &plan.path)?;
        let version = if client.is_open(&uri) {
            client.change_document(&uri, &plan.updated_text)?
        } else {
            client.open_document(&uri, &plan.updated_text)?
        };
        client.save_document(&uri, &plan.updated_text)?;
        request_rescan(&plan.path);
        synchronized.push((uri, stamp, version, file.edits.len()));
    }
    collect_published(
        synchronized,
        Duration::from_millis(DEFAULT_DIAGNOSTICS_WAIT_MS),
        |uri, wait| client.diagnostics(uri, wait),
    )
}

/// Reads each synchronized document's diagnostics under one deadline for the whole batch.
///
/// One deadline, not one per file. Every file used to be given its own full wait, so the cost of a
/// server that publishes nothing was the wait times the number of files: nine silent files were
/// forty-five seconds, from a call whose caller was told it costs five. Split out from
/// `edit_documents` because that function reaches a process-global language server and this rule —
/// how long each file is given — is the part worth holding to a test.
fn collect_published(
    synchronized: Vec<(Url, FileStamp, i32, usize)>,
    budget: Duration,
    mut pull: impl FnMut(&Url, Duration) -> Result<Option<PublishDiagnosticsParams>, LspError>,
) -> Result<Vec<EditedScript>, LspError> {
    let deadline = Instant::now() + budget;
    let mut edited = Vec::with_capacity(synchronized.len());
    for (uri, stamp, version, replaced) in synchronized {
        let published = pull(&uri, deadline.saturating_duration_since(Instant::now()))?;
        edited.push(EditedScript {
            path: stamp.path,
            hash: stamp.hash,
            bytes: stamp.bytes,
            version,
            replaced,
            diagnostics: published
                .as_ref()
                .map(|published| published.diagnostics.clone())
                .unwrap_or_default(),
            published: published.is_some(),
        });
    }
    Ok(edited)
}

/// Diagnostics for one document, as one entry of a batch answer.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsReport {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<i32>,
    pub diagnostics: Vec<Diagnostic>,
    /// False when the server published nothing for that document within the batch's window.
    pub published: bool,
}

/// Reads the diagnostics published for several documents under one deadline for the whole batch.
///
/// One deadline, not one per file — the rule [`collect_published`] already holds for `edit`, for
/// the reason written there. It matters twice over here, because this is the call an agent makes,
/// and an agent that could only name one path at a time made nine calls in a row: nine tool
/// round-trips, nine answers to pay context for, and nine full waits when the server is silent.
pub fn diagnostics_for(
    paths: Vec<String>,
    timeout_ms: Option<u64>,
) -> Result<Vec<DiagnosticsReport>, LspError> {
    let (client, workspace) = connection()?;
    let budget = Duration::from_millis(
        timeout_ms
            .unwrap_or(DEFAULT_DIAGNOSTICS_WAIT_MS)
            .min(MAX_DIAGNOSTICS_WAIT_MS),
    );
    let uris = paths
        .iter()
        .map(|path| godot_lsp::file_uri(&workspace, path))
        .collect::<Result<Vec<_>, _>>()?;
    pull_published(paths, uris, budget, |uri, wait| {
        client.diagnostics(uri, wait)
    })
}

/// Reads each named document's diagnostics under one deadline for the whole batch.
///
/// Split out for the same reason [`collect_published`] is: this rule — that the window belongs to
/// the batch and not to each file — is the whole point of taking a list, and it reaches a
/// process-global language server everywhere else.
fn pull_published(
    paths: Vec<String>,
    uris: Vec<Url>,
    budget: Duration,
    mut pull: impl FnMut(&Url, Duration) -> Result<Option<PublishDiagnosticsParams>, LspError>,
) -> Result<Vec<DiagnosticsReport>, LspError> {
    let deadline = Instant::now() + budget;
    let mut reports = Vec::with_capacity(paths.len());
    for (path, uri) in paths.into_iter().zip(uris) {
        let published = pull(&uri, deadline.saturating_duration_since(Instant::now()))?;
        reports.push(DiagnosticsReport {
            path,
            version: published.as_ref().and_then(|published| published.version),
            published: published.is_some(),
            diagnostics: published
                .map(|published| published.diagnostics)
                .unwrap_or_default(),
        });
    }
    Ok(reports)
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
            // Through the batch reader, so one path and a list of them can never answer differently
            // about the same file.
            let report = diagnostics_for(vec![path], timeout_ms)?
                .pop()
                .expect("one path answers with one report");
            Ok(ScriptResponse::Diagnostics {
                path: report.path,
                version: report.version,
                published: report.published,
                diagnostics: report.diagnostics,
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
    // The same guard the editor's other two doors take. A language server answering about a
    // checkout the window has moved away from describes another task's files, and looks exactly
    // like an answer about this one.
    crate::godot_session_api::require_session_task_here().map_err(|refusal| {
        LspError::new("session_other_task", refusal.message).with_details(refusal.details)
    })?;
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

/// The editor the script commands bind to: the bound editor's language-server port and the
/// worktree it is bound to.
fn active_session() -> Option<(u16, String)> {
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
    let _ = rpc.call(CallRequest::new("resource.rescan", json!({"path": path})));
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

    fn edit(old_text: &str, new_text: &str) -> ScriptEdit {
        ScriptEdit {
            old_text: old_text.to_owned(),
            new_text: new_text.to_owned(),
        }
    }

    /// A silent server costs the batch one wait however many files are in it.
    ///
    /// The bug this pins is arithmetic no caller can see: every file used to be handed a fresh full
    /// wait, so a batch cost the wait times the number of files. Nine files at five seconds each is
    /// forty-five, from a call documented as five.
    ///
    /// The count and the budget are the test's, not the rule's — the rule is that the allowances
    /// handed out sum to no more than one budget, which holds for any count. Three files is the
    /// smallest batch where a per-file deadline would hand out the same number twice.
    #[test]
    fn a_silent_server_costs_the_batch_one_wait_and_not_one_per_file() {
        let budget = Duration::from_millis(300);
        let synchronized: Vec<(Url, FileStamp, i32, usize)> = ["a.gd", "b.gd", "c.gd"]
            .iter()
            .map(|path| {
                (
                    Url::parse(&format!("file:///w/{path}")).expect("uri"),
                    FileStamp {
                        path: (*path).to_owned(),
                        hash: "hash".to_owned(),
                        bytes: 1,
                    },
                    1,
                    1,
                )
            })
            .collect();

        let mut allowances = Vec::new();
        let started = Instant::now();
        let edited = collect_published(synchronized, budget, |_, wait| {
            allowances.push(wait);
            // A server that says nothing burns whatever it was given and answers `None`, which is
            // silence rather than a clean file.
            thread::sleep(wait);
            Ok(None)
        })
        .expect("a silent server is not an error");
        let elapsed = started.elapsed();

        assert_eq!(edited.len(), 3);
        assert!(edited.iter().all(|file| !file.published));
        assert_eq!(allowances.len(), 3);
        // The rule, stated for any count: one budget, shared. A per-file deadline hands out three.
        assert!(
            allowances.iter().sum::<Duration>() <= budget,
            "{allowances:?}"
        );
        assert!(
            allowances.windows(2).all(|pair| pair[1] <= pair[0]),
            "an allowance may only shrink: {allowances:?}"
        );
        // And the allowances are honoured rather than merely computed, with room for scheduling.
        assert!(elapsed < budget * 2, "the batch took {elapsed:?}");
    }

    /// Asking about several files shares one wait too, and answers about each one by name.
    ///
    /// The same rule as the test above, at the seam the agent reaches. `diagnostics` used to take
    /// one path, so a turn that had just written nine scripts asked nine times — nine full waits at
    /// the same budget the single call advertises, and nine answers to pay context for.
    #[test]
    fn asking_about_several_files_shares_one_wait_and_names_each_answer() {
        let budget = Duration::from_millis(300);
        let paths: Vec<String> = ["a.gd", "b.gd", "c.gd"].map(str::to_owned).to_vec();
        let uris: Vec<Url> = paths
            .iter()
            .map(|path| Url::parse(&format!("file:///w/{path}")).expect("uri"))
            .collect();

        let mut allowances = Vec::new();
        let reports = pull_published(paths.clone(), uris, budget, |_, wait| {
            allowances.push(wait);
            thread::sleep(wait);
            Ok(None)
        })
        .expect("a silent server is not an error");

        assert_eq!(
            reports
                .iter()
                .map(|report| &report.path)
                .collect::<Vec<_>>(),
            paths.iter().collect::<Vec<_>>(),
            "each answer names its own file, in the order the call asked"
        );
        // Silence is not a clean file, and the batch says so about every one of them.
        assert!(reports.iter().all(|report| !report.published));
        assert!(
            allowances.iter().sum::<Duration>() <= budget,
            "{allowances:?}"
        );
    }

    fn edited(text: &str, edits: &[ScriptEdit]) -> Result<String, LspError> {
        apply_edits("player.gd", text, edits)
    }

    /// Several anchors in one call are the whole point of the operation, and the one way to get
    /// them wrong is to apply an early replacement before locating a later one: every offset after
    /// it moves by the difference in length. So the two edits here are deliberately of different
    /// lengths, and the second one is the one that would land in the wrong place.
    #[test]
    fn every_anchor_is_located_before_any_of_them_is_replaced() {
        let text = "extends Node\n\nvar speed = 1\n\nfunc _ready():\n\tpass\n";

        let updated = edited(
            text,
            &[
                edit("var speed = 1", "var speed: float = 220.0"),
                edit("\tpass", "\tspeed = 0.0"),
            ],
        )
        .expect("both anchors are replaced");

        assert_eq!(
            updated,
            "extends Node\n\nvar speed: float = 220.0\n\nfunc _ready():\n\tspeed = 0.0\n"
        );
    }

    /// Three ways an edit names no single region, and all three are refused rather than resolved.
    /// A guess here writes the file, and the caller finds out from the next diagnostics pull.
    #[test]
    fn an_anchor_that_names_no_one_region_is_refused() {
        let text = "extends Node\n\nfunc a():\n\tpass\n\nfunc b():\n\tpass\n";

        assert_eq!(
            edited(text, &[edit("func c():", "func d():")])
                .expect_err("the anchor is not there")
                .code,
            "anchor_not_found"
        );
        assert_eq!(
            edited(text, &[edit("\tpass", "\treturn")])
                .expect_err("the anchor is in the file twice")
                .code,
            "anchor_not_unique"
        );
        assert_eq!(
            edited(text, &[edit("", "func c():\n\tpass\n")])
                .expect_err("an empty anchor names the whole file")
                .code,
            "empty_anchor"
        );
        assert_eq!(
            edited(text, &[])
                .expect_err("a file with no edits asks for nothing")
                .code,
            "no_edits"
        );
    }

    /// The refusal hands back the bytes the file holds, when the only difference is whitespace.
    ///
    /// This is `scripts/main.gd` on 2026-08-20, reduced. The model quoted `_disconnect_spider_events`
    /// one tab deeper than the file has it, was told to "read the file and anchor on text it
    /// currently has", and sent the identical call again instead. Both were refused. The region it
    /// needed was four lines away and the refusal was holding it.
    #[test]
    fn a_stray_tab_is_answered_with_the_bytes_the_file_actually_holds() {
        let text = concat!(
            "extends Node\n",
            "\n",
            "func _return_spider_to_pool(spider: StrategyUnit) -> void:\n",
            "\tactive_units.erase(spider)\n",
            "\tif selected_unit == spider:\n",
            "\t\tselected_unit = null\n",
            "\t_disconnect_spider_events(spider)\n",
            "\tspider.reset_for_pool()\n",
        );
        let one_tab_too_deep = concat!(
            "func _return_spider_to_pool(spider: StrategyUnit) -> void:\n",
            "\tactive_units.erase(spider)\n",
            "\tif selected_unit == spider:\n",
            "\t\tselected_unit = null\n",
            "\t\t_disconnect_spider_events(spider)\n",
            "\tspider.reset_for_pool()",
        );

        let refusal = edited(
            text,
            &[edit(one_tab_too_deep, "func _return_spider_to_pool():\n")],
        )
        .expect_err("the anchor is one tab off");

        assert_eq!(refusal.code, "anchor_not_found");
        // The file's own bytes, at the file's own indentation — not the squeezed form the region
        // was found with, which would be unusable as the next anchor.
        assert!(
            refusal
                .message
                .contains("\n\t_disconnect_spider_events(spider)\n"),
            "the region the file holds has to be in the refusal: {}",
            refusal.message
        );
        assert!(
            refusal.message.contains("lines 3 to 8"),
            "and it has to say where it is: {}",
            refusal.message
        );
    }

    /// An anchor that is near several regions still names none of them, so it picks none.
    ///
    /// The same rule `anchor_not_unique` follows one branch above: two regions is two answers, and
    /// choosing one would be a guess about which. Naming the lines is what the caller can act on.
    #[test]
    fn a_near_miss_in_several_places_names_the_lines_and_refuses_to_pick() {
        let text = "extends Node\n\nfunc a():\n\tpass\n\nfunc b():\n\t pass\n";

        let refusal = edited(text, &[edit("\tpass ", "\treturn")])
            .expect_err("the anchor is near both bodies");

        assert_eq!(refusal.code, "anchor_not_found");
        assert!(
            refusal.message.contains("matches 2 regions, at lines 4, 7"),
            "both regions have to be named: {}",
            refusal.message
        );
        assert!(
            !refusal.message.contains("Anchor on that text exactly"),
            "and none of them may be handed back as the answer: {}",
            refusal.message
        );
    }

    /// A region past the cap is named, never quoted in part.
    ///
    /// Truncation is the worse failure of the two, for the reason `OPEN_TEXT_BUDGET` records: a
    /// model handed half a block pastes that half back as `oldText` and is refused again, this
    /// time by a refusal that caused itself.
    #[test]
    fn a_near_miss_too_long_to_quote_is_named_by_its_lines_instead() {
        let body: String = (0..80)
            .map(|index| format!("\tprint(\"line {index} of a long function body\")\n"))
            .collect();
        let text = format!("extends Node\n\nfunc _ready() -> void:\n{body}");
        let one_tab_too_deep = text
            .trim_start_matches("extends Node\n\n")
            .replace("\tprint", "\t\tprint");

        let refusal = edited(
            &text,
            &[edit(&one_tab_too_deep, "func _ready() -> void:\n\tpass\n")],
        )
        .expect_err("the anchor is one tab off throughout");

        assert_eq!(refusal.code, "anchor_not_found");
        assert!(
            refusal.message.contains("too long to quote here"),
            "the cap has to say so: {}",
            refusal.message
        );
        assert!(
            refusal.message.contains("`func _ready() -> void:`"),
            "and it has to name where to look: {}",
            refusal.message
        );
        assert!(
            !refusal.message.contains("line 40 of a long function body"),
            "no part of the region may be quoted: {}",
            refusal.message
        );
    }

    /// An anchor the file does not resemble is answered with nothing, and that is the design.
    ///
    /// Two of the four anchors refused over the measured week were a stale idea of the file's
    /// content rather than its whitespace — one omitted six comment lines, one wrote `**bold**`
    /// where the file had a `###` heading. Squeezing whitespace does not reach either, and the
    /// refusal says so plainly instead of offering the nearest thing it can find. Silence is what
    /// kept the false-positive count at zero.
    #[test]
    fn an_anchor_the_file_does_not_resemble_is_answered_with_no_region_at_all() {
        let text = "### The kit has no letters\n\nSilkscreen is the only font.\n";

        let refusal = edited(
            text,
            &[edit("**The kit has no letters**\n", "## Letters\n")],
        )
        .expect_err("bold is not a heading");

        assert_eq!(refusal.code, "anchor_not_found");
        assert!(
            refusal
                .message
                .contains("Read the file and anchor on text it currently has."),
            "the fallback sentence is what a content mistake gets: {}",
            refusal.message
        );
        assert!(
            !refusal.message.contains("Apart from whitespace"),
            "and it must not claim a region it did not find: {}",
            refusal.message
        );
    }

    /// Two anchors that cover the same text are refused whichever order they arrive in, because
    /// the overlap check runs on the sorted spans rather than on the list as written.
    #[test]
    fn two_edits_over_the_same_text_are_refused_in_either_order() {
        let text = "extends Node\n\nfunc _ready():\n\tprint(\"hello world\")\n";
        let wide = edit("\tprint(\"hello world\")", "\tprint(\"hi\")");
        let narrow = edit("hello world", "goodbye");

        for pair in [
            [wide.clone(), narrow.clone()],
            [narrow.clone(), wide.clone()],
        ] {
            assert_eq!(
                edited(text, &pair)
                    .expect_err("the two anchors cover the same text")
                    .code,
                "overlapping_edits"
            );
        }
        // Adjacent is not overlapping: one ending where the next begins is two regions, not one.
        assert_eq!(
            edited(
                "extends Node\n",
                &[edit("extends ", "extends\t"), edit("Node\n", "Node2D\n")]
            )
            .expect("adjacent anchors are two regions"),
            "extends\tNode2D\n"
        );
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

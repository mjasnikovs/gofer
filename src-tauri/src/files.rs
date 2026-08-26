//! The single implementation of workspace file access.
//!
//! Every typed read, write, patch, move, and delete performed for the UI, the AI agent, or the
//! Godot addon goes through [`Workspace`]: paths are validated against the canonical worktree root,
//! writes are atomic, and every write carries the SHA-256 the caller expected to replace, so a
//! stale buffer reports a conflict instead of overwriting newer content. [`spawn_watcher`] reports
//! changes made behind Gofer's back — by Godot, the user, or a confined shell command.

use crate::paths;
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::JoinHandle;
use std::time::{Duration, UNIX_EPOCH};

/// Typed reads and writes are for text a human or a model edits, not for game assets.
pub const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;
/// What a thumbnail will decode. A 4K texture sits well under this; a packed atlas may not, and
/// the menu shows it an icon rather than spending a second and a gigabyte on a 16px square.
const MAX_THUMBNAIL_SOURCE_BYTES: u64 = 16 * 1024 * 1024;
/// An SVG is handed to the webview verbatim, so the cap is on what is reasonable to inline.
const MAX_SVG_BYTES: u64 = 256 * 1024;
/// Twice the 16px the row draws, so the square stays sharp on a HiDPI screen.
const THUMBNAIL_EDGE: u32 = 32;
/// The suffixes Godot appends to a file to hold its own record of that file.
///
/// `<script>.gd.uid` carries the stable id a scene refers to the script by, and `<asset>.png.import`
/// carries how the asset was imported. Both are the file's, not the project's: Godot's own
/// FileSystem dock moves and deletes them with it, and a move that leaves the `.uid` behind gives
/// the file a **new** id while the old one stays at the old path — which is a scene that no longer
/// finds its script. Measured against a real 4.7.2 editor: moving `player.gd` alone produced
/// `ERROR: Attempt to open script 'res://scripts/player.gd' ... 'File not found'`, and the same
/// move carrying `player.gd.uid` produced nothing at all.
const SIDECARS: [&str; 2] = ["uid", "import"];
pub const MAX_RELATIVE_PATH_BYTES: usize = 1024;
const MAX_WALK_DEPTH: usize = 32;
const WATCH_POLL_SLICE: Duration = Duration::from_millis(50);
/// Directories whose churn never concerns Monaco or the language server.
///
/// `.gofer` is here for a second reason as well. The walk is what answers `godot_resource list`, so
/// a directory it enters is a file the agent is told the project has. A live project's list came
/// back two thirds Gofer's own compressed session logs, past the answer's size cap, to a model that
/// had asked what was in the project.
const IGNORED_DIRECTORIES: [&str; 7] = [
    ".git",
    ".godot",
    ".import",
    "node_modules",
    "target",
    "dist",
    crate::workspace::PROJECT_DATA_DIRECTORY,
];

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileError {
    pub code: &'static str,
    pub message: String,
    pub retryable: bool,
    pub details: Value,
}

impl FileError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            retryable: false,
            details: json!({}),
        }
    }

    fn with_details(mut self, details: Value) -> Self {
        self.details = details;
        self
    }

    /// Reports that the worktree itself could not be reached, before any path is considered.
    pub fn unavailable(message: impl Into<String>) -> Self {
        Self::new("workspace_unavailable", message)
    }

    /// Reports a failure raised by a layer built on top of the workspace, such as addon staging,
    /// so every file-shaped error the renderer sees carries the same code/retryable/details shape.
    pub fn refuse(code: &'static str, message: impl Into<String>, details: Value) -> Self {
        Self::new(code, message).with_details(details)
    }

    /// Marks a failure worth retrying, such as a locked or momentarily unreachable file.
    pub fn retry_later(mut self) -> Self {
        self.retryable = true;
        self
    }

    fn invalid_path(path: &str) -> Self {
        Self::new(
            "invalid_path",
            "Workspace paths must be relative paths inside the task worktree",
        )
        .with_details(json!({"path": path}))
    }

    fn outside(path: &str) -> Self {
        Self::new(
            "path_outside_workspace",
            "The path resolves outside the task worktree",
        )
        .with_details(json!({"path": path}))
    }

    fn not_found(path: &str) -> Self {
        Self::new("not_found", format!("{path} does not exist")).with_details(json!({"path": path}))
    }

    fn io(path: &str, error: &std::io::Error) -> Self {
        let mut failure = Self::new(
            "io_failed",
            format!("{path} could not be accessed: {error}"),
        )
        .with_details(json!({"path": path}));
        failure.retryable = true;
        failure
    }

    /// A write refused because the file is not the one the caller last read.
    ///
    /// The way out has to be in the sentence. "changed since it was read" is true and leads
    /// nowhere: a live agent hit it three times on the same script, each time with the same stale
    /// hash, and then wrote the file with the raw `write` tool instead — around the language
    /// server, which is the one thing this domain exists to keep in the loop.
    ///
    /// The three refusals are three different mistakes, and one sentence for all of them is what
    /// sent that agent in a circle: it had just re-read the script, held the current hash, passed
    /// none, and was told the file had changed — which it had not. So each case names itself.
    ///
    /// None of them names the hash. The only reader of this prose is a model, because the renderer
    /// drops the text and raises its own out-of-date bar instead, and `expectedHash` is hidden from
    /// the model's signature and filled in by the router from the read ledger. Telling that caller
    /// what it "passed" describes a parameter it cannot see, and every next step here is a call it
    /// can actually make.
    fn conflict(path: &str, expected: Option<&str>, actual: Option<&str>) -> Self {
        let message = match (expected, actual) {
            // Nothing was passed for a file that is already there: the ledger holds no record, so
            // this caller has never been told what the file contains.
            (None, Some(_)) => format!(
                "{path} exists but has not been read. Nothing was written. Read the file first, \
                 then save."
            ),
            // A hash for a file that is not there: the record outlived the file. The router drops
            // the record on this refusal, so saying "save it again" is true rather than a loop.
            (Some(_), None) => format!(
                "{path} no longer exists on disk. Nothing was written. Save it again to create the \
                 file."
            ),
            _ => format!(
                "{path} changed on disk since it was read. Nothing was written. Read the file \
                 again, then save."
            ),
        };
        Self::new("file_conflict", message)
            .with_details(json!({"path": path, "expectedHash": expected, "actualHash": actual}))
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContents {
    pub path: String,
    pub text: String,
    pub hash: String,
    pub bytes: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStamp {
    pub path: String,
    pub hash: String,
    pub bytes: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ChangeKind {
    Created,
    Modified,
    Removed,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    pub kind: ChangeKind,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteFileRequest {
    pub path: String,
    pub text: String,
    /// The hash the caller believes the file currently holds. `None` means "this file is new".
    #[serde(default)]
    pub expected_hash: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditFileRequest {
    pub path: String,
    pub expected_hash: String,
    pub find: String,
    pub replace: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeletePathRequest {
    pub path: String,
    #[serde(default)]
    pub expected_hash: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MovePathRequest {
    pub from: String,
    pub to: String,
}

/// What `godot_resource list` takes: one directory to narrow the walk to, and whether to hash
/// every file it reports.
///
/// A type rather than two `params.get` lookups, because the agent router used to read this call's
/// JSON by hand and `tool_drift` recovered its contract by parsing the arm's own source text —
/// which held the arm to a shape, an indentation and a spelling that no compiler was checking.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListPathsRequest {
    /// The directory to list, named the way the project names it. `None` is the whole worktree.
    #[serde(default)]
    pub under: Option<String>,
    /// Hashing is asked for rather than always done — see the arm that answers this.
    #[serde(default)]
    pub hashes: bool,
}

/// The fields [`DeletePathRequest`] deserializes, as serde spells them on the wire, and whether a
/// call may leave each one out.
///
/// Declared beside the type rather than recovered from it. `tool_drift` holds the catalogue's
/// parameter table to what the handler behind it really reads, and it used to do that by parsing
/// this file: find `struct X {`, read to the first `\n}`, split each line on its first `:`. A
/// field whose type wrapped onto a second line was dropped without a word, and a rename left the
/// whole comparison iterating an empty set. What a request takes is a fact about the request, so
/// it is written here, where changing the struct and not the list is the same edit.
#[cfg(test)]
pub const DELETE_PATH_FIELDS: &[(&str, bool)] = &[("path", false), ("expectedHash", true)];

/// The fields [`MovePathRequest`] deserializes. See [`DELETE_PATH_FIELDS`].
#[cfg(test)]
pub const MOVE_PATH_FIELDS: &[(&str, bool)] = &[("from", false), ("to", false)];

/// The fields [`ListPathsRequest`] deserializes. See [`DELETE_PATH_FIELDS`].
#[cfg(test)]
pub const LIST_PATHS_FIELDS: &[(&str, bool)] = &[("under", true), ("hashes", true)];

/// A canonical worktree root plus every operation allowed inside it.
#[derive(Clone, Debug)]
pub struct Workspace {
    root: PathBuf,
}

impl Workspace {
    pub fn open(root: &Path) -> Result<Self, FileError> {
        let canonical = paths::canonical(root)
            .map_err(|error| FileError::io(&root.display().to_string(), &error))?;
        if !canonical.is_dir() {
            return Err(FileError::new(
                "workspace_unavailable",
                format!("{} is not a directory", canonical.display()),
            ));
        }
        Ok(Self { root: canonical })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    // coverage-critical-start: path
    /// Maps a workspace-relative path onto disk, refusing traversal, absolute paths, and every
    /// symlink whose real location leaves the worktree.
    pub fn resolve(&self, relative: &str) -> Result<PathBuf, FileError> {
        let cleaned = validate_relative(relative)?;
        let target = self.root.join(&cleaned);
        let mut existing = target.as_path();
        loop {
            match paths::canonical(existing) {
                Ok(real) => {
                    // A short root can stay plain while a long path under it needs the verbatim
                    // prefix, so the two spellings are levelled before they are compared.
                    if !paths::simplified(&real).starts_with(paths::simplified(&self.root)) {
                        return Err(FileError::outside(relative));
                    }
                    return Ok(target);
                }
                Err(_) => {
                    existing = existing
                        .parent()
                        .ok_or_else(|| FileError::outside(relative))?;
                    if !existing.starts_with(&self.root) {
                        return Err(FileError::outside(relative));
                    }
                }
            }
        }
    }
    // coverage-critical-end: path

    pub fn read(&self, relative: &str) -> Result<FileContents, FileError> {
        let path = self.resolve(relative)?;
        // `resolve` already proved the real location is inside the worktree, so following a
        // symlink here cannot leave it.
        let metadata = fs::metadata(&path).map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                FileError::not_found(relative)
            } else {
                FileError::io(relative, &error)
            }
        })?;
        if !metadata.is_file() {
            return Err(
                FileError::new("not_a_file", format!("{relative} is not a file"))
                    .with_details(json!({"path": relative})),
            );
        }
        if metadata.len() > MAX_FILE_BYTES {
            return Err(FileError::new(
                "file_too_large",
                format!("{relative} is larger than {MAX_FILE_BYTES} bytes"),
            )
            .with_details(json!({"path": relative, "bytes": metadata.len()})));
        }
        let bytes = fs::read(&path).map_err(|error| FileError::io(relative, &error))?;
        let text = String::from_utf8(bytes).map_err(|_| {
            FileError::new("not_text", format!("{relative} is not UTF-8 text"))
                .with_details(json!({"path": relative}))
        })?;
        Ok(FileContents {
            path: relative.to_owned(),
            hash: hash_text(&text),
            bytes: text.len() as u64,
            text,
        })
    }

    /// A `data:` URL small enough to draw beside a filename, or `None` when the file is not a
    /// picture.
    ///
    /// The webview cannot open a worktree file — there is no asset protocol, and the CSP allows
    /// `data:` and nothing else — so the square is built here. Anything the `image` crate decodes
    /// becomes previewable, which covers the formats a browser refuses: `.tga`, `.exr`, `.hdr`,
    /// `.dds`. SVG is the exception and needs no decoder; its own bytes are the picture.
    ///
    /// `None` is the answer for every ordinary reason a file has no preview — wrong extension, too
    /// large, corrupt, half-written by the agent a moment ago. A picker is decoration on top of a
    /// filename, and an error here would take the filename away too.
    pub fn thumbnail(&self, relative: &str) -> Result<Option<String>, FileError> {
        let path = self.resolve(relative)?;
        let Ok(metadata) = fs::metadata(&path) else {
            return Ok(None);
        };
        if !metadata.is_file() {
            return Ok(None);
        }
        let extension = path
            .extension()
            .map(|value| value.to_string_lossy().to_ascii_lowercase())
            .unwrap_or_default();
        if extension == "svg" {
            if metadata.len() > MAX_SVG_BYTES {
                return Ok(None);
            }
            let Ok(bytes) = fs::read(&path) else {
                return Ok(None);
            };
            return Ok(Some(format!(
                "data:image/svg+xml;base64,{}",
                STANDARD.encode(&bytes)
            )));
        }
        if !is_thumbnail_extension(&extension) || metadata.len() > MAX_THUMBNAIL_SOURCE_BYTES {
            return Ok(None);
        }
        let Ok(bytes) = fs::read(&path) else {
            return Ok(None);
        };
        Ok(encode_thumbnail(&bytes, &extension))
    }

    /// Replaces a file atomically. `expected_hash` is the optimistic-concurrency token: `None`
    /// claims the file does not exist yet, and a hash claims the file still holds exactly that
    /// content.
    pub fn write(
        &self,
        relative: &str,
        text: &str,
        expected_hash: Option<&str>,
    ) -> Result<FileStamp, FileError> {
        let path = self.resolve(relative)?;
        if text.len() as u64 > MAX_FILE_BYTES {
            return Err(FileError::new(
                "file_too_large",
                format!("{relative} would exceed {MAX_FILE_BYTES} bytes"),
            )
            .with_details(json!({"path": relative, "bytes": text.len()})));
        }
        let current = self.current_hash(relative, &path)?;
        match (expected_hash, current.as_deref()) {
            (None, None) => (),
            (Some(expected), Some(actual)) if expected == actual => (),
            (expected, actual) => return Err(FileError::conflict(relative, expected, actual)),
        }
        write_atomically(&path, text.as_bytes())
            .map_err(|error| FileError::io(relative, &error))?;
        Ok(FileStamp {
            path: relative.to_owned(),
            hash: hash_text(text),
            bytes: text.len() as u64,
        })
    }

    /// Replaces the single occurrence of `find`. Ambiguous or missing matches never write.
    pub fn edit(
        &self,
        relative: &str,
        expected_hash: &str,
        find: &str,
        replace: &str,
    ) -> Result<FileStamp, FileError> {
        if find.is_empty() {
            return Err(
                FileError::new("invalid_edit", "The text to replace must not be empty")
                    .with_details(json!({"path": relative})),
            );
        }
        let contents = self.read(relative)?;
        if contents.hash != expected_hash {
            return Err(FileError::conflict(
                relative,
                Some(expected_hash),
                Some(&contents.hash),
            ));
        }
        let occurrences = contents.text.matches(find).count();
        if occurrences != 1 {
            return Err(FileError::new(
                "edit_not_unique",
                format!("The text to replace occurs {occurrences} times in {relative}"),
            )
            .with_details(json!({"path": relative, "occurrences": occurrences})));
        }
        let updated = contents.text.replace(find, replace);
        self.write(relative, &updated, Some(&contents.hash))
    }

    pub fn move_path(&self, from: &str, to: &str) -> Result<(), FileError> {
        self.reject_live_sidecar(from)?;
        let source = self.resolve(from)?;
        let destination = self.resolve(to)?;
        if !source.exists() {
            return Err(FileError::not_found(from));
        }
        if destination.exists() {
            return Err(
                FileError::new("already_exists", format!("{to} already exists"))
                    .with_details(json!({"path": to})),
            );
        }
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).map_err(|error| FileError::io(to, &error))?;
        }
        fs::rename(&source, &destination).map_err(|error| FileError::io(to, &error))?;
        for suffix in SIDECARS {
            let carried = self.resolve(&format!("{from}.{suffix}"))?;
            if carried.exists() {
                let landing = self.resolve(&format!("{to}.{suffix}"))?;
                // Renamed over whatever is there. A sidecar at the destination with no file of its
                // own is metadata for something that does not exist, and leaving it would give the
                // moved file that dead file's uid.
                fs::rename(&carried, &landing).map_err(|error| FileError::io(to, &error))?;
            }
        }
        Ok(())
    }

    /// Deletes one file or one empty directory. Recursive deletion is deliberately absent.
    pub fn delete(&self, relative: &str, expected_hash: Option<&str>) -> Result<(), FileError> {
        self.reject_live_sidecar(relative)?;
        let path = self.resolve(relative)?;
        let metadata = fs::symlink_metadata(&path).map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                FileError::not_found(relative)
            } else {
                FileError::io(relative, &error)
            }
        })?;
        if metadata.is_dir() {
            return fs::remove_dir(&path).map_err(|error| FileError::io(relative, &error));
        }
        if let Some(expected) = expected_hash {
            let actual = self.current_hash(relative, &path)?;
            if actual.as_deref() != Some(expected) {
                return Err(FileError::conflict(
                    relative,
                    Some(expected),
                    actual.as_deref(),
                ));
            }
        }
        fs::remove_file(&path).map_err(|error| FileError::io(relative, &error))?;
        for suffix in SIDECARS {
            let carried = self.resolve(&format!("{relative}.{suffix}"))?;
            if carried.exists() {
                fs::remove_file(&carried).map_err(|error| FileError::io(relative, &error))?;
            }
        }
        Ok(())
    }

    /// Refuses a path that is one live file's metadata rather than a file of its own.
    ///
    /// Naming a sidecar directly is always a mistake while the file it describes is still there:
    /// taking `player.gd.uid` away from `player.gd` is exactly the breakage [`SIDECARS`] exists to
    /// prevent, done deliberately. An *orphan* is the opposite — metadata for a file that is gone —
    /// and removing one is a tidy-up, so it is allowed through.
    fn reject_live_sidecar(&self, relative: &str) -> Result<(), FileError> {
        let Some((owner, suffix)) = relative.rsplit_once('.') else {
            return Ok(());
        };
        if !SIDECARS.contains(&suffix) || !self.resolve(owner)?.exists() {
            return Ok(());
        }
        Err(FileError::new(
            "sidecar_path",
            format!("{relative} is Godot's own record of {owner} and moves and dies with it"),
        )
        .with_details(json!({"path": relative, "owner": owner})))
    }

    /// The content hash of one file, or `None` when there is no file there.
    ///
    /// The same token [`Self::delete`] and [`Self::write`] check against, for callers holding a
    /// path rather than something they read. Reading a `.gd` script was the only way to obtain
    /// one, which left `expected_hash` unusable for every other kind of file — a scene or a
    /// resource could only be deleted unconditionally.
    pub fn hash_of(&self, relative: &str) -> Result<Option<String>, FileError> {
        let path = self.resolve(relative)?;
        self.current_hash(relative, &path)
    }

    fn current_hash(&self, relative: &str, path: &Path) -> Result<Option<String>, FileError> {
        match fs::read(path) {
            Ok(bytes) => Ok(Some(hash_bytes(&bytes))),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(FileError::io(relative, &error)),
        }
    }
}

// coverage-critical-start: path
/// Cleans one worktree-relative path, and refuses one that is not.
///
/// It takes `res://` off as well, and that is the confinement backstop rather than the place the
/// two conventions are reconciled. The router normalises every path an operation declares before an
/// arm sees it — see `ai_tools::as_the_worktree_names_them` — so nothing routed should still carry
/// the scheme by the time it arrives here; what does arrive with one is a caller that never went
/// through the router, which is the renderer's own commands.
///
/// Stripping here is also what made the missing normalisation invisible: an unnormalised
/// `godot_resource delete {"path": "res://levels/level.tscn"}` deleted the right file, while the
/// read ledger — keyed on the string the caller wrote — held no record of it and attached no hash
/// to guard it with. So this strips to refuse, never to translate.
fn validate_relative(relative: &str) -> Result<PathBuf, FileError> {
    let trimmed = relative.strip_prefix("res://").unwrap_or(relative);
    if trimmed.is_empty()
        || trimmed.len() > MAX_RELATIVE_PATH_BYTES
        || trimmed.chars().any(char::is_control)
    {
        return Err(FileError::invalid_path(relative));
    }
    let mut cleaned = PathBuf::new();
    for component in Path::new(trimmed).components() {
        match component {
            Component::Normal(part) => cleaned.push(part),
            Component::CurDir => (),
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(FileError::invalid_path(relative));
            }
        }
    }
    if cleaned.as_os_str().is_empty() {
        return Err(FileError::invalid_path(relative));
    }
    Ok(cleaned)
}
// coverage-critical-end: path

pub fn hash_text(text: &str) -> String {
    hash_bytes(text.as_bytes())
}

fn hash_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Writes through a sibling temporary file so a crash or a concurrent reader never observes a
/// half-written file. Renaming over a symlink replaces the link with a regular file, which is the
/// safe outcome: the worktree keeps the content it was asked to store.
pub fn write_atomically(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| std::io::Error::other("The file has no parent directory"))?;
    fs::create_dir_all(parent)?;
    let temporary = parent.join(format!(".gofer-{}.tmp", uuid::Uuid::now_v7()));
    let result = (|| {
        let mut file = File::create(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Stamp {
    pub bytes: u64,
    pub modified_ms: u64,
}

pub type Snapshot = BTreeMap<String, Stamp>;

/// Records size and modification time for every watchable file. Content hashes are deliberately
/// absent: a worktree holds game assets, and the change report exists to make callers re-read.
pub fn scan(root: &Path) -> Snapshot {
    let mut snapshot = Snapshot::new();
    collect(root, root, 0, &mut snapshot);
    snapshot
}

fn collect(root: &Path, directory: &Path, depth: usize, snapshot: &mut Snapshot) {
    if depth >= MAX_WALK_DEPTH {
        return;
    }
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            continue;
        };
        let name = entry.file_name().to_string_lossy().into_owned();
        if metadata.is_dir() {
            if !IGNORED_DIRECTORIES.contains(&name.as_str()) {
                collect(root, &path, depth + 1, snapshot);
            }
            continue;
        }
        // Symlinks are skipped rather than followed: their target may sit outside the worktree.
        if !metadata.is_file() {
            continue;
        }
        let Some(label) = relative_label(root, &path) else {
            continue;
        };
        snapshot.insert(
            label,
            Stamp {
                bytes: metadata.len(),
                modified_ms: modified_ms(&metadata),
            },
        );
    }
}

/// The extensions worth handing to a decoder. The gate is on the name, not the content, so a
/// `.blend` is never read to find out it is not a picture.
fn is_thumbnail_extension(extension: &str) -> bool {
    matches!(
        extension,
        "png"
            | "jpg"
            | "jpeg"
            | "webp"
            | "gif"
            | "bmp"
            | "ico"
            | "tga"
            | "tif"
            | "tiff"
            | "qoi"
            | "hdr"
            | "exr"
            | "dds"
    )
}

/// Decodes, shrinks to [`THUMBNAIL_EDGE`], and re-encodes as a PNG `data:` URL.
///
/// The re-encode is what lets a `.tga` or an `.exr` reach the webview at all: whatever went in,
/// a PNG comes out. A file that will not decode answers `None`.
///
/// The extension picks the decoder, and guessing is only the fallback. TGA carries no magic number
/// at the front of the file, so `load_from_memory` cannot recognise one at all — the extension is
/// the only thing that identifies it. Guessing still runs after, for the file that was saved as a
/// PNG and named `.jpg`, which an asset pipeline does often enough.
fn encode_thumbnail(bytes: &[u8], extension: &str) -> Option<String> {
    let named = image::ImageFormat::from_extension(extension)
        .and_then(|format| image::load_from_memory_with_format(bytes, format).ok());
    let decoded = match named {
        Some(image) => image,
        None => image::load_from_memory(bytes).ok()?,
    };
    let small = decoded.thumbnail(THUMBNAIL_EDGE, THUMBNAIL_EDGE);
    let mut png = std::io::Cursor::new(Vec::new());
    small.write_to(&mut png, image::ImageFormat::Png).ok()?;
    Some(format!(
        "data:image/png;base64,{}",
        STANDARD.encode(png.into_inner())
    ))
}

fn modified_ms(metadata: &fs::Metadata) -> u64 {
    metadata
        .modified()
        .unwrap_or(UNIX_EPOCH)
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or_default()
}

fn relative_label(root: &Path, path: &Path) -> Option<String> {
    let suffix = path.strip_prefix(root).ok()?;
    let mut label = String::new();
    for component in suffix.components() {
        let Component::Normal(part) = component else {
            return None;
        };
        if !label.is_empty() {
            label.push('/');
        }
        label.push_str(&part.to_string_lossy());
    }
    if label.is_empty() { None } else { Some(label) }
}

pub fn diff(previous: &Snapshot, next: &Snapshot) -> Vec<FileChange> {
    let mut changes = Vec::new();
    for (path, stamp) in next {
        match previous.get(path) {
            None => changes.push(FileChange {
                path: path.clone(),
                kind: ChangeKind::Created,
            }),
            Some(known) if known != stamp => changes.push(FileChange {
                path: path.clone(),
                kind: ChangeKind::Modified,
            }),
            Some(_) => (),
        }
    }
    for path in previous.keys() {
        if !next.contains_key(path) {
            changes.push(FileChange {
                path: path.clone(),
                kind: ChangeKind::Removed,
            });
        }
    }
    changes
}

/// Collapses repeated changes to the same path while the worktree is still settling.
#[derive(Debug, Default)]
pub struct ChangeBuffer {
    pending: BTreeMap<String, ChangeKind>,
}

impl ChangeBuffer {
    pub fn absorb(&mut self, changes: Vec<FileChange>) {
        for change in changes {
            let merged = match (self.pending.get(&change.path), change.kind) {
                (Some(ChangeKind::Created), ChangeKind::Modified) => ChangeKind::Created,
                (Some(ChangeKind::Removed), ChangeKind::Created) => ChangeKind::Modified,
                (_, kind) => kind,
            };
            if merged == ChangeKind::Removed
                && self.pending.get(&change.path) == Some(&ChangeKind::Created)
            {
                self.pending.remove(&change.path);
                continue;
            }
            self.pending.insert(change.path, merged);
        }
    }

    pub fn take(&mut self) -> Vec<FileChange> {
        std::mem::take(&mut self.pending)
            .into_iter()
            .map(|(path, kind)| FileChange { path, kind })
            .collect()
    }

    pub fn is_empty(&self) -> bool {
        self.pending.is_empty()
    }
}

/// Advances the debounce state by one scan. A batch is reported only once a scan finds nothing new,
/// so a burst of writes surfaces as one settled report.
pub fn watch_step(
    previous: &mut Snapshot,
    buffer: &mut ChangeBuffer,
    next: Snapshot,
) -> Option<Vec<FileChange>> {
    let changes = diff(previous, &next);
    *previous = next;
    if !changes.is_empty() {
        buffer.absorb(changes);
        return None;
    }
    if buffer.is_empty() {
        return None;
    }
    Some(buffer.take())
}

pub struct WatchHandle {
    stop: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}

impl WatchHandle {
    pub fn stop(mut self) {
        self.shutdown();
    }

    fn shutdown(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

impl Drop for WatchHandle {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// Polls the worktree and reports settled batches of external changes.
pub fn spawn_watcher<F>(workspace: Workspace, interval: Duration, emit: F) -> WatchHandle
where
    F: Fn(Vec<FileChange>) + Send + 'static,
{
    let stop = Arc::new(AtomicBool::new(false));
    let flag = Arc::clone(&stop);
    // The baseline is taken before the caller regains control, so a change made right after this
    // call is still reported.
    let mut previous = scan(workspace.root());
    let worker = std::thread::spawn(move || {
        let mut buffer = ChangeBuffer::default();
        while !flag.load(Ordering::Acquire) {
            if !sleep_until_stopped(&flag, interval) {
                return;
            }
            if let Some(batch) = watch_step(&mut previous, &mut buffer, scan(workspace.root())) {
                emit(batch);
            }
        }
    });
    WatchHandle {
        stop,
        worker: Some(worker),
    }
}

fn sleep_until_stopped(stop: &AtomicBool, interval: Duration) -> bool {
    let mut remaining = interval;
    while !remaining.is_zero() {
        if stop.load(Ordering::Acquire) {
            return false;
        }
        let slice = remaining.min(WATCH_POLL_SLICE);
        std::thread::sleep(slice);
        remaining -= slice;
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use std::sync::mpsc;

    fn workspace() -> (tempfile::TempDir, Workspace) {
        let directory = tempfile::tempdir().expect("temporary workspace");
        let workspace = Workspace::open(directory.path()).expect("workspace");
        (directory, workspace)
    }

    #[test]
    fn opening_rejects_missing_and_non_directory_roots() {
        let directory = tempfile::tempdir().expect("temporary workspace");
        let missing = directory.path().join("missing");
        assert_eq!(
            Workspace::open(&missing).expect_err("missing root").code,
            "io_failed"
        );
        let file = directory.path().join("file.txt");
        fs::write(&file, "x").expect("write file");
        assert_eq!(
            Workspace::open(&file).expect_err("file root").code,
            "workspace_unavailable"
        );
    }

    #[test]
    fn traversal_and_absolute_paths_are_rejected() {
        let (_directory, workspace) = workspace();
        for path in [
            "",
            "..",
            "../escape.gd",
            "nested/../../escape.gd",
            "res://",
            "with\0null.gd",
            "with\nnewline.gd",
            ".",
            "./",
        ] {
            assert_eq!(
                workspace.resolve(path).expect_err(path).code,
                "invalid_path",
                "{path}"
            );
        }
        let absolute = workspace.root().join("inside.gd").display().to_string();
        assert_eq!(
            workspace.resolve(&absolute).expect_err("absolute").code,
            "invalid_path"
        );
        assert_eq!(
            workspace
                .resolve(&"a".repeat(MAX_RELATIVE_PATH_BYTES + 1))
                .expect_err("long path")
                .code,
            "invalid_path"
        );
    }

    #[test]
    fn resolving_fails_once_the_worktree_itself_is_gone() {
        let (directory, workspace) = workspace();
        fs::remove_dir_all(directory.path()).expect("remove the worktree");
        assert_eq!(
            workspace
                .resolve("scripts/player.gd")
                .expect_err("a deleted worktree")
                .code,
            "path_outside_workspace"
        );
    }

    #[test]
    fn resolving_accepts_relative_godot_and_nested_paths() {
        let (_directory, workspace) = workspace();
        assert_eq!(
            workspace.resolve("res://scripts/player.gd").expect("godot"),
            workspace.root().join("scripts").join("player.gd")
        );
        assert_eq!(
            workspace.resolve("./scripts/./player.gd").expect("dotted"),
            workspace.root().join("scripts").join("player.gd")
        );
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_that_leave_the_workspace_are_rejected() {
        let outside = tempfile::tempdir().expect("outside directory");
        fs::write(outside.path().join("secret.txt"), "secret").expect("write secret");
        let (_directory, workspace) = workspace();
        std::os::unix::fs::symlink(outside.path(), workspace.root().join("link"))
            .expect("directory symlink");
        std::os::unix::fs::symlink(
            outside.path().join("secret.txt"),
            workspace.root().join("file-link"),
        )
        .expect("file symlink");
        assert_eq!(
            workspace
                .resolve("link/secret.txt")
                .expect_err("through a symlinked directory")
                .code,
            "path_outside_workspace"
        );
        assert_eq!(
            workspace
                .resolve("file-link")
                .expect_err("symlinked file")
                .code,
            "path_outside_workspace"
        );
        assert_eq!(
            workspace.read("link/secret.txt").expect_err("read").code,
            "path_outside_workspace"
        );
        assert_eq!(
            workspace
                .write("link/secret.txt", "x", None)
                .expect_err("write")
                .code,
            "path_outside_workspace"
        );
        std::os::unix::fs::symlink(
            workspace.root().join("kept.gd"),
            workspace.root().join("in"),
        )
        .expect("internal symlink");
        workspace.write("kept.gd", "kept", None).expect("write");
        assert_eq!(workspace.read("in").expect("internal").text, "kept");
    }

    #[test]
    fn writing_creates_reads_back_and_reports_hashes() {
        let (_directory, workspace) = workspace();
        let stamp = workspace
            .write("scripts/player.gd", "extends Node\n", None)
            .expect("create");
        assert_eq!(stamp.hash, hash_text("extends Node\n"));
        assert_eq!(stamp.bytes, 13);
        let contents = workspace.read("scripts/player.gd").expect("read");
        assert_eq!(contents.text, "extends Node\n");
        assert_eq!(contents.hash, stamp.hash);
        let updated = workspace
            .write("scripts/player.gd", "extends Node2D\n", Some(&stamp.hash))
            .expect("update");
        assert_eq!(
            workspace.read("scripts/player.gd").expect("re-read").hash,
            updated.hash
        );
        assert!(
            !fs::read_dir(workspace.root().join("scripts"))
                .expect("scripts")
                .flatten()
                .any(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
        );
    }

    /// The three refusals read as three different mistakes.
    ///
    /// A live agent opened a script, updated the buffer, saved with no hash, and was told the file
    /// had changed since it was read. It had not: the agent was holding the current hash and had
    /// left it out of the call. It re-read, saved without the hash again, got the same sentence,
    /// and gave up on this domain for the raw `write` tool.
    #[test]
    fn each_conflict_names_its_own_mistake() {
        let (_directory, workspace) = workspace();
        let stamp = workspace.write("a.gd", "one", None).expect("create");

        let omitted = workspace.write("a.gd", "two", None).expect_err("exists");
        assert!(
            omitted.message.contains("has not been read"),
            "an unread file must not be reported as an outside change: {}",
            omitted.message
        );

        let missing = workspace
            .write("b.gd", "two", Some(&stamp.hash))
            .expect_err("missing");
        assert!(
            missing.message.contains("no longer exists on disk"),
            "a record for a file that is not there must say so: {}",
            missing.message
        );

        workspace
            .write("a.gd", "two", Some(&stamp.hash))
            .expect("the hash from the last write saves over it");
        let stale = workspace
            .write("a.gd", "three", Some(&stamp.hash))
            .expect_err("stale");
        assert!(
            stale.message.contains("changed on disk since it was read"),
            "only a real outside change says so: {}",
            stale.message
        );

        // The prose is read by a model that cannot see `expectedHash` at all, so naming it — or
        // naming what the caller "passed" — is the failure this test exists to keep out.
        for refusal in [&omitted, &missing, &stale] {
            assert!(
                !refusal.message.contains("expectedHash")
                    && !refusal.message.contains("you passed"),
                "a refusal must not name a parameter its reader cannot pass: {}",
                refusal.message
            );
        }
    }

    #[test]
    fn stale_and_unexpected_writes_conflict() {
        let (_directory, workspace) = workspace();
        let stamp = workspace.write("a.gd", "one", None).expect("create");
        assert_eq!(
            workspace
                .write("a.gd", "two", None)
                .expect_err("exists")
                .code,
            "file_conflict"
        );
        workspace
            .write("a.gd", "two", Some(&stamp.hash))
            .expect("update");
        let stale = workspace
            .write("a.gd", "three", Some(&stamp.hash))
            .expect_err("stale");
        assert_eq!(stale.code, "file_conflict");
        assert_eq!(stale.details["expectedHash"], stamp.hash);
        assert_eq!(stale.details["actualHash"], hash_text("two"));
        assert_eq!(workspace.read("a.gd").expect("read").text, "two");
        assert_eq!(
            workspace
                .write("missing.gd", "x", Some(&stamp.hash))
                .expect_err("missing")
                .code,
            "file_conflict"
        );
    }

    #[test]
    fn external_edits_are_visible_to_the_next_read_and_block_stale_writes() {
        let (_directory, workspace) = workspace();
        let stamp = workspace.write("a.gd", "one", None).expect("create");
        fs::write(workspace.root().join("a.gd"), "edited by Godot").expect("external edit");
        let contents = workspace.read("a.gd").expect("read");
        assert_eq!(contents.text, "edited by Godot");
        assert_ne!(contents.hash, stamp.hash);
        assert_eq!(
            workspace
                .write("a.gd", "overwrite", Some(&stamp.hash))
                .expect_err("stale")
                .code,
            "file_conflict"
        );
        workspace
            .write("a.gd", "merged", Some(&contents.hash))
            .expect("fresh write");
    }

    #[test]
    fn reading_reports_missing_directories_binary_and_oversized_files() {
        let (_directory, workspace) = workspace();
        assert_eq!(
            workspace.read("missing.gd").expect_err("missing").code,
            "not_found"
        );
        fs::create_dir(workspace.root().join("folder")).expect("directory");
        assert_eq!(
            workspace.read("folder").expect_err("directory").code,
            "not_a_file"
        );
        fs::write(workspace.root().join("binary.bin"), [0xff, 0xfe, 0x00]).expect("binary");
        assert_eq!(
            workspace.read("binary.bin").expect_err("binary").code,
            "not_text"
        );
        fs::write(
            workspace.root().join("big.txt"),
            vec![b'a'; MAX_FILE_BYTES as usize + 1],
        )
        .expect("big file");
        assert_eq!(
            workspace.read("big.txt").expect_err("too large").code,
            "file_too_large"
        );
        assert_eq!(
            workspace
                .write("big.txt", &"a".repeat(MAX_FILE_BYTES as usize + 1), None)
                .expect_err("too large")
                .code,
            "file_too_large"
        );
    }

    #[test]
    fn editing_replaces_exactly_one_occurrence() {
        let (_directory, workspace) = workspace();
        let stamp = workspace
            .write("a.gd", "var speed = 1\nvar other = 2\n", None)
            .expect("create");
        let edited = workspace
            .edit("a.gd", &stamp.hash, "speed = 1", "speed = 3")
            .expect("edit");
        assert_eq!(
            workspace.read("a.gd").expect("read").text,
            "var speed = 3\nvar other = 2\n"
        );
        assert_eq!(
            workspace
                .edit("a.gd", &stamp.hash, "var", "let")
                .expect_err("stale")
                .code,
            "file_conflict"
        );
        assert_eq!(
            workspace
                .edit("a.gd", &edited.hash, "var", "let")
                .expect_err("ambiguous")
                .code,
            "edit_not_unique"
        );
        assert_eq!(
            workspace
                .edit("a.gd", &edited.hash, "missing", "x")
                .expect_err("absent")
                .code,
            "edit_not_unique"
        );
        assert_eq!(
            workspace
                .edit("a.gd", &edited.hash, "", "x")
                .expect_err("empty")
                .code,
            "invalid_edit"
        );
        assert_eq!(
            workspace
                .edit("missing.gd", &edited.hash, "a", "b")
                .expect_err("missing")
                .code,
            "not_found"
        );
    }

    #[test]
    fn moving_requires_a_source_and_a_free_destination() {
        let (_directory, workspace) = workspace();
        workspace.write("a.gd", "one", None).expect("create");
        workspace.write("taken.gd", "two", None).expect("create");
        assert_eq!(
            workspace
                .move_path("missing.gd", "b.gd")
                .expect_err("missing")
                .code,
            "not_found"
        );
        assert_eq!(
            workspace
                .move_path("a.gd", "taken.gd")
                .expect_err("taken")
                .code,
            "already_exists"
        );
        assert_eq!(
            workspace
                .move_path("a.gd", "../escape.gd")
                .expect_err("escape")
                .code,
            "invalid_path"
        );
        workspace
            .move_path("a.gd", "nested/moved.gd")
            .expect("move");
        assert_eq!(workspace.read("nested/moved.gd").expect("read").text, "one");
        assert_eq!(workspace.read("a.gd").expect_err("gone").code, "not_found");
    }

    #[test]
    fn deleting_checks_hashes_and_refuses_populated_directories() {
        let (_directory, workspace) = workspace();
        let stamp = workspace.write("a.gd", "one", None).expect("create");
        assert_eq!(
            workspace
                .delete("missing.gd", None)
                .expect_err("missing")
                .code,
            "not_found"
        );
        assert_eq!(
            workspace
                .delete("a.gd", Some(&hash_text("other")))
                .expect_err("stale")
                .code,
            "file_conflict"
        );
        workspace.write("nested/b.gd", "two", None).expect("create");
        assert_eq!(
            workspace
                .delete("nested", None)
                .expect_err("populated")
                .code,
            "io_failed"
        );
        workspace.delete("nested/b.gd", None).expect("delete file");
        workspace.delete("nested", None).expect("delete directory");
        workspace.delete("a.gd", Some(&stamp.hash)).expect("delete");
        assert!(!workspace.root().join("a.gd").exists());
    }

    /// Godot's own metadata travels with the file it belongs to.
    ///
    /// A `.gd.uid` left behind is not a stray file, it is a broken project. Measured against a real
    /// 4.7.2 editor on the `C03-clutter` worktree, whose `main.tscn` references its scripts the way
    /// every scene Gofer saves does — `uid="uid://o323pr5mlvad" path="res://scripts/player.gd"`:
    ///
    /// * moving `player.gd` alone and reimporting →
    ///   `ERROR: Attempt to open script 'res://scripts/player.gd' resulted in error 'File not
    ///   found'.`
    /// * moving `player.gd` **and** `player.gd.uid` and reimporting → no errors at all, and the
    ///   scene file still holds the old path. The uid resolved it. That is what the uid is for.
    ///
    /// The delete half is the same file seen from the other side: `old_save_system.gd.uid` outlived
    /// its script by a whole turn in three recorded live runs.
    #[test]
    fn godots_sidecars_move_and_die_with_the_file_they_belong_to() {
        let (_directory, workspace) = workspace();
        workspace
            .write("scripts/player.gd", "one", None)
            .expect("script");
        workspace
            .write("scripts/player.gd.uid", "uid://o323pr5mlvad", None)
            .expect("uid");
        workspace
            .write("assets/tiles.png", "png", None)
            .expect("asset");
        workspace
            .write("assets/tiles.png.import", "[remap]", None)
            .expect("import");

        workspace
            .move_path("scripts/player.gd", "entities/player.gd")
            .expect("move the script");
        assert_eq!(
            workspace
                .read("entities/player.gd.uid")
                .expect("the uid came too")
                .text,
            "uid://o323pr5mlvad"
        );
        assert_eq!(
            workspace
                .read("scripts/player.gd.uid")
                .expect_err("nothing left behind")
                .code,
            "not_found"
        );

        workspace
            .move_path("assets/tiles.png", "art/tiles.png")
            .expect("move the asset");
        assert_eq!(
            workspace
                .read("art/tiles.png.import")
                .expect("the import came too")
                .text,
            "[remap]"
        );

        workspace
            .delete("entities/player.gd", None)
            .expect("delete the script");
        assert_eq!(
            workspace
                .read("entities/player.gd.uid")
                .expect_err("the uid went too")
                .code,
            "not_found"
        );

        // A file with no sidecar is the ordinary case and must not become an error.
        workspace.write("notes.md", "text", None).expect("plain");
        workspace
            .move_path("notes.md", "docs/notes.md")
            .expect("move a bare file");
        workspace
            .delete("docs/notes.md", None)
            .expect("delete a bare file");

        // And a sidecar is not a file a caller may name. Moving one on its own would leave the
        // script it describes without a uid, which is the bug this test is about, backwards.
        workspace
            .write("scripts/main.gd", "two", None)
            .expect("script");
        workspace
            .write("scripts/main.gd.uid", "uid://x", None)
            .expect("uid");
        assert_eq!(
            workspace
                .move_path("scripts/main.gd.uid", "elsewhere.uid")
                .expect_err("refused")
                .code,
            "sidecar_path"
        );
        assert_eq!(
            workspace
                .delete("scripts/main.gd.uid", None)
                .expect_err("refused")
                .code,
            "sidecar_path"
        );
    }

    /// A tiny picture in whatever format the test asks for, written into the worktree.
    fn write_picture(workspace: &Workspace, relative: &str, format: image::ImageFormat) {
        let picture = image::RgbaImage::from_pixel(64, 48, image::Rgba([12, 34, 56, 255]));
        let mut bytes = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(picture)
            .write_to(&mut bytes, format)
            .expect("encode");
        let path = workspace.resolve(relative).expect("resolve");
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("create directory");
        }
        fs::write(path, bytes.into_inner()).expect("write picture");
    }

    /// Every format the `@` menu offers a square for reaches the webview as a PNG `data:` URL.
    ///
    /// TGA is the one that matters here: no browser opens it, and it only has a preview at all
    /// because it is decoded and re-encoded on this side.
    #[test]
    fn thumbnails_re_encode_every_decodable_picture_as_png() {
        let (_directory, workspace) = workspace();
        for (relative, format) in [
            ("sprites/player.png", image::ImageFormat::Png),
            ("sprites/tile.bmp", image::ImageFormat::Bmp),
            ("sprites/terrain.tga", image::ImageFormat::Tga),
        ] {
            write_picture(&workspace, relative, format);
            let square = workspace
                .thumbnail(relative)
                .expect("thumbnail")
                .unwrap_or_else(|| panic!("{relative} has no square"));
            assert!(square.starts_with("data:image/png;base64,"), "{relative}");
            let decoded = STANDARD
                .decode(square.trim_start_matches("data:image/png;base64,"))
                .expect("base64");
            let small = image::load_from_memory(&decoded).expect("decode square");
            // 64x48 shrunk to fit a 32px box, aspect ratio kept.
            assert_eq!((small.width(), small.height()), (32, 24), "{relative}");
        }
    }

    /// SVG needs no decoder — its own bytes are the picture — so it is passed through untouched.
    #[test]
    fn thumbnails_hand_an_svg_through_unchanged() {
        let (_directory, workspace) = workspace();
        let svg = "<svg xmlns='http://www.w3.org/2000/svg'/>";
        workspace
            .write("branding/logo.svg", svg, None)
            .expect("write");
        let square = workspace
            .thumbnail("branding/logo.svg")
            .expect("thumbnail")
            .expect("square");
        let prefix = "data:image/svg+xml;base64,";
        assert!(square.starts_with(prefix));
        assert_eq!(
            String::from_utf8(
                STANDARD
                    .decode(square.trim_start_matches(prefix))
                    .expect("base64")
            )
            .expect("utf8"),
            svg
        );
    }

    /// Every ordinary reason a file has no square answers `None`. A picker is decoration on top of
    /// a filename, and an error here would take the filename away with it.
    #[test]
    fn thumbnails_answer_none_rather_than_failing() {
        let (_directory, workspace) = workspace();
        workspace
            .write("scripts/player.gd", "extends Node", None)
            .expect("write");
        fs::create_dir_all(workspace.root().join("sprites")).expect("create directory");
        fs::write(workspace.root().join("sprites/broken.png"), b"not a png").expect("write");
        for relative in [
            "scripts/player.gd",  // not a picture
            "sprites/broken.png", // named like one, will not decode
            "sprites/gone.png",   // never existed
            "sprites",            // a directory
        ] {
            assert_eq!(
                workspace.thumbnail(relative).expect("thumbnail"),
                None,
                "{relative}"
            );
        }
    }

    /// The path guard is the same one every other read uses, and it still refuses.
    #[test]
    fn thumbnails_refuse_a_path_outside_the_worktree() {
        let (_directory, workspace) = workspace();
        assert_eq!(
            workspace
                .thumbnail("../secret.png")
                .expect_err("traversal")
                .code,
            "invalid_path"
        );
    }

    #[test]
    fn scanning_skips_ignored_directories_and_symlinks() {
        let (_directory, workspace) = workspace();
        workspace.write("kept.gd", "one", None).expect("create");
        workspace
            .write(".git/config", "ignored", None)
            .expect("create");
        workspace
            .write("node_modules/pkg/index.js", "ignored", None)
            .expect("create");
        // Gofer's own directory, which the agent's `godot_resource list` reads out of this walk. A
        // live project answered that call with two hundred lines of its own session logs.
        workspace
            .write(".gofer/logs/session/turn.jsonl.zst", "ignored", None)
            .expect("create");
        let snapshot = scan(workspace.root());
        assert_eq!(snapshot.keys().collect::<Vec<_>>(), vec!["kept.gd"]);
    }

    #[test]
    fn diffing_reports_creations_modifications_and_removals() {
        let (_directory, workspace) = workspace();
        let empty = scan(workspace.root());
        workspace.write("a.gd", "one", None).expect("create");
        let created = scan(workspace.root());
        assert_eq!(
            diff(&empty, &created),
            vec![FileChange {
                path: "a.gd".to_owned(),
                kind: ChangeKind::Created
            }]
        );
        assert!(diff(&created, &created).is_empty());
        fs::write(workspace.root().join("a.gd"), "one plus more").expect("external edit");
        let modified = scan(workspace.root());
        assert_eq!(
            diff(&created, &modified),
            vec![FileChange {
                path: "a.gd".to_owned(),
                kind: ChangeKind::Modified
            }]
        );
        assert_eq!(
            diff(&modified, &empty),
            vec![FileChange {
                path: "a.gd".to_owned(),
                kind: ChangeKind::Removed
            }]
        );
    }

    fn change(path: &str, kind: ChangeKind) -> FileChange {
        FileChange {
            path: path.to_owned(),
            kind,
        }
    }

    #[test]
    fn the_change_buffer_collapses_repeated_changes() {
        let mut buffer = ChangeBuffer::default();
        assert!(buffer.is_empty());
        buffer.absorb(vec![
            change("a.gd", ChangeKind::Created),
            change("b.gd", ChangeKind::Modified),
            change("c.gd", ChangeKind::Removed),
        ]);
        buffer.absorb(vec![
            change("a.gd", ChangeKind::Modified),
            change("b.gd", ChangeKind::Removed),
            change("c.gd", ChangeKind::Created),
        ]);
        assert_eq!(
            buffer.take(),
            vec![
                change("a.gd", ChangeKind::Created),
                change("b.gd", ChangeKind::Removed),
                change("c.gd", ChangeKind::Modified),
            ]
        );
        buffer.absorb(vec![change("d.gd", ChangeKind::Created)]);
        buffer.absorb(vec![change("d.gd", ChangeKind::Removed)]);
        assert!(buffer.is_empty(), "a created-then-removed file is not news");
        assert!(buffer.take().is_empty());
    }

    #[test]
    fn watching_reports_one_settled_batch_per_burst() {
        let (_directory, workspace) = workspace();
        let mut previous = scan(workspace.root());
        let mut buffer = ChangeBuffer::default();
        assert!(watch_step(&mut previous, &mut buffer, scan(workspace.root())).is_none());
        workspace.write("a.gd", "one", None).expect("create");
        assert!(
            watch_step(&mut previous, &mut buffer, scan(workspace.root())).is_none(),
            "a scan that saw changes waits for the worktree to settle"
        );
        workspace.write("b.gd", "two", None).expect("create");
        assert!(watch_step(&mut previous, &mut buffer, scan(workspace.root())).is_none());
        assert_eq!(
            watch_step(&mut previous, &mut buffer, scan(workspace.root())).expect("batch"),
            vec![
                change("a.gd", ChangeKind::Created),
                change("b.gd", ChangeKind::Created),
            ]
        );
        assert!(watch_step(&mut previous, &mut buffer, scan(workspace.root())).is_none());
    }

    #[test]
    fn the_watcher_thread_reports_external_changes_and_stops() {
        let (_directory, workspace) = workspace();
        let (sender, receiver) = mpsc::channel();
        let sender = Mutex::new(sender);
        let handle = spawn_watcher(workspace.clone(), Duration::from_millis(20), move |batch| {
            let _ = sender.lock().expect("watch sender").send(batch);
        });
        fs::write(workspace.root().join("a.gd"), "external").expect("external write");
        let batch = receiver
            .recv_timeout(Duration::from_secs(10))
            .expect("a change batch");
        assert_eq!(batch, vec![change("a.gd", ChangeKind::Created)]);
        handle.stop();
    }

    #[test]
    fn stopping_before_the_first_poll_ends_the_watcher() {
        let (_directory, workspace) = workspace();
        let handle = spawn_watcher(workspace, Duration::from_secs(30), |_| {
            panic!("a stopped watcher never reports")
        });
        handle.stop();
    }

    /// The scan walks a directory a user controls, so it has to end on its own terms rather than
    /// on the filesystem's. A tree deeper than the walk limit is truncated instead of recursing
    /// until the stack runs out, and a directory the process cannot read is skipped rather than
    /// failing the scan that a Godot import or a `.git` operation happened to race.
    #[test]
    fn scanning_stops_at_the_depth_limit_and_survives_unreadable_directories() {
        let (directory, workspace) = workspace();
        let mut deep = String::new();
        for _ in 0..MAX_WALK_DEPTH + 2 {
            deep.push_str("d/");
        }
        workspace
            .write(&format!("{deep}buried.gd"), "extends Node\n", None)
            .expect("create a file below the walk limit");
        workspace
            .write("shallow.gd", "extends Node\n", None)
            .expect("create");

        let snapshot = scan(workspace.root());

        assert!(
            snapshot.contains_key("shallow.gd"),
            "the walk limit must not cost the files above it"
        );
        assert!(
            !snapshot.keys().any(|path| path.ends_with("buried.gd")),
            "a tree past the walk limit is truncated, not followed"
        );

        // A path that is not a directory at all is the same non-event: the scan answers empty.
        assert!(scan(&directory.path().join("shallow.gd")).is_empty());
        assert!(scan(&directory.path().join("absent")).is_empty());
    }

    /// Every relative path arrives from a model or a renderer, so the rejections are the contract:
    /// a name that is empty once `res://` is stripped, one longer than the cap, one carrying
    /// control characters, and one that cleans away to nothing.
    #[test]
    fn relative_paths_are_refused_by_shape_before_they_reach_the_filesystem() {
        let (_directory, workspace) = workspace();

        for path in [
            "",
            "res://",
            "./",
            &"a".repeat(MAX_RELATIVE_PATH_BYTES + 1),
            "scripts/pla\u{7}yer.gd",
            "scripts/player\n.gd",
        ] {
            let error = workspace
                .resolve(path)
                .expect_err("a path of this shape never names a file");
            assert_eq!(error.code, "invalid_path", "{path:?}");
        }

        assert!(
            workspace
                .resolve(&"a".repeat(MAX_RELATIVE_PATH_BYTES))
                .is_ok(),
            "the cap itself is allowed"
        );
    }
}

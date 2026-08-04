//! Staging and removal of the Gofer addon inside a task worktree.
//!
//! The addon is bundled with Gofer and copied into `res://addons/gofer` together with a manifest
//! that records the content hash of every file Gofer wrote. `project.godot` gains exactly two
//! entries — the editor plugin and the runtime autoload — and Git's per-repository exclude file
//! gains one pattern. Everything Gofer introduces is written to a cleanup ledger in Gofer's own
//! application data *before* the worktree is touched, so a crashed session is repairable: cleanup
//! removes only what the ledger claims, and only when it is still Gofer's.
//!
//! Every file the worktree receives goes through [`Workspace`], which is the single implementation
//! of workspace writes: paths stay inside the canonical worktree, replacement is atomic, and the
//! `project.godot` rewrite carries the hash it expected to replace, so an edit made while the
//! session was staging reports a conflict instead of losing the user's change.

use crate::files::{FileContents, FileError, Workspace, write_atomically};
use crate::git;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// The addon version, kept in step with the protocol the plugin speaks.
pub const ADDON_VERSION: &str = "2.0.0";
pub const ADDON_DIRECTORY: &str = "addons/gofer";
pub const MANIFEST_PATH: &str = "addons/gofer/gofer.manifest.json";
pub const PROJECT_FILE: &str = "project.godot";
pub const AUTOLOAD_NAME: &str = "GoferRuntime";
pub const AUTOLOAD_TARGET: &str = "*res://addons/gofer/runtime.gd";
pub const PLUGIN_ENTRY: &str = "res://addons/gofer/plugin.cfg";

const MANAGED_BY: &str = "gofer";
const PLUGIN_SECTION: &str = "editor_plugins";
const PLUGIN_KEY: &str = "enabled";
const AUTOLOAD_SECTION: &str = "autoload";
const EXCLUDE_PATTERN: &str = "addons/gofer/";
const EXCLUDE_MARKER: &str = "# Gofer: the managed Godot addon is never part of the project.";

/// The addon as shipped. `include_str!` keeps the files in the binary, so staging needs no
/// installation directory and cannot be tampered with between releases.
const ADDON_FILES: [(&str, &str); 3] = [
    (
        "addons/gofer/plugin.cfg",
        include_str!("../addon/plugin.cfg"),
    ),
    ("addons/gofer/plugin.gd", include_str!("../addon/plugin.gd")),
    (
        "addons/gofer/runtime.gd",
        include_str!("../addon/runtime.gd"),
    ),
];

/// Deepest first, so removal never meets a non-empty parent.
const ADDON_DIRECTORIES: [&str; 2] = ["addons/gofer", "addons"];

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddonManifest {
    pub managed_by: String,
    pub version: String,
    pub files: BTreeMap<String, String>,
}

/// What Gofer did to `[editor_plugins] enabled`. Cleanup removes Gofer's member and nothing else,
/// so a plugin enabled while the session ran survives.
#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginRecord {
    pub entry_added: bool,
    pub key_created: bool,
    pub section_created: bool,
}

/// What Gofer did to `[autoload]`. `previous_line` is the exact line an unmanaged autoload of the
/// same name held beforehand, which cleanup restores verbatim.
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoloadRecord {
    pub added: bool,
    pub previous_line: Option<String>,
    pub section_created: bool,
}

/// In a linked worktree `info/exclude` resolves to the shared Git directory, so `file` is the same
/// path for every task of one repository and the entry outlives any single session.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitExcludeRecord {
    pub file: String,
    pub added: bool,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerEntry {
    pub worktree: String,
    pub version: String,
    pub staged_at: u64,
    pub files: Vec<String>,
    pub directories: Vec<String>,
    pub plugin: PluginRecord,
    pub autoload: AutoloadRecord,
    pub git_exclude: Option<GitExcludeRecord>,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Ledger {
    #[serde(default)]
    pub entries: Vec<LedgerEntry>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Managed {
    /// No `addons/gofer` exists in the worktree.
    Absent,
    /// `addons/gofer` carries a Gofer manifest and may be replaced.
    Gofer(AddonManifest),
    /// Something else owns `addons/gofer`; Gofer refuses to touch it.
    Foreign,
}

/// Installs and removes the addon, keeping the cleanup ledger in Gofer's application data.
#[derive(Clone, Debug)]
pub struct AddonStager {
    ledger_path: PathBuf,
}

impl AddonStager {
    pub fn new(ledger_path: PathBuf) -> Self {
        Self { ledger_path }
    }

    pub fn ledger(&self) -> Result<Ledger, FileError> {
        let bytes = match fs::read(&self.ledger_path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Ledger::default());
            }
            Err(error) => {
                return Err(FileError::refuse(
                    "ledger_unreadable",
                    format!("The addon cleanup ledger could not be read: {error}"),
                    json!({"path": self.ledger_path.display().to_string()}),
                )
                .retry_later());
            }
        };
        serde_json::from_slice(&bytes).map_err(|error| {
            FileError::refuse(
                "ledger_unreadable",
                format!("The addon cleanup ledger is not valid JSON: {error}"),
                json!({"path": self.ledger_path.display().to_string()}),
            )
        })
    }

    fn save(&self, ledger: &Ledger) -> Result<(), FileError> {
        let text = serde_json::to_string_pretty(ledger).map_err(|error| {
            FileError::refuse(
                "ledger_write_failed",
                format!("The addon cleanup ledger could not be serialized: {error}"),
                json!({}),
            )
        })?;
        write_atomically(&self.ledger_path, format!("{text}\n").as_bytes()).map_err(|error| {
            FileError::refuse(
                "ledger_write_failed",
                format!("The addon cleanup ledger could not be written: {error}"),
                json!({"path": self.ledger_path.display().to_string()}),
            )
            .retry_later()
        })
    }

    pub fn staged(&self, worktree: &Path) -> Result<bool, FileError> {
        let key = worktree.display().to_string();
        Ok(self
            .ledger()?
            .entries
            .iter()
            .any(|entry| entry.worktree == key))
    }

    /// Installs the addon into `workspace`. A leftover entry from a crashed session is removed
    /// first, so staging is the repair path for the worktree it is about to use.
    pub fn stage(&self, workspace: &Workspace) -> Result<LedgerEntry, FileError> {
        self.unstage(workspace.root())?;
        let project = read_project_file(workspace)?;
        if let Managed::Foreign = managed_state(workspace)? {
            return Err(FileError::refuse(
                "addon_unmanaged",
                format!("{ADDON_DIRECTORY} exists but was not installed by Gofer"),
                json!({"path": ADDON_DIRECTORY, "worktree": workspace.root().display().to_string()}),
            ));
        }
        let mut ledger = self.ledger()?;
        let mut lines = split_lines(&project.text);
        let entry = LedgerEntry {
            worktree: workspace.root().display().to_string(),
            version: ADDON_VERSION.to_owned(),
            staged_at: now_millis(),
            files: staged_files(),
            directories: missing_directories(workspace),
            plugin: enable_plugin(&mut lines),
            autoload: add_autoload(&mut lines),
            git_exclude: plan_exclude(workspace.root(), &ledger),
        };
        // The ledger is written before the worktree changes: an entry describing work that never
        // happened cleans up to a no-op, while unrecorded work would be stranded forever.
        ledger.entries.push(entry.clone());
        self.save(&ledger)?;
        match install(workspace, &entry, &join_lines(&lines), &project.hash) {
            Ok(()) => Ok(entry),
            Err(error) => {
                let _ = self.unstage(workspace.root());
                Err(error)
            }
        }
    }

    /// Removes everything the ledger records for `worktree`. Reports whether an entry existed.
    pub fn unstage(&self, worktree: &Path) -> Result<bool, FileError> {
        let key = worktree.display().to_string();
        let mut ledger = self.ledger()?;
        let Some(position) = ledger
            .entries
            .iter()
            .position(|entry| entry.worktree == key)
        else {
            return Ok(false);
        };
        let entry = ledger.entries.remove(position);
        // The ledger is saved only once removal succeeded, so a failure leaves the entry to retry.
        revert(&entry, &ledger.entries)?;
        self.save(&ledger)?;
        Ok(true)
    }

    /// Removes leftovers from sessions that never stopped cleanly. Called before a new session
    /// starts and after a crash.
    pub fn repair(&self) -> Result<Vec<String>, FileError> {
        let mut repaired = Vec::new();
        for entry in self.ledger()?.entries {
            if self.unstage(Path::new(&entry.worktree))? {
                repaired.push(entry.worktree);
            }
        }
        Ok(repaired)
    }
}

/// Reports who owns `addons/gofer` in this worktree.
pub fn managed_state(workspace: &Workspace) -> Result<Managed, FileError> {
    if !workspace.resolve(ADDON_DIRECTORY)?.exists() {
        return Ok(Managed::Absent);
    }
    let manifest = match workspace.read(MANIFEST_PATH) {
        Ok(contents) => contents,
        Err(error) if error.code == "not_found" => return Ok(Managed::Foreign),
        Err(_) => return Ok(Managed::Foreign),
    };
    match serde_json::from_str::<AddonManifest>(&manifest.text) {
        Ok(manifest) if manifest.managed_by == MANAGED_BY => Ok(Managed::Gofer(manifest)),
        _ => Ok(Managed::Foreign),
    }
}

pub fn manifest() -> AddonManifest {
    AddonManifest {
        managed_by: MANAGED_BY.to_owned(),
        version: ADDON_VERSION.to_owned(),
        files: ADDON_FILES
            .iter()
            .map(|(path, text)| ((*path).to_owned(), crate::files::hash_text(text)))
            .collect(),
    }
}

fn staged_files() -> Vec<String> {
    ADDON_FILES
        .iter()
        .map(|(path, _)| (*path).to_owned())
        .chain(std::iter::once(MANIFEST_PATH.to_owned()))
        .collect()
}

fn missing_directories(workspace: &Workspace) -> Vec<String> {
    ADDON_DIRECTORIES
        .iter()
        .filter(|directory| {
            workspace
                .resolve(directory)
                .map(|path| !path.exists())
                .unwrap_or(false)
        })
        .map(|directory| (*directory).to_owned())
        .collect()
}

fn read_project_file(workspace: &Workspace) -> Result<FileContents, FileError> {
    workspace.read(PROJECT_FILE).map_err(|error| {
        if error.code != "not_found" {
            return error;
        }
        FileError::refuse(
            "project_missing",
            format!("{} holds no {PROJECT_FILE}", workspace.root().display()),
            json!({"worktree": workspace.root().display().to_string()}),
        )
    })
}

/// Writes the staged files, the manifest, the Git exclude entry, and finally `project.godot`,
/// which is the file Godot reads at startup.
fn install(
    workspace: &Workspace,
    entry: &LedgerEntry,
    project_text: &str,
    expected_project_hash: &str,
) -> Result<(), FileError> {
    for (path, text) in ADDON_FILES {
        install_file(workspace, path, text)?;
    }
    let manifest = serde_json::to_string_pretty(&manifest()).map_err(|error| {
        FileError::refuse(
            "addon_manifest_failed",
            format!("The addon manifest could not be serialized: {error}"),
            json!({}),
        )
    })?;
    install_file(workspace, MANIFEST_PATH, &format!("{manifest}\n"))?;
    write_exclude(entry.git_exclude.as_ref())?;
    workspace
        .write(PROJECT_FILE, project_text, Some(expected_project_hash))
        .map(|_| ())
}

/// Replaces a Gofer-owned file. The old file is removed first so content Gofer did not write —
/// a hand-edited addon script — is replaced rather than reported as a conflict.
fn install_file(workspace: &Workspace, path: &str, text: &str) -> Result<(), FileError> {
    ignore_missing(workspace.delete(path, None))?;
    workspace.write(path, text, None).map(|_| ())
}

fn ignore_missing(result: Result<(), FileError>) -> Result<(), FileError> {
    match result {
        Err(error) if error.code == "not_found" => Ok(()),
        other => other,
    }
}

fn revert(entry: &LedgerEntry, remaining: &[LedgerEntry]) -> Result<(), FileError> {
    // A worktree that no longer exists needs no file cleanup, but its shared exclude entry does.
    if let Ok(workspace) = Workspace::open(Path::new(&entry.worktree)) {
        restore_project_file(&workspace, entry)?;
        for path in &entry.files {
            ignore_missing(workspace.delete(path, None))?;
            // Godot 4.4+ writes a `<file>.uid` sidecar next to every script it imports. The
            // sidecar belongs to the Gofer-owned file and must leave with it, or the addon
            // directory survives unstage as what looks like a foreign leftover.
            ignore_missing(workspace.delete(&format!("{path}.uid"), None))?;
        }
        for directory in &entry.directories {
            // A directory the user filled with their own files stays.
            let _ = workspace.delete(directory, None);
        }
    }
    remove_exclude(entry, remaining);
    Ok(())
}

fn restore_project_file(workspace: &Workspace, entry: &LedgerEntry) -> Result<(), FileError> {
    let contents = match workspace.read(PROJECT_FILE) {
        Ok(contents) => contents,
        Err(error) if error.code == "not_found" => return Ok(()),
        Err(error) => return Err(error),
    };
    let mut lines = split_lines(&contents.text);
    disable_plugin(&mut lines, &entry.plugin);
    remove_autoload(&mut lines, &entry.autoload);
    let text = join_lines(&lines);
    if text == contents.text {
        return Ok(());
    }
    workspace
        .write(PROJECT_FILE, &text, Some(&contents.hash))
        .map(|_| ())
}

/// Decides who owns the exclude pattern. A pattern another task session wrote is Gofer's, and the
/// last session to stop removes it; a pattern the user wrote themselves is never touched.
fn plan_exclude(worktree: &Path, ledger: &Ledger) -> Option<GitExcludeRecord> {
    let file = git::common_directory(worktree)?
        .join("info")
        .join("exclude");
    let path = file.display().to_string();
    let present = fs::read_to_string(&file)
        .unwrap_or_default()
        .lines()
        .any(|line| line.trim() == EXCLUDE_PATTERN);
    let owned = ledger.entries.iter().any(|entry| {
        entry
            .git_exclude
            .as_ref()
            .is_some_and(|record| record.file == path && record.added)
    });
    Some(GitExcludeRecord {
        added: !present || owned,
        file: path,
    })
}

fn write_exclude(record: Option<&GitExcludeRecord>) -> Result<(), FileError> {
    let Some(record) = record.filter(|record| record.added) else {
        return Ok(());
    };
    let path = PathBuf::from(&record.file);
    if let Some(parent) = path.parent()
        && let Err(error) = fs::create_dir_all(parent)
    {
        return Err(exclude_failure(&record.file, &error));
    }
    let mut text = fs::read_to_string(&path).unwrap_or_default();
    if text.lines().any(|line| line.trim() == EXCLUDE_PATTERN) {
        return Ok(());
    }
    if !text.is_empty() && !text.ends_with('\n') {
        text.push('\n');
    }
    text.push_str(EXCLUDE_MARKER);
    text.push('\n');
    text.push_str(EXCLUDE_PATTERN);
    text.push('\n');
    write_atomically(&path, text.as_bytes()).map_err(|error| exclude_failure(&record.file, &error))
}

fn exclude_failure(path: &str, error: &std::io::Error) -> FileError {
    FileError::refuse(
        "git_exclude_failed",
        format!("Git's per-repository exclude file could not be updated: {error}"),
        json!({"path": path}),
    )
    .retry_later()
}

/// Drops Gofer's exclude entry, but only once no other task worktree of the same repository still
/// needs it: in a linked worktree they all share one exclude file.
fn remove_exclude(entry: &LedgerEntry, remaining: &[LedgerEntry]) {
    let Some(record) = entry.git_exclude.as_ref().filter(|record| record.added) else {
        return;
    };
    let shared = remaining.iter().any(|other| {
        other
            .git_exclude
            .as_ref()
            .is_some_and(|other| other.file == record.file)
    });
    if shared {
        return;
    }
    let path = PathBuf::from(&record.file);
    let Ok(text) = fs::read_to_string(&path) else {
        return;
    };
    let kept: Vec<&str> = text
        .lines()
        .filter(|line| {
            let line = line.trim();
            line != EXCLUDE_PATTERN && line != EXCLUDE_MARKER
        })
        .collect();
    let mut rewritten = kept.join("\n");
    if !rewritten.is_empty() {
        rewritten.push('\n');
    }
    let _ = write_atomically(&path, rewritten.as_bytes());
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or_default()
}

// `project.godot` is a Godot-owned configuration file, so Gofer edits the two lines it owns and
// leaves every other byte — comments, ordering, and unrelated settings — exactly as it found them.

fn split_lines(text: &str) -> Vec<String> {
    text.split('\n').map(str::to_owned).collect()
}

fn join_lines(lines: &[String]) -> String {
    lines.join("\n")
}

fn section_bounds(lines: &[String], section: &str) -> Option<(usize, usize)> {
    let header = format!("[{section}]");
    let start = lines.iter().position(|line| line.trim() == header)?;
    let end = lines[start + 1..]
        .iter()
        .position(|line| line.trim_start().starts_with('['))
        .map(|offset| start + 1 + offset)
        .unwrap_or(lines.len());
    Some((start, end))
}

fn create_section(lines: &mut Vec<String>, section: &str) -> (usize, usize) {
    while lines.last().is_some_and(|line| line.trim().is_empty()) {
        lines.pop();
    }
    lines.push(String::new());
    lines.push(format!("[{section}]"));
    lines.push(String::new());
    (lines.len() - 2, lines.len())
}

fn key_of(line: &str) -> Option<&str> {
    let (key, _) = line.split_once('=')?;
    let key = key.trim();
    if key.is_empty() || key.starts_with(';') || key.starts_with('[') {
        return None;
    }
    Some(key)
}

fn find_key(lines: &[String], bounds: (usize, usize), key: &str) -> Option<usize> {
    (bounds.0 + 1..bounds.1).find(|index| key_of(&lines[*index]) == Some(key))
}

/// The index a new key takes: after the last setting of the section, before its trailing blank
/// lines, and never between the header and the blank line Godot writes under it.
fn insert_index(lines: &[String], bounds: (usize, usize)) -> usize {
    let mut index = bounds.1;
    while index > bounds.0 + 2 && lines[index - 1].trim().is_empty() {
        index -= 1;
    }
    index
}

fn section_is_empty(lines: &[String], bounds: (usize, usize)) -> bool {
    (bounds.0 + 1..bounds.1).all(|index| lines[index].trim().is_empty())
}

fn remove_section(lines: &mut Vec<String>, bounds: (usize, usize)) {
    lines.drain(bounds.0..bounds.1);
    ensure_trailing_newline(lines);
}

fn ensure_trailing_newline(lines: &mut Vec<String>) {
    if lines.last().is_some_and(|line| !line.is_empty()) {
        lines.push(String::new());
    }
}

fn packed_string_array(entries: &[String]) -> String {
    let joined = entries
        .iter()
        .map(|entry| format!("\"{entry}\""))
        .collect::<Vec<_>>()
        .join(", ");
    format!("PackedStringArray({joined})")
}

fn parse_packed_string_array(value: &str) -> Vec<String> {
    let mut entries = Vec::new();
    let mut rest = value;
    while let Some(open) = rest.find('"') {
        let after = &rest[open + 1..];
        let Some(close) = after.find('"') else {
            break;
        };
        entries.push(after[..close].to_owned());
        rest = &after[close + 1..];
    }
    entries
}

fn enable_plugin(lines: &mut Vec<String>) -> PluginRecord {
    let (bounds, section_created) = match section_bounds(lines, PLUGIN_SECTION) {
        Some(bounds) => (bounds, false),
        None => (create_section(lines, PLUGIN_SECTION), true),
    };
    let Some(index) = find_key(lines, bounds, PLUGIN_KEY) else {
        let index = insert_index(lines, bounds);
        lines.insert(
            index,
            format!(
                "{PLUGIN_KEY}={}",
                packed_string_array(&[PLUGIN_ENTRY.to_owned()])
            ),
        );
        ensure_trailing_newline(lines);
        return PluginRecord {
            entry_added: true,
            key_created: true,
            section_created,
        };
    };
    let mut entries = parse_packed_string_array(&lines[index]);
    if entries.iter().any(|entry| entry == PLUGIN_ENTRY) {
        return PluginRecord {
            entry_added: false,
            key_created: false,
            section_created,
        };
    }
    entries.push(PLUGIN_ENTRY.to_owned());
    lines[index] = format!("{PLUGIN_KEY}={}", packed_string_array(&entries));
    PluginRecord {
        entry_added: true,
        key_created: false,
        section_created,
    }
}

fn disable_plugin(lines: &mut Vec<String>, record: &PluginRecord) {
    if !record.entry_added {
        return;
    }
    let Some(bounds) = section_bounds(lines, PLUGIN_SECTION) else {
        return;
    };
    let Some(index) = find_key(lines, bounds, PLUGIN_KEY) else {
        return;
    };
    let entries: Vec<String> = parse_packed_string_array(&lines[index])
        .into_iter()
        .filter(|entry| entry != PLUGIN_ENTRY)
        .collect();
    if entries.is_empty() && record.key_created {
        lines.remove(index);
    } else {
        lines[index] = format!("{PLUGIN_KEY}={}", packed_string_array(&entries));
    }
    drop_created_section(lines, record.section_created, PLUGIN_SECTION);
}

fn add_autoload(lines: &mut Vec<String>) -> AutoloadRecord {
    let (bounds, section_created) = match section_bounds(lines, AUTOLOAD_SECTION) {
        Some(bounds) => (bounds, false),
        None => (create_section(lines, AUTOLOAD_SECTION), true),
    };
    let line = format!("{AUTOLOAD_NAME}=\"{AUTOLOAD_TARGET}\"");
    let Some(index) = find_key(lines, bounds, AUTOLOAD_NAME) else {
        let index = insert_index(lines, bounds);
        lines.insert(index, line);
        ensure_trailing_newline(lines);
        return AutoloadRecord {
            added: true,
            previous_line: None,
            section_created,
        };
    };
    let previous_line = lines[index].clone();
    if previous_line == line {
        return AutoloadRecord {
            added: false,
            previous_line: None,
            section_created,
        };
    }
    lines[index] = line;
    AutoloadRecord {
        added: true,
        previous_line: Some(previous_line),
        section_created,
    }
}

fn remove_autoload(lines: &mut Vec<String>, record: &AutoloadRecord) {
    if !record.added {
        return;
    }
    let Some(bounds) = section_bounds(lines, AUTOLOAD_SECTION) else {
        return;
    };
    let Some(index) = find_key(lines, bounds, AUTOLOAD_NAME) else {
        return;
    };
    match &record.previous_line {
        Some(previous) => lines[index] = previous.clone(),
        None => {
            lines.remove(index);
            drop_created_section(lines, record.section_created, AUTOLOAD_SECTION);
        }
    }
}

fn drop_created_section(lines: &mut Vec<String>, section_created: bool, section: &str) {
    if !section_created {
        return;
    }
    let Some(bounds) = section_bounds(lines, section) else {
        return;
    };
    if section_is_empty(lines, bounds) {
        remove_section(lines, bounds);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;
    use tempfile::TempDir;

    const PROJECT: &str = "; Engine configuration file.\nconfig_version=5\n\n[application]\n\nconfig/name=\"Fixture\"\nrun/main_scene=\"res://main.tscn\"\n\n[rendering]\n\nrenderer/rendering_method=\"gl_compatibility\"\n";

    struct Fixture {
        _home: TempDir,
        _directory: TempDir,
        workspace: Workspace,
        stager: AddonStager,
    }

    fn fixture() -> Fixture {
        fixture_with(PROJECT)
    }

    fn fixture_with(project: &str) -> Fixture {
        let directory = TempDir::new().expect("temporary worktree");
        fs::write(directory.path().join(PROJECT_FILE), project).expect("project file");
        let home = TempDir::new().expect("temporary application data");
        Fixture {
            workspace: Workspace::open(directory.path()).expect("workspace"),
            stager: AddonStager::new(home.path().join("godot-addon-ledger.json")),
            _home: home,
            _directory: directory,
        }
    }

    fn project_text(fixture: &Fixture) -> String {
        fixture
            .workspace
            .read(PROJECT_FILE)
            .expect("project file")
            .text
    }

    /// Git inherits the environment of whatever ran the suite — a Git hook exports `GIT_DIR` and
    /// `GIT_INDEX_FILE` — so the test repositories are addressed the same scrubbed way `git.rs`
    /// addresses the real ones.
    fn git_command(directory: &Path, arguments: &[&str]) -> std::process::Output {
        Command::new("git")
            .args(arguments)
            .current_dir(directory)
            .env_remove("GIT_DIR")
            .env_remove("GIT_WORK_TREE")
            .env_remove("GIT_INDEX_FILE")
            .env_remove("GIT_OBJECT_DIRECTORY")
            .env_remove("GIT_ALTERNATE_OBJECT_DIRECTORIES")
            .env_remove("GIT_COMMON_DIR")
            .env_remove("GIT_PREFIX")
            .output()
            .expect("run Git")
    }

    fn git(directory: &Path, arguments: &[&str]) {
        let output = git_command(directory, arguments);
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn repository(directory: &Path) {
        git(directory, &["init", "-b", "master"]);
        git(directory, &["config", "user.name", "Gofer Test"]);
        git(
            directory,
            &["config", "user.email", "gofer@example.invalid"],
        );
        git(directory, &["add", "--all"]);
        git(directory, &["commit", "-m", "Initial"]);
    }

    #[test]
    fn staging_installs_the_addon_and_registers_it_once() {
        let fixture = fixture();

        let entry = fixture.stager.stage(&fixture.workspace).expect("stage");

        assert_eq!(entry.version, ADDON_VERSION);
        assert!(entry.plugin.entry_added);
        assert!(entry.autoload.added);
        assert_eq!(
            entry.directories,
            vec!["addons/gofer".to_owned(), "addons".to_owned()]
        );
        for (path, text) in ADDON_FILES {
            assert_eq!(fixture.workspace.read(path).expect(path).text, text);
        }
        let manifest: AddonManifest = serde_json::from_str(
            &fixture
                .workspace
                .read(MANIFEST_PATH)
                .expect("manifest")
                .text,
        )
        .expect("manifest json");
        assert_eq!(manifest, super::manifest());
        assert_eq!(
            managed_state(&fixture.workspace).expect("state"),
            Managed::Gofer(manifest)
        );
        let text = project_text(&fixture);
        assert!(text.contains(&format!(
            "[editor_plugins]\n\nenabled=PackedStringArray(\"{PLUGIN_ENTRY}\")"
        )));
        assert!(text.contains(&format!(
            "[autoload]\n\n{AUTOLOAD_NAME}=\"{AUTOLOAD_TARGET}\""
        )));
        assert!(text.contains("run/main_scene=\"res://main.tscn\""));
        assert!(
            fixture
                .stager
                .staged(fixture.workspace.root())
                .expect("staged")
        );
        assert_eq!(fixture.stager.ledger().expect("ledger").entries.len(), 1);
    }

    #[test]
    fn install_and_removal_cycles_leave_the_worktree_as_it_was() {
        let fixture = fixture();
        let before = project_text(&fixture);

        for _ in 0..3 {
            fixture.stager.stage(&fixture.workspace).expect("stage");
            assert!(
                fixture
                    .stager
                    .unstage(fixture.workspace.root())
                    .expect("unstage")
            );
            assert_eq!(project_text(&fixture), before);
            assert!(!fixture.workspace.root().join("addons").exists());
            assert!(fixture.stager.ledger().expect("ledger").entries.is_empty());
        }
        assert!(
            !fixture
                .stager
                .unstage(fixture.workspace.root())
                .expect("second unstage")
        );
    }

    #[test]
    fn unstage_removes_the_uid_sidecars_godot_writes_next_to_staged_scripts() {
        let fixture = fixture();
        fixture.stager.stage(&fixture.workspace).expect("stage");

        // The editor imports the staged scripts and records a UID cache file next to each one.
        for sidecar in ["addons/gofer/plugin.gd.uid", "addons/gofer/runtime.gd.uid"] {
            fixture
                .workspace
                .write(sidecar, "uid://goferacceptance\n", None)
                .expect("uid sidecar");
        }

        assert!(
            fixture
                .stager
                .unstage(fixture.workspace.root())
                .expect("unstage")
        );
        assert!(
            !fixture.workspace.root().join("addons").exists(),
            "no sidecar may strand the addon directory"
        );
    }

    #[test]
    fn staging_over_a_crashed_session_repairs_and_reinstalls() {
        let fixture = fixture();
        let before = project_text(&fixture);
        fixture.stager.stage(&fixture.workspace).expect("stage");
        let staged = project_text(&fixture);

        // A crash leaves the ledger entry and the worktree exactly as the first staging left them.
        let entry = fixture.stager.stage(&fixture.workspace).expect("restage");

        assert_eq!(
            fixture.stager.ledger().expect("ledger").entries,
            vec![entry]
        );
        assert_eq!(project_text(&fixture), staged);
        assert_eq!(
            fixture.stager.repair().expect("repair"),
            vec![fixture.workspace.root().display().to_string()]
        );
        assert_eq!(project_text(&fixture), before);
        assert!(fixture.stager.repair().expect("second repair").is_empty());
    }

    #[test]
    fn an_unmanaged_addon_directory_is_never_overwritten() {
        let fixture = fixture();
        let before = project_text(&fixture);
        fixture
            .workspace
            .write("addons/gofer/plugin.gd", "extends Node\n", None)
            .expect("foreign addon");

        let error = fixture
            .stager
            .stage(&fixture.workspace)
            .expect_err("an unmanaged addon");

        assert_eq!(error.code, "addon_unmanaged");
        assert_eq!(
            fixture
                .workspace
                .read("addons/gofer/plugin.gd")
                .expect("foreign addon")
                .text,
            "extends Node\n"
        );
        assert_eq!(project_text(&fixture), before);
        assert!(fixture.stager.ledger().expect("ledger").entries.is_empty());
    }

    #[test]
    fn a_manifest_written_by_someone_else_makes_the_directory_unmanaged() {
        let fixture = fixture();
        for manifest in ["{\"managedBy\":\"someone-else\"}", "not json", ""] {
            ignore_missing(fixture.workspace.delete(MANIFEST_PATH, None)).expect("clear");
            fixture
                .workspace
                .write(MANIFEST_PATH, manifest, None)
                .expect("foreign manifest");
            assert_eq!(
                managed_state(&fixture.workspace).expect("state"),
                Managed::Foreign,
                "{manifest}"
            );
        }
        assert_eq!(
            fixture
                .stager
                .stage(&fixture.workspace)
                .expect_err("unmanaged")
                .code,
            "addon_unmanaged"
        );
    }

    #[test]
    fn a_worktree_without_a_project_file_is_refused() {
        let directory = TempDir::new().expect("temporary worktree");
        let home = TempDir::new().expect("temporary application data");
        let workspace = Workspace::open(directory.path()).expect("workspace");
        let stager = AddonStager::new(home.path().join("ledger.json"));

        let error = stager.stage(&workspace).expect_err("no project file");

        assert_eq!(error.code, "project_missing");
        assert!(!directory.path().join("addons").exists());
    }

    #[test]
    fn existing_settings_and_concurrent_edits_survive_cleanup() {
        let fixture = fixture_with(
            "config_version=5\n\n[autoload]\n\nOther=\"*res://other.gd\"\n\n[editor_plugins]\n\nenabled=PackedStringArray(\"res://addons/other/plugin.cfg\")\n",
        );
        let before = project_text(&fixture);

        let entry = fixture.stager.stage(&fixture.workspace).expect("stage");
        assert!(!entry.plugin.section_created);
        assert!(!entry.autoload.section_created);
        assert!(project_text(&fixture).contains(&format!(
            "enabled=PackedStringArray(\"res://addons/other/plugin.cfg\", \"{PLUGIN_ENTRY}\")"
        )));

        // Godot enables another plugin and the user adds an autoload while the session runs.
        let contents = fixture.workspace.read(PROJECT_FILE).expect("project file");
        let concurrent = contents
            .text
            .replace(
                &format!("\"{PLUGIN_ENTRY}\")"),
                &format!("\"{PLUGIN_ENTRY}\", \"res://addons/third/plugin.cfg\")"),
            )
            .replace("Other=", "Added=\"*res://added.gd\"\nOther=");
        fixture
            .workspace
            .write(PROJECT_FILE, &concurrent, Some(&contents.hash))
            .expect("concurrent edit");

        fixture
            .stager
            .unstage(fixture.workspace.root())
            .expect("unstage");

        let text = project_text(&fixture);
        assert!(text.contains(
            "enabled=PackedStringArray(\"res://addons/other/plugin.cfg\", \"res://addons/third/plugin.cfg\")"
        ));
        assert!(text.contains("Added=\"*res://added.gd\""));
        assert!(text.contains("Other=\"*res://other.gd\""));
        assert!(!text.contains(PLUGIN_ENTRY));
        assert!(!text.contains(AUTOLOAD_NAME));
        assert_ne!(text, before);
    }

    #[test]
    fn an_unmanaged_autoload_of_the_same_name_is_restored() {
        let fixture = fixture_with(
            "config_version=5\n\n[autoload]\n\nGoferRuntime=\"*res://mine.gd\"\n\n[editor_plugins]\n\nenabled=PackedStringArray(\"res://addons/gofer/plugin.cfg\")\n",
        );
        let before = project_text(&fixture);

        let entry = fixture.stager.stage(&fixture.workspace).expect("stage");

        assert!(!entry.plugin.entry_added, "the entry was already enabled");
        assert_eq!(
            entry.autoload.previous_line.as_deref(),
            Some("GoferRuntime=\"*res://mine.gd\"")
        );
        assert!(project_text(&fixture).contains(AUTOLOAD_TARGET));

        fixture
            .stager
            .unstage(fixture.workspace.root())
            .expect("unstage");

        assert_eq!(project_text(&fixture), before);
    }

    #[test]
    fn staging_twice_over_the_same_entry_is_idempotent() {
        let fixture = fixture_with("config_version=5\n");

        let entry = fixture.stager.stage(&fixture.workspace).expect("stage");

        assert!(entry.plugin.section_created);
        assert!(entry.autoload.section_created);
        let text = project_text(&fixture);
        assert!(text.starts_with("config_version=5\n"));
        assert!(text.ends_with('\n'));

        fixture
            .stager
            .unstage(fixture.workspace.root())
            .expect("unstage");

        assert_eq!(project_text(&fixture), "config_version=5\n");
    }

    #[test]
    fn a_shared_git_exclude_entry_outlives_the_first_task() {
        let repository_directory = TempDir::new().expect("temporary repository");
        fs::write(repository_directory.path().join(PROJECT_FILE), PROJECT).expect("project file");
        repository(repository_directory.path());
        let worktree_root = TempDir::new().expect("temporary worktrees");
        let home = TempDir::new().expect("temporary application data");
        let stager = AddonStager::new(home.path().join("ledger.json"));
        let mut workspaces = Vec::new();
        for task in ["one", "two"] {
            let path = worktree_root.path().join(task);
            git(
                repository_directory.path(),
                &[
                    "worktree",
                    "add",
                    "-b",
                    &format!("gofer/task-{task}"),
                    path.to_str().expect("worktree path"),
                ],
            );
            workspaces.push(Workspace::open(&path).expect("workspace"));
        }
        let exclude = repository_directory
            .path()
            .join(".git")
            .join("info")
            .join("exclude");

        let first = stager.stage(&workspaces[0]).expect("stage the first task");
        let second = stager.stage(&workspaces[1]).expect("stage the second task");

        assert_eq!(
            first
                .git_exclude
                .as_ref()
                .map(|record| record.file.as_str()),
            Some(exclude.display().to_string().as_str())
        );
        assert!(first.git_exclude.expect("first record").added);
        assert!(
            second.git_exclude.expect("second record").added,
            "the second task shares the entry the first one wrote"
        );
        let excluded = fs::read_to_string(&exclude).expect("exclude file");
        assert_eq!(excluded.matches(EXCLUDE_PATTERN).count(), 1, "{excluded}");
        let status = git_command(workspaces[0].root(), &["status", "--porcelain"]);
        let status = String::from_utf8(status.stdout).expect("git status output");
        assert!(
            !status.contains("addons"),
            "the staged addon is invisible to Git: {status}"
        );

        stager
            .unstage(workspaces[0].root())
            .expect("unstage the first task");
        assert!(
            fs::read_to_string(&exclude)
                .expect("exclude file")
                .contains(EXCLUDE_PATTERN),
            "the second task still needs the entry"
        );

        stager
            .unstage(workspaces[1].root())
            .expect("unstage the second task");
        let excluded = fs::read_to_string(&exclude).expect("exclude file");
        assert!(!excluded.contains(EXCLUDE_PATTERN));
        assert!(!excluded.contains(EXCLUDE_MARKER));
    }

    #[test]
    fn a_deleted_worktree_still_releases_its_shared_exclude_entry() {
        let repository_directory = TempDir::new().expect("temporary repository");
        fs::write(repository_directory.path().join(PROJECT_FILE), PROJECT).expect("project file");
        repository(repository_directory.path());
        let worktree_root = TempDir::new().expect("temporary worktrees");
        let worktree = worktree_root.path().join("task");
        git(
            repository_directory.path(),
            &[
                "worktree",
                "add",
                "-b",
                "gofer/task-deleted",
                worktree.to_str().expect("worktree path"),
            ],
        );
        let home = TempDir::new().expect("temporary application data");
        let stager = AddonStager::new(home.path().join("ledger.json"));
        let workspace = Workspace::open(&worktree).expect("workspace");
        let root = workspace.root().to_path_buf();
        stager.stage(&workspace).expect("stage");
        let exclude = repository_directory
            .path()
            .join(".git")
            .join("info")
            .join("exclude");
        fs::remove_dir_all(&root).expect("remove the worktree");

        assert!(stager.unstage(&root).expect("unstage"));

        assert!(
            !fs::read_to_string(&exclude)
                .expect("exclude file")
                .contains(EXCLUDE_PATTERN)
        );
        assert!(stager.ledger().expect("ledger").entries.is_empty());
    }

    #[test]
    fn an_exclude_pattern_the_user_wrote_is_left_alone() {
        let repository_directory = TempDir::new().expect("temporary repository");
        fs::write(repository_directory.path().join(PROJECT_FILE), PROJECT).expect("project file");
        repository(repository_directory.path());
        let exclude = repository_directory
            .path()
            .join(".git")
            .join("info")
            .join("exclude");
        fs::create_dir_all(exclude.parent().expect("info directory")).expect("info directory");
        fs::write(&exclude, format!("{EXCLUDE_PATTERN}\n")).expect("user exclude");
        let home = TempDir::new().expect("temporary application data");
        let stager = AddonStager::new(home.path().join("ledger.json"));
        let workspace = Workspace::open(repository_directory.path()).expect("workspace");

        let entry = stager.stage(&workspace).expect("stage");

        assert!(!entry.git_exclude.expect("record").added);
        stager.unstage(workspace.root()).expect("unstage");
        assert_eq!(
            fs::read_to_string(&exclude).expect("exclude file"),
            format!("{EXCLUDE_PATTERN}\n")
        );
    }

    #[test]
    fn a_worktree_outside_a_repository_records_no_exclude_entry() {
        let fixture = fixture();

        let entry = fixture.stager.stage(&fixture.workspace).expect("stage");

        assert_eq!(entry.git_exclude, None);
        fixture
            .stager
            .unstage(fixture.workspace.root())
            .expect("unstage");
    }

    #[test]
    fn an_unreadable_ledger_is_reported_rather_than_ignored() {
        let home = TempDir::new().expect("temporary application data");
        let path = home.path().join("ledger.json");
        fs::write(&path, "{ not json").expect("broken ledger");
        let stager = AddonStager::new(path);

        assert_eq!(
            stager.ledger().expect_err("broken ledger").code,
            "ledger_unreadable"
        );

        let directory = home.path().join("missing").join("ledger.json");
        assert_eq!(
            AddonStager::new(directory)
                .ledger()
                .expect("a missing ledger is empty"),
            Ledger::default()
        );
    }

    #[test]
    fn the_ledger_round_trips_every_recorded_decision() {
        let fixture = fixture();
        let entry = fixture.stager.stage(&fixture.workspace).expect("stage");

        let reopened = AddonStager::new(fixture.stager.ledger_path.clone())
            .ledger()
            .expect("ledger");

        assert_eq!(reopened.entries, vec![entry.clone()]);
        assert!(entry.staged_at > 0);
        assert_eq!(
            entry.files,
            vec![
                "addons/gofer/plugin.cfg".to_owned(),
                "addons/gofer/plugin.gd".to_owned(),
                "addons/gofer/runtime.gd".to_owned(),
                MANIFEST_PATH.to_owned(),
            ]
        );
    }

    #[test]
    fn user_files_left_in_the_addon_directory_keep_it_alive() {
        let fixture = fixture();
        fixture.stager.stage(&fixture.workspace).expect("stage");
        fixture
            .workspace
            .write("addons/gofer/notes.txt", "mine", None)
            .expect("user file");

        fixture
            .stager
            .unstage(fixture.workspace.root())
            .expect("unstage");

        assert_eq!(
            fixture
                .workspace
                .read("addons/gofer/notes.txt")
                .expect("user file")
                .text,
            "mine"
        );
        assert_eq!(
            fixture
                .stager
                .stage(&fixture.workspace)
                .expect_err("the leftover directory is no longer Gofer's")
                .code,
            "addon_unmanaged"
        );
    }

    #[test]
    fn the_shipped_plugin_declares_the_staged_version() {
        let (_, plugin) = ADDON_FILES[0];
        assert!(plugin.contains(&format!("version=\"{ADDON_VERSION}\"")));
        assert!(manifest().files.len() == ADDON_FILES.len());
    }

    #[test]
    fn sections_and_keys_are_found_without_disturbing_neighbours() {
        let lines = split_lines("[a]\n\nkey=1\n; comment=2\n[b]\n\nkey=3\n");
        let a = section_bounds(&lines, "a").expect("section a");
        let b = section_bounds(&lines, "b").expect("section b");
        assert_eq!(find_key(&lines, a, "key"), Some(2));
        assert_eq!(find_key(&lines, b, "key"), Some(6));
        assert_eq!(find_key(&lines, a, "missing"), None);
        assert_eq!(section_bounds(&lines, "missing"), None);
        assert_eq!(key_of("; comment=2"), None);
        assert_eq!(key_of("[section]"), None);
        assert_eq!(key_of("=2"), None);
        assert_eq!(key_of("no equals sign"), None);
        assert_eq!(key_of(" key = 1"), Some("key"));
        assert!(!section_is_empty(&lines, a));
        assert!(section_is_empty(&split_lines("[a]\n\n"), (0, 2)));
    }

    #[test]
    fn packed_string_arrays_round_trip() {
        assert_eq!(
            parse_packed_string_array("enabled=PackedStringArray(\"a\", \"b\")"),
            vec!["a".to_owned(), "b".to_owned()]
        );
        assert_eq!(
            parse_packed_string_array("enabled=PackedStringArray()"),
            Vec::<String>::new()
        );
        assert_eq!(
            parse_packed_string_array("enabled=PackedStringArray(\"unterminated)"),
            Vec::<String>::new()
        );
        assert_eq!(
            packed_string_array(&["a".to_owned(), "b".to_owned()]),
            "PackedStringArray(\"a\", \"b\")"
        );
        assert_eq!(packed_string_array(&[]), "PackedStringArray()");
    }

    #[test]
    fn plugin_and_autoload_edits_are_reversible_in_every_starting_shape() {
        for project in [
            "config_version=5\n",
            "config_version=5\n\n[editor_plugins]\n\nenabled=PackedStringArray()\n",
            "config_version=5\n\n[autoload]\n\n[editor_plugins]\n\nenabled=PackedStringArray(\"res://addons/other/plugin.cfg\")\n",
            "[application]\n\nconfig/name=\"x\"",
        ] {
            let mut lines = split_lines(project);
            let plugin = enable_plugin(&mut lines);
            let autoload = add_autoload(&mut lines);
            let staged = join_lines(&lines);
            assert!(staged.contains(PLUGIN_ENTRY), "{project}");
            assert!(staged.contains(AUTOLOAD_TARGET), "{project}");
            assert!(staged.ends_with('\n'), "{project}");

            disable_plugin(&mut lines, &plugin);
            remove_autoload(&mut lines, &autoload);
            let restored = join_lines(&lines);
            assert!(!restored.contains(PLUGIN_ENTRY), "{project}");
            assert!(!restored.contains(AUTOLOAD_NAME), "{project}");
            assert!(restored.starts_with(project.trim_end()), "{project}");
        }
    }

    #[test]
    fn cleanup_tolerates_entries_a_user_already_removed() {
        let plugin = PluginRecord {
            entry_added: true,
            key_created: true,
            section_created: true,
        };
        let autoload = AutoloadRecord {
            added: true,
            previous_line: None,
            section_created: true,
        };
        let mut lines = split_lines("config_version=5\n");
        disable_plugin(&mut lines, &plugin);
        remove_autoload(&mut lines, &autoload);
        assert_eq!(join_lines(&lines), "config_version=5\n");

        let mut lines = split_lines("[editor_plugins]\n\n[autoload]\n\n");
        disable_plugin(&mut lines, &plugin);
        remove_autoload(&mut lines, &autoload);
        assert_eq!(join_lines(&lines), "[editor_plugins]\n\n[autoload]\n\n");

        let mut lines = split_lines("config_version=5\n");
        disable_plugin(
            &mut lines,
            &PluginRecord {
                entry_added: false,
                ..plugin
            },
        );
        remove_autoload(
            &mut lines,
            &AutoloadRecord {
                added: false,
                ..autoload.clone()
            },
        );
        assert_eq!(join_lines(&lines), "config_version=5\n");
    }
}

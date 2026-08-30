//! Skills: the instructions a project adds to its agent, and the tab that manages them.
//!
//! A skill is `.gofer/skills/<name>/SKILL.md`, and whatever else that directory holds beside it.
//! Only the name and description reach the model; the body is read with the agent's own read tool,
//! and only on the turn whose work matches the description. That is why the files live inside the
//! workspace: everything the agent reads is confined to it, so a skill kept anywhere else would be
//! a skill the model is told about and then refused when it reaches for it.
//!
//! Nothing here parses a skill. The loader is `@earendil-works/pi-agent-core`, in Node, where the
//! turn also composes its prompt from it — so `scripts/skills-worker.mjs` is asked instead. A
//! second parser in Rust would be a second answer to "is this file a skill", and the tab and the
//! turn would eventually disagree about a file neither of them wrote.
//!
//! A skill is found by asking the loader where it is, never by building a path out of the name the
//! renderer sent. The two are not the same string — pi takes a name from frontmatter and only
//! warns when it disagrees with the directory — and a path that came back from the loader is still
//! checked to be inside the skills directory before anything opens or deletes it.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime};

use crate::command_error::CommandError;
use crate::workspace::project_storage;

/// A skill no larger than this, matching `MAX_SKILL_BYTES` in `scripts/skills.mjs`.
const MAX_SKILL_BYTES: usize = 256 * 1024;

/// One row of the Skills tab.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Skill {
    pub name: String,
    pub description: String,
    pub path: String,
    /// Turned off in this project. The agent is never told it exists.
    #[serde(default)]
    pub enabled: bool,
    /// Hidden by the file's own `disable-model-invocation`, which the project cannot override.
    #[serde(default)]
    pub hidden: bool,
}

/// A file under `.gofer/skills` that is not a skill, and the sentence that explains why.
///
/// Shown rather than swallowed: a `SKILL.md` with no description loads as nothing at all, so
/// without this the row would simply never appear and the user would have no way to find out why.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillWarning {
    pub code: String,
    pub message: String,
    pub path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillsResponse {
    pub skills: Vec<Skill>,
    pub warnings: Vec<SkillWarning>,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum WorkerAnswer {
    List {
        skills: Vec<Skill>,
        warnings: Vec<SkillWarning>,
    },
    /// The import worked, and the loader decided this name. The command answers with the whole
    /// list rather than this one row, because a file that turns out to be invalid becomes a
    /// warning instead of a row — but the name is what proves the seam in a test.
    Imported {
        name: String,
    },
    Failed {
        message: String,
    },
}

fn worker_path() -> Result<PathBuf, String> {
    crate::workers::resolve(
        "The skills worker",
        "GOFER_SKILLS_WORKER",
        "skills-worker.mjs",
    )
}

/// Asks the loader one question and reads its one answer.
fn ask(request: &serde_json::Value) -> Result<WorkerAnswer, CommandError> {
    let node = crate::workers::node_binary();
    let worker = worker_path().map_err(CommandError::from)?;
    let mut child = Command::new(&node)
        .arg(&worker)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| {
            CommandError::new(
                "skills_worker_unavailable",
                format!(
                    "Could not start the skills worker with '{}': {error}",
                    node.to_string_lossy()
                ),
            )
        })?;
    {
        let mut stdin = child.stdin.take().ok_or_else(|| {
            CommandError::new(
                "skills_worker_unavailable",
                "Could not write to the skills worker".to_owned(),
            )
        })?;
        let mut line = serde_json::to_vec(request).map_err(|error| {
            CommandError::new(
                "skills_worker_unavailable",
                format!("Could not serialize the skills request: {error}"),
            )
        })?;
        line.push(b'\n');
        stdin.write_all(&line).map_err(|error| {
            CommandError::new(
                "skills_worker_unavailable",
                format!("Could not send the skills request: {error}"),
            )
        })?;
    }
    let output = child.wait_with_output().map_err(|error| {
        CommandError::new(
            "skills_worker_unavailable",
            format!("The skills worker did not answer: {error}"),
        )
    })?;
    let text = String::from_utf8_lossy(&output.stdout);
    let Some(line) = text.lines().last().filter(|line| !line.trim().is_empty()) else {
        let reason = String::from_utf8_lossy(&output.stderr);
        let detail = reason.trim();
        return Err(CommandError::new(
            "skills_worker_unavailable",
            if detail.is_empty() {
                "The skills worker answered nothing".to_owned()
            } else {
                format!("The skills worker failed: {detail}")
            },
        ));
    };
    match serde_json::from_str::<WorkerAnswer>(line) {
        Ok(WorkerAnswer::Failed { message }) => Err(CommandError::new("skill_refused", message)),
        Ok(answer) => Ok(answer),
        Err(error) => Err(CommandError::new(
            "skills_worker_unavailable",
            format!("The skills worker answered something unreadable: {error}"),
        )),
    }
}

/// Where the agent will look, which is the only place the tab may look.
fn workspace<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<(PathBuf, crate::storage::ProjectStorage), CommandError> {
    let storage = project_storage(app)?;
    let path = storage.tasks().agent_workspace()?;
    Ok((path, storage))
}

fn list_with(workspace_path: &Path, disabled: &[String]) -> Result<SkillsResponse, CommandError> {
    let answer = ask(&serde_json::json!({
        "operation": "list",
        "workspacePath": workspace_path.display().to_string(),
    }))?;
    let WorkerAnswer::List { skills, warnings } = answer else {
        return Err(CommandError::new(
            "skills_worker_unavailable",
            "The skills worker answered the wrong question".to_owned(),
        ));
    };
    Ok(SkillsResponse {
        skills: skills
            .into_iter()
            .map(|skill| Skill {
                enabled: !skill.hidden && !disabled.contains(&skill.name),
                ..skill
            })
            .collect(),
        warnings,
    })
}

/// Copies one file in, and answers with the name the loader gave it.
///
/// Split from the command so the Rust-to-Node seam can be driven by a test. Everything above it is
/// a path check and a database read; this is the part that spawns a process and reads its answer.
fn import_into(workspace_path: &Path, source_path: &str) -> Result<String, CommandError> {
    let answer = ask(&serde_json::json!({
        "operation": "import",
        "workspacePath": workspace_path.display().to_string(),
        "sourcePath": source_path,
    }))?;
    match answer {
        WorkerAnswer::Imported { name } => Ok(name),
        _ => Err(CommandError::new(
            "skills_worker_unavailable",
            "The skills worker answered the wrong question".to_owned(),
        )),
    }
}

#[tauri::command(async)]
pub fn list_skills(app: AppHandle) -> Result<SkillsResponse, CommandError> {
    let (workspace_path, storage) = workspace(&app)?;
    let disabled = storage.project().read_disabled_skills()?;
    list_with(&workspace_path, &disabled)
}

/// Copies the Markdown file or the skill folder the user picked in, and answers with the whole list.
///
/// A folder as well as a file, because a skill is usually more than one file: `SKILL.md` is what
/// the model is told about, and it points at the rest by relative path for the agent to open once
/// the description matches. Importing only the one file leaves every one of those pointing at
/// nothing.
///
/// The list rather than the one skill, because an import can change more than the row it adds: a
/// file that turns out to be invalid appears as a warning instead of a row, and the tab has to
/// show that rather than a row that is not there.
#[tauri::command(async)]
pub fn import_skill(app: AppHandle, source_path: String) -> Result<SkillsResponse, CommandError> {
    let source = Path::new(&source_path);
    if source.is_dir() {
        if !source.join("SKILL.md").is_file() {
            return Err(CommandError::new(
                "skill_not_markdown",
                "A skill folder holds a SKILL.md, and this one does not".to_owned(),
            ));
        }
    } else if !source.is_file() {
        return Err(CommandError::new(
            "skill_unreadable",
            "That is not a file this project can read".to_owned(),
        ));
    } else if source
        .extension()
        .is_none_or(|one| !one.eq_ignore_ascii_case("md"))
    {
        return Err(CommandError::new(
            "skill_not_markdown",
            "A skill is a Markdown file".to_owned(),
        ));
    }
    let (workspace_path, storage) = workspace(&app)?;
    import_into(&workspace_path, &source_path)?;
    let disabled = storage.project().read_disabled_skills()?;
    list_with(&workspace_path, &disabled)
}

/// Where a skill the loader listed actually sits.
///
/// Asked of the loader rather than rebuilt from the name, because the two are not the same string.
/// pi takes a skill's name from its frontmatter and only *warns* when that disagrees with the
/// directory — so a `SKILL.md` in `one-name/` saying `name: another-name` is listed as
/// `another-name`, and a path built from that name names a directory that does not exist. Every
/// command keyed that way was broken for exactly those skills: reading failed, saving created a
/// second copy under the frontmatter name, and Delete was a permanent no-op.
///
/// The answer is still checked against the skills directory before anything opens it. The name
/// arrives from the renderer, and a path that came back from a loader reading the workspace is
/// only trustworthy once it has been shown to be inside the directory it was supposed to read.
fn locate(workspace_path: &Path, name: &str) -> Result<PathBuf, CommandError> {
    let listed = list_with(workspace_path, &[])?;
    let found = listed
        .skills
        .into_iter()
        .find(|skill| skill.name == name)
        .ok_or_else(|| {
            CommandError::new(
                "skill_not_found",
                format!("This project has no skill called \"{name}\""),
            )
        })?;
    let path = PathBuf::from(&found.path);
    if !path.starts_with(skills_directory(workspace_path)) {
        return Err(CommandError::new(
            "skill_not_found",
            format!("\"{name}\" does not sit in this project's skills directory"),
        ));
    }
    Ok(path)
}

fn skills_directory(workspace_path: &Path) -> PathBuf {
    workspace_path.join(".gofer").join("skills")
}

#[tauri::command(async)]
pub fn read_skill(app: AppHandle, name: String) -> Result<String, CommandError> {
    let (workspace_path, _) = workspace(&app)?;
    let path = locate(&workspace_path, &name)?;
    std::fs::read_to_string(&path).map_err(|error| {
        CommandError::new(
            "skill_unreadable",
            format!("Could not read the skill \"{name}\": {error}"),
        )
    })
}

#[tauri::command(async)]
pub fn write_skill(
    app: AppHandle,
    name: String,
    text: String,
) -> Result<SkillsResponse, CommandError> {
    if text.len() > MAX_SKILL_BYTES {
        return Err(CommandError::new(
            "skill_too_large",
            "Skills cannot exceed 256 KiB".to_owned(),
        ));
    }
    let (workspace_path, storage) = workspace(&app)?;
    let path = locate(&workspace_path, &name)?;
    let directory = path.parent().ok_or_else(|| {
        CommandError::new("skill_unwritable", "That skill has no directory".to_owned())
    })?;
    std::fs::create_dir_all(directory)
        .and_then(|()| std::fs::write(&path, text))
        .map_err(|error| {
            CommandError::new(
                "skill_unwritable",
                format!("Could not save the skill \"{name}\": {error}"),
            )
        })?;
    let disabled = storage.project().read_disabled_skills()?;
    list_with(&workspace_path, &disabled)
}

/// The directory `remove_dir_all` may be pointed at, which is never the store itself.
///
/// `starts_with` answers true for an equal path, and one arrangement arrives here with the store
/// as the directory: a `SKILL.md` dropped straight into `.gofer/skills` makes pi call that whole
/// directory one skill named `skills`, because it stops at the first `SKILL.md` and does not
/// recurse. Deleting the row the tab draws for it took every other skill in the project with it,
/// and `.gofer/.gitignore` is `*`, so nothing brought them back.
fn deletable_directory(workspace_path: &Path, name: &str) -> Result<PathBuf, CommandError> {
    let directory = locate(workspace_path, name)?
        .parent()
        .ok_or_else(|| {
            CommandError::new("skill_unwritable", "That skill has no directory".to_owned())
        })?
        .to_path_buf();
    let store = skills_directory(workspace_path);
    if directory == store || !directory.starts_with(&store) {
        return Err(CommandError::new(
            "skill_not_found",
            format!("\"{name}\" does not sit in a skill directory of its own"),
        ));
    }
    Ok(directory)
}

#[tauri::command(async)]
pub fn delete_skill(app: AppHandle, name: String) -> Result<SkillsResponse, CommandError> {
    let (workspace_path, storage) = workspace(&app)?;
    let directory = deletable_directory(&workspace_path, &name)?;
    if directory.is_dir() {
        std::fs::remove_dir_all(&directory).map_err(|error| {
            CommandError::new(
                "skill_unwritable",
                format!("Could not delete the skill \"{name}\": {error}"),
            )
        })?;
    }
    let project = storage.project();
    let mut disabled = project.read_disabled_skills()?;
    disabled.retain(|one| one != &name);
    project.write_disabled_skills(&disabled)?;
    list_with(&workspace_path, &disabled)
}

#[tauri::command(async)]
pub fn set_skill_enabled(
    app: AppHandle,
    name: String,
    enabled: bool,
) -> Result<SkillsResponse, CommandError> {
    let (workspace_path, storage) = workspace(&app)?;
    locate(&workspace_path, &name)?;
    let project = storage.project();
    let mut disabled = project.read_disabled_skills()?;
    disabled.retain(|one| one != &name);
    if !enabled {
        disabled.push(name);
    }
    disabled.sort();
    project.write_disabled_skills(&disabled)?;
    list_with(&workspace_path, &disabled)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A name the renderer sent is never turned into a path: it is looked up.
    ///
    /// So the guard is not a pattern but the lookup itself, and this is the test that says so. A
    /// name nothing was listed under has nowhere to point at, whatever characters are in it.
    #[test]
    fn a_name_this_project_never_listed_locates_nothing() {
        let directory = tempfile::TempDir::new().expect("temporary directory");
        let workspace = directory.path();
        std::fs::create_dir_all(workspace.join(".gofer/skills/tile-levels")).expect("directory");
        std::fs::write(
            workspace.join(".gofer/skills/tile-levels/SKILL.md"),
            "---\ndescription: How to build a 2D level from tiles\n---\nbody",
        )
        .expect("skill file");

        assert_eq!(
            locate(workspace, "tile-levels").expect("a path"),
            workspace.join(".gofer/skills/tile-levels/SKILL.md")
        );
        for refused in ["../../etc", "a/b", "Tile-Levels", "", "nothing-like-it"] {
            let failure = locate(workspace, refused).expect_err("no such skill");
            assert_eq!(failure.code, "skill_not_found", "{refused}: {failure:?}");
        }
    }

    /// The regression, and the reason a path is asked for rather than built.
    ///
    /// pi takes a skill's name from its frontmatter and only *warns* when that disagrees with the
    /// directory. A path rebuilt from the listed name pointed at a directory that does not exist:
    /// reading failed, saving wrote a second copy under the frontmatter name, and Delete removed
    /// nothing at all while answering with a list that still held the row.
    #[test]
    fn a_skill_whose_name_disagrees_with_its_directory_is_still_found() {
        let directory = tempfile::TempDir::new().expect("temporary directory");
        let workspace = directory.path();
        std::fs::create_dir_all(workspace.join(".gofer/skills/one-name")).expect("directory");
        std::fs::write(
            workspace.join(".gofer/skills/one-name/SKILL.md"),
            "---\nname: another-name\ndescription: mismatched\n---\nbody",
        )
        .expect("skill file");

        let listed = list_with(workspace, &[]).expect("the loader answers");
        assert_eq!(listed.skills[0].name, "another-name");

        assert_eq!(
            locate(workspace, "another-name").expect("a path"),
            workspace.join(".gofer/skills/one-name/SKILL.md")
        );
        assert!(locate(workspace, "one-name").is_err());
    }

    /// The seam this whole module exists to cross: Rust spawns Node, Node parses, Rust reads it.
    ///
    /// Everything else here is a path check or a database read. This is the only test that starts
    /// a process, and it is the only one that would have caught a worker that cannot be found, a
    /// request the worker cannot parse, or an answer Rust cannot read. It is worth the 100ms.
    #[test]
    fn the_loader_is_asked_over_a_real_process_and_its_answer_is_read_back() {
        let directory = tempfile::TempDir::new().expect("temporary directory");
        let workspace = directory.path();
        let skills = workspace.join(".gofer").join("skills");

        for (name, body) in [
            (
                "tile-levels",
                "---\ndescription: How to build a 2D level from tiles\n---\nbody",
            ),
            ("half-written", "No frontmatter yet."),
            (
                "one-name",
                "---\nname: another-name\ndescription: mismatched\n---\nbody",
            ),
        ] {
            std::fs::create_dir_all(skills.join(name)).expect("skill directory");
            std::fs::write(skills.join(name).join("SKILL.md"), body).expect("skill file");
        }

        let answer =
            list_with(workspace, &["another-name".to_owned()]).expect("the loader answers");

        let named: Vec<&str> = answer.skills.iter().map(|one| one.name.as_str()).collect();
        assert_eq!(named, vec!["another-name", "tile-levels"]);
        assert!(
            answer
                .skills
                .iter()
                .any(|one| one.name == "tile-levels" && one.enabled)
        );
        assert!(
            answer
                .skills
                .iter()
                .any(|one| one.name == "another-name" && !one.enabled)
        );

        assert!(
            answer
                .warnings
                .iter()
                .any(|one| one.path.contains("half-written") && one.message.contains("description")),
            "{:?}",
            answer.warnings
        );
    }

    /// A skill is usually a folder, and importing only its `SKILL.md` left every reference in it
    /// pointing at a file that was never copied.
    #[test]
    fn an_imported_folder_brings_the_files_its_skill_points_at() {
        let directory = tempfile::TempDir::new().expect("temporary directory");
        let workspace = directory.path();
        let picked = directory.path().join("godot-pixel-camera");
        std::fs::create_dir_all(picked.join("reference")).expect("source directory");
        std::fs::write(
            picked.join("SKILL.md"),
            "---\ndescription: pixel perfect cameras\n---\nThe traps are in `reference/traps.md`.",
        )
        .expect("skill file");
        std::fs::write(picked.join("reference").join("traps.md"), "# Traps").expect("reference");

        let name = import_into(workspace, &picked.display().to_string()).expect("import");

        assert_eq!(name, "godot-pixel-camera");
        let landed = locate(workspace, &name).expect("a path");
        assert!(landed.is_file());
        assert!(
            landed
                .parent()
                .expect("a directory")
                .join("reference")
                .join("traps.md")
                .is_file()
        );
    }

    /// The delete that would have taken every other skill with it.
    ///
    /// A `SKILL.md` dropped straight into `.gofer/skills` makes pi call the whole store one skill
    /// named `skills`, because it stops at the first `SKILL.md` and does not recurse. The row the
    /// tab draws for it has the store as its directory, and `starts_with` answers true for an
    /// equal path — so Delete passed the guard and removed the lot.
    #[test]
    fn deleting_a_skill_that_is_the_whole_store_is_refused() {
        let directory = tempfile::TempDir::new().expect("temporary directory");
        let workspace = directory.path();
        let skills = workspace.join(".gofer").join("skills");
        std::fs::create_dir_all(skills.join("tile-levels")).expect("skill directory");
        std::fs::write(
            skills.join("tile-levels").join("SKILL.md"),
            "---\ndescription: a real skill\n---\nbody",
        )
        .expect("skill file");
        std::fs::write(
            skills.join("SKILL.md"),
            "---\ndescription: dropped in by hand\n---\nbody",
        )
        .expect("shadowing file");

        let listed = list_with(workspace, &[]).expect("the loader answers");
        assert_eq!(listed.skills[0].name, "skills");

        let refused = deletable_directory(workspace, "skills").expect_err("refused");
        assert_eq!(refused.code, "skill_not_found");

        std::fs::remove_file(skills.join("SKILL.md")).expect("the shadowing file");
        assert_eq!(
            deletable_directory(workspace, "tile-levels").expect("a directory"),
            skills.join("tile-levels")
        );
    }

    /// The other half of the seam, and the name the loader decides.
    #[test]
    fn an_imported_file_is_named_by_the_loader_and_lands_where_the_agent_reads_it() {
        let directory = tempfile::TempDir::new().expect("temporary directory");
        let workspace = directory.path();
        let source = directory.path().join("Tile Levels.md");
        std::fs::write(
            &source,
            "---\ndescription: picked out of a folder\n---\nbody",
        )
        .expect("source file");

        let name = import_into(workspace, &source.display().to_string()).expect("import");

        assert_eq!(name, "tile-levels");
        assert!(locate(workspace, &name).expect("a path").is_file());
        let failure = import_into(workspace, &source.display().to_string()).expect_err("refused");
        assert_eq!(failure.code, "skill_refused");
        assert!(
            failure.message.contains("already has a skill"),
            "{failure:?}"
        );
    }
}

//! The layouts the agent has shown the user, kept as files.

use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};

use super::*;
use crate::command_error::CommandError;

/// One saved layout, as a list names it. The markup is not here.
///
/// A sketch drawn with the project's own artwork inlined runs to tens of kilobytes of base64, and a
/// panel listing forty of them would carry all of it across the seam to draw one. So the row says
/// what a list needs — which question, what it was called, whether it was agreed, when — and
/// [`Sketches::read`] fetches the bytes for the one that gets opened.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SketchRecord {
    pub id: String,
    pub task_id: Option<String>,
    pub question_id: String,
    pub question: String,
    pub label: String,
    pub is_approved: bool,
    pub saved_at: i64,
}

/// Both copies of one sketch, which are read by different readers.
///
/// `shown` is what the user was actually looking at: the project's own fonts and sprites are in it,
/// so it is the only copy worth drawing again. `source` is the model's own markup before any of that
/// was inlined, which is the copy worth handing to whoever builds it — the inlined one is base64
/// saying nothing a builder can act on.
///
/// `source` is absent for a sketch kept before the second copy existed. That is a fact about when it
/// was saved, not a failure.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SketchHtml {
    pub shown: String,
    pub source: Option<String>,
}

/// One sketch on its way to being kept, borrowed from wherever the caller already holds it.
///
/// A struct rather than eight parameters, and the two markup fields are named for their readers
/// rather than for their contents: passing them the wrong way round would put base64 in front of a
/// builder and a missing sprite in front of the user, and neither would fail loudly.
pub struct KeptSketch<'a> {
    pub sketch_id: &'a str,
    pub question_id: &'a str,
    pub task_id: Option<&'a str>,
    pub question: &'a str,
    pub label: &'a str,
    /// What the viewer draws: the copy with the project's artwork inlined.
    pub shown_html: &'a str,
    /// What a builder is handed: the model's own markup, before inlining.
    pub source_html: &'a str,
    pub is_approved: bool,
}

/// The layouts the agent has shown the user: a row each, and the markup beside it as files.
///
/// The markup is not content-addressed the way an attachment is, and it is deliberately not a
/// column. A sketch is revised in place — the third draft of a pause menu replaces the second under
/// the same identifier — so what is wanted afterwards is one file holding what was actually agreed,
/// not five near-identical drafts with no way to tell which one the user was looking at when they
/// said yes. The row exists so a list can name that file without opening it.
pub struct Sketches<'a> {
    pub(super) storage: &'a ProjectStorage,
}

impl Sketches<'_> {
    /// Keeps one revision, replacing whatever was under that identifier before.
    ///
    /// Best effort by design: the caller is a tool call the user is waiting on, and a full disk must
    /// not turn a layout the user just approved into a refused tool call. A failure here loses an
    /// artefact; a failure reported upwards would lose the reaction.
    ///
    /// Files first, then the row. The two orderings fail differently and only one of them is
    /// recoverable: a file with no row is invisible, which is what every sketch saved before this
    /// table existed already is. A row with no file is a list offering something that cannot be
    /// opened.
    ///
    /// Under the write lock, and the lock is taken before the files rather than with the row. It is
    /// what [`collect`](Self::collect) holds for its whole pass, and that pass deletes any file in
    /// this directory with no row behind it — so a sketch kept while maintenance ran had its markup
    /// written, then removed under it, and the insert below produced exactly the row with no file
    /// the ordering above exists to avoid.
    pub fn keep(&self, kept: &KeptSketch<'_>) -> Result<(), CommandError> {
        let (_write_guard, connection) = self.storage.write_connection()?;
        let directory = self.sketch_directory(kept.sketch_id)?;
        fs::create_dir_all(&directory).map_err(|error| {
            CommandError::from(format!("Could not create {}: {error}", directory.display()))
        })?;
        write_sketch_file(
            &directory.join(format!("{}.html", kept.sketch_id)),
            kept.shown_html,
        )?;
        write_sketch_file(
            &directory.join(format!("{}.source.html", kept.sketch_id)),
            kept.source_html,
        )?;
        connection
            .execute(
                "INSERT INTO sketches (id, task_id, question_id, question, label, is_approved, saved_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT(id) DO UPDATE SET
                     task_id = excluded.task_id,
                     question_id = excluded.question_id,
                     question = excluded.question,
                     label = excluded.label,
                     is_approved = excluded.is_approved,
                     saved_at = excluded.saved_at",
                params![
                    kept.sketch_id,
                    kept.task_id,
                    kept.question_id,
                    kept.question,
                    kept.label,
                    i64::from(kept.is_approved),
                    now_millis()?
                ],
            )
            .map_err(database_error)?;
        Ok(())
    }

    /// Every sketch the project has kept, most recently saved first.
    pub fn list(&self, limit: usize) -> Result<Vec<SketchRecord>, CommandError> {
        self.listed_records(limit)
            .map_err(CommandError::or_coded("sketches_unavailable"))
    }

    fn listed_records(&self, limit: usize) -> Result<Vec<SketchRecord>, CommandError> {
        let connection = self.storage.connection()?;
        let mut statement = connection
            .prepare(
                "SELECT id, task_id, question_id, question, label, is_approved, saved_at
                 FROM sketches
                 ORDER BY saved_at DESC, id DESC
                 LIMIT ?1",
            )
            .map_err(database_error)?;
        let rows = statement
            .query_map([limit as i64], |row| {
                Ok(SketchRecord {
                    id: row.get(0)?,
                    task_id: row.get(1)?,
                    question_id: row.get(2)?,
                    question: row.get(3)?,
                    label: row.get(4)?,
                    is_approved: row.get::<_, i64>(5)? != 0,
                    saved_at: row.get(6)?,
                })
            })
            .map_err(database_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(database_error)?;
        Ok(rows)
    }

    /// Both copies of one sketch.
    ///
    /// The identifier is checked before anything touches the filesystem, and that check is the point
    /// of this method rather than an afterthought in it. Until there was a screen for these, the
    /// value came from `ask::new_sketch_id` and could not be anything else; it now arrives from the
    /// renderer as a command argument, which makes it the one string in this feature that could name
    /// a path.
    pub fn read(&self, sketch_id: &str) -> Result<SketchHtml, CommandError> {
        self.read_html(sketch_id)
            .map_err(CommandError::or_coded("sketch_unavailable"))
    }

    fn read_html(&self, sketch_id: &str) -> Result<SketchHtml, CommandError> {
        let directory = self.sketch_directory(sketch_id)?;
        let connection = self.storage.connection()?;
        let known = connection
            .query_row("SELECT 1 FROM sketches WHERE id = ?1", [sketch_id], |row| {
                row.get::<_, i64>(0)
            })
            .optional()
            .map_err(database_error)?;
        if known.is_none() {
            return Err(CommandError::new(
                "sketch_not_found",
                format!("There is no sketch {sketch_id}"),
            ));
        }
        let shown_path = directory.join(format!("{sketch_id}.html"));
        let shown = fs::read_to_string(&shown_path).map_err(|error| {
            CommandError::from(format!("Could not read {}: {error}", shown_path.display()))
        })?;
        let source = fs::read_to_string(directory.join(format!("{sketch_id}.source.html"))).ok();
        Ok(SketchHtml { shown, source })
    }

    /// Where a sketch's files live, having first proved its identifier cannot name anywhere else.
    fn sketch_directory(&self, sketch_id: &str) -> Result<PathBuf, CommandError> {
        if sketch_id.is_empty() || !sketch_id.bytes().all(is_sketch_id_byte) {
            return Err(CommandError::new(
                "sketch_id_invalid",
                "A sketch identifier may only hold letters, digits and hyphens".to_owned(),
            ));
        }
        Ok(self.storage.project_directory().join("sketches"))
    }

    /// Rows whose markup is gone, and markup no row names.
    ///
    /// Not an age. A sketch is deliberately outlived by nothing: `task_id` clears rather than
    /// cascades because the layout the user agreed to is still the layout they agreed to after the
    /// task that produced it is deleted, so there is no date after which one stops being worth
    /// keeping. What there is instead is the pair coming apart, and [`Sketches::keep`] writes the
    /// files before the row precisely because the two orderings fail differently — so both halves
    /// of that failure are what this collects.
    ///
    /// A row with no file is the worse half and goes first: it is a list offering the user something
    /// that cannot be opened. A file with no row is only invisible, which is what every sketch saved
    /// before this table existed already was — but it is also what a crash between the two writes
    /// leaves behind, and nothing else would ever remove it.
    pub(crate) fn collect(&self, _cutoffs: &Cutoffs) -> Result<Collected, CommandError> {
        let directory = self.storage.project_directory().join("sketches");
        let connection = self.storage.connection()?;
        let mut statement = connection
            .prepare("SELECT id FROM sketches")
            .map_err(database_error)?;
        let kept = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(database_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(database_error)?;
        drop(statement);
        let mut surviving = Vec::with_capacity(kept.len());
        let mut removed = 0;
        for id in kept {
            if directory.join(format!("{id}.html")).is_file() {
                surviving.push(id);
                continue;
            }
            connection
                .execute("DELETE FROM sketches WHERE id = ?1", [&id])
                .map_err(database_error)?;
            let _ = fs::remove_file(directory.join(format!("{id}.source.html")));
            removed += 1;
        }
        for path in sketch_files(&directory)? {
            let Some(id) = sketch_id_of(&path) else {
                continue;
            };
            if surviving.contains(&id) {
                continue;
            }
            fs::remove_file(&path).map_err(|error| {
                CommandError::from(format!("Could not remove {}: {error}", path.display()))
            })?;
        }
        Ok(Collected {
            sketches_removed: removed,
            ..Collected::default()
        })
    }
}

/// Every file in the sketch directory, or none at all when the project has never kept one.
fn sketch_files(directory: &Path) -> Result<Vec<PathBuf>, CommandError> {
    if !directory.is_dir() {
        return Ok(Vec::new());
    }
    Ok(fs::read_dir(directory)
        .map_err(|error| {
            CommandError::from(format!("Could not read {}: {error}", directory.display()))
        })?
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
        .map(|entry| entry.path())
        .collect())
}

/// Which sketch a file in that directory belongs to, and nothing for a file that is not one.
///
/// Unambiguous because [`is_sketch_id_byte`] allows no dot: `pause-menu.source.html` can only be the
/// source copy of `pause-menu`, never a sketch called `pause-menu.source`.
fn sketch_id_of(path: &Path) -> Option<String> {
    let name = path.file_name()?.to_str()?;
    let stem = name
        .strip_suffix(".source.html")
        .or_else(|| name.strip_suffix(".html"))?;
    if stem.is_empty() || !stem.bytes().all(is_sketch_id_byte) {
        return None;
    }
    Some(stem.to_owned())
}

fn write_sketch_file(path: &Path, html: &str) -> Result<(), CommandError> {
    fs::write(path, html)
        .map_err(|error| CommandError::from(format!("Could not save {}: {error}", path.display())))
}

/// The bytes a sketch identifier may hold, which is what keeps it from naming a path.
///
/// The identifier is minted by `ask::new_sketch_id`, and the window hands it back to ask for the
/// markup, so a value that becomes a filename makes a round trip through code we do not own.
/// Nothing in `question-7-018f…` needs a dot or a separator, so neither is allowed, `..` cannot be
/// spelt at all, and the `.source.html` suffix cannot be forged by an identifier ending in `.source`.
fn is_sketch_id_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'-'
}

#[cfg(test)]
mod tests {
    use super::super::test_support::*;
    use super::*;
    use tempfile::TempDir;

    /// The whole point of the store: what the user agreed can be found and drawn again.
    #[test]
    fn a_kept_sketch_is_listed_and_read_back_in_both_copies() {
        let directory = TempDir::new().expect("temporary directory");
        let storage = storage(&directory);

        storage
            .sketches()
            .keep(&kept(
                "question-1-run",
                "Centered overlay",
                "<p>inlined</p>",
                "<p>res://ui/panel.png</p>",
            ))
            .expect("keep the sketch");

        let listed = storage.sketches().list(10).expect("list sketches");
        assert_eq!(listed.len(), 1, "one sketch was kept");
        assert_eq!(listed[0].label, "Centered overlay");
        assert_eq!(listed[0].question, "Where does the pause menu go?");
        assert!(listed[0].is_approved, "it was kept as agreed");

        let html = storage.sketches().read("question-1-run").expect("read");
        assert_eq!(
            html.shown, "<p>inlined</p>",
            "the viewer draws the inlined copy"
        );
        assert_eq!(
            html.source.as_deref(),
            Some("<p>res://ui/panel.png</p>"),
            "a builder is handed the model's own markup, not the base64 one"
        );
    }

    /// A design loop is one layout being revised, so its rounds must not pile up as separate rows.
    #[test]
    fn keeping_a_revision_replaces_the_row_rather_than_adding_one() {
        let directory = TempDir::new().expect("temporary directory");
        let storage = storage(&directory);

        storage
            .sketches()
            .keep(&kept("question-1-run", "Draft", "<p>one</p>", "<p>one</p>"))
            .expect("keep the first draft");
        storage
            .sketches()
            .keep(&kept(
                "question-1-run",
                "Revised",
                "<p>two</p>",
                "<p>two</p>",
            ))
            .expect("keep the revision");

        let listed = storage.sketches().list(10).expect("list sketches");
        assert_eq!(
            listed.len(),
            1,
            "a revision replaces its predecessor in place"
        );
        assert_eq!(listed[0].label, "Revised");
        assert_eq!(
            storage
                .sketches()
                .read("question-1-run")
                .expect("read")
                .shown,
            "<p>two</p>",
            "the file is replaced along with the row"
        );
    }

    /// Newest first, because the layout somebody is re-checking is almost always the last one.
    #[test]
    fn sketches_are_listed_newest_first() {
        let directory = TempDir::new().expect("temporary directory");
        let storage = storage(&directory);

        storage
            .sketches()
            .keep(&kept("question-1-run", "Older", "<p>a</p>", "<p>a</p>"))
            .expect("keep the older sketch");
        std::thread::sleep(std::time::Duration::from_millis(2));
        storage
            .sketches()
            .keep(&kept("question-2-run", "Newer", "<p>b</p>", "<p>b</p>"))
            .expect("keep the newer sketch");

        let listed = storage.sketches().list(10).expect("list sketches");
        assert_eq!(
            listed
                .iter()
                .map(|row| row.label.as_str())
                .collect::<Vec<_>>(),
            vec!["Newer", "Older"]
        );
    }

    /// The identifier makes a round trip through the window, so it is checked on the way back in.
    ///
    /// Reading is the direction that matters. Keeping has only ever been handed a value minted by
    /// `ask::new_sketch_id`; reading is handed whatever the renderer sends.
    #[test]
    fn a_sketch_identifier_that_could_name_a_path_is_refused_both_ways() {
        let directory = TempDir::new().expect("temporary directory");
        let storage = storage(&directory);

        for identifier in ["", "../secret", "a.b", "a/b", "a.source"] {
            let refused = storage
                .sketches()
                .read(identifier)
                .expect_err("an identifier that could name a path must be refused");
            assert_eq!(
                refused.code, "sketch_id_invalid",
                "{identifier} was allowed through the read guard"
            );
            assert!(
                storage
                    .sketches()
                    .keep(&kept(identifier, "x", "<p>a</p>", "<p>a</p>"))
                    .is_err(),
                "{identifier} was allowed through the keep guard"
            );
        }
    }

    /// Asked for something that was never kept, the store says so rather than reading a stray file.
    #[test]
    fn reading_a_sketch_the_project_never_kept_is_reported() {
        let directory = TempDir::new().expect("temporary directory");
        let storage = storage(&directory);

        let refused = storage
            .sketches()
            .read("question-9-run")
            .expect_err("there is no such sketch");
        assert_eq!(
            refused.code, "sketch_not_found",
            "a sketch nobody kept is named as missing, not as a store that failed"
        );
    }

    /// A sketch kept before the second copy existed has one file, and that is an age, not a fault.
    #[test]
    fn a_sketch_with_no_source_copy_reads_back_without_one() {
        let directory = TempDir::new().expect("temporary directory");
        let storage = storage(&directory);

        storage
            .sketches()
            .keep(&kept(
                "question-1-run",
                "Old",
                "<p>drawn</p>",
                "<p>source</p>",
            ))
            .expect("keep the sketch");
        fs::remove_file(
            storage
                .project_directory()
                .join("sketches")
                .join("question-1-run.source.html"),
        )
        .expect("remove the source copy");

        let html = storage.sketches().read("question-1-run").expect("read");
        assert_eq!(
            html.shown, "<p>drawn</p>",
            "the copy that is there is still drawn"
        );
        assert!(
            html.source.is_none(),
            "a missing source copy is reported as absent rather than as a failure"
        );
    }

    /// Sketches were collected by nothing at all, and this is the half of them that goes.
    ///
    /// Not an age: `task_id` clears rather than cascades because the layout the user agreed to
    /// outlives the task that produced it, so there is no date after which one stops being worth
    /// keeping. What is collected is the row and its markup coming apart — a row offering the user
    /// something that cannot be opened, and markup no list will ever name again.
    #[test]
    fn the_sketches_view_collects_a_row_with_no_markup_and_markup_with_no_row() {
        let directory = TempDir::new().expect("temporary directory");
        let storage = storage(&directory);
        for id in ["question-1-run", "question-2-run"] {
            storage
                .sketches()
                .keep(&kept(id, "Dock", "<p>a</p>", "<p>a</p>"))
                .expect("keep the sketch");
        }
        let sketches = storage.project_directory().join("sketches");
        fs::remove_file(sketches.join("question-2-run.html")).expect("lose the markup");
        fs::write(sketches.join("question-3-run.html"), "<p>nobody's</p>").expect("orphan markup");
        fs::write(sketches.join("notes.txt"), "not a sketch").expect("a file that is not ours");

        let collected = storage
            .sketches()
            .collect(&everything_is_old())
            .expect("collect");

        assert_eq!(collected.sketches_removed, 1);
        let listed = storage.sketches().list(10).expect("list sketches");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, "question-1-run");
        assert!(
            !sketches.join("question-2-run.source.html").exists(),
            "a row that goes takes both of its copies"
        );
        assert!(!sketches.join("question-3-run.html").exists());
        assert!(sketches.join("question-1-run.html").is_file());
        assert!(sketches.join("question-1-run.source.html").is_file());
        assert!(
            sketches.join("notes.txt").is_file(),
            "a name this cannot read is not a sketch, and not ours to delete"
        );
    }
}

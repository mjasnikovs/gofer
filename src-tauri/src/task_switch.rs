//! Moving the project's one checkout from wherever it is onto a task's branch.
//!
//! CONTEXT.md states a Switch in one sentence — stop the editor, commit what is loose, check out
//! the branch, then move the current-task pointer — and this is where that sentence lives in code.
//! Five task operations move the same checkout: create, activate, delete, merge and resolve. Each
//! used to spell the order out again, two of them left the commit to a helper inside `git.rs`, and
//! delete dropped its refusal on the floor, so a checkout that would not move left the user reading
//! one task's chat over another task's files with nothing anywhere saying so.
//!
//! The release is handed in once, when the Switch is built, rather than passed to five commands
//! that each remember to pass it on.

use std::path::{Path, PathBuf};

use crate::git;

/// One project's checkout, and the thing that has to stop before it moves.
pub(crate) struct Switch<'a> {
    workspace: PathBuf,
    /// Stops everything holding the working tree. Called once per move, and idempotent — deleting a
    /// task stops the editor and then moves the checkout again, onto the task that took over.
    release: &'a dyn Fn(&Path) -> Result<(), String>,
}

impl<'a> Switch<'a> {
    pub(crate) fn new(
        workspace: impl Into<PathBuf>,
        release: &'a dyn Fn(&Path) -> Result<(), String>,
    ) -> Self {
        Self {
            workspace: workspace.into(),
            release,
        }
    }

    /// Stops what is holding the working tree, without moving it.
    ///
    /// Godot keeps every open scene in memory and never rereads one a checkout changed underneath
    /// it; the next save writes that stale copy over the branch the user switched to, and their work
    /// is gone with no error anywhere. Stopping the editor also takes the addon's two lines back out
    /// of `project.godot`, which is what leaves the file clean enough for Git to move at all.
    pub(crate) fn release(&self) -> Result<(), String> {
        (self.release)(&self.workspace)
    }

    /// The whole Switch: stop the editor, bank the outgoing task's work, move onto `branch`.
    ///
    /// The commit is not optional. One checkout means uncommitted files follow a checkout into the
    /// next task and arrive there looking like that task's own work.
    ///
    /// A checkout already on `branch` is not moved, and nothing is stopped for it: there is no
    /// outgoing task, so there is nothing to bank and nothing holding files that are about to
    /// change. Use [`Switch::onto`] where the stop is the point.
    pub(crate) fn to(&self, branch: &str) -> Result<(), String> {
        if git::current_branch(&self.workspace).as_deref() == Some(branch) {
            return Ok(());
        }
        self.release()?;
        git::commit_pending_changes(&self.workspace)?;
        git::checkout_branch(&self.workspace, branch)
    }

    /// The Switch that leaves loose files loose: stop the editor, move, let them come along.
    ///
    /// For a new task the user chose to start from what is already in the tree. Git carries an
    /// untracked or modified file across a checkout on its own, so nothing is moved by hand.
    pub(crate) fn carrying(&self, branch: &str) -> Result<(), String> {
        if git::current_branch(&self.workspace).as_deref() == Some(branch) {
            return Ok(());
        }
        self.release()?;
        git::checkout_branch(&self.workspace, branch)
    }

    /// Stops the editor and puts the checkout on `branch`, banking nothing on the way.
    ///
    /// For merging and resolving. Both are already on the task's own branch — the caller refuses any
    /// other task — so [`Switch::to`] would find nothing to move and skip the stop, and both commit
    /// what is loose themselves as part of the Git operation they run. The stop is what matters
    /// here: `project.godot` has to lose the addon's two lines before anything is committed.
    pub(crate) fn onto(&self, branch: &str) -> Result<(), String> {
        self.release()?;
        git::checkout_branch(&self.workspace, branch)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// A release that records that it was asked, and can refuse.
    struct Recorder {
        calls: Mutex<usize>,
        refuses: bool,
    }

    impl Recorder {
        fn new(refuses: bool) -> Self {
            Self {
                calls: Mutex::new(0),
                refuses,
            }
        }

        fn released(&self) -> usize {
            *self.calls.lock().expect("the recorder")
        }
    }

    fn recording(recorder: &Recorder) -> impl Fn(&Path) -> Result<(), String> + use<'_> {
        move |_| {
            *recorder.calls.lock().expect("the recorder") += 1;
            if recorder.refuses {
                return Err("an editor would not stop".to_owned());
            }
            Ok(())
        }
    }

    /// A directory that is not a repository, which is enough for the two rules below: neither
    /// depends on Git answering, only on the order the Switch asks in.
    fn nowhere() -> PathBuf {
        std::env::temp_dir().join("gofer-switch-tests-nowhere")
    }

    /*
     * The stop comes first, and a refusal ends the move.
     *
     * This is the rule the whole module exists for: a checkout moved under a running editor loses
     * the outgoing task's work with no error anywhere. Four operations spelt it out separately and
     * one of them dropped the answer.
     */
    #[test]
    fn a_refused_stop_moves_nothing() {
        let recorder = Recorder::new(true);
        let release = recording(&recorder);
        let switch = Switch::new(nowhere(), &release);

        let refusal = switch
            .to("gofer/task-1")
            .expect_err("a switch may not continue past an editor that would not stop");
        assert!(refusal.contains("would not stop"), "{refusal}");
        assert_eq!(recorder.released(), 1);
    }

    /// The Switch that leaves loose files loose still stops the editor first, for the same reason.
    #[test]
    fn carrying_loose_files_across_still_stops_the_editor_first() {
        let recorder = Recorder::new(true);
        let release = recording(&recorder);
        let switch = Switch::new(nowhere(), &release);

        switch
            .carrying("gofer/task-1")
            .expect_err("a new task may not start under an editor holding the files");
        assert_eq!(recorder.released(), 1);
    }

    // `onto` is the merge's move: already on the branch, and the stop is the whole point.
    #[test]
    fn moving_onto_a_branch_always_stops_first() {
        let recorder = Recorder::new(true);
        let release = recording(&recorder);
        let switch = Switch::new(nowhere(), &release);

        switch
            .onto("gofer/task-1")
            .expect_err("a merge may not run under an editor holding the same files");
        assert_eq!(recorder.released(), 1);
    }
}

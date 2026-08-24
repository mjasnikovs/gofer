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
//!
//! The single provider operation is taken here too, for the same reason. Moving the checkout while
//! a turn is streaming pulls the files out from under an agent that is holding hashes for them, so
//! every one of the five refuses a turn first — and each one used to say so itself, in a line
//! beside the line that built the Switch. What held the pair together was a test that read
//! `lib.rs` as a string and looked for both. A sixth caller was written without the guard once
//! already, which is what that test was added for. It is a field now: the operation is taken as
//! the Switch is built, held for as long as the Switch lives, and there is no way to ask for the
//! move without it.

use std::path::{Path, PathBuf};

use crate::ai_turn::AiProviderOperation;
use crate::command_error::CommandError;
use crate::git;

/// One project's checkout, and the thing that has to stop before it moves.
pub(crate) struct Switch<'a> {
    workspace: PathBuf,
    /// Stops everything holding the working tree. Called once per move, and idempotent — deleting a
    /// task stops the editor and then moves the checkout again, onto the task that took over.
    release: &'a dyn Fn(&Path) -> Result<(), String>,
    /// The one provider operation, held for as long as this Switch is alive.
    ///
    /// `None` only for [`Switch::with_no_turn_to_refuse`], where there is no turn to refuse. Kept
    /// as a field rather than taken and dropped inside a move, because the interval the refusal
    /// protects is the caller's whole command — a merge settles the editor's unsaved work between
    /// building this and asking it to move.
    _operation: Option<AiProviderOperation>,
}

impl<'a> Switch<'a> {
    /// The Switch the application builds: it takes the provider operation, or refuses.
    ///
    /// The refusal is a state rather than a fault — something is answering right now — so it is
    /// retryable, and the sentence tells the user what to wait for.
    pub(crate) fn refusing_a_turn(
        workspace: impl Into<PathBuf>,
        release: &'a dyn Fn(&Path) -> Result<(), String>,
    ) -> Result<Self, CommandError> {
        let operation = crate::ai_turn::begin_provider_operation().map_err(|_| {
            CommandError::new(
                "ai_request_in_progress",
                "Wait for the current answer to finish before opening another task",
            )
            .retryable()
        })?;
        Ok(Self {
            workspace: workspace.into(),
            release,
            _operation: Some(operation),
        })
    }

    /// The Switch for a move that no turn can be running during.
    ///
    /// Two callers. Opening a project makes its first task before the window has drawn anything,
    /// let alone asked a model — and taking the operation there would refuse the project itself,
    /// because a tool handler inside a live turn reopens the same storage. The suites are the
    /// other: they drive the checkout with no window competing for the process-wide operation.
    ///
    /// Stated rather than inferred. A caller that skips the refusal has to name the door that
    /// skips it, and the name says what it skipped.
    pub(crate) fn with_no_turn_to_refuse(
        workspace: impl Into<PathBuf>,
        release: &'a dyn Fn(&Path) -> Result<(), String>,
    ) -> Self {
        Self {
            workspace: workspace.into(),
            release,
            _operation: None,
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
        let switch = Switch::with_no_turn_to_refuse(nowhere(), &release);

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
        let switch = Switch::with_no_turn_to_refuse(nowhere(), &release);

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
        let switch = Switch::with_no_turn_to_refuse(nowhere(), &release);

        switch
            .onto("gofer/task-1")
            .expect_err("a merge may not run under an editor holding the same files");
        assert_eq!(recorder.released(), 1);
    }

    /**
     * The operation is held for as long as the Switch is, not for as long as taking it took.
     *
     * This was a source-text test in `lib.rs`: it split the file on `\nfn `, found every body
     * containing `storage.switch(`, and required `refuse_during_turn()?` beside it. That test
     * exists because a sixth command was written without the guard — and a rule kept by reading
     * the source is a rule the seventh caller can still be written without, in a file the test
     * does not read.
     *
     * Asserted by asking twice, because that is the whole of the difference: a probe that took the
     * operation and dropped it would answer yes both times.
     */
    #[test]
    fn a_switch_holds_the_provider_operation_until_it_is_dropped() {
        // The provider operation is process-wide, and every `ai_turn` test that begins a turn takes
        // this lock — so this waits behind them rather than refusing one of them by holding it.
        let _gate = crate::approvals::serialize_gate_tests();
        let release = |_: &Path| Ok(());

        let moving = Switch::refusing_a_turn(nowhere(), &release)
            .expect("nothing else is holding the operation");
        let refused = Switch::refusing_a_turn(nowhere(), &release)
            .err()
            .expect("the checkout is moving, so nothing else may take the operation");
        assert_eq!(refused.code, "ai_request_in_progress");

        drop(moving);
        Switch::refusing_a_turn(nowhere(), &release)
            .expect("the move is over, so the next one may begin");
    }

    /// The suite's door takes nothing, so it cannot refuse and cannot be refused.
    #[test]
    fn a_switch_with_no_turn_to_refuse_leaves_the_operation_alone() {
        let _gate = crate::approvals::serialize_gate_tests();
        let release = |_: &Path| Ok(());

        let _suite = Switch::with_no_turn_to_refuse(nowhere(), &release);
        Switch::refusing_a_turn(nowhere(), &release)
            .expect("a suite's Switch is not holding the operation");
    }
}

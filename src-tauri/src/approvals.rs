//! The safety model the AI tool router enforces.
//!
//! The agent runs unattended, so the first question every tool call has to answer is not "may this
//! work?" but "who can undo it?". Reads, editor and debugger control, runtime actions, typed file
//! writes and edits, undoable scene changes, saves, worktree project settings, and documentation
//! retrieval are auto-allowed: Git holds the worktree and the editor holds an undo stack, so the
//! user can take any of them back. The operations that leave both of those nets stop here and wait
//! for the user — a typed delete, an addon or plugin change, and a machine-wide editor setting,
//! which lives outside the worktree entirely and therefore outside every rollback the task has.
//!
//! Files outside the task worktree are refused rather than offered for approval: [`crate::files`]
//! rejects them by canonical path, and the router validates the paths of a gated call before this
//! module asks anything, so no prompt can ever offer to write outside the worktree.
//!
//! Direct UI actions carry the user's authorization by construction — the renderer reaches the same
//! Rust handlers through its own commands, and this gate sits in the AI tool router alone. Confined
//! bash is the deliberate exception in the other direction: it stays autonomous inside the active
//! task worktree even where the equivalent typed delete stops here, because a shell that asks for
//! permission per command is a shell the agent cannot use.
//!
//! Which operations those are is not written here. A gate is a fact about one named operation, so
//! it is carried on the operation's own row — `gated` in `protocol/schemas/v2/params.json`, read
//! by [`crate::tool_params::Operation::gate`] — beside its parameters, its route and its
//! narrowing. Written here it was a table of its own keyed on the same `(tool, op)` pair, and a
//! gate naming an operation that had been renamed meant an operation quietly running unapproved,
//! catchable only by a test that ran after the fact. Absence is still auto-allowed, so a new
//! operation is allowed by default and has to be gated deliberately.

use crate::ask::{AskError, MAIN_WINDOW, Registry};
use serde::Serialize;
use serde_json::{Value, json};
use std::sync::mpsc::RecvTimeoutError;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, Runtime};

/// How long a gated call waits for an answer before it gives up. Long, because the user may be
/// reading the scene the agent is asking about; bounded, because a turn that waits forever holds
/// the worker's tool channel open forever.
const APPROVAL_TIMEOUT: Duration = Duration::from_secs(300);
const REQUEST_EVENT: &str = "ai-approval-request";
const SETTLED_EVENT: &str = "ai-approval-settled";

/// A gate failure, in the shape every other handler behind the router already reports.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalError {
    pub code: &'static str,
    pub message: String,
    pub retryable: bool,
    pub details: Value,
}

impl ApprovalError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            retryable: false,
            details: json!({}),
        }
    }

    /// Reports that the blocking task carrying an answer never ran. Retryable: the prompt is still
    /// waiting, so the same answer sent again reaches it.
    pub fn dropped(message: impl Into<String>) -> Self {
        Self::new("task_dropped", message).retry_later()
    }

    fn retry_later(mut self) -> Self {
        self.retryable = true;
        self
    }

    fn with_details(mut self, details: Value) -> Self {
        self.details = details;
        self
    }
}

/// One gated operation inside a call. It names the operation and carries the parameters, because
/// "delete a file" and "delete `main.tscn`" are different decisions.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatedCall {
    pub op: String,
    pub reason: &'static str,
    pub params: Value,
}

/// The prompt the renderer shows: every gated operation of one tool call, in the order it would run.
///
/// A list rather than a single operation because a call is a list. Asked one at a time, ten
/// deletions would reach the user as ten dialogs, and they could only refuse the ones they had
/// already been shown — the rest would already have run.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalPrompt {
    pub approval_id: String,
    pub tool: String,
    pub calls: Vec<GatedCall>,
}

impl ApprovalPrompt {
    /// The operations, for a sentence: `godot_resource delete` or `godot_resource delete, move`.
    fn named(&self) -> String {
        let ops: Vec<&str> = self.calls.iter().map(|call| call.op.as_str()).collect();
        format!("{} {}", self.tool, ops.join(", "))
    }
}

/// Emitted whenever a prompt stops waiting — answered, timed out, or cancelled with the turn — so
/// the renderer never leaves a dialog open over a decision nobody is waiting for anymore.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalSettled {
    pub approval_id: String,
    pub approved: bool,
}

/// The prompts currently waiting for an answer, and the gate that says whether anything can wait at
/// all. Both live in [`crate::ask`], which is also where the question surface's registry lives — the
/// two share the mechanism and differ only in what an answer is and how long one is worth waiting
/// for.
///
/// A dropped sender — `cancel_all`, or a poisoned lock — reaches the waiter as a disconnect, so no
/// gated call can outlive its turn. The gate is separate from the map because dropping senders
/// cannot reach a tool worker still on its way into [`ask`] when the turn ended; a closed gate is
/// what refuses that one instead of a wait nobody will ever answer.
static APPROVALS: Registry<bool> = Registry::new("approval");

/// Runs the gate for one tool call: a call with nothing gated in it returns immediately, and one
/// with anything gated blocks until the user answers, the prompt times out, or the turn ends.
///
/// One answer covers the whole call. The user is shown every gated operation it holds, so approving
/// is a decision about what the call actually does rather than about its first line.
pub fn require<R: Runtime>(
    app: &AppHandle<R>,
    tool: &str,
    calls: &[GatedCall],
) -> Result<(), ApprovalError> {
    if calls.is_empty() {
        return Ok(());
    }
    ask(
        app,
        ApprovalPrompt {
            approval_id: APPROVALS.next_id(),
            tool: tool.to_owned(),
            calls: calls.to_vec(),
        },
        APPROVAL_TIMEOUT,
    )
}

fn ask<R: Runtime>(
    app: &AppHandle<R>,
    prompt: ApprovalPrompt,
    timeout: Duration,
) -> Result<(), ApprovalError> {
    // Without a window there is nobody to ask, and an unattended headless backend must not decide
    // on the user's behalf. The call is refused, and refused as retryable: the same request works
    // once the window is back.
    if !app.webview_windows().contains_key(MAIN_WINDOW) {
        return Err(ApprovalError::new(
            "approval_unavailable",
            format!(
                "{} needs the user's approval, and no window is open to ask for it",
                prompt.named()
            ),
        )
        .retry_later());
    }

    let approval_id = prompt.approval_id.clone();
    let receiver = APPROVALS.register(&approval_id).map_err(|_| {
        ApprovalError::new("lock_poisoned", "The tool approval lock is poisoned").retry_later()
    })?;

    // Registered into a turn that has already ended: there is nobody to answer, so the prompt is
    // never shown and the wait is skipped entirely.
    let abandoned = !APPROVALS.is_open();
    if !abandoned && let Err(error) = app.emit_to(MAIN_WINDOW, REQUEST_EVENT, &prompt) {
        take_pending(&approval_id);
        return Err(ApprovalError::new(
            "approval_unavailable",
            format!("The approval request could not be shown: {error}"),
        )
        .retry_later());
    }

    let outcome = if abandoned {
        Err(RecvTimeoutError::Disconnected)
    } else {
        receiver.recv_timeout(timeout)
    };
    // The responder removes the entry before it answers; a timeout or a disconnect leaves it, so
    // both paths take it back out rather than leaking a prompt id nobody will ever answer.
    take_pending(&approval_id);
    let details = json!({
        "approvalId": approval_id,
        "tool": prompt.tool,
        "ops": prompt.calls.iter().map(|call| call.op.as_str()).collect::<Vec<_>>(),
    });
    let settled = |approved: bool| {
        let _ = app.emit_to(
            MAIN_WINDOW,
            SETTLED_EVENT,
            ApprovalSettled {
                approval_id: approval_id.clone(),
                approved,
            },
        );
    };
    match outcome {
        Ok(true) => {
            settled(true);
            Ok(())
        }
        Ok(false) => {
            settled(false);
            Err(ApprovalError::new(
                "approval_denied",
                format!(
                    "The user did not approve {}. Do not retry it; ask what to do instead.",
                    prompt.named()
                ),
            )
            .with_details(details))
        }
        Err(RecvTimeoutError::Timeout) => {
            settled(false);
            Err(ApprovalError::new(
                "approval_timeout",
                format!(
                    "Nobody answered the approval request for {} in time",
                    prompt.named()
                ),
            )
            .retry_later()
            .with_details(details))
        }
        Err(RecvTimeoutError::Disconnected) => {
            settled(false);
            Err(ApprovalError::new(
                "approval_cancelled",
                format!("The approval request for {} was cancelled", prompt.named()),
            )
            .with_details(details))
        }
    }
}

/// Answers one waiting prompt. Called by the renderer's `respond_tool_approval` command.
pub fn respond(approval_id: &str, approved: bool) -> Result<(), ApprovalError> {
    APPROVALS
        .respond(approval_id, approved)
        .map_err(|error| match error {
            AskError::Unknown => ApprovalError::new(
                "unknown_approval",
                format!("No tool call is waiting for approval {approval_id}"),
            ),
            AskError::Expired => ApprovalError::new(
                "approval_expired",
                format!(
                    "The tool call waiting for approval {approval_id} has already stopped waiting"
                ),
            ),
            AskError::LockPoisoned => {
                ApprovalError::new("lock_poisoned", "The tool approval lock is poisoned")
                    .retry_later()
            }
        })
}

/// Opens the gate for one agent turn. Approvals belong to a turn: only a running turn has a tool
/// call to block and an agent waiting for the answer.
pub fn open() {
    APPROVALS.open();
}

/// Whether a turn is currently able to ask the user anything.
///
/// Only the tests read this, and they read it to assert the thing the gate's own invariant is:
/// no turn, no gate. It is not a question a caller has any business asking — `require` answers
/// what a caller actually wants to know.
#[cfg(test)]
pub(crate) fn is_open() -> bool {
    APPROVALS.is_open()
}

/// Closes the gate and settles every waiting prompt as a cancellation. The AI turn owns these
/// calls, so when the turn ends — normally or by cancellation — no gated call may be left blocking
/// a tool worker the turn is about to join.
pub fn cancel_all() {
    APPROVALS.cancel_all();
}

/// The prompts currently waiting for an answer, for the acceptance journey's stand-in renderer.
/// The real one learns each identifier from the `ai-approval-request` event it is shown; a test
/// backend has no window to receive one. Absent from every non-test build.
#[cfg(all(test, feature = "godot-acceptance"))]
pub fn pending_approvals() -> Vec<String> {
    APPROVALS.waiting()
}

fn take_pending(approval_id: &str) -> Option<std::sync::mpsc::Sender<bool>> {
    APPROVALS.take(approval_id)
}

/// Serializes every test that drives a gate a turn opens, wherever that test lives.
///
/// There are two registries — an approval and a question are different answers — but one schedule:
/// [`crate::ai_turn`] opens both when a turn begins and closes both when it ends, and says so in
/// the same breath. So this is one lock, not one per registry. An `ai_turn` test that begins and
/// drops an `AiTurn` settles the prompt an `approvals` test is waiting on and empties the registry
/// an [`crate::ask`] test is waiting on, from another thread, with no call between them to say so.
///
/// It read as a flake in whichever of them lost. `approval_cancelled` where the test asked for
/// `approval_timeout`; `no question was ever registered` where the question had been registered and
/// taken away again. `ask` kept a second lock of its own for a while, which serialized its tests
/// against each other and against nothing else — the half of the problem that was never the hard
/// half.
///
/// Poisoning is taken rather than propagated, because a panic in one test is that test's failure,
/// and re-raising it in every later one hides which test failed behind a `PoisonError`.
#[cfg(test)]
pub(crate) fn serialize_gate_tests() -> std::sync::MutexGuard<'static, ()> {
    static GATE_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    GATE_TEST_LOCK
        .lock()
        .unwrap_or_else(|held| held.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread;

    /// The reason one operation needs approval, by name, for the tests that state the pair they
    /// are about. The router reads it off the operation it has already resolved.
    fn gate(tool: &str, op: &str) -> Option<&'static str> {
        crate::tool_params::operation_of(tool, op)
            .unwrap_or_else(|| panic!("{tool}.{op} is a catalogue operation"))
            .gate()
    }

    /// A turn is running: prompts are only ever raised from inside one, so every test that drives
    /// the gate opens it the way `run_ai_worker_with` does.
    fn mock_app(with_window: bool) -> tauri::App<tauri::test::MockRuntime> {
        open();
        let app = tauri::test::mock_builder()
            .build(crate::app_context())
            .expect("build mock Tauri app");
        if with_window {
            tauri::WebviewWindowBuilder::new(&app, MAIN_WINDOW, Default::default())
                .build()
                .expect("build mock webview");
        }
        app
    }

    fn prompt(id: &str) -> ApprovalPrompt {
        ApprovalPrompt {
            approval_id: id.to_owned(),
            tool: "godot_resource".to_owned(),
            calls: vec![GatedCall {
                op: "delete".to_owned(),
                reason: "test",
                params: json!({"path": "res://main.tscn"}),
            }],
        }
    }

    fn answer_when_pending(approval_id: &'static str, approved: bool) -> thread::JoinHandle<()> {
        thread::spawn(move || {
            for _ in 0..200 {
                if respond(approval_id, approved).is_ok() {
                    return;
                }
                thread::sleep(Duration::from_millis(5));
            }
            panic!("{approval_id} never reached the pending registry");
        })
    }

    #[test]
    fn the_safety_model_auto_allows_recoverable_work() {
        // Reads, editor and debugger control, runtime actions, saves, undoable scene changes, and
        // worktree project settings all run without asking.
        for (tool, op) in [
            ("godot_scene", "get_tree"),
            ("godot_scene", "save"),
            ("godot_node", "delete"),
            ("godot_script", "save"),
            ("godot_project", "set_setting"),
            ("godot_project", "remove_autoload"),
            ("godot_debug", "launch"),
            ("godot_runtime", "input"),
            ("godot_docs_search", "search"),
        ] {
            assert_eq!(gate(tool, op), None, "{tool}.{op} must be allowed");
        }
        // A node delete is undoable in the editor; a file delete is not.
        assert!(gate("godot_resource", "delete").is_some());
        assert!(gate("godot_resource", "move").is_some());
        assert!(gate("godot_project", "set_editor_setting").is_some());
        assert!(gate("godot_project", "set_plugin_enabled").is_some());
    }

    #[test]
    fn an_approved_call_proceeds_and_a_denied_one_reports_the_refusal() {
        let _test = serialize_gate_tests();
        let app = mock_app(true);

        let responder = answer_when_pending("approval-approved", true);
        ask(
            app.handle(),
            prompt("approval-approved"),
            Duration::from_secs(5),
        )
        .expect("an approved call proceeds");
        responder.join().expect("responder thread");

        let responder = answer_when_pending("approval-denied", false);
        let failure = ask(
            app.handle(),
            prompt("approval-denied"),
            Duration::from_secs(5),
        )
        .expect_err("a denied call fails");
        responder.join().expect("responder thread");
        assert_eq!(failure.code, "approval_denied");
        assert!(!failure.retryable);
        assert_eq!(failure.details["approvalId"], "approval-denied");
    }

    #[test]
    fn an_unanswered_prompt_times_out_and_a_cancelled_turn_settles_it() {
        let _test = serialize_gate_tests();
        let app = mock_app(true);

        let failure = ask(
            app.handle(),
            prompt("approval-timeout"),
            Duration::from_millis(50),
        )
        .expect_err("an unanswered prompt fails");
        assert_eq!(failure.code, "approval_timeout");
        assert!(failure.retryable);
        // The timed-out prompt is gone, so a late answer cannot approve a call nobody is running.
        assert_eq!(
            respond("approval-timeout", true)
                .expect_err("late answer")
                .code,
            "unknown_approval"
        );

        let handle = app.handle().clone();
        let waiter = thread::spawn(move || {
            ask(
                &handle,
                prompt("approval-cancelled"),
                Duration::from_secs(5),
            )
        });
        for _ in 0..200 {
            if APPROVALS
                .waiting()
                .iter()
                .any(|id| id == "approval-cancelled")
            {
                break;
            }
            thread::sleep(Duration::from_millis(5));
        }
        cancel_all();
        let failure = waiter
            .join()
            .expect("waiter thread")
            .expect_err("a cancelled turn abandons its prompts");
        assert_eq!(failure.code, "approval_cancelled");
    }

    #[test]
    fn a_prompt_raised_after_the_turn_ended_is_refused_at_once() {
        let _test = serialize_gate_tests();
        let app = mock_app(true);
        // The turn ends while a tool worker is still on its way in: dropping the senders cannot
        // reach a prompt that is not registered yet, so the closed gate has to refuse it instead of
        // letting it wait out the full approval timeout.
        cancel_all();
        let started = std::time::Instant::now();
        let failure = ask(app.handle(), prompt("approval-late"), APPROVAL_TIMEOUT)
            .expect_err("a prompt nobody is waiting for is refused");
        assert_eq!(failure.code, "approval_cancelled");
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn a_backend_with_no_window_refuses_instead_of_deciding() {
        let _test = serialize_gate_tests();
        let app = mock_app(false);
        let failure = ask(
            app.handle(),
            prompt("approval-headless"),
            Duration::from_millis(50),
        )
        .expect_err("a windowless backend cannot approve anything itself");
        assert_eq!(failure.code, "approval_unavailable");
        assert!(failure.retryable);
        assert!(
            APPROVALS.waiting().is_empty(),
            "a refused request must leave nothing waiting"
        );
    }

    #[test]
    fn an_auto_allowed_operation_never_reaches_the_prompt() {
        let _test = serialize_gate_tests();
        let app = mock_app(false);
        // No window, so anything that asked would fail: reaching `Ok` proves nothing was asked.
        require(app.handle(), "godot_scene", &[])
            .expect("a call with nothing gated in it is auto-allowed");
    }
}

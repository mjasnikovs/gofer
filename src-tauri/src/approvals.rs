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

use serde::Serialize;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{RecvTimeoutError, Sender, channel};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, Runtime};

/// How long a gated call waits for an answer before it gives up. Long, because the user may be
/// reading the scene the agent is asking about; bounded, because a turn that waits forever holds
/// the worker's tool channel open forever.
const APPROVAL_TIMEOUT: Duration = Duration::from_secs(300);
/// The window the prompt is shown in. Tauri permissions restrict these commands to it as well.
const MAIN_WINDOW: &str = "main";
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
    pub fn task_failed(message: impl Into<String>) -> Self {
        Self::new("approval_task_failed", message).retry_later()
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

/// One operation the agent may not run on its own, and the reason the user is shown.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GatedOperation {
    pub tool: &'static str,
    pub op: &'static str,
    pub reason: &'static str,
}

const fn gate(tool: &'static str, op: &'static str, reason: &'static str) -> GatedOperation {
    GatedOperation { tool, op, reason }
}

/// Every AI operation that requires approval. Anything absent from this list is auto-allowed, so a
/// new catalog operation is allowed by default and has to be added here deliberately — which is
/// why `gated_operations_name_real_catalog_operations` checks the list against the catalog.
pub const GATED: &[GatedOperation] = &[
    gate(
        "godot_project",
        "set_plugin_enabled",
        "Enabling or disabling an editor plugin changes what runs inside the editor itself.",
    ),
    gate(
        "godot_project",
        "set_editor_setting",
        "Editor settings are machine-wide: they live outside the task worktree and outside Git, so \
         this change is not part of anything the task can roll back.",
    ),
    gate(
        "godot_resource",
        "delete",
        "Deleting a file removes it from the task worktree; only a Git checkout brings it back.",
    ),
    gate(
        "godot_resource",
        "move",
        "Moving a path removes the file from where it is now, and can overwrite the destination.",
    ),
];

/// The reason one operation needs approval, or `None` when the agent may just run it.
pub fn gate_reason(tool: &str, op: &str) -> Option<&'static str> {
    GATED
        .iter()
        .find(|gated| gated.tool == tool && gated.op == op)
        .map(|gated| gated.reason)
}

/// The prompt the renderer shows. It names the operation and carries the parameters, because
/// "delete a file" and "delete `main.tscn`" are different decisions.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalPrompt {
    pub approval_id: String,
    pub tool: String,
    pub op: String,
    pub reason: &'static str,
    pub params: Value,
}

/// Emitted whenever a prompt stops waiting — answered, timed out, or cancelled with the turn — so
/// the renderer never leaves a dialog open over a decision nobody is waiting for anymore.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalSettled {
    pub approval_id: String,
    pub approved: bool,
}

type Pending = HashMap<String, Sender<bool>>;

/// The prompts currently waiting for an answer. A dropped sender — `cancel_all`, or a poisoned
/// lock — reaches the waiter as a disconnect, so no gated call can outlive its turn.
static PENDING: Mutex<Option<Pending>> = Mutex::new(None);
static NEXT_APPROVAL_ID: AtomicU64 = AtomicU64::new(1);
/// Whether an agent turn is running. Only a turn can wait for an answer, and dropping the senders
/// cannot reach a prompt that has not been registered yet — a tool worker still on its way into
/// [`ask`] when the turn ended — so a closed gate is what refuses that one instead of a wait
/// nobody will ever answer.
static GATE_OPEN: AtomicBool = AtomicBool::new(false);

/// Runs the gate for one tool call: auto-allowed operations return immediately, gated ones block
/// until the user answers, the prompt times out, or the turn ends.
pub fn require<R: Runtime>(
    app: &AppHandle<R>,
    tool: &str,
    op: &str,
    params: &Value,
) -> Result<(), ApprovalError> {
    let Some(reason) = gate_reason(tool, op) else {
        return Ok(());
    };
    ask(
        app,
        ApprovalPrompt {
            approval_id: format!(
                "approval-{}",
                NEXT_APPROVAL_ID.fetch_add(1, Ordering::Relaxed)
            ),
            tool: tool.to_owned(),
            op: op.to_owned(),
            reason,
            params: params.clone(),
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
                "{}.{} needs the user's approval, and no window is open to ask for it",
                prompt.tool, prompt.op
            ),
        )
        .retry_later());
    }

    let approval_id = prompt.approval_id.clone();
    let (sender, receiver) = channel();
    PENDING
        .lock()
        .map_err(|_| {
            ApprovalError::new("lock_poisoned", "The tool approval lock is poisoned").retry_later()
        })?
        .get_or_insert_with(Pending::new)
        .insert(approval_id.clone(), sender);

    // Registered into a turn that has already ended: there is nobody to answer, so the prompt is
    // never shown and the wait is skipped entirely.
    let abandoned = !GATE_OPEN.load(Ordering::Acquire);
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
    let details = json!({"approvalId": approval_id, "tool": prompt.tool, "op": prompt.op});
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
                    "The user did not approve {}.{}. Do not retry it; ask what to do instead.",
                    prompt.tool, prompt.op
                ),
            )
            .with_details(details))
        }
        Err(RecvTimeoutError::Timeout) => {
            settled(false);
            Err(ApprovalError::new(
                "approval_timeout",
                format!(
                    "Nobody answered the approval request for {}.{} in time",
                    prompt.tool, prompt.op
                ),
            )
            .retry_later()
            .with_details(details))
        }
        Err(RecvTimeoutError::Disconnected) => {
            settled(false);
            Err(ApprovalError::new(
                "approval_cancelled",
                format!(
                    "The approval request for {}.{} was cancelled",
                    prompt.tool, prompt.op
                ),
            )
            .with_details(details))
        }
    }
}

/// Answers one waiting prompt. Called by the renderer's `respond_tool_approval` command.
pub fn respond(approval_id: &str, approved: bool) -> Result<(), ApprovalError> {
    let sender = take_pending(approval_id).ok_or_else(|| {
        ApprovalError::new(
            "unknown_approval",
            format!("No tool call is waiting for approval {approval_id}"),
        )
    })?;
    sender.send(approved).map_err(|_| {
        ApprovalError::new(
            "approval_expired",
            format!("The tool call waiting for approval {approval_id} has already stopped waiting"),
        )
    })
}

/// Opens the gate for one agent turn. Approvals belong to a turn: only a running turn has a tool
/// call to block and an agent waiting for the answer.
pub fn open() {
    GATE_OPEN.store(true, Ordering::Release);
}

/// Closes the gate and settles every waiting prompt as a cancellation. The AI turn owns these
/// calls, so when the turn ends — normally or by cancellation — no gated call may be left blocking
/// a tool worker the turn is about to join.
pub fn cancel_all() {
    GATE_OPEN.store(false, Ordering::Release);
    let Ok(mut pending) = PENDING.lock() else {
        return;
    };
    // Dropping the senders disconnects each waiter, which is what turns the wait into
    // `approval_cancelled` without needing to know how many are waiting.
    pending.take();
}

/// The prompts currently waiting for an answer, for the acceptance journey's stand-in renderer.
/// The real one learns each identifier from the `ai-approval-request` event it is shown; a test
/// backend has no window to receive one. Absent from every non-test build.
#[cfg(all(test, feature = "godot-acceptance"))]
pub fn pending_approvals() -> Vec<String> {
    PENDING
        .lock()
        .ok()
        .and_then(|pending| {
            pending
                .as_ref()
                .map(|pending| pending.keys().cloned().collect())
        })
        .unwrap_or_default()
}

fn take_pending(approval_id: &str) -> Option<Sender<bool>> {
    PENDING
        .lock()
        .ok()?
        .as_mut()
        .and_then(|pending| pending.remove(approval_id))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai_tools::CATALOG;
    use std::thread;

    /// The approval registry is process-wide, so the tests that drive it take turns.
    static APPROVAL_TEST_LOCK: Mutex<()> = Mutex::new(());

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
            op: "delete".to_owned(),
            reason: "test",
            params: json!({"path": "res://main.tscn"}),
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
    fn gated_operations_name_real_catalog_operations() {
        for gated in GATED {
            let domain = CATALOG
                .iter()
                .find(|domain| domain.name == gated.tool)
                .unwrap_or_else(|| panic!("{} is not a tool", gated.tool));
            assert!(
                domain.operations.iter().any(|entry| entry.op == gated.op),
                "{} has no {} operation",
                gated.tool,
                gated.op
            );
        }
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
            assert_eq!(gate_reason(tool, op), None, "{tool}.{op} must be allowed");
        }
        // A node delete is undoable in the editor; a file delete is not.
        assert!(gate_reason("godot_resource", "delete").is_some());
        assert!(gate_reason("godot_resource", "move").is_some());
        assert!(gate_reason("godot_project", "set_editor_setting").is_some());
        assert!(gate_reason("godot_project", "set_plugin_enabled").is_some());
    }

    #[test]
    fn an_approved_call_proceeds_and_a_denied_one_reports_the_refusal() {
        let _test = APPROVAL_TEST_LOCK.lock().expect("approval test lock");
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
        let _test = APPROVAL_TEST_LOCK.lock().expect("approval test lock");
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
            if PENDING
                .lock()
                .expect("pending lock")
                .as_ref()
                .is_some_and(|pending| pending.contains_key("approval-cancelled"))
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
        let _test = APPROVAL_TEST_LOCK.lock().expect("approval test lock");
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
        let _test = APPROVAL_TEST_LOCK.lock().expect("approval test lock");
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
            PENDING
                .lock()
                .expect("pending lock")
                .as_ref()
                .is_none_or(|pending| pending.is_empty()),
            "a refused request must leave nothing waiting"
        );
    }

    #[test]
    fn an_auto_allowed_operation_never_reaches_the_prompt() {
        let _test = APPROVAL_TEST_LOCK.lock().expect("approval test lock");
        let app = mock_app(false);
        // No window, so anything that asked would fail: reaching `Ok` proves nothing was asked.
        require(app.handle(), "godot_scene", "save", &json!({}))
            .expect("saving the edited scene is auto-allowed");
    }
}

//! Running one command's work off the async runtime, and the one failure that can mean.
//!
//! Nearly every Gofer command is blocking work — a database write, a process started, an RPC that
//! waits for the editor to answer — so nearly every one of them is a `spawn_blocking`. That leaves
//! two outcomes: what the work said, and the runtime dropping the task so the work never ran at
//! all. The second was written out by hand at every command, nine lines each, and each one invented
//! its own code for it: `start_task_failed`, `stop_task_failed`, `get_session_task_failed`,
//! `call_task_failed`, `subscribe_task_failed`, `unsubscribe_task_failed`, and four more.
//!
//! Six names for one event, reaching the renderer as six failure codes it could branch on and never
//! does. There is one code now — `task_dropped` — and the command's own name is in the message,
//! which is what `details` and prose are for. It is always retryable: the work did not happen, so
//! running it again is exactly the right thing to offer.

use crate::approvals::ApprovalError;
use crate::command_error::CommandError;
use crate::godot_dap::DapError;
use crate::godot_rpc::RpcError;
use crate::godot_session::SessionError;

/// A failure type that can say the blocking pool dropped a command's work.
///
/// Each command surface rejects with its own type — the session, the debug adapter, the approval
/// gate, and everything else — but they all serialize to the same four fields, so they can all
/// answer the same question.
pub trait TaskDropped {
    fn task_dropped(command: &'static str, cause: String) -> Self;
}

/// The message every one of them carries, so the wording of this failure is decided once.
fn dropped_message(command: &'static str, cause: String) -> String {
    format!("`{command}` did not run: the work was dropped before it finished ({cause})")
}

impl TaskDropped for CommandError {
    fn task_dropped(command: &'static str, cause: String) -> Self {
        Self::new("task_dropped", dropped_message(command, cause)).retryable()
    }
}

impl TaskDropped for SessionError {
    fn task_dropped(command: &'static str, cause: String) -> Self {
        Self::new("task_dropped", dropped_message(command, cause))
    }
}

impl TaskDropped for DapError {
    fn task_dropped(command: &'static str, cause: String) -> Self {
        Self::new("task_dropped", dropped_message(command, cause)).retryable()
    }
}

impl TaskDropped for RpcError {
    fn task_dropped(command: &'static str, cause: String) -> Self {
        Self::new("task_dropped", dropped_message(command, cause))
    }
}

impl TaskDropped for ApprovalError {
    fn task_dropped(command: &'static str, cause: String) -> Self {
        Self::dropped(dropped_message(command, cause))
    }
}

impl TaskDropped for crate::ask::QuestionError {
    fn task_dropped(command: &'static str, cause: String) -> Self {
        // Retryable: the question is still waiting, so the same answer sent again reaches it.
        Self {
            code: "task_dropped",
            message: dropped_message(command, cause),
            retryable: true,
        }
    }
}

/// Runs one command's blocking work, and turns a dropped task into that command's failure type.
///
/// `command` is the registered command's own name. It goes in the message rather than in the code,
/// so a renderer that wants to know which command was dropped can read it, and one that only wants
/// to know *that* something was dropped has a single code to match.
pub async fn off_thread<Answer, Failure, Work>(
    command: &'static str,
    work: Work,
) -> Result<Answer, Failure>
where
    Work: FnOnce() -> Answer + Send + 'static,
    Answer: Send + 'static,
    Failure: TaskDropped,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| Failure::task_dropped(command, error.to_string()))
}

/// The same, for blocking work that answers a helper's sentence rather than a coded failure.
///
/// Two things can go wrong and they are different things: the work did not run, or the work ran and
/// said no. The first is `task_dropped` and this decides it; the second is a sentence from a helper
/// deep in storage or retrieval, and `code` is the command naming the situation that sentence
/// describes — which, as `command_error.rs` says, only the command can do.
pub async fn off_thread_coded<Answer, Work>(
    command: &'static str,
    code: &'static str,
    work: Work,
) -> Result<Answer, CommandError>
where
    Work: FnOnce() -> Result<Answer, String> + Send + 'static,
    Answer: Send + 'static,
{
    // Named rather than inferred: `CommandError` can be built from a `String` as well as from a
    // dropped task, so nothing here says which of the two the `?` is lifting unless it is written.
    let answered = off_thread::<_, CommandError, _>(command, work).await?;
    answered.map_err(CommandError::coded(code))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_surface_names_the_same_event_the_same_way() {
        assert_eq!(
            CommandError::task_dropped("load_settings", "panicked".to_owned()).code,
            "task_dropped"
        );
        assert_eq!(
            SessionError::task_dropped("stop_godot_session", "panicked".to_owned()).code,
            "task_dropped"
        );
        assert_eq!(
            DapError::task_dropped("call_godot_debug", "panicked".to_owned()).code,
            "task_dropped"
        );
        assert_eq!(
            ApprovalError::task_dropped("respond_tool_approval", "panicked".to_owned()).code,
            "task_dropped"
        );
    }

    #[test]
    fn the_command_that_did_not_run_is_named_in_the_message() {
        let failure = CommandError::task_dropped("save_settings", "pool closed".to_owned());
        assert!(failure.message.contains("save_settings"));
        assert!(failure.message.contains("pool closed"));
    }

    /// The work never happened, so pressing the button again is the right offer to make.
    #[test]
    fn a_dropped_task_is_worth_trying_again() {
        assert!(CommandError::task_dropped("initialize_rag", "x".to_owned()).retryable);
        assert!(ApprovalError::task_dropped("respond_tool_approval", "x".to_owned()).retryable);
    }

    #[tokio::test]
    async fn work_that_runs_answers_with_what_it_returned() {
        let answer: Result<u8, CommandError> = off_thread("load_settings", || 7).await;
        assert_eq!(answer.expect("the work ran"), 7);
    }
}

//! Turn-scoped cancellation for the AI tool calls the agent runs off the stream loop.
//!
//! Stopping a turn kills the worker process, but a tool call already dispatched into Rust runs on a
//! thread of its own, and the waits it makes are long: an addon request may name a timeout of ten
//! minutes, a debug wait a minute. Nothing here interrupts those threads — a blocked `recv` cannot
//! be taken away from a thread — so instead every wait that can outlast a turn polls, and this
//! module answers the one question those polls ask: *is the turn I belong to still wanted?*
//!
//! The scope is a thread, not the process. The renderer calls the same addon, debug adapter, and
//! language server through the same functions, from Tauri's own threads; a cancellation that
//! reached those would abort the user's own click. Only a thread that entered [`ToolTurn`] — which
//! is only ever the tool worker — can be cancelled.
//!
//! The turn is identified rather than flagged. A tool that outlives its turn keeps the id it was
//! spawned with, so the next turn's cancellation cannot reach into it and no reset has to race the
//! threads still reading it.

use std::cell::Cell;
#[cfg(test)]
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::time::{Duration, Instant};

/// How often a cancellable wait looks up from the channel. Short enough that stopping a turn feels
/// immediate, long enough that a wait costs no measurable CPU.
const POLL_INTERVAL: Duration = Duration::from_millis(50);

/// The turn the user stopped. Zero — the id no request is given — means none.
static CANCELLED_TURN: AtomicU64 = AtomicU64::new(0);

thread_local! {
    /// The turn whose tool call this thread is running, or zero for every other thread.
    static TOOL_TURN: Cell<u64> = const { Cell::new(0) };
}

/// Marks the calling thread as running a tool call for `turn` until it is dropped.
pub struct ToolTurn;

impl ToolTurn {
    pub fn enter(turn: u64) -> Self {
        TOOL_TURN.with(|current| current.set(turn));
        Self
    }
}

impl Drop for ToolTurn {
    fn drop(&mut self) {
        TOOL_TURN.with(|current| current.set(0));
    }
}

/// Records that `turn` was stopped. Later calls replace the id rather than accumulating: only the
/// active turn has tool threads to stop.
pub fn cancel_turn(turn: u64) {
    CANCELLED_TURN.store(turn, Ordering::Release);
}

/// Whether the calling thread is running a tool call for a turn the user stopped.
pub fn is_cancelled() -> bool {
    let turn = TOOL_TURN.with(Cell::get);
    turn != 0 && turn == CANCELLED_TURN.load(Ordering::Acquire)
}

/// Why a cancellable wait ended without a value.
#[derive(Debug, PartialEq, Eq)]
pub enum WaitEnd {
    /// The turn this thread's tool call belongs to was stopped.
    Cancelled,
    /// The deadline passed with nothing received.
    TimedOut,
    /// The sender is gone, so nothing can still arrive.
    Disconnected,
}

/// Receives one value, giving up at `deadline` or as soon as the turn is cancelled.
///
/// Outside a tool call this is `recv_timeout` with a poll it can never take, so the renderer's own
/// requests behave exactly as before.
pub fn recv_until<T>(receiver: &Receiver<T>, deadline: Instant) -> Result<T, WaitEnd> {
    loop {
        if is_cancelled() {
            return Err(WaitEnd::Cancelled);
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(WaitEnd::TimedOut);
        }
        match receiver.recv_timeout(remaining.min(POLL_INTERVAL)) {
            Ok(value) => return Ok(value),
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return Err(WaitEnd::Disconnected),
        }
    }
}

/// Serializes every test that sets the process-wide cancelled turn.
///
/// An id of its own per test is not enough, because [`cancel_turn`] *replaces* the id rather than
/// accumulating: a second test cancelling its own turn un-cancels the first one, and a wait that
/// was watching for its cancellation then serves out its whole deadline instead. That is a test
/// racing a test, not a fault in the waits — but it is indistinguishable from one in the output.
#[cfg(test)]
pub(crate) static CANCEL_TEST_LOCK: Mutex<()> = Mutex::new(());

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc::channel;

    #[test]
    fn a_thread_outside_a_tool_call_is_never_cancelled() {
        let _serialized = CANCEL_TEST_LOCK
            .lock()
            .unwrap_or_else(|held| held.into_inner());
        cancel_turn(101);
        assert!(!is_cancelled(), "no tool call is running on this thread");
    }

    #[test]
    fn only_the_cancelled_turn_stops() {
        let _serialized = CANCEL_TEST_LOCK
            .lock()
            .unwrap_or_else(|held| held.into_inner());
        let _turn = ToolTurn::enter(102);
        cancel_turn(103);
        assert!(
            !is_cancelled(),
            "another turn's cancellation must not reach this one"
        );
        cancel_turn(102);
        assert!(is_cancelled());
    }

    #[test]
    fn leaving_the_tool_call_clears_the_thread() {
        let _serialized = CANCEL_TEST_LOCK
            .lock()
            .unwrap_or_else(|held| held.into_inner());
        cancel_turn(104);
        {
            let _turn = ToolTurn::enter(104);
            assert!(is_cancelled());
        }
        assert!(
            !is_cancelled(),
            "the thread is free again once the call returns"
        );
    }

    #[test]
    fn a_wait_ends_early_when_the_turn_is_cancelled() {
        let _serialized = CANCEL_TEST_LOCK
            .lock()
            .unwrap_or_else(|held| held.into_inner());
        let _turn = ToolTurn::enter(105);
        cancel_turn(105);
        let (_sender, receiver) = channel::<u8>();
        let started = Instant::now();
        let end = recv_until(&receiver, started + Duration::from_secs(30));
        assert_eq!(end, Err(WaitEnd::Cancelled));
        assert!(
            started.elapsed() < Duration::from_secs(1),
            "a cancelled wait must not serve out its timeout"
        );
    }

    #[test]
    fn a_wait_still_delivers_its_value_and_its_timeout() {
        let (sender, receiver) = channel();
        sender.send(7).expect("send");
        assert_eq!(
            recv_until(&receiver, Instant::now() + Duration::from_secs(5)),
            Ok(7)
        );
        assert_eq!(
            recv_until(&receiver, Instant::now() + Duration::from_millis(10)),
            Err(WaitEnd::TimedOut)
        );
        drop(sender);
        assert_eq!(
            recv_until(&receiver, Instant::now() + Duration::from_secs(5)),
            Err(WaitEnd::Disconnected)
        );
    }
}

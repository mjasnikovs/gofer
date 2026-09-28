//! The game run: whether the debugger holds a game, whether it is halted and why, and the
//! breakpoints the next game will be handed.
//!
//! The debugger, the adapter's reader and the router feed it transitions; the second-game guard,
//! the halted-game refusal and the diagnosis read it. One value, so no two of them can disagree.

use std::collections::BTreeMap;
use std::sync::{Condvar, Mutex, PoisonError};
use std::time::Duration;

/// Why a halted game is halted, as the adapter's `stopped` event says.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Halt {
    /// A step or an exception: there is a frame to read.
    InAFrame,
    /// A pause stops the game between frames and leaves none to read.
    Paused,
    AtABreakpoint,
}

/// Something that happened to the game.
#[derive(Clone, Copy, Debug)]
pub(crate) enum Transition<'a> {
    /// A debugger launch or restart was answered.
    DebuggerStartedAGame,
    Halted(Halt),
    /// The adapter said `continued`, or a request that resumes the game was written.
    Resumed,
    /// The adapter said `terminated` or `exited`. While a launch is unanswered that is the old game.
    DebuggeeEnded {
        while_a_launch_is_unanswered: bool,
    },
    /// A call that ends the game was answered, or an answer said the debuggee is gone.
    GameEnded,
    /// The editor went, and every breakpoint it held with it.
    SessionEnded,
    /// A `set_breakpoints` was answered; no lines takes the file's breakpoints away.
    BreakpointsSet {
        path: &'a str,
        lines: &'a [i64],
    },
}

/// Who is asking to start a game.
#[derive(Clone, Copy, Debug)]
pub(crate) enum Starter<'a> {
    DebugLaunch,
    /// A `godot_runtime` operation, by name.
    Runtime(&'a str),
}

/// A refusal to start a game beside the one the debugger holds.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct SecondGame {
    pub(crate) code: &'static str,
    pub(crate) message: &'static str,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct GameRun {
    /// `runtime.run` asks the editor `is_playing_scene()`, which a game the adapter launched is not.
    debugger_holds_a_game: bool,
    halt: Option<Halt>,
    /// Kept because the editor keeps them and hands them to the next game it plays, including one
    /// `godot_runtime run` starts; only a `set_breakpoints` with no lines or the editor going
    /// takes one away.
    armed: BTreeMap<String, Vec<i64>>,
}

impl Default for GameRun {
    fn default() -> Self {
        NO_GAME
    }
}

const NO_GAME: GameRun = GameRun {
    debugger_holds_a_game: false,
    halt: None,
    armed: BTreeMap::new(),
};

impl GameRun {
    pub(crate) fn after(mut self, transition: Transition) -> Self {
        match transition {
            Transition::DebuggerStartedAGame => {
                self.debugger_holds_a_game = true;
                self.halt = None;
            }
            Transition::Halted(halt) => self.halt = Some(halt),
            Transition::Resumed => self.halt = None,
            Transition::DebuggeeEnded {
                while_a_launch_is_unanswered,
            } => {
                self.halt = None;
                if !while_a_launch_is_unanswered {
                    self.debugger_holds_a_game = false;
                }
            }
            Transition::GameEnded => {
                self.debugger_holds_a_game = false;
                self.halt = None;
            }
            Transition::SessionEnded => self = NO_GAME,
            Transition::BreakpointsSet { path, lines: [] } => {
                self.armed.remove(path);
            }
            Transition::BreakpointsSet { path, lines } => {
                self.armed.insert(path.to_owned(), lines.to_vec());
            }
        }
        self
    }

    pub(crate) fn debugger_holds_a_game(&self) -> bool {
        self.debugger_holds_a_game
    }

    pub(crate) fn halt(&self) -> Option<Halt> {
        self.halt
    }

    pub(crate) fn is_halted(&self) -> bool {
        self.halt.is_some()
    }

    /// Whether the debugger's own game is halted: the one case waiting on a frame cannot help.
    pub(crate) fn debugger_game_is_halted(&self) -> bool {
        self.debugger_holds_a_game && self.is_halted()
    }

    /// The armed breakpoints by workspace-relative path, as a launch re-sends them.
    pub(crate) fn armed(&self) -> &BTreeMap<String, Vec<i64>> {
        &self.armed
    }

    /// The files that still hold a breakpoint this session set.
    pub(crate) fn armed_files(&self) -> Vec<String> {
        self.armed.keys().cloned().collect()
    }

    /// The breakpoints the way a caller sets them — `scripts/player.gd:22`.
    pub(crate) fn armed_lines(&self) -> Vec<String> {
        self.armed
            .iter()
            .flat_map(|(path, lines)| lines.iter().map(move |line| format!("{path}:{line}")))
            .collect()
    }

    /// Refuses a game started beside the one the debugger holds; each refusal names the ways out.
    pub(crate) fn refuse_a_second_game(&self, starter: Starter) -> Result<(), SecondGame> {
        if !self.debugger_holds_a_game {
            return Ok(());
        }
        match starter {
            Starter::DebugLaunch => Err(SecondGame {
                code: "already_launched",
                message: "The debugger is already running a game. Let it go on with continue, \
                          stop it where it is with pause, or end it with terminate — and restart \
                          is the one call that replaces a running game with a fresh one.",
            }),
            Starter::Runtime("run" | "restart") => Err(SecondGame {
                code: "already_running",
                message: "The debugger is already running this game. Read it where it is with \
                          debug.stack_trace, debug.scopes and debug.variables, or end it with \
                          debug.terminate. runtime.run would start a second one beside it.",
            }),
            Starter::Runtime(_) => Ok(()),
        }
    }
}

/// The run and the signal that it changed.
struct Watched {
    run: Mutex<GameRun>,
    changed: Condvar,
}

impl Watched {
    const fn new() -> Self {
        Self {
            run: Mutex::new(NO_GAME),
            changed: Condvar::new(),
        }
    }

    fn note(&self, transition: Transition) {
        let mut run = self.run.lock().unwrap_or_else(PoisonError::into_inner);
        *run = std::mem::take(&mut *run).after(transition);
        self.changed.notify_all();
    }

    fn now(&self) -> GameRun {
        self.run
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    fn halt_within(&self, deadline: Duration) -> Option<Halt> {
        let run = self.run.lock().unwrap_or_else(PoisonError::into_inner);
        let (run, _) = self
            .changed
            .wait_timeout_while(run, deadline, |run| run.halt.is_none())
            .unwrap_or_else(PoisonError::into_inner);
        run.halt
    }
}

/// Process-wide because the adapter's reader, the debugger and the router are on different threads
/// and each acceptance test is its own process.
static RUN: Watched = Watched::new();

pub(crate) fn note(transition: Transition) {
    RUN.note(transition);
}

pub(crate) fn now() -> GameRun {
    RUN.now()
}

/// Waits for the adapter's reader to say the game halted, and answers why.
pub(crate) fn halt_within(deadline: Duration) -> Option<Halt> {
    RUN.halt_within(deadline)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn after(transitions: &[Transition]) -> GameRun {
        transitions
            .iter()
            .fold(GameRun::default(), |run, transition| run.after(*transition))
    }

    #[test]
    fn a_launched_game_is_held_until_it_ends_and_halted_until_it_resumes() {
        let halted = after(&[
            Transition::DebuggerStartedAGame,
            Transition::Halted(Halt::AtABreakpoint),
        ]);
        assert!(halted.debugger_game_is_halted());
        assert_eq!(halted.halt(), Some(Halt::AtABreakpoint));

        let resumed = halted.clone().after(Transition::Resumed);
        assert!(resumed.debugger_holds_a_game() && !resumed.is_halted());

        for ending in [
            Transition::GameEnded,
            Transition::DebuggeeEnded {
                while_a_launch_is_unanswered: false,
            },
        ] {
            let ended = halted.clone().after(ending);
            assert!(
                !ended.debugger_holds_a_game() && !ended.is_halted(),
                "{ending:?}"
            );
        }
    }

    /// A restart writes the old game's end before it is answered; that end is not the new game's.
    #[test]
    fn the_old_games_end_during_a_restart_does_not_end_the_new_one() {
        let restarted = after(&[
            Transition::DebuggerStartedAGame,
            Transition::DebuggeeEnded {
                while_a_launch_is_unanswered: true,
            },
            Transition::DebuggerStartedAGame,
        ]);
        assert!(restarted.debugger_holds_a_game());
    }

    /// A halt the editor's own game reached is not the debugger's game halted.
    #[test]
    fn a_halt_without_a_debugger_game_is_not_the_debuggers() {
        let run = after(&[Transition::Halted(Halt::Paused)]);
        assert!(run.is_halted() && !run.debugger_game_is_halted());
    }

    /// Breakpoints outlive the game — the editor hands them to the next one — and not the editor.
    #[test]
    fn breakpoints_outlive_the_game_and_not_the_session() {
        let armed = after(&[
            Transition::BreakpointsSet {
                path: "scripts/player.gd",
                lines: &[22, 30],
            },
            Transition::BreakpointsSet {
                path: "scripts/hud.gd",
                lines: &[4],
            },
            Transition::DebuggerStartedAGame,
            Transition::GameEnded,
        ]);
        assert_eq!(armed.armed_files(), ["scripts/hud.gd", "scripts/player.gd"]);
        assert_eq!(
            armed.armed_lines(),
            [
                "scripts/hud.gd:4",
                "scripts/player.gd:22",
                "scripts/player.gd:30"
            ]
        );

        let cleared = armed.clone().after(Transition::BreakpointsSet {
            path: "scripts/hud.gd",
            lines: &[],
        });
        assert_eq!(cleared.armed_files(), ["scripts/player.gd"]);

        assert!(armed.after(Transition::SessionEnded).armed().is_empty());
    }

    /// One guard for both doors a second game comes through, and each names its ways out.
    ///
    /// One live debugging turn made seven launches with no terminate between them; another had
    /// `runtime.run` start a second game beside the debugger's and read the collision as a broken
    /// engine.
    #[test]
    fn a_second_game_is_refused_at_both_doors_while_the_debugger_holds_one() {
        let held = after(&[Transition::DebuggerStartedAGame]);

        let launch = held
            .refuse_a_second_game(Starter::DebugLaunch)
            .expect_err("a second launch");
        assert_eq!(launch.code, "already_launched");
        for onward in ["continue", "pause", "terminate", "restart"] {
            assert!(launch.message.contains(onward), "{onward}: {launch:?}");
        }

        for op in ["run", "restart"] {
            let run = held
                .refuse_a_second_game(Starter::Runtime(op))
                .expect_err("a second game");
            assert_eq!(run.code, "already_running");
            assert!(
                run.message.contains("debug.terminate")
                    && run.message.contains("debug.stack_trace"),
                "{run:?}"
            );
        }
        for op in ["stop", "get_state", "get_tree", "capture", "input", "wait"] {
            assert!(
                held.refuse_a_second_game(Starter::Runtime(op)).is_ok(),
                "{op}"
            );
        }

        let ended = held.after(Transition::GameEnded);
        assert!(ended.refuse_a_second_game(Starter::DebugLaunch).is_ok());
        assert!(ended.refuse_a_second_game(Starter::Runtime("run")).is_ok());
    }

    #[test]
    fn a_halt_noted_on_another_thread_wakes_the_wait() {
        let watched = std::sync::Arc::new(Watched::new());
        let reader = std::sync::Arc::clone(&watched);
        let noted = std::thread::spawn(move || {
            reader.note(Transition::Halted(Halt::AtABreakpoint));
        });
        assert_eq!(
            watched.halt_within(Duration::from_secs(60)),
            Some(Halt::AtABreakpoint)
        );
        noted.join().expect("the reader thread");
    }

    #[test]
    fn a_wait_with_nothing_halting_answers_none_at_its_deadline() {
        assert_eq!(Watched::new().halt_within(Duration::ZERO), None);
    }
}

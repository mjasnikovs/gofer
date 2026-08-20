//! Asking the user something and blocking until they answer.
//!
//! Three things in Gofer need this and they need it for different reasons: a tool call that may not
//! run unattended has to stop for a yes or no, an agent that has run out of ways to decide something
//! has to stop for a sentence, and an agent proposing a *layout* has to stop while somebody looks at
//! it. All three are the same mechanism — hand out an identifier, park a channel under it, show the
//! renderer a prompt, and wait — and the mechanism is the part that is easy to get subtly wrong, so
//! it is written once here and instantiated per answer shape.
//!
//! What the two share, and why each piece is here rather than at a call site:
//!
//! The registry is a map of identifier to sender, and the sender is *taken out* before it is used.
//! That is what makes a timeout, an answer and a cancellation mutually exclusive without a second
//! lock: whoever removes the entry owns the outcome.
//!
//! Dropping the whole map disconnects every waiter at once. A run ending does not need to know how
//! many prompts are outstanding or which they are — it drops the map and every wait turns into a
//! cancellation on its own.
//!
//! A gate, separate from the map, refuses a prompt registered after its run already ended. Dropping
//! senders cannot reach a caller that is still on its way in, so without the gate that one waits for
//! an answer nobody will ever send.
//!
//! What is NOT shared is the timeout and the wording. A yes-or-no about a delete and a question a
//! person is composing prose for are not the same wait, and pretending they are is how a question
//! surface inherits a five-minute ceiling nobody chose for it.
//!
//! What IS shared, deliberately, is the *gate*. `open_user_prompts` and `cancel_user_prompts` cover
//! every registry a turn can park a prompt in, because a turn ends in four places and the count of
//! things it has to remember to close must not grow with the count of surfaces. A registry closed in
//! three of the four leaves a tool call parked for half an hour on a card nobody can see.

use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender, channel};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, Runtime};

/// The window every prompt is shown in. Tauri permissions restrict the answering commands to it too.
pub const MAIN_WINDOW: &str = "main";

/// Why a prompt could not be registered or answered. Deliberately small: everything a *caller* wants
/// to say about a refusal — which tool, which operation, retryable or not — belongs to the caller,
/// because only it knows how its failures are reported.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AskError {
    /// The registry lock is poisoned. The caller decides whether that is worth retrying.
    LockPoisoned,
    /// No prompt is waiting under that identifier.
    Unknown,
    /// A prompt was waiting, but it has already stopped — it timed out or its run ended.
    Expired,
}

/// One kind of prompt: the outstanding waits, the identifiers they are handed out under, and whether
/// anything is currently able to ask at all.
///
/// Generic over the answer so the two users share the machinery and nothing else — a yes-or-no is a
/// `Registry<bool>` and a question a person types into is a `Registry<Option<String>>`, where `None`
/// is a deliberate skip rather than an absent answer.
pub struct Registry<T> {
    pending: Mutex<Option<HashMap<String, Sender<T>>>>,
    next_id: AtomicU64,
    open: AtomicBool,
    prefix: &'static str,
}

impl<T> Registry<T> {
    /// `prefix` is what the identifiers this registry hands out are named after, so an identifier
    /// says which surface it belongs to when it turns up in a log or an event.
    pub const fn new(prefix: &'static str) -> Self {
        Self {
            pending: Mutex::new(None),
            next_id: AtomicU64::new(1),
            open: AtomicBool::new(false),
            prefix,
        }
    }

    /// The next identifier. Monotonic per process, never reused, so a late answer to a prompt that
    /// has already settled cannot land on a different one.
    pub fn next_id(&self) -> String {
        format!(
            "{}-{}",
            self.prefix,
            self.next_id.fetch_add(1, Ordering::Relaxed)
        )
    }

    /// Whether anything is currently able to wait for an answer.
    pub fn is_open(&self) -> bool {
        self.open.load(Ordering::Acquire)
    }

    /// Opens the gate for one run. A prompt only makes sense while something is waiting on it.
    pub fn open(&self) {
        self.open.store(true, Ordering::Release);
    }

    /// Closes the gate and disconnects every waiter, which is what turns each outstanding wait into
    /// a cancellation without this needing to know how many there are.
    pub fn cancel_all(&self) {
        self.open.store(false, Ordering::Release);
        if let Ok(mut pending) = self.pending.lock() {
            pending.take();
        }
    }

    /// Parks a channel under `id` and hands back the receiving half.
    ///
    /// Registering is separate from waiting on purpose: the caller has to be able to show the prompt
    /// *after* the channel exists, or an answer that arrives immediately has nowhere to land.
    pub fn register(&self, id: &str) -> Result<Receiver<T>, AskError> {
        let (sender, receiver) = channel();
        self.pending
            .lock()
            .map_err(|_| AskError::LockPoisoned)?
            .get_or_insert_with(HashMap::new)
            .insert(id.to_owned(), sender);
        Ok(receiver)
    }

    /// Removes a prompt from the registry and hands back its sender.
    ///
    /// Every ending goes through here, and that is what makes them exclusive: an answer, a timeout
    /// and a cancellation all race to remove the same entry, and only one of them can.
    pub fn take(&self, id: &str) -> Option<Sender<T>> {
        self.pending
            .lock()
            .ok()?
            .as_mut()
            .and_then(|pending| pending.remove(id))
    }

    /// Answers one waiting prompt.
    pub fn respond(&self, id: &str, answer: T) -> Result<(), AskError> {
        let sender = self.take(id).ok_or(AskError::Unknown)?;
        sender.send(answer).map_err(|_| AskError::Expired)
    }

    /// The identifiers currently waiting, for a test backend that has no window to learn them from.
    #[cfg(test)]
    pub fn waiting(&self) -> Vec<String> {
        self.pending
            .lock()
            .ok()
            .and_then(|pending| pending.as_ref().map(|map| map.keys().cloned().collect()))
            .unwrap_or_default()
    }
}

/// One thing the agent wants looked at, as the renderer draws it.
///
/// `label` names what makes this one different rather than which one it is: shown beside two others,
/// "Bar across the top" tells the user what they are choosing between and "Option A" does not.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sketch {
    pub label: String,
    pub html: String,
}

/// What the renderer is shown when the agent asks the user something.
///
/// `options` is what the model suggested, not a closed set — the answer is free text and the options
/// are shortcuts. A question with no options is perfectly ordinary.
///
/// `sketches` is the same idea drawn rather than written, and it is why there is no second tool for
/// showing things. A question about a *layout* cannot be asked in a sentence: the user would have to
/// build the layout in their head before they could correct it. So the question carries pictures
/// when it needs to, and carries none when it does not — which is most of the time.
///
/// `revision` counts from one. A model that asks again under the same identifier is revising one
/// thing, and the card says so instead of looking like a new question.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionPrompt {
    pub question_id: String,
    pub question: String,
    pub options: Vec<String>,
    pub sketches: Vec<Sketch>,
    /// One sentence on what turns on the answer. Empty when the asker did not say.
    pub why: String,
    pub revision: u32,
}

/// Emitted whenever a question stops waiting — answered, skipped, timed out or cancelled — so the
/// renderer never leaves a card open over a decision nobody is waiting for anymore.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionSettled {
    pub question_id: String,
    pub answered: bool,
}

/// What the user did with the question.
///
/// Every field is optional in practice, and that is deliberate: answering in a sentence, picking one
/// of three sketches, and drawing on one are all whole answers. Only `skipped` says the user read the
/// question and declined to decide it.
///
/// `blocked` is not an answer at all — it is what the policy refused while a sketch was on screen. It
/// rides here because the frame has no console the model can read, so a webfont that never loaded
/// would otherwise reach it as "the user says it looks wrong" with no cause attached.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Reply {
    pub text: String,
    /// Which sketch they picked, counting from zero.
    pub picked: Option<usize>,
    pub blocked: Vec<String>,
    /// They read the question and chose not to decide it. A decision, not an absence.
    pub skipped: bool,
}

/// How a question ended.
#[derive(Clone, Debug, PartialEq)]
pub enum Answer {
    /// The user did something with it — including deliberately nothing, as `Reply::skipped`.
    Answered(Reply),
    /// Nobody answered in time.
    TimedOut,
    /// The run ended, or the question was asked after it had already ended.
    Cancelled,
    /// There is no window to ask in, so nobody could have answered.
    Unavailable,
}

const QUESTION_REQUEST_EVENT: &str = "ai-question-request";
const QUESTION_SETTLED_EVENT: &str = "ai-question-settled";

/// How long a question waits before it gives up.
///
/// Half an hour, where an approval waits five minutes, and the difference is the point of keeping the
/// two timeouts apart. An approval is a yes or no about something the user is already watching. A
/// question asks them to make a decision and write it down, and it can arrive while they are reading
/// the code it is about — or looking at a layout, which is slower still. Five minutes there is not a
/// ceiling on a hung backend, it is a ceiling on thinking.
const QUESTION_TIMEOUT: Duration = Duration::from_secs(1800);

/// The questions currently waiting. Its own registry rather than the approvals one, because the
/// answers are different shapes and the two are opened and closed by different runs.
static QUESTIONS: Registry<Reply> = Registry::new("question");

/// The number of times each question has been asked, so a revision is numbered rather than new.
///
/// Dropped whole when the run ends: an identifier never comes round again, so nothing here outlives
/// the turn that made it.
static ASKED: Mutex<Option<HashMap<String, u32>>> = Mutex::new(None);

/// Opens every surface a turn may park a prompt in.
///
/// One function rather than one per registry, and that is the whole point of it. A turn opens in one
/// place and closes in four, and a surface that has to be remembered separately at each of them is a
/// surface that will be forgotten at one of them — which reads, from the outside, as a tool call that
/// hung for half an hour over a card nobody could see.
pub fn open_user_prompts() {
    QUESTIONS.open();
}

/// Closes every surface and settles everything waiting on one as a cancellation.
pub fn cancel_user_prompts() {
    QUESTIONS.cancel_all();
    if let Ok(mut asked) = ASKED.lock() {
        asked.take();
    }
}

/// An identifier for a question nobody has asked yet.
///
/// Handed out here rather than minted by the caller so it cannot collide with one already waiting,
/// and so a caller that invents its own — which a model would, given the chance — has nothing to
/// invent: the parameter is only ever echoed back, never chosen.
pub fn new_question_id() -> String {
    QUESTIONS.next_id()
}

/// The number this asking is, counting from one, remembering it for the next.
fn next_revision(question_id: &str) -> u32 {
    let Ok(mut asked) = ASKED.lock() else {
        return 1;
    };
    let seen = asked.get_or_insert_with(HashMap::new);
    let revision = seen.get(question_id).copied().unwrap_or(0) + 1;
    seen.insert(question_id.to_owned(), revision);
    revision
}

/// Asks the user one question and blocks until they answer it, skip it, or the wait ends.
///
/// Blocking is the whole point and it is safe here for one reason: every caller reaches this from a
/// tool call, and a tool call already runs on its own thread. Called from the loop that reads the
/// worker's output instead, this would stall every event behind it — including the ones drawing the
/// question on screen, which is to say it would wait for an answer to a question nobody was shown.
///
/// `question_id` is the caller's, not ours. A caller revising something it has already asked sends
/// back the identifier it was given, which is what lets the card say "revision 3" rather than
/// pretending to be new.
pub fn ask_question<R: Runtime>(
    app: &AppHandle<R>,
    question_id: &str,
    question: &str,
    options: Vec<String>,
    sketches: Vec<Sketch>,
    why: &str,
) -> Answer {
    // Nobody to ask. An unattended backend must not answer on the user's behalf, and a caller that
    // gets this back can record the question as open rather than inventing a decision.
    if !app.webview_windows().contains_key(MAIN_WINDOW) {
        return Answer::Unavailable;
    }

    let prompt = QuestionPrompt {
        question_id: question_id.to_owned(),
        question: question.to_owned(),
        options,
        sketches,
        why: why.to_owned(),
        revision: next_revision(question_id),
    };
    let Ok(receiver) = QUESTIONS.register(&prompt.question_id) else {
        return Answer::Unavailable;
    };

    // Asked after the run already ended: there is nobody waiting on the answer, so the question is
    // never shown and the wait is skipped rather than running out its half hour.
    let abandoned = !QUESTIONS.is_open();
    if !abandoned
        && app
            .emit_to(MAIN_WINDOW, QUESTION_REQUEST_EVENT, &prompt)
            .is_err()
    {
        QUESTIONS.take(&prompt.question_id);
        return Answer::Unavailable;
    }

    let outcome = if abandoned {
        Err(RecvTimeoutError::Disconnected)
    } else {
        receiver.recv_timeout(QUESTION_TIMEOUT)
    };
    // The responder removes the entry before it answers; a timeout or a disconnect leaves it, so
    // both paths take it back out rather than leaking an identifier nobody will ever answer.
    QUESTIONS.take(&prompt.question_id);

    let answered = outcome.as_ref().is_ok_and(|reply| !reply.skipped);
    let _ = app.emit_to(
        MAIN_WINDOW,
        QUESTION_SETTLED_EVENT,
        QuestionSettled {
            question_id: prompt.question_id,
            answered,
        },
    );
    match outcome {
        Ok(reply) => Answer::Answered(reply),
        Err(RecvTimeoutError::Timeout) => Answer::TimedOut,
        Err(RecvTimeoutError::Disconnected) => Answer::Cancelled,
    }
}

/// What the renderer sends back.
#[derive(Clone, Debug, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionResponse {
    pub question_id: String,
    #[serde(default)]
    pub answer: Option<String>,
    #[serde(default)]
    pub picked: Option<usize>,
    #[serde(default)]
    pub blocked: Vec<String>,
    #[serde(default)]
    pub skipped: bool,
}

/// A refusal, in the shape every other command already reports one.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionError {
    pub code: &'static str,
    pub message: String,
    pub retryable: bool,
}

/// Answers one waiting question. Called by the renderer's `respond_user_question` command.
///
/// An answer of only whitespace is a skip, and so is a reply carrying nothing else — no words and no
/// pick. The two reach the same place from the user's side: they pressed the button without saying
/// anything. Treating that as a decision would put an empty string into a specification as though
/// somebody had chosen it.
pub fn respond_question(response: QuestionResponse) -> Result<(), QuestionError> {
    let text = response
        .answer
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .unwrap_or_default();
    let empty = text.is_empty() && response.picked.is_none();
    let reply = if response.skipped || empty {
        Reply {
            blocked: response.blocked,
            skipped: true,
            ..Reply::default()
        }
    } else {
        Reply {
            text,
            picked: response.picked,
            blocked: response.blocked,
            skipped: false,
        }
    };
    QUESTIONS
        .respond(&response.question_id, reply)
        .map_err(|error| match error {
            AskError::Unknown => QuestionError {
                code: "unknown_question",
                message: format!("Nothing is waiting for question {}", response.question_id),
                retryable: false,
            },
            AskError::Expired => QuestionError {
                code: "question_expired",
                message: format!(
                    "Question {} has already stopped waiting for an answer",
                    response.question_id
                ),
                retryable: false,
            },
            AskError::LockPoisoned => QuestionError {
                code: "lock_poisoned",
                message: "The question lock is poisoned".to_owned(),
                retryable: true,
            },
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_identifier_is_never_handed_out_twice() {
        let registry: Registry<bool> = Registry::new("q");
        let first = registry.next_id();
        let second = registry.next_id();
        assert_ne!(first, second);
        assert!(first.starts_with("q-"));
    }

    #[test]
    fn taking_a_prompt_is_what_makes_the_endings_exclusive() {
        let registry: Registry<bool> = Registry::new("q");
        let receiver = registry.register("q-1").expect("registered");
        assert_eq!(registry.waiting(), vec!["q-1".to_owned()]);

        // Whoever removes the entry owns the outcome. The second attempt finds nothing, which is how
        // a timeout that fired first stops a late answer from also settling the same prompt.
        registry.respond("q-1", true).expect("answered");
        assert_eq!(registry.respond("q-1", true), Err(AskError::Unknown));
        assert_eq!(receiver.recv_timeout(Duration::from_secs(1)), Ok(true));
        assert!(registry.waiting().is_empty());
    }

    #[test]
    fn a_run_ending_disconnects_every_waiter_without_counting_them() {
        let registry: Registry<Option<String>> = Registry::new("q");
        registry.open();
        let first = registry.register("q-1").expect("registered");
        let second = registry.register("q-2").expect("registered");

        registry.cancel_all();

        assert!(!registry.is_open());
        assert!(first.recv_timeout(Duration::from_secs(1)).is_err());
        assert!(second.recv_timeout(Duration::from_secs(1)).is_err());
        assert!(registry.waiting().is_empty());
    }

    #[test]
    fn answering_a_prompt_that_stopped_waiting_says_so() {
        let registry: Registry<bool> = Registry::new("q");
        let receiver = registry.register("q-1").expect("registered");
        drop(receiver);
        assert_eq!(registry.respond("q-1", true), Err(AskError::Expired));
    }

    /// The mock window every prompt is emitted to, so `ask_question` has somewhere to ask.
    fn mock_app_with_a_window() -> tauri::App<tauri::test::MockRuntime> {
        let app = tauri::test::mock_builder()
            .build(crate::app_context())
            .expect("build mock Tauri app");
        tauri::WebviewWindowBuilder::new(&app, MAIN_WINDOW, Default::default())
            .build()
            .expect("build mock webview");
        app
    }

    /// `QUESTIONS` is one process-wide gate, so the tests that open and close it take turns.
    static QUESTION_TEST_LOCK: Mutex<()> = Mutex::new(());

    /**
     * Blank text is the user pressing the button with nothing written, and that is a skip.
     *
     * An empty string travelling as an answer reads downstream exactly like a decision somebody
     * made, and it would be written into a specification as one. Only `Given` may carry text.
     */
    #[test]
    fn an_answer_of_only_whitespace_settles_the_question_as_a_skip() {
        let receiver = QUESTIONS.register("question-blank").expect("registered");
        respond_question(QuestionResponse {
            question_id: "question-blank".to_owned(),
            answer: Some("   \n".to_owned()),
            ..QuestionResponse::default()
        })
        .expect("answered");

        let reply = receiver
            .recv_timeout(Duration::from_secs(1))
            .expect("a reply");
        assert!(reply.skipped);
    }

    /// Text the user did write arrives trimmed, and a question only settles once.
    #[test]
    fn a_written_answer_arrives_and_the_question_stops_waiting() {
        let receiver = QUESTIONS.register("question-written").expect("registered");
        respond_question(QuestionResponse {
            question_id: "question-written".to_owned(),
            answer: Some("  use a pause menu  ".to_owned()),
            ..QuestionResponse::default()
        })
        .expect("answered");

        let reply = receiver
            .recv_timeout(Duration::from_secs(1))
            .expect("a reply");
        assert_eq!(reply.text, "use a pause menu");
        assert!(!reply.skipped);

        let late = respond_question(QuestionResponse {
            question_id: "question-written".to_owned(),
            answer: Some("too late".to_owned()),
            ..QuestionResponse::default()
        })
        .expect_err("nothing is waiting anymore");
        assert_eq!(late.code, "unknown_question");
        assert!(!late.retryable);
    }

    /// Pressing skip discards whatever was typed, rather than sending it as the decision.
    #[test]
    fn a_skip_beats_the_text_that_was_left_in_the_box() {
        let receiver = QUESTIONS.register("question-skipped").expect("registered");
        respond_question(QuestionResponse {
            question_id: "question-skipped".to_owned(),
            answer: Some("half a thought".to_owned()),
            skipped: true,
            ..QuestionResponse::default()
        })
        .expect("answered");

        let reply = receiver
            .recv_timeout(Duration::from_secs(1))
            .expect("a reply");
        assert!(reply.skipped);
        assert!(reply.text.is_empty());
    }

    /// A card answered after its waiter is gone says so instead of reporting success.
    #[test]
    fn answering_a_question_whose_waiter_has_gone_is_reported_as_expired() {
        let receiver = QUESTIONS.register("question-expired").expect("registered");
        drop(receiver);

        let failure = respond_question(QuestionResponse {
            question_id: "question-expired".to_owned(),
            answer: Some("anything".to_owned()),
            ..QuestionResponse::default()
        })
        .expect_err("the waiter is gone");

        assert_eq!(failure.code, "question_expired");
    }

    /**
     * No window is nobody to ask, and the agent must not answer for the user.
     *
     * A headless backend still runs tools, and a question reaching one has to come back as
     * unanswered rather than blocking the tool call for half an hour over a card nobody can see.
     */
    #[test]
    fn a_question_with_no_window_to_show_it_in_is_unavailable_at_once() {
        let app = tauri::test::mock_builder()
            .build(crate::app_context())
            .expect("build mock Tauri app");

        assert_eq!(
            ask_question(
                app.handle(),
                "question-1",
                "which menu?",
                Vec::new(),
                Vec::new(),
                "it decides the scene"
            ),
            Answer::Unavailable
        );
    }

    /**
     * A question asked after the run ended is cancelled, not waited on.
     *
     * The gate is checked after registering, because a run can end while the tool call is on its
     * way in here. Without it the card is never shown and the caller sits out the full half hour
     * waiting for an answer to a question nobody was ever asked.
     */
    #[test]
    fn a_question_asked_after_its_run_ended_is_cancelled_rather_than_waited_on() {
        let _guard = QUESTION_TEST_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let app = mock_app_with_a_window();
        cancel_user_prompts();

        assert_eq!(
            ask_question(
                app.handle(),
                "question-2",
                "which menu?",
                vec!["pause".to_owned()],
                Vec::new(),
                ""
            ),
            Answer::Cancelled
        );
    }

    /**
     * The whole round trip: the question is shown, the user writes, the tool call resumes.
     *
     * `ask_question` blocks, so the answer has to come from another thread — which is also the
     * real shape: the tool call waits on its own thread while the renderer answers on the window's.
     */
    #[test]
    fn a_question_that_is_answered_hands_the_text_back_to_the_caller() {
        let _guard = QUESTION_TEST_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let app = mock_app_with_a_window();
        open_user_prompts();

        let responder = std::thread::spawn(|| {
            for _ in 0..200 {
                if let Some(id) = QUESTIONS.waiting().into_iter().next() {
                    return respond_question(QuestionResponse {
                        question_id: id,
                        answer: Some("a pause menu".to_owned()),
                        ..QuestionResponse::default()
                    });
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            panic!("no question was ever registered")
        });

        let answer = ask_question(
            app.handle(),
            "question-3",
            "which menu?",
            Vec::new(),
            Vec::new(),
            "it picks the scene",
        );
        responder
            .join()
            .expect("responder thread")
            .expect("answered");

        assert_eq!(
            answer,
            Answer::Answered(Reply {
                text: "a pause menu".to_owned(),
                ..Reply::default()
            })
        );
        cancel_user_prompts();
    }

    /// A sketch and a question are different waits, and the gate has to reach both.
    #[test]
    fn one_gate_covers_every_surface_a_turn_can_park_a_prompt_in() {
        let _guard = QUESTION_TEST_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        open_user_prompts();
        assert!(QUESTIONS.is_open());
        cancel_user_prompts();
        assert!(!QUESTIONS.is_open());
    }

    /**
     * A reply carrying nothing is a skip, because there is no way to tell it from one.
     *
     * The renderer sends what the user left behind. Somebody who pressed the button with an empty
     * box, no pick and no marks has declined to decide, and inventing a difference between that and
     * pressing skip would put an opinion into the record that nobody had.
     */
    #[test]
    fn a_reply_holding_nothing_settles_the_question_as_a_skip() {
        let receiver = QUESTIONS.register("question-empty").expect("registered");
        respond_question(QuestionResponse {
            question_id: "question-empty".to_owned(),
            answer: Some("   \n".to_owned()),
            ..QuestionResponse::default()
        })
        .expect("answered");

        let reply = receiver
            .recv_timeout(Duration::from_secs(1))
            .expect("a reply");
        assert!(reply.skipped);
        assert!(reply.text.is_empty());
    }

    /**
     * The whole round trip, and the revision counter that makes an iteration read as one thing.
     *
     * `ask_question` blocks, so the answer comes from another thread — which is also the real shape:
     * the tool call waits on its own thread while the renderer answers on the window's.
     */
    #[test]
    fn a_question_asked_twice_under_one_id_is_a_second_revision_of_the_same_thing() {
        let _guard = QUESTION_TEST_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let app = mock_app_with_a_window();
        open_user_prompts();

        let reply = || {
            std::thread::spawn(|| {
                for _ in 0..200 {
                    if let Some(id) = QUESTIONS.waiting().into_iter().next() {
                        return respond_question(QuestionResponse {
                            question_id: id,
                            picked: Some(1),
                            ..QuestionResponse::default()
                        });
                    }
                    std::thread::sleep(Duration::from_millis(10));
                }
                panic!("no question was ever registered")
            })
        };

        let sketches = vec![
            Sketch {
                label: "Bar across the top".to_owned(),
                html: "<p>a</p>".to_owned(),
            },
            Sketch {
                label: "Side rail".to_owned(),
                html: "<p>b</p>".to_owned(),
            },
        ];

        let first = reply();
        let one = ask_question(
            app.handle(),
            "question-rev",
            "which?",
            Vec::new(),
            sketches.clone(),
            "",
        );
        first.join().expect("responder thread").expect("answered");
        assert_eq!(
            one,
            Answer::Answered(Reply {
                picked: Some(1),
                ..Reply::default()
            })
        );

        // The second asking is the same question, so nothing is registered twice and the number the
        // card carries goes up rather than starting over.
        let second = reply();
        ask_question(
            app.handle(),
            "question-rev",
            "which?",
            Vec::new(),
            sketches,
            "",
        );
        second.join().expect("responder thread").expect("answered");
        assert_eq!(next_revision("question-rev"), 3);

        cancel_user_prompts();
    }

    /// An identifier is never handed out twice, so a late answer cannot land on a later question.
    #[test]
    fn every_question_is_given_an_identifier_of_its_own() {
        assert_ne!(new_question_id(), new_question_id());
        assert!(new_question_id().starts_with("question-"));
    }

    #[test]
    fn a_skip_is_an_answer_the_channel_can_carry() {
        let registry: Registry<Reply> = Registry::new("q");
        let receiver = registry.register("q-1").expect("registered");
        registry
            .respond(
                "q-1",
                Reply {
                    skipped: true,
                    ..Reply::default()
                },
            )
            .expect("answered");
        assert!(
            receiver
                .recv_timeout(Duration::from_secs(1))
                .expect("a reply")
                .skipped
        );
    }
}

//! Asking the user something and blocking until they answer.
//!
//! Two things in Gofer need this and they need it for different reasons: a tool call that may not run
//! unattended has to stop for a yes or no, and an agent that has run out of ways to decide something
//! has to stop for a sentence. Both are the same mechanism — hand out an identifier, park a channel
//! under it, show the renderer a prompt, and wait — and the mechanism is the part that is easy to get
//! subtly wrong, so it is written once here and instantiated per answer shape.
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

/// What the renderer is shown when the agent asks the user something.
///
/// `options` is what the model suggested, not a closed set — the answer is free text and the options
/// are shortcuts. A question with no options is perfectly ordinary.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionPrompt {
    pub question_id: String,
    pub question: String,
    pub options: Vec<String>,
    /// One sentence on what turns on the answer. Empty when the asker did not say.
    pub why: String,
}

/// Emitted whenever a question stops waiting — answered, skipped, timed out or cancelled — so the
/// renderer never leaves a card open over a decision nobody is waiting for anymore.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionSettled {
    pub question_id: String,
    pub answered: bool,
}

const QUESTION_REQUEST_EVENT: &str = "ai-question-request";
const QUESTION_SETTLED_EVENT: &str = "ai-question-settled";

/// How long a question waits before it gives up.
///
/// Half an hour, where an approval waits five minutes, and the difference is the point of keeping the
/// two timeouts apart. An approval is a yes or no about something the user is already watching. A
/// question asks them to make a decision and write it down, and it can arrive while they are reading
/// the code it is about. Five minutes there is not a ceiling on a hung backend, it is a ceiling on
/// thinking.
const QUESTION_TIMEOUT: Duration = Duration::from_secs(1800);

/// The questions currently waiting. Its own registry rather than the approvals one, because the
/// answers are different shapes and the two are opened and closed by different runs.
static QUESTIONS: Registry<Option<String>> = Registry::new("question");

/// How a question ended.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Answer {
    /// The user wrote something.
    Given(String),
    /// The user saw the question and chose not to pin it. A decision, not an absence.
    Skipped,
    /// Nobody answered in time.
    TimedOut,
    /// The run ended, or the question was asked after it had already ended.
    Cancelled,
    /// There is no window to ask in, so nobody could have answered.
    Unavailable,
}

/// Opens the gate for one run that may ask questions.
pub fn open_questions() {
    QUESTIONS.open();
}

/// Closes the gate and settles every waiting question as a cancellation.
pub fn cancel_questions() {
    QUESTIONS.cancel_all();
}

/// Asks the user one question and blocks until they answer it, skip it, or the wait ends.
///
/// Blocking is the whole point and it is safe here for one reason: every caller reaches this from a
/// tool call, and a tool call already runs on its own thread. Called from the loop that reads the
/// worker's output instead, this would stall every event behind it — including the ones drawing the
/// question on screen, which is to say it would wait for an answer to a question nobody was shown.
pub fn ask_question<R: Runtime>(
    app: &AppHandle<R>,
    question: &str,
    options: Vec<String>,
    why: &str,
) -> Answer {
    // Nobody to ask. An unattended backend must not answer on the user's behalf, and a caller that
    // gets this back can record the question as open rather than inventing a decision.
    if !app.webview_windows().contains_key(MAIN_WINDOW) {
        return Answer::Unavailable;
    }

    let prompt = QuestionPrompt {
        question_id: QUESTIONS.next_id(),
        question: question.to_owned(),
        options,
        why: why.to_owned(),
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

    let answered = matches!(outcome, Ok(Some(_)));
    let _ = app.emit_to(
        MAIN_WINDOW,
        QUESTION_SETTLED_EVENT,
        QuestionSettled {
            question_id: prompt.question_id,
            answered,
        },
    );
    match outcome {
        Ok(Some(text)) => Answer::Given(text),
        Ok(None) => Answer::Skipped,
        Err(RecvTimeoutError::Timeout) => Answer::TimedOut,
        Err(RecvTimeoutError::Disconnected) => Answer::Cancelled,
    }
}

/// What the renderer sends back. `answer` absent — or `skipped` — is the user declining to decide,
/// which is a different thing from an empty answer and is carried as one.
#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionResponse {
    pub question_id: String,
    #[serde(default)]
    pub answer: Option<String>,
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
/// An answer of only whitespace is a skip. The two reach the same place from the user's side — they
/// pressed the button without writing anything — and treating blank text as a decision would put an
/// empty string into a specification as though somebody had chosen it.
pub fn respond_question(response: QuestionResponse) -> Result<(), QuestionError> {
    let answer = response
        .answer
        .map(|text| text.trim().to_owned())
        .filter(|text| !text.is_empty() && !response.skipped);
    QUESTIONS
        .respond(&response.question_id, answer)
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
            skipped: false,
        })
        .expect("answered");

        assert_eq!(receiver.recv_timeout(Duration::from_secs(1)), Ok(None));
    }

    /// Text the user did write arrives trimmed, and a question only settles once.
    #[test]
    fn a_written_answer_arrives_and_the_question_stops_waiting() {
        let receiver = QUESTIONS.register("question-written").expect("registered");
        respond_question(QuestionResponse {
            question_id: "question-written".to_owned(),
            answer: Some("  use a pause menu  ".to_owned()),
            skipped: false,
        })
        .expect("answered");

        assert_eq!(
            receiver.recv_timeout(Duration::from_secs(1)),
            Ok(Some("use a pause menu".to_owned()))
        );

        let late = respond_question(QuestionResponse {
            question_id: "question-written".to_owned(),
            answer: Some("too late".to_owned()),
            skipped: false,
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
        })
        .expect("answered");

        assert_eq!(receiver.recv_timeout(Duration::from_secs(1)), Ok(None));
    }

    /// A card answered after its waiter is gone says so instead of reporting success.
    #[test]
    fn answering_a_question_whose_waiter_has_gone_is_reported_as_expired() {
        let receiver = QUESTIONS.register("question-expired").expect("registered");
        drop(receiver);

        let failure = respond_question(QuestionResponse {
            question_id: "question-expired".to_owned(),
            answer: Some("anything".to_owned()),
            skipped: false,
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
                "which menu?",
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
        cancel_questions();

        assert_eq!(
            ask_question(app.handle(), "which menu?", vec!["pause".to_owned()], ""),
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
        open_questions();

        let responder = std::thread::spawn(|| {
            for _ in 0..200 {
                if let Some(id) = QUESTIONS.waiting().into_iter().next() {
                    return respond_question(QuestionResponse {
                        question_id: id,
                        answer: Some("a pause menu".to_owned()),
                        skipped: false,
                    });
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            panic!("no question was ever registered")
        });

        let answer = ask_question(
            app.handle(),
            "which menu?",
            Vec::new(),
            "it picks the scene",
        );
        responder
            .join()
            .expect("responder thread")
            .expect("answered");

        assert_eq!(answer, Answer::Given("a pause menu".to_owned()));
        cancel_questions();
    }

    #[test]
    fn a_skip_is_an_answer_the_channel_can_carry() {
        let registry: Registry<Option<String>> = Registry::new("q");
        let receiver = registry.register("q-1").expect("registered");
        registry.respond("q-1", None).expect("answered");
        assert_eq!(receiver.recv_timeout(Duration::from_secs(1)), Ok(None));
    }
}

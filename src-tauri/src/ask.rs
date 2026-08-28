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

use crate::ai_tools::ToolFailure;
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::OnceLock;
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
    /// The tool call these questions belong to, which is the block in the feed that draws them.
    ///
    /// Set by the tool rather than by whatever is asking, and it changes only the window. It is the
    /// one link between a call and the questions it produces: a delegated design asks about one
    /// layout several times, and every round carries the PARENT's call id, so the rounds land on one
    /// card being revised rather than as a pile of unrelated questions. Nothing on this side reads
    /// it.
    ///
    /// Left out of the payload entirely when there is none, rather than sent as `null`. A live sweep
    /// found why, on the field this replaces: the card asked whether it was `undefined`, and `null`
    /// is not `undefined` — so every ordinary question arrived dressed as a design loop, grew a
    /// button that ends one, and refused to close on Escape.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner_call_id: Option<String>,
    /// Whether a child is asking this on another agent's behalf.
    ///
    /// The one thing the block cannot work out from the question itself, and it decides one control:
    /// the button that ends a delegation. Only a delegated question has an agent still looping
    /// behind it, so only a delegated question has a loop to end.
    pub is_delegated: bool,
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
    /// They ended the design here: this layout is agreed and there is nothing more to show them.
    ///
    /// Only a delegated question can produce this, because only its block has the button. It is the
    /// opposite of `skipped` — the user decided the whole thing rather than none of it — and the
    /// asker is both told so and stopped from asking again.
    pub approved: bool,
    /// They want another round on this, whatever else they wrote.
    ///
    /// The middle of the three endings, and the one that had no control at all for a while: a design
    /// could be iterated because its block carried "Send changes", and an ordinary question could
    /// only be answered. But the line between a question worth one round and a question worth three
    /// is the user's to draw, not the model's — that is the whole reason the two tools became one.
    ///
    /// It is not the same as saying nothing. A model reads an answer and decides for itself whether
    /// to come back; this is the user saying they expect it to.
    pub again: bool,
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
///
/// [`crate::approvals`] is one of those surfaces, and it was outside this call until it was not.
/// The bundling stopped at the two question registries, so every caller opened a pair by hand —
/// five of them in [`crate::ai_turn`] and a sixth in the journey harness, which copied only the
/// approval half and refused every `ask_user` a journey ever made. An approval and a question are
/// different answers, which is why they are different registries; there is no run in which one of
/// them should be open and the other shut, which is why there is one function.
pub fn open_user_prompts() {
    QUESTIONS.open();
    crate::approvals::open();
}

/// Closes every surface and settles everything waiting on one as a cancellation.
pub fn cancel_user_prompts() {
    QUESTIONS.cancel_all();
    crate::approvals::cancel_all();
    if let Ok(mut asked) = ASKED.lock() {
        asked.take();
    }
}

/// Whether anything is currently able to ask the user a question.
///
/// The questions' half of what [`crate::approvals::is_open`] answers for approvals, and only the
/// tests read it — for the same reason and to assert the same invariant: no run, no gate. A caller
/// with something to ask calls [`ask_question`], which answers what it actually wants to know.
#[cfg(test)]
pub(crate) fn questions_open() -> bool {
    QUESTIONS.is_open()
}

/// The questions currently waiting for an answer, for a suite that has no window to ask in.
///
/// The twin of [`crate::approvals::pending_approvals`], and it exists for the same reason: a live
/// turn has no user, and everything a turn can stop and wait for has to be answerable by the run
/// itself. Approvals had that half and questions did not, so a turn that asked one waited out
/// `QUESTION_TIMEOUT` — **thirty minutes**, in a harness that answers approvals in milliseconds.
/// One live run spent them, on a task whose fixture did not hold what the task described.
///
/// Absent from every non-test build.
#[cfg(all(test, feature = "godot-acceptance"))]
pub fn pending_questions() -> Vec<String> {
    QUESTIONS.waiting()
}

/// An identifier for a question nobody has asked yet.
///
/// Handed out here rather than minted by the caller so it cannot collide with one already waiting,
/// and so a caller that invents its own — which a model would, given the chance — has nothing to
/// invent: the parameter is only ever echoed back, never chosen.
pub fn new_question_id() -> String {
    QUESTIONS.next_id()
}

/// The name a question's sketch is kept under: stable across its revisions, unique across runs.
///
/// A question identifier is a counter seeded at one *per process*, so every run's first question is
/// `question-1`. Keyed on that alone, run two overwrote run one's saved layout — which nobody saw,
/// because nothing read the folder back until there was a screen for it.
///
/// The run segment is minted once and shared, so the two halves say the two things that matter. The
/// question half keeps a revision replacing its predecessor in place, which is the whole contract of
/// the store: a ten-round design leaves one file holding what was actually agreed. The run half
/// keeps yesterday's ten rounds out of today's.
///
/// Hex and hyphens only, which is what `storage::is_sketch_id_byte` allows, because this value
/// becomes a filename.
pub fn new_sketch_id(question_id: &str) -> String {
    static RUN: OnceLock<String> = OnceLock::new();
    let run = RUN.get_or_init(|| uuid::Uuid::now_v7().simple().to_string());
    format!("{question_id}-{run}")
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
#[allow(clippy::too_many_arguments)]
pub fn ask_question<R: Runtime>(
    app: &AppHandle<R>,
    question_id: &str,
    question: &str,
    options: Vec<String>,
    sketches: Vec<Sketch>,
    why: &str,
    owner_call_id: Option<String>,
    is_delegated: bool,
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
        owner_call_id,
        is_delegated,
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
    #[serde(default)]
    pub approved: bool,
    #[serde(default)]
    pub again: bool,
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
    // An approval is never empty, whatever else it carries. It is the user saying the design is
    // done, which is the most definite answer this card can produce — and reading it as "they
    // pressed a button without saying anything" would turn the end of a design into a skip.
    // Asking for another round is never empty either: it is the user saying the decision is not
    // finished, which is a thing they did rather than a box they left alone.
    let empty =
        text.is_empty() && response.picked.is_none() && !response.approved && !response.again;
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
            approved: response.approved,
            again: response.again,
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

/// Asking the user something, by the name the worker sends it under.
///
/// Deliberately not a [`crate::ai_tools::CATALOG`] domain. Everything in that list is a Godot
/// domain with an addon handler, an `ops` list and a generated parameter contract, and a question
/// has none of those. It is a host operation the same way storing a credential is — it lives in
/// Rust because the window does, not because it belongs to the editor.
pub const ASK_USER_TOOL: &str = "ask_user";

/// A value with its surrounding quotation marks taken off, if it arrived wearing any.
///
/// Written for the question identifier, and measured rather than guessed. The answer the model reads
/// used to name the identifier in quotes, and the real model copied the quotes into the parameter —
/// `"question-1"` instead of `question-1`. That is a different identifier: the revision counter
/// started again at one and a fourth draft was drawn as though it were the first.
///
/// The wording was fixed too, next to the sentence that caused it. This is the half that holds when
/// the wording does not, which is the only half worth relying on. Safe because an identifier this
/// side hands out is `question-<n>` and never contains a quotation mark.
fn unquoted(value: &str) -> String {
    value
        .trim()
        .trim_matches(|character| character == '"' || character == '\'')
        .trim()
        .to_owned()
}

/// Blocks until the user answers, and reports every other ending as a failure the asker can act on.
///
/// A skip and a timeout are told apart on purpose. A skip is a decision — the user read the question
/// and left it to the implementer — so it comes back as an ordinary answer saying so. A timeout and a
/// cancellation are not answers at all, and reporting them as an empty one would put words in the
/// user's mouth.
pub(crate) fn ask_user<R: Runtime>(
    app: &AppHandle<R>,
    params: &Value,
) -> Result<Value, ToolFailure> {
    if params
        .get(crate::ai_tools::PROBE_KEY)
        .and_then(Value::as_bool)
        == Some(true)
    {
        return crate::ai_tools::probe(ASK_USER_TOOL);
    }
    let question = params
        .get("question")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .ok_or_else(|| invalid("ask_user needs a `question`: the one thing you want decided."))?;
    let options = params
        .get("options")
        .and_then(Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    let why = params
        .get("why")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let sketches = requested_sketches(params)?;
    // Echoed back rather than chosen: a caller revising something it has already asked about sends
    // the identifier it was given, and anything else starts a new question under a fresh one.
    let question_id = params
        .get("questionId")
        .and_then(Value::as_str)
        .map(unquoted)
        .filter(|text| !text.is_empty())
        .unwrap_or_else(new_question_id);
    // Put there by the tool, never by the model. It names the call in the feed these questions belong
    // to, which is the difference between a card that stays put across a revision and a pile of
    // unrelated questions.
    let owner_call_id = params
        .get("ownerCallId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_owned);
    // Set only by the copy of the tool a delegated child holds. It draws the button that ends the
    // delegation, and nothing else has a delegation to end.
    let is_delegated = params
        .get("isDelegated")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    // Resolved before anything is shown, so the user judges a layout with the game's own artwork in
    // it rather than with the window's default typeface.
    //
    // The model's own markup is kept beside the resolved copy, because the two are read by different
    // readers. The window is shown the resolved one, so a sprite is a sprite. The agent that asked
    // for the design is handed the original: inlining turns a 2KB layout into 80KB of base64 that
    // says nothing a builder can act on, and `res://` is the path it has to build against anyway.
    let (shown, unresolved) = resolve_sketch_assets(app, sketches.clone());

    match ask_question(
        app,
        &question_id,
        question,
        options,
        shown.clone(),
        why,
        owner_call_id,
        is_delegated,
    ) {
        Answer::Answered(reply) => {
            keep_sketch(app, &question_id, question, &sketches, &shown, &reply);
            Ok(reply_answer(&question_id, &sketches, &reply, unresolved))
        }
        Answer::TimedOut => Err(ToolFailure::new(
            "question_timeout",
            "Nobody answered the question in time. Decide it yourself and say which way you went.",
        )),
        Answer::Cancelled => Err(ToolFailure::new(
            "question_cancelled",
            "The question was cancelled because the run ended.",
        )),
        Answer::Unavailable => Err(ToolFailure::new(
            "question_unavailable",
            "There is no window open to ask the user anything.",
        )),
    }
}

/// Puts the project's own artwork into every sketch, and says what it could not find.
///
/// No workspace open is not a reason to refuse the question: one that names no asset is unaffected,
/// and one that does says so in its own answer.
fn resolve_sketch_assets<R: Runtime>(
    app: &AppHandle<R>,
    sketches: Vec<Sketch>,
) -> (Vec<Sketch>, Vec<String>) {
    let Ok(workspace) = crate::active_workspace(app) else {
        return (sketches, Vec::new());
    };
    let mut refused = Vec::new();
    let resolved = sketches
        .into_iter()
        .map(|sketch| {
            let (html, missing) = inline_project_assets(&workspace, &sketch.html);
            refused.extend(missing);
            Sketch { html, ..sketch }
        })
        .collect();
    (resolved, refused)
}

/// The reply as the worker reads it.
///
/// The prose is written in `scripts/ai-ask.mjs`, next to the description that told the model what to
/// send, so the two are edited together.
fn reply_answer(
    question_id: &str,
    sketches: &[Sketch],
    reply: &Reply,
    unresolved: Vec<String>,
) -> Value {
    let picked = reply
        .picked
        .filter(|index| *index < sketches.len())
        .map(|index| json!({"index": index, "label": sketches[index].label}));
    // The layout the user reacted to, as the model wrote it.
    //
    // Not part of the prose, and the design tool is the only thing that reads it: a child asking a
    // question does not need its own markup handed back, and putting it in the answer text would
    // charge the child for the drawing on every round. It rides here so the *parent* can be shown
    // what was agreed.
    //
    // Which one that is comes from `chosen_sketch`, the same function that decides what is kept.
    // Two rules would mean the panel showing a layout the asker was never told about, and each
    // half would look right on its own.
    let chosen = chosen_sketch(sketches, sketches, reply)
        .map(|(sketch, _)| json!({"label": sketch.label, "html": sketch.html}));
    json!({
        "questionId": question_id,
        "skipped": reply.skipped,
        "note": skipping_is_a_decision(reply),
        "approved": reply.approved,
        "again": reply.again,
        "answer": reply.text,
        "picked": picked,
        "sketch": chosen,
        "sketches": sketches.len(),
        "blocked": reply.blocked,
        "unresolved": unresolved,
    })
}

/// What a skip means, in the answer rather than only in this file's comments.
///
/// [`ask_user`] says it at length — "a skip is a decision, the user read the question and left it
/// to the implementer" — and until now the model was told it as `"skipped": true` and nothing else.
/// A boolean with no word beside it is a boolean a reader has to guess at, and one live turn
/// guessed the other way: asked whether to delete a script it had just unregistered, it was skipped,
/// and it finished with "`scripts/old_save_system.gd` remains orphaned because file-deletion
/// approval was not provided". A skip is not a refusal, and nothing had refused it.
///
/// Nothing is loosened by saying so. What a caller may actually do is decided by the approval gate,
/// which is a different registry with a different answer — a skipped question cannot make a
/// `godot_resource delete` happen, and this sentence does not claim it can.
fn skipping_is_a_decision(reply: &Reply) -> Option<&'static str> {
    reply.skipped.then_some(
        "The user read this and left the decision to you. Nothing was refused and nothing is \
         blocked by it: choose what you judge best, do it, and say which way you went. Anything \
         that needs their permission asks for it separately.",
    )
}

/// Keeps the revision the user reacted to, so what was agreed outlives the turn that agreed it.
///
/// Best effort, and silent. The caller is a tool call somebody is waiting on: a project with no
/// storage open, or a full disk, must cost an artefact rather than the answer itself.
///
/// Both copies are kept, at the same index, because they are read by different readers. The window
/// gets the one with the project's artwork inlined, which is the only copy worth drawing again; a
/// builder gets the model's own markup, because the inlined one is base64 that says nothing.
///
/// The empty case is not an edge. Every question asked in words reaches this function, and must
/// leave nothing behind — which is what `chosen_sketch` answering `None` means.
fn keep_sketch<R: Runtime>(
    app: &AppHandle<R>,
    question_id: &str,
    question: &str,
    sketches: &[Sketch],
    shown: &[Sketch],
    reply: &Reply,
) {
    let Some((source, shown_html)) = chosen_sketch(sketches, shown, reply) else {
        return;
    };
    let Ok(storage) = crate::workspace::project_storage(app) else {
        return;
    };
    let task_id = storage.tasks().active().ok().flatten();
    let _ = storage.sketches().keep(&crate::storage::KeptSketch {
        sketch_id: &new_sketch_id(question_id),
        question_id,
        task_id: task_id.as_deref(),
        question,
        label: &source.label,
        shown_html,
        source_html: &source.html,
        is_approved: reply.approved,
    });
}

/// Which sketch the answer was about, in both of its copies.
///
/// The two are taken at the same index and that is the whole of the rule. Crossed over, a builder
/// would be handed eighty kilobytes of base64 and the user would be shown a layout with its artwork
/// missing — and neither would fail loudly enough for anybody to notice.
///
/// The one place the answer is decided, for the asker and for the sketches panel alike. It is read
/// twice because the two used to decide it separately, and disagreed exactly where it mattered: the
/// asker was correctly told nothing was chosen while the panel filed a guess under "the layout you
/// chose".
fn chosen_sketch<'a>(
    sketches: &'a [Sketch],
    shown: &'a [Sketch],
    reply: &Reply,
) -> Option<(&'a Sketch, &'a str)> {
    if reply.skipped {
        return None;
    }
    // No pick at all is not the same as a pick that arrived wrong, and only the second is ours to
    // absorb. Words against three variants name none of them, so nothing is kept: guessing the
    // first is a one-in-three guess, and what is kept becomes what somebody builds. One sketch is
    // the exception, because there is nothing else the words could have been about.
    let index = match reply.picked {
        Some(picked) if picked < sketches.len() => picked,
        Some(_) => 0,
        None if sketches.len() == 1 => 0,
        None => return None,
    };
    let source = sketches.get(index)?;
    // `resolve_sketch_assets` maps one to one, so this is the same sketch. Read rather than indexed
    // anyway: a panic here would cost the user the answer they have just given.
    let shown_html = shown
        .get(index)
        .map_or(source.html.as_str(), |sketch| sketch.html.as_str());
    Some((source, shown_html))
}

/// The most variants one showing may hold.
///
/// Three, because the point of more than one is that the user can tell them apart at a glance, and
/// the fourth is where that stops being true. A model with four layouts has not narrowed anything
/// down, and the way to narrow it down is to ask about them in words first.
const MAX_SKETCHES: usize = 3;

/// The most markup one sketch may hold.
///
/// A ceiling on what the *model* spends, not on what the renderer can draw. Every revision is written
/// out in full, so a model that answers a layout question with a stylesheet pays for it on every
/// round of an iteration — and three variants at this size still sit inside the tool-text ceiling in
/// `scripts/tool-result.mjs`.
const MAX_SKETCH_CHARS: usize = 8_000;

fn invalid(message: impl Into<String>) -> ToolFailure {
    ToolFailure::new("invalid_params", message)
}

/// Reads the sketches out of the call, refusing every shape the renderer could not draw.
///
/// Absent and empty both mean a question in words, which is what most questions are. Only a
/// `sketches` that is present and misshapen is a mistake worth naming.
fn requested_sketches(params: &Value) -> Result<Vec<Sketch>, ToolFailure> {
    let Some(given) = params.get("sketches").filter(|value| !value.is_null()) else {
        return Ok(Vec::new());
    };
    let entries = given.as_array().ok_or_else(|| {
        invalid("`sketches` is a list of {label, html}. Leave it out entirely to ask in words.")
    })?;
    if entries.is_empty() {
        return Ok(Vec::new());
    }
    if entries.len() > MAX_SKETCHES {
        return Err(invalid(format!(
            "ask_user was given {} sketches and shows at most {MAX_SKETCHES}. More than three \
             cannot be told apart at a glance, so narrow them down in words first.",
            entries.len()
        )));
    }
    entries
        .iter()
        .enumerate()
        .map(|(index, entry)| {
            let text = |name: &str| {
                entry
                    .get(name)
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
            };
            let label = text("label").ok_or_else(|| {
                invalid(format!(
                    "Sketch {} has no `label`. Name what makes it different in two or three words \
                     — \"Bar across the top\", not \"Option A\".",
                    index + 1
                ))
            })?;
            let html = text("html")
                .ok_or_else(|| invalid(format!("Sketch {} has no `html` to show.", index + 1)))?;
            if html.chars().count() > MAX_SKETCH_CHARS {
                return Err(invalid(format!(
                    "Sketch {} holds {} characters and the ceiling is {MAX_SKETCH_CHARS}. Cut the \
                     styling rather than the structure: the layout is what is being looked at.",
                    index + 1,
                    html.chars().count()
                )));
            }
            Ok(Sketch {
                label: label.to_owned(),
                html: html.to_owned(),
            })
        })
        .collect()
}

/// The most one inlined asset may weigh, before encoding.
///
/// A sketch travels as a string through a window event, so a background plate at full resolution
/// would be megabytes of base64 in a message the renderer parses on the main thread. Anything larger
/// is reported to the model as unusable rather than quietly making the dialog slow.
const MAX_ASSET_BYTES: u64 = 512 * 1024;

/// What a `res://` path is served as, by its extension.
///
/// A short list on purpose: these are the things a layout is made of. Anything else has no business
/// being fetched by a sketch, and saying so by name is more useful than guessing a type.
fn asset_mime(path: &str) -> Option<&'static str> {
    let extension = path.rsplit('.').next()?.to_ascii_lowercase();
    Some(match extension.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        _ => return None,
    })
}

/// Where one `res://` reference ends: at the quote, bracket or space that closes it.
fn reference_end(rest: &str) -> usize {
    rest.find(|character: char| {
        character.is_whitespace() || matches!(character, '"' | '\'' | ')' | '>' | ',' | ';')
    })
    .unwrap_or(rest.len())
}

/// Replaces every `res://` reference in a sketch with the bytes it names.
///
/// The reason this exists at all: the frame runs under a policy that refuses everything remote, and
/// a local file is not reachable from it either. So a sketch of a pause menu was drawn in the
/// window's own typeface rather than the game's — which is the one thing the user was being asked to
/// judge. The model cannot fix that itself; `read` hands it text, and a font is not text.
///
/// Confined by `files::Workspace`, which resolves against the task's worktree and refuses anything
/// outside it. `res://` is Godot's own spelling for exactly that root, so the model writes the path
/// it already uses everywhere else and gets the file.
///
/// Returns the rewritten markup and every reference it could not honour, worded for the model.
fn inline_project_assets(workspace: &crate::files::Workspace, html: &str) -> (String, Vec<String>) {
    const PREFIX: &str = "res://";
    let mut out = String::with_capacity(html.len());
    let mut refused = Vec::new();
    let mut rest = html;
    while let Some(start) = rest.find(PREFIX) {
        out.push_str(&rest[..start]);
        let tail = &rest[start + PREFIX.len()..];
        let end = reference_end(tail);
        let relative = &tail[..end];
        rest = &tail[end..];
        match asset_data_uri(workspace, relative) {
            Ok(uri) => out.push_str(&uri),
            Err(reason) => {
                // The reference is left as it was written. Removed, the markup would silently lose
                // an attribute; left alone, the model can see in its own sketch what did not resolve.
                out.push_str(PREFIX);
                out.push_str(relative);
                refused.push(format!("res://{relative} ({reason})"));
            }
        }
    }
    out.push_str(rest);
    (out, refused)
}

/// One asset as a `data:` URI, or why it is not one.
fn asset_data_uri(workspace: &crate::files::Workspace, relative: &str) -> Result<String, String> {
    let Some(mime) = asset_mime(relative) else {
        return Err("not a picture or a font".to_owned());
    };
    let path = workspace
        .resolve(relative)
        .map_err(|_| "outside the project".to_owned())?;
    let size = std::fs::metadata(&path)
        .map_err(|_| "no such file".to_owned())?
        .len();
    if size > MAX_ASSET_BYTES {
        return Err(format!(
            "{size} bytes, over the {MAX_ASSET_BYTES} a sketch may carry"
        ));
    }
    let bytes = std::fs::read(&path).map_err(|_| "could not be read".to_owned())?;
    use base64::Engine;
    Ok(format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    // Only the design-loop test needs it, so it is imported here rather than beside `Mutex`: a
    // lib build without the tests would carry an import nothing uses.

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

    /// `QUESTIONS` is one process-wide gate, so every test that touches it takes turns — and it
    /// shares that turn with the approval gate, because a turn opens and closes the two together.
    ///
    /// The lock lives in [`crate::approvals`] rather than here for that reason. A lock of our own
    /// serialized these tests against each other and against nothing else, and the test that took
    /// the question away was never one of these: it was an `ai_turn` test ending a turn.
    fn serialize_question_tests() -> std::sync::MutexGuard<'static, ()> {
        crate::approvals::serialize_gate_tests()
    }

    /**
     * Blank text is the user pressing the button with nothing written, and that is a skip.
     *
     * An empty string travelling as an answer reads downstream exactly like a decision somebody
     * made, and it would be written into a specification as one. Only `Given` may carry text.
     */
    #[test]
    fn an_answer_of_only_whitespace_settles_the_question_as_a_skip() {
        let _guard = serialize_question_tests();
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
        let _guard = serialize_question_tests();
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
        let _guard = serialize_question_tests();
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
        let _guard = serialize_question_tests();
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
        let _guard = serialize_question_tests();
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
                "it decides the scene",
                None,
                false
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
        let _guard = serialize_question_tests();
        let app = mock_app_with_a_window();
        cancel_user_prompts();

        assert_eq!(
            ask_question(
                app.handle(),
                "question-2",
                "which menu?",
                vec!["pause".to_owned()],
                Vec::new(),
                "",
                None,
                false
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
        let _guard = serialize_question_tests();
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
            None,
            false,
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

    /**
     * The button that ends a design loop is the most definite answer this card can send.
     *
     * Read as an empty reply it would settle as a skip — the user declining to decide the thing they
     * have just decided — and the child would be told to make the call itself over a layout it had
     * already agreed with them.
     */
    #[test]
    fn ending_a_design_is_an_answer_rather_than_an_empty_reply() {
        let _guard = serialize_question_tests();
        let receiver = QUESTIONS.register("question-approved").expect("registered");
        respond_question(QuestionResponse {
            question_id: "question-approved".to_owned(),
            picked: Some(1),
            approved: true,
            ..QuestionResponse::default()
        })
        .expect("answered");

        let reply = receiver.recv().expect("a reply");
        assert!(reply.approved, "the approval must survive the round trip");
        assert!(!reply.skipped, "ending a design is not declining to decide");
        assert_eq!(reply.picked, Some(1));
    }

    /**
     * An ordinary question carries no owner field at all, rather than one holding nothing.
     *
     * A live sweep is what found this, on the field this replaces. The card decided whether it was
     * part of a design by asking whether the field was absent, and `null` is present — so every
     * ordinary question arrived dressed as a design loop, grew the button that ends one, and stopped
     * closing on Escape. This is the end that stops it being sent.
     */
    #[test]
    fn a_question_with_no_owner_sends_no_owner_field() {
        let plain = QuestionPrompt {
            question_id: "question-1".to_owned(),
            question: "which?".to_owned(),
            options: Vec::new(),
            sketches: Vec::new(),
            why: String::new(),
            revision: 1,
            owner_call_id: None,
            is_delegated: false,
        };
        let payload = serde_json::to_value(&plain).expect("a prompt serialises");
        assert!(
            payload.get("ownerCallId").is_none(),
            "a question with no owning call must not mention one at all: {payload}"
        );
        assert_eq!(payload["isDelegated"], serde_json::json!(false));

        let owned = QuestionPrompt {
            owner_call_id: Some("call-1".to_owned()),
            is_delegated: true,
            ..plain
        };
        let payload = serde_json::to_value(&owned).expect("a prompt serialises");
        assert_eq!(payload["ownerCallId"], serde_json::json!("call-1"));
        assert_eq!(payload["isDelegated"], serde_json::json!(true));
    }

    /**
     * The owning call travels with the question, so the block in the feed knows which rounds are one
     * layout.
     *
     * Set by the tool and never by whatever is asking, which is why it is carried rather than
     * inferred: a plain question with sketches is still a plain question, and it must settle on its
     * answer the way it always has.
     */
    #[test]
    fn a_question_carries_the_call_it_belongs_to_and_whether_it_is_delegated() {
        let _guard = serialize_question_tests();
        let app = mock_app_with_a_window();
        open_user_prompts();
        let responder = std::thread::spawn(|| {
            for _ in 0..200 {
                if let Some(id) = QUESTIONS.waiting().into_iter().next() {
                    return respond_question(QuestionResponse {
                        question_id: id,
                        approved: true,
                        picked: Some(0),
                        ..QuestionResponse::default()
                    });
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            panic!("no question was ever registered")
        });

        let answer = ask_question(
            app.handle(),
            "question-owned",
            "which?",
            Vec::new(),
            vec![Sketch {
                label: "Bar across the top".to_owned(),
                html: "<p>a</p>".to_owned(),
            }],
            "",
            Some("call-1".to_owned()),
            true,
        );
        responder
            .join()
            .expect("responder thread")
            .expect("answered");

        let Answer::Answered(reply) = answer else {
            panic!("the question was answered")
        };
        assert!(reply.approved);
        cancel_user_prompts();
    }

    /// A sketch, a question and an approval are different waits, and the gate has to reach all of
    /// them.
    ///
    /// Approvals were outside this call until they were not, and every caller opened the pair by
    /// hand: five sites in `ai_turn` and a sixth in the journey harness, which copied the approval
    /// half alone and left every `ask_user` a journey made refused by a gate nothing had opened.
    /// One function is only one function if it covers the last registry too.
    #[test]
    fn one_gate_covers_every_surface_a_turn_can_park_a_prompt_in() {
        let _guard = serialize_question_tests();
        open_user_prompts();
        assert!(QUESTIONS.is_open());
        assert!(crate::approvals::is_open());
        cancel_user_prompts();
        assert!(!QUESTIONS.is_open());
        assert!(!crate::approvals::is_open());
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
        let _guard = serialize_question_tests();
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
        let _guard = serialize_question_tests();
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
            None,
            false,
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
            None,
            false,
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

    /// A backend with no window, which is where every question below is asked from. The call is
    /// judged on its parameters before a window is looked for, so a refusal that is not
    /// `question_unavailable` is a refusal about the call itself.
    fn unattended_app() -> tauri::App<tauri::test::MockRuntime> {
        tauri::test::mock_builder()
            .build(crate::app_context())
            .expect("build mock Tauri app")
    }

    /// Asking the user is not a Godot domain, and the catalogue is the Godot domains.
    ///
    /// It is routed by name ahead of the catalogue because that is where the thing that answers it
    /// lives — the window — and not because it belongs to the editor. If it ever became a catalogue
    /// entry it would need an addon handler, an `ops` list and a generated parameter contract, and
    /// it has none of those.
    #[test]
    fn asking_the_user_is_routed_without_being_a_catalog_domain() {
        assert!(
            !crate::ai_tools::CATALOG
                .iter()
                .any(|domain| domain.name == ASK_USER_TOOL),
            "ask_user must not be a catalog domain"
        );
        // Reachable by construction: it is compiled in, and whether a window is open is a thing
        // that changes during a turn rather than something a pre-turn probe can settle.
        let answer = crate::ai_tools::probe(ASK_USER_TOOL).expect("ask_user answers its own probe");
        assert_eq!(answer["reachable"], serde_json::json!(true));
    }

    /// A question with nothing to decide is a mistake worth naming, not a prompt to put on screen.
    #[test]
    fn asking_the_user_nothing_is_refused_by_name() {
        let app = unattended_app();
        for params in [
            json!({}),
            json!({"question": "   "}),
            json!({"question": 7}),
        ] {
            let failure =
                ask_user(app.handle(), &params).expect_err("an empty question is refused");
            assert_eq!(failure.code, "invalid_params");
        }
    }

    /// An unattended backend must not answer on the user's behalf.
    ///
    /// There is no window here, so nothing could have been asked — and the refusal says exactly
    /// that rather than reporting an empty answer the agent would read as a decision.
    #[test]
    fn a_question_with_no_window_says_so_instead_of_answering() {
        let app = unattended_app();
        let failure = ask_user(
            app.handle(),
            &json!({"question": "Where does the menu live?"}),
        )
        .expect_err("a windowless backend cannot answer for the user");
        assert_eq!(failure.code, "question_unavailable");
    }

    /// A probe must never put a dialog in front of the user, whichever tool it is probing.
    #[test]
    fn probing_the_question_tool_asks_nobody() {
        let app = unattended_app();
        // Without the probe branch this would be refused for having no question in it; answering
        // proves the probe was taken before the parameters were read.
        let answer = ask_user(app.handle(), &json!({"probe": true})).expect("a probe is answered");
        assert_eq!(answer["tool"], serde_json::json!(ASK_USER_TOOL));
    }

    /// A showing with nothing in it, or too much, is refused before a window is looked for.
    ///
    /// Every one of these is a shape the renderer could not draw, and naming which one it was is the
    /// difference between the model fixing the call and the model trying the same call again.
    #[test]
    fn a_sketch_the_window_could_not_draw_is_refused_by_name() {
        let app = unattended_app();
        let sketch = |html: &str| json!({"label": "Bar across the top", "html": html});
        for params in [
            json!({"question": "   ", "sketches": [sketch("<p>a</p>")]}),
            json!({"question": "which?", "sketches": {"label": "x"}}),
            json!({"question": "which?", "sketches": [
                sketch("<p>a</p>"),
                sketch("<p>b</p>"),
                sketch("<p>c</p>"),
                sketch("<p>d</p>"),
            ]}),
            json!({"question": "which?", "sketches": [{"html": "<p>a</p>"}]}),
            json!({"question": "which?", "sketches": [{"label": "Bar"}]}),
            json!({"question": "which?", "sketches": [sketch(&"x".repeat(MAX_SKETCH_CHARS + 1))]}),
        ] {
            let failure =
                ask_user(app.handle(), &params).expect_err("an undrawable sketch is refused");
            assert_eq!(failure.code, "invalid_params", "for {params}");
        }
    }

    /// What is saved and what the asker is told are the same layout, or the panel lies about it.
    ///
    /// `reply_answer` already refused to name a variant nobody picked, and calls it what it is: a
    /// one-in-three guess reported as a fact. Kept under a different rule, that guess is written to
    /// the sketches table anyway and the panel lists it under "The layout you chose".
    #[test]
    fn a_variant_nobody_picked_is_neither_kept_nor_reported() {
        let sketch = |label: &str| Sketch {
            label: label.to_owned(),
            html: format!("<p>{label}</p>"),
        };
        let sketches = vec![sketch("Overlay"), sketch("Dock"), sketch("Rail")];
        let reply = Reply {
            text: "make the rows bigger".to_owned(),
            picked: None,
            blocked: Vec::new(),
            skipped: false,
            approved: false,
            again: false,
        };

        assert!(
            chosen_sketch(&sketches, &sketches, &reply).is_none(),
            "nothing may be kept for a choice that was never made"
        );
        assert_eq!(
            reply_answer("question-1", &sketches, &reply, Vec::new())["sketch"],
            Value::Null,
            "and the asker is told the same"
        );
    }

    /// The two copies of a sketch are read by different readers, so they must not be crossed over.
    ///
    /// The window is shown the copy with the project's artwork in it. Whoever builds it is handed
    /// the model's own markup, because the inlined one is base64 that says nothing. Swapped, both
    /// are wrong and neither fails: a builder gets noise and the user judges a layout with its
    /// sprites missing.
    #[test]
    fn a_kept_sketch_takes_both_copies_from_the_chosen_one() {
        let sketch = |label: &str, html: &str| Sketch {
            label: label.to_owned(),
            html: html.to_owned(),
        };
        let sketches = vec![
            sketch("Overlay", "res://a.png"),
            sketch("Dock", "res://b.png"),
        ];
        let shown = vec![sketch("Overlay", "data:a"), sketch("Dock", "data:b")];
        let reply = |picked: Option<usize>, skipped: bool| Reply {
            text: String::new(),
            picked,
            blocked: Vec::new(),
            skipped,
            approved: false,
            again: false,
        };

        let (source, drawn) =
            chosen_sketch(&sketches, &shown, &reply(Some(1), false)).expect("the picked sketch");
        assert_eq!(
            source.label, "Dock",
            "the pick chooses which sketch was kept"
        );
        assert_eq!(
            source.html, "res://b.png",
            "a builder gets the model's own markup"
        );
        assert_eq!(drawn, "data:b", "the window gets the copy it drew");

        assert!(
            chosen_sketch(&sketches, &shown, &reply(None, false)).is_none(),
            "words against three variants name none of them, and the first is a guess"
        );

        let one = &sketches[..1];
        let (only, _) = chosen_sketch(one, &shown[..1], &reply(None, false))
            .expect("one sketch is the only thing the words could be about");
        assert_eq!(only.label, "Overlay");

        let (fallback, _) = chosen_sketch(&sketches, &shown, &reply(Some(9), false))
            .expect("a pick out of range still chose a layout");
        assert_eq!(
            fallback.label, "Overlay",
            "a number the renderer got wrong is absorbed"
        );

        assert!(
            chosen_sketch(&sketches, &shown, &reply(Some(0), true)).is_none(),
            "a skip is not a choice and must leave nothing behind"
        );
        assert!(
            chosen_sketch(&[], &[], &reply(None, false)).is_none(),
            "every question asked in words reaches this and must keep nothing"
        );
    }

    /// A question with no sketches is the ordinary case, and must not be refused for having none.
    #[test]
    fn a_question_in_words_needs_no_sketches() {
        let app = unattended_app();
        for params in [
            json!({"question": "Where does the menu live?"}),
            json!({"question": "Where does the menu live?", "sketches": []}),
            json!({"question": "Where does the menu live?", "sketches": null}),
        ] {
            // No window, so it gets that far and no further — which is proof it was not refused for
            // its parameters on the way.
            let failure = ask_user(app.handle(), &params).expect_err("no window to ask in");
            assert_eq!(failure.code, "question_unavailable", "for {params}");
        }
    }

    /// The reply the worker reads names the sketch, not just its number.
    ///
    /// A number alone is a number against a list the model wrote several messages ago. The label is
    /// what it called the thing, which is what it can act on without counting back.
    #[test]
    fn a_pick_is_reported_by_the_name_the_asker_gave_it() {
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
        let answer = reply_answer(
            "question-1",
            &sketches,
            &Reply {
                picked: Some(1),
                text: "tighter".to_owned(),
                ..Reply::default()
            },
            Vec::new(),
        );
        assert_eq!(answer["picked"]["label"], json!("Side rail"));
        assert_eq!(answer["picked"]["index"], json!(1));
        assert_eq!(answer["answer"], json!("tighter"));

        // A pick pointing past the end of the list is dropped rather than panicking or naming the
        // wrong sketch: the reaction crosses a process boundary and nothing on the way is typed.
        let stray = reply_answer(
            "question-1",
            &sketches,
            &Reply {
                picked: Some(7),
                ..Reply::default()
            },
            Vec::new(),
        );
        assert_eq!(stray["picked"], Value::Null);
    }

    /**
     * The agreed layout goes back to whoever asked for the design, as the model drew it.
     *
     * The prose the design child writes reads as complete and is not: a builder handed "seven tiles,
     * a cap column, four-pixel gaps" still has to guess at what the user actually looked at, and the
     * first build off one came back close and wrong. The markup is the drawing itself, and it rides
     * on the answer so nothing has to retype it.
     */
    #[test]
    fn the_layout_the_user_reacted_to_rides_back_with_the_answer() {
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
        let picked = reply_answer(
            "question-1",
            &sketches,
            &Reply {
                picked: Some(1),
                approved: true,
                ..Reply::default()
            },
            Vec::new(),
        );
        assert_eq!(picked["sketch"]["html"], json!("<p>b</p>"));
        assert_eq!(picked["sketch"]["label"], json!("Side rail"));

        // Words against one layout are a reaction to that layout, because there is no other.
        let said = reply_answer(
            "question-1",
            &sketches[..1],
            &Reply {
                text: "tighter".to_owned(),
                ..Reply::default()
            },
            Vec::new(),
        );
        assert_eq!(said["sketch"]["html"], json!("<p>a</p>"));

        // Words against three, with no pick, name none of them. Answering with the first is a guess
        // reported as a fact, and it is the fact somebody builds.
        let unpicked = reply_answer(
            "question-1",
            &sketches,
            &Reply {
                text: "tighter".to_owned(),
                ..Reply::default()
            },
            Vec::new(),
        );
        assert_eq!(unpicked["sketch"], Value::Null);

        // A skip reacted to nothing, and a question in words has nothing to react to.
        let skipped = reply_answer(
            "question-1",
            &sketches,
            &Reply {
                skipped: true,
                ..Reply::default()
            },
            Vec::new(),
        );
        assert_eq!(skipped["sketch"], Value::Null);
        let wordy = reply_answer("question-1", &[], &Reply::default(), Vec::new());
        assert_eq!(wordy["sketch"], Value::Null);
    }

    /// A skip says what it means, and an answer says nothing extra.
    ///
    /// This file has always said a skip is a decision — "the user read the question and left it to
    /// the implementer" — in a doc comment the model never sees. What it saw was `"skipped": true`
    /// and no words, and one live turn read that as a refusal: skipped on whether to delete a script
    /// it had just unregistered, it finished with "remains orphaned because file-deletion approval
    /// was not provided". Nothing had refused it.
    #[test]
    fn a_skip_carries_the_sentence_saying_what_a_skip_is() {
        let skipped = reply_answer(
            "question-1",
            &[],
            &Reply {
                skipped: true,
                ..Reply::default()
            },
            Vec::new(),
        );
        let note = skipped["note"].as_str().expect("a skip says what it is");
        assert!(note.contains("left the decision to you"), "{note}");
        assert!(note.contains("Nothing was refused"), "{note}");
        // And it does not claim to have unlocked anything: what a caller may do is the approval
        // gate's to answer, and that is a different registry.
        assert!(note.contains("permission asks for it separately"), "{note}");

        // An answer the user actually wrote carries no note at all — the words are the answer.
        let said = reply_answer(
            "question-1",
            &[],
            &Reply {
                text: "use a pause menu".to_owned(),
                ..Reply::default()
            },
            Vec::new(),
        );
        assert_eq!(said["note"], Value::Null, "{said}");
    }

    /**
     * A sketch is drawn with the game's own artwork, not the window's default typeface.
     *
     * The frame refuses everything remote and cannot reach a local file either, so before this the
     * one thing the user was asked to judge — how it looks in their game — was the one thing the
     * sketch could not show. The model cannot fix that itself: `read` hands it text, and a font is
     * not text.
     */
    #[test]
    fn a_project_asset_named_the_way_godot_names_it_goes_into_the_sketch() {
        let directory = tempfile::tempdir().expect("temporary workspace");
        std::fs::create_dir_all(directory.path().join("ui")).expect("make ui");
        std::fs::write(directory.path().join("ui/hero.png"), b"\x89PNG").expect("write asset");
        let workspace = crate::files::Workspace::open(directory.path()).expect("open workspace");

        let (html, refused) =
            inline_project_assets(&workspace, r#"<img src="res://ui/hero.png"><i>x</i>"#);

        assert!(html.contains("data:image/png;base64,"));
        assert!(
            html.contains("<i>x</i>"),
            "the rest of the markup is untouched"
        );
        assert!(refused.is_empty());
    }

    /**
     * Everything a reference can be wrong about is named, and the reference is left where it was.
     *
     * Removed, the markup would silently lose an attribute and the model would be looking for a bug
     * in its own layout. Left alone, the sketch shows it what did not resolve.
     */
    #[test]
    fn an_asset_that_cannot_go_in_is_reported_rather_than_dropped() {
        let directory = tempfile::tempdir().expect("temporary workspace");
        std::fs::write(directory.path().join("big.png"), vec![0u8; 600 * 1024])
            .expect("write asset");
        std::fs::write(directory.path().join("notes.txt"), b"x").expect("write text");
        let workspace = crate::files::Workspace::open(directory.path()).expect("open workspace");

        let (html, refused) = inline_project_assets(
            &workspace,
            "res://big.png res://notes.txt res://gone.png res://../escape.png",
        );

        assert_eq!(refused.len(), 4, "{refused:?}");
        assert!(refused[0].contains("over the"));
        assert!(refused[1].contains("not a picture or a font"));
        assert!(refused[2].contains("no such file"));
        assert!(refused[3].contains("outside the project"));
        assert!(
            html.contains("res://big.png"),
            "the reference stays where it was"
        );
    }

    /// Markup naming nothing is handed back exactly as it arrived.
    #[test]
    fn a_sketch_with_no_assets_in_it_is_left_alone() {
        let directory = tempfile::tempdir().expect("temporary workspace");
        let workspace = crate::files::Workspace::open(directory.path()).expect("open workspace");
        let markup = "<div class=\"p\"><h1>Paused</h1></div>";

        let (html, refused) = inline_project_assets(&workspace, markup);

        assert_eq!(html, markup);
        assert!(refused.is_empty());
    }

    /**
     * A quoted identifier is the same identifier.
     *
     * Measured against the real model, not imagined. The answer it reads named the identifier in
     * quotation marks and it copied them into the parameter, which made `"question-1"` a different
     * question from `question-1` — so the revision counter started again at one and a fourth draft
     * was drawn as though it were the first. The wording was fixed as well; this is the half that
     * holds when the wording does not.
     */
    #[test]
    fn a_question_identifier_that_arrived_in_quotes_is_the_same_question() {
        assert_eq!(unquoted("\"question-1\""), "question-1");
        assert_eq!(unquoted("'question-1'"), "question-1");
        assert_eq!(unquoted("  question-1  "), "question-1");
        assert_eq!(unquoted("question-1"), "question-1");
        // Nothing but quotes is nothing, and the caller reads that as "no identifier given".
        assert_eq!(unquoted("\"\""), "");
    }
}

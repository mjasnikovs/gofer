//! Every tool operation, and the check that holds a model to what it takes.
//!
//! One [`Operation`] per row of `protocol/schemas/v2/params.json`, carrying everything that is a
//! fact about a named operation: the prose the model reads, the parameters that refuse a call,
//! what answers it, how much of an `ops` list it may share, whether the user is asked first, and
//! what it writes that one of their rules may refuse. The router resolves the row once, as it
//! reads the entry, and asks it each of those in turn. They were five tables in three modules,
//! keyed on the same `(tool, op)` pair of strings, and one dispatch looked the same operation up
//! seven times over.
//!
//! Before this existed, four domains — `godot_scene`, `godot_node`, `godot_project` and
//! `godot_runtime` — were routed to the addon as raw JSON. Nothing between the model and GDScript
//! looked inside `params`. The shape of a value was first examined by `Protocol.decode`, in the
//! editor, across a socket, and the only thing that came back was a hand-written sentence.
//!
//! A live run lost a whole session to that seam. The model wrote
//! `{"type": "resource", "value": "res://scripts/player.gd"}` — the path is right, the `{"path": …}`
//! wrapper is missing — and was answered `A resource value requires an object carrying a path`
//! eight times. The sentence is true. It does not show the wrapper and it does not repeat what
//! arrived, so the model changed nothing between attempts, then concluded that scripts cannot be
//! attached at all and started writing `.tscn` files by hand.
//!
//! So a failure here is not allowed to be only a complaint. Every one of them names the parameter,
//! says what arrived, and prints the corrected call with the model's own values already in it.
//! `note` is the per-parameter sentence, in the spirit of a zod `message`: it is added when the
//! generic explanation would leave the model guessing which of two right-looking shapes to use.

use crate::ai_tools::ToolFailure;
use serde::Serialize;
use serde_json::{Value, json};

/// What one parameter accepts. Deliberately coarse: this rejects the shape a model gets wrong on
/// its own, and leaves what only the engine can know — whether a node has that property, whether
/// the value fits its declared type, whether the setter kept it — to the addon that can answer it.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind", content = "of")]
pub enum Kind {
    Text,
    Int,
    Number,
    Flag,
    List,
    /// Any JSON object. The shape inside it belongs to the handler that reads it.
    Object,
    /// A `{"type": …, "value": …}` pair, the protocol's own tagged value.
    Tagged,
    /// Sixty-four lowercase hex characters: the optimistic-concurrency token a read answers with.
    ///
    /// It has its own kind because it is the one parameter a caller copies by hand, and a copy that
    /// drops a character is not a string problem — it is a token that cannot be the hash of
    /// anything. A live run lost a script to it: sixty-three characters, one short, answered
    /// `changed since it was read`, re-read, copied wrong the same way, three rounds, then gave up
    /// on the domain and wrote the file raw, around the language server.
    Hash,
    /// A string from a fixed set.
    Choice(&'static [&'static str]),
    /// Any one of several kinds. `tileSize` is one number or two, `solid` a list or the word "all".
    Either(&'static [Kind]),
    /// A list whose entries are one scalar kind, where [`Param::entry`] can only say what an
    /// *object* entry holds.
    ///
    /// `properties: list` said nothing about what goes in it, and the gap was not cosmetic: a name
    /// that means a list of objects in one operation of a domain and a bare list in another widens
    /// the generated schema to an array that swallows the strict branch, which
    /// `everyMergedNameDeclaresItsShape` refuses outright. So a list of strings had no way to be
    /// declared beside a list of objects at all.
    ListOf(&'static Kind),
}

/// One parameter of one operation.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Param {
    pub name: &'static str,
    #[serde(flatten)]
    pub kind: Kind,
    pub required: bool,
    /// Accepted, and left out of the signature the model reads. `scene` is the whole population:
    /// every node command takes it, defaults it to the scene the editor already has open, and is
    /// passed it by the desktop client. Refusing it would break a caller that predates the model,
    /// and advertising it would spend tokens telling the model about a value it never needs.
    pub hidden: bool,
    /// The extra sentence the model reads when this parameter is wrong or missing. Empty when the
    /// generic explanation already says everything worth saying.
    pub note: &'static str,
    /// The words this parameter accepts inside a structure, where [`Kind`] cannot reach.
    ///
    /// `key` sits inside each entry of an `events` list, so no kind can name it. These are printed
    /// into the signature all the same, because that is where a vocabulary belongs: they used to
    /// be two verbatim copies of the same twenty-five names inside two catalogue summaries, read
    /// back out of the English by a parser that split on the literal string "Accepted: ".
    pub vocabulary: &'static [&'static str],
    /// What one entry of this parameter holds, when [`Kind`] can only say `list` or `object`.
    ///
    /// A kind stops at the outermost bracket, so `files: list` says nothing about the
    /// `{path, edits}` inside it and the first thing to look was serde, whose complaint is
    /// `missing field oldText` — no operation, no parameter, no position, no corrected call. A
    /// live turn nested five files inside each other's `edits` and got exactly that.
    ///
    /// Empty means the inside is not written down, never that it is free-form.
    pub entry: &'static [Param],
}

pub const fn need(name: &'static str, kind: Kind) -> Param {
    Param {
        name,
        kind,
        required: true,
        hidden: false,
        note: "",
        vocabulary: &[],
        entry: &[],
    }
}

pub const fn opt(name: &'static str, kind: Kind) -> Param {
    Param {
        name,
        kind,
        required: false,
        hidden: false,
        note: "",
        vocabulary: &[],
        entry: &[],
    }
}

/// Accepted without being advertised. See `Param::hidden`.
pub const fn hidden(name: &'static str, kind: Kind) -> Param {
    Param {
        name,
        kind,
        required: false,
        hidden: true,
        note: "",
        vocabulary: &[],
        entry: &[],
    }
}

/// The same parameter, carrying the sentence a model needs when it gets this one wrong.
pub const fn noted(param: Param, note: &'static str) -> Param {
    Param { note, ..param }
}

/// The same parameter, carrying what one of its entries holds. See [`Param::entry`].
pub const fn shaped(param: Param, entry: &'static [Param]) -> Param {
    Param { entry, ..param }
}

/// The same parameter, carrying the words it accepts inside a structure. See [`Param::vocabulary`].
pub const fn speaking(param: Param, vocabulary: &'static [&'static str]) -> Param {
    Param {
        vocabulary,
        ..param
    }
}

/// What answers one operation.
///
/// The catalogue's own data has always known this — `params.json` carries `command` for every
/// operation the addon answers and `answeredBy: "rust"` for every one it does not — and Rust read
/// neither. So the router rebuilt the addon command by string arithmetic (`format!("scene.{op}")`),
/// kept a hand-written exception list for each domain that is only partly its own, and two drift
/// tests re-derived both a second and a third time, in the same file.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Answers {
    /// The addon, under this exact command name.
    Addon(&'static str),
    /// The desktop, in a handler of its own.
    Rust,
}

/// How much of an `ops` list one operation may share.
///
/// The default for an operation that declares neither is the whole list: it may appear beside
/// anything, as often as the list names it, which is what `ops` exists for.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Sharing {
    /// May sit beside other operations, and may not appear twice.
    ///
    /// The router runs a list in order, so a second entry of an operation that takes no parameters
    /// answers the question the first one already answered, and a second entry of one driving what
    /// the session owns exactly one of — the open scene, the running game, the undo stack, the
    /// dialog — acts on whatever the first left behind.
    Repeat,
    /// Has to be the only entry of its call.
    ///
    /// The debugger, and only the debugger: each answer decides what the next operation means, so a
    /// list written before the first answer arrived is a list written about a state that no longer
    /// holds.
    Exclusive,
}

/// How much of an `ops` list one operation may share, and the sentence that says why.
///
/// A tool call is a list, so a model that wants three inspections writes one call instead of three.
/// Thirty-five operations are narrower than that, in one of the two ways [`Sharing`] describes, and
/// the sentence beside each says which. The model is told before it writes the call rather than
/// after: `ops` exists to save round trips, so learning its narrowing by spending one is the wrong
/// way round.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Lone {
    pub scope: Sharing,
    pub why: &'static str,
}

/// What an operation writes, where one of the user's enforced Godot rules may refuse it.
///
/// A tag rather than a `(tool, op)` match. Applying a rule is only half of enforcing it: an agent
/// that meets a parse error it cannot fix reaches for the setting that produced it, and
/// [`crate::godot_policy::enforcement_refusal`] is what refuses that. It used to name the five
/// operations itself, in a match beside every other match on the same pair; the operation knows
/// what it writes, so it is the operation that carries it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Writes {
    /// A project setting, which is where the GDScript warning levels live.
    ProjectSetting,
    /// A machine-wide editor setting, which is where the game's window placement lives.
    EditorSetting,
    /// GDScript source, which is where an annotation can suppress a warning per file.
    ScriptText,
}

/// Everything one tool operation is, in one row.
///
/// It was five: the prose the model reads, the parameters that refuse a call, the route that
/// answers it, the narrowing of an `ops` list, and the gate that asks the user first. Each lived in
/// a table of its own, keyed on the same `(tool, op)` pair of strings, and a single dispatch looked
/// the same operation up five times over. They are one row of `protocol/schemas/v2/params.json`,
/// so they are one row here.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Operation {
    /// The domain tool that offers it. Carried so a refusal can name the whole call the way the
    /// model wrote it — "godot_node create requires `type`" — rather than being handed a name the
    /// row already knows.
    pub tool: &'static str,
    pub op: &'static str,
    /// What the model is told this operation is for. See `$summaryComment` in the source.
    pub summary: &'static str,
    pub params: &'static [Param],
    pub answers: Answers,
    pub alone: Option<Lone>,
    /// The sentence the user is shown before the agent may run this. `None` is auto-allowed, so a
    /// new operation is allowed by default and has to be gated deliberately.
    pub gated: Option<&'static str>,
    pub writes: Option<Writes>,
}

/// The wire shape of one operation: what the Node worker is sent, per entry, at startup.
///
/// The signature is printed from the row's own parameters rather than stored beside them, because
/// two spellings of one contract is the drift this file exists to end — see [`signature`].
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Wire<'a> {
    op: &'static str,
    summary: &'static str,
    signature: String,
    params: &'a [Param],
    alone: Option<Lone>,
}

impl Serialize for Operation {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        Wire {
            op: self.op,
            summary: self.summary,
            signature: signature(self.params),
            params: self.params,
            alone: self.alone,
        }
        .serialize(serializer)
    }
}

impl Operation {
    /// What answers it: the addon under a command name, or the desktop in a handler of its own.
    pub fn route(&self) -> Answers {
        self.answers
    }

    /// How much of an `ops` list it may share, and why, or `None` when it may share all of one.
    pub fn sharing(&self) -> Option<(Sharing, &'static str)> {
        self.alone.map(|lone| (lone.scope, lone.why))
    }

    /// The reason it needs the user's approval, or `None` when the agent may just run it.
    pub fn gate(&self) -> Option<&'static str> {
        self.gated
    }

    /// What it writes that one of the user's enforced rules may refuse, or `None` when no rule
    /// keys on it. See [`Writes`].
    pub fn writes(&self) -> Option<Writes> {
        self.writes
    }

    /// The values a model wrote in a shape the protocol does not take, rewritten into the one it
    /// does.
    ///
    /// Repair rather than refusal, because the refusal was tried. `{"type": "vector2", "value":
    /// {"x": 32, "y": 48}}` is what one live turn wrote thirteen times in a single run; the refusal
    /// was then taught to print the exact value to send instead, and the next run wrote it four
    /// more times in a row, each answered with `Send {"type": "vector2", "value": [32, 48]}` and
    /// each ignored. A correction a model will not read is one that cannot help it, and the numbers
    /// were never in doubt.
    ///
    /// Only where the order is not a guess — the same table the correction is printed from — and
    /// only for a parameter the operation declares as a tagged value, so this can never reach a key
    /// that means something else. Everything it does not recognise is left exactly as it arrived,
    /// for [`Operation::check`] to refuse by name.
    ///
    /// What is left to the worker's `prepareArguments`, a layer above this, is only what this one
    /// can no longer reach. The agent loop validates a call against the generated schema *between*
    /// that hook and this function, so the worker owns exactly the shapes the schema refuses
    /// outright: the `ops` bracket, the `op` naming an entry, the wrapper the parameters were
    /// parked under, and the whitespace round a parameter's *name* — a nested entry's schema is
    /// closed and requires its own names, so `{"properties": [{" node": …}]}` is answered by the
    /// loop before the router is ever called. The whitespace round a parameter's *value* is here,
    /// in [`trim_a_name`], and so is every other repair of what a value or a key means.
    ///
    /// That split is what makes those repairs reach a caller the worker never sees. The acceptance
    /// suites call `dispatch` directly, the desktop client calls it with no model in front of it,
    /// and a fix that lives only in the worker reaches neither — which is what a tagged value
    /// wrapped in a second copy of its own tag did, unwrapped in JavaScript and refused here.
    pub fn repair(&self, params: &mut Value) {
        repair_set(self.params, params);
    }

    /// Refuses a call whose parameters cannot possibly be right, before it leaves this process.
    ///
    /// Everything here is arithmetic on JSON: a name that is not accepted, a missing required
    /// parameter, a value of the wrong JSON type, a tagged value whose payload does not match its
    /// own tag. None of it needs the editor, so none of it should cost a round trip to find out.
    pub fn check(&self, params: &Value) -> Result<(), ToolFailure> {
        let Some(object) = params.as_object() else {
            return Ok(());
        };
        let call = format!("{} {}", self.tool, self.op);
        check_set(&call, self.op, "", self.params, object)
    }
}

const fn op(
    tool: &'static str,
    op: &'static str,
    summary: &'static str,
    answers: Answers,
    params: &'static [Param],
) -> Operation {
    Operation {
        tool,
        op,
        summary,
        params,
        answers,
        alone: None,
        gated: None,
        writes: None,
    }
}

/// The same operation, narrowed to where it may sit in an `ops` list. See [`Lone`].
const fn alone(operation: Operation, scope: Sharing, why: &'static str) -> Operation {
    Operation {
        alone: Some(Lone { scope, why }),
        ..operation
    }
}

/// The same operation, with the sentence the user is asked before it runs.
const fn gated(operation: Operation, reason: &'static str) -> Operation {
    Operation {
        gated: Some(reason),
        ..operation
    }
}

/// The same operation, carrying what it writes that a rule may refuse. See [`Writes`].
const fn writes(operation: Operation, what: Writes) -> Operation {
    Operation {
        writes: Some(what),
        ..operation
    }
}

/// The row `domain.op` was declared in, or `None` for a pair nothing declares.
///
/// The lookup by name, and it is read only by tests: the drift checks and the tests that state the
/// pair they are about hold two strings and nothing else. Nothing in a shipped build looks an
/// operation up this way — the router resolves the row once, as it reads the entry, and asks that
/// row everything after.
#[cfg(test)]
pub fn operation_of(domain: &str, op: &str) -> Option<&'static Operation> {
    crate::ai_tools::CATALOG
        .iter()
        .find(|entry| entry.name == domain)
        .and_then(|entry| entry.operation(op))
}

/// What answers `domain.op`, or `None` for an operation nothing declares.
///
/// Absence is a build-time oversight rather than something a caller can reach: `dispatch` refuses
/// an operation the catalogue does not offer before it gets here, and
/// `every_catalog_operation_declares_its_parameters` holds these rows to the catalogue.
///
/// Read only by tests, like the lookup behind it. The router routes what it resolved.
#[cfg(test)]
pub fn answers(domain: &str, op: &str) -> Option<Answers> {
    operation_of(domain, op).map(Operation::route)
}

/// The words a parameter accepts inside a structure, where [`Kind`] cannot reach.
///
/// Emitted from `protocol/schemas/v2/params.json`. They were two verbatim copies of the same
/// twenty-five names inside two catalogue summaries, and the only thing holding them to the engine
/// was a parser that split the English on the literal string "Accepted: ".
// GENERATED-BEGIN vocabularies sha256:c9f8f5c5638d87e6
/// Godot's own name for a key, not the browser's.
pub const GODOT_KEY_NAME: &[&str] = &[
    "Enter",
    "Kp Enter",
    "Escape",
    "Space",
    "Backspace",
    "Tab",
    "Delete",
    "Left",
    "Right",
    "Up",
    "Down",
    "PageUp",
    "PageDown",
    "Home",
    "End",
    "Shift",
    "Ctrl",
    "Alt",
    "Meta",
    "Comma",
    "Period",
    "Slash",
    "Minus",
    "Equal",
    "BracketLeft",
];

/// Names the engine does not have, so the drift check can prove GODOT_KEY_NAME means something.
///
/// Read only by tests: the engine drift check feeds these to a real editor and requires each to
/// be refused. Nothing in a shipped build has any use for a list of names that do not work.
#[allow(dead_code)]
pub const GODOT_KEY_NAME_REFUSED: &[&str] =
    &["Return", "Esc", "Control", "Super", "ArrowLeft", "Spacebar"];
// GENERATED-END vocabularies
use Kind::{Flag, Hash, Int, List, Number, Object, Tagged, Text};

/// Every operation of every domain tool, one [`Operation`] per row of the source.
///
/// The whole catalogue, with no exceptions list. The first cut of this file covered four domains
/// and left five to serde, which read as a reasonable division and was not one: `expectedHash`
/// lives in one of the five, a model copied sixty-three of its sixty-four characters, and nothing
/// between it and the filesystem counted them. So there is no hole and no way to add one — an
/// operation reaches the model only through `CATALOG`, and every entry of it is one of these rows.
///
/// One list per domain, and `CATALOG` is the only thing that names them: a list nobody hands to a
/// domain is a dead const, which the compiler reports rather than a test.
// GENERATED-BEGIN operations sha256:7aad2907045aaf9c
pub const GODOT_SESSION_OPERATIONS: &[Operation] = &[
    alone(
        op(
            "godot_session",
            "status",
            "Reports the session state, ports, engine version, and worktree.",
            Answers::Rust,
            &[],
        ),
        Sharing::Repeat,
        "It takes no parameters, so a second one in the same call is the first one again.",
    ),
    alone(
        op(
            "godot_session",
            "start",
            "Starts the editor session for the active task worktree.",
            Answers::Rust,
            &[],
        ),
        Sharing::Repeat,
        "There is one editor session, so a second one in the same call is the first one again.",
    ),
    alone(
        op(
            "godot_session",
            "stop",
            "Stops the editor session and removes the staged Gofer addon.",
            Answers::Rust,
            &[],
        ),
        Sharing::Repeat,
        "There is one editor session, so a second one in the same call is the first one again.",
    ),
    alone(
        op(
            "godot_session",
            "get_state",
            "Asks the addon for readiness, the open scene, its revision, and the dialog the editor is waiting on. A `dialog` is a question only a person can answer — its text and the buttons it offers — and until someone presses one the editor will not run the game. Nothing else reports it: commands are still answered while one is up, and a screenshot of the editor need not contain it.",
            Answers::Addon("session.get_state"),
            &[],
        ),
        Sharing::Repeat,
        "It takes no parameters, so a second one in the same call is the first one again.",
    ),
    gated(
        alone(
            op(
                "godot_session",
                "answer_dialog",
                "Presses a button on the dialog the editor is waiting on, by its label — one of the `buttons` the dialog was reported with. Use it when a dialog is blocking the work; there is no other way past one, and nothing else you can do will clear it. Read what it asks before choosing: the buttons do what they say, and some of them change the project.",
                Answers::Addon("session.answer_dialog"),
                &[need("button", Text)],
            ),
            Sharing::Repeat,
            "One dialog is up at a time, and pressing a button clears it, so a second press has nothing to press.",
        ),
        "Answering an editor dialog presses that button in the editor, exactly as clicking it would.",
    ),
    alone(
        op(
            "godot_session",
            "undo",
            "Undoes the last editor operation.",
            Answers::Addon("session.undo"),
            &[noted(
                hidden("expectedRevision", Int),
                "Supplied by the router from the last answer that reported it, so a call never carries one. It stays accepted for a caller that holds its own.",
            )],
        ),
        Sharing::Repeat,
        "One undo stack, walked in order: what the second call undoes depends on what the first one did.",
    ),
    alone(
        op(
            "godot_session",
            "redo",
            "Redoes the last undone editor operation.",
            Answers::Addon("session.redo"),
            &[noted(
                hidden("expectedRevision", Int),
                "Supplied by the router from the last answer that reported it, so a call never carries one. It stays accepted for a caller that holds its own.",
            )],
        ),
        Sharing::Repeat,
        "One undo stack, walked in order: what the second call undoes depends on what the first one did.",
    ),
];

pub const GODOT_SCENE_OPERATIONS: &[Operation] = &[
    alone(
        op(
            "godot_scene",
            "list",
            "Lists the scene files in the project.",
            Answers::Addon("scene.list"),
            &[],
        ),
        Sharing::Repeat,
        "It takes no parameters, so a second one in the same call is the first one again.",
    ),
    alone(
        op(
            "godot_scene",
            "open",
            "Opens a scene.",
            Answers::Addon("scene.open"),
            &[need("path", Text)],
        ),
        Sharing::Repeat,
        "One scene is open at a time, so a second one would act on whatever the first left open.",
    ),
    op(
        "godot_scene",
        "create",
        "Creates a scene and opens it. It is checked against the revision of the scene being *replaced*, because creating a scene discards whatever is unsaved in the open one — which is what the check is for. The router holds that number already.",
        Answers::Addon("scene.create"),
        &[
            need("path", Text),
            need("rootType", Text),
            opt("rootName", Text),
            noted(
                hidden("expectedRevision", Int),
                "Supplied by the router from the last answer that reported it, so a call never carries one. It stays accepted for a caller that holds its own.",
            ),
        ],
    ),
    op(
        "godot_scene",
        "get_tree",
        "Returns the edited scene hierarchy and its revision. Read it to see what the scene holds, not to fetch a revision: every mutation is checked against a number the router already has, and answers with the next one.",
        Answers::Addon("scene.get_tree"),
        &[
            noted(
                opt("root", Text),
                "The node to start from, as a path. The whole tree when it is absent.",
            ),
            noted(
                opt("depth", Int),
                "How many levels below the starting node to walk. Every level when it is absent.",
            ),
            noted(
                opt("limit", Int),
                "How many nodes to answer with, at most. The answer opens with `truncated`, which says whether it stopped early; a root or a depth is how you read the rest.",
            ),
        ],
    ),
    alone(
        op(
            "godot_scene",
            "save",
            "Saves the edited scene. A scene nothing has changed is left exactly as it is and answers `wrote: false`; saving one anyway rewrites it from memory and drops the `uid` of anything the editor cannot resolve right now.",
            Answers::Addon("scene.save"),
            &[noted(
                hidden("expectedRevision", Int),
                "Supplied by the router from the last answer that reported it, so a call never carries one. It stays accepted for a caller that holds its own.",
            )],
        ),
        Sharing::Repeat,
        "One scene is open at a time, so a second one would act on whatever the first left open.",
    ),
    alone(
        op(
            "godot_scene",
            "save_as",
            "Saves the edited scene to a new path.",
            Answers::Addon("scene.save_as"),
            &[
                need("path", Text),
                noted(
                    hidden("expectedRevision", Int),
                    "Supplied by the router from the last answer that reported it, so a call never carries one. It stays accepted for a caller that holds its own.",
                ),
            ],
        ),
        Sharing::Repeat,
        "One scene is open at a time, so a second one would act on whatever the first left open.",
    ),
    alone(
        op(
            "godot_scene",
            "reload",
            "Reloads the edited scene from disk, discarding in-memory edits.",
            Answers::Addon("scene.reload"),
            &[noted(
                hidden("expectedRevision", Int),
                "Supplied by the router from the last answer that reported it, so a call never carries one. It stays accepted for a caller that holds its own.",
            )],
        ),
        Sharing::Repeat,
        "One scene is open at a time, so a second one would act on whatever the first left open.",
    ),
];

pub const GODOT_NODE_OPERATIONS: &[Operation] = &[
    op(
        "godot_node",
        "inspect",
        "Inspects a node. Answers with its type, its groups, every signal it can emit, the connections it already has, and every property whose value is not still the one its class ships with. The rest are named, without their values, in `atClassDefault` — a Label has 129 properties and four of them differ, so this is most of the node. `properties` narrows the answer to the names you list and answers every one of them in full, at their default or not, exactly as runtime.inspect_node does for the running game. Read a property here before setting it rather than guessing what it holds; `stored` is false for properties the scene recomputes, like a Control's position and size and every theme_override_*, and those are set the same way as any other.",
        Answers::Addon("node.inspect"),
        &[
            need("node", Text),
            noted(
                opt("properties", Kind::ListOf(&Text)),
                "The property names to read, like [\"text\", \"position\"]. Without it every property is answered.",
            ),
            hidden("scene", Text),
        ],
    ),
    op(
        "godot_node",
        "create",
        "Creates a node. `parent` is the parent's path — the root's own path, like /Level1, for a direct child.",
        Answers::Addon("node.create"),
        &[
            need("parent", Text),
            need("type", Text),
            need("name", Text),
            opt("index", Int),
            noted(
                hidden("expectedRevision", Int),
                "Supplied by the router from the last answer that reported it, so a call never carries one. It stays accepted for a caller that holds its own.",
            ),
            hidden("scene", Text),
        ],
    ),
    op(
        "godot_node",
        "create_nodes",
        "Creates several nodes in one call, as one revision and one undo step. Prefer this over calling create in a row: create answers with the revision the next create needs, so forty nodes one at a time is forty round trips. Each `nodes` entry is exactly what create takes. Entries are applied in order, so a later entry may name a node an earlier entry creates as its parent, and a whole subtree goes in at once. Nothing is attached unless every entry is accepted.",
        Answers::Addon("node.create_nodes"),
        &[
            noted(
                shaped(
                    need("nodes", List),
                    &[
                        need("parent", Text),
                        need("type", Text),
                        need("name", Text),
                        opt("index", Int),
                    ],
                ),
                "Entries are applied in order, so a later entry may name a node an earlier entry creates as its parent.",
            ),
            noted(
                hidden("expectedRevision", Int),
                "Supplied by the router from the last answer that reported it, so a call never carries one. It stays accepted for a caller that holds its own.",
            ),
            hidden("scene", Text),
        ],
    ),
    op(
        "godot_node",
        "instantiate",
        "Places an instance of a saved scene under a node. This is how a level repeats a thing — build the coin once as its own scene, then instantiate it wherever a coin goes, and one edit reaches every placement. `node.create` cannot do this: it only builds engine classes.",
        Answers::Addon("node.instantiate"),
        &[
            need("parent", Text),
            need("path", Text),
            opt("name", Text),
            opt("index", Int),
            noted(
                hidden("expectedRevision", Int),
                "Supplied by the router from the last answer that reported it, so a call never carries one. It stays accepted for a caller that holds its own.",
            ),
            hidden("scene", Text),
        ],
    ),
    op(
        "godot_node",
        "duplicate",
        "Duplicates a node.",
        Answers::Addon("node.duplicate"),
        &[
            need("node", Text),
            opt("name", Text),
            noted(
                hidden("expectedRevision", Int),
                "Supplied by the router from the last answer that reported it, so a call never carries one. It stays accepted for a caller that holds its own.",
            ),
            hidden("scene", Text),
        ],
    ),
    op(
        "godot_node",
        "rename",
        "Renames a node.",
        Answers::Addon("node.rename"),
        &[
            need("node", Text),
            need("name", Text),
            noted(
                hidden("expectedRevision", Int),
                "Supplied by the router from the last answer that reported it, so a call never carries one. It stays accepted for a caller that holds its own.",
            ),
            hidden("scene", Text),
        ],
    ),
    op(
        "godot_node",
        "reparent",
        "Reparents a node.",
        Answers::Addon("node.reparent"),
        &[
            need("node", Text),
            need("newParent", Text),
            opt("index", Int),
            noted(
                hidden("expectedRevision", Int),
                "Supplied by the router from the last answer that reported it, so a call never carries one. It stays accepted for a caller that holds its own.",
            ),
            hidden("scene", Text),
        ],
    ),
    op(
        "godot_node",
        "change_type",
        "Turns a node into one of another class, keeping its name, its place, its children, its groups, its script, and every stored property the new class also has. This is the editor’s own Change Type: a Node2D placed as a player becomes a CharacterBody2D without being rebuilt node by node. A signal connected to or from the node does not travel — the connection names the node, and the new one is a different object — so put those back with connect_signal. The scene’s own root cannot be changed this way.",
        Answers::Addon("node.change_type"),
        &[
            need("node", Text),
            need("type", Text),
            noted(
                hidden("expectedRevision", Int),
                "Supplied by the router from the last answer that reported it, so a call never carries one. It stays accepted for a caller that holds its own.",
            ),
            hidden("scene", Text),
        ],
    ),
    op(
        "godot_node",
        "delete",
        "Deletes a node.",
        Answers::Addon("node.delete"),
        &[
            need("node", Text),
            noted(
                hidden("expectedRevision", Int),
                "Supplied by the router from the last answer that reported it, so a call never carries one. It stays accepted for a caller that holds its own.",
            ),
            hidden("scene", Text),
        ],
    ),
    op(
        "godot_node",
        "set_property",
        "Sets a property. `value` is tagged with its type — a `type` beside a `value`: {\"type\": \"vector2\", \"value\": [12, 34]}, {\"type\": \"float\", \"value\": 1.5}, {\"type\": \"string\", \"value\": \"hi\"}. A property that holds a resource — a CollisionShape2D's `shape`, a Sprite2D's `texture` — takes {\"type\": \"resource\", \"value\": {\"path\": \"res://…\"}}, never a string: a path written as a string is refused. A color takes four numbers, or a name like \"skyblue\", or a hex string like \"#8b5a2b\". The other tags are null, bool, int, rect2 and rect2i (four numbers each), vector2i, vector3, vector3i, vector4, vector4i, quaternion, plane, transform2d, basis, transform3d, array (of tagged values) and dictionary (of key and value pairs of them).",
        Answers::Addon("node.set_property"),
        &[
            need("node", Text),
            need("property", Text),
            noted(
                need("value", Tagged),
                "A script is attached here like any other resource: property \"script\", value {\"type\": \"resource\", \"value\": {\"path\": \"res://scripts/player.gd\"}}.",
            ),
            noted(
                hidden("expectedRevision", Int),
                "Supplied by the router from the last answer that reported it, so a call never carries one. It stays accepted for a caller that holds its own.",
            ),
            hidden("scene", Text),
        ],
    ),
    op(
        "godot_node",
        "set_properties",
        "Sets several properties in one call, as one revision and one undo step. Prefer this over calling set_property in a row, for the same reason create_nodes exists: each single write answers with the revision the next one needs. Each `properties` entry is exactly what set_property takes, with `value` tagged the same way, and entries may name different nodes. Nothing is written unless every entry is accepted.",
        Answers::Addon("node.set_properties"),
        &[
            noted(
                shaped(
                    need("properties", List),
                    &[
                        need("node", Text),
                        need("property", Text),
                        noted(
                            need("value", Tagged),
                            "A script is attached here like any other resource: property \"script\", value {\"type\": \"resource\", \"value\": {\"path\": \"res://scripts/player.gd\"}}.",
                        ),
                    ],
                ),
                "Entries may name different nodes.",
            ),
            noted(
                hidden("expectedRevision", Int),
                "Supplied by the router from the last answer that reported it, so a call never carries one. It stays accepted for a caller that holds its own.",
            ),
            hidden("scene", Text),
        ],
    ),
    op(
        "godot_node",
        "add_to_group",
        "Puts a node in a group the saved scene keeps. Groups are how a running game finds every coin or enemy at once, with get_tree().get_nodes_in_group(\"…\").",
        Answers::Addon("node.add_to_group"),
        &[
            need("node", Text),
            need("group", Text),
            noted(
                hidden("expectedRevision", Int),
                "Supplied by the router from the last answer that reported it, so a call never carries one. It stays accepted for a caller that holds its own.",
            ),
        ],
    ),
    op(
        "godot_node",
        "remove_from_group",
        "Takes a node out of a group.",
        Answers::Addon("node.remove_from_group"),
        &[
            need("node", Text),
            need("group", Text),
            noted(
                hidden("expectedRevision", Int),
                "Supplied by the router from the last answer that reported it, so a call never carries one. It stays accepted for a caller that holds its own.",
            ),
        ],
    ),
    op(
        "godot_node",
        "connect_signal",
        "Connects a node's signal to a method, as an editor connection the scene keeps. `target` is the node carrying the method and defaults to the scene root; the method has to exist there already, so write the script first. `binds` are extra tagged values passed after the signal's own arguments. This is how a scene wires itself up without a `connect` call in _ready.",
        Answers::Addon("node.connect_signal"),
        &[
            need("node", Text),
            need("signal", Text),
            need("method", Text),
            opt("target", Text),
            opt("binds", List),
            opt("deferred", Flag),
            opt("oneShot", Flag),
            noted(
                hidden("expectedRevision", Int),
                "Supplied by the router from the last answer that reported it, so a call never carries one. It stays accepted for a caller that holds its own.",
            ),
        ],
    ),
    op(
        "godot_node",
        "disconnect_signal",
        "Removes a connection. `binds` are tagged values like connect_signal's, and have to match the ones the connection was made with or nothing is found to remove.",
        Answers::Addon("node.disconnect_signal"),
        &[
            need("node", Text),
            need("signal", Text),
            need("method", Text),
            opt("target", Text),
            opt("binds", List),
            noted(
                hidden("expectedRevision", Int),
                "Supplied by the router from the last answer that reported it, so a call never carries one. It stays accepted for a caller that holds its own.",
            ),
        ],
    ),
    op(
        "godot_node",
        "set_cells",
        "Paints tiles onto a TileMapLayer. This is how a 2D level is built — one TileMapLayer carrying a tileset, rather than a node per block. `x`/`y` are cell coordinates, not pixels, and `width`/`height` default to 1 so a rectangle is one entry — a whole ground row is {\"x\": 0, \"y\": 12, \"width\": 200, \"height\": 2, \"atlas\": [0, 0]}. `atlas` is the [column, row] of the tile in the tileset, which resource.describe_tileset lists. An entry with no `atlas` erases the cells it covers. The node needs its `tile_set` property set first, with node.set_property and a resource value.",
        Answers::Addon("node.set_cells"),
        &[
            need("node", Text),
            shaped(
                need("cells", List),
                &[
                    need("x", Int),
                    need("y", Int),
                    opt("width", Int),
                    opt("height", Int),
                    noted(
                        opt("atlas", List),
                        "A [column, row] pair, naming the tile in the atlas. An entry without one erases the cells it covers.",
                    ),
                    opt("source", Int),
                ],
            ),
            noted(
                hidden("expectedRevision", Int),
                "Supplied by the router from the last answer that reported it, so a call never carries one. It stays accepted for a caller that holds its own.",
            ),
        ],
    ),
    op(
        "godot_node",
        "get_cells",
        "Reads back what a TileMapLayer holds. Answers with how many cells are painted, the rectangle they span, and the tile each one draws.",
        Answers::Addon("node.get_cells"),
        &[need("node", Text), opt("limit", Int)],
    ),
];

pub const GODOT_PROJECT_OPERATIONS: &[Operation] = &[
    alone(
        op(
            "godot_project",
            "get_settings",
            "Returns the project settings overview.",
            Answers::Addon("project.get_settings"),
            &[],
        ),
        Sharing::Repeat,
        "It takes no parameters, so a second one in the same call is the first one again.",
    ),
    op(
        "godot_project",
        "search_settings",
        "Searches project settings by name. Answers with at most 50 matches, plus `totalMatches` and `truncated` — narrow the query rather than ask for more, because there is no limit to raise.",
        Answers::Addon("project.search_settings"),
        &[need("query", Text)],
    ),
    op(
        "godot_project",
        "get_setting",
        "Reads one project setting.",
        Answers::Addon("project.get_setting"),
        &[need("name", Text)],
    ),
    writes(
        op(
            "godot_project",
            "set_setting",
            "Writes one project setting. `value` is tagged with its type, the same shape node.set_property takes: {\"type\": \"int\", \"value\": 1152}, {\"type\": \"string\", \"value\": \"res://main.tscn\"}, {\"type\": \"vector2\", \"value\": [12, 34]}. A bare number or string is refused.",
            Answers::Addon("project.set_setting"),
            &[need("name", Text), need("value", Tagged)],
        ),
        Writes::ProjectSetting,
    ),
    writes(
        op(
            "godot_project",
            "reset_setting",
            "Resets a project setting to its default, and answers what that did: `changed`, the `previous` value and the `value` it reads as now. A setting already at its default answers `changed: false` rather than reporting a write. A setting Godot ships a default for goes back to that default; one the project invented leaves the file.",
            Answers::Addon("project.reset_setting"),
            &[need("name", Text)],
        ),
        Writes::ProjectSetting,
    ),
    alone(
        op(
            "godot_project",
            "list_autoloads",
            "Lists the configured autoloads.",
            Answers::Addon("project.list_autoloads"),
            &[],
        ),
        Sharing::Repeat,
        "It takes no parameters, so a second one in the same call is the first one again.",
    ),
    op(
        "godot_project",
        "set_autoload",
        "Adds or updates an autoload.",
        Answers::Addon("project.set_autoload"),
        &[need("name", Text), need("path", Text), opt("enabled", Flag)],
    ),
    op(
        "godot_project",
        "remove_autoload",
        "Removes an autoload.",
        Answers::Addon("project.remove_autoload"),
        &[need("name", Text)],
    ),
    op(
        "godot_project",
        "list_input_actions",
        "Lists the Input Map actions this project chose — its own, and the built-ins it overrode — with their events. The engine's untouched built-ins are named, without their events, in `atEngineDefault`: Godot registers 72 of them and writing them out is about 2,200 tokens of its own constant table. `names` answers exactly what it lists, chosen or not, which is how the events of an untouched built-in are read.",
        Answers::Addon("project.list_input_actions"),
        &[noted(
            opt("names", Kind::ListOf(&Text)),
            "The action names to read, like [\"ui_left\", \"jump\"]. Without it the project's own are answered and the rest are named.",
        )],
    ),
    op(
        "godot_project",
        "set_input_action",
        "Writes an input action. `name` is the action's own name, like move_left, never a settings path. Each event names its kind and its key, as {\"kind\": \"key\", \"key\": \"A\"} — the same shape list_input_actions answers with. The named keys are in the signature; F1 to F16, A to Z and 0 to 9 are spelled as they read. The other kinds are mouse_button and joypad_button, each taking a `button` index.",
        Answers::Addon("project.set_input_action"),
        &[
            noted(
                need("name", Text),
                "The action's own name, like move_left, never a settings path.",
            ),
            noted(
                shaped(
                    speaking(need("events", List), GODOT_KEY_NAME),
                    &[
                        noted(
                            need(
                                "kind",
                                Kind::Choice(&["key", "mouse_button", "joypad_button"]),
                            ),
                            "Which of the three an event is. Any other kind is refused here rather than in the editor.",
                        ),
                        speaking(opt("key", Text), GODOT_KEY_NAME),
                        noted(
                            opt("button", Int),
                            "A mouse button is an index of 1 or higher; a joypad button an index.",
                        ),
                    ],
                ),
                "The key is Godot's name for it, not the browser's.",
            ),
            opt("deadzone", Number),
        ],
    ),
    op(
        "godot_project",
        "remove_input_action",
        "Removes a project input action.",
        Answers::Addon("project.remove_input_action"),
        &[need("name", Text)],
    ),
    op(
        "godot_project",
        "reset_input_action",
        "Drops the override of a built-in action.",
        Answers::Addon("project.reset_input_action"),
        &[need("name", Text)],
    ),
    alone(
        op(
            "godot_project",
            "list_plugins",
            "Lists the project's editor plugins.",
            Answers::Addon("project.list_plugins"),
            &[],
        ),
        Sharing::Repeat,
        "It takes no parameters, so a second one in the same call is the first one again.",
    ),
    gated(
        op(
            "godot_project",
            "set_plugin_enabled",
            "Enables or disables a plugin.",
            Answers::Addon("project.set_plugin_enabled"),
            &[need("plugin", Text), need("enabled", Flag)],
        ),
        "Enabling or disabling an editor plugin changes what runs inside the editor itself.",
    ),
    op(
        "godot_project",
        "search_editor_settings",
        "Searches machine-wide editor settings by name. Capped at 50 matches, like search_settings.",
        Answers::Addon("editor.search_settings"),
        &[need("query", Text)],
    ),
    op(
        "godot_project",
        "get_editor_setting",
        "Reads one machine-wide editor setting.",
        Answers::Addon("editor.get_setting"),
        &[need("name", Text)],
    ),
    writes(
        gated(
            op(
                "godot_project",
                "set_editor_setting",
                "Writes one machine-wide editor setting. `value` is tagged with its type, as {\"type\": \"bool\", \"value\": true} — the same shape set_setting and node.set_property take.",
                Answers::Addon("editor.set_setting"),
                &[need("name", Text), need("value", Tagged)],
            ),
            "Editor settings are machine-wide: they live outside the task worktree and outside Git, so this change is not part of anything the task can roll back.",
        ),
        Writes::EditorSetting,
    ),
];

pub const GODOT_RESOURCE_OPERATIONS: &[Operation] = &[
    op(
        "godot_resource",
        "list",
        "Lists the files in the task worktree with their sizes. `under` narrows it to one directory — `assets`, named the way the project names it — and without it you get the whole worktree, which is a lot to read to see one folder. `hashes: true` reads every file so that a later delete of one is refused if it changed in the meantime. The router holds what it read; you never see it and never pass it. That is a read of the whole project, so ask for it before deleting files you have not opened, not to look around.",
        Answers::Rust,
        &[
            noted(
                opt("under", Text),
                "A directory to list, named the way the project names it — `assets`, not its full path. Omit it for every file in the worktree.",
            ),
            opt("hashes", Flag),
        ],
    ),
    op(
        "godot_resource",
        "rescan",
        "Tells the editor filesystem about files that changed. `path` is one file or a list of them — name everything you just wrote in one call, because a batch is imported in one pass and a call per file is not. Omit it to walk the whole project.",
        Answers::Addon("resource.rescan"),
        &[noted(
            opt("path", Kind::Either(&[Text, List])),
            "The file that changed, or a list of them — name every file you just wrote in one call rather than one call each. Omitted, the whole project is walked, which is what a directory made after the editor started needs.",
        )],
    ),
    op(
        "godot_resource",
        "create_tileset",
        "Cuts a texture into a TileSet and saves it. `path` is the .tres to write, `texture` an image the project already holds, and `tileSize` one number or two — 16 or [16, 16] — defaulting to 16. `tiles` is the [column, row] list to define and defaults to every tile the texture holds; `solid` is the subset that gets collision, either a list or \"all\", and a tile with no collision is scenery the player falls through. Answers with the atlas grid it found. Build a tileset with this rather than writing one as text: a TileSet carries a record per tile and a polygon per solid one, and a hand-written one opens as a resource with no tiles in it.",
        Answers::Addon("resource.create_tileset"),
        &[
            need("path", Text),
            need("texture", Text),
            noted(
                opt("tileSize", Kind::Either(&[Number, List])),
                "One number or two: 16 or [16, 16].",
            ),
            opt("tiles", List),
            noted(
                opt("solid", Kind::Either(&[List, Kind::Choice(&["all"])])),
                "A list of [column, row] pairs, or the word \"all\".",
            ),
        ],
    ),
    op(
        "godot_resource",
        "create_texture",
        "Draws a PNG and imports it, which is how a project with no art gets some. `path` is the .png to write and `size` is one number or two — 16 or [16, 24]. `rects` are filled rectangles painted over `background` in the order they are named, and without a `background` the image starts transparent, which is what a sprite wants. A colour is a name or a hex string — \"skyblue\", \"#8b5a2b\". An atlas is one texture with a rectangle per tile, laid out on the grid create_tileset then cuts: two 16x16 tiles side by side is a 32x16 image. The texture is imported by the time this answers, so it needs no rescan and create_tileset can name it straight away. Draw art with this rather than through bash: an image library is not something every machine has.",
        Answers::Addon("resource.create_texture"),
        &[
            need("path", Text),
            noted(
                need("size", Kind::Either(&[Number, List])),
                "One number or two: 16 or [16, 24].",
            ),
            noted(
                opt("background", Text),
                "A colour name or a hex string, like \"skyblue\" or \"#8b5a2b\". Transparent without one.",
            ),
            noted(
                shaped(
                    opt("rects", List),
                    &[
                        need("x", Int),
                        need("y", Int),
                        need("width", Int),
                        need("height", Int),
                        noted(
                            need("color", Text),
                            "A colour name or a hex string, spelled as `background` is.",
                        ),
                    ],
                ),
                "Filled rectangles, painted over the background in order.",
            ),
        ],
    ),
    op(
        "godot_resource",
        "create_shape",
        "Saves a 2D collision shape as a resource. `path` is the .tres to write. `shapeType` is one of RectangleShape2D (size as [width, height]), CircleShape2D (radius), CapsuleShape2D (radius and height), SegmentShape2D (points as [ax, ay, bx, by]), or WorldBoundaryShape2D (nothing). Set the node's `shape` property to the path afterwards — a CollisionShape2D without one collides with nothing, and a shape can only be assigned from a file that already exists.",
        Answers::Addon("resource.create_shape"),
        &[
            need("path", Text),
            need(
                "shapeType",
                Kind::Choice(&[
                    "RectangleShape2D",
                    "CircleShape2D",
                    "CapsuleShape2D",
                    "SegmentShape2D",
                    "WorldBoundaryShape2D",
                ]),
            ),
            opt("size", List),
            opt("radius", Number),
            opt("height", Number),
            opt("points", List),
        ],
    ),
    op(
        "godot_resource",
        "describe_tileset",
        "Reports what a saved TileSet holds. Answers with its tile size, its sources, and every tile they define with whether it is solid — which is where the [column, row] pairs godot_node set_cells takes come from.",
        Answers::Addon("resource.describe_tileset"),
        &[need("path", Text)],
    ),
    gated(
        op(
            "godot_resource",
            "move",
            "Moves a file or directory inside the worktree. Godot's own record of a file — its `.uid`, an asset's `.import` — travels with it, so a scene that refers to the file by id keeps finding it. Never move one of those on its own.",
            Answers::Rust,
            &[need("from", Text), need("to", Text)],
        ),
        "Moving a path removes the file from where it is now, and can overwrite the destination.",
    ),
    gated(
        op(
            "godot_resource",
            "delete",
            "Deletes a file or directory, and Godot's own record of it — its `.uid`, an asset's `.import` — with it. Never name one of those on its own. A file you have read is deleted as you last read it: the router holds the hash that read answered with and refuses the delete if the file changed since, so read it first when it matters that nothing moved underneath.",
            Answers::Rust,
            &[
                need("path", Text),
                noted(
                    hidden("expectedHash", Hash),
                    "Supplied by the router from the read that answered with it, so a call never carries one. It stays accepted for a caller that holds its own.",
                ),
            ],
        ),
        "Deleting a file removes it from the task worktree; only a Git checkout brings it back.",
    ),
];

pub const GODOT_SCRIPT_OPERATIONS: &[Operation] = &[
    op(
        "godot_script",
        "list",
        "Lists the GDScript files in the worktree with their size. `under` narrows it to one directory, named the way the project names it — `scripts`, not its full path — and omitting it lists every script. This is the call for finding a script whose name you do not know; a shell `find` is not, and it is refused outside the worktree anyway.",
        Answers::Rust,
        &[noted(
            opt("under", Text),
            "A directory to list, named the way the project names it — `scripts`, not its full path. Omit it for every script in the worktree.",
        )],
    ),
    op(
        "godot_script",
        "open",
        "Opens a script as a language-server document. `path` is one script or a list of them — open everything you are about to query in one call, not one call each. A list answers with `files`, one entry per path.",
        Answers::Rust,
        &[noted(
            need("path", Kind::Either(&[Text, List])),
            "One script, or a list of them — open every script you are about to query in one call rather than one call each. A list is answered with {\"files\": […]}, one entry per path, in the order you named them.",
        )],
    ),
    op(
        "godot_script",
        "update",
        "Reports an in-memory buffer change.",
        Answers::Rust,
        &[need("path", Text), need("text", Text)],
    ),
    writes(
        op(
            "godot_script",
            "edit",
            "Changes existing scripts by replacing exact text, and answers with each file's diagnostics. Put every change to one file in that file's `edits`, and every file in one call: this is one call, not one per change. `oldText` must appear exactly once in the file, so extend it with a neighbouring line when it would not; it is quoted from the file, so read the file first. Either every file is written or none is. To create a script, use `save`.",
            Answers::Rust,
            &[noted(
                shaped(
                    need("files", List),
                    &[
                        need("path", Text),
                        shaped(
                            need("edits", List),
                            &[need("oldText", Text), need("newText", Text)],
                        ),
                    ],
                ),
                "Every `oldText` must match one region of that file exactly and must not overlap another edit of the same file. Entries may name different files, and either every file is written or none is.",
            )],
        ),
        Writes::ScriptText,
    ),
    writes(
        op(
            "godot_script",
            "save",
            "Writes a whole file and answers with the file's diagnostics, the same way `edit` does. Use it to create a script, or to replace one outright; to change part of one, `edit` is the call, and it does not send the file back. A file that already exists is only written over what you have read, so open it first — the router holds the hash that read answered with. A script you are creating needs no read. `update` does not write anything: it reports a buffer change to the language server, and this is the call that puts it on disk. Do not follow this with a `diagnostics` call about the same file: the verdict is already here. `published: false` means the server had not spoken about the text yet, which is not the same as the file being clean.",
            Answers::Rust,
            &[
                need("path", Text),
                need("text", Text),
                noted(
                    hidden("expectedHash", Hash),
                    "Supplied by the router from the read that answered with it, so a call never carries one. It stays accepted for a caller that holds its own.",
                ),
            ],
        ),
        Writes::ScriptText,
    ),
    op(
        "godot_script",
        "close",
        "Closes the document. `path` is one script or a list of them, and a list answers with `files`, one entry per path.",
        Answers::Rust,
        &[noted(
            need("path", Kind::Either(&[Text, List])),
            "One script, or a list of them — close every script you are done with in one call rather than one call each. A list is answered with {\"files\": […]}, one entry per path, in the order you named them.",
        )],
    ),
    op(
        "godot_script",
        "format",
        "Formats source through the pinned gdformat sidecar.",
        Answers::Rust,
        &[need("source", Text)],
    ),
    op(
        "godot_script",
        "hover",
        "Hover documentation.",
        Answers::Rust,
        &[
            need("path", Text),
            noted(
                shaped(
                    need("position", Object),
                    &[need("line", Int), need("character", Int)],
                ),
                "Zero-based: the first character of the first line is {\"line\": 0, \"character\": 0}.",
            ),
        ],
    ),
    op(
        "godot_script",
        "completion",
        "Completion items.",
        Answers::Rust,
        &[
            need("path", Text),
            noted(
                shaped(
                    need("position", Object),
                    &[need("line", Int), need("character", Int)],
                ),
                "Zero-based: the first character of the first line is {\"line\": 0, \"character\": 0}.",
            ),
        ],
    ),
    op(
        "godot_script",
        "signature_help",
        "Signature help.",
        Answers::Rust,
        &[
            need("path", Text),
            noted(
                shaped(
                    need("position", Object),
                    &[need("line", Int), need("character", Int)],
                ),
                "Zero-based: the first character of the first line is {\"line\": 0, \"character\": 0}.",
            ),
        ],
    ),
    op(
        "godot_script",
        "definition",
        "Go to definition.",
        Answers::Rust,
        &[
            need("path", Text),
            noted(
                shaped(
                    need("position", Object),
                    &[need("line", Int), need("character", Int)],
                ),
                "Zero-based: the first character of the first line is {\"line\": 0, \"character\": 0}.",
            ),
        ],
    ),
    op(
        "godot_script",
        "declaration",
        "Go to declaration.",
        Answers::Rust,
        &[
            need("path", Text),
            noted(
                shaped(
                    need("position", Object),
                    &[need("line", Int), need("character", Int)],
                ),
                "Zero-based: the first character of the first line is {\"line\": 0, \"character\": 0}.",
            ),
        ],
    ),
    op(
        "godot_script",
        "references",
        "Find references.",
        Answers::Rust,
        &[
            need("path", Text),
            noted(
                shaped(
                    need("position", Object),
                    &[need("line", Int), need("character", Int)],
                ),
                "Zero-based: the first character of the first line is {\"line\": 0, \"character\": 0}.",
            ),
            opt("includeDeclaration", Flag),
        ],
    ),
    op(
        "godot_script",
        "highlights",
        "Document highlights.",
        Answers::Rust,
        &[
            need("path", Text),
            noted(
                shaped(
                    need("position", Object),
                    &[need("line", Int), need("character", Int)],
                ),
                "Zero-based: the first character of the first line is {\"line\": 0, \"character\": 0}.",
            ),
        ],
    ),
    op(
        "godot_script",
        "diagnostics",
        "Diagnostics the server published for a file. `path` is one script or a list of them — ask about every script you just wrote in one call, not one call each, because a list shares one wait for the whole batch and a call per file waits that long per file. A list answers with `files`, one entry per path. Answers `published: false` when the server has not said anything about that file yet, which is not the same as the file being clean — ask again rather than take an empty list for an answer. An empty list with `published: true` is a file that parses.",
        Answers::Rust,
        &[
            noted(
                need("path", Kind::Either(&[Text, List])),
                "One script, or a list of them — ask about every script you just wrote in one call rather than one call each. A list is answered with {\"files\": […]}, one entry per path, and shares one wait for the whole batch instead of waiting that long per file.",
            ),
            opt("timeoutMs", Int),
        ],
    ),
    op(
        "godot_script",
        "document_symbols",
        "Symbols of one document.",
        Answers::Rust,
        &[need("path", Text)],
    ),
    op(
        "godot_script",
        "workspace_symbols",
        "Symbols across the worktree.",
        Answers::Rust,
        &[need("query", Text)],
    ),
    op(
        "godot_script",
        "prepare_rename",
        "Checks whether a symbol can be renamed. Answers `renameable`: false is the language server declining this position, and rename will decline it too.",
        Answers::Rust,
        &[
            need("path", Text),
            noted(
                shaped(
                    need("position", Object),
                    &[need("line", Int), need("character", Int)],
                ),
                "Zero-based: the first character of the first line is {\"line\": 0, \"character\": 0}.",
            ),
        ],
    ),
    op(
        "godot_script",
        "rename",
        "Plans a rename without writing, and refuses when the server plans nothing — every real rename touches at least the declaration, so an empty plan is the server declining rather than a rename that reached no files. Pass what it answers to apply_rename unchanged.",
        Answers::Rust,
        &[
            need("path", Text),
            noted(
                shaped(
                    need("position", Object),
                    &[need("line", Int), need("character", Int)],
                ),
                "Zero-based: the first character of the first line is {\"line\": 0, \"character\": 0}.",
            ),
            need("newName", Text),
        ],
    ),
    writes(
        op(
            "godot_script",
            "apply_rename",
            "Applies a planned rename in one transaction. `files` is the list `rename` answered with, passed back unchanged. Every entry is checked against the file on disk before anything is written, so a list you edited by hand is refused the moment its `originalHash` does not match. It writes whole files: do not use it to write text you wrote yourself, which is what `save` and `edit` are for.",
            Answers::Rust,
            &[noted(
                shaped(
                    need("files", List),
                    &[
                        need("path", Text),
                        need("originalText", Text),
                        need("originalHash", Text),
                        need("updatedText", Text),
                    ],
                ),
                "The list `rename` answered with, passed back unchanged.",
            )],
        ),
        Writes::ScriptText,
    ),
];

pub const GODOT_DEBUG_OPERATIONS: &[Operation] = &[
    alone(
        op(
            "godot_debug",
            "status",
            "Connects to the adapter and reports its capabilities.",
            Answers::Rust,
            &[],
        ),
        Sharing::Repeat,
        "It takes no parameters, so a second one in the same call is the first one again.",
    ),
    op(
        "godot_debug",
        "set_breakpoints",
        "Replaces the breakpoints of one script.",
        Answers::Rust,
        &[need("path", Text), opt("lines", List)],
    ),
    op(
        "godot_debug",
        "breakpoint_locations",
        "Validates candidate lines.",
        Answers::Rust,
        &[need("path", Text), need("line", Int)],
    ),
    alone(
        op(
            "godot_debug",
            "launch",
            "Runs the project under the debugger. Give `breakpoints` when the game has to stop somewhere before you can look at it; without them it runs to completion and there is nothing to inspect.",
            Answers::Rust,
            &[
                opt("playArgs", List),
                shaped(
                    opt("breakpoints", List),
                    &[
                        need("path", Text),
                        noted(
                            need("lines", List),
                            "The line numbers to break on, counted from one.",
                        ),
                    ],
                ),
            ],
        ),
        Sharing::Exclusive,
        "One debuggee, driven in order: each answer decides what the next call means.",
    ),
    alone(
        op(
            "godot_debug",
            "attach",
            "Attaches to a game already running under this adapter.",
            Answers::Rust,
            &[],
        ),
        Sharing::Repeat,
        "It takes no parameters, so a second one in the same call is the first one again.",
    ),
    alone(
        op(
            "godot_debug",
            "await_stop",
            "Waits for the next stop. Null means it ended.",
            Answers::Rust,
            &[opt("threadId", Int), opt("timeoutMs", Int)],
        ),
        Sharing::Exclusive,
        "One debuggee, driven in order: each answer decides what the next call means.",
    ),
    alone(
        op(
            "godot_debug",
            "threads",
            "Lists the debuggable threads.",
            Answers::Rust,
            &[],
        ),
        Sharing::Repeat,
        "It takes no parameters, so a second one in the same call is the first one again.",
    ),
    op(
        "godot_debug",
        "stack_trace",
        "Returns the stopped stack, which is empty unless the game is stopped at a breakpoint or a step — a pause leaves it with no frame at all.",
        Answers::Rust,
        &[opt("threadId", Int)],
    ),
    op(
        "godot_debug",
        "scopes",
        "Returns Locals, Members, and Globals of a frame.",
        Answers::Rust,
        &[need("frameId", Int)],
    ),
    op(
        "godot_debug",
        "variables",
        "Expands a scope or object.",
        Answers::Rust,
        &[need("variablesReference", Int)],
    ),
    op(
        "godot_debug",
        "evaluate",
        "Evaluates an expression in a frame.",
        Answers::Rust,
        &[need("expression", Text), opt("frameId", Int)],
    ),
    alone(
        op(
            "godot_debug",
            "continue",
            "Resumes the debuggee.",
            Answers::Rust,
            &[opt("threadId", Int)],
        ),
        Sharing::Exclusive,
        "One debuggee, driven in order: each answer decides what the next call means.",
    ),
    alone(
        op(
            "godot_debug",
            "pause",
            "Pauses the debuggee between frames. It is not a break: a paused game has no stack to read and nothing to evaluate in. To look inside a script, set a breakpoint, continue, and wait for it with await_stop.",
            Answers::Rust,
            &[opt("threadId", Int)],
        ),
        Sharing::Exclusive,
        "One debuggee, driven in order: each answer decides what the next call means.",
    ),
    alone(
        op(
            "godot_debug",
            "step_over",
            "Steps over one line.",
            Answers::Rust,
            &[opt("threadId", Int)],
        ),
        Sharing::Exclusive,
        "One debuggee, driven in order: each answer decides what the next call means.",
    ),
    alone(
        op(
            "godot_debug",
            "step_in",
            "Steps into the call at the current line.",
            Answers::Rust,
            &[opt("threadId", Int)],
        ),
        Sharing::Exclusive,
        "One debuggee, driven in order: each answer decides what the next call means.",
    ),
    alone(
        op(
            "godot_debug",
            "step_out",
            "Steps out of the current frame (emulated).",
            Answers::Rust,
            &[opt("threadId", Int)],
        ),
        Sharing::Exclusive,
        "One debuggee, driven in order: each answer decides what the next call means.",
    ),
    alone(
        op(
            "godot_debug",
            "restart",
            "Restarts the debuggee with the last launch arguments.",
            Answers::Rust,
            &[],
        ),
        Sharing::Exclusive,
        "One debuggee, driven in order: each answer decides what the next call means.",
    ),
    alone(
        op(
            "godot_debug",
            "terminate",
            "Stops the debuggee, keeping the adapter.",
            Answers::Rust,
            &[],
        ),
        Sharing::Exclusive,
        "One debuggee, driven in order: each answer decides what the next call means.",
    ),
    alone(
        op(
            "godot_debug",
            "disconnect",
            "Detaches.",
            Answers::Rust,
            &[opt("terminateDebuggee", Flag)],
        ),
        Sharing::Exclusive,
        "One debuggee, driven in order: each answer decides what the next call means.",
    ),
];

pub const GODOT_RUNTIME_OPERATIONS: &[Operation] = &[
    alone(
        op(
            "godot_runtime",
            "run",
            "Runs the project and captures the first frame. `scene` runs that one scene instead of the project's main scene, which is the editor's own F6 — use it to try a scene you just built, rather than writing application/run/main_scene, running, and writing it back. restart restarts whatever run started.",
            Answers::Addon("runtime.run"),
            &[noted(
                opt("scene", Text),
                "A res:// path to a .tscn, like res://scenes/level_2.tscn. Without it the project's main scene runs.",
            )],
        ),
        Sharing::Repeat,
        "There is one running game, so a second one in the same call is the first one again.",
    ),
    alone(
        op(
            "godot_runtime",
            "stop",
            "Stops the running game.",
            Answers::Addon("runtime.stop"),
            &[],
        ),
        Sharing::Repeat,
        "There is one running game, so a second one in the same call is the first one again.",
    ),
    alone(
        op(
            "godot_runtime",
            "restart",
            "Restarts the running game.",
            Answers::Addon("runtime.restart"),
            &[],
        ),
        Sharing::Repeat,
        "There is one running game, so a second one in the same call is the first one again.",
    ),
    alone(
        op(
            "godot_runtime",
            "get_state",
            "Reports whether a game is running, its helper is ready, and the debugger has it paused at an error.",
            Answers::Addon("runtime.get_state"),
            &[],
        ),
        Sharing::Repeat,
        "It takes no parameters, so a second one in the same call is the first one again.",
    ),
    op(
        "godot_runtime",
        "get_tree",
        "Returns the running game's scene tree, and `paused`: whether the tree is paused right now. That one belongs to the SceneTree rather than to any node, so `inspect_node` cannot reach it and this is the only call that reports it.",
        Answers::Addon("runtime.get_tree"),
        &[
            noted(
                opt("root", Text),
                "The node to start from, as a path. The whole tree when it is absent.",
            ),
            noted(
                opt("depth", Int),
                "How many levels below the starting node to walk. Every level when it is absent.",
            ),
            noted(
                opt("limit", Int),
                "How many nodes to answer with, at most. The answer opens with `truncated`, which says whether it stopped early; a root or a depth is how you read the rest.",
            ),
        ],
    ),
    op(
        "godot_runtime",
        "inspect_node",
        "Inspects a running node. `properties` is the list of property names to read, like [\"position\", \"velocity\"]; without it the answer carries the node's path, name and type and an empty property map, so name what you want to see. A name the node does not have is an error rather than a gap. The groups it is in come back whether or not anything was named, because a group is not a property and a script joining one at run time is how half of them are joined.",
        Answers::Addon("runtime.inspect_node"),
        &[need("path", Text), opt("properties", List)],
    ),
    op(
        "godot_runtime",
        "input",
        "Injects input and captures the result. Each event names its kind and the parameters that kind uses, as {\"kind\": \"key\", \"key\": \"A\", \"pressed\": true} — send the release as a second event, or the key stays down. The named keys are in the signature; F1 to F16, A to Z and 0 to 9 are spelled as they read. A mouse button is named left, right, middle, wheel_up or wheel_down, or given as an index. A position is [x, y]. This drives the Input Map, so it is how you check that a level you built can actually be played. Its answer carries a frame, unless a later entry of the same call carries one too: a picture another picture replaces is not worth sending, and a moment in the middle of a key sequence is what capture is for.",
        Answers::Addon("runtime.input"),
        &[noted(
            shaped(
                speaking(need("events", List), GODOT_KEY_NAME),
                &[
                    noted(
                        need(
                            "kind",
                            Kind::Choice(&[
                                "key",
                                "mouse_button",
                                "mouse_motion",
                                "joypad_button",
                                "joypad_motion",
                            ]),
                        ),
                        "Which of the five an event is. Checked here rather than in the game: an event with no kind used to cross the socket and come back as `Input event kind '' is not supported`, which names nothing to send instead. One live turn wrote it 22 times.",
                    ),
                    speaking(opt("key", Text), GODOT_KEY_NAME),
                    noted(
                        opt("pressed", Flag),
                        "Held down unless this says otherwise, so the release is a second event carrying false.",
                    ),
                    noted(
                        opt("button", Kind::Either(&[Text, Int])),
                        "A mouse button by name - left, right, middle, wheel_up, wheel_down - or an index; a joypad button is an index.",
                    ),
                    opt("position", List),
                    opt("relative", List),
                    opt("axis", Int),
                    opt("value", Number),
                    opt("device", Int),
                ],
            ),
            "Each event is {\"kind\": \"key\", \"key\": \"A\", \"pressed\": true}, and the release is a second event.",
        )],
    ),
    op(
        "godot_runtime",
        "capture",
        "Captures a PNG frame.",
        Answers::Addon("runtime.capture"),
        &[opt("source", Kind::Choice(&["game", "editor"]))],
    ),
    op(
        "godot_runtime",
        "wait",
        "Lets the game run on for a few frames, then answers with how many passed and how long it took. This is how you wait for something the game does over time — a tween, a timer, a unit walking somewhere — before capturing or inspecting it. Never wait by running `sleep` in bash: that stops this process rather than letting the game advance, and it costs a whole request to do nothing.",
        Answers::Addon("runtime.wait"),
        &[
            noted(
                opt("frames", Int),
                "How many rendered frames to let pass. One when neither this nor `ms` is named.",
            ),
            noted(
                opt("ms", Int),
                "How long to let pass instead, in milliseconds. Held under ten seconds, which is what one request has.",
            ),
        ],
    ),
    alone(
        op(
            "godot_runtime",
            "pause",
            "Freezes the running game where it stands, the way its own pause menu would: `SceneTree.paused`, so a node that opted out of pausing keeps running. Use it before reading a game that moves — a path to a node a spawner made is stale as soon as that node is freed, and a frozen tree is one you can read twice. `resume` lets it go again. Gofer's own helper keeps answering either way.",
            Answers::Addon("runtime.pause"),
            &[],
        ),
        Sharing::Repeat,
        "It takes no parameters, so a second one in the same call is the first one again.",
    ),
    alone(
        op(
            "godot_runtime",
            "resume",
            "Lets a paused game run on again.",
            Answers::Addon("runtime.resume"),
            &[],
        ),
        Sharing::Repeat,
        "It takes no parameters, so a second one in the same call is the first one again.",
    ),
    op(
        "godot_runtime",
        "get_monitors",
        "Reads engine performance monitors. Without a list it answers with fps, memory_static and object_node_count. The rest are process_time, physics_time, memory_message_buffer, object_count, object_resource_count, object_orphan_node_count, render_objects_in_frame, render_primitives_in_frame, render_draw_calls_in_frame, render_video_memory, render_texture_memory and render_buffer_memory; any other name is an error.",
        Answers::Addon("runtime.get_monitors"),
        &[opt("monitors", List)],
    ),
];

pub const GODOT_LOGS_OPERATIONS: &[Operation] = &[op(
    "godot_logs",
    "read",
    "Reads a page. `editor` is the editor's stdout, which also carries what the game printed; `editorError` is where the engine reports its own failures, including a script that would not parse. Terminal colour is taken out, and the editor's own progress bar — `[  16% ] first_scan_filesystem | …` — is left out and counted in `terminalLinesOmitted`, because a terminal drawing itself is a fifth of this output and none of it is about the project.",
    Answers::Rust,
    &[
        opt("after", Int),
        opt("minSeverity", Kind::Choice(&["info", "warning", "error"])),
        opt("source", Kind::Choice(&["editor", "editorError"])),
        opt("contains", Text),
        opt("limit", Int),
    ],
)];

pub const GODOT_DOCS_SEARCH_OPERATIONS: &[Operation] = &[
    op(
        "godot_docs_search",
        "search",
        "Retrieves ranked passages for a question in plain words. Use it to see which chapters the manual has on a subject at all — when the question is which class to reach for, the list of chapters is the answer.",
        Answers::Rust,
        &[
            need("question", Text),
            noted(
                hidden("maxPassages", Int),
                "How many passages come back is not a number the model can reason about, so it is settled here at four. gofer-rag takes it as a ceiling and applies it before pinning a chapter the question named, so the rescue survives it; replaying its 83 labelled questions through every ceiling, four keeps 79% of the bytes and loses no case, where three loses two. The desktop Docs panel sets its own bound, so the parameter stays accepted and unadvertised.",
            ),
            opt("maxTextChars", Int),
        ],
    ),
    op(
        "godot_docs_search",
        "ask",
        "Answers one question from those same passages and hands back a paragraph and a quote instead of the chapters. Use it when you want one fact — a signature, an argument, what a property does — and would only have read one line out of what `search` returns. The quote is checked against the manual: an answer that arrives with a warning that its quote is not there was written from memory, and is not evidence. It needs a model connection, where `search` does not.",
        Answers::Rust,
        &[
            need("question", Text),
            noted(
                hidden("maxPassages", Int),
                "How many passages come back is not a number the model can reason about, so it is settled here at four. gofer-rag takes it as a ceiling and applies it before pinning a chapter the question named, so the rescue survives it; replaying its 83 labelled questions through every ceiling, four keeps 79% of the bytes and loses no case, where three loses two. The desktop Docs panel sets its own bound, so the parameter stays accepted and unadvertised.",
            ),
            opt("maxTextChars", Int),
        ],
    ),
];
// GENERATED-END operations

/// `timeoutMs` is lifted out of the parameters by the router for every command, so it is accepted
/// everywhere rather than repeated in forty tables.
///
/// `op` is not here. It names the entry rather than parameterising it, and the router takes it out
/// of the entry before anything — this check, the policy, the approval, the addon — sees one.
const UNIVERSAL: &[&str] = &["timeoutMs"];

/// The parameters of one operation, or `None` when nothing declares it and it is therefore
/// unchecked. Read only by tests, like the lookup behind it.
#[cfg(test)]
pub fn params_of(domain: &str, op: &str) -> Option<&'static [Param]> {
    operation_of(domain, op).map(|operation| operation.params)
}

/// The signature the model reads, as `{node, property, value, expectedRevision}`. Generated rather
/// than written, so the prose can no longer disagree with the check.
pub fn signature(params: &[Param]) -> String {
    if params.iter().all(|param| param.hidden) {
        return String::new();
    }
    let names: Vec<String> = params
        .iter()
        .filter(|param| !param.hidden)
        .map(|param| {
            let mark = if param.required { "" } else { "?" };
            // Every parameter carries its kind, and this is not decoration. A local Qwen3.6-27B was
            // asked 24 times to attach a script with `{node, property, value, expectedRevision}` in
            // front of the sentence and got the tagged value wrong 24 times, flattening it to
            // `{"type": "resource", "path": …}`; with `value: tagged` written out it was right 24
            // times out of 24. Annotating only the parameters that look tricky was worse than both
            // — 10 of 24 — so the annotation is uniform on purpose.
            match param.kind {
                Kind::Choice(allowed) => {
                    let quoted: Vec<String> =
                        allowed.iter().map(|word| format!("\"{word}\"")).collect();
                    format!("{}{mark}: {}", param.name, quoted.join("|"))
                }
                // The entry shape is printed for the same reason the kind is: it is the part a
                // model gets wrong, and it belongs where the kind is rather than in a sentence
                // beside it. `files: list of {path: text, edits: list of {oldText: text,
                // newText: text}}` is the whole contract, nested as deeply as it really is.
                _ if !param.entry.is_empty() => match param.kind {
                    // An object is its shape, so naming the kind as well would say it twice.
                    Kind::Object => format!("{}{mark}: {}", param.name, signature(param.entry)),
                    _ => format!(
                        "{}{mark}: {} of {}",
                        param.name,
                        short(param.kind),
                        signature(param.entry)
                    ),
                },
                // A vocabulary is printed wherever it applies, and the note on `Kind` above is the
                // measurement that says a signature carries this better than a sentence beside it.
                //
                // `like` rather than the `|` list a `Choice` gets, because a vocabulary is a sample
                // and a choice is the whole set: every key name Godot knows would be a signature
                // nobody could read, and `F7` is as valid as the twenty-five spelled here.
                _ if !param.vocabulary.is_empty() => {
                    let quoted: Vec<String> = param
                        .vocabulary
                        .iter()
                        .map(|word| format!("\"{word}\""))
                        .collect();
                    format!(
                        "{}{mark}: {} like {}",
                        param.name,
                        short(param.kind),
                        quoted.join("|")
                    )
                }
                Kind::Text => format!("{}{mark}: text", param.name),
                Kind::Int => format!("{}{mark}: int", param.name),
                Kind::Number => format!("{}{mark}: number", param.name),
                Kind::Flag => format!("{}{mark}: flag", param.name),
                Kind::List => format!("{}{mark}: list", param.name),
                Kind::Object => format!("{}{mark}: object", param.name),
                Kind::Hash => format!("{}{mark}: hash", param.name),
                Kind::Tagged => format!("{}{mark}: tagged", param.name),
                Kind::ListOf(inner) => format!("{}{mark}: list of {}", param.name, short(*inner)),
                Kind::Either(kinds) => {
                    let names: Vec<&str> = kinds.iter().map(|one| short(*one)).collect();
                    format!("{}{mark}: {}", param.name, names.join("|"))
                }
            }
        })
        .collect();
    format!("{{{}}}", names.join(", "))
}

/// The one word a signature spells a kind with.
fn short(kind: Kind) -> &'static str {
    match kind {
        Kind::Text => "text",
        Kind::Int => "int",
        Kind::Number => "number",
        Kind::Flag => "flag",
        Kind::List => "list",
        Kind::Object => "object",
        Kind::Hash => "hash",
        Kind::Tagged => "tagged",
        Kind::Choice(_) => "choice",
        Kind::Either(_) => "either",
        Kind::ListOf(_) => "list",
    }
}

/// [`Operation::check`], for a caller holding two strings — the drift checks, and the tests that
/// state the pair they are about. The router resolves the operation once and asks the row, which
/// is why this door is read only by tests.
#[cfg(test)]
pub fn check(domain: &str, op: &str, params: &Value) -> Result<(), ToolFailure> {
    operation_of(domain, op).map_or(Ok(()), |operation| operation.check(params))
}

/// One object against one parameter list, at `where_` — the empty string for the call's own
/// parameters, `files[0]` or `files[0].edits[1]` for something inside one of them.
///
/// The wording is the whole point of the nesting. `missing field oldText` is what serde says about
/// the same call, and a model cannot act on it: it names no operation, no parameter and no
/// position. `godot_script edit \`files[0].edits[1]\` requires \`oldText\`` names all three.
fn check_set(
    call: &str,
    op: &str,
    where_: &str,
    spec: &[Param],
    object: &serde_json::Map<String, Value>,
) -> Result<(), ToolFailure> {
    let shape = signature(spec);
    // Inside a structure the call's own name is already spent, so the sentence points at the
    // entry: "`files[0]` has no `edits` key" rather than "has no `edits` parameter".
    let (at, noun, takes) = if where_.is_empty() {
        (String::new(), "parameter", "It takes")
    } else {
        (format!(" `{where_}`"), "key", "Each entry takes")
    };
    // An operation whose every parameter is hidden has an empty signature, and the sentence then
    // read `godot_scene reload has no \`x\` parameter. It takes .` — which a live run was sent.
    // What the model needs to hear there is that the operation takes nothing at all.
    let takes_shape = if shape.is_empty() {
        format!("{takes} no parameters.")
    } else {
        format!("{takes} {shape}.")
    };

    let unknown: Vec<&String> = object
        .keys()
        .filter(|key| {
            !spec.iter().any(|param| param.name == *key)
                && !(where_.is_empty() && UNIVERSAL.contains(&key.as_str()))
        })
        .collect();
    // More than one key it does not take, and at least one of them could never have been a name.
    //
    // The loop below answers about the first bad key and returns, which is right when there is one
    // and costs a round trip per key when there are several. A live turn wrote three coins as three
    // `instantiate` entries, the JSON tore across all three, and the entry arrived carrying
    // `nameCoin1`, `name": "Coin1"}, {` and `path": "res://scenes/coin.tscn", ` beside an intact
    // `op`, `parent` and `path`. Gofer named one key per refusal: `nameCoin1` first, with
    // `Did you mean \`name\`?`, then the next, then the next. Five round trips and 3.6k tokens
    // before the repeat guard finally told it to build the call again, which it then did in one.
    //
    // Two or more unknown keys with a tear among them is not a vocabulary problem, so the spelling
    // hint is withheld: it sends a model looking for a better word for wreckage. The wording is the
    // one measured 15 of 15 on [`torn_object`] — name the intact keys, and ask for the whole call.
    //
    // The single-tear branch below is left alone: where a key tore and took its value with it, and
    // its head names a real parameter, that refusal was measured and this one must not preempt it.
    let single_tear = unknown.iter().any(|key| {
        tore_away_the_value(key, object.get(*key))
            && spec
                .iter()
                .any(|param| !param.hidden && param.name == the_name_at_the_head(key))
    });
    if !single_tear && unknown.len() > 1 && unknown.iter().any(|key| !could_be_a_name(key)) {
        // Only the keys the operation declares. The other branch's list is "could be a name",
        // which is right where one key tore; here a name-shaped piece of wreckage — `nameCoin1`,
        // the parameter glued to the value it was about to carry — would be read back as a key
        // that landed, and the whole sentence is about what did not.
        let intact: serde_json::Map<String, Value> = object
            .iter()
            .filter(|(name, _)| spec.iter().any(|param| param.name == name.as_str()))
            .map(|(name, held)| (name.clone(), held.clone()))
            .collect();
        let named = unknown.first().expect("more than one");
        return Err(failure(
            "torn_param",
            format!(
                "{call}{at} has {} keys it does not take, and the object you wrote came apart \
                 across them, so none of them is a word you chose wrongly. {takes_shape}{} Write \
                 the whole call again from what you meant, one operation per entry.",
                unknown.len(),
                what_it_carries(&intact)
            ),
            json!({"op": op, "param": path(where_, named), "takes": shape}),
        ));
    }

    for key in object.keys() {
        if spec.iter().any(|param| param.name == key)
            || (where_.is_empty() && UNIVERSAL.contains(&key.as_str()))
        {
            continue;
        }
        // A tear that took the value with it. Naming the key back is the right answer when the
        // key still holds the value — that is the 15-of-15 line below — and the wrong one when it
        // holds nothing: the sentence then describes the caller's own wreckage instead of what to
        // write, and puts that wreckage back into the conversation. One live turn sent
        // `{"name": "Enemy", "op": "instantiate", "parent\": ": ", "}`, was told thirteen times
        // running that the operation "has no `parent\": ` parameter", and resent it unchanged
        // thirteen times; it then abandoned the operation and hand-wrote the resource with the
        // file tools. What is missing is the part a caller can act on, so that is what it hears,
        // with the tear named and never quoted.
        if tore_away_the_value(key, object.get(key))
            && let Some(head) = spec
                .iter()
                .find(|param| !param.hidden && param.name == the_name_at_the_head(key))
        {
            let intact: serde_json::Map<String, Value> = object
                .iter()
                .filter(|(name, _)| could_be_a_name(name))
                .map(|(name, held)| (name.clone(), held.clone()))
                .collect();
            // A required parameter still missing is the thing to lead with. When nothing required
            // is missing the call is short of an optional one, and dropping it quietly would build
            // a node under a name nobody asked for — so it is still a refusal, and it still never
            // quotes the key.
            let missing = spec
                .iter()
                .find(|param| param.required && !object.contains_key(param.name));
            let (opening, named) = match missing {
                Some(param) => (format!("{call}{at} requires `{}`.", param.name), param),
                None => (
                    format!(
                        "{call}{at} lost `{}` to a torn key, and it is optional here.",
                        head.name
                    ),
                    head,
                ),
            };
            return Err(failure(
                if missing.is_some() {
                    "missing_param"
                } else {
                    "torn_param"
                },
                join(
                    format!(
                        "{opening} {takes_shape}{} One key arrived torn, carrying no value, so \
                         what went wrong is the object you wrote rather than a word you chose: \
                         write the whole call again.",
                        what_it_carries(&intact)
                    ),
                    named.note,
                ),
                json!({"op": op, "param": path(where_, named.name), "takes": shape}),
            ));
        }
        let hint = nearest(key, spec)
            .map(|name| format!(" Did you mean `{name}`?"))
            .unwrap_or_default();
        return Err(failure(
            "unknown_param",
            format!(
                "{call}{at} has no `{}` {noun}. {takes_shape}{hint}{}",
                as_much_of_the_key_as_is_evidence(key),
                torn_object(key, object.get(key))
            ),
            json!({"op": op, "param": path(where_, key), "takes": shape}),
        ));
    }

    for param in spec {
        match object.get(param.name) {
            None if param.required => {
                return Err(failure(
                    "missing_param",
                    join(
                        format!(
                            "{call}{at} requires `{}`. {takes_shape}{}",
                            param.name,
                            what_it_carries(object)
                        ),
                        param.note,
                    ),
                    json!({"op": op, "param": path(where_, param.name), "takes": shape}),
                ));
            }
            None => {}
            Some(value) => check_one(call, op, where_, param, value)?,
        }
    }
    Ok(())
}

/// The head of a key, which is where the evidence is. A torn key can be arbitrarily long.
///
/// The same reasoning [`torn_object`] applies to the value: the shape is the evidence, not the
/// length of it. And it matters more here, because what makes a key long is the wreckage. One live
/// turn sent `size=[32, 64]}]'</parameter>]</parameter>></function></tool_call></parameter>   Let
/// me fix the syntax. <tool_call>1;0;0}{` — its own harness's closing tags, in its own JSON — three
/// times running, and the refusal read every one of them back into the conversation. The head says
/// what tore; the tail is the thing not to repeat.
fn as_much_of_the_key_as_is_evidence(key: &str) -> String {
    const LONGEST: usize = 40;
    if key.chars().count() <= LONGEST {
        return key.to_owned();
    }
    format!("{}…", key.chars().take(LONGEST).collect::<String>())
}

/// The keys an object did arrive with, so a missing one is a difference rather than an absence.
///
/// `godot_script edit \`files[0]\` requires \`path\`` is the second commonest refusal in the recorded
/// live turns and the only frequent one that says nothing about what was sent — an `unknown_param`
/// carries the value that arrived, and this carried the shape that was wanted and no more. Three
/// separate turns hit it, in three separate sessions, and none of the traces can say what shape
/// they wrote, because nothing anywhere recorded it.
///
/// The names alone, never the values: an edit's `oldText` is a whole function, and a refusal is not
/// where to put one back.
fn what_it_carries(object: &serde_json::Map<String, Value>) -> String {
    if object.is_empty() {
        return " This one is empty.".to_owned();
    }
    const SHOWN: usize = 8;
    const LONGEST: usize = 40;
    let named: Vec<String> = object
        .keys()
        .take(SHOWN)
        .map(|key| {
            if key.chars().count() <= LONGEST {
                key.clone()
            } else {
                format!("{}…", key.chars().take(LONGEST).collect::<String>())
            }
        })
        .collect();
    let rest = object.len().saturating_sub(named.len());
    let more = if rest == 0 {
        String::new()
    } else {
        format!(" and {rest} more")
    };
    format!(" This one carries {}{more}.", named.join(", "))
}

/// Where a parameter sits, written the way the model wrote it: `files[0].edits[1].oldText`.
fn path(where_: &str, name: &str) -> String {
    if where_.is_empty() {
        name.to_owned()
    } else {
        format!("{where_}.{name}")
    }
}

/// Whether a value is of a kind. Shape only: nothing here needs the editor or the filesystem.
fn fits(kind: Kind, value: &Value) -> bool {
    match kind {
        Kind::Text => value.is_string(),
        Kind::Int => value.is_i64() || value.is_u64(),
        Kind::Number => value.is_number(),
        Kind::Flag => value.is_boolean(),
        Kind::List => value.is_array(),
        Kind::Object => value.is_object(),
        Kind::Hash => value.as_str().is_some_and(is_hash),
        Kind::Choice(allowed) => value.as_str().is_some_and(|text| allowed.contains(&text)),
        Kind::Either(kinds) => kinds.iter().any(|one| fits(*one, value)),
        Kind::Tagged => value.is_object(),
        // The bracket only. An entry that does not fit is named by its position in `check_inside`,
        // rather than folded into "this one was an array of three items".
        Kind::ListOf(_) => value.is_array(),
    }
}

/// Sixty-four lowercase hex characters, and nothing else. A read answers with exactly this.
fn is_hash(text: &str) -> bool {
    text.len() == 64
        && text
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn wanted(kind: Kind) -> String {
    match kind {
        Kind::Text => "a string".to_owned(),
        Kind::Int => "a whole number".to_owned(),
        Kind::Number => "a number".to_owned(),
        Kind::Flag => "true or false".to_owned(),
        Kind::List => "an array".to_owned(),
        Kind::Object => "an object".to_owned(),
        Kind::Hash => "a hash: sixty-four lowercase hex characters".to_owned(),
        Kind::Choice(allowed) => format!("one of {}", allowed.join(", ")),
        Kind::Either(kinds) => {
            let names: Vec<String> = kinds.iter().map(|one| wanted(*one)).collect();
            names.join(" or ")
        }
        Kind::Tagged => "a tagged value".to_owned(),
        Kind::ListOf(inner) => format!("a list of {}", wanted(*inner)),
    }
}

fn check_one(
    call: &str,
    op: &str,
    where_: &str,
    param: &Param,
    value: &Value,
) -> Result<(), ToolFailure> {
    let here = path(where_, param.name);
    if let Kind::Tagged = param.kind {
        return check_tagged(call, &here, param, value);
    }
    if fits(param.kind, value) {
        return check_inside(call, op, &here, param, value);
    }
    let expected = wanted(param.kind);
    // A hash is the one parameter a caller copies by hand, so the failure counts the characters
    // rather than describing the string: "sixty-three characters" is the whole diagnosis, and
    // "changed since it was read" — what this used to become — is a lie that reads as true.
    let counted = match (param.kind, value.as_str()) {
        (Kind::Hash, Some(text)) => format!(
            " That is {} character{}, so it is a copy that slipped rather than a hash of anything. \
             Copy it again from the read that answered with it.",
            text.chars().count(),
            if text.chars().count() == 1 { "" } else { "s" }
        ),
        _ => String::new(),
    };
    Err(failure(
        "invalid_param",
        join(
            format!(
                "{call} `{here}` takes {expected}, and this one was {}.{counted}",
                describe(value)
            ),
            param.note,
        ),
        json!({"param": here, "received": value}),
    ))
}

/// What is inside a `list` or an `object`, when the parameter says what that is.
///
/// A list is checked entry by entry, so the position is in the answer: the model that nested five
/// files inside each other's `edits` was told `missing field oldText` and could not tell which of
/// the five, or that nesting was the mistake at all.
fn check_inside(
    call: &str,
    op: &str,
    here: &str,
    param: &Param,
    value: &Value,
) -> Result<(), ToolFailure> {
    if let Kind::ListOf(inner) = param.kind {
        for (index, item) in value.as_array().into_iter().flatten().enumerate() {
            if !fits(*inner, item) {
                return Err(failure(
                    "invalid_param",
                    join(
                        format!(
                            "{call} `{here}[{index}]` takes {}, and this one was {}.",
                            wanted(*inner),
                            describe(item)
                        ),
                        param.note,
                    ),
                    json!({"param": format!("{here}[{index}]"), "received": item}),
                ));
            }
        }
        return Ok(());
    }
    if param.entry.is_empty() {
        return Ok(());
    }
    let mut entries: Vec<(String, &Value)> = Vec::new();
    match value.as_array() {
        Some(items) => {
            for (index, item) in items.iter().enumerate() {
                entries.push((format!("{here}[{index}]"), item));
            }
        }
        None => entries.push((here.to_owned(), value)),
    }
    for (at, item) in entries {
        let Some(object) = item.as_object() else {
            return Err(failure(
                "invalid_param",
                join(
                    format!(
                        "{call} `{at}` takes an object of {}, and this one was {}.",
                        signature(param.entry),
                        describe(item)
                    ),
                    param.note,
                ),
                json!({"param": at, "received": item}),
            ));
        };
        check_set(call, op, &at, param.entry, object)?;
    }
    Ok(())
}

/// Every tag the protocol carries, and the payload it requires.
///
/// This is the same table `Protocol.decode` walks in the addon, and it stays the addon's job too:
/// that one is the wire's own backstop and cannot be removed. What it cannot be is the *first*
/// place a shape is examined, because by then the call has crossed a socket and the answer has been
/// flattened to `code: message`.
const TAGS: &[(&str, Payload)] = &[
    ("null", Payload::Anything),
    ("bool", Payload::Boolean),
    ("int", Payload::Numeric),
    ("float", Payload::Numeric),
    ("string", Payload::Str),
    ("vector2", Payload::Numbers(2)),
    ("vector2i", Payload::Numbers(2)),
    ("vector3", Payload::Numbers(3)),
    ("vector3i", Payload::Numbers(3)),
    ("vector4", Payload::Numbers(4)),
    ("vector4i", Payload::Numbers(4)),
    ("quaternion", Payload::Numbers(4)),
    ("color", Payload::Colour),
    ("rect2", Payload::Numbers(4)),
    ("rect2i", Payload::Numbers(4)),
    ("plane", Payload::Numbers(4)),
    ("transform2d", Payload::Numbers(6)),
    ("basis", Payload::Numbers(9)),
    ("transform3d", Payload::Numbers(12)),
    ("array", Payload::Items),
    ("dictionary", Payload::Pairs),
    ("resource", Payload::ResourcePath),
];

#[derive(Clone, Copy, PartialEq)]
enum Payload {
    Anything,
    /// Four numbers, or a name or hex string the engine reads as one. `Color.from_string` takes
    /// "skyblue" and "#8b5a2b" alike, `resource.create_texture` takes them, and a `color` value
    /// that refused them was the one place in the tool where a colour had to be spelled another
    /// way — one live turn wrote "red" here and was told a colour is four numbers.
    Colour,
    Boolean,
    Numeric,
    Str,
    Numbers(usize),
    Items,
    Pairs,
    ResourcePath,
}

/// How many numbers a payload is written as, where it is written as numbers at all.
///
/// A colour is four of them and also a name, so the repairs that put `{r, g, b, a}` back into an
/// array have to know both — the shape is the same however the value may also be spelled.
fn how_many_numbers(payload: &Payload) -> Option<usize> {
    match payload {
        Payload::Numbers(count) => Some(*count),
        Payload::Colour => Some(4),
        _ => None,
    }
}

fn check_tagged(call: &str, here: &str, param: &Param, value: &Value) -> Result<(), ToolFailure> {
    let example = "{\"type\": \"vector2\", \"value\": [12, 34]}";
    let Some(object) = value.as_object() else {
        return Err(failure(
            "invalid_param",
            join(
                format!(
                    "{call} `{here}` takes a tagged value like {example}, and this one was {}.",
                    describe(value)
                ),
                param.note,
            ),
            json!({"param": here, "received": value}),
        ));
    };
    let Some(tag) = object.get("type").and_then(Value::as_str) else {
        return Err(failure(
            "invalid_param",
            join(
                format!("{call} `{here}` needs a `type`, as in {example}."),
                param.note,
            ),
            json!({"param": here, "received": value}),
        ));
    };
    let Some((_, payload)) = TAGS.iter().find(|(name, _)| *name == tag) else {
        let names: Vec<&str> = TAGS.iter().map(|(name, _)| *name).collect();
        return Err(failure(
            "invalid_param",
            format!(
                "{call} `{here}`: `{tag}` is not a value type. They are {}.",
                names.join(", ")
            ),
            json!({"param": here, "type": tag, "types": names}),
        ));
    };
    let inner = object.get("value").unwrap_or(&Value::Null);
    let wrong = match payload {
        Payload::Anything => None,
        Payload::Boolean => (!inner.is_boolean()).then(|| "true or false".to_owned()),
        Payload::Numeric => (!inner.is_number()).then(|| "a number".to_owned()),
        Payload::Str => (!inner.is_string()).then(|| "a string".to_owned()),
        Payload::Numbers(count) => {
            let numbers = inner
                .as_array()
                .is_some_and(|items| items.len() == *count && items.iter().all(Value::is_number));
            (!numbers).then(|| format!("an array of {count} numbers"))
        }
        Payload::Colour => {
            let four = inner
                .as_array()
                .is_some_and(|items| items.len() == 4 && items.iter().all(Value::is_number));
            // The engine reads the name; this only refuses what is neither shape. A name it does
            // not know is refused on the wire, where the table that knows the names lives.
            let named = inner.as_str().is_some_and(|text| !text.trim().is_empty());
            (!four && !named).then(|| {
                "four numbers, or a name like skyblue, or a hex string like #8b5a2b".to_owned()
            })
        }
        Payload::Items => (!inner.is_array()).then(|| "an array of tagged values".to_owned()),
        Payload::Pairs => {
            (!inner.is_array()).then(|| "an array of {key, value} tagged pairs".to_owned())
        }
        Payload::ResourcePath => {
            let held = inner.as_object().and_then(|object| object.get("path"));
            match held.and_then(Value::as_str) {
                Some(path) if !path.trim().is_empty() => None,
                // The wrapper is right and the path inside it is not. Saying "takes an object
                // carrying a path, and this one was an object holding path" is a sentence that
                // contradicts itself and never names the mistake — one live turn wrote
                // `{"path": ""}` for a material it had not made yet and read exactly that.
                Some(_) => Some("a path, and this one's is empty".to_owned()),
                None if held.is_some() => Some("a path written as a string".to_owned()),
                None => Some("an object carrying a path".to_owned()),
            }
        }
    };
    let Some(expected) = wrong else {
        return Ok(());
    };

    // The correction, with the model's own value already in it, wherever the value is recoverable
    // from what arrived. A generic example is one the model has to adapt, and a live run showed
    // what that costs: `{"x": 32, "y": 32}` for a vector2, thirteen times, each refused by a
    // sentence that said what was wanted and never what to send.
    let fix = match payload {
        Payload::ResourcePath => {
            let path = inner.as_str().unwrap_or("res://…");
            format!(" Send {{\"type\": \"resource\", \"value\": {{\"path\": \"{path}\"}}}}.")
        }
        Payload::Numbers(_) | Payload::Colour => how_many_numbers(payload)
            .and_then(|count| numbers_under_names(inner, count))
            .map_or_else(String::new, |numbers| {
                let written: Vec<String> = numbers.iter().map(ToString::to_string).collect();
                format!(
                    " Send {{\"type\": \"{tag}\", \"value\": [{}]}}.",
                    written.join(", ")
                )
            }),
        _ => String::new(),
    };
    Err(failure(
        "invalid_param",
        join(
            format!(
                "{call} `{here}`: a {tag} value takes {expected}{}.{fix}",
                // A sentence that has already named what arrived does not name it twice.
                if expected.starts_with("a path") {
                    String::new()
                } else {
                    format!(", and this one was {}", describe(inner))
                }
            ),
            param.note,
        ),
        json!({"param": here, "type": tag, "received": inner}),
    ))
}

/// [`Operation::repair`], for a caller holding two strings. Read only by tests, like the lookup
/// behind it.
#[cfg(test)]
pub fn repair(domain: &str, op: &str, params: &mut Value) {
    if let Some(operation) = operation_of(domain, op) {
        operation.repair(params);
    }
}

fn repair_set(spec: &[Param], params: &mut Value) {
    let Some(object) = params.as_object_mut() else {
        return;
    };
    // A key onto the parameter it was plainly meant to be, before anything is held to it.
    //
    // The refusal already worked this out: ``set_autoload has no `nameSettings` parameter … Did
    // you mean `name`?``. One live turn was told that nineteen times and resent the same call
    // unchanged every time — a third of everything it did — with the sentence naming the answer
    // in front of it each time. That is the same finding that made a whitespace-padded key a
    // repair rather than a refusal.
    //
    // Narrower than the hint, on purpose. The hint names the *first* parameter a key could have
    // meant, because one guess in a sentence beats none; this renames only when the key could
    // have meant exactly one, and only when that parameter is not already there. Anything else is
    // left where it is for `check` to refuse by name, with the hint still saying what to try.
    put_the_pair_back(spec, object);
    drop_the_wreckage_of_a_pair_that_survived(spec, object);
    fold_a_tag_written_flat(spec, object);
    a_pair_written_as_one_key(spec, object);
    drop_the_empty_claimant(spec, object);
    let wanted: Vec<(String, &'static str)> = object
        .keys()
        .filter(|key| {
            !spec.iter().any(|param| param.name == key.as_str())
                && !UNIVERSAL.contains(&key.as_str())
        })
        .filter_map(|key| {
            only_one_meaning(key, object.get(key), spec).map(|name| (key.clone(), name))
        })
        .filter(|(_, name)| !object.contains_key(*name))
        .collect();
    // Two wrong keys that both read as the same parameter are two answers, so neither is taken.
    // Whichever won would be whichever the map happened to iterate first, and a rename nobody can
    // predict is worse than the refusal that names both.
    for (wrong, right) in &wanted {
        let contested = wanted.iter().filter(|(_, name)| name == right).count() > 1;
        if contested {
            continue;
        }
        if let Some(held) = object.remove(wrong.as_str()) {
            object.insert((*right).to_owned(), held);
        }
    }
    for param in spec {
        let Some(held) = object.get_mut(param.name) else {
            continue;
        };
        trim_a_name(param, held);
        unbox_the_one(param.kind, held);
        match param.kind {
            Kind::Tagged => repair_tagged(held),
            Kind::List if !param.entry.is_empty() => {
                if let Some(items) = held.as_array_mut() {
                    for item in items {
                        repair_set(param.entry, item);
                    }
                }
            }
            Kind::Object if !param.entry.is_empty() => repair_set(param.entry, held),
            _ => {}
        }
    }
}

/// A name and its value written as one key, with the colon and the quotes lost between them.
///
/// One live turn's `create_shape` calls, six of them in a row, five distinct shapes:
///
/// ```text
/// {"op": "create_shape", "path": …, "shapeType": "RectangleShape2D", "size [16, 16]": null}
/// {"op": "create_shape", "op create_shape": null, "path shapes/floor_shape.tres": null,
///  "shapeType RectangleShape2D": null, "size [640, 16]": null}
/// ```
///
/// Every one of them is `"<name> <value>": null`. The pair was written, the separator was not, and
/// what should have been a value became part of the key — so the parameter is absent and the key
/// beside it names nothing. Neither existing repair reaches it: the key is not name-shaped, so
/// `only_one_meaning` needs a value beside it and there is none, and it holds more than punctuation
/// past its name, so `tore_away_the_value` says no.
///
/// Two shapes, and nothing else:
///
/// The tail is a whole JSON value — `[16, 16]` — or one plain word with no space, comma, quote or
/// bracket in it, which is what a path, a class name or a node path looks like. A tail that is
/// neither is wreckage rather than a value: `"size 16: null}]er_shape.tres, "` is two calls that
/// ran into each other, and `"path a.tres, b.tres"` is two operations written as one. Both stay for
/// `check` to name.
///
/// And the result has to be one the parameter could hold, which is the rule every rename follows.
///
/// A key whose head names something the object already carries, with the same value, is the second
/// half of a pair that survived — `"op create_shape": null` beside `"op": "create_shape"`. It says
/// nothing the call has not already said, and it is taken away rather than read.
fn a_pair_written_as_one_key(spec: &[Param], object: &mut serde_json::Map<String, Value>) {
    let torn: Vec<String> = object
        .iter()
        .filter(|(key, held)| held.is_null() && !spec.iter().any(|one| one.name == key.as_str()))
        .map(|(key, _)| key.clone())
        .collect();
    for key in torn {
        let head = the_name_at_the_head(&key).to_owned();
        if head.is_empty() {
            continue;
        }
        let tail = key[head.len()..].trim_matches(|one: char| {
            one.is_whitespace() || one == ':' || one == '=' || one == '"' || one == '\''
        });
        if tail.is_empty() {
            continue;
        }
        let Some(written) = a_value_out_of(tail) else {
            continue;
        };
        // The same pair a second time, torn. Nothing to read, and the refusal it would otherwise
        // earn is about a key the caller cannot see.
        if object.get(&head) == Some(&written) {
            object.remove(&key);
            continue;
        }
        if object.contains_key(&head) {
            continue;
        }
        let Some(param) = spec
            .iter()
            .find(|one| !one.hidden && one.name == head.as_str())
        else {
            continue;
        };
        if !could_become(param.kind, &written) {
            continue;
        }
        object.remove(&key);
        object.insert(head, written);
    }
}

/// The value half of a key that swallowed one, or nothing when what is there is not a value.
///
/// A whole JSON value, or one plain word. `serde_json` stops at the end of the first value it
/// reads, so the whole tail has to be consumed — otherwise `[32, 32]}]edits`, which is two tool
/// calls that ran into each other, would read as a size.
fn a_value_out_of(tail: &str) -> Option<Value> {
    if let Ok(held) = serde_json::from_str::<Value>(tail) {
        return Some(held);
    }
    let plain = !tail.chars().any(|one| {
        one.is_whitespace() || matches!(one, ',' | '"' | '\'' | '{' | '}' | '[' | ']' | ':' | '=')
    });
    plain.then(|| Value::String(tail.to_owned()))
}

/// A key holding nothing, standing between a key holding the answer and the parameter it names.
///
/// `{"path": …, "shapeType": "RectangleShape2D", "size_list": [16, 16], "size_list_note": null}`
/// is what a live turn sent `resource.create_shape`. `size_list` alone is repaired to `size` and
/// the call runs; with the second key beside it both read as `size`, the rename below sees two
/// answers, and it takes neither — a rename nobody can predict being worse than a refusal that
/// names both. So the call was refused, and what blocked it was a key with nothing in it.
///
/// Only that: the key carries no value at all, another unknown key reads as the same parameter and
/// does carry one, and neither is a parameter this operation declares. A key holding something is
/// never dropped, because what it holds is what the caller wrote.
fn drop_the_empty_claimant(spec: &[Param], object: &mut serde_json::Map<String, Value>) {
    let unknown: Vec<(String, bool, Option<&'static str>)> = object
        .iter()
        .filter(|(key, _)| !spec.iter().any(|param| param.name == key.as_str()))
        .filter(|(key, _)| !UNIVERSAL.contains(&key.as_str()))
        .map(|(key, held)| {
            (
                key.clone(),
                carries_a_value(Some(held)),
                the_one_it_reads_as(key, spec),
            )
        })
        .collect();
    let empty: Vec<String> = unknown
        .iter()
        .filter(|(_, carries, reads)| !carries && reads.is_some())
        .filter(|(key, _, reads)| {
            unknown.iter().any(|(other, carries, other_reads)| {
                other != key && *carries && other_reads == reads
            })
        })
        .map(|(key, _, _)| key.clone())
        .collect();
    for key in empty {
        object.remove(&key);
    }
}

/// The two halves of a tagged value, written as two flat keys, folded back to one.
///
/// `{"path": …, "shapeType": "RectangleShape2D", "sizeType": null, "sizeValue": [24, 48]}` is what
/// a live turn sent `resource.create_shape`. `size` is a plain list here and nothing about it is
/// tagged — the model carried the protocol's own `{type, value}` shape over from `set_property`
/// and flattened it onto the parameter name.
///
/// The rename below already turns a lone `sizeValue` into `size`. It cannot turn this one, and
/// deliberately: `sizeType` and `sizeValue` both read as `size`, that is two answers, and
/// `wanted` refuses a contested rename rather than picking whichever the map iterated first. So
/// the call was refused with ``has no `sizeType` parameter … Did you mean `size`?``, which names
/// the half that was already right.
///
/// Measured against the local Qwen3.8-27B at medium, 2 seeds interleaved over two catalogue arms:
/// **0 of 8 `create_shape` entries carried a two-number `size`**, and every one of the eight wrote
/// it under `sizeValue`, `size_value`, `sizeValues` or `sizeType` + `sizeValue`. Printing the
/// shape in the signature — `size?: [width, height]` rather than `size?: list` — changed nothing:
/// 0 of 4 either way. It is the tagged habit, not the word `list`.
///
/// Narrow: the head has to name a declared parameter the object does not already carry, the
/// object has to hold that head's value half as well, and the type half has to hold what a type
/// slot holds — a name, or nothing. No operation in the catalogue declares a `<name>Type` beside
/// a `<name>`, so nothing real is thrown away; `check-command-surface` would have to change for
/// that to stop being true.
fn fold_a_tag_written_flat(spec: &[Param], object: &mut serde_json::Map<String, Value>) {
    const TYPE_HALF: [&str; 2] = ["Type", "_type"];
    const VALUE_HALF: [&str; 4] = ["Value", "Values", "_value", "_values"];
    let flattened: Vec<String> = object
        .iter()
        .filter(|(_, held)| held.is_null() || held.is_string())
        .filter_map(|(key, _)| {
            let head = TYPE_HALF
                .iter()
                .find_map(|suffix| key.strip_suffix(suffix))
                .filter(|head| !head.is_empty())?;
            spec.iter()
                .any(|param| !param.hidden && param.name == head)
                .then_some(())?;
            (!object.contains_key(head)).then_some(())?;
            VALUE_HALF
                .iter()
                .any(|suffix| object.contains_key(&format!("{head}{suffix}")))
                .then(|| key.clone())
        })
        .collect();
    for key in flattened {
        object.remove(&key);
    }
}

/// The parameters whose text is content, where the whitespace round it is part of what was written.
///
/// Everything else a `text` or `choice` parameter carries is a name: a node path, a property, a
/// class, a setting, a group, a signal, a file. None of those has meaningful whitespace at either
/// end, and a model that slips puts it there — the padded *key* has been repaired for a while, and
/// one live turn showed the padded *value* going through untouched twelve times in a row.
///
/// `source` is a whole script buffer, and the trailing newline is the part that mattered: gdformat
/// always ends its output with one, so a trimmed buffer came back differing from what was sent and
/// `godot_script format` answered `changed: true` about a buffer it had not changed.
const TEXT_THAT_IS_CONTENT: [&str; 6] = [
    "text",
    "oldText",
    "newText",
    "originalText",
    "updatedText",
    "source",
];

/// Trims the whitespace round a name, which is never part of one.
///
/// Watched live: `{"parent ": "/Level3D ", "type ": "DirectionalLight3D"}`. The key came back as
/// `parent`, the value stayed `/Level3D `, and the refusal read `Node /Level3D  was not found …
/// the scene's own root is /Level3D` — two strings that look identical on screen. The addon trims
/// node paths now as well; this is the door before it, and it reaches property names, class names,
/// group names and settings paths too.
fn trim_a_name(param: &Param, held: &mut Value) {
    if TEXT_THAT_IS_CONTENT.contains(&param.name) {
        return;
    }
    if !matches!(param.kind, Kind::Text | Kind::Choice(_) | Kind::Hash) {
        return;
    }
    let Some(text) = held.as_str() else {
        return;
    };
    let trimmed = text.trim();
    if trimmed.len() != text.len() {
        *held = Value::String(trimmed.to_owned());
    }
}

/// Takes a lone value out of the list a model wrapped it in.
///
/// The same reasoning as [`sole_entry`], one shape along: a parameter that takes one thing, given a
/// list of exactly one thing of that kind, has been handed the value in a box. There is no order to
/// guess at and nothing to choose between.
///
/// Watched live in one turn building a large project: `godot_node add_to_group \`node\` takes a
/// string, and this one was an array of 1` — four times, and once more for `set_cells`. Every one
/// of them held the single node path the call was about.
///
/// A parameter whose kind already allows a list is left alone: `godot_resource rescan` takes one
/// path or several on purpose, and unwrapping there would change what was asked. So is a list of
/// two, which is a shape rather than a box, and a list of one holding the wrong kind, which is not
/// the value at all. Both stay for the refusal to name.
fn unbox_the_one(kind: Kind, held: &mut Value) {
    if fits(kind, held) || fits(Kind::List, held) && allows_a_list(kind) {
        return;
    }
    let Some(items) = held.as_array() else {
        return;
    };
    let [only] = items.as_slice() else {
        return;
    };
    if !fits(kind, only) {
        return;
    }
    *held = only.clone();
}

/// Whether a kind takes a list itself, and so must never have one unwrapped out from under it.
fn allows_a_list(kind: Kind) -> bool {
    match kind {
        Kind::List => true,
        Kind::Either(kinds) => kinds.iter().any(|one| allows_a_list(*one)),
        _ => false,
    }
}

/// The only value in an object of one entry, or nothing.
///
/// A model that reads `value: tagged` and the kind beside it writes the kind back into the value:
/// `{"type": "float", "value": {"number": 3.5}}` and `{"type": "string", "value": {"text": "…"}}`,
/// eight times in one live turn, under the protocol's own words for those kinds. One entry of the
/// type the tag wants is not a shape with an order to guess at — it is the value, in a box.
///
/// **The key's own name is deliberately ignored, and narrowing this to a list of box words would
/// be worse.** The concern is real on its face: `{"type": "int", "value": {"height": 720}}` written
/// to `viewport_width` is accepted, saved, and reads back 720, so a name that contradicts the
/// parameter is thrown away. Reproduced against a real editor, and then measured for how often a
/// model actually writes one — twenty turns asked to set five properties, counted by
/// `scripts/bench-prompt-line.mjs`:
///
/// 18 boxes were written under a word that is not a box word, and every one of them was a
/// placeholder for the value itself — `{"base": 5}`, `{"n": 5}`, `{"a": true}`, `{"data": 5}`,
/// `{"amount": 5}`, `{"state": true}` — carrying the right number. 15 were written under a box
/// word. Not one named a different property. A box-word list would refuse eighteen correct calls in
/// twenty turns to prevent a shape the model does not write.
///
/// An object of two is still refused, and says what it received, which is where a genuine
/// width-for-height slip lands.
fn sole_entry(value: &Value) -> Option<&Value> {
    let object = value.as_object()?;
    if object.len() != 1 {
        return None;
    }
    object.values().next()
}

/// The protocol's spelling of a tag a model wrote in the engine's.
///
/// `{"type": "String", "value": "Resume"}` is one wrapper written by one model that knew both
/// words: the protocol tag and Godot's own class name. It was refused sixteen times in one live
/// turn — the same call resent unchanged, then split into single properties and resent again — and
/// cost that turn most of its twelve minutes, while the `bool` beside it in the same call went
/// through. Across five recorded turns 41 of 86 tagged values were wrapped twice, and 22 of the 41
/// spelled the inner tag with the engine's capital.
///
/// Every tag the protocol carries is lowercase and no two of them differ only in case, so the fold
/// cannot reach two answers. A word that is not a tag in any case is left exactly as it arrived,
/// so [`check_tagged`] still refuses it in the spelling the caller wrote.
fn fold_the_tag(held: &mut Value) {
    let Some(tag) = held.get("type").and_then(Value::as_str) else {
        return;
    };
    if TAGS.iter().any(|(name, _)| *name == tag) {
        return;
    }
    let lowered = tag.to_lowercase();
    let Some(name) = TAGS
        .iter()
        .find(|(name, _)| *name == lowered)
        .map(|(name, _)| *name)
    else {
        return;
    };
    if let Some(object) = held.as_object_mut() {
        object.insert("type".to_owned(), Value::String(name.to_owned()));
    }
}

/// The tagged value a model wrapped in a second copy of its own tag, unwrapped.
///
/// `{"type": "vector2", "value": {"type": "vector2", "value": [32, 48]}}` is what one live turn
/// against a local Qwen3.6-27B wrote 51 times in 114 tool calls. The router refused every one of
/// them by naming the payload it wanted, and the payload it wanted was inside the value it was
/// handed.
///
/// Only the same tag twice, whatever case each side is written in — the two spellings are the
/// protocol's and the engine's, and [`fold_the_tag`] has already put the outer one back. Two
/// different tags is not a wrapper anybody meant to write, and deciding which of them is the real
/// one is not this layer's to do: the router refuses it and says what it received. A `resource`,
/// whose payload is an object with a `path`, is untouched for the same reason — it is not a tag
/// inside a tag.
///
/// Repeatedly, because three copies is the same mistake as two.
fn unwrap_a_tag_written_twice(held: &mut Value) {
    while let Some((tag, payload)) = a_tag_inside_its_own(held) {
        *held = json!({"type": tag, "value": payload});
    }
}

/// The tag and the payload of a value wrapped in a second copy of its own tag, or nothing.
///
/// "Exactly" the pair: the inner object holds a `type` and a `value` and nothing else, so a payload
/// that merely happens to carry a `type` of its own is left alone.
fn a_tag_inside_its_own(held: &Value) -> Option<(String, Value)> {
    let tag = held.get("type")?.as_str()?;
    let inner = held.get("value")?.as_object()?;
    if inner.len() != 2 {
        return None;
    }
    if !inner.get("type")?.as_str()?.eq_ignore_ascii_case(tag) {
        return None;
    }
    Some((tag.to_owned(), inner.get("value")?.clone()))
}

fn repair_tagged(held: &mut Value) {
    // The tag first, because the payload repairs below are chosen by it, and then the wrapper,
    // because what is inside a wrapper is what the payload repairs are about.
    fold_the_tag(held);
    unwrap_a_tag_written_twice(held);
    let Some(tag) = held.get("type").and_then(Value::as_str) else {
        return;
    };
    let Some((_, payload)) = TAGS.iter().find(|(name, _)| *name == tag) else {
        return;
    };
    let Some(inner) = held.get("value") else {
        return;
    };
    let repaired = match payload {
        Payload::Numbers(_) | Payload::Colour => how_many_numbers(payload)
            .and_then(|count| numbers_under_names(inner, count))
            .map(|numbers| Value::Array(numbers.into_iter().cloned().map(Value::Number).collect())),
        Payload::Numeric => sole_entry(inner).filter(|one| one.is_number()).cloned(),
        Payload::Str => sole_entry(inner).filter(|one| one.is_string()).cloned(),
        Payload::Boolean => sole_entry(inner).filter(|one| one.is_boolean()).cloned(),
        // `resource` carries an object on purpose, `array` and `dictionary` carry their own lists,
        // and `null` takes anything. None of them is a value in a box.
        _ => None,
    };
    let Some(repaired) = repaired else {
        return;
    };
    if let Some(object) = held.as_object_mut() {
        object.insert("value".to_owned(), repaired);
    }
}

/// The names a model reaches for when it writes a vector as an object, in the order the protocol
/// wants the numbers in.
///
/// Only sets whose order is not a guess. `{x, y}` is a vector2 and `{r, g, b, a}` is a colour;
/// a rect2's four numbers under any four names are not, so nothing is offered for those.
const ORDERED_NAMES: [&[&str]; 4] = [
    &["x", "y"],
    &["x", "y", "z"],
    &["x", "y", "z", "w"],
    &["r", "g", "b", "a"],
];

/// The numbers of a vector written as an object, in protocol order, or nothing.
fn numbers_under_names(inner: &Value, count: usize) -> Option<Vec<&serde_json::Number>> {
    let object = inner.as_object()?;
    if object.len() != count {
        return None;
    }
    ORDERED_NAMES
        .iter()
        .filter(|names| names.len() == count)
        .find_map(|names| {
            names
                .iter()
                .map(|name| object.get(*name).and_then(Value::as_number))
                .collect::<Option<Vec<&serde_json::Number>>>()
        })
}

/// What arrived, in the words the failure uses. A model that is told only what was wanted has
/// nothing to compare its own call against, which is the whole reason the old sentence failed.
fn describe(value: &Value) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::Bool(held) => held.to_string(),
        Value::Number(held) => format!("the number {held}"),
        Value::String(held) => format!("the string {}", json!(held)),
        Value::Array(held) => format!("an array of {}", held.len()),
        Value::Object(held) => {
            let mut names: Vec<&str> = held.keys().map(String::as_str).collect();
            names.sort_unstable();
            if names.is_empty() {
                "an empty object".to_owned()
            } else {
                format!("an object holding {}", names.join(", "))
            }
        }
    }
}

/// What to add when the key is not a name at all, but a piece of an object that came apart.
///
/// `{"name': ": ", ", "op": "set_autoload", "path": "res://…"}` is a model whose JSON tore
/// mid-line: the key swallowed a quote and a colon and the value is the fragment left over. The
/// name it meant never reached the wire. Sixteen of these across two live turns, thirteen of them
/// one call resent unchanged, and the autoload was never registered in either.
///
/// The refusal already ended `Did you mean \`name\`?`, and that is the wrong advice here — nothing
/// was misnamed, the object was mis-written, and a model told it picked the wrong word goes looking
/// for a better word. Measured interleaved against a local Qwen3.6-27B, 15 seeds, the same torn
/// call and the same refusal, scored on whether the next call carries a well-formed `name`:
/// **the shipped sentence 0 of 15, this one 15 of 15**. What the shipped arm does instead is
/// abandon the call — it answers with `godot_script list` and `godot_scene get_tree` and never
/// tries the autoload again, which is exactly what both live turns did.
///
/// Only for a key that could not have been a name. An ordinary typo is a word, and for that the
/// hint above is the right answer and this would be nonsense.
fn torn_object(key: &str, value: Option<&Value>) -> String {
    if could_be_a_name(key) {
        return String::new();
    }
    let Some(carried) = value.and_then(|held| serde_json::to_string(held).ok()) else {
        return String::new();
    };
    // A long value is not the evidence; the shape of it is. The whole point is that it is a scrap.
    if carried.chars().count() > 60 {
        return String::new();
    }
    format!(
        " It arrived carrying {carried}, so what went wrong is the object you wrote rather than \
         the word you chose: write the whole call again."
    )
}

/// Takes away a torn key that is a second copy of a pair the object already holds intact.
///
/// Watched live, seventeen times in one turn, the same call every time:
///
/// ```text
/// {"expression": "velocity", "expression}: ": ", ", "frameId': 0}, {": 0, "op": "evaluate"}
/// ```
///
/// `expression` is there and correct. `expression}: ` is the same pair a second time, torn, with a
/// comma for a value — it names nothing the call has not already said, and the call is complete and
/// right without it. Every refusal it earned was about a key the caller could not see, and the
/// caller resent the identical call seventeen times.
///
/// Only that shape: the key holds its name and punctuation and nothing else, the value beside it
/// holds nothing, and the name is a parameter this object already carries. A torn key over a
/// parameter that is *absent* is left alone, because there the caller does have something to write
/// and `check` says so.
fn drop_the_wreckage_of_a_pair_that_survived(
    spec: &[Param],
    object: &mut serde_json::Map<String, Value>,
) {
    let wreckage: Vec<String> = object
        .iter()
        .filter(|(key, held)| tore_away_the_value(key, Some(held)))
        .filter(|(key, _)| {
            let head: String = key
                .chars()
                .take_while(|one| one.is_ascii_alphanumeric() || *one == '_')
                .collect();
            spec.iter().any(|param| param.name == head) && object.contains_key(&head)
        })
        .map(|(key, _)| key.clone())
        .collect();
    for key in wreckage {
        object.remove(&key);
    }
}

/// Puts back a parameter whose whole `name: value,` fragment tore into the key.
///
/// [`only_one_meaning`] renames a torn key only when the *value beside it* carries a letter or a
/// digit, because `"name': ": ", "` would otherwise register an autoload called `, `. That rule is
/// right and this is the case it cannot reach: the value is not beside the key, it is **inside**
/// it. Quoted either way and bare numbers both, because both were watched live — a model that
/// rendered a Python dictionary into its JSON wrote single quotes, and a debugger turn tore
/// `frameId': 0}, {` twice.
///
/// ```text
/// "node': '/GameLevel/Ground', ": ", "
/// ```
///
/// The model rendered a Python dictionary into its JSON — `{'node': '/GameLevel/Ground', …}` — and
/// one whole pair became a key, with the leftover comma and space as its value. The path is not
/// wreckage; it is the thing the call was about. One live turn building a large project met this
/// **thirteen times**: six `set_cells`, four `set_property`, three `create`, each carrying the node
/// path it wanted.
///
/// Only when every part of it is unambiguous: the name is a real parameter of this operation, that
/// parameter takes a string, it is not already there, and no second torn key names it too. Anything
/// else is left for the refusal, which already prints the whole fragment.
fn put_the_pair_back(spec: &[Param], object: &mut serde_json::Map<String, Value>) {
    let found: Vec<(String, &'static str, Value)> = object
        .keys()
        .filter(|key| !spec.iter().any(|param| param.name == key.as_str()))
        .filter_map(|key| {
            let (name, value) = a_torn_pair(key)?;
            let param = spec
                .iter()
                .find(|param| !param.hidden && param.name == name)?;
            fits(param.kind, &value).then(|| (key.clone(), param.name, value))
        })
        .filter(|(_, name, _)| !object.contains_key(*name))
        .collect();
    for (torn, name, value) in &found {
        if found.iter().filter(|(_, other, _)| other == name).count() > 1 {
            continue;
        }
        object.remove(torn.as_str());
        object.insert((*name).to_owned(), value.clone());
    }
}

/// A key that is a whole `name: value,` fragment, read back as the two it was.
///
/// Deliberately strict, in three places. A name-shaped start; nothing but punctuation between it
/// and the colon; and nothing but punctuation after the value, which is the brace and comma the
/// object lost. That last rule is what keeps `size": [32, 32]}]edits` out — the tail carries
/// another call's word, so half of it is not a value to put back.
///
/// The value is a quoted string or a bare number. Both were watched live: `node': '/GameLevel/
/// Ground', ` thirteen times in one turn, and `frameId': 0}, {` twice in another, that one under a
/// value made entirely of the harness's own closing tags.
fn a_torn_pair(key: &str) -> Option<(&str, Value)> {
    let split = key.find(|one: char| !(one.is_ascii_alphanumeric() || one == '_'))?;
    let (name, rest) = key.split_at(split);
    if !could_be_a_name(name) {
        return None;
    }
    let colon = rest.find(':')?;
    if rest[..colon].chars().any(char::is_alphanumeric) {
        return None;
    }
    let (value, tail) = a_leading_scalar(rest[colon + 1..].trim_start())?;
    (!tail.chars().any(char::is_alphanumeric)).then_some((name, value))
}

/// The scalar a fragment opens with, and whatever followed it.
///
/// Quoted either way, because a model that rendered a Python dictionary into its JSON wrote single
/// quotes. Numbers bare. Nothing else: `true`, `false` and `null` are words, and a word here is far
/// more likely to be the wreckage of the next key than a value anybody meant.
fn a_leading_scalar(text: &str) -> Option<(Value, &str)> {
    for quote in ['\'', '"'] {
        if let Some(rest) = text.strip_prefix(quote)
            && let Some((held, tail)) = rest.split_once(quote)
        {
            return Some((Value::String(held.to_owned()), tail));
        }
    }
    let digits = text
        .find(|one: char| !(one.is_ascii_digit() || one == '-' || one == '+' || one == '.'))
        .unwrap_or(text.len());
    let (number, tail) = text.split_at(digits);
    serde_json::from_str::<Value>(number)
        .ok()
        .filter(Value::is_number)
        .map(|held| (held, tail))
}

/// The one parameter a key reads as, with no opinion about what sits beside it.
///
/// [`only_one_meaning`] answers the question a rename asks — which needs the value, because a
/// rename that lands a pair on a parameter that takes a number writes a call the caller did not.
/// Two repairs ask a narrower question: which parameter is this key *about*. An empty key is about
/// something by its name alone, and what it holds is precisely the thing it does not have.
fn the_one_it_reads_as(key: &str, spec: &[Param]) -> Option<&'static str> {
    let mut fitting = spec
        .iter()
        .filter(|param| !param.hidden && reads_as(key, param));
    let first = fitting.next()?;
    fitting.next().is_none().then_some(())?;
    Some(first.name)
}

/// The one parameter a key could have been meant as, or nothing when it could have been two.
///
/// A key that is not shaped like a name has torn out of an object, and then the value beside it
/// decides. Both halves are real, and they are told apart by what arrived, not by the key:
///
/// - `"path:": "scripts/main.gd"` — a stray colon on the key, and the path itself is intact. The
///   model meant `path` and can be given it.
/// - `"name': ": ", "` — the key swallowed a quote and a colon and the value is the comma and space
///   left over. Renaming that registers an autoload called `, `.
///
/// So a torn key is renamed only when its value carries a letter or a digit. Punctuation on its own
/// is the wreckage, and every torn value in the recordings is exactly `", "`. I had this the other
/// way round first — refusing every torn key — and a live debugger turn showed what that costs:
/// three refusals of `path:` in a row, each carrying the path it wanted.
fn only_one_meaning(key: &str, value: Option<&Value>, spec: &[Param]) -> Option<&'static str> {
    if !could_be_a_name(key) && !carries_a_value(value) {
        return None;
    }
    let mut fitting = spec
        .iter()
        .filter(|param| !param.hidden && reads_as(key, param));
    let first = fitting.next()?;
    fitting.next().is_none().then_some(())?;
    // Never onto a parameter the value could not be, whatever the key looks like. The clause below
    // has said this for a torn key since a live turn wrote `"size)": false`; a key that is merely
    // misspelled was exempt, and a live turn found the hole:
    //
    //     {"op": "create_shape", "shapeType": "RectangleShape2D",
    //      "size_list": [16, 16], "height_list": [16, 16]}
    //
    // Both keys are name-shaped and each reads as exactly one parameter, so both were renamed.
    // `size` was right; `height` is a number and now held a pair, and the whole call came back
    // ``\`height\` takes a number, and this one was an array of 2`` — about a key the model never
    // wrote, on an operation whose `height` a RectangleShape2D does not read at all. Left unnamed,
    // `check` refuses `height_list` by its own name and the sentence is at least true.
    value
        .is_some_and(|held| could_become(first.kind, held))
        .then_some(())?;
    // A key that is not shaped like a name at all did not arrive by choosing the wrong word — it
    // arrived torn. Two things have to hold before it is renamed anyway, and both were watched in
    // live turns failing.
    //
    // The value has to be one this parameter could take. One turn wrote `"size)": false` where
    // `"size": [32, 32]` was meant, was told ``\`size\` takes an array, and this one was false`` —
    // about a key it had never written — resent the identical call, and then abandoned the
    // operation and hand-wrote the `.tres` with the file tools.
    //
    // And the key has to hold nothing past the name but punctuation. `path:` is a stray colon and
    // renaming it is right. `size": [32, 32]}]edits` is two tool calls that ran into each other:
    // the name reads as `size`, the value that came with it was a list of *edits*, and a list is
    // what `size` takes — so the rename fired, `check` passed, and the addon answered "A
    // RectangleShape2D takes size as two numbers" three times running about a call whose real
    // `size` was sitting inside the key.
    //
    // When either fails the key stays for `check` to name, and that refusal quotes the mangled key
    // and what it held — the sentence a live turn recovered from in one call.
    if !could_be_a_name(key)
        && !(only_punctuation_past_the_name(key)
            && value.is_some_and(|held| could_become(first.kind, held)))
    {
        return None;
    }
    Some(first.name)
}

/// Whether a value is of a kind, or is one of the shapes the repairs below turn into that kind.
fn could_become(kind: Kind, value: &Value) -> bool {
    if fits(kind, value) {
        return true;
    }
    let mut probe = value.clone();
    unbox_the_one(kind, &mut probe);
    fits(kind, &probe)
}

/// Whether a torn key took the value with it, leaving nothing worth handing back.
///
/// `method": "_on_coin_collected", ` still holds the value the line lost, and naming it back is
/// what tells a model where its value went: 0 of 15 recoveries without that line, 15 of 15 with
/// it. `parent": ` holds the parameter's own name, some punctuation, and nothing else. Naming that
/// back is handing a caller its own wreckage, and the same measurement runs the other way — one
/// live turn resent the identical call thirteen times against it.
///
/// So: nothing alphanumeric past the name-shaped start of the key, and nothing in the value either.
fn tore_away_the_value(key: &str, value: Option<&Value>) -> bool {
    !could_be_a_name(key) && !carries_a_value(value) && only_punctuation_past_the_name(key)
}

/// The name-shaped start of a key, which is the parameter a torn one reads as.
fn the_name_at_the_head(key: &str) -> &str {
    let leading = key
        .chars()
        .take_while(|one| one.is_ascii_alphanumeric() || *one == '_')
        .count();
    &key[..leading]
}

/// Whether a torn key holds nothing past its name-shaped start but punctuation.
///
/// `path:` and `parent": ` do. `size": [32, 32]}]edits` does not — what follows the name is another
/// call's worth of JSON, and neither the value beside such a key nor the value inside it is the one
/// the caller meant.
fn only_punctuation_past_the_name(key: &str) -> bool {
    let leading = key
        .chars()
        .take_while(|one| one.is_ascii_alphanumeric() || *one == '_')
        .count();
    !key[leading..].chars().any(char::is_alphanumeric)
}

/// Whether what arrived is a value at all, rather than punctuation left over from a torn object.
///
/// One letter or digit anywhere in it. `", "` has none; `"scripts/main.gd"`, `"ticks"` and every
/// real value do. A non-string — a number, a flag, a list — is a value by arriving at all.
fn carries_a_value(value: Option<&Value>) -> bool {
    match value {
        None => false,
        Some(Value::String(held)) => held.chars().any(|one| one.is_alphanumeric()),
        Some(Value::Null) => false,
        Some(_) => true,
    }
}

/// Whether a written key is shaped like a parameter name: a letter or underscore, then more of
/// those or digits. Every name in the table is one, and no torn-off fragment of JSON is.
fn could_be_a_name(key: &str) -> bool {
    let mut characters = key.chars();
    characters
        .next()
        .is_some_and(|first| first.is_ascii_alphabetic() || first == '_')
        && characters.all(|held| held.is_ascii_alphanumeric() || held == '_')
}

/// Whether one written key reads as one declared parameter. The rule [`nearest`] offers hints by.
fn reads_as(key: &str, param: &Param) -> bool {
    let lowered = key.to_lowercase();
    let name = param.name.to_lowercase();
    name == lowered
        || name.starts_with(&lowered)
        || lowered.starts_with(&name)
        || lowered.replace('_', "") == name.replace('_', "")
}

/// The accepted name closest to one that was not accepted, when a single edit reaches it. Typos and
/// case slips are the whole population here — `nodePath` for `node`, `Value` for `value` — so a
/// cheap prefix-and-case comparison finds them without a distance matrix.
fn nearest(key: &str, spec: &[Param]) -> Option<&'static str> {
    spec.iter()
        // A hidden parameter is one the prompt tells the model never to pass, so offering it as
        // the near miss sends the model to write the one key it must not write. A live run was
        // told `Did you mean \`expectedRevision\`?` about a key that was not one at all.
        .filter(|param| !param.hidden)
        .find(|param| reads_as(key, param))
        .map(|param| param.name)
}

fn join(message: String, note: &str) -> String {
    if note.is_empty() {
        message
    } else {
        format!("{message} {note}")
    }
}

fn failure(code: &str, message: String, details: Value) -> ToolFailure {
    ToolFailure {
        code: code.to_owned(),
        message,
        retryable: false,
        details,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai_tools::CATALOG;

    fn check_ok(domain: &str, op: &str, params: Value) {
        assert_eq!(check(domain, op, &params), Ok(()), "{domain} {op} {params}");
    }

    fn message(domain: &str, op: &str, params: Value) -> String {
        check(domain, op, &params)
            .expect_err("the call is refused")
            .message
    }

    /// A colour may be written the way Godot writes one, and the way it always could.
    ///
    /// `resource.create_texture` takes "skyblue" and "#8b5a2b" because `Color.from_string` does,
    /// and a `color` value refusing them made the same tool spell a colour two ways. One live turn
    /// wrote "red" for a `modulate` and was told a colour is four numbers.
    #[test]
    fn a_colour_may_be_named_as_well_as_counted() {
        for value in [
            json!({"type": "color", "value": "red"}),
            json!({"type": "color", "value": "#8b5a2b"}),
            json!({"type": "color", "value": [1, 0.5, 0.25, 1]}),
        ] {
            check_ok(
                "godot_node",
                "set_property",
                json!({"node": "/Main/Player", "property": "modulate", "value": value}),
            );
        }

        // Neither shape is neither. The name itself is read on the wire, where the engine's own
        // table of names lives, so an unknown one is refused there rather than guessed at here.
        let neither = message(
            "godot_node",
            "set_property",
            json!({
                "node": "/Main/Player",
                "property": "modulate",
                "value": {"type": "color", "value": 7}
            }),
        );
        assert!(neither.contains("name like skyblue"), "{neither}");
    }

    /// A resource wrapper that is right with a path that is empty says so, rather than contradicting
    /// itself.
    ///
    /// Observed live: `{"type": "resource", "value": {"path": ""}}` for a material the turn had not
    /// made yet, answered `a resource value takes an object carrying a path, and this one was an
    /// object holding path` — a sentence that says the shape is wrong when the shape is right, and
    /// never names the empty string that is.
    #[test]
    fn an_empty_resource_path_is_named_as_one() {
        let empty = message(
            "godot_node",
            "set_property",
            json!({
                "node": "/Game/Ground",
                "property": "material",
                "value": {"type": "resource", "value": {"path": ""}}
            }),
        );
        assert!(
            empty.contains("this one's is empty") && !empty.contains("an object holding path"),
            "{empty}"
        );

        // A wrapper with no path at all is still the wrapper being wrong.
        let shapeless = message(
            "godot_node",
            "set_property",
            json!({
                "node": "/Game/Ground",
                "property": "material",
                "value": {"type": "resource", "value": {"res": "a.tres"}}
            }),
        );
        assert!(
            shapeless.contains("an object carrying a path"),
            "{shapeless}"
        );
    }

    /// The whitespace round a name is trimmed off it; the whitespace inside content is not.
    ///
    /// Observed live, twelve times running: `{"parent ": "/Level3D ", "type ":
    /// "DirectionalLight3D"}`. The padded *key* has been repaired for a while, and the padded
    /// *value* went through untouched — so the refusal read `Node /Level3D  was not found … the
    /// scene's own root is /Level3D`, two strings that look identical on screen.
    #[test]
    fn the_whitespace_round_a_name_is_not_part_of_it() {
        let mut padded = json!({"type ": "DirectionalLight3D", "name": " Light "});
        padded["parent "] = json!("/Level3D ");
        repair("godot_node", "create", &mut padded);
        assert_eq!(padded["parent"], json!("/Level3D"), "{padded}");
        assert_eq!(padded["type"], json!("DirectionalLight3D"), "{padded}");
        assert_eq!(padded["name"], json!("Light"), "{padded}");
        check_ok("godot_node", "create", padded);

        // A choice reads as one too, so a padded shape name is the shape.
        let mut shape = json!({"path": " a.tres ", "shapeType": "CircleShape2D ", "radius": 4});
        repair("godot_resource", "create_shape", &mut shape);
        assert_eq!(shape["shapeType"], json!("CircleShape2D"), "{shape}");
        assert_eq!(shape["path"], json!("a.tres"), "{shape}");
        check_ok("godot_resource", "create_shape", shape);

        // And a script's own text is content: what is round it is part of what was written.
        let mut written = json!({"path": "a.gd", "text": "extends Node\n\n\n"});
        repair("godot_script", "save", &mut written);
        assert_eq!(written["text"], json!("extends Node\n\n\n"), "{written}");
        let mut edited = json!({
            "files": [{"path": "a.gd", "edits": [{"oldText": "  x = 1\n", "newText": "  x = 2\n"}]}]
        });
        repair("godot_script", "edit", &mut edited);
        assert_eq!(
            edited["files"][0]["edits"][0]["oldText"],
            json!("  x = 1\n"),
            "{edited}"
        );

        // So is the buffer handed to the formatter. Trimmed, gdformat put the trailing newline
        // back and every already-formatted buffer came back `changed: true` — the one answer that
        // tells the caller to write the file again.
        let mut formatting =
            json!({"source": "extends Node\n\n\nfunc value() -> int:\n\treturn 1\n"});
        repair("godot_script", "format", &mut formatting);
        assert_eq!(
            formatting["source"],
            json!("extends Node\n\n\nfunc value() -> int:\n\treturn 1\n"),
            "{formatting}"
        );
        check_ok("godot_script", "format", formatting);
    }

    /// A torn second copy of a pair the object already holds is thrown away, not refused.
    ///
    /// Observed live, seventeen times in one turn — the same `godot_debug evaluate` call each time,
    /// with `expression` present and correct beside a torn `expression}: ` carrying a comma. Every
    /// refusal was about a key the caller could not see in what it thought it had written, and it
    /// resent the identical call seventeen times.
    #[test]
    fn a_torn_second_copy_of_a_pair_that_survived_is_thrown_away() {
        let mut doubled = json!({"expression": "velocity"});
        doubled["expression}: "] = json!(", ");
        doubled["frameId': 0}, {"] = json!(0);
        repair("godot_debug", "evaluate", &mut doubled);
        assert_eq!(doubled["expression"], json!("velocity"), "{doubled}");
        assert_eq!(doubled["frameId"], json!(0), "{doubled}");
        assert!(doubled.get("expression}: ").is_none(), "{doubled}");
        check_ok("godot_debug", "evaluate", doubled);

        // The parameter is absent, so there is something for the caller to write and the refusal
        // says so rather than the key quietly going away.
        let mut absent = json!({"frameId": 0});
        absent["expression}: "] = json!(", ");
        repair("godot_debug", "evaluate", &mut absent);
        assert!(absent.get("expression}: ").is_some(), "{absent}");
        let refused = message("godot_debug", "evaluate", absent);
        assert!(refused.contains("requires `expression`"), "{refused}");

        // And the parameter that tore away is an optional one, so nothing required is missing and
        // the call would go through without it — under a name nobody asked for. Observed live:
        // `godot_node instantiate` with `parent` and `path` intact and `name": ` over a comma.
        // Still a refusal, still without quoting the key.
        let mut optional = json!({"parent": "/Game", "path": "res://enemy.tscn"});
        optional["name\": "] = json!(", ");
        let torn = check("godot_node", "instantiate", &optional).expect_err("refused");
        assert_eq!(torn.code, "torn_param", "{}", torn.message);
        assert!(
            torn.message.contains("lost `name` to a torn key")
                && !torn.message.contains("name\": "),
            "{}",
            torn.message
        );
    }

    /// A refusal does not read a torn key's wreckage back into the conversation.
    ///
    /// Observed live, three times running: the key opened `size=[32, 64]}]` and went on for
    /// another eighty characters of the model's own harness tags — closing `parameter`, `function`
    /// and `tool_call` markers, inside its own JSON, followed by a sentence about fixing the
    /// syntax and a fresh opening tag. The refusal quoted every one of them back.
    /// The head is what says a key tore; the tail is the part not to repeat.
    #[test]
    fn a_refusal_quotes_the_head_of_a_torn_key_and_not_its_wreckage() {
        let mut wrecked = json!({"path": "a.tres", "shapeType": "RectangleShape2D"});
        let key = "size=[32, 64]}]'</parameter>]</parameter>></function></tool_call></parameter>   \
                   Let me fix the syntax. <tool_call>1;0;0}{";
        wrecked[key] = json!(1);
        let refused = message("godot_resource", "create_shape", wrecked);
        assert!(
            refused.contains("size=[32, 64]"),
            "the head is the evidence: {refused}"
        );
        assert!(
            !refused.contains("</function>"),
            "and the tail is not: {refused}"
        );
        assert!(refused.contains('…'), "{refused}");
    }

    /// Two calls that ran into each other are refused, not renamed onto a parameter that fits.
    ///
    /// Observed live, three times running: `{"op": "create_shape", "path": …, "shapeType":
    /// "RectangleShape2D", "size\": [32, 32]}]edits": [ …a scene's worth of edits… ]}`. The key
    /// reads as `size`, and what came with it was a list — which is exactly what `size` takes — so
    /// the rename fired, the gate passed it, and the addon answered "A RectangleShape2D takes size
    /// as two numbers" about a call whose real `[32, 32]` was sitting inside the key. The turn gave
    /// up and hand-wrote the `.tres` with the file tools, twice, getting the syntax wrong the first
    /// time and running the game into a parse error.
    #[test]
    fn two_calls_that_ran_into_each_other_are_refused_rather_than_renamed() {
        let mut merged = json!({
            "path": "assets/player_shape.tres",
            "shapeType": "RectangleShape2D"
        });
        merged["size\": [32, 32]}]edits"] = json!([{"newText": "[gd_scene load_steps=5]"}]);
        repair("godot_resource", "create_shape", &mut merged);
        assert!(
            merged.get("size").is_none(),
            "another call's list must not be renamed onto `size`: {merged}"
        );
        let refused = check("godot_resource", "create_shape", &merged).expect_err("refused");
        assert_eq!(refused.code, "unknown_param", "{}", refused.message);
        assert!(
            refused.message.contains("Did you mean `size`?"),
            "the hint still names what it read as: {}",
            refused.message
        );
        // And what arrived under the key, which is the line that tells a model its object tore
        // rather than that it picked a wrong word. Measured: 0 of 15 recoveries without it,
        // 15 of 15 with it.
        assert!(
            refused.message.contains("It arrived carrying"),
            "the refusal quotes the scrap that arrived: {}",
            refused.message
        );

        // A stray colon still is a stray colon: the key holds nothing past the name but punctuation
        // and the value is intact, so the rename is still the right answer.
        let mut colon = json!({"shapeType": "RectangleShape2D"});
        colon["path:"] = json!("assets/player_shape.tres");
        repair("godot_resource", "create_shape", &mut colon);
        assert_eq!(colon["path"], json!("assets/player_shape.tres"), "{colon}");
    }

    /// A tear that took the value with it is answered with what is missing, not with the wreckage.
    ///
    /// Observed live, thirteen times running in one turn: `{"name": "Enemy", "op": "instantiate",
    /// "parent": ": ", "}` — the key holding the parameter's own name and a quote and a colon, the
    /// value holding a comma. The refusal named that key back, and the model, which had written no
    /// such key it could see, resent the identical call thirteen times before abandoning the
    /// operation and hand-writing the resource with the file tools.
    ///
    /// The counter-case is the one right above it and is not changed: a key that still carries the
    /// value the line lost is named back, because that is what tells a model where its value went.
    #[test]
    fn a_tear_that_took_the_value_is_answered_with_what_is_missing() {
        let mut torn = json!({"name": "Enemy"});
        torn["parent\": "] = json!(", ");
        let refused = message("godot_node", "instantiate", torn);
        assert!(
            refused.contains("requires `parent`") && refused.contains("One key arrived torn"),
            "the refusal has to lead with what the call needs: {refused}"
        );
        assert!(
            !refused.contains("parent\": "),
            "and must not hand the wreckage back: {refused}"
        );
        assert!(
            refused.contains("This one carries name."),
            "the keys that did survive are still named: {refused}"
        );
    }

    /// A key that tore is renamed only when the value beside it survived the tear.
    ///
    /// Observed live, twice in one turn and then a third time: `{"op": "create_shape", "path": …,
    /// "shapeType": "RectangleShape2D", "size)": false}`. `size)` reads as `size`, so the rename
    /// fired and the refusal became ``\`size\` takes an array, and this one was false`` — about a
    /// key the model had never written. It resent the identical call, then gave up on the operation
    /// and hand-wrote the `.tres` with the file tools, which is the door this one exists to close.
    ///
    /// A torn key whose value did survive is still renamed: that is the whole point of the rule,
    /// and `nameSettings` for `name` is the case it was built for.
    #[test]
    fn a_key_that_tore_is_renamed_only_when_its_value_survived() {
        let mut torn = json!({
            "path": "scenes/enemy_shape.tres",
            "shapeType": "RectangleShape2D",
            "size)": false
        });
        repair("godot_resource", "create_shape", &mut torn);
        assert!(
            torn.get("size).").is_none() && torn.get("size").is_none(),
            "a torn key over a value that cannot be a size must not be renamed onto it: {torn}"
        );
        let refused = message("godot_resource", "create_shape", torn);
        assert!(
            refused.contains("`size)`") && refused.contains("write the whole call again"),
            "the refusal has to name the key that arrived: {refused}"
        );

        // The value survived the tear, so the rename is still the right answer.
        let mut readable = json!({
            "path": "scenes/enemy_shape.tres",
            "shapeType": "RectangleShape2D",
            "size)": [32, 32]
        });
        repair("godot_resource", "create_shape", &mut readable);
        assert_eq!(readable["size"], json!([32, 32]), "{readable}");
    }

    /// The erase entry `set_cells` documents is one the gate lets through.
    ///
    /// An entry with no `atlas` erases the cells it covers — the catalogue says so, the addon's own
    /// refusal sentence says so, and `the_addon_authors_a_whole_subtree_in_one_call`'s sibling in
    /// `godot_addon_acceptance` drives it against a real editor. None of those is the door a model
    /// comes through. This table had `atlas` required, so the one call that digs the gap Mario falls
    /// down was refused before it reached the socket, and the addon test passed the whole time
    /// because it speaks to the addon directly.
    #[test]
    fn an_entry_that_erases_carries_no_atlas_and_is_accepted() {
        check_ok(
            "godot_node",
            "set_cells",
            json!({
                "node": "/level/Terrain",
                "cells": [{"x": 10, "y": 12, "width": 2, "height": 2}]
            }),
        );
        // The pair itself is still a pair: an `atlas` that is present has to be one.
        assert!(
            message(
                "godot_node",
                "set_cells",
                json!({"node": "/level/Terrain", "cells": [{"x": 0, "y": 0, "atlas": 3}]}),
            )
            .contains("atlas"),
        );
    }

    /// A key that could only have meant one parameter is put onto it, and one that could have
    /// meant two is not.
    ///
    /// `nameSettings` for `name` is a live turn's own mistake, made nineteen times in one turn —
    /// a third of everything it did — each answered with ``Did you mean `name`?`` and each resent
    /// unchanged. `tile` is the counter-case the catalogue actually holds: `create_tileset` takes
    /// both `tileSize` and `tiles`, so `tile` names neither and stays for `check` to refuse.
    /*
     * A whole `'name': 'value',` fragment that tore into a key is put back as both.
     *
     * `only_one_meaning` renames a torn key only when the value *beside* it carries a letter or a
     * digit — otherwise `"name': ": ", "` registers an autoload called `, `. This is the case that
     * rule cannot reach: the value is inside the key, not beside it. One live turn building a large
     * project met it thirteen times — six `set_cells`, four `set_property`, three `create` — each
     * key carrying the node path the call was about, with `", "` as its value.
     */
    #[test]
    fn a_pair_that_tore_into_its_key_is_put_back() {
        let mut torn = json!({
            "node': '/GameLevel/Ground', ": ", ",
            "cells": [{"x": 0, "y": 0, "atlas": [0, 0]}]
        });
        repair("godot_node", "set_cells", &mut torn);
        assert_eq!(torn["node"], json!("/GameLevel/Ground"), "{torn}");
        assert!(torn.get("node': '/GameLevel/Ground', ").is_none(), "{torn}");
        check_ok("godot_node", "set_cells", torn);

        // Both halves of one call, and a `create` shape from the same turn.
        let mut two = json!({
            "parent': '/GameLevel', ": ", ",
            "type": "Node2D",
            "name": "Pickups"
        });
        repair("godot_node", "create", &mut two);
        assert_eq!(two["parent"], json!("/GameLevel"), "{two}");
        check_ok("godot_node", "create", two);

        // Nothing to recover: no value inside the key, so these stay refused — which is the rule
        // `only_one_meaning` already gets right. `null` and `false` are words rather than values
        // here, and a word inside a torn key is far more likely to be the next key's wreckage.
        for (op, key) in [
            ("set_cells", "node': null, "),
            ("create", "parent**: false, "),
        ] {
            let mut hopeless = json!({key.to_owned(): ", "});
            repair("godot_node", op, &mut hopeless);
            assert!(
                hopeless.get(key).is_some(),
                "{key} must not be recovered: {hopeless}"
            );
        }

        // A name that is not a parameter of this operation is not one to put back.
        let mut elsewhere = json!({"nonesuch': '/A', ": ", "});
        repair("godot_node", "set_cells", &mut elsewhere);
        assert!(elsewhere.get("nonesuch': '/A', ").is_some(), "{elsewhere}");

        // A parameter already carrying a value is not overwritten by a fragment.
        let mut held = json!({"node': '/Wrong', ": ", ", "node": "/Right",
                              "cells": [{"x": 0, "y": 0, "atlas": [0, 0]}]});
        repair("godot_node", "set_cells", &mut held);
        assert_eq!(held["node"], json!("/Right"), "{held}");

        // And a parameter that does not take a string is left alone: the fragment carries text.
        let mut wrong_kind = json!({"index': '3', ": ", ", "parent": "/A", "type": "Node2D",
                                    "name": "N"});
        repair("godot_node", "create", &mut wrong_kind);
        assert!(wrong_kind.get("index").is_none(), "{wrong_kind}");
    }

    /*
     * A lone value in a list is the value, in a box.
     *
     * Watched live in one turn building a large project: `godot_node add_to_group `node` takes a
     * string, and this one was an array of 1` — four times, and once more for `set_cells`. Every one
     * held the single node path the call was about.
     */
    #[test]
    fn a_lone_value_in_a_list_comes_out_of_it() {
        let mut boxed = json!({"node": ["/Player"], "group": "players"});
        repair("godot_node", "add_to_group", &mut boxed);
        assert_eq!(boxed, json!({"node": "/Player", "group": "players"}));
        check_ok("godot_node", "add_to_group", boxed);

        // Two is a shape, not a box: nothing is chosen between them.
        let mut two = json!({"node": ["/A", "/B"], "group": "players"});
        repair("godot_node", "add_to_group", &mut two);
        assert_eq!(two["node"], json!(["/A", "/B"]), "{two}");
        assert!(message("godot_node", "add_to_group", two).contains("`node`"));

        // One of the wrong kind is not the value at all.
        let mut wrong = json!({"node": [7], "group": "players"});
        repair("godot_node", "add_to_group", &mut wrong);
        assert_eq!(wrong["node"], json!([7]), "{wrong}");

        // A parameter that takes a list itself keeps it. `godot_resource rescan` takes one path or
        // several on purpose, and unwrapping there would change what was asked.
        let mut listed = json!({"path": ["res://a.png"]});
        repair("godot_resource", "rescan", &mut listed);
        assert_eq!(listed["path"], json!(["res://a.png"]), "{listed}");
        check_ok("godot_resource", "rescan", listed);

        // And an entry inside a list is repaired the same way, because `repair_set` walks in.
        let mut nested = json!({
            "properties": [{"node": ["/Player"], "property": "position",
                            "value": {"type": "vector2", "value": [1, 2]}}]
        });
        repair("godot_node", "set_properties", &mut nested);
        assert_eq!(
            nested["properties"][0]["node"],
            json!("/Player"),
            "{nested}"
        );
    }

    #[test]
    fn a_key_that_can_only_have_meant_one_parameter_is_put_onto_it() {
        let mut written = json!({
            "nameSettings": "SettingsManager",
            "path": "res://scripts/settings_manager.gd",
            "enabled": true
        });
        repair("godot_project", "set_autoload", &mut written);
        assert_eq!(
            written,
            json!({
                "name": "SettingsManager",
                "path": "res://scripts/settings_manager.gd",
                "enabled": true
            })
        );
        check_ok("godot_project", "set_autoload", written);

        // Two parameters it could have been is not one, so nothing moves and the refusal stands.
        let mut ambiguous = json!({"path": "res://t.tres", "texture": "res://t.png", "tile": 16});
        repair("godot_resource", "create_tileset", &mut ambiguous);
        assert_eq!(ambiguous["tile"], json!(16), "{ambiguous}");
        assert!(
            message("godot_resource", "create_tileset", ambiguous).contains("`tile`"),
            "an ambiguous key is still refused by name"
        );

        // A parameter already written is never overwritten by a near miss for it.
        let mut both = json!({"name": "Real", "nameSettings": "Other", "path": "res://a.gd"});
        repair("godot_project", "set_autoload", &mut both);
        assert_eq!(both["name"], json!("Real"));
        assert_eq!(both["nameSettings"], json!("Other"));

        // A torn key whose value survived is put back: `"path:": "scripts/main.gd"` is a stray
        // colon on the key and an intact path beside it. A live debugger turn wrote this three
        // times in a row and was refused three times.
        let mut colon = json!({"line": 13});
        colon["path:"] = json!("scripts/main.gd");
        repair("godot_debug", "breakpoint_locations", &mut colon);
        assert_eq!(colon["path"], json!("scripts/main.gd"), "{colon}");
        check_ok("godot_debug", "breakpoint_locations", colon);

        // The same tear with double quotes, which is what a model writes when its JSON comes apart:
        // the key carries the quote and the comma from the line it lost, and its value is the
        // wreckage. Five of these in the recordings. What must never happen is the *key* being
        // renamed onto `method`, which would register `", "` as the method and call it a
        // well-formed call; the value inside the key is the one the caller meant, and it is put
        // back with the wreckage discarded.
        let mut torn = json!({"signal": "coin_collected", "binds": []});
        torn["method\": \"_on_coin_collected\", "] = json!(", ");
        repair("godot_node", "connect_signal", &mut torn);
        assert_eq!(torn["method"], json!("_on_coin_collected"), "{torn}");
        assert!(
            torn.get("method\": \"_on_coin_collected\", ").is_none(),
            "{torn}"
        );

        // A number tears the same way and is put back the same way. Watched live twice in one turn,
        // under a value made entirely of the harness's own closing tags.
        let mut numeric = json!({"expression": "velocity"});
        numeric["frameId': 0}, {"] = json!(": 0}]}]'</parameter></function>");
        repair("godot_debug", "evaluate", &mut numeric);
        assert_eq!(numeric["frameId"], json!(0), "{numeric}");
        check_ok("godot_debug", "evaluate", numeric);

        // An ordinary typo is a word, and there the near-miss hint is the right answer on its own.
        let typo = json!({"nameSettings": "A", "path": "res://a.gd", "name": "Taken"});
        let hinted = message("godot_project", "set_autoload", typo);
        assert!(hinted.contains("Did you mean `name`?"), "{hinted}");
        assert!(!hinted.contains("It arrived carrying"), "{hinted}");

        // Two wrong keys that both read as the same parameter are two answers, so neither moves.
        let mut contested = json!({"nameSettings": "A", "nameOfIt": "B", "path": "res://a.gd"});
        repair("godot_project", "set_autoload", &mut contested);
        assert_eq!(contested["nameSettings"], json!("A"), "{contested}");
        assert_eq!(contested["nameOfIt"], json!("B"), "{contested}");
        assert!(contested.get("name").is_none(), "{contested}");

        // Inside an entry of a list parameter, at the position that entry declares.
        let mut nested = json!({
            "files": [{"pathName": "scripts/a.gd", "edits": [{"oldText": "a", "newText": "b"}]}]
        });
        repair("godot_script", "edit", &mut nested);
        assert_eq!(nested["files"][0]["path"], json!("scripts/a.gd"));
        check_ok("godot_script", "edit", nested);
    }

    /// The failure this whole module exists for. The old answer was
    /// `A resource value requires an object carrying a path`, which a model read eight times
    /// without changing anything, because it never showed the wrapper or repeated the path.
    #[test]
    fn a_resource_written_as_a_string_is_answered_with_the_corrected_call() {
        let refused = message(
            "godot_node",
            "set_property",
            json!({
                "node": "/Player",
                "property": "script",
                "value": {"type": "resource", "value": "res://scripts/player.gd"},
                "expectedRevision": 1
            }),
        );
        assert!(
            refused.contains(
                "Send {\"type\": \"resource\", \"value\": {\"path\": \"res://scripts/player.gd\"}}."
            ),
            "the correction must carry the model's own path: {refused}"
        );
        assert!(
            refused.contains("the string \"res://scripts/player.gd\""),
            "the failure must repeat what arrived: {refused}"
        );
    }

    /// The call a live turn actually wrote: five files, each nested inside the previous file's
    /// `edits` instead of standing beside it in `files`. It was answered `missing field oldText`,
    /// which names no operation, no parameter and no position — serde was the first thing to look
    /// inside a `list`, because the kind stops at the outermost bracket.
    #[test]
    fn a_nested_entry_is_refused_where_it_sits_rather_than_by_serde() {
        let refused = message(
            "godot_script",
            "edit",
            json!({
                "files": [{
                    "path": "scripts/game.gd",
                    "edits": [
                        {"oldText": "old", "newText": "new"},
                        {"path": "scripts/enemy.gd", "edits": [{"oldText": "a", "newText": "b"}]}
                    ]
                }]
            }),
        );
        assert!(
            refused.contains("`files[0].edits[1]` has no `edits` key"),
            "the failure must name the entry that is wrong: {refused}"
        );
        assert!(
            refused.contains("{oldText: text, newText: text}"),
            "the failure must show what an entry takes: {refused}"
        );
    }

    /// `apply_rename` takes the same parameter name as `edit` and a different shape behind it, and
    /// for a while it declared no shape at all. Nothing checked it: the schema widened to a bare
    /// list that swallowed `edit`'s strict branch, and [`check_inside`] returns early on an empty
    /// entry — so `{"nope": 1}` was accepted by both layers and serde was the first thing to look.
    ///
    /// That is the refusal [`check_inside`] exists to replace, so the entry is declared and this
    /// holds it. `scripts/check-command-surface.mjs` refuses the omission returning.
    #[test]
    fn a_rename_plan_is_checked_rather_than_waved_through() {
        check_ok(
            "godot_script",
            "apply_rename",
            json!({"files": [{
                "path": "a.gd",
                "originalText": "x",
                "originalHash": "h",
                "updatedText": "y"
            }]}),
        );
        let refused = message(
            "godot_script",
            "apply_rename",
            json!({"files": [{"nope": 1}]}),
        );
        assert!(
            refused.contains("`files[0]`"),
            "the failure must name the entry that is wrong: {refused}"
        );
        let partial = message(
            "godot_script",
            "apply_rename",
            json!({"files": [{"path": "a.gd", "originalText": "x", "originalHash": "h"}]}),
        );
        assert!(
            partial.contains("requires `updatedText`"),
            "a plan missing a field must say which: {partial}"
        );
    }

    /// `set_input_action` takes the same `events` name `runtime.input` takes in another domain,
    /// and for a while it declared no shape at all: the schema advertised a bare list and
    /// [`check_inside`] returns early on one, so `{"nope": 1}` crossed the socket and the
    /// editor's decoder was the first thing to look. The editor's decoder takes three kinds —
    /// the game's takes five — so the entry names the three, and this holds them.
    #[test]
    fn an_input_action_event_is_checked_rather_than_waved_through() {
        check_ok(
            "godot_project",
            "set_input_action",
            json!({"name": "move_left", "events": [
                {"kind": "key", "key": "Left"},
                {"kind": "mouse_button", "button": 1},
                {"kind": "joypad_button", "button": 5}
            ]}),
        );
        let refused = message(
            "godot_project",
            "set_input_action",
            json!({"name": "move_left", "events": [{"nope": 1}]}),
        );
        assert!(
            refused.contains("`events[0]`"),
            "the failure must name the entry that is wrong: {refused}"
        );
        let partial = message(
            "godot_project",
            "set_input_action",
            json!({"name": "jump", "events": [{"key": "Space"}]}),
        );
        assert!(
            partial.contains("requires `kind`"),
            "an event missing its kind must say which: {partial}"
        );
    }

    /// The nesting is printed as deeply as it goes, because the signature is where a model reads
    /// the contract — the same measurement that put kinds there in the first place.
    #[test]
    fn the_signature_carries_the_shape_inside_a_list() {
        assert_eq!(
            signature(params_of("godot_script", "edit").expect("edit declares its parameters")),
            "{files: list of {path: text, edits: list of {oldText: text, newText: text}}}"
        );
    }

    /// A list of one scalar kind says so, and refuses an entry that is not one, by position.
    ///
    /// `entry` can only say what an *object* entry holds, so `properties: list` was the whole of
    /// what `node.inspect` could have declared — and a name that means a list of objects in one
    /// operation of a domain and a bare list in another widens the generated schema to an array
    /// that swallows the strict branch. `everyMergedNameDeclaresItsShape` refuses that outright,
    /// so a list of strings had no way to be declared beside `set_properties`' list of objects.
    #[test]
    fn a_list_of_one_kind_says_which_and_refuses_the_entry_that_is_not_it() {
        assert_eq!(
            signature(params_of("godot_node", "inspect").expect("inspect declares its parameters")),
            "{node: text, properties?: list of text}"
        );
        check_ok(
            "godot_node",
            "inspect",
            json!({"node": "/Main/Label", "properties": ["text", "position"]}),
        );
        // Naming none of them is still the whole list, so the narrowing is not a second operation.
        check_ok("godot_node", "inspect", json!({"node": "/Main/Label"}));

        // The position is in the refusal, for the reason every other entry check carries one: the
        // caller has to know which of the names it wrote is the one that is not a name.
        let refused = message(
            "godot_node",
            "inspect",
            json!({"node": "/Main/Label", "properties": ["text", {"name": "position"}]}),
        );
        assert!(
            refused.contains("properties[1]") && refused.contains("a string"),
            "the entry that is not a string must be named by its position: {refused}"
        );
        // And the bracket itself is still checked.
        assert!(
            message(
                "godot_node",
                "inspect",
                json!({"node": "/x", "properties": "text"})
            )
            .contains("a list of a string"),
            "a list of strings written as one string must be refused"
        );
    }

    #[test]
    fn an_entry_shape_accepts_the_call_it_describes() {
        check_ok(
            "godot_script",
            "edit",
            json!({"files": [{"path": "a.gd", "edits": [{"oldText": "x", "newText": "y"}]}]}),
        );
        check_ok(
            "godot_node",
            "set_properties",
            json!({
                "properties": [
                    {"node": "/Player", "property": "position",
                     "value": {"type": "vector2", "value": [1, 2]}}
                ],
                "expectedRevision": 3
            }),
        );
        // A tagged value inside an entry is checked as one, and says where it was.
        let refused = message(
            "godot_node",
            "set_properties",
            json!({
                "properties": [{"node": "/Player", "property": "script",
                                "value": {"type": "resource", "value": "res://a.gd"}}]
            }),
        );
        assert!(
            refused.contains("`properties[0].value`"),
            "a tagged value inside a list must name its position: {refused}"
        );
    }

    #[test]
    fn the_shape_the_addon_accepts_is_the_shape_this_accepts() {
        check_ok(
            "godot_node",
            "set_property",
            json!({
                "node": "/Player",
                "property": "script",
                "value": {"type": "resource", "value": {"path": "res://scripts/player.gd"}},
                "expectedRevision": 1
            }),
        );
        check_ok(
            "godot_node",
            "set_property",
            json!({
                "node": "/Player/Sprite2D",
                "property": "region_rect",
                "value": {"type": "rect2", "value": [112, 0, 16, 16]},
                "expectedRevision": 2
            }),
        );
    }

    #[test]
    fn a_missing_parameter_names_itself_and_the_whole_shape() {
        let refused = message(
            "godot_node",
            "set_property",
            json!({"node": "/Player", "value": {"type": "int", "value": 1}, "expectedRevision": 1}),
        );
        assert!(refused.contains("requires `property`"), "{refused}");
        // `expectedRevision` is accepted here and absent from the shape: the router supplies it,
        // and a refusal that names it teaches the model to start carrying one.
        assert!(
            refused.contains("{node: text, property: text, value: tagged}"),
            "{refused}"
        );
        // And what did arrive, which is the difference between the two shapes rather than the
        // absence of one key.
        assert!(
            refused.contains("This one carries expectedRevision, node, value."),
            "{refused}"
        );
    }

    /*
     * A missing parameter names the keys that were sent instead.
     *
     * `godot_script edit \`files[0]\` requires \`path\`` is the second commonest refusal in the
     * recorded live turns and was the only frequent one saying nothing about what arrived. Three
     * separate turns in three separate sessions hit it, and not one of their traces can say what
     * shape they wrote.
     */
    #[test]
    fn a_missing_parameter_names_what_did_arrive() {
        // The shape three live turns actually wrote: the edits in place and the path somewhere
        // else. Every key it does carry is one the entry takes, so nothing else in the refusal
        // says what is different about it.
        let pathless = message(
            "godot_script",
            "edit",
            json!({"files": [{"edits": [{"oldText": "var a := 1", "newText": "var a := 2"}]}]}),
        );
        assert!(
            pathless.contains("`files[0]` requires `path`"),
            "{pathless}"
        );
        assert!(pathless.contains("This one carries edits."), "{pathless}");

        // An empty object says so rather than listing nothing.
        let empty = message("godot_script", "edit", json!({"files": [{}]}));
        assert!(empty.contains("This one is empty."), "{empty}");

        // A wide object is counted rather than recited, and a key long enough to be wreckage is
        // cut: a refusal is not the place to hand a torn call back in full.
        let mut wide = serde_json::Map::new();
        for index in 0..13 {
            wide.insert(format!("k{index:02}"), json!(1));
        }
        let counted = super::what_it_carries(&wide);
        assert!(counted.contains("and 5 more."), "{counted}");

        let mut torn = serde_json::Map::new();
        torn.insert("x".repeat(120), json!(1));
        let cut = super::what_it_carries(&torn);
        assert!(cut.contains('…'), "{cut}");
        assert!(!cut.contains(&"x".repeat(120)), "{cut}");
    }

    #[test]
    fn a_name_that_is_not_accepted_is_refused_with_the_nearest_one() {
        let refused = message(
            "godot_node",
            "create",
            json!({
                "parent": "/Level",
                "type": "Sprite2D",
                "name": "Coin",
                "nodeIndex": 2,
                "expectedRevision": 1
            }),
        );
        assert!(
            refused.contains("has no `nodeIndex` parameter"),
            "{refused}"
        );
    }

    #[test]
    fn a_wrong_arity_names_the_count_it_wanted() {
        let refused = message(
            "godot_node",
            "set_property",
            json!({
                "node": "/Player",
                "property": "position",
                "value": {"type": "vector2", "value": [12]},
                "expectedRevision": 1
            }),
        );
        assert!(refused.contains("an array of 2 numbers"), "{refused}");
    }

    /// The shape the correction could not stop, repaired instead.
    ///
    /// Every value here was written by a live turn against a local Qwen3.6-27B driving a real
    /// editor: a vector2 and a float on `set_property`, a vector2 inside `set_properties`.
    #[test]
    fn a_vector_written_as_an_object_is_repaired_before_it_is_checked() {
        let mut one = json!({
            "node": "/Main/Player",
            "property": "position",
            "value": {"type": "vector2", "value": {"x": 32, "y": 48}}
        });
        repair("godot_node", "set_property", &mut one);
        assert_eq!(one["value"], json!({"type": "vector2", "value": [32, 48]}));
        assert!(check("godot_node", "set_property", &one).is_ok());

        // Inside a list parameter's entries, and beside an entry that was already right.
        let mut listed = json!({
            "properties": [
                {
                    "node": "/Main/Floor",
                    "property": "position",
                    "value": {"type": "vector2", "value": {"x": 0, "y": -100}}
                },
                {
                    "node": "/Main/Floor",
                    "property": "visible",
                    "value": {"type": "bool", "value": true}
                }
            ]
        });
        repair("godot_node", "set_properties", &mut listed);
        assert_eq!(
            listed["properties"][0]["value"],
            json!({"type": "vector2", "value": [0, -100]})
        );
        assert_eq!(
            listed["properties"][1]["value"],
            json!({"type": "bool", "value": true})
        );
        assert!(check("godot_node", "set_properties", &listed).is_ok());

        // A colour, whose four names are the other order the table knows.
        let mut colour = json!({
            "node": "/Main/Player",
            "property": "modulate",
            "value": {"type": "color", "value": {"r": 1, "g": 0.5, "b": 0.25, "a": 1}}
        });
        repair("godot_node", "set_property", &mut colour);
        assert_eq!(
            colour["value"],
            json!({"type": "color", "value": [1, 0.5, 0.25, 1]})
        );
    }

    /// The kind word, written back into the value.
    ///
    /// A model that reads `value: tagged` and the kind beside it wrote
    /// `{"type": "float", "value": {"number": 3.5}}` and `{"type": "string", "value": {"text": …}}`
    /// eight times in one live turn — the protocol's own words for those kinds, used as a key.
    #[test]
    fn a_scalar_written_in_a_box_is_taken_out_of_it() {
        let boxed = |value: Value| {
            let mut written =
                json!({"node": "/Main/Player", "property": "rotation", "value": value});
            repair("godot_node", "set_property", &mut written);
            written["value"].clone()
        };
        assert_eq!(
            boxed(json!({"type": "float", "value": {"number": 3.5}})),
            json!({"type": "float", "value": 3.5})
        );
        assert_eq!(
            boxed(json!({"type": "string", "value": {"text": "Coin"}})),
            json!({"type": "string", "value": "Coin"})
        );
        assert_eq!(
            boxed(json!({"type": "bool", "value": {"value": true}})),
            json!({"type": "bool", "value": true})
        );

        // One entry, and of the type the tag wants. Two entries is a shape, and one entry of the
        // wrong type is not the value in a box — both are left for the refusal to name.
        for wrong in [
            json!({"type": "float", "value": {"number": 3.5, "unit": "degrees"}}),
            json!({"type": "float", "value": {"number": "3.5"}}),
        ] {
            assert_eq!(boxed(wrong.clone()), wrong);
        }
    }

    /// Everything the table cannot order is left exactly as it arrived, for `check` to refuse.
    ///
    /// The same run wrote `an object holding x` for a float and `an object holding origin, x, y`
    /// for a transform2d. Neither is a vector written under names; both are the model inventing a
    /// shape, and a guess at what it meant would be worse than the sentence that names it.
    #[test]
    fn a_value_nobody_can_order_is_left_for_the_refusal_to_name() {
        for (property, value) in [
            (
                "transform",
                json!({"type": "transform2d", "value": {"origin": [0, 0], "x": [1, 0], "y": [0, 1]}}),
            ),
            (
                "rect",
                json!({"type": "rect2", "value": {"top": 0, "left": 1, "width": 2, "height": 3}}),
            ),
        ] {
            let mut written = json!({"node": "/Main/Player", "property": property, "value": value});
            let before = written.clone();
            repair("godot_node", "set_property", &mut written);
            assert_eq!(written, before, "{property}");
            assert!(
                check("godot_node", "set_property", &written).is_err(),
                "{property}"
            );
        }

        // And a value that was already right is not touched.
        let mut right = json!({
            "node": "/Main/Player",
            "property": "script",
            "value": {"type": "resource", "value": {"path": "res://scripts/player.gd"}}
        });
        let before = right.clone();
        repair("godot_node", "set_property", &mut right);
        assert_eq!(right, before);
    }

    /// A live run wrote `{"x": 32, "y": 32}` for a vector2 thirteen times and was refused thirteen
    /// times. The sentence said what was wanted and never what to send, so the numbers it already
    /// had were never handed back to it in the right shape.
    ///
    /// An agent call no longer reaches this: [`repair`] runs first and the value is already an
    /// array by the time `check` sees it. The sentence is still what the renderer and the addon's
    /// own backstop answer with, and it is still what a shape the repair declines comes back as.
    #[test]
    fn a_vector_written_as_an_object_is_refused_with_the_value_it_should_have_sent() {
        let refused = message(
            "godot_node",
            "set_property",
            json!({
                "node": "/Player",
                "property": "position",
                "value": {"type": "vector2", "value": {"x": 32, "y": 48}}
            }),
        );
        assert!(refused.contains("an object holding x, y"), "{refused}");
        assert!(
            refused.contains(r#"Send {"type": "vector2", "value": [32, 48]}"#),
            "{refused}"
        );

        // The numbers keep the form they were written in, because a model comparing its own call
        // against the correction should find its own numbers in it.
        let colour = message(
            "godot_node",
            "set_property",
            json!({
                "node": "/Player",
                "property": "modulate",
                "value": {"type": "color", "value": {"r": 1, "g": 0.5, "b": 0.25, "a": 1}}
            }),
        );
        assert!(
            colour.contains(r#"Send {"type": "color", "value": [1, 0.5, 0.25, 1]}"#),
            "{colour}"
        );
    }

    /// Only where the order is not a guess. Four numbers under four names that are not a colour or
    /// a vector could be a rect2 in either order, so nothing is offered rather than the wrong thing.
    #[test]
    fn numbers_under_names_nobody_can_order_are_left_without_a_correction() {
        let refused = message(
            "godot_node",
            "set_property",
            json!({
                "node": "/Player",
                "property": "rect",
                "value": {"type": "rect2", "value": {"top": 0, "left": 1, "width": 2, "height": 3}}
            }),
        );
        assert!(refused.contains("an array of 4 numbers"), "{refused}");
        assert!(!refused.contains("Send {"), "{refused}");
    }

    /// `godot_scene reload` declares one parameter and it is hidden, so its signature is empty and
    /// the sentence read `It takes .` — which is what a live run was sent.
    #[test]
    fn an_operation_with_nothing_to_take_says_so_rather_than_trailing_off() {
        let refused = message("godot_scene", "reload", json!({"scene": "res://main.tscn"}));
        assert!(refused.contains("It takes no parameters."), "{refused}");
        assert!(!refused.contains("It takes ."), "{refused}");
    }

    /// The near miss must not point at a parameter the prompt tells the model never to pass. A live
    /// run wrote a key that was not one at all and was answered `Did you mean `expectedRevision`?`.
    #[test]
    fn the_nearest_name_is_never_one_the_model_is_told_not_to_send() {
        let refused = message(
            "godot_node",
            "create",
            json!({
                "parent": "/Level",
                "type": "Sprite2D",
                "name": "Coin",
                "expectedRevisio": 1
            }),
        );
        assert!(refused.contains("has no `expectedRevisio`"), "{refused}");
        assert!(!refused.contains("Did you mean"), "{refused}");
    }

    #[test]
    fn a_tag_that_does_not_exist_lists_the_ones_that_do() {
        let refused = message(
            "godot_project",
            "set_setting",
            json!({"name": "display/window/size/viewport_width", "value": {"type": "number", "value": 1152}}),
        );
        assert!(
            refused.contains("`number` is not a value type"),
            "{refused}"
        );
        assert!(refused.contains("vector2"), "{refused}");
    }

    #[test]
    fn a_bare_value_where_a_tagged_one_belongs_shows_the_tag() {
        let refused = message(
            "godot_project",
            "set_setting",
            json!({"name": "display/window/size/viewport_width", "value": 1152}),
        );
        assert!(refused.contains("a tagged value like"), "{refused}");
        assert!(refused.contains("the number 1152"), "{refused}");
    }

    #[test]
    fn timeout_is_accepted_everywhere_without_being_declared() {
        check_ok("godot_scene", "get_tree", json!({"timeoutMs": 5_000}));
    }

    /// An operation with no table is unchecked, and that has to stay visible: absence must never be
    /// read as "this operation takes nothing".
    #[test]
    fn an_operation_without_a_table_is_not_refused() {
        check_ok("godot_script", "open", json!({"path": "scripts/mario.gd"}));
        check_ok("godot_node", "set_property", json!("not an object"));
    }

    /// The whole catalogue, with no exceptions list.
    ///
    /// The first cut of this file covered four domains and left five to serde, which read as a
    /// reasonable division and was not one: `expectedHash` lives in one of the five, a model
    /// copied sixty-three of its sixty-four characters, and nothing between it and the filesystem
    /// counted them. A schema with a hole in it is not a schema, so there is no hole and no way to
    /// add one — an operation reaches the model only through `CATALOG`, and every entry of it has
    /// to be declared here.
    ///
    /// It cannot be missed any more: an operation *is* one of these rows, so there is no second
    /// list to add one to. What is left to check is that the row says something — a row reaching
    /// the model with no prose is an operation it is told the name of and nothing else, which is
    /// the one thing this catalogue may not be.
    #[test]
    fn every_catalog_operation_declares_its_parameters() {
        let mute: Vec<String> = CATALOG
            .iter()
            .flat_map(|domain| {
                domain
                    .operations
                    .iter()
                    .filter(|operation| {
                        params_of(domain.name, operation.op).is_none()
                            || operation.summary.trim().is_empty()
                    })
                    .map(move |operation| format!("{} {}", domain.name, operation.op))
            })
            .collect();
        assert!(
            mute.is_empty(),
            "these operations reach the model with no contract and nothing said about them:\n{}",
            mute.join("\n")
        );
    }

    /// Every declared operation is offered by the domain it names, so a domain cannot be handed
    /// another domain's rows.
    ///
    /// A list nobody hands to a domain at all is a dead const rather than a test failure: only
    /// `CATALOG` names one, so the compiler reports it. What a compiler cannot see is a domain
    /// handed the wrong list — every row would still be a real row, checked against a real
    /// parameter table, under a tool that does not offer it.
    #[test]
    fn no_table_outlives_the_operation_it_declares() {
        for domain in CATALOG {
            assert!(
                !domain.operations.is_empty(),
                "{} offers nothing",
                domain.name
            );
            for operation in domain.operations {
                assert_eq!(
                    operation.tool, domain.name,
                    "{} was handed {}'s {} row",
                    domain.name, operation.tool, operation.op
                );
            }
        }
    }

    /// A hash is sixty-four lowercase hex characters, and one character short is a typo rather
    /// than a file that changed. This is the check the live run needed and did not have.
    #[test]
    fn a_hash_one_character_short_is_refused_as_a_copy_that_slipped() {
        let full = "a".repeat(64);
        check_ok(
            "godot_script",
            "save",
            json!({"path": "hud.gd", "text": "extends Node2D\n", "expectedHash": full}),
        );
        let short = "a".repeat(63);
        let refused = message(
            "godot_script",
            "save",
            json!({"path": "hud.gd", "text": "extends Node2D\n", "expectedHash": short}),
        );
        assert!(refused.contains("63 characters"), "{refused}");
        assert!(refused.contains("Copy it again"), "{refused}");
        assert!(
            !refused.contains("changed"),
            "a mistyped hash must not be blamed on the file: {refused}"
        );

        // Sixty-four characters that are not hex is the same mistake wearing the right length.
        let wrong = format!("{}Z", "a".repeat(63));
        assert!(
            check(
                "godot_resource",
                "delete",
                &json!({"path": "a.gd", "expectedHash": wrong})
            )
            .is_err(),
            "sixty-four characters is not enough to be a hash"
        );
    }

    /// `either` accepts each of its kinds and nothing else.
    #[test]
    fn a_parameter_of_two_kinds_takes_either_and_no_third() {
        for size in [json!(16), json!([16, 16])] {
            check_ok(
                "godot_resource",
                "create_tileset",
                json!({"path": "a.tres", "texture": "t.png", "tileSize": size}),
            );
        }
        let refused = message(
            "godot_resource",
            "create_tileset",
            json!({"path": "a.tres", "texture": "t.png", "tileSize": "16"}),
        );
        assert!(refused.contains("a number or an array"), "{refused}");
    }

    /// The signature is what the model reads, so it has to say which parameters are optional — and
    /// leave out the ones the router fills in, which a model that reads it will otherwise try to
    /// supply.
    #[test]
    fn the_signature_marks_the_optional_parameters() {
        let params = params_of("godot_node", "create").expect("node.create is in the table");
        assert_eq!(
            signature(params),
            "{parent: text, type: text, name: text, index?: int}"
        );
        assert_eq!(signature(&[]), "");
    }

    /// A tagged value wrapped in a second copy of its own tag, unwrapped rather than refused.
    ///
    /// One live turn against a local Qwen3.6-27B sent 51 of these in 114 tool calls, and every one
    /// was refused by a sentence that named the shape it wanted and never noticed that the shape it
    /// wanted was sitting inside the one it got.
    ///
    /// This lived in the worker until it was moved here. It was the only place a live turn's
    /// commonest wrong shape was repaired, and the acceptance suites — which call `dispatch`
    /// directly — never ran it at all.
    #[test]
    fn a_tag_written_twice_is_unwrapped_rather_than_refused() {
        let repaired = |value: Value| {
            let mut params = json!({"node": "/Player", "property": "position", "value": value});
            repair("godot_node", "set_property", &mut params);
            params["value"].clone()
        };

        assert_eq!(
            repaired(json!({"type": "vector2", "value": {"type": "vector2", "value": [32, 48]}})),
            json!({"type": "vector2", "value": [32, 48]})
        );

        // The protocol's word outside and the engine's inside. One live turn wrote
        // `{type: "string", value: {type: "String", value: "Resume"}}` and was refused sixteen
        // times over twelve minutes, while `{type: "bool", value: {type: "bool", value: false}}` in
        // the same call went straight through. Across five recorded turns 41 of 86 tagged values
        // were wrapped twice and 22 of the 41 spelled the inner tag with the engine's capital. No
        // two protocol tags differ only in case, so folding it is safe, and the value that comes
        // out carries the lowercase spelling whichever side wrote it.
        for wrapper in [
            json!({"type": "string", "value": {"type": "String", "value": "Resume"}}),
            json!({"type": "String", "value": {"type": "string", "value": "Resume"}}),
        ] {
            assert_eq!(
                repaired(wrapper.clone()),
                json!({"type": "string", "value": "Resume"}),
                "{wrapper}"
            );
        }

        // And one wrapper written the same way. The model that knew both words wrote Godot's
        // spelling in the tag it wrote once as readily as in the tag it wrote twice, and `check`
        // looks the tag up case-sensitively — so `{type: "String", value: "Resume"}` was refused
        // with "`String` is not a value type" while the double-wrapped form beside it in the same
        // call was repaired.
        assert_eq!(
            repaired(json!({"type": "String", "value": "Resume"})),
            json!({"type": "string", "value": "Resume"})
        );

        // Three copies is the same mistake as two.
        assert_eq!(
            repaired(json!({
                "type": "int",
                "value": {"type": "int", "value": {"type": "int", "value": 2}}
            })),
            json!({"type": "int", "value": 2})
        );

        // Only the same tag twice. Two different tags is not a wrapper a caller meant to write, and
        // guessing which of them is the real one is not this layer's to do — the refusal says what
        // it received. A word that is not a tag in any case keeps the spelling it arrived in, so
        // the refusal quotes what the caller wrote.
        for left in [
            json!({"type": "vector2", "value": {"type": "float", "value": 1}}),
            json!({"type": "int", "value": {"type": "float", "value": 1}}),
            json!({"type": "Vektor2", "value": [1, 2]}),
            // A `resource` carries an object with a `path`, which is not a tag inside a tag.
            json!({"type": "resource", "value": {"path": "res://scripts/player.gd"}}),
        ] {
            assert_eq!(repaired(left.clone()), left, "{left}");
        }

        // Inside a list parameter's entries too, which is where `set_properties` carries them.
        let mut listed = json!({"properties": [
            {"node": "/P", "property": "position",
             "value": {"type": "vector2", "value": {"type": "vector2", "value": [1, 2]}}},
            {"node": "/P", "property": "visible", "value": {"type": "bool", "value": true}},
        ]});
        repair("godot_node", "set_properties", &mut listed);
        assert_eq!(
            listed["properties"][0]["value"],
            json!({"type": "vector2", "value": [1, 2]}),
            "{listed}"
        );
        assert_eq!(
            listed["properties"][1]["value"],
            json!({"type": "bool", "value": true}),
            "{listed}"
        );
        check_ok("godot_node", "set_properties", listed);
    }

    /// The shape the fixture says a recorded call has to be repaired into is the shape `check`
    /// accepts, proven rather than maintained by hand.
    ///
    /// `fixtures/recorded-tool-calls.json` carries nine calls under `repairs` that a model really
    /// wrote and the router really refused, each beside the `repaired` form it had to become. That
    /// field used to be asserted only against the worker's normalizer, in JavaScript, in another
    /// process — so if it drifted from what this file accepts, both tests stayed green and the live
    /// call was still refused.
    ///
    /// So the fixture is run down the path the router really takes: repair, then check. Three
    /// things have to hold for every entry, and the third is what keeps this from being vacuous —
    /// the call as the model wrote it has to be one `check` refuses, or the fixture is recording a
    /// repair that does nothing.
    #[test]
    fn every_shape_the_fixture_records_as_repaired_is_the_shape_the_router_accepts() {
        let recorded: Value = serde_json::from_slice(
            &std::fs::read(
                std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("../fixtures/recorded-tool-calls.json"),
            )
            .expect("read the recorded calls"),
        )
        .expect("parse the recorded calls");
        let repairs = recorded["repairs"].as_array().expect("recorded repairs");
        assert!(repairs.len() > 5, "the fixture lost its repairs");

        let without_op = |entry: &Value| {
            let mut params = entry.clone();
            if let Some(object) = params.as_object_mut() {
                object.remove("op");
            }
            params
        };
        for case in repairs {
            let tool = case["tool"].as_str().expect("case tool");
            let written = case["ops"].as_array().expect("case ops");
            let wanted = case["repaired"].as_array().expect("case repaired");
            assert_eq!(
                written.len(),
                wanted.len(),
                "{tool} records {} calls and {} repairs of them",
                written.len(),
                wanted.len()
            );
            let mut refused_as_written = 0;
            for (entry, want) in written.iter().zip(wanted) {
                let op = entry["op"].as_str().expect("an op name");
                assert_eq!(
                    want["op"].as_str(),
                    Some(op),
                    "{tool} records a repair of another operation"
                );
                let mut params = without_op(entry);
                if check(tool, op, &params).is_err() {
                    refused_as_written += 1;
                }
                repair(tool, op, &mut params);
                assert_eq!(
                    params,
                    without_op(want),
                    "{tool} {op} was repaired into a shape the fixture does not name"
                );
                check(tool, op, &params).unwrap_or_else(|failure| {
                    panic!("{tool} {op} is refused after repair: {}", failure.message)
                });
            }
            assert!(
                refused_as_written > 0,
                "{tool} records a repair of a call nothing was going to refuse"
            );
        }
    }

    /// Three coins written as one torn entry earn one refusal, not one per key.
    ///
    /// The exact object a live turn sent, from `runs/coin01`: the model wrote three `instantiate`
    /// entries, its JSON tore across all three, and what arrived was one entry holding an intact
    /// `op`, `parent` and `path` beside three keys made of the wreckage. Gofer answered about one
    /// key per refusal — `nameCoin1` first, with `Did you mean `name`?` — and the model spent five
    /// round trips and 3.6k tokens peeling them off one at a time, then abandoned the batch and
    /// instantiated the coins one call at a time, which worked.
    ///
    /// A spelling hint is the wrong advice for wreckage, so this refusal withholds it.
    #[test]
    fn an_entry_that_came_apart_in_three_places_is_refused_once() {
        let mut entry = serde_json::Map::new();
        entry.insert("parent".to_owned(), json!("/Main"));
        entry.insert("path".to_owned(), json!("res://scenes/coin.tscn"));
        entry.insert("nameCoin1".to_owned(), Value::Null);
        entry.insert("name\": \"Coin1\"}, {".to_owned(), Value::Null);
        entry.insert(
            "path\": \"res://scenes/coin.tscn\", ".to_owned(),
            json!(", \"Coin2\"}, {"),
        );
        let refused = check("godot_node", "instantiate", &Value::Object(entry))
            .expect_err("the entry is refused");
        assert_eq!(refused.code, "torn_param", "{}", refused.message);
        assert!(
            refused.message.contains("3 keys it does not take"),
            "it counts the wreckage rather than naming one piece of it: {}",
            refused.message
        );
        assert!(
            refused.message.contains("came apart"),
            "it says the object came apart: {}",
            refused.message
        );
        assert!(
            !refused.message.contains("Did you mean"),
            "a spelling hint sends a model looking for a better word for wreckage: {}",
            refused.message
        );
        assert!(
            refused.message.contains("carries parent, path"),
            "it names the keys that survived: {}",
            refused.message
        );
    }

    /// One wrong word is still one wrong word.
    ///
    /// The refusal above must not swallow the ordinary case: a single misspelled parameter still
    /// earns the near-miss hint, which is what a model can act on in one round trip.
    #[test]
    fn a_single_misspelled_parameter_still_gets_its_near_miss() {
        let refused = check(
            "godot_node",
            "instantiate",
            &json!({"parent": "/Main", "pathh": "res://a.tscn"}),
        )
        .expect_err("the call is refused");
        assert_eq!(refused.code, "unknown_param", "{}", refused.message);
        assert!(
            refused.message.contains("Did you mean `path`?"),
            "{}",
            refused.message
        );
    }

    /// A tagged value written as two flat keys is one value, not two candidate names.
    ///
    /// Both shapes a live turn wrote for `create_shape`'s `size`, and both were refused with
    /// ``has no `sizeType` parameter … Did you mean `size`?`` — a hint naming the half that was
    /// already right. Nothing about `size` is tagged; the habit came from `set_property`.
    ///
    /// Measured against the local Qwen3.8-27B at medium: 0 of 8 entries carried a well-formed
    /// `size`, over two catalogue arms. See `fold_a_tag_written_flat`.
    #[test]
    fn a_tagged_value_flattened_onto_a_parameter_name_is_folded_back() {
        for written in [
            json!({
                "path": "a.tres", "shapeType": "RectangleShape2D",
                "sizeType": Value::Null, "sizeValue": [24, 48]
            }),
            json!({
                "path": "a.tres", "shapeType": "RectangleShape2D",
                "sizeType": "Vector2", "sizeValue": [24, 48]
            }),
            json!({
                "path": "a.tres", "shapeType": "RectangleShape2D",
                "size_type": "Vector2", "size_value": [24, 48]
            }),
        ] {
            let mut held = written.clone();
            repair("godot_resource", "create_shape", &mut held);
            assert_eq!(held["size"], json!([24, 48]), "{written} became {held}");
            check_ok("godot_resource", "create_shape", held);
        }

        // The value half alone was always repaired and still is.
        let mut lone = json!({"path": "a.tres", "shapeType": "CircleShape2D", "radiusValue": 8});
        repair("godot_resource", "create_shape", &mut lone);
        assert_eq!(lone["radius"], json!(8), "{lone}");

        // A type half with no value half beside it is not a flattened tag, and nothing here throws
        // it away. It is not renamed either: `size` takes a list and "Vector2" is a word, and a
        // rename never lands a value on a parameter that could not hold it. So `check` names the
        // key the caller actually wrote.
        let mut alone = json!({
            "path": "a.tres", "shapeType": "RectangleShape2D", "sizeType": "Vector2"
        });
        repair("godot_resource", "create_shape", &mut alone);
        assert_eq!(alone["sizeType"], json!("Vector2"), "{alone}");
        let refused =
            check("godot_resource", "create_shape", &alone).expect_err("the key is named");
        assert!(
            refused.message.contains("`sizeType`"),
            "{}",
            refused.message
        );

        // And a type half carrying a real value is not a type slot. `points` is declared here, so
        // the head reads as one; what sits beside it is a list, which no `{type, value}` pair has
        // in its type half, and throwing it away would lose what the caller wrote.
        let mut carried = json!({
            "path": "a.tres", "shapeType": "SegmentShape2D",
            "pointsType": [0, 0], "pointsValue": [0, 0, 8, 8]
        });
        repair("godot_resource", "create_shape", &mut carried);
        assert_eq!(carried["pointsType"], json!([0, 0]), "{carried}");
    }

    /// A key with nothing in it must not block the key that holds the answer.
    ///
    /// The call a live turn sent `resource.create_shape` while building a tile level. `size_list`
    /// alone is renamed to `size` and runs; the empty key beside it made both read as `size`, the
    /// rename refused a contest it could not resolve, and the call came back
    /// ``has no `size_list` parameter … Did you mean `size`?`` — about the key that was closest to
    /// right.
    #[test]
    fn an_empty_key_does_not_block_the_one_beside_it() {
        let mut held = json!({
            "path": "assets/player_shape.tres",
            "shapeType": "RectangleShape2D",
            "size_list": [16, 16],
            "size_list_note": Value::Null
        });
        repair("godot_resource", "create_shape", &mut held);
        assert_eq!(held["size"], json!([16, 16]), "{held}");
        check_ok("godot_resource", "create_shape", held);

        // Two keys that both hold something are still two answers, and neither is taken.
        let mut contested = json!({
            "path": "a.tres", "shapeType": "RectangleShape2D",
            "size_a": [16, 16], "size_b": [32, 32]
        });
        repair("godot_resource", "create_shape", &mut contested);
        assert!(contested.get("size").is_none(), "{contested}");
    }

    /// A rename never lands a value on a parameter that could not have held it.
    ///
    /// The call a live turn sent while building a platformer, both entries the same shape:
    /// `{"size_list": [16, 16], "height_list": [16, 16]}`. Both keys are name-shaped and each reads
    /// as exactly one parameter, so both were renamed — `size` correctly, and `height`, which is a
    /// number, onto a pair. The whole call came back ``\`height\` takes a number, and this one was
    /// an array of 2``, about a key the model never wrote, on an operation whose `height` a
    /// RectangleShape2D does not read at all.
    #[test]
    fn a_rename_never_lands_a_value_the_parameter_could_not_hold() {
        let mut held = json!({
            "path": "assets/player_shape.tres",
            "shapeType": "RectangleShape2D",
            "size_list": [16, 16],
            "height_list": [16, 16]
        });
        repair("godot_resource", "create_shape", &mut held);
        assert_eq!(held["size"], json!([16, 16]), "{held}");
        assert!(held.get("height").is_none(), "{held}");
        let refused = check("godot_resource", "create_shape", &held).expect_err("still refused");
        assert!(
            refused.message.contains("`height_list`"),
            "the refusal names the key the caller wrote: {}",
            refused.message
        );
        // A note on the four dimension parameters, saying which shape reads each, was tried here
        // and reverted: `bench-size-shape.mjs`, catalogue-with-notes against catalogue-without,
        // 14 seeds interleaved, **0 of 24 against 0 of 27**. It is the second thing measured to
        // make no difference to how this model writes `size` — printing the shape in the signature
        // was the first, 0 of 4 either way. Prose does not reach this field; the repairs do.
    }

    /// A name and its value written as one key, with the separator lost between them.
    ///
    /// One live turn sent `create_shape` six times running and was refused six times. Five distinct
    /// shapes, every one of them `"<name> <value>": null` — the pair written, the colon and the
    /// quotes not. Neither existing repair reaches it, so the parameter was simply absent and the
    /// key beside it named nothing.
    #[test]
    fn a_name_and_its_value_written_as_one_key_are_read_as_a_pair() {
        // The whole recorded entry, wreckage and all.
        let mut held = json!({
            "path": "shapes/player_shape.tres",
            "shapeType": "RectangleShape2D",
            "size [16, 16]": Value::Null
        });
        repair("godot_resource", "create_shape", &mut held);
        assert_eq!(held["size"], json!([16, 16]), "{held}");
        check_ok("godot_resource", "create_shape", held);

        // A plain word is a value too: a path, a class name, a node path.
        let mut worded = json!({
            "path shapes/floor_shape.tres": Value::Null,
            "shapeType RectangleShape2D": Value::Null,
            "size [640, 16]": Value::Null
        });
        repair("godot_resource", "create_shape", &mut worded);
        assert_eq!(worded["path"], json!("shapes/floor_shape.tres"), "{worded}");
        assert_eq!(worded["shapeType"], json!("RectangleShape2D"), "{worded}");
        assert_eq!(worded["size"], json!([640, 16]), "{worded}");
        check_ok("godot_resource", "create_shape", worded);

        // The same pair a second time, torn, beside the one that survived. It says nothing the
        // call has not already said.
        let mut twice = json!({
            "node": "/Main/Player",
            "node /Main/Player": Value::Null,
            "group": "player"
        });
        repair("godot_node", "add_to_group", &mut twice);
        assert!(twice.get("node /Main/Player").is_none(), "{twice}");
        check_ok("godot_node", "add_to_group", twice);
    }

    /// And what is not a value stays for `check` to name.
    #[test]
    fn a_key_that_swallowed_two_calls_is_not_read_as_a_pair() {
        // Two calls that ran into each other. The tail begins with a list and does not end there.
        let mut ran_together = json!({
            "path": "a.tres",
            "shapeType": "RectangleShape2D",
            "size [32, 32]}]edits": Value::Null
        });
        repair("godot_resource", "create_shape", &mut ran_together);
        assert!(ran_together.get("size").is_none(), "{ran_together}");

        // Two operations written as one key. A comma is not part of a path.
        let mut both = json!({"path shapes/a.tres, shapes/b.tres": Value::Null});
        repair("godot_resource", "rescan", &mut both);
        assert!(both.get("path").is_none(), "{both}");

        // And a tail the parameter could not hold. `size` takes a list, and this is a number.
        let mut wrong =
            json!({"path": "a.tres", "shapeType": "RectangleShape2D", "size 16": Value::Null});
        repair("godot_resource", "create_shape", &mut wrong);
        assert!(wrong.get("size").is_none(), "{wrong}");
    }
}

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
use serde_json::Value;

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
        crate::tool_repair::repair_call(self.tool, self.op, self.params, params);
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
        crate::tool_repair::check_set(&call, self.op, "", self.params, object)
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
// GENERATED-BEGIN operations sha256:12ddb273450b570e
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
        "Creates a scene and opens it. It is checked against the revision of the scene being *replaced*, because creating a scene discards whatever is unsaved in the open one — which is what the check is for. The router holds that number already. A scene here is never inherited from another one: there is no base, and no call in this catalogue makes one scene extend another. To build on an existing scene, instantiate it with node.instantiate and set on the instance whatever differs — measured on 4.7.2, the instance keeps what is set on it and the scene it came from is unchanged.",
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
        "Replaces the breakpoints of one script. The answer echoes what was asked for, so it says success whether or not the game took it: read `armed` for what is actually still set, everywhere. A clear sent while the game is stopped can be lost — clear it, continue, and check it does not stop there again. A launch does not clear what the editor is holding either; an empty breakpoint list at launch is not a clear.",
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
        &[
            noted(
                need("path", Text),
                "The node to read, by its path in the running tree: every one of those starts at /root. godot_node calls this same thing `node`, and this is the one operation in this catalogue where `path` names a node rather than a file.",
            ),
            opt("properties", List),
        ],
    ),
    op(
        "godot_runtime",
        "input",
        "Injects input and captures the result. Each event names its kind and the parameters that kind uses, as {\"kind\": \"key\", \"key\": \"A\", \"pressed\": true} — send the release as a second event, or the key stays down. An event that leaves `pressed` out alternates on its own: the first is the press and the second the release, so a click is the same event written twice. A Button answers the release, not the press. The named keys are in the signature; F1 to F16, A to Z and 0 to 9 are spelled as they read. A mouse button is named left, right, middle, wheel_up or wheel_down, or given as an index. A position is [x, y]. This drives the Input Map, so it is how you check that a level you built can actually be played. Its answer carries a frame, unless a later entry of the same call carries one too: a picture another picture replaces is not worth sending, and a moment in the middle of a key sequence is what capture is for.",
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
    "Reads a page. `editor` is the editor's stdout, which also carries what the game printed; `editorError` is where the engine reports its own failures, including a script that would not parse. Terminal colour is taken out, and the editor's own progress bar — `[  16% ] first_scan_filesystem | …` — is left out and counted in `terminalLinesOmitted`, because a terminal drawing itself is a fifth of this output and none of it is about the project. One line in `editorError` is never about the project: an `ERROR:` naming a section like `res://scripts/player.gd` with the key `state` is the editor restoring which script tabs were open. It is dropped from the errors a failed call carries, and left here because this is the raw page.",
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
            match param.kind {
                Kind::Choice(allowed) => {
                    let quoted: Vec<String> =
                        allowed.iter().map(|word| format!("\"{word}\"")).collect();
                    format!("{}{mark}: {}", param.name, quoted.join("|"))
                }
                _ if !param.entry.is_empty() => match param.kind {
                    Kind::Object => format!("{}{mark}: {}", param.name, signature(param.entry)),
                    _ => format!(
                        "{}{mark}: {} of {}",
                        param.name,
                        short(param.kind),
                        signature(param.entry)
                    ),
                },
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

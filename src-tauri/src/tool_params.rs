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
//! `{"type": "Resource", "value": {"path": "res://scripts/player.gd"}}` — the path is right, the `{"path": …}`
//! wrapper is missing — and was answered `A resource value requires an object carrying a path`
//! eight times. The sentence is true. It does not show the wrapper and it does not repeat what
//! arrived, so the model changed nothing between attempts, then concluded that scripts cannot be
//! attached at all and started writing `.tscn` files by hand.
//!
//! So a failure here is not allowed to be only a complaint. Every one of them names the parameter,
//! says what arrived, and prints the corrected call with the model's own values already in it.
//! Each carried a hand-written sentence of its own as well, until the arm that cut all seventy-nine
//! of them out of the schema tied on success; they are the shape and the generic explanation now.

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

/// What a parameter means when the call leaves it out, where the router rather than the handler
/// decides.
///
/// Emitted into the schema as JSON-schema `default` from this same row, so the value the model is
/// shown and the value the router applies cannot be two different words.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(untagged)]
pub enum Fallback {
    Text(&'static str),
    Int(i64),
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
    /// The words this parameter accepts inside a structure, where [`Kind`] cannot reach.
    ///
    /// `key` sits inside each entry of an `events` list, so no kind can name it. It reaches the
    /// model as the schema `enum` the sampler is constrained by rather than as prose: the
    /// signature used to print the words, which was twenty-five of the engine's hundred and
    /// ninety, and the arm that measured the enum with that sentence still beside it lost to the
    /// arm that measured the enum alone.
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
    /// What this parameter is worth when the call names none. See [`Fallback`].
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default: Option<Fallback>,
}

pub const fn need(name: &'static str, kind: Kind) -> Param {
    Param {
        name,
        kind,
        required: true,
        hidden: false,
        vocabulary: &[],
        entry: &[],
        default: None,
    }
}

pub const fn opt(name: &'static str, kind: Kind) -> Param {
    Param {
        name,
        kind,
        required: false,
        hidden: false,
        vocabulary: &[],
        entry: &[],
        default: None,
    }
}

/// Accepted without being advertised. See `Param::hidden`.
pub const fn hidden(name: &'static str, kind: Kind) -> Param {
    Param {
        name,
        kind,
        required: false,
        hidden: true,
        vocabulary: &[],
        entry: &[],
        default: None,
    }
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

/// The same parameter, carrying what it is worth when a call names none. See [`Fallback`].
pub const fn defaulting(param: Param, default: Fallback) -> Param {
    Param {
        default: Some(default),
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
/// It carried the printed signature too, back when the tool description named one per operation.
/// The description does not any more — the schema already carries every kind — so the worker is
/// sent the parameters and prints what it needs from them.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Wire<'a> {
    op: &'static str,
    summary: &'static str,
    params: &'a [Param],
    alone: Option<Lone>,
}

impl Serialize for Operation {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        Wire {
            op: self.op,
            summary: self.summary,
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

    /// Refuses a call whose parameters cannot possibly be right, before it leaves this process.
    ///
    /// Everything here is arithmetic on JSON: a name that is not accepted, a missing required
    /// parameter, a value of the wrong JSON type, a tagged value whose payload does not match its
    /// own tag. None of it needs the editor, so none of it should cost a round trip to find out.
    pub fn check(&self, params: &Value) -> Result<(), ToolFailure> {
        let Some(object) = params.as_object() else {
            return Ok(());
        };
        let call = crate::tool_check::dotted(self.tool, self.op);
        crate::tool_check::check_set(&call, self.op, "", self.params, object)
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
/// Read out of the pinned engine into `protocol/godot-vocabulary.json` and emitted from there.
/// They were twenty-five key names written by hand into `params.json`, of the hundred and ninety
/// the engine has, and the only thing holding even those to it was a test that fed each one to a
/// real editor.
// GENERATED-BEGIN vocabularies sha256:b1dff5748ca32659
/// Godot's own name for a key, not the browser's.
pub const GODOT_KEY_NAME: &[&str] = &[
    "0",
    "1",
    "2",
    "3",
    "4",
    "5",
    "6",
    "7",
    "8",
    "9",
    "A",
    "Alt",
    "Ampersand",
    "Apostrophe",
    "AsciiCircum",
    "AsciiTilde",
    "Asterisk",
    "At",
    "B",
    "Back",
    "BackSlash",
    "Backspace",
    "Backtab",
    "Bar",
    "BraceLeft",
    "BraceRight",
    "BracketLeft",
    "BracketRight",
    "C",
    "CapsLock",
    "Clear",
    "Colon",
    "Comma",
    "Ctrl",
    "D",
    "Delete",
    "Dollar",
    "Down",
    "E",
    "End",
    "Enter",
    "Equal",
    "Escape",
    "Exclam",
    "F",
    "F1",
    "F10",
    "F11",
    "F12",
    "F13",
    "F14",
    "F15",
    "F16",
    "F17",
    "F18",
    "F19",
    "F2",
    "F20",
    "F21",
    "F22",
    "F23",
    "F24",
    "F25",
    "F26",
    "F27",
    "F28",
    "F29",
    "F3",
    "F30",
    "F31",
    "F32",
    "F33",
    "F34",
    "F35",
    "F4",
    "F5",
    "F6",
    "F7",
    "F8",
    "F9",
    "Favorites",
    "Forward",
    "G",
    "Globe",
    "Greater",
    "H",
    "Help",
    "Home",
    "HomePage",
    "Hyper",
    "I",
    "Insert",
    "J",
    "JIS Eisu",
    "JIS Kana",
    "K",
    "Kp 0",
    "Kp 1",
    "Kp 2",
    "Kp 3",
    "Kp 4",
    "Kp 5",
    "Kp 6",
    "Kp 7",
    "Kp 8",
    "Kp 9",
    "Kp Add",
    "Kp Divide",
    "Kp Enter",
    "Kp Multiply",
    "Kp Period",
    "Kp Subtract",
    "L",
    "Launch0",
    "Launch1",
    "Launch2",
    "Launch3",
    "Launch4",
    "Launch5",
    "Launch6",
    "Launch7",
    "Launch8",
    "Launch9",
    "LaunchA",
    "LaunchB",
    "LaunchC",
    "LaunchD",
    "LaunchE",
    "LaunchF",
    "LaunchMail",
    "LaunchMedia",
    "Left",
    "Less",
    "M",
    "MediaNext",
    "MediaPlay",
    "MediaPrevious",
    "MediaRecord",
    "MediaStop",
    "Menu",
    "Meta",
    "Minus",
    "N",
    "NumLock",
    "NumberSign",
    "O",
    "On-screen keyboard",
    "OpenURL",
    "P",
    "PageDown",
    "PageUp",
    "ParenLeft",
    "ParenRight",
    "Pause",
    "Percent",
    "Period",
    "Plus",
    "Print",
    "Q",
    "Question",
    "QuoteDbl",
    "QuoteLeft",
    "R",
    "Refresh",
    "Right",
    "S",
    "ScrollLock",
    "Search",
    "Section",
    "Semicolon",
    "Shift",
    "Slash",
    "Space",
    "StandBy",
    "Stop",
    "SysReq",
    "T",
    "Tab",
    "U",
    "UnderScore",
    "Up",
    "V",
    "VolumeDown",
    "VolumeMute",
    "VolumeUp",
    "W",
    "X",
    "Y",
    "Yen",
    "Z",
];

/// A `Performance.Monitor` constant, as the engine spells it.
pub const GODOT_MONITOR_NAME: &[&str] = &[
    "TIME_FPS",
    "TIME_PROCESS",
    "TIME_PHYSICS_PROCESS",
    "TIME_NAVIGATION_PROCESS",
    "MEMORY_STATIC",
    "MEMORY_STATIC_MAX",
    "MEMORY_MESSAGE_BUFFER_MAX",
    "OBJECT_COUNT",
    "OBJECT_RESOURCE_COUNT",
    "OBJECT_NODE_COUNT",
    "OBJECT_ORPHAN_NODE_COUNT",
    "RENDER_TOTAL_OBJECTS_IN_FRAME",
    "RENDER_TOTAL_PRIMITIVES_IN_FRAME",
    "RENDER_TOTAL_DRAW_CALLS_IN_FRAME",
    "RENDER_VIDEO_MEM_USED",
    "RENDER_TEXTURE_MEM_USED",
    "RENDER_BUFFER_MEM_USED",
    "PHYSICS_2D_ACTIVE_OBJECTS",
    "PHYSICS_2D_COLLISION_PAIRS",
    "PHYSICS_2D_ISLAND_COUNT",
    "PHYSICS_3D_ACTIVE_OBJECTS",
    "PHYSICS_3D_COLLISION_PAIRS",
    "PHYSICS_3D_ISLAND_COUNT",
    "AUDIO_OUTPUT_LATENCY",
    "NAVIGATION_ACTIVE_MAPS",
    "NAVIGATION_REGION_COUNT",
    "NAVIGATION_AGENT_COUNT",
    "NAVIGATION_LINK_COUNT",
    "NAVIGATION_POLYGON_COUNT",
    "NAVIGATION_EDGE_COUNT",
    "NAVIGATION_EDGE_MERGE_COUNT",
    "NAVIGATION_EDGE_CONNECTION_COUNT",
    "NAVIGATION_EDGE_FREE_COUNT",
    "NAVIGATION_OBSTACLE_COUNT",
    "PIPELINE_COMPILATIONS_CANVAS",
    "PIPELINE_COMPILATIONS_MESH",
    "PIPELINE_COMPILATIONS_SURFACE",
    "PIPELINE_COMPILATIONS_DRAW",
    "PIPELINE_COMPILATIONS_SPECIALIZATION",
    "NAVIGATION_2D_ACTIVE_MAPS",
    "NAVIGATION_2D_REGION_COUNT",
    "NAVIGATION_2D_AGENT_COUNT",
    "NAVIGATION_2D_LINK_COUNT",
    "NAVIGATION_2D_POLYGON_COUNT",
    "NAVIGATION_2D_EDGE_COUNT",
    "NAVIGATION_2D_EDGE_MERGE_COUNT",
    "NAVIGATION_2D_EDGE_CONNECTION_COUNT",
    "NAVIGATION_2D_EDGE_FREE_COUNT",
    "NAVIGATION_2D_OBSTACLE_COUNT",
    "NAVIGATION_3D_ACTIVE_MAPS",
    "NAVIGATION_3D_REGION_COUNT",
    "NAVIGATION_3D_AGENT_COUNT",
    "NAVIGATION_3D_LINK_COUNT",
    "NAVIGATION_3D_POLYGON_COUNT",
    "NAVIGATION_3D_EDGE_COUNT",
    "NAVIGATION_3D_EDGE_MERGE_COUNT",
    "NAVIGATION_3D_EDGE_CONNECTION_COUNT",
    "NAVIGATION_3D_EDGE_FREE_COUNT",
    "NAVIGATION_3D_OBSTACLE_COUNT",
];

/// The `type_string` spelling of every Variant type a JSON payload can be built into, plus
/// `Resource` for the {path} payload.
pub const GODOT_VALUE_TAG: &[&str] = &[
    "Nil",
    "bool",
    "int",
    "float",
    "String",
    "Vector2",
    "Vector2i",
    "Rect2",
    "Rect2i",
    "Vector3",
    "Vector3i",
    "Transform2D",
    "Vector4",
    "Vector4i",
    "Plane",
    "Quaternion",
    "AABB",
    "Basis",
    "Transform3D",
    "Projection",
    "Color",
    "StringName",
    "NodePath",
    "Dictionary",
    "Array",
    "PackedByteArray",
    "PackedInt32Array",
    "PackedInt64Array",
    "PackedFloat32Array",
    "PackedFloat64Array",
    "PackedStringArray",
    "PackedVector2Array",
    "PackedVector3Array",
    "PackedColorArray",
    "PackedVector4Array",
    "Resource",
];

/// A `MouseButton` constant, as the engine spells it.
pub const GODOT_MOUSE_BUTTON: &[&str] = &[
    "MOUSE_BUTTON_LEFT",
    "MOUSE_BUTTON_RIGHT",
    "MOUSE_BUTTON_MIDDLE",
    "MOUSE_BUTTON_WHEEL_UP",
    "MOUSE_BUTTON_WHEEL_DOWN",
    "MOUSE_BUTTON_WHEEL_LEFT",
    "MOUSE_BUTTON_WHEEL_RIGHT",
    "MOUSE_BUTTON_XBUTTON1",
    "MOUSE_BUTTON_XBUTTON2",
];

/// A `JoyButton` constant, as the engine spells it.
pub const GODOT_JOY_BUTTON: &[&str] = &[
    "JOY_BUTTON_A",
    "JOY_BUTTON_B",
    "JOY_BUTTON_X",
    "JOY_BUTTON_Y",
    "JOY_BUTTON_BACK",
    "JOY_BUTTON_GUIDE",
    "JOY_BUTTON_START",
    "JOY_BUTTON_LEFT_STICK",
    "JOY_BUTTON_RIGHT_STICK",
    "JOY_BUTTON_LEFT_SHOULDER",
    "JOY_BUTTON_RIGHT_SHOULDER",
    "JOY_BUTTON_DPAD_UP",
    "JOY_BUTTON_DPAD_DOWN",
    "JOY_BUTTON_DPAD_LEFT",
    "JOY_BUTTON_DPAD_RIGHT",
    "JOY_BUTTON_MISC1",
    "JOY_BUTTON_PADDLE1",
    "JOY_BUTTON_PADDLE2",
    "JOY_BUTTON_PADDLE3",
    "JOY_BUTTON_PADDLE4",
    "JOY_BUTTON_TOUCHPAD",
    "JOY_BUTTON_MISC2",
    "JOY_BUTTON_MISC3",
    "JOY_BUTTON_MISC4",
    "JOY_BUTTON_MISC5",
    "JOY_BUTTON_MISC6",
];

/// A `JoyAxis` constant, as the engine spells it.
pub const GODOT_JOY_AXIS: &[&str] = &[
    "JOY_AXIS_LEFT_X",
    "JOY_AXIS_LEFT_Y",
    "JOY_AXIS_RIGHT_X",
    "JOY_AXIS_RIGHT_Y",
    "JOY_AXIS_TRIGGER_LEFT",
    "JOY_AXIS_TRIGGER_RIGHT",
];
// GENERATED-END vocabularies

/// What one tag's payload has to be, coarsely enough that only the engine can say more.
///
/// The variant a tag stands for is not chosen here: `scripts/godot-vocabulary.mjs` holds one
/// JSON-schema payload per tag, the generated schema refuses everything else before a sampler can
/// write it, and [`GODOT_TAG_PAYLOAD`] is that same table printed as the arity this side counts.
#[derive(Clone, Copy, PartialEq)]
pub enum Payload {
    Null,
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
    /// A packed array's elements, written as the payload each element's own type carries and
    /// nothing more: the array's tag has already said which type that is.
    PackedIntegers,
    PackedNumbers,
    PackedStrings,
    PackedComponents(usize),
    ResourcePath,
}

/// Every tag the protocol carries, and the payload it requires.
///
/// The same table `Protocol.decode` walks in the addon, and it stays the addon's job too: that one
/// is the wire's own backstop and cannot be removed. What it cannot be is the *first* place a
/// shape is examined, because by then the call has crossed a socket and the answer has been
/// flattened to `code: message`.
// GENERATED-BEGIN tag-payloads sha256:f7c3a3e297533b15
pub const GODOT_TAG_PAYLOAD: &[(&str, Payload)] = &[
    ("Nil", Payload::Null),
    ("bool", Payload::Boolean),
    ("int", Payload::Numeric),
    ("float", Payload::Numeric),
    ("String", Payload::Str),
    ("Vector2", Payload::Numbers(2)),
    ("Vector2i", Payload::Numbers(2)),
    ("Rect2", Payload::Numbers(4)),
    ("Rect2i", Payload::Numbers(4)),
    ("Vector3", Payload::Numbers(3)),
    ("Vector3i", Payload::Numbers(3)),
    ("Transform2D", Payload::Numbers(6)),
    ("Vector4", Payload::Numbers(4)),
    ("Vector4i", Payload::Numbers(4)),
    ("Plane", Payload::Numbers(4)),
    ("Quaternion", Payload::Numbers(4)),
    ("AABB", Payload::Numbers(6)),
    ("Basis", Payload::Numbers(9)),
    ("Transform3D", Payload::Numbers(12)),
    ("Projection", Payload::Numbers(16)),
    ("Color", Payload::Colour),
    ("StringName", Payload::Str),
    ("NodePath", Payload::Str),
    ("Dictionary", Payload::Pairs),
    ("Array", Payload::Items),
    ("PackedByteArray", Payload::PackedIntegers),
    ("PackedInt32Array", Payload::PackedIntegers),
    ("PackedInt64Array", Payload::PackedIntegers),
    ("PackedFloat32Array", Payload::PackedNumbers),
    ("PackedFloat64Array", Payload::PackedNumbers),
    ("PackedStringArray", Payload::PackedStrings),
    ("PackedVector2Array", Payload::PackedComponents(2)),
    ("PackedVector3Array", Payload::PackedComponents(3)),
    ("PackedColorArray", Payload::PackedComponents(4)),
    ("PackedVector4Array", Payload::PackedComponents(4)),
    ("Resource", Payload::ResourcePath),
];
// GENERATED-END tag-payloads

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
// GENERATED-BEGIN operations sha256:4960c59ef2ad7c55
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
            "Asks the addon for readiness, the open scene, its revision, and the dialog the editor is waiting on.",
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
                "Presses a button on the dialog the editor is waiting on, by its label — one of the `buttons` the dialog was reported with.",
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
            &[hidden("expectedRevision", Int)],
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
            &[hidden("expectedRevision", Int)],
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
        "Creates a scene and opens it.",
        Answers::Addon("scene.create"),
        &[
            need("path", Text),
            need("rootType", Text),
            opt("rootName", Text),
            hidden("expectedRevision", Int),
        ],
    ),
    op(
        "godot_scene",
        "get_tree",
        "Returns the edited scene hierarchy and its revision.",
        Answers::Addon("scene.get_tree"),
        &[opt("root", Text), opt("depth", Int), opt("limit", Int)],
    ),
    alone(
        op(
            "godot_scene",
            "save",
            "Saves the edited scene.",
            Answers::Addon("scene.save"),
            &[hidden("expectedRevision", Int)],
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
            &[need("path", Text), hidden("expectedRevision", Int)],
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
            &[hidden("expectedRevision", Int)],
        ),
        Sharing::Repeat,
        "One scene is open at a time, so a second one would act on whatever the first left open.",
    ),
];

pub const GODOT_NODE_OPERATIONS: &[Operation] = &[
    op(
        "godot_node",
        "inspect",
        "Inspects a node.",
        Answers::Addon("node.inspect"),
        &[
            need("node", Text),
            opt("properties", Kind::ListOf(&Text)),
            hidden("scene", Text),
        ],
    ),
    op(
        "godot_node",
        "create_nodes",
        "Creates nodes, as one revision and one undo step.",
        Answers::Addon("node.create_nodes"),
        &[
            shaped(
                need("nodes", List),
                &[
                    need("parent", Text),
                    need("type", Text),
                    need("name", Text),
                    opt("index", Int),
                ],
            ),
            hidden("expectedRevision", Int),
            hidden("scene", Text),
        ],
    ),
    op(
        "godot_node",
        "instantiate",
        "Places an instance of a saved scene under a node.",
        Answers::Addon("node.instantiate"),
        &[
            need("parent", Text),
            need("path", Text),
            opt("name", Text),
            opt("index", Int),
            hidden("expectedRevision", Int),
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
            hidden("expectedRevision", Int),
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
            hidden("expectedRevision", Int),
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
            hidden("expectedRevision", Int),
            hidden("scene", Text),
        ],
    ),
    op(
        "godot_node",
        "change_type",
        "Turns a node into one of another class, keeping its name, its place, its children, its groups, its script, and every stored property the new class also has.",
        Answers::Addon("node.change_type"),
        &[
            need("node", Text),
            need("type", Text),
            hidden("expectedRevision", Int),
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
            hidden("expectedRevision", Int),
            hidden("scene", Text),
        ],
    ),
    op(
        "godot_node",
        "set_properties",
        "Sets properties, as one revision and one undo step.",
        Answers::Addon("node.set_properties"),
        &[
            shaped(
                need("properties", List),
                &[
                    need("node", Text),
                    need("property", Text),
                    speaking(need("value", Tagged), GODOT_VALUE_TAG),
                ],
            ),
            hidden("expectedRevision", Int),
            hidden("scene", Text),
        ],
    ),
    op(
        "godot_node",
        "add_to_group",
        "Puts a node in a group the saved scene keeps.",
        Answers::Addon("node.add_to_group"),
        &[
            need("node", Text),
            need("group", Text),
            hidden("expectedRevision", Int),
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
            hidden("expectedRevision", Int),
        ],
    ),
    op(
        "godot_node",
        "connect_signal",
        "Connects a node's signal to a method, as an editor connection the scene keeps.",
        Answers::Addon("node.connect_signal"),
        &[
            need("node", Text),
            need("signal", Text),
            need("method", Text),
            opt("target", Text),
            opt("binds", List),
            opt("deferred", Flag),
            opt("oneShot", Flag),
            hidden("expectedRevision", Int),
        ],
    ),
    op(
        "godot_node",
        "disconnect_signal",
        "Removes a connection.",
        Answers::Addon("node.disconnect_signal"),
        &[
            need("node", Text),
            need("signal", Text),
            need("method", Text),
            opt("target", Text),
            opt("binds", List),
            hidden("expectedRevision", Int),
        ],
    ),
    op(
        "godot_node",
        "set_cells",
        "Paints tiles onto a TileMapLayer.",
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
                    opt("atlas", List),
                    opt("source", Int),
                ],
            ),
            hidden("expectedRevision", Int),
        ],
    ),
    op(
        "godot_node",
        "get_cells",
        "Reads back what a TileMapLayer holds.",
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
        "Searches project settings by name.",
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
            "Writes one project setting.",
            Answers::Addon("project.set_setting"),
            &[
                need("name", Text),
                speaking(need("value", Tagged), GODOT_VALUE_TAG),
            ],
        ),
        Writes::ProjectSetting,
    ),
    writes(
        op(
            "godot_project",
            "reset_setting",
            "Resets a project setting to its default, and answers what that did: `changed`, the `previous` value and the `value` it reads as now.",
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
        "Lists the Input Map actions this project chose — its own, and the built-ins it overrode — with their events.",
        Answers::Addon("project.list_input_actions"),
        &[opt("names", Kind::ListOf(&Text))],
    ),
    op(
        "godot_project",
        "set_input_action",
        "Writes an input action.",
        Answers::Addon("project.set_input_action"),
        &[
            need("name", Text),
            shaped(
                speaking(need("events", List), GODOT_KEY_NAME),
                &[
                    need(
                        "kind",
                        Kind::Choice(&["key", "mouse_button", "joypad_button"]),
                    ),
                    speaking(opt("key", Text), GODOT_KEY_NAME),
                    speaking(
                        opt("button", Kind::Choice(GODOT_MOUSE_BUTTON)),
                        GODOT_MOUSE_BUTTON,
                    ),
                    speaking(
                        opt("joypadButton", Kind::Choice(GODOT_JOY_BUTTON)),
                        GODOT_JOY_BUTTON,
                    ),
                ],
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
        "Searches machine-wide editor settings by name.",
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
                "Writes one machine-wide editor setting.",
                Answers::Addon("editor.set_setting"),
                &[
                    need("name", Text),
                    speaking(need("value", Tagged), GODOT_VALUE_TAG),
                ],
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
        "Lists the files in the task worktree with their sizes.",
        Answers::Rust,
        &[opt("under", Text), opt("hashes", Flag)],
    ),
    op(
        "godot_resource",
        "rescan",
        "Tells the editor filesystem about files that changed.",
        Answers::Addon("resource.rescan"),
        &[opt("paths", Kind::ListOf(&Text))],
    ),
    op(
        "godot_resource",
        "create_tileset",
        "Cuts a texture into a TileSet and saves it.",
        Answers::Addon("resource.create_tileset"),
        &[
            need("path", Text),
            need("texture", Text),
            defaulting(opt("tileWidth", Int), Fallback::Int(16)),
            defaulting(opt("tileHeight", Int), Fallback::Int(16)),
            opt("tiles", List),
            opt("solid", List),
            opt("allSolid", Flag),
        ],
    ),
    op(
        "godot_resource",
        "create_texture",
        "Draws a PNG and imports it, which is how a project with no art gets some.",
        Answers::Addon("resource.create_texture"),
        &[
            need("path", Text),
            need("width", Int),
            need("height", Int),
            opt("background", Text),
            shaped(
                opt("rects", List),
                &[
                    need("x", Int),
                    need("y", Int),
                    need("width", Int),
                    need("height", Int),
                    need("color", Text),
                ],
            ),
        ],
    ),
    op(
        "godot_resource",
        "create_shape",
        "Saves a 2D collision shape as a resource.",
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
        "Reports what a saved TileSet holds.",
        Answers::Addon("resource.describe_tileset"),
        &[need("path", Text)],
    ),
    gated(
        op(
            "godot_resource",
            "move",
            "Moves a file or directory inside the worktree.",
            Answers::Rust,
            &[need("from", Text), need("to", Text)],
        ),
        "Moving a path removes the file from where it is now, and can overwrite the destination.",
    ),
    gated(
        op(
            "godot_resource",
            "delete",
            "Deletes a file or directory, and Godot's own record of it — its `.uid`, an asset's `.import` — with it.",
            Answers::Rust,
            &[need("path", Text), hidden("expectedHash", Hash)],
        ),
        "Deleting a file removes it from the task worktree; only a Git checkout brings it back.",
    ),
];

pub const GODOT_SCRIPT_OPERATIONS: &[Operation] = &[
    op(
        "godot_script",
        "list",
        "Lists the GDScript files in the worktree with their size.",
        Answers::Rust,
        &[opt("under", Text)],
    ),
    op(
        "godot_script",
        "open",
        "Opens a script as a language-server document, its text coming back with each line prefixed by its 1-indexed number and a tab.",
        Answers::Rust,
        &[need("paths", Kind::ListOf(&Text))],
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
            "Changes existing scripts by replacing exact text, and answers with each file's diagnostics.",
            Answers::Rust,
            &[shaped(
                need("files", List),
                &[
                    need("path", Text),
                    shaped(
                        need("edits", List),
                        &[need("oldText", Text), need("newText", Text)],
                    ),
                ],
            )],
        ),
        Writes::ScriptText,
    ),
    writes(
        op(
            "godot_script",
            "save",
            "Writes a whole file and answers with the file's diagnostics, the same way `edit` does.",
            Answers::Rust,
            &[
                need("path", Text),
                need("text", Text),
                hidden("expectedHash", Hash),
            ],
        ),
        Writes::ScriptText,
    ),
    op(
        "godot_script",
        "close",
        "Closes the documents.",
        Answers::Rust,
        &[need("paths", Kind::ListOf(&Text))],
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
        "Hover documentation at a position. `position.line` is 0-based, one less than the number script.open shows.",
        Answers::Rust,
        &[
            need("path", Text),
            shaped(
                need("position", Object),
                &[need("line", Int), need("character", Int)],
            ),
        ],
    ),
    op(
        "godot_script",
        "completion",
        "Completion items at a position. `position.line` is 0-based, one less than the number script.open shows.",
        Answers::Rust,
        &[
            need("path", Text),
            shaped(
                need("position", Object),
                &[need("line", Int), need("character", Int)],
            ),
        ],
    ),
    op(
        "godot_script",
        "signature_help",
        "Signature help at a position. `position.line` is 0-based, one less than the number script.open shows.",
        Answers::Rust,
        &[
            need("path", Text),
            shaped(
                need("position", Object),
                &[need("line", Int), need("character", Int)],
            ),
        ],
    ),
    op(
        "godot_script",
        "definition",
        "Go to definition from a position. `position.line` is 0-based, one less than the number script.open shows.",
        Answers::Rust,
        &[
            need("path", Text),
            shaped(
                need("position", Object),
                &[need("line", Int), need("character", Int)],
            ),
        ],
    ),
    op(
        "godot_script",
        "declaration",
        "Go to declaration from a position. `position.line` is 0-based, one less than the number script.open shows.",
        Answers::Rust,
        &[
            need("path", Text),
            shaped(
                need("position", Object),
                &[need("line", Int), need("character", Int)],
            ),
        ],
    ),
    op(
        "godot_script",
        "references",
        "Find references of the symbol at a position. `position.line` is 0-based, one less than the number script.open shows.",
        Answers::Rust,
        &[
            need("path", Text),
            shaped(
                need("position", Object),
                &[need("line", Int), need("character", Int)],
            ),
            opt("includeDeclaration", Flag),
        ],
    ),
    op(
        "godot_script",
        "highlights",
        "Document highlights of the symbol at a position. `position.line` is 0-based, one less than the number script.open shows.",
        Answers::Rust,
        &[
            need("path", Text),
            shaped(
                need("position", Object),
                &[need("line", Int), need("character", Int)],
            ),
        ],
    ),
    op(
        "godot_script",
        "diagnostics",
        "Diagnostics the server published.",
        Answers::Rust,
        &[need("paths", Kind::ListOf(&Text)), opt("timeoutMs", Int)],
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
        "Checks whether the symbol at a position can be renamed. `position.line` is 0-based, one less than the number script.open shows.",
        Answers::Rust,
        &[
            need("path", Text),
            shaped(
                need("position", Object),
                &[need("line", Int), need("character", Int)],
            ),
        ],
    ),
    op(
        "godot_script",
        "rename",
        "Plans a rename of the symbol at a position without writing, and refuses when the server plans nothing — every real rename touches at least the declaration, so an empty plan is the server declining rather than a rename that reached no files.",
        Answers::Rust,
        &[
            need("path", Text),
            shaped(
                need("position", Object),
                &[need("line", Int), need("character", Int)],
            ),
            need("newName", Text),
        ],
    ),
    writes(
        op(
            "godot_script",
            "apply_rename",
            "Applies a planned rename in one transaction.",
            Answers::Rust,
            &[shaped(
                need("files", List),
                &[
                    need("path", Text),
                    need("originalText", Text),
                    need("originalHash", Text),
                    need("updatedText", Text),
                ],
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
            "Runs the project under the debugger, the main scene unless `scene` names another.",
            Answers::Rust,
            &[
                defaulting(opt("scene", Text), Fallback::Text("main")),
                opt("playArgs", List),
                shaped(
                    opt("breakpoints", List),
                    &[need("path", Text), need("lines", List)],
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
            "Waits for the next stop.",
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
        "Evaluates an expression in the frame the game is stopped in; a running game is refused as not_stopped, and a pause gives no frame either.",
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
            "Pauses the debuggee between frames.",
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
            "Restarts the debuggee with the last launch arguments and its breakpoints, and answers like the launch it is.",
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
            "Runs the project and captures the first frame, unless `playArgs` start it with `--headless`, which draws none.",
            Answers::Addon("runtime.run"),
            &[opt("scene", Text), opt("playArgs", Kind::ListOf(&Text))],
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
        "Returns the running game's scene tree, and `paused`: whether the tree is paused right now.",
        Answers::Addon("runtime.get_tree"),
        &[opt("root", Text), opt("depth", Int), opt("limit", Int)],
    ),
    op(
        "godot_runtime",
        "inspect_node",
        "Inspects a running node.",
        Answers::Addon("runtime.inspect_node"),
        &[need("path", Text), opt("properties", List)],
    ),
    op(
        "godot_runtime",
        "input",
        "Injects input and captures the result. Each event names its kind and the parameters that kind uses, as {\"kind\": \"key\", \"key\": \"A\", \"pressed\": true} — send the release as a second event, or the key stays down. An event that leaves `pressed` out alternates on its own: the first is the press and the second the release, so a click is the same event written twice. A Button answers the release, not the press. A mouse_button event names its `button`, a joypad_button event its `joypadButton`, and a joypad_motion event its `axis`. A position is [x, y]. This drives the Input Map, so it is how you check that a level you built can actually be played. Its answer carries a frame, unless a later entry of the same call carries one too: a picture another picture replaces is not worth sending, and a moment in the middle of a key sequence is what capture is for.",
        Answers::Addon("runtime.input"),
        &[shaped(
            speaking(need("events", List), GODOT_KEY_NAME),
            &[
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
                speaking(opt("key", Text), GODOT_KEY_NAME),
                opt("pressed", Flag),
                speaking(
                    opt("button", Kind::Choice(GODOT_MOUSE_BUTTON)),
                    GODOT_MOUSE_BUTTON,
                ),
                speaking(
                    opt("joypadButton", Kind::Choice(GODOT_JOY_BUTTON)),
                    GODOT_JOY_BUTTON,
                ),
                opt("position", List),
                opt("relative", List),
                speaking(opt("axis", Kind::Choice(GODOT_JOY_AXIS)), GODOT_JOY_AXIS),
                opt("value", Number),
                opt("device", Int),
            ],
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
        "Lets the game run on for a few frames, then answers with how many passed and how long it took.",
        Answers::Addon("runtime.wait"),
        &[opt("frames", Int), opt("ms", Int)],
    ),
    alone(
        op(
            "godot_runtime",
            "pause",
            "Freezes the running game where it stands, the way its own pause menu would: `SceneTree.paused`, so a node that opted out of pausing keeps running.",
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
        "Reads engine performance monitors.",
        Answers::Addon("runtime.get_monitors"),
        &[opt(
            "monitors",
            Kind::ListOf(&Kind::Choice(GODOT_MONITOR_NAME)),
        )],
    ),
];

pub const GODOT_LOGS_OPERATIONS: &[Operation] = &[op(
    "godot_logs",
    "read",
    "Reads a page of the editor and game log, newest last.",
    Answers::Rust,
    &[
        opt("after", Int),
        defaulting(
            opt("minSeverity", Kind::Choice(&["info", "warning", "error"])),
            Fallback::Text("info"),
        ),
        opt("source", Kind::Choice(&["editor", "editorError"])),
        opt("contains", Text),
        opt("context", Int),
        opt("limit", Int),
    ],
)];

pub const GODOT_DOCS_SEARCH_OPERATIONS: &[Operation] = &[
    op(
        "godot_docs_search",
        "search",
        "Retrieves ranked passages for a question in plain words.",
        Answers::Rust,
        &[
            need("question", Text),
            hidden("maxPassages", Int),
            opt("maxTextChars", Int),
        ],
    ),
    op(
        "godot_docs_search",
        "ask",
        "Answers one question from those same passages and hands back a paragraph and a quote instead of the chapters.",
        Answers::Rust,
        &[
            need("question", Text),
            hidden("maxPassages", Int),
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

/// The parameter shape a refusal prints, as `{node, property, value}`.
///
/// The tool description named one per operation until the schema carried every kind itself. What
/// still needs it is [`crate::tool_check`]: a refusal that does not print the shape leaves the
/// model to guess which of two right-looking ones the operation meant.
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
                // A choice out of a vocabulary prints as text: the words are the engine's, the
                // schema carries all of them, and the measured arm that names no member won.
                Kind::Choice(_) if !param.vocabulary.is_empty() => {
                    format!("{}{mark}: text", param.name)
                }
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
                Kind::Text => format!("{}{mark}: text", param.name),
                Kind::Int => format!("{}{mark}: int", param.name),
                Kind::Number => format!("{}{mark}: number", param.name),
                Kind::Flag => format!("{}{mark}: flag", param.name),
                Kind::List => format!("{}{mark}: list", param.name),
                Kind::Object => format!("{}{mark}: object", param.name),
                Kind::Hash => format!("{}{mark}: hash", param.name),
                Kind::Tagged => format!("{}{mark}: tagged", param.name),
                Kind::ListOf(inner) => format!("{}{mark}: list of {}", param.name, short(*inner)),
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
        // Text from a fixed set, and the schema carries which words. Spelling it "choice" would
        // name the declaration rather than what goes in the call.
        Kind::Choice(_) => "text",
        Kind::ListOf(_) => "list",
    }
}

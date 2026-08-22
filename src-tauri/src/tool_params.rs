//! The parameter contract of every tool operation, and the check that holds a model to it.
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
#[derive(Clone, Copy, PartialEq)]
pub enum Answers {
    /// The addon, under this exact command name.
    Addon(&'static str),
    /// The desktop, in a handler of its own.
    Rust,
}

/// The parameters of one operation, as `domain.op`, and what answers it.
pub struct OpParams {
    pub domain: &'static str,
    pub op: &'static str,
    pub answers: Answers,
    pub params: &'static [Param],
}

const fn op(
    domain: &'static str,
    op: &'static str,
    answers: Answers,
    params: &'static [Param],
) -> OpParams {
    OpParams {
        domain,
        op,
        answers,
        params,
    }
}

/// What answers `domain.op`, or `None` for an operation this table does not name.
///
/// Absence is a build-time oversight rather than something a caller can reach: `dispatch` refuses
/// an operation the catalogue does not offer before it gets here, and
/// `every_catalog_operation_declares_its_parameters` holds this table to the catalogue.
pub fn answers(domain: &str, op: &str) -> Option<Answers> {
    TABLE
        .iter()
        .find(|entry| entry.domain == domain && entry.op == op)
        .map(|entry| entry.answers)
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

/// Every parameter of every operation the router forwards as raw JSON.
///
/// The other five domains deserialize into typed Rust structs already, so serde is their contract
/// and repeating it here would be a second one. An operation absent from this table is not checked
/// — absence means unchecked, never "takes nothing" — which is why a new operation that wants
/// checking has to be added rather than merely written.
// GENERATED-BEGIN op-params sha256:54dc6cdc50a5c0a9
pub const TABLE: &[OpParams] = &[
    op("godot_session", "status", Answers::Rust, &[]),
    op("godot_session", "start", Answers::Rust, &[]),
    op("godot_session", "stop", Answers::Rust, &[]),
    op(
        "godot_session",
        "get_state",
        Answers::Addon("session.get_state"),
        &[],
    ),
    op(
        "godot_session",
        "undo",
        Answers::Addon("session.undo"),
        &[noted(
            hidden("expectedRevision", Int),
            "Supplied by the router from the last answer that reported it, so a call never carries one. It stays accepted for a caller that holds its own.",
        )],
    ),
    op(
        "godot_session",
        "redo",
        Answers::Addon("session.redo"),
        &[noted(
            hidden("expectedRevision", Int),
            "Supplied by the router from the last answer that reported it, so a call never carries one. It stays accepted for a caller that holds its own.",
        )],
    ),
    op(
        "godot_session",
        "answer_dialog",
        Answers::Addon("session.answer_dialog"),
        &[need("button", Text)],
    ),
    op("godot_scene", "list", Answers::Addon("scene.list"), &[]),
    op(
        "godot_scene",
        "open",
        Answers::Addon("scene.open"),
        &[need("path", Text)],
    ),
    op(
        "godot_scene",
        "create",
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
    op(
        "godot_scene",
        "save",
        Answers::Addon("scene.save"),
        &[noted(
            hidden("expectedRevision", Int),
            "Supplied by the router from the last answer that reported it, so a call never carries one. It stays accepted for a caller that holds its own.",
        )],
    ),
    op(
        "godot_scene",
        "save_as",
        Answers::Addon("scene.save_as"),
        &[
            need("path", Text),
            noted(
                hidden("expectedRevision", Int),
                "Supplied by the router from the last answer that reported it, so a call never carries one. It stays accepted for a caller that holds its own.",
            ),
        ],
    ),
    op(
        "godot_scene",
        "reload",
        Answers::Addon("scene.reload"),
        &[noted(
            hidden("expectedRevision", Int),
            "Supplied by the router from the last answer that reported it, so a call never carries one. It stays accepted for a caller that holds its own.",
        )],
    ),
    op(
        "godot_node",
        "inspect",
        Answers::Addon("node.inspect"),
        &[need("node", Text), hidden("scene", Text)],
    ),
    op(
        "godot_node",
        "create",
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
        "delete",
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
                        need("atlas", List),
                        "A [column, row] pair, naming the tile in the atlas.",
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
        Answers::Addon("node.get_cells"),
        &[need("node", Text), opt("limit", Int)],
    ),
    op(
        "godot_project",
        "get_settings",
        Answers::Addon("project.get_settings"),
        &[],
    ),
    op(
        "godot_project",
        "search_settings",
        Answers::Addon("project.search_settings"),
        &[need("query", Text)],
    ),
    op(
        "godot_project",
        "get_setting",
        Answers::Addon("project.get_setting"),
        &[need("name", Text)],
    ),
    op(
        "godot_project",
        "set_setting",
        Answers::Addon("project.set_setting"),
        &[need("name", Text), need("value", Tagged)],
    ),
    op(
        "godot_project",
        "reset_setting",
        Answers::Addon("project.reset_setting"),
        &[need("name", Text)],
    ),
    op(
        "godot_project",
        "list_autoloads",
        Answers::Addon("project.list_autoloads"),
        &[],
    ),
    op(
        "godot_project",
        "set_autoload",
        Answers::Addon("project.set_autoload"),
        &[need("name", Text), need("path", Text), opt("enabled", Flag)],
    ),
    op(
        "godot_project",
        "remove_autoload",
        Answers::Addon("project.remove_autoload"),
        &[need("name", Text)],
    ),
    op(
        "godot_project",
        "list_input_actions",
        Answers::Addon("project.list_input_actions"),
        &[],
    ),
    op(
        "godot_project",
        "set_input_action",
        Answers::Addon("project.set_input_action"),
        &[
            noted(
                need("name", Text),
                "The action's own name, like move_left, never a settings path.",
            ),
            noted(
                speaking(need("events", List), GODOT_KEY_NAME),
                "Each event is {\"kind\": \"key\", \"key\": \"A\"}, with Godot's key name rather than the browser's.",
            ),
            opt("deadzone", Number),
        ],
    ),
    op(
        "godot_project",
        "remove_input_action",
        Answers::Addon("project.remove_input_action"),
        &[need("name", Text)],
    ),
    op(
        "godot_project",
        "reset_input_action",
        Answers::Addon("project.reset_input_action"),
        &[need("name", Text)],
    ),
    op(
        "godot_project",
        "list_plugins",
        Answers::Addon("project.list_plugins"),
        &[],
    ),
    op(
        "godot_project",
        "set_plugin_enabled",
        Answers::Addon("project.set_plugin_enabled"),
        &[need("plugin", Text), need("enabled", Flag)],
    ),
    op(
        "godot_project",
        "search_editor_settings",
        Answers::Addon("editor.search_settings"),
        &[need("query", Text)],
    ),
    op(
        "godot_project",
        "get_editor_setting",
        Answers::Addon("editor.get_setting"),
        &[need("name", Text)],
    ),
    op(
        "godot_project",
        "set_editor_setting",
        Answers::Addon("editor.set_setting"),
        &[need("name", Text), need("value", Tagged)],
    ),
    op(
        "godot_resource",
        "list",
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
        Answers::Addon("resource.rescan"),
        &[noted(
            opt("path", Kind::Either(&[Text, List])),
            "The file that changed, or a list of them — name every file you just wrote in one call rather than one call each. Omitted, the whole project is walked, which is what a directory made after the editor started needs.",
        )],
    ),
    op(
        "godot_resource",
        "create_tileset",
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
        "create_shape",
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
        Answers::Addon("resource.describe_tileset"),
        &[need("path", Text)],
    ),
    op(
        "godot_resource",
        "move",
        Answers::Rust,
        &[need("from", Text), need("to", Text)],
    ),
    op(
        "godot_resource",
        "delete",
        Answers::Rust,
        &[
            need("path", Text),
            noted(
                hidden("expectedHash", Hash),
                "Supplied by the router from the read that answered with it, so a call never carries one. It stays accepted for a caller that holds its own.",
            ),
        ],
    ),
    op(
        "godot_script",
        "list",
        Answers::Rust,
        &[noted(
            opt("under", Text),
            "A directory to list, named the way the project names it — `scripts`, not its full path. Omit it for every script in the worktree.",
        )],
    ),
    op(
        "godot_script",
        "open",
        Answers::Rust,
        &[noted(
            need("path", Kind::Either(&[Text, List])),
            "One script, or a list of them — open every script you are about to query in one call rather than one call each. A list is answered with {\"files\": […]}, one entry per path, in the order you named them.",
        )],
    ),
    op(
        "godot_script",
        "update",
        Answers::Rust,
        &[need("path", Text), need("text", Text)],
    ),
    op(
        "godot_script",
        "save",
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
    op(
        "godot_script",
        "edit",
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
    op(
        "godot_script",
        "close",
        Answers::Rust,
        &[noted(
            need("path", Kind::Either(&[Text, List])),
            "One script, or a list of them — close every script you are done with in one call rather than one call each. A list is answered with {\"files\": […]}, one entry per path, in the order you named them.",
        )],
    ),
    op(
        "godot_script",
        "format",
        Answers::Rust,
        &[need("source", Text)],
    ),
    op(
        "godot_script",
        "hover",
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
        Answers::Rust,
        &[need("path", Text)],
    ),
    op(
        "godot_script",
        "workspace_symbols",
        Answers::Rust,
        &[need("query", Text)],
    ),
    op(
        "godot_script",
        "prepare_rename",
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
    op(
        "godot_script",
        "apply_rename",
        Answers::Rust,
        &[noted(
            need("files", List),
            "The list `rename` answered with, passed back unchanged.",
        )],
    ),
    op("godot_debug", "status", Answers::Rust, &[]),
    op(
        "godot_debug",
        "set_breakpoints",
        Answers::Rust,
        &[need("path", Text), opt("lines", List)],
    ),
    op(
        "godot_debug",
        "breakpoint_locations",
        Answers::Rust,
        &[need("path", Text), need("line", Int)],
    ),
    op(
        "godot_debug",
        "launch",
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
    op("godot_debug", "attach", Answers::Rust, &[]),
    op(
        "godot_debug",
        "await_stop",
        Answers::Rust,
        &[opt("threadId", Int), opt("timeoutMs", Int)],
    ),
    op("godot_debug", "threads", Answers::Rust, &[]),
    op(
        "godot_debug",
        "stack_trace",
        Answers::Rust,
        &[opt("threadId", Int)],
    ),
    op(
        "godot_debug",
        "scopes",
        Answers::Rust,
        &[need("frameId", Int)],
    ),
    op(
        "godot_debug",
        "variables",
        Answers::Rust,
        &[need("variablesReference", Int)],
    ),
    op(
        "godot_debug",
        "evaluate",
        Answers::Rust,
        &[need("expression", Text), opt("frameId", Int)],
    ),
    op(
        "godot_debug",
        "continue",
        Answers::Rust,
        &[opt("threadId", Int)],
    ),
    op(
        "godot_debug",
        "pause",
        Answers::Rust,
        &[opt("threadId", Int)],
    ),
    op(
        "godot_debug",
        "step_over",
        Answers::Rust,
        &[opt("threadId", Int)],
    ),
    op(
        "godot_debug",
        "step_in",
        Answers::Rust,
        &[opt("threadId", Int)],
    ),
    op(
        "godot_debug",
        "step_out",
        Answers::Rust,
        &[opt("threadId", Int)],
    ),
    op("godot_debug", "restart", Answers::Rust, &[]),
    op("godot_debug", "terminate", Answers::Rust, &[]),
    op(
        "godot_debug",
        "disconnect",
        Answers::Rust,
        &[opt("terminateDebuggee", Flag)],
    ),
    op("godot_runtime", "run", Answers::Addon("runtime.run"), &[]),
    op("godot_runtime", "stop", Answers::Addon("runtime.stop"), &[]),
    op(
        "godot_runtime",
        "restart",
        Answers::Addon("runtime.restart"),
        &[],
    ),
    op(
        "godot_runtime",
        "get_state",
        Answers::Addon("runtime.get_state"),
        &[],
    ),
    op(
        "godot_runtime",
        "get_tree",
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
        Answers::Addon("runtime.inspect_node"),
        &[need("path", Text), opt("properties", List)],
    ),
    op(
        "godot_runtime",
        "input",
        Answers::Addon("runtime.input"),
        &[noted(
            speaking(need("events", List), GODOT_KEY_NAME),
            "Each event is {\"kind\": \"key\", \"key\": \"A\", \"pressed\": true}, and the release is a second event.",
        )],
    ),
    op(
        "godot_runtime",
        "capture",
        Answers::Addon("runtime.capture"),
        &[opt("source", Kind::Choice(&["game", "editor"]))],
    ),
    op(
        "godot_runtime",
        "wait",
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
    op(
        "godot_runtime",
        "get_monitors",
        Answers::Addon("runtime.get_monitors"),
        &[opt("monitors", List)],
    ),
    op(
        "godot_logs",
        "read",
        Answers::Rust,
        &[
            opt("after", Int),
            opt("minSeverity", Kind::Choice(&["info", "warning", "error"])),
            opt("source", Kind::Choice(&["editor", "editorError"])),
            opt("contains", Text),
            opt("limit", Int),
        ],
    ),
    op(
        "godot_docs_search",
        "search",
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
// GENERATED-END op-params

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

/// One operation that may not share the whole of an `ops` list, and the sentence that says why.
pub struct LoneOperation {
    pub domain: &'static str,
    pub op: &'static str,
    pub scope: Sharing,
    pub reason: &'static str,
}

const fn only(
    domain: &'static str,
    op: &'static str,
    scope: Sharing,
    reason: &'static str,
) -> LoneOperation {
    LoneOperation {
        domain,
        op,
        scope,
        reason,
    }
}

/// The operations that may not share the whole of an `ops` list.
///
/// A tool call is a list, so a model that wants three inspections writes one call instead of three.
/// Thirty-five operations are narrower than that, in one of the two ways [`Sharing`] describes, and
/// the sentence beside each says which.
///
/// Generated from the row that declares the operation, like the parameters and the gate, so an
/// operation cannot be listed here under a name the catalogue no longer offers.
// GENERATED-BEGIN alone-operations sha256:c3b06b04fdcf5da4
pub const ALONE: &[LoneOperation] = &[
    only(
        "godot_session",
        "status",
        Sharing::Repeat,
        "It takes no parameters, so a second one in the same call is the first one again.",
    ),
    only(
        "godot_session",
        "start",
        Sharing::Repeat,
        "There is one editor session, so a second one in the same call is the first one again.",
    ),
    only(
        "godot_session",
        "stop",
        Sharing::Repeat,
        "There is one editor session, so a second one in the same call is the first one again.",
    ),
    only(
        "godot_session",
        "get_state",
        Sharing::Repeat,
        "It takes no parameters, so a second one in the same call is the first one again.",
    ),
    only(
        "godot_session",
        "undo",
        Sharing::Repeat,
        "One undo stack, walked in order: what the second call undoes depends on what the first one did.",
    ),
    only(
        "godot_session",
        "redo",
        Sharing::Repeat,
        "One undo stack, walked in order: what the second call undoes depends on what the first one did.",
    ),
    only(
        "godot_session",
        "answer_dialog",
        Sharing::Repeat,
        "One dialog is up at a time, and pressing a button clears it, so a second press has nothing to press.",
    ),
    only(
        "godot_scene",
        "list",
        Sharing::Repeat,
        "It takes no parameters, so a second one in the same call is the first one again.",
    ),
    only(
        "godot_scene",
        "open",
        Sharing::Repeat,
        "One scene is open at a time, so a second one would act on whatever the first left open.",
    ),
    only(
        "godot_scene",
        "save",
        Sharing::Repeat,
        "One scene is open at a time, so a second one would act on whatever the first left open.",
    ),
    only(
        "godot_scene",
        "save_as",
        Sharing::Repeat,
        "One scene is open at a time, so a second one would act on whatever the first left open.",
    ),
    only(
        "godot_scene",
        "reload",
        Sharing::Repeat,
        "One scene is open at a time, so a second one would act on whatever the first left open.",
    ),
    only(
        "godot_project",
        "get_settings",
        Sharing::Repeat,
        "It takes no parameters, so a second one in the same call is the first one again.",
    ),
    only(
        "godot_project",
        "list_autoloads",
        Sharing::Repeat,
        "It takes no parameters, so a second one in the same call is the first one again.",
    ),
    only(
        "godot_project",
        "list_input_actions",
        Sharing::Repeat,
        "It takes no parameters, so a second one in the same call is the first one again.",
    ),
    only(
        "godot_project",
        "list_plugins",
        Sharing::Repeat,
        "It takes no parameters, so a second one in the same call is the first one again.",
    ),
    only(
        "godot_debug",
        "status",
        Sharing::Repeat,
        "It takes no parameters, so a second one in the same call is the first one again.",
    ),
    only(
        "godot_debug",
        "launch",
        Sharing::Exclusive,
        "One debuggee, driven in order: each answer decides what the next call means.",
    ),
    only(
        "godot_debug",
        "attach",
        Sharing::Repeat,
        "It takes no parameters, so a second one in the same call is the first one again.",
    ),
    only(
        "godot_debug",
        "await_stop",
        Sharing::Exclusive,
        "One debuggee, driven in order: each answer decides what the next call means.",
    ),
    only(
        "godot_debug",
        "threads",
        Sharing::Repeat,
        "It takes no parameters, so a second one in the same call is the first one again.",
    ),
    only(
        "godot_debug",
        "continue",
        Sharing::Exclusive,
        "One debuggee, driven in order: each answer decides what the next call means.",
    ),
    only(
        "godot_debug",
        "pause",
        Sharing::Exclusive,
        "One debuggee, driven in order: each answer decides what the next call means.",
    ),
    only(
        "godot_debug",
        "step_over",
        Sharing::Exclusive,
        "One debuggee, driven in order: each answer decides what the next call means.",
    ),
    only(
        "godot_debug",
        "step_in",
        Sharing::Exclusive,
        "One debuggee, driven in order: each answer decides what the next call means.",
    ),
    only(
        "godot_debug",
        "step_out",
        Sharing::Exclusive,
        "One debuggee, driven in order: each answer decides what the next call means.",
    ),
    only(
        "godot_debug",
        "restart",
        Sharing::Exclusive,
        "One debuggee, driven in order: each answer decides what the next call means.",
    ),
    only(
        "godot_debug",
        "terminate",
        Sharing::Exclusive,
        "One debuggee, driven in order: each answer decides what the next call means.",
    ),
    only(
        "godot_debug",
        "disconnect",
        Sharing::Exclusive,
        "One debuggee, driven in order: each answer decides what the next call means.",
    ),
    only(
        "godot_runtime",
        "run",
        Sharing::Repeat,
        "There is one running game, so a second one in the same call is the first one again.",
    ),
    only(
        "godot_runtime",
        "stop",
        Sharing::Repeat,
        "There is one running game, so a second one in the same call is the first one again.",
    ),
    only(
        "godot_runtime",
        "restart",
        Sharing::Repeat,
        "There is one running game, so a second one in the same call is the first one again.",
    ),
    only(
        "godot_runtime",
        "get_state",
        Sharing::Repeat,
        "It takes no parameters, so a second one in the same call is the first one again.",
    ),
];
// GENERATED-END alone-operations

/// How much of a list `domain.op` may share and why, or `None` when it may share all of one.
pub fn alone_rule(domain: &str, op: &str) -> Option<(Sharing, &'static str)> {
    ALONE
        .iter()
        .find(|entry| entry.domain == domain && entry.op == op)
        .map(|entry| (entry.scope, entry.reason))
}

/// `timeoutMs` is lifted out of the parameters by the router for every command, so it is accepted
/// everywhere rather than repeated in forty tables.
///
/// `op` is not here. It names the entry rather than parameterising it, and the router takes it out
/// of the entry before anything — this check, the policy, the approval, the addon — sees one.
const UNIVERSAL: &[&str] = &["timeoutMs"];

/// The parameters of one operation, or `None` when it has no table and is therefore unchecked.
pub fn params_of(domain: &str, op: &str) -> Option<&'static [Param]> {
    TABLE
        .iter()
        .find(|entry| entry.domain == domain && entry.op == op)
        .map(|entry| entry.params)
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
                // A vocabulary is printed wherever it applies, kind or not. `key` sits inside each
                // entry of an `events` list, so no kind can name it — and the note on `Kind` above
                // is the measurement that says a signature carries this better than a sentence.
                _ if !param.vocabulary.is_empty() => {
                    let quoted: Vec<String> = param
                        .vocabulary
                        .iter()
                        .map(|word| format!("\"{word}\""))
                        .collect();
                    format!(
                        "{}{mark}: {} of {{kind, key: {}}}",
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
    }
}

/// Refuses a call whose parameters cannot possibly be right, before it leaves this process.
///
/// Everything here is arithmetic on JSON: a name that is not accepted, a missing required
/// parameter, a value of the wrong JSON type, a tagged value whose payload does not match its own
/// tag. None of it needs the editor, so none of it should cost a round trip to find out.
pub fn check(domain: &str, op: &str, params: &Value) -> Result<(), ToolFailure> {
    let Some(spec) = params_of(domain, op) else {
        return Ok(());
    };
    let Some(object) = params.as_object() else {
        return Ok(());
    };
    let call = format!("{domain} {op}");
    check_set(&call, op, "", spec, object)
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

    for key in object.keys() {
        if spec.iter().any(|param| param.name == key)
            || (where_.is_empty() && UNIVERSAL.contains(&key.as_str()))
        {
            continue;
        }
        let hint = nearest(key, spec)
            .map(|name| format!(" Did you mean `{name}`?"))
            .unwrap_or_default();
        return Err(failure(
            "unknown_param",
            format!(
                "{call}{at} has no `{key}` {noun}. {takes_shape}{hint}{}",
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
    ("color", Payload::Numbers(4)),
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
    Boolean,
    Numeric,
    Str,
    Numbers(usize),
    Items,
    Pairs,
    ResourcePath,
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
        Payload::Items => (!inner.is_array()).then(|| "an array of tagged values".to_owned()),
        Payload::Pairs => {
            (!inner.is_array()).then(|| "an array of {key, value} tagged pairs".to_owned())
        }
        Payload::ResourcePath => {
            let named = inner
                .as_object()
                .and_then(|held| held.get("path"))
                .and_then(Value::as_str)
                .is_some_and(|path| !path.is_empty());
            (!named).then(|| "an object carrying a path".to_owned())
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
        Payload::Numbers(count) => {
            numbers_under_names(inner, *count).map_or_else(String::new, |numbers| {
                let written: Vec<String> = numbers.iter().map(ToString::to_string).collect();
                format!(
                    " Send {{\"type\": \"{tag}\", \"value\": [{}]}}.",
                    written.join(", ")
                )
            })
        }
        _ => String::new(),
    };
    Err(failure(
        "invalid_param",
        join(
            format!(
                "{call} `{here}`: a {tag} value takes {expected}, and this one was {}.{fix}",
                describe(inner)
            ),
            param.note,
        ),
        json!({"param": here, "type": tag, "received": inner}),
    ))
}

/// The values a model wrote in a shape the protocol does not take, rewritten into the one it does.
///
/// Repair rather than refusal, because the refusal was tried. `{"type": "vector2", "value": {"x":
/// 32, "y": 48}}` is what one live turn wrote thirteen times in a single run; the refusal was then
/// taught to print the exact value to send instead, and the next run wrote it four more times in a
/// row, each answered with `Send {"type": "vector2", "value": [32, 48]}` and each ignored. A
/// correction a model will not read is one that cannot help it, and the numbers were never in doubt.
///
/// Only where the order is not a guess — the same table the correction is printed from — and only
/// for a parameter the operation declares as a tagged value, so this can never reach a key that
/// means something else. Everything it does not recognise is left exactly as it arrived, for
/// [`check`] to refuse by name.
///
/// The structure of a call is repaired a layer above this, in the worker's `prepareArguments`:
/// which operation an entry is, which list it belongs in, where its wrapper went. That layer needs
/// the parameter list and nothing else. This one needs the tag table, which is here.
pub fn repair(domain: &str, op: &str, params: &mut Value) {
    let Some(spec) = params_of(domain, op) else {
        return;
    };
    repair_set(spec, params);
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

fn repair_tagged(held: &mut Value) {
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
        Payload::Numbers(count) => numbers_under_names(inner, *count)
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
    fitting.next().is_none().then_some(first.name)
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

    /// A key that could only have meant one parameter is put onto it, and one that could have
    /// meant two is not.
    ///
    /// `nameSettings` for `name` is a live turn's own mistake, made nineteen times in one turn —
    /// a third of everything it did — each answered with ``Did you mean `name`?`` and each resent
    /// unchanged. `tile` is the counter-case the catalogue actually holds: `create_tileset` takes
    /// both `tileSize` and `tiles`, so `tile` names neither and stays for `check` to refuse.
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

        // A key that is not shaped like a name is left where it is, however well it reads as one.
        // This is what a model writes when its JSON comes apart: the key carries the quote and the
        // comma from the line it lost, and its value is the wreckage. Five of these in the
        // recordings, and renaming would put `", "` into `method` and call it a well-formed call.
        let mut torn = json!({"signal": "coin_collected", "binds": []});
        torn["method\": \"_on_coin_collected\", "] = json!(", ");
        repair("godot_node", "connect_signal", &mut torn);
        assert!(torn.get("method").is_none(), "{torn}");
        let refused = message("godot_node", "connect_signal", torn);
        assert!(
            refused.contains("_on_coin_collected"),
            "the refusal names the broken key rather than a parameter it was folded onto: {refused}"
        );
        // And says what arrived under it, which is what tells a model its object tore rather than
        // that it picked a wrong word. Measured: 0 of 15 recoveries without this line, 15 of 15
        // with it.
        assert!(
            refused.contains(r#"It arrived carrying ", ""#),
            "the refusal quotes the scrap that arrived: {refused}"
        );

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

    /// The nesting is printed as deeply as it goes, because the signature is where a model reads
    /// the contract — the same measurement that put kinds there in the first place.
    #[test]
    fn the_signature_carries_the_shape_inside_a_list() {
        assert_eq!(
            signature(params_of("godot_script", "edit").expect("edit declares its parameters")),
            "{files: list of {path: text, edits: list of {oldText: text, newText: text}}}"
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
    #[test]
    fn every_catalog_operation_declares_its_parameters() {
        let undeclared: Vec<String> = CATALOG
            .iter()
            .flat_map(|domain| {
                domain
                    .operations
                    .iter()
                    .filter(move |operation| params_of(domain.name, operation.op).is_none())
                    .map(move |operation| format!("{} {}", domain.name, operation.op))
            })
            .collect();
        assert!(
            undeclared.is_empty(),
            "these operations reach a handler with nothing checking their parameters:\n{}",
            undeclared.join("\n")
        );
    }

    /// Every declared operation is one the catalogue really offers, so a rename cannot leave a
    /// table behind that quietly stops checking anything.
    #[test]
    fn no_table_outlives_the_operation_it_declares() {
        for entry in TABLE {
            let domain = CATALOG
                .iter()
                .find(|domain| domain.name == entry.domain)
                .unwrap_or_else(|| panic!("{} is a catalog domain", entry.domain));
            assert!(
                domain.operations.iter().any(|op| op.op == entry.op),
                "{} {} is declared and is not an operation",
                entry.domain,
                entry.op
            );
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
}

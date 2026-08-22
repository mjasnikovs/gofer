//! The AI tool router.
//!
//! Ten compact domain tools stand in front of the handlers the renderer already calls. A tool call
//! is `{tool, params: {op, ...}}`, and this module is the only place that turns it into a real
//! operation: an addon RPC command, a script-intelligence request, a debug-adapter request, a page
//! of session logs, or a documentation retrieval. There is no second implementation of any of them
//! — the agent and the UI reach identical code, so a scene the agent edits goes through the same
//! undo stack, the same revision check, and the same worktree binding as one the user edits.
//!
//! The catalog below is also the contract the Node worker receives at startup: the tool names,
//! their operations, and the parameter hints the model sees are generated from it and validated
//! against it, so a tool the model can call always exists here, and one it cannot call never does.
//!
//! Every call also passes [`crate::approvals`] on its way in: most operations are auto-allowed
//! because the worktree and the editor's undo stack can take them back, and the few that leave both
//! of those nets wait for the user before they reach a handler.

use crate::approvals;
use crate::debug::{self, DebugRequest};
use crate::files;
use crate::gdformat;
use crate::godot_session::{self, LogQuery};
use crate::godot_session_api::{self, CallGodotRequest, StartGodotSessionRequest};
use crate::rag;
use crate::script::{self, ScriptRequest};
use crate::tool_params::Sharing;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::{AppHandle, Runtime};

/// One tool call as the Node worker sends it.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolRequest {
    pub tool: String,
    #[serde(default)]
    pub params: Value,
}

/// A structured tool failure. Every handler this router calls already reports code, message,
/// retryability, and details, so the shape is theirs rather than a flattened string.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolFailure {
    pub code: String,
    pub message: String,
    pub retryable: bool,
    pub details: Value,
}

impl ToolFailure {
    fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_owned(),
            message: message.into(),
            retryable: false,
            details: json!({}),
        }
    }
}

/// The errors of every handler behind the router already share one shape, so the conversion is
/// mechanical and carries them whole: a `revision_conflict` or a `file_conflict` reaches the model
/// as that code rather than as flattened prose.
macro_rules! tool_failure_from {
    ($($type:ty),*) => {
        $(impl From<$type> for ToolFailure {
            fn from(error: $type) -> Self {
                Self {
                    code: error.code.to_string(),
                    message: error.message,
                    retryable: error.retryable,
                    details: error.details,
                }
            }
        })*
    };
}

tool_failure_from!(
    crate::approvals::ApprovalError,
    crate::godot_rpc::RpcError,
    crate::godot_lsp::LspError,
    crate::godot_dap::DapError,
    crate::files::FileError,
    crate::gdformat::GdformatError,
    crate::godot_session::SessionError
);

/// One operation of a domain tool, as the model is told about it.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolOperation {
    pub op: &'static str,
    pub summary: &'static str,
}

/// One domain tool: a name, what it is for, and every operation it accepts.
///
/// Serialization is hand-written because an operation's parameters are not stored on it. They live
/// in [`crate::tool_params`], which is also what refuses a call, so attaching them here would be a
/// second copy of the same contract — the exact drift this design removes. The worker receives the
/// merge: the prose from this file, the signature and parameter list from that one.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ToolDomain {
    pub name: &'static str,
    pub description: &'static str,
    pub operations: &'static [ToolOperation],
}

impl Serialize for ToolDomain {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let operations: Vec<Value> = self
            .operations
            .iter()
            .map(|operation| {
                let params = crate::tool_params::params_of(self.name, operation.op);
                json!({
                    "op": operation.op,
                    "summary": operation.summary,
                    // Absent when the operation has no table, so the worker can tell "takes
                    // nothing" from "nobody wrote the contract down yet".
                    "signature": params.map(crate::tool_params::signature),
                    "params": params,
                    // How much of an `ops` list this one may share, and why, or null when it may
                    // share all of one. The model is told here rather than finding out from a
                    // refusal: `ops` exists to save round trips, so learning its narrowing by
                    // spending one is the wrong way round.
                    "alone": crate::tool_params::alone_rule(self.name, operation.op)
                        .map(|(scope, why)| json!({"scope": scope, "why": why})),
                })
            })
            .collect();
        let mut domain = serializer.serialize_struct("ToolDomain", 3)?;
        domain.serialize_field("name", self.name)?;
        domain.serialize_field("description", self.description)?;
        domain.serialize_field("operations", &operations)?;
        domain.end()
    }
}

const fn operation(op: &'static str, summary: &'static str) -> ToolOperation {
    ToolOperation { op, summary }
}

/// The ten domain tools. Compact on purpose: one tool per domain with an `op`, rather than a
/// hundred flat tools that would fill the model's context with names it will never call.
pub const CATALOG: &[ToolDomain] = &[
    ToolDomain {
        name: "godot_session",
        description: "Owns the managed Godot editor session bound to the active task worktree.",
        operations: &[
            operation(
                "status",
                "Reports the session state, ports, engine version, and worktree.",
            ),
            operation(
                "start",
                "Starts the editor session for the active task worktree.",
            ),
            operation(
                "stop",
                "Stops the editor session and removes the staged Gofer addon.",
            ),
            operation(
                "get_state",
                "Asks the addon for readiness, the open scene, its revision, and the dialog the \
                 editor is waiting on. A `dialog` is a question only a person can answer — its \
                 text and the buttons it offers — and until someone presses one the editor will \
                 not run the game. Nothing else reports it: commands are still answered while one \
                 is up, and a screenshot of the editor need not contain it.",
            ),
            operation(
                "answer_dialog",
                "Presses a button on the dialog the editor is waiting on, by its label — one of \
                 the `buttons` the dialog was reported with. Use it when a dialog is blocking the \
                 work; there is no other way past one, and nothing else you can do will clear it. \
                 Read what it asks before choosing: the buttons do what they say, and some of \
                 them change the project.",
            ),
            operation("undo", "Undoes the last editor operation."),
            operation("redo", "Redoes the last undone editor operation."),
        ],
    },
    ToolDomain {
        name: "godot_scene",
        description: "The edited scene in the editor — never the running game's scene tree. Every \
                      mutation here is checked against the scene's revision, and the router supplies \
                      that number from the last answer that carried one, so never pass it and never \
                      read the tree to fetch it.",
        operations: &[
            operation("list", "Lists the scene files in the project."),
            operation("open", "Opens a scene."),
            operation(
                "create",
                "Creates a scene and opens it. It is checked against the revision of the scene \
                 being *replaced*, because creating a scene discards whatever is unsaved in the \
                 open one — which is what the check is for. The router holds that number already.",
            ),
            operation(
                "get_tree",
                "Returns the edited scene hierarchy and its revision. Read it to see what the \
                 scene holds, not to fetch a revision: every mutation is checked against a number \
                 the router already has, and answers with the next one.",
            ),
            operation("save", "Saves the edited scene."),
            operation("save_as", "Saves the edited scene to a new path."),
            operation(
                "reload",
                "Reloads the edited scene from disk, discarding in-memory edits.",
            ),
        ],
    },
    ToolDomain {
        name: "godot_node",
        description: "Node authoring inside the edited scene. Every mutation is undoable and every \
                      one of them is checked against the scene's revision — which the router \
                      supplies from the last answer that carried one, and every mutation's own \
                      answer carries the next. So mutate, then mutate again: there is no revision to \
                      pass and no tree to re-read between them. Paths are the scene's own, like \
                      /Level1 or /Level1/Ground.",
        operations: &[
            operation(
                "inspect",
                "Inspects a node. Answers with its type, every property with its current \
                 value, its groups, every signal it can emit, and the connections it already has. \
                 Read a property here before setting it rather than guessing what it holds; \
                 `stored` is false for properties the scene recomputes, like a Control's position \
                 and size and every theme_override_*, and those are set the same way as any other.",
            ),
            operation(
                "create",
                "Creates a node. `parent` is the \
                 parent's path — the root's own path, like /Level1, for a direct child.",
            ),
            operation(
                "create_nodes",
                "Creates several nodes in one call, as one revision and one undo step. Prefer this \
                 over calling create in a row: create answers with the revision the next create \
                 needs, so forty nodes one at a time is forty round trips. Each `nodes` entry is \
                 exactly what create takes. Entries are applied in \
                 order, so a later entry may name a node an earlier entry creates as its parent, \
                 and a whole subtree goes in at once. Nothing is attached unless every entry is \
                 accepted.",
            ),
            operation(
                "instantiate",
                "Places an instance of a saved scene under a node. This is how a level repeats a thing — build the coin once as \
                 its own scene, then instantiate it wherever a coin goes, and one edit reaches \
                 every placement. `node.create` cannot do this: it only builds engine classes.",
            ),
            operation("duplicate", "Duplicates a node."),
            operation("rename", "Renames a node."),
            operation("reparent", "Reparents a node."),
            operation("delete", "Deletes a node."),
            operation(
                "set_property",
                "Sets a property. `value` is tagged \
                 with its type — a `type` beside a `value`: {\"type\": \"vector2\", \"value\": [12, 34]}, \
                 {\"type\": \"float\", \"value\": 1.5}, {\"type\": \"string\", \"value\": \"hi\"}. \
                 A property that holds a resource — a CollisionShape2D's `shape`, a Sprite2D's \
                 `texture` — takes {\"type\": \"resource\", \"value\": {\"path\": \"res://…\"}}, \
                 never a string: a path written as a string is refused. The other tags are null, \
                 bool, int, color, rect2 and rect2i (four numbers each), vector2i, vector3, \
                 vector3i, vector4, vector4i, quaternion, plane, transform2d, basis, transform3d, \
                 array (of tagged values) and dictionary (of key and value pairs of them).",
            ),
            operation(
                "set_properties",
                "Sets several properties in one call, as one revision and one undo step. Prefer \
                 this over calling set_property in a row, for the same reason create_nodes exists: \
                 each single write answers with the revision the next one needs. Each `properties` \
                 entry is exactly what set_property takes, with `value` tagged the same way, and \
                 entries may name different nodes. Nothing is written unless every entry is \
                 accepted.",
            ),
            operation(
                "add_to_group",
                "Puts a node in a group the saved scene keeps. \
                 Groups are how a running game finds every coin or enemy at once, with \
                 get_tree().get_nodes_in_group(\"…\").",
            ),
            operation("remove_from_group", "Takes a node out of a group."),
            operation(
                "connect_signal",
                "Connects a node's signal to a method, as an editor connection the scene keeps. \
                 `target` is the node carrying the method and defaults to the scene root; the \
                 method has to exist there already, so write the script first. `binds` are extra \
                 tagged values passed after the signal's own arguments. This is how a scene wires \
                 itself up without a `connect` call in _ready.",
            ),
            operation(
                "disconnect_signal",
                "Removes a connection. \
                 `binds` are tagged values like connect_signal's, and have to match the ones the \
                 connection was made with or nothing is found to remove.",
            ),
            operation(
                "set_cells",
                "Paints tiles onto a TileMapLayer. This is how a \
                 2D level is built — one TileMapLayer carrying a tileset, rather than a node per \
                 block. `x`/`y` are cell coordinates, not pixels, and `width`/`height` default to \
                 1 so a rectangle is one entry — a whole ground row is {\"x\": 0, \"y\": 12, \
                 \"width\": 200, \"height\": 2, \"atlas\": [0, 0]}. `atlas` is the [column, row] of \
                 the tile in the tileset, which resource.describe_tileset lists. An entry with no \
                 `atlas` erases the cells it covers. The node needs its `tile_set` property set \
                 first, with node.set_property and a resource value.",
            ),
            operation(
                "get_cells",
                "Reads back what a TileMapLayer holds. Answers with how many cells \
                 are painted, the rectangle they span, and the tile each one draws.",
            ),
        ],
    },
    ToolDomain {
        name: "godot_project",
        description: "Project settings, autoloads, the Input Map, plugins, and machine-wide editor \
                      settings. Project writes persist in the task worktree; editor settings are \
                      machine-wide and outside Git.",
        operations: &[
            operation("get_settings", "Returns the project settings overview."),
            operation(
                "search_settings",
                "Searches project settings by name. Answers with at most 50 matches, \
                 plus `totalMatches` and `truncated` — narrow the query rather than ask for more, \
                 because there is no limit to raise.",
            ),
            operation("get_setting", "Reads one project setting."),
            operation(
                "set_setting",
                "Writes one project setting. `value` is tagged with its type, the \
                 same shape node.set_property takes: {\"type\": \"int\", \"value\": 1152}, \
                 {\"type\": \"string\", \"value\": \"res://main.tscn\"}, {\"type\": \"vector2\", \
                 \"value\": [12, 34]}. A bare number or string is refused.",
            ),
            operation("reset_setting", "Resets a project setting to its default."),
            operation("list_autoloads", "Lists the configured autoloads."),
            operation("set_autoload", "Adds or updates an autoload."),
            operation("remove_autoload", "Removes an autoload."),
            operation("list_input_actions", "Lists the Input Map actions."),
            operation(
                "set_input_action",
                "Writes an input action. `name` is the action's own \
                 name, like move_left, never a settings path. Each event names its kind and its \
                 key, as {\"kind\": \"key\", \"key\": \"A\"} — the same shape list_input_actions \
                 answers with. The named keys are in the signature; F1 to F16, A to Z and 0 to 9 \
                 are spelled as they read. The other kinds are mouse_button and joypad_button, \
                 each taking a `button` index.",
            ),
            operation("remove_input_action", "Removes a project input action."),
            operation(
                "reset_input_action",
                "Drops the override of a built-in action.",
            ),
            operation("list_plugins", "Lists the project's editor plugins."),
            operation("set_plugin_enabled", "Enables or disables a plugin."),
            operation(
                "search_editor_settings",
                "Searches machine-wide editor settings by name. Capped at 50 matches, \
                 like search_settings.",
            ),
            operation(
                "get_editor_setting",
                "Reads one machine-wide editor setting.",
            ),
            operation(
                "set_editor_setting",
                "Writes one machine-wide editor setting. `value` is tagged with its \
                 type, as {\"type\": \"bool\", \"value\": true} — the same shape set_setting and \
                 node.set_property take.",
            ),
        ],
    },
    ToolDomain {
        name: "godot_resource",
        description: "Project files as the editor sees them. Deleting and moving need the user's \
                      approval; nothing outside the task worktree can be named at all.",
        operations: &[
            operation(
                "list",
                "Lists the files in the task worktree with their sizes. `under` narrows it to one \
                 directory — `assets`, named the way the project names it — and without it you get \
                 the whole worktree, which is a lot to read to see one folder. `hashes: true` \
                 reads every file so that a later delete of one is refused if it changed in the \
                 meantime. The router holds what it read; you never see it and never pass it. That \
                 is a read of the whole project, so ask for it before deleting files you have not \
                 opened, not to look around.",
            ),
            operation(
                "rescan",
                "Tells the editor filesystem about files that changed. `path` is one \
                 file or a list of them — name everything you just wrote in one call, because a \
                 batch is imported in one pass and a call per file is not. Omit it to walk the \
                 whole project.",
            ),
            operation(
                "create_tileset",
                "Cuts a texture into a TileSet and saves it. `path` is the .tres to write, `texture` an image the project already \
                 holds, and `tileSize` one number or two — 16 or [16, 16] — defaulting to 16. \
                 `tiles` is the [column, row] list to define and defaults to every tile the texture \
                 holds; `solid` is the subset that gets collision, either a list or \"all\", and a \
                 tile with no collision is scenery the player falls through. Answers with the \
                 atlas grid it found. Build a tileset with this rather than writing one as text: a \
                 TileSet carries a record per tile and a polygon per solid one, and a hand-written \
                 one opens as a resource with no tiles in it.",
            ),
            operation(
                "create_shape",
                "Saves a 2D collision shape as a resource. `path` is the .tres to write. `shapeType` is one of \
                 RectangleShape2D (size as [width, height]), CircleShape2D (radius), \
                 CapsuleShape2D (radius and height), SegmentShape2D (points as [ax, ay, bx, by]), \
                 or WorldBoundaryShape2D (nothing). Set the node's `shape` property to the path \
                 afterwards — a CollisionShape2D without one collides with nothing, and a shape \
                 can only be assigned from a file that already exists.",
            ),
            operation(
                "describe_tileset",
                "Reports what a saved TileSet holds. Answers with its tile size, its \
                 sources, and every tile they define with whether it is solid — which is where the \
                 [column, row] pairs godot_node set_cells takes come from.",
            ),
            operation("move", "Moves a file or directory inside the worktree."),
            operation(
                "delete",
                "Deletes a file or directory. A file you have read is deleted as you last read it: the \
                 router holds the hash that read answered with and refuses the delete if the file \
                 changed since, so read it first when it matters that nothing moved underneath.",
            ),
        ],
    },
    ToolDomain {
        name: "godot_script",
        description: "GDScript editing and intelligence through Godot's language server. Positions \
                      are {line, character}, zero-based. Open a script before querying it — and \
                      write GDScript here rather than with the file tools, which refuse a .gd, \
                      because writing here is what tells the server whether it parses. A script \
                      that does not parse stops the scene using it from loading. `edit` changes a \
                      script that exists and answers with its diagnostics, so it needs no \
                      `diagnostics` call after it; `save` creates one, and `diagnostics` on the \
                      same path is what then says whether it parses. Paths may be named either \
                      way, `scripts/mario.gd` or res://scripts/mario.gd.",
        operations: &[
            operation(
                "list",
                "Lists the GDScript files in the worktree with their size. `under` narrows it to \
                 one directory, named the way the project names it — `scripts`, not its full path \
                 — and omitting it lists every script. This is the call for finding a script whose \
                 name you do not know; a shell `find` is not, and it is refused outside the \
                 worktree anyway.",
            ),
            operation(
                "open",
                "Opens a script as a language-server document. `path` is one script or a list of \
                 them — open everything you are about to query in one call, not one call each. A \
                 list answers with `files`, one entry per path.",
            ),
            operation("update", "Reports an in-memory buffer change."),
            operation(
                "edit",
                "Changes existing scripts by replacing exact text, and answers with each file's \
                 diagnostics. Put every change to one file in that file's `edits`, and every \
                 file in one call: this is one call, not one per change. `oldText` must appear \
                 exactly once in the file, so extend it with a neighbouring line when it would \
                 not; it is quoted from the file, so read the file first. Either every file is \
                 written or none is. To create a script, use `save`.",
            ),
            operation(
                "save",
                "Writes a whole file and answers with the file's diagnostics, the same way `edit` \
                 does. Use it to create a script, or to replace one outright; to change part of \
                 one, `edit` is the call, and it does not send the file back. A file that already \
                 exists is only written over what you have read, so open it first — the router \
                 holds the hash that read answered with. A script you are creating needs no read. \
                 `update` does not write anything: it reports a buffer change to the language \
                 server, and this is the call that puts it on disk. Do not follow this with a \
                 `diagnostics` call about the same file: the verdict is already here. \
                 `published: false` means the server had not spoken about the text yet, which is \
                 not the same as the file being clean.",
            ),
            operation(
                "close",
                "Closes the document. `path` is one script or a list of them, and a list answers \
                 with `files`, one entry per path.",
            ),
            operation(
                "format",
                "Formats source through the pinned gdformat sidecar.",
            ),
            operation("hover", "Hover documentation."),
            operation("completion", "Completion items."),
            operation("signature_help", "Signature help."),
            operation("definition", "Go to definition."),
            operation("declaration", "Go to declaration."),
            operation("references", "Find references."),
            operation("highlights", "Document highlights."),
            operation(
                "diagnostics",
                "Diagnostics the server published for a file. `path` is one script or a list of \
                 them — ask about every script you just wrote in one call, not one call each, \
                 because a list shares one wait for the whole batch and a call per file waits that \
                 long per file. A list answers with `files`, one entry per path. Answers \
                 `published: false` when the server has not said anything about that file yet, \
                 which is not the same as the file being clean — ask again rather than take an \
                 empty list for an answer. An empty list with `published: true` is a file that \
                 parses.",
            ),
            operation("document_symbols", "Symbols of one document."),
            operation("workspace_symbols", "Symbols across the worktree."),
            operation("prepare_rename", "Checks whether a symbol can be renamed."),
            operation("rename", "Plans a rename without writing."),
            operation(
                "apply_rename",
                "Applies a planned rename in one transaction. `files` is the list \
                 `rename` answered with, passed back unchanged — each entry carries path, \
                 originalText, originalHash and updatedText, and a hand-built one is refused.",
            ),
        ],
    },
    ToolDomain {
        name: "godot_debug",
        description: "Godot's debug adapter. Install breakpoints with the launch itself, then wait \
                      for a stop before inspecting: stopping is an event, not a response.",
        operations: &[
            operation(
                "status",
                "Connects to the adapter and reports its capabilities.",
            ),
            operation("set_breakpoints", "Replaces the breakpoints of one script."),
            operation("breakpoint_locations", "Validates candidate lines."),
            operation(
                "launch",
                "Runs the project under the debugger. Give `breakpoints` when the game has to \
                  stop somewhere before you can look at it; without them it runs to completion \
                  and there is nothing to inspect.",
            ),
            operation(
                "attach",
                "Attaches to a game already running under this adapter.",
            ),
            operation(
                "await_stop",
                "Waits for the next stop. Null means it ended.",
            ),
            operation("threads", "Lists the debuggable threads."),
            operation("stack_trace", "Returns the stopped stack."),
            operation("scopes", "Returns Locals, Members, and Globals of a frame."),
            operation("variables", "Expands a scope or object."),
            operation("evaluate", "Evaluates an expression in a frame."),
            operation("continue", "Resumes the debuggee."),
            operation("pause", "Pauses the debuggee."),
            operation("step_over", "Steps over one line."),
            operation("step_in", "Steps into the call at the current line."),
            operation("step_out", "Steps out of the current frame (emulated)."),
            operation(
                "restart",
                "Restarts the debuggee with the last launch arguments.",
            ),
            operation("terminate", "Stops the debuggee, keeping the adapter."),
            operation("disconnect", "Detaches."),
        ],
    },
    ToolDomain {
        name: "godot_runtime",
        description: "The running game: its live scene tree, input, performance, and screenshots. \
                      Distinct from the edited scene, and named differently: every path here \
                      starts at /root, where godot_node's start at the edited scene's own root.",
        operations: &[
            operation("run", "Runs the project and captures the first frame."),
            operation("stop", "Stops the running game."),
            operation("restart", "Restarts the running game."),
            operation(
                "get_state",
                "Reports whether a game is running, its helper is ready, and the debugger has it \
                 paused at an error.",
            ),
            operation(
                "get_tree",
                "Returns the running game's scene tree, and `paused`: whether the tree is paused \
                 right now. That one belongs to the SceneTree rather than to any node, so \
                 `inspect_node` cannot reach it and this is the only call that reports it.",
            ),
            operation(
                "inspect_node",
                "Inspects a running node. `properties` is the list of \
                 property names to read, like [\"position\", \"velocity\"]; without it the answer \
                 carries the node's path, name and type and an empty property map, so name what \
                 you want to see. A name the node does not have is an error rather than a gap.",
            ),
            operation(
                "input",
                "Injects input and captures the result. Each event names its kind and \
                 the parameters that kind uses, as {\"kind\": \"key\", \"key\": \"A\", \
                 \"pressed\": true} — send the release as a second event, or the key stays down. \
                 The named keys are in the signature; F1 to F16, A to Z and 0 to 9 are spelled as \
                 they read. A mouse button is named left, right, middle, wheel_up or wheel_down, \
                 or given as an index. A position is [x, y]. This \
                 drives the Input Map, so it is how you check that a level you built can actually \
                 be played.",
            ),
            operation("capture", "Captures a PNG frame."),
            operation(
                "wait",
                "Lets the game run on for a few frames, then answers with how many passed and how \
                 long it took. This is how you wait for something the game does over time — a \
                 tween, a timer, a unit walking somewhere — before capturing or inspecting it. \
                 Never wait by running `sleep` in bash: that stops this process rather than \
                 letting the game advance, and it costs a whole request to do nothing.",
            ),
            operation(
                "get_monitors",
                "Reads engine performance monitors. Without a list it answers with \
                 fps, memory_static and object_node_count. The rest are process_time, \
                 physics_time, memory_message_buffer, object_count, object_resource_count, \
                 object_orphan_node_count, render_objects_in_frame, render_primitives_in_frame, \
                 render_draw_calls_in_frame, render_video_memory, render_texture_memory and \
                 render_buffer_memory; any other name is an error.",
            ),
        ],
    },
    ToolDomain {
        name: "godot_logs",
        description: "The session's captured output — editor, importer, plugin, and the game the \
                      editor launched — with a cursor and severity filtering.",
        operations: &[operation(
            "read",
            "Reads a page. `editor` is the editor's stdout, \
             which also carries what the game printed; `editorError` is where the engine reports \
             its own failures, including a script that would not parse.",
        )],
    },
    ToolDomain {
        name: "godot_docs_search",
        description: "The Godot 4.7 documentation, on this machine. SEARCH IT BEFORE writing a \
                      class, method, signal or constant name, and before answering any question \
                      about how the engine behaves. Do not answer either from memory and do not \
                      reason it out from the name: what you remember is mostly Godot 3, where a \
                      great many of these names were spelled differently, and a name this does not \
                      return is a name to check rather than to guess at. Passages cite a chapter, \
                      never a URL. It holds the engine's documentation and nothing else, so send a \
                      question about this project's own scripts, scenes or files to the subagent \
                      tool instead.",
        operations: &[
            operation(
                "search",
                "Retrieves ranked passages for a question in plain words. Use it to see which \
                 chapters the manual has on a subject at all — when the question is which class \
                 to reach for, the list of chapters is the answer.",
            ),
            operation(
                "ask",
                "Answers one question from those same passages and hands back a paragraph and a \
                 quote instead of the chapters. Use it when you want one fact — a signature, an \
                 argument, what a property does — and would only have read one line out of what \
                 `search` returns. The quote is checked against the manual: an answer that arrives \
                 with a warning that its quote is not there was written from memory, and is not \
                 evidence. It needs a model connection, where `search` does not.",
            ),
        ],
    },
];

/// The key names a summary advertises, split into the ones it offers and the ones it says are
/// refused.
///
/// The summary of one catalog operation, for the tests and the acceptance suite that hold the
/// prose to the addon behind it.
#[cfg(test)]
pub fn summary_of(tool: &str, op: &str) -> &'static str {
    CATALOG
        .iter()
        .find(|domain| domain.name == tool)
        .and_then(|domain| {
            domain
                .operations
                .iter()
                .find(|operation| operation.op == op)
        })
        .unwrap_or_else(|| panic!("{tool} {op} is in the catalog"))
        .summary
}

/// Asking the user something, by the name the worker sends it under.
///
/// Deliberately not a [`CATALOG`] domain. Everything in that list is a Godot domain with an addon
/// handler, an `ops` list and a generated parameter contract, and a question has none of those. It
/// is a host operation the same way storing a credential is — it lives in Rust because the window
/// does, not because it belongs to the editor.
pub const ASK_USER_TOOL: &str = "ask_user";

/// The name the design tool calls to bracket its loop. Not a catalogue domain, for [`ASK_USER_TOOL`]'s
/// reasons, and not a model tool either: nothing chooses to call it.
pub const DESIGN_SESSION_TOOL: &str = "design_session";

/// Tells the window a design loop started or finished, and answers at once.
///
/// The one call here that opens nothing and waits for nobody. A design loop asks the user several
/// questions about one layout, and without these two edges the window cannot tell that from several
/// questions about several things — so it closes its card on every answer and reopens it a minute
/// later, which is what this exists to stop.
fn design_session<R: Runtime>(app: &AppHandle<R>, params: &Value) -> Result<Value, ToolFailure> {
    if params.get(PROBE_KEY).and_then(Value::as_bool) == Some(true) {
        return probe(DESIGN_SESSION_TOOL);
    }
    let session_id = params
        .get("sessionId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .ok_or_else(|| invalid("design_session needs a `sessionId`."))?;
    let opening = match params.get("state").and_then(Value::as_str) {
        Some("open") => true,
        Some("closed") => false,
        _ => {
            return Err(invalid(
                "design_session needs a `state` of 'open' or 'closed'.",
            ));
        }
    };
    crate::ask::design_session(app, session_id, opening);
    Ok(json!({"sessionId": session_id, "state": if opening { "open" } else { "closed" }}))
}

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
fn ask_user<R: Runtime>(app: &AppHandle<R>, params: &Value) -> Result<Value, ToolFailure> {
    if params.get(PROBE_KEY).and_then(Value::as_bool) == Some(true) {
        return probe(ASK_USER_TOOL);
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
        .unwrap_or_else(crate::ask::new_question_id);
    // Put there by the design tool, never by the model. It says these questions are one layout being
    // revised, which is the difference between a card that stays put and a card that reopens.
    let design_session = params
        .get("designSession")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_owned);

    // Resolved before anything is shown, so the user judges a layout with the game's own artwork in
    // it rather than with the window's default typeface.
    //
    // The model's own markup is kept beside the resolved copy, because the two are read by different
    // readers. The window is shown the resolved one, so a sprite is a sprite. The agent that asked
    // for the design is handed the original: inlining turns a 2KB layout into 80KB of base64 that
    // says nothing a builder can act on, and `res://` is the path it has to build against anyway.
    let (shown, unresolved) = resolve_sketch_assets(app, sketches.clone());

    match crate::ask::ask_question(
        app,
        &question_id,
        question,
        options,
        shown.clone(),
        why,
        design_session,
    ) {
        crate::ask::Answer::Answered(reply) => {
            keep_sketch(app, &question_id, question, &sketches, &shown, &reply);
            Ok(reply_answer(&question_id, &sketches, &reply, unresolved))
        }
        crate::ask::Answer::TimedOut => Err(ToolFailure::new(
            "question_timeout",
            "Nobody answered the question in time. Decide it yourself and say which way you went.",
        )),
        crate::ask::Answer::Cancelled => Err(ToolFailure::new(
            "question_cancelled",
            "The question was cancelled because the run ended.",
        )),
        crate::ask::Answer::Unavailable => Err(ToolFailure::new(
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
    sketches: Vec<crate::ask::Sketch>,
) -> (Vec<crate::ask::Sketch>, Vec<String>) {
    let Ok(workspace) = crate::active_workspace(app) else {
        return (sketches, Vec::new());
    };
    let mut refused = Vec::new();
    let resolved = sketches
        .into_iter()
        .map(|sketch| {
            let (html, missing) = inline_project_assets(&workspace, &sketch.html);
            refused.extend(missing);
            crate::ask::Sketch { html, ..sketch }
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
    sketches: &[crate::ask::Sketch],
    reply: &crate::ask::Reply,
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
        "approved": reply.approved,
        "answer": reply.text,
        "picked": picked,
        "sketch": chosen,
        "sketches": sketches.len(),
        "blocked": reply.blocked,
        "unresolved": unresolved,
    })
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
    sketches: &[crate::ask::Sketch],
    shown: &[crate::ask::Sketch],
    reply: &crate::ask::Reply,
) {
    let Some((source, shown_html)) = chosen_sketch(sketches, shown, reply) else {
        return;
    };
    let Ok(storage) = crate::workspace::project_storage(app) else {
        return;
    };
    let task_id = storage.tasks().active().ok().flatten();
    let _ = storage.sketches().keep(&crate::storage::KeptSketch {
        sketch_id: &crate::ask::new_sketch_id(question_id),
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
    sketches: &'a [crate::ask::Sketch],
    shown: &'a [crate::ask::Sketch],
    reply: &crate::ask::Reply,
) -> Option<(&'a crate::ask::Sketch, &'a str)> {
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
/// `scripts/ai-host.mjs`.
const MAX_SKETCH_CHARS: usize = 8_000;

fn invalid(message: impl Into<String>) -> ToolFailure {
    ToolFailure::new("invalid_params", message)
}

/// Reads the sketches out of the call, refusing every shape the renderer could not draw.
///
/// Absent and empty both mean a question in words, which is what most questions are. Only a
/// `sketches` that is present and misshapen is a mistake worth naming.
fn requested_sketches(params: &Value) -> Result<Vec<crate::ask::Sketch>, ToolFailure> {
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
            Ok(crate::ask::Sketch {
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

/// Marks a tool request as a reachability probe rather than an operation.
///
/// The worker sends one per declared tool before the turn starts; the same constant is
/// `PROBE_REQUEST` in `scripts/ai-reachability.mjs`. The model cannot forge one: the tools it is
/// given take `{op, params}`, so nothing it writes reaches this level of the call.
const PROBE_KEY: &str = "probe";

/// Answers whether the model could really use this tool right now.
///
/// Nine domains route to the editor session, the debug adapter or the log buffer, all of which are
/// compiled into this binary and start with the session — being routed is the whole of their
/// reachability. `godot_docs_search` is the exception, and the reason this exists: it answers
/// through a sidecar script and a model cache that live outside the binary, so it can be declared
/// to the model while nothing behind it can answer, which is what ten live sweeps found.
///
/// A domain added to the catalog without a probe fails here rather than defaulting to reachable.
fn probe(domain: &str) -> Result<Value, ToolFailure> {
    match domain {
        "godot_session" | "godot_scene" | "godot_node" | "godot_project" | "godot_resource"
        | "godot_script" | "godot_debug" | "godot_runtime" | "godot_logs" => {
            Ok(json!({"tool": domain, "reachable": true}))
        }
        "godot_docs_search" => {
            let worker = rag::probe_retrieval()
                .map_err(|error| ToolFailure::new("docs_unavailable", error))?;
            Ok(json!({"tool": domain, "reachable": true, "worker": worker}))
        }
        // Answered without looking for a window, and that is the deliberate part. The probe runs
        // once before the turn; whether a window is open is a thing that changes during one, and a
        // turn refused at the start because the user had the window minimised would be refusing
        // work over a state that no longer holds by the time the tool is called. Asking with no
        // window is refused at the call, by name, which is where the answer is still true.
        // Answered together, and without looking for a window, for the reason above: whether a
        // window is open is a thing that changes during a turn, and the call is where the answer is
        // still true.
        ASK_USER_TOOL | DESIGN_SESSION_TOOL => Ok(json!({"tool": domain, "reachable": true})),
        other => Err(ToolFailure::new(
            "unprobed_tool",
            format!(
                "The {other} tool is in the catalog with no reachability probe, so nothing proves \
                 the model can use it"
            ),
        )),
    }
}

/// Answers one tool call by routing it to the handler the renderer uses for the same operation.
pub fn dispatch<R: Runtime>(
    app: &AppHandle<R>,
    request: ToolRequest,
) -> Result<Value, ToolFailure> {
    // A settings file that cannot be read falls back to the rules being on, which is what a machine
    // that never chose gets. Failing open would make an unreadable settings file the way past them.
    let rules = crate::settings::read_godot_settings(app).unwrap_or_default();
    dispatch_under(app, request, &rules)
}

/// The router proper, with the user's Godot rules passed in rather than read.
///
/// Separate so the tests can state the rules they are testing. Read inside, every assertion about a
/// refusal would be an assertion about whichever `settings.json` the machine running the test
/// happens to hold — which on a developer's machine is a real one they may have edited.
fn dispatch_under<R: Runtime>(
    app: &AppHandle<R>,
    request: ToolRequest,
    rules: &crate::settings::GodotSettings,
) -> Result<Value, ToolFailure> {
    // The agent dispatches its calls in parallel, so a stopped turn usually leaves several queued
    // behind the one that was running. None of them has an agent left to answer.
    if crate::cancel::is_cancelled() {
        return Err(ToolFailure::new(
            "cancelled",
            "The turn was stopped before this tool call ran",
        ));
    }
    // Asked before the catalogue, because it is not a catalogue entry and must not become one. The
    // catalogue is the Godot domains — ten of them, asserted — and a question to the user is not a
    // Godot operation, has no addon handler and takes no `ops` list. It is routed here for the same
    // reason `web_search` is built in Node: this is simply where the thing that answers it lives.
    if request.tool == ASK_USER_TOOL {
        return ask_user(app, &request.params);
    }
    // Beside `ask_user` and for the same reason: not a Godot operation, so not a catalogue domain.
    // It is also not a tool any model holds — the design tool calls it around its own child, and a
    // model has no way to reach it, which is why it needs no description and no probe.
    if request.tool == DESIGN_SESSION_TOOL {
        return design_session(app, &request.params);
    }
    let domain = CATALOG
        .iter()
        .find(|domain| domain.name == request.tool)
        .ok_or_else(|| {
            ToolFailure::new(
                "unknown_tool",
                format!("There is no '{}' tool", request.tool),
            )
        })?;
    // Answered before the operation is read — a probe names none — and before approvals, because
    // proving that a tool can answer must never open a dialog for the user to click.
    if request.params.get(PROBE_KEY).and_then(Value::as_bool) == Some(true) {
        return probe(domain.name);
    }
    let mut entries = requested_operations(domain, &request.params)?;

    // The shapes a model writes that mean exactly one thing, put into the shape the protocol takes,
    // before anything is held to it. See `tool_params::repair` for why this is a repair and not a
    // refusal: the refusal was tried, and it printed the right answer into a call that was made
    // again unchanged four times.
    for entry in &mut entries {
        crate::tool_params::repair(domain.name, &entry.op, &mut entry.params);
    }

    // Everything that can refuse the call is answered before any of it runs. A list applied half
    // way and then refused is the worst of both: the model cannot tell what landed, and the
    // parameter mistake behind it is usually in an entry it has not looked at yet.
    for (index, entry) in entries.iter().enumerate() {
        // The parameter contract, checked here rather than in GDScript. Four domains are forwarded
        // to the addon as raw JSON, so before this the first thing to examine a value's shape was
        // `Protocol.decode`, in the editor, across a socket — and its answer reached the model as
        // one flattened sentence with no example in it. See `tool_params`.
        crate::tool_params::check(domain.name, &entry.op, &entry.params)
            .map_err(|failure| the_whole_file(domain.name, &entry.op, failure))
            .map_err(|failure| entry.blamed(index, entries.len(), failure))?;

        // A game the debugger started is not one the editor is playing, so `runtime.run`'s own
        // guard cannot see it. Answered here, where both are known.
        if domain.name == "godot_runtime" {
            refuse_a_second_game(&entry.op, crate::debug::holds_a_game())
                .map_err(|failure| entry.blamed(index, entries.len(), failure))?;
        }

        // The user's rules are answered before the user's approvals, because a rule they already
        // answered is not a question to ask them again: `game_embed_mode` is gated below, and a
        // prompt offering to undo a ticked box is a worse outcome than a refusal.
        if let Some(refusal) =
            crate::godot_policy::enforcement_refusal(rules, domain.name, &entry.op, &entry.params)
        {
            return Err(entry.blamed(
                index,
                entries.len(),
                ToolFailure::new("policy_enforced", refusal),
            ));
        }
    }
    refuse_a_list_that_holds_a_lone_operation(domain, &entries)?;

    // The safety model sits between validation and the operation. A call the router would refuse
    // anyway is never worth a prompt, and a path outside the worktree is rejected here rather than
    // offered for approval, so no dialog can ever propose writing outside the task's own tree.
    let mut gated: Vec<approvals::GatedCall> = Vec::new();
    for entry in &entries {
        let Some(reason) = approvals::gate_reason(domain.name, &entry.op) else {
            continue;
        };
        reject_outside_paths(app, &entry.params)?;
        gated.push(approvals::GatedCall {
            op: entry.op.clone(),
            reason,
            params: entry.params.clone(),
        });
    }
    // One prompt for the whole call. Asked per entry, a list of ten deletions would reach the user
    // as ten dialogs, of which they could only refuse the ones they had already been shown.
    approvals::require(app, domain.name, &gated)?;

    run_in_order(domain, entries, |op, params| {
        starting_the_session_if_there_is_none(
            domain,
            params,
            |params| run_one(app, domain, op, params),
            || {
                godot_session_api::start_session(app, StartGodotSessionRequest {})
                    .map(|_| ())
                    .map_err(ToolFailure::from)
            },
        )
    })
}

/// Runs one operation, and starts the editor session if the only thing wrong was that there is
/// none.
///
/// The model is told to start the session before it reaches for the editor, and it cannot reliably
/// tell whether one is running: a live run asked `godot_project get_settings` first and was told
/// `session_not_active`, which is a refusal it can do nothing with except guess. Starting is what
/// the answer to that refusal always is, so it happens here instead of being asked for.
///
/// `godot_session` is left out on purpose. Its `start` is this door already, and its `stop` reports
/// the same code for the same reason — a stop that started an editor would be the opposite of what
/// was asked.
///
/// A start that fails still answers `session_not_active`. There is still no session, which is what
/// the code says and what the caller has to act on; why the start failed is the sentence after it.
fn starting_the_session_if_there_is_none(
    domain: &ToolDomain,
    params: Value,
    mut run: impl FnMut(Value) -> Result<Value, ToolFailure>,
    start: impl FnOnce() -> Result<(), ToolFailure>,
) -> Result<Value, ToolFailure> {
    let failure = match run(params.clone()) {
        Err(failure) if failure.code == SESSION_NOT_ACTIVE => failure,
        answered => return answered,
    };
    if domain.name == "godot_session" {
        return Err(failure);
    }
    match start() {
        Ok(()) => run(params),
        Err(start_failure) => {
            let mut failure = failure;
            failure.message = format!(
                "{} Starting one failed: {}",
                failure.message.trim_end(),
                start_failure.message
            );
            failure.retryable = start_failure.retryable;
            if let Some(details) = failure.details.as_object_mut() {
                details.insert("startFailure".to_owned(), json!(start_failure.code));
            }
            Err(failure)
        }
    }
}

/// What every door to a missing editor answers with.
const SESSION_NOT_ACTIVE: &str = "session_not_active";

/// One entry of the `ops` list: the operation, and the parameters written beside it.
#[derive(Clone, Debug)]
struct Requested {
    op: String,
    params: Value,
}

impl Requested {
    /// The same failure, told where in the list it happened.
    ///
    /// A call of one says nothing extra: there is no list to point into, and the sentence the
    /// checker already wrote is the whole story. A longer one names the entry, because `godot_node
    /// create requires `type`` is not actionable when the model wrote eleven of them.
    fn blamed(&self, index: usize, total: usize, failure: ToolFailure) -> ToolFailure {
        if total < 2 {
            return failure;
        }
        let mut failure = failure;
        failure.message = format!("`ops[{index}]` ({}): {}", self.op, failure.message);
        if let Some(details) = failure.details.as_object_mut() {
            details.insert("opIndex".to_owned(), json!(index));
        }
        failure
    }
}

/// Reads the `ops` list a tool call carries, and refuses anything that is not one.
///
/// Every call is a list, including a call of one operation. A model that wanted three inspections
/// used to write three calls and wait for each in turn, because nothing it could write said "these
/// three together" — ten live sweeps found it doing exactly that and never once emitting parallel
/// calls of its own. One shape is what makes the batch reachable without making the model choose
/// between two shapes on every call.
fn requested_operations(
    domain: &ToolDomain,
    params: &Value,
) -> Result<Vec<Requested>, ToolFailure> {
    let Some(listed) = params.get("ops").and_then(Value::as_array) else {
        return Err(ToolFailure::new(
            "missing_ops",
            format!(
                "{} takes an `ops` list: {{\"ops\": [{{\"op\": \"…\", …}}]}}, with each \
                 operation's parameters beside its `op`. One operation is a list of one.",
                domain.name
            ),
        ));
    };
    if listed.is_empty() {
        return Err(ToolFailure::new(
            "empty_ops",
            format!("{} was called with an empty `ops` list", domain.name),
        ));
    }
    listed
        .iter()
        .enumerate()
        .map(|(index, entry)| requested_operation(domain, index, entry))
        .collect()
}

fn requested_operation(
    domain: &ToolDomain,
    index: usize,
    entry: &Value,
) -> Result<Requested, ToolFailure> {
    if !entry.is_object() {
        return Err(ToolFailure::new(
            "invalid_params",
            format!("{} `ops[{index}]` is not an object", domain.name),
        ));
    }
    let op = entry
        .get("op")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            ToolFailure::new(
                "missing_op",
                format!(
                    "{} `ops[{index}]` needs an `op` naming the operation",
                    domain.name
                ),
            )
        })?
        .to_owned();
    if !domain.operations.iter().any(|offered| offered.op == op) {
        return Err(ToolFailure::new(
            "unknown_operation",
            format!("{} has no '{op}' operation", domain.name),
        ));
    }
    // `op` names the entry; it is not one of the operation's parameters. It is taken out here
    // rather than tolerated downstream, because four domains are forwarded to the addon as raw
    // JSON and the addon refuses a parameter no handler reads — which is what a real editor
    // answered to `session.get_state has no `op` parameter`.
    let mut params = entry.clone();
    if let Some(object) = params.as_object_mut() {
        object.remove("op");
    }
    Ok(Requested { op, params })
}

/// Refuses a list that asks an operation to share more of itself than it can.
///
/// Two refusals, because one sentence cannot be true of both. An `Exclusive` operation cannot share
/// a call at all: it is the debugger, where the answer to one operation decides what the next one
/// means. A `Repeat` operation may sit beside anything and may not appear twice — it takes no
/// parameters to vary, or it drives what the session owns exactly one of, and `run_in_order` walks
/// the list, so the second entry either answers the first one's question again or acts on what it
/// left behind.
///
/// The reason `Repeat` is separate is what a live project measured. Ten calls across ten of sixteen
/// tasks were refused for holding a lone operation, and not one of them repeated it: they were
/// `[open, get_tree]`, `[capture, get_state]`, `[status, threads, stack_trace]` — ordinary two-step
/// requests the router was already able to run. The old rule refused a list holding any lone
/// operation, and told the model "a second one is the first one again" about two different ones.
fn refuse_a_list_that_holds_a_lone_operation(
    domain: &ToolDomain,
    entries: &[Requested],
) -> Result<(), ToolFailure> {
    if entries.len() < 2 {
        return Ok(());
    }
    for (index, entry) in entries.iter().enumerate() {
        let Some((scope, reason)) = crate::tool_params::alone_rule(domain.name, &entry.op) else {
            continue;
        };
        match scope {
            Sharing::Exclusive => {
                return Err(ToolFailure {
                    code: "must_be_alone".to_owned(),
                    message: format!(
                        "{}.{} has to be the only entry of its call, and `ops[{index}]` is one of \
                         {}. {reason} Send it as a list of one, and the rest as their own call.",
                        domain.name,
                        entry.op,
                        entries.len()
                    ),
                    retryable: false,
                    details: json!({"op": entry.op, "opIndex": index}),
                });
            }
            // Only a later twin is named. The first entry of a pair is the one the caller keeps,
            // so pointing at it would ask for the wrong edit.
            Sharing::Repeat => {
                if let Some(again) = entries
                    .iter()
                    .skip(index + 1)
                    .position(|later| later.op == entry.op)
                {
                    let again = index + 1 + again;
                    return Err(ToolFailure {
                        code: "op_repeated".to_owned(),
                        message: format!(
                            "{}.{} is in this call twice, at `ops[{index}]` and `ops[{again}]`. \
                             {reason} Drop the second one; the rest of the list is fine.",
                            domain.name, entry.op
                        ),
                        retryable: false,
                        details: json!({"op": entry.op, "opIndex": again, "firstIndex": index}),
                    });
                }
            }
        }
    }
    Ok(())
}

/// Runs the entries in the order they were written, and stops at the first one that fails.
///
/// Stopping is not a preference. The entry after a failed one usually depends on it: its
/// `expectedRevision` is the revision the failed entry would have produced, and a node it meant to
/// build under one the failed entry did not create has nowhere to go.
///
/// The call itself fails only when nothing in it worked. Whatever did run is reported instead,
/// because a failure crossing the channel keeps its code and its message and loses its details — so
/// a part-applied list answered as one failure would tell the model that eleven nodes it had just
/// created do not exist.
///
/// `step` is what runs one entry. Given rather than called, because the four rules above are the
/// whole of what this function decides and none of them is about the editor: with `run_one` wired
/// in directly, proving any of them meant driving a real editor through a whole batch.
fn run_in_order(
    domain: &ToolDomain,
    entries: Vec<Requested>,
    mut step: impl FnMut(&str, Value) -> Result<Value, ToolFailure>,
) -> Result<Value, ToolFailure> {
    let mut answered: Vec<Value> = Vec::with_capacity(entries.len());
    let mut stopped: Option<ToolFailure> = None;
    let mut worked = false;
    // The revision the last answer reported, threaded into the next entry that takes one. No caller
    // can supply it: the revision an entry has to expect is the one the entry before it produced,
    // and that number does not exist yet when the call is written.
    let mut revision: Option<i64> = None;
    for entry in entries {
        if let Some(failure) = &stopped {
            answered.push(json!({
                "op": entry.op,
                "skipped": "an earlier entry failed, so this was not run",
                "because": failure.code,
            }));
            continue;
        }
        let params = expecting_what_the_last_entry_produced(domain, &entry, revision);
        match step(&entry.op, params) {
            Ok(answer) => {
                worked = true;
                revision = answer.get("revision").and_then(Value::as_i64).or(revision);
                answered.push(json!({"op": entry.op, "result": answer}));
            }
            Err(failure) => {
                answered.push(json!({"op": entry.op, "error": failure}));
                stopped = Some(failure);
            }
        }
    }
    match stopped {
        // Nothing landed, so the list carries nothing the failure does not already say. This is the
        // whole of a one-entry call that failed, which is exactly what every caller had before.
        Some(failure) if !worked => Err(failure),
        _ => Ok(json!({"ops": answered})),
    }
}

/// Gives an entry the revision the entry before it produced.
///
/// Only for operations that declare `expectedRevision`, and only once an answer has carried one.
/// What the caller wrote on the first entry is left alone: that one is the guard against the scene
/// having changed under the whole call, and it is the only revision a caller can know. The guard
/// survives the chain — anything else that edits the scene between two entries makes the number the
/// previous answer reported stale, and the addon refuses it exactly as it refuses a stale one from
/// a caller.
fn expecting_what_the_last_entry_produced(
    domain: &ToolDomain,
    entry: &Requested,
    revision: Option<i64>,
) -> Value {
    let (Some(revision), Some(spec)) = (
        revision,
        crate::tool_params::params_of(domain.name, &entry.op),
    ) else {
        return entry.params.clone();
    };
    if !spec.iter().any(|param| param.name == "expectedRevision") {
        return entry.params.clone();
    }
    let mut params = entry.params.clone();
    if let Some(object) = params.as_object_mut() {
        object.insert("expectedRevision".to_owned(), json!(revision));
    }
    params
}

/// One operation, routed to the handler the renderer uses for the same thing.
fn run_one<R: Runtime>(
    app: &AppHandle<R>,
    domain: &ToolDomain,
    op: &str,
    params: Value,
) -> Result<Value, ToolFailure> {
    // What answers this operation is a fact about the operation, so it is read off the operation
    // rather than rebuilt from its name. The router used to spell the addon command with
    // `format!("scene.{op}")` and keep a hand-written exception list wherever a domain was only
    // partly the addon's — `session.start|stop|status` and `resource.list|move|delete` — and two
    // drift tests in this file re-derived the same arithmetic and the same exceptions a second and
    // a third time. `params.json` had carried the mapping as data the whole time.
    let Some(answers) = crate::tool_params::answers(domain.name, op) else {
        // Unreachable from outside: an operation the catalogue does not offer was refused above,
        // and the table is held to the catalogue by a test.
        return Err(ToolFailure::new(
            "unrouted_operation",
            format!("{}.{op} has no route", domain.name),
        ));
    };

    match answers {
        crate::tool_params::Answers::Addon(command) => {
            let answered = rpc(app, command, params);
            if domain.name == "godot_runtime" {
                // A game that broke does not die, so a runtime call that failed has to carry the
                // error that ended it rather than the transport's own.
                return answered
                    .map_err(|error| carrying_the_error_that_ended_the_game(error.into()));
            }
            Ok(answered?)
        }
        crate::tool_params::Answers::Rust => match domain.name {
            "godot_session" => session_domain(app, op),
            "godot_resource" => resource_domain(app, op, params),
            "godot_script" => script_domain(app, op, params),
            "godot_debug" => debug_domain(op, params),
            "godot_logs" => logs_domain(params),
            "godot_docs_search" => docs_domain(app, op, params),
            // Every Rust-answered domain is handled above; a new one without a handler is a
            // build-time oversight, not something a caller can reach.
            other => Err(ToolFailure::new(
                "unrouted_tool",
                format!("The {other} tool has no route"),
            )),
        },
    }
}

/// The three session operations the desktop answers itself: starting, stopping, and reporting the
/// supervisor's own view of the editor. Everything else in the domain is the addon's, and the
/// router sends it there without asking here.
fn session_domain<R: Runtime>(app: &AppHandle<R>, op: &str) -> Result<Value, ToolFailure> {
    match op {
        "status" => Ok(json!({"session": godot_session_api::get_session(app)?})),
        "start" => Ok(json!({
            "session": godot_session_api::start_session(app, StartGodotSessionRequest {})?
        })),
        "stop" => {
            godot_session_api::stop_session(app)?;
            Ok(json!({"stopped": true}))
        }
        other => Err(ToolFailure::new(
            "unrouted_operation",
            format!("godot_session.{other} has no desktop handler"),
        )),
    }
}

/// Fills in `expectedHash` from what this agent was last told about the file it names.
///
/// A hash the caller passed itself is left alone: the renderer holds its own buffer and its own
/// token, and this is not the place to overrule it. A path with no record is left alone too, which
/// is what an unread file already meant — `Workspace::write` reads that as "creating this file" and
/// says so plainly if the file is in fact already there.
fn with_remembered_hash<R: Runtime>(app: &AppHandle<R>, params: Value) -> Value {
    let mut params = params;
    let Some(object) = params.as_object_mut() else {
        return params;
    };
    if object.contains_key("expectedHash") {
        return params;
    }
    let Some(path) = object
        .get("path")
        .and_then(Value::as_str)
        .map(str::to_owned)
    else {
        return params;
    };
    let Ok(workspace) = crate::active_workspace(app) else {
        return params;
    };
    if let Some(hash) = crate::read_ledger::recall(workspace.root(), &path) {
        object.insert("expectedHash".to_owned(), json!(hash));
    }
    params
}

/// Reconciles an answer with the read ledger and hands back what the model may see.
///
/// One step where the path/hash pairs are produced. Every file-touching arm goes through it, so a
/// new one cannot enact half of the ritual the way `apply_rename` did — see `crate::read_ledger`.
///
/// A workspace that cannot be read is not a reason to hand the model a hash, so the bookkeeping is
/// stripped either way and only the recording is skipped.
fn reconciled<R: Runtime>(app: &AppHandle<R>, answer: Value) -> Value {
    match crate::active_workspace(app) {
        Ok(workspace) => crate::read_ledger::reconcile(workspace.root(), answer),
        Err(_) => crate::read_ledger::reconcile(std::path::Path::new(""), answer),
    }
}

/// Drops the ledger's record when a refusal reports the file as gone.
///
/// The record outlived the file — deleted, moved, or reverted outside the router — and the caller
/// can neither see the hash nor clear it, because `expectedHash` is hidden from the signature.
/// Left in place, the router would attach the same dead record to the next save and refuse it
/// identically, with no call the model could make to escape. Forgetting here is what makes
/// `save it again to create the file` a true sentence rather than a loop.
fn forget_a_vanished_file<R: Runtime>(app: &AppHandle<R>, path: &str, failure: &ToolFailure) {
    if failure.code != "file_conflict" {
        return;
    }
    // A `file_conflict` always carries both hashes, and a null `actualHash` is the one case that
    // means "there is no file there" rather than "the file holds something else".
    if !failure.details["actualHash"].is_null() {
        return;
    }
    if let Ok(workspace) = crate::active_workspace(app) {
        crate::read_ledger::forget(workspace.root(), path);
    }
}

/// A directory named the way the project names it, whichever way it was written.
///
/// `res://` and stray slashes are taken off, because a model that has been reading scene paths all
/// turn writes `res://assets` as readily as `assets`, and both mean the same folder.
///
/// The `params.get("under")` that feeds this stays written out in each arm that takes it:
/// `tool_drift` reads those arms' own source to hold them to the catalogue, and a lookup moved
/// behind a helper is a parameter that check can no longer see.
fn named_directory(named: &str) -> String {
    named
        .trim_start_matches("res://")
        .trim_matches('/')
        .to_owned()
}

/// Whether one worktree-relative path sits inside that directory. No directory means every path.
fn is_under(path: &str, under: Option<&str>) -> bool {
    under.is_none_or(|under| {
        path.strip_prefix(under)
            .is_some_and(|rest| rest.starts_with('/'))
    })
}

fn resource_domain<R: Runtime>(
    app: &AppHandle<R>,
    op: &str,
    params: Value,
) -> Result<Value, ToolFailure> {
    match op {
        "list" => {
            let workspace = crate::active_workspace(app)?;
            // Hashing is asked for rather than always done: a worktree holds game assets, and
            // hashing every texture and every sound to answer "what files are there" would read
            // the whole project on a call the agent makes to orient itself.
            let with_hashes = params
                .get("hashes")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            // One directory, the way `godot_script list` takes one. A live turn asked for
            // `{"op": "list", "path": "assets"}` — the wrong key, and there was no right one — and
            // fell back to `bash find`. The whole-project answer averages fourteen thousand
            // characters and has been truncated, which is a lot to pay to see one folder.
            let under = params
                .get("under")
                .and_then(Value::as_str)
                .map(named_directory);
            let files: Vec<Value> = files::scan(workspace.root())
                .into_iter()
                .filter(|(path, _)| is_under(path, under.as_deref()))
                .map(|(path, stamp)| {
                    let hash = if with_hashes {
                        workspace.hash_of(&path).ok().flatten()
                    } else {
                        None
                    };
                    json!({"path": path, "bytes": stamp.bytes, "hash": hash})
                })
                .collect();
            // Reconciled like every other answer that carries stamps: the hashes go into the
            // ledger and out of the answer. The hash is the router's to hold and the caller's never
            // to carry, so printing it is noise the model pays for and cannot spend on anything.
            Ok(reconciled(app, json!({"files": files})))
        }
        // The typed destructive pair. Both reach the same `Workspace` the renderer's own
        // `move_workspace_path` and `delete_workspace_path` commands use, so canonical-path
        // validation and the hash check are the workspace's, not a second copy of them.
        "move" => {
            let request: files::MovePathRequest = from_params(params)?;
            let workspace = crate::active_workspace(app)?;
            workspace.move_path(&request.from, &request.to)?;
            // The content did not change, only where it lives, so the record follows the file.
            if let Some(hash) = crate::read_ledger::recall(workspace.root(), &request.from) {
                crate::read_ledger::remember(workspace.root(), &request.to, &hash);
            }
            crate::read_ledger::forget(workspace.root(), &request.from);
            tell_the_editor_the_worktree_moved(app);
            Ok(json!({"from": request.from, "to": request.to, "moved": true}))
        }
        "delete" => {
            let request: files::DeletePathRequest = from_params(with_remembered_hash(app, params))?;
            let workspace = crate::active_workspace(app)?;
            workspace.delete(&request.path, request.expected_hash.as_deref())?;
            // The record is now a claim about nothing, and keeping it would refuse the save that
            // recreates the file — the one case where naming no hash is the whole point.
            crate::read_ledger::forget(workspace.root(), &request.path);
            tell_the_editor_the_worktree_moved(app);
            Ok(json!({"path": request.path, "deleted": true}))
        }
        // Everything else in the domain is the editor's, and the router sent it there rather than
        // here. This arm is the build-time oversight, not a name a caller can reach.
        other => Err(ToolFailure::new(
            "unrouted_operation",
            format!("godot_resource.{other} has no desktop handler"),
        )),
    }
}

/// Rescans the project after a move or a delete, because both go straight to disk and the editor
/// is otherwise never told.
///
/// An asset the editor has already imported does not stop existing when its file does: the import
/// it wrote under `.godot/imported` is still there, so `load` still answers with the old pixels.
/// A tileset was built from a texture that had been deleted, and one built from the path a file was
/// moved *away* from, both reported as successes — a scene authored against a resource that is not
/// in the project. The destination of a move has the opposite problem: nothing has imported it yet,
/// so it cannot be loaded at all until something scans.
///
/// A project walk rather than the two named paths: either end of a move can be a directory, and
/// these two operations are rare and already gated behind the user's approval. Best effort — a
/// worktree edit must not fail because no editor is bound to it.
fn tell_the_editor_the_worktree_moved<R: Runtime>(app: &AppHandle<R>) {
    let _ = rpc(app, "resource.rescan", json!({}));
}

/// Resolves every path a gated call names before the user is asked about it. Outside-worktree
/// files are refused outright — "outside the worktree" is not a decision to put in front of the
/// user one file at a time — and the resolution is the workspace's own, so this check cannot drift
/// from the one the operation itself will run.
fn reject_outside_paths<R: Runtime>(app: &AppHandle<R>, params: &Value) -> Result<(), ToolFailure> {
    let named: Vec<&str> = ["path", "from", "to"]
        .iter()
        .filter_map(|key| params.get(*key).and_then(Value::as_str))
        .collect();
    if named.is_empty() {
        return Ok(());
    }
    let workspace = crate::active_workspace(app)?;
    for path in named {
        workspace.resolve(path)?;
    }
    Ok(())
}

/// Keeps this domain to the files it is for.
///
/// `save` writes whatever path it is given, and the language server behind it only knows GDScript.
/// A live agent used it to write a `.tscn` by hand rather than build the scene with the node tools:
/// the text landed under an editor that had its own copy of that scene open, outside the undo stack
/// and outside the revision guard, in a layout Godot's own writer would never produce. A scene is
/// the editor's to write, so anything that is not a script is refused with the tool that owns it.
/// Rewrites `res://…` into the worktree-relative path the file tools take.
///
/// Two conventions meet in this catalog and neither is wrong: the editor names a file the way Godot
/// does, `res://scripts/mario.gd`, and everything that reaches the filesystem names it the way the
/// worktree does, `scripts/mario.gd`. A model has no way to know which domain wants which, and it
/// reaches for `res://` because that is what it just used to build the scene — then `godot_script
/// open` answers that the file does not exist, about a file it wrote a moment ago. The mapping is
/// exact, so it is done here rather than explained. Confinement is untouched: what is left after
/// the prefix is still a relative path, so `res://../secrets` is refused exactly as `../secrets` is.
fn accept_resource_paths(mut params: Value) -> Value {
    fn worktree_relative(value: &mut Value) {
        if let Some(path) = value.as_str().and_then(|path| path.strip_prefix("res://")) {
            *value = Value::String(path.to_owned());
        }
    }
    if let Some(path) = params.get_mut("path") {
        // `path` is one name or a list of them wherever a batch is accepted, so both shapes are
        // rewritten. A list of anything else is left alone: `worktree_relative` only touches a
        // string that starts with the prefix.
        match path.as_array_mut() {
            Some(entries) => entries.iter_mut().for_each(worktree_relative),
            None => worktree_relative(path),
        }
    }
    // `apply_rename` and `set_breakpoints` carry their paths one level down.
    for key in ["files", "breakpoints"] {
        if let Some(entries) = params.get_mut(key).and_then(Value::as_array_mut) {
            for entry in entries {
                if let Some(path) = entry.get_mut("path") {
                    worktree_relative(path);
                }
            }
        }
    }
    params
}

fn require_script_path(params: &Value) -> Result<(), ToolFailure> {
    let path = params
        .get("path")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if path.is_empty() || path.ends_with(".gd") {
        return Ok(());
    }
    Err(ToolFailure::new(
        "unsupported_file",
        format!(
            "godot_script works on GDScript, and {path} is not a .gd file. Build and save a scene \
             with godot_scene and godot_node — a scene written as text is not the scene the editor \
             has open."
        ),
    ))
}

/// The scripts one call names, and whether it named them as a list.
///
/// `open`, `close` and `diagnostics` each take one script or a list of them, because an agent that
/// could only name one at a time made one call per file: nine `open` calls in a row, then a
/// `diagnostics` call per file, each one a round-trip and an answer the turn pays context for. A
/// caller that names a single path still gets the single answer it always got; a caller that names
/// a list gets `{"files": […]}`, the shape `edit` already answers with, in the order it asked.
fn named_scripts(params: &Value) -> Result<(Vec<String>, bool), ToolFailure> {
    let empty = || {
        ToolFailure::new(
            "invalid_params",
            "`path` is empty, so the call names no script to work on.",
        )
    };
    let Some(entries) = params.get("path").and_then(Value::as_array) else {
        let path = params
            .get("path")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        if path.is_empty() {
            return Err(empty());
        }
        require_script_path(&json!({"path": path}))?;
        return Ok((vec![path], false));
    };
    if entries.is_empty() {
        return Err(empty());
    }
    let mut paths = Vec::with_capacity(entries.len());
    for entry in entries {
        let path = entry.as_str().ok_or_else(|| {
            ToolFailure::new(
                "invalid_params",
                format!(
                    "`path` is a list of script paths, and {entry} is not one. Name them as \
                     strings: [\"scripts/player.gd\", \"scripts/enemy.gd\"]."
                ),
            )
        })?;
        require_script_path(&json!({"path": path}))?;
        paths.push(path.to_owned());
    }
    Ok((paths, true))
}

/// One answer for a single path, `{"files": […]}` for a list.
/// How much script text one `open` call answers with before it starts withholding.
///
/// The worker holds a tool result at 24,000 characters and slices it there, mid-file. Ten of
/// thirty-two `open` calls in a live project hit that, and the file cut in half was the last one
/// named — after which an `edit` anchored on text the model had been shown only part of failed with
/// `anchor_not_found`. A budget answers instead with whole files and a note about the rest, which
/// is a thing the model can act on.
const OPEN_TEXT_BUDGET: usize = 16_000;

/// Whether this file's text is the one an `open` call stops carrying.
///
/// The first file is answered however large it is. A budget that could withhold everything would
/// turn `open scripts/main.gd` — one file, larger than the budget on its own — into a call that
/// says only how big it is, and there is no smaller call to fall back to. Truncation is the worse
/// failure of the two, but it is only worse when the model has somewhere else to go.
fn withholds_the_text(spent: usize, text_bytes: usize, first: bool) -> bool {
    !first && spent + text_bytes > OPEN_TEXT_BUDGET
}

fn one_or_many(mut answers: Vec<Value>, batched: bool) -> Value {
    if batched {
        return json!({"files": answers});
    }
    // A single path always produced exactly one answer: `named_scripts` refuses an empty call.
    answers.pop().unwrap_or(Value::Null)
}

/// Names the operation that needs no anchors, when an edit call arrives in a shape it cannot use.
///
/// `godot_script edit` carries the largest nested payload of any operation — a list of files, each
/// holding a list of before-and-after strings that are whole functions — and it is where this
/// model's JSON tears most often. `files[0] requires path` is the second commonest refusal in every
/// recorded live turn: nine of them across five turns, three of those inside one call sequence.
///
/// It is not a misunderstanding of the shape. Asked directly, twelve seeds out of twelve wrote
/// `files[{path, edits}]` correctly. The turn that met it three times said so itself, in the middle
/// of the run:
///
/// > The JSON structure is getting mangled. Let me just save the whole file:
///
/// — and `godot_script save`, which takes one path and one string, worked immediately. So there is
/// nothing here to repair: the intended text never reaches the wire, and a router that guessed a
/// path would be writing a guess into somebody's script. What can be done is name the way out that
/// this run took four calls to find on its own.
fn the_whole_file(tool: &str, op: &str, failure: ToolFailure) -> ToolFailure {
    let shape = matches!(
        failure.code.as_str(),
        "missing_param" | "unknown_param" | "invalid_param"
    );
    if !shape || tool != "godot_script" || op != "edit" {
        return failure;
    }
    let mut failure = failure;
    failure.message = format!(
        "{} If this call keeps arriving in a shape it cannot use, godot_script save writes the \
         whole file as one string and needs no anchors at all.",
        failure.message.trim_end()
    );
    failure
}

fn script_domain<R: Runtime>(
    app: &AppHandle<R>,
    op: &str,
    params: Value,
) -> Result<Value, ToolFailure> {
    let params = accept_resource_paths(params);
    match op {
        // Answered from the worktree walk rather than the language server, which knows only the
        // documents something opened. A model that cannot see the scripts reaches for `bash find`,
        // and the workspace refuses the absolute path it writes.
        "list" => {
            let workspace = crate::active_workspace(app)?;
            // Matched as a prefix of the relative path rather than resolved: a path that resolves
            // is a path that can leave the worktree.
            let under = params
                .get("under")
                .and_then(Value::as_str)
                .map(named_directory);
            let files: Vec<Value> = files::scan(workspace.root())
                .into_iter()
                .filter(|(path, _)| path.ends_with(".gd"))
                .filter(|(path, _)| is_under(path, under.as_deref()))
                .map(|(path, stamp)| json!({"path": path, "bytes": stamp.bytes}))
                .collect();
            Ok(json!({"files": files}))
        }
        "open" => {
            let (paths, batched) = named_scripts(&params)?;
            let mut answers = Vec::with_capacity(paths.len());
            let mut spent = 0usize;
            for path in paths {
                // Opening a script that has not been written yet is the commonest thing an agent
                // does wrong here, because the catalog tells it to open a script before querying
                // one. The workspace's own answer — "scripts/mario.gd does not exist" — is true and
                // leaves it nowhere; every live sweep watched the same turn spent on it, followed
                // by an `update` against the document the failed open never created.
                let document = script::open_document(from_params(json!({"path": path}))?).map_err(
                    |error| {
                        if error.code == "not_found" {
                            ToolFailure::new(
                                "not_found",
                                format!(
                                    "{} There is nothing to open yet: write the script with \
                                     godot_script save, which creates the file, tells the language \
                                     server about it, and leaves it open.",
                                    error.message
                                ),
                            )
                        } else {
                            ToolFailure::from(error)
                        }
                    },
                )?;
                // Every file is opened, because opening is what tells the language server the
                // document exists — the text is what the budget withholds, never the open itself.
                let text_bytes = document.text.len();
                let answered = if withholds_the_text(spent, text_bytes, answers.is_empty()) {
                    // No `hash`. It is what `reconciled` records in the read ledger, and the
                    // ledger is the hash a later `save` is given as its `expectedHash` — so
                    // answering with one here would let the model replace a whole file out of text
                    // it was never shown. Without it the save is refused as a conflict, which is
                    // the true answer: read the file, then write it.
                    json!({
                        "path": document.path,
                        "bytes": document.bytes,
                        "version": document.version,
                        "omitted": "This call had no room left for the text. It is open; ask for it \
                                    on its own before writing to it.",
                    })
                } else {
                    spent += text_bytes;
                    to_value(document)
                };
                answers.push(reconciled(app, answered));
            }
            Ok(one_or_many(answers, batched))
        }
        "update" => {
            require_script_path(&params)?;
            Ok(reconciled(
                app,
                to_value(script::update_document(from_params(params)?)?),
            ))
        }
        "save" => {
            require_script_path(&params)?;
            // The hash the agent's own last read answered with, supplied here rather than copied
            // by the model. See `crate::read_ledger`.
            let params = with_remembered_hash(app, params);
            let path = params
                .get("path")
                .and_then(Value::as_str)
                .map(str::to_owned);
            let saved = match script::save_and_publish(from_params(params)?) {
                Ok(saved) => to_value(saved),
                Err(error) => {
                    let failure = ToolFailure::from(error);
                    if let Some(path) = path.as_deref() {
                        forget_a_vanished_file(app, path, &failure);
                    }
                    return Err(failure);
                }
            };
            Ok(reconciled(app, saved))
        }
        "close" => {
            let (paths, batched) = named_scripts(&params)?;
            let mut answers = Vec::with_capacity(paths.len());
            for path in paths {
                script::close_document(from_params(json!({"path": path.clone()}))?)?;
                answers.push(json!({"path": path, "closed": true}));
            }
            if batched {
                return Ok(one_or_many(answers, true));
            }
            Ok(json!({"closed": true}))
        }
        "format" => {
            let request: gdformat::FormatRequest = from_params(params)?;
            let binary = crate::gdformat_binary(app)?;
            Ok(to_value(gdformat::format_source(
                &crate::process::SystemProcessSpawner,
                &binary,
                &request.source,
            )?))
        }
        "edit" => {
            let request: script::EditScriptRequest = from_params(params)?;
            for file in &request.files {
                require_script_path(&json!({"path": file.path}))?;
            }
            Ok(reconciled(
                app,
                json!({"files": to_value(script::edit_documents(request)?)}),
            ))
        }
        "apply_rename" => {
            let request: script::ApplyRenameRequest = from_params(params)?;
            // Through the ledger like every other file-touching arm. Renaming rewrites the files it
            // names, so the hashes recorded for them are claims about text that is gone: the next
            // save over one was refused `file_conflict`, and the model cannot clear a hash it is
            // never shown.
            Ok(reconciled(
                app,
                json!({"files": to_value(script::apply_rename(request)?)}),
            ))
        }
        // A list here shares one wait for the whole batch; a single path keeps the answer it has
        // always had, and both read the diagnostics through the same function.
        "diagnostics" if params.get("path").map(Value::is_array) == Some(true) => {
            let (paths, _) = named_scripts(&params)?;
            let timeout_ms = params.get("timeoutMs").and_then(Value::as_u64);
            let files: Vec<Value> = script::diagnostics_for(paths, timeout_ms)?
                .into_iter()
                .map(to_value)
                .collect();
            Ok(json!({"files": files}))
        }
        _ => {
            let request: ScriptRequest = from_tagged_params(op, params)?;
            Ok(to_value(script::call(request)?))
        }
    }
}

/// Refuses a launch the debugger already made, before the editor is asked to make a second one.
///
/// `runtime.run` guards on `EditorInterface.is_playing_scene()`, and a game the debug adapter
/// started is not a scene the editor is playing — so the guard passed and `play_main_scene()` ran
/// on top of it. What came back was `runtime_not_running: The game started and then stopped before
/// it was ready`, which is not what happened and gives the caller nowhere to go. A live debugging
/// turn met it twice and spent the seven calls between them trying to launch the project from the
/// shell, every one refused by the workspace rule.
fn refuse_a_second_game(op: &str, debugger_holds_a_game: bool) -> Result<(), ToolFailure> {
    if !matches!(op, "run" | "restart") || !debugger_holds_a_game {
        return Ok(());
    }
    Err(ToolFailure {
        code: "already_running".to_owned(),
        message: "The debugger is already running this game. Read it where it is with godot_debug \
                  — stack_trace, scopes, variables — or end it with godot_debug terminate. \
                  godot_runtime run would start a second one beside it."
            .to_owned(),
        retryable: false,
        details: json!({"op": op}),
    })
}

fn debug_domain(op: &str, params: Value) -> Result<Value, ToolFailure> {
    // A breakpoint names a script, so it meets the same two conventions the script domain does.
    let request: DebugRequest = from_tagged_params(op, accept_resource_paths(params))?;
    Ok(to_value(debug::call(request)?))
}

fn logs_domain(params: Value) -> Result<Value, ToolFailure> {
    let query: LogQuery = from_params(params)?;
    Ok(to_value(godot_session::read_logs(&query)?))
}

/// Answers a documentation search, telling the sidecar which model to reach for.
///
/// The connection is resolved per call rather than once, because the settings page can change it
/// between two searches in one turn. A settings file that cannot be read leaves it absent, which
/// costs the question its expansion and nothing else — the same state a ChatGPT-only install is in.
fn docs_domain<R: Runtime>(
    app: &AppHandle<R>,
    op: &str,
    params: Value,
) -> Result<Value, ToolFailure> {
    let query: rag::GodotDocsQuery = from_params(params)?;
    // The question as it will be keyed, so "How do I tween?" and "how do I tween?" are one entry.
    let asked = query.question.trim().to_lowercase();
    let corpus = rag::known_corpus_version();
    let project = crate::workspace::project_storage(app).ok();

    if let (Some(corpus), Some(storage)) = (corpus.as_deref(), project.as_ref())
        && let Some(cached) = storage.project().cached_docs_answer(corpus, op, &asked)
        && let Ok(value) = serde_json::from_str::<Value>(&cached)
    {
        return Ok(value);
    }

    let connection = rag::expansion_connection(app);
    let response = if op == "ask" {
        rag::ask_query(query, connection)
    } else {
        rag::retrieve_query(query, connection)
    }
    .map_err(|error| ToolFailure::new("docs_unavailable", error))?;

    let answer = to_value(&response);
    // Written after the answer is built, and only when it is one. A cache that also holds dead ends
    // hands the same dead end to every later task and stops anything ever asking again.
    if response.is_worth_remembering()
        && let Some(corpus) = response.corpus_version.as_deref().or(corpus.as_deref())
        && let Some(storage) = project.as_ref()
        && let Ok(json) = serde_json::to_string(&answer)
    {
        storage
            .project()
            .remember_docs_answer(corpus, op, &asked, &json);
    }
    Ok(answer)
}

/// Editor settings are machine-wide and live in their own addon domain, so the three operations
/// that reach them carry an `editor_` prefix the model can see rather than hiding behind a
/// project operation name.
/// Sends one addon command through the same session API the renderer's `call_godot` uses.
/// `expectedRevision` and `timeoutMs` are lifted out of the parameters: every scene mutation
/// carries a revision, and the wire format keeps it beside the command rather than inside it.
/// The runtime failures that mean the game is not answering, whatever the reason turns out to be.
///
/// Every one of them is the addon reporting a state of the process rather than a fault in the
/// request: the game is paused at an error, it is gone, it stopped answering, or it is up and its
/// helper has not loaded. All four are worth the same treatment, because in all four the model's
/// next question is the same one, and the answer is in the editor's output either way.
///
/// `runtime_slow_start` is here for a failure that looks like patience and is not: a parse error in
/// the addon's own runtime script leaves the game running and its helper never loading, so the
/// launch times out while the editor is still playing, for ever. Without the output the message
/// reads as "wait a little longer", and there is nothing to wait for.
const GAME_IS_NOT_ANSWERING: [&str; 5] = [
    "runtime_broke",
    "runtime_not_running",
    "runtime_slow_start",
    "runtime_timeout",
    // The editor, not the game. `session_closed` is what every call answers once the RPC socket
    // has gone, and on its own it says only that — see `editor_crashed` for what it is usually
    // hiding.
    "session_closed",
];

/// What Godot prints as it dies of a signal.
const CRASH_MARKER: &str = "Program crashed with signal";

/// The crash line, when the editor died rather than merely stopped answering.
///
/// Godot 4.7.2 segfaults when it is asked to play a project whose script will not parse. Watched
/// three times in one night, always the same four lines:
///
/// ```text
/// SCRIPT ERROR: Parse Error: Function "add_child_node()" not found in base self.
/// ERROR: Failed to load script "res://scripts/spawner.gd" with error "Parse error".
/// ERROR: Parameter "t" is null.
/// handle_crash: Program crashed with signal 11
/// ```
///
/// What reached the model was `session_closed: The RPC session closed`, which is true and tells it
/// nothing — so it retried, and retried, and two of those three runs never finished. A crash is not
/// something to retry, and it is not the caller's mistake; the engine is the thing that broke, and
/// saying so is the difference between restarting the session and arguing with it.
///
/// Read without a severity floor on purpose. `handle_crash:` arrives on the editor's stderr and is
/// not classified as an error line, so the reader that carries error lines never sees it.
fn editor_crashed() -> Option<String> {
    let page = godot_session::read_logs(&LogQuery {
        contains: Some(CRASH_MARKER.to_owned()),
        limit: Some(MAX_CARRIED_SCAN),
        ..LogQuery::default()
    })
    .ok()?;
    page.entries.last().map(|entry| entry.message.clone())
}

/// Puts the error that ended the game into the failure the model is about to read.
///
/// The addon knows the game stopped and does not know why. A GDScript parse error is printed by
/// the engine onto the editor's own stderr and never crosses the debugger bridge, so the addon can
/// only say that nothing answered — which is how `runtime_broke` came to end with "read the error
/// in the session output", and how the call after it answered "The game stopped before it could
/// answer" and named nothing at all.
///
/// Gofer has that text. `godot_logs` reads the very same buffer, and a live run showed the two
/// lines that explained everything sitting in it while the model was told to go and look:
///
/// ```text
/// SCRIPT ERROR: Parse Error: Expected expression after "else".
/// ERROR: Failed to load script "res://scripts/generate_assets.gd" with error "Parse error".
/// ```
///
/// A pointer to a side channel costs a turn, and the turn after a crash is the one the model has
/// least to spare. So the lines travel with the failure instead of being described.
fn carrying_the_error_that_ended_the_game(mut failure: ToolFailure) -> ToolFailure {
    if !GAME_IS_NOT_ANSWERING.contains(&failure.code.as_str()) {
        return failure;
    }
    if let Some(crash) = editor_crashed() {
        failure.message = format!(
            "{}\n\nThe Godot editor itself died: {crash}. That is the engine crashing, not this \
             call — retrying it will not help. Start a new session with godot_session start.",
            failure.message.trim_end()
        );
        return failure;
    }
    // Not for `session_closed`. That one is about the editor, and an editor that has gone takes the
    // staged autoload with it — so the check below would be right about the file and wrong about
    // what happened.
    if failure.code.starts_with("runtime_")
        && let Some(missing) = the_helper_is_not_installed()
    {
        failure.message = format!("{}\n\n{missing}", failure.message.trim_end());
        return failure;
    }
    let printed = last_session_errors(CARRIED_ERROR_LINES);
    if printed.is_empty() {
        return failure;
    }
    failure.message = format!(
        "{}\n\nThe session output ends with:\n{}",
        failure.message.trim_end(),
        printed.join("\n")
    );
    failure
}

/// Says so when the game cannot possibly answer, because its helper is not in the project any more.
///
/// The other three explanations a runtime failure carries all come out of the session output. This
/// one is not in it: the game boots, runs, and prints nothing wrong — it simply has no
/// `GoferRuntime` autoload, so nothing inside it ever announces itself. Every runtime call then
/// waits its full deadline and answers with advice to wait longer, for ever.
///
/// See [`crate::addon::runtime_helper_missing`] for what takes the autoload away under a session
/// that is still running, and why the file rather than the editor is what gets read.
fn the_helper_is_not_installed() -> Option<String> {
    let worktree = godot_session::current_info()?.worktree;
    if !crate::addon::runtime_helper_missing(std::path::Path::new(&worktree)) {
        return None;
    }
    Some(
        "The game has no Gofer runtime helper to answer with: project.godot no longer registers \
         the GoferRuntime autoload, so nothing in the game can reply and waiting will not change \
         that. Something rewrote project.godot after this session staged it — a branch switch, a \
         merge, or an edit to the file. Restart the editor with godot_session stop then \
         godot_session start, which stages it again."
            .to_owned(),
    )
}

/// How many of the session's last errors travel with a runtime failure.
///
/// Enough for the two lines an engine prints about one bad script — the parse error and the load
/// that failed because of it — and few enough that a buffer full of an earlier problem cannot bury
/// the message it is attached to.
const CARRIED_ERROR_LINES: usize = 6;

/// The most recent error lines the running session printed, oldest of them first.
///
/// Errors only. The `at:` frames and the GDScript backtrace under one are classified as info, and
/// a failure message is not the place for engine internals — what the model needs is the sentence
/// naming the script and what is wrong with it. `godot_logs` is still there for the rest.
fn last_session_errors(wanted: usize) -> Vec<String> {
    let page = godot_session::read_logs(&LogQuery {
        min_severity: Some(godot_session::LogSeverity::Error),
        limit: Some(MAX_CARRIED_SCAN),
        ..LogQuery::default()
    });
    let entries = page.map(|page| page.entries).unwrap_or_default();
    entries
        .iter()
        .skip(entries.len().saturating_sub(wanted))
        .map(|entry| entry.message.clone())
        .collect()
}

/// How much of the buffer is read to find those last few. The reader answers with the *first*
/// matches after its cursor, so the tail is taken here rather than asked for.
const MAX_CARRIED_SCAN: usize = 1_000;

fn rpc<R: Runtime>(
    app: &AppHandle<R>,
    command: &str,
    mut params: Value,
) -> Result<Value, crate::godot_rpc::RpcError> {
    let held = remembered_revision(app);
    // Both halves or neither. A revision the router supplied is only meaningful beside the scene it
    // was counted in, and a revision the caller supplied is theirs to be held to — the renderer
    // names its own scene in `params` when it cares which.
    let (expected_revision, expected_scene) = match take_u64(&mut params, "expectedRevision") {
        Some(revision) => (Some(revision), None),
        None => (
            held.as_ref().map(|held| held.revision),
            held.map(|held| held.scene),
        ),
    };
    let timeout_ms = take_u64(&mut params, "timeoutMs");
    let request = CallGodotRequest {
        command: command.to_owned(),
        params,
        expected_revision,
        expected_scene,
        timeout_ms,
    };
    let response = match godot_session_api::call_godot(app, request.clone()) {
        Ok(answered) => answered,
        Err(refusal) => {
            let revision =
                the_revision_a_first_mutation_was_refused_for(&refusal, expected_revision)
                    .ok_or(refusal)?;
            godot_session_api::call_godot(
                app,
                CallGodotRequest {
                    expected_revision: Some(revision),
                    ..request
                },
            )?
        }
    };
    let mut result = response.result;
    if let (Some(revision), Some(object)) = (response.revision, result.as_object_mut()) {
        object.insert("revision".to_owned(), json!(revision));
    }
    record_revision(app, &result);
    Ok(result)
}

/// The revision to retry at, when the router had none to supply and the addon refused for it.
///
/// A mutation is checked against the revision of the read it followed. The first call of a session
/// follows no read: the ledger is in memory and empty, so the router supplies nothing and the addon
/// refuses. The catalog tells the model the router holds that number and to never read the tree for
/// it, so the model's only way out is the read the same sentence forbids — a refusal and a whole
/// `scene.get_tree`, measured at 719 tool tokens and 2.6 seconds on a live turn whose first act was
/// `scene.create`.
///
/// Only when the router supplied nothing. A revision it did supply, or one the caller passed, is a
/// read this turn really made, and a conflict against it is the concurrent edit the guard exists to
/// catch — retrying that would overwrite whatever moved the scene on.
fn the_revision_a_first_mutation_was_refused_for(
    refusal: &crate::godot_rpc::RpcError,
    supplied: Option<u64>,
) -> Option<u64> {
    if supplied.is_some() || refusal.code != "revision_conflict" {
        return None;
    }
    refusal
        .details
        .get("currentRevision")
        .and_then(Value::as_u64)
}

/// The revision the last answer reported, for a call that named none.
///
/// A caller that passed its own is left alone, exactly as `expectedHash` is: the renderer holds a
/// view the router has no business overruling. Every addon answer that carries a revision is
/// recorded, so this is the number the agent's own last read or write answered with.
fn remembered_revision<R: Runtime>(
    app: &AppHandle<R>,
) -> Option<crate::read_ledger::SceneRevision> {
    let workspace = crate::active_workspace(app).ok()?;
    crate::read_ledger::recall_revision(workspace.root())
}

/// Records the revision an answer carries. A mutation reports it on the envelope and a read reports
/// it in the body; both have been merged into one object by the time this runs.
fn record_revision<R: Runtime>(app: &AppHandle<R>, answer: &Value) {
    let Some(revision) = answer.get("revision").and_then(Value::as_u64) else {
        return;
    };
    // The scene the number counts, when the answer says. A read of the tree names it; a mutation
    // reports only the revision, and the ledger keeps the scene it already had.
    let scene = answer
        .get("scene")
        .and_then(Value::as_str)
        .filter(|scene| !scene.is_empty());
    if let Ok(workspace) = crate::active_workspace(app) {
        crate::read_ledger::remember_revision(workspace.root(), scene, revision);
    }
}

fn take_u64(params: &mut Value, key: &str) -> Option<u64> {
    params
        .as_object_mut()
        .and_then(|object| object.remove(key))
        .and_then(|value| value.as_u64())
}

/// Deserializes tool parameters into a handler's own request type, so the handler's validation is
/// the only validation and a malformed call is refused before it reaches the editor.
fn from_params<T: serde::de::DeserializeOwned>(params: Value) -> Result<T, ToolFailure> {
    serde_json::from_value(params)
        .map_err(|error| ToolFailure::new("invalid_params", error.to_string()))
}

/// Builds a serde-tagged request out of `op` plus the caller's parameters. The router's snake_case
/// operation names are the model-facing spelling of the same variants the renderer sends in
/// camelCase, so the tag is derived rather than mapped by a second table that could drift.
fn from_tagged_params<T: serde::de::DeserializeOwned>(
    op: &str,
    params: Value,
) -> Result<T, ToolFailure> {
    let mut tagged = params;
    let object = tagged
        .as_object_mut()
        .ok_or_else(|| ToolFailure::new("invalid_params", "Parameters must be an object"))?;
    object.insert("op".to_owned(), json!(to_camel_case(op)));
    from_params(tagged)
}

pub(crate) fn to_camel_case(op: &str) -> String {
    let mut result = String::with_capacity(op.len());
    let mut capitalize = false;
    for character in op.chars() {
        if character == '_' {
            capitalize = true;
            continue;
        }
        if capitalize {
            result.extend(character.to_uppercase());
            capitalize = false;
        } else {
            result.push(character);
        }
    }
    result
}

/// Serialization of a handler's own response type cannot fail — every one of them is a plain
/// struct or enum — but a router that panicked on it would take the agent turn with it.
fn to_value<T: Serialize>(value: T) -> Value {
    serde_json::to_value(value)
        .unwrap_or_else(|error| json!({"serializationError": error.to_string()}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::Manager;
    use tempfile::TempDir;

    /// Writes the serialized catalogue to `GOFER_CATALOG_DUMP`, so a bench outside this crate reads
    /// the same bytes the worker is sent rather than a hand copy of them. A no-op without the
    /// variable, which is how it costs an ordinary `cargo test` nothing.
    #[test]
    fn dump_the_catalog_when_asked() {
        let Ok(path) = std::env::var("GOFER_CATALOG_DUMP") else {
            return;
        };
        std::fs::write(
            path,
            serde_json::to_string(CATALOG).expect("serialize the catalogue"),
        )
        .expect("write the catalogue");
    }

    /// The domain the batch rules are exercised against, by name from the catalogue.
    ///
    /// A real one rather than a fixture, because one of the four rules — whether an entry takes
    /// `expectedRevision` — is read out of `params.json` for the operation named.
    fn scene_domain() -> &'static ToolDomain {
        CATALOG
            .iter()
            .find(|domain| domain.name == "godot_scene")
            .expect("the scene domain is in the catalogue")
    }

    /// A domain the auto-start seam is exercised against, by name from the catalogue.
    fn project_domain() -> &'static ToolDomain {
        CATALOG
            .iter()
            .find(|domain| domain.name == "godot_project")
            .expect("the project domain is in the catalogue")
    }

    fn requested(op: &str, params: Value) -> Requested {
        Requested {
            op: op.to_owned(),
            params,
        }
    }

    /*
     * The four rules a batch follows, with nothing behind them.
     *
     * All four were provable only by driving a real editor through a whole `ops` list, because the
     * fold called the router directly. What the fold decides is not about the editor at all: which
     * entry runs next, what a failure does to the rest, when the call itself fails, and which entry
     * gets told what the one before it produced.
     */
    #[test]
    fn a_batch_stops_at_the_first_failure_and_says_what_it_did_not_run() {
        let ran = std::cell::RefCell::new(Vec::new());
        let answer = run_in_order(
            scene_domain(),
            vec![
                requested("save", json!({})),
                requested("reload", json!({})),
                requested("save_as", json!({"path": "b.tscn"})),
            ],
            |op, _| {
                ran.borrow_mut().push(op.to_owned());
                if op == "reload" {
                    return Err(ToolFailure::new(
                        "scene_locked",
                        "the scene would not reload",
                    ));
                }
                Ok(json!({"ok": true}))
            },
        )
        .expect("a batch where something worked answers rather than fails");

        // The entry after a failed one usually depends on it, so it is not attempted at all.
        assert_eq!(*ran.borrow(), vec!["save", "reload"]);
        let ops = answer["ops"].as_array().expect("the entries");
        assert_eq!(ops.len(), 3, "every entry is accounted for: {answer}");
        assert_eq!(ops[1]["error"]["code"], "scene_locked");
        assert_eq!(ops[2]["because"], "scene_locked");
        assert!(ops[2]["skipped"].is_string(), "{answer}");
    }

    /*
     * A failure crossing the channel keeps its code and its message and loses its details, so a
     * part-applied list answered as one failure would tell the model that eleven nodes it had just
     * created do not exist. Only a list where nothing landed carries nothing the failure does not.
     */
    #[test]
    fn a_batch_fails_only_when_nothing_in_it_worked() {
        let refused = run_in_order(
            scene_domain(),
            vec![requested("save", json!({})), requested("reload", json!({}))],
            |_, _| Err(ToolFailure::new("session_not_active", "no editor")),
        )
        .expect_err("a list where nothing worked is the failure itself");
        assert_eq!(refused.code, "session_not_active");
    }

    /// The revision an entry has to expect is the one the entry before it produced, and that number
    /// does not exist when the call is written — so no caller can supply it.
    #[test]
    fn each_entry_is_told_what_the_one_before_it_produced() {
        let seen = std::cell::RefCell::new(Vec::new());
        run_in_order(
            scene_domain(),
            vec![
                requested("save", json!({})),
                requested("reload", json!({})),
                requested("save_as", json!({"path": "b.tscn"})),
            ],
            |op, params| {
                seen.borrow_mut()
                    .push((op.to_owned(), params["expectedRevision"].clone()));
                Ok(json!({"revision": if op == "save" { 7 } else { 9 }}))
            },
        )
        .expect("every entry worked");

        let seen = seen.borrow();
        assert!(seen[0].1.is_null(), "entry 0 is told nothing: {seen:?}");
        assert_eq!(seen[1].1, json!(7), "{seen:?}");
        assert_eq!(seen[2].1, json!(9), "and it follows the chain: {seen:?}");
    }

    /*
     * Entry 0's own revision is left exactly as written.
     *
     * That one is the guard against the scene having changed under the whole call, and it is the
     * only revision a caller can know. Overwriting it would throw the guard away on every batch.
     */
    #[test]
    fn the_first_entrys_own_revision_is_never_overwritten() {
        let seen = std::cell::RefCell::new(Vec::new());
        run_in_order(
            scene_domain(),
            vec![
                requested("save", json!({"expectedRevision": 2})),
                requested("reload", json!({"expectedRevision": 2})),
            ],
            |_, params| {
                seen.borrow_mut().push(params["expectedRevision"].clone());
                Ok(json!({"revision": 40}))
            },
        )
        .expect("every entry worked");

        let seen = seen.borrow();
        assert_eq!(seen[0], json!(2), "what the caller wrote: {seen:?}");
        // And a later entry's own number IS replaced: anything the caller wrote there is a guess
        // about a revision that did not exist yet.
        assert_eq!(seen[1], json!(40), "{seen:?}");
    }

    /// An operation that does not declare `expectedRevision` is never given one, whatever the
    /// entry before it answered with.
    #[test]
    fn an_operation_with_no_revision_parameter_is_left_alone() {
        let seen = std::cell::RefCell::new(Vec::new());
        run_in_order(
            scene_domain(),
            vec![
                requested("save", json!({})),
                requested("get_tree", json!({})),
            ],
            |_, params| {
                seen.borrow_mut().push(params.clone());
                Ok(json!({"revision": 5}))
            },
        )
        .expect("every entry worked");

        assert!(
            seen.borrow()[1].get("expectedRevision").is_none(),
            "{:?}",
            seen.borrow()
        );
    }

    /// A backend with no window: nothing here can approve anything, so a gated operation that
    /// reports `approval_unavailable` proves the gate stopped it before its handler ran.
    fn unattended_app() -> tauri::App<tauri::test::MockRuntime> {
        tauri::test::mock_builder()
            .build(crate::app_context())
            .expect("build mock Tauri app")
    }

    /// A scene is not something this domain writes.
    #[test]
    fn the_script_domain_refuses_a_file_that_is_not_a_script() {
        let app = unattended_app();
        let failure = dispatch(
            app.handle(),
            call(
                "godot_script",
                "save",
                json!({"path": "scenes/level_1.tscn", "text": "[gd_scene]"}),
            ),
        )
        .expect_err("a scene written as text must be refused");
        assert_eq!(failure.code, "unsupported_file");
        assert!(
            failure.message.contains("godot_scene"),
            "the refusal must name the tool that owns a scene: {}",
            failure.message
        );
    }

    /// Every operation the catalog offers for the editor's own domains has to exist in the addon.
    ///
    /// The catalog is what the model reads and the addon is what answers, and nothing else keeps
    /// them together: four node operations were advertised for months with no handler behind them,
    /// so an agent that reached for one could only ever be told the command was unknown.
    /// It reads the route rather than rebuilding it. The prefix arithmetic and the two exception
    /// lists this used to carry were a third copy of the mapping `params.json` holds as data, and a
    /// copy that drifted would have made the test agree with itself about the wrong command.
    #[test]
    fn every_editor_operation_the_catalog_offers_has_an_addon_handler() {
        const ADDON: &str = include_str!("../addon/plugin.gd");
        for domain in CATALOG {
            for operation in domain.operations {
                let Some(crate::tool_params::Answers::Addon(command)) =
                    crate::tool_params::answers(domain.name, operation.op)
                else {
                    continue;
                };
                assert!(
                    ADDON.contains(&format!("\"{command}\":")),
                    "{} {} is offered to the model but the addon has no handler for {command}",
                    domain.name,
                    operation.op
                );
            }
        }
    }

    /// Every command the protocol calls mutating has to exist in the addon that answers it.
    ///
    /// This is the direction the catalog test above cannot cover: a command can be written into the
    /// frozen contract, listed by both clients as needing `expectedRevision`, and still reach an
    /// addon with no handler for it. Four node commands lived that way — the spec promised
    /// `node.connect_signal` while the addon answered `unknown_command`, so a scene could never be
    /// wired up in the editor at all.
    #[test]
    fn every_mutating_command_the_protocol_declares_exists_in_the_addon() {
        const ADDON: &str = include_str!("../addon/plugin.gd");
        for command in crate::protocol_v2::MUTATING_COMMANDS {
            assert!(
                ADDON.contains(&format!("\"{command}\":")),
                "the protocol declares {command} mutating but the addon has no handler for it"
            );
            assert!(
                ADDON.contains(&format!("    \"{command}\",")),
                "the addon must guard {command} with a revision, as the protocol says it does"
            );
        }
    }

    /// The schema and the code have to call the same commands mutating.
    ///
    /// The schema carries its own copy of the list, and it silently lost one: `node.instantiate`
    /// was added to the contract, to the addon and to both clients, and the schema went on
    /// describing a request for it as valid without `expectedRevision`. Nothing noticed, because
    /// the schema is only read by the fixture tests and no fixture exercised that command.
    #[test]
    fn the_schema_names_the_same_mutating_commands_the_code_does() {
        const SCHEMA: &str = include_str!("../../protocol/schemas/v2/request.schema.json");
        let schema: Value = serde_json::from_str(SCHEMA).expect("the request schema is JSON");
        let listed = schema["allOf"]
            .as_array()
            .and_then(|entries| {
                entries.iter().find_map(|entry| {
                    entry["if"]["properties"]["command"]["enum"]
                        .as_array()
                        .cloned()
                })
            })
            .expect("the schema requires expectedRevision of some commands");
        let listed: Vec<&str> = listed.iter().filter_map(Value::as_str).collect();
        assert_eq!(
            listed,
            crate::protocol_v2::MUTATING_COMMANDS.to_vec(),
            "the schema's mutating commands must be the ones the code guards, in the same order"
        );
    }

    /// A script named the way the editor names it reaches the file the worktree holds.
    ///
    /// The catalog mixes two path conventions because Godot does: a scene is `res://main.tscn` and
    /// a script is `scripts/main.gd`. A model reaches for the one it just used, so `godot_script
    /// open` was told a file it had written a moment earlier did not exist.
    #[test]
    fn a_resource_path_reaches_the_same_script_as_a_worktree_path() {
        assert_eq!(
            accept_resource_paths(json!({"path": "res://scripts/mario.gd"}))["path"],
            "scripts/mario.gd"
        );
        // Already worktree-relative, and left exactly as it is.
        assert_eq!(
            accept_resource_paths(json!({"path": "scripts/mario.gd"}))["path"],
            "scripts/mario.gd"
        );
        // The nested paths of `apply_rename` and `set_breakpoints`.
        let nested = accept_resource_paths(json!({
            "files": [{"path": "res://scripts/a.gd"}],
            "breakpoints": [{"path": "res://scripts/b.gd", "lines": [1]}]
        }));
        assert_eq!(nested["files"][0]["path"], "scripts/a.gd");
        assert_eq!(nested["breakpoints"][0]["path"], "scripts/b.gd");
        // Stripping the prefix must not become a way out of the worktree: what is left is still a
        // relative path, and a relative path that climbs is refused where every other one is.
        assert_eq!(
            accept_resource_paths(json!({"path": "res://../secrets.gd"}))["path"],
            "../secrets.gd"
        );
        let directory = tempfile::TempDir::new().expect("temporary directory");
        let workspace = crate::files::Workspace::open(directory.path()).expect("open workspace");
        assert!(
            workspace.resolve("../secrets.gd").is_err(),
            "a path that climbs out of the worktree must still be refused"
        );
        // A batched call names its scripts as a list, and each one still meets the editor's
        // convention or the worktree's.
        let batched = accept_resource_paths(json!({
            "path": ["res://scripts/a.gd", "scripts/b.gd"]
        }));
        assert_eq!(batched["path"][0], "scripts/a.gd");
        assert_eq!(batched["path"][1], "scripts/b.gd");
    }

    /// The three operations an agent repeats take a list, so it can stop repeating them.
    ///
    /// A live turn opened nine scripts with nine `open` calls and then asked about them with a
    /// `diagnostics` call each: every one a round-trip, an answer the turn pays context for, and —
    /// for `diagnostics` — a full wait of its own when the server is silent. The contract is what
    /// forced it, because `path` was a single string, so the fix is here rather than in a sentence
    /// asking the model to batch what it cannot batch.
    #[test]
    fn the_repeated_script_operations_take_a_list_of_paths() {
        for op in ["open", "close", "diagnostics"] {
            let params = crate::tool_params::TABLE
                .iter()
                .find(|entry| entry.domain == "godot_script" && entry.op == op)
                .unwrap_or_else(|| panic!("godot_script {op} declares its parameters"));
            let path = params
                .params
                .iter()
                .find(|param| param.name == "path")
                .unwrap_or_else(|| panic!("godot_script {op} names a path"));
            assert_eq!(
                path.kind,
                crate::tool_params::Kind::Either(&[
                    crate::tool_params::Kind::Text,
                    crate::tool_params::Kind::List
                ]),
                "godot_script {op} must take one script or a list of them"
            );
            // A list is what the check has to let through: the handler never sees a call the
            // parameter contract rejected.
            crate::tool_params::check(
                "godot_script",
                op,
                &json!({"path": ["scripts/a.gd", "scripts/b.gd"]}),
            )
            .unwrap_or_else(|failure| {
                panic!("a list of paths must pass {op}: {}", failure.message)
            });
        }
    }

    /// A batch is refused for the same file a single call is refused for, and says which.
    #[test]
    fn a_batch_of_scripts_refuses_the_entry_that_is_not_a_script() {
        let failure = named_scripts(&json!({"path": ["scripts/a.gd", "scenes/level_1.tscn"]}))
            .expect_err("a scene inside a batch must be refused");
        assert_eq!(failure.code, "unsupported_file");
        assert!(
            failure.message.contains("scenes/level_1.tscn"),
            "the refusal must name the entry that is wrong: {}",
            failure.message
        );
        // An empty list asks for nothing, and is a clearer failure than an answer with no files.
        assert_eq!(
            named_scripts(&json!({"path": []}))
                .expect_err("an empty list must be refused")
                .code,
            "invalid_params"
        );
        // One path keeps the single answer; a list is the batch answer.
        assert_eq!(
            named_scripts(&json!({"path": "scripts/a.gd"})).expect("one script"),
            (vec!["scripts/a.gd".to_owned()], false)
        );
        assert_eq!(
            named_scripts(&json!({"path": ["scripts/a.gd"]})).expect("a list of one"),
            (vec!["scripts/a.gd".to_owned()], true)
        );
        assert_eq!(
            one_or_many(vec![json!({"closed": true})], false),
            json!({"closed": true})
        );
        assert_eq!(
            one_or_many(vec![json!({"closed": true})], true),
            json!({"files": [{"closed": true}]})
        );
    }

    fn call(tool: &str, op: &str, params: Value) -> ToolRequest {
        calls(tool, &[(op, params)])
    }

    /// A call as the worker sends one: an `ops` list, each entry naming its operation beside the
    /// parameters. A call of one operation is a list of one.
    fn calls(tool: &str, ops: &[(&str, Value)]) -> ToolRequest {
        let listed: Vec<Value> = ops
            .iter()
            .map(|(op, params)| {
                let mut entry = params.clone();
                let object = entry
                    .as_object_mut()
                    .expect("a test call names its parameters in an object");
                object.insert("op".to_owned(), json!(op));
                entry
            })
            .collect();
        ToolRequest {
            tool: tool.to_owned(),
            params: json!({"ops": listed}),
        }
    }

    /// The answer of the only operation in a call, for the tests that send one.
    fn only_answer(answer: &Value) -> &Value {
        let ops = answer["ops"]
            .as_array()
            .expect("an answer carries its operations");
        assert_eq!(ops.len(), 1, "this call sent one operation: {answer}");
        &ops[0]["result"]
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
            !CATALOG.iter().any(|domain| domain.name == ASK_USER_TOOL),
            "ask_user must not be a catalog domain"
        );
        // Reachable by construction: it is compiled in, and whether a window is open is a thing
        // that changes during a turn rather than something a pre-turn probe can settle.
        let answer = probe(ASK_USER_TOOL).expect("ask_user answers its own probe");
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
        let sketch = |label: &str| crate::ask::Sketch {
            label: label.to_owned(),
            html: format!("<p>{label}</p>"),
        };
        let sketches = vec![sketch("Overlay"), sketch("Dock"), sketch("Rail")];
        let reply = crate::ask::Reply {
            text: "make the rows bigger".to_owned(),
            picked: None,
            blocked: Vec::new(),
            skipped: false,
            approved: false,
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
        let sketch = |label: &str, html: &str| crate::ask::Sketch {
            label: label.to_owned(),
            html: html.to_owned(),
        };
        let sketches = vec![
            sketch("Overlay", "res://a.png"),
            sketch("Dock", "res://b.png"),
        ];
        let shown = vec![sketch("Overlay", "data:a"), sketch("Dock", "data:b")];
        let reply = |picked: Option<usize>, skipped: bool| crate::ask::Reply {
            text: String::new(),
            picked,
            blocked: Vec::new(),
            skipped,
            approved: false,
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
            crate::ask::Sketch {
                label: "Bar across the top".to_owned(),
                html: "<p>a</p>".to_owned(),
            },
            crate::ask::Sketch {
                label: "Side rail".to_owned(),
                html: "<p>b</p>".to_owned(),
            },
        ];
        let answer = reply_answer(
            "question-1",
            &sketches,
            &crate::ask::Reply {
                picked: Some(1),
                text: "tighter".to_owned(),
                ..crate::ask::Reply::default()
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
            &crate::ask::Reply {
                picked: Some(7),
                ..crate::ask::Reply::default()
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
            crate::ask::Sketch {
                label: "Bar across the top".to_owned(),
                html: "<p>a</p>".to_owned(),
            },
            crate::ask::Sketch {
                label: "Side rail".to_owned(),
                html: "<p>b</p>".to_owned(),
            },
        ];
        let picked = reply_answer(
            "question-1",
            &sketches,
            &crate::ask::Reply {
                picked: Some(1),
                approved: true,
                ..crate::ask::Reply::default()
            },
            Vec::new(),
        );
        assert_eq!(picked["sketch"]["html"], json!("<p>b</p>"));
        assert_eq!(picked["sketch"]["label"], json!("Side rail"));

        // Words against one layout are a reaction to that layout, because there is no other.
        let said = reply_answer(
            "question-1",
            &sketches[..1],
            &crate::ask::Reply {
                text: "tighter".to_owned(),
                ..crate::ask::Reply::default()
            },
            Vec::new(),
        );
        assert_eq!(said["sketch"]["html"], json!("<p>a</p>"));

        // Words against three, with no pick, name none of them. Answering with the first is a guess
        // reported as a fact, and it is the fact somebody builds.
        let unpicked = reply_answer(
            "question-1",
            &sketches,
            &crate::ask::Reply {
                text: "tighter".to_owned(),
                ..crate::ask::Reply::default()
            },
            Vec::new(),
        );
        assert_eq!(unpicked["sketch"], Value::Null);

        // A skip reacted to nothing, and a question in words has nothing to react to.
        let skipped = reply_answer(
            "question-1",
            &sketches,
            &crate::ask::Reply {
                skipped: true,
                ..crate::ask::Reply::default()
            },
            Vec::new(),
        );
        assert_eq!(skipped["sketch"], Value::Null);
        let wordy = reply_answer("question-1", &[], &crate::ask::Reply::default(), Vec::new());
        assert_eq!(wordy["sketch"], Value::Null);
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

    /// Every tool the worker declares has to be able to say whether it can answer, and a tool
    /// added to the catalog without a probe has to fail rather than be assumed reachable.
    #[test]
    fn every_catalog_domain_answers_a_reachability_probe() {
        for domain in CATALOG {
            if domain.name == "godot_docs_search" {
                // The one probe that reads the machine: it is asserted to be probed, not to pass,
                // because whether the models are downloaded is not this test's subject.
                assert!(
                    probe(domain.name)
                        .map_err(|failure| failure.code)
                        .err()
                        .is_none_or(|code| code == "docs_unavailable")
                );
                continue;
            }
            let answer = probe(domain.name).expect("a catalog domain must answer its own probe");
            assert_eq!(answer["reachable"], json!(true), "{}", domain.name);
        }

        assert_eq!(
            probe("godot_something_new")
                .expect_err("an unprobed domain must fail")
                .code,
            "unprobed_tool"
        );
    }

    /// The probe is answered before anything a real call passes through: there is no operation to
    /// validate, no user to approve it, and no editor session to route it to.
    #[test]
    fn a_probe_is_answered_without_an_operation_a_session_or_an_approval() {
        let app = unattended_app();
        let answer = dispatch(
            app.handle(),
            ToolRequest {
                tool: "godot_project".to_owned(),
                params: json!({"probe": true}),
            },
        )
        .expect("a probe carries no operation");
        assert_eq!(answer["reachable"], json!(true));

        let failure = dispatch(
            app.handle(),
            ToolRequest {
                tool: "godot_nonexistent".to_owned(),
                params: json!({"probe": true}),
            },
        )
        .expect_err("a tool that is not in the catalog cannot be reachable");
        assert_eq!(failure.code, "unknown_tool");
    }

    /**
     * The design loop reaches its own route, by the name the Node side actually sends.
     *
     * Worth a test of its own because the failure is silent by design. The design tool swallows
     * whatever this answers — an announcement that did not arrive must cost the card its held-open
     * state and never the design itself — so a name that stopped matching here would read as the bug
     * this whole seam was built to remove, with nothing anywhere saying why.
     */
    #[test]
    fn a_design_session_is_routed_by_name_and_is_not_a_catalogue_domain() {
        let app = unattended_app();
        for state in ["open", "closed"] {
            let answer = dispatch(
                app.handle(),
                ToolRequest {
                    tool: DESIGN_SESSION_TOOL.to_owned(),
                    params: json!({"sessionId": "design-1", "state": state}),
                },
            )
            .expect("the design session is answered rather than looked up in the catalogue");
            assert_eq!(answer["state"], json!(state));
        }
        assert!(
            !CATALOG
                .iter()
                .any(|domain| domain.name == DESIGN_SESSION_TOOL),
            "the catalogue is the Godot domains, and this is not one"
        );
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

    /// A malformed announcement is refused by name rather than emitting an edge nobody asked for.
    #[test]
    fn a_design_session_with_no_state_is_refused() {
        let app = unattended_app();
        let failure = dispatch(
            app.handle(),
            ToolRequest {
                tool: DESIGN_SESSION_TOOL.to_owned(),
                params: json!({"sessionId": "design-1"}),
            },
        )
        .expect_err("an announcement that says nothing is not an announcement");
        assert_eq!(failure.code, "invalid_params");
    }

    /// Issue #5. An editor operation asked with no session started one and answered, instead of
    /// refusing with a code the model can do nothing about.
    #[test]
    fn an_editor_operation_with_no_session_starts_one_and_answers() {
        let started = std::cell::Cell::new(0);
        let answered = starting_the_session_if_there_is_none(
            project_domain(),
            json!({}),
            |_| {
                if started.get() == 0 {
                    return Err(ToolFailure::new(
                        "session_not_active",
                        "No Godot session is active",
                    ));
                }
                Ok(json!({"mainScene": "res://main.tscn"}))
            },
            || {
                started.set(started.get() + 1);
                Ok(())
            },
        )
        .expect("the operation is answered from the session it started");
        assert_eq!(started.get(), 1, "the session is started once");
        assert_eq!(answered["mainScene"], json!("res://main.tscn"));
    }

    /// Anything but a missing session is the handler's answer, and is not retried.
    #[test]
    fn a_failure_that_is_not_a_missing_session_starts_nothing() {
        let started = std::cell::Cell::new(0);
        let ran = std::cell::Cell::new(0);
        let failure = starting_the_session_if_there_is_none(
            project_domain(),
            json!({}),
            |_| {
                ran.set(ran.get() + 1);
                Err(ToolFailure::new("not_ready", "the session is importing"))
            },
            || {
                started.set(started.get() + 1);
                Ok(())
            },
        )
        .expect_err("the handler's own failure is the answer");
        assert_eq!(failure.code, "not_ready");
        assert_eq!((ran.get(), started.get()), (1, 0));
    }

    /// A stop that started an editor would be the opposite of what was asked.
    #[test]
    fn the_session_domain_never_starts_an_editor_behind_its_own_back() {
        let started = std::cell::Cell::new(0);
        let failure = starting_the_session_if_there_is_none(
            CATALOG
                .iter()
                .find(|domain| domain.name == "godot_session")
                .expect("the session domain"),
            json!({}),
            |_| {
                Err(ToolFailure::new(
                    "session_not_active",
                    "No Godot session is active",
                ))
            },
            || {
                started.set(started.get() + 1);
                Ok(())
            },
        )
        .expect_err("stopping a session that is not running is not a reason to start one");
        assert_eq!(failure.code, "session_not_active");
        assert_eq!(started.get(), 0);
    }

    /// A start that could not happen still answers "no session", and says why it could not.
    ///
    /// Through the real router: `unattended_app` has no project storage, so the start the router
    /// now makes for itself fails there rather than launching an editor.
    #[test]
    fn a_session_that_cannot_be_started_says_why_it_could_not() {
        let app = unattended_app();
        let failure = dispatch(
            app.handle(),
            call("godot_project", "get_settings", json!({})),
        )
        .expect_err("nothing can start a session for an app with no project storage");
        assert_eq!(failure.code, "session_not_active");
        assert_eq!(
            failure.details["startFailure"],
            json!("storage_unavailable")
        );
        assert!(
            failure.message.contains("Starting one failed"),
            "the refusal has to carry the reason the start failed: {}",
            failure.message
        );
    }

    #[test]
    fn a_gated_operation_stops_before_its_handler_runs() {
        let app = unattended_app();

        let failure = dispatch(
            app.handle(),
            call(
                "godot_project",
                "set_editor_setting",
                json!({
                    "name": "interface/editor/single_window_mode",
                    "value": {"type": "bool", "value": true}
                }),
            ),
        )
        .expect_err("a machine-wide editor setting needs the user");
        assert_eq!(failure.code, "approval_unavailable");
        assert!(failure.retryable);

        // The same domain's auto-allowed operations reach the handler, which reports the missing
        // session rather than a missing approval.
        let failure = dispatch(
            app.handle(),
            call("godot_project", "get_settings", json!({})),
        )
        .expect_err("no session is active");
        assert_eq!(failure.code, "session_not_active");
        let failure = dispatch(
            app.handle(),
            call(
                "godot_project",
                "set_setting",
                json!({"name": "a", "value": {"type": "int", "value": 1}}),
            ),
        )
        .expect_err("no session is active");
        assert_eq!(failure.code, "session_not_active");
    }

    /// The shape of a call, refused before anything runs.
    ///
    /// Every one of these is answered without a session, an editor or a user, because none of them
    /// is a question about the operation — they are questions about the list carrying it.
    #[test]
    fn a_call_that_is_not_a_list_of_operations_is_refused_before_anything_runs() {
        let app = unattended_app();
        let refusal = |params: Value| {
            dispatch(
                app.handle(),
                ToolRequest {
                    tool: "godot_node".to_owned(),
                    params,
                },
            )
            .expect_err("this call cannot be run")
        };

        // No list at all. The message shows the shape rather than naming it, because a model that
        // wrote the wrong one cannot act on the word "list".
        let failure = refusal(json!({"op": "inspect", "node": "/Level1"}));
        assert_eq!(failure.code, "missing_ops");
        assert!(failure.message.contains("\"ops\""), "{}", failure.message);

        assert_eq!(refusal(json!({"ops": []})).code, "empty_ops");
        assert_eq!(refusal(json!({"ops": ["inspect"]})).code, "invalid_params");
        assert_eq!(
            refusal(json!({"ops": [{"node": "/Level1"}]})).code,
            "missing_op"
        );
        assert_eq!(
            refusal(json!({"ops": [{"op": "detonate"}]})).code,
            "unknown_operation"
        );
    }

    /// A parameter mistake in the fourth entry has to name the fourth entry.
    ///
    /// The checker's own sentence is about the operation, and it is the same sentence whichever
    /// entry wrote it. `godot_node create requires `type`` is not actionable when the model sent
    /// eleven creates; the entry it came from is the whole of what makes it one.
    #[test]
    fn a_bad_entry_is_blamed_by_its_position_and_nothing_in_the_list_runs() {
        let app = unattended_app();
        let failure = dispatch(
            app.handle(),
            calls(
                "godot_node",
                &[
                    (
                        "create",
                        json!({"parent": "/L", "type": "Node2D", "name": "A"}),
                    ),
                    (
                        "create",
                        json!({"parent": "/L", "type": "Node2D", "name": "B"}),
                    ),
                    ("create", json!({"parent": "/L", "name": "C"})),
                ],
            ),
        )
        .expect_err("an entry with no type cannot be run");
        assert_eq!(failure.code, "missing_param");
        assert!(
            failure.message.starts_with("`ops[2]` (create):"),
            "{}",
            failure.message
        );
        assert_eq!(failure.details["opIndex"], json!(2));

        // A call of one says nothing about a list, because there is no list to point into.
        let failure = dispatch(
            app.handle(),
            call("godot_node", "create", json!({"parent": "/L", "name": "C"})),
        )
        .expect_err("one entry with no type cannot be run either");
        assert!(!failure.message.contains("ops["), "{}", failure.message);
        assert_eq!(failure.details["opIndex"], Value::Null);
    }

    /// A batched `open` answers with whole files and a note, never with one cut in half.
    ///
    /// The worker slices a tool result at 24,000 characters. Ten of thirty-two `open` calls in a
    /// live project reached that, always in the last file named, and an `edit` anchored on the text
    /// the model had been shown half of then failed with `anchor_not_found`.
    #[test]
    fn a_batched_open_stops_carrying_text_before_the_worker_cuts_it() {
        // One file is answered whatever it weighs: there is no smaller call to be sent instead.
        assert!(!withholds_the_text(0, OPEN_TEXT_BUDGET * 4, true));

        // Files keep coming while the budget holds, and stop at the one that would overrun it.
        assert!(!withholds_the_text(OPEN_TEXT_BUDGET - 1, 1, false));
        assert!(withholds_the_text(OPEN_TEXT_BUDGET - 1, 2, false));

        // The two files a live project opened together, at the sizes it opened them: 22,752 and
        // 6,671 bytes, which the worker answered as one 24,031-character slice.
        assert!(!withholds_the_text(0, 22_752, true));
        assert!(withholds_the_text(22_752, 6_671, false));

        // And the budget leaves the answer inside the worker's cap once the JSON around it is
        // counted — path, hash and version ride along with every file.
        const { assert!(OPEN_TEXT_BUDGET < 24_000) };
    }

    /// The gate on its own, given a list of operation names.
    ///
    /// Called directly rather than through `dispatch`, because the parameters are not what it
    /// reads: they are checked one entry earlier, and threading a valid set through thirty-five
    /// operations would test that checker instead of this one.
    fn gate(tool: &str, ops: &[&str]) -> Result<(), ToolFailure> {
        let domain = CATALOG
            .iter()
            .find(|domain| domain.name == tool)
            .expect("a catalogue domain");
        let entries: Vec<Requested> = ops
            .iter()
            .map(|op| Requested {
                op: (*op).to_owned(),
                params: json!({}),
            })
            .collect();
        refuse_a_list_that_holds_a_lone_operation(domain, &entries)
    }

    /// The two narrowings, each refused in its own words, and neither one costing a list that is
    /// merely two steps long.
    #[test]
    fn a_repeated_operation_is_refused_and_a_two_step_list_is_not() {
        // `Repeat`: the same operation twice. The later twin is the one named, because the first is
        // the one the caller keeps.
        let failure = gate("godot_scene", &["open", "open"]).expect_err("one scene is open");
        assert_eq!(failure.code, "op_repeated");
        assert_eq!(failure.details["opIndex"], json!(1));
        assert_eq!(failure.details["firstIndex"], json!(0));
        // The sentence is the operation's own, so the refusal says which narrowing it is.
        assert!(
            failure.message.contains("One scene is open at a time"),
            "{}",
            failure.message
        );

        // The same operation beside a different one is an ordinary two-step request, and the whole
        // point of `ops`.
        gate("godot_scene", &["open", "get_tree"]).expect("open then read the tree");
        gate("godot_runtime", &["capture", "get_state"]).expect("a frame and the state");
        gate("godot_debug", &["status", "threads"]).expect("two reads of the debuggee");

        // `Exclusive`: the debugger refuses to share a call at all, whatever the other entry is.
        let failure = gate("godot_debug", &["continue", "threads"]).expect_err("one debuggee");
        assert_eq!(failure.code, "must_be_alone");
        assert_eq!(failure.details["opIndex"], json!(0));
        assert!(
            failure.message.contains("One debuggee, driven in order"),
            "{}",
            failure.message
        );

        // Narrowed is not refused. A list of one passes the gate whatever its scope, and reaching
        // the handler is what proves the gate is wired into `dispatch` at all.
        let app = unattended_app();
        let failure = dispatch(
            app.handle(),
            call("godot_scene", "open", json!({"path": "res://a.tscn"})),
        )
        .expect_err("no session is active");
        assert_eq!(failure.code, "session_not_active");

        // Every operation the table names is one the catalogue offers.
        for entry in crate::tool_params::ALONE {
            assert!(
                CATALOG.iter().any(|domain| domain.name == entry.domain
                    && domain.operations.iter().any(|op| op.op == entry.op)),
                "{}.{} is marked alone and is not in the catalogue",
                entry.domain,
                entry.op
            );
        }
    }

    /// Every narrowed operation, refused when it is asked for what its scope does not allow, and
    /// allowed the other shape.
    ///
    /// Generated from the table rather than listed, so an operation added to it is covered the day
    /// it lands, and one whose scope changes is covered in its new sense.
    #[test]
    fn every_narrowed_operation_is_refused_in_the_shape_its_scope_names() {
        for entry in crate::tool_params::ALONE {
            // An operation of the same domain to stand beside it. Any one will do: what the gate
            // reads is the scope, not the neighbour.
            let domain = CATALOG
                .iter()
                .find(|domain| domain.name == entry.domain)
                .expect("a catalogue domain");
            let neighbour = domain
                .operations
                .iter()
                .map(|operation| operation.op)
                .find(|op| *op != entry.op)
                .expect("a domain offers more than one operation");

            // Twice is refused whatever the scope. An exclusive operation is answered in its own
            // words rather than as a repeat: sharing at all is what it cannot do, and a caller told
            // to drop the second entry would send the first one beside something else next.
            let twice = gate(entry.domain, &[entry.op, entry.op])
                .expect_err("a narrowed operation is never allowed twice");
            assert_eq!(
                twice.code,
                match entry.scope {
                    Sharing::Repeat => "op_repeated",
                    Sharing::Exclusive => "must_be_alone",
                },
                "{}.{}: {}",
                entry.domain,
                entry.op,
                twice.message
            );
            assert!(
                twice.message.contains(entry.reason),
                "{}.{} does not carry its own sentence: {}",
                entry.domain,
                entry.op,
                twice.message
            );

            let beside = gate(entry.domain, &[entry.op, neighbour]);
            match entry.scope {
                Sharing::Repeat => {
                    beside.unwrap_or_else(|failure| {
                        panic!(
                            "{}.{} may sit beside {neighbour}: {}",
                            entry.domain, entry.op, failure.message
                        )
                    });
                }
                Sharing::Exclusive => {
                    let failure = beside.expect_err("an exclusive operation shares nothing");
                    assert_eq!(failure.code, "must_be_alone");
                    assert_eq!(failure.details["op"], json!(entry.op));
                    assert!(
                        failure.message.contains(entry.reason),
                        "{}.{}: {}",
                        entry.domain,
                        entry.op,
                        failure.message
                    );
                }
            }
        }
    }

    /// The four pairs a model wrote against `godot_session`, and what the router does with them now.
    ///
    /// They were written against the unbounded `ops` array the domain used to advertise, one per
    /// ordinary two-step request, and every one of them was refused. Three of the four are two
    /// different operations, which `run_in_order` has always been able to walk — so the refusal was
    /// the defect, not the call. Only the pair that repeats one is still refused.
    #[test]
    fn the_session_pairs_a_model_wrote_run_unless_they_repeat_an_operation() {
        // "Start the Godot editor session, then report its status."
        gate("godot_session", &["start", "status"]).expect("start then report");
        // "The editor is blocked on a dialog. Read the session state, then press Discard."
        gate("godot_session", &["get_state", "answer_dialog"]).expect("read then press");
        // "Restart the editor session: stop it and start it again."
        gate("godot_session", &["stop", "start"]).expect("stop then start");

        // "Undo the last two editor operations." One undo stack, walked in order: the second entry
        // undoes whatever the first one left, which is not what the caller asked for.
        let failure = gate("godot_session", &["undo", "undo"]).expect_err("one undo stack");
        assert_eq!(failure.code, "op_repeated");
        assert_eq!(failure.details["op"], json!("undo"));
        assert!(
            failure.message.contains("One undo stack"),
            "{}",
            failure.message
        );
    }

    /// A launch the debugger already made is refused before the editor is asked for a second one.
    ///
    /// `runtime.run` guards on `is_playing_scene()`, which a debug-adapter launch does not set, so
    /// the editor started a second game beside the first and answered `runtime_not_running: The
    /// game started and then stopped before it was ready`. A live debugging turn met that twice and
    /// spent the seven calls in between trying to launch the project from the shell.
    #[test]
    fn a_game_the_debugger_started_is_not_launched_again() {
        for op in ["run", "restart"] {
            let refused = super::refuse_a_second_game(op, true)
                .expect_err("a second game must be refused while the debugger holds one");
            assert_eq!(refused.code, "already_running");
            assert!(
                refused.message.contains("godot_debug terminate"),
                "{refused:?}"
            );
            assert!(
                refused.message.contains("stack_trace"),
                "and says the game can be read where it is: {refused:?}"
            );
            assert!(super::refuse_a_second_game(op, false).is_ok());
        }
        // Everything else the runtime tool does is about the game that is already there.
        for op in ["stop", "get_state", "get_tree", "capture", "input", "wait"] {
            assert!(super::refuse_a_second_game(op, true).is_ok(), "{op}");
        }
    }

    /// One directory, however it is spelled, and no directory means the whole worktree.
    ///
    /// The rule both `list` operations narrow by. A live turn asked `godot_resource list` for one
    /// folder with the only key it could think of — `{"op": "list", "path": "assets"}` — was
    /// refused because there was no such parameter, and fell back to `bash find`.
    #[test]
    fn a_listing_narrowed_to_a_directory_holds_only_what_is_under_it() {
        for spelling in ["assets", "res://assets", "/assets/", "res://assets/"] {
            let under = Some(super::named_directory(spelling));
            assert!(
                super::is_under("assets/tiles.png", under.as_deref()),
                "{spelling}"
            );
            assert!(
                super::is_under("assets/Effects/hit.png", under.as_deref()),
                "a directory holds what is under it, at any depth: {spelling}"
            );
            assert!(
                !super::is_under("scripts/main.gd", under.as_deref()),
                "{spelling}"
            );
            // A sibling whose name merely starts the same way is not inside it.
            assert!(
                !super::is_under("assetsold/tiles.png", under.as_deref()),
                "{spelling}"
            );
            // The directory itself is not one of the files in it.
            assert!(!super::is_under("assets", under.as_deref()), "{spelling}");
        }
        assert!(
            super::is_under("anything/at/all.png", None),
            "no directory named is every file"
        );
    }

    /// Every distinct `ops` shape a model wrote across real work, and not one refused.
    ///
    /// `fixtures/recorded-tool-calls.json` is 712 calls from a live project reduced to their
    /// distinct lists of operation names, and 178 more from five `live_agent_acceptance` turns
    /// against a real 4.7.2 editor. Ten of the first set — eight shapes, marked `refusedBefore` —
    /// were refused by the rule this replaced, and every one of them was two different operations
    /// rather than a repeat. The fixture is the evidence, so the fixture is the test: what a model
    /// actually sends is what the gate has to let through.
    ///
    /// The nine shapes under `repairs` are deliberately not here. Those are calls the normalizer
    /// rewrites before the router sees them, so the raw form is expected to be refused; the JS side
    /// holds them to the shape they must be rewritten into.
    #[test]
    fn no_shape_a_model_recorded_is_refused_by_the_gate() {
        let recorded: Value = serde_json::from_slice(
            &std::fs::read(
                std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("../fixtures/recorded-tool-calls.json"),
            )
            .expect("read the recorded calls"),
        )
        .expect("parse the recorded calls");
        let cases = recorded["cases"].as_array().expect("recorded cases");
        assert!(cases.len() > 50, "the fixture lost its cases");

        let mut previously_refused = 0;
        for case in cases {
            let tool = case["tool"].as_str().expect("case tool");
            let ops: Vec<&str> = case["ops"]
                .as_array()
                .expect("case ops")
                .iter()
                .map(|entry| entry["op"].as_str().expect("an op name"))
                .collect();
            if case["refusedBefore"].as_bool().unwrap_or(false) {
                previously_refused += 1;
            }
            gate(tool, &ops).unwrap_or_else(|failure| {
                panic!("{tool} {ops:?} was refused: {}", failure.message)
            });
            // And every parameter beside those names, down the path the router really takes:
            // repair, then check. The gate above reads only the operation names, so a recorded call
            // could carry a value the router refuses and this fixture would still pass — which is
            // the half the shapes that cost live turns actually live in. Running the repair too is
            // what makes this a net under it: a rename that reached a key it should not have would
            // show up here as a call that used to be accepted and is not any more.
            for entry in case["ops"].as_array().expect("case ops") {
                let mut params = entry.clone();
                if let Some(object) = params.as_object_mut() {
                    object.remove("op");
                }
                let op = entry["op"].as_str().expect("an op name");
                crate::tool_params::repair(tool, op, &mut params);
                crate::tool_params::check(tool, op, &params).unwrap_or_else(|failure| {
                    panic!("{tool} {op} was refused: {}", failure.message)
                });
            }
        }
        assert_eq!(
            previously_refused, 8,
            "the fixture no longer carries the shapes the old rule refused"
        );
    }

    /// The regression this guard exists for. A live run met a parse error it could not fix, looked
    /// the warning up with `search_settings`, and wrote it back down — auto-allowed, because
    /// nothing between the model and the addon knew the user had asked for that warning.
    #[test]
    fn a_rule_the_user_enforced_is_refused_at_the_router() {
        let app = unattended_app();
        let enforcing = crate::settings::GodotSettings::default();
        let relaxed = crate::settings::GodotSettings {
            strict_typing: false,
            embed_game_window: false,
        };
        let warning = json!({
            "name": "debug/gdscript/warnings/unsafe_method_access",
            "value": {"type": "int", "value": 0}
        });

        let failure = dispatch_under(
            app.handle(),
            call("godot_project", "set_setting", warning.clone()),
            &enforcing,
        )
        .expect_err("an enforced warning is not the agent's to write");
        assert_eq!(failure.code, "policy_enforced");
        assert!(!failure.retryable, "retrying writes the same setting again");

        // With the rule off it is an ordinary setting again, and reaches the handler that reports
        // the missing session — which is what proves the refusal is the rule and not the name.
        assert_eq!(
            dispatch_under(
                app.handle(),
                call("godot_project", "set_setting", warning),
                &relaxed,
            )
            .expect_err("no session is active")
            .code,
            "session_not_active"
        );

        // The embed rule is approval-gated as well, so this also fixes the order: the refusal comes
        // first, and the user is never shown a prompt offering to undo their own answer.
        assert_eq!(
            dispatch_under(
                app.handle(),
                call(
                    "godot_project",
                    "set_editor_setting",
                    json!({
                        "name": crate::godot_policy::GAME_EMBED_MODE,
                        "value": {"type": "int", "value": 0}
                    }),
                ),
                &enforcing,
            )
            .expect_err("an enforced editor rule is refused rather than prompted")
            .code,
            "policy_enforced"
        );
    }

    #[test]
    fn a_path_outside_the_worktree_is_rejected_rather_than_offered_for_approval() {
        let directory = TempDir::new().expect("temporary application data");
        let workspace = directory.path().join("workspace");
        std::fs::create_dir(&workspace).expect("create workspace");
        let storage =
            crate::storage::ProjectStorage::open(&directory.path().join("data"), &workspace)
                .expect("open project storage");
        let app = unattended_app();
        app.manage(crate::storage::StorageSlot::new(Ok(storage)));

        for params in [
            json!({"path": "../escape.gd"}),
            json!({"path": "/etc/passwd"}),
        ] {
            let failure = dispatch(app.handle(), call("godot_resource", "delete", params))
                .expect_err("a path outside the worktree is refused");
            assert_eq!(failure.code, "invalid_path");
        }

        let failure = dispatch(
            app.handle(),
            call(
                "godot_resource",
                "move",
                json!({"from": "main.gd", "to": "../stolen.gd"}),
            ),
        )
        .expect_err("a destination outside the worktree is refused");
        assert_eq!(failure.code, "invalid_path");

        // Inside the worktree the same call is a decision the user gets to make, so it reaches the
        // prompt — which this unattended backend cannot show.
        let failure = dispatch(
            app.handle(),
            call("godot_resource", "delete", json!({"path": "main.gd"})),
        )
        .expect_err("an unattended backend cannot approve a delete");
        assert_eq!(failure.code, "approval_unavailable");
    }

    /// A file that is not a script can be deleted against a hash, the way a script always could.
    ///
    /// `delete` has always taken an `expectedHash`, and the only thing that produced one was a
    /// `godot_script` open or save — which works on `.gd` files. So the guard was unusable for
    /// exactly the files a wrong delete costs most: a scene, a tileset, a resource. A live agent
    /// tried to use it anyway and invented a number, which was refused, which is what put the
    /// asymmetry on the record.
    ///
    /// The listing fills the ledger and says nothing about it. The hash the guard runs on is the
    /// router's, so an answer that printed it would be asking a model to hold a number that every
    /// other arm now refuses to take from it.
    #[test]
    fn listing_records_the_hashes_a_delete_of_a_non_script_file_is_held_to() {
        let directory = TempDir::new().expect("temporary application data");
        let workspace_path = directory.path().join("workspace");
        std::fs::create_dir(&workspace_path).expect("create workspace");
        let storage =
            crate::storage::ProjectStorage::open(&directory.path().join("data"), &workspace_path)
                .expect("open project storage");
        let app = unattended_app();
        app.manage(crate::storage::StorageSlot::new(Ok(storage)));

        let scene = "[gd_scene format=3]\n\n[node name=\"Level\" type=\"Node2D\"]\n";
        let workspace = crate::active_workspace(app.handle()).expect("the task worktree");
        workspace
            .write("levels/level.tscn", scene, None)
            .expect("write the scene");

        // Looking around is the cheap call it has always been: no hash unless one is asked for.
        let listed = dispatch(app.handle(), call("godot_resource", "list", json!({})))
            .expect("list the worktree");
        let plain = &only_answer(&listed)["files"][0];
        assert_eq!(plain["path"], "levels/level.tscn");
        assert!(
            crate::read_ledger::recall(workspace.root(), "levels/level.tscn").is_none(),
            "an unasked-for hash is not read at all"
        );

        let listed = dispatch(
            app.handle(),
            call("godot_resource", "list", json!({"hashes": true})),
        )
        .expect("list the worktree with hashes");
        assert!(
            only_answer(&listed)["files"][0]["hash"].is_null(),
            "the hash is the router's to hold, not the model's to read: {listed}"
        );
        let hash = crate::read_ledger::recall(workspace.root(), "levels/level.tscn")
            .expect("the listing records what it read");
        assert_eq!(
            hash,
            files::hash_text(scene),
            "the recorded hash must be the one the delete is checked against"
        );

        // And it is: the same token refuses the delete once the file has moved on, and lets it
        // through while the file is what was listed.
        workspace
            .write(
                "levels/level.tscn",
                &format!("{scene}\n[node name=\"Player\"]\n"),
                Some(&hash),
            )
            .expect("someone edits the scene");
        assert_eq!(
            workspace
                .delete("levels/level.tscn", Some(&hash))
                .expect_err("a scene that changed since it was listed must not be deleted")
                .code,
            "file_conflict"
        );
        let current = workspace
            .hash_of("levels/level.tscn")
            .expect("read the current hash")
            .expect("the scene is still there");
        workspace
            .delete("levels/level.tscn", Some(&current))
            .expect("the current hash deletes it");
    }

    /// A record that outlives its file must not refuse every save of that path forever.
    ///
    /// The file goes away outside the router — the Godot editor deletes it, a checkout reverts it —
    /// and the ledger still holds the hash the agent's last read answered with. The router attaches
    /// it, the write is refused because there is nothing there to match, and the refusal tells the
    /// agent to save again. Without this the next save carries the same dead record and is refused
    /// the same way, and the agent cannot see or clear the parameter that is stopping it.
    #[test]
    fn a_record_that_outlived_its_file_is_dropped_so_the_next_save_creates_it() {
        let directory = TempDir::new().expect("temporary application data");
        let workspace_path = directory.path().join("workspace");
        std::fs::create_dir(&workspace_path).expect("create workspace");
        let storage =
            crate::storage::ProjectStorage::open(&directory.path().join("data"), &workspace_path)
                .expect("open project storage");
        let app = unattended_app();
        app.manage(crate::storage::StorageSlot::new(Ok(storage)));

        let workspace = crate::active_workspace(app.handle()).expect("the task worktree");
        let stamp = workspace
            .write("hud.gd", "extends Node\n", None)
            .expect("write the script");
        crate::read_ledger::remember(workspace.root(), "hud.gd", &stamp.hash);

        // A real change on disk is not a vanished file, and its record has to survive: re-reading
        // is what fixes that one, and forgetting would silently license an overwrite.
        workspace
            .write("hud.gd", "extends Node2D\n", Some(&stamp.hash))
            .expect("someone edits the script");
        let changed = ToolFailure::from(
            workspace
                .write("hud.gd", "extends Control\n", Some(&stamp.hash))
                .expect_err("a stale record is refused"),
        );
        forget_a_vanished_file(app.handle(), "hud.gd", &changed);
        assert_eq!(
            crate::read_ledger::recall(workspace.root(), "hud.gd").as_deref(),
            Some(stamp.hash.as_str()),
            "a file that merely changed keeps its record"
        );

        std::fs::remove_file(workspace_path.join("hud.gd")).expect("the file goes away outside us");
        let gone = ToolFailure::from(
            workspace
                .write("hud.gd", "extends Control\n", Some(&stamp.hash))
                .expect_err("there is nothing there to match"),
        );
        assert!(
            gone.message.contains("Save it again to create the file"),
            "the refusal has to name the call that works: {}",
            gone.message
        );
        forget_a_vanished_file(app.handle(), "hud.gd", &gone);
        assert!(
            crate::read_ledger::recall(workspace.root(), "hud.gd").is_none(),
            "a record for a file that is gone is a claim about nothing"
        );

        // Which is the whole point: the next save carries no record and creates the file.
        let params = with_remembered_hash(app.handle(), json!({"path": "hud.gd"}));
        assert!(
            params.get("expectedHash").is_none(),
            "the router must attach nothing once the record is dropped: {params}"
        );
        workspace
            .write("hud.gd", "extends Control\n", None)
            .expect("saving again creates the file");
    }

    #[test]
    fn every_catalog_domain_has_a_route_and_unique_operations() {
        for domain in CATALOG {
            assert!(
                !domain.operations.is_empty(),
                "{} must expose at least one operation",
                domain.name
            );
            let mut seen = std::collections::HashSet::new();
            for operation in domain.operations {
                assert!(
                    seen.insert(operation.op),
                    "{} repeats the {} operation",
                    domain.name,
                    operation.op
                );
            }
        }
        let names: std::collections::HashSet<&str> =
            CATALOG.iter().map(|domain| domain.name).collect();
        assert_eq!(names.len(), CATALOG.len(), "tool names must be unique");
    }

    /// Whether prose is naming a parameter rather than using an English word that happens to match.
    ///
    /// Half the parameter names are ordinary words — `scene`, `path`, `node`, `name` — and every
    /// description is written in sentences about scenes and nodes. What identifies a parameter is
    /// either a name no sentence would contain (`expectedRevision`, `timeoutMs`) or backticks
    /// around it, which is how every summary that does mean the key writes it.
    fn names_the_parameter(prose: &str, name: &str) -> bool {
        prose.contains(&format!("`{name}`"))
            || (name.chars().any(char::is_uppercase) && prose.contains(name))
    }

    /// A hidden parameter is one the router fills in and a call never carries. Prose that names one
    /// is telling the model to write the single key it must not write.
    ///
    /// Both scene domains did, for long enough to be measured: `godot_node` said "every one of them
    /// needs expectedRevision … a mutation without it is refused, so read the tree, then mutate,
    /// then read it again for the next one", which is a round trip per mutation for a number the
    /// router already holds. The prompt has said the opposite the whole time — "supplied by the
    /// router, so never ask for it or pass it" — and a live turn, caught between them, wrote
    /// `expectedRevision` into two calls and was refused for the key it wrote around it.
    #[test]
    fn no_summary_names_a_parameter_the_router_supplies() {
        for domain in CATALOG {
            for operation in domain.operations {
                let Some(spec) = crate::tool_params::params_of(domain.name, operation.op) else {
                    continue;
                };
                for param in spec.iter().filter(|param| param.hidden) {
                    assert!(
                        !names_the_parameter(domain.description, param.name),
                        "{} names the hidden `{}` in its description",
                        domain.name,
                        param.name
                    );
                    assert!(
                        !names_the_parameter(operation.summary, param.name),
                        "{}.{} names the hidden `{}` in its summary",
                        domain.name,
                        operation.op,
                        param.name
                    );
                }
            }
        }
    }

    #[test]
    fn the_catalog_is_the_ten_agreed_domains() {
        let names: Vec<&str> = CATALOG.iter().map(|domain| domain.name).collect();
        assert_eq!(
            names,
            [
                "godot_session",
                "godot_scene",
                "godot_node",
                "godot_project",
                "godot_resource",
                "godot_script",
                "godot_debug",
                "godot_runtime",
                "godot_logs",
                "godot_docs_search",
            ]
        );
    }

    #[test]
    fn operation_names_become_serde_tags() {
        assert_eq!(to_camel_case("set_breakpoints"), "setBreakpoints");
        assert_eq!(to_camel_case("workspace_symbols"), "workspaceSymbols");
        assert_eq!(to_camel_case("hover"), "hover");
        assert_eq!(to_camel_case("await_stop"), "awaitStop");
    }

    /// One tool, two addon domains: a project setting lives in the repository and an editor setting
    /// is machine-wide, and the model is shown one `godot_project` rather than being asked to know
    /// which is which. The split used to be a hand-written match in this file; it is a row in
    /// `params.json` now, and this is the assertion that the row still says so.
    #[test]
    fn project_operations_split_project_and_machine_wide_settings() {
        let command = |op: &str| match crate::tool_params::answers("godot_project", op) {
            Some(crate::tool_params::Answers::Addon(command)) => command,
            _ => panic!("godot_project.{op} must be answered by the addon"),
        };
        assert_eq!(command("set_setting"), "project.set_setting");
        assert_eq!(command("list_autoloads"), "project.list_autoloads");
        assert_eq!(command("get_editor_setting"), "editor.get_setting");
        assert_eq!(command("search_editor_settings"), "editor.search_settings");
    }

    #[test]
    fn rpc_parameters_lift_the_revision_and_timeout_out_of_the_body() {
        let mut params =
            json!({"path": "res://main.tscn", "expectedRevision": 7, "timeoutMs": 500});
        assert_eq!(take_u64(&mut params, "expectedRevision"), Some(7));
        assert_eq!(take_u64(&mut params, "timeoutMs"), Some(500));
        assert_eq!(params, json!({"path": "res://main.tscn"}));
    }

    /*
     * An input event with no kind is refused here, with the five it could be.
     *
     * `events` had no entry contract, so an event crossed the socket unchecked and the game
     * answered `Input event kind '' is not supported` — true, and naming nothing to send instead.
     * One live turn building a playable game wrote it **twenty-two times running**, the largest
     * single loop in any recorded turn.
     */
    #[test]
    fn an_input_event_with_no_kind_is_told_what_the_kinds_are() {
        let app = unattended_app();
        let refused = dispatch_under(
            app.handle(),
            call("godot_runtime", "input", json!({"events": [{"key": "A"}]})),
            &crate::settings::GodotSettings::default(),
        )
        .expect_err("an event with no kind is refused");
        assert_eq!(refused.code, "missing_param");
        for named in [
            "key",
            "mouse_button",
            "mouse_motion",
            "joypad_button",
            "joypad_motion",
        ] {
            assert!(
                refused.message.contains(named),
                "the refusal must name {named}: {}",
                refused.message
            );
        }

        // A kind that is not one of the five is refused by the same contract rather than by the
        // game, so this never reaches an editor either.
        let wrong = dispatch_under(
            app.handle(),
            call(
                "godot_runtime",
                "input",
                json!({"events": [{"kind": "keyboard", "key": "A"}]}),
            ),
            &crate::settings::GodotSettings::default(),
        )
        .expect_err("a kind outside the five is refused");
        assert!(wrong.message.contains("mouse_motion"), "{}", wrong.message);

        // And every key the decoder reads is still accepted: a contract that refused one of these
        // would break the calls that work. Refused for having no session, which is past the shape.
        let complete = dispatch_under(
            app.handle(),
            call(
                "godot_runtime",
                "input",
                json!({"events": [
                    {"kind": "key", "key": "A", "pressed": false, "device": 16},
                    {"kind": "mouse_button", "button": "left", "position": [4, 5]},
                    {"kind": "mouse_button", "button": 3},
                    {"kind": "mouse_motion", "position": [1, 2], "relative": [3, 4]},
                    {"kind": "joypad_button", "button": 2, "pressed": true},
                    {"kind": "joypad_motion", "axis": 1, "value": -0.5},
                ]}),
            ),
            &crate::settings::GodotSettings::default(),
        )
        .expect_err("no session is active");
        assert_ne!(complete.code, "missing_param", "{}", complete.message);
        assert_ne!(complete.code, "unknown_param", "{}", complete.message);
        assert_ne!(complete.code, "invalid_param", "{}", complete.message);
    }

    /*
     * A torn edit is told about the operation that needs no anchors.
     *
     * `godot_script edit` carries the largest nested payload of any operation and is where this
     * model's JSON tears most often — `files[0] requires path` is the second commonest refusal in
     * every recorded live turn, nine across five of them. The turn that met it three times worked
     * it out itself, four calls later: "The JSON structure is getting mangled. Let me just save the
     * whole file". That sentence is now in the refusal.
     */
    #[test]
    fn a_torn_edit_is_told_about_the_call_that_needs_no_anchors() {
        let torn = the_whole_file(
            "godot_script",
            "edit",
            ToolFailure::new(
                "missing_param",
                "godot_script edit `files[0]` requires `path`.",
            ),
        );
        assert_eq!(torn.code, "missing_param");
        assert!(torn.message.contains("requires `path`"), "{}", torn.message);
        assert!(
            torn.message.contains("godot_script save"),
            "the refusal offered no way out: {}",
            torn.message
        );

        // Only a shape refusal. A file that is not there, or a hash that moved, is a fact about the
        // worktree rather than about the call, and `save` is no answer to either.
        for code in ["file_conflict", "not_found", "connect_failed"] {
            let other = the_whole_file(
                "godot_script",
                "edit",
                ToolFailure::new(code, "something else went wrong"),
            );
            assert!(
                !other.message.contains("godot_script save"),
                "{code} must not be answered with save: {}",
                other.message
            );
        }

        // And no other operation. `godot_node create` has a shape of its own and `save` is not a
        // word about it.
        let elsewhere = the_whole_file(
            "godot_node",
            "create",
            ToolFailure::new("missing_param", "godot_node create requires `parent`."),
        );
        assert!(
            !elsewhere.message.contains("godot_script save"),
            "{}",
            elsewhere.message
        );
        let other_op = the_whole_file(
            "godot_script",
            "save",
            ToolFailure::new("missing_param", "godot_script save requires `path`."),
        );
        assert!(
            !other_op.message.contains("needs no anchors"),
            "{}",
            other_op.message
        );

        // And through the router, on the shape three separate turns actually wrote: the edits in
        // place and no path anywhere. The parameter contract is checked before any domain runs, so
        // this is the only place the sentence can be attached and the only place to prove it is.
        let app = unattended_app();
        let refused = dispatch_under(
            app.handle(),
            call(
                "godot_script",
                "edit",
                json!({"files": [{"edits": [{"oldText": "a", "newText": "b"}]}]}),
            ),
            &crate::settings::GodotSettings::default(),
        )
        .expect_err("an entry with no path is refused");
        assert_eq!(refused.code, "missing_param");
        assert!(
            refused.message.contains("This one carries edits."),
            "{}",
            refused.message
        );
        assert!(
            refused.message.contains("godot_script save"),
            "{}",
            refused.message
        );
    }

    #[test]
    fn tagged_parameters_refuse_anything_but_an_object() {
        let failure = from_tagged_params::<DebugRequest>("status", json!("nope"))
            .expect_err("a string is not a parameter object");
        assert_eq!(failure.code, "invalid_params");
    }

    /// Serializes the tests that share the one session log buffer.
    ///
    /// A poisoned lock is taken anyway. The buffer is seeded from scratch by every test that holds
    /// this, so there is no state a panicking test could have left half-written — and refusing the
    /// lock would turn one honest assertion failure into three tests reporting `PoisonError`
    /// instead of what they actually found.
    fn session_test_lock() -> std::sync::MutexGuard<'static, ()> {
        godot_session::SESSION_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Seeds the session log buffer with the output one editor produced, and nothing else.
    fn given_the_session_printed(lines: &[(godot_session::LogSource, &str)]) {
        godot_session::clear_logs();
        for (source, line) in lines {
            godot_session::append_log(*source, &format!("{line}\n"));
        }
    }

    /// The failure the addon answers a runtime call with, before this module has touched it.
    fn addon_failure(code: &str, message: &str) -> ToolFailure {
        ToolFailure {
            code: code.to_owned(),
            message: message.to_owned(),
            retryable: true,
            details: json!({}),
        }
    }

    /*
     * A game whose helper is not in the project is told so, rather than told to wait.
     *
     * `runtime_slow_start` was written for a helper that is late, and it says the right thing to a
     * caller whose game is still starting: read `get_state`, do not stop it. A helper that is not
     * installed reads the same and never resolves — `get_state` answers
     * `running: true, runtimeReady: false` for ever, `wait` answers `runtime_not_running` about a
     * game that is plainly running, and the advice is to keep asking. A live turn spent seventeen
     * calls in that loop and produced nothing.
     *
     * The session output cannot explain it, because there is no error: the game boots and runs
     * perfectly, with nothing inside it that can answer.
     */
    #[test]
    fn a_game_with_no_runtime_helper_is_told_that_and_not_to_wait() {
        let _test = session_test_lock();
        given_the_session_printed(&[(godot_session::LogSource::Editor, "GOFER_ADDON_READY:2")]);
        let worktree = tempfile::TempDir::new().expect("temporary worktree");
        std::fs::write(
            worktree.path().join(crate::addon::PROJECT_FILE),
            "config_version=5\n\n[application]\n\nconfig/name=\"Fixture\"\n",
        )
        .expect("a project with no autoload section");
        godot_session::bind(Some(std::sync::Arc::new(
            godot_session::ExternalEditor::at(0, 0, worktree.path()),
        )));

        let carried = carrying_the_error_that_ended_the_game(addon_failure(
            "runtime_slow_start",
            "The game is running and its helper has not answered yet.",
        ));

        godot_session::bind(None);
        assert_eq!(carried.code, "runtime_slow_start");
        assert!(
            carried.message.contains("GoferRuntime"),
            "the failure named nothing to fix: {}",
            carried.message
        );
        assert!(
            carried.message.contains("godot_session start"),
            "the failure offered no way out: {}",
            carried.message
        );
    }

    /*
     * And a staged project keeps the failure it already had.
     *
     * The sentence above is a diagnosis, so it must not be attached to a game whose helper is
     * simply late — which is every ordinary `runtime_slow_start` and the reason that code exists.
     */
    #[test]
    fn a_staged_project_is_not_accused_of_losing_its_helper() {
        let _test = session_test_lock();
        given_the_session_printed(&[(godot_session::LogSource::Editor, "GOFER_ADDON_READY:2")]);
        let worktree = tempfile::TempDir::new().expect("temporary worktree");
        std::fs::write(
            worktree.path().join(crate::addon::PROJECT_FILE),
            format!(
                "config_version=5\n\n[autoload]\n\n{}=\"{}\"\n",
                crate::addon::AUTOLOAD_NAME,
                crate::addon::AUTOLOAD_TARGET
            ),
        )
        .expect("a staged project");
        godot_session::bind(Some(std::sync::Arc::new(
            godot_session::ExternalEditor::at(0, 0, worktree.path()),
        )));

        let carried = carrying_the_error_that_ended_the_game(addon_failure(
            "runtime_slow_start",
            "The game is running and its helper has not answered yet.",
        ));

        godot_session::bind(None);
        assert!(
            !carried.message.contains("GoferRuntime"),
            "a staged project was accused of losing its helper: {}",
            carried.message
        );
    }

    /**
     * A crashed game reaches the model with the error that crashed it.
     *
     * Observed in a live run against a blank project: the game stopped on a parse error, the model
     * was told to "read the error in the session output", and the next `godot_runtime run` answered
     * "The game stopped before it could answer". Two failures, no cause, while both lines that
     * explained it sat in the buffer this reads.
     */
    #[test]
    fn a_dead_game_answers_with_the_error_that_killed_it() {
        let _test = session_test_lock();
        given_the_session_printed(&[
            (godot_session::LogSource::Editor, "GOFER_ADDON_READY:2"),
            (
                godot_session::LogSource::EditorError,
                "SCRIPT ERROR: Parse Error: Expected expression after \"else\".",
            ),
            (
                godot_session::LogSource::EditorError,
                "ERROR: Failed to load script \"res://scripts/generate_assets.gd\" with error \
                 \"Parse error\".",
            ),
        ]);

        let carried = carrying_the_error_that_ended_the_game(addon_failure(
            "runtime_not_running",
            "The game stopped before it could answer",
        ));

        // The code is the addon's and stays the addon's; only what the model can act on is added.
        assert_eq!(carried.code, "runtime_not_running");
        assert!(
            carried
                .message
                .contains("The game stopped before it could answer"),
            "the failure lost what it already said: {}",
            carried.message
        );
        assert!(
            carried
                .message
                .contains("Parse Error: Expected expression after \"else\""),
            "the failure named no cause: {}",
            carried.message
        );
        assert!(
            carried.message.contains("scripts/generate_assets.gd"),
            "the failure named no file to go and fix: {}",
            carried.message
        );
    }

    /// When the editor itself dies, the failure says so instead of describing a game.
    ///
    /// Godot 4.7.2 segfaults on being asked to play a project whose script will not parse. Watched
    /// three times in one night, and what reached the model was `session_closed: The RPC session
    /// closed` — true, and no help at all: two of those three runs spent their whole budget
    /// retrying a call that could never work.
    ///
    /// The crash line arrives on the editor's stderr and is not classified as an error, which is
    /// why the reader that carries error lines never saw it and why this one reads without a floor.
    #[test]
    fn an_editor_that_crashed_is_named_as_the_thing_that_broke() {
        let _guard = session_test_lock();
        given_the_session_printed(&[
            (
                godot_session::LogSource::EditorError,
                "SCRIPT ERROR: Parse Error: Function \"add_child_node()\" not found in base self.",
            ),
            (
                godot_session::LogSource::EditorError,
                "handle_crash: Program crashed with signal 11",
            ),
        ]);

        let carried = carrying_the_error_that_ended_the_game(addon_failure(
            "session_closed",
            "The RPC session closed",
        ));

        assert_eq!(carried.code, "session_closed");
        assert!(
            carried.message.contains("The RPC session closed"),
            "the failure lost what it already said: {}",
            carried.message
        );
        assert!(
            carried.message.contains("Program crashed with signal 11"),
            "the crash has to be in it: {}",
            carried.message
        );
        assert!(
            carried.message.contains("godot_session start"),
            "and the one thing worth doing about it: {}",
            carried.message
        );
        assert!(
            carried.message.contains("retrying it will not help"),
            "a crash is not something to retry: {}",
            carried.message
        );
    }

    /// The `read the error in the session output` pointer is replaced by the error itself.
    #[test]
    fn a_broken_game_stops_pointing_at_a_side_channel() {
        let _test = session_test_lock();
        given_the_session_printed(&[(
            godot_session::LogSource::EditorError,
            "SCRIPT ERROR: Invalid access to property or key 'velocity' on a base object of type \
             'Node2D'.",
        )]);

        let carried = carrying_the_error_that_ended_the_game(addon_failure(
            "runtime_broke",
            "The game stopped at an error while starting and is paused in the debugger; read the \
             error in the session output, fix it, and run again",
        ));

        assert!(
            carried
                .message
                .contains("Invalid access to property or key 'velocity'"),
            "the failure named no cause: {}",
            carried.message
        );
    }

    /// A buffer with nothing wrong in it leaves the failure exactly as the addon wrote it.
    #[test]
    fn a_runtime_failure_with_no_error_to_carry_is_left_alone() {
        let _test = session_test_lock();
        given_the_session_printed(&[(
            godot_session::LogSource::Editor,
            "Godot Engine v4.7.2.stable",
        )]);

        let carried = carrying_the_error_that_ended_the_game(addon_failure(
            "runtime_timeout",
            "The game did not answer in time",
        ));

        assert_eq!(carried.message, "The game did not answer in time");
    }

    /// A fault in the request is not a fault in the game, and gains nothing from the game's output.
    #[test]
    fn a_request_the_game_refused_carries_no_session_output() {
        let _test = session_test_lock();
        given_the_session_printed(&[(
            godot_session::LogSource::EditorError,
            "SCRIPT ERROR: something unrelated went wrong earlier",
        )]);

        let carried = carrying_the_error_that_ended_the_game(addon_failure(
            "unsupported_value",
            "A value must be a tagged object with a type and a value",
        ));

        assert_eq!(
            carried.message,
            "A value must be a tagged object with a type and a value"
        );
    }
}

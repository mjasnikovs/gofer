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
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolDomain {
    pub name: &'static str,
    pub description: &'static str,
    pub operations: &'static [ToolOperation],
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
                "Asks the addon for readiness, the open scene, and its revision.",
            ),
            operation(
                "undo",
                "Undoes the last editor operation: {expectedRevision}.",
            ),
            operation(
                "redo",
                "Redoes the last undone editor operation: {expectedRevision}.",
            ),
        ],
    },
    ToolDomain {
        name: "godot_scene",
        description: "The edited scene in the editor — never the running game's scene tree. The \
                      mutations here need expectedRevision like the node ones do, and the revision \
                      is whatever the last get_tree — or godot_session get_state — reported, so \
                      start with one of those rather than guessing.",
        operations: &[
            operation("list", "Lists the scene files in the project."),
            operation("open", "Opens a scene: {path}."),
            operation(
                "create",
                "Creates a scene and opens it: {path, rootType, rootName?, expectedRevision}. The \
                 revision is the one the scene being *replaced* is at — creating a scene discards \
                 whatever is unsaved in the open one, which is what the revision is guarding — so \
                 read godot_scene get_tree first even though the new scene does not exist yet.",
            ),
            operation(
                "get_tree",
                "Returns the edited scene hierarchy and its revision. Read this before every \
                 mutation: its `revision` is the `expectedRevision` the mutation needs.",
            ),
            operation("save", "Saves the edited scene: {expectedRevision}."),
            operation(
                "save_as",
                "Saves the edited scene to a new path: {path, expectedRevision}.",
            ),
            operation(
                "reload",
                "Reloads the edited scene from disk, discarding in-memory edits: \
                 {expectedRevision}.",
            ),
        ],
    },
    ToolDomain {
        name: "godot_node",
        description: "Node authoring inside the edited scene. Every mutation is undoable and every \
                      one of them needs expectedRevision — the `revision` the last godot_scene \
                      get_tree reported. A mutation without it is refused, so read the tree, then \
                      mutate, then read it again for the next one. Paths are the scene's own, like \
                      /Level1 or /Level1/Ground.",
        operations: &[
            operation(
                "inspect",
                "Inspects a node: {node}. Answers with its type, every property with its current \
                 value, its groups, every signal it can emit, and the connections it already has. \
                 Read a property here before setting it rather than guessing what it holds; \
                 `stored` is false for properties the scene recomputes, like a Control's position \
                 and size and every theme_override_*, and those are set the same way as any other.",
            ),
            operation(
                "create",
                "Creates a node: {parent, type, name, index?, expectedRevision}. `parent` is the \
                 parent's path — the root's own path, like /Level1, for a direct child.",
            ),
            operation(
                "instantiate",
                "Places an instance of a saved scene under a node: {parent, path, name?, index?, \
                 expectedRevision}. This is how a level repeats a thing — build the coin once as \
                 its own scene, then instantiate it wherever a coin goes, and one edit reaches \
                 every placement. `node.create` cannot do this: it only builds engine classes.",
            ),
            operation(
                "duplicate",
                "Duplicates a node: {node, name?, expectedRevision}.",
            ),
            operation("rename", "Renames a node: {node, name, expectedRevision}."),
            operation(
                "reparent",
                "Reparents a node: {node, newParent, index?, expectedRevision}.",
            ),
            operation("delete", "Deletes a node: {node, expectedRevision}."),
            operation(
                "set_property",
                "Sets a property: {node, property, value, expectedRevision}. `value` is tagged \
                 with its type, as {type, value}: {\"type\": \"vector2\", \"value\": [12, 34]}, \
                 {\"type\": \"float\", \"value\": 1.5}, {\"type\": \"string\", \"value\": \"hi\"}. \
                 A property that holds a resource — a CollisionShape2D's `shape`, a Sprite2D's \
                 `texture` — takes {\"type\": \"resource\", \"value\": {\"path\": \"res://…\"}}, \
                 never a string: a path written as a string is refused. The other tags are null, \
                 bool, int, color and rect2 (four numbers each), vector2i/3/3i/4/4i, quaternion, \
                 plane, transform2d, basis, transform3d, array (of tagged values) and dictionary \
                 (of {key, value} pairs of them).",
            ),
            operation(
                "add_to_group",
                "Puts a node in a group the saved scene keeps: {node, group, expectedRevision}. \
                 Groups are how a running game finds every coin or enemy at once, with \
                 get_tree().get_nodes_in_group(\"…\").",
            ),
            operation(
                "remove_from_group",
                "Takes a node out of a group: {node, group, expectedRevision}.",
            ),
            operation(
                "connect_signal",
                "Connects a node's signal to a method, as an editor connection the scene keeps: \
                 {node, signal, method, target?, binds?, deferred?, oneShot?, expectedRevision}. \
                 `target` is the node carrying the method and defaults to the scene root; the \
                 method has to exist there already, so write the script first. `binds` are extra \
                 tagged values passed after the signal's own arguments. This is how a scene wires \
                 itself up without a `connect` call in _ready.",
            ),
            operation(
                "disconnect_signal",
                "Removes a connection: {node, signal, method, target?, binds?, expectedRevision}.",
            ),
            operation(
                "set_cells",
                "Paints tiles onto a TileMapLayer: {node, cells, expectedRevision}. This is how a \
                 2D level is built — one TileMapLayer carrying a tileset, rather than a node per \
                 block. Each entry is {x, y, width?, height?, atlas, source?}: `x`/`y` are cell \
                 coordinates, not pixels, `width`/`height` default to 1 so a rectangle is one \
                 entry — a whole ground row is {\"x\": 0, \"y\": 12, \"width\": 200, \"height\": 2, \
                 \"atlas\": [0, 0]} — and `atlas` is the [column, row] of the tile in the tileset, \
                 which resource.describe_tileset lists. An entry with no `atlas` erases the cells \
                 it covers. The node needs its `tile_set` property set first, with \
                 node.set_property and a resource value.",
            ),
            operation(
                "get_cells",
                "Reads back what a TileMapLayer holds: {node, limit?}. Answers with how many cells \
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
                "Searches project settings: {query, limit?}.",
            ),
            operation("get_setting", "Reads one project setting: {name}."),
            operation("set_setting", "Writes one project setting: {name, value}."),
            operation(
                "reset_setting",
                "Resets a project setting to its default: {name}.",
            ),
            operation("list_autoloads", "Lists the configured autoloads."),
            operation(
                "set_autoload",
                "Adds or updates an autoload: {name, path, enabled?}.",
            ),
            operation("remove_autoload", "Removes an autoload: {name}."),
            operation("list_input_actions", "Lists the Input Map actions."),
            operation(
                "set_input_action",
                "Writes an input action: {name, events, deadzone?}. `name` is the action's own \
                 name, like move_left, never a settings path. Each event names its kind and its \
                 key, as {\"kind\": \"key\", \"key\": \"A\"} — the same shape list_input_actions \
                 answers with. The other kinds are mouse_button and joypad_button, each taking a \
                 `button` index.",
            ),
            operation(
                "remove_input_action",
                "Removes a project input action: {name}.",
            ),
            operation(
                "reset_input_action",
                "Drops the override of a built-in action: {name}.",
            ),
            operation("list_plugins", "Lists the project's editor plugins."),
            operation(
                "set_plugin_enabled",
                "Enables or disables a plugin: {plugin, enabled}.",
            ),
            operation(
                "search_editor_settings",
                "Searches machine-wide editor settings: {query, limit?}.",
            ),
            operation(
                "get_editor_setting",
                "Reads one machine-wide editor setting: {name}.",
            ),
            operation(
                "set_editor_setting",
                "Writes one machine-wide editor setting: {name, value}.",
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
                "Lists every file in the task worktree with its size: {hashes?}. `hashes: true` \
                 adds a content hash per file — the token `delete` takes as `expectedHash` — and \
                 reads every file to do it, so ask for it when you are about to delete something \
                 rather than to look around.",
            ),
            operation(
                "rescan",
                "Tells the editor filesystem about one changed file: {path}.",
            ),
            operation(
                "create_tileset",
                "Cuts a texture into a TileSet and saves it: {path, texture, tileSize?, tiles?, \
                 solid?}. `path` is the .tres to write, `texture` an image the project already \
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
                "Saves a 2D collision shape as a resource: {path, shapeType, size?, radius?, \
                 height?, points?}. `path` is the .tres to write. `shapeType` is one of \
                 RectangleShape2D (size as [width, height]), CircleShape2D (radius), \
                 CapsuleShape2D (radius and height), SegmentShape2D (points as [ax, ay, bx, by]), \
                 or WorldBoundaryShape2D (nothing). Set the node's `shape` property to the path \
                 afterwards — a CollisionShape2D without one collides with nothing, and a shape \
                 can only be assigned from a file that already exists.",
            ),
            operation(
                "describe_tileset",
                "Reports what a saved TileSet holds: {path}. Answers with its tile size, its \
                 sources, and every tile they define with whether it is solid — which is where the \
                 [column, row] pairs godot_node set_cells takes come from.",
            ),
            operation(
                "move",
                "Moves a file or directory inside the worktree: {from, to}.",
            ),
            operation(
                "delete",
                "Deletes a file or directory: {path, expectedHash?}. `expectedHash` is the hash \
                 string reported for that same file by a godot_script open or save, or by \
                 `list` with `hashes: true` for anything that is not a script, and it refuses the \
                 delete if the file changed since. Those are the only two ways to obtain one, so \
                 omit it unless you are holding one — a made-up value is refused.",
            ),
        ],
    },
    ToolDomain {
        name: "godot_script",
        description: "GDScript editing and intelligence through Godot's language server. Positions \
                      are {line, character}, zero-based. Open a script before querying it — and \
                      write GDScript here rather than with the file tools, because saving here is \
                      what tells the server, and `diagnostics` on the same path is then what says \
                      whether it parses. A script that does not parse stops the scene using it from \
                      loading. Paths may be named either way, `scripts/mario.gd` or \
                      res://scripts/mario.gd.",
        operations: &[
            operation(
                "open",
                "Opens a script as a language-server document: {path}.",
            ),
            operation(
                "update",
                "Reports an in-memory buffer change: {path, text}.",
            ),
            operation(
                "save",
                "Writes the buffer and notifies the server: {path, text, expectedHash?}.",
            ),
            operation("close", "Closes the document: {path}."),
            operation(
                "format",
                "Formats source through the pinned gdformat sidecar: {source}.",
            ),
            operation("hover", "Hover documentation: {path, position}."),
            operation("completion", "Completion items: {path, position}."),
            operation("signature_help", "Signature help: {path, position}."),
            operation("definition", "Go to definition: {path, position}."),
            operation("declaration", "Go to declaration: {path, position}."),
            operation(
                "references",
                "Find references: {path, position, includeDeclaration?}.",
            ),
            operation("highlights", "Document highlights: {path, position}."),
            operation(
                "diagnostics",
                "Diagnostics the server published for a file: {path, timeoutMs?}. Answers \
                 `published: false` when the server has not said anything about that file yet, \
                 which is not the same as the file being clean — ask again rather than take an \
                 empty list for an answer. An empty list with `published: true` is a file that \
                 parses.",
            ),
            operation("document_symbols", "Symbols of one document: {path}."),
            operation("workspace_symbols", "Symbols across the worktree: {query}."),
            operation(
                "prepare_rename",
                "Checks whether a symbol can be renamed: {path, position}.",
            ),
            operation(
                "rename",
                "Plans a rename without writing: {path, position, newName}.",
            ),
            operation(
                "apply_rename",
                "Applies a planned rename in one transaction: {files}.",
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
            operation(
                "set_breakpoints",
                "Replaces the breakpoints of one script: {path, lines}.",
            ),
            operation(
                "breakpoint_locations",
                "Validates candidate lines: {path, line}.",
            ),
            operation(
                "launch",
                "Runs the project: {playArgs?, breakpoints?: [{path, lines}]}.",
            ),
            operation(
                "attach",
                "Attaches to a game already running under this adapter.",
            ),
            operation(
                "await_stop",
                "Waits for the next stop: {timeoutMs?}. Null means it ended.",
            ),
            operation("threads", "Lists the debuggable threads."),
            operation("stack_trace", "Returns the stopped stack."),
            operation(
                "scopes",
                "Returns Locals, Members, and Globals of a frame: {frameId}.",
            ),
            operation(
                "variables",
                "Expands a scope or object: {variablesReference}.",
            ),
            operation(
                "evaluate",
                "Evaluates an expression in a frame: {expression, frameId?}.",
            ),
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
            operation("disconnect", "Detaches: {terminateDebuggee?}."),
        ],
    },
    ToolDomain {
        name: "godot_runtime",
        description: "The running game: its live scene tree, input, performance, and screenshots. \
                      Distinct from the edited scene.",
        operations: &[
            operation("run", "Runs the project and captures the first frame."),
            operation("stop", "Stops the running game."),
            operation("restart", "Restarts the running game."),
            operation(
                "get_state",
                "Reports whether a game is running and its helper is ready.",
            ),
            operation("get_tree", "Returns the running game's scene tree."),
            operation("inspect_node", "Inspects a running node: {path}."),
            operation(
                "input",
                "Injects input and captures the result: {events}. Each event names its kind and \
                 its key, as {\"kind\": \"key\", \"key\": \"A\", \"pressed\": true} — send the \
                 release as a second event, or the key stays down. This drives the Input Map, so \
                 it is how you check that a level you built can actually be played.",
            ),
            operation(
                "capture",
                "Captures a PNG frame: {source?: \"game\" | \"editor\"}.",
            ),
            operation("get_monitors", "Reads the engine performance monitors."),
        ],
    },
    ToolDomain {
        name: "godot_logs",
        description: "The session's captured output — editor, importer, plugin, and the game the \
                      editor launched — with a cursor and severity filtering.",
        operations: &[operation(
            "read",
            "Reads a page: {after?, minSeverity?: \"info\"|\"warning\"|\"error\", source?, contains?, limit?}.",
        )],
    },
    ToolDomain {
        name: "godot_docs_search",
        description: "Godot documentation retrieval. Passages cite a chapter, never a URL.",
        operations: &[operation(
            "search",
            "Retrieves ranked passages: {question, maxPassages?, maxTextChars?}.",
        )],
    },
];

/// Answers one tool call by routing it to the handler the renderer uses for the same operation.
pub fn dispatch<R: Runtime>(
    app: &AppHandle<R>,
    request: ToolRequest,
) -> Result<Value, ToolFailure> {
    // The agent dispatches its calls in parallel, so a stopped turn usually leaves several queued
    // behind the one that was running. None of them has an agent left to answer.
    if crate::cancel::is_cancelled() {
        return Err(ToolFailure::new(
            "cancelled",
            "The turn was stopped before this tool call ran",
        ));
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
    let op = request
        .params
        .get("op")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            ToolFailure::new(
                "missing_op",
                format!("{} requires an 'op' naming the operation", domain.name),
            )
        })?
        .to_owned();
    if !domain.operations.iter().any(|entry| entry.op == op) {
        return Err(ToolFailure::new(
            "unknown_operation",
            format!("{} has no '{op}' operation", domain.name),
        ));
    }
    let params = request
        .params
        .get("params")
        .cloned()
        .unwrap_or_else(|| json!({}));
    if !params.is_object() {
        return Err(ToolFailure::new(
            "invalid_params",
            format!("{}.{op} takes an object of parameters", domain.name),
        ));
    }

    // The safety model sits between validation and the operation. A call the router would refuse
    // anyway is never worth a prompt, and a path outside the worktree is rejected here rather than
    // offered for approval, so no dialog can ever propose writing outside the task's own tree.
    if approvals::gate_reason(domain.name, &op).is_some() {
        reject_outside_paths(app, &params)?;
    }
    approvals::require(app, domain.name, &op, &params)?;

    match domain.name {
        "godot_session" => session_domain(app, &op, params),
        "godot_scene" => Ok(rpc(app, &format!("scene.{op}"), params)?),
        "godot_node" => Ok(rpc(app, &format!("node.{op}"), params)?),
        "godot_project" => Ok(rpc(app, &project_command(&op), params)?),
        "godot_resource" => resource_domain(app, &op, params),
        "godot_script" => script_domain(app, &op, params),
        "godot_debug" => debug_domain(&op, params),
        "godot_runtime" => Ok(rpc(app, &format!("runtime.{op}"), params)?),
        "godot_logs" => logs_domain(params),
        "godot_docs_search" => docs_domain(params),
        // Every catalog entry is handled above; a new domain without a route is a build-time
        // oversight, not something a caller can reach.
        other => Err(ToolFailure::new(
            "unrouted_tool",
            format!("The {other} tool has no route"),
        )),
    }
}

fn session_domain<R: Runtime>(
    app: &AppHandle<R>,
    op: &str,
    params: Value,
) -> Result<Value, ToolFailure> {
    match op {
        "status" => Ok(json!({"session": godot_session_api::get_session(app)?})),
        "start" => Ok(json!({
            "session": godot_session_api::start_session(app, StartGodotSessionRequest {})?
        })),
        "stop" => {
            godot_session_api::stop_session(app)?;
            Ok(json!({"stopped": true}))
        }
        _ => Ok(rpc(app, &format!("session.{op}"), params)?),
    }
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
            let files: Vec<Value> = files::scan(workspace.root())
                .into_iter()
                .map(|(path, stamp)| {
                    let hash = if with_hashes {
                        workspace.hash_of(&path).ok().flatten()
                    } else {
                        None
                    };
                    match hash {
                        Some(hash) => json!({"path": path, "bytes": stamp.bytes, "hash": hash}),
                        None => json!({"path": path, "bytes": stamp.bytes}),
                    }
                })
                .collect();
            Ok(json!({"files": files}))
        }
        // The typed destructive pair. Both reach the same `Workspace` the renderer's own
        // `move_workspace_path` and `delete_workspace_path` commands use, so canonical-path
        // validation and the hash check are the workspace's, not a second copy of them.
        "move" => {
            let request: files::MovePathRequest = from_params(params)?;
            crate::active_workspace(app)?.move_path(&request.from, &request.to)?;
            Ok(json!({"from": request.from, "to": request.to, "moved": true}))
        }
        "delete" => {
            let request: files::DeletePathRequest = from_params(params)?;
            crate::active_workspace(app)?
                .delete(&request.path, request.expected_hash.as_deref())?;
            Ok(json!({"path": request.path, "deleted": true}))
        }
        // Everything else is the editor's: the catalog is what says which operations exist, so the
        // name is forwarded rather than matched a second time here.
        _ => Ok(rpc(app, &format!("resource.{op}"), params)?),
    }
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
        worktree_relative(path);
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

fn script_domain<R: Runtime>(
    app: &AppHandle<R>,
    op: &str,
    params: Value,
) -> Result<Value, ToolFailure> {
    let params = accept_resource_paths(params);
    match op {
        "open" => {
            require_script_path(&params)?;
            // Opening a script that has not been written yet is the commonest thing an agent does
            // wrong here, because the catalog tells it to open a script before querying one. The
            // workspace's own answer — "scripts/mario.gd does not exist" — is true and leaves it
            // nowhere; every live sweep watched the same turn spent on it, followed by an `update`
            // against the document the failed open never created.
            script::open_document(from_params(params)?)
                .map(to_value)
                .map_err(|error| {
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
                })
        }
        "update" => {
            require_script_path(&params)?;
            Ok(to_value(script::update_document(from_params(params)?)?))
        }
        "save" => {
            require_script_path(&params)?;
            Ok(to_value(script::save_document(from_params(params)?)?))
        }
        "close" => {
            script::close_document(from_params(params)?)?;
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
        "apply_rename" => {
            let request: script::ApplyRenameRequest = from_params(params)?;
            Ok(json!({"files": script::apply_rename(request)?}))
        }
        _ => {
            let request: ScriptRequest = from_tagged_params(op, params)?;
            Ok(to_value(script::call(request)?))
        }
    }
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

fn docs_domain(params: Value) -> Result<Value, ToolFailure> {
    let query: rag::GodotDocsQuery = from_params(params)?;
    let response =
        rag::retrieve_query(query).map_err(|error| ToolFailure::new("docs_unavailable", error))?;
    Ok(to_value(response))
}

/// Editor settings are machine-wide and live in their own addon domain, so the three operations
/// that reach them carry an `editor_` prefix the model can see rather than hiding behind a
/// project operation name.
fn project_command(op: &str) -> String {
    match op {
        "search_editor_settings" => "editor.search_settings".to_owned(),
        "get_editor_setting" => "editor.get_setting".to_owned(),
        "set_editor_setting" => "editor.set_setting".to_owned(),
        _ => format!("project.{op}"),
    }
}

/// Sends one addon command through the same session API the renderer's `call_godot` uses.
/// `expectedRevision` and `timeoutMs` are lifted out of the parameters: every scene mutation
/// carries a revision, and the wire format keeps it beside the command rather than inside it.
fn rpc<R: Runtime>(
    app: &AppHandle<R>,
    command: &str,
    mut params: Value,
) -> Result<Value, crate::godot_rpc::RpcError> {
    let expected_revision = take_u64(&mut params, "expectedRevision");
    let timeout_ms = take_u64(&mut params, "timeoutMs");
    let response = godot_session_api::call_godot(
        app,
        CallGodotRequest {
            id: format!("ai-{command}-{}", next_call_id()),
            command: command.to_owned(),
            params,
            expected_revision,
            timeout_ms,
        },
    )?;
    let mut result = response.result;
    if let (Some(revision), Some(object)) = (response.revision, result.as_object_mut()) {
        object.insert("revision".to_owned(), json!(revision));
    }
    Ok(result)
}

fn take_u64(params: &mut Value, key: &str) -> Option<u64> {
    params
        .as_object_mut()
        .and_then(|object| object.remove(key))
        .and_then(|value| value.as_u64())
}

fn next_call_id() -> u64 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(1);
    NEXT.fetch_add(1, Ordering::Relaxed)
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

fn to_camel_case(op: &str) -> String {
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
    #[test]
    fn every_editor_operation_the_catalog_offers_has_an_addon_handler() {
        const ADDON: &str = include_str!("../addon/plugin.gd");
        for domain in CATALOG {
            let prefix = match domain.name {
                "godot_session" => "session",
                "godot_scene" => "scene",
                "godot_node" => "node",
                "godot_project" => "project",
                "godot_resource" => "resource",
                _ => continue,
            };
            for operation in domain.operations {
                // The three editor-settings operations are the addon's `editor.` domain, and
                // `project_command` is the one place that mapping lives.
                let command = if prefix == "project" {
                    project_command(operation.op)
                } else {
                    format!("{prefix}.{}", operation.op)
                };
                // `session.start`, `stop` and `status` are the desktop's own, and so are the three
                // file operations `resource_domain` answers out of the workspace itself.
                if matches!(
                    command.as_str(),
                    "session.start"
                        | "session.stop"
                        | "session.status"
                        | "resource.list"
                        | "resource.move"
                        | "resource.delete"
                ) {
                    continue;
                }
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
    }

    /// The catalog has to name an input event the way the addon reads one.
    ///
    /// It documented `{"type": "key", "keycode": "A"}` while the addon reads `kind` and `key`, so a
    /// model that believed its own tool description was answered "Input event kind '' is not
    /// supported" and had to discover the real shape by reading an action back. Nothing else keeps
    /// the sentence and the decoder together, because the sentence is prose.
    #[test]
    fn the_input_event_shape_the_catalog_documents_is_the_one_the_addon_reads() {
        const ADDON: &str = include_str!("../addon/plugin.gd");
        let summary = CATALOG
            .iter()
            .find(|domain| domain.name == "godot_project")
            .and_then(|domain| {
                domain
                    .operations
                    .iter()
                    .find(|operation| operation.op == "set_input_action")
            })
            .expect("godot_project set_input_action is in the catalog")
            .summary;
        for field in ["kind", "key"] {
            assert!(
                ADDON.contains(&format!("entry.get(\"{field}\"")),
                "the addon reads {field} from an input event"
            );
            assert!(
                summary.contains(&format!("\"{field}\"")),
                "set_input_action must document the {field} field the addon reads: {summary}"
            );
        }
        assert!(
            !summary.contains("keycode"),
            "the addon has no `keycode` field on an input event: {summary}"
        );
    }

    /// Every mutation the addon guards with a revision has to say so where the model reads it.
    ///
    /// Without this the catalog documented the parameter nowhere an operation names its arguments,
    /// and a live agent spent a whole turn being refused with `revision_conflict` on every
    /// authoring call it made. The list is the protocol's own, so an operation added to the
    /// contract cannot reach the model without its revision documented.
    #[test]
    fn mutating_operations_document_the_revision_they_require() {
        let mutating = crate::protocol_v2::MUTATING_COMMANDS.map(|command| {
            let (domain, op) = command
                .split_once('.')
                .unwrap_or_else(|| panic!("{command} names a domain and an operation"));
            (format!("godot_{domain}"), op)
        });
        for (tool, op) in &mutating {
            let tool = tool.as_str();
            let op = *op;
            let domain = CATALOG
                .iter()
                .find(|domain| domain.name == tool)
                .unwrap_or_else(|| panic!("{tool} is in the catalog"));
            let operation = domain
                .operations
                .iter()
                .find(|operation| operation.op == op)
                .unwrap_or_else(|| panic!("{tool} {op} is in the catalog"));
            assert!(
                operation.summary.contains("expectedRevision"),
                "{tool} {op} must tell the model it needs expectedRevision: {}",
                operation.summary
            );
        }
    }

    fn call(tool: &str, op: &str, params: Value) -> ToolRequest {
        ToolRequest {
            tool: tool.to_owned(),
            params: json!({"op": op, "params": params}),
        }
    }

    #[test]
    fn a_gated_operation_stops_before_its_handler_runs() {
        let app = unattended_app();

        let failure = dispatch(
            app.handle(),
            call(
                "godot_project",
                "set_editor_setting",
                json!({"setting": "interface/editor/single_window_mode", "value": true}),
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
                json!({"setting": "a", "value": 1}),
            ),
        )
        .expect_err("no session is active");
        assert_eq!(failure.code, "session_not_active");
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
    #[test]
    fn listing_reports_hashes_that_a_delete_of_a_non_script_file_can_be_held_to() {
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
        let plain = &listed["files"][0];
        assert_eq!(plain["path"], "levels/level.tscn");
        assert!(
            plain["hash"].is_null(),
            "an unasked-for hash is not read: {plain}"
        );

        let listed = dispatch(
            app.handle(),
            call("godot_resource", "list", json!({"hashes": true})),
        )
        .expect("list the worktree with hashes");
        let hashed = &listed["files"][0];
        assert_eq!(
            hashed["hash"].as_str(),
            Some(files::hash_text(scene).as_str()),
            "the listed hash must be the one the delete is checked against"
        );

        // And it is: the same token refuses the delete once the file has moved on, and lets it
        // through while the file is what was listed.
        let hash = hashed["hash"].as_str().expect("a listed hash").to_owned();
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

    #[test]
    fn project_operations_split_project_and_machine_wide_settings() {
        assert_eq!(project_command("set_setting"), "project.set_setting");
        assert_eq!(project_command("list_autoloads"), "project.list_autoloads");
        assert_eq!(project_command("get_editor_setting"), "editor.get_setting");
        assert_eq!(
            project_command("search_editor_settings"),
            "editor.search_settings"
        );
    }

    #[test]
    fn rpc_parameters_lift_the_revision_and_timeout_out_of_the_body() {
        let mut params =
            json!({"path": "res://main.tscn", "expectedRevision": 7, "timeoutMs": 500});
        assert_eq!(take_u64(&mut params, "expectedRevision"), Some(7));
        assert_eq!(take_u64(&mut params, "timeoutMs"), Some(500));
        assert_eq!(params, json!({"path": "res://main.tscn"}));
    }

    #[test]
    fn tagged_parameters_refuse_anything_but_an_object() {
        let failure = from_tagged_params::<DebugRequest>("status", json!("nope"))
            .expect_err("a string is not a parameter object");
        assert_eq!(failure.code, "invalid_params");
    }
}

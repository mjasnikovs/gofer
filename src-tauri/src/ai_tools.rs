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
        description: "The edited scene in the editor — never the running game's scene tree.",
        operations: &[
            operation("list", "Lists the scene files in the project."),
            operation("open", "Opens a scene: {path}."),
            operation(
                "create",
                "Creates a scene and opens it: {path, rootType, rootName?, expectedRevision}.",
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
            operation("inspect", "Inspects a node: {node}."),
            operation(
                "create",
                "Creates a node: {parent, type, name, index?, expectedRevision}. `parent` is the \
                 parent's path — the root's own path, like /Level1, for a direct child.",
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
                 {\"type\": \"float\", \"value\": 1.5}, {\"type\": \"string\", \"value\": \"hi\"}.",
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
                 name, like move_left, never a settings path. Each event is tagged, as \
                 {\"type\": \"key\", \"keycode\": \"A\"}.",
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
                "Lists every file in the task worktree with its size.",
            ),
            operation(
                "rescan",
                "Tells the editor filesystem about one changed file: {path}.",
            ),
            operation(
                "move",
                "Moves a file or directory inside the worktree: {from, to}.",
            ),
            operation(
                "delete",
                "Deletes a file or directory: {path, expectedHash?}.",
            ),
        ],
    },
    ToolDomain {
        name: "godot_script",
        description: "GDScript editing and intelligence through Godot's language server. Positions \
                      are {line, character}, zero-based. Open a script before querying it.",
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
                "Diagnostics the server published for a file: {path, timeoutMs?}.",
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
            operation("input", "Injects input and captures the result: {events}."),
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
        "godot_scene" => Ok(rpc(&format!("scene.{op}"), params)?),
        "godot_node" => Ok(rpc(&format!("node.{op}"), params)?),
        "godot_project" => Ok(rpc(&project_command(&op), params)?),
        "godot_resource" => resource_domain(app, &op, params),
        "godot_script" => script_domain(app, &op, params),
        "godot_debug" => debug_domain(&op, params),
        "godot_runtime" => Ok(rpc(&format!("runtime.{op}"), params)?),
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
        "status" => Ok(json!({"session": godot_session_api::get_session()?})),
        "start" => Ok(json!({
            "session": godot_session_api::start_session(app, StartGodotSessionRequest {})?
        })),
        "stop" => {
            godot_session_api::stop_session(app)?;
            Ok(json!({"stopped": true}))
        }
        _ => Ok(rpc(&format!("session.{op}"), params)?),
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
            let files: Vec<Value> = files::scan(workspace.root())
                .into_iter()
                .map(|(path, stamp)| json!({"path": path, "bytes": stamp.bytes}))
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
        _ => Ok(rpc("resource.rescan", params)?),
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

fn script_domain<R: Runtime>(
    app: &AppHandle<R>,
    op: &str,
    params: Value,
) -> Result<Value, ToolFailure> {
    match op {
        "open" => Ok(to_value(script::open_document(from_params(params)?)?)),
        "update" => Ok(to_value(script::update_document(from_params(params)?)?)),
        "save" => Ok(to_value(script::save_document(from_params(params)?)?)),
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
    let request: DebugRequest = from_tagged_params(op, params)?;
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
fn rpc(command: &str, mut params: Value) -> Result<Value, crate::godot_rpc::RpcError> {
    let expected_revision = take_u64(&mut params, "expectedRevision");
    let timeout_ms = take_u64(&mut params, "timeoutMs");
    let response = godot_session_api::call_godot(CallGodotRequest {
        id: format!("ai-{command}-{}", next_call_id()),
        command: command.to_owned(),
        params,
        expected_revision,
        timeout_ms,
    })?;
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
            .build(tauri::generate_context!())
            .expect("build mock Tauri app")
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
                // `session.start`, `stop` and `status` are the desktop's own, not the addon's.
                if matches!(
                    command.as_str(),
                    "session.start" | "session.stop" | "session.status"
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

    /// Every mutation the addon guards with a revision has to say so where the model reads it.
    ///
    /// Without this the catalog documented the parameter nowhere an operation names its arguments,
    /// and a live agent spent a whole turn being refused with `revision_conflict` on every
    /// authoring call it made.
    #[test]
    fn mutating_operations_document_the_revision_they_require() {
        let mutating = [
            ("godot_node", "create"),
            ("godot_node", "duplicate"),
            ("godot_node", "rename"),
            ("godot_node", "reparent"),
            ("godot_node", "delete"),
            ("godot_node", "set_property"),
            ("godot_scene", "create"),
            ("godot_scene", "save"),
            ("godot_scene", "save_as"),
            ("godot_scene", "reload"),
            ("godot_session", "undo"),
            ("godot_session", "redo"),
        ];
        for (tool, op) in mutating {
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
        app.manage(storage);

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

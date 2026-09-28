//! The AI tool router.
//!
//! One `godot` tool stands in front of the handlers the renderer already calls. A tool call is
//! `{tool: "godot", params: {ops: [{op: "node.create", ...}]}}`, and this module is the only place
//! that turns it into a real operation: an addon RPC command, a script-intelligence request, a
//! debug-adapter request, a page of session logs, or a documentation retrieval. The dotted `op`
//! names the domain and the operation inside it, and a domain name with a bare `op` is the same
//! call — the verify points, the acceptance suites and the recorded fixtures take that door. There
//! is no second implementation of any of them — the agent and the UI reach identical code, so a
//! scene the agent edits goes through the same undo stack, the same revision check, and the same
//! worktree binding as one the user edits.
//!
//! The catalog below is also the contract the Node worker receives at startup: the ten domains, and
//! under each of them the [`Operation`] rows [`crate::tool_params`] declares — the summary, the
//! parameters and the narrowing the model is shown. It is the same list this router dispatches
//! against, so a tool the model can call always exists here, and one it cannot call never does.
//!
//! Every call also passes [`crate::approvals`] on its way in: most operations are auto-allowed
//! because the worktree and the editor's undo stack can take them back, and the few that leave both
//! of those nets wait for the user before they reach a handler.
//!
//! What is *not* here is the arithmetic each answer needs, which was two thirds of this file and
//! none of it routing: [`crate::tool_paths`] for which parameter names a file and what to do about
//! it, [`crate::script_answers`] for a language-server answer the model can read,
//! [`crate::session_output`] for the editor's output, and [`crate::dispatch_ledger`] for what the
//! acceptance suite records. A change to how a terminal escape sequence is stripped from a Godot
//! log line used to edit the router.

use crate::approvals;
use crate::debug::{self, DebugRequest};
use crate::files;
use crate::gdformat;
use crate::godot_session;
use crate::godot_session_api::{self, CallGodotRequest, StartGodotSessionRequest};
use crate::rag;
use crate::script::{self, ScriptRequest};
use crate::script_answers::{
    a_completion_the_model_can_read, answer_names_nothing, numbered_lines, the_whole_file,
    with_the_placeholder_the_range_holds, with_where_the_cursor_was, withholds_the_text,
};
use crate::session_output::logs_domain;
use crate::tool_params::{self, Operation, Sharing};
use crate::tool_paths::{
    a_path_that_climbs_out, as_the_worktree_names_them, is_goferns_own, is_under, named_directory,
    reject_outside_paths,
};
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
    pub(crate) fn new(code: &str, message: impl Into<String>) -> Self {
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
    crate::godot_session::SessionError,
    crate::command_error::CommandError
);

/// One domain tool: a name and every operation it accepts.
///
/// The operations are [`crate::tool_params`]'s, whole: one [`Operation`] per row of
/// `protocol/schemas/v2/params.json`, carrying the prose the model reads as well as the parameters
/// that refuse the call, the route that answers it, the narrowing of an `ops` list and the gate
/// that asks the user first. What the worker receives is therefore the row rather than a merge —
/// the summary used to live here and everything else there, so the view the model is given was
/// assembled at serialization time out of two files nothing in the type system held together.
///
/// A domain used to carry a description as well — the grouping's own paragraph, ahead of its
/// operation lines. The arm that cut all ten tied on success, so the model reads the name and the
/// operations under it and nothing else.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct ToolDomain {
    pub name: &'static str,
    pub operations: &'static [Operation],
}

impl ToolDomain {
    /// The operation this domain offers under that name, or `None` for a name it does not offer.
    ///
    /// The router resolves it once, at the start of the call, and asks the row everything after
    /// that. Before, the same `(tool, op)` pair was matched against a separate table five times in
    /// one dispatch — for the check, the rule, the gate and the narrowing — and again to route it
    /// and to thread its revision.
    pub fn operation(&self, op: &str) -> Option<&'static Operation> {
        self.operations.iter().find(|offered| offered.op == op)
    }
}

/// The ten domains. A grouping rather than a tool each: the model is given one `godot` tool whose
/// dotted `op` names the domain, because a hundred flat tools fill its context with names it will
/// never call and cost a round trip apiece.
// GENERATED-BEGIN catalog sha256:dd245e1fb10f754a
pub const CATALOG: &[ToolDomain] = &[
    ToolDomain {
        name: "godot_session",
        operations: tool_params::GODOT_SESSION_OPERATIONS,
    },
    ToolDomain {
        name: "godot_scene",
        operations: tool_params::GODOT_SCENE_OPERATIONS,
    },
    ToolDomain {
        name: "godot_node",
        operations: tool_params::GODOT_NODE_OPERATIONS,
    },
    ToolDomain {
        name: "godot_project",
        operations: tool_params::GODOT_PROJECT_OPERATIONS,
    },
    ToolDomain {
        name: "godot_resource",
        operations: tool_params::GODOT_RESOURCE_OPERATIONS,
    },
    ToolDomain {
        name: "godot_script",
        operations: tool_params::GODOT_SCRIPT_OPERATIONS,
    },
    ToolDomain {
        name: "godot_debug",
        operations: tool_params::GODOT_DEBUG_OPERATIONS,
    },
    ToolDomain {
        name: "godot_runtime",
        operations: tool_params::GODOT_RUNTIME_OPERATIONS,
    },
    ToolDomain {
        name: "godot_logs",
        operations: tool_params::GODOT_LOGS_OPERATIONS,
    },
    ToolDomain {
        name: "godot_docs_search",
        operations: tool_params::GODOT_DOCS_SEARCH_OPERATIONS,
    },
];
// GENERATED-END catalog

/// Marks a tool request as a reachability probe rather than an operation.
///
/// The worker sends one per declared tool before the turn starts; the same constant is
/// `PROBE_REQUEST` in `scripts/ai-reachability.mjs`. The model cannot forge one: the tools it is
/// given take `{op, params}`, so nothing it writes reaches this level of the call.
pub(crate) const PROBE_KEY: &str = "probe";

/// Answers whether the model could really use this tool right now.
///
/// Nine domains route to the editor session, the debug adapter or the log buffer, all of which are
/// compiled into this binary and start with the session — being routed is the whole of their
/// reachability. `godot_docs_search` is the exception, and the reason this exists: it answers
/// through a sidecar script and a model cache that live outside the binary, so it can be declared
/// to the model while nothing behind it can answer, which is what ten live sweeps found.
///
/// A domain added to the catalog without a probe fails here rather than defaulting to reachable.
///
/// The one `godot` tool is every domain at once, so it is reachable only when all of them are, and
/// the first that is not is what the model is told about — by name, since `godot` is not the thing
/// that failed.
pub(crate) fn probe(domain: &str) -> Result<Value, ToolFailure> {
    if domain == GODOT_TOOL {
        for one in CATALOG {
            probe(one.name).map_err(|mut failure| {
                failure.message = format!("{}: {}", one.name, failure.message);
                failure
            })?;
        }
        return Ok(json!({"tool": domain, "reachable": true}));
    }
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
        crate::ask::ASK_USER_TOOL | crate::remember::REMEMBER_TOOL | crate::board::BOARD_TOOL => {
            Ok(json!({"tool": domain, "reachable": true}))
        }
        other => Err(ToolFailure::new(
            "unprobed_tool",
            format!(
                "The {other} tool is in the catalog with no reachability probe, so nothing proves \
                 the model can use it"
            ),
        )),
    }
}

/// Arms a save over a file the worker's own `read` tool showed the model.
fn note_a_read<R: Runtime>(app: &AppHandle<R>, params: &Value) -> Result<Value, ToolFailure> {
    let Some(path) = params.get("path").and_then(Value::as_str) else {
        return Err(ToolFailure::new(
            "invalid_params",
            "noted_read names the path the read showed",
        ));
    };
    let workspace = crate::active_workspace(app)?;
    let noted = crate::read_ledger::note_a_read(&workspace, path)?;
    Ok(json!({"noted": noted}))
}

/// Who is calling: the worker in a turn, or an agent at the door with no turn and no dialog.
///
/// An outside caller has nobody to click for it, so a call that would wait on the user is refused
/// with a code instead of hanging the door until the timeout: the approval gate and `ask_user`.
/// The board also needs a name from it, where the worker writes as itself.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Caller {
    Worker,
    Outside,
}

/// Answers one tool call by routing it to the handler the renderer uses for the same operation.
pub fn dispatch<R: Runtime>(
    app: &AppHandle<R>,
    request: ToolRequest,
) -> Result<Value, ToolFailure> {
    dispatch_as(app, request, Caller::Worker)
}

/// The same door, for an agent outside the turn.
///
/// Everything but the board is run under the provider-operation bit, the one thing a turn holds
/// for its whole length: the read ledger and the remembered revision are one slot per worktree, so
/// two agents editing at once would each be guarded by the other's last read, and a session stop
/// or a scene open from outside would land under the worker's feet. Taken rather than waited for,
/// because a turn is minutes and the caller can say so; and held for the call, so a turn cannot
/// start under a door call either. The board has a lock of its own and needs no turn.
pub fn dispatch_from_outside<R: Runtime>(
    app: &AppHandle<R>,
    request: ToolRequest,
) -> Result<Value, ToolFailure> {
    let _alone = if request.tool == crate::board::BOARD_TOOL {
        None
    } else {
        Some(
            crate::ai_turn::begin_provider_operation().map_err(|_| ToolFailure {
                retryable: true,
                ..ToolFailure::new(
                    "turn_running",
                    "Gofer's model is in a turn, and this tool shares its editor, its read ledger \
                     and its scene revision. Nothing ran. Wait for the turn to end, or stop it in \
                     Gofer, and send the call again.",
                )
            })?,
        )
    };
    dispatch_as(app, request, Caller::Outside)
}

fn dispatch_as<R: Runtime>(
    app: &AppHandle<R>,
    request: ToolRequest,
    caller: Caller,
) -> Result<Value, ToolFailure> {
    let rules = crate::settings::read_godot_settings(app).unwrap_or_default();
    dispatch_under(app, request, &rules, caller)
}

/// The router, with the user's Godot rules passed in rather than read.
///
/// Separate so the tests can state the rules they are testing. Read inside, every assertion about a
/// refusal would be an assertion about whichever `settings.json` the machine running the test
/// happens to hold — which on a developer's machine is a real one they may have edited.
///
/// It counts the list before routing, because that is the one fact every refusal below needs and
/// none of them carries: see [`said_that_none_of_it_ran`].
fn dispatch_under<R: Runtime>(
    app: &AppHandle<R>,
    request: ToolRequest,
    rules: &crate::settings::GodotSettings,
    caller: Caller,
) -> Result<Value, ToolFailure> {
    let listed = request
        .params
        .get("ops")
        .and_then(Value::as_array)
        .map_or(0, Vec::len);
    route(app, request, rules, caller).map_err(|failure| said_that_none_of_it_ran(listed, failure))
}

/// Says that a refused list left nothing behind, for a model that would otherwise assume it did.
///
/// Every refusal above `run_in_order` happens before any entry runs, and `run_in_order` itself
/// fails only when nothing in it worked — so a call answered with a bare failure applied none of
/// its operations. Nothing in the failure says so, and a live turn shows what that costs: a model
/// sent `godot_scene [create, create_nodes, set_properties, connect_signal, connect_signal, save]`,
/// was refused for `create_nodes` belonging to another tool, and wrote "The scene is created and
/// open — the node-level ops belong to `godot_node`. Continuing there:". It was not created. Four
/// calls went on discovering that.
///
/// Only a list. A call of one operation that is refused has plainly not run, and the sentence would
/// be a line of noise on every single-operation refusal in the session. A stopped turn is excluded
/// for the same reason it is excluded from the repetition guard: the caller wrote nothing wrong and
/// has no turn left to send anything again.
fn said_that_none_of_it_ran(listed: usize, failure: ToolFailure) -> ToolFailure {
    // A refusal for approval is not one a corrected entry gets past, so it keeps its own advice.
    if listed < 2
        || matches!(
            failure.code.as_str(),
            "cancelled" | "unknown_tool" | "approval_needed"
        )
    {
        return failure;
    }
    let mut failure = failure;
    let stop = if failure.message.trim_end().ends_with(['.', '!', '?']) {
        ""
    } else {
        "."
    };
    failure.message = format!(
        "{}{stop} None of the {listed} operations in this call ran. A list is refused as one, so \
         send all {listed} again with this one corrected.",
        failure.message.trim_end()
    );
    failure
}

/// The router proper: everything that answers a call, or refuses it.
fn route<R: Runtime>(
    app: &AppHandle<R>,
    request: ToolRequest,
    rules: &crate::settings::GodotSettings,
    caller: Caller,
) -> Result<Value, ToolFailure> {
    if crate::cancel::is_cancelled() {
        return Err(ToolFailure::new(
            "cancelled",
            "The turn was stopped before this tool call ran",
        ));
    }
    if request.tool == crate::ask::ASK_USER_TOOL {
        if caller == Caller::Outside {
            return Err(ToolFailure::new(
                "needs_user",
                "ask_user waits on the user in Gofer's window, and the door has no turn to ask in",
            ));
        }
        return crate::ask::ask_user(app, &request.params);
    }
    if request.tool == crate::remember::REMEMBER_TOOL {
        return crate::remember::remember(app, &request.params);
    }
    if request.tool == crate::board::BOARD_TOOL {
        return match caller {
            Caller::Worker => crate::board::board_tool(app, &request.params),
            Caller::Outside => crate::board::board_tool_from_outside(app, &request.params),
        };
    }
    if request.tool == crate::read_ledger::NOTED_READ_TOOL {
        return note_a_read(app, &request.params);
    }
    let within = CATALOG.iter().find(|domain| domain.name == request.tool);
    if within.is_none() && request.tool != GODOT_TOOL {
        return Err(ToolFailure::new(
            "unknown_tool",
            format!("There is no '{}' tool", request.tool),
        ));
    }
    if request.params.get(PROBE_KEY).and_then(Value::as_bool) == Some(true) {
        return probe(&request.tool);
    }
    let mut entries = requested_operations(&request.tool, within, &request.params)?;

    for entry in &mut entries {
        as_the_worktree_names_them(entry.operation, &mut entry.params);
    }

    for (index, entry) in entries.iter().enumerate() {
        entry
            .operation
            .check(&entry.params)
            .map_err(|failure| the_whole_file(entry.domain.name, entry.operation.op, failure))
            .map_err(|failure| entry.blamed(index, entries.len(), failure))?;

        if entry.domain.name == "godot_runtime" {
            refuse_a_second_game(entry.operation.op)
                .map_err(|failure| entry.blamed(index, entries.len(), failure))?;
        }

        if let Some(refusal) =
            crate::godot_policy::enforcement_refusal(rules, entry.operation.writes(), &entry.params)
        {
            return Err(entry.blamed(
                index,
                entries.len(),
                ToolFailure::new("policy_enforced", refusal),
            ));
        }
    }
    refuse_a_list_that_holds_a_lone_operation(&entries)?;

    let gated = gated_per_domain(app, &entries)?;
    if caller == Caller::Outside && !gated.is_empty() {
        return Err(refused_without_a_user_to_ask(&gated));
    }
    for (domain, gated) in gated {
        approvals::require(app, domain.name, &gated)?;
    }

    let step = |entry: &Requested, params: Value| {
        starting_the_session_if_there_is_none(
            entry.domain,
            params,
            |params| run_one(app, entry.domain, entry.operation, params),
            || {
                joining_a_start_in_flight(godot_session_api::start_session(
                    app,
                    StartGodotSessionRequest {},
                ))?;
                the_editor_once_it_can_answer(app).map(|_| ())
            },
        )
    };
    run_in_order(entries, step)
}

/// The refusal an outside caller gets where the worker would get a dialog. It names every gated
/// operation of the call and why, across every domain the call crossed, so the caller can ask the
/// user itself — in whatever window it has.
fn refused_without_a_user_to_ask(
    gated: &[(&'static ToolDomain, Vec<approvals::GatedCall>)],
) -> ToolFailure {
    // One clause per operation, however many entries asked for it, each entry named by what it
    // names: a batch of twenty-three deletes was answered with the same sentence twenty-three
    // times and not one path.
    let mut named: Vec<String> = Vec::new();
    for (domain, calls) in gated {
        let mut ops: Vec<&str> = Vec::new();
        for call in calls {
            if !ops.contains(&call.op.as_str()) {
                ops.push(&call.op);
            }
        }
        for op in ops {
            let same: Vec<&approvals::GatedCall> =
                calls.iter().filter(|call| call.op == op).collect();
            let reason = same.first().map_or("", |call| call.reason);
            let subjects: Vec<String> = same
                .iter()
                .filter_map(|call| what_the_call_names(&call.params))
                .collect();
            let count = same.len();
            named.push(if subjects.is_empty() {
                format!("{}.{op} ({reason})", domain.name)
            } else {
                format!(
                    "{}.{op} for {count} {}: {} ({reason})",
                    domain.name,
                    if count == 1 { "entry" } else { "entries" },
                    subjects.join(", ")
                )
            });
        }
    }
    let listed: Vec<Value> = gated
        .iter()
        .flat_map(|(domain, calls)| {
            calls.iter().map(move |call| {
                json!({"tool": domain.name, "op": call.op, "reason": call.reason, "params": call.params})
            })
        })
        .collect();
    ToolFailure {
        code: "approval_needed".to_owned(),
        message: format!(
            "{} needs the user's approval, and the door has no dialog to ask in. Nothing ran. \
             Have the user do it in Gofer, or ask them yourself and send an operation that \
             is not gated.",
            named.join("; ")
        ),
        retryable: false,
        details: json!({"gated": listed}),
    }
}

/// The one value a gated call is about, for the sentence: the path it deletes or moves, the
/// setting or plugin it changes, the button it presses.
fn what_the_call_names(params: &Value) -> Option<String> {
    ["path", "from", "name", "plugin", "button"]
        .iter()
        .find_map(|key| params.get(key).and_then(Value::as_str))
        .map(str::to_owned)
}

/// Writes a captured frame into the project and answers with where, in place of the bytes.
///
/// The bytes are for a model that can look at a picture. A terminal caller wants a file, and a
/// local model that cannot take an image wants nothing at all — eighty kilobytes of base64 in a
/// tool answer is context spent on what nothing will read.
fn the_frame_written_to<R: Runtime>(
    app: &AppHandle<R>,
    mut answer: Value,
    save_to: &str,
) -> Result<Value, ToolFailure> {
    use base64::Engine as _;
    let Some(frame) = answer.get_mut("frame").and_then(Value::as_object_mut) else {
        return Ok(answer);
    };
    let data = frame
        .get("data")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|error| {
            ToolFailure::new(
                "frame_unreadable",
                format!("The captured frame was not base64: {error}"),
            )
        })?;
    let relative = save_to.strip_prefix("res://").unwrap_or(save_to);
    let workspace = crate::active_workspace(app)?;
    let path = workspace.resolve(relative)?;
    let unwritable = |error: std::io::Error| {
        ToolFailure::new(
            "frame_unwritable",
            format!("{relative} could not be written: {error}"),
        )
    };
    if let Some(parent) = path.parent()
        && !parent.exists()
    {
        std::fs::create_dir_all(parent).map_err(unwritable)?;
        // A directory made for captures is not an asset folder: without this every frame gains
        // a .import beside it on the editor's next scan.
        std::fs::write(parent.join(".gdignore"), "").map_err(unwritable)?;
    }
    crate::files::write_atomically(&path, &bytes).map_err(unwritable)?;
    frame.remove("data");
    frame.remove("encoding");
    frame.insert("path".to_owned(), json!(relative));
    Ok(answer)
}

/// A start refused because another is in flight is a start to wait on, not a failure.
fn joining_a_start_in_flight<T>(
    started: Result<T, godot_session::SessionError>,
) -> Result<(), ToolFailure> {
    match started {
        Ok(_) => Ok(()),
        Err(error) if error.code == "session_already_starting" => Ok(()),
        Err(error) => Err(error.into()),
    }
}

/// The gated entries of a call, grouped by the domain whose name the dialog names, in list order.
///
/// One prompt per domain rather than one per call: a `godot` list may cross domains, and "Approve
/// godot_resource delete?" is a sentence about a domain rather than about the tool the model wrote.
fn gated_per_domain<R: Runtime>(
    app: &AppHandle<R>,
    entries: &[Requested],
) -> Result<Vec<(&'static ToolDomain, Vec<approvals::GatedCall>)>, ToolFailure> {
    let mut grouped: Vec<(&'static ToolDomain, Vec<approvals::GatedCall>)> = Vec::new();
    for entry in entries {
        let Some(reason) = entry.operation.gate() else {
            continue;
        };
        reject_outside_paths(app, entry.operation, &entry.params)?;
        let call = approvals::GatedCall {
            op: entry.operation.op.to_owned(),
            reason,
            params: entry.params.clone(),
        };
        match grouped
            .iter_mut()
            .find(|(domain, _)| domain.name == entry.domain.name)
        {
            Some((_, calls)) => calls.push(call),
            None => grouped.push((entry.domain, vec![call])),
        }
    }
    Ok(grouped)
}

/// One `edit` call may name scripts and shaders together; each goes the way its kind goes, and
/// the answer keeps the order the call wrote.
fn edited_scripts_and_shaders<R: Runtime>(
    app: &AppHandle<R>,
    request: script::EditScriptRequest,
) -> Result<Vec<script::EditedScript>, ToolFailure> {
    let (shaders, scripts): (Vec<_>, Vec<_>) = request
        .files
        .into_iter()
        .partition(|file| script::is_outside_the_language_server(&file.path));
    let mut answered = Vec::with_capacity(shaders.len() + scripts.len());
    if !shaders.is_empty() {
        let workspace = crate::active_workspace(app)?;
        answered.extend(script::edit_outside_the_language_server(
            &workspace,
            script::EditScriptRequest { files: shaders },
        )?);
    }
    if !scripts.is_empty() {
        answered.extend(script::edit_documents(script::EditScriptRequest {
            files: scripts,
        })?);
    }
    Ok(answered)
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
/// A start that fails still answers the code the call met. There is still no session, which is what
/// that code says and what the caller has to act on; why the start failed is the sentence after it.
///
/// The start is the same wait `godot_session start` is: a start that answered on spawn had the
/// retry meet the language server's port before it was listening, and answer `connect_failed`.
fn starting_the_session_if_there_is_none(
    domain: &ToolDomain,
    params: Value,
    mut run: impl FnMut(Value) -> Result<Value, ToolFailure>,
    start: impl FnOnce() -> Result<(), ToolFailure>,
) -> Result<Value, ToolFailure> {
    let failure = match run(params.clone()) {
        Err(failure) if IS_A_MISSING_SESSION.contains(&failure.code.as_str()) => failure,
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

/// The codes that mean there is no editor to talk to, whichever door reported it.
///
/// `session_not_active` is what a call meets when nothing has been started. `connect_failed` is what
/// it meets when a session record exists and the port behind it is not answering — an editor still
/// coming up, or one that went away without clearing the record. A live turn's first
/// `godot_script save` met the second and was told only that a port could not be reached, which is
/// not a call it can make. Both have the same next move, so both open the same door.
const IS_A_MISSING_SESSION: [&str; 2] = ["session_not_active", "connect_failed"];

/// The name of the one tool the model is given, whose every entry names its domain in its `op`.
pub(crate) const GODOT_TOOL: &str = "godot";

/// One entry of the `ops` list: the operation, and the parameters written beside it.
///
/// The operation is the catalogue's own row, resolved once as the entry is read. Everything that
/// follows — the check, the rule, the gate, the narrowing, the route — is a question asked of that
/// row rather than another lookup by the same two strings.
#[derive(Clone, Debug)]
struct Requested {
    domain: &'static ToolDomain,
    operation: &'static Operation,
    /// The op as the call spelled it: `scene.open` on a `godot` call, `open` on a domain one.
    /// Echoed back rather than normalised, so every sentence the model reads names what it wrote.
    spelled: String,
    params: Value,
}

impl Requested {
    /// The operation's name, as the call spelled it.
    fn op(&self) -> &str {
        &self.spelled
    }

    /// The operation named the way this same call could write it again.
    fn named(&self) -> String {
        if self.spelled.contains('.') {
            return self.spelled.clone();
        }
        format!("{}.{}", self.domain.name, self.spelled)
    }

    /// The same catalogue row, whichever of the two ways each entry spelled it.
    fn is_the_same_operation_as(&self, other: &Requested) -> bool {
        self.domain.name == other.domain.name && self.operation.op == other.operation.op
    }

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
        failure.message = format!("`ops[{index}]` ({}): {}", self.op(), failure.message);
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
    tool: &str,
    within: Option<&'static ToolDomain>,
    params: &Value,
) -> Result<Vec<Requested>, ToolFailure> {
    let Some(listed) = params.get("ops").and_then(Value::as_array) else {
        return Err(ToolFailure::new(
            "missing_ops",
            format!(
                "{tool} takes an `ops` list: {{\"ops\": [{{\"op\": \"…\", …}}]}}, with each \
                 operation's parameters beside its `op`. One operation is a list of one."
            ),
        ));
    };
    if listed.is_empty() {
        return Err(ToolFailure::new(
            "empty_ops",
            format!("{tool} was called with an empty `ops` list"),
        ));
    }
    listed
        .iter()
        .enumerate()
        .map(|(index, entry)| requested_operation(tool, within, index, entry))
        .collect()
}

/// Resolves one entry, inside the domain a domain call named or across the catalogue.
///
/// The two spellings are the same call: `godot_node` with `{"op": "inspect"}` and `godot` with
/// `{"op": "node.inspect"}` reach the same row, and everything after this point asks the row rather
/// than the name the call used.
fn requested_operation(
    tool: &str,
    within: Option<&'static ToolDomain>,
    index: usize,
    entry: &Value,
) -> Result<Requested, ToolFailure> {
    if !entry.is_object() {
        return Err(ToolFailure::new(
            "invalid_params",
            format!("{tool} `ops[{index}]` is not an object"),
        ));
    }
    let op = entry
        .get("op")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            ToolFailure::new(
                "missing_op",
                format!("{tool} `ops[{index}]` needs an `op` naming the operation"),
            )
        })?
        .to_owned();
    let (domain, operation) = match within {
        Some(domain) => (
            domain,
            domain.operation(&op).ok_or_else(|| {
                ToolFailure::new(
                    "unknown_operation",
                    format!("{} has no '{op}' operation", domain.name),
                )
            })?,
        ),
        None => whatever_the_dotted_name_points_at(&op).ok_or_else(|| {
            ToolFailure::new(
                "unknown_operation",
                format!("{tool} has no '{op}' operation"),
            )
        })?,
    };
    let mut params = entry.clone();
    if let Some(object) = params.as_object_mut() {
        object.remove("op");
    }
    Ok(Requested {
        domain,
        operation,
        spelled: op,
        params,
    })
}

/// The catalogue row a `<short>.<op>` name points at, where `<short>` is the domain without its
/// `godot_` prefix.
fn whatever_the_dotted_name_points_at(
    op: &str,
) -> Option<(&'static ToolDomain, &'static Operation)> {
    let (short, name) = op.split_once('.')?;
    let domain = CATALOG
        .iter()
        .find(|domain| domain.name.strip_prefix("godot_") == Some(short))?;
    Some((domain, domain.operation(name)?))
}

/// Refuses a list that asks an operation to share more of itself than it can.
///
/// Two refusals, because one sentence cannot be true of both. An `Exclusive` operation cannot share
/// a call at all: it is the debugger, where the answer to one operation decides what the next one
/// means. A `Repeat` operation may sit beside anything and may not appear twice in a row — it takes no
/// parameters to vary, or it drives what the session owns exactly one of, and `run_in_order` walks
/// the list, so the second entry either answers the first one's question again or acts on what it
/// left behind.
///
/// The reason `Repeat` is separate is what a live project measured. Ten calls across ten of sixteen
/// tasks were refused for holding a lone operation, and not one of them repeated it: they were
/// `[open, get_tree]`, `[capture, get_state]`, `[status, threads, stack_trace]` — ordinary two-step
/// requests the router was already able to run. The old rule refused a list holding any lone
/// operation, and told the model "a second one is the first one again" about two different ones.
fn refuse_a_list_that_holds_a_lone_operation(entries: &[Requested]) -> Result<(), ToolFailure> {
    if entries.len() < 2 {
        return Ok(());
    }
    for (index, entry) in entries.iter().enumerate() {
        let Some((scope, reason)) = entry.operation.sharing() else {
            continue;
        };
        match scope {
            Sharing::Exclusive => {
                return Err(ToolFailure {
                    code: "must_be_alone".to_owned(),
                    message: format!(
                        "{} has to be the only entry of its call, and `ops[{index}]` is one of \
                         {}. {reason} Send it as a list of one, and the rest as their own call.",
                        entry.named(),
                        entries.len()
                    ),
                    retryable: false,
                    details: json!({"op": entry.op(), "opIndex": index}),
                });
            }
            Sharing::Repeat => {
                // Only a repeat with nothing between counts: two live turns wrote
                // `[set_autoload, list_autoloads, remove_autoload, list_autoloads]`, a read
                // after each write, and were told the second read was the first one again.
                let again = index + 1;
                if entries
                    .get(again)
                    .is_some_and(|next| next.is_the_same_operation_as(entry))
                {
                    return Err(ToolFailure {
                        code: "op_repeated".to_owned(),
                        message: format!(
                            "{} is in this call twice in a row, at `ops[{index}]` and \
                             `ops[{again}]`. {reason} Drop the second one; the rest of the list \
                             is fine.",
                            entry.named()
                        ),
                        retryable: false,
                        details: json!({"op": entry.op(), "opIndex": again, "firstIndex": index}),
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
    entries: Vec<Requested>,
    mut step: impl FnMut(&Requested, Value) -> Result<Value, ToolFailure>,
) -> Result<Value, ToolFailure> {
    let mut answered: Vec<Value> = Vec::with_capacity(entries.len());
    let mut stopped: Option<ToolFailure> = None;
    let mut worked = false;
    let mut revision: Option<i64> = None;
    for entry in entries {
        if let Some(failure) = &stopped {
            answered.push(json!({
                "op": entry.op(),
                "skipped": "an earlier entry failed, so this was not run",
                "because": failure.code,
            }));
            continue;
        }
        let params = expecting_what_the_last_entry_produced(&entry, revision);
        match step(&entry, params) {
            Ok(answer) => {
                worked = true;
                revision = answer.get("revision").and_then(Value::as_i64).or(revision);
                answered.push(json!({"op": entry.op(), "result": answer}));
            }
            Err(failure) => {
                answered.push(json!({"op": entry.op(), "error": failure}));
                stopped = Some(failure);
            }
        }
    }
    match stopped {
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
fn expecting_what_the_last_entry_produced(entry: &Requested, revision: Option<i64>) -> Value {
    let Some(revision) = revision else {
        return entry.params.clone();
    };
    if !entry
        .operation
        .params
        .iter()
        .any(|param| param.name == "expectedRevision")
    {
        return entry.params.clone();
    }
    let mut params = entry.params.clone();
    if let Some(object) = params.as_object_mut() {
        object.insert("expectedRevision".to_owned(), json!(revision));
    }
    params
}

/// Records that this operation reached its handler, and what came back. Compiles to nothing
/// outside the suite.
#[cfg(all(test, feature = "godot-acceptance"))]
pub(crate) fn record_dispatched(
    domain: &ToolDomain,
    operation: &Operation,
    params: &Value,
    answered: &Result<Value, ToolFailure>,
    started: std::time::Instant,
) {
    crate::dispatch_ledger::record(
        domain.name,
        operation.op,
        params,
        answered,
        started.elapsed().as_millis(),
    );
}

#[cfg(not(all(test, feature = "godot-acceptance")))]
pub(crate) fn record_dispatched(
    _domain: &ToolDomain,
    _operation: &Operation,
    _params: &Value,
    _answered: &Result<Value, ToolFailure>,
    _started: std::time::Instant,
) {
}

/// One operation, routed to the handler the renderer uses for the same thing.
fn run_one<R: Runtime>(
    app: &AppHandle<R>,
    domain: &ToolDomain,
    operation: &Operation,
    params: Value,
) -> Result<Value, ToolFailure> {
    let started = std::time::Instant::now();
    #[cfg(all(test, feature = "godot-acceptance"))]
    let recorded = params.clone();
    #[cfg(not(all(test, feature = "godot-acceptance")))]
    let recorded = Value::Null;
    let answered = route_one(app, domain, operation, params);
    record_dispatched(domain, operation, &recorded, &answered, started);
    answered
}

/// The project files that still spell `res://` + `moved`, as the file itself or a directory above
/// a file. A move rewrites none of them, and a `preload` of the old path no longer compiles. An
/// `ext_resource` whose uid the moved file still carries is left out: Godot finds it by that uid.
fn files_naming(root: &std::path::Path, moved: &str, now_at: &str) -> Vec<String> {
    let old = format!(
        "res://{}",
        moved.trim_start_matches("res://").trim_end_matches('/')
    );
    let carried = uids_under(root, now_at.trim_start_matches("res://"));
    let rescued = |line: &str| {
        line.starts_with("[ext_resource") && uid_in(line).is_some_and(|uid| carried.contains(uid))
    };
    let names = |line: &str| {
        line.match_indices(&old).any(|(at, _)| {
            matches!(
                line[at + old.len()..].chars().next(),
                Some('/' | '"' | '\'')
            )
        })
    };
    files::scan(root)
        .into_keys()
        .filter(|path| !is_goferns_own(path))
        .filter(|path| {
            [
                "gd",
                "cs",
                "tscn",
                "tres",
                "godot",
                "cfg",
                "gdshader",
                "gdshaderinc",
            ]
            .contains(
                &std::path::Path::new(path)
                    .extension()
                    .and_then(|e| e.to_str())
                    .unwrap_or(""),
            )
        })
        .filter(|path| {
            std::fs::read_to_string(root.join(path))
                .is_ok_and(|text| text.lines().any(|line| names(line) && !rescued(line)))
        })
        .collect()
}

/// The first `uid="…"` a line carries.
fn uid_in(line: &str) -> Option<&str> {
    let rest = &line[line.find("uid=\"")? + "uid=\"".len()..];
    Some(&rest[..rest.find('"')?])
}

/// Every uid the files under `relative` answer to: an asset's in its `.import`, a script's in its
/// `.uid`, a scene's or resource's in its own header.
fn uids_under(root: &std::path::Path, relative: &str) -> std::collections::HashSet<String> {
    let relative = relative.trim_end_matches('/');
    let mut uids = std::collections::HashSet::new();
    for path in files::scan(root).into_keys() {
        if path != relative && !path.starts_with(&format!("{relative}/")) {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(root.join(&path)) else {
            continue;
        };
        let uid = if path.ends_with(".uid") {
            Some(text.trim())
        } else if path.ends_with(".import") || path.ends_with(".tscn") || path.ends_with(".tres") {
            text.lines().find_map(uid_in)
        } else {
            None
        };
        uids.extend(
            uid.filter(|uid| uid.starts_with("uid://"))
                .map(str::to_owned),
        );
    }
    uids
}

/// A game that halts before its first frame fails the launch, but a halt at a breakpoint the
/// caller armed is the run doing what it was asked. Only the adapter knows which it was, and its
/// stop arrives on its own socket, after the editor's answer.
fn a_launch_stopped_where_it_was_asked_to(command: &str) -> Option<Value> {
    if !matches!(command, "runtime.run" | "runtime.restart")
        || crate::game_run::now().armed().is_empty()
    {
        return None;
    }
    // The adapter's reader notes the halt; the event itself is await_stop's to take.
    (crate::game_run::halt_within(crate::godot_dap::SETTLE_TIMEOUT)
        == Some(crate::game_run::Halt::AtABreakpoint))
    .then(|| json!({"running": true, "stoppedAt": "breakpoint"}))
}

/// The routing itself, apart from the ledger that watches it.
fn route_one<R: Runtime>(
    app: &AppHandle<R>,
    domain: &ToolDomain,
    operation: &Operation,
    params: Value,
) -> Result<Value, ToolFailure> {
    let op = operation.op;
    match operation.route() {
        tool_params::Answers::Addon(command) => {
            a_path_that_climbs_out(operation, &params)?;
            if domain.name == "godot_runtime" {
                crate::session_diagnosis::a_game_the_debugger_has_halted(op)?;
            }
            let save_to = matches!(
                command,
                "runtime.capture" | "runtime.run" | "runtime.restart"
            )
            .then(|| {
                params
                    .get("saveTo")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            })
            .flatten();
            let answered: Result<Value, ToolFailure> = match save_to {
                Some(save_to) => rpc(app, command, params)
                    .map_err(Into::into)
                    .and_then(|frame| the_frame_written_to(app, frame, &save_to)),
                None => rpc(app, command, params).map_err(Into::into),
            };
            if answered.is_ok() {
                crate::project_sync::changed(crate::project_sync::Change::Answered(command));
            }
            let answered = match answered {
                Err(failure) if failure.code == "runtime_broke" && op != "stop" => {
                    a_launch_stopped_where_it_was_asked_to(command).ok_or(failure)
                }
                answered => answered,
            };
            if domain.name == "godot_runtime" {
                // The adapter's own terminated event says the same, on another socket, later.
                if answered.is_ok() && op == "stop" {
                    crate::game_run::note(crate::game_run::Transition::GameEnded);
                }
                return answered
                    .map_err(crate::session_diagnosis::carrying_the_error_that_ended_the_game);
            }
            Ok(answered?)
        }
        tool_params::Answers::Rust => {
            let root = || {
                crate::active_workspace(app)
                    .ok()
                    .map(|workspace| workspace.root().to_owned())
            };
            crate::read_ledger::through(operation, root, params, |params| match domain.name {
                "godot_session" => session_domain(app, op),
                "godot_resource" => resource_domain(app, op, params),
                "godot_script" => script_domain(app, op, params),
                "godot_debug" => debug_domain(op, params),
                "godot_logs" => logs_domain(params),
                "godot_docs_search" => docs_domain(app, op, params),
                other => Err(ToolFailure::new(
                    "unrouted_tool",
                    format!("The {other} tool has no route"),
                )),
            })
        }
    }
}

/// The three session operations the desktop answers itself: starting, stopping, and reporting the
/// supervisor's own view of the editor. Everything else in the domain is the addon's, and the
/// router sends it there without asking here.
fn session_domain<R: Runtime>(app: &AppHandle<R>, op: &str) -> Result<Value, ToolFailure> {
    match op {
        "status" => Ok(json!({"session": godot_session_api::get_session(app)?})),
        "start" => {
            godot_session_api::start_session(app, StartGodotSessionRequest {})?;
            Ok(json!({"session": the_editor_once_it_can_answer(app)?}))
        }
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

/// The session, once the editor behind it can actually take a call.
///
/// `start_session` returns as soon as the editor is spawned, and it is right to: the desktop has a
/// window watching the state change. The agent has one answer and no event stream, and what it was
/// handed was `{"state": "starting"}` reported as a success. Across every recorded run, a
/// successful `godot_session start` answered **`ready` twice, `starting` thirteen times and `error`
/// once** — and the prompt sends the model here before any other `godot_` tool.
///
/// What that cost, in one live turn: `godot_scene open` and two `godot_session get_state` refused
/// with `session_closed`, a `bash sleep 12` refused by the shell rule, and then — because nothing
/// lets a caller wait for a session — the agent wrote its own wait loop, thirty `curl` polls
/// against Gofer's own RPC port, to find out when the editor it had just been told was started
/// could answer.
///
/// So this holds the call open, the way `runtime.run` "is answered only after the game booted, its
/// helper announced itself, and the first frame was captured". Polled rather than awaited because
/// nothing here signals: `start_session_watch` emits to a window, and the tool has none.
/// What a caller is told when the editor behind a start is gone rather than slow.
fn the_editor_never_came_up() -> ToolFailure {
    ToolFailure::new(
        "session_start_failed",
        "The editor was started and stopped before it could answer. Read logs.read for what it \
         printed on the way up, then start it again."
            .to_owned(),
    )
}

fn the_editor_once_it_can_answer<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<Option<crate::godot_session_api::GodotSessionResponse>, ToolFailure> {
    let deadline = std::time::Instant::now() + SESSION_START_TIMEOUT;
    loop {
        match the_start_so_far(
            godot_session::start_in_flight,
            godot_session::current_state,
            godot_session::editor_has_exited,
        ) {
            StartSoFar::Answering => return Ok(godot_session_api::get_session(app)?),
            StartSoFar::Gone => return Err(the_editor_never_came_up()),
            StartSoFar::Coming => {}
        }
        if std::time::Instant::now() >= deadline {
            let state = godot_session::current_state();
            return Err(ToolFailure::new(
                "session_slow_start",
                format!(
                    "The editor has been {state:?} for {} seconds and has not answered yet. It is \
                     still coming up rather than gone: read session.status again rather than \
                     starting a second one.",
                    SESSION_START_TIMEOUT.as_secs()
                ),
            ));
        }
        std::thread::sleep(SESSION_START_POLL);
    }
}

/// Where a start the caller is waiting on has got to.
enum StartSoFar {
    Answering,
    Gone,
    Coming,
}

fn the_start_so_far(
    in_flight: impl Fn() -> bool,
    state: impl Fn() -> godot_session::SessionState,
    exited: impl Fn() -> bool,
) -> StartSoFar {
    // The flag first: a start clears it only after its session is visible to `state`.
    let in_flight = in_flight();
    match state() {
        godot_session::SessionState::Ready
        | godot_session::SessionState::Playing
        | godot_session::SessionState::DebugPaused => StartSoFar::Answering,
        godot_session::SessionState::Offline if !in_flight => StartSoFar::Gone,
        godot_session::SessionState::Error if exited() => StartSoFar::Gone,
        _ => StartSoFar::Coming,
    }
}

/// How long a session start may take before the caller is told it is slow rather than broken.
///
/// A cold editor imports the project and enables plugins before the addon connects. Sixty seconds
/// is `runtime.run`'s own launch budget, and a session start is the same kind of wait.
const SESSION_START_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

/// How often the state is read while waiting. Fast, because the wait is the editor's and every
/// extra tick is a caller kept waiting for nothing.
const SESSION_START_POLL: std::time::Duration = std::time::Duration::from_millis(200);

fn resource_domain<R: Runtime>(
    app: &AppHandle<R>,
    op: &str,
    params: Value,
) -> Result<Value, ToolFailure> {
    match op {
        "list" => {
            let request: files::ListPathsRequest = from_params(params)?;
            let workspace = crate::active_workspace(app)?;
            let under = request.under.as_deref().and_then(named_directory);
            let files: Vec<Value> = files::scan(workspace.root())
                .into_iter()
                .filter(|(path, _)| !is_goferns_own(path))
                .filter(|(path, _)| is_under(path, under.as_deref()))
                .map(|(path, stamp)| {
                    let hash = if request.hashes {
                        workspace.hash_of(&path).ok().flatten()
                    } else {
                        None
                    };
                    json!({"path": path, "bytes": stamp.bytes, "hash": hash})
                })
                .collect();
            Ok(json!({"files": files}))
        }
        "move" => {
            let request: files::MovePathRequest = from_params(params)?;
            let workspace = crate::active_workspace(app)?;
            let also_moved = workspace.move_path(&request.from, &request.to)?;
            // An asset imported from either end outlives the move until the editor walks.
            crate::project_sync::changed(crate::project_sync::Change::Moved);
            let still_referenced_by = files_naming(workspace.root(), &request.from, &request.to);
            Ok(json!({
                "from": request.from,
                "to": request.to,
                "moved": true,
                "alsoMoved": also_moved,
                "stillReferencedBy": still_referenced_by,
            }))
        }
        "delete" => {
            let request: files::DeletePathRequest = from_params(params)?;
            let workspace = crate::active_workspace(app)?;
            let also_removed = workspace.delete(&request.path, request.expected_hash.as_deref())?;
            crate::project_sync::changed(crate::project_sync::Change::Moved);
            Ok(json!({"path": request.path, "deleted": true, "alsoRemoved": also_removed}))
        }
        other => Err(ToolFailure::new(
            "unrouted_operation",
            format!("godot_resource.{other} has no desktop handler"),
        )),
    }
}

/// Keeps this domain to the files it is for: GDScript, and the shaders no other tool writes.
///
/// `save` writes whatever path it is given, and the language server behind it only knows GDScript.
/// A live agent used it to write a `.tscn` by hand rather than build the scene with the node tools:
/// the text landed under an editor that had its own copy of that scene open, outside the undo stack
/// and outside the revision guard, in a layout Godot's own writer would never produce. A scene is
/// the editor's to write, so it is refused with the tool that owns it; anything else is refused
/// with the reason, because the old sentence sent a shader edit to the node tools.
fn require_script_path(params: &Value) -> Result<(), ToolFailure> {
    let path = params
        .get("path")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if path.is_empty() || path.ends_with(".gd") || script::is_outside_the_language_server(path) {
        return Ok(());
    }
    let why = if path.ends_with(".tscn") || path.ends_with(".scn") {
        "Build and save a scene with the scene.* and node.* operations — a scene written as text \
         is not the scene the editor has open."
    } else if path.ends_with(".tres") || path.ends_with(".res") {
        "A resource is the editor's to write: resource.* creates the kinds it knows, and a node's \
         property takes one by path through node.set_properties."
    } else {
        "This domain writes GDScript and shaders (.gdshader, .gdshaderinc) and nothing else."
    };
    Err(ToolFailure::new(
        "unsupported_file",
        format!("The script.* operations do not write {path}. {why}"),
    ))
}

/// The scripts one call names.
///
/// `open`, `close` and `diagnostics` each take a list and answer `{"files": […]}`, one entry per
/// path in the order they were named, because an agent that could only name one at a time made one
/// call per file: nine `open` calls in a row, then a `diagnostics` call per file, each one a
/// round-trip and an answer the turn pays context for.
fn named_scripts(params: &Value) -> Result<Vec<String>, ToolFailure> {
    let entries = params
        .get("paths")
        .and_then(Value::as_array)
        .filter(|entries| !entries.is_empty())
        .ok_or_else(|| {
            ToolFailure::new(
                "invalid_params",
                "`paths` names no script to work on. It is a list of script paths: \
                 [\"scripts/player.gd\", \"scripts/enemy.gd\"].",
            )
        })?;
    let mut paths = Vec::with_capacity(entries.len());
    for entry in entries {
        let path = entry.as_str().ok_or_else(|| {
            ToolFailure::new(
                "invalid_params",
                format!(
                    "`paths` is a list of script paths, and {entry} is not one. Name them as \
                     strings: [\"scripts/player.gd\", \"scripts/enemy.gd\"]."
                ),
            )
        })?;
        require_script_path(&json!({"path": path}))?;
        paths.push(path.to_owned());
    }
    Ok(paths)
}

fn script_domain<R: Runtime>(
    app: &AppHandle<R>,
    op: &str,
    params: Value,
) -> Result<Value, ToolFailure> {
    match op {
        "list" => {
            let request: script::ListScriptsRequest = from_params(params)?;
            let workspace = crate::active_workspace(app)?;
            let under = request.under.as_deref().and_then(named_directory);
            let files: Vec<Value> = files::scan(workspace.root())
                .into_iter()
                .filter(|(path, _)| path.ends_with(".gd"))
                .filter(|(path, _)| !is_goferns_own(path))
                .filter(|(path, _)| is_under(path, under.as_deref()))
                .map(|(path, stamp)| json!({"path": path, "bytes": stamp.bytes}))
                .collect();
            Ok(json!({"files": files}))
        }
        "open" => {
            let paths = named_scripts(&params)?;
            let mut answers = Vec::with_capacity(paths.len());
            let mut spent = 0usize;
            for path in paths {
                let document = script::open_document(from_params(json!({"path": path}))?).map_err(
                    |error| {
                        if error.code == "not_found" {
                            ToolFailure::new(
                                "not_found",
                                format!(
                                    "{} There is nothing to open yet: write the script with \
                                     script.save, which creates the file, tells the language \
                                     server about it, and leaves it open.",
                                    error.message
                                ),
                            )
                        } else {
                            ToolFailure::from(error)
                        }
                    },
                )?;
                let listing = numbered_lines(&document.text);
                let text_bytes = listing.len();
                let answered = if withholds_the_text(spent, text_bytes, answers.is_empty()) {
                    json!({
                        "path": document.path,
                        "bytes": document.bytes,
                        "version": document.version,
                        "omitted": "This call had no room left for the text. It is open; ask for it \
                                    on its own before writing to it.",
                    })
                } else {
                    spent += text_bytes;
                    let mut answered = to_value(document);
                    answered["text"] = Value::String(listing);
                    answered
                };
                answers.push(answered);
            }
            Ok(json!({"files": answers}))
        }
        "update" => {
            require_script_path(&params)?;
            Ok(to_value(script::update_document(from_params(params)?)?))
        }
        "save" => {
            require_script_path(&params)?;
            let request: script::SaveScriptRequest = from_params(params)?;
            let saved = if script::is_outside_the_language_server(&request.path) {
                let workspace = crate::active_workspace(app)?;
                to_value(script::save_outside_the_language_server(
                    &workspace, request,
                )?)
            } else {
                to_value(script::save_and_publish(request)?)
            };
            Ok(saved)
        }
        "close" => {
            let paths = named_scripts(&params)?;
            let mut answers = Vec::with_capacity(paths.len());
            for path in paths {
                script::close_document(from_params(json!({"path": path.clone()}))?)?;
                answers.push(json!({"path": path, "closed": true}));
            }
            Ok(json!({"files": answers}))
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
            Ok(json!({"files": to_value(edited_scripts_and_shaders(app, request)?)}))
        }
        "apply_rename" => {
            let request: script::ApplyRenameRequest = from_params(params)?;
            for file in &request.files {
                require_script_path(&json!({"path": file.path}))?;
            }
            Ok(json!({"files": to_value(script::apply_rename(request)?)}))
        }
        "diagnostics" => {
            let paths = named_scripts(&params)?;
            let timeout_ms = params.get("timeoutMs").and_then(Value::as_u64);
            let files: Vec<Value> = script::diagnostics_for(paths, timeout_ms)?
                .into_iter()
                .map(to_value)
                .collect();
            Ok(json!({"files": files}))
        }
        _ => {
            let asked = params.clone();
            let request: ScriptRequest = from_tagged_params(op, params)?;
            let answered = to_value(script::call(request)?);
            Ok(if op == "completion" {
                a_completion_the_model_can_read(answered)
            } else if answer_names_nothing(op, &answered) {
                with_where_the_cursor_was(answered, &asked, script::document_text)
            } else if op == "prepare_rename" {
                with_the_placeholder_the_range_holds(answered, &asked, script::document_text)
            } else {
                answered
            })
        }
    }
}

/// `runtime.run` guards on the editor's `is_playing_scene()`, which a game the adapter launched is not.
fn refuse_a_second_game(op: &str) -> Result<(), ToolFailure> {
    crate::game_run::now()
        .refuse_a_second_game(crate::game_run::Starter::Runtime(op))
        .map_err(|refused| ToolFailure {
            code: refused.code.to_owned(),
            message: refused.message.to_owned(),
            retryable: false,
            details: json!({"op": op}),
        })
}

fn debug_domain(op: &str, params: Value) -> Result<Value, ToolFailure> {
    let request: DebugRequest = from_tagged_params(op, params)?;
    Ok(to_value(debug::call(request)?))
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

/// Sends one addon command through the same session API the renderer's `call_godot` uses.
/// `expectedRevision` and `timeoutMs` are lifted out of the parameters: every scene mutation
/// carries a revision, and the wire format keeps it beside the command rather than inside it.
fn rpc<R: Runtime>(
    app: &AppHandle<R>,
    command: &str,
    mut params: Value,
) -> Result<Value, crate::godot_rpc::RpcError> {
    let request = CallGodotRequest {
        command: command.to_owned(),
        expected_revision: take_u64(&mut params, "expectedRevision"),
        expected_scene: None,
        timeout_ms: take_u64(&mut params, "timeoutMs"),
        params,
    };
    let workspace = crate::active_workspace(app).ok();
    crate::read_ledger::through_the_editor(
        workspace.as_ref().map(files::Workspace::root),
        request,
        |request| godot_session_api::call_godot(app, request),
    )
}

fn take_u64(params: &mut Value, key: &str) -> Option<u64> {
    params
        .as_object_mut()
        .and_then(|object| object.remove(key))
        .and_then(|value| value.as_u64())
}

/// Deserializes tool parameters into a handler's own request type, so the handler's validation is
/// the only validation and a malformed call is refused before it reaches the editor.
pub(crate) fn from_params<T: serde::de::DeserializeOwned>(params: Value) -> Result<T, ToolFailure> {
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
pub(crate) fn to_value<T: Serialize>(value: T) -> Value {
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

    /// One entry of a `godot_scene` call, resolved the way the router resolves one.
    fn requested(op: &str, params: Value) -> Requested {
        Requested {
            domain: scene_domain(),
            operation: scene_domain()
                .operation(op)
                .unwrap_or_else(|| panic!("godot_scene offers {op}")),
            spelled: op.to_owned(),
            params,
        }
    }

    #[test]
    fn a_batch_stops_at_the_first_failure_and_says_what_it_did_not_run() {
        let ran = std::cell::RefCell::new(Vec::new());
        let answer = run_in_order(
            vec![
                requested("save", json!({})),
                requested("reload", json!({})),
                requested("save_as", json!({"path": "b.tscn"})),
            ],
            |entry, _| {
                ran.borrow_mut().push(entry.op().to_owned());
                if entry.op() == "reload" {
                    return Err(ToolFailure::new(
                        "scene_locked",
                        "the scene would not reload",
                    ));
                }
                Ok(json!({"ok": true}))
            },
        )
        .expect("a batch where something worked answers rather than fails");

        assert_eq!(*ran.borrow(), vec!["save", "reload"]);
        let ops = answer["ops"].as_array().expect("the entries");
        assert_eq!(ops.len(), 3, "every entry is accounted for: {answer}");
        assert_eq!(ops[1]["error"]["code"], "scene_locked");
        assert_eq!(ops[2]["because"], "scene_locked");
        assert!(ops[2]["skipped"].is_string(), "{answer}");
    }

    #[test]
    fn a_batch_fails_only_when_nothing_in_it_worked() {
        let refused = run_in_order(
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
            vec![
                requested("save", json!({})),
                requested("reload", json!({})),
                requested("save_as", json!({"path": "b.tscn"})),
            ],
            |entry, params| {
                seen.borrow_mut()
                    .push((entry.op().to_owned(), params["expectedRevision"].clone()));
                Ok(json!({"revision": if entry.op() == "save" { 7 } else { 9 }}))
            },
        )
        .expect("every entry worked");

        let seen = seen.borrow();
        assert!(seen[0].1.is_null(), "entry 0 is told nothing: {seen:?}");
        assert_eq!(seen[1].1, json!(7), "{seen:?}");
        assert_eq!(seen[2].1, json!(9), "and it follows the chain: {seen:?}");
    }

    #[test]
    fn the_first_entrys_own_revision_is_never_overwritten() {
        let seen = std::cell::RefCell::new(Vec::new());
        run_in_order(
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
        assert_eq!(seen[1], json!(40), "{seen:?}");
    }

    /// An operation that does not declare `expectedRevision` is never given one, whatever the
    /// entry before it answered with.
    #[test]
    fn an_operation_with_no_revision_parameter_is_left_alone() {
        let seen = std::cell::RefCell::new(Vec::new());
        run_in_order(
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
            failure.message.contains("scene.*"),
            "the refusal must name the tool that owns a scene: {}",
            failure.message
        );
    }

    /// A shader has no other tool, so `save` and `edit` write it; a resource is refused with the
    /// tool that owns it rather than with the scene sentence a live agent was sent to.
    #[test]
    fn a_shader_is_a_file_this_domain_writes_and_a_resource_is_named_its_own_tool() {
        assert!(require_script_path(&json!({"path": "shaders/night.gdshader"})).is_ok());
        assert!(require_script_path(&json!({"path": "shaders/common.gdshaderinc"})).is_ok());
        let resource = require_script_path(&json!({"path": "materials/lamp.tres"}))
            .expect_err("a resource is not this domain's to write");
        assert_eq!(resource.code, "unsupported_file");
        assert!(
            resource.message.contains("resource.*") && !resource.message.contains("scene.*"),
            "{}",
            resource.message
        );
        let other = require_script_path(&json!({"path": "notes/todo.md"}))
            .expect_err("anything else is refused with the reason");
        assert!(other.message.contains(".gdshader"), "{}", other.message);
    }

    /// A rename plan is a list of whole files, and it may only name scripts.
    ///
    /// The list is meant to be the one `rename` answered with, and a plan the server wrote names
    /// nothing but GDScript. A hand-built one can name anything at all — `project.godot`, a scene —
    /// and this arm wrote every entry with no path check, which is exactly the door `save` and
    /// `edit` are guarded at.
    #[test]
    fn a_rename_plan_may_only_name_scripts() {
        let app = unattended_app();
        let failure = dispatch(
            app.handle(),
            call(
                "godot_script",
                "apply_rename",
                json!({"files": [{
                    "path": "scenes/level_1.tscn",
                    "originalText": "[gd_scene]",
                    "originalHash": "whatever",
                    "updatedText": "[gd_scene]"
                }]}),
            ),
        )
        .expect_err("a scene inside a rename plan must be refused");
        assert_eq!(failure.code, "unsupported_file");
        assert!(
            failure.message.contains("scenes/level_1.tscn"),
            "the refusal must name the entry that is wrong: {}",
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
            let params = CATALOG
                .iter()
                .find(|domain| domain.name == "godot_script")
                .and_then(|domain| domain.operation(op))
                .unwrap_or_else(|| panic!("godot_script {op} declares its parameters"));
            assert!(
                params.params.iter().all(|param| param.name != "path"),
                "godot_script {op} still offers a single path beside the list"
            );
            let paths = params
                .params
                .iter()
                .find(|param| param.name == "paths")
                .unwrap_or_else(|| panic!("godot_script {op} names its paths"));
            assert_eq!(
                paths.kind,
                crate::tool_params::Kind::ListOf(&crate::tool_params::Kind::Path),
                "godot_script {op} must take a list of script paths"
            );
            assert!(paths.required, "godot_script {op} needs a path to work on");
            crate::tool_check::check(
                "godot_script",
                op,
                &json!({"paths": ["scripts/a.gd", "scripts/b.gd"]}),
            )
            .unwrap_or_else(|failure| {
                panic!("a list of paths must pass {op}: {}", failure.message)
            });
        }
    }

    /// A batch is refused for the same file a single call is refused for, and says which.
    #[test]
    fn a_batch_of_scripts_refuses_the_entry_that_is_not_a_script() {
        let failure = named_scripts(&json!({"paths": ["scripts/a.gd", "scenes/level_1.tscn"]}))
            .expect_err("a scene inside a batch must be refused");
        assert_eq!(failure.code, "unsupported_file");
        assert!(
            failure.message.contains("scenes/level_1.tscn"),
            "the refusal must name the entry that is wrong: {}",
            failure.message
        );
        for empty in [json!({"paths": []}), json!({})] {
            assert_eq!(
                named_scripts(&empty)
                    .expect_err("a call naming no script must be refused")
                    .code,
                "invalid_params"
            );
        }
        assert_eq!(
            named_scripts(&json!({"paths": ["scripts/a.gd"]})).expect("a list of one"),
            vec!["scripts/a.gd".to_owned()]
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

    /// Every tool the worker declares has to be able to say whether it can answer, and a tool
    /// added to the catalog without a probe has to fail rather than be assumed reachable.
    #[test]
    fn every_catalog_domain_answers_a_reachability_probe() {
        for domain in CATALOG {
            if domain.name == "godot_docs_search" {
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

    /// The 61 operations the addon answers, driven through the router with no editor.
    ///
    /// Every one of them used to be reachable only from `godot_ai_acceptance`, which boots Godot
    /// under xvfb at about four and a half seconds a test, because [`ScriptedAddon`] did not exist
    /// and `Editor` had no implementation that answered a command. What is under test here is
    /// Gofer — that the router reaches the transport, spells the command the way the catalogue
    /// says, and hands back what came off the wire. What the editor would have answered is not,
    /// and stays with the GDScript suites that can prove it.
    #[test]
    fn an_operation_the_addon_answers_is_driven_through_the_router_without_an_editor() {
        let directory = TempDir::new().expect("temporary application data");
        let workspace_path = directory.path().join("workspace");
        std::fs::create_dir(&workspace_path).expect("create workspace");
        let storage =
            crate::storage::ProjectStorage::open(&directory.path().join("data"), &workspace_path)
                .expect("open project storage");
        let app = unattended_app();
        app.manage(crate::storage::StorageSlot::new(Ok(storage)));
        // Bound at the app's own worktree: an editor sitting somewhere else is a worktree that
        // moved, and the router announces that with a `resource.rescan` the test never asked for.
        let worktree = crate::active_workspace(app.handle())
            .expect("the task worktree")
            .root()
            .to_owned();
        let addon = crate::scripted_addon::ScriptedAddon::answering(
            &worktree,
            &[
                (
                    "scene.open",
                    json!({"scene": "res://levels/level.tscn", "revision": 1, "dirty": false}),
                ),
                ("scene.list", json!({"scenes": ["res://levels/level.tscn"]})),
            ],
        );

        let answer = dispatch(
            app.handle(),
            calls(
                GODOT_TOOL,
                &[
                    ("scene.open", json!({"path": "res://levels/level.tscn"})),
                    ("scene.list", json!({})),
                ],
            ),
        )
        .expect("the scripted addon answers both");

        let ops = answer["ops"].as_array().expect("the entries");
        assert_eq!(ops.len(), 2, "{answer}");
        assert_eq!(ops[0]["result"]["scene"], "res://levels/level.tscn");
        assert_eq!(ops[1]["result"]["scenes"][0], "res://levels/level.tscn");

        // The binding is the process's, so what the addon was asked holds whatever else was
        // dispatched while this test held it. The assertion is about this test's own commands.
        let asked = addon.asked_about("scene.");
        let commands: Vec<&str> = asked.iter().map(|one| one.command.as_str()).collect();
        assert_eq!(commands, ["scene.open", "scene.list"], "{asked:?}");
        assert_eq!(
            asked[0].params["path"], "res://levels/level.tscn",
            "an addon operation is forwarded verbatim, scheme and all"
        );
    }

    /// A failure the addon answers with is the failure the model reads.
    #[test]
    fn what_the_addon_refuses_is_carried_out_under_the_addons_own_code() {
        let worktree = TempDir::new().expect("a worktree");
        let _addon = crate::scripted_addon::ScriptedAddon::answering(worktree.path(), &[]);
        let app = unattended_app();

        let failure = dispatch(
            app.handle(),
            call(
                "godot_scene",
                "open",
                json!({"path": "res://levels/level.tscn"}),
            ),
        )
        .expect_err("nothing in this addon's script answers scene.open");
        assert_eq!(failure.code, "unknown_command", "{failure:?}");
    }

    /// The confinement gate is in front of the transport, not behind it.
    ///
    /// It was written for the writers that live in the addon — `resource.create_texture` and its
    /// two neighbours — which are forwarded verbatim and had no gate on the way at all. Proving
    /// that needed a real editor until there was an addon that could be asked whether it was told.
    #[test]
    fn a_path_that_climbs_out_never_reaches_the_addon() {
        let worktree = TempDir::new().expect("a worktree");
        let addon = crate::scripted_addon::ScriptedAddon::answering(
            worktree.path(),
            &[("scene.open", json!({}))],
        );
        let app = unattended_app();

        let failure = dispatch(
            app.handle(),
            call(
                "godot_scene",
                "open",
                json!({"path": "res://../escaped.tscn"}),
            ),
        )
        .expect_err("a path that climbs out is refused");
        assert_eq!(failure.code, "outside_workspace");
        assert!(
            addon.asked_about("scene.open").is_empty(),
            "{:?}",
            addon.asked_about("scene.open")
        );
    }

    /// The one tool the model is given: each entry names its domain in a dotted `op`, one list may
    /// cross domains, and the answer echoes back what the call wrote.
    #[test]
    fn a_dotted_list_spanning_domains_is_answered_in_the_order_it_was_written() {
        let app = unattended_app();
        let answer = dispatch(
            app.handle(),
            calls(
                GODOT_TOOL,
                &[
                    ("session.status", json!({})),
                    ("logs.read", json!({"limit": 5})),
                ],
            ),
        )
        .expect("neither operation needs an editor");

        let ops = answer["ops"].as_array().expect("the entries");
        assert_eq!(ops.len(), 2, "{answer}");
        assert_eq!(ops[0]["op"], json!("session.status"));
        assert_eq!(ops[1]["op"], json!("logs.read"));
        assert!(ops[0]["result"].is_object(), "{answer}");
        assert!(ops[1]["result"].is_object(), "{answer}");
    }

    /// A dotted name the catalogue does not offer is refused as an operation rather than as a tool,
    /// and the refusal names it the way the call spelled it — including the domain prefix a model
    /// writes when it reaches for the old ten-tool spelling.
    #[test]
    fn a_dotted_op_the_catalogue_does_not_offer_is_named_in_the_refusal() {
        let app = unattended_app();
        for op in [
            "scene.detonate",
            "godot_node.create",
            "nowhere.open",
            "create",
        ] {
            let failure = dispatch(app.handle(), call(GODOT_TOOL, op, json!({})))
                .expect_err("the catalogue has no such operation");
            assert_eq!(failure.code, "unknown_operation", "{op}");
            assert!(failure.message.contains(op), "{}", failure.message);
        }

        let failure = dispatch(app.handle(), call("godot_nonexistent", "status", json!({})))
            .expect_err("a tool that is neither godot nor a domain");
        assert_eq!(failure.code, "unknown_tool");
    }

    /// The lone-operation rule is about the list the router received, so on a `godot` call it spans
    /// domains — which is what the model is told, and what the debugger needs to be true.
    #[test]
    fn the_lone_operation_rule_spans_domains_on_a_godot_call() {
        let app = unattended_app();
        let failure = dispatch(
            app.handle(),
            calls(
                GODOT_TOOL,
                &[
                    ("scene.open", json!({"path": "res://a.tscn"})),
                    ("debug.continue", json!({})),
                ],
            ),
        )
        .expect_err("the debugger shares no call, whatever domain sits beside it");
        assert_eq!(failure.code, "must_be_alone");
        assert_eq!(failure.details["op"], json!("debug.continue"));
        assert!(
            failure.message.starts_with("debug.continue has to be"),
            "{}",
            failure.message
        );
    }

    /// The blame prefix names the entry the way the call wrote it, so the model can correct the
    /// line it sent rather than translate a spelling back.
    #[test]
    fn a_multi_entry_godot_call_is_blamed_by_the_dotted_op() {
        let app = unattended_app();
        let failure = dispatch(
            app.handle(),
            calls(
                GODOT_TOOL,
                &[
                    (
                        "node.create_nodes",
                        json!({"nodes": [{"parent": "/L", "type": "Node2D", "name": "A"}]}),
                    ),
                    (
                        "node.create_nodes",
                        json!({"nodes": [{"parent": "/L", "name": "B"}]}),
                    ),
                ],
            ),
        )
        .expect_err("an entry with no type cannot be run");
        assert_eq!(failure.code, "missing_param");
        assert!(
            failure.message.starts_with("`ops[1]` (node.create_nodes):"),
            "{}",
            failure.message
        );
        assert_eq!(failure.details["opIndex"], json!(1));
    }

    /// `godot` is every domain at once, so its probe is only reachable when all of them are, and a
    /// failure names the domain rather than the tool.
    #[test]
    fn the_godot_probe_reaches_every_domain_the_catalogue_has() {
        match probe(GODOT_TOOL) {
            Ok(answer) => {
                assert_eq!(answer["tool"], json!(GODOT_TOOL));
                assert_eq!(answer["reachable"], json!(true));
            }
            Err(failure) => {
                assert_eq!(failure.code, "docs_unavailable");
                assert!(
                    failure.message.starts_with("godot_docs_search: "),
                    "{}",
                    failure.message
                );
            }
        }
    }

    /// A start another entry of the same call already began is joined, not reported.
    #[test]
    fn a_start_already_in_flight_is_waited_on_rather_than_refused() {
        use crate::godot_session::SessionError;
        joining_a_start_in_flight(Err::<(), _>(SessionError::new(
            "session_already_starting",
            "Another Godot session is already starting",
        )))
        .expect("the entry waits on the start in flight");
        let refused = joining_a_start_in_flight(Err::<(), _>(SessionError::new(
            "not_a_godot_project",
            "no project.godot",
        )))
        .expect_err("any other refusal is the answer");
        assert_eq!(refused.code, "not_a_godot_project");
    }

    /// A start that finishes between the two reads is a start that finished, not one that died.
    #[test]
    fn a_start_finishing_between_the_reads_is_not_reported_gone() {
        use crate::godot_session::SessionState;
        // The first read of either lets the start finish, so the second read sees it done.
        let finished = std::cell::Cell::new(false);
        let in_flight = || {
            let answer = !finished.get();
            finished.set(true);
            answer
        };
        let state = || {
            let answer = if finished.get() {
                SessionState::Ready
            } else {
                SessionState::Offline
            };
            finished.set(true);
            answer
        };
        assert!(matches!(
            the_start_so_far(in_flight, state, || false),
            StartSoFar::Answering
        ));
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

    /// A language server that is not listening yet is a session that is not up.
    ///
    /// `session_not_active` is what a call meets when nothing has been started. `connect_failed` is
    /// what it meets when the session record exists and the editor's language server port is not
    /// answering — a session still coming up, or one whose editor went away without clearing the
    /// record. The model cannot tell those apart and has the same next move for both, so the same
    /// door opens for both. A live turn met this on its first `godot_script save` and was told only
    /// that a port could not be reached.
    #[test]
    fn a_language_server_that_cannot_be_reached_starts_a_session_and_answers() {
        let started = std::cell::Cell::new(0);
        let answered = starting_the_session_if_there_is_none(
            project_domain(),
            json!({}),
            |_| {
                if started.get() == 0 {
                    return Err(ToolFailure::new(
                        "connect_failed",
                        "Could not reach the language server at 127.0.0.1:6005",
                    ));
                }
                Ok(json!({"path": "scripts/player.gd"}))
            },
            || {
                started.set(started.get() + 1);
                Ok(())
            },
        )
        .expect("the operation is answered from the session it started");
        assert_eq!(started.get(), 1, "the session is started once");
        assert_eq!(answered["path"], json!("scripts/player.gd"));
    }

    /// A server that stays unreachable after a start answers the failure, and starts nothing more.
    #[test]
    fn a_language_server_that_stays_unreachable_is_answered_rather_than_restarted() {
        let started = std::cell::Cell::new(0);
        let ran = std::cell::Cell::new(0);
        let failure = starting_the_session_if_there_is_none(
            project_domain(),
            json!({}),
            |_| {
                ran.set(ran.get() + 1);
                Err(ToolFailure::new(
                    "connect_failed",
                    "Could not reach the language server at 127.0.0.1:6005",
                ))
            },
            || {
                started.set(started.get() + 1);
                Ok(())
            },
        )
        .expect_err("a server that never answers is a failure, not a loop");
        assert_eq!(failure.code, "connect_failed");
        assert_eq!((ran.get(), started.get()), (2, 1));
    }

    /// A stop that started an editor would be the opposite of what was asked.
    ///
    /// Both codes the door opens on, because the exemption is one line past the match: widening
    /// what counts as a missing session widens what `godot_session` has to be held out of.
    #[test]
    fn the_session_domain_never_starts_an_editor_behind_its_own_back() {
        for code in ["session_not_active", "connect_failed"] {
            let started = std::cell::Cell::new(0);
            let failure = starting_the_session_if_there_is_none(
                CATALOG
                    .iter()
                    .find(|domain| domain.name == "godot_session")
                    .expect("the session domain"),
                json!({}),
                |_| Err(ToolFailure::new(code, "No Godot session is active")),
                || {
                    started.set(started.get() + 1);
                    Ok(())
                },
            )
            .expect_err("stopping a session that is not running is not a reason to start one");
            assert_eq!(failure.code, code);
            assert_eq!(started.get(), 0, "{code}");
        }
    }

    /// A start that could not happen still answers "no session", and says why it could not.
    ///
    /// Through the real router: `unattended_app` has no project storage, so the start the router
    /// now makes for itself fails there rather than launching an editor.
    #[test]
    fn a_session_that_cannot_be_started_says_why_it_could_not() {
        let _no_editor = crate::godot_session::no_editor_bound();
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
        let _no_editor = crate::godot_session::no_editor_bound();
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

    /// A page asked for `limit` lines comes back with `limit` lines a model can read.
    ///
    /// The buffer applies the limit and the filter runs after it, so one page of two hundred can
    /// come back as forty once the editor's own terminal output is out of it — and forty where two
    /// hundred were asked for reads as "there is no more", which is the one thing it must not mean.
    #[test]
    fn a_page_is_filled_to_the_limit_with_lines_that_survive_the_filter() {
        let _test = godot_session::SESSION_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        godot_session::clear_logs();
        let escape = char::from(27);
        for index in 0..30 {
            for step in 0..9 {
                godot_session::append_log(
                    godot_session::LogSource::Editor,
                    &format!("[  {step}0% ] {escape}[90mimport{escape}[0m | step {step}\n"),
                );
            }
            godot_session::append_log(
                godot_session::LogSource::Editor,
                &format!("[player] line {index}\n"),
            );
        }

        let answered = logs_domain(json!({"limit": 12})).expect("the logs read");
        let entries = answered["entries"].as_array().expect("entries");
        assert_eq!(entries.len(), 12, "{answered}");
        assert_eq!(entries[0]["message"], "[player] line 0", "{answered}");
        assert_eq!(entries[11]["message"], "[player] line 11", "{answered}");
        assert!(
            answered["terminalLinesOmitted"].as_u64().unwrap_or(0) >= 108,
            "{answered}"
        );

        let next = logs_domain(json!({"limit": 3, "after": answered["cursor"].clone()}))
            .expect("the next page");
        assert_eq!(next["entries"][0]["message"], "[player] line 12", "{next}");

        let searched = logs_domain(json!({"limit": 5, "contains": "line 2"})).expect("the search");
        assert_eq!(
            searched["entries"][0]["message"], "[player] line 2",
            "{searched}"
        );
        let narrowed = logs_domain(json!({"contains": "line 2", "minSeverity": "warning"}))
            .expect("the narrowed search");
        assert!(
            narrowed["entries"].as_array().is_some_and(Vec::is_empty),
            "a search that named a severity keeps it: {narrowed}"
        );

        godot_session::append_log(
            godot_session::LogSource::EditorError,
            "WARNING: Live test reached five ticks",
        );
        let on_the_editor = logs_domain(json!({"minSeverity": "warning", "source": "editor"}))
            .expect("the warnings of the editor");
        assert_eq!(
            on_the_editor["entries"][0]["message"], "WARNING: Live test reached five ticks",
            "`editor` is the whole editor process, and its warnings are on stderr: {on_the_editor}"
        );
        let on_stderr = logs_domain(json!({"minSeverity": "info", "source": "editorError"}))
            .expect("stderr alone");
        assert_eq!(
            on_stderr["entries"].as_array().map(Vec::len),
            Some(1),
            "`editorError` is still stderr alone: {on_stderr}"
        );
        godot_session::clear_logs();
    }

    /// A game's own output is the verdict of whatever it just ran, and a bare read has to carry it.
    ///
    /// The default severity was `warning`, to keep the editor's chatter out of a page. Godot marks
    /// none of a game's output, so a test scene printing `ALL CHECKS PASSED` is classified `info`
    /// and fell under it. A live turn ran its own combat check, read the log, was answered nine
    /// editor lines and not one of its own, and spent six minutes in the debugger hunting a verdict
    /// the read had already dropped. Chatter is held back by the terminal-progress collapse, which
    /// is where the volume actually was: that whole session logged 115 lines, 89 of them the game.
    #[test]
    fn a_bare_read_carries_what_the_game_printed_on_its_error_stream() {
        let _test = godot_session::SESSION_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        godot_session::clear_logs();
        godot_session::append_log(
            godot_session::LogSource::Editor,
            "[  90% ] import | scenes/main.tscn\n",
        );
        godot_session::append_log(
            godot_session::LogSource::EditorError,
            "[PASS] splash: 12 damage killed both 10-hp dummies\n",
        );
        godot_session::append_log(godot_session::LogSource::EditorError, "ALL CHECKS PASSED\n");

        let answered = logs_domain(json!({})).expect("the logs read");
        let messages: Vec<&str> = answered["entries"]
            .as_array()
            .expect("entries")
            .iter()
            .filter_map(|entry| entry["message"].as_str())
            .collect();
        assert!(
            messages.contains(&"ALL CHECKS PASSED"),
            "a bare read has to carry the game's own verdict: {answered}"
        );
        assert!(
            messages.contains(&"[PASS] splash: 12 damage killed both 10-hp dummies"),
            "{answered}"
        );
        assert!(
            !messages
                .iter()
                .any(|message| message.contains("import | scenes/main.tscn")),
            "the editor's own chatter is what the default is for: {answered}"
        );
        godot_session::clear_logs();
    }

    /// A parameter mistake in the fourth entry has to name the fourth entry.
    ///
    /// The checker's own sentence is about the operation, and it is the same sentence whichever
    /// entry wrote it. `godot_node rename requires `name`` is not actionable when the model sent
    /// eleven renames; the entry it came from is the whole of what makes it one.
    #[test]
    fn a_bad_entry_is_blamed_by_its_position_and_nothing_in_the_list_runs() {
        let app = unattended_app();
        let failure = dispatch(
            app.handle(),
            calls(
                "godot_node",
                &[
                    ("rename", json!({"node": "/L/A", "name": "A2"})),
                    ("rename", json!({"node": "/L/B", "name": "B2"})),
                    ("rename", json!({"node": "/L/C"})),
                ],
            ),
        )
        .expect_err("an entry with no name cannot be run");
        assert_eq!(failure.code, "missing_param");
        assert!(
            failure.message.starts_with("`ops[2]` (rename):"),
            "{}",
            failure.message
        );
        assert_eq!(failure.details["opIndex"], json!(2));

        assert!(
            failure
                .message
                .contains("None of the 3 operations in this call ran"),
            "{}",
            failure.message
        );

        let failure = dispatch(
            app.handle(),
            call("godot_node", "create", json!({"parent": "/L", "name": "C"})),
        )
        .expect_err("one entry with no type cannot be run either");
        assert!(!failure.message.contains("ops["), "{}", failure.message);
        assert!(
            !failure.message.contains("None of the"),
            "{}",
            failure.message
        );
        assert_eq!(failure.details["opIndex"], Value::Null);
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
                domain,
                operation: domain
                    .operation(op)
                    .unwrap_or_else(|| panic!("{tool} offers {op}")),
                spelled: (*op).to_owned(),
                params: json!({}),
            })
            .collect();
        refuse_a_list_that_holds_a_lone_operation(&entries)
    }

    /// The two narrowings, each refused in its own words, and neither one costing a list that is
    /// merely two steps long.
    #[test]
    fn a_repeated_operation_is_refused_and_a_two_step_list_is_not() {
        let _no_editor = crate::godot_session::no_editor_bound();
        let failure = gate("godot_scene", &["open", "open"]).expect_err("one scene is open");
        assert_eq!(failure.code, "op_repeated");
        assert_eq!(failure.details["opIndex"], json!(1));
        assert_eq!(failure.details["firstIndex"], json!(0));
        assert!(
            failure.message.contains("One scene is open at a time"),
            "{}",
            failure.message
        );

        gate("godot_scene", &["open", "get_tree"]).expect("open then read the tree");
        gate("godot_runtime", &["capture", "get_state"]).expect("a frame and the state");
        gate("godot_debug", &["status", "threads"]).expect("two reads of the debuggee");

        let failure = gate("godot_debug", &["continue", "threads"]).expect_err("one debuggee");
        assert_eq!(failure.code, "must_be_alone");
        assert_eq!(failure.details["opIndex"], json!(0));
        assert!(
            failure.message.contains("One debuggee, driven in order"),
            "{}",
            failure.message
        );

        let app = unattended_app();
        let failure = dispatch(
            app.handle(),
            call("godot_scene", "open", json!({"path": "res://a.tscn"})),
        )
        .expect_err("no session is active");
        assert_eq!(failure.code, "session_not_active");
    }

    /// Every operation that declares a narrowing, with the domain that offers it.
    fn narrowed() -> Vec<(
        &'static ToolDomain,
        &'static Operation,
        Sharing,
        &'static str,
    )> {
        CATALOG
            .iter()
            .flat_map(|domain| {
                domain.operations.iter().filter_map(move |operation| {
                    let (scope, reason) = operation.sharing()?;
                    Some((domain, operation, scope, reason))
                })
            })
            .collect()
    }

    /// Every narrowed operation, refused when it is asked for what its scope does not allow, and
    /// allowed the other shape.
    ///
    /// Read off the catalogue rather than listed, so an operation that grows a narrowing is
    /// covered the day it lands, and one whose scope changes is covered in its new sense.
    #[test]
    fn every_narrowed_operation_is_refused_in_the_shape_its_scope_names() {
        let narrowed = narrowed();
        assert!(
            narrowed.len() > 20,
            "{} narrowed operations",
            narrowed.len()
        );
        for (domain, entry, scope, reason) in narrowed {
            let neighbour = domain
                .operations
                .iter()
                .map(|operation| operation.op)
                .find(|op| *op != entry.op)
                .expect("a domain offers more than one operation");

            let twice = gate(domain.name, &[entry.op, entry.op])
                .expect_err("a narrowed operation is never allowed twice");
            assert_eq!(
                twice.code,
                match scope {
                    Sharing::Repeat => "op_repeated",
                    Sharing::Exclusive => "must_be_alone",
                },
                "{}.{}: {}",
                domain.name,
                entry.op,
                twice.message
            );
            assert!(
                twice.message.contains(reason),
                "{}.{} does not carry its own sentence: {}",
                domain.name,
                entry.op,
                twice.message
            );

            let beside = gate(domain.name, &[entry.op, neighbour]);
            match scope {
                Sharing::Repeat => {
                    beside.unwrap_or_else(|failure| {
                        panic!(
                            "{}.{} may sit beside {neighbour}: {}",
                            domain.name, entry.op, failure.message
                        )
                    });
                }
                Sharing::Exclusive => {
                    let failure = beside.expect_err("an exclusive operation shares nothing");
                    assert_eq!(failure.code, "must_be_alone");
                    assert_eq!(failure.details["op"], json!(entry.op));
                    assert!(
                        failure.message.contains(reason),
                        "{}.{}: {}",
                        domain.name,
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
        gate("godot_session", &["start", "status"]).expect("start then report");
        gate("godot_session", &["get_state", "answer_dialog"]).expect("read then press");
        gate("godot_session", &["stop", "start"]).expect("stop then start");

        gate(
            "godot_project",
            &[
                "set_autoload",
                "list_autoloads",
                "remove_autoload",
                "list_autoloads",
            ],
        )
        .expect("a read after each write is two different questions");
        gate("godot_session", &["undo", "get_state", "undo"]).expect("a read between two undos");

        let failure = gate("godot_session", &["undo", "undo"]).expect_err("one undo stack");
        assert_eq!(failure.code, "op_repeated");
        assert_eq!(failure.details["op"], json!("undo"));
        assert!(
            failure.message.contains("One undo stack"),
            "{}",
            failure.message
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
    /// The nine shapes under `repairs` are deliberately not here. Those are calls the generated
    /// schema refuses outright, so the raw form never reaches the gate;
    /// `the_repaired_form_of_every_recorded_call_passes_the_check` in `tool_check.rs` holds each
    /// one to the corrected form instead.
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
            for entry in case["ops"].as_array().expect("case ops") {
                let mut params = entry.clone();
                if let Some(object) = params.as_object_mut() {
                    object.remove("op");
                }
                let op = entry["op"].as_str().expect("an op name");
                crate::tool_check::check(tool, op, &params).unwrap_or_else(|failure| {
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
        let _no_editor = crate::godot_session::no_editor_bound();
        let app = unattended_app();
        let enforcing = crate::settings::GodotSettings::default();
        let relaxed = crate::settings::GodotSettings {
            strict_typing: false,
            embed_game_window: false,
            headless: false,
        };
        let warning = json!({
            "name": "debug/gdscript/warnings/unsafe_method_access",
            "value": {"type": "int", "value": 0}
        });

        let failure = dispatch_under(
            app.handle(),
            call("godot_project", "set_setting", warning.clone()),
            &enforcing,
            Caller::Worker,
        )
        .expect_err("an enforced warning is not the agent's to write");
        assert_eq!(failure.code, "policy_enforced");
        assert!(!failure.retryable, "retrying writes the same setting again");

        assert_eq!(
            dispatch_under(
                app.handle(),
                call("godot_project", "set_setting", warning),
                &relaxed,
                Caller::Worker,
            )
            .expect_err("no session is active")
            .code,
            "session_not_active"
        );

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
                Caller::Worker,
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

        let failure = dispatch(
            app.handle(),
            call("godot_resource", "delete", json!({"path": "main.gd"})),
        )
        .expect_err("an unattended backend cannot approve a delete");
        assert_eq!(failure.code, "approval_unavailable");
    }

    /// Both listings take `under` off a request type, and both narrow the walk by it.
    ///
    /// The two arms read `params.get("under")` out of the raw JSON until they were given request
    /// types, and `tool_drift` recovered what they read by parsing their own source text — so the
    /// wiring between the key and the filter was held together by a parser rather than by a
    /// compiler, and the parser was the thing that decided the arms could not share a helper. This
    /// is what says the field reaches the walk.
    #[test]
    fn both_listings_narrow_to_the_directory_the_call_names() {
        let directory = TempDir::new().expect("temporary application data");
        let workspace_path = directory.path().join("workspace");
        std::fs::create_dir(&workspace_path).expect("create workspace");
        let storage =
            crate::storage::ProjectStorage::open(&directory.path().join("data"), &workspace_path)
                .expect("open project storage");
        let app = unattended_app();
        app.manage(crate::storage::StorageSlot::new(Ok(storage)));

        let workspace = crate::active_workspace(app.handle()).expect("the task worktree");
        workspace
            .write("scripts/player.gd", "extends Node\n", None)
            .expect("write a script");
        workspace
            .write("levels/level.tscn", "[gd_scene format=3]\n", None)
            .expect("write a scene");

        let listed = |tool: &str, params: Value| -> Vec<String> {
            let answered = dispatch(app.handle(), call(tool, "list", params)).expect("list");
            only_answer(&answered)["files"]
                .as_array()
                .expect("a listing answers with files")
                .iter()
                .map(|file| file["path"].as_str().unwrap_or_default().to_owned())
                .collect()
        };

        assert_eq!(
            listed("godot_resource", json!({"under": "scripts"})),
            vec!["scripts/player.gd".to_owned()],
            "a directory named narrows the worktree listing to it"
        );
        assert_eq!(
            listed("godot_script", json!({"under": "levels"})),
            Vec::<String>::new(),
            "and narrows the script listing to it, which holds no scripts"
        );
        assert_eq!(
            listed("godot_script", json!({})),
            vec!["scripts/player.gd".to_owned()],
            "no directory named is every script"
        );
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

    /// A backend with a window that approves every prompt it is shown.
    ///
    /// The prompt is registered before it is emitted, so the listener can answer it on the spot.
    fn approving_app() -> tauri::App<tauri::test::MockRuntime> {
        use tauri::Listener;
        crate::approvals::open();
        let app = unattended_app();
        let window = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("build mock webview");
        window.listen("ai-approval-request", |event| {
            let prompt: Value = serde_json::from_str(event.payload()).expect("an approval prompt");
            let id = prompt["approvalId"]
                .as_str()
                .expect("a prompt carries its id");
            crate::approvals::respond(id, true).expect("the prompt is waiting");
        });
        app
    }

    /// The ledger is keyed on the worktree's spelling, so a `res://` delete that reached it
    /// unnormalised found no record and ran unguarded.
    #[test]
    fn a_resource_spelled_delete_of_a_changed_file_is_refused_by_the_hash_it_was_listed_with() {
        let _gate = crate::approvals::serialize_gate_tests();
        let directory = TempDir::new().expect("temporary application data");
        let workspace_path = directory.path().join("workspace");
        std::fs::create_dir(&workspace_path).expect("create workspace");
        let storage =
            crate::storage::ProjectStorage::open(&directory.path().join("data"), &workspace_path)
                .expect("open project storage");
        let app = approving_app();
        app.manage(crate::storage::StorageSlot::new(Ok(storage)));
        let workspace = crate::active_workspace(app.handle()).expect("the task worktree");

        let scene = "[gd_scene format=3]\n\n[node name=\"Level\" type=\"Node2D\"]\n";
        let stamp = workspace
            .write("levels/level.tscn", scene, None)
            .expect("write the scene");
        dispatch(
            app.handle(),
            call("godot_resource", "list", json!({"hashes": true})),
        )
        .expect("list the worktree with hashes");
        workspace
            .write(
                "levels/level.tscn",
                &format!("{scene}\n[node name=\"Player\"]\n"),
                Some(&stamp.hash),
            )
            .expect("someone edits the scene");

        let refused = dispatch(
            app.handle(),
            call(
                "godot_resource",
                "delete",
                json!({"path": "res://levels/level.tscn"}),
            ),
        )
        .expect_err("a scene that changed since it was listed must not be deleted");
        assert_eq!(refused.code, "file_conflict", "{}", refused.message);
        assert!(workspace_path.join("levels/level.tscn").exists());
        crate::read_ledger::forget_worktree(workspace.root());
    }

    /// A read the worker made arms the save the router later checks, as the router's own would.
    ///
    /// The regression: `read scripts/player.gd`, then `script.save` over it, refused as a file
    /// the agent had not been shown — and sent again unchanged, because from where the model sat
    /// it had been shown the file.
    #[test]
    fn a_read_the_worker_made_arms_the_save_over_what_it_showed() {
        let directory = TempDir::new().expect("temporary application data");
        let workspace_path = directory.path().join("workspace");
        std::fs::create_dir(&workspace_path).expect("create workspace");
        let storage =
            crate::storage::ProjectStorage::open(&directory.path().join("data"), &workspace_path)
                .expect("open project storage");
        let app = unattended_app();
        app.manage(crate::storage::StorageSlot::new(Ok(storage)));
        let workspace = crate::active_workspace(app.handle()).expect("the task worktree");
        let script = "extends Node2D\n";
        workspace
            .write("scripts/player.gd", script, None)
            .expect("write the script");
        crate::read_ledger::forget_worktree(workspace.root());

        let noted = dispatch(
            app.handle(),
            ToolRequest {
                tool: crate::read_ledger::NOTED_READ_TOOL.to_owned(),
                params: json!({"path": "res://scripts/player.gd"}),
            },
        )
        .expect("note the read");
        assert_eq!(noted["noted"], true, "{noted}");
        assert_eq!(
            crate::read_ledger::recall(workspace.root(), "scripts/player.gd").as_deref(),
            Some(files::hash_text(script).as_str()),
            "the record is keyed the way a save names the file, scheme off"
        );
        crate::read_ledger::forget_worktree(workspace.root());
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

        let mut dotted = std::collections::HashSet::new();
        for domain in CATALOG {
            let short = domain
                .name
                .strip_prefix("godot_")
                .unwrap_or_else(|| panic!("{} has to be named godot_<short>", domain.name));
            for operation in domain.operations {
                let name = format!("{short}.{}", operation.op);
                assert_eq!(
                    whatever_the_dotted_name_points_at(&name).map(|(_, row)| row.op),
                    Some(operation.op),
                    "{name} has to resolve back to its own row"
                );
                assert!(
                    dotted.insert(name.clone()),
                    "{name} is not unique across the catalogue"
                );
            }
        }
    }

    /// Whether prose is naming a parameter rather than using an English word that happens to match.
    ///
    /// Half the parameter names are ordinary words — `scene`, `path`, `node`, `name` — and every
    /// summary is written in sentences about scenes and nodes. What identifies a parameter is
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

    #[test]
    fn an_input_event_with_no_kind_is_told_what_the_kinds_are() {
        let app = unattended_app();
        let refused = dispatch_under(
            app.handle(),
            call("godot_runtime", "input", json!({"events": [{"key": "A"}]})),
            &crate::settings::GodotSettings::default(),
            Caller::Worker,
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

        let wrong = dispatch_under(
            app.handle(),
            call(
                "godot_runtime",
                "input",
                json!({"events": [{"kind": "keyboard", "key": "A"}]}),
            ),
            &crate::settings::GodotSettings::default(),
            Caller::Worker,
        )
        .expect_err("a kind outside the five is refused");
        assert!(wrong.message.contains("mouse_motion"), "{}", wrong.message);

        let complete = dispatch_under(
            app.handle(),
            call(
                "godot_runtime",
                "input",
                json!({"events": [
                    {"kind": "key", "key": "A", "pressed": false, "device": 16},
                    {"kind": "mouse_button", "button": "MOUSE_BUTTON_LEFT", "position": [4, 5]},
                    {"kind": "mouse_button", "button": "MOUSE_BUTTON_MIDDLE"},
                    {"kind": "mouse_motion", "position": [1, 2], "relative": [3, 4]},
                    {"kind": "joypad_button", "joypadButton": "JOY_BUTTON_X", "pressed": true},
                    {"kind": "joypad_motion", "axis": "JOY_AXIS_LEFT_Y", "value": -0.5},
                ]}),
            ),
            &crate::settings::GodotSettings::default(),
            Caller::Worker,
        )
        .expect_err("no session is active");
        assert_ne!(complete.code, "missing_param", "{}", complete.message);
        assert_ne!(complete.code, "unknown_param", "{}", complete.message);
        assert_ne!(complete.code, "invalid_param", "{}", complete.message);
    }

    #[test]
    fn a_torn_edit_is_told_about_the_call_that_needs_no_anchors() {
        let torn = the_whole_file(
            "godot_script",
            "edit",
            ToolFailure::new("missing_param", "script.edit `files[0]` requires `path`."),
        );
        assert_eq!(torn.code, "missing_param");
        assert!(torn.message.contains("requires `path`"), "{}", torn.message);
        assert!(
            torn.message.contains("script.save"),
            "the refusal offered no way out: {}",
            torn.message
        );

        for code in ["file_conflict", "not_found", "connect_failed"] {
            let other = the_whole_file(
                "godot_script",
                "edit",
                ToolFailure::new(code, "something else went wrong"),
            );
            assert!(
                !other.message.contains("script.save"),
                "{code} must not be answered with save: {}",
                other.message
            );
        }

        let elsewhere = the_whole_file(
            "godot_node",
            "create",
            ToolFailure::new("missing_param", "node.create requires `parent`."),
        );
        assert!(
            !elsewhere.message.contains("script.save"),
            "{}",
            elsewhere.message
        );
        let other_op = the_whole_file(
            "godot_script",
            "save",
            ToolFailure::new("missing_param", "script.save requires `path`."),
        );
        assert!(
            !other_op.message.contains("needs no anchors"),
            "{}",
            other_op.message
        );

        let app = unattended_app();
        let refused = dispatch_under(
            app.handle(),
            call(
                "godot_script",
                "edit",
                json!({"files": [{"edits": [{"oldText": "a", "newText": "b"}]}]}),
            ),
            &crate::settings::GodotSettings::default(),
            Caller::Worker,
        )
        .expect_err("an entry with no path is refused");
        assert_eq!(refused.code, "missing_param");
        assert!(
            refused.message.contains("This one carries edits."),
            "{}",
            refused.message
        );
        assert!(
            refused.message.contains("script.save"),
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
}

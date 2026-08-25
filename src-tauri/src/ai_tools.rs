//! The AI tool router.
//!
//! Ten compact domain tools stand in front of the handlers the renderer already calls. A tool call
//! is `{tool, params: {op, ...}}`, and this module is the only place that turns it into a real
//! operation: an addon RPC command, a script-intelligence request, a debug-adapter request, a page
//! of session logs, or a documentation retrieval. There is no second implementation of any of them
//! — the agent and the UI reach identical code, so a scene the agent edits goes through the same
//! undo stack, the same revision check, and the same worktree binding as one the user edits.
//!
//! The catalog below is also the contract the Node worker receives at startup: the ten tools, and
//! under each of them the [`Operation`] rows [`crate::tool_params`] declares — the summary, the
//! signature, the parameters and the narrowing the model is shown. It is the same list this router
//! dispatches against, so a tool the model can call always exists here, and one it cannot call
//! never does.
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
use crate::tool_params::{self, Operation, Sharing};
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
    crate::godot_session::SessionError
);

/// One domain tool: a name, what it is for, and every operation it accepts.
///
/// The operations are [`crate::tool_params`]'s, whole: one [`Operation`] per row of
/// `protocol/schemas/v2/params.json`, carrying the prose the model reads as well as the parameters
/// that refuse the call, the route that answers it, the narrowing of an `ops` list and the gate
/// that asks the user first. What the worker receives is therefore the row rather than a merge —
/// the summary used to live here and everything else there, so the view the model is given was
/// assembled at serialization time out of two files nothing in the type system held together.
///
/// The name and the description stay here, hand-written: a domain is a decision about how to
/// present a hundred operations as ten tools, and there is nothing to hold it to.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct ToolDomain {
    pub name: &'static str,
    pub description: &'static str,
    pub operations: &'static [Operation],
}

impl ToolDomain {
    /// The operation this domain offers under that name, or `None` for a name it does not offer.
    ///
    /// The router resolves it once, at the start of the call, and asks the row everything after
    /// that. Before, the same `(tool, op)` pair was matched against a separate table five times in
    /// one dispatch — for the repair, the check, the rule, the gate and the narrowing — and a
    /// sixth and seventh time to route it and to thread its revision.
    pub fn operation(&self, op: &str) -> Option<&'static Operation> {
        self.operations.iter().find(|offered| offered.op == op)
    }
}

/// The ten domain tools. Compact on purpose: one tool per domain with an `op`, rather than a
/// hundred flat tools that would fill the model's context with names it will never call.
pub const CATALOG: &[ToolDomain] = &[
    ToolDomain {
        name: "godot_session",
        description: "Owns the managed Godot editor session bound to the active task worktree.",
        operations: tool_params::GODOT_SESSION_OPERATIONS,
    },
    ToolDomain {
        name: "godot_scene",
        description: "The edited scene in the editor — never the running game's scene tree. Every \
                      mutation here is checked against the scene's revision, and the router supplies \
                      that number from the last answer that carried one, so never pass it and never \
                      read the tree to fetch it.",
        operations: tool_params::GODOT_SCENE_OPERATIONS,
    },
    // The last clause is the corpus's most common surviving mistake, answered where the call is
    // written. `{"op": "save"}` batched onto `godot_node` is **seven of the nine recorded refusals
    // that still reach one before the router**, across six runs, and each one takes a whole batch
    // of good work down with it because a list is refused as one. The description said how a
    // mutation is revisioned and what a path looks like, and never that none of them writes the
    // file.
    //
    // **Unmeasured.** `scripts/bench-where-save-lives.mjs` is the interleaved A/B for it, primed to
    // the call before the mistake. The local model cannot answer it — three seeds an arm and it
    // never wrote `connect_signal` or a `save` on any tool, because it wires buttons in `_ready`
    // instead — and OpenRouter's free tier for the model that does write it was spent for the day.
    ToolDomain {
        name: "godot_node",
        description: "Node authoring inside the edited scene. Every mutation is undoable and every \
                      one of them is checked against the scene's revision — which the router \
                      supplies from the last answer that carried one, and every mutation's own \
                      answer carries the next. So mutate, then mutate again: there is no revision to \
                      pass and no tree to re-read between them. Paths are the scene's own, like \
                      /Level1 or /Level1/Ground. Nothing here writes the file: godot_scene save \
                      does.",
        operations: tool_params::GODOT_NODE_OPERATIONS,
    },
    ToolDomain {
        name: "godot_project",
        description: "Project settings, autoloads, the Input Map, plugins, and machine-wide editor \
                      settings. Project writes persist in the task worktree; editor settings are \
                      machine-wide and outside Git.",
        operations: tool_params::GODOT_PROJECT_OPERATIONS,
    },
    ToolDomain {
        name: "godot_resource",
        description: "Project files as the editor sees them. Deleting and moving need the user's \
                      approval; nothing outside the task worktree can be named at all.",
        operations: tool_params::GODOT_RESOURCE_OPERATIONS,
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
        operations: tool_params::GODOT_SCRIPT_OPERATIONS,
    },
    ToolDomain {
        name: "godot_debug",
        description: "Godot's debug adapter. Install breakpoints with the launch itself, then wait \
                      for a stop before inspecting: stopping is an event, not a response.",
        operations: tool_params::GODOT_DEBUG_OPERATIONS,
    },
    ToolDomain {
        name: "godot_runtime",
        description: "The running game: its live scene tree, input, performance, and screenshots. \
                      Distinct from the edited scene, and named differently: every path here \
                      starts at /root, where godot_node's start at the edited scene's own root.",
        operations: tool_params::GODOT_RUNTIME_OPERATIONS,
    },
    ToolDomain {
        name: "godot_logs",
        description: "The session's captured output — editor, importer, plugin, and the game the \
                      editor launched — with a cursor and severity filtering.",
        operations: tool_params::GODOT_LOGS_OPERATIONS,
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
        operations: tool_params::GODOT_DOCS_SEARCH_OPERATIONS,
    },
];

/// The summary of one catalog operation, for the tests and the acceptance suite that hold the
/// prose to the addon behind it.
#[cfg(test)]
pub fn summary_of(tool: &str, op: &str) -> &'static str {
    tool_params::operation_of(tool, op)
        .unwrap_or_else(|| panic!("{tool} {op} is in the catalog"))
        .summary
}

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
pub(crate) fn probe(domain: &str) -> Result<Value, ToolFailure> {
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
        crate::ask::ASK_USER_TOOL => Ok(json!({"tool": domain, "reachable": true})),
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
) -> Result<Value, ToolFailure> {
    let listed = request
        .params
        .get("ops")
        .and_then(Value::as_array)
        .map_or(0, Vec::len);
    route(app, request, rules).map_err(|failure| said_that_none_of_it_ran(listed, failure))
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
    if listed < 2 || failure.code == "cancelled" || failure.code == "unknown_tool" {
        return failure;
    }
    let mut failure = failure;
    // A full stop first when the sentence it is joining did not end in one. `node_not_found: No
    // running node at '/root/Main/@Area2D@19'` ends on the path, and the clause ran straight into
    // it — measured on a live turn, four times in one run.
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
    if request.tool == crate::ask::ASK_USER_TOOL {
        return crate::ask::ask_user(app, &request.params);
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
    // before anything is held to it. See `Operation::repair` for why this is a repair and not a
    // refusal: the refusal was tried, and it printed the right answer into a call that was made
    // again unchanged four times.
    for entry in &mut entries {
        entry.operation.repair(&mut entry.params);
        // And the other half of "the shape a model wrote, put into the shape the protocol takes":
        // the two spellings of a path. Here rather than in an arm, because an arm that has to
        // remember it is an arm that can forget it — and `resource_domain` did, silently. See
        // `as_the_worktree_names_them`.
        as_the_worktree_names_them(entry.operation, &mut entry.params);
    }

    // Everything that can refuse the call is answered before any of it runs. A list applied half
    // way and then refused is the worst of both: the model cannot tell what landed, and the
    // parameter mistake behind it is usually in an entry it has not looked at yet.
    for (index, entry) in entries.iter().enumerate() {
        // The parameter contract, checked here rather than in GDScript. Four domains are forwarded
        // to the addon as raw JSON, so before this the first thing to examine a value's shape was
        // `Protocol.decode`, in the editor, across a socket — and its answer reached the model as
        // one flattened sentence with no example in it. See `tool_params`.
        entry
            .operation
            .check(&entry.params)
            .map_err(|failure| the_whole_file(domain.name, entry.op(), failure))
            .map_err(|failure| entry.blamed(index, entries.len(), failure))?;

        // A game the debugger started is not one the editor is playing, so `runtime.run`'s own
        // guard cannot see it. Answered here, where both are known.
        if domain.name == "godot_runtime" {
            refuse_a_second_game(entry.op(), crate::debug::holds_a_game())
                .map_err(|failure| entry.blamed(index, entries.len(), failure))?;
        }

        // The user's rules are answered before the user's approvals, because a rule they already
        // answered is not a question to ask them again: `game_embed_mode` is gated below, and a
        // prompt offering to undo a ticked box is a worse outcome than a refusal.
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
    refuse_a_list_that_holds_a_lone_operation(domain, &entries)?;

    // The safety model sits between validation and the operation. A call the router would refuse
    // anyway is never worth a prompt, and a path outside the worktree is rejected here rather than
    // offered for approval, so no dialog can ever propose writing outside the task's own tree.
    let mut gated: Vec<approvals::GatedCall> = Vec::new();
    for entry in &entries {
        let Some(reason) = entry.operation.gate() else {
            continue;
        };
        reject_outside_paths(app, entry.operation, &entry.params)?;
        gated.push(approvals::GatedCall {
            op: entry.op().to_owned(),
            reason,
            params: entry.params.clone(),
        });
    }
    // One prompt for the whole call. Asked per entry, a list of ten deletions would reach the user
    // as ten dialogs, of which they could only refuse the ones they had already been shown.
    approvals::require(app, domain.name, &gated)?;

    run_in_order(entries, |operation, params| {
        starting_the_session_if_there_is_none(
            domain,
            params,
            |params| run_one(app, domain, operation, params),
            || {
                godot_session_api::start_session(app, StartGodotSessionRequest {})
                    .map(|_| ())
                    .map_err(ToolFailure::from)
            },
        )
    })
}

/// Tells the editor's filesystem about GDScript this call just wrote.
///
/// `godot_script` writes through the language server, which is a different door from every other
/// write in this router: `create_texture`, `create_shape` and the scene commands all end in
/// `EditorFileSystem.update_file`, and a script never did. The consequence is not the file being
/// invisible — the server reads it perfectly well — it is that **a `class_name` written this
/// session does not exist for anything else**.
///
/// Measured against the pinned 4.7.2, in this order:
///
/// * save `coin.gd` declaring `class_name Coin`, then save a script typing `Coin` →
///   `Could not find type "Coin" in the current scope.`
/// * reopen the second script, which re-reads it from disk and re-parses → still refused.
/// * a whole-project `rescan` with no path → still refused, and it reported no paths at all.
/// * `rescan` naming `coin.gd` → the next script typing `Coin` saves with **no diagnostics**.
///
/// So the missing step is naming the file, and `resource.rescan` is where that already lives. It
/// is `update_file` for a `.gd`: nothing about a script is importable, so `_import_batch` registers
/// it and returns without waiting for anything.
///
/// The failure is swallowed on purpose. The write has already happened and is already answered; a
/// caller told the save failed would write it again, and the thing that went wrong is a
/// registration it cannot do anything about. What it costs is the state this function exists to
/// prevent, which is where the project was before it.
fn told_the_editor_about<R: Runtime>(app: &AppHandle<R>, paths: Vec<String>) {
    if paths.is_empty() {
        return;
    }
    let _ = godot_session_api::call_godot(
        app,
        CallGodotRequest {
            command: "resource.rescan".to_owned(),
            params: json!({"path": paths}),
            expected_revision: None,
            expected_scene: None,
            timeout_ms: None,
        },
    );
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
///
/// The operation is the catalogue's own row, resolved once as the entry is read. Everything that
/// follows — the repair, the check, the rule, the gate, the narrowing, the route — is a question
/// asked of that row rather than a seventh lookup by the same two strings.
#[derive(Clone, Debug)]
struct Requested {
    operation: &'static Operation,
    params: Value,
}

impl Requested {
    /// The operation's name, which is the row's.
    fn op(&self) -> &'static str {
        self.operation.op
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
    let Some(operation) = domain.operation(&op) else {
        return Err(ToolFailure::new(
            "unknown_operation",
            format!("{} has no '{op}' operation", domain.name),
        ));
    };
    // `op` names the entry; it is not one of the operation's parameters. It is taken out here
    // rather than tolerated downstream, because four domains are forwarded to the addon as raw
    // JSON and the addon refuses a parameter no handler reads — which is what a real editor
    // answered to `session.get_state has no `op` parameter`.
    let mut params = entry.clone();
    if let Some(object) = params.as_object_mut() {
        object.remove("op");
    }
    Ok(Requested { operation, params })
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
        let Some((scope, reason)) = entry.operation.sharing() else {
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
                        entry.op(),
                        entries.len()
                    ),
                    retryable: false,
                    details: json!({"op": entry.op(), "opIndex": index}),
                });
            }
            // Only a later twin is named. The first entry of a pair is the one the caller keeps,
            // so pointing at it would ask for the wrong edit.
            Sharing::Repeat => {
                if let Some(again) = entries
                    .iter()
                    .skip(index + 1)
                    .position(|later| later.op() == entry.op())
                {
                    let again = index + 1 + again;
                    return Err(ToolFailure {
                        code: "op_repeated".to_owned(),
                        message: format!(
                            "{}.{} is in this call twice, at `ops[{index}]` and `ops[{again}]`. \
                             {reason} Drop the second one; the rest of the list is fine.",
                            domain.name,
                            entry.op()
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
    mut step: impl FnMut(&'static Operation, Value) -> Result<Value, ToolFailure>,
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
                "op": entry.op(),
                "skipped": "an earlier entry failed, so this was not run",
                "because": failure.code,
            }));
            continue;
        }
        let params = expecting_what_the_last_entry_produced(&entry, revision);
        match step(entry.operation, params) {
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

/// One operation, routed to the handler the renderer uses for the same thing.
fn run_one<R: Runtime>(
    app: &AppHandle<R>,
    domain: &ToolDomain,
    operation: &Operation,
    params: Value,
) -> Result<Value, ToolFailure> {
    let op = operation.op;
    // What answers this operation is a fact about the operation, so it is read off the operation
    // rather than rebuilt from its name. The router used to spell the addon command with
    // `format!("scene.{op}")` and keep a hand-written exception list wherever a domain was only
    // partly the addon's — `session.start|stop|status` and `resource.list|move|delete` — and two
    // drift tests in this file re-derived the same arithmetic and the same exceptions a second and
    // a third time. `params.json` had carried the mapping as data the whole time.
    match operation.route() {
        tool_params::Answers::Addon(command) => {
            a_path_that_climbs_out(&params)?;
            let answered = rpc(app, command, params);
            // An autoload is a global name, and every script the language server already has open
            // was parsed without it. Nothing about those documents changed, so the server never
            // revisits them and their diagnostics keep naming a global that now exists. Done here
            // rather than in the addon because the language server is this process's connection,
            // and only after the command was accepted — a refused autoload changed nothing.
            if answered.is_ok()
                && matches!(command, "project.set_autoload" | "project.remove_autoload")
            {
                crate::script::reparse_open_documents();
            }
            if domain.name == "godot_runtime" {
                // A game that broke does not die, so a runtime call that failed has to carry the
                // error that ended it rather than the transport's own.
                return answered.map_err(|error| {
                    godot_session::carrying_the_error_that_ended_the_game(error.into())
                });
            }
            Ok(answered?)
        }
        tool_params::Answers::Rust => {
            through_the_read_ledger(app, operation, params, |params| match domain.name {
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

/// Everything the read ledger asks of one file-touching operation, in one wrapper.
///
/// Five steps used to be re-enacted per arm: fill in `expectedHash` on the way in, reconcile the
/// answer on the way out, forget a path that is gone, carry a moved path's record with it, and drop
/// a record that outlived its file when the refusal says there is nothing there. No arm enacted all
/// five. `script_domain`'s save enacted three, `resource_domain`'s delete two and its move one, and
/// every other file-touching arm one — and not one omission failed a test, because each step is
/// invisible except through the next call that is refused for it.
///
/// So the router applies it, and a new domain arm inherits the whole ritual without knowing any of
/// it exists. Which operations it covers is the operation's own row: one that declares a path is
/// one that touches a file, and one that declares a [`tool_params::Kind::Hash`] parameter is one
/// the ledger can fill in — a gated destructive operation added later is held to the hash its own
/// row asks for, rather than to whichever arm remembered to ask.
///
/// The other end of it is [`crate::read_ledger::reconcile`], which reads what became of the file
/// out of the answer instead of being told twice.
fn through_the_read_ledger<R: Runtime>(
    app: &AppHandle<R>,
    operation: &Operation,
    params: Value,
    run: impl FnOnce(Value) -> Result<Value, ToolFailure>,
) -> Result<Value, ToolFailure> {
    if !touches_a_file(operation) {
        return run(params);
    }
    let params = if operation
        .params
        .iter()
        .any(|param| param.kind == tool_params::Kind::Hash)
    {
        with_remembered_hash(app, params)
    } else {
        params
    };
    let named = paths_named(operation, &params);
    match run(params) {
        Ok(answer) => Ok(reconciled(app, answer)),
        Err(failure) => {
            for path in &named {
                forget_a_vanished_file(app, path, &failure);
            }
            Err(failure)
        }
    }
}

/// Whether an operation names a file at all, which is what the ledger keys on.
///
/// Read off the parameters rather than listed: `under` counts, because a listing is the read that
/// fills the ledger for every file it reports.
fn touches_a_file(operation: &Operation) -> bool {
    fn anywhere(params: &[tool_params::Param]) -> bool {
        params
            .iter()
            .any(|param| names_a_path(param.name) || anywhere(param.entry))
    }
    anywhere(operation.params)
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
/// turn writes `res://assets` as readily as `assets`, and both mean the same folder. The scheme is
/// off before this sees it now — `under` is a path the operation declares, so the router normalises
/// it with every other one — and the trim stays as the backstop it always was.
///
/// The root is no directory at all, and that is what `None` says. `res://`, `/` and `.` all come
/// out of the trimming with nothing left, and nothing was matched as a prefix against every
/// worktree-relative path — so `godot_resource list` and `godot_script list` answered
/// `{"files": []}` about a worktree full of files. `res://` is the spelling a model reaching for
/// the whole project writes, precisely because this helper accepts it everywhere else.
fn named_directory(named: &str) -> Option<String> {
    let trimmed = named
        .trim()
        .trim_start_matches("res://")
        .trim_matches('/')
        .trim();
    (!trimmed.is_empty() && trimmed != ".").then(|| trimmed.to_owned())
}

/// Whether a path is Gofer's own staged addon rather than anything in the project.
///
/// `addons/gofer` is not the user's code and Gofer says so itself: it stages the directory into the
/// worktree on session start and writes `addons/gofer/` into the checkout's Git exclude file, under
/// the marker "the managed Godot addon is never part of the project". Listing it contradicts that,
/// and it is the *first* thing most turns read — ten of the sixteen entries in a bare fixture's
/// listing are it.
///
/// The cost is not the bytes. A live turn stuck on a runtime call that would not answer stopped
/// working on the game and spent four subagent calls reading `addons/gofer/runtime.gd` to work out
/// why — debugging Gofer instead of the thing it was asked to build, down a road it only knew about
/// because the listing named it. A file nobody may usefully change does not belong in the answer to
/// "what is in this project".
fn is_goferns_own(path: &str) -> bool {
    path == crate::addon::ADDON_DIRECTORY
        || path.starts_with(&format!("{}/", crate::addon::ADDON_DIRECTORY))
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
            // Hashing is asked for rather than always done: a worktree holds game assets, and
            // hashing every texture and every sound to answer "what files are there" would read
            // the whole project on a call the agent makes to orient itself.
            //
            // One directory, the way `godot_script list` takes one. A live turn asked for
            // `{"op": "list", "path": "assets"}` — the wrong key, and there was no right one — and
            // fell back to `bash find`. The whole-project answer averages fourteen thousand
            // characters and has been truncated, which is a lot to pay to see one folder.
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
            // Reconciled like every other answer that carries stamps — by the router, on the way
            // out. The hashes go into the ledger and out of the answer: the hash is the router's to
            // hold and the caller's never to carry, so printing it is noise the model pays for and
            // cannot spend on anything.
            Ok(json!({"files": files}))
        }
        // The typed destructive pair. Both reach the same `Workspace` the renderer's own
        // `move_workspace_path` and `delete_workspace_path` commands use, so canonical-path
        // validation and the hash check are the workspace's, not a second copy of them.
        "move" => {
            let request: files::MovePathRequest = from_params(params)?;
            let workspace = crate::active_workspace(app)?;
            workspace.move_path(&request.from, &request.to)?;
            tell_the_editor_the_worktree_moved(app);
            Ok(json!({"from": request.from, "to": request.to, "moved": true}))
        }
        "delete" => {
            let request: files::DeletePathRequest = from_params(params)?;
            let workspace = crate::active_workspace(app)?;
            workspace.delete(&request.path, request.expected_hash.as_deref())?;
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
fn reject_outside_paths<R: Runtime>(
    app: &AppHandle<R>,
    operation: &Operation,
    params: &Value,
) -> Result<(), ToolFailure> {
    let named = paths_named(operation, params);
    if named.is_empty() {
        return Ok(());
    }
    let workspace = crate::active_workspace(app)?;
    for path in &named {
        workspace.resolve(path)?;
    }
    Ok(())
}

/// Rewrites `res://…` into the worktree-relative path the file tools take, once, for every
/// operation the desktop answers itself.
///
/// Two conventions meet in this catalog and neither is wrong: the editor names a file the way Godot
/// does, `res://scripts/mario.gd`, and everything that reaches the filesystem names it the way the
/// worktree does, `scripts/mario.gd`. A model has no way to know which domain wants which, and it
/// reaches for `res://` because that is what it just used to build the scene — then `godot_script
/// open` answers that the file does not exist, about a file it wrote a moment ago. The mapping is
/// exact, so it is done here rather than explained. Confinement is untouched: what is left after
/// the prefix is still a relative path, so `res://../secrets` is refused exactly as `../secrets` is.
///
/// It runs in `dispatch_under`, beside [`Operation::repair`] and before anything is held to the
/// parameters, because an arm that has to remember to call it is an arm that can forget to.
/// `script_domain` and `debug_domain` called it; `resource_domain` never did, and nothing failed —
/// `files::validate_relative` strips the scheme too, so an unnormalised `delete` reached the right
/// file while [`crate::read_ledger`], which keys on the string the caller wrote, missed every
/// record for it. The delete then ran with no hash to be held to at all.
///
/// Which parameters are paths is the operation's own row rather than a list kept here: a name the
/// table declares as a path is rewritten wherever it sits, including inside the `entry` shape a
/// list of files declares, so a new operation inherits this by declaring its parameters.
///
/// Only the operations [`tool_params::Answers::Rust`] answers. Everything routed to the addon is
/// forwarded verbatim and the addon names files the way Godot does — `_as_resource_path` puts the
/// scheme back on a worktree-relative path, and `project.set_autoload` refuses a path that does not
/// carry it, because that string is written into `project.godot` for the engine to load.
fn as_the_worktree_names_them(operation: &Operation, params: &mut Value) {
    if operation.route() != tool_params::Answers::Rust {
        return;
    }
    let Some(object) = params.as_object_mut() else {
        return;
    };
    for param in operation.params {
        if let Some(value) = object.get_mut(param.name) {
            worktree_relative(param, value);
        }
    }
}

/// One declared parameter, and everything the table says lives inside it.
fn worktree_relative(param: &tool_params::Param, value: &mut Value) {
    if names_a_path(param.name) {
        // `path` is one name or a list of them wherever a batch is accepted, so both shapes are
        // rewritten. A list of anything else is left alone: only a string carrying the scheme is
        // touched.
        match value.as_array_mut() {
            Some(entries) => entries.iter_mut().for_each(strip_the_scheme),
            None => strip_the_scheme(value),
        }
    }
    match param.entry {
        // The inside is written down, so it is walked as a parameter list of its own: `files` on
        // `godot_script edit` and `breakpoints` on `godot_debug launch` each carry a `path`.
        [_, ..] => {
            for entry in entries_of(value) {
                let Some(fields) = entry.as_object_mut() else {
                    continue;
                };
                for inner in param.entry {
                    if let Some(held) = fields.get_mut(inner.name) {
                        worktree_relative(inner, held);
                    }
                }
            }
        }
        // The inside is not written down — `apply_rename` takes back the list `rename` answered
        // with — so the keys that name a path are honoured wherever they appear in it.
        [] if value.is_array() || value.is_object() => wherever_a_key_names_a_path(value),
        [] => (),
    }
}

/// The entries of a list parameter, or the single object one that is not a list.
fn entries_of(value: &mut Value) -> &mut [Value] {
    match value {
        Value::Array(entries) => entries.as_mut_slice(),
        other => std::slice::from_mut(other),
    }
}

fn strip_the_scheme(value: &mut Value) {
    if let Some(path) = value.as_str().and_then(|path| path.strip_prefix("res://")) {
        *value = Value::String(path.to_owned());
    }
}

/// The same rewrite through a shape the table does not describe, keyed on the names it does.
fn wherever_a_key_names_a_path(value: &mut Value) {
    match value {
        Value::Array(entries) => entries.iter_mut().for_each(wherever_a_key_names_a_path),
        Value::Object(fields) => {
            for (key, held) in fields.iter_mut() {
                if names_a_path(key) {
                    strip_the_scheme(held);
                }
                wherever_a_key_names_a_path(held);
            }
        }
        _ => (),
    }
}

/// The worktree-relative paths one call names, read off the operation's own row.
///
/// Only the parameters that carry a path as a string: a list of files and a nested `path` are the
/// answer to a different question, and the two callers here — the outside-worktree rejection and
/// the vanished-record drop — each act on one file at a time.
fn paths_named(operation: &Operation, params: &Value) -> Vec<String> {
    let Some(object) = params.as_object() else {
        return Vec::new();
    };
    operation
        .params
        .iter()
        .filter(|param| names_a_path(param.name))
        .filter_map(|param| object.get(param.name).and_then(Value::as_str))
        .map(str::to_owned)
        .collect()
}

/// Refuses a call carrying a path that climbs out of the project, before it reaches the addon.
///
/// The editor names files `res://…`, and `res://../` is a real path: Godot resolves it out of the
/// project and follows it. Measured against the pinned 4.7.2 editor — `Image.save_png` wrote
/// `res://../escaped.png` and `ResourceSaver.save` wrote `res://../escaped.tres`, both one
/// directory above the project, both answering OK.
///
/// The file and script tools have their own confinement and this is not it. Everything routed by
/// [`crate::tool_params::Answers::Addon`] is forwarded to the addon verbatim, so the writers that
/// live there — `resource.create_texture`, `create_shape`, `create_tileset` — had no gate on the
/// way at all, under a catalogue that describes their domain as one where "nothing outside the
/// task worktree can be named at all".
///
/// A `..` inside a *path* is what is refused, not a `..` inside a value: a Label's `text` may say
/// anything, so a string counts as a path only when it carries the scheme or a separator.
fn a_path_that_climbs_out(params: &Value) -> Result<(), ToolFailure> {
    fn climbing<'a>(under: &str, value: &'a Value) -> Option<&'a str> {
        match value {
            Value::String(text) => climbs(under, text).then_some(text.as_str()),
            Value::Array(items) => items.iter().find_map(|item| climbing(under, item)),
            Value::Object(fields) => fields.iter().find_map(|(key, held)| climbing(key, held)),
            _ => None,
        }
    }
    match climbing("", params) {
        None => Ok(()),
        Some(text) => Err(ToolFailure::new(
            "outside_workspace",
            format!(
                "{text} climbs out of the project. Every path here names a file inside the task \
                 worktree, spelled the way the project spells it — assets/tiles.png, or \
                 res://assets/tiles.png — and a `..` segment is refused wherever it appears."
            ),
        )),
    }
}

/// The keys whose value is a file, so that a `..` in one is a path climbing and not prose.
///
/// A node's `text` may say anything, `../docs/readme` included, and refusing that would be this
/// gate inventing a rule nobody has. A string that carries the scheme is a path wherever it sits,
/// and everything else has to be named here. `path` covers the nested one a resource value holds:
/// `{"type": "resource", "value": {"path": "res://…"}}` arrives under that key like any other.
const A_KEY_THAT_NAMES_A_FILE: [&str; 8] = [
    "path", "paths", "texture", "scene", "file", "files", "from", "to",
];

/// A directory a listing narrows to, which is a path spelled the way a file is.
///
/// Beside the file keys rather than inside them because it names a folder rather than a file, and
/// the two questions asked of both — is this string a path, and does it carry the scheme — have
/// one answer. `named_directory` took the scheme off itself for as long as this was the only key
/// nothing else reached.
const A_KEY_THAT_NAMES_A_DIRECTORY: &str = "under";

/// Whether a key names a path at all: a file the worktree holds, or a directory inside it.
fn names_a_path(key: &str) -> bool {
    key == A_KEY_THAT_NAMES_A_DIRECTORY || A_KEY_THAT_NAMES_A_FILE.contains(&key)
}

/// Whether a string is a path, and climbs.
fn climbs(under: &str, text: &str) -> bool {
    let (path, schemed) = match text
        .strip_prefix("res://")
        .or_else(|| text.strip_prefix("user://"))
    {
        Some(rest) => (rest, true),
        None => (text, false),
    };
    if !schemed && !names_a_path(under) {
        return false;
    }
    path.split('/').any(|segment| segment == "..") || (!schemed && path == "..")
}

/// Keeps this domain to the files it is for.
///
/// `save` writes whatever path it is given, and the language server behind it only knows GDScript.
/// A live agent used it to write a `.tscn` by hand rather than build the scene with the node tools:
/// the text landed under an editor that had its own copy of that scene open, outside the undo stack
/// and outside the revision guard, in a layout Godot's own writer would never produce. A scene is
/// the editor's to write, so anything that is not a script is refused with the tool that owns it.
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
    match op {
        // Answered from the worktree walk rather than the language server, which knows only the
        // documents something opened. A model that cannot see the scripts reaches for `bash find`,
        // and the workspace refuses the absolute path it writes.
        "list" => {
            // Matched as a prefix of the relative path rather than resolved: a path that resolves
            // is a path that can leave the worktree.
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
                answers.push(answered);
            }
            Ok(one_or_many(answers, batched))
        }
        "update" => {
            require_script_path(&params)?;
            Ok(to_value(script::update_document(from_params(params)?)?))
        }
        // The hash the agent's own last read answered with is supplied by the router, not copied
        // by the model, and a record that outlived its file is dropped there too. See
        // `through_the_read_ledger` and `crate::read_ledger`.
        "save" => {
            require_script_path(&params)?;
            let path = params
                .get("path")
                .and_then(Value::as_str)
                .map(str::to_owned);
            let saved = to_value(script::save_and_publish(from_params(params)?)?);
            told_the_editor_about(app, path.into_iter().collect());
            Ok(saved)
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
            let written: Vec<String> = request.files.iter().map(|file| file.path.clone()).collect();
            let edited = json!({"files": to_value(script::edit_documents(request)?)});
            told_the_editor_about(app, written);
            Ok(edited)
        }
        "apply_rename" => {
            let request: script::ApplyRenameRequest = from_params(params)?;
            // The same guard `save` and `edit` carry, and for the same reason: this writes whole
            // files, and a plan written by hand can name any path at all. A rename planned by the
            // language server only ever names GDScript.
            for file in &request.files {
                require_script_path(&json!({"path": file.path}))?;
            }
            // Through the ledger like every other file-touching arm — the router's, on the way
            // out. Renaming rewrites the files it names, so the hashes recorded for them are claims
            // about text that is gone: the next save over one was refused `file_conflict`, and the
            // model cannot clear a hash it is never shown.
            let written: Vec<String> = request.files.iter().map(|file| file.path.clone()).collect();
            let renamed = json!({"files": to_value(script::apply_rename(request)?)});
            told_the_editor_about(app, written);
            Ok(renamed)
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
    let request: DebugRequest = from_tagged_params(op, params)?;
    Ok(to_value(debug::call(request)?))
}

/// Reads log lines until the caller's limit is filled with lines a model can read.
///
/// The page is filtered after the buffer applies the limit, so one page of two hundred can come
/// back as forty once the editor's own terminal output is out of it — and forty lines where two
/// hundred were asked for reads as "there is no more", which is the one thing it must not mean.
/// So the pages are read forward until the limit is met or the buffer runs out.
///
/// The cursor answered is the one that continues from the last line actually handed over, never
/// from a line read past it: `after` takes a sequence, and every entry carries its own.
fn logs_domain(params: Value) -> Result<Value, ToolFailure> {
    let mut query: LogQuery = from_params(params)?;
    // The buffer's own defaults, applied here as well: without them a call naming no limit would
    // read the whole buffer rather than a page of it.
    let wanted = query
        .limit
        .unwrap_or(godot_session::DEFAULT_LOG_PAGE)
        .clamp(1, godot_session::MAX_LOG_PAGE);
    // Read in whole pages whatever the caller asked for, and take `wanted` readable lines out of
    // them. A `limit: 5` over a stretch of import output would otherwise take a lock per five
    // lines walked; the buffer is scanned in memory, so a page costs the same as five.
    query.limit = Some(godot_session::MAX_LOG_PAGE);
    let mut kept: Vec<Value> = Vec::new();
    let mut omitted = 0;
    let first = godot_session::read_logs(&query)?;
    let dropped = first.dropped;
    let mut cursor = first.cursor;
    let mut page = first;
    loop {
        let counted = page.entries.len();
        for entry in page.entries {
            if kept.len() >= wanted {
                break;
            }
            cursor = entry.sequence;
            match a_line_a_model_can_read(&entry) {
                Some(line) => kept.push(line),
                None => omitted += 1,
            }
        }
        if counted == 0 || kept.len() >= wanted {
            break;
        }
        query.after = Some(cursor);
        page = godot_session::read_logs(&query)?;
    }
    Ok(json!({
        "entries": kept,
        "cursor": cursor,
        "dropped": dropped,
        "terminalLinesOmitted": omitted,
    }))
}

/// One line with the terminal's own control codes taken out of it.
///
/// The editor writes to a terminal and colours what it writes. `\u{1b}[90m\u{1b}[1mfirst_scan…`
/// is one line of Godot's import progress, and a third of that line is the escapes. Written
/// without the `regex` crate, which this binary does not carry: an escape here is always
/// `ESC [ … letter`, the CSI form, which is all a terminal colour is.
fn without_terminal_colour(line: &str) -> String {
    let mut plain = String::with_capacity(line.len());
    let mut rest = line.chars();
    while let Some(character) = rest.next() {
        if character != '\u{1b}' {
            plain.push(character);
            continue;
        }
        // `ESC [` then the parameters, then the letter that ends it. An `ESC` that begins nothing
        // is dropped on its own, which is what a terminal does with it.
        if rest.next() != Some('[') {
            continue;
        }
        for parameter in rest.by_ref() {
            if parameter.is_ascii_alphabetic() {
                break;
            }
        }
    }
    plain
}

/// Whether this line is the editor's own progress bar rather than anything about the project.
///
/// `EditorProgress` prints `[  16% ] first_scan_filesystem | Scanning file structure...` and
/// `[ DONE ] save` to standard output, and both are a terminal drawing itself. **159 of the 655 log
/// entries in the recorded corpus are these**, 22,653 characters of 102,196 — more than a fifth of
/// everything `godot_logs read` has ever handed a model. Nothing in one is actionable: an import
/// that fails prints an `ERROR`, and a save that worked is answered by the save.
fn is_the_editors_progress_bar(line: &str) -> bool {
    let Some(bracketed) = line.strip_prefix('[') else {
        return false;
    };
    let Some((inside, _)) = bracketed.split_once(']') else {
        return false;
    };
    // Godot right-aligns the number in a fixed field, so the brackets always hold exactly six
    // characters: `[   0% ]`, `[  16% ]`, `[ 100% ]`, `[ DONE ]`. Held to that width so a game
    // printing `[ 50% ] loading` of its own is not read as the editor's.
    if inside.chars().count() != 6 {
        return false;
    }
    let inside = inside.trim();
    inside == "DONE"
        || inside
            .strip_suffix('%')
            .is_some_and(|number| !number.is_empty() && number.bytes().all(|b| b.is_ascii_digit()))
}

/// The log page, with what only a terminal can use taken out of it, and a count of what went.
///
/// Three things, measured over the 655 entries the recorded live runs read back: the escape codes
/// are 7.5% of them, the lines that are nothing but escape codes are 3.7%, and the editor's own
/// progress bar is 22%. Together they are a third of every character `godot_logs read` answers
/// with, and `godot_logs read` is 18% of everything the model reads back from any tool.
///
/// Counted rather than silently dropped, and only here: the renderer reads the same buffer through
/// [`godot_session::read_logs`] and shows the user their editor's output as their editor wrote it.
fn a_line_a_model_can_read(entry: &godot_session::LogEntry) -> Option<Value> {
    let message = without_terminal_colour(&entry.message);
    if message.trim().is_empty() || is_the_editors_progress_bar(message.trim()) {
        return None;
    }
    Some(json!({
        "sequence": entry.sequence,
        "source": entry.source,
        "severity": entry.severity,
        "message": message,
        "timestamp": entry.timestamp,
    }))
}

/// The same question asked of a whole page, which is what the tests drive.
#[cfg(test)]
fn what_a_model_can_read(entries: Vec<godot_session::LogEntry>) -> (Vec<Value>, usize) {
    let mut kept = Vec::with_capacity(entries.len());
    let mut omitted = 0;
    for entry in entries {
        match a_line_a_model_can_read(&entry) {
            Some(line) => kept.push(line),
            None => omitted += 1,
        }
    }
    (kept, omitted)
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

/// Sends one addon command through the same session API the renderer's `call_godot` uses.
/// `expectedRevision` and `timeoutMs` are lifted out of the parameters: every scene mutation
/// carries a revision, and the wire format keeps it beside the command rather than inside it.
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

    /// One entry of a `godot_scene` call, resolved the way the router resolves one.
    fn requested(op: &str, params: Value) -> Requested {
        Requested {
            operation: scene_domain()
                .operation(op)
                .unwrap_or_else(|| panic!("godot_scene offers {op}")),
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
            vec![
                requested("save", json!({})),
                requested("reload", json!({})),
                requested("save_as", json!({"path": "b.tscn"})),
            ],
            |operation, _| {
                ran.borrow_mut().push(operation.op.to_owned());
                if operation.op == "reload" {
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
            |operation, params| {
                seen.borrow_mut()
                    .push((operation.op.to_owned(), params["expectedRevision"].clone()));
                Ok(json!({"revision": if operation.op == "save" { 7 } else { 9 }}))
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

    /// Every operation that names a path takes it either way, and takes it at the router.
    ///
    /// The catalog mixes two path conventions because Godot does: a scene is `res://main.tscn` and
    /// a script is `scripts/main.gd`. A model reaches for the one it just used, so `godot_script
    /// open` was told a file it had written a moment earlier did not exist.
    ///
    /// A table test over the whole catalogue, because the failure it replaces was never a path that
    /// came out wrong. The rewrite worked; it was three arms that called it and a fourth that did
    /// not, and the test that stood here called the rewrite as a pure function and asserted nothing
    /// about which arms applied it. `resource_domain` was the arm that did not, and nothing failed:
    /// `files::validate_relative` strips the scheme too, so the delete reached the right file and
    /// only the read ledger — keyed on the string the caller wrote — could tell. So the assertion
    /// is the table: every operation that declares a path, whichever domain adds it next.
    #[test]
    fn every_operation_that_names_a_path_takes_it_either_way() {
        /// The parameter as the router hands it to the arm, resolved off the catalogue's own row.
        fn normalised(tool: &str, op: &str, params: Value) -> Value {
            let operation = crate::tool_params::operation_of(tool, op)
                .unwrap_or_else(|| panic!("{tool}.{op} is a catalogue operation"));
            let mut params = params;
            as_the_worktree_names_them(operation, &mut params);
            params
        }

        let mut checked = 0;
        for domain in CATALOG {
            for operation in domain.operations {
                // Everything the addon answers is forwarded verbatim, and the addon names a file
                // the way Godot does — `_as_resource_path` puts the scheme back on a
                // worktree-relative path, and `project.set_autoload` refuses one without it.
                let worktree = operation.route() == crate::tool_params::Answers::Rust;
                let expected = |named: &str| {
                    if worktree {
                        format!("levels/{named}")
                    } else {
                        format!("res://levels/{named}")
                    }
                };
                for param in operation.params {
                    if names_a_path(param.name)
                        && matches!(
                            param.kind,
                            crate::tool_params::Kind::Text | crate::tool_params::Kind::Either(_)
                        )
                    {
                        let answered = normalised(
                            domain.name,
                            operation.op,
                            json!({param.name: "res://levels/level.tscn"}),
                        );
                        assert_eq!(
                            answered[param.name],
                            json!(expected("level.tscn")),
                            "{} {} `{}`",
                            domain.name,
                            operation.op,
                            param.name
                        );
                        // A worktree-relative path is left exactly as it is, either way round.
                        let untouched = normalised(
                            domain.name,
                            operation.op,
                            json!({param.name: "levels/level.tscn"}),
                        );
                        assert_eq!(
                            untouched[param.name], "levels/level.tscn",
                            "{} {} `{}`",
                            domain.name, operation.op, param.name
                        );
                        checked += 1;
                    }
                    // The nested paths a list of files carries: `godot_script edit`'s `files` and
                    // `godot_debug launch`'s `breakpoints` both name one per entry.
                    for inner in param.entry {
                        if !names_a_path(inner.name) {
                            continue;
                        }
                        let answered = normalised(
                            domain.name,
                            operation.op,
                            json!({param.name: [{inner.name: "res://levels/level.tscn"}]}),
                        );
                        assert_eq!(
                            answered[param.name][0][inner.name],
                            json!(expected("level.tscn")),
                            "{} {} `{}[].{}`",
                            domain.name,
                            operation.op,
                            param.name,
                            inner.name
                        );
                        checked += 1;
                    }
                }
            }
        }
        assert!(
            checked > 30,
            "the catalogue declares more paths than this walked: {checked}"
        );

        // A batched call names its scripts as a list, and each one still meets the editor's
        // convention or the worktree's.
        let batched = normalised(
            "godot_script",
            "open",
            json!({"path": ["res://scripts/a.gd", "scripts/b.gd"]}),
        );
        assert_eq!(batched["path"][0], "scripts/a.gd");
        assert_eq!(batched["path"][1], "scripts/b.gd");

        // `apply_rename` takes back the list `rename` answered with, and the catalogue does not
        // write down what one entry holds — so the keys that name a path are honoured wherever they
        // appear in it.
        let renamed = normalised(
            "godot_script",
            "apply_rename",
            json!({"files": [{"path": "res://scripts/a.gd", "updatedText": "extends Node\n"}]}),
        );
        assert_eq!(renamed["files"][0]["path"], "scripts/a.gd");
        assert_eq!(renamed["files"][0]["updatedText"], "extends Node\n");

        // A directory a listing narrows to is a path spelled the same way, and it reaches
        // `named_directory` already stripped.
        assert_eq!(
            normalised("godot_resource", "list", json!({"under": "res://assets"}))["under"],
            "assets"
        );

        // Stripping the prefix must not become a way out of the worktree: what is left is still a
        // relative path, and a relative path that climbs is refused where every other one is.
        assert_eq!(
            normalised(
                "godot_script",
                "open",
                json!({"path": "res://../secrets.gd"})
            )["path"],
            "../secrets.gd"
        );
        // An operation the addon answers never meets that confinement — it is forwarded verbatim.
        // Measured against the pinned editor: `Image.save_png("res://../escaped.png")` and
        // `ResourceSaver.save(shape, "res://../escaped.tres")` both wrote one directory above the
        // project and both answered OK, under a catalogue that says nothing outside the task
        // worktree can be named at all.
        for climbing in [
            json!({"path": "res://../escaped.png"}),
            json!({"path": "../escaped.png"}),
            json!({"path": "assets/../../escaped.png"}),
            json!({"path": "user://../escaped.png"}),
            json!({"texture": "res://a.png", "tiles": ["res://../x.png"]}),
            json!({"properties": [{"value": {"type": "resource", "value": {"path": "res://../x.tres"}}}]}),
        ] {
            let refused = a_path_that_climbs_out(&climbing).expect_err("a climbing path");
            assert_eq!(refused.code, "outside_workspace", "{climbing}");
        }
        // And a `..` that is not a path is a value like any other. A node's `text` may say
        // anything, `../docs/readme` included, and refusing that would be this gate inventing a
        // rule nobody has — so a bare string is only read as a path under a key that names a file.
        for ordinary in [
            json!({"path": "res://assets/tiles.png"}),
            json!({"value": {"type": "string", "value": "Loading.."}}),
            json!({"properties": [{"property": "text", "value": {"type": "string", "value": "see ../docs/readme"}}]}),
            json!({"name": "a..b"}),
            json!({"query": "physics/2d/default_gravity"}),
        ] {
            assert!(a_path_that_climbs_out(&ordinary).is_ok(), "{ordinary}");
        }
        // The scheme makes it a path wherever it sits, key or no key.
        assert!(
            a_path_that_climbs_out(&json!({
                "properties": [{"value": {"type": "string", "value": "res://../secrets"}}]
            }))
            .is_err(),
        );

        let directory = tempfile::TempDir::new().expect("temporary directory");
        let workspace = crate::files::Workspace::open(directory.path()).expect("open workspace");
        assert!(
            workspace.resolve("../secrets.gd").is_err(),
            "a path that climbs out of the worktree must still be refused"
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

    /// The editor's terminal drawing itself is not something a model can read.
    ///
    /// Measured over the 655 log entries the recorded live runs read back: the escape codes are
    /// 7.5% of them, the lines that are nothing but escape codes are 3.7%, and the progress bar is
    /// 22%. The lines below are real ones out of `logs/oxloop`.
    #[test]
    fn the_editors_terminal_colour_and_progress_bar_do_not_reach_the_model() {
        let escape = char::from(27);
        let line = |sequence: u64, message: &str| godot_session::LogEntry {
            sequence,
            source: godot_session::LogSource::Editor,
            severity: godot_session::LogSeverity::Info,
            message: message.to_owned(),
            timestamp: 1_787_680_547_282,
        };
        let (kept, omitted) = what_a_model_can_read(vec![
            line(
                1,
                &format!(
                    "[  16% ] {escape}[90m{escape}[1mfirst_scan_filesystem{escape}[22m | Scanning \
                     file structure...{escape}[39m{escape}[0m"
                ),
            ),
            line(
                2,
                &format!("{escape}[92m[ DONE ]{escape}[39m {escape}[1msave{escape}[22m"),
            ),
            line(3, &format!("{escape}[0m")),
            line(4, ""),
            line(
                5,
                &format!("{escape}[1mSCRIPT ERROR:{escape}[0m Parse Error: Identifier not found"),
            ),
            line(6, "[player] hit right window edge after 580.1 px"),
            // A game printing its own progress in the same shape, but not in the editor's fixed
            // six-character field. Kept.
            line(7, "[ 50% ] loading the level"),
        ]);

        assert_eq!(omitted, 4, "{kept:?}");
        assert_eq!(kept.len(), 3, "{kept:?}");
        assert_eq!(kept[2]["message"], "[ 50% ] loading the level");
        // The colour is gone and the sentence is whole.
        assert_eq!(
            kept[0]["message"],
            "SCRIPT ERROR: Parse Error: Identifier not found"
        );
        // A game's own print that merely opens with a bracket is not a progress bar.
        assert_eq!(
            kept[1]["message"],
            "[player] hit right window edge after 580.1 px"
        );
        assert_eq!(kept[0]["sequence"], json!(5));
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
        // Nine lines the model cannot read for every one it can, which is the shape of a real
        // import: the corpus's own ratio is closer to one in three.
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

        // And the cursor continues from the last line handed over, not from one read past it.
        let next = logs_domain(json!({"limit": 3, "after": answered["cursor"].clone()}))
            .expect("the next page");
        assert_eq!(next["entries"][0]["message"], "[player] line 12", "{next}");
        godot_session::clear_logs();
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

        // And it has to say that the two entries before it did not run. A live turn read a refusal
        // of this shape as having applied the entry before the mistake, and spent four calls
        // finding out otherwise.
        assert!(
            failure
                .message
                .contains("None of the 3 operations in this call ran"),
            "{}",
            failure.message
        );

        // A call of one says nothing about a list, because there is no list to point into.
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
                operation: domain
                    .operation(op)
                    .unwrap_or_else(|| panic!("{tool} offers {op}")),
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
            // An operation of the same domain to stand beside it. Any one will do: what the gate
            // reads is the scope, not the neighbour.
            let neighbour = domain
                .operations
                .iter()
                .map(|operation| operation.op)
                .find(|op| *op != entry.op)
                .expect("a domain offers more than one operation");

            // Twice is refused whatever the scope. An exclusive operation is answered in its own
            // words rather than as a repeat: sharing at all is what it cannot do, and a caller told
            // to drop the second entry would send the first one beside something else next.
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
            let under = super::named_directory(spelling);
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

    /// The project root, however it is spelled, narrows nothing.
    ///
    /// `res://` is the spelling a model reaching for "the whole project" writes, and it is one
    /// `named_directory` deliberately accepts — it took the scheme off and was left with nothing,
    /// and nothing matched nothing. `godot_resource list` and `godot_script list` both answered
    /// `{"files": []}` about a worktree full of files, which reads as an empty project rather than
    /// as a listing that narrowed itself away.
    #[test]
    fn the_project_root_is_not_a_directory_to_narrow_by() {
        for spelling in ["res://", "/", "//", ".", "res:///", "  "] {
            assert_eq!(super::named_directory(spelling), None, "{spelling}");
        }
        for spelling in ["assets", "res://assets"] {
            assert_eq!(
                super::named_directory(spelling),
                Some("assets".to_owned()),
                "{spelling}"
            );
        }
        let root = super::named_directory("res://");
        assert!(
            super::is_under("scripts/main.gd", root.as_deref()),
            "the root holds every file the worktree holds"
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
    /// The nine shapes under `repairs` are deliberately not here. Those are calls the repair pass
    /// rewrites before the router sees them, so the raw form is expected to be refused;
    /// `every_shape_the_fixture_records_as_repaired_is_the_shape_the_router_accepts` in
    /// `tool_params.rs` holds them to the shape they must be rewritten into.
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

    /// A backend that approves whatever the router asks it, so a gated call reaches its handler.
    ///
    /// The gate is the reason the destructive pair had never been driven through the router at all:
    /// the one test that exercised the ledger against a delete called `Workspace::delete` directly,
    /// which is the one path where the router's own bookkeeping cannot be observed.
    fn approving_app() -> tauri::App<tauri::test::MockRuntime> {
        use tauri::Listener;
        crate::approvals::open();
        let app = tauri::test::mock_builder()
            .build(crate::app_context())
            .expect("build mock Tauri app");
        tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("build mock webview");
        let window = app
            .get_webview_window("main")
            .expect("the window that was just built");
        window.listen("ai-approval-request", move |event| {
            let prompt: Value = serde_json::from_str(event.payload()).expect("an approval prompt");
            let id = prompt["approvalId"]
                .as_str()
                .expect("a prompt carries its id")
                .to_owned();
            std::thread::spawn(move || {
                for _ in 0..400 {
                    if crate::approvals::respond(&id, true).is_ok() {
                        return;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(5));
                }
            });
        });
        app
    }

    /// The same call named either way lands identically and leaves the same ledger behind.
    ///
    /// This is the live defect the table test above cannot see. `resource_domain` never normalised
    /// its paths, and nothing failed: `files::validate_relative` strips `res://` as well, so
    /// `delete {"path": "res://levels/level.tscn"}` reached the right file. What it did not reach
    /// was the read ledger, which is keyed on the string the caller wrote — so `recall` missed, no
    /// `expectedHash` was attached, and the file was deleted **unguarded**. The hash guard that
    /// `listing_records_the_hashes_a_delete_of_a_non_script_file_is_held_to` exists to prove was
    /// absent for the spelling a model reaches for first, and `forget` then forgot nothing, so the
    /// record outlived the file.
    ///
    /// `move` was the same shape from the other end: the record neither followed the file nor was
    /// dropped, which is exactly the stale-hash-after-a-rename state `read_ledger::reconcile` was
    /// written to prevent.
    #[test]
    fn a_resource_path_is_held_to_the_same_hash_and_ledger_as_a_worktree_path() {
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
        let root = workspace.root().to_owned();
        crate::read_ledger::forget_worktree(&root);

        let scene = "[gd_scene format=3]\n\n[node name=\"Level\" type=\"Node2D\"]\n";
        let stamp = workspace
            .write("levels/level.tscn", scene, None)
            .expect("write the scene");

        // The listing is the read that fills the ledger, and it records the worktree spelling.
        dispatch(
            app.handle(),
            call("godot_resource", "list", json!({"hashes": true})),
        )
        .expect("list the worktree with hashes");
        assert_eq!(
            crate::read_ledger::recall(&root, "levels/level.tscn").as_deref(),
            Some(stamp.hash.as_str())
        );

        // The file moves on behind the agent's back. A delete named the way the editor names it has
        // to meet the same refusal a worktree-relative one does — before, it met none at all.
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
        assert_eq!(refused.code, "file_conflict");
        assert!(
            workspace_path.join("levels/level.tscn").exists(),
            "the refused delete must have left the file where it is"
        );

        // Read it again, and the same call goes through — and takes the record with it.
        dispatch(
            app.handle(),
            call("godot_resource", "list", json!({"hashes": true})),
        )
        .expect("list the worktree again");
        dispatch(
            app.handle(),
            call(
                "godot_resource",
                "delete",
                json!({"path": "res://levels/level.tscn"}),
            ),
        )
        .expect("the hash the second listing recorded deletes it");
        assert!(
            !workspace_path.join("levels/level.tscn").exists(),
            "the approved delete removes the file"
        );
        assert!(
            crate::read_ledger::recall(&root, "levels/level.tscn").is_none(),
            "a record for a file that is gone is a claim about nothing"
        );

        // And a move carries the record to where the file went, named either way.
        let stamp = workspace
            .write("levels/level.tscn", scene, None)
            .expect("write the scene again");
        dispatch(
            app.handle(),
            call("godot_resource", "list", json!({"hashes": true})),
        )
        .expect("list the worktree once more");
        dispatch(
            app.handle(),
            call(
                "godot_resource",
                "move",
                json!({"from": "res://levels/level.tscn", "to": "res://levels/one.tscn"}),
            ),
        )
        .expect("move the scene");
        assert!(
            crate::read_ledger::recall(&root, "levels/level.tscn").is_none(),
            "the record must not outlive the path the file left"
        );
        assert_eq!(
            crate::read_ledger::recall(&root, "levels/one.tscn").as_deref(),
            Some(stamp.hash.as_str()),
            "the content did not change, only where it lives, so the record follows the file"
        );
        crate::read_ledger::forget_worktree(&root);
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
}

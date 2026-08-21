use command_error::CommandError;
use off_thread::{off_thread, off_thread_coded};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, Runtime};
use unsaved_work::UnsavedWork;
use workspace::{chat_attachments_path, open_project_storage, project_storage};

pub mod addon;
mod agent_prompt;
mod ai_tools;
mod ai_turn;
mod approvals;
mod ask;
mod cancel;
mod chatgpt_auth;
mod clipboard;
mod command_error;
mod debug;
mod files;
mod gdformat;
mod git;
mod godot_dap;
mod godot_lsp;
mod godot_policy;
mod godot_rpc;
mod godot_session;
mod godot_session_api;
mod health;
// How every acceptance suite below starts a real editor: the pinned binary, the fixture worktree,
// the launch, and the staged addon behind one `Session`.
#[cfg(all(test, feature = "godot-acceptance"))]
mod godot_editor_harness;
// Drives the staged addon inside a real editor. Gated so the default gate needs no Godot binary.
#[cfg(all(test, feature = "godot-acceptance"))]
mod godot_addon_acceptance;
// Sweeps the whole 2D/UI node catalogue through that same editor, same gate.
#[cfg(all(test, feature = "godot-acceptance"))]
mod godot_nodes_acceptance;
// Holds every mutating command to its read-back: what it answered has to be what Godot holds.
#[cfg(all(test, feature = "godot-acceptance"))]
mod godot_readback_acceptance;
// Holds what the tool catalog claims about the *engine* to the engine. Its own gate, outside the
// acceptance run: it can only break when the pinned Godot version moves.
#[cfg(all(test, feature = "godot-api-drift"))]
mod godot_api_drift;
// Drives the native language server inside a real editor, under the same gate.
#[cfg(all(test, feature = "godot-acceptance"))]
mod godot_lsp_acceptance;
// Drives the script commands Monaco calls against that same editor.
#[cfg(all(test, feature = "godot-acceptance"))]
mod godot_script_acceptance;
// Drives the native debug adapter inside a real editor running the fixture game, same gate.
#[cfg(all(test, feature = "godot-acceptance"))]
mod godot_dap_acceptance;
#[cfg(all(test, feature = "godot-acceptance"))]
mod godot_runtime_acceptance;
// Drives one AI turn through the router into that same editor: the step 14 done-criteria.
#[cfg(all(test, feature = "godot-acceptance"))]
mod godot_ai_acceptance;
#[cfg(all(test, feature = "godot-acceptance"))]
mod godot_live_agent;
// Drives the final journey: one task worktree from connect to task switch, through the supervisor
// the renderer starts and the router the agent calls, with no transport bound by the test itself.
#[cfg(all(test, feature = "godot-acceptance"))]
mod godot_journey_acceptance;
mod memory;
mod model_server;
mod off_thread;
mod paths;
mod process;
mod project_memory;
pub mod protocol_v2;
mod rag;
mod read_ledger;
mod script;
mod settings;
mod storage;
mod task_switch;
/// The catalogue's parameter contract, checked against everything that reads it. Tests only.
mod tool_drift;
mod tool_params;
mod unsaved_work;
mod workers;
mod workspace;

use ai_turn::{
    ChatAttachment, ChatAttachmentUpload, cancel_ai_request_with, read_chat_attachment_in,
    save_chat_attachment_in,
};
use process::SystemProcessSpawner;
use settings::{
    AI_HEALTH_TIMEOUT, AI_REQUEST_TIMEOUT, AiModelOption, ApiKeyUpdate, ConnectionTestResult,
    ConnectionTestStatus, GodotSettings, SettingsRequest, SettingsResponse, apply_api_key_update,
    apply_brave_key_update, clear_chatgpt_credential, list_ai_models_with, read_settings,
    restore_api_key, run_connection_test, save_godot_settings as store_godot_settings,
    settings_response, stored_api_key, validate_settings, write_settings,
};
use storage::{
    BackupResult, MaintenanceResult, MergeTaskResult, ResolveTaskResult, StorageSlot, StoredChat,
    TaskRecord,
};

/// How often the worktree is polled for changes Gofer did not make itself.
const WORKSPACE_WATCH_INTERVAL: Duration = Duration::from_millis(750);
static WORKSPACE_WATCH: Mutex<Option<files::WatchHandle>> = Mutex::new(None);

#[tauri::command]
async fn load_settings(app: AppHandle) -> Result<SettingsResponse, CommandError> {
    off_thread_coded("load_settings", "settings_unreadable", move || {
        let settings = read_settings(&app)?;
        Ok(settings_response(settings))
    })
    .await
}

#[tauri::command]
async fn save_settings(
    app: AppHandle,
    request: SettingsRequest,
) -> Result<SettingsResponse, CommandError> {
    off_thread_coded("save_settings", "settings_unwritable", move || {
        let settings = validate_settings(request.settings)?;
        // Written before the AI key's own rollback window, and deliberately outside it: the two are
        // separate credentials, and a failed settings write must not put back a Brave key the user
        // had just cleared.
        apply_brave_key_update(&request.brave_api_key)?;
        if matches!(&request.api_key, ApiKeyUpdate::Keep) {
            write_settings(&app, &settings)?;
            return Ok(announce_settings(&app, settings_response(settings)));
        }

        let previous_api_key = stored_api_key()?;
        apply_api_key_update(&request.api_key)?;
        if let Err(error) = write_settings(&app, &settings) {
            restore_api_key(previous_api_key.as_deref())?;
            return Err(error);
        }

        Ok(announce_settings(&app, settings_response(settings)))
    })
    .await
}

/// Tells every screen what the settings file now says.
///
/// The saved file is the one source of truth for the model, its limits and its reasoning level.
/// Without this, whoever did not do the saving keeps rendering the settings it read at mount — the
/// composer would still offer the old model after the settings page changed it.
fn announce_settings(app: &AppHandle, response: SettingsResponse) -> SettingsResponse {
    // A screen that is not listening is not a failed save: the file is already written, and the
    // command's own answer still carries the same response to whoever asked for it.
    let _ = app.emit("settings-saved", &response);
    response
}

/// Stores the Godot rules on their own, without the settings page's other three tabs.
///
/// The rules reach the editor when a session goes ready, not from here, because Godot reads the
/// embed mode once at startup and never looks again. Writing them into a live editor would move
/// nothing and would claim otherwise.
#[tauri::command]
async fn save_godot_settings(
    app: AppHandle,
    godot: GodotSettings,
) -> Result<SettingsResponse, CommandError> {
    off_thread_coded("save_godot_settings", "settings_unwritable", move || {
        Ok(settings_response(store_godot_settings(&app, godot)?))
    })
    .await
}

#[tauri::command]
async fn test_ai_connection(
    request: SettingsRequest,
) -> Result<ConnectionTestResult, CommandError> {
    run_connection_test(request, AI_REQUEST_TIMEOUT)
        .await
        // Retryable: an AI server that is not up yet is the ordinary case here, and the user has
        // nothing to change before pressing the button again.
        .map_err(|message| CommandError::new("ai_unreachable", message).retryable())
}

#[tauri::command]
async fn list_ai_models(request: SettingsRequest) -> Result<Vec<AiModelOption>, CommandError> {
    list_ai_models_with(request)
        .await
        .map_err(|message| CommandError::new("ai_unreachable", message).retryable())
}

#[tauri::command]
async fn login_chatgpt(
    method: chatgpt_auth::ChatGptLoginMethod,
    events: tauri::ipc::Channel<chatgpt_auth::ChatGptLoginPayload>,
) -> Result<(), CommandError> {
    off_thread_coded("login_chatgpt", "chatgpt_login_failed", move || {
        chatgpt_auth::login(method, events)
    })
    .await
}

#[tauri::command(async)]
fn respond_chatgpt_login(value: String) -> Result<(), CommandError> {
    chatgpt_auth::respond(value).map_err(CommandError::coded("chatgpt_login_not_waiting"))
}

#[tauri::command(async)]
fn cancel_chatgpt_login() -> Result<bool, CommandError> {
    chatgpt_auth::cancel().map_err(CommandError::coded("chatgpt_login_not_cancelled"))
}

#[tauri::command(async)]
fn logout_chatgpt() -> Result<(), CommandError> {
    clear_chatgpt_credential().map_err(CommandError::coded("chatgpt_logout_failed"))
}

/// The clipboard's image, for a paste the webview cannot deliver itself. See `clipboard`.
#[tauri::command(async)]
fn read_clipboard_image() -> Result<Option<clipboard::ClipboardImage>, CommandError> {
    clipboard::read_image().map_err(CommandError::coded("clipboard_image_unavailable"))
}

#[tauri::command(async)]
fn save_chat_attachment(app: AppHandle, request: ChatAttachmentUpload) -> Result<(), CommandError> {
    save_chat_attachment_in(&project_storage(&app)?, request)
}

#[tauri::command(async)]
fn read_chat_attachment(
    app: AppHandle,
    attachment: ChatAttachment,
) -> Result<String, CommandError> {
    read_chat_attachment_in(&project_storage(&app)?, attachment)
}

/// The conversation of the task the window is drawing, which it names rather than assumes.
#[tauri::command(async)]
fn load_chat(app: AppHandle, task_id: Option<String>) -> Result<StoredChat, CommandError> {
    project_storage(&app)?.chats().load(task_id.as_deref())
}

#[tauri::command(async)]
fn save_chat(app: AppHandle, chat: StoredChat) -> Result<(), CommandError> {
    project_storage(&app)?.chats().save(&chat)
}

/// Makes a task and opens it, which moves the project's one checkout onto its new branch.
///
/// Refused during a turn for the same reason opening one is: the checkout moves. Creating one was
/// the way around that refusal — the task was made, the editor stopped and the working tree
/// committed and checked out from under a running agent, and only then did the window's own switch
/// meet the refusal below and fail with nowhere to go.
///
/// `bring_changes` is the user's answer about whatever is loose in the checkout. Without it the
/// files are committed onto the task being left — including files the user copied in by hand, which
/// then disappear from disk when the new branch is checked out.
#[tauri::command(async)]
fn create_chat_task(app: AppHandle, bring_changes: bool) -> Result<StoredChat, CommandError> {
    let storage = project_storage(&app)?;
    refuse_during_turn()?;
    let release = switch_for(&app);
    let switch = storage.switch(&release);
    if bring_changes {
        storage.tasks().create_carrying_changes(&switch)
    } else {
        storage.tasks().create(&switch)
    }
}

/// What is loose in the checkout right now, so the new-task dialog can ask before it takes it.
#[tauri::command(async)]
fn pending_project_changes(app: AppHandle) -> Result<Vec<git::PendingChange>, CommandError> {
    let storage = project_storage(&app)?;
    let workspace = storage.tasks().agent_workspace()?;
    if !git::is_repository(&workspace) {
        return Ok(Vec::new());
    }
    git::pending_changes(&workspace).map_err(CommandError::from)
}

/// Opens another task, which moves the project's one checkout onto that task's branch.
///
/// A turn in flight is refused rather than raced: the agent is holding file hashes and an open
/// stream against the files that are about to change underneath it.
#[tauri::command(async)]
fn activate_chat_task(app: AppHandle, task_id: String) -> Result<StoredChat, CommandError> {
    let storage = project_storage(&app)?;
    refuse_during_turn()?;
    let release = switch_for(&app);
    storage
        .tasks()
        .activate(&task_id, &storage.switch(&release))
}

/// Everything that has to stop before the working tree moves.
///
/// The editor first: Godot keeps every open scene in memory and never rereads one a checkout
/// changed, so an editor left running saves the outgoing task's scene over the incoming task's file
/// with no error anywhere. Stopping it also unstages the addon, which is what leaves `project.godot`
/// clean enough for Git to perform the checkout at all. The read ledger goes with it, because the
/// hashes the agent was told are claims about files that are being replaced.
pub(crate) fn leave_task<R: tauri::Runtime>(
    app: &AppHandle<R>,
    workspace: &Path,
) -> Result<(), String> {
    godot_session_api::release_worktree(app, workspace)?;
    read_ledger::forget_worktree(workspace);
    Ok(())
}

/// The project's one checkout, and what has to stop before it moves.
///
/// Built once per command and handed to the task operation, rather than each operation remembering
/// to pass a closure on. See `task_switch`: the order and the failure policy live there.
fn switch_for(app: &AppHandle) -> impl Fn(&Path) -> Result<(), String> + use<'_> {
    move |workspace| leave_task(app, workspace)
}

fn refuse_during_turn() -> Result<(), CommandError> {
    match ai_turn::begin_provider_operation() {
        Ok(_guard) => Ok(()),
        Err(_) => Err(CommandError::new(
            "ai_request_in_progress",
            "Wait for the current answer to finish before opening another task",
        )
        .retryable()),
    }
}

#[tauri::command(async)]
fn delete_chat_task(app: AppHandle, task_id: String) -> Result<StoredChat, CommandError> {
    let storage = project_storage(&app)?;
    // Deleting the task the editor is editing stops that editor first: the checkout moves off the
    // deleted branch onto the task that takes over, and the staged addon comes out on the way.
    let release = switch_for(&app);
    storage.tasks().delete(&task_id, &storage.switch(&release))
}

#[tauri::command(async)]
fn import_legacy_chat(app: AppHandle, chat: StoredChat) -> Result<StoredChat, CommandError> {
    import_legacy_chat_in(&app, chat)
}

fn import_legacy_chat_in(app: &AppHandle, chat: StoredChat) -> Result<StoredChat, CommandError> {
    let storage = project_storage(app)?;
    let legacy_directory = chat_attachments_path(app)?;
    for attachment in chat
        .messages
        .iter()
        .flat_map(|message| message.attachments.iter())
    {
        storage
            .chats()
            .import_legacy_attachment(&legacy_directory, attachment)?;
    }
    storage.chats().save(&chat)?;
    storage.chats().load(chat.task_id.as_deref())
}

/// Reads one piece of remembered interface state for the open project.
///
/// The renderer keeps its layout — which tabs were open, how wide the panels were, which scripts
/// were being edited — per project rather than per machine, because they are facts about the work
/// rather than about the window.
#[tauri::command(async)]
fn read_project_state(app: AppHandle, key: String) -> Result<Option<String>, CommandError> {
    project_storage(&app)?.project().read_ui_state(&key)
}

/// Records one piece of interface state, or forgets it when no value is sent.
#[tauri::command(async)]
fn write_project_state(
    app: AppHandle,
    key: String,
    value: Option<String>,
) -> Result<(), CommandError> {
    project_storage(&app)?
        .project()
        .write_ui_state(&key, value.as_deref())
}

#[tauri::command(async)]
fn list_project_tasks(app: AppHandle) -> Result<Vec<TaskRecord>, CommandError> {
    project_storage(&app)?.tasks().list()
}

/// Every memory the open project holds, each checked against the files the workspace has now.
///
/// The check is not a second command the user has to press. A memory nobody has looked at is read
/// into the front of every turn's prompt, so the point of putting the list on screen at all is to
/// see which rows have stopped matching the project — and a verdict behind a button is a verdict
/// nobody asks for. It costs one directory walk, which is what the file watcher already does.
///
/// A workspace it cannot open is reported as unchecked rather than as every file being missing.
/// There is no active task before the first one is created, and a project with no worktree would
/// otherwise have its entire memory drawn as broken.
#[tauri::command(async)]
fn list_project_memory(app: AppHandle) -> Result<Vec<project_memory::CheckedMemory>, CommandError> {
    let storage = project_storage(&app)?;
    project_memory::list_checked_memories(&storage, workspace_snapshot(&app).as_ref())
}

/// How many saved layouts the panel is handed at once.
///
/// One file per question, and a question is something a person sat and answered, so a project with
/// hundreds is a project that has been designed in for months. Generous rather than tuned: the row
/// carries no markup, which is the reason a limit here is cheap in the first place.
const SKETCH_LIST_LIMIT: usize = 200;

/// Every layout the user has agreed, most recently saved first.
///
/// The markup is not in the answer. A sketch drawn with the project's own artwork inlined runs to
/// tens of kilobytes, and a list of forty would carry all of it to draw one — so this names them and
/// `read_project_sketch` fetches the one that gets opened.
#[tauri::command(async)]
fn list_project_sketches(app: AppHandle) -> Result<Vec<storage::SketchRecord>, CommandError> {
    project_storage(&app)?.sketches().list(SKETCH_LIST_LIMIT)
}

/// Both copies of one saved layout: the one to draw, and the one to hand to a builder.
///
/// `id` is the only value in this feature that arrives from the window and becomes a filename, so
/// the store checks its shape before it touches the disk.
#[tauri::command(async)]
fn read_project_sketch(app: AppHandle, id: String) -> Result<storage::SketchHtml, CommandError> {
    project_storage(&app)?.sketches().read(&id)
}

/// Stores one memory the user wrote or corrected, and answers with it checked.
///
/// Editing is the same upsert a finished turn uses, so an edited row loses its vector the moment
/// its text changes and is re-embedded here. What the user is really reaching for is often `state`:
/// retrieval reads `confirmed` and nothing else, so moving a row to `candidate` takes it away from
/// the model without throwing away what it says.
#[tauri::command(async)]
fn save_project_memory(
    app: AppHandle,
    edit: project_memory::MemoryEdit,
) -> Result<project_memory::CheckedMemory, CommandError> {
    let storage = project_storage(&app)?;
    project_memory::save_memory(&storage, &edit, workspace_snapshot(&app).as_ref())
}

/// Forgets one memory, so the next turn is never given it again.
#[tauri::command(async)]
fn delete_project_memory(app: AppHandle, id: String) -> Result<(), CommandError> {
    project_storage(&app)?.memory().delete(&id)
}

/// The files the active task's worktree holds, or nothing when there is no worktree to read.
fn workspace_snapshot(app: &AppHandle) -> Option<files::Snapshot> {
    active_workspace(app)
        .ok()
        .map(|workspace| files::scan(workspace.root()))
}

#[tauri::command(async)]
fn merge_task_branch(
    app: AppHandle,
    task_id: String,
    unsaved_work: Option<UnsavedWork>,
) -> Result<MergeTaskResult, CommandError> {
    // Merging visits the base branch and comes back, so the files under the editor move twice. The
    // session is stopped first, which also takes Gofer's own two lines back out of `project.godot`
    // before anything is committed.
    let storage = project_storage(&app)?;
    refuse_during_turn()?;
    // Before any of that: the stop is `get_tree().quit()`, which writes nothing. Work the editor is
    // holding is settled here or the merge does not start. Absent means nobody has been asked yet.
    unsaved_work::settle(unsaved_work.unwrap_or_default())?;
    let release = switch_for(&app);
    storage.tasks().merge(&task_id, &storage.switch(&release))
}

/// Brings the project's branch into the task so the agent can reconcile what clashed.
///
/// Offered after a merge Git could not do on its own. It runs on the task's own branch, which is
/// the worktree the agent already works in, so the conflict arrives as files holding both versions
/// rather than as a merge someone has to drive. Nothing is committed while any of them is still
/// unresolved — `merge_task_branch` refuses — so a half-finished resolution cannot reach the
/// project.
#[tauri::command(async)]
fn resolve_task_merge(app: AppHandle, task_id: String) -> Result<ResolveTaskResult, CommandError> {
    let storage = project_storage(&app)?;
    refuse_during_turn()?;
    let release = switch_for(&app);
    storage
        .tasks()
        .resolve_conflicts(&task_id, &storage.switch(&release))
}

/// Throws away an unfinished resolution merge and leaves the task exactly as it was.
#[tauri::command(async)]
fn abandon_task_merge(app: AppHandle, task_id: String) -> Result<(), CommandError> {
    let storage = project_storage(&app)?;
    refuse_during_turn()?;
    storage.tasks().abandon_conflicts(&task_id)
}

#[tauri::command(async)]
fn create_project_backup(app: AppHandle) -> Result<BackupResult, CommandError> {
    project_storage(&app)?.project().create_backup()
}

#[tauri::command(async)]
fn run_storage_maintenance(app: AppHandle) -> Result<MaintenanceResult, CommandError> {
    run_storage_maintenance_in(&app)
}

fn run_storage_maintenance_in(app: &AppHandle) -> Result<MaintenanceResult, CommandError> {
    let storage = project_storage(app)?;
    let mut result = storage.project().run_maintenance()?;
    result.memory_embeddings_restored = project_memory::backfill_memory_embeddings(&storage);
    Ok(result)
}

/// Searches the stored warning and error history of every recorded run.
///
/// `read_godot_logs` answers from the live session buffer, which holds only what the editor now
/// running has printed. This reaches the durable index behind it, so output from a session that
/// has already stopped is still findable.
#[tauri::command(async)]
fn search_godot_log_history(
    app: AppHandle,
    request: storage::SearchGodotLogsRequest,
) -> Result<Vec<storage::GodotLogSearchHit>, CommandError> {
    project_storage(&app)?.runs().search_logs(&request)
}

/// Starts a Godot editor session bound to the active task's isolated worktree.
#[tauri::command]
async fn start_godot_session<R: Runtime>(
    app: AppHandle<R>,
    request: godot_session_api::StartGodotSessionRequest,
) -> Result<godot_session_api::GodotSessionResponse, godot_session::SessionError> {
    off_thread("start_godot_session", move || {
        godot_session_api::start_session(&app, request)
    })
    .await?
}

/// Stops the active Godot editor session and cleans up the staged addon.
#[tauri::command]
async fn stop_godot_session<R: Runtime>(
    app: AppHandle<R>,
) -> Result<(), godot_session::SessionError> {
    off_thread("stop_godot_session", move || {
        godot_session_api::stop_session(&app)
    })
    .await?
}

/// Returns the active Godot editor session, if any.
#[tauri::command]
async fn get_godot_session<R: Runtime>(
    app: AppHandle<R>,
) -> Result<Option<godot_session_api::GodotSessionResponse>, godot_session::SessionError> {
    off_thread("get_godot_session", move || {
        godot_session_api::get_session(&app)
    })
    .await?
}

/// Sends one tagged RPC call to the connected Godot addon.
#[tauri::command]
async fn call_godot<R: Runtime>(
    app: AppHandle<R>,
    request: godot_session_api::CallGodotRequest,
) -> Result<godot_session_api::CallGodotResponse, godot_rpc::RpcError> {
    off_thread("call_godot", move || {
        godot_session_api::call_godot(&app, request)
    })
    .await?
}

/// Subscribes to addon events through a Tauri channel.
#[tauri::command]
async fn subscribe_godot_events<R: Runtime>(
    app: AppHandle<R>,
    events: tauri::ipc::Channel<godot_session_api::SessionEvent>,
) -> Result<(), godot_session::SessionError> {
    off_thread("subscribe_godot_events", move || {
        godot_session_api::subscribe_godot_events(&app, events)
    })
    .await?
}

/// Stops the active event subscription.
#[tauri::command]
async fn unsubscribe_godot_events() -> Result<(), godot_session::SessionError> {
    off_thread(
        "unsubscribe_godot_events",
        godot_session_api::unsubscribe_godot_events,
    )
    .await?
}

/// Answers one AI tool call the safety model stopped and put in front of the user.
#[tauri::command]
async fn respond_tool_approval(
    request: godot_session_api::ToolApprovalRequest,
) -> Result<(), approvals::ApprovalError> {
    off_thread("respond_tool_approval", move || {
        godot_session_api::respond_tool_approval(request)
    })
    .await?
}

/// Answers one question the agent asked the user, or records that they chose not to decide it.
///
/// Beside `respond_tool_approval` rather than folded into it: both unblock a waiting tool call and
/// both sit on the same registry, but an approval is a yes or no about an operation and this is a
/// sentence about a decision. One command carrying both would have to be told which it was.
#[tauri::command]
async fn respond_user_question(request: ask::QuestionResponse) -> Result<(), ask::QuestionError> {
    off_thread("respond_user_question", move || {
        ask::respond_question(request)
    })
    .await?
}

/// One debugger operation against the active session's adapter. The debugger panel and the
/// agent's `godot_debug` tool both land here, so a breakpoint the user set and one the agent set
/// are the same breakpoint.
#[tauri::command]
async fn call_godot_debug(
    request: debug::DebugRequest,
) -> Result<debug::DebugResponse, godot_dap::DapError> {
    off_thread("call_godot_debug", move || debug::call(request)).await?
}

/// Reads one page of captured session output: editor, importer, plugin, and the game the editor
/// launched, since they share the editor's two pipes.
#[tauri::command]
async fn read_godot_logs(
    query: godot_session::LogQuery,
) -> Result<godot_session::LogPage, godot_session::SessionError> {
    off_thread("read_godot_logs", move || godot_session::read_logs(&query)).await?
}

/// Typed workspace file access. Every caller — the renderer, the AI agent, and the Godot addon —
/// reaches the worktree through these commands so that path validation, atomic replacement, and
/// optimistic concurrency exist exactly once.
#[tauri::command(async)]
fn read_workspace_file(
    app: AppHandle,
    path: String,
) -> Result<files::FileContents, files::FileError> {
    active_workspace(&app)?.read(&path)
}

/// A small `data:` URL for a worktree picture, or `None` when the file is not one.
///
/// Its own command rather than a field on the listing: the listing is every file in the worktree
/// and the menu draws twenty of them, so the squares are fetched for what is on screen.
#[tauri::command(async)]
fn read_workspace_thumbnail(
    app: AppHandle,
    path: String,
) -> Result<Option<String>, files::FileError> {
    active_workspace(&app)?.thumbnail(&path)
}

#[tauri::command(async)]
fn write_workspace_file(
    app: AppHandle,
    request: files::WriteFileRequest,
) -> Result<files::FileStamp, files::FileError> {
    active_workspace(&app)?.write(
        &request.path,
        &request.text,
        request.expected_hash.as_deref(),
    )
}

#[tauri::command(async)]
fn edit_workspace_file(
    app: AppHandle,
    request: files::EditFileRequest,
) -> Result<files::FileStamp, files::FileError> {
    active_workspace(&app)?.edit(
        &request.path,
        &request.expected_hash,
        &request.find,
        &request.replace,
    )
}

#[tauri::command(async)]
fn move_workspace_path(
    app: AppHandle,
    request: files::MovePathRequest,
) -> Result<(), files::FileError> {
    active_workspace(&app)?.move_path(&request.from, &request.to)
}

#[tauri::command(async)]
fn delete_workspace_path(
    app: AppHandle,
    request: files::DeletePathRequest,
) -> Result<(), files::FileError> {
    active_workspace(&app)?.delete(&request.path, request.expected_hash.as_deref())
}

/// Streams settled batches of changes made by Godot, the user, or a confined shell command.
#[tauri::command(async)]
fn watch_workspace_files(
    app: AppHandle,
    changes: tauri::ipc::Channel<Vec<files::FileChange>>,
) -> Result<(), files::FileError> {
    let workspace = active_workspace(&app)?;
    let mut slot = workspace_watch()?;
    if let Some(previous) = slot.take() {
        previous.stop();
    }
    *slot = Some(files::spawn_watcher(
        workspace,
        WORKSPACE_WATCH_INTERVAL,
        move |batch| {
            let _ = changes.send(batch);
        },
    ));
    Ok(())
}

#[tauri::command(async)]
fn unwatch_workspace_files() -> Result<(), files::FileError> {
    if let Some(watch) = workspace_watch()?.take() {
        watch.stop();
    }
    Ok(())
}

/// Lists every watchable file in the active task worktree so the renderer can offer them for
/// editing. Sizes come from the same scan the watcher uses; content hashes stay absent because a
/// worktree holds game assets and the editor re-reads a file when it opens it.
#[tauri::command(async)]
fn list_workspace_files(app: AppHandle) -> Result<Vec<WorkspaceEntry>, files::FileError> {
    let workspace = active_workspace(&app)?;
    Ok(files::scan(workspace.root())
        .into_iter()
        .map(|(path, stamp)| WorkspaceEntry {
            path,
            bytes: stamp.bytes,
        })
        .collect())
}

/// One workspace file offered to the renderer's script picker.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceEntry {
    path: String,
    bytes: u64,
}

/// Script intelligence for the renderer's Monaco editor. Every command binds to the active
/// session's language server, so the editor and the AI agent share one document version per file.
#[tauri::command(async)]
fn open_script_document(
    request: script::OpenScriptRequest,
) -> Result<script::ScriptDocument, godot_lsp::LspError> {
    script::open_document(request)
}

#[tauri::command(async)]
fn update_script_document(
    request: script::UpdateScriptRequest,
) -> Result<script::ScriptStamp, godot_lsp::LspError> {
    script::update_document(request)
}

#[tauri::command(async)]
fn save_script_document(
    request: script::SaveScriptRequest,
) -> Result<script::ScriptStamp, godot_lsp::LspError> {
    script::save_document(request)
}

#[tauri::command(async)]
fn close_script_document(request: script::OpenScriptRequest) -> Result<(), godot_lsp::LspError> {
    script::close_document(request)
}

#[tauri::command(async)]
fn call_script_language(
    request: script::ScriptRequest,
) -> Result<script::ScriptResponse, godot_lsp::LspError> {
    script::call(request)
}

#[tauri::command(async)]
fn apply_script_rename(
    request: script::ApplyRenameRequest,
) -> Result<Vec<script::ScriptStamp>, godot_lsp::LspError> {
    script::apply_rename(request)
}

#[tauri::command(async)]
fn subscribe_script_diagnostics(
    diagnostics: tauri::ipc::Channel<script::ScriptDiagnostics>,
) -> Result<(), godot_lsp::LspError> {
    script::subscribe_diagnostics(diagnostics)
}

#[tauri::command(async)]
fn unsubscribe_script_diagnostics() -> Result<(), godot_lsp::LspError> {
    script::unsubscribe_diagnostics()
}

/// Formats a GDScript buffer through the pinned gdformat sidecar. The formatted text is returned
/// for the caller to diff; applying it is a separate, explicit workspace write, so a formatter
/// failure can never mutate the source. A missing or wrong-version sidecar reports
/// `formatter_unavailable` — formatting is the one feature allowed to ship disabled.
#[tauri::command(async)]
fn format_gdscript(
    app: AppHandle,
    request: gdformat::FormatRequest,
) -> Result<gdformat::FormatResponse, gdformat::GdformatError> {
    let binary = gdformat_binary(&app)?;
    gdformat::format_source(&SystemProcessSpawner, &binary, &request.source)
}

/// Resolves the sidecar once per binary path so each format call does not pay for a second
/// process spawn just to re-prove the pin.
fn gdformat_binary<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<std::path::PathBuf, gdformat::GdformatError> {
    let resource_dir = app.path().resource_dir().ok();
    let binary = gdformat::resolve(std::env::var_os(gdformat::ENV_OVERRIDE), resource_dir)?;
    let mut verified = GDFORMAT_VERIFIED
        .lock()
        .map_err(|_| gdformat_lock_error())?;
    if verified.as_deref() == Some(binary.as_path()) {
        return Ok(binary);
    }
    gdformat::verify_version(&SystemProcessSpawner, &binary)?;
    *verified = Some(binary.clone());
    Ok(binary)
}

fn gdformat_lock_error() -> gdformat::GdformatError {
    gdformat::GdformatError {
        code: "formatter_unavailable",
        message: "The gdformat sidecar state lock is poisoned".to_owned(),
        retryable: false,
        details: serde_json::json!({}),
    }
}

static GDFORMAT_VERIFIED: Mutex<Option<std::path::PathBuf>> = Mutex::new(None);

fn workspace_watch()
-> Result<std::sync::MutexGuard<'static, Option<files::WatchHandle>>, files::FileError> {
    WORKSPACE_WATCH
        .lock()
        .map_err(|_| files::FileError::unavailable("The workspace watch lock is poisoned"))
}

/// Binds file access to the active task's worktree, which `agent_workspace` resolves.
pub(crate) fn active_workspace<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<files::Workspace, files::FileError> {
    let storage = project_storage(app).map_err(files::FileError::unavailable)?;
    let root = storage
        .tasks()
        .agent_workspace()
        .map_err(|failure| files::FileError::unavailable(failure.message))?;
    files::Workspace::open(&root)
}

#[tauri::command(async)]
fn cancel_ai_request(request_id: u64) -> Result<bool, CommandError> {
    cancel_ai_request_with(request_id).map_err(CommandError::coded("cancel_refused"))
}

/// Streams one turn of the conversation.
///
/// The deltas ride a channel rather than an event: they are high-rate, they are tied to this one
/// invocation, and text assembled out of order is corrupt text.
#[tauri::command]
async fn send_ai_message(
    app: AppHandle,
    request: ai_turn::ChatRequest,
    stream: tauri::ipc::Channel<ai_turn::AiStreamPayload>,
) -> Result<(), CommandError> {
    ai_turn::run_turn(app, request, stream).await
}

/// Runs the four phases that turn a planned task's ask into a specification.
///
/// It takes the same stream channel a chat turn does, because it runs as one: that is what the Stop
/// button reaches, and what stops the shared checkout being switched out from under it. The brief's
/// own progress does not travel on the channel — it goes out as `ai-brief` window events, because a
/// phase is not part of an assistant message and the chat timeline drops what it does not draw.
#[tauri::command]
async fn run_task_brief(
    app: AppHandle,
    request: ai_turn::BriefRequest,
    stream: tauri::ipc::Channel<ai_turn::AiStreamPayload>,
) -> Result<(), CommandError> {
    ai_turn::run_brief(app, request, stream).await
}

/// Puts one memory to a read-only sub-agent, which says whether it is still true of the checkout.
///
/// The other half of `list_project_memory`'s check, and the half that costs something. That one
/// reads a memory's file paths and looks for them — free, instant, and blind to any sentence that
/// names no file, which was 32 of 87 memories measured on a real project. This one reads the code.
///
/// It takes a stream channel because it runs as a turn: that is what Stop reaches, and what keeps
/// it from running beside a chat turn on the one provider connection. Its own progress does not
/// ride the channel — it goes out as `ai-memory-judge` window events, because the panel reading it
/// is not the chat timeline.
#[tauri::command]
async fn judge_project_memory(
    app: AppHandle,
    request: ai_turn::JudgeRequest,
    stream: tauri::ipc::Channel<ai_turn::AiStreamPayload>,
) -> Result<project_memory::CheckedMemory, CommandError> {
    ai_turn::run_judge(app, request, stream).await
}

/// A task's brief as far as it got, or nothing when it never had one.
#[tauri::command]
async fn read_task_brief(
    app: AppHandle,
    task_id: String,
) -> Result<Option<storage::BriefRun>, CommandError> {
    off_thread_coded("read_task_brief", "brief_unreadable", move || {
        Ok(project_storage(&app)?.tasks().read_brief(&task_id))
    })
    .await
}

#[tauri::command]
async fn get_rag_cache_status() -> Result<rag::CacheStatus, CommandError> {
    off_thread_coded(
        "get_rag_cache_status",
        "models_unavailable",
        rag::cache_status,
    )
    .await
}

#[tauri::command]
async fn delete_rag_cache() -> Result<rag::CacheStatus, CommandError> {
    off_thread_coded("delete_rag_cache", "models_unavailable", rag::delete_cache).await
}

#[tauri::command]
async fn initialize_rag(app: AppHandle) -> Result<(), CommandError> {
    off_thread_coded("initialize_rag", "models_unavailable", move || {
        rag::run_initialization(|| rag::run_warmup(&app))
    })
    .await
    // A half-written cache and a download that timed out both come back here. Retrying is
    // worth offering for either: the splash already does, and the code is what lets it.
    .map_err(CommandError::retryable)
}

/// The prompt as the settings page shows it: what this project sends, and what Gofer ships.
#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentPromptResponse {
    prompt: String,
    default_prompt: String,
}

fn agent_prompt_response(stored: Option<String>, strict_typing: bool) -> AgentPromptResponse {
    AgentPromptResponse {
        prompt: agent_prompt::resolve(stored.as_deref(), ai_tools::CATALOG, strict_typing),
        default_prompt: agent_prompt::default_prompt(ai_tools::CATALOG, strict_typing),
    }
}

/// Whether this project enforces strict typing, which decides one line of the prompt.
///
/// Read the way the router reads it, and unreadable settings answer with the shipped rules rather
/// than with no rules: a prompt that quietly dropped the line would tell the model nothing about a
/// rule that is still being enforced underneath it.
fn strict_typing<R: Runtime>(app: &AppHandle<R>) -> bool {
    settings::read_godot_settings(app)
        .unwrap_or_default()
        .strict_typing
}

#[tauri::command(async)]
fn read_agent_prompt(app: AppHandle) -> Result<AgentPromptResponse, CommandError> {
    let stored = project_storage(&app)?.project().read_agent_prompt()?;
    Ok(agent_prompt_response(stored, strict_typing(&app)))
}

/// Stores this project's prompt, or forgets it when the text is the one Gofer ships.
#[tauri::command(async)]
fn save_agent_prompt(app: AppHandle, prompt: String) -> Result<AgentPromptResponse, CommandError> {
    if prompt.len() > agent_prompt::MAX_PROMPT_BYTES {
        return Err(CommandError::new(
            "prompt_too_large",
            "System prompts cannot exceed 64 KiB",
        ));
    }
    let enforced = strict_typing(&app);
    let stored = if prompt.trim().is_empty()
        || agent_prompt::is_default(&prompt, ai_tools::CATALOG, enforced)
    {
        None
    } else {
        Some(prompt)
    };
    project_storage(&app)?
        .project()
        .write_agent_prompt(stored.as_deref())?;
    Ok(agent_prompt_response(stored, enforced))
}

#[tauri::command]
async fn query_godot_docs(
    app: AppHandle,
    request: rag::GodotDocsQuery,
) -> Result<rag::GodotDocsResponse, CommandError> {
    // Resolved on this thread, where the app handle lives, and carried into the worker thread.
    let connection = rag::expansion_connection(&app);
    off_thread_coded("query_godot_docs", "docs_unavailable", move || {
        rag::retrieve_query(request, connection)
    })
    .await
}

/// Reports everything Gofer needs in order to work here, and what repairs each missing piece.
#[tauri::command]
async fn check_workspace_health(app: AppHandle) -> Result<health::HealthReport, CommandError> {
    let ai = ai_health(&app).await;
    off_thread("check_workspace_health", move || {
        let formatter_error = gdformat_binary(&app).err().map(|error| error.message);
        workspace::report_health(&app, ai, formatter_error)
    })
    .await
}

/// Applies one repair and answers with the report as it stands afterwards, so the interface never
/// shows a fix that has already been applied.
#[tauri::command]
async fn apply_health_remedy(
    app: AppHandle,
    request: HealthRemedyRequest,
) -> Result<health::HealthReport, CommandError> {
    let handle = app.clone();
    off_thread_coded("apply_health_remedy", "health_remedy_refused", move || {
        workspace::apply_remedy(&handle, request.action, request.path)
    })
    .await?;
    check_workspace_health(app).await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HealthRemedyRequest {
    action: health::RemedyAction,
    /// The folder or executable the user picked, for the remedies that need one.
    #[serde(default)]
    path: Option<String>,
}

/// Asks the configured AI server whether it is there and serving the configured model.
///
/// Unreachable is reported, never fatal: a local model the user has not started yet is the ordinary
/// case, and it must not stand between them and their project.
async fn ai_health(app: &AppHandle) -> health::AiHealth {
    let loaded = tauri::async_runtime::spawn_blocking({
        let app = app.clone();
        move || read_settings(&app)
    })
    .await
    .map_err(|error| error.to_string())
    .and_then(|settings| settings);
    let settings = match loaded {
        Ok(settings) => settings,
        Err(error) => {
            return health::AiHealth {
                base_url: String::new(),
                model: String::new(),
                reachability: health::AiReachability::ServerError,
                message: format!("Gofer's AI settings could not be read: {error}"),
            };
        }
    };
    let base_url = settings.ai.base_url.clone();
    let model = settings.ai.model.clone();
    let result = run_connection_test(
        SettingsRequest {
            settings,
            api_key: ApiKeyUpdate::Keep,
            brave_api_key: ApiKeyUpdate::Keep,
        },
        AI_HEALTH_TIMEOUT,
    )
    .await;
    let (reachability, message) = match result {
        Ok(result) => (
            match result.status {
                ConnectionTestStatus::Connected => health::AiReachability::Connected,
                ConnectionTestStatus::ModelUnavailable => health::AiReachability::ModelUnavailable,
                ConnectionTestStatus::Unauthorized => health::AiReachability::Unauthorized,
                ConnectionTestStatus::ServerError => health::AiReachability::ServerError,
                ConnectionTestStatus::ServerUnreachable => health::AiReachability::Unreachable,
            },
            result.message,
        ),
        Err(error) => (health::AiReachability::ServerError, error),
    };
    health::AiHealth {
        base_url,
        model,
        reachability,
        message,
    }
}

/// The one place `tauri::generate_context!` may be expanded.
///
/// On macOS the macro embeds the Info.plist as `#[no_mangle] static _EMBED_INFO_PLIST`, and
/// `embed_plist` gives that a stable symbol name on purpose, so a second expansion anywhere in the
/// crate is a duplicate-symbol link error rather than a second plist. A test build expands
/// everything the tests need at once, so the mock apps have to share the real application's
/// context instead of each generating their own. `EmbeddedAssets` implements `Assets<R>` for every
/// runtime, so the same context serves `MockRuntime` and the real one.
pub(crate) fn app_context<R: tauri::Runtime>() -> tauri::Context<R> {
    tauri::generate_context!()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "linux")]
    // SAFETY: this runs at process startup, before Tauri or WebKit creates worker threads.
    unsafe {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }

    let builder = tauri::Builder::default();
    #[cfg(feature = "webdriver")]
    let builder = builder
        .plugin(tauri_plugin_wdio::init())
        .plugin(tauri_plugin_wdio_webdriver::init());

    let builder = builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init());

    // A workspace Gofer cannot open is the health check's problem, not a reason to refuse to
    // start: failing here fails `build`, which panics, and the user is left with no window and no
    // way to point Gofer at a folder that would have worked.
    let builder = builder.setup(|app| {
        // Read once here because the workers are spawned from places that hold no handle, and
        // because a process cannot move its own resources while it runs.
        workers::remember_resource_dir(app.path().resource_dir().ok());
        // The editor's guard reads the project through this. Two of the three doors to the editor
        // — the language server and the debug adapter — are reached from call paths that carry no
        // handle at all. See `godot_session_api::remember_app`.
        godot_session_api::remember_app(app.handle().clone());
        app.manage(StorageSlot::new(open_project_storage(app.handle())));
        Ok(())
    });

    let builder = builder.invoke_handler(tauri::generate_handler![
        abandon_task_merge,
        activate_chat_task,
        apply_health_remedy,
        apply_script_rename,
        call_godot,
        check_workspace_health,
        call_godot_debug,
        call_script_language,
        cancel_ai_request,
        cancel_chatgpt_login,
        close_script_document,
        create_chat_task,
        pending_project_changes,
        create_project_backup,
        delete_chat_task,
        delete_project_memory,
        delete_rag_cache,
        delete_workspace_path,
        edit_workspace_file,
        format_gdscript,
        get_godot_session,
        get_rag_cache_status,
        import_legacy_chat,
        initialize_rag,
        list_ai_models,
        judge_project_memory,
        list_project_memory,
        list_project_sketches,
        list_project_tasks,
        list_workspace_files,
        load_chat,
        load_settings,
        login_chatgpt,
        logout_chatgpt,
        merge_task_branch,
        move_workspace_path,
        open_script_document,
        query_godot_docs,
        read_agent_prompt,
        read_chat_attachment,
        read_clipboard_image,
        read_godot_logs,
        read_task_brief,
        read_project_sketch,
        read_project_state,
        read_workspace_file,
        read_workspace_thumbnail,
        resolve_task_merge,
        respond_tool_approval,
        respond_user_question,
        respond_chatgpt_login,
        run_task_brief,
        run_storage_maintenance,
        save_agent_prompt,
        save_chat,
        save_project_memory,
        save_script_document,
        save_settings,
        save_godot_settings,
        save_chat_attachment,
        search_godot_log_history,
        send_ai_message,
        start_godot_session,
        stop_godot_session,
        subscribe_godot_events,
        subscribe_script_diagnostics,
        test_ai_connection,
        unsubscribe_godot_events,
        unsubscribe_script_diagnostics,
        unwatch_workspace_files,
        update_script_document,
        watch_workspace_files,
        write_project_state,
        write_workspace_file,
    ]);

    builder
        .build(app_context())
        .expect("error while building tauri application")
        .run(|app, event| {
            // The editor is Gofer's own child, and the addon it staged lives in the user's
            // worktree. Closing the window without this leaves both behind: a Godot process the
            // user did not start, editing files Gofer promised to clean up.
            if matches!(event, tauri::RunEvent::Exit) {
                let _ = godot_session_api::stop_session(app);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::process::FakeProcessSpawner;
    use crate::storage::ProjectStorage;
    use std::fs;
    use tempfile::TempDir;

    fn mock_app() -> tauri::App<tauri::test::MockRuntime> {
        let app = tauri::test::mock_builder()
            .build(app_context())
            .expect("build mock Tauri app");
        tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("build mock webview");
        app
    }

    /// The window is granted exactly the commands it registers.
    ///
    /// These are two hand-maintained lists in two languages, and the build cannot reconcile them:
    /// `generate_handler!` decides what exists, `permissions/main-window-commands.toml` decides
    /// what the renderer may call, and a name in one and not the other is either a command nobody
    /// can reach or a grant for a command that is gone. Both are read out of the files themselves
    /// so that adding a command in one place and forgetting the other fails here.
    #[test]
    fn the_window_is_granted_exactly_the_commands_it_registers() {
        let source = include_str!("lib.rs");
        let handler = source
            .split_once("builder.invoke_handler(tauri::generate_handler![")
            .expect("the application registers its commands")
            .1
            .split_once("]);")
            .expect("the command list is closed")
            .0;
        let mut registered: Vec<&str> = handler
            .split(',')
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .collect();
        registered.sort_unstable();

        let permissions = include_str!("../permissions/main-window-commands.toml");
        let allowed_block = permissions
            .split_once("commands.allow = [")
            .expect("the permission set allows commands")
            .1
            .split_once(']')
            .expect("the allow list is closed")
            .0;
        let mut allowed: Vec<&str> = allowed_block
            .split(',')
            .map(|entry| entry.trim().trim_matches('"'))
            .filter(|name| !name.is_empty())
            .collect();
        allowed.sort_unstable();

        assert_eq!(
            registered, allowed,
            "generate_handler! and permissions/main-window-commands.toml disagree"
        );
    }

    #[test]
    fn injected_rag_worker_streams_progress_and_classifies_failures() {
        let app = mock_app();
        let success = FakeProcessSpawner::new(
            "diagnostic\nGOFER_RAG_EVENT:{\"phase\":\"download\",\"progress\":0.5}\n",
            "",
            true,
        );
        rag::run_warmup_with(app.handle(), &success).expect("fake RAG warmup");

        let invalid = FakeProcessSpawner::new("GOFER_RAG_EVENT:not-json\n", "", true);
        assert!(
            rag::run_warmup_with(app.handle(), &invalid)
                .unwrap_err()
                .contains("invalid progress data")
        );

        let failed = FakeProcessSpawner::new("", "download failed\n", false);
        assert_eq!(
            rag::run_warmup_with(app.handle(), &failed).unwrap_err(),
            "Gofer RAG initialization failed: download failed"
        );

        let silent = FakeProcessSpawner::new("", "", false);
        assert!(
            rag::run_warmup_with(app.handle(), &silent)
                .unwrap_err()
                .contains("exit status: 1")
        );
    }

    #[test]
    fn tauri_mock_runtime_exposes_godot_session_commands() {
        use tauri::Manager;
        use tauri::ipc::{CallbackFn, InvokeBody};
        use tauri::test::{INVOKE_KEY, get_ipc_response, mock_builder};
        use tauri::webview::InvokeRequest;

        // Every command below is answered by the process-wide session state, and three of the four
        // assertions are about there being no session. That is only this test's to say while
        // nothing else has an editor bound.
        let _no_editor = crate::godot_session::no_editor_bound();

        let directory = TempDir::new().expect("temporary application data");
        let workspace = directory.path().join("workspace");
        fs::create_dir(&workspace).expect("create workspace");
        let storage = ProjectStorage::open(&directory.path().join("data"), &workspace)
            .expect("open project storage");

        let app = mock_builder()
            .invoke_handler(tauri::generate_handler![
                start_godot_session,
                stop_godot_session,
                get_godot_session,
                call_godot,
                respond_tool_approval
            ])
            .build(app_context())
            .expect("build mock Tauri app");
        app.manage(StorageSlot::new(Ok(storage)));
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("build mock webview");

        let get_response = get_ipc_response(
            &webview,
            InvokeRequest {
                cmd: "get_godot_session".into(),
                callback: CallbackFn(0),
                error: CallbackFn(1),
                url: "tauri://localhost".parse().expect("mock URL"),
                body: InvokeBody::Json(serde_json::json!({})),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.to_owned(),
            },
        )
        .expect("invoke get_godot_session")
        .deserialize::<Option<godot_session_api::GodotSessionResponse>>()
        .expect("deserialize session response");
        assert!(get_response.is_none());

        let start_error = get_ipc_response(
            &webview,
            InvokeRequest {
                cmd: "start_godot_session".into(),
                callback: CallbackFn(0),
                error: CallbackFn(1),
                url: "tauri://localhost".parse().expect("mock URL"),
                body: InvokeBody::Json(serde_json::json!({"request": {}})),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.to_owned(),
            },
        )
        .unwrap_err();
        assert!(start_error.to_string().contains("no_active_task_workspace"));

        let call_error = get_ipc_response(
            &webview,
            InvokeRequest {
                cmd: "call_godot".into(),
                callback: CallbackFn(0),
                error: CallbackFn(1),
                url: "tauri://localhost".parse().expect("mock URL"),
                body: InvokeBody::Json(serde_json::json!({
                    "request": {
                        "id": "call-1",
                        "command": "session.get_state",
                        "params": {}
                    }
                })),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.to_owned(),
            },
        )
        .unwrap_err();
        assert!(call_error.to_string().contains("session_not_active"));

        let approval_error = get_ipc_response(
            &webview,
            InvokeRequest {
                cmd: "respond_tool_approval".into(),
                callback: CallbackFn(0),
                error: CallbackFn(1),
                url: "tauri://localhost".parse().expect("mock URL"),
                body: InvokeBody::Json(serde_json::json!({
                    "request": {
                        "approvalId": "approval-1",
                        "approved": true
                    }
                })),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.to_owned(),
            },
        )
        .unwrap_err();
        // Nothing is waiting: an answer to a prompt that no longer exists must not silently pass
        // for approval of the next one.
        assert!(approval_error.to_string().contains("unknown_approval"));
    }

    /// Leaving a task must actually leave the editor stopped, and must not go quietly when it could
    /// not.
    ///
    /// This is the whole safety property behind a switch, a delete and a merge. Godot holds every
    /// open scene in memory, never rereads one a checkout changed underneath it, and saves the stale
    /// copy over the branch that was switched to — with no error anywhere. Yet `release_worktree`
    /// answers `()`, throws its stop's failure away, and returns early and silently whenever the two
    /// paths do not compare equal. Nothing else tests it: it has no unit test of its own, and the
    /// only suite that reaches it needs a real 4.7.2 editor.
    ///
    /// So the checkout moves whatever happened. A stop that failed reads exactly like a stop that
    /// worked.
    #[test]
    fn leaving_a_task_leaves_no_editor_running_in_it() {
        use crate::godot_session::{ExternalEditor, SESSION_TEST_LOCK, bind};
        use std::sync::Arc;

        let _test = SESSION_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let directory = TempDir::new().expect("temporary directory");
        let workspace = directory.path().join("workspace");
        fs::create_dir(&workspace).expect("create workspace");
        let workspace = crate::paths::canonical(&workspace).expect("canonical workspace");
        let app = mock_app();

        // An editor running in exactly the workspace the task is about to move out from under.
        bind(Some(Arc::new(ExternalEditor::at(6105, 6106, &workspace))));
        assert!(
            crate::godot_session::current_info().is_some(),
            "this fixture starts with an editor running"
        );

        // What `leave_task` is, minus the read ledger. `leave_task` itself is not generic over the
        // runtime, so the mock cannot reach it.
        godot_session_api::release_worktree(app.handle(), &workspace).expect(
            "the editor is stopped, and a failure to stop it is answered rather than hidden",
        );

        assert!(
            crate::godot_session::current_info().is_none(),
            "the working tree may not move while an editor is still holding it"
        );
        bind(None);
    }

    /// A command the main window cannot call is a command that does not exist, and nothing says so
    /// until the window invokes it: Tauri's ACL is enforced at runtime, so registering a command
    /// without allowing it fails only in front of the user. This compares the two lists directly.
    #[test]
    fn every_registered_command_is_allowed_for_the_main_window() {
        use std::collections::BTreeSet;

        let source = include_str!("lib.rs");
        let handler = source
            .split_once("invoke_handler(tauri::generate_handler![")
            .expect("the invoke handler is registered")
            .1
            .split_once("]);")
            .expect("the invoke handler list is closed")
            .0;
        let registered: BTreeSet<&str> = handler
            .lines()
            .map(|line| line.trim().trim_end_matches(','))
            .filter(|name| !name.is_empty() && !name.starts_with("//"))
            .collect();

        let permissions = include_str!("../permissions/main-window-commands.toml");
        let allowed: BTreeSet<&str> = permissions
            .lines()
            .filter_map(|line| line.trim().strip_prefix('"'))
            .filter_map(|line| line.split_once('"'))
            .map(|(name, _)| name)
            .collect();

        assert_eq!(
            registered.difference(&allowed).collect::<Vec<_>>(),
            Vec::<&&str>::new(),
            "these commands are registered but the main window may not call them; \
             add them to src-tauri/permissions/main-window-commands.toml"
        );
        assert_eq!(
            allowed.difference(&registered).collect::<Vec<_>>(),
            Vec::<&&str>::new(),
            "these commands are allowed but no longer registered; remove them from \
             src-tauri/permissions/main-window-commands.toml"
        );
    }
}

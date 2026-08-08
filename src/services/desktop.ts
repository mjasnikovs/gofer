import {Channel, invoke as tauriInvoke, isTauri as tauriIsTauri} from '@tauri-apps/api/core'
import {listen as tauriListen} from '@tauri-apps/api/event'
import type {EventCallback, UnlistenFn} from '@tauri-apps/api/event'
/*
 * The picker's own option type, from the plugin that defines it. The command is invoked directly
 * rather than through the plugin's `open()` so that the test driver intercepts it like every other
 * desktop call — but the payload shape is the plugin's to declare, not this file's to guess at.
 * The package is a devDependency: nothing here imports its runtime.
 */
import type {OpenDialogOptions} from '@tauri-apps/plugin-dialog'
import type {DownloadProgress} from '@mjasnikovs/gofer-rag'
import type {TaskSummary} from '../models/app'
import type {HealthRemedyRequest, HealthReport} from '../models/health'
import type {
    DeleteWorkspacePathRequest,
    EditWorkspaceFileRequest,
    MoveWorkspacePathRequest,
    WorkspaceFileChange,
    WorkspaceFileContents,
    WorkspaceFileStamp,
    WriteWorkspaceFileRequest
} from '../models/files'
import type {
    PlannedScriptFile,
    ScriptDiagnosticsEvent,
    ScriptDocument,
    ScriptRequest,
    ScriptResponse,
    ScriptStamp,
    WorkspaceEntry
} from '../models/script'
import type {
    AiStreamPayload,
    ChatAttachment,
    Message,
    StoredChat,
    ToolApprovalPrompt,
    ToolApprovalSettled
} from '../models/chat'
import type {
    AgentPrompt,
    AiModelOption,
    CacheStatus,
    ConnectionTestResult,
    SettingsRequest,
    SettingsResponse,
    StorageMaintenanceResult
} from '../models/settings'
import type {
    CallGodotRequest,
    CallGodotResponse,
    DebugRequest,
    DebugResponse,
    DocsQuery,
    DocsResponse,
    GodotLogPage,
    GodotLogQuery,
    GodotLogSearchHit,
    GodotLogSearchRequest,
    GodotSessionEvent,
    GodotSessionSummary,
    StartGodotSessionRequest
} from '../models/godot'

type CommandSpec<Arguments, Response> = Readonly<{
    arguments: Arguments
    response: Response
}>

type ChatMessageInput = Pick<Message, 'sender' | 'text' | 'timestamp' | 'attachments'>

export type SendAiMessageRequest = Readonly<{
    requestId: number
    taskId?: string | undefined
    agentMessages: readonly unknown[]
    messages: readonly ChatMessageInput[]
}>

type AttachmentUpload = Readonly<{
    attachment: ChatAttachment
    data: string
}>

type BackupResult = Readonly<{path: string}>

type ToolApprovalRequest = Readonly<{
    approvalId: string
    approved: boolean
}>

// The backend returns the formatted buffer for the caller to diff; applying it is a separate,
// explicit workspace write.
type FormatGdscriptRequest = Readonly<{source: string}>

type FormatGdscriptResponse = Readonly<{
    formatted: string
    changed: boolean
}>

type OpenScriptRequest = Readonly<{path: string}>

type UpdateScriptRequest = Readonly<{
    path: string
    text: string
}>

type SaveScriptRequest = Readonly<{
    path: string
    text: string
    expectedHash?: string | undefined
}>

type ApplyScriptRenameRequest = Readonly<{files: readonly PlannedScriptFile[]}>

type StoredChatPayload = Omit<StoredChat, 'taskId'>
    & Readonly<{
        taskId?: string | undefined
    }>

type DesktopCommandMap = Readonly<{
    activate_chat_task: CommandSpec<{taskId: string}, StoredChat>
    apply_health_remedy: CommandSpec<{request: HealthRemedyRequest}, HealthReport>
    apply_script_rename: CommandSpec<{request: ApplyScriptRenameRequest}, readonly ScriptStamp[]>
    call_godot: CommandSpec<{request: CallGodotRequest}, CallGodotResponse>
    call_godot_debug: CommandSpec<{request: DebugRequest}, DebugResponse>
    call_script_language: CommandSpec<{request: ScriptRequest}, ScriptResponse>
    cancel_ai_request: CommandSpec<{requestId: number}, boolean>
    check_workspace_health: CommandSpec<undefined, HealthReport>
    close_script_document: CommandSpec<{request: OpenScriptRequest}, void>
    create_chat_task: CommandSpec<undefined, StoredChat>
    create_project_backup: CommandSpec<undefined, BackupResult>
    delete_chat_task: CommandSpec<{taskId: string}, StoredChat>
    delete_rag_cache: CommandSpec<undefined, CacheStatus>
    delete_workspace_path: CommandSpec<{request: DeleteWorkspacePathRequest}, void>
    edit_workspace_file: CommandSpec<{request: EditWorkspaceFileRequest}, WorkspaceFileStamp>
    format_gdscript: CommandSpec<{request: FormatGdscriptRequest}, FormatGdscriptResponse>
    get_godot_session: CommandSpec<undefined, GodotSessionSummary | undefined>
    get_rag_cache_status: CommandSpec<undefined, CacheStatus>
    import_legacy_chat: CommandSpec<{chat: StoredChat}, StoredChat>
    initialize_rag: CommandSpec<undefined, void>
    list_ai_models: CommandSpec<{request: SettingsRequest}, readonly AiModelOption[]>
    list_project_tasks: CommandSpec<undefined, readonly TaskSummary[]>
    list_workspace_files: CommandSpec<undefined, readonly WorkspaceEntry[]>
    load_chat: CommandSpec<undefined, StoredChat>
    load_settings: CommandSpec<undefined, SettingsResponse>
    merge_task_worktree: CommandSpec<{taskId: string}, unknown>
    move_workspace_path: CommandSpec<{request: MoveWorkspacePathRequest}, void>
    open_script_document: CommandSpec<{request: OpenScriptRequest}, ScriptDocument>
    'plugin:dialog|open': CommandSpec<{options: OpenDialogOptions}, string | null>
    query_godot_docs: CommandSpec<{request: DocsQuery}, DocsResponse>
    read_agent_prompt: CommandSpec<undefined, AgentPrompt>
    read_chat_attachment: CommandSpec<{attachment: ChatAttachment}, string>
    read_godot_logs: CommandSpec<{query: GodotLogQuery}, GodotLogPage>
    // Remembered interface state, as the JSON the renderer wrote. Absent when nothing is stored.
    read_project_state: CommandSpec<{key: string}, string | null>
    read_workspace_file: CommandSpec<{path: string}, WorkspaceFileContents>
    respond_tool_approval: CommandSpec<{request: ToolApprovalRequest}, void>
    run_storage_maintenance: CommandSpec<undefined, StorageMaintenanceResult>
    save_agent_prompt: CommandSpec<{prompt: string}, AgentPrompt>
    save_chat: CommandSpec<{chat: StoredChatPayload}, void>
    save_chat_attachment: CommandSpec<{request: AttachmentUpload}, void>
    save_script_document: CommandSpec<{request: SaveScriptRequest}, ScriptStamp>
    save_settings: CommandSpec<{request: SettingsRequest}, SettingsResponse>
    search_godot_log_history: CommandSpec<
        {request: GodotLogSearchRequest},
        readonly GodotLogSearchHit[]
    >
    // The turn's deltas ride this channel: they are high-rate, ordered, and tied to this one call.
    send_ai_message: CommandSpec<
        {request: SendAiMessageRequest; stream: Channel<AiStreamPayload>},
        void
    >
    start_godot_session: CommandSpec<{request: StartGodotSessionRequest}, GodotSessionSummary>
    stop_godot_session: CommandSpec<undefined, void>
    subscribe_godot_events: CommandSpec<{events: Channel<GodotSessionEvent>}, void>
    // Published diagnostics arrive on this channel until the renderer unsubscribes.
    subscribe_script_diagnostics: CommandSpec<{diagnostics: Channel<ScriptDiagnosticsEvent>}, void>
    test_ai_connection: CommandSpec<{request: SettingsRequest}, ConnectionTestResult>
    unsubscribe_godot_events: CommandSpec<undefined, void>
    unsubscribe_script_diagnostics: CommandSpec<undefined, void>
    unwatch_workspace_files: CommandSpec<undefined, void>
    update_script_document: CommandSpec<{request: UpdateScriptRequest}, ScriptStamp>
    // The backend streams settled batches of external changes down this channel.
    watch_workspace_files: CommandSpec<{changes: Channel<readonly WorkspaceFileChange[]>}, void>
    // No `value` forgets the key, which is how a task's draft goes when the draft is emptied.
    write_project_state: CommandSpec<{key: string; value?: string}, void>
    write_workspace_file: CommandSpec<{request: WriteWorkspaceFileRequest}, WorkspaceFileStamp>
}>

type DesktopEventMap = Readonly<{
    'ai-approval-request': ToolApprovalPrompt
    'ai-approval-settled': ToolApprovalSettled
    'godot-session-event': GodotSessionEvent
    'rag-download-progress': DownloadProgress
}>

type DesktopCommand = keyof DesktopCommandMap
type CommandArguments<Command extends DesktopCommand> =
    DesktopCommandMap[Command]['arguments'] extends undefined ? []
    :   [arguments: DesktopCommandMap[Command]['arguments']]

type DesktopTestDriver = Readonly<{
    invoke: (command: string, arguments_?: unknown) => Promise<unknown>
    isTauri: () => boolean
    listen: (event: string, handler: EventCallback<unknown>) => Promise<UnlistenFn>
}>

declare global {
    interface Window {
        __GOFER_TEST_DESKTOP__?: DesktopTestDriver
    }
}

function testDriver() {
    return window.__GOFER_TEST_DESKTOP__
}

export function isTauri() {
    return testDriver()?.isTauri() ?? tauriIsTauri()
}

export function invoke<Command extends DesktopCommand>(
    command: Command,
    ...arguments_: CommandArguments<Command>
): Promise<DesktopCommandMap[Command]['response']> {
    const driver = testDriver()
    if (driver) return driver.invoke(command, arguments_[0])
    return tauriInvoke(command, arguments_[0])
}

export function listen<EventName extends keyof DesktopEventMap>(
    event: EventName,
    handler: EventCallback<DesktopEventMap[EventName]>
): Promise<UnlistenFn> {
    const driver = testDriver()
    if (driver) return driver.listen(event, handler as EventCallback<unknown>)
    return tauriListen(event, handler)
}

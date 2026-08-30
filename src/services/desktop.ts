import {Channel, invoke as tauriInvoke, isTauri as tauriIsTauri} from '@tauri-apps/api/core'
import {listen as tauriListen} from '@tauri-apps/api/event'
import type {EventCallback, UnlistenFn} from '@tauri-apps/api/event'
import type {OpenDialogOptions} from '@tauri-apps/plugin-dialog'
import type {DownloadProgress} from '@mjasnikovs/gofer-rag'
import type {PendingChange, TaskSummary} from '../models/app'
import type {
    BriefEvent,
    BriefRun,
    UserQuestionPrompt,
    UserQuestionResponse,
    UserQuestionSettled
} from '../models/brief'
import type {HealthRemedyRequest, HealthReport} from '../models/health'
import type {
    MemoryEdit,
    MemoryJudgeEvent,
    MemoryState,
    MemorySweepEvent,
    ProjectMemory
} from '../models/memory'
import type {ProjectSketch, SketchHtml} from '../models/sketch'
import type {SkillsResponse} from '../models/skills'
import type {UnsavedWork} from '../models/unsaved-work'
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
    ChatGptLoginEvent,
    ChatGptLoginMethod,
    ConnectionTestResult,
    GodotSettings,
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
    isRetry: boolean
}>

type AttachmentUpload = Readonly<{
    attachment: ChatAttachment
    data: string
}>

export type ClipboardImage = Readonly<{
    width: number
    height: number
    pngBase64: string
}>

type BackupResult = Readonly<{path: string}>

type JudgeMemoryRequest = Readonly<{
    requestId: number
    memoryId: string
}>

type SweepMemoryRequest = Readonly<{
    requestId: number
    memoryIds: readonly string[]
}>

type ToolApprovalRequest = Readonly<{
    approvalId: string
    approved: boolean
}>

type RunTaskBriefRequest = Readonly<{
    requestId: number
    taskId: string
    prompt: string
}>

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

export type ResolveTaskMergeResult = Readonly<{
    taskId: string
    conflicts: readonly string[]
}>

export type DesktopCommandMap = Readonly<{
    abandon_task_merge: CommandSpec<{taskId: string}, void>
    activate_chat_task: CommandSpec<{taskId: string}, StoredChat>
    apply_health_remedy: CommandSpec<{request: HealthRemedyRequest}, HealthReport>
    apply_script_rename: CommandSpec<{request: ApplyScriptRenameRequest}, readonly ScriptStamp[]>
    call_godot: CommandSpec<{request: CallGodotRequest}, CallGodotResponse>
    call_godot_debug: CommandSpec<{request: DebugRequest}, DebugResponse>
    call_script_language: CommandSpec<{request: ScriptRequest}, ScriptResponse>
    cancel_ai_request: CommandSpec<{requestId: number}, boolean>
    cancel_chatgpt_login: CommandSpec<undefined, boolean>
    check_workspace_health: CommandSpec<undefined, HealthReport>
    close_script_document: CommandSpec<{request: OpenScriptRequest}, void>
    create_chat_task: CommandSpec<{bringChanges: boolean}, StoredChat>
    create_project_backup: CommandSpec<undefined, BackupResult>
    delete_chat_task: CommandSpec<{taskId: string}, StoredChat>
    delete_project_memory: CommandSpec<{id: string}, void>
    delete_rag_cache: CommandSpec<undefined, CacheStatus>
    delete_skill: CommandSpec<{name: string}, SkillsResponse>
    delete_workspace_path: CommandSpec<{request: DeleteWorkspacePathRequest}, void>
    edit_workspace_file: CommandSpec<{request: EditWorkspaceFileRequest}, WorkspaceFileStamp>
    format_gdscript: CommandSpec<{request: FormatGdscriptRequest}, FormatGdscriptResponse>
    get_godot_session: CommandSpec<undefined, GodotSessionSummary | undefined>
    get_rag_cache_status: CommandSpec<undefined, CacheStatus>
    import_legacy_chat: CommandSpec<{chat: StoredChat}, StoredChat>
    import_skill: CommandSpec<{sourcePath: string}, SkillsResponse>
    initialize_rag: CommandSpec<undefined, void>
    judge_project_memory: CommandSpec<
        {request: JudgeMemoryRequest; stream: Channel<AiStreamPayload>},
        ProjectMemory
    >
    list_ai_models: CommandSpec<{request: SettingsRequest}, readonly AiModelOption[]>
    list_project_memory: CommandSpec<undefined, readonly ProjectMemory[]>
    list_project_sketches: CommandSpec<undefined, readonly ProjectSketch[]>
    list_project_tasks: CommandSpec<undefined, readonly TaskSummary[]>
    list_skills: CommandSpec<undefined, SkillsResponse>
    list_workspace_files: CommandSpec<undefined, readonly WorkspaceEntry[]>
    load_chat: CommandSpec<{taskId: string | undefined}, StoredChat>
    load_settings: CommandSpec<undefined, SettingsResponse>
    login_chatgpt: CommandSpec<
        {method: ChatGptLoginMethod; events: Channel<Readonly<{event: ChatGptLoginEvent}>>},
        void
    >
    logout_chatgpt: CommandSpec<undefined, void>
    merge_task_branch: CommandSpec<{taskId: string; unsavedWork?: UnsavedWork}, unknown>
    move_workspace_path: CommandSpec<{request: MoveWorkspacePathRequest}, void>
    open_script_document: CommandSpec<{request: OpenScriptRequest}, ScriptDocument>
    pending_project_changes: CommandSpec<undefined, readonly PendingChange[]>
    'plugin:dialog|open': CommandSpec<{options: OpenDialogOptions}, string | null>
    query_godot_docs: CommandSpec<{request: DocsQuery}, DocsResponse>
    read_agent_prompt: CommandSpec<undefined, AgentPrompt>
    read_chat_attachment: CommandSpec<{attachment: ChatAttachment}, string>
    read_clipboard_image: CommandSpec<undefined, ClipboardImage | null>
    read_godot_logs: CommandSpec<{query: GodotLogQuery}, GodotLogPage>
    read_project_sketch: CommandSpec<{id: string}, SketchHtml>
    read_project_state: CommandSpec<{key: string}, string | null>
    read_skill: CommandSpec<{name: string}, string>
    read_task_brief: CommandSpec<{taskId: string}, BriefRun | null>
    read_workspace_file: CommandSpec<{path: string}, WorkspaceFileContents>
    read_workspace_thumbnail: CommandSpec<{path: string}, string | null>
    resolve_task_merge: CommandSpec<{taskId: string}, ResolveTaskMergeResult>
    respond_chatgpt_login: CommandSpec<{value: string}, void>
    respond_tool_approval: CommandSpec<{request: ToolApprovalRequest}, void>
    respond_user_question: CommandSpec<{request: UserQuestionResponse}, void>
    run_storage_maintenance: CommandSpec<undefined, StorageMaintenanceResult>
    run_task_brief: CommandSpec<
        {request: RunTaskBriefRequest; stream: Channel<AiStreamPayload>},
        void
    >
    save_agent_prompt: CommandSpec<{prompt: string}, AgentPrompt>
    save_chat: CommandSpec<{chat: StoredChatPayload}, void>
    save_chat_attachment: CommandSpec<{request: AttachmentUpload}, void>
    save_godot_settings: CommandSpec<{godot: GodotSettings}, SettingsResponse>
    save_project_memory: CommandSpec<{edit: MemoryEdit}, ProjectMemory>
    save_script_document: CommandSpec<{request: SaveScriptRequest}, ScriptStamp>
    save_settings: CommandSpec<{request: SettingsRequest}, SettingsResponse>
    search_godot_log_history: CommandSpec<
        {request: GodotLogSearchRequest},
        readonly GodotLogSearchHit[]
    >
    send_ai_message: CommandSpec<
        {request: SendAiMessageRequest; stream: Channel<AiStreamPayload>},
        void
    >
    set_memory_states: CommandSpec<
        {ids: readonly string[]; state: MemoryState},
        readonly ProjectMemory[]
    >
    set_skill_enabled: CommandSpec<{name: string; enabled: boolean}, SkillsResponse>
    start_godot_session: CommandSpec<{request: StartGodotSessionRequest}, GodotSessionSummary>
    stop_godot_session: CommandSpec<undefined, void>
    subscribe_godot_events: CommandSpec<{events: Channel<GodotSessionEvent>}, void>
    subscribe_script_diagnostics: CommandSpec<{diagnostics: Channel<ScriptDiagnosticsEvent>}, void>
    sweep_project_memory: CommandSpec<
        {request: SweepMemoryRequest; stream: Channel<AiStreamPayload>},
        readonly ProjectMemory[]
    >
    test_ai_connection: CommandSpec<{request: SettingsRequest}, ConnectionTestResult>
    unsubscribe_godot_events: CommandSpec<undefined, void>
    unsubscribe_script_diagnostics: CommandSpec<undefined, void>
    unwatch_workspace_files: CommandSpec<undefined, void>
    update_script_document: CommandSpec<{request: UpdateScriptRequest}, ScriptStamp>
    watch_workspace_files: CommandSpec<{changes: Channel<readonly WorkspaceFileChange[]>}, void>
    write_project_state: CommandSpec<{key: string; value?: string}, void>
    write_skill: CommandSpec<{name: string; text: string}, SkillsResponse>
    write_workspace_file: CommandSpec<{request: WriteWorkspaceFileRequest}, WorkspaceFileStamp>
}>

type DesktopEventMap = Readonly<{
    'ai-approval-request': ToolApprovalPrompt
    'ai-approval-settled': ToolApprovalSettled
    'ai-brief': BriefEvent
    'ai-question-request': UserQuestionPrompt
    'ai-question-settled': UserQuestionSettled
    'ai-memory-judge': MemoryJudgeEvent
    'ai-memory-sweep': MemorySweepEvent
    'godot-session-event': GodotSessionEvent
    'rag-download-progress': DownloadProgress
    'settings-saved': SettingsResponse
}>

export type DesktopCommand = keyof DesktopCommandMap
export type DesktopEvent = keyof DesktopEventMap
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

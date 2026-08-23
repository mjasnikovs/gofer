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
import type {PendingChange, TaskSummary} from '../models/app'
import type {
    BriefEvent,
    BriefRun,
    DesignSessionEvent,
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
    /** Set when this turn replaces one that already ran, so the worker rolls the failed one back. */
    isRetry: boolean
}>

type AttachmentUpload = Readonly<{
    attachment: ChatAttachment
    data: string
}>

/** A PNG the backend read off the system clipboard, base64 encoded. */
export type ClipboardImage = Readonly<{
    width: number
    height: number
    pngBase64: string
}>

type BackupResult = Readonly<{path: string}>

/** Putting one memory to a read-only sub-agent: which turn it runs as, and which memory. */
type JudgeMemoryRequest = Readonly<{
    requestId: number
    memoryId: string
}>

/**
 * Putting a list of memories to the same sub-agent as one turn.
 *
 * The ids come from the panel rather than being chosen in Rust, because a judgement is a minute
 * each and only the person pressing the button can see whether that is worth paying for.
 */
type SweepMemoryRequest = Readonly<{
    requestId: number
    memoryIds: readonly string[]
}>

type ToolApprovalRequest = Readonly<{
    approvalId: string
    approved: boolean
}>

/** Starting a brief: which task it is for, and the ask it works from. */
type RunTaskBriefRequest = Readonly<{
    requestId: number
    taskId: string
    prompt: string
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

/** What bringing the project's branch into a task left for the agent to reconcile. */
export type ResolveTaskMergeResult = Readonly<{
    taskId: string
    /** Empty when the two branches merged on their own and there is nothing to resolve. */
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
    // Forgetting one memory, so no later turn is given it again.
    delete_project_memory: CommandSpec<{id: string}, void>
    delete_rag_cache: CommandSpec<undefined, CacheStatus>
    delete_workspace_path: CommandSpec<{request: DeleteWorkspacePathRequest}, void>
    edit_workspace_file: CommandSpec<{request: EditWorkspaceFileRequest}, WorkspaceFileStamp>
    format_gdscript: CommandSpec<{request: FormatGdscriptRequest}, FormatGdscriptResponse>
    get_godot_session: CommandSpec<undefined, GodotSessionSummary | undefined>
    get_rag_cache_status: CommandSpec<undefined, CacheStatus>
    import_legacy_chat: CommandSpec<{chat: StoredChat}, StoredChat>
    initialize_rag: CommandSpec<undefined, void>
    // Runs as a turn, so it takes the channel one does — that is what Stop reaches. Its own
    // progress rides `ai-memory-judge` window events instead: the panel is not the chat timeline.
    judge_project_memory: CommandSpec<
        {request: JudgeMemoryRequest; stream: Channel<AiStreamPayload>},
        ProjectMemory
    >
    list_ai_models: CommandSpec<{request: SettingsRequest}, readonly AiModelOption[]>
    // Every memory, each already checked against the files the workspace has now. The check is not
    // a second command: it is one directory walk, and one nobody would press a button for.
    list_project_memory: CommandSpec<undefined, readonly ProjectMemory[]>
    // Named, not drawn: a sketch's markup is fetched one at a time, because the copy the user
    // looked at has the project's artwork inlined into it.
    list_project_sketches: CommandSpec<undefined, readonly ProjectSketch[]>
    list_project_tasks: CommandSpec<undefined, readonly TaskSummary[]>
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
    // The clipboard's image, which the webview keeps from the paste event. Null when it holds
    // anything else.
    read_clipboard_image: CommandSpec<undefined, ClipboardImage | null>
    read_godot_logs: CommandSpec<{query: GodotLogQuery}, GodotLogPage>
    // Remembered interface state, as the JSON the renderer wrote. Absent when nothing is stored.
    read_project_sketch: CommandSpec<{id: string}, SketchHtml>
    read_project_state: CommandSpec<{key: string}, string | null>
    read_task_brief: CommandSpec<{taskId: string}, BriefRun | null>
    read_workspace_file: CommandSpec<{path: string}, WorkspaceFileContents>
    // A small `data:` square for a worktree picture. `null` for every file that is not one.
    read_workspace_thumbnail: CommandSpec<{path: string}, string | null>
    resolve_task_merge: CommandSpec<{taskId: string}, ResolveTaskMergeResult>
    respond_chatgpt_login: CommandSpec<{value: string}, void>
    respond_tool_approval: CommandSpec<{request: ToolApprovalRequest}, void>
    respond_user_question: CommandSpec<{request: UserQuestionResponse}, void>
    run_storage_maintenance: CommandSpec<undefined, StorageMaintenanceResult>
    // Runs as a turn, so it takes the same channel one does — the brief's own progress rides
    // `ai-brief` window events instead, because a phase is not part of an assistant message.
    run_task_brief: CommandSpec<
        {request: RunTaskBriefRequest; stream: Channel<AiStreamPayload>},
        void
    >
    save_agent_prompt: CommandSpec<{prompt: string}, AgentPrompt>
    save_chat: CommandSpec<{chat: StoredChatPayload}, void>
    save_chat_attachment: CommandSpec<{request: AttachmentUpload}, void>
    // The Godot rules alone. Separate from save_settings because the tab has no Save of its own,
    // and a checkbox must not store another tab's half-typed draft as a side effect.
    save_godot_settings: CommandSpec<{godot: GodotSettings}, SettingsResponse>
    // Only the three fields the window may change. The backend carries provenance, the task and any
    // supersession across, because the upsert behind this overwrites whatever it is handed.
    save_project_memory: CommandSpec<{edit: MemoryEdit}, ProjectMemory>
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
    // Bulk triage, and only the state: the rows keep their words, their verdict and the reason it
    // was given, and stop reaching the prompt. It re-embeds nothing, because nothing was rewritten.
    set_memory_states: CommandSpec<
        {ids: readonly string[]; state: MemoryState},
        readonly ProjectMemory[]
    >
    start_godot_session: CommandSpec<{request: StartGodotSessionRequest}, GodotSessionSummary>
    stop_godot_session: CommandSpec<undefined, void>
    subscribe_godot_events: CommandSpec<{events: Channel<GodotSessionEvent>}, void>
    // Published diagnostics arrive on this channel until the renderer unsubscribes.
    subscribe_script_diagnostics: CommandSpec<{diagnostics: Channel<ScriptDiagnosticsEvent>}, void>
    // One turn for the whole list, which is what makes Stop reach the run rather than whichever
    // memory is in flight. The count rides `ai-memory-sweep`; each row's spinner still rides the
    // judge's own event.
    sweep_project_memory: CommandSpec<
        {request: SweepMemoryRequest; stream: Channel<AiStreamPayload>},
        readonly ProjectMemory[]
    >
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
    /**
     * A brief's progress. An event rather than the turn's channel, because the chat timeline drops
     * every event it does not draw — and a phase is not part of an assistant message.
     */
    'ai-brief': BriefEvent
    'ai-question-request': UserQuestionPrompt
    'ai-question-settled': UserQuestionSettled
    /** How judging one memory is going, and how it ended. Not the chat's, so not the channel's. */
    'ai-memory-judge': MemoryJudgeEvent
    /** How far through the list a sweep is, and how it ended. One event for the run, not the row. */
    'ai-memory-sweep': MemorySweepEvent
    /**
     * A design loop's two edges. Between them the question card holds itself open, because the
     * rounds are one layout being revised rather than a queue of unrelated questions.
     */
    'ai-design-opened': DesignSessionEvent
    'ai-design-closed': DesignSessionEvent
    'godot-session-event': GodotSessionEvent
    'rag-download-progress': DownloadProgress
    /** What the settings file now says, sent by whichever screen saved it to every other one. */
    'settings-saved': SettingsResponse
}>

export type DesktopCommand = keyof DesktopCommandMap
/** Every event the backend sends, so a listener cannot subscribe to one that is never emitted. */
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

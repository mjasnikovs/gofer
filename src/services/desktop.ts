import {invoke as tauriInvoke, isTauri as tauriIsTauri} from '@tauri-apps/api/core'
import {listen as tauriListen} from '@tauri-apps/api/event'
import type {EventCallback, UnlistenFn} from '@tauri-apps/api/event'
import type {DownloadProgress} from '@mjasnikovs/gofer-rag'
import type {TaskSummary} from '../models/app'
import type {
    AiStreamPayload,
    ChatAttachment,
    GodotProcessEvent,
    Message,
    StoredChat
} from '../models/chat'
import type {
    AiModelOption,
    CacheStatus,
    ConnectionTestResult,
    SettingsRequest,
    SettingsResponse,
    StorageMaintenanceResult
} from '../models/settings'

type CommandSpec<Arguments, Response> = Readonly<{
    arguments: Arguments
    response: Response
}>

type ChatMessageInput = Pick<Message, 'sender' | 'text' | 'timestamp' | 'attachments'>

type SendAiMessageRequest = Readonly<{
    requestId: number
    taskId?: string | undefined
    agentMessages: readonly unknown[]
    messages: readonly ChatMessageInput[]
}>

type AttachmentUpload = Readonly<{
    attachment: ChatAttachment
    data: string
}>

type LaunchGodotRequest = Readonly<{
    taskId?: string | undefined
    editor: boolean
    scene?: string
}>

type BackupResult = Readonly<{path: string}>

type ProtocolRequest = Readonly<{
    protocolVersion: number
    id: string
    command: string
    params: Readonly<Record<string, unknown>>
}>

type StoredChatPayload = Omit<StoredChat, 'taskId'>
    & Readonly<{
        taskId?: string | undefined
    }>

type DesktopCommandMap = Readonly<{
    activate_chat_task: CommandSpec<{taskId: string}, StoredChat>
    cancel_ai_request: CommandSpec<{requestId: number}, boolean>
    cancel_godot: CommandSpec<undefined, void>
    create_chat_task: CommandSpec<undefined, StoredChat>
    create_project_backup: CommandSpec<undefined, BackupResult>
    delete_rag_cache: CommandSpec<undefined, CacheStatus>
    get_rag_cache_status: CommandSpec<undefined, CacheStatus>
    import_legacy_chat: CommandSpec<{chat: StoredChat}, StoredChat>
    initialize_rag: CommandSpec<undefined, void>
    launch_godot: CommandSpec<{request: LaunchGodotRequest}, void>
    list_ai_models: CommandSpec<{request: SettingsRequest}, readonly AiModelOption[]>
    list_project_tasks: CommandSpec<undefined, readonly TaskSummary[]>
    load_chat: CommandSpec<undefined, StoredChat>
    load_settings: CommandSpec<undefined, SettingsResponse>
    merge_task_worktree: CommandSpec<{taskId: string}, unknown>
    read_chat_attachment: CommandSpec<{attachment: ChatAttachment}, string>
    run_storage_maintenance: CommandSpec<undefined, StorageMaintenanceResult>
    save_chat: CommandSpec<{chat: StoredChatPayload}, void>
    save_chat_attachment: CommandSpec<{request: AttachmentUpload}, void>
    save_settings: CommandSpec<{request: SettingsRequest}, SettingsResponse>
    send_godot_command: CommandSpec<{address: string; request: ProtocolRequest}, unknown>
    send_ai_message: CommandSpec<{request: SendAiMessageRequest}, void>
    test_ai_connection: CommandSpec<{request: SettingsRequest}, ConnectionTestResult>
}>

type DesktopEventMap = Readonly<{
    'ai-stream-event': AiStreamPayload
    'godot-process-event': GodotProcessEvent
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

import {Channel} from '@tauri-apps/api/core'
import {invoke} from './desktop'
import {toCommandError} from '../utils/command-error'
import type {
    GodotCommandName,
    GodotCommandParams,
    GodotCommandResult
} from '../models/godot-commands'
import type {
    DebugRequest,
    DebugResponse,
    DocsQuery,
    DocsResponse,
    GodotCallOptions,
    GodotError,
    GodotLogPage,
    GodotLogQuery,
    GodotLogSearchHit,
    GodotLogSearchRequest,
    GodotSessionEvent,
    GodotSessionSummary
} from '../models/godot'

export function startGodotSession(): Promise<GodotSessionSummary> {
    return invoke('start_godot_session', {request: {}})
}

export function stopGodotSession(): Promise<void> {
    return invoke('stop_godot_session')
}

export function getGodotSession(): Promise<GodotSessionSummary | undefined> {
    return invoke('get_godot_session')
}

export async function callGodot<Name extends GodotCommandName>(
    command: Name,
    params: GodotCommandParams<Name> = {},
    options: GodotCallOptions = {}
): Promise<GodotCommandResult<Name>> {
    const response = await invoke('call_godot', {
        request: {
            command,
            params,
            ...(options.expectedRevision !== undefined && {
                expectedRevision: options.expectedRevision
            }),
            ...(options.timeoutMs !== undefined && {timeoutMs: options.timeoutMs})
        }
    })
    return response.result
}

export function callGodotDebug(request: DebugRequest): Promise<DebugResponse> {
    return invoke('call_godot_debug', {request})
}

export function readGodotLogs(query: GodotLogQuery): Promise<GodotLogPage> {
    return invoke('read_godot_logs', {query})
}

export function searchGodotLogHistory(
    request: GodotLogSearchRequest
): Promise<readonly GodotLogSearchHit[]> {
    return invoke('search_godot_log_history', {request})
}

export function queryGodotDocs(query: DocsQuery): Promise<DocsResponse> {
    return invoke('query_godot_docs', {request: query})
}

export async function subscribeGodotEvents(
    handler: (event: GodotSessionEvent) => void
): Promise<void> {
    const events = new Channel<GodotSessionEvent>()
    events.onmessage = handler
    await invoke('subscribe_godot_events', {events})
}

export function unsubscribeGodotEvents(): Promise<void> {
    return invoke('unsubscribe_godot_events')
}

export const toGodotError: (error: unknown) => GodotError = toCommandError

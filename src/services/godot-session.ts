import {Channel} from '@tauri-apps/api/core'
import {invoke} from './desktop'
import {toCommandError} from '../utils/command-error'
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

/**
 * The renderer's half of the Godot session commands. Every editor operation the workspace performs
 * lands on the same Rust handlers the AI tool router calls, so a panel and an agent turn cannot
 * disagree about what an operation does.
 */

export function startGodotSession(): Promise<GodotSessionSummary> {
    return invoke('start_godot_session', {request: {}})
}

export function stopGodotSession(): Promise<void> {
    return invoke('stop_godot_session')
}

export function getGodotSession(): Promise<GodotSessionSummary | undefined> {
    return invoke('get_godot_session')
}

/** One addon command. The id correlates the reply; Rust rejects a call with no active session. */
export async function callGodot(
    command: string,
    params: Readonly<Record<string, unknown>> = {},
    options: GodotCallOptions = {}
): Promise<Readonly<Record<string, unknown>>> {
    const response = await invoke('call_godot', {
        request: {
            id: crypto.randomUUID(),
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

/**
 * Searches the stored history instead of the live buffer.
 *
 * `readGodotLogs` answers from the session that is running now; this reaches the archive behind it,
 * so a warning from a session that has already stopped is still findable.
 */
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

/** The shared converter, under the name the session panels read it by. */
export const toGodotError: (error: unknown) => GodotError = toCommandError

import type {GodotError, GodotLogEntry, GodotLogPage} from './godot'

export const MAX_ENTRIES = 500

export type SessionLogs = Readonly<{
    entries: readonly GodotLogEntry[]
    dropped: number
    cursor?: number | undefined
    isFirstPage: boolean
    error?: GodotError | undefined
}>

export type SessionLogAction =
    | Readonly<{type: 'restarted'}>
    | Readonly<{type: 'page-read'; page: GodotLogPage}>
    | Readonly<{type: 'failed'; error: GodotError}>
    | Readonly<{type: 'cleared'}>

export const INITIAL_SESSION_LOGS: SessionLogs = {
    entries: [],
    dropped: 0,
    isFirstPage: true
}

export function reduceSessionLogs(state: SessionLogs, action: SessionLogAction): SessionLogs {
    switch (action.type) {
        case 'restarted':
            return {...state, cursor: undefined, isFirstPage: true, error: undefined}

        case 'page-read': {
            const {page} = action
            if (state.isFirstPage) {
                return {
                    entries: page.entries.slice(-MAX_ENTRIES),
                    dropped: page.dropped,
                    cursor: page.cursor,
                    isFirstPage: false,
                    error: undefined
                }
            }
            return {
                ...state,
                entries:
                    page.entries.length === 0 ?
                        state.entries
                    :   [...state.entries, ...page.entries].slice(-MAX_ENTRIES),
                dropped: page.dropped,
                cursor: page.cursor,
                error: undefined
            }
        }

        case 'failed':
            return {...state, error: action.error}

        case 'cleared':
            return state.entries.length === 0 ? state : {...state, entries: []}
    }
}

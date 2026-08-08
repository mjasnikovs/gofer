import type {GodotError, GodotLogEntry, GodotLogPage} from './godot'

/** How many lines the panel keeps on screen. The backend's own ring buffer is the real bound. */
export const MAX_ENTRIES = 500

/**
 * What the output panel is showing, as one value.
 *
 * The cursor lives here beside the lines it produced. Kept apart — in a ref, as it was — a filter
 * change could reset one without the other, and the panel would append the new query's first page
 * onto the previous query's lines while reporting a `dropped` count belonging to neither.
 */
export type SessionLogs = Readonly<{
    entries: readonly GodotLogEntry[]
    /** What the backend's ring buffer discarded before this panel asked for it. */
    dropped: number
    /** Where the next read starts, or absent at the beginning of a subscription. */
    cursor?: number | undefined
    /** Whether the next page replaces what is on screen rather than being added to it. */
    isFirstPage: boolean
    error?: GodotError | undefined
}>

export type SessionLogAction =
    /** A filter changed, so the query is a different one and its first page starts over. */
    | Readonly<{type: 'restarted'}>
    | Readonly<{type: 'page-read'; page: GodotLogPage}>
    | Readonly<{type: 'failed'; error: GodotError}>
    /** The user emptied the panel. The cursor is untouched: the lines already read are gone. */
    | Readonly<{type: 'cleared'}>

export const INITIAL_SESSION_LOGS: SessionLogs = {
    entries: [],
    dropped: 0,
    isFirstPage: true
}

export function reduceSessionLogs(state: SessionLogs, action: SessionLogAction): SessionLogs {
    switch (action.type) {
        /*
         * A filter belongs to the query, not to what is on screen. The backend is the only place
         * that still holds the lines the previous filter excluded, so the subscription starts again
         * from the oldest buffered line rather than sieving what has already been shown.
         */
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

        // The lines already on screen stay. A poll that could not reach the editor says nothing
        // about the output it read a second ago.
        case 'failed':
            return {...state, error: action.error}

        case 'cleared':
            return state.entries.length === 0 ? state : {...state, entries: []}
    }
}

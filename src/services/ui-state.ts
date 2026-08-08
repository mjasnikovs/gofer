import {invoke, isTauri} from './desktop'

/** How the whole workspace was left: tabs, sizes, filters, open scripts, the chosen node. */
export const WORKSPACE_LAYOUT_KEY = 'ui.workspace'
/** Monaco's cursor and scroll for each open script. Written far more often than the layout. */
export const SCRIPT_VIEWS_KEY = 'ui.scriptViews'

/** The key one task's unsent message is kept under. Mirrors `draft_ui_key` in the Rust storage. */
export function draftKey(taskId: string) {
    return `ui.draft.${taskId}`
}

/**
 * Long enough that typing and dragging do not write once per event, short enough that a window
 * closed straight after a change still records it.
 */
const WRITE_DEBOUNCE_MS = 250

const pending = new Map<string, unknown>()
const timers = new Map<string, ReturnType<typeof setTimeout>>()

function send(key: string, value: unknown) {
    pending.delete(key)
    void invoke('write_project_state', {
        key,
        ...(value === undefined ? {} : {value: JSON.stringify(value)})
    }).catch(() => {
        // Remembering the layout is a convenience. Failing to is not something to interrupt the
        // user over, and the next change tries again.
    })
}

/**
 * Reads one remembered piece of interface state, or `undefined` when the project has none.
 *
 * Never throws: a database that will not answer, a value stored by a version that wrote it
 * differently, and a browser with no desktop backend behind it all mean the same thing to the
 * caller — mount with the defaults.
 */
export async function readProjectState(key: string): Promise<unknown> {
    if (!isTauri()) return undefined
    try {
        const stored = await invoke('read_project_state', {key})
        return typeof stored === 'string' ? JSON.parse(stored) : undefined
    } catch {
        return undefined
    }
}

/** Records one piece of interface state, coalescing the writes of a drag or a burst of typing. */
export function writeProjectState(key: string, value: unknown) {
    if (!isTauri()) return
    pending.set(key, value)
    const running = timers.get(key)
    if (running !== undefined) clearTimeout(running)
    timers.set(
        key,
        setTimeout(() => {
            timers.delete(key)
            send(key, value)
        }, WRITE_DEBOUNCE_MS)
    )
}

/** Writes whatever is still waiting out, so a window closing mid-debounce does not lose it. */
export function flushProjectState() {
    for (const timer of timers.values()) clearTimeout(timer)
    timers.clear()
    for (const [key, value] of [...pending]) send(key, value)
}

if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', flushProjectState)
}

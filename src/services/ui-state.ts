import {schedule} from './clock'
import {invoke, isTauri} from './desktop'
import type {WriteScheduler} from './clock'

/** How the whole workspace was left: tabs, sizes, filters, open scripts, the chosen node. */
export const WORKSPACE_LAYOUT_KEY = 'ui.workspace'
/** Monaco's cursor and scroll for each open script. Written far more often than the layout. */
export const SCRIPT_VIEWS_KEY = 'ui.scriptViews'
/** Whether the task sidebar was left collapsed, and how wide it was dragged. */
export const SIDE_NAV_KEY = 'ui.sideNav'

/** The key one task's unsent message is kept under. Mirrors `draft_ui_key` in the Rust storage. */
export function draftKey(taskId: string) {
    return `ui.draft.${taskId}`
}

/**
 * Long enough that typing and dragging do not write once per event, short enough that a window
 * closed straight after a change still records it.
 */
export const WRITE_DEBOUNCE_MS = 250

/** One project's worth of pending writes, holding whatever clock it was built with. */
export type ProjectStateWriter = Readonly<{
    write: (key: string, value: unknown) => void
    flush: () => void
}>

export function createProjectStateWriter(
    delay: WriteScheduler,
    delayMs = WRITE_DEBOUNCE_MS
): ProjectStateWriter {
    const pending = new Map<string, unknown>()
    const cancels = new Map<string, () => void>()

    const send = (key: string, value: unknown) => {
        pending.delete(key)
        cancels.delete(key)
        void invoke('write_project_state', {
            key,
            ...(value === undefined ? {} : {value: JSON.stringify(value)})
        }).catch(() => {
            // Remembering the layout is a convenience. Failing to is not something to interrupt
            // the user over, and the next change tries again.
        })
    }

    return {
        write(key, value) {
            if (!isTauri()) return
            pending.set(key, value)
            cancels.get(key)?.()
            cancels.set(
                key,
                delay(() => {
                    send(key, value)
                }, delayMs)
            )
        },
        flush() {
            for (const cancel of cancels.values()) cancel()
            cancels.clear()
            for (const [key, value] of [...pending]) send(key, value)
        }
    }
}

// Built with the shared clock rather than a clock of its own, so `setScheduler` reaches it without
// this module having to be told about the swap.
const writer = createProjectStateWriter(schedule)

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
    writer.write(key, value)
}

/** Writes whatever is still waiting out, so a window closing mid-debounce does not lose it. */
export function flushProjectState() {
    writer.flush()
}

/**
 * Starts listening for the window closing, and hands back a way to stop.
 *
 * Called from the entry point rather than run on import: a module that attaches a global listener
 * merely because something imported it cannot be loaded by a test without also being started.
 */
export function watchForWindowClose(): () => void {
    if (typeof window === 'undefined') return () => undefined
    window.addEventListener('beforeunload', flushProjectState)
    return () => {
        window.removeEventListener('beforeunload', flushProjectState)
    }
}

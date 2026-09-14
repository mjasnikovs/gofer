import {schedule} from './clock'
import {invoke, isTauri} from './desktop'
import type {WriteScheduler} from './clock'

export const WORKSPACE_LAYOUT_KEY = 'ui.workspace'
export const SCRIPT_VIEWS_KEY = 'ui.scriptViews'
export const SIDE_NAV_KEY = 'ui.sideNav'

export function draftKey(taskId: string) {
    return `ui.draft.${taskId}`
}

/** Where a card's pictures wait for the task's composer. Read once, then cleared. */
export function draftAttachmentsKey(taskId: string) {
    return `ui.draftAttachments.${taskId}`
}

export const WRITE_DEBOUNCE_MS = 250

type PendingWrite = Readonly<{value: unknown}>

export type ProjectStateWriter = Readonly<{
    write: (key: string, value: unknown) => void
    flush: () => void
    pending: (key: string) => PendingWrite | undefined
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
        }).catch(() => undefined)
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
        },
        pending(key) {
            return pending.has(key) ? {value: pending.get(key)} : undefined
        }
    }
}

const writer = createProjectStateWriter(schedule)

export async function readProjectState(key: string): Promise<unknown> {
    if (!isTauri()) return undefined
    // A workspace remounted inside the debounce, like the board opening a task, must see its own change.
    const unsent = writer.pending(key)
    if (unsent) return unsent.value
    try {
        const stored = await invoke('read_project_state', {key})
        return typeof stored === 'string' ? JSON.parse(stored) : undefined
    } catch {
        return undefined
    }
}

export function writeProjectState(key: string, value: unknown) {
    writer.write(key, value)
}

export function flushProjectState() {
    writer.flush()
}

export function watchForWindowClose(): () => void {
    if (typeof window === 'undefined') return () => undefined
    window.addEventListener('beforeunload', flushProjectState)
    return () => {
        window.removeEventListener('beforeunload', flushProjectState)
    }
}

import {Channel} from '@tauri-apps/api/core'
import {invoke} from './desktop'
import type {WorkspaceFileChange} from '../models/files'
import type {WorkspaceEntry} from '../models/script'

type ChangeHandler = (changes: readonly WorkspaceFileChange[]) => void

export function listWorkspaceFiles(): Promise<readonly WorkspaceEntry[]> {
    return invoke('list_workspace_files')
}

// The backend holds one watcher, and starting a second stops the first; so every subscriber shares
// the one this module opens.
const handlers = new Set<ChangeHandler>()
let isWatching = false
// Set when the last subscriber leaves. The next one gets a fresh watcher even if the old one never
// stopped, because a task switch remounts everyone at once onto a different folder.
let wantsFreshWatcher = false
let settling: Promise<unknown> = Promise.resolve()

function settle(): Promise<void> {
    const step = settling.then(async () => {
        if (handlers.size > 0 && (!isWatching || wantsFreshWatcher)) {
            wantsFreshWatcher = false
            const changes = new Channel<readonly WorkspaceFileChange[]>()
            changes.onmessage = batch => {
                for (const handler of handlers) handler(batch)
            }
            await invoke('watch_workspace_files', {changes})
            isWatching = true
        } else if (handlers.size === 0 && isWatching) {
            isWatching = false
            await invoke('unwatch_workspace_files')
        }
    })
    settling = step.catch(() => undefined)
    return step
}

/** Answers with the call that ends this subscription. */
export async function subscribeWorkspaceChanges(
    handler: ChangeHandler
): Promise<() => Promise<void>> {
    handlers.add(handler)
    const unsubscribe = () => {
        handlers.delete(handler)
        if (handlers.size === 0) wantsFreshWatcher = true
        return settle()
    }
    try {
        await settle()
    } catch (error) {
        await unsubscribe().catch(() => undefined)
        throw error
    }
    return unsubscribe
}

import {Channel} from '@tauri-apps/api/core'
import {invoke} from './desktop'
import type {WorkspaceFileChange} from '../models/files'
import type {WorkspaceEntry} from '../models/script'

/**
 * File access for the renderer. The watcher reports paths only — a worktree holds game assets, so
 * a caller that cares about content re-reads the file and compares hashes.
 */

export function listWorkspaceFiles(): Promise<readonly WorkspaceEntry[]> {
    return invoke('list_workspace_files')
}

export async function subscribeWorkspaceChanges(
    handler: (changes: readonly WorkspaceFileChange[]) => void
): Promise<void> {
    const changes = new Channel<readonly WorkspaceFileChange[]>()
    changes.onmessage = handler
    await invoke('watch_workspace_files', {changes})
}

export function unsubscribeWorkspaceChanges(): Promise<void> {
    return invoke('unwatch_workspace_files')
}

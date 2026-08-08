import {invoke} from './desktop'
import type {OpenDialogOptions} from '@tauri-apps/plugin-dialog'
import type {HealthRemedyRequest} from '../models/health'

/**
 * The renderer's half of the workspace health check, and the file picker its remedies need.
 *
 * The picker is here rather than in the gate because it is the same kind of thing: a call out of
 * the renderer that a test has to be able to answer without knowing a plugin's command name.
 */

export function checkWorkspaceHealth() {
    return invoke('check_workspace_health')
}

export function applyHealthRemedy(request: HealthRemedyRequest) {
    return invoke('apply_health_remedy', {request})
}

/** Answers with `undefined` when the user changed their mind, which is not a failure. */
export async function choosePath(options: OpenDialogOptions) {
    const chosen = await invoke('plugin:dialog|open', {options})
    return typeof chosen === 'string' ? chosen : undefined
}

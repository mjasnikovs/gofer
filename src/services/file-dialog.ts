import {invoke} from './desktop'
import type {OpenDialogOptions} from '@tauri-apps/plugin-dialog'

/**
 * The native file picker, behind a name the renderer can call and a test can answer.
 *
 * It is here rather than at its call site because it is not a pass-through: the plugin's command
 * answers with the chosen path, an array of them, or `null` for a dialog the user dismissed, and
 * every caller wants the same one of those three.
 */

/** Answers with `undefined` when the user changed their mind, which is not a failure. */
export async function choosePath(options: OpenDialogOptions) {
    const chosen = await invoke('plugin:dialog|open', {options})
    return typeof chosen === 'string' ? chosen : undefined
}

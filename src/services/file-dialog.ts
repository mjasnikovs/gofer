import {invoke} from './desktop'
import type {OpenDialogOptions} from '@tauri-apps/plugin-dialog'

export async function choosePath(options: OpenDialogOptions) {
    const chosen = await invoke('plugin:dialog|open', {options})
    return typeof chosen === 'string' ? chosen : undefined
}

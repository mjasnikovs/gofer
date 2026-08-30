import type * as Monaco from 'monaco-editor'
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker'
import {registerGdscript} from './monaco-gdscript'
import {GOFER_EDITOR_THEME, goferEditorTheme} from './monaco-theme'

declare global {
    interface Window {
        MonacoEnvironment?: Monaco.Environment
    }
}

let pending: Promise<typeof Monaco> | undefined

export function loadMonaco(): Promise<typeof Monaco> {
    pending ??= import('monaco-editor').then(monaco => {
        self.MonacoEnvironment = {getWorker: () => new EditorWorker()}
        registerGdscript(monaco)
        monaco.editor.defineTheme(GOFER_EDITOR_THEME, goferEditorTheme())
        return monaco
    })
    return pending
}

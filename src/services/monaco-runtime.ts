import type * as Monaco from 'monaco-editor'
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker'
import {registerGdscript} from './monaco-gdscript'

/**
 * Loads Monaco once, on demand.
 *
 * The editor is several megabytes, so it is not part of the application entry: the first script a
 * user opens pays for it. Its web worker is bundled by Vite and served from the application
 * origin, which is why the production CSP grants `worker-src 'self' blob:` — Monaco loads the
 * worker through a blob URL when the bundle and the document share an origin.
 *
 * Only the base editor worker is registered because every file Gofer opens is either GDScript,
 * whose intelligence comes from Godot's language server, or plain text.
 */

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
        return monaco
    })
    return pending
}

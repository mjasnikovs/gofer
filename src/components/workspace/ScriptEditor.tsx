import {useCallback, useEffect, useRef, useState} from 'react'
import type * as Monaco from 'monaco-editor'
import {StackItem} from '@astryxdesign/core/Stack'
import {languageForPath} from '../../services/monaco-gdscript'
import {loadMonaco} from '../../services/monaco-runtime'
import {
    modelUri,
    registerScriptProviders,
    toMarkers,
    toScriptPosition,
    workspacePathFromUri
} from '../../services/monaco-lsp'
import {callScriptLanguage} from '../../services/script-session'
import type {ScriptDiagnostic, ScriptPosition} from '../../models/script'
import type {ScriptBuffer} from '../../hooks/useScriptBuffers'
import {GDSCRIPT_LANGUAGE_ID} from '../../services/monaco-gdscript'

type ScriptEditorProps = Readonly<{
    buffer: ScriptBuffer
    diagnostics: readonly ScriptDiagnostic[]
    /**
     * Where another panel asked the editor to go. `at` is the click that asked, so choosing the
     * same problem twice reveals it twice.
     */
    reveal?: Readonly<{path: string; line: number; at: number}> | undefined
    /** Every open tab, so models for closed files are disposed instead of leaking. */
    openPaths: readonly string[]
    onChange: (path: string, text: string) => void
    onSave: (path: string) => void
    onRename: (path: string, position: ScriptPosition) => void
    onToggleBreakpoint: (path: string, line: number) => void
    onOpenPath: (path: string) => void
    onError: (message: string) => void
}>

const EDITOR_HOST_STYLE = {minHeight: 0, width: '100%'} as const
const MARKER_OWNER = 'gofer-lsp'

const EDITOR_OPTIONS: Monaco.editor.IStandaloneEditorConstructionOptions = {
    automaticLayout: true,
    glyphMargin: true,
    minimap: {enabled: false},
    scrollBeyondLastLine: false,
    fontSize: 13,
    tabSize: 4,
    insertSpaces: true,
    renderWhitespace: 'selection'
}

/**
 * Hosts Monaco for the active buffer.
 *
 * One model per open file lives for as long as its tab does, so switching tabs keeps undo history
 * and scroll position. Text only flows into a model from outside when it actually differs — a
 * reload, a rename, or a formatter apply — and that write is flagged so it is not echoed back as a
 * user edit.
 */
export function ScriptEditor({
    buffer,
    diagnostics,
    reveal,
    openPaths,
    onChange,
    onSave,
    onRename,
    onToggleBreakpoint,
    onOpenPath,
    onError
}: ScriptEditorProps) {
    const hostRef = useRef<HTMLElement | null>(null)
    const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | undefined>(undefined)
    const modelsRef = useRef(new Map<string, Monaco.editor.ITextModel>())
    const viewStatesRef = useRef(new Map<string, Monaco.editor.ICodeEditorViewState | null>())
    const decorationsRef = useRef<Monaco.editor.IEditorDecorationsCollection | undefined>(undefined)
    const applyingRef = useRef(false)
    const [monaco, setMonaco] = useState<typeof Monaco>()

    // Monaco listeners are registered once against a live editor, so the newest callbacks are read
    // through a ref instead of re-registering every render.
    const handlers = useRef({onChange, onSave, onRename, onToggleBreakpoint, onOpenPath})
    useEffect(() => {
        handlers.current = {onChange, onSave, onRename, onToggleBreakpoint, onOpenPath}
    }, [onChange, onSave, onRename, onToggleBreakpoint, onOpenPath])

    const reportError = useCallback(
        (error: unknown) => {
            onError(`The language server request failed: ${String(error)}`)
        },
        [onError]
    )

    useEffect(() => {
        let cancelled = false
        void loadMonaco()
            .then(loaded => {
                if (!cancelled) setMonaco(loaded)
            })
            .catch((error: unknown) => {
                onError(`The code editor could not be loaded: ${String(error)}`)
            })
        return () => {
            cancelled = true
        }
    }, [onError])

    useEffect(() => {
        if (!monaco) return
        const providers = registerScriptProviders(monaco, GDSCRIPT_LANGUAGE_ID, {
            request: callScriptLanguage,
            pathForModel: model => {
                const path = workspacePathFromUri(model.uri)
                return path === '' ? undefined : path
            },
            onError: reportError
        })
        // Go-to-definition across files opens the target as a tab instead of failing silently,
        // which is what a standalone editor does with a model it does not hold.
        const opener = monaco.editor.registerEditorOpener({
            openCodeEditor: (_source, resource) => {
                const path = workspacePathFromUri(resource)
                if (path === '') return false
                handlers.current.onOpenPath(path)
                return true
            }
        })
        return () => {
            providers.dispose()
            opener.dispose()
        }
    }, [monaco, reportError])

    useEffect(() => {
        if (!monaco || !hostRef.current || editorRef.current) return
        const editor = monaco.editor.create(hostRef.current, EDITOR_OPTIONS)
        editorRef.current = editor
        decorationsRef.current = editor.createDecorationsCollection([])
        const changed = editor.onDidChangeModelContent(() => {
            if (applyingRef.current) return
            const model = editor.getModel()
            if (!model) return
            handlers.current.onChange(workspacePathFromUri(model.uri), model.getValue())
        })
        const clicked = editor.onMouseDown(event => {
            const model = editor.getModel()
            // The glyph margin is the breakpoint gutter; clicks anywhere else are the editor's.
            if (!model || event.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) {
                return
            }
            handlers.current.onToggleBreakpoint(
                workspacePathFromUri(model.uri),
                event.target.position.lineNumber
            )
        })
        editor.addAction({
            id: 'gofer.saveScript',
            label: 'Save Script',
            keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
            run: current => {
                const model = current.getModel()
                if (model) handlers.current.onSave(workspacePathFromUri(model.uri))
            }
        })
        // Renaming runs through Gofer's own preview rather than Monaco's rename widget: the edit
        // is applied as one validated filesystem transaction, not as model edits.
        editor.addAction({
            id: 'gofer.renameSymbol',
            label: 'Rename Symbol (Preview)',
            keybindings: [monaco.KeyCode.F2],
            contextMenuGroupId: 'navigation',
            run: current => {
                const model = current.getModel()
                const position = current.getPosition()
                if (!model || !position) return
                handlers.current.onRename(
                    workspacePathFromUri(model.uri),
                    toScriptPosition(position)
                )
            }
        })
        return () => {
            changed.dispose()
            clicked.dispose()
            editor.dispose()
            editorRef.current = undefined
            decorationsRef.current = undefined
        }
    }, [monaco])

    // One model per open path, disposed when its tab closes.
    useEffect(() => {
        if (!monaco) return
        const models = modelsRef.current
        for (const [path, model] of models) {
            if (openPaths.includes(path)) continue
            model.dispose()
            models.delete(path)
            viewStatesRef.current.delete(path)
        }
    }, [monaco, openPaths])

    useEffect(() => {
        const editor = editorRef.current
        if (!monaco || !editor) return
        const models = modelsRef.current
        let model = models.get(buffer.path)
        if (!model || model.isDisposed()) {
            model = monaco.editor.createModel(
                buffer.text,
                languageForPath(buffer.path),
                modelUri(monaco, buffer.path)
            )
            models.set(buffer.path, model)
        }
        if (editor.getModel() !== model) {
            const previous = editor.getModel()
            if (previous) {
                viewStatesRef.current.set(
                    workspacePathFromUri(previous.uri),
                    editor.saveViewState()
                )
            }
            editor.setModel(model)
            const restored = viewStatesRef.current.get(buffer.path)
            if (restored) editor.restoreViewState(restored)
        }
        if (model.getValue() !== buffer.text) {
            applyingRef.current = true
            // `pushEditOperations` keeps undo history; `setValue` would discard it.
            model.pushEditOperations(
                [],
                [{range: model.getFullModelRange(), text: buffer.text}],
                () => null
            )
            applyingRef.current = false
        }
    }, [buffer.path, buffer.text, monaco])

    useEffect(() => {
        if (!monaco) return
        const model = modelsRef.current.get(buffer.path)
        if (!model || model.isDisposed()) return
        monaco.editor.setModelMarkers(model, MARKER_OWNER, [...toMarkers(diagnostics)])
    }, [buffer.path, diagnostics, monaco])

    // Reveals what the Problems list or a debugger frame pointed at, once the buffer it names is
    // the one on screen.
    useEffect(() => {
        const editor = editorRef.current
        if (!monaco || !editor || !reveal) return
        if (reveal.path !== buffer.path) return
        editor.revealLineInCenter(reveal.line)
        editor.setPosition({lineNumber: reveal.line, column: 1})
        editor.focus()
    }, [buffer.path, monaco, reveal])

    useEffect(() => {
        const collection = decorationsRef.current
        if (!monaco || !collection) return
        collection.set(
            buffer.breakpoints.map(line => ({
                range: new monaco.Range(line, 1, line, 1),
                options: {
                    isWholeLine: false,
                    glyphMarginClassName: 'gofer-breakpoint',
                    glyphMarginHoverMessage: {value: 'Breakpoint'},
                    stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges
                }
            }))
        )
    }, [buffer.breakpoints, buffer.path, monaco])

    return (
        <StackItem
            ref={hostRef}
            size='fill'
            style={EDITOR_HOST_STYLE}
            data-testid='script-editor-host'
        />
    )
}

import {useCallback, useEffect, useRef, useState} from 'react'
import type * as Monaco from 'monaco-editor'
import {StackItem} from '@astryxdesign/core/Stack'
import {schedule} from '../../services/clock'
import {languageForPath} from '../../services/monaco-gdscript'
import {loadMonaco} from '../../services/monaco-runtime'
import {GOFER_EDITOR_THEME} from '../../services/monaco-theme'
import {
    modelUri,
    registerScriptProviders,
    toMarkers,
    toScriptPosition,
    workspacePathFromUri
} from '../../services/monaco-lsp'
import {callScriptLanguage} from '../../services/script-session'
import {commandErrorMessage} from '../../utils/command-error'
import type {ScriptDiagnostic, ScriptPosition} from '../../models/script'
import type {ScriptViews} from '../../models/ui-state'
import type {ScriptBuffer} from '../../hooks/useScriptBuffers'
import {useWorkspaceFailure} from '../../hooks/useWorkspaceFailure'
import {GDSCRIPT_LANGUAGE_ID} from '../../services/monaco-gdscript'

type ScriptEditorProps = Readonly<{
    buffer: ScriptBuffer
    diagnostics: readonly ScriptDiagnostic[]
    reveal?: Readonly<{path: string; line: number; at: number}> | undefined
    openPaths: readonly string[]
    views: ScriptViews
    onViewChange: (path: string, view: unknown) => void
    onChange: (path: string, text: string) => void
    onSave: (path: string) => void
    onRename: (path: string, position: ScriptPosition) => void
    onToggleBreakpoint: (path: string, line: number) => void
    onOpenPath: (path: string) => void
}>

const EDITOR_HOST_STYLE = {minHeight: 0, width: '100%'} as const
const MARKER_OWNER = 'gofer-lsp'
const VIEW_SETTLE_MS = 400

const EDITOR_OPTIONS: Monaco.editor.IStandaloneEditorConstructionOptions = {
    theme: GOFER_EDITOR_THEME,
    automaticLayout: true,
    glyphMargin: true,
    minimap: {enabled: false},
    scrollBeyondLastLine: false,
    fontSize: 13,
    tabSize: 4,
    insertSpaces: true,
    renderWhitespace: 'selection'
}

export function ScriptEditor({
    buffer,
    diagnostics,
    reveal,
    openPaths,
    views,
    onViewChange,
    onChange,
    onSave,
    onRename,
    onToggleBreakpoint,
    onOpenPath
}: ScriptEditorProps) {
    const onError = useWorkspaceFailure()
    const hostRef = useRef<HTMLElement | null>(null)
    const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | undefined>(undefined)
    const modelsRef = useRef(new Map<string, Monaco.editor.ITextModel>())
    const viewStatesRef = useRef(
        new Map<string, Monaco.editor.ICodeEditorViewState | null>(
            Object.entries(views) as [string, Monaco.editor.ICodeEditorViewState][]
        )
    )
    const cancelSettleRef = useRef<(() => void) | undefined>(undefined)
    const decorationsRef = useRef<Monaco.editor.IEditorDecorationsCollection | undefined>(undefined)
    const applyingRef = useRef(false)
    const [monaco, setMonaco] = useState<typeof Monaco>()

    const handlers = useRef({
        onChange,
        onSave,
        onRename,
        onToggleBreakpoint,
        onOpenPath,
        onViewChange
    })
    useEffect(() => {
        handlers.current = {
            onChange,
            onSave,
            onRename,
            onToggleBreakpoint,
            onOpenPath,
            onViewChange
        }
    }, [onChange, onSave, onRename, onToggleBreakpoint, onOpenPath, onViewChange])

    const reportError = useCallback(
        (error: unknown) => {
            onError(`The language server request failed: ${commandErrorMessage(error)}`)
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
                onError(`The code editor could not be loaded: ${commandErrorMessage(error)}`)
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
        const settle = () => {
            cancelSettleRef.current?.()
            cancelSettleRef.current = schedule(() => {
                cancelSettleRef.current = undefined
                const model = editor.getModel()
                if (!model) return
                const path = workspacePathFromUri(model.uri)
                const view = editor.saveViewState()
                viewStatesRef.current.set(path, view)
                handlers.current.onViewChange(path, view)
            }, VIEW_SETTLE_MS)
        }
        const moved = editor.onDidChangeCursorPosition(settle)
        const scrolled = editor.onDidScrollChange(settle)
        return () => {
            cancelSettleRef.current?.()
            changed.dispose()
            clicked.dispose()
            moved.dispose()
            scrolled.dispose()
            editor.dispose()
            editorRef.current = undefined
            decorationsRef.current = undefined
        }
    }, [monaco])

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
                const previousPath = workspacePathFromUri(previous.uri)
                const view = editor.saveViewState()
                viewStatesRef.current.set(previousPath, view)
                handlers.current.onViewChange(previousPath, view)
            }
            editor.setModel(model)
            const restored = viewStatesRef.current.get(buffer.path)
            if (restored) editor.restoreViewState(restored)
        }
        if (model.getValue() !== buffer.text) {
            applyingRef.current = true
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

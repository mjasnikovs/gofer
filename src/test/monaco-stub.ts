import type * as Monaco from 'monaco-editor'

export type StubModel = Readonly<{
    uri: {path: string}
    getValue: () => string
    setText: (text: string) => void
    getFullModelRange: () => Monaco.IRange
    pushEditOperations: (
        selections: unknown,
        operations: readonly {text: string}[],
        cursor: () => null
    ) => void
    isDisposed: () => boolean
    dispose: () => void
}>

export interface MonacoStubState {
    editors: number
    markers: Record<string, readonly Monaco.editor.IMarkerData[]>
    decorations: readonly Monaco.editor.IModelDeltaDecoration[]
    actions: string[]
    diffEditors: number
    sideBySide: boolean | undefined
    revealed: number[]
    activeText: () => string
    type: (text: string) => void
    clickGlyphMargin: (line: number) => void
    runAction: (id: string) => void
    moveCursor: (line: number) => void
    restored: unknown[]
    reset: () => void
}

export function createMonacoStub(): {monaco: typeof Monaco; state: MonacoStubState} {
    const uris: Record<string, {path: string}> = {}
    const disposable = {dispose: () => undefined}
    let contentListener: (() => void) | undefined
    let mouseListener: ((event: unknown) => void) | undefined
    let cursorListener: (() => void) | undefined
    let activeModel: StubModel | undefined
    let cursorLine = 1
    const actionRunners = new Map<string, (editor: unknown) => void>()

    const state: MonacoStubState = {
        editors: 0,
        markers: {},
        decorations: [],
        actions: [],
        diffEditors: 0,
        sideBySide: undefined,
        revealed: [],
        activeText: () => activeModel?.getValue() ?? '',
        type: (text: string) => {
            activeModel?.setText(text)
            contentListener?.()
        },
        clickGlyphMargin: (line: number) => {
            mouseListener?.({target: {type: 2, position: {lineNumber: line, column: 1}}})
        },
        runAction: (id: string) => {
            actionRunners.get(id)?.(editorInstance)
        },
        moveCursor: (line: number) => {
            cursorLine = line
            cursorListener?.()
        },
        restored: [],
        reset: () => {
            state.restored = []
            cursorListener = undefined
            cursorLine = 1
            state.editors = 0
            state.markers = {}
            state.decorations = []
            state.actions = []
            state.diffEditors = 0
            state.sideBySide = undefined
            state.revealed = []
            contentListener = undefined
            mouseListener = undefined
            activeModel = undefined
            actionRunners.clear()
        }
    }

    const createModel = (text: string, _language: string, uri?: {path: string}): StubModel => {
        let value = text
        let disposed = false
        return {
            uri: uri ?? {path: '/untitled'},
            getValue: () => value,
            setText: (next: string) => {
                value = next
            },
            getFullModelRange: () => ({
                startLineNumber: 1,
                startColumn: 1,
                endLineNumber: value.split('\n').length,
                endColumn: 1
            }),
            pushEditOperations: (_selections, operations) => {
                value = operations[0]?.text ?? value
            },
            isDisposed: () => disposed,
            dispose: () => {
                disposed = true
            }
        }
    }

    const editorInstance = {
        getModel: () => activeModel,
        setModel: (model: StubModel) => {
            activeModel = model
        },
        getPosition: () => ({lineNumber: 1, column: 1}),
        setPosition: () => undefined,
        focus: () => undefined,
        revealLineInCenter: (line: number) => {
            state.revealed.push(line)
        },
        saveViewState: () => ({cursorLine}),
        restoreViewState: (view: unknown) => {
            state.restored.push(view)
            const line = (view as {cursorLine?: number} | null)?.cursorLine
            if (typeof line === 'number') cursorLine = line
        },
        createDecorationsCollection: () => ({
            set: (decorations: readonly Monaco.editor.IModelDeltaDecoration[]) => {
                state.decorations = decorations
            },
            clear: () => {
                state.decorations = []
            }
        }),
        onDidChangeModelContent: (listener: () => void) => {
            contentListener = listener
            return disposable
        },
        onMouseDown: (listener: (event: unknown) => void) => {
            mouseListener = listener
            return disposable
        },
        onDidChangeCursorPosition: (listener: () => void) => {
            cursorListener = listener
            return disposable
        },
        onDidScrollChange: () => disposable,
        addAction: (action: {id: string; run: (editor: unknown) => void}) => {
            state.actions.push(action.id)
            actionRunners.set(action.id, action.run)
            return disposable
        },
        dispose: () => undefined
    }

    const monaco = {
        Uri: {from: ({path}: {scheme: string; path: string}) => (uris[path] ??= {path})},
        Range: class {
            constructor(
                readonly startLineNumber: number,
                readonly startColumn: number,
                readonly endLineNumber: number,
                readonly endColumn: number
            ) {}
        },
        KeyMod: {CtrlCmd: 2048},
        KeyCode: {KeyS: 49, F2: 60},
        editor: {
            create: () => {
                state.editors += 1
                return editorInstance
            },
            createDiffEditor: () => {
                state.diffEditors += 1
                return {
                    setModel: () => undefined,
                    updateOptions: (options: Monaco.editor.IDiffEditorOptions) => {
                        state.sideBySide = options.renderSideBySide ?? state.sideBySide
                    },
                    dispose: () => undefined
                }
            },
            createModel,
            setModelMarkers: (
                model: StubModel,
                _owner: string,
                markers: readonly Monaco.editor.IMarkerData[]
            ) => {
                state.markers = {...state.markers, [model.uri.path]: markers}
            },
            registerEditorOpener: () => disposable,
            MouseTargetType: {GUTTER_GLYPH_MARGIN: 2},
            TrackedRangeStickiness: {NeverGrowsWhenTypingAtEdges: 1}
        },
        languages: {
            getLanguages: () => [],
            register: () => undefined,
            setLanguageConfiguration: () => undefined,
            setMonarchTokensProvider: () => undefined,
            registerHoverProvider: () => disposable,
            registerCompletionItemProvider: () => disposable,
            registerSignatureHelpProvider: () => disposable,
            registerDefinitionProvider: () => disposable,
            registerDeclarationProvider: () => disposable,
            registerReferenceProvider: () => disposable,
            registerDocumentHighlightProvider: () => disposable,
            registerDocumentSymbolProvider: () => disposable
        }
    }

    return {monaco: monaco as unknown as typeof Monaco, state}
}

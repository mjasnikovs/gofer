import {describe, expect, it, vi} from 'vitest'
import type * as Monaco from 'monaco-editor'
import {
    modelUri,
    registerScriptProviders,
    toCompletionList,
    toDocumentSymbols,
    toMarkers,
    toMonacoHighlights,
    toMonacoHover,
    toMonacoLocations,
    toMonacoRange,
    toMonacoSignatureHelp,
    toScriptPosition,
    workspacePathFromUri
} from './monaco-lsp'
import type {ScriptRequest, ScriptResponse} from '../models/script'

type ProviderRecord = Readonly<Record<string, unknown>>

function range(line: number, character = 0) {
    return {
        start: {line, character},
        end: {line, character: character + 4}
    }
}

function monacoStub() {
    const uris: Record<string, {path: string}> = {}
    const providers = new Map<string, ProviderRecord>()
    const disposed: string[] = []
    const register = (name: string) => (language: string, provider: ProviderRecord) => {
        providers.set(name, provider)
        return {
            dispose: () => {
                disposed.push(`${name}:${language}`)
            }
        }
    }
    const monaco = {
        Uri: {
            from: ({path}: {scheme: string; path: string}) => (uris[path] ??= {path})
        },
        languages: {
            registerHoverProvider: register('hover'),
            registerCompletionItemProvider: register('completion'),
            registerSignatureHelpProvider: register('signatureHelp'),
            registerDefinitionProvider: register('definition'),
            registerDeclarationProvider: register('declaration'),
            registerReferenceProvider: register('references'),
            registerDocumentHighlightProvider: register('highlights'),
            registerDocumentSymbolProvider: register('documentSymbols')
        }
    }
    return {monaco: monaco as unknown as typeof Monaco, providers, disposed}
}

function modelStub(path: string) {
    return {
        uri: {path: `/${path}`},
        getWordUntilPosition: () => ({word: 'spe', startColumn: 5, endColumn: 8})
    } as unknown as Monaco.editor.ITextModel
}

describe('LSP to Monaco conversion', () => {
    it('shifts positions between the two coordinate systems', () => {
        expect(toMonacoRange(range(3, 2))).toEqual({
            startLineNumber: 4,
            startColumn: 3,
            endLineNumber: 4,
            endColumn: 7
        })
        expect(toScriptPosition({lineNumber: 4, column: 3})).toEqual({line: 3, character: 2})
    })

    it('maps diagnostic severities onto Monaco marker severities', () => {
        const markers = toMarkers([
            {range: range(0), message: 'broken', severity: 1, source: 'gdscript', code: 7},
            {range: range(1), message: 'suspect', severity: 2},
            {range: range(2), message: 'noted', severity: 3},
            {range: range(3), message: 'hinted', severity: 4},
            {range: range(4), message: 'unspecified'}
        ])

        expect(markers.map(marker => marker.severity)).toEqual([8, 4, 2, 1, 8])
        expect(markers[0]).toMatchObject({
            startLineNumber: 1,
            message: 'broken',
            source: 'gdscript',
            code: '7'
        })
        expect(markers[1]).not.toHaveProperty('source')
    })

    it('renders hover contents and drops empty ones', () => {
        expect(
            toMonacoHover({
                contents: [{language: 'gdscript', value: 'func move()'}, 'Moves the player.'],
                range: range(2)
            })
        ).toEqual({
            contents: [{value: '```gdscript\nfunc move()\n```'}, {value: 'Moves the player.'}],
            range: {startLineNumber: 3, startColumn: 1, endLineNumber: 3, endColumn: 5}
        })
        expect(toMonacoHover({contents: '   '})).toBeUndefined()
        expect(toMonacoHover(undefined)).toBeUndefined()
    })

    it('translates completion kinds, snippets, and edit ranges', () => {
        const defaultRange = {
            startLineNumber: 1,
            startColumn: 5,
            endLineNumber: 1,
            endColumn: 8
        }
        const list = toCompletionList(
            [
                {label: 'speed', kind: 6, detail: 'float', documentation: {value: 'Movement'}},
                {
                    label: 'move_and_slide',
                    kind: 3,
                    insertText: 'move_and_slide()$0',
                    insertTextFormat: 2
                },
                {label: 'position', textEdit: {range: range(0, 4), newText: 'position'}}
            ],
            true,
            defaultRange
        )

        expect(list.incomplete).toBe(true)
        expect(list.suggestions[0]).toMatchObject({
            kind: 4,
            insertText: 'speed',
            detail: 'float',
            documentation: {value: 'Movement'},
            range: defaultRange
        })
        expect(list.suggestions[1]).toMatchObject({kind: 1, insertTextRules: 4})
        expect(list.suggestions[2]?.range).toEqual({
            startLineNumber: 1,
            startColumn: 5,
            endLineNumber: 1,
            endColumn: 9
        })
    })

    it('keeps signature help and refuses an empty answer', () => {
        const help = toMonacoSignatureHelp({
            signatures: [
                {
                    label: 'move(speed: float)',
                    documentation: 'Moves',
                    parameters: [{label: 'speed: float'}]
                }
            ],
            activeSignature: 0
        })

        expect(help?.value.signatures[0]).toMatchObject({
            label: 'move(speed: float)',
            documentation: {value: 'Moves'}
        })
        expect(help?.value.activeParameter).toBe(0)
        expect(toMonacoSignatureHelp({signatures: []})).toBeUndefined()
    })

    it('maps highlight kinds and symbol kinds', () => {
        expect(toMonacoHighlights([{range: range(1), kind: 3}, {range: range(2)}])).toEqual([
            {range: toMonacoRange(range(1)), kind: 2},
            {range: toMonacoRange(range(2)), kind: 0}
        ])

        const nested = toDocumentSymbols([
            {
                name: 'Player',
                kind: 5,
                range: range(0),
                selectionRange: range(0),
                children: [{name: 'speed', kind: 13, range: range(1), selectionRange: range(1)}]
            }
        ])
        expect(nested[0]).toMatchObject({name: 'Player', kind: 4})
        expect(nested[0]?.children?.[0]).toMatchObject({name: 'speed', kind: 12})

        const flat = toDocumentSymbols([
            {
                name: 'speed',
                kind: 13,
                location: {uri: 'file:///player.gd', range: range(4)},
                containerName: 'Player'
            }
        ])
        expect(flat[0]).toMatchObject({name: 'speed', kind: 12, detail: 'Player'})
    })

    it('round-trips workspace paths through model URIs', () => {
        const {monaco} = monacoStub()
        const uri = modelUri(monaco, 'scripts/player.gd')

        expect(workspacePathFromUri(uri)).toBe('scripts/player.gd')
        expect(toMonacoLocations(monaco, [{path: 'scripts/player.gd', range: range(2)}])).toEqual([
            {uri, range: toMonacoRange(range(2))}
        ])
    })
})

describe('script language providers', () => {
    const respond = (responses: Partial<Record<ScriptRequest['op'], ScriptResponse>>) =>
        vi.fn(async (request: ScriptRequest) => {
            const response = responses[request.op]
            if (!response) throw new Error(`unexpected ${request.op}`)
            return response
        })

    function register(request: ReturnType<typeof respond>, onError = vi.fn()) {
        const {monaco, providers, disposed} = monacoStub()
        const registration = registerScriptProviders(monaco, 'gdscript', {
            request,
            pathForModel: model => {
                const path = workspacePathFromUri(model.uri)
                return path === '' ? undefined : path
            },
            onError
        })
        return {providers, disposed, registration, onError}
    }

    it('asks the server at the cursor and converts the answer', async () => {
        const request = respond({hover: {op: 'hover', hover: {contents: 'Player speed'}}})
        const {providers} = register(request)
        const provider = providers.get('hover') as {
            provideHover: (
                model: Monaco.editor.ITextModel,
                position: Monaco.IPosition
            ) => Promise<Monaco.languages.Hover | undefined>
        }

        const hover = await provider.provideHover(modelStub('player.gd'), {
            lineNumber: 5,
            column: 3
        })

        expect(request).toHaveBeenCalledWith({
            op: 'hover',
            path: 'player.gd',
            position: {line: 4, character: 2}
        })
        expect(hover?.contents).toEqual([{value: 'Player speed'}])
    })

    it('passes the reference context through and maps locations back to workspace paths', async () => {
        const request = respond({
            references: {op: 'locations', locations: [{path: 'player.gd', range: range(9)}]}
        })
        const {providers} = register(request)
        const provider = providers.get('references') as {
            provideReferences: (
                model: Monaco.editor.ITextModel,
                position: Monaco.IPosition,
                context: {includeDeclaration: boolean}
            ) => Promise<Monaco.languages.Location[]>
        }

        const locations = await provider.provideReferences(
            modelStub('player.gd'),
            {lineNumber: 1, column: 1},
            {includeDeclaration: true}
        )

        expect(request).toHaveBeenCalledWith({
            op: 'references',
            path: 'player.gd',
            position: {line: 0, character: 0},
            includeDeclaration: true
        })
        expect(locations[0]?.range.startLineNumber).toBe(10)
    })

    it('reports a failed request and answers empty so typing continues', async () => {
        const request = vi.fn(async () => {
            throw new Error('session_not_active')
        })
        const onError = vi.fn()
        const {providers} = register(request, onError)
        const provider = providers.get('completion') as {
            provideCompletionItems: (
                model: Monaco.editor.ITextModel,
                position: Monaco.IPosition
            ) => Promise<Monaco.languages.CompletionList>
        }

        const list = await provider.provideCompletionItems(modelStub('player.gd'), {
            lineNumber: 1,
            column: 8
        })

        expect(list.suggestions).toEqual([])
        expect(onError).toHaveBeenCalledOnce()
    })

    it('leaves models it does not own alone and disposes every registration', async () => {
        const request = respond({documentSymbols: {op: 'documentSymbols', symbols: []}})
        const {providers, disposed, registration} = register(request)
        const provider = providers.get('documentSymbols') as {
            provideDocumentSymbols: (
                model: Monaco.editor.ITextModel
            ) => Promise<Monaco.languages.DocumentSymbol[]>
        }

        expect(await provider.provideDocumentSymbols(modelStub(''))).toEqual([])
        expect(request).not.toHaveBeenCalled()

        registration.dispose()
        expect(disposed).toHaveLength(providers.size)
    })
})

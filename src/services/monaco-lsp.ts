import type * as Monaco from 'monaco-editor'
import type {
    ScriptCompletionItem,
    ScriptDiagnostic,
    ScriptDocumentSymbol,
    ScriptHighlight,
    ScriptHover,
    ScriptLocation,
    ScriptMarkedString,
    ScriptMarkup,
    ScriptPosition,
    ScriptRange,
    ScriptRequest,
    ScriptResponse,
    ScriptSignatureHelp,
    ScriptSymbolInformation
} from '../models/script'

/**
 * Translation between Godot's language server and Monaco, plus the providers that carry it.
 *
 * The two protocols disagree on almost every number: LSP counts lines and UTF-16 characters from
 * zero, Monaco counts lines and columns from one, and their severity, completion, and symbol
 * enumerations are unrelated. Every conversion lives here so no provider re-derives one.
 */

/** Monaco's `MarkerSeverity`, keyed by the LSP severity that produced it. */
const MARKER_SEVERITY: Readonly<Record<number, number>> = {
    1: 8, // error
    2: 4, // warning
    3: 2, // information
    4: 1 // hint
}

/** Monaco's `CompletionItemKind`, keyed by the LSP `CompletionItemKind`. */
const COMPLETION_KIND: Readonly<Record<number, number>> = {
    1: 18,
    2: 0,
    3: 1,
    4: 2,
    5: 3,
    6: 4,
    7: 5,
    8: 7,
    9: 8,
    10: 9,
    11: 12,
    12: 13,
    13: 15,
    14: 17,
    15: 27,
    16: 19,
    17: 20,
    18: 21,
    19: 23,
    20: 16,
    21: 14,
    22: 6,
    23: 10,
    24: 11,
    25: 24
}

/** Monaco's `DocumentHighlightKind`, keyed by the LSP kind. */
const HIGHLIGHT_KIND: Readonly<Record<number, number>> = {
    1: 0, // text
    2: 1, // read
    3: 2 // write
}

/** LSP `InsertTextFormat.Snippet`. */
const SNIPPET_FORMAT = 2
/** Monaco's `CompletionItemInsertTextRule.InsertAsSnippet`. */
const INSERT_AS_SNIPPET = 4
/** Monaco's `CompletionItemKind.Text`, used when the server names no kind. */
const DEFAULT_COMPLETION_KIND = 18
/** Monaco's `SymbolKind.Variable`, used when the server names no kind. */
const DEFAULT_SYMBOL_KIND = 12

const COMPLETION_TRIGGERS = ['.', ':', '$', '@', '"', "'", '/']
const SIGNATURE_TRIGGERS = ['(', ',']

export type ScriptLanguageBridge = Readonly<{
    /** Sends one language request to Rust. */
    request: (request: ScriptRequest) => Promise<ScriptResponse>
    /** The workspace-relative path a model holds, or undefined for a model Gofer does not own. */
    pathForModel: (model: Monaco.editor.ITextModel) => string | undefined
    /** Reports a failed provider request. Providers themselves answer empty so typing continues. */
    onError?: ((error: unknown) => void) | undefined
}>

/** Converts an LSP range to the one-based, inclusive-start range Monaco ranges use. */
export function toMonacoRange(range: ScriptRange): Monaco.IRange {
    return {
        startLineNumber: range.start.line + 1,
        startColumn: range.start.character + 1,
        endLineNumber: range.end.line + 1,
        endColumn: range.end.character + 1
    }
}

/** Converts a Monaco position to the zero-based LSP position the server expects. */
export function toScriptPosition(position: Monaco.IPosition): ScriptPosition {
    return {line: position.lineNumber - 1, character: position.column - 1}
}

/** Turns published diagnostics into the markers Monaco renders in the gutter and overview ruler. */
export function toMarkers(
    diagnostics: readonly ScriptDiagnostic[]
): readonly Monaco.editor.IMarkerData[] {
    return diagnostics.map(diagnostic => ({
        ...toMonacoRange(diagnostic.range),
        message: diagnostic.message,
        severity: (MARKER_SEVERITY[diagnostic.severity ?? 1]
            ?? MARKER_SEVERITY[1]) as Monaco.MarkerSeverity,
        ...(diagnostic.source !== undefined && {source: diagnostic.source}),
        ...(diagnostic.code !== undefined && {code: String(diagnostic.code)})
    }))
}

function toMarkdown(value: ScriptMarkedString): Monaco.IMarkdownString {
    if (typeof value === 'string') return {value}
    if ('language' in value) return {value: `\`\`\`${value.language}\n${value.value}\n\`\`\``}
    return {value: value.value}
}

function toPlainDocumentation(value: string | ScriptMarkup | undefined) {
    if (value === undefined) return undefined
    return typeof value === 'string' ? {value} : {value: value.value}
}

export function toMonacoHover(hover: ScriptHover | undefined): Monaco.languages.Hover | undefined {
    if (!hover) return undefined
    const contents =
        Array.isArray(hover.contents) ?
            (hover.contents as readonly ScriptMarkedString[]).map(toMarkdown)
        :   [toMarkdown(hover.contents as ScriptMarkedString)]
    if (contents.every(entry => entry.value.trim() === '')) return undefined
    return {
        contents,
        ...(hover.range && {range: toMonacoRange(hover.range)})
    }
}

export function toCompletionList(
    items: readonly ScriptCompletionItem[],
    isIncomplete: boolean,
    defaultRange: Monaco.IRange
): Monaco.languages.CompletionList {
    return {
        incomplete: isIncomplete,
        suggestions: items.map(item => {
            const documentation = toPlainDocumentation(item.documentation)
            return {
                label: item.label,
                kind: COMPLETION_KIND[item.kind ?? 0] ?? DEFAULT_COMPLETION_KIND,
                insertText: item.textEdit?.newText ?? item.insertText ?? item.label,
                range: item.textEdit ? toMonacoRange(item.textEdit.range) : defaultRange,
                ...(item.detail !== undefined && {detail: item.detail}),
                ...(documentation && {documentation}),
                ...(item.filterText !== undefined && {filterText: item.filterText}),
                ...(item.sortText !== undefined && {sortText: item.sortText}),
                ...(item.insertTextFormat === SNIPPET_FORMAT && {
                    insertTextRules: INSERT_AS_SNIPPET
                })
            }
        })
    }
}

export function toMonacoSignatureHelp(
    help: ScriptSignatureHelp | undefined
): Monaco.languages.SignatureHelpResult | undefined {
    if (!help || help.signatures.length === 0) return undefined
    return {
        value: {
            signatures: help.signatures.map(signature => {
                const documentation = toPlainDocumentation(signature.documentation)
                return {
                    label: signature.label,
                    ...(documentation && {documentation}),
                    parameters: (signature.parameters ?? []).map(parameter => {
                        const parameterDocumentation = toPlainDocumentation(parameter.documentation)
                        return {
                            label: parameter.label as string | [number, number],
                            ...(parameterDocumentation && {
                                documentation: parameterDocumentation
                            })
                        }
                    })
                }
            }),
            activeSignature: help.activeSignature ?? 0,
            activeParameter: help.activeParameter ?? 0
        },
        dispose: () => undefined
    }
}

export function toMonacoHighlights(
    highlights: readonly ScriptHighlight[]
): Monaco.languages.DocumentHighlight[] {
    return highlights.map(highlight => ({
        range: toMonacoRange(highlight.range),
        kind: (HIGHLIGHT_KIND[highlight.kind ?? 1]
            ?? HIGHLIGHT_KIND[1]) as Monaco.languages.DocumentHighlightKind
    }))
}

function isNested(
    symbols: readonly ScriptDocumentSymbol[] | readonly ScriptSymbolInformation[]
): symbols is readonly ScriptDocumentSymbol[] {
    const first = symbols[0]
    return first === undefined || 'selectionRange' in first
}

/**
 * Godot answers `documentSymbol` with nested symbols, but the protocol allows the flat form, so
 * both are accepted rather than trusting one shape.
 */
export function toDocumentSymbols(
    symbols: readonly ScriptDocumentSymbol[] | readonly ScriptSymbolInformation[]
): Monaco.languages.DocumentSymbol[] {
    if (!isNested(symbols)) {
        return symbols.map(symbol => ({
            name: symbol.name,
            detail: symbol.containerName ?? '',
            kind: symbol.kind - 1,
            tags: [],
            range: toMonacoRange(symbol.location.range),
            selectionRange: toMonacoRange(symbol.location.range)
        }))
    }
    return symbols.map(symbol => ({
        name: symbol.name,
        detail: symbol.detail ?? '',
        // Monaco's SymbolKind is the LSP kind minus one, all the way through TypeParameter.
        kind: (symbol.kind || DEFAULT_SYMBOL_KIND + 1) - 1,
        tags: [],
        range: toMonacoRange(symbol.range),
        selectionRange: toMonacoRange(symbol.selectionRange),
        ...(symbol.children?.length && {children: toDocumentSymbols(symbol.children)})
    }))
}

/** The model URI Gofer gives a workspace file, and its inverse. */
export function modelUri(monaco: typeof Monaco, path: string): Monaco.Uri {
    return monaco.Uri.from({scheme: 'file', path: `/${path}`})
}

export function workspacePathFromUri(uri: Monaco.Uri): string {
    return uri.path.replace(/^\/+/, '')
}

export function toMonacoLocations(
    monaco: typeof Monaco,
    locations: readonly ScriptLocation[]
): Monaco.languages.Location[] {
    return locations.map(location => ({
        uri: modelUri(monaco, location.path),
        range: toMonacoRange(location.range)
    }))
}

/**
 * Registers every provider Monaco can answer from the language server. Rename is deliberately
 * absent: Monaco's rename UI applies its own edits, and Gofer applies a multi-file rename as one
 * validated filesystem transaction after the user approves the preview.
 */
export function registerScriptProviders(
    monaco: typeof Monaco,
    languageId: string,
    bridge: ScriptLanguageBridge
): Monaco.IDisposable {
    const report = (error: unknown) => {
        bridge.onError?.(error)
    }

    const positionRequest = async (
        model: Monaco.editor.ITextModel,
        position: Monaco.IPosition,
        build: (path: string, at: ScriptPosition) => ScriptRequest
    ) => {
        const path = bridge.pathForModel(model)
        if (path === undefined) return undefined
        try {
            return await bridge.request(build(path, toScriptPosition(position)))
        } catch (error) {
            report(error)
            return undefined
        }
    }

    const disposables: Monaco.IDisposable[] = [
        monaco.languages.registerHoverProvider(languageId, {
            provideHover: async (model, position) => {
                const response = await positionRequest(model, position, (path, at) => ({
                    op: 'hover',
                    path,
                    position: at
                }))
                return response?.op === 'hover' ? toMonacoHover(response.hover) : undefined
            }
        }),
        monaco.languages.registerCompletionItemProvider(languageId, {
            triggerCharacters: COMPLETION_TRIGGERS,
            provideCompletionItems: async (model, position) => {
                const word = model.getWordUntilPosition(position)
                const defaultRange: Monaco.IRange = {
                    startLineNumber: position.lineNumber,
                    startColumn: word.startColumn,
                    endLineNumber: position.lineNumber,
                    endColumn: word.endColumn
                }
                const response = await positionRequest(model, position, (path, at) => ({
                    op: 'completion',
                    path,
                    position: at
                }))
                if (response?.op !== 'completion') return {suggestions: []}
                return toCompletionList(response.items, response.isIncomplete, defaultRange)
            }
        }),
        monaco.languages.registerSignatureHelpProvider(languageId, {
            signatureHelpTriggerCharacters: SIGNATURE_TRIGGERS,
            provideSignatureHelp: async (model, position) => {
                const response = await positionRequest(model, position, (path, at) => ({
                    op: 'signatureHelp',
                    path,
                    position: at
                }))
                return response?.op === 'signatureHelp' ?
                        toMonacoSignatureHelp(response.signatureHelp)
                    :   undefined
            }
        }),
        monaco.languages.registerDefinitionProvider(languageId, {
            provideDefinition: async (model, position) => {
                const response = await positionRequest(model, position, (path, at) => ({
                    op: 'definition',
                    path,
                    position: at
                }))
                return response?.op === 'locations' ?
                        toMonacoLocations(monaco, response.locations)
                    :   []
            }
        }),
        monaco.languages.registerDeclarationProvider(languageId, {
            provideDeclaration: async (model, position) => {
                const response = await positionRequest(model, position, (path, at) => ({
                    op: 'declaration',
                    path,
                    position: at
                }))
                return response?.op === 'locations' ?
                        toMonacoLocations(monaco, response.locations)
                    :   []
            }
        }),
        monaco.languages.registerReferenceProvider(languageId, {
            provideReferences: async (model, position, context) => {
                const response = await positionRequest(model, position, (path, at) => ({
                    op: 'references',
                    path,
                    position: at,
                    includeDeclaration: context.includeDeclaration
                }))
                return response?.op === 'locations' ?
                        toMonacoLocations(monaco, response.locations)
                    :   []
            }
        }),
        monaco.languages.registerDocumentHighlightProvider(languageId, {
            provideDocumentHighlights: async (model, position) => {
                const response = await positionRequest(model, position, (path, at) => ({
                    op: 'highlights',
                    path,
                    position: at
                }))
                return response?.op === 'highlights' ? toMonacoHighlights(response.highlights) : []
            }
        }),
        monaco.languages.registerDocumentSymbolProvider(languageId, {
            provideDocumentSymbols: async model => {
                const path = bridge.pathForModel(model)
                if (path === undefined) return []
                try {
                    const response = await bridge.request({op: 'documentSymbols', path})
                    return response.op === 'documentSymbols' ?
                            toDocumentSymbols(response.symbols)
                        :   []
                } catch (error) {
                    report(error)
                    return []
                }
            }
        })
    ]

    return {
        dispose: () => {
            for (const disposable of disposables) disposable.dispose()
        }
    }
}

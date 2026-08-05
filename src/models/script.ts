/**
 * The wire shapes the script commands exchange with Rust. They mirror `src-tauri/src/script.rs`,
 * which speaks the Language Server Protocol on the far side, so positions are zero-based lines and
 * UTF-16 characters — Monaco's are one-based, and `monaco-lsp.ts` owns that conversion.
 */

export type ScriptPosition = Readonly<{
    line: number
    character: number
}>

export type ScriptRange = Readonly<{
    start: ScriptPosition
    end: ScriptPosition
}>

export type ScriptDocument = Readonly<{
    path: string
    text: string
    hash: string
    bytes: number
    version: number
}>

/** What a write or an in-memory change leaves the renderer to record. */
export type ScriptStamp = Readonly<{
    path: string
    hash?: string | undefined
    bytes?: number | undefined
    version: number
}>

/** LSP severities: 1 error, 2 warning, 3 information, 4 hint. */
export type ScriptDiagnostic = Readonly<{
    range: ScriptRange
    message: string
    severity?: number | undefined
    source?: string | undefined
    code?: string | number | undefined
}>

export type ScriptDiagnosticsEvent = Readonly<{
    path: string
    version?: number | undefined
    diagnostics: readonly ScriptDiagnostic[]
}>

/** A place the renderer can open: workspace-relative, never a `file://` URI. */
export type ScriptLocation = Readonly<{
    path: string
    range: ScriptRange
}>

/** One file a rename would rewrite, carrying everything the apply transaction needs. */
export type PlannedScriptFile = Readonly<{
    path: string
    originalText: string
    originalHash: string
    updatedText: string
}>

export type ScriptMarkup = Readonly<{
    kind?: string | undefined
    value: string
}>

export type ScriptMarkedString = string | ScriptMarkup | Readonly<{language: string; value: string}>

export type ScriptHover = Readonly<{
    contents: ScriptMarkedString | readonly ScriptMarkedString[]
    range?: ScriptRange | undefined
}>

export type ScriptTextEdit = Readonly<{
    range: ScriptRange
    newText: string
}>

export type ScriptCompletionItem = Readonly<{
    label: string
    kind?: number | undefined
    detail?: string | undefined
    documentation?: string | ScriptMarkup | undefined
    insertText?: string | undefined
    insertTextFormat?: number | undefined
    filterText?: string | undefined
    sortText?: string | undefined
    textEdit?: ScriptTextEdit | undefined
    data?: unknown
}>

export type ScriptParameterInformation = Readonly<{
    label: string | readonly [number, number]
    documentation?: string | ScriptMarkup | undefined
}>

export type ScriptSignatureInformation = Readonly<{
    label: string
    documentation?: string | ScriptMarkup | undefined
    parameters?: readonly ScriptParameterInformation[] | undefined
}>

export type ScriptSignatureHelp = Readonly<{
    signatures: readonly ScriptSignatureInformation[]
    activeSignature?: number | undefined
    activeParameter?: number | undefined
}>

/** LSP document-highlight kinds: 1 text, 2 read, 3 write. */
export type ScriptHighlight = Readonly<{
    range: ScriptRange
    kind?: number | undefined
}>

export type ScriptDocumentSymbol = Readonly<{
    name: string
    detail?: string | undefined
    kind: number
    range: ScriptRange
    selectionRange: ScriptRange
    children?: readonly ScriptDocumentSymbol[] | undefined
}>

/** A flat symbol, either from a flat `documentSymbol` answer or the synthesized workspace index. */
export type ScriptSymbolInformation = Readonly<{
    name: string
    kind: number
    location: Readonly<{uri: string; range: ScriptRange}>
    containerName?: string | undefined
}>

export type ScriptWorkspaceSymbol = Readonly<{
    name: string
    kind: number
    uri: string
    range: ScriptRange
    container?: string | undefined
}>

export type ScriptRequest =
    | Readonly<{op: 'hover'; path: string; position: ScriptPosition}>
    | Readonly<{op: 'completion'; path: string; position: ScriptPosition}>
    | Readonly<{op: 'resolveCompletion'; item: ScriptCompletionItem}>
    | Readonly<{op: 'signatureHelp'; path: string; position: ScriptPosition}>
    | Readonly<{op: 'definition'; path: string; position: ScriptPosition}>
    | Readonly<{op: 'declaration'; path: string; position: ScriptPosition}>
    | Readonly<{
          op: 'references'
          path: string
          position: ScriptPosition
          includeDeclaration: boolean
      }>
    | Readonly<{op: 'highlights'; path: string; position: ScriptPosition}>
    | Readonly<{op: 'documentSymbols'; path: string}>
    | Readonly<{op: 'prepareRename'; path: string; position: ScriptPosition}>
    | Readonly<{op: 'rename'; path: string; position: ScriptPosition; newName: string}>
    | Readonly<{op: 'workspaceSymbols'; query: string}>

export type ScriptResponse =
    | Readonly<{op: 'hover'; hover?: ScriptHover | undefined}>
    | Readonly<{op: 'completion'; items: readonly ScriptCompletionItem[]; isIncomplete: boolean}>
    | Readonly<{op: 'resolveCompletion'; item: ScriptCompletionItem}>
    | Readonly<{op: 'signatureHelp'; signatureHelp?: ScriptSignatureHelp | undefined}>
    | Readonly<{op: 'locations'; locations: readonly ScriptLocation[]}>
    | Readonly<{op: 'highlights'; highlights: readonly ScriptHighlight[]}>
    | Readonly<{
          op: 'documentSymbols'
          symbols: readonly ScriptDocumentSymbol[] | readonly ScriptSymbolInformation[]
      }>
    | Readonly<{op: 'prepareRename'; range?: ScriptRange | undefined; placeholder?: string}>
    | Readonly<{op: 'rename'; files: readonly PlannedScriptFile[]}>
    | Readonly<{op: 'workspaceSymbols'; symbols: readonly ScriptWorkspaceSymbol[]}>

/** The structured failure every script command rejects with. */
export type ScriptError = Readonly<{
    code: string
    message: string
    retryable: boolean
    details: Readonly<Record<string, unknown>>
}>

export type WorkspaceEntry = Readonly<{
    path: string
    bytes: number
}>

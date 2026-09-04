import type {DownloadProgress} from '@mjasnikovs/gofer-rag'

export type AiSettings = Readonly<{
    connectionType: AiConnectionType
    connections: AiConnections
    maxRetries: number
    timeoutMs: number
    compactionPercent: number
    subagent: SubagentSettings
    web: WebSettings
}>

export type AiConnections = Readonly<Partial<Record<AiConnectionType, AiConnectionProfile>>>

export type WebSettings = Readonly<{
    searchProvider: SearchProvider
}>

export type SearchProvider = 'exa' | 'ddg' | 'brave'

export const SEARCH_PROVIDERS: readonly SearchProvider[] = ['exa', 'ddg', 'brave']

export const SEARCH_PROVIDER_LABELS: Readonly<Record<SearchProvider, string>> = {
    exa: 'Exa',
    ddg: 'DuckDuckGo',
    brave: 'Brave'
}

export const SEARCH_PROVIDERS_NEEDING_KEY: readonly SearchProvider[] = ['brave']

export const DEFAULT_WEB_SETTINGS: WebSettings = {searchProvider: 'exa'}

export type AiApiDialect = 'openai-completions' | 'openai-codex-responses'

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'

export const CEREBRAS_BASE_URL = 'https://api.cerebras.ai/v1'

export type AiConnectionProfile = Readonly<{
    name: string
    baseUrl: string
    api: AiApiDialect
    chatTemplateThinking: boolean
    model: ModelChoice
}>

export type ModelChoice = AiModelOption & Readonly<{thinkingLevel: ThinkingLevel}>

export type SubagentSettings = Readonly<{
    commandTimeoutMinutes: number
    streamInactivityMinutes: number
    maxTurns: number
    maxAnswerChars: number
    retryAttempts: number
    retryBaseDelaySeconds: number
    connection?: SubagentConnection | undefined
}>

export type SubagentConnection = Readonly<{
    connectionType: AiConnectionType
    model: ModelChoice
}>

export type AgentPrompt = Readonly<{
    prompt: string
    defaultPrompt: string
}>

export type ThinkingLevel = 'off' | 'on' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export type AiModelOption = Readonly<{
    id: string
    name: string
    contextWindow: number
    maxTokens: number
    reasoning: boolean
    supportsReasoningEffort: boolean
    reasoningMandatory: boolean
    thinkingLevels: readonly ThinkingLevel[]
    input: readonly string[]
    offEffort?: string | undefined
    /** Whether this row names a model and nothing more. See `AiModelOption::names_only` in Rust. */
    namesOnly?: boolean
}>

export type GodotSettings = Readonly<{
    strictTyping: boolean
    embedGameWindow: boolean
}>

export type GoferSettings = Readonly<{
    version: 2
    ai: AiSettings
    godot: GodotSettings
}>

export type SettingsResponse = Readonly<{
    settings: GoferSettings
    /** Which slots the machine is holding something in. A slot it says nothing about is empty. */
    storedSecrets: Partial<Readonly<Record<SecretName, boolean>>>
    credentialStoreError?: string
}>

export type ChatGptLoginMethod = 'browser' | 'device_code'

export type ChatGptLoginEvent =
    | Readonly<{type: 'info'; message: string}>
    | Readonly<{type: 'auth_url'; url: string; instructions?: string | undefined}>
    | Readonly<{
          type: 'device_code'
          userCode: string
          verificationUri: string
          expiresInSeconds?: number | undefined
      }>
    | Readonly<{type: 'manual-code-request'; message: string; placeholder?: string | undefined}>
    | Readonly<{type: 'progress'; message: string}>
    | Readonly<{type: 'completed'}>
    | Readonly<{type: 'failed'; message: string}>

export type ApiKeyUpdate =
    | Readonly<{action: 'keep'}>
    | Readonly<{action: 'set'; value: string}>
    | Readonly<{action: 'clear'}>

export type SettingsRequest = Readonly<{
    settings: GoferSettings
    /** What the save does to each slot it names. A slot it does not name is left alone. */
    secrets: Partial<Readonly<Record<SecretName, ApiKeyUpdate>>>
}>

export type CacheStatus = Readonly<{
    path: string
    sizeBytes: number
    state: 'installed' | 'incomplete' | 'not-installed' | 'busy'
}>

export type ConnectionTestResult = Readonly<{
    status:
        'connected' | 'model-unavailable' | 'unauthorized' | 'server-error' | 'server-unreachable'
    message: string
}>

export type Notice = Readonly<{
    status: 'info' | 'warning' | 'error' | 'success'
    title: string
    description: string
}>

export type ApiKeyIntent = 'keep' | 'set' | 'clear'

export type StorageMaintenanceResult = Readonly<{
    attachmentsRemoved: number
    blobsRemoved: number
    godotRunsRemoved: number
    sketchesRemoved: number
    docsAnswersRemoved: number
    memoryVectorsRemoved: number
    memoryVectorsRefiled: number
    backupsRemoved: number
    memoryEmbeddingsRestored: number
}>

export const EFFORT_LEVELS: readonly ThinkingLevel[] = [
    'off',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
    'max'
]
export const NO_THINKING_LEVELS: readonly ThinkingLevel[] = ['off']
export const ON_OFF_THINKING_LEVELS: readonly ThinkingLevel[] = ['off', 'on']

export function thinkingLevelsFor(model: ThinkingCapable): readonly ThinkingLevel[] {
    if (!model.reasoning) return NO_THINKING_LEVELS
    const off: readonly ThinkingLevel[] = model.reasoningMandatory ? [] : ['off']
    if (model.thinkingLevels.length > 0) return [...off, ...model.thinkingLevels]
    if (!model.supportsReasoningEffort) return [...off, 'on']
    return model.reasoningMandatory ? EFFORT_LEVELS.filter(level => level !== 'off') : EFFORT_LEVELS
}

type ThinkingCapable = Readonly<{
    reasoning: boolean
    supportsReasoningEffort: boolean
    reasoningMandatory: boolean
    thinkingLevels: readonly ThinkingLevel[]
}>

export function keepThinkingLevel(model: ThinkingCapable, level: ThinkingLevel): ThinkingLevel {
    const offered = thinkingLevelsFor(model)
    if (offered.includes(level)) return level
    return EFFORT_LEVELS.find(cheapest => offered.includes(cheapest)) ?? offered[0] ?? 'off'
}

// GENERATED-BEGIN subagent-bounds sha256:e53302d81d27c140
export const DEFAULT_SUBAGENT_SETTINGS: SubagentSettings = {
    commandTimeoutMinutes: 5,
    streamInactivityMinutes: 10,
    maxTurns: 0,
    maxAnswerChars: 12_000,
    retryAttempts: 2,
    retryBaseDelaySeconds: 1
}

export const SUBAGENT_RANGES = {
    commandTimeoutMinutes: {min: 0, max: 30, step: 1},
    streamInactivityMinutes: {min: 0, max: 30, step: 1},
    maxTurns: {min: 0, max: 40, step: 1},
    // Capped at what a tool result is truncated to anyway (`MAX_TOOL_TEXT_CHARS`): an answer larger
    // than that is cut by the layer above regardless of what is chosen here.
    maxAnswerChars: {min: 0, max: 24_000, step: 1_000},
    // Attention, not machine time. Past six the conversation has stopped converging and belongs
    // back in the chat, so the top of the range is a ceiling rather than an absence of one.
    retryAttempts: {min: 0, max: 5, step: 1},
    retryBaseDelaySeconds: {min: 1, max: 10, step: 1}
} as const
// GENERATED-END subagent-bounds

export function minutesLabel(minutes: number) {
    if (minutes === 0) return 'Off'
    return `${String(minutes)} minute${minutes === 1 ? '' : 's'}`
}

export function secondsLabel(seconds: number) {
    return `${String(seconds)} second${seconds === 1 ? '' : 's'}`
}

export function stepsLabel(steps: number) {
    if (steps === 0) return 'Off'
    return `${String(steps)} step${steps === 1 ? '' : 's'}`
}

export function charactersLabel(characters: number) {
    if (characters === 0) return 'Off'
    return `${characters.toLocaleString()} characters`
}

export function retriesLabel(retries: number) {
    if (retries === 0) return 'Off'
    return `${String(retries)} ${retries === 1 ? 'retry' : 'retries'}`
}

export const DEFAULT_GODOT_SETTINGS: GodotSettings = {
    strictTyping: true,
    embedGameWindow: true
}

export function normalizeSettings(settings: GoferSettings): GoferSettings {
    const tuning = {maxRetries: 2, timeoutMs: 120_000, compactionPercent: 86}
    return {
        ...settings,
        godot: {...DEFAULT_GODOT_SETTINGS, ...settings.godot},
        ai: {
            ...tuning,
            ...settings.ai,
            connections: {...settings.ai.connections},
            subagent: {...DEFAULT_SUBAGENT_SETTINGS, ...settings.ai.subagent},
            web: {...DEFAULT_WEB_SETTINGS, ...settings.ai.web}
        }
    }
}

export function selectAiDriver(ai: AiSettings, connectionType: AiConnectionType): AiSettings {
    if (ai.connectionType === connectionType) return ai
    if (!connectionProfile(ai, connectionType)) return ai
    return {...ai, connectionType}
}

/**
 * Picking a model out of a listing, which does not always mean adopting what the listing says.
 *
 * A `namesOnly` row is one whose catalogue answered an id and nothing else — every other field on
 * it is a copy of what is already configured, sent back so the page has something to show. Writing
 * that copy over the draft reverts whatever the user typed while the listing was on the wire, and
 * on the OpenAI-compatible driver the typing is the only source those facts have.
 */
export function applyModelSelection(choice: ModelChoice, model: AiModelOption): ModelChoice {
    if (model.namesOnly) return {...choice, id: model.id, name: model.name}
    return {...model, thinkingLevel: keepThinkingLevel(model, choice.thinkingLevel)}
}

export function adoptModelReasoning(choice: ModelChoice, model: AiModelOption): ModelChoice {
    if (model.namesOnly) return choice
    if (
        choice.reasoning === model.reasoning
        && choice.supportsReasoningEffort === model.supportsReasoningEffort
        && choice.reasoningMandatory === model.reasoningMandatory
        && choice.offEffort === model.offEffort
    ) {
        return choice
    }
    return {
        ...choice,
        reasoning: model.reasoning,
        supportsReasoningEffort: model.supportsReasoningEffort,
        reasoningMandatory: model.reasoningMandatory,
        thinkingLevels: model.thinkingLevels,
        offEffort: model.offEffort,
        thinkingLevel: keepThinkingLevel(model, choice.thinkingLevel)
    }
}

export function adoptSubagentReasoning(
    ai: AiSettings,
    listedFor: AiConnectionType,
    available: readonly AiModelOption[]
): AiSettings {
    const chosen = ai.subagent.connection
    if (chosen?.connectionType !== listedFor) return ai
    const configured = available.find(model => model.id === chosen.model.id)
    if (!configured) return ai
    const model = adoptModelReasoning(chosen.model, configured)
    if (model === chosen.model) return ai
    return {...ai, subagent: {...ai.subagent, connection: {...chosen, model}}}
}

export function connectionProfile(
    ai: AiSettings,
    connectionType: AiConnectionType
): AiConnectionProfile | undefined {
    return ai.connections[connectionType]
}

export function activeConnection(ai: AiSettings): AiConnectionProfile | undefined {
    return connectionProfile(ai, ai.connectionType)
}

export function activeModel(settings?: GoferSettings): ModelChoice | undefined {
    return settings && activeConnection(settings.ai)?.model
}

function withConnection(
    ai: AiSettings,
    connectionType: AiConnectionType,
    connection: AiConnectionProfile
): AiSettings {
    return {...ai, connections: {...ai.connections, [connectionType]: connection}}
}

export function withActiveConnection(
    ai: AiSettings,
    change: (connection: AiConnectionProfile) => AiConnectionProfile
): AiSettings {
    const connection = activeConnection(ai)
    if (!connection) return ai
    return withConnection(ai, ai.connectionType, change(connection))
}

// GENERATED-BEGIN drivers sha256:df55177993d2c39c
export type AiConnectionType =
    'local' | 'openai-compatible' | 'openai-codex' | 'openrouter' | 'qwen' | 'cerebras'

/** Every driver a build knows, in the order the pickers offer them. */
export const AI_CONNECTION_TYPES: readonly AiConnectionType[] = [
    'local',
    'openai-compatible',
    'openai-codex',
    'openrouter',
    'qwen',
    'cerebras'
]

/**
 * What each driver is called on screen. Separate from the stored id, and one-directional:
 * a label must never be written to the settings file. Same rule as `SEARCH_PROVIDER_LABELS`.
 */
export const AI_CONNECTION_LABELS: Readonly<Record<AiConnectionType, string>> = {
    // A llama.cpp server on an address the user types. The only driver whose key never leaves this
    // machine, and the only one that is asked what it is serving: its `/props` answer outranks
    // everything written down about the model.
    local: 'Local model',
    // Any host speaking OpenAI completions, on an address the user types. It is asked nothing
    // beyond its model list, because a hosted endpoint answers no `/props` and Pi's catalogue has
    // never heard of it — so what its model can do is typed rather than derived. This word named
    // the local driver before settings version 2.
    'openai-compatible': 'OpenAI-compatible',
    // Authenticates with an OAuth credential rather than a key, which is why a missing one reads as
    // "Sign in with ChatGPT" rather than as an error. pi-ai ships the provider.
    'openai-codex': 'ChatGPT subscription',
    // A fixed host whose catalogue answers every question the local server cannot. Billed, and it
    // reserves credit for the ceiling before it generates a token.
    openrouter: 'OpenRouter',
    // The Qwen token plan, on a fixed host. Its endpoint publishes no capabilities either, so what
    // Gofer knows about its models is a second table shipped in this directory — and its live list
    // carries image and audio models that cannot call a tool, which naming the ones that can is the
    // filter for.
    qwen: 'Qwen',
    // A fixed host whose endpoint publishes no capabilities at all, which is why what Gofer knows
    // about its models is a table shipped in this directory rather than something asked for.
    cerebras: 'Cerebras'
}

export type SecretName =
    'ai-default' | 'brave' | 'openrouter' | 'cerebras' | 'openai-compatible' | 'qwen' | 'chat-gpt'

/** Every secret Gofer keeps, in the order a save writes them. */
export const SECRET_NAMES: readonly SecretName[] = [
    'ai-default',
    'brave',
    'openrouter',
    'cerebras',
    'openai-compatible',
    'qwen',
    'chat-gpt'
]

/**
 * The secrets a person types into a box, which is every one but the OAuth credential.
 *
 * A ChatGPT credential is written by its login, so a settings save that named it would
 * be saying something the page cannot mean.
 */
export type TypedSecret =
    'ai-default' | 'brave' | 'openrouter' | 'cerebras' | 'openai-compatible' | 'qwen'

export const TYPED_SECRET_NAMES: readonly TypedSecret[] = [
    'ai-default',
    'brave',
    'openrouter',
    'cerebras',
    'openai-compatible',
    'qwen'
]

/**
 * The one credential each driver authenticates with.
 *
 * A key sent to the wrong address is a key handed to a machine that was never meant to
 * see it, so this pairing is one row of `protocol/drivers.json` and every reader of it is
 * a lookup. It used to be a match in Rust, a second match in another Rust file, a table in
 * this renderer and two hand-written record literals in a hook.
 */
export const AI_CONNECTION_SECRETS: Readonly<Record<AiConnectionType, SecretName>> = {
    local: 'ai-default',
    'openai-compatible': 'openai-compatible',
    'openai-codex': 'chat-gpt',
    openrouter: 'openrouter',
    qwen: 'qwen',
    cerebras: 'cerebras'
}

/**
 * The same pairing, narrowed to the drivers whose secret is typed into a box.
 *
 * A driver that signs in has no box, so it has no entry — and a page that draws one
 * reads `undefined` rather than being handed a slot that belongs to another driver.
 */
export const TYPED_DRIVER_SECRETS: Partial<Readonly<Record<AiConnectionType, TypedSecret>>> = {
    local: 'ai-default',
    'openai-compatible': 'openai-compatible',
    openrouter: 'openrouter',
    qwen: 'qwen',
    cerebras: 'cerebras'
}
// GENERATED-END drivers

export function driverOptions(ai: AiSettings): {value: AiConnectionType; label: string}[] {
    return AI_CONNECTION_TYPES.filter(
        connectionType => connectionProfile(ai, connectionType) !== undefined
    ).map(connectionType => ({value: connectionType, label: AI_CONNECTION_LABELS[connectionType]}))
}

export function startSubagentConnection(
    ai: AiSettings,
    connectionType: AiConnectionType
): SubagentConnection | undefined {
    const profile = connectionProfile(ai, connectionType)
    if (!profile) return undefined
    return {connectionType, model: profile.model}
}

export function formatBytes(bytes: number) {
    if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GiB`
    if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`
    if (bytes === 0) return '0 bytes'
    return `${String(Math.round(bytes / 1024))} KiB`
}

export function progressValue(progress?: DownloadProgress) {
    if (typeof progress?.progress === 'number') return Math.min(100, Math.max(0, progress.progress))
    if (progress?.loaded !== undefined && progress.total)
        return (progress.loaded / progress.total) * 100
    return undefined
}

export function progressLabel(progress?: DownloadProgress) {
    if (!progress) return 'Preparing model download…'
    if (progress.loaded !== undefined && progress.total) {
        return `${progress.model}: ${formatBytes(progress.loaded)} of ${formatBytes(progress.total)}`
    }
    return `${progress.model}: ${progress.status}`
}

export function compactionLabel(contextWindow: number) {
    return (percent: number) => {
        if (percent >= 100) return 'Off · never summarise'
        return `${String(percent)}% · ${Math.floor((contextWindow * percent) / 100).toLocaleString()} tokens`
    }
}

export function apiKeyUpdate(intent: ApiKeyIntent, value: string): ApiKeyUpdate {
    if (intent === 'clear') return {action: 'clear'}
    if (intent === 'set') return {action: 'set', value}
    return {action: 'keep'}
}

export function cacheStateLabel(state: CacheStatus['state']) {
    if (state === 'installed') return 'Installed'
    if (state === 'incomplete') return 'Incomplete'
    if (state === 'busy') return 'Busy'
    return 'Not installed'
}

export function cacheStateVariant(state: CacheStatus['state']) {
    if (state === 'installed') return 'success' as const
    if (state === 'incomplete' || state === 'busy') return 'warning' as const
    return 'neutral' as const
}

export function connectionNotice(result: ConnectionTestResult): Notice {
    if (result.status === 'connected') {
        return {status: 'success', title: 'AI connection works', description: result.message}
    }
    if (result.status === 'model-unavailable') {
        return {
            status: 'warning',
            title: 'Configured model is unavailable',
            description: result.message
        }
    }
    if (result.status === 'unauthorized') {
        return {status: 'error', title: 'Authentication failed', description: result.message}
    }
    if (result.status === 'server-unreachable') {
        return {status: 'error', title: 'AI server is unreachable', description: result.message}
    }
    return {status: 'error', title: 'AI server returned an error', description: result.message}
}

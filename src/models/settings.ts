import type {DownloadProgress} from '@mjasnikovs/gofer-rag'

export type AiSettings = Readonly<{
    connectionType: AiConnectionType
    name: string
    baseUrl: string
    model: string
    api: AiApiDialect
    modelName: string
    contextWindow: number
    maxTokens: number
    reasoning: boolean
    supportsReasoningEffort: boolean
    input: readonly string[]
    thinkingLevel: ThinkingLevel
    maxRetries: number
    timeoutMs: number
    /**
     * How full the context may get before the old part of it is summarised away. 100 turns
     * compaction off. 86 draws the same line Pi does with its 16,384-token reserve.
     */
    compactionPercent: number
    subagent: SubagentSettings
    web: WebSettings
    /** Saved independently so changing drivers never destroys the other driver's selection. */
    local?: AiConnectionProfile | undefined
    chatgpt?: AiConnectionProfile | undefined
}>

/**
 * Which engine `web_search` asks, and nothing else.
 *
 * The Brave key is not here. It lives in the OS keyring, because this file is written to disk as
 * plain text and a search key is a credential like the AI one.
 */
export type WebSettings = Readonly<{
    searchProvider: SearchProvider
}>

/** The stored id of a search engine. Never its display name — see `SEARCH_PROVIDER_LABELS`. */
export type SearchProvider = 'exa' | 'ddg' | 'brave'

export const SEARCH_PROVIDERS: readonly SearchProvider[] = ['exa', 'ddg', 'brave']

/**
 * What each engine is called on screen.
 *
 * Separate from the stored id, and one-directional: a label must never be written to the settings
 * file, because a file holding `DuckDuckGo` matches no engine this build knows.
 */
export const SEARCH_PROVIDER_LABELS: Readonly<Record<SearchProvider, string>> = {
    exa: 'Exa',
    ddg: 'DuckDuckGo',
    brave: 'Brave'
}

/** Exa and DuckDuckGo are keyless. Brave holds up better under load and needs a key to do it. */
export const SEARCH_PROVIDERS_NEEDING_KEY: readonly SearchProvider[] = ['brave']

/** The shipped engine. Keyless, so a fresh install can search the moment it is opened. */
export const DEFAULT_WEB_SETTINGS: WebSettings = {searchProvider: 'exa'}

export type AiConnectionType = 'openai-compatible' | 'openai-codex'
export type AiApiDialect = 'openai-completions' | 'openai-codex-responses'

export type AiConnectionProfile = Readonly<{
    name: string
    baseUrl: string
    model: string
    api: AiApiDialect
    modelName: string
    contextWindow: number
    maxTokens: number
    reasoning: boolean
    supportsReasoningEffort: boolean
    input: readonly string[]
    thinkingLevel: ThinkingLevel
}>

/**
 * What bounds the sub-agent, the second agent the main one delegates reading to.
 *
 * Every field is a ceiling. None is a fact about Gofer — they are facts about the machine the model
 * runs on, which is why they are settings rather than constants. The two clocks are separate because
 * they catch failures that hide each other: a command that never returns holds a healthy stream, and
 * a silent stream holds a healthy machine. The step ceiling covers the third case, a sub-agent that
 * is busy and getting nowhere, which no clock can see.
 */
export type SubagentSettings = Readonly<{
    /** Ceiling on one tool call, in minutes. 0 turns the command watchdog off. */
    commandTimeoutMinutes: number
    /** Ceiling on model silence, in minutes, ignoring time spent in tools. 0 turns it off. */
    streamInactivityMinutes: number
    /** Ceiling on model requests one delegation may make. 0 turns it off. */
    maxTurns: number
    /** Ceiling on the answer handed back, in characters. 0 turns it off. */
    maxAnswerChars: number
    /** How many times one delegation may stop the user to show them something. 0 turns it off. */
    maxShows: number
    /** How many times a delegation that failed transiently is asked again. 0 turns retry off. */
    retryAttempts: number
    /** The first wait before asking again, in seconds. Each further attempt doubles it. */
    retryBaseDelaySeconds: number
    /**
     * Which model answers a delegation, when it is not the one the parent is using.
     *
     * Absent means the child borrows everything — the connection, the model and the reasoning
     * level — which is what every settings file written before this field said, and still says.
     */
    connection?: SubagentConnection | undefined
}>

/**
 * The model a delegation is answered by, and which of the two configured connections serves it.
 *
 * Deliberately not a second connection. It names one of the connections the settings file already
 * holds and carries only what is the model's own. The address, the dialect and the credential
 * belong to the connection, are configured in one place, and are never copied here.
 */
export type SubagentConnection = Readonly<{
    connectionType: AiConnectionType
    model: string
    modelName: string
    contextWindow: number
    maxTokens: number
    reasoning: boolean
    supportsReasoningEffort: boolean
    input: readonly string[]
    thinkingLevel: ThinkingLevel
}>

/**
 * The agent's system prompt as the settings page holds it: what this project sends, and the text
 * Gofer ships. Both are the whole prompt — the page shows what the turn will send, not a fragment
 * of it — and a project storing nothing is simply a project whose `prompt` is the default.
 */
export type AgentPrompt = Readonly<{
    prompt: string
    defaultPrompt: string
}>

export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export type AiModelOption = Readonly<{
    id: string
    name: string
    contextWindow: number
    maxTokens: number
    reasoning: boolean
    supportsReasoningEffort: boolean
    input: readonly string[]
}>

/**
 * The rules Gofer holds a Godot project to. Both are on for a project opened for the first time.
 *
 * Neither takes effect the moment it is stored. The editor is told when a session goes ready,
 * because Godot reads the embed mode once at its own startup and never looks again.
 */
export type GodotSettings = Readonly<{
    /** Untyped and Variant-based GDScript is a parse error rather than a warning. */
    strictTyping: boolean
    /** The running game is drawn inside the editor rather than in a window of its own. */
    embedGameWindow: boolean
}>

export type GoferSettings = Readonly<{
    version: 1
    ai: AiSettings
    godot: GodotSettings
}>

export type SettingsResponse = Readonly<{
    settings: GoferSettings
    hasApiKey: boolean
    hasChatGptCredential?: boolean | undefined
    hasBraveApiKey?: boolean | undefined
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
    apiKey: ApiKeyUpdate
    braveApiKey: ApiKeyUpdate
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
    backupsRemoved: number
    memoryEmbeddingsRestored: number
}>

export const ALL_THINKING_LEVELS: readonly ThinkingLevel[] = [
    'off',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
    'max'
]
export const NO_THINKING_LEVELS: readonly ThinkingLevel[] = ['off']

/**
 * The sub-agent's shipped bounds. The same numbers as `default_subagent_*` in `settings.rs`, which
 * is the side that writes them to disk; these fill in a settings file written before the section
 * existed, or one hand-edited to drop a field.
 */
export const DEFAULT_SUBAGENT_SETTINGS: SubagentSettings = {
    commandTimeoutMinutes: 5,
    streamInactivityMinutes: 10,
    maxTurns: 24,
    maxAnswerChars: 12_000,
    maxShows: 6,
    retryAttempts: 2,
    retryBaseDelaySeconds: 1
}

/**
 * What each sub-agent slider may be dragged to.
 *
 * A range is a claim about what is sensible, which is why the sliders replaced typed numbers: a box
 * accepts 7 and 700000 with equal confidence, and neither the user nor the field could tell which of
 * those was a mistake. The top of each range is the largest value that is still a ceiling rather than
 * an absence of one, and every range starts where "off" is a real answer — except the retry wait,
 * which is only read when a retry happens and has no meaning at zero.
 */
export const SUBAGENT_RANGES = {
    commandTimeoutMinutes: {min: 0, max: 30, step: 1},
    streamInactivityMinutes: {min: 0, max: 30, step: 1},
    maxTurns: {min: 0, max: 40, step: 1},
    // Capped at what a tool result is truncated to anyway (`MAX_TOOL_TEXT_CHARS`): an answer larger
    // than that is cut by the layer above regardless of what is chosen here.
    maxAnswerChars: {min: 0, max: 24_000, step: 1_000},
    // Attention, not machine time. Past six the conversation has stopped converging and belongs
    // back in the chat, so the top of the range is a ceiling rather than an absence of one.
    maxShows: {min: 0, max: 12, step: 1},
    retryAttempts: {min: 0, max: 5, step: 1},
    retryBaseDelaySeconds: {min: 1, max: 10, step: 1}
} as const

/** A ceiling in minutes, where zero is not a short ceiling but no ceiling. */
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

export function showsLabel(shows: number) {
    if (shows === 0) return 'Never'
    return `${String(shows)} time${shows === 1 ? '' : 's'}`
}

export function retriesLabel(retries: number) {
    if (retries === 0) return 'Off'
    return `${String(retries)} ${retries === 1 ? 'retry' : 'retries'}`
}

/** What a build that has never been asked the question enforces: both rules, on. */
export const DEFAULT_GODOT_SETTINGS: GodotSettings = {
    strictTyping: true,
    embedGameWindow: true
}

function profileOf(ai: AiSettings): AiConnectionProfile {
    return {
        name: ai.name,
        baseUrl: ai.baseUrl,
        model: ai.model,
        api: ai.api,
        modelName: ai.modelName,
        contextWindow: ai.contextWindow,
        maxTokens: ai.maxTokens,
        reasoning: ai.reasoning,
        supportsReasoningEffort: ai.supportsReasoningEffort,
        input: ai.input,
        thinkingLevel: ai.thinkingLevel
    }
}

export function normalizeSettings(settings: GoferSettings): GoferSettings {
    const normalizedAi = Object.assign(
        {
            modelName: settings.ai.model,
            contextWindow: 120_064,
            maxTokens: 120_064,
            reasoning: false,
            supportsReasoningEffort: false,
            input: ['text'],
            thinkingLevel: 'off',
            maxRetries: 2,
            timeoutMs: 120_000,
            compactionPercent: 86
        },
        settings.ai,
        {
            subagent: {...DEFAULT_SUBAGENT_SETTINGS, ...settings.ai.subagent},
            // Filled the same way, for the same reason: a file written before the web tools existed
            // arrives without this, and an undefined engine reaches the worker as no engine at all.
            web: {...DEFAULT_WEB_SETTINGS, ...settings.ai.web}
        }
    ) as AiSettings
    const active = profileOf(normalizedAi)
    return {
        ...settings,
        // Filled in the same way the sub-agent bounds are, and for the same reason: a stored file
        // written before this section existed arrives without it, and an undefined rule read as
        // `false` would silently stop enforcing what the user never turned off.
        godot: {...DEFAULT_GODOT_SETTINGS, ...settings.godot},
        ai: {
            ...normalizedAi,
            // Never invented here. What a ChatGPT connection is belongs to the backend, which sends
            // it with every settings response; a driver with no profile is a driver Gofer cannot
            // offer, and the settings page draws it that way rather than guessing an address.
            local:
                normalizedAi.local
                ?? (normalizedAi.connectionType === 'openai-compatible' ? active : undefined),
            chatgpt:
                normalizedAi.chatgpt
                ?? (normalizedAi.connectionType === 'openai-codex' ? active : undefined)
        }
    }
}

export function selectAiDriver(ai: AiSettings, connectionType: AiConnectionType): AiSettings {
    if (ai.connectionType === connectionType) return ai
    const current = profileOf(ai)
    const local = ai.connectionType === 'openai-compatible' ? current : ai.local
    const chatgpt = ai.connectionType === 'openai-codex' ? current : ai.chatgpt
    const selected = connectionType === 'openai-compatible' ? local : chatgpt
    if (!selected) return ai
    return {...ai, ...selected, connectionType, local, chatgpt}
}

/**
 * Applies a chosen server model to the AI settings.
 *
 * Picking a model carries the model's own limits with it. Reasoning is the one that cannot simply
 * be copied: a model that cannot reason has no thinking level to keep, so the previously chosen
 * level is dropped rather than left pointing at nothing.
 *
 * The rule lives here because two places choose a model — the settings page's draft reducer and the
 * connection hook that saves the choice straight away — and a field copied into one of them only is
 * a model whose limits depend on which screen picked it.
 */
export function applyModelSelection(ai: AiSettings, model: AiModelOption): AiSettings {
    return withProfile({
        ...ai,
        model: model.id,
        modelName: model.name,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        reasoning: model.reasoning,
        supportsReasoningEffort: model.supportsReasoningEffort,
        input: model.input,
        thinkingLevel: model.reasoning ? ai.thinkingLevel : 'off'
    })
}

/**
 * Re-reads what the configured model can think, off the catalogue the server just answered with.
 *
 * Not [`applyModelSelection`], because nothing was selected. The limits stay as they are — a
 * context window typed by hand is the user's answer, and overwriting it on every reconnect would
 * undo a setting nobody changed. Whether a model reasons is not theirs to type: it is the model's
 * own fact, and a file that says no because the catalogue had never been read is a file whose
 * reasoning menu offers `off` and nothing else, for as long as that model stays selected.
 *
 * Returns the settings unchanged when the catalogue says what they already said, so a connection
 * that agrees costs no write.
 */
export function adoptModelReasoning(ai: AiSettings, model: AiModelOption): AiSettings {
    if (
        ai.reasoning === model.reasoning
        && ai.supportsReasoningEffort === model.supportsReasoningEffort
    ) {
        return ai
    }
    return withProfile({
        ...ai,
        reasoning: model.reasoning,
        supportsReasoningEffort: model.supportsReasoningEffort,
        thinkingLevel: model.reasoning ? ai.thinkingLevel : 'off'
    })
}

/** Mirrors the flat fields back into the driver's half of the saved pair. See `normalizeSettings`. */
function withProfile(ai: AiSettings): AiSettings {
    const profile = profileOf(ai)
    return {
        ...ai,
        local: ai.connectionType === 'openai-compatible' ? profile : ai.local,
        chatgpt: ai.connectionType === 'openai-codex' ? profile : ai.chatgpt
    }
}

/**
 * Which stored connection serves a driver, or nothing when that driver has never been configured.
 *
 * Read off the saved pair rather than the flat fields, because the pair is the only place both
 * drivers exist at once — the flat fields hold whichever one is active. `normalizeSettings` fills
 * the active driver's half of the pair from them, so the two can never disagree.
 */
export function connectionProfile(
    ai: AiSettings,
    connectionType: AiConnectionType
): AiConnectionProfile | undefined {
    return connectionType === 'openai-compatible' ? ai.local : ai.chatgpt
}

/**
 * The sub-agent's model as it starts life on a driver: that connection's own model.
 *
 * Seeded rather than left blank, because a driver the user has configured already names a model
 * that works on it. Picking a different one is the next thing they do, not the first.
 */
export function startSubagentConnection(
    ai: AiSettings,
    connectionType: AiConnectionType
): SubagentConnection | undefined {
    const profile = connectionProfile(ai, connectionType)
    if (!profile) return undefined
    return {
        connectionType,
        model: profile.model,
        modelName: profile.modelName,
        contextWindow: profile.contextWindow,
        maxTokens: profile.maxTokens,
        reasoning: profile.reasoning,
        supportsReasoningEffort: profile.supportsReasoningEffort,
        input: profile.input,
        thinkingLevel: profile.thinkingLevel
    }
}

/**
 * Applies a chosen model to the sub-agent's connection.
 *
 * The same rule as [`applyModelSelection`], and it has to be: a model carries its own limits, and a
 * model that cannot reason has no reasoning level to keep. Written out rather than shared, because
 * what the two update is a different shape — the parent's selection also has a profile pair to
 * mirror into, and the child has none.
 */
export function applySubagentModel(
    connection: SubagentConnection,
    model: AiModelOption
): SubagentConnection {
    return {
        ...connection,
        model: model.id,
        modelName: model.name,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        reasoning: model.reasoning,
        supportsReasoningEffort: model.supportsReasoningEffort,
        input: model.input,
        thinkingLevel: model.reasoning ? connection.thinkingLevel : 'off'
    }
}

/**
 * The same re-read as [`adoptModelReasoning`], for the sub-agent's own model.
 *
 * It needs its own, because the child's connection is a different shape and its `reasoning` was
 * copied from the parent's profile at the moment the child was first given a model of its own. A
 * profile that said `false` then goes on saying `false` after the catalogue is corrected, which is
 * how the sub-agent kept a reasoning menu offering nothing but `off`.
 */
export function adoptSubagentReasoning(
    connection: SubagentConnection,
    model: AiModelOption
): SubagentConnection {
    if (
        connection.reasoning === model.reasoning
        && connection.supportsReasoningEffort === model.supportsReasoningEffort
    ) {
        return connection
    }
    return {
        ...connection,
        reasoning: model.reasoning,
        supportsReasoningEffort: model.supportsReasoningEffort,
        thinkingLevel: model.reasoning ? connection.thinkingLevel : 'off'
    }
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

/**
 * Reads the compaction slider back as the thing it actually sets: the point in this connection's
 * window where summarising starts. A percentage on its own says nothing about whether the line
 * lands anywhere useful for a 120k window or an 8k one, so the token count travels with it.
 */
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

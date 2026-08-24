import type {DownloadProgress} from '@mjasnikovs/gofer-rag'

export type AiSettings = Readonly<{
    /** Which of the connections below is live. The only thing that decides. */
    connectionType: AiConnectionType
    connections: AiConnections
    maxRetries: number
    timeoutMs: number
    /**
     * How full the context may get before the old part of it is summarised away. 100 turns
     * compaction off. 86 draws the same line Pi does with its 16,384-token reserve.
     */
    compactionPercent: number
    subagent: SubagentSettings
    web: WebSettings
}>

/**
 * Every connection the settings file holds, by the driver that runs it.
 *
 * One entry per driver and no second copy of any of them, so "which one is live" is a lookup rather
 * than a rule. The live connection used to be stored twice — flattened onto `AiSettings` and
 * mirrored into a slot — and the paragraph explaining which copy to trust was written out in Rust,
 * here, and in the worker. The three had already drifted.
 *
 * A driver with no entry has never been configured, which a ChatGPT-only install's local driver
 * never is, and a driver with no entry is not offered in the picker.
 */
export type AiConnections = Readonly<Partial<Record<AiConnectionType, AiConnectionProfile>>>

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

export type AiConnectionType = 'openai-compatible' | 'openai-codex' | 'openrouter'
export type AiApiDialect = 'openai-completions' | 'openai-codex-responses'

/**
 * OpenRouter's address, which the user never types.
 *
 * The whole point of the driver: a fixed host whose catalogue answers every question the local
 * driver has to ask the user by hand.
 */
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'

/**
 * One connection and the model chosen on it: an address half, and a `ModelChoice`.
 *
 * The split is the point. The address is the connection's — where it is, which dialect it speaks,
 * how thinking is turned on there — and the model half is what a catalogue can answer for and the
 * sub-agent can override. The child borrows the first and replaces the second, which is one field
 * rather than nine.
 */
export type AiConnectionProfile = Readonly<{
    name: string
    baseUrl: string
    api: AiApiDialect
    /**
     * Whether thinking is turned on by a chat-template argument rather than by an effort field.
     *
     * True for a llama.cpp host, which takes `chat_template_kwargs.enable_thinking` and ignores
     * `reasoning_effort` without a word. A property of the connection, not of the model on it, and
     * derived from the server rather than typed.
     */
    chatTemplateThinking: boolean
    model: ModelChoice
}>

/**
 * A model, as the user chose it: which one, what it can do, and the level it is asked at.
 *
 * Everything but the level is what the catalogue says — which is exactly `AiModelOption`, so this
 * is that type plus the one field the user owns rather than a second list of the same nine facts.
 */
export type ModelChoice = AiModelOption & Readonly<{thinkingLevel: ThinkingLevel}>

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
    /** The model half of that connection, replaced. The address half is borrowed as it stands. */
    model: ModelChoice
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

export type ThinkingLevel =
    | 'off'
    /** The one level a model that thinks without named efforts has. See `thinkingLevelsFor`. */
    | 'on'
    | 'minimal'
    | 'low'
    | 'medium'
    | 'high'
    | 'xhigh'
    | 'max'

export type AiModelOption = Readonly<{
    id: string
    name: string
    contextWindow: number
    maxTokens: number
    reasoning: boolean
    supportsReasoningEffort: boolean
    /** See `AiSettings`. Empty for anything but a local server that named its own efforts. */
    thinkingLevels: readonly ThinkingLevel[]
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
    hasOpenrouterApiKey?: boolean | undefined
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
    openrouterApiKey: ApiKeyUpdate
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

/**
 * Which secret a key field is about. The same four names as `Secret` in `settings.rs`.
 *
 * Four secrets used to be four sets of draft fields, four actions and three copies of one field on
 * screen, all differing in a noun. Naming them is what lets one field, one action and one draft
 * entry serve all of them.
 */
export type SecretName = 'ai-default' | 'brave' | 'openrouter' | 'chat-gpt'

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

/**
 * The levels a model with named efforts can be asked at, which is the menu rather than the
 * validation set. `on` is not one of them: it belongs to a template with no efforts to name, and a
 * model that has efforts has no use for it. `EFFORT_LEVELS` in `settings.rs` is the same list, and
 * the levels a settings file may legally hold are `EVERY_LEVEL` there.
 */
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
/** What a model that thinks and has no efforts to name offers. See `thinkingLevelsFor`. */
export const ON_OFF_THINKING_LEVELS: readonly ThinkingLevel[] = ['off', 'on']

/**
 * The levels one model may be asked at, which is not one list.
 *
 * Three cases, and the middle one is why this exists. A chat template can have a place for thinking
 * and no effort to name — llama.cpp reports exactly that pair for a Qwen build — so the honest
 * control there is on or off, not seven words that all mean on.
 */
export function thinkingLevelsFor(model: ThinkingCapable): readonly ThinkingLevel[] {
    // Reasoning first, and it is not redundant: a model can be marked as taking an effort and as
    // not thinking at all, and a model that does not think has nothing to spend an effort on.
    if (!model.reasoning) return NO_THINKING_LEVELS
    // What the server named wins outright. Its template raises on an effort it does not know, and
    // llama.cpp turns that into an HTTP 500 on every request of the turn.
    if (model.thinkingLevels.length > 0) return ['off', ...model.thinkingLevels]
    return model.supportsReasoningEffort ? EFFORT_LEVELS : ON_OFF_THINKING_LEVELS
}

/** The three fields that decide what a reasoning menu offers. See `thinkingLevelsFor`. */
type ThinkingCapable = Readonly<{
    reasoning: boolean
    supportsReasoningEffort: boolean
    thinkingLevels: readonly ThinkingLevel[]
}>

/** The stored level, kept if the model still offers it and dropped to `off` if it does not. */
export function keepThinkingLevel(model: ThinkingCapable, level: ThinkingLevel): ThinkingLevel {
    return thinkingLevelsFor(model).includes(level) ? level : 'off'
}

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

export function retriesLabel(retries: number) {
    if (retries === 0) return 'Off'
    return `${String(retries)} ${retries === 1 ? 'retry' : 'retries'}`
}

/** What a build that has never been asked the question enforces: both rules, on. */
export const DEFAULT_GODOT_SETTINGS: GodotSettings = {
    strictTyping: true,
    embedGameWindow: true
}

/**
 * Fills in what a settings response left out, so no screen has to guess at an absent field.
 *
 * The three numbers and the three sections a file written before them arrives without. The
 * connections themselves are
 * never invented here: what a ChatGPT connection is belongs to the backend, which sends it with
 * every settings response, and a driver with no connection is one Gofer cannot offer — the settings
 * page draws it that way rather than guessing an address.
 */
export function normalizeSettings(settings: GoferSettings): GoferSettings {
    const tuning = {maxRetries: 2, timeoutMs: 120_000, compactionPercent: 86}
    return {
        ...settings,
        // Filled in the same way the sub-agent bounds are, and for the same reason: a stored file
        // written before this section existed arrives without it, and an undefined rule read as
        // `false` would silently stop enforcing what the user never turned off.
        godot: {...DEFAULT_GODOT_SETTINGS, ...settings.godot},
        ai: {
            ...tuning,
            ...settings.ai,
            // Spread rather than taken whole, so a response that carried no connections at all
            // arrives as a map with none in it rather than as an absent field every reader would
            // then have to guard against.
            connections: {...settings.ai.connections},
            subagent: {...DEFAULT_SUBAGENT_SETTINGS, ...settings.ai.subagent},
            // Filled the same way, for the same reason: a file written before the web tools existed
            // arrives without this, and an undefined engine reaches the worker as no engine at all.
            web: {...DEFAULT_WEB_SETTINGS, ...settings.ai.web}
        }
    }
}

/**
 * Switches the live driver, which is one field, because there is nothing to move.
 *
 * It used to write the driver being left back into its own slot first: its flat fields were the
 * only copy the user had been editing, and without that write they were overwritten by the driver
 * being switched to and never reached the pair. There are no flat fields now — every driver's
 * connection has only ever been in one place — so switching is naming a different key.
 *
 * A driver with no connection is not switched to: there would be no address and no dialect to run
 * it on, and the picker does not offer it for exactly that reason.
 */
export function selectAiDriver(ai: AiSettings, connectionType: AiConnectionType): AiSettings {
    if (ai.connectionType === connectionType) return ai
    if (!connectionProfile(ai, connectionType)) return ai
    return {...ai, connectionType}
}

/**
 * Applies a chosen model, wherever a model is chosen.
 *
 * Picking a model carries the model's own limits with it. Reasoning is the one that cannot simply
 * be copied: a model that cannot reason has no thinking level to keep, so the previously chosen
 * level is dropped rather than left pointing at nothing.
 *
 * One function rather than two. The parent's selection and the sub-agent's used to be written out
 * separately because what they updated was a different shape — the parent's had a profile pair to
 * mirror into, and the child had none — and both shapes are a `ModelChoice` now.
 */
export function applyModelSelection(choice: ModelChoice, model: AiModelOption): ModelChoice {
    return {...model, thinkingLevel: keepThinkingLevel(model, choice.thinkingLevel)}
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
 * Returns the choice unchanged when the catalogue says what it already said, so a connection that
 * agrees costs no write.
 */
export function adoptModelReasoning(choice: ModelChoice, model: AiModelOption): ModelChoice {
    if (
        choice.reasoning === model.reasoning
        && choice.supportsReasoningEffort === model.supportsReasoningEffort
    ) {
        return choice
    }
    return {
        ...choice,
        reasoning: model.reasoning,
        supportsReasoningEffort: model.supportsReasoningEffort,
        thinkingLevels: model.thinkingLevels,
        thinkingLevel: keepThinkingLevel(model, choice.thinkingLevel)
    }
}

/** Which stored connection serves a driver, or nothing when that driver has never been configured. */
export function connectionProfile(
    ai: AiSettings,
    connectionType: AiConnectionType
): AiConnectionProfile | undefined {
    return ai.connections[connectionType]
}

/** The connection the live driver runs on, which is the same lookup against `connectionType`. */
export function activeConnection(ai: AiSettings): AiConnectionProfile | undefined {
    return connectionProfile(ai, ai.connectionType)
}

/**
 * The model the live driver is on, or nothing while nothing has been loaded.
 *
 * Takes the whole settings rather than the `ai` half, because every screen that asks holds them
 * optionally: a window that has not heard from the backend yet has no model to name, and that is an
 * ordinary state rather than a fault.
 */
export function activeModel(settings?: GoferSettings): ModelChoice | undefined {
    return settings && activeConnection(settings.ai)?.model
}

/** One driver's connection, replaced, leaving the others alone. */
function withConnection(
    ai: AiSettings,
    connectionType: AiConnectionType,
    connection: AiConnectionProfile
): AiSettings {
    return {...ai, connections: {...ai.connections, [connectionType]: connection}}
}

/**
 * The live connection, rewritten. Every edit to what the live driver runs on is one of these.
 *
 * A driver with no connection is left alone rather than given one: what a connection is belongs to
 * the backend, and inventing an address here is how a screen writes a server nobody named.
 */
export function withActiveConnection(
    ai: AiSettings,
    change: (connection: AiConnectionProfile) => AiConnectionProfile
): AiSettings {
    const connection = activeConnection(ai)
    if (!connection) return ai
    return withConnection(ai, ai.connectionType, change(connection))
}

/**
 * What each driver is called on screen. Separate from the stored id, and one-directional: a label
 * must never be written to the settings file. Same rule as `SEARCH_PROVIDER_LABELS`.
 */
export const AI_CONNECTION_LABELS: Readonly<Record<AiConnectionType, string>> = {
    'openai-compatible': 'Local model',
    'openai-codex': 'ChatGPT subscription',
    openrouter: 'OpenRouter'
}

/** Every driver a build knows, in the order the pickers offer them. */
export const AI_CONNECTION_TYPES: readonly AiConnectionType[] = [
    'openai-compatible',
    'openai-codex',
    'openrouter'
]

/**
 * The drivers a picker may offer, which is the drivers that have somewhere to run.
 *
 * A driver with no saved profile is not offered: switching to it would need an address and a
 * dialect the settings page does not own. Both pickers ask this rather than each building the list
 * from the profiles itself — two hand-written lists of the same thing can disagree, and the one
 * that is wrong is whichever was not touched when a driver was added.
 */
export function driverOptions(ai: AiSettings): {value: AiConnectionType; label: string}[] {
    return AI_CONNECTION_TYPES.filter(
        connectionType => connectionProfile(ai, connectionType) !== undefined
    ).map(connectionType => ({value: connectionType, label: AI_CONNECTION_LABELS[connectionType]}))
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

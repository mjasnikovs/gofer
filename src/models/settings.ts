import type {DownloadProgress} from '@mjasnikovs/gofer-rag'

export type AiSettings = Readonly<{
    connectionType: 'openai-compatible'
    name: string
    baseUrl: string
    model: string
    api: 'openai-completions'
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
    systemPrompt: string
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

export type GoferSettings = Readonly<{
    version: 1
    ai: AiSettings
}>

export type SettingsResponse = Readonly<{
    settings: GoferSettings
    hasApiKey: boolean
    credentialStoreError?: string
}>

export type ApiKeyUpdate =
    | Readonly<{action: 'keep'}>
    | Readonly<{action: 'set'; value: string}>
    | Readonly<{action: 'clear'}>

export type SettingsRequest = Readonly<{
    settings: GoferSettings
    apiKey: ApiKeyUpdate
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

export function normalizeSettings(settings: GoferSettings): GoferSettings {
    return {
        ...settings,
        ai: Object.assign(
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
                compactionPercent: 86,
                systemPrompt: ''
            },
            settings.ai
        )
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

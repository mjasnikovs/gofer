import type {DownloadProgress} from '@mjasnikovs/gofer-rag'
import {apiKeyUpdate, normalizeSettings} from './settings'
import type {
    AiModelOption,
    AiSettings,
    ApiKeyIntent,
    CacheStatus,
    GoferSettings,
    Notice,
    SettingsRequest,
    SettingsResponse
} from './settings'

/**
 * The long-running things the settings page can be doing. They are named rather than counted
 * because two of them overlap: a model download and a project backup touch different subsystems
 * and the page lets both buttons spin at once.
 */
export type SettingsTask =
    'testing' | 'saving' | 'downloading' | 'deleting' | 'backingUp' | 'cleaningStorage'

export type SettingsBusy = Readonly<Record<SettingsTask, boolean>>

/**
 * Everything the settings dialog holds, as one value.
 *
 * Kept whole and kept out of React on purpose: the page's behaviour is then a pure function of
 * this and an action, so it can be read in one place and tested without mounting anything or
 * waiting for anything.
 */
export type SettingsDraft = Readonly<{
    /** Absent until the backend answers, and while it never does. */
    settings?: GoferSettings | undefined
    /** Whether the credential store already holds a key, as the backend last reported it. */
    hasApiKey: boolean
    /** What the user has typed into the key field this session. Never the stored key. */
    apiKey: string
    apiKeyIntent: ApiKeyIntent
    cache?: CacheStatus | undefined
    progress?: DownloadProgress | undefined
    notice?: Notice | undefined
    isLoading: boolean
    isDeleteOpen: boolean
    busy: SettingsBusy
    /** Models the server reported on the last successful connection test. */
    availableModels: readonly AiModelOption[]
}>

export type SettingsAction =
    /** The backend answered with settings and a cache reading. */
    | Readonly<{type: 'loaded'; response: SettingsResponse; cache: CacheStatus}>
    /** Loading finished without settings: no desktop backend, or the call threw. */
    | Readonly<{type: 'unavailable'; notice: Notice}>
    | Readonly<{type: 'began'; task: SettingsTask}>
    | Readonly<{type: 'ended'; task: SettingsTask}>
    | Readonly<{type: 'failed'; task: SettingsTask; notice: Notice}>
    | Readonly<{type: 'ai-changed'; update: Partial<AiSettings>}>
    | Readonly<{type: 'model-chosen'; model: AiModelOption}>
    | Readonly<{type: 'models-listed'; models: readonly AiModelOption[]}>
    | Readonly<{type: 'api-key-typed'; value: string}>
    | Readonly<{type: 'api-key-removal-toggled'}>
    | Readonly<{type: 'saved'; response: SettingsResponse}>
    /** Something finished with a result worth showing, and nothing else about the page changed. */
    | Readonly<{type: 'noticed'; notice: Notice}>
    | Readonly<{type: 'cache-read'; cache: CacheStatus}>
    /** The download has started, so the cache is in flux before the backend says so. */
    | Readonly<{type: 'cache-downloading'}>
    | Readonly<{type: 'progress'; progress?: DownloadProgress | undefined}>
    | Readonly<{type: 'delete-dialog'; isOpen: boolean}>
    | Readonly<{type: 'notice-dismissed'}>

const NOTHING_RUNNING: SettingsBusy = {
    testing: false,
    saving: false,
    downloading: false,
    deleting: false,
    backingUp: false,
    cleaningStorage: false
}

export const INITIAL_SETTINGS_DRAFT: SettingsDraft = {
    hasApiKey: false,
    apiKey: '',
    apiKeyIntent: 'keep',
    isLoading: true,
    isDeleteOpen: false,
    busy: NOTHING_RUNNING,
    availableModels: []
}

function busyWith(busy: SettingsBusy, task: SettingsTask, isRunning: boolean): SettingsBusy {
    return {...busy, [task]: isRunning}
}

/** What the page sends to the backend, or `undefined` while there is nothing loaded to send. */
export function settingsRequest(state: SettingsDraft): SettingsRequest | undefined {
    if (!state.settings) return undefined
    return {settings: state.settings, apiKey: apiKeyUpdate(state.apiKeyIntent, state.apiKey)}
}

/**
 * A save either stored the key or could not reach the credential store. Both wrote the settings,
 * so neither is an error, but only one of them is the whole of what the user asked for.
 */
function savedNotice(response: SettingsResponse): Notice {
    if (response.credentialStoreError) {
        return {
            status: 'warning',
            title: 'Connection saved without API key access',
            description: response.credentialStoreError
        }
    }
    return {
        status: 'success',
        title: 'Settings saved',
        description: 'Gofer will use this AI connection for subsequent requests.'
    }
}

/** Whether the model cache may not be touched: the backend says busy, or this page is downloading. */
export function cacheIsBusy(state: SettingsDraft) {
    return state.cache?.state === 'busy' || state.busy.downloading
}

export function canDeleteCache(state: SettingsDraft) {
    return Boolean(state.cache && state.cache.sizeBytes > 0 && !cacheIsBusy(state))
}

export function reduce(state: SettingsDraft, action: SettingsAction): SettingsDraft {
    switch (action.type) {
        case 'loaded':
            return {
                ...state,
                settings: normalizeSettings(action.response.settings),
                hasApiKey: action.response.hasApiKey,
                cache: action.cache,
                isLoading: false,
                notice:
                    action.response.credentialStoreError ?
                        {
                            status: 'warning',
                            title: 'API key storage is unavailable',
                            description: action.response.credentialStoreError
                        }
                    :   state.notice
            }

        case 'unavailable':
            return {...state, isLoading: false, notice: action.notice}

        // Starting work clears the last notice: it described the previous attempt, not this one.
        case 'began':
            return {...state, busy: busyWith(state.busy, action.task, true), notice: undefined}

        case 'ended':
            return {
                ...state,
                busy: busyWith(state.busy, action.task, false),
                progress: action.task === 'downloading' ? undefined : state.progress
            }

        case 'failed':
            return {
                ...state,
                busy: busyWith(state.busy, action.task, false),
                notice: action.notice
            }

        case 'ai-changed':
            if (!state.settings) return state
            return {
                ...state,
                settings: {...state.settings, ai: {...state.settings.ai, ...action.update}}
            }

        /*
         * Picking a server model carries the model's own limits with it. Reasoning is the one that
         * cannot simply be copied: a model that cannot reason has no thinking level to keep, so the
         * previously chosen level is dropped rather than left pointing at nothing.
         */
        case 'model-chosen': {
            if (!state.settings) return state
            const {model} = action
            return {
                ...state,
                settings: {
                    ...state.settings,
                    ai: {
                        ...state.settings.ai,
                        model: model.id,
                        modelName: model.name,
                        contextWindow: model.contextWindow,
                        maxTokens: model.maxTokens,
                        reasoning: model.reasoning,
                        supportsReasoningEffort: model.supportsReasoningEffort,
                        input: model.input,
                        thinkingLevel: model.reasoning ? state.settings.ai.thinkingLevel : 'off'
                    }
                }
            }
        }

        case 'models-listed':
            return {...state, availableModels: action.models}

        // Emptying the field means "leave the stored key alone", not "remove it": removing is the
        // separate button, and it is the only thing that reaches 'clear'.
        case 'api-key-typed':
            return {
                ...state,
                apiKey: action.value,
                apiKeyIntent: action.value.trim() ? 'set' : 'keep'
            }

        case 'api-key-removal-toggled':
            return {
                ...state,
                apiKey: '',
                apiKeyIntent: state.apiKeyIntent === 'clear' ? 'keep' : 'clear'
            }

        case 'saved':
            return {
                ...state,
                settings: action.response.settings,
                hasApiKey: action.response.hasApiKey,
                apiKey: '',
                apiKeyIntent: 'keep',
                busy: busyWith(state.busy, 'saving', false),
                notice: savedNotice(action.response)
            }

        case 'noticed':
            return {...state, notice: action.notice}

        case 'cache-read':
            return {...state, cache: action.cache}

        case 'cache-downloading':
            return {...state, cache: state.cache ? {...state.cache, state: 'busy'} : state.cache}

        case 'progress':
            return {...state, progress: action.progress}

        case 'delete-dialog':
            return {...state, isDeleteOpen: action.isOpen}

        case 'notice-dismissed':
            return {...state, notice: undefined}
    }
}

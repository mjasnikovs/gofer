import type {DownloadProgress} from '@mjasnikovs/gofer-rag'
import {commandErrorMessage} from '../utils/command-error'
import {
    activeConnection,
    adoptModelReasoning,
    apiKeyUpdate,
    applyModelSelection,
    normalizeSettings,
    selectAiDriver,
    startSubagentConnection,
    withActiveConnection
} from './settings'
import type {
    AgentPrompt,
    AiConnectionProfile,
    AiConnectionType,
    AiModelOption,
    AiSettings,
    ApiKeyIntent,
    CacheStatus,
    GodotSettings,
    GoferSettings,
    ModelChoice,
    Notice,
    SecretName,
    SettingsRequest,
    SettingsResponse,
    SubagentConnection,
    ThinkingLevel
} from './settings'

export type SettingsTask =
    | 'testing'
    | 'saving'
    | 'savingPrompt'
    | 'savingGodot'
    | 'downloading'
    | 'deleting'
    | 'backingUp'
    | 'cleaningStorage'

export type SettingsBusy = Readonly<Record<SettingsTask, boolean>>

export type SettingsTab = 'ai' | 'prompt' | 'godot' | 'models' | 'storage'

export const TASK_TABS: Readonly<Record<SettingsTask, SettingsTab>> = {
    testing: 'ai',
    saving: 'ai',
    savingPrompt: 'prompt',
    savingGodot: 'godot',
    downloading: 'models',
    deleting: 'models',
    backingUp: 'storage',
    cleaningStorage: 'storage'
}

export type SettingsNotices = Readonly<Partial<Record<SettingsTab, Notice>>>

export type KeyDraft = Readonly<{
    isStored: boolean
    typed: string
    intent: ApiKeyIntent
}>

const NO_KEY: KeyDraft = {isStored: false, typed: '', intent: 'keep'}

export type SettingsDraft = Readonly<{
    settings?: GoferSettings | undefined
    keys: Readonly<Record<SecretName, KeyDraft>>
    tab: SettingsTab
    cache?: CacheStatus | undefined
    progress?: DownloadProgress | undefined
    notices: SettingsNotices
    isLoading: boolean
    isDeleteOpen: boolean
    busy: SettingsBusy
    availableModels: readonly AiModelOption[]
    subagentModels: readonly AiModelOption[]
    agentPrompt: string
    savedAgentPrompt: string
    defaultAgentPrompt: string
}>

export type SettingsTaskAction =
    | Readonly<{type: 'began'; task: SettingsTask}>
    | Readonly<{type: 'ended'; task: SettingsTask}>
    | Readonly<{type: 'failed'; task: SettingsTask; notice: Notice}>

export type SettingsAction =
    | Readonly<{
          type: 'loaded'
          response: SettingsResponse
          cache: CacheStatus
          prompt: AgentPrompt
      }>
    | Readonly<{type: 'unavailable'; notice: Notice}>
    | Readonly<{type: 'tab-chosen'; tab: SettingsTab}>
    | Readonly<{type: 'ai-changed'; update: Partial<AiSettings>}>
    | Readonly<{type: 'connection-changed'; update: Partial<AiConnectionProfile>}>
    | Readonly<{type: 'model-changed'; update: Partial<ModelChoice>}>
    | Readonly<{type: 'ai-driver-chosen'; connectionType: AiSettings['connectionType']}>
    | Readonly<{type: 'model-chosen'; model: AiModelOption}>
    | Readonly<{type: 'model-reconciled'; model: AiModelOption}>
    | Readonly<{type: 'models-listed'; models: readonly AiModelOption[]}>
    | Readonly<{type: 'subagent-driver-chosen'; connectionType?: AiConnectionType | undefined}>
    | Readonly<{type: 'subagent-model-chosen'; model: AiModelOption}>
    | Readonly<{type: 'subagent-model-reconciled'; model: AiModelOption}>
    | Readonly<{type: 'subagent-thinking-chosen'; thinkingLevel: ThinkingLevel}>
    | Readonly<{type: 'subagent-models-listed'; models: readonly AiModelOption[]}>
    | Readonly<{type: 'key-typed'; secret: SecretName; value: string}>
    | Readonly<{type: 'key-removal-toggled'; secret: SecretName}>
    | Readonly<{type: 'chatgpt-auth-changed'; isAuthenticated: boolean}>
    | Readonly<{type: 'saved'; response: SettingsResponse}>
    | Readonly<{type: 'prompt-typed'; value: string}>
    | Readonly<{type: 'prompt-restored'}>
    | Readonly<{type: 'prompt-saved'; prompt: AgentPrompt}>
    | Readonly<{type: 'godot-changed'; update: Partial<GodotSettings>}>
    | Readonly<{type: 'godot-saved'; response: SettingsResponse}>
    | Readonly<{type: 'noticed'; tab: SettingsTab; notice: Notice}>
    | Readonly<{type: 'cache-read'; cache: CacheStatus}>
    | Readonly<{type: 'cache-downloading'}>
    | Readonly<{type: 'progress'; progress?: DownloadProgress | undefined}>
    | Readonly<{type: 'delete-dialog'; isOpen: boolean}>
    | Readonly<{type: 'notice-dismissed'; tab: SettingsTab}>

const NOTHING_RUNNING: SettingsBusy = {
    testing: false,
    saving: false,
    savingPrompt: false,
    savingGodot: false,
    downloading: false,
    deleting: false,
    backingUp: false,
    cleaningStorage: false
}

export const INITIAL_SETTINGS_DRAFT: SettingsDraft = {
    keys: {
        'ai-default': NO_KEY,
        brave: NO_KEY,
        openrouter: NO_KEY,
        cerebras: NO_KEY,
        'chat-gpt': NO_KEY
    },
    tab: 'ai',
    notices: {},
    isLoading: true,
    isDeleteOpen: false,
    busy: NOTHING_RUNNING,
    availableModels: [],
    subagentModels: [],
    agentPrompt: '',
    savedAgentPrompt: '',
    defaultAgentPrompt: ''
}

function busyWith(busy: SettingsBusy, task: SettingsTask, isRunning: boolean): SettingsBusy {
    return {...busy, [task]: isRunning}
}

function withSubagent(
    settings: GoferSettings,
    connection: SubagentConnection | undefined
): GoferSettings {
    return {
        ...settings,
        ai: {...settings.ai, subagent: {...settings.ai.subagent, connection}}
    }
}

function withLiveConnection(
    settings: GoferSettings,
    change: (connection: AiConnectionProfile) => AiConnectionProfile
): GoferSettings {
    return {...settings, ai: withActiveConnection(settings.ai, change)}
}

function withKey(state: SettingsDraft, secret: SecretName, key: Partial<KeyDraft>): SettingsDraft {
    return {...state, keys: {...state.keys, [secret]: {...state.keys[secret], ...key}}}
}

function withStoredKeys(state: SettingsDraft, response: SettingsResponse): SettingsDraft {
    return {
        ...state,
        keys: {
            'ai-default': {...state.keys['ai-default'], isStored: response.hasApiKey},
            brave: {...state.keys.brave, isStored: response.hasBraveApiKey ?? false},
            openrouter: {
                ...state.keys.openrouter,
                isStored: response.hasOpenrouterApiKey ?? false
            },
            cerebras: {...state.keys.cerebras, isStored: response.hasCerebrasApiKey ?? false},
            'chat-gpt': {
                ...state.keys['chat-gpt'],
                isStored: response.hasChatGptCredential ?? false
            }
        }
    }
}

function forgottenKeys(keys: SettingsDraft['keys']): SettingsDraft['keys'] {
    return {
        'ai-default': {...keys['ai-default'], typed: '', intent: 'keep'},
        brave: {...keys.brave, typed: '', intent: 'keep'},
        openrouter: {...keys.openrouter, typed: '', intent: 'keep'},
        cerebras: {...keys.cerebras, typed: '', intent: 'keep'},
        'chat-gpt': {...keys['chat-gpt'], typed: '', intent: 'keep'}
    }
}

function noticedOn(notices: SettingsNotices, tab: SettingsTab, notice?: Notice): SettingsNotices {
    return {...notices, [tab]: notice}
}

export function settingsRequest(state: SettingsDraft): SettingsRequest | undefined {
    if (!state.settings) return undefined
    const {'ai-default': ai, brave, openrouter, cerebras} = state.keys
    return {
        settings: state.settings,
        apiKey: apiKeyUpdate(ai.intent, ai.typed),
        braveApiKey: apiKeyUpdate(brave.intent, brave.typed),
        openrouterApiKey: apiKeyUpdate(openrouter.intent, openrouter.typed),
        cerebrasApiKey: apiKeyUpdate(cerebras.intent, cerebras.typed)
    }
}

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

export function agentPromptIsUnsaved(state: SettingsDraft) {
    return state.agentPrompt !== state.savedAgentPrompt
}

export function agentPromptIsDefault(state: SettingsDraft) {
    return state.agentPrompt.trim() === state.defaultAgentPrompt.trim()
}

export function cacheIsBusy(state: SettingsDraft) {
    return state.cache?.state === 'busy' || state.busy.downloading
}

export function canDeleteCache(state: SettingsDraft) {
    return Boolean(state.cache && state.cache.sizeBytes > 0 && !cacheIsBusy(state))
}

export function reduce(
    state: SettingsDraft,
    action: SettingsAction | SettingsTaskAction
): SettingsDraft {
    switch (action.type) {
        case 'loaded':
            return {
                ...withStoredKeys(state, action.response),
                settings: normalizeSettings(action.response.settings),
                cache: action.cache,
                agentPrompt: action.prompt.prompt,
                savedAgentPrompt: action.prompt.prompt,
                defaultAgentPrompt: action.prompt.defaultPrompt,
                isLoading: false,
                notices:
                    action.response.credentialStoreError ?
                        {
                            ...state.notices,
                            ai: {
                                status: 'warning',
                                title: 'API key storage is unavailable',
                                description: action.response.credentialStoreError
                            }
                        }
                    :   state.notices
            }

        case 'unavailable':
            return {...state, isLoading: false, notices: {...state.notices, ai: action.notice}}

        case 'tab-chosen':
            return {...state, tab: action.tab}

        case 'began':
            return {
                ...state,
                busy: busyWith(state.busy, action.task, true),
                notices: noticedOn(state.notices, TASK_TABS[action.task], undefined)
            }

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
                notices: noticedOn(state.notices, TASK_TABS[action.task], action.notice)
            }

        case 'ai-changed':
            if (!state.settings) return state
            return {
                ...state,
                settings: {...state.settings, ai: {...state.settings.ai, ...action.update}}
            }

        case 'ai-driver-chosen':
            if (!state.settings) return state
            return {
                ...state,
                availableModels: [],
                settings: {
                    ...state.settings,
                    ai: selectAiDriver(state.settings.ai, action.connectionType)
                }
            }

        case 'connection-changed':
            if (!state.settings) return state
            return {
                ...state,
                settings: withLiveConnection(state.settings, connection => ({
                    ...connection,
                    ...action.update
                }))
            }

        case 'model-changed':
            if (!state.settings) return state
            return {
                ...state,
                settings: withLiveConnection(state.settings, connection => ({
                    ...connection,
                    model: {...connection.model, ...action.update}
                }))
            }

        case 'model-chosen': {
            if (!state.settings) return state
            return {
                ...state,
                settings: withLiveConnection(state.settings, connection => ({
                    ...connection,
                    model: applyModelSelection(connection.model, action.model)
                }))
            }
        }

        case 'model-reconciled': {
            const connection = state.settings && activeConnection(state.settings.ai)
            if (!state.settings || !connection) return state
            const model = adoptModelReasoning(connection.model, action.model)
            if (model === connection.model) return state
            return {
                ...state,
                settings: withLiveConnection(state.settings, chosen => ({...chosen, model}))
            }
        }

        case 'models-listed':
            return {...state, availableModels: action.models}

        case 'subagent-driver-chosen': {
            if (!state.settings) return state
            return {
                ...state,
                subagentModels: [],
                settings: withSubagent(
                    state.settings,
                    action.connectionType === undefined ?
                        undefined
                    :   startSubagentConnection(state.settings.ai, action.connectionType)
                )
            }
        }

        case 'subagent-model-chosen': {
            const chosen = state.settings?.ai.subagent.connection
            if (!state.settings || !chosen) return state
            return {
                ...state,
                settings: withSubagent(state.settings, {
                    ...chosen,
                    model: applyModelSelection(chosen.model, action.model)
                })
            }
        }

        case 'subagent-thinking-chosen': {
            const chosen = state.settings?.ai.subagent.connection
            if (!state.settings || !chosen) return state
            return {
                ...state,
                settings: withSubagent(state.settings, {
                    ...chosen,
                    model: {...chosen.model, thinkingLevel: action.thinkingLevel}
                })
            }
        }

        case 'subagent-model-reconciled': {
            const chosen = state.settings?.ai.subagent.connection
            if (!state.settings || !chosen) return state
            const adopted = adoptModelReasoning(chosen.model, action.model)
            if (adopted === chosen.model) return state
            return {
                ...state,
                settings: withSubagent(state.settings, {...chosen, model: adopted})
            }
        }

        case 'subagent-models-listed':
            return {...state, subagentModels: action.models}

        case 'key-typed':
            return withKey(state, action.secret, {
                typed: action.value,
                intent: action.value.trim() ? 'set' : 'keep'
            })

        case 'key-removal-toggled':
            return withKey(state, action.secret, {
                typed: '',
                intent: state.keys[action.secret].intent === 'clear' ? 'keep' : 'clear'
            })

        case 'chatgpt-auth-changed':
            return withKey(state, 'chat-gpt', {isStored: action.isAuthenticated})

        case 'saved':
            return {
                ...withStoredKeys({...state, keys: forgottenKeys(state.keys)}, action.response),
                settings: normalizeSettings(action.response.settings),
                busy: busyWith(state.busy, 'saving', false),
                notices: noticedOn(state.notices, 'ai', savedNotice(action.response))
            }

        case 'prompt-typed':
            return {...state, agentPrompt: action.value}

        case 'prompt-restored':
            return {...state, agentPrompt: state.defaultAgentPrompt}

        case 'prompt-saved':
            return {
                ...state,
                agentPrompt: action.prompt.prompt,
                savedAgentPrompt: action.prompt.prompt,
                defaultAgentPrompt: action.prompt.defaultPrompt,
                notices: noticedOn(state.notices, 'prompt', {
                    status: 'success',
                    title: 'Agent prompt saved',
                    description: 'The agent is told this before every turn in this project.'
                })
            }

        case 'godot-changed':
            if (!state.settings) return state
            return {
                ...state,
                settings: {...state.settings, godot: {...state.settings.godot, ...action.update}}
            }

        case 'godot-saved':
            return {
                ...state,
                settings: normalizeSettings(action.response.settings),
                busy: busyWith(state.busy, 'savingGodot', false),
                notices: noticedOn(state.notices, 'godot', {
                    status: 'success',
                    title: 'Godot rules saved',
                    description: 'They are applied the next time a Godot session starts.'
                })
            }

        case 'noticed':
            return {...state, notices: noticedOn(state.notices, action.tab, action.notice)}

        case 'cache-read':
            return {...state, cache: action.cache}

        case 'cache-downloading':
            return {...state, cache: state.cache ? {...state.cache, state: 'busy'} : state.cache}

        case 'progress':
            return {...state, progress: action.progress}

        case 'delete-dialog':
            return {...state, isDeleteOpen: action.isOpen}

        case 'notice-dismissed':
            return {...state, notices: noticedOn(state.notices, action.tab, undefined)}
    }
}

export async function runSettingsTask(
    dispatch: (action: SettingsTaskAction) => void,
    task: SettingsTask,
    title: string,
    work: () => Promise<void>
): Promise<void> {
    dispatch({type: 'began', task})
    try {
        await work()
    } catch (error) {
        dispatch({
            type: 'failed',
            task,
            notice: {status: 'error', title, description: commandErrorMessage(error)}
        })
    } finally {
        dispatch({type: 'ended', task})
    }
}

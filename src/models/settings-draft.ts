import type {DownloadProgress} from '@mjasnikovs/gofer-rag'
import {commandErrorMessage} from '../utils/command-error'
import {
    activeConnection,
    adoptModelReasoning,
    apiKeyUpdate,
    applyModelSelection,
    normalizeSettings,
    SECRET_NAMES,
    selectAiDriver,
    TYPED_SECRET_NAMES,
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
    ApiKeyUpdate,
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
    /**
     * The settings as the backend last confirmed them, which is a different thing from the draft.
     *
     * What a model catalogue is asked about: a driver at an address. The address of the local
     * driver is a text field, so keying the question on the draft asks a server once per keystroke,
     * and keying it on the driver alone never asks again when the address changes. This is the
     * question the answer is really about, and it moves when the backend says it did.
     */
    savedSettings?: GoferSettings | undefined
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
    | Readonly<{type: 'announced'; settings: GoferSettings}>
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
        qwen: NO_KEY,
        'openai-compatible': NO_KEY,
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

/** Every key box, folded over one at a time. A sixth secret joins these three by arriving. */
function overEveryKey(
    keys: SettingsDraft['keys'],
    change: (draft: KeyDraft, secret: SecretName) => KeyDraft
): SettingsDraft['keys'] {
    const folded = {...keys}
    for (const secret of SECRET_NAMES) folded[secret] = change(keys[secret], secret)
    return folded
}

function withStoredKeys(state: SettingsDraft, response: SettingsResponse): SettingsDraft {
    return {
        ...state,
        keys: overEveryKey(state.keys, (draft, secret) => ({
            ...draft,
            isStored: response.storedSecrets[secret] ?? false
        }))
    }
}

function forgottenKeys(keys: SettingsDraft['keys']): SettingsDraft['keys'] {
    return overEveryKey(keys, draft => ({...draft, typed: '', intent: 'keep'}))
}

function noticedOn(notices: SettingsNotices, tab: SettingsTab, notice?: Notice): SettingsNotices {
    return {...notices, [tab]: notice}
}

/**
 * Whether the page holds an edit of its own, which is what another writer must not overwrite.
 *
 * Derived rather than tracked: `loaded`, `saved` and `announced` set the draft and the confirmed
 * copy from one value, so any action that changes either makes them differ. A typed or cleared key
 * is an edit too, and it lives beside the settings rather than in them.
 */
export function hasUnsavedEdits(state: SettingsDraft): boolean {
    if (state.settings !== state.savedSettings) return true
    return SECRET_NAMES.some(
        secret => state.keys[secret].intent !== 'keep' || state.keys[secret].typed !== ''
    )
}

export function settingsRequest(state: SettingsDraft): SettingsRequest | undefined {
    if (!state.settings) return undefined
    const secrets: Record<string, ApiKeyUpdate> = {}
    for (const secret of TYPED_SECRET_NAMES) {
        const draft = state.keys[secret]
        secrets[secret] = apiKeyUpdate(draft.intent, draft.typed)
    }
    return {settings: state.settings, secrets}
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
        case 'loaded': {
            const loaded = normalizeSettings(action.response.settings)
            return {
                ...withStoredKeys(state, action.response),
                settings: loaded,
                savedSettings: loaded,
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
        }

        /**
         * What another writer of the settings file saved, adopted unless the page holds an edit.
         *
         * The composer reconciles a model in the background and saves it. Without this the page's
         * draft is a snapshot taken at mount, and pressing Save sends the whole object — so the
         * reconcile is silently written back to what the file held when the dialog opened.
         */
        case 'announced': {
            const announced = normalizeSettings(action.settings)
            if (hasUnsavedEdits(state)) return {...state, savedSettings: announced}
            return {...state, settings: announced, savedSettings: announced}
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

        case 'saved': {
            const saved = normalizeSettings(action.response.settings)
            return {
                ...withStoredKeys({...state, keys: forgottenKeys(state.keys)}, action.response),
                settings: saved,
                savedSettings: saved,
                busy: busyWith(state.busy, 'saving', false),
                notices: noticedOn(state.notices, 'ai', savedNotice(action.response))
            }
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

        case 'godot-saved': {
            const saved = normalizeSettings(action.response.settings)
            return {
                ...state,
                settings: saved,
                savedSettings: saved,
                busy: busyWith(state.busy, 'savingGodot', false),
                notices: noticedOn(state.notices, 'godot', {
                    status: 'success',
                    title: 'Godot rules saved',
                    description: 'They are applied the next time a Godot session starts.'
                })
            }
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

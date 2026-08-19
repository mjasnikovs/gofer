import type {DownloadProgress} from '@mjasnikovs/gofer-rag'
import {commandErrorMessage} from '../utils/command-error'
import {
    adoptModelReasoning,
    adoptSubagentReasoning,
    apiKeyUpdate,
    applyModelSelection,
    applySubagentModel,
    normalizeSettings,
    selectAiDriver,
    startSubagentConnection
} from './settings'
import type {
    AgentPrompt,
    AiConnectionType,
    AiModelOption,
    AiSettings,
    ApiKeyIntent,
    CacheStatus,
    GodotSettings,
    GoferSettings,
    Notice,
    SettingsRequest,
    SettingsResponse,
    SubagentConnection,
    ThinkingLevel
} from './settings'

/**
 * The long-running things the settings page can be doing. They are named rather than counted
 * because two of them overlap: a model download and a project backup touch different subsystems
 * and the page lets both buttons spin at once.
 */
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

/**
 * The five tabs the dialog is divided into. Each one owns its own banner, and all but Godot own a
 * footer: Godot's two rules store the moment they are ticked, so it has nothing to put in one.
 */
export type SettingsTab = 'ai' | 'prompt' | 'godot' | 'models' | 'storage'

/**
 * Which tab a task belongs to, so a task's result lands next to the controls that started it
 * rather than above all four. Every task has exactly one home; that is what makes this a map
 * rather than a decision each call site has to make again.
 */
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

/** The banner each tab is showing, if any. Kept per tab because two tasks can run at once. */
export type SettingsNotices = Readonly<Partial<Record<SettingsTab, Notice>>>

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
    hasChatGptCredential: boolean
    /** Whether a Brave key is already in the keyring. Its value is never sent back to the page. */
    hasBraveApiKey: boolean
    /** What the user has typed into the key field this session. Never the stored key. */
    apiKey: string
    apiKeyIntent: ApiKeyIntent
    /** The Brave Search key, held exactly like the AI key: never read back, only written. */
    braveKey: string
    braveKeyIntent: ApiKeyIntent
    /** Which tab is on screen. Here rather than in React so the page stays one value. */
    tab: SettingsTab
    cache?: CacheStatus | undefined
    progress?: DownloadProgress | undefined
    notices: SettingsNotices
    isLoading: boolean
    isDeleteOpen: boolean
    busy: SettingsBusy
    /** Models the server reported on the last successful connection test. */
    availableModels: readonly AiModelOption[]
    /**
     * Models the sub-agent may be given, which is a second list because it can be a second driver.
     * Empty while the child borrows the parent's connection, since there is then nothing to choose.
     */
    subagentModels: readonly AiModelOption[]
    /**
     * The agent's system prompt, as three texts: what is in the box, what the backend last stored,
     * and what Gofer ships. The middle one is what makes a save worth sending and the last one is
     * what Restore puts back, so the page can answer both questions without asking the backend.
     */
    agentPrompt: string
    savedAgentPrompt: string
    defaultAgentPrompt: string
}>

/**
 * The three steps of a task's lifecycle, which only [`runSettingsTask`] may take.
 *
 * They are apart from [`SettingsAction`] because they are not things the page decides — they are
 * one protocol, in a fixed order, and the page used to narrate it eight times. Nothing outside the
 * runner can construct one, because the page's `dispatch` is typed to the other union.
 */
export type SettingsTaskAction =
    | Readonly<{type: 'began'; task: SettingsTask}>
    | Readonly<{type: 'ended'; task: SettingsTask}>
    | Readonly<{type: 'failed'; task: SettingsTask; notice: Notice}>

export type SettingsAction =
    /** The backend answered with settings and a cache reading. */
    | Readonly<{
          type: 'loaded'
          response: SettingsResponse
          cache: CacheStatus
          prompt: AgentPrompt
      }>
    /** Loading finished without settings: no desktop backend, or the call threw. */
    | Readonly<{type: 'unavailable'; notice: Notice}>
    | Readonly<{type: 'tab-chosen'; tab: SettingsTab}>
    | Readonly<{type: 'ai-changed'; update: Partial<AiSettings>}>
    | Readonly<{type: 'ai-driver-chosen'; connectionType: AiSettings['connectionType']}>
    | Readonly<{type: 'model-chosen'; model: AiModelOption}>
    | Readonly<{type: 'model-reconciled'; model: AiModelOption}>
    | Readonly<{type: 'models-listed'; models: readonly AiModelOption[]}>
    /** Which connection answers a delegation. No type at all is "whatever the parent uses". */
    | Readonly<{type: 'subagent-driver-chosen'; connectionType?: AiConnectionType | undefined}>
    | Readonly<{type: 'subagent-model-chosen'; model: AiModelOption}>
    | Readonly<{type: 'subagent-model-reconciled'; model: AiModelOption}>
    | Readonly<{type: 'subagent-thinking-chosen'; thinkingLevel: ThinkingLevel}>
    | Readonly<{type: 'subagent-models-listed'; models: readonly AiModelOption[]}>
    | Readonly<{type: 'api-key-typed'; value: string}>
    | Readonly<{type: 'api-key-removal-toggled'}>
    | Readonly<{type: 'brave-key-typed'; value: string}>
    | Readonly<{type: 'brave-key-removal-toggled'}>
    | Readonly<{type: 'chatgpt-auth-changed'; isAuthenticated: boolean}>
    | Readonly<{type: 'saved'; response: SettingsResponse}>
    | Readonly<{type: 'prompt-typed'; value: string}>
    /** The user asked for the shipped prompt back. It is theirs to save or to type over. */
    | Readonly<{type: 'prompt-restored'}>
    | Readonly<{type: 'prompt-saved'; prompt: AgentPrompt}>
    /** A Godot rule was ticked. The page stores it straight away; this is only the optimism. */
    | Readonly<{type: 'godot-changed'; update: Partial<GodotSettings>}>
    | Readonly<{type: 'godot-saved'; response: SettingsResponse}>
    /** Something finished with a result worth showing, and nothing else about the page changed. */
    | Readonly<{type: 'noticed'; tab: SettingsTab; notice: Notice}>
    | Readonly<{type: 'cache-read'; cache: CacheStatus}>
    /** The download has started, so the cache is in flux before the backend says so. */
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
    hasApiKey: false,
    hasChatGptCredential: false,
    hasBraveApiKey: false,
    apiKey: '',
    apiKeyIntent: 'keep',
    braveKey: '',
    braveKeyIntent: 'keep',
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

/**
 * Writes the sub-agent's connection into the settings, leaving its six ceilings untouched.
 *
 * The connection sits inside the sub-agent section rather than beside it, so every update to it is
 * two levels of spread. Written once here because three actions need the same two.
 */
function withSubagent(
    settings: GoferSettings,
    connection: SubagentConnection | undefined
): GoferSettings {
    return {
        ...settings,
        ai: {...settings.ai, subagent: {...settings.ai.subagent, connection}}
    }
}

/** Puts one tab's banner in place, or takes it away, leaving the other three tabs alone. */
function noticedOn(notices: SettingsNotices, tab: SettingsTab, notice?: Notice): SettingsNotices {
    return {...notices, [tab]: notice}
}

/** What the page sends to the backend, or `undefined` while there is nothing loaded to send. */
export function settingsRequest(state: SettingsDraft): SettingsRequest | undefined {
    if (!state.settings) return undefined
    return {
        settings: state.settings,
        apiKey: apiKeyUpdate(state.apiKeyIntent, state.apiKey),
        braveApiKey: apiKeyUpdate(state.braveKeyIntent, state.braveKey)
    }
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

/** Whether the box holds something the backend has not been told about yet. */
export function agentPromptIsUnsaved(state: SettingsDraft) {
    return state.agentPrompt !== state.savedAgentPrompt
}

/** Whether the box holds the prompt Gofer ships, so there is nothing to restore. */
export function agentPromptIsDefault(state: SettingsDraft) {
    return state.agentPrompt.trim() === state.defaultAgentPrompt.trim()
}

/** Whether the model cache may not be touched: the backend says busy, or this page is downloading. */
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
                ...state,
                settings: normalizeSettings(action.response.settings),
                hasApiKey: action.response.hasApiKey,
                hasChatGptCredential: action.response.hasChatGptCredential ?? false,
                hasBraveApiKey: action.response.hasBraveApiKey ?? false,
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

        // A dialog that could not load at all is a connection problem, and the connection tab is
        // the one it opens on. The other three say their own unavailable line in place.
        case 'unavailable':
            return {...state, isLoading: false, notices: {...state.notices, ai: action.notice}}

        case 'tab-chosen':
            return {...state, tab: action.tab}

        // Starting work clears the last notice on that task's own tab: it described the previous
        // attempt, not this one. A banner on another tab belongs to another task and stays.
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

        case 'model-chosen': {
            if (!state.settings) return state
            return {
                ...state,
                settings: {
                    ...state.settings,
                    ai: applyModelSelection(state.settings.ai, action.model)
                }
            }
        }

        /*
         * The catalogue answering about the model that is already chosen.
         *
         * Only what the model itself decides — see `adoptModelReasoning`. The limits are left as
         * they are, because a context window the user typed is an answer, not a stale copy.
         */
        case 'model-reconciled': {
            if (!state.settings) return state
            const ai = adoptModelReasoning(state.settings.ai, action.model)
            if (ai === state.settings.ai) return state
            return {...state, settings: {...state.settings, ai}}
        }

        case 'models-listed':
            return {...state, availableModels: action.models}

        // The list is emptied with the driver rather than left standing, because it describes the
        // server that was chosen a moment ago. Offering it against the new one would let a model be
        // picked that the new connection has never heard of.
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
                settings: withSubagent(state.settings, applySubagentModel(chosen, action.model))
            }
        }

        case 'subagent-thinking-chosen': {
            const chosen = state.settings?.ai.subagent.connection
            if (!state.settings || !chosen) return state
            return {
                ...state,
                settings: withSubagent(state.settings, {
                    ...chosen,
                    thinkingLevel: action.thinkingLevel
                })
            }
        }

        /** The catalogue answering about the model the sub-agent already has. See the parent's. */
        case 'subagent-model-reconciled': {
            const chosen = state.settings?.ai.subagent.connection
            if (!state.settings || !chosen) return state
            const adopted = adoptSubagentReasoning(chosen, action.model)
            if (adopted === chosen) return state
            return {...state, settings: withSubagent(state.settings, adopted)}
        }

        case 'subagent-models-listed':
            return {...state, subagentModels: action.models}

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

        // The same two rules as the AI key above, and for the same reason: the page never reads a
        // stored secret back, so an empty field cannot mean "remove it".
        case 'brave-key-typed':
            return {
                ...state,
                braveKey: action.value,
                braveKeyIntent: action.value.trim() ? 'set' : 'keep'
            }

        case 'brave-key-removal-toggled':
            return {
                ...state,
                braveKey: '',
                braveKeyIntent: state.braveKeyIntent === 'clear' ? 'keep' : 'clear'
            }

        case 'chatgpt-auth-changed':
            return {...state, hasChatGptCredential: action.isAuthenticated}

        case 'saved':
            return {
                ...state,
                // Normalised like the load above, and for the same reason: what comes back is a
                // settings object, not necessarily one carrying every field this build knows about.
                // Stored raw, a response missing a field left the draft holding `undefined` for it,
                // and the next screen to read it crashed rather than falling back.
                settings: normalizeSettings(action.response.settings),
                hasApiKey: action.response.hasApiKey,
                hasChatGptCredential: action.response.hasChatGptCredential ?? false,
                hasBraveApiKey: action.response.hasBraveApiKey ?? false,
                apiKey: '',
                apiKeyIntent: 'keep',
                busy: busyWith(state.busy, 'saving', false),
                notices: noticedOn(state.notices, 'ai', savedNotice(action.response))
            }

        case 'prompt-typed':
            return {...state, agentPrompt: action.value}

        case 'prompt-restored':
            return {...state, agentPrompt: state.defaultAgentPrompt}

        // The backend answers with the prompt it will send, which is the shipped one whenever the
        // stored text was the shipped one. Taking its word keeps the box and the agent in step.
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

        // Optimistic: the box moves before the backend answers, because a checkbox that waits for a
        // file write reads as broken. The page dispatches this again with the previous value when
        // the write fails, which is what makes the optimism honest rather than a lie.
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

/**
 * Runs one settings task, in the one order the three steps have to happen in.
 *
 * Eight functions on the page used to write this out: dispatch `began`, `await` the work, dispatch
 * `failed` with a title in the `catch`, dispatch `ended` in the `finally`. That order was part of
 * this module's interface and it was stated nowhere but in comments, so the eight copies did not
 * agree — `saved`, `godot-saved` and `failed` each clear `busy` themselves, and then the `finally`
 * cleared it a third time. There was a reducer test called "keeps the failure notice when the
 * finally block also ends the task": a reducer test that has to know about a component's control
 * flow is the constraint escaping the module.
 *
 * `work` is a thunk, so the command name stays at the call site — ADR 0001 is about pass-throughs,
 * and this holds a protocol rather than a second name for a command. Work that has to put
 * something back on the way out catches, reverts, and rethrows: the failure is still the runner's
 * to report, and the order is still the runner's to keep.
 *
 * It never rejects. A caller that had to catch what this already reported would be writing the
 * eighth copy again.
 */
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

import {useEffect, useReducer, useRef, useState} from 'react'
import type {ReactNode} from 'react'
import {AlertDialog} from '@astryxdesign/core/AlertDialog'
import {Banner} from '@astryxdesign/core/Banner'
import {Button} from '@astryxdesign/core/Button'
import {CheckboxInput} from '@astryxdesign/core/CheckboxInput'
import {Divider} from '@astryxdesign/core/Divider'
import {Dialog, DialogHeader} from '@astryxdesign/core/Dialog'
import {DropdownMenu} from '@astryxdesign/core/DropdownMenu'
import {FormLayout} from '@astryxdesign/core/FormLayout'
import {Grid} from '@astryxdesign/core/Grid'
import {Icon} from '@astryxdesign/core/Icon'
import {Layout, LayoutContent, LayoutFooter} from '@astryxdesign/core/Layout'
import {ProgressBar} from '@astryxdesign/core/ProgressBar'
import {Slider} from '@astryxdesign/core/Slider'
import {Selector} from '@astryxdesign/core/Selector'
import {HStack, VStack} from '@astryxdesign/core/Stack'
import {StatusDot} from '@astryxdesign/core/StatusDot'
import {Tab, TabList} from '@astryxdesign/core/TabList'
import {Heading, Text} from '@astryxdesign/core/Text'
import {TextArea} from '@astryxdesign/core/TextArea'
import {TextInput} from '@astryxdesign/core/TextInput'
import ArchiveBoxIcon from '@heroicons/react/24/outline/ArchiveBoxIcon'
import ArrowUturnLeftIcon from '@heroicons/react/24/outline/ArrowUturnLeftIcon'
import ChatBubbleLeftRightIcon from '@heroicons/react/24/outline/ChatBubbleLeftRightIcon'
import CircleStackIcon from '@heroicons/react/24/outline/CircleStackIcon'
import CloudArrowDownIcon from '@heroicons/react/24/outline/CloudArrowDownIcon'
import GlobeAltIcon from '@heroicons/react/24/outline/GlobeAltIcon'
import KeyIcon from '@heroicons/react/24/outline/KeyIcon'
import MagnifyingGlassIcon from '@heroicons/react/24/outline/MagnifyingGlassIcon'
import ServerStackIcon from '@heroicons/react/24/outline/ServerStackIcon'
import ShieldCheckIcon from '@heroicons/react/24/outline/ShieldCheckIcon'
import TrashIcon from '@heroicons/react/24/outline/TrashIcon'
import {invoke, isTauri, listen} from '../../services/desktop'
import {
    cancelChatGptLogin,
    loginChatGpt,
    logoutChatGpt,
    respondChatGptLogin
} from '../../services/chatgpt-auth'
import {commandErrorMessage} from '../../utils/command-error'
import {
    activeConnection,
    thinkingLevelsFor,
    SEARCH_PROVIDERS,
    SEARCH_PROVIDERS_NEEDING_KEY,
    SEARCH_PROVIDER_LABELS,
    SUBAGENT_RANGES,
    cacheStateLabel,
    cacheStateVariant,
    charactersLabel,
    compactionLabel,
    connectionNotice,
    driverOptions,
    formatBytes,
    minutesLabel,
    progressLabel,
    progressValue,
    retriesLabel,
    showsLabel,
    secondsLabel,
    selectAiDriver,
    stepsLabel
} from '../../models/settings'
import type {
    AiConnectionProfile,
    AiModelOption,
    AiSettings,
    GodotSettings,
    ModelChoice,
    SearchProvider,
    SecretName,
    SubagentSettings
} from '../../models/settings'
import {
    INITIAL_SETTINGS_DRAFT,
    agentPromptIsDefault,
    agentPromptIsUnsaved,
    canDeleteCache,
    reduce,
    runSettingsTask,
    settingsRequest
} from '../../models/settings-draft'
import type {KeyDraft, SettingsAction, SettingsTab, SettingsTask} from '../../models/settings-draft'

/** Every settings group breaks to one column at the same width. */
const SETTINGS_GRID_COLUMNS = {minWidth: 320} as const

/**
 * What the sub-agent's connection reads as when it has none of its own.
 *
 * A value the selector can hold, because "no connection" is a real answer here rather than an unset
 * field: the child borrows the parent's model, its connection and its reasoning level, which is what
 * every Gofer before this did and still the right answer for one model on one machine.
 */
const SUBAGENT_INHERITS = 'inherit'

/** The three secrets a person types. ChatGPT is the fourth, and it is a sign-in rather than a box. */
type TypedSecret = Exclude<SecretName, 'chat-gpt'>

/**
 * What one key box says, which is the whole of what ever differed between the three.
 *
 * Everything else — "Stored securely", "Leave blank to keep…", the removal button and when it is
 * shown — was written out once per secret and had to be kept in step by hand.
 */
type StoredKeyCopy = Readonly<{
    label: string
    /**
     * The box's own hint, shown only while nothing is stored. A format example or a statement about
     * the field, never its name: a placeholder that names the field disappears when it is typed in.
     */
    placeholder: string
    /** What to say when there is no stored key to leave alone. */
    description: string
    removeLabel: string
    keepLabel: string
    /** Which of the two hints the label carries, and neither is the third answer: no hint at all. */
    isRequired: boolean
    isOptional: boolean
}>

const STORED_KEY_COPY: Readonly<Record<TypedSecret, StoredKeyCopy>> = {
    'ai-default': {
        label: 'API key',
        placeholder: 'Not required by local servers',
        description: 'Enter a key only if this server requires authentication.',
        removeLabel: 'Remove stored API key',
        keepLabel: 'Keep stored API key',
        isRequired: false,
        isOptional: true
    },
    openrouter: {
        label: 'API key',
        placeholder: 'sk-or-v1-…',
        description: 'Create one at openrouter.ai under Keys.',
        removeLabel: 'Remove stored API key',
        keepLabel: 'Keep stored API key',
        isRequired: true,
        isOptional: false
    },
    brave: {
        label: 'Brave Search API key',
        placeholder: 'From api.search.brave.com',
        description: 'Stored in the operating system credential store, never in the settings file.',
        removeLabel: 'Remove stored Brave key',
        keepLabel: 'Keep stored Brave key',
        isRequired: false,
        isOptional: false
    }
}

type StoredKeyFieldProps = Readonly<{
    secret: TypedSecret
    draft: KeyDraft
    dispatch: (action: SettingsAction) => void
}>

/**
 * One secret's box, and the button that takes the stored one off the machine.
 *
 * The two belong together: the box cannot mean "remove it" — the page never reads a stored secret
 * back, so an emptied box is "leave it alone" — and the button is the only thing that can. This was
 * written out three times, differing in a noun, and the removal button sat a screenful away from
 * the field it was about.
 */
function StoredKeyField({secret, draft, dispatch}: StoredKeyFieldProps) {
    const copy = STORED_KEY_COPY[secret]
    const isRemoving = draft.intent === 'clear'
    return (
        <>
            <TextInput
                label={copy.label}
                type='password'
                value={draft.typed}
                isRequired={copy.isRequired}
                isOptional={copy.isOptional}
                startIcon={KeyIcon}
                placeholder={draft.isStored ? 'Stored securely' : copy.placeholder}
                description={
                    isRemoving ? 'The stored key will be removed when you save.'
                    : draft.isStored ?
                        'Leave blank to keep the key stored in the operating system credential store.'
                    :   copy.description
                }
                onChange={value => {
                    dispatch({type: 'key-typed', secret, value})
                }}
            />
            {(draft.isStored || isRemoving) && (
                <Button
                    label={isRemoving ? copy.keepLabel : copy.removeLabel}
                    variant='ghost'
                    clickAction={() => {
                        dispatch({type: 'key-removal-toggled', secret})
                    }}
                />
            )}
        </>
    )
}

type SettingsPageProps = Readonly<{
    isOpen: boolean
    onOpenChange: (isOpen: boolean) => void
    onCacheDeleted: () => void
}>

export function SettingsPage({isOpen, onOpenChange, onCacheDeleted}: SettingsPageProps) {
    const hasLoaded = useRef(false)
    const modelsFor = useRef<string | undefined>(undefined)
    /** Which connection the sub-agent's model list came from, so it is fetched once per driver. */
    const subagentModelsFor = useRef<string | undefined>(undefined)
    const [state, dispatchAny] = useReducer(reduce, INITIAL_SETTINGS_DRAFT)
    const [isAuthenticating, setIsAuthenticating] = useState(false)
    const [loginMessage, setLoginMessage] = useState<string | undefined>(undefined)
    const [manualCode, setManualCode] = useState('')
    const [needsManualCode, setNeedsManualCode] = useState(false)
    /*
     * Narrowed on purpose. `began`, `ended` and `failed` are one protocol in a fixed order, and
     * this page used to narrate it eight times; typing the page's dispatch to the other union is
     * what makes writing a ninth copy a compile error rather than a habit.
     */
    const dispatch: (action: SettingsAction) => void = dispatchAny
    /** Runs one task, and owns its began / failed / ended. See `runSettingsTask`. */
    const run = (task: SettingsTask, title: string, work: () => Promise<void>) =>
        runSettingsTask(dispatchAny, task, title, work)
    const {availableModels, busy, cache, keys, notices, progress, tab} = state
    const draft = state.settings
    /** The connection the live driver runs on, which is what the AI tab's fields are about. */
    const connection = draft && activeConnection(draft.ai)
    // The key field appears only for the engine that needs one, so a keyless setup is never shown a
    // credential box it has no use for.
    const needsSearchKey = SEARCH_PROVIDERS_NEEDING_KEY.includes(
        draft?.ai.web.searchProvider ?? 'exa'
    )
    const subagentConnection = draft?.ai.subagent.connection

    /*
     * The driver's own catalogue, asked for once per driver.
     *
     * Both drivers, not only ChatGPT. The local one used to list nothing until the user pressed
     * Test connection, which meant the page opened with no model picker and a reasoning menu drawn
     * from whatever the file happened to say — including a `false` written before any catalogue had
     * been read. Keyed on the driver rather than the address, because the address is a field the
     * user is still typing.
     */
    useEffect(() => {
        if (!draft) return
        if (modelsFor.current === draft.ai.connectionType) return
        modelsFor.current = draft.ai.connectionType
        const request = settingsRequest(state)
        if (!request) return
        const isChatGpt = draft.ai.connectionType === 'openai-codex'
        void invoke('list_ai_models', {request})
            .then(models => {
                dispatch({type: 'models-listed', models})
                const configured = models.find(
                    model => model.id === activeConnection(draft.ai)?.model.id
                )
                // A model the server serves has its facts re-read, so the reasoning menu offers what
                // this model can actually be asked. A model it does not serve is replaced only on
                // ChatGPT, whose catalogue is the whole truth; a local Model ID is typed by hand and
                // is not the page's to overwrite while a server is between models.
                if (configured) dispatch({type: 'model-reconciled', model: configured})
                else if (isChatGpt && models[0]) dispatch({type: 'model-chosen', model: models[0]})
            })
            .catch((error: unknown) => {
                modelsFor.current = undefined
                // A local server that is simply not running is not a settings failure, and saying so
                // on every open would put a red banner in front of anyone who opens the page first.
                if (!isChatGpt) return
                dispatch({
                    type: 'noticed',
                    tab: 'ai',
                    notice: {
                        status: 'error',
                        title: 'ChatGPT models could not be loaded',
                        description: commandErrorMessage(error)
                    }
                })
            })
    }, [draft?.ai.connectionType])

    /*
     * The sub-agent's own list, asked for from the connection it names rather than the one the page
     * is showing. `selectAiDriver` is what turns the settings into that connection — the same
     * function the driver control above uses — so the backend resolves the address and the
     * credential exactly as it would if the user had switched to it.
     */
    useEffect(() => {
        if (!draft || !subagentConnection) return
        if (subagentModelsFor.current === subagentConnection.connectionType) return
        subagentModelsFor.current = subagentConnection.connectionType
        const request = settingsRequest(state)
        if (!request) return
        const ai = selectAiDriver(draft.ai, subagentConnection.connectionType)
        void invoke('list_ai_models', {request: {...request, settings: {...draft, ai}}})
            .then(models => {
                dispatch({type: 'subagent-models-listed', models})
                // The same re-read the parent gets: what the chosen model can actually be asked.
                const chosen = models.find(model => model.id === subagentConnection.model.id)
                if (chosen) dispatch({type: 'subagent-model-reconciled', model: chosen})
            })
            .catch((error: unknown) => {
                subagentModelsFor.current = undefined
                dispatch({
                    type: 'noticed',
                    tab: 'ai',
                    notice: {
                        status: 'error',
                        title: "The sub-agent's models could not be loaded",
                        description: commandErrorMessage(error)
                    }
                })
            })
    }, [subagentConnection?.connectionType])

    const refreshCache = async () => {
        dispatch({type: 'cache-read', cache: await invoke('get_rag_cache_status')})
    }

    useEffect(() => {
        if (hasLoaded.current) return
        hasLoaded.current = true

        const load = async () => {
            if (!isTauri()) {
                dispatch({
                    type: 'unavailable',
                    notice: {
                        status: 'warning',
                        title: 'Desktop app required',
                        description:
                            'Local settings and model management are available in the Tauri desktop app.'
                    }
                })
                return
            }

            try {
                const [response, cacheResponse, prompt] = await Promise.all([
                    invoke('load_settings'),
                    invoke('get_rag_cache_status'),
                    invoke('read_agent_prompt')
                ])
                dispatch({type: 'loaded', response, cache: cacheResponse, prompt})
            } catch (error) {
                dispatch({
                    type: 'unavailable',
                    notice: {
                        status: 'error',
                        title: 'Settings could not be loaded',
                        description: commandErrorMessage(error)
                    }
                })
            }
        }

        void load()
    }, [])

    const updateAi = (update: Partial<AiSettings>) => {
        dispatch({type: 'ai-changed', update})
    }

    const updateConnection = (update: Partial<AiConnectionProfile>) => {
        dispatch({type: 'connection-changed', update})
    }

    const updateModel = (update: Partial<ModelChoice>) => {
        dispatch({type: 'model-changed', update})
    }

    const updateSubagent = (update: Partial<SubagentSettings>) => {
        if (!draft) return
        dispatch({type: 'ai-changed', update: {subagent: {...draft.ai.subagent, ...update}}})
    }

    const testConnection = async () => {
        const nextRequest = settingsRequest(state)
        if (!nextRequest) return
        await run('testing', 'Connection test failed', async () => {
            const result = await invoke('test_ai_connection', {request: nextRequest})
            dispatch({type: 'noticed', tab: 'ai', notice: connectionNotice(result)})
            if (result.status === 'connected' || result.status === 'model-unavailable') {
                const models = await invoke('list_ai_models', {request: nextRequest})
                dispatch({type: 'models-listed', models})
            }
        })
    }

    /*
     * The connection fields and the sub-agent ceilings are one stored object and one backend call,
     * which is why they share a tab. Splitting them across two tabs would have given the second one
     * a Save that silently wrote the first one's edits.
     */
    const saveAiSettings = async () => {
        const nextRequest = settingsRequest(state)
        if (!nextRequest) return
        await run('saving', 'Settings could not be saved', async () => {
            dispatch({
                type: 'saved',
                response: await invoke('save_settings', {request: nextRequest})
            })
        })
    }

    /** The prompt has a store of its own — it belongs to the project rather than to the connection. */
    const saveAgentPrompt = () =>
        run('savingPrompt', 'Agent prompt could not be saved', async () => {
            dispatch({
                type: 'prompt-saved',
                prompt: await invoke('save_agent_prompt', {prompt: state.agentPrompt})
            })
        })

    /**
     * Stores one Godot rule, on its own, the moment it is ticked.
     *
     * The tick is applied first so the box moves at once, and put back if the write fails — a
     * checkbox left showing a state the file does not hold is worse than one that snaps back. The
     * backend re-reads the file and replaces only this section, so a connection half-typed on
     * another tab is not stored as a side effect of ticking a box here.
     */
    const saveGodotSettings = async (update: Partial<GodotSettings>) => {
        const previous = draft?.godot
        if (!previous) return
        dispatch({type: 'godot-changed', update})
        await run('savingGodot', 'Godot rules could not be saved', async () => {
            try {
                const response = await invoke('save_godot_settings', {
                    godot: {...previous, ...update}
                })
                dispatch({type: 'godot-saved', response})
            } catch (error) {
                // The tick goes back before the failure is reported, so the box never sits showing
                // a state the file does not hold. Rethrown: the runner still owns the banner.
                dispatch({type: 'godot-changed', update: previous})
                throw error
            }
        })
    }

    const downloadModels = () =>
        run('downloading', 'Models could not be installed', async () => {
            dispatch({type: 'cache-downloading'})
            let unlisten: (() => void) | undefined
            try {
                unlisten = await listen('rag-download-progress', event => {
                    dispatch({type: 'progress', progress: event.payload})
                })
                await invoke('initialize_rag')
                await refreshCache()
                dispatch({
                    type: 'noticed',
                    tab: 'models',
                    notice: {
                        status: 'success',
                        title: 'Documentation models installed',
                        description: 'Gofer can now search the local Godot 4.7 documentation.'
                    }
                })
            } catch (error) {
                // Read back either way: a download that failed part-way still moved the cache, and
                // the page must show what is on disk rather than what was hoped for.
                await refreshCache()
                throw error
            } finally {
                unlisten?.()
            }
        })

    const deleteCache = () =>
        run('deleting', 'Model cache could not be deleted', async () => {
            dispatch({type: 'cache-read', cache: await invoke('delete_rag_cache')})
            dispatch({type: 'delete-dialog', isOpen: false})
            onCacheDeleted()
        })

    const createBackup = () =>
        run('backingUp', 'Backup failed', async () => {
            const result = await invoke('create_project_backup')
            dispatch({
                type: 'noticed',
                tab: 'storage',
                notice: {
                    status: 'success',
                    title: 'Project backup created',
                    description: result.path
                }
            })
        })

    const cleanStorage = () =>
        run('cleaningStorage', 'Storage cleanup failed', async () => {
            const result = await invoke('run_storage_maintenance')
            dispatch({
                type: 'noticed',
                tab: 'storage',
                notice: {
                    status: 'success',
                    title: 'Storage maintenance complete',
                    description: `${String(result.attachmentsRemoved)} attachments, ${String(result.blobsRemoved)} blobs, ${String(result.godotRunsRemoved)} old Godot runs, ${String(result.sketchesRemoved)} sketches, ${String(result.docsAnswersRemoved)} stale manual answers, ${String(result.memoryVectorsRemoved)} orphaned memory vectors, and ${String(result.backupsRemoved)} old backups removed. ${String(result.memoryEmbeddingsRestored)} memory embeddings restored.`
                }
            })
        })

    const value = progressValue(progress)
    const isDeletable = canDeleteCache(state)
    const isShippedPrompt = agentPromptIsDefault(state)
    const isPromptUnsaved = agentPromptIsUnsaved(state)
    const selectModel = (model: AiModelOption) => {
        dispatch({type: 'model-chosen', model})
    }

    const startChatGptLogin = async (method: 'browser' | 'device_code') => {
        setIsAuthenticating(true)
        setNeedsManualCode(false)
        setManualCode('')
        setLoginMessage('Starting ChatGPT sign-in…')
        try {
            await loginChatGpt(method, {
                onEvent: event => {
                    if (event.type === 'info') setLoginMessage(event.message)
                    if (event.type === 'auth_url') setLoginMessage(event.instructions)
                    if (event.type === 'device_code')
                        setLoginMessage(`Enter code ${event.userCode} in the opened browser.`)
                    if (event.type === 'progress') setLoginMessage(event.message)
                    if (event.type === 'manual-code-request') {
                        setNeedsManualCode(true)
                        setLoginMessage(
                            'If the browser does not return to Gofer, paste its final redirect URL.'
                        )
                    }
                    if (event.type === 'failed') setLoginMessage(event.message)
                }
            })
            dispatch({type: 'chatgpt-auth-changed', isAuthenticated: true})
            setNeedsManualCode(false)
            setLoginMessage('Signed in with ChatGPT.')
            dispatch({
                type: 'noticed',
                tab: 'ai',
                notice: {
                    status: 'success',
                    title: 'ChatGPT connected',
                    description: 'Your subscription can now drive Gofer.'
                }
            })
        } catch (error) {
            dispatch({
                type: 'noticed',
                tab: 'ai',
                notice: {
                    status: 'error',
                    title: 'ChatGPT sign-in failed',
                    description: commandErrorMessage(error)
                }
            })
        } finally {
            setIsAuthenticating(false)
        }
    }

    const signOutChatGpt = async () => {
        try {
            await logoutChatGpt()
            dispatch({type: 'chatgpt-auth-changed', isAuthenticated: false})
            setLoginMessage(undefined)
            dispatch({
                type: 'noticed',
                tab: 'ai',
                notice: {
                    status: 'success',
                    title: 'Signed out of ChatGPT',
                    description: 'The local model configuration is unchanged.'
                }
            })
        } catch (error) {
            dispatch({
                type: 'noticed',
                tab: 'ai',
                notice: {
                    status: 'error',
                    title: 'ChatGPT sign-out failed',
                    description: commandErrorMessage(error)
                }
            })
        }
    }

    /*
     * One banner slot per tab, so a failure sits above the controls it is about. A download that
     * failed on the models tab does not push the connection form down, and neither one hides the
     * other: both tabs can be carrying a banner at once, because both tasks can run at once.
     */
    const banner = (owner: SettingsTab) => {
        const notice = notices[owner]
        if (!notice) return null
        return (
            <Banner
                status={notice.status}
                title={notice.title}
                description={notice.description}
                isDismissable={notice.status !== 'error'}
                onDismiss={() => {
                    dispatch({type: 'notice-dismissed', tab: owner})
                }}
            />
        )
    }

    const aiTab = (
        <VStack gap={8}>
            {banner('ai')}

            <Grid
                columns={SETTINGS_GRID_COLUMNS}
                gap={10}
            >
                <VStack gap={2}>
                    <HStack
                        gap={2}
                        vAlign='center'
                    >
                        <Icon
                            icon={ServerStackIcon}
                            size='md'
                            color='accent'
                        />
                        <Heading level={2}>AI connection</Heading>
                    </HStack>
                    <Text color='secondary'>
                        Choose one active driver. Local and ChatGPT model selections are preserved
                        independently; changes take effect after saving.
                    </Text>
                </VStack>

                {draft && connection ?
                    <VStack gap={5}>
                        <FormLayout>
                            <Selector
                                label='AI driver'
                                value={draft.ai.connectionType}
                                description='Your own server, a ChatGPT subscription, or OpenRouter. Only a driver that has somewhere to run is offered.'
                                options={driverOptions(draft.ai)}
                                onChange={connectionType => {
                                    modelsFor.current = undefined
                                    dispatch({
                                        type: 'ai-driver-chosen',
                                        connectionType:
                                            connectionType as AiSettings['connectionType']
                                    })
                                }}
                            />
                            {draft.ai.connectionType === 'openai-compatible' ?
                                <>
                                    <TextInput
                                        label='Connection name'
                                        value={connection.name}
                                        isRequired
                                        onChange={name => {
                                            updateConnection({name})
                                        }}
                                    />
                                    <TextInput
                                        label='Base URL'
                                        value={connection.baseUrl}
                                        isRequired
                                        description='Absolute HTTP or HTTPS URL including the API prefix.'
                                        onChange={baseUrl => {
                                            updateConnection({baseUrl})
                                        }}
                                    />
                                    <TextInput
                                        label='Model ID'
                                        value={connection.model.id}
                                        isRequired
                                        description='Must exactly match an ID returned by the server models endpoint.'
                                        onChange={id => {
                                            updateModel({id})
                                        }}
                                    />
                                    {availableModels.length > 0 && (
                                        <Selector
                                            label='Available server models'
                                            value={connection.model.id}
                                            options={availableModels.map(model => ({
                                                value: model.id,
                                                label: model.name
                                            }))}
                                            onChange={modelId => {
                                                const model = availableModels.find(
                                                    option => option.id === modelId
                                                )
                                                if (model) selectModel(model)
                                            }}
                                        />
                                    )}
                                    <TextInput
                                        label='Context window'
                                        value={String(connection.model.contextWindow)}
                                        isRequired
                                        description='Maximum context tokens advertised by the selected model.'
                                        onChange={contextWindow => {
                                            updateModel({contextWindow: Number(contextWindow)})
                                        }}
                                    />
                                    <TextInput
                                        label='Maximum output tokens'
                                        value={String(connection.model.maxTokens)}
                                        isRequired
                                        onChange={maxTokens => {
                                            updateModel({maxTokens: Number(maxTokens)})
                                        }}
                                    />
                                </>
                            : draft.ai.connectionType === 'openrouter' ?
                                <>
                                    <StoredKeyField
                                        secret='openrouter'
                                        draft={keys.openrouter}
                                        dispatch={dispatch}
                                    />
                                    <Selector
                                        label='Model'
                                        value={connection.model.id}
                                        hasSearch
                                        searchPlaceholder='Filter by name or id'
                                        isDisabled={availableModels.length === 0}
                                        disabledMessage='OpenRouter has not answered with its catalogue yet.'
                                        description='Only models that can call tools are listed. The rest cannot run Gofer.'
                                        options={availableModels.map(model => ({
                                            value: model.id,
                                            label: model.name
                                        }))}
                                        onChange={modelId => {
                                            const model = availableModels.find(
                                                option => option.id === modelId
                                            )
                                            if (model) selectModel(model)
                                        }}
                                    />
                                    <TextInput
                                        label='Context window'
                                        value={connection.model.contextWindow.toLocaleString()}
                                        isDisabled
                                        disabledMessage="OpenRouter's catalogue answers this, so there is nothing to type."
                                        onChange={() => undefined}
                                    />
                                    <TextInput
                                        label='Maximum output tokens'
                                        value={connection.model.maxTokens.toLocaleString()}
                                        isDisabled
                                        disabledMessage="OpenRouter's catalogue answers this, so there is nothing to type."
                                        onChange={() => undefined}
                                    />
                                    <TextInput
                                        label='Accepts'
                                        value={connection.model.input.join(', ')}
                                        isDisabled
                                        disabledMessage='What this model takes as input, as OpenRouter describes it.'
                                        onChange={() => undefined}
                                    />
                                </>
                            :   <>
                                    <HStack
                                        gap={2}
                                        vAlign='center'
                                    >
                                        <StatusDot
                                            variant={
                                                keys['chat-gpt'].isStored ? 'success' : 'neutral'
                                            }
                                            label={
                                                keys['chat-gpt'].isStored ?
                                                    'Signed in'
                                                :   'Signed out'
                                            }
                                        />
                                        <Text>
                                            {keys['chat-gpt'].isStored ?
                                                'Signed in with ChatGPT'
                                            :   'Not signed in'}
                                        </Text>
                                    </HStack>
                                    <HStack gap={2}>
                                        {keys['chat-gpt'].isStored ?
                                            <Button
                                                label='Sign out of ChatGPT'
                                                variant='secondary'
                                                isDisabled={isAuthenticating}
                                                clickAction={signOutChatGpt}
                                            />
                                        :   <>
                                                <Button
                                                    label='Sign in with ChatGPT'
                                                    variant='secondary'
                                                    isLoading={isAuthenticating}
                                                    clickAction={() => startChatGptLogin('browser')}
                                                />
                                                <Button
                                                    label='Use device code'
                                                    variant='ghost'
                                                    isDisabled={isAuthenticating}
                                                    clickAction={() =>
                                                        startChatGptLogin('device_code')
                                                    }
                                                />
                                            </>
                                        }
                                    </HStack>
                                    {loginMessage && <Text color='secondary'>{loginMessage}</Text>}
                                    {needsManualCode && (
                                        <HStack
                                            gap={2}
                                            vAlign='end'
                                        >
                                            <TextInput
                                                label='Redirect URL or authorization code'
                                                value={manualCode}
                                                description='Use this only when the browser could not return to Gofer automatically.'
                                                onChange={setManualCode}
                                            />
                                            <Button
                                                label='Complete sign-in'
                                                variant='secondary'
                                                isDisabled={!manualCode.trim()}
                                                clickAction={async () => {
                                                    await respondChatGptLogin(manualCode)
                                                    setNeedsManualCode(false)
                                                }}
                                            />
                                        </HStack>
                                    )}
                                    <Selector
                                        label='ChatGPT model'
                                        value={connection.model.id}
                                        isDisabled={availableModels.length === 0}
                                        disabledMessage='The Pi model catalogue is still loading.'
                                        options={availableModels.map(model => ({
                                            value: model.id,
                                            label: model.name
                                        }))}
                                        onChange={modelId => {
                                            const model = availableModels.find(
                                                option => option.id === modelId
                                            )
                                            if (model) selectModel(model)
                                        }}
                                    />
                                </>
                            }
                            <Slider
                                label='Compact conversations at'
                                value={draft.ai.compactionPercent}
                                min={50}
                                max={100}
                                step={1}
                                valueDisplay='text'
                                marks={[
                                    {value: 50, label: '50%'},
                                    {value: 75, label: '75%'},
                                    {value: 100, label: 'Off'}
                                ]}
                                formatValue={compactionLabel(connection.model.contextWindow)}
                                description='Older messages are summarised once a conversation fills this much of the window. 100 keeps every message and lets long conversations run out of room.'
                                onChange={(compactionPercent: number) => {
                                    updateAi({compactionPercent})
                                }}
                            />
                            <TextInput
                                label='Request timeout (milliseconds)'
                                value={String(draft.ai.timeoutMs)}
                                isRequired
                                description='Provider requests are cancelled after this interval.'
                                onChange={timeoutMs => {
                                    updateAi({timeoutMs: Number(timeoutMs)})
                                }}
                            />
                            <TextInput
                                label='Automatic retries'
                                value={String(draft.ai.maxRetries)}
                                isRequired
                                description='Transient provider failures are retried up to ten times.'
                                onChange={maxRetries => {
                                    updateAi({maxRetries: Number(maxRetries)})
                                }}
                            />
                            <DropdownMenu
                                button={{
                                    label: `Reasoning: ${connection.model.thinkingLevel}`,
                                    variant: 'secondary'
                                }}
                                items={thinkingLevelsFor(connection.model).map(level => ({
                                    label: level,
                                    onClick: () => {
                                        updateModel({thinkingLevel: level})
                                    }
                                }))}
                            />
                            {draft.ai.connectionType === 'openai-compatible' && (
                                <TextInput
                                    label='API dialect'
                                    value='OpenAI chat completions'
                                    isDisabled
                                    disabledMessage='The local driver uses OpenAI chat completions.'
                                />
                            )}
                            {draft.ai.connectionType === 'openai-compatible' && (
                                <StoredKeyField
                                    secret='ai-default'
                                    draft={keys['ai-default']}
                                    dispatch={dispatch}
                                />
                            )}
                        </FormLayout>
                    </VStack>
                :   <Text color='secondary'>
                        {state.isLoading ? 'Loading Gofer settings…' : 'Settings are unavailable.'}
                    </Text>
                }
            </Grid>

            {/*
             * Hidden outright when there is nothing to show, rather than repeating the "settings
             * are unavailable" line the section above already says. Two copies of one message
             * reads as two problems.
             */}
            {draft && <Divider />}

            {draft && (
                <Grid
                    columns={SETTINGS_GRID_COLUMNS}
                    gap={10}
                >
                    <VStack gap={2}>
                        <HStack
                            gap={2}
                            vAlign='center'
                        >
                            <Icon
                                icon={MagnifyingGlassIcon}
                                size='md'
                                color='accent'
                            />
                            <Heading level={2}>Sub-agent</Heading>
                        </HStack>
                        <Text color='secondary'>
                            The agent delegates reading to a second, read-only agent and keeps only
                            its answer. Give it a model of its own and the reading is done cheaply
                            while the main agent keeps the large model for planning. The ceilings
                            below stop one from running away; they suit the machine, not the
                            project, so a slower computer wants larger ones.
                        </Text>
                    </VStack>

                    <VStack gap={5}>
                        <FormLayout>
                            <Selector
                                label='Sub-agent model'
                                value={subagentConnection?.connectionType ?? SUBAGENT_INHERITS}
                                description='Give the sub-agent a smaller model and the main agent keeps the large one for planning. A driver with no saved connection is not offered.'
                                options={[
                                    {
                                        value: SUBAGENT_INHERITS,
                                        label: 'Same as the main agent'
                                    },
                                    ...driverOptions(draft.ai)
                                ]}
                                onChange={connectionType => {
                                    subagentModelsFor.current = undefined
                                    dispatch({
                                        type: 'subagent-driver-chosen',
                                        connectionType:
                                            connectionType === SUBAGENT_INHERITS ? undefined : (
                                                (connectionType as AiSettings['connectionType'])
                                            )
                                    })
                                }}
                            />
                            {subagentConnection && (
                                <>
                                    <Selector
                                        label='Model the sub-agent answers with'
                                        value={subagentConnection.model.id}
                                        isDisabled={state.subagentModels.length === 0}
                                        disabledMessage='That connection has not answered with a model list yet.'
                                        options={state.subagentModels.map(model => ({
                                            value: model.id,
                                            label: model.name
                                        }))}
                                        onChange={modelId => {
                                            const model = state.subagentModels.find(
                                                option => option.id === modelId
                                            )
                                            if (model)
                                                dispatch({type: 'subagent-model-chosen', model})
                                        }}
                                    />
                                    <DropdownMenu
                                        button={{
                                            label: `Sub-agent reasoning: ${subagentConnection.model.thinkingLevel}`,
                                            variant: 'secondary'
                                        }}
                                        items={thinkingLevelsFor(subagentConnection.model).map(
                                            thinkingLevel => ({
                                                label: thinkingLevel,
                                                onClick: () => {
                                                    dispatch({
                                                        type: 'subagent-thinking-chosen',
                                                        thinkingLevel
                                                    })
                                                }
                                            })
                                        )}
                                    />
                                </>
                            )}
                            <Slider
                                label='Tool call timeout'
                                value={draft.ai.subagent.commandTimeoutMinutes}
                                {...SUBAGENT_RANGES.commandTimeoutMinutes}
                                valueDisplay='text'
                                formatValue={minutesLabel}
                                marks={[
                                    {value: 0, label: 'Off'},
                                    {value: 15, label: '15m'},
                                    {value: 30, label: '30m'}
                                ]}
                                description='One shell command or file read is cut off after this. A command the model did not bound otherwise runs until the machine is restarted.'
                                onChange={(commandTimeoutMinutes: number) => {
                                    updateSubagent({commandTimeoutMinutes})
                                }}
                            />
                            <Slider
                                label='Give up on a silent model after'
                                value={draft.ai.subagent.streamInactivityMinutes}
                                {...SUBAGENT_RANGES.streamInactivityMinutes}
                                valueDisplay='text'
                                formatValue={minutesLabel}
                                marks={[
                                    {value: 0, label: 'Off'},
                                    {value: 15, label: '15m'},
                                    {value: 30, label: '30m'}
                                ]}
                                description='Time spent running a tool does not count. A local model reading a long prompt is legitimately silent for minutes, so keep this above the slowest answer you see.'
                                onChange={(streamInactivityMinutes: number) => {
                                    updateSubagent({streamInactivityMinutes})
                                }}
                            />
                            <Slider
                                label='Maximum steps'
                                value={draft.ai.subagent.maxTurns}
                                {...SUBAGENT_RANGES.maxTurns}
                                valueDisplay='text'
                                formatValue={stepsLabel}
                                marks={[
                                    {value: 0, label: 'Off'},
                                    {value: 20, label: '20'},
                                    {value: 40, label: '40'}
                                ]}
                                description='Requests one sub-agent may make to the model. The clocks above bound a sub-agent that has stopped; this bounds one that is busy and getting nowhere.'
                                onChange={(maxTurns: number) => {
                                    updateSubagent({maxTurns})
                                }}
                            />
                            <Slider
                                label='Maximum answer'
                                value={draft.ai.subagent.maxAnswerChars}
                                {...SUBAGENT_RANGES.maxAnswerChars}
                                valueDisplay='text'
                                formatValue={charactersLabel}
                                marks={[
                                    {value: 0, label: 'Off'},
                                    {value: 12_000, label: '12K'},
                                    {value: 24_000, label: '24K'}
                                ]}
                                description='A longer answer is cut. What the sub-agent read is meant to stay with it, so an answer near this size means the question was too broad.'
                                onChange={(maxAnswerChars: number) => {
                                    updateSubagent({maxAnswerChars})
                                }}
                            />
                            <Slider
                                label='Times it may interrupt you'
                                value={draft.ai.subagent.maxShows}
                                {...SUBAGENT_RANGES.maxShows}
                                valueDisplay='text'
                                formatValue={showsLabel}
                                marks={[
                                    {value: 0, label: 'Off'},
                                    {value: 6, label: '6'},
                                    {value: 12, label: '12'}
                                ]}
                                description='How often one sub-agent may stop you to show you a layout and wait. The only ceiling here measured in your attention rather than the machine, and the only one nothing else can see being spent.'
                                onChange={(maxShows: number) => {
                                    updateSubagent({maxShows})
                                }}
                            />
                            <Slider
                                label='Retry attempts'
                                value={draft.ai.subagent.retryAttempts}
                                {...SUBAGENT_RANGES.retryAttempts}
                                valueDisplay='text'
                                formatValue={retriesLabel}
                                marks={[
                                    {value: 0, label: 'Off'},
                                    {value: 5, label: '5'}
                                ]}
                                description='A delegation that failed transiently is asked again this many times. One local server with one slot can refuse a connection the next request would have got.'
                                onChange={(retryAttempts: number) => {
                                    updateSubagent({retryAttempts})
                                }}
                            />
                            <Slider
                                label='First retry wait'
                                value={draft.ai.subagent.retryBaseDelaySeconds}
                                {...SUBAGENT_RANGES.retryBaseDelaySeconds}
                                valueDisplay='text'
                                formatValue={secondsLabel}
                                marks={[
                                    {value: 1, label: '1s'},
                                    {value: 10, label: '10s'}
                                ]}
                                isDisabled={draft.ai.subagent.retryAttempts === 0}
                                disabledMessage='There are no retries to wait before.'
                                description='Each further attempt waits twice as long as the one before it.'
                                onChange={(retryBaseDelaySeconds: number) => {
                                    updateSubagent({retryBaseDelaySeconds})
                                }}
                            />
                        </FormLayout>
                    </VStack>
                </Grid>
            )}

            {draft && (
                <Grid
                    columns={SETTINGS_GRID_COLUMNS}
                    gap={10}
                >
                    <VStack gap={2}>
                        <HStack
                            gap={2}
                            vAlign='center'
                        >
                            <Icon
                                icon={GlobeAltIcon}
                                size='md'
                                color='accent'
                            />
                            <Heading level={2}>Web search</Heading>
                        </HStack>
                        <Text color='secondary'>
                            Which engine the agent searches with, and the key for the one that needs
                            it. A page the agent finds is read by the same isolated reader the
                            sub-agent uses, so the page itself never enters the conversation.
                        </Text>
                        <Text color='secondary'>
                            The engine chosen here is the only one asked. A search that fails is
                            reported as having failed, never answered quietly by a different engine.
                        </Text>
                    </VStack>
                    <VStack gap={4}>
                        <FormLayout>
                            <Selector
                                label='Search engine'
                                value={draft.ai.web.searchProvider}
                                options={SEARCH_PROVIDERS.map(provider => ({
                                    value: provider,
                                    label: SEARCH_PROVIDER_LABELS[provider]
                                }))}
                                description={
                                    needsSearchKey ?
                                        'Brave needs an API key. Exa and DuckDuckGo need none.'
                                    :   'Needs no key. Brave is steadier under load, and needs one.'
                                }
                                onChange={(searchProvider: string) => {
                                    dispatch({
                                        type: 'ai-changed',
                                        update: {
                                            web: {
                                                ...draft.ai.web,
                                                searchProvider: searchProvider as SearchProvider
                                            }
                                        }
                                    })
                                }}
                            />
                            {needsSearchKey && (
                                <StoredKeyField
                                    secret='brave'
                                    draft={keys.brave}
                                    dispatch={dispatch}
                                />
                            )}
                        </FormLayout>
                    </VStack>
                </Grid>
            )}
        </VStack>
    )

    const promptTab = (
        <VStack gap={8}>
            {banner('prompt')}

            <Grid
                columns={SETTINGS_GRID_COLUMNS}
                gap={10}
            >
                <VStack gap={2}>
                    <HStack
                        gap={2}
                        vAlign='center'
                    >
                        <Icon
                            icon={ChatBubbleLeftRightIcon}
                            size='md'
                            color='accent'
                        />
                        <Heading level={2}>Agent prompt</Heading>
                    </HStack>
                    <Text color='secondary'>
                        What the agent is told before every turn, sent exactly as it reads here. It
                        belongs to this project, so another project keeps its own.
                    </Text>
                </VStack>

                {draft ?
                    <TextArea
                        label='System prompt'
                        value={state.agentPrompt}
                        rows={18}
                        hasSpellCheck={false}
                        description={
                            isShippedPrompt ?
                                'This is the prompt Gofer ships. Editing it stores your version with the project.'
                            :   'Edited for this project. Restoring the default lets later Gofer versions update it again.'
                        }
                        onChange={typed => {
                            dispatch({type: 'prompt-typed', value: typed})
                        }}
                    />
                :   <Text color='secondary'>
                        {state.isLoading ?
                            'Loading the agent prompt…'
                        :   'The agent prompt is unavailable.'}
                    </Text>
                }
            </Grid>
        </VStack>
    )

    const godotTab = (
        <VStack gap={8}>
            {banner('godot')}

            <Grid
                columns={SETTINGS_GRID_COLUMNS}
                gap={10}
            >
                <VStack gap={2}>
                    <HStack
                        gap={2}
                        vAlign='center'
                    >
                        <Icon
                            icon={ShieldCheckIcon}
                            size='md'
                            color='accent'
                        />
                        <Heading level={2}>Godot rules</Heading>
                    </HStack>
                    <Text color='secondary'>
                        What Gofer holds the editor to. Both are written when a Godot session
                        starts, because Godot reads where a game window goes once and never looks
                        again. A change here reaches the editor the next time one is started.
                    </Text>
                </VStack>

                {draft ?
                    <FormLayout>
                        <CheckboxInput
                            label='Enforce strict typing'
                            value={draft.godot.strictTyping}
                            isLoading={busy.savingGodot}
                            description='Untyped variables and Variant-based access become parse errors, not warnings. Godot leaves res://addons alone.'
                            onChange={strictTyping => {
                                void saveGodotSettings({strictTyping})
                            }}
                        />
                        <CheckboxInput
                            label='Enforce game window inline'
                            value={draft.godot.embedGameWindow}
                            isLoading={busy.savingGodot}
                            description='The running game is drawn inside the editor and cannot be torn out into a window of its own.'
                            onChange={embedGameWindow => {
                                void saveGodotSettings({embedGameWindow})
                            }}
                        />
                    </FormLayout>
                :   <Text color='secondary'>
                        {state.isLoading ?
                            'Loading the Godot rules…'
                        :   'The Godot rules are unavailable.'}
                    </Text>
                }
            </Grid>
        </VStack>
    )

    const modelsTab = (
        <VStack gap={8}>
            {banner('models')}

            <Grid
                columns={SETTINGS_GRID_COLUMNS}
                gap={10}
            >
                <VStack gap={2}>
                    <HStack
                        gap={2}
                        vAlign='center'
                    >
                        <Icon
                            icon={CircleStackIcon}
                            size='md'
                            color='accent'
                        />
                        <Heading level={2}>Godot documentation models</Heading>
                    </HStack>
                    <Text color='secondary'>
                        Local embedding and reranking models used to search the Godot 4.7
                        documentation.
                    </Text>
                </VStack>

                {cache ?
                    <VStack gap={5}>
                        <VStack gap={3}>
                            <HStack
                                gap={2}
                                vAlign='center'
                            >
                                <StatusDot
                                    variant={cacheStateVariant(cache.state)}
                                    label={cacheStateLabel(cache.state)}
                                />
                                <Text>{cacheStateLabel(cache.state)}</Text>
                            </HStack>
                            <VStack gap={1}>
                                <Text type='supporting'>Cache location</Text>
                                <Text color='secondary'>{cache.path}</Text>
                            </VStack>
                            <VStack gap={1}>
                                <Text type='supporting'>Disk usage</Text>
                                <Text color='secondary'>{formatBytes(cache.sizeBytes)}</Text>
                            </VStack>
                        </VStack>

                        {busy.downloading && (
                            <VStack gap={2}>
                                <ProgressBar
                                    label={progressLabel(progress)}
                                    value={value ?? 0}
                                    isIndeterminate={value === undefined}
                                    hasValueLabel={value !== undefined}
                                />
                                <Text
                                    type='supporting'
                                    color='secondary'
                                >
                                    {progressLabel(progress)}
                                </Text>
                            </VStack>
                        )}
                    </VStack>
                :   <Text color='secondary'>
                        {state.isLoading ?
                            'Inspecting the model cache…'
                        :   'Cache status is unavailable.'}
                    </Text>
                }
            </Grid>
        </VStack>
    )

    const storageTab = (
        <VStack gap={8}>
            {banner('storage')}

            {/*
             * No Grid here, unlike the other three: both of this tab's controls live in its
             * footer, so there is no right-hand column for a two-column layout to hold.
             */}
            <VStack gap={2}>
                <HStack
                    gap={2}
                    vAlign='center'
                >
                    <Icon
                        icon={ArchiveBoxIcon}
                        size='md'
                        color='accent'
                    />
                    <Heading level={2}>Project storage</Heading>
                </HStack>
                <Text color='secondary'>
                    Back up the active project database, attachments, and Godot logs. Cleanup
                    retains five backups and thirty days of completed run logs.
                </Text>
            </VStack>
        </VStack>
    )

    /*
     * One footer per tab, holding only what that tab can do. The pinned position is what the old
     * single footer was for — the connection form is taller than the dialog at 1280x800, so an
     * action row that scrolled with its section put Save below the fold with nothing on screen to
     * say there was more. Keeping a footer per tab also keeps Save honest: it now writes what is
     * on screen and nothing else.
     */
    const footers: Readonly<Record<SettingsTab, ReactNode>> = {
        ai:
            draft ?
                <LayoutFooter
                    hasDivider
                    label='AI connection actions'
                >
                    <HStack
                        gap={3}
                        hAlign='end'
                    >
                        <Button
                            label='Test connection'
                            variant='secondary'
                            isLoading={busy.testing}
                            isDisabled={busy.saving}
                            clickAction={testConnection}
                        />
                        <Button
                            label='Save AI settings'
                            variant='primary'
                            isLoading={busy.saving}
                            isDisabled={busy.testing}
                            clickAction={saveAiSettings}
                        />
                    </HStack>
                </LayoutFooter>
            :   undefined,
        prompt:
            draft ?
                <LayoutFooter
                    hasDivider
                    label='Agent prompt actions'
                >
                    <HStack
                        gap={3}
                        hAlign='end'
                    >
                        <Button
                            label='Restore default'
                            variant='secondary'
                            icon={
                                <Icon
                                    icon={ArrowUturnLeftIcon}
                                    size='sm'
                                />
                            }
                            isDisabled={isShippedPrompt}
                            clickAction={() => {
                                dispatch({type: 'prompt-restored'})
                            }}
                        />
                        <Button
                            label='Save prompt'
                            variant='primary'
                            isLoading={busy.savingPrompt}
                            isDisabled={!isPromptUnsaved}
                            clickAction={saveAgentPrompt}
                        />
                    </HStack>
                </LayoutFooter>
            :   undefined,
        // No footer at all: a rule stores the moment it is ticked, so there is nothing left for a
        // Save to do. A Save here would also have had to write the other tabs' drafts with it.
        godot: undefined,
        models:
            cache ?
                <LayoutFooter
                    hasDivider
                    label='Documentation model actions'
                >
                    <HStack
                        gap={3}
                        hAlign='end'
                    >
                        <Button
                            label='Delete model cache'
                            variant='destructive'
                            icon={
                                <Icon
                                    icon={TrashIcon}
                                    size='sm'
                                />
                            }
                            isDisabled={!isDeletable}
                            clickAction={() => {
                                dispatch({
                                    type: 'delete-dialog',
                                    isOpen: true
                                })
                            }}
                        />
                        {cache.state !== 'installed' && (
                            <Button
                                label='Download models'
                                variant='primary'
                                icon={
                                    <Icon
                                        icon={CloudArrowDownIcon}
                                        size='sm'
                                    />
                                }
                                isLoading={busy.downloading}
                                /*
                                 * Started rather than awaited. `Button` runs `clickAction` inside
                                 * `startTransition`, and React holds the old screen for as long as
                                 * a transition is pending — so awaiting a 1.68 GiB download here
                                 * meant the progress bar and the Busy badge this sets did not
                                 * appear until the download was already over. Returning at once
                                 * ends the transition and lets the rest paint as it happens; the
                                 * button still spins, on `busy.downloading` above.
                                 */
                                clickAction={() => {
                                    void downloadModels()
                                }}
                            />
                        )}
                    </HStack>
                </LayoutFooter>
            :   undefined,
        storage: (
            <LayoutFooter
                hasDivider
                label='Project storage actions'
            >
                <HStack
                    gap={3}
                    hAlign='end'
                >
                    <Button
                        label='Clean storage'
                        variant='secondary'
                        isLoading={busy.cleaningStorage}
                        isDisabled={busy.backingUp}
                        clickAction={cleanStorage}
                    />
                    {/*
                     * Primary here, where it was secondary before: this tab no longer shares a
                     * footer with Save, so there is only one blue on the screen and it names what
                     * the tab is for.
                     */}
                    <Button
                        label='Back up project'
                        variant='primary'
                        isLoading={busy.backingUp}
                        isDisabled={busy.cleaningStorage}
                        clickAction={createBackup}
                    />
                </HStack>
            </LayoutFooter>
        )
    }

    const bodies: Readonly<Record<SettingsTab, ReactNode>> = {
        ai: aiTab,
        prompt: promptTab,
        godot: godotTab,
        models: modelsTab,
        storage: storageTab
    }

    return (
        <>
            <Dialog
                isOpen={isOpen && !state.isDeleteOpen}
                onOpenChange={nextOpen => {
                    if (!nextOpen && isAuthenticating) void cancelChatGptLogin()
                    onOpenChange(nextOpen)
                }}
                purpose='form'
                width={960}
                maxHeight='90vh'
            >
                <Layout
                    height='fill'
                    header={
                        <VStack gap={0}>
                            <DialogHeader
                                title='Settings'
                                subtitle='Configuration is owned by Gofer and stored only on this device.'
                                hasDivider={false}
                                onOpenChange={onOpenChange}
                            />
                            <VStack
                                gap={0}
                                paddingInline={6}
                            >
                                <TabList
                                    hasDivider
                                    aria-label='Settings sections'
                                    value={tab}
                                    onChange={chosen => {
                                        dispatch({
                                            type: 'tab-chosen',
                                            tab: chosen as SettingsTab
                                        })
                                    }}
                                >
                                    <Tab
                                        value='ai'
                                        label='AI connection'
                                    />
                                    <Tab
                                        value='prompt'
                                        label='Agent prompt'
                                    />
                                    <Tab
                                        value='godot'
                                        label='Godot rules'
                                    />
                                    <Tab
                                        value='models'
                                        label='Documentation models'
                                    />
                                    <Tab
                                        value='storage'
                                        label='Project storage'
                                    />
                                </TabList>
                            </VStack>
                        </VStack>
                    }
                    /*
                     * A floor under the body, because the tabs are wildly different heights: the
                     * connection form overflows a 1280x800 window while project storage is two
                     * lines. Without it the dialog collapsed from 780px to 280px on a tab click,
                     * and the footer buttons jumped most of the way up the screen. 520 is what
                     * fills the shortest window this dialog is designed for once its header and
                     * footer are taken out, so the taller tabs still scroll rather than stretch.
                     */
                    content={
                        <LayoutContent padding={6}>
                            <VStack
                                gap={0}
                                minHeight={520}
                            >
                                {bodies[tab]}
                            </VStack>
                        </LayoutContent>
                    }
                    footer={footers[tab]}
                />
            </Dialog>
            <AlertDialog
                isOpen={state.isDeleteOpen}
                onOpenChange={isDeleteOpen => {
                    dispatch({type: 'delete-dialog', isOpen: isDeleteOpen})
                }}
                title='Delete documentation model cache?'
                description='This removes only the downloaded embedding and reranking models. Gofer will return to the preparation screen and download approximately 1.68 GiB again.'
                actionLabel='Delete model cache'
                isActionLoading={busy.deleting}
                onAction={deleteCache}
            />
        </>
    )
}

export default SettingsPage

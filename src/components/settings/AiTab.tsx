import {useEffect, useEffectEvent, useRef, useState} from 'react'
import {Button} from '@astryxdesign/core/Button'
import {Divider} from '@astryxdesign/core/Divider'
import {FormLayout} from '@astryxdesign/core/FormLayout'
import {Grid} from '@astryxdesign/core/Grid'
import {Icon} from '@astryxdesign/core/Icon'
import {LayoutFooter} from '@astryxdesign/core/Layout'
import {Selector} from '@astryxdesign/core/Selector'
import {Slider} from '@astryxdesign/core/Slider'
import {HStack, VStack} from '@astryxdesign/core/Stack'
import {StatusDot} from '@astryxdesign/core/StatusDot'
import {Heading, Text} from '@astryxdesign/core/Text'
import {TextInput} from '@astryxdesign/core/TextInput'
import GlobeAltIcon from '@heroicons/react/24/outline/GlobeAltIcon'
import MagnifyingGlassIcon from '@heroicons/react/24/outline/MagnifyingGlassIcon'
import ServerStackIcon from '@heroicons/react/24/outline/ServerStackIcon'
import {invoke} from '../../services/desktop'
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
    charactersLabel,
    compactionLabel,
    connectionNotice,
    driverOptions,
    minutesLabel,
    retriesLabel,
    secondsLabel,
    selectAiDriver,
    stepsLabel
} from '../../models/settings'
import type {
    AiConnectionProfile,
    AiConnectionType,
    AiModelOption,
    AiSettings,
    ModelChoice,
    SearchProvider,
    SubagentSettings
} from '../../models/settings'
import {settingsRequest} from '../../models/settings-draft'
import {StoredKeyField} from './StoredKeyField'
import type {TypedSecret} from './StoredKeyField'
import {SETTINGS_GRID_COLUMNS, settingsBanner} from './settings-view'
import type {SettingsTabView, SettingsView} from './settings-view'

/**
 * What the sub-agent's connection reads as when it has none of its own.
 *
 * A value the selector can hold, because "no connection" is a real answer here rather than an unset
 * field: the child borrows the parent's model, its connection and its reasoning level, which is what
 * every Gofer before this did and still the right answer for one model on one machine.
 */
const SUBAGENT_INHERITS = 'inherit'

/**
 * The drivers whose whole configuration is a key and a model chosen off a catalogue.
 *
 * One row rather than one branch each. The two of them differ in five sentences and nothing else,
 * and a fourth driver written as a fourth arm of a ternary chain is four copies of eight fields
 * that can drift apart in any of them. A driver is added here once.
 *
 * The local driver is not one of these — its address, its window and its ceiling are all typed —
 * and neither is ChatGPT, which is a sign-in rather than a key.
 */
const HOSTED_DRIVERS: Partial<
    Record<
        AiConnectionType,
        Readonly<{
            secret: TypedSecret
            awaiting: string
            listed: string
            answered: string
            ceiling: string
            accepts: string
        }>
    >
> = {
    openrouter: {
        secret: 'openrouter',
        awaiting: 'OpenRouter has not answered with its catalogue yet.',
        listed: 'Only models that can call tools are listed. The rest cannot run Gofer.',
        answered: "OpenRouter's catalogue answers this, so there is nothing to type.",
        ceiling: "OpenRouter's catalogue answers this, so there is nothing to type.",
        accepts: 'What this model takes as input, as OpenRouter describes it.'
    },
    cerebras: {
        secret: 'cerebras',
        awaiting: 'Cerebras has not answered with its model list yet.',
        // The narrowing said out loud. Cerebras answers ids and nothing else, so what a model can
        // do is a table Gofer ships — and a user who sees a model on the Cerebras dashboard and not
        // here is owed the sentence rather than left to guess the list is broken.
        listed: 'Only models Gofer holds measured capabilities for are listed, because Cerebras publishes none.',
        answered: 'Measured against the live endpoint, so there is nothing to type.',
        // Not the same sentence as the window's. Cerebras declares no output ceiling at all — a
        // request may name the whole window and is answered — so this number is Gofer's, not theirs.
        ceiling: 'Output shares the context window here, so this is the room Gofer leaves for it.',
        accepts: 'What this model takes as input, measured against the live endpoint.'
    }
}

/** The AI tab, plus the sign-in it may have left half-finished when the dialog is closed. */
type AiTabView = SettingsTabView & Readonly<{cancelPendingLogin: () => void}>

/**
 * Where the model comes from: the driver, its address, the model it serves, and the sub-agent's own.
 *
 * The connection fields and the sub-agent ceilings are one stored object and one backend call, which
 * is why they share a tab. Splitting them across two tabs would have given the second one a Save
 * that silently wrote the first one's edits.
 */
export function useAiTab(view: SettingsView): AiTabView {
    const {state, dispatch, run} = view
    const {availableModels, busy, keys} = state
    const draft = state.settings
    /** The connection the live driver runs on, which is what this tab's fields are about. */
    const connection = draft && activeConnection(draft.ai)
    /** The prose this driver's key-and-catalogue fields carry, or nothing when it has none. */
    const hosted = draft && HOSTED_DRIVERS[draft.ai.connectionType]
    // The key field appears only for the engine that needs one, so a keyless setup is never shown a
    // credential box it has no use for.
    const needsSearchKey = SEARCH_PROVIDERS_NEEDING_KEY.includes(
        draft?.ai.web.searchProvider ?? 'exa'
    )
    const subagentConnection = draft?.ai.subagent.connection
    /*
     * The two drivers, named on their own, because they are the whole of what may send a catalogue
     * request. Pulled out of the draft here so the effects below can list what they really watch
     * instead of reaching through an object they must not re-run for.
     */
    const driver = draft?.ai.connectionType
    const subagentDriver = subagentConnection?.connectionType

    const modelsFor = useRef<string | undefined>(undefined)
    /** Which connection the sub-agent's model list came from, so it is fetched once per driver. */
    const subagentModelsFor = useRef<string | undefined>(undefined)
    /*
     * Which request is the newest, for each of the two lists.
     *
     * A monotonic count rather than the driver's name. Naming the driver cannot tell two requests
     * for the *same* driver apart, and that pair is reachable: a local server that hangs on connect,
     * then a switch away and back, issues a second request while the first is still open. The first
     * one's failure would pass a name-keyed guard, clear the "already asked" ref, and make the
     * second one's success look stale — leaving an empty model picker that nothing re-fills.
     */
    const modelsRequest = useRef(0)
    const subagentModelsRequest = useRef(0)

    const [isAuthenticating, setIsAuthenticating] = useState(false)
    const [loginMessage, setLoginMessage] = useState<string | undefined>(undefined)
    const [manualCode, setManualCode] = useState('')
    const [needsManualCode, setNeedsManualCode] = useState(false)

    /*
     * The driver's own catalogue, asked for once per driver.
     *
     * Both drivers, not only ChatGPT. The local one used to list nothing until the user pressed
     * Test connection, which meant the page opened with no model picker and a reasoning menu drawn
     * from whatever the file happened to say — including a `false` written before any catalogue had
     * been read. Keyed on the driver rather than the address, because the address is a field the
     * user is still typing.
     *
     * An effect event, because the two halves of this pull in opposite directions: the request is
     * built from the whole draft, and only a change of driver may send one. As a plain effect the
     * draft, the state and the dispatch were closed over and left off the list. Here they are read
     * when the event fires, which is the same instant, and the list below is the truth.
     */
    const loadModels = useEffectEvent((asked: AiConnectionType) => {
        if (!draft) return
        if (modelsFor.current === asked) return
        // Which request this is. Switching driver while one is in flight used to let the late answer
        // dispatch anyway — writing one driver's catalogue, and on ChatGPT its first model, into
        // whichever connection is live by the time it lands.
        const asking = modelsRequest.current + 1
        modelsRequest.current = asking
        modelsFor.current = asked
        const request = settingsRequest(state)
        if (!request) return
        const isChatGpt = asked === 'openai-codex'
        void invoke('list_ai_models', {request})
            .then(models => {
                if (modelsRequest.current !== asking) return
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
                if (modelsRequest.current !== asking) return
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
    })

    useEffect(() => {
        if (!driver) return
        loadModels(driver)
    }, [driver])

    /*
     * The sub-agent's own list, asked for from the connection it names rather than the one the page
     * is showing. `selectAiDriver` is what turns the settings into that connection — the same
     * function the driver control above uses — so the backend resolves the address and the
     * credential exactly as it would if the user had switched to it.
     *
     * An effect event for the same reason as the one above.
     */
    const loadSubagentModels = useEffectEvent((asked: AiConnectionType) => {
        if (!draft || !subagentConnection) return
        if (subagentModelsFor.current === asked) return
        // Same guard as the parent's: two switches in quick succession left the sub-agent showing
        // the other connection's catalogue.
        const asking = subagentModelsRequest.current + 1
        subagentModelsRequest.current = asking
        subagentModelsFor.current = asked
        const request = settingsRequest(state)
        if (!request) return
        const ai = selectAiDriver(draft.ai, asked)
        void invoke('list_ai_models', {request: {...request, settings: {...draft, ai}}})
            .then(models => {
                if (subagentModelsRequest.current !== asking) return
                dispatch({type: 'subagent-models-listed', models})
                // The same re-read the parent gets: what the chosen model can actually be asked.
                const chosen = models.find(model => model.id === subagentConnection.model.id)
                if (chosen) dispatch({type: 'subagent-model-reconciled', model: chosen})
            })
            .catch((error: unknown) => {
                if (subagentModelsRequest.current !== asking) return
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
    })

    useEffect(() => {
        if (!subagentDriver) return
        loadSubagentModels(subagentDriver)
    }, [subagentDriver])

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

    return {
        body: (
            <VStack gap={8}>
                {settingsBanner(view, 'ai')}

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
                            Choose one active driver. Each driver's model selection is preserved
                            independently; changes take effect after saving.
                        </Text>
                    </VStack>

                    {draft && connection ?
                        <VStack gap={5}>
                            <FormLayout>
                                <Selector
                                    label='AI driver'
                                    value={draft.ai.connectionType}
                                    description='Your own server or a hosted provider. Only a driver that has somewhere to run is offered.'
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
                                : hosted ?
                                    <>
                                        <StoredKeyField
                                            secret={hosted.secret}
                                            draft={keys[hosted.secret]}
                                            dispatch={dispatch}
                                        />
                                        <Selector
                                            label='Model'
                                            value={connection.model.id}
                                            hasSearch
                                            searchPlaceholder='Filter by name or id'
                                            isDisabled={availableModels.length === 0}
                                            disabledMessage={hosted.awaiting}
                                            description={hosted.listed}
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
                                        {/*
                                         * Read-only, not disabled. These three are true values the
                                         * catalogue answered; disabling dims a real value and puts
                                         * its explanation behind a tooltip, so a fact the user came
                                         * to read looked like a broken field.
                                         */}
                                        <TextInput
                                            label='Context window'
                                            value={connection.model.contextWindow.toLocaleString()}
                                            isReadOnly
                                            description={hosted.answered}
                                        />
                                        <TextInput
                                            label='Maximum output tokens'
                                            value={connection.model.maxTokens.toLocaleString()}
                                            isReadOnly
                                            description={hosted.ceiling}
                                        />
                                        <TextInput
                                            label='Accepts'
                                            value={connection.model.input.join(', ')}
                                            isReadOnly
                                            description={hosted.accepts}
                                        />
                                    </>
                                :   <>
                                        <HStack
                                            gap={2}
                                            vAlign='center'
                                        >
                                            <StatusDot
                                                variant={
                                                    keys['chat-gpt'].isStored ?
                                                        'success'
                                                    :   'neutral'
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
                                                        clickAction={() =>
                                                            startChatGptLogin('browser')
                                                        }
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
                                        {loginMessage && (
                                            <Text color='secondary'>{loginMessage}</Text>
                                        )}
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
                                {/*
                                 * A field, not a menu. The level is one of a fixed set, and drawn as
                                 * a dropdown it was the only control in this form with no label and
                                 * no description — its value readable only inside the button's own
                                 * text.
                                 */}
                                <Selector
                                    label='Reasoning'
                                    value={connection.model.thinkingLevel}
                                    description='How much the model is asked to think before it answers. Only the levels this model accepts are offered.'
                                    options={thinkingLevelsFor(connection.model).map(level => ({
                                        value: level,
                                        label: level
                                    }))}
                                    onChange={chosen => {
                                        // Selector answers with a plain string; the level is a union.
                                        // Found in the list rather than cast, so a value the model
                                        // does not accept can never reach the request.
                                        const thinkingLevel = thinkingLevelsFor(
                                            connection.model
                                        ).find(level => level === chosen)
                                        if (thinkingLevel) updateModel({thinkingLevel})
                                    }}
                                />
                                {draft.ai.connectionType === 'openai-compatible' && (
                                    <TextInput
                                        label='API dialect'
                                        value='OpenAI chat completions'
                                        isReadOnly
                                        description='The local driver uses OpenAI chat completions.'
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
                            {state.isLoading ?
                                'Loading Gofer settings…'
                            :   'Settings are unavailable.'}
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
                                The agent delegates reading to a second, read-only agent and keeps
                                only its answer. Give it a model of its own and the reading is done
                                cheaply while the main agent keeps the large model for planning. The
                                ceilings below stop one from running away; they suit the machine,
                                not the project, so a slower computer wants larger ones.
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
                                        <Selector
                                            label='Sub-agent reasoning'
                                            value={subagentConnection.model.thinkingLevel}
                                            description='The level the child is asked to think at, which need not match the parent.'
                                            options={thinkingLevelsFor(
                                                subagentConnection.model
                                            ).map(level => ({value: level, label: level}))}
                                            onChange={chosen => {
                                                const thinkingLevel = thinkingLevelsFor(
                                                    subagentConnection.model
                                                ).find(level => level === chosen)
                                                if (thinkingLevel)
                                                    dispatch({
                                                        type: 'subagent-thinking-chosen',
                                                        thinkingLevel
                                                    })
                                            }}
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
                                Which engine the agent searches with, and the key for the one that
                                needs it. A page the agent finds is read by the same isolated reader
                                the sub-agent uses, so the page itself never enters the
                                conversation.
                            </Text>
                            <Text color='secondary'>
                                The engine chosen here is the only one asked. A search that fails is
                                reported as having failed, never answered quietly by a different
                                engine.
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
        ),
        footer:
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
        /**
         * A sign-in the user walked away from.
         *
         * Closing the dialog mid-flow leaves a browser tab and a listening callback behind, and the
         * page is the only thing that knows the dialog closed. It is returned rather than kept here
         * because nothing inside this tab ever learns that it stopped being drawn.
         */
        cancelPendingLogin: () => {
            if (isAuthenticating) void cancelChatGptLogin()
        }
    }
}

import {Button} from '@astryxdesign/core/Button'
import {CheckboxInput} from '@astryxdesign/core/CheckboxInput'
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
    activeConnection,
    thinkingLevelsFor,
    TYPED_DRIVER_SECRETS,
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
import {useChatGptLogin} from './use-chatgpt-login'
import {useModelCatalogue} from './use-model-catalogue'
import {SETTINGS_GRID_COLUMNS, settingsBanner} from './settings-view'
import type {SettingsTabView, SettingsView} from './settings-view'

const SUBAGENT_INHERITS = 'inherit'

/** What a hosted driver's own catalogue answers, in the words its page says it in. */
type HostedDriverCopy = Readonly<{
    awaiting: string
    listed: string
    answered: string
    ceiling: string
    accepts: string
}>

const HOSTED_DRIVERS: Partial<Record<AiConnectionType, HostedDriverCopy>> = {
    openrouter: {
        awaiting: 'OpenRouter has not answered with its catalogue yet.',
        listed: 'Only models that can call tools are listed. The rest cannot run Gofer.',
        answered: "OpenRouter's catalogue answers this, so there is nothing to type.",
        ceiling: "OpenRouter's catalogue answers this, so there is nothing to type.",
        accepts: 'What this model takes as input, as OpenRouter describes it.'
    },
    qwen: {
        awaiting: 'Qwen has not answered with its model list yet.',
        listed: 'Only the models Gofer has measured are listed. The rest of what this host serves draws pictures or speaks, and cannot call a tool.',
        answered: 'Measured against the live endpoint, so there is nothing to type.',
        ceiling: 'The largest single answer this model will give, as its own endpoint states it.',
        accepts: 'What this model takes as input, measured against the live endpoint.'
    },
    cerebras: {
        awaiting: 'Cerebras has not answered with its model list yet.',
        listed: 'Only models Gofer holds measured capabilities for are listed, because Cerebras publishes none.',
        answered: 'Measured against the live endpoint, so there is nothing to type.',
        ceiling: 'Output shares the context window here, so this is the room Gofer leaves for it.',
        accepts: 'What this model takes as input, measured against the live endpoint.'
    }
}

/** The drivers whose address the user types, which are the two the dialect readout is about. */
function typesItsOwnAddress(driver: AiConnectionType): boolean {
    return driver === 'local' || driver === 'openai-compatible'
}

type AiTabView = SettingsTabView & Readonly<{cancelPendingLogin: () => void}>

export function useAiTab(view: SettingsView): AiTabView {
    const {state, dispatch, run} = view
    const {availableModels, busy, keys} = state
    const draft = state.settings
    const connection = draft && activeConnection(draft.ai)
    const hosted = draft && HOSTED_DRIVERS[draft.ai.connectionType]
    // Which key box a hosted driver shows is the pairing, and the pairing is one generated row.
    // Absent for a driver that signs in, which is the same absence `hosted` already turns on.
    const hostedSecret = draft && TYPED_DRIVER_SECRETS[draft.ai.connectionType]
    const needsSearchKey = SEARCH_PROVIDERS_NEEDING_KEY.includes(
        draft?.ai.web.searchProvider ?? 'exa'
    )
    const subagentConnection = draft?.ai.subagent.connection

    useModelCatalogue(view, 'main')
    useModelCatalogue(view, 'subagent')
    const login = useChatGptLogin(view)

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
                                        dispatch({
                                            type: 'ai-driver-chosen',
                                            connectionType:
                                                connectionType as AiSettings['connectionType']
                                        })
                                    }}
                                />
                                {draft.ai.connectionType === 'local' ?
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
                                : draft.ai.connectionType === 'openai-compatible' ?
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
                                            description='Absolute HTTP or HTTPS URL including the API prefix, such as /v1.'
                                            onChange={baseUrl => {
                                                updateConnection({baseUrl})
                                            }}
                                        />
                                        {hostedSecret && (
                                            <StoredKeyField
                                                secret={hostedSecret}
                                                draft={keys[hostedSecret]}
                                                dispatch={dispatch}
                                            />
                                        )}
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
                                                label='Models this host lists'
                                                value={connection.model.id}
                                                hasSearch
                                                searchPlaceholder='Filter by id'
                                                description='Every id the host returns, including ones that cannot run a chat turn. It publishes no capabilities, so the fields below are yours to set.'
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
                                            description='This host answers no capabilities. Take this from its documentation.'
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
                                        <CheckboxInput
                                            label='This model reasons'
                                            value={connection.model.reasoning}
                                            description='Unlocks the reasoning menu below. Leave it off and the model is never asked to think.'
                                            onChange={reasoning => {
                                                updateModel({reasoning})
                                            }}
                                        />
                                        <CheckboxInput
                                            label='It accepts a named effort'
                                            value={connection.model.supportsReasoningEffort}
                                            isDisabled={!connection.model.reasoning}
                                            disabledMessage='Only a model that reasons can be asked how hard.'
                                            description='Turns the reasoning menu from on and off into named levels.'
                                            onChange={supportsReasoningEffort => {
                                                updateModel({supportsReasoningEffort})
                                            }}
                                        />
                                        <TextInput
                                            label='Its word for no thinking'
                                            value={connection.model.offEffort ?? ''}
                                            isOptional
                                            placeholder='none'
                                            description='Sent as the effort when the reasoning menu says off. Some hosts think anyway unless one is named.'
                                            onChange={offEffort => {
                                                updateModel({
                                                    offEffort: offEffort.trim() || undefined
                                                })
                                            }}
                                        />
                                        <CheckboxInput
                                            label='Thinking is switched by the chat template'
                                            value={connection.chatTemplateThinking}
                                            description='Sends enable_thinking through chat_template_kwargs rather than as a top-level effort. Some hosts have no other off switch.'
                                            onChange={chatTemplateThinking => {
                                                updateConnection({chatTemplateThinking})
                                            }}
                                        />
                                        <CheckboxInput
                                            label='It reads images'
                                            value={connection.model.input.includes('image')}
                                            description='Turns the composer image control on. A host that refuses pictures answers the whole turn with an error.'
                                            onChange={reads => {
                                                updateModel({
                                                    input: reads ? ['text', 'image'] : ['text']
                                                })
                                            }}
                                        />
                                    </>
                                : hosted ?
                                    <>
                                        {hostedSecret && (
                                            <StoredKeyField
                                                secret={hostedSecret}
                                                draft={keys[hostedSecret]}
                                                dispatch={dispatch}
                                            />
                                        )}
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
                                                    isDisabled={login.isAuthenticating}
                                                    clickAction={login.signOut}
                                                />
                                            :   <>
                                                    <Button
                                                        label='Sign in with ChatGPT'
                                                        variant='secondary'
                                                        isLoading={login.isAuthenticating}
                                                        clickAction={() => login.signIn('browser')}
                                                    />
                                                    <Button
                                                        label='Use device code'
                                                        variant='ghost'
                                                        isDisabled={login.isAuthenticating}
                                                        clickAction={() =>
                                                            login.signIn('device_code')
                                                        }
                                                    />
                                                </>
                                            }
                                        </HStack>
                                        {login.message && (
                                            <Text color='secondary'>{login.message}</Text>
                                        )}
                                        {login.needsManualCode && (
                                            <HStack
                                                gap={2}
                                                vAlign='end'
                                            >
                                                <TextInput
                                                    label='Redirect URL or authorization code'
                                                    value={login.manualCode}
                                                    description='Use this only when the browser could not return to Gofer automatically.'
                                                    onChange={login.typeManualCode}
                                                />
                                                <Button
                                                    label='Complete sign-in'
                                                    variant='secondary'
                                                    isDisabled={!login.manualCode.trim()}
                                                    clickAction={login.submitManualCode}
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
                                <Selector
                                    label='Reasoning'
                                    value={connection.model.thinkingLevel}
                                    description='How much the model is asked to think before it answers. Only the levels this model accepts are offered.'
                                    options={thinkingLevelsFor(connection.model).map(level => ({
                                        value: level,
                                        label: level
                                    }))}
                                    onChange={chosen => {
                                        const thinkingLevel = thinkingLevelsFor(
                                            connection.model
                                        ).find(level => level === chosen)
                                        if (thinkingLevel) updateModel({thinkingLevel})
                                    }}
                                />
                                {typesItsOwnAddress(draft.ai.connectionType) && (
                                    <TextInput
                                        label='API dialect'
                                        value='OpenAI chat completions'
                                        isReadOnly
                                        description='This driver speaks OpenAI chat completions.'
                                    />
                                )}
                                {draft.ai.connectionType === 'local' && (
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
        cancelPendingLogin: login.cancel
    }
}

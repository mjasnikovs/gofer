import {useEffect, useReducer, useRef} from 'react'
import {AlertDialog} from '@astryxdesign/core/AlertDialog'
import {Banner} from '@astryxdesign/core/Banner'
import {Button} from '@astryxdesign/core/Button'
import {Divider} from '@astryxdesign/core/Divider'
import {Dialog, DialogHeader} from '@astryxdesign/core/Dialog'
import {DropdownMenu} from '@astryxdesign/core/DropdownMenu'
import {FormLayout} from '@astryxdesign/core/FormLayout'
import {Grid} from '@astryxdesign/core/Grid'
import {Icon} from '@astryxdesign/core/Icon'
import {Layout, LayoutContent, LayoutFooter} from '@astryxdesign/core/Layout'
import {ProgressBar} from '@astryxdesign/core/ProgressBar'
import {Slider} from '@astryxdesign/core/Slider'
import {HStack, VStack} from '@astryxdesign/core/Stack'
import {StatusDot} from '@astryxdesign/core/StatusDot'
import {Heading, Text} from '@astryxdesign/core/Text'
import {TextArea} from '@astryxdesign/core/TextArea'
import {TextInput} from '@astryxdesign/core/TextInput'
import ArrowUturnLeftIcon from '@heroicons/react/24/outline/ArrowUturnLeftIcon'
import ChatBubbleLeftRightIcon from '@heroicons/react/24/outline/ChatBubbleLeftRightIcon'
import CircleStackIcon from '@heroicons/react/24/outline/CircleStackIcon'
import CloudArrowDownIcon from '@heroicons/react/24/outline/CloudArrowDownIcon'
import KeyIcon from '@heroicons/react/24/outline/KeyIcon'
import ServerStackIcon from '@heroicons/react/24/outline/ServerStackIcon'
import TrashIcon from '@heroicons/react/24/outline/TrashIcon'
import {isTauri, listen} from '../../services/desktop'
import {
    createProjectBackup,
    deleteRagCache,
    initializeRag,
    listAiModels,
    loadSettings,
    readAgentPrompt,
    readCacheStatus,
    runStorageMaintenance,
    saveAgentPrompt,
    saveSettings,
    testAiConnection
} from '../../services/settings-store'
import {commandErrorMessage} from '../../utils/command-error'
import {
    ALL_THINKING_LEVELS,
    NO_THINKING_LEVELS,
    cacheStateLabel,
    cacheStateVariant,
    compactionLabel,
    connectionNotice,
    formatBytes,
    progressLabel,
    progressValue
} from '../../models/settings'
import type {AiModelOption, AiSettings} from '../../models/settings'
import {
    INITIAL_SETTINGS_DRAFT,
    agentPromptIsDefault,
    agentPromptIsUnsaved,
    canDeleteCache,
    reduce,
    settingsRequest
} from '../../models/settings-draft'

/** Every settings group breaks to one column at the same width. */
const SETTINGS_GRID_COLUMNS = {minWidth: 320} as const

type SettingsPageProps = Readonly<{
    isOpen: boolean
    onOpenChange: (isOpen: boolean) => void
    onCacheDeleted: () => void
}>

export function SettingsPage({isOpen, onOpenChange, onCacheDeleted}: SettingsPageProps) {
    const hasLoaded = useRef(false)
    const [state, dispatch] = useReducer(reduce, INITIAL_SETTINGS_DRAFT)
    const {apiKey, apiKeyIntent, availableModels, busy, cache, notice, progress} = state
    const draft = state.settings

    const refreshCache = async () => {
        dispatch({type: 'cache-read', cache: await readCacheStatus()})
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
                    loadSettings(),
                    readCacheStatus(),
                    readAgentPrompt()
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

    const testConnection = async () => {
        const nextRequest = settingsRequest(state)
        if (!nextRequest) return
        dispatch({type: 'began', task: 'testing'})
        try {
            const result = await testAiConnection(nextRequest)
            dispatch({type: 'noticed', notice: connectionNotice(result)})
            if (result.status === 'connected' || result.status === 'model-unavailable') {
                const models = await listAiModels(nextRequest)
                dispatch({type: 'models-listed', models})
            }
        } catch (error) {
            dispatch({
                type: 'failed',
                task: 'testing',
                notice: {
                    status: 'error',
                    title: 'Connection test failed',
                    description: commandErrorMessage(error)
                }
            })
        } finally {
            dispatch({type: 'ended', task: 'testing'})
        }
    }

    const save = async () => {
        const nextRequest = settingsRequest(state)
        if (!nextRequest) return
        dispatch({type: 'began', task: 'saving'})
        try {
            // The prompt has a store of its own — it belongs to the project rather than to the
            // connection — and one button saves both, because two save buttons on one page is a
            // question the user should not have to answer.
            if (agentPromptIsUnsaved(state)) {
                dispatch({type: 'prompt-saved', prompt: await saveAgentPrompt(state.agentPrompt)})
            }
            const response = await saveSettings(nextRequest)
            dispatch({type: 'saved', response})
        } catch (error) {
            dispatch({
                type: 'failed',
                task: 'saving',
                notice: {
                    status: 'error',
                    title: 'Settings could not be saved',
                    description: commandErrorMessage(error)
                }
            })
        } finally {
            dispatch({type: 'ended', task: 'saving'})
        }
    }

    const downloadModels = async () => {
        dispatch({type: 'began', task: 'downloading'})
        dispatch({type: 'cache-downloading'})
        let unlisten: (() => void) | undefined
        try {
            unlisten = await listen('rag-download-progress', event => {
                dispatch({type: 'progress', progress: event.payload})
            })
            await initializeRag()
            await refreshCache()
            dispatch({
                type: 'noticed',
                notice: {
                    status: 'success',
                    title: 'Documentation models installed',
                    description: 'Gofer can now search the local Godot 4.7 documentation.'
                }
            })
        } catch (error) {
            await refreshCache()
            dispatch({
                type: 'failed',
                task: 'downloading',
                notice: {
                    status: 'error',
                    title: 'Models could not be installed',
                    description: commandErrorMessage(error)
                }
            })
        } finally {
            unlisten?.()
            dispatch({type: 'ended', task: 'downloading'})
        }
    }

    const deleteCache = async () => {
        dispatch({type: 'began', task: 'deleting'})
        try {
            const nextCache = await deleteRagCache()
            dispatch({type: 'cache-read', cache: nextCache})
            dispatch({type: 'delete-dialog', isOpen: false})
            onCacheDeleted()
        } catch (error) {
            dispatch({
                type: 'failed',
                task: 'deleting',
                notice: {
                    status: 'error',
                    title: 'Model cache could not be deleted',
                    description: commandErrorMessage(error)
                }
            })
        } finally {
            dispatch({type: 'ended', task: 'deleting'})
        }
    }

    const createBackup = async () => {
        dispatch({type: 'began', task: 'backingUp'})
        try {
            const result = await createProjectBackup()
            dispatch({
                type: 'noticed',
                notice: {
                    status: 'success',
                    title: 'Project backup created',
                    description: result.path
                }
            })
        } catch (error) {
            dispatch({
                type: 'failed',
                task: 'backingUp',
                notice: {
                    status: 'error',
                    title: 'Backup failed',
                    description: commandErrorMessage(error)
                }
            })
        } finally {
            dispatch({type: 'ended', task: 'backingUp'})
        }
    }

    const cleanStorage = async () => {
        dispatch({type: 'began', task: 'cleaningStorage'})
        try {
            const result = await runStorageMaintenance()
            dispatch({
                type: 'noticed',
                notice: {
                    status: 'success',
                    title: 'Storage maintenance complete',
                    description: `${String(result.attachmentsRemoved)} attachments, ${String(result.blobsRemoved)} blobs, ${String(result.godotRunsRemoved)} old Godot runs, and ${String(result.backupsRemoved)} old backups removed. ${String(result.memoryEmbeddingsRestored)} memory embeddings restored.`
                }
            })
        } catch (error) {
            dispatch({
                type: 'failed',
                task: 'cleaningStorage',
                notice: {
                    status: 'error',
                    title: 'Storage cleanup failed',
                    description: commandErrorMessage(error)
                }
            })
        } finally {
            dispatch({type: 'ended', task: 'cleaningStorage'})
        }
    }

    const value = progressValue(progress)
    const isDeletable = canDeleteCache(state)
    const isShippedPrompt = agentPromptIsDefault(state)
    const selectModel = (model: AiModelOption) => {
        dispatch({type: 'model-chosen', model})
    }

    return (
        <>
            <Dialog
                isOpen={isOpen && !state.isDeleteOpen}
                onOpenChange={onOpenChange}
                purpose='form'
                width={960}
                maxHeight='90vh'
            >
                <Layout
                    height='fill'
                    header={
                        <DialogHeader
                            title='Settings'
                            subtitle='Configuration is owned by Gofer and stored only on this device.'
                            onOpenChange={onOpenChange}
                        />
                    }
                    content={
                        <LayoutContent padding={6}>
                            <VStack gap={8}>
                                {notice && (
                                    <Banner
                                        status={notice.status}
                                        title={notice.title}
                                        description={notice.description}
                                        isDismissable={notice.status !== 'error'}
                                        onDismiss={() => {
                                            dispatch({type: 'notice-dismissed'})
                                        }}
                                    />
                                )}

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
                                            One active OpenAI-compatible connection. Changes take
                                            effect only after saving.
                                        </Text>
                                    </VStack>

                                    {draft ?
                                        <VStack gap={5}>
                                            <FormLayout>
                                                <TextInput
                                                    label='Connection type'
                                                    value='OpenAI-compatible'
                                                    isDisabled
                                                    disabledMessage='OpenAI-compatible is the only supported connection type.'
                                                />
                                                <TextInput
                                                    label='Connection name'
                                                    value={draft.ai.name}
                                                    isRequired
                                                    onChange={name => {
                                                        updateAi({name})
                                                    }}
                                                />
                                                <TextInput
                                                    label='Base URL'
                                                    value={draft.ai.baseUrl}
                                                    isRequired
                                                    description='Absolute HTTP or HTTPS URL including the API prefix.'
                                                    onChange={baseUrl => {
                                                        updateAi({baseUrl})
                                                    }}
                                                />
                                                <TextInput
                                                    label='Model ID'
                                                    value={draft.ai.model}
                                                    isRequired
                                                    description='Must exactly match an ID returned by the server models endpoint.'
                                                    onChange={model => {
                                                        updateAi({model})
                                                    }}
                                                />
                                                {availableModels.length > 0 && (
                                                    <DropdownMenu
                                                        button={{
                                                            label: `Select server model (${String(availableModels.length)})`,
                                                            variant: 'secondary'
                                                        }}
                                                        menuWidth={360}
                                                        items={availableModels.map(model => ({
                                                            label: `${model.name} · ${model.contextWindow.toLocaleString()} context`,
                                                            onClick: () => {
                                                                selectModel(model)
                                                            }
                                                        }))}
                                                    />
                                                )}
                                                <TextInput
                                                    label='Context window'
                                                    value={String(draft.ai.contextWindow)}
                                                    isRequired
                                                    description='Maximum context tokens advertised by the selected model.'
                                                    onChange={contextWindow => {
                                                        updateAi({
                                                            contextWindow: Number(contextWindow)
                                                        })
                                                    }}
                                                />
                                                <TextInput
                                                    label='Maximum output tokens'
                                                    value={String(draft.ai.maxTokens)}
                                                    isRequired
                                                    onChange={maxTokens => {
                                                        updateAi({maxTokens: Number(maxTokens)})
                                                    }}
                                                />
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
                                                    formatValue={compactionLabel(
                                                        draft.ai.contextWindow
                                                    )}
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
                                                        label: `Reasoning: ${draft.ai.thinkingLevel}`,
                                                        variant: 'secondary'
                                                    }}
                                                    items={(draft.ai.reasoning ?
                                                        ALL_THINKING_LEVELS
                                                    :   NO_THINKING_LEVELS
                                                    ).map(level => ({
                                                        label: level,
                                                        onClick: () => {
                                                            updateAi({thinkingLevel: level})
                                                        }
                                                    }))}
                                                />
                                                <TextInput
                                                    label='API dialect'
                                                    value='OpenAI chat completions'
                                                    isDisabled
                                                    disabledMessage='Additional OpenAI API dialects are not supported yet.'
                                                />
                                                <TextInput
                                                    label='API key'
                                                    type='password'
                                                    value={apiKey}
                                                    isOptional
                                                    startIcon={KeyIcon}
                                                    placeholder={
                                                        state.hasApiKey ? 'Stored securely' : (
                                                            'Not required by local servers'
                                                        )
                                                    }
                                                    description={
                                                        apiKeyIntent === 'clear' ?
                                                            'The stored key will be removed when you save.'
                                                        : state.hasApiKey ?
                                                            'Leave blank to keep the key stored in the operating system credential store.'
                                                        :   'Enter a key only if this server requires authentication.'

                                                    }
                                                    onChange={enteredApiKey => {
                                                        dispatch({
                                                            type: 'api-key-typed',
                                                            value: enteredApiKey
                                                        })
                                                    }}
                                                />
                                            </FormLayout>
                                            {(state.hasApiKey || apiKeyIntent === 'clear') && (
                                                <Button
                                                    label={
                                                        apiKeyIntent === 'clear' ?
                                                            'Keep stored API key'
                                                        :   'Remove stored API key'
                                                    }
                                                    variant='ghost'
                                                    clickAction={() => {
                                                        dispatch({type: 'api-key-removal-toggled'})
                                                    }}
                                                />
                                            )}
                                        </VStack>
                                    :   <Text color='secondary'>
                                            {state.isLoading ?
                                                'Loading Gofer settings…'
                                            :   'Settings are unavailable.'}
                                        </Text>
                                    }
                                </Grid>

                                <Divider />

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
                                            What the agent is told before every turn, sent exactly
                                            as it reads here. It belongs to this project, so another
                                            project keeps its own.
                                        </Text>
                                    </VStack>

                                    {draft ?
                                        <VStack gap={5}>
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
                                            </HStack>
                                        </VStack>
                                    :   <Text color='secondary'>
                                            {state.isLoading ?
                                                'Loading the agent prompt…'
                                            :   'The agent prompt is unavailable.'}
                                        </Text>
                                    }
                                </Grid>

                                <Divider />

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
                                            Local embedding and reranking models used to search the
                                            Godot 4.7 documentation.
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
                                                    <Text color='secondary'>
                                                        {formatBytes(cache.sizeBytes)}
                                                    </Text>
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

                                            <HStack
                                                gap={3}
                                                hAlign='end'
                                            >
                                                {cache.state !== 'installed' && (
                                                    <Button
                                                        label='Download models'
                                                        variant='secondary'
                                                        icon={
                                                            <Icon
                                                                icon={CloudArrowDownIcon}
                                                                size='sm'
                                                            />
                                                        }
                                                        isLoading={busy.downloading}
                                                        /*
                                                         * Started rather than awaited. `Button`
                                                         * runs `clickAction` inside
                                                         * `startTransition`, and React holds the
                                                         * old screen for as long as a transition
                                                         * is pending — so awaiting a 1.68 GiB
                                                         * download here meant the progress bar and
                                                         * the Busy badge this sets did not appear
                                                         * until the download was already over.
                                                         * Returning at once ends the transition and
                                                         * lets the rest paint as it happens; the
                                                         * button still spins, on `busy.downloading`
                                                         * above.
                                                         */
                                                        clickAction={() => {
                                                            void downloadModels()
                                                        }}
                                                    />
                                                )}
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
                                            </HStack>
                                        </VStack>
                                    :   <Text color='secondary'>
                                            {state.isLoading ?
                                                'Inspecting the model cache…'
                                            :   'Cache status is unavailable.'}
                                        </Text>
                                    }
                                </Grid>

                                <Divider />

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
                                            <Heading level={2}>Project storage</Heading>
                                        </HStack>
                                        <Text color='secondary'>
                                            Back up the active project database, attachments, and
                                            Godot logs. Cleanup retains five backups and thirty days
                                            of completed run logs.
                                        </Text>
                                    </VStack>
                                    <HStack
                                        gap={3}
                                        hAlign='end'
                                        vAlign='center'
                                    >
                                        <Button
                                            label='Clean storage'
                                            variant='secondary'
                                            isLoading={busy.cleaningStorage}
                                            isDisabled={busy.backingUp}
                                            clickAction={cleanStorage}
                                        />
                                        {/*
                                         * Secondary, not primary: the footer's Save is pinned, so
                                         * scrolling to this row puts both blues on screen at once
                                         * and neither one says what the dialog is for.
                                         */}
                                        <Button
                                            label='Back up project'
                                            variant='secondary'
                                            isLoading={busy.backingUp}
                                            isDisabled={busy.cleaningStorage}
                                            clickAction={createBackup}
                                        />
                                    </HStack>
                                </Grid>
                            </VStack>
                        </LayoutContent>
                    }
                    /*
                     * The connection form is taller than the dialog at 1280x800, so an action row
                     * that scrolled with its own section put Save below the fold with nothing on
                     * screen to say there was more: the last field simply ran off the bottom edge.
                     * Pinned here it is always reachable, and the divider gives the scrolling body
                     * an end to slide under.
                     */
                    footer={
                        draft ?
                            <LayoutFooter
                                hasDivider
                                label='Connection actions'
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
                                        label='Save connection'
                                        variant='primary'
                                        isLoading={busy.saving}
                                        isDisabled={busy.testing}
                                        clickAction={save}
                                    />
                                </HStack>
                            </LayoutFooter>
                        :   undefined
                    }
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

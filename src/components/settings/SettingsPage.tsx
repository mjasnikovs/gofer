import {useCallback, useEffect, useRef, useState} from 'react'
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
import {HStack, VStack} from '@astryxdesign/core/Stack'
import {StatusDot} from '@astryxdesign/core/StatusDot'
import {Heading, Text} from '@astryxdesign/core/Text'
import {TextInput} from '@astryxdesign/core/TextInput'
import CircleStackIcon from '@heroicons/react/24/outline/CircleStackIcon'
import CloudArrowDownIcon from '@heroicons/react/24/outline/CloudArrowDownIcon'
import KeyIcon from '@heroicons/react/24/outline/KeyIcon'
import ServerStackIcon from '@heroicons/react/24/outline/ServerStackIcon'
import TrashIcon from '@heroicons/react/24/outline/TrashIcon'
import {invoke, isTauri, listen} from '../../services/desktop'
import {commandErrorMessage} from '../../utils/command-error'
import type {DownloadProgress} from '@mjasnikovs/gofer-rag'
import {
    ALL_THINKING_LEVELS,
    NO_THINKING_LEVELS,
    apiKeyUpdate,
    cacheStateLabel,
    cacheStateVariant,
    connectionNotice,
    formatBytes,
    normalizeSettings,
    progressLabel,
    progressValue
} from '../../models/settings'
import type {
    AiModelOption,
    AiSettings,
    ApiKeyIntent,
    CacheStatus,
    GoferSettings,
    Notice,
    SettingsRequest
} from '../../models/settings'

/** Every settings group breaks to one column at the same width. */
const SETTINGS_GRID_COLUMNS = {minWidth: 320} as const

type SettingsPageProps = Readonly<{
    isOpen: boolean
    onOpenChange: (isOpen: boolean) => void
    onCacheDeleted: () => void
}>

export function SettingsPage({isOpen, onOpenChange, onCacheDeleted}: SettingsPageProps) {
    const hasLoaded = useRef(false)
    const [draft, setDraft] = useState<GoferSettings>()
    const [hasApiKey, setHasApiKey] = useState(false)
    const [apiKey, setApiKey] = useState('')
    const [apiKeyIntent, setApiKeyIntent] = useState<ApiKeyIntent>('keep')
    const [cache, setCache] = useState<CacheStatus>()
    const [progress, setProgress] = useState<DownloadProgress>()
    const [notice, setNotice] = useState<Notice>()
    const [isLoading, setIsLoading] = useState(true)
    const [isTesting, setIsTesting] = useState(false)
    const [isSaving, setIsSaving] = useState(false)
    const [isDownloading, setIsDownloading] = useState(false)
    const [isDeleteOpen, setIsDeleteOpen] = useState(false)
    const [isDeleting, setIsDeleting] = useState(false)
    const [isBackingUp, setIsBackingUp] = useState(false)
    const [isCleaningStorage, setIsCleaningStorage] = useState(false)
    const [availableModels, setAvailableModels] = useState<readonly AiModelOption[]>([])

    const refreshCache = useCallback(async () => {
        const nextCache = await invoke('get_rag_cache_status')
        setCache(nextCache)
    }, [])

    useEffect(() => {
        if (hasLoaded.current) return
        hasLoaded.current = true

        const load = async () => {
            if (!isTauri()) {
                setNotice({
                    status: 'warning',
                    title: 'Desktop app required',
                    description:
                        'Local settings and model management are available in the Tauri desktop app.'
                })
                setIsLoading(false)
                return
            }

            try {
                const [settingsResponse, cacheResponse] = await Promise.all([
                    invoke('load_settings'),
                    invoke('get_rag_cache_status')
                ])
                setDraft(normalizeSettings(settingsResponse.settings))
                setHasApiKey(settingsResponse.hasApiKey)
                setCache(cacheResponse)
                if (settingsResponse.credentialStoreError) {
                    setNotice({
                        status: 'warning',
                        title: 'API key storage is unavailable',
                        description: settingsResponse.credentialStoreError
                    })
                }
            } catch (error) {
                setNotice({
                    status: 'error',
                    title: 'Settings could not be loaded',
                    description: commandErrorMessage(error)
                })
            } finally {
                setIsLoading(false)
            }
        }

        void load()
    }, [])

    const updateAi = (update: Partial<AiSettings>) => {
        setDraft(previous => (previous ? {...previous, ai: {...previous.ai, ...update}} : previous))
    }

    const request = (): SettingsRequest | undefined => {
        if (!draft) return undefined
        return {settings: draft, apiKey: apiKeyUpdate(apiKeyIntent, apiKey)}
    }

    const testConnection = async () => {
        const nextRequest = request()
        if (!nextRequest) return
        setIsTesting(true)
        setNotice(undefined)
        try {
            const result = await invoke('test_ai_connection', {
                request: nextRequest
            })
            setNotice(connectionNotice(result))
            if (result.status === 'connected' || result.status === 'model-unavailable') {
                const models = await invoke('list_ai_models', {
                    request: nextRequest
                })
                setAvailableModels(models)
            }
        } catch (error) {
            setNotice({
                status: 'error',
                title: 'Connection test failed',
                description: commandErrorMessage(error)
            })
        } finally {
            setIsTesting(false)
        }
    }

    const save = async () => {
        const nextRequest = request()
        if (!nextRequest) return
        setIsSaving(true)
        setNotice(undefined)
        try {
            const response = await invoke('save_settings', {request: nextRequest})
            setDraft(response.settings)
            setHasApiKey(response.hasApiKey)
            setApiKey('')
            setApiKeyIntent('keep')
            setNotice(
                response.credentialStoreError ?
                    {
                        status: 'warning',
                        title: 'Connection saved without API key access',
                        description: response.credentialStoreError
                    }
                :   {
                        status: 'success',
                        title: 'Settings saved',
                        description: 'Gofer will use this AI connection for subsequent requests.'
                    }
            )
        } catch (error) {
            setNotice({
                status: 'error',
                title: 'Settings could not be saved',
                description: commandErrorMessage(error)
            })
        } finally {
            setIsSaving(false)
        }
    }

    const downloadModels = async () => {
        setIsDownloading(true)
        setNotice(undefined)
        setCache(previous => (previous ? {...previous, state: 'busy'} : previous))
        let unlisten: (() => void) | undefined
        try {
            unlisten = await listen('rag-download-progress', event => {
                setProgress(event.payload)
            })
            await invoke('initialize_rag')
            await refreshCache()
            setNotice({
                status: 'success',
                title: 'Documentation models installed',
                description: 'Gofer can now search the local Godot 4.7 documentation.'
            })
        } catch (error) {
            await refreshCache()
            setNotice({
                status: 'error',
                title: 'Models could not be installed',
                description: commandErrorMessage(error)
            })
        } finally {
            unlisten?.()
            setIsDownloading(false)
            setProgress(undefined)
        }
    }

    const deleteCache = async () => {
        setIsDeleting(true)
        setNotice(undefined)
        try {
            const nextCache = await invoke('delete_rag_cache')
            setCache(nextCache)
            setIsDeleteOpen(false)
            onCacheDeleted()
        } catch (error) {
            setNotice({
                status: 'error',
                title: 'Model cache could not be deleted',
                description: commandErrorMessage(error)
            })
        } finally {
            setIsDeleting(false)
        }
    }

    const createBackup = async () => {
        setIsBackingUp(true)
        setNotice(undefined)
        try {
            const result = await invoke('create_project_backup')
            setNotice({
                status: 'success',
                title: 'Project backup created',
                description: result.path
            })
        } catch (error) {
            setNotice({
                status: 'error',
                title: 'Backup failed',
                description: commandErrorMessage(error)
            })
        } finally {
            setIsBackingUp(false)
        }
    }

    const cleanStorage = async () => {
        setIsCleaningStorage(true)
        setNotice(undefined)
        try {
            const result = await invoke('run_storage_maintenance')
            setNotice({
                status: 'success',
                title: 'Storage maintenance complete',
                description: `${String(result.attachmentsRemoved)} attachments, ${String(result.blobsRemoved)} blobs, ${String(result.godotRunsRemoved)} old Godot runs, and ${String(result.backupsRemoved)} old backups removed. ${String(result.memoryEmbeddingsRestored)} memory embeddings restored.`
            })
        } catch (error) {
            setNotice({
                status: 'error',
                title: 'Storage cleanup failed',
                description: commandErrorMessage(error)
            })
        } finally {
            setIsCleaningStorage(false)
        }
    }

    const value = progressValue(progress)
    const cacheIsBusy = cache?.state === 'busy' || isDownloading
    const canDeleteCache = Boolean(cache && cache.sizeBytes > 0 && !cacheIsBusy)
    const selectModel = (model: AiModelOption) => {
        updateAi({
            model: model.id,
            modelName: model.name,
            contextWindow: model.contextWindow,
            maxTokens: model.maxTokens,
            reasoning: model.reasoning,
            supportsReasoningEffort: model.supportsReasoningEffort,
            input: model.input,
            thinkingLevel: model.reasoning ? (draft?.ai.thinkingLevel ?? 'off') : 'off'
        })
    }

    return (
        <>
            <Dialog
                isOpen={isOpen && !isDeleteOpen}
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
                                            setNotice(undefined)
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
                                                    label='Agent system prompt'
                                                    value={draft.ai.systemPrompt}
                                                    isOptional
                                                    description='Leave blank to use Gofer’s built-in coding-agent prompt.'
                                                    onChange={systemPrompt => {
                                                        updateAi({systemPrompt})
                                                    }}
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
                                                        hasApiKey ? 'Stored securely' : (
                                                            'Not required by local servers'
                                                        )
                                                    }
                                                    description={
                                                        apiKeyIntent === 'clear' ?
                                                            'The stored key will be removed when you save.'
                                                        : hasApiKey ?
                                                            'Leave blank to keep the key stored in the operating system credential store.'
                                                        :   'Enter a key only if this server requires authentication.'

                                                    }
                                                    onChange={enteredApiKey => {
                                                        setApiKey(enteredApiKey)
                                                        setApiKeyIntent(
                                                            enteredApiKey.trim() ? 'set' : 'keep'
                                                        )
                                                    }}
                                                />
                                            </FormLayout>
                                            {(hasApiKey || apiKeyIntent === 'clear') && (
                                                <Button
                                                    label={
                                                        apiKeyIntent === 'clear' ?
                                                            'Keep stored API key'
                                                        :   'Remove stored API key'
                                                    }
                                                    variant='ghost'
                                                    clickAction={() => {
                                                        setApiKey('')
                                                        setApiKeyIntent(
                                                            apiKeyIntent === 'clear' ? 'keep' : (
                                                                'clear'
                                                            )
                                                        )
                                                    }}
                                                />
                                            )}
                                        </VStack>
                                    :   <Text color='secondary'>
                                            {isLoading ?
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

                                            {isDownloading && (
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
                                                        isLoading={isDownloading}
                                                        clickAction={downloadModels}
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
                                                    isDisabled={!canDeleteCache}
                                                    clickAction={() => {
                                                        setIsDeleteOpen(true)
                                                    }}
                                                />
                                            </HStack>
                                        </VStack>
                                    :   <Text color='secondary'>
                                            {isLoading ?
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
                                            isLoading={isCleaningStorage}
                                            isDisabled={isBackingUp}
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
                                            isLoading={isBackingUp}
                                            isDisabled={isCleaningStorage}
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
                                        isLoading={isTesting}
                                        isDisabled={isSaving}
                                        clickAction={testConnection}
                                    />
                                    <Button
                                        label='Save connection'
                                        variant='primary'
                                        isLoading={isSaving}
                                        isDisabled={isTesting}
                                        clickAction={save}
                                    />
                                </HStack>
                            </LayoutFooter>
                        :   undefined
                    }
                />
            </Dialog>
            <AlertDialog
                isOpen={isDeleteOpen}
                onOpenChange={setIsDeleteOpen}
                title='Delete documentation model cache?'
                description='This removes only the downloaded embedding and reranking models. Gofer will return to the preparation screen and download approximately 1.68 GiB again.'
                actionLabel='Delete model cache'
                isActionLoading={isDeleting}
                onAction={deleteCache}
            />
        </>
    )
}

export default SettingsPage

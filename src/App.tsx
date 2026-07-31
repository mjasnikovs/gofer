import {useCallback, useEffect, useRef, useState} from 'react'
import {AlertDialog} from '@astryxdesign/core/AlertDialog'
import {AppShell} from '@astryxdesign/core/AppShell'
import {Banner} from '@astryxdesign/core/Banner'
import {Button} from '@astryxdesign/core/Button'
import {
    ChatComposer,
    ChatMessage,
    ChatMessageBubble,
    ChatMessageList
} from '@astryxdesign/core/Chat'
import {ClickableCard} from '@astryxdesign/core/ClickableCard'
import {Divider} from '@astryxdesign/core/Divider'
import {FormLayout} from '@astryxdesign/core/FormLayout'
import {Grid} from '@astryxdesign/core/Grid'
import {Icon} from '@astryxdesign/core/Icon'
import {Layout, LayoutContent, LayoutFooter} from '@astryxdesign/core/Layout'
import {NavIcon} from '@astryxdesign/core/NavIcon'
import {ProgressBar} from '@astryxdesign/core/ProgressBar'
import {SideNav, SideNavHeading, SideNavItem, SideNavSection} from '@astryxdesign/core/SideNav'
import {Spinner} from '@astryxdesign/core/Spinner'
import {HStack, VStack} from '@astryxdesign/core/Stack'
import {StatusDot} from '@astryxdesign/core/StatusDot'
import {Heading, Text} from '@astryxdesign/core/Text'
import {TextInput} from '@astryxdesign/core/TextInput'
import {
    BoltIcon,
    ChatBubbleLeftRightIcon,
    CircleStackIcon,
    CloudArrowDownIcon,
    CodeBracketSquareIcon,
    Cog6ToothIcon,
    CubeTransparentIcon,
    FolderOpenIcon,
    KeyIcon,
    PlusIcon,
    ServerStackIcon,
    SparklesIcon,
    TrashIcon
} from '@heroicons/react/24/outline'
import {invoke, isTauri} from '@tauri-apps/api/core'
import {listen} from '@tauri-apps/api/event'
import type {DownloadProgress} from '@mjasnikovs/gofer-rag'

type Page = 'workspace' | 'settings'

type Message = Readonly<{
    id: number
    sender: 'user' | 'assistant'
    text: string
}>

type InitializationState =
    | Readonly<{status: 'initializing'; progress?: DownloadProgress}>
    | Readonly<{status: 'error'; message: string}>
    | Readonly<{status: 'ready'}>

type AiSettings = Readonly<{
    connectionType: 'openai-compatible'
    name: string
    baseUrl: string
    model: string
    api: 'openai-completions'
}>

type GoferSettings = Readonly<{
    version: 1
    ai: AiSettings
}>

type SettingsResponse = Readonly<{
    settings: GoferSettings
    hasApiKey: boolean
    credentialStoreError?: string
}>

type ApiKeyUpdate =
    | Readonly<{action: 'keep'}>
    | Readonly<{action: 'set'; value: string}>
    | Readonly<{action: 'clear'}>

type SettingsRequest = Readonly<{
    settings: GoferSettings
    apiKey: ApiKeyUpdate
}>

type CacheStatus = Readonly<{
    path: string
    sizeBytes: number
    state: 'installed' | 'incomplete' | 'not-installed' | 'busy'
}>

type ConnectionTestResult = Readonly<{
    status:
        'connected' | 'model-unavailable' | 'unauthorized' | 'server-error' | 'server-unreachable'
    message: string
}>

type Notice = Readonly<{
    status: 'info' | 'warning' | 'error' | 'success'
    title: string
    description: string
}>

type ApiKeyIntent = 'keep' | 'set' | 'clear'

const SUGGESTIONS = [
    {
        title: 'Build a player controller',
        description: 'Create the scene, script movement, and wire input actions.',
        prompt: 'Build a responsive third-person player controller.'
    },
    {
        title: 'Debug the current scene',
        description: 'Inspect nodes, errors, signals, and runtime behavior.',
        prompt: 'Inspect the current scene and help me debug it.'
    },
    {
        title: 'Polish the environment',
        description: 'Improve lighting, materials, composition, and atmosphere.',
        prompt: 'Polish the current environment and explain each change.'
    },
    {
        title: 'Design an interaction',
        description: 'Plan and implement an object the player can use.',
        prompt: 'Design and implement an interactive object for this scene.'
    }
] as const

function formatBytes(bytes: number) {
    if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GiB`
    if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`
    if (bytes === 0) return '0 bytes'
    return `${String(Math.round(bytes / 1024))} KiB`
}

function progressValue(progress?: DownloadProgress) {
    if (typeof progress?.progress === 'number') return Math.min(100, Math.max(0, progress.progress))
    if (progress?.loaded !== undefined && progress.total)
        return (progress.loaded / progress.total) * 100
    return undefined
}

function progressLabel(progress?: DownloadProgress) {
    if (!progress) return 'Preparing model download…'
    if (progress.loaded !== undefined && progress.total) {
        return `${progress.model}: ${formatBytes(progress.loaded)} of ${formatBytes(progress.total)}`
    }
    return `${progress.model}: ${progress.status}`
}

function InitializationSplash({onReady}: {onReady: () => void}) {
    const [state, setState] = useState<InitializationState>({status: 'initializing'})
    const hasStarted = useRef(false)

    const initialize = useCallback(async () => {
        setState({status: 'initializing'})

        if (!isTauri()) {
            setState({
                status: 'error',
                message:
                    'Model initialization requires the desktop app. Start Gofer with npm run tauri dev.'
            })
            return
        }

        const unlisten = await listen<DownloadProgress>('rag-download-progress', event => {
            setState({status: 'initializing', progress: event.payload})
        })

        try {
            await invoke('initialize_rag')
            setState({status: 'ready'})
            onReady()
        } catch (error) {
            setState({status: 'error', message: String(error)})
        } finally {
            unlisten()
        }
    }, [onReady])

    useEffect(() => {
        if (hasStarted.current) return
        hasStarted.current = true
        void initialize()
    }, [initialize])

    const progress = state.status === 'initializing' ? state.progress : undefined
    const value = progressValue(progress)

    return (
        <AppShell
            contentPadding={6}
            variant='wash'
        >
            <Layout
                height='fill'
                contentWidth={640}
                content={
                    <LayoutContent padding={6}>
                        <VStack
                            height='100%'
                            gap={6}
                            hAlign='stretch'
                            vAlign='center'
                        >
                            <VStack
                                gap={3}
                                hAlign='center'
                            >
                                <Icon
                                    icon={CircleStackIcon}
                                    size='lg'
                                    color='accent'
                                />
                                <VStack
                                    gap={1}
                                    hAlign='center'
                                >
                                    <Heading
                                        level={1}
                                        type='display-2'
                                    >
                                        Prepare Gofer
                                    </Heading>
                                    <Text color='secondary'>
                                        Installing the local models used to search the Godot 4.7
                                        documentation.
                                    </Text>
                                </VStack>
                            </VStack>

                            {state.status === 'initializing' && (
                                <VStack gap={4}>
                                    <Banner
                                        status='info'
                                        title='Preparing documentation models'
                                        description='Missing models download automatically. Existing models are reused from the local cache.'
                                    />
                                    <Spinner
                                        size='lg'
                                        label='Initializing documentation search'
                                    />
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

                            {state.status === 'error' && (
                                <VStack gap={4}>
                                    <Banner
                                        status='error'
                                        title='Models could not be initialized'
                                        description={state.message}
                                    />
                                    <Button
                                        label='Try again'
                                        variant='primary'
                                        width='100%'
                                        clickAction={initialize}
                                    />
                                </VStack>
                            )}
                        </VStack>
                    </LayoutContent>
                }
            />
        </AppShell>
    )
}

function apiKeyUpdate(intent: ApiKeyIntent, value: string): ApiKeyUpdate {
    if (intent === 'clear') return {action: 'clear'}
    if (intent === 'set') return {action: 'set', value}
    return {action: 'keep'}
}

function cacheStateLabel(state: CacheStatus['state']) {
    if (state === 'installed') return 'Installed'
    if (state === 'incomplete') return 'Incomplete'
    if (state === 'busy') return 'Busy'
    return 'Not installed'
}

function cacheStateVariant(state: CacheStatus['state']) {
    if (state === 'installed') return 'success' as const
    if (state === 'incomplete' || state === 'busy') return 'warning' as const
    return 'neutral' as const
}

function connectionNotice(result: ConnectionTestResult): Notice {
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

function Navigation({page, onNavigate}: {page: Page; onNavigate: (page: Page) => void}) {
    return (
        <SideNav
            collapsible
            resizable={{defaultWidth: 280, minWidth: 220, maxWidth: 400}}
            header={
                <SideNavHeading
                    heading='Gofer'
                    icon={
                        <NavIcon
                            icon={
                                <Icon
                                    icon={SparklesIcon}
                                    size='sm'
                                    color='accent'
                                />
                            }
                        />
                    }
                    headingHref='#workspace'
                />
            }
            footer={
                <SideNavSection
                    title='System'
                    isHeaderHidden
                >
                    <SideNavItem
                        label='Settings'
                        icon={Cog6ToothIcon}
                        href='#settings'
                        isSelected={page === 'settings'}
                        onClick={event => {
                            event.preventDefault()
                            onNavigate('settings')
                        }}
                    />
                </SideNavSection>
            }
        >
            <SideNavSection
                title='Actions'
                isHeaderHidden
            >
                <SideNavItem
                    label='New task'
                    icon={PlusIcon}
                    href='#workspace'
                    isSelected={page === 'workspace'}
                    onClick={event => {
                        event.preventDefault()
                        onNavigate('workspace')
                    }}
                />
                <SideNavItem
                    label='Projects'
                    icon={FolderOpenIcon}
                    href='#projects'
                />
            </SideNavSection>
            <SideNavSection title='Recent tasks'>
                <SideNavItem
                    label='Player movement'
                    icon={ChatBubbleLeftRightIcon}
                    href='#player-movement'
                    endContent={
                        <StatusDot
                            variant='success'
                            label='Complete'
                        />
                    }
                />
                <SideNavItem
                    label='Village lighting'
                    icon={ChatBubbleLeftRightIcon}
                    href='#village-lighting'
                    endContent={
                        <StatusDot
                            variant='neutral'
                            label='Idle'
                        />
                    }
                />
                <SideNavItem
                    label='Inventory prototype'
                    icon={ChatBubbleLeftRightIcon}
                    href='#inventory-prototype'
                    endContent={
                        <StatusDot
                            variant='warning'
                            label='Needs review'
                        />
                    }
                />
            </SideNavSection>
        </SideNav>
    )
}

function Welcome({onSuggestion}: {onSuggestion: (prompt: string) => void}) {
    return (
        <VStack
            gap={8}
            paddingBlock={10}
            hAlign='stretch'
        >
            <VStack
                gap={2}
                hAlign='center'
            >
                <Icon
                    icon={SparklesIcon}
                    size='lg'
                    color='accent'
                />
                <Heading
                    level={1}
                    type='display-2'
                >
                    What should we make?
                </Heading>
                <Text color='secondary'>
                    Describe the outcome. Gofer will plan the work and operate Godot for you.
                </Text>
            </VStack>
            <Grid
                columns={{minWidth: 280}}
                gap={3}
            >
                {SUGGESTIONS.map(suggestion => (
                    <ClickableCard
                        key={suggestion.title}
                        label={suggestion.title}
                        variant='muted'
                        padding={4}
                        onClick={() => {
                            onSuggestion(suggestion.prompt)
                        }}
                    >
                        <VStack gap={1}>
                            <Heading level={3}>{suggestion.title}</Heading>
                            <Text
                                type='supporting'
                                color='secondary'
                            >
                                {suggestion.description}
                            </Text>
                        </VStack>
                    </ClickableCard>
                ))}
            </Grid>
        </VStack>
    )
}

function Workspace() {
    const [draft, setDraft] = useState('')
    const [messages, setMessages] = useState<readonly Message[]>([])
    const nextMessageId = useRef(1)

    const submitMessage = (value: string) => {
        const prompt = value.trim()
        if (!prompt) return

        const userMessage: Message = {
            id: nextMessageId.current++,
            sender: 'user',
            text: prompt
        }
        const assistantMessage: Message = {
            id: nextMessageId.current++,
            sender: 'assistant',
            text: 'The workspace is ready. Connect a Godot 4.7 editor to begin executing this task.'
        }

        setMessages(previous => [...previous, userMessage, assistantMessage])
        setDraft('')
    }

    return (
        <Layout
            height='fill'
            contentWidth={880}
            content={
                <LayoutContent padding={6}>
                    <VStack
                        gap={6}
                        height='100%'
                    >
                        <HStack
                            hAlign='between'
                            vAlign='center'
                        >
                            <VStack gap={0.5}>
                                <Heading level={2}>New task</Heading>
                                <Text
                                    type='supporting'
                                    color='secondary'
                                >
                                    Agent workspace
                                </Text>
                            </VStack>
                            <HStack
                                gap={3}
                                vAlign='center'
                            >
                                <HStack
                                    gap={1}
                                    vAlign='center'
                                >
                                    <StatusDot
                                        variant='neutral'
                                        label='Godot disconnected'
                                    />
                                    <Text type='supporting'>Godot disconnected</Text>
                                </HStack>
                                <HStack
                                    gap={1}
                                    vAlign='center'
                                >
                                    <Icon
                                        icon={CodeBracketSquareIcon}
                                        size='sm'
                                    />
                                    <Text type='supporting'>4.7</Text>
                                </HStack>
                            </HStack>
                        </HStack>
                        {messages.length === 0 ?
                            <Welcome onSuggestion={setDraft} />
                        :   <ChatMessageList density='spacious'>
                                {messages.map(message => (
                                    <ChatMessage
                                        key={message.id}
                                        sender={message.sender}
                                    >
                                        <ChatMessageBubble
                                            variant={
                                                message.sender === 'assistant' ? 'ghost' : 'filled'
                                            }
                                            name={
                                                message.sender === 'assistant' ? 'Gofer' : undefined
                                            }
                                        >
                                            <Text>{message.text}</Text>
                                        </ChatMessageBubble>
                                    </ChatMessage>
                                ))}
                            </ChatMessageList>
                        }
                    </VStack>
                </LayoutContent>
            }
            footer={
                <LayoutFooter>
                    <VStack gap={2}>
                        <ChatComposer
                            value={draft}
                            onChange={setDraft}
                            onSubmit={submitMessage}
                            placeholder='Ask Gofer to build, fix, or explain anything…'
                            footerActions={
                                <HStack
                                    gap={3}
                                    vAlign='center'
                                >
                                    <HStack
                                        gap={1}
                                        vAlign='center'
                                    >
                                        <Icon
                                            icon={CubeTransparentIcon}
                                            size='sm'
                                        />
                                        <Text type='supporting'>Godot context</Text>
                                    </HStack>
                                    <HStack
                                        gap={1}
                                        vAlign='center'
                                    >
                                        <Icon
                                            icon={BoltIcon}
                                            size='sm'
                                        />
                                        <Text type='supporting'>Plan first</Text>
                                    </HStack>
                                </HStack>
                            }
                        />
                        <Text
                            type='supporting'
                            color='secondary'
                        >
                            Gofer can make mistakes. Review project changes before shipping.
                        </Text>
                    </VStack>
                </LayoutFooter>
            }
        />
    )
}

function SettingsPage({onCacheDeleted}: {onCacheDeleted: () => void}) {
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

    const refreshCache = useCallback(async () => {
        const nextCache = await invoke<CacheStatus>('get_rag_cache_status')
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
                    invoke<SettingsResponse>('load_settings'),
                    invoke<CacheStatus>('get_rag_cache_status')
                ])
                setDraft(settingsResponse.settings)
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
                    description: String(error)
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
            const result = await invoke<ConnectionTestResult>('test_ai_connection', {
                request: nextRequest
            })
            setNotice(connectionNotice(result))
        } catch (error) {
            setNotice({
                status: 'error',
                title: 'Connection test failed',
                description: String(error)
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
            const response = await invoke<SettingsResponse>('save_settings', {request: nextRequest})
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
                description: String(error)
            })
        } finally {
            setIsSaving(false)
        }
    }

    const downloadModels = async () => {
        setIsDownloading(true)
        setNotice(undefined)
        setCache(previous => (previous ? {...previous, state: 'busy'} : previous))
        const unlisten = await listen<DownloadProgress>('rag-download-progress', event => {
            setProgress(event.payload)
        })
        try {
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
                description: String(error)
            })
        } finally {
            unlisten()
            setIsDownloading(false)
            setProgress(undefined)
        }
    }

    const deleteCache = async () => {
        setIsDeleting(true)
        setNotice(undefined)
        try {
            const nextCache = await invoke<CacheStatus>('delete_rag_cache')
            setCache(nextCache)
            setIsDeleteOpen(false)
            onCacheDeleted()
        } catch (error) {
            setNotice({
                status: 'error',
                title: 'Model cache could not be deleted',
                description: String(error)
            })
        } finally {
            setIsDeleting(false)
        }
    }

    const value = progressValue(progress)
    const cacheIsBusy = cache?.state === 'busy' || isDownloading
    const canDeleteCache = Boolean(cache && cache.sizeBytes > 0 && !cacheIsBusy)

    return (
        <>
            <Layout
                height='fill'
                contentWidth={960}
                content={
                    <LayoutContent padding={6}>
                        <VStack gap={8}>
                            <VStack gap={1}>
                                <Heading
                                    level={1}
                                    type='display-3'
                                >
                                    Settings
                                </Heading>
                                <Text color='secondary'>
                                    Configuration is owned by Gofer and stored only on this device.
                                </Text>
                            </VStack>

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
                                columns={{minWidth: 320}}
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
                                        One active OpenAI-compatible connection. Changes take effect
                                        only after saving.
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
                                                    apiKeyIntent === 'clear' ? 'Keep stored API key'
                                                    :   'Remove stored API key'
                                                }
                                                variant='ghost'
                                                clickAction={() => {
                                                    setApiKey('')
                                                    setApiKeyIntent(
                                                        apiKeyIntent === 'clear' ? 'keep' : 'clear'
                                                    )
                                                }}
                                            />
                                        )}
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
                                columns={{minWidth: 320}}
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
                        </VStack>
                    </LayoutContent>
                }
            />
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

export default function App() {
    const [page, setPage] = useState<Page>('workspace')
    const [isReady, setIsReady] = useState(false)
    const showApplication = useCallback(() => {
        setIsReady(true)
    }, [])
    const prepareModels = useCallback(() => {
        setIsReady(false)
    }, [])

    if (!isReady) return <InitializationSplash onReady={showApplication} />

    return (
        <AppShell
            contentPadding={0}
            sideNav={
                <Navigation
                    page={page}
                    onNavigate={setPage}
                />
            }
        >
            {page === 'settings' ?
                <SettingsPage onCacheDeleted={prepareModels} />
            :   <Workspace />}
        </AppShell>
    )
}

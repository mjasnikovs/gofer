import {useCallback, useEffect, useRef, useState} from 'react'
import type {ReactNode} from 'react'
import {AlertDialog} from '@astryxdesign/core/AlertDialog'
import {AppShell} from '@astryxdesign/core/AppShell'
import {Banner} from '@astryxdesign/core/Banner'
import {Button} from '@astryxdesign/core/Button'
import {
    ChatComposer,
    ChatComposerDrawer,
    ChatComposerInput,
    ChatMessage,
    ChatMessageBubble,
    ChatMessageList,
    ChatMessageMetadata,
    ChatSendButton,
    ChatToolCalls,
    useChatStreamScroll
} from '@astryxdesign/core/Chat'
import {CodeBlock} from '@astryxdesign/core/CodeBlock'
import {Divider} from '@astryxdesign/core/Divider'
import {Dialog, DialogHeader} from '@astryxdesign/core/Dialog'
import {DropdownMenu} from '@astryxdesign/core/DropdownMenu'
import {FormLayout} from '@astryxdesign/core/FormLayout'
import {Grid} from '@astryxdesign/core/Grid'
import {Icon} from '@astryxdesign/core/Icon'
import {Layout, LayoutContent} from '@astryxdesign/core/Layout'
import {NavIcon} from '@astryxdesign/core/NavIcon'
import {ProgressBar} from '@astryxdesign/core/ProgressBar'
import {SideNav, SideNavHeading, SideNavItem, SideNavSection} from '@astryxdesign/core/SideNav'
import {Spinner} from '@astryxdesign/core/Spinner'
import {HStack, StackItem, VStack} from '@astryxdesign/core/Stack'
import {StatusDot} from '@astryxdesign/core/StatusDot'
import {Heading, Text} from '@astryxdesign/core/Text'
import {TextInput} from '@astryxdesign/core/TextInput'
import {Thumbnail} from '@astryxdesign/core/Thumbnail'
import {Token} from '@astryxdesign/core/Token'
import {
    CircleStackIcon,
    CloudArrowDownIcon,
    Cog6ToothIcon,
    KeyIcon,
    PlusIcon,
    ArrowPathIcon,
    PhotoIcon,
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
    timestamp: number
    thinking?: string
    tools?: readonly ToolActivity[]
    usage?: TokenUsage
    model?: string
    status?: 'streaming' | 'complete' | 'error' | 'aborted'
    attachments?: readonly ChatAttachment[]
}>

type ChatAttachment = Readonly<{
    id: string
    name: string
    mimeType: string
    size: number
}>

type DraftAttachment = ChatAttachment
    & Readonly<{
        data: string
        previewUrl: string
    }>

type TokenUsage = Readonly<{
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    reasoning?: number
    totalTokens: number
    cost: Readonly<{total: number}>
}>

type ToolActivity = Readonly<{
    id: string
    name: string
    target?: string
    output?: string
    status: 'pending' | 'running' | 'complete' | 'error'
    startedAt: number
    endedAt?: number
}>

type AiStreamEvent =
    | Readonly<{type: 'text-delta'; delta: string}>
    | Readonly<{type: 'thinking-delta'; delta: string}>
    | Readonly<{type: 'tool-start'; id: string; name: string; target?: string; startedAt: number}>
    | Readonly<{type: 'tool-update'; id: string; output: string}>
    | Readonly<{type: 'tool-end'; id: string; output: string; isError: boolean; endedAt: number}>
    | Readonly<{type: 'usage'; usage: TokenUsage; model: string}>
    | Readonly<{
          type: 'done'
          text: string
          thinking: string
          stopReason: string
          usage: TokenUsage
          model: string
          agentMessages: readonly unknown[]
      }>
    | Readonly<{type: 'aborted'}>

type AiStreamPayload = Readonly<{
    requestId: number
    event: AiStreamEvent
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
    modelName: string
    contextWindow: number
    maxTokens: number
    reasoning: boolean
    supportsReasoningEffort: boolean
    input: readonly string[]
    thinkingLevel: ThinkingLevel
    maxRetries: number
    timeoutMs: number
    systemPrompt: string
}>

type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

type AiModelOption = Readonly<{
    id: string
    name: string
    contextWindow: number
    maxTokens: number
    reasoning: boolean
    supportsReasoningEffort: boolean
    input: readonly string[]
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
type StoredChat = Readonly<{
    messages: readonly Message[]
    agentMessages: readonly unknown[]
}>

const CHAT_STORAGE_KEY = 'gofer.agent-chat.v1'
const CHAT_ATTACHMENT_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif'
const CHAT_ATTACHMENT_TYPES = new Set(CHAT_ATTACHMENT_ACCEPT.split(','))
const MAX_CHAT_ATTACHMENTS = 5
const MAX_CHAT_ATTACHMENT_BYTES = 10 * 1024 * 1024
const SPACIOUS_COMPOSER_INPUT_STYLE = {
    minHeight: 'calc(var(--spacing-12) + var(--spacing-10))'
} as const
const LEFT_ALIGNED_USER_BUBBLE_STYLE = {alignSelf: 'flex-start'} as const
const CHAT_SCROLL_VIEWPORT_STYLE = {display: 'flex'} as const

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null
}

function isStoredMessage(value: unknown): value is Message {
    if (!isRecord(value)) return false
    return (
        typeof value['id'] === 'number'
        && (value['sender'] === 'user' || value['sender'] === 'assistant')
        && typeof value['text'] === 'string'
        && typeof value['timestamp'] === 'number'
        && (value['attachments'] === undefined
            || (Array.isArray(value['attachments'])
                && value['attachments'].every(isStoredAttachment)))
    )
}

function isStoredAttachment(value: unknown): value is ChatAttachment {
    if (!isRecord(value)) return false
    return (
        typeof value['id'] === 'string'
        && typeof value['name'] === 'string'
        && typeof value['mimeType'] === 'string'
        && typeof value['size'] === 'number'
    )
}

function attachmentData(file: File) {
    return new Promise<{data: string; previewUrl: string}>((resolve, reject) => {
        const reader = new FileReader()
        reader.addEventListener('error', () => {
            reject(reader.error ?? new Error(`Could not read ${file.name}`))
        })
        reader.addEventListener('load', () => {
            if (typeof reader.result !== 'string') {
                reject(new Error(`Could not read ${file.name}`))
                return
            }
            const separator = reader.result.indexOf(',')
            if (separator < 0) {
                reject(new Error(`Could not encode ${file.name}`))
                return
            }
            resolve({data: reader.result.slice(separator + 1), previewUrl: reader.result})
        })
        reader.readAsDataURL(file)
    })
}

function loadStoredChat(): StoredChat {
    if (typeof window === 'undefined') return {messages: [], agentMessages: []}
    try {
        const serialized = window.localStorage.getItem(CHAT_STORAGE_KEY)
        if (!serialized) return {messages: [], agentMessages: []}
        const parsed = JSON.parse(serialized) as unknown
        if (!isRecord(parsed)) return {messages: [], agentMessages: []}
        if (!Array.isArray(parsed['messages']) || !parsed['messages'].every(isStoredMessage)) {
            return {messages: [], agentMessages: []}
        }
        if (!Array.isArray(parsed['agentMessages'])) return {messages: [], agentMessages: []}
        return {messages: parsed['messages'], agentMessages: parsed['agentMessages']}
    } catch {
        return {messages: [], agentMessages: []}
    }
}

function normalizeSettings(settings: GoferSettings): GoferSettings {
    return {
        ...settings,
        ai: Object.assign(
            {
                modelName: settings.ai.model,
                contextWindow: 120_064,
                maxTokens: 120_064,
                reasoning: false,
                supportsReasoningEffort: false,
                input: ['text'],
                thinkingLevel: 'off',
                maxRetries: 2,
                timeoutMs: 120_000,
                systemPrompt: ''
            },
            settings.ai
        )
    }
}

function formatBytes(bytes: number) {
    if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GiB`
    if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`
    if (bytes === 0) return '0 bytes'
    return `${String(Math.round(bytes / 1024))} KiB`
}

function formatContextTokens(tokens: number) {
    const thousands = tokens / 1000
    const fractionDigits =
        thousands < 1 ? 2
        : thousands < 10 ? 1
        : 0
    const formatted = thousands.toFixed(fractionDigits)
    return `${fractionDigits === 0 ? formatted : formatted.replace(/\.?0+$/, '')}K`
}

function formatContextUsage(value: number, max: number) {
    return `${formatContextTokens(value)} / ${formatContextTokens(max)}`
}

function contextProgressVariant(value: number, max: number) {
    const usage = max > 0 ? value / max : 0
    if (usage <= 0.8) return 'success'
    if (usage <= 0.9) return 'warning'
    return 'error'
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

export function InitializationSplash({onReady}: {onReady: () => void}) {
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

        let unlisten: (() => void) | undefined

        try {
            unlisten = await listen<DownloadProgress>('rag-download-progress', event => {
                setState({status: 'initializing', progress: event.payload})
            })
            await invoke('initialize_rag')
            setState({status: 'ready'})
            onReady()
        } catch (error) {
            setState({status: 'error', message: String(error)})
        } finally {
            unlisten?.()
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

type NavigationProps = Readonly<{
    page: Page
    onNavigate: (page: Page) => void
    onNewTask: () => void
}>

function Navigation({page, onNavigate, onNewTask}: NavigationProps) {
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
                        onNewTask()
                    }}
                />
            </SideNavSection>
        </SideNav>
    )
}

function Welcome({composer}: {composer: ReactNode}) {
    return (
        <VStack
            gap={6}
            width='100%'
            maxWidth={720}
        >
            <VStack
                gap={1}
                hAlign='start'
            >
                <HStack
                    gap={2}
                    vAlign='center'
                >
                    <Icon
                        icon={SparklesIcon}
                        size='sm'
                        color='accent'
                    />
                    <Text type='large'>Gofer is ready</Text>
                </HStack>
                <Heading
                    level={1}
                    type='display-2'
                >
                    Where should we start?
                </Heading>
            </VStack>
            {composer}
        </VStack>
    )
}

export function Workspace() {
    const [storedChat] = useState(loadStoredChat)
    const [draft, setDraft] = useState('')
    const [draftAttachments, setDraftAttachments] = useState<readonly DraftAttachment[]>([])
    const [attachmentPreviews, setAttachmentPreviews] = useState<Readonly<Record<string, string>>>(
        {}
    )
    const [isSavingAttachments, setIsSavingAttachments] = useState(false)
    const [messages, setMessages] = useState<readonly Message[]>(storedChat.messages)
    const [isStreaming, setIsStreaming] = useState(false)
    const [streamError, setStreamError] = useState<string>()
    const [settings, setSettings] = useState<GoferSettings>()
    const [models, setModels] = useState<readonly AiModelOption[]>([])
    const [agentMessages, setAgentMessages] = useState<readonly unknown[]>(storedChat.agentMessages)
    const [connectionState, setConnectionState] = useState<'connecting' | 'connected' | 'offline'>(
        () => (isTauri() ? 'connecting' : 'offline')
    )
    const nextMessageId = useRef(Math.max(0, ...storedChat.messages.map(message => message.id)) + 1)
    const nextRequestId = useRef(1)
    const activeRequestId = useRef<number | undefined>(undefined)
    const attachmentInputRef = useRef<HTMLInputElement>(null)
    const messageScrollRef = useRef<HTMLElement>(null)
    const chatScroll = useChatStreamScroll({
        scrollRef: messageScrollRef,
        enabled: messages.length > 0
    })

    useEffect(() => {
        chatScroll.scrollIfLocked()
    }, [messages, chatScroll.scrollIfLocked])

    const applyModel = useCallback(async (model: AiModelOption, previous?: GoferSettings) => {
        if (!previous) return
        const nextSettings: GoferSettings = {
            ...previous,
            ai: {
                ...previous.ai,
                model: model.id,
                modelName: model.name,
                contextWindow: model.contextWindow,
                maxTokens: model.maxTokens,
                reasoning: model.reasoning,
                supportsReasoningEffort: model.supportsReasoningEffort,
                input: model.input,
                thinkingLevel: model.reasoning ? previous.ai.thinkingLevel : 'off'
            }
        }
        setSettings(nextSettings)
        try {
            await invoke('save_settings', {
                request: {settings: nextSettings, apiKey: {action: 'keep'}}
            })
            setStreamError(undefined)
        } catch (error) {
            setStreamError(`The model selection could not be saved: ${String(error)}`)
        }
    }, [])

    const applyThinkingLevel = useCallback(
        async (thinkingLevel: ThinkingLevel, previous?: GoferSettings) => {
            if (!previous) return
            const nextSettings: GoferSettings = {
                ...previous,
                ai: {
                    ...previous.ai,
                    thinkingLevel
                }
            }
            setSettings(nextSettings)
            try {
                await invoke('save_settings', {
                    request: {settings: nextSettings, apiKey: {action: 'keep'}}
                })
                setStreamError(undefined)
            } catch (error) {
                setStreamError(`The reasoning level could not be saved: ${String(error)}`)
            }
        },
        []
    )

    const connect = useCallback(async () => {
        if (!isTauri()) return
        await Promise.resolve()
        setConnectionState('connecting')
        setStreamError(undefined)
        try {
            const response = await invoke<SettingsResponse>('load_settings')
            const loadedSettings = normalizeSettings(response.settings)
            setSettings(loadedSettings)
            const available = await invoke<AiModelOption[]>('list_ai_models', {
                request: {settings: loadedSettings, apiKey: {action: 'keep'}}
            })
            setModels(available)
            setConnectionState('connected')
            if (
                available.length === 1
                && !available.some(model => model.id === loadedSettings.ai.model)
            ) {
                const onlyModel = available[0]
                if (onlyModel) await applyModel(onlyModel, loadedSettings)
            }
        } catch (error) {
            setConnectionState('offline')
            setStreamError(`Local AI is unavailable: ${String(error)}`)
        }
    }, [applyModel])

    useEffect(() => {
        const timeout = window.setTimeout(() => {
            void connect()
        }, 0)
        return () => {
            window.clearTimeout(timeout)
        }
    }, [connect])

    useEffect(() => {
        const hasAttachments = messages.some(message => Boolean(message.attachments?.length))
        let errorTimeout: number | undefined
        try {
            window.localStorage.setItem(
                CHAT_STORAGE_KEY,
                JSON.stringify({messages, agentMessages: hasAttachments ? [] : agentMessages})
            )
        } catch (error) {
            errorTimeout = window.setTimeout(() => {
                setStreamError(`Chat history could not be saved: ${String(error)}`)
            }, 0)
        }
        return () => {
            if (errorTimeout !== undefined) window.clearTimeout(errorTimeout)
        }
    }, [agentMessages, messages])

    useEffect(() => {
        if (!isTauri()) return
        const attachments = messages.flatMap(message => message.attachments ?? [])
        if (attachments.length === 0) return
        let isCancelled = false
        const load = async () => {
            const previews = await Promise.all(
                attachments.map(async attachment => {
                    try {
                        const preview = await invoke<string>('read_chat_attachment', {attachment})
                        return [attachment.id, preview] as const
                    } catch {
                        return undefined
                    }
                })
            )
            if (isCancelled) return
            setAttachmentPreviews(previous =>
                Object.fromEntries([
                    ...Object.entries(previous),
                    ...previews.filter(entry => entry !== undefined)
                ])
            )
        }
        void load()
        return () => {
            isCancelled = true
        }
    }, [messages])

    const updateAssistant = useCallback((id: number, update: (message: Message) => Message) => {
        setMessages(previous =>
            previous.map(message => (message.id === id ? update(message) : message))
        )
    }, [])

    const runRequest = useCallback(
        (
            prompt: string,
            history: readonly Message[],
            attachments: readonly ChatAttachment[] = []
        ) => {
            const userMessage: Message = {
                id: nextMessageId.current++,
                sender: 'user',
                text: prompt,
                timestamp: Date.now(),
                ...(attachments.length > 0 && {attachments})
            }
            const assistantMessage: Message = {
                id: nextMessageId.current++,
                sender: 'assistant',
                text: '',
                timestamp: Date.now(),
                tools: [],
                status: 'streaming'
            }
            const requestId = nextRequestId.current++
            const requestMessages = [...history, userMessage]

            activeRequestId.current = requestId
            setMessages([...history, userMessage, assistantMessage])
            setDraft('')
            setDraftAttachments([])
            setStreamError(undefined)
            setIsStreaming(true)

            const run = async () => {
                let unlisten: (() => void) | undefined
                try {
                    unlisten = await listen<AiStreamPayload>('ai-stream-event', received => {
                        if (received.payload.requestId !== requestId) return
                        const event = received.payload.event
                        if (event.type === 'text-delta') {
                            updateAssistant(assistantMessage.id, message => ({
                                ...message,
                                text: message.text + event.delta
                            }))
                        }
                        if (event.type === 'thinking-delta') {
                            updateAssistant(assistantMessage.id, message => ({
                                ...message,
                                thinking: (message.thinking ?? '') + event.delta
                            }))
                        }
                        if (event.type === 'tool-start') {
                            updateAssistant(assistantMessage.id, message => ({
                                ...message,
                                tools: [
                                    ...(message.tools ?? []),
                                    {
                                        id: event.id,
                                        name: event.name,
                                        status: 'running',
                                        startedAt: event.startedAt,
                                        ...(event.target && {target: event.target})
                                    }
                                ]
                            }))
                        }
                        if (event.type === 'tool-update' || event.type === 'tool-end') {
                            updateAssistant(assistantMessage.id, message => ({
                                ...message,
                                tools: (message.tools ?? []).map(tool =>
                                    tool.id === event.id ?
                                        {
                                            ...tool,
                                            output: event.output,
                                            ...(event.type === 'tool-end' && {
                                                status:
                                                    event.isError ?
                                                        ('error' as const)
                                                    :   ('complete' as const),
                                                endedAt: event.endedAt
                                            })
                                        }
                                    :   tool
                                )
                            }))
                        }
                        if (event.type === 'usage') {
                            updateAssistant(assistantMessage.id, message => ({
                                ...message,
                                usage: event.usage,
                                model: event.model
                            }))
                        }
                        if (event.type === 'done') {
                            setAgentMessages(event.agentMessages)
                            updateAssistant(assistantMessage.id, message => ({
                                ...message,
                                text: event.text || message.text,
                                usage: event.usage,
                                model: event.model,
                                status: 'complete',
                                ...((event.thinking || message.thinking) && {
                                    thinking: event.thinking || message.thinking
                                })
                            }))
                        }
                        if (event.type === 'aborted') {
                            updateAssistant(assistantMessage.id, message => ({
                                ...message,
                                text: message.text || 'Generation stopped.',
                                status: 'aborted'
                            }))
                        }
                    })
                    await invoke('send_ai_message', {
                        request: {
                            requestId,
                            agentMessages,
                            messages: requestMessages.map(message => ({
                                sender: message.sender,
                                text: message.text,
                                timestamp: message.timestamp,
                                attachments: message.attachments ?? []
                            }))
                        }
                    })
                } catch (error) {
                    const message = String(error)
                    setStreamError(message)
                    updateAssistant(assistantMessage.id, entry => ({
                        ...entry,
                        text: entry.text || 'The AI response could not be completed.',
                        status: 'error'
                    }))
                } finally {
                    unlisten?.()
                    if (activeRequestId.current === requestId) activeRequestId.current = undefined
                    setIsStreaming(false)
                }
            }
            void run()
        },
        [agentMessages, updateAssistant]
    )

    const submitMessage = async (value: string) => {
        const prompt = value.trim()
        if ((!prompt && draftAttachments.length === 0) || isStreaming || !isTauri()) return
        setIsSavingAttachments(true)
        setStreamError(undefined)
        try {
            await Promise.all(
                draftAttachments.map(attachment =>
                    invoke('save_chat_attachment', {
                        request: {
                            attachment: {
                                id: attachment.id,
                                name: attachment.name,
                                mimeType: attachment.mimeType,
                                size: attachment.size
                            },
                            data: attachment.data
                        }
                    })
                )
            )
            setAttachmentPreviews(previous => ({
                ...previous,
                ...Object.fromEntries(
                    draftAttachments.map(attachment => [attachment.id, attachment.previewUrl])
                )
            }))
            runRequest(
                prompt,
                messages,
                draftAttachments.map(attachment => ({
                    id: attachment.id,
                    name: attachment.name,
                    mimeType: attachment.mimeType,
                    size: attachment.size
                }))
            )
        } catch (error) {
            setStreamError(`The images could not be attached: ${String(error)}`)
        } finally {
            setIsSavingAttachments(false)
        }
    }

    const selectAttachments = async (files: FileList | null) => {
        if (!files) return
        const available = MAX_CHAT_ATTACHMENTS - draftAttachments.length
        const selected = Array.from(files).slice(0, available)
        const invalid = selected.find(
            file =>
                !CHAT_ATTACHMENT_TYPES.has(file.type)
                || file.size === 0
                || file.size > MAX_CHAT_ATTACHMENT_BYTES
        )
        if (files.length > available) {
            setStreamError(`You can attach up to ${String(MAX_CHAT_ATTACHMENTS)} images.`)
            return
        }
        if (invalid) {
            setStreamError(
                invalid.size === 0 ? `${invalid.name} is empty.`
                : CHAT_ATTACHMENT_TYPES.has(invalid.type) ? `${invalid.name} is larger than 10 MiB.`
                : `${invalid.name} is not a supported image.`
            )
            return
        }
        try {
            const attachments = await Promise.all(
                selected.map(async file => ({
                    id: crypto.randomUUID(),
                    name: file.name,
                    mimeType: file.type,
                    size: file.size,
                    ...(await attachmentData(file))
                }))
            )
            setDraftAttachments(previous => [...previous, ...attachments])
            setStreamError(undefined)
        } catch (error) {
            setStreamError(`The images could not be read: ${String(error)}`)
        } finally {
            if (attachmentInputRef.current) attachmentInputRef.current.value = ''
        }
    }

    const stop = () => {
        if (activeRequestId.current === undefined) return
        void invoke('cancel_ai_request', {requestId: activeRequestId.current})
    }

    const retry = (assistantId: number) => {
        const assistantIndex = messages.findIndex(message => message.id === assistantId)
        const userMessage = messages[assistantIndex - 1]
        if (assistantIndex < 1 || userMessage?.sender !== 'user') return
        runRequest(userMessage.text, messages.slice(0, assistantIndex - 1), userMessage.attachments)
    }

    const totalUsage = messages.reduce(
        (total, message) => total + (message.usage?.totalTokens ?? 0),
        0
    )
    const contextUsage = messages.reduce(
        (latest, message) => message.usage?.totalTokens ?? latest,
        0
    )
    const contextWindow = settings?.ai.contextWindow ?? 120_064
    const selectedModel = settings?.ai.modelName ?? settings?.ai.model ?? 'Loading model…'
    const thinkingLevel = settings?.ai.thinkingLevel ?? 'off'
    const thinkingLevels: readonly ThinkingLevel[] =
        settings?.ai.reasoning ?
            ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
        :   ['off']
    const supportsImages = Boolean(settings?.ai.input.includes('image'))
    const canAttachImages = supportsImages && !isStreaming && !isSavingAttachments && isTauri()

    const composer = (
        <VStack gap={1}>
            <input
                ref={attachmentInputRef}
                type='file'
                accept={CHAT_ATTACHMENT_ACCEPT}
                multiple
                hidden
                onChange={event => {
                    void selectAttachments(event.currentTarget.files)
                }}
            />
            <ChatComposer
                value={draft}
                onChange={setDraft}
                onSubmit={value => {
                    void submitMessage(value)
                }}
                onStop={stop}
                isStopShown={isStreaming}
                density='spacious'
                placeholder={
                    isSavingAttachments ? 'Attaching images…'
                    : isStreaming ?
                        'Gofer is working…'
                    :   'Ask anything'
                }
                drawer={
                    draftAttachments.length > 0 ?
                        <ChatComposerDrawer>
                            <HStack
                                gap={2}
                                wrap='wrap'
                            >
                                {draftAttachments.map(attachment => (
                                    <Thumbnail
                                        key={attachment.id}
                                        src={attachment.previewUrl}
                                        alt={`Attached image: ${attachment.name}`}
                                        label={attachment.name}
                                        isDisabled={isStreaming || isSavingAttachments}
                                        showRemoveOn='always'
                                        onRemove={() => {
                                            setDraftAttachments(previous =>
                                                previous.filter(item => item.id !== attachment.id)
                                            )
                                        }}
                                    />
                                ))}
                            </HStack>
                        </ChatComposerDrawer>
                    :   undefined
                }
                headerActions={
                    <Button
                        label='Attach images'
                        variant='ghost'
                        size='sm'
                        isIconOnly
                        icon={<Icon icon={PhotoIcon} />}
                        isDisabled={!canAttachImages}
                        tooltip={
                            supportsImages ? 'Attach up to 5 images' : (
                                'The selected model does not support image input'
                            )
                        }
                        onClick={() => {
                            attachmentInputRef.current?.click()
                        }}
                    />
                }
                input={
                    <ChatComposerInput
                        maxRows={8}
                        style={SPACIOUS_COMPOSER_INPUT_STYLE}
                        onKeyDown={event => {
                            if (
                                event.key !== 'Enter'
                                || event.shiftKey
                                || draft.trim()
                                || draftAttachments.length === 0
                                || event.nativeEvent.isComposing
                            ) {
                                return
                            }
                            event.preventDefault()
                            void submitMessage('')
                        }}
                    />
                }
                sendButton={
                    <ChatSendButton
                        isStopShown={isStreaming}
                        isDisabled={
                            isSavingAttachments || (!draft.trim() && draftAttachments.length === 0)
                        }
                        onSend={() => {
                            void submitMessage(draft)
                        }}
                        onStop={stop}
                    />
                }
                {...(streamError && {status: {type: 'error' as const, message: streamError}})}
            />
            <HStack
                gap={1}
                paddingInline={2}
                vAlign='center'
            >
                <DropdownMenu
                    button={{
                        label: `Model: ${selectedModel}`,
                        variant: 'ghost',
                        size: 'sm',
                        icon: (
                            <Icon
                                icon={SparklesIcon}
                                size='sm'
                                color='secondary'
                            />
                        ),
                        endContent: (
                            <Icon
                                icon='chevronDown'
                                size='sm'
                                color='secondary'
                            />
                        ),
                        children: (
                            <Text
                                type='supporting'
                                color='secondary'
                            >
                                Model: {selectedModel}
                            </Text>
                        )
                    }}
                    menuWidth={320}
                    items={models.map(model => ({
                        label: model.name,
                        onClick: () => {
                            void applyModel(model, settings)
                        }
                    }))}
                />
                <DropdownMenu
                    button={{
                        label: `Reasoning: ${thinkingLevel}`,
                        variant: 'ghost',
                        size: 'sm',
                        icon: (
                            <Icon
                                icon={Cog6ToothIcon}
                                size='sm'
                                color='secondary'
                            />
                        ),
                        endContent: (
                            <Icon
                                icon='chevronDown'
                                size='sm'
                                color='secondary'
                            />
                        ),
                        children: (
                            <Text
                                type='supporting'
                                color='secondary'
                            >
                                Reasoning: {thinkingLevel}
                            </Text>
                        )
                    }}
                    items={thinkingLevels.map(level => ({
                        label: level,
                        onClick: () => {
                            void applyThinkingLevel(level, settings)
                        }
                    }))}
                />
                <HStack
                    gap={2}
                    width={200}
                    vAlign='center'
                >
                    <StackItem size='fill'>
                        <ProgressBar
                            label='Context usage'
                            value={contextUsage}
                            max={contextWindow}
                            variant={contextProgressVariant(contextUsage, contextWindow)}
                            isLabelHidden
                        />
                    </StackItem>
                    <Text
                        type='supporting'
                        color='secondary'
                    >
                        {formatContextUsage(contextUsage, contextWindow)}
                    </Text>
                </HStack>
                <Text
                    type='supporting'
                    color='secondary'
                >
                    ·
                </Text>
                <Text
                    type='supporting'
                    color='secondary'
                >
                    {totalUsage.toLocaleString()} tokens
                </Text>
            </HStack>
        </VStack>
    )

    return (
        <Layout
            height='fill'
            contentWidth={960}
            content={
                <LayoutContent padding={0}>
                    <VStack
                        gap={0}
                        height='100%'
                    >
                        <HStack
                            padding={4}
                            hAlign='between'
                            vAlign='center'
                        >
                            <HStack
                                gap={3}
                                vAlign='center'
                            >
                                <Heading level={2}>New task</Heading>
                                <Token label='Godot 4.7' />
                            </HStack>
                            <HStack
                                gap={2}
                                vAlign='center'
                            >
                                <HStack
                                    gap={1}
                                    vAlign='center'
                                >
                                    <StatusDot
                                        variant={
                                            connectionState === 'connected' ? 'success'
                                            : connectionState === 'connecting' ?
                                                'warning'
                                            :   'error'
                                        }
                                        label={connectionState}
                                    />
                                    <Text type='supporting'>Local AI {connectionState}</Text>
                                </HStack>
                                {connectionState === 'offline' && (
                                    <Button
                                        label='Reconnect'
                                        variant='ghost'
                                        size='sm'
                                        icon={
                                            <Icon
                                                icon={ArrowPathIcon}
                                                size='sm'
                                            />
                                        }
                                        clickAction={connect}
                                    />
                                )}
                            </HStack>
                        </HStack>
                        <Divider />
                        <StackItem size='fill'>
                            {messages.length === 0 ?
                                <VStack
                                    height='100%'
                                    padding={8}
                                    hAlign='center'
                                    vAlign='center'
                                >
                                    <Welcome composer={composer} />
                                </VStack>
                            :   <VStack
                                    gap={0}
                                    height='100%'
                                >
                                    <StackItem
                                        ref={messageScrollRef}
                                        size='fill'
                                        isScrollable
                                        style={CHAT_SCROLL_VIEWPORT_STYLE}
                                    >
                                        <ChatMessageList
                                            density='spacious'
                                            isStreaming={isStreaming}
                                        >
                                            {messages.map(message => (
                                                <ChatMessage
                                                    key={message.id}
                                                    sender={message.sender}
                                                >
                                                    {message.sender === 'assistant'
                                                        && Boolean(message.tools?.length) && (
                                                            <ChatToolCalls
                                                                calls={(message.tools ?? []).map(
                                                                    tool => ({
                                                                        key: tool.id,
                                                                        name: tool.name,
                                                                        status: tool.status,
                                                                        ...(tool.target && {
                                                                            target: tool.target
                                                                        }),
                                                                        ...(tool.endedAt && {
                                                                            duration: `${String(tool.endedAt - tool.startedAt)}ms`
                                                                        }),
                                                                        ...(tool.status === 'error'
                                                                            && tool.output && {
                                                                                errorMessage:
                                                                                    tool.output
                                                                            }),
                                                                        ...(tool.output && {
                                                                            resultDetail: (
                                                                                <CodeBlock
                                                                                    code={
                                                                                        tool.output
                                                                                    }
                                                                                    language={
                                                                                        (
                                                                                            tool.name
                                                                                            === 'bash'
                                                                                        ) ?
                                                                                            'bash'
                                                                                        :   'text'
                                                                                    }
                                                                                />
                                                                            )
                                                                        })
                                                                    })
                                                                )}
                                                            />
                                                        )}
                                                    {message.sender === 'assistant'
                                                        && message.thinking && (
                                                            <ChatMessageBubble
                                                                variant='ghost'
                                                                name='Reasoning'
                                                            >
                                                                <Text color='secondary'>
                                                                    {message.thinking}
                                                                </Text>
                                                            </ChatMessageBubble>
                                                        )}
                                                    <ChatMessageBubble
                                                        variant={
                                                            message.sender === 'assistant' ?
                                                                'ghost'
                                                            :   'filled'
                                                        }
                                                        style={
                                                            message.sender === 'user' ?
                                                                LEFT_ALIGNED_USER_BUBBLE_STYLE
                                                            :   undefined
                                                        }
                                                        metadata={
                                                            message.sender === 'assistant' ?
                                                                <ChatMessageMetadata
                                                                    {...(message.status
                                                                        === 'error' && {
                                                                        status: 'error'
                                                                    })}
                                                                    footer={
                                                                        <HStack
                                                                            gap={2}
                                                                            vAlign='center'
                                                                        >
                                                                            {message.usage && (
                                                                                <Text
                                                                                    type='supporting'
                                                                                    color='secondary'
                                                                                >
                                                                                    {message.usage.input.toLocaleString()}{' '}
                                                                                    in ·{' '}
                                                                                    {message.usage.output.toLocaleString()}{' '}
                                                                                    out
                                                                                    {message.usage
                                                                                        .reasoning
                                                                                        !== undefined
                                                                                        && ` · ${message.usage.reasoning.toLocaleString()} reasoning`}
                                                                                </Text>
                                                                            )}
                                                                            {(message.status
                                                                                === 'error'
                                                                                || message.status
                                                                                    === 'aborted') && (
                                                                                <Button
                                                                                    label='Retry'
                                                                                    variant='ghost'
                                                                                    size='sm'
                                                                                    icon={
                                                                                        <Icon
                                                                                            icon={
                                                                                                ArrowPathIcon
                                                                                            }
                                                                                            size='sm'
                                                                                        />
                                                                                    }
                                                                                    clickAction={() => {
                                                                                        retry(
                                                                                            message.id
                                                                                        )
                                                                                    }}
                                                                                />
                                                                            )}
                                                                        </HStack>
                                                                    }
                                                                />
                                                            :   undefined
                                                        }
                                                    >
                                                        <VStack
                                                            gap={2}
                                                            hAlign='start'
                                                        >
                                                            {Boolean(
                                                                message.attachments?.length
                                                            ) && (
                                                                <HStack
                                                                    gap={2}
                                                                    wrap='wrap'
                                                                >
                                                                    {(
                                                                        message.attachments ?? []
                                                                    ).map(attachment => (
                                                                        <Thumbnail
                                                                            key={attachment.id}
                                                                            alt={`Attached image: ${attachment.name}`}
                                                                            label={attachment.name}
                                                                            {...(attachmentPreviews[
                                                                                attachment.id
                                                                            ] && {
                                                                                src: attachmentPreviews[
                                                                                    attachment.id
                                                                                ]
                                                                            })}
                                                                        />
                                                                    ))}
                                                                </HStack>
                                                            )}
                                                            {message.text ?
                                                                <Text>{message.text}</Text>
                                                            : message.sender === 'assistant' ?
                                                                <Spinner
                                                                    size='sm'
                                                                    label='Generating response'
                                                                />
                                                            :   undefined}
                                                        </VStack>
                                                    </ChatMessageBubble>
                                                </ChatMessage>
                                            ))}
                                        </ChatMessageList>
                                    </StackItem>
                                    <VStack
                                        width='100%'
                                        paddingInline={3}
                                        paddingBlock={3}
                                    >
                                        {composer}
                                    </VStack>
                                </VStack>
                            }
                        </StackItem>
                    </VStack>
                </LayoutContent>
            }
        />
    )
}

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
    const [availableModels, setAvailableModels] = useState<readonly AiModelOption[]>([])

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
            if (result.status === 'connected' || result.status === 'model-unavailable') {
                const models = await invoke<AiModelOption[]>('list_ai_models', {
                    request: nextRequest
                })
                setAvailableModels(models)
            }
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
        let unlisten: (() => void) | undefined
        try {
            unlisten = await listen<DownloadProgress>('rag-download-progress', event => {
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
                description: String(error)
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
                                                        ([
                                                            'off',
                                                            'minimal',
                                                            'low',
                                                            'medium',
                                                            'high',
                                                            'xhigh',
                                                            'max'
                                                        ] as const)
                                                    :   (['off'] as const)
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

export default function App() {
    const [page, setPage] = useState<Page>(() =>
        window.location.hash === '#settings' ? 'settings' : 'workspace'
    )
    const [workspaceKey, setWorkspaceKey] = useState(0)
    const [isReady, setIsReady] = useState(false)
    const showApplication = useCallback(() => {
        setIsReady(true)
    }, [])
    const prepareModels = useCallback(() => {
        setIsReady(false)
    }, [])
    const navigate = useCallback((nextPage: Page) => {
        window.history.pushState(undefined, '', `#${nextPage}`)
        setPage(nextPage)
    }, [])
    const newTask = useCallback(async () => {
        if (isTauri()) await invoke('clear_chat_attachments').catch(() => undefined)
        window.localStorage.removeItem(CHAT_STORAGE_KEY)
        setWorkspaceKey(previous => previous + 1)
        navigate('workspace')
    }, [navigate])

    useEffect(() => {
        const syncPageWithLocation = () => {
            setPage(window.location.hash === '#settings' ? 'settings' : 'workspace')
        }

        window.addEventListener('hashchange', syncPageWithLocation)
        window.addEventListener('popstate', syncPageWithLocation)
        return () => {
            window.removeEventListener('hashchange', syncPageWithLocation)
            window.removeEventListener('popstate', syncPageWithLocation)
        }
    }, [])

    if (!isReady) return <InitializationSplash onReady={showApplication} />

    return (
        <AppShell
            contentPadding={0}
            variant='section'
            sideNav={
                <Navigation
                    page={page}
                    onNavigate={navigate}
                    onNewTask={newTask}
                />
            }
        >
            <Workspace key={workspaceKey} />
            {page === 'settings' && (
                <SettingsPage
                    isOpen
                    onOpenChange={isOpen => {
                        if (!isOpen) navigate('workspace')
                    }}
                    onCacheDeleted={prepareModels}
                />
            )}
        </AppShell>
    )
}

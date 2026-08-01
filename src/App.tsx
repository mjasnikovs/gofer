import {Suspense, lazy, useCallback, useEffect, useRef, useState} from 'react'
import type {ReactNode} from 'react'
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
import {Divider} from '@astryxdesign/core/Divider'
import {DropdownMenu} from '@astryxdesign/core/DropdownMenu'
import {Icon} from '@astryxdesign/core/Icon'
import {Layout, LayoutContent} from '@astryxdesign/core/Layout'
import {NavIcon} from '@astryxdesign/core/NavIcon'
import {ProgressBar} from '@astryxdesign/core/ProgressBar'
import {SideNav, SideNavHeading, SideNavItem, SideNavSection} from '@astryxdesign/core/SideNav'
import {Spinner} from '@astryxdesign/core/Spinner'
import {HStack, StackItem, VStack} from '@astryxdesign/core/Stack'
import {StatusDot} from '@astryxdesign/core/StatusDot'
import {Heading, Text} from '@astryxdesign/core/Text'
import {Thumbnail} from '@astryxdesign/core/Thumbnail'
import {Token} from '@astryxdesign/core/Token'
import ArrowPathIcon from '@heroicons/react/24/outline/ArrowPathIcon'
import CircleStackIcon from '@heroicons/react/24/outline/CircleStackIcon'
import Cog6ToothIcon from '@heroicons/react/24/outline/Cog6ToothIcon'
import PhotoIcon from '@heroicons/react/24/outline/PhotoIcon'
import PlayIcon from '@heroicons/react/24/outline/PlayIcon'
import PlusIcon from '@heroicons/react/24/outline/PlusIcon'
import SparklesIcon from '@heroicons/react/24/outline/SparklesIcon'
import StopIcon from '@heroicons/react/24/outline/StopIcon'
import {invoke, isTauri} from '@tauri-apps/api/core'
import {listen} from '@tauri-apps/api/event'
import type {DownloadProgress} from '@mjasnikovs/gofer-rag'
import type {Page, TaskSummary} from './app-models'
import {
    ALL_THINKING_LEVELS,
    NO_THINKING_LEVELS,
    normalizeSettings,
    progressLabel,
    progressValue
} from './settings-models'
import type {AiModelOption, GoferSettings, SettingsResponse, ThinkingLevel} from './settings-models'

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

type StoredChat = Readonly<{
    taskId?: string
    messages: readonly Message[]
    agentMessages: readonly unknown[]
}>

type WorkspaceProps = Readonly<{
    activeTask?: TaskSummary
    onTasksChanged?: () => void
    onMergeTask?: () => Promise<void>
}>

type GodotProcessEvent = Readonly<{
    runId: string
    eventType: 'started' | 'line' | 'finished'
    level?: 'info' | 'warning' | 'error'
    message?: string
    exitCode?: number
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
const ToolOutputCodeBlock = lazy(() =>
    import('@astryxdesign/core/CodeBlock').then(module => ({default: module.CodeBlock}))
)

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

function loadLegacyChat(): StoredChat {
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

function isStoredChat(value: unknown): value is StoredChat {
    if (!isRecord(value)) return false
    return (
        (value['taskId'] === undefined || typeof value['taskId'] === 'string')
        && Array.isArray(value['messages'])
        && value['messages'].every(isStoredMessage)
        && Array.isArray(value['agentMessages'])
    )
}

function nextStoredMessageId(messages: readonly Message[]) {
    let maximumId = 0
    for (const message of messages) {
        if (message.id > maximumId) maximumId = message.id
    }
    return maximumId + 1
}

function messageUsage(messages: readonly Message[]) {
    let total = 0
    let context = 0
    for (const message of messages) {
        const tokens = message.usage?.totalTokens
        if (tokens === undefined) continue
        total += tokens
        context = tokens
    }
    return {total, context}
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

type NavigationProps = Readonly<{
    page: Page
    selectedTaskId?: string
    tasks: readonly TaskSummary[]
    onNavigate: (page: Page) => void
    onNewTask: () => void
    onOpenTask: (taskId: string) => void
}>

export function Navigation({
    page,
    selectedTaskId,
    tasks,
    onNavigate,
    onNewTask,
    onOpenTask
}: NavigationProps) {
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
                    headingHref='#/'
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
                        href='#/settings'
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
                    href='#/'
                    onClick={event => {
                        event.preventDefault()
                        onNewTask()
                    }}
                />
            </SideNavSection>
            {tasks.length > 0 && (
                <SideNavSection title='Tasks'>
                    {tasks.map(task => (
                        <SideNavItem
                            key={task.id}
                            label={task.title}
                            href={`#/tasks/${encodeURIComponent(task.id)}`}
                            isSelected={page === 'workspace' && task.id === selectedTaskId}
                            onClick={event => {
                                event.preventDefault()
                                onOpenTask(task.id)
                            }}
                        />
                    ))}
                </SideNavSection>
            )}
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

export function Workspace({activeTask, onTasksChanged, onMergeTask}: WorkspaceProps) {
    const [draft, setDraft] = useState('')
    const [draftAttachments, setDraftAttachments] = useState<readonly DraftAttachment[]>([])
    const [attachmentPreviews, setAttachmentPreviews] = useState<Readonly<Record<string, string>>>(
        {}
    )
    const [isSavingAttachments, setIsSavingAttachments] = useState(false)
    const [messages, setMessages] = useState<readonly Message[]>([])
    const [isChatLoaded, setIsChatLoaded] = useState(() => !isTauri())
    const [isStreaming, setIsStreaming] = useState(false)
    const [streamError, setStreamError] = useState<string>()
    const [settings, setSettings] = useState<GoferSettings>()
    const [models, setModels] = useState<readonly AiModelOption[]>([])
    const [agentMessages, setAgentMessages] = useState<readonly unknown[]>([])
    const [taskId, setTaskId] = useState<string>()
    const [isGodotRunning, setIsGodotRunning] = useState(false)
    const [connectionState, setConnectionState] = useState<'connecting' | 'connected' | 'offline'>(
        () => (isTauri() ? 'connecting' : 'offline')
    )
    const nextMessageId = useRef(1)
    const nextRequestId = useRef(1)
    const activeRequestId = useRef<number | undefined>(undefined)
    const requestedAttachmentPreviews = useRef(new Set<string>())
    const isWorkspaceMounted = useRef(false)
    const attachmentInputRef = useRef<HTMLInputElement>(null)
    const messageScrollRef = useRef<HTMLElement>(null)
    const chatScroll = useChatStreamScroll({
        scrollRef: messageScrollRef,
        enabled: messages.length > 0
    })

    useEffect(() => {
        isWorkspaceMounted.current = true
        return () => {
            isWorkspaceMounted.current = false
        }
    }, [])

    useEffect(() => {
        chatScroll.scrollIfLocked()
    }, [messages, chatScroll.scrollIfLocked])

    useEffect(() => {
        if (!isTauri()) return
        let isCancelled = false
        const load = async () => {
            try {
                const response = await invoke<unknown>('load_chat')
                const stored = isStoredChat(response) ? response : {messages: [], agentMessages: []}
                const legacy = loadLegacyChat()
                const chat =
                    (
                        stored.messages.length === 0
                        && stored.agentMessages.length === 0
                        && (legacy.messages.length > 0 || legacy.agentMessages.length > 0)
                    ) ?
                        await invoke<StoredChat>('import_legacy_chat', {chat: legacy})
                    :   stored
                if (isCancelled) return
                setMessages(chat.messages)
                setAgentMessages(chat.agentMessages)
                setTaskId(chat.taskId)
                nextMessageId.current = nextStoredMessageId(chat.messages)
                window.localStorage.removeItem(CHAT_STORAGE_KEY)
            } catch (error) {
                if (isCancelled) return
                const legacy = loadLegacyChat()
                setMessages(legacy.messages)
                setAgentMessages(legacy.agentMessages)
                nextMessageId.current = nextStoredMessageId(legacy.messages)
                setStreamError(`Chat history could not be loaded: ${String(error)}`)
            } finally {
                if (!isCancelled) setIsChatLoaded(true)
            }
        }
        void load()
        return () => {
            isCancelled = true
        }
    }, [])

    useEffect(() => {
        if (!isTauri()) return
        let isCancelled = false
        let unlisten: (() => void) | undefined
        void listen<GodotProcessEvent>('godot-process-event', event => {
            if (isCancelled) return
            if (event.payload.eventType === 'started') setIsGodotRunning(true)
            if (event.payload.eventType === 'finished') setIsGodotRunning(false)
            if (event.payload.level === 'error' && event.payload.message) {
                setStreamError(`Godot: ${event.payload.message}`)
            }
        }).then(dispose => {
            if (isCancelled) {
                dispose()
                return
            }
            unlisten = dispose
        })
        return () => {
            isCancelled = true
            unlisten?.()
        }
    }, [])

    const runGodot = useCallback(() => {
        setStreamError(undefined)
        void invoke('launch_godot', {request: {taskId, editor: false}}).catch((error: unknown) => {
            setIsGodotRunning(false)
            setStreamError(`Godot could not be launched: ${String(error)}`)
        })
    }, [taskId])

    const stopGodot = useCallback(() => {
        void invoke('cancel_godot').catch((error: unknown) => {
            setStreamError(`Godot could not be stopped: ${String(error)}`)
        })
    }, [])

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
        if (!isChatLoaded || !isTauri()) return
        let isCancelled = false
        const timeout = window.setTimeout(() => {
            void invoke('save_chat', {chat: {taskId, messages, agentMessages}})
                .then(() => {
                    onTasksChanged?.()
                })
                .catch((error: unknown) => {
                    if (!isCancelled)
                        setStreamError(`Chat history could not be saved: ${String(error)}`)
                })
        }, 150)
        return () => {
            isCancelled = true
            window.clearTimeout(timeout)
        }
    }, [agentMessages, isChatLoaded, messages, onTasksChanged, taskId])

    useEffect(() => {
        if (!isTauri()) return
        const attachments = messages.flatMap(message =>
            (message.attachments ?? []).filter(
                attachment => !requestedAttachmentPreviews.current.has(attachment.id)
            )
        )
        if (attachments.length === 0) return
        for (const attachment of attachments) requestedAttachmentPreviews.current.add(attachment.id)
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
            if (!isWorkspaceMounted.current) return
            setAttachmentPreviews(previous => {
                const next = {...previous}
                for (const entry of previews) {
                    if (entry) next[entry[0]] = entry[1]
                }
                return next
            })
        }
        void load()
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
                            taskId,
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
        [agentMessages, taskId, updateAssistant]
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

    const mergeTask = async () => {
        if (!onMergeTask) return
        setStreamError(undefined)
        try {
            await onMergeTask()
        } catch (error) {
            setStreamError(`The task could not be merged: ${String(error)}`)
        }
    }

    const retry = (assistantId: number) => {
        const assistantIndex = messages.findIndex(message => message.id === assistantId)
        const userMessage = messages[assistantIndex - 1]
        if (assistantIndex < 1 || userMessage?.sender !== 'user') return
        runRequest(userMessage.text, messages.slice(0, assistantIndex - 1), userMessage.attachments)
    }

    const usage = messageUsage(messages)
    const contextWindow = settings?.ai.contextWindow ?? 120_064
    const selectedModel = settings?.ai.modelName ?? settings?.ai.model ?? 'Loading model…'
    const thinkingLevel = settings?.ai.thinkingLevel ?? 'off'
    const thinkingLevels = settings?.ai.reasoning ? ALL_THINKING_LEVELS : NO_THINKING_LEVELS
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
                            value={usage.context}
                            max={contextWindow}
                            variant={contextProgressVariant(usage.context, contextWindow)}
                            isLabelHidden
                        />
                    </StackItem>
                    <Text
                        type='supporting'
                        color='secondary'
                    >
                        {formatContextUsage(usage.context, contextWindow)}
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
                    {usage.total.toLocaleString()} tokens
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
                                <Heading level={2}>{activeTask?.title ?? 'New task'}</Heading>
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
                                <Button
                                    label={isGodotRunning ? 'Stop Godot' : 'Run project'}
                                    variant={isGodotRunning ? 'destructive' : 'secondary'}
                                    size='sm'
                                    icon={
                                        <Icon
                                            icon={isGodotRunning ? StopIcon : PlayIcon}
                                            size='sm'
                                        />
                                    }
                                    clickAction={isGodotRunning ? stopGodot : runGodot}
                                />
                                {activeTask?.worktree && !activeTask.worktree.mergedCommit && (
                                    <Button
                                        label='Merge task'
                                        variant='secondary'
                                        size='sm'
                                        clickAction={mergeTask}
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
                                                                                <Suspense
                                                                                    fallback={
                                                                                        <Text>
                                                                                            {
                                                                                                tool.output
                                                                                            }
                                                                                        </Text>
                                                                                    }
                                                                                >
                                                                                    <ToolOutputCodeBlock
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
                                                                                </Suspense>
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

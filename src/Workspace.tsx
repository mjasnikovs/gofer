import {useCallback, useEffect, useRef, useState} from 'react'
import {useChatStreamScroll} from '@astryxdesign/core/Chat'
import {Divider} from '@astryxdesign/core/Divider'
import {Layout, LayoutContent} from '@astryxdesign/core/Layout'
import {StackItem, VStack} from '@astryxdesign/core/Stack'
import {invoke, isTauri} from '@tauri-apps/api/core'
import {listen} from '@tauri-apps/api/event'
import type {TaskSummary} from './app-models'
import type {
    AiStreamPayload,
    ChatAttachment,
    DraftAttachment,
    GodotProcessEvent,
    Message,
    StoredChat
} from './chat-models'
import {messageUsage} from './chat-format'
import {
    attachmentData,
    clearLegacyChat,
    isStoredChat,
    loadLegacyChat,
    nextStoredMessageId
} from './chat-storage'
import {ALL_THINKING_LEVELS, NO_THINKING_LEVELS, normalizeSettings} from './settings-models'
import type {AiModelOption, GoferSettings, SettingsResponse, ThinkingLevel} from './settings-models'
import {ChatConversation} from './ChatConversation'
import {WorkspaceComposer, WorkspaceWelcome} from './WorkspaceComposer'
import {WorkspaceHeader} from './WorkspaceHeader'

type WorkspaceProps = Readonly<{
    activeTask?: TaskSummary
    onTasksChanged?: () => void
    onMergeTask?: () => Promise<void>
}>

const CHAT_ATTACHMENT_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const MAX_CHAT_ATTACHMENTS = 5
const MAX_CHAT_ATTACHMENT_BYTES = 10 * 1024 * 1024

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
                clearLegacyChat()
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

    const removeAttachment = useCallback((attachmentId: string) => {
        setDraftAttachments(previous => previous.filter(item => item.id !== attachmentId))
    }, [])

    const composer = (
        <WorkspaceComposer
            attachmentInputRef={attachmentInputRef}
            canAttachImages={canAttachImages}
            contextWindow={contextWindow}
            draft={draft}
            draftAttachments={draftAttachments}
            isSavingAttachments={isSavingAttachments}
            isStreaming={isStreaming}
            models={models}
            selectedModel={selectedModel}
            supportsImages={supportsImages}
            thinkingLevel={thinkingLevel}
            thinkingLevels={thinkingLevels}
            usage={usage}
            onApplyModel={applyModel}
            onApplyThinkingLevel={applyThinkingLevel}
            onChangeDraft={setDraft}
            onRemoveAttachment={removeAttachment}
            onSelectAttachments={selectAttachments}
            onStop={stop}
            onSubmit={submitMessage}
            {...(settings && {settings})}
            {...(streamError && {streamError})}
        />
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
                        <WorkspaceHeader
                            connectionState={connectionState}
                            isGodotRunning={isGodotRunning}
                            onConnect={connect}
                            onMergeTask={() => {
                                void mergeTask()
                            }}
                            onRunGodot={runGodot}
                            onStopGodot={stopGodot}
                            {...(activeTask && {activeTask})}
                        />
                        <Divider />
                        <StackItem size='fill'>
                            {messages.length === 0 ?
                                <VStack
                                    height='100%'
                                    padding={8}
                                    hAlign='center'
                                    vAlign='center'
                                >
                                    <WorkspaceWelcome composer={composer} />
                                </VStack>
                            :   <VStack
                                    gap={0}
                                    height='100%'
                                >
                                    <ChatConversation
                                        attachmentPreviews={attachmentPreviews}
                                        isStreaming={isStreaming}
                                        messages={messages}
                                        scrollRef={messageScrollRef}
                                        onRetry={retry}
                                    />
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

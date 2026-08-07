import {useCallback, useEffect, useMemo, useRef, useState} from 'react'
import {useChatStreamScroll} from '@astryxdesign/core/Chat'
import {Divider} from '@astryxdesign/core/Divider'
import {StackItem, VStack} from '@astryxdesign/core/Stack'
import {invoke, isTauri} from '../../services/desktop'
import {sendAiMessage} from '../../services/ai-stream'
import {commandErrorMessage, toCommandError} from '../../utils/command-error'
import type {TaskSummary} from '../../models/app'
import type {AiStreamPayload, ChatAttachment, DraftAttachment, Message} from '../../models/chat'
import {compactionActivity, messageUsage} from '../../utils/chat-format'
import {attachmentData} from '../../services/chat-storage'
import {ALL_THINKING_LEVELS, NO_THINKING_LEVELS} from '../../models/settings'
import {useAiConnection} from '../../hooks/useAiConnection'
import {useAttachmentPreviews} from '../../hooks/useAttachmentPreviews'
import {useChatPersistence} from '../../hooks/useChatPersistence'
import {useToolApprovals} from '../../hooks/useToolApprovals'
import {ChatReferenceContext} from '../../hooks/useChatReferences'
import {ComposerContext} from '../../hooks/useComposer'
import type {Composer} from '../../hooks/useComposer'
import {appendReference} from '../../utils/chat-references'
import type {ChatReference} from '../../utils/chat-references'
import {ChatConversation} from './ChatConversation'
import {InspectorWorkspace} from './InspectorWorkspace'
import {ToolApprovalDialog} from './ToolApprovalDialog'
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
const DEFAULT_CONTEXT_WINDOW = 120_064
/** The chat column stays readable inside the frame's flexible center region. */
const CHAT_CONTENT_WIDTH = 960
/**
 * Centring the welcome overflows both ways in a short centre region, and a scroll container cannot
 * reach what overflows above it. `safe` falls back to start alignment exactly then.
 */
const SAFE_CENTRE = {justifyContent: 'safe center'} as const

/**
 * A turn that ends early takes its unfinished tool calls with it. The backend stops streaming the
 * moment it is cancelled, so no `tool-end` is ever coming for a call still in flight: left alone it
 * would spin forever and read as an agent that is still working.
 */
/**
 * Drops the label a long step was showing while it had nothing else to show.
 *
 * Whatever ended the turn ended the step with it, so a label left behind would describe work that
 * is no longer happening — which is the exact impression the label exists to prevent.
 */
function withoutActivity(message: Message): Message {
    if (message.activity === undefined) return message
    const {activity, ...rest} = message
    void activity
    return rest
}

function settleRunningTools(message: Message, reason: string): Message {
    if (!message.tools?.some(tool => tool.status === 'running' || tool.status === 'pending')) {
        return message
    }
    const endedAt = Date.now()
    return {
        ...message,
        tools: message.tools.map(tool =>
            tool.status === 'running' || tool.status === 'pending' ?
                {...tool, status: 'error' as const, output: tool.output ?? reason, endedAt}
            :   tool
        )
    }
}

export function Workspace({activeTask, onTasksChanged, onMergeTask}: WorkspaceProps) {
    const [draft, setDraft] = useState('')
    const [draftAttachments, setDraftAttachments] = useState<readonly DraftAttachment[]>([])
    const [isSavingAttachments, setIsSavingAttachments] = useState(false)
    const [isStreaming, setIsStreaming] = useState(false)
    const [streamError, setStreamError] = useState<string>()
    const nextRequestId = useRef(1)
    const activeRequestId = useRef<number | undefined>(undefined)
    const messageScrollRef = useRef<HTMLElement>(null)

    const reportError = useCallback((message: string) => {
        setStreamError(message)
    }, [])
    const clearError = useCallback(() => {
        setStreamError(undefined)
    }, [])

    const {
        messages,
        setMessages,
        agentMessages,
        setAgentMessages,
        taskId,
        takeMessageId,
        isChatLoaded,
        isMounted
    } = useChatPersistence({onError: reportError, onTasksChanged})
    const {attachmentPreviews, addPreviews} = useAttachmentPreviews({
        messages,
        isChatLoaded,
        isMounted
    })
    const {settings, models, connectionState, connect, applyModel, applyThinkingLevel} =
        useAiConnection({onError: reportError, onConnected: clearError})
    const {approvals, respond: respondToApproval} = useToolApprovals({onError: reportError})

    const chatScroll = useChatStreamScroll({
        scrollRef: messageScrollRef,
        enabled: messages.length > 0
    })

    const conversation = useRef(messages)
    useEffect(() => {
        conversation.current = messages
    }, [messages])

    useEffect(() => {
        chatScroll.scrollIfLocked()
    }, [messages, chatScroll.scrollIfLocked])

    const updateAssistant = useCallback(
        (id: number, update: (message: Message) => Message) => {
            setMessages(previous =>
                previous.map(message => (message.id === id ? update(message) : message))
            )
        },
        [setMessages]
    )

    const runRequest = useCallback(
        (
            prompt: string,
            history: readonly Message[],
            attachments: readonly ChatAttachment[] = []
        ) => {
            const userMessage: Message = {
                id: takeMessageId(),
                sender: 'user',
                text: prompt,
                timestamp: Date.now(),
                ...(attachments.length > 0 && {attachments})
            }
            const assistantMessage: Message = {
                id: takeMessageId(),
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

            const receive = (payload: AiStreamPayload) => {
                if (payload.requestId !== requestId) return
                const event = payload.event
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
                if (event.type === 'compaction-start') {
                    updateAssistant(assistantMessage.id, message => ({
                        ...message,
                        activity: compactionActivity(event.tokens, event.contextWindow)
                    }))
                }
                // Cleared rather than left to the first token, because a turn that answers with a
                // tool call produces no token to clear it, and the label would outlive the work.
                if (event.type === 'compaction-end') {
                    updateAssistant(assistantMessage.id, withoutActivity)
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
                        ...settleRunningTools(message, 'Stopped before it finished.'),
                        text: message.text || 'Generation stopped.',
                        status: 'aborted'
                    }))
                }
            }

            const run = async () => {
                try {
                    await sendAiMessage(
                        {
                            requestId,
                            taskId,
                            agentMessages,
                            messages: requestMessages.map(message => ({
                                sender: message.sender,
                                text: message.text,
                                timestamp: message.timestamp,
                                attachments: message.attachments ?? []
                            }))
                        },
                        receive
                    )
                } catch (error) {
                    const failure = toCommandError(error)
                    setStreamError(failure.message)
                    updateAssistant(assistantMessage.id, entry => ({
                        ...settleRunningTools(entry, 'The turn ended before this call finished.'),
                        // A turn refused because one was already running never reached the model,
                        // so the bubble says that rather than claiming an answer was attempted.
                        // That distinction is the whole point of the backend answering with a code
                        // instead of a sentence.
                        text:
                            entry.text
                            || (failure.code === 'ai_request_in_progress' ?
                                'Gofer is still working on the previous message.'
                            :   'The AI response could not be completed.'),
                        status: 'error'
                    }))
                } finally {
                    // The stream is over however it ended, so nothing it started can still be
                    // running — a `tool-end` the backend never sent is one it never will.
                    updateAssistant(assistantMessage.id, entry =>
                        withoutActivity(
                            settleRunningTools(entry, 'The turn ended before this call finished.')
                        )
                    )
                    if (activeRequestId.current === requestId) activeRequestId.current = undefined
                    setIsStreaming(false)
                }
            }
            void run()
        },
        [agentMessages, setAgentMessages, setMessages, takeMessageId, taskId, updateAssistant]
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
            addPreviews(
                Object.fromEntries(
                    draftAttachments.map(attachment => [attachment.id, attachment.previewUrl])
                )
            )
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
            setStreamError(`The images could not be attached: ${commandErrorMessage(error)}`)
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
            setStreamError(`The images could not be read: ${commandErrorMessage(error)}`)
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
            setStreamError(`The task could not be merged: ${commandErrorMessage(error)}`)
        }
    }

    /**
     * Retry is handed to every message in the conversation, so it has to keep its identity between
     * renders or `ConversationMessage`'s memo never holds: a callback redefined per token
     * re-renders the whole conversation per token. The history it replays comes from a ref rather
     * than from `messages`, which is a new array on every delta.
     */
    const retry = useCallback(
        (assistantId: number) => {
            const history = conversation.current
            const assistantIndex = history.findIndex(message => message.id === assistantId)
            const userMessage = history[assistantIndex - 1]
            if (assistantIndex < 1 || userMessage?.sender !== 'user') return
            runRequest(
                userMessage.text,
                history.slice(0, assistantIndex - 1),
                userMessage.attachments
            )
        },
        [runRequest]
    )

    const usage = messageUsage(messages)
    const supportsImages = Boolean(settings?.ai.input.includes('image'))

    const removeAttachment = useCallback((attachmentId: string) => {
        setDraftAttachments(previous => previous.filter(item => item.id !== attachmentId))
    }, [])

    const composerValue: Composer = {
        state: {
            draft,
            draftAttachments,
            selectedModel: settings?.ai.modelName ?? settings?.ai.model ?? 'Loading model…',
            thinkingLevel: settings?.ai.thinkingLevel ?? 'off',
            usage,
            ...(streamError && {streamError})
        },
        actions: {
            applyModel,
            applyThinkingLevel,
            changeDraft: setDraft,
            removeAttachment,
            selectAttachments,
            stop,
            submit: submitMessage
        },
        meta: {
            canAttachImages: supportsImages && !isStreaming && !isSavingAttachments && isTauri(),
            contextWindow: settings?.ai.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
            isSavingAttachments,
            isStreaming,
            models,
            supportsImages,
            thinkingLevels: settings?.ai.reasoning ? ALL_THINKING_LEVELS : NO_THINKING_LEVELS,
            ...(settings && {settings})
        }
    }

    // Every panel below the header can name what it shows in the message being written.
    const references = useMemo(
        () => ({
            add: (reference: ChatReference) => {
                setDraft(previous => appendReference(previous, reference))
            }
        }),
        []
    )

    const composer = <WorkspaceComposer />

    const chat =
        messages.length === 0 ?
            // The welcome scrolls: the centre region shares its height with the bottom panel, and a
            // short window would otherwise clip the greeting rather than let the user reach it.
            <StackItem
                size='fill'
                isScrollable
            >
                <VStack
                    height='100%'
                    padding={6}
                    hAlign='center'
                    vAlign='center'
                    style={SAFE_CENTRE}
                >
                    <WorkspaceWelcome composer={composer} />
                </VStack>
            </StackItem>
        :   <StackItem size='fill'>
                <VStack
                    gap={0}
                    height='100%'
                    maxWidth={CHAT_CONTENT_WIDTH}
                    hAlign='center'
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
            </StackItem>

    return (
        <ComposerContext value={composerValue}>
            <VStack
                gap={0}
                height='100%'
            >
                <WorkspaceHeader
                    connectionState={connectionState}
                    onConnect={connect}
                    onMergeTask={() => {
                        void mergeTask()
                    }}
                    {...(activeTask && {activeTask})}
                />
                <Divider />
                <StackItem size='fill'>
                    <ChatReferenceContext.Provider value={references}>
                        <InspectorWorkspace
                            chat={chat}
                            onError={reportError}
                        />
                    </ChatReferenceContext.Provider>
                </StackItem>
                <ToolApprovalDialog
                    onRespond={respondToApproval}
                    {...(approvals[0] && {prompt: approvals[0]})}
                />
            </VStack>
        </ComposerContext>
    )
}

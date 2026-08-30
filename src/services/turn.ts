import {nextStoredMessageId} from './chat-storage'
import {schedule} from './clock'
import {toCommandError} from '../utils/command-error'
import {
    applyStreamEvent,
    isAiStreamEvent,
    retryPlan,
    settleRunningTools,
    settleStoredChat,
    settleStreaming,
    withFallbackText,
    withoutActivity
} from '../models/chat-timeline'
import type {AiStreamPayload, ChatAttachment, Message, StoredChat} from '../models/chat'
import type {SendAiMessageRequest} from './desktop'

const UNFINISHED_TOOL_REASON = 'The turn ended before this call finished.'

export type TurnState = Readonly<{
    messages: readonly Message[]
    agentMessages: readonly unknown[]
    taskId?: string | undefined
    isStreaming: boolean
    error?: string
}>

export type TurnDependencies = Readonly<{
    send: (
        request: SendAiMessageRequest,
        receive: (payload: AiStreamPayload) => void
    ) => Promise<void>
    cancel: (requestId: number) => Promise<unknown>
}>

export type TurnRunner = Readonly<{
    state: () => TurnState
    subscribe: (listener: () => void) => () => void
    open: (chat: StoredChat) => void
    start: (prompt: string, attachments?: readonly ChatAttachment[]) => void
    retry: (assistantId: number) => void
    stop: () => void
}>

type PlannedTurn = Readonly<{
    conversation: readonly Message[]
    history: readonly Message[]
    prompt: Message
    assistantId: number
    isRetry: boolean
}>

const EMPTY: TurnState = {messages: [], agentMessages: [], isStreaming: false}

let nextRequestId = 1

export function createTurnRunner({send, cancel}: TurnDependencies): TurnRunner {
    let current: TurnState = EMPTY
    const listeners = new Set<() => void>()
    let nextMessageId = 1
    let activeRequestId: number | undefined

    const FRAME_MS = 16
    let isNotificationPending = false
    let cancelPendingNotification: (() => void) | undefined

    const notify = () => {
        isNotificationPending = false
        cancelPendingNotification?.()
        cancelPendingNotification = undefined
        for (const listener of [...listeners]) listener()
    }

    const publish = (next: TurnState) => {
        current = next
        notify()
    }

    const publishSoon = (next: TurnState) => {
        current = next
        if (isNotificationPending) return
        isNotificationPending = true
        cancelPendingNotification = schedule(notify, FRAME_MS)
    }

    const amend = (
        id: number,
        update: (message: Message) => Message,
        deliver: (next: TurnState) => void = publish
    ) => {
        deliver({
            ...current,
            messages: current.messages.map(message =>
                message.id === id ? update(message) : message
            )
        })
    }

    const takeMessageId = () => nextMessageId++

    const settle = (message: Message) =>
        withoutActivity(settleStreaming(settleRunningTools(message, UNFINISHED_TOOL_REASON)))

    const cleared = (state: TurnState): TurnState => {
        if (state.error === undefined) return state
        const {error, ...rest} = state
        void error
        return rest
    }

    const run = (turn: PlannedTurn) => {
        const requestId = nextRequestId++
        const requestMessages = [...turn.history, turn.prompt]
        const agentMessages = current.agentMessages

        activeRequestId = requestId
        publish({...cleared(current), messages: turn.conversation, isStreaming: true})

        const receive = (payload: AiStreamPayload) => {
            if (payload.requestId !== requestId) return
            if (!isAiStreamEvent(payload.event)) return
            const event = payload.event
            if (event.type === 'turn-state' || event.type === 'done') {
                publish({...current, agentMessages: event.agentMessages})
            }
            const isProseDelta = event.type === 'text-delta' || event.type === 'thinking-delta'
            amend(
                turn.assistantId,
                message => applyStreamEvent(message, event),
                isProseDelta ? publishSoon : publish
            )
        }

        const attempt = async () => {
            try {
                await send(
                    {
                        requestId,
                        taskId: current.taskId,
                        agentMessages,
                        isRetry: turn.isRetry,
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
                publish({...current, error: failure.message})
                const reason =
                    failure.code === 'ai_request_in_progress' ?
                        'Gofer is still working on the previous message.'
                    :   'The AI response could not be completed.'
                amend(turn.assistantId, message => ({
                    ...withFallbackText(
                        settleRunningTools(message, UNFINISHED_TOOL_REASON),
                        reason
                    ),
                    status: 'error'
                }))
            } finally {
                amend(turn.assistantId, settle)
                if (activeRequestId === requestId) activeRequestId = undefined
                publish({...current, isStreaming: false})
            }
        }
        void attempt()
    }

    return {
        state: () => current,
        subscribe(listener) {
            listeners.add(listener)
            return () => {
                listeners.delete(listener)
            }
        },
        open(chat) {
            nextMessageId = nextStoredMessageId(chat.messages)
            publish({
                messages: settleStoredChat(chat.messages),
                agentMessages: chat.agentMessages,
                ...(chat.taskId !== undefined && {taskId: chat.taskId}),
                isStreaming: false
            })
        },
        start(prompt, attachments = []) {
            const history = current.messages
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
                parts: [],
                status: 'streaming'
            }
            run({
                conversation: [...history, userMessage, assistantMessage],
                history,
                prompt: userMessage,
                assistantId: assistantMessage.id,
                isRetry: false
            })
        },
        retry(assistantId) {
            const plan = retryPlan(current.messages, assistantId)
            if (!plan) return
            run({
                conversation: plan.conversation,
                history: plan.history,
                prompt: plan.prompt,
                assistantId: plan.assistant.id,
                isRetry: true
            })
        },
        stop() {
            if (activeRequestId === undefined) return
            void cancel(activeRequestId)
        }
    }
}

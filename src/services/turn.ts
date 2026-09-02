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
    withoutActivity,
    withoutStatus
} from '../models/chat-timeline'
import type {
    AiStreamEvent,
    AiStreamPayload,
    ChatAttachment,
    Message,
    StoredChat
} from '../models/chat'
import type {CompactAiContextRequest, SendAiMessageRequest, SteerAiRequest} from './desktop'

const UNFINISHED_TOOL_REASON = 'The turn ended before this call finished.'

export type QueuedSteer = Readonly<{
    steerId: string
    requestId: number
    messageId: number
    text: string
}>

export type TurnState = Readonly<{
    messages: readonly Message[]
    agentMessages: readonly unknown[]
    queued: readonly QueuedSteer[]
    handBack: readonly string[]
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
    steer: (request: SteerAiRequest) => Promise<unknown>
    compact: (
        request: CompactAiContextRequest,
        receive: (payload: AiStreamPayload) => void
    ) => Promise<void>
}>

export type TurnRunner = Readonly<{
    state: () => TurnState
    subscribe: (listener: () => void) => () => void
    open: (chat: StoredChat) => void
    start: (prompt: string, attachments?: readonly ChatAttachment[]) => void
    queue: (prompt: string) => boolean
    takeHandBack: () => readonly string[]
    clearError: () => void
    retry: (assistantId: number) => void
    compact: () => Promise<void>
    stop: () => void
}>

type PlannedTurn = Readonly<{
    conversation: readonly Message[]
    history: readonly Message[]
    prompt: Message
    assistantId: number
    isRetry: boolean
}>

function isUnanswered(message: Message): boolean {
    return (
        message.text === ''
        && (message.parts?.length ?? 0) === 0
        && (message.tools?.length ?? 0) === 0
    )
}

const EMPTY: TurnState = {
    messages: [],
    agentMessages: [],
    queued: [],
    handBack: [],
    isStreaming: false
}

let nextRequestId = 1

export function createTurnRunner({send, cancel, steer, compact}: TurnDependencies): TurnRunner {
    let current: TurnState = EMPTY
    const listeners = new Set<() => void>()
    let nextMessageId = 1
    let activeRequestId: number | undefined
    let stoppedRequestId: number | undefined
    let nextSteerId = 1
    const takeSteerId = () => nextSteerId++

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

    // Offers back a message the turn never carried, so nothing typed is lost to a refusal or a stop.
    const drop = (steerId: string) => {
        const queued = current.queued.find(one => one.steerId === steerId)
        if (!queued) return
        publish({
            ...current,
            messages: current.messages.filter(message => message.id !== queued.messageId),
            queued: current.queued.filter(one => one.steerId !== steerId),
            handBack: [...current.handBack, queued.text]
        })
    }

    const settle = (message: Message) =>
        withoutActivity(settleStreaming(settleRunningTools(message, UNFINISHED_TOOL_REASON)))

    const cleared = (state: TurnState): TurnState => {
        if (state.error === undefined) return state
        const {error, ...rest} = state
        void error
        return rest
    }

    const streamingAssistant = (): Message => ({
        id: takeMessageId(),
        sender: 'assistant',
        text: '',
        timestamp: Date.now(),
        tools: [],
        parts: [],
        status: 'streaming'
    })

    const run = (turn: PlannedTurn) => {
        const requestId = nextRequestId++
        const requestMessages = [...turn.history, turn.prompt]
        const agentMessages = current.agentMessages
        // One turn now answers more than once: a steered message opens a fresh assistant beneath it.
        let assistantId = turn.assistantId

        activeRequestId = requestId
        publish({...cleared(current), messages: turn.conversation, isStreaming: true})

        // The steered message reached the model, so it stops being queued, and the answer it
        // interrupted settles. Its tools have all ended by this point, so nothing is errored.
        //
        // The message and its answer move to sit under the answer they interrupted, because a later
        // message still queued is already at the end and would otherwise come between the two.
        const injectSteer = (steerId: string) => {
            const queued = current.queued.find(one => one.steerId === steerId)
            if (!queued) return
            const taken = current.messages.find(message => message.id === queued.messageId)
            if (!taken) return
            const rest = current.messages.filter(message => message.id !== queued.messageId)
            const at = rest.findIndex(message => message.id === assistantId)
            const answering = rest[at]
            if (!answering) return
            const promoted = withoutStatus(taken)
            // Nothing was said before the steer arrived, so it takes the answer already open rather
            // than settling an empty one above it.
            const replacing =
                isUnanswered(answering) ?
                    [promoted, answering]
                :   [withoutActivity(settleStreaming(answering)), promoted, streamingAssistant()]
            publish({
                ...current,
                messages: [...rest.slice(0, at), ...replacing, ...rest.slice(at + 1)],
                queued: current.queued.filter(one => one.steerId !== steerId)
            })
            assistantId = replacing[replacing.length - 1]?.id ?? assistantId
        }

        const receive = (payload: AiStreamPayload) => {
            if (payload.requestId !== requestId) return
            if (!isAiStreamEvent(payload.event)) return
            const event = payload.event
            if (event.type === 'steered') {
                injectSteer(event.id)
                return
            }
            if (event.type === 'turn-state' || event.type === 'done') {
                publish({...current, agentMessages: event.agentMessages})
            }
            const isProseDelta = event.type === 'text-delta' || event.type === 'thinking-delta'
            amend(
                assistantId,
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
                amend(assistantId, message => ({
                    ...withFallbackText(
                        settleRunningTools(message, UNFINISHED_TOOL_REASON),
                        reason
                    ),
                    status: 'error'
                }))
            } finally {
                amend(assistantId, settle)
                if (activeRequestId === requestId) activeRequestId = undefined
                for (const left of current.queued.filter(one => one.requestId === requestId))
                    drop(left.steerId)
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
                queued: [],
                handBack: [],
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
        queue(prompt) {
            if (activeRequestId === undefined) return false
            const requestId = activeRequestId
            const steerId = `steer-${String(takeSteerId())}`
            const message: Message = {
                id: takeMessageId(),
                sender: 'user',
                text: prompt,
                timestamp: Date.now(),
                status: 'queued'
            }
            publish({
                ...current,
                messages: [...current.messages, message],
                queued: [
                    ...current.queued,
                    {steerId, requestId, messageId: message.id, text: prompt}
                ]
            })
            void steer({
                requestId,
                id: steerId,
                text: prompt,
                timestamp: message.timestamp,
                attachments: []
            }).catch((error: unknown) => {
                // Without this the bubble just disappears: the backend's sentence is the only
                // thing that says the message was refused rather than sent.
                publish({...current, error: toCommandError(error).message})
                drop(steerId)
            })
            return true
        },
        takeHandBack() {
            const taken = current.handBack
            if (taken.length > 0) publish({...current, handBack: []})
            return taken
        },
        clearError() {
            const dropped = cleared(current)
            if (dropped !== current) publish(dropped)
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
        // It runs as a turn because it is one: it holds the single provider connection, Stop
        // reaches it through the same registry, and a task switch has to stay locked while it does.
        async compact() {
            if (activeRequestId !== undefined) return
            const requestId = nextRequestId++
            const last = current.messages.at(-1)
            let done: Extract<AiStreamEvent, {type: 'compact-done'}> | undefined
            activeRequestId = requestId
            publish({...cleared(current), isStreaming: true})
            try {
                await compact(
                    {
                        requestId,
                        taskId: current.taskId,
                        agentMessages: current.agentMessages
                    },
                    payload => {
                        if (payload.requestId !== requestId) return
                        if (!isAiStreamEvent(payload.event)) return
                        if (payload.event.type === 'compact-done') done = payload.event
                    }
                )
            } catch (error) {
                publish({...current, isStreaming: false, error: toCommandError(error).message})
                return
            } finally {
                if (activeRequestId === requestId) activeRequestId = undefined
            }
            // A Stop is the user's own answer. Only a teardown that never answered needs saying,
            // because there the button looks like it did nothing.
            if (!done) {
                publish({
                    ...current,
                    isStreaming: false,
                    ...(stoppedRequestId !== requestId && {
                        error: 'The conversation was not summarised.'
                    })
                })
                return
            }
            const settled = done
            // Nothing was older than the retained tail, so there is no divider to draw and no
            // smaller context to report — only a sentence saying the click bought nothing.
            if (settled.summarised === 0 || !last) {
                publish({
                    ...current,
                    isStreaming: false,
                    error: 'Nothing in this conversation is old enough to summarise yet.'
                })
                return
            }
            publish({
                ...cleared(current),
                isStreaming: false,
                agentMessages: settled.agentMessages,
                messages: current.messages.map(message =>
                    message.id === last.id ?
                        {
                            ...message,
                            compaction: {
                                messages: settled.summarised,
                                tokensBefore: settled.tokensBefore,
                                tokensAfter: settled.tokensAfter
                            }
                        }
                    :   message
                )
            })
        },
        stop() {
            if (activeRequestId === undefined) return
            stoppedRequestId = activeRequestId
            void cancel(activeRequestId)
        }
    }
}

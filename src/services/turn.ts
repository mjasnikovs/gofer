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

/** What a call still in flight is told when the turn around it ended. */
const UNFINISHED_TOOL_REASON = 'The turn ended before this call finished.'

/**
 * The conversation and how it is doing.
 *
 * One value rather than four, because the four only ever make sense together: a message list with
 * a streaming flag from before it, or a transcript from a turn other than the one on screen, is the
 * desync every settle in this file exists to prevent.
 */
export type TurnState = Readonly<{
    /** Every message on screen, oldest first. */
    messages: readonly Message[]
    /** What the model is given as its memory. Not rendered, and not derivable from `messages`. */
    agentMessages: readonly unknown[]
    /** The task this conversation belongs to, once one has been opened. */
    taskId?: string | undefined
    /** Whether a turn is running right now. */
    isStreaming: boolean
    /** Why the last turn failed, if it did. Cleared by the next turn that starts. */
    error?: string
}>

/**
 * Everything the runner cannot do itself.
 *
 * Both are injected rather than imported so that a test drives a whole turn — crash, cancel,
 * retry — by handing over a `send` that emits a scripted list of events. That is the only seam
 * this module has, and it is the one its tests cross.
 */
export type TurnDependencies = Readonly<{
    /** Runs one turn, calling back with each event, settling when the turn ends however it ended. */
    send: (
        request: SendAiMessageRequest,
        receive: (payload: AiStreamPayload) => void
    ) => Promise<void>
    /** Asks the backend to stop the turn with this request id. Whatever it answers is advisory. */
    cancel: (requestId: number) => Promise<unknown>
}>

export type TurnRunner = Readonly<{
    /** The conversation as it stands. Stable by identity between changes. */
    state: () => TurnState
    /** Registers a listener for every change, and hands back the way to stop listening. */
    subscribe: (listener: () => void) => () => void
    /** Seeds the conversation from storage, settling whatever a previous window left running. */
    open: (chat: StoredChat) => void
    /** Appends a user turn and the reply being written, and runs it. */
    start: (prompt: string, attachments?: readonly ChatAttachment[]) => void
    /** Rewrites the last reply in place and runs it again. Does nothing if it is not retryable. */
    retry: (assistantId: number) => void
    /** Stops the running turn. Does nothing if none is running. */
    stop: () => void
}>

/** What one run of a turn needs decided before it starts. */
type PlannedTurn = Readonly<{
    /** The conversation while the turn runs: every message kept, the reply being written blank. */
    conversation: readonly Message[]
    /** Everything before the user turn, as the history the model is sent. */
    history: readonly Message[]
    /** The user turn being sent. */
    prompt: Message
    /** The id of the reply this turn writes into. */
    assistantId: number
    /** Whether this replaces a turn that already ran, so the worker rolls the failed one back. */
    isRetry: boolean
}>

const EMPTY: TurnState = {messages: [], agentMessages: [], isStreaming: false}

/**
 * The next request id, shared by every runner this process ever builds.
 *
 * Module scope rather than runner scope, because the backend cancels a turn by id and never clears
 * it: `cancel::CANCELLED_TURN` holds the last stopped id for the life of the process, deliberately,
 * so a tool thread that outlives its turn still reads its own cancellation. The workspace is keyed
 * on the task, so opening another task builds a new runner — and a counter that restarted at 1
 * handed the next turn the id of the stopped one. Every backend tool then answered its reachability
 * probe with `cancelled`, and the turn was refused before it started.
 */
let nextRequestId = 1

/**
 * The agent turn: what a conversation is, and what happens to it between a prompt and an answer.
 *
 * Owning the whole sequence is the point. The steps are individually simple and only correct in
 * order — the transcript is stored on `turn-state` as well as `done` so a turn that crashed still
 * leaves the model's memory holding what it did; unfinished tool calls are settled in `finally` so
 * an ending the backend never narrated does not leave a spinner running forever; a retry rewrites
 * one reply and shortens nothing, because the chat is saved by replacing every row of the task.
 * Every one of those was a bug before it was a line, and each was a bug about ordering rather than
 * about any single step.
 */
export function createTurnRunner({send, cancel}: TurnDependencies): TurnRunner {
    let current: TurnState = EMPTY
    const listeners = new Set<() => void>()
    let nextMessageId = 1
    let activeRequestId: number | undefined

    /*
     * A delta is folded into the state at once and told to the screen at most once a frame.
     *
     * The two are not the same job. `current` has to be exact the instant a delta lands, because a
     * reader that arrives between two deltas must not see a half-built reply — so every event is
     * applied immediately. Telling React is the expensive half: a notification rebuilds the
     * streaming message, re-parses its Markdown and re-lays the column, and a local model answers
     * far faster than a screen refreshes. Measured on a 40-delta-a-second stream, the notification
     * per delta cost 24% of a core; nothing above 60 a second is ever drawn.
     *
     * Only prose deltas are held. Anything that changes the shape of the turn — a call starting or
     * ending, the transcript, the end of the stream — notifies at once and takes the pending
     * delta with it, so no ordering a reader can observe is ever reordered.
     */
    const FRAME_MS = 16
    let isNotificationPending = false
    /** Calls off the frame a held delta is waiting for, so no timer outlives the state it carried. */
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

    /** Folds the change in now, and lets the screen hear about it on the next frame. */
    const publishSoon = (next: TurnState) => {
        current = next
        if (isNotificationPending) return
        isNotificationPending = true
        // The flag rather than the canceller is what holds a second delta back, because a clock
        // with no delay runs `notify` inside `schedule` and answers with a canceller for a frame
        // that has already happened. Left here it is called once and does nothing.
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

    /** Everything a turn leaves behind whatever ended it: nothing running, nothing streaming. */
    const settle = (message: Message) =>
        withoutActivity(settleStreaming(settleRunningTools(message, UNFINISHED_TOOL_REASON)))

    /** The state with the last failure dropped. A turn that starts clears the one before it. */
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
            // Anything the timeline does not recognise is dropped here rather than folded in. The
            // alternative was an undefined message reaching the renderer, and a render that throws
            // takes the window with it.
            if (!isAiStreamEvent(payload.event)) return
            const event = payload.event
            /*
             * The transcript is the one thing the message cannot carry, so it is stored here.
             *
             * `turn-state` arrives at every step of the turn and `done` only at a clean end, so a
             * turn that crashed, was stopped, or lost its worker still leaves the model's memory
             * holding what it had done. Storing it only on `done` was what let the conversation on
             * screen and the conversation the model was given drift apart.
             */
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
                // A turn refused because one was already running never reached the model, so the
                // bubble says that rather than claiming an answer was attempted. That distinction
                // is the whole point of the backend answering with a code instead of a sentence.
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
                // The stream is over however it ended, so nothing it started can still be running —
                // a `tool-end` the backend never sent is one it never will, and the same goes for
                // the `done` that would otherwise have ended the turn.
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

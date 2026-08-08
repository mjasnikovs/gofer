import type {AiStreamEvent, Message, MessagePart, TokenUsage} from './chat'
import {compactionActivity, rebuiltActivity} from '../utils/chat-format'

type ProseKind = 'text' | 'thinking'

/**
 * Grows the trailing run of prose instead of starting a new one, so the timeline holds one part per
 * uninterrupted stretch of writing rather than one per delta.
 */
function appendProse(
    parts: readonly MessagePart[],
    kind: ProseKind,
    delta: string
): readonly MessagePart[] {
    const last = parts.at(-1)
    if (last === undefined || last.kind === 'tool' || last.kind !== kind) {
        return [...parts, {kind, text: delta}]
    }
    return [...parts.slice(0, -1), {kind, text: last.text + delta}]
}

/**
 * The turn's steps in order, for messages that recorded them and for the ones stored before they
 * were recorded.
 *
 * The fallback rebuilds the layout those chats were displayed in — reasoning, then every tool call,
 * then the whole reply — because that is the only order their fields still support. It is not the
 * order the work happened in, and no new message takes this path.
 */
export function messageParts(message: Message): readonly MessagePart[] {
    if (message.parts) return message.parts
    const parts: MessagePart[] = []
    if (message.thinking) parts.push({kind: 'thinking', text: message.thinking})
    for (const tool of message.tools ?? []) parts.push({kind: 'tool', toolId: tool.id})
    if (message.text) parts.push({kind: 'text', text: message.text})
    return parts
}

/**
 * Drops the label a long step was showing while it had nothing else to show.
 *
 * Whatever ended the turn ended the step with it, so a label left behind would describe work that
 * is no longer happening — which is the exact impression the label exists to prevent.
 */
export function withoutActivity(message: Message): Message {
    if (message.activity === undefined) return message
    const {activity, ...rest} = message
    void activity
    return rest
}

/**
 * A turn that ends early takes its unfinished tool calls with it. The backend stops streaming the
 * moment it is cancelled, so no `tool-end` is ever coming for a call still in flight: left alone it
 * would spin forever and read as an agent that is still working.
 */
export function settleRunningTools(message: Message, reason: string): Message {
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

/**
 * Marks a turn ended once its stream is over.
 *
 * `done` and `aborted` each set a status, but neither is guaranteed to arrive — the backend can
 * return from a turn without emitting either. A message left `streaming` keeps its working
 * indicator for the rest of the session, which is the exact lie that indicator exists to prevent.
 */
export function settleStreaming(message: Message): Message {
    if (message.status !== 'streaming') return message
    return {...message, status: 'complete'}
}

/**
 * Gives a turn that produced no prose something to say, as its own step at the end of the timeline.
 *
 * Used for the endings the stream cannot narrate itself — a cancel, a refused request, a failure —
 * where the bubble would otherwise be an empty one under a row of tool calls.
 */
export function withFallbackText(message: Message, text: string): Message {
    if (message.text || !text) return message
    return {...message, text, parts: appendProse(messageParts(message), 'text', text)}
}

/**
 * Settles a conversation read back from disk.
 *
 * A turn is settled by the code that ran it, and a window that closed — or crashed — mid-turn never
 * ran that code. The reply stays on disk as `streaming`, and it comes back as a turn that is still
 * working: an indicator that never stops, and no Retry, because Retry is offered on a turn that
 * ended badly and this one never ended at all. Both of the chats found in the wild were in exactly
 * this state, and neither could be picked up again from inside the application.
 *
 * `aborted` is what it was: the turn stopped before it finished, and nothing is coming.
 */
export function settleStoredChat(messages: readonly Message[]): readonly Message[] {
    if (!messages.some(message => message.status === 'streaming')) return messages
    return messages.map(message =>
        message.status === 'streaming' ?
            {
                ...withoutActivity(
                    settleRunningTools(message, 'Gofer stopped before this call finished.')
                ),
                status: 'aborted' as const
            }
        :   message
    )
}

export type RetryPlan = Readonly<{
    /** The conversation while the turn runs again: every message kept, the failed reply blank. */
    conversation: readonly Message[]
    /** Everything before the user turn being replayed, as the request history. */
    history: readonly Message[]
    /** The user turn being replayed. It keeps its id and its attachments. */
    prompt: Message
    /** The reply being rewritten. It keeps its id, so no stored row is ever removed. */
    assistant: Message
}>

/**
 * What a retry does to the conversation: rewrite one reply in place, remove nothing.
 *
 * The reply keeps its id because the chat is saved by replacing every row of the task — a shorter
 * array is a delete, and a retry that dropped the pair and re-appended it deleted every turn below
 * it from the database with no way back.
 *
 * Only the last reply can be retried. Re-running an earlier turn is a branch, and a conversation
 * that shows one past answer while the model was sent another is the desync this whole file exists
 * to prevent. Returning nothing is what the button's absence is drawn from.
 */
export function retryPlan(
    messages: readonly Message[],
    assistantId: number
): RetryPlan | undefined {
    const index = messages.length - 1
    const assistant = messages[index]
    const prompt = messages[index - 1]
    if (assistant?.id !== assistantId || assistant.sender !== 'assistant') return undefined
    if (prompt?.sender !== 'user') return undefined
    const blank: Message = {
        id: assistant.id,
        sender: 'assistant',
        text: '',
        timestamp: Date.now(),
        tools: [],
        parts: [],
        status: 'streaming'
    }
    return {
        conversation: [...messages.slice(0, index), blank],
        history: messages.slice(0, index - 1),
        prompt,
        assistant: blank
    }
}

/** The streamed value if the stream produced one, the final message's if it did not, else nothing. */
function streamedOr(streamed: string | undefined, final: string): string | undefined {
    if (streamed) return streamed
    if (final) return final
    return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null
}

function isText(value: unknown): value is string {
    return typeof value === 'string'
}

function isCount(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value)
}

/**
 * The parts of a usage report the conversation renders without asking whether they are there.
 *
 * Deliberately narrower than `TokenUsage`: the fields nothing reads are not worth dropping a real
 * event over, and the fields something reads are worth refusing. `input` and `output` are printed
 * straight into the turn's footer, so a report missing either used to throw inside a render.
 */
function isRenderableUsage(value: unknown): value is TokenUsage {
    if (!isRecord(value)) return false
    return (
        isCount(value['input'])
        && isCount(value['output'])
        && isCount(value['totalTokens'])
        && (value['reasoning'] === undefined || isCount(value['reasoning']))
    )
}

/**
 * Whether a payload from the backend is an event this file can fold in.
 *
 * The stream crosses a process boundary, and what arrives is whatever the worker wrote — a renamed
 * field, an event from a newer build, a half-written line. `applyStreamEvent` is total over the
 * events it knows and undefined over everything else, and an undefined message rendered as Markdown
 * threw during a render, which unmounted the entire window. So the switch is guarded rather than
 * trusted, and anything unrecognised is dropped instead of drawn.
 */
export function isAiStreamEvent(value: unknown): value is AiStreamEvent {
    if (!isRecord(value)) return false
    switch (value['type']) {
        case 'text-delta':
        case 'thinking-delta':
            return isText(value['delta'])
        case 'tool-start':
            return (
                isText(value['id'])
                && isText(value['name'])
                && isCount(value['startedAt'])
                && (value['target'] === undefined || isText(value['target']))
            )
        case 'tool-update':
            return isText(value['id']) && isText(value['output'])
        case 'tool-end':
            return (
                isText(value['id'])
                && isText(value['output'])
                && typeof value['isError'] === 'boolean'
                && isCount(value['endedAt'])
            )
        case 'usage':
            return isRenderableUsage(value['usage']) && isText(value['model'])
        case 'compaction-start':
            return isCount(value['tokens']) && isCount(value['contextWindow'])
        case 'compaction-end':
        case 'aborted':
            return true
        case 'turn-state':
            return Array.isArray(value['agentMessages'])
        case 'context-rebuilt':
            return isCount(value['messages'])
        case 'done':
            return (
                isText(value['text'])
                && isText(value['thinking'])
                && isRenderableUsage(value['usage'])
                && isText(value['model'])
                && Array.isArray(value['agentMessages'])
            )
        default:
            return false
    }
}

/**
 * Folds one backend stream event into the assistant message on screen.
 *
 * Pure and total: every event type is handled here, and the caller keeps only the side effects it
 * cannot express as a message — storing the agent transcript, clearing the streaming flag.
 */
export function applyStreamEvent(message: Message, event: AiStreamEvent): Message {
    const parts = messageParts(message)
    switch (event.type) {
        case 'text-delta':
            return {
                ...message,
                text: message.text + event.delta,
                parts: appendProse(parts, 'text', event.delta)
            }
        case 'thinking-delta':
            return {
                ...message,
                thinking: (message.thinking ?? '') + event.delta,
                parts: appendProse(parts, 'thinking', event.delta)
            }
        case 'tool-start':
            return {
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
                ],
                parts: [...parts, {kind: 'tool', toolId: event.id}]
            }
        case 'tool-update':
        case 'tool-end':
            return {
                ...message,
                tools: (message.tools ?? []).map(tool =>
                    tool.id === event.id ?
                        {
                            ...tool,
                            output: event.output,
                            ...(event.type === 'tool-end' && {
                                status: event.isError ? ('error' as const) : ('complete' as const),
                                endedAt: event.endedAt
                            })
                        }
                    :   tool
                )
            }
        case 'usage':
            return {...message, usage: event.usage, model: event.model}
        case 'compaction-start':
            return {...message, activity: compactionActivity(event.tokens, event.contextWindow)}
        // Cleared rather than left to the first token, because a turn that answers with a tool call
        // produces no token to clear it, and the label would outlive the work.
        case 'compaction-end':
            return withoutActivity(message)
        // `event.text` is the last assistant message of the turn, not the turn — the backend takes
        // it from the final `turn_end`, and a turn that called tools has one `turn_end` per step.
        // Preferring it would throw away everything the agent said before its last step, so the
        // streamed deltas win and it is only the fallback for a turn that streamed none.
        case 'done': {
            const thinking = streamedOr(message.thinking, event.thinking)
            return {
                ...withFallbackText(message, event.text),
                usage: event.usage,
                model: event.model,
                status: 'complete',
                ...(thinking !== undefined && {thinking})
            }
        }
        // The transcript is the caller's to store; the message on screen does not hold it.
        case 'turn-state':
            return message
        // Said in the caption the turn already has for what it is doing, and dropped with it when
        // the turn ends — the same place, and the same lifetime, as the compaction notice.
        case 'context-rebuilt':
            return {...message, activity: rebuiltActivity(event.messages)}
        case 'aborted':
            return {
                ...withFallbackText(
                    settleRunningTools(message, 'Stopped before it finished.'),
                    'Generation stopped.'
                ),
                status: 'aborted'
            }
    }
}

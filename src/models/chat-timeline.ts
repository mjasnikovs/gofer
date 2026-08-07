import type {AiStreamEvent, Message, MessagePart} from './chat'
import {compactionActivity} from '../utils/chat-format'

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

/** The streamed value if the stream produced one, the final message's if it did not, else nothing. */
function streamedOr(streamed: string | undefined, final: string): string | undefined {
    if (streamed) return streamed
    if (final) return final
    return undefined
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

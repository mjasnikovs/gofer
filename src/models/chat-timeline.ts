import type {AiStreamEvent, Message, MessagePart, TokenUsage, ToolActivity} from './chat'
import {
    compactionActivity,
    rebuiltActivity,
    retryActivity,
    retryWaitActivity
} from '../utils/chat-format'

type ProseKind = 'text' | 'thinking'

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

export function messageParts(message: Message): readonly MessagePart[] {
    if (message.parts) return message.parts
    const parts: MessagePart[] = []
    if (message.thinking) parts.push({kind: 'thinking', text: message.thinking})
    for (const tool of message.tools ?? []) parts.push({kind: 'tool', toolId: tool.id})
    if (message.text) parts.push({kind: 'text', text: message.text})
    return parts
}

export function withoutActivity(message: Message): Message {
    if (message.activity === undefined) return message
    const {activity, ...rest} = message
    void activity
    return rest
}

export function settleRunningTools(message: Message, reason: string): Message {
    if (!message.tools?.some(tool => tool.status === 'running' || tool.status === 'pending')) {
        return message
    }
    const endedAt = Date.now()
    const settled = (output?: string) => (output === undefined ? reason : `${output}\n\n${reason}`)
    return {
        ...message,
        tools: message.tools.map(tool =>
            tool.status === 'running' || tool.status === 'pending' ?
                {...tool, status: 'error' as const, output: settled(tool.output), endedAt}
            :   tool
        )
    }
}

export function settleStreaming(message: Message): Message {
    if (message.status !== 'streaming') return message
    return {...message, status: 'complete'}
}

export function withFallbackText(message: Message, text: string): Message {
    if (message.text || !text) return message
    return {...message, text, parts: appendProse(messageParts(message), 'text', text)}
}

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
    conversation: readonly Message[]
    history: readonly Message[]
    prompt: Message
    assistant: Message
}>

function proseOf(parts: readonly MessagePart[], kind: ProseKind) {
    let prose = ''
    for (const part of parts) if (part.kind === kind) prose += part.text
    return prose
}

function reopenedReply(assistant: Message): Message {
    const parts = messageParts(assistant)
    let end = parts.length
    while (end > 0 && parts[end - 1]?.kind !== 'tool') end -= 1
    const kept = parts.slice(0, end)
    const keptToolIds = new Set(kept.filter(part => part.kind === 'tool').map(part => part.toolId))
    const thinking = proseOf(kept, 'thinking')
    return {
        ...assistant,
        text: proseOf(kept, 'text'),
        ...(thinking ? {thinking} : {}),
        tools: (assistant.tools ?? []).filter(tool => keptToolIds.has(tool.id)),
        parts: kept,
        status: 'streaming'
    }
}

export function retryPlan(
    messages: readonly Message[],
    assistantId: number
): RetryPlan | undefined {
    const index = messages.length - 1
    const assistant = messages[index]
    const prompt = messages[index - 1]
    if (assistant?.id !== assistantId || assistant.sender !== 'assistant') return undefined
    if (prompt?.sender !== 'user') return undefined
    const reopened = reopenedReply(assistant)
    return {
        conversation: [...messages.slice(0, index), reopened],
        history: messages.slice(0, index - 1),
        prompt,
        assistant: reopened
    }
}

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

function isRenderableUsage(value: unknown): value is TokenUsage {
    if (!isRecord(value)) return false
    return (
        isCount(value['input'])
        && isCount(value['output'])
        && isCount(value['totalTokens'])
        && (value['reasoning'] === undefined || isCount(value['reasoning']))
    )
}

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
            return (
                isText(value['id'])
                && isText(value['output'])
                && (value['step'] === undefined || isText(value['step']))
            )
        case 'tool-end':
            return (
                isText(value['id'])
                && isText(value['output'])
                && typeof value['isError'] === 'boolean'
                && isCount(value['endedAt'])
            )
        case 'usage':
            return isRenderableUsage(value['usage']) && isText(value['model'])
        case 'tool-cost':
            return (
                Array.isArray(value['ids'])
                && value['ids'].every(isText)
                && isCount(value['tokens'])
            )
        case 'compaction-start':
            return isCount(value['tokens']) && isCount(value['contextWindow'])
        case 'compact-done':
            return (
                Array.isArray(value['agentMessages'])
                && isCount(value['summarised'])
                && isCount(value['tokensBefore'])
                && isCount(value['tokensAfter'])
            )
        case 'compaction-end':
        case 'aborted':
            return true
        case 'steered':
            return isText(value['id'])
        case 'turn-state':
            return Array.isArray(value['agentMessages'])
        case 'context-rebuilt':
            return isCount(value['messages'])
        case 'retry-scheduled':
            return (
                isCount(value['attempt'])
                && isCount(value['maxAttempts'])
                && isCount(value['delayMs'])
                && isText(value['errorMessage'])
            )
        case 'retry-start':
            return isCount(value['attempt']) && isCount(value['maxAttempts'])
        case 'done':
            return (
                isText(value['text'])
                && isText(value['thinking'])
                && (value['stopReason'] === undefined || isText(value['stopReason']))
                && isRenderableUsage(value['usage'])
                && isText(value['model'])
                && Array.isArray(value['agentMessages'])
            )
        case 'verify-point':
            return (
                isText(value['name'])
                && isText(value['command'])
                && (value['status'] === 'running'
                    || value['status'] === 'complete'
                    || value['status'] === 'error')
            )
        default:
            return false
    }
}

export function withoutStatus(message: Message): Message {
    if (message.status === undefined) return message
    const {status: _dropped, ...rest} = message
    return rest
}

function withoutStep(tool: ToolActivity): ToolActivity {
    if (tool.step === undefined) return tool
    const {step: _dropped, ...rest} = tool
    return rest
}

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
                tools: (message.tools ?? []).map(tool => {
                    if (tool.id !== event.id) return tool
                    if (event.type === 'tool-update')
                        return {
                            ...tool,
                            output: event.output,
                            ...(event.step !== undefined && {step: event.step})
                        }
                    return {
                        ...withoutStep(tool),
                        output: event.output,
                        status: event.isError ? ('error' as const) : ('complete' as const),
                        endedAt: event.endedAt
                    }
                })
            }
        case 'usage':
            return {...message, usage: event.usage, model: event.model}
        case 'tool-cost': {
            if (event.ids.length === 0) return message
            const share = Math.floor(event.tokens / event.ids.length)
            const first = event.tokens - share * (event.ids.length - 1)
            return {
                ...message,
                tools: (message.tools ?? []).map(tool => {
                    const index = event.ids.indexOf(tool.id)
                    if (index === -1) return tool
                    return {...tool, tokens: index === 0 ? first : share}
                })
            }
        }
        case 'compaction-start':
            return {...message, activity: compactionActivity(event.tokens, event.contextWindow)}
        // A manual compaction has no assistant message of its own to change; the runner reads
        // compact-done off the stream and stamps the divider itself.
        case 'compaction-end':
        case 'compact-done':
            return withoutActivity(message)
        case 'done': {
            const thinking = streamedOr(message.thinking, event.thinking)
            return {
                ...withoutActivity(
                    withFallbackText(
                        event.stopReason === 'aborted' ?
                            settleRunningTools(message, 'Stopped before it finished.')
                        :   message,
                        event.text
                    )
                ),
                usage: event.usage,
                model: event.model,
                status: event.stopReason === 'aborted' ? 'aborted' : 'complete',
                ...(thinking !== undefined && {thinking})
            }
        }
        case 'verify-point': {
            const point = {
                name: event.name,
                command: event.command,
                status: event.status,
                ...(event.output !== undefined && event.output !== '' && {output: event.output})
            }
            const points = message.verifyPoints ?? []
            const at = points.findIndex(existing => existing.name === event.name)
            return {
                ...message,
                verifyPoints:
                    at < 0 ?
                        [...points, point]
                    :   [...points.slice(0, at), point, ...points.slice(at + 1)]
            }
        }
        case 'turn-state':
            return message
        case 'context-rebuilt':
            return {...message, activity: rebuiltActivity(event.messages)}
        case 'retry-scheduled':
            return {
                ...message,
                activity: retryWaitActivity(
                    event.attempt,
                    event.maxAttempts,
                    event.delayMs,
                    event.errorMessage
                )
            }
        case 'retry-start':
            return {...message, activity: retryActivity(event.attempt, event.maxAttempts)}
        case 'aborted':
            return {
                ...withoutActivity(
                    withFallbackText(
                        settleRunningTools(message, 'Stopped before it finished.'),
                        'Generation stopped.'
                    )
                ),
                status: 'aborted'
            }
        // Not an amendment to one assistant message: the runner splits the timeline on it.
        case 'steered':
            return message
    }
}

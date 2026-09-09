import {turnState} from './ai-events.mjs'

export function withoutTrailingAnswer(messages) {
    return messages.at(-1)?.role === 'assistant' ? messages.slice(0, -1) : messages
}

export function createTranscript(agent, emit) {
    return {
        messages: () => agent.state.messages,

        checkpoint: () => {
            emit(turnState(agent.state.messages))
        },

        replaceWith: compacted => {
            agent.state.messages = compacted
            return compacted
        },

        dropTrailingAnswer: () => {
            agent.state.messages = withoutTrailingAnswer(agent.state.messages)
            return agent.state.messages
        }
    }
}

function namesOnlyAnOperation(entry) {
    return (
        typeof entry === 'object'
        && entry !== null
        && !Array.isArray(entry)
        && Object.keys(entry).length === 1
        && typeof entry.op === 'string'
    )
}

function heldNothing(call) {
    const args = call.arguments
    if (typeof args !== 'object' || args === null || Array.isArray(args)) return false
    const entries = Array.isArray(args.ops) ? args.ops : [args]
    return entries.length > 0 && entries.every(namesOnlyAnOperation)
}

// An operation that needs no parameters is legitimately written as `{op}`, so the shape alone is
// not the defect. Our own refusal saying which parameter is missing is.
const REFUSED_FOR_EMPTINESS = /missing_param|has now refused this exact call/u

function refusedForEmptiness(result) {
    if (result.isError !== true) return false
    const said = (result.content ?? [])
        .filter(part => part.type === 'text')
        .map(part => part.text)
        .join(' ')
    return REFUSED_FOR_EMPTINESS.test(said)
}

/**
 * The model reads its own failures and copies them. An operation named with every parameter
 * missing is refused, the pair stays in the history, and the next call is likelier to be empty
 * still. Deleting the pair is what stops it: 7/10 empty turns became 0/10 on the same task.
 *
 * This runs as `transformContext`, on every request. The agent loop works from its own copy of
 * the context, so assigning `agent.state.messages` mid-run reaches nothing the model will read.
 */
export function withoutEmptyToolCalls(messages) {
    const dropped = new Set()
    for (const message of messages) {
        if (message.role !== 'assistant' || !Array.isArray(message.content)) continue
        const calls = message.content.filter(part => part.type === 'toolCall')
        if (calls.length === 0 || !calls.every(heldNothing)) continue
        const results = messages.filter(
            other => other.role === 'toolResult' && calls.some(call => call.id === other.toolCallId)
        )
        if (results.length !== calls.length || !results.every(refusedForEmptiness)) continue
        dropped.add(message)
        for (const result of results) dropped.add(result)
    }
    return dropped.size === 0 ? messages : messages.filter(message => !dropped.has(message))
}

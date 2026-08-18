import type {Message} from '../models/chat'

export function messageUsage(messages: readonly Message[]) {
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

export function formatContextUsage(value: number, max: number) {
    return `${formatContextTokens(value)} / ${formatContextTokens(max)}`
}

/**
 * What the spinner says while the conversation is being summarised.
 *
 * The two numbers are the reason the wait exists, and they are the difference between a spinner
 * that looks stuck and one that is visibly working through a known amount.
 */
export function compactionActivity(tokens: number, contextWindow: number) {
    return `Summarising the conversation to make room (${formatContextUsage(tokens, contextWindow)})`
}

/**
 * Says that this turn started from the conversation on screen rather than from the model's own
 * memory of it, which happens when a task's memory was lost with a turn that never finished.
 */
export function rebuiltActivity(messages: number) {
    return `Rebuilt this conversation from the ${messages.toLocaleString()} message${
        messages === 1 ? '' : 's'
    } on screen`
}

/**
 * What the spinner says between a dropped turn and the next attempt at it.
 *
 * The countdown and the attempt number are the whole point: a turn that goes quiet for a minute
 * and a turn that has died look identical, and this is the one thing that tells them apart. The
 * cause is said too, because a model that keeps refusing for the same reason is worth seeing.
 */
export function retryWaitActivity(
    attempt: number,
    maxAttempts: number,
    delayMs: number,
    reason: string
) {
    const seconds = Math.max(1, Math.round(delayMs / 1000))
    const because = reason.trim() ? ` — ${reason.trim()}` : ''
    return `Model unavailable. Trying again in ${String(seconds)}s (${String(attempt)} of ${String(maxAttempts)})${because}`
}

/** What the spinner says once the wait is over and the model is being asked again. */
export function retryActivity(attempt: number, maxAttempts: number) {
    return `Trying again (${String(attempt)} of ${String(maxAttempts)})`
}

export function contextProgressVariant(value: number, max: number) {
    const usage = max > 0 ? value / max : 0
    if (usage <= 0.8) return 'success'
    if (usage <= 0.9) return 'warning'
    return 'error'
}

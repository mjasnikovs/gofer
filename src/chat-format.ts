import type {Message} from './chat-models'

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

export function contextProgressVariant(value: number, max: number) {
    const usage = max > 0 ? value / max : 0
    if (usage <= 0.8) return 'success'
    if (usage <= 0.9) return 'warning'
    return 'error'
}

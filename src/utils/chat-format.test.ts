import {describe, expect, it} from 'vitest'
import {
    compactionActivity,
    contextProgressVariant,
    formatContextUsage,
    messageUsage
} from './chat-format'
import type {Message, TokenUsage} from '../models/chat'

const WINDOW = 120_064

function usage(totalTokens: number): TokenUsage {
    return {
        input: totalTokens - 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens,
        cost: {total: 0}
    }
}

function answered(id: number, totalTokens: number): Message {
    return {id, sender: 'assistant', text: 'answer', timestamp: id, usage: usage(totalTokens)}
}

describe('context usage', () => {
    /**
     * Gofer does not compact: every turn resends the whole conversation, so what the last turn
     * cost is what the next one starts from. A conversation that outgrows the window dies there —
     * the model answers a token or two with `finish_reason: length` — and the readout is the only
     * warning the user gets before that happens, so it has to be the number that hits the wall
     * rather than a running total of everything spent.
     */
    it('reads the last turn rather than the sum of the session', () => {
        const messages = [answered(1, 4_000), answered(2, 9_000), answered(3, 21_000)]
        expect(messageUsage(messages)).toEqual({total: 34_000, context: 21_000})
    })

    it('ignores turns that reported no usage rather than counting them as free', () => {
        const streaming: Message = {id: 4, sender: 'assistant', text: '', timestamp: 4}
        expect(messageUsage([answered(1, 4_000), streaming]).context).toBe(4_000)
        expect(messageUsage([]).context).toBe(0)
    })

    /**
     * The live sweep that found this had the model answering "I" and "Let" nine times in a row at
     * 116,449 tokens of a 120,064-token window. The bar has to have left green well before that.
     */
    it('warns before the wall and not on it', () => {
        expect(contextProgressVariant(21_000, WINDOW)).toBe('success')
        expect(contextProgressVariant(96_051, WINDOW)).toBe('success')
        expect(contextProgressVariant(96_052, WINDOW)).toBe('warning')
        expect(contextProgressVariant(108_058, WINDOW)).toBe('error')
        expect(contextProgressVariant(116_449, WINDOW)).toBe('error')
    })

    /** A window nothing reported is not a full one. */
    it('does not read an unknown window as spent', () => {
        expect(contextProgressVariant(0, 0)).toBe('success')
    })

    it('reads as a size rather than as six digits', () => {
        expect(formatContextUsage(116_449, WINDOW)).toBe('116K / 120K')
        expect(formatContextUsage(4_200, WINDOW)).toBe('4.2K / 120K')
        expect(formatContextUsage(120, WINDOW)).toBe('0.12K / 120K')
    })
})

describe('compaction activity', () => {
    /**
     * The label carries the two numbers because they are what tells the user the wait is bounded.
     * Without them it is a spinner with a sentence on it, which is what it already was.
     */
    it('names the wait and how much conversation it is working through', () => {
        expect(compactionActivity(105_000, 120_064)).toBe(
            'Summarising the conversation to make room (105K / 120K)'
        )
    })
})

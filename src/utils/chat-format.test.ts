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
    it('reads the last turn rather than the sum of the session', () => {
        const messages = [answered(1, 4_000), answered(2, 9_000), answered(3, 21_000)]
        expect(messageUsage(messages)).toEqual({total: 34_000, context: 21_000})
    })

    it('ignores turns that reported no usage rather than counting them as free', () => {
        const streaming: Message = {id: 4, sender: 'assistant', text: '', timestamp: 4}
        expect(messageUsage([answered(1, 4_000), streaming]).context).toBe(4_000)
        expect(messageUsage([]).context).toBe(0)
    })

    it('warns before the wall and not on it', () => {
        expect(contextProgressVariant(21_000, WINDOW)).toBe('success')
        expect(contextProgressVariant(96_051, WINDOW)).toBe('success')
        expect(contextProgressVariant(96_052, WINDOW)).toBe('warning')
        expect(contextProgressVariant(108_058, WINDOW)).toBe('error')
        expect(contextProgressVariant(116_449, WINDOW)).toBe('error')
    })

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
    it('names the wait and how much conversation it is working through', () => {
        expect(compactionActivity(105_000, 120_064)).toBe(
            'Summarising the conversation to make room (105K / 120K)'
        )
    })
})

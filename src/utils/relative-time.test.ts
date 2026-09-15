import {describe, expect, it, vi} from 'vitest'
import {MINUTE_MS, relativeTime} from './relative-time'

const NOW = 1_700_000_000_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

describe('relativeTime', () => {
    it('reads a time under a minute old as just now', () => {
        expect(relativeTime(NOW - 30_000, NOW)).toBe('just now')
    })

    it('counts whole minutes', () => {
        expect(relativeTime(NOW - 5 * MINUTE_MS, NOW)).toBe('5 minutes ago')
    })

    it('counts a day and a bit as a day, not as yesterday, which may be two dates back', () => {
        expect(relativeTime(NOW - 26 * HOUR_MS, NOW)).toBe('1 day ago')
    })

    it('counts weeks before months', () => {
        expect(relativeTime(NOW - 15 * DAY_MS, NOW)).toBe('2 weeks ago')
    })

    it('counts a year as a year, not as last year', () => {
        expect(relativeTime(NOW - 400 * DAY_MS, NOW)).toBe('1 year ago')
    })

    it('reads a time ahead of the clock as just now', () => {
        expect(relativeTime(NOW + 10 * MINUTE_MS, NOW)).toBe('just now')
    })

    it('speaks English on a machine set to another language, with one formatter for every card', async () => {
        const native = Intl.RelativeTimeFormat
        let built = 0
        class GermanMachine extends native {
            constructor(locales?: Intl.LocalesArgument, options?: Intl.RelativeTimeFormatOptions) {
                built += 1
                super(locales ?? 'de', options)
            }
        }
        Object.defineProperty(Intl, 'RelativeTimeFormat', {
            value: GermanMachine,
            configurable: true
        })
        vi.resetModules()
        try {
            const fresh = await import('./relative-time')
            expect(fresh.relativeTime(NOW - 5 * MINUTE_MS, NOW)).toBe('5 minutes ago')
            fresh.relativeTime(NOW - 10 * MINUTE_MS, NOW)
            expect(built).toBe(1)
        } finally {
            Object.defineProperty(Intl, 'RelativeTimeFormat', {value: native, configurable: true})
        }
    })
})

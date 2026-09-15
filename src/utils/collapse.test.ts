import {describe, expect, it} from 'vitest'
import {settleCollapse} from './collapse'

describe('settleCollapse', () => {
    it('collapses once the content overflows, and remembers the width it took', () => {
        const needed = {current: 0}
        expect(settleCollapse(false, {available: 620, content: 1072}, needed)).toBe(true)
        expect(needed.current).toBe(1072)
    })

    it('keeps content that fits', () => {
        const needed = {current: 0}
        expect(settleCollapse(false, {available: 1400, content: 1400}, needed)).toBe(false)
    })

    it('stays collapsed while there is less room than the content needed', () => {
        const needed = {current: 1072}
        expect(settleCollapse(true, {available: 1071, content: 900}, needed)).toBe(true)
        expect(needed.current).toBe(1072)
    })

    it('expands again once the width it needed is there', () => {
        const needed = {current: 1072}
        expect(settleCollapse(true, {available: 1072, content: 900}, needed)).toBe(false)
    })
})

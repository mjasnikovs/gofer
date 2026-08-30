import {describe, expect, it, vi} from 'vitest'
import {rememberValue} from './interface-state'
import type {InterfaceStateStore} from './interface-state'

type Store = InterfaceStateStore
    & Readonly<{
        writes: (readonly [string, unknown])[]
        reads: Record<string, number>
        settle: () => void
    }>

function store(stored: Record<string, unknown> = {}): Store {
    const values = new Map(Object.entries(stored))
    const writes: (readonly [string, unknown])[] = []
    const reads: Record<string, number> = {}
    const waiting: (() => void)[] = []
    return {
        writes,
        reads,
        settle: () => {
            for (const release of waiting.splice(0)) release()
        },
        read: async key => {
            reads[key] = (reads[key] ?? 0) + 1
            await new Promise<void>(resolve => waiting.push(resolve))
            return values.get(key)
        },
        write: (key, value) => {
            values.set(key, value)
            writes.push([key, value])
        }
    }
}

const asText = (stored: unknown) => (typeof stored === 'string' ? stored : '')

describe('rememberValue', () => {
    it('is closed until the key has answered', async () => {
        const backing = store({'ui.draft.a': 'hello'})
        const remembered = rememberValue(backing, {restore: asText})

        const opening = remembered.open('ui.draft.a')
        expect(remembered.state()).toEqual({isOpen: false})

        backing.settle()
        await opening
        expect(remembered.state()).toEqual({isOpen: true, value: 'hello'})
    })

    it('refuses to record anything while the read is still in flight', async () => {
        const backing = store({'ui.draft.a': 'half a sentence'})
        const remembered = rememberValue(backing, {restore: asText})

        const opening = remembered.open('ui.draft.a')
        remembered.change('what the empty composer holds')

        expect(backing.writes).toEqual([])
        backing.settle()
        await opening
        expect(remembered.state()).toEqual({isOpen: true, value: 'half a sentence'})
    })

    it('reads a key once however many times it is opened', async () => {
        const backing = store()
        const remembered = rememberValue(backing, {restore: asText})

        const opening = Promise.all([remembered.open('ui.sideNav'), remembered.open('ui.sideNav')])
        backing.settle()
        await opening
        await remembered.open('ui.sideNav')

        expect(backing.reads['ui.sideNav']).toBe(1)
    })

    it('records a change under the key it was opened on', async () => {
        const backing = store()
        const remembered = rememberValue(backing, {restore: asText})
        const opening = remembered.open('ui.draft.a')
        backing.settle()
        await opening

        remembered.change('typed')

        expect(backing.writes).toEqual([['ui.draft.a', 'typed']])
        expect(remembered.state()).toEqual({isOpen: true, value: 'typed'})
    })

    it('writes nothing when the change is the value it already holds', async () => {
        const backing = store({'ui.draft.a': 'typed'})
        const remembered = rememberValue(backing, {restore: asText})
        const opening = remembered.open('ui.draft.a')
        backing.settle()
        await opening

        remembered.change('typed')

        expect(backing.writes).toEqual([])
    })

    it('forgets a key rather than storing an empty value', async () => {
        const backing = store({'ui.draft.a': 'typed'})
        const remembered = rememberValue(backing, {
            restore: asText,
            isEmpty: value => value === ''
        })
        const opening = remembered.open('ui.draft.a')
        backing.settle()
        await opening

        remembered.change('')

        expect(backing.writes).toEqual([['ui.draft.a', undefined]])
    })

    it('takes an updater, so a caller need not hold what it is appending to', async () => {
        const backing = store({'ui.draft.a': 'look at '})
        const remembered = rememberValue(backing, {restore: asText})
        const opening = remembered.open('ui.draft.a')
        backing.settle()
        await opening

        remembered.change(previous => `${previous}res://main.tscn`)

        expect(remembered.state()).toEqual({isOpen: true, value: 'look at res://main.tscn'})
    })

    describe('changing keys', () => {
        it('closes while the new key is being read', async () => {
            const backing = store({'ui.draft.a': 'one', 'ui.draft.b': 'two'})
            const remembered = rememberValue(backing, {restore: asText})
            const first = remembered.open('ui.draft.a')
            backing.settle()
            await first

            const second = remembered.open('ui.draft.b')
            expect(remembered.state()).toEqual({isOpen: false})

            backing.settle()
            await second
            expect(remembered.state()).toEqual({isOpen: true, value: 'two'})
        })

        it('never saves one key’s value under another key’s name', async () => {
            const backing = store({'ui.draft.a': 'one', 'ui.draft.b': 'two'})
            const remembered = rememberValue(backing, {restore: asText})
            const first = remembered.open('ui.draft.a')
            backing.settle()
            await first

            const second = remembered.open('ui.draft.b')
            remembered.change('one, still being written')
            backing.settle()
            await second

            expect(backing.writes).toEqual([])
            expect(remembered.state()).toEqual({isOpen: true, value: 'two'})
        })

        it('drops a read that lands after the key has moved on', async () => {
            const backing = store({'ui.draft.a': 'one', 'ui.draft.b': 'two'})
            const remembered = rememberValue(backing, {restore: asText})

            const first = remembered.open('ui.draft.a')
            const second = remembered.open('ui.draft.b')
            backing.settle()
            await Promise.all([first, second])

            expect(remembered.state()).toEqual({isOpen: true, value: 'two'})
        })
    })

    describe('with nowhere to remember it', () => {
        it('opens on the default at once', async () => {
            const backing = store()
            const remembered = rememberValue(backing, {restore: asText})

            await remembered.open(undefined)

            expect(remembered.state()).toEqual({isOpen: true, value: ''})
            expect(backing.reads).toEqual({})
        })

        it('keeps what it is given without writing it anywhere', async () => {
            const backing = store()
            const remembered = rememberValue(backing, {restore: asText})
            await remembered.open(undefined)

            remembered.change('typed before the task loaded')

            expect(remembered.state()).toEqual({
                isOpen: true,
                value: 'typed before the task loaded'
            })
            expect(backing.writes).toEqual([])
        })
    })

    describe('subscribe', () => {
        it('stops telling a listener that has stopped listening', async () => {
            const backing = store()
            const remembered = rememberValue(backing, {restore: asText})
            const listener = vi.fn()
            const unsubscribe = remembered.subscribe(listener)

            const opening = remembered.open('ui.sideNav')
            backing.settle()
            await opening
            expect(listener).toHaveBeenCalledTimes(1)

            unsubscribe()
            remembered.change('moved')
            expect(listener).toHaveBeenCalledTimes(1)
        })
    })
})

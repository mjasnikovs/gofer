import {describe, expect, it, vi} from 'vitest'
import {createRememberedLayout, type LayoutStore} from './remembered-layout'
import {SCRIPT_VIEWS_KEY, WORKSPACE_LAYOUT_KEY} from './ui-state'
import {EXPLORER_MAX, EXPLORER_MIN} from '../models/ui-state'

type Store = LayoutStore
    & Readonly<{
        /** Every write in order, so a test can assert what was recorded and what was not. */
        writes: (readonly [string, unknown])[]
        /** How many reads each key has taken. */
        reads: Record<string, number>
    }>

/**
 * The project's state held in a Map.
 *
 * `read` is a promise that has already settled rather than a value, because the real one is a call
 * into the database — and the gap between mounting and that call answering is the whole reason
 * this module exists.
 */
function store(stored: Record<string, unknown> = {}): Store {
    const values = new Map(Object.entries(stored))
    const writes: (readonly [string, unknown])[] = []
    const reads: Record<string, number> = {}
    return {
        writes,
        reads,
        read: async key => {
            reads[key] = (reads[key] ?? 0) + 1
            return values.get(key)
        },
        write: (key, value) => {
            values.set(key, value)
            writes.push([key, value])
        }
    }
}

describe('createRememberedLayout', () => {
    it('is closed until the project has answered', async () => {
        const remembered = createRememberedLayout(store())

        expect(remembered.state()).toEqual({isOpen: false})

        await remembered.open()
        expect(remembered.state().isOpen).toBe(true)
    })

    it('refuses to record anything before the project has been read', () => {
        const backing = store({[WORKSPACE_LAYOUT_KEY]: {centerTab: 'game'}})
        const remembered = createRememberedLayout(backing)

        remembered.dispatch({type: 'center-tab', tab: 'docs'})

        expect(backing.writes).toEqual([])
    })

    it('reads the project once however many times it is opened', async () => {
        const backing = store()
        const remembered = createRememberedLayout(backing)

        await Promise.all([remembered.open(), remembered.open()])
        await remembered.open()

        expect(backing.reads[WORKSPACE_LAYOUT_KEY]).toBe(1)
    })

    describe('opening', () => {
        it('clamps a width the responsive contract no longer allows', async () => {
            const remembered = createRememberedLayout(
                store({[WORKSPACE_LAYOUT_KEY]: {explorerWidth: 10_000}})
            )

            await remembered.open()

            const state = remembered.state()
            expect(state.isOpen && state.layout.explorerWidth).toBe(EXPLORER_MAX)
        })

        it('falls back per field rather than discarding the whole layout', async () => {
            const remembered = createRememberedLayout(
                store({
                    [WORKSPACE_LAYOUT_KEY]: {centerTab: 'scripts', explorerTab: 'from-the-future'}
                })
            )

            await remembered.open()

            const state = remembered.state()
            expect(state.isOpen && state.layout.centerTab).toBe('scripts')
            expect(state.isOpen && state.layout.explorerTab).toBe('scene')
        })

        it('drops the cursor of a script that is not being reopened', async () => {
            const remembered = createRememberedLayout(
                store({
                    [WORKSPACE_LAYOUT_KEY]: {openScripts: ['a.gd']},
                    [SCRIPT_VIEWS_KEY]: {'a.gd': {line: 1}, 'gone.gd': {line: 2}}
                })
            )

            await remembered.open()

            const state = remembered.state()
            expect(state.isOpen && state.views).toEqual({'a.gd': {line: 1}})
        })
    })

    describe('recording a change', () => {
        it('writes the layout when it genuinely moved', async () => {
            const backing = store()
            const remembered = createRememberedLayout(backing)
            await remembered.open()

            remembered.dispatch({type: 'center-tab', tab: 'game'})

            expect(backing.writes).toHaveLength(1)
            expect(backing.writes[0]?.[0]).toBe(WORKSPACE_LAYOUT_KEY)
            const state = remembered.state()
            expect(state.isOpen && state.layout.centerTab).toBe('game')
        })

        it('writes nothing when the change is the state it is already in', async () => {
            const backing = store({[WORKSPACE_LAYOUT_KEY]: {centerTab: 'game'}})
            const remembered = createRememberedLayout(backing)
            await remembered.open()

            remembered.dispatch({type: 'center-tab', tab: 'game'})
            remembered.dispatch({
                type: 'resized',
                explorerWidth: EXPLORER_MIN,
                inspectorWidth: 5
            })
            remembered.dispatch({
                type: 'resized',
                explorerWidth: EXPLORER_MIN,
                inspectorWidth: 5
            })

            expect(backing.writes).toHaveLength(1)
        })

        it('drops the cursor of a script the moment its tab closes', async () => {
            const backing = store({
                [WORKSPACE_LAYOUT_KEY]: {openScripts: ['a.gd', 'b.gd']},
                [SCRIPT_VIEWS_KEY]: {'a.gd': {line: 1}, 'b.gd': {line: 2}}
            })
            const remembered = createRememberedLayout(backing)
            await remembered.open()

            remembered.dispatch({
                type: 'scripts-changed',
                openScripts: ['a.gd'],
                breakpoints: {}
            })

            expect(backing.writes.map(([key]) => key)).toEqual([
                WORKSPACE_LAYOUT_KEY,
                SCRIPT_VIEWS_KEY
            ])
            expect(backing.writes[1]?.[1]).toEqual({'a.gd': {line: 1}})
        })

        it('leaves the cursors alone when the open tabs did not change', async () => {
            const backing = store({
                [WORKSPACE_LAYOUT_KEY]: {openScripts: ['a.gd']},
                [SCRIPT_VIEWS_KEY]: {'a.gd': {line: 1}}
            })
            const remembered = createRememberedLayout(backing)
            await remembered.open()

            remembered.dispatch({type: 'bottom-toggled'})

            expect(backing.writes.map(([key]) => key)).toEqual([WORKSPACE_LAYOUT_KEY])
        })
    })

    describe('recordView', () => {
        it('records a cursor without telling anything to re-render', async () => {
            const backing = store({[WORKSPACE_LAYOUT_KEY]: {openScripts: ['a.gd']}})
            const remembered = createRememberedLayout(backing)
            await remembered.open()
            const listener = vi.fn()
            remembered.subscribe(listener)

            remembered.recordView('a.gd', {line: 12})

            expect(listener).not.toHaveBeenCalled()
            expect(backing.writes).toEqual([[SCRIPT_VIEWS_KEY, {'a.gd': {line: 12}}]])
        })

        it('keeps a recorded cursor across the prune that follows a tab closing', async () => {
            const backing = store({[WORKSPACE_LAYOUT_KEY]: {openScripts: ['a.gd', 'b.gd']}})
            const remembered = createRememberedLayout(backing)
            await remembered.open()

            remembered.recordView('a.gd', {line: 12})
            remembered.recordView('b.gd', {line: 34})
            remembered.dispatch({
                type: 'scripts-changed',
                openScripts: ['a.gd'],
                breakpoints: {}
            })

            expect(backing.writes.at(-1)).toEqual([SCRIPT_VIEWS_KEY, {'a.gd': {line: 12}}])
        })
    })

    describe('subscribe', () => {
        it('stops telling a listener that has stopped listening', async () => {
            const remembered = createRememberedLayout(store())
            const listener = vi.fn()
            const unsubscribe = remembered.subscribe(listener)

            await remembered.open()
            expect(listener).toHaveBeenCalledTimes(1)

            unsubscribe()
            remembered.dispatch({type: 'center-tab', tab: 'docs'})
            expect(listener).toHaveBeenCalledTimes(1)
        })
    })
})

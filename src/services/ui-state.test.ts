import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {immediateScheduler} from './clock'
import {
    WORKSPACE_LAYOUT_KEY,
    createProjectStateWriter,
    draftKey,
    readProjectState
} from './ui-state'
import {createDesktopFake, installDesktopFake, removeDesktopFake} from '../test/desktop-driver'
import type {WriteScheduler} from './clock'

const tauri = createDesktopFake()

type Call = Readonly<{command: string; arguments: unknown}>

const calls: Call[] = []
let answer: (command: string, arguments_: unknown) => unknown = () => null
/** Set to make the bridge reject, the way a real failing command does. */
let rejectWith: Error | undefined

/*
 * The real desktop bridge, driven through the same test hook the application's own driver uses.
 * Nothing here substitutes a module: `services/desktop` is exercised as written, so a rename on
 * either side of it still fails.
 */
beforeEach(() => {
    calls.length = 0
    answer = () => null
    rejectWith = undefined
    installDesktopFake(tauri)
    tauri.invoke.mockImplementation((command, arguments_) => {
        calls.push({command, arguments: arguments_})
        if (rejectWith) return Promise.reject(rejectWith)
        return Promise.resolve(answer(command, arguments_))
    })
})

afterEach(() => {
    removeDesktopFake()
})

/** A clock nobody winds: work is held until the test decides time has passed. */
function manualScheduler() {
    const due: (() => void)[] = []
    const schedule: WriteScheduler = write => {
        const index = due.push(write) - 1
        return () => {
            due[index] = () => undefined
        }
    }
    return {
        schedule,
        tick() {
            const running = [...due]
            due.length = 0
            for (const write of running) write()
        }
    }
}

describe('keys', () => {
    it('namespaces a task draft under the prefix the backend allows', () => {
        expect(draftKey('task-7')).toBe('ui.draft.task-7')
        expect(WORKSPACE_LAYOUT_KEY.startsWith('ui.')).toBe(true)
    })
})

describe('writing', () => {
    it('sends the value as JSON once the scheduled write runs', () => {
        const clock = manualScheduler()
        const writer = createProjectStateWriter(clock.schedule)

        writer.write(WORKSPACE_LAYOUT_KEY, {centerTab: 'scripts'})
        expect(calls).toEqual([])

        clock.tick()
        expect(calls).toEqual([
            {
                command: 'write_project_state',
                arguments: {
                    key: WORKSPACE_LAYOUT_KEY,
                    value: JSON.stringify({centerTab: 'scripts'})
                }
            }
        ])
    })

    it('sends no value at all when the value is undefined, which forgets the key', () => {
        const clock = manualScheduler()
        const writer = createProjectStateWriter(clock.schedule)

        writer.write(draftKey('task-7'), undefined)
        clock.tick()

        expect(calls[0]?.arguments).toEqual({key: 'ui.draft.task-7'})
    })

    it('coalesces a burst on one key into a single write of the last value', () => {
        const clock = manualScheduler()
        const writer = createProjectStateWriter(clock.schedule)

        writer.write(WORKSPACE_LAYOUT_KEY, {explorerWidth: 200})
        writer.write(WORKSPACE_LAYOUT_KEY, {explorerWidth: 260})
        writer.write(WORKSPACE_LAYOUT_KEY, {explorerWidth: 300})
        clock.tick()

        expect(calls).toHaveLength(1)
        expect(calls[0]?.arguments).toEqual({
            key: WORKSPACE_LAYOUT_KEY,
            value: JSON.stringify({explorerWidth: 300})
        })
    })

    it('debounces each key on its own, so a script view does not delay a layout', () => {
        const clock = manualScheduler()
        const writer = createProjectStateWriter(clock.schedule)

        writer.write('ui.workspace', 1)
        writer.write('ui.scriptViews', 2)
        clock.tick()

        expect(calls.map(call => (call.arguments as {key: string}).key)).toEqual([
            'ui.workspace',
            'ui.scriptViews'
        ])
    })

    it('writes a pending value out immediately when flushed', () => {
        const clock = manualScheduler()
        const writer = createProjectStateWriter(clock.schedule)

        writer.write(WORKSPACE_LAYOUT_KEY, {centerTab: 'game'})
        writer.flush()

        expect(calls).toHaveLength(1)
    })

    it('does not write the flushed value a second time when its timer would have run', () => {
        const clock = manualScheduler()
        const writer = createProjectStateWriter(clock.schedule)

        writer.write(WORKSPACE_LAYOUT_KEY, {centerTab: 'game'})
        writer.flush()
        clock.tick()

        expect(calls).toHaveLength(1)
    })

    it('writes nothing when there is no desktop backend behind it', () => {
        tauri.isTauri.mockReturnValue(false)
        const writer = createProjectStateWriter(immediateScheduler)

        writer.write(WORKSPACE_LAYOUT_KEY, {centerTab: 'chat'})

        expect(calls).toEqual([])
    })

    it('survives a backend that rejects the write', async () => {
        rejectWith = new Error('database is locked')
        const writer = createProjectStateWriter(immediateScheduler)

        writer.write(WORKSPACE_LAYOUT_KEY, {centerTab: 'chat'})
        await Promise.resolve()

        expect(calls).toHaveLength(1)
    })
})

describe('reading', () => {
    it('parses the JSON the backend stored', async () => {
        answer = () => JSON.stringify({centerTab: 'docs'})
        await expect(readProjectState(WORKSPACE_LAYOUT_KEY)).resolves.toEqual({centerTab: 'docs'})
    })

    it('is undefined when the project has never stored the key', async () => {
        answer = () => null
        await expect(readProjectState(WORKSPACE_LAYOUT_KEY)).resolves.toBeUndefined()
    })

    it('is undefined rather than a throw when the stored value will not parse', async () => {
        answer = () => 'not json'
        await expect(readProjectState(WORKSPACE_LAYOUT_KEY)).resolves.toBeUndefined()
    })

    it('is undefined rather than a throw when the backend fails', async () => {
        answer = () => {
            throw new Error('database is locked')
        }
        await expect(readProjectState(WORKSPACE_LAYOUT_KEY)).resolves.toBeUndefined()
    })
})

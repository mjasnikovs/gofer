import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import type {Channel} from '@tauri-apps/api/core'
import {subscribeWorkspaceChanges} from './workspace-files'
import {createDesktopFake, installDesktopFake, removeDesktopFake} from '../test/desktop-driver'
import type {WorkspaceFileChange} from '../models/files'

const tauri = createDesktopFake()

type Batch = readonly WorkspaceFileChange[]

let watcher: Channel<Batch> | undefined

const commands = () => tauri.invoke.mock.calls.map(call => call[0])
const publish = (batch: Batch) => {
    watcher?.onmessage(batch)
}
const BATCH: Batch = [{path: 'scripts/player.gd', kind: 'modified'}]

beforeEach(() => {
    installDesktopFake(tauri)
    watcher = undefined
    tauri.invoke.mockImplementation((command, arguments_) => {
        if (command === 'watch_workspace_files')
            watcher = (arguments_ as {changes: Channel<Batch>}).changes
        if (command === 'unwatch_workspace_files') watcher = undefined
        return Promise.resolve(undefined)
    })
})

afterEach(() => {
    removeDesktopFake()
    tauri.invoke.mockReset()
})

describe('the workspace watcher', () => {
    it('hands every batch to every subscriber, from one watcher', async () => {
        const first: Batch[] = []
        const second: Batch[] = []
        const stopFirst = await subscribeWorkspaceChanges(batch => first.push(batch))
        const stopSecond = await subscribeWorkspaceChanges(batch => second.push(batch))

        publish(BATCH)

        expect(first).toEqual([BATCH])
        expect(second).toEqual([BATCH])
        expect(commands().filter(command => command === 'watch_workspace_files')).toHaveLength(1)
        await stopFirst()
        await stopSecond()
    })

    it('keeps watching for the subscriber that is left', async () => {
        const kept: Batch[] = []
        const stopKept = await subscribeWorkspaceChanges(batch => kept.push(batch))
        const stopGone = await subscribeWorkspaceChanges(() => undefined)

        await stopGone()
        publish(BATCH)

        expect(kept).toEqual([BATCH])
        expect(commands()).not.toContain('unwatch_workspace_files')
        await stopKept()
    })

    it('stops the watcher once nobody listens', async () => {
        const stop = await subscribeWorkspaceChanges(() => undefined)

        await stop()

        expect(commands().at(-1)).toBe('unwatch_workspace_files')
    })

    // A task switch remounts every subscriber at once, and the new task is a different folder.
    it('starts a fresh watcher when the last subscriber is replaced in the same tick', async () => {
        const stopOld = await subscribeWorkspaceChanges(() => undefined)
        const replaced = stopOld()
        const fresh = subscribeWorkspaceChanges(() => undefined)
        await replaced
        const stopFresh = await fresh

        expect(commands().filter(command => command === 'watch_workspace_files')).toHaveLength(2)
        expect(watcher).toBeDefined()
        await stopFresh()
    })
})

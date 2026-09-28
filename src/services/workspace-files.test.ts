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
        const {stop: stopFirst, ready: firstReady} = subscribeWorkspaceChanges(batch =>
            first.push(batch)
        )
        await firstReady
        const {stop: stopSecond, ready: secondReady} = subscribeWorkspaceChanges(batch =>
            second.push(batch)
        )
        await secondReady

        publish(BATCH)

        expect(first).toEqual([BATCH])
        expect(second).toEqual([BATCH])
        expect(commands().filter(command => command === 'watch_workspace_files')).toHaveLength(1)
        await stopFirst()
        await stopSecond()
    })

    it('keeps watching for the subscriber that is left', async () => {
        const kept: Batch[] = []
        const {stop: stopKept, ready: keptReady} = subscribeWorkspaceChanges(batch =>
            kept.push(batch)
        )
        await keptReady
        const {stop: stopGone, ready: goneReady} = subscribeWorkspaceChanges(() => undefined)
        await goneReady

        await stopGone()
        publish(BATCH)

        expect(kept).toEqual([BATCH])
        expect(commands()).not.toContain('unwatch_workspace_files')
        await stopKept()
    })

    it('stops the watcher once nobody listens', async () => {
        const {stop, ready} = subscribeWorkspaceChanges(() => undefined)
        await ready

        await stop()

        expect(commands().at(-1)).toBe('unwatch_workspace_files')
    })

    // A task switch remounts every subscriber at once, and the new task is a different folder.
    it('starts a fresh watcher when the last subscriber is replaced in the same tick', async () => {
        const {stop: stopOld, ready: oldReady} = subscribeWorkspaceChanges(() => undefined)
        await oldReady
        const replaced = stopOld()
        const fresh = subscribeWorkspaceChanges(() => undefined)
        await replaced
        await fresh.ready
        const stopFresh = fresh.stop

        expect(commands().filter(command => command === 'watch_workspace_files')).toHaveLength(2)
        expect(watcher).toBeDefined()
        await stopFresh()
    })

    // The backend refuses before it stops the old watcher, so the old folder keeps streaming.
    it('does not hand a subscriber the old watcher when the fresh one failed to start', async () => {
        const {stop: stopOld, ready: oldReady} = subscribeWorkspaceChanges(() => undefined)
        await oldReady
        const oldWatcher = watcher
        tauri.invoke.mockImplementationOnce(() => Promise.reject(new Error('no worktree yet')))
        const replaced = stopOld().catch(() => undefined)
        const heard: Batch[] = []
        const fresh = subscribeWorkspaceChanges(batch => heard.push(batch))
        await replaced
        await fresh.ready
        const stopFresh = fresh.stop

        expect(watcher).not.toBe(oldWatcher)
        publish(BATCH)
        expect(heard).toEqual([BATCH])
        await stopFresh()
    })
})

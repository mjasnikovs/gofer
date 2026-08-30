import {act, renderHook, waitFor} from '@testing-library/react'
import {describe, expect, it, vi} from 'vitest'
import type {ReactNode} from 'react'
import {useGodotReading} from './useGodotReading'
import {InEditorSession} from '../test/editor-session'
import {fakeSession, refusal} from '../test/fake-session'
import type {GodotSessionState} from '../models/godot'
import type {GodotCall} from '../models/workspace'

function reader(
    state: GodotSessionState,
    answer: () => Promise<unknown> = () => Promise.resolve({root: null})
) {
    const call = vi.fn(answer)
    const session = fakeSession({state, call: call as unknown as GodotCall})
    const wrapper = ({children}: Readonly<{children: ReactNode}>) => (
        <InEditorSession session={session}>{children}</InEditorSession>
    )
    return {wrapper, call}
}

describe('useGodotReading', () => {
    it('asks a session that can answer', async () => {
        const {wrapper, call} = reader('ready')
        const {result} = renderHook(() => useGodotReading('scene.get_tree'), {wrapper})
        await waitFor(() => {
            expect(result.current.data).toEqual({root: null})
        })
        expect(call).toHaveBeenCalledWith('scene.get_tree', {})
    })

    it.each<GodotSessionState>(['offline', 'error'])('asks nothing of a %s session', state => {
        const {wrapper, call} = reader(state)
        const {result} = renderHook(() => useGodotReading('scene.get_tree'), {wrapper})
        expect(call).not.toHaveBeenCalled()
        expect(result.current.isLoading).toBe(false)
    })

    it.each<GodotSessionState>(['staging', 'starting', 'importing'])(
        'waits for a session that is still %s rather than keeping its empty answer',
        state => {
            const {wrapper, call} = reader(state)
            const {result} = renderHook(() => useGodotReading('scene.get_tree'), {wrapper})
            expect(call).not.toHaveBeenCalled()
            expect(result.current.isLoading).toBe(true)
        }
    )

    it('sends nothing for a reading nobody wants', () => {
        const {wrapper, call} = reader('ready')
        const {result} = renderHook(() => useGodotReading('scene.get_tree', {}, {when: false}), {
            wrapper
        })
        expect(call).not.toHaveBeenCalled()
        expect(result.current.isLoading).toBe(false)
    })

    it('does not report a session that went away under a read in flight', async () => {
        const {wrapper} = reader('ready', () =>
            Promise.reject(refusal('session_stopped', 'stopped'))
        )
        const {result} = renderHook(() => useGodotReading('scene.get_tree'), {wrapper})
        await waitFor(() => {
            expect(result.current.isLoading).toBe(false)
        })
        expect(result.current.error).toBeUndefined()
    })

    it('reports a failure that is about the read rather than about the session', async () => {
        const {wrapper} = reader('ready', () => Promise.reject(refusal('scene_unreadable', 'no')))
        const {result} = renderHook(() => useGodotReading('scene.get_tree'), {wrapper})
        await waitFor(() => {
            expect(result.current.error?.code).toBe('scene_unreadable')
        })
    })

    it('re-reads when the epoch it follows moves', async () => {
        const {wrapper, call} = reader('ready')
        const {result, rerender} = renderHook(
            ({follows}: {follows: number}) => useGodotReading('scene.get_tree', {}, {follows}),
            {wrapper, initialProps: {follows: 1}}
        )
        await waitFor(() => {
            expect(result.current.data).toBeDefined()
        })
        expect(call).toHaveBeenCalledTimes(1)
        rerender({follows: 2})
        await waitFor(() => {
            expect(call).toHaveBeenCalledTimes(2)
        })
    })

    it('does not re-read for params that only look new', async () => {
        const {wrapper, call} = reader('ready')
        const {result, rerender} = renderHook(
            () => useGodotReading('project.search_settings', {query: 'physics'}),
            {wrapper}
        )
        await waitFor(() => {
            expect(result.current.data).toBeDefined()
        })
        rerender()
        rerender()
        expect(call).toHaveBeenCalledTimes(1)
    })

    it('re-reads when the params genuinely change', async () => {
        const {wrapper, call} = reader('ready')
        const {rerender} = renderHook(
            ({query}: {query: string}) => useGodotReading('project.search_settings', {query}),
            {wrapper, initialProps: {query: 'physics'}}
        )
        await waitFor(() => {
            expect(call).toHaveBeenCalledTimes(1)
        })
        rerender({query: 'audio'})
        await waitFor(() => {
            expect(call).toHaveBeenCalledTimes(2)
        })
        expect(call).toHaveBeenLastCalledWith('project.search_settings', {query: 'audio'})
    })

    it('asks again when the panel asks it to', async () => {
        const {wrapper, call} = reader('ready')
        const {result} = renderHook(() => useGodotReading('scene.get_tree'), {wrapper})
        await waitFor(() => {
            expect(call).toHaveBeenCalledTimes(1)
        })
        act(() => {
            result.current.reload()
        })
        await waitFor(() => {
            expect(call).toHaveBeenCalledTimes(2)
        })
    })
})

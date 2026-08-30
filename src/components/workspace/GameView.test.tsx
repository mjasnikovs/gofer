import {afterEach, describe, expect, it, vi} from 'vitest'
import {act, cleanup, render, screen, waitFor} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {GameView} from './GameView'
import {InEditorSession} from '../../test/editor-session'
import {fakeSession} from '../../test/fake-session'
import type {GodotSessionState} from '../../models/godot'
import type {GodotCall} from '../../models/workspace'

afterEach(cleanup)

const FRAME = {encoding: 'png-base64', width: 320, height: 180, data: 'iVBORw0KGgo='}

function surface(state: GodotSessionState) {
    const call = vi.fn(() => Promise.resolve({}))
    const inSession = (next: GodotSessionState) => (
        <InEditorSession session={fakeSession({state: next, call: call as unknown as GodotCall})}>
            <GameView />
        </InEditorSession>
    )
    const view = render(inSession(state))
    return Object.assign(call, {
        replay: (next: GodotSessionState) => {
            view.rerender(inSession(next))
        }
    })
}

function deferred<T>() {
    let settle!: (value: T) => void
    const promise = new Promise<T>(resolve => {
        settle = resolve
    })
    return {promise, settle}
}

function isRefused(label: string) {
    const button = screen.getByRole('button', {name: label})
    return button.hasAttribute('disabled') || button.getAttribute('aria-disabled') === 'true'
}

describe('the game surface', () => {
    it('offers Run only while there is no game to run', () => {
        surface('ready')
        expect(isRefused('Run')).toBe(false)
        cleanup()

        for (const state of ['playing', 'debugPaused'] as const) {
            surface(state)
            expect(isRefused('Run')).toBe(true)
            expect(isRefused('Restart')).toBe(false)
            expect(isRefused('Stop')).toBe(false)
            cleanup()
        }
    })

    it('stops showing a frame of the game once that game is gone', async () => {
        const user = userEvent.setup()
        const call = surface('playing')
        call.mockImplementation(() => Promise.resolve({frame: FRAME}))
        await user.click(screen.getByRole('button', {name: 'Capture game'}))
        await waitFor(() => {
            expect(screen.getByAltText(/the running game/i)).toBeInTheDocument()
        })

        call.replay('ready')

        expect(screen.queryByAltText(/the running game/i)).not.toBeInTheDocument()
        expect(screen.getByText('No frame captured')).toBeInTheDocument()
    })

    it('shows the frame of the run it has just started', async () => {
        const user = userEvent.setup()
        const call = surface('ready')
        const held = deferred<{frame: typeof FRAME}>()
        call.mockImplementation(() => held.promise)
        await user.click(screen.getByRole('button', {name: 'Run'}))
        call.replay('playing')
        await act(async () => {
            held.settle({frame: FRAME})
        })

        await waitFor(() => {
            expect(screen.getByAltText(/the running game/i)).toBeInTheDocument()
        })
        expect(screen.getByText('Game · 320×180')).toBeInTheDocument()
    })

    it('takes the picture down with the game a restart is ending', async () => {
        const user = userEvent.setup()
        const call = surface('playing')
        call.mockImplementation(() => Promise.resolve({frame: FRAME}))
        await user.click(screen.getByRole('button', {name: 'Capture game'}))
        await waitFor(() => {
            expect(screen.getByAltText(/the running game/i)).toBeInTheDocument()
        })

        call.mockImplementation(() => new Promise(() => undefined))
        await waitFor(() => {
            expect(isRefused('Restart')).toBe(false)
        })
        await user.click(screen.getByRole('button', {name: 'Restart'}))

        await waitFor(() => {
            expect(screen.queryByAltText(/the running game/i)).not.toBeInTheDocument()
        })
    })

    it('keeps a capture of the editor across a game that came and went', async () => {
        const user = userEvent.setup()
        const call = surface('ready')
        call.mockImplementation(() => Promise.resolve({frame: FRAME}))
        await user.click(screen.getByRole('button', {name: 'Capture editor'}))
        await waitFor(() => {
            expect(screen.getByAltText(/the editor viewport/i)).toBeInTheDocument()
        })

        call.replay('playing')
        expect(screen.getByAltText(/the editor viewport/i)).toBeInTheDocument()
        call.replay('ready')
        expect(screen.getByAltText(/the editor viewport/i)).toBeInTheDocument()
    })

    it('offers nothing at all without an editor session', () => {
        surface('offline')
        for (const label of ['Run', 'Restart', 'Stop', 'Capture game', 'Capture editor'])
            expect(isRefused(label)).toBe(true)
    })
})

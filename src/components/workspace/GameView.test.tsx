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
        /** The same panel, with the editor now in another state. */
        replay: (next: GodotSessionState) => {
            view.rerender(inSession(next))
        }
    })
}

/** A promise this test settles itself, so the order of an answer and a re-render is not a race. */
function deferred<T>() {
    let settle!: (value: T) => void
    const promise = new Promise<T>(resolve => {
        settle = resolve
    })
    return {promise, settle}
}

/** Astryx keeps a refusing button focusable, so it says so with ARIA rather than the attribute. */
function isRefused(label: string) {
    const button = screen.getByRole('button', {name: label})
    return button.hasAttribute('disabled') || button.getAttribute('aria-disabled') === 'true'
}

describe('the game surface', () => {
    it('offers Run only while there is no game to run', () => {
        surface('ready')
        expect(isRefused('Run')).toBe(false)
        cleanup()

        // A second run of a running game can only answer `already_running`, and a game stopped on
        // a breakpoint is still a game the editor is running. Restart is what was wanted.
        for (const state of ['playing', 'debugPaused'] as const) {
            surface(state)
            expect(isRefused('Run')).toBe(true)
            expect(isRefused('Restart')).toBe(false)
            expect(isRefused('Stop')).toBe(false)
            cleanup()
        }
    })

    /**
     * The picture is evidence of the game it came out of, and of no other.
     *
     * A frame stayed on screen through a restart, through a crash, and through a stop the panel
     * did not issue itself — a picture of a game that no longer exists, beside controls describing
     * one that does. The epoch moves whenever the game does, which is what retires it.
     */
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

    /**
     * The first frame of a run belongs to that run.
     *
     * The frame used to be tagged with a counter the workspace bumps whenever the game starts, read
     * when the command was sent — so the bump that Run itself caused retired Run's own answer, and
     * the panel said "No frame captured" over a game it had just started and drawn.
     */
    it('shows the frame of the run it has just started', async () => {
        const user = userEvent.setup()
        const call = surface('ready')
        // The answer is held rather than resolved, because the order is the whole subject: the
        // editor moves into playing while Run's own call is still in flight, and the frame that
        // call answers with belongs to the run that bump describes. Resolving it immediately left
        // that order to a microtask, and under the load of a full gate it came out the other way —
        // the panel said "No frame captured" over a game it had just started.
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

    /** A restart takes the old game's picture down when it is asked for, not when it answers. */
    it('takes the picture down with the game a restart is ending', async () => {
        const user = userEvent.setup()
        const call = surface('playing')
        call.mockImplementation(() => Promise.resolve({frame: FRAME}))
        await user.click(screen.getByRole('button', {name: 'Capture game'}))
        await waitFor(() => {
            expect(screen.getByAltText(/the running game/i)).toBeInTheDocument()
        })

        // A restart that never answers still ends the game it was pressed over. The panel refuses
        // every control while a call is in flight, so the wait is for the capture to have let go.
        call.mockImplementation(() => new Promise(() => undefined))
        await waitFor(() => {
            expect(isRefused('Restart')).toBe(false)
        })
        await user.click(screen.getByRole('button', {name: 'Restart'}))

        await waitFor(() => {
            expect(screen.queryByAltText(/the running game/i)).not.toBeInTheDocument()
        })
    })

    /** The editor viewport is not a game, so no run of one takes it away. */
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

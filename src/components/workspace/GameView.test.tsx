import {afterEach, describe, expect, it, vi} from 'vitest'
import {cleanup, render, screen} from '@testing-library/react'
import {GameView} from './GameView'
import type {GodotSessionState} from '../../models/godot'

afterEach(cleanup)

function surface(state: GodotSessionState) {
    const call = vi.fn(() => Promise.resolve({}))
    render(
        <GameView
            call={call}
            state={state}
        />
    )
    return call
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

    it('offers nothing at all without an editor session', () => {
        surface('offline')
        for (const label of ['Run', 'Restart', 'Stop', 'Capture game', 'Capture editor'])
            expect(isRefused(label)).toBe(true)
    })
})

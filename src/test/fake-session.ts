import {vi} from 'vitest'
import type {EditorSession} from '../hooks/useEditorSession'
import {INITIAL_SESSION_VIEW} from '../models/godot-session-state'

/**
 * One editor session for a panel to be mounted against.
 *
 * The session is the only thing a panel needs a frame for, so supplying one is what lets a panel be
 * tested as a panel. Everything is a working default: `call` answers with an empty dictionary, the
 * state is `ready`, and both epochs start where a fresh session starts.
 */
export function fakeSession(overrides: Partial<EditorSession> = {}): EditorSession {
    return {
        ...INITIAL_SESSION_VIEW,
        state: 'ready',
        scenePath: '',
        call: vi.fn(() => Promise.resolve({})),
        ensureReady: vi.fn(() => Promise.resolve(true)),
        start: vi.fn(() => Promise.resolve()),
        stop: vi.fn(() => Promise.resolve()),
        ...overrides
    }
}

/** A rejection shaped the way a failed command rejects: a code beside the sentence. */
export function refusal(code: string, message: string) {
    return Object.assign(new Error(message), {code})
}

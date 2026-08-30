import {vi} from 'vitest'
import type {EditorSession} from '../hooks/useEditorSession'
import {INITIAL_SESSION_VIEW} from '../models/godot-session-state'

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

export function refusal(code: string, message: string) {
    return Object.assign(new Error(message), {code})
}

import {act, cleanup, renderHook, waitFor} from '@testing-library/react'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {useChatGptLogin} from './use-chatgpt-login'
import {INITIAL_SETTINGS_DRAFT} from '../../models/settings-draft'
import type {SettingsAction} from '../../models/settings-draft'
import type {SettingsView} from './settings-view'
import type {ChatGptLoginEvent} from '../../models/settings'

const auth = vi.hoisted(() => ({
    login: vi.fn(),
    logout: vi.fn(),
    respond: vi.fn(),
    cancel: vi.fn()
}))

vi.mock('../../services/chatgpt-auth', () => ({
    loginChatGpt: auth.login,
    logoutChatGpt: auth.logout,
    respondChatGptLogin: auth.respond,
    cancelChatGptLogin: auth.cancel
}))

/** Drives the login through the events a real sign-in streams, then resolves it. */
function streaming(...events: ChatGptLoginEvent[]) {
    auth.login.mockImplementation(
        async (_method: unknown, callbacks: {onEvent: (event: ChatGptLoginEvent) => void}) => {
            for (const event of events) callbacks.onEvent(event)
        }
    )
}

function signingIn() {
    const dispatched: SettingsAction[] = []
    const view: SettingsView = {
        state: INITIAL_SETTINGS_DRAFT,
        dispatch: action => {
            dispatched.push(action)
        },
        run: async (_task, _title, work) => {
            await work()
        }
    }
    return {dispatched, rendered: renderHook(() => useChatGptLogin(view))}
}

afterEach(() => {
    cleanup()
    vi.clearAllMocks()
})

describe('useChatGptLogin', () => {
    it('shows the last thing the sign-in said, and files the success', async () => {
        streaming({type: 'progress', message: 'Waiting for the browser…'})
        const {dispatched, rendered} = signingIn()
        await act(async () => {
            await rendered.result.current.signIn('browser')
        })
        expect(rendered.result.current.message).toBe('Signed in with ChatGPT.')
        expect(rendered.result.current.isAuthenticating).toBe(false)
        expect(dispatched).toContainEqual({type: 'chatgpt-auth-changed', isAuthenticated: true})
    })

    it('asks for the redirect URL when the browser could not hand it back', async () => {
        // The real sign-in is still pending when it asks: the code it wants is what completes it.
        auth.login.mockImplementation(
            async (_method: unknown, callbacks: {onEvent: (event: ChatGptLoginEvent) => void}) => {
                callbacks.onEvent({type: 'manual-code-request', message: 'Paste the redirect URL'})
                await new Promise(() => undefined)
            }
        )
        const {rendered} = signingIn()
        act(() => {
            void rendered.result.current.signIn('browser')
        })
        await waitFor(() => {
            expect(rendered.result.current.needsManualCode).toBe(true)
        })

        act(() => {
            rendered.result.current.typeManualCode('http://localhost/cb?code=abc')
        })
        await act(async () => {
            await rendered.result.current.submitManualCode()
        })
        expect(auth.respond).toHaveBeenCalledWith('http://localhost/cb?code=abc')
        expect(rendered.result.current.needsManualCode).toBe(false)
    })

    it('keeps the box open when the code it was given is refused', async () => {
        auth.login.mockImplementation(
            async (_method: unknown, callbacks: {onEvent: (event: ChatGptLoginEvent) => void}) => {
                callbacks.onEvent({type: 'manual-code-request', message: 'Paste it'})
                await new Promise(() => undefined)
            }
        )
        auth.respond.mockRejectedValue(new Error('that is not the code'))
        const {rendered} = signingIn()
        act(() => {
            void rendered.result.current.signIn('browser')
        })
        await waitFor(() => {
            expect(rendered.result.current.needsManualCode).toBe(true)
        })
        await act(async () => {
            await expect(rendered.result.current.submitManualCode()).rejects.toThrow()
        })
        expect(rendered.result.current.needsManualCode).toBe(true)
    })

    it('reports a refusal as a notice rather than leaving the button spinning', async () => {
        auth.login.mockRejectedValue(new Error('the provider refused'))
        const {dispatched, rendered} = signingIn()
        await act(async () => {
            await rendered.result.current.signIn('device_code')
        })
        expect(rendered.result.current.isAuthenticating).toBe(false)
        expect(
            dispatched.some(action => action.type === 'noticed' && action.notice.status === 'error')
        ).toBe(true)
    })

    it('cancels only a sign-in that is running, so closing the dialog is not a cancel', async () => {
        const {rendered} = signingIn()
        act(() => {
            rendered.result.current.cancel()
        })
        expect(auth.cancel).not.toHaveBeenCalled()

        let release: (() => void) | undefined
        auth.login.mockImplementation(async () => {
            await new Promise<void>(resolve => {
                release = resolve
            })
        })
        act(() => {
            void rendered.result.current.signIn('browser')
        })
        await waitFor(() => {
            expect(rendered.result.current.isAuthenticating).toBe(true)
        })
        act(() => {
            rendered.result.current.cancel()
        })
        expect(auth.cancel).toHaveBeenCalledTimes(1)
        await act(async () => {
            release?.()
        })
    })

    it('clears the message it was showing when the user signs out', async () => {
        streaming()
        const {dispatched, rendered} = signingIn()
        await act(async () => {
            await rendered.result.current.signIn('browser')
        })
        expect(rendered.result.current.message).toBeDefined()

        auth.logout.mockResolvedValue(undefined)
        await act(async () => {
            await rendered.result.current.signOut()
        })
        expect(rendered.result.current.message).toBeUndefined()
        expect(dispatched).toContainEqual({type: 'chatgpt-auth-changed', isAuthenticated: false})
    })
})

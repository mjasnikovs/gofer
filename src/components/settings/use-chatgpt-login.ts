import {useState} from 'react'
import {
    cancelChatGptLogin,
    loginChatGpt,
    logoutChatGpt,
    respondChatGptLogin
} from '../../services/chatgpt-auth'
import {commandErrorMessage} from '../../utils/command-error'
import type {SettingsView} from './settings-view'

export type ChatGptLogin = Readonly<{
    isAuthenticating: boolean
    message: string | undefined
    manualCode: string
    needsManualCode: boolean
    typeManualCode: (value: string) => void
    submitManualCode: () => Promise<void>
    signIn: (method: 'browser' | 'device_code') => Promise<void>
    signOut: () => Promise<void>
    cancel: () => void
}>

/**
 * The ChatGPT sign-in, from the first event to the last.
 *
 * Four pieces of state and a seven-variant event stream lived in the tab that draws the button, so
 * nothing about the flow could be exercised without rendering the whole settings page — and none of
 * it was. The tab reads the four values now and the flow is driven through this interface.
 */
export function useChatGptLogin(view: SettingsView): ChatGptLogin {
    const {dispatch} = view
    const [isAuthenticating, setIsAuthenticating] = useState(false)
    const [message, setMessage] = useState<string | undefined>(undefined)
    const [manualCode, setManualCode] = useState('')
    const [needsManualCode, setNeedsManualCode] = useState(false)

    const notice = (status: 'success' | 'error', title: string, description: string) => {
        dispatch({type: 'noticed', tab: 'ai', notice: {status, title, description}})
    }

    const signIn = async (method: 'browser' | 'device_code') => {
        setIsAuthenticating(true)
        setNeedsManualCode(false)
        setManualCode('')
        setMessage('Starting ChatGPT sign-in…')
        try {
            await loginChatGpt(method, {
                onEvent: event => {
                    if (event.type === 'info') setMessage(event.message)
                    if (event.type === 'auth_url') setMessage(event.instructions)
                    if (event.type === 'device_code')
                        setMessage(`Enter code ${event.userCode} in the opened browser.`)
                    if (event.type === 'progress') setMessage(event.message)
                    if (event.type === 'manual-code-request') {
                        setNeedsManualCode(true)
                        setMessage(
                            'If the browser does not return to Gofer, paste its final redirect URL.'
                        )
                    }
                    if (event.type === 'failed') setMessage(event.message)
                }
            })
            dispatch({type: 'chatgpt-auth-changed', isAuthenticated: true})
            setNeedsManualCode(false)
            setMessage('Signed in with ChatGPT.')
            notice('success', 'ChatGPT connected', 'Your subscription can now drive Gofer.')
        } catch (error) {
            notice('error', 'ChatGPT sign-in failed', commandErrorMessage(error))
        } finally {
            setIsAuthenticating(false)
        }
    }

    const signOut = async () => {
        try {
            await logoutChatGpt()
            dispatch({type: 'chatgpt-auth-changed', isAuthenticated: false})
            setMessage(undefined)
            notice(
                'success',
                'Signed out of ChatGPT',
                'The local model configuration is unchanged.'
            )
        } catch (error) {
            notice('error', 'ChatGPT sign-out failed', commandErrorMessage(error))
        }
    }

    return {
        isAuthenticating,
        message,
        manualCode,
        needsManualCode,
        typeManualCode: setManualCode,
        submitManualCode: async () => {
            // Awaited before the box goes: a code the backend refuses leaves the user somewhere
            // to correct it rather than looking accepted.
            await respondChatGptLogin(manualCode)
            setNeedsManualCode(false)
        },
        signIn,
        signOut,
        cancel: () => {
            if (isAuthenticating) void cancelChatGptLogin()
        }
    }
}

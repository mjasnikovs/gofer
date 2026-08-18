import {Channel} from '@tauri-apps/api/core'
import {openUrl} from '@tauri-apps/plugin-opener'
import type {ChatGptLoginEvent, ChatGptLoginMethod} from '../models/settings'
import {invoke, isTauri} from './desktop'

type ChatGptLoginCallbacks = Readonly<{
    onEvent: (event: ChatGptLoginEvent) => void
}>

export async function loginChatGpt(method: ChatGptLoginMethod, callbacks: ChatGptLoginCallbacks) {
    const events = new Channel<Readonly<{event: ChatGptLoginEvent}>>()
    events.onmessage = payload => {
        const event = payload.event
        callbacks.onEvent(event)
        const url =
            event.type === 'auth_url' ? event.url
            : event.type === 'device_code' ? event.verificationUri
            : undefined
        if (url && isTauri()) void openUrl(url)
    }
    await invoke('login_chatgpt', {method, events})
}

export function respondChatGptLogin(value: string) {
    return invoke('respond_chatgpt_login', {value})
}

export function cancelChatGptLogin() {
    return invoke('cancel_chatgpt_login')
}

export function logoutChatGpt() {
    return invoke('logout_chatgpt')
}

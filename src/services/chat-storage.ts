import type {ChatAttachment, Message, StoredChat} from '../models/chat'

const CHAT_STORAGE_KEY = 'gofer.agent-chat.v1'

export function attachmentData(file: File) {
    return new Promise<{data: string; previewUrl: string}>((resolve, reject) => {
        const reader = new FileReader()
        reader.addEventListener('error', () => {
            reject(reader.error ?? new Error(`Could not read ${file.name}`))
        })
        reader.addEventListener('load', () => {
            if (typeof reader.result !== 'string') {
                reject(new Error(`Could not read ${file.name}`))
                return
            }
            const separator = reader.result.indexOf(',')
            if (separator < 0) {
                reject(new Error(`Could not encode ${file.name}`))
                return
            }
            resolve({data: reader.result.slice(separator + 1), previewUrl: reader.result})
        })
        reader.readAsDataURL(file)
    })
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null
}

function isStoredAttachment(value: unknown): value is ChatAttachment {
    if (!isRecord(value)) return false
    return (
        typeof value['id'] === 'string'
        && typeof value['name'] === 'string'
        && typeof value['mimeType'] === 'string'
        && typeof value['size'] === 'number'
    )
}

function isStoredMessage(value: unknown): value is Message {
    if (!isRecord(value)) return false
    return (
        typeof value['id'] === 'number'
        && (value['sender'] === 'user' || value['sender'] === 'assistant')
        && typeof value['text'] === 'string'
        && typeof value['timestamp'] === 'number'
        && (value['attachments'] === undefined
            || (Array.isArray(value['attachments'])
                && value['attachments'].every(isStoredAttachment)))
    )
}

export function loadLegacyChat(): StoredChat {
    if (typeof window === 'undefined') return {messages: [], agentMessages: []}
    try {
        const serialized = window.localStorage.getItem(CHAT_STORAGE_KEY)
        if (!serialized) return {messages: [], agentMessages: []}
        const parsed = JSON.parse(serialized) as unknown
        if (!isRecord(parsed)) return {messages: [], agentMessages: []}
        if (!Array.isArray(parsed['messages']) || !parsed['messages'].every(isStoredMessage)) {
            return {messages: [], agentMessages: []}
        }
        if (!Array.isArray(parsed['agentMessages'])) return {messages: [], agentMessages: []}
        return {messages: parsed['messages'], agentMessages: parsed['agentMessages']}
    } catch {
        return {messages: [], agentMessages: []}
    }
}

export function clearLegacyChat() {
    window.localStorage.removeItem(CHAT_STORAGE_KEY)
}

export function isStoredChat(value: unknown): value is StoredChat {
    if (!isRecord(value)) return false
    return (
        (value['taskId'] === undefined || typeof value['taskId'] === 'string')
        && Array.isArray(value['messages'])
        && value['messages'].every(isStoredMessage)
        && Array.isArray(value['agentMessages'])
    )
}

export function nextStoredMessageId(messages: readonly Message[]) {
    let maximumId = 0
    for (const message of messages) {
        if (message.id > maximumId) maximumId = message.id
    }
    return maximumId + 1
}

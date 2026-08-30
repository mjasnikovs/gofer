import {Channel} from '@tauri-apps/api/core'
import {invoke} from './desktop'
import type {SendAiMessageRequest} from './desktop'
import type {AiStreamPayload} from '../models/chat'

export async function sendAiMessage(
    request: SendAiMessageRequest,
    handler: (payload: AiStreamPayload) => void
): Promise<void> {
    const stream = new Channel<AiStreamPayload>()
    stream.onmessage = handler
    await invoke('send_ai_message', {request, stream})
}

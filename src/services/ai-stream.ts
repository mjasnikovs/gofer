import {Channel} from '@tauri-apps/api/core'
import {invoke} from './desktop'
import type {SendAiMessageRequest} from './desktop'
import type {AiStreamPayload} from '../models/chat'

/**
 * Runs one turn, delivering its deltas on a channel.
 *
 * A channel rather than an event: the stream is high-rate, it is tied to this one invocation, and
 * it is assembled by appending — text that arrives out of order is corrupt text. The promise
 * settles when the turn ends, however it ended.
 */
export async function sendAiMessage(
    request: SendAiMessageRequest,
    handler: (payload: AiStreamPayload) => void
): Promise<void> {
    const stream = new Channel<AiStreamPayload>()
    stream.onmessage = handler
    await invoke('send_ai_message', {request, stream})
}

import {Channel} from '@tauri-apps/api/core'
import {invoke} from './desktop'
import type {CompactAiContextRequest, SendAiMessageRequest} from './desktop'
import type {AiStreamPayload, CompactionSummary} from '../models/chat'

export async function sendAiMessage(
    request: SendAiMessageRequest,
    handler: (payload: AiStreamPayload) => void
): Promise<void> {
    const stream = new Channel<AiStreamPayload>()
    stream.onmessage = handler
    await invoke('send_ai_message', {request, stream})
}

// The summary rides the command's own reply. It used to be read off the channel, which is a second
// message with no ordering against this one: a compaction that had worked looked like one that
// never answered whenever the event lost the race.
export async function compactAiContext(
    request: CompactAiContextRequest
): Promise<CompactionSummary | undefined> {
    return await invoke('compact_ai_context', {request, stream: new Channel<AiStreamPayload>()})
}

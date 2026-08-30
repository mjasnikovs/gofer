import {Channel} from '@tauri-apps/api/core'
import {invoke, isTauri, listen} from './desktop'
import {isBriefEvent} from '../models/brief'
import type {AiStreamPayload, ChatAttachment} from '../models/chat'
import type {BriefEvent, BriefRun} from '../models/brief'

export async function runTaskBrief(
    request: Readonly<{
        requestId: number
        taskId: string
        prompt: string
        attachments: readonly ChatAttachment[]
    }>
): Promise<void> {
    const stream = new Channel<AiStreamPayload>()
    await invoke('run_task_brief', {request, stream})
}

export async function readTaskBrief(taskId: string): Promise<BriefRun | null> {
    if (!isTauri()) return null
    return invoke('read_task_brief', {taskId})
}

export function watchBrief(handler: (event: BriefEvent) => void): Promise<() => void> {
    return listen('ai-brief', event => {
        if (isBriefEvent(event.payload)) handler(event.payload)
    })
}

import {Channel} from '@tauri-apps/api/core'
import {invoke, isTauri, listen} from './desktop'
import {isBriefEvent} from '../models/brief'
import type {AiStreamPayload, ChatAttachment} from '../models/chat'
import type {BriefEvent, BriefRun} from '../models/brief'

/**
 * Runs the four phases that turn a planned task's ask into a specification.
 *
 * It takes a stream channel because it runs as an AI turn, and it runs as one deliberately: that is
 * what the Stop button can reach, and what stops the project's single checkout being switched onto
 * another task while four research workers are reading it. Nothing useful arrives on the channel —
 * the brief's own progress rides `ai-brief` events instead, because a phase is not part of an
 * assistant message and the chat timeline drops what it cannot draw.
 *
 * The promise settles when the brief ends, however it ended. A stop or a phase failure is not a
 * rejection: both are endings the run reported for itself, and both arrive as events first.
 */
export async function runTaskBrief(
    request: Readonly<{
        requestId: number
        taskId: string
        prompt: string
        /** The pictures the ask came with, already saved. The phases are shown them by name. */
        attachments: readonly ChatAttachment[]
    }>
): Promise<void> {
    const stream = new Channel<AiStreamPayload>()
    await invoke('run_task_brief', {request, stream})
}

/** A task's brief as far as it got, or nothing when it never had one. */
export async function readTaskBrief(taskId: string): Promise<BriefRun | null> {
    if (!isTauri()) return null
    return invoke('read_task_brief', {taskId})
}

/**
 * Watches a brief run.
 *
 * Unrecognised events are dropped rather than rendered as a guess, the same rule the chat timeline
 * follows: a screen that draws whatever arrives is a screen that draws a backend mistake.
 */
export function watchBrief(handler: (event: BriefEvent) => void): Promise<() => void> {
    return listen('ai-brief', event => {
        if (isBriefEvent(event.payload)) handler(event.payload)
    })
}

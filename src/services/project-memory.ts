import {Channel} from '@tauri-apps/api/core'
import {invoke, listen} from './desktop'
import {toCommandError} from '../utils/command-error'
import type {CommandError} from '../models/errors'
import type {AiStreamPayload} from '../models/chat'
import type {
    MemoryEdit,
    MemoryJudgeEvent,
    MemoryState,
    MemorySweepEvent,
    ProjectMemory
} from '../models/memory'
import {isMemoryJudgeEvent, isMemorySweepEvent} from '../models/memory'

/**
 * The project's memory, as the window reads and corrects it.
 *
 * The check comes back with the list rather than from a call of its own. It is one directory walk,
 * and a verdict behind a button is a verdict nobody presses — the point of the screen is to see
 * which rows have stopped matching the project without having to ask.
 */
export function listProjectMemory(): Promise<readonly ProjectMemory[]> {
    return invoke('list_project_memory')
}

export function saveProjectMemory(edit: MemoryEdit): Promise<ProjectMemory> {
    return invoke('save_project_memory', {edit})
}

export function deleteProjectMemory(id: string): Promise<void> {
    return invoke('delete_project_memory', {id})
}

/**
 * Puts one memory to a read-only sub-agent and answers with it once the verdict is filed.
 *
 * It takes a stream channel because it runs as an AI turn, and that is deliberate: a turn is what
 * the Stop button reaches, and what keeps a judgement from running beside a chat turn on the one
 * provider connection. Nothing useful arrives on the channel — the judgement's own progress rides
 * `ai-memory-judge` events, because the panel reading them is not the chat timeline.
 *
 * The promise settles when the judgement ends. A stop is not a rejection: it is an ending the run
 * reported for itself, and it arrives as an event first.
 */
export function judgeProjectMemory(
    request: Readonly<{requestId: number; memoryId: string}>
): Promise<ProjectMemory> {
    return invoke('judge_project_memory', {request, stream: new Channel<AiStreamPayload>()})
}

/**
 * Watches every running judgement.
 *
 * Unrecognised events are dropped rather than drawn as a guess — the same rule the chat timeline
 * follows, and the reason a screen cannot render a backend mistake as a verdict.
 */
export function watchMemoryJudge(handler: (event: MemoryJudgeEvent) => void): Promise<() => void> {
    return listen('ai-memory-judge', event => {
        if (isMemoryJudgeEvent(event.payload)) handler(event.payload)
    })
}

/**
 * Puts a list of memories to the judge, one after another, as a single turn.
 *
 * Which rows go is decided here rather than in Rust, because the cost is a minute each and the
 * person pressing the button is the one who can see whether that is worth paying. The promise
 * settles when the run ends, either way, and answers with every row that was judged.
 */
export function sweepProjectMemory(
    request: Readonly<{requestId: number; memoryIds: readonly string[]}>
): Promise<readonly ProjectMemory[]> {
    return invoke('sweep_project_memory', {request, stream: new Channel<AiStreamPayload>()})
}

/** Watches the running sweep's own count. Per-row progress is still `watchMemoryJudge`. */
export function watchMemorySweep(handler: (event: MemorySweepEvent) => void): Promise<() => void> {
    return listen('ai-memory-sweep', event => {
        if (isMemorySweepEvent(event.payload)) handler(event.payload)
    })
}

/** Moves several memories to one state, which is the only bulk correction worth having. */
export function setMemoryStates(
    ids: readonly string[],
    state: MemoryState
): Promise<readonly ProjectMemory[]> {
    return invoke('set_memory_states', {ids, state})
}

/** Ends a running judgement. The turn it runs as is what makes this reach the child. */
export function stopMemoryJudge(requestId: number): Promise<boolean> {
    return invoke('cancel_ai_request', {requestId})
}

/** The shared converter, under the name this panel reads it by. */
export const toMemoryError: (error: unknown) => CommandError = toCommandError

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
import {setTurnRunning} from './turn-activity'

async function asTurn<T>(run: () => Promise<T>): Promise<T> {
    setTurnRunning('memory', true)
    try {
        return await run()
    } finally {
        setTurnRunning('memory', false)
    }
}

export function listProjectMemory(): Promise<readonly ProjectMemory[]> {
    return invoke('list_project_memory')
}

export function saveProjectMemory(edit: MemoryEdit): Promise<ProjectMemory> {
    return invoke('save_project_memory', {edit})
}

export function deleteProjectMemory(id: string): Promise<void> {
    return invoke('delete_project_memory', {id})
}

export function judgeProjectMemory(
    request: Readonly<{requestId: number; memoryId: string}>
): Promise<ProjectMemory> {
    return asTurn(() =>
        invoke('judge_project_memory', {request, stream: new Channel<AiStreamPayload>()})
    )
}

export function watchMemoryJudge(handler: (event: MemoryJudgeEvent) => void): Promise<() => void> {
    return listen('ai-memory-judge', event => {
        if (isMemoryJudgeEvent(event.payload)) handler(event.payload)
    })
}

export function sweepProjectMemory(
    request: Readonly<{requestId: number; memoryIds: readonly string[]}>
): Promise<readonly ProjectMemory[]> {
    return asTurn(() =>
        invoke('sweep_project_memory', {request, stream: new Channel<AiStreamPayload>()})
    )
}

export function watchMemorySweep(handler: (event: MemorySweepEvent) => void): Promise<() => void> {
    return listen('ai-memory-sweep', event => {
        if (isMemorySweepEvent(event.payload)) handler(event.payload)
    })
}

export function setMemoryStates(
    ids: readonly string[],
    state: MemoryState
): Promise<readonly ProjectMemory[]> {
    return invoke('set_memory_states', {ids, state})
}

export function stopMemoryJudge(requestId: number): Promise<boolean> {
    return invoke('cancel_ai_request', {requestId})
}

export const toMemoryError: (error: unknown) => CommandError = toCommandError

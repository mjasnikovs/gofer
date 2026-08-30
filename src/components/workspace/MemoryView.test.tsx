import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {cleanup, render, screen} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {MemoryView} from './MemoryView'
import {createDesktopFake, installDesktopFake, removeDesktopFake} from '../../test/desktop-driver'
import {flush, flushUntil} from '../../test/flush'
import {CommandFailure, installBackend} from '../../test/backend'
import type {MemoryJudgeEvent, MemorySweepEvent, ProjectMemory} from '../../models/memory'

const tauri = createDesktopFake()

function memory(overrides: Partial<ProjectMemory>): ProjectMemory {
    return {
        id: 'one',
        kind: 'summary',
        state: 'confirmed',
        content: 'User request: add a roster\nOutcome: built it in `scripts/placement.gd`.',
        provenance: {source: 'completed-ai-turn'},
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
        check: 'intact',
        anchors: [{named: 'scripts/placement.gd', resolved: 'scripts/placement.gd'}],
        ...overrides
    }
}

const STALE = memory({
    id: 'two',
    content: 'User request: delete GRAYZONE.md\nOutcome: deleted it.',
    check: 'stale',
    anchors: [{named: 'GRAYZONE.md'}]
})

type JudgeRequest = Readonly<{memoryId: string; requestId: number}>
type SweepRequest = Readonly<{memoryIds: readonly string[]; requestId: number}>

function backend(rows: readonly ProjectMemory[] = [memory({}), STALE]) {
    const judged: JudgeRequest[] = []
    const stopped: number[] = []
    const swept: SweepRequest[] = []
    let settle: ((memory: ProjectMemory) => void) | undefined
    let endSweep: ((rows: readonly ProjectMemory[]) => void) | undefined
    const server = installBackend(tauri, {
        memories: rows,
        answers: {
            judge_project_memory: ({request}) => {
                judged.push(request)
                return new Promise<ProjectMemory>(resolve => {
                    settle = resolve
                })
            },
            cancel_ai_request: ({requestId}) => {
                stopped.push(requestId)
                return true
            },
            sweep_project_memory: ({request}) => {
                swept.push(request)
                return new Promise<readonly ProjectMemory[]>(resolve => {
                    endSweep = resolve
                })
            }
        }
    })
    return {
        state: server.state,
        judged,
        stopped,
        swept,
        settle: (row: ProjectMemory) => {
            server.state.memories = server.state.memories.map(one =>
                one.id === row.id ? row : one
            )
            settle?.(row)
        },
        endSweep: () => endSweep?.(server.state.memories),
        listed: () => server.state.memories
    }
}

function emitJudge(event: MemoryJudgeEvent) {
    for (const [name, handler] of tauri.listen.mock.calls)
        if (name === 'ai-memory-judge')
            (handler as (e: {payload: unknown}) => void)({payload: event})
}

function emitSweep(event: MemorySweepEvent) {
    for (const [name, handler] of tauri.listen.mock.calls)
        if (name === 'ai-memory-sweep')
            (handler as (e: {payload: unknown}) => void)({payload: event})
}

async function open() {
    render(<MemoryView />)
    await flushUntil(() => screen.queryAllByRole('radio', {name: /Needs review/u}).length > 0)
    await flush()
}

beforeEach(() => {
    installDesktopFake(tauri)
})

afterEach(() => {
    cleanup()
    removeDesktopFake()
    tauri.invoke.mockReset()
})

describe('the memory panel', () => {
    it('reports each memory against the workspace without being asked to', async () => {
        backend()
        await open()

        expect(screen.getByText('Names 1 file, and it is there')).toBeInTheDocument()
        expect(
            screen.getByText('Names GRAYZONE.md, which is not in the workspace')
        ).toBeInTheDocument()
        expect(tauri.invoke).toHaveBeenCalledTimes(1)
    })

    it('says a file is not there rather than that the memory is wrong', async () => {
        backend()
        await open()
        const user = userEvent.setup()

        await user.click(screen.getByText('delete GRAYZONE.md → deleted it.'))
        await flush()

        expect(
            screen.getByText(/a memory about deleting a file names one too/u)
        ).toBeInTheDocument()
        expect(screen.queryByText(/wrong|false|incorrect/iu)).toBeNull()
    })

    it('narrows to the memories that name a file the workspace does not have', async () => {
        backend()
        await open()
        const user = userEvent.setup()

        await user.click(screen.getByRole('radio', {name: 'Needs review 1'}))
        await flush()

        expect(screen.getByText('delete GRAYZONE.md → deleted it.')).toBeInTheDocument()
        expect(screen.queryByText('add a roster → built it in `scripts/placement.gd`.')).toBeNull()
    })

    it('holds a memory back from the model without throwing away what it says', async () => {
        const log = backend()
        await open()
        const user = userEvent.setup()

        await user.click(screen.getByText('delete GRAYZONE.md → deleted it.'))
        await flush()
        await user.click(screen.getByRole('radio', {name: 'Held back'}))
        await user.click(screen.getByRole('button', {name: 'Save'}))
        await flush()

        expect(log.listed().find(row => row.id === 'two')).toMatchObject({
            kind: 'summary',
            state: 'candidate',
            content: 'User request: delete GRAYZONE.md\nOutcome: deleted it.'
        })
        expect(screen.getByText('1 of these reach the model. A turn is given six.')).toBeVisible()
    })

    it('forgets a memory so no later turn is given it', async () => {
        const log = backend()
        await open()
        const user = userEvent.setup()

        await user.click(screen.getByText('delete GRAYZONE.md → deleted it.'))
        await flush()
        await user.click(screen.getByRole('button', {name: 'Forget'}))
        await flush()

        expect(log.listed().map(row => row.id)).toEqual(['one'])
        expect(screen.queryByText('delete GRAYZONE.md → deleted it.')).toBeNull()
    })

    it('reports a read it could not do', async () => {
        installBackend(tauri, {
            answers: {
                list_project_memory: () => {
                    throw new CommandFailure(
                        'memory_unavailable',
                        'The project database is not open'
                    )
                }
            }
        })
        render(<MemoryView />)
        await flushUntil(
            () => screen.queryAllByText(/The project database is not open/u).length > 0
        )

        expect(screen.getByText(/The project database is not open/u)).toBeInTheDocument()
    })
})

describe('putting a memory to the model', () => {
    it('asks only when a person asks, and says which memory it is about', async () => {
        const log = backend()
        await open()
        const user = userEvent.setup()

        await user.click(screen.getByText('delete GRAYZONE.md → deleted it.'))
        await flush()
        expect(log.judged).toEqual([])

        await user.click(screen.getByRole('button', {name: 'Ask the model'}))
        await flush()

        expect(log.judged).toHaveLength(1)
        expect(log.judged[0]?.memoryId).toBe('two')
    })

    it('shows what the sub-agent is reading while it reads it', async () => {
        backend()
        await open()
        const user = userEvent.setup()

        await user.click(screen.getByText('delete GRAYZONE.md → deleted it.'))
        await flush()
        await user.click(screen.getByRole('button', {name: 'Ask the model'}))
        await flush()
        emitJudge({type: 'judge-step', memoryId: 'two', line: 'bash: git log -1 GRAYZONE.md'})
        await flush()

        expect(screen.getByText('bash: git log -1 GRAYZONE.md')).toBeInTheDocument()
    })

    it('reports a verdict as something the model said, with what said it and when', async () => {
        const log = backend()
        await open()
        const user = userEvent.setup()

        await user.click(screen.getByText('delete GRAYZONE.md → deleted it.'))
        await flush()
        await user.click(screen.getByRole('button', {name: 'Ask the model'}))
        await flush()
        log.settle(
            memory({
                ...STALE,
                judgement: {
                    verdict: 'holds',
                    reason: 'GRAYZONE.md is absent and nothing references it.',
                    at: 1_700_000_100_000,
                    model: 'qwen3-coder',
                    isCurrent: true
                }
            })
        )
        await flush()

        expect(
            screen.getByText('The model read the code and says this still holds')
        ).toBeInTheDocument()
        expect(
            screen.getByText('GRAYZONE.md is absent and nothing references it.')
        ).toBeInTheDocument()
        expect(screen.getByText(/qwen3-coder/u)).toBeInTheDocument()
    })

    it('says when a verdict was made about an earlier version of the memory', async () => {
        backend([
            memory({
                ...STALE,
                judgement: {
                    verdict: 'broken',
                    reason: 'the file is still there',
                    at: 1_700_000_100_000,
                    model: 'qwen3-coder',
                    isCurrent: false
                }
            })
        ])
        await open()
        const user = userEvent.setup()

        await user.click(screen.getByText('delete GRAYZONE.md → deleted it.'))
        await flush()

        expect(
            screen.getByText(
                'The model read the code and says this no longer holds, before this memory was edited'
            )
        ).toBeInTheDocument()
    })

    it('stops a judgement through the turn it runs as', async () => {
        const log = backend()
        await open()
        const user = userEvent.setup()

        await user.click(screen.getByText('delete GRAYZONE.md → deleted it.'))
        await flush()
        await user.click(screen.getByRole('button', {name: 'Ask the model'}))
        await flush()
        await user.click(screen.getByRole('button', {name: 'Stop'}))
        await flush()

        expect(log.stopped).toEqual([log.judged[0]?.requestId])
    })

    it('reports a judgement that did not finish', async () => {
        backend()
        await open()
        const user = userEvent.setup()

        await user.click(screen.getByText('delete GRAYZONE.md → deleted it.'))
        await flush()
        await user.click(screen.getByRole('button', {name: 'Ask the model'}))
        await flush()
        emitJudge({type: 'judge-failed', memoryId: 'two', reason: 'it used all of its steps'})
        await flush()

        expect(screen.getByText(/it used all of its steps/u)).toBeInTheDocument()
    })
})

it('leaves the other memories alone when one judgement fails', async () => {
    backend()
    await open()
    const user = userEvent.setup()

    await user.click(screen.getByText('delete GRAYZONE.md → deleted it.'))
    await flush()
    await user.click(screen.getByRole('button', {name: 'Ask the model'}))
    await flush()
    emitJudge({type: 'judge-failed', memoryId: 'two', reason: 'it used all of its steps'})
    await flush()
    expect(screen.getByText(/it used all of its steps/u)).toBeInTheDocument()

    await user.click(screen.getByText('delete GRAYZONE.md → deleted it.'))
    await flush()
    await user.click(screen.getByText('add a roster → built it in `scripts/placement.gd`.'))
    await flush()

    expect(screen.queryByText(/it used all of its steps/u)).not.toBeInTheDocument()
})

describe('sweeping the whole list', () => {
    const JUDGED = memory({
        id: 'three',
        content: 'User request: pool the audio\nOutcome: added an autoload.',
        judgement: {
            verdict: 'holds',
            reason: 'the autoload is registered',
            at: 1_700_000_100_000,
            model: 'qwen3-coder',
            isCurrent: true
        }
    })

    it('asks about every memory without a current verdict, as a single turn', async () => {
        const log = backend([memory({}), STALE, JUDGED])
        await open()
        const user = userEvent.setup()

        await user.click(screen.getByRole('button', {name: 'Ask the model about 2'}))
        await flush()

        expect(log.swept).toHaveLength(1)
        expect(log.swept[0]?.memoryIds).toEqual(['one', 'two'])
    })

    it('stops the whole run through the one turn it holds', async () => {
        const log = backend([memory({}), STALE])
        await open()
        const user = userEvent.setup()

        await user.click(screen.getByRole('button', {name: 'Ask the model about 2'}))
        await flush()
        emitSweep({type: 'sweep-progress', memoryId: 'one', done: 0, total: 2})
        await flush()
        await user.click(screen.getByRole('button', {name: 'Stop'}))
        await flush()

        expect(log.stopped).toEqual([log.swept[0]?.requestId])
    })

    it('re-reads the list as each verdict lands rather than at the end', async () => {
        backend([memory({}), STALE])
        await open()
        const user = userEvent.setup()
        const readsBefore = tauri.invoke.mock.calls.filter(
            ([command]) => command === 'list_project_memory'
        ).length

        await user.click(screen.getByRole('button', {name: 'Ask the model about 2'}))
        await flush()
        emitJudge({type: 'judge-verdict', memoryId: 'one', verdict: 'broken'})
        await flush()

        const readsAfter = tauri.invoke.mock.calls.filter(
            ([command]) => command === 'list_project_memory'
        ).length
        expect(readsAfter).toBeGreaterThan(readsBefore)
    })

    it('shows which row it is on after an earlier one failed', async () => {
        backend([memory({}), STALE])
        await open()
        const user = userEvent.setup()

        await user.click(screen.getByText('delete GRAYZONE.md → deleted it.'))
        await flush()
        await user.click(screen.getByRole('button', {name: 'Ask the model about 2'}))
        await flush()
        emitSweep({type: 'sweep-progress', memoryId: 'one', done: 0, total: 2})
        await flush()
        emitJudge({type: 'judge-failed', memoryId: 'one', reason: 'it used all of its steps'})
        await flush()
        emitSweep({type: 'sweep-progress', memoryId: 'two', done: 1, total: 2})
        await flush()

        expect(screen.getByText('starting the sub-agent…')).toBeInTheDocument()
    })

    it('says how far through the list it is, and that chat is waiting', async () => {
        backend([memory({}), STALE])
        await open()
        const user = userEvent.setup()

        await user.click(screen.getByRole('button', {name: 'Ask the model about 2'}))
        await flush()
        emitSweep({type: 'sweep-progress', memoryId: 'two', done: 1, total: 2})
        await flush()

        expect(
            screen.getByText(/Asking the model about 2 of 2\. Chat waits for this\./u)
        ).toBeInTheDocument()
    })

    it('offers nothing to sweep when every memory has a current verdict', async () => {
        backend([JUDGED])
        await open()

        expect(screen.getByRole('button', {name: 'Every memory has a verdict'})).toBeDisabled()
    })
})

describe('acting on what the model found', () => {
    const BROKEN = memory({
        id: 'four',
        content: 'User request: add a pause menu\nOutcome: built it in `scripts/pause.gd`.',
        judgement: {
            verdict: 'broken',
            reason: 'scripts/pause.gd holds a settings screen now',
            at: 1_700_000_100_000,
            model: 'qwen3-coder',
            isCurrent: true
        }
    })

    it('counts only the rows judged broken against their current text', async () => {
        backend([
            memory({}),
            BROKEN,
            memory({
                id: 'five',
                judgement: {
                    verdict: 'broken',
                    reason: 'about an older version',
                    at: 1_700_000_100_000,
                    model: 'qwen3-coder',
                    isCurrent: false
                }
            })
        ])
        await open()

        expect(screen.getByRole('radio', {name: 'Model says broken 1'})).toBeInTheDocument()
    })

    it('stops retrieval reading every broken row in one press', async () => {
        const log = backend([memory({}), BROKEN])
        await open()
        const user = userEvent.setup()

        await user.click(screen.getByRole('radio', {name: 'Model says broken 1'}))
        await flush()
        await user.click(screen.getByRole('button', {name: 'Hold back all 1'}))
        await flush()

        expect(log.listed().find(row => row.id === 'four')).toMatchObject({
            state: 'candidate',
            content: BROKEN.content
        })
        expect(log.listed().map(row => row.id)).toEqual(['one', 'four'])
    })
})

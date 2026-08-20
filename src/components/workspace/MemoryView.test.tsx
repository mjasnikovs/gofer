import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {cleanup, render, screen} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {MemoryView} from './MemoryView'
import {createDesktopFake, installDesktopFake, removeDesktopFake} from '../../test/desktop-driver'
import {flush, flushUntil} from '../../test/flush'
import type {MemoryEdit, MemoryJudgeEvent, ProjectMemory} from '../../models/memory'

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

/** Everything the panel asked the backend to do, and what it was handed back. */
function backend(rows: readonly ProjectMemory[] = [memory({}), STALE]) {
    const saved: MemoryEdit[] = []
    const forgotten: string[] = []
    const judged: {memoryId: string; requestId: number}[] = []
    const stopped: number[] = []
    /** Resolves the running judgement, the way the backend answers once its verdict is filed. */
    let settle: ((memory: ProjectMemory) => void) | undefined
    let listed = [...rows]
    tauri.invoke.mockImplementation((command, arguments_) => {
        if (command === 'judge_project_memory') {
            const {request} = arguments_ as {request: {memoryId: string; requestId: number}}
            judged.push(request)
            return new Promise<ProjectMemory>(resolve => {
                settle = judgedMemory => {
                    listed = listed.map(row => (row.id === judgedMemory.id ? judgedMemory : row))
                    resolve(judgedMemory)
                }
            })
        }
        if (command === 'cancel_ai_request') {
            stopped.push((arguments_ as {requestId: number}).requestId)
            return Promise.resolve(true)
        }
        if (command === 'list_project_memory') return Promise.resolve(listed)
        if (command === 'save_project_memory') {
            const {edit} = arguments_ as {edit: MemoryEdit}
            saved.push(edit)
            const before = listed.find(row => row.id === edit.id)
            const stored = memory({
                ...before,
                kind: edit.kind,
                state: edit.state,
                content: edit.content
            })
            listed = listed.map(row => (row.id === stored.id ? stored : row))
            return Promise.resolve(stored)
        }
        if (command === 'delete_project_memory') {
            const {id} = arguments_ as {id: string}
            forgotten.push(id)
            listed = listed.filter(row => row.id !== id)
            return Promise.resolve()
        }
        throw new Error(`No fake for ${command}`)
    })
    return {saved, forgotten, judged, stopped, settle: (row: ProjectMemory) => settle?.(row)}
}

/** The window event a running judgement rides, delivered the way the backend emits it. */
function emitJudge(event: MemoryJudgeEvent) {
    for (const [name, handler] of tauri.listen.mock.calls)
        if (name === 'ai-memory-judge')
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
    /**
     * The check is what the read answers with, not a second thing to press.
     *
     * A verdict behind a button is a verdict nobody asks for, and these rows are read into the
     * front of every prompt whether or not anyone looked at them.
     */
    it('reports each memory against the workspace without being asked to', async () => {
        backend()
        await open()

        expect(screen.getByText('Names 1 file, and it is there')).toBeInTheDocument()
        expect(
            screen.getByText('Names GRAYZONE.md, which is not in the workspace')
        ).toBeInTheDocument()
        expect(tauri.invoke).toHaveBeenCalledTimes(1)
    })

    /**
     * A missing file is a measurement, and the wording never grows into a judgement.
     *
     * The memory below is entirely correct: it says a file was deleted, and the file is duly gone.
     * Nothing on screen may call that wrong, because on this evidence there is no way to know.
     */
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

    /** The filter is the screen's reason to exist: the rows that stopped matching the project. */
    it('narrows to the memories that name a file the workspace does not have', async () => {
        backend()
        await open()
        const user = userEvent.setup()

        await user.click(screen.getByRole('radio', {name: 'Needs review 1'}))
        await flush()

        expect(screen.getByText('delete GRAYZONE.md → deleted it.')).toBeInTheDocument()
        expect(screen.queryByText('add a roster → built it in `scripts/placement.gd`.')).toBeNull()
    })

    /**
     * Holding a memory back is the edit most rows need, and it sends only what the user changed.
     *
     * Retrieval reads `confirmed` and nothing else, so moving a row off it stops the model being
     * given it while keeping what it says. The save carries the three editable fields and no more:
     * the upsert behind it overwrites provenance and the task with whatever it is handed.
     */
    it('holds a memory back from the model without throwing away what it says', async () => {
        const log = backend()
        await open()
        const user = userEvent.setup()

        await user.click(screen.getByText('delete GRAYZONE.md → deleted it.'))
        await flush()
        await user.click(screen.getByRole('radio', {name: 'Held back'}))
        await user.click(screen.getByRole('button', {name: 'Save'}))
        await flush()

        expect(log.saved).toEqual([
            {
                id: 'two',
                kind: 'summary',
                state: 'candidate',
                content: 'User request: delete GRAYZONE.md\nOutcome: deleted it.'
            }
        ])
        expect(screen.getByText('1 of these reach the model. A turn is given six.')).toBeVisible()
    })

    /** Forgetting is the other way out, and the row goes without a second read. */
    it('forgets a memory so no later turn is given it', async () => {
        const log = backend()
        await open()
        const user = userEvent.setup()

        await user.click(screen.getByText('delete GRAYZONE.md → deleted it.'))
        await flush()
        await user.click(screen.getByRole('button', {name: 'Forget'}))
        await flush()

        expect(log.forgotten).toEqual(['two'])
        expect(screen.queryByText('delete GRAYZONE.md → deleted it.')).toBeNull()
    })

    /** A failed read is a state of the panel, not a blank list that looks like an empty project. */
    it('reports a read it could not do', async () => {
        tauri.invoke.mockRejectedValue({
            code: 'memory_unavailable',
            message: 'The project database is not open',
            retryable: true
        })
        render(<MemoryView />)
        await flushUntil(
            () => screen.queryAllByText(/The project database is not open/u).length > 0
        )

        expect(screen.getByText(/The project database is not open/u)).toBeInTheDocument()
    })
})

describe('putting a memory to the model', () => {
    /**
     * The judge is asked for, never assumed.
     *
     * It is a model request and about a minute, where the path check beside it is a directory walk.
     * That is the whole reason one runs on every open and the other waits to be clicked.
     */
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

    /** A minute with nothing on screen is indistinguishable from a hang. */
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

    /**
     * A verdict is a thing a model said, and the wording never lets it become a fact.
     *
     * The panel draws what the backend stored rather than what the event reported, because the
     * event does not survive a stop and the stored row does.
     */
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

    /**
     * A verdict kept through an edit is marked as being about text that has since changed.
     *
     * Keeping it is right — the user usually edits BECAUSE of it — and presenting it as current
     * would be a model vouching for a sentence it never read.
     */
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

    /** It runs as a turn precisely so it can be stopped. */
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

    /** A judgement that failed says so where it was asked for, rather than leaving a spinner. */
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

/**
 * A failure belongs to the memory it happened to.
 *
 * It was one string for the whole panel, and the editor drew it for whichever row happened to be
 * open. So a judgement that failed on one memory told the user their *other* memory could not be
 * judged — about a run that was never started on it.
 */
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

    // Away from the memory it failed on, and on to one that was never judged at all.
    await user.click(screen.getByText('delete GRAYZONE.md → deleted it.'))
    await flush()
    await user.click(screen.getByText('add a roster → built it in `scripts/placement.gd`.'))
    await flush()

    expect(screen.queryByText(/it used all of its steps/u)).not.toBeInTheDocument()
})

import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {cleanup, render, screen} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {MemoryView} from './MemoryView'
import {createDesktopFake, installDesktopFake, removeDesktopFake} from '../../test/desktop-driver'
import {flush, flushUntil} from '../../test/flush'
import type {
    MemoryEdit,
    MemoryJudgeEvent,
    MemoryState,
    MemorySweepEvent,
    ProjectMemory
} from '../../models/memory'

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
    const swept: {memoryIds: readonly string[]; requestId: number}[] = []
    const held: {ids: string[]; state: MemoryState}[] = []
    /** Resolves the running judgement, the way the backend answers once its verdict is filed. */
    let settle: ((memory: ProjectMemory) => void) | undefined
    /** Ends the running sweep, which is how the backend answers whether it finished or was stopped. */
    let endSweep: (() => void) | undefined
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
        if (command === 'sweep_project_memory') {
            const {request} = arguments_ as {
                request: {memoryIds: readonly string[]; requestId: number}
            }
            swept.push(request)
            return new Promise<readonly ProjectMemory[]>(resolve => {
                endSweep = () => {
                    resolve(listed)
                }
            })
        }
        if (command === 'set_memory_states') {
            const {ids, state} = arguments_ as {ids: readonly string[]; state: MemoryState}
            held.push({ids: [...ids], state})
            const moved = listed.filter(row => ids.includes(row.id)).map(row => ({...row, state}))
            listed = listed.map(row => moved.find(one => one.id === row.id) ?? row)
            return Promise.resolve(moved)
        }
        throw new Error(`No fake for ${command}`)
    })
    return {
        saved,
        forgotten,
        judged,
        stopped,
        swept,
        held,
        settle: (row: ProjectMemory) => settle?.(row),
        endSweep: () => endSweep?.(),
        /** What the panel would read now, so a test can assert against the same rows it does. */
        listed: () => listed
    }
}

/** The window event a running judgement rides, delivered the way the backend emits it. */
function emitJudge(event: MemoryJudgeEvent) {
    for (const [name, handler] of tauri.listen.mock.calls)
        if (name === 'ai-memory-judge')
            (handler as (e: {payload: unknown}) => void)({payload: event})
}

/** The window event a running sweep rides. Separate from the judge's, as the backend keeps it. */
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

/**
 * Checking the whole list, and what a person does with what it finds.
 *
 * The path check decides nothing about a memory that names no file, and on a real project that was
 * 32 of 87 rows — so the panel's own review filter can read zero while most of the list has never
 * been checked against anything. The sweep is the only thing that can settle those, and it is an
 * hour of the app's one provider connection, which is why it says so on the button and why every
 * verdict is worth showing the moment it lands.
 */
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

    /** One turn for the list, and only the rows nobody has paid for a verdict on. */
    it('asks about every memory without a current verdict, as a single turn', async () => {
        const log = backend([memory({}), STALE, JUDGED])
        await open()
        const user = userEvent.setup()

        await user.click(screen.getByRole('button', {name: 'Ask the model about 2'}))
        await flush()

        expect(log.swept).toHaveLength(1)
        expect(log.swept[0]?.memoryIds).toEqual(['one', 'two'])
    })

    /**
     * Stop reaches the run, not whichever memory is in flight.
     *
     * That is the whole reason a sweep is one turn rather than eighty. Eighty turns is eighty gaps
     * a chat message can win the provider connection in, and a Stop that lands in one of them ends
     * a judgement while the sweep goes on to the next.
     */
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

    /**
     * An hour is too long to look at a list that does not move.
     *
     * The verdict is not patched in from the event — it is filed on the Rust side before the event
     * leaves it, so the panel reads the list again and draws what was stored. Same rule the rest of
     * this screen keeps: nothing on it is drawn from what was reported.
     */
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

    /**
     * One row failing does not stop the rest of the run showing which row it is on.
     *
     * The per-row spinner was only ever moved onto the next memory when there was already one to
     * move, and a failure cleared it. So the first `judge-failed` in an eighty-four row sweep took
     * the spinner away for the remaining hour: the run went on, the header counted up, and no row
     * ever said it was the one being asked about.
     */
    it('shows which row it is on after an earlier one failed', async () => {
        backend([memory({}), STALE])
        await open()
        const user = userEvent.setup()

        // The row the sweep will reach second, open, so its spinner is on screen to look for.
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

    /** The count on screen is the run's own, so nobody is reading the panel's arithmetic. */
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

    /** Nothing to buy, nothing to sell: every row already carries a verdict about its own words. */
    it('offers nothing to sweep when every memory has a current verdict', async () => {
        backend([JUDGED])
        await open()

        expect(screen.getByRole('button', {name: 'Every memory has a verdict'})).toBeDisabled()
    })
})

/**
 * What a sweep leaves worth doing.
 *
 * A verdict changes nothing on its own: a row the model called broken is still `confirmed`, and
 * still one of the six a turn is given. Triage is the press that makes the verdict mean something.
 */
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

    /**
     * Only a verdict about the words stored now.
     *
     * A verdict made before the memory was edited is kept and shown, because the reason is still
     * worth reading — but it is about a sentence that is no longer there, so it is not something to
     * act on without looking.
     */
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

    /** Held back, not forgotten: the row keeps its words, its verdict, and the reason. */
    it('stops retrieval reading every broken row in one press', async () => {
        const log = backend([memory({}), BROKEN])
        await open()
        const user = userEvent.setup()

        await user.click(screen.getByRole('radio', {name: 'Model says broken 1'}))
        await flush()
        await user.click(screen.getByRole('button', {name: 'Hold back all 1'}))
        await flush()

        expect(log.held).toEqual([{ids: ['four'], state: 'candidate'}])
        expect(log.forgotten).toEqual([])
        expect(log.listed().find(row => row.id === 'four')?.content).toBe(BROKEN.content)
    })
})

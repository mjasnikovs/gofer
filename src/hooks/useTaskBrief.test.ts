import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {act, renderHook} from '@testing-library/react'
import type {RenderHookResult} from '@testing-library/react'
import {useTaskBrief} from './useTaskBrief'
import {clearTurnActivity, isTurnRunning} from '../services/turn-activity'
import {createDesktopFake, installDesktopFake, removeDesktopFake} from '../test/desktop-driver'
import {flush} from '../test/flush'
import {CommandFailure, installBackend} from '../test/backend'
import type {BackendAnswers, BackendOptions} from '../test/backend'
import type {BriefEvent} from '../models/brief'
import type {ChatAttachment} from '../models/chat'

const tauri = createDesktopFake()

/** Sends what the backend would send, to whoever the hook subscribed with. */
let deliver: (event: BriefEvent) => void = () => undefined

/** The shared in-memory backend, with whatever this test needs held or refused on top. */
const backend = (options: BackendOptions = {}) => installBackend(tauri, options)

/** A run held open, so the window can be read while the plan is still going. */
function heldRun(): {answers: BackendAnswers; endRun: () => void} {
    let endRun: () => void = () => undefined
    const answers: BackendAnswers = {
        run_task_brief: () =>
            new Promise<void>(resolve => {
                endRun = resolve
            })
    }
    return {
        answers,
        endRun: () => {
            endRun()
        }
    }
}

beforeEach(() => {
    // The fake is built once at module scope, so its call history outlives a test unless it is
    // cleared here. Without this, "nothing was started" passes or fails on what the previous test
    // did.
    tauri.invoke.mockReset()
    tauri.listen.mockReset()
    installDesktopFake(tauri)
    backend()
    tauri.listen.mockImplementation(async (name, handler) => {
        if (name === 'ai-brief') {
            deliver = event => {
                handler({event: name, id: 1, payload: event} as never)
            }
        }
        return () => undefined
    })
})

afterEach(() => {
    clearTurnActivity()
    removeDesktopFake()
    vi.restoreAllMocks()
    deliver = () => undefined
})

type Brief = ReturnType<typeof useTaskBrief>

const mount = (taskId: string | undefined) => {
    const startTurn = vi.fn<(prompt: string, attachments: readonly ChatAttachment[]) => void>()
    const onError = vi.fn<(message: string) => void>()
    const view = renderHook(() => useTaskBrief({taskId, onStartTurn: startTurn, onError}))
    return {startTurn, onError, view}
}

/** What the composer's plan control does: hands the typed ask over instead of sending it. */
const plan = async (
    view: RenderHookResult<Brief, unknown>,
    prompt = 'add a pause menu'
): Promise<void> => {
    act(() => {
        view.result.current.startPlan(prompt)
    })
    await flush()
}

/** The identifier the run registered itself under, which is the handle a cancellation needs. */
const startedRequestId = (): number => {
    const started = tauri.invoke.mock.calls.find(([command]) => command === 'run_task_brief')
    return (started?.[1] as {request: {requestId: number}}).request.requestId
}

describe('starting a plan from the composer', () => {
    it('runs the phases against what was typed', async () => {
        const {startTurn, view} = mount('task-1')
        await plan(view)

        expect(tauri.invoke).toHaveBeenCalledWith(
            'run_task_brief',
            expect.objectContaining({
                request: expect.objectContaining({
                    taskId: 'task-1',
                    prompt: 'add a pause menu'
                }) as unknown
            })
        )
        // Nothing is sent yet: the first message of a planned task is the specification, and there
        // is not one until the last phase produces it.
        expect(startTurn).not.toHaveBeenCalled()
    })

    // A task nobody has pressed the control on has nothing to do, which is every task.
    it('does nothing until the control is pressed', async () => {
        mount('task-1')
        await flush()
        expect(tauri.invoke).not.toHaveBeenCalledWith('run_task_brief', expect.anything())
    })

    it('does nothing while there is no task on screen', async () => {
        const {view} = mount(undefined)
        await plan(view)
        expect(tauri.invoke).not.toHaveBeenCalledWith('run_task_brief', expect.anything())
    })

    /*
     * Refused here rather than in the button, so the backend's own `brief_without_prompt` is never
     * the thing the user sees.
     */
    it('refuses an ask that is only whitespace', async () => {
        const {view} = mount('task-1')
        await plan(view, '   ')

        expect(tauri.invoke).not.toHaveBeenCalledWith('run_task_brief', expect.anything())
        expect(view.result.current.isPlanStarted).toBe(false)
    })

    /*
     * A task gets one opening move. The composer withholds the control once this is set, and a
     * second press that slipped through must not begin a second fifteen-minute run.
     */
    it('says a plan has been started, and starts only one', async () => {
        const {view} = mount('task-1')
        expect(view.result.current.isPlanStarted).toBe(false)

        await plan(view)
        expect(view.result.current.isPlanStarted).toBe(true)

        await plan(view, 'something else')
        const runs = tauri.invoke.mock.calls.filter(([command]) => command === 'run_task_brief')
        expect(runs).toHaveLength(1)
    })

    // The plan lives with the workspace that started it, and a workspace is remounted per task.
    it('starts nothing on its own when the workspace remounts', async () => {
        const {view} = mount('task-1')
        await plan(view)
        view.unmount()

        const second = mount('task-1')
        await flush()

        const runs = tauri.invoke.mock.calls.filter(([command]) => command === 'run_task_brief')
        expect(runs).toHaveLength(1)
        // Nothing stored, so nothing to restore: a task that never had a plan is still offered one.
        expect(second.view.result.current.isPlanStarted).toBe(false)
    })

    /*
     * The regression: a brief is written to disk phase by phase, and nothing read it back.
     *
     * `isPlanStarted` was built from live events alone, so a restart — or switching away and back —
     * put the Plan control in front of a task that had already run one. Pressing it re-ran all four
     * phases against a specification that was already stored: minutes of model time, several worker
     * spawns, for a result the database already held.
     */
    it('knows a plan was already asked for when the row on disk says so', async () => {
        backend({
            briefs: {
                'task-1': {
                    taskId: 'task-1',
                    status: 'done',
                    phase: 'compose',
                    rawPrompt: 'add a pause menu',
                    refined: null,
                    research: null,
                    qa: null,
                    spec: 'a specification',
                    reason: null
                }
            }
        })

        const {view} = mount('task-1')
        await flush()

        expect(view.result.current.isPlanStarted).toBe(true)
        // Restoring the ask must not restart the run it came from.
        const runs = tauri.invoke.mock.calls.filter(([command]) => command === 'run_task_brief')
        expect(runs).toHaveLength(0)
    })

    /** A brief that cannot be read is one re-offered control, not an error in front of the user. */
    it('says nothing when the stored brief cannot be read', async () => {
        backend({
            answers: {
                read_task_brief: () => {
                    throw new CommandFailure('brief_unavailable', 'the database was busy')
                }
            }
        })

        const {view, onError} = mount('task-1')
        await flush()

        expect(view.result.current.isPlanStarted).toBe(false)
        expect(onError).not.toHaveBeenCalled()
    })
})

describe('a plan that is running', () => {
    it('shows what it is doing before the first phase starts', async () => {
        const {view} = mount('task-1')
        await plan(view)

        expect(view.result.current.briefState.isRunning).toBe(false)
        deliver({type: 'brief-started'})
        await flush()
        expect(view.result.current.briefState.isRunning).toBe(true)
    })

    /*
     * Published where everything else reads it, because a brief holds the same single provider
     * operation a chat turn does and nothing outside this hook can see `briefState`.
     *
     * Without it the sidebar offered New task through a fifteen-minute plan and the backend refused
     * it by name — a control offered, pressed, and then refused.
     */
    it('tells the rest of the window the agent is occupied', async () => {
        const {view} = mount('task-1')
        await plan(view)
        expect(isTurnRunning()).toBe(false)

        deliver({type: 'brief-started'})
        await flush()
        expect(isTurnRunning()).toBe(true)

        deliver({type: 'brief-failed', phase: 'compose', reason: 'no verify block'})
        await flush()
        expect(isTurnRunning()).toBe(false)

        // And a workspace that goes leaves nothing running behind it.
        deliver({type: 'brief-started'})
        await flush()
        view.unmount()
        expect(isTurnRunning()).toBe(false)
    })

    it('follows the phases it reports', async () => {
        const {view} = mount('task-1')
        await plan(view)

        deliver({type: 'brief-started'})
        deliver({type: 'brief-phase-start', phase: 'research'})
        deliver({type: 'brief-worker-done', section: 'FILES', kind: 'ok'})
        await flush()

        expect(view.result.current.briefState.phase).toBe('research')
        expect(view.result.current.briefState.research.map(w => w.section)).toEqual(['FILES'])
    })

    /*
     * The specification goes through the same path a typed message does.
     *
     * Writing the chat row here instead would show it twice — the turn runner appends its own user
     * message — and would leave a message in the transcript that no turn ever ran against.
     */
    it('sends the specification as the task’s first message', async () => {
        const {startTurn, view} = mount('task-1')
        await plan(view)

        deliver({type: 'brief-phase', phase: 'compose', field: 'spec', value: 'GOAL\nA menu.'})
        await flush()

        expect(startTurn).toHaveBeenCalledWith('GOAL\nA menu.', [])
    })

    /*
     * The specification arrives while the run that produced it is still going.
     *
     * `brief-phase` is emitted from inside the worker loop, which the brief's `AiTurn` outlives —
     * `run_ai_worker` borrows it. That turn holds the backend's single provider operation, and it is
     * released after the command answers, not when the last phase reports.
     *
     * So a turn started on the event itself is refused `ai_request_in_progress`, and a planned task's
     * first message is a failed bubble reading "Gofer is still working on the previous message."
     * Every planned task ended that way.
     */
    it('waits for the run to end before sending the specification', async () => {
        const {answers, endRun} = heldRun()
        backend({answers})
        const {startTurn, view} = mount('task-1')
        await plan(view)

        deliver({type: 'brief-phase', phase: 'compose', field: 'spec', value: 'GOAL\nA menu.'})
        await flush()

        expect(startTurn).not.toHaveBeenCalled()

        endRun()
        await flush()

        expect(startTurn).toHaveBeenCalledWith('GOAL\nA menu.', [])
    })

    /*
     * A plan that worked ends silently, and something has to notice.
     *
     * The backend announces an ending only when there is one worth reading — a run that produced a
     * specification emits nothing at all, because the specification IS the report. So the command
     * answering is the only news that the run is over, and without acting on it `isRunning` stayed
     * true for the rest of the task's life: the panel sat spinning on "Writing the spec" above a
     * chat that was already working, the composer's Stop went on cancelling a finished brief instead
     * of the turn it was pointed at, and the window was told the agent was occupied forever.
     */
    it('closes the panel when the plan finishes, and hands the window back', async () => {
        const {answers, endRun} = heldRun()
        backend({answers})
        const {startTurn, view} = mount('task-1')
        await plan(view)

        deliver({type: 'brief-started'})
        deliver({type: 'brief-phase-start', phase: 'compose'})
        deliver({type: 'brief-phase', phase: 'compose', field: 'spec', value: 'GOAL\nA menu.'})
        await flush()
        expect(view.result.current.briefState.isRunning).toBe(true)

        endRun()
        await flush()

        expect(startTurn).toHaveBeenCalledWith('GOAL\nA menu.', [])
        expect(view.result.current.briefState.isRunning).toBe(false)
        // Nothing broke, so nothing is reported as broken. The panel is drawn on "running or
        // ended", so both have to be false for it to go.
        expect(view.result.current.briefState.ended).toBeUndefined()
        expect(isTurnRunning()).toBe(false)
    })

    // And the ending a run did report survives the command answering after it.
    it('keeps the ending a broken run reported', async () => {
        const {answers, endRun} = heldRun()
        backend({answers})
        const {view} = mount('task-1')
        await plan(view)

        deliver({type: 'brief-started'})
        deliver({type: 'brief-failed', phase: 'compose', reason: 'no verify block'})
        endRun()
        await flush()

        expect(view.result.current.briefState.ended).toEqual({
            kind: 'failed',
            reason: 'no verify block'
        })
    })

    // Every phase announces its output. Only the last one is the thing the agent works from.
    it('sends nothing for the phases before the last', async () => {
        const {startTurn, view} = mount('task-1')
        await plan(view)

        deliver({type: 'brief-phase', phase: 'refine', field: 'refined', value: 'GOAL\nA menu.'})
        deliver({type: 'brief-phase', phase: 'research', field: 'research', value: 'FILES'})
        await flush()

        expect(startTurn).not.toHaveBeenCalled()
    })

    /*
     * A half-finished specification handed over as though it were whole is worse than none: the
     * agent cannot tell that the questions were never asked.
     */
    it('delivers nothing when the run stops or breaks', async () => {
        const {startTurn, view} = mount('task-1')
        await plan(view)

        deliver({type: 'brief-started'})
        deliver({type: 'brief-phase', phase: 'refine', field: 'refined', value: 'GOAL'})
        deliver({type: 'brief-stopped', phase: 'research'})
        await flush()

        expect(startTurn).not.toHaveBeenCalled()
        expect(view.result.current.briefState.ended).toEqual({kind: 'stopped'})
        expect(view.result.current.briefState.isRunning).toBe(false)
    })

    /*
     * A refused command is an ending like any other, so it goes through the fold rather than round
     * it.
     *
     * Patching `isRunning` directly cleared the run without recording that it had failed, and the
     * panel is drawn on "running or ended" — so it unmounted, taking the way out of a failed plan
     * with it, in the one case that button exists for.
     */
    it('reports a plan that could not be started at all, and keeps the panel', async () => {
        backend({
            answers: {
                run_task_brief: () => {
                    throw new CommandFailure('ai_request_in_progress', 'a turn is already running')
                }
            }
        })
        const {onError, view} = mount('task-1')
        await plan(view)

        expect(onError).toHaveBeenCalledWith(expect.stringContaining('a turn is already running'))
        expect(view.result.current.briefState.ended).toEqual({
            kind: 'failed',
            reason: expect.stringContaining('a turn is already running') as unknown
        })
        expect(view.result.current.briefState.isRunning).toBe(false)
    })

    /*
     * The backend reports an ending of its own for a worker that died without one, and it cannot
     * tell whether the worker got a word in first. So the first ending wins: the safety net must not
     * replace "no verify block" with "the plan ended before it wrote a specification".
     */
    it('keeps the first ending it was told', async () => {
        const {view} = mount('task-1')
        await plan(view)

        deliver({type: 'brief-started'})
        deliver({type: 'brief-failed', phase: 'compose', reason: 'no verify block'})
        deliver({type: 'brief-failed', phase: 'compose', reason: 'the plan ended before it wrote'})
        await flush()

        expect(view.result.current.briefState.ended).toEqual({
            kind: 'failed',
            reason: 'no verify block'
        })
    })

    /*
     * A brief is an AI turn so that Stop can reach it — and Stop reaches a turn by its identifier.
     *
     * Without this the window offered no way to end a fifteen-minute run at all: the composer's Stop
     * follows the CHAT turn, which a brief never starts, so the only way out was closing the window.
     */
    it('can be stopped by the identifier it was started under', async () => {
        const {view} = mount('task-1')
        await plan(view)

        const requestId = startedRequestId()
        view.result.current.stopBrief()
        await flush()

        expect(tauri.invoke).toHaveBeenCalledWith('cancel_ai_request', {requestId})
    })

    it('has nothing to stop before a run has started', async () => {
        const {view} = mount('task-1')
        await flush()
        view.result.current.stopBrief()
        await flush()
        expect(tauri.invoke).not.toHaveBeenCalledWith('cancel_ai_request', expect.anything())
    })

    /*
     * The way out of a failed plan.
     *
     * The task exists, is named after the ask, and has an empty chat — and the composer was emptied
     * when the plan took the ask. Without this the only other thing to do with the task is delete it
     * and type the same sentence again.
     */
    it('can start the task from the ask the plan was going to work from', async () => {
        const {startTurn, view} = mount('task-1')
        await plan(view)

        deliver({type: 'brief-started'})
        deliver({type: 'brief-failed', phase: 'compose', reason: 'no verify block'})
        await flush()
        expect(startTurn).not.toHaveBeenCalled()

        act(() => {
            view.result.current.startWithoutPlan()
        })
        await flush()

        expect(startTurn).toHaveBeenCalledWith('add a pause menu', [])
        // The panel goes with the run it was reporting on; the task is an ordinary one from here.
        expect(view.result.current.briefState.ended).toBeUndefined()
    })

    /*
     * The pictures are part of the ask, so they follow it everywhere it goes.
     *
     * Three places, and it used to be none of them: the run that reads them, the turn its
     * specification starts, and the ask handed back when the plan failed. A screenshot left in the
     * drawer meant a fifteen-minute plan written about a sentence describing a screen nobody looked
     * at, and a chat turn that then could not see it either.
     */
    it('carries the pictures the ask came with, however the plan ends', async () => {
        const picture = {
            id: '018f47aa-09d2-7b34-a2d3-8c4e6f123456',
            name: 'menu.png',
            mimeType: 'image/png',
            size: 2
        }
        const {startTurn, view} = mount('task-1')
        act(() => {
            view.result.current.startPlan('why is this menu off centre', [picture])
        })
        await flush()

        expect(tauri.invoke).toHaveBeenCalledWith(
            'run_task_brief',
            expect.objectContaining({
                request: expect.objectContaining({attachments: [picture]}) as unknown
            })
        )

        deliver({type: 'brief-started'})
        deliver({type: 'brief-failed', phase: 'refine', reason: 'the model would not answer'})
        await flush()
        act(() => {
            view.result.current.startWithoutPlan()
        })
        await flush()

        expect(startTurn).toHaveBeenCalledWith('why is this menu off centre', [picture])
    })

    // Once, so a second press cannot send the same ask twice.
    it('starts from the ask only once', async () => {
        const {startTurn, view} = mount('task-1')
        await plan(view)

        act(() => {
            view.result.current.startWithoutPlan()
            view.result.current.startWithoutPlan()
        })
        await flush()

        expect(startTurn).toHaveBeenCalledTimes(1)
    })
})

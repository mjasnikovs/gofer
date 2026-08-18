import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {act, renderHook} from '@testing-library/react'
import {useTaskBrief} from './useTaskBrief'
import {clearStagedTaskStarts, stageTaskStart} from '../services/task-start'
import {clearTurnActivity, isTurnRunning} from '../services/turn-activity'
import {createDesktopFake, installDesktopFake, removeDesktopFake} from '../test/desktop-driver'
import {flush} from '../test/flush'
import type {BriefEvent} from '../models/brief'

const tauri = createDesktopFake()

/** Sends what the backend would send, to whoever the hook subscribed with. */
let deliver: (event: BriefEvent) => void = () => undefined

beforeEach(() => {
    // The fake is built once at module scope, so its call history outlives a test unless it is
    // cleared here. Without this, "nothing was started" passes or fails on what the previous test
    // did.
    tauri.invoke.mockReset()
    tauri.listen.mockReset()
    installDesktopFake(tauri)
    tauri.invoke.mockResolvedValue(undefined)
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
    clearStagedTaskStarts()
    clearTurnActivity()
    removeDesktopFake()
    vi.restoreAllMocks()
    deliver = () => undefined
})

const mount = (taskId: string | undefined, isChatLoaded = true, isDraftLoaded = true) => {
    const startTurn = vi.fn<(prompt: string) => void>()
    const onDraft = vi.fn<(prompt: string) => void>()
    const onError = vi.fn<(message: string) => void>()
    const view = renderHook(
        (props: {isChatLoaded: boolean; isDraftLoaded: boolean}) =>
            useTaskBrief({
                taskId,
                ...props,
                onStartTurn: startTurn,
                onDraft,
                onError
            }),
        {initialProps: {isChatLoaded, isDraftLoaded}}
    )
    return {startTurn, onDraft, onError, view}
}

describe('what a new task does when it opens', () => {
    /*
     * Skip planning is a way out of the dialog, not a second way to send a message.
     *
     * The user pressed it to go and type, so the ask lands in the composer and nothing is sent. A
     * turn started here would take the decision back off them the instant they made it.
     */
    it('puts a skipped task’s ask in the composer, sends nothing, and plans nothing', async () => {
        stageTaskStart('task-1', {prompt: 'add a pause menu', mode: 'draft'})
        const {startTurn, onDraft} = mount('task-1')
        await flush()

        expect(onDraft).toHaveBeenCalledWith('add a pause menu')
        expect(startTurn).not.toHaveBeenCalled()
        expect(tauri.invoke).not.toHaveBeenCalledWith('run_task_brief', expect.anything())
    })

    /*
     * A remembered value refuses every write until its own read has answered, so a draft handed
     * over before then vanishes without a word — and the sentence the user typed into the dialog
     * would simply not be in the composer when it appeared.
     */
    it('waits for the remembered draft to be read before writing into it', async () => {
        stageTaskStart('task-1', {prompt: 'add a pause menu', mode: 'draft'})
        const {onDraft, view} = mount('task-1', true, false)
        await flush()

        expect(onDraft).not.toHaveBeenCalled()

        view.rerender({isChatLoaded: true, isDraftLoaded: true})
        await flush()

        expect(onDraft).toHaveBeenCalledWith('add a pause menu')
    })

    it('runs the phases for a planned task', async () => {
        stageTaskStart('task-1', {prompt: 'add a pause menu', mode: 'planned'})
        const {startTurn} = mount('task-1')
        await flush()

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

    /*
     * Reading the stored conversation REPLACES what the runner holds, so a turn started before that
     * read lands is thrown away when it does — the message vanished, the task kept the name "New
     * task", and nothing reported a failure anywhere. A planned task never noticed, because its
     * first message arrives minutes later.
     */
    it('waits for the conversation to be read before starting anything', async () => {
        stageTaskStart('task-1', {prompt: 'add a pause menu', mode: 'planned'})
        const {view} = mount('task-1', false)
        await flush()

        expect(tauri.invoke).not.toHaveBeenCalledWith('run_task_brief', expect.anything())

        view.rerender({isChatLoaded: true, isDraftLoaded: true})
        await flush()

        expect(tauri.invoke).toHaveBeenCalledWith('run_task_brief', expect.anything())
    })

    /*
     * The draft's own read is the slower of the two: its key is not known until the chat has
     * answered with the task. Holding a plan behind it would put a whole round trip in front of
     * every planned task for a value the plan never touches.
     */
    it('starts a plan without waiting for the remembered draft', async () => {
        stageTaskStart('task-1', {prompt: 'add a pause menu', mode: 'planned'})
        mount('task-1', true, false)
        await flush()

        expect(tauri.invoke).toHaveBeenCalledWith('run_task_brief', expect.anything())
    })

    // And the staged start is still there to act on, rather than consumed by the mount that could
    // not use it.
    it('does not consume the staged start while it cannot act on it', async () => {
        stageTaskStart('task-1', {prompt: 'add a pause menu', mode: 'planned'})
        const first = mount('task-1', false)
        await flush()
        first.view.unmount()

        const {view} = mount('task-1', true, true)
        await flush()

        expect(tauri.invoke).toHaveBeenCalledWith('run_task_brief', expect.anything())
        expect(view.result.current.briefState).toBeDefined()
    })

    // A task opened from the sidebar was not made from the dialog, so it has nothing to do.
    it('does nothing at all for a task nobody staged', async () => {
        mount('task-1')
        await flush()
        expect(tauri.invoke).not.toHaveBeenCalledWith('run_task_brief', expect.anything())
    })

    it('does nothing while there is no task on screen', async () => {
        stageTaskStart('task-1', {prompt: 'anything', mode: 'planned'})
        mount(undefined)
        await flush()
        expect(tauri.invoke).not.toHaveBeenCalledWith('run_task_brief', expect.anything())
    })
})

describe('a plan that is running', () => {
    it('shows what it is doing before the first phase starts', async () => {
        stageTaskStart('task-1', {prompt: 'add a pause menu', mode: 'planned'})
        const {view} = mount('task-1')
        await flush()

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
        stageTaskStart('task-1', {prompt: 'add a pause menu', mode: 'planned'})
        const {view} = mount('task-1')
        await flush()
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
        stageTaskStart('task-1', {prompt: 'add a pause menu', mode: 'planned'})
        const {view} = mount('task-1')
        await flush()

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
        stageTaskStart('task-1', {prompt: 'add a pause menu', mode: 'planned'})
        const {startTurn} = mount('task-1')
        await flush()

        deliver({type: 'brief-phase', phase: 'compose', field: 'spec', value: 'GOAL\nA menu.'})
        await flush()

        expect(startTurn).toHaveBeenCalledWith('GOAL\nA menu.')
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
        let endRun: () => void = () => undefined
        tauri.invoke.mockImplementation(async (command: string) => {
            if (command !== 'run_task_brief') return undefined
            return new Promise<void>(resolve => {
                endRun = resolve
            })
        })
        stageTaskStart('task-1', {prompt: 'add a pause menu', mode: 'planned'})
        const {startTurn} = mount('task-1')
        await flush()

        deliver({type: 'brief-phase', phase: 'compose', field: 'spec', value: 'GOAL\nA menu.'})
        await flush()

        expect(startTurn).not.toHaveBeenCalled()

        endRun()
        await flush()

        expect(startTurn).toHaveBeenCalledWith('GOAL\nA menu.')
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
        let endRun: () => void = () => undefined
        tauri.invoke.mockImplementation(async (command: string) => {
            if (command !== 'run_task_brief') return undefined
            return new Promise<void>(resolve => {
                endRun = resolve
            })
        })
        stageTaskStart('task-1', {prompt: 'add a pause menu', mode: 'planned'})
        const {startTurn, view} = mount('task-1')
        await flush()

        deliver({type: 'brief-started'})
        deliver({type: 'brief-phase-start', phase: 'compose'})
        deliver({type: 'brief-phase', phase: 'compose', field: 'spec', value: 'GOAL\nA menu.'})
        await flush()
        expect(view.result.current.briefState.isRunning).toBe(true)

        endRun()
        await flush()

        expect(startTurn).toHaveBeenCalledWith('GOAL\nA menu.')
        expect(view.result.current.briefState.isRunning).toBe(false)
        // Nothing broke, so nothing is reported as broken. The panel is drawn on "running or
        // ended", so both have to be false for it to go.
        expect(view.result.current.briefState.ended).toBeUndefined()
        expect(isTurnRunning()).toBe(false)
    })

    // And the ending a run did report survives the command answering after it.
    it('keeps the ending a broken run reported', async () => {
        let endRun: () => void = () => undefined
        tauri.invoke.mockImplementation(async (command: string) => {
            if (command !== 'run_task_brief') return undefined
            return new Promise<void>(resolve => {
                endRun = resolve
            })
        })
        stageTaskStart('task-1', {prompt: 'add a pause menu', mode: 'planned'})
        const {view} = mount('task-1')
        await flush()

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
        stageTaskStart('task-1', {prompt: 'add a pause menu', mode: 'planned'})
        const {startTurn} = mount('task-1')
        await flush()

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
        stageTaskStart('task-1', {prompt: 'add a pause menu', mode: 'planned'})
        const {startTurn, view} = mount('task-1')
        await flush()

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
        tauri.invoke.mockImplementation(async (command: string) => {
            if (command === 'run_task_brief') throw new Error('a turn is already running')
            return undefined
        })
        stageTaskStart('task-1', {prompt: 'add a pause menu', mode: 'planned'})
        const {onError, view} = mount('task-1')
        await flush()

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
        stageTaskStart('task-1', {prompt: 'add a pause menu', mode: 'planned'})
        const {view} = mount('task-1')
        await flush()

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
        stageTaskStart('task-1', {prompt: 'add a pause menu', mode: 'planned'})
        const {view} = mount('task-1')
        await flush()

        const started = tauri.invoke.mock.calls.find(([command]) => command === 'run_task_brief')
        const requestId = (started?.[1] as {request: {requestId: number}}).request.requestId

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
     * The task exists, is named after the ask, and has an empty chat — and the dialog that took the
     * ask is long gone. Without this the only other thing to do with the task is delete it and type
     * the same sentence again.
     */
    it('can start the task from the ask the plan was going to work from', async () => {
        stageTaskStart('task-1', {prompt: 'add a pause menu', mode: 'planned'})
        const {startTurn, view} = mount('task-1')
        await flush()

        deliver({type: 'brief-started'})
        deliver({type: 'brief-failed', phase: 'compose', reason: 'no verify block'})
        await flush()
        expect(startTurn).not.toHaveBeenCalled()

        act(() => {
            view.result.current.startWithoutPlan()
        })
        await flush()

        expect(startTurn).toHaveBeenCalledWith('add a pause menu')
        // The panel goes with the run it was reporting on; the task is an ordinary one from here.
        expect(view.result.current.briefState.ended).toBeUndefined()
    })

    // Once, so a second press cannot send the same ask twice.
    it('starts from the ask only once', async () => {
        stageTaskStart('task-1', {prompt: 'add a pause menu', mode: 'planned'})
        const {startTurn, view} = mount('task-1')
        await flush()

        act(() => {
            view.result.current.startWithoutPlan()
            view.result.current.startWithoutPlan()
        })
        await flush()

        expect(startTurn).toHaveBeenCalledTimes(1)
    })

    // The staged start is taken once, so a remount does not begin a fifteen-minute run again.
    it('does not start again when the workspace remounts', async () => {
        stageTaskStart('task-1', {prompt: 'add a pause menu', mode: 'planned'})
        const {view} = mount('task-1')
        await flush()
        view.unmount()

        mount('task-1')
        await flush()

        const runs = tauri.invoke.mock.calls.filter(([command]) => command === 'run_task_brief')
        expect(runs).toHaveLength(1)
    })
})

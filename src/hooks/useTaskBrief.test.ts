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

let deliver: (event: BriefEvent) => void = () => undefined

const backend = (options: BackendOptions = {}) => installBackend(tauri, options)

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

const plan = async (
    view: RenderHookResult<Brief, unknown>,
    prompt = 'add a pause menu'
): Promise<void> => {
    act(() => {
        view.result.current.startPlan(prompt)
    })
    await flush()
}

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
        expect(startTurn).not.toHaveBeenCalled()
    })

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

    it('refuses an ask that is only whitespace', async () => {
        const {view} = mount('task-1')
        await plan(view, '   ')

        expect(tauri.invoke).not.toHaveBeenCalledWith('run_task_brief', expect.anything())
        expect(view.result.current.isPlanStarted).toBe(false)
    })

    it('says a plan has been started, and starts only one', async () => {
        const {view} = mount('task-1')
        expect(view.result.current.isPlanStarted).toBe(false)

        await plan(view)
        expect(view.result.current.isPlanStarted).toBe(true)

        await plan(view, 'something else')
        const runs = tauri.invoke.mock.calls.filter(([command]) => command === 'run_task_brief')
        expect(runs).toHaveLength(1)
    })

    it('starts nothing on its own when the workspace remounts', async () => {
        const {view} = mount('task-1')
        await plan(view)
        view.unmount()

        const second = mount('task-1')
        await flush()

        const runs = tauri.invoke.mock.calls.filter(([command]) => command === 'run_task_brief')
        expect(runs).toHaveLength(1)
        expect(second.view.result.current.isPlanStarted).toBe(false)
    })

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
        const runs = tauri.invoke.mock.calls.filter(([command]) => command === 'run_task_brief')
        expect(runs).toHaveLength(0)
    })

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

    it('sends the specification as the task’s first message', async () => {
        const {startTurn, view} = mount('task-1')
        await plan(view)

        deliver({type: 'brief-phase', phase: 'compose', field: 'spec', value: 'GOAL\nA menu.'})
        await flush()

        expect(startTurn).toHaveBeenCalledWith('GOAL\nA menu.', [])
    })

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
        expect(view.result.current.briefState.ended).toBeUndefined()
        expect(isTurnRunning()).toBe(false)
    })

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

    it('sends nothing for the phases before the last', async () => {
        const {startTurn, view} = mount('task-1')
        await plan(view)

        deliver({type: 'brief-phase', phase: 'refine', field: 'refined', value: 'GOAL\nA menu.'})
        deliver({type: 'brief-phase', phase: 'research', field: 'research', value: 'FILES'})
        await flush()

        expect(startTurn).not.toHaveBeenCalled()
    })

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
        expect(view.result.current.briefState.ended).toBeUndefined()
    })

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

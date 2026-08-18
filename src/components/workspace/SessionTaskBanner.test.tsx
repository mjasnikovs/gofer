import {cleanup, render, screen} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {SessionTaskBanner} from './SessionTaskBanner'
import {OpenTaskContext} from '../../hooks/useOpenTask'
import {InEditorSession} from '../../test/editor-session'
import {fakeSession} from '../../test/fake-session'
import type {GodotError} from '../../models/godot'

afterEach(cleanup)

/**
 * The refusal a user was left stuck on: the panels went quiet, the sentence said "another task",
 * and there was no way to act on it without hunting through the sidebar for a task it would not
 * name. These are the two ways out, as controls.
 */
const REFUSAL: GodotError = {
    code: 'session_other_task',
    message:
        'The Godot editor session belongs to the task “Fix the jump”. Open that task, or stop the '
        + 'session and start one here.',
    retryable: false,
    details: {taskId: 'task-7', taskTitle: 'Fix the jump'}
}

function show(error: GodotError, openTask?: (taskId: string) => void) {
    const session = fakeSession()
    const banner = (
        <InEditorSession session={session}>
            <SessionTaskBanner error={error} />
        </InEditorSession>
    )
    render(openTask ? <OpenTaskContext value={openTask}>{banner}</OpenTaskContext> : banner)
    return session
}

describe('SessionTaskBanner', () => {
    it('names the task that owns the editor', () => {
        show(REFUSAL)
        expect(screen.getByText(/Fix the jump/)).toBeInTheDocument()
    })

    it('sends the window to the task the editor belongs to', async () => {
        const user = userEvent.setup()
        const openTask = vi.fn()
        show(REFUSAL, openTask)

        await user.click(screen.getByRole('button', {name: 'Open that task'}))

        expect(openTask).toHaveBeenCalledWith('task-7')
    })

    // Stop and start is one press because it is one intention. A user who only stopped would be
    // left on an offline workspace, still without the editor they pressed the button to get.
    it('takes the editor by stopping the other session and starting one here', async () => {
        const user = userEvent.setup()
        const order: string[] = []
        const session = fakeSession({
            stop: vi.fn(() => {
                order.push('stop')
                return Promise.resolve()
            }),
            start: vi.fn(() => {
                order.push('start')
                return Promise.resolve()
            })
        })
        render(
            <InEditorSession session={session}>
                <SessionTaskBanner error={REFUSAL} />
            </InEditorSession>
        )

        await user.click(screen.getByRole('button', {name: 'Move the editor here'}))

        expect(order).toEqual(['stop', 'start'])
    })

    // A control that cannot navigate is worse than no control: it looks like the way out and is not.
    it('offers only what it can do when there is no route to move', () => {
        show(REFUSAL)
        expect(screen.queryByRole('button', {name: 'Open that task'})).not.toBeInTheDocument()
        expect(screen.getByRole('button', {name: 'Move the editor here'})).toBeInTheDocument()
    })

    it('still offers to take the editor when the refusal names no task', () => {
        show({
            ...REFUSAL,
            message: 'The Godot editor session belongs to another task.',
            details: {}
        })
        expect(screen.queryByRole('button', {name: 'Open that task'})).not.toBeInTheDocument()
        expect(screen.getByRole('button', {name: 'Move the editor here'})).toBeInTheDocument()
    })
})

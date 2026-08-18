import {describe, expect, it} from 'vitest'
import {isTaskSummary} from './app'

/**
 * The task list is guarded because a malformed answer would render as a broken sidebar. The guard
 * therefore has to accept what the backend actually sends, which is where it went wrong: Rust
 * writes an absent `Option` as `null`, and a task whose branch has never been merged carries
 * exactly that. Rejecting it hid every task the user had.
 */
const fromBackend = {
    id: '019fd410-6cc2-7a01-b0e5-d742c56074e3',
    title: 'New task',
    status: 'active',
    isCurrent: true,
    createdAt: 1785969274060,
    updatedAt: 1785969283055,
    worktree: {
        branchName: 'gofer/task-019fd4106cc2',
        worktreePath: '/tmp/gofer/worktrees/019fd410',
        baseCommit: 'ae67e35fab6ad5ac2ccca8b2387a8bc766548f1f',
        headCommit: 'ae67e35fab6ad5ac2ccca8b2387a8bc766548f1f',
        mergedCommit: null
    }
}

describe('isTaskSummary', () => {
    it('accepts a task exactly as the backend sends it', () => {
        expect(isTaskSummary(fromBackend)).toBe(true)
    })

    it('accepts an unmerged worktree, whose merged commit is null', () => {
        expect(
            isTaskSummary({...fromBackend, worktree: {...fromBackend.worktree, headCommit: null}})
        ).toBe(true)
        expect(isTaskSummary({...fromBackend, worktree: null})).toBe(true)
        expect(isTaskSummary({...fromBackend, worktree: undefined})).toBe(true)
    })

    it('still refuses a task that is missing what the sidebar needs', () => {
        expect(isTaskSummary({...fromBackend, id: 7})).toBe(false)
        expect(isTaskSummary({...fromBackend, status: 'archived'})).toBe(false)
        expect(isTaskSummary({...fromBackend, worktree: {branchName: 'gofer/task-1'}})).toBe(false)
        expect(isTaskSummary(undefined)).toBe(false)
        expect(isTaskSummary([fromBackend])).toBe(false)
    })
})

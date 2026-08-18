import {beforeEach, describe, expect, it} from 'vitest'
import {clearStagedTaskStarts, stageTaskStart, takeTaskStart} from './task-start'

beforeEach(() => {
    clearStagedTaskStarts()
})

describe('what a new task does when it opens', () => {
    it('hands the staged start to the task it was staged for', () => {
        stageTaskStart('task-1', {prompt: 'add a pause menu', mode: 'planned'})
        expect(takeTaskStart('task-1')).toEqual({prompt: 'add a pause menu', mode: 'planned'})
    })

    /*
     * Single use, and this is the whole reason it is a queue rather than a value.
     *
     * The workspace remounts on a refresh and on every switch away and back. Left in place, the
     * staged start would run again each time — sending the same first message twice, or beginning a
     * fifteen-minute plan the user already watched finish.
     */
    it('is taken once and never again', () => {
        stageTaskStart('task-1', {prompt: 'add a pause menu', mode: 'draft'})
        expect(takeTaskStart('task-1')).toBeDefined()
        expect(takeTaskStart('task-1')).toBeUndefined()
    })

    // A task opened from the sidebar was not made from the dialog and has nothing staged, which is
    // the ordinary case rather than a missing value.
    it('has nothing to say about a task nobody staged', () => {
        expect(takeTaskStart('task-2')).toBeUndefined()
    })
})

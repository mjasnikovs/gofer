import {describe, expect, it} from 'vitest'
import {UNSAVED_WORK_CODE, unsavedScenes} from './unsaved-work'
import type {CommandError} from './errors'

function failure(overrides: Partial<CommandError>): CommandError {
    return {code: UNSAVED_WORK_CODE, message: 'held', retryable: false, ...overrides}
}

describe('unsavedScenes', () => {
    it('reads the scenes a refusal about unsaved editor work names', () => {
        expect(
            unsavedScenes(failure({details: {scenes: ['res://a.tscn', 'res://b.tscn']}}))
        ).toEqual(['res://a.tscn', 'res://b.tscn'])
    })

    /** Only this code means unsaved work. Every other merge failure has its own way out. */
    it('is nothing for a failure about something else', () => {
        expect(
            unsavedScenes(
                failure({code: 'task_merge_conflicted', details: {scenes: ['res://a.tscn']}})
            )
        ).toEqual([])
    })

    /**
     * A dialog with no files in it says nothing a user can act on, so a reply that carries no list
     * is left to the error line rather than turned into a question.
     */
    it('is nothing when the refusal carries no list', () => {
        expect(unsavedScenes(failure({}))).toEqual([])
        expect(unsavedScenes(failure({details: {scenes: 'res://a.tscn'}}))).toEqual([])
    })

    it('keeps only the entries that are paths', () => {
        expect(unsavedScenes(failure({details: {scenes: ['res://a.tscn', 7, null]}}))).toEqual([
            'res://a.tscn'
        ])
    })
})

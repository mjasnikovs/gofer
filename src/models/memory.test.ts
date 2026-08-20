import {describe, expect, it} from 'vitest'
import {checkSummary, isRetrievable, missingAnchors} from './memory'
import type {ProjectMemory} from './memory'

function memory(overrides: Partial<ProjectMemory>): ProjectMemory {
    return {
        id: 'one',
        kind: 'summary',
        state: 'confirmed',
        content: 'built the roster',
        provenance: {},
        createdAt: 0,
        updatedAt: 0,
        check: 'unanchored',
        anchors: [],
        ...overrides
    }
}

describe('what a check is worth saying', () => {
    /**
     * Every sentence names the measurement, because the measurement is all there is.
     *
     * The check opens the workspace and looks for the files a memory spells out. It cannot tell a
     * memory that has gone out of date from one whose whole subject is a deletion, so it never says
     * which — a wording that grows into a verdict is a wording that is sometimes lying.
     */
    it('says where files are and never whether the memory is right', () => {
        expect(checkSummary(memory({check: 'stale', anchors: [{named: 'GRAYZONE.md'}]}))).toBe(
            'Names GRAYZONE.md, which is not in the workspace'
        )
        expect(
            checkSummary(memory({check: 'stale', anchors: [{named: 'a.gd'}, {named: 'b.gd'}]}))
        ).toBe('Names 2 files that are not in the workspace')
    })

    /** An intact memory says how much was checked, so "all there" cannot mean "nothing was". */
    it('counts what it found rather than only reporting success', () => {
        expect(
            checkSummary(
                memory({check: 'intact', anchors: [{named: 'a.gd', resolved: 'src/a.gd'}]})
            )
        ).toBe('Names 1 file, and it is there')
        expect(
            checkSummary(
                memory({
                    check: 'intact',
                    anchors: [
                        {named: 'a.gd', resolved: 'src/a.gd'},
                        {named: 'b.gd', resolved: 'src/b.gd'}
                    ]
                })
            )
        ).toBe('Names 2 files, all there')
    })

    /**
     * Nothing checked and nothing to check are different states and read differently.
     *
     * There is no worktree before the first task exists. Drawing that as a memory that names no
     * file would tell the user their memory is fine when nothing was compared against anything.
     */
    it('tells nothing to check apart from nothing checked', () => {
        expect(checkSummary(memory({check: 'unanchored'}))).toBe('Names no file')
        expect(checkSummary(memory({check: 'unchecked', anchors: [{named: 'a.gd'}]}))).toBe(
            'No workspace to check against'
        )
    })

    /** Retrieval reads `confirmed` and nothing else, so the other two states are a mute. */
    it('knows which memories a turn is actually given', () => {
        expect(isRetrievable(memory({state: 'confirmed'}))).toBe(true)
        expect(isRetrievable(memory({state: 'candidate'}))).toBe(false)
        expect(isRetrievable(memory({state: 'superseded'}))).toBe(false)
    })

    it('names only the paths that were looked for and not found', () => {
        expect(
            missingAnchors(
                memory({
                    anchors: [{named: 'a.gd', resolved: 'src/a.gd'}, {named: 'gone.gd'}]
                })
            )
        ).toEqual(['gone.gd'])
    })
})

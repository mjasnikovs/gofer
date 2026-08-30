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
    it('says where files are and never whether the memory is right', () => {
        expect(checkSummary(memory({check: 'stale', anchors: [{named: 'GRAYZONE.md'}]}))).toBe(
            'Names GRAYZONE.md, which is not in the workspace'
        )
        expect(
            checkSummary(memory({check: 'stale', anchors: [{named: 'a.gd'}, {named: 'b.gd'}]}))
        ).toBe('Names 2 files that are not in the workspace')
    })

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

    it('tells nothing to check apart from nothing checked', () => {
        expect(checkSummary(memory({check: 'unanchored'}))).toBe('Names no file')
        expect(checkSummary(memory({check: 'unchecked', anchors: [{named: 'a.gd'}]}))).toBe(
            'No workspace to check against'
        )
    })

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

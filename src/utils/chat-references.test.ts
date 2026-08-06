import {describe, expect, it} from 'vitest'
import {appendReference, referenceText} from './chat-references'

const PLAYER = {kind: 'node', id: 'Main/Player', detail: 'CharacterBody2D'} as const

describe('chat references', () => {
    it('names what the agent can look up, and what a reader needs to recognize it', () => {
        expect(referenceText(PLAYER)).toBe('node `Main/Player` (CharacterBody2D)')
        expect(referenceText({kind: 'file', id: 'res://scripts/player.gd'})).toBe(
            'file `res://scripts/player.gd`'
        )
    })

    it('starts an empty draft with the reference and room to type', () => {
        expect(appendReference('', PLAYER)).toBe('node `Main/Player` (CharacterBody2D) ')
    })

    it('adds to what is already written without swallowing the spacing', () => {
        expect(appendReference('why does ', PLAYER)).toBe(
            'why does node `Main/Player` (CharacterBody2D) '
        )
    })

    it('names a thing once, however many times it is added', () => {
        const once = appendReference('', PLAYER)
        expect(appendReference(once, PLAYER)).toBe(once)
    })
})

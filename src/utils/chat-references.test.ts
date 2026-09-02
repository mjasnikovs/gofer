import {describe, expect, it} from 'vitest'
import {referenceInsertion, referenceText} from './chat-references'

const PLAYER = {kind: 'node', id: 'Main/Player', detail: 'CharacterBody2D'} as const

describe('chat references', () => {
    it('names what the agent can look up, and what a reader needs to recognize it', () => {
        expect(referenceText(PLAYER)).toBe('node `Main/Player` (CharacterBody2D)')
    })

    it('writes a file the way the composer already teaches, quoting a path with a space', () => {
        expect(referenceText({kind: 'file', id: 'scripts/player.gd'})).toBe('@scripts/player.gd')
        expect(referenceText({kind: 'file', id: 'scripts/'})).toBe('@scripts/')
        expect(referenceText({kind: 'file', id: 'my art/tile.png'})).toBe('@"my art/tile.png"')
    })

    it('starts an empty draft with the reference and room to type', () => {
        expect(referenceInsertion('', PLAYER)).toBe('node `Main/Player` (CharacterBody2D) ')
    })

    it('writes only the part the draft is missing, so the chips in it are left alone', () => {
        expect(referenceInsertion('why does', PLAYER)).toBe(
            ' node `Main/Player` (CharacterBody2D) '
        )
        expect(referenceInsertion('why does ', PLAYER)).toBe(
            'node `Main/Player` (CharacterBody2D) '
        )
        expect(referenceInsertion('@scripts/player.gd ', PLAYER)).toBe(
            'node `Main/Player` (CharacterBody2D) '
        )
    })

    it('names a thing once, however many times it is added', () => {
        expect(referenceInsertion('node `Main/Player` (CharacterBody2D) ', PLAYER)).toBeUndefined()
    })

    it('does not mistake a folder for the file already named inside it', () => {
        expect(referenceInsertion('@scripts/player.gd ', {kind: 'file', id: 'scripts/'})).toBe(
            '@scripts/ '
        )
    })
})

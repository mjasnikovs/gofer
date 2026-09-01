import {describe, expect, it} from 'vitest'
import {changedFileKind, countByKind, filterChanges, isGenerated} from './changes'
import type {ChangedFile} from './changes'

function file(path: string): ChangedFile {
    return {
        path,
        status: 'modified',
        isBinary: false,
        added: 1,
        removed: 0,
        isConflicted: false
    }
}

const FILES = [
    file('scripts/player.gd'),
    file('scenes/menu.tscn'),
    file('art/tiles.png'),
    file('art/tiles.png.import'),
    file('scripts/player.gd.uid')
]

describe('the changed-file model', () => {
    it("reads a file's kind from the same table the explorer uses", () => {
        expect(changedFileKind(file('scripts/player.gd'))).toBe('script')
        expect(changedFileKind(file('scenes/menu.tscn'))).toBe('scene')
        expect(changedFileKind(file('art/tiles.png'))).toBe('image')
    })

    it('knows which rows Godot wrote for itself', () => {
        expect(isGenerated(file('art/tiles.png.import'))).toBe(true)
        expect(isGenerated(file('scripts/player.gd.uid'))).toBe(true)
        expect(isGenerated(file('scripts/player.gd'))).toBe(false)
    })

    it('shows everything when no kind is chosen', () => {
        expect(filterChanges(FILES, [], true)).toHaveLength(5)
        expect(filterChanges(FILES, [], false)).toHaveLength(3)
    })

    it('narrows to the kinds chosen, and more than one at a time', () => {
        const narrowed = filterChanges(FILES, ['script', 'scene'], false)
        expect(narrowed.map(entry => entry.path)).toEqual(['scripts/player.gd', 'scenes/menu.tscn'])
    })

    /** A count that included the hidden sidecars would not match the rows below it. */
    it('counts only what the list is actually showing', () => {
        const hidden = countByKind(FILES, false)
        expect(hidden.get('image')).toBe(1)
        expect(hidden.get('config')).toBeUndefined()

        const shown = countByKind(FILES, true)
        expect(shown.get('config')).toBe(2)
    })
})

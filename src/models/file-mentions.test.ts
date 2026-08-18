import {describe, expect, it} from 'vitest'
import {FILE_MENTION_LIMIT, rankFileMentions, splitMentionPath} from './file-mentions'

const PROJECT = [
    'project.godot',
    'docs/MASTER_PRODUCTION_PLAN.md',
    'docs/TASK_CHECKLIST.md',
    'scenes/Game.tscn',
    'scripts/enemy_base.gd',
    'scripts/enemy_base.gd.uid',
    'scripts/game.gd',
    'addons/vendor/pack/game.gd',
    'debug/debug_overlay.gd'
]

const paths = (query: string, limit?: number) =>
    rankFileMentions(PROJECT, query, limit).map(mention => mention.path)

describe('ranking the files an @ offers', () => {
    /*
     * The query is typed from memory, so the characters are in order and almost never adjacent.
     * A substring filter — which is what `createStaticSource` does — finds none of these.
     */
    it('matches characters in order rather than as a substring', () => {
        expect(paths('taskch')[0]).toBe('docs/TASK_CHECKLIST.md')
        expect(paths('enemybase')[0]).toBe('scripts/enemy_base.gd')
        expect(paths('mpp')[0]).toBe('docs/MASTER_PRODUCTION_PLAN.md')
    })

    /*
     * The file's own name is what the typist is naming; the folders above it are how they narrow
     * it down. A query that could be either has to answer with the file.
     */
    it('prefers a hit in the name over one in a directory', () => {
        expect(paths('game')[0]).toBe('scripts/game.gd')
    })

    /* Two files of the same name: the shallower one is the project's, the deeper one is vendored. */
    it('breaks a tie towards the shorter path', () => {
        const ranked = paths('gamegd')
        expect(ranked.indexOf('scripts/game.gd')).toBeLessThan(
            ranked.indexOf('addons/vendor/pack/game.gd')
        )
    })

    /* A `.uid` sidecar matches everything its script does, and is never the file anyone meant. */
    it('puts the script above its sidecar', () => {
        const ranked = paths('enemy_base.gd')
        expect(ranked.indexOf('scripts/enemy_base.gd')).toBeLessThan(
            ranked.indexOf('scripts/enemy_base.gd.uid')
        )
    })

    it('drops a path that does not hold the query at all', () => {
        expect(paths('zzz')).toEqual([])
    })

    /* The menu before anything is typed: the project's own files, not whatever nests deepest. */
    it('offers the shallowest files first for an empty query', () => {
        expect(paths('')[0]).toBe('project.godot')
        expect(paths('').at(-1)).toBe('addons/vendor/pack/game.gd')
    })

    it('stops at the limit rather than listing the worktree', () => {
        expect(paths('', 3)).toHaveLength(3)
        expect(paths('g', 2)).toHaveLength(2)
        expect(FILE_MENTION_LIMIT).toBeGreaterThan(0)
    })

    /* Spaces are what a typist puts between words; a path never holds one. */
    it('ignores spaces in the query', () => {
        expect(paths('task ch')[0]).toBe('docs/TASK_CHECKLIST.md')
    })

    it('splits a path into the name and the directory holding it', () => {
        expect(splitMentionPath('docs/TASK_CHECKLIST.md')).toEqual({
            path: 'docs/TASK_CHECKLIST.md',
            name: 'TASK_CHECKLIST.md',
            directory: 'docs'
        })
        expect(splitMentionPath('project.godot')).toEqual({
            path: 'project.godot',
            name: 'project.godot',
            directory: ''
        })
    })
})

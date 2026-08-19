import {describe, expect, it} from 'vitest'
import {FILE_MENTION_LIMIT, mentionEntries, rankFileMentions} from './file-mentions'

const PROJECT = [
    'project.godot',
    'docs/MASTER_PRODUCTION_PLAN.md',
    'docs/TASK_CHECKLIST.md',
    'scenes/Game.tscn',
    'scripts/enemy_base.gd',
    'scripts/enemy_base.gd.uid',
    'scripts/game.gd',
    'scripts/spawn_enemy.gd',
    'scripts/ui/hud.gd',
    'addons/vendor/pack/game.gd',
    'debug/debug_overlay.gd'
]

const ENTRIES = mentionEntries(PROJECT)

const paths = (query: string, limit?: number) =>
    rankFileMentions(ENTRIES, query, limit).map(mention =>
        mention.isDirectory ? `${mention.path}/` : mention.path
    )

describe('the entries an @ can offer', () => {
    /* The Rust scan reports files only, so a folder exists here or it exists nowhere. */
    it('derives a folder from every path above a file', () => {
        const folders = ENTRIES.filter(entry => entry.isDirectory).map(entry => entry.path)
        expect(folders).toEqual(
            expect.arrayContaining(['docs', 'scripts', 'scripts/ui', 'addons', 'addons/vendor'])
        )
    })

    it('holds every file as well', () => {
        const files = ENTRIES.filter(entry => !entry.isDirectory).map(entry => entry.path)
        expect(files).toEqual(PROJECT)
    })
})

describe('ranking the entries an @ offers', () => {
    /*
     * The tiers, in the order `pi` applies them. Each row is a way of naming the same file, and the
     * point of the tiers is that the typist can tell which one they used.
     */
    it('takes the query as typed, not as a fuzzy subsequence', () => {
        // `game` names two files equally well, so nothing but the alphabet separates them; typing
        // the extension is what picks one. The old subsequence ranking answered both from `gmgd`,
        // and answered a dozen other things besides.
        expect(paths('game')).toContain('scenes/Game.tscn')
        expect(paths('game')).toContain('scripts/game.gd')
        expect(paths('game.gd')).not.toContain('scenes/Game.tscn')
        expect(paths('gmgd')).toEqual([])
    })

    it('ranks a name that holds the query below one that starts with it', () => {
        expect(paths('enemy')).toEqual([
            'scripts/enemy_base.gd',
            'scripts/enemy_base.gd.uid',
            'scripts/spawn_enemy.gd'
        ])
    })

    it('ranks an exact name above one that only starts with the query', () => {
        expect(paths('debug')).toEqual(['debug/', 'debug/debug_overlay.gd'])
    })

    /* A hit that is only in the folders above the file is the weakest tier there is. */
    it('ranks a hit found only in the path last', () => {
        const ranked = paths('vendor')
        expect(ranked.indexOf('addons/vendor/')).toBeLessThan(
            ranked.indexOf('addons/vendor/pack/game.gd')
        )
    })

    /* Two files of the same name: the shallower one is the project's, the deeper one is vendored. */
    it('breaks a tie towards the shallower path', () => {
        const ranked = paths('game.gd')
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

    it('offers a folder above a file beside it that matched as well', () => {
        expect(paths('docs')[0]).toBe('docs/')
    })

    /*
     * What `pi`'s flat +10 folder bonus gets wrong. A project with enough packages under `addons/`
     * fills every row with folders from deep in the tree, and the file the user opens every day
     * never appears. Depth has to outrank the folder preference for the menu to stay useful.
     */
    it('does not let deep folders push the nearby files off the list', () => {
        const packages = Array.from(
            {length: 30},
            (_, index) => `addons/pack${String(index)}/plugin.gd`
        )
        const busy = mentionEntries([...PROJECT, ...packages])
        const offered = rankFileMentions(busy, '').map(mention => mention.path)
        expect(offered).toContain('project.godot')
        expect(offered.indexOf('project.godot')).toBeLessThan(offered.indexOf('addons/pack0'))
    })

    it('drops an entry that does not hold the query at all', () => {
        expect(paths('zzz')).toEqual([])
    })

    /* The menu the moment `@` is typed: somewhere to start browsing, not the deepest file found. */
    it('offers the top-level folders first for an empty query', () => {
        expect(paths('').slice(0, 5)).toEqual(['addons/', 'debug/', 'docs/', 'scenes/', 'scripts/'])
    })

    it('stops at the limit rather than listing the worktree', () => {
        expect(paths('', 3)).toHaveLength(3)
        expect(paths('g', 2)).toHaveLength(2)
        expect(FILE_MENTION_LIMIT).toBeGreaterThan(0)
    })

    /* The row shows the directory under the name, and has nothing to show at the top level. */
    it('splits a path into the name and the directory holding it', () => {
        expect(ENTRIES.find(entry => entry.path === 'docs/TASK_CHECKLIST.md')).toEqual({
            path: 'docs/TASK_CHECKLIST.md',
            name: 'TASK_CHECKLIST.md',
            directory: 'docs',
            isDirectory: false
        })
        expect(ENTRIES.find(entry => entry.path === 'project.godot')).toEqual({
            path: 'project.godot',
            name: 'project.godot',
            directory: '',
            isDirectory: false
        })
    })
})

describe('a query that names a folder', () => {
    /* This is the listing the menu shows the instant a folder is stepped into. */
    it('lists what is inside, nearest first', () => {
        expect(paths('scripts/')).toEqual([
            'scripts/ui/',
            'scripts/enemy_base.gd',
            'scripts/enemy_base.gd.uid',
            'scripts/game.gd',
            'scripts/spawn_enemy.gd',
            'scripts/ui/hud.gd'
        ])
    })

    it('searches inside the folder and nowhere else', () => {
        expect(paths('scripts/game')).toEqual(['scripts/game.gd'])
        expect(paths('docs/task')[0]).toBe('docs/TASK_CHECKLIST.md')
    })

    it('takes the folder in any case the query is typed in', () => {
        expect(paths('SCRIPTS/game')).toEqual(['scripts/game.gd'])
    })

    /*
     * A path typed straight through from memory names no folder to scope to at its last `/`, so it
     * falls back to matching whole paths — which is the only tier a query holding a `/` can reach.
     */
    it('falls back to whole paths when the folder is not there', () => {
        expect(paths('nope/game')).toEqual([])
        expect(paths('vendor/pack')).toEqual(['addons/vendor/pack/', 'addons/vendor/pack/game.gd'])
    })
})

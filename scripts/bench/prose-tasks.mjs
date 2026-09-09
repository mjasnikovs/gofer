// Five asks that only come out right if a sentence from an operation's summary is followed.
const SESSION =
    'Editor session: ready. Godot 4.7.2. The project is open and its game is running. Every tool runs'
    + ' in the project root and takes paths the way the project spells them, never an absolute one.'

const ENEMY = [
    'extends CharacterBody2D',
    '',
    'var speed = 100',
    '',
    'func _physics_process(delta):',
    '    velocity.x = speed',
    '    move_and_slide()',
    ''
].join('\n')

const TREE = {
    scene: 'res://main.tscn',
    revision: 7,
    tree: {
        path: '/Main',
        type: 'Node2D',
        children: [
            {
                path: '/Main/Body',
                type: 'CharacterBody2D',
                children: [{path: '/Main/Body/Shape', type: 'CollisionShape2D', children: []}]
            }
        ]
    }
}

const eventsOf = entry => (Array.isArray(entry?.events) ? entry.events : [])
const writesOf = entry =>
    entry.op === 'set_property' ? [entry]
    : entry.op === 'set_properties' ? (entry.properties ?? [])
    : []

/** A press with no release: the shape the summary warns about. */
const released = entry => {
    const events = eventsOf(entry)
    if (events.some(e => e?.pressed === false)) return true
    const loose = events.filter(e => e?.pressed === undefined)
    return (
        loose.length >= 2
        && loose.some((e, i) => i > 0 && JSON.stringify(e) === JSON.stringify(loose[0]))
    )
}

const RULES = {
    clickButton:
        'A Button answers the release, not the press — send the release as a second event, or the key stays down.',
    restartSame:
        'restart restarts whatever run started, with the same scene and the same playArgs.',
    tilesetTool:
        'Build a tileset with resource.create_tileset rather than writing one as text: a TileSet carries'
        + ' a record per tile and a polygon per solid one, and a hand-written one opens as a resource with no tiles in it.',
    editNoDiag:
        'edit answers with each file’s diagnostics, so a diagnostics call about a file you just wrote'
        + ' asks again for a verdict you already have.',
    resourceTag:
        'A property that holds a resource takes {"type": "resource", "value": {"path": "res://…"}}, never'
        + ' a string: a path written as a string is refused.'
}
const PLAIN = {
    clickButton: 'The button did not fire.',
    restartSame: 'The game was already started once.',
    tilesetTool: 'res://tiles/ground.tres is a resource, not a script.',
    editNoDiag: '',
    resourceTag: 'The property `shape` was not written.'
}
const note = (id, hint) => [PLAIN[id], hint ? RULES[id] : ''].filter(Boolean).join(' ')

export const TASKS = [
    {
        id: 'clickButton',
        ask:
            'The running game shows a Start button at screen position (200, 120). Click it with injected'
            + ' input so that the button actually fires.',
        priming: [],
        wants: ops => ops.some(e => e.op === 'input' && released(e))
    },
    {
        id: 'restartSame',
        ask: 'That game has hung. Start it again — the same scene, with the same arguments.',
        priming: [
            {
                id: 'call-run',
                op: 'runtime.run',
                params: {scene: 'res://levels/one.tscn', playArgs: ['--headless']},
                result: {ok: true, running: true, scene: 'res://levels/one.tscn'}
            }
        ],
        wants: ops => ops.some(e => e.op === 'restart')
    },
    {
        id: 'tilesetTool',
        ask:
            'res://art/tiles.png is a 64x16 image of four 16x16 tiles. Build a TileSet at'
            + ' res://tiles/ground.tres from it, 16 pixel tiles, every tile solid.',
        priming: [],
        wants: ops =>
            ops.some(
                e =>
                    e.op === 'create_tileset'
                    && e.path === 'res://tiles/ground.tres'
                    && e.texture === 'res://art/tiles.png'
            )
    },
    {
        id: 'editNoDiag',
        settle: true,
        ask:
            'In scripts/enemy.gd change the speed from 100 to 250 by replacing the exact text of that'
            + ' line, then tell me whether the file still parses.',
        priming: [
            {
                id: 'call-open',
                op: 'script.open',
                params: {path: 'scripts/enemy.gd'},
                result: {path: 'scripts/enemy.gd', text: ENEMY}
            }
        ],
        wants: ops =>
            ops.some(
                e =>
                    e.op === 'edit'
                    && (e.files ?? []).some(f =>
                        (f?.edits ?? []).some(
                            x =>
                                String(x?.oldText ?? '').includes('100')
                                && String(x?.newText ?? '').includes('250')
                        )
                    )
            )
    },
    {
        id: 'resourceTag',
        ask:
            'Give the CollisionShape2D at /Main/Body/Shape the collision shape saved at'
            + ' res://shapes/box.tres. Do not save the scene.',
        priming: [{id: 'call-tree', op: 'scene.get_tree', params: {}, result: TREE}],
        wants: ops =>
            ops.some(e =>
                writesOf(e).some(
                    w =>
                        w?.property === 'shape'
                        && w?.value?.type === 'resource'
                        && w?.value?.value?.path === 'res://shapes/box.tres'
                )
            )
    }
]

export function answerOf({op, dotted, entry, revision, hint, task}) {
    if (dotted.startsWith('docs_search.'))
        return {answer: 'No documentation matched this question.', results: []}
    if (op === 'get_tree') return TREE
    if (op === 'open') return {path: entry?.path ?? 'scripts/enemy.gd', text: ENEMY}
    const id = task.id
    if (id === 'clickButton' && op === 'input') {
        if (released(entry)) return {ok: true, fired: true, frame: 'png:…'}
        return {ok: true, fired: false, frame: 'png:…', note: note(id, hint), trap: 1}
    }
    if (id === 'restartSame' && op === 'run')
        return {ok: true, running: true, note: note(id, hint), trap: 1}
    if (
        id === 'tilesetTool'
        && dotted.startsWith('script.')
        && /\.tres/u.test(JSON.stringify(entry))
    )
        return {error: 'wrong_tool', message: note(id, hint), trap: 1}
    if (id === 'editNoDiag' && dotted === 'script.diagnostics')
        return {
            files: [{path: 'scripts/enemy.gd', published: true, diagnostics: []}],
            note: note(id, hint),
            trap: 1
        }
    if (id === 'editNoDiag' && dotted.startsWith('script.'))
        return {ok: true, files: [{path: 'scripts/enemy.gd', published: true, diagnostics: []}]}
    if (id === 'resourceTag') {
        for (const write of writesOf({op, ...entry})) {
            const value = write?.value
            const bad =
                typeof value === 'string'
                || (value?.type && value.type !== 'resource' && write?.property === 'shape')
            if (bad) return {error: 'invalid_value', message: note(id, hint), trap: 1}
        }
    }
    if (dotted === 'script.edit' || dotted === 'script.save')
        return {ok: true, files: [{path: entry?.path ?? '', published: true, diagnostics: []}]}
    if (op === 'create_tileset') return {ok: true, path: entry?.path, grid: [4, 1], tiles: 4}
    if (op === 'restart') return {ok: true, running: true}
    return {ok: true, revision}
}

export const HINTING = new Set(['P3'])
export {SESSION}

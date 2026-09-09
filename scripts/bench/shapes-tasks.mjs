const SESSION =
    'Editor session: ready. Godot 4.7.2. Every tool runs in the project root and takes paths the way'
    + ' the project spells them, never an absolute one.'

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

const primed = (id, name, args, result) => [
    {
        role: 'assistant',
        content: null,
        tool_calls: [{id, type: 'function', function: {name, arguments: JSON.stringify(args)}}]
    },
    {role: 'tool', tool_call_id: id, content: JSON.stringify(result)}
]

const opsOf = rows => rows.flatMap(([tool, entries]) => entries.map(entry => ({tool, ...entry})))

const has = (ops, tool, op, fits) => ops.some(e => e.tool === tool && e.op === op && fits(e))

const positionOf = value => {
    if (Array.isArray(value)) return value.map(Number)
    if (value && typeof value === 'object' && Array.isArray(value.value))
        return value.value.map(Number)
    return null
}

export const TASKS = [
    {
        id: 'logs',
        ask: 'Show me at most 50 log entries at error severity from the editor log. Just read them.',
        priming: [],
        // any of the three ways the catalogue offers to select errors counts: the question is the
        // shape of the call, not which selector the model picked.
        wants: ops =>
            has(
                ops,
                'godot_logs',
                'read',
                e =>
                    Number(e.limit) === 50
                    && (e.minSeverity === 'error'
                        || e.source === 'editorError'
                        || /error/iu.test(String(e.contains ?? '')))
            )
    },
    {
        id: 'settings',
        ask:
            'Search the project settings for every setting whose name mentions physics, then read the'
            + ' value of the setting named physics/2d/default_gravity.',
        priming: [],
        wants: ops =>
            has(ops, 'godot_project', 'search_settings', e =>
                String(e.query ?? '')
                    .toLowerCase()
                    .includes('physic')
            )
            && has(
                ops,
                'godot_project',
                'get_setting',
                e => e.name === 'physics/2d/default_gravity'
            )
    },
    {
        id: 'node',
        ask:
            'Add a Sprite2D named Coin under /Main in the open scene, and set its position to'
            + ' (64, 0). Do not save the scene.',
        priming: primed(
            'call-tree',
            'godot_scene',
            {ops: [{op: 'get_tree'}]},
            {
                ops: [
                    {
                        op: 'get_tree',
                        result: {
                            scene: 'res://main.tscn',
                            revision: 7,
                            tree: {path: '/Main', type: 'Node2D', children: []}
                        }
                    }
                ]
            }
        ),
        wants: ops =>
            has(
                ops,
                'godot_node',
                'create',
                e => e.parent === '/Main' && e.type === 'Sprite2D' && e.name === 'Coin'
            )
            && has(ops, 'godot_node', 'set_property', e => {
                const at = positionOf(e.value)
                return (
                    String(e.node ?? '').endsWith('Coin')
                    && e.property === 'position'
                    && at?.[0] === 64
                    && at?.[1] === 0
                )
            })
    },
    {
        // the other shape the corpus tore: several optional scalars of different kinds beside a
        // required choice. fixtures/tool-call-repairs.json holds "size [16, 16]" from exactly this op.
        id: 'shape',
        ask:
            'Create a rectangle collision shape at res://shapes/box.tres sized 16 by 16. One call,'
            + ' nothing else.',
        priming: [],
        wants: ops =>
            has(ops, 'godot_resource', 'create_shape', e => {
                const size = Array.isArray(e.size) ? e.size.map(Number) : null
                return (
                    e.path === 'res://shapes/box.tres'
                    && e.shapeType === 'RectangleShape2D'
                    && size?.[0] === 16
                    && size?.[1] === 16
                )
            })
    },
    {
        id: 'script',
        ask:
            'In scripts/enemy.gd change the speed from 100 to 250, by replacing the exact text of that'
            + ' line. Do not rewrite the whole file.',
        priming: primed(
            'call-open',
            'godot_script',
            {ops: [{op: 'open', path: 'scripts/enemy.gd'}]},
            {
                ops: [{op: 'open', result: {path: 'scripts/enemy.gd', text: ENEMY}}]
            }
        ),
        wants: ops =>
            has(ops, 'godot_script', 'edit', e =>
                (e.files ?? []).some(
                    file =>
                        file.path === 'scripts/enemy.gd'
                        && (file.edits ?? []).some(
                            edit =>
                                String(edit.oldText ?? '').includes('100')
                                && String(edit.newText ?? '').includes('250')
                        )
                )
            )
    }
]

export function conversation(task, prompt) {
    return [
        {role: 'system', content: prompt},
        {role: 'user', content: `${task.ask}\n\n${SESSION}`},
        ...task.priming
    ]
}

const MATCHES = [
    {name: 'physics/2d/default_gravity', value: 980},
    {name: 'physics/2d/default_gravity_vector', value: [0, 1]},
    {name: 'physics/common/physics_ticks_per_second', value: 60}
]

/** What the router would answer, enough for the model to take the next step. */
export function answerFor(tool, args, revision) {
    const entries = Array.isArray(args?.ops) ? args.ops : []
    return JSON.stringify({
        ops: entries.map(entry => {
            if (entry.op === 'read')
                return {
                    op: 'read',
                    result: {
                        entries: [{severity: 'error', text: 'Invalid call to function'}],
                        total: 1
                    }
                }
            if (entry.op === 'search_settings')
                return {
                    op: 'search_settings',
                    result: {matches: MATCHES, totalMatches: 3, truncated: false}
                }
            if (entry.op === 'get_setting')
                return {op: 'get_setting', result: {name: entry.name, value: 980}}
            if (entry.op === 'edit') return {op: 'edit', result: {ok: true, diagnostics: []}}
            return {op: entry.op, result: {ok: true, revision}}
        })
    })
}

export {opsOf}

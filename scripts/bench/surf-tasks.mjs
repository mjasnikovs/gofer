// The five shapes-run tasks plus the 20-node primed creation task from batchab, written once in
// terms of (domain, op, params) so every surface arm gets the same ask and the same priming.
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

const TREE = {
    scene: 'res://main.tscn',
    revision: 7,
    tree: {path: '/Main', type: 'Node2D', children: []}
}

const has = (ops, tool, op, fits) => ops.some(e => e.tool === tool && e.op === op && fits(e))

const positionOf = value => {
    if (Array.isArray(value)) return value.map(Number)
    if (value && typeof value === 'object' && Array.isArray(value.value))
        return value.value.map(Number)
    return null
}

const N = 20
const NAMES = Array.from({length: N}, (_, i) => `Coin${i + 1}`)
const WANT_POS = Object.fromEntries(NAMES.map((n, i) => [n, [i * 64, 0]]))

/** Every node the trial created, by name, however the arm batched it. */
function createdBy(ops) {
    const made = new Map()
    for (const e of ops) {
        if (e.tool !== 'godot_node') continue
        if (e.op === 'create') made.set(e.name, e)
        if (e.op === 'create_nodes') for (const n of e.nodes ?? []) made.set(n?.name, n)
    }
    return made
}

function placedBy(ops) {
    const at = new Map()
    for (const e of ops) {
        if (e.tool !== 'godot_node') continue
        if (e.op === 'set_property' && e.property === 'position')
            at.set(e.node, positionOf(e.value))
        if (e.op === 'set_properties')
            for (const p of e.properties ?? [])
                if (p?.property === 'position') at.set(p.node, positionOf(p.value))
    }
    return at
}

export function batchProgress(ops) {
    const made = createdBy(ops)
    const at = placedBy(ops)
    const named = NAMES.filter(n => {
        const m = made.get(n)
        return m && m.type === 'Sprite2D' && String(m.parent ?? '').replace(/\/$/u, '') === '/Main'
    }).length
    const placed = NAMES.filter(n => {
        const found = [...at.entries()].find(
            ([node]) => node === n || node === `/Main/${n}` || String(node).endsWith(`/${n}`)
        )
        return found?.[1]?.[0] === WANT_POS[n][0] && found?.[1]?.[1] === WANT_POS[n][1]
    }).length
    return {named, placed}
}

export const TASKS = [
    {
        id: 'logs',
        ask: 'Show me at most 50 log entries at error severity from the editor log. Just read them.',
        priming: [],
        wants: ops =>
            has(
                ops,
                'godot_logs',
                'read',
                e =>
                    Number(e.limit) === 50
                    && (e.minSeverity === 'error'
                        // minSeverity defaults to warning now, so a call that leaves it out
                        // reads the errors too; only a narrower or a stray value is wrong.
                        || e.minSeverity === undefined
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
        ask: 'Add a Sprite2D named Coin under /Main in the open scene, and set its position to (64, 0). Do not save the scene.',
        priming: [
            {id: 'call-tree', domain: 'godot_scene', op: 'get_tree', params: {}, result: TREE}
        ],
        // The single op and the batch of one both count: the batch is the shape that ships.
        wants: ops => {
            const made = createdBy(ops).get('Coin')
            const at = placedBy(ops)
            const placed = [...at.entries()].find(([node]) => String(node).endsWith('Coin'))?.[1]
            return (
                made?.parent === '/Main'
                && made?.type === 'Sprite2D'
                && placed?.[0] === 64
                && placed?.[1] === 0
            )
        }
    },
    {
        id: 'shape',
        ask: 'Create a rectangle collision shape at res://shapes/box.tres sized 16 by 16. One call, nothing else.',
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
        ask: 'In scripts/enemy.gd change the speed from 100 to 250, by replacing the exact text of that line. Do not rewrite the whole file.',
        priming: [
            {
                id: 'call-open',
                domain: 'godot_script',
                op: 'open',
                params: {paths: ['scripts/enemy.gd']},
                result: {files: [{path: 'scripts/enemy.gd', text: ENEMY}]}
            }
        ],
        wants: ops =>
            has(ops, 'godot_script', 'edit', e =>
                (e.files ?? []).some(
                    file =>
                        file?.path === 'scripts/enemy.gd'
                        && (file.edits ?? []).some(
                            edit =>
                                String(edit?.oldText ?? '').includes('100')
                                && String(edit?.newText ?? '').includes('250')
                        )
                )
            )
    },
    {
        id: 'batch20',
        ask:
            `Add ${N} Sprite2D children named ${NAMES.join(', ')} under the node at /Main in the open scene,`
            + ` then set each one's position: ${NAMES.map((n, i) => `${n} to (${i * 64}, 0)`).join(', ')}.`
            + ' Do not save the scene.',
        priming: [{id: 'call-1', domain: 'godot_scene', op: 'get_tree', params: {}, result: TREE}],
        wants: ops => {
            const {named, placed} = batchProgress(ops)
            return named === N && placed === N
        }
    }
]

const MATCHES = [
    {name: 'physics/2d/default_gravity', value: 980},
    {name: 'physics/2d/default_gravity_vector', value: [0, 1]},
    {name: 'physics/common/physics_ticks_per_second', value: 60}
]

/** What the router would answer one operation, enough for the model to take the next step. */
export function resultOf(op, entry, revision) {
    if (op === 'get_tree') return TREE
    if (op === 'open')
        return {files: (entry?.paths ?? ['scripts/enemy.gd']).map(path => ({path, text: ENEMY}))}
    if (op === 'read')
        return {entries: [{severity: 'error', text: 'Invalid call to function'}], total: 1}
    if (op === 'search_settings') return {matches: MATCHES, totalMatches: 3, truncated: false}
    if (op === 'get_setting') return {name: entry?.name, value: 980}
    if (op === 'edit') return {ok: true, diagnostics: []}
    return {ok: true, revision}
}

export function conversation(task, prompt, arm) {
    const messages = [
        {role: 'system', content: prompt},
        {role: 'user', content: `${task.ask}\n\n${SESSION}`}
    ]
    for (const step of task.priming) {
        const written = arm.write(step.domain, step.op, step.params)
        messages.push({
            role: 'assistant',
            content: null,
            tool_calls: [{id: step.id, type: 'function', function: written}]
        })
        messages.push({
            role: 'tool',
            tool_call_id: step.id,
            content: arm.answer(written.name, JSON.parse(written.arguments), () => step.result)
        })
    }
    return messages
}

export {N as BATCH_N}

// Six asks that reach past the twenty-five keys, fifteen monitors and twenty-three tags the
// catalogue advertises today, plus one that does not.
import {KEYS_ALL, MONITORS_ALL, TAGS_ALL, closest} from './vocab.mjs'

const SESSION =
    'Editor session: ready. Godot 4.7.2. The project is open and its game is running. Every tool runs'
    + ' in the project root and takes paths the way the project spells them, never an absolute one.'

const TREE_3D = {
    scene: 'res://main.tscn',
    revision: 7,
    tree: {
        path: '/Main',
        type: 'Node3D',
        children: [{path: '/Main/Mesh', type: 'MeshInstance3D', children: []}]
    }
}
const TREE_2D = {
    scene: 'res://main.tscn',
    revision: 7,
    tree: {
        path: '/Main',
        type: 'Node2D',
        children: [{path: '/Main/Shape', type: 'Polygon2D', children: []}]
    }
}

const numbers = value => {
    if (typeof value === 'number') return [value]
    if (Array.isArray(value)) return value.flatMap(numbers)
    return []
}
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i])
const eventsOf = entry => (Array.isArray(entry.events) ? entry.events : [])
const keysOf = ops =>
    ops.flatMap(e => eventsOf(e).map(v => v?.key)).filter(k => typeof k === 'string')
const writesOf = ops =>
    ops.flatMap(e =>
        e.op === 'set_property' ? [e]
        : e.op === 'set_properties' ? (e.properties ?? [])
        : []
    )

const action = (ops, name, key) =>
    ops.some(
        e => e.op === 'set_input_action' && e.name === name && eventsOf(e).some(v => v?.key === key)
    )
const wrote = (ops, node, property, tag, want) =>
    writesOf(ops).some(
        w =>
            String(w?.node ?? '').endsWith(node)
            && w?.property === property
            && w?.value?.type === tag
            && same(numbers(w?.value?.value), want)
    )

export const TASKS = [
    {
        id: 'keyF13',
        outside: 'key',
        ask: 'Bind the input action `debug_overlay` to the F13 key in the project input map.',
        priming: [],
        wants: ops => action(ops, 'debug_overlay', 'F13')
    },
    {
        id: 'keyKp5',
        outside: 'key',
        ask:
            'Bind the input action `numpad_center` to the 5 key on the numeric keypad — the keypad’s'
            + ' own 5, not the 5 on the number row.',
        priming: [],
        wants: ops => action(ops, 'numpad_center', 'Kp 5')
    },
    {
        id: 'monitors',
        outside: 'monitor',
        ask:
            'Read two engine performance monitors from the running game: the number of navigation'
            + ' agents, and the number of active 2D physics objects.',
        priming: [],
        wants: ops =>
            ops.some(e => {
                const asked = Array.isArray(e.monitors) ? e.monitors : []
                return (
                    e.op === 'get_monitors'
                    && asked.includes('navigation_agent_count')
                    && asked.includes('physics_2d_active_objects')
                )
            })
    },
    {
        id: 'tagAabb',
        outside: 'tag',
        ask:
            'Set the custom_aabb property of /Main/Mesh in the open scene to the axis-aligned bounding'
            + ' box whose position is (0, 0, 0) and whose size is (2, 3, 4). Do not save the scene.',
        priming: [{id: 'call-tree', op: 'scene.get_tree', params: {}, result: TREE_3D}],
        wants: ops => wrote(ops, 'Mesh', 'custom_aabb', 'aabb', [0, 0, 0, 2, 3, 4])
    },
    {
        id: 'tagPoly',
        outside: 'tag',
        ask:
            'Set the polygon property of /Main/Shape in the open scene to the four points (0, 0),'
            + ' (16, 0), (16, 16) and (0, 16). Do not save the scene.',
        priming: [{id: 'call-tree', op: 'scene.get_tree', params: {}, result: TREE_2D}],
        wants: ops =>
            wrote(ops, 'Shape', 'polygon', 'packed_vector2_array', [0, 0, 16, 0, 16, 16, 0, 16])
    },
    {
        id: 'keyEnter',
        outside: 'none',
        ask: 'Bind the input action `confirm` to the Enter key in the project input map.',
        priming: [],
        wants: ops => action(ops, 'confirm', 'Enter')
    }
]

const refusal = (what, word, vocabulary, hint) => ({
    error: 'unsupported_value',
    message: `unknown ${what} "${word}"${hint ? `; closest: ${closest(word, vocabulary).join(', ')}` : ''}`
})

/** The router's answer, with every Godot word checked against the engine's own list. */
export function answerOf({op, dotted, entry, revision, hint}) {
    // Inert and identical in every arm: a real answer here would be a fifth place to put the
    // vocabulary, which is the thing being measured.
    if (dotted.startsWith('docs_search.'))
        return {answer: 'No documentation matched this question.', results: []}
    for (const event of eventsOf(entry)) {
        const key = event?.key
        if (typeof key === 'string' && !KEYS_ALL.includes(key))
            return refusal('key', key, KEYS_ALL, hint)
    }
    if (op === 'get_monitors') {
        const asked = Array.isArray(entry.monitors) ? entry.monitors : []
        for (const name of asked)
            if (!MONITORS_ALL.includes(name)) return refusal('monitor', name, MONITORS_ALL, hint)
        return {values: Object.fromEntries((asked.length > 0 ? asked : ['fps']).map(n => [n, 0]))}
    }
    for (const write of writesOf([{op, ...entry}])) {
        const tag = write?.value?.type
        if (typeof tag === 'string' && !TAGS_ALL.includes(tag))
            return refusal('value tag', tag, TAGS_ALL, hint)
    }
    if (op === 'get_tree') return TREE_2D
    if (op === 'list_input_actions') return {actions: []}
    if (op === 'search_settings') return {matches: [], totalMatches: 0, truncated: false}
    return {ok: true, revision}
}

export const HINTING = new Set(['V3', 'P3'])
export {SESSION}

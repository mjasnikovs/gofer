// Six asks about a file whose path the model was never given, over one seeded project inventory.
// The two arms differ only in how the model can learn a path: arm A is handed the inventory in the
// user message the way a real turn hands it over, arm B is handed a `files.list` operation instead.
import {readFile} from 'node:fs/promises'

const S = process.env.SCRATCH ?? import.meta.dirname

// Exactly what `describe_session` prints for a ready editor, and exactly where `withTurnContext`
// puts it: appended to the message that started the turn.
const SESSION =
    'Editor session: ready. Godot 4.7.2. Every tool runs in the project root and takes paths the way'
    + ' the project spells them, never an absolute one.'

// `describe_inventory` in src-tauri/src/ai_turn.rs, verbatim. The sentence is half the effect and
// there is no fence around the list: a Rust test refuses an indented line.
const INVENTORY_SENTENCE =
    "The project's tracked files are listed below. Read them here rather than listing the"
    + ' project; list again only after you have written a file this list does not name.'

export const INVENTORY = (await readFile(`${S}/inv-inventory.txt`, 'utf8')).trim()
const PATHS = INVENTORY.split('\n')
const TRACKED = new Set(PATHS)

/** The inventory block as `turnContextText` joins it: the sentence, a blank line, the paths. */
export function inventoryBlock() {
    return `${INVENTORY_SENTENCE}\n\n${INVENTORY}`
}

const ENEMY_PATH = 'scripts/enemies/enemy.gd'
const PLAYER_PATH = 'scripts/player/player.gd'
const COIN_PATH = 'scenes/items/coin.tscn'
const UNUSED_PATH = 'scripts/tests/unused_hud_test.gd'
const HUB_PATH = 'scenes/levels/level_hub.tscn'
const SHOP_PATH = 'scripts/ui/shop_panel.gd'

const ENEMY = [
    'extends CharacterBody2D',
    '',
    '@export var speed: float = 100.0',
    '@export var health: int = 3',
    '',
    'func _physics_process(delta: float) -> void:',
    '    velocity.x = speed',
    '    move_and_slide()',
    ''
].join('\n')

const PLAYER = [
    'extends CharacterBody2D',
    '',
    '@export var walk_speed: float = 220.0',
    '@export var jump_velocity: float = -420.0',
    '@export var coyote_time: float = 0.12',
    '',
    'var _coins: int = 0',
    '',
    'func _physics_process(delta: float) -> void:',
    '    velocity.x = walk_speed',
    '    move_and_slide()',
    ''
].join('\n')

const SHOP = [
    'extends Panel',
    '',
    'signal item_purchased(item_id: String, price: int)',
    '',
    'func _on_buy_pressed(item_id: String, price: int) -> void:',
    '    if not Economy.can_afford(price):',
    '        return',
    '    Economy.spend(price)',
    '    print("bought ", item_id, " for ", price)',
    '    item_purchased.emit(item_id, price)',
    ''
].join('\n')

const STUB = 'extends Node\n\nfunc _ready() -> void:\n    pass\n'

const TEXTS = {[ENEMY_PATH]: ENEMY, [PLAYER_PATH]: PLAYER, [SHOP_PATH]: SHOP}

const TREE = {
    scene: 'res://scenes/levels/level_hub.tscn',
    revision: 7,
    tree: {
        path: '/Main',
        type: 'Node2D',
        children: [{path: '/Main/Player', type: 'CharacterBody2D'}]
    }
}

/** A path as the project spells it: `res://` and `./` are the project root, not a directory. */
export const norm = value =>
    String(value ?? '')
        .replace(/^res:\/\//u, '')
        .replace(/^\.\//u, '')
        .replace(/\/+$/u, '')

const tracked = value => TRACKED.has(norm(value))

// A key whose value is prose, a pattern or a body of code, never a path. Without this a glob or a
// script body scores as a path the project does not have.
const NOT_A_PATH = new Set([
    'op',
    'glob',
    'query',
    'text',
    'source',
    'contains',
    'oldText',
    'newText',
    'summary',
    'prompt',
    'command',
    'message'
])

const FILE_LIKE =
    /\.(gd|tscn|scn|tres|res|png|svg|ogg|wav|ttf|json|cfg|csv|md|sh|gdshader|import|godot|translation|txt|glb|obj|gltf|webp|jpg)$/iu

/** Every value in one op that names a file, however deep it sits. */
export function pathsIn(value, key = '') {
    if (typeof value === 'string') {
        if (NOT_A_PATH.has(key)) return []
        if (/[\s*?]/u.test(value) || value.length > 200) return []
        return FILE_LIKE.test(value) ? [value] : []
    }
    if (Array.isArray(value)) return value.flatMap(item => pathsIn(item, key))
    if (value && typeof value === 'object')
        return Object.entries(value).flatMap(([name, item]) => pathsIn(item, name))
    return []
}

const absolute = path => /^([/\\]|[A-Za-z]:[\\/])/u.test(path)

// `find /`, `ls /home/...`: the shape scripts/workspace-confinement.mjs refuses outright.
const ABSOLUTE_IN_COMMAND = /(^|[\s'"=(])[/~](?:[\w.-]|$)/u
const SEARCHES = /\b(find|ls|grep|rg|fd|tree|locate)\b/u

export function bashScore(command) {
    const text = String(command ?? '')
    return {
        find: SEARCHES.test(text) ? 1 : 0,
        absolute: ABSOLUTE_IN_COMMAND.test(text) ? 1 : 0
    }
}

const has = (ops, tool, op, fits) => ops.some(e => e.tool === tool && e.op === op && fits(e))

const editsTo = (ops, path, fits) =>
    has(ops, 'godot_script', 'edit', e =>
        (e.files ?? []).some(
            file => norm(file?.path) === path && (file.edits ?? []).some(edit => fits(edit))
        )
    )

export const TASKS = [
    {
        // scripts/enemies/enemy.gd — the only enemy script, and never named in the ask.
        id: 'speed',
        ask: 'The enemy moves too slowly. Change its movement speed from 100 to 250, by replacing the exact text of that line.',
        priming: [],
        wants: ops =>
            editsTo(
                ops,
                ENEMY_PATH,
                edit =>
                    String(edit?.oldText ?? '').includes('100')
                    && String(edit?.newText ?? '').includes('250')
            )
    },
    {
        id: 'exports',
        ask: 'Open the player script and tell me which variables it exports.',
        priming: [],
        wants: ops =>
            has(ops, 'godot_script', 'open', e =>
                (e.paths ?? []).some(path => norm(path) === PLAYER_PATH)
            )
    },
    {
        id: 'coin',
        ask: 'Add an instance of the coin scene under /Main in the open scene. Do not save the scene.',
        priming: [
            {id: 'call-tree', domain: 'godot_scene', op: 'get_tree', params: {}, result: TREE}
        ],
        wants: ops =>
            has(
                ops,
                'godot_node',
                'instantiate',
                e =>
                    norm(e.path) === COIN_PATH
                    && String(e.parent ?? '').replace(/\/$/u, '') === '/Main'
            )
    },
    {
        id: 'delete',
        ask: 'There is one unused test script left in this project. Delete it.',
        priming: [],
        wants: ops => has(ops, 'godot_resource', 'delete', e => norm(e.path) === UNUSED_PATH)
    },
    {
        id: 'hub',
        ask: 'Open the hub level scene in the editor.',
        priming: [],
        wants: ops => has(ops, 'godot_scene', 'open', e => norm(e.path) === HUB_PATH)
    },
    {
        id: 'shop',
        ask: 'The shop panel still prints a debug line on every purchase. Take that line out of its script.',
        priming: [],
        wants: ops => editsTo(ops, SHOP_PATH, edit => /print/u.test(String(edit?.oldText ?? '')))
    }
]

const textOf = path => TEXTS[norm(path)] ?? STUB

const notFound = path => ({
    error: 'file_not_found',
    path,
    message: `${path} is not a file in this project`
})

const globToRegExp = glob => {
    const text = String(glob)
    let out = '^'
    for (let at = 0; at < text.length; at += 1) {
        const char = text[at]
        if (char === '*' && text[at + 1] === '*') {
            at += text[at + 2] === '/' ? 2 : 1
            out += '(?:.*/)?'
        } else if (char === '*') out += '[^/]*'
        else if (char === '?') out += '[^/]'
        else out += char.replace(/[.+^${}()|[\]\\]/u, '\\$&')
    }
    return new RegExp(`${out}$`, 'u')
}

// A glob is written against the file name — `*.gd` — but a model that writes a whole path in it
// should not be told the project is empty, so both spellings match.
const listing = (under, glob) => {
    const prefix = under ? `${norm(under)}/` : ''
    const pattern = glob ? globToRegExp(glob) : null
    return PATHS.filter(path => {
        if (prefix && !path.startsWith(prefix)) return false
        if (!pattern) return true
        return (
            pattern.test(path)
            || pattern.test(path.slice(prefix.length))
            || pattern.test(path.slice(path.lastIndexOf('/') + 1))
        )
    })
}

/** What the router would answer one operation. Identical for both arms but for `files.list`. */
export function resultOf(op, entry) {
    if (op === 'files.list') {
        const files = listing(entry?.under, entry?.glob)
        return {files, total: files.length}
    }
    if (op === 'get_tree') return TREE
    if (op === 'open') {
        const paths = entry?.paths ?? (entry?.path ? [entry.path] : [])
        const ghost = paths.find(path => !tracked(path))
        if (ghost) return notFound(ghost)
        // scene.open takes one path and answers a tree; script.open takes a list of them.
        if (entry?.path !== undefined && entry?.paths === undefined)
            return {...TREE, scene: `res://${norm(entry.path)}`}
        return {files: paths.map(path => ({path, text: textOf(path)}))}
    }
    if (op === 'edit') {
        const ghost = (entry?.files ?? []).map(file => file?.path).find(path => !tracked(path))
        if (ghost) return notFound(ghost)
        return {ok: true, diagnostics: []}
    }
    if (op === 'delete' || op === 'instantiate') {
        const path = entry?.path
        if (path !== undefined && !tracked(path)) return notFound(path)
        return {ok: true, revision: 8}
    }
    if (op === 'update' || op === 'save' || op === 'diagnostics') {
        const paths = entry?.paths ?? (entry?.path ? [entry.path] : [])
        const ghost = paths.find(path => !tracked(path))
        if (ghost) return notFound(ghost)
        return {ok: true, diagnostics: []}
    }
    return {ok: true, revision: 8}
}

/** `godot_script list` and `godot_resource list` answer out of the same inventory, in both arms. */
export function listResult(tool, entry) {
    const files = listing(entry?.under).filter(
        path => tool !== 'godot_script' || path.endsWith('.gd')
    )
    return {files, total: files.length}
}

const asObject = value => (value && typeof value === 'object' && !Array.isArray(value) ? value : {})
const short = name => name.replace(/^godot_/u, '')

/**
 * The one surface both arms speak: one `godot` tool, one `ops` list, `domain.op` dotted.
 *
 * Decoded by splitting the dot rather than through surf-map.json, because arm B's `files.list` is
 * synthesised and is in no committed map.
 */
export const ARM = {
    isGodot: name => name === 'godot',
    write: (domain, op, params) => ({
        name: 'godot',
        arguments: JSON.stringify({ops: [{op: `${short(domain)}.${op}`, ...params}]})
    }),
    decode(name, args) {
        if (name !== 'godot') return null
        const list = Array.isArray(args?.ops) ? args.ops : []
        return list.map(entry => {
            const {op, ...rest} = asObject(entry)
            const dot = String(op ?? '').indexOf('.')
            if (dot < 0) return {tool: null, op, ...rest}
            return {
                tool: `godot_${String(op).slice(0, dot)}`,
                op: String(op).slice(dot + 1),
                dotted: op,
                ...rest
            }
        })
    },
    answer(name, args) {
        const entries = Array.isArray(args?.ops) ? args.ops : []
        return JSON.stringify({
            ops: entries.map(entry => {
                const decoded = ARM.decode('godot', {ops: [entry]})[0]
                const result =
                    decoded.op === 'list' && decoded.tool !== 'godot_files' ?
                        listResult(decoded.tool, decoded)
                    :   resultOf(
                            decoded.dotted === 'files.list' ? 'files.list' : decoded.op,
                            decoded
                        )
                return {op: entry.op, result}
            })
        })
    }
}

export function conversation(task, prompt, withInventory) {
    const tail = withInventory ? `${SESSION}\n\n${inventoryBlock()}` : SESSION
    const messages = [
        {role: 'system', content: prompt},
        {role: 'user', content: `${task.ask}\n\n${tail}`}
    ]
    for (const step of task.priming) {
        const written = ARM.write(step.domain, step.op, step.params)
        messages.push({
            role: 'assistant',
            content: null,
            tool_calls: [{id: step.id, type: 'function', function: written}]
        })
        messages.push({
            role: 'tool',
            tool_call_id: step.id,
            content: JSON.stringify({
                ops: [{op: `${short(step.domain)}.${step.op}`, result: step.result}]
            })
        })
    }
    return messages
}

export {tracked, absolute}

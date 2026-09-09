// Godot's real vocabularies, and the wire names Gofer spells them with.
import {readFile} from 'node:fs/promises'

const S = process.env.SCRATCH ?? import.meta.dirname

const api = JSON.parse(await readFile(`${S}/extension_api.json`, 'utf8'))
const keycodes = JSON.parse(await readFile(`${S}/probe/keycodes.json`, 'utf8'))

export const KEYS_25 = [
    'Enter',
    'Kp Enter',
    'Escape',
    'Space',
    'Backspace',
    'Tab',
    'Delete',
    'Left',
    'Right',
    'Up',
    'Down',
    'PageUp',
    'PageDown',
    'Home',
    'End',
    'Shift',
    'Ctrl',
    'Alt',
    'Meta',
    'Comma',
    'Period',
    'Slash',
    'Minus',
    'Equal',
    'BracketLeft'
]
export const KEYS_ALL = [...new Set(Object.values(keycodes))]

// The fifteen the addon maps today, then every other Performance.Monitor as its lowercased name.
const SHIPPED_MONITORS = {
    fps: 'TIME_FPS',
    process_time: 'TIME_PROCESS',
    physics_time: 'TIME_PHYSICS_PROCESS',
    memory_static: 'MEMORY_STATIC',
    memory_message_buffer: 'MEMORY_MESSAGE_BUFFER_MAX',
    object_count: 'OBJECT_COUNT',
    object_resource_count: 'OBJECT_RESOURCE_COUNT',
    object_node_count: 'OBJECT_NODE_COUNT',
    object_orphan_node_count: 'OBJECT_ORPHAN_NODE_COUNT',
    render_objects_in_frame: 'RENDER_TOTAL_OBJECTS_IN_FRAME',
    render_primitives_in_frame: 'RENDER_TOTAL_PRIMITIVES_IN_FRAME',
    render_draw_calls_in_frame: 'RENDER_TOTAL_DRAW_CALLS_IN_FRAME',
    render_video_memory: 'RENDER_VIDEO_MEM_USED',
    render_texture_memory: 'RENDER_TEXTURE_MEM_USED',
    render_buffer_memory: 'RENDER_BUFFER_MEM_USED'
}
export const MONITORS_15 = Object.keys(SHIPPED_MONITORS)
const taken = new Set(Object.values(SHIPPED_MONITORS))
const monitorEnum = api.classes
    .find(c => c.name === 'Performance')
    .enums.find(e => e.name === 'Monitor')
export const MONITORS_ALL = [
    ...MONITORS_15,
    ...monitorEnum.values
        .map(v => v.name)
        .filter(name => name !== 'MONITOR_MAX' && !taken.has(name))
        .map(name => name.toLowerCase())
]

export const TAGS_23 = [
    'null',
    'bool',
    'int',
    'float',
    'string',
    'vector2',
    'vector2i',
    'vector3',
    'vector3i',
    'vector4',
    'vector4i',
    'quaternion',
    'color',
    'rect2',
    'rect2i',
    'plane',
    'transform2d',
    'basis',
    'transform3d',
    'array',
    'dictionary',
    'resource',
    'node_path'
]
const snake = name =>
    name
        .replace(/^TYPE_/u, '')
        .toLowerCase()
        .replace(/(\d)i$/u, '$1i')
export const VARIANT_TYPES = api.global_enums
    .find(e => e.name === 'Variant.Type')
    .values.map(v => v.name)
    .filter(n => n !== 'TYPE_MAX')
    .map(snake)
// `resource` and `null` are wire tags with no Variant of their own, so the union is what the
// addon could answer, not the enum verbatim.
export const TAGS_ALL = [...new Set([...VARIANT_TYPES, 'resource', 'null'])]

const norm = s =>
    String(s)
        .toLowerCase()
        .replace(/[^a-z0-9]/gu, '')
const tokens = s =>
    String(s)
        .toLowerCase()
        .split(/[^a-z0-9]+|(?<=[a-z])(?=[0-9])|(?<=[0-9])(?=[a-z])/u)
        .filter(Boolean)
const bigrams = s =>
    new Set(Array.from({length: Math.max(0, s.length - 1)}, (_, i) => s.slice(i, i + 2)))
const dice = (a, b) => {
    const [x, y] = [bigrams(a), bigrams(b)]
    if (x.size === 0 || y.size === 0) return a === b ? 1 : 0
    let shared = 0
    for (const g of x) if (y.has(g)) shared += 1
    return (2 * shared) / (x.size + y.size)
}
const jaccard = (a, b) => {
    const [x, y] = [new Set(tokens(a)), new Set(tokens(b))]
    let shared = 0
    for (const t of x) if (y.has(t)) shared += 1
    return shared / (x.size + y.size - shared)
}
/** The names a refusal would name back: an exact match once punctuation and case are gone, else nearest. */
export function closest(word, vocabulary, count = 3) {
    const target = norm(word)
    const same = vocabulary.filter(v => norm(v) === target)
    if (same.length > 0) return same
    const score = v => Math.max(dice(norm(v), target), jaccard(v, word))
    return [...vocabulary].sort((a, b) => score(b) - score(a)).slice(0, count)
}

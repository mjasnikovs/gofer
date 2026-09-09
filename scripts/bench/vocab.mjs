// Godot's real vocabularies, and the wire names Gofer spells them with.
//
// The engine's lists are read from protocol/godot-vocabulary.json, which `npm run generate`
// writes by running the pinned engine. The hand copies this used to hold — a 12 MB extension API
// dump and a keycode probe of its own — were the same measurement's scaffolding, and a bench arm
// that names words the shipped surface no longer names measures nothing.
import {readFile} from 'node:fs/promises'

const engine = JSON.parse(
    await readFile(new URL('../../protocol/godot-vocabulary.json', import.meta.url), 'utf8')
)

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
export const KEYS_ALL = engine.keys

// The fifteen the addon mapped when the arms were measured, under the names it took then.
export const MONITORS_15 = [
    'fps',
    'process_time',
    'physics_time',
    'memory_static',
    'memory_message_buffer',
    'object_count',
    'object_resource_count',
    'object_node_count',
    'object_orphan_node_count',
    'render_objects_in_frame',
    'render_primitives_in_frame',
    'render_draw_calls_in_frame',
    'render_video_memory',
    'render_texture_memory',
    'render_buffer_memory'
]
export const MONITORS_ALL = engine.monitors

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
export const VARIANT_TYPES = engine.variantTypes.map(type => type.string)
// `Resource` is a wire tag with no Variant of its own, so the union is what the addon can answer
// rather than the enum verbatim.
export const TAGS_ALL = [...new Set([...VARIANT_TYPES, 'Resource'])]

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

import {spawn} from 'node:child_process'
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {resolveGodotBinary} from './godot-binary.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const PROBE = join(root, 'scripts/godot-vocabulary-probe.gd')
const PROJECT = join(root, 'fixtures/godot-project')
export const VOCABULARY_PATH = 'protocol/godot-vocabulary.json'

const BEGIN = '@@GOFER-VOCABULARY-BEGIN@@'
const END = '@@GOFER-VOCABULARY-END@@'

/**
 * The values of an enum that count it or stand for its absence, dropped by name.
 *
 * By name rather than by a `*_MAX` suffix rule, because `MEMORY_STATIC_MAX` and
 * `MEMORY_MESSAGE_BUFFER_MAX` are two of the fifty-nine real monitors and a suffix rule takes
 * them out. Each of these is a sentinel:
 *
 * - `KEY_NONE` is no key; `KEY_SPECIAL` is the bit marking the non-printable half of the keycode
 *   space and prints as an invalid codepoint; `KEY_UNKNOWN` round-trips through the string table
 *   and still names no key.
 * - `TYPE_MAX` counts the Variant types.
 * - `MOUSE_BUTTON_NONE` is no button.
 * - `JOY_BUTTON_INVALID` and `JOY_AXIS_INVALID` are no button and no axis; `SDL_MAX` and `MAX`
 *   count them.
 * - `MONITOR_MAX` counts the monitors.
 */
const SENTINELS = {
    Key: ['KEY_NONE', 'KEY_SPECIAL', 'KEY_UNKNOWN'],
    'Variant.Type': ['TYPE_MAX'],
    MouseButton: ['MOUSE_BUTTON_NONE'],
    JoyButton: ['JOY_BUTTON_INVALID', 'JOY_BUTTON_SDL_MAX', 'JOY_BUTTON_MAX'],
    JoyAxis: ['JOY_AXIS_INVALID', 'JOY_AXIS_SDL_MAX', 'JOY_AXIS_MAX'],
    Monitor: ['MONITOR_MAX']
}

function run(binary, args, options = {}) {
    return new Promise((settle, fail) => {
        const child = spawn(binary, args, {cwd: options.cwd, stdio: ['ignore', 'pipe', 'pipe']})
        let out = ''
        let error = ''
        child.stdout.setEncoding('utf8')
        child.stderr.setEncoding('utf8')
        child.stdout.on('data', chunk => (out += chunk))
        child.stderr.on('data', chunk => (error += chunk))
        child.on('error', fail)
        child.on('close', status =>
            status === 0 ?
                settle(out)
            :   fail(new Error(`${binary} ${args.join(' ')} exited ${status}: ${error.trim()}`))
        )
    })
}

function without(values, enumName) {
    const sentinels = SENTINELS[enumName]
    const present = new Set(values.map(value => value.name))
    for (const sentinel of sentinels) {
        if (!present.has(sentinel))
            throw new Error(`${enumName} no longer has the sentinel ${sentinel}`)
    }
    return values.filter(value => !sentinels.includes(value.name))
}

function globalEnum(api, name) {
    const found = api.global_enums.find(entry => entry.name === name)
    if (!found) throw new Error(`the extension API dump no longer declares the ${name} enum`)
    return without(found.values, name)
}

function monitorEnum(api) {
    const performance = api.classes.find(entry => entry.name === 'Performance')
    const found = performance?.enums?.find(entry => entry.name === 'Monitor')
    if (!found) throw new Error('the extension API dump no longer declares Performance.Monitor')
    return without(found.values, 'Monitor')
}

/** Every class whose ancestry reaches `Node`, with the properties it declares itself. */
function nodeClasses(api) {
    const byName = new Map(api.classes.map(entry => [entry.name, entry]))
    const reachesNode = entry => {
        let walked = entry
        while (walked) {
            if (walked.name === 'Node') return true
            walked = byName.get(walked.inherits)
        }
        return false
    }
    return api.classes
        .filter(reachesNode)
        .map(entry => ({
            name: entry.name,
            parent: entry.inherits ?? null,
            instantiable: entry.is_instantiable === true,
            properties: (entry.properties ?? []).map(property => ({
                name: property.name,
                type: property.type
            }))
        }))
        .sort((one, other) => (one.name < other.name ? -1 : 1))
}

function probeOutput(text) {
    const start = text.indexOf(BEGIN)
    const stop = text.indexOf(END)
    if (start === -1 || stop === -1)
        throw new Error(`the vocabulary probe printed no document:\n${text}`)
    return JSON.parse(text.slice(start + BEGIN.length, stop).trim())
}

/** The whole vocabulary, read out of one pinned engine by two headless runs of it. */
export async function buildVocabulary(binary = resolveGodotBinary()) {
    const engine = (await run(binary, ['--version'])).trim()
    const workspace = await mkdtemp(join(tmpdir(), 'gofer-vocabulary-'))
    try {
        await run(binary, ['--headless', '--dump-extension-api'], {cwd: workspace})
        const api = JSON.parse(await readFile(join(workspace, 'extension_api.json'), 'utf8'))
        const keyValues = globalEnum(api, 'Key')
        const variantValues = globalEnum(api, 'Variant.Type')
        const request = join(workspace, 'walk.json')
        await writeFile(
            request,
            JSON.stringify({
                keys: keyValues.map(value => value.value),
                variantTypes: variantValues.map(value => value.value)
            })
        )
        const spoken = probeOutput(
            await run(binary, ['--headless', '--path', PROJECT, '--script', PROBE, '--', request])
        )
        const keycodes = Object.fromEntries(
            Object.entries(spoken.keycodes).sort(([one], [other]) => (one < other ? -1 : 1))
        )
        return {
            engine,
            keys: Object.keys(keycodes),
            keycodes,
            monitors: monitorEnum(api).map(value => value.name),
            variantTypes: variantValues.map((value, index) => ({
                name: value.name,
                value: value.value,
                string: spoken.variantTypes[index]
            })),
            mouseButtons: globalEnum(api, 'MouseButton').map(value => value.name),
            joyButtons: globalEnum(api, 'JoyButton').map(value => value.name),
            joyAxes: globalEnum(api, 'JoyAxis').map(value => value.name),
            nodes: nodeClasses(api)
        }
    } finally {
        await rm(workspace, {recursive: true, force: true})
    }
}

/**
 * The Variant types the addon cannot build out of JSON, and why each one.
 *
 * A tag is the `type_string` spelling of a Variant type, and every type but these four is a value
 * a JSON payload fully describes. These four name something that only exists inside the running
 * process, so a tag for one would be a name the model could write and nothing could answer.
 */
export const UNDECODABLE_TAGS = {
    Object: 'a live instance, which no JSON payload carries a reference to',
    Callable: 'a method bound to a live instance',
    Signal: 'a signal of a live instance',
    RID: 'a server-side handle, valid only inside the process that issued it'
}

/** A fixed-length array of numbers, which is how every vector, rect, basis and transform reads. */
function numbers(arity, of = 'number') {
    return {type: 'array', minItems: arity, maxItems: arity, items: {type: of}}
}

/** The same, for the types whose components are whole numbers and whose fixtures say so. */
function whole(arity) {
    return numbers(arity, 'integer')
}

function arrayOf(shape) {
    return {type: 'array', items: shape}
}

/**
 * The payload each tag carries, as the JSON schema that refuses everything else.
 *
 * One table, three printers: the `taggedValue` branches of `godot-tool.json`, the request half of
 * `value.schema.json`, and the arity the router's own check reads. The three used to be written
 * out by hand in three languages, and the schema's half said only "a value" — which is what left
 * `tool_repair.rs` a live layer, rewriting payloads a closed grammar would never have let a
 * sampler write.
 *
 * `ref` is how a tagged value refers to itself, which differs by target: `Array` and `Dictionary`
 * hold tagged values, and nothing else here recurses.
 *
 * A vector of whole numbers takes JSON integers, which is what the frozen protocol corpus has
 * always said: `protocol/fixtures/v2/invalid/value-vector2i-float.json` is a Vector2i with a 2.5
 * in it.
 */
export function tagPayloads(ref) {
    const tagged = {$ref: ref}
    const pair = {
        type: 'object',
        properties: {key: tagged, value: tagged},
        required: ['key', 'value'],
        additionalProperties: false
    }
    return {
        Nil: {type: 'null'},
        bool: {type: 'boolean'},
        int: {type: 'integer'},
        float: {type: 'number'},
        String: {type: 'string'},
        StringName: {type: 'string'},
        NodePath: {type: 'string'},
        Vector2: numbers(2),
        Vector2i: whole(2),
        Vector3: numbers(3),
        Vector3i: whole(3),
        Vector4: numbers(4),
        Vector4i: whole(4),
        Quaternion: numbers(4),
        Plane: numbers(4),
        Rect2: numbers(4),
        Rect2i: whole(4),
        AABB: numbers(6),
        Transform2D: numbers(6),
        Basis: numbers(9),
        Transform3D: numbers(12),
        Projection: numbers(16),
        // Four numbers, or a word the engine reads as one: `Color.from_string` takes "skyblue" and
        // "#8b5a2b" alike, and a live turn wrote "red" here and was told a colour is four numbers.
        Color: {oneOf: [numbers(4), {type: 'string'}]},
        Array: arrayOf(tagged),
        Dictionary: arrayOf(pair),
        PackedByteArray: arrayOf({type: 'integer'}),
        PackedInt32Array: arrayOf({type: 'integer'}),
        PackedInt64Array: arrayOf({type: 'integer'}),
        PackedFloat32Array: arrayOf({type: 'number'}),
        PackedFloat64Array: arrayOf({type: 'number'}),
        PackedStringArray: arrayOf({type: 'string'}),
        PackedVector2Array: arrayOf(numbers(2)),
        PackedVector3Array: arrayOf(numbers(3)),
        PackedVector4Array: arrayOf(numbers(4)),
        PackedColorArray: arrayOf(numbers(4)),
        Resource: {
            type: 'object',
            properties: {path: {type: 'string', minLength: 1}},
            required: ['path'],
            additionalProperties: false
        }
    }
}

/**
 * What only an answer carries, kept out of every request-side printer.
 *
 * `node`, `object` and `opaque` describe something live that no payload can rebuild, so nothing
 * may write one; a `Resource` comes back naming its class and its UID, which a caller sending one
 * has no way to know and `Protocol.decode` never reads.
 */
export const ANSWER_ONLY = {
    tags: {
        node: {
            type: 'object',
            required: ['path', 'nodeType'],
            properties: {
                path: {type: 'string', minLength: 1},
                nodeType: {type: 'string', minLength: 1},
                instanceId: {type: 'integer'}
            },
            additionalProperties: true
        },
        object: {
            type: 'object',
            required: ['className', 'instanceId'],
            properties: {
                className: {type: 'string', minLength: 1},
                instanceId: {type: 'integer'}
            },
            additionalProperties: true
        },
        opaque: {
            type: 'object',
            required: ['typeName', 'text'],
            properties: {typeName: {type: 'string', minLength: 1}, text: {type: 'string'}},
            additionalProperties: true
        }
    },
    resource: {
        type: 'object',
        required: ['path', 'resourceType'],
        properties: {
            path: {type: 'string', minLength: 1},
            resourceType: {type: 'string', minLength: 1},
            uid: {type: 'string', minLength: 1}
        },
        additionalProperties: true
    }
}

/**
 * The words one vocabulary stands for, out of the engine's own lists.
 *
 * `keys`, `monitors`, `mouseButtons`, `joyButtons` and `joyAxes` are lists of this file verbatim.
 * `valueTags` is the one derived list: the `type_string` spelling of every Variant type minus
 * [`UNDECODABLE_TAGS`], plus `Resource` for the `{path}` payload the wire has always carried and
 * the Variant enum has no name for.
 */
export function engineWords(vocabulary, engine, where) {
    if (engine === 'keys') return vocabulary.keys
    if (engine === 'monitors') return vocabulary.monitors
    if (engine === 'mouseButtons') return vocabulary.mouseButtons
    if (engine === 'joyButtons') return vocabulary.joyButtons
    if (engine === 'joyAxes') return vocabulary.joyAxes
    if (engine === 'valueTags')
        return [
            ...vocabulary.variantTypes
                .map(type => type.string)
                .filter(tag => !(tag in UNDECODABLE_TAGS)),
            'Resource'
        ]
    throw new Error(`${where} names the engine list ${engine}, which nothing writes`)
}

/** The committed file, which every other generator reads instead of launching the engine. */
export async function readVocabulary() {
    return JSON.parse(await readFile(join(root, VOCABULARY_PATH), 'utf8'))
}

export function serializeVocabulary(vocabulary) {
    return `${JSON.stringify(vocabulary, null, 4)}\n`
}

/** The engine, or nothing when this machine has no pinned one. */
export function availableGodotBinary() {
    try {
        return resolveGodotBinary()
    } catch {
        return undefined
    }
}

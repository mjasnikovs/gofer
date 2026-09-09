import {spawn} from 'node:child_process'
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'
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

/**
 * The words one vocabulary stands for, out of the engine's own lists.
 *
 * `keys` and `monitors` are lists of this file verbatim. `valueTags` is the one derived list: the
 * `type_string` spelling of every Variant type minus [`UNDECODABLE_TAGS`], plus `Resource` for the
 * `{path}` payload the wire has always carried and the Variant enum has no name for.
 */
export function engineWords(vocabulary, engine, where) {
    if (engine === 'keys') return vocabulary.keys
    if (engine === 'monitors') return vocabulary.monitors
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const flag = process.argv.indexOf('--out')
    const out = flag === -1 ? join(root, VOCABULARY_PATH) : resolve(process.argv[flag + 1])
    const binary = flag === -1 ? availableGodotBinary() : resolveGodotBinary()
    if (!binary) {
        process.stdout.write(
            `scripts/godot-vocabulary.mjs: no pinned Godot on this machine, so ${VOCABULARY_PATH} stays as committed\n`
        )
    } else {
        const written = serializeVocabulary(await buildVocabulary(binary))
        const before = await readFile(out, 'utf8').catch(() => '')
        if (before !== written) await writeFile(out, written)
        process.stdout.write(
            `scripts/godot-vocabulary.mjs: ${before === written ? 'unchanged' : 'rewrote'} ${out}\n`
        )
    }
}

// Four vocabulary placements over the S2 surface. Only where Godot's words live changes.
import {readFile, writeFile} from 'node:fs/promises'
import {buildS2, branchOf} from './s2.mjs'
import {KEYS_ALL, MONITORS_ALL, TAGS_ALL} from './vocab.mjs'

const S = process.env.SCRATCH ?? import.meta.dirname
const base = JSON.parse(await readFile(`${S}/catalog.json`, 'utf8'))

const KEY_OPS = [
    ['godot_project', 'set_input_action'],
    ['godot_runtime', 'input']
]
const KEY_SIGNATURE = /key\?: text like (?:"[^"]*"\|)*"[^"]*"/u
const KEY_SENTENCE =
    ' The named keys are in the signature; F1 to F16, A to Z and 0 to 9 are spelled as they read.'
const MONITOR_SENTENCE = / Without a list it answers[\s\S]*?any other name is an error\./u
const TAG_SENTENCE = / The other tags are null, bool[\s\S]*?pairs of them\)\./u

const clone = value => JSON.parse(JSON.stringify(value))
const opOf = (catalog, domain, op) =>
    catalog.find(d => d.name === domain).operations.find(o => o.op === op)

const forEachKeyParam = (catalog, visit) => {
    for (const [domain, op] of KEY_OPS) {
        const operation = opOf(catalog, domain, op)
        for (const param of operation.params) {
            if (param.name !== 'events') continue
            visit(param)
            for (const entry of param.entry ?? []) if (entry.name === 'key') visit(entry)
        }
    }
}

/** Strips every enumeration of a Godot word out of the prose, leaving the shape sentences. */
function stripProse(catalog) {
    const out = clone(catalog)
    forEachKeyParam(out, param => {
        param.vocabulary = []
    })
    for (const [domain, op] of KEY_OPS) {
        const operation = opOf(out, domain, op)
        operation.signature = operation.signature.replace(KEY_SIGNATURE, 'key?: text')
        operation.summary = operation.summary.replace(KEY_SENTENCE, '')
    }
    const monitors = opOf(out, 'godot_runtime', 'get_monitors')
    monitors.summary = monitors.summary.replace(MONITOR_SENTENCE, '')
    const property = opOf(out, 'godot_node', 'set_property')
    property.summary = property.summary.replace(TAG_SENTENCE, '')
    return out
}

/** Prose that points at the schema instead of repeating a stale list of its own. */
function proseToSchema(catalog) {
    const out = stripProse(catalog)
    forEachKeyParam(out, param => {
        param.note =
            `${param.note} The accepted names are the ones the schema's \`key\` lists.`.trim()
    })
    const monitors = opOf(out, 'godot_runtime', 'get_monitors')
    monitors.summary +=
        ' Without a list it answers with fps, memory_static and object_node_count; the names it accepts'
        + ' are the ones the schema lists, and any other name is an error.'
    const property = opOf(out, 'godot_node', 'set_property')
    property.summary += " The other tags are the ones the schema's `type` lists."
    return out
}

/** GBNF only constrains what the schema states, so this is the only placement that can refuse. */
function addEnums(tools) {
    for (const op of ['project.set_input_action', 'runtime.input'])
        branchOf(tools, op).properties.events.items.properties.key.enum = KEYS_ALL
    branchOf(tools, 'runtime.get_monitors').properties.monitors.items = {
        type: 'string',
        enum: MONITORS_ALL
    }
    branchOf(tools, 'node.set_property').properties.value.properties.type.enum = TAGS_ALL
    branchOf(
        tools,
        'node.set_properties'
    ).properties.properties.items.properties.value.properties.type.enum = TAGS_ALL
    return tools
}

const CATALOGS = {V1: base, V2: base, V2p: proseToSchema(base), V3: stripProse(base)}
for (const [arm, catalog] of Object.entries(CATALOGS))
    await writeFile(`${S}/vocab-catalog-${arm}.json`, JSON.stringify(catalog, null, 2))

const ARMS = {
    V1: buildS2(base),
    V2: addEnums(buildS2(base)),
    V2p: addEnums(buildS2(proseToSchema(base))),
    V3: buildS2(stripProse(base))
}

for (const [arm, tools] of Object.entries(ARMS)) {
    await writeFile(`${S}/vocab-tools-${arm}.json`, JSON.stringify(tools, null, 2))
    console.log(arm, 'bytes', JSON.stringify(tools).length)
}

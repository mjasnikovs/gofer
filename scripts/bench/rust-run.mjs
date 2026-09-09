import {readFileSync, writeFileSync} from 'node:fs'
import {execFileSync} from 'node:child_process'
import Ajv from 'ajv'
import {declaredDomains} from '../declared-domains.mjs'
import {createGodotTools, normalizeGodotCall} from '../godot-tools.mjs'
import {jsonSchemaOfEntry} from './tool-schema-2026-09-09.mjs'

const S = process.env.SCRATCH ?? import.meta.dirname
const corpus = JSON.parse(readFileSync(`${S}/corpus.json`, 'utf8'))
const domains = await declaredDomains()
const tools = createGodotTools(domains, {call: async () => ({})})
const ajv = new Ajv({strict: false})
const callValidator = Object.fromEntries(tools.map(t => [t.name, ajv.compile(t.parameters)]))
const entryValidator = Object.fromEntries(
    domains.map(d => [d.name, ajv.compile(jsonSchemaOfEntry(d.operations))])
)

const entries = []
for (const call of corpus) {
    if (!entryValidator[call.name]) continue
    const listed = Array.isArray(call.arguments?.ops) ? call.arguments.ops : null
    // what the schema sees, per entry, exactly as written
    if (listed === null) {
        entries.push({call, entry: null, at: -1})
        continue
    }
    listed.forEach((entry, at) => entries.push({call, entry, at}))
}

const sent = entries.filter(e => e.entry && typeof e.entry === 'object' && !Array.isArray(e.entry))
const input = sent.map(e => ({tool: e.call.name, entry: e.entry}))
const out = JSON.parse(
    execFileSync(`${S}/rustprobe/target/release/rustprobe`, {
        input: JSON.stringify(input),
        maxBuffer: 1 << 30
    }).toString()
)
const rows = sent.map((e, i) => ({
    db: e.call.db,
    id: e.call.id,
    tool: e.call.name,
    model: e.call.model,
    provider: e.call.provider,
    schemaAccepts: entryValidator[e.call.name](e.entry),
    ...out[i]
}))
writeFileSync(`${S}/rust-rows.json`, JSON.stringify(rows, null, 1))

const n = k => rows.filter(k).length
console.log('ops entries examined', rows.length)
console.log(
    '  schema accepts',
    n(r => r.schemaAccepts)
)
console.log(
    '  schema refuses',
    n(r => !r.schemaAccepts)
)
console.log(
    'unknown op (catalogue drift)',
    n(r => !r.known)
)
console.log(
    'ACCEPTED by schema AND changed by rust repair',
    n(r => r.schemaAccepts && r.changed)
)
console.log(
    'ACCEPTED by schema AND refused by rust check (after repair)',
    n(r => r.schemaAccepts && r.checkAfter)
)
console.log(
    'REFUSED by schema AND changed by rust repair',
    n(r => !r.schemaAccepts && r.changed)
)

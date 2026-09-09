import {readFileSync, writeFileSync} from 'node:fs'
import {execFileSync} from 'node:child_process'
import Ajv from 'ajv'
import {declaredDomains} from '../declared-domains.mjs'
import {createGodotTools, normalizeGodotCall} from '../godot-tools.mjs'
import * as W from '../tool-call-repair.mjs'

const S = process.env.SCRATCH ?? import.meta.dirname
const corpus = JSON.parse(readFileSync(`${S}/corpus.json`, 'utf8'))
const domains = await declaredDomains()
const tools = createGodotTools(domains, {call: async () => ({})})
const ajv = new Ajv({strict: false})
const valid = Object.fromEntries(tools.map(t => [t.name, ajv.compile(t.parameters)]))
const opsOf = name => domains.find(d => d.name === name).operations

const sorted = v =>
    JSON.stringify(v, (k, held) =>
        held && typeof held === 'object' && !Array.isArray(held) ?
            Object.fromEntries(Object.entries(held).sort())
        :   held
    )
const isObject = v => typeof v === 'object' && v !== null && !Array.isArray(v)

/** which exported worker rule changes this call, applied in the order normalizeToolCalls uses */
function workerRules(operations, args) {
    const fired = []
    const raw = isObject(args) ? args : {}
    let listed = Array.isArray(raw.ops) ? raw.ops : [raw]
    if (!Array.isArray(raw.ops)) fired.push('ops-bracket-added')
    if (typeof raw.ops === 'string') fired.push('ops-written-as-a-string(unrepaired)')
    let step = W.dropEmptyEntries(listed)
    if (sorted(step) !== sorted(listed)) fired.push('dropEmptyEntries')
    let a = step.map(e => W.unwrapOperationNamedKey(operations, e))
    if (sorted(a) !== sorted(step)) fired.push('unwrapOperationNamedKey')
    let b = a.map(e => W.normalizeEntry(operations, e))
    if (sorted(b) !== sorted(a)) fired.push('normalizeEntry')
    for (const [i, e] of a.entries())
        if (
            isObject(e)
            && W.gluedWrapperKey(
                operations.find(o => o.op === (e.op ?? e.operation ?? e.action))?.params,
                e,
                'op'
            )
        )
            fired.push('gluedWrapperKey')
    let c = b.map(e => W.foldFlatEntry(operations, e))
    if (sorted(c) !== sorted(b)) fired.push('foldFlatEntry')
    let d = W.foldStrayEntries(operations, c)
    if (sorted(d) !== sorted(c)) fired.push('foldStrayEntries')
    let e2 = d.map(e => W.nameTheOperation(operations, e))
    if (sorted(e2) !== sorted(d)) fired.push('nameTheOperation')
    for (const entry of e2) {
        const params = operations.find(o => o.op === entry.op)?.params
        const t = W.trimPaddedKeys(params, entry)
        if (sorted(t) !== sorted(entry)) fired.push('trimPaddedKeys')
        const u = W.unquoteATaggedKey(params, t)
        if (sorted(u) !== sorted(t)) fired.push('unquoteATaggedKey')
        const r = W.readAValueWrittenAsAString(params, u)
        if (sorted(r) !== sorted(u)) fired.push('readAValueWrittenAsAString')
        const w = W.wrapBareResource(params, r)
        if (sorted(w) !== sorted(r)) fired.push('wrapBareResource')
        try {
            W.refuseUnnamedOperation(operations, entry)
        } catch {
            fired.push('refuseUnnamedOperation')
        }
        try {
            W.refuseUnknownOperation(operations, entry)
        } catch {
            fired.push('refuseUnknownOperation')
        }
        try {
            W.refuseSiblingParameter(operations, w)
        } catch {
            fired.push('refuseSiblingParameter')
        }
    }
    return [...new Set(fired)]
}

const invalid = []
const workerHits = {}
const workerHitsOnValid = {}
for (const call of corpus) {
    if (!valid[call.name]) continue
    const ok = valid[call.name](call.arguments)
    const fired = workerRules(opsOf(call.name), call.arguments)
    const bag = ok ? workerHitsOnValid : workerHits
    for (const rule of fired) bag[rule] = (bag[rule] ?? 0) + 1
    if (!ok) invalid.push({call, fired})
}

// counterfactual: the entries the schema refuses, put to the Rust anyway
const cf = []
for (const {call} of invalid) {
    const listed = Array.isArray(call.arguments?.ops) ? call.arguments.ops : []
    for (const entry of listed)
        if (isObject(entry)) cf.push({tool: call.name, entry, id: call.id, model: call.model})
}
const out = JSON.parse(
    execFileSync(`${S}/rustprobe/target/release/rustprobe`, {
        input: JSON.stringify(cf.map(c => ({tool: c.tool, entry: c.entry}))),
        maxBuffer: 1 << 30
    }).toString()
)
const rustHits = {}
const rustCalls = {}
cf.forEach((c, i) => {
    for (const rule of out[i].rules ?? []) {
        rustHits[rule] = (rustHits[rule] ?? 0) + 1
        ;(rustCalls[rule] ??= new Set()).add(c.id)
    }
    if (!out[i].known)
        rustHits['(op unknown to the table)'] = (rustHits['(op unknown to the table)'] ?? 0) + 1
})
writeFileSync(
    `${S}/attribution.json`,
    JSON.stringify({workerHits, workerHitsOnValid, rustHits, cf: cf.length}, null, 1)
)
console.log('worker rules firing on SCHEMA-INVALID calls:')
console.table(workerHits)
console.log('worker rules firing on SCHEMA-VALID calls (pure no-ops the schema already covers):')
console.table(workerHitsOnValid)
console.log(
    'rust rules that WOULD fire on the schema-refused entries (counterfactual, '
        + cf.length
        + ' entries):'
)
console.table(
    Object.fromEntries(
        Object.entries(rustHits).map(([k, v]) => [k, {entries: v, calls: rustCalls[k]?.size ?? 0}])
    )
)
const guard = cf.filter(
    (c, i) => out[i].known && (out[i].rules ?? []).length > 0 && !out[i].changed
)
console.log(
    'misplaced-call guard: entries repair_set would touch but repair_call leaves alone:',
    guard.length
)

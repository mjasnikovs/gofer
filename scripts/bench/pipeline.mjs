/**
 * The real order: normalizeToolCalls (worker) -> generated schema (loop) -> tool_repair.rs (router).
 * Answers: how often each stage is the one that acts.
 */
import {readFileSync, writeFileSync} from 'node:fs'
import {execFileSync} from 'node:child_process'
import Ajv from 'ajv'
import {declaredDomains} from '../declared-domains.mjs'
import {createGodotTools, normalizeGodotCall} from '../godot-tools.mjs'

const S = process.env.SCRATCH ?? import.meta.dirname
const corpus = JSON.parse(readFileSync(`${S}/corpus.json`, 'utf8'))
const domains = await declaredDomains()
const tools = createGodotTools(domains, {call: async () => ({})})
const ajv = new Ajv({strict: false})
const valid = Object.fromEntries(tools.map(t => [t.name, ajv.compile(t.parameters)]))

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const rows = []
for (const call of corpus) {
    if (!valid[call.name]) continue
    const raw = call.arguments
    const rawOk = valid[call.name](raw)
    let worker,
        workerOk,
        threw = null
    try {
        worker = normalizeGodotCall(domains, call.name, structuredClone(raw))
        workerOk = valid[call.name](worker)
    } catch (e) {
        threw = e.message
        workerOk = false
    }
    rows.push({
        db: call.db,
        id: call.id,
        tool: call.name,
        model: call.model,
        provider: call.provider,
        rawOk,
        workerChanged: threw ? null : !same(raw, worker),
        workerOk,
        threw,
        raw,
        worker
    })
}

// everything that reaches the router, entry by entry
const reaching = []
for (const row of rows) {
    if (!row.workerOk) continue
    for (const entry of row.worker.ops) reaching.push({row, entry})
}
const out = JSON.parse(
    execFileSync(`${S}/rustprobe/target/release/rustprobe`, {
        input: JSON.stringify(reaching.map(r => ({tool: r.row.tool, entry: r.entry}))),
        maxBuffer: 1 << 30
    }).toString()
)
reaching.forEach((r, i) => Object.assign(r, out[i]))
writeFileSync(
    `${S}/pipeline-rows.json`,
    JSON.stringify(
        {
            rows: rows.map(({raw, worker, ...rest}) => rest),
            reaching: reaching.map(({row, ...rest}) => ({id: row.id, ...rest}))
        },
        null,
        1
    )
)
writeFileSync(`${S}/pipeline-full.json`, JSON.stringify(rows))

const n = (a, k) => a.filter(k).length
console.log('domain tool calls', rows.length)
console.log(
    '  raw already valid          ',
    n(rows, r => r.rawOk)
)
console.log(
    '  raw invalid                ',
    n(rows, r => !r.rawOk)
)
console.log(
    '    worker repaired to valid ',
    n(rows, r => !r.rawOk && r.workerOk)
)
console.log(
    '    worker refused (threw)   ',
    n(rows, r => !r.rawOk && r.threw)
)
console.log(
    '    still refused by schema  ',
    n(rows, r => !r.rawOk && !r.workerOk && !r.threw)
)
console.log(
    '  worker touched an already-valid call',
    n(rows, r => r.rawOk && r.workerChanged)
)
console.log('entries reaching the router', reaching.length)
console.log(
    '  unknown to the Rust table ',
    n(reaching, r => !r.known)
)
console.log(
    '  rust repair changed it    ',
    n(reaching, r => r.changed)
)
console.log(
    '  rust check refused it     ',
    n(reaching, r => r.checkAfter)
)
console.log(
    '  rust check would have refused it before repair',
    n(reaching, r => r.checkBefore)
)
for (const r of reaching.filter(r => r.changed || r.checkAfter))
    console.log(
        '   *',
        r.tool,
        r.op,
        JSON.stringify(r.before).slice(0, 200),
        '->',
        JSON.stringify(r.after).slice(0, 200),
        r.checkAfter
    )

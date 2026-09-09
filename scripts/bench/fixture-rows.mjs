import {readFileSync} from 'node:fs'
import {execFileSync} from 'node:child_process'
import Ajv from 'ajv'
import {declaredDomains} from '../declared-domains.mjs'
import {createGodotTools} from '../godot-tools.mjs'
import {validateToolArguments} from '@earendil-works/pi-ai'
const REPO = new URL('../..', import.meta.url).pathname

const S = process.env.SCRATCH ?? import.meta.dirname
const fixture = JSON.parse(readFileSync(`${REPO}/fixtures/tool-call-repairs.json`, 'utf8'))
const domains = await declaredDomains()
const tools = createGodotTools(domains, {call: async () => ({})})
const ajv = new Ajv({strict: false})
const valid = Object.fromEntries(tools.map(t => [t.name, ajv.compile(t.parameters)]))
const sorted = v =>
    JSON.stringify(v, (k, h) =>
        h && typeof h === 'object' && !Array.isArray(h) ?
            Object.fromEntries(Object.entries(h).sort())
        :   h
    )

const cf = []
const table = []
for (const row of fixture.repairs) {
    const tool = tools.find(t => t.name === row.tool)
    const args = {ops: [{op: row.op, ...row.wrote}]}
    let piOk = true
    try {
        validateToolArguments(tool, {id: 'one', name: tool.name, arguments: structuredClone(args)})
    } catch {
        piOk = false
    }
    const ajvOk = valid[row.tool](structuredClone(args))
    let workerOut = null,
        workerFixes = false
    try {
        workerOut = tool.prepareArguments(structuredClone(args))
        workerFixes = sorted(workerOut) === sorted({ops: [{op: row.op, ...row.becomes}]})
    } catch (e) {
        workerOut = 'THREW: ' + e.message.slice(0, 60)
    }
    cf.push({tool: row.tool, entry: {op: row.op, ...row.wrote}})
    table.push({
        why: row.why.slice(0, 58),
        tool: row.tool,
        op: row.op,
        labelled: row.repairedBy,
        schemaAccepts: ajvOk,
        piAccepts: piOk,
        workerRepairs: workerFixes
    })
}
const out = JSON.parse(
    execFileSync(`${S}/rustprobe/target/release/rustprobe`, {
        input: JSON.stringify(cf),
        maxBuffer: 1 << 28
    }).toString()
)
table.forEach((r, i) => {
    const want = sorted({...fixture.repairs[i].becomes})
    const got = sorted(out[i].after ?? {})
    r.rustRepairs = want === got
    r.rustRules = (out[i].rules ?? []).join('+') || '-'
    r.owner =
        r.schemaAccepts ?
            r.rustRepairs ?
                'router'
            :   'router(unrepaired)'
        :   'schema'
})
console.table(table)

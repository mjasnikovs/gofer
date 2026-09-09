// Recomputes every score from the calls each trial actually wrote, so a scoring question can be
// answered without paying for the sweep again.
import {readFile, writeFile} from 'node:fs/promises'
import Ajv from 'ajv'
import {normalizeGodotCall} from '../godot-tools.mjs'
import {TASKS} from './shapes-tasks.mjs'

const S = process.env.SCRATCH ?? import.meta.dirname
const IN = process.env.ROWS ?? 'shapes-rows'
const catalog = JSON.parse(await readFile(`${S}/catalog.json`, 'utf8'))
const toolsA = JSON.parse(await readFile(`${S}/shapes-tools-A.json`, 'utf8'))
const ajv = new Ajv({strict: false, allErrors: false})
const strict = Object.fromEntries(toolsA.map(t => [t.name, ajv.compile(t.parameters)]))
const paramsOf = Object.fromEntries(
    catalog.map(d => [
        d.name,
        Object.fromEntries(d.operations.map(o => [o.op, (o.params ?? []).map(p => p.name)]))
    ])
)
const wantOf = Object.fromEntries(TASKS.map(t => [t.id, t.wants]))

function swallowed(tool, entry) {
    const known = paramsOf[tool]?.[entry?.op]
    if (!known) return 0
    let count = 0
    for (const key of Object.keys(entry)) {
        if (key === 'op' || known.includes(key)) continue
        const trimmed = key.trim()
        if (known.includes(trimmed)) continue
        const head = trimmed.split(/[\s:=]/u)[0]
        if (known.includes(head)) count += 1
        else if (
            known.some(
                p => trimmed.toLowerCase().startsWith(p.toLowerCase()) && trimmed.length > p.length
            )
        )
            count += 1
    }
    return count
}

const rows = JSON.parse(await readFile(`${S}/${IN}.json`, 'utf8'))
const out = rows.map(row => {
    if (row.error) return row
    const fresh = {...row, validRaw: 0, validRepaired: 0, swallowed: 0, parsed: 0, done: 0}
    const seen = []
    for (const call of row.wrote ?? []) {
        if (!('args' in call)) continue
        fresh.parsed += 1
        const check = strict[call.tool]
        if (check?.(call.args)) fresh.validRaw += 1
        let repaired = call.args
        try {
            repaired = normalizeGodotCall(catalog, call.tool, call.args)
        } catch {
            /* a refusal is itself an invalid call */
        }
        if (check?.(repaired)) fresh.validRepaired += 1
        for (const entry of Array.isArray(call.args?.ops) ? call.args.ops : [])
            fresh.swallowed += swallowed(call.tool, entry)
        for (const entry of Array.isArray(repaired?.ops) ? repaired.ops : [])
            seen.push({tool: call.tool, ...entry})
    }
    fresh.done = wantOf[row.task]?.(seen) ? 1 : 0
    return fresh
})
await writeFile(`${S}/${IN}-rescored.json`, JSON.stringify(out, null, 2))
const changed = out.filter((r, i) => !r.error && r.done !== rows[i].done).length
console.log('rescored', out.length, 'rows; done flipped on', changed)

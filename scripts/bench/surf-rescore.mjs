// Recomputes every score from the calls each trial actually wrote, so a scoring question can be
// answered without paying for the sweep again.
import {readFile, writeFile} from 'node:fs/promises'
import Ajv from 'ajv'
import {ARMS} from './surf-arms.mjs'
import {TASKS, batchProgress} from './surf-tasks.mjs'

const S = process.env.SCRATCH ?? import.meta.dirname
const IN = process.env.ROWS ?? 'surf-rows'
const catalog = JSON.parse(await readFile(`${S}/catalog.json`, 'utf8'))
const ajv = new Ajv({strict: false, allErrors: false})
const own = {}
for (const arm of Object.keys(ARMS)) {
    const tools = JSON.parse(await readFile(`${S}/surf-tools-${arm}.json`, 'utf8'))
    own[arm] = Object.fromEntries(tools.map(t => [t.name, ajv.compile(t.parameters)]))
}
const S1 = JSON.parse(await readFile(`${S}/surf-tools-S1.json`, 'utf8'))
const canon = {}
for (const tool of S1.filter(t => t.name.startsWith('godot_')))
    for (const b of tool.parameters.properties.ops.items.oneOf ?? [])
        canon[`${tool.name}::${b.properties.op.const}`] = ajv.compile(b)
const paramsOf = Object.fromEntries(
    catalog.map(d => [
        d.name,
        Object.fromEntries(d.operations.map(o => [o.op, (o.params ?? []).map(p => p.name)]))
    ])
)
const wantOf = Object.fromEntries(TASKS.map(t => [t.id, t.wants]))

function swallowed(entry) {
    const known = paramsOf[entry?.tool]?.[entry?.op]
    if (!known) return 0
    let count = 0
    for (const key of Object.keys(entry)) {
        if (key === 'op' || key === 'tool' || known.includes(key)) continue
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
    const arm = ARMS[row.arm]
    const fresh = {
        ...row,
        parsed: 0,
        rawValid: 0,
        opsDecoded: 0,
        canonValid: 0,
        undecodable: 0,
        swallowed: 0,
        godotCalls: 0,
        done: 0
    }
    const seen = []
    for (const call of row.wrote ?? []) {
        const godot = arm.isGodot(call.tool)
        if (godot) fresh.godotCalls += 1
        if (!('args' in call)) continue
        fresh.parsed += 1
        if (own[row.arm][call.tool]?.(call.args)) fresh.rawValid += 1
        const decoded = godot ? (arm.decode(call.tool, call.args) ?? []) : []
        if (godot && decoded.length === 0) fresh.undecodable += 1
        for (const entry of decoded) {
            fresh.opsDecoded += 1
            const {tool, ...rest} = entry
            if (tool && canon[`${tool}::${rest.op}`]?.(rest)) fresh.canonValid += 1
            fresh.swallowed += swallowed(entry)
            seen.push(entry)
        }
    }
    fresh.done = wantOf[row.task]?.(seen) ? 1 : 0
    if (row.task === 'batch20') Object.assign(fresh, batchProgress(seen))
    return fresh
})
await writeFile(`${S}/${IN}-rescored.json`, JSON.stringify(out, null, 2))
console.log(
    'rescored',
    out.length,
    'rows; done flipped on',
    out.filter((r, i) => !r.error && r.done !== rows[i].done).length
)

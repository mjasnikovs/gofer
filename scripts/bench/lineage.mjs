import {readFileSync} from 'node:fs'
import Ajv from 'ajv'
import {declaredDomains} from '../declared-domains.mjs'
import {createGodotTools} from '../godot-tools.mjs'
const S = process.env.SCRATCH ?? import.meta.dirname
const corpus = JSON.parse(readFileSync(`${S}/corpus.json`, 'utf8'))
const domains = await declaredDomains()
const tools = createGodotTools(domains, {call: async () => ({})})
const ajv = new Ajv({strict: false})
const valid = Object.fromEntries(tools.map(t => [t.name, ajv.compile(t.parameters)]))
const declared = new Map()
for (const d of domains)
    for (const o of d.operations)
        declared.set(`${d.name} ${o.op}`, new Set((o.params ?? []).map(p => p.name)))
/** the offending keys, with digits flattened, so pathError4 and pathError5 are one mistake */
const badKeys = call => {
    const ops = Array.isArray(call.arguments?.ops) ? call.arguments.ops : []
    return [
        ...new Set(
            ops.flatMap(e =>
                e && typeof e === 'object' ?
                    Object.keys(e)
                        .filter(
                            k =>
                                k !== 'op'
                                && !(declared.get(`${call.name} ${e.op}`) ?? new Set()).has(k)
                        )
                        .map(k => k.replace(/\d+/gu, '#'))
                :   []
            )
        )
    ]
        .sort()
        .join(',')
}
const rows = []
const seatOf = new Map()
for (const call of corpus) {
    if (!valid[call.name]) continue
    const seat = (seatOf.get(call.task) ?? 0) + 1
    seatOf.set(call.task, seat)
    rows.push({
        ...call,
        seat,
        ok: valid[call.name](call.arguments),
        side: call.provider === 'local' ? 'local' : 'cloud'
    })
}
const bad = rows.filter(r => !r.ok)
const prev = new Map()
for (const f of bad) {
    const before = prev.get(f.task)
    const key = badKeys(f)
    f.lineage = Boolean(before && key !== '' && badKeys(before) === key)
    prev.set(f.task, f)
}
for (const side of ['local', 'cloud']) {
    const all = rows.filter(r => r.side === side)
    const b = bad.filter(r => r.side === side)
    const lin = b.filter(r => r.lineage)
    console.log(
        side,
        '| calls',
        all.length,
        '| failing',
        b.length,
        '| same offending key as the previous failure in the task',
        lin.length,
        '| lineages collapsed to one',
        b.length - lin.length,
        `= ${((100 * (b.length - lin.length)) / all.length).toFixed(2)}%`
    )
}
for (const side of ['local', 'cloud']) {
    const all = rows.filter(r => r.side === side)
    const b = bad.filter(r => r.side === side)
    const per = {}
    for (const r of b) per[r.task] = (per[r.task] ?? 0) + 1
    const worst = Object.entries(per).sort((a, c) => c[1] - a[1])[0][0]
    const keptAll = all.filter(r => r.task !== worst)
    const keptBad = b.filter(r => r.task !== worst)
    const keptCollapsed = keptBad.filter(r => !r.lineage)
    console.log(
        side,
        '| worst task',
        worst.slice(0, 8),
        `(${per[worst]} failures)`,
        '| without it',
        keptBad.length,
        '/',
        keptAll.length,
        `= ${((100 * keptBad.length) / keptAll.length).toFixed(2)}%`,
        '| and lineages collapsed',
        keptCollapsed.length,
        `= ${((100 * keptCollapsed.length) / keptAll.length).toFixed(2)}%`
    )
}

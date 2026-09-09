// An upper bound on what arm B would score if the Rust router repaired every tear it could:
// any key at all counts as `size`/`minSeverity` so long as the value survived the tear.
import {readFile} from 'node:fs/promises'
const S = process.env.SCRATCH ?? import.meta.dirname
const rows = JSON.parse(await readFile(`${S}/shapes-rows-all.json`, 'utf8'))
const value = (entry, want) =>
    Object.entries(entry).find(([, v]) => JSON.stringify(v) === JSON.stringify(want))
let byTask = {}
for (const row of rows) {
    if (row.error) continue
    const key = `${row.task}/${row.arm}`
    byTask[key] ??= {n: 0, strict: 0, generous: 0}
    byTask[key].n += 1
    byTask[key].strict += row.done
    let ok = row.done === 1
    for (const call of row.wrote ?? []) {
        for (const entry of Array.isArray(call.args?.ops) ? call.args.ops : []) {
            if (row.task === 'shape' && entry.op === 'create_shape')
                if (
                    entry.path === 'res://shapes/box.tres'
                    && entry.shapeType === 'RectangleShape2D'
                    && value(entry, [16, 16])
                )
                    ok = true
            if (row.task === 'logs' && entry.op === 'read')
                if (value(entry, 'error') && value(entry, 50)) ok = true
        }
    }
    if (ok) byTask[key].generous += 1
}
for (const [key, x] of Object.entries(byTask))
    console.log(
        key.padEnd(16),
        `n ${x.n}  strict ${Math.round((100 * x.strict) / x.n)}%  router-generous ${Math.round((100 * x.generous) / x.n)}%`
    )

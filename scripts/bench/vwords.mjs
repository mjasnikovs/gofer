// Every Godot word each arm actually wrote, so a failure can be read as a wrong word rather
// than a wrong call.
import {readFile} from 'node:fs/promises'
const S = process.env.SCRATCH ?? import.meta.dirname
const rows = JSON.parse(await readFile(`${S}/${process.env.ROWS}.json`, 'utf8'))
const words = entry => [
    ...(Array.isArray(entry.events) ? entry.events.map(e => e?.key).filter(Boolean) : []),
    ...(Array.isArray(entry.monitors) ? entry.monitors : []),
    ...(entry.value?.type ? [entry.value.type] : []),
    ...(Array.isArray(entry.properties) ?
        entry.properties.map(p => p?.value?.type).filter(Boolean)
    :   [])
]
const seen = {}
for (const row of rows) {
    if (row.error) continue
    const key = `${row.task} ${row.arm}`
    seen[key] ??= new Map()
    for (const call of row.wrote ?? [])
        for (const entry of call.args?.ops ?? [])
            for (const word of words(entry)) seen[key].set(word, (seen[key].get(word) ?? 0) + 1)
}
for (const key of Object.keys(seen).sort())
    console.log(
        key.padEnd(22),
        [...seen[key].entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([w, n]) => `${JSON.stringify(w)}x${n}`)
            .join(' ')
    )

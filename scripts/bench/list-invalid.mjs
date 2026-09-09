import {readFile} from 'node:fs/promises'
import Ajv from 'ajv'
const S = process.env.SCRATCH ?? import.meta.dirname
const toolsA = JSON.parse(await readFile(`${S}/shapes-tools-A.json`, 'utf8'))
const ajv = new Ajv({strict: false, allErrors: false})
const strict = Object.fromEntries(toolsA.map(t => [t.name, ajv.compile(t.parameters)]))
const rows = JSON.parse(await readFile(`${S}/shapes-rows-all.json`, 'utf8'))
let n = 0
for (const row of rows) {
    if (row.arm !== 'B' || row.error) continue
    for (const call of row.wrote ?? []) {
        if (!('args' in call)) continue
        if (strict[call.tool]?.(call.args)) continue
        n += 1
        console.log(
            `${String(n).padStart(2)} ${row.task}/${row.seed} ${call.tool} ${JSON.stringify(call.args).slice(0, 200)}`
        )
    }
}
console.log('invalid arm-B calls:', n)

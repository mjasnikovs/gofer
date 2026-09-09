import {readFile} from 'node:fs/promises'
import {jsonSchemaOfEntry, jsonSchemaOfParams} from '../tool-schema.mjs'
const SCRATCH = process.env.SCRATCH ?? import.meta.dirname
const domains = JSON.parse(await readFile(`${SCRATCH}/catalog.json`, 'utf8'))
const tok = async content =>
    (
        await (
            await fetch('http://localhost:8080/tokenize', {
                method: 'POST',
                headers: {'content-type': 'application/json'},
                body: JSON.stringify({content})
            })
        ).json()
    ).tokens.length
// the pre-2026-09-09 shape: every op's params merged into one open object
const merged = ops => {
    const props = {op: {type: 'string', enum: ops.map(o => o.op)}}
    for (const o of ops) Object.assign(props, jsonSchemaOfParams(o.params ?? []).properties)
    return {type: 'object', properties: props, required: ['op']}
}
let now = 0,
    before = 0,
    opConst = 0,
    opSummaries = 0
for (const d of domains) {
    now += await tok(JSON.stringify(jsonSchemaOfEntry(d.operations)))
    before += await tok(JSON.stringify(merged(d.operations)))
    for (const o of d.operations) {
        opConst += await tok(JSON.stringify({op: {const: o.op, description: o.summary}}))
        opSummaries += await tok(o.summary ?? '')
    }
}
console.log({
    oneOfSchemaTokens: now,
    mergedEquivalentTokens: before,
    delta: now - before,
    opConstBlocks: opConst,
    opSummaryProse: opSummaries
})
// prose vs schema split inside the godot descriptions
let domainProse = 0,
    opLines = 0
for (const d of domains) {
    domainProse += await tok(d.description)
    for (const o of d.operations)
        opLines += await tok(`- ${o.op}${o.signature ? ' ' + o.signature : ''}: ${o.summary}`)
}
console.log({domainDescriptionProse: domainProse, operationListLines: opLines})

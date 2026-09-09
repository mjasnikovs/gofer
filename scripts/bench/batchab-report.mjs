import {readFile} from 'node:fs/promises'
const S = process.env.SCRATCH ?? import.meta.dirname
const rows = JSON.parse(await readFile(`${S}/batchab-rows-${process.env.ROWS}.json`, 'utf8'))
const ok = rows.filter(r => !r.error)
const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length
const median = xs => {
    const s = [...xs].sort((a, b) => a - b)
    return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
}
const METRICS = [
    ['modelTurns', r => r.assistantTurns],
    ['toolCalls', r => r.calls],
    ['firstMsgCalls', r => r.firstCalls ?? 0],
    ['addonRPCs', r => r.mutations],
    ['completionTok', r => r.completionTokens],
    ['promptTok', r => r.promptTokens],
    ['wallMs', r => r.ms],
    ['nodesRight', r => r.namedRight],
    ['posRight', r => r.placedRight],
    ['schemaValid', r => (r.parsed > 0 && r.validRaw === r.parsed ? 1 : 0)],
    ['repairNeeded', r => (r.validRepaired > r.validRaw ? 1 : 0)],
    ['complete', r => r.done]
]
const arms = [...new Set(ok.map(r => r.arm))].sort()
const width = 15
console.log(
    `n per arm: ${arms.map(a => `${a}=${ok.filter(r => r.arm === a).length}`).join(' ')}   errors: ${rows.length - ok.length}`
)
console.log('metric'.padEnd(width) + arms.map(a => `${a} mean/med`.padStart(18)).join(''))
for (const [name, of] of METRICS) {
    const cells = arms.map(a => {
        const xs = ok.filter(r => r.arm === a).map(of)
        return `${mean(xs).toFixed(2)}/${median(xs).toFixed(1)}`.padStart(18)
    })
    console.log(name.padEnd(width) + cells.join(''))
}

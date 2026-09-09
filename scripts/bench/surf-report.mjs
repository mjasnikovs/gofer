import {readFile} from 'node:fs/promises'
const S = process.env.SCRATCH ?? import.meta.dirname
const rows = JSON.parse(await readFile(`${S}/${process.env.ROWS ?? 'surf-rows'}.json`, 'utf8'))
const ok = rows.filter(r => !r.error)
const arms = ['S1', 'S2', 'S3', 'S4', 'S4b'].filter(a => ok.some(r => r.arm === a))
const tasks = [...new Set(ok.map(r => r.task))]
const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
const pct = x => `${(100 * x).toFixed(0)}%`

const METRICS = [
    ['success', r => r.done, pct],
    ['rawInvalid', r => (r.parsed > 0 ? (r.parsed - r.rawValid) / r.parsed : 0), pct],
    [
        'canonInvalid',
        r => (r.opsDecoded > 0 ? (r.opsDecoded - r.canonValid) / r.opsDecoded : 0),
        pct
    ],
    ['unparsable', r => r.unparsable, x => x.toFixed(2)],
    ['swallowedKeys', r => r.swallowed, x => x.toFixed(2)],
    ['modelTurns', r => r.turns, x => x.toFixed(2)],
    ['callsPerMsg', r => r.calls / Math.max(1, r.turns), x => x.toFixed(2)],
    ['editorRPCs', r => r.godotCalls, x => x.toFixed(2)],
    ['opsDecoded', r => r.opsDecoded, x => x.toFixed(2)],
    ['promptTok/turn', r => r.promptTokens / Math.max(1, r.turns), x => x.toFixed(0)],
    ['promptTok/trial', r => r.promptTokens, x => x.toFixed(0)],
    ['complTok/trial', r => r.completionTokens, x => x.toFixed(0)],
    ['wallMs/trial', r => r.ms, x => x.toFixed(0)],
    ['noCallTurns', r => r.noCall, x => x.toFixed(2)]
]

function table(label, subset) {
    console.log(
        `\n## ${label}   n/arm ${arms.map(a => `${a}=${subset.filter(r => r.arm === a).length}`).join(' ')}`
    )
    console.log('metric'.padEnd(16) + arms.map(a => a.padStart(11)).join(''))
    for (const [name, of, fmt] of METRICS)
        console.log(
            name.padEnd(16)
                + arms
                    .map(a => fmt(mean(subset.filter(r => r.arm === a).map(of))).padStart(11))
                    .join('')
        )
}

table('ALL TASKS', ok)
for (const task of tasks)
    table(
        `task ${task}`,
        ok.filter(r => r.task === task)
    )

const b = ok.filter(r => r.task === 'batch20')
if (b.length) {
    console.log('\n## batch20 partial credit (of 20)')
    console.log('metric'.padEnd(16) + arms.map(a => a.padStart(11)).join(''))
    for (const [name, of] of [
        ['nodesRight', r => r.named ?? 0],
        ['posRight', r => r.placed ?? 0]
    ])
        console.log(
            name.padEnd(16)
                + arms
                    .map(a =>
                        mean(b.filter(r => r.arm === a).map(of))
                            .toFixed(1)
                            .padStart(11)
                    )
                    .join('')
        )
}

console.log('\n## paired sign counts vs S1, per (task, seed)  [S1 better / S1 worse / tie]')
const key = r => `${r.task}#${r.seed}`
const byArm = Object.fromEntries(
    arms.map(a => [a, Object.fromEntries(ok.filter(r => r.arm === a).map(r => [key(r), r]))])
)
const LOWER = new Set([
    'rawInvalid',
    'canonInvalid',
    'unparsable',
    'swallowedKeys',
    'modelTurns',
    'editorRPCs',
    'opsDecoded',
    'promptTok/turn',
    'promptTok/trial',
    'complTok/trial',
    'wallMs/trial',
    'noCallTurns'
])
for (const other of arms.filter(a => a !== 'S1')) {
    console.log(`\nS1 vs ${other}`)
    for (const [name, of] of METRICS) {
        let better = 0
        let worse = 0
        let tie = 0
        for (const k of Object.keys(byArm.S1)) {
            const left = byArm.S1[k]
            const right = byArm[other]?.[k]
            if (!right) continue
            const a = of(left)
            const z = of(right)
            if (a === z) tie += 1
            else if (LOWER.has(name) ? a < z : a > z) better += 1
            else worse += 1
        }
        console.log(
            `  ${name.padEnd(16)} ${String(better).padStart(3)} / ${String(worse).padStart(3)} / ${String(tie).padStart(3)}`
        )
    }
}
const errs = rows.filter(r => r.error)
if (errs.length) console.log('\nerrors', errs.length, JSON.stringify(errs.slice(0, 3)))

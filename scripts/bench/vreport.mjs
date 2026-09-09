import {readFile} from 'node:fs/promises'
const S = process.env.SCRATCH ?? import.meta.dirname
const rows = JSON.parse(await readFile(`${S}/${process.env.ROWS}.json`, 'utf8'))
const BASE = process.env.BASE
const ok = rows.filter(r => !r.error)
const arms = [...new Set(ok.map(r => r.arm))]
const tasks = [...new Set(ok.map(r => r.task))]
const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
const pct = x => `${(100 * x).toFixed(0)}%`

const METRICS = [
    ['success', r => r.done, pct],
    ['firstTurn', r => r.firstTry, pct],
    ['turns', r => r.turns, x => x.toFixed(2)],
    ['refusals', r => r.refusals, x => x.toFixed(2)],
    ['traps', r => r.traps, x => x.toFixed(2)],
    ['rawInvalid', r => (r.parsed > 0 ? (r.parsed - r.rawValid) / r.parsed : 0), pct],
    ['unparsable', r => r.unparsable, x => x.toFixed(2)],
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

console.log(
    `\n## paired sign counts vs ${BASE}, per (task, seed)  [${BASE} better / ${BASE} worse / tie]`
)
const key = r => `${r.task}#${r.seed}`
const byArm = Object.fromEntries(
    arms.map(a => [a, Object.fromEntries(ok.filter(r => r.arm === a).map(r => [key(r), r]))])
)
const LOWER = new Set([
    'turns',
    'refusals',
    'traps',
    'rawInvalid',
    'unparsable',
    'opsDecoded',
    'promptTok/turn',
    'promptTok/trial',
    'complTok/trial',
    'wallMs/trial',
    'noCallTurns'
])
for (const other of arms.filter(a => a !== BASE)) {
    console.log(`\n${BASE} vs ${other}`)
    for (const [name, of] of METRICS) {
        let better = 0
        let worse = 0
        let tie = 0
        for (const k of Object.keys(byArm[BASE])) {
            const right = byArm[other]?.[k]
            if (!right) continue
            const a = of(byArm[BASE][k])
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

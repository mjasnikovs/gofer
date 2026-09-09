import {readFile} from 'node:fs/promises'
const S = process.env.SCRATCH ?? import.meta.dirname
const rows = JSON.parse(await readFile(`${S}/${process.env.ROWS ?? 'shapes-rows'}.json`, 'utf8'))
const ok = rows.filter(r => !r.error)
const arms = [...new Set(ok.map(r => r.arm))].sort()
const tasks = [...new Set(ok.map(r => r.task))]
const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
const pct = x => `${(100 * x).toFixed(0)}%`

const METRICS = [
    ['promptTok/turn', r => r.promptTokens / Math.max(1, r.turns), x => x.toFixed(0)],
    ['complTok/turn', r => r.completionTokens / Math.max(1, r.turns), x => x.toFixed(0)],
    ['wallMs/turn', r => r.ms / Math.max(1, r.turns), x => x.toFixed(0)],
    ['modelTurns', r => r.turns, x => x.toFixed(2)],
    ['rawInvalid', r => (r.parsed > 0 ? (r.parsed - r.validRaw) / r.parsed : 0), pct],
    ['postRepairInv', r => (r.parsed > 0 ? (r.parsed - r.validRepaired) / r.parsed : 0), pct],
    ['swallowedKeys', r => r.swallowed, x => x.toFixed(2)],
    ['unparsable', r => r.unparsable, x => x.toFixed(2)],
    ['success', r => r.done, pct]
]

function table(label, subset) {
    console.log(
        `\n## ${label}   n/arm ${arms.map(a => `${a}=${subset.filter(r => r.arm === a).length}`).join(' ')}`
    )
    console.log('metric'.padEnd(16) + arms.map(a => a.padStart(12)).join(''))
    for (const [name, of, fmt] of METRICS) {
        const cells = arms.map(a => fmt(mean(subset.filter(r => r.arm === a).map(of))).padStart(12))
        console.log(name.padEnd(16) + cells.join(''))
    }
}

for (const task of tasks)
    table(
        `task ${task}`,
        ok.filter(r => r.task === task)
    )
table('ALL TASKS', ok)

// paired signs: every arm sees the same (task, seed), so each pair is a real comparison
console.log('\n## paired sign counts (A better / worse / tie), per (task, seed)')
const key = r => `${r.task}#${r.seed}`
const byArm = Object.fromEntries(
    arms.map(a => [a, Object.fromEntries(ok.filter(r => r.arm === a).map(r => [key(r), r]))])
)
const LOWER_IS_BETTER = new Set([
    'promptTok/turn',
    'complTok/turn',
    'wallMs/turn',
    'modelTurns',
    'rawInvalid',
    'postRepairInv',
    'swallowedKeys',
    'unparsable'
])
for (const other of arms.filter(a => a !== 'A')) {
    console.log(`\nA vs ${other}`)
    for (const [name, of] of METRICS) {
        let better = 0
        let worse = 0
        let tie = 0
        for (const k of Object.keys(byArm.A)) {
            const left = byArm.A[k]
            const right = byArm[other]?.[k]
            if (!right) continue
            const a = of(left)
            const b = of(right)
            if (a === b) tie += 1
            else if (LOWER_IS_BETTER.has(name) ? a < b : a > b) better += 1
            else worse += 1
        }
        console.log(
            `  ${name.padEnd(16)} A better ${String(better).padStart(3)}  A worse ${String(worse).padStart(3)}  tie ${String(tie).padStart(3)}`
        )
    }
}

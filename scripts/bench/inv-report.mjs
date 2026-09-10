// surf-report.mjs's shape for the inventory trim: means per arm, then the paired sign counts per
// (task, seed), which is the only comparison that means anything here.
import {readFile} from 'node:fs/promises'
const S = process.env.SCRATCH ?? import.meta.dirname
const rows = JSON.parse(await readFile(`${S}/${process.env.ROWS ?? 'inv-rows'}.json`, 'utf8'))
const ok = rows.filter(row => !row.error)
const arms = [...new Set(ok.map(row => row.arm))]
const BASE = process.env.BASE ?? arms[0]
const tasks = [...new Set(ok.map(row => row.task))]
const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
const pct = x => `${(100 * x).toFixed(0)}%`
const two = x => x.toFixed(2)

const METRICS = [
    ['success', r => r.done, pct],
    ['findCalls', r => r.findCalls, two],
    ['ghostPaths', r => r.ghostPaths, two],
    ['absolutePaths', r => r.absolutePaths, two],
    ['bashCalls', r => r.bashCalls, two],
    ['listOps', r => r.listOps, two],
    ['modelTurns', r => r.turns, two],
    ['editorRPCs', r => r.godotCalls, two],
    ['opsDecoded', r => r.opsDecoded, two],
    ['unparsable', r => r.unparsable, two],
    ['promptTok/turn', r => r.promptTokens / Math.max(1, r.turns), x => x.toFixed(0)],
    ['promptTok/trial', r => r.promptTokens, x => x.toFixed(0)],
    ['complTok/trial', r => r.completionTokens, x => x.toFixed(0)],
    ['wallMs/trial', r => r.ms, x => x.toFixed(0)],
    ['noCallTurns', r => r.noCall, two]
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

const LOWER = new Set([
    'findCalls',
    'ghostPaths',
    'absolutePaths',
    'bashCalls',
    'listOps',
    'modelTurns',
    'editorRPCs',
    'opsDecoded',
    'unparsable',
    'promptTok/turn',
    'promptTok/trial',
    'complTok/trial',
    'wallMs/trial',
    'noCallTurns'
])

console.log(
    `\n## paired sign counts vs ${BASE}, per (task, seed)  [${BASE} better / ${BASE} worse / tie]`
)
const key = row => `${row.task}#${row.seed}`
const byArm = Object.fromEntries(
    arms.map(a => [a, Object.fromEntries(ok.filter(r => r.arm === a).map(r => [key(r), r]))])
)
for (const other of arms.filter(a => a !== BASE)) {
    console.log(`\n${BASE} vs ${other}`)
    for (const [name, of] of METRICS) {
        let better = 0
        let worse = 0
        let tie = 0
        for (const k of Object.keys(byArm[BASE])) {
            const left = byArm[BASE][k]
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

const ghosts = ok.flatMap(row => (row.ghosts ?? []).map(path => `${row.arm} ${row.task} ${path}`))
if (ghosts.length) {
    console.log('\n## every path named that the project does not have')
    const counted = new Map()
    for (const one of ghosts) counted.set(one, (counted.get(one) ?? 0) + 1)
    for (const [one, count] of [...counted].sort((a, b) => b[1] - a[1]))
        console.log(`  ${String(count).padStart(3)}  ${one}`)
}

const errs = rows.filter(row => row.error)
if (errs.length) console.log('\nerrors', errs.length, JSON.stringify(errs.slice(0, 3)))

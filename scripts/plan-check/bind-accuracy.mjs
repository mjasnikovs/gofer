// Does the binder pick the repo the plan was actually written in?
// The number smoke 3 was missing.

import {readdirSync, readFileSync, existsSync} from 'node:fs'
import {join} from 'node:path'
import {bindRepo, candidateRepos} from './bind.mjs'
import {buildTruth} from './truth.mjs'

const PLANS = '/home/edgars/.claude/plans'
const repos = candidateRepos(['/home/edgars/hub', '/home/edgars/.pi/agent/extensions'])
const truth = buildTruth(repos)

let known = 0,
    right = 0,
    wrong = 0,
    refused = 0
const misses = []
for (const f of readdirSync(PLANS).filter(f => f.endsWith('.md'))) {
    const t = truth.get(f)
    if (!t) continue
    known++
    const b = bindRepo(readFileSync(join(PLANS, f), 'utf8'), repos)
    if (!b.repo) {
        refused++
        continue
    }
    if (b.repo === t) right++
    else {
        wrong++
        misses.push(`${f}\n     bound  ${b.repo}\n     truth  ${t}`)
    }
}
console.log(`plans with ground truth: ${known}`)
console.log(`  bound correctly: ${right}`)
console.log(`  bound WRONG:     ${wrong}`)
console.log(`  refused:         ${refused}`)
console.log(`accuracy over bound: ${((100 * right) / (right + wrong || 1)).toFixed(1)}%`)
for (const m of misses.slice(0, 15)) console.log('   ' + m)

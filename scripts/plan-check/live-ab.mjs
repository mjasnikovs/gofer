// LIVE SMOKE: does a real model write plans with invented file facts, and does
// plan-check catch them?
//
// Interleaved A/B in one process, because cross-run numbers flip sign:
//   arm A - the model gets no file inventory
//   arm B - the model gets `git ls-files` for the repo
// Same task, same seed order, alternating. If the checker measures invention
// rather than noise, A must carry more findings than B.

import {execFileSync} from 'node:child_process'
import {writeFileSync, mkdirSync} from 'node:fs'
import {checkPlan} from '/home/edgars/hub/gofer/scripts/plan-check/index.mjs'
import {candidateRepos} from '/home/edgars/hub/gofer/scripts/plan-check/bind.mjs'

const ENDPOINT = 'http://localhost:8080/v1/chat/completions'
const OUT = process.env.OUT ?? '/tmp/live-plans'
mkdirSync(OUT, {recursive: true})
const NEIGHBOURS = candidateRepos(['/home/edgars/hub', '/home/edgars/.pi/agent/extensions'])

const TASKS = [
    {
        repo: '/home/edgars/hub/swarm',
        ask: 'Make enemy spiders drop a pickup when they die, and let a unit collect it.'
    },
    {
        repo: '/home/edgars/hub/swarm',
        ask: 'Add a wave counter to the HUD that increases every time the swarm is cleared.'
    },
    {
        repo: '/home/edgars/hub/swarm',
        ask: 'Let the player pause the game with Escape and show a pause overlay.'
    },
    {
        repo: '/home/edgars/hub/swarm',
        ask: 'Give each unit class a distinct muzzle flash when it fires.'
    },
    {
        repo: '/home/edgars/hub/swarm',
        ask: 'Add a sell button that refunds half a placed unit and removes it.'
    },
    {
        repo: '/home/edgars/hub/swarm',
        ask: 'Show a damage number floating up from a spider when it is hit.'
    }
]

const FORMAT = `Write an implementation plan using EXACTLY these ALL-CAPS section headers, in this order:

GOAL
CONSTRAINTS
STEPS
VERIFY

Rules:
- Write every file path and code symbol in backticks, e.g. \`scripts/units/units.gd\`.
- CONSTRAINTS lists things that must hold, including files that must NOT be modified.
- STEPS is a numbered list naming the files to change.
- VERIFY is a fenced \`\`\`sh block of commands that prove the work.
Be specific and concrete. Name real files.`

function inventory(repo) {
    return execFileSync('git', ['-C', repo, 'ls-files'], {encoding: 'utf8'})
        .split('\n')
        .filter(Boolean)
        .join('\n')
}

async function ask(prompt) {
    const r = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({
            model: '/models/Qwen3.8-27B-UD-Q4_K_XL.gguf',
            messages: [{role: 'user', content: prompt}],
            temperature: 0.7,
            max_tokens: 2000,
            stream: false
        })
    })
    if (!r.ok) throw new Error(`${r.status} ${await r.text()}`)
    const j = await r.json()
    return j.choices?.[0]?.message?.content ?? ''
}

const rows = []
for (const [i, t] of TASKS.entries()) {
    for (const arm of ['A', 'B']) {
        const inv =
            arm === 'B' ?
                `\n\nThe repository contains exactly these files:\n${inventory(t.repo)}\n`
            :   ''
        const prompt = `You are planning a change to a Godot 4 project at ${t.repo}.${inv}\n\nTASK: ${t.ask}\n\n${FORMAT}`
        let text = ''
        let err = null
        try {
            text = await ask(prompt)
        } catch (e) {
            err = String(e).slice(0, 120)
        }
        if (err) {
            rows.push({i, arm, err})
            console.log(`task ${i} arm ${arm}  ERROR ${err}`)
            continue
        }
        // Strip a reasoning block if the model emits one.
        text = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
        const f = `${OUT}/task${i}-${arm}.md`
        writeFileSync(f, text)
        const r = checkPlan(text, t.repo, NEIGHBOURS)
        const kinds = {}
        for (const x of r.findings) kinds[x.kind] = (kinds[x.kind] ?? 0) + 1
        rows.push({
            i,
            arm,
            claims: r.claims,
            findings: r.findings.length,
            kinds,
            file: f,
            list: r.findings.map(x => `${x.kind}:${x.what}`)
        })
        console.log(
            `task ${i} arm ${arm}  claims ${String(r.claims).padStart(3)}  findings ${r.findings.length}  ${JSON.stringify(kinds)}`
        )
    }
}

const sum = arm => {
    const rs = rows.filter(r => r.arm === arm && !r.err)
    return {
        plans: rs.length,
        claims: rs.reduce((a, r) => a + r.claims, 0),
        findings: rs.reduce((a, r) => a + r.findings, 0)
    }
}
const A = sum('A'),
    B = sum('B')
console.log(`\n=== LIVE A/B  (Qwen3-27B, interleaved, same process)`)
console.log(
    `arm A  no inventory   plans ${A.plans}  claims ${A.claims}  findings ${A.findings}  per-plan ${(A.findings / (A.plans || 1)).toFixed(2)}`
)
console.log(
    `arm B  git ls-files   plans ${B.plans}  claims ${B.claims}  findings ${B.findings}  per-plan ${(B.findings / (B.plans || 1)).toFixed(2)}`
)
writeFileSync(`${OUT}/rows.json`, JSON.stringify(rows, null, 2))

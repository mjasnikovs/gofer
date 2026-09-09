// The smoke harness. Produces numbers, not a pass/fail feeling: the risk this
// checker carries is noise, so the headline is findings-per-plan.

import {readFileSync, readdirSync, existsSync} from 'node:fs'
import {join} from 'node:path'
import {claimsOf, bindRepo, candidateRepos} from './bind.mjs'
import {sections, tokensIn} from './extract.mjs'
import {isFileClaim} from './classify.mjs'
import {makeIndex, resolveClaim} from './resolve.mjs'

const ROOTS = ['/home/edgars/hub', '/home/edgars/.pi/agent/extensions']

function smoke1() {
    let plans = 0,
        cand = 0,
        miss = 0
    const seen = new Map()
    for (const d of readdirSync('/home/edgars/hub')) {
        const repo = join('/home/edgars/hub', d)
        const dir = join(repo, '.pi-tasks')
        if (!existsSync(dir)) continue
        const index = makeIndex(repo)
        for (const f of readdirSync(dir).filter(f => /^TASK_\d+\.md$/.test(f))) {
            const body = sections(readFileSync(join(dir, f), 'utf8'))['CONSTRAINTS']
            if (!body) continue
            plans++
            for (const tok of tokensIn(body)) {
                if (!isFileClaim(tok)) continue
                cand++
                if (!resolveClaim(index, tok)) {
                    miss++
                    const k = `${d}: ${tok}`
                    seen.set(k, (seen.get(k) ?? 0) + 1)
                }
            }
        }
    }
    console.log('=== SMOKE 1  pi-task CONSTRAINTS corpus')
    console.log(
        `plans ${plans}   claims ${cand}   findings ${miss}   rate ${((100 * miss) / (cand || 1)).toFixed(1)}%   per-plan ${(miss / (plans || 1)).toFixed(2)}`
    )
    for (const [k, n] of [...seen].sort((a, b) => b[1] - a[1]).slice(0, 10))
        console.log(`   ${n}x ${k}`)
    return {plans, cand, miss}
}

function smoke3() {
    const dir = '/home/edgars/.claude/plans'
    const repos = candidateRepos(ROOTS)
    let plans = 0,
        bound = 0,
        unbound = 0,
        miss = 0,
        cand = 0,
        cross = 0
    const hist = new Map()
    const worst = []
    for (const f of readdirSync(dir).filter(f => f.endsWith('.md'))) {
        const text = readFileSync(join(dir, f), 'utf8')
        plans++
        const b = bindRepo(text, repos)
        if (!b.repo) {
            unbound++
            continue
        }
        bound++
        const index = makeIndex(b.repo)
        const claims = claimsOf(text)
        cand += claims.length
        // Cross-repo references are counted separately: they are a different
        // finding, and folding them in was what made this smoke look noisy.
        const unresolved = claims.filter(c => !resolveClaim(index, c.token))
        const strong = (o, t) => ['exact', 'suffix'].includes(resolveClaim(makeIndex(o), t))
        const bad = unresolved.filter(c => !repos.some(o => o !== b.repo && strong(o, c.token)))
        cross += unresolved.length - bad.length
        miss += bad.length
        hist.set(bad.length, (hist.get(bad.length) ?? 0) + 1)
        if (bad.length) worst.push([bad.length, f, b.repo.split('/').pop()])
    }
    console.log('\n=== SMOKE 3  ~/.claude/plans, repo inferred per plan')
    console.log(`plans ${plans}   bound ${bound}   unbound(refused) ${unbound}`)
    console.log(
        `claims ${cand}   findings ${miss}   rate ${((100 * miss) / (cand || 1)).toFixed(1)}%   per-bound-plan ${(miss / (bound || 1)).toFixed(2)}`
    )
    console.log(
        `histogram findings->plans: ${[...hist]
            .sort((a, b) => a[0] - b[0])
            .map(([k, v]) => `${k}:${v}`)
            .join('  ')}`
    )
    for (const [n, f, r] of worst.sort((a, b) => b[0] - a[0]).slice(0, 8))
        console.log(`   ${n}  ${f}  [${r}]`)
}

smoke1()
smoke3()

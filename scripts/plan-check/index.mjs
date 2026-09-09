// plan-check <plan.md> [--repo <dir>] [--auto] [--json]
//
// Four checks over a written plan, all advisory. Nothing here edits, rewrites,
// or blocks; each finding names a token and the section it came from and stops.
//
//   1  file claims        a backticked path that resolves to nothing
//   2  repo binding       which repo the plan is even about (--auto infers it)
//   3  citations          `path:line` + quoted text, verified against the file
//   4  verify block       shell commands that cannot fail or never execute,
//                         and Godot node paths checked against the run scene
//
// Guard direction throughout: may cost time, never work. Every undecidable
// input steps aside instead of being guessed at.

import {readFileSync} from 'node:fs'
import {claimsOf, bindRepo, candidateRepos} from './bind.mjs'
import {makeIndex, resolveClaim} from './resolve.mjs'
import {checkCitations} from './citations.mjs'
import {verifyCommands, runtimeTargets} from './verify-block.mjs'
import {findGrepOnlyVerify, classifyExitStatus} from './verify-shell.mjs'
import {isGodotRepo, checkNodePathInScene, findNodeByName} from './godot-nodes.mjs'

/**
 * A claim that resolves in some OTHER candidate repo is a cross-repo reference,
 * not a phantom. Plans cite a sibling constantly - a server plan naming a client
 * component, a plan citing pi-task as a reference implementation - and calling
 * those missing is correct about the filesystem and wrong about the plan.
 *
 * Reported separately rather than suppressed: naming a file in another repo may
 * still be a mistake, but it is a different one, and the reader decides.
 */
function elsewhere(token, repo, neighbours) {
    for (const other of neighbours) {
        if (other === repo) continue
        // Exact or suffix only. A basename hit is far too weak to call a token
        // "a file in another repo": a live run labelled `scripts/units/unit.gd`
        // cross-repo when no repo has that path at all - some project merely had
        // a file named unit.gd. That turns an invention into a false reassurance.
        const how = resolveClaim(makeIndex(other), token)
        if (how === 'exact' || how === 'suffix') return other
    }
    return null
}

export function checkPlan(text, repo, neighbours = []) {
    const findings = []
    const index = makeIndex(repo)

    const claims = claimsOf(text)
    for (const c of claims) {
        if (resolveClaim(index, c.token)) continue
        const other = elsewhere(c.token, repo, neighbours)
        if (other) {
            findings.push({
                fix: 1,
                kind: 'cross-repo-path',
                where: c.section,
                what: c.token,
                why: `resolves in ${other}, not in this repo`
            })
        } else {
            // A bare filename matching one in a sibling is still unresolved here,
            // but saying so is the difference between "you invented this" and
            // "you meant the one next door and did not say which".
            const weak = neighbours.find(o => o !== repo && resolveClaim(makeIndex(o), c.token))
            findings.push({
                fix: 1,
                kind: 'unresolved-path',
                where: c.section,
                what: c.token,
                why:
                    weak ?
                        `a file of this name exists in ${weak}, but not this path here`
                    :   undefined
            })
        }
    }

    for (const c of checkCitations(text, repo)) {
        if (!c.ok) {
            findings.push({
                fix: 3,
                kind: 'bad-citation',
                where: `${c.path}:${c.line}`,
                what: c.quote,
                why: c.why
            })
        }
    }

    const {shell, runtime} = verifyCommands(text)
    for (const cmd of shell) {
        const v = classifyExitStatus(cmd)
        if (v.cls === 'unfailable')
            findings.push({
                fix: 4,
                kind: 'unfailable-command',
                where: 'VERIFY',
                what: cmd,
                why: v.reason
            })
    }
    for (const g of findGrepOnlyVerify(shell)) {
        findings.push({
            fix: 4,
            kind: 'grep-theater',
            where: 'VERIFY',
            what: g.target,
            why: 'inspected statically, never run'
        })
    }
    if (isGodotRepo(repo)) {
        for (const r of runtime) {
            if (r.spec === null) continue
            const {scene, paths} = runtimeTargets(r.spec)
            if (!scene) continue
            for (const p of paths) {
                const v = checkNodePathInScene(repo, scene, p)
                if (v.ok === false) {
                    const seen = findNodeByName(repo, p.split('/').filter(Boolean).pop())
                    findings.push({
                        fix: 4,
                        kind: 'bad-node-path',
                        where: `VERIFY (runs ${scene})`,
                        what: p,
                        why:
                            v.why
                            + (seen.length ? ` — that node is declared in ${seen.join(', ')}` : '')
                    })
                }
            }
        }
    }
    return {claims: claims.length, shell: shell.length, runtime: runtime.length, findings}
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const args = process.argv.slice(2)
    const planPath = args.find(a => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--repo')
    if (!planPath) {
        console.error('usage: plan-check <plan.md> [--repo <dir>] [--auto]')
        process.exit(2)
    }
    const text = readFileSync(planPath, 'utf8')

    let repo = args.includes('--repo') ? args[args.indexOf('--repo') + 1] : null
    let bindNote = 'given with --repo'
    if (!repo || args.includes('--auto')) {
        const b = bindRepo(
            text,
            candidateRepos(['/home/edgars/hub', '/home/edgars/.pi/agent/extensions'])
        )
        if (!b.repo) {
            console.error(`plan-check: cannot bind a repo — ${b.reason}`)
            console.error('pass --repo <dir> explicitly.')
            process.exit(3)
        }
        repo = b.repo
        bindNote = `inferred: ${b.reason}`
    }

    const r = checkPlan(
        text,
        repo,
        candidateRepos(['/home/edgars/hub', '/home/edgars/.pi/agent/extensions'])
    )
    if (args.includes('--json')) {
        console.log(JSON.stringify({repo, ...r}, null, 2))
    } else {
        console.log(`plan:  ${planPath}`)
        console.log(`repo:  ${repo}   (${bindNote})`)
        console.log(
            `file claims: ${r.claims}   verify shell: ${r.shell}   verify runtime: ${r.runtime}`
        )
        console.log(`FINDINGS: ${r.findings.length}\n`)
        for (const f of r.findings) {
            console.log(`  [fix ${f.fix}] ${f.kind}  ${f.what}`)
            console.log(`            in ${f.where}${f.why ? `\n            ${f.why}` : ''}`)
        }
    }
    process.exit(0)
}

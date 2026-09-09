// FIX 2 - which repo is this plan about?
//
// Measured need: pointing the checker at the wrong repo turned one real plan
// into 33 fake findings, and into 1 real one when pointed correctly. A plan in
// ~/.claude/plans records no binding to any repo, so it has to be inferred or
// refused.
//
// The inference is a vote, not a guess: score each candidate by how many of the
// plan's file claims resolve in it, and accept only an unambiguous winner. A tie
// or an empty field returns null, and the caller must then be told rather than
// given a repo it did not choose.

import {readdirSync, existsSync} from 'node:fs'
import {join} from 'node:path'
import {sections, referenceSections, tokensIn} from './extract.mjs'
import {isFileClaim} from './classify.mjs'
import {makeIndex, resolveClaim} from './resolve.mjs'

/**
 * Binding and reporting ask different questions, so they read different scopes.
 *
 * To IDENTIFY the repo, every path in the plan is evidence - a step saying
 * "edit `scripts/units/units.gd`" is the strongest signal there is, even though
 * a step is not a reference section.
 *
 * To REPORT a finding, only the reference sections count, because a step
 * legitimately names files that do not exist yet.
 */
export function claimsOf(text, {all = false} = {}) {
    const out = []
    const scope = all ? sections(text) : referenceSections(text)
    for (const [name, body] of Object.entries(scope)) {
        for (const tok of tokensIn(body))
            if (isFileClaim(tok)) out.push({section: name, token: tok})
    }
    return out
}

/**
 * Score on EXACT resolution only. A basename match is what makes every repo
 * look equally plausible - `package.json` and `index.html` resolve everywhere -
 * so counting them turns binding into a coin flip. A path with its directory
 * (`src/task/critique-probes.ts`) is what actually identifies a repo.
 */
export function scoreRepo(claims, repo) {
    const index = makeIndex(repo)
    let hit = 0
    // `exact` and `suffix` both carry a directory, so both identify a repo.
    // `basename` and `disk` do not and are deliberately not counted.
    for (const c of claims) {
        const how = resolveClaim(index, c.token)
        if (how === 'exact' || how === 'suffix') hit++
    }
    return {repo, hit, total: claims.length}
}

/**
 * Pick the repo a plan is about from a candidate list. Returns null when no
 * candidate resolves anything, or when the top two tie - an ambiguous binding
 * is the case that produced the 33 fake findings, so it must not be resolved
 * by picking one.
 */
export function bindRepo(text, candidates) {
    const claims = claimsOf(text, {all: true})
    if (claims.length === 0) return {repo: null, reason: 'plan makes no file claims', scores: []}
    const scores = candidates
        .filter(r => existsSync(r))
        .map(r => scoreRepo(claims, r))
        .sort((a, b) => b.hit - a.hit)
    if (scores.length === 0 || scores[0].hit === 0) {
        return {repo: null, reason: 'no candidate repo resolves any claim', scores}
    }
    if (scores.length > 1 && scores[1].hit === scores[0].hit) {
        return {
            repo: null,
            reason: `ambiguous: ${scores[0].repo} and ${scores[1].repo} tie at ${scores[0].hit}`,
            scores
        }
    }
    return {
        repo: scores[0].repo,
        reason: `${scores[0].hit}/${scores[0].total} claims resolve`,
        scores
    }
}

/** Every immediate subdirectory of `roots` that is a git tree. */
export function candidateRepos(roots) {
    const out = []
    for (const root of roots) {
        if (!existsSync(root)) continue
        if (existsSync(join(root, '.git'))) out.push(root)
        for (const d of readdirSync(root, {withFileTypes: true})) {
            if (!d.isDirectory()) continue
            const p = join(root, d.name)
            if (existsSync(join(p, '.git'))) out.push(p)
        }
    }
    return out
}

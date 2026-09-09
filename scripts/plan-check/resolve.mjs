// Does a claimed path exist in this repo?
//
// Three chances, weakest last. A bare basename ("db.ts") is a real file
// the plan named without its directory, so a basename index is the
// difference between a finding and noise - it accounted for 117 of 622
// candidates in one corpus.

import {existsSync} from 'node:fs'
import {execFileSync} from 'node:child_process'
import {join, basename} from 'node:path'

export function makeIndex(repo) {
    let tracked = []
    try {
        tracked = execFileSync('git', ['-C', repo, 'ls-files'], {encoding: 'utf8'})
            .split('\n')
            .filter(Boolean)
    } catch {
        // Not a git tree. The disk check below still runs; the basename
        // index is simply empty, so this guard only loses findings.
    }
    const exact = new Set(tracked)
    const byBase = new Map()
    for (const p of tracked) {
        const b = basename(p)
        if (!byBase.has(b)) byBase.set(b, [])
        byBase.get(b).push(p)
    }
    return {repo, exact, byBase, tracked}
}

/**
 * A path written relative to a source root: `task/loop-detector.ts` for
 * `src/task/loop-detector.ts`. Plans do this constantly, and treating it as
 * unresolved was most of what smoke 3 was reporting.
 *
 * The match must fall on a segment boundary, so `x/ab.ts` never matches
 * `src/xyz/ab.ts`. Two or more segments only - a bare basename is the weaker
 * `basename` tier below, and admitting it here would make every repo match.
 */
function suffixHit(index, token) {
    if (!token.includes('/')) return false
    const needle = `/${token}`
    return index.tracked.some(p => p.endsWith(needle))
}

export function resolveClaim(index, token) {
    if (index.exact.has(token)) return 'exact'
    if (existsSync(join(index.repo, token))) return 'disk'
    if (suffixHit(index, token)) return 'suffix'
    if (index.byBase.has(basename(token))) return 'basename'
    return null
}

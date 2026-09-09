// FIX 3 - a step's claim must be backed by the line it names.
//
// The control-flow defects (a 0.25s animation against a 0.12s cooldown, a guard
// on a function's first line) are invisible to any text scanner. The only lever
// is to force the read, so a step cites `path:line` plus the text it relies on,
// and the check is a substring test against that file at that line.
//
// A plan with no citations produces no findings. This reports on what a plan
// claims, it does not demand that a plan make claims.

import {readFileSync, existsSync} from 'node:fs'
import {join} from 'node:path'

// `path:line` immediately followed by a backticked or quoted excerpt.
const CITATION = /`?([\w./-]+\.\w{1,5}):(\d+)`?\s*[-–—:]?\s*(?:`([^`\n]+)`|"([^"\n]+)")/g

export function findCitations(text) {
    return [...text.matchAll(CITATION)].map(m => ({
        path: m[1],
        line: Number(m[2]),
        quote: (m[3] ?? m[4]).trim()
    }))
}

/**
 * The quoted text is the claim; the line number is a hint that decays as the
 * file moves. So the whole file is searched and the drift is REPORTED, never
 * compared against a window - a tolerance in lines would be a number nobody
 * measured, and the file this suite first cited moved 52 lines mid-session.
 *
 * A quote found nowhere is the finding. A quote found elsewhere passes and says
 * where, which is the correction the reader needs.
 */
export function checkCitation(repo, c) {
    const abs = join(repo, c.path)
    if (!existsSync(abs)) return {...c, ok: false, why: 'file does not exist'}
    const lines = readFileSync(abs, 'utf8').split('\n')
    if ((lines[c.line - 1] ?? '').includes(c.quote)) return {...c, ok: true, why: 'exact'}
    const at = lines.findIndex(l => l.includes(c.quote))
    if (at < 0)
        return {...c, ok: false, why: `quoted text is nowhere in the file (${lines.length} lines)`}
    return {...c, ok: true, why: `moved to line ${at + 1}, cited as ${c.line}`}
}

export function checkCitations(text, repo) {
    return findCitations(text).map(c => checkCitation(repo, c))
}

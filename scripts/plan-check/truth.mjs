// Ground truth for repo binding, recovered from the session transcripts.
//
// A plan file in ~/.claude/plans records no repo. The transcript that wrote it
// does: Claude Code stores sessions under a directory named for the session's
// cwd, so the directory holding a transcript that mentions a plan IS that plan's
// repo. Nothing here infers - it reads what actually happened.

import {readdirSync, existsSync, readFileSync} from 'node:fs'
import {join} from 'node:path'
import {execFileSync} from 'node:child_process'

const PROJECTS = '/home/edgars/.claude/projects'

/** `-home-edgars-hub-gofer` -> `/home/edgars/hub/gofer`. A dot in the real path
 *  encodes as an extra dash, so candidates are tried longest-prefix first. */
export function decodeProjectDir(name, candidates) {
    const norm = p => p.replace(/[/.]/g, '-')
    return candidates.find(c => norm(c) === name) ?? null
}

export function buildTruth(candidates) {
    const map = new Map()
    for (const d of readdirSync(PROJECTS)) {
        const repo = decodeProjectDir(d, candidates)
        if (!repo) continue
        let out = ''
        try {
            out = execFileSync(
                'bash',
                [
                    '-c',
                    `grep -rhoE '\\.claude/plans/[a-zA-Z0-9-]+\\.md' --include=*.jsonl ${JSON.stringify(join(PROJECTS, d))} 2>/dev/null | sed 's|.*/||' | sort -u`
                ],
                {encoding: 'utf8', maxBuffer: 64 * 1024 * 1024}
            )
        } catch {
            continue
        }
        for (const plan of out.split('\n').filter(Boolean)) {
            // A plan mentioned from two repos has no single truth; drop it
            // rather than pick, the same refusal the binder makes.
            if (map.has(plan) && map.get(plan) !== repo) map.set(plan, null)
            else if (!map.has(plan)) map.set(plan, repo)
        }
    }
    return map
}

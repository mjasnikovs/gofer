import {readFile} from 'node:fs/promises'
import {spawnSync} from 'node:child_process'

const tracked = spawnSync('git', ['ls-files', '-z'], {encoding: 'utf8'})
if (tracked.status !== 0) throw new Error(tracked.stderr || 'Could not list tracked files')

const ignoredPattern = /(?:\b(?:describe|it|test)\.(?:skip|todo)\b|#\s*\[ignore\])/u
const issuePattern = /https:\/\/[^\s)]+\/issues\/\d+/u
const datePattern = /\b(\d{4}-\d{2}-\d{2})\b/u
const failures = []

for (const path of tracked.stdout.split('\0').filter(Boolean)) {
    if (!/\.(?:mjs|js|ts|tsx|rs)$/u.test(path)) continue
    const lines = (await readFile(path, 'utf8')).split('\n')
    for (const [index, line] of lines.entries()) {
        if (!ignoredPattern.test(line)) continue
        const expiry = line.match(datePattern)?.[1]
        if (!issuePattern.test(line) || !expiry || expiry < new Date().toISOString().slice(0, 10)) {
            failures.push(
                `${path}:${String(index + 1)} ignored tests need an issue URL and future ISO expiry date`
            )
        }
    }
}

if (failures.length > 0) throw new Error(failures.join('\n'))

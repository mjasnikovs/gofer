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

// A node --test lane names its files by hand, so a new .test.mjs that nobody lists runs nowhere and
// says nothing. Untracked files count: the gap should close when the file is written, not when it is
// committed. Vitest and Playwright find their own by glob and need no listing.
const listed = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    encoding: 'utf8'
})
if (listed.status !== 0) throw new Error(listed.stderr || 'Could not list files')

const scripts = JSON.parse(await readFile('package.json', 'utf8')).scripts
const named = new Set(
    Object.values(scripts).flatMap(line => line.match(/[\w./-]+\.test\.mjs/gu) ?? [])
)

for (const path of listed.stdout.split('\0').filter(one => one.endsWith('.test.mjs'))) {
    if (named.has(path)) continue
    failures.push(`${path} is named by no package.json script, so nothing ever runs it`)
}

for (const path of named) {
    if (!listed.stdout.split('\0').includes(path)) {
        failures.push(`${path} is named by a package.json script but does not exist`)
    }
}

if (failures.length > 0) throw new Error(failures.join('\n'))

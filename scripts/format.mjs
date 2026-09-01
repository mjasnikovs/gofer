import {spawnSync} from 'node:child_process'
import {resolve} from 'node:path'

// Prettier's own walk descends into src-tauri/target before rejecting it, which is fifteen seconds
// of a hundred-gigabyte directory on every run. Git already knows the set the gate cares about.
const listed = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
})
if (listed.status !== 0) throw new Error(listed.stderr || 'Could not list the files to format')

const files = listed.stdout.split('\0').filter(Boolean)
const mode = process.argv[2] === 'write' ? '--write' : '--check'
const prettier = resolve('node_modules/.bin/prettier')

// One argv cannot hold the whole repository on every platform, so hand it over in batches.
const BATCH = 200
let failed = false
for (let start = 0; start < files.length; start += BATCH) {
    const batch = files.slice(start, start + BATCH)
    const result = spawnSync(
        prettier,
        [mode, '--cache', '--ignore-unknown', '--log-level', 'warn', ...batch],
        {stdio: 'inherit', shell: process.platform === 'win32'}
    )
    if (result.error) throw result.error
    if (result.status !== 0) failed = true
}
process.exitCode = failed ? 1 : 0

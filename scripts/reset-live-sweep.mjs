import {execFileSync} from 'node:child_process'
import {existsSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

const dataRoot = join(tmpdir(), 'gofer-live-run')
const workspace = process.env.GOFER_LIVE_WORKSPACE ?? join(tmpdir(), 'gofer-live-workspace')

rmSync(dataRoot, {recursive: true, force: true})
console.log(`removed ${dataRoot}`)

if (!existsSync(join(workspace, '.git'))) {
    console.log(`no git workspace at ${workspace}; nothing else to clean`)
    process.exit(0)
}

const git = (...arguments_) =>
    execFileSync('git', ['-C', workspace, ...arguments_], {encoding: 'utf8'})

git('worktree', 'prune')

const named = pattern =>
    git('branch', '--format=%(refname:short)')
        .split('\n')
        .map(line => line.trim())
        .filter(name => name !== '' && pattern(name))

const branches = named(name => name.startsWith('gofer/task'))

const current = git('branch', '--show-current').trim()
if (branches.includes(current)) {
    const base = named(name => !name.startsWith('gofer/task'))[0]
    if (base === undefined) {
        console.log(`${workspace}: only task branches exist; leaving ${current} checked out`)
        process.exit(0)
    }
    git('checkout', '--force', base)
    console.log(`checked out ${base}`)
}

for (const branch of branches) {
    git('branch', '-D', branch)
    console.log(`deleted ${branch}`)
}

console.log(`${workspace}: deleted ${String(branches.length)} task branches`)

import {execFileSync} from 'node:child_process'
import {existsSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

/*
 * Puts the machine back where a live sweep found it.
 *
 * A sweep leaves two things behind: its redirected application data, and the branches it made for
 * the tasks it ran — one of which is still checked out. None of them are cleaned up
 * by the run itself, on purpose — a failed sweep is worth opening afterwards. But a second sweep
 * started on top of the first reopens the first one's projects and tasks, and then reports on
 * those instead. This is the command to run in between, and it is a command rather than a
 * paragraph in the README because a paragraph is not something anybody runs.
 */

const dataRoot = join(tmpdir(), 'gofer-live-run')
// The same default `liveWorkspacePath()` uses, so the reset cleans the workspace a sweep made.
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

// Only the branches a sweep made. Anything else in the workspace is the user's.
const branches = named(name => name.startsWith('gofer/task'))

// A task is a branch now, and the sweep leaves the last one checked out. Git refuses to delete the
// branch HEAD points at, so the workspace is put back on its own before anything is deleted.
const current = git('branch', '--show-current').trim()
if (branches.includes(current)) {
    const base = named(name => !name.startsWith('gofer/task'))[0]
    if (base === undefined) {
        console.log(`${workspace}: only task branches exist; leaving ${current} checked out`)
        process.exit(0)
    }
    // Whatever the sweep left uncommitted goes with the branches it is about to delete.
    git('checkout', '--force', base)
    console.log(`checked out ${base}`)
}

for (const branch of branches) {
    git('branch', '-D', branch)
    console.log(`deleted ${branch}`)
}

console.log(`${workspace}: deleted ${String(branches.length)} task branches`)

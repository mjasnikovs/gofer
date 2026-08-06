import {spawnSync} from 'node:child_process'
import {cpSync, existsSync, mkdirSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'

/**
 * The Godot project the live sweep drives.
 *
 * The sweep asserts against a specific scene tree, a specific script and the output that script
 * prints, so the project cannot be any project on the machine — it used to be a hand-made
 * `~/hub/mario-test` that every developer had to build for themselves, and a sweep whose workspace
 * is undocumented is a sweep nobody else can run. The default is seeded from `fixtures/live-project`
 * instead. `GOFER_LIVE_WORKSPACE` still points it at a project of your own, which is the only way to
 * sweep against a game that actually exists.
 */
export function liveWorkspacePath() {
    return process.env.GOFER_LIVE_WORKSPACE ?? join(tmpdir(), 'gofer-live-workspace')
}

/**
 * Git inherits the environment of whatever ran the sweep — a Git hook exports `GIT_DIR` and
 * `GIT_INDEX_FILE` — so the fixture repository is addressed the same scrubbed way `git.rs`
 * addresses the real ones. Without it, `add` writes these fixture files into Gofer's own index while
 * their objects stay here, leaving that repository referencing objects it cannot find.
 */
const GIT_ENVIRONMENT = new Set([
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_COMMON_DIR',
    'GIT_PREFIX'
])

function git(workspace: string, ...arguments_: string[]) {
    const environment = Object.fromEntries(
        Object.entries(process.env).filter(([name]) => !GIT_ENVIRONMENT.has(name))
    )
    const result = spawnSync('git', ['-C', workspace, ...arguments_], {
        encoding: 'utf8',
        env: environment
    })
    if (result.status !== 0) {
        throw new Error(`git ${arguments_.join(' ')} failed: ${result.stderr || result.stdout}`)
    }
}

/**
 * Makes sure the sweep has a Godot project with a commit in it, and answers with its path.
 *
 * A task only gets an isolated worktree inside a repository that has a commit, so the fixture is
 * committed rather than merely copied. An existing project is left exactly as it is: the workspace
 * survives between runs on purpose — `.godot` is Godot's own import cache, and re-seeding would
 * spend a full import scan proving nothing.
 */
export function seedLiveWorkspace() {
    const workspace = liveWorkspacePath()
    if (existsSync(join(workspace, 'project.godot'))) return workspace
    if (process.env.GOFER_LIVE_WORKSPACE) {
        throw new Error(`GOFER_LIVE_WORKSPACE=${workspace} is not a Godot project`)
    }
    mkdirSync(workspace, {recursive: true})
    cpSync(resolve('fixtures/live-project'), workspace, {recursive: true})
    git(workspace, 'init', '--quiet', '--initial-branch', 'master')
    git(workspace, 'config', 'user.email', 'live@gofer.test')
    git(workspace, 'config', 'user.name', 'Gofer live sweep')
    git(workspace, 'add', '--all')
    git(workspace, 'commit', '--quiet', '--message', 'Gofer live sweep fixture project')
    return workspace
}

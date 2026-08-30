import {spawnSync} from 'node:child_process'
import {cpSync, existsSync, mkdirSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'

export function liveWorkspacePath() {
    return process.env.GOFER_LIVE_WORKSPACE ?? join(tmpdir(), 'gofer-live-workspace')
}

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

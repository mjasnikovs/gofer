import {execFileSync} from 'node:child_process'
import {copyFileSync, existsSync, mkdirSync, rmSync} from 'node:fs'
import {homedir, tmpdir} from 'node:os'
import {join} from 'node:path'
import {liveWorkspacePath, seedLiveWorkspace} from './e2e/live/workspace-fixture'

const executable =
    process.platform === 'win32' ?
        'src-tauri/target/release/gofer.exe'
    :   'src-tauri/target/release/gofer'

const workspace = liveWorkspacePath()
const dataRoot = join(tmpdir(), 'gofer-live-run')
const appDataDir = join(dataRoot, 'data')
mkdirSync(appDataDir, {recursive: true})

process.env.GOFER_WORKSPACE_DIR = workspace
process.env.GOFER_APP_DATA_DIR = appDataDir
process.env.GOFER_GODOT_BINARY = process.env.GOFER_GODOT_BINARY ?? 'godot'
process.env.GOFER_RAG_CACHE_DIR = join(homedir(), '.cache/gofer-rag')
process.env.GOFER_WEBDRIVER_SKIP_CREDENTIAL_STORE = '1'
delete process.env.GOFER_WEBDRIVER_RAG_READY
delete process.env.GOFER_AI_WORKER
delete process.env.GOFER_GODOT_HEADLESS

const specs = ['./e2e/live/workspace.spec.ts']

export const config: WebdriverIO.Config = {
    runner: 'local',
    specs,
    maxInstances: 1,
    services: [
        [
            '@wdio/tauri-service',
            {
                appBinaryPath: executable,
                driverProvider: 'embedded',
                embeddedPort: 4447,
                captureBackendLogs: true,
                captureFrontendLogs: true
            }
        ]
    ],
    capabilities: [{browserName: 'tauri', 'tauri:options': {application: executable}}],
    logLevel: 'error',
    bail: 0,
    waitforTimeout: 10_000,
    connectionRetryTimeout: 1_860_000,
    connectionRetryCount: 0,
    framework: 'mocha',
    reporters: ['spec'],
    specFileRetries: 0,
    mochaOpts: {ui: 'bdd', timeout: 3_600_000},
    onPrepare: () => {
        seedLiveWorkspace()
        stopAStaleApplication()
        rmSync(dataRoot, {recursive: true, force: true})
        mkdirSync(appDataDir, {recursive: true})
        restoreWorkspace()
        const userSettings = join(homedir(), '.config/com.gofer.desktop/settings.json')
        const settings = join(appDataDir, 'settings.json')
        if (!existsSync(settings) && existsSync(userSettings)) copyFileSync(userSettings, settings)
        seedCommit = git('rev-parse', 'HEAD')
        baseBranch = git('branch', '--show-current')
    },
    onComplete: () => {
        restoreWorkspace()
    }
}

let seedCommit = ''

let baseBranch = ''

function stopAStaleApplication() {
    for (let attempt = 0; attempt < 20; attempt++) {
        const running = (() => {
            try {
                return execFileSync('pgrep', ['-f', executable], {encoding: 'utf8'}).trim()
            } catch {
                return ''
            }
        })()
        if (running === '') return
        if (attempt === 0)
            console.log(`stopping a ${executable} a previous sweep left running: ${running}`)
        for (const pid of running.split('\n')) {
            try {
                process.kill(Number(pid), attempt < 5 ? 'SIGTERM' : 'SIGKILL')
            } catch {}
        }
        execFileSync('sleep', ['0.5'])
    }
    throw new Error(`${executable} is still running and this sweep cannot drive a second one`)
}

function git(...arguments_: string[]) {
    return execFileSync('git', ['-C', workspace, ...arguments_], {encoding: 'utf8'}).trim()
}

function restoreWorkspace() {
    for (const line of git('worktree', 'list').split('\n')) {
        const root = line.split(' ')[0] ?? ''
        if (root === '' || root === workspace) continue
        try {
            git('worktree', 'remove', '--force', root)
        } catch {}
    }
    git('worktree', 'prune')
    if (seedCommit !== '') git('checkout', '--force', seedCommit)
    for (const line of git('branch', '--list', 'gofer/task-*').split('\n')) {
        const name = line.replace(/^[*+]/u, '').trim()
        if (name !== '') git('branch', '-D', name)
    }
    if (baseBranch !== '') git('checkout', '--force', baseBranch)
    if (seedCommit !== '') git('reset', '--hard', seedCommit)
    git('clean', '-fd')
}

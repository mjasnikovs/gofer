import type {Options} from '@wdio/types'
import {execFileSync} from 'node:child_process'
import {copyFileSync, existsSync, mkdirSync, rmSync} from 'node:fs'
import {homedir, tmpdir} from 'node:os'
import {join} from 'node:path'
import {liveWorkspacePath, seedLiveWorkspace} from './e2e/live/workspace-fixture'

/**
 * Drives the shipped application against a real Godot project on this machine.
 *
 * Unlike `wdio.packaged.conf.ts` this configuration stubs nothing that a user would have: the AI
 * worker is the real one talking to the configured endpoint, the retrieval models are the ones
 * already in the user's cache, and the editor is a real windowed Godot. Only the application data
 * directory is redirected, so a live sweep cannot damage the user's own projects.
 */
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
// The user's own retrieval cache: downloading 1.68 GiB again would prove nothing.
process.env.GOFER_RAG_CACHE_DIR = join(homedir(), '.cache/gofer-rag')
// A local llama.cpp endpoint needs no credential, and the sweep must not block on a keyring prompt.
process.env.GOFER_WEBDRIVER_SKIP_CREDENTIAL_STORE = '1'
delete process.env.GOFER_WEBDRIVER_RAG_READY
delete process.env.GOFER_AI_WORKER
delete process.env.GOFER_GODOT_HEADLESS

/**
 * One spec file, because there is one application.
 *
 * The service keeps a single embedded driver on a fixed port, so a second spec file attaches to the
 * application the first one left running rather than starting a fresh one — every scenario
 * therefore lives in the ordered sweep.
 */
const specs = ['./e2e/live/workspace.spec.ts']

export const config: Options.Testrunner = {
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
    /**
     * How long one WebDriver command may take.
     *
     * Every wait in this sweep blocks inside the page, so this is the ceiling on all of them: the
     * default three minutes turned an agent turn that was still authoring a scene into "the
     * operation was aborted due to timeout", which says nothing about the application.
     */
    connectionRetryTimeout: 1_860_000,
    connectionRetryCount: 0,
    framework: 'mocha',
    reporters: ['spec'],
    specFileRetries: 0,
    /**
     * The outer bound on one scenario, not a schedule.
     *
     * A step that asks the agent to build part of a level waits for as many turns as it takes, and
     * the harness ends a turn that has stopped working within seconds — so this only has to be
     * longer than the slowest honest scenario rather than tuned to it.
     */
    mochaOpts: {ui: 'bdd', timeout: 3_600_000},
    onPrepare: () => {
        seedLiveWorkspace()
        stopAStaleApplication()
        // A run starts from nothing: the tasks, chats and worktrees of an earlier one would change
        // what this one is asked to build, and a sweep whose first run differs from its second is
        // not a regression test.
        rmSync(dataRoot, {recursive: true, force: true})
        mkdirSync(appDataDir, {recursive: true})
        restoreWorkspace()
        const userSettings = join(homedir(), '.config/com.gofer.desktop/settings.json')
        const settings = join(appDataDir, 'settings.json')
        // The sweep talks to whatever model the user configured, so it starts from their settings.
        if (!existsSync(settings) && existsSync(userSettings)) copyFileSync(userSettings, settings)
        seedCommit = git('rev-parse', 'HEAD')
    },
    /**
     * Puts the project back the way the sweep found it.
     *
     * This runs after the application has exited, which is the first moment its worktrees can be
     * taken away from it. The sweep merges a task, so without this the project would gain a commit
     * per run — and the next run would be asked to build a level that is already there.
     */
    onComplete: () => {
        restoreWorkspace()
    }
}

/** The commit the project was on before the sweep, read once the runner has checked the path. */
let seedCommit = ''

/**
 * Clears an application a previous sweep left running.
 *
 * The embedded driver listens on one fixed port, so a leftover window answers this run instead of
 * the one it is about to start — and the data directory wiped below is that window's, which then
 * fails every step with a database it can no longer open. The binary named here is the test build
 * this configuration drives, never an installed Gofer, so the only thing this can end is debris
 * from a sweep that did not shut down.
 */
function stopAStaleApplication() {
    for (let attempt = 0; attempt < 20; attempt++) {
        // `pgrep` exits non-zero when it matches nothing, which is the ordinary case.
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
            } catch {
                // It exited between the listing and the signal, which is the outcome wanted.
            }
        }
        execFileSync('sleep', ['0.5'])
    }
    throw new Error(`${executable} is still running and this sweep cannot drive a second one`)
}

function git(...arguments_: string[]) {
    return execFileSync('git', ['-C', workspace, ...arguments_], {encoding: 'utf8'}).trim()
}

/**
 * Puts the project back to the commit the sweep started from, with none of its task checkouts left.
 *
 * The order matters: a branch Git still believes is checked out somewhere cannot be deleted, so the
 * worktrees go first — including the registrations whose directories are already gone.
 */
function restoreWorkspace() {
    for (const line of git('worktree', 'list').split('\n')) {
        const root = line.split(' ')[0] ?? ''
        if (root === '' || root === workspace) continue
        try {
            git('worktree', 'remove', '--force', root)
        } catch {
            // A directory that is already gone is removed by the prune below instead.
        }
    }
    git('worktree', 'prune')
    for (const line of git('branch', '--list', 'gofer/task-*').split('\n')) {
        const name = line.replace(/^[*+]/u, '').trim()
        if (name !== '') git('branch', '-D', name)
    }
    if (seedCommit !== '') git('reset', '--hard', seedCommit)
    // `.godot` is Godot's own import cache: regenerating it costs a scan the sweep does not need.
    git('clean', '-fd')
}

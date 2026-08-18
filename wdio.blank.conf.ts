import {execFileSync, spawnSync} from 'node:child_process'
import {copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync} from 'node:fs'
import {homedir, tmpdir} from 'node:os'
import {join, resolve} from 'node:path'

/**
 * One prompt, put to the shipped application against a Godot project with nothing in it.
 *
 * `wdio.live.conf.ts` drives a sweep of scenarios against a seeded project that already holds a
 * scene, a script and an atlas. This drives one message against a project that holds a name and a
 * commit, which is what a person starting a game actually has. The difference is the point: every
 * turn the model spends discovering that nothing exists is a turn this configuration is here to
 * make visible.
 *
 * Nothing is stubbed. The worktrees are deliberately left behind when the run ends, because reading
 * what the model built is the whole reason the run happened.
 */
const executable =
    process.platform === 'win32' ?
        'src-tauri/target/release/gofer.exe'
    :   'src-tauri/target/release/gofer'

/** The blank project, remade for every run. `GOFER_LIVE_WORKSPACE` names one of your own instead. */
const workspace = process.env.GOFER_LIVE_WORKSPACE ?? join(tmpdir(), 'gofer-blank-project')
const dataRoot = join(tmpdir(), 'gofer-live-run')
const appDataDir = join(dataRoot, 'data')

process.env.GOFER_WORKSPACE_DIR = workspace
process.env.GOFER_APP_DATA_DIR = appDataDir
process.env.GOFER_GODOT_BINARY = process.env.GOFER_GODOT_BINARY ?? 'godot'
// The user's own retrieval cache: downloading 1.68 GiB again would prove nothing.
process.env.GOFER_RAG_CACHE_DIR = join(homedir(), '.cache/gofer-rag')
// A local llama.cpp endpoint needs no credential, and the run must not block on a keyring prompt.
process.env.GOFER_WEBDRIVER_SKIP_CREDENTIAL_STORE = '1'
// The sidecar sits beside the *bundled* binary, which a `--no-bundle` build has no copy of, so
// every formatting step would quietly do nothing without this.
process.env.GOFER_GDFORMAT = process.env.GOFER_GDFORMAT ?? resolve('src-tauri/sidecar/gdformat')
delete process.env.GOFER_WEBDRIVER_RAG_READY
delete process.env.GOFER_AI_WORKER
delete process.env.GOFER_GODOT_HEADLESS

export const config: WebdriverIO.Config = {
    runner: 'local',
    specs: ['./e2e/live/blank-run.spec.ts'],
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
     * Every wait in this run blocks inside the page, so this is the ceiling on all of them — the
     * default three minutes would abort a turn that is still authoring a scene and report it as
     * "the operation was aborted due to timeout", which says nothing about the application.
     */
    connectionRetryTimeout: 3_600_000,
    connectionRetryCount: 0,
    framework: 'mocha',
    reporters: ['spec'],
    specFileRetries: 0,
    /**
     * The outer bound on the whole run, not a schedule.
     *
     * Longer than the spec's own limit on one turn, so that when a run is cut short the message
     * comes from the spec — which says what it was waiting for — rather than from Mocha, which
     * says only that the test took too long.
     */
    mochaOpts: {ui: 'bdd', timeout: 15_000_000},
    onPrepare: () => {
        stopAStaleApplication()
        stopAStaleEditor()
        // A run starts from nothing. The tasks, chats and settings of an earlier one would change
        // what this one is asked to build, and two runs that start differently cannot be compared.
        rmSync(dataRoot, {recursive: true, force: true})
        mkdirSync(appDataDir, {recursive: true})
        seedBlankProject()
        const userSettings = join(homedir(), '.config/com.gofer.desktop/settings.json')
        const settings = join(appDataDir, 'settings.json')
        // The run talks to whatever model the user configured, so it starts from their settings.
        if (existsSync(userSettings)) copyFileSync(userSettings, settings)
    }
}

/**
 * Git inherits the environment of whatever ran this — a Git hook exports `GIT_DIR` — so the blank
 * repository is addressed the same scrubbed way `git.rs` addresses the real ones. Without it, `add`
 * writes these files into Gofer's own index while their objects stay here.
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

function git(...arguments_: string[]) {
    const environment = Object.fromEntries(
        Object.entries(process.env).filter(([name]) => !GIT_ENVIRONMENT.has(name))
    )
    const result = spawnSync('git', ['-C', workspace, ...arguments_], {
        encoding: 'utf8',
        env: environment
    })
    if (result.status !== 0)
        throw new Error(`git ${arguments_.join(' ')} failed: ${result.stderr || result.stdout}`)
}

/**
 * Makes the blank project: a name, and one commit.
 *
 * The commit is not optional — a task only gets an isolated worktree inside a repository that has
 * one. Nothing else is seeded. No scene, no script, no art, no main scene setting: finding out that
 * none of that exists is part of what the model is being watched doing.
 *
 * A workspace named by `GOFER_LIVE_WORKSPACE` is left exactly as it is, because it is yours.
 */
function seedBlankProject() {
    if (process.env.GOFER_LIVE_WORKSPACE) {
        if (!existsSync(join(workspace, 'project.godot')))
            throw new Error(`GOFER_LIVE_WORKSPACE=${workspace} is not a Godot project`)
        return
    }
    rmSync(workspace, {recursive: true, force: true})
    mkdirSync(workspace, {recursive: true})
    writeFileSync(
        join(workspace, 'project.godot'),
        'config_version=5\n\n[application]\n\nconfig/name="Blank"\n'
            + 'config/features=PackedStringArray("4.7")\n'
    )
    git('init', '--quiet', '--initial-branch', 'master')
    git('config', 'user.email', 'live@gofer.test')
    git('config', 'user.name', 'Gofer blank run')
    git('add', '--all')
    git('commit', '--quiet', '--message', 'A Godot project with nothing in it')
}

/**
 * Clears a managed editor a previous run left behind.
 *
 * Gofer is killed by the service at the end of a run rather than asked to shut down, and the first
 * run left its editor running afterwards — bound to a worktree, holding a language server and a
 * debug adapter port, and outliving the application that started it. The next run's editor would
 * then be the second one on this machine. Only editors pointed at this run's own data directory are
 * ended, so a developer's own Godot is never touched.
 */
function stopAStaleEditor() {
    try {
        execFileSync('pkill', ['-f', `^godot --editor --path ${dataRoot}`])
        console.log('stopping a managed editor a previous run left running')
    } catch {
        // `pkill` exits non-zero when it matches nothing, which is the ordinary case.
    }
}

/**
 * Clears an application a previous run left behind.
 *
 * The embedded driver listens on one fixed port, so a leftover window answers this run instead of
 * the one it is about to start — and the data directory wiped above is that window's, which then
 * fails every step with a database it can no longer open. The binary named here is the test build
 * this configuration drives, never an installed Gofer.
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
            console.log(`stopping a ${executable} a previous run left running: ${running}`)
        for (const pid of running.split('\n')) {
            try {
                process.kill(Number(pid), attempt < 5 ? 'SIGTERM' : 'SIGKILL')
            } catch {
                // It exited between the listing and the signal, which is the outcome wanted.
            }
        }
        execFileSync('sleep', ['0.5'])
    }
    throw new Error(`${executable} is still running and this run cannot drive a second one`)
}

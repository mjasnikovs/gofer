import {execFileSync, spawnSync} from 'node:child_process'
import {copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {homedir, tmpdir} from 'node:os'
import {join, resolve} from 'node:path'

const executable =
    process.platform === 'win32' ?
        'src-tauri/target/release/gofer.exe'
    :   'src-tauri/target/release/gofer'

const workspace = process.env.GOFER_LIVE_WORKSPACE ?? join(tmpdir(), 'gofer-blank-project')
const dataRoot = join(tmpdir(), 'gofer-live-run')
const appDataDir = join(dataRoot, 'data')

process.env.GOFER_WORKSPACE_DIR = workspace
process.env.GOFER_APP_DATA_DIR = appDataDir
process.env.GOFER_GODOT_BINARY = process.env.GOFER_GODOT_BINARY ?? 'godot'
process.env.GOFER_RAG_CACHE_DIR = join(homedir(), '.cache/gofer-rag')
process.env.GOFER_WEBDRIVER_SKIP_CREDENTIAL_STORE = '1'
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
    connectionRetryTimeout: 3_600_000,
    connectionRetryCount: 0,
    framework: 'mocha',
    reporters: ['spec'],
    specFileRetries: 0,
    mochaOpts: {ui: 'bdd', timeout: 15_000_000},
    onPrepare: () => {
        stopAStaleApplication()
        stopAStaleEditor()
        rmSync(dataRoot, {recursive: true, force: true})
        mkdirSync(appDataDir, {recursive: true})
        seedBlankProject()
        const userSettings = join(homedir(), '.config/com.gofer.desktop/settings.json')
        const settings = join(appDataDir, 'settings.json')
        if (existsSync(userSettings)) copyFileSync(userSettings, settings)
        forceTheLocalModel(settings)
    }
}

function forceTheLocalModel(settings: string) {
    if (!existsSync(settings)) throw new Error(`${settings} was never written`)
    const stored = JSON.parse(readFileSync(settings, 'utf8')) as {
        ai?: Record<string, unknown> & {local?: Record<string, unknown>}
    }
    const local = stored.ai?.local
    if (!stored.ai || !local)
        throw new Error(
            'no `ai.local` profile in the copied settings; configure the local endpoint in Gofer '
                + 'once, or this run would talk to a hosted model'
        )
    const subagent = (stored.ai['subagent'] ?? {}) as Record<string, unknown>
    const connection = {
        ...local,
        connectionType: 'openai-compatible',
        model: servedModel(String(local['baseUrl']), asText(local['model']))
    }
    stored.ai = {
        ...stored.ai,
        ...connection,
        modelName: connection.model,
        subagent: {...subagent, connection: {...connection, modelName: connection.model}}
    }
    writeFileSync(settings, JSON.stringify(stored, undefined, 2))
    console.log(
        `the run and its sub-agents talk to ${String(local['baseUrl'])} for ${connection.model}`
    )
}

function asText(value: unknown): string {
    return typeof value === 'string' ? value : ''
}

function servedModel(baseUrl: string, stored: string): string {
    const answer = spawnSync('curl', ['--silent', '--max-time', '30', `${baseUrl}/models`], {
        encoding: 'utf8'
    })
    if (answer.status !== 0)
        throw new Error(`${baseUrl} did not answer; no run is possible: ${answer.stderr}`)
    const served = (JSON.parse(answer.stdout) as {data?: {id?: string}[]}).data ?? []
    const ids = served.map(entry => entry.id).filter(entry => entry !== undefined)
    const first = ids[0]
    if (first === undefined) throw new Error(`${baseUrl} is serving no model`)
    if (ids.includes(stored)) return stored
    console.log(`the settings name ${stored}; ${baseUrl} is serving ${first}`)
    return first
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

function stopAStaleEditor() {
    try {
        execFileSync('pkill', ['-f', `^godot --editor --path ${dataRoot}`])
        console.log('stopping a managed editor a previous run left running')
    } catch {}
}

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
            console.log(`stopping a ${executable} a previous run left running: ${running}`)
        for (const pid of running.split('\n')) {
            try {
                process.kill(Number(pid), attempt < 5 ? 'SIGTERM' : 'SIGKILL')
            } catch {}
        }
        execFileSync('sleep', ['0.5'])
    }
    throw new Error(`${executable} is still running and this run cannot drive a second one`)
}

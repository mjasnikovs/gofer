import {execFileSync} from 'node:child_process'
import {cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {homedir, tmpdir} from 'node:os'
import {join} from 'node:path'

const executable =
    process.platform === 'win32' ?
        'src-tauri/target/release/gofer.exe'
    :   'src-tauri/target/release/gofer'

const source = process.env['GOFER_BRIEF_PROJECT'] ?? join(homedir(), 'hub/stormheart')
const workspace =
    process.env['GOFER_BRIEF_IN_PLACE'] === '1' ? source : join(tmpdir(), 'gofer-brief-project')
const dataRoot = join(tmpdir(), 'gofer-brief-run')
const appDataDir = join(dataRoot, 'data')

const MODEL = {
    connectionType: 'openai-codex',
    name: 'ChatGPT subscription',
    baseUrl: 'https://chatgpt.com/backend-api',
    api: 'openai-codex-responses',
    model: 'gpt-5.6-luna',
    modelName: 'GPT-5.6 Luna',
    contextWindow: 272_000,
    maxTokens: 128_000,
    reasoning: true,
    supportsReasoningEffort: true,
    thinkingLevels: [],
    input: ['text', 'image'],
    thinkingLevel: 'medium'
}

process.env.GOFER_WORKSPACE_DIR = workspace
process.env.GOFER_APP_DATA_DIR = appDataDir
process.env.GOFER_GODOT_BINARY = process.env.GOFER_GODOT_BINARY ?? 'godot'
process.env.GOFER_RAG_CACHE_DIR = join(homedir(), '.cache/gofer-rag')
delete process.env.GOFER_WEBDRIVER_RAG_READY
delete process.env.GOFER_AI_WORKER
delete process.env.GOFER_GODOT_HEADLESS

const specs = ['./e2e/live/brief.spec.ts']

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
                embeddedPort: 4448,
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
        stopAStaleApplication()
        stageWorkers()
        prepareWorkspace()
        rmSync(dataRoot, {recursive: true, force: true})
        mkdirSync(appDataDir, {recursive: true})
        writeSettings()
    }
}

function stageWorkers() {
    const built = join('src-tauri', 'workers')
    const staged = join('src-tauri', 'target', 'release', 'workers')
    if (!existsSync(built) || !existsSync(staged)) return
    cpSync(built, staged, {recursive: true})
    console.log('staged the current workers beside the binary')
}

function prepareWorkspace() {
    if (process.env['GOFER_BRIEF_IN_PLACE'] === '1') {
        console.log(`sweeping ${workspace} IN PLACE — this creates branches in the real project`)
        return
    }
    if (!existsSync(source)) throw new Error(`no project at ${source}`)
    rmSync(workspace, {recursive: true, force: true})
    const skipped = new Set(['.godot', '.import', 'release', 'artifacts', 'node_modules'])
    cpSync(source, workspace, {
        recursive: true,
        filter: path => !skipped.has(path.slice(source.length + 1).split('/')[0] ?? '')
    })
    git('reset', '--hard')
    git('clean', '-fd')
    console.log(`sweeping a copy of ${source} at ${workspace}`)
}

function writeSettings() {
    const userSettings = join(homedir(), '.config/com.gofer.desktop/settings.json')
    const base: Record<string, unknown> =
        existsSync(userSettings) ?
            (JSON.parse(readFileSync(userSettings, 'utf8')) as Record<string, unknown>)
        :   {version: 1, ai: {}}
    const ai = (base['ai'] ?? {}) as Record<string, unknown>
    const subagent = (ai['subagent'] ?? {}) as Record<string, unknown>
    base['ai'] = {
        ...ai,
        ...MODEL,
        chatgpt: {...MODEL},
        subagent: {...subagent, connection: {...MODEL}}
    }
    writeFileSync(join(appDataDir, 'settings.json'), JSON.stringify(base, null, 2))
}

function git(...arguments_: string[]) {
    execFileSync('git', ['-C', workspace, ...arguments_], {encoding: 'utf8'})
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
        if (attempt === 0) console.log(`stopping a stale ${executable}: ${running}`)
        execFileSync('pkill', ['-f', executable], {stdio: 'ignore'})
        execFileSync('sleep', ['0.5'])
    }
}

import {execFileSync} from 'node:child_process'
import {cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {homedir, tmpdir} from 'node:os'
import {join} from 'node:path'

/**
 * Drives a planned task end to end, against a real project and a real model.
 *
 * Separate from `wdio.live.conf.ts` because it is asking a different question. That sweep drives the
 * whole application through a scripted build and asserts what the editor holds afterwards. This one
 * has one subject — the four phases that run before a task's first turn — and its job is to break
 * them: an ask about files that do not exist, an ask that is not a task at all, a stop in the middle
 * of a run.
 *
 * It runs against a COPY of the project, and that is not caution for its own sake. A task is a
 * branch and a merge in the real repository, and this sweep deliberately feeds the agent nonsense.
 * `GOFER_BRIEF_PROJECT` points it somewhere else; `GOFER_BRIEF_IN_PLACE=1` uses that path directly
 * with no copy, which is the only way to sweep the actual project and is never the default.
 */
const executable =
    process.platform === 'win32' ?
        'src-tauri/target/release/gofer.exe'
    :   'src-tauri/target/release/gofer'

const source = process.env['GOFER_BRIEF_PROJECT'] ?? join(homedir(), 'hub/stormheart')
const workspace =
    process.env['GOFER_BRIEF_IN_PLACE'] === '1' ? source : join(tmpdir(), 'gofer-brief-project')
const dataRoot = join(tmpdir(), 'gofer-brief-run')
const appDataDir = join(dataRoot, 'data')

/**
 * The model every phase runs on.
 *
 * Named here rather than taken from the user's settings because the sweep is about what the phases
 * do, and a run on one model says nothing about a run on another. Medium effort is the point of
 * choosing a reasoning model at all: the phases are short and the thinking is where the difference
 * between a real answer and a plausible one shows up.
 */
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
    // A phase is a bounded delegation and four of them run in a row, so the ceiling on one command
    // has to outlast a whole brief rather than one model request.
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

/**
 * Puts the freshly bundled workers where the binary looks for them.
 *
 * `npm run build:workers` writes to `src-tauri/workers`, and the running application reads a COPY of
 * that directory staged beside the executable by `tauri build`. So a worker edited and rebuilt after
 * the last binary build is not the worker that runs, and nothing says so — the application quietly
 * behaves like the version it was built with. That cost this sweep two full runs against code that
 * had already been fixed.
 *
 * Copying rather than pointing `GOFER_AI_WORKER` at the source, because the resolution path the
 * application really uses is part of what a sweep against the shipped build is for.
 */
function stageWorkers() {
    const built = join('src-tauri', 'workers')
    const staged = join('src-tauri', 'target', 'release', 'workers')
    if (!existsSync(built) || !existsSync(staged)) return
    cpSync(built, staged, {recursive: true})
    console.log('staged the current workers beside the binary')
}

/**
 * Puts a project under the sweep, copied unless told otherwise.
 *
 * The copy leaves out the build output and the editor's own cache — several hundred megabytes that
 * Godot rebuilds on first open and that nothing here reads — but keeps `.git`, because a task is a
 * branch and Gofer refuses a workspace that is not a repository.
 */
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
    // A copy of a repository is still a repository, but its checkout may be mid-anything. The sweep
    // starts from a clean tree so that what a task changes is only what the task changed.
    git('reset', '--hard')
    git('clean', '-fd')
    console.log(`sweeping a copy of ${source} at ${workspace}`)
}

/**
 * The settings the application starts with: the user's, with every model pointed at one.
 *
 * Started from the user's file rather than written from nothing, because a settings file has more in
 * it than the model — the Godot rules, the sub-agent's ceilings, the compaction line — and a sweep
 * that invented those would be testing a configuration nobody runs.
 */
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
        // Every phase runs as a delegation, so this is the half that decides what the brief costs
        // and how well it answers. The parent is set to the same model so a basic task and a
        // planned one are the same comparison.
        subagent: {...subagent, connection: {...MODEL}}
    }
    writeFileSync(join(appDataDir, 'settings.json'), JSON.stringify(base, null, 2))
}

function git(...arguments_: string[]) {
    execFileSync('git', ['-C', workspace, ...arguments_], {encoding: 'utf8'})
}

/** Clears an application a previous sweep left running on the same fixed driver port. */
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

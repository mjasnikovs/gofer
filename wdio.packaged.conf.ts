import type {Options} from '@wdio/types'
import {cpSync, existsSync, mkdtempSync, mkdirSync, writeFileSync} from 'node:fs'
import {spawnSync} from 'node:child_process'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'

const executable =
    process.platform === 'win32' ?
        'src-tauri/target/release/gofer.exe'
    :   'src-tauri/target/release/gofer'
const fixtureRoot =
    process.env.GOFER_PACKAGED_FIXTURE_ROOT ?? mkdtempSync(join(tmpdir(), 'gofer-wdio-'))
const appDataDir = join(fixtureRoot, 'data')
const workspace = join(fixtureRoot, 'workspace')
process.env.GOFER_APP_DATA_DIR = appDataDir
process.env.GOFER_RAG_CACHE_DIR = join(fixtureRoot, 'cache')
process.env.GOFER_WEBDRIVER_RAG_READY = '1'
process.env.GOFER_WEBDRIVER_SKIP_CREDENTIAL_STORE = '1'
process.env.GOFER_AI_WORKER = resolve('fixtures/packaged/fake-ai-worker.mjs')
// The journey drives a real Godot editor session over protocol v2, so the application needs a
// workspace it can create a task worktree in, and an editor it can launch without a display.
process.env.GOFER_WORKSPACE_DIR = workspace
process.env.GOFER_GODOT_HEADLESS = '1'

/**
 * Git inherits the environment of whatever ran the journey — a Git hook exports `GIT_DIR` and
 * `GIT_INDEX_FILE` — so the fixture repository is addressed the same scrubbed way `git.rs`
 * addresses the real ones. Without it, `add` writes these fixture files into Gofer's own index
 * while their objects stay here, leaving that repository referencing objects it cannot find.
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
    if (result.status !== 0) {
        throw new Error(`git ${arguments_.join(' ')} failed: ${result.stderr || result.stdout}`)
    }
}

/**
 * Prepares the repository the packaged application manages.
 *
 * Gofer binds every editor session to the active task's isolated worktree, and a task only gets a
 * worktree inside a Git repository with a commit, so the fixture project is committed here rather
 * than merely copied.
 */
function prepareWorkspace() {
    if (!process.env.GOFER_GODOT_BINARY) {
        throw new Error('GOFER_GODOT_BINARY is required for the packaged journey')
    }
    // The restart journey runs a second application process against the same fixture root, and it
    // must find the repository the first one worked in rather than a fresh one.
    if (existsSync(join(workspace, '.git'))) return
    mkdirSync(workspace, {recursive: true})
    cpSync(resolve('fixtures/godot-project'), workspace, {recursive: true})
    git('init', '--quiet', '--initial-branch', 'main')
    git('config', 'user.email', 'packaged@gofer.test')
    git('config', 'user.name', 'Gofer packaged journey')
    git('add', '--all')
    git('commit', '--quiet', '--message', 'Godot fixture project')
}

export const config: Options.Testrunner = {
    runner: 'local',
    specs: ['./e2e/desktop/packaged.spec.ts'],
    maxInstances: 1,
    services: [
        [
            '@wdio/tauri-service',
            {
                appBinaryPath: executable,
                driverProvider: 'embedded',
                embeddedPort: 4445,
                captureBackendLogs: true,
                captureFrontendLogs: true
            }
        ]
    ],
    capabilities: [{browserName: 'tauri', 'tauri:options': {application: executable}}],
    logLevel: 'error',
    bail: 0,
    waitforTimeout: 15_000,
    connectionRetryTimeout: 60_000,
    connectionRetryCount: 0,
    framework: 'mocha',
    reporters: ['spec'],
    // A real editor session imports the project before the addon can answer, which is slower than
    // anything else in this suite.
    mochaOpts: {ui: 'bdd', timeout: 240_000},
    onPrepare: () => {
        prepareWorkspace()
        const modelBaseUrl = process.env.GOFER_PACKAGED_MODEL_BASE_URL
        if (!modelBaseUrl) throw new Error('GOFER_PACKAGED_MODEL_BASE_URL is required')
        mkdirSync(appDataDir, {recursive: true})
        const settingsPath = join(appDataDir, 'settings.json')
        if (!existsSync(settingsPath))
            writeFileSync(
                settingsPath,
                `${JSON.stringify(
                    {
                        version: 1,
                        ai: {
                            connectionType: 'openai-compatible',
                            name: 'Packaged test AI',
                            baseUrl: modelBaseUrl,
                            model: 'gofer-packaged-test',
                            api: 'openai-completions',
                            modelName: 'Gofer packaged test',
                            contextWindow: 8192,
                            maxTokens: 2048,
                            reasoning: false,
                            supportsReasoningEffort: false,
                            input: ['text', 'image'],
                            thinkingLevel: 'off',
                            maxRetries: 0,
                            timeoutMs: 10_000,
                            systemPrompt: ''
                        }
                    },
                    null,
                    4
                )}\n`
            )
    }
}

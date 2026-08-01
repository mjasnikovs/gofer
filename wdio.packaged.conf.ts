import type {Options} from '@wdio/types'
import {cpSync, existsSync, mkdtempSync, mkdirSync, writeFileSync} from 'node:fs'
import {spawn} from 'node:child_process'
import type {ChildProcessWithoutNullStreams} from 'node:child_process'
import {createServer} from 'node:http'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'

const executable =
    process.platform === 'win32' ?
        'src-tauri/target/release/gofer.exe'
    :   'src-tauri/target/release/gofer'
const fixtureRoot =
    process.env.GOFER_PACKAGED_FIXTURE_ROOT ?? mkdtempSync(join(tmpdir(), 'gofer-wdio-'))
const appDataDir = join(fixtureRoot, 'data')
process.env.GOFER_APP_DATA_DIR = appDataDir
process.env.GOFER_RAG_CACHE_DIR = join(fixtureRoot, 'cache')
process.env.GOFER_WEBDRIVER_RAG_READY = '1'
process.env.GOFER_WEBDRIVER_SKIP_CREDENTIAL_STORE = '1'
process.env.GOFER_AI_WORKER = resolve('fixtures/packaged/fake-ai-worker.mjs')

let godotBridge: ChildProcessWithoutNullStreams | undefined

async function startGodotBridge() {
    const binary = process.env.GOFER_GODOT_BINARY
    if (!binary) throw new Error('GOFER_GODOT_BINARY is required for the packaged journey')
    const project = join(fixtureRoot, 'godot-project')
    cpSync(resolve('fixtures/godot-project'), project, {recursive: true})
    const probe = createServer()
    await new Promise<void>((resolveListen, reject) => {
        probe.once('error', reject)
        probe.listen(0, '127.0.0.1', resolveListen)
    })
    const address = probe.address()
    if (!address || typeof address === 'string') throw new Error('Godot bridge probe has no port')
    await new Promise<void>(resolveClose =>
        probe.close(() => {
            resolveClose()
        })
    )
    const port = address.port
    const bridge = spawn(
        binary,
        [
            '--headless',
            '--path',
            project,
            '--script',
            'res://tests/bridge.gd',
            '--',
            `--port=${String(port)}`
        ],
        {stdio: 'pipe'}
    )
    godotBridge = bridge
    await new Promise<void>((resolveReady, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error('Godot bridge did not become ready'))
        }, 15_000)
        bridge.once('error', reject)
        bridge.once('exit', code => {
            reject(new Error(`Godot bridge exited with ${String(code)}`))
        })
        bridge.stdout.on('data', chunk => {
            if (!String(chunk).includes('GOFER_BRIDGE_READY:')) return
            clearTimeout(timeout)
            resolveReady()
        })
    })
    process.env.GOFER_TEST_GODOT_ADDRESS = `127.0.0.1:${String(port)}`
    process.env.GOFER_TEST_GODOT_PROJECT = project
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
    mochaOpts: {ui: 'bdd', timeout: 60_000},
    onPrepare: async () => {
        await startGodotBridge()
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
    },
    onComplete: async () => {
        godotBridge?.kill()
    }
}

import type {Options} from '@wdio/types'
import {copyFileSync, existsSync, mkdirSync} from 'node:fs'
import {homedir, tmpdir} from 'node:os'
import {join} from 'node:path'

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

const workspace = process.env.GOFER_LIVE_WORKSPACE ?? join(homedir(), 'hub/test-gd')
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
    connectionRetryTimeout: 180_000,
    connectionRetryCount: 0,
    framework: 'mocha',
    reporters: ['spec'],
    specFileRetries: 0,
    mochaOpts: {ui: 'bdd', timeout: 300_000},
    onPrepare: () => {
        if (!existsSync(join(workspace, 'project.godot'))) {
            throw new Error(`${workspace} is not a Godot project`)
        }
        const userSettings = join(homedir(), '.config/com.gofer.desktop/settings.json')
        const settings = join(appDataDir, 'settings.json')
        // The sweep talks to whatever model the user configured, so it starts from their settings.
        if (!existsSync(settings) && existsSync(userSettings)) copyFileSync(userSettings, settings)
    }
}

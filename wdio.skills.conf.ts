import {mkdirSync, mkdtempSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

const executable =
    process.platform === 'win32' ?
        'src-tauri/target/release/gofer.exe'
    :   'src-tauri/target/release/gofer'

const root = process.env.GOFER_SKILLS_SMOKE_ROOT ?? mkdtempSync(join(tmpdir(), 'gofer-skills-'))
const workspace = join(root, 'workspace')
const fixture = join(root, 'godot-pixel-camera')

process.env.GOFER_SKILLS_SMOKE_ROOT = root
process.env.GOFER_APP_DATA_DIR = join(root, 'data')
process.env.GOFER_WORKSPACE_DIR = workspace
process.env.GOFER_SKILLS_SMOKE_WORKSPACE = workspace
process.env.GOFER_SKILLS_SMOKE_FOLDER = process.env.GOFER_SKILL_FOLDER ?? fixture
process.env.GOFER_WEBDRIVER_RAG_READY = '1'
process.env.GOFER_WEBDRIVER_SKIP_CREDENTIAL_STORE = '1'

function prepare() {
    mkdirSync(workspace, {recursive: true})
    if (process.env.GOFER_SKILL_FOLDER) return
    mkdirSync(join(fixture, 'reference'), {recursive: true})
    writeFileSync(
        join(fixture, 'SKILL.md'),
        '---\nname: godot-pixel-camera\ndescription: Build a pixel-perfect Camera2D in Godot 4.\n---\n\nThe traps are in `reference/traps.md`.\n'
    )
    writeFileSync(join(fixture, 'reference', 'traps.md'), '# Traps\n')
    writeFileSync(join(fixture, 'reference', 'camera.md'), '# Camera\n')
}

export const config: WebdriverIO.Config = {
    runner: 'local',
    specs: ['./e2e/desktop/skills.spec.ts'],
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
    waitforTimeout: 15_000,
    connectionRetryTimeout: 60_000,
    connectionRetryCount: 0,
    framework: 'mocha',
    reporters: ['spec'],
    mochaOpts: {ui: 'bdd', timeout: 60_000},
    onPrepare: prepare
}

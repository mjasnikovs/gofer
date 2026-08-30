import {existsSync, mkdtempSync, rmSync} from 'node:fs'
import {homedir, tmpdir} from 'node:os'
import {delimiter, join} from 'node:path'
import {seedGodotProject} from './e2e/live/workspace-fixture'

const executable =
    process.platform === 'win32' ?
        'src-tauri/target/release/gofer.exe'
    :   'src-tauri/target/release/gofer'

const root = mkdtempSync(join(tmpdir(), 'gofer-layout-'))

// An empty chat cannot overflow, so a gate that only ever opens one measures a
// column no user has. Point this at a real project to measure the real thing.
const workspace = process.env['GOFER_LAYOUT_PROJECT'] ?? join(root, 'workspace')

process.env.GOFER_APP_DATA_DIR = join(root, 'data')
process.env.GOFER_WORKSPACE_DIR = workspace
process.env.GOFER_WEBDRIVER_RAG_READY = '1'
process.env.GOFER_WEBDRIVER_SKIP_CREDENTIAL_STORE = '1'

// cargo installs tauri-driver outside the login PATH on most machines, so find it
// rather than failing with a driver error that names nothing.
const cargoBin = join(homedir(), '.cargo/bin')
if (existsSync(join(cargoBin, 'tauri-driver'))) {
    process.env['PATH'] = `${cargoBin}${delimiter}${process.env['PATH'] ?? ''}`
}

// GTK prefers Wayland whenever WAYLAND_DISPLAY survives, and a tiling compositor then
// hands the window its own width no matter what setWindowSize asked for.
process.env['GDK_BACKEND'] = 'x11'
delete process.env['WAYLAND_DISPLAY']
delete process.env['XDG_SESSION_TYPE']

function which(binary: string) {
    return (process.env['PATH'] ?? '')
        .split(delimiter)
        .some(entry => entry.length > 0 && existsSync(join(entry, binary)))
}

export const config: WebdriverIO.Config = {
    runner: 'local',
    specs: ['./e2e/desktop/layout.spec.ts'],
    maxInstances: 1,
    services: [
        [
            '@wdio/tauri-service',
            {
                appBinaryPath: executable,
                driverProvider: 'embedded',
                embeddedPort: 4449,
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
    mochaOpts: {ui: 'bdd', timeout: 120_000},
    onPrepare: () => {
        if (!which('tauri-driver')) {
            throw new Error(
                'tauri-driver is missing. Install it with `cargo install tauri-driver`.'
            )
        }
        if (!which('xvfb-run')) {
            throw new Error(
                'xvfb-run is missing. This gate needs a bare display to size the window.'
            )
        }
        if (!process.env['GOFER_LAYOUT_PROJECT']) seedGodotProject(workspace)
    },
    onComplete: () => {
        rmSync(root, {recursive: true, force: true})
    }
}

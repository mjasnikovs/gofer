import {existsSync, mkdtempSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'
import {spawn} from 'node:child_process'
import {createServer} from 'node:http'
import {resolveGodotBinary} from './godot-binary.mjs'

// The journey asserts the formatter answers from the bundled sidecar rather than from an override,
// so the sidecar has to have been built. Failing here names the command; failing inside the
// packaged run would only report `formatter_unavailable` from a window three processes away.
const sidecar = resolve(
    'src-tauri/sidecar',
    process.platform === 'win32' ? 'gdformat.exe' : 'gdformat'
)
if (!existsSync(sidecar)) {
    throw new Error(`The packaged journey needs the bundled sidecar. Run: npm run build:gdformat`)
}

const fixtureRoot = mkdtempSync(join(tmpdir(), 'gofer-packaged-journey-'))
const wdio = resolve('node_modules/@wdio/cli/bin/wdio.js')
const modelServer = createServer((request, response) => {
    if (request.url === '/v1/models') {
        response.writeHead(200, {'content-type': 'application/json'})
        response.end(JSON.stringify({data: [{id: 'gofer-packaged-test'}]}))
        return
    }
    response.writeHead(404, {'content-type': 'application/json'})
    response.end('{}')
})

await new Promise((resolveListen, reject) => {
    modelServer.once('error', reject)
    modelServer.listen(0, '127.0.0.1', resolveListen)
})
const address = modelServer.address()
if (!address || typeof address === 'string') throw new Error('Fake model server has no port')
// The journey drives a real editor session, so the pinned engine is resolved and verified here
// rather than assumed: the application discovers it through this same variable.
const environment = {
    ...process.env,
    GOFER_GODOT_BINARY: resolveGodotBinary(),
    GOFER_PACKAGED_FIXTURE_ROOT: fixtureRoot,
    GOFER_PACKAGED_MODEL_BASE_URL: `http://127.0.0.1:${String(address.port)}/v1`
}

function runWdio(spec) {
    return new Promise((resolveRun, reject) => {
        const child = spawn(
            process.execPath,
            [wdio, 'run', 'wdio.packaged.conf.ts', '--spec', spec],
            {
                env: environment,
                stdio: 'inherit'
            }
        )
        child.once('error', reject)
        child.once('exit', code => resolveRun(code ?? 1))
    })
}

try {
    for (const spec of ['e2e/desktop/packaged.spec.ts', 'e2e/desktop/packaged-restart.spec.ts']) {
        const status = await runWdio(spec)
        if (status !== 0) process.exitCode = status
        if (status !== 0) break
    }
} finally {
    await new Promise(resolveClose => modelServer.close(resolveClose))
    rmSync(fixtureRoot, {recursive: true, force: true})
}

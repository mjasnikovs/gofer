import {resolve} from 'node:path'
import {spawn} from 'node:child_process'
import {copyFileSync, mkdirSync, rmSync} from 'node:fs'
import {resolveGodotBinary} from './godot-binary.mjs'

const binary = resolveGodotBinary()

const project = resolve('fixtures/godot-project')

const SUITES = [
    'res://tests/protocol_test.gd',
    'res://tests/params_test.gd',
    'res://tests/parse_test.gd'
]

const STAGED = resolve(project, 'addons/gofer')
const ADDON = resolve('src-tauri/addon')

function stageAddon() {
    mkdirSync(STAGED, {recursive: true})
    for (const name of ['protocol.gd', 'params.gd', 'plugin.gd', 'runtime.gd'])
        copyFileSync(resolve(ADDON, name), resolve(STAGED, name))
}

function runSuite(suite) {
    return new Promise((settle, fail) => {
        const child = spawn(binary, ['--headless', '--path', project, '--script', suite], {
            encoding: 'utf8'
        })
        let output = ''
        child.stdout.on('data', chunk => (output += chunk))
        child.stderr.on('data', chunk => (output += chunk))
        child.on('error', fail)
        child.on('close', status => settle({status, output}))
    })
}

stageAddon()
let failed = false
try {
    const results = await Promise.all(SUITES.map(runSuite))
    for (const {status, output} of results) {
        process.stdout.write(output)
        if (status !== 0 || /(?:SCRIPT ERROR|ERROR:)/u.test(output)) failed = true
    }
} finally {
    rmSync(resolve(project, 'addons'), {recursive: true, force: true})
}
process.exitCode = failed ? 1 : 0

import {resolve} from 'node:path'
import {spawn} from 'node:child_process'
import {copyFileSync, mkdirSync, rmSync} from 'node:fs'
import {resolveGodotBinary} from './godot-binary.mjs'

const binary = resolveGodotBinary()

const project = resolve('fixtures/godot-project')

/**
 * The halves of the addon that need no editor.
 *
 * `protocol.gd` is the codec both processes share; `params.gd` is what the editor commands decide
 * before they touch the editor. Both are loaded from source rather than from a staged copy, and
 * both run in about a second — which is the whole point of them being separate from `plugin.gd`,
 * where every one of these checks cost a real editor boot to reach.
 */
const SUITES = [
    'res://tests/protocol_test.gd',
    'res://tests/params_test.gd',
    'res://tests/parse_test.gd'
]

/*
 * The addon, copied in fresh from source for the length of the run.
 *
 * `params.gd` preloads `protocol.gd`, and GDScript resolves a preload against `res://` at parse
 * time — so the two have to sit where the shipped addon sits before either can be loaded at all.
 * Copied rather than committed, and removed afterwards, so what runs is always the current source
 * and the fixture project never holds a stale second copy of the addon.
 */
const STAGED = resolve(project, 'addons/gofer')
const ADDON = resolve('src-tauri/addon')

function stageAddon() {
    mkdirSync(STAGED, {recursive: true})
    // `plugin.gd` and `runtime.gd` are staged too, and only `parse_test.gd` reads them: neither
    // can be *run* without an editor or a game, but both can be compiled, and a moved function
    // that no longer parses is the one thing that breaks without any suite noticing.
    for (const name of ['protocol.gd', 'params.gd', 'plugin.gd', 'runtime.gd'])
        copyFileSync(resolve(ADDON, name), resolve(STAGED, name))
}

/**
 * One suite, in an editor of its own.
 *
 * The two are started against each other rather than one after the other. Each is a full headless
 * engine boot that imports the fixture before it runs a line, and neither touches anything the
 * other writes — the addon is staged once before both, and read-only from there. Run in turn they
 * cost two boots end to end for no reason but the shape of the loop that started them.
 */
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
    // Both are awaited before anything is written, so the two editors' output does not interleave
    // into one unreadable stream — a suite is read as a block or not at all.
    const results = await Promise.all(SUITES.map(runSuite))
    for (const {status, output} of results) {
        process.stdout.write(output)
        if (status !== 0 || /(?:SCRIPT ERROR|ERROR:)/u.test(output)) failed = true
    }
} finally {
    rmSync(resolve(project, 'addons'), {recursive: true, force: true})
}
process.exitCode = failed ? 1 : 0

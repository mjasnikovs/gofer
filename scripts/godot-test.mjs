import {resolve} from 'node:path'
import {spawnSync} from 'node:child_process'
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
const SUITES = ['res://tests/protocol_test.gd', 'res://tests/params_test.gd']

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
    for (const name of ['protocol.gd', 'params.gd'])
        copyFileSync(resolve(ADDON, name), resolve(STAGED, name))
}

let failed = false
stageAddon()
try {
    for (const suite of SUITES) {
        const result = spawnSync(binary, ['--headless', '--path', project, '--script', suite], {
            encoding: 'utf8'
        })
        if (result.error) throw result.error
        process.stdout.write(result.stdout)
        process.stderr.write(result.stderr)
        const output = `${result.stdout}\n${result.stderr}`
        if (result.status !== 0 || /(?:SCRIPT ERROR|ERROR:)/u.test(output)) failed = true
    }
} finally {
    rmSync(resolve(project, 'addons'), {recursive: true, force: true})
}
process.exitCode = failed ? 1 : 0

import {isAbsolute, resolve} from 'node:path'
import {spawnSync} from 'node:child_process'

const binary = process.env.GOFER_GODOT_BINARY
if (!binary) throw new Error('GOFER_GODOT_BINARY must be the absolute pinned Godot binary path')
if (!isAbsolute(binary)) throw new Error('GOFER_GODOT_BINARY must be an absolute path')

const version = spawnSync(binary, ['--version'], {encoding: 'utf8'})
if (version.status !== 0) throw new Error(version.stderr || 'Could not execute GOFER_GODOT_BINARY')
if (!version.stdout.startsWith('4.7.1.stable')) {
    throw new Error(`Expected Godot 4.7.1-stable, received ${version.stdout.trim()}`)
}

const project = resolve('fixtures/godot-project')
const result = spawnSync(
    binary,
    ['--headless', '--path', project, '--script', 'res://tests/protocol_test.gd'],
    {encoding: 'utf8'}
)
if (result.error) throw result.error
process.stdout.write(result.stdout)
process.stderr.write(result.stderr)
const output = `${result.stdout}\n${result.stderr}`
process.exitCode = result.status !== 0 || /(?:SCRIPT ERROR|ERROR:)/u.test(output) ? 1 : 0

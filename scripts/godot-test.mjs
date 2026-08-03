import {resolve} from 'node:path'
import {spawnSync} from 'node:child_process'
import {resolveGodotBinary} from './godot-binary.mjs'

const binary = resolveGodotBinary()

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

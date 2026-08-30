import {spawnSync} from 'node:child_process'
import {pinnedVersionPrefix, resolveGodotBinary} from './godot-binary.mjs'
import {reexecUnderVirtualDisplay} from './virtual-display.mjs'

reexecUnderVirtualDisplay()

const binary = resolveGodotBinary()
const version = spawnSync(binary, ['--version'], {encoding: 'utf8'})
if (version.status !== 0) throw new Error(`Could not read the version of ${binary}`)
process.stdout.write(
    `Checking the catalog against Godot ${version.stdout.trim()} (pinned ${pinnedVersionPrefix()})\n`
)

const run = spawnSync(
    'cargo',
    [
        'test',
        '--manifest-path',
        'src-tauri/Cargo.toml',
        '--features',
        'godot-api-drift',
        '--lib',
        'godot_api_drift',
        '--',
        '--test-threads=1'
    ],
    {stdio: 'inherit'}
)
process.exit(run.status ?? 1)

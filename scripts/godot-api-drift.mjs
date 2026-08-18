import {spawnSync} from 'node:child_process'
import {pinnedVersionPrefix, resolveGodotBinary} from './godot-binary.mjs'
import {reexecUnderVirtualDisplay} from './virtual-display.mjs'

// Runs the engine-drift gate: the claims the AI tool catalog makes about Godot itself, checked
// against a real editor.
//
// Kept out of `npm run check` and out of `npm run test:godot` on purpose. Nothing it covers can
// break because of a commit — the key names it feeds to the editor come out of Godot's own keycode
// table — so it earns nothing by running on every change. It earns everything the day the pin in
// `protocol/godot-artifacts.json` moves, which is the day the table might have.
//
// The version is printed rather than asserted: this suite is evidence about one engine, and the
// line above the result is what says which.

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

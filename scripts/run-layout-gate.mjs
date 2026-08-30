import {spawnSync} from 'node:child_process'
import {existsSync, readFileSync} from 'node:fs'
import {delimiter, join} from 'node:path'

const conf = JSON.parse(
    readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8')
)
const window = conf.app.windows[0]

function onPath(binary) {
    return (process.env.PATH ?? '')
        .split(delimiter)
        .some(entry => entry.length > 0 && existsSync(join(entry, binary)))
}

// A tiling compositor answers setWindowSize with its own tile, so the sweep has to
// own the display. The screen is the largest window the sweep asks for; with no
// window manager there are no decorations to leave room for.
const screen = `${String(window.width)}x${String(window.height)}x24`
const wrapped =
    process.platform === 'linux' ?
        ['xvfb-run', ['-a', '-s', `-screen 0 ${screen}`, 'wdio', 'run', 'wdio.layout.conf.ts']]
    :   ['wdio', ['run', 'wdio.layout.conf.ts']]

if (process.platform === 'linux' && !onPath('xvfb-run')) {
    process.stderr.write(
        'xvfb-run is missing. This gate needs a display it owns, because a tiling\n'
            + 'compositor overrides the window size the sweep asks for. Install xvfb.\n'
    )
    process.exit(1)
}

const result = spawnSync(wrapped[0], wrapped[1], {stdio: 'inherit'})
process.exit(result.status ?? 1)

import {spawnSync} from 'node:child_process'

const WRAPPED = 'GOFER_VIRTUAL_DISPLAY'

export function reexecUnderVirtualDisplay() {
    if (
        process.platform !== 'linux'
        || process.env[WRAPPED]
        || process.env.GOFER_GODOT_DISPLAY === 'host'
    ) {
        return false
    }
    const wrapped = spawnSync('xvfb-run', ['-a', process.execPath, ...process.argv.slice(1)], {
        stdio: 'inherit',
        env: virtualDisplayEnv(process.env)
    })
    if (wrapped.error) {
        throw new Error(
            'This suite needs a display for the Godot tests that run a windowed game. Install '
                + 'xvfb, or set GOFER_GODOT_DISPLAY=host to use the one already running.'
        )
    }
    process.exit(wrapped.status ?? 1)
}

export function virtualDisplayEnv(env) {
    const child = {...env, [WRAPPED]: '1'}
    delete child.WAYLAND_DISPLAY
    delete child.XDG_SESSION_TYPE
    return child
}

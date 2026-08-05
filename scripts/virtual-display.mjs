import {spawnSync} from 'node:child_process'

const WRAPPED = 'GOFER_VIRTUAL_DISPLAY'

/**
 * Re-executes the calling script under `xvfb-run` when it needs a display and the machine has
 * none, and returns whether it did.
 *
 * Three Godot acceptance tests run the fixture as a real windowed game, because a screenshot needs
 * a rendered frame and a headless viewport has none — `--headless` returns a null image where a
 * windowed run returns pixels. A Linux CI runner has no display at all, so those tests can only
 * report "Unable to create DisplayServer, all display drivers failed" there.
 *
 * The suites that need a display claim one for themselves rather than the workflow wrapping the
 * whole gate: a display is not free to the suites that do not want one. Wrapping `npm run check`
 * made Playwright render into X instead of its own headless pipeline and moved 297 pixels of three
 * committed snapshots.
 */
export function reexecUnderVirtualDisplay() {
    if (
        process.platform !== 'linux'
        || process.env.DISPLAY
        || process.env.WAYLAND_DISPLAY
        || process.env[WRAPPED]
    ) {
        return false
    }
    const wrapped = spawnSync('xvfb-run', ['-a', process.execPath, ...process.argv.slice(1)], {
        stdio: 'inherit',
        env: {...process.env, [WRAPPED]: '1'}
    })
    if (wrapped.error) {
        throw new Error(
            'This suite needs a display for the Godot tests that run a windowed game. Install '
                + 'xvfb, or run it where a display server is already available.'
        )
    }
    process.exit(wrapped.status ?? 1)
}

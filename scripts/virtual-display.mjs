import {spawnSync} from 'node:child_process'

const WRAPPED = 'GOFER_VIRTUAL_DISPLAY'

/**
 * Re-executes the calling script under `xvfb-run`, and returns whether it did.
 *
 * Several Godot acceptance tests run the fixture as a real windowed game, because a screenshot
 * needs a rendered frame and a headless viewport has none — `--headless` returns a null image where
 * a windowed run returns pixels. A Linux CI runner has no display at all, so those tests can only
 * report "Unable to create DisplayServer, all display drivers failed" there.
 *
 * A display of its own rather than the developer's, even when the developer has one. Sixty tests
 * launching a game onto the desktop is a minute of Godot splash screens taking focus off whatever
 * the person running the gate was actually doing, and a window manager that decides to place, raise
 * or animate one of those windows is doing it inside a test that is timing the launch. CI has run
 * every one of these under Xvfb since the suite existed, so the virtual display is the configuration
 * with evidence behind it and the desktop was the exception.
 *
 * The suites that need a display claim one for themselves rather than the workflow wrapping the
 * whole gate: a display is not free to the suites that do not want one. Wrapping `npm run check`
 * made Playwright render into X instead of its own headless pipeline and moved 297 pixels of three
 * committed snapshots.
 *
 * `GOFER_GODOT_DISPLAY=host` opts back out, for the one case the virtual display cannot serve:
 * watching what the editor is actually doing while a test drives it.
 */
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

/**
 * The environment a child under the virtual display gets.
 *
 * `xvfb-run` sets `DISPLAY` and nothing else, so a Wayland session's `WAYLAND_DISPLAY` travels
 * straight through it. Gofer reads that variable to decide the editor's display driver — embedding
 * a game needs Godot's Wayland embedder, and there is no X11 one — so an editor started inside this
 * wrapper asked for Wayland, found the developer's own compositor, and opened on their desktop.
 * Measured while a live turn was running: `hyprctl clients` had
 * `org.godotengine.Editor | main.tscn - Gofer Live Sweep - Backwards` on workspace 1, beside the
 * terminal that started it. Which is the one thing this wrapper exists to prevent.
 *
 * So the Wayland session is dropped along with the desktop it belongs to. A child here has one
 * display, the X server `xvfb-run` just started, and says so. Game embedding is off inside the
 * wrapper as a result, which is correct rather than a cost: Godot cannot embed on X11 at all, and a
 * test that needs a window wants it on the virtual screen.
 *
 * `XDG_SESSION_TYPE` goes too. Nothing in Gofer reads it, but it is the other half of the same
 * claim, and a child that is told `wayland` while holding only an X display is being lied to.
 */
export function virtualDisplayEnv(env) {
    const child = {...env, [WRAPPED]: '1'}
    delete child.WAYLAND_DISPLAY
    delete child.XDG_SESSION_TYPE
    return child
}

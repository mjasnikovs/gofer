import {strict as assert} from 'node:assert'
import test from 'node:test'
import {virtualDisplayEnv} from './virtual-display.mjs'

/**
 * The failure this pins was watched, not reasoned about: while a live turn ran under `xvfb-run`,
 * `hyprctl clients` reported `org.godotengine.Editor | main.tscn - Gofer Live Sweep - Backwards`
 * on the developer's own workspace 1, beside the terminal that had started it.
 *
 * `xvfb-run` sets `DISPLAY` and nothing else, so `WAYLAND_DISPLAY` travelled through untouched,
 * and Gofer reads that variable to decide whether to ask Godot for the Wayland driver that game
 * embedding needs. A wrapper whose whole purpose is a display of its own was handing every child a
 * second one.
 */
test('a child under the virtual display is not also told about a Wayland session', () => {
    const child = virtualDisplayEnv({
        DISPLAY: ':0',
        WAYLAND_DISPLAY: 'wayland-1',
        XDG_SESSION_TYPE: 'wayland',
        PATH: '/usr/bin'
    })
    assert.equal(child.WAYLAND_DISPLAY, undefined)
    assert.equal(child.XDG_SESSION_TYPE, undefined)
    // Everything else travels: the wrapper narrows the display, it does not build an environment.
    assert.equal(child.PATH, '/usr/bin')
    // `xvfb-run` overwrites DISPLAY itself, so what is passed in is irrelevant and left alone.
    assert.equal(child.DISPLAY, ':0')
})

test('the child is marked as already wrapped, so it cannot re-exec itself forever', () => {
    assert.equal(virtualDisplayEnv({}).GOFER_VIRTUAL_DISPLAY, '1')
})

test('an environment with no Wayland session is passed through unharmed', () => {
    const child = virtualDisplayEnv({DISPLAY: ':99', HOME: '/home/x'})
    assert.equal(child.DISPLAY, ':99')
    assert.equal(child.HOME, '/home/x')
})

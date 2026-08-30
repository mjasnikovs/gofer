import {strict as assert} from 'node:assert'
import test from 'node:test'
import {virtualDisplayEnv} from './virtual-display.mjs'

test('a child under the virtual display is not also told about a Wayland session', () => {
    const child = virtualDisplayEnv({
        DISPLAY: ':0',
        WAYLAND_DISPLAY: 'wayland-1',
        XDG_SESSION_TYPE: 'wayland',
        PATH: '/usr/bin'
    })
    assert.equal(child.WAYLAND_DISPLAY, undefined)
    assert.equal(child.XDG_SESSION_TYPE, undefined)
    assert.equal(child.PATH, '/usr/bin')
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

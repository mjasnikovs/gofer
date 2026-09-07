import assert from 'node:assert/strict'
import test from 'node:test'
import {findPhantomPaths, formatPathCorrections, namedPaths} from './phantom.mjs'

const has = present => async full => present.some(path => full.endsWith(path))

test('only backticked project files count, and res:// is the same file', () => {
    const found = namedPaths(
        '- edit `scripts/ui/menu.gd` and `res://scenes/main.tscn` using `Units`'
    )
    assert.deepEqual([...found.keys()], ['scripts/ui/menu.gd', 'scenes/main.tscn'])
})

test('a path the task plans to write is absent on purpose', () => {
    assert.deepEqual([...namedPaths('- create `scripts/ui/new_panel.gd`').keys()], [])
    assert.deepEqual([...namedPaths('- `a/b.gd` does not exist yet; the task adds it').keys()], [])
})

test('a path that climbs out of the workspace is never looked up', () => {
    assert.deepEqual([...namedPaths('- read `../secrets/keys.json` and `/etc/a.json`').keys()], [])
})

test('an asserted path the project does not have comes back in the spelling used', async () => {
    const missing = await findPhantomPaths(
        '- do not modify `scenes/main.tscn`\n- reuse `scripts/ui/ghost.gd`',
        '/w',
        has(['scenes/main.tscn'])
    )
    assert.deepEqual(missing, ['`scripts/ui/ghost.gd`'])
})

test('the correction is its own section, and nothing missing writes nothing', () => {
    assert.match(
        formatPathCorrections(['`a.gd`']),
        /^CORRECTIONS\n- `a\.gd` is not in this project/u
    )
    assert.equal(formatPathCorrections([]), '')
})

test('a runtime path and a glob are not files this project is missing', () => {
    const found = namedPaths(
        '- the game saves to `user://save.json`, and every `*.gd` under `scripts/ui/`'
    )
    assert.deepEqual([...found.keys()], [])
})

test('"new" alone does not exempt a line from the check', () => {
    assert.deepEqual(
        [...namedPaths('- the new panel must read `scripts/ui/menu.gd`').keys()],
        ['scripts/ui/menu.gd']
    )
})

test('a line that plans to write the file is exempt however it words it', () => {
    for (const line of [
        '- add a new file `scripts/ui/menu.gd` for the pause menu',
        '- write a new `scripts/ui/menu.gd`',
        '- make `scripts/ui/menu.gd` hold the pause menu',
        '- a new scene `scenes/menu.tscn` is introduced',
        '- build `scripts/ui/menu.gd` from the existing panel'
    ])
        assert.deepEqual([...namedPaths(line).keys()], [], line)
})

test('a create verb exempts only the file it acts on', () => {
    for (const line of [
        '- add the pause toggle to `scripts/ui/menu.gd`',
        '- write the score into `scripts/ui/menu.gd`',
        '- build the menu out of `scripts/ui/menu.gd`',
        '- make the pause work by reading `scripts/ui/menu.gd`'
    ])
        assert.deepEqual([...namedPaths(line).keys()], ['scripts/ui/menu.gd'], line)
})

test('a create verb inside a command token exempts nothing', () => {
    for (const line of [
        '- `make test` must pass before you touch `scripts/ui/menu.gd`',
        '- run `npm run build`, then read `scripts/ui/menu.gd`'
    ])
        assert.deepEqual([...namedPaths(line).keys()], ['scripts/ui/menu.gd'], line)
})

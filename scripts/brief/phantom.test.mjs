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

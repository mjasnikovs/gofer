import assert from 'node:assert/strict'
import test from 'node:test'
import {SOURCES, readVersions} from './version.mjs'

test('reads one version out of every file that carries it', async () => {
    const found = await readVersions()

    assert.equal(found.length, SOURCES.length)
    assert.deepEqual(
        found.map(entry => entry.file),
        SOURCES.map(source => source.file)
    )
    for (const entry of found) assert.match(entry.version, /^\d+\.\d+\.\d+/u)
    assert.equal(new Set(found.map(entry => entry.version)).size, 1)
})

test('takes the crate version out of Cargo.toml and not a dependency it lists', () => {
    // Every dependency below `[package]` has a `version` too, and the first one in the file is the
    // crate's only by luck. A pattern that matched loosely renamed a dependency instead.
    const cargo = SOURCES.find(source => source.file.endsWith('Cargo.toml'))
    const manifest = [
        '[package]',
        'name = "gofer"',
        'version = "1.2.3"',
        '',
        '[dependencies]',
        'tauri = { version = "9.9.9" }'
    ].join('\n')

    assert.equal(cargo.pattern.exec(manifest).groups.version, '1.2.3')
})

test('finds nothing to replace in a file that carries no version', () => {
    for (const source of SOURCES) assert.equal(source.pattern.exec('{}\n'), null)
})

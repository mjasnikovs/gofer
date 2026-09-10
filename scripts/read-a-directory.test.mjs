import assert from 'node:assert/strict'
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import test from 'node:test'
import {NodeExecutionEnv, createReadTool} from '@earendil-works/pi-agent-core/node'
import {MOST_ENTRIES, listingOf, readsADirectory} from './read-a-directory.mjs'

async function workspace() {
    const root = await mkdtemp(join(tmpdir(), 'gofer-listing-'))
    await mkdir(join(root, 'scripts'))
    await mkdir(join(root, 'empty'))
    await writeFile(join(root, 'project.godot'), 'x')
    await writeFile(join(root, 'scripts', 'player.gd'), 'extends Node\n')
    return {path: root, remove: () => rm(root, {recursive: true, force: true})}
}

function readIn(path) {
    const env = new NodeExecutionEnv({cwd: path})
    const tool = readsADirectory(createReadTool())
    return async params =>
        (await tool.execute('1', params, undefined, undefined, {env})).content[0].text
}

test('reading a folder answers with what is in it', async context => {
    const current = await workspace()
    context.after(current.remove)

    assert.deepEqual((await readIn(current.path)({path: '.'})).split('\n'), [
        'empty/',
        'project.godot',
        'scripts/'
    ])
})

test('reading a file still reads the file', async context => {
    const current = await workspace()
    context.after(current.remove)

    assert.match(await readIn(current.path)({path: 'scripts/player.gd'}), /extends Node/u)
})

test('an empty folder says so rather than answering with nothing', async context => {
    const current = await workspace()
    context.after(current.remove)

    assert.equal(await readIn(current.path)({path: 'empty'}), '(this folder is empty)')
})

test('a folder with more entries than fit says how many are shown', () => {
    const many = Array.from({length: MOST_ENTRIES}, (_unused, index) => ({
        name: `f${String(index)}`,
        kind: 'file'
    }))

    assert.match(listingOf(many, {more: true}), /\n\n\[only the first 500 are shown\]$/u)
})

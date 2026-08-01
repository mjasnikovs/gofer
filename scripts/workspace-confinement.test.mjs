import assert from 'node:assert/strict'
import {mkdir, mkdtemp, rm, symlink, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import test from 'node:test'
import {confineTool} from './workspace-confinement.mjs'

async function workspace() {
    const root = await mkdtemp(join(tmpdir(), 'gofer-confinement-'))
    const path = join(root, 'workspace')
    const outside = join(root, 'outside')
    await mkdir(path)
    await mkdir(outside)
    await writeFile(join(path, 'inside.txt'), 'inside')
    await writeFile(join(outside, 'secret.txt'), 'secret')
    await symlink(join(outside, 'secret.txt'), join(path, 'escape.txt'))
    return {path, remove: () => rm(root, {recursive: true, force: true})}
}

function fakeTool(name) {
    return {
        name,
        execute: async (_id, params) => params
    }
}

test('allows existing and new paths that remain in the workspace', async context => {
    const current = await workspace()
    context.after(current.remove)
    const tool = confineTool(fakeTool('read'), current.path)

    assert.deepEqual(await tool.execute('1', {path: 'inside.txt'}), {path: 'inside.txt'})
    assert.deepEqual(await tool.execute('2', {path: 'new.txt'}), {path: 'new.txt'})
    assert.deepEqual(await tool.execute('3', {path: '.'}), {path: '.'})
})

test('rejects malformed, traversal, and escaping-symlink tool paths', async context => {
    const current = await workspace()
    context.after(current.remove)
    const tool = confineTool(fakeTool('read'), current.path)

    for (const path of [undefined, '', 'bad\0path', '../outside/secret.txt', 'escape.txt'])
        await assert.rejects(tool.execute('1', {path}), /path|workspace/iu)
})

test('allows workspace shell commands and rejects every explicit escape form', async context => {
    const current = await workspace()
    context.after(current.remove)
    const tool = confineTool(fakeTool('bash'), current.path)

    assert.deepEqual(await tool.execute('1', {command: 'npm test'}), {command: 'npm test'})
    for (const command of [
        undefined,
        '',
        'bad\0command',
        'cat ../secret',
        'cat /etc/passwd',
        'cat ~/secret',
        'true; cd other'
    ])
        await assert.rejects(tool.execute('2', {command}), /Shell|workspace/iu)
})

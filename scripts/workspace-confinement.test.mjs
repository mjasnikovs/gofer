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
    await mkdir(join(path, 'scenes'))
    await mkdir(join(path, 'scripts'))
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

test('accepts the resource paths Godot names files by', async context => {
    const current = await workspace()
    context.after(current.remove)
    const tool = confineTool(fakeTool('read'), current.path)

    // The agent writes back the names it reads — the editor's, the addon's, and Gofer's own errors
    // all say `res://`. Untranslated they resolved to a `res:/` directory that never existed.
    assert.deepEqual(await tool.execute('1', {path: 'res://inside.txt'}), {path: 'inside.txt'})
    assert.deepEqual(await tool.execute('2', {path: 'res://new.txt', text: 'x'}), {
        path: 'new.txt',
        text: 'x'
    })
    await assert.rejects(tool.execute('3', {path: 'res://../outside/secret.txt'}), /workspace/iu)
})

test('rejects malformed, traversal, and escaping-symlink tool paths', async context => {
    const current = await workspace()
    context.after(current.remove)
    const tool = confineTool(fakeTool('read'), current.path)

    for (const path of [undefined, '', 'bad\0path', '../outside/secret.txt', 'escape.txt'])
        await assert.rejects(tool.execute('1', {path}), /path|workspace/iu)
})

test('refuses to let the raw file tools write what the editor owns', async context => {
    const current = await workspace()
    context.after(current.remove)

    for (const name of ['write', 'edit']) {
        const tool = confineTool(fakeTool(name), current.path)
        // Both of these hang the editor on a modal nobody can answer when they are written as text.
        await assert.rejects(
            tool.execute('1', {path: 'scenes/level.tscn', text: '[gd_scene]'}),
            /godot_scene/u
        )
        await assert.rejects(
            tool.execute('2', {path: 'res://scenes/level.scn', text: 'x'}),
            /godot_scene/u
        )
        await assert.rejects(
            tool.execute('3', {path: 'project.godot', text: 'x'}),
            /godot_project/u
        )
        // Everything else the project holds is the agent's to write.
        assert.deepEqual(await tool.execute('4', {path: 'scripts/player.gd', text: 'x'}), {
            path: 'scripts/player.gd',
            text: 'x'
        })
    }

    // Reading one is how the agent finds out what is in it, and that stays allowed.
    const reader = confineTool(fakeTool('read'), current.path)
    assert.deepEqual(await reader.execute('5', {path: 'scenes/level.tscn'}), {
        path: 'scenes/level.tscn'
    })
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

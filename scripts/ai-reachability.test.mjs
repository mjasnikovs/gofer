import assert from 'node:assert/strict'
import {readdir} from 'node:fs/promises'
import {join} from 'node:path'
import test from 'node:test'
import {createToolHost} from './ai-host.mjs'
import {probeTools} from './ai-reachability.mjs'
import {createChildTools} from './ai-subagent.mjs'
import {createAgentTools, runAgent} from './ai-provider.mjs'
import {
    baseUrl,
    catalog,
    probeResult,
    servedBy,
    settings,
    startScriptedServer,
    temporaryWorkspace
} from './ai-turn-harness.mjs'

test('a declared tool that cannot answer stops the turn before the model is asked', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    const mock = startScriptedServer([{text: 'this turn must never reach the model'}])
    const url = await baseUrl(context, mock.server)
    const host = createToolHost(call =>
        host.deliver(
            call.tool === 'godot_docs_search' ?
                {
                    type: 'tool-result',
                    id: call.id,
                    ok: false,
                    error: {
                        code: 'docs_unavailable',
                        message: 'the retrieve worker was not found'
                    }
                }
            :   probeResult(call)
        )
    )

    await assert.rejects(
        runAgent({
            settings: servedBy(url),
            messages: [{sender: 'user', text: 'How does Tween work?', timestamp: 1}],
            workspacePath: workspace.path,
            tools: catalog,
            host,
            emit: () => undefined
        }),
        error => {
            assert.match(
                error.message,
                /godot_docs_search: docs_unavailable: the retrieve worker was not found/u
            )
            assert.doesNotMatch(error.message, /godot_scene/u)
            return true
        }
    )

    assert.equal(mock.bodies.length, 0)
    assert.deepEqual(await readdir(workspace.path), [])
})

test('the workspace tools are proven against the workspace, not assumed', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    const mock = startScriptedServer([{text: 'this turn must never reach the model'}])
    const url = await baseUrl(context, mock.server)

    await assert.rejects(
        runAgent({
            settings: servedBy(url),
            messages: [{sender: 'user', text: 'Fix the script', timestamp: 1}],
            workspacePath: join(workspace.path, 'removed-worktree'),
            emit: () => undefined
        }),
        error => {
            for (const name of ['read', 'write', 'edit', 'bash'])
                assert.match(error.message, new RegExp(`- ${name}: `, 'u'))
            return true
        }
    )
    assert.equal(mock.bodies.length, 0)
})

test('read and bash are provable without a write tool to set them up', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    const {env, tools} = createChildTools(workspace.path, {toolNames: ['read', 'bash']})
    context.after(() => env.cleanup())

    await probeTools({tools, workspacePath: workspace.path})

    assert.deepEqual(
        (await readdir(workspace.path)).filter(name => name.startsWith('.gofer-tool-probe')),
        []
    )
})

test('a tool that never answers its probe is given up on, and one the turn outlived is not', async () => {
    const silent = {
        name: 'godot_scene',
        execute: () => new Promise(() => undefined)
    }
    const workspace = await temporaryWorkspace()

    await assert.rejects(
        probeTools({
            tools: [silent],
            host: {call: () => new Promise(() => undefined)},
            workspacePath: workspace.path,
            timeoutMs: 20
        }),
        /godot_scene: it did not answer within 0\.02 seconds/u
    )

    await assert.rejects(
        probeTools({tools: [silent], workspacePath: workspace.path}),
        /godot_scene: there is no channel to answer it/u
    )

    await assert.rejects(
        probeTools({
            tools: [silent],
            host: {call: () => new Promise(() => undefined)},
            workspacePath: workspace.path,
            signal: AbortSignal.abort()
        }),
        /godot_scene: the turn was stopped/u
    )

    await workspace.remove()
})

test('a workspace tool that answers without doing its work is caught by the next one', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    const pretending = {
        name: 'edit',
        execute: () => Promise.resolve({content: [{type: 'text', text: 'Successfully edited'}]})
    }
    const real = createAgentTools(workspace.path, undefined, undefined).tools.filter(tool =>
        ['write', 'read'].includes(tool.name)
    )

    await assert.rejects(
        probeTools({tools: [...real, pretending], workspacePath: workspace.path}),
        /- read: it answered without the text the probe wrote: expected reachable, got/u
    )
    assert.deepEqual(await readdir(workspace.path), [])
})

/**
 * Reachability: whether a tool the model is about to be offered can answer at all.
 *
 * The probe runs before the model is told anything, so a tool with nothing behind it stops the turn
 * where the reason can be read rather than becoming a tool the model calls once and never again.
 */

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

/*
 * The defect the reachability pass exists for: a tool the model is told about, with nothing behind
 * it. Zero documentation searches across ten live sweeps was never the model declining the tool.
 */
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
            // The failure names the one tool that could not answer, and only that one.
            assert.match(
                error.message,
                /godot_docs_search: docs_unavailable: the retrieve worker was not found/u
            )
            assert.doesNotMatch(error.message, /godot_scene/u)
            return true
        }
    )

    assert.equal(mock.bodies.length, 0)
    // The probe leaves the worktree as it found it, including when it fails.
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
            // The worktree the turn was given is gone. Every file tool is dead, and the shell has
            // nowhere to start.
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

/*
 * The chain has a beginning, and a caller that does not hold it still has to be provable.
 *
 * The four workspace probes each prove the one before them, and `write` is what creates the file the
 * other three work on. A research worker holds `read` and `bash` and nothing else, so both failed on
 * a file that was never going to exist — every planned task died before its first phase, reported as
 * two tools that could not answer.
 */
test('read and bash are provable without a write tool to set them up', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    const {env, tools} = createChildTools(workspace.path, {toolNames: ['read', 'bash']})
    context.after(() => env.cleanup())

    await probeTools({tools, workspacePath: workspace.path})

    // And the file is still taken away afterwards, so a seeded probe does not leave litter in the
    // worktree the agent is about to work in.
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

    // A domain tool with no channel behind it is the same defect one layer up.
    await assert.rejects(
        probeTools({tools: [silent], workspacePath: workspace.path}),
        /godot_scene: there is no channel to answer it/u
    )

    // A turn stopped while the probes are running fails as stopped rather than as unreachable.
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
    // The shape the whole refactor is about: a tool that reports success and changed nothing. It
    // is the read after it that says so, because the probe is a read-back rather than four
    // independent calls.
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

import assert from 'node:assert/strict'
import test from 'node:test'
import {CANCEL_TYPE, createCancellation, createToolHost} from './ai-host.mjs'

test('the tool host correlates results, failures, cancellation, and closure', async () => {
    const sent = []
    const host = createToolHost(call => sent.push(call))

    const answered = host.call('godot_scene', {op: 'get_tree'})
    assert.equal(sent.length, 1)
    assert.equal(sent[0].tool, 'godot_scene')
    host.deliver({type: 'tool-result', id: sent[0].id, ok: true, result: {revision: 3}})
    assert.deepEqual(await answered, {revision: 3})

    const refused = host.call('godot_scene', {op: 'save'})
    host.deliver({
        type: 'tool-result',
        id: sent[1].id,
        ok: false,
        error: {code: 'revision_conflict', message: 'The scene moved on'}
    })
    await assert.rejects(refused, /revision_conflict: The scene moved on/u)

    host.deliver({type: 'tool-result', id: sent[1].id, ok: true, result: {}})
    host.deliver({type: 'tool-result', id: 'call-unknown', ok: true, result: {}})
    host.deliver({type: 'ignored'})

    const controller = new AbortController()
    const cancelled = host.call('godot_scene', {op: 'get_tree'}, controller.signal)
    controller.abort()
    await assert.rejects(cancelled, /cancelled/u)
    assert.equal(host.pendingCount, 0)

    const failing = createToolHost(() => {
        throw new Error('the channel is closed')
    })
    await assert.rejects(failing.call('godot_scene', {op: 'get_tree'}), /channel is closed/u)
    assert.equal(failing.pendingCount, 0)

    const pending = host.call('godot_scene', {op: 'get_tree'})
    host.close('the backend closed the tool channel')
    await assert.rejects(pending, /backend closed/u)
    await assert.rejects(host.call('godot_scene', {op: 'get_tree'}), /backend closed/u)
    await assert.rejects(
        host.call('godot_scene', {op: 'get_tree'}, AbortSignal.abort()),
        /backend closed/u
    )
})

test('the cancel line is the only line that is not an answer', () => {
    const cancellation = createCancellation()
    assert.equal(cancellation.signal.aborted, false)

    assert.equal(cancellation.deliver({type: 'tool-result', id: 'call-1', ok: true}), false)
    assert.equal(cancellation.deliver(undefined), false)
    assert.equal(cancellation.signal.aborted, false)

    assert.equal(cancellation.deliver({type: CANCEL_TYPE}), true)
    assert.equal(cancellation.signal.aborted, true)
})

test('two hosts reading one stream never answer each other', async () => {
    const toolCalls = []
    const credentialCalls = []
    const tools = createToolHost(call => toolCalls.push(call))
    const credentials = createToolHost(call => credentialCalls.push(call), 'credential')

    const tool = tools.call('godot_scene', {op: 'get_tree'})
    const stored = credentials.call('store', {credential: {type: 'oauth'}})
    assert.notEqual(toolCalls[0].id, credentialCalls[0].id)

    for (const answer of [
        {type: 'tool-result', id: credentialCalls[0].id, ok: true},
        {type: 'tool-result', id: toolCalls[0].id, ok: true, result: {revision: 7}}
    ]) {
        tools.deliver(answer)
        credentials.deliver(answer)
    }

    assert.deepEqual(await tool, {revision: 7})
    assert.equal(await stored, undefined)
})

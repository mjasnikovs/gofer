/**
 * The domain tools as the model is offered them: the router's catalog, turned into tools that
 * forward every call across the host.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {createGodotTools} from './godot-tools.mjs'
import {catalog} from './ai-turn-harness.mjs'

test('domain tools carry the router catalog and forward every call', async () => {
    const calls = []
    const host = {
        call: (tool, params) => {
            calls.push({tool, params})
            return Promise.resolve({nodes: []})
        }
    }
    const tools = createGodotTools(catalog, host)

    assert.deepEqual(
        tools.map(tool => tool.name),
        ['godot_scene', 'godot_runtime', 'godot_resource', 'godot_docs_search']
    )
    assert.deepEqual(tools[0].parameters.properties.ops.items.properties.op.enum, [
        'get_tree',
        'save'
    ])
    assert.match(tools[0].description, /get_tree: Returns the edited scene hierarchy\./u)
    const result = await tools[0].execute(
        'call-1',
        tools[0].prepareArguments({ops: [{op: 'get_tree'}]})
    )
    assert.deepEqual(calls, [{tool: 'godot_scene', params: {ops: [{op: 'get_tree'}]}}])
    assert.deepEqual(result.details, {nodes: []})
    assert.equal(createGodotTools(undefined, host).length, 0)
})

/**
 * The race this pins cost one live turn five of its seven refusals.
 *
 * Gemma wrote `godot_runtime stop` in the same assistant message as `godot_node connect_signal`
 * and `godot_scene save`, twice. Run concurrently, both mutations were answered `session_playing`
 * before the stop beside them had returned — by one millisecond, the second time — and the retry
 * that followed met `revision_conflict`, because by then half the batch had run.
 *
 * `godot_docs_search` is left out: it answers through a sidecar and a cache, holds nothing a
 * sibling call can disturb, and two of its searches at once is a case `ai-provider.test.mjs` still
 * proves.
 */
test('one editor is one caller at a time, before and after the wrappers', async () => {
    const host = {call: () => Promise.resolve({})}
    const ordered = tool => (tool.name === 'godot_docs_search' ? undefined : 'sequential')
    for (const tool of createGodotTools(catalog, host))
        assert.equal(tool.executionMode, ordered(tool), tool.name)

    // And the flag has to survive `decorateTools`, which rebuilds every tool three times over: a
    // wrapper that returned a fresh object would put the batch back in parallel without changing a
    // line of `godot-tools.mjs`.
    const {decorateTools} = await import('./agent-runtime.mjs')
    const decorated = decorateTools({
        env: {},
        tools: createGodotTools(catalog, host),
        model: {input: ['text']}
    })
    for (const tool of decorated) assert.equal(tool.executionMode, ordered(tool), tool.name)
})

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

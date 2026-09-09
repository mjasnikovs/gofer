import assert from 'node:assert/strict'
import test from 'node:test'
import {createGodotTools} from './godot-tools.mjs'
import {catalog} from './ai-turn-harness.mjs'

test('one tool carries the whole router catalog and forwards every call', async () => {
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
        ['godot']
    )
    const [godot] = tools
    assert.equal(godot.label, 'godot')
    assert.deepEqual(
        godot.parameters.properties.ops.items.oneOf.map(branch => branch.properties.op.const),
        ['scene.get_tree', 'scene.save', 'runtime.capture', 'resource.delete', 'docs_search.search']
    )
    assert.match(godot.description, /# scene — The edited scene\./u)
    assert.match(godot.description, /- scene\.get_tree: Returns the edited scene hierarchy\./u)
    assert.match(godot.description, /- docs_search\.search: Retrieves ranked passages/u)

    const result = await godot.execute(
        'call-1',
        godot.prepareArguments({ops: [{op: 'scene.get_tree'}, {op: 'runtime.capture'}]})
    )
    assert.deepEqual(calls, [
        {tool: 'godot', params: {ops: [{op: 'scene.get_tree'}, {op: 'runtime.capture'}]}}
    ])
    assert.deepEqual(result.details, {nodes: []})
    assert.equal(createGodotTools(undefined, host).length, 0)
    assert.equal(createGodotTools([], host).length, 0)
})

test('the narrowing sentences name dotted operations from every domain at once', () => {
    const [godot] = createGodotTools(
        [
            {
                name: 'godot_session',
                description: 'The session.',
                operations: [
                    {
                        op: 'undo',
                        summary: 'Undoes it.',
                        alone: {scope: 'repeat', why: 'One undo stack.'}
                    }
                ]
            },
            {
                name: 'godot_debug',
                description: 'The debuggee.',
                operations: [
                    {
                        op: 'continue',
                        summary: 'Resumes it.',
                        alone: {scope: 'exclusive', why: 'One debuggee.'}
                    },
                    {
                        op: 'pause',
                        summary: 'Pauses it.',
                        alone: {scope: 'repeat', why: 'One debuggee.'}
                    }
                ]
            }
        ],
        {call: async () => ({})}
    )
    const {description} = godot.parameters.properties.ops
    assert.match(description, /only entry of their call: debug\.continue\./u)
    assert.match(description, /may not appear twice: session\.undo, debug\.pause\./u)
})

test('one editor is one caller at a time, before and after the wrappers', async () => {
    const host = {call: () => Promise.resolve({})}
    for (const tool of createGodotTools(catalog, host))
        assert.equal(tool.executionMode, 'sequential', tool.name)

    const {decorateTools} = await import('./agent-runtime.mjs')
    const decorated = decorateTools({
        env: {},
        tools: createGodotTools(catalog, host),
        model: {input: ['text']}
    })
    for (const tool of decorated) assert.equal(tool.executionMode, 'sequential', tool.name)
})

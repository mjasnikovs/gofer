import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import test from 'node:test'
import {createGodotTools} from './godot-tools.mjs'
import {normalizeToolCalls} from './tool-call-repair.mjs'
import {declaredDomains} from './declared-domains.mjs'
import {validateToolArguments} from '@earendil-works/pi-ai'

const catalog = [
    {
        name: 'godot_scene',
        description: 'The edited scene.',
        operations: [
            {op: 'get_tree', summary: 'Returns the edited scene hierarchy.'},
            {op: 'save', summary: 'Saves the edited scene.'}
        ]
    },
    {
        name: 'godot_runtime',
        description: 'The running game.',
        operations: [{op: 'capture', summary: 'Captures a PNG frame.'}]
    },
    {
        name: 'godot_resource',
        description: 'Project resources.',
        operations: [{op: 'delete', summary: 'Deletes a resource. Asks the user first.'}]
    },
    {
        name: 'godot_docs_search',
        description: 'The Godot documentation on this machine.',
        operations: [{op: 'search', summary: 'Retrieves ranked passages: {question}.'}]
    }
]

test('a call the router repairs reaches it as the model wrote it', async () => {
    const recorded = JSON.parse(
        await readFile(new URL('../fixtures/recorded-tool-calls.json', import.meta.url), 'utf8')
    )
    const domains = await declaredDomains()
    assert.ok(recorded.repairs.length > 5, 'the fixture lost its repairs')
    for (const repair of recorded.repairs) {
        const domain = domains.find(candidate => candidate.name === repair.tool)
        assert.ok(domain, `${repair.tool} is recorded and is not advertised`)
        assert.equal(
            sortedKeys(normalizeToolCalls(domain.operations, {ops: repair.ops}).ops),
            sortedKeys(repair.ops),
            `${repair.tool} ${JSON.stringify(repair.ops).slice(0, 120)}`
        )
    }
})

function somethingOf(kind, param) {
    switch (kind) {
        case 'text':
            return 'a'
        case 'hash':
            return '0'.repeat(64)
        case 'int':
            return 1
        case 'number':
            return 1.5
        case 'flag':
            return true
        case 'list':
        case 'listOf':
            return []
        case 'object':
            return {}
        case 'tagged':
            return {type: 'int', value: 1}
        case 'choice':
            return param.of?.[0] ?? 'a'
        case 'either':
            return somethingOf(param.of?.[0]?.kind ?? 'text', param.of?.[0] ?? {})
        default:
            return 'a'
    }
}

function theLeastEntry(operation) {
    const entry = {op: operation.op}
    for (const param of operation.params ?? []) {
        if (!param.required || param.hidden) continue
        entry[param.name] =
            param.kind === 'list' && (param.entry ?? []).length > 0 ?
                [theLeastEntry({op: undefined, params: param.entry})]
            :   somethingOf(param.kind, param)
        if (param.kind === 'list' && (param.entry ?? []).length > 0) {
            delete entry[param.name][0].op
        }
    }
    return entry
}

/**
 * The line between the two engines is the schema's, and this computes it rather than reading it.
 *
 * The agent loop validates a call against the generated schema between `prepareArguments` and the
 * router, with this very function. A shape the schema refuses never reaches `tool_repair.rs`, so
 * only the worker can answer it. A shape it accepts is the router's, and a second copy of that
 * repair here is drift waiting to happen — which is exactly how a fix for the double-wrapped tag
 * came to exist only in JavaScript while both suites stayed green.
 *
 * Four rows were `both` when this was written. Every one of them was a pass in this file
 * reimplementing a repair the router already owned, and deleting it is what made them `router`.
 */
test("the line between the two engines is the schema's, not a column in the fixture", async () => {
    const fixture = JSON.parse(
        await readFile(new URL('../fixtures/tool-call-repairs.json', import.meta.url), 'utf8')
    )
    const domains = await declaredDomains()
    const tools = createGodotTools(domains, {call: async () => ({})})
    assert.ok(fixture.repairs.length > 10, 'the corpus lost its repairs')
    for (const row of fixture.repairs) {
        const tool = tools.find(one => one.name === row.tool)
        assert.ok(tool, `${row.tool} is in the corpus and is not advertised`)
        const accepted = schemaAccepts(tool, {ops: [{op: row.op, ...row.wrote}]})
        if (accepted) {
            assert.notEqual(
                row.repairedBy,
                'worker',
                `${row.why}: the schema lets this reach the router, so the router has to own it`
            )
            assert.notEqual(
                row.repairedBy,
                'both',
                `${row.why}: the router already repairs this, so the worker's copy is drift`
            )
            continue
        }
        assert.notEqual(
            row.repairedBy,
            'router',
            `${row.why}: the schema refuses this, so the router never sees it to repair it`
        )
    }
})

/** Whether the loop's own validator would let a call through to the router. */
function schemaAccepts(tool, args) {
    try {
        validateToolArguments(tool, {id: 'one', name: tool.name, arguments: args})
        return true
    } catch {
        return false
    }
}

test('a call the router would accept is never rewritten, for every operation', async () => {
    const domains = await declaredDomains()
    let asked = 0
    for (const domain of domains) {
        for (const operation of domain.operations) {
            const call = {ops: [theLeastEntry(operation)]}
            const written = sortedKeys(call)
            const once = normalizeToolCalls(domain.operations, structuredClone(call))
            assert.equal(
                sortedKeys(once),
                written,
                `${domain.name} ${operation.op} was rewritten though it was already right`
            )
            assert.equal(
                sortedKeys(normalizeToolCalls(domain.operations, structuredClone(once))),
                sortedKeys(once),
                `${domain.name} ${operation.op} does not settle: the repair moves its own output`
            )
            asked += 1
        }
    }
    assert.ok(asked > 100, `the catalogue has to be reached for this to mean anything: ${asked}`)
})

function sortedKeys(value) {
    return JSON.stringify(value, (key, held) =>
        held && typeof held === 'object' && !Array.isArray(held) ?
            Object.fromEntries(Object.entries(held).sort())
        :   held
    )
}

test('an operation this tool does not have is refused by name, with a signpost', () => {
    const tools = createGodotTools(catalog, {call: async () => ({})})
    const node = tools.find(tool => tool.name === 'godot_scene')
    assert.throws(
        () => node.prepareArguments({ops: [{op: 'get_tree'}, {op: 'capture'}]}),
        error => {
            assert.match(error.message, /no 'capture' operation/u)
            assert.match(error.message, /get_tree, save/u)
            assert.match(error.message, /godot_runtime/u)
            return true
        }
    )
})

test('an operation no tool has is refused without inventing a signpost', () => {
    const tools = createGodotTools(catalog, {call: async () => ({})})
    const scene = tools.find(tool => tool.name === 'godot_scene')
    assert.throws(
        () => scene.prepareArguments({ops: [{op: 'levitate'}]}),
        error => {
            assert.match(error.message, /no 'levitate' operation/u)
            assert.ok(!error.message.includes('is an operation of'), 'no signpost was invented')
            return true
        }
    )
})

test('a call naming only real operations is left alone', () => {
    const tools = createGodotTools(catalog, {call: async () => ({})})
    const scene = tools.find(tool => tool.name === 'godot_scene')
    assert.deepEqual(scene.prepareArguments({ops: [{op: 'get_tree'}, {op: 'save'}]}), {
        ops: [{op: 'get_tree'}, {op: 'save'}]
    })
})

test('a parameter belonging to a sibling operation is refused by name', async () => {
    const domains = await declaredDomains()
    const node = domains.find(domain => domain.name === 'godot_node')
    assert.throws(
        () =>
            normalizeToolCalls(node.operations, {
                ops: [{op: 'create', parent: '/Main', type: 'Node2D', nodes: ['Player']}]
            }),
        error => {
            assert.match(error.message, /create has no `nodes` parameter/u)
            assert.match(error.message, /is a parameter of create_nodes/u)
            return true
        }
    )
})

test('the refusal quotes the signature the operation was advertised under', () => {
    const operations = [
        {op: 'create', signature: '{parent: text}', params: [{name: 'parent', kind: 'text'}]},
        {
            op: 'create_nodes',
            signature: '{nodes: list of {parent: text}}',
            params: [{name: 'nodes', kind: 'list', entry: [{name: 'parent', kind: 'text'}]}]
        }
    ]
    assert.throws(
        () => normalizeToolCalls(operations, {ops: [{op: 'create', nodes: [{parent: '/Main'}]}]}),
        error => {
            assert.match(error.message, /It takes \{parent: text\}\./u)
            return true
        }
    )
})

test('a key more than one sibling declares is left for the router', async () => {
    const domains = await declaredDomains()
    const script = domains.find(domain => domain.name === 'godot_script')
    const call = {
        ops: [{op: 'edit', path: 'scripts/player.gd', files: [{path: 'a.gd', edits: []}]}]
    }
    assert.deepEqual(normalizeToolCalls(script.operations, call), call)
})

test('a sibling parameter with nothing inside it is left for the router', () => {
    const operations = [
        {op: 'stop', signature: '{}', params: []},
        {op: 'wait', signature: '{ms: int}', params: [{name: 'ms', kind: 'int'}]}
    ]
    const call = {ops: [{op: 'stop', ms: 20}]}
    assert.deepEqual(normalizeToolCalls(operations, call), call)
})

test('a key no operation declares is left for the router to refuse', async () => {
    const domains = await declaredDomains()
    const node = domains.find(domain => domain.name === 'godot_node')
    assert.deepEqual(
        normalizeToolCalls(node.operations, {ops: [{op: 'inspect', node: '/Main', depth: 2}]}),
        {ops: [{op: 'inspect', node: '/Main', depth: 2}]}
    )
})

test('an entry with nothing written into it does not take the batch with it', async () => {
    const domains = await declaredDomains()
    const runtime = domains.find(domain => domain.name === 'godot_runtime')
    assert.deepEqual(
        normalizeToolCalls(runtime.operations, {
            ops: [{}, {op: 'wait', ms: 2200}, {op: 'capture'}]
        }),
        {ops: [{op: 'wait', ms: 2200}, {op: 'capture'}]}
    )
})

test('a call with nothing in it at all is left exactly as it came', async () => {
    const domains = await declaredDomains()
    const runtime = domains.find(domain => domain.name === 'godot_runtime')
    assert.deepEqual(normalizeToolCalls(runtime.operations, {ops: [{}]}), {ops: [{}]})
})

test('a padded key that trims onto a real parameter is not refused as a stranger', async () => {
    const domains = await declaredDomains()
    const node = domains.find(domain => domain.name === 'godot_node')
    assert.deepEqual(
        normalizeToolCalls(node.operations, {ops: [{op: 'inspect', 'node ': '/Main'}]}),
        {ops: [{op: 'inspect', node: '/Main'}]}
    )
})

test('a single list entry written flat on the operation is folded into its list', async () => {
    const domains = await declaredDomains()
    const script = domains.find(domain => domain.name === 'godot_script')
    const repaired = normalizeToolCalls(script.operations, {
        ops: [
            {
                op: 'edit',
                path: 'scripts/player.gd',
                edits: [{oldText: 'var coins := 0', newText: 'var coins := 1'}]
            }
        ]
    })
    assert.deepEqual(repaired.ops[0], {
        op: 'edit',
        files: [
            {
                path: 'scripts/player.gd',
                edits: [{oldText: 'var coins := 0', newText: 'var coins := 1'}]
            }
        ]
    })
})

test('a flattened first file and a stray second one are folded into one list', async () => {
    const domains = await declaredDomains()
    const script = domains.find(domain => domain.name === 'godot_script')
    const repaired = normalizeToolCalls(script.operations, {
        ops: [
            {op: 'edit', path: 'a.gd', edits: [{oldText: '1', newText: '2'}]},
            {path: 'b.gd', edits: [{oldText: '3', newText: '4'}]}
        ]
    })
    assert.equal(repaired.ops.length, 1)
    assert.deepEqual(repaired.ops[0].files, [
        {path: 'a.gd', edits: [{oldText: '1', newText: '2'}]},
        {path: 'b.gd', edits: [{oldText: '3', newText: '4'}]}
    ])
})

test('an operation that declares its own parameters is not folded', async () => {
    const domains = await declaredDomains()
    const script = domains.find(domain => domain.name === 'godot_script')
    const written = {op: 'open', path: 'scripts/player.gd'}
    assert.deepEqual(normalizeToolCalls(script.operations, {ops: [written]}).ops[0], written)
})

test('a list that is already there is not given the operation as a second entry', async () => {
    const domains = await declaredDomains()
    const script = domains.find(domain => domain.name === 'godot_script')
    const written = {op: 'edit', files: [{path: 'a.gd', edits: []}]}
    assert.deepEqual(normalizeToolCalls(script.operations, {ops: [written]}).ops[0], written)
})

test('a resource written straight into a tagged value is put back inside it', async () => {
    const domains = await declaredDomains()
    const node = domains.find(domain => domain.name === 'godot_node')
    const repaired = normalizeToolCalls(node.operations, {
        ops: [
            {
                op: 'set_properties',
                properties: [
                    {
                        node: '/Coin',
                        property: 'script',
                        value: {type: 'resource', path: 'res://scripts/coin.gd'}
                    },
                    {
                        node: '/Coin/Sprite',
                        property: 'texture',
                        value: {type: 'resource', value: {path: 'res://assets/coin.png'}}
                    },
                    {node: '/Coin', property: 'position', value: {type: 'vector2', value: [8, 8]}}
                ]
            }
        ]
    })
    const [written, already, untagged] = repaired.ops[0].properties
    assert.deepEqual(written.value, {
        type: 'resource',
        value: {path: 'res://scripts/coin.gd'}
    })
    assert.deepEqual(already.value, {type: 'resource', value: {path: 'res://assets/coin.png'}})
    assert.deepEqual(untagged.value, {type: 'vector2', value: [8, 8]})
})

test('the same repair reaches a tagged value that is not inside a list', async () => {
    const domains = await declaredDomains()
    const node = domains.find(domain => domain.name === 'godot_node')
    const repaired = normalizeToolCalls(node.operations, {
        ops: [
            {
                op: 'set_property',
                node: '/Main/Player',
                property: 'script',
                value: {type: 'resource', path: 'res://scripts/player.gd'}
            }
        ]
    })
    assert.deepEqual(repaired.ops[0].value, {
        type: 'resource',
        value: {path: 'res://scripts/player.gd'}
    })
})

test('a resource tag carrying more than a path is left for the router to refuse', async () => {
    const domains = await declaredDomains()
    const node = domains.find(domain => domain.name === 'godot_node')
    const written = {type: 'resource', path: 'res://a.tres', subresource: 'Shape'}
    const repaired = normalizeToolCalls(node.operations, {
        ops: [{op: 'set_property', node: '/A', property: 'shape', value: written}]
    })
    assert.deepEqual(repaired.ops[0].value, written)
})

test('the wrapper a model got wrong is repaired rather than refused', () => {
    const script = [
        {op: 'open', params: [{name: 'path', kind: 'text', required: true}]},
        {
            op: 'edit',
            params: [
                {
                    name: 'files',
                    kind: 'list',
                    required: true,
                    entry: [
                        {name: 'path', kind: 'text', required: true},
                        {name: 'edits', kind: 'list', required: true}
                    ]
                }
            ]
        },
        {
            op: 'diagnostics',
            params: [
                {name: 'path', kind: 'text', required: true},
                {name: 'timeoutMs', kind: 'int', required: false}
            ]
        }
    ]
    const runtime = [
        {
            op: 'inspect_node',
            params: [
                {name: 'path', kind: 'text', required: true},
                {name: 'properties', kind: 'list', required: false}
            ]
        }
    ]

    assert.deepEqual(normalizeToolCalls(script, {ops: [{op: 'open', path: 'scripts/enemy.gd'}]}), {
        ops: [{path: 'scripts/enemy.gd', op: 'open'}]
    })

    assert.deepEqual(
        normalizeToolCalls(runtime, {
            ops: [{op: 'inspect_node', parameters: {path: '/root/Main/Game'}}]
        }),
        {ops: [{path: '/root/Main/Game', op: 'inspect_node'}]}
    )

    assert.deepEqual(
        normalizeToolCalls([{op: 'set', params: [{name: 'node'}, {name: 'expectedRevision'}]}], {
            ops: [{op: 'set', expectedRevision: 0, params: {node: '/Main'}}]
        }),
        {ops: [{expectedRevision: 0, node: '/Main', op: 'set'}]}
    )

    assert.deepEqual(normalizeToolCalls(script, {ops: [{op: 'open', file: 'scripts/enemy.gd'}]}), {
        ops: [{file: 'scripts/enemy.gd', op: 'open'}]
    })

    assert.deepEqual(
        normalizeToolCalls(script, {
            ops: [{op: 'open', thinking: 'now open it', params: {path: 'a.gd'}}]
        }),
        {ops: [{path: 'a.gd', op: 'open'}]}
    )

    assert.deepEqual(
        normalizeToolCalls(script, {ops: [{op: 'open', path: 'a.gd', params: {path: 'b.gd'}}]}),
        {ops: [{path: 'b.gd', op: 'open'}]}
    )

    assert.deepEqual(normalizeToolCalls(script, {op: 'open', path: 'a.gd'}), {
        ops: [{path: 'a.gd', op: 'open'}]
    })

    assert.deepEqual(normalizeToolCalls([script[0]], {ops: [{path: 'a.gd'}]}), {
        ops: [{path: 'a.gd', op: 'open'}]
    })

    assert.deepEqual(normalizeToolCalls(script, {ops: [{operation: 'open', path: 'a.gd'}]}), {
        ops: [{path: 'a.gd', op: 'open'}]
    })

    assert.deepEqual(
        normalizeToolCalls([{op: 'connect', params: [{name: 'method'}]}], {
            ops: [{op: 'connect', method: '_on_pressed'}]
        }),
        {ops: [{method: '_on_pressed', op: 'connect'}]}
    )

    assert.deepEqual(
        normalizeToolCalls(script, {
            ops: [
                {op: 'edit', files: [{path: 'a.gd', edits: [{oldText: 'x', newText: 'y'}]}]},
                {path: 'b.gd', edits: [{oldText: 'p', newText: 'q'}]},
                {path: 'c.gd', edits: [{oldText: 'm', newText: 'n'}]}
            ]
        }),
        {
            ops: [
                {
                    op: 'edit',
                    files: [
                        {path: 'a.gd', edits: [{oldText: 'x', newText: 'y'}]},
                        {path: 'b.gd', edits: [{oldText: 'p', newText: 'q'}]},
                        {path: 'c.gd', edits: [{oldText: 'm', newText: 'n'}]}
                    ]
                }
            ]
        }
    )

    assert.throws(
        () =>
            normalizeToolCalls(script, {
                ops: [
                    {op: 'edit', files: [{path: 'a.gd', edits: []}]},
                    {path: 'b.gd', text: 'extends Node'}
                ]
            }),
        /names no operation, and its keys — path and text —/su
    )

    assert.deepEqual(
        normalizeToolCalls(script, {
            ops: [
                {path: 'b.gd', edits: []},
                {op: 'open', path: 'a.gd'}
            ]
        }),
        {
            ops: [
                {op: 'edit', files: [{path: 'b.gd', edits: []}]},
                {path: 'a.gd', op: 'open'}
            ]
        }
    )

    assert.deepEqual(
        normalizeToolCalls(script, {
            ops: [
                {op: 'edit', files: [{path: 'a.gd', edits: []}]},
                {path: 'a.gd', timeoutMs: 5000}
            ]
        }),
        {
            ops: [
                {op: 'edit', files: [{path: 'a.gd', edits: []}]},
                {path: 'a.gd', timeoutMs: 5000, op: 'diagnostics'}
            ]
        }
    )

    assert.throws(
        () => normalizeToolCalls(script, {ops: [{path: 'a.gd'}, {path: 'b.gd'}]}),
        /open and diagnostics both take/su
    )
})

test('normalizing a recorded call changes nothing about what it says', async () => {
    const domains = await declaredDomains()
    const recorded = JSON.parse(
        await readFile(new URL('../fixtures/recorded-tool-calls.json', import.meta.url), 'utf8')
    )
    let checked = 0
    for (const recordedCase of recorded.cases) {
        const domain = domains.find(candidate => candidate.name === recordedCase.tool)
        assert.ok(domain, `${recordedCase.tool} is recorded and is not declared`)
        const normalized = normalizeToolCalls(domain.operations, {ops: recordedCase.ops})
        assert.equal(
            sortedKeys(normalized.ops),
            sortedKeys(recordedCase.ops),
            `${recordedCase.tool} ${JSON.stringify(recordedCase.ops.map(op => op.op))} was rewritten`
        )
        checked += 1
    }
    assert.ok(checked > 50, 'the fixture lost its cases')
})

test('a parameter set parked under an invented key is read as the wrapper it is', async () => {
    const domains = await declaredDomains()
    const project = domains.find(domain => domain.name === 'godot_project').operations
    const script = domains.find(domain => domain.name === 'godot_script').operations

    assert.deepEqual(
        normalizeToolCalls(project, {
            ops: [
                {
                    op: 'set_autoload',
                    enabled: true,
                    path: 'res://score.gd',
                    nameScore: {name: 'Score', path: 'res://score.gd'}
                }
            ]
        }),
        {ops: [{op: 'set_autoload', enabled: true, name: 'Score', path: 'res://score.gd'}]}
    )
    assert.deepEqual(
        normalizeToolCalls(project, {
            ops: [
                {
                    op: 'set_autoload',
                    enabled: true,
                    pathScore: {name: 'Score', path: 'res://score.gd'}
                }
            ]
        }),
        {ops: [{op: 'set_autoload', enabled: true, name: 'Score', path: 'res://score.gd'}]}
    )

    const complete = {
        op: 'save',
        path: 'a.gd',
        text: 'extends Node\n',
        note: {path: 'b.gd', text: 'other'}
    }
    assert.deepEqual(normalizeToolCalls(script, {ops: [complete]}), {ops: [complete]})

    const partial = {op: 'set_autoload', enabled: true, thinking: {name: 'Score'}}
    assert.deepEqual(normalizeToolCalls(project, {ops: [partial]}), {ops: [partial]})

    const extra = {op: 'set_autoload', held: {name: 'Score', path: 'a.gd', why: 'because'}}
    assert.deepEqual(normalizeToolCalls(project, {ops: [extra]}), {ops: [extra]})

    const both = {
        op: 'set_autoload',
        one: {name: 'Score', path: 'a.gd'},
        two: {name: 'Other', path: 'b.gd'}
    }
    assert.deepEqual(normalizeToolCalls(project, {ops: [both]}), {ops: [both]})
})

test('a tagged value whose keys wear quotation marks is read without them', async () => {
    const domains = await declaredDomains()
    const node = domains.find(domain => domain.name === 'godot_node').operations

    assert.deepEqual(
        normalizeToolCalls(node, {
            ops: [
                {
                    op: 'set_property',
                    node: '/HUD',
                    property: 'script',
                    value: {'"type"': 'resource', value: {'"path"': 'res://scripts/hud.gd'}}
                }
            ]
        }),
        {
            ops: [
                {
                    op: 'set_property',
                    node: '/HUD',
                    property: 'script',
                    value: {type: 'resource', value: {path: 'res://scripts/hud.gd'}}
                }
            ]
        }
    )

    assert.deepEqual(
        normalizeToolCalls(node, {
            ops: [
                {
                    op: 'set_properties',
                    properties: [
                        {
                            node: '/A',
                            property: 'position',
                            value: {'"type"': 'vector2', value: [1, 2]}
                        }
                    ]
                }
            ]
        }),
        {
            ops: [
                {
                    op: 'set_properties',
                    properties: [
                        {node: '/A', property: 'position', value: {type: 'vector2', value: [1, 2]}}
                    ]
                }
            ]
        }
    )

    const dictionary = {
        op: 'set_property',
        node: '/A',
        property: 'metadata',
        value: {
            type: 'dictionary',
            value: [{key: {type: 'string', value: '"quoted"'}, value: {type: 'int', value: 1}}]
        }
    }
    assert.deepEqual(normalizeToolCalls(node, {ops: [dictionary]}), {ops: [dictionary]})

    const both = {
        op: 'set_property',
        node: '/A',
        property: 'script',
        value: {'"type"': 'resource', type: 'texture', value: {path: 'res://a.png'}}
    }
    assert.deepEqual(normalizeToolCalls(node, {ops: [both]}), {ops: [both]})
})

test('a parameter named with whitespace around it is named without it', async () => {
    const domains = await declaredDomains()
    const node = domains.find(domain => domain.name === 'godot_node').operations

    assert.deepEqual(
        normalizeToolCalls(node, {
            ops: [
                {
                    op: 'connect_signal',
                    'node ': '/Coin',
                    'signal ': 'body_entered',
                    method: '_on_body_entered'
                }
            ]
        }),
        {
            ops: [
                {
                    op: 'connect_signal',
                    node: '/Coin',
                    signal: 'body_entered',
                    method: '_on_body_entered'
                }
            ]
        }
    )

    assert.deepEqual(
        normalizeToolCalls(node, {
            ops: [
                {
                    op: 'set_properties',
                    properties: [
                        {
                            ' node': '/Player',
                            property: 'visible',
                            value: {type: 'bool', value: true}
                        }
                    ]
                }
            ]
        }),
        {
            ops: [
                {
                    op: 'set_properties',
                    properties: [
                        {node: '/Player', property: 'visible', value: {type: 'bool', value: true}}
                    ]
                }
            ]
        }
    )

    assert.deepEqual(
        normalizeToolCalls(node, {ops: [{op: 'connect_signal', 'signaller ': '/Coin'}]}),
        {
            ops: [{op: 'connect_signal', 'signaller ': '/Coin'}]
        }
    )

    assert.deepEqual(
        normalizeToolCalls(node, {ops: [{op: 'connect_signal', node: '/Coin', 'node ': '/Other'}]}),
        {ops: [{op: 'connect_signal', node: '/Coin', 'node ': '/Other'}]}
    )

    const padded = {
        type: 'dictionary',
        value: [{key: {type: 'string', value: 'node '}, value: {type: 'int', value: 1}}]
    }
    assert.deepEqual(
        normalizeToolCalls(node, {
            ops: [{op: 'set_property', node: '/P', property: 'meta', value: padded}]
        }),
        {ops: [{op: 'set_property', node: '/P', property: 'meta', value: padded}]}
    )
})

test('a call is a list, and a bare operation is a list of one', async () => {
    const calls = []
    const host = {
        call: (tool, params) => {
            calls.push({tool, params})
            return Promise.resolve({passages: []})
        }
    }
    const [scene, , , docs] = createGodotTools(catalog, host)

    const drive = (tool, id, args) => tool.execute(id, tool.prepareArguments(args))

    await drive(docs, 'call-1', {
        ops: [{question: 'Camera2D shake'}, {question: 'TileMapLayer'}, {question: 'AnimationTree'}]
    })
    await drive(docs, 'call-2', {question: 'Camera2D shake'})
    await drive(docs, 'call-3', {op: 'search', params: {question: 'Camera2D shake'}})
    assert.deepEqual(
        calls.map(call => call.params),
        [
            {
                ops: [
                    {question: 'Camera2D shake', op: 'search'},
                    {question: 'TileMapLayer', op: 'search'},
                    {question: 'AnimationTree', op: 'search'}
                ]
            },
            {ops: [{question: 'Camera2D shake', op: 'search'}]},
            {ops: [{question: 'Camera2D shake', op: 'search'}]}
        ]
    )

    assert.deepEqual(scene.parameters.required, ['ops'])
    assert.deepEqual(docs.parameters.required, ['ops'])
})

test('a refused list says that none of it ran, and a refused single call does not', () => {
    const operations = [
        {op: 'create', signature: '{parent: text}', params: [{name: 'parent', kind: 'text'}]},
        {op: 'inspect', signature: '{node: text}', params: [{name: 'node', kind: 'text'}]}
    ]
    assert.throws(
        () =>
            normalizeToolCalls(operations, {
                ops: [{op: 'create', parent: '/Main'}, {op: 'save'}]
            }),
        error => {
            assert.match(error.message, /This tool has no 'save' operation/u)
            assert.match(error.message, /None of the 2 operations in this call ran\./u)
            assert.match(error.message, /send all 2 again with this one corrected/u)
            return true
        }
    )
    assert.throws(
        () => normalizeToolCalls(operations, {ops: [{op: 'save'}]}),
        error => {
            assert.doesNotMatch(error.message, /None of the/u)
            return true
        }
    )

    assert.throws(
        () =>
            normalizeToolCalls(operations, {
                ops: [{op: 'create', parent: '/Main'}, {op: 'save'}]
            }),
        error => {
            assert.match(error.message, /inspect\. None of the 2/u)
            assert.doesNotMatch(error.message, /\.\. None of/u)
            return true
        }
    )
})

test('an entry written as an operation name, and one written as its own list entry', () => {
    const runtime = [
        {op: 'wait', params: [{name: 'ms', kind: 'int'}]},
        {op: 'capture', params: []}
    ]
    assert.deepEqual(normalizeToolCalls(runtime, {ops: ['wait', {op: 'capture'}]}), {
        ops: [{op: 'wait'}, {op: 'capture'}]
    })

    assert.deepEqual(normalizeToolCalls(runtime, {ops: ['nonsense', {op: 'capture'}]}), {
        ops: [{}, {op: 'capture'}]
    })

    const script = [
        {
            op: 'edit',
            params: [
                {
                    name: 'files',
                    kind: 'list',
                    required: true,
                    entry: [
                        {name: 'path', kind: 'text', required: true},
                        {name: 'edits', kind: 'list', required: true, entry: [{name: 'oldText'}]}
                    ]
                }
            ]
        },
        {op: 'open', params: [{name: 'path', kind: 'text', required: true}]}
    ]
    const edits = [{oldText: 'a', newText: 'b'}]
    assert.deepEqual(normalizeToolCalls(script, {ops: [{path: 'scripts/player.gd', edits}]}), {
        ops: [{op: 'edit', files: [{path: 'scripts/player.gd', edits}]}]
    })

    assert.deepEqual(normalizeToolCalls(script, {ops: [{path: 'scripts/player.gd'}]}), {
        ops: [{op: 'open', path: 'scripts/player.gd'}]
    })
})

/**
 * A torn key that swallowed its own value is the router's, and the corpus proves it is left alone.
 *
 * This file used to split it too. The schema accepts a key no operation declares, so the call
 * reaches `tool_repair.rs` with the tear intact and the router repairs it there; a second
 * implementation here was a repair that could only drift. The four corpus rows it answered say
 * `router` now, and `the line between the two engines is the schema's` refuses a fifth.
 */
test('a list written as the text of itself is read as the list', () => {
    const resource = [
        {
            op: 'create_shape',
            params: [
                {name: 'path', kind: 'text'},
                {name: 'shapeType', kind: 'choice'},
                {name: 'size', kind: 'list'},
                {name: 'radius', kind: 'number'}
            ]
        }
    ]
    assert.deepEqual(
        normalizeToolCalls(resource, {
            ops: [
                {
                    op: 'create_shape',
                    path: 'a.tres',
                    shapeType: 'RectangleShape2D',
                    size: '[16, 32]'
                }
            ]
        }),
        {
            ops: [
                {op: 'create_shape', path: 'a.tres', shapeType: 'RectangleShape2D', size: [16, 32]}
            ]
        }
    )

    assert.deepEqual(
        normalizeToolCalls(resource, {
            ops: [{op: 'create_shape', path: '[16, 32]', shapeType: 'RectangleShape2D'}]
        }),
        {ops: [{op: 'create_shape', path: '[16, 32]', shapeType: 'RectangleShape2D'}]}
    )

    assert.deepEqual(
        normalizeToolCalls(resource, {
            ops: [{op: 'create_shape', path: 'a.tres', shapeType: 'CircleShape2D', size: '16'}]
        }),
        {ops: [{op: 'create_shape', path: 'a.tres', shapeType: 'CircleShape2D', size: '16'}]}
    )
})

test('a list written as text inside a declared entry is read there too', () => {
    const node = [
        {
            op: 'set_cells',
            params: [
                {name: 'node', kind: 'text'},
                {
                    name: 'cells',
                    kind: 'list',
                    entry: [
                        {name: 'x', kind: 'int'},
                        {name: 'y', kind: 'int'},
                        {name: 'atlas', kind: 'list'}
                    ]
                }
            ]
        }
    ]
    assert.deepEqual(
        normalizeToolCalls(node, {
            ops: [{op: 'set_cells', node: '/Main/Terrain', cells: [{x: 0, y: 1, atlas: '[2, 3]'}]}]
        }),
        {ops: [{op: 'set_cells', node: '/Main/Terrain', cells: [{x: 0, y: 1, atlas: [2, 3]}]}]}
    )
})

test('a list written as text is read under listOf and under either', () => {
    const wider = [
        {
            op: 'create_texture',
            params: [
                {name: 'path', kind: 'text'},
                {name: 'size', kind: 'either', of: [{kind: 'number'}, {kind: 'list'}]}
            ]
        },
        {
            op: 'inspect',
            params: [
                {name: 'node', kind: 'text'},
                {name: 'properties', kind: 'listOf', of: {kind: 'text'}}
            ]
        }
    ]
    assert.deepEqual(
        normalizeToolCalls(wider, {ops: [{op: 'create_texture', path: 'a.png', size: '[16, 24]'}]}),
        {ops: [{op: 'create_texture', path: 'a.png', size: [16, 24]}]}
    )
    assert.deepEqual(
        normalizeToolCalls(wider, {
            ops: [{op: 'inspect', node: '/Main', properties: '["text", "position"]'}]
        }),
        {ops: [{op: 'inspect', node: '/Main', properties: ['text', 'position']}]}
    )
    assert.deepEqual(
        normalizeToolCalls(wider, {ops: [{op: 'create_texture', path: 'a.png', size: 16}]}),
        {ops: [{op: 'create_texture', path: 'a.png', size: 16}]}
    )
})

test('an operation written as the key of its own parameters is read as the operation', async () => {
    const domains = await declaredDomains()
    const node = domains.find(domain => domain.name === 'godot_node').operations
    assert.deepEqual(
        normalizeToolCalls(node, {
            ops: [
                {create: {name: 'HUD', parent: '/Main', type: 'CanvasLayer'}},
                {create: {name: 'ScoreLabel', parent: '/Main/HUD', type: 'Label'}},
                {
                    set_property: {
                        node: '/Main/HUD',
                        property: 'script',
                        value: {type: 'resource', value: {path: 'res://scripts/hud.gd'}}
                    }
                }
            ]
        }),
        {
            ops: [
                {op: 'create', name: 'HUD', parent: '/Main', type: 'CanvasLayer'},
                {op: 'create', name: 'ScoreLabel', parent: '/Main/HUD', type: 'Label'},
                {
                    op: 'set_property',
                    node: '/Main/HUD',
                    property: 'script',
                    value: {type: 'resource', value: {path: 'res://scripts/hud.gd'}}
                }
            ]
        }
    )

    const script = domains.find(domain => domain.name === 'godot_script').operations
    const edits = [{oldText: 'extends Node\nclass_name GameState\n', newText: 'extends Node\n'}]
    assert.deepEqual(
        normalizeToolCalls(script, {ops: [{edit: {params: {files: [{path: 'a.gd', edits}]}}}]}),
        {ops: [{op: 'edit', files: [{path: 'a.gd', edits}]}]}
    )

    assert.throws(
        () => normalizeToolCalls(script, {ops: [{save: 'a.gd'}]}),
        /`save` is an operation of this tool: write it as `"op": "save"`/su
    )
    assert.throws(
        () => normalizeToolCalls(script, {ops: [{write: {path: 'a.gd'}}]}),
        /This tool's operations are: list, open/su
    )
    assert.throws(
        () => normalizeToolCalls(script, {ops: [{save: {path: 'a.gd'}, why: 'x'}]}),
        /its keys — save and why —.*`save` is an operation of this tool/su
    )

    const files = [{path: 'main.gd', edits: [{oldText: 'a', newText: 'b'}]}]
    assert.deepEqual(normalizeToolCalls(script, {ops: [{edit: {files, op: 'edit'}}]}), {
        ops: [{op: 'edit', files}]
    })
    assert.deepEqual(normalizeToolCalls(script, {ops: [{edit: {files, operation: 'edit'}}]}), {
        ops: [{op: 'edit', files}]
    })
})

test('no operation is named after a parameter of its own tool', async () => {
    for (const domain of await declaredDomains()) {
        const named = new Set(domain.operations.map(operation => operation.op))
        for (const operation of domain.operations) {
            for (const param of operation.params) {
                assert.ok(
                    !named.has(param.name),
                    `${domain.name} ${operation.op} takes a \`${param.name}\`, which is also an operation`
                )
            }
        }
    }
})

test('an entry that fits two operations is refused by naming both', async () => {
    const domains = await declaredDomains()
    const script = domains.find(domain => domain.name === 'godot_script').operations
    assert.throws(
        () => normalizeToolCalls(script, {ops: [{path: 'a.gd', text: 'extends Node\n'}]}),
        /names no operation.*update and save both take/su
    )

    const docs = domains.find(domain => domain.name === 'godot_docs_search').operations
    assert.throws(
        () => normalizeToolCalls(docs, {ops: [{question: 'Input.get_vector'}]}),
        /search and ask both take/su
    )

    assert.throws(
        () => normalizeToolCalls(script, {ops: [{nonsense: 1}]}),
        /its keys — nonsense — are not the parameters of any one operation.*operations are: list, open/su
    )
})

test('an operation written under a key that is not `op` is named where it sits', async () => {
    const domains = await declaredDomains()
    const script = domains.find(domain => domain.name === 'godot_script').operations

    assert.throws(
        () =>
            normalizeToolCalls(script, {
                ops: [{path: 'scripts/player.gd', text: 'extends Node2D\n', type: 'save'}]
            }),
        /`type` holds "save", which is an operation of this tool: write it as `"op": "save"`/su
    )

    assert.throws(
        () => normalizeToolCalls(script, {ops: [{was: 'open', now: 'save'}]}),
        /This tool's operations are: list, open/su
    )
})

test('an entry that fits more than two operations is named without being told which to pick', async () => {
    const domains = await declaredDomains()
    const script = domains.find(domain => domain.name === 'godot_script').operations
    assert.throws(
        () => normalizeToolCalls(script, {ops: [{path: 'a.gd', position: {line: 1, column: 1}}]}),
        error => {
            assert.match(
                error.message,
                /what hover, completion, signature_help, definition, declaration, references, highlights and prepare_rename all take/u
            )
            assert.match(error.message, /name the one you meant in `op`/u)
            assert.ok(!error.message.includes('both take'), 'eight operations do not "both" take')
            assert.ok(
                !/add `"op"/u.test(error.message),
                'the first of eight is not the one to suggest'
            )
            return true
        }
    )

    assert.throws(
        () => normalizeToolCalls(script, {ops: [{files: []}]}),
        /what edit and apply_rename both take.*add `"op": "edit"`/su
    )
})

test('the operation the key names survives whatever the object it wraps holds', async () => {
    const domains = await declaredDomains()
    const node = domains.find(domain => domain.name === 'godot_node').operations

    assert.deepEqual(normalizeToolCalls(node, {ops: [{create: {op: 7, parent: '/Main'}}]}), {
        ops: [{op: 'create', parent: '/Main'}]
    })
    assert.throws(
        () => normalizeToolCalls(node, {ops: [{create: {op: 'rename', parent: '/Main'}}]}),
        /`create` is an operation of this tool/su
    )
    assert.deepEqual(normalizeToolCalls(node, {ops: [{create: {op: 'create', parent: '/Main'}}]}), {
        ops: [{op: 'create', parent: '/Main'}]
    })
})

test('every repair in the shared corpus is made by the engine that owns it', async () => {
    const corpus = JSON.parse(
        await readFile(new URL('../fixtures/tool-call-repairs.json', import.meta.url), 'utf8')
    )
    const domains = await declaredDomains()
    assert.ok(corpus.repairs.length > 10, 'the corpus lost its repairs')

    for (const row of corpus.repairs) {
        const operations = domains.find(domain => domain.name === row.tool)?.operations
        assert.ok(operations, `${row.tool} is not a domain`)
        assert.ok(
            operations.some(operation => operation.op === row.op),
            `${row.tool} has no ${row.op} operation`
        )
        assert.ok(
            ['both', 'router', 'worker'].includes(row.repairedBy),
            `${row.why}: ${row.repairedBy} is not an engine`
        )
        const {op, ...ran} = normalizeToolCalls(operations, {
            ops: [{op: row.op, ...row.wrote}]
        }).ops[0]
        assert.equal(op, row.op, row.why)
        const wanted = row.repairedBy === 'router' ? row.wrote : row.becomes
        assert.deepEqual(ran, wanted, `${row.tool} ${row.op}: ${row.why}`)
    }
})

test('what the worker leaves for the router still passes the schema', async () => {
    const corpus = JSON.parse(
        await readFile(new URL('../fixtures/tool-call-repairs.json', import.meta.url), 'utf8')
    )
    const {default: Ajv} = await import('ajv')
    const ajv = new Ajv({strict: false, allErrors: true})
    const tools = new Map(
        createGodotTools(await declaredDomains(), {call: async () => ({})}).map(tool => [
            tool.name,
            tool
        ])
    )

    for (const row of corpus.repairs) {
        const tool = tools.get(row.tool)
        assert.ok(tool, `${row.tool} is not a tool`)
        const validate = ajv.compile(tool.parameters)
        const prepared = tool.prepareArguments({ops: [{op: row.op, ...row.wrote}]})
        assert.ok(
            validate(prepared),
            `${row.tool} ${row.op}: ${row.why} — the worker left a call the schema refuses: `
                + `${ajv.errorsText(validate.errors)}`
        )
        if (row.repairedBy !== 'worker') continue
        assert.ok(
            !validate({ops: [{op: row.op, ...row.wrote}]}),
            `${row.tool} ${row.op}: ${row.why} — the schema accepts this unrepaired, so the `
                + 'router could have answered it'
        )
    }
})

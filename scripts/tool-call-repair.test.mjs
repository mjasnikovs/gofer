import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import test from 'node:test'
import {createGodotTools, normalizeGodotCall} from './godot-tools.mjs'
import {normalizeToolCalls} from './tool-call-repair.mjs'
import {declaredDomains} from './declared-domains.mjs'
import {validateToolArguments} from '@earendil-works/pi-ai'

const dotted = (tool, op) => `${tool.replace(/^godot_/u, '')}.${op}`

const asOneCall = row => ({ops: [{op: dotted(row.tool, row.op), ...row.wrote}]})

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

/**
 * The raw form of every recorded repair is one the committed schema refuses, and the worker leaves
 * it exactly as the model wrote it.
 *
 * All nine wrote a tagged value wrapped in a second copy of its own tag. A repairing table in Rust
 * used to unwrap them behind the schema; the schema's `taggedValue` branches close the payload, so
 * the refusal now happens before any of it runs and there is nothing left to leave it alone for.
 * The far end — that the `repaired` form is a call the router accepts — is asserted in
 * `src-tauri/src/tool_check.rs`.
 */
test('the raw form of a recorded repair is refused by the schema, not rewritten', async () => {
    const recorded = JSON.parse(
        await readFile(new URL('../fixtures/recorded-tool-calls.json', import.meta.url), 'utf8')
    )
    const domains = await declaredDomains()
    const [godot] = createGodotTools(domains, {call: async () => ({})})
    assert.ok(recorded.repairs.length > 5, 'the fixture lost its repairs')
    for (const repair of recorded.repairs) {
        const domain = domains.find(candidate => candidate.name === repair.tool)
        assert.ok(domain, `${repair.tool} is recorded and is not advertised`)
        assert.equal(
            sortedKeys(normalizeToolCalls(domain.operations, {ops: repair.ops}).ops),
            sortedKeys(repair.ops),
            `${repair.tool} ${JSON.stringify(repair.ops).slice(0, 120)}`
        )
        const dottedOps = repair.ops.map(one => ({...one, op: dotted(repair.tool, one.op)}))
        assert.ok(
            !schemaAccepts(godot, {ops: dottedOps}),
            `${repair.tool}: the schema admits this again, so nothing refuses it`
        )
        assert.ok(
            schemaAccepts(godot, {
                ops: repair.repaired.map(one => ({...one, op: dotted(repair.tool, one.op)}))
            }),
            `${repair.tool}: the corrected call is one the schema refuses`
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
 * router, with this very function. Nothing behind that schema repairs anything any more, so every
 * row is one the schema refuses, and which engine owns it is decided by one question: whether the
 * worker's pass turns it into a call the schema accepts.
 */
test("the line between the two engines is the schema's, not a column in the fixture", async () => {
    const fixture = JSON.parse(
        await readFile(new URL('../fixtures/tool-call-repairs.json', import.meta.url), 'utf8')
    )
    const domains = await declaredDomains()
    const [godot] = createGodotTools(domains, {call: async () => ({})})
    assert.ok(fixture.repairs.length > 10, 'the corpus lost its repairs')
    for (const row of fixture.repairs) {
        assert.ok(
            !schemaAccepts(godot, asOneCall(row)),
            `${row.why}: the schema admits this, and nothing behind the schema repairs anything`
        )
        const repaired = godot.prepareArguments(asOneCall(row))
        const answered = schemaAccepts(godot, repaired)
        assert.equal(
            row.repairedBy,
            answered ? 'worker' : 'schema',
            `${row.why}: the worker ${answered ? 'answers' : 'leaves'} this`
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

// The tool the model holds hands the repairs one list of every operation, so a name that fits
// nothing in its own domain now has 110 siblings to be confused with.
test('a call the one tool would accept is never rewritten, for every dotted operation', async () => {
    const domains = await declaredDomains()
    const [godot] = createGodotTools(domains, {call: async () => ({})})
    let asked = 0
    for (const domain of domains) {
        for (const operation of domain.operations) {
            const entry = theLeastEntry(operation)
            const call = {ops: [{...entry, op: dotted(domain.name, entry.op)}]}
            const once = godot.prepareArguments(structuredClone(call))
            assert.equal(
                sortedKeys(once),
                sortedKeys(call),
                `${call.ops[0].op} was rewritten though it was already right`
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

test('an operation this domain does not have is refused by name, with a signpost', () => {
    assert.throws(
        () =>
            normalizeGodotCall(catalog, 'godot_scene', {ops: [{op: 'get_tree'}, {op: 'capture'}]}),
        error => {
            assert.match(error.message, /no 'capture' operation/u)
            assert.match(error.message, /get_tree, save/u)
            assert.match(error.message, /godot_runtime/u)
            return true
        }
    )
})

test('an operation no domain has is refused without inventing a signpost', () => {
    assert.throws(
        () => normalizeGodotCall(catalog, 'godot_scene', {ops: [{op: 'levitate'}]}),
        error => {
            assert.match(error.message, /no 'levitate' operation/u)
            assert.ok(!error.message.includes('is an operation of'), 'no signpost was invented')
            return true
        }
    )
})

test('a call naming only real operations is left alone', () => {
    const [godot] = createGodotTools(catalog, {call: async () => ({})})
    assert.deepEqual(
        godot.prepareArguments({ops: [{op: 'scene.get_tree'}, {op: 'runtime.capture'}]}),
        {ops: [{op: 'scene.get_tree'}, {op: 'runtime.capture'}]}
    )
    assert.deepEqual(normalizeGodotCall(catalog, 'godot_scene', {ops: [{op: 'save'}]}), {
        ops: [{op: 'save'}]
    })
})

test('a parameter belonging to a sibling operation is refused by name', async () => {
    const domains = await declaredDomains()
    const node = domains.find(domain => domain.name === 'godot_node')
    assert.throws(
        () =>
            normalizeToolCalls(node.operations, {
                ops: [{op: 'rename', node: '/Main/Old', name: 'New', nodes: ['Player']}]
            }),
        error => {
            assert.match(error.message, /rename has no `nodes` parameter/u)
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
                        value: {type: 'Resource', path: 'res://scripts/coin.gd'}
                    },
                    {
                        node: '/Coin/Sprite',
                        property: 'texture',
                        value: {type: 'Resource', value: {path: 'res://assets/coin.png'}}
                    },
                    {node: '/Coin', property: 'position', value: {type: 'Vector2', value: [8, 8]}}
                ]
            }
        ]
    })
    const [written, already, untagged] = repaired.ops[0].properties
    assert.deepEqual(written.value, {
        type: 'Resource',
        value: {path: 'res://scripts/coin.gd'}
    })
    assert.deepEqual(already.value, {type: 'Resource', value: {path: 'res://assets/coin.png'}})
    assert.deepEqual(untagged.value, {type: 'Vector2', value: [8, 8]})
})

test('the same repair reaches a tagged value that is not inside a list', async () => {
    const domains = await declaredDomains()
    const node = domains.find(domain => domain.name === 'godot_node')
    const repaired = normalizeToolCalls(node.operations, {
        ops: [
            {
                op: 'set_properties',
                properties: [
                    {
                        node: '/Main/Player',
                        property: 'script',
                        value: {type: 'Resource', path: 'res://scripts/player.gd'}
                    }
                ]
            }
        ]
    })
    assert.deepEqual(repaired.ops[0].properties[0].value, {
        type: 'Resource',
        value: {path: 'res://scripts/player.gd'}
    })
})

test('a resource tag carrying more than a path is left for the router to refuse', async () => {
    const domains = await declaredDomains()
    const node = domains.find(domain => domain.name === 'godot_node')
    const written = {type: 'Resource', path: 'res://a.tres', subresource: 'Shape'}
    const repaired = normalizeToolCalls(node.operations, {
        ops: [
            {
                op: 'set_properties',
                properties: [{node: '/A', property: 'shape', value: written}]
            }
        ]
    })
    assert.deepEqual(repaired.ops[0].properties[0].value, written)
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
                    op: 'set_properties',
                    properties: [
                        {
                            node: '/HUD',
                            property: 'script',
                            value: {
                                '"type"': 'Resource',
                                value: {'"path"': 'res://scripts/hud.gd'}
                            }
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
                        {
                            node: '/HUD',
                            property: 'script',
                            value: {type: 'Resource', value: {path: 'res://scripts/hud.gd'}}
                        }
                    ]
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
                            value: {'"type"': 'Vector2', value: [1, 2]}
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
                        {node: '/A', property: 'position', value: {type: 'Vector2', value: [1, 2]}}
                    ]
                }
            ]
        }
    )

    const dictionary = {
        op: 'set_properties',
        properties: [
            {
                node: '/A',
                property: 'metadata',
                value: {
                    type: 'Dictionary',
                    value: [
                        {key: {type: 'String', value: '"quoted"'}, value: {type: 'int', value: 1}}
                    ]
                }
            }
        ]
    }
    assert.deepEqual(normalizeToolCalls(node, {ops: [dictionary]}), {ops: [dictionary]})

    const both = {
        op: 'set_properties',
        properties: [
            {
                node: '/A',
                property: 'script',
                value: {'"type"': 'Resource', type: 'texture', value: {path: 'res://a.png'}}
            }
        ]
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
        type: 'Dictionary',
        value: [{key: {type: 'String', value: 'node '}, value: {type: 'int', value: 1}}]
    }
    const meta = {
        op: 'set_properties',
        properties: [{node: '/P', property: 'meta', value: padded}]
    }
    assert.deepEqual(normalizeToolCalls(node, {ops: [meta]}), {ops: [meta]})
})

test('a call is a list, and a bare operation is a list of one', async () => {
    const calls = []
    const host = {
        call: (tool, params) => {
            calls.push({tool, params})
            return Promise.resolve({passages: []})
        }
    }
    const [godot] = createGodotTools(catalog, host)

    const drive = (id, args) => godot.execute(id, godot.prepareArguments(args))

    await drive('call-1', {
        ops: [
            {op: 'docs_search.search', question: 'Camera2D shake'},
            {op: 'docs_search.search', question: 'TileMapLayer'},
            {op: 'scene.get_tree'}
        ]
    })
    await drive('call-2', {op: 'docs_search.search', question: 'Camera2D shake'})
    await drive('call-3', {op: 'docs_search.search', params: {question: 'Camera2D shake'}})
    assert.deepEqual(
        calls.map(call => call.params),
        [
            {
                ops: [
                    {question: 'Camera2D shake', op: 'docs_search.search'},
                    {question: 'TileMapLayer', op: 'docs_search.search'},
                    {op: 'scene.get_tree'}
                ]
            },
            {ops: [{question: 'Camera2D shake', op: 'docs_search.search'}]},
            {ops: [{question: 'Camera2D shake', op: 'docs_search.search'}]}
        ]
    )
    assert.deepEqual(
        calls.map(call => call.tool),
        ['godot', 'godot', 'godot']
    )

    assert.deepEqual(godot.parameters.required, ['ops'])
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
 * A list written as the JSON text of itself, at either level: the `ops` array, or one parameter
 * inside an entry.
 *
 * `ops` as a string is the shape `scripts/bench/repeats.mjs` names first — a provider that
 * stringifies a nested array leaves the whole call unreadable, and no entry schema can answer it
 * because nothing has parsed an entry yet.
 */
test('an ops list written as the text of itself is read as the list', async () => {
    const domains = await declaredDomains()
    const [godot] = createGodotTools(domains, {call: async () => ({})})
    // The parsed list is still the input to every pass below it, not a shortcut past them.
    assert.deepEqual(godot.prepareArguments({ops: '[{"operation": "session.status"}]'}), {
        ops: [{op: 'session.status'}]
    })
    // Text that parses into anything but a list is not read as one.
    assert.notDeepEqual(godot.prepareArguments({ops: '{"op": "session.status"}'}), {
        ops: [{op: 'session.status'}]
    })
})

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

test('a list written as text is read under list and under listOf', () => {
    const wider = [
        {
            op: 'create_shape',
            params: [
                {name: 'path', kind: 'text'},
                {name: 'size', kind: 'list'}
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
        normalizeToolCalls(wider, {ops: [{op: 'create_shape', path: 'a.tres', size: '[16, 24]'}]}),
        {ops: [{op: 'create_shape', path: 'a.tres', size: [16, 24]}]}
    )
    assert.deepEqual(
        normalizeToolCalls(wider, {
            ops: [{op: 'inspect', node: '/Main', properties: '["text", "position"]'}]
        }),
        {ops: [{op: 'inspect', node: '/Main', properties: ['text', 'position']}]}
    )
    assert.deepEqual(
        normalizeToolCalls(wider, {ops: [{op: 'create_shape', path: 'a.tres', size: 16}]}),
        {ops: [{op: 'create_shape', path: 'a.tres', size: 16}]}
    )
})

test('an operation written as the key of its own parameters is read as the operation', async () => {
    const domains = await declaredDomains()
    const node = domains.find(domain => domain.name === 'godot_node').operations
    assert.deepEqual(
        normalizeToolCalls(node, {
            ops: [
                {create_nodes: {nodes: [{name: 'HUD', parent: '/Main', type: 'CanvasLayer'}]}},
                {rename: {node: '/Main/HUD/Old', name: 'ScoreLabel'}},
                {
                    set_properties: {
                        properties: [
                            {
                                node: '/Main/HUD',
                                property: 'script',
                                value: {type: 'Resource', value: {path: 'res://scripts/hud.gd'}}
                            }
                        ]
                    }
                }
            ]
        }),
        {
            ops: [
                {op: 'create_nodes', nodes: [{name: 'HUD', parent: '/Main', type: 'CanvasLayer'}]},
                {op: 'rename', node: '/Main/HUD/Old', name: 'ScoreLabel'},
                {
                    op: 'set_properties',
                    properties: [
                        {
                            node: '/Main/HUD',
                            property: 'script',
                            value: {type: 'Resource', value: {path: 'res://scripts/hud.gd'}}
                        }
                    ]
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

    assert.deepEqual(normalizeToolCalls(node, {ops: [{create_nodes: {op: 7, nodes: []}}]}), {
        ops: [{op: 'create_nodes', nodes: []}]
    })
    assert.throws(
        () => normalizeToolCalls(node, {ops: [{create_nodes: {op: 'rename', nodes: []}}]}),
        /`create_nodes` is an operation of this tool/su
    )
    assert.deepEqual(
        normalizeToolCalls(node, {ops: [{create_nodes: {op: 'create_nodes', nodes: []}}]}),
        {ops: [{op: 'create_nodes', nodes: []}]}
    )
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
            ['schema', 'worker'].includes(row.repairedBy),
            `${row.why}: ${row.repairedBy} is not an engine`
        )
        const {op, ...ran} = normalizeToolCalls(operations, {
            ops: [{op: row.op, ...row.wrote}]
        }).ops[0]
        assert.equal(op, row.op, row.why)
        const wanted = row.repairedBy === 'schema' ? row.wrote : row.becomes
        assert.deepEqual(ran, wanted, `${row.tool} ${row.op}: ${row.why}`)
    }
})

test('what the worker leaves for the router still passes the schema', async () => {
    const corpus = JSON.parse(
        await readFile(new URL('../fixtures/tool-call-repairs.json', import.meta.url), 'utf8')
    )
    const {default: Ajv} = await import('ajv')
    const ajv = new Ajv({strict: false, allErrors: true})
    const [godot] = createGodotTools(await declaredDomains(), {call: async () => ({})})
    const validate = ajv.compile(godot.parameters)

    for (const row of corpus.repairs) {
        // A shape the schema refuses outright is written by neither engine's rules.
        if (row.repairedBy === 'schema') continue
        const prepared = godot.prepareArguments(asOneCall(row))
        assert.ok(
            validate(prepared),
            `${row.tool} ${row.op}: ${row.why} — the worker left a call the schema refuses: `
                + `${ajv.errorsText(validate.errors)}`
        )
        if (row.repairedBy !== 'worker') continue
        assert.ok(
            !validate(asOneCall(row)),
            `${row.tool} ${row.op}: ${row.why} — the schema accepts this unrepaired, so the `
                + 'router could have answered it'
        )
    }
})

import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import test from 'node:test'
import {createGodotTools} from './godot-tools.mjs'
import {normalizeToolCalls} from './tool-call-repair.mjs'

/** The four domains a repaired call is checked against, as the router would send them. */
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
    // The tool the reachability pass was written for: it answers through a sidecar and a model
    // cache, so it is the one that can be declared with nothing behind it.
    {
        name: 'godot_docs_search',
        description: 'The Godot documentation on this machine.',
        operations: [{op: 'search', summary: 'Retrieves ranked passages: {question}.'}]
    }
]

/**
 * The domains as `createGodotTools` receives them, built from the declared parameter contract.
 *
 * The real catalogue is serialized by the Rust crate, which merges prose from `ai_tools.rs` with
 * this file. Only the parameters and the narrowing reach the JSON schema — a summary is a sentence
 * in the description — so reading them here costs no cargo build, and `check:command-surface` is
 * what holds the two halves together.
 */
async function declaredDomains() {
    const {operations} = JSON.parse(
        await readFile(new URL('../protocol/schemas/v2/params.json', import.meta.url), 'utf8')
    )
    const domains = new Map()
    for (const entry of operations) {
        const operations = domains.get(entry.tool) ?? []
        operations.push({
            op: entry.op,
            summary: `${entry.op}.`,
            params: entry.params ?? [],
            alone: entry.alone ?? null
        })
        domains.set(entry.tool, operations)
    }
    return [...domains].map(([name, operations]) => ({name, description: name, operations}))
}

/**
 * The calls the router repairs reach it exactly as the model wrote them.
 *
 * The `repairs` half of the fixture is the calls a model wrote that the router would have refused
 * as written. All nine are the same one: a tagged value wrapped in a second copy of its own tag.
 * Across those five turns the model wrote 86 tagged values, 41 of them double-wrapped, and 22 of
 * the 41 spelled the inner tag with the engine's capital — `{type: "string", value: {type:
 * "String", …}}`.
 *
 * Unwrapping them is `tool_params::repair_tagged`'s, and
 * `every_shape_the_fixture_records_as_repaired_is_the_shape_the_router_accepts` is what proves the
 * `repaired` field beside each of these is the shape `check` accepts. It used to be proven here,
 * against this layer, which is how a fix for the 22 came to exist only in JavaScript: the router
 * looked its tags up case-sensitively, the acceptance suites call `dispatch` directly, and nothing
 * ran both halves.
 *
 * What is left for this layer is the other half of that split — that it hands the router the call
 * the model wrote, unchanged. Key order is not meaning, so the comparison is on sorted keys.
 */
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

/** One value written out with every object's keys in order, so key order is not a difference. */
function sortedKeys(value) {
    return JSON.stringify(value, (key, held) =>
        held && typeof held === 'object' && !Array.isArray(held) ?
            Object.fromEntries(Object.entries(held).sort())
        :   held
    )
}

// Every call below was written by a model in a recorded turn and refused. The op is real, the
// parameters are real, and only the wrapper was in the wrong place.
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

    // The parameter list flat beside the op, which is the shape the schema now asks for.
    assert.deepEqual(normalizeToolCalls(script, {ops: [{op: 'open', path: 'scripts/enemy.gd'}]}), {
        ops: [{path: 'scripts/enemy.gd', op: 'open'}]
    })

    // The wrapper under the name the prose uses.
    assert.deepEqual(
        normalizeToolCalls(runtime, {
            ops: [{op: 'inspect_node', parameters: {path: '/root/Main/Game'}}]
        }),
        {ops: [{path: '/root/Main/Game', op: 'inspect_node'}]}
    )

    // One parameter hoisted out of a wrapper that is otherwise right.
    assert.deepEqual(
        normalizeToolCalls([{op: 'set', params: [{name: 'node'}, {name: 'expectedRevision'}]}], {
            ops: [{op: 'set', expectedRevision: 0, params: {node: '/Main'}}]
        }),
        {ops: [{expectedRevision: 0, node: '/Main', op: 'set'}]}
    )

    // A key no parameter is named after reaches the router, which refuses it by name and offers
    // the near miss. Dropped here, the call would run without it and answer as if it had worked.
    assert.deepEqual(normalizeToolCalls(script, {ops: [{op: 'open', file: 'scripts/enemy.gd'}]}), {
        ops: [{file: 'scripts/enemy.gd', op: 'open'}]
    })

    // Unless a wrapper was written too, which is the shape the dropping was measured on: the
    // parameters in their wrapper, and something loose beside it that was never one of them.
    assert.deepEqual(
        normalizeToolCalls(script, {
            ops: [{op: 'open', thinking: 'now open it', params: {path: 'a.gd'}}]
        }),
        {ops: [{path: 'a.gd', op: 'open'}]}
    )

    // The wrapper as sent stays the wrapper, and it wins over a flat key of the same name.
    assert.deepEqual(
        normalizeToolCalls(script, {ops: [{op: 'open', path: 'a.gd', params: {path: 'b.gd'}}]}),
        {ops: [{path: 'b.gd', op: 'open'}]}
    )

    // No list at all: the previous shape, and what a model writes when it wants one thing. A list
    // of one rather than a refusal, because refusing it would spend a round trip teaching a bracket.
    assert.deepEqual(normalizeToolCalls(script, {op: 'open', path: 'a.gd'}), {
        ops: [{path: 'a.gd', op: 'open'}]
    })

    // A domain with one operation still does not need to be told which: there is only one, so a
    // call that omits `op` is not ambiguous.
    assert.deepEqual(normalizeToolCalls([script[0]], {ops: [{path: 'a.gd'}]}), {
        ops: [{path: 'a.gd', op: 'open'}]
    })

    // The operation under the word the prose uses. A live turn wrote this and was refused with four
    // `must not have additional properties` lines that never named the key it should have written.
    assert.deepEqual(normalizeToolCalls(script, {ops: [{operation: 'open', path: 'a.gd'}]}), {
        ops: [{path: 'a.gd', op: 'open'}]
    })

    // `method` is a real parameter on other operations, so it is never read as the operation.
    assert.deepEqual(
        normalizeToolCalls([{op: 'connect', params: [{name: 'method'}]}], {
            ops: [{op: 'connect', method: '_on_pressed'}]
        }),
        {ops: [{method: '_on_pressed', op: 'connect'}]}
    )

    // One list parameter split across the `ops` list. Recorded four times in one project, always
    // the same way: the first file inside a proper `edit` entry, and every file after it written
    // as a sibling of that entry instead of a sibling of the first file. Every one was refused
    // with `ops.1.op: must have required properties op` — a line that names neither the key that
    // is wrong nor the list it belonged in — and the largest of them lost six files at once.
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

    // A stray that does not fit the list is left where it is. The router names the operation it is
    // missing, which is a better sentence than a file folded into an edit it was never part of.
    assert.deepEqual(
        normalizeToolCalls(script, {
            ops: [
                {op: 'edit', files: [{path: 'a.gd', edits: []}]},
                {path: 'b.gd', text: 'extends Node'}
            ]
        }),
        {
            ops: [
                {op: 'edit', files: [{path: 'a.gd', edits: []}]},
                {path: 'b.gd', text: 'extends Node'}
            ]
        }
    )

    // Nothing to fold into, and no operation shaped like it: the first entry of a call is nobody's
    // stray, and a domain of several operations still cannot guess which one it meant.
    assert.deepEqual(
        normalizeToolCalls(script, {
            ops: [
                {path: 'b.gd', edits: []},
                {op: 'open', path: 'a.gd'}
            ]
        }),
        {
            ops: [
                {path: 'b.gd', edits: []},
                {path: 'a.gd', op: 'open'}
            ]
        }
    )

    // The parameters written without the operation they belong to. The fifth recorded refusal was
    // an `edit` followed by four of these, and `{path, timeoutMs}` is a pair only `diagnostics`
    // takes — so the operation is not a guess, it is the only one the keys fit.
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

    // A pair of operations the same keys fit is still a guess, and is left for the router to name.
    assert.deepEqual(normalizeToolCalls(script, {ops: [{path: 'a.gd'}, {path: 'b.gd'}]}), {
        ops: [{path: 'a.gd'}, {path: 'b.gd'}]
    })
})

// The tagged value a model wrapped twice. One live turn against a local Qwen3.6-27B sent 51 of
// these in 114 tool calls, and every one was refused by a sentence that named the shape it wanted
// and never noticed that the shape it wanted was sitting inside the one it got.
/**
 * Every repair in this layer leaves a call that was already right alone.
 *
 * The repairs are all "a model wrote this shape and meant that one", and each one is a licence to
 * rewrite a call nobody is watching. This is the other half of that: the 93 distinct shapes sixteen
 * real tasks produced, normalized against the declared contract, must come back meaning the same
 * thing. Key order is not meaning — `op` moves to the end — so the comparison is on sorted keys.
 */
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

    // What one live turn wrote, twice, then once more with the other parameter's name glued on.
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

    // A call already carrying every required parameter keeps its stray key, and the refusal that
    // names it: a model that wrote a whole wrapper deliberately did not also write them flat.
    const complete = {
        op: 'save',
        path: 'a.gd',
        text: 'extends Node\n',
        note: {path: 'b.gd', text: 'other'}
    }
    assert.deepEqual(normalizeToolCalls(script, {ops: [complete]}), {ops: [complete]})

    // An object that does not hold every required parameter is not the parameter set.
    const partial = {op: 'set_autoload', enabled: true, thinking: {name: 'Score'}}
    assert.deepEqual(normalizeToolCalls(project, {ops: [partial]}), {ops: [partial]})

    // An object holding a key no parameter is named after is not it either.
    const extra = {op: 'set_autoload', held: {name: 'Score', path: 'a.gd', why: 'because'}}
    assert.deepEqual(normalizeToolCalls(project, {ops: [extra]}), {ops: [extra]})

    // Two that fit make it a guess, and a guess is left for the router to refuse by name.
    const both = {
        op: 'set_autoload',
        one: {name: 'Score', path: 'a.gd'},
        two: {name: 'Other', path: 'b.gd'}
    }
    assert.deepEqual(normalizeToolCalls(project, {ops: [both]}), {ops: [both]})
})

test('a parameter named with whitespace around it is named without it', async () => {
    // The real declared contract, not a fixture: the shapes below are what a live turn wrote, and
    // what makes them repairable is the parameter list the router will hold them to.
    const domains = await declaredDomains()
    const node = domains.find(domain => domain.name === 'godot_node').operations

    // Three times in one turn, the same call resent unchanged after being refused by name.
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

    // Inside a list parameter's entries, which is the position the router cannot repair for
    // itself: a nested entry's schema is closed and requires its own names, so a padded key
    // there is refused by the agent loop before `tool_params::repair` is ever called.
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

    // A padded key the operation does not declare is left where it is, for the router to refuse by
    // name — trimming it would invent a parameter and be refused for that instead.
    assert.deepEqual(
        normalizeToolCalls(node, {ops: [{op: 'connect_signal', 'signaller ': '/Coin'}]}),
        {
            ops: [{op: 'connect_signal', 'signaller ': '/Coin'}]
        }
    )

    // A padded key beside the real one is left alone too: the entry already carries the name, and
    // the model wrote the unpadded one deliberately.
    assert.deepEqual(
        normalizeToolCalls(node, {ops: [{op: 'connect_signal', node: '/Coin', 'node ': '/Other'}]}),
        {ops: [{op: 'connect_signal', node: '/Coin', 'node ': '/Other'}]}
    )

    // A dictionary payload's keys are the caller's own, and the walk stops at a tagged value rather
    // than reaching into one.
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

    // As the agent loop drives it: arguments are prepared, then validated against the schema, then
    // executed. Repair that happened after validation would already have been refused.
    const drive = (tool, id, args) => tool.execute(id, tool.prepareArguments(args))

    // Three questions in one call, which is the whole reason the list exists. Sent one at a time,
    // each would be a turn of its own waiting on the one before it.
    await drive(docs, 'call-1', {
        ops: [{question: 'Camera2D shake'}, {question: 'TileMapLayer'}, {question: 'AnimationTree'}]
    })
    // The op is the only one there is, so an entry that omits it is not ambiguous — and a call with
    // no list at all is the one a model writes when it reads the operation line and nothing else.
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

    // Every tool asks for the list, whatever it holds.
    assert.deepEqual(scene.parameters.required, ['ops'])
    assert.deepEqual(docs.parameters.required, ['ops'])
})

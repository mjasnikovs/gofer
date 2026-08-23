import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import test from 'node:test'
import Ajv from 'ajv'
import {createGodotTools} from './godot-tools.mjs'
import {signatureOf} from './tool-schema.mjs'

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
 * The two narrowings read differently, and neither one caps the list.
 *
 * `godot_session` used to advertise a list of exactly one, because all seven of its operations were
 * marked alone. The mark meant two different things, and the schema said the stricter of them about
 * both: a live project wrote `[stop, start]` and `[get_state, answer_dialog]` and was refused, for
 * ordinary two-step requests the router walks in order. Only the debugger is exclusive now.
 */
test('an exclusive operation and a once-only operation are advertised apart', () => {
    const session = [
        {
            op: 'status',
            summary: 'Reports the session state.',
            alone: {scope: 'repeat', why: 'It takes no parameters.'}
        },
        {
            op: 'undo',
            summary: 'Undoes the last operation.',
            alone: {scope: 'repeat', why: 'One undo stack, walked in order.'}
        }
    ]
    const debug = [
        {op: 'threads', summary: 'Lists the threads.', alone: null},
        {
            op: 'continue',
            summary: 'Resumes the debuggee.',
            alone: {scope: 'exclusive', why: 'One debuggee, driven in order.'}
        }
    ]
    const [owned, driven] = createGodotTools(
        [
            {name: 'godot_session', description: 'd', operations: session},
            {name: 'godot_debug', description: 'd', operations: debug}
        ],
        {call: async () => ({})}
    )

    // Nothing is capped: a list of two different operations is what `ops` is for.
    assert.equal(owned.parameters.properties.ops.maxItems, undefined)
    assert.equal(driven.parameters.properties.ops.maxItems, undefined)

    // A repeat operation is named as one that may not appear twice, never as one that must be alone.
    assert.match(owned.parameters.properties.ops.description, /may not appear twice: status, undo/u)
    assert.doesNotMatch(owned.parameters.properties.ops.description, /only entry of their call/u)
    assert.match(owned.description, /not twice in one call: It takes no parameters\./u)

    // An exclusive one keeps the stronger sentence, and only it.
    assert.match(
        driven.parameters.properties.ops.description,
        /only entry of their call: continue/u
    )
    assert.doesNotMatch(driven.parameters.properties.ops.description, /may not appear twice/u)
    assert.match(driven.description, /only entry of its call: One debuggee, driven in order\./u)
})

/**
 * Every distinct `ops` shape a model wrote across real work validates against the schema.
 *
 * `fixtures/recorded-tool-calls.json` is 712 calls from a live project reduced to their distinct
 * operation lists, and 178 more from five live turns against a real editor. The Rust gate has its
 * own pass over the same file; this one is the layer above it, where the agent loop refuses a call
 * before the router ever sees it.
 */
test('every recorded ops shape validates against the advertised schema', async () => {
    const recorded = JSON.parse(
        await readFile(new URL('../fixtures/recorded-tool-calls.json', import.meta.url), 'utf8')
    )
    const tools = createGodotTools(await declaredDomains(), {call: async () => ({})})
    const validate = new Ajv({strict: false, allErrors: true})
    let checked = 0
    for (const recordedCase of recorded.cases) {
        const tool = tools.find(candidate => candidate.name === recordedCase.tool)
        assert.ok(tool, `${recordedCase.tool} is recorded and is not advertised`)
        const check = validate.compile(tool.parameters)
        assert.ok(
            check({ops: recordedCase.ops}),
            `${recordedCase.tool} ${JSON.stringify(recordedCase.ops.map(op => op.op))}: ${validate.errorsText(check.errors)}`
        )
        checked += 1
    }
    assert.ok(checked > 50, 'the fixture lost its cases')
})

/**
 * The entry schema is one object per domain, not one branch per operation.
 *
 * Measured, not preferred. Branching per `op` refuses a call by reporting every branch it did not
 * match — a `godot_script save` missing its `text` came back as eight lines, two of them `must be
 * equal to constant` about operations the caller never named. `if`/`then` reports one line, and it
 * is `must match "then" schema`, naming neither parameter nor operation. So the types are enforced
 * here, where an error is about one named key, and which parameters belong to which operation is
 * enforced by `tool_params::check`, which names the parameter and prints the corrected call.
 */
test('the entry schema types every parameter and leaves the rest to the router', () => {
    const domain = [
        {
            op: 'save',
            summary: 'Writes a whole file.',
            params: [
                {name: 'path', kind: 'text', required: true, entry: []},
                {name: 'text', kind: 'text', required: true, entry: []},
                {name: 'expectedHash', kind: 'hash', required: false, entry: []}
            ]
        },
        {
            op: 'diagnostics',
            summary: 'Diagnostics for a file.',
            params: [
                {
                    name: 'path',
                    kind: 'either',
                    of: [{kind: 'text'}, {kind: 'list'}],
                    required: true,
                    entry: []
                },
                {name: 'timeoutMs', kind: 'int', required: false, entry: []}
            ]
        }
    ]
    const [tool] = createGodotTools(
        [{name: 'godot_script', description: 'd', operations: domain}],
        {
            call: async () => ({})
        }
    )
    const entry = tool.parameters.properties.ops.items

    // Every kind is a real JSON type, which is the whole reason this schema is generated.
    assert.deepEqual(entry.properties.text, {type: 'string'})
    assert.deepEqual(entry.properties.timeoutMs, {type: 'integer'})
    assert.deepEqual(entry.properties.expectedHash, {
        type: 'string',
        pattern: '^[0-9a-f]{64}$'
    })
    // Two operations, two shapes for one name: the entry accepts either and the router decides.
    assert.deepEqual(entry.properties.path, {anyOf: [{type: 'string'}, {type: 'array'}]})

    // Only `op` is required here. A missing parameter is the router's to name.
    assert.deepEqual(entry.required, ['op'])
    assert.deepEqual(entry.properties.op.enum, ['save', 'diagnostics'])
    assert.equal(entry.additionalProperties, true)
})

/**
 * The signature reads in front of the summary, and an operation with no table has none.
 *
 * It is generated in Rust from the same parameter list that refuses a call, so what the model is
 * told and what the router accepts cannot drift apart. Absence is "not written down yet", never
 * "takes nothing", so an operation with no table reads exactly as it did before rather than being
 * quietly advertised as parameterless.
 */
test('the signature is a leading space and a shape, or nothing at all', () => {
    assert.equal(
        signatureOf({op: 'save', signature: '{path: text, text: text}'}),
        ' {path: text, text: text}'
    )
    assert.equal(signatureOf({op: 'reload'}), '')
    assert.equal(signatureOf({op: 'reload', signature: ''}), '')

    const [tool] = createGodotTools(
        [
            {
                name: 'godot_scene',
                description: 'The edited scene.',
                operations: [
                    {op: 'save', summary: 'Saves it.', signature: '{path?: text}'},
                    {op: 'reload', summary: 'Reloads it.'}
                ]
            }
        ],
        {call: async () => ({})}
    )
    assert.match(tool.description, /- save \{path\?: text\}: Saves it\./u)
    assert.match(tool.description, /- reload: Reloads it\./u)
})

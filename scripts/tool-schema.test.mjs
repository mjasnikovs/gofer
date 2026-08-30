import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import test from 'node:test'
import Ajv from 'ajv'
import {createGodotTools} from './godot-tools.mjs'
import {signatureOf} from './tool-schema.mjs'
import {declaredDomains} from './declared-domains.mjs'

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

    assert.equal(owned.parameters.properties.ops.maxItems, undefined)
    assert.equal(driven.parameters.properties.ops.maxItems, undefined)

    assert.match(owned.parameters.properties.ops.description, /may not appear twice: status, undo/u)
    assert.doesNotMatch(owned.parameters.properties.ops.description, /only entry of their call/u)
    assert.match(owned.description, /not twice in one call: It takes no parameters\./u)

    assert.match(
        driven.parameters.properties.ops.description,
        /only entry of their call: continue/u
    )
    assert.doesNotMatch(driven.parameters.properties.ops.description, /may not appear twice/u)
    assert.match(driven.description, /only entry of its call: One debuggee, driven in order\./u)
})

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

    assert.deepEqual(entry.properties.text, {type: 'string'})
    assert.deepEqual(entry.properties.timeoutMs, {type: 'integer'})
    assert.deepEqual(entry.properties.expectedHash, {
        type: 'string',
        pattern: '^[0-9a-f]{64}$'
    })
    assert.deepEqual(entry.properties.path, {anyOf: [{type: 'string'}, {type: 'array'}]})

    assert.deepEqual(entry.required, ['op'])
    assert.deepEqual(entry.properties.op.enum, ['save', 'diagnostics'])
    assert.equal(entry.additionalProperties, true)
})

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

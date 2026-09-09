import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import test from 'node:test'
import Ajv from 'ajv'
import {createGodotTools} from './godot-tools.mjs'
import {signatureOf} from './tool-schema.mjs'
import {declaredDomains} from './declared-domains.mjs'

const dotted = (tool, op) => `${tool.replace(/^godot_/u, '')}.${op}`

const branches = tool => tool.parameters.properties.ops.items.oneOf

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
    const [godot] = createGodotTools(
        [
            {name: 'godot_session', description: 'd', operations: session},
            {name: 'godot_debug', description: 'd', operations: debug}
        ],
        {call: async () => ({})}
    )

    assert.equal(godot.parameters.properties.ops.maxItems, undefined)

    // Both narrowings span every domain, because the list the router applies them to does.
    assert.match(
        godot.parameters.properties.ops.description,
        /may not appear twice: session\.status, session\.undo/u
    )
    assert.match(
        godot.parameters.properties.ops.description,
        /only entry of their call: debug\.continue/u
    )
    assert.match(godot.description, /not twice in one call: It takes no parameters\./u)
    assert.match(godot.description, /only entry of its call: One debuggee, driven in order\./u)
})

test('every recorded ops shape validates against the advertised schema', async () => {
    const recorded = JSON.parse(
        await readFile(new URL('../fixtures/recorded-tool-calls.json', import.meta.url), 'utf8')
    )
    const [godot] = createGodotTools(await declaredDomains(), {call: async () => ({})})
    const validate = new Ajv({strict: false, allErrors: true})
    const check = validate.compile(godot.parameters)
    let checked = 0
    for (const recordedCase of recorded.cases) {
        const ops = recordedCase.ops.map(one => ({...one, op: dotted(recordedCase.tool, one.op)}))
        assert.ok(
            check({ops}),
            `${recordedCase.tool} ${JSON.stringify(ops.map(one => one.op))}: ${validate.errorsText(check.errors)}`
        )
        checked += 1
    }
    assert.ok(checked > 50, 'the fixture lost its cases')
})

test('the entry schema types every parameter and pins it to its own operation', () => {
    const domain = [
        {
            op: 'save',
            summary: 'Writes a whole file.',
            params: [
                {name: 'path', kind: 'text', required: true, entry: []},
                {name: 'text', kind: 'text', required: true, entry: []},
                {name: 'expectedHash', kind: 'hash', required: false, entry: []},
                {name: 'expectedRevision', kind: 'int', required: false, hidden: true, entry: []}
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
    const [save, diagnostics] = branches(tool)

    assert.deepEqual(save.properties.text, {type: 'string'})
    assert.deepEqual(save.properties.expectedHash, {
        type: 'string',
        pattern: '^[0-9a-f]{64}$'
    })
    assert.deepEqual(save.properties.path, {type: 'string'})
    assert.deepEqual(save.properties.op, {const: 'script.save'})
    assert.deepEqual(save.required, ['op', 'path', 'text'])
    assert.equal(save.additionalProperties, false)
    assert.equal(save.properties.expectedRevision, undefined)

    assert.deepEqual(diagnostics.properties.timeoutMs, {type: 'integer'})
    assert.deepEqual(diagnostics.properties.path, {anyOf: [{type: 'string'}, {type: 'array'}]})
    assert.deepEqual(diagnostics.required, ['op', 'path'])
    assert.deepEqual(diagnostics.properties.op, {const: 'script.diagnostics'})

    // save's own shape for `path`, not the union of both operations' shapes
    assert.equal(save.properties.timeoutMs, undefined)
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
    assert.match(tool.description, /# scene — The edited scene\./u)
    assert.match(tool.description, /- scene\.save \{path\?: text\}: Saves it\./u)
    assert.match(tool.description, /- scene\.reload: Reloads it\./u)
})

test('the entry schema refuses an operation missing a parameter the router requires', async () => {
    const domains = await declaredDomains()
    const [godot] = createGodotTools(domains, {call: async () => ({})})
    const validate = new Ajv({strict: false, allErrors: true})
    const check = validate.compile(godot.parameters)
    const admitted = []
    for (const domain of domains) {
        for (const operation of domain.operations) {
            const required = (operation.params ?? []).filter(param => param.required)
            if (required.length === 0) continue
            const op = dotted(domain.name, operation.op)
            if (check({ops: [{op}]})) admitted.push(op)
        }
    }
    assert.deepEqual(
        admitted,
        [],
        `these operations advertise their parameters as optional, so a bare {"op": …} is a legal call the router then refuses: ${admitted.join(', ')}`
    )
})

test('the entry schema refuses a key that belongs to another operation', async () => {
    const domains = await declaredDomains()
    const [godot] = createGodotTools(domains, {call: async () => ({})})
    const validate = new Ajv({strict: false, allErrors: true})
    const check = validate.compile(godot.parameters)
    const admitted = []
    for (const domain of domains) {
        for (const operation of domain.operations) {
            const mine = new Set((operation.params ?? []).map(param => param.name))
            const theirs = domain.operations
                .filter(other => other.op !== operation.op)
                .flatMap(other => (other.params ?? []).map(param => param.name))
                .find(name => !mine.has(name))
            if (!theirs) continue
            const entry = Object.fromEntries([
                ['op', dotted(domain.name, operation.op)],
                ...(operation.params ?? [])
                    .filter(param => param.required)
                    .map(param => [param.name, 'x']),
                [theirs, 'x']
            ])
            if (check({ops: [entry]})) admitted.push(`${entry.op}+${theirs}`)
        }
    }
    assert.deepEqual(
        admitted,
        [],
        `these operations admit a parameter that is not theirs: ${admitted.slice(0, 8).join(', ')} (${admitted.length} total)`
    )
})

test('the schema offers no key the router fills in, and repeats no summary', async () => {
    const domains = await declaredDomains()
    const [godot] = createGodotTools(domains, {call: async () => ({})})
    const walked = branches(godot)
    let hidden = 0
    let index = 0
    for (const domain of domains) {
        for (const operation of domain.operations) {
            const branch = walked[index]
            index += 1
            assert.deepEqual(branch.properties.op, {const: dotted(domain.name, operation.op)})
            for (const param of (operation.params ?? []).filter(param => param.hidden)) {
                assert.equal(
                    branch.properties[param.name],
                    undefined,
                    `${domain.name}.${operation.op} offers \`${param.name}\``
                )
                hidden += 1
            }
        }
    }
    assert.ok(hidden > 30, 'the catalogue lost its hidden parameters')
})

test('one branch per operation of every domain, each pinned to a name no other branch has', async () => {
    const domains = await declaredDomains()
    const [godot] = createGodotTools(domains, {call: async () => ({})})
    const consts = branches(godot).map(branch => branch.properties.op.const)

    assert.equal(
        consts.length,
        domains.reduce((total, domain) => total + domain.operations.length, 0)
    )
    assert.equal(new Set(consts).size, consts.length)
    assert.ok(
        consts.every(name => /^[a-z_]+\.[a-z_]+$/u.test(name)),
        `these are not dotted operation names: ${consts.filter(name => !name.includes('.')).join(', ')}`
    )
})

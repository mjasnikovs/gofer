// Four tool SURFACE shapes over one catalog. Per-op strict parameter schemas everywhere (arm C
// style: no op.description, the summary lives once in the tool description).
import {readFile, writeFile} from 'node:fs/promises'
import {jsonSchemaOfParams, signatureOf} from './tool-schema-2026-09-09.mjs'

const S = process.env.SCRATCH ?? import.meta.dirname
const catalog = JSON.parse(await readFile(`${S}/catalog.json`, 'utf8'))
const shipped = JSON.parse(await readFile(`${S}/shapes-tools-C.json`, 'utf8'))
const extras = shipped.filter(t => !t.name.startsWith('godot_'))

const short = name => name.replace(/^godot_/u, '')
const dotted = (domain, op) => `${short(domain.name)}.${op}`

const branch = (operation, opConst) => {
    const body = jsonSchemaOfParams(operation.params ?? [])
    return {
        type: 'object',
        properties: {op: {const: opConst}, ...body.properties},
        required: ['op', ...body.required],
        additionalProperties: false
    }
}

const lineOf = (operation, label) => {
    const narrowing =
        operation.alone?.scope === 'exclusive' ? ` (only entry of its call: ${operation.alone.why})`
        : operation.alone ? ` (not twice in one call: ${operation.alone.why})`
        : ''
    return `- ${label}${signatureOf(operation)}: ${operation.summary}${narrowing}`
}

const OPS_NOTE =
    'The operations to run, in order, each with its parameters beside its `op`. One operation is'
    + ' a list of one; several run in this one call rather than one call each.'

const opsProperty = (operations, labelOf, items) => {
    const exclusive = operations.filter(o => o.alone?.scope === 'exclusive')
    const atMostOnce = operations.filter(o => o.alone?.scope === 'repeat')
    return {
        type: 'array',
        minItems: 1,
        description:
            OPS_NOTE
            + (exclusive.length > 0 ?
                ` These have to be the only entry of their call: ${exclusive.map(labelOf).join(', ')}.`
            :   '')
            + (atMostOnce.length > 0 ?
                ` These may sit beside others and may not appear twice: ${atMostOnce.map(labelOf).join(', ')}.`
            :   ''),
        items
    }
}

// ---- S1: as shipped. 10 domain tools, ops array, per-op oneOf. (arm C)
const S1 = shipped

// ---- S2: one `godot` tool, ops array, 110 branches keyed by a dotted op const.
const everyOp = catalog.flatMap(d => d.operations.map(o => ({domain: d, operation: o})))
const S2 = [
    {
        name: 'godot',
        description:
            'Everything Gofer can do inside the open Godot editor. Every operation is named'
            + ' `domain.op` and goes in the `ops` list as its `op`, with its parameters beside it.\n'
            + catalog
                .map(
                    d =>
                        `# ${short(d.name)} — ${d.description}\nOperations:\n${d.operations
                            .map(o => lineOf(o, dotted(d, o.op)))
                            .join('\n')}`
                )
                .join('\n\n'),
        parameters: {
            type: 'object',
            properties: {
                ops: opsProperty(
                    everyOp.map(e => ({...e.operation, _label: dotted(e.domain, e.operation.op)})),
                    o => o._label,
                    {oneOf: everyOp.map(e => branch(e.operation, dotted(e.domain, e.operation.op)))}
                )
            },
            required: ['ops']
        }
    },
    ...extras
]

// ---- S3: 110 flat tools. params are that op's schema at top level, no `op`, no `ops`.
const S3 = [
    ...everyOp.map(({domain, operation}) => ({
        name: `${domain.name}_${operation.op}`,
        description: `${domain.description}\n${operation.summary}`,
        parameters: jsonSchemaOfParams(operation.params ?? [])
    })),
    ...extras
]

// ---- S4: 10 domain tools, no ops array. One call is one operation: {op, ...params}.
const S4 = [
    ...catalog.map(domain => ({
        name: domain.name,
        description:
            `${domain.description}\nOne call is one operation: put its name in \`op\` and its`
            + ` parameters beside it.\nOperations:\n${domain.operations.map(o => lineOf(o, o.op)).join('\n')}`,
        parameters: {oneOf: domain.operations.map(o => branch(o, o.op))}
    })),
    ...extras
]

// ---- S4b: S4's surface with the oneOf one level down, where llama.cpp does constrain it. The
// only way to ask whether dropping the array costs anything without also dropping the grammar.
const S4b = [
    ...catalog.map(domain => ({
        name: domain.name,
        description:
            `${domain.description}\nOne call is one operation: put it in \`operation\`, its name in`
            + ` \`op\` and its parameters beside it.\nOperations:\n${domain.operations.map(o => lineOf(o, o.op)).join('\n')}`,
        parameters: {
            type: 'object',
            properties: {operation: {oneOf: domain.operations.map(o => branch(o, o.op))}},
            required: ['operation'],
            additionalProperties: false
        }
    })),
    ...extras
]

const ARMS = {S1, S2, S3, S4, S4b}
for (const [arm, tools] of Object.entries(ARMS)) {
    await writeFile(`${S}/surf-tools-${arm}.json`, JSON.stringify(tools, null, 2))
    console.log(
        arm,
        'tools',
        tools.length,
        'godot',
        tools.length - extras.length,
        'bytes',
        JSON.stringify(tools).length
    )
}
await writeFile(
    `${S}/surf-map.json`,
    JSON.stringify(
        {
            flat: Object.fromEntries(
                everyOp.map(({domain, operation}) => [
                    `${domain.name}_${operation.op}`,
                    [domain.name, operation.op]
                ])
            ),
            dot: Object.fromEntries(
                everyOp.map(({domain, operation}) => [
                    dotted(domain, operation.op),
                    [domain.name, operation.op]
                ])
            )
        },
        null,
        2
    )
)
console.log('extras', extras.map(t => t.name).join(', '))

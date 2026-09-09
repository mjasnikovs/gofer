// The S2 surface — one `godot` tool, an ops array, one oneOf branch per dotted op — built from
// whatever catalogue it is handed, so an arm is a catalogue transform and nothing else.
import {readFile} from 'node:fs/promises'
import {jsonSchemaOfParams, signatureOf} from '../tool-schema.mjs'

const S = process.env.SCRATCH ?? import.meta.dirname
const shipped = JSON.parse(await readFile(`${S}/shapes-tools-C.json`, 'utf8'))
export const EXTRAS = shipped.filter(t => !t.name.startsWith('godot_'))

export const short = name => name.replace(/^godot_/u, '')
export const dotted = (domain, op) => `${short(domain.name)}.${op}`

const branch = (operation, opConst) => {
    const body = jsonSchemaOfParams(operation.params ?? [])
    return {
        type: 'object',
        properties: {op: {const: opConst}, ...body.properties},
        required: ['op', ...body.required],
        additionalProperties: false
    }
}

const lineOf = (operation, label, summaryOf) => {
    const narrowing =
        operation.alone?.scope === 'exclusive' ? ` (only entry of its call: ${operation.alone.why})`
        : operation.alone ? ` (not twice in one call: ${operation.alone.why})`
        : ''
    const summary = summaryOf(operation)
    return `- ${label}${signatureOf(operation)}${summary ? `: ${summary}` : ''}${narrowing}`
}

const OPS_NOTE =
    'The operations to run, in order, each with its parameters beside its `op`. One operation is'
    + ' a list of one; several run in this one call rather than one call each.'

export function buildS2(catalog, {summaryOf = o => o.summary} = {}) {
    const everyOp = catalog.flatMap(d => d.operations.map(o => ({domain: d, operation: o})))
    const exclusive = everyOp.filter(e => e.operation.alone?.scope === 'exclusive')
    const atMostOnce = everyOp.filter(e => e.operation.alone?.scope === 'repeat')
    const label = e => dotted(e.domain, e.operation.op)
    return [
        {
            name: 'godot',
            description:
                'Everything Gofer can do inside the open Godot editor. Every operation is named'
                + ' `domain.op` and goes in the `ops` list as its `op`, with its parameters beside it.\n'
                + catalog
                    .map(
                        d =>
                            `# ${short(d.name)} — ${d.description}\nOperations:\n${d.operations
                                .map(o => lineOf(o, dotted(d, o.op), summaryOf))
                                .join('\n')}`
                    )
                    .join('\n\n'),
            parameters: {
                type: 'object',
                properties: {
                    ops: {
                        type: 'array',
                        minItems: 1,
                        description:
                            OPS_NOTE
                            + (exclusive.length > 0 ?
                                ` These have to be the only entry of their call: ${exclusive.map(label).join(', ')}.`
                            :   '')
                            + (atMostOnce.length > 0 ?
                                ` These may sit beside others and may not appear twice: ${atMostOnce.map(label).join(', ')}.`
                            :   ''),
                        items: {oneOf: everyOp.map(e => branch(e.operation, label(e)))}
                    }
                },
                required: ['ops']
            }
        },
        ...EXTRAS
    ]
}

/** The branch for one dotted op inside a built S2 tool list. */
export const branchOf = (tools, op) =>
    tools
        .find(t => t.name === 'godot')
        .parameters.properties.ops.items.oneOf.find(b => b.properties.op.const === op)

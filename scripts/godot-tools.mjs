import {normalizeToolCalls} from './tool-call-repair.mjs'
import {toolResult} from './tool-result.mjs'
import {jsonSchemaOfEntry, signatureOf, taggedValueDefs} from './tool-schema.mjs'

export const GODOT_TOOL_NAME = 'godot'

const short = name => name.replace(/^godot_/u, '')

const elsewhereIn = domains => op =>
    domains
        .filter(other => other.operations.some(operation => operation.op === op))
        .map(other => other.name)

/// Ten tools became one, so there is no sibling tool to point an unknown operation at.
const noOtherTool = () => []

const dottedIn = domain =>
    domain.operations.map(operation => ({
        ...operation,
        op: `${short(domain.name)}.${operation.op}`
    }))

const dottedOperations = domains => domains.flatMap(dottedIn)

const narrowingOf = operation =>
    operation.alone?.scope === 'exclusive' ? ` (only entry of its call: ${operation.alone.why})`
    : operation.alone ? ` (not twice in one call: ${operation.alone.why})`
    : ''

const lineOf = operation =>
    `- ${operation.op}${signatureOf(operation)}`
    + `${operation.summary ? `: ${operation.summary}` : ''}${narrowingOf(operation)}`

const OPENING =
    'Everything Gofer can do inside the open Godot editor. Every operation is named'
    + ' `domain.op` and goes in the `ops` list as its `op`, with its parameters beside it.\n'

const OPS_NOTE =
    'The operations to run, in order, each with its parameters beside its `op`. One operation is'
    + ' a list of one; several run in this one call rather than one call each.'

/// A call written by hand rather than by the model — a verification point — takes the same
/// repairs. A wrapper shape the repair layer fixes must not fail here and pass there.
export function normalizeGodotCall(domains, name, args) {
    const declared = Array.isArray(domains) ? domains : []
    if (name === GODOT_TOOL_NAME)
        return normalizeToolCalls(dottedOperations(declared), args, noOtherTool)
    const found = declared.find(domain => domain.name === name)
    if (!found) return args
    return normalizeToolCalls(found.operations, args, elsewhereIn(declared))
}

export function createGodotTools(domains, host) {
    if (!Array.isArray(domains) || domains.length === 0) return []
    const operations = dottedOperations(domains)
    const exclusive = operations.filter(operation => operation.alone?.scope === 'exclusive')
    const atMostOnce = operations.filter(operation => operation.alone?.scope === 'repeat')
    return [
        {
            name: GODOT_TOOL_NAME,
            label: GODOT_TOOL_NAME,
            executionMode: 'sequential',
            description:
                OPENING
                + domains
                    .map(
                        domain =>
                            `# ${short(domain.name)} — ${domain.description}\nOperations:\n`
                            + dottedIn(domain).map(lineOf).join('\n')
                    )
                    .join('\n\n'),
            parameters: {
                type: 'object',
                // The tagged value's 36 branches, named once and pointed at from each of the three
                // parameters that take one. See `TAGGED_VALUE_REF`.
                ...(taggedValueDefs(operations) ? {$defs: taggedValueDefs(operations)} : {}),
                properties: {
                    ops: {
                        type: 'array',
                        minItems: 1,
                        description:
                            OPS_NOTE
                            + (exclusive.length > 0 ?
                                ` These have to be the only entry of their call: ${exclusive
                                    .map(operation => operation.op)
                                    .join(', ')}.`
                            :   '')
                            + (atMostOnce.length > 0 ?
                                ` These may sit beside others and may not appear twice: ${atMostOnce
                                    .map(operation => operation.op)
                                    .join(', ')}.`
                            :   ''),
                        items: jsonSchemaOfEntry(operations)
                    }
                },
                required: ['ops']
            },
            prepareArguments: args => normalizeToolCalls(operations, args, noOtherTool),
            execute: async (_toolCallId, args, signal) =>
                toolResult(await host.call(GODOT_TOOL_NAME, args, signal))
        }
    ]
}

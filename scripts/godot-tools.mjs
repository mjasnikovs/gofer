import {normalizeToolCalls} from './tool-call-repair.mjs'
import {toolResult} from './tool-result.mjs'
import {jsonSchemaOfEntry, signatureOf} from './tool-schema.mjs'

export function createGodotTools(domains, host) {
    if (!Array.isArray(domains)) return []
    const elsewhere = op =>
        domains
            .filter(other => other.operations.some(operation => operation.op === op))
            .map(other => other.name)
    return domains.map(domain => {
        const exclusive = domain.operations.filter(
            operation => operation.alone?.scope === 'exclusive'
        )
        const atMostOnce = domain.operations.filter(
            operation => operation.alone?.scope === 'repeat'
        )
        return {
            name: domain.name,
            label: domain.name.replace(/_/gu, ' '),
            ...(domain.name === 'godot_docs_search' ? {} : {executionMode: 'sequential'}),
            description: `${domain.description}\nOperations:\n${domain.operations
                .map(operation => {
                    const narrowing =
                        operation.alone?.scope === 'exclusive' ?
                            ` (only entry of its call: ${operation.alone.why})`
                        : operation.alone ? ` (not twice in one call: ${operation.alone.why})`
                        : ''
                    return `- ${operation.op}${signatureOf(operation)}: ${operation.summary}${narrowing}`
                })
                .join('\n')}`,
            parameters: {
                type: 'object',
                properties: {
                    ops: {
                        type: 'array',
                        minItems: 1,
                        description:
                            'The operations to run, in order, each with its parameters beside'
                            + ' its `op`. One operation is a list of one; several run in this'
                            + ' one call rather than one call each.'
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
                        items: jsonSchemaOfEntry(domain.operations)
                    }
                },
                required: ['ops']
            },
            prepareArguments: args => normalizeToolCalls(domain.operations, args, elsewhere),
            execute: async (_toolCallId, args, signal) => {
                const result = await host.call(domain.name, args, signal)
                return toolResult(result)
            }
        }
    })
}

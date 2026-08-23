/**
 * One agent tool per domain of the catalog Rust sent.
 *
 * This is where the three layers beside it meet: the schema a call is advertised and validated
 * under, the repair that runs between validation and the call, and the budgeting the answer comes
 * back through. Nothing here implements a Godot operation — `src-tauri/src/ai_tools.rs` routes
 * every one of them.
 */
import {normalizeToolCalls} from './tool-call-repair.mjs'
import {toolResult} from './tool-result.mjs'
import {jsonSchemaOfEntry, signatureOf} from './tool-schema.mjs'

/**
 * Builds one agent tool per domain in the catalog Rust sent. The operations are the router's, so a
 * tool the model can call always has a handler and one it cannot call never does.
 *
 * Every call is an `ops` list, including a call of one operation. Ten live sweeps recorded the
 * model calling one operation per turn and waiting for each — three inspections of three nodes as
 * three turns — and never once emitting parallel tool calls of its own, though the harness runs
 * them in parallel when it does. A list is what makes the batch reachable without asking the model
 * to choose between two shapes on every call.
 *
 * Parameters sit beside `op` rather than under a wrapper, because flat is what models write
 * unprompted: nine of the twenty-four miswritten calls counted across four projects were flat
 * against a schema that asked for a wrapper. Everything else they get wrong is repaired by
 * [`normalizeToolCalls`].
 */
export function createGodotTools(domains, host) {
    if (!Array.isArray(domains)) return []
    return domains.map(domain => {
        // Two narrowings, and they read differently to a caller. `exclusive` is an operation that
        // cannot share a call at all; `repeat` is one that may sit beside anything and may not
        // appear twice. Naming them together as "alone" is what produced ten refusals across ten
        // of sixteen live tasks, every one of them a two-step list the router could already run.
        const exclusive = domain.operations.filter(
            operation => operation.alone?.scope === 'exclusive'
        )
        const atMostOnce = domain.operations.filter(
            operation => operation.alone?.scope === 'repeat'
        )
        return {
            name: domain.name,
            label: domain.name.replace(/_/gu, ' '),
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
            // Repair runs here rather than inside `execute`, because the agent loop validates the
            // arguments against the schema above in between, and a call reshaped after that point
            // has already been refused. `prepareArguments` is the one hook that runs before it: a
            // model that wrote the parameters under a wrapper now passes validation instead of
            // spending a round trip on a bracket.
            prepareArguments: args => normalizeToolCalls(domain.operations, args),
            execute: async (_toolCallId, args, signal) => {
                const result = await host.call(domain.name, args, signal)
                return toolResult(result)
            }
        }
    })
}

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
    // Which other tools have an operation, so a call sent to the wrong one is told where it lives
    // rather than only that it is not here. See `refuseUnknownOperation`.
    const elsewhere = op =>
        domains
            .filter(other => other.operations.some(operation => operation.op === op))
            .map(other => other.name)
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
            // One editor, one running game, one edited scene — so two of these at once is two
            // callers mutating one thing, and the loop's default is to run an assistant message's
            // tool calls concurrently.
            //
            // Measured on 2026-08-27: one Gemma turn wrote `godot_runtime stop` beside
            // `godot_node connect_signal` and `godot_scene save`, twice. Both mutations were
            // refused `session_playing` before the stop they were sent with had returned — one
            // millisecond before it, the second time — and the retry that followed met
            // `revision_conflict`, because by then half the batch had run. Five of that turn's
            // seven refusals were this race, and not one of its parameters was wrong.
            //
            // Ordering has to be across domains, because that is where the race was: `stop` is
            // `godot_runtime`'s and `save` is `godot_scene`'s. Pi runs a whole assistant message
            // sequentially as soon as one tool in it says so, so declaring it here is enough.
            //
            // `godot_docs_search` is the one domain that does not, and it is the same exception
            // `ai_tools::probe` names: the other nine route to the editor session, the debug
            // adapter or the log buffer, and this one answers through a sidecar and a model cache
            // that hold no state a sibling call can disturb. Two searches in one message stay
            // concurrent, which is what they were.
            //
            // This flag is not a property of one tool, and that is deliberate rather than
            // overlooked: one tool in an assistant message carrying it makes the loop run the
            // *whole* message one call at a time. It was replaced with a queue inside `execute`
            // once, to stop a `subagent` waiting behind a scene read, and put back when the
            // recorded batches were read. Of the 88 messages that put a godot call beside a tool
            // that is not one, 21 were `write`, `edit` or `bash` — and those bash calls are
            // `godot --headless --import` and a Python script writing PNGs, which is a second
            // engine and a file the editor call beside it is about to read. The remaining 38 were
            // `subagent`, and a child holds `read` and `bash` of its own, so it mutates the same
            // checkout. Ordering the whole message is what keeps all of that behind one caller.
            // The latency is the price, and it is the smaller of the two.
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
            // Repair runs here rather than inside `execute`, because the agent loop validates the
            // arguments against the schema above in between, and a call reshaped after that point
            // has already been refused. `prepareArguments` is the one hook that runs before it: a
            // model that wrote the parameters under a wrapper now passes validation instead of
            // spending a round trip on a bracket.
            prepareArguments: args => normalizeToolCalls(domain.operations, args, elsewhere),
            execute: async (_toolCallId, args, signal) => {
                const result = await host.call(domain.name, args, signal)
                return toolResult(result)
            }
        }
    })
}

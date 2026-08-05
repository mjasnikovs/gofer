/**
 * The worker's half of the duplex channel to Rust.
 *
 * Rust sends the startup context as the first stdin line and then answers tool requests on the
 * same stream; the worker writes agent events and tool requests to stdout, each on its own line
 * behind its own prefix so unprefixed diagnostics stay diagnostics. Nothing here implements a
 * Godot operation: every tool call is forwarded, and the router in `src-tauri/src/ai_tools.rs` is
 * the only place an operation exists.
 */

/** Beyond this, a tool result is summarized for the model. Details keep the whole value. */
const MAX_TOOL_TEXT_CHARS = 24_000

export const EVENT_PREFIX = 'GOFER_AI_EVENT:'
export const TOOL_PREFIX = 'GOFER_AI_TOOL:'

/**
 * Correlates outgoing tool requests with the results Rust sends back.
 *
 * A pending call is settled exactly once — by a result, by the caller's AbortSignal, or by the
 * channel closing — because an agent turn that ends with a promise nobody will ever resolve hangs
 * the worker instead of failing it.
 */
export function createToolHost(send) {
    const pending = new Map()
    let nextId = 0
    let closed
    return {
        call(tool, params, signal) {
            return new Promise((resolve, reject) => {
                if (closed) return reject(new Error(closed))
                if (signal?.aborted) return reject(new Error('The tool call was cancelled'))
                const id = `call-${String((nextId += 1))}`
                const settle = outcome => {
                    if (!pending.delete(id)) return
                    if (outcome.ok) resolve(outcome.result)
                    else reject(outcome.error)
                }
                pending.set(id, settle)
                signal?.addEventListener(
                    'abort',
                    () => settle({ok: false, error: new Error('The tool call was cancelled')}),
                    {once: true}
                )
                // A write that throws — a closed stdout — must fail this call rather than leave a
                // promise the backend can no longer answer.
                try {
                    send({id, tool, params})
                } catch (error) {
                    settle({ok: false, error})
                }
            })
        },
        deliver(message) {
            if (!message || message.type !== 'tool-result') return
            const settle = pending.get(String(message.id))
            if (!settle) return
            if (message.ok) return settle({ok: true, result: message.result})
            const error = message.error ?? {}
            settle({
                ok: false,
                error: new Error(
                    `${error.code ?? 'tool_failed'}: ${error.message ?? 'The tool call failed'}`
                )
            })
        },
        close(reason) {
            closed = reason
            for (const settle of [...pending.values()])
                settle({ok: false, error: new Error(reason)})
        },
        get pendingCount() {
            return pending.size
        }
    }
}

/**
 * Builds one agent tool per domain in the catalog Rust sent. The operations are the router's, so a
 * tool the model can call always has a handler and one it cannot call never does.
 */
export function createGodotTools(domains, host) {
    if (!Array.isArray(domains)) return []
    return domains.map(domain => ({
        name: domain.name,
        label: domain.name.replace(/_/gu, ' '),
        description: `${domain.description}\nOperations:\n${domain.operations
            .map(operation => `- ${operation.op}: ${operation.summary}`)
            .join('\n')}`,
        parameters: {
            type: 'object',
            properties: {
                op: {
                    type: 'string',
                    enum: domain.operations.map(operation => operation.op),
                    description: 'The operation to run.'
                },
                params: {
                    type: 'object',
                    description: 'Parameters for the operation, as named in its summary.',
                    additionalProperties: true
                }
            },
            required: ['op']
        },
        execute: async (_toolCallId, {op, params}, signal) => {
            const result = await host.call(domain.name, {op, params: params ?? {}}, signal)
            return toolResult(result)
        }
    }))
}

/**
 * Turns a tool result into model-visible content. A captured frame becomes a real image part —
 * base64 PNG in a text blob is worth nothing to the model and would swamp the context — and the
 * remaining JSON is bounded, because a scene tree is allowed to be large.
 */
export function toolResult(result) {
    const frame = result?.frame
    const image =
        frame?.encoding === 'png-base64' && typeof frame.data === 'string' ?
            {type: 'image', data: frame.data, mimeType: 'image/png'}
        :   undefined
    const described =
        image ?
            {...result, frame: {encoding: frame.encoding, width: frame.width, height: frame.height}}
        :   result
    let text = JSON.stringify(described ?? null)
    if (text.length > MAX_TOOL_TEXT_CHARS)
        text = `${text.slice(0, MAX_TOOL_TEXT_CHARS)}… [truncated, ${String(text.length)} characters]`
    return {
        content: image ? [{type: 'text', text}, image] : [{type: 'text', text}],
        details: result
    }
}

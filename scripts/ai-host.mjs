/**
 * The worker's half of the duplex channel to Rust.
 *
 * Rust sends the startup context as the first stdin line and then answers tool requests on the
 * same stream; the worker writes agent events and tool requests to stdout, each on its own line
 * behind its own prefix so unprefixed diagnostics stay diagnostics. Nothing here implements a
 * Godot operation: every tool call is forwarded, and the router in `src-tauri/src/ai_tools.rs` is
 * the only place an operation exists.
 */

export const EVENT_PREFIX = 'GOFER_AI_EVENT:'
export const TOOL_PREFIX = 'GOFER_AI_TOOL:'
export const CREDENTIAL_PREFIX = 'GOFER_AI_CREDENTIAL:'

/**
 * The one line Rust sends that is not an answer: stop.
 *
 * Kept beside the prefixes because it is the channel's vocabulary rather than any one job's.
 * `src-tauri/src/ai_turn.rs` spells the same word in `AI_CANCEL_LINE`, and
 * `scripts/check-command-surface.mjs` holds the two to each other.
 */
export const CANCEL_TYPE = 'cancel'

/** What a job is told it was stopped by, on every abort this channel raises. */
export const STOP_REASON = 'the turn was stopped'

/**
 * The stop the backend asks for, and the signal every job reads it from.
 *
 * There were two implementations of "the user stopped the turn" and only one of them ran. Rust
 * cancelled by killing the worker, so the whole abort path threaded through `runAgent`, `runBrief`
 * and `runMemoryJudge` — the listener that calls `agent.abort()`, the `aborted` completion, the
 * interruptible retry wait — was reachable from tests and from nothing else: `scripts/ai-worker.mjs`
 * never built an `AbortController` and passed `undefined` in its place.
 *
 * The kill is still the backstop, and a worker that does not answer this still dies. But it is the
 * second ask now. The first is one line on the channel that is already open, and answering it is
 * what lets the turn narrate its own ending: the in-flight assistant message reaches the transcript
 * checkpoint instead of going with the process.
 */
export function createCancellation() {
    const controller = new AbortController()
    return {
        signal: controller.signal,
        /**
         * Whether this line was the stop rather than a tool answer.
         *
         * Answering `true` is what keeps it away from the tool hosts: a cancel carries no `id`, so
         * delivering it to them would be a lookup that finds nothing and says nothing.
         */
        deliver(message) {
            if (message?.type !== CANCEL_TYPE) return false
            controller.abort(new Error(STOP_REASON))
            return true
        }
    }
}

/**
 * Correlates outgoing tool requests with the results Rust sends back.
 *
 * A pending call is settled exactly once — by a result, by the caller's AbortSignal, or by the
 * channel closing — because an agent turn that ends with a promise nobody will ever resolve hangs
 * the worker instead of failing it.
 *
 * `channel` names the id space. Rust answers on one stream that every host reads, so two hosts
 * counting from one would both claim the reply to `call-1` and one of them would settle a promise
 * that was never its own.
 */
export function createToolHost(send, channel = 'call') {
    const pending = new Map()
    let nextId = 0
    let closed
    return {
        call(tool, params, signal) {
            return new Promise((resolve, reject) => {
                if (closed) return reject(new Error(closed))
                if (signal?.aborted) return reject(new Error('The tool call was cancelled'))
                const id = `${channel}-${String((nextId += 1))}`
                // The listener comes off with the call. One signal lasts the whole turn and a turn
                // makes hundreds of tool calls, so a listener left on after its call settled is one
                // more closure held for the rest of the turn, over and over.
                const onAbort = () =>
                    settle({ok: false, error: new Error('The tool call was cancelled')})
                const settle = outcome => {
                    if (!pending.delete(id)) return
                    signal?.removeEventListener('abort', onAbort)
                    if (outcome.ok) resolve(outcome.result)
                    else reject(outcome.error)
                }
                pending.set(id, settle)
                signal?.addEventListener('abort', onAbort, {once: true})
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

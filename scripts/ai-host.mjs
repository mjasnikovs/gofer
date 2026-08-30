export const EVENT_PREFIX = 'GOFER_AI_EVENT:'
export const TOOL_PREFIX = 'GOFER_AI_TOOL:'
export const CREDENTIAL_PREFIX = 'GOFER_AI_CREDENTIAL:'

export const CANCEL_TYPE = 'cancel'

export const STOP_REASON = 'the turn was stopped'

export function createCancellation() {
    const controller = new AbortController()
    return {
        signal: controller.signal,
        deliver(message) {
            if (message?.type !== CANCEL_TYPE) return false
            controller.abort(new Error(STOP_REASON))
            return true
        }
    }
}

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

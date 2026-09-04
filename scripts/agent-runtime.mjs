import {NodeExecutionEnv} from '@earendil-works/pi-agent-core/node'
import {createAssistantMessageEventStream, isRetryableAssistantError} from '@earendil-works/pi-ai'
import {isContextOverflow} from '@earendil-works/pi-ai/compat'
import {withoutPictures, withoutRepeatingARefusal} from './tool-result.mjs'

export function zeroUsage() {
    return {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}
    }
}

export function textContent(content) {
    return (content ?? [])
        .filter(part => part.type === 'text')
        .map(part => part.text)
        .join('')
}

export function modelReadsImages(model) {
    return Array.isArray(model?.input) && model.input.includes('image')
}

export function createToolEnv(workspacePath) {
    return new NodeExecutionEnv({cwd: workspacePath})
}

function bindTool(tool, context) {
    return {
        ...tool,
        execute: (id, params, signal, onUpdate) =>
            tool.execute(id, params, signal, onUpdate, context)
    }
}

// The guard sits inside the picture stripping so a screenshot is judged by its bytes, not by the
// one fixed sentence a text-only model is handed in their place.
export function decorateTools({env, tools, model, guard, extras = []}) {
    const context = {env}
    const sees = modelReadsImages(model)
    return tools
        .map(tool => bindTool(tool, context))
        .map(tool => (guard ? guard(tool) : tool))
        .map(tool => (sees ? tool : withoutPictures(tool)))
        .map(withoutRepeatingARefusal)
        .map(tool => extras.reduce((wrapped, decorate) => decorate(wrapped), tool))
}

// `shouldStopAfterTurn` ends a loop after a turn's tool results. This ends it at the next request
// instead, which is the only place a caller can first grant one more answer and then close.
export function endedStream(model, errorMessage) {
    const stream = createAssistantMessageEventStream()
    const message = {
        role: 'assistant',
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: zeroUsage(),
        stopReason: 'error',
        errorMessage,
        timestamp: Date.now()
    }
    stream.push({type: 'error', reason: 'error', error: message})
    stream.end(message)
    return stream
}

export const EMPTY_ANSWER = 'The model ended its turn empty: no answer, no tool call.'

function asAssistantFailure(failure) {
    if (failure.assistantMessage) return failure.assistantMessage
    if (typeof failure.errorMessage === 'string') return failure
    return {stopReason: 'error', errorMessage: failure.reason ?? failure.message ?? ''}
}

export function isWorthRetrying(failure, model) {
    if (failure.retryable !== undefined) return failure.retryable
    const message = asAssistantFailure(failure)
    if (isContextOverflow(message, model.contextWindow)) return false
    if (message.errorMessage === EMPTY_ANSWER) return true
    return isRetryableAssistantError(message)
}

export const realTimers = {
    now: () => Date.now(),
    schedule: (fn, ms) => setTimeout(fn, ms),
    cancel: handle => {
        clearTimeout(handle)
    },
    repeat: (fn, ms) => setInterval(fn, ms),
    stopRepeat: handle => {
        clearInterval(handle)
    }
}

export function abortableWait(
    ms,
    signal,
    timers = realTimers,
    stopMessage = 'The turn was stopped'
) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(new Error(stopMessage))
            return
        }
        const onAbort = () => {
            timers.cancel(handle)
            reject(new Error(stopMessage))
        }
        const handle = timers.schedule(() => {
            signal?.removeEventListener('abort', onAbort)
            resolve()
        }, ms)
        signal?.addEventListener('abort', onAbort, {once: true})
    })
}

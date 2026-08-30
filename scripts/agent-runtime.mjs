import {NodeExecutionEnv} from '@earendil-works/pi-agent-core/node'
import {isRetryableAssistantError} from '@earendil-works/pi-ai'
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

export function decorateTools({env, tools, model, extras = []}) {
    const context = {env}
    const sees = modelReadsImages(model)
    return tools
        .map(tool => bindTool(tool, context))
        .map(tool => (sees ? tool : withoutPictures(tool)))
        .map(withoutRepeatingARefusal)
        .map(tool => extras.reduce((wrapped, decorate) => decorate(wrapped), tool))
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

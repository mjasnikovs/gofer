/**
 * What both agent loops are made of, held in one place so there is one of each.
 *
 * Gofer runs two loops around a model and they are deliberately not one loop: a turn compacts,
 * verifies, rolls a transcript back and reports to a chat, and a delegation counts steps, watches a
 * silence clock and hands back a paragraph. Those are different policies and merging them would
 * mean a flag for every difference.
 *
 * Underneath the policies they were the same code twice. A zero usage record, the text out of a
 * content list, whether a model can be shown a picture, the pipeline that turns raw tools into the
 * tools an agent may hold, whether a failure is worth asking again, and a wait a stopped turn does
 * not sit through — each was written once in `ai-provider.mjs` and once in `ai-subagent.mjs`, under
 * two names, and the copies had already drifted: one `textContent` tolerated a missing content list
 * and the other did not, and only the child's wait could be given a clock.
 *
 * So this file holds the substrate and neither loop holds a copy. It knows nothing about turns,
 * phases, verify points or delegation bounds; anything that has to decide between them belongs to
 * the caller that knows which one it is.
 */

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

/**
 * The words out of a content list, which is what a screen and a parent model are given.
 *
 * An absent list reads as empty rather than throwing. Both loops already meant that — the parent
 * wrote `?? []` at each of its three call sites and the child wrote it once, here — and a helper
 * that is safe in one file and not the other is the shape a copy drifts into.
 */
export function textContent(content) {
    return (content ?? [])
        .filter(part => part.type === 'text')
        .map(part => part.text)
        .join('')
}

/**
 * Can this model be shown a picture?
 *
 * Read off the model rather than assumed, because a model that cannot is not lenient about it: the
 * provider refuses the whole request, so an unchecked image ends the agent at its first step rather
 * than going unnoticed in it. A model that says nothing about its inputs is taken at its word — no
 * claim to read images is not a claim to read them. Absent means text, which is the safe answer.
 *
 * One function, because two copies of one capability check is one of them being right after
 * somebody widens it — a provider that advertises its eyes under another word would be understood
 * by one caller and not the other, for the same model.
 */
export function modelReadsImages(model) {
    return Array.isArray(model?.input) && model.input.includes('image')
}

/** Where a tool's file and shell work happens. One per agent, cleaned up by whoever asked for it. */
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

/**
 * Raw tools in, the tools an agent may actually hold out.
 *
 * Three steps, in this order, for every agent in Gofer:
 *
 *   the execution environment bound into `execute`, so a tool runs in this agent's worktree;
 *   pictures taken out unless the model reading them said it could — the child's own model may not
 *   be the parent's and may not have its eyes;
 *   the refusal counter, so a tool that keeps being called the same wrong way stops repeating
 *   itself. The counter is per agent because these tools are: the provider is not made until a turn
 *   starts, so a call refused in one turn is not remembered into the next, and a child's tools are
 *   built per delegation, so the counter is per child.
 *
 * `extras` is what the caller adds on the outside and is the only difference between the two: the
 * child wraps every tool in its command clock, and the turn has nothing to add. What each agent may
 * hold is decided before this — the caller builds and confines its own list — so widening one
 * agent's reach is still an edit to that agent's list and never to this pipeline.
 */
export function decorateTools({env, tools, model, extras = []}) {
    const context = {env}
    const sees = modelReadsImages(model)
    return tools
        .map(tool => bindTool(tool, context))
        .map(tool => (sees ? tool : withoutPictures(tool)))
        .map(withoutRepeatingARefusal)
        .map(tool => extras.reduce((wrapped, decorate) => decorate(wrapped), tool))
}

/**
 * What a turn that stopped without saying anything is reported as.
 *
 * The wording is the marker: `isWorthRetrying` matches this exact string to decide the turn is
 * worth asking again, because Pi's classifier reads provider error text and this failure has none.
 */
export const EMPTY_ANSWER = 'The model ended its turn empty: no answer, no tool call.'

/**
 * The one shape the classifier reads, out of the three shapes a failure arrives in.
 *
 * A turn hands over an assistant message that already carries `errorMessage`. A delegation hands
 * over its own error, which either carries the assistant message that caused it or carries only the
 * sentence it was built with — and a sentence is not something Pi's classifier can read until it is
 * restated as the failed message it stands for.
 */
function asAssistantFailure(failure) {
    if (failure.assistantMessage) return failure.assistantMessage
    if (typeof failure.errorMessage === 'string') return failure
    return {stopReason: 'error', errorMessage: failure.reason ?? failure.message ?? ''}
}

/**
 * Whether waiting and asking again is worth anything.
 *
 * A failure that already knows its own answer is believed first: a delegation that ran out of steps
 * or finished without writing anything says so on the error itself, and no amount of provider
 * wording changes that verdict.
 *
 * Context overflow is asked next and always answered no: it is deterministic, it fails identically
 * every time, and patience is not its repair. The turn's repair is compaction; the child has none at
 * all — a narrower question is the repair, and only the parent can ask one.
 *
 * Everything else is Pi's classifier, which is a list of provider and transport wording earned from
 * real failures. Copying the list here would have meant maintaining it here.
 */
export function isWorthRetrying(failure, model) {
    if (failure.retryable !== undefined) return failure.retryable
    const message = asAssistantFailure(failure)
    if (isContextOverflow(message, model.contextWindow)) return false
    // Ours, and asked before Pi's list, because an empty turn carries no provider wording for that
    // list to recognise. Pi is deliberate about this: its classifier only reads turns that stopped
    // with an error, and it states that the retry policy belongs to the caller. This is the caller.
    if (message.errorMessage === EMPTY_ANSWER) return true
    return isRetryableAssistantError(message)
}

/**
 * Real timers, and the seam every clock in Gofer's agents is tested through.
 *
 * Injectable because the alternative is a test that waits out a five-minute ceiling to prove the
 * ceiling works. `now` is separate from `schedule` because the silence clock polls: it asks how long
 * it has been rather than being re-armed on every one of the thousands of events a stream emits.
 */
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

/**
 * A wait that a cancelled turn does not have to sit through.
 *
 * `timers` is injectable on both sides, so neither loop's retry policy has to be proved by paying
 * the delay it schedules. `signal` stays optional: a caller with nothing to be stopped by passes
 * nothing, and the wait is then an ordinary timer.
 *
 * `stopMessage` is the caller's, because the two agents are read by different audiences: a turn's
 * stop is reported to a person, and a delegation's is a tool result written for the parent model.
 */
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
        // Taken off again when the wait ends on its own. The signal lasts the whole turn while a
        // wait lasts a backoff, so a listener left behind outlives what it was listening for — and
        // every retry, and every probe, adds another one to the same signal.
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

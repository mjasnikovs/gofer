import {createHash} from 'node:crypto'
import {sameWhateverTheOrder, withExecute} from './tool-result.mjs'

// Consecutive identical calls before one is refused. Over 1,490 legitimate recorded calls the
// longest run was 4; the one runaway made 274. Dimensionless, so a slow model is never punished.
export const SAME_CALL_LIMIT = 8

// Consecutive tool results that were errors or bytes already returned this turn. Longest
// legitimate streak on the same corpus was 4; the runaway reached 517.
export const NO_NEW_GROUND_LIMIT = 10

// Refusals of one call before the turn is ended rather than argued with.
export const REFUSALS_BEFORE_ENDING = 3

// Every no-new-ground refusal counts against this one key, whatever call it landed on.
const NO_NEW_GROUND_KEY = 'no-new-ground'

const SHOWN_ARGUMENT_CHARS = 120

// Digits fold to one symbol so an A/B rotation over offsets, ports or counters reads as one call.
export function normalisedKey(name, params) {
    const shape = sameWhateverTheOrder(params).replaceAll(/\d+/gu, '#').replaceAll(/\s+/gu, ' ')
    return `${name} ${shape}`
}

// Every content part, image bytes included: four screenshots can share one caption.
export function resultDigest(result) {
    return createHash('sha256')
        .update(JSON.stringify(result?.content ?? result ?? null))
        .digest('hex')
}

function shownArguments(params) {
    const text = JSON.stringify(params) ?? ''
    return text.length <= SHOWN_ARGUMENT_CHARS ? text : `${text.slice(0, SHOWN_ARGUMENT_CHARS)}…`
}

function ordinal(count) {
    const rest = count % 100
    if (rest >= 11 && rest <= 13) return `${String(count)}th`
    const ends = {1: 'st', 2: 'nd', 3: 'rd'}
    return `${String(count)}${ends[count % 10] ?? 'th'}`
}

function describeHit(hit) {
    return hit.kind === 'same-call' ?
            `${hit.name} ${shownArguments(hit.params)} was made ${String(hit.count)} times in a row`
        :   `${String(hit.count)} tool results in a row returned nothing new, each an error or `
                + `bytes already returned this turn`
}

export function refusedCallReason(hit, refusals) {
    const left = REFUSALS_BEFORE_ENDING - refusals
    const ending =
        left === 1 ? 'One more will end this turn.' : `${String(left)} more will end this turn.`
    if (hit.kind === 'same-call')
        return (
            `Refused: this is the ${ordinal(hit.count)} ${hit.name} call in a row with the same `
            + `arguments, ${shownArguments(hit.params)}, and nothing about the project changed `
            + `between them. Use the result it already returned, or take a different route to the `
            + `answer. ${ending}`
        )
    return (
        `Refused: the last ${String(hit.count)} tool results taught you nothing you did not `
        + `already have. Each was an error or bytes already returned this turn. Answer from what `
        + `you have, or ask for something you have not seen. ${ending}`
    )
}

export function loopedReason(hit, refusals) {
    return (
        `it looped: ${describeHit(hit)}, was refused ${String(refusals)} times this turn, and was `
        + `asked for again`
    )
}

function isAbort(error, signal) {
    return signal?.aborted === true || error?.name === 'AbortError'
}

export function createProgressGuard() {
    const seen = new Set()
    const seenCalls = new Set()
    const refusals = new Map()
    let lastKey
    let streak = 0
    let dead = 0
    let verdict

    const reset = () => {
        seen.clear()
        seenCalls.clear()
        refusals.clear()
        lastKey = undefined
        streak = 0
        dead = 0
        verdict = undefined
    }

    const judge = (name, params) => {
        const key = normalisedKey(name, params)
        streak = key === lastKey ? streak + 1 : 1
        lastKey = key
        const repeated = seenCalls.has(key)
        seenCalls.add(key)
        // The refusal claims nothing changed between the calls, so it has to be true: `dead` is
        // zero for as long as the last result was one this turn had not seen. Stepping a debugger
        // and paging a file both repeat their arguments exactly — `step_over` takes an optional
        // thread and nothing else, and a folded offset reads as the same call — and both are
        // progress. The runaway this rule was measured on repeated its results too.
        if (streak >= SAME_CALL_LIMIT && dead > 0)
            return {kind: 'same-call', key, name, params, count: streak}
        // A call never made this turn is the one thing the refusal asks for, so it runs, and its
        // result rather than its arguments decides whether the streak goes on.
        if (repeated && dead >= NO_NEW_GROUND_LIMIT)
            return {kind: 'no-new-ground', key: NO_NEW_GROUND_KEY, name, params, count: dead}
        return undefined
    }

    const refuse = hit => {
        const refused = (refusals.get(hit.key) ?? 0) + 1
        refusals.set(hit.key, refused)
        if (refused < REFUSALS_BEFORE_ENDING) throw new Error(refusedCallReason(hit, refused))
        verdict = {cause: 'loop', reason: loopedReason(hit, refused)}
        throw new Error(verdict.reason)
    }

    const decorate = tool =>
        withExecute(tool, async (execute, id, params, signal, onUpdate, context) => {
            if (verdict) throw new Error(verdict.reason)
            if (signal?.aborted) return execute(id, params, signal, onUpdate, context)
            const hit = judge(tool.name, params)
            if (hit) refuse(hit)
            let result
            try {
                result = await execute(id, params, signal, onUpdate, context)
            } catch (error) {
                if (!isAbort(error, signal)) dead += 1
                throw error
            }
            const digest = resultDigest(result)
            if (seen.has(digest)) dead += 1
            else {
                seen.add(digest)
                dead = 0
            }
            return result
        })

    return {decorate, reset, verdict: () => verdict}
}

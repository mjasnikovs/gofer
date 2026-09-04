export const WORKER_KINDS = ['ok', 'empty', 'runaway', 'fatal', 'stopped']

const RUNAWAY_CAUSES = new Set(['step-ceiling', 'loop', 'command-timeout'])

const BARE_NONE =
    /^[-*\s]*\(?\s*(?:none|n\/?a|nothing|no (?:content|entries|response|items|results))\s*\.?\s*\)?\s*$/iu

export function isBareNoneAnswer(text) {
    return BARE_NONE.test((text ?? '').trim())
}

export function classifyWorkerOutcome(outcome, {partial = ''} = {}) {
    if (!outcome || typeof outcome.kind !== 'string') {
        throw new TypeError('classifyWorkerOutcome was given something that is not an outcome')
    }
    switch (outcome.kind) {
        case 'stopped':
            return {kind: 'stopped', reason: outcome.reason}
        case 'failed': {
            if (RUNAWAY_CAUSES.has(outcome.cause)) {
                return {kind: 'runaway', reason: outcome.reason, text: partial.trim()}
            }
            if (outcome.cause === 'no-answer') return {kind: 'empty'}
            return {kind: 'fatal', reason: outcome.reason}
        }
        case 'ok':
            return isBareNoneAnswer(outcome.text) ?
                    {kind: 'empty'}
                :   {kind: 'ok', text: outcome.text, usage: outcome.usage, turns: outcome.turns}
        default:
            throw new TypeError(`classifyWorkerOutcome does not know the ending '${outcome.kind}'`)
    }
}

export function degradedSection(name, reason, partial = '') {
    const marker = `(degraded: the ${name} worker ${reason}; this section may be incomplete)`
    const body = partial.trim()
    return body.length > 0 ? `${marker}\n\n${body}` : marker
}

export function emptySection(name) {
    return `(none — the ${name} worker ran and reported nothing for this task)`
}

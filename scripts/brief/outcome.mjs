/**
 * What one worker's ending means to the pipeline running it.
 *
 * A phase worker can end five ways and only two of them are the same kind of event, so the pipeline
 * has to be told which one it got before it can decide anything. The classification lives here, once,
 * as an ordered table, and every consumer switches on the resulting kind — so a new ending is a
 * missing branch at the switch rather than a case that quietly falls through to whatever the last
 * `else` happened to be.
 *
 * Order is load-bearing. `stopped` is asked first and answered first: a stop sets the same flags a
 * failure does, and a pipeline that read the flags in the other order would degrade past the stop and
 * carry on spending a machine the user just asked to stop spending. `empty` is asked before `fatal`
 * for the opposite reason — see below.
 *
 * The five kinds:
 *
 *   ok       an answer.
 *   empty    the worker RAN, said nothing, and reported no cause. On a task that touches nothing —
 *            "make a folder with an index.html in it" — three of the four research workers have
 *            genuinely nothing to report, and each worker prompt tells them to emit only what the
 *            task touches. Silence is then the correct answer, and treating it as a failure kills a
 *            healthy run over its weakest section. So it is recorded, not raised.
 *   runaway  the worker explored too long and was cut off: a step ceiling, a silent stream, a
 *            command that never returned. It did real work and may have left partial text. The other
 *            workers are unaffected and the phase keeps what it got, marked — failing here would
 *            throw away every good worker over the weakest one, and because the loop is
 *            deterministic a retry just re-loops.
 *   fatal    a cause was reported. The output is untrustworthy in a way partial text cannot paper
 *            over, so it is raised rather than laundered into a plausible-looking section.
 *   stopped  the user's doing. Never retried, never degraded past.
 *
 * The distinction that matters most, and the one that is easy to get wrong: silence WITHOUT a cause
 * is `empty`, silence WITH a cause is `fatal`. A crashed worker and a worker with nothing to say look
 * identical from the outside, and only the reported cause tells them apart.
 */

/** Every kind `classifyWorkerOutcome` can answer. A consumer that switches on these is exhaustive. */
export const WORKER_KINDS = ['ok', 'empty', 'runaway', 'fatal', 'stopped']

/**
 * Endings that mean the worker was cut off mid-explore rather than broken.
 *
 * Keyed on the `cause` tag rather than on the failure's sentence: the sentence is written to be read
 * and gets reworded, and a table matching prose drifts the first time it is improved without anything
 * failing to say so.
 */
const RUNAWAY_CAUSES = new Set(['step-ceiling', 'stream-stall', 'command-timeout'])

/**
 * A worker answer that IS the word "nothing" and carries nothing else: `(none)`, `N/A`, `- none`,
 * `(no entries)`. A model with nothing to say writes one of these about as often as it writes an
 * empty answer, and both mean the same thing, so both are recorded the same way rather than passed
 * through in whatever shape the model happened to pick.
 *
 * Deliberately narrow — a lone token only. Prose like "(no APIs to list: this task creates one HTML
 * file)" carries a reason worth keeping and is a real answer.
 */
const BARE_NONE =
    /^[-*\s]*\(?\s*(?:none|n\/?a|nothing|no (?:content|entries|response|items|results))\s*\.?\s*\)?\s*$/iu

export function isBareNoneAnswer(text) {
    return BARE_NONE.test((text ?? '').trim())
}

/**
 * Classify one `runSubagentOutcome` result.
 *
 * `partial` is whatever the worker streamed before it was cut off, when the caller kept it. It is
 * carried on a runaway so the phase can keep an incomplete section rather than nothing, and ignored
 * everywhere else.
 */
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
            // A worker that ran, exited clean and wrote nothing reports `no-answer` and no cause
            // beyond it. That is the honest empty answer, and it is the one ending here that is not
            // a failure at all.
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

/**
 * The body written for a section whose worker was cut off.
 *
 * The marker is always present, even with no partial text, so an empty degrade is never read as a
 * real finding. Naming the worker inside it keeps the marker true after assembly, where the section
 * headings are all that separate one worker's output from another's.
 */
export function degradedSection(name, reason, partial = '') {
    const marker = `(degraded: the ${name} worker ${reason}; this section may be incomplete)`
    const body = partial.trim()
    return body.length > 0 ? `${marker}\n\n${body}` : marker
}

/**
 * The body written for a section whose worker ran and found nothing.
 *
 * Three states have to stay tellable apart by anyone reading a section — a person or a later phase —
 * so each carries its own marker: this one, `degradedSection`'s, and a section that is simply absent
 * because the worker never got that far.
 */
export function emptySection(name) {
    return `(none — the ${name} worker ran and reported nothing for this task)`
}

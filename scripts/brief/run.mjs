/**
 * The host loop: four phases, in a fixed order, driven by code rather than chosen by a model.
 *
 * This is the only file that knows there is a pipeline. The phases themselves take text and return
 * text (see `phases.mjs`), the workers are ordinary bounded delegations, and the question surface is
 * an ordinary tool — so every part of this is usable without the others, and this file is what
 * happens to arrange them in this order.
 *
 * Two facts about the process it runs in shape everything below.
 *
 * A stop is a kill. The backend cancels a run by killing this process, so nothing held here survives
 * it. Anything a resumed run would want back has to have crossed into Rust already, which is why each
 * phase announces its output the moment it has one rather than at the end.
 *
 * Nothing here writes to a database. Node has no handle on one. The `brief-phase` event is the whole
 * of the persistence story from this side; the backend is what makes it durable.
 */

import {createModelContext} from '../ai-provider.mjs'
import {createChildTools, eventProgress, readsImages, runSubagentOutcome} from '../ai-subagent.mjs'
import {probeTools} from '../ai-reachability.mjs'
import {BRIEF_PHASES} from './catalogue.mjs'
import {PhaseFailed, PhaseStopped, compose, grill, refine, research} from './phases.mjs'
import {appendNoThink} from './prompts.mjs'

export {BRIEF_PHASES}

/** The tool the grill phase asks its questions through, by the name the backend routes it under. */
export const ASK_TOOL_NAME = 'ask_user'

/**
 * How long a whole brief may take before it gives up.
 *
 * Nothing else composes the per-child bounds. A child is bounded three ways and seven of them run in
 * a row, so the worst case is the sum — measured in hours, and reached by an ask the phases cannot
 * make sense of. `asdf ;;;; ????` spent fifteen minutes inside research alone before anything
 * noticed, and the only thing that would ever have ended it was the user.
 *
 * Checked before every worker rather than enforced with a timer, because that is where a run can be
 * ended without throwing away what it has: every phase before the deadline is already recorded, and
 * the row says which one it got to. A phase boundary alone is too coarse — research runs up to eight
 * workers between two of them, and compose two whole drafts.
 *
 * Time spent waiting for the USER does not count against it. A question can wait half an hour, and a
 * run held up by a person who is reading the code it is about has not run away — it is doing exactly
 * what it should. Counted, the deadline would kill the one case it has no business killing, and a
 * ceiling that fires on somebody thinking is not a ceiling on the machine.
 */
export const BRIEF_DEADLINE_MS = 20 * 60 * 1000

/** Raised at the first phase boundary past the deadline. */
export class BriefExpired extends Error {
    constructor(phase, elapsedMs) {
        super(`the plan was still on ${phase} after ${Math.round(elapsedMs / 60_000)} minutes`)
        this.phase = phase
    }
}

/**
 * Ends a run that has outlived its deadline, at the point it is noticed inside the named phase.
 *
 * A deadline of zero is off, which is what a caller with no ceiling means — never `expire
 * immediately`, which is what a bare `elapsed > deadline` would have done to it.
 */
export function guardDeadline(phase, elapsedMs, deadlineMs = BRIEF_DEADLINE_MS) {
    if (deadlineMs > 0 && elapsedMs > deadlineMs) throw new BriefExpired(phase, elapsedMs)
}

/**
 * What each phase is, as one call over everything the phases before it produced.
 *
 * Keyed by the catalogue's names, and the loop below walks the catalogue rather than this — so a
 * phase that is in the vocabulary and has no work here is a named failure, not a silent skip.
 */
const PHASE_WORK = {
    refine: (done, deps) => refine(done.prompt, deps),
    research: (done, deps) => research(done.refined, deps),
    grill: (done, deps) => grill(done.refined, done.research, deps),
    compose: (done, deps) => compose(done.refined, done.research, done.qa, deps)
}

/** What a phase's output looks like once it is a field the backend can store. */
const stored = value => (typeof value === 'string' ? value : JSON.stringify(value))

/**
 * Every tool any phase might hold, which is what gets proved before the first phase runs.
 *
 * Probing once rather than per phase is a compromise between the two failures either extreme causes.
 * Probing nothing brings back the failure the reachability check was written for — a tool that is
 * silently dead looks exactly like a model choosing not to call it, and a run ends with no searches
 * and no error to show for it. Probing seven times builds seven children to answer a question whose
 * answer cannot change in the fifteen minutes between the first and the last.
 */
function everyPhaseTool(canSearch) {
    return canSearch ?
            ['read', 'bash', 'godot_docs_search', 'web_search']
        :   ['read', 'bash', 'godot_docs_search']
}

/**
 * Is a web search worth offering this run?
 *
 * The keyless providers always are; only Brave needs its key, and a tool that can only answer with an
 * error is worse than an absent one — a small model will spend steps on it before believing it.
 */
export function searchConfigured(settings, braveApiKey) {
    const provider = settings?.web?.searchProvider ?? 'exa'
    return provider !== 'brave' || Boolean(braveApiKey)
}

/**
 * Can this model be shown a picture?
 *
 * Re-exported rather than written again. It was written twice, identically, and two copies of one
 * capability check is one of them being right after somebody widens it — a provider that advertises
 * its eyes under another word would be understood by one caller and not the other, for the same
 * model.
 */
export {readsImages}

/** The backend's `{data, mimeType}` pairs, as the content blocks a prompt carries. */
export function asImageContent(images) {
    return images.map(image => ({type: 'image', data: image.data, mimeType: image.mimeType}))
}

/**
 * What the phases spend, added up.
 *
 * Reported on its own event rather than folded into the turn's usage, and the reason is worth
 * writing down: the context bar reads the LAST usage event as how full the conversation is, so a
 * child's tokens reported that way would say the first chat message had already filled the window.
 * A delegation deliberately emits no usage at all for exactly that reason. This is the other half —
 * the spend is real and the user is the one deciding whether Planned was worth it, so it is counted
 * here and shown beside the brief instead of being lost.
 */
function addSpend(total, usage) {
    return {
        input: total.input + (usage?.input ?? 0),
        output: total.output + (usage?.output ?? 0)
    }
}

/**
 * Everything a run reaches outside this process: a model, bounded children, and a proof that the
 * tools those children hold are actually reachable.
 *
 * One parameter rather than three imports, because the arrangement of the phases is the thing this
 * file owns and it was the one part of it nothing could exercise. A test substitutes this and drives
 * the whole pipeline — including the ways it ends — without a provider.
 */
export const LIVE_WORLD = {createModelContext, createChildTools, probeTools, runSubagentOutcome}

/**
 * Runs the whole brief and answers with the finished specification.
 *
 * `emit` is the same event sink a turn uses. Every phase boundary goes down it as `brief-phase`, and
 * that is what the backend persists — see the note at the top about what a stop does to anything held
 * only in here.
 *
 * However it ends, it says so on exactly one event before it returns or throws. See the catch at the
 * bottom: that is the whole of the contract the window's panel is drawn from.
 */
export async function runBrief({
    settings,
    apiKey,
    openrouterApiKey,
    braveApiKey,
    oauthCredential,
    sessionId,
    workspacePath,
    prompt,
    images = [],
    inventory,
    existingFiles,
    planContext,
    tools: domains,
    host,
    credentialHost,
    emit,
    signal,
    now = () => Date.now(),
    deadlineMs = BRIEF_DEADLINE_MS,
    world = LIVE_WORLD
}) {
    if (typeof prompt !== 'string' || prompt.trim().length === 0) {
        throw new Error('The brief was given no task to work from')
    }
    const {models, model, subagent, streamOptions} = world.createModelContext({
        settings,
        apiKey,
        openrouterApiKey,
        oauthCredential,
        credentialHost,
        sessionId,
        signal
    })
    // Said before anything slow happens, and the probe below is slow. Until this arrives the window
    // has a task with an empty chat and nothing saying why, which is the same thing a broken run
    // looks like. It is also the only event that arrives before the first phase can fail.
    emit({type: 'brief-started'})
    /*
     * The pictures the ask came with, if the model answering the phases can read one.
     *
     * The sub-agent's model is the user's own choice and need not be the model the composer offered
     * the paperclip for. Sent to a text-only model the images are not ignored — the provider refuses
     * the request, and that refusal would end the first phase of a fifteen-minute run. Said out
     * loud when they are dropped, because a plan written without the screenshot it was asked about
     * is wrong in a way only the user can see.
     */
    const pictures = readsImages(subagent.model) ? asImageContent(images) : []
    if (images.length > 0 && pictures.length === 0) {
        emit({
            type: 'brief-log',
            message:
                `the plan's model cannot read images, so the ${String(images.length)} attached `
                + 'to the ask were left out of it'
        })
    }
    const canSearch = searchConfigured(settings, braveApiKey)
    const childDeps = {domains, host, braveApiKey, searchProvider: settings?.web?.searchProvider}

    let spend = {input: 0, output: 0}
    /** How long this run spent waiting for a person, which the deadline below does not count. */
    let waitedOnTheUser = 0
    const startedAt = now()
    /** Where the run is, so an ending names it even when the thing that ended it does not. */
    let atPhase = 'startup'

    /**
     * One worker. Every phase reaches a model only through here, so the bounds, the model choice and
     * the accounting are decided once instead of per phase.
     */
    const runWorker = async ({label, prompt: text, toolNames, images: pictures = []}) => {
        emit({type: 'brief-worker', label})
        const outcome = await world.runSubagentOutcome({
            // The panel's live line, produced by the delegation rather than by this loop. Nothing
            // here formats it: `eventProgress` is the sub-agent's own sink for a caller that has an
            // event pipe instead of a tool row, and the only thing this file supplies is the name
            // the catalogue owns and which worker it is about.
            progress: eventProgress(emit, 'brief-worker-step', {label}),
            prompt: appendNoThink(text),
            images: pictures,
            toolNames,
            workspacePath,
            models,
            model: subagent.model,
            thinkingLevel: subagent.thinkingLevel,
            streamOptions,
            settings: settings?.subagent,
            deps: childDeps,
            signal
        })
        if (outcome.kind === 'ok') spend = addSpend(spend, outcome.usage)
        return outcome
    }

    const deps = {
        runWorker,
        // Shown to the one phase that reads the raw ask, and only if the model answering it can
        // read a picture at all: the sub-agent's model is the user's own choice and need not be the
        // one the composer offered the paperclip for. Sent to a text-only model, the images are not
        // ignored — the provider refuses the request, and the refusal ends the first phase of a
        // fifteen-minute run.
        images: pictures,
        inventory,
        existingFiles,
        planContext,
        canSearch,
        // Checked before every worker any phase runs, rather than only at a phase boundary: research
        // runs up to eight workers between two of them and compose two whole drafts, so a boundary
        // alone lets a runaway spend most of a run past its ceiling.
        guard: phase => guardDeadline(phase, now() - startedAt - waitedOnTheUser, deadlineMs),
        log: message => emit({type: 'brief-log', message}),
        onWorker: (section, kind) => emit({type: 'brief-worker-done', section, kind}),
        onQuestion: (question, outcome) =>
            emit({type: 'brief-question-settled', question: question.question, outcome}),
        // The question goes out as an ordinary tool call, down the channel the backend already gives
        // its own thread. That is what lets it block for as long as a person takes to answer without
        // stalling the events drawing the question on screen.
        askUser: async question => {
            const askedAt = now()
            const answer = await host.call(
                ASK_TOOL_NAME,
                {
                    question: question.question,
                    options: question.options,
                    why: question.why
                },
                signal
            )
            // Held apart from the deadline: a person reading the code a question is about is not a
            // runaway, and a ceiling that fires on them is a ceiling on the wrong thing.
            waitedOnTheUser += now() - askedAt
            const text = typeof answer?.answer === 'string' ? answer.answer.trim() : ''
            return text.length > 0 ? text : null
        }
    }

    const started = phase => {
        atPhase = phase
        emit({type: 'brief-phase-start', phase})
    }
    const finished = (phase, field, value) => emit({type: 'brief-phase', phase, field, value})

    try {
        // Before any phase runs, and worded so a refusal names the tool rather than the brief: a
        // phase that discovers a dead tool eight minutes in has already spent those eight minutes.
        const {env, tools} = world.createChildTools(workspacePath, {
            toolNames: everyPhaseTool(canSearch),
            deps: childDeps
        })
        try {
            await world.probeTools({tools, host, workspacePath, signal})
        } finally {
            await env.cleanup()
        }

        // The catalogue is the order. Walking it here rather than writing four calls in a row is
        // what makes the table the one owner of "which phases there are and what each fills"
        // instead of a comment beside the code that really decides.
        const done = {prompt}
        for (const {name, field} of BRIEF_PHASES) {
            const work = PHASE_WORK[name]
            if (!work) throw new Error(`The ${name} phase is in the catalogue but does nothing`)
            started(name)
            done[field] = await work(done, deps)
            finished(name, field, stored(done[field]))
        }

        emit({type: 'brief-cost', ...spend})
        emit({type: 'done', spec: done.spec})
        return done.spec
    } catch (error) {
        // Every way out of a run says so, on one of two events, and this is the only place that
        // decides which. A stop is the user's; everything else is a failure that names where it
        // happened. The catch-all is the point: a probe that threw, a question the backend refused,
        // a fault in here — all three used to leave the process with no event at all, so the panel
        // showing the run kept a spinner and then vanished, taking the way out of a failed plan
        // with it.
        if (error instanceof PhaseStopped) {
            emit({type: 'brief-stopped', phase: error.phase})
            return null
        }
        const phase = error?.phase ?? atPhase
        const reason =
            error instanceof PhaseFailed ? error.reason
            : error instanceof Error ? error.message
            : String(error)
        emit({type: 'brief-failed', phase, reason})
        // Rethrown for anything this file did not expect, so the exit code still says the worker
        // broke. The two typed endings are outcomes of a run that worked; this is not one.
        if (error instanceof PhaseFailed || error instanceof BriefExpired) return null
        throw error
    }
}

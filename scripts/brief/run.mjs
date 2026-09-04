import {
    briefCost,
    briefDone,
    briefFailed,
    briefLog,
    briefPhase,
    briefPhaseStart,
    briefQuestionSettled,
    briefStarted,
    briefStopped,
    briefWorker,
    briefWorkerDone,
    briefWorkerStep
} from '../ai-events.mjs'
import {createModelContext} from '../ai-provider.mjs'
import {createChildTools, eventProgress, runSubagentOutcome} from '../ai-subagent.mjs'
import {modelReadsImages} from '../agent-runtime.mjs'
import {probeTools} from '../ai-reachability.mjs'
import {BRIEF_PHASES} from './catalogue.mjs'
import {PhaseFailed, PhaseStopped, compose, grill, refine, research} from './phases.mjs'
import {appendNoThink} from './prompts.mjs'

export {BRIEF_PHASES}

export const ASK_TOOL_NAME = 'ask_user'

// Cancelling sends the cancel line and this question's rejection down one pipe from two
// threads, so the rejection can arrive first, with the abort flag not yet set. Reading the
// code is what tells a cancelled run from a failed one.
const CANCELLED_QUESTION = 'question_cancelled'

const PHASE_WORK = {
    refine: (done, deps) => refine(done.prompt, deps),
    research: (done, deps) => research(done.refined, deps),
    grill: (done, deps) => grill(done.refined, done.research, deps),
    compose: (done, deps) => compose(done.refined, done.research, done.qa, deps)
}

const stored = value => (typeof value === 'string' ? value : JSON.stringify(value))

function everyPhaseTool(canSearch) {
    return canSearch ?
            ['read', 'bash', 'godot_docs_search', 'web_search']
        :   ['read', 'bash', 'godot_docs_search']
}

export function searchConfigured(settings, braveApiKey) {
    const provider = settings?.web?.searchProvider ?? 'exa'
    return provider !== 'brave' || Boolean(braveApiKey)
}

export function asImageContent(images) {
    return images.map(image => ({type: 'image', data: image.data, mimeType: image.mimeType}))
}

function addSpend(total, usage) {
    return {
        input: total.input + (usage?.input ?? 0),
        output: total.output + (usage?.output ?? 0)
    }
}

export const LIVE_WORLD = {createModelContext, createChildTools, probeTools, runSubagentOutcome}

export async function runBrief({
    settings,
    secrets = {},
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
    world = LIVE_WORLD
}) {
    if (typeof prompt !== 'string' || prompt.trim().length === 0) {
        throw new Error('The brief was given no task to work from')
    }
    const {models, model, subagent, streamOptions, probe} = world.createModelContext({
        settings,
        secrets,
        oauthCredential,
        credentialHost,
        sessionId,
        signal
    })
    emit(briefStarted())
    const pictures = modelReadsImages(subagent.model) ? asImageContent(images) : []
    if (images.length > 0 && pictures.length === 0) {
        emit(
            briefLog(
                `the plan's model cannot read images, so the ${String(images.length)} attached `
                    + 'to the ask were left out of it'
            )
        )
    }
    const canSearch = searchConfigured(settings, secrets.brave)
    const childDeps = {
        domains,
        host,
        braveApiKey: secrets.brave,
        searchProvider: settings?.web?.searchProvider
    }

    let spend = {input: 0, output: 0}
    let atPhase = 'startup'

    const runWorker = async ({label, prompt: text, toolNames, images: pictures = []}) => {
        emit(briefWorker(label))
        const outcome = await world.runSubagentOutcome({
            progress: eventProgress(emit, briefWorkerStep, {label}),
            prompt: appendNoThink(text),
            images: pictures,
            toolNames,
            workspacePath,
            models,
            model: subagent.model,
            thinkingLevel: subagent.thinkingLevel,
            streamOptions,
            settings: settings?.subagent,
            probe,
            deps: childDeps,
            signal
        })
        // Nothing bounds a plan but the Cancel button, so the number the user decides on has
        // to climb while they are deciding rather than arrive once the run is over.
        if (outcome.kind === 'ok') {
            spend = addSpend(spend, outcome.usage)
            emit(briefCost(spend))
        }
        return outcome
    }

    const deps = {
        runWorker,
        images: pictures,
        inventory,
        existingFiles,
        planContext,
        canSearch,
        answersItsOwnQuestions: settings?.plan?.answersItsOwnQuestions === true,
        log: message => emit(briefLog(message)),
        onWorker: (section, kind) => emit(briefWorkerDone(section, kind)),
        onQuestion: (question, outcome) => emit(briefQuestionSettled(question.question, outcome)),
        askUser: async question => {
            const answer = await stoppableCall(() =>
                host.call(
                    ASK_TOOL_NAME,
                    {
                        question: question.question,
                        options: question.options,
                        why: question.why,
                        canStopAsking: true
                    },
                    signal
                )
            )
            const text = typeof answer?.answer === 'string' ? answer.answer.trim() : ''
            return {
                answer: text.length > 0 ? text : null,
                stopAsking: answer?.stopAsking === true
            }
        }
    }

    const stoppableCall = async run => {
        try {
            return await run()
        } catch (error) {
            const cancelled =
                signal?.aborted || String(error?.message ?? '').startsWith(CANCELLED_QUESTION)
            if (cancelled) throw new PhaseStopped(atPhase)
            throw error
        }
    }

    const started = phase => {
        atPhase = phase
        emit(briefPhaseStart(phase))
    }
    const finished = (phase, field, value) => emit(briefPhase(phase, field, value))

    try {
        const {env, tools} = world.createChildTools(workspacePath, {
            toolNames: everyPhaseTool(canSearch),
            deps: childDeps
        })
        try {
            await stoppableCall(() => world.probeTools({tools, host, workspacePath, signal}))
        } finally {
            await env.cleanup()
        }

        const done = {prompt}
        for (const {name, field} of BRIEF_PHASES) {
            const work = PHASE_WORK[name]
            if (!work) throw new Error(`The ${name} phase is in the catalogue but does nothing`)
            started(name)
            done[field] = await work(done, deps)
            finished(name, field, stored(done[field]))
        }

        emit(briefDone(done.spec))
        return done.spec
    } catch (error) {
        if (error instanceof PhaseStopped) {
            emit(briefStopped(error.phase))
            return null
        }
        const phase = error?.phase ?? atPhase
        const reason =
            error instanceof PhaseFailed ? error.reason
            : error instanceof Error ? error.message
            : String(error)
        emit(briefFailed(phase, reason))
        if (error instanceof PhaseFailed) return null
        throw error
    }
}

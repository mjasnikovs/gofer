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

export const BRIEF_DEADLINE_MS = 20 * 60 * 1000

export class BriefExpired extends Error {
    constructor(phase, elapsedMs) {
        super(`the plan was still on ${phase} after ${Math.round(elapsedMs / 60_000)} minutes`)
        this.phase = phase
    }
}

export function guardDeadline(phase, elapsedMs, deadlineMs = BRIEF_DEADLINE_MS) {
    if (deadlineMs > 0 && elapsedMs > deadlineMs) throw new BriefExpired(phase, elapsedMs)
}

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
    now = () => Date.now(),
    deadlineMs = BRIEF_DEADLINE_MS,
    world = LIVE_WORLD
}) {
    if (typeof prompt !== 'string' || prompt.trim().length === 0) {
        throw new Error('The brief was given no task to work from')
    }
    const {models, model, subagent, streamOptions} = world.createModelContext({
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
    let waitedOnTheUser = 0
    const startedAt = now()
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
            deps: childDeps,
            signal
        })
        if (outcome.kind === 'ok') spend = addSpend(spend, outcome.usage)
        return outcome
    }

    const deps = {
        runWorker,
        images: pictures,
        inventory,
        existingFiles,
        planContext,
        canSearch,
        guard: phase => guardDeadline(phase, now() - startedAt - waitedOnTheUser, deadlineMs),
        log: message => emit(briefLog(message)),
        onWorker: (section, kind) => emit(briefWorkerDone(section, kind)),
        onQuestion: (question, outcome) => emit(briefQuestionSettled(question.question, outcome)),
        askUser: async question => {
            const askedAt = now()
            const answer = await stoppableCall(() =>
                host.call(
                    ASK_TOOL_NAME,
                    {
                        question: question.question,
                        options: question.options,
                        why: question.why
                    },
                    signal
                )
            )
            waitedOnTheUser += now() - askedAt
            const text = typeof answer?.answer === 'string' ? answer.answer.trim() : ''
            return text.length > 0 ? text : null
        }
    }

    const stoppableCall = async run => {
        try {
            return await run()
        } catch (error) {
            if (signal?.aborted) throw new PhaseStopped(atPhase)
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

        emit(briefCost(spend))
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
        if (error instanceof PhaseFailed || error instanceof BriefExpired) return null
        throw error
    }
}

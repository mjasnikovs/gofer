import {classifyWorkerOutcome, degradedSection, emptySection} from './outcome.mjs'
import {
    NO_COMMANDS,
    apisPrompt,
    autoAnswerPrompt,
    composePrompt,
    contextPrompt,
    filesPrompt,
    grillPrompt,
    refinePrompt,
    scopedGoal,
    toolingPrompt
} from './prompts.mjs'

export class PhaseFailed extends Error {
    constructor(phase, reason) {
        super(`The ${phase} phase could not finish: ${reason}`)
        this.phase = phase
        this.reason = reason
    }
}

export class PhaseStopped extends Error {
    constructor(phase) {
        super(`The ${phase} phase was stopped`)
        this.phase = phase
    }
}

async function ask(phase, deps, spec) {
    const verdict = classifyWorkerOutcome(await deps.runWorker(spec), {partial: spec.partial ?? ''})
    if (verdict.kind === 'stopped') throw new PhaseStopped(phase)
    if (verdict.kind === 'fatal') throw new PhaseFailed(phase, verdict.reason)
    return verdict
}

export async function refine(raw, deps = {}) {
    const pictures = deps.images ?? []
    const verdict = await ask('refine', deps, {
        label: 'refine',
        toolNames: ['read'],
        images: pictures,
        prompt: refinePrompt(raw, {
            existingFiles: deps.existingFiles,
            planContext: deps.planContext,
            pictures: pictures.length
        })
    })
    if (verdict.kind === 'ok') return verdict.text
    deps.log?.(`refine produced nothing usable; carrying the task through unchanged`)
    return raw
}

const ANSWER_OR_SAY_NOTHING =
    'STOP. Your previous attempt returned an EMPTY answer — zero characters. That cannot be '
    + 'accepted, because it is indistinguishable from a worker that crashed before it wrote '
    + 'anything. Answer again, and do the work this time: look first, then write what you found, in '
    + 'the format below. Only if you have looked and there is genuinely nothing to report — this '
    + 'task touches no existing file, needs no external symbol, or this project has no such command '
    + '— write exactly `(none)` and nothing else. Never answer with silence.\n\n'

export const RESEARCH_WORKERS = [
    {
        section: 'FILES',
        label: 'files',
        toolNames: ['read', 'bash'],
        build: (refined, deps) => filesPrompt(refined, {inventory: deps.inventory})
    },
    {
        section: 'APIS',
        label: 'apis',
        toolNames: deps =>
            deps.canSearch ?
                ['read', 'bash', 'godot_docs_search', 'web_search']
            :   ['read', 'bash', 'godot_docs_search'],
        build: (refined, deps, done) =>
            apisPrompt(refined, {
                inventory: deps.inventory,
                files: done.FILES,
                canSearch: deps.canSearch
            })
    },
    {
        section: 'CONTEXT',
        label: 'context',
        toolNames: ['read', 'bash'],
        build: (refined, deps) => contextPrompt(refined, {inventory: deps.inventory})
    },
    {
        section: 'TOOLING',
        label: 'tooling',
        toolNames: ['read', 'bash'],
        build: refined => toolingPrompt(scopedGoal(refined))
    }
]

export async function research(refined, deps = {}) {
    const done = {}
    for (const worker of RESEARCH_WORKERS) {
        const toolNames =
            typeof worker.toolNames === 'function' ? worker.toolNames(deps) : worker.toolNames
        const prompt = worker.build(refined, deps, done)
        let verdict = await ask('research', deps, {
            label: `worker:${worker.label}`,
            toolNames,
            prompt
        })
        if (verdict.kind === 'empty') {
            verdict = await ask('research', deps, {
                label: `worker:${worker.label}`,
                toolNames,
                prompt: `${ANSWER_OR_SAY_NOTHING}${prompt}`
            })
        }
        const text =
            verdict.kind === 'ok' ? verdict.text
            : verdict.kind === 'runaway' ?
                degradedSection(worker.section, verdict.reason, verdict.text)
            :   emptySection(worker.section)
        done[worker.section] = text
        deps.onWorker?.(worker.section, verdict.kind)
    }
    return RESEARCH_WORKERS.map(worker => done[worker.section]).join('\n\n')
}

export function parseQuestion(text) {
    const body = (text ?? '').trim()
    if (body.length === 0 || /^NONE\b/iu.test(body)) return null
    const question = /^QUESTION:\s*(.+)$/mu.exec(body)
    if (!question) return null
    const a = /^A:\s*(.+)$/mu.exec(body)
    const b = /^B:\s*(.+)$/mu.exec(body)
    const why = /^WHY:\s*(.+)$/mu.exec(body)
    return {
        question: question[1].trim(),
        options: [a?.[1].trim(), b?.[1].trim()].filter(Boolean),
        why: why?.[1].trim() ?? ''
    }
}

export function parseAutoAnswer(text) {
    const answered = /^ANSWER:\s*([\s\S]+)$/mu.exec((text ?? '').trim())
    return answered ? answered[1].trim() : null
}

async function answerFromResearch(question, refined, research, deps) {
    if (!deps.answersItsOwnQuestions) return null
    const attempted = await ask('grill', deps, {
        label: 'grill:answer',
        toolNames: ['read'],
        prompt: autoAnswerPrompt(question.question, refined, research)
    })
    return attempted.kind === 'ok' ? parseAutoAnswer(attempted.text) : null
}

const sameQuestion = text =>
    text
        .toLowerCase()
        .replace(/[^a-z0-9]+/gu, ' ')
        .trim()

export async function grill(refined, research, deps = {}) {
    const settled = []
    const asked = []
    const alreadyAsked = new Set()
    for (;;) {
        const generated = await ask('grill', deps, {
            label: 'grill',
            toolNames: ['read'],
            prompt: grillPrompt(refined, research, {asked: asked.join('\n')})
        })
        if (generated.kind !== 'ok') break
        const question = parseQuestion(generated.text)
        if (!question) break
        // ALREADY ASKED is a sentence in a prompt, and a prompt enforces nothing. Without the round
        // count there is no other floor under a model that keeps putting the same question back —
        // and with the answering setting on, no user sees it happening.
        if (alreadyAsked.has(sameQuestion(question.question))) break
        alreadyAsked.add(sameQuestion(question.question))
        asked.push(`- ${question.question}`)

        const automatic = await answerFromResearch(question, refined, research, deps)
        if (automatic) {
            settled.push({...question, answer: automatic, from: 'research'})
            deps.onQuestion?.(question, 'answered')
            continue
        }

        // Nothing else ends the loop now that the round count is gone, and a caller with
        // nobody to ask would put the same question back forever.
        if (!deps.askUser) {
            settled.push({
                ...question,
                answer: '(open — nobody was available to decide)',
                from: 'open'
            })
            deps.onQuestion?.(question, 'open')
            break
        }
        const {answer, stopAsking} = await deps.askUser(question)
        settled.push({
            ...question,
            answer: answer ?? '(skipped — left to the implementer)',
            from: answer ? 'user' : 'skipped'
        })
        deps.onQuestion?.(question, answer ? 'user' : 'skipped')
        if (stopAsking) break
    }
    return settled
}

export function formatAnswers(settled) {
    return settled.map(entry => `- ${entry.question}\n  ${entry.answer}`).join('\n')
}

function verifyBlockBody(spec) {
    const match = /^VERIFY[ \t]*\n+```(?:sh|bash)?[ \t]*\n([\s\S]*?)\n```/mu.exec(spec ?? '')
    return match ? match[1] : null
}

function verifyLines(spec) {
    const body = verifyBlockBody(spec)
    if (body === null) return null
    const lines = body
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0 && !line.startsWith('#'))
    return lines.length > 0 ? lines : null
}

export function parseVerifyBlock(spec) {
    const commands = (verifyLines(spec) ?? []).filter(line => line !== NO_COMMANDS)
    return commands.length > 0 ? commands : null
}

export function declaresNoCommands(spec) {
    const lines = verifyLines(spec)
    return lines !== null && lines.length === 1 && lines[0] === NO_COMMANDS
}

export function parseVerifyPoints(spec) {
    const body = verifyBlockBody(spec)
    if (body === null) return null
    const points = []
    let pending = ''
    for (const raw of body.split('\n')) {
        const line = raw.trim()
        if (line.length === 0) {
            pending = ''
            continue
        }
        if (line.startsWith('#')) {
            pending = line.replace(/^#+[ \t]*/u, '').trim()
            continue
        }
        if (line === NO_COMMANDS) {
            pending = ''
            continue
        }
        points.push({name: pending.length > 0 ? pending : line, command: line})
        pending = ''
    }
    return points.length > 0 ? points : null
}

export function stripPreamble(spec) {
    const at = (spec ?? '').search(/^GOAL[ \t]*$/mu)
    return at <= 0 ? (spec ?? '').trim() : spec.slice(at).trim()
}

const NEEDS_VERIFY =
    'STOP. Your previous draft had no VERIFY block. A specification without one cannot be checked '
    + 'and will not be accepted. Write the whole specification again, and end it with a VERIFY '
    + 'section holding a fenced ```sh block with one shell command per line, taken from the TOOLING '
    + `section of the research — or holding exactly \`${NO_COMMANDS}\` if TOOLING lists no command. `
    + 'Do not invent one to fill the block. Nothing else about the draft needs to change.\n\n'

export async function compose(refined, researchText, settled, deps = {}) {
    const prompt = composePrompt(refined, researchText, formatAnswers(settled ?? []))
    for (const attempt of [prompt, `${NEEDS_VERIFY}${prompt}`]) {
        const verdict = await ask('compose', deps, {
            label: 'compose',
            toolNames: [],
            prompt: attempt
        })
        if (verdict.kind !== 'ok') continue
        const spec = stripPreamble(verdict.text)
        if (parseVerifyBlock(spec) || declaresNoCommands(spec)) return spec
        deps.log?.('compose wrote a specification with no VERIFY block; asking again')
    }
    throw new PhaseFailed('compose', 'it could not write a specification that can be verified')
}

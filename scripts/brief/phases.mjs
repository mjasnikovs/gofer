import {classifyWorkerOutcome, degradedSection, emptySection} from './outcome.mjs'
import {findPhantomPaths, formatPathCorrections} from './phantom.mjs'
import {applyRefutations} from './refuted.mjs'
import {
    extractToolingCommands,
    onlyClaimedCommands,
    parseVerifyToolingOutput,
    rejectedEveryCommand,
    replaceToolingWithVerified
} from './tooling.mjs'
import {
    NO_COMMANDS,
    apisPrompt,
    autoAnswerPrompt,
    composePrompt,
    contextPrompt,
    critiquePrompt,
    filesPrompt,
    grillPrompt,
    refinePrompt,
    scopedGoal,
    toolingPrompt,
    verifyToolingPrompt
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
                ['read', 'bash', 'godot_docs_search', 'godot_script', 'web_search']
            :   ['read', 'bash', 'godot_docs_search', 'godot_script'],
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
        build: (refined, deps, done) =>
            contextPrompt(refined, {inventory: deps.inventory, files: done.FILES})
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
    const assembled = RESEARCH_WORKERS.map(worker => done[worker.section]).join('\n\n')
    return await correctPaths(await verifyTooling(assembled, deps), refined, deps)
}

/**
 * A worker that may degrade the phase rather than end it.
 *
 * `ask` throws on any cause, which is right for a research section — a missing one is a
 * hole in the spec. These two run AFTER the sections are in hand, so their failure costs
 * a correction, not the plan. Only a stop still propagates; nothing survives that.
 */
async function attempt(deps, spec) {
    const verdict = classifyWorkerOutcome(await deps.runWorker(spec))
    if (verdict.kind === 'stopped') throw new PhaseStopped('research')
    return verdict.kind === 'ok' ? verdict.text : null
}

/**
 * Run the commands TOOLING claims, and keep only the ones that ran.
 *
 * TOOLING is the one research section that is a claim about the future rather than a
 * report of something read, and compose picks its VERIFY block out of it. An unrun
 * command reaches the implementer as a step that always fails.
 */
export async function verifyTooling(research, deps = {}) {
    const commands = extractToolingCommands(research)
    if (commands.length === 0) return research
    const answer = await attempt(deps, {
        label: 'verify-tooling',
        toolNames: ['read', 'bash'],
        prompt: verifyToolingPrompt(commands)
    })
    if (answer === null) {
        deps.log?.('the tooling commands could not be run; they reach the spec unverified')
        return research
    }
    const {verified, rejected} = parseVerifyToolingOutput(answer)
    const kept = onlyClaimedCommands(verified, commands)
    for (const line of verified.filter(one => !kept.includes(one)))
        deps.log?.(`tooling verdict names a command nobody ran, so it is dropped: ${line}`)
    for (const line of rejected) deps.log?.(`tooling rejected: ${line}`)
    // Nothing to keep is only a verdict of total failure when every command was rejected by name.
    // A partial, empty, or renamed verdict is an answer this pass could not read; rewriting the
    // section then states a failure that never happened and empties the menu.
    if (kept.length === 0 && !rejectedEveryCommand(rejected, commands)) {
        deps.log?.('the tooling verdict could not be read; the commands reach the spec unverified')
        return research
    }
    deps.onWorker?.('TOOLING', kept.length > 0 ? 'ok' : 'empty')
    return replaceToolingWithVerified(research, kept)
}

/** Say so where the task names a file of this project that the project does not have. */
async function correctPaths(research, refined, deps) {
    if (!deps.workspacePath) return research
    const missing = await findPhantomPaths(refined, deps.workspacePath, deps.pathExists)
    const corrections = formatPathCorrections(missing)
    if (corrections.length === 0) return research
    deps.log?.(
        `the task names ${String(missing.length)} path this project does not have: ${missing.join(', ')}`
    )
    return `${research}\n\n${corrections}`
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

export function formatAnswers(settled) {
    return settled.map(entry => `- ${entry.question}\n  ${entry.answer}`).join('\n')
}

const sameQuestion = text =>
    text
        .toLowerCase()
        .replace(/[^a-z0-9]+/gu, ' ')
        .trim()

export async function grill(refined, research, deps = {}) {
    const settled = []
    const alreadyAsked = new Set()
    for (;;) {
        // The whole Q&A goes forward, not the questions alone: a question is adaptive only
        // if the model can see what the last answer decided, what it opened, and what it
        // left unsettled. Feeding back the questions by themselves made every round after
        // the first ask into a vacuum.
        const generated = await ask('grill', deps, {
            label: 'grill',
            toolNames: ['read'],
            prompt: grillPrompt(refined, research, {decisions: formatAnswers(settled)})
        })
        if (generated.kind !== 'ok') break
        const question = parseQuestion(generated.text)
        if (!question) break
        // ALREADY ASKED is a sentence in a prompt, and a prompt enforces nothing. Without the round
        // count there is no other floor under a model that keeps putting the same question back —
        // and with the answering setting on, no user sees it happening.
        if (alreadyAsked.has(sameQuestion(question.question))) break
        alreadyAsked.add(sameQuestion(question.question))

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

/// A verification line that reaches the editor instead of the shell: the tool name, then one JSON
/// object. `contains` is the parser's own key — the text the answer must hold — so it never
/// reaches the tool.
///
/// Only the running game. A point runs unattended and skips the operation allowlist a child tool
/// goes through, and `godot_node` delete and `godot_scene` save are auto-allowed; a check would be
/// able to edit the project it exists to measure.
const TOOL_POINT = /^(godot_runtime)[ \t]+(\{[\s\S]*\})$/u

function toolPoint(line) {
    const match = TOOL_POINT.exec(line)
    if (!match) return null
    let written
    try {
        written = JSON.parse(match[2])
    } catch {
        return null
    }
    if (!written || typeof written !== 'object' || Array.isArray(written)) return null
    const {contains, ...params} = written
    return {
        tool: match[1],
        params,
        ...(typeof contains === 'string' && contains.length > 0 ? {contains} : {})
    }
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
        points.push({
            name: pending.length > 0 ? pending : line,
            command: line,
            ...(toolPoint(line) ?? {})
        })
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
    + 'section holding a fenced ```sh block with one check per line — a shell command from the '
    + 'TOOLING section of the research, or a `godot_runtime {"ops": [...], "contains": "..."}` call '
    + `— or holding exactly \`${NO_COMMANDS}\` if there is nothing to run. Do not invent one to `
    + 'fill the block. Nothing else about the draft needs to change.\n\n'

export async function compose(refined, researchText, settled, deps = {}) {
    const dropped = applyRefutations(refined, researchText)
    for (const line of dropped.trail) deps.log?.(line)
    const prompt = composePrompt(dropped.refined, researchText, formatAnswers(settled ?? []))
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

const CRITIQUE_KEPT = 'the critique could not be read as a specification; the composed one stands'

const SPEC_SECTIONS = ['GOAL', 'CONSTRAINTS', 'STEPS', 'VERIFY']

/// Every section, not just a verifiable block: a critique that answers with the VERIFY fragment it
/// was faulting would otherwise replace the whole specification with that fragment.
function isWholeSpec(text) {
    if (!parseVerifyBlock(text) && !declaresNoCommands(text)) return false
    return SPEC_SECTIONS.every(name => new RegExp(`^${name}[ \\t]*$`, 'mu').test(text))
}

/**
 * Read the finished spec back against the task, the research and the decisions.
 *
 * Compose writes in one pass with no tools and everything it needs in the prompt, so it
 * cannot notice that it hardened an invention or that its VERIFY block proves a step
 * instead of the goal. This is the only phase whose input is a spec.
 *
 * It can only ever return a spec: a critique that comes back unreadable, or does not come
 * back, leaves the composed one exactly as it was. A correction step must not be able to
 * cost the plan the answer it already had.
 */
export async function critique(refined, researchText, settled, spec, deps = {}) {
    // The same subtraction compose read. Handed the original task, the critique is told a
    // constraint research refuted is authoritative, and puts back what compose was denied.
    const {refined: task} = applyRefutations(refined, researchText)
    const verdict = classifyWorkerOutcome(
        await deps.runWorker({
            label: 'critique',
            toolNames: [],
            prompt: critiquePrompt(spec, task, researchText, formatAnswers(settled ?? []))
        })
    )
    if (verdict.kind === 'stopped') throw new PhaseStopped('critique')
    if (verdict.kind !== 'ok') {
        deps.log?.('the critique did not answer; the composed specification stands')
        return spec
    }
    const corrected = stripPreamble(verdict.text)
    if (!isWholeSpec(corrected)) {
        deps.log?.(CRITIQUE_KEPT)
        return spec
    }
    return corrected
}

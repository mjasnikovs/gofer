/**
 * The four phases, each a function from what it is given to what it produces.
 *
 * None of them knows it is part of a brief. None knows about a database, a task id, a window or a
 * chat. A phase takes text and dependencies and returns text — which is what makes any one of them
 * usable on its own, and what makes all four testable without a model, a worktree or a backend.
 *
 * The one dependency they all share is `runWorker`, a function that runs one bounded child and
 * answers with a verdict from `classifyWorkerOutcome`. Everything each phase decides — which failure
 * degrades, which retries, what a silent worker means — is a pure function of that verdict, so a test
 * substitutes the verdict rather than driving a model to produce one.
 */

import {classifyWorkerOutcome, degradedSection, emptySection} from './outcome.mjs'
import {
    MAX_QUESTIONS,
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

/**
 * Raised when a phase cannot produce anything trustworthy.
 *
 * Typed rather than a bare `Error` because the pipeline reports a cancelled run and a broken run
 * differently, and because `phase` is what tells the user where a fifteen-minute run stopped.
 */
export class PhaseFailed extends Error {
    constructor(phase, reason) {
        super(`The ${phase} phase could not finish: ${reason}`)
        this.phase = phase
        this.reason = reason
    }
}

/** Raised, rather than returned, when the user stopped the run. Never degraded past. */
export class PhaseStopped extends Error {
    constructor(phase) {
        super(`The ${phase} phase was stopped`)
        this.phase = phase
    }
}

/**
 * Run one worker and answer with its verdict, raising the endings no phase may continue past.
 *
 * Every phase funnels through this so the rules that must never differ per phase — a stop is not a
 * failure, a reported cause is not partial data, and a run past its ceiling starts no more work —
 * are written once. `deps.guard` is what the caller uses to say the run is over; it raises, and
 * phases pass it through, because a phase has nothing useful to do with that answer.
 */
async function ask(phase, deps, spec) {
    deps.guard?.(phase)
    const verdict = classifyWorkerOutcome(await deps.runWorker(spec), {partial: spec.partial ?? ''})
    if (verdict.kind === 'stopped') throw new PhaseStopped(phase)
    if (verdict.kind === 'fatal') throw new PhaseFailed(phase, verdict.reason)
    return verdict
}

// ─── refine ──────────────────────────────────────────────────────────────────

/**
 * The raw ask, sharpened into a GOAL and CONSTRAINTS the later phases can scope by.
 *
 * The one phase shown the pictures the ask came with, because it is the one that reads the ask
 * itself — the three after it read what this one wrote. That is enough: a screenshot is something
 * the ask is ABOUT, and what this phase writes down about it is what the rest of the run works
 * from.
 *
 * Kept even though it costs a whole model call, because the three phases after it read a shape rather
 * than a sentence: the research workers bound themselves by the GOAL, and `scopedGoal` cuts the
 * tooling worker's view at its first bullet. Handed a one-line ask instead, they have nothing to
 * bound themselves with and explore the whole tree.
 *
 * Degrades rather than failing on an empty answer. Its deliverable is producible from the ask alone,
 * so a refine that could not settle is better replaced by the raw text than allowed to end the run.
 */
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

// ─── research ────────────────────────────────────────────────────────────────

/**
 * Prepended on the one retry an empty section earns.
 *
 * A zero-length answer is ambiguous — a worker that crashed and a worker with nothing to say look
 * identical — so the retry's only job is to remove the ambiguity: answer properly, or say so in as
 * many words. The `(none)` exit sits behind an explicit "after you have looked", because this also
 * fires on a healthy project where the first attempt died for an unrelated reason, and an easy way
 * out there would silence real research.
 */
const ANSWER_OR_SAY_NOTHING =
    'STOP. Your previous attempt returned an EMPTY answer — zero characters. That cannot be '
    + 'accepted, because it is indistinguishable from a worker that crashed before it wrote '
    + 'anything. Answer again, and do the work this time: look first, then write what you found, in '
    + 'the format below. Only if you have looked and there is genuinely nothing to report — this '
    + 'task touches no existing file, needs no external symbol, or this project has no such command '
    + '— write exactly `(none)` and nothing else. Never answer with silence.\n\n'

/**
 * The four workers, in the order their sections are assembled.
 *
 * Order is fixed here and the assembly below follows it rather than completion order, so the same
 * task produces the same research text every time — a section list that reorders itself run to run
 * is a diff nobody can read.
 *
 * Each worker gets one job and the narrowest tools that job needs. CONTEXT is deliberately not given
 * the APIS worker's output: it holds read and grep only, so widening what it may assert without
 * widening what it can check would just move an unsourced claim from one section to another.
 */
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
        // The only worker that reaches past the worktree, because it is the only one whose answer is
        // about things the worktree does not contain.
        toolNames: deps =>
            deps.canSearch ?
                ['read', 'bash', 'godot_docs_search', 'web_search']
            :   ['read', 'bash', 'godot_docs_search'],
        build: (refined, deps, done) =>
            apisPrompt(refined, {
                inventory: deps.inventory,
                // The finished FILES map rides along so this worker does not spend its own steps
                // re-deriving where things live — the question the previous worker just answered.
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
        // Scoped to the goal prose. The per-file checklist a large refined prompt carries makes a
        // small model spelunk source it has no use for until it runs out of steps.
        build: refined => toolingPrompt(scopedGoal(refined))
    }
]

/**
 * What the four workers found, as one assembled document.
 *
 * There is deliberately no per-worker cache here. One would make a resume cheap — a worker whose
 * section is already stored could be skipped rather than re-run — but nothing resumes a brief, so a
 * cache would be machinery with no caller and tests that read as validation of a path production
 * never takes. Bring it back with the resume that needs it, not before.
 */
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

// ─── grill ───────────────────────────────────────────────────────────────────

/** One `QUESTION:`/`A:`/`B:` block, or null when the worker said there is nothing left to ask. */
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

/**
 * An auto-answer, or null when the worker declined to invent one.
 *
 * `UNKNOWN:` is a real answer to a different question — it says a person has to decide — so it is
 * read as "ask the user", never as a failure. Anything carrying neither tag is treated the same way:
 * a reply that ignored the format is not evidence that the question is settled.
 */
export function parseAutoAnswer(text) {
    const answered = /^ANSWER:\s*([\s\S]+)$/mu.exec((text ?? '').trim())
    return answered ? answered[1].trim() : null
}

/**
 * The questions the spec cannot be written without, answered from research where that is honest and
 * from the user where it is not.
 *
 * One question at a time, each generated knowing what has already been asked, because the answer to
 * one changes whether the next is worth asking at all. Capped, because a model that never says NONE
 * would otherwise ask forever.
 *
 * `deps.askUser` is optional. Without it — a run nobody is watching — an unanswered question is
 * recorded as open rather than blocking, which is the difference between a spec with a known gap and
 * a pipeline that waits for somebody who is not there.
 */
export async function grill(refined, research, deps = {}) {
    const settled = []
    const asked = []
    for (let round = 0; round < MAX_QUESTIONS; round += 1) {
        const generated = await ask('grill', deps, {
            label: 'grill',
            toolNames: ['read'],
            prompt: grillPrompt(refined, research, {asked: asked.join('\n')})
        })
        if (generated.kind !== 'ok') break
        const question = parseQuestion(generated.text)
        if (!question) break
        asked.push(`- ${question.question}`)

        const attempted = await ask('grill', deps, {
            label: 'grill:answer',
            toolNames: ['read'],
            prompt: autoAnswerPrompt(question.question, refined, research)
        })
        const automatic = attempted.kind === 'ok' ? parseAutoAnswer(attempted.text) : null
        if (automatic) {
            settled.push({...question, answer: automatic, from: 'research'})
            deps.onQuestion?.(question, 'answered')
            continue
        }

        if (!deps.askUser) {
            settled.push({
                ...question,
                answer: '(open — nobody was available to decide)',
                from: 'open'
            })
            deps.onQuestion?.(question, 'open')
            continue
        }
        const answer = await deps.askUser(question)
        // A skip is a decision too: the user saw the question and chose not to pin it, which is not
        // the same as the pipeline never having asked.
        settled.push({
            ...question,
            answer: answer ?? '(skipped — left to the implementer)',
            from: answer ? 'user' : 'skipped'
        })
        deps.onQuestion?.(question, answer ? 'user' : 'skipped')
    }
    return settled
}

/** The settled questions as the block compose reads them in. */
export function formatAnswers(settled) {
    return settled.map(entry => `- ${entry.question}\n  ${entry.answer}`).join('\n')
}

// ─── compose ─────────────────────────────────────────────────────────────────

/**
 * The meaningful lines of a spec's VERIFY block, or null when it has no block at all.
 *
 * Strict about the closing fence on purpose. A spec that opens ```` ```sh ```` and never closes it
 * would otherwise "have" a verify block holding every line to the end of the document, and a
 * downstream reader treating those as commands is worse off than one told there are none.
 */
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

/**
 * The commands a spec's VERIFY block would run, or null when it holds none.
 *
 * The no-commands sentinel is not one of them. It is the block saying there is nothing to run, so a
 * caller that ran it as a command would be running the word `(none)`.
 */
export function parseVerifyBlock(spec) {
    const commands = (verifyLines(spec) ?? []).filter(line => line !== NO_COMMANDS)
    return commands.length > 0 ? commands : null
}

/**
 * Whether the spec says, in the one wording compose is given, that this project has no command.
 *
 * The gate below accepts this as readily as a command. A spec is verifiable when it is honest about
 * how it can be checked, and "there is nothing to run here" is honest; a borrowed command that fails
 * on every project that does not define it is not.
 */
export function declaresNoCommands(spec) {
    const lines = verifyLines(spec)
    return lines !== null && lines.length === 1 && lines[0] === NO_COMMANDS
}

/**
 * The named points a spec's VERIFY block declares, or null when it declares none.
 *
 * A point is a command plus the name to call it by, and the name is the `#` comment written above
 * it. Nothing else in the format changes: the fence, the `sh` tag and the `(none)` sentinel are
 * what compose already writes, and the comment was already legal there — it was thrown away.
 *
 * The failure this closes: a run reports `npm run test:godot` and `godot --headless --script
 * .gofer/checks/centipede.gd` as two shell strings, so a reader watching a task cannot tell which
 * of them is the boss and which is the lint. Eleven planned tasks in one project wrote twelve
 * command lines between them and three were ever run; a line nobody can name is a line nobody
 * misses.
 *
 * A name labels the one command below it and no more. Two commands under one comment would
 * otherwise be two rows with the same label, which is worse in a list than a row labelled by its
 * own command — so an unnamed command falls back to naming itself, and a blank line clears a
 * pending name so a comment cannot reach past a gap to a command it was not written for.
 */
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
        // The sentinel is the block saying there is nothing to run. It is not a point, and a name
        // written above it belongs to nothing.
        if (line === NO_COMMANDS) {
            pending = ''
            continue
        }
        points.push({name: pending.length > 0 ? pending : line, command: line})
        pending = ''
    }
    return points.length > 0 ? points : null
}

/** Everything before the first bare GOAL heading — the narration a model writes before answering. */
export function stripPreamble(spec) {
    const at = (spec ?? '').search(/^GOAL[ \t]*$/mu)
    return at <= 0 ? (spec ?? '').trim() : spec.slice(at).trim()
}

/**
 * Prepended on the one retry a spec with no VERIFY block earns. Names the missing thing rather than
 * asking again, because asking again is what produced the draft that is already here.
 */
const NEEDS_VERIFY =
    'STOP. Your previous draft had no VERIFY block. A specification without one cannot be checked '
    + 'and will not be accepted. Write the whole specification again, and end it with a VERIFY '
    + 'section holding a fenced ```sh block with one shell command per line, taken from the TOOLING '
    + `section of the research — or holding exactly \`${NO_COMMANDS}\` if TOOLING lists no command. `
    + 'Do not invent one to fill the block. Nothing else about the draft needs to change.\n\n'

/**
 * The specification, assembled from everything the earlier phases produced.
 *
 * Gated on a VERIFY block that either runs commands or says there are none, and this is the only
 * gate the spec gets: with the critique phase out of scope there is nothing after this to catch a
 * draft that cannot be checked. One retry, then a typed failure — a third attempt on a model that
 * has now failed the same contract twice is spending time to produce the same draft.
 */
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

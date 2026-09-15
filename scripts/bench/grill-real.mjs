// The asking section exactly as the application runs it — the real sub-agent runner, the real
// read tool, the real grill loop — from a stored refined task and research. The user is played
// back from the stored answers. Arms are the sub-agent's thinking level.
//
//   GRILL_DIR=<dir with refined.txt research.txt qa.txt> WORKSPACE=<project> \
//     node scripts/bench/grill-real.mjs [seeds] [arms: medium,off]
import {appendFile, readFile} from 'node:fs/promises'
import {createModelContext} from '../ai-provider.mjs'
import {noProgress, runSubagentOutcome} from '../ai-subagent.mjs'
import {grill} from '../brief/phases.mjs'
import {appendNoThink} from '../brief/prompts.mjs'

const DIR = process.env.GRILL_DIR
const WORKSPACE = process.env.WORKSPACE
const OUT = process.env.OUT ?? `${DIR}/real-rows.jsonl`
const SEEDS = Number(process.argv[2] ?? 3)
// An arm is a thinking level, then flags: `noread` runs the grill call without its read tool,
// `tail` moves the DECISIONS block from the head of the prompt to its tail.
const ARMS = (process.argv[3] ?? 'medium,off').split(',')
const SETTINGS = `${process.env.HOME}/.config/com.gofer.desktop/settings.json`

const refined = await readFile(`${DIR}/refined.txt`, 'utf8')
const research = await readFile(`${DIR}/research.txt`, 'utf8')
const stored = JSON.parse(await readFile(`${DIR}/qa.txt`, 'utf8'))
const settings = JSON.parse(await readFile(SETTINGS, 'utf8')).ai

const {models, subagent, streamOptions, probe} = createModelContext({
    settings,
    secrets: {},
    sessionId: 'bench-grill'
})

const words = text =>
    new Set(
        text
            .toLowerCase()
            .replace(/[^a-z0-9 ]+/gu, ' ')
            .split(/\s+/u)
            .filter(w => w.length > 3)
    )

// The stored user, replayed: the closest stored question by word overlap answers, else option A.
function playUser(question) {
    const asked = words(question.question)
    let best = null
    let score = 0
    for (const entry of stored) {
        const have = words(entry.question)
        let common = 0
        for (const w of asked) if (have.has(w)) common += 1
        const overlap = common / Math.max(1, Math.min(asked.size, have.size))
        if (overlap > score) {
            score = overlap
            best = entry
        }
    }
    if (best && score >= 0.5) return {answer: best.answer, from: 'stored', score}
    return {answer: question.options[0] ?? '(skipped)', from: 'optionA', score}
}

// Same words, the decisions moved from the head of the prompt to its tail.
function decisionsOnTail(text) {
    const start = text.indexOf('DECISIONS SO FAR')
    if (start === -1) return text
    const end = text.indexOf('RESEARCH\n', start)
    return `${text.slice(0, start)}${text.slice(end)}\n\n${text.slice(start, end).trimEnd()}`
}

// A question that overlaps an earlier one this much was asked before in other words.
function repeats(settled) {
    const seen = []
    let count = 0
    for (const entry of settled) {
        const asked = words(entry.question)
        const again = seen.some(have => {
            let common = 0
            for (const w of asked) if (have.has(w)) common += 1
            return common / Math.max(1, Math.min(asked.size, have.size)) >= 0.6
        })
        if (again) count += 1
        seen.push(asked)
    }
    return count
}

async function runArm(arm, seed) {
    const calls = []
    const [level, ...flags] = arm.split(':')
    const noread = flags.includes('noread')
    const tail = flags.includes('tail')
    // The call's own level wins, as it does in run.mjs; the arm is the sub-agent default.
    const runWorker = async ({label, prompt, toolNames, thinkingLevel}) => {
        const started = Date.now()
        let steps = 0
        const outcome = await runSubagentOutcome({
            progress: () => {
                steps += 1
            },
            prompt: appendNoThink(tail ? decisionsOnTail(prompt) : prompt),
            toolNames: noread ? [] : toolNames,
            workspacePath: WORKSPACE,
            models,
            model: subagent.model,
            thinkingLevel: thinkingLevel ?? level,
            streamOptions,
            settings: settings.subagent,
            probe,
            deps: {domains: []}
        })
        calls.push({
            label,
            kind: outcome.kind,
            wallMs: Date.now() - started,
            steps,
            input: outcome.usage?.input ?? 0,
            cacheRead: outcome.usage?.cacheRead ?? 0,
            output: outcome.usage?.output ?? 0,
            text: (outcome.text ?? '').slice(0, 400)
        })
        return outcome
    }
    const rounds = []
    const settled = await grill(refined, research, {
        runWorker,
        answersItsOwnQuestions: false,
        onQuestion: (question, outcome) => rounds.push({question: question.question, outcome}),
        askUser: async question => {
            const reply = playUser(question)
            return {answer: reply.answer, stopAsking: false}
        }
    })
    return {arm, seed, questions: settled.length, repeats: repeats(settled), calls, rounds, settled}
}

for (let seed = 1; seed <= SEEDS; seed += 1) {
    for (const arm of ARMS) {
        const started = Date.now()
        const run = await runArm(arm, seed)
        const row = {
            ...run,
            runMs: Date.now() - started,
            output: run.calls.reduce((a, c) => a + c.output, 0),
            steps: run.calls.reduce((a, c) => a + c.steps, 0)
        }
        await appendFile(OUT, `${JSON.stringify(row)}\n`)
        console.log(
            JSON.stringify({
                arm,
                seed,
                questions: row.questions,
                repeats: row.repeats,
                calls: row.calls.length,
                steps: row.steps,
                output: row.output,
                runMs: row.runMs
            })
        )
    }
}
console.log('GRILL-REAL-DONE')
process.exit(0)

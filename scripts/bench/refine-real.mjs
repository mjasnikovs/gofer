// The refine phase exactly as the application runs it — the real sub-agent runner, the real read
// tool, the real refine() — from a raw ask and its screenshot. Arms are the sub-agent's thinking
// level, with `:noread` to run without the read tool.
//
//   REFINE_DIR=<dir with raw.txt [screenshot.png]> WORKSPACE=<project> \
//     node scripts/bench/refine-real.mjs [seeds] [arms: medium,off]
import {appendFile, readFile} from 'node:fs/promises'
import {existsSync} from 'node:fs'
import {createModelContext} from '../ai-provider.mjs'
import {runSubagentOutcome} from '../ai-subagent.mjs'
import {refine} from '../brief/phases.mjs'
import {appendNoThink} from '../brief/prompts.mjs'

const DIR = process.env.REFINE_DIR
const WORKSPACE = process.env.WORKSPACE
const OUT = process.env.OUT ?? `${DIR}/real-rows.jsonl`
const SEEDS = Number(process.argv[2] ?? 3)
const ARMS = (process.argv[3] ?? 'medium,off').split(',')
const SETTINGS = `${process.env.HOME}/.config/com.gofer.desktop/settings.json`

const raw = await readFile(`${DIR}/raw.txt`, 'utf8')
const images =
    existsSync(`${DIR}/screenshot.png`) ?
        [
            {
                type: 'image',
                data: (await readFile(`${DIR}/screenshot.png`)).toString('base64'),
                mimeType: 'image/png'
            }
        ]
    :   []
const settings = JSON.parse(await readFile(SETTINGS, 'utf8')).ai
const {models, subagent, streamOptions, probe} = createModelContext({
    settings,
    secrets: {},
    sessionId: 'bench-refine'
})

const section = (text, name) =>
    new RegExp(
        `^${name}[ \\t]*\\n([\\s\\S]*?)(?=\\n[A-Z][A-Z -]+[ \\t]*\\n|$(?![\\s\\S]))`,
        'mu'
    ).exec(text)?.[1] ?? ''

// The user's asks, each as a pattern the refined text must still carry.
const ASKS = {
    centred: /cent(re|er)/iu,
    flipped: /upside|upward|bottom|mirror|flip|invert/iu,
    closeIcon: /close (icon|button)|"X"|X button/iu,
    escape: /\bESC\b|escape/iu
}

function judge(text) {
    const constraints = section(text, 'CONSTRAINTS')
    const unknowns = section(text, 'KNOWN-UNKNOWNS')
    const covered = Object.fromEntries(
        Object.entries(ASKS).map(([k, re]) => [k, re.test(text) ? 1 : 0])
    )
    return {
        chars: text.length,
        goalWords: section(text, 'GOAL').split(/\s+/u).filter(Boolean).length,
        constraints: (constraints.match(/^- /gmu) ?? []).length,
        unknowns: /\(none\)/u.test(unknowns) ? 0 : (unknowns.match(/^- /gmu) ?? []).length,
        lineRefs: (text.match(/lines? \d+/gu) ?? []).length,
        ...covered,
        asks: Object.values(covered).reduce((a, b) => a + b, 0)
    }
}

async function runArm(arm) {
    const [level, mode] = arm.split(':')
    let steps = 0
    let usage = {}
    const started = Date.now()
    let fellThrough = false
    const text = await refine(raw, {
        images,
        log: () => {
            fellThrough = true
        },
        runWorker: async ({prompt, toolNames, images: pictures = []}) => {
            const outcome = await runSubagentOutcome({
                progress: () => {
                    steps += 1
                },
                prompt: appendNoThink(prompt),
                images: pictures,
                toolNames: mode === 'noread' ? [] : toolNames,
                workspacePath: WORKSPACE,
                models,
                model: subagent.model,
                thinkingLevel: level,
                streamOptions,
                settings: settings.subagent,
                probe,
                deps: {domains: []}
            })
            usage = outcome.usage ?? {}
            return outcome
        }
    })
    return {
        arm,
        wallMs: Date.now() - started,
        steps,
        input: usage.input ?? 0,
        cacheRead: usage.cacheRead ?? 0,
        output: usage.output ?? 0,
        // refine() hands the raw ask back when the worker produced nothing, and the raw ask
        // matches every ask pattern by construction; that run is a miss, not a full score.
        refined: fellThrough ? 0 : 1,
        ...(fellThrough ? {} : judge(text)),
        text
    }
}

for (let seed = 1; seed <= SEEDS; seed += 1) {
    for (const arm of ARMS) {
        const row = {seed, ...(await runArm(arm))}
        await appendFile(OUT, `${JSON.stringify(row)}\n`)
        console.log(JSON.stringify({...row, text: undefined}))
    }
}
console.log('REFINE-REAL-DONE')
process.exit(0)

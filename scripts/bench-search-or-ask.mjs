/**
 * An interleaved A/B of what the two documentation operations say they cost.
 *
 * The question. `godot_docs_search` is 24% of every character the model reads back from any tool,
 * and 91% of that is `search` rather than `ask`: **5,603 characters per `search` operation against
 * 458 for an `ask`**, measured across 31 recorded live runs, which chose `search` 24 times and
 * `ask` 18. Iteration 4 measured the two against each other over six questions and found them
 * equal on whether the fact came back — 5/6 each — with `ask` 1.5x slower and 7x smaller.
 *
 * So the model is choosing the expensive one about half the time, and nothing it reads says which
 * is expensive. This measures whether saying so moves the choice. It is a fact rather than a
 * persuasion: the two numbers are the ones the corpus recorded.
 *
 * What it cannot measure is the other half — whether the turns that switch to `ask` still finish
 * the task. That needs whole turns, not one call, and `ox-turn.sh` is what runs those.
 *
 *   GOFER_DUMP_CATALOG=/tmp/catalog.json GOFER_DUMP_PROMPT=/tmp/prompt.txt \
 *     cargo test --manifest-path src-tauri/Cargo.toml --features godot-acceptance --lib \
 *     -- dump_catalog_and_prompt --test-threads=1
 *
 *   GOFER_BENCH_CATALOG=/tmp/catalog.json GOFER_BENCH_PROMPT=/tmp/prompt.txt \
 *     node scripts/bench-search-or-ask.mjs 20
 *
 * `GOFER_BENCH_ENDPOINT` names the completions endpoint; the default is the local llama.cpp.
 */

import {readFile} from 'node:fs/promises'
import {createGodotTools} from './godot-tools.mjs'

const ENDPOINT = process.env.GOFER_BENCH_ENDPOINT ?? 'http://127.0.0.1:8080/v1/chat/completions'
/** The model to ask, and the key it needs. Both default to the local server, which wants neither. */
const MODEL = process.env.GOFER_BENCH_MODEL ?? 'local'
const AUTHORIZATION =
    process.env.OPENROUTER_API_KEY ?
        {authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`}
    :   {}

const named = variable => {
    const path = process.env[variable]
    if (path) return path
    throw new Error(`${variable} names the file the Rust dump wrote. See the header of this file.`)
}
const catalog = JSON.parse(await readFile(named('GOFER_BENCH_CATALOG'), 'utf8'))
const prompt = await readFile(named('GOFER_BENCH_PROMPT'), 'utf8')

/** The clause under test, appended to the domain's description. */
const ARMS = {
    shipped: '',
    costed:
        ' A search answers with four passages, about 7,000 characters of them; an ask answers with'
        + ' a paragraph and a quote, about 450. Both carry the fact as often as the other.'
}

const asSchema = tool => ({
    type: 'function',
    function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters ?? tool.inputSchema
    }
})

function toolsFor(clause) {
    const extended = catalog.map(domain =>
        domain.name === 'godot_docs_search' ?
            {...domain, description: `${domain.description}${clause}`}
        :   domain
    )
    return createGodotTools(extended, {call: async () => ({})}).map(asSchema)
}

/*
 * Four asks, each one a live run's own opening question, and each one a single fact rather than a
 * survey — which is the case the catalogue already says `ask` is for. `r11` and `s21` opened with
 * `search` on the first two; `t13` and `s34` on the last two.
 */
const ASKS = [
    'Give the player real platformer movement: gravity, a jump on the Space key, and left/right'
        + ' movement with the arrow keys. Use CharacterBody2D.',
    'Add an enemy that walks back and forth and hurts the player on contact.',
    'The main script prints a tick. Change it to print only once every five seconds instead.',
    'Add a sound that plays when the player reaches the right edge of the window.'
]

async function ask(clause, question, seed) {
    const response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {'content-type': 'application/json', ...AUTHORIZATION},
        body: JSON.stringify({
            model: MODEL,
            messages: [
                {role: 'system', content: `${prompt}\n\nEditor session: ready. Godot 4.7.2.`},
                {role: 'user', content: question}
            ],
            tools: toolsFor(clause),
            tool_choice: 'auto',
            temperature: 0.7,
            seed
        })
    })
    if (!response.ok) throw new Error(`${response.status} ${await response.text()}`)
    const body = await response.json()
    return body.choices?.[0]?.message ?? {}
}

/** Which documentation operations the model wrote, if any. */
function score(message) {
    const ops = []
    for (const call of message.tool_calls ?? []) {
        if (call.function?.name !== 'godot_docs_search') continue
        let args
        try {
            args = JSON.parse(call.function?.arguments ?? '{}')
        } catch {
            continue
        }
        for (const entry of Array.isArray(args.ops) ? args.ops : []) ops.push(entry?.op)
    }
    return ops
}

const seeds = Number(process.argv[2] ?? 20)
const totals = Object.fromEntries(
    Object.keys(ARMS).map(name => [name, {search: 0, ask: 0, neither: 0, turns: 0}])
)
for (let seed = 1; seed <= seeds; seed += 1) {
    for (const question of ASKS) {
        for (const [name, clause] of Object.entries(ARMS)) {
            const ops = score(await ask(clause, question, seed))
            const held = totals[name]
            held.turns += 1
            held.search += ops.includes('search') ? 1 : 0
            held.ask += ops.includes('ask') ? 1 : 0
            held.neither += ops.length === 0 ? 1 : 0
        }
    }
}
console.log('\n--- first calls where the operation appears ---')
for (const [name, held] of Object.entries(totals))
    console.log(
        `${name.padEnd(8)} search ${held.search}/${held.turns}  ask ${held.ask}/${held.turns}`
            + `  no docs call ${held.neither}/${held.turns}`
    )

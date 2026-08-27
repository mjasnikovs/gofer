/**
 * An interleaved A/B of whether the language-server operations say enough to be reached for.
 *
 * The question. Eight of `godot_script`'s intelligence operations carry a summary that is an IDE
 * menu label rather than a sentence — `references` says "Find references.", `declaration` says "Go
 * to declaration." Across 122 recorded live runs and 1,608 tool calls, those eight account for
 * **four calls**, and `references`, `declaration`, `highlights` and `signature_help` account for
 * none at all. What the runs did instead is grep: the rename task ran three `bash grep`s, and three
 * move tasks each paid 50–220 seconds for a sub-agent whose whole question was "find every
 * reference to this".
 *
 * Every one of the thirteen operations no live run has ever called has a summary under 120
 * characters; not one of the fifty-one with a longer summary is uncalled. That is a correlation and
 * not a cause — a short summary is often short because the operation is small. This measures the
 * one direction that can be measured cheaply: whether saying what `references` answers, and when to
 * prefer it to grep, moves the first call the model writes.
 *
 * The prose is a fact rather than a persuasion. `godot_journey_acceptance` drives `references`
 * against a real editor and asserts it answers workspace-relative `locations` and finds the
 * declaration in another script, so the arm says exactly that.
 *
 *   GOFER_DUMP_CATALOG=/tmp/catalog.json GOFER_DUMP_PROMPT=/tmp/prompt.txt \
 *     cargo test --manifest-path src-tauri/Cargo.toml --features godot-acceptance --lib \
 *     -- dump_catalog_and_prompt --test-threads=1
 *
 *   GOFER_BENCH_CATALOG=/tmp/catalog.json GOFER_BENCH_PROMPT=/tmp/prompt.txt \
 *     GOFER_BENCH_ENDPOINT=https://openrouter.ai/api/v1/chat/completions \
 *     GOFER_BENCH_MODEL=z-ai/glm-5.3-flash OPENROUTER_API_KEY=… \
 *     node scripts/bench-references.mjs 10
 */

import {readFile} from 'node:fs/promises'
import {createGodotTools} from './godot-tools.mjs'

const ENDPOINT = process.env.GOFER_BENCH_ENDPOINT ?? 'http://127.0.0.1:8080/v1/chat/completions'
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

/**
 * The summaries under test, keyed by operation. Every clause is something the acceptance suites
 * already hold the operation to: `locations` and its workspace-relative paths come from
 * `godot_journey_acceptance`, the open-first rule from the domain description, and the
 * GDScript-only limit from the handler, which asks the language server and nothing else.
 */
const WRITTEN = {
    references:
        'Every place a symbol is used, across every script the language server has indexed.'
        + ' Answers with `locations`: a worktree-relative path and a range for each one. Open the'
        + ' script first, then point `position` at the name in any file that uses it. This is the'
        + ' call for finding out what depends on something before you rename or delete it — it'
        + ' matches the symbol rather than the text, so a `speed` does not drag in `speed_label` or'
        + ' a comment, and a shell `grep` is not the same answer. It reads GDScript: a scene'
        + " referring to a *file* is not a symbol, and moving that file is `godot_resource move`'s"
        + ' job.',
    declaration:
        'Where the name under `position` is declared, answered as `locations` — a worktree-relative'
        + ' path and a range. Open the script first. Use it to find out where something comes from'
        + ' rather than opening scripts until you meet it.',
    highlights:
        'Every occurrence of the symbol under `position` inside that one file, as ranges. The'
        + ' same question as `references` narrowed to the open script, and cheaper.',
    signature_help:
        'The parameters of the call `position` sits inside, with the one being typed marked. Ask'
        + ' it instead of guessing what arguments a method takes.'
}

const asSchema = tool => ({
    type: 'function',
    function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters ?? tool.inputSchema
    }
})

function toolsFor(arm) {
    const extended = catalog.map(domain =>
        domain.name === 'godot_script' && arm === 'written' ?
            {
                ...domain,
                operations: domain.operations.map(operation =>
                    WRITTEN[operation.op] ?
                        {...operation, summary: WRITTEN[operation.op]}
                    :   operation
                )
            }
        :   domain
    )
    return createGodotTools(extended, {call: async () => ({})}).map(asSchema)
}

/*
 * Four asks whose answer is "find out what refers to this before you touch it". The first two are
 * verbatim the opening asks of recorded runs that answered them with `bash grep` and with a
 * sub-agent; the other two are the same shape against a symbol rather than a file.
 */
const ASKS = [
    "Rename the player's speed variable to move_speed everywhere it is used, in every script."
        + ' Prove nothing still refers to the old name.',
    'I am about to delete the take_damage function from the player script. Tell me what still'
        + ' calls it.',
    'The enemy script has a variable called health. Find every place it is read or written before'
        + ' I change what it means.',
    'Something sets the score twice a frame. Find every place score is assigned.'
]

async function ask(arm, question, seed) {
    const response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {'content-type': 'application/json', ...AUTHORIZATION},
        body: JSON.stringify({
            model: MODEL,
            messages: [
                {role: 'system', content: `${prompt}\n\nEditor session: ready. Godot 4.7.2.`},
                {role: 'user', content: question}
            ],
            tools: toolsFor(arm),
            tool_choice: 'auto',
            temperature: 0.7,
            seed
        })
    })
    if (!response.ok) throw new Error(`${response.status} ${await response.text()}`)
    const body = await response.json()
    return body.choices?.[0]?.message ?? {}
}

/** What the model reached for: the language server, a shell grep, a sub-agent, or something else. */
function score(message) {
    const reached = new Set()
    for (const call of message.tool_calls ?? []) {
        const name = call.function?.name
        if (name === 'bash') reached.add('bash')
        if (name === 'subagent') reached.add('subagent')
        if (name !== 'godot_script') continue
        let args
        try {
            args = JSON.parse(call.function?.arguments ?? '{}')
        } catch {
            continue
        }
        for (const entry of Array.isArray(args.ops) ? args.ops : []) {
            if (entry?.op === 'references' || entry?.op === 'highlights') reached.add('lsp')
        }
    }
    return reached
}

const seeds = Number(process.argv[2] ?? 10)
const ARMS = ['shipped', 'written']
const totals = Object.fromEntries(ARMS.map(arm => [arm, {lsp: 0, bash: 0, subagent: 0, turns: 0}]))
for (let seed = 1; seed <= seeds; seed += 1)
    for (const question of ASKS)
        for (const arm of ARMS) {
            const reached = score(await ask(arm, question, seed))
            const held = totals[arm]
            held.turns += 1
            held.lsp += reached.has('lsp') ? 1 : 0
            held.bash += reached.has('bash') ? 1 : 0
            held.subagent += reached.has('subagent') ? 1 : 0
        }
console.log('\n--- what the first call reached for ---')
for (const [arm, held] of Object.entries(totals))
    console.log(
        `${arm.padEnd(8)} language server ${held.lsp}/${held.turns}`
            + `  bash ${held.bash}/${held.turns}  sub-agent ${held.subagent}/${held.turns}`
    )

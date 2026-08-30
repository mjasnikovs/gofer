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

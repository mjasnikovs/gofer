/**
 * Does the model wrap a tagged value in a second copy of its own tag, and does any wording stop it?
 *
 * Measured over five live turns on 2026-08-22: of 86 tagged values written, 41 were double-wrapped
 * and 22 of those spelled the inner tag with Godot's capital. The normalizer repairs them; the
 * question here is whether the catalogue can stop them being written.
 *
 * Interleaved inside one process, alternating arms per seed, and only the sign of the gap is read —
 * the same rule `bench-prompt-line.mjs` documents.
 *
 * **And one this file learnt the hard way: a single-turn bench measures the FIRST answer, and
 * cannot measure a loop.** A sentence scored here at 0/15 against 15/15 — a clean, repeatable win —
 * and a live turn then sent one identical refused call twenty-nine times with that sentence in
 * front of it every time. Posing the loop directly, three identical refusals deep, both arms
 * recovered 15 of 15: the loop does not reproduce in a short conversation at all. So a win here is
 * a win about the first refusal, and nothing else. Say that much and no more when quoting it.
 *
 *   GOFER_BENCH_CATALOG=/tmp/catalog.json GOFER_BENCH_PROMPT=/tmp/prompt.txt \
 *     node scripts/bench-tagged-value.mjs 15
 */
import {readFile} from 'node:fs/promises'
import {createGodotTools} from './ai-host.mjs'

const ENDPOINT = process.env.GOFER_BENCH_ENDPOINT ?? 'http://127.0.0.1:8080/v1/chat/completions'
const named = variable => {
    const path = process.env[variable]
    if (path) return path
    throw new Error(`${variable} names the file the Rust dump wrote. See the header of this file.`)
}
const catalog = JSON.parse(await readFile(named('GOFER_BENCH_CATALOG'), 'utf8'))
const prompt = await readFile(named('GOFER_BENCH_PROMPT'), 'utf8')

const asSchema = tool => ({
    type: 'function',
    function: {name: tool.name, description: tool.description, parameters: tool.parameters}
})

/** The payload sentence each arm puts where the model will meet it. */
const PAYLOAD_NOTE =
    'The payload is the bare value itself: a string, a number, an array of numbers, or {path} for'
    + ' a resource. Never a second {type, value} pair around it.'

// Three arms over the same catalogue: the shipped one, the note on the JSON Schema property the
// model fills in, and the note appended to the operation summary it reads first.
function armedTools(arm) {
    const tools = createGodotTools(catalog, {call: async () => ({})}).map(asSchema)
    if (arm === 'shipped') return tools
    return tools.map(tool => {
        if (arm === 'summary')
            return {
                ...tool,
                function: {
                    ...tool.function,
                    description: tool.function.description.replaceAll(
                        'The other tags are null,',
                        `${PAYLOAD_NOTE} The other tags are null,`
                    )
                }
            }
        const entry = tool.function.parameters?.properties?.ops?.items
        const value = entry?.properties?.value
        if (!value?.properties?.value) return tool
        return {
            ...tool,
            function: {
                ...tool.function,
                parameters: {
                    ...tool.function.parameters,
                    properties: {
                        ...tool.function.parameters.properties,
                        ops: {
                            ...tool.function.parameters.properties.ops,
                            items: {
                                ...entry,
                                properties: {
                                    ...entry.properties,
                                    value: {
                                        ...value,
                                        properties: {
                                            ...value.properties,
                                            value: {description: PAYLOAD_NOTE}
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    })
}

const ARMS = ['shipped', 'schema', 'summary']

// The moment a live turn reached: the nodes exist and the next call dresses them.
const ASK =
    'The scene has /Main/PauseMenu (a CanvasLayer) holding /Main/PauseMenu/CenterContainer/'
    + 'ResumeButton (a Button). Set the button\'s text to "Resume", hide the PauseMenu, and set the'
    + " PauseMenu's process_mode to 3."
const SESSION = 'Editor session: ready. Godot 4.7.2, scene res://scenes/main.tscn open, revision 4.'

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v)

/** Every tagged value in a call, and how many of them carry a second tag inside. */
function scoreTags(message) {
    let tagged = 0
    let doubled = 0
    const walk = v => {
        if (Array.isArray(v)) return v.forEach(walk)
        if (!isObject(v)) return
        if (typeof v.type === 'string' && 'value' in v) {
            tagged += 1
            if (isObject(v.value) && typeof v.value.type === 'string') doubled += 1
        }
        for (const inner of Object.values(v)) walk(inner)
    }
    for (const call of message.tool_calls ?? []) {
        try {
            walk(JSON.parse(call.function?.arguments ?? '{}'))
        } catch {
            /* a call that is not JSON carries no tagged value to score */
        }
    }
    return {tagged, doubled}
}

async function ask(tools, seed) {
    const response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({
            model: 'local',
            messages: [
                {role: 'system', content: `${prompt}\n\n${SESSION}`},
                {role: 'user', content: ASK}
            ],
            tools,
            tool_choice: 'auto',
            temperature: 0.7,
            seed
        })
    })
    if (!response.ok) throw new Error(`${response.status} ${await response.text()}`)
    return (await response.json()).choices?.[0]?.message ?? {}
}

const seeds = Number(process.argv[2] ?? 15)
const built = Object.fromEntries(ARMS.map(arm => [arm, armedTools(arm)]))
const totals = Object.fromEntries(
    ARMS.map(arm => [arm, {tagged: 0, doubled: 0, turns: 0, dirty: 0}])
)
for (let seed = 1; seed <= seeds; seed += 1)
    for (const arm of ARMS) {
        const scored = scoreTags(await ask(built[arm], seed))
        totals[arm].tagged += scored.tagged
        totals[arm].doubled += scored.doubled
        totals[arm].dirty += scored.doubled > 0 ? 1 : 0
        totals[arm].turns += 1
        process.stdout.write(`${seed} ${arm.padEnd(8)} ${scored.doubled}/${scored.tagged}\n`)
    }
console.log('\n--- double-wrapped tagged values ---')
for (const [arm, held] of Object.entries(totals))
    console.log(
        `${arm.padEnd(8)} ${held.doubled}/${held.tagged} values`
            + `  ${held.dirty}/${held.turns} turns carried at least one`
    )

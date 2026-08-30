import {readFile} from 'node:fs/promises'
import {createGodotTools} from './godot-tools.mjs'

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

const PAYLOAD_NOTE =
    'The payload is the bare value itself: a string, a number, an array of numbers, or {path} for'
    + ' a resource. Never a second {type, value} pair around it.'

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

const ASK =
    'The scene has /Main/PauseMenu (a CanvasLayer) holding /Main/PauseMenu/CenterContainer/'
    + 'ResumeButton (a Button). Set the button\'s text to "Resume", hide the PauseMenu, and set the'
    + " PauseMenu's process_mode to 3."
const SESSION = 'Editor session: ready. Godot 4.7.2, scene res://scenes/main.tscn open, revision 4.'

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v)

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
        } catch {}
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

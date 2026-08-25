/**
 * Two questions the schema alone cannot answer, measured against the local model.
 *
 * **A — does widening invite the mistake?** `unbox_the_one` repairs a single-value parameter handed
 * a list of one, and the generated schema refuses that shape before the router ever sees it, so the
 * repair is reachable only from the desktop client and the acceptance suites. Widening the property
 * makes it reachable — but a permissive schema may also *teach* the boxed shape. Arms: the shipped
 * property against one that accepts a list of one.
 *
 * **B — does our wording beat ajv's?** Seven of the eight nested entries in the catalogue are
 * enforced by ajv, whose refusal names neither the operation nor the position. `check_inside` was
 * written because `missing field oldText` left a model unable to tell which of five nested files
 * was wrong. Arms: pose the refusal both ways, three deep, and score the next call.
 *
 * Interleaved inside one process, alternating arms per seed, and only the SIGN of the gap is read —
 * the rule `bench-prompt-line.mjs` documents. A run collected across two sittings flipped sign
 * twice and is worth nothing.
 *
 *   GOFER_BENCH_CATALOG=/tmp/catalog.json GOFER_BENCH_PROMPT=/tmp/prompt.txt \
 *     node scripts/bench-boxed-and-wording.mjs 15
 */
import {readFile} from 'node:fs/promises'
import Ajv from 'ajv'
import {createGodotTools} from './godot-tools.mjs'

const ENDPOINT = process.env.GOFER_BENCH_ENDPOINT ?? 'http://127.0.0.1:8080/v1/chat/completions'
const named = variable => {
    const path = process.env[variable]
    if (path) return path
    throw new Error(`${variable} names the file the Rust dump wrote. See the header of this file.`)
}
const catalog = JSON.parse(await readFile(named('GOFER_BENCH_CATALOG'), 'utf8'))
const prompt = await readFile(named('GOFER_BENCH_PROMPT'), 'utf8')
const ajv = new Ajv({strict: false, allErrors: true})

const asSchema = tool => ({
    type: 'function',
    function: {name: tool.name, description: tool.description, parameters: tool.parameters}
})

/** The shipped tools, and the same with every single-value property also accepting a list of one. */
function armedTools(widened) {
    const tools = createGodotTools(catalog, {call: async () => ({})})
    if (!widened) return {schemas: tools.map(asSchema), tools}
    const loosened = tools.map(tool => {
        const items = tool.parameters?.properties?.ops?.items
        if (!items?.properties) return tool
        const properties = Object.fromEntries(
            Object.entries(items.properties).map(([name, shape]) => {
                if (name === 'op' || shape.type !== 'string') return [name, shape]
                return [
                    name,
                    {
                        anyOf: [
                            shape,
                            {type: 'array', items: {type: 'string'}, minItems: 1, maxItems: 1}
                        ]
                    }
                ]
            })
        )
        const parameters = structuredClone(tool.parameters)
        parameters.properties.ops.items = {...items, properties}
        return {...tool, parameters}
    })
    return {schemas: loosened.map(asSchema), tools: loosened}
}

const SESSION = 'Editor session: ready. Godot 4.7.2, scene res://scenes/main.tscn open, revision 7.'

// A: several nodes, one single-value parameter each. The shape of the turn the repair was measured in.
const BOXED_ASK =
    'The scene holds /Main/Enemies/Slime, /Main/Enemies/Bat and /Main/Enemies/Ghost. Put all three'
    + ' into the "enemies" group so the spawner can find them.'

async function ask(schemas, messages, seed) {
    const response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({
            model: 'local',
            messages,
            tools: schemas,
            tool_choice: 'auto',
            temperature: 0.7,
            seed
        })
    })
    if (!response.ok) throw new Error(`${response.status} ${await response.text()}`)
    return (await response.json()).choices?.[0]?.message ?? {}
}

/** Every op entry the message wrote, whatever tool carried it. */
function entriesOf(message, tools) {
    const out = []
    for (const call of message.tool_calls ?? []) {
        const tool = tools.find(t => t.name === call.function?.name)
        if (!tool) continue
        let args
        try {
            args = JSON.parse(call.function?.arguments ?? '{}')
        } catch {
            continue
        }
        // A throw is a refusal. `prepareArguments` refuses an operation the tool does not have,
        // and a wrong-tool `op` is exactly the mistake these recorded calls carry — so it is
        // counted as refused rather than allowed to end the run.
        let prepared = args
        let threw = false
        try {
            if (tool.prepareArguments) prepared = tool.prepareArguments(args)
        } catch {
            threw = true
        }
        const accepts = !threw && ajv.compile(tool.parameters)(prepared)
        for (const entry of Array.isArray(prepared.ops) ? prepared.ops : [prepared])
            if (entry && typeof entry === 'object') out.push({entry, accepts, tool: tool.name})
    }
    return out
}

const SINGLE = new Set([
    'node',
    'group',
    'path',
    'parent',
    'name',
    'property',
    'scene',
    'newParent'
])
const scoreBoxed = written => {
    let boxed = 0
    let calls = 0
    let accepted = 0
    for (const {entry, accepts} of written) {
        calls += 1
        if (accepts) accepted += 1
        for (const [key, value] of Object.entries(entry))
            if (SINGLE.has(key) && Array.isArray(value)) boxed += 1
    }
    return {calls, boxed, accepted}
}

// B: the same refusal, worded two ways, posed three deep so it is a loop and not a first answer.
const AJV_WORDING =
    "Invalid arguments: /ops/0/properties/0 must NOT have additional properties, /ops/0/properties/0 must have required property 'name'"
const OURS_WORDING =
    'godot_node set_properties `properties[0]` has no ` name` key. Each entry takes {name: text,'
    + ' value: a tagged value}. It arrived carrying "modulate", so what went wrong is the object you'
    + ' wrote rather than the word you chose: write the whole call again.'
const WORDING_ASK = "Set /Main/Player's modulate to opaque red and its z_index to 5."
const BAD_CALL = JSON.stringify({
    ops: [
        {
            op: 'set_properties',
            node: '/Main/Player',
            properties: [{' name': 'modulate', value: {type: 'Color', value: [1, 0, 0, 1]}}]
        }
    ]
})

function wordingMessages(refusal) {
    const messages = [
        {role: 'system', content: `${prompt}\n\n${SESSION}`},
        {role: 'user', content: WORDING_ASK}
    ]
    for (let attempt = 0; attempt < 3; attempt += 1) {
        messages.push({
            role: 'assistant',
            content: null,
            tool_calls: [
                {
                    id: `c${attempt}`,
                    type: 'function',
                    function: {name: 'godot_node', arguments: BAD_CALL}
                }
            ]
        })
        messages.push({role: 'tool', tool_call_id: `c${attempt}`, content: refusal})
    }
    return messages
}

/**
 * Did the retry produce something the app would take?
 *
 * Scored on the whole call, not on `set_properties`, because switching to `set_property` singular
 * is a real recovery: it drops the nested entry the refusal was about. Scoring only the plural
 * form reads that as a failure and reads a model that solved the problem as one that did not.
 */
const scoreWording = written => {
    let recovered = 0
    let still = 0
    const padded = value => {
        if (Array.isArray(value)) return value.some(padded)
        if (!value || typeof value !== 'object') return false
        return Object.entries(value).some(([key, held]) => key !== key.trim() || padded(held))
    }
    for (const {entry, accepts} of written) {
        if (padded(entry)) still += 1
        else if (accepts) recovered += 1
    }
    return {recovered, still}
}

const seeds = Number(process.argv[2] ?? 15)
const shipped = armedTools(false)
const widened = armedTools(true)
const A = {shipped: {calls: 0, boxed: 0, accepted: 0}, widened: {calls: 0, boxed: 0, accepted: 0}}
const B = {ajv: {recovered: 0, still: 0, turns: 0}, ours: {recovered: 0, still: 0, turns: 0}}

for (let seed = 1; seed <= seeds; seed += 1) {
    for (const [arm, built] of [
        ['shipped', shipped],
        ['widened', widened]
    ]) {
        const messages = [
            {role: 'system', content: `${prompt}\n\n${SESSION}`},
            {role: 'user', content: BOXED_ASK}
        ]
        const scored = scoreBoxed(entriesOf(await ask(built.schemas, messages, seed), built.tools))
        A[arm].calls += scored.calls
        A[arm].boxed += scored.boxed
        A[arm].accepted += scored.accepted
        process.stdout.write(
            `A ${seed} ${arm.padEnd(7)} boxed ${scored.boxed}  accepted ${scored.accepted}/${scored.calls}\n`
        )
    }
    for (const [arm, refusal] of [
        ['ajv', AJV_WORDING],
        ['ours', OURS_WORDING]
    ]) {
        const scored = scoreWording(
            entriesOf(await ask(shipped.schemas, wordingMessages(refusal), seed), shipped.tools)
        )
        // Scored per TURN, not per entry: a model that batches two ops into one call has not
        // recovered twice, and one that writes a single op has not recovered less.
        const won = scored.still === 0 && scored.recovered > 0
        B[arm].recovered += won ? 1 : 0
        B[arm].still += scored.still > 0 ? 1 : 0
        B[arm].turns += 1
        process.stdout.write(`B ${seed} ${arm.padEnd(7)} ${won ? 'recovered' : 'no       '}\n`)
    }
}

console.log('\n--- A: does widening invite the boxed shape? ---')
for (const [arm, held] of Object.entries(A))
    console.log(
        `${arm.padEnd(8)} boxed ${held.boxed}  accepted ${held.accepted}/${held.calls} calls`
    )
console.log('\n--- B: which refusal does the model recover from? ---')
for (const [arm, held] of Object.entries(B))
    console.log(
        `${arm.padEnd(8)} recovered ${held.recovered}/${held.turns} turns  still padded ${held.still}`
    )

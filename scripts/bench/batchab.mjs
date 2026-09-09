import {readFile, writeFile} from 'node:fs/promises'
import Ajv from 'ajv'
import {normalizeGodotCall} from '../godot-tools.mjs'

const S = process.env.SCRATCH ?? import.meta.dirname
const ENDPOINT = 'http://localhost:8080/v1/chat/completions'
const ARMS = process.env.ARMS?.split(',') ?? ['A', 'B', 'C']
const SEEDS = Number(process.env.SEEDS ?? 12)
const SCENARIO = process.env.SCENARIO ?? 'primed'
const catalog = JSON.parse(await readFile(`${S}/catalog.json`, 'utf8'))
const prompt = await readFile(`${S}/prompt.txt`, 'utf8')
const every = JSON.parse(await readFile(`${S}/tools.json`, 'utf8'))
const EXTRAS = ['subagent', 'web_search', 'web_fetch', 'remember', 'ask_user']
const extras = every.filter(t => EXTRAS.includes(t.name))

const armTools = {}
const armDomains = {}
for (const arm of ARMS) {
    const mine = JSON.parse(await readFile(`${S}/batchab-tools-${arm}.json`, 'utf8'))
    armTools[arm] = [...mine, ...extras]
    const drop =
        arm === 'B' ? ['create_nodes', 'set_properties']
        : arm === 'C' ? ['create', 'set_property']
        : []
    armDomains[arm] = catalog.map(d =>
        d.name === 'godot_node' ?
            {...d, operations: d.operations.filter(o => !drop.includes(o.op))}
        :   d
    )
}

const ajv = new Ajv({strict: false, allErrors: false})
const validators = {}
for (const arm of ARMS)
    validators[arm] = Object.fromEntries(
        armTools[arm].map(t => [t.name, ajv.compile(t.parameters)])
    )

const N = Number(process.env.COINS ?? 5)
const NAMES = Array.from({length: N}, (_, i) => `Coin${i + 1}`)
const ASK =
    `Add ${N} Sprite2D children named ${NAMES.join(', ')} under the node at /Main in the open scene,`
    + ` then set each one's position: ${NAMES.map((n, i) => `${n} to (${i * 64}, 0)`).join(', ')}.`
    + ' Do not save the scene.'

const SESSION =
    'Editor session: ready. Godot 4.7.2. Every tool runs in the project root and takes paths the way'
    + ' the project spells them, never an absolute one.'

// The realistic arrival at this task: the model has just read the tree, so the scene, the parent
// node and the revision are all already in context.
const PRIMING = [
    {
        role: 'assistant',
        content: null,
        tool_calls: [
            {
                id: 'call-1',
                type: 'function',
                function: {
                    name: 'godot_scene',
                    arguments: JSON.stringify({ops: [{op: 'get_tree'}]})
                }
            }
        ]
    },
    {
        role: 'tool',
        tool_call_id: 'call-1',
        content: JSON.stringify({
            ops: [
                {
                    op: 'get_tree',
                    result: {
                        scene: 'res://main.tscn',
                        revision: 7,
                        tree: {path: '/Main', type: 'Node2D', children: []}
                    }
                }
            ]
        })
    }
]

function conversation(scenario) {
    return [
        {role: 'system', content: prompt},
        {role: 'user', content: `${ASK}\n\n${SESSION}`},
        ...(scenario === 'primed' ? PRIMING : [])
    ]
}

async function ask(arm, seed, scenario, messages = conversation(scenario)) {
    const started = Date.now()
    const response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({
            model: 'local',
            messages,
            tools: armTools[arm].map(t => ({
                type: 'function',
                function: {name: t.name, description: t.description, parameters: t.parameters}
            })),
            tool_choice: 'auto',
            reasoning_effort: 'medium',
            seed
        })
    })
    if (!response.ok) throw new Error(`${response.status} ${await response.text()}`)
    const body = await response.json()
    return {
        message: body.choices?.[0]?.message ?? {},
        usage: body.usage ?? {},
        ms: Date.now() - started
    }
}

const MUTATING = new Set([
    'create',
    'create_nodes',
    'instantiate',
    'duplicate',
    'rename',
    'reparent',
    'change_type',
    'set_property',
    'set_properties',
    'add_to_group',
    'remove_from_group',
    'delete',
    'connect_signal',
    'disconnect_signal',
    'attach_script',
    'detach_script',
    'set_owner'
])

const WANT_NODES = NAMES
const WANT_POS = Object.fromEntries(NAMES.map((n, i) => [n, [i * 64, 0]]))

function positionOf(value) {
    if (value && typeof value === 'object' && Array.isArray(value.value))
        return value.value.map(Number)
    if (Array.isArray(value)) return value.map(Number)
    return null
}

function score(arm, message, created, positioned) {
    const calls = message.tool_calls ?? []
    let parsed = 0
    let validRaw = 0
    let validRepaired = 0
    let mutations = 0
    let ops = 0
    for (const call of calls) {
        const name = call.function?.name
        let args
        try {
            args = JSON.parse(call.function?.arguments ?? '')
        } catch {
            continue
        }
        parsed += 1
        const check = validators[arm][name]
        if (check?.(args)) validRaw += 1
        let repaired = args
        try {
            repaired = normalizeGodotCall(armDomains[arm], name, args)
        } catch {
            /* the repair layer refusing is itself an invalid call */
        }
        if (check?.(repaired)) validRepaired += 1
        for (const entry of Array.isArray(repaired?.ops) ? repaired.ops : []) {
            ops += 1
            if (MUTATING.has(entry.op)) mutations += 1
            if (entry.op === 'create') created.set(entry.name, entry)
            if (entry.op === 'create_nodes')
                for (const n of entry.nodes ?? []) created.set(n.name, n)
            if (entry.op === 'set_property' && entry.property === 'position')
                positioned.set(entry.node, positionOf(entry.value))
            if (entry.op === 'set_properties')
                for (const p of entry.properties ?? [])
                    if (p.property === 'position') positioned.set(p.node, positionOf(p.value))
        }
    }
    const namedRight = WANT_NODES.filter(n => {
        const made = created.get(n)
        return (
            made
            && made.type === 'Sprite2D'
            && String(made.parent ?? '').replace(/\/$/u, '') === '/Main'
        )
    }).length
    const placedRight = WANT_NODES.filter(n => {
        const at = [...positioned.entries()].find(
            ([node]) => node === n || node === `/Main/${n}` || node.endsWith(`/${n}`)
        )
        if (!at || !at[1]) return false
        return at[1][0] === WANT_POS[n][0] && at[1][1] === WANT_POS[n][1]
    }).length
    return {
        calls: calls.length,
        parsed,
        validRaw,
        validRepaired,
        ops,
        mutations,
        namedRight,
        placedRight
    }
}

// A turn does not end at the first assistant message: create_nodes answers, and the positions
// follow in the next one. So each trial runs the real loop — synthetic tool results, revision
// advancing — until the five nodes and five positions are all expressed or the ceiling is hit.
const CEILING = 4

function answerFor(name, args, revision) {
    const ops = Array.isArray(args?.ops) ? args.ops : []
    return JSON.stringify({
        ops: ops.map(entry => ({
            op: entry.op,
            result: MUTATING.has(entry.op) ? {ok: true, revision} : {ok: true}
        }))
    })
}

async function trial(arm, seed) {
    const messages = conversation(SCENARIO)
    const totals = {
        ms: 0,
        completionTokens: 0,
        promptTokens: 0,
        assistantTurns: 0,
        calls: 0,
        ops: 0,
        mutations: 0,
        validRaw: 0,
        validRepaired: 0,
        parsed: 0
    }
    let revision = 8
    let last = {namedRight: 0, placedRight: 0}
    const created = new Map()
    const positioned = new Map()
    for (let round = 0; round < CEILING; round += 1) {
        const {message, usage, ms} = await ask(arm, seed, SCENARIO, messages)
        totals.ms += ms
        totals.completionTokens += usage.completion_tokens ?? 0
        totals.promptTokens += usage.prompt_tokens ?? 0
        totals.assistantTurns += 1
        const scored = score(arm, message, created, positioned)
        for (const key of ['calls', 'ops', 'mutations', 'validRaw', 'validRepaired', 'parsed'])
            totals[key] += scored[key]
        last = scored
        if (round === 0) totals.firstCalls = scored.calls
        if (round === 0) totals.firstOps = scored.ops
        messages.push({
            role: 'assistant',
            content: message.content ?? null,
            ...(message.tool_calls ? {tool_calls: message.tool_calls} : {})
        })
        const calls = message.tool_calls ?? []
        if (calls.length === 0) break
        for (const call of calls) {
            let args = {}
            try {
                args = JSON.parse(call.function?.arguments ?? '{}')
            } catch {
                /* an unparsable call still gets an answer, as the router would give it one */
            }
            revision += 1
            messages.push({
                role: 'tool',
                tool_call_id: call.id,
                content: answerFor(call.function?.name, args, revision)
            })
        }
        if (last.namedRight === N && last.placedRight === N) break
    }
    return {
        arm,
        seed,
        ...totals,
        namedRight: last.namedRight,
        placedRight: last.placedRight,
        done: last.namedRight === N && last.placedRight === N ? 1 : 0
    }
}

const rows = []
for (let seed = 1; seed <= SEEDS; seed += 1) {
    for (const arm of ARMS) {
        let row
        try {
            row = await trial(arm, seed)
        } catch (error) {
            row = {arm, seed, error: String(error).slice(0, 200)}
        }
        rows.push(row)
        console.log(JSON.stringify(row))
    }
}
await writeFile(`${S}/batchab-rows-${SCENARIO}-${N}.json`, JSON.stringify(rows, null, 2))

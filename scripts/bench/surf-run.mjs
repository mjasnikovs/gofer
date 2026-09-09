import {readFile, writeFile} from 'node:fs/promises'
import Ajv from 'ajv'
import {ARMS} from './surf-arms.mjs'
import {TASKS, conversation, resultOf, batchProgress} from './surf-tasks.mjs'

const S = process.env.SCRATCH ?? import.meta.dirname
const ENDPOINT = 'http://localhost:8080/v1/chat/completions'
const NAMES = process.env.ARMS?.split(',') ?? ['S1', 'S2', 'S3', 'S4']
const SEEDS = Number(process.env.SEEDS ?? 10)
const FROM = Number(process.env.FROM ?? 1)
const OUT = process.env.OUT ?? 'surf-rows'
const ONLY = process.env.ONLY?.split(',')
const TURNS = 3

const catalog = JSON.parse(await readFile(`${S}/catalog.json`, 'utf8'))
const shared = await readFile(`${S}/prompt.txt`, 'utf8')
// An arm that ships its own system prompt is measured with it: surf-prompt-<arm>.txt beside the
// tools, else the shared one.
const prompts = {}
for (const arm of NAMES)
    prompts[arm] = await readFile(`${S}/surf-prompt-${arm}.txt`, 'utf8').catch(() => shared)
const tools = {}
for (const arm of NAMES)
    tools[arm] = JSON.parse(await readFile(`${S}/surf-tools-${arm}.json`, 'utf8'))

const ajv = new Ajv({strict: false, allErrors: false})
// each arm judged by its own advertised schema...
const own = Object.fromEntries(
    NAMES.map(arm => [
        arm,
        Object.fromEntries(tools[arm].map(t => [t.name, ajv.compile(t.parameters)]))
    ])
)
// ...and every arm also judged by the one rule: the shipped per-op branch for (domain, op).
// The shipped ten-tool list, verbatim: its per-op branches are the one rule every arm is judged
// by, whichever arm S1 happens to be in this run.
const shippedTen = JSON.parse(await readFile(`${S}/shapes-tools-C.json`, 'utf8'))
const canon = {}
for (const tool of shippedTen.filter(t => t.name.startsWith('godot_')))
    for (const b of tool.parameters.properties.ops.items.oneOf ?? [])
        canon[`${tool.name}::${b.properties.op.const}`] = ajv.compile(b)

const paramsOf = Object.fromEntries(
    catalog.map(d => [
        d.name,
        Object.fromEntries(d.operations.map(o => [o.op, (o.params ?? []).map(p => p.name)]))
    ])
)

/** A key that carried its own value: "limit 50", "minSeverityWarning", "size [16, 16]". */
function swallowed(entry) {
    const known = paramsOf[entry?.tool]?.[entry?.op]
    if (!known) return 0
    let count = 0
    for (const key of Object.keys(entry)) {
        if (key === 'op' || key === 'tool' || known.includes(key)) continue
        const trimmed = key.trim()
        if (known.includes(trimmed)) continue
        const head = trimmed.split(/[\s:=]/u)[0]
        if (known.includes(head)) count += 1
        else if (
            known.some(
                p => trimmed.toLowerCase().startsWith(p.toLowerCase()) && trimmed.length > p.length
            )
        )
            count += 1
    }
    return count
}

async function ask(arm, seed, messages) {
    const started = Date.now()
    const response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({
            model: 'local',
            messages,
            tools: tools[arm].map(t => ({type: 'function', function: t})),
            tool_choice: 'auto',
            reasoning_effort: 'medium',
            // an unconstrained arm generates until something stops it: S4's first trial ran past
            // 11k tokens with no grammar to end the call. Same ceiling for every arm.
            max_tokens: 3072,
            seed
        })
    })
    // An unconstrained arm's arguments do not always parse, and llama.cpp answers the whole
    // request with 500 rather than handing the call over. That is a result, not an outage.
    if (!response.ok)
        return {
            rejected: `${response.status} ${(await response.text()).slice(0, 160)}`,
            message: {},
            usage: {},
            ms: Date.now() - started
        }
    const body = await response.json()
    return {
        message: body.choices?.[0]?.message ?? {},
        usage: body.usage ?? {},
        finish: body.choices?.[0]?.finish_reason,
        ms: Date.now() - started
    }
}

async function trial(armName, task, seed) {
    // An arm is decoded by its shape, not its name: S1 is whatever list the previous step built,
    // and since step 2 that is one `godot` tool.
    const arm = tools[armName].some(t => t.name === 'godot') ? ARMS.S2 : ARMS[armName]
    const messages = conversation(task, prompts[armName], arm)
    const row = {
        arm: armName,
        task: task.id,
        seed,
        turns: 0,
        calls: 0,
        godotCalls: 0,
        parsed: 0,
        unparsable: 0,
        rawValid: 0,
        opsDecoded: 0,
        canonValid: 0,
        undecodable: 0,
        swallowed: 0,
        promptTokens: 0,
        completionTokens: 0,
        ms: 0,
        done: 0,
        noCall: 0,
        truncated: 0,
        rejected: 0,
        multiCallTurns: 0,
        wrote: []
    }
    const seen = []
    let revision = 8
    for (let turn = 0; turn < TURNS; turn += 1) {
        const {message, usage, ms, finish, rejected} = await ask(armName, seed, messages)
        row.turns += 1
        row.ms += ms
        if (rejected) {
            row.rejected += 1
            row.why = rejected
            break
        }
        if (finish === 'length') row.truncated += 1
        row.promptTokens += usage.prompt_tokens ?? 0
        row.completionTokens += usage.completion_tokens ?? 0
        const calls = message.tool_calls ?? []
        row.calls += calls.length
        if (calls.length === 0) row.noCall += 1
        if (calls.length > 1) row.multiCallTurns += 1
        messages.push({
            role: 'assistant',
            content: message.content ?? null,
            ...(calls.length > 0 ? {tool_calls: calls} : {})
        })
        for (const call of calls) {
            const name = call.function?.name
            const godot = arm.isGodot(name)
            if (godot) row.godotCalls += 1
            let args
            try {
                args = JSON.parse(call.function?.arguments ?? '')
            } catch {
                row.unparsable += 1
                row.wrote.push({
                    tool: name,
                    raw: String(call.function?.arguments ?? '').slice(0, 400)
                })
                messages.push({
                    role: 'tool',
                    tool_call_id: call.id,
                    content: '{"error":"unparsable arguments"}'
                })
                continue
            }
            row.parsed += 1
            row.wrote.push({tool: name, args})
            if (own[armName][name]?.(args)) row.rawValid += 1
            const decoded = godot ? (arm.decode(name, args) ?? []) : []
            if (godot && decoded.length === 0) row.undecodable += 1
            for (const entry of decoded) {
                row.opsDecoded += 1
                const {tool, ...rest} = entry
                if (tool && canon[`${tool}::${rest.op}`]?.(rest)) row.canonValid += 1
                row.swallowed += swallowed(entry)
                seen.push(entry)
                revision += 1
            }
            if (!godot) {
                messages.push({
                    role: 'tool',
                    tool_call_id: call.id,
                    content: '{"error":"unavailable in this session"}'
                })
                continue
            }
            messages.push({
                role: 'tool',
                tool_call_id: call.id,
                content: arm.answer(name, args, (op, entry) => resultOf(op, entry, revision))
            })
        }
        if (task.wants(seen)) {
            row.done = 1
            break
        }
        if (calls.length === 0) break
    }
    if (task.id === 'batch20') Object.assign(row, batchProgress(seen))
    return row
}

const rows = []
for (let seed = FROM; seed <= SEEDS; seed += 1) {
    for (const task of TASKS.filter(t => !ONLY || ONLY.includes(t.id))) {
        for (const arm of NAMES) {
            let row
            try {
                row = await trial(arm, task, seed)
            } catch (error) {
                row = {arm, task: task.id, seed, error: String(error).slice(0, 200)}
            }
            rows.push(row)
            const {wrote, ...brief} = row
            console.log(JSON.stringify(brief))
            await writeFile(`${S}/${OUT}.json`, JSON.stringify(rows, null, 2))
        }
    }
}

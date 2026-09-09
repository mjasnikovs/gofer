import {readFile, writeFile} from 'node:fs/promises'
import Ajv from 'ajv'
import {normalizeGodotCall} from '../godot-tools.mjs'
import {TASKS, conversation, answerFor} from './shapes-tasks.mjs'

const S = process.env.SCRATCH ?? import.meta.dirname
const ENDPOINT = 'http://localhost:8080/v1/chat/completions'
const ARMS = process.env.ARMS?.split(',') ?? ['A', 'B', 'C']
const SEEDS = Number(process.env.SEEDS ?? 12)
const OUT = process.env.OUT ?? 'shapes-rows'
const TURNS = 3
const ONLY = process.env.ONLY?.split(',')

const catalog = JSON.parse(await readFile(`${S}/catalog.json`, 'utf8'))
const prompt = await readFile(`${S}/prompt.txt`, 'utf8')
const armTools = {}
for (const arm of ARMS)
    armTools[arm] = JSON.parse(await readFile(`${S}/shapes-tools-${arm}.json`, 'utf8'))

// One validator for every arm: the strict per-op schema the shipped commit introduced. Arm B is
// judged by the rule it predates, which is the whole point of asking whether it needed the rule.
const ajv = new Ajv({strict: false, allErrors: false})
const strict = Object.fromEntries(armTools.A.map(t => [t.name, ajv.compile(t.parameters)]))
const paramsOf = Object.fromEntries(
    catalog.map(d => [
        d.name,
        Object.fromEntries(d.operations.map(o => [o.op, (o.params ?? []).map(p => p.name)]))
    ])
)

/** A key that carried its own value: "limit 50", "minSeverityWarning", "size [16, 16]". */
function swallowed(tool, entry) {
    const known = paramsOf[tool]?.[entry?.op]
    if (!known) return 0
    let count = 0
    for (const key of Object.keys(entry)) {
        if (key === 'op' || known.includes(key)) continue
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
            tools: armTools[arm].map(t => ({type: 'function', function: t})),
            tool_choice: 'auto',
            reasoning_effort: 'medium',
            seed
        })
    })
    if (!response.ok) throw new Error(`${response.status} ${(await response.text()).slice(0, 200)}`)
    const body = await response.json()
    return {
        message: body.choices?.[0]?.message ?? {},
        usage: body.usage ?? {},
        ms: Date.now() - started
    }
}

async function trial(arm, task, seed) {
    const messages = conversation(task, prompt)
    const row = {
        arm,
        task: task.id,
        seed,
        turns: 0,
        calls: 0,
        parsed: 0,
        unparsable: 0,
        validRaw: 0,
        validRepaired: 0,
        swallowed: 0,
        promptTokens: 0,
        completionTokens: 0,
        ms: 0,
        done: 0,
        noCall: 0,
        wrote: []
    }
    const seen = []
    let revision = 8
    for (let turn = 0; turn < TURNS; turn += 1) {
        const {message, usage, ms} = await ask(arm, seed, messages)
        row.turns += 1
        row.ms += ms
        row.promptTokens += usage.prompt_tokens ?? 0
        row.completionTokens += usage.completion_tokens ?? 0
        const calls = message.tool_calls ?? []
        row.calls += calls.length
        if (calls.length === 0) row.noCall += 1
        messages.push({
            role: 'assistant',
            content: message.content ?? null,
            ...(calls.length > 0 ? {tool_calls: calls} : {})
        })
        for (const call of calls) {
            const name = call.function?.name
            let args
            try {
                args = JSON.parse(call.function?.arguments ?? '')
            } catch {
                row.unparsable += 1
                row.wrote.push({
                    tool: name,
                    raw: String(call.function?.arguments ?? '').slice(0, 400)
                })
                revision += 1
                messages.push({
                    role: 'tool',
                    tool_call_id: call.id,
                    content: '{"error":"unparsable arguments"}'
                })
                continue
            }
            row.parsed += 1
            row.wrote.push({tool: name, args})
            const check = strict[name]
            if (check?.(args)) row.validRaw += 1
            let repaired = args
            try {
                repaired = normalizeGodotCall(catalog, name, args)
            } catch {
                /* the repair layer refusing is itself an invalid call */
            }
            if (check?.(repaired)) row.validRepaired += 1
            for (const entry of Array.isArray(args?.ops) ? args.ops : [])
                row.swallowed += swallowed(name, entry)
            for (const entry of Array.isArray(repaired?.ops) ? repaired.ops : [])
                seen.push({tool: name, ...entry})
            revision += 1
            messages.push({
                role: 'tool',
                tool_call_id: call.id,
                content: answerFor(name, repaired, revision)
            })
        }
        if (task.wants(seen)) {
            row.done = 1
            break
        }
        if (calls.length === 0) break
    }
    return row
}

const rows = []
for (let seed = 1; seed <= SEEDS; seed += 1) {
    for (const task of TASKS.filter(t => !ONLY || ONLY.includes(t.id))) {
        for (const arm of ARMS) {
            let row
            try {
                row = await trial(arm, task, seed)
            } catch (error) {
                row = {arm, task: task.id, seed, error: String(error).slice(0, 200)}
            }
            rows.push(row)
            console.log(JSON.stringify(row))
            await writeFile(`${S}/${OUT}.json`, JSON.stringify(rows, null, 2))
        }
    }
}

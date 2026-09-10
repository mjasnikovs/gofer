// surf-run.mjs's loop, scored for one question: how does a model reach a file it was not given the
// path of. A and B are interleaved inside each (task, seed), same process, same seed.
import {readFile, writeFile} from 'node:fs/promises'
import {ARM, TASKS, bashScore, conversation, pathsIn, tracked, absolute} from './inv-tasks.mjs'

const S = process.env.SCRATCH ?? import.meta.dirname
const ENDPOINT = process.env.ENDPOINT ?? 'http://localhost:8080/v1/chat/completions'
const NAMES = process.env.ARMS?.split(',') ?? ['A', 'B']
const SEEDS = Number(process.env.SEEDS ?? 10)
const FROM = Number(process.env.FROM ?? 1)
const OUT = process.env.OUT ?? 'inv-rows'
const ONLY = process.env.ONLY?.split(',')
// One more than surf's three: finding the file is a turn these tasks spend before the work starts.
const TURNS = Number(process.env.TURNS ?? 4)

// Arm A is handed the inventory in the user message; arm B is handed the files.list operation.
const HAS_INVENTORY = {A: true, B: false}

const prompts = {}
const tools = {}
for (const arm of NAMES) {
    prompts[arm] = await readFile(`${S}/inv-prompt-${arm}.txt`, 'utf8')
    tools[arm] = JSON.parse(await readFile(`${S}/inv-tools-${arm}.json`, 'utf8'))
}

async function ask(arm, seed, messages) {
    const started = Date.now()
    const response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({
            model: 'local',
            messages,
            tools: tools[arm].map(tool => ({type: 'function', function: tool})),
            tool_choice: 'auto',
            reasoning_effort: 'medium',
            max_tokens: 3072,
            seed
        })
    })
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

async function trial(arm, task, seed) {
    const messages = conversation(task, prompts[arm], HAS_INVENTORY[arm])
    const row = {
        arm,
        task: task.id,
        seed,
        turns: 0,
        calls: 0,
        godotCalls: 0,
        opsDecoded: 0,
        listOps: 0,
        bashCalls: 0,
        findCalls: 0,
        ghostPaths: 0,
        absolutePaths: 0,
        unparsable: 0,
        promptTokens: 0,
        completionTokens: 0,
        ms: 0,
        done: 0,
        noCall: 0,
        truncated: 0,
        rejected: 0,
        ghosts: [],
        wrote: []
    }
    const seen = []
    for (let turn = 0; turn < TURNS; turn += 1) {
        const {message, usage, ms, finish, rejected} = await ask(arm, seed, messages)
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
        messages.push({
            role: 'assistant',
            content: message.content ?? null,
            ...(calls.length > 0 ? {tool_calls: calls} : {})
        })
        for (const call of calls) {
            const name = call.function?.name
            const godot = ARM.isGodot(name)
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
            row.wrote.push({tool: name, args})
            if (name === 'bash') {
                row.bashCalls += 1
                const {find, absolute: abs} = bashScore(args?.command)
                row.findCalls += find
                row.absolutePaths += abs
            }
            for (const entry of godot ? (ARM.decode(name, args) ?? []) : []) {
                row.opsDecoded += 1
                if (entry.op === 'list') row.listOps += 1
                for (const path of pathsIn(entry)) {
                    if (!tracked(path)) {
                        row.ghostPaths += 1
                        row.ghosts.push(path)
                    }
                    if (absolute(path)) row.absolutePaths += 1
                }
                seen.push(entry)
            }
            if (!godot) {
                // Every non-godot tool answers the way the other trims' extras do: the arm with the
                // inventory has no legitimate reason to shell out, and neither has the other.
                messages.push({
                    role: 'tool',
                    tool_call_id: call.id,
                    content: '{"error":"unavailable in this session"}'
                })
                continue
            }
            messages.push({role: 'tool', tool_call_id: call.id, content: ARM.answer(name, args)})
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
for (let seed = FROM; seed <= SEEDS; seed += 1) {
    for (const task of TASKS.filter(one => !ONLY || ONLY.includes(one.id))) {
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

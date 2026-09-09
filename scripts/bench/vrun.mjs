// One interleaved sweep over S2-shaped arms: same seed, same task, arms back to back.
import {readFile, writeFile} from 'node:fs/promises'
import Ajv from 'ajv'

const S = process.env.SCRATCH ?? import.meta.dirname
const ENDPOINT = 'http://localhost:8080/v1/chat/completions'
const PREFIX = process.env.PREFIX ?? 'vocab'
const NAMES = process.env.ARMS.split(',')
const SEEDS = Number(process.env.SEEDS ?? 10)
const FROM = Number(process.env.FROM ?? 1)
const OUT = process.env.OUT ?? `${PREFIX}-rows`
const ONLY = process.env.ONLY?.split(',')
const TURNS = Number(process.env.TURNS ?? 3)

const {TASKS, answerOf, HINTING, SESSION} = await import(`./${PREFIX}-tasks.mjs`)
const map = JSON.parse(await readFile(`${S}/surf-map.json`, 'utf8'))
const shared = await readFile(`${S}/prompt.txt`, 'utf8')
// An arm that ships its own system prompt is measured with it: <prefix>-prompt-<arm>.txt.
const prompts = {}
for (const arm of NAMES)
    prompts[arm] = await readFile(`${S}/${PREFIX}-prompt-${arm}.txt`, 'utf8').catch(() => shared)
const tools = {}
for (const arm of NAMES)
    tools[arm] = JSON.parse(await readFile(`${S}/${PREFIX}-tools-${arm}.json`, 'utf8'))

const ajv = new Ajv({strict: false, allErrors: false})
const own = Object.fromEntries(
    NAMES.map(arm => [
        arm,
        Object.fromEntries(tools[arm].map(t => [t.name, ajv.compile(t.parameters)]))
    ])
)

const opsOf = args => (Array.isArray(args?.ops) ? args.ops : [])
const bare = op => map.dot[op]?.[1] ?? String(op).split('.').pop()
const write = (op, params) => ({name: 'godot', arguments: JSON.stringify({ops: [{op, ...params}]})})

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

function conversation(task, arm) {
    const messages = [
        {role: 'system', content: prompts[arm]},
        {role: 'user', content: `${task.ask}\n\n${SESSION}`}
    ]
    for (const step of task.priming) {
        const written = write(step.op, step.params)
        messages.push({
            role: 'assistant',
            content: null,
            tool_calls: [{id: step.id, type: 'function', function: written}]
        })
        messages.push({
            role: 'tool',
            tool_call_id: step.id,
            content: JSON.stringify({ops: [{op: step.op, result: step.result}]})
        })
    }
    return messages
}

async function trial(arm, task, seed) {
    const hint = HINTING.has(arm)
    const messages = conversation(task, arm)
    const row = {
        arm,
        task: task.id,
        seed,
        turns: 0,
        calls: 0,
        parsed: 0,
        unparsable: 0,
        rawValid: 0,
        opsDecoded: 0,
        refusals: 0,
        traps: 0,
        promptTokens: 0,
        completionTokens: 0,
        ms: 0,
        done: 0,
        doneTurn: 0,
        firstTry: 0,
        noCall: 0,
        truncated: 0,
        rejected: 0,
        wrote: []
    }
    const seen = []
    let revision = 8
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
            let args
            try {
                args = JSON.parse(call.function?.arguments ?? '')
            } catch {
                row.unparsable += 1
                row.wrote.push({
                    turn,
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
            row.wrote.push({turn, tool: name, args})
            if (own[arm][name]?.(args)) row.rawValid += 1
            if (name !== 'godot') {
                messages.push({
                    role: 'tool',
                    tool_call_id: call.id,
                    content: '{"error":"unavailable in this session"}'
                })
                continue
            }
            const answered = []
            for (const raw of opsOf(args)) {
                const {op, ...rest} = raw && typeof raw === 'object' ? raw : {}
                row.opsDecoded += 1
                seen.push({op: bare(op), dotted: op, ...rest, turn})
                revision += 1
                const result = answerOf({
                    op: bare(op),
                    dotted: String(op),
                    entry: rest,
                    revision,
                    hint,
                    task
                })
                if (result?.error) row.refusals += 1
                if (result?.trap) row.traps += 1
                // `trap` is the sweep's own bookkeeping and `note` is empty unless an arm carries
                // the rule; neither belongs in what the model reads.
                const {trap, note, ...visible} = result
                answered.push({op, result: note ? {...visible, note} : visible})
            }
            messages.push({
                role: 'tool',
                tool_call_id: call.id,
                content: JSON.stringify({ops: answered})
            })
        }
        if (task.wants(seen) && row.done === 0) {
            row.done = 1
            row.doneTurn = turn + 1
            if (turn === 0) row.firstTry = 1
            // A rule about what NOT to call next is only visible if the turn after it runs.
            if (!task.settle) break
        }
        if (calls.length === 0) break
    }
    if (task.score) Object.assign(row, task.score(seen))
    return row
}

const rows = []
for (let seed = FROM; seed <= SEEDS; seed += 1)
    for (const task of TASKS.filter(t => !ONLY || ONLY.includes(t.id)))
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

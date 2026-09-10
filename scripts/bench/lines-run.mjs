// Does a line-numbered read fix the miscounted breakpoint line? Three arms over the shipped surface,
// differing only in how file text comes back: L0 raw (shipped), L1 `cat -n` numbering, L2 the same
// numbering plus one sentence on the read tool saying so, L4 that sentence with the bare number.
// Same prompt, same tools otherwise.
import {readFile, writeFile} from 'node:fs/promises'
import {ARMS} from './surf-arms.mjs'

const S = process.env.SCRATCH ?? import.meta.dirname
const REPO = new URL('../..', import.meta.url).pathname
const ENDPOINT = 'http://localhost:8080/v1/chat/completions'
const NAMES = process.env.ARMS?.split(',') ?? ['L0', 'L1', 'L2']
const SEEDS = Number(process.env.SEEDS ?? 10)
const FROM = Number(process.env.FROM ?? 1)
const OUT = process.env.OUT ?? 'lines-rows'
const ONLY = process.env.ONLY?.split(',')
const TURNS = 4

const SESSION =
    'Editor session: ready. Godot 4.7.2. Every tool runs in the project root and takes paths the way'
    + ' the project spells them, never an absolute one.'
const NUMBERED_NOTE = ' Each line is prefixed with its 1-indexed line number and a tab.'

const prompt = await readFile(`${S}/surf-prompt-S2.txt`, 'utf8')
const shipped = JSON.parse(await readFile(`${S}/surf-tools-S2.json`, 'utf8'))
const arm = ARMS.S2

const FILES = {
    'scripts/main.gd': await readFile(`${REPO}/fixtures/live-project/scripts/main.gd`, 'utf8'),
    'scripts/player.gd': await readFile(`${REPO}/fixtures/live-project/scripts/player.gd`, 'utf8'),
    'scripts/hero.gd': await readFile(`${S}/lines-long.gd`, 'utf8')
}

const TASKS = [
    {
        id: 'announce',
        path: 'scripts/main.gd',
        want: 26,
        ask: 'Put a breakpoint on the print line inside _announce in scripts/main.gd, launch the game under the debugger, wait for it to stop, and tell me the value of ticks there. Then terminate.'
    },
    {
        id: 'assign',
        path: 'scripts/main.gd',
        want: 19,
        ask: 'Launch the game under the debugger with a breakpoint on the total_ticks assignment inside _on_tick in scripts/main.gd. When it stops, report total_ticks and terminate.'
    },
    {
        id: 'warn',
        path: 'scripts/main.gd',
        want: 22,
        ask: 'Set a breakpoint on the push_warning line in scripts/main.gd and launch the game under the debugger. When it stops, tell me the value of ticks, then terminate.'
    },
    {
        id: 'travel',
        path: 'scripts/player.gd',
        want: 9,
        ask: 'Launch the game under the debugger with a breakpoint on the line in scripts/player.gd that adds to travelled. When it stops, report delta and terminate.'
    },
    {
        id: 'damage',
        path: 'scripts/hero.gd',
        want: 80,
        ask: 'Put a breakpoint on the line inside take_damage in scripts/hero.gd where health is assigned, launch the game under the debugger, wait for it to stop, and tell me health and amount there. Then terminate.'
    },
    {
        id: 'dash',
        path: 'scripts/hero.gd',
        want: 65,
        ask: 'Launch the game under the debugger with a breakpoint on the line in _read_input in scripts/hero.gd that sets dashing to true. When it stops, report velocity and terminate.'
    }
]

// L0 raw; L1/L2 `cat -n` padding; L4 the bare number, two tokens a line cheaper. O0/O1 take the
// read tool away so the file can only come back through script.open: raw, and numbered with the
// op's summary saying so (PAD sets O1's width).
const WIDTH = {L1: 6, L2: 6, L4: 0, O1: Number(process.env.PAD ?? 0)}
const NOTED = new Set(['L2', 'L4'])
const RAW = new Set(['L0', 'O0'])
const OPEN_ONLY = new Set(['O0', 'O1'])
const OPEN_SUMMARY = 'Opens a script as a language-server document.'

function numbered(text, width) {
    return text
        .replace(/\n$/u, '')
        .split('\n')
        .map((line, i) => `${String(i + 1).padStart(width)}\t${line}`)
        .join('\n')
}

const projectPath = path => String(path ?? '').replace(/^res:\/\//u, '')
const render = (armName, text) => (RAW.has(armName) ? text : numbered(text, WIDTH[armName]))

function toolsFor(armName) {
    return shipped
        .filter(tool => !(OPEN_ONLY.has(armName) && tool.name === 'read'))
        .map(tool => {
            if (tool.name === 'read' && NOTED.has(armName))
                return {...tool, description: tool.description + NUMBERED_NOTE}
            if (tool.name === 'godot' && armName === 'O1')
                return {
                    ...tool,
                    description: tool.description.replace(
                        OPEN_SUMMARY,
                        `${OPEN_SUMMARY.slice(0, -1)}, its text coming back with each line prefixed by its 1-indexed number and a tab.`
                    )
                }
            return tool
        })
}

/** Every breakpoint line one entry carries, whichever of the two ops spelled it. */
function breakpointsIn(entry) {
    const lines = value => (Array.isArray(value) ? value.map(Number) : [])
    if (entry.op === 'debug.set_breakpoints')
        return lines(entry.lines).map(line => ({path: entry.path, line}))
    if (entry.op === 'debug.launch')
        return (Array.isArray(entry.breakpoints) ? entry.breakpoints : []).flatMap(b =>
            lines(b?.lines).map(line => ({path: b?.path, line}))
        )
    return []
}

// Branches on the dotted op: `open` is a scene operation too, and `launch` a runtime one.
function answerOp(armName, entry, row) {
    const set = breakpointsIn(entry)
    if (entry.op === 'debug.launch' || entry.op === 'debug.set_breakpoints')
        return {
            op: entry.op === 'debug.launch' ? 'launched' : 'breakpoints',
            armed: set.map(b => `${b.path}:${b.line}`),
            breakpoints: set.map(b => ({...b, verified: true}))
        }
    if (entry.op === 'script.open') {
        row.opened += 1
        const paths = entry.paths ?? (entry.path ? [entry.path] : [])
        return {
            files: paths.map(path => ({
                path,
                text: render(armName, FILES[projectPath(path)] ?? '')
            }))
        }
    }
    if (entry.op === 'debug.breakpoint_locations')
        return {locations: [{line: entry.line, endLine: null}]}
    return {ok: true}
}

async function ask(armName, seed, messages) {
    const started = Date.now()
    const response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({
            model: 'local',
            messages,
            tools: toolsFor(armName).map(t => ({type: 'function', function: t})),
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

async function trial(armName, task, seed) {
    const messages = [
        {role: 'system', content: prompt},
        {role: 'user', content: `${task.ask}\n\n${SESSION}`}
    ]
    const row = {
        arm: armName,
        task: task.id,
        seed,
        want: task.want,
        named: null,
        hit: 0,
        off: null,
        turns: 0,
        calls: 0,
        read: 0,
        opened: 0,
        bash: 0,
        unparsable: 0,
        promptTokens: 0,
        completionTokens: 0,
        ms: 0,
        truncated: 0,
        rejected: 0,
        wrote: []
    }
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
                messages.push({
                    role: 'tool',
                    tool_call_id: call.id,
                    content: '{"error":"unparsable arguments"}'
                })
                continue
            }
            row.wrote.push({tool: name, args})
            let content
            if (name === 'read') {
                row.read += 1
                const text = FILES[String(args?.path ?? '').replace(/^res:\/\//u, '')]
                content =
                    text === undefined ?
                        `Error: file not found: ${args?.path}`
                    :   render(armName, text)
            } else if (name === 'godot') {
                const decoded = arm.decode(name, args) ?? []
                for (const entry of decoded) {
                    if (entry.tool !== 'godot_debug') continue
                    const first = breakpointsIn({...entry, op: `debug.${entry.op}`})[0]
                    if (first && row.named === null) {
                        row.named = first.line
                        row.namedPath = first.path
                        row.hit =
                            first.line === task.want && projectPath(first.path) === task.path ?
                                1
                            :   0
                        row.off = first.line - task.want
                    }
                }
                content = arm.answer(name, args, (op, entry) => answerOp(armName, entry, row))
            } else {
                if (name === 'bash') row.bash += 1
                content = '{"error":"unavailable in this session"}'
            }
            messages.push({role: 'tool', tool_call_id: call.id, content})
        }
        if (row.named !== null || calls.length === 0) break
    }
    return row
}

const rows = []
for (let seed = FROM; seed <= SEEDS; seed += 1) {
    for (const task of TASKS.filter(t => !ONLY || ONLY.includes(t.id))) {
        for (const armName of NAMES) {
            let row
            try {
                row = await trial(armName, task, seed)
            } catch (error) {
                row = {arm: armName, task: task.id, seed, error: String(error).slice(0, 200)}
            }
            rows.push(row)
            const {wrote, ...brief} = row
            console.log(JSON.stringify(brief))
            await writeFile(`${S}/${OUT}.json`, JSON.stringify(rows, null, 2))
        }
    }
}

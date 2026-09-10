// Does a numbered read leak its prefix into what the model writes back? L0 raw vs L2 numbered,
// three editing tasks; a leak is an `N\t` at any line start of an oldText, newText or saved text.
// O0/O1 take the read tool away so the text can only come from script.open: raw, and numbered with
// the op's summary saying so.
import {readFile, writeFile} from 'node:fs/promises'
import {ARMS} from './surf-arms.mjs'

const S = process.env.SCRATCH ?? import.meta.dirname
const REPO = new URL('../..', import.meta.url).pathname
const ENDPOINT = 'http://localhost:8080/v1/chat/completions'
const NAMES = process.env.ARMS?.split(',') ?? ['L0', 'L2']
const RAW = new Set(['L0', 'O0'])
const OPEN_ONLY = new Set(['O0', 'O1'])
const OPEN_SUMMARY = 'Opens a script as a language-server document.'
const projectPath = path => String(path ?? '').replace(/^res:\/\//u, '')
const SEEDS = Number(process.env.SEEDS ?? 10)
const OUT = process.env.OUT ?? 'lines-quote-rows'
const TURNS = 4
const SESSION =
    'Editor session: ready. Godot 4.7.2. Every tool runs in the project root and takes paths the way'
    + ' the project spells them, never an absolute one.'
const NUMBERED_NOTE = ' Each line is prefixed with its 1-indexed line number and a tab.'
const PREFIX = /^ *\d+\t/mu

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
        id: 'interval',
        ask: 'In scripts/main.gd change the default of tick_interval from 1.0 to 0.5 by replacing the exact text of that line with script.edit. Do not rewrite the whole file.',
        anchor: 'tick_interval: float = 1.0'
    },
    {
        id: 'walk',
        ask: 'In scripts/hero.gd change WALK_SPEED from 160.0 to 200.0 by replacing the exact text of that line with script.edit. Do not rewrite the whole file.',
        anchor: 'WALK_SPEED := 160.0'
    },
    {
        id: 'save',
        ask: 'Rewrite scripts/player.gd so that speed defaults to 48.0 and nothing else changes, and write it back whole with script.save.',
        anchor: 'extends Node2D'
    }
]
const numbered = text =>
    text
        .replace(/\n$/u, '')
        .split('\n')
        .map((l, i) => `${String(i + 1)}\t${l}`)
        .join('\n')
const render = (armName, text) => (RAW.has(armName) ? text : numbered(text))
const toolsFor = armName =>
    shipped
        .filter(t => !(OPEN_ONLY.has(armName) && t.name === 'read'))
        .map(t => {
            if (t.name === 'read' && armName === 'L2')
                return {...t, description: t.description + NUMBERED_NOTE}
            if (t.name === 'godot' && armName === 'O1')
                return {
                    ...t,
                    description: t.description.replace(
                        OPEN_SUMMARY,
                        `${OPEN_SUMMARY.slice(0, -1)}, its text coming back with each line prefixed by its 1-indexed number and a tab.`
                    )
                }
            return t
        })

// Branches on the dotted op: `save` and `open` are scene operations too.
function written(entry) {
    if (entry.op === 'script.edit')
        return (entry.files ?? []).flatMap(f =>
            (f.edits ?? []).flatMap(e => [String(e.oldText ?? ''), String(e.newText ?? '')])
        )
    if (entry.op === 'script.save') return [String(entry.text ?? '')]
    return []
}

async function ask(armName, seed, messages) {
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
    if (!response.ok) return {rejected: `${response.status}`, message: {}, usage: {}}
    const body = await response.json()
    return {message: body.choices?.[0]?.message ?? {}, usage: body.usage ?? {}}
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
        wrote: 0,
        leaked: 0,
        anchored: 0,
        read: 0,
        opened: 0,
        turns: 0,
        texts: []
    }
    for (let turn = 0; turn < TURNS; turn += 1) {
        const {message, rejected} = await ask(armName, seed, messages)
        row.turns += 1
        if (rejected) {
            row.rejected = rejected
            break
        }
        const calls = message.tool_calls ?? []
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
                messages.push({
                    role: 'tool',
                    tool_call_id: call.id,
                    content: '{"error":"unparsable arguments"}'
                })
                continue
            }
            let content
            if (name === 'read') {
                row.read += 1
                const text = FILES[projectPath(args?.path)]
                content =
                    text === undefined ?
                        `Error: file not found: ${args?.path}`
                    :   render(armName, text)
            } else if (name === 'godot') {
                content = arm.answer(name, args, (op, entry) => {
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
                    const texts = written(entry)
                    if (texts.length > 0) {
                        row.wrote += 1
                        row.texts.push(...texts)
                        if (texts.some(t => PREFIX.test(t))) row.leaked += 1
                        if (texts.some(t => t.includes(task.anchor))) row.anchored += 1
                    }
                    return entry.op === 'script.edit' ? {ok: true, diagnostics: []} : {ok: true}
                })
            } else content = '{"error":"unavailable in this session"}'
            messages.push({role: 'tool', tool_call_id: call.id, content})
        }
        if (row.wrote > 0 || calls.length === 0) break
    }
    return row
}

const rows = []
for (let seed = 1; seed <= SEEDS; seed += 1)
    for (const task of TASKS)
        for (const armName of NAMES) {
            const row = await trial(armName, task, seed)
            rows.push(row)
            const {texts, ...brief} = row
            console.log(JSON.stringify(brief))
            await writeFile(`${S}/${OUT}.json`, JSON.stringify(rows, null, 2))
        }
for (const armName of NAMES) {
    const of = rows.filter(r => r.arm === armName)
    console.log(
        armName,
        'wrote',
        of.filter(r => r.wrote).length,
        'leaked',
        of.filter(r => r.leaked).length,
        'anchored',
        of.filter(r => r.anchored).length,
        'of',
        of.length
    )
}

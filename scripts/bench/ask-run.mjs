// Does the model ask through ask_user, or write the question into its answer? Arms differ only in
// one prompt line (P1) and one sentence of the ask_user description (P2). Interleaved per seed.
import {readFile, appendFile} from 'node:fs/promises'

const S = process.env.SCRATCH ?? import.meta.dirname
const REPO = new URL('../..', import.meta.url).pathname
const ENDPOINT = 'http://localhost:8080/v1/chat/completions'
const NAMES = process.env.ARMS?.split(',') ?? ['P0', 'P1', 'P2']
const SEEDS = Number(process.env.SEEDS ?? 10)
const FROM = Number(process.env.FROM ?? 1)
const OUT = process.env.OUT ?? `${S}/ask2-rows.jsonl`
const ONLY = process.env.ONLY?.split(',')
const TURNS = 5

const prompt = await readFile(`${S}/prompt.txt`, 'utf8')
const shipped = JSON.parse(await readFile(`${S}/ask-tools.json`, 'utf8'))

const ASK_LINE =
    '- A question for the user goes through ask_user, never into your answer: your answer ends the turn, and nothing comes back for a question written in it'
const ASSET_SENTENCE =
    " The designer draws with the project's own art and fonts when the brief names them by res:// path, so name the files that belong in the layout."

const LAYOUT_LINE =
    "- A screen, menu or HUD whose layout nobody has settled is the user's to see before you build it: send ask_user a brief for it, and build from the layout that comes back"
const ANCHOR = '- Never claim an action succeeded unless a tool result says it did'
if (!prompt.includes(ANCHOR)) throw new Error('the anchor line is gone from the prompt')
const PROMPTS = {
    P0: prompt,
    P1: prompt.replace(ANCHOR, `${ANCHOR}\n${ASK_LINE}`),
    P3: prompt.replace(ANCHOR, `${ANCHOR}\n${ASK_LINE}\n${LAYOUT_LINE}`)
}
PROMPTS.P2 = PROMPTS.P1
PROMPTS.P4 = PROMPTS.P3
const ASSET_ARMS = new Set(['P2', 'P4'])

function toolsFor(armName) {
    return shipped.map(tool => {
        if (tool.name === 'ask_user' && ASSET_ARMS.has(armName)) {
            const anchor = 'That is what you build from.'
            if (!tool.description.includes(anchor)) throw new Error('P2 anchor gone')
            return {...tool, description: tool.description.replace(anchor, anchor + ASSET_SENTENCE)}
        }
        return tool
    })
}

const FILES = {}
for (const path of [
    'project.godot',
    'scenes/main.tscn',
    'scripts/main.gd',
    'scripts/player.gd',
    'assets/README.md',
    '.gitignore'
])
    FILES[path] = await readFile(`${REPO}/fixtures/live-project/${path}`, 'utf8')

const INVENTORY = [
    '.gitignore',
    'assets/README.md',
    'assets/tiles.png',
    'project.godot',
    'scenes/main.tscn',
    'scripts/main.gd',
    'scripts/player.gd'
]
const TAIL =
    'Editor session: ready. Godot 4.7.2. Every tool runs in the project root and takes paths the way the project spells them, never an absolute one.'
    + "\n\nThe project's tracked files are listed below. Read them here rather than listing the project; list again only after you have written a file this list does not name.\n\n"
    + INVENTORY.join('\n')

const TREE = {
    root: 'Main',
    nodes: [
        {path: '/Main', type: 'Node2D', script: 'res://scripts/main.gd'},
        {path: '/Main/Ticker', type: 'Node'},
        {path: '/Main/Ticker/Timer', type: 'Timer'},
        {path: '/Main/Player', type: 'Node2D', script: 'res://scripts/player.gd'},
        {path: '/Main/Player/Label', type: 'Label'}
    ]
}

const TASKS = [
    {id: 'boss', want: 'ask', ask: 'Make the boss twice as fast.'},
    {
        id: 'hud',
        want: 'brief',
        ask: 'Add a HUD to the main scene: a health bar, the score and a minimap.'
    },
    {
        id: 'title',
        want: 'brief-asset',
        ask: 'Make a title screen scene for this game that uses the art in assets/.'
    },
    {
        id: 'look',
        want: 'ask',
        ask: "Give the Player some proper art instead of the placeholder label. I haven't settled on a look yet."
    },
    {id: 'control', want: 'none', ask: 'Rename the Label node to Title and save the scene.'}
]

const numbered = text =>
    text
        .replace(/\n$/u, '')
        .split('\n')
        .map((line, i) => `${String(i + 1)}\t${line}`)
        .join('\n')
const projectPath = path => String(path ?? '').replace(/^res:\/\//u, '')

function answerOp(entry) {
    if (entry.op === 'scene.get_tree') return TREE
    if (entry.op === 'scene.list')
        return {scenes: ['res://scenes/main.tscn'], open: 'res://scenes/main.tscn'}
    if (entry.op === 'scene.open') return {opened: 'res://scenes/main.tscn'}
    if (entry.op === 'script.list')
        return {
            scripts: [
                {path: 'res://scripts/main.gd', bytes: 500},
                {path: 'res://scripts/player.gd', bytes: 120}
            ]
        }
    if (entry.op === 'script.open') {
        const paths = entry.paths ?? (entry.path ? [entry.path] : [])
        return {files: paths.map(path => ({path, text: numbered(FILES[projectPath(path)] ?? '')}))}
    }
    if (entry.op === 'node.inspect') {
        const node = TREE.nodes.find(n => n.path === entry.node)
        if (!node)
            return {
                error: {code: 'node_not_found', message: `${entry.node} is not in the edited scene`}
            }
        return {
            path: node.path,
            type: node.type,
            properties: {position: {x: 64, y: 200}},
            groups: [],
            signals: []
        }
    }
    if (entry.op === 'resource.list')
        return {
            files: INVENTORY.filter(f => !f.startsWith('.')).map(path => ({
                path: `res://${path}`,
                bytes: 400
            }))
        }
    if (entry.op?.startsWith('docs_search'))
        return {
            results: [
                {
                    title: 'Control',
                    excerpt:
                        'Base class for all GUI controls. Adapts its position and size based on its parent control.'
                }
            ]
        }
    if (entry.op?.startsWith('session')) return {status: 'ready', engine: '4.7.2'}
    return {ok: true}
}

function answerTool(call) {
    const name = call.function?.name
    let args = {}
    try {
        args = JSON.parse(call.function?.arguments ?? '{}')
    } catch {
        return {text: 'The arguments were not valid JSON.', unparsable: true}
    }
    if (name === 'ask_user')
        return {
            text: 'The user chose not to decide this. Make the call yourself and say which way you went. Do not ask again.',
            asked: args
        }
    if (name === 'godot') {
        const ops = Array.isArray(args.ops) ? args.ops : [args]
        return {text: JSON.stringify({ops: ops.map(op => ({op: op.op, result: answerOp(op)}))})}
    }
    if (name === 'read') {
        const text = FILES[projectPath(args.path)]
        return {
            text:
                text === undefined ?
                    `read: ${String(args.path)} is not in the project`
                :   numbered(text)
        }
    }
    if (name === 'grep' || name === 'bash') return {text: ''}
    if (name === 'subagent')
        return {
            text: 'The project holds one scene, scenes/main.tscn: Main (Node2D, scripts/main.gd) with Ticker/Timer and Player (Node2D, scripts/player.gd) carrying a Label. The only art is assets/tiles.png, a 128x32 platformer atlas described in assets/README.md. No other nodes, scripts or scenes exist.'
        }
    if (name === 'web_search') return {text: 'No results.'}
    if (name === 'web_fetch') return {text: 'Nothing readable at that address.'}
    if (name === 'remember') return {text: 'Remembered.'}
    if (name === 'write' || name === 'edit') return {text: 'ok'}
    return {text: 'ok'}
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
            max_tokens: 4096,
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
        {role: 'system', content: PROMPTS[armName]},
        {role: 'user', content: `${task.ask}\n\n${TAIL}`}
    ]
    const row = {
        arm: armName,
        task: task.id,
        seed,
        want: task.want,
        turns: 0,
        calls: 0,
        askUser: 0,
        brief: null,
        briefAsset: 0,
        question: null,
        textQuestion: 0,
        finalText: null,
        tools: [],
        ms: 0,
        rejected: 0,
        truncated: 0
    }
    for (let turn = 0; turn < TURNS; turn += 1) {
        const {message, finish, ms, rejected} = await ask(armName, seed, messages)
        row.ms += ms
        if (rejected) {
            row.rejected += 1
            row.finalText = rejected
            break
        }
        row.turns += 1
        if (finish === 'length') row.truncated += 1
        const calls = message.tool_calls ?? []
        messages.push({
            role: 'assistant',
            content: message.content ?? null,
            ...(calls.length ? {tool_calls: calls} : {})
        })
        if (calls.length === 0) {
            row.finalText = String(message.content ?? '').slice(0, 600)
            row.textQuestion =
                (
                    /\?\s*$/u.test(String(message.content ?? '').trim())
                    || /\?/u.test(
                        String(message.content ?? '')
                            .split('\n')
                            .slice(-3)
                            .join('\n')
                    )
                ) ?
                    1
                :   0
            break
        }
        let stop = false
        for (const call of calls) {
            row.calls += 1
            row.tools.push(call.function?.name)
            const answer = answerTool(call)
            if (answer.asked) {
                row.askUser += 1
                row.question = String(answer.asked.question ?? '').slice(0, 300)
                if (typeof answer.asked.brief === 'string') {
                    row.brief = answer.asked.brief.slice(0, 600)
                    row.briefAsset = /res:\/\/|tiles\.png/u.test(answer.asked.brief) ? 1 : 0
                }
                stop = true
            }
            messages.push({role: 'tool', tool_call_id: call.id, content: answer.text})
        }
        if (stop) break
    }
    return row
}

const tasks = ONLY ? TASKS.filter(t => ONLY.includes(t.id)) : TASKS
const done = new Set()
try {
    for (const line of (await readFile(OUT, 'utf8')).split('\n')) {
        if (!line.trim()) continue
        const row = JSON.parse(line)
        if (!row.rejected) done.add(`${row.arm}|${row.task}|${String(row.seed)}`)
    }
} catch {}
const PLAN = {boss: ['P0', 'P1'], hud: ['P1', 'P3'], title: ['P1', 'P3', 'P4']}
const armsFor = task => PLAN[task.id] ?? []
for (let seed = FROM; seed < FROM + SEEDS; seed += 1) {
    for (const task of tasks) {
        for (const armName of armsFor(task)) {
            if (done.has(`${armName}|${task.id}|${String(seed)}`)) continue
            const row = await trial(armName, task, seed)
            await appendFile(OUT, JSON.stringify(row) + '\n')
            process.stdout.write(
                `${armName} ${task.id.padEnd(8)} s${seed} ask=${row.askUser} brief=${row.brief ? 1 : 0} asset=${row.briefAsset} textQ=${row.textQuestion} turns=${row.turns} ${row.ms}ms ${row.rejected ? 'REJECTED ' + row.finalText : ''}\n`
            )
        }
    }
}
process.stdout.write('ASK-DONE\n')

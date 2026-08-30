import {execFileSync} from 'node:child_process'
import {writeFileSync, readFileSync, mkdtempSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const BASE = process.env.GOFER_BENCH_BASE ?? 'http://127.0.0.1:8080/v1/chat/completions'
const MODEL = process.env.GOFER_BENCH_MODEL ?? '/models/Qwen3.6-27B-NVFP4-MTP.gguf'
const OUT = mkdtempSync(join(tmpdir(), 'bench-alone-out-'))

function realCatalog() {
    const path = join(OUT, 'catalog.json')
    execFileSync(
        'cargo',
        [
            'test',
            '--quiet',
            '--manifest-path',
            join(ROOT, 'src-tauri/Cargo.toml'),
            'dump_the_catalog_when_asked'
        ],
        {env: {...process.env, GOFER_CATALOG_DUMP: path}, stdio: 'ignore'}
    )
    return JSON.parse(readFileSync(path, 'utf8'))
}

const catalog = realCatalog()

const BASELINE = process.env.GOFER_BENCH_BASELINE ?? 'c0e7a5a^'

async function variants() {
    const stage = mkdtempSync(join(tmpdir(), 'bench-alone-'))
    const baseline = join(stage, 'baseline.mjs')
    writeFileSync(
        baseline,
        execFileSync('git', ['-C', ROOT, 'show', `${BASELINE}:scripts/ai-host.mjs`], {
            encoding: 'utf8'
        })
    )
    return {
        before: (await import(baseline)).createGodotTools,
        after: (await import(join(ROOT, 'scripts/godot-tools.mjs'))).createGodotTools
    }
}

function asChatTools(build, names) {
    return build(
        catalog.filter(domain => names.includes(domain.name)),
        {call: async () => ({})}
    ).map(tool => ({
        type: 'function',
        function: {name: tool.name, description: tool.description, parameters: tool.parameters}
    }))
}

const SYSTEM =
    'You are editing a Godot project through the tools you are given. '
    + 'Call exactly one tool. Do not explain.'

const SESSION_TASKS = [
    {
        id: 'start-then-status',
        text: 'Start the Godot editor session, then report its status.'
    },
    {
        id: 'undo-twice',
        text: 'Undo the last two editor operations.'
    },
    {
        id: 'state-then-dialog',
        text:
            'The editor is blocked on a dialog. Read the session state, then press its "Discard"'
            + ' button.'
    },
    {
        id: 'stop-then-start',
        text: 'Restart the editor session: stop it and start it again.'
    }
]

const NODE_TASK = {
    id: 'three-children',
    text:
        'The edited scene revision is 3. Under the node /Root, create three Node2D children named'
        + ' A, B and C.'
}

async function ask(messages, tools, seed) {
    const response = await fetch(BASE, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
            model: MODEL,
            messages,
            tools,
            tool_choice: 'auto',
            temperature: 0.7,
            seed,
            max_tokens: 900
        })
    })
    if (!response.ok) throw new Error(`${String(response.status)} ${await response.text()}`)
    return response.json()
}

function firstCall(reply) {
    const message = reply.choices[0].message
    for (const call of message.tool_calls ?? []) {
        let args = {}
        try {
            args = JSON.parse(call.function.arguments)
        } catch {
            args = {_unparsable: call.function.arguments}
        }
        return {name: call.function.name, args}
    }
    return {name: undefined, args: undefined}
}

function opsOf(args) {
    if (!args) return []
    if (Array.isArray(args.ops)) return args.ops
    return args.op ? [args] : []
}

const trials = Number(process.argv[2] ?? 8)
const seeds = Array.from({length: trials}, (_, index) => index + 1)
const {before, after} = await variants()

const tools = {
    before: {
        session: asChatTools(before, ['godot_session']),
        node: asChatTools(before, ['godot_node'])
    },
    after: {
        session: asChatTools(after, ['godot_session']),
        node: asChatTools(after, ['godot_node'])
    }
}

const report = {trials, hits: [], counts: {}}
const bump = key => {
    report.counts[key] = (report.counts[key] ?? 0) + 1
}

for (const seed of seeds) {
    for (const task of SESSION_TASKS) {
        for (const side of ['before', 'after']) {
            const {name, args} = firstCall(
                await ask(
                    [
                        {role: 'system', content: SYSTEM},
                        {role: 'user', content: task.text}
                    ],
                    tools[side].session,
                    seed
                )
            )
            const ops = opsOf(args)
            bump(`${side}.calls`)
            if (ops.length > 1) {
                bump(`${side}.batched`)
                report.hits.push({side, seed, task: task.id, name, args})
            }
            console.log(
                `${side} ${task.id} seed=${String(seed)} ops=${String(ops.length)}`
                    + ` [${ops.map(entry => entry?.op).join(',')}]`
            )
        }
    }
    for (const side of ['before', 'after']) {
        const {args} = firstCall(
            await ask(
                [
                    {role: 'system', content: SYSTEM},
                    {role: 'user', content: NODE_TASK.text}
                ],
                tools[side].node,
                seed
            )
        )
        const ops = opsOf(args)
        bump(`${side}.node.calls`)
        if (ops.length > 1) bump(`${side}.node.batched`)
        console.log(`${side} ${NODE_TASK.id} seed=${String(seed)} ops=${String(ops.length)}`)
    }
}

writeFileSync(join(OUT, 'bench-alone.json'), JSON.stringify(report, undefined, 1))
console.log(JSON.stringify(report.counts, undefined, 1))
console.log(`hits: ${String(report.hits.length)}`)

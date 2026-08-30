import {execFileSync, spawn} from 'node:child_process'
import {homedir} from 'node:os'
import {dirname, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const WORKER = resolve(ROOT, 'src-tauri/workers/rag-retrieve-worker.mjs')
const NODE = resolve(ROOT, 'src-tauri/runtime/node')
const CACHE = resolve(homedir(), '.cache/gofer-rag')
const KEY = execFileSync(
    'secret-tool',
    ['lookup', 'service', 'com.gofer.desktop', 'username', 'ai-openrouter'],
    {encoding: 'utf8'}
).trim()

const connection = {
    connectionType: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: process.env.OX_MODEL ?? 'z-ai/glm-5.3-flash',
    modelName: 'Ox Alpha',
    apiKey: KEY,
    thinkingLevel: process.env.OX_LEVEL ?? 'low',
    contextWindow: 1048576,
    maxTokens: 131072,
    reasoning: true,
    supportsReasoningEffort: true,
    reasoningMandatory: true,
    thinkingLevels: ['max', 'high', 'low'],
    chatTemplateThinking: false,
    timeoutMs: 120000,
    maxRetries: 2
}

const run = (mode, question) =>
    new Promise(done => {
        const child = spawn(NODE, [WORKER], {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: {
                ...process.env,
                GOFER_RAG_DATABASE_PATH: resolve(ROOT, 'src-tauri/workers/.lancedb')
            }
        })
        let out = ''
        let err = ''
        const started = Date.now()
        child.stdout.on('data', d => {
            out += d
        })
        child.stderr.on('data', d => {
            err += d
        })
        child.on('close', () => {
            let parsed
            const line = out.split('\n').find(l => l.startsWith('GOFER_RAG_RESULT:'))
            try {
                parsed = JSON.parse(line.slice('GOFER_RAG_RESULT:'.length))
            } catch {
                parsed = {raw: out.slice(-400), err: err.slice(-400)}
            }
            done({mode, question, ms: Date.now() - started, parsed})
        })
        child.stdin.end(
            JSON.stringify({
                mode,
                question,
                cacheDir: CACHE,
                maxPassages: 8,
                maxTextChars: 4000,
                connection
            }) + '\n'
        )
    })

const QUESTIONS = [
    [
        'move_and_slide',
        'What is the exact return type and signature of CharacterBody2D.move_and_slide in Godot 4?',
        /bool\s+move_and_slide/i
    ],
    [
        'area_entered',
        'What argument does the Area2D area_entered signal pass to its handler?',
        /Area2D/
    ],
    [
        'queue_free',
        'What does Node.queue_free do and when is the node actually removed?',
        /idle|frame|end of/i
    ],
    [
        'tween',
        'How do you create a Tween in Godot 4 from a Node, and what method starts a property animation?',
        /create_tween/
    ],
    [
        'input_event',
        'Which method do you override to receive unhandled input events in a Node?',
        /_unhandled_input/
    ],
    [
        'tilemap',
        'What replaced TileMap in Godot 4.3 and how are layers handled now?',
        /TileMapLayer/i
    ]
]

const rows = []
for (const [name, question, wanted] of QUESTIONS) {
    for (const mode of ['search', 'ask']) {
        const r = await run(mode, question)
        const text = JSON.stringify(r.parsed)
        rows.push({
            name,
            mode,
            ms: r.ms,
            chars: text.length,
            error: r.parsed?.error?.message ?? r.parsed?.error ?? null,
            hasFact: wanted.test(text)
        })
        console.log(
            `${name.padEnd(14)} ${mode.padEnd(7)} ${String(r.ms).padStart(6)}ms  `
                + `${String(text.length).padStart(7)} chars  fact=${wanted.test(text)}  `
                + `${rows.at(-1).error ? 'ERR ' + String(rows.at(-1).error).slice(0, 60) : ''}`
        )
    }
}
const by = mode => rows.filter(r => r.mode === mode)
for (const mode of ['search', 'ask']) {
    const m = by(mode)
    const ms = m.reduce((a, r) => a + r.ms, 0) / m.length
    const chars = m.reduce((a, r) => a + r.chars, 0) / m.length
    console.log(
        `\n${mode}: ${Math.round(ms)}ms avg, ${Math.round(chars)} chars avg, `
            + `${m.filter(r => r.hasFact).length}/${m.length} carried the fact, `
            + `${m.filter(r => r.error).length} errors`
    )
}

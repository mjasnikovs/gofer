import {execFileSync, spawn} from 'node:child_process'
import {homedir} from 'node:os'
import {dirname, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WORKER = resolve(ROOT, 'src-tauri/workers/rag-retrieve-worker.mjs')
const NODE = resolve(ROOT, 'src-tauri/runtime/node')
const CACHE = resolve(homedir(), '.cache/gofer-rag')

const connection =
    process.env.OX_MODEL ?
        {
            connectionType: 'openrouter',
            baseUrl: 'https://openrouter.ai/api/v1',
            model: process.env.OX_MODEL,
            modelName: 'Ox Alpha',
            apiKey: execFileSync(
                'secret-tool',
                ['lookup', 'service', 'com.gofer.desktop', 'username', 'ai-openrouter'],
                {encoding: 'utf8'}
            ).trim(),
            thinkingLevel: 'low',
            reasoning: true,
            supportsReasoningEffort: true,
            reasoningMandatory: true,
            thinkingLevels: ['max', 'high', 'low'],
            contextWindow: 1048576,
            maxTokens: 131072,
            chatTemplateThinking: false,
            timeoutMs: 120000,
            maxRetries: 2
        }
    :   {
            connectionType: 'openai-compatible',
            baseUrl: 'http://127.0.0.1:8080/v1',
            model: 'local',
            modelName: 'local',
            apiKey: '',
            thinkingLevel: 'off',
            reasoning: false,
            supportsReasoningEffort: false,
            reasoningMandatory: false,
            thinkingLevels: [],
            contextWindow: 120064,
            maxTokens: 120064,
            chatTemplateThinking: true,
            timeoutMs: 120000,
            maxRetries: 2
        }

const retrieve = question =>
    new Promise(done => {
        const child = spawn(NODE, [WORKER], {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: {
                ...process.env,
                GOFER_RAG_DATABASE_PATH: resolve(ROOT, 'src-tauri/workers/.lancedb')
            }
        })
        let out = ''
        child.stdout.on('data', chunk => {
            out += chunk
        })
        child.on('close', () => {
            const line = out.split('\n').find(one => one.startsWith('GOFER_RAG_RESULT:'))
            try {
                done(JSON.parse(line.slice('GOFER_RAG_RESULT:'.length)))
            } catch {
                done({passages: [], raw: out.slice(-300)})
            }
        })
        child.stdin.end(
            `${JSON.stringify({
                mode: 'search',
                question,
                cacheDir: CACHE,
                maxPassages: 4,
                maxTextChars: 100_000,
                connection
            })}\n`
        )
    })

const QUESTIONS = [
    [
        'move_and_slide',
        'What is the exact return type and signature of CharacterBody2D.move_and_slide in Godot 4?',
        /bool\s+move_and_slide/iu
    ],
    [
        'area_entered',
        'What argument does the Area2D area_entered signal pass to its handler?',
        /Area2D/u
    ],
    [
        'queue_free',
        'What does Node.queue_free do and when is the node actually removed?',
        /idle|frame|end of/iu
    ],
    [
        'tween',
        'How do you create a Tween in Godot 4 from a Node, and what method starts a property animation?',
        /create_tween/u
    ],
    [
        'input_event',
        'Which method do you override to receive unhandled input events in a Node?',
        /_unhandled_input/u
    ],
    [
        'tilemap',
        'What replaced TileMap in Godot 4.3 and how are layers handled now?',
        /TileMapLayer/iu
    ]
]

const CEILINGS = [100_000, 3000, 2000, 1500, 1200, 900, 600, 400]
const totals = new Map(CEILINGS.map(cap => [cap, {chars: 0, facts: 0, cut: 0}]))

for (const [name, question, wanted] of QUESTIONS) {
    const answer = await retrieve(question)
    const passages = answer.passages ?? []
    const lengths = passages.map(passage => passage.text.length)
    process.stdout.write(`${name.padEnd(16)} passages ${JSON.stringify(lengths)}\n`)
    for (const cap of CEILINGS) {
        const capped = passages.map(passage => ({...passage, text: passage.text.slice(0, cap)}))
        const text = JSON.stringify(capped)
        const held = totals.get(cap)
        held.chars += text.length
        held.facts += wanted.test(text) ? 1 : 0
        held.cut += lengths.filter(length => length > cap).length
    }
}

console.log('\ncap      chars   facts  passages cut')
const whole = totals.get(100_000).chars
for (const cap of CEILINGS) {
    const held = totals.get(cap)
    const share = Math.round((100 * held.chars) / whole)
    console.log(
        `${String(cap).padStart(6)}  ${String(held.chars).padStart(7)}  `
            + `${held.facts}/${QUESTIONS.length}   ${held.cut}  (${share}% of the bytes)`
    )
}

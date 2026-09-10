#!/usr/bin/env node
// One live turn of the real agent against a real editor, recorded into logs/tool-ledger.sqlite.
//
//   node scripts/live-turn.mjs <name> --id <bank id> [--fixture <name>] [--vulkan] [--budget <s>]
//   node scripts/live-turn.mjs <name> --task "<ask>" --fixture live-project
//
// The run's files land in logs/live/<name>/: the events, the op ledger, the kept worktree, and the
// cargo output. Read the result with `node scripts/tool-report.mjs run <name>`.
import {spawn} from 'node:child_process'
import {cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {parseArgs} from 'node:util'
import {virtualDisplayEnv} from './virtual-display.mjs'
import {
    CONTRACT_CODES,
    callsFromEvents,
    loadTaskBank,
    openLedger,
    opsFromLedger,
    recordRun
} from './tool-ledger.mjs'

const {values, positionals} = parseArgs({
    allowPositionals: true,
    options: {
        id: {type: 'string'},
        task: {type: 'string'},
        fixture: {type: 'string'},
        vulkan: {type: 'boolean', default: false},
        images: {type: 'boolean', default: false},
        thinking: {type: 'string'},
        model: {type: 'string', default: 'local'},
        budget: {type: 'string'}
    }
})
const [name] = positionals
if (!name) throw new Error('name the run: live-turn.mjs <name> --id <bank id>')

let task = values.task
let fixture = values.fixture
let taskId = null
if (values.id) {
    const found = loadTaskBank().find(entry => entry.id === values.id)
    if (!found) throw new Error(`the task bank has no ${values.id}`)
    task = found.task
    fixture ??= found.fixture
    taskId = found.id
}
if (!task) throw new Error('give --id <bank id> or --task "<ask>"')
fixture ??= 'live-project'

const runDir = resolve('logs/live', name)
rmSync(runDir, {recursive: true, force: true})
mkdirSync(runDir, {recursive: true})

let fixturePath = resolve('fixtures', fixture)
if (!existsSync(fixturePath)) throw new Error(`no fixture at ${fixturePath}`)
if (values.vulkan) {
    // gl_compatibility cannot get a GL context while llama-server holds the GPUs; Vulkan still can.
    const copy = resolve(runDir, 'fixture')
    cpSync(fixturePath, copy, {recursive: true})
    const godot = resolve(copy, 'project.godot')
    writeFileSync(
        godot,
        readFileSync(godot, 'utf8').replace(
            'renderer/rendering_method="gl_compatibility"',
            'renderer/rendering_method="forward_plus"'
        )
    )
    fixturePath = copy
}

const out = resolve(runDir, 'turn.json')
const ledger = resolve(runDir, 'ledger.jsonl')
// The test binary has no Tauri resource directory, so the bundled sidecar is only reachable
// through the override; without it every script.format answers formatter_unavailable.
const sidecar = resolve('src-tauri/sidecar/gdformat')
const formatter = process.env.GOFER_GDFORMAT ?? (existsSync(sidecar) ? sidecar : undefined)
const env = virtualDisplayEnv({
    ...process.env,
    ...(formatter ? {GOFER_GDFORMAT: formatter} : {}),
    GOFER_LIVE_TASK: task,
    GOFER_LIVE_OUT: out,
    GOFER_LIVE_FIXTURE: fixturePath,
    GOFER_LIVE_KEEP: resolve(runDir, 'worktree'),
    GOFER_LIVE_IMAGES: values.images ? 'on' : 'off',
    GOFER_LIVE_MODEL: values.model,
    GOFER_DISPATCH_LEDGER: ledger,
    ...(values.thinking ? {GOFER_LIVE_THINKING: values.thinking} : {})
})

const startedAt = Date.now()
const child = spawn(
    'xvfb-run',
    [
        '-a',
        'cargo',
        'test',
        '--manifest-path',
        'src-tauri/Cargo.toml',
        '--features',
        'godot-acceptance',
        '--lib',
        '--',
        'live_agent_acceptance',
        '--test-threads=1',
        '--nocapture'
    ],
    {env, detached: true, stdio: ['ignore', 'pipe', 'pipe']}
)
let log = ''
child.stdout.on('data', chunk => (log += chunk))
child.stderr.on('data', chunk => (log += chunk))

// The budget is the caller's cost cap for one turn, never a guess at how long a turn takes.
let killed = false
const budget =
    values.budget ?
        setTimeout(
            () => {
                killed = true
                try {
                    process.kill(-child.pid, 'SIGKILL')
                } catch {}
            },
            Number(values.budget) * 1000
        )
    :   null

const exitStatus = await new Promise(settle => child.on('close', settle))
if (budget) clearTimeout(budget)
writeFileSync(resolve(runDir, 'cargo.log'), log)

const seconds = (Date.now() - startedAt) / 1000
const readLines = path => (existsSync(path) ? readFileSync(path, 'utf8').split('\n') : [])
const calls = callsFromEvents(readLines(resolve(runDir, 'turn.jsonl')))
const ops = opsFromLedger(readLines(ledger))
let report = {}
try {
    report = JSON.parse(readFileSync(out, 'utf8'))
} catch {}

const db = openLedger()
recordRun(
    db,
    {
        name,
        taskId,
        task,
        fixture: values.vulkan ? `${fixture}+vulkan` : fixture,
        model: values.model,
        startedAt,
        seconds: report.seconds ?? seconds,
        exitStatus: killed ? -1 : exitStatus,
        completion: report.completion ?? null,
        failure:
            report.failure
            ?? (killed ? `killed at the ${values.budget}s budget`
            : exitStatus === 0 ? null
            : `cargo exited ${exitStatus}`)
    },
    calls,
    ops
)
db.close()

const refused =
    ops.filter(op => op.code).length
    + calls.filter(call => call.tool === 'godot' && CONTRACT_CODES.has(call.code)).length
process.stdout.write(
    `${name}: ${
        killed ? 'KILLED'
        : exitStatus === 0 ? 'done'
        : `exit ${exitStatus}`
    } in ${seconds.toFixed(0)}s, `
        + `${calls.length} calls, ${ops.length} ops, ${refused} refused, `
        + `${report.completion ? `answered ${report.completion.length} chars` : `no answer: ${report.failure ?? 'no report'}`}\n`
)

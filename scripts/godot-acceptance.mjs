import {cpus} from 'node:os'
import {dirname, resolve} from 'node:path'
import {readFileSync, rmSync, writeFileSync} from 'node:fs'
import {spawn, spawnSync} from 'node:child_process'
import {reexecUnderVirtualDisplay} from './virtual-display.mjs'

const MANIFEST = 'src-tauri/Cargo.toml'
const FEATURE = 'godot-acceptance'
const FILTER = 'acceptance'
const PACKAGE = dirname(MANIFEST)
const jobs = Number(process.env.GOFER_GODOT_JOBS) || Math.max(1, Math.floor(cpus().length / 2))

reexecUnderVirtualDisplay()

function cargo(args, options = {}) {
    return spawnSync('cargo', args, {encoding: 'utf8', ...options})
}

const built = cargo(
    [
        'test',
        '--quiet',
        '--manifest-path',
        MANIFEST,
        '--features',
        FEATURE,
        '--no-run',
        '--message-format',
        'json'
    ],
    {stdio: ['inherit', 'pipe', 'inherit']}
)
const messages = built.stdout
    .split('\n')
    .filter(line => line.startsWith('{'))
    .map(line => JSON.parse(line))

// --message-format json puts the diagnostics on the piped stdout, so a failed build
// otherwise reports only cargo's summary line and none of the errors it counted.
if (built.status !== 0) {
    for (const message of messages) {
        if (message.reason === 'compiler-message' && message.message?.rendered)
            process.stderr.write(message.message.rendered)
    }
    process.exit(built.status ?? 1)
}

const binary = messages.findLast(
    message => message.executable && message.target?.name === 'gofer_lib'
)?.executable
if (!binary) throw new Error('The Godot acceptance build produced no library test binary')

const listed = spawnSync(binary, ['--list'], {encoding: 'utf8', cwd: PACKAGE})
if (listed.status !== 0) {
    process.stderr.write(listed.stderr ?? '')
    throw new Error('Could not list the Godot acceptance tests')
}
const TIMES = resolve('src-tauri/target/godot-test-times.json')
// Named after this run, because two lanes on one machine would otherwise truncate each other's
// records and report operations as never run that the other process had just driven.
const LEDGER = resolve(`src-tauri/target/godot-dispatch-ledger.${process.pid}.txt`)
const TOOL = resolve('protocol/schemas/v2/godot-tool.json')

function recordedTimes() {
    try {
        return JSON.parse(readFileSync(TIMES, 'utf8'))
    } catch {
        return {}
    }
}

function longestFirst(times) {
    const known = Object.values(times)
        .filter(seconds => typeof seconds === 'number')
        .sort((one, other) => one - other)
    const median = known.length > 0 ? known[Math.floor(known.length / 2)] : 0
    const cost = name => (typeof times[name] === 'number' ? times[name] : median)
    return (one, other) => cost(other) - cost(one)
}

const STAGGER_MS = 750

const tests = listed.stdout
    .split('\n')
    .filter(line => line.endsWith(': test'))
    .map(line => line.slice(0, -': test'.length))
    .filter(name => name.includes(FILTER))
    .sort(longestFirst(recordedTimes()))
if (tests.length === 0) throw new Error('No Godot acceptance tests matched')

const running = new Set()

// The catalogue promises the model these; the run proves which of them a real editor answers.
function catalogueOperations() {
    const found = []
    const walk = node => {
        if (!node || typeof node !== 'object') return
        if (Array.isArray(node)) return node.forEach(walk)
        if (node.properties?.op?.const) found.push(node.properties.op.const)
        Object.values(node).forEach(walk)
    }
    walk(JSON.parse(readFileSync(TOOL, 'utf8')))
    return found
}

// Every operation the routers of every test process recorded. A missing ledger is the hook not
// being compiled in, which is not "all ran", so it throws rather than reporting a full complement.
function operationsThatRan() {
    let written
    try {
        written = readFileSync(LEDGER, 'utf8')
    } catch (reason) {
        throw new Error(
            `No dispatch ledger at ${LEDGER}: ${reason.message}. `
                + 'Nothing recorded an operation, so nothing proves any of them ran.'
        )
    }
    const ran = new Set(written.split('\n').filter(Boolean))
    if (ran.size === 0)
        throw new Error(
            `The dispatch ledger at ${LEDGER} is empty. The recording hook in ai_tools::run_one `
                + 'is not compiled into this build.'
        )
    return ran
}

function reap(child) {
    running.delete(child)
    try {
        process.kill(-child.pid, 'SIGKILL')
    } catch {}
}

function run(name, worker) {
    const began = Date.now()
    return new Promise(settle => {
        const child = spawn(binary, [name, '--exact', '--test-threads=1'], {
            encoding: 'utf8',
            cwd: PACKAGE,
            detached: true,
            env: {
                ...process.env,
                GOFER_GODOT_WORKER: String(worker),
                GOFER_DISPATCH_LEDGER: LEDGER
            }
        })
        running.add(child)
        let output = ''
        child.stdout.on('data', chunk => (output += chunk))
        child.stderr.on('data', chunk => (output += chunk))
        child.on('close', status => {
            reap(child)
            settle({name, status, output, seconds: (Date.now() - began) / 1000})
        })
    })
}

for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
        for (const child of [...running]) reap(child)
        process.exit(1)
    })
}

const sleep = milliseconds => new Promise(wake => setTimeout(wake, milliseconds))

writeFileSync(LEDGER, '')

const started = Date.now()
const queue = [...tests]
const failures = []
const measured = {}
const workers = Array.from({length: Math.min(jobs, queue.length)}, async (_unused, index) => {
    await sleep(index * STAGGER_MS)
    for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
        const result = await run(name, index)
        measured[name] = result.seconds
        if (result.status === 0) {
            process.stdout.write(`ok   ${result.seconds.toFixed(1)}s ${name}\n`)
            continue
        }
        process.stdout.write(`FAIL ${result.seconds.toFixed(1)}s ${name}\n`)
        failures.push(result)
    }
})
await Promise.all(workers)

try {
    writeFileSync(TIMES, `${JSON.stringify({...recordedTimes(), ...measured}, undefined, 4)}\n`)
} catch {}

const seconds = ((Date.now() - started) / 1000).toFixed(1)
for (const failure of failures) {
    process.stdout.write(`\n--- ${failure.name} ---\n${failure.output}\n`)
}
process.stdout.write(
    `\n${tests.length - failures.length}/${tests.length} Godot acceptance tests passed `
        + `in ${seconds}s across ${jobs} processes\n`
)

const catalogue = catalogueOperations()
const ran = operationsThatRan()
rmSync(LEDGER, {force: true})
const never = catalogue.filter(op => !ran.has(op))
for (const op of never) process.stdout.write(`never run: ${op}\n`)
process.stdout.write(
    `${catalogue.length - never.length}/${catalogue.length} catalogue operations reached a handler`
        + `${never.length === 0 ? '' : `, ${never.length} never run`}\n`
)

process.exitCode = failures.length === 0 && never.length === 0 ? 0 : 1

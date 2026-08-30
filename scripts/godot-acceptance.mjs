import {cpus} from 'node:os'
import {dirname, resolve} from 'node:path'
import {readFileSync, writeFileSync} from 'node:fs'
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
if (built.status !== 0) process.exit(built.status ?? 1)

const binary = built.stdout
    .split('\n')
    .filter(line => line.startsWith('{'))
    .map(line => JSON.parse(line))
    .findLast(message => message.executable && message.target?.name === 'gofer_lib')?.executable
if (!binary) throw new Error('The Godot acceptance build produced no library test binary')

const listed = spawnSync(binary, ['--list'], {encoding: 'utf8', cwd: PACKAGE})
if (listed.status !== 0) {
    process.stderr.write(listed.stderr ?? '')
    throw new Error('Could not list the Godot acceptance tests')
}
const TIMES = resolve('src-tauri/target/godot-test-times.json')

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
            env: {...process.env, GOFER_GODOT_WORKER: String(worker)}
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
process.exitCode = failures.length === 0 ? 0 : 1

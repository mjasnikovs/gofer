import {cpus} from 'node:os'
import {spawn, spawnSync} from 'node:child_process'
import {reexecUnderVirtualDisplay} from './virtual-display.mjs'

// Runs the real-editor Godot acceptance tests, one test per `cargo test` process, several at a
// time.
//
// They cannot share a process: `godot_session`, `script`, and `debug` each keep the active session
// in a process-global (`ACTIVE_SESSION`, `CONNECTION`, `TEST_SESSION`), so two acceptance tests in
// one binary overwrite each other's session and fail with `session_not_active` or `session_closed`.
// That is why the suite ran under `--test-threads=1`, and why it cost the wall time of eleven
// editors booted end to end. A process each restores the isolation the globals assume, and the
// editors then boot at the same time instead of in a queue.
//
// Concurrency is half the core count: every worker boots a real Godot editor that imports a project
// on its own threads, so a worker is worth more than a core. Measured on 16 cores, six workers run
// the suite in 15s and eight in the same 15s — past that the wall time is the slowest single test,
// not the queue. `GOFER_GODOT_JOBS` overrides it.

const MANIFEST = 'src-tauri/Cargo.toml'
const FEATURE = 'godot-acceptance'
const FILTER = 'acceptance'
const jobs =
    Number(process.env.GOFER_GODOT_JOBS) || Math.max(1, Math.min(6, Math.floor(cpus().length / 2)))

// One `xvfb-run` around this runner covers every worker it starts.
reexecUnderVirtualDisplay()

function cargo(args, options = {}) {
    return spawnSync('cargo', args, {encoding: 'utf8', ...options})
}

// One shared build first: parallel workers would otherwise queue on Cargo's build lock anyway, and
// a build failure should be reported as itself rather than as eleven identical failures.
const built = cargo(
    ['test', '--quiet', '--manifest-path', MANIFEST, '--features', FEATURE, '--no-run'],
    {
        stdio: 'inherit'
    }
)
if (built.status !== 0) process.exit(built.status ?? 1)

const listed = cargo([
    'test',
    '--quiet',
    '--manifest-path',
    MANIFEST,
    '--features',
    FEATURE,
    '--',
    '--list'
])
if (listed.status !== 0) {
    process.stderr.write(listed.stderr ?? '')
    throw new Error('Could not list the Godot acceptance tests')
}
const tests = listed.stdout
    .split('\n')
    .filter(line => line.endsWith(': test'))
    .map(line => line.slice(0, -': test'.length))
    .filter(name => name.includes(FILTER))
if (tests.length === 0) throw new Error('No Godot acceptance tests matched')

function run(name) {
    return new Promise(settle => {
        const child = spawn(
            'cargo',
            [
                'test',
                '--quiet',
                '--manifest-path',
                MANIFEST,
                '--features',
                FEATURE,
                name,
                '--',
                '--exact',
                '--test-threads=1'
            ],
            {encoding: 'utf8'}
        )
        let output = ''
        child.stdout.on('data', chunk => (output += chunk))
        child.stderr.on('data', chunk => (output += chunk))
        child.on('close', status => settle({name, status, output}))
    })
}

const started = Date.now()
const queue = [...tests]
const failures = []
const workers = Array.from({length: Math.min(jobs, queue.length)}, async () => {
    for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
        const result = await run(name)
        if (result.status === 0) {
            process.stdout.write(`ok   ${name}\n`)
            continue
        }
        process.stdout.write(`FAIL ${name}\n`)
        failures.push(result)
    }
})
await Promise.all(workers)

const seconds = ((Date.now() - started) / 1000).toFixed(1)
// Only failures print their output, and they print it whole: an acceptance failure is read through
// the editor output the test quotes, which is the bulk of what a passing run would drown it in.
for (const failure of failures) {
    process.stdout.write(`\n--- ${failure.name} ---\n${failure.output}\n`)
}
process.stdout.write(
    `\n${tests.length - failures.length}/${tests.length} Godot acceptance tests passed `
        + `in ${seconds}s across ${jobs} processes\n`
)
process.exitCode = failures.length === 0 ? 0 : 1

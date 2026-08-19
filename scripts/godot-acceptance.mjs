import {cpus} from 'node:os'
import {dirname} from 'node:path'
import {spawn, spawnSync} from 'node:child_process'
import {reexecUnderVirtualDisplay} from './virtual-display.mjs'

// Runs the real-editor Godot acceptance tests, one test per process, several at a time.
//
// They cannot share a process: `godot_session`, `script`, and `debug` each keep the active session
// in a process-global (`ACTIVE_SESSION`, `CONNECTION`, `TEST_SESSION`), so two acceptance tests in
// one binary overwrite each other's session and fail with `session_not_active` or `session_closed`.
// That is why the suite ran under `--test-threads=1`, and why it cost the wall time of eleven
// editors booted end to end. A process each restores the isolation the globals assume, and the
// editors then boot at the same time instead of in a queue.
//
// Concurrency is half the core count: every worker boots a real Godot editor that imports a project
// on its own threads, so a worker is worth more than a core. `GOFER_GODOT_JOBS` overrides it.
//
// The suite is 47 tests now, and six workers run it in about 48s on 16 cores. Raising the count
// does not reliably help: 6, 8, 10 and 12 workers were measured at 60s, 69s, 46s and 43s, and an
// interleaved rerun of 6 against 12 then gave 57s/38s in one round and 56s/58s in the next. The
// spread within one setting is wider than the gap between settings, so there is no reading in
// those numbers, only noise. What does bound the suite is its slowest single test, which takes 21s
// on its own — no worker count gets under that.

const MANIFEST = 'src-tauri/Cargo.toml'
const FEATURE = 'godot-acceptance'
const FILTER = 'acceptance'
// Cargo runs a test binary from the package root, and `workspace.rs` reads the working directory,
// so starting the binary ourselves has to start it from the same place.
const PACKAGE = dirname(MANIFEST)
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

// The binary that build just produced, which every test below is started from directly rather than
// through `cargo test`.
//
// Cargo is not a thin wrapper here. Each `cargo test` call takes the build lock on `target` and
// re-checks the dependency graph before it starts anything, which measured at 0.55s on top of a
// 3.0s test — 26 seconds of the suite spent proving 47 times over that a build finished a minute
// ago is still finished. Worse than the time is the lock: while these workers hold it, `cargo test`
// in the lane beside them cannot start, so the two could never overlap.
//
// The acceptance tests are in the library, so the library's test binary is the one to run — the
// build also emits one for the binary crate.
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
/**
 * The one test that must start first, because nothing can be run after it.
 *
 * It waits out a launch deadline: 33s of a suite whose next-longest test is 18s. `--list` hands the
 * tests over alphabetically, which put it near the end, and the five workers that finished before
 * it then had nothing to do — the suite measured 67s without it and 97s with it, for 33s of work.
 * Started first it costs nothing: 50 tests in 48s.
 *
 * Only this one. Ordering the six longest that way instead packed six real editors into six workers
 * at the same moment, and under `npm run check` — where the Cargo lane is building beside them —
 * two unrelated tests then failed waiting on a session view. A worker here is worth more than a
 * core, which is why the pool is half the core count; front-loading the heaviest work undoes that.
 */
const STARTS_FIRST = 'a_launch_that_outlives_its_deadline_while_playing_says_the_game_is_up'

/** That one test before every other, and the rest in the order `--list` gave them. */
function longestFirst(one, other) {
    return Number(other.endsWith(STARTS_FIRST)) - Number(one.endsWith(STARTS_FIRST))
}

const tests = listed.stdout
    .split('\n')
    .filter(line => line.endsWith(': test'))
    .map(line => line.slice(0, -': test'.length))
    .filter(name => name.includes(FILTER))
    .sort(longestFirst)
if (tests.length === 0) throw new Error('No Godot acceptance tests matched')

function run(name) {
    return new Promise(settle => {
        const child = spawn(binary, [name, '--exact', '--test-threads=1'], {
            encoding: 'utf8',
            cwd: PACKAGE
        })
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

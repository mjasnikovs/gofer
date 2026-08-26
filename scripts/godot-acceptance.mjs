import {cpus} from 'node:os'
import {dirname, resolve} from 'node:path'
import {readFileSync, writeFileSync} from 'node:fs'
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
// Which test is longest, the runner knows rather than guesses. It writes every test's duration
// beside the build and reads them back next time, so the queue is drained longest first — the one
// ordering that cannot leave a long test starting last with every other worker idle behind it.
//
// That ordering is also what made the worker count readable. Six was a cap written here because
// raising it "did not reliably help": 6, 8, 10 and 12 were measured at 60s, 69s, 46s and 43s, and
// an interleaved rerun of 6 against 12 gave 57s/38s in one round and 56s/58s in the next — a
// spread within one setting wider than the gap between settings. It was never noise. One test was
// waiting out a 30s launch deadline, and whether the tail happened to land on it swamped
// everything else. That deadline is four seconds now, and the same interleaved comparison on the
// same machine reads 55.2/54.8s at six workers, 43.2/42.6s at eight and 38.7/38.3s at ten — half a
// second of spread inside each setting, twelve between them. So the cap is gone and the formula it
// was capping stands on its own.
//
// Eight is what this file picks on its own, for a lane run by hand. `npm run check` sets
// `GOFER_GODOT_JOBS` to ten and gets the same green: the reds that used to arrive above eight were
// never the core count, they were ten editors sharing Godot's one debugger port. See `debug_port`
// in `godot_editor_harness.rs`.

const MANIFEST = 'src-tauri/Cargo.toml'
const FEATURE = 'godot-acceptance'
const FILTER = 'acceptance'
// Cargo runs a test binary from the package root, and `workspace.rs` reads the working directory,
// so starting the binary ourselves has to start it from the same place.
const PACKAGE = dirname(MANIFEST)
const jobs = Number(process.env.GOFER_GODOT_JOBS) || Math.max(1, Math.floor(cpus().length / 2))

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
 * What each test cost last time, written beside the build it belongs to.
 *
 * In `target/` rather than in the tree because it is a measurement of this machine, not a fact
 * about the suite: a slower laptop and this desktop disagree about which test is longest, and only
 * the machine draining the queue has a use for the answer. It survives a rebuild and goes with a
 * `cargo clean`, which is the right lifetime for something that is only ever an optimisation.
 */
const TIMES = resolve('src-tauri/target/godot-test-times.json')

function recordedTimes() {
    try {
        return JSON.parse(readFileSync(TIMES, 'utf8'))
    } catch {
        // No file yet, or one from an older shape. Either way the suite runs in `--list` order and
        // writes a usable file on its way out.
        return {}
    }
}

/**
 * Longest first, by what was actually measured.
 *
 * The queue's tail is one test running alone while every other worker waits, so the last thing
 * started should be the shortest thing left. That was hand-written before: one test named in a
 * constant, hoisted because it waited out a 30s launch deadline and `--list` had put it near the
 * end. The deadline is four seconds now and the name was never going to keep up with the suite, so
 * the runner measures instead.
 *
 * A test with no recorded time sorts as the median rather than as zero or as infinity. Zero would
 * bury a new test at the very end, which is the position that costs most when it turns out to be
 * slow; infinity would put every new test in the opening burst, which is the position the stagger
 * below exists to keep small.
 */
function longestFirst(times) {
    const known = Object.values(times)
        .filter(seconds => typeof seconds === 'number')
        // With a comparator: the default one sorts numbers as text, and picked 9 out of [1, 10, 9].
        .sort((one, other) => one - other)
    const median = known.length > 0 ? known[Math.floor(known.length / 2)] : 0
    const cost = name => (typeof times[name] === 'number' ? times[name] : median)
    return (one, other) => cost(other) - cost(one)
}

/**
 * How long each worker waits before its first test, multiplied by its index.
 *
 * Longest-first means the heaviest tests all start at once, and a worker here is worth more than a
 * core: six real editors importing a project on their own threads, with the Cargo lane building
 * beside them under `npm run check`. Ordering the six longest first is exactly what failed before —
 * two unrelated tests gave up waiting on a session view. Spreading the opening boots over a few
 * seconds costs that once and keeps the ordering.
 */
const STAGGER_MS = 750

const tests = listed.stdout
    .split('\n')
    .filter(line => line.endsWith(': test'))
    .map(line => line.slice(0, -': test'.length))
    .filter(name => name.includes(FILTER))
    .sort(longestFirst(recordedTimes()))
if (tests.length === 0) throw new Error('No Godot acceptance tests matched')

/** Every test process still running, so an interrupt takes its editors and games with it. */
const running = new Set()

/**
 * Ends a test process and everything it started.
 *
 * A test owns an editor, and the editor owns the game it was told to play. Killing the test alone
 * leaves both behind — and the game the stop tests launch spins its main thread on purpose, so each
 * one that escapes holds a core at 100% for as long as the machine is up. Eight of them were found
 * after an afternoon of runs, and by then every later run was slower and more of its timing
 * assertions were failing, which orphaned more games. That is a loop that only ever goes one way.
 *
 * `detached` puts each test in a process group of its own, which is what makes the whole tree
 * addressable: a negative pid signals the group. Sent after the process is already gone it reaches
 * exactly the descendants that outlived it, and nothing when there are none.
 */
function reap(child) {
    running.delete(child)
    try {
        process.kill(-child.pid, 'SIGKILL')
    } catch {
        // ESRCH: the group is already empty, which is the ordinary case for a test that passed.
    }
}

function run(name, worker) {
    const began = Date.now()
    return new Promise(settle => {
        const child = spawn(binary, [name, '--exact', '--test-threads=1'], {
            encoding: 'utf8',
            cwd: PACKAGE,
            detached: true,
            // Which lane of debugger ports this process deals from. See `debug_port` in
            // `godot_editor_harness.rs`.
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

// An interrupted run leaks the same way a failed test does, and the person who pressed Ctrl-C is
// not going to go looking for eight spinning games.
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

// Merged rather than replaced: a filtered or interrupted run would otherwise throw away the times
// of every test it did not reach, and the next full run would sort as if it had never measured.
try {
    writeFileSync(TIMES, `${JSON.stringify({...recordedTimes(), ...measured}, undefined, 4)}\n`)
} catch {
    // A run against a target directory that is not writable still has a suite result to report,
    // and the ordering it could not save is the only thing lost.
}

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

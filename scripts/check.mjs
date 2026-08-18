import {spawn} from 'node:child_process'

// Runs everything `npm run check` used to run one after another, in three lanes at once.
//
// The lanes are drawn around Cargo's build lock, not around the tests. Every `cargo` invocation
// takes the same lock on `src-tauri/target` before it does anything, so two of them started at the
// same time do not run at the same time — the second waits, and all that is gained is a confusing
// progress display. Everything that holds that lock for its whole run therefore stays in one serial
// lane, in the order it ran in before.
//
// `test:godot` gets a lane of its own because it is the exception: it takes the lock once to build,
// then hands its 47 tests to the binary directly and never asks Cargo for anything again. Almost
// all of its minute is spent holding no lock at all, which is the window the Cargo lane runs in.
//
// The wall time is now the longest lane rather than the sum of all three. That is the Godot lane,
// and everything else — clippy, the Rust tests, Prettier, ESLint, tsc, Vitest, the Node tests, the
// browser journey — now finishes while those editors are still booting, where before it was a
// minute spent one command at a time with fifteen cores idle.

const GODOT_LANE = ['test:godot']

const CARGO_LANE = ['check:clippy', 'test:rust', 'check:cargo']

const OTHER_LANE = [
    'format:check',
    'lint',
    'typecheck',
    'check:rustfmt',
    'check:ignored-tests',
    'check:command-surface',
    'check:design',
    'test:coverage:frontend',
    'test:coverage:node',
    'test:coverage:node-critical',
    // The source worker passing proves nothing about the file a built Gofer runs: that one is
    // bundled, and a bundle can lose a module the source resolved fine.
    'test:worker:bundled',
    'test:desktop:browser'
]

// Two at a time, not all eleven. Vitest and the browser journey each spread over several cores of
// their own, and the Cargo lane beside them is running six Godot editors — started all together
// they finish no sooner and every one of them gets slower. Two is enough: this lane has about 45
// seconds of work in it and the Cargo lane beside it runs for 80, so there is nothing to win by
// crowding it, and a crowded machine is what made the Vitest suite time out.
const LANE_WIDTH = 2

const results = []

function run(script) {
    const started = Date.now()
    return new Promise(settle => {
        const child = spawn('npm', ['run', '--silent', script], {encoding: 'utf8'})
        let output = ''
        child.stdout.on('data', chunk => (output += chunk))
        child.stderr.on('data', chunk => (output += chunk))
        child.on('close', status => {
            const result = {script, status, output, seconds: (Date.now() - started) / 1000}
            results.push(result)
            process.stdout.write(
                `${status === 0 ? 'ok  ' : 'FAIL'} ${result.seconds.toFixed(1)}s ${script}\n`
            )
            settle(result)
        })
    })
}

// A lane is a queue its workers pull from, so a slow script holds up only its own worker. The Cargo
// lane is one worker wide, which is what keeps it in order.
async function lane(scripts, width) {
    const queue = [...scripts]
    const workers = Array.from({length: Math.min(width, queue.length)}, async () => {
        for (let script = queue.shift(); script !== undefined; script = queue.shift())
            await run(script)
    })
    await Promise.all(workers)
}

const started = Date.now()
await Promise.all([lane(GODOT_LANE, 1), lane(CARGO_LANE, 1), lane(OTHER_LANE, LANE_WIDTH)])

// Only failures print their output, and they print it whole. A check that passed has nothing to say
// that is worth burying the one that did not.
const failures = results.filter(result => result.status !== 0)
for (const failure of failures) {
    process.stdout.write(`\n--- ${failure.script} ---\n${failure.output}\n`)
}

const seconds = ((Date.now() - started) / 1000).toFixed(1)
process.stdout.write(
    `\n${results.length - failures.length}/${results.length} checks passed in ${seconds}s\n`
)
process.exitCode = failures.length === 0 ? 0 : 1

import {spawn} from 'node:child_process'
import {delimiter, resolve} from 'node:path'

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
//
// A step is a label and the command it runs. The command is written here rather than kept as an
// `npm run` script, because a script nothing else ever names is not a way in — it is a line in
// `package.json` that exists so this file can spell it. Nine of them were exactly that. What stays
// a script is what something else calls: CI, `tauri.conf.json`, the Rust sources, or a person.

/** A step whose command is a `package.json` script, because something other than this file runs it. */
const script = name => [name, `npm run --silent ${name}`]

const GODOT_LANE = [script('test:godot')]

const CARGO_LANE = [
    [
        'check:clippy',
        'cargo clippy --quiet --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings'
    ],
    ['test:rust', 'cargo test --quiet --manifest-path src-tauri/Cargo.toml'],
    ['check:cargo', 'cargo check --quiet --manifest-path src-tauri/Cargo.toml']
]

const NODE_COVERAGE_EXCLUDES = [
    '*.test.mjs',
    'check.mjs',
    'godot-test.mjs',
    'godot-acceptance.mjs',
    'godot-api-drift.mjs',
    'design-check.mjs',
    'setup-hooks.mjs',
    'check-ignored-tests.mjs',
    'check-command-surface.mjs',
    'generate-command-surface.mjs',
    'check-rust-critical-coverage.mjs',
    'run-rust-coverage.mjs',
    'run-packaged-journey.mjs',
    'install-godot.mjs',
    'build-gdformat.mjs',
    'build-workers.mjs',
    'godot-binary.mjs',
    'memory-worker.mjs',
    'rag-warmup.mjs',
    'rag-retrieve-worker.mjs',
    'bench-alone.mjs'
]
    .map(name => `--exclude='scripts/${name}'`)
    .join(' ')

const OTHER_LANE = [
    script('format:check'),
    script('lint'),
    script('typecheck'),
    ['check:rustfmt', 'cargo fmt --check --manifest-path src-tauri/Cargo.toml'],
    ['check:ignored-tests', 'node scripts/check-ignored-tests.mjs'],
    script('check:command-surface'),
    script('check:design'),
    ['test:coverage:frontend', 'vitest run --coverage'],
    [
        'test:coverage:node',
        `c8 --all --include='scripts/*.mjs' ${NODE_COVERAGE_EXCLUDES} --reporter=text --check-coverage --lines 80 --branches 75 npm run --silent test:worker`
    ],
    [
        'test:coverage:node-critical',
        "c8 --include='scripts/workspace-confinement.mjs' --reporter=text --check-coverage --lines 100 --branches 100 --functions 100 --statements 100 node --test scripts/workspace-confinement.test.mjs"
    ],
    // The source worker passing proves nothing about the file a built Gofer runs: that one is
    // bundled, and a bundle can lose a module the source resolved fine.
    script('test:worker:bundled'),
    [
        'test:desktop:browser',
        "start-server-and-test 'npm run dev -- --host 127.0.0.1' http://127.0.0.1:1420 'wdio run wdio.browser.conf.ts'"
    ]
]

// Two at a time, not all eleven. Vitest and the browser journey each spread over several cores of
// their own, and the Cargo lane beside them is running six Godot editors — started all together
// they finish no sooner and every one of them gets slower. Two is enough: this lane has about 45
// seconds of work in it and the Cargo lane beside it runs for 80, so there is nothing to win by
// crowding it, and a crowded machine is what made the Vitest suite time out.
const LANE_WIDTH = 2

// `npm run` puts this on PATH for the scripts it starts, and half the commands above are binaries
// that live in it — `vitest`, `c8`, `wdio`, `start-server-and-test`. Run straight from a shell they
// would be "command not found", which is the one thing that breaks by inlining them.
const PATH_WITH_LOCAL_BINARIES = `${resolve('node_modules/.bin')}${delimiter}${process.env['PATH'] ?? ''}`

const results = []

function run([label, command]) {
    const started = Date.now()
    return new Promise(settle => {
        const child = spawn(command, {
            shell: true,
            encoding: 'utf8',
            env: {...process.env, PATH: PATH_WITH_LOCAL_BINARIES}
        })
        let output = ''
        child.stdout.on('data', chunk => (output += chunk))
        child.stderr.on('data', chunk => (output += chunk))
        child.on('close', status => {
            const result = {label, status, output, seconds: (Date.now() - started) / 1000}
            results.push(result)
            process.stdout.write(
                `${status === 0 ? 'ok  ' : 'FAIL'} ${result.seconds.toFixed(1)}s ${label}\n`
            )
            settle(result)
        })
    })
}

// A lane is a queue its workers pull from, so a slow step holds up only its own worker. The Cargo
// lane is one worker wide, which is what keeps it in order.
async function lane(steps, width) {
    const queue = [...steps]
    const workers = Array.from({length: Math.min(width, queue.length)}, async () => {
        for (let step = queue.shift(); step !== undefined; step = queue.shift()) await run(step)
    })
    await Promise.all(workers)
}

const started = Date.now()
await Promise.all([lane(GODOT_LANE, 1), lane(CARGO_LANE, 1), lane(OTHER_LANE, LANE_WIDTH)])

// Only failures print their output, and they print it whole. A check that passed has nothing to say
// that is worth burying the one that did not.
const failures = results.filter(result => result.status !== 0)
for (const failure of failures) {
    process.stdout.write(`\n--- ${failure.label} ---\n${failure.output}\n`)
}

const seconds = ((Date.now() - started) / 1000).toFixed(1)
process.stdout.write(
    `\n${results.length - failures.length}/${results.length} checks passed in ${seconds}s\n`
)
process.exitCode = failures.length === 0 ? 0 : 1

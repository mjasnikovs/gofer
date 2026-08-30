import {spawn} from 'node:child_process'
import {cpus, tmpdir} from 'node:os'
import {delimiter, join, resolve} from 'node:path'

const script = name => [name, `npm run --silent ${name}`]

const coverage = name => join(tmpdir(), 'gofer-c8-coverage', name)

const CORES = Math.max(4, cpus().length)
const GODOT_JOBS = Math.floor((CORES * 5) / 8)
const CARGO_JOBS = Math.floor(CORES / 4)
const OTHER_JOBS = Math.floor(CORES / 4)

const GODOT_LANE = [['test:godot', `GOFER_GODOT_JOBS=${GODOT_JOBS} npm run --silent test:godot`]]

const CARGO_LANE = [
    [
        'check:clippy',
        `cargo clippy --quiet --jobs ${CARGO_JOBS} --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`
    ],
    [
        'test:rust',
        `cargo test --quiet --jobs ${CARGO_JOBS} --manifest-path src-tauri/Cargo.toml -- --test-threads=${CARGO_JOBS}`
    ],
    ['check:cargo', `cargo check --quiet --jobs ${CARGO_JOBS} --manifest-path src-tauri/Cargo.toml`]
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
    'build-node-runtime.mjs',
    'check-version.mjs',
    'set-version.mjs',
    'godot-binary.mjs',
    'memory-worker.mjs',
    'rag-warmup.mjs',
    'rag-retrieve-worker.mjs',
    'skills-worker.mjs',
    'bench-*.mjs',
    'ai-turn-harness.mjs',
    'declared-domains.mjs'
]
    .map(name => `--exclude='scripts/${name}'`)
    .join(' ')

const OTHER_LANE = [
    script('format:check'),
    script('lint'),
    script('typecheck'),
    ['check:rustfmt', 'cargo fmt --check --manifest-path src-tauri/Cargo.toml'],
    ['check:ignored-tests', 'node scripts/check-ignored-tests.mjs'],
    ['check:version', 'node scripts/check-version.mjs'],
    script('check:command-surface'),
    script('check:design'),
    ['test:coverage:frontend', `vitest run --coverage --maxWorkers=${OTHER_JOBS}`],
    [
        'test:coverage:node',
        `c8 --all --include='scripts/*.mjs' ${NODE_COVERAGE_EXCLUDES} --temp-directory=${coverage('node')}/tmp --reports-dir=${coverage('node')} --reporter=text --check-coverage --lines 90 --branches 80 npm run --silent test:worker`
    ],
    [
        'test:coverage:node-critical',
        `c8 --include='scripts/workspace-confinement.mjs' --temp-directory=${coverage('node-critical')}/tmp --reports-dir=${coverage('node-critical')} --reporter=text --check-coverage --lines 100 --branches 100 --functions 100 --statements 100 node --test scripts/workspace-confinement.test.mjs`
    ],
    [
        'test:coverage:node-turn-context',
        `c8 --include='scripts/turn-context.mjs' --temp-directory=${coverage('turn-context')}/tmp --reports-dir=${coverage('turn-context')} --reporter=text --check-coverage --lines 100 --branches 100 --functions 100 --statements 100 node --test scripts/turn-context.test.mjs`
    ],
    script('test:worker:bundled'),
    [
        'test:desktop:browser',
        "start-server-and-test 'npm run dev -- --host 127.0.0.1' http://127.0.0.1:1420 'wdio run wdio.browser.conf.ts'"
    ]
]

const LANE_WIDTH = 2

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

async function lane(steps, width) {
    const queue = [...steps]
    const workers = Array.from({length: Math.min(width, queue.length)}, async () => {
        for (let step = queue.shift(); step !== undefined; step = queue.shift()) await run(step)
    })
    await Promise.all(workers)
}

const started = Date.now()
await Promise.all([lane(GODOT_LANE, 1), lane(CARGO_LANE, 1), lane(OTHER_LANE, LANE_WIDTH)])

const failures = results.filter(result => result.status !== 0)
for (const failure of failures) {
    process.stdout.write(`\n--- ${failure.label} ---\n${failure.output}\n`)
}

const seconds = ((Date.now() - started) / 1000).toFixed(1)
process.stdout.write(
    `\n${results.length - failures.length}/${results.length} checks passed in ${seconds}s\n`
)
process.exitCode = failures.length === 0 ? 0 : 1

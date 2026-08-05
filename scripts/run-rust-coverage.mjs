import {existsSync} from 'node:fs'
import {spawnSync} from 'node:child_process'
import {reexecUnderVirtualDisplay} from './virtual-display.mjs'

// Coverage is measured with the real-editor acceptance suites, because without them it measures
// the wrong thing: `script.rs` reported 2 of 30 branches and `debug.rs` 1 of 12 while eleven
// acceptance tests drove both of them hard, and the Godot subsystems still counted in full against
// the total. That gap is what held the branch percentage at 72% against a 75% minimum.
//
// The acceptance modules themselves are excluded from the measurement. They are the test harness —
// counting a fixture's own branches as production coverage is how 74.39% and 75.62% come out of the
// same test run.
//
// They share one process here, so they run serially: `godot_session::ACTIVE_SESSION`,
// `script::CONNECTION`, and `debug::TEST_SESSION` are process-globals that two concurrent tests
// would overwrite. `scripts/godot-acceptance.mjs` gives each its own process instead, which is why
// the gate's copy of this suite is fifteen seconds and this one is not.
reexecUnderVirtualDisplay()

const outputPath = 'src-tauri/target/critical-coverage.json'
const environment = {...process.env, RUSTC_BOOTSTRAP: '1'}
const rustup = spawnSync('rustup', ['--version'], {stdio: 'ignore'})

if (rustup.error && process.platform !== 'win32') {
    if (existsSync('/usr/bin/llvm-cov')) environment.LLVM_COV = '/usr/bin/llvm-cov'
    if (existsSync('/usr/bin/llvm-profdata')) environment.LLVM_PROFDATA = '/usr/bin/llvm-profdata'
}

const coverage = spawnSync(
    'cargo',
    [
        'llvm-cov',
        '--manifest-path',
        'src-tauri/Cargo.toml',
        '--all-targets',
        '--branch',
        '--features',
        'godot-acceptance',
        '--ignore-filename-regex',
        '_acceptance\\.rs$',
        '--json',
        '--output-path',
        outputPath,
        '--',
        '--test-threads=1'
    ],
    {env: environment, stdio: 'inherit'}
)
if (coverage.error) throw coverage.error
if (coverage.status !== 0) process.exit(coverage.status ?? 1)

const check = spawnSync(
    process.execPath,
    ['scripts/check-rust-critical-coverage.mjs', outputPath],
    {
        stdio: 'inherit'
    }
)
if (check.error) throw check.error
process.exit(check.status ?? 1)

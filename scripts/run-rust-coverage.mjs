import {existsSync} from 'node:fs'
import {spawnSync} from 'node:child_process'
import {reexecUnderVirtualDisplay} from './virtual-display.mjs'

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

# Gofer developer validation — measured wall-clock times

All times measured on this working tree: 16 cores, 31 GB, warm `node_modules`, warm
`src-tauri/target`, `date`-based wall-clock. "Before" is the measurement this file recorded first;
"after" is the same command on the same machine once the work below had landed.

| Step                                     | Definition (verbatim from package.json)                            | Before           | After                |
| ---------------------------------------- | ------------------------------------------------------------------ | ---------------- | -------------------- |
| pre-commit hook (`.githooks/pre-commit`) | unsets the five `GIT_*` vars, then `npm run check`                 | 95.4 s           | **57.0 s**           |
| `npm run check`                          | `node scripts/check.mjs` (3 lanes)                                 | 88.9 s           | **54.5–66.7 s**      |
| `npm run test:godot`                     | `node scripts/godot-test.mjs && npm run --silent test:godot:addon` | 75.4 s           | **52.4 s**           |
| `└ 62 acceptance tests`                  | `node scripts/godot-acceptance.mjs`                                | 66.8 s / 6 procs | **43.6 s / 8 procs** |
| `└ two GDScript suites`                  | `node scripts/godot-test.mjs`                                      | 8.6 s            | **1.0 s**            |
| `npm run lint`                           | `eslint . --quiet --cache --cache-location …`                      | 13.0 s           | **1.6 s**            |
| `npm run typecheck`                      | `tsc --noEmit --pretty false` ×2                                   | 4.2 s            | **2.4 s**            |
| `npm run format:check`                   | `prettier --check . --cache --log-level warn`                      | 5.6 s            | **3.2 s**            |
| `cargo test` (`test:rust`)               | `cargo test --quiet --manifest-path src-tauri/Cargo.toml`          | 33.7 s           | **16.2 s**           |
| `cargo clippy` (`check:clippy`)          | `--all-targets -- -D warnings`                                     | 6.6 s            | **6.2 s**            |
| `cargo check` (`check:cargo`)            |                                                                    | 3.8 s            | **2.1 s**            |
| `npm run build`                          | `tauri build --no-bundle`                                          | 56.6 s           | 59.5 s (unchanged)   |
| `npm run build:frontend`                 | renderer + workers                                                 | 6.6 s            | 5.7 s                |
| `npm run test:worker`                    | 34 files under `node --test`                                       | 4.5 s            | 3.5 s                |
| `npm run test:worker:bundled`            | build:workers + one bundled suite                                  | 4.1 s            | 3.1 s                |
| `npm run test:coverage:rust`             | `node scripts/run-rust-coverage.mjs`                               | 404.2 s          | 419.4 s (unchanged)  |

Per-step inside one warm `npm run check` (54.5 s total, 17/17):

| Step                     | Lane  | Before | After  |
| ------------------------ | ----- | ------ | ------ |
| `test:godot`             | GODOT | 88.8 s | 54.4 s |
| `test:coverage:frontend` | OTHER | 38.3 s | 49.2 s |
| `test:rust`              | CARGO | 33.7 s | 26.9 s |
| `lint`                   | OTHER | 23.4 s | 1.5 s  |
| `test:coverage:node`     | OTHER | 18.1 s | 6.8 s  |
| `test:desktop:browser`   | OTHER | 6.3 s  | 11.4 s |
| `check:clippy`           | CARGO | 6.6 s  | 0.6 s  |
| `typecheck`              | OTHER | 6.4 s  | 2.5 s  |
| `format:check`           | OTHER | 5.8 s  | 3.4 s  |
| `test:worker:bundled`    | OTHER | 5.8 s  | 4.4 s  |
| `check:cargo`            | CARGO | 3.8 s  | 4.2 s  |
| everything else          | OTHER | 2.0 s  | 1.6 s  |

Two steps got slower on purpose. `test:coverage:frontend` and `test:desktop:browser` now run inside
a core budget instead of forking against the whole machine; the lane they are in still finishes well
inside the one that sets the total, so the seconds they gave up cost nothing and the starvation they
were causing did.

## What changed

### The gate's wall-clock was one lane, and that lane was one test

`scripts/check.mjs` runs three lanes at once, so the total is the longest lane and nothing else.
That lane was `test:godot`. Inside it, one acceptance test —
`a_launch_that_outlives_its_deadline_while_playing_says_the_game_is_up` — sat out the addon's
30-second launch deadline on purpose, because what it asserts is what the editor says _after_ a
deadline expires. It was hoisted to run first because nothing could follow it, and it still ended
the suite.

`RUNTIME_LAUNCH_TIMEOUT_MS` in `src-tauri/addon/plugin.gd` is now overridable from the environment,
defaulting to the same 30 seconds. The harness gives that one test four seconds. It costs 7.7 s
instead of 33 s and proves exactly what it proved before.

### The runner was guessing which test was longest

`scripts/godot-acceptance.mjs` sorted on a single hard-coded test name and had no idea what anything
cost. It now records every test's duration to `src-tauri/target/godot-test-times.json` and drains
the queue longest first, with a 750 ms stagger between worker starts so the heavy tests do not all
boot an editor in the same instant.

That ordering is also what made the worker count readable. The old comment capped the pool at six
because raising it "did not reliably help" — 6, 8, 10 and 12 measured at 60/69/46/43 s with a spread
inside one setting wider than the gap between settings. That was never noise. It was the 33-second
test, and whether the tail happened to land on it. With the deadline shortened and the queue
ordered, the same interleaved comparison reads 55.2/54.8 s at six workers, 43.2/42.6 s at eight and
38.7/38.3 s at ten. The cap is gone.

### Three lanes each sized themselves against the whole machine

Cargo builds and tests with a thread per core. Vitest forks one process per test file up to the same
number. The Godot runner boots an editor per worker. Side by side they asked for about forty threads
on sixteen cores, and what that cost was not slowness — it was failures.
`stopping_the_game_answers_only_once_the_game_is_gone` asserts the game is gone the instant
`runtime.stop` answers, and a starved machine has not reaped the process yet.

`scripts/check.mjs` now hands each lane a share: ten cores to Godot, four to Cargo, four to the
rest. Ten and four and four is eighteen on sixteen, deliberately — the lanes are not all busy at the
same moment, and pretending they were left two cores idle for a minute. Measured whole runs,
alternating: eight Godot workers gave 63.9/63.8/64.4 s, ten gave 61.6/61.9/61.1 s, all green.

### A failed test leaked a spinning game, and the leak fed itself

Eight orphaned Godot games were found after an afternoon of runs, each holding a core at 100%. They
come from the stop tests, whose game spins its main thread on purpose. A test that fails or is
interrupted leaves the editor behind, and the editor leaves the game.

Every run after that was slower, which made more timing assertions fail, which orphaned more games.
Measurements taken during it were worthless — a `check` that reads 88.9 s clean read 132 s with
eight of these running.

Each test now runs in a process group of its own and the group is signalled when the test closes, so
nothing outlives it. `SIGINT` and `SIGTERM` do the same for the whole run.

### Nothing was cached, anywhere

No `--cache` on ESLint or Prettier. No `incremental` on the main `tsconfig.json`, so its 195-file
program was type-checked cold three times per gate. All three are on now. ESLint's cache is a local
optimisation only: it keys on a file's own content, so a type-aware rule can go stale when a
_different_ file changes. CI has no `node_modules` cache and lints cold, which is where that is
caught.

`eslint-plugin-react-hooks` v7 is the React Compiler — eighteen rules that each put a file through
the compiler's pipeline. It was applied to `**/*.{ts,tsx}`, which included the thirteen end-to-end
specs and the five wdio configs, none of which contain a component. It is scoped to `src` now.

### The Rust side had no profile and no linker

`src-tauri/Cargo.toml` had no `[profile]` section and there was no `.cargo/config.toml`. Test builds
carried full DWARF into a 61 GB `target/debug` and linked single-threaded with GNU ld.

`[profile.dev]` is now `debug = "line-tables-only"` with `split-debuginfo = "unpacked"` — backtraces
keep file and line, the variable-level information nothing reads is gone. `.cargo/config.toml` at
the repository root points the x86_64 Linux target at mold. It is at the root and not beside the
manifest because Cargo looks for that file from the working directory, and the gate runs
`cargo test --manifest-path src-tauri/...` from here.

mold is a hard requirement on Linux now. A machine without it fails with "linker `mold` not found"
rather than quietly building slower.

### The Godot suites take a display of their own

Sixty tests launching a windowed game put a minute of Godot splash screens on the developer's
desktop, and a window manager that decides to place or animate one of those windows is doing it
inside a test that is timing a launch. `scripts/virtual-display.mjs` claimed a virtual display only
when the machine had none. It claims one always, which is the configuration CI has always used.
`GOFER_GODOT_DISPLAY=host` opts out, for watching what an editor is actually doing.

### CI rebuilt the whole dependency tree every run

`check.yml` had no Rust cache in either job, inside a 30-minute cap. `Swatinem/rust-cache` is in
`check.yml`, `packaged-journey.yml` and `release.yml`, and every Linux runner now installs mold.

### Two c8 runs were overwriting each other

Unrelated to speed, found while reading the same file. Both `c8` steps in `scripts/check.mjs`
defaulted to `coverage/tmp` and both default to `--clean`. They sit next to each other in a lane two
workers wide, so whichever started second wiped the first one's raw V8 output. Each has its own temp
and report directory now.

## What was looked at and left alone

**`npm run build` (56.6 s → 59.5 s).** The 49 s is the `gofer` crate recompiling at `opt-level = 3`,
not linking: `beforeBuildCommand` rewrites `dist/`, `tauri-build` watches it, and the crate rebuilds
whether or not any Rust changed. mold only shortens the link. Getting at the rest means splitting
the crate, and no developer loop runs this — `tauri dev` is the loop.

**`npm run build:release` (838.5 s, ~781 s of it bundling).** `src-tauri/tauri.conf.json` names no
`bundle.targets`, so Linux builds deb, rpm _and_ AppImage — the earlier note here saying two was
wrong. Its only caller is `release.yml`. It is in no developer loop, so it keeps building all three;
the CI cache is the reduction.

**`npm run test:coverage:rust` (404 s → 419 s).** It builds into a target directory of its own under
llvm-cov's instrumentation and runs the acceptance suites at `--test-threads=1`, which
`scripts/run-rust-coverage.mjs` requires because of the process-global sessions. Neither the
ordering nor the worker count reaches it, and a serial suite has little link time to save. It is not
in the gate and should stay out of it.

**Pooling one editor across tests.** The thirteen `godot_readback_acceptance` tests each boot their
own editor and none of them destroy it, so they could share. They cannot yet: `godot_session`,
`script` and `debug` each keep the active session in a process-global, which is why the runner gives
every test a process. Worth doing after the timing data shows boots are what is left.

**Caching `pinned_editor()`.** It spawns `godot --version` on every launch, which sounds like 62
wasted spawns and is not: one test per process means one call per process. Worth about a second.

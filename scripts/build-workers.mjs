/**
 * Bundles the Node workers Gofer ships into self-contained files.
 *
 * A built Gofer used to carry no JavaScript at all. `ai_turn.rs` and `chatgpt_auth.rs` resolved
 * their worker from `CARGO_MANIFEST_DIR/../scripts`, a path frozen into the binary at compile
 * time, and read the file fresh on every run. On the machine that built it that path still exists,
 * so an edit to `scripts/ai-worker.mjs` changed what an already-built application ran, and the
 * imports resolved against the developer's `node_modules` too. Nothing was copied into the bundle:
 * the AppImage contained zero `.mjs` files.
 *
 * This script is the copy that was missing. Each entry point becomes one file with its whole
 * import graph inlined, written to `src-tauri/workers/`, which `tauri.conf.json` bundles as an
 * application resource. `workers.rs` resolves them from there.
 *
 * Only the two AI workers are bundled. `memory-worker.mjs`, `rag-warmup.mjs` and
 * `rag-retrieve-worker.mjs` reach `onnxruntime-node` and `@lancedb/lancedb`, which are native
 * `.node` binaries no bundler can inline; they still resolve from the source tree. See
 * `REDUCE-SIZE.md` in gofer-rag for the work that would let them join.
 *
 * The build is also the proof: every bundle is spawned before this script exits, because a bundle
 * that lost a module fails when it is run, not when it is written.
 *
 * Run it with `npm run build:workers`. `tauri build` runs it through `beforeBuildCommand`.
 */
import {spawnSync} from 'node:child_process'
import {mkdir, readFile, rm, writeFile} from 'node:fs/promises'
import {dirname, join, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {build} from 'esbuild'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outputDirectory = join(root, 'src-tauri/workers')

/**
 * Hands the bundle a real `require`.
 *
 * Some of Pi's dependencies are CommonJS and call `require('process')` at load time. esbuild's ESM
 * output answers a dynamic require with a thrown error unless a `require` is already in scope, and
 * the failure is at startup: the worker dies before it reads its first line.
 */
const REQUIRE_BANNER =
    "import {createRequire as __createRequire} from 'node:module'\nconst require = __createRequire(import.meta.url)\n"

/**
 * What each bundle has to survive before it is allowed to ship. Every probe runs offline.
 *
 * The interesting one is `check` with a credential. Pi loads each OAuth flow through a *variable*
 * import specifier so that bundlers cannot follow it, and a bundle then has no such file beside it:
 * the first bundle built here answered every ChatGPT turn with `Cannot find module
 * .../openai-codex.js`. The workers now call Pi's `registerBunOAuthFlows` to import those flows
 * statically.
 *
 * The credential is what makes the probe worth anything. Without one, `check` returns "Sign in with
 * ChatGPT" before it ever asks for the flow, and passes just as happily on a bundle that has none —
 * measured, after that weaker probe was written. With one, Pi derives the auth, which is the load.
 * The value is nonsense and the expiry is far away, so the derivation succeeds, nothing is
 * refreshed, and no request leaves the machine.
 *
 * The AI worker has no offline operation of its own: every path it has talks to a model, and a probe
 * that reached one would be a build making requests to OpenAI. So it is held to the registration
 * itself instead, by `REGISTERS_OAUTH_FLOWS` below. That is weaker than the ChatGPT worker's probe,
 * and it is why the probe exists on the worker that can be driven offline: the two entries share
 * one bundler, one library and one call, so the one that can be proven proves the mechanism, and
 * this keeps the other from quietly dropping it. Everything past loading is
 * `npm run test:worker:bundled`.
 */
const ENTRIES = [
    {
        name: 'ai-worker.mjs',
        probes: [{input: '{invalid', status: 1, stderr: /JSON/u}]
    },
    {
        name: 'ai-codex-auth.mjs',
        probes: [
            {input: '{"operation":"models"}\n', status: 0, stdout: /"type":"models"/u},
            {
                input: `${JSON.stringify({
                    operation: 'check',
                    credential: {
                        type: 'oauth',
                        access: 'gofer-build-probe',
                        refresh: 'gofer-build-probe',
                        expires: 99_999_999_999_999
                    }
                })}\n`,
                status: 0,
                stdout: /"type":"checked"/u
            }
        ]
    }
]

/** Every worker bundled here talks to a provider, so every one of them has to register the flows. */
const REGISTERS_OAUTH_FLOWS = 'registerBunOAuthFlows()'

async function bundle(entry) {
    await build({
        entryPoints: [join(root, 'scripts', entry.name)],
        outfile: join(outputDirectory, entry.name),
        bundle: true,
        platform: 'node',
        format: 'esm',
        target: 'node22',
        banner: {js: REQUIRE_BANNER},
        logLevel: 'warning'
    })
}

function probe(entry, expected) {
    const bundled = join(outputDirectory, entry.name)
    const result = spawnSync(process.execPath, [bundled], {
        input: expected.input,
        encoding: 'utf8',
        timeout: 60_000
    })
    if (result.error) throw result.error
    const report = `${result.stdout}${result.stderr}`.trim()
    if (result.status !== expected.status) {
        throw new Error(
            `${entry.name} exited ${result.status}, expected ${expected.status}: ${report}`
        )
    }
    for (const [stream, pattern] of [
        ['stdout', expected.stdout],
        ['stderr', expected.stderr]
    ]) {
        if (pattern && !pattern.test(result[stream])) {
            throw new Error(`${entry.name} ${stream} did not match ${pattern}: ${report}`)
        }
    }
}

// Only what this script wrote last time, never the directory: `README.md` is tracked, and Tauri's
// build script fails the whole crate when a declared resource path is missing.
await mkdir(outputDirectory, {recursive: true})
for (const entry of ENTRIES) {
    await rm(join(outputDirectory, entry.name), {force: true})
}
// Bundles are ESM and nothing above them declares a module type — `src-tauri` has no package.json
// — so the marker keeps the resource directory self-describing wherever it is unpacked.
await writeFile(
    join(outputDirectory, 'package.json'),
    `${JSON.stringify({type: 'module'}, null, 4)}\n`
)

for (const entry of ENTRIES) {
    const source = await readFile(join(root, 'scripts', entry.name), 'utf8')
    if (!source.includes(REGISTERS_OAUTH_FLOWS)) {
        throw new Error(
            `scripts/${entry.name} does not call ${REGISTERS_OAUTH_FLOWS}, so its bundle would look for Pi's OAuth flows in files that only exist in node_modules`
        )
    }
    await bundle(entry)
    for (const expected of entry.probes) probe(entry, expected)
    process.stdout.write(`bundled ${entry.name}, ${entry.probes.length} probe(s) passed\n`)
}

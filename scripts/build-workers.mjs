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
 * All five workers are bundled. `memory-worker.mjs`, `rag-warmup.mjs` and
 * `rag-retrieve-worker.mjs` reach `onnxruntime-node`, `@lancedb/lancedb` and `sharp`, which load
 * `.node` binaries through a computed `require` no bundler can follow. Those three packages are
 * left external and their dependency closure is copied into `src-tauri/workers/node_modules`, so
 * the bundle resolves them the way Node resolves anything — by walking up from where it sits.
 *
 * The build is also the proof: every bundle is spawned before this script exits, because a bundle
 * that lost a module fails when it is run, not when it is written.
 *
 * Run it with `npm run build:workers`. `tauri build` runs it through `beforeBuildCommand`.
 */
import {spawnSync} from 'node:child_process'
import {existsSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {cp, mkdir, readFile, readdir, rm, writeFile} from 'node:fs/promises'
import {dirname, join, relative, resolve, sep} from 'node:path'
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
 * The packages esbuild is not allowed to inline, and their reason.
 *
 * Each one loads a `.node` binary through a require it computes at runtime — onnxruntime from
 * `../bin/napi-v6/${process.platform}/${process.arch}/`, lancedb and sharp from a per-host binding
 * package. A bundler cannot follow any of them, so an inlined copy throws at load. They are copied
 * beside the bundles instead, in `copyNativePackages` below.
 */
const NATIVE_PACKAGES = ['onnxruntime-node', '@lancedb/lancedb', 'sharp']

/**
 * The Godot documentation itself: a LanceDB table `@mjasnikovs/gofer-rag` publishes inside its own
 * package, and the one thing here that is data rather than code.
 *
 * gofer-rag finds it by resolving one directory up from its own module file. Inlining the package
 * into a bundle moved that file, so "one directory up" became `src-tauri` in a dev build and the
 * resource root in a shipped one, and neither holds a database — every warmup failed with
 * `Table 'chunks' was not found` after downloading 1.8 GiB of models first. The copy is beside the
 * bundles and `rag.rs` names it outright through `GOFER_RAG_DATABASE_PATH`, so nothing depends on
 * where a third-party package thinks its own root is.
 */
const DATABASE_PACKAGE = '@mjasnikovs/gofer-rag'
const DATABASE_DIRECTORY = '.lancedb'

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
        registersOAuthFlows: true,
        probes: [{input: '{invalid', status: 1, stderr: /JSON/u}]
    },
    {
        name: 'ai-codex-auth.mjs',
        registersOAuthFlows: true,
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
    },
    // The retrieval worker is the only one of the three that answers offline, and its probe runs
    // before gofer-rag is imported — so it proves the reading half and nothing about the native
    // modules. `NATIVE_PROBE` below is what holds those.
    {
        name: 'rag-retrieve-worker.mjs',
        external: NATIVE_PACKAGES,
        probes: [{input: '{"probe":true}\n', status: 0, stdout: /docs-ask-reachable/u}]
    },
    // Warmup downloads 1.8 GiB of models and the embedder needs one loaded, so neither has an
    // offline operation to be asked for. `NATIVE_PROBE` is their whole proof.
    {name: 'rag-warmup.mjs', external: NATIVE_PACKAGES, probes: []},
    {name: 'memory-worker.mjs', external: NATIVE_PACKAGES, probes: []}
]

/** The two workers that talk to a provider through Pi have to register the flows. */
const REGISTERS_OAUTH_FLOWS = 'registerBunOAuthFlows()'

async function bundle(entry) {
    await build({
        entryPoints: [join(root, 'scripts', entry.name)],
        outfile: join(outputDirectory, entry.name),
        bundle: true,
        platform: 'node',
        format: 'esm',
        target: 'node22',
        external: entry.external ?? [],
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

/** The host this build is for. A napi binding package names the host it holds. */
const HOST = `${process.platform}-${process.arch}`

/** The directory the copied packages go in, which is where Node looks when a bundle requires one. */
const nativeDirectory = join(outputDirectory, 'node_modules')

/**
 * Where a package lives, found the way Node finds it.
 *
 * `require.resolve` cannot answer this. Both `@lancedb/lancedb` and `sharp` publish an `exports`
 * map that does not list `./package.json`, and asking for one through the map is an error rather
 * than a miss — so the lookup walks `node_modules` directories itself.
 */
function packageDirectory(name, from) {
    let directory = from
    for (;;) {
        const candidate = join(directory, 'node_modules', name)
        if (existsSync(join(candidate, 'package.json'))) return candidate
        const parent = dirname(directory)
        if (parent === directory) return undefined
        directory = parent
    }
}

/** A per-host binding package, which npm installs only for the host it matches. */
const isBindingPackage = name => /-(?:darwin|linux|linuxmusl|win32|android|wasm)/u.test(name)

/**
 * Every package the three native ones need, and nothing else.
 *
 * `dependencies` and `peerDependencies` are followed in full — `apache-arrow` is lancedb's peer and
 * the bundle dies without it. `optionalDependencies` are followed only when they name this host:
 * they are how napi ships one package per platform, and following all of them dragged in every
 * other platform's binaries, `onnxruntime-web` and a second copy of transformers — 1 GiB for a
 * 243 MiB need.
 */
function nativeClosure() {
    const found = new Map()
    const walk = (name, from) => {
        if (found.has(name)) return
        const directory = packageDirectory(name, from)
        found.set(name, directory)
        if (!directory) return
        const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
        const optional = Object.keys(manifest.optionalDependencies ?? {}).filter(
            dependency => isBindingPackage(dependency) && dependency.includes(HOST)
        )
        for (const dependency of [
            ...Object.keys(manifest.dependencies ?? {}),
            ...Object.keys(manifest.peerDependencies ?? {}),
            ...optional
        ])
            walk(dependency, directory)
    }
    for (const name of NATIVE_PACKAGES) walk(name, root)

    // A binding package for a host npm did not install for is a miss, not a failure: musl and glibc
    // both match `linux-x64`, and only one of them is ever on disk. Anything else missing is a
    // package the bundle will ask for and not find, so the build stops here rather than at run time.
    const missing = [...found]
        .filter(([name, directory]) => !directory && !isBindingPackage(name))
        .map(([name]) => name)
    if (missing.length > 0) {
        throw new Error(
            `The native workers need ${missing.join(', ')}, which npm has not installed. Run npm ci.`
        )
    }
    return [...found].filter(([, directory]) => directory)
}

/**
 * Trims a copied package to the host it was copied for.
 *
 * onnxruntime ships every platform in one package, and its CUDA provider is 316 MiB on its own —
 * larger than everything else here put together, for a GPU path Gofer never asks for.
 */
async function pruneOnnxRuntime() {
    const binaries = join(nativeDirectory, 'onnxruntime-node/bin/napi-v6')
    if (!existsSync(binaries)) return
    for (const platform of await readdir(binaries)) {
        const directory = join(binaries, platform)
        if (platform !== process.platform) {
            await rm(directory, {recursive: true, force: true})
            continue
        }
        for (const architecture of await readdir(directory)) {
            if (architecture !== process.arch)
                await rm(join(directory, architecture), {recursive: true, force: true})
        }
    }
    const host = join(binaries, process.platform, process.arch)
    for (const file of existsSync(host) ? await readdir(host) : []) {
        if (/providers_(?:cuda|tensorrt)/u.test(file)) await rm(join(host, file), {force: true})
    }
}

/** Copies the documentation table beside the bundles, and answers with how big it is. */
async function copyDocumentationDatabase() {
    const source = join(packageDirectory(DATABASE_PACKAGE, root) ?? '', DATABASE_DIRECTORY)
    if (!existsSync(source)) {
        throw new Error(
            `${DATABASE_PACKAGE} carries no ${DATABASE_DIRECTORY}, so the documentation workers would ship without the manual. Run npm ci.`
        )
    }
    const target = join(outputDirectory, DATABASE_DIRECTORY)
    await rm(target, {recursive: true, force: true})
    await cp(source, target, {recursive: true, dereference: true})
    return target
}

/** Copies the closure, without the nested `node_modules` npm left inside some of them. */
async function copyNativePackages() {
    await rm(nativeDirectory, {recursive: true, force: true})
    const closure = nativeClosure()
    for (const [name, directory] of closure) {
        const target = join(nativeDirectory, name)
        await mkdir(dirname(target), {recursive: true})
        await cp(directory, target, {
            recursive: true,
            dereference: true,
            filter: source => !relative(directory, source).split(sep).includes('node_modules')
        })
    }
    await pruneOnnxRuntime()
    return closure.length
}

/**
 * The proof the copy is worth anything: every native package loads from where it was put.
 *
 * None of the three workers' own probes reach these. `rag-retrieve-worker` answers its probe before
 * it imports gofer-rag, and the other two have no offline operation at all — so a build with an
 * empty `node_modules` passed every probe and shipped three workers that die on first use.
 */
function probeNativePackages() {
    const probeFile = join(outputDirectory, '.native-probe.mjs')
    writeFileSync(
        probeFile,
        "import {createRequire} from 'node:module'\n"
            + 'const require = createRequire(import.meta.url)\n'
            + `for (const name of ${JSON.stringify(NATIVE_PACKAGES)}) require(name)\n`
            + "process.stdout.write('native-modules-load\\n')\n"
    )
    const result = spawnSync(process.execPath, [probeFile], {encoding: 'utf8', timeout: 120_000})
    rmSync(probeFile, {force: true})
    if (result.error) throw result.error
    if (!/native-modules-load/u.test(result.stdout)) {
        throw new Error(
            `The native packages beside the workers do not load: ${`${result.stdout}${result.stderr}`.trim()}`
        )
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
    if (entry.registersOAuthFlows && !source.includes(REGISTERS_OAUTH_FLOWS)) {
        throw new Error(
            `scripts/${entry.name} does not call ${REGISTERS_OAUTH_FLOWS}, so its bundle would look for Pi's OAuth flows in files that only exist in node_modules`
        )
    }
    await bundle(entry)
    for (const expected of entry.probes) probe(entry, expected)
    process.stdout.write(`bundled ${entry.name}, ${entry.probes.length} probe(s) passed\n`)
}

const copied = await copyNativePackages()
process.stdout.write(`copied ${copied} native package(s) for ${HOST}\n`)
process.stdout.write(`copied the documentation table to ${await copyDocumentationDatabase()}\n`)
probeNativePackages()
process.stdout.write(`${NATIVE_PACKAGES.join(', ')} load from the workers directory\n`)

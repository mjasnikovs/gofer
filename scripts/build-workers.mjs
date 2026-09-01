import {spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {existsSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {cp, mkdir, readFile, readdir, rm, stat, writeFile} from 'node:fs/promises'
import {dirname, join, relative, resolve, sep} from 'node:path'
import {fileURLToPath} from 'node:url'
import {build} from 'esbuild'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outputDirectory = join(root, 'src-tauri/workers')

// Everything under src-tauri/workers is a Tauri `resources` entry, so Cargo reruns the build
// script and relinks the release binary whenever a file in it gets a new mtime. Copying the same
// bytes back therefore costs a minute of rebuild, which is why every write here is conditional.
const stampDirectory = join(root, 'node_modules/.cache/gofer')

async function writeWhenChanged(path, contents) {
    const existing = await readFile(path).catch(() => undefined)
    if (existing && Buffer.from(contents).equals(existing)) return false
    await mkdir(dirname(path), {recursive: true})
    await writeFile(path, contents)
    return true
}

async function hashTree(hash, directory, skip) {
    const entries = await readdir(directory, {withFileTypes: true})
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        const path = join(directory, entry.name)
        if (skip?.(path)) continue
        if (entry.isDirectory()) {
            await hashTree(hash, path, skip)
            continue
        }
        const {size, mtimeMs} = await stat(path)
        hash.update(`${path}\0${size}\0${mtimeMs}\n`)
    }
}

async function upToDate(name, target, stamp) {
    if (!existsSync(target)) return false
    const path = join(stampDirectory, name)
    return (await readFile(path, 'utf8').catch(() => undefined)) === stamp
}

async function recordStamp(name, stamp) {
    await mkdir(stampDirectory, {recursive: true})
    await writeFile(join(stampDirectory, name), stamp)
}

const REQUIRE_BANNER =
    "import {createRequire as __createRequire} from 'node:module'\nconst require = __createRequire(import.meta.url)\n"

const NATIVE_PACKAGES = ['onnxruntime-node', '@lancedb/lancedb', 'sharp']

const DATABASE_PACKAGE = '@mjasnikovs/gofer-rag'
const DATABASE_DIRECTORY = '.lancedb'

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
    {
        name: 'rag-retrieve-worker.mjs',
        external: NATIVE_PACKAGES,
        probes: [{input: '{"probe":true}\n', status: 0, stdout: /docs-ask-reachable/u}]
    },
    {name: 'rag-warmup.mjs', external: NATIVE_PACKAGES, probes: []},
    {
        name: 'skills-worker.mjs',
        probes: [{input: '{"probe":true}\n', status: 0, stdout: /skills-worker-reachable/u}]
    },
    {name: 'memory-worker.mjs', external: NATIVE_PACKAGES, probes: []}
]

const REGISTERS_OAUTH_FLOWS = 'registerBunOAuthFlows()'

async function bundle(entry) {
    const built = await build({
        entryPoints: [join(root, 'scripts', entry.name)],
        outfile: join(outputDirectory, entry.name),
        bundle: true,
        platform: 'node',
        format: 'esm',
        target: 'node22',
        external: entry.external ?? [],
        banner: {js: REQUIRE_BANNER},
        logLevel: 'warning',
        write: false
    })
    const [output] = built.outputFiles
    return writeWhenChanged(join(outputDirectory, entry.name), output.contents)
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

const HOST = `${process.platform}-${process.arch}`

const nativeDirectory = join(outputDirectory, 'node_modules')

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

const isBindingPackage = name => /-(?:darwin|linux|linuxmusl|win32|android|wasm)/u.test(name)

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

async function copyDocumentationDatabase() {
    const source = join(packageDirectory(DATABASE_PACKAGE, root) ?? '', DATABASE_DIRECTORY)
    if (!existsSync(source)) {
        throw new Error(
            `${DATABASE_PACKAGE} carries no ${DATABASE_DIRECTORY}, so the documentation workers would ship without the manual. Run npm ci.`
        )
    }
    const target = join(outputDirectory, DATABASE_DIRECTORY)
    const hash = createHash('sha256')
    await hashTree(hash, source)
    const stamp = hash.digest('hex')
    if (await upToDate('documentation-table', target, stamp)) return undefined
    await rm(target, {recursive: true, force: true})
    await cp(source, target, {recursive: true, dereference: true})
    await recordStamp('documentation-table', stamp)
    return target
}

async function copyNativePackages() {
    const closure = nativeClosure()
    const hash = createHash('sha256')
    for (const [name, directory] of closure) {
        hash.update(`${name}\0${directory}\n`)
        await hashTree(hash, directory, path => path.endsWith(`${sep}node_modules`))
    }
    const stamp = hash.digest('hex')
    if (await upToDate('native-packages', nativeDirectory, stamp)) return undefined

    await rm(nativeDirectory, {recursive: true, force: true})
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
    await recordStamp('native-packages', stamp)
    return closure.length
}

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

await mkdir(outputDirectory, {recursive: true})
await writeWhenChanged(
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
process.stdout.write(
    copied === undefined ?
        `the native packages for ${HOST} are already beside the workers\n`
    :   `copied ${copied} native package(s) for ${HOST}\n`
)
const table = await copyDocumentationDatabase()
process.stdout.write(
    table === undefined ?
        'the documentation table is already beside the workers\n'
    :   `copied the documentation table to ${table}\n`
)
probeNativePackages()
process.stdout.write(`${NATIVE_PACKAGES.join(', ')} load from the workers directory\n`)

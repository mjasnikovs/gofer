/**
 * Puts the Node runtime Gofer's workers need beside the application.
 *
 * Every AI path, the memory embedder and both documentation workers are JavaScript, and Rust
 * spawns them. The binary that ran them used to be whatever `node` PATH answered with — so a
 * shipped Gofer failed at its first AI turn on a machine with no Node, and a macOS one failed even
 * where Node was installed, because a GUI-launched `.app` inherits `/usr/bin:/bin:/usr/sbin:/sbin`
 * and never reads a shell profile. An installed application cannot ask its user to fix that.
 *
 * So the runtime ships. This script downloads the pin in `protocol/node-runtime.json`, checks it
 * against the published checksum, and writes the one executable out of the archive into
 * `src-tauri/runtime/`, which `tauri.conf.json` bundles as an application resource. `workers.rs`
 * resolves it from there and `GOFER_NODE_BINARY` still overrides it.
 *
 * Only the binary is kept. A Node distribution is npm, its headers and a documentation tree as
 * well, and none of that is ever run here.
 *
 * The build is the proof: the extracted binary is asked its own version before this script exits,
 * because an archive that unpacked the wrong layout fails when it is run, not when it is written.
 *
 * Run it with `npm run build:node-runtime`. CI runs it per platform before packaging.
 */
import {createHash} from 'node:crypto'
import {spawnSync} from 'node:child_process'
import {chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {dirname, join, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outputDirectory = join(root, 'src-tauri/runtime')

/** How the binary is named where it lands. `workers.rs` looks for exactly this. */
export const binaryName = platform => (platform === 'win32' ? 'node.exe' : 'node')

/** The pin for one host, or a refusal that names the host it could not answer for. */
export function artifactFor(manifest, platform, architecture) {
    const key = `${platform}-${architecture}`
    const artifact = manifest.artifacts[key]
    if (!artifact) {
        throw new Error(
            `No pinned Node runtime for ${key}. Add one to protocol/node-runtime.json, or set GOFER_NODE_BINARY and skip this build.`
        )
    }
    return artifact
}

async function download(url, destination) {
    const response = await fetch(url)
    if (!response.ok) throw new Error(`Downloading ${url} failed with HTTP ${response.status}`)
    const bytes = Buffer.from(await response.arrayBuffer())
    await writeFile(destination, bytes)
    return createHash('sha256').update(bytes).digest('hex')
}

function extract(archive, directory) {
    // The Windows distribution is a zip and every other one is a tar.xz, which is why this is not
    // one command. `tar` on Windows cannot read xz, and `Expand-Archive` cannot read a tarball.
    const command =
        process.platform === 'win32' ?
            [
                'powershell',
                [
                    '-NoProfile',
                    '-Command',
                    `Expand-Archive -Path '${archive}' -DestinationPath '${directory}' -Force`
                ]
            ]
        :   ['tar', ['-xJf', archive, '-C', directory]]
    const result = spawnSync(command[0], command[1], {encoding: 'utf8'})
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error(result.stderr || `Could not extract ${archive}`)
}

/** Asks the extracted binary what it is. An archive with a moved layout fails here. */
function verifyVersion(binary, expected) {
    const result = spawnSync(binary, ['--version'], {encoding: 'utf8', timeout: 60_000})
    if (result.error) throw result.error
    const reported = result.stdout.trim()
    if (reported !== `v${expected}`) {
        throw new Error(`The extracted Node runtime reported ${reported}, expected v${expected}`)
    }
    return reported
}

const manifest = JSON.parse(await readFile(join(root, 'protocol/node-runtime.json'), 'utf8'))
const artifact = artifactFor(manifest, process.platform, process.arch)
const target = join(outputDirectory, binaryName(process.platform))

const staging = await mkdtemp(join(tmpdir(), 'gofer-node-runtime-'))
try {
    const archive = join(staging, 'node-runtime')
    process.stdout.write(
        `Downloading Node ${manifest.version} for ${process.platform}-${process.arch}\n`
    )
    const digest = await download(artifact.url, archive)
    if (digest !== artifact.sha256) {
        throw new Error(
            `${artifact.url} hashed to ${digest}, and the pin says ${artifact.sha256}. Nothing was installed.`
        )
    }
    extract(archive, staging)
    await mkdir(outputDirectory, {recursive: true})
    await rm(target, {force: true})
    await copyFile(join(staging, artifact.binary), target)
    // A tar copy keeps its mode and a zip one does not, and neither does every resource copy a
    // bundler makes. The runtime is only ever spawned, so it is only ever executable.
    await chmod(target, 0o755)
    process.stdout.write(`${verifyVersion(target, manifest.version)} at ${target}\n`)
} finally {
    await rm(staging, {recursive: true, force: true})
}

import {createHash} from 'node:crypto'
import {spawnSync} from 'node:child_process'
import {chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {dirname, join, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outputDirectory = join(root, 'src-tauri/runtime')

export const binaryName = platform => (platform === 'win32' ? 'node.exe' : 'node')

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
    await chmod(target, 0o755)
    process.stdout.write(`${verifyVersion(target, manifest.version)} at ${target}\n`)
} finally {
    await rm(staging, {recursive: true, force: true})
}

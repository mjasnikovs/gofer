import {createHash} from 'node:crypto'
import {appendFile, chmod, mkdir, mkdtemp, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {spawnSync} from 'node:child_process'
import {pinnedGodotArtifacts, pinnedVersionPrefix} from './godot-binary.mjs'

const PLATFORM_KEYS = Object.freeze({
    linux: 'linux-x86_64',
    win32: 'windows-x86_64',
    darwin: 'macos-universal'
})

function artifactKey() {
    const key = PLATFORM_KEYS[process.platform]
    if (!key) throw new Error(`No pinned Godot artifact for platform ${process.platform}`)
    return key
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
        :   ['unzip', ['-q', '-o', archive, '-d', directory]]
    const result = spawnSync(command[0], command[1], {encoding: 'utf8'})
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error(result.stderr || `Could not extract ${archive}`)
}

const key = artifactKey()
const artifact = pinnedGodotArtifacts().artifacts[key]
if (!artifact) throw new Error(`The pinned artifact manifest has no entry for ${key}`)

const directory = process.env.GOFER_GODOT_INSTALL_DIR ?? (await mkdtemp(join(tmpdir(), 'godot-')))
await mkdir(directory, {recursive: true})
const archive = join(directory, 'godot.zip')

const digest = await download(artifact.url, archive)
if (digest !== artifact.sha256) {
    throw new Error(`Godot SHA-256 mismatch: expected ${artifact.sha256}, received ${digest}`)
}
extract(archive, directory)

const binary = join(directory, artifact.binary)
if (process.platform !== 'win32') await chmod(binary, 0o755)

const version = spawnSync(binary, ['--version'], {encoding: 'utf8'})
const expected = pinnedVersionPrefix()
if (version.status !== 0 || !version.stdout.startsWith(expected)) {
    throw new Error(`Expected Godot ${expected} at ${binary}, received ${version.stdout.trim()}`)
}

process.stdout.write(`${binary}\n`)
if (process.env.GITHUB_ENV)
    await appendFile(process.env.GITHUB_ENV, `GOFER_GODOT_BINARY=${binary}\n`)

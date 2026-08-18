import {readFileSync} from 'node:fs'
import {isAbsolute} from 'node:path'
import {fileURLToPath} from 'node:url'
import {spawnSync} from 'node:child_process'

const MANIFEST_URL = new URL('../protocol/godot-artifacts.json', import.meta.url)
const PATH_CANDIDATES = ['godot', 'godot4']

export function pinnedGodotArtifacts() {
    return JSON.parse(readFileSync(fileURLToPath(MANIFEST_URL), 'utf8'))
}

// Godot reports "4.7.1.stable.official.<hash>" for the "4.7.1-stable" release tag.
export function pinnedVersionPrefix() {
    return pinnedGodotArtifacts().version.replace('-', '.')
}

function reportedVersion(command) {
    const result = spawnSync(command, ['--version'], {encoding: 'utf8'})
    if (result.error || result.status !== 0) return undefined
    return result.stdout.trim()
}

/**
 * Resolves the pinned Godot editor binary.
 *
 * `GOFER_GODOT_BINARY` wins when set and must be an absolute path, which is how CI pins an
 * extracted release. Otherwise the pinned version is accepted from `PATH`, so a developer whose
 * distribution already ships it can run the gate without extra setup. The pinned version is
 * always verified, so neither route can silently test a different engine.
 */
export function resolveGodotBinary() {
    const expected = pinnedVersionPrefix()
    const configured = process.env.GOFER_GODOT_BINARY
    if (configured) {
        if (!isAbsolute(configured)) throw new Error('GOFER_GODOT_BINARY must be an absolute path')
        const version = reportedVersion(configured)
        if (!version) throw new Error(`Could not execute GOFER_GODOT_BINARY at ${configured}`)
        if (!version.startsWith(expected)) {
            throw new Error(`Expected Godot ${expected}, received ${version}`)
        }
        return configured
    }
    const mismatched = []
    for (const candidate of PATH_CANDIDATES) {
        const version = reportedVersion(candidate)
        if (!version) continue
        if (version.startsWith(expected)) return candidate
        mismatched.push(`${candidate} reports ${version}`)
    }
    const detail = mismatched.length > 0 ? ` Found ${mismatched.join(', ')}.` : ''
    throw new Error(
        `Godot ${expected} is required. Install it on PATH, or set GOFER_GODOT_BINARY to the `
            + `absolute path of the pinned binary.${detail}`
    )
}

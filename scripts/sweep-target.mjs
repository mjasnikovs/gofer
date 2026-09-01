import {readdir, rm, stat} from 'node:fs/promises'
import {dirname, join, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const target = join(root, 'src-tauri/target')

const GIGABYTE = 1024 ** 3
const DAY = 86_400_000
const budget = Number(process.env['GOFER_TARGET_BUDGET_GB'] ?? 30) * GIGABYTE
const keepDays = Number(process.env['GOFER_TARGET_KEEP_DAYS'] ?? 14)

async function size(directory) {
    let total = 0
    for (const entry of await readdir(directory, {withFileTypes: true}).catch(() => [])) {
        const path = join(directory, entry.name)
        if (entry.isDirectory()) total += await size(path)
        else total += (await stat(path).catch(() => ({size: 0}))).size
    }
    return total
}

const gigabytes = bytes => (bytes / GIGABYTE).toFixed(1)

// Cargo never deletes what it stops needing, and it does not touch a unit it finds fresh, so age is
// the only evidence of a dead build variant. Deleting a live one is safe — Cargo rebuilds it.
async function unitsOlderThan(profile, cutoff) {
    const fingerprints = join(profile, '.fingerprint')
    const dead = []
    for (const name of await readdir(fingerprints).catch(() => [])) {
        const invoked = await stat(join(fingerprints, name, 'invoked.timestamp')).catch(
            () => undefined
        )
        if (invoked && invoked.mtimeMs > cutoff) continue
        const {mtimeMs} = await stat(join(fingerprints, name)).catch(() => ({mtimeMs: 0}))
        if (!invoked && mtimeMs > cutoff) continue
        dead.push(name)
    }
    return dead
}

async function sweepProfile(profile, cutoff) {
    const dead = await unitsOlderThan(profile, cutoff)
    if (dead.length === 0) return 0

    const hashes = new Set(dead.map(name => name.slice(name.lastIndexOf('-') + 1)))
    const deps = join(profile, 'deps')
    const artefacts = (await readdir(deps).catch(() => [])).filter(name => {
        const stem = name.slice(0, name.indexOf('.') === -1 ? name.length : name.indexOf('.'))
        return hashes.has(stem.slice(stem.lastIndexOf('-') + 1))
    })

    for (const name of dead) {
        await rm(join(profile, '.fingerprint', name), {recursive: true, force: true})
        await rm(join(profile, 'build', name), {recursive: true, force: true})
    }
    for (const name of artefacts) await rm(join(deps, name), {force: true})
    return dead.length
}

async function sweepIncremental(profile, cutoff) {
    const incremental = join(profile, 'incremental')
    let dropped = 0
    for (const name of await readdir(incremental).catch(() => [])) {
        const path = join(incremental, name)
        const {mtimeMs} = await stat(path).catch(() => ({mtimeMs: 0}))
        if (mtimeMs > cutoff) continue
        await rm(path, {recursive: true, force: true})
        dropped += 1
    }
    return dropped
}

const before = await size(target)
if (before <= budget) {
    process.stdout.write(
        `src-tauri/target is ${gigabytes(before)} GB, under the ${gigabytes(budget)} GB budget\n`
    )
    process.exit(0)
}

const cutoff = Date.now() - keepDays * DAY
let units = 0
let sessions = 0
for (const name of await readdir(target, {withFileTypes: true}).catch(() => [])) {
    if (!name.isDirectory()) continue
    const profile = join(target, name.name)
    units += await sweepProfile(profile, cutoff)
    sessions += await sweepIncremental(profile, cutoff)
}

const after = await size(target)
process.stdout.write(
    `swept ${units} build unit(s) and ${sessions} incremental session(s) untouched for ${keepDays} days: ${gigabytes(before)} GB to ${gigabytes(after)} GB\n`
)

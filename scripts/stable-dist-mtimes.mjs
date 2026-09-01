import {createHash} from 'node:crypto'
import {mkdir, readFile, readdir, stat, utimes, writeFile} from 'node:fs/promises'
import {dirname, join, relative, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const distDirectory = join(root, 'dist')
const manifestPath = join(root, 'node_modules/.cache/gofer/dist-mtimes.json')

async function files(directory) {
    const found = []
    for (const entry of await readdir(directory, {withFileTypes: true})) {
        const path = join(directory, entry.name)
        if (entry.isDirectory()) found.push(...(await files(path)))
        else found.push(path)
    }
    return found
}

const digest = async path =>
    createHash('sha256')
        .update(await readFile(path))
        .digest('hex')

/// Vite rewrites every asset on every build, and `dist` is what tauri-build watches, so a
/// byte-identical bundle still costs a minute of release relink. Give unchanged files their old
/// timestamp back and Cargo sees the build it already has.
const previous = JSON.parse(await readFile(manifestPath, 'utf8').catch(() => '{}'))
const current = {}

for (const path of await files(distDirectory)) {
    const name = relative(distDirectory, path)
    const hash = await digest(path)
    const remembered = previous[name]
    if (remembered?.hash === hash) {
        const when = new Date(remembered.mtimeMs)
        await utimes(path, when, when)
        current[name] = remembered
        continue
    }
    current[name] = {hash, mtimeMs: (await stat(path)).mtimeMs}
}

await mkdir(dirname(manifestPath), {recursive: true})
await writeFile(manifestPath, `${JSON.stringify(current)}\n`)

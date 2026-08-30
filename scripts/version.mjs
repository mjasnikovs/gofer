import {readFile, writeFile} from 'node:fs/promises'
import {dirname, join, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export const SOURCES = [
    {
        file: 'package.json',
        pattern: /^(?<before>\s*"version":\s*")(?<version>[^"]+)(?<after>")/mu
    },
    {
        file: 'src-tauri/Cargo.toml',
        pattern: /^(?<before>\[package\][^[]*?\nversion\s*=\s*")(?<version>[^"]+)(?<after>")/su
    },
    {
        file: 'src-tauri/tauri.conf.json',
        pattern: /^(?<before>\s*"version":\s*")(?<version>[^"]+)(?<after>")/mu
    }
]

export async function readVersions() {
    const found = []
    for (const source of SOURCES) {
        const text = await readFile(join(root, source.file), 'utf8')
        const match = source.pattern.exec(text)
        if (!match?.groups) throw new Error(`${source.file} has no version to read`)
        found.push({file: source.file, version: match.groups.version})
    }
    return found
}

export async function writeVersion(version) {
    const previous = await readVersions()
    for (const source of SOURCES) {
        const path = join(root, source.file)
        const text = await readFile(path, 'utf8')
        await writeFile(path, text.replace(source.pattern, `$<before>${version}$<after>`))
    }
    return previous
}

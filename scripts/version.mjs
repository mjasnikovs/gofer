/**
 * The one version, and the three files that have to agree on it.
 *
 * Gofer's version is written in `package.json`, `src-tauri/Cargo.toml` and
 * `src-tauri/tauri.conf.json`. Nothing kept them equal, and each one is read by something
 * different: npm scripts, the Rust crate, and the bundler that names every installer. A release
 * where they disagree ships a `.deb` called one thing by an application that reports another.
 *
 * `readVersions` is what the check reads and `writeVersion` is what a release bump writes.
 */
import {readFile, writeFile} from 'node:fs/promises'
import {dirname, join, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Where each version lives, and the pattern that finds only that one.
 *
 * The Cargo pattern is anchored to `[package]`'s own `version`, because the manifest holds a
 * `version` for every dependency below it and the first match would be the crate's only by luck.
 */
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

/** What each file currently says, in the order above. */
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

/** Writes one version into all three, and answers with what it wrote over. */
export async function writeVersion(version) {
    const previous = await readVersions()
    for (const source of SOURCES) {
        const path = join(root, source.file)
        const text = await readFile(path, 'utf8')
        await writeFile(path, text.replace(source.pattern, `$<before>${version}$<after>`))
    }
    return previous
}

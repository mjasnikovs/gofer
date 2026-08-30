import {readVersions, writeVersion} from './version.mjs'

const [version] = process.argv.slice(2)
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version ?? '')) {
    process.stderr.write(
        'Name the version to set: npm run set-version -- 0.2.0. Tauri reads it as a bundle version, so it has to be three numbers.\n'
    )
    process.exit(1)
}

const previous = await readVersions()
await writeVersion(version)
for (const entry of previous) {
    process.stdout.write(`${entry.file}: ${entry.version} -> ${version}\n`)
}

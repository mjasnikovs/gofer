/**
 * Refuses a tree whose three version fields disagree.
 *
 * Run by `npm run check`. `scripts/set-version.mjs` is how they are moved together.
 */
import {readVersions} from './version.mjs'

const found = await readVersions()
const versions = new Set(found.map(entry => entry.version))
if (versions.size > 1) {
    process.stderr.write(
        `Gofer's version is written in ${found.length} files and they disagree:\n${found
            .map(entry => `  ${entry.version}  ${entry.file}`)
            .join('\n')}\nRun npm run set-version -- <version> to move them together.\n`
    )
    process.exit(1)
}
process.stdout.write(`version ${[...versions][0]} in ${found.length} files\n`)

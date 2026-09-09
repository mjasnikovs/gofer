// A fresh dump of the pinned engine, against the vocabulary this repository committed.
//
// Everything else in the suite holds Gofer to Gofer: the catalogue to the addon, the addon to its
// read-backs, a command to its handler. Those are ours, and they change when we change them.
// `protocol/godot-vocabulary.json` is not ours — it is the engine's key names, its performance
// monitors and its Variant types, and every one of them reaches the model as a schema `enum`.
//
// So this is its own gate rather than another test. Nothing in it can fail because of a commit;
// it fails because the pin in `protocol/godot-artifacts.json` moved. The fix for a red run is to
// re-run `npm run generate` against the moved pin and commit what it writes.

import {readFile} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {VOCABULARY_PATH, buildVocabulary, serializeVocabulary} from './godot-vocabulary.mjs'
import {pinnedVersionPrefix, resolveGodotBinary} from './godot-binary.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const binary = resolveGodotBinary()

const fresh = await buildVocabulary(binary)
process.stdout.write(
    `Checking ${VOCABULARY_PATH} against Godot ${fresh.engine} (pinned ${pinnedVersionPrefix()})\n`
)

const committed = await readFile(new URL(VOCABULARY_PATH, `file://${root}`), 'utf8')
const written = serializeVocabulary(fresh)
if (committed === written) {
    process.stdout.write(
        `${fresh.keys.length} key names, ${fresh.monitors.length} monitors and `
            + `${fresh.variantTypes.length} Variant types, all as committed\n`
    )
    process.exit(0)
}

const before = JSON.parse(committed)
const named = one => (typeof one === 'string' ? one : one.name)
for (const list of ['keys', 'monitors', 'variantTypes', 'mouseButtons', 'joyButtons', 'joyAxes']) {
    const had = before[list].map(named)
    const has = fresh[list].map(named)
    const gone = had.filter(name => !has.includes(name))
    const added = has.filter(name => !had.includes(name))
    if (gone.length > 0) process.stdout.write(`${list}: gone — ${gone.join(', ')}\n`)
    if (added.length > 0) process.stdout.write(`${list}: new — ${added.join(', ')}\n`)
}
if (before.engine !== fresh.engine)
    process.stdout.write(`engine: ${before.engine} → ${fresh.engine}\n`)

process.stderr.write(
    `${VOCABULARY_PATH} is not what this engine answers. Run \`npm run generate\` and commit what `
        + 'it writes.\n'
)
process.exit(1)

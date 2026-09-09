// The engine run behind `npm run generate`, and nothing else.
//
// It is its own file because `godot-vocabulary.mjs` is bundled into the AI worker now — the tool
// schema reads its tag payloads — and esbuild makes a module's `import.meta.url` the bundle's own,
// so a `process.argv[1]` main block inside it runs on every worker start.
import {readFile, writeFile} from 'node:fs/promises'
import {join, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {resolveGodotBinary} from './godot-binary.mjs'
import {
    VOCABULARY_PATH,
    availableGodotBinary,
    buildVocabulary,
    serializeVocabulary
} from './godot-vocabulary.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const flag = process.argv.indexOf('--out')
const out = flag === -1 ? join(root, VOCABULARY_PATH) : resolve(process.argv[flag + 1])
const binary = flag === -1 ? availableGodotBinary() : resolveGodotBinary()

if (!binary) {
    process.stdout.write(
        `scripts/godot-vocabulary-build.mjs: no pinned Godot on this machine, so ${VOCABULARY_PATH} stays as committed\n`
    )
} else {
    const written = serializeVocabulary(await buildVocabulary(binary))
    const before = await readFile(out, 'utf8').catch(() => '')
    if (before !== written) await writeFile(out, written)
    process.stdout.write(
        `scripts/godot-vocabulary-build.mjs: ${before === written ? 'unchanged' : 'rewrote'} ${out}\n`
    )
}

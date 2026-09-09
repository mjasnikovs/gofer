// The surface the model reads today, as one arm for surf-run.mjs / vrun.mjs: the committed
// protocol/schemas/v2/godot-tool.json, which the worker is held to byte for byte, beside S1's
// extras so the pair differs in the Godot surface and nothing else.
import {readFile, writeFile} from 'node:fs/promises'
const REPO = new URL('../..', import.meta.url).pathname

const S = process.env.SCRATCH ?? import.meta.dirname
const ARM = process.env.ARM ?? 'S2'
const PREFIX = process.env.PREFIX ?? 'surf'
const godot = JSON.parse(await readFile(`${REPO}/protocol/schemas/v2/godot-tool.json`, 'utf8'))
const shipped = JSON.parse(await readFile(`${S}/shapes-tools-C.json`, 'utf8'))
const extras = shipped.filter(t => !t.name.startsWith('godot_'))
const listed = [godot, ...extras].map(t => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters
}))
await writeFile(`${S}/${PREFIX}-tools-${ARM}.json`, JSON.stringify(listed, null, 2))
console.log(
    ARM,
    'tools',
    listed.length,
    listed.map(t => t.name).join(', '),
    'bytes',
    JSON.stringify(listed).length
)

// The surface as the worker really builds it today, written as one arm for surf-run.mjs: the
// paired comparison after a step that moves the surface is S1 (shipped, verbatim) against this.
import {readFile, writeFile} from 'node:fs/promises'
import {createAgentTools} from '../ai-provider.mjs'
const REPO = new URL('../..', import.meta.url).pathname

const S = process.env.SCRATCH ?? import.meta.dirname
const ARM = process.env.ARM ?? 'S2'
const domains = JSON.parse(await readFile(`${S}/catalog.json`, 'utf8'))
const host = {call: async () => ({})}
const model = {
    id: 'local',
    api: 'openai-completions',
    provider: 'local',
    contextWindow: 145152,
    sees: false
}
const {tools} = createAgentTools(REPO, domains, host, [], model, [])
// The extras are S1's, verbatim, so the pair differs in the Godot surface and nothing else.
const shipped = JSON.parse(await readFile(`${S}/shapes-tools-C.json`, 'utf8'))
const extras = shipped.filter(t => !t.name.startsWith('godot_'))
const godot = tools.filter(t => t.name === 'godot')
const listed = [...godot, ...extras].map(t => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters
}))
await writeFile(`${S}/surf-tools-${ARM}.json`, JSON.stringify(listed, null, 2))
console.log(
    ARM,
    'tools',
    listed.length,
    listed.map(t => t.name).join(', '),
    'bytes',
    JSON.stringify(listed).length
)

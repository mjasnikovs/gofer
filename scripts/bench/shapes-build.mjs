import {readFile, writeFile} from 'node:fs/promises'
import {createAgentTools} from '../ai-provider.mjs'
import {jsonSchemaOfEntry as entryA} from './arms/tool-schema-A.mjs'
import {jsonSchemaOfEntry as entryB} from './arms/tool-schema-B.mjs'
import {jsonSchemaOfEntry as entryC} from './arms/tool-schema-C.mjs'
const REPO = new URL('../..', import.meta.url).pathname

const S = process.env.SCRATCH ?? import.meta.dirname
const catalog = JSON.parse(await readFile(`${S}/catalog.json`, 'utf8'))
const model = {
    id: 'local',
    api: 'openai-completions',
    provider: 'local',
    contextWindow: 145152,
    sees: false
}
const host = {call: async () => ({})}
const {tools} = createAgentTools(REPO, catalog, host, [], model, [])
const every = JSON.parse(await readFile(`${S}/tools.json`, 'utf8'))
const EXTRAS = ['subagent', 'web_search', 'web_fetch', 'remember', 'ask_user']
const extras = every.filter(t => EXTRAS.includes(t.name))
const base = [
    ...tools.map(t => ({
        name: t.name,
        description: t.description,
        parameters: structuredClone(t.parameters)
    })),
    ...extras
]
const byName = Object.fromEntries(catalog.map(d => [d.name, d.operations]))

const ENTRY = {A: entryA, B: entryB, C: entryC}
for (const [arm, entry] of Object.entries(ENTRY)) {
    const armed = base.map(t => {
        if (!byName[t.name]) return t
        const copy = structuredClone(t)
        copy.parameters.properties.ops.items = entry(byName[t.name])
        return copy
    })
    await writeFile(`${S}/shapes-tools-${arm}.json`, JSON.stringify(armed, null, 2))
    console.log(arm, 'tools', armed.length, 'bytes', JSON.stringify(armed).length)
}

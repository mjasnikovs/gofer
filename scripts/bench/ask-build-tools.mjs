// The tool set the ask bench sends: the confined tools and the godot tool as the worker builds
// them, the four extras from the surf bench, and ask_user in its delegating shape.
import {readFile, writeFile} from 'node:fs/promises'
import {createAgentTools} from '../ai-provider.mjs'
const S = process.env.SCRATCH ?? import.meta.dirname
const domains = JSON.parse(await readFile(`${S}/catalog.json`, 'utf8'))
const host = {call: async () => ({})}
const model = {
    id: 'local',
    api: 'openai-completions',
    provider: 'local',
    contextWindow: 145152,
    sees: false
}
const {tools} = createAgentTools(
    '/home/edgars/hub/gofer/fixtures/live-project',
    domains,
    host,
    [],
    model,
    []
)
console.log(tools.length, tools.map(t => t.name).join(' '))
await writeFile(
    `${S}/ask-tools.json`,
    JSON.stringify(
        tools.map(t => ({name: t.name, description: t.description, parameters: t.parameters})),
        null,
        2
    )
)
import {createAskUserTool} from '../ai-ask.mjs'
const s2 = JSON.parse(await readFile(`${S}/surf-tools-S2.json`, 'utf8'))
const extras = s2.filter(t => ['subagent', 'web_search', 'web_fetch', 'remember'].includes(t.name))
const ask = createAskUserTool({host, model, delegate: async () => ({text: ''})})
const all = [
    ...tools.map(t => ({name: t.name, description: t.description, parameters: t.parameters})),
    ...extras,
    {name: ask.name, description: ask.description, parameters: ask.parameters}
]
await writeFile(`${S}/ask-tools.json`, JSON.stringify(all, null, 2))
console.log(all.map(t => t.name).join(' '))

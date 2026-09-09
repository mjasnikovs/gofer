import {readFile, writeFile} from 'node:fs/promises'
import {createAgentTools} from '../ai-provider.mjs'
const REPO = new URL('../..', import.meta.url).pathname

const SCRATCH = process.env.SCRATCH ?? import.meta.dirname
const domains = JSON.parse(await readFile(`${SCRATCH}/catalog.json`, 'utf8'))
const host = {call: async () => ({})}
const model = {
    id: 'local',
    api: 'openai-completions',
    provider: 'local',
    contextWindow: 145152,
    sees: false
}
const models = {}
const {tools} = createAgentTools(REPO, domains, host, [], model, [])
console.log('confined+godot tools:', tools.length, tools.map(t => t.name).join(', '))
await writeFile(
    `${SCRATCH}/tools-partial.json`,
    JSON.stringify(
        tools.map(t => ({name: t.name, description: t.description, parameters: t.parameters})),
        null,
        2
    )
)

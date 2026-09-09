import {readFile, writeFile} from 'node:fs/promises'
import {createAgentTools} from '../ai-provider.mjs'
import {createSubagentTool} from '../ai-subagent.mjs'
import {createWebSearchTool} from '../ai-search.mjs'
import {createWebFetchTool} from '../ai-fetch.mjs'
import {createRememberTool} from '../ai-remember.mjs'
import {createAskUserTool} from '../ai-ask.mjs'
const REPO = new URL('../..', import.meta.url).pathname

const SCRATCH = process.env.SCRATCH ?? import.meta.dirname
const domains = JSON.parse(await readFile(`${SCRATCH}/catalog.json`, 'utf8'))
const host = {call: async () => ({})}
const model = {id: 'local', api: 'openai-completions', provider: 'local', contextWindow: 145152}
const stub = {
    workspacePath: REPO,
    models: {},
    model,
    thinkingLevel: 'medium',
    streamOptions: {},
    settings: {},
    probe: undefined
}
const extra = [
    createSubagentTool(stub),
    createWebSearchTool({provider: 'brave', apiKey: 'x'}),
    createWebFetchTool(stub),
    createRememberTool({host}),
    createAskUserTool({host, model, delegate: async () => ''})
]
const {tools} = createAgentTools(REPO, domains, host, extra, model, [])
console.log('tools:', tools.length)
console.log(tools.map(t => t.name).join(', '))
await writeFile(
    `${SCRATCH}/tools.json`,
    JSON.stringify(
        tools.map(t => ({name: t.name, description: t.description, parameters: t.parameters})),
        null,
        2
    )
)

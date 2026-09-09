import {readFile, writeFile} from 'node:fs/promises'
import {createAgentTools} from '../ai-provider.mjs'
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

// The three arms differ only in which godot_node operations exist: dropping one drops it from the
// oneOf schema and from the domain description's operation list at once, which is the real removal.
const DROP = {
    A: [],
    B: ['create_nodes', 'set_properties'],
    C: ['create', 'set_property']
}

const shape = tools =>
    tools.map(t => ({name: t.name, description: t.description, parameters: t.parameters}))

for (const [arm, drop] of Object.entries(DROP)) {
    const domains = catalog.map(d =>
        d.name === 'godot_node' ?
            {...d, operations: d.operations.filter(o => !drop.includes(o.op))}
        :   d
    )
    const {tools} = createAgentTools(REPO, domains, host, [], model, [])
    await writeFile(`${S}/batchab-tools-${arm}.json`, JSON.stringify(shape(tools), null, 2))
    const node = tools.find(t => t.name === 'godot_node')
    console.log(
        arm,
        'tools',
        tools.length,
        'godot_node ops',
        node.parameters.properties.ops.items.oneOf.length
    )
}

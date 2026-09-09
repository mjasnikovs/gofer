import {readFile} from 'node:fs/promises'
const S = process.env.SCRATCH ?? import.meta.dirname
const tok = async content => {
    const r = await fetch('http://localhost:8080/tokenize', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({content})
    })
    return (await r.json()).tokens.length
}
for (const arm of ['A', 'B', 'C']) {
    const tools = JSON.parse(await readFile(`${S}/batchab-tools-${arm}.json`, 'utf8'))
    const node = tools.find(t => t.name === 'godot_node')
    const whole = await tok(JSON.stringify(tools))
    const nodeTok = await tok(JSON.stringify(node))
    const desc = await tok(node.description)
    const params = await tok(JSON.stringify(node.parameters))
    console.log(
        `${arm}  allTools ${whole}  godot_node ${nodeTok}  (desc ${desc} + params ${params})`
    )
}
// the two batch ops on their own, as the schema and the prose spell them
const A = JSON.parse(await readFile(`${S}/batchab-tools-A.json`, 'utf8')).find(
    t => t.name === 'godot_node'
)
for (const op of ['create_nodes', 'set_properties']) {
    const branch = A.parameters.properties.ops.items.oneOf.find(b => b.properties.op.const === op)
    const line = A.description.split('\n').find(l => l.startsWith(`- ${op}`))
    console.log(
        `${op}: schema branch ${await tok(JSON.stringify(branch))} tok, description line ${await tok(line)} tok`
    )
}

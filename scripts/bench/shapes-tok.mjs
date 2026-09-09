import {readFile} from 'node:fs/promises'
const S = process.env.SCRATCH ?? import.meta.dirname
const tok = async content =>
    (
        await (
            await fetch('http://localhost:8080/tokenize', {
                method: 'POST',
                headers: {'content-type': 'application/json'},
                body: JSON.stringify({content})
            })
        ).json()
    ).tokens.length

const prompt = await readFile(`${S}/prompt.txt`, 'utf8')
console.log('system prompt', await tok(prompt))
const rows = []
for (const arm of ['A', 'B', 'C']) {
    const tools = JSON.parse(await readFile(`${S}/shapes-tools-${arm}.json`, 'utf8'))
    const godot = tools.filter(t => t.name.startsWith('godot_'))
    const all = await tok(JSON.stringify(tools))
    const desc = await tok(godot.map(t => t.description).join('\n'))
    const params = await tok(JSON.stringify(godot.map(t => t.parameters)))
    rows.push({arm, allTools: all, godotDescriptions: desc, godotParams: params})
}
console.table(rows)
// the duplicate specifically: every op.description inside arm A's oneOf branches
const A = JSON.parse(await readFile(`${S}/shapes-tools-A.json`, 'utf8'))
let dup = 0
for (const t of A.filter(t => t.name.startsWith('godot_')))
    for (const branch of t.parameters.properties.ops.items.oneOf ?? [])
        if (branch.properties?.op?.description) dup += await tok(branch.properties.op.description)
console.log('op.description text inside arm A oneOf branches:', dup, 'tokens')

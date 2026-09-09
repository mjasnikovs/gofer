import {readFile} from 'node:fs/promises'
const S = process.env.SCRATCH ?? import.meta.dirname
const PREFIX = process.env.PREFIX ?? 'vocab'
const ARMS = process.env.ARMS.split(',')
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

const rows = []
for (const arm of ARMS) {
    const tools = JSON.parse(await readFile(`${S}/${PREFIX}-tools-${arm}.json`, 'utf8'))
    const godot = tools.find(t => t.name === 'godot')
    rows.push({
        arm,
        allToolsJson: await tok(JSON.stringify(tools)),
        godotToolJson: await tok(JSON.stringify(godot)),
        description: await tok(godot.description),
        parameters: await tok(JSON.stringify(godot.parameters)),
        descChars: godot.description.length
    })
}
console.table(rows)

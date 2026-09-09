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
console.log('system prompt', await tok(prompt), 'tokens')
const rows = []
for (const arm of ['S1', 'S2', 'S3', 'S4', 'S4b']) {
    const tools = JSON.parse(await readFile(`${S}/surf-tools-${arm}.json`, 'utf8'))
    const EXTRAS = new Set([
        'read',
        'write',
        'edit',
        'bash',
        'subagent',
        'web_search',
        'web_fetch',
        'remember',
        'ask_user'
    ])
    const godot = tools.filter(t => !EXTRAS.has(t.name))
    rows.push({
        arm,
        tools: tools.length,
        godotTools: godot.length,
        allToolsJson: await tok(JSON.stringify(tools)),
        godotToolsJson: await tok(JSON.stringify(godot)),
        godotDescriptions: await tok(godot.map(t => t.description).join('\n')),
        godotParams: await tok(JSON.stringify(godot.map(t => t.parameters)))
    })
}
console.table(rows)

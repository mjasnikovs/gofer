import {readFile, writeFile} from 'node:fs/promises'
const SCRATCH = process.env.SCRATCH ?? import.meta.dirname
const tok = async content => {
    const r = await fetch('http://localhost:8080/tokenize', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({content})
    })
    const j = await r.json()
    return j.tokens.length
}
const tools = JSON.parse(await readFile(`${SCRATCH}/tools.json`, 'utf8'))
const prompt = await readFile(`${SCRATCH}/prompt.txt`, 'utf8')
const rows = []
for (const t of tools) {
    const desc = t.description ?? ''
    const params = JSON.stringify(t.parameters ?? {})
    rows.push({
        name: t.name,
        nameTok: await tok(t.name),
        descChars: desc.length,
        descTok: await tok(desc),
        paramChars: params.length,
        paramTok: await tok(params)
    })
}
for (const r of rows) r.total = r.nameTok + r.descTok + r.paramTok
rows.sort((a, b) => b.total - a.total)
const systemTok = await tok(prompt)
const allToolsJson = JSON.stringify(
    tools.map(t => ({
        type: 'function',
        function: {name: t.name, description: t.description, parameters: t.parameters}
    }))
)
const allToolsTok = await tok(allToolsJson)
console.log(
    JSON.stringify(
        {
            systemPromptChars: prompt.length,
            systemTok,
            allToolsChars: allToolsJson.length,
            allToolsTok,
            sumRows: rows.reduce((a, r) => a + r.total, 0)
        },
        null,
        1
    )
)
console.table(rows)
await writeFile(`${SCRATCH}/rows.json`, JSON.stringify({rows, systemTok, allToolsTok}, null, 2))

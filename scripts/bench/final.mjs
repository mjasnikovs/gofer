import {readFile} from 'node:fs/promises'
const SCRATCH = process.env.SCRATCH ?? import.meta.dirname
const tools = JSON.parse(await readFile(`${SCRATCH}/tools.json`, 'utf8'))
const prompt = await readFile(`${SCRATCH}/prompt.txt`, 'utf8')
const inv = await readFile(`${SCRATCH}/inventory.txt`, 'utf8')
const api = tools.map(t => ({
    type: 'function',
    function: {name: t.name, description: t.description, parameters: t.parameters}
}))
const session =
    'Editor session: offline. Godot 4.7.2. Every tool runs in the project root and takes paths the way the project spells them, never an absolute one.'
const invBlock =
    "The project's tracked files are listed below. Read them here rather than listing the project; list again only after you have written a file this list does not name.\n\n"
    + inv
const ask = async (label, body) => {
    const r = await fetch('http://localhost:8080/v1/chat/completions', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({...body, max_tokens: 1, temperature: 0})
    })
    const j = await r.json()
    console.log(label.padEnd(46), j.usage?.prompt_tokens ?? JSON.stringify(j).slice(0, 200))
    return j.usage?.prompt_tokens
}
const user = c => [
    {role: 'system', content: prompt},
    {role: 'user', content: c}
]
await ask('reconstructed real turn (sys+ctx+19 tools+hi)', {
    messages: user(`hi\n\n${session}\n\n${invBlock}`),
    tools: api
})
await ask('same, no inventory block', {messages: user(`hi\n\n${session}`), tools: api})

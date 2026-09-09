import {readFile} from 'node:fs/promises'
const SCRATCH = process.env.SCRATCH ?? import.meta.dirname
const tools = JSON.parse(await readFile(`${SCRATCH}/tools.json`, 'utf8'))
const prompt = await readFile(`${SCRATCH}/prompt.txt`, 'utf8')
const api = tools.map(t => ({
    type: 'function',
    function: {name: t.name, description: t.description, parameters: t.parameters}
}))
const ask = async (label, body) => {
    const r = await fetch('http://localhost:8080/v1/chat/completions', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({...body, max_tokens: 1, temperature: 0})
    })
    const j = await r.json()
    if (!j.usage) return console.log(label, 'ERR', JSON.stringify(j).slice(0, 400))
    console.log(label.padEnd(34), j.usage.prompt_tokens)
    return j.usage.prompt_tokens
}
const user = [{role: 'user', content: 'HI'}]
const sys = [{role: 'system', content: prompt}, ...user]
const a = await ask('bare HI (no sys, no tools)', {messages: user})
const b = await ask('HI + system prompt', {messages: sys})
const c = await ask('HI + tools (no system)', {messages: user, tools: api})
const d = await ask('HI + system + all 19 tools', {messages: sys, tools: api})
const e = await ask('HI + system + 4 pi built-ins', {
    messages: sys,
    tools: api.filter(t => ['read', 'write', 'edit', 'bash'].includes(t.function.name))
})
const f = await ask('HI + system + 10 godot only', {
    messages: sys,
    tools: api.filter(t => t.function.name.startsWith('godot_'))
})
console.log(
    '\nderived: tools block =',
    d - b,
    ' system block =',
    d - c,
    ' godot block =',
    f - b,
    ' builtins block =',
    e - b
)

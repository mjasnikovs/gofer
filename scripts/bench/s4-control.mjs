import {readFile} from 'node:fs/promises'
const S = process.env.SCRATCH ?? import.meta.dirname
const ask = async (label, fn) => {
    const r = await fetch('http://localhost:8080/v1/chat/completions', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        signal: AbortSignal.timeout(240000),
        body: JSON.stringify({
            model: 'local',
            messages: [
                {
                    role: 'user',
                    content: `Call ${fn.name} with no arguments at all. Send {} and nothing else.`
                }
            ],
            tools: [{type: 'function', function: fn}],
            tool_choice: {type: 'function', function: {name: fn.name}},
            reasoning_effort: 'medium',
            seed: 3
        })
    })
    if (!r.ok) return console.log(label, 'HTTP', r.status, (await r.text()).slice(0, 300))
    const b = await r.json()
    console.log(
        label,
        JSON.stringify(b.choices?.[0]?.message?.tool_calls?.map(c => c.function.arguments))
    )
}
const S1 = JSON.parse(await readFile(`${S}/surf-tools-S1.json`, 'utf8'))
await ask(
    'S1-godot_node(ops array)',
    S1.find(t => t.name === 'godot_node')
)
const S3 = JSON.parse(await readFile(`${S}/surf-tools-S3.json`, 'utf8'))
await ask(
    'S3-godot_node_create(flat obj)',
    S3.find(t => t.name === 'godot_node_create')
)

// Is a top-level `oneOf` in `parameters` actually GBNF-constrained, or does llama.cpp leave it
// unconstrained? Forcing the call and asking for nothing is the cheapest way to see.
import {readFile} from 'node:fs/promises'
const S = process.env.SCRATCH ?? import.meta.dirname
const S4 = JSON.parse(await readFile(`${S}/surf-tools-S4.json`, 'utf8'))
const node = S4.find(t => t.name === 'godot_node')
const variants = {
    bare: node.parameters,
    typed: {type: 'object', ...node.parameters}
}
for (const [label, parameters] of Object.entries(variants)) {
    const r = await fetch('http://localhost:8080/v1/chat/completions', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        signal: AbortSignal.timeout(240000),
        body: JSON.stringify({
            model: 'local',
            messages: [
                {
                    role: 'user',
                    content: 'Call godot_node with no arguments at all. Send {} and nothing else.'
                }
            ],
            tools: [{type: 'function', function: {...node, parameters}}],
            tool_choice: {type: 'function', function: {name: 'godot_node'}},
            reasoning_effort: 'medium',
            seed: 3
        })
    })
    if (!r.ok) {
        console.log(label, 'HTTP', r.status, (await r.text()).slice(0, 300))
        continue
    }
    const b = await r.json()
    console.log(
        label,
        JSON.stringify(b.choices?.[0]?.message?.tool_calls?.map(c => c.function.arguments))
    )
}

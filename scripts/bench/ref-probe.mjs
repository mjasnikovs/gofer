// Does llama.cpp constrain a `$ref` into `parameters.$defs`? Ask for a wrong payload under a
// tagged value whose branches live in $defs; a constrained grammar cannot write it.
const defs = {
    taggedValue: {
        oneOf: [
            {
                type: 'object',
                properties: {
                    type: {const: 'Vector2'},
                    value: {type: 'array', items: {type: 'number'}, minItems: 2, maxItems: 2}
                },
                required: ['type', 'value'],
                additionalProperties: false
            },
            {
                type: 'object',
                properties: {type: {const: 'bool'}, value: {type: 'boolean'}},
                required: ['type', 'value'],
                additionalProperties: false
            }
        ]
    }
}
const variants = {
    ref: {
        type: 'object',
        $defs: defs,
        properties: {node: {type: 'string'}, value: {$ref: '#/$defs/taggedValue'}},
        required: ['node', 'value'],
        additionalProperties: false
    },
    inline: {
        type: 'object',
        properties: {node: {type: 'string'}, value: defs.taggedValue},
        required: ['node', 'value'],
        additionalProperties: false
    }
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
                    content:
                        'Call set_value with node "/Main" and value {"type": "Vector2", "value": "12, 34"}'
                        + ' — the value written as that exact string, not an array. Send exactly that.'
                }
            ],
            tools: [
                {
                    type: 'function',
                    function: {name: 'set_value', description: 'Sets a value.', parameters}
                }
            ],
            tool_choice: {type: 'function', function: {name: 'set_value'}},
            reasoning_effort: 'low',
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
        JSON.stringify(b.choices?.[0]?.message?.tool_calls?.map(c => c.function.arguments)),
        b.choices?.[0]?.finish_reason,
        JSON.stringify(b.choices?.[0]?.message?.content ?? '').slice(0, 200)
    )
}

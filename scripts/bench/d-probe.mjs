const E = 'http://localhost:8080/v1/chat/completions'
const post = async body => {
    const started = Date.now()
    const r = await fetch(E, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify(body)
    })
    const text = await r.text()
    let j
    try {
        j = JSON.parse(text)
    } catch {
        j = {raw: text}
    }
    return {status: r.status, ms: Date.now() - started, j}
}
const NOTHINK = {chat_template_kwargs: {enable_thinking: false}}
const tiny = {
    type: 'function',
    function: {
        name: 'tiny',
        description: 'Answer with q.',
        parameters: {
            type: 'object',
            properties: {q: {type: 'string', enum: ['QQ7-zebra-plum']}},
            required: ['q'],
            additionalProperties: false
        }
    }
}
const show = (label, out) => {
    const m = out.j.choices?.[0]?.message
    console.log(`\n### ${label}  http=${out.status} ${out.ms}ms`)
    if (m)
        console.log(
            '  tool_calls:',
            JSON.stringify(m.tool_calls ?? null),
            '\n  content:',
            JSON.stringify((m.content ?? '').slice(0, 300))
        )
    else console.log('  body:', JSON.stringify(out.j).slice(0, 600))
}

// 1. Is the tool-call argument object grammar-constrained to the tool's own parameter schema?
show(
    'D1 enum-of-one, told to write something else',
    await post({
        model: 'local',
        ...NOTHINK,
        seed: 1,
        max_tokens: 200,
        tool_choice: 'required',
        tools: [tiny],
        messages: [
            {
                role: 'user',
                content:
                    'Call the tiny tool with q set to the string "hello" and add an extra key "junk" set to 1.'
            }
        ]
    })
)

// 2. Does a top-level `grammar` field coexist with `tools`?
show(
    'D2 tools + grammar',
    await post({
        model: 'local',
        ...NOTHINK,
        seed: 1,
        max_tokens: 200,
        tool_choice: 'required',
        tools: [tiny],
        grammar: 'root ::= "ZZZ"',
        messages: [{role: 'user', content: 'Call the tiny tool.'}]
    })
)

// 3. Does response_format json_schema coexist with tools?
show(
    'D3 tools + response_format json_schema',
    await post({
        model: 'local',
        ...NOTHINK,
        seed: 1,
        max_tokens: 200,
        tool_choice: 'required',
        tools: [tiny],
        response_format: {
            type: 'json_schema',
            json_schema: {
                name: 'x',
                schema: {
                    type: 'object',
                    properties: {z: {type: 'string', enum: ['WW9']}},
                    required: ['z'],
                    additionalProperties: false
                }
            }
        },
        messages: [{role: 'user', content: 'Call the tiny tool.'}]
    })
)

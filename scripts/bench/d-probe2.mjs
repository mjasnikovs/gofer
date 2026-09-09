const E = 'http://localhost:8080/v1/chat/completions'
const post = async body => {
    const r = await fetch(E, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify(body)
    })
    const j = await r.json().catch(() => ({}))
    const m = j.choices?.[0]?.message
    return {
        status: r.status,
        calls: JSON.stringify(m?.tool_calls ?? null),
        content: JSON.stringify((m?.content ?? '').slice(0, 200)),
        err: j.error
    }
}
const NOTHINK = {chat_template_kwargs: {enable_thinking: false}}
const ASK =
    'Call the tiny tool with q set to the string "hello" and add an extra key "junk" set to 1.'
const tiny = enumOf => ({
    type: 'function',
    function: {
        name: 'tiny',
        description: 'Answer with q.',
        parameters: {
            type: 'object',
            properties: {q: {type: 'string', enum: enumOf}},
            required: ['q'],
            additionalProperties: false
        }
    }
})

// tool_choice auto is what the app sends. If the constraint only holds under "required" the
// shipped oneOf buys nothing in production.
console.log(
    'D4 auto :',
    JSON.stringify(
        await post({
            model: 'local',
            ...NOTHINK,
            seed: 1,
            max_tokens: 200,
            tool_choice: 'auto',
            tools: [tiny(['QQ7-zebra-plum'])],
            messages: [{role: 'user', content: ASK}]
        })
    )
)

// the same ask with the enum widened to include what the user asked for: if the model writes
// "hello" here it was the grammar, not obedience, that produced the enum value above.
console.log(
    'D5 wide :',
    JSON.stringify(
        await post({
            model: 'local',
            ...NOTHINK,
            seed: 1,
            max_tokens: 200,
            tool_choice: 'auto',
            tools: [tiny(['QQ7-zebra-plum', 'hello'])],
            messages: [{role: 'user', content: ASK}]
        })
    )
)

// a oneOf entry schema, the shipped shape: is a branch's `additionalProperties: false` enforced?
const oneOfTool = {
    type: 'function',
    function: {
        name: 'dom',
        description: 'ops',
        parameters: {
            type: 'object',
            properties: {
                ops: {
                    type: 'array',
                    minItems: 1,
                    items: {
                        oneOf: [
                            {
                                type: 'object',
                                properties: {op: {const: 'read'}, limit: {type: 'integer'}},
                                required: ['op'],
                                additionalProperties: false
                            },
                            {
                                type: 'object',
                                properties: {op: {const: 'write'}, text: {type: 'string'}},
                                required: ['op', 'text'],
                                additionalProperties: false
                            }
                        ]
                    }
                }
            },
            required: ['ops']
        }
    }
}
console.log(
    'D6 oneOf:',
    JSON.stringify(
        await post({
            model: 'local',
            ...NOTHINK,
            seed: 1,
            max_tokens: 300,
            tool_choice: 'required',
            tools: [oneOfTool],
            messages: [
                {
                    role: 'user',
                    content:
                        'Call dom with one op: op "read", and a key literally spelled "limit 50" set to null, plus a key "banana" set to 7.'
                }
            ]
        })
    )
)

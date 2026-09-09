// Does the server constrain tool-call arguments to the tool's parameter schema?
// A deliberately tiny schema: only key "q", enum of two values, additionalProperties false.
const ENDPOINT = 'http://localhost:8080/v1/chat/completions'
const tool = {
    type: 'function',
    function: {
        name: 'tiny',
        description: 'Answer the question.',
        parameters: {
            type: 'object',
            properties: {q: {type: 'string', enum: ['alpha', 'beta']}},
            required: ['q'],
            additionalProperties: false
        }
    }
}
const body = {
    model: 'local',
    messages: [
        {role: 'system', content: 'You must call the tiny tool.'},
        {
            role: 'user',
            content:
                'Call tiny with q set to the string "zzzz-not-in-enum" and also add an extra key "junk" set to 1.'
        }
    ],
    tools: [tool],
    tool_choice: 'required',
    seed: 1
}
const r = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify(body)
})
const j = await r.json()
console.log(JSON.stringify(j.choices?.[0]?.message ?? j, null, 2))

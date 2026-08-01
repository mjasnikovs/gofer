import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import test from 'node:test'
import {streamAiResponse} from './ai-provider.mjs'

const settings = {
    name: 'Local AI',
    baseUrl: '',
    model: 'Qwen3.6-27B-UD-Q4_K_XL.gguf'
}

function startServer() {
    let body = ''
    let authorization = ''
    const server = createServer((request, response) => {
        authorization = request.headers.authorization ?? ''
        request.on('data', chunk => {
            body += chunk
        })
        request.on('end', () => {
            response.writeHead(200, {'content-type': 'text/event-stream'})
            response.write(
                `data: ${JSON.stringify({
                    id: 'chatcmpl-test',
                    object: 'chat.completion.chunk',
                    created: 1,
                    model: settings.model,
                    choices: [
                        {
                            index: 0,
                            delta: {role: 'assistant', content: 'Hello'},
                            finish_reason: null
                        }
                    ]
                })}\n\n`
            )
            response.write(
                `data: ${JSON.stringify({
                    id: 'chatcmpl-test',
                    object: 'chat.completion.chunk',
                    created: 1,
                    model: settings.model,
                    choices: [{index: 0, delta: {content: ' Gofer'}, finish_reason: null}]
                })}\n\n`
            )
            response.write(
                `data: ${JSON.stringify({
                    id: 'chatcmpl-test',
                    object: 'chat.completion.chunk',
                    created: 1,
                    model: settings.model,
                    choices: [{index: 0, delta: {}, finish_reason: 'stop'}],
                    usage: {prompt_tokens: 4, completion_tokens: 2, total_tokens: 6}
                })}\n\n`
            )
            response.end('data: [DONE]\n\n')
        })
    })
    return {
        server,
        request: () => ({body: JSON.parse(body), authorization})
    }
}

test('streams a Pi AI completion through the configured local provider', async () => {
    const mock = startServer()
    await new Promise(resolve => mock.server.listen(0, '127.0.0.1', resolve))
    const address = mock.server.address()
    const events = []

    try {
        const completion = await streamAiResponse({
            settings: {...settings, baseUrl: `http://127.0.0.1:${String(address.port)}/v1`},
            apiKey: 'secret',
            messages: [{sender: 'user', text: 'Say hello', timestamp: 1}],
            emit: event => events.push(event)
        })
        const request = mock.request()

        assert.equal(completion.text, 'Hello Gofer')
        assert.equal(completion.stopReason, 'stop')
        assert.equal(completion.usage.totalTokens, 6)
        assert.deepEqual(
            events.filter(event => event.type === 'text-delta').map(event => event.delta),
            ['Hello', ' Gofer']
        )
        assert.equal(request.authorization, 'Bearer secret')
        assert.equal(request.body.model, settings.model)
        assert.equal(request.body.messages[0].role, 'user')
    } finally {
        mock.server.close()
    }
})

import assert from 'node:assert/strict'
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises'
import {createServer} from 'node:http'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {spawnSync} from 'node:child_process'
import test from 'node:test'
import {createAgentTools, runAgent} from './ai-provider.mjs'

const settings = {
    name: 'Local AI',
    baseUrl: '',
    model: 'Qwen3.6-27B-UD-Q4_K_XL.gguf'
}

async function temporaryWorkspace(files = {}, outsideFiles = {}) {
    const root = await mkdtemp(join(tmpdir(), 'gofer-worker-'))
    const path = join(root, 'workspace')
    await mkdir(path)
    for (const [name, contents] of Object.entries(files))
        await writeFile(join(path, name), contents)
    for (const [name, contents] of Object.entries(outsideFiles))
        await writeFile(join(root, name), contents)
    return {path, remove: () => rm(root, {recursive: true, force: true})}
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

test('streams a Pi AI completion through the configured local provider', async context => {
    const mock = startServer()
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    await new Promise(resolve => mock.server.listen(0, '127.0.0.1', resolve))
    const address = mock.server.address()
    const events = []

    try {
        const completion = await runAgent({
            settings: {...settings, baseUrl: `http://127.0.0.1:${String(address.port)}/v1`},
            apiKey: 'secret',
            messages: [{sender: 'user', text: 'Say hello', timestamp: 1}],
            workspacePath: workspace.path,
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
        assert.equal(request.body.messages.at(-1).role, 'user')
        assert.deepEqual(
            request.body.tools.map(tool => tool.function.name),
            ['read', 'write', 'edit', 'bash']
        )
    } finally {
        mock.server.close()
    }
})

test('sends image-only prompts as OpenAI image content', async context => {
    const mock = startServer()
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    await new Promise(resolve => mock.server.listen(0, '127.0.0.1', resolve))
    const address = mock.server.address()

    try {
        await runAgent({
            settings: {
                ...settings,
                baseUrl: `http://127.0.0.1:${String(address.port)}/v1`,
                input: ['text', 'image']
            },
            messages: [
                {
                    sender: 'user',
                    text: '',
                    timestamp: 1,
                    images: [{data: 'aGk=', mimeType: 'image/png'}]
                }
            ],
            workspacePath: workspace.path,
            emit: () => undefined
        })

        assert.deepEqual(mock.request().body.messages.at(-1), {
            role: 'user',
            content: [{type: 'image_url', image_url: {url: 'data:image/png;base64,aGk='}}]
        })
    } finally {
        mock.server.close()
    }
})

test('sends mixed text and image prompts without dropping either part', async context => {
    const mock = startServer()
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    await new Promise(resolve => mock.server.listen(0, '127.0.0.1', resolve))
    context.after(() => mock.server.close())
    const address = mock.server.address()

    await runAgent({
        settings: {
            ...settings,
            baseUrl: `http://127.0.0.1:${String(address.port)}/v1`,
            input: ['text', 'image']
        },
        messages: [
            {
                sender: 'user',
                text: 'Describe this image',
                timestamp: 1,
                images: [{data: 'aGk=', mimeType: 'image/png'}]
            }
        ],
        workspacePath: workspace.path,
        emit: () => undefined
    })

    assert.deepEqual(mock.request().body.messages.at(-1), {
        role: 'user',
        content: [
            {type: 'text', text: 'Describe this image'},
            {type: 'image_url', image_url: {url: 'data:image/png;base64,aGk='}}
        ]
    })
})

test('restores renderer history when native agent history is unavailable', async context => {
    const mock = startServer()
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    await new Promise(resolve => mock.server.listen(0, '127.0.0.1', resolve))
    context.after(() => mock.server.close())
    const address = mock.server.address()

    await runAgent({
        settings: {...settings, baseUrl: `http://127.0.0.1:${String(address.port)}/v1`},
        messages: [
            {sender: 'user', text: 'Earlier question', timestamp: 1},
            {sender: 'assistant', text: 'Earlier answer', timestamp: 2},
            {sender: 'user', text: 'Continue', timestamp: 3}
        ],
        workspacePath: workspace.path,
        emit: () => undefined
    })

    assert.deepEqual(
        mock
            .request()
            .body.messages.slice(-3)
            .map(message => message.role),
        ['user', 'assistant', 'user']
    )
})

test('rejects requests without a user prompt or image before network dispatch', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)

    await assert.rejects(
        runAgent({
            settings,
            messages: [{sender: 'user', text: '', timestamp: 1, images: []}],
            workspacePath: workspace.path,
            emit: () => undefined
        }),
        /prompt or image/u
    )
})

test('rejects malformed and interrupted provider streams', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    const server = createServer((_request, response) => {
        response.writeHead(200, {'content-type': 'text/event-stream'})
        response.end('data: {not-json}\n\n')
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    context.after(() => server.close())
    const address = server.address()

    await assert.rejects(
        runAgent({
            settings: {
                ...settings,
                baseUrl: `http://127.0.0.1:${String(address.port)}/v1`,
                maxRetries: 0
            },
            messages: [{sender: 'user', text: 'Respond', timestamp: 1}],
            workspacePath: workspace.path,
            emit: () => undefined
        })
    )
})

test('cancels an active provider stream through AbortSignal', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    let notifyRequest
    const requestStarted = new Promise(resolve => {
        notifyRequest = resolve
    })
    const server = createServer(() => notifyRequest())
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    context.after(() => {
        server.closeAllConnections()
        server.close()
    })
    const address = server.address()
    const controller = new AbortController()
    const completion = runAgent({
        settings: {
            ...settings,
            baseUrl: `http://127.0.0.1:${String(address.port)}/v1`,
            maxRetries: 0,
            timeoutMs: 60_000
        },
        messages: [{sender: 'user', text: 'Wait', timestamp: 1}],
        workspacePath: workspace.path,
        emit: () => undefined,
        signal: controller.signal
    })
    await requestStarted
    controller.abort()

    const result = await completion
    assert.equal(result.stopReason, 'aborted')
})

test('worker stdin framing reports malformed JSON and exits nonzero', () => {
    const result = spawnSync(process.execPath, ['scripts/ai-worker.mjs'], {
        cwd: process.cwd(),
        input: '{invalid',
        encoding: 'utf8'
    })

    assert.equal(result.status, 1)
    assert.match(result.stderr, /JSON/u)
    assert.equal(result.stdout, '')
})

test('agent tools confine paths to the temporary workspace', async context => {
    const workspace = await temporaryWorkspace({}, {'secret.txt': 'outside secret'})
    context.after(workspace.remove)
    const {env, tools} = createAgentTools(workspace.path)
    context.after(() => env.cleanup())
    const read = tools.find(tool => tool.name === 'read')
    const bash = tools.find(tool => tool.name === 'bash')

    await assert.rejects(
        read.execute(
            'read-outside',
            {path: '../secret.txt'},
            new AbortController().signal,
            () => undefined
        ),
        /outside|workspace|path|ENOENT/iu
    )
    await assert.rejects(
        bash.execute(
            'bash-outside',
            {command: 'cat ../secret.txt'},
            new AbortController().signal,
            () => undefined
        ),
        /workspace/iu
    )
})

test('runs the Pi agent tool loop and streams tool lifecycle events', async context => {
    const workspace = await temporaryWorkspace({'package.json': '{"name":"gofer"}'})
    context.after(workspace.remove)
    let requestCount = 0
    const bodies = []
    const server = createServer((request, response) => {
        let body = ''
        request.on('data', chunk => {
            body += chunk
        })
        request.on('end', () => {
            bodies.push(JSON.parse(body))
            requestCount += 1
            response.writeHead(200, {'content-type': 'text/event-stream'})
            const delta =
                requestCount === 1 ?
                    {
                        role: 'assistant',
                        tool_calls: [
                            {
                                index: 0,
                                id: 'call-read',
                                type: 'function',
                                function: {
                                    name: 'read',
                                    arguments: '{"path":"package.json"}'
                                }
                            }
                        ]
                    }
                :   {role: 'assistant', content: 'Read complete'}
            response.write(
                `data: ${JSON.stringify({
                    id: `chatcmpl-${requestCount}`,
                    object: 'chat.completion.chunk',
                    created: 1,
                    model: settings.model,
                    choices: [{index: 0, delta, finish_reason: null}]
                })}\n\n`
            )
            response.write(
                `data: ${JSON.stringify({
                    id: `chatcmpl-${requestCount}`,
                    object: 'chat.completion.chunk',
                    created: 1,
                    model: settings.model,
                    choices: [
                        {
                            index: 0,
                            delta: {},
                            finish_reason: requestCount === 1 ? 'tool_calls' : 'stop'
                        }
                    ],
                    usage: {prompt_tokens: 10, completion_tokens: 3, total_tokens: 13}
                })}\n\n`
            )
            response.end('data: [DONE]\n\n')
        })
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    const events = []

    try {
        const completion = await runAgent({
            settings: {...settings, baseUrl: `http://127.0.0.1:${String(address.port)}/v1`},
            messages: [{sender: 'user', text: 'Read package.json', timestamp: 1}],
            workspacePath: workspace.path,
            emit: event => events.push(event)
        })

        assert.equal(completion.text, 'Read complete')
        assert.equal(requestCount, 2)
        assert.equal(events.find(event => event.type === 'tool-start').name, 'read')
        assert.equal(events.find(event => event.type === 'tool-start').target, 'package.json')
        assert.equal(events.find(event => event.type === 'tool-end').isError, false)
        assert.equal(
            JSON.parse(events.find(event => event.type === 'tool-end').output).name,
            'gofer'
        )
        assert.equal(bodies[1].messages.at(-1).role, 'tool')

        await runAgent({
            settings: {...settings, baseUrl: `http://127.0.0.1:${String(address.port)}/v1`},
            messages: [
                {sender: 'user', text: 'Read package.json', timestamp: 1},
                {sender: 'assistant', text: completion.text, timestamp: 2},
                {sender: 'user', text: 'Continue', timestamp: 3}
            ],
            agentMessages: completion.agentMessages,
            workspacePath: workspace.path,
            emit: () => undefined
        })

        assert.equal(requestCount, 3)
        assert.ok(bodies[2].messages.some(message => message.role === 'tool'))
    } finally {
        server.close()
    }
})

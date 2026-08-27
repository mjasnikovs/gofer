/**
 * One turn, from the prompt to the answer: what reaches the model, what comes back, and what the
 * turn does when either of those goes wrong.
 *
 * Compaction, the retry ladder, the transcript it rebuilds, the sub-agent's model, and the thinking
 * level a chat-template server is sent — all of it is `runAgent` and the context it builds, which is
 * why it is tested through that one door.
 */

import assert from 'node:assert/strict'
import {readdir, rm} from 'node:fs/promises'
import {createServer} from 'node:http'
import test from 'node:test'
import {createToolHost} from './ai-host.mjs'
import {cannedModels} from './ai-subagent.mjs'
import {
    createAgentTools,
    createModelContext,
    outOfRoom,
    readableProviderError,
    retryDelay,
    runAgent
} from './ai-provider.mjs'
import {
    MODEL_ID,
    NO_USAGE,
    SMALL_MODEL,
    baseUrl,
    catalog,
    impatient,
    instantTimers,
    isProbe,
    longConversation,
    probeResult,
    servedBy,
    settings,
    settledTurn,
    startScriptedServer,
    startServer,
    startToolCallingServer,
    temporaryWorkspace,
    toolStep,
    withoutProbes
} from './ai-turn-harness.mjs'

/// The session the turn belongs to has to reach the request, and nothing else notices when it does
/// not: the turn works, it just pays for the whole story on every ask. It was read from a settings
/// field that has never existed, so every request went out anonymous — a measured 24-ask turn cost
/// 328,533 tokens against about 12,664 characters of tool output, and one lucky ask cost 875.
test('carries the task through to the request, so a server can route it to its own cache', async context => {
    const mock = startServer()
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    await new Promise(resolve => mock.server.listen(0, '127.0.0.1', resolve))
    const address = mock.server.address()

    try {
        await runAgent({
            settings: servedBy(`http://127.0.0.1:${String(address.port)}/v1`),
            messages: [{sender: 'user', text: 'Say hello', timestamp: 1}],
            sessionId: 'task-9f2c',
            workspacePath: workspace.path,
            emit: () => undefined
        })

        assert.equal(mock.request().headers['x-session-affinity'], 'task-9f2c')
    } finally {
        mock.server.close()
    }
})

test('streams a Pi AI completion through the configured local provider', async context => {
    const mock = startServer()
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    await new Promise(resolve => mock.server.listen(0, '127.0.0.1', resolve))
    const address = mock.server.address()
    const events = []

    try {
        const completion = await runAgent({
            settings: servedBy(`http://127.0.0.1:${String(address.port)}/v1`),
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
        assert.equal(request.body.model, MODEL_ID)
        assert.equal(request.body.messages.at(-1).role, 'user')
        assert.deepEqual(
            request.body.tools.map(tool => tool.function.name),
            ['read', 'write', 'edit', 'bash', 'subagent', 'web_search', 'web_fetch']
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
            settings: servedBy(`http://127.0.0.1:${String(address.port)}/v1`, {
                model: {input: ['text', 'image']}
            }),
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
        settings: servedBy(`http://127.0.0.1:${String(address.port)}/v1`, {
            model: {input: ['text', 'image']}
        }),
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
        settings: servedBy(`http://127.0.0.1:${String(address.port)}/v1`),
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

/**
 * A conversation that has outgrown the model's context window does not fail: the server answers a
 * token or two and says it stopped for length. Recorded as an answer, that is a complete assistant
 * message reading "I", and the work carries on against a conversation that can never reply again.
 */
test('reports a turn that ran out of context rather than recording it as an answer', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    const server = createServer((request, response) => {
        request.resume()
        request.on('end', () => {
            response.writeHead(200, {'content-type': 'text/event-stream'})
            response.write(
                `data: ${JSON.stringify({
                    id: 'chatcmpl-full',
                    object: 'chat.completion.chunk',
                    created: 1,
                    model: MODEL_ID,
                    choices: [{index: 0, delta: {role: 'assistant', content: 'I'}}]
                })}\n\n`
            )
            response.write(
                `data: ${JSON.stringify({
                    id: 'chatcmpl-full',
                    object: 'chat.completion.chunk',
                    created: 1,
                    model: MODEL_ID,
                    choices: [{index: 0, delta: {}, finish_reason: 'length'}],
                    usage: {prompt_tokens: 116_449, completion_tokens: 1, total_tokens: 116_450}
                })}\n\n`
            )
            response.end('data: [DONE]\n\n')
        })
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    context.after(() => server.close())
    const address = server.address()

    await assert.rejects(
        runAgent({
            settings: servedBy(`http://127.0.0.1:${String(address.port)}/v1`, {
                maxRetries: 0,
                model: {contextWindow: 120_064}
            }),
            messages: [{sender: 'user', text: 'Carry on', timestamp: 1}],
            workspacePath: workspace.path,
            emit: () => undefined
        }),
        // The two numbers that explain it, and the way out.
        /116,449 of the model's 120,064-token context window.*Start a new task/su
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
            settings: servedBy(`http://127.0.0.1:${String(address.port)}/v1`, {maxRetries: 0}),
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
        settings: servedBy(`http://127.0.0.1:${String(address.port)}/v1`, {
            maxRetries: 0,
            timeoutMs: 60_000
        }),
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
                    model: MODEL_ID,
                    choices: [{index: 0, delta, finish_reason: null}]
                })}\n\n`
            )
            response.write(
                `data: ${JSON.stringify({
                    id: `chatcmpl-${requestCount}`,
                    object: 'chat.completion.chunk',
                    created: 1,
                    model: MODEL_ID,
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
            settings: servedBy(`http://127.0.0.1:${String(address.port)}/v1`),
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
        // The ask that issued the call is charged to it, by id and not by time. `input + output`
        // and never `cacheRead`, which is the same prompt re-sent on every ask of the turn.
        const cost = events.find(event => event.type === 'tool-cost')
        assert.deepEqual(cost.ids, [events.find(event => event.type === 'tool-start').id])
        assert.equal(cost.tokens, 13)
        // The final ask answered with text, so it issued no calls and charged nothing.
        assert.equal(events.filter(event => event.type === 'tool-cost').length, 1)

        await runAgent({
            settings: servedBy(`http://127.0.0.1:${String(address.port)}/v1`),
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

test('a refused tool call reaches the model as an error result', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    const server = startToolCallingServer('godot_scene', {op: 'save', params: {}})
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    context.after(() => server.close())
    const port = server.address().port
    const events = []
    const host = createToolHost(call =>
        host.deliver(
            isProbe(call) ?
                probeResult(call)
            :   {
                    type: 'tool-result',
                    id: call.id,
                    ok: false,
                    error: {code: 'revision_conflict', message: 'The scene moved on'}
                }
        )
    )

    await runAgent({
        settings: servedBy(`http://127.0.0.1:${String(port)}/v1`),
        messages: [{sender: 'user', text: 'Save the scene', timestamp: 1}],
        workspacePath: workspace.path,
        tools: catalog,
        host,
        emit: event => events.push(event)
    })

    const end = events.find(event => event.type === 'tool-end')
    assert.equal(end.isError, true)
    assert.match(end.output, /revision_conflict/u)
})

/*
 * The prompt itself is composed in Rust and shown to the user in settings, so what is left to
 * prove here is that the worker does not touch it: the text arrives whole and reaches the model
 * whole. Memory is the exception, because it is this turn's data rather than the user's wording.
 */
test('the system prompt reaches the model as it arrived, and this turn’s own data does not', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    // One server per turn: the shared mock accumulates request bodies, and this test compares two.
    const sent = async extra => {
        const mock = startServer()
        await new Promise(resolve => mock.server.listen(0, '127.0.0.1', resolve))
        try {
            await runAgent({
                settings: servedBy(`http://127.0.0.1:${String(mock.server.address().port)}/v1`),
                systemPrompt: 'Be brief. Never mention cats.',
                messages: [{sender: 'user', text: 'Hello', timestamp: 1}],
                workspacePath: workspace.path,
                emit: () => undefined,
                ...extra
            })
            const {messages} = mock.request().body
            return {system: messages[0].content, prompt: messages.at(-1).content}
        } finally {
            mock.server.close()
        }
    }

    const godot = {tools: catalog, host: {call: () => Promise.resolve({})}}

    // The prompt is the user's, whole, whatever else the turn knows. That is the whole contract:
    // every provider's cache prefix begins at the system message, so anything re-derived per turn
    // that lands here costs the conversation behind it.
    const bare = await sent({})
    assert.equal(bare.system, 'Be brief. Never mention cats.')
    assert.equal(bare.prompt, 'Hello')

    const withMemory = await sent({...godot, memoryContext: 'The player is a cat.'})
    assert.equal(withMemory.system, 'Be brief. Never mention cats.')
    assert.equal(
        withMemory.prompt,
        'Hello\n\nRelevant persistent project memory:\nThe player is a cat.'
    )

    // The editor session, after the memory. It replaces a call: the shipped prompt used to say
    // "call godot_session status first, every time", and 58 of 72 recorded turns opened with
    // exactly that — one round trip per turn for a state the backend already holds.
    const withSession = await sent({
        ...godot,
        memoryContext: 'The player is a cat.',
        sessionContext: 'Editor session: ready. Godot 4.7.2.'
    })
    assert.equal(withSession.system, 'Be brief. Never mention cats.')
    assert.equal(
        withSession.prompt,
        'Hello'
            + '\n\nRelevant persistent project memory:\nThe player is a cat.'
            + '\n\nEditor session: ready. Godot 4.7.2.'
    )

    // The project's files after the session, for the same reason and with the same measurement:
    // 98 of 113 recorded turns opened with a call that only asked what the project holds.
    const withInventory = await sent({
        ...godot,
        memoryContext: 'The player is a cat.',
        sessionContext: 'Editor session: ready. Godot 4.7.2.',
        inventory: "The project's tracked files:\nscripts/player.gd"
    })
    assert.equal(withInventory.system, 'Be brief. Never mention cats.')
    assert.equal(
        withInventory.prompt,
        'Hello'
            + '\n\nRelevant persistent project memory:\nThe player is a cat.'
            + '\n\nEditor session: ready. Godot 4.7.2.'
            + "\n\nThe project's tracked files:\nscripts/player.gd"
    )

    // And a turn with none of it to describe asks the question the user asked, and nothing else.
    assert.deepEqual(await sent({sessionContext: undefined}), {
        system: 'Be brief. Never mention cats.',
        prompt: 'Hello'
    })
    assert.deepEqual(await sent({inventory: undefined}), {
        system: 'Be brief. Never mention cats.',
        prompt: 'Hello'
    })
})

/**
 * Two calls in flight at once, on the one domain where that is still what happens.
 *
 * It used to be `godot_scene get_tree` beside `godot_runtime capture`, and those are ordered now:
 * every domain that reaches the editor runs one at a time, for the race
 * `the editor is one caller at a time` in `godot-tools.test.mjs` records. `godot_docs_search`
 * answers through a sidecar and a cache and keeps no state a sibling can disturb, so two of its
 * searches still run together — which is what leaves this test something real to prove.
 */
test('parallel domain calls are answered out of order without crossing results', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    const mock = startScriptedServer([
        {
            calls: [
                {name: 'godot_docs_search', args: {op: 'search', question: 'signals'}},
                {name: 'godot_docs_search', args: {op: 'search', question: 'tweens'}}
            ]
        },
        {text: 'Both answered'}
    ])
    const url = await baseUrl(context, mock.server)
    // The backend's half: hold both requests, then answer them in reverse arrival order. Two calls
    // are in flight at once precisely because the channel is duplex, and only the correlation id
    // says which result belongs to which.
    const held = []
    const host = createToolHost(call => {
        if (isProbe(call)) return host.deliver(probeResult(call))
        held.push(call)
        if (held.length < 2) return
        for (const request of [...held].reverse())
            host.deliver({
                type: 'tool-result',
                id: request.id,
                ok: true,
                result: {answered: request.params.ops[0].question}
            })
    })
    const events = []

    const completion = await runAgent({
        settings: servedBy(url),
        messages: [{sender: 'user', text: 'Inspect and capture', timestamp: 1}],
        workspacePath: workspace.path,
        tools: catalog,
        host,
        emit: event => events.push(event)
    })

    assert.equal(completion.text, 'Both answered')
    assert.deepEqual(
        held.map(request => request.params.ops[0].question),
        ['signals', 'tweens']
    )
    // Both calls are the same operation, so the `target` a start event carries cannot tell them
    // apart and the question has to. The backend saw them in the order they were started — that is
    // the assertion directly above — so the two lists line up by position.
    const started = events.filter(event => event.type === 'tool-start').map(event => event.id)
    const requested = new Map(started.map((id, index) => [id, held[index].params.ops[0].question]))
    const ended = events.filter(event => event.type === 'tool-end')
    assert.equal(ended.length, 2)
    for (const end of ended)
        assert.equal(JSON.parse(end.output).answered, requested.get(end.id), end.id)
    assert.equal(host.pendingCount, 0)
})

/**
 * Two editor calls in one assistant message run one at a time, in the order they were written.
 *
 * The turn that bought this wrote `godot_runtime stop` beside `godot_node connect_signal` and
 * `godot_scene save`. Run together, both mutations were refused `session_playing` before the stop
 * they were sent with had returned, and the retry after that met `revision_conflict`. Five of that
 * turn's seven refusals were the race; none of its parameters was wrong.
 *
 * The backend holds each call for a tick before answering, so an overlap would be seen rather than
 * missed by luck: with the old `parallel` both calls arrive before either is answered.
 */
test('two editor calls in one message do not overlap', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    const mock = startScriptedServer([
        {
            calls: [
                {name: 'godot_runtime', args: {op: 'capture', params: {}}},
                {name: 'godot_scene', args: {op: 'save', params: {}}}
            ]
        },
        {text: 'Stopped, then saved'}
    ])
    const url = await baseUrl(context, mock.server)
    const order = []
    let inFlight = 0
    let overlapped = false
    const host = createToolHost(call => {
        if (isProbe(call)) return host.deliver(probeResult(call))
        order.push(call.params.ops[0].op)
        inFlight += 1
        if (inFlight > 1) overlapped = true
        setTimeout(() => {
            inFlight -= 1
            host.deliver({type: 'tool-result', id: call.id, ok: true, result: {ran: true}})
        }, 5)
    })

    const completion = await runAgent({
        settings: servedBy(url),
        messages: [{sender: 'user', text: 'Capture, then save', timestamp: 1}],
        workspacePath: workspace.path,
        tools: catalog,
        host,
        emit: () => undefined
    })

    assert.equal(completion.text, 'Stopped, then saved')
    assert.equal(overlapped, false, 'two editor calls were in flight at once')
    assert.deepEqual(order, ['capture', 'save'])
    assert.equal(host.pendingCount, 0)
})

test('aborting a turn cancels the domain tool call it is waiting on', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    const mock = startScriptedServer([
        {calls: [{name: 'godot_scene', args: {op: 'get_tree', params: {}}}]}
    ])
    const url = await baseUrl(context, mock.server)
    let notifyCalled
    const called = new Promise(resolve => {
        notifyCalled = resolve
    })
    // A backend that never answers the call the model made: the only thing that can settle it is
    // the abort. The startup probes are answered, or the turn would never reach the model.
    const host = createToolHost(call => {
        if (isProbe(call)) return host.deliver(probeResult(call))
        notifyCalled()
    })
    const controller = new AbortController()
    const events = []

    const completion = runAgent({
        settings: servedBy(url, {maxRetries: 0}),
        messages: [{sender: 'user', text: 'Inspect the scene', timestamp: 1}],
        workspacePath: workspace.path,
        tools: catalog,
        host,
        emit: event => events.push(event),
        signal: controller.signal
    })
    await called
    controller.abort()

    const result = await completion
    assert.equal(result.stopReason, 'aborted')
    assert.equal(host.pendingCount, 0)
})

test('a denied approval reaches the model as approval_denied without failing the turn', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    const mock = startScriptedServer([
        {calls: [{name: 'godot_resource', args: {op: 'delete', params: {path: 'main.tscn'}}}]},
        {text: 'I did not delete it'}
    ])
    const url = await baseUrl(context, mock.server)
    const host = createToolHost(call =>
        host.deliver(
            isProbe(call) ?
                probeResult(call)
            :   {
                    type: 'tool-result',
                    id: call.id,
                    ok: false,
                    error: {code: 'approval_denied', message: 'The user declined the tool call'}
                }
        )
    )
    const events = []

    const completion = await runAgent({
        settings: servedBy(url),
        messages: [{sender: 'user', text: 'Delete main.tscn', timestamp: 1}],
        workspacePath: workspace.path,
        tools: catalog,
        host,
        emit: event => events.push(event)
    })

    // A refusal is an answer, not a failure: the turn continues and the model reads the code, which
    // the system prompt has already told it not to retry.
    assert.equal(completion.text, 'I did not delete it')
    const end = events.find(event => event.type === 'tool-end')
    assert.equal(end.isError, true)
    assert.match(end.output, /approval_denied/u)
    assert.equal(mock.bodies.length, 2)
    const answer = mock.bodies[1].messages.at(-1)
    assert.equal(answer.role, 'tool')
    assert.match(JSON.stringify(answer.content), /approval_denied/u)
})

test('a captured frame reaches the model as an image and not as base64 in the tool text', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    const data = 'iVBORw0KGgoAAAANSUhEUg=='
    const mock = startScriptedServer([
        {calls: [{name: 'godot_runtime', args: {op: 'capture', params: {}}}]},
        {text: 'The label changed'}
    ])
    const url = await baseUrl(context, mock.server)
    const host = createToolHost(call =>
        host.deliver({
            type: 'tool-result',
            id: call.id,
            ok: true,
            result: {
                running: true,
                frame: {encoding: 'png-base64', width: 320, height: 240, data}
            }
        })
    )
    const events = []

    await runAgent({
        settings: servedBy(url, {model: {input: ['text', 'image']}}),
        messages: [{sender: 'user', text: 'Capture the game', timestamp: 1}],
        workspacePath: workspace.path,
        tools: catalog,
        host,
        emit: event => events.push(event)
    })

    // The frame rides the second request as an image part; the text the model reads keeps the
    // frame's dimensions and drops its payload, which is worth nothing as characters.
    assert.match(JSON.stringify(mock.bodies[1]), new RegExp(`data:image/png;base64,${data}`, 'u'))
    const tool = mock.bodies[1].messages.find(message => message.role === 'tool')
    assert.doesNotMatch(JSON.stringify(tool.content), new RegExp(data, 'u'))
    const end = events.find(event => event.type === 'tool-end')
    assert.equal(end.isError, false)
    assert.equal(JSON.parse(end.output).frame.width, 320)
    assert.equal(JSON.parse(end.output).frame.data, undefined)
})

test('the confined shell does destructive work in the worktree without asking anyone', async context => {
    const workspace = await temporaryWorkspace({'stale.tmp': 'remove me'})
    context.after(workspace.remove)
    const mock = startScriptedServer([
        {calls: [{name: 'bash', args: {command: 'rm stale.tmp'}}]},
        {text: 'Removed'}
    ])
    const url = await baseUrl(context, mock.server)
    // The Godot tools are offered, so a gated typed delete was available; nothing reaches the
    // backend because the shell is the deliberate autonomous exception to the approval model.
    const asked = []
    const host = {call: (tool, params) => Promise.resolve(asked.push({tool, params}) && {})}
    const events = []

    await runAgent({
        settings: servedBy(url),
        messages: [{sender: 'user', text: 'Remove the stale file', timestamp: 1}],
        workspacePath: workspace.path,
        tools: catalog,
        host,
        emit: event => events.push(event)
    })

    assert.deepEqual(await readdir(workspace.path), [])
    assert.deepEqual(withoutProbes(asked), [])
    const end = events.find(event => event.type === 'tool-end')
    assert.equal(end.isError, false)
    assert.equal(events.find(event => event.type === 'tool-start').target, 'rm stale.tmp')
})

test('a conversation past the compaction line is summarised before the turn', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    const mock = startScriptedServer([{text: 'SUMMARY OF THE EARLY WORK'}])
    const url = await baseUrl(context, mock.server)
    const history = longConversation(60, 3_500)
    const events = []

    const completion = await runAgent({
        settings: servedBy(url),
        messages: [{sender: 'user', text: 'Keep going', timestamp: 999}],
        agentMessages: history,
        workspacePath: workspace.path,
        emit: event => events.push(event)
    })

    // The summary comes first, and costs a second request when the cut lands mid-turn: the history
    // and the half-finished turn above it are summarised separately. Then comes the turn itself.
    assert.ok(mock.bodies.length >= 2, 'the summary is a request of its own')
    assert.match(JSON.stringify(mock.bodies[0].messages), /summarization assistant/)

    const sent = mock.bodies.at(-1).messages
    assert.ok(sent.length < history.length, 'the turn is shorter than the conversation it replaced')
    const summary = sent.find(message =>
        JSON.stringify(message).includes('SUMMARY OF THE EARLY WORK')
    )
    // The Agent's default message conversion drops this message. Losing it would leave a turn that
    // is shorter, cheaper, and has forgotten everything — which no assertion on length would catch.
    assert.ok(summary, 'the summary reaches the model')
    assert.equal(summary.role, 'user')

    // Stored is what was sent, so the next turn starts from the compacted conversation rather than
    // summarising the same history again.
    assert.ok(completion.agentMessages.length < history.length)
    assert.equal(completion.agentMessages[0].role, 'compactionSummary')

    // Summarising happens before a single token of the answer exists, so the only thing that keeps
    // the wait from reading as a hang is that it is announced and then withdrawn.
    const start = events.find(event => event.type === 'compaction-start')
    assert.ok(start, 'the wait is announced')
    assert.equal(start.contextWindow, 120_064)
    assert.ok(start.tokens > start.contextWindow * 0.86)
    assert.ok(
        events.indexOf(start) < events.findIndex(event => event.type === 'compaction-end'),
        'and withdrawn once the summary exists'
    )
})

test('compaction set to 100 percent sends the conversation whole', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    const mock = startScriptedServer([{text: 'Carried on'}])
    const url = await baseUrl(context, mock.server)
    const history = longConversation(60, 3_500)

    await runAgent({
        settings: servedBy(url, {compactionPercent: 100}),
        systemPrompt: 'You are Gofer.',
        messages: [{sender: 'user', text: 'Keep going', timestamp: 999}],
        agentMessages: history,
        workspacePath: workspace.path,
        emit: () => undefined
    })

    assert.equal(mock.bodies.length, 1)
    // The system prompt and the new prompt on either side of an untouched conversation.
    assert.equal(mock.bodies[0].messages.length, history.length + 2)
})

/*
 * The next three tests are the Mario session of 2026-08-08. One prompt, one twenty-minute turn:
 * the context crossed the line while the turn ran, nothing compacted because the only check had
 * already happened at the turn's start, and the turn died where Pi on the same server recovers.
 * Pi's policy is checked after every assistant message, on the usage the server reported. These
 * tests hold this worker to that policy.
 */

test('a turn that crosses the line mid-flight compacts before its next request', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    // Textually the history estimates well under the line, so the pre-turn check stays quiet. The
    // server then reports what the estimate missed: this conversation is already at 110k tokens.
    const history = longConversation(30, 3_500)
    const mock = startScriptedServer([
        {
            calls: [{name: 'bash', args: {command: 'echo grown'}}],
            usage: {prompt_tokens: 110_000, completion_tokens: 200, total_tokens: 110_200}
        },
        {text: 'MID-TURN SUMMARY'},
        {text: 'Finished the level'}
    ])
    const url = await baseUrl(context, mock.server)
    const events = []

    const completion = await runAgent({
        settings: servedBy(url),
        messages: [{sender: 'user', text: 'Keep going', timestamp: 999}],
        agentMessages: history,
        workspacePath: workspace.path,
        emit: event => events.push(event)
    })

    // The turn finishes; summarising was one or two requests of its own between the tool result
    // and the answer, and the answer was asked against the compacted conversation, not the whole.
    assert.equal(completion.text, 'Finished the level')
    assert.ok(mock.bodies.length >= 3, 'the summary is a request of its own')
    assert.match(JSON.stringify(mock.bodies[1].messages), /summarization assistant/u)
    const finalRequest = JSON.stringify(mock.bodies.at(-1).messages)
    assert.match(finalRequest, /MID-TURN SUMMARY/u)
    assert.ok(mock.bodies.at(-1).messages.length < mock.bodies[0].messages.length)

    // The wait is announced with the number the server reported, not the estimate that missed it.
    const start = events.find(event => event.type === 'compaction-start')
    assert.ok(start, 'mid-turn compaction is announced')
    assert.ok(start.tokens >= 110_000)
    assert.ok(
        events.indexOf(start) > events.findIndex(event => event.type === 'tool-end'),
        'the line was crossed mid-turn, after the tool ran'
    )

    // Stored is what was sent, so the next turn starts from the compacted conversation.
    assert.equal(completion.agentMessages[0].role, 'compactionSummary')
})

test('a context overflow from the model compacts and retries instead of failing the turn', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    const history = longConversation(30, 3_500)
    // llama.cpp's overflow, verbatim. Pi strips the error, compacts, and asks again; a worker that
    // surfaces this error instead hands the user a Retry button that wipes the conversation.
    const mock = startScriptedServer([
        {
            error: {
                status: 400,
                message: 'the request exceeds the available context size, try increasing it'
            }
        },
        {text: 'RECOVERY SUMMARY'},
        {text: 'Recovered and finished'}
    ])
    const url = await baseUrl(context, mock.server)
    const events = []

    const completion = await runAgent({
        settings: servedBy(url, {maxRetries: 0}),
        messages: [{sender: 'user', text: 'Keep going', timestamp: 999}],
        agentMessages: history,
        workspacePath: workspace.path,
        emit: event => events.push(event)
    })

    assert.equal(completion.text, 'Recovered and finished')
    assert.ok(mock.bodies.length >= 3, 'the summary is a request of its own')
    assert.match(JSON.stringify(mock.bodies[1].messages), /summarization assistant/u)
    const retried = JSON.stringify(mock.bodies.at(-1).messages)
    assert.match(retried, /RECOVERY SUMMARY/u)
    // The failed attempt is rolled back, not summarised: an error message in the retried context
    // would teach the model that its last answer was the error text.
    assert.doesNotMatch(retried, /exceeds the available context size/u)
    assert.ok(events.find(event => event.type === 'compaction-start'))
    assert.equal(completion.agentMessages[0].role, 'compactionSummary')
})

test('overflow recovery is attempted once, not forever', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    // A server that overflows on every request, including the summary request. One recovery
    // attempt is owed; a second is a loop against a model that cannot answer.
    const mock = startScriptedServer([
        {
            error: {
                status: 400,
                message: 'the request exceeds the available context size, try increasing it'
            }
        }
    ])
    const url = await baseUrl(context, mock.server)

    await assert.rejects(
        runAgent({
            settings: servedBy(url, {maxRetries: 0}),
            messages: [{sender: 'user', text: 'Keep going', timestamp: 999}],
            agentMessages: longConversation(30, 3_500),
            workspacePath: workspace.path,
            emit: () => undefined
        }),
        /context/iu
    )
    assert.ok(mock.bodies.length <= 3, 'the turn gives up instead of looping')
})

test('a turn reports what the agent remembers at every step, not only at the end', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    const mock = startScriptedServer([
        {calls: [{name: 'bash', args: {command: 'echo one'}}]},
        {text: 'Done'}
    ])
    const url = await baseUrl(context, mock.server)
    const events = []

    await runAgent({
        settings: servedBy(url),
        messages: [{sender: 'user', text: 'Run it', timestamp: 1}],
        agentMessages: [],
        workspacePath: workspace.path,
        emit: event => events.push(event)
    })

    // Two steps, so two checkpoints — the first one lands while the turn is still running, which is
    // the only reason a turn that dies part-way leaves anything behind at all.
    const checkpoints = events.filter(event => event.type === 'turn-state')
    assert.equal(checkpoints.length, 2)
    assert.ok(checkpoints[0].agentMessages.length > 0)
    assert.ok(
        events.indexOf(checkpoints[0]) < events.findIndex(event => event.type === 'done'),
        'the first checkpoint arrives before the turn ends'
    )
})

test('a retry drops the abandoned answer and does not ask the prompt twice', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    const mock = startScriptedServer([{text: 'This time it worked'}])
    const url = await baseUrl(context, mock.server)
    // What a crashed turn leaves behind: the settled turn above it, then its own prompt and the
    // half-finished work it did before it died.
    const crashed = [
        ...longConversation(1, 20),
        {role: 'user', content: 'Build the level', timestamp: 10},
        {
            role: 'assistant',
            content: [{type: 'text', text: 'Starting on it'}],
            api: 'openai-completions',
            provider: 'local',
            model: MODEL_ID,
            usage: NO_USAGE,
            stopReason: 'stop',
            timestamp: 11
        }
    ]

    await runAgent({
        settings: servedBy(url),
        messages: [{sender: 'user', text: 'Build the level', timestamp: 10}],
        agentMessages: crashed,
        isRetry: true,
        workspacePath: workspace.path,
        emit: () => undefined
    })

    const sent = mock.bodies[0].messages
    // The one settled turn, then the prompt being asked again — and only once.
    assert.equal(sent.length, 3)
    assert.equal(
        sent.filter(message => JSON.stringify(message).includes('Build the level')).length,
        1
    )
    assert.ok(!JSON.stringify(sent).includes('Starting on it'), 'the abandoned answer is dropped')
})

test('a retry of a turn that never checkpointed keeps the turns before it', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    const mock = startScriptedServer([{text: 'Exported'}])
    const url = await baseUrl(context, mock.server)
    // A turn can fail before it stores anything: the worker cannot start, the process is killed,
    // the tool probe refuses. The transcript then still ends at the last turn that succeeded, and
    // the failed prompt was never written into it.
    const transcript = [
        ...settledTurn('Build the level', 'Built it', 1),
        ...settledTurn('Add a light', 'Added it', 3)
    ]

    await runAgent({
        settings: servedBy(url),
        messages: [
            {sender: 'user', text: 'Build the level', timestamp: 1},
            {sender: 'assistant', text: 'Built it', timestamp: 2},
            {sender: 'user', text: 'Add a light', timestamp: 3},
            {sender: 'assistant', text: 'Added it', timestamp: 4},
            {sender: 'user', text: 'Now export it', timestamp: 5}
        ],
        agentMessages: transcript,
        isRetry: true,
        workspacePath: workspace.path,
        emit: () => undefined
    })

    const sent = JSON.stringify(mock.bodies[0].messages)
    // Nothing the screen still shows may be taken off the model's memory by a retry.
    assert.ok(sent.includes('Build the level'), 'the first turn survives')
    assert.ok(sent.includes('Add a light'), 'the last settled prompt survives')
    assert.ok(sent.includes('Added it'), 'the last settled answer survives')
    assert.ok(sent.includes('Now export it'), 'the prompt being retried is asked')
})

test('a retry keeps the work the turn already did', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    const mock = startScriptedServer([{text: 'Picking up where it stopped'}])
    const url = await baseUrl(context, mock.server)
    // Force-quit mid-turn: the prompt is on the transcript, so are twenty steps of real work, and
    // the turn never got to write an answer. The screen shows four bubbles; the model remembers
    // forty-five messages. Retry must not be the thing that throws the forty-one away.
    const transcript = [
        ...settledTurn('Create Mario 1-1 clone.', 'Built it', 1),
        {role: 'user', content: 'Debug errors', timestamp: 3},
        ...Array.from({length: 20}, (_, index) =>
            toolStep(`step${String(index)}`, 10 + index * 2)
        ).flat()
    ]

    await runAgent({
        settings: servedBy(url),
        // What `retryPlan` sends: every message except the reply being rewritten, so the last one
        // is the user turn being asked again.
        messages: [
            {sender: 'user', text: 'Create Mario 1-1 clone.', timestamp: 1},
            {sender: 'assistant', text: 'Built it', timestamp: 2},
            {sender: 'user', text: 'Debug errors', timestamp: 3}
        ],
        agentMessages: transcript,
        isRetry: true,
        workspacePath: workspace.path,
        emit: () => undefined
    })

    const sent = JSON.stringify(mock.bodies[0].messages)
    // Every step the turn managed to take is still the model's to build on.
    for (let index = 0; index < 20; index += 1) {
        assert.ok(sent.includes(`result of step${String(index)}`), `step ${String(index)} survives`)
    }
    // And the question is still asked exactly once.
    assert.equal(sent.split('Debug errors').length - 1, 1)
})

test('a retry of a turn that answered replaces the answer, not the work', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    const mock = startScriptedServer([{text: 'A better answer'}])
    const url = await baseUrl(context, mock.server)
    const transcript = [
        {role: 'user', content: 'Debug errors', timestamp: 3},
        ...toolStep('one', 10),
        {
            role: 'assistant',
            content: [{type: 'text', text: 'I gave up'}],
            api: 'openai-completions',
            provider: 'local',
            model: MODEL_ID,
            usage: NO_USAGE,
            stopReason: 'error',
            errorMessage: 'connection lost',
            timestamp: 20
        }
    ]

    const completion = await runAgent({
        settings: servedBy(url),
        messages: [{sender: 'user', text: 'Debug errors', timestamp: 3}],
        agentMessages: transcript,
        isRetry: true,
        workspacePath: workspace.path,
        emit: () => undefined
    })

    const sent = JSON.stringify(mock.bodies[0].messages)
    assert.ok(sent.includes('result of one'), 'the work survives')
    // The answer being retried is not left in front of the model as its own last word.
    assert.ok(!sent.includes('I gave up'), 'the failed answer is replaced')
    assert.equal(completion.text, 'A better answer')
})

test('the wait doubles from five seconds and is held at a minute', () => {
    const policy = {baseDelayMs: 5_000, maxDelayMs: 60_000}
    const waits = Array.from({length: 10}, (_, index) => retryDelay(index + 1, policy))
    assert.deepEqual(
        waits,
        [5_000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000, 60_000, 60_000, 60_000]
    )
})

test('a turn whose model drops out is asked again by itself', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    // A model that died and came back — the everyday failure a local runtime has.
    const mock = startScriptedServer([
        {error: {status: 503, message: 'upstream connect error: connection refused'}},
        {text: 'Back online'}
    ])
    const url = await baseUrl(context, mock.server)
    const events = []
    const timers = instantTimers()

    const completion = await runAgent({
        settings: servedBy(url, impatient),
        messages: [{sender: 'user', text: 'Build the level', timestamp: 1}],
        agentMessages: [],
        workspacePath: workspace.path,
        timers,
        emit: event => events.push(event)
    })

    assert.equal(completion.text, 'Back online')
    // The shipped policy, run rather than shortened: the first wait is five seconds and nothing
    // sat through it.
    assert.deepEqual(timers.waited, [5_000])
    const scheduled = events.filter(event => event.type === 'retry-scheduled')
    assert.equal(scheduled.length, 1)
    assert.equal(scheduled[0].attempt, 1)
    assert.equal(scheduled[0].maxAttempts, 10)
    assert.ok(events.some(event => event.type === 'retry-start'))
    // The prompt is on the transcript already, so the retry continues rather than asking twice.
    assert.equal(JSON.stringify(mock.bodies.at(-1).messages).split('Build the level').length - 1, 1)
    // An error message left in the transcript teaches the model that its last word was the error.
    assert.ok(!JSON.stringify(completion.agentMessages).includes('connection refused'))
})

/**
 * Stop lands in the backoff more than anywhere else, because the backoff is what is on screen.
 *
 * `retry-scheduled` draws a countdown and invites the user to use it — up to a minute of it, on the
 * shipped curve. `abortableWait` rejects with its own wording, which threw straight past the loop's
 * stopped ending and out as a failed turn: no `done` event, so nothing recorded that the turn had
 * ended at all. Unreachable before the worker started passing a real signal.
 */
test('a stop during the wait between attempts ends the turn as stopped', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    const mock = startScriptedServer([
        {error: {status: 503, message: 'upstream connect error: connection refused'}},
        {text: 'Back online'}
    ])
    const url = await baseUrl(context, mock.server)
    const events = []
    const controller = new AbortController()
    // A clock that never fires: the wait ends on the signal instead, which is the whole point.
    const timers = {
        ...instantTimers(),
        schedule(_fn, ms) {
            // After the listener is on, so this is the ordinary abort path rather than a race.
            queueMicrotask(() => {
                controller.abort()
            })
            return ms
        }
    }

    const completion = await runAgent({
        settings: servedBy(url, impatient),
        messages: [{sender: 'user', text: 'Build the level', timestamp: 1}],
        agentMessages: [],
        workspacePath: workspace.path,
        timers,
        signal: controller.signal,
        emit: event => events.push(event)
    })

    assert.equal(completion.stopReason, 'aborted')
    assert.ok(
        events.some(event => event.type === 'retry-scheduled'),
        'the wait had begun'
    )
    assert.ok(
        !events.some(event => event.type === 'retry-start'),
        'and the attempt it was waiting for never ran'
    )
    assert.equal(mock.bodies.length, 1, 'the provider was not asked again')
})

test('a turn gives up once its retry budget is spent', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    const mock = startScriptedServer([{error: {status: 503, message: 'service unavailable'}}])
    const url = await baseUrl(context, mock.server)
    const events = []
    const timers = instantTimers()

    await assert.rejects(
        runAgent({
            settings: servedBy(url, {...impatient, retryAttempts: 2}),
            messages: [{sender: 'user', text: 'Build the level', timestamp: 1}],
            agentMessages: [],
            workspacePath: workspace.path,
            timers,
            emit: event => events.push(event)
        }),
        /unavailable/iu
    )

    // The first ask, then two retries. Not forever.
    assert.equal(mock.bodies.length, 3)
    assert.equal(events.filter(event => event.type === 'retry-scheduled').length, 2)
    // Doubling, on the real numbers, and the whole test paid neither wait.
    assert.deepEqual(timers.waited, [5_000, 10_000])
})

/**
 * OpenRouter's free pool, as it answered on 2026-08-25: HTTP 429, no `Retry-After`, and a body
 * whose `metadata` holds both the real cause and the one thing the user can do about it.
 */
const RATE_LIMITED = {
    status: 429,
    body: {
        error: {
            message: 'Provider returned error',
            code: 429,
            metadata: {
                raw: 'stealth/ox-alpha is temporarily rate-limited upstream. Please retry shortly.',
                provider_name: 'Stealth',
                limit_source: 'upstream_provider_shared_pool',
                remedy_hint: 'Retry shortly, or add your own provider key.'
            }
        },
        user_id: 'user_3IJE3NGNCSCGpZVhEluB5fQ6ck5'
    }
}

/*
 * A refusal that is about this second, waited on like one.
 *
 * Four live turns against that pool spent their whole ten-attempt budget — about nine minutes each
 * — being refused, and died. Sampled back to back in the same state the refusals cleared within a
 * second and never ran more than three deep, so the budget was not too small; the waits in front of
 * it were too long. The first five attempts now land inside 31 seconds rather than 155.
 */
test('a rate-limited turn is asked again in a second, not five', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    const mock = startScriptedServer([
        {error: RATE_LIMITED},
        {error: RATE_LIMITED},
        {text: 'Through on the third ask'}
    ])
    const url = await baseUrl(context, mock.server)
    const timers = instantTimers()

    const completion = await runAgent({
        settings: servedBy(url, impatient),
        messages: [{sender: 'user', text: 'Build the level', timestamp: 1}],
        agentMessages: [],
        workspacePath: workspace.path,
        timers,
        emit: () => {}
    })

    assert.equal(completion.text, 'Through on the third ask')
    // The shipped curve for a rate limit: one second, doubling. Not the five-second one, which
    // would have put these same two attempts 15 seconds apart.
    assert.deepEqual(timers.waited, [1_000, 2_000])
})

/*
 * OpenRouter reports one refusal two ways: HTTP 429 with its body, and an in-band stream error
 * whose text is the four words `Provider returned error` with the code stripped. A live turn
 * alternated between them, and reading the base off each failure made the waits climb 4 s, 40 s,
 * 16 s — the exponent kept counting while the base flipped. Being rate-limited is the turn's state.
 */
test('a turn that has been rate-limited keeps the short curve when the wording changes', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    const mock = startScriptedServer([
        {error: RATE_LIMITED},
        {error: {status: 503, message: 'Provider returned error'}},
        {error: RATE_LIMITED},
        {text: 'Through'}
    ])
    const url = await baseUrl(context, mock.server)
    const timers = instantTimers()

    const completion = await runAgent({
        settings: servedBy(url, impatient),
        messages: [{sender: 'user', text: 'Build the level', timestamp: 1}],
        agentMessages: [],
        workspacePath: workspace.path,
        timers,
        emit: () => {}
    })

    assert.equal(completion.text, 'Through')
    // Doubling from one second all the way, rather than jumping to 20 for the middle attempt.
    assert.deepEqual(timers.waited, [1_000, 2_000, 4_000])
})

/*
 * An outage is still waited out at five seconds. A model server that was killed is being restarted,
 * and asking again in a second is asking a socket that is not listening.
 */
test('a failure that is not a rate limit keeps the five-second curve', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    const mock = startScriptedServer([
        {error: {status: 503, message: 'upstream connect error: connection refused'}},
        {text: 'Back online'}
    ])
    const url = await baseUrl(context, mock.server)
    const timers = instantTimers()

    const completion = await runAgent({
        settings: servedBy(url, impatient),
        messages: [{sender: 'user', text: 'Build the level', timestamp: 1}],
        agentMessages: [],
        workspacePath: workspace.path,
        timers,
        emit: () => {}
    })

    assert.equal(completion.text, 'Back online')
    assert.deepEqual(timers.waited, [5_000])
})

/*
 * What the user is told when the budget really is spent.
 *
 * The turn used to end on 400 characters of the provider's JSON, with the only actionable line in
 * it — OpenRouter's `remedy_hint` — buried in the middle. The status stays in the sentence so a bug
 * report still names it.
 */
test('a spent rate-limit budget ends the turn in a sentence, not in JSON', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    const mock = startScriptedServer([{error: RATE_LIMITED}])
    const url = await baseUrl(context, mock.server)

    await assert.rejects(
        runAgent({
            settings: servedBy(url, {...impatient, retryAttempts: 1}),
            messages: [{sender: 'user', text: 'Build the level', timestamp: 1}],
            agentMessages: [],
            workspacePath: workspace.path,
            timers: instantTimers(),
            emit: () => {}
        }),
        error => {
            assert.equal(
                error.message,
                'The provider refused this request (429): stealth/ox-alpha is temporarily '
                    + 'rate-limited upstream. Please retry shortly. Retry shortly, or add your own '
                    + 'provider key.'
            )
            assert.ok(!error.message.includes('{'), 'no JSON reaches the user')
            return true
        }
    )
})

/*
 * A spent quota is still a spent quota after the sentence is written.
 *
 * The readable form keeps the status and the provider's own detail and drops everything else — and
 * `GoUsageLimitError` lives in `error.type`, which is one of the markers Pi's classifier reads to
 * decide a failure will never fix itself. Classified on the readable form, this 429 kept its number,
 * matched the retryable pattern, and burned all ten attempts against an account with nothing left.
 */
test('a quota that will never clear is not retried, however it is worded', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    const mock = startScriptedServer([
        {
            error: {
                status: 429,
                body: {
                    error: {
                        type: 'GoUsageLimitError',
                        code: 429,
                        message: 'You have reached your plan limit.'
                    }
                }
            }
        }
    ])
    const url = await baseUrl(context, mock.server)
    const events = []
    const timers = instantTimers()

    await assert.rejects(
        runAgent({
            settings: servedBy(url, impatient),
            messages: [{sender: 'user', text: 'Build the level', timestamp: 1}],
            agentMessages: [],
            workspacePath: workspace.path,
            timers,
            emit: event => events.push(event)
        }),
        /plan limit/u
    )

    assert.equal(mock.bodies.length, 1, 'the provider was asked once and not again')
    assert.ok(!events.some(event => event.type === 'retry-scheduled'))
    assert.deepEqual(timers.waited, [])
})

/* A body this cannot read is handed back exactly as it came, rather than replaced by a guess. */
test('a provider error that is not JSON is left alone', () => {
    assert.equal(readableProviderError('fetch failed'), 'fetch failed')
    assert.equal(readableProviderError('429: not json at all'), '429: not json at all')
    assert.equal(readableProviderError(undefined), undefined)
})

test('a failure that will not fix itself is not waited on', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    // A spent quota is the account's problem, not the moment's. Waiting only delays the news.
    const mock = startScriptedServer([
        {error: {status: 429, message: 'insufficient_quota: quota exceeded for this key'}}
    ])
    const url = await baseUrl(context, mock.server)
    const events = []
    const timers = instantTimers()

    await assert.rejects(
        runAgent({
            settings: servedBy(url, impatient),
            messages: [{sender: 'user', text: 'Build the level', timestamp: 1}],
            agentMessages: [],
            workspacePath: workspace.path,
            timers,
            emit: event => events.push(event)
        }),
        /quota/iu
    )

    assert.equal(mock.bodies.length, 1)
    assert.ok(!events.some(event => event.type === 'retry-scheduled'))
    assert.deepEqual(timers.waited, [])
})

test('a turn that stops without saying anything is asked again', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    // What a gateway does when the model behind it dies mid-request: HTTP 200, `finish_reason:
    // "stop"`, and nothing in the message. Measured against OpenRouter, which reports the upstream
    // failure only in `native_finish_reason` — a field the completions dialect does not carry.
    const mock = startScriptedServer([{text: ''}, {text: 'Back with an answer'}])
    const url = await baseUrl(context, mock.server)
    const events = []

    const completion = await runAgent({
        settings: servedBy(url, impatient),
        messages: [{sender: 'user', text: 'Build the level', timestamp: 1}],
        agentMessages: [],
        workspacePath: workspace.path,
        timers: instantTimers(),
        emit: event => events.push(event)
    })

    assert.equal(completion.text, 'Back with an answer')
    assert.equal(events.filter(event => event.type === 'retry-scheduled').length, 1)
    // The blank answer is not left in front of the model as its own last word.
    assert.equal(JSON.stringify(mock.bodies.at(-1).messages).split('Build the level').length - 1, 1)
})

test('a turn that only thought and never answered is asked again', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    // The same gateway failure, against a reasoning model: the reasoning block arrives, the answer
    // never does, and `finish_reason` still says the turn ended normally. Thinking is not something
    // the user was told, so a turn holding only thinking has not answered.
    const mock = startScriptedServer([
        {reasoning: 'Let me work out what they want.'},
        {text: 'Back with an answer'}
    ])
    const url = await baseUrl(context, mock.server)
    const events = []

    const completion = await runAgent({
        settings: servedBy(url, {...impatient, model: {reasoning: true}}),
        messages: [{sender: 'user', text: 'Build the level', timestamp: 1}],
        agentMessages: [],
        workspacePath: workspace.path,
        timers: instantTimers(),
        emit: event => events.push(event)
    })

    assert.equal(completion.text, 'Back with an answer')
    assert.equal(events.filter(event => event.type === 'retry-scheduled').length, 1)
})

test('a turn that only ever stops without saying anything gives up loudly', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    const mock = startScriptedServer([{text: ''}])
    const url = await baseUrl(context, mock.server)

    await assert.rejects(
        runAgent({
            settings: servedBy(url, {...impatient, retryAttempts: 2}),
            messages: [{sender: 'user', text: 'Build the level', timestamp: 1}],
            agentMessages: [],
            workspacePath: workspace.path,
            timers: instantTimers(),
            emit: () => undefined
        }),
        /empty/iu
    )

    // The first ask, then two retries. An empty answer is never returned as the answer.
    assert.equal(mock.bodies.length, 3)
})

test('an ordinary turn keeps the transcript it was given', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    const mock = startScriptedServer([{text: 'Carrying on'}])
    const url = await baseUrl(context, mock.server)
    const history = longConversation(2, 20)

    await runAgent({
        settings: servedBy(url),
        messages: [{sender: 'user', text: 'Next', timestamp: 99}],
        agentMessages: history,
        workspacePath: workspace.path,
        emit: () => undefined
    })

    assert.equal(mock.bodies[0].messages.length, history.length + 1)
})

test('an empty transcript is rebuilt from the conversation on screen', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    const mock = startScriptedServer([{text: 'Carrying on'}])
    const url = await baseUrl(context, mock.server)
    const events = []

    // What a task looks like after its first turn failed: three messages on screen, and a model
    // that was never told any of them.
    await runAgent({
        settings: servedBy(url),
        messages: [
            {sender: 'user', text: 'Earlier question', timestamp: 1},
            {sender: 'assistant', text: 'Earlier answer', timestamp: 2},
            {sender: 'user', text: 'Continue', timestamp: 3}
        ],
        agentMessages: [],
        workspacePath: workspace.path,
        emit: event => events.push(event)
    })

    assert.deepEqual(
        mock.bodies[0].messages.map(message => message.role),
        ['user', 'assistant', 'user']
    )
    const rebuilt = events.find(event => event.type === 'context-rebuilt')
    assert.ok(rebuilt, 'the rebuild is announced rather than done silently')
    assert.equal(rebuilt.messages, 2)
})

test('a first turn with nothing behind it rebuilds nothing', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    const mock = startScriptedServer([{text: 'Starting'}])
    const url = await baseUrl(context, mock.server)
    const events = []

    await runAgent({
        settings: servedBy(url),
        messages: [{sender: 'user', text: 'First question', timestamp: 1}],
        agentMessages: [],
        workspacePath: workspace.path,
        emit: event => events.push(event)
    })

    assert.equal(mock.bodies[0].messages.length, 1)
    assert.ok(!events.some(event => event.type === 'context-rebuilt'))
})

test('a delegated question comes back as an answer, not as what it read', async context => {
    const workspace = await temporaryWorkspace({
        'physics.gd': `extends Node\n${'# padding\n'.repeat(200)}const SPEED = 512 # SECRET-MARKER\n`
    })
    context.after(workspace.remove)
    const mock = startScriptedServer([
        // The parent delegates.
        {calls: [{name: 'subagent', args: {prompt: 'Where is the player speed set?'}}]},
        // The child reads the big file, then answers from it.
        {calls: [{name: 'read', args: {path: 'physics.gd'}}]},
        {text: 'physics.gd sets SPEED to 512.'},
        // The parent answers its user.
        {text: 'The speed is 512, set in physics.gd.'}
    ])
    const url = await baseUrl(context, mock.server)
    const events = []

    const completion = await runAgent({
        settings: servedBy(url),
        messages: [{sender: 'user', text: 'How fast does the player move?', timestamp: 1}],
        workspacePath: workspace.path,
        emit: event => events.push(event)
    })

    assert.equal(completion.text, 'The speed is 512, set in physics.gd.')
    assert.equal(mock.bodies.length, 4)

    // The whole point, asserted on the wire: the child read two hundred lines and the parent's
    // context holds one sentence about them. The marker only ever existed in the child's request.
    const child = JSON.stringify(mock.bodies[2])
    const parent = JSON.stringify(mock.bodies[3])
    assert.match(child, /SECRET-MARKER/u)
    assert.doesNotMatch(parent, /SECRET-MARKER/u)
    assert.match(parent, /physics\.gd sets SPEED to 512/u)
    // And what it cost rides with it, on the call that spent it.
    assert.match(parent, /sub-agent: Qwen3\.6-27B-UD-Q4_K_XL\.gguf, 2 steps/u)

    // On screen it is one tool row, named and captioned by the question it was asked.
    const started = events.find(event => event.type === 'tool-start')
    assert.equal(started.name, 'subagent')
    assert.equal(started.target, 'Where is the player speed set?')
    assert.equal(events.find(event => event.type === 'tool-end').isError, false)
})

/*
 * The whole point of letting the child name a model: the parent plans on the large one and the
 * child reads on the small one. Asserted on the wire, because the child builds its own `Agent` and
 * nothing between here and the request would notice it streaming through the parent's model object.
 */
test('a delegation is answered by the model the sub-agent was given, not the parents', async context => {
    const workspace = await temporaryWorkspace({'physics.gd': 'extends Node\n'})
    context.after(workspace.remove)
    const mock = startScriptedServer([
        {calls: [{name: 'subagent', args: {prompt: 'Where is the speed set?'}}]},
        {text: 'physics.gd sets it.'},
        {text: 'The speed is set in physics.gd.'}
    ])
    const url = await baseUrl(context, mock.server)

    await runAgent({
        settings: servedBy(url, {subagent: {connection: SMALL_MODEL}}),
        messages: [{sender: 'user', text: 'How fast does the player move?', timestamp: 1}],
        workspacePath: workspace.path,
        emit: () => undefined
    })

    assert.equal(mock.bodies[0].model, MODEL_ID)
    assert.equal(mock.bodies[1].model, 'small.gguf')
    assert.equal(mock.bodies[2].model, MODEL_ID)
})

/*
 * The two connections a turn may need at once, which is the arrangement the whole field exists for:
 * a ChatGPT parent that plans, and a local child that reads. Both providers are registered on one
 * `Models`, and this proves the registration rather than the requests — the parent's own ask needs
 * a ChatGPT credential no test has. What it must never fail with is the local provider missing.
 */
test('registers both connections when the sub-agent is on the other one', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)

    const failure = await runAgent({
        settings: {
            ...settings,
            connectionType: 'openai-codex',
            maxRetries: 0,
            connections: {
                ...servedBy('http://127.0.0.1:1/v1').connections,
                'openai-codex': {
                    name: 'ChatGPT subscription',
                    baseUrl: 'https://chatgpt.com/backend-api',
                    api: 'openai-codex-responses',
                    chatTemplateThinking: false,
                    model: {id: 'gpt-5.4-mini'}
                }
            },
            subagent: {connection: SMALL_MODEL}
        },
        messages: [{sender: 'user', text: 'Say hello', timestamp: 1}],
        workspacePath: workspace.path,
        emit: () => undefined
    }).then(
        () => '',
        error => String(error)
    )

    assert.doesNotMatch(failure, /Unknown provider/u)
    assert.match(failure, /openai-codex/u)
})

test('stops the turn by name when the sub-agent has nowhere to run', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    const mock = startScriptedServer([{text: 'Done'}])
    const url = await baseUrl(context, mock.server)

    const start = configuration =>
        runAgent({
            settings: {...servedBy(url), ...configuration},
            messages: [{sender: 'user', text: 'Say hello', timestamp: 1}],
            workspacePath: workspace.path,
            emit: () => undefined
        }).then(
            () => '',
            error => String(error)
        )

    // A local child on a settings file that has never held a local connection.
    assert.match(
        await start({
            connectionType: 'openai-codex',
            connections: {
                'openai-codex': {
                    name: 'ChatGPT subscription',
                    baseUrl: 'https://chatgpt.com/backend-api',
                    api: 'openai-codex-responses',
                    chatTemplateThinking: false,
                    model: {id: 'gpt-5.4-mini'}
                }
            },
            subagent: {connection: SMALL_MODEL}
        }),
        /no local connection is configured/u
    )

    // And a ChatGPT model that is not in this Pi release.
    assert.match(
        await start({
            subagent: {
                connection: {
                    connectionType: 'openai-codex',
                    model: {...SMALL_MODEL.model, id: 'gpt-2'}
                }
            }
        }),
        /'gpt-2' is unavailable on ChatGPT/u
    )
})

/**
 * A turn that failed its own verification must say so in the answer, not only on the transcript.
 *
 * Measured live against a local model: a point failed twice, the model was handed the report and
 * asked again, and the turn still ended "The verification passes. The code is already correct." —
 * four seconds after the second red. The turn reported `stopReason: 'stop'` and nothing anywhere
 * near the sentence a person reads said otherwise, which is the Centipede failure one layer up.
 */
test('a turn whose verification failed carries the verdict in its answer', async context => {
    const mock = startServer()
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    await new Promise(resolve => mock.server.listen(0, '127.0.0.1', resolve))
    const address = mock.server.address()
    const spec =
        'GOAL\nA thing.\n\nVERIFY\n```sh\n'
        + '# the boss registers every part it builds\n'
        + 'sh -c "exit 1"\n'
        + '# the project is still there\n'
        + 'sh -c "exit 0"\n'
        + '```\n'

    try {
        const completion = await runAgent({
            settings: servedBy(`http://127.0.0.1:${String(address.port)}/v1`),
            messages: [{sender: 'user', text: spec, images: [], timestamp: 1}],
            workspacePath: workspace.path,
            emit: () => undefined
        })

        // The model said "Hello" and stopped. The answer says what actually happened.
        assert.match(completion.text, /^Hello/u)
        assert.match(completion.text, /Verification failed: 1 of 2 points/u)
        assert.match(completion.text, /FAIL {2}the boss registers every part it builds/u)
        assert.match(completion.text, /PASS {2}the project is still there/u)
        assert.equal(completion.verify.failed, 1)
        assert.deepEqual(completion.verify.points, [
            {name: 'the boss registers every part it builds', passed: false},
            {name: 'the project is still there', passed: true}
        ])
    } finally {
        mock.server.close()
    }
})

test('a turn that passes its verification says nothing extra', async context => {
    const mock = startServer()
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    await new Promise(resolve => mock.server.listen(0, '127.0.0.1', resolve))
    const address = mock.server.address()
    const spec = 'GOAL\nA thing.\n\nVERIFY\n```sh\n# it is there\nsh -c "exit 0"\n```\n'

    try {
        const completion = await runAgent({
            settings: servedBy(`http://127.0.0.1:${String(address.port)}/v1`),
            messages: [{sender: 'user', text: spec, images: [], timestamp: 1}],
            workspacePath: workspace.path,
            emit: () => undefined
        })

        // Exactly what the model said, and not a word more.
        assert.equal(completion.text, 'Hello Gofer')
        assert.equal(completion.verify.failed, 0)
    } finally {
        mock.server.close()
    }
})

/**
 * The switch a llama.cpp host actually reads.
 *
 * Measured, not assumed. One machine, two Qwen builds in turn: with no `chat_template_kwargs` the
 * server produced 0 characters of reasoning, with `enable_thinking: true` it produced 1175, and a
 * top-level `reasoning_effort` was accepted and ignored. So a connection that turns thinking on
 * with a template argument has to say so, or the reasoning level does nothing at all.
 */
test('a chat-template server is sent the argument that turns thinking on', () => {
    const template = {
        name: 'Local AI',
        baseUrl: 'http://127.0.0.1:8080/v1',
        api: 'openai-completions',
        chatTemplateThinking: true,
        model: {
            id: 'local.gguf',
            name: 'local.gguf',
            contextWindow: 120_064,
            maxTokens: 120_064,
            reasoning: true,
            supportsReasoningEffort: false,
            thinkingLevels: [],
            input: ['text'],
            thinkingLevel: 'on'
        }
    }
    const on = connection => ({
        connectionType: 'openai-compatible',
        connections: {'openai-compatible': connection}
    })
    const {model} = createModelContext({settings: on(template), apiKey: 'local'})

    assert.equal(model.compat.thinkingFormat, 'chat-template')
    assert.deepEqual(model.compat.chatTemplateKwargs, {
        enable_thinking: {$var: 'thinking.enabled'},
        preserve_thinking: true
    })

    // A template that names its own efforts gets the effort argument too. The same template raises
    // on an effort it does not know, so this only ever carries a level the server itself named.
    const {model: withEfforts} = createModelContext({
        settings: on({
            ...template,
            model: {...template.model, supportsReasoningEffort: true, thinkingLevel: 'medium'}
        }),
        apiKey: 'local'
    })
    assert.deepEqual(withEfforts.compat.chatTemplateKwargs.reasoning_effort, {
        $var: 'thinking.effort',
        omitWhenOff: true
    })

    // And a server that never answered `/props` is left exactly as it was: no template argument
    // reaches an endpoint that would reject an unknown field.
    const {model: plain} = createModelContext({
        settings: on({...template, chatTemplateThinking: false}),
        apiKey: 'local'
    })
    assert.equal(plain.compat.thinkingFormat, undefined)
    assert.equal(plain.compat.chatTemplateKwargs, undefined)
})

/**
 * The level the menu offers, in the body the server receives.
 *
 * The test above reads the model's compat block, which is the shape of the request rather than the
 * request. Between the two sits `clampThinkingLevel`, and it does not know the word `on`: an
 * unknown level clamps to the lowest one available, which is `off`, which resolves
 * `enable_thinking` to false. So the connection that only has on and off sent thinking explicitly
 * disabled on every request — the one setting it exists to turn on.
 */
test('the on level reaches a chat-template server as thinking enabled', async context => {
    const mock = startServer()
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    await new Promise(resolve => mock.server.listen(0, '127.0.0.1', resolve))
    const {port} = mock.server.address()

    try {
        await runAgent({
            settings: servedBy(`http://127.0.0.1:${String(port)}/v1`, {
                connection: {chatTemplateThinking: true},
                model: {
                    reasoning: true,
                    supportsReasoningEffort: false,
                    thinkingLevel: 'on'
                }
            }),
            messages: [{sender: 'user', text: 'Say hello', timestamp: 1}],
            workspacePath: workspace.path,
            emit: () => undefined
        })

        const {body} = mock.request()
        assert.equal(body.chat_template_kwargs?.enable_thinking, true)
        assert.equal(body.chat_template_kwargs?.preserve_thinking, true)
        // The template does not name efforts, so it is never told one.
        assert.equal('reasoning_effort' in body.chat_template_kwargs, false)
    } finally {
        mock.server.close()
    }
})

/** And off still means off, or the level would be a label with one state. */
test('the off level reaches a chat-template server as thinking disabled', async context => {
    const mock = startServer()
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    await new Promise(resolve => mock.server.listen(0, '127.0.0.1', resolve))
    const {port} = mock.server.address()

    try {
        await runAgent({
            settings: servedBy(`http://127.0.0.1:${String(port)}/v1`, {
                connection: {chatTemplateThinking: true},
                model: {
                    reasoning: true,
                    supportsReasoningEffort: false,
                    thinkingLevel: 'off'
                }
            }),
            messages: [{sender: 'user', text: 'Say hello', timestamp: 1}],
            workspacePath: workspace.path,
            emit: () => undefined
        })

        assert.equal(mock.request().body.chat_template_kwargs?.enable_thinking, false)
    } finally {
        mock.server.close()
    }
})

/*
 * A model that refuses to be asked not to think, with `off` still in its settings file.
 *
 * This is the failure a live turn hit: the sub-agent was left at `off` against `stealth/ox-alpha`,
 * every `godot_docs_search ask` went out as `reasoning: {enabled: false}`, and OpenRouter answered
 * HTTP 400 `Reasoning is mandatory for this endpoint and cannot be disabled` to all of them. The
 * settings page no longer offers `off` for such a model, but a file written before that still holds
 * it, so the request itself has to be the thing that never disables reasoning.
 *
 * The body is what is asserted, not the level: pi-ai rewrites a level on the way past.
 */
test('a stored off never disables reasoning on a model that requires it', async context => {
    const mock = startServer()
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    await new Promise(resolve => mock.server.listen(0, '127.0.0.1', resolve))
    const {port} = mock.server.address()

    try {
        await runAgent({
            settings: servedBy(`http://127.0.0.1:${String(port)}/v1`, {
                model: {
                    reasoning: true,
                    supportsReasoningEffort: true,
                    reasoningMandatory: true,
                    thinkingLevels: ['max', 'high', 'low'],
                    thinkingLevel: 'off'
                }
            }),
            messages: [{sender: 'user', text: 'Say hello', timestamp: 1}],
            workspacePath: workspace.path,
            emit: () => undefined
        })

        const {body} = mock.request()
        assert.notEqual(body.reasoning_effort, 'none')
        assert.notEqual(body.reasoning?.enabled, false)
        // The least effort it named, which is the nearest thing it has to the setting that was made.
        assert.equal(body.reasoning_effort, 'low')
    } finally {
        mock.server.close()
    }
})

/** And a model that may be turned off still is. The rule is narrow on purpose. */
test('a stored off still disables reasoning where off is allowed', async context => {
    const mock = startServer()
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    await new Promise(resolve => mock.server.listen(0, '127.0.0.1', resolve))
    const {port} = mock.server.address()

    try {
        await runAgent({
            settings: servedBy(`http://127.0.0.1:${String(port)}/v1`, {
                model: {
                    reasoning: true,
                    supportsReasoningEffort: true,
                    reasoningMandatory: false,
                    thinkingLevels: ['max', 'high', 'low'],
                    thinkingLevel: 'off'
                }
            }),
            messages: [{sender: 'user', text: 'Say hello', timestamp: 1}],
            workspacePath: workspace.path,
            emit: () => undefined
        })

        assert.notEqual(mock.request().body.reasoning_effort, 'low')
    } finally {
        mock.server.close()
    }
})

/** A template that does name its efforts still carries the one the user picked. */
test('a named effort reaches a chat-template server unchanged', async context => {
    const mock = startServer()
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    await new Promise(resolve => mock.server.listen(0, '127.0.0.1', resolve))
    const {port} = mock.server.address()

    try {
        await runAgent({
            settings: servedBy(`http://127.0.0.1:${String(port)}/v1`, {
                connection: {chatTemplateThinking: true},
                model: {
                    reasoning: true,
                    supportsReasoningEffort: true,
                    thinkingLevel: 'medium'
                }
            }),
            messages: [{sender: 'user', text: 'Say hello', timestamp: 1}],
            workspacePath: workspace.path,
            emit: () => undefined
        })

        const {body} = mock.request()
        assert.equal(body.chat_template_kwargs?.enable_thinking, true)
        assert.equal(body.chat_template_kwargs?.reasoning_effort, 'medium')
    } finally {
        mock.server.close()
    }
})

/**
 * A level the server named has to reach it under the name the server used.
 *
 * pi-ai treats `xhigh` and `max` as levels a model only has if it says so, and a model that has not
 * said so has them clamped away — `xhigh` becomes `high`. The chat template these levels come from
 * is the one that raises on an effort it does not know, and llama.cpp answers that with HTTP 500.
 * Measured against a real Qwen3.8 build: its guard is `('xhigh', 'medium', 'low')`, Gofer offered
 * xhigh because the server named it, and the request went out saying `high`. That one survived only
 * because its template happens to alias high onto xhigh a line earlier. A template without that
 * line answers every request with a 500.
 */
test('a level the server named is sent under that name, not the nearest one', async context => {
    const mock = startServer()
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    await new Promise(resolve => mock.server.listen(0, '127.0.0.1', resolve))
    const {port} = mock.server.address()

    try {
        await runAgent({
            settings: servedBy(`http://127.0.0.1:${String(port)}/v1`, {
                connection: {chatTemplateThinking: true},
                model: {
                    reasoning: true,
                    supportsReasoningEffort: true,
                    thinkingLevels: ['low', 'medium', 'xhigh'],
                    thinkingLevel: 'xhigh'
                }
            }),
            messages: [{sender: 'user', text: 'Say hello', timestamp: 1}],
            workspacePath: workspace.path,
            emit: () => undefined
        })

        assert.equal(mock.request().body.chat_template_kwargs?.reasoning_effort, 'xhigh')
    } finally {
        mock.server.close()
    }
})

/** And a level the server did not name is never reached for, however near it looks. */
test('a level the server did not name is never what a request settles on', async context => {
    const mock = startServer()
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    await new Promise(resolve => mock.server.listen(0, '127.0.0.1', resolve))
    const {port} = mock.server.address()

    try {
        await runAgent({
            settings: servedBy(`http://127.0.0.1:${String(port)}/v1`, {
                connection: {chatTemplateThinking: true},
                model: {
                    reasoning: true,
                    supportsReasoningEffort: true,
                    thinkingLevels: ['low', 'medium', 'xhigh'],
                    // Nothing in the app can pick this — the menu offers what the server named —
                    // but a settings file written against an older model can still hold it.
                    thinkingLevel: 'high'
                }
            }),
            messages: [{sender: 'user', text: 'Say hello', timestamp: 1}],
            workspacePath: workspace.path,
            emit: () => undefined
        })

        const sent = mock.request().body.chat_template_kwargs?.reasoning_effort
        assert.ok(
            sent === undefined || ['low', 'medium', 'xhigh'].includes(sent),
            `sent an effort the template would raise on: ${String(sent)}`
        )
    } finally {
        mock.server.close()
    }
})

/*
 * Two length limits reach the same `stopReason`, and they need opposite advice.
 *
 * A live turn asked to build a whole Breakout spent 16,384 tokens planning — exactly `maxTokens` —
 * with 84,104 of its 120,064-token window still free, and was told the conversation had no room
 * left and to point the connection at a model with a larger context window. A larger window would
 * have changed nothing.
 *
 * The number was wrong too, and always was: `usage.input` is the part of the request the provider
 * did *not* serve from cache, so the same run reported "the request filled 1,000 of 120,064" about
 * a conversation holding 35,960.
 */
test('a length stop names which limit it was, and what the conversation really held', () => {
    const model = {contextWindow: 120064, maxTokens: 16384}

    // The Breakout run, to the token.
    const ceiling = outOfRoom({usage: {input: 1000, cacheRead: 34960, output: 16384}}, model)
    assert.match(ceiling, /whole response limit/u)
    assert.match(ceiling, /84,104 of its 120,064-token context window still free/u)
    assert.match(ceiling, /a larger context window would not change it/u)
    assert.doesNotMatch(ceiling, /no longer leaves room/u)

    // A conversation that genuinely crowded out its reply keeps the old answer — and names what it
    // really held, cache included, rather than the sliver that missed the cache.
    const crowded = outOfRoom({usage: {input: 900, cacheRead: 118000, output: 40}}, model)
    assert.match(crowded, /no longer leaves room/u)
    assert.match(crowded, /filled 118,900 of the model's 120,064-token/u)
    assert.match(crowded, /larger context window/u)
})

/**
 * The one thing that makes a long conversation affordable, and the one thing nothing checked.
 *
 * Every provider Gofer talks to caches a prompt by its leading bytes and charges full price for the
 * first byte that differs and everything after it. So what a turn re-sends has to be what the last
 * turn sent, exactly — the same system message, the same tool schemas, the same transcript in front
 * of the new words.
 *
 * It was not. The memory block, the session line and the file listing were concatenated onto the
 * system prompt, and all three are re-derived every turn — the memory block is a search keyed on
 * the words the user just typed, so it was never twice the same. Measured across one project's
 * 1,645 requests: 96.6% of the prompt came from cache inside a turn and 14.3% at a turn boundary,
 * the cached prefix stopped at 9,728 tokens every single time — the base prompt and the tool
 * schemas, and not one byte past where the memory block began — and 94 prompts cost as much as the
 * 1,551 tool results between them.
 *
 * Three turns rather than two, because two share only the system message and that is not a prefix
 * worth the name. Turns two and three share the whole of turn one.
 *
 * "Byte for byte" up to one message, and the exception is the point of the design rather than a
 * gap in it. The block is sent and not stored, so turn N+1 re-sends turn N's prompt without it and
 * the prefix ends there — one turn's span re-read, once. What it buys is everything in front of
 * that: the system message, the tool schemas, and every turn before the last. The loop below names
 * the shared run for each pair, and the `+ 1` is that one message.
 */
test('what a turn re-sends is what the last turn sent, byte for byte', async context => {
    const mock = startScriptedServer([{text: 'One'}, {text: 'Two'}, {text: 'Three'}])
    const url = await baseUrl(context, mock.server)
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)

    // Everything a turn derives for itself, different on every turn — which is what the real ones
    // do. Retrieval is keyed on the prompt, the editor moves, and the model writes files.
    const derived = turn => ({
        memoryContext: `Turn ${String(turn)} remembered something else entirely.`,
        sessionContext: `Editor session: ready. Godot 4.7.${String(turn)}.`,
        inventory: `The project's tracked files:\n${'scripts/player.gd\n'.repeat(turn)}`
    })

    let agentMessages = []
    const messages = []
    for (const turn of [1, 2, 3]) {
        messages.push({sender: 'user', text: `Ask number ${String(turn)}`, timestamp: turn})
        await runAgent({
            settings: servedBy(url),
            systemPrompt: 'Be brief.',
            tools: catalog,
            host: {call: () => Promise.resolve({})},
            messages: [...messages],
            agentMessages,
            sessionId: 'one-task',
            workspacePath: workspace.path,
            emit: event => {
                if (event.type === 'turn-state') agentMessages = event.agentMessages
            },
            ...derived(turn)
        })
        messages.push({sender: 'assistant', text: 'ok', timestamp: turn})
    }

    assert.equal(mock.bodies.length, 3, 'three turns, three requests')

    /** Where two requests stop being the same request, as a person can read it. */
    const divergence = (before, after) => {
        const at = [...before].findIndex((part, index) => part !== after[index])
        if (at < 0) return undefined
        return {
            at,
            before: JSON.stringify(before[at]).slice(0, 200),
            after: JSON.stringify(after[at]).slice(0, 200)
        }
    }

    // Each turn's request holds the one before it plus an answer and a new prompt, so the run of
    // messages both requests have to agree on grows by two a turn. Named rather than derived from
    // the shorter request: `earlier.length - 1` is the same number today and stops meaning anything
    // the moment a regression makes a request shorter, which is exactly when this has to fail.
    for (const [earlier, later, shared] of [
        [mock.bodies[0], mock.bodies[1], 1],
        [mock.bodies[1], mock.bodies[2], 3]
    ]) {
        // The tool schemas, first, because they are the largest single thing in the request and a
        // reordered key in one of them is as expensive as a rewritten one.
        assert.equal(
            JSON.stringify(later.tools),
            JSON.stringify(earlier.tools),
            'the tool schemas have to be the same bytes every turn'
        )

        // The system message, which is where every provider starts counting.
        assert.equal(
            later.messages[0].content,
            earlier.messages[0].content,
            'the system message has to be the same bytes every turn'
        )

        // And the conversation in front of the new words. The earlier request's own last message is
        // where this turn's context was hung, so it is the one message allowed to differ.
        assert.equal(
            earlier.messages.length,
            shared + 1,
            'the earlier request is the shared run plus the prompt this turn hung its context on'
        )
        const before = earlier.messages.slice(0, shared).map(message => JSON.stringify(message))
        const after = later.messages.slice(0, shared).map(message => JSON.stringify(message))
        assert.deepEqual(
            divergence(before, after),
            undefined,
            `the first ${String(shared)} messages have to be the same bytes every turn`
        )
    }

    // And the turn's own data still reaches the model, on the tail where it costs nothing. Without
    // this, deleting the memory feature outright would pass every assertion above.
    const asked = mock.bodies[2].messages.at(-1).content
    assert.ok(asked.startsWith('Ask number 3'), 'the user still asks first')
    assert.ok(asked.includes('Turn 3 remembered something else entirely.'), 'memory still arrives')
    assert.ok(asked.includes('Godot 4.7.3'), 'the session line still arrives')
    assert.ok(asked.includes('scripts/player.gd'), 'the file listing still arrives')
})

/**
 * The block this turn appends is sent, never stored — and Retry is where that stops being a detail.
 *
 * A retry decides between carrying on from the transcript and asking the prompt again by matching
 * the stored prompt against the one being retried, word for word. The words the turn hangs on the
 * tail are re-derived every time — memory is a search keyed on the prompt, against a corpus the
 * failed turn already wrote to — so a block written into the stored message would never match twice.
 * The retry would fall through to asking again, and the prompt would land on the transcript a
 * second time: the exact loss `retryEntry` was written to prevent, reintroduced from below.
 */
test('a retry still recognises its own prompt, whatever this turn remembered', async context => {
    const mock = startScriptedServer([{text: 'Carrying on'}])
    const url = await baseUrl(context, mock.server)
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)

    const crashed = [
        {role: 'user', content: 'Build the level', timestamp: 10},
        {
            role: 'assistant',
            content: [{type: 'text', text: 'Starting on it'}],
            api: 'openai-completions',
            provider: 'local',
            model: MODEL_ID,
            usage: NO_USAGE,
            stopReason: 'stop',
            timestamp: 11
        }
    ]

    await runAgent({
        settings: servedBy(url),
        messages: [{sender: 'user', text: 'Build the level', timestamp: 10}],
        agentMessages: crashed,
        isRetry: true,
        tools: catalog,
        host: {call: () => Promise.resolve({})},
        // Nothing like what the failed turn was given, which is the realistic case.
        memoryContext: 'Something the last attempt never saw.',
        sessionContext: 'Editor session: ready. Godot 4.7.2.',
        workspacePath: workspace.path,
        emit: () => undefined
    })

    const sent = mock.bodies[0].messages
    assert.equal(
        sent.filter(message => JSON.stringify(message).includes('Build the level')).length,
        1,
        'the retry carried on rather than asking the prompt a second time'
    )
    // And this turn's data still reached it, on the prompt the transcript already held.
    const asked = sent.find(message => JSON.stringify(message).includes('Build the level'))
    assert.ok(String(asked.content).includes('Something the last attempt never saw.'))
})

/**
 * A turn can ask a second question of itself, and the block has to stay where it was put.
 *
 * A red verify report is asked as a user message, partway through a turn that has already sent
 * twenty tool results. Hanging this turn's context on "the last user message" would move it off the
 * original prompt and onto the report — and every earlier request of that turn had already sent it
 * on the prompt, so the prefix would break there and throw away the whole turn behind it. Once per
 * re-prompted turn is better than once per tool call and still worse than never.
 */
test('a red verify report does not move this turn’s context off the prompt', async context => {
    const mock = startScriptedServer([{text: 'Hello'}, {text: 'Fixed it'}])
    const url = await baseUrl(context, mock.server)
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)

    const spec = 'GOAL\nA thing.\n\nVERIFY\n```sh\n# it is registered\nsh -c "exit 1"\n```\n'
    await runAgent({
        settings: servedBy(url),
        messages: [{sender: 'user', text: spec, images: [], timestamp: 1}],
        memoryContext: 'The player is a cat.',
        workspacePath: workspace.path,
        emit: () => undefined
    })

    assert.equal(mock.bodies.length, 2, 'the red report was asked as a second request')
    const [asked, reasked] = mock.bodies
    const prompt = body => body.messages.find(message => String(message.content).includes('GOAL'))

    // The prompt reaches the second request exactly as it reached the first — block and all.
    assert.equal(
        JSON.stringify(prompt(reasked)),
        JSON.stringify(prompt(asked)),
        'the prompt has to be the same bytes in both requests'
    )
    assert.ok(String(prompt(asked).content).includes('The player is a cat.'))
    // And the report is asked without a second copy of it.
    assert.ok(!String(reasked.messages.at(-1).content).includes('The player is a cat.'))
})

/// A turn can be driven with no model server at all, which is what the world seam is for.
///
/// `brief/run.mjs` and `memory-judge.mjs` have had this since they were written; the turn did not,
/// so every case here stands up an HTTP listener — a port, a workspace, and SSE frames written by
/// hand. Most of them should: the retry ladder, the overflow recovery and the prefix stability are
/// all statements about what a *server* did, and a fake that simply answers cannot make them.
///
/// This one is the other kind. It says the turn folds a completed answer into a completion and
/// emits the events around it, and none of that is about the wire. The adapter is `cannedModels`,
/// which is not written for this test — it is what the sub-agent probe uses in a shipped build.
test('a turn runs against a canned world, with no server behind it', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    const events = []
    const model = {id: MODEL_ID, api: 'openai-completions', provider: 'local'}

    const completion = await runAgent({
        settings: servedBy('http://127.0.0.1:1/v1'),
        messages: [{sender: 'user', text: 'Say hello', timestamp: 1}],
        workspacePath: workspace.path,
        emit: event => events.push(event),
        world: {
            createModelContext: () => ({
                isChatGpt: false,
                models: cannedModels(model, 'Hello from nowhere'),
                model,
                subagent: {model, thinkingLevel: 'off'},
                streamOptions: {}
            })
        }
    })

    assert.equal(completion.text, 'Hello from nowhere')
    assert.equal(completion.stopReason, 'stop')
    assert.ok(
        events.some(event => event.type === 'done'),
        `a finished turn emits done: ${JSON.stringify(events.map(one => one.type))}`
    )
})

/// The default is the live world, which the case above cannot say: it passes one.
///
/// Asserting that `LIVE_WORLD.createModelContext` is a function says nothing about what `runAgent`
/// falls back to — the default could be deleted and that assertion would still pass, while every
/// turn in the app died on `world.createModelContext is not a function`. So this asks for a turn
/// with no world at all and no connections, and reads back the message only the real adapter
/// writes. No listener: the throw is the first statement of the turn.
test('a turn with no world given reaches the live one', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)

    await assert.rejects(
        runAgent({
            settings: {...servedBy('http://127.0.0.1:1/v1'), connections: {}},
            messages: [{sender: 'user', text: 'Say hello', timestamp: 1}],
            workspacePath: workspace.path,
            emit: () => {}
        }),
        /The selected model .* is unavailable/
    )
})

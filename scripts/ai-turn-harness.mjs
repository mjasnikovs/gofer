/**
 * The fixtures every AI turn test is written against: one settings object, one mock model server,
 * one temporary workspace, and the catalog of domain tools a turn is offered.
 *
 * These sat at the top of `ai-worker.test.mjs`, which is where all sixty-seven of these tests sat —
 * a file named after a module it never imported, holding the tests for five others. The tests moved
 * to the modules whose interfaces they cross. The fixtures they share moved here, because a fixture
 * four files reach for belongs to none of them.
 *
 * Not a test file: it declares nothing and asserts nothing. Everything here is scaffolding for
 * something that does.
 */

import {createServer} from 'node:http'
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

export const MODEL_ID = 'Qwen3.6-27B-UD-Q4_K_XL.gguf'

export const settings = {
    connectionType: 'openai-compatible',
    connections: {
        'openai-compatible': {
            name: 'Local AI',
            baseUrl: '',
            api: 'openai-completions',
            chatTemplateThinking: false,
            model: {id: MODEL_ID}
        }
    }
}

/**
 * The same settings pointed at one server, with whatever this test needs changed on the way.
 *
 * `model` lands on the live connection's model half and `connection` on its address half; anything
 * else is the file's own tuning. Written once because forty-odd tests here differ from each other
 * only in which port the mock server came up on.
 */
export function servedBy(baseUrl, {model = {}, connection = {}, ...tuning} = {}) {
    const live = settings.connections['openai-compatible']
    return {
        ...settings,
        ...tuning,
        connections: {
            'openai-compatible': {...live, ...connection, baseUrl, model: {...live.model, ...model}}
        }
    }
}

export async function temporaryWorkspace(files = {}, outsideFiles = {}) {
    const root = await mkdtemp(join(tmpdir(), 'gofer-worker-'))
    const path = join(root, 'workspace')
    await mkdir(path)
    for (const [name, contents] of Object.entries(files))
        await writeFile(join(path, name), contents)
    for (const [name, contents] of Object.entries(outsideFiles))
        await writeFile(join(root, name), contents)
    return {path, remove: () => rm(root, {recursive: true, force: true})}
}

export function startServer() {
    let body = ''
    let authorization = ''
    let headers = {}
    const server = createServer((request, response) => {
        authorization = request.headers.authorization ?? ''
        headers = request.headers
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
                    model: MODEL_ID,
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
                    model: MODEL_ID,
                    choices: [{index: 0, delta: {content: ' Gofer'}, finish_reason: null}]
                })}\n\n`
            )
            response.write(
                `data: ${JSON.stringify({
                    id: 'chatcmpl-test',
                    object: 'chat.completion.chunk',
                    created: 1,
                    model: MODEL_ID,
                    choices: [{index: 0, delta: {}, finish_reason: 'stop'}],
                    usage: {prompt_tokens: 4, completion_tokens: 2, total_tokens: 6}
                })}\n\n`
            )
            response.end('data: [DONE]\n\n')
        })
    })
    return {
        server,
        request: () => ({body: JSON.parse(body), authorization, headers})
    }
}

export const catalog = [
    {
        name: 'godot_scene',
        description: 'The edited scene.',
        operations: [
            {op: 'get_tree', summary: 'Returns the edited scene hierarchy.'},
            {op: 'save', summary: 'Saves the edited scene.'}
        ]
    },
    {
        name: 'godot_runtime',
        description: 'The running game.',
        operations: [{op: 'capture', summary: 'Captures a PNG frame.'}]
    },
    {
        name: 'godot_resource',
        description: 'Project resources.',
        operations: [{op: 'delete', summary: 'Deletes a resource. Asks the user first.'}]
    },
    // The tool the reachability pass was written for: it answers through a sidecar and a model
    // cache, so it is the one that can be declared with nothing behind it.
    {
        name: 'godot_docs_search',
        description: 'The Godot documentation on this machine.',
        operations: [{op: 'search', summary: 'Retrieves ranked passages: {question}.'}]
    }
]

/**
 * The backend's half of the startup reachability probe.
 *
 * Every fake backend below answers it, because a turn no longer starts against a tool that does
 * not answer — which is the whole point of the pass. A fake that stayed silent would be testing a
 * backend the application would refuse to talk to.
 */
export function isProbe(call) {
    return call.params?.probe === true
}

export function probeResult(call) {
    return {type: 'tool-result', id: call.id, ok: true, result: {tool: call.tool, reachable: true}}
}

/** The tool calls a turn made, with the startup probes taken out. */
export function withoutProbes(calls) {
    return calls.filter(call => !isProbe(call))
}

/** A model that answers with one tool call, then with text once the tool result comes back. */
export function startToolCallingServer(tool, args) {
    let turn = 0
    const server = createServer((request, response) => {
        request.on('data', () => undefined)
        request.on('end', () => {
            turn += 1
            const delta =
                turn === 1 ?
                    {
                        role: 'assistant',
                        tool_calls: [
                            {
                                index: 0,
                                id: 'call-tool',
                                type: 'function',
                                function: {name: tool, arguments: JSON.stringify(args)}
                            }
                        ]
                    }
                :   {role: 'assistant', content: 'Scene inspected'}
            response.writeHead(200, {'content-type': 'text/event-stream'})
            response.write(
                `data: ${JSON.stringify({
                    id: 'chatcmpl-tool',
                    object: 'chat.completion.chunk',
                    created: 1,
                    model: MODEL_ID,
                    choices: [{index: 0, delta, finish_reason: null}]
                })}\n\n`
            )
            response.write(
                `data: ${JSON.stringify({
                    id: 'chatcmpl-tool',
                    object: 'chat.completion.chunk',
                    created: 1,
                    model: MODEL_ID,
                    choices: [
                        {index: 0, delta: {}, finish_reason: turn === 1 ? 'tool_calls' : 'stop'}
                    ],
                    usage: {prompt_tokens: 8, completion_tokens: 2, total_tokens: 10}
                })}\n\n`
            )
            response.end('data: [DONE]\n\n')
        })
    })
    return server
}

/**
 * A model scripted turn by turn: `calls` answers with tool calls, `text` ends the turn on a
 * message. The request bodies are kept because half of what these tests prove is what reaches the
 * model — an error code it must read, an image it must see, a tool it was never asked to confirm.
 *
 * `usage` is what the server says the request cost, which is the number compaction has to trust
 * over any estimate. `error` fails the request the way llama.cpp does, body and status and all.
 */
export function startScriptedServer(turns) {
    const bodies = []
    let turn = 0
    const server = createServer((request, response) => {
        let body = ''
        request.on('data', chunk => {
            body += chunk
        })
        request.on('end', () => {
            bodies.push(JSON.parse(body))
            const script = turns[Math.min(turn, turns.length - 1)]
            turn += 1
            if (script.error) {
                response.writeHead(script.error.status ?? 400, {
                    'content-type': 'application/json'
                })
                // `body` for a gateway that answers with more than a sentence. OpenRouter puts the
                // real cause and the one thing the user can do about it in `metadata`, and a test
                // about how that reaches a person cannot be written against a shape this harness
                // makes up. Absent, it is the one-line body llama.cpp sends.
                response.end(
                    JSON.stringify(
                        script.error.body ?? {
                            error: {message: script.error.message, type: 'invalid_request_error'}
                        }
                    )
                )
                return
            }
            const calls = script.calls ?? []
            const delta =
                calls.length > 0 ?
                    {
                        role: 'assistant',
                        tool_calls: calls.map((call, index) => ({
                            index,
                            id: `call-${String(turn)}-${String(index)}`,
                            type: 'function',
                            function: {name: call.name, arguments: JSON.stringify(call.args)}
                        }))
                    }
                : script.reasoning !== undefined ?
                    {role: 'assistant', reasoning: script.reasoning, content: script.text ?? ''}
                :   {role: 'assistant', content: script.text ?? 'Done'}
            const frame = choices => ({
                id: `chatcmpl-${String(turn)}`,
                object: 'chat.completion.chunk',
                created: 1,
                model: MODEL_ID,
                choices
            })
            response.writeHead(200, {'content-type': 'text/event-stream'})
            response.write(
                `data: ${JSON.stringify(frame([{index: 0, delta, finish_reason: null}]))}\n\n`
            )
            response.write(
                `data: ${JSON.stringify({
                    ...frame([
                        {
                            index: 0,
                            delta: {},
                            finish_reason: calls.length > 0 ? 'tool_calls' : 'stop'
                        }
                    ]),
                    usage: script.usage ?? {
                        prompt_tokens: 8,
                        completion_tokens: 2,
                        total_tokens: 10
                    }
                })}\n\n`
            )
            response.end('data: [DONE]\n\n')
        })
    })
    return {bodies, server}
}

export async function baseUrl(context, server) {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    context.after(() => server.close())
    return `http://127.0.0.1:${String(server.address().port)}/v1`
}

export const NO_USAGE = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}
}

/**
 * A stored conversation long enough to cross the compaction line.
 *
 * Every turn reports no usage, so the size the worker measures comes from the text itself rather
 * than from a server's token accounting — which is what makes the line the test crosses a number
 * the test controls.
 */
export function longConversation(pairs, characters) {
    const messages = []
    for (let index = 0; index < pairs; index += 1) {
        messages.push({role: 'user', content: 'u'.repeat(characters), timestamp: index * 2 + 1})
        messages.push({
            role: 'assistant',
            content: [{type: 'text', text: 'a'.repeat(characters)}],
            api: 'openai-completions',
            provider: 'local',
            model: MODEL_ID,
            usage: NO_USAGE,
            stopReason: 'stop',
            timestamp: index * 2 + 2
        })
    }
    return messages
}

/**
 * One step of agentic work in the shape the agent stores it: a call, then its result.
 *
 * This is what a long turn is almost entirely made of. A conversation of six bubbles on screen was
 * two hundred and thirty five of these in the transcript on disk, so what a retry does to them is
 * what a retry does to the model's memory.
 */
export function toolStep(marker, at) {
    return [
        {
            role: 'assistant',
            content: [
                {type: 'text', text: `Working on ${marker}`},
                {type: 'toolCall', id: `call-${marker}`, name: 'bash', arguments: {command: 'ls'}}
            ],
            api: 'openai-completions',
            provider: 'local',
            model: MODEL_ID,
            usage: NO_USAGE,
            stopReason: 'toolUse',
            timestamp: at
        },
        {
            role: 'toolResult',
            toolCallId: `call-${marker}`,
            toolName: 'bash',
            content: [{type: 'text', text: `result of ${marker}`}],
            isError: false,
            timestamp: at + 1
        }
    ]
}

/** One settled exchange in the shape the agent stores it. */
export function settledTurn(prompt, answer, at) {
    return [
        {role: 'user', content: prompt, timestamp: at},
        {
            role: 'assistant',
            content: [{type: 'text', text: answer}],
            api: 'openai-completions',
            provider: 'local',
            model: MODEL_ID,
            usage: NO_USAGE,
            stopReason: 'stop',
            timestamp: at + 1
        }
    ]
}

/** The turn-level retry only. `maxRetries: 0` switches the provider's own HTTP retry off. */
export const impatient = {maxRetries: 0}

/**
 * A clock that owes nothing: every wait is written down and then run at once.
 *
 * The retry policy used to be proved by shortening it — `retryBaseDelayMs: 1` — which paid real
 * milliseconds to test a curve that was no longer the shipped one. On this clock the tests run the
 * defaults, five seconds doubling to a minute, and `waited` is what the loop actually asked for.
 */
export function instantTimers() {
    const waited = []
    return {
        waited,
        now: () => Date.now(),
        schedule(fn, ms) {
            waited.push(ms)
            queueMicrotask(fn)
            return waited.length
        },
        cancel: () => undefined,
        repeat: (fn, ms) => setInterval(fn, ms),
        stopRepeat: handle => {
            clearInterval(handle)
        }
    }
}

/** A child given a model of its own: a small one to read with, on the connection it names. */
export const SMALL_MODEL = {
    connectionType: 'openai-compatible',
    model: {
        id: 'small.gguf',
        name: 'Small',
        contextWindow: 8192,
        maxTokens: 4096,
        reasoning: false,
        supportsReasoningEffort: false,
        input: ['text'],
        thinkingLevel: 'off'
    }
}

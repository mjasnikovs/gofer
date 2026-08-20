import assert from 'node:assert/strict'
import test from 'node:test'
import {createAssistantMessageEventStream} from '@earendil-works/pi-ai'
import {
    createDesignWithUserTool,
    DESIGN_PROBE_ANSWER,
    DESIGN_SESSION_TOOL_NAME,
    DESIGN_TOOL_NAME
} from './ai-design.mjs'
import {
    CHILD_TOOL_NAMES,
    createChildTools,
    DESIGN_TOOL_NAMES,
    SUBAGENT_TOOL_NAMES
} from './ai-subagent.mjs'

/*
 * The design loop is the only child in this codebase allowed to interrupt the user, and everything
 * here is about that being deliberate rather than accidental.
 */

const model = {id: 'test-model', api: 'openai-completions', provider: 'test'}

function designTool(overrides = {}) {
    return createDesignWithUserTool({
        workspacePath: process.cwd(),
        models: {streamSimple: () => assert.fail('the probe must not reach a provider')},
        model,
        thinkingLevel: 'off',
        streamOptions: {},
        settings: {maxShows: 4},
        host: {call: () => assert.fail('a probe must not open a dialog')},
        ...overrides
    })
}

/**
 * The delegation tool must not gain the window as a side effect of the design loop having it.
 *
 * That split is the whole reason `CHILD_TOOL_NAMES` and the per-caller rations are separate
 * constants: widening the ceiling for one caller must not hand every other caller the same reach.
 */
test('only the design loop may reach the user, and the ceiling was widened on purpose', () => {
    assert.ok(CHILD_TOOL_NAMES.includes('ask_user'))
    assert.ok(DESIGN_TOOL_NAMES.includes('ask_user'))
    assert.ok(!SUBAGENT_TOOL_NAMES.includes('ask_user'))
})

/**
 * A child that could delegate again, write, or reach the editor would stop being a child.
 *
 * `design_with_user` is on this list for the reason `web_fetch` is: it holds a child of its own, so
 * a child holding it is a grandchild. `ask_user` is not, because it builds no agent — it is rationed
 * by a count instead, which is the thing a tool list cannot check.
 */
test('nothing that would make a child something else is on the ceiling', () => {
    for (const name of ['write', 'edit', 'subagent', 'web_fetch', DESIGN_TOOL_NAME])
        assert.ok(!CHILD_TOOL_NAMES.includes(name), `${name} must not be a tool a child may hold`)
})

test('a delegation with no brief is refused by name rather than started empty', async () => {
    const tool = designTool()
    await assert.rejects(() => tool.execute('id', {brief: '   '}), /no brief/u)
})

/**
 * A machine set never to be interrupted has nobody for a design loop to talk to.
 *
 * Refused here rather than discovered inside the child, where it would arrive as a tool that
 * mysteriously refuses every showing and a delegation that answers with nothing.
 */
test('a ration of zero is refused with somewhere else to go', async () => {
    const tool = designTool({settings: {maxShows: 0}})
    await assert.rejects(() => tool.execute('id', {brief: 'a pause menu'}), /ask_user/u)
})

/** The probe drives the real child against a canned provider, so it costs no network call. */
test('the probe builds the child, runs a turn and answers without a provider', async () => {
    const tool = designTool({host: {call: () => Promise.resolve({})}})
    const result = await tool.execute('id', {probe: true})
    assert.match(result.content[0].text, new RegExp(DESIGN_PROBE_ANSWER, 'u'))
})

/** A probe puts nothing on screen, and a session opened is something on screen. */
test('the probe opens no design session', async () => {
    const named = []
    const tool = designTool({
        host: {
            call: name => {
                named.push(name)
                return Promise.resolve({})
            }
        }
    })
    await tool.execute('id', {probe: true})
    assert.ok(!named.includes(DESIGN_SESSION_TOOL_NAME))
})

/**
 * A session records what the window has no other way to know: where the loop starts and stops.
 *
 * Without the closing edge the card holds itself open over a design that finished — which is the
 * failure this seam exists to remove, arrived at from the other side.
 */
test('a design loop tells the window when it starts and when it is over', async () => {
    const states = []
    const tool = designTool({
        models: {streamSimple: () => assert.fail('no provider in this test')},
        host: {
            call: (name, request) => {
                if (name === DESIGN_SESSION_TOOL_NAME) states.push(request)
                return Promise.resolve({})
            }
        }
    })

    await assert.rejects(() => tool.execute('id', {brief: 'a pause menu'}))

    assert.deepEqual(
        states.map(state => state.state),
        ['open', 'closed'],
        'a loop that failed must still close its card'
    )
    assert.equal(states[0].sessionId, states[1].sessionId)
})

/**
 * The child asks under the session its parent opened.
 *
 * Two seams away from each other — the tool mints the identifier, `createChildTools` hands it to the
 * one tool that can reach the user — and a session that stopped halfway between them would look
 * exactly like today's bug: a card that closes on every answer.
 */
test('the ration and the session both reach the child through the same deps', () => {
    const sent = []
    const host = {
        call: (_name, request) => {
            sent.push(request)
            return Promise.resolve({questionId: 'question-1', answer: 'y'})
        }
    }
    const {tools} = createChildTools(process.cwd(), {
        toolNames: ['ask_user'],
        deps: {host, asks: 4, sketchesRequired: true, sessionId: 'design-7'}
    })

    const ask = tools.find(tool => tool.name === 'ask_user')
    return ask
        .execute('id', {
            question: 'which?',
            sketches: [{label: 'Bar across the top', html: '<p>a</p>'}]
        })
        .then(() => {
            assert.equal(sent[0].designSession, 'design-7')
        })
})

/**
 * A provider that answers from a script instead of a socket.
 *
 * The design loop is a loop around a model, so the only way to make "asks, is answered, asks again"
 * deterministic is to write down what the model says back. A real server would be testing the
 * server. The shape is the one `ai-subagent.test.mjs` uses for the same reason.
 */
function scriptedModels(script) {
    let turn = 0
    return {
        get turns() {
            return turn
        },
        streamSimple: requested => {
            const step = script[Math.min(turn, script.length - 1)]
            turn += 1
            const calls = step.calls ?? []
            const message = {
                role: 'assistant',
                content: [
                    ...(step.text ? [{type: 'text', text: step.text}] : []),
                    ...calls.map((call, index) => ({
                        type: 'toolCall',
                        id: `call-${String(turn)}-${String(index)}`,
                        name: call.name,
                        arguments: call.args
                    }))
                ],
                api: requested.api,
                provider: requested.provider,
                model: requested.id,
                usage: {
                    input: 1,
                    output: 1,
                    cacheRead: 0,
                    cacheWrite: 0,
                    totalTokens: 2,
                    cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}
                },
                stopReason: calls.length > 0 ? 'toolUse' : 'stop',
                timestamp: 0
            }
            const stream = createAssistantMessageEventStream()
            queueMicrotask(() => {
                stream.push({
                    type: 'done',
                    reason: calls.length > 0 ? 'toolUse' : 'stop',
                    message
                })
                stream.end(message)
            })
            return stream
        }
    }
}

const SKETCH = [{label: 'Bar across the top', html: '<p>a</p>'}]

/**
 * The whole loop, once, through the real child and the real tools.
 *
 * Everything else here tests one seam. This runs them together, because the failure that started
 * this work lived between them: every piece behaved, and the card still closed and reopened on every
 * round. What it asserts, in order — the loop opens before the child exists, every question the
 * child asks carries that same loop, and the loop closes when the tool returns.
 */
test('a whole design loop opens, asks under one session, and closes', async () => {
    const calls = []
    const tool = designTool({
        models: scriptedModels([
            {calls: [{name: 'ask_user', args: {question: 'which?', sketches: SKETCH}}]},
            {
                calls: [
                    {
                        name: 'ask_user',
                        args: {question: 'and now?', questionId: 'question-1', sketches: SKETCH}
                    }
                ]
            },
            {text: 'The header sits at the top, 64px tall, 24px of padding.'}
        ]),
        host: {
            call: (name, request) => {
                calls.push({name, request})
                if (name !== 'ask_user') return Promise.resolve({})
                return Promise.resolve({
                    questionId: 'question-1',
                    answer: 'tighter',
                    sketches: 1
                })
            }
        }
    })

    const result = await tool.execute('id', {brief: 'a pause menu'})

    const sessions = calls.filter(call => call.name === DESIGN_SESSION_TOOL_NAME)
    const asks = calls.filter(call => call.name === 'ask_user')
    assert.deepEqual(
        sessions.map(call => call.request.state),
        ['open', 'closed']
    )
    assert.equal(asks.length, 2, 'both rounds reached the window')
    // One loop, not one per question. This is the whole point of the seam.
    const loop = sessions[0].request.sessionId
    for (const ask of asks) assert.equal(ask.request.designSession, loop)
    // Opened before anything was asked and closed after everything was.
    assert.equal(calls[0].name, DESIGN_SESSION_TOOL_NAME)
    assert.equal(calls.at(-1).request.state, 'closed')
    assert.match(result.content[0].text, /64px tall/u)
})

/**
 * The button that ends the loop ends it, even against a model that would rather keep going.
 *
 * Here the child is scripted to ask again after being told the design is agreed, because that is the
 * case a sentence in a system prompt cannot cover. The ration is spent at the moment of approval, so
 * the second question is answered by the tool and never reaches the window.
 */
test('a model that asks again after approval is answered rather than shown', async () => {
    const asks = []
    const tool = designTool({
        models: scriptedModels([
            {calls: [{name: 'ask_user', args: {question: 'which?', sketches: SKETCH}}]},
            {calls: [{name: 'ask_user', args: {question: 'sure?', sketches: SKETCH}}]},
            {text: 'A single column, 720px wide, centred.'}
        ]),
        host: {
            call: (name, request) => {
                if (name !== 'ask_user') return Promise.resolve({})
                asks.push(request)
                return Promise.resolve({
                    questionId: 'question-1',
                    approved: true,
                    picked: {index: 0, label: 'Bar across the top'},
                    sketches: 1
                })
            }
        }
    })

    await tool.execute('id', {brief: 'a pause menu'})

    assert.equal(asks.length, 1, 'the user was interrupted once and then not again')
})

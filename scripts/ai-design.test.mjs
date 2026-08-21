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
    const seen = []
    return {
        get turns() {
            return turn
        },
        /** Every context the child was run with, so a test can ask what it was actually sent. */
        get seen() {
            return seen
        },
        streamSimple: (requested, context) => {
            seen.push(context)
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

/**
 * The agreement in words, and the drawing it is about.
 *
 * The child is still told not to paste its markup, and that is still right: it would spend the
 * child's own output on the round it should be summarising. This is the same drawing arriving the
 * other way — copied by the tool from what the window already had, after the answer is whole. It is
 * here because prose alone was not enough. A description of a dock reads as complete and still
 * leaves the builder guessing at what the user looked at, and the first build off one came back
 * close and wrong.
 */
test('the layout the user agreed comes back drawn as well as described', async () => {
    const tool = designTool({
        models: scriptedModels([
            {calls: [{name: 'ask_user', args: {question: 'which?', sketches: SKETCH}}]},
            {text: 'The dock sits bottom-left, 576x84.'}
        ]),
        host: {
            call: name => {
                if (name !== 'ask_user') return Promise.resolve({})
                return Promise.resolve({
                    questionId: 'question-1',
                    approved: true,
                    picked: {index: 0, label: 'Bar across the top'},
                    sketch: {label: 'Bar across the top', html: '<p>the agreed one</p>'},
                    sketches: 1
                })
            }
        }
    })

    const {text} = (await tool.execute('id', {brief: 'a squad dock'})).content[0]

    assert.match(text, /The dock sits bottom-left/u, 'the agreement in words is still first')
    assert.match(text, /<p>the agreed one<\/p>/u, 'and the drawing is under it')
    assert.match(text, /Bar across the top/u, 'named, so it can be talked about')
})

/**
 * A layout the user turned down is not appended, whatever else is true.
 *
 * Every ending that is not an approval leaves a last sketch behind, and the user may have rejected
 * it in as many words. Handed over under a sentence saying they agreed it, it is the one layout
 * they said no to arriving as the one to build.
 */
test('a layout that was never agreed is not handed over as agreed', async () => {
    const tool = designTool({
        models: scriptedModels([
            {calls: [{name: 'ask_user', args: {question: 'which?', sketches: SKETCH}}]},
            {text: 'They asked for changes and then stopped answering.'}
        ]),
        host: {
            call: name => {
                if (name !== 'ask_user') return Promise.resolve({})
                return Promise.resolve({
                    questionId: 'question-1',
                    approved: false,
                    answer: 'no, much wider',
                    picked: {index: 0, label: 'Bar across the top'},
                    sketch: {label: 'Bar across the top', html: '<p>REJECTED</p>'},
                    sketches: 1
                })
            }
        }
    })

    const {text} = (await tool.execute('id', {brief: 'a squad dock'})).content[0]

    assert.ok(!text.includes('REJECTED'), 'the rejected layout must not be handed over')
    assert.ok(!text.includes('they agreed'))
})

/**
 * An answer nobody approved must not read as an agreement.
 *
 * This is the defect the whole line exists for. The child stopped after one round — out of patience
 * rather than out of ration — and wrote a confident specification anyway, and the parent read it and
 * told the user they had agreed on a layout they had never even been asked to approve.
 */
test('a design the user never ended says so before it says anything else', async () => {
    const tool = designTool({
        models: scriptedModels([
            {calls: [{name: 'ask_user', args: {question: 'which?', sketches: SKETCH}}]},
            {text: 'The dock sits bottom-left.'}
        ]),
        host: {
            call: name => {
                if (name !== 'ask_user') return Promise.resolve({})
                return Promise.resolve({
                    questionId: 'question-1',
                    approved: false,
                    answer: 'bigger rows',
                    sketch: {label: 'Bar across the top', html: '<p>a</p>'},
                    sketches: 1
                })
            }
        }
    })

    const {text} = (await tool.execute('id', {brief: 'a squad dock'})).content[0]

    assert.match(text, /^THE USER DID NOT AGREE THIS\./u)
    assert.match(text, /shown 1 round/u)
    assert.match(text, /proposal, not a decision/u)
})

/** A child that answered without asking anybody is the same lie with nobody in the room at all. */
test('a design nobody was ever shown says nobody was shown it', async () => {
    const tool = designTool({
        models: scriptedModels([{text: 'The dock sits bottom-left.'}]),
        host: {call: () => Promise.resolve({})}
    })

    const {text} = (await tool.execute('id', {brief: 'a squad dock'})).content[0]

    assert.match(text, /^THE USER DID NOT AGREE THIS\./u)
    assert.match(text, /never shown anything at all/u)
})

/** And an approval says none of it, or the sentence would mean nothing where it matters. */
test('an agreed design carries no warning', async () => {
    const tool = designTool({
        models: scriptedModels([
            {calls: [{name: 'ask_user', args: {question: 'which?', sketches: SKETCH}}]},
            {text: 'The dock sits bottom-left.'}
        ]),
        host: {
            call: name => {
                if (name !== 'ask_user') return Promise.resolve({})
                return Promise.resolve({
                    questionId: 'question-1',
                    approved: true,
                    sketch: {label: 'Bar across the top', html: '<p>a</p>'},
                    sketches: 1
                })
            }
        }
    })

    const {text} = (await tool.execute('id', {brief: 'a squad dock'})).content[0]

    assert.ok(!text.includes('DID NOT AGREE'))
})

/**
 * A picture the child could not be shown is a picture the parent has to be told about.
 *
 * A layout drawn without the screenshot it was asked about is wrong in a way only the person who
 * attached the screenshot can see, and a silent drop is how the first build of this tool failed.
 */
test('a design agreed without the pictures says so', async () => {
    const tool = designTool({
        models: scriptedModels([{text: 'Agreed.'}]),
        images: [{type: 'image', data: 'AAAA', mimeType: 'image/png'}],
        host: {call: () => Promise.resolve({})}
    })

    const {text} = (await tool.execute('id', {brief: 'a squad dock'})).content[0]

    assert.match(text, /never reached the design loop/u)
    assert.match(text, /project files alone/u)
})

/** A child that can see is told nothing, because nothing went missing. */
test('a design agreed with the pictures says nothing about them', async () => {
    const tool = designTool({
        model: {...model, input: ['text', 'image']},
        models: scriptedModels([{text: 'Agreed.'}]),
        images: [{type: 'image', data: 'AAAA', mimeType: 'image/png'}],
        host: {call: () => Promise.resolve({})}
    })

    const {text} = (await tool.execute('id', {brief: 'a squad dock'})).content[0]

    assert.ok(!text.includes('never reached the design loop'))
})

/** A loop that showed nothing back appends nothing: there is no drawing to hand over. */
test('an answer with no drawing behind it appends nothing', async () => {
    const tool = designTool({
        models: scriptedModels([
            {calls: [{name: 'ask_user', args: {question: 'which?', sketches: SKETCH}}]},
            {text: 'They walked away.'}
        ]),
        host: {
            call: name =>
                Promise.resolve(
                    name === 'ask_user' ? {questionId: 'question-1', skipped: true} : {}
                )
        }
    })

    const {text} = (await tool.execute('id', {brief: 'a squad dock'})).content[0]

    assert.match(text, /They walked away\./u)
    assert.ok(!text.includes('they agreed'), 'nothing was agreed, so nothing is claimed to be')
})

/**
 * The screenshot the ask came with reaches the child.
 *
 * It did not, for the first build, and nothing said so. The picture went into the parent's context
 * and the child was handed a brief saying "the provided screenshot" with nothing provided — so it
 * drew from the project files alone and what came back was close and not right.
 */
test('the pictures the user attached are what the child designs against', async () => {
    const picture = {type: 'image', data: 'AAAA', mimeType: 'image/png'}
    const models = scriptedModels([{text: 'Agreed.'}])
    const tool = designTool({
        model: {...model, input: ['text', 'image']},
        models,
        images: [picture],
        host: {call: () => Promise.resolve({})}
    })

    await tool.execute('id', {brief: 'a squad dock'})

    const parts = models.seen[0].messages.flatMap(message =>
        Array.isArray(message.content) ? message.content : []
    )
    assert.deepEqual(
        parts.filter(part => part.type === 'image'),
        [picture]
    )
})

/**
 * A child whose model has no eyes is sent none.
 *
 * Not a detail lost: the provider refuses the whole request, so an unchecked picture would end the
 * design loop at its first step rather than at its worst draft.
 */
test('a child that cannot see is sent no pictures at all', async () => {
    const models = scriptedModels([{text: 'Agreed.'}])
    const tool = designTool({
        models,
        images: [{type: 'image', data: 'AAAA', mimeType: 'image/png'}],
        host: {call: () => Promise.resolve({})}
    })

    await tool.execute('id', {brief: 'a squad dock'})

    const parts = models.seen[0].messages.flatMap(message =>
        Array.isArray(message.content) ? message.content : []
    )
    assert.equal(parts.filter(part => part.type === 'image').length, 0)
})

import assert from 'node:assert/strict'
import test from 'node:test'
import {createAssistantMessageEventStream} from '@earendil-works/pi-ai'
import {answerText, ASK_PROBE_ANSWER, ASK_USER_TOOL_NAME, createAskUserTool} from './ai-ask.mjs'
import {ASK_LOOP_PROBE_ANSWER, createAskDelegate} from './ai-ask-loop.mjs'
import {
    CHILD_TOOL_NAMES,
    createChildTools,
    DESIGN_TOOL_NAMES,
    SUBAGENT_TOOL_NAMES
} from './ai-subagent.mjs'

/*
 * One tool with two halves, and most of it is wording.
 *
 * What reaches the model is one paragraph, and half these tests are a paragraph that was wrong in a
 * way that costs a round trip: an approval read as feedback, a pick read as half an answer, a
 * blocked webfont read as the user disliking a layout. The other half is the delegating side, where
 * the failure is louder — a layout nobody agreed to coming back as one they did.
 */

const model = {id: 'test-model', api: 'openai-completions', provider: 'test'}

test('a skip tells the model to decide it, not to ask again', () => {
    const text = answerText({questionId: 'question-1', skipped: true})
    assert.match(text, /chose not to decide this/u)
    assert.match(text, /Do not ask again/u)
})

test('a question answered in words comes back as words', () => {
    const text = answerText({questionId: 'question-1', answer: 'its own scene'})
    assert.match(text, /They said: "its own scene"/u)
})

/**
 * Any answer can be followed up, not only one about a layout.
 *
 * This was told to a model that had shown a sketch and to nothing else, which is the old two-tool
 * split leaking back in through the wording: a layout could be refined and a question could not. It
 * is one tool and one block either way, with a round counter on it, and a follow-up asked as a NEW
 * question is the pile of unrelated cards this seam replaced a modal to remove.
 */
test('a plain question in words can still be asked again under the same id', () => {
    const text = answerText({questionId: 'question-1', answer: 'its own scene'})
    assert.match(text, /questionId question-1/u)
    assert.match(text, /same decision/u)
})

/** And a skip cannot: the user declined to decide, so asking again is the one thing forbidden. */
test('a skip is never invited to ask again', () => {
    const text = answerText({questionId: 'question-1', skipped: true})
    assert.doesNotMatch(text, /questionId/u)
})

/**
 * Words about a sketch are a change to it, and a changed layout is the same question again.
 *
 * Asked as a new question instead, the user is shown a second card about a decision they are in the
 * middle of, and neither they nor the model can tell the two apart afterwards.
 */
test('words about a sketch ask for the revision under the same id', () => {
    const text = answerText({questionId: 'question-9', answer: 'the title is too big', sketches: 2})
    assert.match(text, /questionId question-9/u)
})

/**
 * The identifier is named bare, because the real model copies what it is shown.
 *
 * Quoted, it sent `"question-9"` — a different identifier — so the revision counter started again at
 * one and the fourth draft was drawn as the first. Measured against the local model, not imagined.
 * The reader trims quotes as well; this is the half that stops it happening at all.
 */
test('the identifier a revision is asked under is never wrapped in quotes', () => {
    const text = answerText({questionId: 'question-9', answer: 'smaller', sketches: 2})
    assert.doesNotMatch(text, /"question-9"/u)
    assert.match(text, /no quotation marks/u)
})

/**
 * A pick with nothing written is a whole answer.
 *
 * Left to speak for itself it reads as half of one, and the next thing the model does is ask the
 * user to justify a choice they already made.
 */
test('a pick with no note says so, so nothing asks the user to justify it', () => {
    const text = answerText({
        questionId: 'question-1',
        picked: {index: 0, label: 'Bar across the top'}
    })
    assert.match(text, /picked "Bar across the top" \(sketch 1\)/u)
    assert.match(text, /do not ask them to justify it/iu)
    assert.match(text, /do not ask again/iu)
})

/**
 * Inside a delegation the same click means something else.
 *
 * There is a button that ends a design and picking a sketch is not it. Read as the end, one click on
 * a variant the user liked came back to the parent as a whole layout they had agreed to.
 */
test('a pick inside a delegation is a preference, not the end of it', () => {
    const text = answerText(
        {questionId: 'question-1', picked: {index: 0, label: 'Bar across the top'}},
        {inDesign: true}
    )
    assert.match(text, /not the end of the design/u)
    assert.match(text, /show it to them again/u)
    assert.doesNotMatch(text, /do not ask again/iu)
})

/**
 * What the policy refused is named in the text, not only in the details.
 *
 * The model reads content parts and nothing else, and the frame has no console for it to read
 * instead. Recorded but never said, a blocked webfont is a sketch that rendered in the wrong
 * typeface for a reason nobody in the loop can see.
 */
test('blocked resources are named in the sentence the model reads', () => {
    const text = answerText({
        questionId: 'question-5',
        answer: 'ugly',
        blocked: ['https://fonts.googleapis.com/…/css2']
    })
    assert.match(text, /fonts\.googleapis\.com/u)
    assert.match(text, /res:\/\/ path/u)
})

/** A project file that is missing is a different mistake from a request the policy refused. */
test('a project asset that did not go in is reported apart from what was blocked', () => {
    const text = answerText({
        questionId: 'question-6',
        answer: 'fine',
        unresolved: ['res://fonts/Title.ttf (no such file)']
    })
    assert.match(text, /did not go into the sketch/u)
    assert.match(text, /Check the path against the project/u)
})

test('a skip still reports what could not load', () => {
    const text = answerText({
        questionId: 'question-7',
        skipped: true,
        blocked: ['https://x.test/a.png']
    })
    assert.match(text, /chose not to decide/u)
    assert.match(text, /x\.test/u)
})

/**
 * The user asking for another round outranks the model's own reading of the answer.
 *
 * A model decides for itself whether an answer was enough. This is the user having decided it for
 * them, which is the one thing they could not say before — for an ordinary question there was no
 * control to say it with.
 */
test('a request for another round is said before anything else the answer implies', () => {
    const text = answerText({questionId: 'question-1', answer: 'narrower than that', again: true})
    assert.match(text, /NOT finished with this/u)
    assert.doesNotMatch(text, /whole answer/u)
})

/**
 * And it names the identifier, rather than saying "the same questionId".
 *
 * This branch comes before the one that used to name it, so for one build the model was told to ask
 * again under an identifier nothing had given it — and every revision of a design landed as a fresh
 * card. Measured in the real window: two rounds, no round badge on either.
 */
test('a request for another round names the identifier to ask it under', () => {
    const text = answerText({questionId: 'question-9', answer: 'narrower', again: true})
    assert.match(text, /questionId question-9/u)
    assert.doesNotMatch(text, /"question-9"/u)
})

/** And an approval still outranks it: the user cannot both end a design and ask for another round. */
test('an approval outranks a request for another round', () => {
    const text = answerText({
        questionId: 'question-1',
        answer: 'perfect',
        again: true,
        approved: true
    })
    assert.match(text, /ended the design here/u)
    assert.doesNotMatch(text, /NOT finished/u)
})

/** An approval is the end of the matter, so nothing may invite another round on the back of it. */
test('an approval is not read as a change to make', () => {
    const text = answerText({
        questionId: 'question-9',
        answer: 'perfect',
        sketches: 2,
        picked: {index: 1, label: 'Side rail'},
        approved: true
    })
    assert.match(text, /ended the design here/u)
    assert.doesNotMatch(text, /show them a revision/u)
})

/*
 * The link between a tool call and the questions it produced.
 *
 * Nothing else connects the two. The call id lives in the worker and the question id is minted in
 * Rust, so the block in the feed can only find its question if the tool puts its own call id on the
 * request — which is why the model is never asked to, and never allowed to.
 */

test('an ordinary question is owned by the call that asked it', async () => {
    const sent = []
    const host = {
        call: (_name, request) => {
            sent.push(request)
            return Promise.resolve({questionId: 'question-1', answer: 'y'})
        }
    }
    const tool = createAskUserTool({host})

    await tool.execute('call-42', {question: 'which?'})

    assert.equal(sent[0].ownerCallId, 'call-42')
    assert.equal('isDelegated' in sent[0], false)
})

/**
 * A child's questions are owned by the PARENT's call, which is what makes rounds one block.
 *
 * Owned by the child's own call instead, every round of one design would land in the feed as an
 * unrelated question — which is the failure this seam replaced a modal to remove.
 */
test('a delegated question carries the call it is asking on behalf of', async () => {
    const sent = []
    const host = {
        call: (_name, request) => {
            sent.push(request)
            return Promise.resolve({questionId: 'question-1', answer: 'y'})
        }
    }
    const tool = createAskUserTool({host, ownerCallId: 'call-parent'})

    await tool.execute('call-child', {question: 'which?'})

    assert.equal(sent[0].ownerCallId, 'call-parent')
    assert.equal(sent[0].isDelegated, true)
})

/**
 * The owner belongs to the tool, so a model cannot award itself one.
 *
 * It decides which block in the feed a question lands on, and a model that guessed at it would put
 * its question on somebody else's card — or, worse, dress an ordinary question as a delegation and
 * grow it a button that ends a loop nothing started.
 */
test('a question never carries an owner the model invented', async () => {
    let seen
    const host = {
        call: (_name, request) => {
            seen = request
            return Promise.resolve({questionId: 'question-1', answer: 'yes'})
        }
    }
    const tool = createAskUserTool({host})

    await tool.execute('call-42', {question: 'which?', ownerCallId: 'call-somebody-else'})

    assert.equal(seen.ownerCallId, 'call-42')
})

/**
 * Two schemas, no overlap: the parent hands a layout over, the child draws one.
 *
 * That is the whole of the split. With `sketches` absent from the parent's schema there is no line
 * for the model to draw between "one question" and "a design" — the old pair of tools drew it, and
 * drew it wrong.
 */
test('the two copies of the tool offer two different parameters', () => {
    const parent = createAskUserTool({host: {call: () => Promise.resolve({})}, delegate: () => {}})
    const child = createAskUserTool({host: {call: () => Promise.resolve({})}})

    assert.ok('brief' in parent.parameters.properties)
    assert.ok(!('sketches' in parent.parameters.properties))
    assert.ok('sketches' in child.parameters.properties)
    assert.ok(!('brief' in child.parameters.properties))
})

/** And a call carrying both is refused rather than guessed at, however it got written. */
test('a brief and sketches together are refused', async () => {
    let calls = 0
    const tool = createAskUserTool({
        host: {
            call: () => {
                calls += 1
                return Promise.resolve({})
            }
        },
        delegate: () => assert.fail('a refused call must not start a child')
    })

    await assert.rejects(
        () =>
            tool.execute('call-1', {
                question: 'which?',
                brief: 'a pause menu',
                sketches: [{label: 'a', html: '<p>a</p>'}]
            }),
        /brief AND sketches/u
    )
    assert.equal(calls, 0, 'a refused question never reaches the window')
})

/** A parent that drew its own markup is told where to send it instead. */
test('the parent is refused sketches and pointed at the brief', async () => {
    const tool = createAskUserTool({
        host: {call: () => assert.fail('a refused question never reaches the window')},
        delegate: () => assert.fail('a refused call must not start a child')
    })

    await assert.rejects(
        () =>
            tool.execute('call-1', {
                question: 'which?',
                sketches: [{label: 'a', html: '<p>a</p>'}]
            }),
        /send a `brief`/u
    )
})

/**
 * And the mirror of it, which is the one that used to be missing.
 *
 * The child's schema does not declare `brief`, which is not the same as the child never sending
 * one — its whole prompt is about a brief. Unguarded, that call reached `await delegate(...)` with
 * no delegate there and the model's tool result was `delegate is not a function`.
 */
test('the child is refused a brief and pointed at its own sketches', async () => {
    const tool = createAskUserTool({
        host: {call: () => assert.fail('a refused question never reaches the window')}
    })

    await assert.rejects(
        () => tool.execute('call-1', {question: 'which?', brief: 'a pause menu'}),
        /send `sketches`/u
    )
})

/*
 * The delegating half: a brief goes to a child, and the parent is handed what was agreed.
 */

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

/** The parent's copy of the tool, with a real delegate behind it. */
function askTool({host = {call: () => Promise.resolve({})}, ...overrides} = {}) {
    return createAskUserTool({
        host,
        delegate: createAskDelegate({
            workspacePath: process.cwd(),
            models: {streamSimple: () => assert.fail('the probe must not reach a provider')},
            model,
            thinkingLevel: 'off',
            streamOptions: {},
            settings: {},
            host,
            ...overrides
        })
    })
}

/** Answers every question the same way, and records what was asked. */
function answering(reply) {
    const asks = []
    return {
        asks,
        call: (name, request) => {
            if (name !== ASK_USER_TOOL_NAME) return Promise.resolve({})
            asks.push(request)
            return Promise.resolve({questionId: 'question-1', ...reply})
        }
    }
}

/**
 * The one child allowed to reach the user, and the ceiling widened for it on purpose.
 *
 * That split is why `CHILD_TOOL_NAMES` and the per-caller lists are separate constants: widening the
 * ceiling for one caller must not hand every other caller the same reach.
 */
test('only a delegated design may reach the user, and the ceiling was widened on purpose', () => {
    assert.ok(CHILD_TOOL_NAMES.includes('ask_user'))
    assert.ok(DESIGN_TOOL_NAMES.includes('ask_user'))
    assert.ok(!SUBAGENT_TOOL_NAMES.includes('ask_user'))
})

/**
 * A child that could delegate again, write, or reach the editor would stop being a child.
 *
 * `ask_user` is on the ceiling because the copy a child gets builds no agent: it has no `brief` in
 * its schema and no delegate behind it, so it cannot start a grandchild.
 */
test('nothing that would make a child something else is on the ceiling', () => {
    for (const name of ['write', 'edit', 'subagent', 'web_fetch'])
        assert.ok(!CHILD_TOOL_NAMES.includes(name), `${name} must not be a tool a child may hold`)
})

/**
 * A child's `ask_user` is refused without the call it asks on behalf of.
 *
 * Built without one, every round of a design lands in the feed as an unrelated question — a failure
 * that only shows on screen, mid-design, with the user watching.
 */
test('a child cannot hold ask_user without an owning call', () => {
    assert.throws(
        () =>
            createChildTools(process.cwd(), {
                toolNames: DESIGN_TOOL_NAMES,
                deps: {host: {call: () => Promise.resolve({})}}
            }),
        /ownerCallId/u
    )
})

/** The owner and the record both reach the child through the same deps. */
test('the owning call reaches the child through createChildTools', () => {
    const agreed = {}
    const {tools} = createChildTools(process.cwd(), {
        toolNames: DESIGN_TOOL_NAMES,
        deps: {host: {call: () => Promise.resolve({})}, ownerCallId: 'call-parent', agreed}
    })

    const ask = tools.find(tool => tool.name === ASK_USER_TOOL_NAME)
    assert.ok(ask, 'the child holds the question tool')
    assert.ok(!('brief' in ask.parameters.properties), 'and it is the drafting half of it')
})

/** The probe drives the real child against a canned provider, so it costs no network call. */
test('the probe proves the backend routes it and the child builds', async () => {
    let routed = 0
    const tool = askTool({
        host: {
            call: () => {
                routed += 1
                return Promise.resolve({tool: ASK_USER_TOOL_NAME, reachable: true})
            }
        },
        models: {streamSimple: () => assert.fail('a probe must not reach a provider')}
    })

    const {content} = await tool.execute('call-1', {probe: true})

    assert.equal(routed, 1, 'the backend was asked whether it routes the name')
    assert.match(content[0].text, new RegExp(ASK_PROBE_ANSWER, 'u'))
    assert.match(content[0].text, new RegExp(ASK_LOOP_PROBE_ANSWER, 'u'))
})

/**
 * The whole loop, once, through the real child and the real tools.
 *
 * Everything else here tests one seam. This runs them together, because the failure that started
 * this work lived between them: every piece behaved, and the card still closed and reopened on every
 * round. What it asserts is the thing that replaced the session — every question the child asks
 * carries the parent's call, so the rounds are one block.
 */
test('a whole design asks several times under one owning call', async () => {
    const host = answering({answer: 'tighter', sketches: 1})
    const tool = askTool({
        host,
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
        ])
    })

    const result = await tool.execute('call-parent', {
        question: 'how should the HUD sit?',
        brief: 'a pause menu'
    })

    assert.equal(host.asks.length, 2, 'both rounds reached the window')
    for (const ask of host.asks) {
        assert.equal(ask.ownerCallId, 'call-parent')
        assert.equal(ask.isDelegated, true)
    }
    assert.match(result.content[0].text, /64px tall/u)
})

/**
 * The button that ends the delegation ends it, against a model that would rather keep going.
 *
 * The child is scripted to ask again after being told the design is agreed, because that is the case
 * a sentence in a system prompt cannot cover. The loop is closed in front of the provider: one more
 * request so the child writes its answer, then nothing.
 */
test('a model that asks again after approval is stopped, and its answer is kept', async () => {
    const host = answering({
        approved: true,
        picked: {index: 0, label: 'Bar across the top'},
        sketch: {label: 'Bar across the top', html: '<p>the agreed one</p>'},
        sketches: 1
    })
    const tool = askTool({
        host,
        models: scriptedModels([
            {calls: [{name: 'ask_user', args: {question: 'which?', sketches: SKETCH}}]},
            {text: 'A single column, 720px wide, centred.'},
            {calls: [{name: 'ask_user', args: {question: 'sure?', sketches: SKETCH}}]}
        ])
    })

    const {text} = (await tool.execute('call-parent', {question: 'which?', brief: 'a pause menu'}))
        .content[0]

    assert.equal(host.asks.length, 1, 'the user was interrupted once and then not again')
    assert.match(text, /720px wide/u, 'the answer written after the approval is what came back')
    assert.ok(!text.includes('DID NOT AGREE'))
})

/**
 * What was agreed is what was on screen when they agreed it, and nothing after.
 *
 * The loop is closed in front of the provider, so an approved design still gets one more request —
 * and a child that spends it asking rather than writing is answered by a user who has already
 * finished. That answer carried a sketch, and the record kept the markup separately from the
 * approval: `approved` stayed true from the round before while the markup was overwritten by the
 * round after. The parent was then handed a layout under "This is the layout they agreed" that the
 * user had never agreed to.
 */
test('a round after the approval cannot change the layout that was agreed', async () => {
    const asks = []
    const host = {
        asks,
        call: (name, request) => {
            if (name !== ASK_USER_TOOL_NAME) return Promise.resolve({})
            asks.push(request)
            return Promise.resolve(
                asks.length === 1 ?
                    {
                        questionId: 'question-1',
                        approved: true,
                        picked: {index: 0, label: 'Bar across the top'},
                        sketch: {label: 'Bar across the top', html: '<p>the agreed one</p>'}
                    }
                :   {
                        questionId: 'question-1',
                        answer: 'not that one',
                        sketch: {label: 'Rail down the side', html: '<p>the one after</p>'}
                    }
            )
        }
    }
    const tool = askTool({
        host,
        models: scriptedModels([
            {calls: [{name: 'ask_user', args: {question: 'which?', sketches: SKETCH}}]},
            {calls: [{name: 'ask_user', args: {question: 'sure?', sketches: SKETCH}}]},
            {text: 'A single column, 720px wide, centred.'}
        ])
    })

    const {text} = (await tool.execute('call-parent', {question: 'which?', brief: 'a pause menu'}))
        .content[0]

    assert.equal(asks.length, 2, 'the child did ask again, which is the case being covered')
    assert.match(text, /<p>the agreed one<\/p>/u, 'the layout they approved is what comes back')
    assert.ok(!text.includes('the one after'), 'and the round after it is not what they agreed')
    assert.ok(!text.includes('DID NOT AGREE'), 'the approval itself still stands')
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
    const tool = askTool({
        host: answering({
            approved: true,
            picked: {index: 0, label: 'Bar across the top'},
            sketch: {label: 'Bar across the top', html: '<p>the agreed one</p>'},
            sketches: 1
        }),
        models: scriptedModels([
            {calls: [{name: 'ask_user', args: {question: 'which?', sketches: SKETCH}}]},
            {text: 'The dock sits bottom-left, 576x84.'}
        ])
    })

    const {text} = (await tool.execute('call-1', {question: 'which?', brief: 'a squad dock'}))
        .content[0]

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
    const tool = askTool({
        host: answering({
            approved: false,
            answer: 'no, much wider',
            picked: {index: 0, label: 'Bar across the top'},
            sketch: {label: 'Bar across the top', html: '<p>REJECTED</p>'},
            sketches: 1
        }),
        models: scriptedModels([
            {calls: [{name: 'ask_user', args: {question: 'which?', sketches: SKETCH}}]},
            {text: 'They asked for changes and then stopped answering.'}
        ])
    })

    const {text} = (await tool.execute('call-1', {question: 'which?', brief: 'a squad dock'}))
        .content[0]

    assert.ok(!text.includes('REJECTED'), 'the rejected layout must not be handed over')
    assert.ok(!text.includes('they agreed'))
})

/**
 * An answer nobody approved must not read as an agreement.
 *
 * This is the defect the whole line exists for. The child stopped after one round — out of patience
 * rather than out of anything else — and wrote a confident specification anyway, and the parent read
 * it and told the user they had agreed on a layout they had never been asked to approve.
 */
test('a design the user never ended says so before it says anything else', async () => {
    const tool = askTool({
        host: answering({
            approved: false,
            answer: 'bigger rows',
            sketch: {label: 'Bar across the top', html: '<p>a</p>'},
            sketches: 1
        }),
        models: scriptedModels([
            {calls: [{name: 'ask_user', args: {question: 'which?', sketches: SKETCH}}]},
            {text: 'The dock sits bottom-left.'}
        ])
    })

    const {text} = (await tool.execute('call-1', {question: 'which?', brief: 'a squad dock'}))
        .content[0]

    assert.match(text, /^THE USER DID NOT AGREE THIS\./u)
    assert.match(text, /shown 1 round/u)
    assert.match(text, /proposal, not a decision/u)
})

/** A child that answered without asking anybody is the same lie with nobody in the room at all. */
test('a design nobody was ever shown says nobody was shown it', async () => {
    const tool = askTool({models: scriptedModels([{text: 'The dock sits bottom-left.'}])})

    const {text} = (await tool.execute('call-1', {question: 'which?', brief: 'a squad dock'}))
        .content[0]

    assert.match(text, /^THE USER DID NOT AGREE THIS\./u)
    assert.match(text, /never shown anything at all/u)
})

/**
 * A picture the child could not be shown is a picture the parent has to be told about.
 *
 * A layout drawn without the screenshot it was asked about is wrong in a way only the person who
 * attached the screenshot can see, and a silent drop is how the first build of this seam failed.
 */
test('a design agreed without the pictures says so', async () => {
    const tool = askTool({
        models: scriptedModels([{text: 'Agreed.'}]),
        images: [{type: 'image', data: 'AAAA', mimeType: 'image/png'}]
    })

    const {text} = (await tool.execute('call-1', {question: 'which?', brief: 'a squad dock'}))
        .content[0]

    assert.match(text, /never reached the design loop/u)
    assert.match(text, /project files alone/u)
})

/** A child that can see is told nothing, because nothing went missing. */
test('a design agreed with the pictures says nothing about them', async () => {
    const tool = askTool({
        model: {...model, input: ['text', 'image']},
        models: scriptedModels([{text: 'Agreed.'}]),
        images: [{type: 'image', data: 'AAAA', mimeType: 'image/png'}]
    })

    const {text} = (await tool.execute('call-1', {question: 'which?', brief: 'a squad dock'}))
        .content[0]

    assert.ok(!text.includes('never reached the design loop'))
})

/** A loop that showed nothing back appends nothing: there is no drawing to hand over. */
test('an answer with no drawing behind it appends nothing', async () => {
    const tool = askTool({
        host: answering({skipped: true}),
        models: scriptedModels([
            {calls: [{name: 'ask_user', args: {question: 'which?', sketches: SKETCH}}]},
            {text: 'They walked away.'}
        ])
    })

    const {text} = (await tool.execute('call-1', {question: 'which?', brief: 'a squad dock'}))
        .content[0]

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
    const tool = askTool({
        model: {...model, input: ['text', 'image']},
        models,
        images: [picture]
    })

    await tool.execute('call-1', {question: 'which?', brief: 'a squad dock'})

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
 * design at its first step rather than at its worst draft.
 */
test('a child that cannot see is sent no pictures at all', async () => {
    const models = scriptedModels([{text: 'Agreed.'}])
    const tool = askTool({
        models,
        images: [{type: 'image', data: 'AAAA', mimeType: 'image/png'}]
    })

    await tool.execute('call-1', {question: 'which?', brief: 'a squad dock'})

    const parts = models.seen[0].messages.flatMap(message =>
        Array.isArray(message.content) ? message.content : []
    )
    assert.equal(parts.filter(part => part.type === 'image').length, 0)
})

/**
 * The drawing the user reacted to, kept for whoever built the tool rather than for the model.
 *
 * It is not in the answer text and must not be: the child drew it, and charging it for its own
 * markup on every round is the cost this whole seam exists to avoid.
 */
test('the layout the user reacted to is recorded without being read back to the child', async () => {
    const agreed = {}
    const tool = createAskUserTool({
        host: {
            call: () =>
                Promise.resolve({
                    questionId: 'question-1',
                    approved: true,
                    sketch: {label: 'Bar across the top', html: '<p>a</p>'},
                    sketches: 1
                })
        },
        ownerCallId: 'call-parent',
        agreed
    })

    const answer = await tool.execute('call-child', {question: 'which?'})

    assert.deepEqual(agreed, {
        rounds: 1,
        approved: true,
        label: 'Bar across the top',
        html: '<p>a</p>'
    })
    assert.ok(!answer.content[0].text.includes('<p>a</p>'))
})

/**
 * A retry starts from nothing, and the record starts from nothing with it.
 *
 * `createAskUserTool` runs once per attempt, so this is where the clearing belongs. A delegation
 * that showed a sketch and then died on a stream timeout would otherwise leave it behind, and the
 * retry would hand back a layout the user's final answer never saw.
 */
test('a retried attempt inherits no layout from the attempt that failed', () => {
    const agreed = {rounds: 3, label: 'Stale', html: '<p>old</p>', approved: true}

    createAskUserTool({
        host: {call: () => Promise.resolve({})},
        ownerCallId: 'call-parent',
        agreed
    })

    assert.deepEqual(agreed, {})
})

import assert from 'node:assert/strict'
import test from 'node:test'
import {answerText, ASK_USER_TOOL_NAME, BUDGET_SPENT, createAskUserTool} from './ai-ask.mjs'

/*
 * The wording is most of the tool.
 *
 * What reaches the model is one paragraph, and every test here is a paragraph that was wrong in a
 * way that costs a round trip: an approval read as feedback, a pick read as half an answer, a
 * blocked webfont read as the user disliking a layout.
 */

test('a skip tells the model to decide it, not to ask again', () => {
    const text = answerText({questionId: 'question-1', skipped: true})
    assert.match(text, /chose not to decide this/u)
    assert.match(text, /Do not ask again/u)
})

test('a question answered in words comes back as words', () => {
    const text = answerText({questionId: 'question-1', answer: 'its own scene'})
    assert.match(text, /They said: "its own scene"/u)
    // Nothing was shown, so there is nothing to revise and nothing to ask again about.
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
 * Inside a design loop the same click means something else.
 *
 * There is a button that ends a design and picking a sketch is not it. Read as the end, one click on
 * a variant the user liked came back to the parent as a whole layout they had agreed to.
 */
test('a pick inside a design loop is a preference, not the end of it', () => {
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
 * The ration answers rather than throwing.
 *
 * A throw reads to the model as a fault worth retrying. An answer telling it to wrap up is the thing
 * it should actually do, and the only thing it still can do.
 */
test('a child that has spent its ration is told to write its answer, not to retry', async () => {
    let calls = 0
    const host = {
        call: () => {
            calls += 1
            return Promise.resolve({questionId: 'question-1', answer: 'fine'})
        }
    }
    const tool = createAskUserTool({host, budget: 2})
    const ask = () => tool.execute('id', {question: 'which?'})

    await ask()
    await ask()
    const spent = await ask()

    assert.equal(calls, 2, 'the third question never reached the window')
    assert.equal(spent.content[0].text, BUDGET_SPENT)
    assert.equal(spent.details.spent, true)
})

/** A probe must not spend a ration, or a turn would start by using up the user's attention. */
test('a probe is not a question', async () => {
    const host = {call: () => Promise.resolve({tool: ASK_USER_TOOL_NAME, reachable: true})}
    const tool = createAskUserTool({host, budget: 1})

    await tool.execute('id', {probe: true})
    const after = await tool.execute('id', {question: 'which?'})

    assert.notEqual(after.content[0].text, BUDGET_SPENT)
})

test('no budget means no ceiling, which is what the parent turn gets', async () => {
    const host = {call: () => Promise.resolve({questionId: 'question-1', answer: 'y'})}
    const tool = createAskUserTool({host})
    for (let round = 0; round < 20; round += 1) {
        const result = await tool.execute('id', {question: 'which?'})
        assert.notEqual(result.content[0].text, BUDGET_SPENT)
    }
})

/**
 * The design loop may only put a layout in front of the user.
 *
 * It is rationed in the user's attention, and a plain question spends the same ration on something
 * the child was delegated to decide for itself.
 */
test('a holder that may only show things is refused a question with no sketches', async () => {
    let calls = 0
    const host = {
        call: () => {
            calls += 1
            return Promise.resolve({questionId: 'question-1', approved: true})
        }
    }
    const tool = createAskUserTool({host, budget: 2, sketchesRequired: true})

    await assert.rejects(() => tool.execute('id', {question: 'which?'}), /needs sketches/u)
    assert.equal(calls, 0, 'a refused question never reaches the window')

    const withSketch = await tool.execute('id', {
        question: 'which?',
        sketches: [{label: 'Bar across the top', html: '<p>a</p>'}]
    })
    assert.ok(withSketch.content[0].text.length > 0)
})

/**
 * The session is put on the question here rather than left to the model.
 *
 * It is what tells the window these askings are one layout being revised, so the card stays put
 * between rounds instead of closing on the answer and reopening a minute later. A model asked to
 * remember it would forget on the round that mattered.
 */
test('a question from a design loop carries the loop it belongs to', async () => {
    const sent = []
    const host = {
        call: (_name, request) => {
            sent.push(request)
            return Promise.resolve({questionId: 'question-1', answer: 'y'})
        }
    }
    const tool = createAskUserTool({host, budget: 2, sessionId: 'design-7'})

    await tool.execute('id', {question: 'which?'})

    assert.equal(sent[0].designSession, 'design-7')
})

/** Every ordinary question must carry no session at all, or every card starts holding itself open. */
test('an ordinary question carries no design loop', async () => {
    const sent = []
    const host = {
        call: (_name, request) => {
            sent.push(request)
            return Promise.resolve({questionId: 'question-1', answer: 'y'})
        }
    }
    const tool = createAskUserTool({host})

    await tool.execute('id', {question: 'which?'})

    assert.ok(!('designSession' in sent[0]))
})

/**
 * The button that ends a design spends the ration, it does not merely discourage another question.
 *
 * `APPROVED` tells the model the design is settled, and this is what makes that true. Nothing here
 * relies on a sentence to stop a model doing something it can still do.
 */
test('ending a design leaves the child nothing left to ask with', async () => {
    let calls = 0
    const host = {
        call: () => {
            calls += 1
            return Promise.resolve({questionId: 'question-1', picked: {index: 0}, approved: true})
        }
    }
    const tool = createAskUserTool({host, budget: 4, sessionId: 'design-7'})
    const ask = () =>
        tool.execute('id', {
            question: 'which?',
            sketches: [{label: 'Bar across the top', html: '<p>a</p>'}]
        })

    const agreed = await ask()
    assert.match(agreed.content[0].text, /ended the design here/u)

    const after = await ask()
    assert.equal(calls, 1, 'the next question never reached the window')
    assert.equal(after.content[0].text, BUDGET_SPENT)
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

/**
 * The session belongs to the loop, so a model cannot award itself one.
 *
 * `designSession` is in the schema the model reads, and the window treats it as proof: a question
 * carrying one is drawn as a design round, which cannot be escaped, cannot be dismissed by clicking
 * away, and offers a button that ends a loop nothing started. An ordinary tool — built with no
 * session, which is nearly every one of them — forwarded whatever the model put under that name.
 */
test('an ordinary question never carries a session the model invented', async () => {
    let seen
    const host = {
        call: (_name, request) => {
            seen = request
            return Promise.resolve({questionId: 'question-1', answer: 'yes'})
        }
    }
    const tool = createAskUserTool({host})

    await tool.execute('id', {question: 'which?', designSession: 'design-7'})

    assert.equal('designSession' in seen, false)
    assert.equal(seen.question, 'which?')
})

/** And a probe belongs to no loop either, however it was called. */
test('a probe never carries a session', async () => {
    let seen
    const host = {
        call: (_name, request) => {
            seen = request
            return Promise.resolve({questionId: 'probe'})
        }
    }
    const tool = createAskUserTool({host, sessionId: 'design-7'})

    await tool.execute('id', {probe: true, designSession: 'design-9'})

    assert.equal('designSession' in seen, false)
})

/** The loop's own session still reaches the window, and still outranks anything the model sent. */
test('a design question carries the loop session, not the one the model sent', async () => {
    let seen
    const host = {
        call: (_name, request) => {
            seen = request
            return Promise.resolve({questionId: 'question-1', answer: 'yes'})
        }
    }
    const tool = createAskUserTool({host, sessionId: 'design-7'})

    await tool.execute('id', {
        question: 'which?',
        designSession: 'design-9',
        sketches: [{label: 'a', html: '<p>a</p>'}]
    })

    assert.equal(seen.designSession, 'design-7')
})

/**
 * The drawing the user reacted to, kept for the tool that built this rather than for the model.
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
        budget: 2,
        agreed
    })

    const answer = await tool.execute('id', {question: 'which?'})

    assert.deepEqual(agreed, {
        rounds: 1,
        label: 'Bar across the top',
        html: '<p>a</p>',
        approved: true
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

    createAskUserTool({host: {call: () => Promise.resolve({})}, budget: 2, agreed})

    assert.deepEqual(agreed, {})
})

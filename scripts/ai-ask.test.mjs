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
    assert.match(text, /questionId "question-9"/u)
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

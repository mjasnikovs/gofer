import assert from 'node:assert/strict'
import test from 'node:test'
import {
    askDocs,
    buildAskPrompt,
    buildContent,
    COVERAGE_MISS_NEXT_STEP,
    NOTHING_RETRIEVED
} from './rag-ask.mjs'

const PASSAGES = [
    {text: 'tween_property(object, property, final_val, duration)', chapter: 'Tween', score: 1.86},
    {text: 'PropertyTweener interpolates a property.', chapter: 'PropertyTweener', score: 0.42}
]

/** A reader that answers with whatever tags it is handed, and records the prompt it was given. */
function reader(reply) {
    const calls = []
    return {
        calls,
        complete: async request => {
            calls.push(request)
            return reply
        }
    }
}

test('the passages reach the reader under their chapter names', () => {
    const content = buildContent(PASSAGES)

    assert.match(content, /\[Tween\]/u)
    assert.match(content, /\[PropertyTweener\]/u)
    assert.match(content, /tween_property\(object, property, final_val, duration\)/u)
})

test('the content budget keeps the first passage even when it alone exceeds it', () => {
    const huge = [{text: 'a'.repeat(50), chapter: 'Big', score: 1}, ...PASSAGES]

    const content = buildContent(huge, 10)

    assert.match(content, /\[Big\]/u)
    assert.equal(content.includes('[Tween]'), false)
})

test('the prompt asks for both tags and names the sentinels the host looks for', () => {
    const prompt = buildAskPrompt('what does tween_property take?', buildContent(PASSAGES))

    assert.match(prompt, /<answer>/u)
    assert.match(prompt, /<excerpt>/u)
    assert.match(prompt, /not covered by this documentation/u)
    assert.match(prompt, /unclear from this documentation/u)
    assert.match(prompt, /what does tween_property take\?/u)
})

test('a verified quote comes back beside the answer', async () => {
    const {complete, calls} = reader(
        '<answer>It takes an object, a property, a final value and a duration.</answer>'
            + '<excerpt>tween_property(object, property, final_val, duration)</excerpt>'
    )

    const result = await askDocs({
        question: 'what does tween_property take?',
        passages: PASSAGES,
        complete
    })

    assert.equal(result.excerptVerified, true)
    assert.match(result.text, /It takes an object/u)
    assert.match(result.text, /Source excerpt:/u)
    assert.equal(result.text.includes('WARNING'), false)
    assert.deepEqual(result.chapters, [
        {chapter: 'Tween', score: 1.86},
        {chapter: 'PropertyTweener', score: 0.42}
    ])
    assert.equal(calls.length, 1)
})

test('a quote that is not in the manual is called out as unsourced', async () => {
    const {complete} = reader(
        '<answer>It takes four arguments.</answer><excerpt>tween_method(callable, from, to)</excerpt>'
    )

    const result = await askDocs({question: 'how do I tween?', passages: PASSAGES, complete})

    assert.equal(result.excerptVerified, false)
    assert.match(result.text, /WARNING/u)
    assert.match(result.text, /remembered rather than read/u)
})

test('a coverage miss carries the next step, and an abstention does not', async () => {
    const missed = await askDocs({
        question: 'how do I bake lightmaps?',
        passages: PASSAGES,
        complete: reader(
            '<answer>not covered by this documentation</answer><excerpt>PropertyTweener interpolates a property.</excerpt>'
        ).complete
    })
    assert.equal(missed.coverageMiss, true)
    assert.match(missed.text, new RegExp(COVERAGE_MISS_NEXT_STEP.slice(0, 30), 'u'))

    const unclear = await askDocs({
        question: 'how do I tween?',
        passages: PASSAGES,
        complete: reader(
            '<answer>unclear from this documentation</answer><excerpt>PropertyTweener interpolates a property.</excerpt>'
        ).complete
    })
    assert.equal(unclear.abstained, true)
    assert.equal(unclear.coverageMiss, false)
    assert.equal(unclear.text.includes(COVERAGE_MISS_NEXT_STEP), false)
})

test('an empty retrieval is the search missing, not the manual being silent', async () => {
    const {complete, calls} = reader('<answer>should never run</answer>')

    const result = await askDocs({question: 'sourdough', passages: [], complete})

    assert.equal(result.nothingRetrieved, true)
    assert.equal(result.text, NOTHING_RETRIEVED)
    // No model was asked: nothing cleared the threshold, so there was nothing to read.
    assert.equal(calls.length, 0)
})

test('no model connection is reported rather than answered around', async () => {
    const result = await askDocs({question: 'how do I tween?', passages: PASSAGES})

    assert.match(result.error, /without a model connection/u)
    assert.match(result.error, /search operation/u)
})

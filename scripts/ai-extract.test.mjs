import assert from 'node:assert/strict'
import test from 'node:test'
import {
    abstentionSentence,
    CORPORA,
    extractionRules,
    formatResultText,
    isAbstention,
    isCoverageMiss,
    excerptPieces,
    isExcerptInContent,
    normaliseWhitespace,
    notCoveredSentence,
    parseChildOutput,
    verifyExcerpt
} from './ai-extract.mjs'

test('every corpus the prompts can name is a corpus the matchers recognise', () => {
    for (const corpus of CORPORA) {
        assert.equal(isAbstention(abstentionSentence(corpus)), true, corpus)
        assert.equal(isCoverageMiss(notCoveredSentence(corpus)), true, corpus)
        assert.match(extractionRules(corpus, 'x'), new RegExp(abstentionSentence(corpus), 'u'))
        assert.match(extractionRules(corpus, 'x'), new RegExp(notCoveredSentence(corpus), 'u'))
    }
    assert.deepEqual(CORPORA, ['page', 'documentation'])
})

test('abstention matches when wrapped, coverage only when it is the whole answer', () => {
    assert.equal(isAbstention('Unclear from this page — the README does not say.'), true)
    assert.equal(isAbstention('The page is clear about this.'), false)

    assert.equal(isCoverageMiss('not covered by this page'), true)
    assert.equal(isCoverageMiss('not covered by this page.'), true)
    assert.equal(
        isCoverageMiss(
            '`obs_add_raw_audio_callback` is not covered by this page, but the rest is.'
        ),
        false
    )
})

test('a reply with no tags is taken whole, and a blank quote is no quote', () => {
    assert.deepEqual(parseChildOutput('  just prose  '), {answer: 'just prose'})
    assert.deepEqual(parseChildOutput('<answer>a</answer><excerpt>   </excerpt>'), {
        answer: 'a',
        excerpt: undefined
    })
    assert.deepEqual(parseChildOutput('<answer> a </answer><excerpt> b </excerpt>'), {
        answer: 'a',
        excerpt: 'b'
    })
    assert.deepEqual(parseChildOutput(undefined), {answer: ''})
})

test('a whitespace-only quote verifies against nothing', () => {
    assert.equal(isExcerptInContent('   ', 'anything at all'), false)
    assert.equal(isExcerptInContent('a  b', 'x a b y'), true)
    assert.equal(isExcerptInContent('a b', 'x ab y'), false)
    assert.equal(normaliseWhitespace(' a \n b '), 'a b')
})

test('a quote that joins two retrieved passages across an elision is still sourced', () => {
    // The Timer.autostart turn of 2026-09-11, shortened. Both halves are real
    // retrieved text from two different chapters; the reader marked the join.
    const content = [
        '[Godot notifications]\nfunc _ready():\n    var t = Timer.new()\n    add_child(t)',
        '[Timer]\nIf true, the timer will start immediately when it enters the scene tree.'
    ].join('\n\n')
    const excerpt = [
        'func _ready():',
        '    var t = Timer.new()',
        '    add_child(t)',
        '...',
        'If true, the timer will start immediately when it enters the scene tree.'
    ].join('\n')

    assert.equal(isExcerptInContent(excerpt, content), true)
    assert.equal(verifyExcerpt(excerpt, content).verified, true)
    assert.deepEqual(excerptPieces('a\n…\nb'), ['a', 'b'])
    assert.deepEqual(excerptPieces('a\n[...]\nb'), ['a', 'b'])
})

test('an elision does not excuse a half that was never retrieved', () => {
    assert.equal(isExcerptInContent('a real line\n...\nan invented line', 'x a real line y'), false)
    // Dots inside a line are the documentation's own, so they never split a quote.
    assert.equal(isExcerptInContent('alpha ... omega', 'alpha beta omega'), false)
    // A quote that is nothing but elisions verifies against nothing.
    assert.equal(isExcerptInContent('...\n…', 'anything at all'), false)
})

test('the verdict carries what it checked, so a false can be diagnosed later', () => {
    const check = verifyExcerpt('a b', 'x a b y')

    assert.equal(check.verified, true)
    assert.equal(check.normalisedExcerpt, 'a b')
    assert.equal(check.contentLength, 'x a b y'.length)
    assert.match(check.contentSha256, /^[0-9a-f]{64}$/u)
})

test('the warning appears only for a quote that is not there', () => {
    const parsed = {answer: 'the answer', excerpt: 'the quote'}

    assert.match(formatResultText(parsed, false, {unverifiedWarning: 'MADE UP'}), /^MADE UP/u)
    assert.equal(
        formatResultText(parsed, true, {unverifiedWarning: 'MADE UP'}).includes('MADE UP'),
        false
    )
    assert.equal(formatResultText({answer: 'a'}, false, {unverifiedWarning: 'MADE UP'}), 'a')
    assert.match(formatResultText(parsed, true, {header: 'Per Tween:'}), /^Per Tween:/u)
})

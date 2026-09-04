import assert from 'node:assert/strict'
import test from 'node:test'
import {
    WORKER_KINDS,
    classifyWorkerOutcome,
    degradedSection,
    emptySection,
    isBareNoneAnswer
} from './outcome.mjs'

const answered = text => ({kind: 'ok', text, usage: {input: 1, output: 1}, turns: 2})
const failed = (cause, reason = 'because') => ({kind: 'failed', cause, reason, attempts: 1})

test('a worker that ran and said nothing is an answer, not a failure', () => {
    assert.equal(classifyWorkerOutcome(failed('no-answer')).kind, 'empty')
})

test('a worker that said nothing WITH a reported cause is fatal', () => {
    const verdict = classifyWorkerOutcome(failed('model-error', 'the endpoint refused'))
    assert.equal(verdict.kind, 'fatal')
    assert.equal(verdict.reason, 'the endpoint refused')
})

test('a stop is answered before anything else and is never a failure', () => {
    const verdict = classifyWorkerOutcome({kind: 'stopped', reason: 'the turn was stopped'})
    assert.equal(verdict.kind, 'stopped')
    assert.equal(verdict.reason, 'the turn was stopped')
})

test('being cut off mid-explore degrades and keeps what it wrote', () => {
    for (const cause of ['step-ceiling', 'loop', 'command-timeout']) {
        const verdict = classifyWorkerOutcome(failed(cause, 'it ran out of steps'), {
            partial: '  - it found this much  '
        })
        assert.equal(verdict.kind, 'runaway', cause)
        assert.equal(verdict.text, '- it found this much')
    }
})

test('a cause nobody named is fatal rather than quietly degraded', () => {
    assert.equal(classifyWorkerOutcome(failed('unknown')).kind, 'fatal')
})

test('an answer carries its text and what it cost', () => {
    const verdict = classifyWorkerOutcome(answered('FILES\n  src/main.ts'))
    assert.equal(verdict.kind, 'ok')
    assert.equal(verdict.text, 'FILES\n  src/main.ts')
    assert.deepEqual(verdict.usage, {input: 1, output: 1})
    assert.equal(verdict.turns, 2)
})

test('an answer that is only the word nothing is recorded as empty', () => {
    for (const text of ['(none)', 'N/A', '- none', '  (no entries) ', 'Nothing.'])
        assert.equal(classifyWorkerOutcome(answered(text)).kind, 'empty', text)
})

test('prose that explains why there is nothing is a real answer', () => {
    const text = '(no APIs to list — this task creates one HTML file and imports nothing)'
    assert.ok(!isBareNoneAnswer(text))
    assert.equal(classifyWorkerOutcome(answered(text)).kind, 'ok')
})

test('an ending the table does not know raises instead of guessing', () => {
    assert.throws(() => classifyWorkerOutcome({kind: 'exploded'}), TypeError)
    assert.throws(() => classifyWorkerOutcome(undefined), TypeError)
})

test('every kind the table can answer is declared', () => {
    const answers = [
        classifyWorkerOutcome(answered('text')),
        classifyWorkerOutcome(answered('(none)')),
        classifyWorkerOutcome(failed('step-ceiling')),
        classifyWorkerOutcome(failed('model-error')),
        classifyWorkerOutcome({kind: 'stopped', reason: 'stopped'})
    ].map(verdict => verdict.kind)
    assert.deepEqual([...new Set(answers)].sort(), [...WORKER_KINDS].sort())
})

test('a degraded section says so even when it saved nothing', () => {
    assert.equal(
        degradedSection('CONTEXT', 'ran out of steps'),
        '(degraded: the CONTEXT worker ran out of steps; this section may be incomplete)'
    )
    assert.match(degradedSection('APIS', 'went silent', 'half an answer'), /^\(degraded: .*\n\n/su)
})

test('an empty section names the worker that reported nothing', () => {
    assert.match(emptySection('TOOLING'), /the TOOLING worker ran and reported nothing/u)
})

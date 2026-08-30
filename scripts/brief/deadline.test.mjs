import assert from 'node:assert/strict'
import test from 'node:test'
import {BRIEF_DEADLINE_MS, BriefExpired, guardDeadline} from './run.mjs'

test('a run that has outlived its deadline is ended at the next boundary', () => {
    assert.throws(() => guardDeadline('grill', BRIEF_DEADLINE_MS + 1), BriefExpired)
    assert.doesNotThrow(() => guardDeadline('grill', BRIEF_DEADLINE_MS))
})

test('it names the phase it never got to start', () => {
    try {
        guardDeadline('compose', 25 * 60 * 1000)
        assert.fail('a run past its deadline must not continue')
    } catch (error) {
        assert.ok(error instanceof BriefExpired)
        assert.equal(error.phase, 'compose')
        assert.match(error.message, /still on compose after 25 minutes/u)
    }
})

test('a deadline of zero is no deadline at all', () => {
    assert.doesNotThrow(() => guardDeadline('refine', 10 * 60 * 60 * 1000, 0))
})

test('time spent waiting for a person is not time the run spent working', () => {
    const wallClock = 40 * 60 * 1000
    const waitedOnTheUser = 30 * 60 * 1000

    assert.throws(() => guardDeadline('compose', wallClock), BriefExpired)
    assert.doesNotThrow(() => guardDeadline('compose', wallClock - waitedOnTheUser))
})

test('the shipped deadline outlasts an honest run and not an endless one', () => {
    assert.ok(BRIEF_DEADLINE_MS > 15 * 60 * 1000, 'longer than the slowest honest run measured')
    assert.ok(BRIEF_DEADLINE_MS <= 30 * 60 * 1000, 'short enough that a wedged run is not the day')
})

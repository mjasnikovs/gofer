import assert from 'node:assert/strict'
import test from 'node:test'
import {BRIEF_DEADLINE_MS, BriefExpired, guardDeadline} from './run.mjs'

/*
 * Nothing else composes the per-child bounds.
 *
 * A child is bounded three ways and seven of them run in a row, so the worst case is the sum —
 * measured in hours. An ask the phases could not make sense of (`asdf ;;;; ????`) spent fifteen
 * minutes inside research alone, and the only thing that would ever have ended it was the user
 * noticing and pressing Stop.
 */
test('a run that has outlived its deadline is ended at the next boundary', () => {
    assert.throws(() => guardDeadline('grill', BRIEF_DEADLINE_MS + 1), BriefExpired)
    assert.doesNotThrow(() => guardDeadline('grill', BRIEF_DEADLINE_MS))
})

/*
 * At a boundary, not on a timer, and that is the point: everything the run finished is already
 * recorded, so the row says which phase it got to instead of discarding a phase mid-flight.
 */
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

// Zero is off, which is what a caller with no ceiling means. Read as a plain comparison it would
// expire every run at its first phase instead.
test('a deadline of zero is no deadline at all', () => {
    assert.doesNotThrow(() => guardDeadline('refine', 10 * 60 * 60 * 1000, 0))
})

/*
 * A question can wait half an hour, and a run held up by a person reading the code it is about has
 * not run away — it is doing exactly what it should. Counted against the deadline, the ceiling would
 * fire on the one case it has no business ending.
 *
 * The subtraction is done at the call site; what this pins is that the guard is given working time,
 * not wall-clock, and that the difference is the thing that decides.
 */
test('time spent waiting for a person is not time the run spent working', () => {
    const wallClock = 40 * 60 * 1000
    const waitedOnTheUser = 30 * 60 * 1000

    assert.throws(() => guardDeadline('compose', wallClock), BriefExpired)
    assert.doesNotThrow(() => guardDeadline('compose', wallClock - waitedOnTheUser))
})

test('the shipped deadline outlasts an honest run and not an endless one', () => {
    // The two live runs that produced a specification took 409s and 187s.
    assert.ok(BRIEF_DEADLINE_MS > 15 * 60 * 1000, 'longer than the slowest honest run measured')
    assert.ok(BRIEF_DEADLINE_MS <= 30 * 60 * 1000, 'short enough that a wedged run is not the day')
})

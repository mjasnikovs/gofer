import {describe, expect, it} from 'vitest'
import {EMPTY_BRIEF_STATE, applyBriefEvent, endBriefRun, isBriefEvent} from './brief'
import type {BriefEvent, BriefState} from './brief'

const fold = (events: readonly BriefEvent[]): BriefState =>
    events.reduce(applyBriefEvent, EMPTY_BRIEF_STATE)

/** Every event that means the worker whose line is on screen is no longer the one running. */
const BOUNDARIES: readonly (readonly [string, BriefEvent])[] = [
    ['the next worker starts', {type: 'brief-worker', label: 'worker:apis'}],
    ['the worker finishes', {type: 'brief-worker-done', section: 'FILES', kind: 'ok'}],
    ['the phase changes', {type: 'brief-phase-start', phase: 'grill'}],
    ['the run is stopped', {type: 'brief-stopped', phase: 'research'}],
    ['the run fails', {type: 'brief-failed', phase: 'research', reason: 'a dead tool'}]
]

describe('what a brief is doing', () => {
    /*
     * The panel has to appear before the first phase does. Proving every tool is reachable happens
     * first and takes long enough that a task with an empty chat and nothing on screen is
     * indistinguishable from a run that never started.
     */
    it('says a run exists before any phase has started', () => {
        const state = fold([{type: 'brief-started'}])
        expect(state.isRunning).toBe(true)
        expect(state.phase).toBeUndefined()
    })

    it('follows the phase, and counts the workers of the one that has them', () => {
        const state = fold([
            {type: 'brief-started'},
            {type: 'brief-phase-start', phase: 'research'},
            {type: 'brief-worker-done', section: 'FILES', kind: 'ok'},
            {type: 'brief-worker-done', section: 'APIS', kind: 'empty'}
        ])
        expect(state.phase).toBe('research')
        expect(state.research.map(worker => worker.section)).toEqual(['FILES', 'APIS'])
    })

    /*
     * The only thing on the panel that moves while one worker runs, which is minutes at a time. It
     * is produced by the delegation rather than by the loop driving it, so every caller of a
     * sub-agent gets it and none of them writes it.
     */
    it('says what the worker in flight is doing right now', () => {
        const state = fold([
            {type: 'brief-phase-start', phase: 'research'},
            {type: 'brief-worker', label: 'worker:files'},
            {type: 'brief-worker-step', label: 'worker:files', line: 'bash: rg -n Main', steps: 1}
        ])
        expect(state.running).toBe('FILES')
        expect(state.step).toBe('bash: rg -n Main')
    })

    /*
     * Cleared at every boundary, and that is the whole of the care this needs. The previous worker's
     * last line sitting under the next worker's name does not read as stale — it reads as this
     * worker's progress, which is worse than showing nothing.
     */
    it.each(BOUNDARIES)('forgets the line when %s', (_when, ending) => {
        const state = fold([
            {type: 'brief-phase-start', phase: 'research'},
            {type: 'brief-worker', label: 'worker:files'},
            {type: 'brief-worker-step', label: 'worker:files', line: 'bash: rg -n Main', steps: 1},
            ending
        ])
        expect(state.step).toBeUndefined()
    })

    // A worker announcing itself twice must not make the count say three of four are done.
    it('counts each worker once', () => {
        const state = fold([
            {type: 'brief-phase-start', phase: 'research'},
            {type: 'brief-worker-done', section: 'FILES', kind: 'ok'},
            {type: 'brief-worker-done', section: 'FILES', kind: 'ok'}
        ])
        expect(state.research).toHaveLength(1)
    })

    /*
     * The count outlives the phase that produced it, because the row that shows it does.
     *
     * Cleared at the next boundary, a finished research phase rendered "0/4" beside its own done
     * marker — the number was gone while the row still asked for it.
     */
    it('keeps the count after the phase that produced it has passed', () => {
        const state = fold([
            {type: 'brief-started'},
            {type: 'brief-phase-start', phase: 'research'},
            {type: 'brief-worker-done', section: 'FILES', kind: 'ok'},
            {type: 'brief-worker-done', section: 'APIS', kind: 'ok'},
            {type: 'brief-worker-done', section: 'CONTEXT', kind: 'ok'},
            {type: 'brief-worker-done', section: 'TOOLING', kind: 'ok'},
            {type: 'brief-phase-start', phase: 'grill'}
        ])
        expect(state.phase).toBe('grill')
        expect(state.research).toHaveLength(4)
    })

    // A fresh run is the one boundary that does clear it.
    it('starts a new run from nothing', () => {
        const state = fold([
            {type: 'brief-phase-start', phase: 'research'},
            {type: 'brief-worker-done', section: 'FILES', kind: 'ok'},
            {type: 'brief-started'}
        ])
        expect(state.research).toEqual([])
        expect(state.phase).toBeUndefined()
    })

    /*
     * Which worker is reading right now, so a slow phase names the thing that is slow rather than
     * showing a count that has not moved.
     */
    it('follows the worker in flight, and forgets it when that worker answers', () => {
        const reading = fold([
            {type: 'brief-phase-start', phase: 'research'},
            {type: 'brief-worker', label: 'worker:apis'}
        ])
        expect(reading.running).toBe('APIS')

        const answered = applyBriefEvent(reading, {
            type: 'brief-worker-done',
            section: 'APIS',
            kind: 'empty'
        })
        expect(answered.running).toBeUndefined()
        expect(answered.research).toEqual([{section: 'APIS', kind: 'empty'}])
    })

    // The other phases are their own row, so their labels name no research worker.
    it('names no worker for a phase that has none', () => {
        const state = fold([
            {type: 'brief-phase-start', phase: 'compose'},
            {type: 'brief-worker', label: 'compose'}
        ])
        expect(state.running).toBeUndefined()
    })

    // How a worker ended is kept, not just that it ended.
    it('keeps how each worker ended', () => {
        const state = fold([
            {type: 'brief-worker-done', section: 'FILES', kind: 'ok'},
            {type: 'brief-worker-done', section: 'CONTEXT', kind: 'runaway'}
        ])
        expect(state.research).toEqual([
            {section: 'FILES', kind: 'ok'},
            {section: 'CONTEXT', kind: 'runaway'}
        ])
    })

    it('tells a run that was stopped from one that broke', () => {
        expect(
            fold([{type: 'brief-started'}, {type: 'brief-stopped', phase: 'research'}])
        ).toMatchObject({isRunning: false, ended: {kind: 'stopped'}})
        expect(
            fold([
                {type: 'brief-started'},
                {type: 'brief-failed', phase: 'compose', reason: 'no verify block'}
            ])
        ).toMatchObject({isRunning: false, ended: {kind: 'failed', reason: 'no verify block'}})
    })

    /*
     * A run that worked says nothing on its way out. Only the endings worth reading are announced —
     * a finished plan's report is the specification, which is already in the chat by then — so the
     * command answering is the only news that the last phase was the last.
     */
    it('closes a run that ended without saying so', () => {
        const state = endBriefRun(
            fold([{type: 'brief-started'}, {type: 'brief-phase-start', phase: 'compose'}])
        )
        expect(state.isRunning).toBe(false)
        // Nothing broke, so nothing is reported as broken: the panel is drawn on "running or
        // ended", and a run that finished should take it off screen.
        expect(state.ended).toBeUndefined()
    })

    // A run that named its own ending keeps it. The command answers afterwards either way.
    it('leaves an ending that was already reported', () => {
        const before = fold([
            {type: 'brief-started'},
            {type: 'brief-failed', phase: 'compose', reason: 'no verify block'}
        ])
        expect(endBriefRun(before)).toBe(before)
    })

    it('ignores an event it has nothing to say about', () => {
        const before = fold([{type: 'brief-started'}])
        expect(applyBriefEvent(before, {type: 'brief-log', message: 'anything'})).toBe(before)
    })
})

describe('reading what arrived', () => {
    // A screen that draws whatever arrives is a screen that draws a backend mistake.
    it('accepts only the events it knows', () => {
        expect(isBriefEvent({type: 'brief-started'})).toBe(true)
        expect(isBriefEvent({type: 'brief-nonsense'})).toBe(false)
        expect(isBriefEvent({})).toBe(false)
        expect(isBriefEvent(null)).toBe(false)
        expect(isBriefEvent('brief-started')).toBe(false)
    })

    /*
     * A phase nobody knows about set `state.phase` to a name no row is drawn for, so every row read
     * "not started" — a panel that looks like a run which never began, and nothing anywhere
     * reporting an error. Dropped instead, the panel keeps the last phase it could draw.
     */
    it('rejects a phase it cannot draw a row for', () => {
        expect(isBriefEvent({type: 'brief-phase-start', phase: 'grill'})).toBe(true)
        expect(isBriefEvent({type: 'brief-phase-start', phase: 'critique'})).toBe(false)
        expect(isBriefEvent({type: 'brief-phase', phase: 'critique', field: 'x', value: 'y'})).toBe(
            false
        )
    })

    // An ending names where it happened, which is worth reporting even when nothing had started.
    it('still accepts an ending that names no phase it knows', () => {
        expect(isBriefEvent({type: 'brief-failed', phase: 'startup', reason: 'a dead tool'})).toBe(
            true
        )
    })
})

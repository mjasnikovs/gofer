import {describe, expect, it} from 'vitest'
import {EMPTY_BRIEF_STATE, applyBriefEvent, endBriefRun, isBriefEvent} from './brief'
import type {BriefEvent, BriefState} from './brief'

const fold = (events: readonly BriefEvent[]): BriefState =>
    events.reduce(applyBriefEvent, EMPTY_BRIEF_STATE)

const BOUNDARIES: readonly (readonly [string, BriefEvent])[] = [
    ['the next worker starts', {type: 'brief-worker', label: 'worker:apis'}],
    ['the worker finishes', {type: 'brief-worker-done', section: 'FILES', kind: 'ok'}],
    ['the phase changes', {type: 'brief-phase-start', phase: 'grill'}],
    ['the run is stopped', {type: 'brief-stopped', phase: 'research'}],
    ['the run fails', {type: 'brief-failed', phase: 'research', reason: 'a dead tool'}]
]

describe('what a brief is doing', () => {
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

    it('says what the worker in flight is doing right now', () => {
        const state = fold([
            {type: 'brief-phase-start', phase: 'research'},
            {type: 'brief-worker', label: 'worker:files'},
            {type: 'brief-worker-step', label: 'worker:files', line: 'bash: rg -n Main', steps: 1}
        ])
        expect(state.running).toBe('FILES')
        expect(state.step).toBe('bash: rg -n Main')
    })

    it.each(BOUNDARIES)('forgets the line when %s', (_when, ending) => {
        const state = fold([
            {type: 'brief-phase-start', phase: 'research'},
            {type: 'brief-worker', label: 'worker:files'},
            {type: 'brief-worker-step', label: 'worker:files', line: 'bash: rg -n Main', steps: 1},
            ending
        ])
        expect(state.step).toBeUndefined()
    })

    it('counts each worker once', () => {
        const state = fold([
            {type: 'brief-phase-start', phase: 'research'},
            {type: 'brief-worker-done', section: 'FILES', kind: 'ok'},
            {type: 'brief-worker-done', section: 'FILES', kind: 'ok'}
        ])
        expect(state.research).toHaveLength(1)
    })

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

    it('starts a new run from nothing', () => {
        const state = fold([
            {type: 'brief-phase-start', phase: 'research'},
            {type: 'brief-worker-done', section: 'FILES', kind: 'ok'},
            {type: 'brief-started'}
        ])
        expect(state.research).toEqual([])
        expect(state.phase).toBeUndefined()
    })

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

    it('names no worker for a phase that has none', () => {
        const state = fold([
            {type: 'brief-phase-start', phase: 'compose'},
            {type: 'brief-worker', label: 'compose'}
        ])
        expect(state.running).toBeUndefined()
    })

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

    it('closes a run that ended without saying so', () => {
        const state = endBriefRun(
            fold([{type: 'brief-started'}, {type: 'brief-phase-start', phase: 'compose'}])
        )
        expect(state.isRunning).toBe(false)
        expect(state.ended).toBeUndefined()
    })

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
    it('accepts only the events it knows', () => {
        expect(isBriefEvent({type: 'brief-started'})).toBe(true)
        expect(isBriefEvent({type: 'brief-nonsense'})).toBe(false)
        expect(isBriefEvent({})).toBe(false)
        expect(isBriefEvent(null)).toBe(false)
        expect(isBriefEvent('brief-started')).toBe(false)
    })

    it('rejects a phase it cannot draw a row for', () => {
        expect(isBriefEvent({type: 'brief-phase-start', phase: 'grill'})).toBe(true)
        expect(isBriefEvent({type: 'brief-phase-start', phase: 'critique'})).toBe(false)
        expect(isBriefEvent({type: 'brief-phase', phase: 'critique', field: 'x', value: 'y'})).toBe(
            false
        )
    })

    it('still accepts an ending that names no phase it knows', () => {
        expect(isBriefEvent({type: 'brief-failed', phase: 'startup', reason: 'a dead tool'})).toBe(
            true
        )
    })
})

import {describe, expect, it} from 'vitest'
import {INITIAL_SESSION_LOGS, MAX_ENTRIES, reduceSessionLogs} from './session-logs'
import type {SessionLogAction, SessionLogs} from './session-logs'
import type {GodotLogEntry, GodotLogPage} from './godot'

/** Applies a run of actions in order, which is the only way the panel ever reaches a state. */
function apply(...actions: readonly SessionLogAction[]): SessionLogs {
    return actions.reduce(reduceSessionLogs, INITIAL_SESSION_LOGS)
}

function line(sequence: number, message = `line ${String(sequence)}`): GodotLogEntry {
    return {sequence, source: 'editor', severity: 'info', message, timestamp: sequence}
}

function page(entries: readonly GodotLogEntry[], cursor: number, dropped = 0): GodotLogPage {
    return {entries, cursor, dropped}
}

const opened = apply({type: 'page-read', page: page([line(1), line(2)], 2)})

describe('reading pages', () => {
    it('shows the first page and takes the cursor it came with', () => {
        expect(opened.entries.map(entry => entry.sequence)).toEqual([1, 2])
        expect(opened.cursor).toBe(2)
        expect(opened.isFirstPage).toBe(false)
    })

    it('adds every later page to what is already on screen', () => {
        const more = reduceSessionLogs(opened, {type: 'page-read', page: page([line(3)], 3)})
        expect(more.entries.map(entry => entry.sequence)).toEqual([1, 2, 3])
        expect(more.cursor).toBe(3)
    })

    /** A poll that found nothing must not rebuild the list, or the panel re-renders once a second. */
    it('answers with the same lines when a page brings none', () => {
        const empty = reduceSessionLogs(opened, {type: 'page-read', page: page([], 2)})
        expect(empty.entries).toBe(opened.entries)
    })

    it('reports what the ring buffer discarded before the panel asked', () => {
        expect(reduceSessionLogs(opened, {type: 'page-read', page: page([], 2, 41)}).dropped).toBe(
            41
        )
    })

    it('keeps only the newest lines once the panel is full', () => {
        const flooded = apply({
            type: 'page-read',
            page: page(
                Array.from({length: MAX_ENTRIES + 10}, (_, index) => line(index + 1)),
                MAX_ENTRIES + 10
            )
        })
        expect(flooded.entries).toHaveLength(MAX_ENTRIES)
        expect(flooded.entries[0]?.sequence).toBe(11)
    })

    it('keeps only the newest lines when a later page overflows it', () => {
        const flooded = reduceSessionLogs(opened, {
            type: 'page-read',
            page: page(
                Array.from({length: MAX_ENTRIES}, (_, index) => line(index + 3)),
                MAX_ENTRIES + 2
            )
        })
        expect(flooded.entries).toHaveLength(MAX_ENTRIES)
        expect(flooded.entries.at(-1)?.sequence).toBe(MAX_ENTRIES + 2)
    })
})

describe('changing a filter', () => {
    /*
     * The filter belongs to the query. The backend is the only place that still holds the lines
     * the previous filter excluded, so a new query starts from the oldest buffered line rather
     * than sieving what is already on screen.
     */
    it('replaces the previous query rather than adding to it', () => {
        const refiltered = apply(
            {type: 'page-read', page: page([line(1), line(2)], 2)},
            {type: 'restarted'},
            {type: 'page-read', page: page([line(2, 'only errors')], 2)}
        )
        expect(refiltered.entries.map(entry => entry.message)).toEqual(['only errors'])
    })

    it('forgets the cursor so the new query starts at the oldest line', () => {
        expect(reduceSessionLogs(opened, {type: 'restarted'}).cursor).toBeUndefined()
    })
})

describe('failures and clearing', () => {
    /** A poll that could not reach the editor says nothing about the output it read a second ago. */
    it('keeps the lines on screen when a poll fails', () => {
        const failed = reduceSessionLogs(opened, {
            type: 'failed',
            error: {code: 'no_session', message: 'no editor session', retryable: true}
        })
        expect(failed.entries).toBe(opened.entries)
        expect(failed.error?.message).toBe('no editor session')
    })

    it('retires the failure as soon as a page comes back', () => {
        const recovered = apply(
            {type: 'page-read', page: page([line(1)], 1)},
            {type: 'failed', error: {code: 'no_session', message: 'gone', retryable: true}},
            {type: 'page-read', page: page([line(2)], 2)}
        )
        expect(recovered.error).toBeUndefined()
    })

    /** Clearing empties the panel and nothing else: the cursor still says what has been read. */
    it('empties the panel without rewinding the cursor', () => {
        const cleared = reduceSessionLogs(opened, {type: 'cleared'})
        expect(cleared.entries).toEqual([])
        expect(cleared.cursor).toBe(2)
    })

    it('answers with the same value when there is nothing to clear', () => {
        expect(reduceSessionLogs(INITIAL_SESSION_LOGS, {type: 'cleared'})).toBe(
            INITIAL_SESSION_LOGS
        )
    })
})

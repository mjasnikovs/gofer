import {describe, expect, it, vi} from 'vitest'
import {createFileMentionSource} from './file-mentions'

const LISTING = [
    {path: 'project.godot'},
    {path: 'docs/TASK_CHECKLIST.md'},
    {path: 'scripts/enemy_base.gd'}
]

describe('the search source behind an @ mention', () => {
    it('offers the worktree it was handed', async () => {
        const source = createFileMentionSource(() => Promise.resolve(LISTING))
        expect((await source.bootstrap()).map(entry => entry.id)).toContain('project.godot')
        const found = await source.search('task')
        expect(found[0]).toMatchObject({
            id: 'docs/TASK_CHECKLIST.md',
            label: 'TASK_CHECKLIST.md',
            auxiliaryData: {directory: 'docs', isDirectory: false}
        })
    })

    /*
     * The composer's menu never calls `bootstrap`: it calls `search`, twice per keystroke. So a
     * source that only read the worktree on `bootstrap` would answer every query out of an empty
     * list, which is the menu saying "No results" about a file that is right there.
     */
    it('reads the worktree for a search, without being bootstrapped first', async () => {
        const list = vi.fn().mockResolvedValue(LISTING)
        const source = createFileMentionSource(list)
        expect((await source.search('task')).map(entry => entry.id)).toEqual([
            'docs/TASK_CHECKLIST.md'
        ])
        expect(list).toHaveBeenCalledTimes(1)
    })

    /* Ten characters typed is twenty searches. It is one read, not twenty. */
    it('reads once for a burst of searches', async () => {
        const list = vi.fn().mockResolvedValue(LISTING)
        const source = createFileMentionSource(list)
        for (const query of ['', 't', 'ta', 'tas', 'task', 'task_']) await source.search(query)
        expect(list).toHaveBeenCalledTimes(1)
    })

    /* The agent writes files mid-turn, so a listing that never expires goes stale under the user. */
    it('reads again once the listing it held is old', async () => {
        const list = vi.fn().mockResolvedValue(LISTING)
        let clock = 0
        const source = createFileMentionSource(list, () => clock)
        await source.search('task')
        clock += 60_000
        await source.search('task')
        expect(list).toHaveBeenCalledTimes(2)
    })

    /*
     * Issue #3. The menu asks `search('')` on every keystroke to find out whether this source is
     * async, and puts itself on a 150 ms debounce showing "Searching…" whenever the answer is a
     * promise. Answering with an array is what keeps the rows on screen and keeps Enter meaning
     * "take this file"; a promise here is the flicker, so it is asserted rather than assumed.
     */
    it('answers a search out of the listing it already holds, on the same tick', async () => {
        const source = createFileMentionSource(() => Promise.resolve(LISTING))
        await source.search('')
        expect(source.search('task')).not.toBeInstanceOf(Promise)
        expect(source.bootstrap()).not.toBeInstanceOf(Promise)
    })

    /*
     * The folders are the browsable half and the Rust scan reports none of them, so the source is
     * the only place they can come from. A folder's `id` is what marks it: the trailing slash is
     * both what the row inserts and what the composer reads to decide whether to step in.
     */
    it('offers the folders above the files as well', async () => {
        const source = createFileMentionSource(() => Promise.resolve(LISTING))
        await source.bootstrap()
        expect((await source.search('docs')).map(entry => entry.id)).toEqual([
            'docs/',
            'docs/TASK_CHECKLIST.md'
        ])
        expect((await source.search('docs/')).map(entry => entry.id)).toEqual([
            'docs/TASK_CHECKLIST.md'
        ])
    })

    /* A workspace that cannot be listed is an empty menu, not a thrown message half-written. */
    it('answers with no files when the workspace cannot be listed', async () => {
        const source = createFileMentionSource(() => Promise.reject(new Error('no workspace')))
        expect(await source.search('anything')).toEqual([])
    })

    /* One failed IPC mid-browse must not take the file away until the reuse window is out. */
    it('keeps the listing it holds when a later read fails', async () => {
        const list = vi
            .fn()
            .mockResolvedValueOnce(LISTING)
            .mockRejectedValue(new Error('no workspace'))
        let clock = 0
        const source = createFileMentionSource(list, () => clock)
        await source.search('task')
        clock += 60_000
        await source.search('task')
        expect((await source.search('task')).map(entry => entry.id)).toEqual([
            'docs/TASK_CHECKLIST.md'
        ])
    })
})

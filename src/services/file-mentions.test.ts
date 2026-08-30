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

    it('reads the worktree for a search, without being bootstrapped first', async () => {
        const list = vi.fn().mockResolvedValue(LISTING)
        const source = createFileMentionSource(list)
        expect((await source.search('task')).map(entry => entry.id)).toEqual([
            'docs/TASK_CHECKLIST.md'
        ])
        expect(list).toHaveBeenCalledTimes(1)
    })

    it('reads once for a burst of searches', async () => {
        const list = vi.fn().mockResolvedValue(LISTING)
        const source = createFileMentionSource(list)
        for (const query of ['', 't', 'ta', 'tas', 'task', 'task_']) await source.search(query)
        expect(list).toHaveBeenCalledTimes(1)
    })

    it('reads again once the listing it held is old', async () => {
        const list = vi.fn().mockResolvedValue(LISTING)
        let clock = 0
        const source = createFileMentionSource(list, () => clock)
        await source.search('task')
        clock += 60_000
        await source.search('task')
        expect(list).toHaveBeenCalledTimes(2)
    })

    it('answers a search out of the listing it already holds, on the same tick', async () => {
        const source = createFileMentionSource(() => Promise.resolve(LISTING))
        await source.search('')
        expect(source.search('task')).not.toBeInstanceOf(Promise)
        expect(source.bootstrap()).not.toBeInstanceOf(Promise)
    })

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

    it('answers with no files when the workspace cannot be listed', async () => {
        const source = createFileMentionSource(() => Promise.reject(new Error('no workspace')))
        expect(await source.search('anything')).toEqual([])
    })

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

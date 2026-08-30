import {afterEach, describe, expect, it, vi} from 'vitest'
import {
    clearThumbnails,
    requestThumbnail,
    resetThumbnails,
    setThumbnailRequest,
    thumbnailFor,
    watchThumbnails
} from './file-thumbnails'
import {flush} from '../test/flush'

const SQUARE = 'data:image/png;base64,AAAA'

async function settle() {
    for (let turn = 0; turn < 10; turn += 1) await flush()
}

afterEach(() => {
    resetThumbnails()
})

describe('the squares the @ menu draws', () => {
    it('fetches a path once and keeps the answer', async () => {
        const request = vi.fn().mockResolvedValue(SQUARE)
        setThumbnailRequest(request)
        requestThumbnail('sprites/player.png')
        await settle()
        expect(thumbnailFor('sprites/player.png')).toBe(SQUARE)
        requestThumbnail('sprites/player.png')
        await settle()
        expect(request).toHaveBeenCalledTimes(1)
    })

    it('asks once for a burst of requests on the same path', async () => {
        const request = vi.fn().mockResolvedValue(SQUARE)
        setThumbnailRequest(request)
        for (let n = 0; n < 20; n += 1) requestThumbnail('sprites/player.png')
        await settle()
        expect(request).toHaveBeenCalledTimes(1)
    })

    it('keeps at most three decodes running at a time', async () => {
        let running = 0
        let peak = 0
        const release: (() => void)[] = []
        setThumbnailRequest(() => {
            running += 1
            peak = Math.max(peak, running)
            return new Promise<string | null>(resolve => {
                release.push(() => {
                    running -= 1
                    resolve(SQUARE)
                })
            })
        })
        for (let n = 0; n < 12; n += 1) requestThumbnail(`sprites/frame${String(n)}.png`)
        await settle()
        expect(peak).toBe(3)
        while (release.length > 0) {
            release.shift()?.()
            await settle()
        }
        expect(thumbnailFor('sprites/frame11.png')).toBe(SQUARE)
    })

    it('remembers a failure as "no preview" rather than retrying it', async () => {
        const request = vi.fn().mockRejectedValue(new Error('half written'))
        setThumbnailRequest(request)
        requestThumbnail('sprites/player.png')
        await settle()
        expect(thumbnailFor('sprites/player.png')).toBeNull()
        requestThumbnail('sprites/player.png')
        await settle()
        expect(request).toHaveBeenCalledTimes(1)
    })

    it('tells a watcher when a square arrives, and stops once it leaves', async () => {
        setThumbnailRequest(() => Promise.resolve(SQUARE))
        const told = vi.fn()
        const stop = watchThumbnails(told)
        requestThumbnail('sprites/player.png')
        await settle()
        expect(told).toHaveBeenCalled()
        stop()
        told.mockClear()
        requestThumbnail('sprites/other.png')
        await settle()
        expect(told).not.toHaveBeenCalled()
    })

    it('forgets everything when the checkout moves', async () => {
        const request = vi.fn().mockResolvedValue(SQUARE)
        setThumbnailRequest(request)
        requestThumbnail('sprites/player.png')
        await settle()
        expect(thumbnailFor('sprites/player.png')).toBe(SQUARE)
        clearThumbnails()
        expect(thumbnailFor('sprites/player.png')).toBeUndefined()
        requestThumbnail('sprites/player.png')
        await settle()
        expect(request).toHaveBeenCalledTimes(2)
    })

    it('drops an answer that was already in flight when the checkout moved', async () => {
        let answer: ((url: string) => void) | undefined
        setThumbnailRequest(
            () =>
                new Promise<string | null>(resolve => {
                    answer = resolve
                })
        )
        requestThumbnail('sprites/player.png')
        await flush()

        clearThumbnails()
        answer?.(SQUARE)
        await settle()

        expect(thumbnailFor('sprites/player.png')).toBeUndefined()
    })

    it('answers undefined for a path nobody has asked about', () => {
        expect(thumbnailFor('sprites/unknown.png')).toBeUndefined()
    })
})

import {expect} from '@wdio/globals'
import {browser} from '@wdio/tauri-service'
import {DEFAULT_WINDOW, SMALLEST_WINDOW, WINDOW_SWEEP} from '../visual/window-size'

const CONTROLS = 'button, a[href], input, textarea, select, [role="button"]'

// Every other suite renders this UI in Chromium against a mocked IPC, and text
// metrics differ enough between engines to change which controls fit, so the only
// honest answer about what the user sees comes from the shipped binary's own view.
// Nothing excuses a control off the window: the strips draw no scrollbar, so what
// leaves the frame is gone as far as anyone using it can tell. The one strip that does
// is a TabList past its width: it draws a scroll button, so a tab beyond the edge is one
// press away, and at 800 the centre strip's ninth tab sits there.
async function offTheWindow(): Promise<readonly string[]> {
    return browser.execute((selector: string) => {
        const scrollsByButton = (one: Element) => {
            let strip = one.parentElement
            for (let depth = 0; depth < 4 && strip !== null; depth += 1) {
                const button = strip.querySelector('.astryx-tab-scroll-button')
                if (button !== null && button.getBoundingClientRect().width > 0) return true
                strip = strip.parentElement
            }
            return false
        }
        return [...document.querySelectorAll(selector)]
            .filter(one => {
                const box = one.getBoundingClientRect()
                if (box.width === 0) return false
                if (scrollsByButton(one)) return false
                return box.right > window.innerWidth + 1 || box.left < -1
            })
            .map(one => {
                const box = one.getBoundingClientRect()
                const name = one.textContent.trim().slice(0, 24)
                return `${one.tagName} "${name}" ${String(Math.round(box.left))}..${String(Math.round(box.right))}`
            })
    }, CONTROLS)
}

const extra = (process.env['GOFER_LAYOUT_WIDTHS'] ?? '')
    .split(',')
    .map(one => Number.parseInt(one, 10))
    .filter(one => Number.isFinite(one) && one > 0)
    .map(width => ({width, height: SMALLEST_WINDOW.height}))

describe('the shipped window', () => {
    for (const size of [DEFAULT_WINDOW, ...WINDOW_SWEEP, ...extra]) {
        it(`keeps every control inside ${String(size.width)}x${String(size.height)}`, async () => {
            await browser.setWindowSize(size.width, size.height)
            await browser.$('[data-tab-value="chat"]').waitForDisplayed()
            // a tiling compositor answers setWindowSize with its own tile, and the run
            // then measures a window nobody asked for, so prove the size took first.
            await browser
                .waitUntil(
                    async () => (await browser.execute(() => window.innerWidth)) === size.width
                )
                .catch(() => undefined)
            expect(await browser.execute(() => window.innerWidth)).toBe(size.width)

            expect(await offTheWindow()).toEqual([])
        })
    }
})

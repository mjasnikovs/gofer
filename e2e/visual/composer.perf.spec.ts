import {expect, test} from '@playwright/test'
import type {CDPSession, Page} from '@playwright/test'
import {installDesktop} from './desktop-fixture'

/**
 * What one typed character costs the conversation above the composer.
 *
 * The composer is a `contenteditable` and the conversation is its sibling inside one full-height
 * column, so a character typed into it dirties the column and the browser lays every message in it
 * out again. Measured before the fix: 0.40ms of layout per keystroke on a four-message chat and
 * 2.20ms on a four-hundred-message one — a window that types slower the longer it has been worked
 * in, which on WebKit is where the reported lag came from.
 *
 * Measured as a ratio, not a time. Milliseconds are whatever machine runs the suite; the defect is
 * the *slope*, typing costing more because there is more conversation behind it.
 * `content-visibility` on each message is what flattens it, by leaving a row off the top of the
 * viewport unlaid out until it is scrolled to.
 */

/** Conversation lengths compared. Far apart, so a slope shows well clear of the noise. */
const SHORT_CHAT = 4
const LONG_CHAT = 400
/** Enough characters that per-key noise averages out, few enough that the line never wraps. */
const KEYSTROKES = 40
/**
 * How much more a keystroke may cost on the long conversation.
 *
 * Not 1: the rows near the viewport are laid out either way, and there are more of them on a longer
 * page. It measured 1.8x with the fix and 5.5x without, so this sits between the two.
 */
const ALLOWED_SLOPE = 3

/** Lets the browser finish the frame the last keystroke asked for before the counters are read. */
async function settle(page: Page) {
    await page.evaluate(
        () =>
            new Promise<void>(resolve => {
                requestAnimationFrame(() => {
                    requestAnimationFrame(() => {
                        resolve()
                    })
                })
            })
    )
}

/** Milliseconds the browser has spent in layout since `Performance.enable`. */
async function layoutMs(session: CDPSession): Promise<number> {
    const {metrics} = await session.send('Performance.getMetrics')
    return (metrics.find(metric => metric.name === 'LayoutDuration')?.value ?? 0) * 1000
}

/** Opens the workspace on a conversation of `messages` rows and waits for it to be drawn. */
async function openConversation(page: Page, messages: number) {
    await installDesktop(page, 'streaming', {seededMessages: messages})
    await page.goto('/')
    await expect(page.getByRole('img', {name: 'Local AI connected'})).toBeVisible()
    // The last row a user sent. Only those carry the numbered opening line; an assistant reply is
    // drawn from its `parts`, which start with its reasoning.
    const lastAsked = messages % 2 === 0 ? messages - 1 : messages
    await expect(
        page
            .getByRole('log')
            .getByText(`Message ${String(lastAsked)}. Make`)
            .first()
    ).toBeAttached()
}

/** Layout milliseconds one keystroke costs with `messages` already on screen. */
async function typingCost(page: Page, messages: number): Promise<number> {
    await openConversation(page, messages)
    const composer = page.getByRole('combobox', {name: 'Message input'})
    await composer.click()
    // A warm-up run: the first characters into an empty composer pay for its placeholder going and
    // for whatever the click itself invalidated, neither of which is what typing costs.
    await page.keyboard.type('warm')
    await settle(page)

    const session = await page.context().newCDPSession(page)
    await session.send('Performance.enable')
    const before = await layoutMs(session)
    await page.keyboard.type('a'.repeat(KEYSTROKES))
    await settle(page)
    const after = await layoutMs(session)
    await session.detach()

    return (after - before) / KEYSTROKES
}

test('typing costs the same whatever is in the conversation @interaction', async ({page}) => {
    const short = await typingCost(page, SHORT_CHAT)
    const long = await typingCost(page, LONG_CHAT)

    const slope = long / Math.max(short, Number.EPSILON)
    expect(
        slope,
        `a keystroke costs ${long.toFixed(2)}ms of layout with ${String(LONG_CHAT)} messages and `
            + `${short.toFixed(2)}ms with ${String(SHORT_CHAT)} — ${slope.toFixed(1)}x, so the `
            + 'conversation is being laid out again per character'
    ).toBeLessThan(ALLOWED_SLOPE)
})

/**
 * The row that is skipped still holds the column open.
 *
 * A skipped row has no content, so its automatic minimum size is zero, and the list is a flex
 * column taller than its viewport — every row off screen was shrunk to nothing, which took a
 * twenty-message conversation from 6194px of scroll to 1875px. The scrollbar is the visible half of
 * that; the invisible half is a conversation that cannot be scrolled back through.
 */
test('a message off screen still holds its place @interaction', async ({page}) => {
    await openConversation(page, 40)

    const heights = await page.evaluate(() =>
        [...document.querySelectorAll('[role="log"] .astryx-chat-message')].map(message =>
            Math.round(message.getBoundingClientRect().height)
        )
    )
    const collapsed = heights.filter(height => height === 0).length

    expect(heights.length, 'the conversation drew no messages').toBeGreaterThan(30)
    expect(
        collapsed,
        `${String(collapsed)} of ${String(heights.length)} messages have no height at all`
    ).toBe(0)
})

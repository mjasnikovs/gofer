import {expect, test} from '@playwright/test'
import type {BrowserContext, CDPSession, Page} from '@playwright/test'
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
 * Below this, a measurement is the machine's noise rather than the window's work.
 *
 * The short conversation is the divisor, and a fast enough machine can lay four messages out in a
 * time the counter rounds to nothing — which would turn a passing ratio into an infinity. The floor
 * is what the assertion falls back to, so a budget stays a budget.
 */
const NOISE_FLOOR_MS = 0.1
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
    await expect(
        page
            .getByRole('log')
            .getByText(`Message ${String(messages)}.`)
            .first()
    ).toBeAttached()
}

/**
 * Layout milliseconds one keystroke costs with `messages` already on screen.
 *
 * On a page of its own. `installDesktop` adds an init script, and init scripts accumulate on a
 * page — measuring twice on one page would run the first conversation's fixture alongside the
 * second's, and the slope would be of something neither of them is.
 */
async function typingCost(context: BrowserContext, messages: number): Promise<number> {
    const page = await context.newPage()
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
    await page.close()

    return (after - before) / KEYSTROKES
}

test('typing costs the same whatever is in the conversation @interaction', async ({context}) => {
    const short = await typingCost(context, SHORT_CHAT)
    const long = await typingCost(context, LONG_CHAT)

    const budget = Math.max(short, NOISE_FLOOR_MS) * ALLOWED_SLOPE
    expect(
        long,
        `a keystroke costs ${long.toFixed(2)}ms of layout with ${String(LONG_CHAT)} messages and `
            + `${short.toFixed(2)}ms with ${String(SHORT_CHAT)}, against a budget of `
            + `${budget.toFixed(2)}ms — so the conversation is being laid out again per character`
    ).toBeLessThan(budget)
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

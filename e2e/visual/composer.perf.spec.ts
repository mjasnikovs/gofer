import {expect, test} from '@playwright/test'
import type {BrowserContext, CDPSession, Page} from '@playwright/test'
import {installDesktop} from './desktop-fixture'

const SHORT_CHAT = 4
const LONG_CHAT = 400
const KEYSTROKES = 40
const NOISE_FLOOR_MS = 0.1
const ALLOWED_SLOPE = 3

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

async function layoutMs(session: CDPSession): Promise<number> {
    const {metrics} = await session.send('Performance.getMetrics')
    return (metrics.find(metric => metric.name === 'LayoutDuration')?.value ?? 0) * 1000
}

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

async function typingCost(context: BrowserContext, messages: number): Promise<number> {
    const page = await context.newPage()
    await openConversation(page, messages)
    const composer = page.getByRole('combobox', {name: 'Message input'})
    await composer.click()
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

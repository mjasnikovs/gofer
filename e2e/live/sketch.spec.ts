import {browser} from '@wdio/tauri-service'
import {execFileSync} from 'node:child_process'
import {existsSync, mkdirSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {
    clickText,
    expectSelector,
    expectText,
    installActivityProbe,
    pageText,
    releaseModifiers
} from './harness'

/**
 * Puts a question with pictures in front of a real model, in the real window.
 *
 * Nothing else in this repository renders a sketch in WebKitGTK. The unit tests draw the block in
 * jsdom, which lays nothing out and never loads an iframe, so every layout defect this surface has
 * shipped — a block wider than its column, a sketch cut off by the column edge, a frame put inside
 * a button and spilling over everything — was invisible to them and obvious here.
 *
 * Only a delegated `ask_user` can put markup in front of anybody, so the prompt asks for a design:
 * the parent's copy of the tool has no `sketches` parameter at all. `design.spec.ts` next door
 * proves the several-rounds half; this one proves one round, drawn.
 *
 * The model is the user's own. What it decides to send is not asserted: this fails only when the
 * *window* is wrong, and it reports what the model did either way.
 */
const workspace = process.env.GOFER_WORKSPACE_DIR ?? ''
const shots = join(process.env.GOFER_APP_DATA_DIR ?? '', 'shots')

const PROMPT =
    'Use your ask_user tool with a brief: I need a pause menu for this game, 1280x720. Show me two '
    + "layouts side by side and I'll pick one. Don't build anything yet."

/** How long the model may work before the run is called off. */
const RUN_LIMIT_MS = 900_000

function git(...arguments_: string[]) {
    return execFileSync('git', ['-C', workspace, ...arguments_], {encoding: 'utf8'}).trim()
}

function taskBranches() {
    return git('branch', '--list', 'gofer/task-*')
        .split('\n')
        .map(entry => entry.replace('*', '').trim())
        .filter(Boolean)
}

async function shoot(name: string) {
    mkdirSync(shots, {recursive: true})
    const path = join(shots, `${name}.png`)
    writeFileSync(path, Buffer.from(await browser.takeScreenshot(), 'base64'))
    console.log(`shot ${path}`)
}

/** The composer, typed into and read back, the way the blank run does it. */
async function sendChat(prompt: string) {
    await releaseModifiers()
    await expectText(['Ask anything'], {allow: ['could not be read'], limitMs: 120_000})
    const composer = browser.$('[role="combobox"]')
    await composer.waitForDisplayed({timeout: 15_000})
    for (let attempt = 0; attempt < 3; attempt++) {
        await composer.click()
        await composer.setValue(prompt)
        if ((await composer.getText()).includes(prompt.slice(0, 20))) {
            await browser.keys('Enter')
            return
        }
    }
    throw new Error('the composer would not take the message')
}

/**
 * Every box the question draws, in window pixels.
 *
 * Read from the page rather than from a screenshot, because "is the second sketch cut off" is a
 * question about numbers and a picture can only be looked at.
 */
type Box = Readonly<{width: number; height: number; top: number; left: number; right: number}>

type Boxes = Readonly<{
    window: Readonly<{width: number; height: number}>
    frames: readonly Box[]
    answer: Readonly<{bottom: number}> | null
}>

/**
 * How many sketches are on screen, asked of the page rather than of the driver.
 *
 * The question lives in the conversation feed now, not in a dialog, so the scope is the document —
 * except while the zoom is open, which IS a dialog and is drawing one of the same sketches over the
 * block. Whichever is in front is the one being looked at.
 */
async function sketchCount(): Promise<number> {
    return browser.execute(() => {
        const zoom = document.querySelector('dialog[open]')
        return (zoom ?? document).querySelectorAll('iframe').length
    })
}

async function measure(): Promise<Boxes> {
    return browser.execute((): Boxes => {
        const box = (element: Element) => {
            const rect = element.getBoundingClientRect()
            return {
                width: rect.width,
                height: rect.height,
                top: rect.top,
                left: rect.left,
                right: rect.right
            }
        }
        const scope = document.querySelector('dialog[open]') ?? document
        const answer = [...scope.querySelectorAll('button')].find(button =>
            button.textContent.trim().startsWith('Send')
        )
        return {
            window: {width: window.innerWidth, height: window.innerHeight},
            frames: [...scope.querySelectorAll('iframe')].map(box),
            answer: answer ? {bottom: answer.getBoundingClientRect().bottom} : null
        }
    })
}

describe('a question the agent asks with pictures', () => {
    before(async () => {
        await installActivityProbe()
    })

    it('boots against the configured endpoint', async () => {
        await expectText(['Where should we start?'], {limitMs: 300_000})
        await expectSelector('[aria-label="Local AI connected"]', 60_000)
    })

    it('creates a task backed by its own branch', async () => {
        const before = taskBranches()
        await clickText('New task')
        await browser.waitUntil(() => taskBranches().length > before.length, {
            timeout: 60_000,
            interval: 200,
            timeoutMsg: 'the task never received a branch'
        })
    })

    it('draws the sketches inside the window it is in', async () => {
        await sendChat(PROMPT)

        const appeared = await browser
            .waitUntil(async () => (await sketchCount()) > 0, {
                timeout: RUN_LIMIT_MS,
                interval: 2_000,
                timeoutMsg: 'the model never asked with pictures'
            })
            .then(
                () => true,
                () => false
            )
        if (!appeared) {
            console.log(`no sketch question; the window shows: ${(await pageText()).slice(-600)}`)
            await shoot('no-sketches')
            return
        }
        await browser.pause(1_500)
        await shoot('compare')

        const boxes = await measure()
        console.log(JSON.stringify(boxes))

        // Every sketch fits the window it is being judged in. The first build drew a 1100-wide
        // dialog on a 1280 window and let the second sketch run off the edge of it.
        for (const frame of boxes.frames) {
            expect(frame.left).toBeGreaterThanOrEqual(-1)
            expect(frame.right).toBeLessThanOrEqual(boxes.window.width + 1)
            // A frame with no height is a sketch that never measured its column.
            expect(frame.height).toBeGreaterThan(40)
        }

        // Side by side means side by side: same size, same top edge. A label allowed to wrap made
        // the two columns different heights and pushed the second sketch down past the first.
        const [first, second] = boxes.frames
        if (first && second) {
            expect(Math.abs(first.top - second.top)).toBeLessThanOrEqual(1)
            expect(Math.abs(first.width - second.width)).toBeLessThanOrEqual(1)
            expect(Math.abs(first.height - second.height)).toBeLessThanOrEqual(1)
        }

        // The control that answers the question is on screen, not below the fold.
        expect(boxes.answer).not.toBeNull()
        expect(boxes.answer?.bottom ?? Infinity).toBeLessThanOrEqual(boxes.window.height + 1)
    })

    it('opens one sketch on its own and answers the question', async () => {
        type Control = Readonly<{name: string; disabled: boolean}>
        /*
         * Scoped to whichever surface is in front.
         *
         * The question is a block in the feed, so its controls are the page's. The zoom over one
         * sketch is still a dialog, and while it is open it owns every press — a closed <dialog>
         * stays in the document, so an unscoped search finds the controls of cards this window is
         * not showing, including another Close, which is what the zoom's Close press once landed on.
         */
        /** Every control the question offers, as the window has it. */
        const controls = () =>
            browser.execute(() =>
                [
                    ...(document.querySelector('dialog[open]') ?? document).querySelectorAll(
                        'button'
                    )
                ].map(button => ({
                    name: button.getAttribute('aria-label') ?? button.textContent.trim(),
                    disabled: button.disabled
                }))
            )
        /** Clicked in the page, so nothing here depends on how the driver decides what is visible. */
        const press = (name: string) =>
            browser.execute((wanted: string) => {
                const scope = document.querySelector('dialog[open]') ?? document
                const found = [...scope.querySelectorAll('button')].find(
                    button =>
                        (button.getAttribute('aria-label') ?? button.textContent.trim()) === wanted
                )
                if (!found) return false
                found.click()
                return true
            }, name)

        const before = await controls()
        console.log(`the question offers ${JSON.stringify(before)}`)

        const open = before.find(control => control.name.startsWith('Open '))
        if (open) {
            expect(await press(open.name)).toBe(true)
            await browser.pause(1_000)
            await shoot('opened')
            const opened = await measure()
            // A zoom is a viewer: one sketch, and nothing that answers the question.
            expect(opened.frames).toHaveLength(1)
            expect(opened.frames[0]?.right ?? Infinity).toBeLessThanOrEqual(opened.window.width + 1)
            expect(await press('Close')).toBe(true)
        }

        /** The control named, once the screen showing it has settled. */
        const waitFor = async (prefix: string) => {
            let found: Control | undefined
            await browser.waitUntil(
                async () => {
                    found = (await controls()).find(control => control.name.startsWith(prefix))
                    return found !== undefined
                },
                {
                    timeout: 15_000,
                    interval: 250,
                    timeoutMsg: `nothing named "${prefix}"; it offered ${JSON.stringify(before)}`
                }
            )
            return found
        }

        // Choosing is what makes the answer sendable: a question with sketches and nothing written
        // has nothing to send, and the button says so by staying disabled.
        const chosen = await waitFor('Choose ')
        expect(await press(chosen?.name ?? '')).toBe(true)

        const answer = await waitFor('Send changes')
        expect(answer?.disabled).toBe(false)
        expect(await press('Send changes')).toBe(true)

        // The sketches go when the answer is sent, which is what unblocks the child behind them.
        // The block itself stays: it is the tool call's own place in the feed, and it is back to
        // reporting what the child is doing.
        await browser.waitUntil(async () => (await sketchCount()) === 0, {
            timeout: 30_000,
            interval: 500,
            timeoutMsg: 'the sketches stayed up after the question was answered'
        })
        await shoot('answered')
        if (!existsSync(shots)) throw new Error('no screenshots were written')
    })
})

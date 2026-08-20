import {browser} from '@wdio/tauri-service'
import {execFileSync} from 'node:child_process'
import {existsSync, mkdirSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {
    clickText,
    expectSelector,
    expectText,
    installActivityProbe,
    releaseModifiers
} from './harness'

/**
 * Runs a whole design loop in the real window, against a real model.
 *
 * `sketch.spec.ts` next door proves one question with pictures. This proves the thing a design loop
 * is: several of them about one layout. What shipped before was a card that closed the moment the
 * user answered and opened again a minute later once the agent had redrawn — so a design read as a
 * queue of unrelated questions, and there was no way to say "this is right, stop".
 *
 * The two claims, and neither is visible anywhere else. The card SURVIVES an answer, because the
 * loop it belongs to is still open. And the button that ends the loop ends it: the dialog goes, the
 * turn carries on, and nothing asks the user anything else.
 *
 * The model is the user's own and what it draws is not asserted. This fails only when the *window*
 * is wrong.
 *
 * Not in the sweep's spec list, the same way `sketch.spec.ts` is not: the ordered sweep is one file
 * and these are each a scenario somebody runs on purpose. To run it, point `specs` in
 * `wdio.live.conf.ts` at this file, `node scripts/reset-live-sweep.mjs`, then `npm run test:live`.
 * It needs a connection the parent agent can reach — a local endpoint is enough, and is what this
 * was written against.
 */
const workspace = process.env.GOFER_WORKSPACE_DIR ?? ''
const shots = join(process.env.GOFER_APP_DATA_DIR ?? '', 'shots')

/*
 * The tool is named, and that is deliberate.
 *
 * This sweep is about the window, not about whether a model reaches for the right tool. Left to
 * choose, the local model asked with `ask_user` — one question, no loop — and the sweep then spent
 * fifteen minutes proving nothing about the thing it exists to prove.
 */
const PROMPT =
    'Use the design_with_user tool to agree a pause menu for this game with me, 1280x720. It needs '
    + 'a title and Resume, Options and Quit. I want to see options and change my mind a few times '
    + 'before we settle it. Do not build anything yet.'

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

/** The composer, typed into and read back, the way the sketch sweep does it. */
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

type Card = Readonly<{
    open: boolean
    sketches: number
    redrawing: boolean
    round: string
    buttons: readonly string[]
}>

/** What the card is doing right now, asked of the page rather than of the driver. */
async function card(): Promise<Card> {
    return browser.execute((): Card => {
        const dialog = document.querySelector('dialog[open]')
        const text = dialog?.textContent ?? ''
        const round = /Round (\d+)/u.exec(text)
        return {
            open: dialog !== null,
            sketches: dialog?.querySelectorAll('iframe').length ?? 0,
            redrawing: text.includes('Design in progress'),
            round: round?.[1] ?? '',
            buttons: [...(dialog?.querySelectorAll('button') ?? [])].map(button =>
                button.textContent.trim()
            )
        }
    })
}

/** Presses a control by the text on it, from inside the dialog. */
async function press(label: string): Promise<boolean> {
    return browser.execute((name: string) => {
        const found = [...document.querySelectorAll('dialog[open] button')].find(
            button => button.textContent.trim() === name
        )
        if (!(found instanceof HTMLButtonElement) || found.disabled) return false
        found.click()
        return true
    }, label)
}

async function waitForCard(
    describe: string,
    ready: (state: Card) => boolean,
    limitMs = RUN_LIMIT_MS
): Promise<Card> {
    let seen = await card()
    await browser.waitUntil(
        async () => {
            seen = await card()
            return ready(seen)
        },
        {
            timeout: limitMs,
            interval: 2_000,
            timeoutMsg: `${describe}; the card was ${JSON.stringify(seen)}`
        }
    )
    return seen
}

describe('a design agreed with the user over several rounds', () => {
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

    it('keeps one card for the whole loop and ends it on the button', async () => {
        await sendChat(PROMPT)

        // Round one. A design loop's card carries the control that ends it; a plain question's does
        // not, and that is how this sweep tells the two apart without reading any of our own state.
        const first = await waitForCard(
            'no design loop was opened; if a card appeared with an Answer button the model asked '
                + 'with ask_user instead, which is a model choice and not a window fault',
            state => state.sketches > 0 && state.buttons.includes('Complete and handoff')
        )
        console.log(`round one: ${JSON.stringify(first)}`)
        await shoot('design-round-one')
        expect(first.buttons).toContain('Send changes')

        // A change, not an approval, so the agent has to draw again.
        const chosen = first.buttons.find(name => name.startsWith('Choose '))
        expect(chosen).toBeDefined()
        expect(await press(chosen ?? '')).toBe(true)
        await browser.execute(() => {
            const box = document.querySelector('dialog[open] textarea')
            if (!(box instanceof HTMLTextAreaElement)) return
            const setter = Object.getOwnPropertyDescriptor(
                HTMLTextAreaElement.prototype,
                'value'
            )?.set
            setter?.call(box, 'Make the title smaller and left-align the buttons.')
            box.dispatchEvent(new Event('input', {bubbles: true}))
        })
        await browser.waitUntil(async () => (await card()).buttons.includes('Send changes'), {
            timeout: 15_000,
            interval: 250,
            timeoutMsg: 'the card lost its controls'
        })
        expect(await press('Send changes')).toBe(true)

        /*
         * The claim this whole sweep exists for.
         *
         * Before, the card left the screen here and came back a minute later as a new question. It
         * has to still be there, and it has to say it is working rather than showing a layout the
         * user can no longer act on.
         */
        const between = await waitForCard(
            'the card closed when the answer was sent',
            state => state.redrawing,
            60_000
        )
        console.log(`between rounds: ${JSON.stringify(between)}`)
        expect(between.open).toBe(true)
        expect(between.sketches).toBe(0)
        await shoot('design-redrawing')

        // Round two, in the same card, and it says which round it is.
        const second = await waitForCard(
            'the revision never arrived',
            state => state.sketches > 0 && state.buttons.includes('Complete and handoff')
        )
        console.log(`round two: ${JSON.stringify(second)}`)
        expect(second.round).toBe('2')
        await shoot('design-round-two')

        // And the way out. Choosing is what makes it pressable: approving with nothing chosen hands
        // the agent a pile of layouts and the news that the user liked one.
        const pick = second.buttons.find(name => name.startsWith('Choose '))
        expect(await press(pick ?? '')).toBe(true)
        await browser.waitUntil(
            async () => {
                const state = await card()
                return state.buttons.includes('Complete and handoff')
            },
            {timeout: 15_000, interval: 250, timeoutMsg: 'the approval never became available'}
        )
        expect(await press('Complete and handoff')).toBe(true)

        // The loop is over, so the card goes — and stays gone rather than reopening for one more
        // round, which is what the spent ration is for.
        await browser.waitUntil(async () => !(await card()).open, {
            timeout: 120_000,
            interval: 1_000,
            timeoutMsg: 'the card stayed up after the design was agreed'
        })
        await shoot('design-agreed')
        if (!existsSync(shots)) throw new Error('no screenshots were written')
    })
})

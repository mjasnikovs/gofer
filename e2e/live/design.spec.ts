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
 * `sketch.spec.ts` next door proves one question with pictures. This proves the thing a design is:
 * several of them about one layout. What shipped before was a card that closed the moment the user
 * answered and opened again a minute later once the agent had redrawn — so a design read as a queue
 * of unrelated questions, and there was no way to say "this is right, stop".
 *
 * The two claims, and neither is visible anywhere else. The BLOCK SURVIVES an answer, because every
 * round carries the same `ownerCallId` and the block is the tool call's own place in the feed. And
 * the button that ends the delegation ends it: the question goes, the turn carries on, and nothing
 * asks the user anything else.
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
 * The brief is named, and that is deliberate.
 *
 * This sweep is about the window, not about whether a model reaches for the right half of the tool.
 * Left to choose, the local model asked in words — one question, no design — and the sweep then
 * spent fifteen minutes proving nothing about the thing it exists to prove.
 */
const PROMPT =
    'Use your ask_user tool with a brief to agree a pause menu for this game with me, 1280x720. It '
    + 'needs a title and Resume, Options and Quit. I want to see options and change my mind a few '
    + 'times before we settle it. Do not build anything yet.'

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
    asking: boolean
    sketches: number
    round: string
    buttons: readonly string[]
}>

/**
 * What the block is doing right now, asked of the page rather than of the driver.
 *
 * The document, not a dialog: the question is a block in the conversation feed and there is nothing
 * modal about it. `asking` is the presence of the control that ends a delegation, which is also how
 * this sweep tells a design apart from a plain question without reading any of our own state.
 */
async function card(): Promise<Card> {
    return browser.execute((): Card => {
        const text = document.body.textContent
        const round = /Round (\d+)/u.exec(text)
        const buttons = [...document.querySelectorAll('button')].map(button =>
            button.textContent.trim()
        )
        return {
            asking: buttons.includes('Done, build it'),
            sketches: document.querySelectorAll('iframe').length,
            round: round?.[1] ?? '',
            buttons
        }
    })
}

/** Presses a control by the text on it. */
async function press(label: string): Promise<boolean> {
    return browser.execute((name: string) => {
        const found = [...document.querySelectorAll('button')].find(
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

    it('keeps one block for the whole design and ends it on the button', async () => {
        await sendChat(PROMPT)

        // Round one. A delegated question carries the control that ends the delegation; a plain
        // question's does not, and that is how this sweep tells the two apart.
        const first = await waitForCard(
            'no design was delegated; if a question appeared with a plain Send button the model '
                + 'asked in words instead, which is a model choice and not a window fault',
            state => state.sketches > 0 && state.asking
        )
        console.log(`round one: ${JSON.stringify(first)}`)
        await shoot('design-round-one')
        expect(first.buttons).toContain('Send changes')

        // A change, not an approval, so the agent has to draw again.
        const chosen = first.buttons.find(name => name.startsWith('Choose '))
        expect(chosen).toBeDefined()
        expect(await press(chosen ?? '')).toBe(true)
        await browser.execute(() => {
            const box = document.querySelector('textarea')
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
            timeoutMsg: 'the block lost its controls'
        })
        expect(await press('Send changes')).toBe(true)

        /*
         * The claim this whole sweep exists for.
         *
         * Before, the card left the screen here and came back a minute later as a new question. The
         * block stays where it is and stops showing a layout the user can no longer act on.
         */
        const between = await waitForCard(
            'the sketches stayed up after the answer was sent',
            state => state.sketches === 0 && !state.asking,
            60_000
        )
        console.log(`between rounds: ${JSON.stringify(between)}`)
        await shoot('design-redrawing')

        // Round two, in the same block, and it says which round it is.
        const second = await waitForCard(
            'the revision never arrived',
            state => state.sketches > 0 && state.asking
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
                return state.asking
            },
            {timeout: 15_000, interval: 250, timeoutMsg: 'the approval never became available'}
        )
        expect(await press('Done, build it')).toBe(true)

        // The design is over, so the question goes — and stays gone rather than coming back for one
        // more round, which is what closing the child's loop is for.
        await browser.waitUntil(
            async () => {
                const state = await card()
                return !state.asking && state.sketches === 0
            },
            {
                timeout: 120_000,
                interval: 1_000,
                timeoutMsg: 'the question stayed up after the design was agreed'
            }
        )
        await shoot('design-agreed')
        if (!existsSync(shots)) throw new Error('no screenshots were written')
    })
})

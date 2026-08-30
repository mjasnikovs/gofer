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

const workspace = process.env.GOFER_WORKSPACE_DIR ?? ''
const shots = join(process.env.GOFER_APP_DATA_DIR ?? '', 'shots')

const PROMPT =
    'Use your ask_user tool with a brief to agree a pause menu for this game with me, 1280x720. It '
    + 'needs a title and Resume, Options and Quit. I want to see options and change my mind a few '
    + 'times before we settle it. Do not build anything yet.'

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

        const first = await waitForCard(
            'no design was delegated; if a question appeared with a plain Send button the model '
                + 'asked in words instead, which is a model choice and not a window fault',
            state => state.sketches > 0 && state.asking
        )
        console.log(`round one: ${JSON.stringify(first)}`)
        await shoot('design-round-one')
        expect(first.buttons).toContain('Send changes')

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

        const between = await waitForCard(
            'the sketches stayed up after the answer was sent',
            state => state.sketches === 0 && !state.asking,
            60_000
        )
        console.log(`between rounds: ${JSON.stringify(between)}`)
        await shoot('design-redrawing')

        const second = await waitForCard(
            'the revision never arrived',
            state => state.sketches > 0 && state.asking
        )
        console.log(`round two: ${JSON.stringify(second)}`)
        expect(second.round).toBe('2')
        await shoot('design-round-two')

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

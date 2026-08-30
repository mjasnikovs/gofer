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

const RUN_LIMIT_MS = 600_000

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

async function newTask() {
    for (let skips = 0; skips < 5 && (await feed()).waiting > 0; skips += 1) {
        if (!(await press('Let the agent decide'))) break
        await browser.pause(500)
    }
    await expectText(['Ask anything'], {allow: ['could not be read'], limitMs: 180_000})
    const before = taskBranches()
    const started = await browser.execute(() => {
        const found = [...document.querySelectorAll('button')].find(
            button => button.textContent.trim() === 'New task'
        )
        if (!(found instanceof HTMLButtonElement)) return false
        found.click()
        return true
    })
    if (!started) await clickText('New task')
    await browser.waitUntil(() => taskBranches().length > before.length, {
        timeout: 60_000,
        interval: 200,
        timeoutMsg: 'the task never received a branch'
    })
}

type Feed = Readonly<{
    waiting: number
    delegated: boolean
    sketches: number
    round: string
    buttons: readonly string[]
}>

async function feed(): Promise<Feed> {
    return browser.execute((): Feed => {
        const all = [...document.querySelectorAll('button')]
        const blocks = all
            .filter(button => button.textContent.trim() === 'Let the agent decide')
            .map(button => button.closest('.astryx-card'))
            .filter((card): card is Element => card !== null)
        const buttons = [...(blocks[0]?.querySelectorAll('button') ?? [])].map(button =>
            button.textContent.trim()
        )
        const round = /Round (\d+)/u.exec(blocks[0]?.textContent ?? '')
        return {
            waiting: blocks.length,
            delegated: buttons.includes('Done, build it'),
            sketches: document.querySelectorAll('iframe').length,
            round: round?.[1] ?? '',
            buttons
        }
    })
}

async function press(label: string, which = 0): Promise<boolean> {
    return browser.execute(
        (name: string, index: number) => {
            const blocks = [...document.querySelectorAll('button')]
                .filter(button => button.textContent.trim() === 'Let the agent decide')
                .map(button => button.closest('.astryx-card'))
                .filter(Boolean)
            const scope = blocks[index] ?? document
            const found = [...scope.querySelectorAll('button')].find(
                button => button.textContent.trim() === name
            )
            if (!(found instanceof HTMLButtonElement) || found.disabled) return false
            found.click()
            return true
        },
        label,
        which
    )
}

async function conversationTail(): Promise<string> {
    const text = await browser.execute(
        () => document.querySelector('[class*="chat-message-list"]')?.textContent ?? ''
    )
    return text.slice(-700).replace(/\s+/gu, ' ')
}

async function write(text: string, which = 0): Promise<boolean> {
    return browser.execute(
        (value: string, index: number) => {
            const blocks = [...document.querySelectorAll('button')]
                .filter(button => button.textContent.trim() === 'Let the agent decide')
                .map(button => button.closest('.astryx-card'))
                .filter(Boolean)
            const box =
                blocks[index]?.querySelector('textarea')
                ?? [...document.querySelectorAll('textarea')][index]
            if (!(box instanceof HTMLTextAreaElement)) return false
            const setter = Object.getOwnPropertyDescriptor(
                HTMLTextAreaElement.prototype,
                'value'
            )?.set
            setter?.call(box, value)
            box.dispatchEvent(new Event('input', {bubbles: true}))
            return true
        },
        text,
        which
    )
}

async function waitForFeed(
    describe: string,
    ready: (state: Feed) => boolean,
    limitMs = RUN_LIMIT_MS
): Promise<Feed> {
    let seen = await feed()
    await browser.waitUntil(
        async () => {
            seen = await feed()
            return ready(seen)
        },
        {
            timeout: limitMs,
            interval: 2_000,
            timeoutMsg: `${describe}; the feed was ${JSON.stringify(seen)}`
        }
    )
    return seen
}

async function waitForQuiet(describe: string, limitMs = 180_000) {
    try {
        await waitForFeed(describe, state => state.waiting === 0 && state.sketches === 0, limitMs)
    } catch (error) {
        console.log(`stuck: ${await conversationTail()}`)
        throw error
    }
}

describe('every shape a question takes', () => {
    before(async () => {
        await installActivityProbe()
    })

    it('boots against the configured endpoint', async () => {
        await expectText(['Where should we start?'], {limitMs: 300_000})
        await expectSelector('[aria-label="Local AI connected"]', 60_000)
    })

    it('sends an option the moment it is pressed', async () => {
        await newTask()
        await sendChat(
            'Use your ask_user tool to ask me one question in words: should the pause menu live in '
                + 'its own scene or inside the HUD? Offer exactly those two as options. Do not send '
                + 'a brief and do not build anything.'
        )

        const asked = await waitForFeed(
            'the model never asked a plain question',
            state => state.waiting > 0
        )
        console.log(`one question: ${JSON.stringify(asked.buttons)}`)
        await shoot('ask-one-question')
        expect(asked.delegated).toBe(false)
        expect(asked.sketches).toBe(0)

        const option = asked.buttons.find(
            name => name.length > 0 && !['Let the agent decide', 'Send'].includes(name)
        )
        expect(option).toBeDefined()
        expect(await press(option ?? '')).toBe(true)
        await waitForFeed(
            'the question stayed up after an option was pressed',
            state => state.waiting === 0,
            60_000
        )
        console.log(`after the option: ${await conversationTail()}`)

        await waitForQuiet('the model kept asking after its question was answered')
        await shoot('ask-one-answered')
    })

    it('carries one block across several rounds of words', async () => {
        await newTask()
        await sendChat(
            'Use your ask_user tool to ask me where the pause menu should live. When I answer, keep '
                + 'asking me about that same decision twice more, then stop and tell me what we '
                + 'settled. Send no brief and build nothing.'
        )

        for (const [round, reply] of [
            [1, 'Its own scene, but I want to talk about how it is opened.'],
            [2, 'Opened from an input action, not from a button.'],
            [3, 'Yes, that is settled. Write it down.']
        ] as const) {
            const asked = await waitForFeed(
                `round ${String(round)} never arrived`,
                state => state.waiting > 0
            )
            console.log(`round ${String(round)}: round badge ${asked.round || '-'}`)
            if (round > 1) expect(asked.round).toBe(String(round))
            expect(await write(reply)).toBe(true)
            await browser.waitUntil(async () => (await feed()).buttons.includes('Send'), {
                timeout: 15_000,
                interval: 250,
                timeoutMsg: 'the block lost its Send control'
            })
            if (round === 1) await shoot('ask-words-round-one')
            expect(await press('Send')).toBe(true)
            await waitForFeed(
                'the question stayed up after the answer was sent',
                state => state.waiting === 0,
                120_000
            )
        }
        await waitForQuiet('the turn never finished')
        await shoot('ask-words-finished')
    })

    it('agrees a design in a single round', async () => {
        await newTask()
        await sendChat(
            'Use your ask_user tool with a brief to design a pause menu for this game, 1280x720, '
                + 'with a title and Resume, Options and Quit. Show me two layouts in ONE round. I '
                + 'will pick one and we are done. Do not build anything.'
        )

        const asked = await waitForFeed(
            'no design was delegated; if a plain question appeared the model asked in words, which '
                + 'is a model choice and not a window fault',
            state => state.sketches > 0 && state.delegated
        )
        console.log(`design round one: ${String(asked.sketches)} sketch(es)`)
        await shoot('ask-design-one-round')

        expect(asked.buttons.includes('Done, build it')).toBe(true)
        const chosen = asked.buttons.find(name => name.startsWith('Choose '))
        expect(chosen).toBeDefined()
        expect(await press(chosen ?? '')).toBe(true)
        await browser.waitUntil(async () => press('Done, build it'), {
            timeout: 15_000,
            interval: 250,
            timeoutMsg: 'the approval never became available'
        })

        await waitForQuiet('the design stayed up after it was agreed')
        await shoot('ask-design-one-agreed')
    })

    it('iterates a design in one block and ends it on the button', async () => {
        await newTask()
        await sendChat(
            'Use your ask_user tool with a brief to agree a pause menu for this game with me, '
                + '1280x720, with a title and Resume, Options and Quit. I want to see options and '
                + 'change my mind a few times before we settle it. Do not build anything yet.'
        )

        const first = await waitForFeed(
            'no design was delegated',
            state => state.sketches > 0 && state.delegated
        )
        console.log(`iterating design round one: ${String(first.sketches)} sketch(es)`)
        await shoot('ask-design-many-round-one')

        for (const note of [
            'Make the title smaller and left-align the buttons.',
            'Now tighten the spacing between the buttons.'
        ]) {
            const chosen = (await feed()).buttons.find(name => name.startsWith('Choose '))
            if (chosen) expect(await press(chosen)).toBe(true)
            expect(await write(note)).toBe(true)
            await browser.waitUntil(async () => press('Send changes'), {
                timeout: 15_000,
                interval: 250,
                timeoutMsg: 'the block lost its Send changes control'
            })
            await waitForFeed(
                'the sketches stayed up after the answer was sent',
                state => state.sketches === 0 && !state.delegated,
                120_000
            )
            await waitForFeed('the revision never arrived', state => state.sketches > 0)
        }

        const last = await feed()
        console.log(`iterating design last round: badge ${last.round || '-'}`)
        expect(Number(last.round || '0')).toBeGreaterThan(1)
        await shoot('ask-design-many-last-round')

        const pick = last.buttons.find(name => name.startsWith('Choose '))
        if (pick) expect(await press(pick)).toBe(true)
        await browser.waitUntil(async () => press('Done, build it'), {
            timeout: 15_000,
            interval: 250,
            timeoutMsg: 'the approval never became available'
        })

        await waitForQuiet('the design stayed up after it was agreed')
        await shoot('ask-design-many-agreed')
    })

    it('shows two live questions at once, each answerable on its own', async () => {
        await newTask()
        await sendChat(
            'Call your ask_user tool TWICE in the same step, as two parallel tool calls, before you '
                + 'say anything else. The first asks where the pause menu should live. The second '
                + 'asks whether the game should pause the physics. Send no brief and build nothing.'
        )

        const asked = await waitForFeed(
            'the model never asked anything',
            state => state.waiting > 0
        )
        const both = await waitForFeed(
            'only one question was ever live',
            state => state.waiting > 1,
            30_000
        ).catch(() => asked)

        console.log(`live questions: ${String(both.waiting)}`)
        await shoot('ask-parallel')
        if (both.waiting < 2) {
            console.log('the model asked one question at a time; nothing here is a window fault')
            expect(await press('Let the agent decide')).toBe(true)
            await waitForQuiet('the question stayed up after it was skipped')
            return
        }

        expect(await write('Physics stays running.', 1)).toBe(true)
        expect(await press('Send', 1)).toBe(true)
        await waitForFeed('the answered question stayed up', state => state.waiting === 1, 60_000)
        await shoot('ask-parallel-one-answered')

        expect(await write('Its own scene.', 0)).toBe(true)
        expect(await press('Send', 0)).toBe(true)
        await waitForQuiet('the second question stayed up after it was answered')
        await shoot('ask-parallel-both-answered')

        if (!existsSync(shots)) throw new Error('no screenshots were written')
    })
})

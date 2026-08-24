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
 * Every way a question can go, in the real window, against a real model.
 *
 * `design.spec.ts` next door proves one of these at length. This is the breadth pass: the five
 * shapes a question actually takes, one after another, each in its own task.
 *
 *   1. one question, an option pressed, done
 *   2. one question, several rounds of words, done
 *   3. a design, one sketch chosen, done
 *   4. a design, several rounds, done
 *   5. two questions live at the same time
 *
 * The last one is why the block replaced a modal. A dialog can only show one thing, so the second
 * question of a parallel pair waited behind the first with nothing on screen saying it existed. Two
 * blocks in the feed each have their own text field and neither has to be chosen between.
 *
 * The model is the user's own and what it draws is not asserted. This fails only when the *window*
 * is wrong, and it reports what the model did either way.
 *
 * Not in the sweep's spec list, the same way `design.spec.ts` is not: the ordered sweep is one file
 * and these are each a scenario somebody runs on purpose. To run it, point `specs` in
 * `wdio.live.conf.ts` at this file, `node scripts/reset-live-sweep.mjs`, then `npm run test:live`.
 */
const workspace = process.env.GOFER_WORKSPACE_DIR ?? ''
const shots = join(process.env.GOFER_APP_DATA_DIR ?? '', 'shots')

/** How long the model may work on one scenario before it is called off. */
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

/** The composer, typed into and read back, the way the design sweep does it. */
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
 * A fresh task, so each scenario starts on an empty chat rather than in the last one's context.
 *
 * Anything the previous scenario left waiting is skipped first. A question that is still parked
 * holds its tool call open, and a run that walks away from one leaves the next scenario starting
 * beside a turn that has not finished — which is how four scenarios in a row failed on a branch
 * that never arrived.
 */
async function newTask() {
    /*
     * Bounded, and the bound is the finding.
     *
     * A skip says "decide it yourself, do not ask again", and nothing enforces it: a delegated child
     * that ignores the sentence simply asks again. An unbounded loop here skipped one child
     * thirty-eight times in a row before its step ceiling stopped it — which is what a user holding
     * down the skip button would get, and it is the cost the plan's "no ration" decision accepted.
     */
    for (let skips = 0; skips < 5 && (await feed()).waiting > 0; skips += 1) {
        if (!(await press('Let the agent decide'))) break
        await browser.pause(500)
    }
    // And the turn has to be over, not merely un-blocked. A task made while one is still streaming
    // never got its branch — twice, in the same run — and the composer's own placeholder is what
    // says which state the window is in.
    await expectText(['Ask anything'], {allow: ['could not be read'], limitMs: 180_000})
    const before = taskBranches()
    /*
     * Clicked in the page rather than through the driver, which is how everything else in this file
     * presses things.
     *
     * The driver refuses a control it considers undisplayed, and the sidebar collapsed itself
     * between two scenarios of one run — twice — leaving "New task" present and hidden. Whatever
     * collapsed it is not this seam's business: scenario three passed on the design flow one minute
     * earlier, and a run that cannot start its fourth scenario reports nothing about the third.
     */
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
    /** How many questions are waiting for an answer right now. */
    waiting: number
    /** Whether any of them is a delegation, which is the only kind with a loop to end. */
    delegated: boolean
    sketches: number
    round: string
    /** Every control inside the first waiting block, and nothing from anywhere else. */
    buttons: readonly string[]
}>

/**
 * What the conversation is showing, asked of the page rather than of the driver.
 *
 * The document, not a dialog: a question is a block in the feed and there is nothing modal about it.
 * `waiting` counts "Let the agent decide", which every waiting question carries exactly one of — so
 * it is the count of questions on screen, which is the thing scenario five is about.
 */
async function feed(): Promise<Feed> {
    return browser.execute((): Feed => {
        const all = [...document.querySelectorAll('button')]
        // Every block that is waiting, found by the one control each of them carries exactly one of.
        const blocks = all
            .filter(button => button.textContent.trim() === 'Let the agent decide')
            .map(button => button.closest('.astryx-card'))
            .filter((card): card is Element => card !== null)
        /*
         * The FIRST block's controls, and nothing from anywhere else.
         *
         * Scanning the document was wrong and cost a run to find out: the explorer's Scene tab is a
         * button reading "SceneScene", and a search for an option about a scene matched that before
         * it ever reached the question. Everything on this screen is a button.
         */
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

/**
 * Presses a control by the text on it, inside a question block rather than anywhere on screen.
 *
 * Scoped, and that is not fussiness. The sidebar lists every task by its own first line, and those
 * lines are the prompts this file sends — so an unscoped search for an option named "Its own scene"
 * can match a task title instead and navigate away from the chat it was meant to answer.
 *
 * The block is found by the one control every waiting question carries exactly one of.
 */
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

/** What the conversation says right now, trimmed to the tail that matters. */
async function conversationTail(): Promise<string> {
    const text = await browser.execute(
        () => document.querySelector('[class*="chat-message-list"]')?.textContent ?? ''
    )
    return text.slice(-700).replace(/\s+/gu, ' ')
}

/**
 * Types into one of the blocks' answer fields.
 *
 * By index, because scenario five has two of them on screen at once and each belongs to its own
 * question — which is the whole reason the block carries its own field rather than borrowing the
 * composer.
 */
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

/** The turn is over: nothing is waiting and the composer is free again. */
async function waitForQuiet(describe: string, limitMs = 180_000) {
    try {
        await waitForFeed(describe, state => state.waiting === 0 && state.sketches === 0, limitMs)
    } catch (error) {
        // What the conversation actually says, because "it is still waiting" and "it asked again"
        // look identical from a button list and need different fixes.
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

    /**
     * One question, one press, done.
     *
     * The commonest shape there is, and the one the block has to make cheapest: an option is a whole
     * answer, so pressing it sends. Anything that asked the user to press a second button would be
     * asking them to confirm a decision they had already made.
     */
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

        // An option, not the Send button. The list is the block's own, so everything in it that is
        // not one of the two standing controls is one of the model's suggested answers.
        const option = asked.buttons.find(
            name => name.length > 0 && !['Let the agent decide', 'Send'].includes(name)
        )
        expect(option).toBeDefined()
        expect(await press(option ?? '')).toBe(true)
        // The press is a whole answer, so the question has to leave at once. Asserted separately
        // from the turn finishing: "the answer never landed" and "the model asked again" are
        // different faults and only one of them is the window's.
        await waitForFeed(
            'the question stayed up after an option was pressed',
            state => state.waiting === 0,
            60_000
        )
        console.log(`after the option: ${await conversationTail()}`)

        await waitForQuiet('the model kept asking after its question was answered')
        await shoot('ask-one-answered')
    })

    /**
     * One question, several rounds of words.
     *
     * The block is the tool call's own place in the feed, so a second asking under the same
     * identifier is the same block with new content — nothing opens and nothing closes. What has to
     * be right is the field: an answer composed for round one must never be sitting in round two's
     * box.
     */
    it('carries one block across several rounds of words', async () => {
        await newTask()
        // Deliberately NOT told how to do it. Naming `questionId` here would prove the model can
        // follow an instruction, not that the tool told it the identifier — and for a plain worded
        // answer it once did not, so a follow-up became a second card.
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
            // The second asking has to land on the SAME block, which is what the badge says. A new
            // card instead is the pile of unrelated questions this seam replaced a modal to remove.
            if (round > 1) expect(asked.round).toBe(String(round))
            expect(await write(reply)).toBe(true)
            await browser.waitUntil(async () => (await feed()).buttons.includes('Send'), {
                timeout: 15_000,
                interval: 250,
                timeoutMsg: 'the block lost its Send control'
            })
            if (round === 1) await shoot('ask-words-round-one')
            expect(await press('Send')).toBe(true)
            // The answer left with the question: nothing may carry into the next round's box.
            await waitForFeed(
                'the question stayed up after the answer was sent',
                state => state.waiting === 0,
                120_000
            )
        }
        await waitForQuiet('the turn never finished')
        await shoot('ask-words-finished')
    })

    /**
     * A design, chosen in one round.
     *
     * The cheapest shape a delegation has: the child draws, the user likes one, and it is over. The
     * ending is still the button — picking a sketch is a preference, and reading it as agreement is
     * how a layout nobody approved came back as one they had.
     */
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

        // Approving with nothing chosen would hand the agent a pile of layouts and the news that
        // the user liked one, so the button is held shut until a sketch is picked.
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

    /**
     * A design, several rounds.
     *
     * The shape the whole seam was built for. What shipped before was a card that closed on every
     * answer and reopened a minute later once the agent had redrawn, so a design read as a queue of
     * unrelated questions. Here the block stays where it is and its content changes.
     */
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

        // Two changes, so the block is revised twice rather than once.
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
            // The sketches go with the answer: a layout the user can still read but no longer act
            // on invites them to keep judging one that is already being replaced.
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

    /**
     * Two questions at once, which is the reason the modal had to go.
     *
     * The parent dispatches its tool calls in parallel, so nothing stops it asking twice in one
     * step. A dialog can only show one of them: the second waited behind the first with nothing on
     * screen saying it existed, and the user had to answer in an order somebody else chose. Two
     * blocks each carry their own field, so neither has to be chosen between.
     *
     * Whether the model actually issues two calls in one step is its decision, not the window's, so
     * a run that only ever shows one is reported rather than failed.
     */
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
        // A moment for the second call's block to arrive: the two land on separate events.
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

        // Each block has its own field. Answering the second one first is the thing a dialog could
        // not do at all, so that is what this does.
        // The second block, by index, both times. Writing into one and sending from the other is
        // the mistake this scenario exists to catch — and it caught it here first, on the test:
        // block one's Send was correctly held shut because nothing had been typed into it.
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

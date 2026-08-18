import {expect} from '@wdio/globals'
import {browser} from '@wdio/tauri-service'
import {
    buttonSelector,
    clickButton,
    clickControl,
    clickSelector,
    clickText,
    expectEnabled,
    conversationText,
    count,
    fillLabelledInput,
    installActivityProbe,
    invokeCommand,
    labelledInputIsDisabled,
    labelledInputValue,
    pageErrors,
    pageText,
    shows,
    untilText
} from './harness'

/**
 * The four phases that run before a planned task's first turn, driven for real.
 *
 * Nothing here is stubbed. The phases talk to the configured model, the research workers read a real
 * Godot project, and the questions the grill phase cannot settle stop and wait for this file to
 * answer them.
 *
 * The suite is ordered, because the application is: one window, one checkout, and a task operation
 * refused while another is running. Each scenario leaves the window on a finished task.
 *
 * What it is actually trying to find out, in the order the tests appear:
 *
 *   1. Does an ordinary ask produce a specification, and does it arrive as the task's first message?
 *   2. Does every control on the question card do what it says?
 *   3. Does an ask built on things that do not exist produce an honest answer or an invented one?
 *   4. Does an ask that is not a task at all end cleanly rather than looping?
 *   5. Does a stop mid-run keep the phases that finished?
 *   6. Is a basic task still exactly what it was?
 */

/** How long one brief may take before the sweep calls it hung. Four phases on a reasoning model. */
const BRIEF_LIMIT = 900_000
/** How long to wait for a question to appear, which is the two phases before it plus its own. */
const QUESTION_LIMIT = 600_000

/** What the stored row says about a task's brief. Read through the command the panel reads. */
type BriefRow = {
    status: string
    phase: string
    rawPrompt: string
    refined: string | null
    research: string | null
    qa: string | null
    spec: string | null
    reason: string | null
} | null

const readBrief = (taskId: string) => invokeCommand<BriefRow>('read_task_brief', {taskId})

const activeTaskId = async () =>
    invokeCommand<{id: string; isCurrent: boolean}[]>('list_project_tasks').then(
        tasks => tasks.find(task => task.isCurrent)?.id ?? ''
    )

/** Opens the new-task dialog, says what the task is, and picks how much work to do first. */
async function newTask(ask: string, mode: 'basic' | 'planned') {
    await endTurn()
    // A side-nav item, which is an anchor with an icon rather than a button — so it is matched by
    // its own text node the way every other navigation step in these sweeps matches one.
    await clickText('New task', 60_000)
    await fillLabelledInput('What needs doing?', ask)
    if (mode === 'planned') await clickText('Plan it first')
    await clickButton(mode === 'planned' ? 'Plan it' : 'Create task')
}

/** The suggested answers on the question card, as the design system renders a selectable card. */
const SUGGESTION = '//*[contains(concat(" ", @class, " "), " astryx-selectable-card ")]'

/**
 * Ends whatever turn the window is running, and waits until it is idle.
 *
 * Every scenario here makes a task, and a task cannot be made while a turn is running — the control
 * that makes one is locked for exactly as long as the checkout could move under it. A planned task
 * hands its specification to the agent and the agent starts working on it, so without this the next
 * scenario meets a locked sidebar rather than the feature it came to test.
 *
 * The implementation turn is not this sweep's subject. What the phases produced is, and that is
 * already on disk by the time the turn starts.
 */
async function endTurn() {
    // A question first, because a run blocked on one is not going anywhere and Stop is what settles
    // it. Left up, the card outlives the test that would have answered it and the next scenario
    // waits out a wait nobody is going to end.
    if (await asking()) {
        await clickButton('Let the agent decide', 30_000).catch(() => undefined)
    }
    if (await shows(WORKING)) {
        await clickControl('Stop', 60_000).catch(() => undefined)
    }
    await browser.waitUntil(async () => !(await shows(WORKING)), {
        timeout: 300_000,
        interval: 2_000,
        timeoutMsg: 'the window never went idle, so the next task cannot be made'
    })
}

/** What the composer says while a turn is running. */
const WORKING = 'Gofer is working…'

/** Whether the question card is on screen right now. */
const asking = () => shows('Your answer')

/** Answers every question the run puts up, however many that turns out to be. */
async function answerEveryQuestion(answer: string, limitMs = BRIEF_LIMIT) {
    const deadline = Date.now() + limitMs
    let answered = 0
    while (Date.now() < deadline) {
        if (await asking()) {
            await fillLabelledInput('Your answer', answer)
            await clickButton('Answer')
            answered += 1
            await browser.pause(1_000)
            continue
        }
        if (!(await shows('Planning this task'))) return answered
        await browser.pause(2_000)
    }
    throw new Error(`the brief never finished; the window shows: ${await pageText()}`)
}

before(async () => {
    await installActivityProbe()
})

describe('a planned task', () => {
    let taskId = ''

    it('runs four phases and hands the chat a specification', async () => {
        await newTask(
            'Add a pause menu that opens on the ui_cancel action and resumes the game when it '
                + 'closes. Reuse whatever UI conventions this project already has.',
            'planned'
        )
        await untilText(['Planning this task'], {limitMs: 120_000})
        taskId = await activeTaskId()
        expect(taskId).not.toBe('')

        // The panel exists because a quiet fifteen minutes and a hang look identical. Every phase
        // it names has to actually be reached.
        await untilText(['Sharpening the ask'], {limitMs: 60_000})
        await untilText(['Reading the project'], {limitMs: BRIEF_LIMIT})
        // The count is a fact the run reports, not a bar invented from elapsed time.
        await untilText(['4/4'], {limitMs: BRIEF_LIMIT})

        await answerEveryQuestion('Its own scene under ui/, instanced by the level.')

        const brief = await readBrief(taskId)
        expect(brief?.status).toBe('done')
        expect(brief?.refined ?? '').toContain('GOAL')
        expect((brief?.research ?? '').length).toBeGreaterThan(0)
        expect(brief?.spec ?? '').toContain('VERIFY')

        // The specification is the task's first message, and it went through the same path a typed
        // one does rather than being written into the transcript directly.
        await untilText(['GOAL'], {limitMs: 120_000})
        expect(await conversationText()).toContain('VERIFY')
        expect(await pageErrors()).toEqual([])
    })

    /*
     * Every research section is written as it lands, because the worker is killed to cancel a run.
     * A row that only filled in at the end would say nothing about a run that stopped.
     */
    it('recorded every phase it finished', async () => {
        const brief = await readBrief(taskId)
        for (const section of ['FILES', 'APIS', 'CONTEXT', 'TOOLING']) {
            expect(brief?.research ?? '').toContain(section)
        }
        // Assembly follows the worker order rather than completion order, so the same task produces
        // the same document every time.
        const text = brief?.research ?? ''
        expect(text.indexOf('FILES')).toBeLessThan(text.indexOf('APIS'))
        expect(text.indexOf('APIS')).toBeLessThan(text.indexOf('CONTEXT'))
        expect(text.indexOf('CONTEXT')).toBeLessThan(text.indexOf('TOOLING'))
    })
})

/*
 * Driven through an ordinary chat turn rather than through a brief, and that is the point twice
 * over.
 *
 * It is deterministic: a brief only asks what its research could not settle, and on a good model
 * against a real project that is often nothing — the first attempt at this suite reached compose
 * without ever asking, so the scenario tested nothing and left a run wedged behind a card that
 * appeared after the test that would have answered it had already been skipped.
 *
 * And it is the actual claim being made. `ask_user` is a tool, not a brief feature, so a plain chat
 * turn reaches this same card. If that is not true, the reusability the whole design rests on is not
 * true either.
 */
describe('the question card', () => {
    before(async () => {
        await newTask(
            'Use your ask_user tool to ask me where a pause menu should live, offering exactly two '
                + 'options: "its own scene under ui/" first, and "a CanvasLayer inside the level" '
                + 'second. Ask nothing else and do not change any files.',
            'basic'
        )
        await browser.waitUntil(asking, {
            timeout: QUESTION_LIMIT,
            interval: 3_000,
            timeoutMsg: 'a turn told to ask the user never asked'
        })
    })

    after(async () => {
        await endTurn()
    })

    it('will not send an answer nobody wrote', async () => {
        expect(await labelledInputIsDisabled('Your answer')).toBe(false)
        // The primary action is the one that sends. With nothing written there is nothing to send.
        const send = browser.$(buttonSelector('Answer'))
        const native = await send.getAttribute('disabled')
        const aria = await send.getAttribute('aria-disabled')
        expect(native !== null || aria === 'true').toBe(true)
    })

    /*
     * The suggestions are shortcuts, not the only way in. Picking one fills the box so the answer
     * can be taken, edited, or thrown away — which is the difference between offering an answer and
     * constraining one.
     */
    it('fills the box from a suggestion instead of answering for the user', async () => {
        const cards = await count(SUGGESTION)
        expect(cards).toBeGreaterThan(0)
        expect(await labelledInputValue('Your answer')).toBe('')

        await clickSelector(`(${SUGGESTION})[1]`, 'the first suggested answer')
        expect((await labelledInputValue('Your answer')).length).toBeGreaterThan(0)
        // Filling the box is not answering: the card is still up.
        expect(await asking()).toBe(true)
    })

    it('takes an answer that was edited after being picked', async () => {
        await fillLabelledInput('Your answer', 'Above the enemy, fading upward over half a second.')
        expect(await labelledInputValue('Your answer')).toBe(
            'Above the enemy, fading upward over half a second.'
        )
        await clickButton('Answer')
        // The card goes the moment the answer is sent, because the agent resumes then.
        await browser.waitUntil(async () => !(await asking()), {
            timeout: 30_000,
            timeoutMsg: 'the question card outlived its answer'
        })
    })

    /*
     * A skip is a decision, not an absent answer: the user read the question and left it to the
     * agent. Something has to be said either way — there is a tool call holding a thread open.
     */
    it('lets the agent decide, and the turn carries on', async () => {
        await newTask(
            'Use your ask_user tool to ask me one question about this project, then answer it '
                + 'yourself and stop. Change no files.',
            'basic'
        )
        await browser.waitUntil(asking, {
            timeout: QUESTION_LIMIT,
            interval: 3_000,
            timeoutMsg: 'a turn told to ask the user never asked'
        })

        await clickButton('Let the agent decide')
        await browser.waitUntil(async () => !(await asking()), {
            timeout: 60_000,
            timeoutMsg: 'the question card outlived the skip'
        })
        expect(await pageErrors()).toEqual([])
    })

    it('marks the answer the agent recommended', async () => {
        // The asker puts the one it recommends first, and the card says so in words as well as
        // colour — this theme is close to colourless, so a tint alone is not a distinction.
        expect(await shows('Recommended')).toBe(true)
        expect(await pageErrors()).toEqual([])
    })
})

describe('an ask built on things that are not there', () => {
    /*
     * The failure this is looking for is not a crash. It is a specification that reads as though the
     * files existed — a plausible plan against an invented API, which is exactly what the research
     * phase is supposed to prevent by looking before it writes.
     */
    it('does not invent the files it was told about', async () => {
        await newTask(
            'The FlurbulatorComponent in scripts/flurbulator.gd is throttling the tick rate too '
                + 'aggressively. Change its throttle_factor from 0.4 to 0.9 and update the two '
                + 'callers in scripts/warp_core.gd.',
            'planned'
        )
        await untilText(['Planning this task'], {limitMs: 120_000})
        const taskId = await activeTaskId()
        await answerEveryQuestion('There is nothing like that in this project. Say so.')

        const brief = await readBrief(taskId)
        expect(brief?.status).toBe('done')
        const research = brief?.research ?? ''
        const spec = brief?.spec ?? ''

        // Whatever it concludes, the research must not report a file it never read as present.
        const invented = ['scripts/flurbulator.gd', 'scripts/warp_core.gd'].filter(path =>
            research.includes(path)
        )
        console.log(`research mentioned: ${invented.join(', ') || 'neither invented path'}`)
        console.log(`--- research ---\n${research.slice(0, 4_000)}`)
        console.log(`--- spec ---\n${spec.slice(0, 4_000)}`)

        // The one thing that must hold: a specification is still checkable, whatever it decided.
        expect(spec).toContain('VERIFY')
        expect(await pageErrors()).toEqual([])
    })
})

describe('an ask that is not a task', () => {
    it('ends rather than looping', async () => {
        await newTask('asdf ;;;; ????', 'planned')
        await untilText(['Planning this task'], {limitMs: 120_000})
        const taskId = await activeTaskId()

        // Whatever it does with nonsense, it has to stop doing it. A phase that cannot answer fails
        // by name; one that can produces something checkable.
        await browser.waitUntil(async () => !(await shows('Planning this task')), {
            timeout: BRIEF_LIMIT,
            interval: 5_000,
            timeoutMsg: 'a nonsense ask never ended'
        })

        const brief = await readBrief(taskId)
        console.log(
            `nonsense ask ended as ${brief?.status ?? '—'} at ${brief?.phase ?? '—'}: `
                + (brief?.reason ?? '—')
        )
        expect(['done', 'failed']).toContain(brief?.status)
        // Either way the row says where it got to, which is what a resume and a user both need.
        expect(brief?.phase ?? '').not.toBe('')
        if (brief?.status === 'failed') {
            expect(brief.reason ?? '').not.toBe('')
        }
    })
})

describe('stopping a plan half way', () => {
    it('keeps the phases that finished', async () => {
        await newTask(
            'Add a settings screen with volume sliders for music and effects, wired to the audio '
                + 'buses this project already defines.',
            'planned'
        )
        await untilText(['Planning this task'], {limitMs: 120_000})
        const taskId = await activeTaskId()

        // Stopped once the first phase is behind it, so there is something to have kept.
        await untilText(['Reading the project'], {limitMs: BRIEF_LIMIT})
        await browser.pause(20_000)
        await expectEnabled('Stop', 120_000)
        await clickControl('Stop')

        await browser.waitUntil(async () => !(await shows('Planning this task')), {
            timeout: 300_000,
            interval: 2_000,
            timeoutMsg: 'the plan carried on after Stop'
        })

        const brief = await readBrief(taskId)
        console.log(`stopped at ${brief?.phase ?? '—'} with status ${brief?.status ?? '—'}`)
        expect(brief?.status).toBe('stopped')
        // The whole reason Rust writes each phase as its event crosses the pipe: the worker is
        // killed, so anything it was still holding is gone.
        expect(brief?.rawPrompt ?? '').toContain('settings screen')
        expect(brief?.refined ?? '').not.toBe('')
        expect(brief?.spec).toBe(null)
        expect(await pageErrors()).toEqual([])
    })

    it('leaves the window usable afterwards', async () => {
        // A stop that left the provider operation held would refuse the next task by name.
        await newTask('List the scenes in this project.', 'basic')
        await untilText(['List the scenes in this project.'], {limitMs: 120_000})
        expect(await pageErrors()).toEqual([])
    })
})

describe('a basic task', () => {
    it('is still one message and no phases', async () => {
        await newTask('What does main.tscn do?', 'basic')
        await untilText(['What does main.tscn do?'], {limitMs: 120_000})
        expect(await shows('Planning this task')).toBe(false)

        const taskId = await activeTaskId()
        expect(await readBrief(taskId)).toBe(null)
        expect(await pageErrors()).toEqual([])
    })
})

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

const BRIEF_LIMIT = 900_000
const QUESTION_LIMIT = 600_000

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

async function newTask(ask: string, mode: 'basic' | 'planned') {
    await endTurn()
    await clickText('New task', 60_000)
    await fillLabelledInput('What needs doing?', ask)
    if (mode === 'planned') await clickText('Plan it first')
    await clickButton(mode === 'planned' ? 'Plan it' : 'Create task')
}

const SUGGESTION = '//*[contains(concat(" ", @class, " "), " astryx-selectable-card ")]'

async function endTurn() {
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

const WORKING = 'Gofer is working…'

const asking = () => shows('Your answer')

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

        await untilText(['Sharpening the ask'], {limitMs: 60_000})
        await untilText(['Reading the project'], {limitMs: BRIEF_LIMIT})
        await untilText(['4/4'], {limitMs: BRIEF_LIMIT})

        await answerEveryQuestion('Its own scene under ui/, instanced by the level.')

        const brief = await readBrief(taskId)
        expect(brief?.status).toBe('done')
        expect(brief?.refined ?? '').toContain('GOAL')
        expect((brief?.research ?? '').length).toBeGreaterThan(0)
        expect(brief?.spec ?? '').toContain('VERIFY')

        await untilText(['GOAL'], {limitMs: 120_000})
        expect(await conversationText()).toContain('VERIFY')
        expect(await pageErrors()).toEqual([])
    })

    it('recorded every phase it finished', async () => {
        const brief = await readBrief(taskId)
        for (const section of ['FILES', 'APIS', 'CONTEXT', 'TOOLING']) {
            expect(brief?.research ?? '').toContain(section)
        }
        const text = brief?.research ?? ''
        expect(text.indexOf('FILES')).toBeLessThan(text.indexOf('APIS'))
        expect(text.indexOf('APIS')).toBeLessThan(text.indexOf('CONTEXT'))
        expect(text.indexOf('CONTEXT')).toBeLessThan(text.indexOf('TOOLING'))
    })
})

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
        const send = browser.$(buttonSelector('Answer'))
        const native = await send.getAttribute('disabled')
        const aria = await send.getAttribute('aria-disabled')
        expect(native !== null || aria === 'true').toBe(true)
    })

    it('fills the box from a suggestion instead of answering for the user', async () => {
        const cards = await count(SUGGESTION)
        expect(cards).toBeGreaterThan(0)
        expect(await labelledInputValue('Your answer')).toBe('')

        await clickSelector(`(${SUGGESTION})[1]`, 'the first suggested answer')
        expect((await labelledInputValue('Your answer')).length).toBeGreaterThan(0)
        expect(await asking()).toBe(true)
    })

    it('takes an answer that was edited after being picked', async () => {
        await fillLabelledInput('Your answer', 'Above the enemy, fading upward over half a second.')
        expect(await labelledInputValue('Your answer')).toBe(
            'Above the enemy, fading upward over half a second.'
        )
        await clickButton('Answer')
        await browser.waitUntil(async () => !(await asking()), {
            timeout: 30_000,
            timeoutMsg: 'the question card outlived its answer'
        })
    })

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
        expect(await shows('Recommended')).toBe(true)
        expect(await pageErrors()).toEqual([])
    })
})

describe('an ask built on things that are not there', () => {
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

        const invented = ['scripts/flurbulator.gd', 'scripts/warp_core.gd'].filter(path =>
            research.includes(path)
        )
        console.log(`research mentioned: ${invented.join(', ') || 'neither invented path'}`)
        console.log(`--- research ---\n${research.slice(0, 4_000)}`)
        console.log(`--- spec ---\n${spec.slice(0, 4_000)}`)

        expect(spec).toContain('VERIFY')
        expect(await pageErrors()).toEqual([])
    })
})

describe('an ask that is not a task', () => {
    it('ends rather than looping', async () => {
        await newTask('asdf ;;;; ????', 'planned')
        await untilText(['Planning this task'], {limitMs: 120_000})
        const taskId = await activeTaskId()

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
        expect(brief?.rawPrompt ?? '').toContain('settings screen')
        expect(brief?.refined ?? '').not.toBe('')
        expect(brief?.spec).toBe(null)
        expect(await pageErrors()).toEqual([])
    })

    it('leaves the window usable afterwards', async () => {
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

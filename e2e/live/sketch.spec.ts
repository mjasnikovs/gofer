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

const workspace = process.env.GOFER_WORKSPACE_DIR ?? ''
const shots = join(process.env.GOFER_APP_DATA_DIR ?? '', 'shots')

const PROMPT =
    'Use your ask_user tool with a brief: I need a pause menu for this game, 1280x720. Show me two '
    + "layouts side by side and I'll pick one. Don't build anything yet."

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

type Box = Readonly<{width: number; height: number; top: number; left: number; right: number}>

type Boxes = Readonly<{
    window: Readonly<{width: number; height: number}>
    frames: readonly Box[]
    answer: Readonly<{bottom: number}> | null
}>

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

        for (const frame of boxes.frames) {
            expect(frame.left).toBeGreaterThanOrEqual(-1)
            expect(frame.right).toBeLessThanOrEqual(boxes.window.width + 1)
            expect(frame.height).toBeGreaterThan(40)
        }

        const [first, second] = boxes.frames
        if (first && second) {
            expect(Math.abs(first.top - second.top)).toBeLessThanOrEqual(1)
            expect(Math.abs(first.width - second.width)).toBeLessThanOrEqual(1)
            expect(Math.abs(first.height - second.height)).toBeLessThanOrEqual(1)
        }

        expect(boxes.answer).not.toBeNull()
        expect(boxes.answer?.bottom ?? Infinity).toBeLessThanOrEqual(boxes.window.height + 1)
    })

    it('opens one sketch on its own and answers the question', async () => {
        type Control = Readonly<{name: string; disabled: boolean}>
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
            expect(opened.frames).toHaveLength(1)
            expect(opened.frames[0]?.right ?? Infinity).toBeLessThanOrEqual(opened.window.width + 1)
            expect(await press('Close')).toBe(true)
        }

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

        const chosen = await waitFor('Choose ')
        expect(await press(chosen?.name ?? '')).toBe(true)

        const answer = await waitFor('Send changes')
        expect(answer?.disabled).toBe(false)
        expect(await press('Send changes')).toBe(true)

        await browser.waitUntil(async () => (await sketchCount()) === 0, {
            timeout: 30_000,
            interval: 500,
            timeoutMsg: 'the sketches stayed up after the question was answered'
        })
        await shoot('answered')
        if (!existsSync(shots)) throw new Error('no screenshots were written')
    })
})

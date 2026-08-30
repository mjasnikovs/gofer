import {browser} from '@wdio/tauri-service'
import {execFileSync} from 'node:child_process'
import {existsSync} from 'node:fs'
import {join} from 'node:path'
import {
    clickText,
    expectSelector,
    expectText,
    installActivityProbe,
    pageText,
    releaseModifiers,
    untilText
} from './harness'

const workspace = process.env.GOFER_WORKSPACE_DIR ?? ''

const PROMPT =
    process.env['GOFER_BLANK_PROMPT'] ?? 'Create a Mario World 1-1 level. Make it playable.'

const RUN_LIMIT_MS = 14_400_000

const projectDatabase = join(process.env.GOFER_APP_DATA_DIR ?? '', 'project.sqlite')

function git(...arguments_: string[]) {
    return execFileSync('git', ['-C', workspace, ...arguments_], {encoding: 'utf8'}).trim()
}

function taskBranches() {
    return git('branch', '--list', 'gofer/task-*')
        .split('\n')
        .map(entry => entry.replace('*', '').trim())
        .filter(Boolean)
}

function databaseRows(sql: string): readonly string[] {
    if (!existsSync(projectDatabase)) return []
    return execFileSync('sqlite3', ['-cmd', '.timeout 10000', projectDatabase, sql], {
        encoding: 'utf8'
    })
        .split('\n')
        .filter(Boolean)
}

type StoredTurn = Readonly<{
    status?: string
    text?: string
    tools?: readonly Readonly<{name: string; status: string}>[]
}>

async function untilTurnSettled(mark: number): Promise<StoredTurn> {
    const deadline = Date.now() + RUN_LIMIT_MS
    let calls = 0
    for (;;) {
        const turns = databaseRows(
            `select payload_json from messages where sender = 'assistant' `
                + `and timestamp >= ${String(mark)} order by sequence`
        ).map(row => JSON.parse(row) as StoredTurn)
        const settled = turns.find(turn => turn.status !== undefined && turn.status !== 'streaming')
        if (settled) return settled
        const made = turns.flatMap(turn => turn.tools ?? []).length
        if (made !== calls) {
            calls = made
            console.log(`${new Date().toISOString()} ${String(made)} tool calls so far`)
        }
        if (Date.now() >= deadline)
            throw new Error(
                `the turn never finished; the window shows: ${(await pageText()).slice(-400)}`
            )
        await browser.pause(2_000)
    }
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
            await browser.waitUntil(
                async () => !(await composer.getText()).includes(prompt.slice(0, 20)),
                {
                    timeout: 30_000,
                    interval: 200,
                    timeoutMsg: `the composer kept the message; the window shows: ${await pageText()}`
                }
            )
            return
        }
    }
    throw new Error(
        `the composer would not take the message; it holds ${JSON.stringify(await composer.getText())}`
    )
}

describe('one prompt against a blank project', () => {
    before(async () => {
        await installActivityProbe()
    })

    it('boots with the real retrieval models and the configured endpoint', async () => {
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
        expect(taskBranches()).toContain(git('branch', '--show-current'))
    })

    it('sends the prompt once and lets the model work to the end of its turn', async () => {
        const mark = Date.now()
        await sendChat(PROMPT)
        const turn = await untilTurnSettled(mark)
        console.log(`the turn settled as ${String(turn.status)}`)
        console.log(`it made ${String((turn.tools ?? []).length)} tool calls`)
        const shown = await untilText(['Ask anything'], {limitMs: 120_000})
        if (!shown.ok) console.log('the composer never came free after the turn')
    })
})

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

/**
 * One prompt, one blank project, and no help.
 *
 * This is not an acceptance test and it asserts almost nothing. It exists to put the shipped
 * application in front of a real model with a real Godot and an empty repository, so that what the
 * model spends its turns on can be read back afterwards. Every assertion here is about the harness
 * reaching the point where the model can work — a failure below means the run never started, not
 * that the level is wrong.
 *
 * The level is never judged here. Whether the run was any good is decided by reading the tool calls
 * the run recorded, which is a question no `expect` can ask.
 */
const workspace = process.env.GOFER_WORKSPACE_DIR ?? ''

/**
 * The prompt.
 *
 * Identical between runs of the same scenario, or two runs are not comparable. `GOFER_BLANK_PROMPT`
 * names a different game to build: the defects this run is looking for are Gofer's, and a platform
 * level exercises a different part of the tool surface than a top-down shooter or a puzzle grid
 * does. The default stays the Mario level so an unparameterised run is still the baseline one.
 */
const PROMPT =
    process.env['GOFER_BLANK_PROMPT'] ?? 'Create a Mario World 1-1 level. Make it playable.'

/**
 * How long the model may work before the run is called off.
 *
 * A blank project is the largest task in this repository — there is no scene, no tileset and no
 * script to start from — and the turn ends itself the moment the model stops calling tools. This is
 * only the bound on a turn that never stops.
 *
 * Four hours because 55 minutes was wrong. The first run hit that limit at 296 tool calls while the
 * model was playtesting its own level: running the game, sending inputs, inspecting the nodes it
 * moved and capturing frames of the result. That is the work, and a harness that ends it is a
 * harness reporting on itself.
 */
const RUN_LIMIT_MS = 14_400_000

/** The project database the application is writing, which lives in the data directory it was given. */
const projectDatabase = join(process.env.GOFER_APP_DATA_DIR ?? '', 'project.sqlite')

function git(...arguments_: string[]) {
    return execFileSync('git', ['-C', workspace, ...arguments_], {encoding: 'utf8'}).trim()
}

/** The branches Gofer created for its tasks. */
function taskBranches() {
    return git('branch', '--list', 'gofer/task-*')
        .split('\n')
        .map(entry => entry.replace('*', '').trim())
        .filter(Boolean)
}

/**
 * One question put to the rows on disk, answered by SQLite rather than by the application.
 *
 * The application is writing the same file while this reads it — the chat is saved on a debounce —
 * so the reader waits its turn rather than answering "database is locked" as a run failure.
 */
function databaseRows(sql: string): readonly string[] {
    if (!existsSync(projectDatabase)) return []
    return execFileSync('sqlite3', ['-cmd', '.timeout 10000', projectDatabase, sql], {
        encoding: 'utf8'
    })
        .split('\n')
        .filter(Boolean)
}

/** One stored assistant turn, as the row holds it. */
type StoredTurn = Readonly<{
    status?: string
    text?: string
    tools?: readonly Readonly<{name: string; status: string}>[]
}>

/**
 * Blocks until the turn asked for after a moment has finished, and answers with the row.
 *
 * Not "until the composer is free": the composer says `Ask anything` for the beat between the
 * message being sent and the turn declaring itself, so a wait on the placeholder can come back
 * before the turn has started — and walking away then would take the turn with it.
 */
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
        // The reporter buffers until the file ends, so this is the only live sign of progress.
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

/**
 * Sends one chat message.
 *
 * The composer is typed into rather than assigned to, and what it holds is read back before Enter:
 * a composer that silently took nothing would otherwise send an empty message and leave the wait
 * above blaming the model for a keystroke that never landed.
 */
async function sendChat(prompt: string) {
    await releaseModifiers()
    await expectText(['Ask anything'], {allow: ['could not be read'], limitMs: 120_000})
    // A combobox rather than a textbox: the composer takes an `@` trigger, and ARIA calls an input
    // with a popup attached to it a combobox whether or not the popup is open.
    const composer = browser.$('[role="combobox"]')
    await composer.waitForDisplayed({timeout: 15_000})
    for (let attempt = 0; attempt < 3; attempt++) {
        await composer.click()
        await composer.setValue(prompt)
        if ((await composer.getText()).includes(prompt.slice(0, 20))) {
            await browser.keys('Enter')
            // A sent message empties the composer; a refused one leaves the text sitting there.
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
        // The branch is a fact in Git rather than a rendering, so Git is what is asked.
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
        // What the run produced is read from the database afterwards. All this records is that the
        // turn ended on its own terms rather than being cut off by the harness.
        console.log(`the turn settled as ${String(turn.status)}`)
        console.log(`it made ${String((turn.tools ?? []).length)} tool calls`)
        // A run is worth reading whatever it settled as, so nothing here fails the file. A turn
        // that stopped at an error is a finding, not a broken harness.
        const shown = await untilText(['Ask anything'], {limitMs: 120_000})
        if (!shown.ok) console.log('the composer never came free after the turn')
    })
})

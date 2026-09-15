import {expect} from '@wdio/globals'
import {browser} from '@wdio/tauri-service'
import {execFileSync} from 'node:child_process'
import {
    clickTab,
    clickText,
    expectSelector,
    expectText,
    installActivityProbe,
    invokeCommand
} from './harness'
import {seedLiveWorkspace} from './workspace-fixture'

// Only what the assertions read; the renderer's own type would pull src into the node project.
type Card = Readonly<{title: string; status: string; taskId: string | null}>

const workspace = process.env.GOFER_WORKSPACE_DIR ?? seedLiveWorkspace()

// Two turns, two merges, and an editor start inside each, on a local model.
const AUTO_LIMIT_MS = 1_800_000

const ASKS = [
    {
        title: 'Name the level scene',
        body: 'Add a one-line comment at the top of scripts/main.gd saying which scene it drives.'
    },
    {
        title: 'Slow the tick',
        body: 'In scripts/main.gd, double the tick interval constant and say what it was before.'
    }
] as const

function git(...arguments_: string[]) {
    return execFileSync('git', ['-C', workspace, ...arguments_], {encoding: 'utf8'}).trim()
}

function board() {
    return invokeCommand<readonly Card[]>('board_list')
}

async function autoStatus() {
    return browser.execute(() => {
        const line = [...document.querySelectorAll('p, span')].find(node =>
            /^Auto( stopped)?:/u.test(node.textContent)
        )
        return line?.textContent ?? ''
    })
}

describe('auto mode on the board', () => {
    let seedCommit = ''

    before(async () => {
        await installActivityProbe()
        await expectText(['Where should we start?'], {limitMs: 180_000})
        await expectSelector('[aria-label="Local AI connected"]', 30_000)
        seedCommit = git('rev-parse', 'HEAD')
        for (const ask of ASKS) {
            await invokeCommand('card_create', {...ask, status: 'ready', attachments: []})
        }
    })

    it('shows both cards in Ready with no task', async () => {
        const cards = await board()
        const ready = cards.filter(card => card.status === 'ready')
        expect(ready.map(card => card.title)).toEqual(ASKS.map(ask => ask.title))
        expect(ready.every(card => card.taskId === null)).toBe(true)
    })

    it('runs and merges every Ready card, top first, and stops when Ready is empty', async () => {
        await clickTab('Board')
        // The switch is a bare input; its label is a real <label for>, so its text toggles it.
        await clickText('Auto')
        await expectText(['Auto:'], {limitMs: 30_000})

        await browser.waitUntil(
            async () => (await board()).filter(card => card.status === 'done').length === 2,
            {
                timeout: AUTO_LIMIT_MS,
                interval: 2_000,
                timeoutMsg: `both cards never reached Done; the board says: ${await autoStatus()}`
            }
        )
        await browser.waitUntil(async () => (await autoStatus()).startsWith('Auto stopped'), {
            timeout: 60_000,
            interval: 500,
            timeoutMsg: `auto mode never stopped; it says: ${await autoStatus()}`
        })

        expect(await autoStatus()).toBe('Auto stopped: nothing left in Ready')
        const done = (await board()).filter(card => card.status === 'done')
        expect(done.map(card => card.title)).toEqual(ASKS.map(ask => ask.title))
        expect(done.every(card => card.taskId !== null)).toBe(true)
    })

    it('landed two merges on the project branch', () => {
        const merges = git('log', '--merges', '--format=%s', `${seedCommit}..master`)
            .split('\n')
            .filter(Boolean)
        expect(merges).toHaveLength(2)
    })

    it('kept Gofer’s scaffolding out of the merged project', () => {
        expect(git('ls-tree', '--name-only', '-r', 'master')).not.toContain('addons/gofer')
    })
})

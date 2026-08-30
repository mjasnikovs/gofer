import {expect} from '@wdio/globals'
import {browser} from '@wdio/tauri-service'
import {execFileSync} from 'node:child_process'
import {existsSync, readFileSync, readdirSync, renameSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {
    attachImage,
    buttonSelector,
    clickButton,
    clickControl,
    clickMenuItem,
    clickSelector,
    clickTab,
    clickText,
    conversationText,
    count,
    dialogText,
    expectElement,
    expectEnabled,
    expectGone,
    expectSelector,
    expectSessionState,
    expectText,
    fillInput,
    fillLabelledInput,
    forgetSessionStates,
    handleSize,
    installActivityProbe,
    invokeCommand,
    isNarrowLayout,
    KEYS,
    labelledInputIsDisabled,
    labelledInputValue,
    nudgeHandle,
    pageErrors,
    pageText,
    placeCaretAtLineStart,
    placeCaretAtStart,
    pressGlyphMargin,
    regionText,
    releaseModifiers,
    renderedLines,
    revealLine,
    sessionStates,
    shows,
    typeInEditor,
    untilText
} from './harness'
import {seedLiveWorkspace} from './workspace-fixture'

const workspace = process.env.GOFER_WORKSPACE_DIR ?? seedLiveWorkspace()
const BREAK_LINE = 19
const EXPORT_LINE = 5
const RENAMED_SYMBOL = 'tick_interval_renamed'
const BROKEN_EDIT = '~\n'
const UNREACHABLE_URL = 'http://127.0.0.1:9/v1'
const LEVEL_SCENE = 'scenes/level_1.tscn'
const LEVEL_SCENE_RESOURCE = `res://${LEVEL_SCENE}`
const ATLAS = 'res://assets/tiles.png'
const TILESET = 'res://tiles/world.tres'
const LEVEL_ROOT = 'Level1'
const TERRAIN = `/${LEVEL_ROOT}/Terrain`
const ATLAS_LEGEND =
    '(0,0) ground, (1,0) brick, (2,0) question block, (3,0) spent block, (4,0) and (5,0) the '
    + 'left and right halves of a pipe’s mouth, (6,0) and (7,0) the left and right halves of its '
    + 'shaft, (0,1) flag pole, (1,1) the ball on top of it, (2,1) the flag, (3,1) castle brick, '
    + '(4,1) and (5,1) the halves of a bush, (6,1) and (7,1) the halves of a cloud'
const AGENT_LIMIT_MS = 900_000
const DOCS_TOOL = 'godot_docs_search'
const COMPACTION_WINDOW = 48_000
const CONFIGURED_WINDOW = '120064'
const REFUSAL = [
    'could not be started',
    'contains no project.godot',
    'is not a Godot project'
] as const

let bound = ''
let baseUrl = ''
let capturedFrame = ''
let beforeTheRun = 0
const seedCommit = execFileSync('git', ['-C', workspace, 'rev-parse', 'HEAD'], {
    encoding: 'utf8'
}).trim()
const seedScript = readFileSync(join(workspace, 'scripts/main.gd'), 'utf8')

function git(...arguments_: string[]) {
    return execFileSync('git', ['-C', workspace, ...arguments_], {encoding: 'utf8'}).trim()
}

function currentBranch() {
    return git('branch', '--show-current')
}

function taskBranches() {
    return git('branch', '--list', 'gofer/task-*')
        .split('\n')
        .map(entry => entry.replace('*', '').trim())
        .filter(Boolean)
}

async function sessionWorktree() {
    const session = await invokeCommand<{worktree?: string} | null>('get_godot_session')
    const worktree = session?.worktree
    if (!worktree) throw new Error('no Godot session is running, so no worktree is bound')
    return worktree
}

const projectDatabase = join(process.env.GOFER_APP_DATA_DIR ?? '', 'project.sqlite')

function databaseRows(sql: string): readonly string[] {
    return execFileSync('sqlite3', ['-cmd', '.timeout 10000', projectDatabase, sql], {
        encoding: 'utf8'
    })
        .split('\n')
        .filter(Boolean)
}

type StoredToolCall = Readonly<{
    name: string
    target?: string
    status: string
    output?: string
}>

function toolCallsSince(mark: number): readonly StoredToolCall[] {
    return databaseRows(
        `select payload_json from messages where sender = 'assistant' `
            + `and timestamp >= ${String(mark)}`
    ).flatMap(row => (JSON.parse(row) as {tools?: readonly StoredToolCall[]}).tools ?? [])
}

type StoredTurn = Readonly<{
    status?: string
    text?: string
    tools?: readonly StoredToolCall[]
}>

async function untilTurnSettled(mark: number, limitMs = AGENT_LIMIT_MS): Promise<StoredTurn> {
    const deadline = Date.now() + limitMs
    for (;;) {
        const settled = databaseRows(
            `select payload_json from messages where sender = 'assistant' `
                + `and timestamp >= ${String(mark)} order by sequence`
        )
            .map(row => JSON.parse(row) as StoredTurn)
            .find(turn => turn.status !== undefined && turn.status !== 'streaming')
        if (settled) return settled
        if (Date.now() >= deadline)
            throw new Error(
                `the turn never finished; the window shows: ${(await pageText()).slice(-400)}`
            )
        await browser.pause(1_000)
    }
}

async function toolCallsFor(name: string, mark: number, limitMs = 30_000) {
    const deadline = Date.now() + limitMs
    for (;;) {
        const calls = toolCallsSince(mark).filter(call => call.name === name)
        if (calls.length > 0 || Date.now() >= deadline) return calls
        await browser.pause(500)
    }
}

async function currentTaskId() {
    const route = await currentRoute()
    const id = /#\/tasks\/([^/?]+)/u.exec(route)?.[1]
    if (!id) throw new Error(`the route names no task: ${route}`)
    return id
}

type AgentMessage = Readonly<{role?: string; summary?: string; tokensBefore?: number}>

function agentMessages(taskId: string): readonly AgentMessage[] {
    const [row] = databaseRows(
        `select agent_messages_json from tasks where id = '${taskId.replace(/'/gu, "''")}'`
    )
    return JSON.parse(row ?? '[]') as readonly AgentMessage[]
}

function lastContextTokens(taskId: string): number {
    const rows = databaseRows(
        `select payload_json from messages where sender = 'assistant' `
            + `and task_id = '${taskId.replace(/'/gu, "''")}' order by sequence`
    )
    for (const row of [...rows].reverse()) {
        const used = (JSON.parse(row) as {usage?: {totalTokens?: number}}).usage?.totalTokens
        if (typeof used === 'number' && used > 0) return used
    }
    return 0
}

function externalResources(scene: string) {
    const resources = new Map<string, string>()
    for (const [line] of scene.matchAll(/^\[ext_resource [^\]]*\]/gmu)) {
        const path = /path="([^"]+)"/u.exec(line)?.[1]
        const id = /(?:^|\s)id="([^"]+)"/u.exec(line)?.[1]
        if (path !== undefined && id !== undefined) resources.set(id, path)
    }
    return resources
}

function sceneFiles() {
    const directory = join(bound, 'scenes')
    if (!existsSync(directory)) return []
    return readdirSync(directory)
        .filter(name => name.endsWith('.tscn'))
        .map(name => join(directory, name))
}

function sceneNodes(scene: string) {
    return scene
        .split(/^\[node /mu)
        .slice(1)
        .map(block => {
            const end = block.indexOf(']')
            return {header: block.slice(0, end), body: block.slice(end + 1)}
        })
}

function nodesCarrying(scene: string, script: string) {
    const resources = externalResources(scene)
    return sceneNodes(scene)
        .filter(node => {
            const id = /^\s*script = ExtResource\("([^"]+)"\)/mu.exec(node.body)?.[1]
            return id !== undefined && resources.get(id) === script
        })
        .map(node => /name="([^"]+)"/u.exec(node.header)?.[1] ?? '(unnamed)')
}

function nodesInstancing(scene: string, instanced: string) {
    const resources = externalResources(scene)
    return sceneNodes(scene)
        .filter(node => {
            const id = /instance=ExtResource\("([^"]+)"\)/u.exec(node.header)?.[1]
            return id !== undefined && resources.get(id) === instanced
        })
        .map(node => /name="([^"]+)"/u.exec(node.header)?.[1] ?? '(unnamed)')
}

type ScriptDiagnosticsAnswer = Readonly<{
    op: 'diagnostics'
    path: string
    published: boolean
    diagnostics: readonly Readonly<{message: string; severity?: number | undefined}>[]
}>

type TaggedValue = Readonly<{type: string; value: unknown}>

type RuntimeInspection = Readonly<{
    path: string
    name: string
    type: string
    properties?: Readonly<Record<string, TaggedValue>> | undefined
}>

type RuntimeTreeNode = Readonly<{
    name: string
    type: string
    path: string
    children?: readonly RuntimeTreeNode[] | undefined
}>

type RuntimeTree = Readonly<{root: RuntimeTreeNode | null; truncated?: boolean | undefined}>

type InputActionEvent = Readonly<{kind: string; key?: string | undefined}>

type InputAction = Readonly<{
    name: string
    builtIn: boolean
    events: readonly InputActionEvent[]
}>

type InputActions = Readonly<{actions: readonly InputAction[]}>

type InspectedNode = Readonly<{
    name: string
    type: string
    path: string
    groups: readonly string[]
    signals: readonly string[]
    connections: readonly Readonly<{signal: string; method: string; target?: string | undefined}>[]
}>

type GodotLogPage = Readonly<{
    entries: readonly Readonly<{sequence: number; severity: string; message: string}>[]
    cursor: number
    dropped: number
}>

type PaintedCells = Readonly<{
    node: string
    cells: number
    usedRect: readonly number[]
    tileSet: string
    tiles: readonly Readonly<{atlas: readonly number[]; count: number}>[]
}>

type DescribedTileset = Readonly<{
    tileSize: readonly number[]
    sources: readonly Readonly<{
        texture?: string | undefined
        regionSize?: readonly number[] | undefined
        tiles: readonly Readonly<{atlas: readonly number[]; solid: boolean}>[]
    }>[]
}>

let nextRequestId = 0

async function godotCall<Answer>(command: string, params: Readonly<Record<string, unknown>>) {
    nextRequestId += 1
    const response = await invokeCommand<{result: Answer}>('call_godot', {
        request: {
            id: `sweep-${String(nextRequestId)}`,
            command,
            params,
            timeoutMs: 60_000
        }
    })
    return response.result
}

async function runningNodePath(name: string) {
    const tree = await godotCall<RuntimeTree>('runtime.get_tree', {})
    const search = (node: RuntimeTreeNode | null | undefined): string => {
        if (!node) return ''
        if (node.name === name) return node.path
        for (const child of node.children ?? []) {
            const found = search(child)
            if (found !== '') return found
        }
        return ''
    }
    const path = search(tree.root)
    if (path === '') throw new Error(`the running game has no node named ${name}`)
    return path
}

function nodesMatching(
    node: RuntimeTreeNode | null | undefined,
    wanted: (candidate: RuntimeTreeNode) => boolean
): readonly RuntimeTreeNode[] {
    if (!node) return []
    return [
        ...(wanted(node) ? [node] : []),
        ...(node.children ?? []).flatMap(child => nodesMatching(child, wanted))
    ]
}

async function editedNodes(wanted: (candidate: RuntimeTreeNode) => boolean) {
    const tree = await godotCall<RuntimeTree>('scene.get_tree', {})
    return nodesMatching(tree.root, wanted)
}

async function boundKey(action: string) {
    const {actions} = await godotCall<InputActions>('project.list_input_actions', {})
    const found = actions.find(entry => entry.name === action)
    const key = found?.events.find(event => event.kind === 'key')?.key
    if (!key) throw new Error(`${action} is bound to no key: ${JSON.stringify(found)}`)
    return key
}

interface StoppedFrame {
    label: string
    path: string
}

async function stoppedFrameScript(): Promise<StoppedFrame> {
    const label = await browser.execute(() => {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const text = (node.textContent ?? '').trim()
            if (/^[\w./-]+\.gd:\d+$/u.test(text)) return text
        }
        return ''
    })
    if (label === '')
        throw new Error(
            `the debugger named no stopped frame; the window shows: ${await pageText()}`
        )
    return {label, path: label.slice(0, label.lastIndexOf(':'))}
}

async function expectInConversation(
    wanted: readonly string[],
    limitMs: number,
    forbidden: readonly string[] = []
) {
    const occurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1
    const asked = await conversationText()
    const deadline = Date.now() + limitMs
    let shown = ''
    for (;;) {
        shown = await conversationText()
        const isNew = (needle: string) => occurrences(shown, needle) > occurrences(asked, needle)
        const said = forbidden.find(isNew)
        if (said !== undefined)
            throw new Error(
                `the conversation answered ${JSON.stringify(said)}: ${shown.slice(-400)}`
            )
        if (wanted.every(isNew)) return
        if (Date.now() >= deadline) break
        await browser.pause(500)
    }
    throw new Error(
        `the answer never held ${JSON.stringify(wanted)}; the conversation ends: ${shown.slice(-600)}`
    )
}

async function explorerShows(wanted: readonly string[], limitMs = 30_000) {
    const deadline = Date.now() + limitMs
    for (;;) {
        const shown = await regionText('Explorer')
        if (wanted.every(needle => shown.includes(needle))) return true
        if (Date.now() >= deadline) return false
        await browser.pause(500)
    }
}

async function expectInExplorer(wanted: readonly string[], limitMs = 60_000) {
    const deadline = Date.now() + limitMs
    let shown = ''
    while (Date.now() < deadline) {
        shown = await regionText('Explorer')
        if (wanted.every(needle => shown.includes(needle))) return
        await browser.pause(250)
    }
    throw new Error(`the explorer never showed ${JSON.stringify(wanted)}; it reads: ${shown}`)
}

async function frameSize(limitMs = 60_000) {
    const deadline = Date.now() + limitMs
    for (;;) {
        const shown = await pageText()
        const named = /Game · (\d+)×(\d+)/u.exec(shown)
        if (named) return {width: Number(named[1]), height: Number(named[2])}
        if (Date.now() >= deadline)
            throw new Error(
                `the game panel never named a frame size; it shows: ${shown.slice(0, 600)}`
            )
        await browser.pause(500)
    }
}

async function shownFrame() {
    return browser.execute(() => {
        const image = document.querySelector<HTMLImageElement>(
            'img[alt*="viewport"], img[alt*="game"]'
        )
        const source = image?.src ?? ''
        const comma = source.indexOf(',')
        return comma === -1 ? '' : source.slice(comma + 1)
    })
}

async function tabText(value: string) {
    return browser.execute(
        (attribute: string) =>
            Array.from(document.querySelectorAll('[data-tab-value]')).find(
                tab => tab.getAttribute('data-tab-value') === attribute
            )?.textContent ?? '',
        value
    )
}

async function currentRoute() {
    return browser.execute(() => window.location.hash)
}

async function taskLinks(): Promise<readonly string[]> {
    return browser.execute(() =>
        Array.from(document.querySelectorAll('a[href^="#/tasks/"]')).map(
            link => link.getAttribute('href') ?? ''
        )
    )
}

async function openInspector() {
    if (await isNarrowLayout()) await clickButton('Inspector')
}

async function closeInspector() {
    if (await isNarrowLayout()) await browser.keys('Escape')
}

async function inspectorText() {
    return (await isNarrowLayout()) ? dialogText() : regionText('Inspector')
}

async function expectInInspector(wanted: readonly string[], limitMs = 60_000) {
    const deadline = Date.now() + limitMs
    let shown = ''
    for (;;) {
        shown = await inspectorText()
        if (wanted.every(needle => shown.includes(needle))) return
        if (Date.now() >= deadline) break
        await browser.pause(250)
    }
    throw new Error(`the inspector never showed ${JSON.stringify(wanted)}; it reads: ${shown}`)
}

async function askUntil(prompt: string, isDone: () => Promise<boolean>, missing: string) {
    await sendChat(prompt, AGENT_LIMIT_MS)
    for (let attempt = 0; attempt < 3; attempt++) {
        await untilComposerIsFree(AGENT_LIMIT_MS)
        if (await isDone()) return
        if (attempt === 2) break
        await sendChat(
            `That is not finished: ${missing} Carry on with your Godot tools until it is.`,
            AGENT_LIMIT_MS
        )
    }
    throw new Error(
        `the agent never delivered: ${missing}\nThe explorer reads: ${await regionText('Explorer')}`
    )
}

async function openLevelInEditor() {
    await clickTab('Files')
    await clickSelector(
        '//*[@aria-label="Explorer"]//*[normalize-space(text())="level_1.tscn"]',
        'the level in the file tree'
    )
    await clickTab('Scene')
    const deadline = Date.now() + 60_000
    for (;;) {
        const tree = await godotCall<RuntimeTree>('scene.get_tree', {}).catch(() => null)
        if (tree?.root?.name === LEVEL_ROOT) return
        if (Date.now() >= deadline)
            throw new Error(
                `the editor never opened ${LEVEL_SCENE_RESOURCE}; it is editing `
                    + (tree?.root?.name ?? '(nothing)')
            )
        await browser.pause(500)
    }
}

async function openSettings() {
    for (let attempt = 0; attempt < 5; attempt++) {
        await clickText('Settings')
        const opened = await untilText(['AI connection', 'Base URL'], {limitMs: 15_000})
        if (opened.ok) return
    }
    throw new Error(`the settings page never opened; the window shows: ${await pageText()}`)
}

async function placeCaretOn(line: number, column: number) {
    await placeCaretAtLineStart(line)
    for (let step = 1; step < column; step++) await browser.keys(KEYS.arrowRight)
}

async function pressBreakpointGutter() {
    await revealLine(BREAK_LINE)
    const refused = await pressGlyphMargin(BREAK_LINE)
    if (refused !== '')
        throw new Error(
            `the gutter of line ${String(BREAK_LINE)} could not be pressed: ${refused}; Monaco `
                + `shows lines ${JSON.stringify(await renderedLines())}`
        )
}

async function untilComposerIsFree(limitMs: number) {
    await expectText(['Ask anything'], {allow: ['could not be read'], limitMs})
}

async function sendChat(prompt: string, limitMs = 240_000) {
    await releaseModifiers()
    await untilComposerIsFree(limitMs)
    const composer = browser.$('[role="combobox"], [role="textbox"]')
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
                    timeoutMsg: `the composer kept the message instead of sending it; the window shows: ${await pageText()}`
                }
            )
            return
        }
    }
    throw new Error(
        `the composer would not take the message; it holds ${JSON.stringify(await composer.getText())}`
    )
}

describe('the live workspace', () => {
    before(async () => {
        await installActivityProbe()
    })

    describe('the shell', () => {
        it('boots past the preparation splash with the real retrieval models', async () => {
            await expectText(['Where should we start?'], {limitMs: 180_000})
        })

        it('reaches the configured AI endpoint', async () => {
            await expectSelector('[aria-label="Local AI connected"]', 30_000)
        })

        it('offers the session controls the workspace is built around', async () => {
            await expectText(['Start Godot', 'Run Game', 'Chat', 'Scripts', 'Game', 'Docs'])
        })

        it('creates a task backed by its own branch, checked out in the project', async () => {
            const before = taskBranches()
            await clickText('New task')
            await browser.waitUntil(() => taskBranches().length > before.length, {
                timeout: 30_000,
                interval: 100,
                timeoutMsg: 'the task never received a branch'
            })
            const created = taskBranches().filter(name => !before.includes(name))
            expect(created).toHaveLength(1)
            expect(currentBranch()).toBe(created[0])
            expect(existsSync(join(workspace, 'project.godot'))).toBe(true)
        })

        it('lists its tasks in the sidebar', async () => {
            await clickText('New task')
            await browser.waitUntil(() => taskBranches().length > 1, {
                timeout: 30_000,
                interval: 100,
                timeoutMsg: 'the second task never received a branch'
            })
            await browser.waitUntil(async () => (await count('a[href^="#/tasks/"]')) >= 2, {
                timeout: 30_000,
                interval: 200,
                timeoutMsg: `the sidebar never listed the tasks; it shows: ${await pageText()}`
            })
        })

        it('switches to the task the sidebar names', async () => {
            const before = await currentRoute()
            const others = (await taskLinks()).filter(href => !before.endsWith(href.slice(1)))
            expect(others.length).toBeGreaterThan(0)
            await clickSelector(`a[href="${String(others[0])}"]`, 'the other task in the sidebar')
            await browser.waitUntil(async () => (await currentRoute()) !== before, {
                timeout: 30_000,
                interval: 100,
                timeoutMsg: `the sidebar never switched the route away from ${before}`
            })
            await expectText(['Where should we start?'])
        })

        it('shows the header controls for the task it is displaying', async () => {
            await expectText(['Godot 4.7', 'Merge task'])
        })

        it('deletes a task from the sidebar with its branch', async () => {
            const route = await currentRoute()
            const links = await taskLinks()
            const doomed = links.findIndex(href => !route.endsWith(href.slice(1)))
            expect(doomed).toBeGreaterThanOrEqual(0)
            const branchesBefore = taskBranches()

            await clickSelector(
                `(//button[starts-with(@aria-label, "Delete task")])[${String(doomed + 1)}]`,
                'the delete button of the task in the sidebar'
            )
            await expectText(['Delete this task?', 'cannot be undone'])
            await clickButton('Delete task')

            await browser.waitUntil(
                async () => !(await taskLinks()).includes(String(links[doomed])),
                {
                    timeout: 30_000,
                    interval: 200,
                    timeoutMsg: `the sidebar kept the deleted task; it shows: ${await pageText()}`
                }
            )
            expect(taskBranches().length).toBe(branchesBefore.length - 1)
            expect(taskBranches()).toContain(currentBranch())
            expect(await currentRoute()).toBe(route)
            await expectText(['Merge task'])
        })
    })

    describe('settings', () => {
        it('opens the settings page on the configured connection', async () => {
            await openSettings()
            await expectText(['Model ID', 'API key'])
            baseUrl = await labelledInputValue('Base URL')
            expect(baseUrl).toMatch(/^https?:\/\//u)
        })

        it('fixes the connection type and the API dialect it cannot change', async () => {
            expect(await labelledInputIsDisabled('Connection type')).toBe(true)
            expect(await labelledInputIsDisabled('API dialect')).toBe(true)
        })

        it('tests the connection and lists the server’s models', async () => {
            await clickButton('Test connection')
            await expectText(['AI connection works', 'Select server model'], {limitMs: 60_000})
        })

        it('takes a model from the list the server answered with', async () => {
            await clickSelector(
                '//button[starts-with(normalize-space(.), "Select server model")]',
                'the server model menu'
            )
            await expectSelector('[role="menuitem"]')
            const [item] = await browser.$$('[role="menuitem"]').getElements()
            const offered = (await item?.getText()) ?? ''
            await clickSelector('[role="menuitem"]', 'the first server model')
            const chosen = await labelledInputValue('Model ID')
            expect(offered).toContain(chosen)
        })

        it('offers the thinking levels the configured model supports', async () => {
            await clickControl('Reasoning')
            await expectSelector('[role="option"]')
            await browser.keys('Escape')
        })

        it('edits every request field the connection is built from', async () => {
            await fillLabelledInput('Connection name', 'Local AI')
            await fillLabelledInput('Context window', '120064')
            await fillLabelledInput('Maximum output tokens', '120064')
            await fillLabelledInput('Request timeout', '600000')
            await fillLabelledInput('Automatic retries', '2')
            await fillLabelledInput('API key', 'not-a-real-key')
            expect(await labelledInputValue('API key')).toBe('not-a-real-key')
            await fillLabelledInput('API key', '')
            expect(await labelledInputValue('Request timeout')).toBe('600000')
        })

        it('saves the connection it was given', async () => {
            await clickButton('Save connection')
            await expectText(['Settings saved'], {limitMs: 60_000})
        })

        it('reports a server it cannot reach', async () => {
            await fillLabelledInput('Base URL', UNREACHABLE_URL)
            await clickButton('Test connection')
            await expectText(['AI server is unreachable'], {
                failures: ['AI connection works'],
                limitMs: 120_000
            })
        })

        it('saves the unreachable server it was told to use', async () => {
            await clickButton('Save connection')
            await expectText(['Settings saved'], {limitMs: 60_000})
            await browser.keys('Escape')
        })

        it('shows the connection as offline when the window is reopened without it', async () => {
            await browser.refresh()
            await installActivityProbe()
            await expectSelector('[aria-label="Local AI offline"]', 180_000)
            await expectText(['Reconnect'])
        })

        it('retries from the header and stays offline while the server is gone', async () => {
            await clickButton('Reconnect')
            await expectSelector('[aria-label="Local AI offline"]', 120_000)
            await expectText(['Reconnect'])
        })

        it('comes back once the endpoint the settings name is reachable again', async () => {
            await openSettings()
            await fillLabelledInput('Base URL', baseUrl)
            await clickButton('Save connection')
            await expectText(['Settings saved'], {limitMs: 60_000})
            await browser.keys('Escape')
            await expectSelector('[aria-label="Local AI connected"]', 120_000)
            await expectGone(['Reconnect'])
            await openSettings()
        })

        it('reports the retrieval cache it is actually using', async () => {
            await expectText(['Godot documentation models', 'Cache location', 'Disk usage'])
            expect(await shows('gofer-rag')).toBe(true)
        })

        it('asks before deleting the retrieval cache, and takes no for an answer', async () => {
            await clickButton('Delete model cache')
            await expectText(['Delete documentation model cache?', '1.68 GiB'])
            await clickButton('Cancel')
            await expectGone(['Delete documentation model cache?'])
        })

        it('backs the project up', async () => {
            await clickButton('Back up project')
            await expectText(['Project backup created'], {limitMs: 60_000})
        })

        it('runs storage maintenance', async () => {
            await clickButton('Clean storage')
            await expectText(['Storage maintenance complete'], {limitMs: 60_000})
        })

        it('returns to the workspace', async () => {
            await browser.keys('Escape')
            await browser.waitUntil(async () => !(await currentRoute()).includes('settings'), {
                timeout: 30_000,
                interval: 100,
                timeoutMsg: 'the settings page never closed'
            })
            await expectText(['Start Godot'])
        })
    })

    describe('the frame', () => {
        it('resizes the explorer column from its handle', async () => {
            const before = await handleSize('Resize the explorer')
            expect(Number.isNaN(before)).toBe(false)
            await nudgeHandle('Resize the explorer', KEYS.arrowRight, 4)
            await browser.waitUntil(
                async () => (await handleSize('Resize the explorer')) > before,
                {
                    timeout: 15_000,
                    interval: 100,
                    timeoutMsg: `the explorer stayed ${String(before)}px wide`
                }
            )
            await nudgeHandle('Resize the explorer', KEYS.arrowLeft, 4)
        })

        it('resizes the inspector column, where the layout has one', async () => {
            if (await isNarrowLayout()) return
            const before = await handleSize('Resize the inspector')
            expect(Number.isNaN(before)).toBe(false)
            await nudgeHandle('Resize the inspector', KEYS.arrowLeft, 4)
            await browser.waitUntil(
                async () => (await handleSize('Resize the inspector')) !== before,
                {
                    timeout: 15_000,
                    interval: 100,
                    timeoutMsg: `the inspector stayed ${String(before)}px wide`
                }
            )
            await nudgeHandle('Resize the inspector', KEYS.arrowRight, 4)
        })

        it('says every panel is waiting for a session it does not have', async () => {
            await clickTab('Scene')
            await expectText(['No editor running', 'Start Godot'])
            await clickTab('Runtime')
            await expectText(['No editor running'])
            await clickTab('Debugger')
            await expectText(['The game is not stopped'])
            await clickTab('Problems')
        })
    })

    describe('the editor session', () => {
        it('starts the managed Godot editor from the explorer’s own control', async () => {
            await forgetSessionStates()
            await clickTab('Scene')
            await clickButton('Start Godot')
            await expectSessionState('ready', 180_000)
            await expectText(['4.7.2', 'Stop Godot'])
            expect(await sessionStates()).toContain('importing')
            bound = await sessionWorktree()
        })

        it('stages the addon into the task worktree', async () => {
            expect(existsSync(join(bound, 'addons/gofer/plugin.gd'))).toBe(true)
        })

        it('names the scene the editor has open', async () => {
            await expectText(['res://scenes/main.tscn'])
        })

        it('shows the project scene tree', async () => {
            await clickTab('Scene')
            await expectText(['Main', 'Ticker', 'Timer', 'Player', 'Label'], {limitMs: 30_000})
        })

        it('refetches the scene tree on demand', async () => {
            await clickButton('Refresh')
            await expectText(['Main', 'Player'], {limitMs: 30_000})
        })

        it('inspects the identity of a selected node', async () => {
            await clickText('Player')
            await openInspector()
            await expectText(['Node2D', '/Main/Player', 'Groups', 'Edited'], {limitMs: 30_000})
        })

        it('searches the project settings', async () => {
            await clickTab('Project')
            await fillLabelledInput('Search project settings', 'main_scene')
            await expectText(['application/run/main_scene', 'res://scenes/main.tscn'], {
                limitMs: 30_000
            })
        })

        it('marks the settings that need a restart', async () => {
            await fillLabelledInput('Search project settings', 'rendering_method')
            await expectText(['rendering/renderer/rendering_method', 'Restart'], {limitMs: 30_000})
        })

        it('searches the editor’s own settings', async () => {
            await clickTab('Editor')
            await fillLabelledInput('Search editor settings', 'font_size')
            await expectText(['font_size'], {limitMs: 30_000})
        })

        it('returns to the node it was inspecting', async () => {
            await clickTab('Node')
            await expectText(['/Main/Player'], {limitMs: 30_000})
            await closeInspector()
        })

        it('reports no running game in the runtime tree', async () => {
            await clickTab('Runtime')
            await expectText(['The game is not running'], {limitMs: 30_000})
        })

        it('lists the worktree files and filters them', async () => {
            await clickTab('Files')
            await expectText(['main.gd', 'player.gd', 'main.tscn'], {limitMs: 30_000})
            await fillLabelledInput('Filter files', 'player')
            await expectText(['player.gd'], {absent: ['main.gd']})
            await fillLabelledInput('Filter files', '')
            await expectText(['main.gd', 'player.gd'])
        })

        it('opens a script in Monaco', async () => {
            await clickText('main.gd')
            await expectText(['TICK_MESSAGE', 'scripts/main.gd'], {limitMs: 30_000})
            await expectSelector('[data-testid="script-editor-host"] .monaco-editor')
        })

        it('opens a scene in the editor rather than in Monaco', async () => {
            await clickTab('Files')
            await clickSelector(
                '//*[@aria-label="Explorer"]//*[normalize-space(text())="main.tscn"]',
                'the scene in the file tree'
            )
            await expectText(['Edited scene', 'Main', 'Ticker'], {
                absent: ['gd_scene load_steps'],
                limitMs: 30_000
            })
        })
    })

    describe('the script editor', () => {
        it('opens a second buffer and switches between the tabs', async () => {
            await clickTab('Files')
            await clickText('player.gd')
            await expectText(['scripts/player.gd', 'travelled'], {limitMs: 30_000})
            await clickTab('main.gd')
            await expectText(['scripts/main.gd', 'TICK_MESSAGE'], {limitMs: 30_000})
        })

        it('marks the buffer dirty when it is edited', async () => {
            await placeCaretAtStart()
            await typeInEditor(BROKEN_EDIT)
            await expectText(['main.gd •'], {limitMs: 30_000})
        })

        it('saves the edit to the worktree', async () => {
            await clickButton('Save')
            await expectText(['scripts/main.gd'], {absent: ['main.gd •'], limitMs: 30_000})
            expect(readFileSync(join(bound, 'scripts/main.gd'), 'utf8')).toContain(BROKEN_EDIT)
        })

        it('surfaces the language server’s diagnostic for the broken script', async () => {
            await clickButton('Close')
            await clickTab('Files')
            await clickText('main.gd')
            await expectText(['TICK_MESSAGE'], {limitMs: 30_000})
            await clickTab('Problems')
            await expectText(['scripts/main.gd:'], {limitMs: 60_000})
            await browser.waitUntil(async () => /\d/u.test(await tabText('scripts/main.gd')), {
                timeout: 30_000,
                interval: 200,
                timeoutMsg: `the main.gd tab carried no diagnostic count; it reads ${JSON.stringify(await tabText('scripts/main.gd'))}`
            })
        })

        it('jumps from a problem to the line it names', async () => {
            await clickSelector(
                '//*[contains(normalize-space(.), "scripts/main.gd:")][not(.//*[contains('
                    + 'normalize-space(.), "scripts/main.gd:")])]',
                'the first problem'
            )
            await expectText(['scripts/main.gd', 'TICK_MESSAGE'], {limitMs: 30_000})
        })

        it('repairs the script and leaves the worktree as it found it', async () => {
            await clickTab('Scripts')
            await placeCaretAtStart()
            await browser.keys(KEYS.delete)
            await browser.keys(KEYS.delete)
            await expectText(['main.gd •'], {limitMs: 30_000})
            await clickButton('Save')
            await expectText(['scripts/main.gd'], {absent: ['main.gd •'], limitMs: 30_000})
            expect(readFileSync(join(bound, 'scripts/main.gd'), 'utf8')).not.toContain('~')
            await clickTab('Problems')
            await expectText(['No problems'], {limitMs: 60_000})
            await clickTab('Scripts')
        })

        it('throws an unsaved edit away when the buffer is reloaded', async () => {
            await placeCaretAtStart()
            await typeInEditor('# discarded by reload\n')
            await expectText(['main.gd •'], {limitMs: 30_000})
            await clickButton('Reload')
            await expectText(['TICK_MESSAGE'], {
                absent: ['main.gd •', '# discarded by reload'],
                limitMs: 30_000
            })
        })

        it('offers to rename the symbol under the caret', async () => {
            await placeCaretOn(EXPORT_LINE, 15)
            await browser.keys(KEYS.f2)
            await expectText(['Rename symbol', 'New name'], {limitMs: 30_000})
        })

        it('takes no for an answer about the rename', async () => {
            await clickButton('Cancel')
            await expectGone(['Rename symbol'], {limitMs: 30_000})
            expect(readFileSync(join(bound, 'scripts/main.gd'), 'utf8')).toContain('tick_interval')
        })

        it('renames a symbol everywhere the language server finds it', async () => {
            await placeCaretOn(EXPORT_LINE, 15)
            await browser.keys(KEYS.f2)
            await expectText(['Rename symbol'], {limitMs: 30_000})
            await fillLabelledInput('New name', RENAMED_SYMBOL)
            await clickButton('Preview rename')
            await expectText([`Rename to ${RENAMED_SYMBOL}`, 'file(s) would be rewritten'], {
                limitMs: 60_000
            })
            await clickButton('Apply rename')
            await expectGone([`Rename to ${RENAMED_SYMBOL}`], {limitMs: 30_000})
            await browser.waitUntil(
                () => readFileSync(join(bound, 'scripts/main.gd'), 'utf8').includes(RENAMED_SYMBOL),
                {
                    timeout: 30_000,
                    interval: 200,
                    timeoutMsg: `the rename was never written to the worktree; ${join(bound, 'scripts/main.gd')} holds ${readFileSync(join(bound, 'scripts/main.gd'), 'utf8').slice(0, 400)}`
                }
            )
            const written = readFileSync(join(bound, 'scripts/main.gd'), 'utf8')
            expect(written.match(new RegExp(RENAMED_SYMBOL, 'gu'))?.length ?? 0).toBeGreaterThan(1)
        })

        it('formats the open script through the bundled sidecar', async () => {
            await clickButton('Format')
            await expectText(['Formatted with gdformat'], {limitMs: 30_000})
            await clickButton('Cancel')
            await expectGone(['Formatted with gdformat'])
        })

        it('applies what the formatter would write to the buffer', async () => {
            await placeCaretAtLineStart(2)
            await typeInEditor('var    live_sweep     :=    1\n')
            await clickButton('Format')
            await expectText(['Formatted with gdformat', 'scripts/main.gd'], {limitMs: 30_000})
            await clickButton('Apply to buffer')
            await expectGone(['Formatted with gdformat'])
            await clickButton('Save')
            await expectText(['scripts/main.gd'], {absent: ['main.gd •'], limitMs: 30_000})
            expect(readFileSync(join(bound, 'scripts/main.gd'), 'utf8')).toContain(
                'var live_sweep := 1'
            )
        })

        it('refuses to overwrite a file that changed underneath the buffer', async () => {
            const path = join(bound, 'scripts/main.gd')
            const onDisk = readFileSync(path, 'utf8')
            await placeCaretAtStart()
            await typeInEditor('# edited in the buffer\n')
            await expectText(['main.gd •'], {limitMs: 30_000})
            writeFileSync(path, `# changed on disk\n${onDisk}`, 'utf8')
            await clickButton('Save')
            await expectText(['This buffer is out of date', 'Reload from disk', 'Overwrite'], {
                allow: ['could not be saved'],
                limitMs: 60_000
            })
        })

        it('takes the file the conflict pointed at', async () => {
            await clickButton('Reload from disk')
            await expectGone(['This buffer is out of date'], {limitMs: 30_000})
            await expectText(['# changed on disk'], {limitMs: 30_000})
        })

        it('overwrites the file when that is what was asked for', async () => {
            const path = join(bound, 'scripts/main.gd')
            await placeCaretAtStart()
            await typeInEditor('# the buffer wins\n')
            writeFileSync(path, `# changed again on disk\n${readFileSync(path, 'utf8')}`, 'utf8')
            await clickButton('Save')
            await expectText(['This buffer is out of date'], {
                allow: ['could not be saved'],
                limitMs: 60_000
            })
            await clickButton('Overwrite')
            await expectGone(['This buffer is out of date'], {limitMs: 30_000})
            const written = readFileSync(path, 'utf8')
            expect(written).toContain('# the buffer wins')
            expect(written).not.toContain('# changed again on disk')
        })

        it('puts the script back the way the sweep found it', async () => {
            writeFileSync(join(bound, 'scripts/main.gd'), seedScript, 'utf8')
            await clickButton('Reload')
            await expectText(['TICK_MESSAGE'], {absent: ['main.gd •'], limitMs: 30_000})
            await clickTab('Problems')
            await expectText(['No problems'], {limitMs: 60_000})
            await clickTab('Scripts')
        })

        it('toggles a breakpoint in the gutter', async () => {
            await pressBreakpointGutter()
            await browser.waitUntil(async () => (await count('.gofer-breakpoint')) > 0, {
                timeout: 15_000,
                interval: 100,
                timeoutMsg: `pressing the gutter beside line ${String(BREAK_LINE)} set no breakpoint`
            })
        })
    })

    describe('running the project', () => {
        it('runs the project under the debug adapter and stops at the breakpoint', async () => {
            await forgetSessionStates()
            await clickButton('Run Game')
            await expectSessionState('playing', 120_000)
            await expectText(['Stopped: breakpoint', '_on_tick'], {limitMs: 90_000})
        })

        it('reads the stopped frame’s scopes and variables', async () => {
            await expectText(['Locals', 'ticks'], {limitMs: 60_000})
        })

        it('steps over a line', async () => {
            await clickControl('Step over')
            await expectText(['Stopped: step'], {limitMs: 60_000})
        })

        it('steps into a line', async () => {
            await clickControl('Step in')
            await expectText(['Stopped: '], {limitMs: 60_000})
        })

        it('steps out of the frame it stepped into', async () => {
            await clickControl('Step out')
            await expectText(['Stopped: '], {limitMs: 60_000})
        })

        it('opens the script the stopped frame names', async () => {
            const named = await stoppedFrameScript()
            await clickText(named.label)
            await expectText([named.path], {limitMs: 30_000})
            await clickTab('Debugger')
        })

        it('continues to the next breakpoint', async () => {
            await clickControl('Continue')
            await expectText(['Stopped: breakpoint'], {limitMs: 90_000})
        })

        it('shows the running game’s own tree', async () => {
            await clickTab('Runtime')
            await expectText(['GoferRuntime', 'Main', 'Player'], {
                absent: ['The game is not running'],
                limitMs: 60_000
            })
            await clickTab('Scene')
        })

        it('clears the breakpoint from the gutter', async () => {
            await clickTab('Scripts')
            await clickTab('main.gd')
            await expectText(['scripts/main.gd'], {limitMs: 30_000})
            await pressBreakpointGutter()
            await browser.waitUntil(async () => (await count('.gofer-breakpoint')) === 0, {
                timeout: 15_000,
                interval: 100,
                timeoutMsg: 'pressing the gutter again left the breakpoint in place'
            })
        })

        it('resumes a game with nothing left to stop it', async () => {
            await clickTab('Debugger')
            await clickControl('Continue')
            await expectText(['Running'], {limitMs: 60_000})
        })

        it('reports the running game’s output in the session log', async () => {
            await clickTab('Output')
            await expectText(['Gofer live test scene ready', 'Live test reached five ticks'], {
                limitMs: 60_000
            })
        })

        it('pauses a running game', async () => {
            await clickTab('Debugger')
            await clickControl('Pause')
            await expectText(['Stopped: '], {limitMs: 60_000})
        })

        it('terminates the game', async () => {
            await clickControl('Terminate')
            await expectText(['Not running', 'Run Game'], {limitMs: 60_000})
        })

        it('launches again from the debugger’s own control', async () => {
            await forgetSessionStates()
            await clickButton('Launch')
            await expectSessionState('playing', 120_000)
            await expectText(['Stop Game'], {limitMs: 60_000})
        })

        it('stops the project from the session toolbar', async () => {
            await clickButton('Stop Game')
            await expectText(['Not running', 'Run Game'], {limitMs: 60_000})
        })
    })

    describe('the game surface', () => {
        it('runs the project from the editor’s own play control', async () => {
            await clickTab('Game')
            await expectText(['No frame captured'])
            await clickButton('Run')
            await expectSelector('img[alt*="running game"]', 120_000)
            const frame = await frameSize(30_000)
            expect(frame.width).toBeGreaterThan(0)
            expect(frame.height).toBeGreaterThan(0)
        })

        it('captures a frame of the running game on demand', async () => {
            await clickControl('Capture game')
            await expectGone(['The game frame could not be read'])
            expect((await frameSize()).height).toBeGreaterThan(0)
            await expectSelector('img[alt*="running game"]', 10_000)
        })

        it('restarts the game', async () => {
            await clickControl('Restart')
            await expectGone(['The game frame could not be read'], {limitMs: 120_000})
            expect((await frameSize(120_000)).height).toBeGreaterThan(0)
            await expectEnabled('Stop', 120_000)
        })

        it('stops the game', async () => {
            await clickControl('Stop')
            await expectText(['No frame captured'], {limitMs: 60_000})
        })

        it('captures the editor viewport with no game running', async () => {
            await clickControl('Capture editor')
            await expectSelector('img[alt*="editor viewport"]', 60_000)
            await expectText(['Editor · '], {limitMs: 30_000})
            capturedFrame = await shownFrame()
        })
    })

    describe('the bottom panel', () => {
        it('shows the editor’s own output', async () => {
            await clickTab('Output')
            await expectText(['Godot Engine v4.7.2'], {limitMs: 60_000})
        })

        it('filters the output down to errors and back', async () => {
            await clickControl('Errors')
            await expectGone(['Godot Engine v4.7.2'], {limitMs: 30_000})
            await clickControl('All')
            await expectText(['Godot Engine v4.7.2'], {limitMs: 30_000})
        })

        it('drops the informational lines when only warnings are wanted', async () => {
            await clickControl('Warnings')
            await expectGone(['Godot Engine v4.7.2'], {limitMs: 30_000})
            await clickControl('All')
            await expectText(['Godot Engine v4.7.2'], {limitMs: 30_000})
        })

        it('filters the output by text', async () => {
            await fillLabelledInput('Filter output', 'live tick')
            await expectText(['live tick'], {absent: ['Godot Engine v4.7.2'], limitMs: 30_000})
            await fillLabelledInput('Filter output', '')
        })

        it('searches the recorded output of every session', async () => {
            await clickControl('History')
            await fillLabelledInput('Search recorded output', 'Parse Error')
            await expectText(['Parse Error'], {limitMs: 60_000})
            await clickControl('This run')
        })

        it('reports and rescans the imported assets', async () => {
            await clickTab('Import')
            await expectText(['imported asset(s)'], {limitMs: 30_000})
            await clickButton('Rescan project')
            await expectText(['imported asset(s)'], {limitMs: 60_000})
        })

        it('collapses and restores itself', async () => {
            await clickControl('Hide panel')
            await expectText(['Problems', 'Import'], {absent: ['Rescan project'], limitMs: 30_000})
            await clickControl('Show panel')
            await expectText(['Rescan project'], {limitMs: 30_000})
        })
    })

    describe('the documentation', () => {
        it('answers a question from the local retrieval models', async () => {
            await clickTab('Docs')
            await fillInput(
                'input[placeholder="How do I move a CharacterBody2D?"]',
                'How do I move a CharacterBody2D?'
            )
            await clickButton('Search')
            await expectText(['CharacterBody2D', 'Section'], {limitMs: 180_000})
        })

        it('answers a second question over the models it already loaded', async () => {
            await fillInput(
                'input[placeholder="How do I move a CharacterBody2D?"]',
                'What does an AnimationPlayer node do?'
            )
            await clickButton('Search')
            await expectText(['AnimationPlayer'], {limitMs: 120_000})
        })
    })

    describe('the documentation tool', () => {
        before(async () => {
            await clickTab('Chat', 300_000)
            await untilComposerIsFree(300_000)
        })

        it('answers a documentation question with at least one docs-RAG call', async () => {
            const asked = Date.now()
            const question =
                'Use your godot_docs_search tool to look up what CharacterBody2D.move_and_slide '
                + 'does, and answer from the documentation you find.'
            let turn = asked
            await sendChat(question, AGENT_LIMIT_MS)
            for (let attempt = 0; attempt < 3; attempt++) {
                await untilTurnSettled(turn)
                const calls = await toolCallsFor(DOCS_TOOL, asked)
                if (calls.length > 0) {
                    const failed = calls.filter(call => call.status === 'error')
                    expect(failed.map(call => call.output ?? '')).toEqual([])
                    return
                }
                if (attempt === 2) break
                turn = Date.now()
                await sendChat(
                    `You have not searched the documentation yet. ${question}`,
                    AGENT_LIMIT_MS
                )
            }
            throw new Error(
                'the documentation question made 0 docs-RAG calls; the agent called '
                    + JSON.stringify(toolCallsSince(asked).map(call => call.name))
            )
        })
    })

    describe('the chat', () => {
        it('shows the model, the reasoning level, and the context usage', async () => {
            await clickTab('Chat')
            await expectText(['Model: ', 'Reasoning: ', 'tokens', 'Ask anything'])
        })

        it('opens the model picker on the models the server offers', async () => {
            await clickSelector(
                '//button[starts-with(normalize-space(.), "Model:")]',
                'the model menu'
            )
            await expectSelector('[role="menuitem"]')
            await browser.keys('Escape')
        })

        it('takes a reasoning level from the picker', async () => {
            await clickSelector(
                '//button[starts-with(normalize-space(.), "Reasoning:")]',
                'the reasoning menu'
            )
            await expectSelector('[role="menuitem"]')
            await clickMenuItem('off')
            await expectText(['Reasoning: off'], {limitMs: 30_000})
        })

        it('offers image attachment according to the model’s input support', async () => {
            await expectSelector('button[aria-label="Attach images"]')
        })

        it('answers with the configured model, using its Godot tools', async () => {
            const mark = Date.now()
            await sendChat('List every node in the main scene using your Godot tools.')
            await untilTurnSettled(mark)
            const calls = await toolCallsFor('godot_scene', mark)
            if (calls.length === 0)
                throw new Error(
                    'the turn made 0 godot_scene calls; it called '
                        + JSON.stringify(toolCallsSince(mark).map(call => call.name))
                )
            expect(calls.some(call => call.status === 'complete')).toBe(true)
        })

        it('stops an answer in flight and offers to retry it', async () => {
            await sendChat('Explain the Godot scene tree in exhaustive detail, step by step.')
            await expectText(['Gofer is working…'], {limitMs: 60_000})
            await clickControl('Stop')
            await expectElement(buttonSelector('Retry'), 'Retry button', 60_000)
        })

        it('retries the answer it stopped', async () => {
            await clickButton('Retry')
            await expectText(['Gofer is working…'], {limitMs: 60_000})
            await clickControl('Stop')
            await expectElement(buttonSelector('Retry'), 'Retry button', 60_000)
        })

        it('carries an attached image into the conversation', async () => {
            expect(capturedFrame.length).toBeGreaterThan(1_000)
            await attachImage('editor-viewport.png', 'image/png', capturedFrame)
            await expectElement(
                'img[alt="Attached image: editor-viewport.png"]',
                'attached image thumbnail',
                30_000
            )
        })

        it('drops an attachment it was told to remove', async () => {
            await clickSelector(
                '//button[contains(@aria-label, "Remove editor-viewport.png")]',
                'the attachment’s remove control'
            )
            await browser.waitUntil(
                async () => (await count('img[alt="Attached image: editor-viewport.png"]')) === 0,
                {
                    timeout: 30_000,
                    interval: 200,
                    timeoutMsg: 'the composer kept the attachment it was told to drop'
                }
            )
        })

        it('sends an image the model can actually read', async () => {
            await attachImage('editor-viewport.png', 'image/png', capturedFrame)
            await expectElement(
                'img[alt="Attached image: editor-viewport.png"]',
                'attached image thumbnail',
                30_000
            )
            await sendChat(
                'An image is attached to this message. Reply with the single word SEEN if you '
                    + 'received an image, and the single word BLIND if you received none. Use no '
                    + 'tools.'
            )
            await expectInConversation(['SEEN'], 300_000, ['BLIND'])
        })
    })

    describe('the tool approvals', () => {
        it('lets the agent write a file it did not have to ask about', async () => {
            await sendChat(
                'Create the file scripts/scratch.gd in this project containing exactly the line '
                    + '"# scratch". Do not delete anything.'
            )
            await browser.waitUntil(() => existsSync(join(bound, 'scripts/scratch.gd')), {
                timeout: 300_000,
                interval: 500,
                timeoutMsg: `the agent never wrote scripts/scratch.gd; the window shows: ${await pageText()}`
            })
        })

        it('asks before deleting a file, and takes no for an answer', async () => {
            await sendChat(
                'Delete scripts/scratch.gd from the project using your godot_resource tool’s '
                    + 'delete operation.'
            )
            await expectText(['Approve godot_resource delete?'], {limitMs: 300_000})
            expect(await dialogText()).toContain('scripts/scratch.gd')
            await clickButton('Reject')
            await expectGone(['Approve godot_resource delete?'], {limitMs: 60_000})
            expect(existsSync(join(bound, 'scripts/scratch.gd'))).toBe(true)
        })

        it('deletes the file once the user approves it', async () => {
            await sendChat(
                'Try again: delete scripts/scratch.gd using your godot_resource tool’s delete '
                    + 'operation. I will approve it this time.'
            )
            await expectText(['Approve godot_resource delete?'], {limitMs: 300_000})
            await clickButton('Approve')
            await browser.waitUntil(() => !existsSync(join(bound, 'scripts/scratch.gd')), {
                timeout: 300_000,
                interval: 500,
                timeoutMsg: `the approved delete never removed scripts/scratch.gd; the window shows: ${await pageText()}`
            })
        })
    })

    describe('building the first level of Mario', () => {
        it('cuts the project’s atlas into a tileset and paints the ground with it', async () => {
            await askUntil(
                'You are building a side-scrolling platformer in this Godot project. It ships '
                    + `16x16 pixel art at ${ATLAS}: eight tiles across and two down, which are `
                    + `${ATLAS_LEGEND}. `
                    + `Cut that atlas into a tileset at ${TILESET} with your godot_resource `
                    + 'create_tileset tool, making the tiles a player has to stand on or bump into '
                    + 'solid and leaving the scenery alone. '
                    + `Then create the scene ${LEVEL_SCENE_RESOURCE} with a Node2D root named `
                    + 'Level1, add a TileMapLayer named Terrain under it, set its tile_set property '
                    + 'to that tileset, and paint the ground of Super Mario Bros World 1-1 with '
                    + 'your godot_node set_cells tool: two rows of ground running the length of the '
                    + 'level, with a couple of gaps to fall down. Save the scene with godot_scene '
                    + 'save — never by writing .tscn or .tres text yourself.',
                async () => {
                    if (!existsSync(join(bound, LEVEL_SCENE))) return false
                    const scene = readFileSync(join(bound, LEVEL_SCENE), 'utf8')
                    if (!scene.includes('tile_map_data = PackedByteArray(')) return false
                    if (!scene.includes('tile_set = ExtResource(')) return false
                    const described = await godotCall<DescribedTileset>(
                        'resource.describe_tileset',
                        {path: TILESET}
                    ).catch(() => null)
                    if (!described?.sources.some(source => source.tiles.some(tile => tile.solid)))
                        return false
                    await openLevelInEditor()
                    return explorerShows(['Level1', 'Terrain'])
                },
                `${LEVEL_SCENE_RESOURCE} must hold a Node2D root named Level1 with a TileMapLayer `
                    + `named Terrain under it, that layer’s tile_set must be ${TILESET} built with `
                    + 'godot_resource create_tileset, some of that tileset’s tiles must be solid, '
                    + 'and the ground must be painted onto the layer with godot_node set_cells.'
            )
        })

        it('reports the tileset it built from the project’s own art', async () => {
            const described = await godotCall<DescribedTileset>('resource.describe_tileset', {
                path: TILESET
            })
            expect(described.tileSize).toEqual([16, 16])
            const source = described.sources[0]
            expect(source?.texture).toBe(ATLAS)
            expect(source?.regionSize).toEqual([16, 16])
            expect(source?.tiles.length).toBeGreaterThanOrEqual(8)
            expect(source?.tiles.some(tile => tile.solid)).toBe(true)
        })

        it('gives the level a player that walks and jumps', async () => {
            await askUntil(
                'Add the player to that level, using your godot_node tools on the open scene: a '
                    + 'CharacterBody2D named Player with a collision shape and something visible, '
                    + 'standing on the ground near the left edge. '
                    + 'Write its script at res://scripts/mario.gd so it walks left and right, '
                    + 'jumps, and falls under gravity, and attach it to the Player node. Register '
                    + 'the input actions move_left, move_right and jump in the project’s Input '
                    + 'Map so the script has keys to read. Save the scene.',
                async () => {
                    if (!existsSync(join(bound, 'scripts/mario.gd'))) return false
                    const registered = await godotCall<InputActions>(
                        'project.list_input_actions',
                        {}
                    ).catch(() => ({actions: []}))
                    const names = new Set(registered.actions.map(action => action.name))
                    if (!['move_left', 'move_right', 'jump'].every(action => names.has(action)))
                        return false
                    await openLevelInEditor()
                    const players = await editedNodes(
                        node => node.name === 'Player' && node.type === 'CharacterBody2D'
                    ).catch(() => [])
                    if (players.length === 0) return false
                    const scenes = [join(bound, LEVEL_SCENE), ...sceneFiles()]
                    return scenes.some(
                        path =>
                            nodesCarrying(readFileSync(path, 'utf8'), 'res://scripts/mario.gd')
                                .length > 0
                    )
                },
                'the level needs a CharacterBody2D named Player carrying res://scripts/mario.gd, '
                    + 'and the project needs the move_left, move_right and jump input actions.'
            )
        })

        it('fills the level in with the things World 1-1 is made of', async () => {
            await askUntil(
                'Finish World 1-1 on that same Terrain layer, with your godot_node set_cells tool '
                    + 'and the tiles the tileset already has: brick and question blocks floating '
                    + 'above the ground, at least two pipes standing on it — each pipe is its two '
                    + 'mouth tiles with its two shaft tiles under them, as many rows tall as you '
                    + 'want it — and the flag pole at the far right end of the level, with the ball '
                    + 'on top and the flag beside it. Put a bush and a cloud in as scenery. Save '
                    + 'the scene with godot_scene save and confirm it still opens.',
                async () => {
                    await openLevelInEditor()
                    const painted = await godotCall<PaintedCells>('node.get_cells', {
                        node: TERRAIN
                    }).catch(() => null)
                    if (!painted) return false
                    const used = new Set(painted.tiles.map(tile => tile.atlas.join(',')))
                    const has = (...tiles: string[]) => tiles.some(tile => used.has(tile))
                    if (!has('4,0', '5,0', '6,0', '7,0')) return false
                    if (!has('1,0', '2,0')) return false
                    if (!has('0,1', '1,1', '2,1')) return false
                    return painted.cells >= 120 && (painted.usedRect[2] ?? 0) >= 40
                },
                'the Terrain layer still needs pipe tiles, brick or question blocks, and the flag '
                    + 'at the end, painted with godot_node set_cells and saved into the scene. '
                    + 'Call godot_scene save as you go: the scene is reopened from disk to check '
                    + 'it, so cells you painted but never saved are gone.'
            )
        })

        it('gives the level coins the player can collect', async () => {
            await askUntil(
                'Add coins to that level: at least three Area2D nodes named Coin, floating above '
                    + 'the ground where a player would jump for them, each with a collision shape '
                    + 'and something visible. Write res://scripts/coin.gd with a method that '
                    + 'prints "coin collected" and frees the coin, and attach it to each one. Then '
                    + 'wire each coin up in the scene itself: connect its body_entered signal to '
                    + 'that method with your godot_node connect_signal tool, targeting the coin, '
                    + 'and put every coin in the group "coins" with godot_node add_to_group. Save '
                    + 'the scene.',
                async () => {
                    if (!existsSync(join(bound, 'scripts/coin.gd'))) return false
                    await openLevelInEditor()
                    if (!(await explorerShows(['Coin']))) return false
                    const coin = await godotCall<InspectedNode>('node.inspect', {
                        node: `/Level1/Coin`
                    }).catch(() => null)
                    if (!coin) return false
                    if (!coin.groups.includes('coins')) return false
                    return coin.connections.some(entry => entry.signal === 'body_entered')
                },
                'the level needs at least three Area2D coins carrying res://scripts/coin.gd, the '
                    + 'first of them named Coin, each with its body_entered connected to that '
                    + 'script’s method and each in the group "coins", and the scene saved '
                    + 'afterwards. Connecting inside a coin scene you instance is fine.'
            )
        })

        it('shows the coin’s wiring in the inspector', async () => {
            await openLevelInEditor()
            await clickSelector(
                '//*[@aria-label="Explorer"]//*[starts-with(normalize-space(text()),"Coin")]',
                'a coin in the scene tree'
            )
            await openInspector()
            await clickTab('Node')
            await expectInInspector(['coins', 'body_entered →'])
            await closeInspector()
        })

        it('follows the player with a camera and shows the score', async () => {
            await askUntil(
                'Two last things. Give the Player a Camera2D child so the view follows it down '
                    + 'the level. Then add a CanvasLayer named HUD holding a Label that shows how '
                    + 'many coins have been collected, and make the coin script keep the count and '
                    + 'update that Label. Save the scene.',
                async () => {
                    await openLevelInEditor()
                    const cameras = await editedNodes(
                        node => node.type === 'Camera2D' && node.path.includes('/Player')
                    ).catch(() => [])
                    if (cameras.length === 0) return false
                    const hud = await editedNodes(
                        node => node.type === 'CanvasLayer' && node.name === 'HUD'
                    ).catch(() => [])
                    if (hud.length === 0) return false
                    return explorerShows(['HUD'])
                },
                'the Player still needs a Camera2D child, and the level a CanvasLayer named HUD '
                    + 'with a Label the coin script updates.'
            )
        })

        it('builds an enemy once and places instances of it', async () => {
            await askUntil(
                'Now the part a real project does: build the enemy once as its own scene, and '
                    + 'place it more than once. Create res://scenes/goomba.tscn with a '
                    + 'CharacterBody2D root named Goomba, a collision shape and something visible, '
                    + 'and write res://scripts/goomba.gd so it walks back and forth along the '
                    + 'ground under gravity. Save that scene. Then open the level again and put at '
                    + 'least three of them on the ground with your godot_node instantiate tool — '
                    + 'instances of that scene, never rebuilt node by node. Save the level.',
                async () => {
                    if (!existsSync(join(bound, 'scenes/goomba.tscn'))) return false
                    if (!existsSync(join(bound, 'scripts/goomba.gd'))) return false
                    const scene = readFileSync(join(bound, LEVEL_SCENE), 'utf8')
                    if (nodesInstancing(scene, 'res://scenes/goomba.tscn').length < 3) return false
                    await openLevelInEditor()
                    return explorerShows(['Goomba'])
                },
                'the level needs at least three instances of res://scenes/goomba.tscn, placed with '
                    + 'godot_node instantiate rather than rebuilt, and the level saved afterwards.'
            )
        })

        it('makes the level the scene the project runs', async () => {
            await askUntil(
                `Make ${LEVEL_SCENE_RESOURCE} the project’s main scene, so running the project `
                    + 'starts the level.',
                async () =>
                    (
                        await godotCall<{value?: {value?: unknown}}>('project.get_setting', {
                            name: 'application/run/main_scene'
                        }).catch(() => ({value: undefined}))
                    ).value?.value === LEVEL_SCENE_RESOURCE,
                `application/run/main_scene must be ${LEVEL_SCENE_RESOURCE} — the setting itself, `
                    + 'spelled with slashes the way Godot names it, not a similar name.'
            )
            await openInspector()
            try {
                await clickTab('Project')
                await fillLabelledInput('Search project settings', 'main_scene')
                await expectInInspector(['application/run/main_scene', LEVEL_SCENE_RESOURCE])
            } finally {
                await closeInspector()
            }
        })

        it('has no script the language server cannot parse', async () => {
            const scripts = readdirSync(join(bound, 'scripts'))
                .filter(name => name.endsWith('.gd'))
                .map(name => `scripts/${name}`)
                .concat(
                    readdirSync(join(bound, 'scenes'))
                        .filter(name => name.endsWith('.gd'))
                        .map(name => `scenes/${name}`)
                )
            expect(scripts.length).toBeGreaterThan(0)
            const broken: string[] = []
            for (const path of scripts) {
                await invokeCommand('open_script_document', {request: {path}})
                const answer = await invokeCommand<ScriptDiagnosticsAnswer>(
                    'call_script_language',
                    {
                        request: {op: 'diagnostics', path, timeoutMs: 20_000}
                    }
                )
                for (const diagnostic of answer.diagnostics)
                    if (diagnostic.severity === 1) broken.push(`${path}: ${diagnostic.message}`)
            }
            expect(broken).toEqual([])
        })

        it('runs the level the agent built and draws a frame of it', async () => {
            beforeTheRun = (
                await invokeCommand<GodotLogPage>('read_godot_logs', {
                    query: {minSeverity: 'error', limit: 1000}
                })
            ).cursor
            await clickTab('Game')
            await clickButton('Run')
            await expectSelector('img[alt*="running game"]', 180_000)
            expect((await frameSize()).height).toBeGreaterThan(0)
        })

        it('shows the level’s own nodes in the running game', async () => {
            await clickTab('Runtime')
            await expectInExplorer(['Level1', 'Player'], 120_000)
        })

        it('plays the level: the player moves when its own key is held', async () => {
            const player = await runningNodePath('Player')
            const moveRight = await boundKey('move_right')
            const positionOf = async () => {
                const inspected = await godotCall<RuntimeInspection>('runtime.inspect_node', {
                    path: player,
                    properties: ['position']
                })
                const value = inspected.properties?.['position']?.value
                if (!Array.isArray(value))
                    throw new Error(`the player reported no position: ${JSON.stringify(inspected)}`)
                return {x: Number(value[0]), y: Number(value[1])}
            }

            const landed = await positionOf()
            await browser.pause(2_000)
            const settled = await positionOf()
            expect(settled.y).toBeLessThan(landed.y + 64)

            const before = (await positionOf()).x
            await godotCall('runtime.input', {
                events: [{kind: 'key', key: moveRight, pressed: true}]
            })
            try {
                const deadline = Date.now() + 30_000
                for (;;) {
                    const now = (await positionOf()).x
                    if (now > before + 16) return
                    if (Date.now() >= deadline)
                        throw new Error(
                            `holding ${moveRight} moved the player from ${String(before)} to `
                                + `${String(now)}; `
                                + 'the level cannot be played with the input actions it registered'
                        )
                }
            } finally {
                await godotCall('runtime.input', {
                    events: [{kind: 'key', key: moveRight, pressed: false}]
                })
            }
        })

        it('reports no error from the script the agent wrote', async () => {
            const page = await invokeCommand<GodotLogPage>('read_godot_logs', {
                query: {after: beforeTheRun, minSeverity: 'error', limit: 1000}
            })
            const named = page.entries
                .map(entry => entry.message)
                .filter(message =>
                    ['mario.gd', 'coin.gd', 'goomba.gd'].some(script => message.includes(script))
                )
            expect(named).toEqual([])
        })

        it('stops the level again', async () => {
            await clickTab('Game')
            await clickControl('Stop')
            await expectText(['No frame captured'], {limitMs: 60_000})
        })
    })

    describe('a conversation that outgrows the context window', () => {
        it('summarises what came before and keeps answering', async () => {
            const taskId = await currentTaskId()
            const summarised = agentMessages(taskId).find(
                entry => entry.role === 'compactionSummary'
            )
            const used = lastContextTokens(taskId)
            if (used <= COMPACTION_WINDOW)
                throw new Error(
                    `this task sends ${String(used)} tokens, which still fits in a `
                        + `${String(COMPACTION_WINDOW)}-token window: nothing would be summarised`
                )

            await openSettings()
            await fillLabelledInput('Context window', String(COMPACTION_WINDOW))
            await clickButton('Save connection')
            await expectText(['Settings saved'], {limitMs: 60_000})
            await browser.keys('Escape')
            try {
                await clickTab('Chat')
                const mark = Date.now()
                await sendChat(
                    'In one sentence, what have we built in this task so far?',
                    AGENT_LIMIT_MS
                )
                const answer = await untilTurnSettled(mark)

                const after = agentMessages(taskId)
                const summary = after.find(entry => entry.role === 'compactionSummary')
                if (!summary)
                    throw new Error(
                        `the conversation was never summarised: the task remembers `
                            + `${String(after.length)} messages, none of them a compaction summary, `
                            + `and the turn ended ${String(answer.status)}`
                    )
                if (summary.summary === summarised?.summary)
                    throw new Error(
                        'the conversation was not summarised again: the task remembers the '
                            + 'summary it already had before this turn'
                    )
                expect((summary.summary ?? '').length).toBeGreaterThan(0)
                expect(summary.tokensBefore ?? 0).toBeGreaterThan(0)

                expect(answer.status).toBe('complete')
                expect((answer.text ?? '').trim()).not.toBe('')
            } finally {
                await openSettings()
                await fillLabelledInput('Context window', CONFIGURED_WINDOW)
                await clickButton('Save connection')
                await expectText(['Settings saved'], {limitMs: 60_000})
                await browser.keys('Escape')
            }
        })
    })

    describe('merging the task back', () => {
        it('merges the branch the agent worked on into the project', async () => {
            await clickButton('Merge task')
            await expectGone(['Merge task'], {limitMs: 120_000})
        })

        it('leaves the level in the project the sweep was pointed at', () => {
            expect(git('rev-parse', 'HEAD')).not.toBe(seedCommit)
            expect(git('ls-tree', '--name-only', '-r', 'HEAD')).toContain(LEVEL_SCENE)
        })

        it('keeps Gofer’s own scaffolding out of the project it merged into', () => {
            const project = readFileSync(join(workspace, 'project.godot'), 'utf8')
            expect(project).not.toContain('addons/gofer')
            expect(project).not.toContain('GoferRuntime')
            expect(existsSync(join(workspace, 'addons/gofer'))).toBe(false)
        })
    })

    describe('opening another task while the editor runs', () => {
        let builtOn = ''

        it('stops the editor before the checkout moves', async () => {
            builtOn = await currentRoute()
            const branchBefore = currentBranch()
            await clickText('New task')
            await browser.waitUntil(async () => (await currentRoute()) !== builtOn, {
                timeout: 60_000,
                interval: 200,
                timeoutMsg: 'the window never moved to the new task'
            })

            expect(currentBranch()).not.toBe(branchBefore)
            await expectText(['Start Godot'], {limitMs: 60_000})

            const answered = await godotCall<RuntimeTree>('scene.get_tree', {})
                .then(tree => tree.root?.name ?? '(no scene)')
                .catch((error: unknown) => `refused: ${String(error)}`)
            expect(answered).not.toBe('Level1')
        })

        after(async () => {
            if (builtOn === '') return
            try {
                await clickSelector(`a[href="${builtOn}"]`, 'the task the level was built in')
                await browser.waitUntil(async () => (await currentRoute()) === builtOn, {
                    timeout: 60_000,
                    interval: 200,
                    timeoutMsg: `the window never returned to ${builtOn}`
                })
            } catch (error: unknown) {
                console.log(`could not return to ${builtOn}: ${String(error)}`)
            }
        })
    })

    describe('an editor that exits on its own', () => {
        it('stops presenting a session whose editor is gone', async () => {
            const running = execFileSync('pgrep', ['-f', `godot --editor.*${bound}`], {
                encoding: 'utf8'
            })
                .split('\n')
                .filter(Boolean)
            expect(running.length).toBeGreaterThan(0)
            for (const pid of running) execFileSync('kill', ['-9', pid])

            await expectText(['No editor running'], {limitMs: 60_000})
        })

        it('closes the run it was recording rather than leaving it open', async () => {
            const open = () =>
                databaseRows('select status from godot_runs order by rowid').filter(
                    status => status === 'running'
                )
            const deadline = Date.now() + 60_000
            while (open().length > 0 && Date.now() < deadline) await browser.pause(500)
            expect(open()).toEqual([])
        })

        it('starts a fresh editor over the dead one', async () => {
            await forgetSessionStates()
            await clickTab('Scene')
            await clickButton('Start Godot')
            await expectSessionState('ready', 180_000)
            bound = await sessionWorktree()
        })
    })

    describe('shutting the session down', () => {
        it('stops the editor and removes the staged addon', async () => {
            await clickButton('Stop Godot')
            await expectText(['Editor stopped', 'Start Godot'], {limitMs: 60_000})
            expect(existsSync(join(bound, 'addons/gofer'))).toBe(false)
        })

        it('leaves the panels saying there is no session rather than failing', async () => {
            await clickTab('Scene')
            await expectText(['No editor running'], {limitMs: 30_000})
        })
    })

    describe('a workspace that is not a Godot project', () => {
        it('refuses the session by naming the directory and what to do about it', async () => {
            renameSync(join(bound, 'project.godot'), join(bound, 'project.godot.hidden'))
            try {
                await clickButton('Start Godot')
                await expectText(
                    [
                        'contains no project.godot',
                        'Commit your project files in your project folder',
                        bound
                    ],
                    {allow: REFUSAL, limitMs: 60_000}
                )
            } finally {
                renameSync(join(bound, 'project.godot.hidden'), join(bound, 'project.godot'))
            }
        })

        it('leaves the session offline rather than half started', async () => {
            await expectText(['Start Godot', 'Editor stopped'], {allow: REFUSAL})
        })
    })

    describe('what the renderer logged', () => {
        it('reported no unexpected errors along the way', async () => {
            const errors = await pageErrors()
            const unexpected = errors.filter(
                entry => !/cancel|abort|project\.godot|stale element|NotAllowedError/i.test(entry)
            )
            expect(unexpected).toEqual([])
        })
    })

    after(async () => {
        console.log('--- the window at the end of the sweep ---')
        console.log(await pageText().catch(() => '(unreadable)'))
        console.log('--- the workspace after the sweep ---')
        console.log(git('log', '--oneline', `${seedCommit}..HEAD`) || '(nothing merged)')
        console.log(git('status', '--short') || '(clean)')
        if (existsSync(join(workspace, 'addons')))
            console.log(`addons/: ${readdirSync(join(workspace, 'addons')).join(', ')}`)
    })
})

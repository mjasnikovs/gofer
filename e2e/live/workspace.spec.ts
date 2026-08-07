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

/**
 * The whole application, driven against a real Godot project on this machine.
 *
 * Nothing here is stubbed: the AI worker talks to the configured endpoint, retrieval uses the
 * models already in the user's cache, and the editor is a real windowed Godot 4.7 running the
 * project in a task worktree. Only the application data directory is redirected, so a sweep cannot
 * touch the user's own projects.
 *
 * The suite is ordered rather than independent, because the application is: a scene tree needs an
 * editor, a debugger needs a game, and starting a fresh editor for each assertion would spend
 * minutes proving something the previous test already established.
 */
const workspace = process.env.GOFER_WORKSPACE_DIR ?? seedLiveWorkspace()
/** A line inside `_on_tick`, which the fixture's timer reaches about once a second. */
const BREAK_LINE = 19
/** The fixture's `@export var tick_interval`, which is used again further down the same file. */
const EXPORT_LINE = 5
const RENAMED_SYMBOL = 'tick_interval_renamed'
/** A line no GDScript parser accepts, typed at the top of the file where the caret is put. */
const BROKEN_EDIT = '~\n'
/** A port nothing on this machine listens on, so the connection fails rather than hanging. */
const UNREACHABLE_URL = 'http://127.0.0.1:9/v1'
/** The scene the agent is asked to build, named as the worktree holds it and as Godot names it. */
const LEVEL_SCENE = 'scenes/level_1.tscn'
const LEVEL_SCENE_RESOURCE = `res://${LEVEL_SCENE}`
/**
 * How long one agent turn may take.
 *
 * A local 27B model authoring a scene runs a dozen tool calls per turn, and every one of them is a
 * command in flight — so the idle detector still ends a turn that has actually stopped working;
 * this is only the outer bound on one that has not.
 */
const AGENT_LIMIT_MS = 900_000
/** The refusal a workspace without a project file has to produce, quoted from the backend. */
const REFUSAL = [
    'could not be started',
    'contains no project.godot',
    'is not a Godot project'
] as const

/** The worktree the editor bound to, remembered for the assertions that outlive the session. */
let bound = ''
/** The endpoint the machine is actually configured for, put back after the offline scenario. */
let baseUrl = ''
/** The last frame the Game tab captured, reused as the image the chat sends to the model. */
let capturedFrame = ''
/** The commit the workspace started on, so a sweep that merges a task can undo it afterwards. */
const seedCommit = execFileSync('git', ['-C', workspace, 'rev-parse', 'HEAD'], {
    encoding: 'utf8'
}).trim()
/**
 * The fixture script as the workspace holds it.
 *
 * The sweep edits, formats, renames and overwrites the worktree's copy; the debugger further down
 * breaks on a line number, so the file has to be this again before it runs.
 */
const seedScript = readFileSync(join(workspace, 'scripts/main.gd'), 'utf8')

function git(...arguments_: string[]) {
    return execFileSync('git', ['-C', workspace, ...arguments_], {encoding: 'utf8'}).trim()
}

/** The checkouts Gofer created for its tasks, named by their `gofer/task-*` branches. */
function taskWorktrees() {
    return git('worktree', 'list')
        .split('\n')
        .filter(entry => entry.includes('[gofer/task-'))
        .map(entry => entry.split(' ')[0] ?? '')
        .filter(Boolean)
}

/** The branches Gofer created for its tasks. */
function taskBranches() {
    return git('branch', '--list', 'gofer/task-*')
        .split('\n')
        .map(entry => entry.replace('*', '').trim())
        .filter(Boolean)
}

/**
 * The worktree the running editor is bound to, as the backend reports it.
 *
 * Which checkout is "the active one" is the backend's fact, not something a path listing can be
 * asked: several tasks have worktrees at once, and their order on disk says nothing about which
 * task the window is showing.
 */
async function sessionWorktree() {
    const session = await invokeCommand<{worktree?: string} | null>('get_godot_session')
    const worktree = session?.worktree
    if (!worktree) throw new Error('no Godot session is running, so no worktree is bound')
    return worktree
}

/** What the language server last published about one file. */
type ScriptDiagnosticsAnswer = Readonly<{
    op: 'diagnostics'
    path: string
    published: boolean
    diagnostics: readonly Readonly<{message: string; severity?: number | undefined}>[]
}>

/** One tagged value, as every Godot value crosses the wire. */
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

/** Correlates the sweep's own editor requests, which share the session the panels use. */
let nextRequestId = 0

/**
 * Sends one command to the editor session the way the renderer's own panels do.
 *
 * Used only where the question cannot be asked of the interface: the running game's node positions
 * are behind no control, and the sweep has to read them itself to say whether the level plays.
 */
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

/** Where the running game keeps a node, which is not where the edited scene keeps it. */
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

/** The key an action is bound to, read back from the Input Map rather than assumed. */
async function boundKey(action: string) {
    const {actions} = await godotCall<InputActions>('project.list_input_actions', {})
    const found = actions.find(entry => entry.name === action)
    const key = found?.events.find(event => event.kind === 'key')?.key
    if (!key) throw new Error(`${action} is bound to no key: ${JSON.stringify(found)}`)
    return key
}

/** How many nodes the edited scene tree is showing. */
async function sceneNodeCount() {
    return browser.execute(
        () => document.querySelectorAll('[aria-label="Explorer"] [role="treeitem"]').length
    )
}

interface StoppedFrame {
    /** The words on the row, which is what a person clicks. */
    label: string
    /** The script part of them, which is what the editor has to open. */
    path: string
}

/**
 * The script the debugger's stack is stopped in, read from the panel rather than assumed.
 *
 * The row writes the file and the line as one text node — `scripts/player.gd:9` — so the node is
 * asked for its own text rather than an ancestor's, which would carry the frame's name as well.
 */
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

/**
 * Blocks until the answer now being written holds this, rather than the part of it on screen.
 *
 * An answer of any length scrolls its own beginning out of the window, and the window's text is
 * only what can be seen — so what the model said has to be read from the transcript.
 *
 * Only what the transcript grows by is searched. The question is in it too, and a question that
 * names the word a wrong answer would use — "reply SEEN, or BLIND if you received no image" — would
 * otherwise fail the moment it was asked, blaming the model for the sweep's own wording.
 */
async function expectInConversation(
    wanted: readonly string[],
    limitMs: number,
    forbidden: readonly string[] = []
) {
    // What the transcript holds *more* of than it did when the question was asked. Counting rather
    // than slicing at the length it had: a message that finishes gains a usage footer, so the text
    // before the question grows too and a fixed offset ends up in the middle of a word.
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

/**
 * Whether the explorer comes to show all of these, without failing if it does not.
 *
 * The scene tree is fetched when the tab is switched to, so reading it the moment the click returns
 * reads the tree the panel had before. A check that answers "no" to that costs an agent turn.
 */
async function explorerShows(wanted: readonly string[], limitMs = 30_000) {
    const deadline = Date.now() + limitMs
    for (;;) {
        const shown = await regionText('Explorer')
        if (wanted.every(needle => shown.includes(needle))) return true
        if (Date.now() >= deadline) return false
        await browser.pause(500)
    }
}

/** Blocks until the explorer column itself shows this, rather than anywhere in the window. */
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

/** The base64 of whatever picture the Game tab is showing, which is a real PNG of this project. */
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

/** What one script tab reads, badge and all. */
async function tabText(value: string) {
    return browser.execute(
        (attribute: string) =>
            Array.from(document.querySelectorAll('[data-tab-value]')).find(
                tab => tab.getAttribute('data-tab-value') === attribute
            )?.textContent ?? '',
        value
    )
}

/** Which task the route is showing. */
async function currentRoute() {
    return browser.execute(() => window.location.hash)
}

/** Every task the sidebar is offering, by the route each one opens. */
async function taskLinks(): Promise<readonly string[]> {
    return browser.execute(() =>
        Array.from(document.querySelectorAll('a[href^="#/tasks/"]')).map(
            link => link.getAttribute('href') ?? ''
        )
    )
}

/**
 * Brings the inspector into view.
 *
 * Under 1024px — which is what a tiling window manager hands this application — the frame moves the
 * inspector into a dialog opened from the toolbar. Both layouts are real, so the sweep asks which
 * one it is in rather than assuming the roomy one.
 */
async function openInspector() {
    if (await isNarrowLayout()) await clickButton('Inspector')
}

async function closeInspector() {
    if (await isNarrowLayout()) await browser.keys('Escape')
}

/**
 * Asks the agent for something and holds it to the result.
 *
 * A local model does not always finish what one message asked for, and a person in front of this
 * window would say so and let it carry on — so the sweep does too, up to a point. What it never
 * does is do the work itself: every node, script and setting below is the agent's, and the check is
 * made against the worktree and the editor rather than against the answer.
 */
async function askUntil(prompt: string, isDone: () => Promise<boolean>, missing: string) {
    await sendChat(prompt, AGENT_LIMIT_MS)
    for (let attempt = 0; attempt < 3; attempt++) {
        // The answer has to be finished before it can be judged. Asking the worktree the moment
        // the message was sent judged an agent that had not started yet: every step then spent one
        // whole turn being told it had not done work it was still doing.
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

/**
 * Opens the level the agent is building in the managed editor.
 *
 * The editor owns the edited scene, so the tree, the inspector and Run all follow whatever it has
 * open — which is not necessarily what the agent touched last.
 */
async function openLevelInEditor() {
    await clickTab('Files')
    await clickSelector(
        '//*[@aria-label="Explorer"]//*[normalize-space(text())="level_1.tscn"]',
        'the level in the file tree'
    )
    await clickTab('Scene')
}

/**
 * Opens the settings page and waits for the form rather than for the click.
 *
 * The navigation item is present before the router can act on it — a window that has just reloaded
 * renders its shell first — so a single click can be swallowed. What says the page is open is the
 * form itself.
 */
async function openSettings() {
    for (let attempt = 0; attempt < 5; attempt++) {
        await clickText('Settings')
        const opened = await untilText(['AI connection', 'Base URL'], {limitMs: 15_000})
        if (opened.ok) return
    }
    throw new Error(`the settings page never opened; the window shows: ${await pageText()}`)
}

/** Puts the caret inside a line, at a column, which is where a rename reads its symbol from. */
async function placeCaretOn(line: number, column: number) {
    await placeCaretAtLineStart(line)
    for (let step = 1; step < column; step++) await browser.keys(KEYS.arrowRight)
}

/** Presses the breakpoint gutter beside the line the fixture's timer runs through. */
async function pressBreakpointGutter() {
    await revealLine(BREAK_LINE)
    const refused = await pressGlyphMargin(BREAK_LINE)
    if (refused !== '')
        throw new Error(
            `the gutter of line ${String(BREAK_LINE)} could not be pressed: ${refused}; Monaco `
                + `shows lines ${JSON.stringify(await renderedLines())}`
        )
}

/**
 * Sends one chat message.
 *
 * The composer is typed into rather than assigned to, and what it holds is read back before Enter:
 * a composer that silently took nothing would otherwise send an empty message and leave the wait
 * below blaming the model for a keystroke that never landed.
 */
/**
 * Blocks until the composer will take another message, which is how a turn says it is over.
 *
 * An answer still streaming makes the composer refuse the next message outright, and the refusal is
 * silent: the placeholder is the only thing that says which state it is in.
 *
 * A panel reading nothing is allowed here: the agent may stop and restart the editor session during
 * its own turn, and while it is down every panel says so. That is a state of the workspace, not a
 * fault in the composer this wait is about.
 */
async function untilComposerIsFree(limitMs: number) {
    await expectText(['Ask anything'], {allow: ['could not be read'], limitMs})
}

async function sendChat(prompt: string, limitMs = 240_000) {
    await releaseModifiers()
    await untilComposerIsFree(limitMs)
    const composer = browser.$('[role="textbox"]')
    await composer.waitForDisplayed({timeout: 15_000})
    for (let attempt = 0; attempt < 3; attempt++) {
        await composer.click()
        await composer.setValue(prompt)
        if ((await composer.getText()).includes(prompt.slice(0, 20))) {
            await browser.keys('Enter')
            // A sent message empties the composer; a refused one leaves the text sitting there.
            // What the conversation shows is no help — WebKit's `innerText` omits whatever the
            // message list has scrolled past.
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
            await expectText(['Local AI connected'], {limitMs: 30_000})
        })

        it('offers the session controls the workspace is built around', async () => {
            await expectText(['Start session', 'Run project', 'Chat', 'Scripts', 'Game', 'Docs'])
        })

        it('creates a task backed by an isolated worktree', async () => {
            const before = taskWorktrees()
            await clickText('New task')
            // The worktree is a fact on disk rather than a rendering, so Git is what is asked.
            await browser.waitUntil(() => taskWorktrees().length > before.length, {
                timeout: 30_000,
                interval: 100,
                timeoutMsg: 'the task never received a worktree'
            })
            const created = taskWorktrees().filter(root => !before.includes(root))
            expect(created.every(root => existsSync(join(root, 'project.godot')))).toBe(true)
        })

        it('lists its tasks in the sidebar', async () => {
            await clickText('New task')
            await browser.waitUntil(() => taskWorktrees().length > 1, {
                timeout: 30_000,
                interval: 100,
                timeoutMsg: 'the second task never received a worktree'
            })
            // Every task Gofer has is reachable from the sidebar, or the user cannot return to it.
            await browser.waitUntil(async () => (await count('a[href^="#/tasks/"]')) >= 2, {
                timeout: 30_000,
                interval: 200,
                timeoutMsg: `the sidebar never listed the tasks; it shows: ${await pageText()}`
            })
        })

        it('switches to the task the sidebar names', async () => {
            const before = await currentRoute()
            // The newest task is already open, so switching means the entry that is not it.
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
            // A task whose worktree has never been merged is one the header offers to merge.
            await expectText(['Godot 4.7', 'Merge task'])
        })

        it('deletes a task from the sidebar with its worktree and branch', async () => {
            const route = await currentRoute()
            const links = await taskLinks()
            // The task being shown is left alone: this is the sidebar deleting one in the
            // background, which is how a user clears a task they are not looking at.
            const doomed = links.findIndex(href => !route.endsWith(href.slice(1)))
            expect(doomed).toBeGreaterThanOrEqual(0)
            const worktreesBefore = taskWorktrees()
            const branchesBefore = taskBranches()

            // The delete buttons follow the same order as the links they sit beside.
            await clickSelector(
                `(//button[starts-with(@aria-label, "Delete task")])[${String(doomed + 1)}]`,
                'the delete button of the task in the sidebar'
            )
            // Nothing is destroyed until the warning is confirmed.
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
            // Git is what is asked about the branch and the checkout, not the rendering.
            const removedWorktrees = worktreesBefore.filter(root => !taskWorktrees().includes(root))
            expect(removedWorktrees.length).toBe(1)
            expect(existsSync(String(removedWorktrees[0]))).toBe(false)
            expect(taskBranches().length).toBe(branchesBefore.length - 1)
            // The task that was on screen is still the one on screen, and still usable.
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
            // Two fields the form shows and refuses: they say what Gofer speaks, and offering them
            // as editable would promise a choice the backend does not have.
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
            // Choosing a model rewrites the identity fields the request is built from.
            const chosen = await labelledInputValue('Model ID')
            expect(offered).toContain(chosen)
        })

        it('offers the thinking levels the configured model supports', async () => {
            await clickSelector(
                '//button[starts-with(normalize-space(.), "Reasoning:")]',
                'the reasoning menu'
            )
            await expectSelector('[role="menuitem"]')
            await browser.keys('Escape')
        })

        it('edits every request field the connection is built from', async () => {
            await fillLabelledInput('Connection name', 'Local AI')
            await fillLabelledInput('Context window', '120064')
            await fillLabelledInput('Maximum output tokens', '120064')
            await fillLabelledInput('Request timeout', '600000')
            await fillLabelledInput('Automatic retries', '2')
            await fillLabelledInput('Agent system prompt', '')
            // The key field is optional against a local server, and typing into it is what makes
            // the form offer to store or drop one.
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
            // The refusal is the subject here, so its own words are the assertion.
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

        /**
         * The connection is probed once, when the window opens.
         *
         * That is the only moment the header can learn the endpoint is gone — and it is exactly
         * what a user sees after starting Gofer with their model server down. Reloading the
         * renderer reproduces it against the backend that is already running, which is also the
         * only way this sweep can reach the Reconnect control at all.
         */
        it('shows the connection as offline when the window is reopened without it', async () => {
            await browser.refresh()
            await installActivityProbe()
            await expectText(['Local AI offline', 'Reconnect'], {limitMs: 180_000})
        })

        it('retries from the header and stays offline while the server is gone', async () => {
            await clickButton('Reconnect')
            // The retry is real: it reaches the same unreachable endpoint and says so again.
            await expectText(['Local AI offline', 'Reconnect'], {limitMs: 120_000})
        })

        it('comes back once the endpoint the settings name is reachable again', async () => {
            await openSettings()
            await fillLabelledInput('Base URL', baseUrl)
            await clickButton('Save connection')
            await expectText(['Settings saved'], {limitMs: 60_000})
            await browser.keys('Escape')
            await expectText(['Local AI connected'], {
                absent: ['Reconnect'],
                limitMs: 120_000
            })
            await openSettings()
        })

        it('reports the retrieval cache it is actually using', async () => {
            await expectText(['Godot documentation models', 'Cache location', 'Disk usage'])
            expect(await shows('gofer-rag')).toBe(true)
        })

        it('asks before deleting the retrieval cache, and takes no for an answer', async () => {
            await clickButton('Delete model cache')
            await expectText(['Delete documentation model cache?', '1.68 GiB'])
            // Answering yes would delete the models this machine actually uses; the sweep proves
            // the gate exists rather than that a 1.68 GiB download can be provoked.
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
            await expectText(['Start session'])
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
            // Under 1024px the inspector is a dialog, and a dialog has no handle to drag.
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
            await expectText(['No editor session', 'Start editor session'])
            await clickTab('Runtime')
            await expectText(['No editor session'])
            await clickTab('Debugger')
            await expectText(['The game is not stopped'])
            await clickTab('Problems')
        })
    })

    describe('the editor session', () => {
        it('starts the managed Godot editor from the explorer’s own control', async () => {
            await forgetSessionStates()
            await clickTab('Scene')
            // The explorer offers the session to a user who is looking at the empty tree, which is
            // where they find out there is none; the toolbar's button is exercised further down.
            await clickButton('Start editor session')
            await expectSessionState('ready', 180_000)
            await expectText(['4.7.1', 'Stop session'])
            // The lifecycle the toolbar's status dot reflects, in the order it happened.
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
            // The node panel reports identity — name, type, path, groups — never properties.
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
            // "No game is running" is a state of this panel, not a failure it reports.
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
            // The editor owns the edited scene, so opening one shows the tree the editor now
            // edits — never the scene's text, which is its serialization and not a document.
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
            // Reopening is what a person does after saving something the editor should complain
            // about, and it is the point at which the language server is handed the text.
            await clickButton('Close')
            await clickTab('Files')
            await clickText('main.gd')
            await expectText(['TICK_MESSAGE'], {limitMs: 30_000})
            await clickTab('Problems')
            await expectText(['scripts/main.gd:'], {limitMs: 60_000})
            // The script tab carries the count too, so a buffer that is not on screen still says
            // how much is wrong with it.
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
            // Two presses: the character and the line it sits on.
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
            // Reload is the way back from an edit that was never wanted, and it reads the file the
            // *worktree* holds rather than anything the editor is keeping in memory.
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
            // The caret has to sit inside the identifier, not beside it: line 5 reads
            // `@export var tick_interval: float = 1.0`, and column 15 is inside its name.
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
            // A rename is one transaction over every use, not a search and replace over one line.
            const written = readFileSync(join(bound, 'scripts/main.gd'), 'utf8')
            expect(written.match(new RegExp(RENAMED_SYMBOL, 'gu'))?.length ?? 0).toBeGreaterThan(1)
        })

        it('formats the open script through the bundled sidecar', async () => {
            await clickButton('Format')
            // The dialog reports what gdformat would write; an already-formatted buffer says so.
            await expectText(['Formatted with gdformat'], {limitMs: 30_000})
            await clickButton('Cancel')
            await expectGone(['Formatted with gdformat'])
        })

        it('applies what the formatter would write to the buffer', async () => {
            // gdformat has nothing to fix in a formatted file, so the buffer is given something it
            // can: an assignment padded out of shape, typed on the blank line under `extends`
            // where GDScript actually accepts one.
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
            // Something else writing the file is exactly the case the conflict exists for: another
            // editor, a Git checkout, or the agent's own tools.
            writeFileSync(path, `# changed on disk\n${onDisk}`, 'utf8')
            await clickButton('Save')
            await expectText(['This buffer is out of date', 'Reload from disk', 'Overwrite'], {
                // The refusal is the outcome under test, so it must not end the wait early.
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
            // Everything above was written into a real worktree; the debugger below breaks on a
            // line number, so the file has to be the fixture again before it runs.
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
            await clickButton('Run project')
            await expectSessionState('playing', 120_000)
            // Run switches the bottom panel to the debugger, which is where the stop shows up.
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
            // Which script the stack is in is the debuggee's business — a step-over walks into
            // whatever runs next, and in this fixture that is as often the player's `_process` as
            // the timer's own handler. So the frame on screen is read first, and the editor is
            // held to that file rather than to the one the sweep set the breakpoint in.
            const named = await stoppedFrameScript()
            // Clicking a frame is how a person gets from the stack to the line, so it selects the
            // frame and reveals its source in the editor at once.
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
            // The frame the debugger stopped in decided which buffer is in front, and the
            // breakpoint is in the other one — a step-over walks into whatever runs next, which in
            // this fixture is as often the player's `_process`.
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
            // The fixture prints every second and warns once it has printed five times. Both are
            // the game's own output arriving through the editor, and the warning is what the
            // recorded history is searched for further down.
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
            await expectText(['Not running', 'Run project'], {limitMs: 60_000})
        })

        it('launches again from the debugger’s own control', async () => {
            // The toolbar's Run is one action over two systems — ensure the editor, then launch.
            // The debugger's own Launch is the second half of it, and it has a session already.
            // What it produces is a game: whether that game is running or has already stopped on
            // something is the fixture's business, and this fixture warns itself into a stop.
            await forgetSessionStates()
            await clickButton('Launch')
            await expectSessionState('playing', 120_000)
            await expectText(['Stop project'], {limitMs: 60_000})
        })

        it('stops the project from the session toolbar', async () => {
            await clickButton('Stop project')
            await expectText(['Not running', 'Run project'], {limitMs: 60_000})
        })
    })

    describe('the game surface', () => {
        it('runs the project from the editor’s own play control', async () => {
            await clickTab('Game')
            await expectText(['No frame captured'])
            await clickButton('Run')
            // The run answers with the frame the game has already drawn, which is the proof.
            await expectSelector('img[alt*="running game"]', 120_000)
            await expectText(['Game · 640×360'], {limitMs: 30_000})
        })

        it('captures a frame of the running game on demand', async () => {
            await clickControl('Capture game')
            // A capture that fails replaces the picture with the reason it failed; one that
            // answers leaves a frame of the game's own size on screen.
            await expectText(['Game · 640×360'], {
                absent: ['The game frame could not be read'],
                limitMs: 60_000
            })
            await expectSelector('img[alt*="running game"]', 10_000)
        })

        it('restarts the game', async () => {
            await clickControl('Restart')
            await expectText(['Game · 640×360'], {
                absent: ['The game frame could not be read'],
                limitMs: 120_000
            })
            // The controls come back the moment the restart has finished with the editor.
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
            // Kept for the chat further down, which sends this very picture to the model.
            capturedFrame = await shownFrame()
        })
    })

    describe('the bottom panel', () => {
        it('shows the editor’s own output', async () => {
            await clickTab('Output')
            await expectText(['Godot Engine v4.7.1'], {limitMs: 60_000})
        })

        it('filters the output down to errors and back', async () => {
            await clickControl('Errors')
            // The engine's startup banner is an informational line, so a filter that keeps only
            // errors has to drop it.
            await expectGone(['Godot Engine v4.7.1'], {limitMs: 30_000})
            await clickControl('All')
            await expectText(['Godot Engine v4.7.1'], {limitMs: 30_000})
        })

        it('drops the informational lines when only warnings are wanted', async () => {
            await clickControl('Warnings')
            // The engine's startup banner is informational, so a filter that keeps warnings and
            // worse has to drop it — which line survives is the session's business, not the
            // filter's.
            await expectGone(['Godot Engine v4.7.1'], {limitMs: 30_000})
            await clickControl('All')
            await expectText(['Godot Engine v4.7.1'], {limitMs: 30_000})
        })

        it('filters the output by text', async () => {
            await fillLabelledInput('Filter output', 'live tick')
            await expectText(['live tick'], {absent: ['Godot Engine v4.7.1'], limitMs: 30_000})
            await fillLabelledInput('Filter output', '')
        })

        it('searches the recorded output of every session', async () => {
            await clickControl('History')
            // The archive keeps the warnings and errors of every session, so the sweep searches it
            // for one it caused itself: the parse error the broken script produced further up.
            await fillLabelledInput('Search recorded output', 'Parse Error')
            await expectText(['Parse Error'], {limitMs: 60_000})
            await clickControl('Session')
        })

        it('reports and rescans the imported assets', async () => {
            await clickTab('Import')
            await expectText(['imported asset(s)'], {limitMs: 30_000})
            await clickButton('Rescan project')
            await expectText(['imported asset(s)'], {limitMs: 60_000})
        })

        it('collapses and restores itself', async () => {
            // Collapsing keeps the tab strip: it is the only affordance that brings the panel back.
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
            // The first query loads the reranker; it answers the moment the passages land.
            await expectText(['CharacterBody2D', 'Section'], {limitMs: 180_000})
        })

        it('answers a second question over the models it already loaded', async () => {
            await fillInput(
                'input[placeholder="How do I move a CharacterBody2D?"]',
                'What does an AnimationPlayer node do?'
            )
            await clickButton('Search')
            // A subject the first answer had no reason to mention, so the passages are new ones.
            await expectText(['AnimationPlayer'], {limitMs: 120_000})
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
            // Choosing a level writes the settings the next request is built from, so the menu is
            // used rather than dismissed.
            await clickMenuItem('off')
            await expectText(['Reasoning: off'], {limitMs: 30_000})
        })

        it('offers image attachment according to the model’s input support', async () => {
            await expectSelector('button[aria-label="Attach images"]')
        })

        it('answers with the configured model, using its Godot tools', async () => {
            await sendChat('List every node in the main scene using your Godot tools.')
            // The tool the agent reached for is named in the answer's own activity; the node names
            // it reports are also in the explorer, so they would prove nothing on their own.
            await expectInConversation(['godot_scene'], 240_000)
        })

        it('stops an answer in flight and offers to retry it', async () => {
            await sendChat('Explain the Godot scene tree in exhaustive detail, step by step.')
            await expectText(['Gofer is working…'], {limitMs: 60_000})
            await clickControl('Stop')
            // The Retry sits under the answer it belongs to, which the conversation may already
            // have scrolled past; the document still holds it even when the window does not.
            await expectElement(buttonSelector('Retry'), 'Retry button', 60_000)
        })

        it('retries the answer it stopped', async () => {
            await clickButton('Retry')
            await expectText(['Gofer is working…'], {limitMs: 60_000})
            await clickControl('Stop')
            await expectElement(buttonSelector('Retry'), 'Retry button', 60_000)
        })

        it('carries an attached image into the conversation', async () => {
            // The picture is the frame the editor captured a few tests ago: a real PNG of this
            // very project, rather than something the sweep invented for the occasion.
            expect(capturedFrame.length).toBeGreaterThan(1_000)
            await attachImage('editor-viewport.png', 'image/png', capturedFrame)
            // The composer shows an attachment as a picture with an accessible name, and nothing
            // the window renders as text — so the document is what is asked, not `innerText`.
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
            // The word is the proof the bytes reached the model, which nothing on the Gofer side
            // of the request can fake.
            await expectInConversation(['SEEN'], 300_000, ['BLIND'])
        })
    })

    /**
     * The gate in front of the operations Git and the editor's undo stack cannot take back.
     *
     * The agent is asked to run one of them by name, twice: the first answer is no, which has to
     * leave the worktree exactly as it was, and the second is yes, which has to actually happen.
     */
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
            await expectText(['Approve godot_resource delete?', 'scripts/scratch.gd'], {
                limitMs: 300_000
            })
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

    /**
     * The application doing the thing it exists for: an agent building a game in a real editor.
     *
     * Nothing here is written by the sweep. Every node, script, input action and project setting
     * below is the model's own work, done through Gofer's tools, and what is asserted is what
     * survived into the worktree and into the running game — not what the answer claimed.
     */
    describe('building the first level of Mario', () => {
        it('creates the level scene and its ground', async () => {
            await askUntil(
                'You are building a side-scrolling platformer in this Godot project. Create the '
                    + `scene ${LEVEL_SCENE_RESOURCE} with a Node2D root named Level1, and give it `
                    + 'the ground of Super Mario Bros World 1-1: a StaticBody2D named Ground with '
                    + 'a collision shape wide enough for the whole level and something visible '
                    + 'drawn along it. Build the scene with your godot_scene and godot_node tools '
                    + 'and save it with godot_scene save — never by writing .tscn text yourself, '
                    + 'because a hand-written scene file the editor cannot open is a failure. '
                    + 'Finish by opening the scene with godot_scene open to prove it loads.',
                async () => {
                    if (!existsSync(join(bound, LEVEL_SCENE))) return false
                    // A collision shape with no shape in it is scenery, not ground: the player
                    // falls through it, and the level is a picture of a game rather than one. The
                    // scene names its shapes the way Godot's own writer does or not at all.
                    if (
                        !/shape = (?:Sub|Ext)Resource\(/u.test(
                            readFileSync(join(bound, LEVEL_SCENE), 'utf8')
                        )
                    )
                        return false
                    // Whether the agent left the level open in the editor or not, opening it is
                    // what a person does next — and it is the only way the tree read below is the
                    // level's own.
                    await openLevelInEditor()
                    return explorerShows(['Level1', 'Ground'])
                },
                `${LEVEL_SCENE_RESOURCE} must exist and hold a Node2D root named Level1 with a `
                    + 'StaticBody2D named Ground under it, and the Ground’s CollisionShape2D needs '
                    + 'a real shape resource — a shape property that is not one leaves the player '
                    + 'falling through the ground.'
            )
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
                    // The Input Map is project state, so the project file is asked rather than the
                    // answer that claims to have written it.
                    const project = readFileSync(join(bound, 'project.godot'), 'utf8')
                    if (
                        !['move_left', 'move_right', 'jump'].every(action =>
                            project.includes(action)
                        )
                    )
                        return false
                    await openLevelInEditor()
                    return explorerShows(['Player'])
                },
                'the level needs a CharacterBody2D named Player carrying res://scripts/mario.gd, '
                    + 'and the project needs the move_left, move_right and jump input actions.'
            )
        })

        it('fills the level in with the things World 1-1 is made of', async () => {
            await askUntil(
                'Finish World 1-1 in that scene, again with your godot_node tools: brick and '
                    + 'question blocks floating above the ground, at least two pipes standing on '
                    + 'it, and a goal flag at the far right end of the level. Name the nodes after '
                    + 'what they are — Pipe, Brick, Flag. Save the scene with godot_scene save and '
                    + 'confirm it still opens.',
                async () => {
                    const scene = readFileSync(join(bound, LEVEL_SCENE), 'utf8').toLowerCase()
                    if (
                        !scene.includes('pipe')
                        || !scene.includes('flag')
                        || !(scene.includes('block') || scene.includes('brick'))
                    )
                        return false
                    await openLevelInEditor()
                    await clickButton('Refresh')
                    // A level with ground, a player, blocks, pipes and a flag is not a four-node
                    // scene. The tree arrives with the fetch behind the tab, so the count is
                    // watched rather than sampled.
                    const deadline = Date.now() + 30_000
                    for (;;) {
                        if ((await sceneNodeCount()) >= 8) return true
                        if (Date.now() >= deadline) return false
                        await browser.pause(500)
                    }
                },
                'the level still needs brick or question blocks, at least two pipes, and a goal '
                    + 'flag, saved into the scene. Call godot_scene save as you go: the scene is '
                    + 'reopened from disk to check it, so nodes you built but never saved are gone.'
            )
        })

        /**
         * The half of a game that is not scenery.
         *
         * Everything above is nodes and shapes. A coin the player can pick up is wired: a signal
         * connected to a method, and a group the running game can ask for every coin at once. Both
         * live in the scene rather than in a script, and both are dropped on save unless the addon
         * writes them the way the editor does — so the assertion is made against the saved `.tscn`,
         * not against the answer or the script.
         */
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
                    const scene = readFileSync(join(bound, LEVEL_SCENE), 'utf8')
                    // A connection the save did not keep is the failure this step exists to catch:
                    // the editor shows it, the game never fires it.
                    if (!scene.includes('[connection signal="body_entered"')) return false
                    if (!scene.includes('groups=["coins"]')) return false
                    await openLevelInEditor()
                    return explorerShows(['Coin'])
                },
                'the level needs at least three Area2D coins carrying res://scripts/coin.gd, each '
                    + 'connected with godot_node connect_signal and put in the group "coins" with '
                    + 'godot_node add_to_group, and the scene saved afterwards.'
            )
        })

        /**
         * The wiring read back through the window a person uses, rather than off the disk.
         *
         * `node.inspect` is the only place the desktop reports what is connected to what, and it
         * reported nothing at all until the addon learned these commands.
         */
        it('shows the coin’s wiring in the inspector', async () => {
            await openLevelInEditor()
            await clickSelector(
                '//*[@aria-label="Explorer"]//*[starts-with(normalize-space(text()),"Coin")]',
                'a coin in the scene tree'
            )
            await openInspector()
            await clickTab('Node')
            await expectText(['coins', 'body_entered →'], {limitMs: 60_000})
            await closeInspector()
        })

        it('follows the player with a camera and shows the score', async () => {
            await askUntil(
                'Two last things. Give the Player a Camera2D child so the view follows it down '
                    + 'the level. Then add a CanvasLayer named HUD holding a Label that shows how '
                    + 'many coins have been collected, and make the coin script keep the count and '
                    + 'update that Label. Save the scene.',
                async () => {
                    const scene = readFileSync(join(bound, LEVEL_SCENE), 'utf8')
                    if (!scene.includes('Camera2D') || !scene.includes('CanvasLayer')) return false
                    await openLevelInEditor()
                    return explorerShows(['HUD'])
                },
                'the Player still needs a Camera2D child, and the level a CanvasLayer named HUD '
                    + 'with a Label the coin script updates.'
            )
        })

        /**
         * The way a game is actually built: one scene, placed more than once.
         *
         * Everything above this is a level made of one-off nodes, which is the only kind Gofer
         * could author while `node.create` reached `ClassDB` and nothing else. What is asserted is
         * that the placements are *instances* — a copy writes the enemy's own children into the
         * level, and then an edit to the enemy reaches none of them.
         */
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
                    if ((scene.match(/instance=ExtResource\(/gu)?.length ?? 0) < 3) return false
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
                () =>
                    Promise.resolve(
                        readFileSync(join(bound, 'project.godot'), 'utf8').includes(
                            LEVEL_SCENE_RESOURCE
                        )
                    ),
                `project.godot must name ${LEVEL_SCENE_RESOURCE} as application/run/main_scene.`
            )
            // The inspector reads the setting from the running editor, not from the file.
            await openInspector()
            await clickTab('Project')
            await fillLabelledInput('Search project settings', 'main_scene')
            await expectText([LEVEL_SCENE_RESOURCE], {limitMs: 60_000})
            await closeInspector()
        })

        /**
         * Every script the agent wrote, as the language server reads it.
         *
         * A GDScript that does not parse stops the scene using it from loading, and the game then
         * never starts — which arrives as `runtime_timeout` three steps later, saying nothing about
         * the script. That is how a `PoolVector2Array()` — the Godot 3 name — reached a level and
         * cost a whole sweep. The server has the answer the moment the file is written, so it is
         * asked before anything is run.
         */
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
                // Opening is what makes the server read the file; a path it never saw publishes
                // nothing and would pass by saying nothing at all.
                await invokeCommand('open_script_document', {request: {path}})
                const answer = await invokeCommand<ScriptDiagnosticsAnswer>(
                    'call_script_language',
                    {
                        request: {op: 'diagnostics', path, timeoutMs: 20_000}
                    }
                )
                // 1 is Error in the language-server protocol; a warning is the model's style, not
                // a level that will not load.
                for (const diagnostic of answer.diagnostics)
                    if (diagnostic.severity === 1) broken.push(`${path}: ${diagnostic.message}`)
            }
            expect(broken).toEqual([])
        })

        it('runs the level the agent built and draws a frame of it', async () => {
            await clickTab('Game')
            await clickButton('Run')
            await expectSelector('img[alt*="running game"]', 180_000)
            await expectText(['Game · 640×360'], {limitMs: 60_000})
        })

        it('shows the level’s own nodes in the running game', async () => {
            await clickTab('Runtime')
            await expectInExplorer(['Level1', 'Player'], 120_000)
        })

        /**
         * The level is a game, not a picture of one.
         *
         * Every assertion above this reads a file or a tree: the nodes exist, the shapes are real,
         * the wiring is saved. None of them says the thing can be *played*. This one holds the
         * agent's own movement key down and watches the player the agent wrote move under the
         * script the agent wrote, driven by the Input Map the agent registered — the whole chain,
         * end to end, with the harness reading the position rather than the model reporting it.
         */
        it('plays the level: the player moves when its own key is held', async () => {
            const player = await runningNodePath('Player')
            // The key is read back from the Input Map the agent wrote rather than assumed: which
            // key it chose is its business, and reading it also says `list_input_actions` reports
            // what `set_input_action` stored.
            const moveRight = await boundKey('move_right')
            const positionOf = async () => {
                const inspected = await godotCall<RuntimeInspection>('runtime.inspect_node', {
                    path: player,
                    properties: ['position']
                })
                const value = inspected.properties?.['position']?.value
                if (!Array.isArray(value))
                    throw new Error(`the player reported no position: ${JSON.stringify(inspected)}`)
                return Number(value[0])
            }

            const before = await positionOf()
            // No `device`: a marked event reaches _input and matches no action at all, because an
            // Input Map binding carries the keyboard's own device. Unmarked is how a player plays.
            await godotCall('runtime.input', {
                events: [{kind: 'key', key: moveRight, pressed: true}]
            })
            try {
                // The key stays down between calls, so the game keeps moving while this waits on
                // the only thing that can end it: the player's own position.
                const deadline = Date.now() + 30_000
                for (;;) {
                    const now = await positionOf()
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
            await clickTab('Output')
            await clickControl('Errors')
            // Godot prints a script error for every frame a script fails on, so a player script
            // that actually runs is named by nothing here. The session's own log holds errors from
            // the broken script this sweep saved on purpose much earlier, so the search is narrowed
            // to the file the agent wrote.
            for (const script of ['mario.gd', 'coin.gd', 'goomba.gd']) {
                await fillLabelledInput('Filter output', script)
                await expectText(['No output'], {limitMs: 60_000})
            }
            await fillLabelledInput('Filter output', '')
            await clickControl('All')
        })

        it('stops the level again', async () => {
            await clickTab('Game')
            await clickControl('Stop')
            await expectText(['No frame captured'], {limitMs: 60_000})
        })
    })

    /**
     * One window, two tasks, one editor.
     *
     * A Godot session is pinned to the worktree it started in, and the active task is whatever the
     * sidebar last pointed at — nothing keeps the two together. Switching tasks with a session
     * running therefore leaves the panels reading one task's editor while every file tool, the
     * agent's included, writes into another's checkout. Nothing says so on screen, and the scene
     * that answers is a scene the user is not looking at.
     */
    describe('a session that belongs to another task', () => {
        /** The route the level was built on, returned to before the story continues. */
        let builtOn = ''

        it('does not answer with another task’s scene', async () => {
            builtOn = await currentRoute()
            await clickText('New task')
            await browser.waitUntil(async () => (await currentRoute()) !== builtOn, {
                timeout: 60_000,
                interval: 200,
                timeoutMsg: 'the window never moved to the new task'
            })

            // Asked of the backend rather than the screen, because what is wrong is not a
            // rendering: the editor answers for a checkout this task has nothing to do with, and
            // the agent's own file tools follow the task while its Godot tools follow the session.
            // Refusing is a correct answer here; naming Level1 is not.
            const answered = await godotCall<RuntimeTree>('scene.get_tree', {})
                .then(tree => tree.root?.name ?? '(no scene)')
                .catch((error: unknown) => `refused: ${String(error)}`)
            expect(answered).not.toBe('Level1')
        })

        after(async () => {
            // The story continues on the task the level was built in.
            if (builtOn === '') return
            await clickSelector(`a[href="${builtOn}"]`, 'the task the level was built in')
            await browser.waitUntil(async () => (await currentRoute()) === builtOn, {
                timeout: 60_000,
                interval: 200,
                timeoutMsg: `the window never returned to ${builtOn}`
            })
        })
    })

    describe('merging the task back', () => {
        it('merges the worktree the agent worked in into the project', async () => {
            await clickButton('Merge task')
            // The button is the state: a task whose branch has landed is not offered again.
            await expectGone(['Merge task'], {limitMs: 120_000})
        })

        it('leaves the level in the project the sweep was pointed at', () => {
            expect(git('rev-parse', 'HEAD')).not.toBe(seedCommit)
            expect(git('ls-tree', '--name-only', '-r', 'HEAD')).toContain(LEVEL_SCENE)
        })

        it('keeps Gofer’s own scaffolding out of the project it merged into', () => {
            // The addon is staged into the worktree while a session runs — its files are kept out
            // of Git by an exclude entry, and the two lines it adds to `project.godot` have to be
            // kept out of the merge as well. They belong to Gofer, not to the user's game.
            const project = readFileSync(join(workspace, 'project.godot'), 'utf8')
            expect(project).not.toContain('addons/gofer')
            expect(project).not.toContain('GoferRuntime')
            expect(existsSync(join(workspace, 'addons/gofer'))).toBe(false)
        })
    })

    describe('shutting the session down', () => {
        it('stops the editor and removes the staged addon', async () => {
            await clickButton('Stop session')
            await expectText(['Editor session stopped', 'Start session'], {limitMs: 60_000})
            expect(existsSync(join(bound, 'addons/gofer'))).toBe(false)
        })

        it('leaves the panels saying there is no session rather than failing', async () => {
            await clickTab('Scene')
            await expectText(['No editor session'], {limitMs: 30_000})
        })
    })

    describe('a workspace that is not a Godot project', () => {
        /**
         * Godot opens any directory as a project, inventing an empty one where there is none, so a
         * workspace that is not one would otherwise fail much later as a scene that will not load.
         * Gofer takes its workspace from the directory it was started in, which is not always the
         * one the user meant, so the refusal has to name the directory.
         */
        it('refuses the session by naming the directory and what to do about it', async () => {
            renameSync(join(bound, 'project.godot'), join(bound, 'project.godot.hidden'))
            try {
                await clickButton('Start session')
                await expectText(
                    // A task worktree is a linked checkout, so the refusal names the fix that
                    // belongs to one: pointing Gofer somewhere else would not help, because the
                    // directory is Gofer's own and it came off a commit without the project in it.
                    [
                        'contains no project.godot',
                        'Commit your project files in your project folder',
                        bound
                    ],
                    // The refusal is the outcome under test, so it must not end the wait early.
                    {allow: REFUSAL, limitMs: 60_000}
                )
            } finally {
                renameSync(join(bound, 'project.godot.hidden'), join(bound, 'project.godot'))
            }
        })

        it('leaves the session offline rather than half started', async () => {
            await expectText(['Start session', 'Editor session stopped'], {allow: REFUSAL})
        })
    })

    describe('what the renderer logged', () => {
        it('reported no unexpected errors along the way', async () => {
            const errors = await pageErrors()
            const unexpected = errors.filter(
                // A cancelled answer rejects its own request by design; that is the feature the
                // Stop control exists for, not a fault. So is the refusal above. A stale element
                // reference is this sweep clicking something the application has just remounted,
                // which is the driver talking about itself.
                // `NotAllowedError` is WebKit refusing the automation a permission the
                // application never asked a person for.
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
        // The workspace itself is put back by the runner's `onComplete`, which is the first moment
        // the application is no longer holding worktrees inside it.
    })
})

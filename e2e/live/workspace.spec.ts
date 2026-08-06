import {expect} from '@wdio/globals'
import {browser} from '@wdio/tauri-service'
import {execFileSync} from 'node:child_process'
import {existsSync, readFileSync, readdirSync, renameSync} from 'node:fs'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {
    buttonSelector,
    clickButton,
    clickControl,
    clickSelector,
    clickTab,
    clickText,
    count,
    expectElement,
    expectEnabled,
    expectGone,
    expectSelector,
    expectSessionState,
    expectText,
    fillInput,
    forgetSessionStates,
    installActivityProbe,
    invokeCommand,
    isNarrowLayout,
    KEYS,
    pageErrors,
    pageText,
    placeCaretAtStart,
    pressGlyphMargin,
    releaseModifiers,
    renderedLines,
    revealLine,
    sessionStates,
    shows,
    typeInEditor,
    untilText
} from './harness'

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
const workspace = process.env.GOFER_WORKSPACE_DIR ?? join(homedir(), 'hub/test-gd')
/** A line inside `_on_tick`, which the fixture's timer reaches about once a second. */
const BREAK_LINE = 19
/** A line no GDScript parser accepts, typed at the top of the file where the caret is put. */
const BROKEN_EDIT = '~\n'
/** The refusal a workspace without a project file has to produce, quoted from the backend. */
const REFUSAL = [
    'could not be started',
    'contains no project.godot',
    'is not a Godot project'
] as const

/** The worktree the editor bound to, remembered for the assertions that outlive the session. */
let bound = ''

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
async function sendChat(prompt: string) {
    await releaseModifiers()
    // An answer still streaming makes the composer refuse the next message outright, and the
    // refusal is silent: the placeholder is the only thing that says which state it is in.
    await expectText(['Ask anything'], {limitMs: 240_000})
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
    })

    describe('settings', () => {
        it('opens the settings page on the configured connection', async () => {
            await clickText('Settings')
            await expectText(['AI connection', 'Base URL', 'Model ID', 'API key'])
        })

        it('tests the connection and lists the server’s models', async () => {
            await clickButton('Test connection')
            await expectText(['AI connection works', 'Select server model'], {limitMs: 60_000})
        })

        it('offers the thinking levels the configured model supports', async () => {
            await clickSelector(
                '//button[starts-with(normalize-space(.), "Reasoning:")]',
                'the reasoning menu'
            )
            await expectSelector('[role="menuitem"]')
            await browser.keys('Escape')
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

    describe('the editor session', () => {
        it('starts the managed Godot editor', async () => {
            await forgetSessionStates()
            await clickButton('Start session')
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
            await fillInput('input[placeholder="Search project settings"]', 'main_scene')
            await expectText(['application/run/main_scene', 'res://scenes/main.tscn'], {
                limitMs: 30_000
            })
        })

        it('marks the settings that need a restart', async () => {
            await fillInput('input[placeholder="Search project settings"]', 'rendering_method')
            await expectText(['rendering/renderer/rendering_method', 'Restart'], {limitMs: 30_000})
        })

        it('searches the editor’s own settings', async () => {
            await clickTab('Editor')
            await fillInput('input[placeholder="Search editor settings"]', 'font_size')
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
            await fillInput('input[placeholder="Filter files"]', 'player')
            await expectText(['player.gd'], {absent: ['main.gd']})
            await fillInput('input[placeholder="Filter files"]', '')
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

        it('formats the open script through the bundled sidecar', async () => {
            await clickButton('Format')
            // The dialog reports what gdformat would write; an already-formatted buffer says so.
            await expectText(['Formatted with gdformat'], {limitMs: 30_000})
            await clickButton('Cancel')
            await expectGone(['Formatted with gdformat'])
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
            await clickButton('Step over')
            await expectText(['Stopped: step'], {limitMs: 60_000})
        })

        it('steps into a line', async () => {
            await clickButton('Step in')
            await expectText(['Stopped: '], {limitMs: 60_000})
        })

        it('continues to the next breakpoint', async () => {
            await clickButton('Continue')
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
            await pressBreakpointGutter()
            await browser.waitUntil(async () => (await count('.gofer-breakpoint')) === 0, {
                timeout: 15_000,
                interval: 100,
                timeoutMsg: 'pressing the gutter again left the breakpoint in place'
            })
        })

        it('resumes a game with nothing left to stop it', async () => {
            await clickTab('Debugger')
            await clickButton('Continue')
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
            await clickButton('Pause')
            await expectText(['Stopped: '], {limitMs: 60_000})
        })

        it('terminates the game', async () => {
            await clickButton('Terminate')
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
            await clickButton('Capture game')
            // A capture that fails replaces the picture with the reason it failed; one that
            // answers leaves a frame of the game's own size on screen.
            await expectText(['Game · 640×360'], {
                absent: ['The game frame could not be read'],
                limitMs: 60_000
            })
            await expectSelector('img[alt*="running game"]', 10_000)
        })

        it('restarts the game', async () => {
            await clickButton('Restart')
            await expectText(['Game · 640×360'], {
                absent: ['The game frame could not be read'],
                limitMs: 120_000
            })
            // The controls come back the moment the restart has finished with the editor.
            await expectEnabled('Stop', 120_000)
        })

        it('stops the game', async () => {
            await clickButton('Stop')
            await expectText(['No frame captured'], {limitMs: 60_000})
        })

        it('captures the editor viewport with no game running', async () => {
            await clickButton('Capture editor')
            await expectSelector('img[alt*="editor viewport"]', 60_000)
            await expectText(['Editor · '], {limitMs: 30_000})
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

        it('filters the output by text', async () => {
            await fillInput('input[placeholder="Filter output"]', 'live tick')
            await expectText(['live tick'], {absent: ['Godot Engine v4.7.1'], limitMs: 30_000})
            await fillInput('input[placeholder="Filter output"]', '')
        })

        it('searches the recorded output of every session', async () => {
            await clickControl('History')
            await fillInput('input[placeholder="Search recorded output"]', 'five ticks')
            await expectText(['Live test reached five ticks'], {limitMs: 60_000})
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

        it('opens the reasoning picker', async () => {
            await clickSelector(
                '//button[starts-with(normalize-space(.), "Reasoning:")]',
                'the reasoning menu'
            )
            await expectSelector('[role="menuitem"]')
            await browser.keys('Escape')
        })

        it('offers image attachment according to the model’s input support', async () => {
            await expectSelector('button[aria-label="Attach images"]')
        })

        it('answers with the configured model, using its Godot tools', async () => {
            await sendChat('List every node in the main scene using your Godot tools.')
            // The tool the agent reached for is named in the answer's own activity; the node names
            // it reports are also in the explorer, so they would prove nothing on their own.
            await expectText(['godot_scene'], {limitMs: 240_000})
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
                    ['contains no project.godot', 'Start Gofer from your project directory', bound],
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
        console.log(git('status', '--short') || '(clean)')
        if (existsSync(join(workspace, 'addons')))
            console.log(`addons/: ${readdirSync(join(workspace, 'addons')).join(', ')}`)
    })
})

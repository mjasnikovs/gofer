import {expect, test} from '@playwright/test'
import type {Page} from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

type VisualState =
    'first-run' | 'empty' | 'streaming' | 'settings' | 'error' | 'scripts' | 'inspector'

async function installDesktop(page: Page, state: VisualState) {
    await page.addInitScript(currentState => {
        const listeners = new Map<string, Set<(event: unknown) => void>>()
        // Channels register their receiver through Tauri's IPC internals, which the browser
        // fixture has to stand in for.
        let nextCallbackId = 1
        window.__TAURI_INTERNALS__ = {
            transformCallback: () => nextCallbackId++,
            unregisterCallback: () => undefined
        }
        const script = 'extends Node\n\n\nfunc _ready() -> void:\n\tprint("ready")\n'
        // Stand-ins for the editor's own class icons: one flat rounded square per class, so a
        // snapshot shows the tree drawing what the editor sent rather than a real theme's artwork.
        const FIXTURE_ICONS: Record<string, string> = {
            Node2D: 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQAgMAAABinRfyAAAADFBMVEUAAABam9Vam9Vam9VG6tLsAAAAA3RSTlMAKLP1Q4hCAAAAKUlEQVQI12NggAPG/f8cGNj//7/AwP3//wMG/v//P+AmwErAisHa4AAAKswhZ5Fmo6UAAAAASUVORK5CYII=',
            CharacterBody2D:
                'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQAgMAAABinRfyAAAADFBMVEUAAADVWlrVWlrVWlr8ciXIAAAAA3RSTlMAKLP1Q4hCAAAAKUlEQVQI12NggAPG/f8cGNj//7/AwP3//wMG/v//P+AmwErAisHa4AAAKswhZ5Fmo6UAAAAASUVORK5CYII=',
            Camera2D:
                'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQAgMAAABinRfyAAAADFBMVEUAAABa1X5a1X5a1X5tBuVgAAAAA3RSTlMAKLP1Q4hCAAAAKUlEQVQI12NggAPG/f8cGNj//7/AwP3//wMG/v//P+AmwErAisHa4AAAKswhZ5Fmo6UAAAAASUVORK5CYII='
        }
        const settings = {
            version: 1,
            ai: {
                connectionType: 'openai-compatible',
                name: 'Local AI',
                baseUrl: 'http://127.0.0.1:8080/v1',
                model: 'local-model',
                api: 'openai-completions',
                modelName: 'Gofer Local',
                contextWindow: 120_064,
                maxTokens: 8_192,
                reasoning: true,
                supportsReasoningEffort: true,
                thinkingLevels: [],
                input: ['text', 'image'],
                thinkingLevel: 'medium',
                maxRetries: 2,
                timeoutMs: 120_000
            }
        }
        // The approval prompt is still an event, and rightly so: it is a rare notification that
        // has nothing to do with one invocation. The fixture needs a way to raise one.
        const emit = (event: string, payload: unknown) => {
            for (const handler of listeners.get(event) ?? []) handler({event, payload})
        }
        /**
         * Puts one question with sketches on screen.
         *
         * The dialog is the hardest screen in this application to look at any other way: it only
         * appears while a real model is holding a real turn open, and every layout defect it has
         * shipped — a column sized by its own 1280-wide sketch, a badge pushing one column three
         * pixels down, a button below the fold — was invisible to jsdom and obvious here.
         */
        window.__GOFER_TEST_ASK__ = (sketches: number, design?: {revision: number}) => {
            const sketch = (accent: string, name: string) =>
                `<style>body{margin:0;width:1280px;height:720px;background:#0d1020;`
                + `font-family:monospace;color:#dbe4ff}`
                + `.p{position:absolute;top:180px;left:${name === 'Side Panel' ? '900px' : '440px'};`
                + `width:380px;padding:24px;border:2px solid ${accent};background:#141a35}`
                + `h1{color:${accent};font-size:34px;letter-spacing:6px;margin:0 0 20px}`
                + `b{display:block;padding:12px;margin:8px 0;border:1px solid ${accent}}</style>`
                + `<div class="p"><h1>PAUSED</h1><b>RESUME</b><b>OPTIONS</b><b>QUIT</b></div>`
            emit('ai-question-request', {
                questionId: 'question-1',
                question: 'Which pause menu layout do you prefer?',
                why: 'It decides the scene tree I build.',
                revision: design?.revision ?? 1,
                ...(design && {designSession: 'design-1'}),
                options: sketches === 0 ? ['Its own scene', 'Inside the HUD'] : ([] as string[]),
                sketches: [
                    {label: 'Centered Overlay', html: sketch('#4f8cff', 'Centered Overlay')},
                    {label: 'Side Panel', html: sketch('#ff4f7d', 'Side Panel')}
                ].slice(0, sketches)
            })
        }
        window.__GOFER_TEST_DESIGN__ = (sessionId: string, closing = false) => {
            emit(closing ? 'ai-design-closed' : 'ai-design-opened', {sessionId})
        }
        window.__GOFER_TEST_APPROVE__ = () => {
            emit('ai-approval-request', {
                approvalId: 'approval-1',
                tool: 'godot_project',
                calls: [
                    {
                        op: 'set_editor_setting',
                        reason: 'This changes an editor setting for every project on this machine.',
                        params: {setting: 'interface/editor/single_window_mode', value: true}
                    }
                ]
            })
        }
        window.__GOFER_TEST_DESKTOP__ = {
            isTauri: () => true,
            listen: async (event, handler) => {
                const handlers = listeners.get(event) ?? new Set()
                handlers.add(handler)
                listeners.set(event, handlers)
                return () => handlers.delete(handler)
            },
            invoke: async (command: string, arguments_: unknown) => {
                // The health gate stands in front of every screen below, so the fixture workspace
                // has to answer it before any of them can render.
                if (command === 'check_workspace_health')
                    return {
                        workspace: '/fixture/workspace',
                        workspaceSource: 'working-directory',
                        checks: [],
                        isReady: true
                    }
                if (command === 'initialize_rag') {
                    if (currentState === 'first-run') return new Promise(() => undefined)
                    if (currentState === 'error')
                        throw new Error('Fixture model cache is unavailable')
                    return undefined
                }
                if (command === 'list_project_tasks') return []
                if (command === 'get_godot_session') return undefined
                if (command === 'start_godot_session')
                    return {
                        state: 'ready',
                        rpcAddress: '127.0.0.1:7000',
                        lspPort: 6005,
                        dapPort: 6006,
                        godotVersion: '4.7.2.stable',
                        worktree: '/fixture/worktree'
                    }
                if (command === 'call_godot') {
                    const call = (arguments_ as {request?: {command?: string}} | undefined)?.request
                    if (call?.command === 'session.get_state')
                        return {
                            id: 'fixture',
                            result: {
                                state: 'ready',
                                scene: 'res://main.tscn',
                                revision: 3,
                                dirty: false,
                                canUndo: true,
                                canRedo: false
                            }
                        }
                    if (call?.command === 'scene.get_tree')
                        return {
                            id: 'fixture',
                            result: {
                                root: {
                                    name: 'Main',
                                    type: 'Node2D',
                                    path: 'Main',
                                    children: [
                                        {
                                            name: 'Player',
                                            type: 'CharacterBody2D',
                                            path: 'Main/Player',
                                            children: [
                                                {
                                                    name: 'CollisionShapeForThePlayerBody',
                                                    type: 'CollisionShape2D',
                                                    path: 'Main/Player/CollisionShapeForThePlayerBody',
                                                    children: [
                                                        {
                                                            name: 'DeeplyNestedMarkerNodeName',
                                                            type: 'Marker2D',
                                                            path: 'Main/Player/CollisionShapeForThePlayerBody/DeeplyNestedMarkerNodeName',
                                                            children: []
                                                        }
                                                    ]
                                                }
                                            ]
                                        },
                                        {
                                            name: 'Camera',
                                            type: 'Camera2D',
                                            path: 'Main/Camera',
                                            children: []
                                        }
                                    ]
                                }
                            }
                        }
                    if (call?.command === 'editor.get_class_icons') {
                        const classes =
                            (call as {params?: {classes?: string[]}}).params?.classes ?? []
                        const icons: Record<string, string> = {}
                        for (const name of classes) {
                            const icon = FIXTURE_ICONS[name]
                            if (icon) icons[name] = icon
                        }
                        return {id: 'fixture', result: {encoding: 'png-base64', icons}}
                    }
                    if (call?.command === 'node.inspect')
                        return {
                            id: 'fixture',
                            result: {
                                name: 'Player',
                                type: 'CharacterBody2D',
                                path: 'Main/Player',
                                groups: ['players']
                            }
                        }
                    return {id: 'fixture', result: {}}
                }
                if (command === 'read_godot_logs')
                    return {
                        entries: [
                            {
                                sequence: 1,
                                source: 'editor',
                                severity: 'info',
                                message: 'Godot Engine v4.7.2.stable',
                                timestamp: 1_800_000_000
                            }
                        ],
                        cursor: 1,
                        dropped: 0
                    }
                if (command === 'list_workspace_files')
                    return [
                        {path: 'scripts/player.gd', bytes: script.length},
                        {path: 'main.tscn', bytes: 220}
                    ]
                if (command === 'open_script_document')
                    return {
                        path: 'scripts/player.gd',
                        text: script,
                        hash: 'fixture-hash',
                        bytes: script.length,
                        version: 1
                    }
                if (command === 'format_gdscript')
                    return {
                        formatted: `${script}\n\nfunc _process(_delta: float) -> void:\n\tpass\n`,
                        changed: true
                    }
                if (command === 'call_script_language') {
                    const request = (arguments_ as {request?: {op?: string}} | undefined)?.request
                    if (request?.op === 'prepareRename')
                        return {op: 'prepareRename', placeholder: '_ready'}
                    if (request?.op === 'rename')
                        return {
                            op: 'rename',
                            files: [
                                {
                                    path: 'scripts/player.gd',
                                    originalText: script,
                                    updatedText: script.replace('_ready', 'on_ready')
                                }
                            ]
                        }
                    // Every other language operation falls through unanswered, as it did before
                    // the rename dialogs needed a fixture: the editor treats a missing answer as a
                    // server that has nothing to say, and inventing a shape for one breaks it.
                    return undefined
                }
                if (command === 'query_godot_docs')
                    return {
                        passages: [
                            {
                                chapter: 'CharacterBody2D',
                                order: 3,
                                score: 0.812_345,
                                text: 'Call move_and_slide() after setting velocity. The body resolves collisions against the tilemap and reports them through get_slide_collision().'
                            },
                            {
                                chapter: 'Physics introduction',
                                order: 1,
                                score: 0.703_915,
                                text: 'A CharacterBody2D is moved by code rather than by the physics engine, which is what makes it the right body for a player.'
                            }
                        ]
                    }
                if (command === 'load_chat') return {messages: [], agentMessages: []}
                if (command === 'load_settings') return {settings, hasApiKey: true}
                if (command === 'read_agent_prompt' || command === 'save_agent_prompt')
                    return {
                        prompt: 'You are Gofer, a capable local coding agent. Work autonomously toward the user’s goal.',
                        defaultPrompt:
                            'You are Gofer, a capable local coding agent. Work autonomously toward the user’s goal.'
                    }
                if (command === 'get_rag_cache_status')
                    return {path: '/fixture/cache', sizeBytes: 1_024, state: 'installed'}
                if (command === 'list_ai_models')
                    return [
                        {
                            id: 'local-model',
                            name: 'Gofer Local',
                            contextWindow: 120_064,
                            maxTokens: 8_192,
                            reasoning: true,
                            supportsReasoningEffort: true,
                            thinkingLevels: [],
                            input: ['text', 'image']
                        }
                    ]
                if (command === 'send_ai_message') {
                    if (!arguments_ || typeof arguments_ !== 'object' || !('request' in arguments_))
                        throw new Error('Missing fixture request')
                    if (!('stream' in arguments_)) throw new Error('Missing fixture stream channel')
                    const stream = arguments_.stream as {
                        onmessage: (payload: unknown) => void
                    }
                    const request = arguments_.request
                    if (!request || typeof request !== 'object' || !('requestId' in request))
                        throw new Error('Missing fixture request ID')
                    const requestId = request.requestId
                    if (typeof requestId !== 'number') throw new Error('Invalid fixture request ID')
                    /*
                     * A turn shaped the way the agent's turns are shaped: it says what it is about
                     * to do, does it, says what it found, does the next thing. The order is the
                     * point — a fixture that calls every tool first and speaks once at the end
                     * cannot tell a conversation that reads in order from one that does not.
                     */
                    const events = [
                        {
                            type: 'thinking-delta',
                            delta: 'The suite has to pass before the script is worth reading.'
                        },
                        {type: 'text-delta', delta: "I'll run the suite first.\n"},
                        {
                            type: 'tool-start',
                            id: 'tool-1',
                            name: 'bash',
                            target: 'npm test',
                            startedAt: 1_800_000_000_000
                        },
                        {
                            type: 'tool-update',
                            id: 'tool-1',
                            output: 'Running tests…'
                        },
                        {
                            type: 'tool-end',
                            id: 'tool-1',
                            output: 'All tests passed',
                            isError: false,
                            endedAt: 1_800_000_001_000
                        },
                        {
                            type: 'text-delta',
                            delta: '## Suite is green\n\nAll tests passed, so the change is safe.'
                        },
                        {type: 'text-delta', delta: ' Now the player script:\n'},
                        {
                            type: 'tool-start',
                            id: 'tool-2',
                            name: 'godot_script',
                            target: 'ls -la assets/tiles/ assets/mario/ assets/goomba/ assets/sprites/ assets/bg/',
                            startedAt: 1_800_000_001_000
                        },
                        {
                            type: 'tool-end',
                            id: 'tool-2',
                            output: 'extends CharacterBody2D',
                            isError: false,
                            endedAt: 1_800_000_002_000
                        },
                        /*
                         * The row the cut-off name was actually reported on: a delegated question,
                         * whose target is a paragraph flattened onto one line. `subagent` is short
                         * enough that losing four characters leaves `subage…`, which names no tool
                         * anyone can look up, while the same four characters off the target are
                         * invisible.
                         */
                        {
                            type: 'tool-start',
                            id: 'tool-3',
                            name: 'subagent',
                            target: 'Find every scene that instances the player and say which of them sets its collision layer',
                            startedAt: 1_800_000_002_000
                        },
                        {
                            type: 'tool-end',
                            id: 'tool-3',
                            output: 'Only main.tscn sets it, to layer 2.',
                            isError: false,
                            endedAt: 1_800_000_003_000
                        },
                        {type: 'text-delta', delta: 'Finished the requested change.'},
                        {
                            type: 'done',
                            text: 'Finished the requested change.',
                            thinking: '',
                            stopReason: 'stop',
                            model: 'local-model',
                            agentMessages: [],
                            usage: {
                                input: 24,
                                output: 8,
                                cacheRead: 0,
                                cacheWrite: 0,
                                reasoning: 0,
                                totalTokens: 32,
                                cost: {total: 0}
                            }
                        }
                    ]
                    /*
                     * A turn that never finishes, for the screens that only exist while one is
                     * running.
                     *
                     * The design card is the only thing in this application that has to survive a
                     * question being answered, and what keeps it alive is a live turn. Nothing else
                     * in the fixture can hold one open: every other turn here pushes its events and
                     * settles in the same tick.
                     */
                    if (window.__GOFER_TEST_HOLD_TURN__ === true) {
                        stream.onmessage({requestId, event: events[0]})
                        return new Promise(() => undefined)
                    }
                    for (const event of events) stream.onmessage({requestId, event})
                }
                return undefined
            }
        }
        Date.now = () => 1_800_000_000_000
    }, state)
}

const MONACO_DIFF_HOST = '[data-testid="script-diff-host"]'

/**
 * @param hasDiff whether the screen embeds Monaco's diff editor.
 *
 * Two concessions, both to the same third-party DOM and neither to Gofer's own markup. Monaco draws
 * its line numbers in a dimmed colour of its own choosing and gives its hidden edit context an empty
 * `aria-label`, so scanning inside it reports a hundred and fifty findings about an editor this
 * repository does not write. And its `lines-content` layer is sixteen million pixels square, which
 * is what axe walks up to when it looks for the background behind a button sitting *beside* the
 * diff — reporting the dialog's own Cancel as #171717 on the editor's near-black. Excluding the
 * host answers the first; the contrast rule has to come off for the second, and the same tokens are
 * measured on every other screen here.
 */
async function stableScreenshot(page: Page, name: string, hasDiff = false, hasSketch = false) {
    await page.addStyleTag({
        content:
            '*, *::before, *::after { animation: none !important; transition: none !important; }'
    })
    const builder = new AxeBuilder({page}).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    // A sketch is a sandboxed frame with no `allow-scripts`, so nothing can be injected into it to
    // be scanned — axe waits for a frame that will never answer. What is inside is the agent's
    // markup rather than this application's, and it is not ours to hold to WCAG.
    if (hasSketch) builder.exclude('iframe')
    const accessibility = await (
        hasDiff ?
            builder.exclude(MONACO_DIFF_HOST).disableRules(['color-contrast'])
        :   builder).analyze()
    expect(accessibility.violations).toEqual([])
    await expect(page).toHaveScreenshot(name, {
        animations: 'disabled',
        caret: 'hide',
        fullPage: true,
        maxDiffPixels: 200
    })
}

test('first-run preparation', async ({page}) => {
    await installDesktop(page, 'first-run')
    await page.goto('/')
    await expect(page.getByText('Preparing documentation models')).toBeVisible()
    await stableScreenshot(page, 'first-run-preparation.png')
})

test('empty workspace', async ({page}) => {
    await installDesktop(page, 'empty')
    await page.goto('/')
    await expect(page.getByRole('img', {name: 'Local AI connected'})).toBeVisible()
    await stableScreenshot(page, 'empty-workspace.png')
})

/**
 * The dialog that starts every task, which is the one screen a user cannot avoid.
 *
 * It is the plan: the four phases run against the ask before there is a first turn, so the ask has
 * to be taken here. Skipping is the other way out and it has to read as one — a real control, not a
 * second Cancel — because it is what a small, clear change goes through.
 */
test('new task dialog', async ({page}) => {
    await installDesktop(page, 'empty')
    await page.goto('/')
    await expect(page.getByRole('img', {name: 'Local AI connected'})).toBeVisible()

    await page.getByRole('link', {name: 'New task'}).click()
    // Scoped to the dialog: the workspace header behind it names an untitled task the same way.
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByText('Each task gets its own branch.')).toBeVisible()
    await expect(dialog.getByRole('button', {name: 'Plan it'})).toBeDisabled()
    await expect(dialog.getByRole('button', {name: 'Skip planning'})).toBeEnabled()
    await stableScreenshot(page, 'new-task-dialog.png')
})

/**
 * `@` names a file, the way every other coding agent lets one be named.
 *
 * The composer had no triggers at all, so the only way to point at a file was to remember its whole
 * path and type it. The menu is the feature, so it is driven rather than looked at: typing a few
 * characters out of the middle of a name has to find the file, and choosing it has to leave the
 * path in the message the agent is sent.
 */
test('names a worktree file from the composer with @ @interaction', async ({page}) => {
    await installDesktop(page, 'streaming')
    await page.goto('/')
    await expect(page.getByRole('img', {name: 'Local AI connected'})).toBeVisible()
    const composer = page.getByRole('combobox', {name: 'Message input'})
    await composer.click()
    // Characters out of the middle of `scripts/player.gd`, in order and not adjacent: a substring
    // filter finds nothing here, which is what the ranking exists for.
    await composer.pressSequentially('@plyr')
    const suggestion = page.getByText('player.gd', {exact: true})
    await expect(suggestion).toBeVisible()
    await suggestion.click()
    await expect(composer).toHaveText(/scripts\/player\.gd/u)
    await composer.press('Enter')
    // What the turn was actually sent, rather than what the composer drew.
    await expect(page.getByRole('log').getByText(/@scripts\/player\.gd/u)).toBeVisible()
})

test('streaming conversation with tool activity', async ({page}) => {
    await installDesktop(page, 'streaming')
    await page.goto('/')
    await expect(page.getByRole('img', {name: 'Local AI connected'})).toBeVisible()
    await page.getByRole('combobox', {name: 'Message input'}).fill('Run the tests')
    await page.getByRole('combobox', {name: 'Message input'}).press('Enter')
    await expect(page.getByText('Finished the requested change.')).toBeVisible()
    await expect(page.getByText('bash')).toBeVisible()
    /*
     * The turn reads top to bottom in the order it happened. Before this, every call in a turn was
     * collapsed into one badge above the reply, and a turn of eighty-eight calls said "88" over a
     * single paragraph of everything the agent had ever said — which is neither followable while it
     * runs nor readable after.
     */
    /*
     * A conversation is a column: it never scrolls sideways. One tool call with a long command in
     * its target used to drag the whole list wider than the panel, so every message in the chat sat
     * behind a horizontal scrollbar. The row's own ellipsis handles the long target once the column
     * stops growing to fit it.
     */
    const overflow = await page.getByRole('log').evaluate(log => {
        const viewport = log.parentElement
        return {scroll: viewport?.scrollWidth ?? 0, client: viewport?.clientWidth ?? 0}
    })
    expect(overflow.scroll, 'the conversation scrolls sideways').toBeLessThanOrEqual(
        overflow.client
    )

    const turn = await page.getByRole('log').innerText()
    const steps = [
        "I'll run the suite first.",
        'npm test',
        'Suite is green',
        'ls -la assets/tiles/',
        'Finished the requested change.'
    ]
    const positions = steps.map(step => turn.indexOf(step))
    expect(positions, `every step is on screen, in:\n${turn}`).not.toContain(-1)
    expect(positions, 'the turn does not read in the order it happened').toEqual(
        [...positions].sort((first, second) => first - second)
    )
    /*
     * The composer's footer, in the narrower of the two layouts it renders in. Held on one line it
     * did not fit the chat column and the reasoning control's chevron was cut in half by the
     * column's right edge — which the baseline recorded rather than caught, because a snapshot
     * agrees with whatever it was shown first. This is the measurement that would have caught it.
     */
    const reasoning = await page.getByRole('button', {name: /^Reasoning:/u}).boundingBox()
    const column = await page.getByRole('combobox', {name: 'Message input'}).boundingBox()
    expect(reasoning, 'the reasoning control is on screen').toBeTruthy()
    expect(
        (reasoning?.x ?? 0) + (reasoning?.width ?? 0),
        'the reasoning control runs past the right edge of the chat column'
    ).toBeLessThanOrEqual((column?.x ?? 0) + (column?.width ?? 0))
    /*
     * The tool's name survives a target too long for the row; only the target gives ground.
     *
     * `ChatToolCalls` shrinks the target ten times faster than the name, which is not the same as
     * shrinking it first: flexbox splits a deficit across every shrinkable item, so five pixels
     * came off the name too. Five pixels is nothing on an eighty-character path and a whole word on
     * an eight-character name — the reported row read `subage…`, and this very baseline used to
     * read `godot_scri…`. Measured rather than looked at, because the screenshot is what recorded
     * it for months.
     */
    for (const tool of ['godot_script', 'subagent']) {
        const name = page
            .locator('.astryx-chat-tool-calls span', {hasText: new RegExp(`^${tool}$`, 'u')})
            .first()
        await expect(name).toHaveText(tool)
        const clipped = await name.evaluate(span => span.scrollWidth - span.clientWidth)
        expect(clipped, `${tool} is drawn in full, not cut to an ellipsis`).toBe(0)
    }
    /*
     * And the label over a stretch of reasoning is a caption, not a heading.
     *
     * `ChatMessageBubble` draws `name` in a bare element that inherits its surroundings, so the
     * string `Reasoning` came out at body size: bigger than the thinking it labels, which is drawn
     * compact, and bigger than the tool names either side of it.
     */
    const sizes = await page.evaluate(() => {
        const label = [...document.querySelectorAll('[data-chat-name]')].find(
            element => element.textContent === 'Reasoning'
        )
        // The deepest element still holding the sentence: Markdown chooses its own tags, and an
        // ancestor's font size is not the one the sentence is drawn at.
        const reply = [...document.querySelectorAll('*')]
            .filter(element => element.textContent.startsWith('All tests passed'))
            .pop()
        const size = (element: Element | undefined) =>
            element ? Number.parseFloat(getComputedStyle(element).fontSize) : 0
        return {label: size(label?.firstElementChild ?? label), reply: size(reply)}
    })
    expect(sizes.label, 'the reasoning label is drawn').toBeGreaterThan(0)
    expect(sizes.reply, 'the reply body is drawn').toBeGreaterThan(0)
    expect(
        sizes.label,
        'the reasoning label must not outshout the reply it sits over'
    ).toBeLessThan(sizes.reply)
    await stableScreenshot(page, 'streaming-tool-activity.png')
})

test('script editor', async ({page}) => {
    await installDesktop(page, 'scripts')
    await page.goto('/')
    await expect(page.getByRole('img', {name: 'Local AI connected'})).toBeVisible()
    await page.getByRole('button', {name: 'Files'}).click()
    await page.getByText('player.gd').click()
    // Monaco renders its own DOM, so waiting for a line it tokenized proves the editor is live.
    await expect(page.locator('.monaco-editor').first()).toBeVisible()
    await expect(page.getByText('func _ready() -> void:')).toBeVisible()
    await stableScreenshot(page, 'script-editor.png')
})

/**
 * The row's own action, which only a real layout can prove.
 *
 * The button is drawn faint until its row is hovered, and it shares a row with a name that may be
 * longer than the column is wide — both of which a component test, with no layout and no pointer,
 * reports as passing however far off the panel the button has been pushed.
 */
test('raises the mention action on the row under the pointer @interaction', async ({page}) => {
    await installDesktop(page, 'inspector')
    await page.goto('/')
    await page
        .getByRole('navigation', {name: 'Explorer'})
        .getByRole('button', {name: 'Start Godot'})
        .click()
    // The deepest row with the longest name: the one a row-width mistake takes out of reach first.
    const action = page.getByRole('button', {
        name: 'Mention DeeplyNestedMarkerNodeName in the message'
    })
    // The strength lives on the slot around the button, not on the button, which is always opaque.
    const slot = action.locator('..')
    // The pointer is left wherever the last click put it, which is inside this very panel.
    await page.mouse.move(0, 0)
    // Absent, not merely invisible: a hidden button that still holds its width leaves a gap in
    // every row of the tree.
    await expect(slot).toHaveCSS('opacity', '0')
    await expect(slot).toHaveCSS('width', '0px')
    await page.getByText('DeeplyNestedMarkerNodeName').hover()
    await expect(slot).toHaveCSS('opacity', '1')
    await expect(slot).not.toHaveCSS('width', '0px')
    await expect(action).toBeVisible()
    // The drawing itself, not just the button around it: a Heroicon handed over without a size
    // renders at nothing in WebKit, which left this button present, hoverable and empty.
    const glyph = await action.locator('svg').boundingBox()
    expect(glyph?.width).toBeGreaterThan(8)
    const box = await action.boundingBox()
    const panel = await page.locator('.astryx-tree-list').boundingBox()
    expect(box && panel && box.x + box.width).toBeLessThanOrEqual(
        (panel?.x ?? 0) + (panel?.width ?? 0)
    )
})

test('inspector workspace', async ({page}) => {
    await installDesktop(page, 'inspector')
    await page.goto('/')
    await expect(page.getByRole('img', {name: 'Local AI connected'})).toBeVisible()
    // Both the explorer and the inspector offer to start one; this is the explorer's.
    await page
        .getByRole('navigation', {name: 'Explorer'})
        .getByRole('button', {name: 'Start Godot'})
        .click()
    // The name is its own element now, so `Player` alone also matches the collision shape below it.
    await page.getByText('Player', {exact: true}).click()
    await expect(
        page.getByRole('complementary', {name: 'Inspector'}).getByText('Main/Player')
    ).toBeVisible()
    await stableScreenshot(page, 'inspector-workspace.png')
})

/*
 * One shot per tab. Only the open tab is rendered, so a single screenshot would have covered the
 * connection form and nothing else — and each tab carries its own footer, which is the part most
 * likely to regress.
 */
/**
 * A question the agent asks with pictures, which is the screen this application is worst at.
 *
 * Two sketches side by side is the case every defect has been in: the columns have to be the same
 * size and start at the same height, each sketch has to be scaled rather than cut off by the column
 * edge, and the control that answers the question has to be on screen.
 */
test('question with two sketches', async ({page}) => {
    await installDesktop(page, 'streaming')
    await page.goto('/')
    await expect(page.getByRole('img', {name: 'Local AI connected'})).toBeVisible()
    await page.evaluate(() => window.__GOFER_TEST_ASK__?.(2))
    await expect(page.getByRole('button', {name: 'Choose Centered Overlay'})).toBeVisible()
    // Side by side means side by side. A label allowed to wrap, or a badge on one column only, put
    // the two sketches out of line — twice — and a screenshot alone never said by how much.
    const frames = await page.evaluate(() =>
        [...document.querySelectorAll('dialog[open] iframe')].map(frame => {
            const rect = frame.getBoundingClientRect()
            return {top: rect.top, width: rect.width, height: rect.height}
        })
    )
    expect(frames).toHaveLength(2)
    expect(Math.abs((frames[0]?.top ?? 0) - (frames[1]?.top ?? 0))).toBeLessThanOrEqual(1)
    expect(Math.abs((frames[0]?.width ?? 0) - (frames[1]?.width ?? 1))).toBeLessThanOrEqual(1)
    expect(Math.abs((frames[0]?.height ?? 0) - (frames[1]?.height ?? 1))).toBeLessThanOrEqual(1)
    await stableScreenshot(page, 'question-two-sketches.png', false, true)
})

test('question with one sketch', async ({page}) => {
    await installDesktop(page, 'streaming')
    await page.goto('/')
    await expect(page.getByRole('img', {name: 'Local AI connected'})).toBeVisible()
    await page.evaluate(() => window.__GOFER_TEST_ASK__?.(1))
    await expect(page.getByRole('button', {name: 'Choose Centered Overlay'})).toBeVisible()
    await stableScreenshot(page, 'question-one-sketch.png', false, true)
})

/**
 * The same question with no pictures, which is what most questions are.
 *
 * Here so that the small card cannot be broken by work on the large one — the two share a component
 * and every change to the sketch half has run through this code.
 */
test('question in words', async ({page}) => {
    await installDesktop(page, 'streaming')
    await page.goto('/')
    await expect(page.getByRole('img', {name: 'Local AI connected'})).toBeVisible()
    await page.evaluate(() => window.__GOFER_TEST_ASK__?.(0))
    await expect(page.getByRole('textbox', {name: /Your answer/u})).toBeVisible()
    await stableScreenshot(page, 'question-in-words.png')
})

/**
 * A sketch that has been chosen.
 *
 * Its own screenshot because the state had none, and what shipped was the chosen button *disabled* —
 * the answer the user had just given, drawn as the one thing they were not allowed to pick.
 */
test('a sketch chosen', async ({page}) => {
    await installDesktop(page, 'streaming')
    await page.goto('/')
    await expect(page.getByRole('img', {name: 'Local AI connected'})).toBeVisible()
    await page.evaluate(() => window.__GOFER_TEST_ASK__?.(2))
    await page.getByRole('button', {name: 'Choose Side Panel'}).click()
    await expect(page.getByRole('button', {name: 'Choose Side Panel'})).toBeEnabled()
    await expect(page.getByRole('button', {name: 'Answer'})).toBeEnabled()
    await stableScreenshot(page, 'question-chosen.png', false, true)
})

/**
 * A round of a design loop, which is the same card carrying two more controls.
 *
 * Worth its own screenshot because the footer is where it can go wrong: three buttons instead of
 * two, one of them the primary the loop exists to reach, and a badge in the header that has to sit
 * beside a long question rather than push it. None of that is visible to jsdom.
 */
test('a design round with two sketches', async ({page}) => {
    await installDesktop(page, 'streaming')
    await page.goto('/')
    await expect(page.getByRole('img', {name: 'Local AI connected'})).toBeVisible()
    await page.evaluate(() => window.__GOFER_TEST_ASK__?.(2, {revision: 3}))
    await expect(page.getByRole('button', {name: 'Complete and handoff'})).toBeVisible()
    // Which round this is, drawn. The prompt has carried it since the first build and the card threw
    // it away, so a layout the user had already commented on came back looking like a new question.
    await expect(page.getByText('Round 3')).toBeVisible()
    await page.getByRole('button', {name: 'Choose Side Panel'}).click()
    await expect(page.getByRole('button', {name: 'Complete and handoff'})).toBeEnabled()
    // The footer holds three controls now. On the shipped window they have to be on screen together,
    // which is the thing a count in a unit test cannot tell anybody.
    const footer = await page.evaluate(() => {
        const names = ['Complete and handoff', 'Send changes', 'Let the agent decide']
        return [...document.querySelectorAll('dialog[open] button')]
            .filter(button => names.includes(button.textContent.trim()))
            .map(button => {
                const rect = button.getBoundingClientRect()
                return {bottom: rect.bottom, text: button.textContent.trim()}
            })
    })
    expect(footer).toHaveLength(3)
    for (const button of footer)
        expect(button.bottom, `${button.text} is below the fold`).toBeLessThanOrEqual(
            page.viewportSize()?.height ?? 0
        )
    await stableScreenshot(page, 'question-design-round.png', false, true)
})

/**
 * Between rounds, which is the state this whole seam was built for.
 *
 * What shipped before was nothing at all here: the card closed on the answer, the window sat empty
 * for the minute the agent spent redrawing, and a new card opened looking like a new question. This
 * is the only screenshot of the thing that replaced it, and it is a real one — a live turn, a real
 * answer sent through the real hook, and the card that stayed.
 */
test('the card between two design rounds', async ({page}) => {
    await installDesktop(page, 'streaming')
    await page.goto('/')
    await expect(page.getByRole('img', {name: 'Local AI connected'})).toBeVisible()
    // A turn that does not finish. The card outlives an answer only while one is running.
    await page.evaluate(() => {
        window.__GOFER_TEST_HOLD_TURN__ = true
    })
    await page.getByRole('combobox', {name: 'Message input'}).fill('Design the pause menu')
    await page.getByRole('combobox', {name: 'Message input'}).press('Enter')
    await page.evaluate(() => window.__GOFER_TEST_DESIGN__?.('design-1'))
    await page.evaluate(() => window.__GOFER_TEST_ASK__?.(2, {revision: 2}))
    await page.getByRole('button', {name: 'Choose Side Panel'}).click()
    await page.getByRole('button', {name: 'Send changes'}).click()

    // The answer is gone and the card is not.
    await expect(page.getByText('Design in progress')).toBeVisible()
    await expect(page.getByText(/Round 2 sent/u)).toBeVisible()
    await expect(page.getByRole('button', {name: 'Choose Side Panel'})).toBeHidden()
    await stableScreenshot(page, 'question-design-redrawing.png')

    // And it goes when the loop does, rather than sitting over a design that already finished.
    await page.evaluate(() => window.__GOFER_TEST_DESIGN__?.('design-1', true))
    await expect(page.getByText('Design in progress')).toBeHidden()
})

/** The zoom: one sketch as large as the window allows, and one way out. */
test('a sketch zoomed', async ({page}) => {
    await installDesktop(page, 'streaming')
    await page.goto('/')
    await expect(page.getByRole('img', {name: 'Local AI connected'})).toBeVisible()
    await page.evaluate(() => window.__GOFER_TEST_ASK__?.(2))
    await page.getByRole('button', {name: 'Open Side Panel'}).click()
    await expect(page.getByRole('button', {name: 'Close'})).toBeVisible()
    await stableScreenshot(page, 'question-zoomed.png', false, true)
})

test('settings dialog', async ({page}) => {
    await installDesktop(page, 'settings')
    await page.goto('/#/settings')
    await expect(page.getByRole('heading', {name: 'Settings'})).toBeVisible()
    await expect(page.getByRole('heading', {name: 'AI connection'})).toBeVisible()
    await stableScreenshot(page, 'settings-ai.png')

    const tabs = page.getByRole('navigation', {name: 'Settings sections'})

    await tabs.getByRole('button', {name: 'Agent prompt'}).click()
    await expect(page.getByRole('button', {name: 'Save prompt'})).toBeVisible()
    await stableScreenshot(page, 'settings-prompt.png')

    await tabs.getByRole('button', {name: 'Documentation models'}).click()
    await expect(page.getByText('Installed')).toBeVisible()
    await stableScreenshot(page, 'settings-models.png')

    await tabs.getByRole('button', {name: 'Project storage'}).click()
    await expect(page.getByRole('button', {name: 'Back up project'})).toBeVisible()
    await stableScreenshot(page, 'settings-storage.png')
})

test('initialization error', async ({page}) => {
    await installDesktop(page, 'error')
    await page.goto('/')
    await expect(page.getByText('Models could not be initialized')).toBeVisible()
    await stableScreenshot(page, 'error-state.png')
})

/** Every screen below needs a live editor session before it has anything to draw. */
async function openSession(page: Page) {
    await installDesktop(page, 'inspector')
    await page.goto('/')
    await expect(page.getByRole('img', {name: 'Local AI connected'})).toBeVisible()
    await page
        .getByRole('navigation', {name: 'Explorer'})
        .getByRole('button', {
            name: 'Start Godot'
        })
        .click()
}

/**
 * A toolbar that runs past the panel it sits in.
 *
 * The bottom panel is a fraction of a 1280 px window and both of these rows hold every action their
 * view has; a snapshot shows the clipping but cannot say which button crossed the edge, and a
 * component test has no layout to clip against. This reads the geometry the browser resolved.
 */
async function expectToolbarFits(page: Page, region: string, lastAction: string) {
    const panel = await page.getByRole('toolbar', {name: region}).boundingBox()
    const button = await page.getByRole('button', {name: lastAction}).boundingBox()
    expect(panel, `the ${region} toolbar is on screen`).toBeTruthy()
    expect(button, `${lastAction} is on screen`).toBeTruthy()
    expect(
        (button?.x ?? 0) + (button?.width ?? 0),
        `${lastAction} runs past the right edge of the ${region} toolbar`
    ).toBeLessThanOrEqual((panel?.x ?? 0) + (panel?.width ?? 0))
}

test('debugger tab', async ({page}) => {
    await openSession(page)
    await page.getByRole('button', {name: 'Debugger', exact: true}).click()
    await expect(page.getByText('Not running', {exact: true})).toBeVisible()
    await expectToolbarFits(page, 'Debugger controls', 'Terminate')
    await stableScreenshot(page, 'debugger-tab.png')
})

test('output tab', async ({page}) => {
    await openSession(page)
    await page.getByRole('button', {name: 'Output', exact: true}).click()
    await expect(page.getByText('Godot Engine v4.7.2.stable')).toBeVisible()
    await stableScreenshot(page, 'output-tab.png')
})

test('import tab', async ({page}) => {
    await openSession(page)
    await page.getByRole('button', {name: 'Import', exact: true}).click()
    await expect(page.getByRole('button', {name: 'Rescan project'})).toBeVisible()
    await stableScreenshot(page, 'import-tab.png')
})

test('game tab', async ({page}) => {
    await openSession(page)
    await page.getByRole('button', {name: 'Game', exact: true}).click()
    await expect(page.getByText('No frame captured')).toBeVisible()
    await expectToolbarFits(page, 'Game controls', 'Capture editor')
    await stableScreenshot(page, 'game-tab.png')
})

test('docs tab', async ({page}) => {
    await openSession(page)
    await page.getByRole('button', {name: 'Docs', exact: true}).click()
    await page.getByRole('textbox', {name: 'Ask the Godot documentation'}).fill('move a body')
    await page.getByRole('button', {name: 'Search'}).click()
    await expect(page.getByText('move_and_slide')).toBeVisible()
    await stableScreenshot(page, 'docs-tab.png')
})

test('tool approval dialog', async ({page}) => {
    await installDesktop(page, 'inspector')
    await page.goto('/')
    await expect(page.getByRole('img', {name: 'Local AI connected'})).toBeVisible()
    await page.evaluate(() => {
        window.__GOFER_TEST_APPROVE__?.()
    })
    await expect(page.getByRole('button', {name: 'Approve'})).toBeVisible()
    await stableScreenshot(page, 'tool-approval-dialog.png')
})

test('format preview dialog', async ({page}) => {
    await installDesktop(page, 'scripts')
    await page.goto('/')
    await expect(page.getByRole('img', {name: 'Local AI connected'})).toBeVisible()
    await page.getByRole('button', {name: 'Files'}).click()
    await page.getByText('player.gd').click()
    await expect(page.getByText('func _ready() -> void:')).toBeVisible()
    await page.getByRole('button', {name: 'Format'}).click()
    await expect(page.getByRole('button', {name: 'Apply to buffer'})).toBeVisible()
    await stableScreenshot(page, 'format-preview-dialog.png', true)
})

test('rename dialogs', async ({page}) => {
    await installDesktop(page, 'scripts')
    await page.goto('/')
    await expect(page.getByRole('img', {name: 'Local AI connected'})).toBeVisible()
    await page.getByRole('button', {name: 'Files'}).click()
    await page.getByText('player.gd').click()
    // The rename gesture is F2 inside the editor, so the caret has to be in it first.
    await page.getByText('func _ready() -> void:').click()
    await page.keyboard.press('F2')
    await expect(page.getByRole('button', {name: 'Preview rename'})).toBeVisible()
    await stableScreenshot(page, 'rename-dialog.png')

    await page.getByRole('textbox', {name: 'New name'}).fill('on_ready')
    await page.getByRole('button', {name: 'Preview rename'}).click()
    await expect(page.getByRole('button', {name: 'Apply rename'})).toBeVisible()
    await stableScreenshot(page, 'rename-preview-dialog.png', true)
})

/** A flat grey picture, so any coloured pixel in the canvas can only be a stroke that was drawn. */
const GREY_PNG =
    'iVBORw0KGgoAAAANSUhEUgAAAPAAAACMCAIAAADN17N/AAACGUlEQVR4nO3OQQkAMQADsOoce5x/FWeiUBiBCEjO/eAZmQ+gKPMBFGU+gKLMB1CU+QCKMh9AUeYDKMp8AEWZD6Ao8wEUZT6AoswHUJT5AIoyH0BR5gMoynwARZkPoCjzARRlPoCizAdQlPkAijIfQFHmAyjKfABFmQ+gKPMBFGU+gKLMB1CU+QCKMh9AUeYDKMp8AEWZD6Ao8wEUZT6AoswHUJT5AIoyH0BR5gMoynwARZkPoCjzARRlPoCizAdQlPkAijIfQFHmAyjKfABFmQ+gKPMBFGU+gKLMB1CU+QCKMh9AUeYDKMp8AEWZD6Ao8wEUZT6AoswHUJT5AIoyH0BR5gMoynwARZkPoCjzARRlPoCizAdQlPkAijIfQFHmAyjKfABFmQ+gKPMBFGU+gKLMB1CU+QCKMh9AUeYDKMp8AEWZD6Ao8wEUZT6AoswHUJT5AIoyH0BR5gMoynwARZkPoCjzARRlPoCizAdQlPkAijIfQFHmAyjKfABFmQ+gKPMBFGU+gKLMB1CU+QCKMh9AUeYDKMp8AEWZD6Ao8wEUZT6AoswHUJT5AIoyH0BR5gMoynwARZkPoCjzARRlPoCizAdQlPkAijIfQFHmAyjKfABFmQ+gKPMBFGU+gKLMB1CU+QCKMh9AUeYDKMp8AEWZD6Ao8wEUZT6AoswHUJT5AIoyH0BR5gMoynwARZkPoCjzARRlPoCiH+eSj9PnhQ95AAAAAElFTkSuQmCC'

/** Pixels the ink is on, counted in the canvas the dialog draws. Grey art scores zero. */
async function redPixels(page: Page) {
    return page.getByRole('img', {name: /Drawing surface/u}).evaluate(element => {
        const canvas = element as HTMLCanvasElement
        const ctx = canvas.getContext('2d')
        if (!ctx) return 0
        const {data} = ctx.getImageData(0, 0, canvas.width, canvas.height)
        let count = 0
        for (let at = 0; at < data.length; at += 4) {
            const [red, green, blue] = [data[at] ?? 0, data[at + 1] ?? 0, data[at + 2] ?? 0]
            if (red > 180 && green < 90 && blue < 90) count += 1
        }
        return count
    })
}

async function attachGreyImage(page: Page) {
    await page.locator('input[type="file"]').setInputFiles({
        name: 'shot.png',
        mimeType: 'image/png',
        buffer: Buffer.from(GREY_PNG, 'base64')
    })
    return page.getByRole('button', {name: /^Open shot\.png/u})
}

/**
 * Drawing on an attached screenshot, and finding the drawing still there on the way back in.
 *
 * The whole point of the scratchpad is that a picture is faster than a paragraph, and the whole
 * risk is that saving burns the strokes into the pixels and the next edit starts from nothing. So
 * this draws, saves, reopens, and counts the ink: the picture underneath is flat grey, so a red
 * pixel on the second visit can only have come from the shapes being kept and painted again.
 */
test('draws on an attachment and keeps the strokes after saving @interaction', async ({page}) => {
    await installDesktop(page, 'empty')
    await page.goto('/')
    await expect(page.getByRole('img', {name: 'Local AI connected'})).toBeVisible()

    const thumbnail = await attachGreyImage(page)
    await expect(thumbnail).toBeVisible()
    const before = await thumbnail.locator('img').getAttribute('src')

    await thumbnail.click()
    const canvas = page.getByRole('img', {name: /Drawing surface/u})
    await expect(canvas).toBeVisible()
    expect(await redPixels(page)).toBe(0)

    const box = await canvas.boundingBox()
    if (!box) throw new Error('The drawing surface has no box to draw in')
    await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.3)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.6, {steps: 8})
    await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.3, {steps: 8})
    await page.mouse.up()
    expect(await redPixels(page)).toBeGreaterThan(0)
    await stableScreenshot(page, 'image-scratchpad.png')

    await page.getByRole('button', {name: 'Save'}).click()
    await expect(canvas).toBeHidden()
    // The flattened picture is what the model would be sent, so the thumbnail has to be it.
    await expect(thumbnail.locator('img')).not.toHaveAttribute('src', before ?? '')

    await thumbnail.click()
    await expect(canvas).toBeVisible()
    expect(await redPixels(page)).toBeGreaterThan(0)
})

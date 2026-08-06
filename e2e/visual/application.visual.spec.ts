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
                input: ['text', 'image'],
                thinkingLevel: 'medium',
                maxRetries: 2,
                timeoutMs: 120_000,
                systemPrompt: ''
            }
        }
        const emit = (event: string, payload: unknown) => {
            for (const handler of listeners.get(event) ?? []) handler({event, payload})
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
                        godotVersion: '4.7.1.stable',
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
                                message: 'Godot Engine v4.7.1.stable',
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
                if (command === 'load_chat') return {messages: [], agentMessages: []}
                if (command === 'load_settings') return {settings, hasApiKey: true}
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
                            input: ['text', 'image']
                        }
                    ]
                if (command === 'send_ai_message') {
                    if (!arguments_ || typeof arguments_ !== 'object' || !('request' in arguments_))
                        throw new Error('Missing fixture request')
                    const request = arguments_.request
                    if (!request || typeof request !== 'object' || !('requestId' in request))
                        throw new Error('Missing fixture request ID')
                    const requestId = request.requestId
                    if (typeof requestId !== 'number') throw new Error('Invalid fixture request ID')
                    const events = [
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
                    for (const event of events) emit('ai-stream-event', {requestId, event})
                }
                return undefined
            }
        }
        Date.now = () => 1_800_000_000_000
    }, state)
}

async function stableScreenshot(page: Page, name: string) {
    await page.addStyleTag({
        content:
            '*, *::before, *::after { animation: none !important; transition: none !important; }'
    })
    const accessibility = await new AxeBuilder({page})
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze()
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
    await expect(page.getByText('Local AI connected')).toBeVisible()
    await stableScreenshot(page, 'empty-workspace.png')
})

test('streaming conversation with tool activity', async ({page}) => {
    await installDesktop(page, 'streaming')
    await page.goto('/')
    await expect(page.getByText('Local AI connected')).toBeVisible()
    await page.getByRole('textbox').fill('Run the tests')
    await page.getByRole('textbox').press('Enter')
    await expect(page.getByText('Finished the requested change.')).toBeVisible()
    await expect(page.getByText('bash')).toBeVisible()
    await stableScreenshot(page, 'streaming-tool-activity.png')
})

test('script editor', async ({page}) => {
    await installDesktop(page, 'scripts')
    await page.goto('/')
    await expect(page.getByText('Local AI connected')).toBeVisible()
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
test('raises the mention action on the row under the pointer', async ({page}) => {
    await installDesktop(page, 'inspector')
    await page.goto('/')
    await page.getByRole('button', {name: 'Start editor session'}).click()
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
    await expect(page.getByText('Local AI connected')).toBeVisible()
    await page.getByRole('button', {name: 'Start editor session'}).click()
    // The name is its own element now, so `Player` alone also matches the collision shape below it.
    await page.getByText('Player', {exact: true}).click()
    await expect(
        page.getByRole('complementary', {name: 'Inspector'}).getByText('Main/Player')
    ).toBeVisible()
    await stableScreenshot(page, 'inspector-workspace.png')
})

test('settings dialog', async ({page}) => {
    await installDesktop(page, 'settings')
    await page.goto('/#/settings')
    await expect(page.getByRole('heading', {name: 'Settings'})).toBeVisible()
    await expect(page.getByText('Installed')).toBeVisible()
    await stableScreenshot(page, 'settings-dialog.png')
})

test('initialization error', async ({page}) => {
    await installDesktop(page, 'error')
    await page.goto('/')
    await expect(page.getByText('Models could not be initialized')).toBeVisible()
    await stableScreenshot(page, 'error-state.png')
})

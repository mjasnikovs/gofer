import {expect, test} from '@playwright/test'
import type {Page} from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

type VisualState = 'first-run' | 'empty' | 'streaming' | 'settings' | 'error' | 'scripts'

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
                if (command === 'initialize_rag') {
                    if (currentState === 'first-run') return new Promise(() => undefined)
                    if (currentState === 'error')
                        throw new Error('Fixture model cache is unavailable')
                    return undefined
                }
                if (command === 'list_project_tasks') return []
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
    await page.getByRole('button', {name: 'Scripts'}).click()
    await page.getByText('scripts/player.gd').click()
    // Monaco renders its own DOM, so waiting for a line it tokenized proves the editor is live.
    await expect(page.locator('.monaco-editor').first()).toBeVisible()
    await expect(page.getByText('func _ready() -> void:')).toBeVisible()
    await stableScreenshot(page, 'script-editor.png')
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

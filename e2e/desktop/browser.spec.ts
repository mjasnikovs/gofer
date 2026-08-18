import {expect} from '@wdio/globals'
import {browser} from '@wdio/tauri-service'

describe('renderer desktop journey', () => {
    it('boots through mocked Tauri IPC and renders an empty workspace', async () => {
        await browser.execute(() => {
            const tauriWindow = window as Window & {isTauri?: boolean}
            tauriWindow.isTauri = true
        })
        const initialize = await browser.tauri.mock('initialize_rag')
        await initialize.mockResolvedValue(undefined)
        const listTasks = await browser.tauri.mock('list_project_tasks')
        await listTasks.mockResolvedValue([])
        const loadChat = await browser.tauri.mock('load_chat')
        await loadChat.mockResolvedValue({messages: [], agentMessages: []})
        const saveChat = await browser.tauri.mock('save_chat')
        await saveChat.mockResolvedValue(undefined)
        const loadSettings = await browser.tauri.mock('load_settings')
        await loadSettings.mockResolvedValue({
            settings: {
                version: 1,
                ai: {
                    connectionType: 'openai-compatible',
                    name: 'Local AI',
                    baseUrl: 'http://127.0.0.1:8080/v1',
                    model: 'fixture',
                    api: 'openai-completions',
                    modelName: 'Fixture',
                    contextWindow: 8_192,
                    maxTokens: 1_024,
                    reasoning: false,
                    supportsReasoningEffort: false,
                    input: ['text'],
                    thinkingLevel: 'off',
                    maxRetries: 0,
                    timeoutMs: 5_000
                }
            },
            hasApiKey: true
        })

        await browser.$('button=Try again').click()
        await expect(browser.$('body')).toHaveText(expect.stringContaining('Gofer is ready'))
        await initialize.update()
        expect(initialize).toHaveBeenCalledTimes(1)
    })
})

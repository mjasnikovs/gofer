import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {
    createProjectBackup,
    deleteRagCache,
    initializeRag,
    listAiModels,
    loadSettings,
    readAgentPrompt,
    readCacheStatus,
    runStorageMaintenance,
    saveAgentPrompt,
    saveSettings,
    testAiConnection
} from './settings-store'
import {normalizeSettings} from '../models/settings'
import type {SettingsRequest} from '../models/settings'
import {createDesktopFake, installDesktopFake, removeDesktopFake} from '../test/desktop-driver'

const tauri = createDesktopFake()

const request: SettingsRequest = {
    settings: normalizeSettings({
        version: 1,
        ai: {
            connectionType: 'openai-compatible',
            name: 'Local AI',
            baseUrl: 'http://127.0.0.1:8080/v1',
            model: 'local-model',
            api: 'openai-completions'
        }
    } as unknown as SettingsRequest['settings']),
    apiKey: {action: 'keep'}
}

beforeEach(() => {
    installDesktopFake(tauri)
    tauri.invoke.mockResolvedValue(undefined)
})

afterEach(() => {
    removeDesktopFake()
})

/*
 * One-line wrappers, so what is checked is the command each one names and the payload it wraps it
 * in. The settings page calls these by name and never writes a command string of its own.
 */
describe('settings commands', () => {
    it('reads the stored settings and the agent prompt without a payload', async () => {
        tauri.invoke.mockResolvedValue({settings: request.settings, hasApiKey: true})
        await expect(loadSettings()).resolves.toMatchObject({hasApiKey: true})

        tauri.invoke.mockResolvedValue({prompt: 'You are Gofer.', defaultPrompt: 'You are Gofer.'})
        await expect(readAgentPrompt()).resolves.toMatchObject({prompt: 'You are Gofer.'})

        expect(tauri.invoke).toHaveBeenCalledWith('load_settings', undefined)
        expect(tauri.invoke).toHaveBeenCalledWith('read_agent_prompt', undefined)
    })

    it('sends the whole settings request to each command that needs one', async () => {
        await saveSettings(request)
        await testAiConnection(request)
        await listAiModels(request)

        expect(tauri.invoke).toHaveBeenCalledWith('save_settings', {request})
        expect(tauri.invoke).toHaveBeenCalledWith('test_ai_connection', {request})
        expect(tauri.invoke).toHaveBeenCalledWith('list_ai_models', {request})
    })

    it('sends the prompt text on its own', async () => {
        await saveAgentPrompt('Be brief.')

        expect(tauri.invoke).toHaveBeenCalledWith('save_agent_prompt', {prompt: 'Be brief.'})
    })

    it('drives the model cache and the storage tools', async () => {
        tauri.invoke.mockResolvedValue({path: '/tmp/gofer-rag', sizeBytes: 42, state: 'incomplete'})
        await expect(readCacheStatus()).resolves.toMatchObject({state: 'incomplete'})

        tauri.invoke.mockResolvedValue(undefined)
        await initializeRag()
        await deleteRagCache()
        await createProjectBackup()
        await runStorageMaintenance()

        expect(tauri.invoke).toHaveBeenCalledWith('get_rag_cache_status', undefined)
        expect(tauri.invoke).toHaveBeenCalledWith('initialize_rag', undefined)
        expect(tauri.invoke).toHaveBeenCalledWith('delete_rag_cache', undefined)
        expect(tauri.invoke).toHaveBeenCalledWith('create_project_backup', undefined)
        expect(tauri.invoke).toHaveBeenCalledWith('run_storage_maintenance', undefined)
    })

    it('lets a rejected save reach the page that has to report it', async () => {
        tauri.invoke.mockRejectedValue(new Error('credential store is locked'))

        await expect(saveSettings(request)).rejects.toThrow('credential store is locked')
    })
})

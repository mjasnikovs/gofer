import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {cleanup, render, screen, waitFor} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {InitializationSplash, SettingsPage, Workspace} from './App'

type InvokeFunction = (command: string, args?: unknown) => Promise<unknown>
type IsTauriFunction = () => boolean
type EventHandler = (event: {payload: never}) => void
type ListenFunction = (event?: string, handler?: EventHandler) => Promise<() => void>

const tauri = vi.hoisted(() => ({
    invoke: vi.fn<InvokeFunction>(),
    isTauri: vi.fn<IsTauriFunction>(),
    listen: vi.fn<ListenFunction>()
}))

vi.mock('@tauri-apps/api/core', () => ({invoke: tauri.invoke, isTauri: tauri.isTauri}))
vi.mock('@tauri-apps/api/event', () => ({listen: tauri.listen}))

const settingsResponse = {
    settings: {
        version: 1,
        ai: {
            connectionType: 'openai-compatible',
            name: 'Local AI',
            baseUrl: 'http://127.0.0.1:8080/v1',
            model: 'local-model',
            api: 'openai-completions'
        }
    },
    hasApiKey: true
} as const

const incompleteCache = {
    path: '/tmp/gofer-rag',
    sizeBytes: 42,
    state: 'incomplete'
} as const

beforeEach(() => {
    tauri.isTauri.mockReturnValue(true)
    tauri.listen.mockResolvedValue(vi.fn())
})

afterEach(() => {
    cleanup()
    vi.clearAllMocks()
})

describe('InitializationSplash', () => {
    it('explains that model initialization requires the desktop app', async () => {
        tauri.isTauri.mockReturnValue(false)

        render(<InitializationSplash onReady={vi.fn()} />)

        expect(await screen.findByText('Models could not be initialized')).toBeInTheDocument()
        expect(
            screen.getByText(/Model initialization requires the desktop app/)
        ).toBeInTheDocument()
        expect(tauri.invoke).not.toHaveBeenCalled()
    })

    it('subscribes before initialization, cleans up, and signals readiness', async () => {
        const calls: string[] = []
        const unlisten = vi.fn()
        const onReady = vi.fn()
        tauri.listen.mockImplementation(async () => {
            calls.push('listen')
            return unlisten
        })
        tauri.invoke.mockImplementation(async () => {
            calls.push('invoke')
        })

        render(<InitializationSplash onReady={onReady} />)

        await waitFor(() => {
            expect(onReady).toHaveBeenCalledOnce()
        })
        expect(calls).toEqual(['listen', 'invoke'])
        expect(unlisten).toHaveBeenCalledOnce()
    })

    it('shows listener registration failures and allows retrying', async () => {
        tauri.listen.mockRejectedValueOnce(new Error('event system unavailable'))
        tauri.invoke.mockResolvedValue(undefined)
        const onReady = vi.fn()

        render(<InitializationSplash onReady={onReady} />)

        expect(await screen.findByText(/event system unavailable/)).toBeInTheDocument()
        await userEvent.click(screen.getByRole('button', {name: 'Try again'}))
        await waitFor(() => {
            expect(onReady).toHaveBeenCalledOnce()
        })
    })
})

describe('SettingsPage', () => {
    function loadSettings() {
        tauri.invoke.mockImplementation(async (command: string) => {
            if (command === 'load_settings') return settingsResponse
            if (command === 'get_rag_cache_status') return incompleteCache
            if (command === 'test_ai_connection') {
                return {status: 'connected', message: 'Connected.'}
            }
            return undefined
        })
    }

    it('loads settings and sends keep, set, and clear API-key intents', async () => {
        loadSettings()
        render(<SettingsPage onCacheDeleted={vi.fn()} />)
        const user = userEvent.setup()

        expect(await screen.findByDisplayValue('Local AI')).toBeInTheDocument()
        await user.click(screen.getByRole('button', {name: 'Test connection'}))
        expect(tauri.invoke.mock.lastCall?.[0]).toBe('test_ai_connection')
        expect(tauri.invoke.mock.lastCall?.[1]).toMatchObject({request: {apiKey: {action: 'keep'}}})

        await user.type(screen.getByPlaceholderText('Stored securely'), ' new-secret ')
        await user.click(screen.getByRole('button', {name: 'Test connection'}))
        expect(tauri.invoke.mock.lastCall?.[1]).toMatchObject({
            request: {apiKey: {action: 'set', value: ' new-secret '}}
        })

        await user.click(screen.getByRole('button', {name: 'Remove stored API key'}))
        await user.click(screen.getByRole('button', {name: 'Test connection'}))
        expect(tauri.invoke.mock.lastCall?.[1]).toMatchObject({
            request: {apiKey: {action: 'clear'}}
        })
    })

    it('reports model listener failures and restores the cache state', async () => {
        loadSettings()
        render(<SettingsPage onCacheDeleted={vi.fn()} />)
        const user = userEvent.setup()

        await screen.findByDisplayValue('Local AI')
        tauri.listen.mockRejectedValueOnce(new Error('listener unavailable'))
        await user.click(screen.getByRole('button', {name: 'Download models'}))

        expect(await screen.findByText(/listener unavailable/)).toBeInTheDocument()
        expect(screen.getByText('Incomplete')).toBeInTheDocument()
    })
})

describe('Workspace', () => {
    it('streams a Pi AI response into the assistant message', async () => {
        let handler: EventHandler | undefined
        tauri.listen.mockImplementation(async (_event, nextHandler) => {
            handler = nextHandler
            return () => undefined
        })
        tauri.invoke.mockImplementation(async command => {
            if (command === 'send_ai_message') {
                handler?.({
                    payload: {
                        requestId: 1,
                        event: {type: 'text-delta', delta: 'Hello from local AI'}
                    } as never
                })
            }
            return undefined
        })
        render(<Workspace />)

        await userEvent.type(screen.getByRole('textbox'), 'Say hello{enter}')

        expect(await screen.findByText('Hello from local AI')).toBeInTheDocument()
        expect(tauri.invoke).toHaveBeenCalledWith('send_ai_message', {
            request: {
                requestId: 1,
                messages: [expect.objectContaining({sender: 'user', text: 'Say hello'})]
            }
        })
    })
})

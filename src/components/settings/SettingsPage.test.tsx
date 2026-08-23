import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {act, cleanup, render, screen} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {SettingsPage} from './SettingsPage'
import {createDesktopFake, installDesktopFake, removeDesktopFake} from '../../test/desktop-driver'
import {flush} from '../../test/flush'
import {immediateScheduler, setScheduler, timerScheduler} from '../../services/clock'
import type {SettingsRequest, SettingsResponse} from '../../models/settings'
import {SETTINGS, installBackend} from '../../test/backend'
import type {Backend, BackendAnswers} from '../../test/backend'
import type {DesktopCommand} from '../../services/desktop'

const tauri = createDesktopFake()

const settingsResponse: SettingsResponse = {
    ...SETTINGS,
    settings: {
        ...SETTINGS.settings,
        ai: {
            ...SETTINGS.settings.ai,
            connections: {
                ...SETTINGS.settings.ai.connections,
                // Sent with every settings response, because what a ChatGPT connection is belongs
                // to the backend. Without it this page has no second driver to offer.
                'openai-codex': {
                    name: 'ChatGPT subscription',
                    baseUrl: 'https://chatgpt.com/backend-api',
                    api: 'openai-codex-responses',
                    chatTemplateThinking: false,
                    model: {
                        id: 'gpt-5.6-terra',
                        name: 'GPT-5.6 Terra',
                        contextWindow: 272_000,
                        maxTokens: 128_000,
                        reasoning: true,
                        supportsReasoningEffort: true,
                        thinkingLevels: [],
                        input: ['text', 'image'],
                        thinkingLevel: 'high'
                    }
                }
            }
        }
    }
}

const shippedPrompt = 'You are Gofer, a capable local coding agent.'

const installedCache = {path: '/tmp/gofer-rag', sizeBytes: 1024 ** 3, state: 'installed'} as const
const missingCache = {path: '/tmp/gofer-rag', sizeBytes: 0, state: 'not-installed'} as const

/** The models a server answers `/models` with, as the page offers them for selection. */
const serverModels = [
    {
        id: 'qwen3-coder',
        name: 'Qwen3 Coder',
        contextWindow: 262_144,
        maxTokens: 32_768,
        reasoning: true,
        supportsReasoningEffort: true,
        thinkingLevels: [],
        input: ['text']
    }
]

/**
 * The shared backend, holding this page's settings, with per-command answers on top.
 *
 * Most overrides are values, because that is all a page test usually needs: what one command
 * answers, or the failure it raises. `handlers` is for the two that need the command held open
 * while the window is read. Keying either by `DesktopCommand` is what makes a renamed command fail
 * typecheck here rather than quietly stop being overridden.
 */
let server: Backend
function answer(
    overrides: Partial<Record<DesktopCommand, unknown>> = {},
    handlers: BackendAnswers = {}
) {
    const answers: BackendAnswers = {}
    for (const command of Object.keys(overrides) as DesktopCommand[]) {
        const value = overrides[command]
        answers[command] = () => {
            if (value instanceof Error) throw value
            return value
        }
    }
    Object.assign(answers, handlers)
    server = installBackend(tauri, {
        settings: settingsResponse,
        agentPrompt: {prompt: shippedPrompt, defaultPrompt: shippedPrompt},
        cache: installedCache,
        answers
    })
    return server
}

/**
 * Brings one tab's controls on screen. Only that tab's fields, buttons and banner are rendered, so
 * every assertion below that is not about the connection has to say which tab it is about first.
 */
async function openTab(label: string) {
    // A button, not a `tab`: Astryx's TabList is a `<nav>` of buttons rather than an ARIA tablist.
    await userEvent.click(screen.getByRole('button', {name: label}))
    await flush()
}

/** Mounts the page with the settings loaded, which is where every interaction below starts. */
async function open() {
    render(
        <SettingsPage
            isOpen
            onOpenChange={vi.fn()}
            onCacheDeleted={vi.fn()}
        />
    )
    await flush()
    expect(screen.getByDisplayValue('Local AI')).toBeInTheDocument()
}

const savedRequest = () =>
    (
        tauri.invoke.mock.calls.filter(call => call[0] === 'save_settings').at(-1)?.[1] as
            {request: SettingsRequest} | undefined
    )?.request

beforeEach(() => {
    setScheduler(immediateScheduler)
    installDesktopFake(tauri)
    answer()
})

afterEach(() => {
    cleanup()
    removeDesktopFake()
    setScheduler(timerScheduler)
    vi.clearAllMocks()
})

describe('the AI connection form', () => {
    it('switches between independently configured local and ChatGPT drivers', async () => {
        answer({list_ai_models: serverModels})
        const user = userEvent.setup()
        await open()

        await user.click(screen.getByRole('combobox', {name: 'AI driver'}))
        await user.click(screen.getByRole('option', {name: 'ChatGPT subscription'}))
        await flush()

        expect(screen.getByText('Not signed in')).toBeInTheDocument()
        expect(screen.getByRole('button', {name: 'Sign in with ChatGPT'})).toBeInTheDocument()
        expect(screen.getByRole('combobox', {name: 'ChatGPT model'})).toBeInTheDocument()
        expect(screen.queryByLabelText(/Base URL/)).not.toBeInTheDocument()
        await user.click(screen.getByRole('button', {name: 'Save AI settings'}))
        await flush()
        expect(savedRequest()?.settings.ai).toMatchObject({
            connectionType: 'openai-codex',
            connections: {'openai-codex': {model: {id: 'qwen3-coder'}}}
        })

        await user.click(screen.getByRole('combobox', {name: 'AI driver'}))
        await user.click(screen.getByRole('option', {name: 'Local model'}))
        await flush()

        expect(screen.getByLabelText(/Model ID/)).toHaveValue('local-model')
    })

    it('saves every field the user edited', async () => {
        const user = userEvent.setup()
        await open()

        await user.clear(screen.getByLabelText(/Connection name/))
        await user.type(screen.getByLabelText(/Connection name/), 'Studio box')
        await user.clear(screen.getByLabelText(/Base URL/))
        await user.type(screen.getByLabelText(/Base URL/), 'https://ai.example.com/v1')
        await user.clear(screen.getByLabelText(/Model ID/))
        await user.type(screen.getByLabelText(/Model ID/), 'big-model')
        await user.clear(screen.getByLabelText(/Context window/))
        await user.type(screen.getByLabelText(/Context window/), '32768')
        await user.clear(screen.getByLabelText(/Maximum output tokens/))
        await user.type(screen.getByLabelText(/Maximum output tokens/), '4096')
        await user.clear(screen.getByLabelText(/Request timeout/))
        await user.type(screen.getByLabelText(/Request timeout/), '90000')
        await user.clear(screen.getByLabelText(/Automatic retries/))
        await user.type(screen.getByLabelText(/Automatic retries/), '5')
        await flush()
        await user.click(screen.getByRole('button', {name: 'Save AI settings'}))
        await flush()

        // Read back out of the backend rather than out of the call that went to it: what a save
        // means is that the next read answers with what was sent.
        expect(server.state.settings.settings.ai).toMatchObject({
            connections: {
                'openai-compatible': {
                    name: 'Studio box',
                    baseUrl: 'https://ai.example.com/v1',
                    model: {id: 'big-model', contextWindow: 32_768, maxTokens: 4096}
                }
            },
            timeoutMs: 90_000,
            maxRetries: 5
        })
    })

    it('reports a save the backend refused', async () => {
        answer({save_settings: new Error('credential store is locked')})
        await open()

        await userEvent.click(screen.getByRole('button', {name: 'Save AI settings'}))
        await flush()

        expect(screen.getByText('Settings could not be saved')).toBeInTheDocument()
        expect(screen.getByText(/credential store is locked/)).toBeInTheDocument()
    })

    /*
     * The models list is what a server actually offers, so it arrives from the connection test
     * rather than from a field the user types. Choosing one fills in the numbers that come with it.
     */
    it('offers the server models a successful test found, and adopts the one chosen', async () => {
        answer({
            test_ai_connection: {status: 'connected', message: 'Connected.'},
            list_ai_models: serverModels
        })
        const user = userEvent.setup()
        await open()

        await user.click(screen.getByRole('button', {name: 'Test connection'}))
        await flush()
        expect(screen.getByText('AI connection works')).toBeInTheDocument()

        await user.click(screen.getByRole('combobox', {name: 'Available server models'}))
        await user.click(screen.getByRole('option', {name: /Qwen3 Coder/}))
        await flush()

        expect(screen.getByLabelText(/Model ID/)).toHaveValue('qwen3-coder')
        expect(screen.getByLabelText(/Context window/)).toHaveValue('262144')
    })

    it('offers the reasoning levels a reasoning model supports', async () => {
        answer({
            test_ai_connection: {status: 'model-unavailable', message: 'Model is not loaded.'},
            list_ai_models: serverModels
        })
        const user = userEvent.setup()
        await open()

        await user.click(screen.getByRole('button', {name: 'Test connection'}))
        await flush()
        expect(screen.getByText('Configured model is unavailable')).toBeInTheDocument()
        await user.click(screen.getByRole('combobox', {name: 'Available server models'}))
        await user.click(screen.getByRole('option', {name: /Qwen3 Coder/}))
        await flush()

        await user.click(screen.getByRole('button', {name: 'Reasoning: off'}))
        await user.click(screen.getByRole('menuitem', {name: 'high'}))
        await flush()

        expect(screen.getByRole('button', {name: 'Reasoning: high'})).toBeInTheDocument()
    })

    it('gives the sub-agent a model of its own without touching the main one', async () => {
        answer({list_ai_models: serverModels})
        const user = userEvent.setup()
        await open()

        // Nothing to choose until the child is told which connection answers it.
        expect(
            screen.queryByRole('combobox', {name: 'Model the sub-agent answers with'})
        ).not.toBeInTheDocument()

        await user.click(screen.getByRole('combobox', {name: 'Sub-agent model'}))
        await user.click(screen.getByRole('option', {name: 'Local model'}))
        await flush()

        await user.click(screen.getByRole('combobox', {name: 'Model the sub-agent answers with'}))
        await user.click(screen.getByRole('option', {name: 'Qwen3 Coder'}))
        await flush()

        await user.click(screen.getByRole('button', {name: 'Save AI settings'}))
        await flush()

        expect(savedRequest()?.settings.ai.subagent.connection).toMatchObject({
            connectionType: 'openai-compatible',
            model: {id: 'qwen3-coder', contextWindow: 262_144}
        })
        // The main agent is where it was. That separation is the whole feature.
        expect(savedRequest()?.settings.ai.connections['openai-compatible']?.model.id).toBe(
            'local-model'
        )
    })

    it('reports a connection test that never reached the server', async () => {
        answer({test_ai_connection: new Error('connect ECONNREFUSED 127.0.0.1:8080')})
        await open()

        await userEvent.click(screen.getByRole('button', {name: 'Test connection'}))
        await flush()

        expect(screen.getByText('Connection test failed')).toBeInTheDocument()
        expect(screen.getByText(/ECONNREFUSED/)).toBeInTheDocument()
    })

    it('lets a dismissable notice be dismissed', async () => {
        answer({test_ai_connection: {status: 'connected', message: 'Connected.'}})
        const user = userEvent.setup()
        await open()

        await user.click(screen.getByRole('button', {name: 'Test connection'}))
        await flush()
        expect(screen.getByText('AI connection works')).toBeInTheDocument()

        await user.click(screen.getByRole('button', {name: /Dismiss/}))
        await flush()

        expect(screen.queryByText('AI connection works')).not.toBeInTheDocument()
    })
})

describe('the agent prompt', () => {
    it('stores an edited prompt with the project and restores the shipped one', async () => {
        const user = userEvent.setup()
        answer({save_agent_prompt: {prompt: 'Be brief.', defaultPrompt: shippedPrompt}})
        await open()
        await openTab('Agent prompt')

        expect(screen.getByText(/This is the prompt Gofer ships/)).toBeInTheDocument()
        expect(screen.getByRole('button', {name: 'Restore default'})).toBeDisabled()

        await user.type(screen.getByLabelText(/System prompt/), ' Be brief.')
        await flush()
        expect(screen.getByText(/Edited for this project/)).toBeInTheDocument()
        await user.click(screen.getByRole('button', {name: 'Save prompt'}))
        await flush()

        expect(tauri.invoke).toHaveBeenCalledWith('save_agent_prompt', {
            prompt: `${shippedPrompt} Be brief.`
        })
        expect(screen.getByText('Agent prompt saved')).toBeInTheDocument()

        await user.click(screen.getByRole('button', {name: 'Restore default'}))
        await flush()

        expect(screen.getByLabelText(/System prompt/)).toHaveValue(shippedPrompt)
        expect(screen.getByRole('button', {name: 'Restore default'})).toBeDisabled()
    })

    /*
     * Its own tab, its own Save, and its own store. Saving the connection must not reach the
     * prompt at all now, whether the prompt was touched or not.
     */
    it('is untouched by a save on the connection tab', async () => {
        const user = userEvent.setup()
        await open()
        await openTab('Agent prompt')
        await user.type(screen.getByLabelText(/System prompt/), ' Be brief.')
        await flush()

        await openTab('AI connection')
        await user.click(screen.getByRole('button', {name: 'Save AI settings'}))
        await flush()

        expect(tauri.invoke).not.toHaveBeenCalledWith('save_agent_prompt', expect.anything())
    })

    it('offers nothing to save until the prompt is edited', async () => {
        await open()
        await openTab('Agent prompt')

        expect(screen.getByRole('button', {name: 'Save prompt'})).toBeDisabled()
    })

    it('reports a prompt save the backend refused', async () => {
        const user = userEvent.setup()
        answer({save_agent_prompt: new Error('the project is read-only')})
        await open()
        await openTab('Agent prompt')

        await user.type(screen.getByLabelText(/System prompt/), ' Be brief.')
        await flush()
        await user.click(screen.getByRole('button', {name: 'Save prompt'}))
        await flush()

        expect(screen.getByText('Agent prompt could not be saved')).toBeInTheDocument()
        expect(screen.getByText(/read-only/)).toBeInTheDocument()
    })
})

describe('the Godot rules', () => {
    const savedGodot = () =>
        (
            tauri.invoke.mock.calls
                .filter(call => call[0] === 'save_godot_settings')
                .at(-1)?.[1] as {godot: Record<string, boolean>} | undefined
        )?.godot

    // The stored settings this suite loads say nothing about Godot, which is what a file written
    // before the tab existed looks like. Both boxes must still come up ticked.
    it('enforces both rules by default', async () => {
        await open()
        await openTab('Godot rules')

        expect(screen.getByLabelText(/Enforce strict typing/)).toBeChecked()
        expect(screen.getByLabelText(/Enforce game window inline/)).toBeChecked()
    })

    it('stores a rule the moment it is unticked, and leaves the other one alone', async () => {
        const user = userEvent.setup()
        await open()
        await openTab('Godot rules')

        await user.click(screen.getByLabelText(/Enforce strict typing/))
        await flush()

        expect(savedGodot()).toEqual({strictTyping: false, embedGameWindow: true})
        expect(screen.getByLabelText(/Enforce strict typing/)).not.toBeChecked()
        expect(screen.getByLabelText(/Enforce game window inline/)).toBeChecked()
    })

    /*
     * The tab has no Save of its own, so a rule ticked here must not carry another tab's draft with
     * it. This is the whole reason the command takes the rules rather than the page's settings.
     */
    it('never sends a connection edit left open on another tab', async () => {
        const user = userEvent.setup()
        await open()
        await user.clear(screen.getByLabelText(/Connection name/))
        await user.type(screen.getByLabelText(/Connection name/), 'Half typed')
        await flush()

        await openTab('Godot rules')
        await user.click(screen.getByLabelText(/Enforce game window inline/))
        await flush()

        expect(tauri.invoke).not.toHaveBeenCalledWith('save_settings', expect.anything())
        expect(savedGodot()).toEqual({strictTyping: true, embedGameWindow: false})
    })

    it('puts the tick back when the write fails, and says why', async () => {
        const user = userEvent.setup()
        answer({save_godot_settings: new Error('the settings file is read-only')})
        await open()
        await openTab('Godot rules')

        await user.click(screen.getByLabelText(/Enforce strict typing/))
        await flush()

        expect(screen.getByText('Godot rules could not be saved')).toBeInTheDocument()
        expect(screen.getByText(/read-only/)).toBeInTheDocument()
        expect(screen.getByLabelText(/Enforce strict typing/)).toBeChecked()
    })
})

describe('the documentation model cache', () => {
    it('shows where the cache is and how much disk it uses', async () => {
        await open()
        await openTab('Documentation models')

        expect(screen.getByText('/tmp/gofer-rag')).toBeInTheDocument()
        expect(screen.getByText('1.00 GiB')).toBeInTheDocument()
        // Nothing to download when the cache is already installed.
        expect(screen.queryByRole('button', {name: 'Download models'})).not.toBeInTheDocument()
    })

    // The download subscribes before it starts and unsubscribes whatever happens, because the
    // progress events are the only sign of life during a 1.68 GiB fetch.
    it('subscribes to the download progress, installs the models, and unsubscribes', async () => {
        const unlisten = vi.fn()
        let report: ((payload: unknown) => void) | undefined
        tauri.listen.mockImplementation(async (event, handler) => {
            if (event === 'rag-download-progress') {
                report = payload => {
                    handler({payload: payload as never})
                }
            }
            return unlisten
        })
        answer(
            {get_rag_cache_status: missingCache},
            {
                initialize_rag: () => {
                    // As the backend does it: the progress arrives while the command is still
                    // running.
                    report?.({model: 'bge-m3', status: 'progress', loaded: 1024, total: 2048})
                    return undefined
                }
            }
        )
        await open()
        await openTab('Documentation models')

        await userEvent.click(screen.getByRole('button', {name: 'Download models'}))
        await flush()

        expect(report, 'the download started without a progress listener').toBeDefined()
        expect(screen.getByText('Documentation models installed')).toBeInTheDocument()
        expect(unlisten).toHaveBeenCalledOnce()
    })

    /*
     * A 1.68 GiB download shows what it is doing while it does it. `Button` runs `clickAction`
     * inside a transition, and React holds the old screen until a transition settles — so a
     * download this page awaited from the button painted nothing at all until it had finished.
     */
    it('shows the progress while the download is still running', async () => {
        answer({get_rag_cache_status: missingCache})
        let report: ((payload: unknown) => void) | undefined
        tauri.listen.mockImplementation(async (event, handler) => {
            if (event === 'rag-download-progress') {
                report = payload => {
                    handler({payload: payload as never})
                }
            }
            return () => undefined
        })
        let finishDownload: (() => void) | undefined
        answer(
            {get_rag_cache_status: missingCache},
            {
                initialize_rag: () =>
                    new Promise<undefined>(resolve => {
                        finishDownload = () => {
                            resolve(undefined)
                        }
                    })
            }
        )
        await open()
        await openTab('Documentation models')

        await userEvent.click(screen.getByRole('button', {name: 'Download models'}))
        await flush()
        await act(async () => {
            report?.({model: 'bge-m3', status: 'progress', loaded: 1024, total: 2048})
        })

        // The cache is in flux until the backend says otherwise, and the bar names the file.
        expect(screen.getByText('Busy')).toBeInTheDocument()
        expect(screen.getAllByText('bge-m3: 1 KiB of 2 KiB').length).toBeGreaterThan(0)

        await act(async () => {
            finishDownload?.()
        })
        await flush()

        expect(screen.getByText('Documentation models installed')).toBeInTheDocument()
    })

    it('reports a download that failed and leaves the cache state on screen', async () => {
        answer({get_rag_cache_status: missingCache, initialize_rag: new Error('disk is full')})
        await open()
        await openTab('Documentation models')

        await userEvent.click(screen.getByRole('button', {name: 'Download models'}))
        await flush()

        expect(screen.getByText('Models could not be installed')).toBeInTheDocument()
        expect(screen.getByText(/disk is full/)).toBeInTheDocument()
        expect(screen.getByText('Not installed')).toBeInTheDocument()
    })

    it('asks before deleting the cache, then tells the shell to prepare again', async () => {
        const onCacheDeleted = vi.fn()
        answer({delete_rag_cache: missingCache})
        render(
            <SettingsPage
                isOpen
                onOpenChange={vi.fn()}
                onCacheDeleted={onCacheDeleted}
            />
        )
        await flush()
        await openTab('Documentation models')

        await userEvent.click(screen.getByRole('button', {name: 'Delete model cache'}))
        await flush()
        // The warning takes over from the settings dialog rather than stacking on it: the form
        // behind it is hidden, and the only reachable buttons are the two the warning offers.
        expect(screen.getByRole('button', {name: 'Cancel'})).toBeInTheDocument()
        expect(screen.queryByRole('button', {name: 'AI connection'})).not.toBeInTheDocument()

        await userEvent.click(screen.getByRole('button', {name: 'Delete model cache'}))
        await flush()

        expect(tauri.invoke).toHaveBeenCalledWith('delete_rag_cache', undefined)
        expect(onCacheDeleted).toHaveBeenCalledOnce()
    })

    it('reports a cache deletion the backend refused', async () => {
        answer({delete_rag_cache: new Error('a model file is still open')})
        await open()
        await openTab('Documentation models')

        await userEvent.click(screen.getByRole('button', {name: 'Delete model cache'}))
        await flush()
        await userEvent.click(screen.getByRole('button', {name: 'Delete model cache'}))
        await flush()

        expect(screen.getByText('Model cache could not be deleted')).toBeInTheDocument()
        expect(screen.getByText(/still open/)).toBeInTheDocument()
    })
})

describe('project storage', () => {
    it('names the backup it wrote', async () => {
        answer({create_project_backup: {path: '/home/dev/game/.gofer/backups/2026-08-08.db'}})
        await open()
        await openTab('Project storage')

        await userEvent.click(screen.getByRole('button', {name: 'Back up project'}))
        await flush()

        expect(screen.getByText('Project backup created')).toBeInTheDocument()
        expect(screen.getByText('/home/dev/game/.gofer/backups/2026-08-08.db')).toBeInTheDocument()
    })

    it('reports a backup that failed', async () => {
        answer({create_project_backup: new Error('no space left on device')})
        await open()
        await openTab('Project storage')

        await userEvent.click(screen.getByRole('button', {name: 'Back up project'}))
        await flush()

        expect(screen.getByText('Backup failed')).toBeInTheDocument()
    })

    it('counts what the storage cleanup removed', async () => {
        answer({
            run_storage_maintenance: {
                attachmentsRemoved: 3,
                blobsRemoved: 4,
                godotRunsRemoved: 5,
                sketchesRemoved: 6,
                docsAnswersRemoved: 7,
                memoryVectorsRemoved: 8,
                backupsRemoved: 1,
                memoryEmbeddingsRestored: 2
            }
        })
        await open()
        await openTab('Project storage')

        await userEvent.click(screen.getByRole('button', {name: 'Clean storage'}))
        await flush()

        expect(screen.getByText('Storage maintenance complete')).toBeInTheDocument()
        expect(
            screen.getByText(
                '3 attachments, 4 blobs, 5 old Godot runs, 6 sketches, 7 stale manual answers, 8 orphaned memory vectors, and 1 old backups removed. 2 memory embeddings restored.'
            )
        ).toBeInTheDocument()
    })

    it('reports a cleanup that failed', async () => {
        answer({run_storage_maintenance: new Error('database is locked')})
        await open()
        await openTab('Project storage')

        await userEvent.click(screen.getByRole('button', {name: 'Clean storage'}))
        await flush()

        expect(screen.getByText('Storage cleanup failed')).toBeInTheDocument()
    })
})

describe('when the settings cannot be read at all', () => {
    it('says so rather than showing an empty form', async () => {
        answer({load_settings: new Error('settings.json is not readable')})
        render(
            <SettingsPage
                isOpen
                onOpenChange={vi.fn()}
                onCacheDeleted={vi.fn()}
            />
        )
        await flush()

        // The failure lands on the tab the dialog opens on. The other two say their own line in
        // place rather than leaving an empty tab behind.
        expect(screen.getByText('Settings could not be loaded')).toBeInTheDocument()
        expect(screen.getByText('Settings are unavailable.')).toBeInTheDocument()

        await openTab('Agent prompt')
        expect(screen.getByText('The agent prompt is unavailable.')).toBeInTheDocument()

        await openTab('Documentation models')
        expect(screen.getByText('Cache status is unavailable.')).toBeInTheDocument()
    })

    it('explains that the browser build has no local settings to manage', async () => {
        tauri.isTauri.mockReturnValue(false)
        render(
            <SettingsPage
                isOpen
                onOpenChange={vi.fn()}
                onCacheDeleted={vi.fn()}
            />
        )
        await flush()

        expect(screen.getByText('Desktop app required')).toBeInTheDocument()
        expect(tauri.invoke).not.toHaveBeenCalled()
    })
})

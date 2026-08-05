import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {cleanup, render, screen, waitFor, within} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import axe from 'axe-core'
import {ScriptWorkspace} from './ScriptWorkspace'
import type {ScriptReveal} from './ScriptWorkspace'
import {useScriptBuffers} from '../../hooks/useScriptBuffers'
import type {WorkspaceFileChange} from '../../models/files'
import type {MonacoStubState} from '../../test/monaco-stub'

type InvokeFunction = (command: string, args?: unknown) => Promise<unknown>

const tauri = vi.hoisted(() => ({
    invoke: vi.fn<InvokeFunction>(),
    isTauri: vi.fn(() => true),
    listen: vi.fn()
}))

vi.mock('../../services/desktop', () => ({
    invoke: tauri.invoke,
    isTauri: tauri.isTauri,
    listen: tauri.listen
}))

const editor = vi.hoisted(() => ({state: undefined as MonacoStubState | undefined}))

vi.mock('../../services/monaco-runtime', async () => {
    const {createMonacoStub} = await import('../../test/monaco-stub')
    const stub = createMonacoStub()
    editor.state = stub.state
    return {loadMonaco: () => Promise.resolve(stub.monaco)}
})

/** The structured failure a stale write is refused with, as Rust would report it. */
class BackendError extends Error {
    readonly code = 'file_conflict'
    readonly retryable = false
    readonly details = {}

    constructor() {
        super('player.gd changed on disk')
    }
}

const SOURCE = 'extends Node\n\nfunc _ready():\n\tpass\n'
const FORMATTED = 'extends Node\n\n\nfunc _ready():\n\tpass\n'
const EXTERNAL = 'extends Node\n\nfunc _ready():\n\tprint("someone else")\n'
const RENAMED = 'extends Node\n\nfunc _start():\n\tpass\n'

function backend() {
    const file = {text: SOURCE, hash: 'hash-1', version: 1}
    const saved: string[] = []
    /** Each rename transaction that reached the backend, as the paths it rewrote. */
    const applied: string[][] = []
    let changes: {onmessage: (changes: readonly WorkspaceFileChange[]) => void} | undefined
    tauri.invoke.mockImplementation(async (command, args) => {
        const request =
            (
                args as
                    | {
                          request?: {
                              op?: string
                              text?: string
                              expectedHash?: string
                              files?: unknown[]
                          }
                      }
                    | undefined
            )?.request ?? {}
        switch (command) {
            case 'list_workspace_files':
                return [
                    {path: 'player.gd', bytes: SOURCE.length},
                    {path: 'player.gd.uid', bytes: 40},
                    {path: 'addons/gofer/plugin.gd', bytes: 10}
                ]
            case 'open_script_document':
                return {
                    path: 'player.gd',
                    text: file.text,
                    hash: file.hash,
                    bytes: file.text.length,
                    version: file.version
                }
            case 'update_script_document':
                file.version += 1
                return {path: 'player.gd', version: file.version}
            case 'save_script_document':
                if (request.expectedHash !== file.hash) throw new BackendError()
                file.text = request.text ?? ''
                file.hash = 'hash-2'
                file.version += 1
                saved.push(file.text)
                return {path: 'player.gd', hash: file.hash, bytes: 1, version: file.version}
            case 'format_gdscript':
                return {formatted: FORMATTED, changed: true}
            case 'watch_workspace_files':
                changes = (
                    args as {changes: {onmessage: (batch: readonly WorkspaceFileChange[]) => void}}
                ).changes
                return undefined
            case 'call_script_language':
                if (request.op === 'prepareRename')
                    return {op: 'prepareRename', placeholder: 'ready'}
                // A rename crossing two files, only one of which has a tab open.
                return {
                    op: 'rename',
                    files: [
                        {
                            path: 'player.gd',
                            originalText: file.text,
                            originalHash: file.hash,
                            updatedText: RENAMED
                        },
                        {
                            path: 'enemy.gd',
                            originalText: 'extends Node\n\nfunc call_ready():\n\tpass\n',
                            originalHash: 'hash-enemy',
                            updatedText: 'extends Node\n\nfunc call_start():\n\tpass\n'
                        }
                    ]
                }
            case 'apply_script_rename': {
                const files = (request.files ?? []) as {path: string; updatedText: string}[]
                applied.push(files.map(entry => entry.path))
                file.text = RENAMED
                file.hash = 'hash-renamed'
                file.version += 1
                return files.map(entry => ({
                    path: entry.path,
                    hash: entry.path === 'player.gd' ? file.hash : 'hash-enemy-2',
                    bytes: entry.updatedText.length,
                    version: file.version
                }))
            }
            default:
                return undefined
        }
    })
    return {
        file,
        saved,
        applied,
        publishChanges: (batch: readonly WorkspaceFileChange[]) => {
            changes?.onmessage(batch)
        }
    }
}

/**
 * The buffers belong to the workspace frame, so the test owns them the way the frame does and
 * opens a file the way the explorer would.
 */
type HarnessProps = Readonly<{
    onError: (message: string) => void
    reveal?: ScriptReveal | undefined
}>

function Harness({onError, reveal}: HarnessProps) {
    const scripts = useScriptBuffers({onError})
    return (
        <>
            <button
                type='button'
                onClick={() => {
                    void scripts.openBuffer('player.gd')
                }}
            >
                Open player.gd
            </button>
            <ScriptWorkspace
                scripts={scripts}
                onError={onError}
                {...(reveal && {reveal})}
            />
        </>
    )
}

/**
 * The open tab strip. Astryx renders tabs as buttons inside a labelled nav rather than with the
 * ARIA tab role, and the file list holds a button with the same name, so the tab is addressed by
 * its own attribute.
 */
function openTab() {
    const tab = document.querySelector('[data-tab-value]')
    if (!tab) throw new Error('No script tab is open')
    return tab as HTMLElement
}

async function openPlayer() {
    const user = userEvent.setup()
    render(<Harness onError={vi.fn()} />)
    await user.click(screen.getByRole('button', {name: 'Open player.gd'}))
    await waitFor(() => {
        expect(editor.state?.editors).toBe(1)
    })
    return user
}

beforeEach(() => {
    tauri.isTauri.mockReturnValue(true)
    editor.state?.reset()
})

afterEach(() => {
    cleanup()
    vi.clearAllMocks()
})

describe('ScriptWorkspace', () => {
    it('opens a file into a tab and hands its text to the editor', async () => {
        backend()
        await openPlayer()

        expect(openTab()).toHaveTextContent('player.gd')
        expect(editor.state?.activeText()).toBe(SOURCE)
        expect(editor.state?.actions).toEqual(['gofer.saveScript', 'gofer.renameSymbol'])
    })

    it('marks the tab dirty while editing and saves through the editor keybinding', async () => {
        const server = backend()
        await openPlayer()

        editor.state?.type('extends Node2D\n')
        await waitFor(() => {
            expect(openTab()).toHaveTextContent('•')
        })

        editor.state?.runAction('gofer.saveScript')

        await waitFor(() => {
            expect(server.saved).toEqual(['extends Node2D\n'])
        })
        await waitFor(() => {
            expect(openTab()).not.toHaveTextContent('•')
        })
    })

    it('renders published diagnostics as editor markers and a tab badge', async () => {
        backend()
        await openPlayer()
        const diagnostics = tauri.invoke.mock.calls.find(
            call => call[0] === 'subscribe_script_diagnostics'
        )?.[1] as {diagnostics: {onmessage: (event: unknown) => void}}

        diagnostics.diagnostics.onmessage({
            path: 'player.gd',
            version: 1,
            diagnostics: [
                {
                    range: {start: {line: 2, character: 0}, end: {line: 2, character: 4}},
                    message: 'Unexpected identifier',
                    severity: 1
                }
            ]
        })

        await waitFor(() => {
            expect(editor.state?.markers['/player.gd']).toEqual([
                {
                    startLineNumber: 3,
                    startColumn: 1,
                    endLineNumber: 3,
                    endColumn: 5,
                    message: 'Unexpected identifier',
                    severity: 8
                }
            ])
        })
        expect(within(openTab()).getByText('1')).toBeInTheDocument()
    })

    it('toggles a breakpoint from the gutter', async () => {
        backend()
        await openPlayer()

        editor.state?.clickGlyphMargin(3)
        await waitFor(() => {
            expect(editor.state?.decorations).toHaveLength(1)
        })
        expect(editor.state?.decorations[0]?.options.glyphMarginClassName).toBe('gofer-breakpoint')

        editor.state?.clickGlyphMargin(3)
        await waitFor(() => {
            expect(editor.state?.decorations).toHaveLength(0)
        })
    })

    it('previews formatting and only applies it when accepted', async () => {
        const server = backend()
        const user = await openPlayer()

        await user.click(screen.getByRole('button', {name: 'Format'}))
        expect(await screen.findByText('Formatted with gdformat')).toBeInTheDocument()
        expect(server.saved).toEqual([])

        await user.click(screen.getByRole('button', {name: 'Apply to buffer'}))

        await waitFor(() => {
            expect(editor.state?.activeText()).toBe(FORMATTED)
        })
        // Applying formats the buffer only; writing it is still an explicit save.
        expect(server.saved).toEqual([])
        expect(openTab()).toHaveTextContent('•')
    })

    it('previews every file a rename would rewrite and writes only when applied', async () => {
        const server = backend()
        const user = await openPlayer()

        editor.state?.runAction('gofer.renameSymbol')

        // The dialog opens on the identifier the server named, not on whatever the cursor touched.
        const name = await screen.findByLabelText('New name')
        expect(name).toHaveValue('ready')
        await user.clear(name)
        await user.type(name, 'start')
        await user.click(screen.getByRole('button', {name: 'Preview rename'}))

        expect(await screen.findByText('Rename to start')).toBeInTheDocument()
        expect(
            screen.getByText('2 file(s) would be rewritten as one transaction.')
        ).toBeInTheDocument()
        expect(screen.getByText('enemy.gd')).toBeInTheDocument()
        // One diff per file, and nothing written by looking at them.
        expect(editor.state?.diffEditors).toBe(2)
        expect(server.applied).toEqual([])
        expect(server.file.text).toBe(SOURCE)

        await user.click(screen.getByRole('button', {name: 'Apply rename'}))

        await waitFor(() => {
            expect(server.applied).toEqual([['player.gd', 'enemy.gd']])
        })
        // The open buffer takes the text the transaction wrote, clean rather than dirty.
        await waitFor(() => {
            expect(editor.state?.activeText()).toBe(RENAMED)
        })
        expect(openTab()).not.toHaveTextContent('•')
    })

    it('conflicts a dirty buffer that changed on disk and reloads it on request', async () => {
        const server = backend()
        const user = await openPlayer()

        editor.state?.type('extends Node2D\n')
        await waitFor(() => {
            expect(openTab()).toHaveTextContent('•')
        })

        server.file.text = EXTERNAL
        server.file.hash = 'hash-external'
        server.publishChanges([{path: 'player.gd', kind: 'modified'}])

        expect(
            await screen.findByText('This file changed on disk while the buffer was edited.')
        ).toBeInTheDocument()
        // The user's edit is still there: a conflict warns, it does not overwrite either side.
        expect(editor.state?.activeText()).toBe('extends Node2D\n')
        expect(server.saved).toEqual([])

        await user.click(screen.getByRole('button', {name: 'Reload from disk'}))

        await waitFor(() => {
            expect(editor.state?.activeText()).toBe(EXTERNAL)
        })
        expect(screen.queryByText('This buffer is out of date')).not.toBeInTheDocument()
        expect(openTab()).not.toHaveTextContent('•')
    })

    it('refuses a stale save and offers to reload or overwrite', async () => {
        const server = backend()
        const user = await openPlayer()

        server.file.hash = 'hash-external'
        editor.state?.type('extends Node2D\n')
        await waitFor(() => {
            expect(openTab()).toHaveTextContent('•')
        })
        await user.click(screen.getByRole('button', {name: 'Save'}))

        expect(await screen.findByText('This buffer is out of date')).toBeInTheDocument()
        expect(server.saved).toEqual([])
        expect(screen.getByRole('button', {name: 'Overwrite'})).toBeInTheDocument()
        expect(screen.getByRole('button', {name: 'Reload from disk'})).toBeInTheDocument()
    })

    it('reveals the line another panel pointed at', async () => {
        backend()
        const report = vi.fn()
        const user = userEvent.setup()
        const {rerender} = render(<Harness onError={report} />)
        await user.click(screen.getByRole('button', {name: 'Open player.gd'}))
        await waitFor(() => {
            expect(editor.state?.editors).toBe(1)
        })
        expect(editor.state?.revealed).toEqual([])

        rerender(
            <Harness
                onError={report}
                reveal={{path: 'player.gd', line: 3, at: 1}}
            />
        )

        await waitFor(() => {
            expect(editor.state?.revealed).toEqual([3])
        })
    })

    it('has no automatically detectable accessibility violations', async () => {
        backend()
        const {container} = render(<Harness onError={vi.fn()} />)
        await screen.findByRole('button', {name: 'Open player.gd'})

        const result = await axe.run(container)

        expect(result.violations).toEqual([])
    })
})

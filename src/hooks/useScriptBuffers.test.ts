import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {act, renderHook} from '@testing-library/react'
import type {Channel} from '@tauri-apps/api/core'
import {useScriptBuffers} from './useScriptBuffers'
import type {FormatPreview, RenamePreview} from './useScriptBuffers'
import type {ScriptDiagnosticsEvent} from '../models/script'
import type {WorkspaceFileChange} from '../models/files'
import {createDesktopFake, installDesktopFake, removeDesktopFake} from '../test/desktop-driver'
import {flush} from '../test/flush'
import {createManualScheduler, setScheduler, timerScheduler} from '../services/clock'

const tauri = createDesktopFake()

interface FileRecord {
    text: string
    hash: string
    version: number
}

/** The fields the fake backend reads out of a command's request body. */
interface ScriptCommandRequest {
    path?: string
    text?: string
    expectedHash?: string
}

/** The structured failure Rust rejects with, as an error object the lint rules accept. */
class BackendError extends Error {
    constructor(
        readonly code: string,
        message: string,
        readonly retryable = false,
        readonly details: Record<string, unknown> = {}
    ) {
        super(message)
    }
}

const CONFLICT = new BackendError('file_conflict', 'player.gd changed on disk since it was read')

/** The backend the hook talks to, reduced to what a buffer's lifecycle actually needs. */
function backend() {
    const files = new Map<string, FileRecord>([
        ['player.gd', {text: 'extends Node\n', hash: 'hash-1', version: 0}]
    ])
    const channels: {diagnostics?: unknown; changes?: unknown} = {}
    const saved: string[] = []
    const closed: string[] = []

    tauri.invoke.mockImplementation(async (command, args) => {
        const request = (args as {request?: ScriptCommandRequest} | undefined)?.request ?? {}
        const path = request.path ?? ''
        const file = files.get(path)
        switch (command) {
            case 'list_workspace_files':
                return [...files.keys()].map(name => ({path: name, bytes: 12}))
            case 'open_script_document': {
                if (!file) throw new BackendError('not_found', 'missing')
                file.version += 1
                return {path, text: file.text, hash: file.hash, bytes: 12, version: file.version}
            }
            case 'update_script_document': {
                if (!file) throw new BackendError('not_found', 'missing')
                file.version += 1
                return {path, version: file.version}
            }
            case 'save_script_document': {
                if (!file) throw new BackendError('not_found', 'missing')
                if (request.expectedHash !== file.hash) throw CONFLICT
                file.text = request.text ?? ''
                file.hash = `hash-${String(files.size + saved.length + 2)}`
                file.version += 1
                saved.push(path)
                return {path, hash: file.hash, bytes: file.text.length, version: file.version}
            }
            case 'close_script_document':
                closed.push(path)
                return undefined
            case 'format_gdscript':
                return {
                    formatted: 'extends Node\n\nfunc _ready() -> void:\n\tpass\n',
                    changed: true
                }
            case 'call_script_language':
                return {
                    op: 'rename',
                    files: [
                        {
                            path: 'player.gd',
                            originalText: files.get('player.gd')?.text ?? '',
                            originalHash: files.get('player.gd')?.hash ?? '',
                            updatedText: 'extends Node2D\n'
                        }
                    ]
                }
            case 'apply_script_rename': {
                const target = files.get('player.gd')
                if (target) {
                    target.text = 'extends Node2D\n'
                    target.hash = 'hash-renamed'
                    target.version += 1
                }
                return [{path: 'player.gd', hash: 'hash-renamed', bytes: 15, version: 9}]
            }
            case 'subscribe_script_diagnostics':
                channels.diagnostics = (args as {diagnostics: unknown}).diagnostics
                return undefined
            case 'watch_workspace_files':
                channels.changes = (args as {changes: unknown}).changes
                return undefined
            default:
                return undefined
        }
    })

    return {
        files,
        saved,
        closed,
        publishDiagnostics: (event: ScriptDiagnosticsEvent) => {
            ;(channels.diagnostics as Channel<ScriptDiagnosticsEvent>).onmessage(event)
        },
        publishChanges: (changes: readonly WorkspaceFileChange[]) => {
            ;(channels.changes as Channel<readonly WorkspaceFileChange[]>).onmessage(changes)
        }
    }
}

async function openPlayer(onError = vi.fn()) {
    const hook = renderHook(() => useScriptBuffers({onError}))
    await flush()
    expect(hook.result.current.files).toHaveLength(1)
    await act(async () => {
        await hook.result.current.openBuffer('player.gd')
    })
    return {hook, onError}
}

/** The change debounce, held until a test says the typing has stopped. */
let clock = createManualScheduler()

beforeEach(() => {
    installDesktopFake(tauri)
    clock = createManualScheduler()
    setScheduler(clock.schedule)
})

afterEach(() => {
    removeDesktopFake()
    setScheduler(timerScheduler)
    vi.clearAllMocks()
})

describe('script buffers', () => {
    it('opens a file as a clean buffer holding the hash it must replace', async () => {
        backend()
        const {hook} = await openPlayer()

        expect(hook.result.current.activeBuffer).toMatchObject({
            path: 'player.gd',
            text: 'extends Node\n',
            hash: 'hash-1',
            dirty: false,
            version: 1
        })
    })

    it('marks a change dirty at once and synchronizes one document version after the pause', async () => {
        backend()
        const {hook} = await openPlayer()

        act(() => {
            hook.result.current.changeBuffer('player.gd', 'extends Node\nvar speed := 1.0\n')
            hook.result.current.changeBuffer('player.gd', 'extends Node\nvar speed := 2.0\n')
        })
        expect(hook.result.current.activeBuffer?.dirty).toBe(true)
        // Two keystrokes, one delay outstanding: the second call off the first rather than adding.
        expect(clock.pending).toBe(1)

        await act(async () => {
            clock.run()
            await Promise.resolve()
        })

        const updates = tauri.invoke.mock.calls.filter(call => call[0] === 'update_script_document')
        expect(updates).toHaveLength(1)
        expect(hook.result.current.activeBuffer?.version).toBe(2)
    })

    it('writes the buffer and clears the dirty flag on save', async () => {
        const server = backend()
        const {hook} = await openPlayer()

        act(() => {
            hook.result.current.changeBuffer('player.gd', 'extends Node2D\n')
        })
        await act(async () => {
            await hook.result.current.saveBuffer('player.gd')
        })

        expect(server.saved).toEqual(['player.gd'])
        expect(server.files.get('player.gd')?.text).toBe('extends Node2D\n')
        expect(hook.result.current.activeBuffer).toMatchObject({dirty: false, conflict: undefined})
    })

    it('reports a stale save as a conflict and writes nothing', async () => {
        const server = backend()
        const {hook, onError} = await openPlayer()

        // Something else wrote the file after this buffer read it.
        const file = server.files.get('player.gd')
        if (file) file.hash = 'hash-external'

        act(() => {
            hook.result.current.changeBuffer('player.gd', 'extends Node2D\n')
        })
        await act(async () => {
            await hook.result.current.saveBuffer('player.gd')
        })

        expect(server.saved).toEqual([])
        expect(hook.result.current.activeBuffer?.conflict).toBe('staleSave')
        expect(hook.result.current.activeBuffer?.dirty).toBe(true)
        // The conflict is the report, and it is attached to the buffer that has the two answers to
        // it. Sending a copy to the frame as well put the same sentence in a banner that only a
        // click can remove, so the workspace went on saying the file could not be saved long after
        // it had been — through every later save, every tab, and every task.
        expect(onError).not.toHaveBeenCalled()
    })

    it('reloads a clean buffer on an external change but conflicts a dirty one', async () => {
        const server = backend()
        const {hook} = await openPlayer()

        const file = server.files.get('player.gd')
        if (file) {
            file.text = 'extends CharacterBody2D\n'
            file.hash = 'hash-external'
        }
        await act(async () => {
            server.publishChanges([{path: 'player.gd', kind: 'modified'}])
        })
        expect(hook.result.current.activeBuffer?.text).toBe('extends CharacterBody2D\n')

        act(() => {
            hook.result.current.changeBuffer('player.gd', 'extends Node\n')
        })
        await act(async () => {
            server.publishChanges([{path: 'player.gd', kind: 'modified'}])
        })

        expect(hook.result.current.activeBuffer?.conflict).toBe('externalChange')
        expect(hook.result.current.activeBuffer?.text).toBe('extends Node\n')
    })

    it('resolves a conflict by overwriting with the buffer text', async () => {
        const server = backend()
        const {hook} = await openPlayer()

        const file = server.files.get('player.gd')
        if (file) file.hash = 'hash-external'
        act(() => {
            hook.result.current.changeBuffer('player.gd', 'extends Node2D\n')
        })
        await act(async () => {
            await hook.result.current.saveBuffer('player.gd')
        })
        await act(async () => {
            await hook.result.current.overwriteBuffer('player.gd')
        })

        expect(server.files.get('player.gd')?.text).toBe('extends Node2D\n')
        expect(hook.result.current.activeBuffer).toMatchObject({
            dirty: false,
            conflict: undefined
        })
    })

    it('toggles breakpoints on and off by line', async () => {
        backend()
        const {hook} = await openPlayer()

        act(() => {
            hook.result.current.toggleBreakpoint('player.gd', 4)
            hook.result.current.toggleBreakpoint('player.gd', 7)
            hook.result.current.toggleBreakpoint('player.gd', 4)
        })

        expect(hook.result.current.activeBuffer?.breakpoints).toEqual([7])
    })

    it('keeps breakpoints across a reload', async () => {
        backend()
        const {hook} = await openPlayer()

        act(() => {
            hook.result.current.toggleBreakpoint('player.gd', 3)
        })
        await act(async () => {
            await hook.result.current.reloadBuffer('player.gd')
        })

        expect(hook.result.current.activeBuffer?.breakpoints).toEqual([3])
    })

    it('previews formatting without writing and dirties the buffer only when applied', async () => {
        const server = backend()
        const {hook} = await openPlayer()

        let preview: FormatPreview | undefined
        await act(async () => {
            preview = await hook.result.current.previewFormat('player.gd')
        })

        expect(preview).toMatchObject({path: 'player.gd', changed: true})
        expect(server.saved).toEqual([])
        expect(hook.result.current.activeBuffer?.dirty).toBe(false)

        act(() => {
            if (preview) hook.result.current.applyFormat(preview)
        })
        expect(hook.result.current.activeBuffer?.dirty).toBe(true)
        expect(server.files.get('player.gd')?.text).toBe('extends Node\n')
    })

    it('plans a rename before applying it as one transaction', async () => {
        const server = backend()
        const {hook} = await openPlayer()

        let preview: RenamePreview | undefined
        await act(async () => {
            preview = await hook.result.current.previewRename(
                'player.gd',
                {line: 0, character: 8},
                'Node2D'
            )
        })

        expect(preview).toMatchObject({newName: 'Node2D'})
        expect(server.files.get('player.gd')?.text).toBe('extends Node\n')

        await act(async () => {
            if (preview) await hook.result.current.commitRename(preview)
        })

        expect(server.files.get('player.gd')?.text).toBe('extends Node2D\n')
        expect(hook.result.current.activeBuffer).toMatchObject({
            text: 'extends Node2D\n',
            hash: 'hash-renamed',
            dirty: false
        })
    })

    it('collects published diagnostics by path', async () => {
        const server = backend()
        const {hook} = await openPlayer()

        await act(async () => {
            server.publishDiagnostics({
                path: 'player.gd',
                version: 1,
                diagnostics: [
                    {
                        range: {start: {line: 1, character: 0}, end: {line: 1, character: 4}},
                        message: 'Unexpected token',
                        severity: 1
                    }
                ]
            })
        })

        expect(hook.result.current.diagnostics['player.gd']).toHaveLength(1)
    })

    /*
     * The regression: diagnostics accumulated per path and nothing ever removed one.
     *
     * `closeBuffer` dropped the tab and left the rows, so the bottom panel kept counting errors for
     * a file that is not open — and for a file the agent had deleted, whose rows open nothing when
     * clicked. Neither the close nor the external-change handler touched the map.
     */
    it("drops a closed file's diagnostics with its tab", async () => {
        const server = backend()
        const {hook} = await openPlayer()

        await act(async () => {
            server.publishDiagnostics({
                path: 'player.gd',
                version: 1,
                diagnostics: [
                    {
                        range: {start: {line: 1, character: 0}, end: {line: 1, character: 4}},
                        message: 'Unexpected token',
                        severity: 1
                    }
                ]
            })
        })
        expect(hook.result.current.diagnostics['player.gd']).toHaveLength(1)

        act(() => {
            hook.result.current.closeBuffer('player.gd')
        })
        await flush()

        expect(hook.result.current.diagnostics['player.gd']).toBeUndefined()
    })

    it('closes the document and drops the tab', async () => {
        const server = backend()
        const {hook} = await openPlayer()

        act(() => {
            hook.result.current.closeBuffer('player.gd')
        })
        await flush()

        expect(server.closed).toEqual(['player.gd'])
        expect(hook.result.current.buffers).toEqual([])
        expect(hook.result.current.activePath).toBeUndefined()
    })

    it('does nothing outside the desktop shell', async () => {
        backend()
        tauri.isTauri.mockReturnValue(false)
        const hook = renderHook(() => useScriptBuffers({onError: vi.fn()}))

        await act(async () => {
            await hook.result.current.openBuffer('player.gd')
        })

        expect(hook.result.current.buffers).toEqual([])
        expect(tauri.invoke).not.toHaveBeenCalled()
    })
})

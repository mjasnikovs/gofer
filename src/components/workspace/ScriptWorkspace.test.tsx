import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {cleanup, render, screen, within} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import axe from 'axe-core'
import {ScriptWorkspace} from './ScriptWorkspace'
import type {ScriptReveal} from './ScriptWorkspace'
import {useScriptBuffers} from '../../hooks/useScriptBuffers'
import {WorkspaceFailureContext} from '../../hooks/useWorkspaceFailure'
import type {MonacoStubState} from '../../test/monaco-stub'
import {createDesktopFake, installDesktopFake, removeDesktopFake} from '../../test/desktop-driver'
import {flush} from '../../test/flush'
import {installBackend} from '../../test/backend'
import {createManualScheduler, setScheduler, timerScheduler} from '../../services/clock'

const tauri = createDesktopFake()

const editor = vi.hoisted(() => ({state: undefined as MonacoStubState | undefined}))

vi.mock('../../services/monaco-runtime', async () => {
    const {createMonacoStub} = await import('../../test/monaco-stub')
    const stub = createMonacoStub()
    editor.state = stub.state
    return {loadMonaco: () => Promise.resolve(stub.monaco)}
})

const SOURCE = 'extends Node\n\nfunc _ready():\n\tpass\n'
const FORMATTED = 'extends Node\n\n\nfunc _ready():\n\tpass\n'
const EXTERNAL = 'extends Node\n\nfunc _ready():\n\tprint("someone else")\n'
const RENAMED = 'extends Node\n\nfunc _start():\n\tpass\n'

function backend() {
    return installBackend(tauri, {
        files: [
            {path: 'player.gd', bytes: SOURCE.length},
            {path: 'player.gd.uid', bytes: 40},
            {path: 'addons/gofer/plugin.gd', bytes: 10}
        ],
        script: {path: 'player.gd', text: SOURCE},
        answers: {
            format_gdscript: () => ({formatted: FORMATTED, changed: true}),
            call_script_language: ({request}) => {
                if (request.op === 'prepareRename')
                    return {op: 'prepareRename', placeholder: 'ready'}
                return {
                    op: 'rename',
                    files: [
                        {
                            path: 'player.gd',
                            originalText: SOURCE,
                            originalHash: 'hash-1',
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
            }
        }
    })
}

type HarnessProps = Readonly<{
    onError: (message: string) => void
    reveal?: ScriptReveal | undefined
}>

function Harness({onError, reveal}: HarnessProps) {
    const scripts = useScriptBuffers({onError})
    return (
        <WorkspaceFailureContext value={onError}>
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
                views={{}}
                onViewChange={() => undefined}
                {...(reveal && {reveal})}
            />
        </WorkspaceFailureContext>
    )
}

function openTab() {
    const tab = document.querySelector('[data-tab-value]')
    if (!tab) throw new Error('No script tab is open')
    return tab as HTMLElement
}

async function openPlayer() {
    const user = userEvent.setup()
    render(<Harness onError={vi.fn()} />)
    await user.click(screen.getByRole('button', {name: 'Open player.gd'}))
    await flush()
    expect(editor.state?.editors).toBe(1)
    return user
}

let clock = createManualScheduler()

beforeEach(() => {
    installDesktopFake(tauri)
    clock = createManualScheduler()
    setScheduler(clock.schedule)
    editor.state?.reset()
})

afterEach(() => {
    cleanup()
    removeDesktopFake()
    setScheduler(timerScheduler)
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
        await flush()
        expect(openTab()).toHaveTextContent('•')

        editor.state?.runAction('gofer.saveScript')
        await flush()

        expect(server.log.savedScripts).toEqual(['extends Node2D\n'])
        expect(openTab()).not.toHaveTextContent('•')
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

        await flush()

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
        expect(within(openTab()).getByText('1')).toBeInTheDocument()
    })

    it('toggles a breakpoint from the gutter', async () => {
        backend()
        await openPlayer()

        editor.state?.clickGlyphMargin(3)
        await flush()

        expect(editor.state?.decorations).toHaveLength(1)
        expect(editor.state?.decorations[0]?.options.glyphMarginClassName).toBe('gofer-breakpoint')

        editor.state?.clickGlyphMargin(3)
        await flush()

        expect(editor.state?.decorations).toHaveLength(0)
    })

    it('previews formatting and only applies it when accepted', async () => {
        const server = backend()
        const user = await openPlayer()

        await user.click(screen.getByRole('button', {name: 'Format'}))
        await flush()
        expect(screen.getByText('Formatted with gdformat')).toBeInTheDocument()
        expect(server.log.savedScripts).toEqual([])

        await user.click(screen.getByRole('button', {name: 'Apply to buffer'}))
        await flush()

        expect(editor.state?.activeText()).toBe(FORMATTED)
        expect(server.log.savedScripts).toEqual([])
        expect(openTab()).toHaveTextContent('•')
    })

    it('previews every file a rename would rewrite and writes only when applied', async () => {
        const server = backend()
        const user = await openPlayer()

        editor.state?.runAction('gofer.renameSymbol')

        await flush()
        const name = screen.getByLabelText('New name')
        expect(name).toHaveValue('ready')
        await user.clear(name)
        await user.type(name, 'start')
        await user.click(screen.getByRole('button', {name: 'Preview rename'}))

        await flush()
        expect(screen.getByText('Rename to start')).toBeInTheDocument()
        expect(
            screen.getByText('2 file(s) would be rewritten as one transaction.')
        ).toBeInTheDocument()
        expect(screen.getByText('enemy.gd')).toBeInTheDocument()
        expect(editor.state?.diffEditors).toBe(2)
        expect(server.log.renames).toEqual([])
        expect(server.state.script.text).toBe(SOURCE)

        await user.click(screen.getByRole('button', {name: 'Apply rename'}))
        await flush()

        expect(server.log.renames).toEqual([['player.gd', 'enemy.gd']])
        expect(editor.state?.activeText()).toBe(RENAMED)
        expect(openTab()).not.toHaveTextContent('•')
    })

    it('conflicts a dirty buffer that changed on disk and reloads it on request', async () => {
        const server = backend()
        const user = await openPlayer()

        editor.state?.type('extends Node2D\n')
        await flush()
        expect(openTab()).toHaveTextContent('•')

        server.state.script.text = EXTERNAL
        server.state.script.hash = 'hash-external'
        server.publishFileChanges([{path: 'player.gd', kind: 'modified'}])
        await flush()

        expect(
            screen.getByText('This file changed on disk while the buffer was edited.')
        ).toBeInTheDocument()
        expect(editor.state?.activeText()).toBe('extends Node2D\n')
        expect(server.log.savedScripts).toEqual([])

        await user.click(screen.getByRole('button', {name: 'Reload from disk'}))
        await flush()

        expect(editor.state?.activeText()).toBe(EXTERNAL)
        expect(screen.queryByText('This buffer is out of date')).not.toBeInTheDocument()
        expect(openTab()).not.toHaveTextContent('•')
    })

    it('refuses a stale save and offers to reload or overwrite', async () => {
        const server = backend()
        const user = await openPlayer()

        server.state.script.hash = 'hash-external'
        editor.state?.type('extends Node2D\n')
        await flush()
        expect(openTab()).toHaveTextContent('•')

        await user.click(screen.getByRole('button', {name: 'Save'}))
        await flush()

        expect(screen.getByText('This buffer is out of date')).toBeInTheDocument()
        expect(server.log.savedScripts).toEqual([])
        expect(screen.getByRole('button', {name: 'Overwrite'})).toBeInTheDocument()
        expect(screen.getByRole('button', {name: 'Reload from disk'})).toBeInTheDocument()
    })

    it('does not also report a stale save to the frame, which cannot take it back', async () => {
        const server = backend()
        const report = vi.fn()
        const user = userEvent.setup()
        render(<Harness onError={report} />)
        await user.click(screen.getByRole('button', {name: 'Open player.gd'}))
        await flush()
        expect(openTab()).toBeInTheDocument()

        server.state.script.hash = 'hash-external'
        editor.state?.type('extends Node2D\n')
        await flush()
        expect(openTab()).toHaveTextContent('•')

        await user.click(screen.getByRole('button', {name: 'Save'}))
        await flush()

        expect(screen.getByText('This buffer is out of date')).toBeInTheDocument()
        expect(report).not.toHaveBeenCalled()
    })

    it('reveals the line another panel pointed at', async () => {
        backend()
        const report = vi.fn()
        const user = userEvent.setup()
        const {rerender} = render(<Harness onError={report} />)
        await user.click(screen.getByRole('button', {name: 'Open player.gd'}))
        await flush()
        expect(editor.state?.editors).toBe(1)
        expect(editor.state?.revealed).toEqual([])

        rerender(
            <Harness
                onError={report}
                reveal={{path: 'player.gd', line: 3, at: 1}}
            />
        )

        await flush()

        expect(editor.state?.revealed).toEqual([3])
    })

    it('has no automatically detectable accessibility violations', async () => {
        backend()
        const {container} = render(<Harness onError={vi.fn()} />)
        await flush()
        expect(screen.getByRole('button', {name: 'Open player.gd'})).toBeInTheDocument()

        const result = await axe.run(container)

        expect(result.violations).toEqual([])
    })
})

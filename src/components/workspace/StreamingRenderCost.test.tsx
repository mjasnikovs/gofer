import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {act, cleanup, render, screen, within} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {Workspace} from './Workspace'
import {RECONCILE_MS} from '../../hooks/useGodotSession'
import type {MonacoStubState} from '../../test/monaco-stub'
import {immediateScheduler, setScheduler} from '../../services/clock'
import {createDesktopFake, installDesktopFake, removeDesktopFake} from '../../test/desktop-driver'
import {flush} from '../../test/flush'
import {installBackend} from '../../test/backend'
import type {Backend} from '../../test/backend'

const tauri = createDesktopFake()

const renders = vi.hoisted(() => ({explorer: 0, inspector: 0, bottom: 0}))

const editor = vi.hoisted(() => ({state: undefined as MonacoStubState | undefined}))

vi.mock('../../services/monaco-runtime', async () => {
    const {createMonacoStub} = await import('../../test/monaco-stub')
    const stub = createMonacoStub()
    editor.state = stub.state
    return {loadMonaco: () => Promise.resolve(stub.monaco)}
})

vi.mock('./ExplorerPanel', async importOriginal => {
    const {createElement} = await import('react')
    const actual = await importOriginal<typeof import('./ExplorerPanel')>()
    return {
        ExplorerPanel: (props: Parameters<typeof actual.ExplorerPanel>[0]) => {
            renders.explorer += 1
            return createElement(actual.ExplorerPanel, props)
        }
    }
})

vi.mock('./InspectorPanel', async importOriginal => {
    const {createElement} = await import('react')
    const actual = await importOriginal<typeof import('./InspectorPanel')>()
    return {
        InspectorPanel: (props: Parameters<typeof actual.InspectorPanel>[0]) => {
            renders.inspector += 1
            return createElement(actual.InspectorPanel, props)
        }
    }
})

vi.mock('./BottomPanel', async importOriginal => {
    const {createElement} = await import('react')
    const actual = await importOriginal<typeof import('./BottomPanel')>()
    return {
        BottomPanel: (props: Parameters<typeof actual.BottomPanel>[0]) => {
            renders.bottom += 1
            return createElement(actual.BottomPanel, props)
        }
    }
})

const TOKENS = 40

let server: Backend

beforeEach(() => {
    setScheduler(immediateScheduler)
    installDesktopFake(tauri)
    editor.state?.reset()
    server = installBackend(tauri)
    renders.explorer = 0
    renders.inspector = 0
    renders.bottom = 0
})

afterEach(() => {
    cleanup()
    removeDesktopFake()
    vi.clearAllMocks()
})

async function startSession(user: ReturnType<typeof userEvent.setup>) {
    await user.click(
        within(screen.getByRole('navigation', {name: 'Explorer'})).getByRole('button', {
            name: 'Start Godot'
        })
    )
    await flush()
    expect(screen.getByText('Player')).toBeInTheDocument()
}

async function send(user: ReturnType<typeof userEvent.setup>, text: string) {
    const composer = await screen.findByRole('combobox', {name: 'Message input'})
    await user.click(composer)
    await user.paste(text)
    await user.keyboard('{Enter}')
    await flush()
}

async function stream(tokens: number) {
    for (let index = 0; index < tokens; index += 1) {
        await act(async () => {
            server.publishStream({
                requestId: 1,
                event: {type: 'text-delta', delta: 'word '}
            } as never)
            await Promise.resolve()
        })
    }
}

describe('what a streamed reply costs the frame', () => {
    it('leaves the explorer alone while a reply streams', async () => {
        const user = userEvent.setup()
        render(<Workspace />)
        await flush()
        await startSession(user)
        await send(user, 'go')

        const before = renders.explorer
        await stream(TOKENS)

        expect(renders.explorer - before).toBe(0)
    })

    it('leaves the inspector alone while a reply streams', async () => {
        const user = userEvent.setup()
        render(<Workspace />)
        await flush()
        await startSession(user)
        await send(user, 'go')

        const before = renders.inspector
        await stream(TOKENS)

        expect(renders.inspector - before).toBe(0)
    })

    it('leaves the bottom panel alone while a reply streams', async () => {
        const user = userEvent.setup()
        render(<Workspace />)
        await flush()
        await startSession(user)
        await send(user, 'go')

        const before = renders.bottom
        await stream(TOKENS)

        expect(renders.bottom - before).toBe(0)
    })

    it('leaves the frame alone while a message is being typed', async () => {
        const user = userEvent.setup()
        render(<Workspace />)
        await flush()
        await startSession(user)

        const composer = await screen.findByRole('combobox', {name: 'Message input'})
        await user.click(composer)
        const before = {...renders}
        await user.paste('a message being written one keystroke at a time')
        await flush()

        expect(renders.explorer - before.explorer).toBe(0)
        expect(renders.inspector - before.inspector).toBe(0)
        expect(renders.bottom - before.bottom).toBe(0)
    })
})

describe('what the session heartbeat costs the frame', () => {
    it('redraws nothing on a tick that read the same session back', async () => {
        vi.useFakeTimers({shouldAdvanceTime: true})
        try {
            const user = userEvent.setup({advanceTimers: vi.advanceTimersByTime})
            render(<Workspace />)
            await flush()
            await startSession(user)

            const before = {...renders}
            await act(async () => {
                await vi.advanceTimersByTimeAsync(RECONCILE_MS * 5)
            })
            await flush()

            expect(renders.explorer - before.explorer).toBe(0)
            expect(renders.inspector - before.inspector).toBe(0)
            expect(renders.bottom - before.bottom).toBe(0)
        } finally {
            vi.useRealTimers()
        }
    })
})

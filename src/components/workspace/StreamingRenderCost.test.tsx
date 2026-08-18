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

/**
 * What a streamed token costs the rest of the window.
 *
 * A reply arrives one token at a time, and every token replaces the conversation — which re-renders
 * `Workspace`. Everything `Workspace` hands to the IDE frame is handed down again on that render,
 * so the scene tree, the runtime tree, the file listing, and the bottom panel are all redrawn per
 * token unless something stops them. Rebuilding a scene tree is not free: every node becomes a
 * `TreeListItemData` carrying a `Tooltip` and an `IconButton`, built during render.
 *
 * These are budgets, not observations. A panel that has nothing to do with the conversation should
 * render zero extra times while the conversation streams.
 */

const tauri = createDesktopFake()

/** How many times each panel was asked to draw. Reset before every test. */
const renders = vi.hoisted(() => ({explorer: 0, inspector: 0, bottom: 0}))

const editor = vi.hoisted(() => ({state: undefined as MonacoStubState | undefined}))

vi.mock('../../services/monaco-runtime', async () => {
    const {createMonacoStub} = await import('../../test/monaco-stub')
    const stub = createMonacoStub()
    editor.state = stub.state
    return {loadMonaco: () => Promise.resolve(stub.monaco)}
})

/*
 * Each panel is wrapped rather than replaced: the counter sits above the real component, so the
 * count is how often the frame asked for it and the panel below still does its real work. React is
 * imported inside the factory because a `vi.mock` factory is hoisted above this file's imports.
 */
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

/** Enough tokens to be a paragraph, few enough to run fast. A real reply sends thousands. */
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

/** Brings the editor up, so the explorer is drawing a real scene tree rather than an empty state. */
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

/** Streams one reply, a token at a time, the way the worker does. */
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

    /*
     * The draft is the conversation's other per-keystroke state, and it lives in the same component
     * the frame hangs off. A message being typed is not a fact about the scene tree either.
     */
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

/**
 * The session's own heartbeat.
 *
 * The frame re-reads the backend's view of the editor once a second, forever, whether or not the
 * user is doing anything. That is the one thing in this window guaranteed to happen while nobody
 * is looking, so an unchanged reading has to cost nothing: a reducer that answered every tick with
 * a fresh object would redraw every panel in the workspace once a second for the life of the app.
 */
describe('what the session heartbeat costs the frame', () => {
    it('redraws nothing on a tick that read the same session back', async () => {
        vi.useFakeTimers({shouldAdvanceTime: true})
        try {
            const user = userEvent.setup({advanceTimers: vi.advanceTimersByTime})
            render(<Workspace />)
            await flush()
            await startSession(user)

            const before = {...renders}
            // Several reconcile ticks, each answering with the session that is already on screen.
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

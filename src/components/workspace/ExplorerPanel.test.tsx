import {afterEach, describe, expect, it, vi} from 'vitest'
import {cleanup, render, screen, waitFor} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {ExplorerPanel} from './ExplorerPanel'
import {InEditorSession} from '../../test/editor-session'
import {fakeSession, refusal} from '../../test/fake-session'
import type {GodotSessionState} from '../../models/godot'
import type {GodotCall} from '../../models/workspace'
import type {WorkspaceEntry} from '../../models/script'
import {ChatReferenceContext} from '../../hooks/useChatReferences'
import type {ChatReference} from '../../utils/chat-references'

afterEach(cleanup)

const TREE = {
    root: {
        name: 'Main',
        type: 'Node2D',
        path: '.',
        children: [{name: 'Player', type: 'CharacterBody2D', path: 'Player', children: []}]
    }
}

const FILES: readonly WorkspaceEntry[] = [
    {path: 'scenes/main.tscn', bytes: 10},
    {path: 'scripts/player.gd', bytes: 10},
    {path: 'art/tile.png', bytes: 10},
    {path: 'scenes/main.tscn.import', bytes: 10},
    {path: '.godot/uid_cache.bin', bytes: 10}
]

function explorer(
    options: Readonly<{
        tab?: 'scene' | 'runtime' | 'files'
        state?: GodotSessionState
        answer?: () => Promise<unknown>
        add?: (reference: ChatReference) => void
    }> = {}
) {
    const {tab = 'scene', state = 'ready', answer = () => Promise.resolve(TREE), add} = options
    const call = vi.fn(answer)
    const handlers = {
        onTabChange: vi.fn(),
        onSelect: vi.fn(),
        onOpenFile: vi.fn(),
        onOpenScene: vi.fn(),
        onOpenMainScene: vi.fn(),
        onStartSession: vi.fn()
    }
    const panel = (
        <InEditorSession session={fakeSession({state, call: call as unknown as GodotCall})}>
            <ExplorerPanel
                tab={tab}
                files={FILES}
                selection={undefined}
                {...handlers}
            />
        </InEditorSession>
    )
    render(
        add ?
            <ChatReferenceContext.Provider value={{add, paste: () => undefined}}>
                {panel}
            </ChatReferenceContext.Provider>
        :   panel
    )
    return {call, ...handlers}
}

describe('the explorer column', () => {
    it('draws the scene the editor has open', async () => {
        const {call} = explorer()
        await waitFor(() => {
            expect(screen.getByText('Player')).toBeInTheDocument()
        })
        expect(call).toHaveBeenCalledWith('scene.get_tree', {limit: 4096})
    })

    it('asks nothing of an editor that is not running, and offers to start one', () => {
        const {call, onStartSession} = explorer({state: 'offline'})
        expect(call).not.toHaveBeenCalled()
        expect(screen.getByText('No editor running')).toBeInTheDocument()
        screen.getByRole('button', {name: 'Start Godot'}).click()
        expect(onStartSession).toHaveBeenCalled()
    })

    it('waits for an editor that is still importing', () => {
        const {call} = explorer({state: 'importing'})
        expect(call).not.toHaveBeenCalled()
        expect(screen.queryByText('No scene is open')).not.toBeInTheDocument()
    })

    it('reports a game that is not running as a fact rather than a fault', async () => {
        explorer({
            tab: 'runtime',
            answer: () => Promise.reject(refusal('runtime_not_running', 'no game'))
        })
        await waitFor(() => {
            expect(screen.getByText('The game is not running')).toBeInTheDocument()
        })
    })

    it('opens a scene in the editor and a script in Monaco, and lists neither sidecar', async () => {
        const user = userEvent.setup()
        const {onOpenScene, onOpenFile} = explorer({tab: 'files'})
        await user.click(screen.getByText('main.tscn'))
        expect(onOpenScene).toHaveBeenCalledWith('scenes/main.tscn')

        await user.click(screen.getByText('player.gd'))
        expect(onOpenFile).toHaveBeenCalledWith('scripts/player.gd')

        expect(screen.queryByText('main.tscn.import')).not.toBeInTheDocument()
        expect(screen.queryByText('uid_cache.bin')).not.toBeInTheDocument()
    })

    it('offers no way to mention a file where there is no conversation to mention it in', () => {
        explorer({tab: 'files'})
        expect(screen.queryByRole('button', {name: /^Mention /})).not.toBeInTheDocument()
    })

    it('mentions a file, a folder, and a picture it cannot open', async () => {
        const user = userEvent.setup()
        const add = vi.fn()
        explorer({tab: 'files', add})

        await user.click(screen.getByRole('button', {name: 'Mention player.gd in the message'}))
        expect(add).toHaveBeenCalledWith({kind: 'file', id: 'scripts/player.gd'})

        await user.click(screen.getByRole('button', {name: 'Mention scripts in the message'}))
        expect(add).toHaveBeenCalledWith({kind: 'file', id: 'scripts/'})

        await user.click(screen.getByRole('button', {name: 'Mention tile.png in the message'}))
        expect(add).toHaveBeenCalledWith({kind: 'file', id: 'art/tile.png'})
    })

    it('chooses a node with the origin it was chosen in', async () => {
        const user = userEvent.setup()
        const {onSelect} = explorer()
        await waitFor(() => {
            expect(screen.getByText('Player')).toBeInTheDocument()
        })
        await user.click(screen.getByText('Player'))
        expect(onSelect).toHaveBeenCalledWith({
            origin: 'edited',
            path: 'Player',
            name: 'Player',
            type: 'CharacterBody2D'
        })
    })
})

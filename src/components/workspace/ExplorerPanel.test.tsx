import {afterEach, describe, expect, it, vi} from 'vitest'
import {cleanup, render, screen, waitFor} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {ExplorerPanel} from './ExplorerPanel'
import {InEditorSession} from '../../test/editor-session'
import {fakeSession, refusal} from '../../test/fake-session'
import type {GodotSessionState} from '../../models/godot'
import type {GodotCall} from '../../models/workspace'
import type {WorkspaceEntry} from '../../models/script'

/**
 * The explorer, mounted as itself.
 *
 * Every one of these used to need the whole frame around it, because the panel took the editor
 * session apart into four props only a frame could supply consistently. It reads the session at a
 * seam now, so a test supplies one.
 */

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
    {path: 'scenes/main.tscn.import', bytes: 10},
    {path: '.godot/uid_cache.bin', bytes: 10}
]

function explorer(
    options: Readonly<{
        tab?: 'scene' | 'runtime' | 'files'
        state?: GodotSessionState
        answer?: () => Promise<unknown>
    }> = {}
) {
    const {tab = 'scene', state = 'ready', answer = () => Promise.resolve(TREE)} = options
    const call = vi.fn(answer)
    const handlers = {
        onTabChange: vi.fn(),
        onSelect: vi.fn(),
        onOpenFile: vi.fn(),
        onOpenScene: vi.fn(),
        onOpenMainScene: vi.fn(),
        onStartSession: vi.fn()
    }
    render(
        <InEditorSession session={fakeSession({state, call: call as unknown as GodotCall})}>
            <ExplorerPanel
                tab={tab}
                files={FILES}
                selection={undefined}
                {...handlers}
            />
        </InEditorSession>
    )
    return {call, ...handlers}
}

describe('the explorer column', () => {
    it('draws the scene the editor has open', async () => {
        const {call} = explorer()
        await waitFor(() => {
            expect(screen.getByText('Player')).toBeInTheDocument()
        })
        expect(call).toHaveBeenCalledWith('scene.get_tree', {})
    })

    it('asks nothing of an editor that is not running, and offers to start one', () => {
        const {call, onStartSession} = explorer({state: 'offline'})
        expect(call).not.toHaveBeenCalled()
        expect(screen.getByText('No editor running')).toBeInTheDocument()
        screen.getByRole('button', {name: 'Start Godot'}).click()
        expect(onStartSession).toHaveBeenCalled()
    })

    /**
     * A session that is still coming up answers with nothing, and nothing would refetch it. The
     * panel waits rather than printing "No scene is open" over a project that has one.
     */
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

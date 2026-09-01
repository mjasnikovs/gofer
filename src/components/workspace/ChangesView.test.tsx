import {afterEach, describe, expect, it, vi} from 'vitest'
import {cleanup, render, screen, within} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {ChangesView} from './ChangesView'
import type {MonacoStubState} from '../../test/monaco-stub'
import {createDesktopFake, installDesktopFake, removeDesktopFake} from '../../test/desktop-driver'
import {installBackend} from '../../test/backend'
import type {ChangedFile, FileDiff, TaskChanges} from '../../models/changes'

const tauri = createDesktopFake()

const editor = vi.hoisted(() => ({state: undefined as MonacoStubState | undefined}))

vi.mock('../../services/monaco-runtime', async () => {
    const {createMonacoStub} = await import('../../test/monaco-stub')
    const stub = createMonacoStub()
    editor.state = stub.state
    return {loadMonaco: () => Promise.resolve(stub.monaco)}
})

const BEFORE = 'extends Node\n\nfunc _ready():\n\tpass\n'
const AFTER = 'extends Node2D\n\nfunc _ready():\n\tpass\n'

function file(overrides: Partial<ChangedFile> = {}): ChangedFile {
    return {
        path: 'scripts/player.gd',
        status: 'modified',
        isBinary: false,
        added: 4,
        removed: 1,
        isConflicted: false,
        ...overrides
    }
}

const SCRIPT = file()
const SCENE = file({path: 'scenes/menu.tscn', status: 'added', added: 30, removed: 0})
const SPRITE = file({path: 'art/tiles.png', status: 'added', isBinary: true, added: 0, removed: 0})
const SIDECAR = file({path: 'art/tiles.png.import', status: 'added', added: 6, removed: 0})

function diff(overrides: Partial<FileDiff> = {}): FileDiff {
    return {
        path: SCRIPT.path,
        original: BEFORE,
        modified: AFTER,
        isText: true,
        isTooLarge: false,
        isSubmodule: false,
        ...overrides
    }
}

function show(changes: Partial<TaskChanges> = {}, diffs: Record<string, FileDiff> = {}) {
    const onSideBySideChange = vi.fn()
    installBackend(tauri, {
        changes: {
            files: [SCRIPT, SCENE, SPRITE, SIDECAR],
            dropped: 0,
            isMerging: false,
            ...changes
        },
        diffs: {[SCRIPT.path]: diff(), ...diffs}
    })
    installDesktopFake(tauri)
    render(
        <ChangesView
            isSideBySide
            onSideBySideChange={onSideBySideChange}
        />
    )
    return {onSideBySideChange}
}

afterEach(() => {
    cleanup()
    removeDesktopFake()
    editor.state?.reset()
})

describe('the changes view', () => {
    it('lists what the task changed, with the counts Git gave', async () => {
        show()

        expect(await screen.findByText('scripts/player.gd')).toBeInTheDocument()
        expect(screen.getByText('scenes/menu.tscn')).toBeInTheDocument()
        expect(screen.getByText('+4 −1')).toBeInTheDocument()
        expect(screen.getByText('binary')).toBeInTheDocument()
    })

    /**
     * The sidecar Godot writes beside every asset is not the work, and there are more of them than
     * there is work. Hidden, but behind a control that says how many.
     */
    it('keeps generated sidecars out of the way until they are asked for', async () => {
        show()
        await screen.findByText('scripts/player.gd')

        expect(screen.queryByText('art/tiles.png.import')).not.toBeInTheDocument()
        await userEvent.click(screen.getByRole('button', {name: 'Generated 1'}))

        expect(screen.getByText('art/tiles.png.import')).toBeInTheDocument()
        // The count comes off the whole listing, so the way back is still on screen.
        await userEvent.click(screen.getByRole('button', {name: 'Generated 1'}))
        expect(screen.queryByText('art/tiles.png.import')).not.toBeInTheDocument()
    })

    it('narrows the list to a chosen kind, and puts it back', async () => {
        show()
        await screen.findByText('scripts/player.gd')

        await userEvent.click(screen.getByRole('button', {name: 'Scenes 1'}))
        expect(screen.queryByText('scripts/player.gd')).not.toBeInTheDocument()
        expect(screen.getByText('scenes/menu.tscn')).toBeInTheDocument()

        await userEvent.click(screen.getByRole('button', {name: 'Scenes 1'}))
        expect(screen.getByText('scripts/player.gd')).toBeInTheDocument()
    })

    it('shows a chosen file beside the version the task started from', async () => {
        show()
        await userEvent.click(await screen.findByText('scripts/player.gd'))

        expect(await screen.findByTestId('task-change-diff-host')).toBeInTheDocument()
        expect(editor.state?.diffEditors).toBe(1)
    })

    /**
     * Monaco folds side-by-side back to inline on its own below 900px, which the centre column
     * never reaches, so the choice has to be passed and honoured rather than left to the default.
     */
    it('tells the editor which way to lay the diff out', async () => {
        const {onSideBySideChange} = show()
        await userEvent.click(await screen.findByText('scripts/player.gd'))
        await screen.findByTestId('task-change-diff-host')

        await userEvent.click(screen.getByRole('button', {name: 'Inline'}))

        expect(onSideBySideChange).toHaveBeenCalledWith(false)
    })

    /**
     * Clicking the row that is already open hands React the same object, so it skips the update.
     * A handler that had cleared the diff first would leave the pane loading for ever.
     */
    it('survives clicking the row that is already open', async () => {
        show()
        await userEvent.click(await screen.findByText('scripts/player.gd'))
        await screen.findByTestId('task-change-diff-host')

        await userEvent.click(screen.getByText('scripts/player.gd'))

        expect(screen.getByTestId('task-change-diff-host')).toBeInTheDocument()
        expect(screen.queryByText(/Loading scripts/u)).not.toBeInTheDocument()
    })

    /**
     * A kind keeps its button only while something on screen is that kind. Left filtering after its
     * button went, it would empty the list with no visible filter and no way back.
     */
    it('stops filtering by a kind whose button is no longer there', async () => {
        show()
        await screen.findByText('scripts/player.gd')
        await userEvent.click(screen.getByRole('button', {name: 'Generated 1'}))
        await userEvent.click(screen.getByRole('button', {name: 'Config 1'}))
        expect(screen.getByText('art/tiles.png.import')).toBeInTheDocument()

        await userEvent.click(screen.getByRole('button', {name: 'Generated 1'}))

        expect(screen.queryByRole('button', {name: 'Config 1'})).not.toBeInTheDocument()
        expect(screen.getByText('scripts/player.gd')).toBeInTheDocument()
    })

    /**
     * A task that only touched sidecars has changed files and shows none of them. Measured on the
     * unfiltered listing this drew a bare list with no word about why it was empty.
     */
    it('says so when everything it changed is hidden, rather than drawing a bare list', async () => {
        show({files: [SIDECAR]})

        expect(await screen.findByText('Nothing matches')).toBeInTheDocument()
        await userEvent.click(screen.getByRole('button', {name: 'Generated 1'}))
        expect(screen.getByText('art/tiles.png.import')).toBeInTheDocument()
    })

    it('says why a binary file has no diff, rather than drawing an empty one', async () => {
        show(
            {},
            {[SPRITE.path]: diff({path: SPRITE.path, isText: false, original: '', modified: ''})}
        )
        await userEvent.click(await screen.findByText('art/tiles.png'))

        expect(await screen.findByText(/not text/u)).toBeInTheDocument()
        expect(screen.queryByTestId('task-change-diff-host')).not.toBeInTheDocument()
    })

    it('says a submodule change is a commit pointer rather than failing to read it', async () => {
        show({}, {[SCENE.path]: diff({path: SCENE.path, isSubmodule: true, isText: false})})
        await userEvent.click(await screen.findByText('scenes/menu.tscn'))

        expect(await screen.findByText(/submodule/u)).toBeInTheDocument()
        expect(screen.queryByTestId('task-change-diff-host')).not.toBeInTheDocument()
    })

    it('says why a very large file has no diff', async () => {
        show(
            {},
            {[SCENE.path]: diff({path: SCENE.path, isTooLarge: true, original: '', modified: ''})}
        )
        await userEvent.click(await screen.findByText('scenes/menu.tscn'))

        expect(await screen.findByText(/too large/u)).toBeInTheDocument()
    })

    /**
     * Mid-merge the files hold Git's markers, not the task's work, so the view has to say so
     * rather than present a diff of something nobody wrote.
     */
    it('warns while a merge is open, and marks the files it left', async () => {
        show({
            files: [file({isConflicted: true})],
            isMerging: true
        })

        expect(await screen.findByText(/part-way through a merge/u)).toBeInTheDocument()
        expect(screen.getByText('conflicted')).toBeInTheDocument()
    })

    /**
     * Reopening a file that failed once must not show that failure again before the fresh read has
     * answered. The banner belongs to the opening that asked for it, not to the path.
     */
    it('does not show the last failure again when a file is reopened', async () => {
        let attempts = 0
        installBackend(tauri, {
            changes: {files: [SCRIPT, SCENE], dropped: 0, isMerging: false},
            diffs: {[SCRIPT.path]: diff()},
            answers: {
                read_task_change: async (request, fall) => {
                    if (request.path !== SCENE.path) return await fall()
                    attempts += 1
                    if (attempts === 1) throw new Error('busy')
                    return diff({path: SCENE.path})
                }
            }
        })
        installDesktopFake(tauri)
        render(
            <ChangesView
                isSideBySide
                onSideBySideChange={vi.fn()}
            />
        )
        await userEvent.click(await screen.findByText('scenes/menu.tscn'))
        await screen.findByText(/could not be read/u)
        await userEvent.click(screen.getByText('scripts/player.gd'))

        await userEvent.click(screen.getByText('scenes/menu.tscn'))

        expect(await screen.findByTestId('task-change-diff-host')).toBeInTheDocument()
        expect(screen.queryByText(/could not be read/u)).not.toBeInTheDocument()
    })

    /** A diff left on screen under a list that no longer holds its row says the two disagree. */
    it('puts the diff away when the filter hides the file it belongs to', async () => {
        show()
        await userEvent.click(await screen.findByText('scripts/player.gd'))
        await screen.findByTestId('task-change-diff-host')

        await userEvent.click(screen.getByRole('button', {name: 'Scenes 1'}))

        expect(screen.queryByTestId('task-change-diff-host')).not.toBeInTheDocument()
        expect(screen.getByText(/Choose a file/u)).toBeInTheDocument()
    })

    /**
     * Refresh clears what is open, so the counter that tells one opening from the next must not go
     * back to where it started — a failure from before would answer for the file opened after.
     */
    it('does not carry a failure across a refresh onto the next file', async () => {
        installBackend(tauri, {
            changes: {files: [SCRIPT, SCENE], dropped: 0, isMerging: false},
            diffs: {[SCRIPT.path]: diff()}
        })
        installDesktopFake(tauri)
        render(
            <ChangesView
                isSideBySide
                onSideBySideChange={vi.fn()}
            />
        )
        await userEvent.click(await screen.findByText('scenes/menu.tscn'))
        await screen.findByText(/could not be read/u)

        await userEvent.click(screen.getByRole('button', {name: 'Refresh'}))
        await userEvent.click(await screen.findByText('scripts/player.gd'))

        expect(await screen.findByTestId('task-change-diff-host')).toBeInTheDocument()
        expect(screen.queryByText(/could not be read/u)).not.toBeInTheDocument()
    })

    /** The group deselects on a second click. A layout has to stay one of the two. */
    it('keeps the layout when the button already showing it is pressed', async () => {
        const {onSideBySideChange} = show()
        await screen.findByText('scripts/player.gd')

        await userEvent.click(screen.getByRole('button', {name: 'Split'}))

        expect(onSideBySideChange).not.toHaveBeenCalledWith(false)
    })

    it('says how many rows the cap left out', async () => {
        show({dropped: 25})

        expect(await screen.findByText(/25 more changed files/u)).toBeInTheDocument()
    })

    it('has an empty state for a task that has changed nothing', async () => {
        show({files: []})

        expect(await screen.findByText('Nothing has changed yet')).toBeInTheDocument()
    })

    it('reports a listing it could not read', async () => {
        installBackend(tauri, {
            answers: {
                list_task_changes: () => {
                    throw new Error('no repository')
                }
            }
        })
        installDesktopFake(tauri)
        render(
            <ChangesView
                isSideBySide
                onSideBySideChange={vi.fn()}
            />
        )

        expect(await screen.findByText(/could not be read/u)).toBeInTheDocument()
    })

    it('reports one file it could not read without losing the list', async () => {
        show()
        await userEvent.click(await screen.findByText('scenes/menu.tscn'))

        const banner = await screen.findByText(/could not be read/u)
        expect(banner).toBeInTheDocument()
        expect(within(screen.getByRole('list')).getByText('scripts/player.gd')).toBeInTheDocument()
    })

    /** A failure belongs to the row that asked for it, not to whichever row is open when it lands. */
    it('does not blame the next file for the last one\u2019s failure', async () => {
        show()
        await userEvent.click(await screen.findByText('scenes/menu.tscn'))
        await screen.findByText(/could not be read/u)

        await userEvent.click(screen.getByText('scripts/player.gd'))

        expect(await screen.findByTestId('task-change-diff-host')).toBeInTheDocument()
        expect(screen.queryByText(/could not be read/u)).not.toBeInTheDocument()
    })
})

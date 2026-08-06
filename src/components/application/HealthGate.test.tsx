import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {cleanup, render, screen, waitFor} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import axe from 'axe-core'
import {HealthGate} from './HealthGate'
import type {HealthReport} from '../../models/health'

type InvokeFunction = (command: string, args?: unknown) => Promise<unknown>
type IsTauriFunction = () => boolean

const tauri = vi.hoisted(() => ({
    invoke: vi.fn<InvokeFunction>(),
    isTauri: vi.fn<IsTauriFunction>(),
    listen: vi.fn()
}))

vi.mock('../../services/desktop', () => ({
    invoke: tauri.invoke,
    isTauri: tauri.isTauri,
    listen: tauri.listen
}))

/** The report an empty folder produces: no repository, no project, and a fix for each. */
const emptyFolder: HealthReport = {
    workspace: '/home/dev/game',
    workspaceSource: 'working-directory',
    isReady: false,
    checks: [
        {
            id: 'git-repository',
            title: 'Git repository',
            status: 'blocked',
            detail: '/home/dev/game is not a Git repository.',
            remedy: {
                action: 'initialize-git-repository',
                label: 'Initialize a Git repository',
                description: 'Runs git init in this folder.',
                input: 'none'
            }
        },
        {
            id: 'godot-project',
            title: 'Godot project',
            status: 'blocked',
            detail: '/home/dev/game has no project.godot.',
            remedy: {
                action: 'create-godot-project',
                label: 'Create a starter Godot project',
                description: 'Writes project.godot and main.tscn here.',
                input: 'none'
            }
        },
        {
            id: 'formatter',
            title: 'GDScript formatter',
            status: 'degraded',
            detail: 'Formatting is disabled.'
        }
    ]
}

const readyWorkspace: HealthReport = {
    workspace: '/home/dev/game',
    workspaceSource: 'configured',
    isReady: true,
    checks: [
        {
            id: 'git-repository',
            title: 'Git repository',
            status: 'ok',
            detail: '/home/dev/game is a Git repository.'
        }
    ]
}

beforeEach(() => {
    tauri.isTauri.mockReturnValue(true)
})

afterEach(() => {
    cleanup()
    vi.clearAllMocks()
})

describe('HealthGate', () => {
    it('opens straight into the workspace when nothing is wrong', async () => {
        tauri.invoke.mockResolvedValue(readyWorkspace)
        const onReady = vi.fn()

        const {container} = render(<HealthGate onReady={onReady} />)

        await waitFor(() => {
            expect(onReady).toHaveBeenCalled()
        })
        // A healthy workspace must not flash a checklist on the way past.
        expect(container).toBeEmptyDOMElement()
    })

    it('names every blocking problem and offers the fix for it', async () => {
        tauri.invoke.mockResolvedValue(emptyFolder)

        render(<HealthGate onReady={vi.fn()} />)

        expect(await screen.findByText('Git repository')).toBeInTheDocument()
        expect(screen.getByText('/home/dev/game is not a Git repository.')).toBeInTheDocument()
        expect(
            screen.getByRole('button', {name: 'Initialize a Git repository'})
        ).toBeInTheDocument()
        expect(
            screen.getByRole('button', {name: 'Create a starter Godot project'})
        ).toBeInTheDocument()
        expect(screen.getByText(/2 things need your attention/)).toBeInTheDocument()
    })

    it('applies a fix and continues once the last blocker is gone', async () => {
        const user = userEvent.setup()
        tauri.invoke.mockResolvedValueOnce(emptyFolder).mockResolvedValueOnce(readyWorkspace)
        const onReady = vi.fn()

        render(<HealthGate onReady={onReady} />)
        await user.click(await screen.findByRole('button', {name: 'Initialize a Git repository'}))

        expect(tauri.invoke).toHaveBeenLastCalledWith('apply_health_remedy', {
            request: {action: 'initialize-git-repository'}
        })
        await waitFor(() => {
            expect(onReady).toHaveBeenCalled()
        })
    })

    it('asks for a folder before applying a fix that needs one', async () => {
        const user = userEvent.setup()
        const chooseWorkspace: HealthReport = {
            ...emptyFolder,
            checks: [
                {
                    id: 'workspace',
                    title: 'Project folder',
                    status: 'blocked',
                    detail: 'Gofer could not open /home/dev/game.',
                    remedy: {
                        action: 'choose-workspace',
                        label: 'Choose project folder…',
                        description: 'Pick the folder holding your game.',
                        input: 'directory'
                    }
                }
            ]
        }
        tauri.invoke.mockImplementation(command => {
            if (command === 'plugin:dialog|open') return Promise.resolve('/home/dev/other')
            if (command === 'apply_health_remedy') return Promise.resolve(readyWorkspace)
            return Promise.resolve(chooseWorkspace)
        })

        render(<HealthGate onReady={vi.fn()} />)
        await user.click(await screen.findByRole('button', {name: 'Choose project folder…'}))

        await waitFor(() => {
            expect(tauri.invoke).toHaveBeenCalledWith('apply_health_remedy', {
                request: {action: 'choose-workspace', path: '/home/dev/other'}
            })
        })
    })

    it('leaves the workspace alone when the folder picker is cancelled', async () => {
        const user = userEvent.setup()
        const workspaceOnly: HealthReport = {
            ...emptyFolder,
            checks: [
                {
                    id: 'workspace',
                    title: 'Project folder',
                    status: 'blocked',
                    detail: 'Gofer could not open /home/dev/game.',
                    remedy: {
                        action: 'choose-workspace',
                        label: 'Choose project folder…',
                        description: 'Pick the folder holding your game.',
                        input: 'directory'
                    }
                }
            ]
        }
        tauri.invoke.mockImplementation(command => {
            if (command === 'plugin:dialog|open') return Promise.resolve(null)
            return Promise.resolve(workspaceOnly)
        })

        render(<HealthGate onReady={vi.fn()} />)
        await user.click(await screen.findByRole('button', {name: 'Choose project folder…'}))

        await waitFor(() => {
            expect(tauri.invoke).toHaveBeenCalledWith('plugin:dialog|open', expect.anything())
        })
        expect(tauri.invoke).not.toHaveBeenCalledWith(
            'apply_health_remedy',
            expect.objectContaining({})
        )
    })

    it('reports a fix that failed without losing the checklist', async () => {
        const user = userEvent.setup()
        tauri.invoke.mockImplementation(command => {
            if (command === 'apply_health_remedy') {
                return Promise.reject(new Error('Could not create the first commit: read-only'))
            }
            return Promise.resolve(emptyFolder)
        })

        render(<HealthGate onReady={vi.fn()} />)
        await user.click(await screen.findByRole('button', {name: 'Initialize a Git repository'}))

        expect(await screen.findByText(/read-only/)).toBeInTheDocument()
        expect(screen.getByText('Git repository')).toBeInTheDocument()
    })

    it('never gates the browser-driven suites, which have no workspace', async () => {
        tauri.isTauri.mockReturnValue(false)
        const onReady = vi.fn()

        render(<HealthGate onReady={onReady} />)

        await waitFor(() => {
            expect(onReady).toHaveBeenCalled()
        })
        expect(tauri.invoke).not.toHaveBeenCalled()
    })

    it('has no automatically detectable accessibility violations', async () => {
        tauri.invoke.mockResolvedValue(emptyFolder)

        const {container} = render(<HealthGate onReady={vi.fn()} />)
        await screen.findByText('Git repository')

        const result = await axe.run(container)

        expect(result.violations).toEqual([])
    })
})

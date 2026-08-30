import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {act, cleanup, render, screen} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import axe from 'axe-core'
import {HealthGate} from './HealthGate'
import type {HealthReport} from '../../models/health'
import {createDesktopFake, installDesktopFake, removeDesktopFake} from '../../test/desktop-driver'
import {flush} from '../../test/flush'
import {CommandFailure, installBackend} from '../../test/backend'
import {createManualScheduler, setScheduler, timerScheduler} from '../../services/clock'

const tauri = createDesktopFake()

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

let clock = createManualScheduler()

beforeEach(() => {
    installDesktopFake(tauri)
    clock = createManualScheduler()
    setScheduler(clock.schedule)
})

afterEach(() => {
    cleanup()
    removeDesktopFake()
    setScheduler(timerScheduler)
    vi.clearAllMocks()
})

describe('HealthGate', () => {
    it('opens straight into the workspace when nothing is wrong', async () => {
        installBackend(tauri, {health: readyWorkspace})
        const onReady = vi.fn()

        const {container} = render(<HealthGate onReady={onReady} />)
        await flush()

        expect(onReady).toHaveBeenCalled()
        expect(container).toBeEmptyDOMElement()
    })

    it('says the check is running once it has taken a while', async () => {
        installBackend(tauri, {
            answers: {check_workspace_health: () => new Promise(() => undefined)}
        })

        render(<HealthGate onReady={vi.fn()} />)
        await flush()
        expect(screen.queryByRole('status')).not.toBeInTheDocument()

        await act(async () => {
            clock.run()
        })

        expect(screen.getByLabelText('Checking this project…')).toBeInTheDocument()
    })

    it('names every blocking problem and offers the fix for it', async () => {
        installBackend(tauri, {health: emptyFolder})

        render(<HealthGate onReady={vi.fn()} />)
        await flush()

        expect(screen.getByText('Git repository')).toBeInTheDocument()
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
        const onReady = vi.fn()
        const server = installBackend(tauri, {
            health: emptyFolder,
            answers: {
                apply_health_remedy: (_, answer) => {
                    server.state.health = readyWorkspace
                    return answer()
                }
            }
        })

        render(<HealthGate onReady={onReady} />)
        await flush()
        expect(screen.getByText('Git repository')).toBeInTheDocument()
        await user.click(screen.getByRole('button', {name: 'Initialize a Git repository'}))
        await flush()

        expect(onReady).toHaveBeenCalled()
        expect(screen.queryByText('Git repository')).not.toBeInTheDocument()
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
        const server = installBackend(tauri, {
            health: chooseWorkspace,
            answers: {
                'plugin:dialog|open': () => '/home/dev/other',
                apply_health_remedy: ({request}) => {
                    if (request.path === '/home/dev/other') server.state.health = readyWorkspace
                    return server.state.health
                }
            }
        })

        render(<HealthGate onReady={vi.fn()} />)
        await flush()
        await user.click(screen.getByRole('button', {name: 'Choose project folder…'}))
        await flush()

        expect(screen.queryByText('Project folder')).not.toBeInTheDocument()
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
        installBackend(tauri, {
            health: workspaceOnly,
            answers: {'plugin:dialog|open': () => null}
        })

        render(<HealthGate onReady={vi.fn()} />)
        await flush()
        await user.click(screen.getByRole('button', {name: 'Choose project folder…'}))
        await flush()

        expect(tauri.invoke).toHaveBeenCalledWith('plugin:dialog|open', expect.anything())
        expect(tauri.invoke).not.toHaveBeenCalledWith(
            'apply_health_remedy',
            expect.objectContaining({})
        )
    })

    it('reports a fix that failed without losing the checklist', async () => {
        const user = userEvent.setup()
        installBackend(tauri, {
            health: emptyFolder,
            answers: {
                apply_health_remedy: () => {
                    throw new CommandFailure(
                        'workspace_not_repaired',
                        'Could not create the first commit: read-only'
                    )
                }
            }
        })

        render(<HealthGate onReady={vi.fn()} />)
        await flush()
        await user.click(screen.getByRole('button', {name: 'Initialize a Git repository'}))
        await flush()

        expect(screen.getByText(/read-only/)).toBeInTheDocument()
        expect(screen.getByText('Git repository')).toBeInTheDocument()
    })

    it('never gates the browser-driven suites, which have no workspace', async () => {
        installBackend(tauri, {health: readyWorkspace})
        tauri.isTauri.mockReturnValue(false)
        const onReady = vi.fn()

        render(<HealthGate onReady={onReady} />)
        await flush()

        expect(onReady).toHaveBeenCalled()
        expect(tauri.invoke).not.toHaveBeenCalled()
    })

    it('has no automatically detectable accessibility violations', async () => {
        installBackend(tauri, {health: emptyFolder})

        const {container} = render(<HealthGate onReady={vi.fn()} />)
        await flush()
        expect(screen.getByText('Git repository')).toBeInTheDocument()

        const result = await axe.run(container)

        expect(result.violations).toEqual([])
    })
})

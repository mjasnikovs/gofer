import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {cleanup, render, screen} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {SkillsView} from './SkillsView'
import {createDesktopFake, installDesktopFake, removeDesktopFake} from '../../test/desktop-driver'
import {flush, flushUntil} from '../../test/flush'
import {installBackend} from '../../test/backend'
import type {Skill} from '../../models/skills'

const tauri = createDesktopFake()

function skill(overrides: Partial<Skill> = {}): Skill {
    return {
        name: 'tile-levels',
        description: 'How to build a 2D level from tiles',
        path: '/project/.gofer/skills/tile-levels/SKILL.md',
        enabled: true,
        hidden: false,
        ...overrides
    }
}

const SOUND = skill({
    name: 'sound-design',
    description: 'Where the audio buses go',
    path: '/project/.gofer/skills/sound-design/SKILL.md',
    enabled: false
})

function backend(rows: readonly Skill[] = [skill(), SOUND]) {
    return installBackend(tauri, {
        skills: rows.map(one => ({skill: one, text: `---\ndescription: ${one.description}\n---\n`}))
    })
}

async function open() {
    render(<SkillsView />)
    await flushUntil(() => screen.queryAllByText('tile-levels').length > 0)
    await flush()
}

beforeEach(() => {
    installDesktopFake(tauri)
})

afterEach(() => {
    cleanup()
    removeDesktopFake()
    tauri.invoke.mockReset()
})

describe('the skills panel', () => {
    it('names every skill with the description the agent matches against', async () => {
        backend()
        await open()

        expect(screen.getByText('tile-levels')).toBeInTheDocument()
        expect(screen.getByText('How to build a 2D level from tiles')).toBeInTheDocument()
        expect(screen.getByText('sound-design')).toBeInTheDocument()
        expect(screen.getByText('Where the audio buses go')).toBeInTheDocument()
    })

    it('says what is missing when a skill has no description', async () => {
        backend([skill({description: ''})])
        await open()

        expect(
            screen.getByText('No description, so the agent has nothing to match against.')
        ).toBeInTheDocument()
    })

    it('turns a skill off through the backend, not in the row', async () => {
        backend()
        await open()
        const user = userEvent.setup()

        await user.click(screen.getByRole('switch', {name: 'Send tile-levels to the agent'}))
        await flush()

        expect(tauri.invoke).toHaveBeenCalledWith(
            'set_skill_enabled',
            expect.objectContaining({name: 'tile-levels', enabled: false})
        )
    })

    it('shows a skill its own file hides, and does not offer to turn it on', async () => {
        backend([skill({hidden: true, enabled: false})])
        await open()

        expect(screen.getByText('Hidden by the file')).toBeInTheDocument()
        expect(screen.getByRole('switch', {name: 'Send tile-levels to the agent'})).toBeDisabled()
    })

    it('explains a file under the skills directory the loader complained about', async () => {
        installBackend(tauri, {
            skills: [{skill: skill(), text: 'x'}],
            answers: {
                list_skills: () => ({
                    skills: [skill()],
                    warnings: [
                        {
                            code: 'invalid_metadata',
                            message: 'description is required',
                            path: '/project/.gofer/skills/half-written/SKILL.md'
                        }
                    ]
                })
            }
        })
        await open()

        expect(screen.getByText('One file needs attention')).toBeInTheDocument()
        expect(screen.getByText(/description is required/u)).toBeInTheDocument()
    })

    it('offers to add a single file and tells the picker what a skill is', async () => {
        installBackend(tauri, {
            skills: [{skill: skill(), text: 'x'}],
            answers: {'plugin:dialog|open': () => '/home/someone/tile-levels.md'}
        })
        await open()
        const user = userEvent.setup()

        await user.click(screen.getByRole('button', {name: 'Add file…'}))
        await flush()

        const opened = tauri.invoke.mock.calls.find(call => call[0] === 'plugin:dialog|open')
        expect(opened?.[1]).toMatchObject({
            options: {filters: [{name: 'Skill', extensions: ['md']}]}
        })
        expect(tauri.invoke).toHaveBeenCalledWith(
            'import_skill',
            expect.objectContaining({sourcePath: '/home/someone/tile-levels.md'})
        )
    })

    it('offers to add a whole skill folder through a directory picker', async () => {
        installBackend(tauri, {
            skills: [{skill: skill(), text: 'x'}],
            answers: {'plugin:dialog|open': () => '/home/someone/godot-pixel-camera'}
        })
        await open()
        const user = userEvent.setup()

        await user.click(screen.getByRole('button', {name: 'Add folder…'}))
        await flush()

        const opened = tauri.invoke.mock.calls.find(call => call[0] === 'plugin:dialog|open')
        expect(opened?.[1]).toMatchObject({options: {directory: true}})
        expect(tauri.invoke).toHaveBeenCalledWith(
            'import_skill',
            expect.objectContaining({sourcePath: '/home/someone/godot-pixel-camera'})
        )
    })

    it('adds nothing when the picker is dismissed', async () => {
        installBackend(tauri, {
            skills: [{skill: skill(), text: 'x'}],
            answers: {'plugin:dialog|open': () => null}
        })
        await open()
        const user = userEvent.setup()

        await user.click(screen.getByRole('button', {name: 'Add file…'}))
        await flush()

        expect(tauri.invoke).not.toHaveBeenCalledWith('import_skill', expect.anything())
    })

    it('reads a skill before opening it for editing', async () => {
        backend()
        await open()
        const user = userEvent.setup()

        await user.click(screen.getByRole('button', {name: 'Edit tile-levels'}))
        await flush()

        expect(tauri.invoke).toHaveBeenCalledWith(
            'read_skill',
            expect.objectContaining({name: 'tile-levels'})
        )
        expect(screen.getByRole('button', {name: 'Save'})).toBeInTheDocument()
    })

    it('asks before deleting, and deletes only on the second press', async () => {
        backend()
        await open()
        const user = userEvent.setup()

        await user.click(screen.getByRole('button', {name: 'Delete tile-levels'}))
        await flush()

        expect(tauri.invoke).not.toHaveBeenCalledWith('delete_skill', expect.anything())
        expect(screen.getByText('Delete tile-levels?')).toBeInTheDocument()

        await user.click(screen.getByRole('button', {name: 'Delete'}))
        await flush()

        expect(tauri.invoke).toHaveBeenCalledWith(
            'delete_skill',
            expect.objectContaining({name: 'tile-levels'})
        )
    })

    it('deletes nothing when the question is cancelled', async () => {
        backend()
        await open()
        const user = userEvent.setup()

        await user.click(screen.getByRole('button', {name: 'Delete tile-levels'}))
        await flush()
        await user.click(screen.getByRole('button', {name: 'Cancel'}))
        await flush()

        expect(tauri.invoke).not.toHaveBeenCalledWith('delete_skill', expect.anything())
        expect(screen.queryByText('Delete tile-levels?')).not.toBeInTheDocument()
    })

    it('says a project has no skills rather than showing an empty list', async () => {
        backend([])
        render(<SkillsView />)
        await flushUntil(() => screen.queryAllByText('No skills yet').length > 0)

        expect(screen.getByText('No skills yet')).toBeInTheDocument()
    })
})

vi.mock('./SkillEditor', () => ({SkillEditor: () => null}))

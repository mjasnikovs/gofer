import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {cleanup, render, screen} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {NewTaskDialog} from './NewTaskDialog'
import type {PendingChange} from '../../models/app'
import {listPendingChanges} from '../../services/task-actions'

vi.mock('../../services/task-actions', () => ({listPendingChanges: vi.fn(async () => [])}))

const loose = vi.mocked(listPendingChanges)

beforeEach(() => {
    loose.mockResolvedValue([])
})

afterEach(cleanup)

const show = () => {
    const onPlan = vi.fn<(prompt: string, bringChanges: boolean) => void>()
    const onSkip = vi.fn<(prompt: string, bringChanges: boolean) => void>()
    const onOpenChange = vi.fn<(isOpen: boolean) => void>()
    const view = render(
        <NewTaskDialog
            isOpen
            onOpenChange={onOpenChange}
            onPlan={onPlan}
            onSkip={onSkip}
        />
    )
    return {onPlan, onSkip, onOpenChange, view}
}

const askBox = () => screen.getByRole('textbox', {name: /What needs doing/u})
const planButton = () => screen.getByRole('button', {name: 'Plan it'})
const skipButton = () => screen.getByRole('button', {name: 'Skip planning'})

describe('making a task', () => {
    /*
     * The dialog IS the plan, and the plan is what the user cannot ask for later: the four phases
     * run against the ask before there is a first turn, so the ask has to be taken here.
     */
    it('plans the task from the ask', async () => {
        const {onPlan, onSkip} = show()

        await userEvent.type(askBox(), 'add a pause menu')
        await userEvent.click(planButton())

        expect(onPlan).toHaveBeenCalledWith('add a pause menu', false)
        expect(onSkip).not.toHaveBeenCalled()
    })

    /*
     * The way out, and the reason it is not just Cancel: the task is still made and its empty chat
     * still opens. The user is put in front of the composer they already know.
     */
    it('makes the task without planning it when planning is skipped', async () => {
        const {onPlan, onSkip, onOpenChange} = show()

        await userEvent.click(skipButton())

        expect(onSkip).toHaveBeenCalledWith('', false)
        expect(onPlan).not.toHaveBeenCalled()
        expect(onOpenChange).toHaveBeenCalledWith(false)
    })

    // Changing your mind about the plan must not cost you the sentence you already wrote.
    it('carries whatever was typed over to the chat when planning is skipped', async () => {
        const {onSkip} = show()

        await userEvent.type(askBox(), 'add a pause menu')
        await userEvent.click(skipButton())

        expect(onSkip).toHaveBeenCalledWith('add a pause menu', false)
    })

    // Only the plan needs one. Skipping is how a user gets to an empty chat with nothing to say yet.
    it('refuses to plan nothing, and still offers to skip', async () => {
        show()
        expect(planButton()).toBeDisabled()
        expect(skipButton()).toBeEnabled()

        await userEvent.type(askBox(), '   ')
        expect(planButton()).toBeDisabled()
    })

    it('says nothing about loose files when there are none', async () => {
        show()
        await userEvent.type(askBox(), 'add a pause menu')

        expect(screen.queryByText(/not committed yet/u)).not.toBeInTheDocument()
    })

    /*
     * The regression this dialog exists for.
     *
     * Files the user copied into the project by hand were committed onto the task being closed and
     * then taken off disk by the checkout, with nothing anywhere saying so.
     */
    it('keeps copied-in files by default, and names them', async () => {
        const copied: PendingChange[] = [
            {path: 'assets/Tileset/tileset.png', isNew: true},
            {path: 'assets/UI/icon-set.png', isNew: true}
        ]
        loose.mockResolvedValue(copied)
        const {onPlan} = show()

        expect(await screen.findByText('2 files are not committed yet')).toBeInTheDocument()
        expect(screen.getByText('assets/Tileset/tileset.png')).toBeInTheDocument()

        await userEvent.type(askBox(), 'build the map')
        await userEvent.click(planButton())

        expect(onPlan).toHaveBeenCalledWith('build the map', true)
    })

    // An edited file could be the closing task's own work, so that answer is not assumed.
    it('asks cold when a tracked file was edited', async () => {
        loose.mockResolvedValue([{path: 'main.tscn', isNew: false}])
        const {onPlan} = show()

        expect(await screen.findByText('1 file is not committed yet')).toBeInTheDocument()

        await userEvent.type(askBox(), 'build the map')
        await userEvent.click(planButton())

        expect(onPlan).toHaveBeenCalledWith('build the map', false)
    })

    // The answer holds whichever way out of the dialog is taken.
    it('takes the other answer when it is chosen, and skipping honours it too', async () => {
        loose.mockResolvedValue([{path: 'assets/tile.png', isNew: true}])
        const {onSkip} = show()

        await userEvent.click(await screen.findByText('Leave them on the current task'))
        await userEvent.type(askBox(), 'build the map')
        await userEvent.click(skipButton())

        expect(onSkip).toHaveBeenCalledWith('build the map', false)
    })

    it('makes nothing when it is cancelled', async () => {
        const {onPlan, onSkip, onOpenChange} = show()

        await userEvent.type(askBox(), 'add a pause menu')
        await userEvent.click(screen.getByRole('button', {name: 'Cancel'}))

        expect(onPlan).not.toHaveBeenCalled()
        expect(onSkip).not.toHaveBeenCalled()
        expect(onOpenChange).toHaveBeenCalledWith(false)
    })
})

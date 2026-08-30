import {afterEach, describe, expect, it, vi} from 'vitest'
import {cleanup, render, screen} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {NewTaskDialog} from './NewTaskDialog'
import type {PendingChange} from '../../models/app'

afterEach(cleanup)

const COPIED: readonly PendingChange[] = [
    {path: 'assets/Tileset/tileset.png', isNew: true},
    {path: 'assets/UI/icon-set.png', isNew: true}
]

const show = (changes: readonly PendingChange[]) => {
    const onCreate = vi.fn<(bringChanges: boolean) => void>()
    const onOpenChange = vi.fn<(isOpen: boolean) => void>()
    const view = render(
        <NewTaskDialog
            isOpen
            changes={changes}
            onOpenChange={onOpenChange}
            onCreate={onCreate}
        />
    )
    return {onCreate, onOpenChange, view}
}

const createButton = () => screen.getByRole('button', {name: 'Create task'})

describe('making a task', () => {
    it('does not ask what the task is', () => {
        show(COPIED)

        expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
        expect(screen.queryByRole('button', {name: /plan/iu})).not.toBeInTheDocument()
    })

    it('keeps copied-in files by default, and names them', async () => {
        const {onCreate} = show(COPIED)

        expect(screen.getByText('2 files are not committed yet')).toBeInTheDocument()
        expect(screen.getByText('assets/Tileset/tileset.png')).toBeInTheDocument()

        await userEvent.click(createButton())

        expect(onCreate).toHaveBeenCalledWith(true)
    })

    it('asks cold when a tracked file was edited', async () => {
        const {onCreate} = show([{path: 'main.tscn', isNew: false}])

        expect(screen.getByText('1 file is not committed yet')).toBeInTheDocument()

        await userEvent.click(createButton())

        expect(onCreate).toHaveBeenCalledWith(false)
    })

    it('takes the other answer when it is chosen', async () => {
        const {onCreate} = show([{path: 'assets/tile.png', isNew: true}])

        await userEvent.click(screen.getByText('Leave them on the current task'))
        await userEvent.click(createButton())

        expect(onCreate).toHaveBeenCalledWith(false)
    })

    it('makes nothing when it is cancelled', async () => {
        const {onCreate, onOpenChange} = show(COPIED)

        await userEvent.click(screen.getByRole('button', {name: 'Cancel'}))

        expect(onCreate).not.toHaveBeenCalled()
        expect(onOpenChange).toHaveBeenCalledWith(false)
    })
})

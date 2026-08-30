import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {useState} from 'react'
import {cleanup, render, screen, waitFor, within} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {ChatComposer, ChatComposerInput} from '@astryxdesign/core/Chat'
import {useFileMentionTrigger} from './useFileMentionTrigger'
import {createDesktopFake, installDesktopFake, removeDesktopFake} from '../test/desktop-driver'
import {installBackend} from '../test/backend'
import {flush} from '../test/flush'
import {resetThumbnails} from '../services/file-thumbnails'

const tauri = createDesktopFake()

const FILES = [
    {path: 'docs/TASK_CHECKLIST.md', bytes: 120},
    {path: 'scripts/player.gd', bytes: 200},
    {path: 'scripts/enemy_base.gd', bytes: 300},
    {path: 'scripts/ui/hud.gd', bytes: 150},
    {path: 'project.godot', bytes: 40},
    {path: 'My Notes/plan.md', bytes: 60},
    {path: 'sprites/hero.png', bytes: 900},
    {path: 'sprites/hero.tga', bytes: 900}
]

const SQUARE = 'data:image/png;base64,AAAA'
const THUMBNAILS = {'sprites/hero.png': SQUARE, 'sprites/hero.tga': SQUARE}

function Composer({onSubmit}: {onSubmit: (value: string) => void}) {
    const [draft, setDraft] = useState('')
    const mentions = useFileMentionTrigger()
    return (
        <ChatComposer
            value={draft}
            onChange={setDraft}
            onSubmit={onSubmit}
            input={<ChatComposerInput triggers={[mentions]} />}
        />
    )
}

async function composer() {
    installBackend(tauri, {files: FILES, thumbnails: THUMBNAILS})
    const onSubmit = vi.fn<(value: string) => void>()
    render(<Composer onSubmit={onSubmit} />)
    await flush()
    return {onSubmit, editable: screen.getByRole('combobox'), user: userEvent.setup()}
}

const squares = () => [...screen.getByRole('listbox').querySelectorAll('img')]

const rows = () =>
    within(screen.getByRole('listbox'))
        .queryAllByRole('option')
        .map(row => row.textContent)

describe('the @ menu', () => {
    beforeEach(() => {
        installDesktopFake(tauri)
    })

    afterEach(() => {
        cleanup()
        removeDesktopFake()
        tauri.invoke.mockReset()
        resetThumbnails()
    })

    it('shows the matching files as they are typed, without a pass through "Searching…"', async () => {
        const {user, editable} = await composer()
        await user.click(editable)
        await user.type(editable, '@task')
        const menu = screen.getByRole('listbox')
        expect(menu).not.toHaveTextContent('Searching')
        expect(within(menu).getByRole('option', {name: /TASK_CHECKLIST\.md/})).toBeInTheDocument()
    })

    it('takes the Enter that follows the last letter typed, instead of sending the message', async () => {
        const {user, editable, onSubmit} = await composer()
        await user.click(editable)
        await user.type(editable, '@task{Enter}')
        expect(onSubmit).not.toHaveBeenCalled()
        await user.type(editable, '{Enter}')
        expect(onSubmit).toHaveBeenCalledWith('@docs/TASK_CHECKLIST.md')
    })

    it('offers the folders first when nothing has been typed yet', async () => {
        const {user, editable} = await composer()
        await user.click(editable)
        await user.type(editable, '@')
        expect(rows().slice(0, 3)).toEqual(['docs/', 'My Notes/', 'scripts/'])
        expect(rows()).toContain('project.godot')
    })

    it('steps into a folder and lists what is inside it', async () => {
        const {user, editable} = await composer()
        await user.click(editable)
        await user.type(editable, '@scripts{Enter}')
        await waitFor(() => {
            expect(rows()).toContain('hud.gdscripts/ui')
        })
        expect(rows()).toEqual([
            'ui/scripts',
            'enemy_base.gdscripts',
            'player.gdscripts',
            'hud.gdscripts/ui'
        ])
        expect(editable).toHaveTextContent('@scripts/')
    })

    it('draws a picture beside a picture, and a kind icon beside everything else', async () => {
        const {user, editable} = await composer()
        await user.click(editable)
        await user.type(editable, '@hero')
        await waitFor(() => {
            expect(squares()).toHaveLength(2)
        })
        for (const square of squares()) expect(square.getAttribute('src')).toBe(SQUARE)

        await user.clear(editable)
        await user.type(editable, '@player.gd')
        await flush()
        expect(squares()).toHaveLength(0)
    })

    it('ends the mention on a folder whose name holds a space', async () => {
        const {user, editable, onSubmit} = await composer()
        await user.click(editable)
        await user.type(editable, '@my{Enter}')
        await flush()
        expect(screen.queryByRole('listbox')).toBeNull()
        await user.keyboard('{Enter}')
        expect(onSubmit).toHaveBeenCalledWith('@"My Notes/"')
    })

    it('keeps stepping, and ends on the file that is picked', async () => {
        const {user, editable, onSubmit} = await composer()
        await user.click(editable)
        await user.type(editable, '@scripts{Enter}')
        await waitFor(() => {
            expect(rows()[0]).toBe('ui/scripts')
        })
        await user.keyboard('{Enter}')
        await waitFor(() => {
            expect(rows()).toEqual(['hud.gdscripts/ui'])
        })
        await user.keyboard('{Enter}')
        await user.keyboard('{Enter}')
        expect(onSubmit).toHaveBeenCalledWith('@scripts/ui/hud.gd')
    })
})

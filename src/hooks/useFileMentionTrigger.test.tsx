import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {useState} from 'react'
import {cleanup, render, screen, waitFor, within} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {ChatComposer, ChatComposerInput} from '@astryxdesign/core/Chat'
import {useFileMentionTrigger} from './useFileMentionTrigger'
import {createDesktopFake, installDesktopFake, removeDesktopFake} from '../test/desktop-driver'
import {installBackend} from '../test/backend'
import {flush} from '../test/flush'

/**
 * Issue #3, second report: the `@` menu flickered and swallowed key presses.
 *
 * The menu is Astryx's; what it does with a search source is not. A source whose `search` returns a
 * promise puts the menu on its 150 ms debounce and shows "Searching…" in place of the rows on every
 * keystroke, and a menu holding no rows hands Enter back to the composer, which sends the message.
 * These drive the real composer and the real menu, because that seam is the whole defect.
 *
 * Third report: the menu offered no folders, so there was nothing to browse. Stepping into one runs
 * against Astryx closing the menu on every pick, and the workaround is a synthetic `input` event —
 * which is exactly the kind of thing that has to be driven through the real composer or not
 * believed at all.
 */

const tauri = createDesktopFake()

const FILES = [
    {path: 'docs/TASK_CHECKLIST.md', bytes: 120},
    {path: 'scripts/player.gd', bytes: 200},
    {path: 'scripts/enemy_base.gd', bytes: 300},
    {path: 'scripts/ui/hud.gd', bytes: 150},
    {path: 'project.godot', bytes: 40},
    {path: 'My Notes/plan.md', bytes: 60}
]

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

/** The composer, mounted and left alone long enough for its file listing to arrive. */
async function composer() {
    installBackend(tauri, {files: FILES})
    const onSubmit = vi.fn<(value: string) => void>()
    render(<Composer onSubmit={onSubmit} />)
    await flush()
    return {onSubmit, editable: screen.getByRole('combobox'), user: userEvent.setup()}
}

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
        // The second Enter is the one that sends, and what it sends is the file that was chosen.
        await user.type(editable, '{Enter}')
        expect(onSubmit).toHaveBeenCalledWith('@docs/TASK_CHECKLIST.md')
    })

    /* The folders are what makes an `@` browsable, and the scan they are derived from has none. */
    it('offers the folders first when nothing has been typed yet', async () => {
        const {user, editable} = await composer()
        await user.click(editable)
        await user.type(editable, '@')
        expect(rows().slice(0, 3)).toEqual(['docs/', 'My Notes/', 'scripts/'])
        // The files at the worktree root sit right under them, not below the whole tree.
        expect(rows()).toContain('project.godot')
    })

    /*
     * The whole point of the rework. Astryx closes its menu on every pick, so this only works
     * because the hook dispatches an `input` event afterwards — assert the listing, not the text.
     *
     * Every Enter after the first goes through `user.keyboard`, not `user.type`: `type` clicks the
     * element first, and a click puts the caret on the editable itself rather than in the text
     * inside it, which is not what pressing Enter on an open menu does.
     */
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

    /*
     * Astryx's `findActiveTrigger` gives up at the first space, so `@My Notes/` could never be
     * typed past and the reopened menu would find no trigger. Such a folder ends the mention
     * instead, quoted, rather than leaving text behind that resolves to nothing.
     */
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
        // The folder steps left plain text behind; only the file becomes a token.
        await user.keyboard('{Enter}')
        expect(onSubmit).toHaveBeenCalledWith('@scripts/ui/hud.gd')
    })
})

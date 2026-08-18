import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {useState} from 'react'
import {cleanup, render, screen, within} from '@testing-library/react'
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
 */

const tauri = createDesktopFake()

const FILES = [
    {path: 'docs/TASK_CHECKLIST.md', bytes: 120},
    {path: 'scripts/player.gd', bytes: 200},
    {path: 'scripts/enemy_base.gd', bytes: 300},
    {path: 'project.godot', bytes: 40}
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
        await user.type(editable, '@taskch')
        const menu = screen.getByRole('listbox')
        expect(menu).not.toHaveTextContent('Searching')
        expect(within(menu).getByRole('option', {name: /TASK_CHECKLIST\.md/})).toBeInTheDocument()
    })

    it('takes the Enter that follows the last letter typed, instead of sending the message', async () => {
        const {user, editable, onSubmit} = await composer()
        await user.click(editable)
        await user.type(editable, '@taskch{Enter}')
        expect(onSubmit).not.toHaveBeenCalled()
        // The second Enter is the one that sends, and what it sends is the file that was chosen.
        await user.type(editable, '{Enter}')
        expect(onSubmit).toHaveBeenCalledWith('@docs/TASK_CHECKLIST.md')
    })
})

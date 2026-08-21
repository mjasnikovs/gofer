import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {cleanup, render, screen, within} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {SketchesView} from './SketchesView'
import {ChatReferenceContext} from '../../hooks/useChatReferences'
import {createDesktopFake, installDesktopFake, removeDesktopFake} from '../../test/desktop-driver'
import {flush, flushUntil} from '../../test/flush'
import type {ProjectSketch, SketchHtml} from '../../models/sketch'

const tauri = createDesktopFake()

/** jsdom measures everything as zero, and a sketch in a zero-wide column has no scale. */
beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
        width: 640,
        height: 360,
        top: 0,
        left: 0,
        right: 640,
        bottom: 360,
        x: 0,
        y: 0,
        toJSON: () => ({})
    })
})

function sketch(overrides: Partial<ProjectSketch> = {}): ProjectSketch {
    return {
        id: 'question-1-run',
        taskId: 'task-1',
        questionId: 'question-1',
        question: 'Where does the pause menu go?',
        label: 'Centered overlay',
        isApproved: true,
        savedAt: 1_700_000_000_000,
        ...overrides
    }
}

const REJECTED = sketch({
    id: 'question-2-run',
    questionId: 'question-2',
    label: 'Side panel',
    isApproved: false,
    savedAt: 1_600_000_000_000
})

/** The markup as the backend keeps it: what the user looked at, and what a builder can use. */
const BOTH: SketchHtml = {
    shown: '<p>data:image/png;base64,AAAA</p>',
    source: '<p>res://ui/panel.png</p>'
}

function backend(rows: readonly ProjectSketch[] = [sketch(), REJECTED], html: SketchHtml = BOTH) {
    const read: string[] = []
    tauri.invoke.mockImplementation((command, arguments_) => {
        if (command === 'list_project_sketches') return Promise.resolve(rows)
        if (command === 'read_project_sketch') {
            const {id} = arguments_ as {id: string}
            read.push(id)
            return Promise.resolve(html)
        }
        throw new Error(`No fake for ${command}`)
    })
    return {read}
}

async function open(paste: (text: string) => void = vi.fn()) {
    render(
        <ChatReferenceContext.Provider value={{add: vi.fn(), paste}}>
            <SketchesView />
        </ChatReferenceContext.Provider>
    )
    await flushUntil(() => screen.queryAllByRole('radio', {name: /All/u}).length > 0)
    await flush()
}

beforeEach(() => {
    installDesktopFake(tauri)
})

afterEach(() => {
    cleanup()
    removeDesktopFake()
    tauri.invoke.mockReset()
    vi.restoreAllMocks()
})

describe('the sketches panel', () => {
    /** The list is what the panel is for: a name for each layout, without fetching any of them. */
    it('names every saved layout without reading one', async () => {
        backend()
        await open()

        expect(screen.getByText('Centered overlay')).toBeInTheDocument()
        expect(screen.getByText('Side panel')).toBeInTheDocument()
        expect(tauri.invoke).toHaveBeenCalledTimes(1)
    })

    /** A design that was completed is the one somebody comes back to look at. */
    it('narrows to what was agreed', async () => {
        backend()
        await open()

        await userEvent.click(screen.getByRole('radio', {name: 'Agreed 1'}))

        expect(screen.getByText('Centered overlay')).toBeInTheDocument()
        expect(screen.queryByText('Side panel')).not.toBeInTheDocument()
    })

    /**
     * Opened once, not once per glance.
     *
     * The copy drawn here has the project's artwork inlined into it, so it is tens of kilobytes.
     * Closing a row and opening it again is a gesture, not a request to fetch that twice.
     */
    it('reads a layout when it is opened, and only the first time', async () => {
        const {read} = backend()
        await open()

        await userEvent.click(screen.getByText('Centered overlay'))
        await flush()
        await userEvent.click(screen.getByText('Side panel'))
        await flush()
        await userEvent.click(screen.getByText('Centered overlay'))
        await flush()

        expect(read).toEqual(['question-1-run', 'question-2-run'])
    })

    /**
     * A revision overwrites the layout under the same identifier, so the cache has to let go of it.
     *
     * `new_sketch_id` is per question, not per round: every revision of one question upserts the
     * same row and rewrites both files in place. Cached forever, Refresh re-lists the rows and still
     * draws round one under round three's label — and Send to chat pastes round one's markup.
     */
    it('forgets what it read when the list is refreshed', async () => {
        const {read} = backend()
        await open()

        await userEvent.click(screen.getByText('Centered overlay'))
        await flush()
        await userEvent.click(screen.getByRole('button', {name: 'Refresh'}))
        await flush()
        await userEvent.click(screen.getByText('Centered overlay'))
        await flush()

        expect(read).toEqual(['question-1-run', 'question-1-run'])
    })

    /**
     * The one that would be silent if it were wrong.
     *
     * Both copies are the same layout to look at. Only one of them is buildable: the other is the
     * project's artwork as base64, which says nothing a builder can act on. Sending the wrong one
     * would look exactly like sending the right one.
     */
    it('sends a builder the markup and never the inlined copy', async () => {
        const paste = vi.fn()
        backend()
        await open(paste)

        await userEvent.click(screen.getByText('Centered overlay'))
        await flush()
        await userEvent.click(screen.getByRole('button', {name: 'Send to chat'}))

        expect(paste).toHaveBeenCalledTimes(1)
        const sent = paste.mock.calls[0]?.[0] as string
        expect(sent).toContain('res://ui/panel.png')
        expect(sent).not.toContain('base64')
        expect(sent).toContain('Centered overlay')
    })

    /** A sketch kept before the second copy existed says why, rather than pasting the wrong one. */
    it('refuses to send a layout it has no buildable markup for', async () => {
        backend([sketch()], {shown: '<p>drawn</p>', source: null})
        await open()

        await userEvent.click(screen.getByText('Centered overlay'))
        await flush()

        expect(screen.getByRole('button', {name: 'Send to chat'})).toBeDisabled()
        expect(
            screen.getByText(/saved before Gofer kept the markup a builder can use/u)
        ).toBeInTheDocument()
    })

    /** A read that failed is drawn as what it was, not as a row with nothing in it. */
    it('reports a layout it could not read', async () => {
        tauri.invoke.mockImplementation(command => {
            if (command === 'list_project_sketches') return Promise.resolve([sketch()])
            return Promise.reject(
                Object.assign(new Error('There is no sketch'), {code: 'sketch_not_found'})
            )
        })
        await open()

        await userEvent.click(screen.getByText('Centered overlay'))
        await flush()

        expect(screen.getByText(/There is no sketch \(sketch_not_found\)/u)).toBeInTheDocument()
    })

    /**
     * A 1280-pixel layout in a 330-pixel column is a picture of a layout, not a layout.
     *
     * The magnifier is what makes re-checking possible at all, and the viewer it opens is over the
     * panel rather than beside it — so what was underneath is still there when it closes.
     */
    it('opens one layout at full size and closes it again', async () => {
        backend([sketch()])
        await open()

        await userEvent.click(screen.getByText('Centered overlay'))
        await flush()
        await userEvent.click(screen.getByRole('button', {name: 'Open Centered overlay full size'}))

        const viewer = screen.getByRole('dialog')
        expect(within(viewer).getByText('Centered overlay')).toBeInTheDocument()
        expect(within(viewer).getByTitle('Sketch')).toBeInTheDocument()

        await userEvent.keyboard('{Escape}')
        await flush()

        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
        expect(screen.getByRole('button', {name: 'Send to chat'})).toBeInTheDocument()
    })

    /** Nothing kept yet is a state of the project, not a failure of the panel. */
    it('says what fills the list when it is empty', async () => {
        backend([])
        await open()

        expect(screen.getByText('No sketches yet')).toBeInTheDocument()
    })
})

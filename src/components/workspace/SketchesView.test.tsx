import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {cleanup, render, screen, within} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {SketchesView} from './SketchesView'
import {ChatReferenceContext} from '../../hooks/useChatReferences'
import {createDesktopFake, installDesktopFake, removeDesktopFake} from '../../test/desktop-driver'
import {flush, flushUntil} from '../../test/flush'
import {CommandFailure, SKETCH_HTML, installBackend} from '../../test/backend'
import type {ProjectSketch, SketchHtml} from '../../models/sketch'

const tauri = createDesktopFake()

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

function backend(
    rows: readonly ProjectSketch[] = [sketch(), REJECTED],
    html: SketchHtml = SKETCH_HTML
) {
    return installBackend(tauri, {sketches: rows, sketchHtml: html})
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
    it('names every saved layout without reading one', async () => {
        backend()
        await open()

        expect(screen.getByText('Centered overlay')).toBeInTheDocument()
        expect(screen.getByText('Side panel')).toBeInTheDocument()
        expect(tauri.invoke).toHaveBeenCalledTimes(1)
    })

    it('narrows to what was agreed', async () => {
        backend()
        await open()

        await userEvent.click(screen.getByRole('radio', {name: 'Agreed 1'}))

        expect(screen.getByText('Centered overlay')).toBeInTheDocument()
        expect(screen.queryByText('Side panel')).not.toBeInTheDocument()
    })

    it('reads a layout when it is opened, and only the first time', async () => {
        const {log} = backend()
        await open()

        await userEvent.click(screen.getByText('Centered overlay'))
        await flush()
        await userEvent.click(screen.getByText('Side panel'))
        await flush()
        await userEvent.click(screen.getByText('Centered overlay'))
        await flush()

        expect(log.sketchReads).toEqual(['question-1-run', 'question-2-run'])
    })

    it('keeps what it read when the same row is shut and opened again', async () => {
        const {log} = backend([sketch()])
        await open()

        await userEvent.click(screen.getByText('Centered overlay'))
        await flush()
        expect(screen.getByTitle('Sketch')).toBeInTheDocument()

        await userEvent.click(screen.getByText('Centered overlay'))
        await flush()
        expect(screen.queryByTitle('Sketch')).not.toBeInTheDocument()

        await userEvent.click(screen.getByText('Centered overlay'))
        await flush()

        expect(screen.getByTitle('Sketch')).toBeInTheDocument()
        expect(log.sketchReads).toEqual(['question-1-run'])
    })

    it('forgets what it read when the list is refreshed', async () => {
        const {log} = backend()
        await open()

        await userEvent.click(screen.getByText('Centered overlay'))
        await flush()
        await userEvent.click(screen.getByRole('button', {name: 'Refresh'}))
        await flush()
        await userEvent.click(screen.getByText('Centered overlay'))
        await flush()

        expect(log.sketchReads).toEqual(['question-1-run', 'question-1-run'])
    })

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

    it('reports a layout it could not read', async () => {
        installBackend(tauri, {
            sketches: [sketch()],
            answers: {
                read_project_sketch: () => {
                    throw new CommandFailure('sketch_not_found', 'There is no sketch')
                }
            }
        })
        await open()

        await userEvent.click(screen.getByText('Centered overlay'))
        await flush()

        expect(screen.getByText(/There is no sketch \(sketch_not_found\)/u)).toBeInTheDocument()
    })

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

    it('says what fills the list when it is empty', async () => {
        backend([])
        await open()

        expect(screen.getByText('No sketches yet')).toBeInTheDocument()
    })
})

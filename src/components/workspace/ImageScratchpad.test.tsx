import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {ImageScratchpad} from './ImageScratchpad'
import type {AnnotationShape} from '../../models/annotation'
import type {DraftAttachment} from '../../models/chat'

/*
 * The canvas is mocked away, not stood in for. jsdom has no 2D context, so a real one here would be
 * a second implementation of the painter to keep correct; what this file is for is the half the
 * visual suite cannot reach cheaply — which control changes what, and what the save is handed.
 */
const painter = vi.hoisted(() => ({
    flatten: vi.fn(),
    load: vi.fn()
}))

vi.mock('../../services/annotation-canvas', () => ({
    flattenAnnotations: painter.flatten,
    loadImage: painter.load,
    paintAnnotations: vi.fn()
}))

const ATTACHMENT: DraftAttachment = {
    id: 'attachment-1',
    name: 'shot.png',
    mimeType: 'image/png',
    size: 12,
    data: 'AAAA',
    previewUrl: 'data:image/png;base64,AAAA'
}

const SAVED = new File(['drawn'], 'shot.png', {type: 'image/png'})

const surface = () => screen.getByRole('img', {name: 'Drawing surface for shot.png'})

const button = (name: string) => screen.getByRole('button', {name})

/** Astryx spells a disabled control two ways: `disabled` on plain ones, `aria-disabled` with a tooltip. */
const isOff = (element: HTMLElement) =>
    element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true'

/** A press, a drag and a release over the surface, in image coordinates. */
function drawStroke(from: readonly [number, number], to: readonly [number, number]) {
    const canvas = surface()
    fireEvent.pointerDown(canvas, {clientX: from[0], clientY: from[1], pointerId: 1})
    fireEvent.pointerMove(canvas, {clientX: to[0], clientY: to[1], pointerId: 1})
    fireEvent.pointerUp(canvas, {clientX: to[0], clientY: to[1], pointerId: 1})
}

async function open(attachment: DraftAttachment = ATTACHMENT) {
    const onSave = vi.fn(() => Promise.resolve())
    const onClose = vi.fn()
    render(
        <ImageScratchpad
            attachment={attachment}
            onSave={onSave}
            onClose={onClose}
        />
    )
    await waitFor(() => {
        expect(isOff(button('Save'))).toBe(false)
    })
    return {onSave, onClose}
}

/** What `flattenAnnotations` was handed on the last save, which is what the model would be sent. */
function flattened() {
    const request = painter.flatten.mock.calls.at(-1)?.[0] as
        {shapes: readonly AnnotationShape[]; src: string; name: string} | undefined
    if (!request) throw new Error('Nothing was flattened')
    return request
}

beforeEach(() => {
    painter.load.mockResolvedValue({naturalWidth: 200, naturalHeight: 100})
    painter.flatten.mockResolvedValue(SAVED)
    // Neither exists in jsdom, and both are what turn a pointer position into an image position.
    HTMLCanvasElement.prototype.setPointerCapture = vi.fn()
    vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
        x: 0,
        y: 0,
        width: 200,
        height: 100,
        top: 0,
        left: 0,
        right: 200,
        bottom: 100,
        toJSON: () => ({})
    })
})

afterEach(() => {
    cleanup()
    vi.clearAllMocks()
})

describe('drawing on an attachment', () => {
    it('keeps a stroke that was dragged and drops a press that went nowhere', async () => {
        await open()
        expect(isOff(button('Undo'))).toBe(true)

        drawStroke([10, 10], [10, 10])
        expect(isOff(button('Undo'))).toBe(true)

        drawStroke([10, 10], [80, 60])
        expect(isOff(button('Undo'))).toBe(false)
    })

    it('hands the save the shapes and the untouched picture', async () => {
        const user = userEvent.setup()
        const {onSave} = await open()
        drawStroke([10, 10], [80, 60])

        await user.click(button('Save'))
        await waitFor(() => {
            expect(onSave).toHaveBeenCalledWith(SAVED, expect.anything())
        })
        expect(flattened().src).toBe(ATTACHMENT.previewUrl)
        expect(flattened().shapes).toHaveLength(1)
    })

    /* Reopening an edit draws the strokes again over the picture as it was before any of them. */
    it('starts from the strokes an earlier edit left', async () => {
        const shapes: readonly AnnotationShape[] = [
            {
                id: 'old',
                kind: 'pen',
                color: '#ff3b30',
                width: 4,
                points: [
                    {x: 0, y: 0},
                    {x: 50, y: 50}
                ]
            }
        ]
        const user = userEvent.setup()
        await open({...ATTACHMENT, annotation: {src: 'data:image/png;base64,ORIGINAL', shapes}})

        expect(isOff(button('Clear'))).toBe(false)
        await user.click(button('Save'))
        await waitFor(() => {
            expect(painter.flatten).toHaveBeenCalled()
        })
        expect(flattened().src).toBe('data:image/png;base64,ORIGINAL')
        expect(flattened().shapes).toHaveLength(1)
    })

    it('says so rather than closing when the picture cannot be drawn on', async () => {
        painter.load.mockRejectedValue(new Error('broken'))
        render(
            <ImageScratchpad
                attachment={ATTACHMENT}
                onSave={vi.fn(() => Promise.resolve())}
                onClose={vi.fn()}
            />
        )
        expect(await screen.findByText('This image could not be opened for drawing.')).toBeVisible()
        expect(isOff(button('Save'))).toBe(true)
    })

    it('reports a save that failed and leaves the drawing where it was', async () => {
        const user = userEvent.setup()
        painter.flatten.mockRejectedValue(new Error('The edited image could not be encoded'))
        const {onSave} = await open()
        drawStroke([10, 10], [80, 60])

        await user.click(button('Save'))
        expect(await screen.findByText('The edited image could not be encoded')).toBeVisible()
        expect(onSave).not.toHaveBeenCalled()
        expect(isOff(button('Clear'))).toBe(false)
    })
})

describe('the tools', () => {
    it('draws with the ink and the width that are picked', async () => {
        const user = userEvent.setup()
        await open()
        await user.click(button('Thick'))
        await user.click(button('Blue ink'))
        drawStroke([10, 10], [80, 60])

        await user.click(button('Save'))
        await waitFor(() => {
            expect(painter.flatten).toHaveBeenCalled()
        })
        expect(flattened().shapes[0]).toMatchObject({width: 8, color: '#0a84ff'})
    })

    it('draws the shape the picked tool names', async () => {
        const user = userEvent.setup()
        await open()
        await user.click(button('Box'))
        drawStroke([10, 10], [80, 60])
        await user.click(button('Arrow'))
        drawStroke([20, 20], [90, 70])

        await user.click(button('Save'))
        await waitFor(() => {
            expect(painter.flatten).toHaveBeenCalled()
        })
        expect(flattened().shapes.map(shape => shape.kind)).toEqual(['box', 'arrow'])
    })

    /*
     * The brush keeps its own size, and the eraser is a shape rather than a delete: both are what
     * lets a rub-out reopen and undo like every other stroke.
     */
    it('paints with the brush at its own size, and rubs out with the eraser', async () => {
        const user = userEvent.setup()
        await open()
        await user.click(button('Thin'))
        drawStroke([10, 10], [80, 60])
        await user.click(button('Brush'))
        drawStroke([20, 20], [90, 70])
        await user.click(button('Erase'))
        drawStroke([30, 30], [95, 75])

        await user.click(button('Save'))
        await waitFor(() => {
            expect(painter.flatten).toHaveBeenCalled()
        })
        const [pen, brush, erase] = flattened().shapes
        expect(pen).toMatchObject({kind: 'pen', width: 2})
        expect(brush).toMatchObject({kind: 'pen', width: 24})
        expect(erase).toMatchObject({kind: 'erase', width: 24})
    })

    /* A label is typed, not dragged, so the press only says where it goes. */
    it('takes a label from the field the press opens, and drops an empty one', async () => {
        const user = userEvent.setup()
        await open()
        await user.click(button('Label'))
        fireEvent.pointerDown(surface(), {clientX: 20, clientY: 40, pointerId: 1})
        fireEvent.pointerUp(surface(), {clientX: 20, clientY: 40, pointerId: 1})

        const field = screen.getByRole('textbox', {name: 'Label'})
        await user.type(field, 'the boss{Enter}')
        expect(screen.queryByRole('textbox', {name: 'Label'})).not.toBeInTheDocument()

        // A second label, abandoned empty: pressing elsewhere ends it and leaves nothing behind.
        fireEvent.pointerDown(surface(), {clientX: 60, clientY: 40, pointerId: 1})
        fireEvent.pointerUp(surface(), {clientX: 60, clientY: 40, pointerId: 1})
        fireEvent.pointerDown(surface(), {clientX: 90, clientY: 40, pointerId: 1})
        fireEvent.pointerUp(surface(), {clientX: 90, clientY: 40, pointerId: 1})

        await user.click(button('Save'))
        await waitFor(() => {
            expect(painter.flatten).toHaveBeenCalled()
        })
        expect(flattened().shapes).toHaveLength(1)
        expect(flattened().shapes[0]).toMatchObject({kind: 'text', text: 'the boss'})
    })
})

describe('changing a stroke that is already there', () => {
    it('moves the one under the pointer and leaves the others alone', async () => {
        const user = userEvent.setup()
        await open()
        drawStroke([10, 10], [10, 60])
        await user.click(button('Pick'))

        const canvas = surface()
        fireEvent.pointerDown(canvas, {clientX: 10, clientY: 30, pointerId: 1})
        fireEvent.pointerMove(canvas, {clientX: 50, clientY: 30, pointerId: 1})
        fireEvent.pointerUp(canvas, {clientX: 50, clientY: 30, pointerId: 1})

        await user.click(button('Save'))
        await waitFor(() => {
            expect(painter.flatten).toHaveBeenCalled()
        })
        const moved = flattened().shapes[0]
        expect(moved?.kind === 'pen' && moved.points[0]).toMatchObject({x: 50, y: 10})
    })

    it('deletes the picked stroke on Delete', async () => {
        const user = userEvent.setup()
        await open()
        drawStroke([10, 10], [10, 60])
        await user.click(button('Pick'))
        fireEvent.pointerDown(surface(), {clientX: 10, clientY: 30, pointerId: 1})
        fireEvent.pointerUp(surface(), {clientX: 10, clientY: 30, pointerId: 1})

        fireEvent.keyDown(window, {key: 'Delete'})
        expect(isOff(button('Clear'))).toBe(true)
    })

    /* Undo has to reach a move and a clear, not only the last shape added. */
    it('undoes and redoes with the keyboard as well as the buttons', async () => {
        const user = userEvent.setup()
        await open()
        drawStroke([10, 10], [80, 60])

        fireEvent.keyDown(window, {key: 'z', ctrlKey: true})
        expect(isOff(button('Clear'))).toBe(true)

        fireEvent.keyDown(window, {key: 'Z', ctrlKey: true, shiftKey: true})
        expect(isOff(button('Clear'))).toBe(false)

        /*
         * Retried rather than read once: `clickAction` runs the update in a transition, so the
         * button it disables settles a tick after the click resolves.
         */
        const clearIs = async (off: boolean) => {
            await waitFor(() => {
                expect(isOff(button('Clear'))).toBe(off)
            })
        }
        await user.click(button('Clear'))
        await clearIs(true)
        await user.click(button('Undo'))
        await clearIs(false)
        await user.click(button('Redo'))
        await clearIs(true)
    })

    it('leaves the picture alone when the dialog is cancelled', async () => {
        const user = userEvent.setup()
        const {onClose, onSave} = await open()
        drawStroke([10, 10], [80, 60])
        await user.click(button('Cancel'))
        expect(onClose).toHaveBeenCalled()
        expect(onSave).not.toHaveBeenCalled()
        expect(painter.flatten).not.toHaveBeenCalled()
    })
})

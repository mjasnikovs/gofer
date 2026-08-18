import {describe, expect, it} from 'vitest'
import {
    ANNOTATION_COLORS,
    arrowBarbs,
    canRedo,
    canUndo,
    clearShapes,
    commitShapes,
    distanceToSegment,
    dragShape,
    EMPTY_HISTORY,
    HISTORY_LIMIT,
    isDegenerate,
    moveShape,
    redo,
    removeShape,
    replaceShape,
    shapeAt,
    shapeBounds,
    startShape,
    textSize,
    toImagePoint,
    undo,
    withText
} from './annotation'
import type {AnnotationPoint, AnnotationStyle, BoxShape, PenShape, TextShape} from './annotation'

const STYLE: AnnotationStyle = {color: ANNOTATION_COLORS[0], width: 4}

const at = (x: number, y: number) => ({x, y})

const pen = (id: string, ...points: readonly (readonly [number, number])[]): PenShape => ({
    id,
    kind: 'pen',
    color: STYLE.color,
    width: STYLE.width,
    points: points.map(([x, y]) => at(x, y))
})

const label = (id: string, anchor: AnnotationPoint, text: string): TextShape => ({
    id,
    kind: 'text',
    color: STYLE.color,
    width: STYLE.width,
    at: anchor,
    text
})

const boxShape = (
    id: string,
    from: readonly [number, number],
    to: readonly [number, number]
): BoxShape => ({
    id,
    kind: 'box',
    color: STYLE.color,
    width: STYLE.width,
    from: at(from[0], from[1]),
    to: at(to[0], to[1])
})

describe('drawing a shape', () => {
    it('grows a pen point by point and drags every other tool by its far corner', () => {
        const stroke = dragShape(
            dragShape(startShape('pen', 'a', STYLE, at(0, 0)), at(1, 1)),
            at(2, 2)
        )
        expect(stroke).toMatchObject({kind: 'pen', points: [at(0, 0), at(1, 1), at(2, 2)]})

        const arrow = dragShape(startShape('arrow', 'b', STYLE, at(0, 0)), at(9, 9))
        expect(arrow).toMatchObject({kind: 'arrow', from: at(0, 0), to: at(9, 9)})
    })

    /* Text is placed, not dragged: a pointer moving after the press must not move the anchor. */
    it('leaves a text anchor where it was placed', () => {
        const text = startShape('text', 'c', STYLE, at(5, 5))
        expect(dragShape(text, at(80, 80))).toEqual(text)
    })

    /*
     * A press with no drag is how a tool gets picked up and put down again. Kept, each one leaves a
     * dot or an empty label behind that the user then has to hunt for and delete.
     */
    it('calls a press with no drag degenerate, and an empty label too', () => {
        expect(isDegenerate(startShape('arrow', 'a', STYLE, at(4, 4)))).toBe(true)
        expect(isDegenerate(startShape('pen', 'b', STYLE, at(4, 4)))).toBe(true)
        // A click sends a move before its release, so the dot arrives as two points, not one.
        expect(isDegenerate(dragShape(startShape('pen', 'b2', STYLE, at(4, 4)), at(4, 4)))).toBe(
            true
        )
        expect(isDegenerate(dragShape(startShape('pen', 'b3', STYLE, at(4, 4)), at(40, 40)))).toBe(
            false
        )
        expect(isDegenerate(startShape('text', 'c', STYLE, at(4, 4)))).toBe(true)
        expect(isDegenerate(dragShape(startShape('box', 'd', STYLE, at(0, 0)), at(40, 40)))).toBe(
            false
        )
        expect(isDegenerate(withText(label('e', at(4, 4), ''), 'here'))).toBe(false)
    })
})

describe('undo across every kind of edit', () => {
    const first = [pen('a', [0, 0], [1, 1])]
    const last = pen('b', [2, 2], [3, 3])
    const second = [...first, last]

    it('takes back a move, not just an added shape', () => {
        const moved = replaceShape(second, moveShape(last, 10, 10))
        const history = commitShapes(
            commitShapes(commitShapes(EMPTY_HISTORY, first), second),
            moved
        )
        expect(history.shapes).toEqual(moved)
        expect(undo(history).shapes).toEqual(second)
    })

    it('takes back a delete and a clear', () => {
        const history = commitShapes(EMPTY_HISTORY, second)
        expect(undo(commitShapes(history, removeShape(second, 'a'))).shapes).toEqual(second)
        expect(undo(clearShapes(history)).shapes).toEqual(second)
    })

    it('redoes what it undid, and drops the future once a new edit lands', () => {
        const history = commitShapes(commitShapes(EMPTY_HISTORY, first), second)
        const back = undo(history)
        expect(canRedo(back)).toBe(true)
        expect(redo(back).shapes).toEqual(second)

        const branched = commitShapes(back, [...first, pen('c', [5, 5], [6, 6])])
        expect(canRedo(branched)).toBe(false)
    })

    it('does nothing at either end rather than throwing', () => {
        expect(canUndo(EMPTY_HISTORY)).toBe(false)
        expect(undo(EMPTY_HISTORY)).toEqual(EMPTY_HISTORY)
        expect(redo(EMPTY_HISTORY)).toEqual(EMPTY_HISTORY)
        expect(clearShapes(EMPTY_HISTORY)).toEqual(EMPTY_HISTORY)
    })

    /* Every state is a copy of the shape list, so an unbounded stack grows with the drawing. */
    it('forgets the oldest state past the limit', () => {
        let history = EMPTY_HISTORY
        for (let step = 0; step < HISTORY_LIMIT + 10; step += 1) {
            history = commitShapes(history, [pen(`s${String(step)}`, [0, 0], [1, 1])])
        }
        expect(history.past).toHaveLength(HISTORY_LIMIT)
    })
})

describe('finding the shape under the pointer', () => {
    it('answers with the topmost of two that overlap', () => {
        const shapes = [pen('under', [0, 0], [100, 0]), pen('over', [0, 0], [100, 0])]
        expect(shapeAt(shapes, at(50, 0))?.id).toBe('over')
    })

    it('measures the distance to a segment, not to the line it sits on', () => {
        expect(distanceToSegment(at(50, 10), at(0, 0), at(100, 0))).toBe(10)
        expect(distanceToSegment(at(200, 0), at(0, 0), at(100, 0))).toBe(100)
    })

    /* A box frames what is under it. Pressing the middle has to reach that, not pick the frame up. */
    it('presses a box by its edge and not by its middle', () => {
        const shapes = [boxShape('frame', [0, 0], [100, 100])]
        expect(shapeAt(shapes, at(0, 50))?.id).toBe('frame')
        expect(shapeAt(shapes, at(50, 50))).toBeUndefined()
    })

    /* An eraser shows nothing, so a selection on one would be a handle the user cannot see. */
    it('never picks up an eraser stroke', () => {
        const rub = startShape('erase', 'rub', STYLE, at(0, 0))
        const shapes = [pen('under', [0, 0], [100, 0]), dragShape(rub, at(100, 0))]
        expect(shapeAt(shapes, at(50, 0))?.id).toBe('under')
    })

    it('answers with nothing when the pointer is on bare image', () => {
        expect(shapeAt([pen('a', [0, 0], [10, 10])], at(400, 400))).toBeUndefined()
        expect(shapeAt([], at(0, 0))).toBeUndefined()
    })
})

describe('geometry the painter and the tests share', () => {
    it('bounds a label above its anchor, which is where a baseline puts it', () => {
        const bounds = shapeBounds(label('a', at(10, 40), 'hi'))
        expect(bounds.y).toBe(40 - textSize(STYLE.width))
        expect(bounds.height).toBe(textSize(STYLE.width))
        expect(bounds.width).toBeGreaterThan(0)
    })

    it('puts both arrow barbs behind the head and off to either side', () => {
        const [left, right] = arrowBarbs(at(0, 0), at(100, 0), 20)
        expect(left.x).toBeCloseTo(right.x)
        expect(left.x).toBeLessThan(100)
        expect(left.y).toBeCloseTo(-right.y)
        expect(left.y).not.toBeCloseTo(0)
    })

    it('moves every point of a shape by the same offset', () => {
        expect(moveShape(pen('a', [0, 0], [10, 10]), 5, -5)).toMatchObject({
            points: [at(5, -5), at(15, 5)]
        })
    })
})

describe('mapping a pointer onto the image', () => {
    /*
     * The canvas is shown at whatever size fits the dialog. A stroke recorded at display scale lands
     * somewhere else in the saved PNG, which is the bug this function exists to stop.
     */
    it('scales a display position up to the image its pixels belong to', () => {
        const rect = {x: 20, y: 10, width: 400, height: 200}
        const image = {width: 800, height: 400}
        expect(toImagePoint(rect, image, at(220, 110))).toEqual(at(400, 200))
        expect(toImagePoint(rect, image, at(20, 10))).toEqual(at(0, 0))
    })

    it('answers with the origin before the canvas has been laid out', () => {
        expect(
            toImagePoint({x: 0, y: 0, width: 0, height: 0}, {width: 10, height: 10}, at(5, 5))
        ).toEqual(at(0, 0))
    })
})

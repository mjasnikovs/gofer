/**
 * The shapes drawn over an attached image, and the history behind them.
 *
 * Kept free of `canvas` on purpose: jsdom has no 2D context, so anything touching one is untestable
 * here. Geometry, hit testing and undo live in this file; painting lives in
 * `services/annotation-canvas.ts`.
 */

export type AnnotationTool = 'pen' | 'arrow' | 'box' | 'text' | 'erase'

export type AnnotationPoint = Readonly<{x: number; y: number}>

/** Ink, not interface: these are painted into the PNG, so no theme token can supply them. */
export const ANNOTATION_COLORS = ['#ff3b30', '#ffd60a', '#32d74b', '#0a84ff'] as const

export const ANNOTATION_WIDTHS = [2, 4, 8] as const

/**
 * The brush and the eraser are dragged over an area rather than along a line, so the three line
 * widths are too coarse and too thin for either. They take a range instead.
 */
export const ROUND_SIZES = {min: 4, max: 96, step: 2, initial: 24} as const

/** Text is sized off the stroke width so one control drives every tool. */
export const TEXT_SIZE_RATIO = 6

/** How the next shape is drawn. */
export type AnnotationStyle = Readonly<{color: string; width: number}>

type ShapeBase = Readonly<{id: string; color: string; width: number}>

export type PenShape = ShapeBase & Readonly<{kind: 'pen'; points: readonly AnnotationPoint[]}>

/**
 * A rubbed-out path. Same geometry as a pen stroke, opposite job.
 *
 * It is a shape rather than a deletion so that it undoes, redoes and reopens like everything else,
 * and so that it only ever rubs out ink: the painter lays the strokes on a layer of their own and
 * this one cuts holes in that layer, never in the picture underneath.
 */
export type EraseShape = ShapeBase & Readonly<{kind: 'erase'; points: readonly AnnotationPoint[]}>

export type ArrowShape = ShapeBase
    & Readonly<{kind: 'arrow'; from: AnnotationPoint; to: AnnotationPoint}>

export type BoxShape = ShapeBase
    & Readonly<{kind: 'box'; from: AnnotationPoint; to: AnnotationPoint}>

export type TextShape = ShapeBase & Readonly<{kind: 'text'; at: AnnotationPoint; text: string}>

export type AnnotationShape = PenShape | EraseShape | ArrowShape | BoxShape | TextShape

export type AnnotationBounds = Readonly<{x: number; y: number; width: number; height: number}>

/** A dragged path: the pen, the brush and the eraser all keep their shape as a list of points. */
export function isPath(shape: AnnotationShape): shape is PenShape | EraseShape {
    return shape.kind === 'pen' || shape.kind === 'erase'
}

/**
 * Undo over whole states rather than over added shapes.
 *
 * A move and a delete are edits too, and a stack of "shapes added" cannot take either of them back.
 */
export type AnnotationHistory = Readonly<{
    shapes: readonly AnnotationShape[]
    past: readonly (readonly AnnotationShape[])[]
    future: readonly (readonly AnnotationShape[])[]
}>

/** Deep enough for a session of drawing, short enough that the states stay cheap. */
export const HISTORY_LIMIT = 50

export const EMPTY_HISTORY: AnnotationHistory = {shapes: [], past: [], future: []}

/** Records `shapes` as the new present. The future is dropped: this is a new branch. */
export function commitShapes(
    history: AnnotationHistory,
    shapes: readonly AnnotationShape[]
): AnnotationHistory {
    const past = [...history.past, history.shapes].slice(-HISTORY_LIMIT)
    return {shapes, past, future: []}
}

export function canUndo(history: AnnotationHistory): boolean {
    return history.past.length > 0
}

export function canRedo(history: AnnotationHistory): boolean {
    return history.future.length > 0
}

export function undo(history: AnnotationHistory): AnnotationHistory {
    const previous = history.past.at(-1)
    if (previous === undefined) return history
    return {
        shapes: previous,
        past: history.past.slice(0, -1),
        future: [history.shapes, ...history.future]
    }
}

export function redo(history: AnnotationHistory): AnnotationHistory {
    const [next, ...rest] = history.future
    if (next === undefined) return history
    return {shapes: next, past: [...history.past, history.shapes], future: rest}
}

/** Clearing is an edit like any other, so undo takes it back. */
export function clearShapes(history: AnnotationHistory): AnnotationHistory {
    if (history.shapes.length === 0) return history
    return commitShapes(history, [])
}

export function textSize(width: number): number {
    return width * TEXT_SIZE_RATIO
}

export function startShape(
    tool: AnnotationTool,
    id: string,
    style: AnnotationStyle,
    at: AnnotationPoint
): AnnotationShape {
    const base = {id, color: style.color, width: style.width}
    if (tool === 'pen') return {...base, kind: 'pen', points: [at]}
    if (tool === 'erase') return {...base, kind: 'erase', points: [at]}
    if (tool === 'text') return {...base, kind: 'text', at, text: ''}
    if (tool === 'box') return {...base, kind: 'box', from: at, to: at}
    return {...base, kind: 'arrow', from: at, to: at}
}

/** The pointer moved while drawing: a pen grows, an arrow and a box follow their far corner. */
export function dragShape(shape: AnnotationShape, at: AnnotationPoint): AnnotationShape {
    if (isPath(shape)) return {...shape, points: [...shape.points, at]}
    if (shape.kind === 'text') return shape
    return {...shape, to: at}
}

export function withText(shape: TextShape, text: string): TextShape {
    return {...shape, text}
}

/**
 * A press with no drag leaves nothing to draw, so it is dropped rather than kept as a dot.
 *
 * Counting a pen's points is not enough: a press sends a move before its release, so a click that
 * never travelled still arrives as two points in the same place.
 */
export function isDegenerate(shape: AnnotationShape): boolean {
    if (shape.kind === 'text') return shape.text.trim() === ''
    if (!isPath(shape)) return distance(shape.from, shape.to) < shape.width
    if (shape.points.length < 2) return true
    const bounds = shapeBounds(shape)
    return Math.hypot(bounds.width, bounds.height) < shape.width
}

export function moveShape(shape: AnnotationShape, dx: number, dy: number): AnnotationShape {
    const shift = (point: AnnotationPoint) => ({x: point.x + dx, y: point.y + dy})
    if (isPath(shape)) return {...shape, points: shape.points.map(shift)}
    if (shape.kind === 'text') return {...shape, at: shift(shape.at)}
    return {...shape, from: shift(shape.from), to: shift(shape.to)}
}

export function replaceShape(
    shapes: readonly AnnotationShape[],
    replacement: AnnotationShape
): readonly AnnotationShape[] {
    return shapes.map(shape => (shape.id === replacement.id ? replacement : shape))
}

export function removeShape(
    shapes: readonly AnnotationShape[],
    id: string
): readonly AnnotationShape[] {
    return shapes.filter(shape => shape.id !== id)
}

function distance(one: AnnotationPoint, other: AnnotationPoint): number {
    return Math.hypot(other.x - one.x, other.y - one.y)
}

/** Distance from a point to a segment, clamped at both ends so it measures the segment, not its line. */
export function distanceToSegment(
    point: AnnotationPoint,
    from: AnnotationPoint,
    to: AnnotationPoint
): number {
    const dx = to.x - from.x
    const dy = to.y - from.y
    const lengthSquared = dx * dx + dy * dy
    if (lengthSquared === 0) return distance(point, from)
    const along = ((point.x - from.x) * dx + (point.y - from.y) * dy) / lengthSquared
    const clamped = Math.min(1, Math.max(0, along))
    return distance(point, {x: from.x + clamped * dx, y: from.y + clamped * dy})
}

/**
 * A text shape's box, measured without a canvas.
 *
 * `measureText` needs a 2D context, which this file will not take. The ratio is the average width
 * of a glyph in a sans-serif face, which is close enough to press on and far cheaper than the truth.
 */
const GLYPH_WIDTH_RATIO = 0.55

export function shapeBounds(shape: AnnotationShape): AnnotationBounds {
    if (isPath(shape)) {
        const xs = shape.points.map(point => point.x)
        const ys = shape.points.map(point => point.y)
        return box(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys))
    }
    if (shape.kind === 'text') {
        const size = textSize(shape.width)
        const width = size * GLYPH_WIDTH_RATIO * shape.text.length
        return box(shape.at.x, shape.at.y - size, shape.at.x + width, shape.at.y)
    }
    return box(
        Math.min(shape.from.x, shape.to.x),
        Math.min(shape.from.y, shape.to.y),
        Math.max(shape.from.x, shape.to.x),
        Math.max(shape.from.y, shape.to.y)
    )
}

function box(left: number, top: number, right: number, bottom: number): AnnotationBounds {
    return {x: left, y: top, width: right - left, height: bottom - top}
}

function isNear(shape: AnnotationShape, point: AnnotationPoint, tolerance: number): boolean {
    const reach = shape.width / 2 + tolerance
    if (isPath(shape)) {
        let previous: AnnotationPoint | undefined
        for (const current of shape.points) {
            if (previous && distanceToSegment(point, previous, current) <= reach) return true
            previous = current
        }
        return false
    }
    if (shape.kind === 'arrow') return distanceToSegment(point, shape.from, shape.to) <= reach
    if (shape.kind === 'text') {
        const bounds = shapeBounds(shape)
        return (
            point.x >= bounds.x - tolerance
            && point.x <= bounds.x + bounds.width + tolerance
            && point.y >= bounds.y - tolerance
            && point.y <= bounds.y + bounds.height + tolerance
        )
    }
    // A box is hollow: its edges are pressable, its middle belongs to whatever it frames.
    const bounds = shapeBounds(shape)
    const {x, y, width, height} = bounds
    const corners: readonly [AnnotationPoint, AnnotationPoint][] = [
        [
            {x, y},
            {x: x + width, y}
        ],
        [
            {x: x + width, y},
            {x: x + width, y: y + height}
        ],
        [
            {x: x + width, y: y + height},
            {x, y: y + height}
        ],
        [
            {x, y: y + height},
            {x, y}
        ]
    ]
    return corners.some(([from, to]) => distanceToSegment(point, from, to) <= reach)
}

/**
 * The shape under the pointer, topmost first — the one drawn last is the one the eye sees.
 *
 * An eraser stroke is never returned: it shows nothing, so picking one would hand the user a
 * selection they cannot see. Undo is how a rub-out is taken back.
 */
export function shapeAt(
    shapes: readonly AnnotationShape[],
    point: AnnotationPoint,
    tolerance = 4
): AnnotationShape | undefined {
    return [...shapes]
        .reverse()
        .find(shape => shape.kind !== 'erase' && isNear(shape, point, tolerance))
}

/** The two barbs of an arrow head, so the head is drawn from the same maths it is tested on. */
export function arrowBarbs(
    from: AnnotationPoint,
    to: AnnotationPoint,
    length: number
): readonly [AnnotationPoint, AnnotationPoint] {
    const angle = Math.atan2(to.y - from.y, to.x - from.x)
    const spread = Math.PI / 7
    return [
        {x: to.x - length * Math.cos(angle - spread), y: to.y - length * Math.sin(angle - spread)},
        {x: to.x - length * Math.cos(angle + spread), y: to.y - length * Math.sin(angle + spread)}
    ]
}

export type ImageSize = Readonly<{width: number; height: number}>

/**
 * A pointer position in the image's own pixels.
 *
 * The canvas is displayed at whatever size fits the dialog, so a stroke drawn at display scale would
 * land somewhere else once the image is saved at full size.
 */
export function toImagePoint(
    rect: AnnotationBounds,
    image: ImageSize,
    client: AnnotationPoint
): AnnotationPoint {
    if (rect.width === 0 || rect.height === 0) return {x: 0, y: 0}
    return {
        x: ((client.x - rect.x) / rect.width) * image.width,
        y: ((client.y - rect.y) / rect.height) * image.height
    }
}

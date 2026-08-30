import {afterEach, describe, expect, it, vi} from 'vitest'
import {annotatedName, paintAnnotations} from './annotation-canvas'
import type {
    AnnotationShape,
    ArrowShape,
    BoxShape,
    EraseShape,
    PenShape,
    TextShape
} from '../models/annotation'

type Call = readonly [string, ...unknown[]]

type Recorder = Readonly<{ctx: CanvasRenderingContext2D; calls: readonly Call[]}>

function recorder(): Recorder {
    const calls: Call[] = []
    const state = {strokeStyle: '', fillStyle: '', lineWidth: 0, font: '', composite: ''}
    const record =
        (name: string) =>
        (...args: unknown[]) => {
            calls.push([name, ...args, {...state}])
        }
    const fake = {
        beginPath: record('beginPath'),
        moveTo: record('moveTo'),
        lineTo: record('lineTo'),
        rect: record('rect'),
        stroke: record('stroke'),
        strokeRect: record('strokeRect'),
        strokeText: record('strokeText'),
        fillText: record('fillText'),
        setLineDash: record('setLineDash'),
        drawImage: record('drawImage'),
        save: record('save'),
        restore: record('restore'),
        set strokeStyle(value: string) {
            state.strokeStyle = value
        },
        set fillStyle(value: string) {
            state.fillStyle = value
        },
        set lineWidth(value: number) {
            state.lineWidth = value
        },
        set font(value: string) {
            state.font = value
        },
        set globalCompositeOperation(value: string) {
            state.composite = value
        },
        canvas: {width: 200, height: 100},
        lineCap: '',
        lineJoin: '',
        textBaseline: ''
    }
    return {ctx: fake as unknown as CanvasRenderingContext2D, calls}
}

const paint = (shapes: readonly AnnotationShape[], selectedId?: string) => {
    const {ctx, calls} = recorder()
    paintAnnotations(ctx, shapes, selectedId)
    return calls
}

const named = (calls: readonly Call[], name: string) => calls.filter(call => call[0] === name)

const styleOf = (call: Call) =>
    call.at(-1) as Readonly<{strokeStyle: string; lineWidth: number; composite: string}>

const PEN: PenShape = {
    id: 'pen',
    kind: 'pen',
    color: '#ff3b30',
    width: 4,
    points: [
        {x: 0, y: 0},
        {x: 10, y: 10},
        {x: 20, y: 0}
    ]
}

const ERASE: EraseShape = {
    id: 'erase',
    kind: 'erase',
    color: '#ff3b30',
    width: 20,
    points: [
        {x: 0, y: 0},
        {x: 30, y: 30}
    ]
}

const ARROW: ArrowShape = {
    id: 'arrow',
    kind: 'arrow',
    color: '#0a84ff',
    width: 4,
    from: {x: 0, y: 0},
    to: {x: 100, y: 0}
}

const BOX: BoxShape = {
    id: 'box',
    kind: 'box',
    color: '#32d74b',
    width: 2,
    from: {x: 40, y: 40},
    to: {x: 10, y: 10}
}

const LABEL: TextShape = {
    id: 'label',
    kind: 'text',
    color: '#ffd60a',
    width: 4,
    at: {x: 5, y: 30},
    text: 'here'
}

describe('painting a shape so it survives the art under it', () => {
    it('strokes a dark wider pass before the coloured one', () => {
        const passes = named(paint([PEN]), 'stroke').map(styleOf)
        expect(passes).toHaveLength(2)
        expect(passes[0]?.strokeStyle).toContain('rgba(0, 0, 0')
        expect(passes[1]?.strokeStyle).toBe(PEN.color)
        expect(passes[0]?.lineWidth).toBeGreaterThan(passes[1]?.lineWidth ?? 0)
        expect(passes[1]?.lineWidth).toBe(PEN.width)
    })

    it('walks a pen from its first point through every later one', () => {
        const calls = paint([PEN])
        expect(named(calls, 'moveTo')[0]?.slice(0, 3)).toEqual(['moveTo', 0, 0])
        expect(named(calls, 'lineTo')).toHaveLength(4)
    })

    it('draws a box from its bounds however it was dragged', () => {
        expect(named(paint([BOX]), 'rect')[0]?.slice(0, 5)).toEqual(['rect', 10, 10, 30, 30])
    })

    it('draws an arrow head as two barbs meeting at the point', () => {
        const lines = named(paint([ARROW]), 'lineTo').map(call => call.slice(0, 3))
        expect(lines).toHaveLength(6)
        expect(lines[0]).toEqual(['lineTo', ARROW.to.x, ARROW.to.y])
    })

    it('outlines a label before filling it, at the same place', () => {
        const calls = paint([LABEL])
        expect(named(calls, 'strokeText')[0]?.slice(0, 4)).toEqual(['strokeText', 'here', 5, 30])
        expect(named(calls, 'fillText')[0]?.slice(0, 4)).toEqual(['fillText', 'here', 5, 30])
        expect(calls.findIndex(call => call[0] === 'strokeText')).toBeLessThan(
            calls.findIndex(call => call[0] === 'fillText')
        )
    })

    it('paints in the order the shapes were added', () => {
        const calls = paint([PEN, BOX])
        expect(calls.findIndex(call => call[0] === 'rect')).toBeGreaterThan(
            calls.findIndex(call => call[0] === 'moveTo')
        )
    })
})

describe('the ring around the picked shape', () => {
    it('draws it around the shape that was picked, and around no other', () => {
        expect(named(paint([PEN, BOX], 'box'), 'strokeRect')).toHaveLength(1)
        expect(named(paint([PEN, BOX], 'pen'), 'strokeRect')).toHaveLength(1)
    })

    it('draws nothing when no shape is picked, or when the pick is gone', () => {
        expect(named(paint([PEN]), 'strokeRect')).toHaveLength(0)
        expect(named(paint([PEN], 'deleted'), 'strokeRect')).toHaveLength(0)
    })

    it('leaves the dashes behind it rather than on the next shape', () => {
        const calls = paint([PEN], 'pen')
        expect(named(calls, 'save')).toHaveLength(1)
        expect(named(calls, 'restore')).toHaveLength(1)
    })
})

describe('naming the edited image', () => {
    it('puts a png extension on whatever came in', () => {
        expect(annotatedName('game-screenshot.png')).toBe('game-screenshot.png')
        expect(annotatedName('shot.jpeg')).toBe('shot.png')
        expect(annotatedName('pasted')).toBe('pasted.png')
        expect(annotatedName('.hidden')).toBe('.hidden.png')
    })
})

describe('rubbing out', () => {
    afterEach(() => {
        vi.restoreAllMocks()
    })

    it('cuts the strokes on their own layer and leaves the picture alone', () => {
        const layer = recorder()
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(layer.ctx)
        const {ctx, calls} = recorder()

        paintAnnotations(ctx, [PEN, ERASE])

        expect(named(calls, 'stroke')).toHaveLength(0)
        expect(named(calls, 'drawImage')).toHaveLength(1)
        const cut = named(layer.calls, 'stroke').map(styleOf).at(-1)
        expect(cut?.composite).toBe('destination-out')
        expect(cut?.lineWidth).toBeGreaterThan(ERASE.width)
    })

    it('leaves a rub-out out entirely when no layer can be made', () => {
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
        const {ctx, calls} = recorder()

        paintAnnotations(ctx, [ERASE])

        expect(named(calls, 'stroke')).toHaveLength(0)
        expect(named(calls, 'drawImage')).toHaveLength(0)
    })
})

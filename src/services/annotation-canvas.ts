/**
 * Painting the shapes of `models/annotation` onto a canvas, and flattening them into a PNG.
 *
 * Everything here needs a 2D context, which jsdom does not have. The visual suite covers it; keep
 * decisions out of this file and in the model, where a unit test can reach them.
 */

import {arrowBarbs, shapeBounds, textSize} from '../models/annotation'
import type {AnnotationShape, ImageSize} from '../models/annotation'

/** Every stroke is laid down twice, dark underneath, so a colour survives being drawn on art of the same colour. */
const HALO = 'rgba(0, 0, 0, 0.65)'
const HALO_WIDTH = 3
const ARROW_HEAD_RATIO = 4

function trace(ctx: CanvasRenderingContext2D, shape: AnnotationShape, path: () => void) {
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    for (const pass of [HALO, shape.color]) {
        ctx.strokeStyle = pass
        ctx.lineWidth = pass === HALO ? shape.width + HALO_WIDTH * 2 : shape.width
        ctx.beginPath()
        path()
        ctx.stroke()
    }
}

function paintShape(ctx: CanvasRenderingContext2D, shape: AnnotationShape) {
    if (shape.kind === 'erase') {
        // Cutting, not painting: this only reaches the layer the strokes live on.
        ctx.save()
        ctx.globalCompositeOperation = 'destination-out'
        ctx.lineCap = 'round'
        ctx.lineJoin = 'round'
        ctx.strokeStyle = '#000000'
        // Wide enough to take the halo with it, or a rubbed-out stroke leaves a dark ghost behind.
        ctx.lineWidth = shape.width + HALO_WIDTH * 2
        ctx.beginPath()
        for (const [index, point] of shape.points.entries()) {
            if (index === 0) ctx.moveTo(point.x, point.y)
            else ctx.lineTo(point.x, point.y)
        }
        ctx.stroke()
        ctx.restore()
        return
    }
    if (shape.kind === 'pen') {
        trace(ctx, shape, () => {
            for (const [index, point] of shape.points.entries()) {
                if (index === 0) ctx.moveTo(point.x, point.y)
                else ctx.lineTo(point.x, point.y)
            }
        })
        return
    }
    if (shape.kind === 'box') {
        const bounds = shapeBounds(shape)
        trace(ctx, shape, () => {
            ctx.rect(bounds.x, bounds.y, bounds.width, bounds.height)
        })
        return
    }
    if (shape.kind === 'arrow') {
        const [left, right] = arrowBarbs(shape.from, shape.to, shape.width * ARROW_HEAD_RATIO)
        trace(ctx, shape, () => {
            ctx.moveTo(shape.from.x, shape.from.y)
            ctx.lineTo(shape.to.x, shape.to.y)
            ctx.moveTo(left.x, left.y)
            ctx.lineTo(shape.to.x, shape.to.y)
            ctx.lineTo(right.x, right.y)
        })
        return
    }
    const size = textSize(shape.width)
    ctx.font = `600 ${String(size)}px sans-serif`
    ctx.textBaseline = 'alphabetic'
    ctx.lineWidth = HALO_WIDTH * 2
    ctx.strokeStyle = HALO
    ctx.strokeText(shape.text, shape.at.x, shape.at.y)
    ctx.fillStyle = shape.color
    ctx.fillText(shape.text, shape.at.x, shape.at.y)
}

/** The marching ants around the picked shape. On screen only — `flattenAnnotations` never asks for it. */
function paintSelection(ctx: CanvasRenderingContext2D, shape: AnnotationShape) {
    const bounds = shapeBounds(shape)
    const padding = shape.width
    ctx.save()
    ctx.setLineDash([6, 4])
    ctx.lineWidth = 1
    ctx.strokeStyle = '#ffffff'
    ctx.strokeRect(
        bounds.x - padding,
        bounds.y - padding,
        bounds.width + padding * 2,
        bounds.height + padding * 2
    )
    ctx.restore()
}

/**
 * The strokes, over whatever is already on the context.
 *
 * With an eraser in the list they are painted on a layer of their own first, because
 * `destination-out` cuts whatever it is drawn on: straight onto the picture it would punch a hole
 * through the photograph instead of rubbing out ink. Without one there is nothing to cut, so the
 * layer is skipped and the strokes land directly.
 */
export function paintAnnotations(
    ctx: CanvasRenderingContext2D,
    shapes: readonly AnnotationShape[],
    selectedId?: string
) {
    const layer = shapes.some(shape => shape.kind === 'erase') ? inkLayer(ctx) : undefined
    const target = layer?.ctx ?? ctx
    for (const shape of shapes) {
        // No layer means nothing safe to cut into, so a rub-out is left out rather than taken out
        // of the photograph underneath.
        if (shape.kind === 'erase' && !layer) continue
        paintShape(target, shape)
    }
    if (layer) ctx.drawImage(layer.canvas, 0, 0)
    const selected = shapes.find(shape => shape.id === selectedId)
    if (selected) paintSelection(ctx, selected)
}

/** A transparent canvas the size of the one being painted, for the strokes an eraser cuts into. */
function inkLayer(
    ctx: CanvasRenderingContext2D
): {canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D} | undefined {
    const canvas = document.createElement('canvas')
    canvas.width = ctx.canvas.width
    canvas.height = ctx.canvas.height
    const layer = canvas.getContext('2d')
    return layer ? {canvas, ctx: layer} : undefined
}

export function loadImage(src: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const image = new Image()
        image.addEventListener('load', () => {
            resolve(image)
        })
        image.addEventListener('error', () => {
            reject(new Error('The image could not be read'))
        })
        image.src = src
    })
}

/** A PNG whatever went in: an edited JPEG re-encoded as JPEG would lose a little more every save. */
export function annotatedName(name: string): string {
    const cut = name.lastIndexOf('.')
    return `${cut > 0 ? name.slice(0, cut) : name}.png`
}

export type FlattenRequest = Readonly<{
    src: string
    size: ImageSize
    shapes: readonly AnnotationShape[]
    name: string
}>

export async function flattenAnnotations(request: FlattenRequest): Promise<File> {
    const image = await loadImage(request.src)
    const canvas = document.createElement('canvas')
    canvas.width = request.size.width
    canvas.height = request.size.height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('This window cannot draw images')
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
    paintAnnotations(ctx, request.shapes)
    const blob = await new Promise<Blob | null>(resolve => {
        canvas.toBlob(resolve, 'image/png')
    })
    if (!blob) throw new Error('The edited image could not be encoded')
    return new File([blob], annotatedName(request.name), {type: 'image/png'})
}

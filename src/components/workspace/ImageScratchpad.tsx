import {useEffect, useMemo, useRef, useState} from 'react'
import type {ComponentType, CSSProperties, PointerEvent as ReactPointerEvent, SVGProps} from 'react'
import {Banner} from '@astryxdesign/core/Banner'
import {Button} from '@astryxdesign/core/Button'
import {Dialog, DialogHeader} from '@astryxdesign/core/Dialog'
import {Icon} from '@astryxdesign/core/Icon'
import {Slider} from '@astryxdesign/core/Slider'
import {HStack, StackItem, VStack} from '@astryxdesign/core/Stack'
import {Text} from '@astryxdesign/core/Text'
import {ToggleButton, ToggleButtonGroup} from '@astryxdesign/core/ToggleButton'
import {Toolbar} from '@astryxdesign/core/Toolbar'
import ArrowLongRightIcon from '@heroicons/react/24/outline/ArrowLongRightIcon'
import BackspaceIcon from '@heroicons/react/24/outline/BackspaceIcon'
import ArrowUturnLeftIcon from '@heroicons/react/24/outline/ArrowUturnLeftIcon'
import ArrowUturnRightIcon from '@heroicons/react/24/outline/ArrowUturnRightIcon'
import ChatBubbleBottomCenterTextIcon from '@heroicons/react/24/outline/ChatBubbleBottomCenterTextIcon'
import CursorArrowRaysIcon from '@heroicons/react/24/outline/CursorArrowRaysIcon'
import PaintBrushIcon from '@heroicons/react/24/outline/PaintBrushIcon'
import PencilIcon from '@heroicons/react/24/outline/PencilIcon'
import StopIcon from '@heroicons/react/24/outline/StopIcon'
import TrashIcon from '@heroicons/react/24/outline/TrashIcon'
import {
    ANNOTATION_COLORS,
    ANNOTATION_WIDTHS,
    ROUND_SIZES,
    canRedo,
    canUndo,
    clearShapes,
    commitShapes,
    dragShape,
    EMPTY_HISTORY,
    isDegenerate,
    moveShape,
    redo,
    removeShape,
    replaceShape,
    shapeAt,
    startShape,
    textSize,
    toImagePoint,
    undo,
    withText
} from '../../models/annotation'
import type {
    AnnotationHistory,
    AnnotationPoint,
    AnnotationShape,
    AnnotationTool,
    TextShape
} from '../../models/annotation'
import {flattenAnnotations, loadImage, paintAnnotations} from '../../services/annotation-canvas'
import type {DraftAttachment} from '../../models/chat'

type ScratchpadMode = 'select' | AnnotationTool | 'brush'

const ROUND_MODES: readonly ScratchpadMode[] = ['brush', 'erase']

type ImageScratchpadProps = Readonly<{
    attachment: DraftAttachment
    onSave: (file: File, shapes: readonly AnnotationShape[]) => Promise<void>
    onClose: () => void
}>

const CANVAS_STYLE = {
    maxWidth: '100%',
    height: 'auto',
    display: 'block',
    alignSelf: 'center',
    touchAction: 'none'
} as const

const CANVAS_ANCHOR_STYLE = {position: 'relative', alignSelf: 'center', maxWidth: '100%'} as const

const LABEL_HALO = '0 0 3px rgba(0, 0, 0, 0.9), 0 0 3px rgba(0, 0, 0, 0.9)'

function labelStyle(shape: TextShape, scale: number): CSSProperties {
    const size = textSize(shape.width) * scale
    return {
        position: 'absolute',
        left: shape.at.x * scale,
        top: shape.at.y * scale - size,
        margin: 0,
        padding: 0,
        border: 'none',
        outline: 'none',
        background: 'transparent',
        color: shape.color,
        caretColor: shape.color,
        font: `600 ${String(size)}px sans-serif`,
        lineHeight: 1,
        textShadow: LABEL_HALO,
        width: `${String(Math.max(shape.text.length, 6))}ch`
    }
}

const MODE_CURSOR: Record<ScratchpadMode, string> = {
    select: 'default',
    pen: 'crosshair',
    brush: 'crosshair',
    erase: 'crosshair',
    arrow: 'crosshair',
    box: 'crosshair',
    text: 'text'
}

const CURSOR_LIMIT = 120

function roundCursor(diameter: number, color: string): string {
    const size = Math.min(Math.max(diameter, 6), CURSOR_LIMIT)
    const edge = size + 4
    const centre = edge / 2
    const ring = (stroke: string, at: number, on: number) =>
        `<circle cx="${String(centre)}" cy="${String(centre)}" r="${String(at)}" fill="none" stroke="${stroke}" stroke-width="${String(on)}"/>`
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${String(edge)}" height="${String(edge)}">${ring('rgba(0,0,0,0.8)', size / 2, 3)}${ring(color, size / 2, 1.5)}</svg>`
    return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${String(centre)} ${String(centre)}, crosshair`
}

const TOOLS: readonly {
    mode: ScratchpadMode
    label: string
    tooltip: string
    hint: string
    icon: ComponentType<SVGProps<SVGSVGElement>>
}[] = [
    {
        mode: 'select',
        label: 'Pick',
        tooltip: 'Pick — move or delete a stroke you already drew',
        hint: 'Drag a shape to move it. Delete removes it.',
        icon: CursorArrowRaysIcon
    },
    {
        mode: 'pen',
        label: 'Draw',
        tooltip: 'Draw — freehand pen',
        hint: 'Drag to draw freehand. Ctrl+Z undoes.',
        icon: PencilIcon
    },
    {
        mode: 'brush',
        label: 'Brush',
        tooltip: 'Brush — a fat round stroke, sized by the slider',
        hint: 'Drag to paint. The slider sets how wide the round tip is.',
        icon: PaintBrushIcon
    },
    {
        mode: 'erase',
        label: 'Erase',
        tooltip: 'Erase — rub out strokes, never the picture',
        hint: 'Drag over your own strokes to rub them out. The picture stays.',
        icon: BackspaceIcon
    },
    {
        mode: 'arrow',
        label: 'Arrow',
        tooltip: 'Arrow — point at something',
        hint: 'Drag from the tail to the head. Ctrl+Z undoes.',
        icon: ArrowLongRightIcon
    },
    {
        mode: 'box',
        label: 'Box',
        tooltip: 'Box — ring something',
        hint: 'Drag one corner to the other. Ctrl+Z undoes.',
        icon: StopIcon
    },
    {
        mode: 'text',
        label: 'Label',
        tooltip: 'Label — type words on the picture',
        hint: 'Click where the label goes, then type. Enter keeps it.',
        icon: ChatBubbleBottomCenterTextIcon
    }
]

const TOOL_HINT: Record<ScratchpadMode, string> = Object.fromEntries(
    TOOLS.map(tool => [tool.mode, tool.hint])
) as Record<ScratchpadMode, string>

const WIDTH_LABELS = ['Thin', 'Medium', 'Thick'] as const

function swatchIcon(color: string): ComponentType<SVGProps<SVGSVGElement>> {
    return function Swatch(props: SVGProps<SVGSVGElement>) {
        return (
            <svg
                viewBox='0 0 16 16'
                {...props}
            >
                <circle
                    cx='8'
                    cy='8'
                    r='6'
                    fill={color}
                />
            </svg>
        )
    }
}

const SWATCH_NAMES = ['Red', 'Yellow', 'Green', 'Blue'] as const

const SWATCHES = ANNOTATION_COLORS.map((color, index) => ({
    color,
    name: SWATCH_NAMES[index] ?? color,
    icon: swatchIcon(color)
}))

export function ImageScratchpad({attachment, onSave, onClose}: ImageScratchpadProps) {
    const source = attachment.annotation?.src ?? attachment.previewUrl
    const [mode, setMode] = useState<ScratchpadMode>('pen')
    const [color, setColor] = useState<string>(ANNOTATION_COLORS[0])
    const [width, setWidth] = useState<number>(ANNOTATION_WIDTHS[1])
    const [roundWidth, setRoundWidth] = useState<number>(ROUND_SIZES.initial)
    const [history, setHistory] = useState<AnnotationHistory>(() => ({
        ...EMPTY_HISTORY,
        shapes: attachment.annotation?.shapes ?? []
    }))
    const [drafting, setDrafting] = useState<AnnotationShape>()
    const [moving, setMoving] = useState<readonly AnnotationShape[]>()
    const [labelling, setLabelling] = useState<TextShape>()
    const [selectedId, setSelectedId] = useState<string>()
    const [hovered, setHovered] = useState(false)
    const [scale, setScale] = useState(1)
    const [image, setImage] = useState<HTMLImageElement>()
    const [isSaving, setIsSaving] = useState(false)
    const [failure, setFailure] = useState<string>()
    const canvasRef = useRef<HTMLCanvasElement>(null)
    const lastPoint = useRef<AnnotationPoint>({x: 0, y: 0})

    const isRound = ROUND_MODES.includes(mode)
    const drawWidth = isRound ? roundWidth : width
    const brushCursor = useMemo(
        () => (isRound ? roundCursor(drawWidth * scale, color) : undefined),
        [color, drawWidth, isRound, scale]
    )
    const shapes = moving ?? history.shapes
    const painted = useMemo(
        () =>
            [...shapes, drafting].filter((shape): shape is AnnotationShape => shape !== undefined),
        [shapes, drafting]
    )

    useEffect(() => {
        let isCurrent = true
        loadImage(source)
            .then(loaded => {
                if (isCurrent) setImage(loaded)
            })
            .catch(() => {
                if (isCurrent) setFailure('This image could not be opened for drawing.')
            })
        return () => {
            isCurrent = false
        }
    }, [source])

    useEffect(() => {
        const canvas = canvasRef.current
        const ctx = canvas?.getContext('2d')
        if (!canvas || !ctx || !image) return
        ctx.clearRect(0, 0, canvas.width, canvas.height)
        ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
        paintAnnotations(ctx, painted, selectedId)
    }, [image, painted, selectedId])

    useEffect(() => {
        const canvas = canvasRef.current
        if (!canvas) return
        const observer = new ResizeObserver(entries => {
            const shown = entries[0]?.contentRect.width ?? 0
            if (canvas.width > 0 && shown > 0) setScale(shown / canvas.width)
        })
        observer.observe(canvas)
        return () => {
            observer.disconnect()
        }
    }, [image])

    const commit = (next: readonly AnnotationShape[]) => {
        setHistory(current => commitShapes(current, next))
    }

    const finishLabel = () => {
        if (!labelling) return
        if (!isDegenerate(labelling)) commit([...shapes, labelling])
        setLabelling(undefined)
    }

    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (event.target instanceof HTMLInputElement) return
            if ((event.key === 'Delete' || event.key === 'Backspace') && selectedId) {
                event.preventDefault()
                setHistory(current =>
                    commitShapes(current, removeShape(current.shapes, selectedId))
                )
                setSelectedId(undefined)
                return
            }
            if (!event.ctrlKey || event.key.toLowerCase() !== 'z') return
            event.preventDefault()
            setHistory(current => (event.shiftKey ? redo(current) : undo(current)))
        }
        window.addEventListener('keydown', onKey)
        return () => {
            window.removeEventListener('keydown', onKey)
        }
    }, [selectedId])

    const pointOf = (event: ReactPointerEvent<HTMLCanvasElement>): AnnotationPoint => {
        const rect = event.currentTarget.getBoundingClientRect()
        return toImagePoint(
            {x: rect.left, y: rect.top, width: rect.width, height: rect.height},
            {width: event.currentTarget.width, height: event.currentTarget.height},
            {x: event.clientX, y: event.clientY}
        )
    }

    const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
        const point = pointOf(event)
        lastPoint.current = point
        finishLabel()
        event.currentTarget.setPointerCapture(event.pointerId)
        if (mode === 'select') {
            const hit = shapeAt(shapes, point)
            setSelectedId(hit?.id)
            if (hit) setMoving(shapes)
            return
        }
        setSelectedId(undefined)
        const tool: AnnotationTool = mode === 'brush' ? 'pen' : mode
        const started = startShape(tool, crypto.randomUUID(), {color, width: drawWidth}, point)
        if (started.kind === 'text') setLabelling(started)
        else setDrafting(started)
    }

    const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
        if (!drafting && !moving) {
            if (mode === 'select') setHovered(shapeAt(shapes, pointOf(event)) !== undefined)
            return
        }
        const point = pointOf(event)
        if (drafting) {
            setDrafting(dragShape(drafting, point))
        } else if (moving && selectedId) {
            const picked = moving.find(shape => shape.id === selectedId)
            if (picked)
                setMoving(
                    replaceShape(
                        moving,
                        moveShape(
                            picked,
                            point.x - lastPoint.current.x,
                            point.y - lastPoint.current.y
                        )
                    )
                )
        }
        lastPoint.current = point
    }

    const onPointerUp = () => {
        if (drafting) {
            if (!isDegenerate(drafting)) commit([...shapes, drafting])
            setDrafting(undefined)
        }
        if (moving) {
            commit(moving)
            setMoving(undefined)
        }
    }

    const save = async () => {
        const canvas = canvasRef.current
        if (!canvas) return
        setIsSaving(true)
        setFailure(undefined)
        try {
            const saved = labelling && !isDegenerate(labelling) ? [...shapes, labelling] : shapes
            const file = await flattenAnnotations({
                src: source,
                size: {width: canvas.width, height: canvas.height},
                shapes: saved,
                name: attachment.name
            })
            await onSave(file, saved)
        } catch (error) {
            setFailure(error instanceof Error ? error.message : 'The drawing could not be saved.')
            setIsSaving(false)
        }
    }

    return (
        <Dialog
            isOpen
            variant='fullscreen'
            purpose='form'
            onOpenChange={next => {
                if (!next) onClose()
            }}
        >
            <DialogHeader
                title={attachment.name}
                subtitle='Draw on it, then send it. The strokes stay editable.'
                onOpenChange={next => {
                    if (!next) onClose()
                }}
            />
            <Toolbar
                label='Drawing tools'
                size='sm'
                dividers={['bottom']}
                startContent={
                    <HStack
                        gap={3}
                        align='center'
                    >
                        <ToggleButtonGroup
                            label='Tool'
                            size='sm'
                            value={mode}
                            onChange={value => {
                                if (typeof value === 'string') setMode(value as ScratchpadMode)
                            }}
                        >
                            {TOOLS.map(tool => (
                                <ToggleButton
                                    key={tool.mode}
                                    value={tool.mode}
                                    label={tool.label}
                                    tooltip={tool.tooltip}
                                    isIconOnly
                                    icon={<Icon icon={tool.icon} />}
                                />
                            ))}
                        </ToggleButtonGroup>
                        <ToggleButtonGroup
                            label='Colour'
                            size='sm'
                            value={color}
                            onChange={value => {
                                if (typeof value === 'string') setColor(value)
                            }}
                        >
                            {SWATCHES.map(swatch => (
                                <ToggleButton
                                    key={swatch.color}
                                    value={swatch.color}
                                    label={`${swatch.name} ink`}
                                    tooltip={`${swatch.name} ink`}
                                    isIconOnly
                                    icon={<Icon icon={swatch.icon} />}
                                />
                            ))}
                        </ToggleButtonGroup>
                        {isRound ?
                            <Slider
                                label='Size'
                                width={180}
                                min={ROUND_SIZES.min}
                                max={ROUND_SIZES.max}
                                step={ROUND_SIZES.step}
                                value={roundWidth}
                                formatValue={size => `${String(size)}px`}
                                onChange={setRoundWidth}
                            />
                        :   <ToggleButtonGroup
                                label='Stroke width'
                                size='sm'
                                value={String(width)}
                                onChange={value => {
                                    if (typeof value === 'string') setWidth(Number(value))
                                }}
                            >
                                {ANNOTATION_WIDTHS.map((stroke, index) => (
                                    <ToggleButton
                                        key={stroke}
                                        value={String(stroke)}
                                        label={WIDTH_LABELS[index] ?? String(stroke)}
                                        tooltip={`${WIDTH_LABELS[index] ?? String(stroke)} stroke, ${String(stroke)}px`}
                                    >
                                        {WIDTH_LABELS[index] ?? String(stroke)}
                                    </ToggleButton>
                                ))}
                            </ToggleButtonGroup>
                        }
                    </HStack>
                }
                endContent={
                    <HStack gap={1}>
                        <Button
                            label='Undo'
                            size='sm'
                            variant='ghost'
                            isIconOnly
                            icon={<Icon icon={ArrowUturnLeftIcon} />}
                            tooltip='Undo'
                            isDisabled={!canUndo(history)}
                            clickAction={() => {
                                setHistory(undo)
                            }}
                        />
                        <Button
                            label='Redo'
                            size='sm'
                            variant='ghost'
                            isIconOnly
                            icon={<Icon icon={ArrowUturnRightIcon} />}
                            tooltip='Redo'
                            isDisabled={!canRedo(history)}
                            clickAction={() => {
                                setHistory(redo)
                            }}
                        />
                        <Button
                            label='Clear'
                            size='sm'
                            variant='ghost'
                            isIconOnly
                            icon={<Icon icon={TrashIcon} />}
                            tooltip='Clear every stroke'
                            isDisabled={shapes.length === 0}
                            clickAction={() => {
                                setSelectedId(undefined)
                                setHistory(clearShapes)
                            }}
                        />
                    </HStack>
                }
            />
            <HStack
                padding={3}
                align='center'
            >
                <Text type='supporting'>{TOOL_HINT[mode]}</Text>
            </HStack>
            <StackItem
                size='fill'
                isScrollable
            >
                <VStack
                    padding={3}
                    gap={3}
                >
                    {failure && (
                        <Banner
                            status='error'
                            title={failure}
                        />
                    )}
                    <VStack style={CANVAS_ANCHOR_STYLE}>
                        <canvas
                            ref={canvasRef}
                            width={image?.naturalWidth ?? 0}
                            height={image?.naturalHeight ?? 0}
                            aria-label={`Drawing surface for ${attachment.name}`}
                            role='img'
                            tabIndex={0}
                            style={{
                                ...CANVAS_STYLE,
                                cursor: hovered ? 'move' : (brushCursor ?? MODE_CURSOR[mode])
                            }}
                            onPointerDown={onPointerDown}
                            onPointerMove={onPointerMove}
                            onPointerUp={onPointerUp}
                        />
                        {labelling && (
                            <input
                                aria-label='Label'
                                value={labelling.text}
                                autoFocus
                                style={labelStyle(labelling, scale)}
                                onChange={event => {
                                    setLabelling(withText(labelling, event.target.value))
                                }}
                                onKeyDown={event => {
                                    if (event.key === 'Enter') finishLabel()
                                    if (event.key === 'Escape') setLabelling(undefined)
                                }}
                            />
                        )}
                    </VStack>
                </VStack>
            </StackItem>
            <HStack
                padding={3}
                gap={3}
                justify='between'
                align='center'
            >
                <Text type='supporting'>Sending uses the flattened picture.</Text>
                <HStack gap={2}>
                    <Button
                        label='Cancel'
                        variant='secondary'
                        isDisabled={isSaving}
                        clickAction={onClose}
                    />
                    <Button
                        label='Save'
                        variant='primary'
                        isDisabled={!image || isSaving}
                        isLoading={isSaving}
                        clickAction={save}
                    />
                </HStack>
            </HStack>
        </Dialog>
    )
}

import {useCallback, useEffect, useState} from 'react'
import {Banner} from '@astryxdesign/core/Banner'
import {Button} from '@astryxdesign/core/Button'
import {Collapsible, CollapsibleGroup} from '@astryxdesign/core/Collapsible'
import {Dialog, DialogHeader} from '@astryxdesign/core/Dialog'
import {Divider} from '@astryxdesign/core/Divider'
import {SegmentedControl, SegmentedControlItem} from '@astryxdesign/core/SegmentedControl'
import {HStack, StackItem, VStack} from '@astryxdesign/core/Stack'
import {Text} from '@astryxdesign/core/Text'
import {Token} from '@astryxdesign/core/Token'
import {
    listProjectSketches,
    readProjectSketch,
    toSketchError
} from '../../services/project-sketches'
import {describeBlocked} from '../../services/sketch-regions'
import {SKETCH_CANVAS, sketchMessage} from '../../models/sketch'
import {useChatReferences} from '../../hooks/useChatReferences'
import {PanelState} from './PanelState'
import {SketchFrame} from './SketchFrame'
import type {ProjectSketch, SketchHtml} from '../../models/sketch'
import type {CommandError} from '../../models/errors'

const PREVIEW_LENGTH = 110

const SPARE = 300

type SketchFilter = 'all' | 'approved'

function preview(question: string): string {
    const line = question.replace(/\s+/gu, ' ').trim()
    return line.length > PREVIEW_LENGTH ? `${line.slice(0, PREVIEW_LENGTH)}…` : line
}

export function SketchesView() {
    const references = useChatReferences()
    const [sketches, setSketches] = useState<readonly ProjectSketch[]>()
    const [error, setError] = useState<CommandError>()
    const [isLoading, setIsLoading] = useState(true)
    const [filter, setFilter] = useState<SketchFilter>('all')
    const [openId, setOpenId] = useState<string>()
    const [html, setHtml] = useState<ReadonlyMap<string, SketchHtml>>(() => new Map())
    const [readFailure, setReadFailure] = useState<{id: string; reason: string}>()
    const [blocked, setBlocked] = useState<readonly string[]>([])
    const [zoomed, setZoomed] = useState<ProjectSketch>()
    const [reads, setReads] = useState(0)

    useEffect(() => {
        let cancelled = false
        void listProjectSketches()
            .then(rows => {
                if (cancelled) return
                setSketches(rows)
                setError(undefined)
            })
            .catch((failure: unknown) => {
                if (cancelled) return
                setError(toSketchError(failure))
                setSketches(undefined)
            })
            .finally(() => {
                if (!cancelled) setIsLoading(false)
            })
        return () => {
            cancelled = true
        }
    }, [reads])

    useEffect(() => {
        if (openId === undefined || html.has(openId)) return
        let cancelled = false
        void readProjectSketch(openId)
            .then(body => {
                if (!cancelled) setHtml(previous => new Map(previous).set(openId, body))
            })
            .catch((failure: unknown) => {
                if (cancelled) return
                const {message, code} = toSketchError(failure)
                setReadFailure({id: openId, reason: `${message} (${code})`})
            })
        return () => {
            cancelled = true
        }
    }, [openId, html])

    const refresh = useCallback(() => {
        setIsLoading(true)
        setHtml(new Map())
        setReadFailure(undefined)
        setBlocked([])
        setReads(count => count + 1)
    }, [])

    const open = useCallback((value: string | string[]) => {
        const chosen = Array.isArray(value) ? value[0] : value
        setOpenId(chosen === undefined || chosen === '' ? undefined : chosen)
        setBlocked([])
        setReadFailure(undefined)
    }, [])

    const noteBlocked = useCallback((uri: string) => {
        setBlocked(previous => (previous.includes(uri) ? previous : [...previous, uri]))
    }, [])

    const all = sketches ?? []
    const approved = all.filter(sketch => sketch.isApproved)
    const shown = filter === 'approved' ? approved : all
    const refused = describeBlocked(blocked)

    return (
        <VStack
            gap={0}
            height='100%'
        >
            <HStack
                gap={3}
                padding={3}
                align='center'
            >
                <SegmentedControl
                    size='sm'
                    label='Which sketches to show'
                    value={filter}
                    onChange={value => {
                        setFilter(value as SketchFilter)
                    }}
                >
                    <SegmentedControlItem
                        value='all'
                        label={`All ${String(all.length)}`}
                    />
                    <SegmentedControlItem
                        value='approved'
                        label={`Agreed ${String(approved.length)}`}
                    />
                </SegmentedControl>
                <StackItem size='fill'>
                    <Text
                        type='supporting'
                        color='secondary'
                    >
                        The layout you chose, as it was drawn for you.
                    </Text>
                </StackItem>
                <Button
                    label='Refresh'
                    size='sm'
                    isDisabled={isLoading}
                    clickAction={refresh}
                />
            </HStack>
            <Divider />
            <StackItem
                size='fill'
                isScrollable
            >
                <PanelState
                    label='saved sketches'
                    isLoading={isLoading}
                    error={error}
                    isEmpty={shown.length === 0}
                    emptyTitle={filter === 'approved' ? 'Nothing agreed yet' : 'No sketches yet'}
                    emptyDescription={
                        filter === 'approved' ?
                            'A design is agreed when you press Complete and handoff.'
                        :   'A sketch is kept whenever you answer a question the agent drew a layout for.'
                    }
                >
                    <CollapsibleGroup
                        type='single'
                        hasDividers
                        value={openId ?? ''}
                        onChange={open}
                    >
                        {shown.map(sketch => (
                            <Collapsible
                                key={sketch.id}
                                value={sketch.id}
                                trigger={
                                    <VStack gap={1}>
                                        <HStack
                                            gap={2}
                                            align='center'
                                        >
                                            <StackItem size='fill'>
                                                <Text maxLines={1}>{sketch.label}</Text>
                                            </StackItem>
                                            {sketch.isApproved && (
                                                <Token
                                                    size='sm'
                                                    color='green'
                                                    label='agreed'
                                                />
                                            )}
                                        </HStack>
                                        <HStack
                                            gap={2}
                                            align='center'
                                        >
                                            <StackItem size='fill'>
                                                <Text
                                                    type='supporting'
                                                    color='secondary'
                                                    maxLines={1}
                                                >
                                                    {preview(sketch.question)}
                                                </Text>
                                            </StackItem>
                                            <Text
                                                type='supporting'
                                                color='secondary'
                                            >
                                                {new Date(sketch.savedAt).toLocaleDateString()}
                                            </Text>
                                        </HStack>
                                    </VStack>
                                }
                            >
                                {openId === sketch.id && (
                                    <SketchBody
                                        sketch={sketch}
                                        {...(html.get(sketch.id) && {html: html.get(sketch.id)})}
                                        {...(readFailure?.id === sketch.id && {
                                            failure: readFailure.reason
                                        })}
                                        refused={refused}
                                        onBlocked={noteBlocked}
                                        onZoom={() => {
                                            setZoomed(sketch)
                                        }}
                                        {...(references && {onSend: references.paste})}
                                    />
                                )}
                            </Collapsible>
                        ))}
                    </CollapsibleGroup>
                </PanelState>
            </StackItem>
            {zoomed !== undefined && (
                <Dialog
                    isOpen
                    purpose='form'
                    width='96vw'
                    maxHeight='94vh'
                    onOpenChange={isOpen => {
                        if (!isOpen) setZoomed(undefined)
                    }}
                >
                    <DialogHeader
                        title={zoomed.label}
                        subtitle={zoomed.question}
                    />
                    <VStack
                        gap={3}
                        padding={4}
                    >
                        <SketchFrame
                            html={html.get(zoomed.id)?.shown ?? ''}
                            canvasSize={SKETCH_CANVAS}
                            spare={160}
                            onBlocked={noteBlocked}
                        />
                    </VStack>
                </Dialog>
            )}
        </VStack>
    )
}

type SketchBodyProps = Readonly<{
    sketch: ProjectSketch
    html?: SketchHtml | undefined
    failure?: string | undefined
    refused: readonly string[]
    onBlocked: (uri: string) => void
    onZoom: () => void
    onSend?: ((text: string) => void) | undefined
}>

function SketchBody({sketch, html, failure, refused, onBlocked, onZoom, onSend}: SketchBodyProps) {
    if (failure !== undefined)
        return (
            <Banner
                container='section'
                status='error'
                title='This sketch could not be read'
                description={failure}
            />
        )
    if (!html)
        return (
            <Text
                type='supporting'
                color='secondary'
            >
                Opening the layout…
            </Text>
        )
    const source = html.source
    return (
        <VStack
            gap={3}
            padding={2}
        >
            <SketchFrame
                html={html.shown}
                canvasSize={SKETCH_CANVAS}
                spare={SPARE}
                onBlocked={onBlocked}
                onOpen={onZoom}
                openLabel={`Open ${sketch.label} full size`}
            />
            {refused.length > 0 && (
                <Banner
                    status='warning'
                    title='Part of this sketch could not load'
                    description={`Nothing outside Gofer is allowed to load here, so ${refused.join(', ')} never arrived. The layout is what was agreed; the missing pieces are this window's, not the design's.`}
                />
            )}
            <HStack
                gap={2}
                justify='end'
                align='center'
            >
                {source === null && (
                    <Text
                        type='supporting'
                        color='secondary'
                    >
                        This one was saved before Gofer kept the markup a builder can use.
                    </Text>
                )}
                <Button
                    label='Send to chat'
                    variant='primary'
                    isDisabled={source === null || onSend === undefined}
                    onClick={() => {
                        if (source !== null && onSend) onSend(sketchMessage(sketch, source))
                    }}
                />
            </HStack>
        </VStack>
    )
}

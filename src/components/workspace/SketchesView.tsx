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

/** How much of the question the closed row shows. */
const PREVIEW_LENGTH = 110

/** How much of the window height everything above and below one sketch needs. */
const SPARE = 300

/** Which rows the list is showing. */
type SketchFilter = 'all' | 'approved'

function preview(question: string): string {
    const line = question.replace(/\s+/gu, ' ').trim()
    return line.length > PREVIEW_LENGTH ? `${line.slice(0, PREVIEW_LENGTH)}…` : line
}

/**
 * The layouts this project has agreed, so one can be looked at again.
 *
 * `ask_user` puts a sketch in front of the user inside a card, and the card closes the moment they
 * answer. That is right for the question and wrong for the layout: what they agreed is the thing the
 * whole design loop existed to produce, and until this screen it was gone the second it was decided.
 *
 * Only what was chosen is here. A round the user rejected is not a layout they agreed, and a list
 * that showed all of them would be asking somebody to remember which of five they picked — which is
 * the question this screen exists to stop them having to answer.
 *
 * The markup is fetched a row at a time rather than with the list. The copy drawn here has the
 * project's own artwork inlined into it, so it runs to tens of kilobytes; forty of them would be
 * carried across the seam so that one could be looked at.
 *
 * Send to chat pastes the model's own markup, never the inlined copy. They are the same layout to
 * look at and nothing alike to build from: one says `res://ui/panel.png` and the other is base64.
 */
export function SketchesView() {
    const references = useChatReferences()
    const [sketches, setSketches] = useState<readonly ProjectSketch[]>()
    const [error, setError] = useState<CommandError>()
    const [isLoading, setIsLoading] = useState(true)
    const [filter, setFilter] = useState<SketchFilter>('all')
    const [openId, setOpenId] = useState<string>()
    // The markup of every sketch opened so far. Closing a row and opening it again is a gesture, not
    // a request to fetch eighty kilobytes twice.
    const [html, setHtml] = useState<ReadonlyMap<string, SketchHtml>>(() => new Map())
    const [readFailure, setReadFailure] = useState<{id: string; reason: string}>()
    const [blocked, setBlocked] = useState<readonly string[]>([])
    // Which sketch is open at full size, or none. A viewer over the panel, never a second copy of
    // it: what is underneath is unchanged and comes back when this closes.
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

    const refresh = useCallback(() => {
        setIsLoading(true)
        setReads(count => count + 1)
    }, [])

    const open = useCallback(
        (value: string | string[]) => {
            const chosen = Array.isArray(value) ? value[0] : value
            const id = chosen === undefined || chosen === '' ? undefined : chosen
            setOpenId(id)
            setBlocked([])
            setReadFailure(undefined)
            if (id === undefined || html.has(id)) return
            void readProjectSketch(id)
                .then(body => {
                    setHtml(previous => new Map(previous).set(id, body))
                })
                .catch((failure: unknown) => {
                    const {message, code} = toSketchError(failure)
                    setReadFailure({id, reason: `${message} (${code})`})
                })
        },
        [html]
    )

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
                                    /*
                                     * Two lines, each with one thing that may grow.
                                     *
                                     * Three of them on one row is what shipped first, and in the
                                     * 330 pixels this column actually has it truncated the badge
                                     * to "agr…" — the one word on the row that has to be read
                                     * exactly.
                                     */
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
                            </Collapsible>
                        ))}
                    </CollapsibleGroup>
                </PanelState>
            </StackItem>
            {/*
             * A layout is 1280 pixels wide and this column has about 330 of them.
             *
             * Shrunk to a quarter it is a picture of a layout rather than a layout, which is not
             * enough to re-check anything — and re-checking is the whole reason this screen exists.
             * The same magnifier the question card carries, over the same frame.
             */}
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
    /** Absent when this panel is rendered with no conversation to paste into. */
    onSend?: ((text: string) => void) | undefined
}>

/**
 * One opened sketch: the drawing, and the one thing to do with it.
 *
 * A sketch with no source markup is one kept before the second copy existed. The button says so and
 * stays put rather than disappearing — a control that vanishes on some rows and not others reads as
 * a fault in the screen rather than as a fact about the row.
 */
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

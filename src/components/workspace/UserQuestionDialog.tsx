import {useState} from 'react'
import {Badge} from '@astryxdesign/core/Badge'
import {Banner} from '@astryxdesign/core/Banner'
import {Button} from '@astryxdesign/core/Button'
import {Dialog, DialogHeader} from '@astryxdesign/core/Dialog'
import {SelectableCard} from '@astryxdesign/core/SelectableCard'
import {Grid} from '@astryxdesign/core/Grid'
import {Spinner} from '@astryxdesign/core/Spinner'
import {HStack, StackItem, VStack} from '@astryxdesign/core/Stack'
import {Text} from '@astryxdesign/core/Text'
import {TextArea} from '@astryxdesign/core/TextArea'
import {describeBlocked, remoteReferences} from '../../services/sketch-regions'
import {SketchFrame} from './SketchFrame'
import type {UserQuestionPrompt, UserQuestionResponse} from '../../models/brief'

type UserQuestionDialogProps = Readonly<{
    prompt?: UserQuestionPrompt | undefined
    /**
     * The design loop is between rounds: this prompt has been answered and the next has not arrived.
     *
     * The card stays where it is rather than closing, which is the whole point of a design session.
     * Nothing here decides when that is true — see `useDesignSession`.
     */
    isRedrawing?: boolean
    onAnswer: (response: UserQuestionResponse) => void
}>

/*
 * A question in words is a small card. A question about a layout takes the window.
 *
 * At a flat 1100 by 420 on the shipped 1280x800 window, the second of two sketches was cut off by
 * the window edge and the buttons sat below the fold. Both are the same mistake: a dialog sized by a
 * number somebody guessed rather than by the window it is inside.
 */
const TEXT_WIDTH = 520
const SKETCH_WIDTH = '96vw'
const SKETCH_MAX_HEIGHT = '94vh'

/**
 * The size a sketch is drawn at before it is shrunk to fit its column.
 *
 * A game's layout is a fixed number of pixels. Reflowed into whatever width the column happens to
 * have, it is a different design from the one being judged; drawn at its own width it is cut off by
 * the column edge, which is what shipped first.
 */
const SKETCH_CANVAS = {width: 1280, height: 720}

/**
 * Asks the user one thing the agent could not settle, with or without pictures.
 *
 * Not a brief dialog, though the brief is what it was built for: `ask_user` is an ordinary tool, so
 * an ordinary chat turn reaches this same card. Nothing here knows what asked.
 *
 * One card for both shapes of question, because they are one question. A decision about a *layout*
 * cannot be put into a sentence — the user would have to build the layout in their head before they
 * could correct it — so the question carries sketches when it needs to. Everything else is the same:
 * one thing asked, one answer, and a tool call on the other side holding a thread open.
 *
 * The sketches are the suggested answers, drawn. So the written suggestions are not shown beside
 * them: two lists of the same options, one in words and one in pictures, is two answers to give for
 * one decision, and the first build shipped exactly that.
 *
 * Only the oldest waiting question is shown. The agent may have more than one call in flight, but a
 * stack of dialogs makes it too easy to answer the wrong one.
 *
 * Dismissing is a skip, not a refusal and not an empty answer — the agent is told the user read it
 * and left the decision to it, and told not to ask again.
 *
 * A question that belongs to a design loop is the same card with two differences, and both are
 * because it is one of several. It cannot be dismissed by accident, since a stray Escape between
 * rounds would end a design the user is in the middle of. And it carries the button that ends the
 * loop, because otherwise the only way out is to stop answering.
 */
export function UserQuestionDialog({
    prompt,
    isRedrawing = false,
    onAnswer
}: UserQuestionDialogProps) {
    const [draft, setDraft] = useState('')
    const [picked, setPicked] = useState<number>()
    // Which sketch is open at full size, or none, which is the side-by-side comparison.
    const [opened, setOpened] = useState<number>()
    const [blocked, setBlocked] = useState<readonly string[]>([])
    // Which question this answer is being composed for. Compared during render rather than reset
    // from an effect, so an answer meant for one question can never reach the next: an effect would
    // clear it one render *after* the new question is already on screen with the old text in it.
    const [answering, setAnswering] = useState(prompt?.questionId)
    const [revision, setRevision] = useState(prompt?.revision)
    if (prompt?.questionId !== answering || prompt?.revision !== revision) {
        setAnswering(prompt?.questionId)
        setRevision(prompt?.revision)
        setDraft('')
        setPicked(undefined)
        setOpened(undefined)
        setBlocked([])
    }

    if (!prompt) return null

    /*
     * Whether this question is one round of a design, asked of the value rather than of its absence.
     *
     * `!== undefined` was wrong and a live sweep is what found it. The backend sends the field as
     * `null` when there is no design, and `null` is not `undefined` — so every ordinary question
     * arrived dressed as a design loop: it grew a button that ends one, its Answer control was
     * renamed, and Escape stopped closing it. The payload no longer carries the null either. This is
     * the half that holds if it ever does again.
     */
    const inDesign = typeof prompt.designSession === 'string' && prompt.designSession !== ''

    /*
     * Between rounds: the question is answered and the next drawing does not exist yet.
     *
     * The sketches go rather than staying greyed out. A layout the user can still read but can no
     * longer act on invites them to keep judging one that is already being replaced, and the pick
     * they make against it belongs to a round that is over.
     */
    if (isRedrawing)
        return (
            <Dialog
                isOpen
                purpose='required'
                width={TEXT_WIDTH}
                onOpenChange={() => undefined}
            >
                <DialogHeader title='Design in progress' />
                <VStack
                    gap={3}
                    padding={6}
                    align='center'
                >
                    <Spinner
                        size='lg'
                        label='Redrawing your layout'
                    />
                    <Text
                        size='sm'
                        color='secondary'
                    >
                        {`Round ${String(prompt.revision)} sent. The next one appears here.`}
                    </Text>
                </VStack>
            </Dialog>
        )

    const answer = draft.trim()
    const sketches = prompt.sketches
    const isVisual = sketches.length > 0
    // Both sources, unioned. The scan is what the markup asks for and is right immediately; the
    // listener is what the policy actually refused and catches whatever resolves later.
    const refused = describeBlocked([
        ...sketches.flatMap(sketch => remoteReferences(sketch.html)),
        ...blocked
    ])
    // The zoom is a viewer over the question, not a second screen of it: the question underneath is
    // unchanged and comes back when it closes, so nothing here has two places to be answered.
    const zoomed = opened === undefined ? undefined : sketches[opened]
    const hasAnswer = answer.length > 0 || picked !== undefined

    const noteBlocked = (uri: string) => {
        setBlocked(previous => (previous.includes(uri) ? previous : [...previous, uri]))
    }

    return (
        <Dialog
            isOpen
            // A design loop cannot be dismissed by accident. Escape and the backdrop between rounds
            // would end a design the user is halfway through, and the two ways out are on screen.
            purpose={inDesign ? 'required' : 'form'}
            width={isVisual ? SKETCH_WIDTH : TEXT_WIDTH}
            {...(isVisual && {maxHeight: SKETCH_MAX_HEIGHT})}
            onOpenChange={isOpen => {
                if (!isOpen && !inDesign)
                    onAnswer({questionId: prompt.questionId, blocked: refused, skipped: true})
            }}
        >
            {
                zoomed === undefined ?
                    <>
                        <DialogHeader
                            title={prompt.question}
                            {...(prompt.why && {subtitle: prompt.why})}
                            {...(prompt.revision > 1 && {
                                // Read from the prompt since the first build and never drawn, which
                                // is what made a revised layout look like a brand new question.
                                endContent: (
                                    <Badge
                                        variant='neutral'
                                        label={`Round ${String(prompt.revision)}`}
                                    />
                                )
                            })}
                        />
                        <VStack
                            gap={3}
                            padding={4}
                            isScrollable
                        >
                            {prompt.options.length > 0 && !isVisual && (
                                <VStack gap={2}>
                                    <Text
                                        size='sm'
                                        color='secondary'
                                    >
                                        {prompt.options.length === 1 ?
                                            'Suggested answer'
                                        :   'Suggested answers'}
                                    </Text>
                                    {prompt.options.map((option, index) => (
                                        <SelectableCard
                                            key={option}
                                            label={option}
                                            padding={2}
                                            // The asker puts the one it recommends first, so the first card is
                                            // the recommendation. Tinted AND labelled, not one or the other:
                                            // this theme is deliberately close to colourless, so a tint alone
                                            // is a distinction some screens and some readers will not see.
                                            variant={index === 0 ? 'green' : 'default'}
                                            isSelected={answer === option}
                                            onChange={() => {
                                                setDraft(option)
                                            }}
                                        >
                                            <HStack
                                                gap={2}
                                                align='center'
                                            >
                                                <Text size='sm'>{option}</Text>
                                                {index === 0 && (
                                                    <Badge
                                                        variant='success'
                                                        label='Recommended'
                                                    />
                                                )}
                                            </HStack>
                                        </SelectableCard>
                                    ))}
                                </VStack>
                            )}
                            {isVisual && (
                                <Grid
                                    columns={sketches.length}
                                    gap={3}
                                    align='start'
                                >
                                    {sketches.map((sketch, index) => (
                                        <VStack
                                            key={sketch.label}
                                            gap={2}
                                        >
                                            {/*
                                             * One line, at a height a badge cannot change.
                                             *
                                             * A row that grows for the badge on one column puts that
                                             * column's sketch lower than its neighbour's, which is the one
                                             * thing a side-by-side comparison has to get right. The visual
                                             * suite measures both frames' top edges for exactly this.
                                             */}
                                            <HStack
                                                gap={2}
                                                align='center'
                                                height={28}
                                            >
                                                <Text
                                                    size='sm'
                                                    weight='medium'
                                                    maxLines={1}
                                                >
                                                    {sketch.label}
                                                </Text>
                                                {/*
                                                 * The asker puts the one it recommends first, and this is
                                                 * the same green the written suggestions are marked in —
                                                 * one recommendation, one colour, whichever shape the
                                                 * question took.
                                                 */}
                                                {index === 0 && sketches.length > 1 && (
                                                    <Badge
                                                        variant='success'
                                                        label='Recommended'
                                                    />
                                                )}
                                            </HStack>
                                            <SketchFrame
                                                html={sketch.html}
                                                canvasSize={SKETCH_CANVAS}
                                                spare={360}
                                                grows={false}
                                                onBlocked={noteBlocked}
                                                openLabel={`Open ${sketch.label}`}
                                                onOpen={() => {
                                                    setOpened(index)
                                                }}
                                            />
                                            {/*
                                             * Under the sketch it belongs to, not beside its name. The
                                             * button that answers the question sits on the thing being
                                             * answered about.
                                             *
                                             * The chosen one is filled, not disabled. Disabling it made
                                             * the answer the user had just given read as the one thing
                                             * they were not allowed to pick — and it took away the only
                                             * way to change their mind back to it after picking another.
                                             */}
                                            <Button
                                                label={`Choose ${sketch.label}`}
                                                variant={picked === index ? 'primary' : 'secondary'}
                                                onClick={() => {
                                                    setPicked(index)
                                                }}
                                            >
                                                {picked === index ? 'Chosen' : 'Choose this one'}
                                            </Button>
                                        </VStack>
                                    ))}
                                </Grid>
                            )}
                            {refused.length > 0 && (
                                <Banner
                                    status='warning'
                                    title='Part of this sketch could not load'
                                    description={`Nothing outside Gofer is allowed to load here, so ${refused.join(', ')} never arrived. The agent is told, so it can inline them instead — judge the layout, not the missing pieces.`}
                                />
                            )}
                            <TextArea
                                label='Your answer'
                                rows={2}
                                value={draft}
                                hasAutoFocus={!isVisual}
                                onChange={setDraft}
                            />
                            <HStack
                                gap={2}
                                justify='end'
                            >
                                <Button
                                    label='Let the agent decide'
                                    variant='ghost'
                                    onClick={() => {
                                        onAnswer({
                                            questionId: prompt.questionId,
                                            blocked: refused,
                                            skipped: true
                                        })
                                    }}
                                />
                                <Button
                                    label={inDesign ? 'Send changes' : 'Answer'}
                                    variant={inDesign ? 'secondary' : 'primary'}
                                    isDisabled={!hasAnswer}
                                    onClick={() => {
                                        onAnswer({
                                            questionId: prompt.questionId,
                                            answer,
                                            ...(picked !== undefined && {picked}),
                                            blocked: refused
                                        })
                                    }}
                                />
                                {/*
                                 * The way out of a design loop, and the only one that ends it as
                                 * agreed rather than abandoned.
                                 *
                                 * Held shut until a sketch is chosen, because approving without one
                                 * hands the agent three layouts and the news that the user liked a
                                 * layout. It is the primary action: the loop exists to reach it.
                                 */}
                                {inDesign && (
                                    <Button
                                        label='Complete and handoff'
                                        variant='primary'
                                        isDisabled={picked === undefined}
                                        onClick={() => {
                                            onAnswer({
                                                questionId: prompt.questionId,
                                                answer,
                                                ...(picked !== undefined && {picked}),
                                                blocked: refused,
                                                approved: true
                                            })
                                        }}
                                    />
                                )}
                            </HStack>
                        </VStack>
                    </>
                    /*
                     * A zoom is a viewer, not a second copy of the question.
                     *
                     * The sketch, as large as the window allows, and one way out. Everything that
                     * answers the question is on the screen underneath, unchanged, and comes back when
                     * this closes — so there is never a second place to answer from.
                     */
                :   <VStack
                        gap={3}
                        padding={4}
                    >
                        <HStack
                            gap={2}
                            align='center'
                        >
                            <StackItem size='fill'>
                                <Text
                                    size='sm'
                                    weight='medium'
                                    maxLines={1}
                                >
                                    {zoomed.label}
                                </Text>
                            </StackItem>
                            <Button
                                label='Close'
                                variant='secondary'
                                size='sm'
                                onClick={() => {
                                    setOpened(undefined)
                                }}
                            />
                        </HStack>
                        <SketchFrame
                            html={zoomed.html}
                            canvasSize={SKETCH_CANVAS}
                            spare={160}
                            onBlocked={noteBlocked}
                        />
                    </VStack>

            }
        </Dialog>
    )
}

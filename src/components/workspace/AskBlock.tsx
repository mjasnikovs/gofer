import {useEffect, useMemo, useRef, useState} from 'react'
import {Badge} from '@astryxdesign/core/Badge'
import {Banner} from '@astryxdesign/core/Banner'
import {Button} from '@astryxdesign/core/Button'
import {Card} from '@astryxdesign/core/Card'
import {Collapsible} from '@astryxdesign/core/Collapsible'
import {Dialog} from '@astryxdesign/core/Dialog'
import {Grid} from '@astryxdesign/core/Grid'
import {Heading} from '@astryxdesign/core/Text'
import {Spinner} from '@astryxdesign/core/Spinner'
import {HStack, StackItem, VStack} from '@astryxdesign/core/Stack'
import {Text} from '@astryxdesign/core/Text'
import {TextArea} from '@astryxdesign/core/TextArea'
import {Token} from '@astryxdesign/core/Token'
import {useAskedQuestion, useUnownedQuestion} from '../../hooks/useUserQuestions'
import {useOpenCenterTab} from '../../hooks/useCenterTab'
import {SKETCH_CANVAS, holdsAgreedSketch} from '../../models/sketch'
import {describeBlocked, remoteReferences} from '../../services/sketch-regions'
import {SketchFrame} from './SketchFrame'
import type {ToolActivity} from '../../models/chat'
import type {UserQuestionPrompt, UserQuestionResponse} from '../../models/brief'

/**
 * A sketch shown on its own, as large as the window allows.
 *
 * A viewer, not a second copy of the question. Everything that answers is on the block underneath,
 * unchanged, and comes back when this closes — so there is never a second place to answer from. It
 * is a modal because that is what "as large as the window allows" means, and because the block it
 * covers is a few hundred pixels wide in a column beside two panels.
 */
function SketchZoom({
    sketch,
    onBlocked,
    onClose
}: Readonly<{
    sketch: Readonly<{label: string; html: string}>
    onBlocked: (uri: string) => void
    onClose: () => void
}>) {
    return (
        <Dialog
            isOpen
            purpose='form'
            width='96vw'
            maxHeight='94vh'
            onOpenChange={isOpen => {
                if (!isOpen) onClose()
            }}
        >
            <VStack
                gap={3}
                padding={4}
            >
                <HStack
                    gap={2}
                    align='center'
                >
                    <StackItem size='fill'>
                        <Text
                            type='supporting'
                            color='primary'
                            maxLines={1}
                        >
                            {sketch.label}
                        </Text>
                    </StackItem>
                    <Button
                        label='Close'
                        variant='secondary'
                        size='sm'
                        onClick={onClose}
                    />
                </HStack>
                <SketchFrame
                    html={sketch.html}
                    canvasSize={SKETCH_CANVAS}
                    spare={160}
                    onBlocked={onBlocked}
                />
            </VStack>
        </Dialog>
    )
}

/**
 * The mark on the answer the asker recommends.
 *
 * A border on the option itself rather than a badge beside it. Beside it was wrong twice over: a
 * tinted pill in a row of buttons is read as a third button, and a mark that sits next to a thing is
 * a mark you have to connect to it. This one is on the thing.
 *
 * The token is the one `SelectableCard variant='green'` draws with, which is what the recommendation
 * used to be before the options became buttons that send.
 */
/*
 * The one raised surface in the chat column, styled in `src/theme/chat.css`.
 *
 * A question is the only block in the transcript the user has to act on, so it is the only one that
 * gets a fill — and it needs to be clearly above the panel in both modes, which the default card
 * colour is not (3.7 L* in dark). The class rather than a `variant` because this block appears in
 * two places, inside a turn and beside the composer for a brief's questions, and it has to be the
 * same surface in both.
 */
const ASK_SURFACE = 'gofer-ask-surface'

const RECOMMENDED_STYLE = {borderColor: 'var(--color-border-green)'} as const

/** The recommendation is a border AND a word, because a colourless theme cannot carry a tint alone. */

/**
 * Columns that are the same width whatever is in them.
 *
 * `Grid columns={2}` lays out two `1fr` tracks, and a `1fr` track floors at its own content. In a
 * dialog there was slack for that; in a chat column there is none — the "Recommended" badge sits in
 * the first column only and measured that track 25 pixels wider than its neighbour. Two sketches
 * drawn at different sizes is the one thing a side-by-side comparison must not do, and the visual
 * suite measures both frames for exactly this.
 *
 * A `style` rather than a prop because Astryx offers no way to say `minmax(0, 1fr)`, and nothing in
 * it is a hardcoded measurement: it is a ratio and a count.
 */
function equalColumns(count: number) {
    return {gridTemplateColumns: `repeat(${String(count)}, minmax(0, 1fr))`}
}

/**
 * What the child is doing right now, one line, clamped rather than wrapped.
 *
 * The only thing on the block that moves between a delegation starting and its first sketch, which
 * can be a minute of reading. A shell command is arbitrarily long and this sits in a narrow column:
 * left to wrap, one `rg` invocation is four lines and the block below it moves every few seconds.
 * `maxLines` also gives the full text back on hover. The same shape `BriefProgress` uses.
 */
function StepLine({step}: Readonly<{step: string}>) {
    return (
        <Text
            type='supporting'
            maxLines={1}
        >
            {`↳ ${step}`}
        </Text>
    )
}

/**
 * The block while there is nothing to answer yet.
 *
 * Either the call has only just gone out, or a delegation is drafting. Both look the same from here
 * and both are the same fact: the agent is working and the user is not being asked anything. Without
 * it a design would be a blank stretch of feed for as long as a child takes to read the project.
 */
function Working({tool}: Readonly<{tool: ToolActivity}>) {
    return (
        <Card
            className={ASK_SURFACE}
            padding={4}
            elevation='low'
        >
            <VStack gap={2}>
                <HStack
                    gap={2}
                    align='center'
                >
                    <Spinner size='sm' />
                    <StackItem size='fill'>
                        <Heading
                            level={4}
                            maxLines={2}
                        >
                            {tool.target ?? 'Asking you something'}
                        </Heading>
                    </StackItem>
                </HStack>
                {tool.step && (
                    <VStack paddingInline={5}>
                        <StepLine step={tool.step} />
                    </VStack>
                )}
            </VStack>
        </Card>
    )
}

/**
 * The block once it has been answered, as one line that opens.
 *
 * Flat rather than raised: a question that is settled is part of the transcript, and a card still
 * floating off the feed goes on asking to be dealt with. This is also every answered block after a
 * reload, where the stored tool result is all there is — the sketches are not in the conversation,
 * they are in project storage, which is what the Design tab reads.
 */
function Answered({tool}: Readonly<{tool: ToolActivity}>) {
    const openTab = useOpenCenterTab()
    const failed = tool.status === 'error'
    const summary = tool.target ?? 'Asked you something'
    const agreed = holdsAgreedSketch(tool.output)
    return (
        <Collapsible
            defaultIsOpen={false}
            trigger={
                <HStack
                    gap={2}
                    align='center'
                >
                    {/*
                     * Token, not Badge. How the call ended is a state, and Badge here is for counts
                     * — the same rule the Design tab's chapter label already follows.
                     *
                     * First, not last. The summary is a whole sentence and the state is two words,
                     * so trailing the state put the one fixed thing in the row behind the one
                     * variable thing, where a long question pushed it off the edge. Leading it also
                     * stacks the states down the feed in one column, which is what a reader
                     * scanning for the red one is doing.
                     *
                     * Three states, and colour carries two of them: a call that never asked is red,
                     * a design the user agreed is green, and a plain answer stays neutral. That is
                     * the two-or-three meaningful colours Token asks for, not a palette.
                     */}
                    <Token
                        size='sm'
                        color={
                            failed ? 'red'
                            : agreed ?
                                'green'
                            :   'gray'
                        }
                        label={
                            failed ? 'not asked'
                            : agreed ?
                                'design agreed'
                            :   'answered'
                        }
                    />
                    {/*
                     * The sentence is the only part that has to give. Without the fill it sized off
                     * its own text and the row ran past the column, which put a horizontal
                     * scrollbar under the whole conversation.
                     */}
                    <StackItem size='fill'>
                        <Text
                            type='supporting'
                            maxLines={1}
                        >
                            {summary}
                        </Text>
                    </StackItem>
                </HStack>
            }
        >
            <VStack
                gap={2}
                padding={2}
            >
                {tool.output && (
                    <Text
                        type='supporting'
                        color='primary'
                    >
                        {tool.output}
                    </Text>
                )}
                {/*
                 * Where the layout went, rather than a copy of it.
                 *
                 * The agreed sketch is kept by the project, not by the conversation, so a block read
                 * back after a restart has the words and no picture. Pointing at where the picture
                 * is beats redrawing it from a transcript that never held it.
                 */}
                {agreed && openTab && (
                    <HStack justify='start'>
                        <Button
                            label='Open the Design tab'
                            variant='secondary'
                            size='sm'
                            onClick={() => {
                                openTab('sketches')
                            }}
                        />
                    </HStack>
                )}
            </VStack>
        </Collapsible>
    )
}

/**
 * Whether the caret is already somewhere the user is writing.
 *
 * Only the composer matters in practice, and it is not named here: any text box with focus is
 * somebody in the middle of typing into it, and taking the caret off one is the same rudeness
 * wherever it sits.
 */
function somebodyIsTyping() {
    const focused = document.activeElement
    if (!(focused instanceof HTMLElement)) return false
    return (
        focused instanceof HTMLTextAreaElement
        || focused instanceof HTMLInputElement
        || focused.isContentEditable
    )
}

type AskingProps = Readonly<{
    prompt: UserQuestionPrompt
    onAnswer: (response: UserQuestionResponse) => void
    /**
     * Whether anything on the other side would come back if it were asked to.
     *
     * True for every question a turn asks: `again` reaches the model as a sentence telling it to
     * ask this again. False for a task brief's grill questions, which do not go through the tool at
     * all — `scripts/brief/run.mjs` calls the host directly and reads the answer's words and
     * nothing else. The control was there and did nothing, which is worse than not offering it: the
     * user marks an answer as half-formed and the plan is written from it as final.
     */
    canAskAgain?: boolean
}>

/**
 * The question itself, with everything that answers it.
 *
 * Lifted out of the modal this used to be, unchanged in what it offers and changed in where it
 * lives. The modal closed on every answer and reopened once the agent had redrawn, so a user
 * watching a design iterate watched their own dialog flicker; here the same block is revised in
 * place because every round carries the same `ownerCallId`.
 *
 * The sketches are the suggested answers, drawn. So the written suggestions are not shown beside
 * them: two lists of the same options, one in words and one in pictures, is two answers to give for
 * one decision, and the first build shipped exactly that.
 *
 * Exactly one primary action. Inside a delegation it is **Done, build it**, because the loop exists
 * to reach it; outside one it is **Send**.
 */
function Asking({prompt, onAnswer, canAskAgain = true}: AskingProps) {
    const block = useRef<HTMLDivElement>(null)
    const [draft, setDraft] = useState('')
    const [picked, setPicked] = useState<number>()
    const [opened, setOpened] = useState<number>()
    const [blocked, setBlocked] = useState<readonly string[]>([])
    /*
     * Which asking this answer is being composed for. Compared during render rather than reset from
     * an effect, so an answer meant for one round can never reach the next: an effect would clear it
     * one render *after* the new sketches are already on screen with the old text in the box.
     *
     * Both halves of the identity, because the revision alone does not identify a question.
     * `next_revision` counts per question id, so two different questions are both revision one — and
     * two questions can share a block: a delegated child's questions all carry the parent's call id,
     * and `useAskedQuestion` hands over whichever is first in the queue. Answering one settles it
     * synchronously and the next takes its place with no render in between, so on the revision alone
     * the draft, the pick and the blocked list all survived into a question that never asked for
     * them, and one click sent the previous answer under the new identifier.
     */
    const [asking, setAsking] = useState({id: prompt.questionId, revision: prompt.revision})
    if (prompt.questionId !== asking.id || prompt.revision !== asking.revision) {
        setAsking({id: prompt.questionId, revision: prompt.revision})
        setDraft('')
        setPicked(undefined)
        setOpened(undefined)
        setBlocked([])
    }

    const answer = draft.trim()
    const sketches = prompt.sketches
    const isVisual = sketches.length > 0
    /*
     * Whether this block may take the caret, decided once, when it mounts.
     *
     * Right for the modal this used to be and wrong the moment it became a block in the feed. The
     * composer stays enabled while a turn streams, so a text-only question arriving mid-sentence
     * pulled the caret out from under the user and the rest of what they were typing landed in the
     * answer box. A question that arrives while nobody is typing still gets it.
     *
     * A `useState` initialiser rather than a render-time read, because that is autofocus's own
     * lifetime: it applies when the input mounts, and this block is revised in place rather than
     * remounted.
     */
    const [takesFocus] = useState(() => !isVisual && !somebodyIsTyping())
    /*
     * Both sources, unioned. The scan is what the markup asks for and is right immediately; the
     * listener is what the policy actually refused and catches whatever resolves later.
     *
     * Memoised because the scan runs five global regexes over each sketch's whole page. In the
     * render body it re-ran on every keystroke in the answer box, and once a second besides: an
     * unanswered question keeps a clock running that re-renders the timeline around it.
     */
    const refused = useMemo(
        () =>
            describeBlocked([
                ...sketches.flatMap(sketch => remoteReferences(sketch.html)),
                ...blocked
            ]),
        [blocked, sketches]
    )
    const zoomed = opened === undefined ? undefined : sketches[opened]
    const hasAnswer = answer.length > 0 || picked !== undefined
    // Approving without a pick hands the agent three layouts and the news that the user liked a
    // layout. A question with nothing drawn on it has nothing to pick, and ending the delegation
    // there is a decision of its own.
    const canApprove = !isVisual || picked !== undefined

    /*
     * A question the user has to answer has to be on screen.
     *
     * The feed's follow is a spring that trails the stream, and it settles before this block has
     * finished growing: the sketch frames measure their own column and set their height a moment
     * after the question arrives. Measured in the real window — the block was drawn below the fold
     * and nothing on screen said a question was waiting.
     *
     * `end` rather than `nearest`, and that is the whole of the fix. `nearest` stops as soon as any
     * part of the block is in view, which on a block taller than the column means its question is on
     * screen and its controls are not — measured in the real window, with the Send button below the
     * fold and nothing saying it was there. The actions are the reason to scroll at all.
     *
     * Keyed on the revision as well as the question, because a revision is a new thing to answer in
     * the same block.
     */
    useEffect(() => {
        block.current?.scrollIntoView({block: 'end', behavior: 'smooth'})
    }, [prompt.questionId, prompt.revision, prompt.sketches])

    // The asker puts the one it recommends first, and a single option is not a recommendation over
    // anything — it is the only answer offered.
    const isRecommended = (index: number) => index === 0 && prompt.options.length > 1

    const noteBlocked = (uri: string) => {
        setBlocked(previous => (previous.includes(uri) ? previous : [...previous, uri]))
    }
    const send = (extra: Readonly<{approved?: boolean; again?: boolean}> = {}) => {
        onAnswer({
            questionId: prompt.questionId,
            answer,
            ...(picked !== undefined && {picked}),
            blocked: refused,
            ...extra
        })
    }

    return (
        <>
            <Card
                ref={block}
                className={ASK_SURFACE}
                padding={4}
                elevation='low'
                maxWidth='100%'
            >
                <VStack gap={3}>
                    <VStack gap={1}>
                        <HStack
                            gap={2}
                            align='center'
                        >
                            <StackItem size='fill'>
                                <Heading level={4}>{prompt.question}</Heading>
                            </StackItem>
                            {prompt.revision > 1 && (
                                <Badge
                                    variant='neutral'
                                    label={`Round ${String(prompt.revision)}`}
                                />
                            )}
                        </HStack>
                        {prompt.why && <Text type='supporting'>{prompt.why}</Text>}
                    </VStack>
                    {/*
                     * An option is a whole answer, so it sends. Selecting it and then reaching for a
                     * second button asks the user to confirm a decision they have already made —
                     * and anything they wanted to add they can write instead of pressing this.
                     *
                     * The asker puts the one it recommends first, so the first button is the
                     * recommendation. It is not the primary action: the block already has one, and
                     * two primaries name neither.
                     */}
                    {prompt.options.length > 0 && !isVisual && (
                        <VStack gap={2}>
                            {prompt.options.map((option, index) => (
                                <HStack
                                    key={`${String(index)}-${option}`}
                                    gap={2}
                                    align='center'
                                >
                                    <StackItem size='fill'>
                                        {/*
                                         * Marked twice, on the answer itself, and both halves earn
                                         * their place.
                                         *
                                         * The border says which one at a glance. The badge says
                                         * what the border means — this theme is deliberately close
                                         * to colourless, so a tint alone is a distinction some
                                         * screens and some readers will not see. `endContent` puts
                                         * the badge inside the button rather than beside it: a mark
                                         * sitting next to a thing is a mark you have to connect to
                                         * it, and a pill in a row of buttons is read as a button.
                                         *
                                         * The word rides the accessible name as well, because the
                                         * name comes from `label` and nothing inside the button is
                                         * announced with it.
                                         */}
                                        <Button
                                            label={
                                                isRecommended(index) ?
                                                    `${option} (recommended)`
                                                :   option
                                            }
                                            variant='secondary'
                                            width='100%'
                                            {...(isRecommended(index) && {
                                                style: RECOMMENDED_STYLE,
                                                /*
                                                 * The same component as the sketch layout's mark,
                                                 * so one recommendation has one appearance. A Badge
                                                 * here was neutral-coloured to match but still drew
                                                 * a 20px pill against the other's square chip —
                                                 * `endContent` takes any node, so it takes this.
                                                 */
                                                endContent: (
                                                    <Token
                                                        size='sm'
                                                        label='Recommended'
                                                    />
                                                )
                                            })}
                                            onClick={() => {
                                                onAnswer({
                                                    questionId: prompt.questionId,
                                                    answer: option,
                                                    blocked: refused
                                                })
                                            }}
                                        >
                                            {option}
                                        </Button>
                                    </StackItem>
                                </HStack>
                            ))}
                        </VStack>
                    )}
                    {isVisual && (
                        <Grid
                            columns={sketches.length}
                            gap={3}
                            align='start'
                            style={equalColumns(sketches.length)}
                        >
                            {/*
                             * Keyed by position, not by label. The labels come from the model and
                             * nothing dedupes them, so two variants it names the same thing gave
                             * React one key for two siblings — and the "Chosen" mark reconciled
                             * onto the wrong column of the one view whose whole job is comparing
                             * them side by side. The list is replaced whole on every revision, so
                             * position is the stable identity here.
                             */}
                            {sketches.map((sketch, index) => (
                                <VStack
                                    key={`${String(index)}-${sketch.label}`}
                                    gap={2}
                                >
                                    {/*
                                     * One line, at a height a badge cannot change. A row that grows
                                     * for the badge on one column puts that column's sketch lower
                                     * than its neighbour's, which is the one thing a side-by-side
                                     * comparison has to get right.
                                     */}
                                    <HStack
                                        gap={2}
                                        align='center'
                                        height='var(--spacing-7)'
                                    >
                                        {/*
                                         * The label is the only thing in a column whose width comes
                                         * from its own text, and a grid track floors at its content.
                                         * In the dialog this used to live in there was slack for
                                         * that; in a chat column there is none, and "Centered
                                         * Overlay" measured 24px wider a track than "Side Panel" —
                                         * two sketches that cannot be compared because they are not
                                         * the same size. Filling frees the track from the word.
                                         */}
                                        <StackItem size='fill'>
                                            <Text
                                                type='supporting'
                                                color='primary'
                                                maxLines={1}
                                            >
                                                {sketch.label}
                                            </Text>
                                        </StackItem>
                                        {/* The same mark the option layout draws. */}
                                        {index === 0 && sketches.length > 1 && (
                                            <Token
                                                size='sm'
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
                                     * Under the sketch it belongs to. The chosen one is filled, not
                                     * disabled: disabling it made the answer the user had just given
                                     * read as the one thing they were not allowed to pick, and took
                                     * away the only way to change their mind back to it.
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
                        hasAutoFocus={takesFocus}
                        onChange={setDraft}
                    />
                    {/*
                     * Wrapped, because three controls do not fit a chat column on one line.
                     *
                     * Measured in the real window: "Let the agent decide", "Send changes" and
                     * "Done, build it" side by side are wider than the column, and a flex row sizes
                     * itself from its content — so the whole block ran off the right edge and the
                     * primary action was the half that was cut. In the dialog this used to live in
                     * there were 96 viewport widths to play with. There are none here.
                     */}
                    <HStack
                        gap={2}
                        justify='end'
                        wrap='wrap'
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
                        {/*
                         * Another round, asked for rather than hoped for.
                         *
                         * A delegated question has had this since the first build, as "Send
                         * changes": there is a child looping behind it and the loop goes round
                         * again. An ordinary question had nothing — the model read the answer and
                         * decided for itself whether to come back, and the user could only hope.
                         *
                         * That was the old two-tool split surviving as a control: a layout could be
                         * iterated and a question could not. Where the line between one round and
                         * three falls is the user's to draw, which is the whole reason the two
                         * tools became one.
                         */}
                        {canAskAgain && (
                            <Button
                                label={prompt.isDelegated ? 'Send changes' : 'Ask me again'}
                                variant='secondary'
                                isDisabled={!hasAnswer}
                                tooltip={
                                    prompt.isDelegated ?
                                        'Send this back and see the next version'
                                    :   'Send this and come back to me about the same thing'
                                }
                                onClick={() => {
                                    send({again: true})
                                }}
                            />
                        )}
                        {/*
                         * And the ending. On an ordinary question that is simply the answer: the
                         * turn carries on and nothing is waiting on the user any more.
                         */}
                        {!prompt.isDelegated && (
                            <Button
                                label='Send'
                                variant='primary'
                                isDisabled={!hasAnswer}
                                onClick={() => {
                                    send()
                                }}
                            />
                        )}
                        {/*
                         * The way out of a delegation, and the only ending that means agreed rather
                         * than abandoned. It also closes the child's loop, so it is the one control
                         * on this block that stops the agent as well as answering it.
                         */}
                        {prompt.isDelegated && (
                            <Button
                                label='Done, build it'
                                variant='primary'
                                isDisabled={!canApprove}
                                onClick={() => {
                                    send({approved: true})
                                }}
                            />
                        )}
                    </HStack>
                </VStack>
            </Card>
            {zoomed && (
                <SketchZoom
                    sketch={zoomed}
                    onBlocked={noteBlocked}
                    onClose={() => {
                        setOpened(undefined)
                    }}
                />
            )}
        </>
    )
}

/**
 * One `ask_user` call, drawn where the turn made it.
 *
 * It replaces the modal this used to be, and the reason is the design loop. A delegation asks about
 * one layout several times: draft, reaction, revision, reaction. As a dialog, every one of those
 * closed the moment the user answered and reopened a minute later once the agent had redrawn — so
 * the user watched their own modal flicker instead of watching one design change, and a second tool
 * existed only to paper over it. In the feed the block is the tool call, and a revision is the same
 * block with new content: nothing opens, nothing closes.
 *
 * The link is `ownerCallId`, put on the request by the tool rather than by the model. A delegated
 * child's questions carry the PARENT's call id, which is exactly what makes several rounds land
 * here rather than in three unrelated places.
 *
 * Three states and nothing between them. Working while the agent has nothing to ask yet, asking
 * while a question is waiting, and answered once it is not. A stopped turn settles the question on
 * the Rust side, so story seven needs no state of its own: the question leaves the queue, the call
 * ends, and the block draws its finished self.
 */
/**
 * The question that names no tool call, drawn where there is no conversation to draw it in.
 *
 * A task brief asks its grill questions before the first turn exists, so there is no `ask_user`
 * block for `AskBlock` to be. Mounted beside the composer, this is the one place a question with no
 * owner can still be seen and answered — without it the brief blocked for its full thirty-minute
 * timeout with nothing on screen.
 *
 * Draws nothing at all when there is no such question, which is almost always.
 */
export function UnownedAsk() {
    const {prompt, answer} = useUnownedQuestion()
    if (!prompt || !answer) return null
    return (
        <Asking
            prompt={prompt}
            onAnswer={answer}
            // Nothing here is a tool call, so nothing here can be asked again: the brief reads the
            // words and moves on to its next question. See `canAskAgain`.
            canAskAgain={false}
        />
    )
}

export function AskBlock({tool}: Readonly<{tool: ToolActivity}>) {
    const {prompt, answer} = useAskedQuestion(tool.id)
    if (prompt && answer) {
        return (
            <Asking
                prompt={prompt}
                onAnswer={answer}
            />
        )
    }
    if (tool.status === 'pending' || tool.status === 'running') return <Working tool={tool} />
    return <Answered tool={tool} />
}

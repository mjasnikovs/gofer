import {use, useEffect, useMemo, useRef, useState} from 'react'
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
import {Token} from '@astryxdesign/core/Token'
import type {ChatComposerInputHandle} from '@astryxdesign/core/Chat'
import {TextField} from '../TextField'
import {AttachmentPicker, AttachmentThumbnails, GameCapturePicker} from './AttachmentControls'
import {clipboardItemImages, imageFiles} from '../../utils/chat-images'
import {useAppendTarget} from '../../hooks/useAppendTarget'
import {useAttachmentPool} from '../../hooks/useAttachmentPool'
import {useFileMentionTrigger} from '../../hooks/useFileMentionTrigger'
import {ComposerContext} from '../../hooks/useComposer'
import {isTauri} from '../../services/desktop'
import {useAskedQuestion, useUnownedQuestion} from '../../hooks/useUserQuestions'
import {useOpenCenterTab} from '../../hooks/useCenterTab'
import {SKETCH_CANVAS, holdsAgreedSketch} from '../../models/sketch'
import {describeBlocked, remoteReferences} from '../../services/sketch-regions'
import {SketchFrame} from './SketchFrame'
import type {ToolActivity} from '../../models/chat'
import type {UserQuestionPrompt, UserQuestionResponse} from '../../models/brief'

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

const ASK_SURFACE = 'gofer-ask-surface'

const ASK_OPTION = 'gofer-ask-option'

const RECOMMENDED_STYLE = {borderColor: 'var(--color-border-green)'} as const

function equalColumns(count: number) {
    return {gridTemplateColumns: `repeat(${String(count)}, minmax(0, 1fr))`}
}

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
    canAskAgain?: boolean
}>

function Asking({prompt, onAnswer, canAskAgain = true}: AskingProps) {
    const block = useRef<HTMLDivElement>(null)
    const answerInput = useRef<ChatComposerInputHandle>(null)
    const fileMentions = useFileMentionTrigger()
    const keepRoot = useAppendTarget(answerInput)
    const [attachError, setAttachError] = useState<string>()
    const pictures = useAttachmentPool(setAttachError)
    const supportsImages = use(ComposerContext)?.meta.supportsImages ?? false
    const canAttach = supportsImages && isTauri()
    const [draft, setDraft] = useState('')
    const [picked, setPicked] = useState<number>()
    const [opened, setOpened] = useState<number>()
    const [blocked, setBlocked] = useState<readonly string[]>([])
    const [asking, setAsking] = useState({id: prompt.questionId, revision: prompt.revision})
    if (prompt.questionId !== asking.id || prompt.revision !== asking.revision) {
        setAsking({id: prompt.questionId, revision: prompt.revision})
        setDraft('')
        setPicked(undefined)
        setOpened(undefined)
        setBlocked([])
        pictures.clear()
        setAttachError(undefined)
    }

    const answer = draft.trim()
    const sketches = prompt.sketches
    const isVisual = sketches.length > 0
    const [takesFocus] = useState(() => !isVisual && !somebodyIsTyping())
    const refused = useMemo(
        () =>
            describeBlocked([
                ...sketches.flatMap(sketch => remoteReferences(sketch.html)),
                ...blocked
            ]),
        [blocked, sketches]
    )
    const zoomed = opened === undefined ? undefined : sketches[opened]
    const hasAnswer = answer.length > 0 || picked !== undefined || pictures.attachments.length > 0
    const canApprove = !isVisual || picked !== undefined

    useEffect(() => {
        block.current?.scrollIntoView({block: 'end', behavior: 'smooth'})
    }, [prompt.questionId, prompt.revision, prompt.sketches])

    useEffect(() => {
        if (takesFocus) answerInput.current?.focus()
    }, [takesFocus])

    const isRecommended = (index: number) => index === 0 && prompt.options.length > 1

    const noteBlocked = (uri: string) => {
        setBlocked(previous => (previous.includes(uri) ? previous : [...previous, uri]))
    }
    const send = (
        extra: Readonly<{approved?: boolean; again?: boolean; stopAsking?: boolean}> = {}
    ) => {
        onAnswer({
            questionId: prompt.questionId,
            answer,
            ...(pictures.attachments.length > 0 && {
                images: pictures.attachments.map(attachment => ({
                    name: attachment.name,
                    mimeType: attachment.mimeType,
                    data: attachment.data
                }))
            }),
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
                    {prompt.options.length > 0 && !isVisual && (
                        <VStack gap={2}>
                            {prompt.options.map((option, index) => (
                                <Button
                                    key={`${String(index)}-${option}`}
                                    className={ASK_OPTION}
                                    label={
                                        isRecommended(index) ? `${option} (recommended)` : option
                                    }
                                    variant='secondary'
                                    width='100%'
                                    {...(isRecommended(index) && {style: RECOMMENDED_STYLE})}
                                    onClick={() => {
                                        onAnswer({
                                            questionId: prompt.questionId,
                                            answer: option,
                                            blocked: refused
                                        })
                                    }}
                                >
                                    <HStack
                                        gap={2}
                                        align='center'
                                    >
                                        <StackItem size='fill'>{option}</StackItem>
                                        {isRecommended(index) && (
                                            <Token
                                                size='sm'
                                                label='Recommended'
                                            />
                                        )}
                                    </HStack>
                                </Button>
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
                            {sketches.map((sketch, index) => (
                                <VStack
                                    key={`${String(index)}-${sketch.label}`}
                                    gap={2}
                                >
                                    <HStack
                                        gap={2}
                                        align='center'
                                        height='var(--spacing-7)'
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
                    <VStack gap={1}>
                        <HStack
                            gap={2}
                            align='center'
                        >
                            <StackItem size='fill'>
                                <Text type='supporting'>Your answer</Text>
                            </StackItem>
                            <AttachmentPicker
                                canAttach={canAttach}
                                supportsImages={supportsImages}
                                onSelect={files => {
                                    void pictures.select(files)
                                }}
                            />
                            <GameCapturePicker
                                canAttach={canAttach}
                                supportsImages={supportsImages}
                                onSelect={files => {
                                    void pictures.select(files)
                                }}
                                onError={setAttachError}
                            />
                        </HStack>
                        <TextField
                            kind='rich'
                            label='Your answer'
                            value={draft}
                            maxRows={6}
                            handleRef={answerInput}
                            rootRef={keepRoot}
                            triggers={[fileMentions.trigger]}
                            canSubmit={hasAnswer}
                            onKeyDown={fileMentions.onKeyDown}
                            onSubmit={() => {
                                send(prompt.isDelegated ? {again: true} : {})
                            }}
                            onChange={setDraft}
                            onFiles={files => {
                                const images = imageFiles(files)
                                if (!canAttach || images.length === 0) return
                                void pictures.select(images)
                            }}
                            onPaste={(event, text) => {
                                if (!canAttach) return undefined
                                const images = clipboardItemImages(event.clipboardData)
                                if (images.length > 0) {
                                    void pictures.select(images)
                                    return true
                                }
                                if (text !== '') return undefined
                                void pictures.attachClipboardImage()
                                return true
                            }}
                        />
                        {pictures.attachments.length > 0 && (
                            <AttachmentThumbnails
                                attachments={pictures.attachments}
                                isDisabled={false}
                                onEdit={pictures.edit}
                                onRemove={pictures.remove}
                            />
                        )}
                        {attachError !== undefined && (
                            <Banner
                                status='error'
                                title='That image could not be attached'
                                description={attachError}
                                isDismissable
                                onDismiss={() => {
                                    setAttachError(undefined)
                                }}
                            />
                        )}
                    </VStack>
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
                        {prompt.canStopAsking && (
                            <Button
                                label='Stop asking, continue'
                                variant='ghost'
                                tooltip='Settles the rest without you and gets on with the work'
                                onClick={() => {
                                    send({stopAsking: true})
                                }}
                            />
                        )}
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

export function UnownedAsk() {
    const {prompt, answer} = useUnownedQuestion()
    if (!prompt || !answer) return null
    return (
        <Asking
            prompt={prompt}
            onAnswer={answer}
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

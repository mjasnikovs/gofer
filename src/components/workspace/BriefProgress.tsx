import {Button} from '@astryxdesign/core/Button'
import {Card} from '@astryxdesign/core/Card'
import {Heading} from '@astryxdesign/core/Text'
import {Spinner} from '@astryxdesign/core/Spinner'
import {HStack, VStack} from '@astryxdesign/core/Stack'
import {StatusDot} from '@astryxdesign/core/StatusDot'
import {Text} from '@astryxdesign/core/Text'
import {
    BRIEF_PHASES,
    BRIEF_PHASE_LABELS,
    RESEARCH_SECTIONS,
    WORKER_OUTCOME_LABELS
} from '../../models/brief'
import type {BriefState} from '../../models/brief'

/** What each research worker is for, in the terms of what it is reading rather than its name. */
const WORKER_LABELS: Readonly<Record<string, string>> = {
    FILES: 'Which files this touches',
    APIS: 'Signatures and node types',
    CONTEXT: 'How this project works',
    TOOLING: 'How to check the work'
}

/**
 * What a brief is doing, while it does it.
 *
 * It exists because of how long this takes. Four phases and seven bounded delegations against a
 * reasoning model is minutes before the chat has anything in it, and for all of that time a healthy
 * run and a hung one look exactly the same from outside. So the panel's job is not decoration — it
 * is the only thing separating "working" from "stuck".
 *
 * The research workers are named rather than counted, and each says how it ended. "Four of four"
 * reports that a phase finished; it does not report that the APIS worker found nothing, or that one
 * was cut short and its section is partial — and those are the two things that explain a thin
 * specification afterwards, at the point where the user can still do something about it.
 *
 * They are listed in the order they run, which is one at a time. Nothing here is concurrent: the
 * workers share one model connection and the list says so by only ever having one spinner in it.
 */
/** Tokens, as a number a person reads rather than one they count digits in. */
function thousands(tokens: number): string {
    return tokens < 1000 ? String(tokens) : `${(tokens / 1000).toFixed(1)}K`
}

/**
 * What the worker in flight is doing at this moment.
 *
 * The only thing on this panel that moves between one worker starting and the same worker finishing,
 * which can be minutes. Everything above it says which of seven bounded delegations is running; this
 * says the run is alive.
 */
function StepLine({step}: Readonly<{step: string}>) {
    // One line, clamped rather than wrapped. A shell command is arbitrarily long and this sits in a
    // narrow column: left to wrap, one `rg` invocation is four lines and the phase list below it
    // moves every few seconds. `maxLines` also gives the full text back on hover.
    return (
        <Text
            type='supporting'
            maxLines={1}
        >
            {`↳ ${step}`}
        </Text>
    )
}

export function BriefProgress({
    state,
    onCancel,
    onStartWithoutPlan
}: Readonly<{state: BriefState; onCancel?: () => void; onStartWithoutPlan?: () => void}>) {
    const current = state.phase
    const reached = current ? BRIEF_PHASES.indexOf(current) : -1
    const answered = new Map(state.research.map(worker => [worker.section, worker.kind]))
    return (
        <Card
            padding={4}
            elevation='low'
        >
            <VStack gap={3}>
                <VStack gap={1}>
                    <Heading level={4}>Planning this task</Heading>
                    <Text type='supporting'>
                        This runs before the first message. It can take a few minutes.
                    </Text>
                </VStack>
                <VStack gap={2}>
                    {BRIEF_PHASES.map((phase, index) => {
                        // Behind the phase the run is on, which is the only thing that makes a
                        // phase done. There is no "everything is done because nothing has started"
                        // case: before the first phase every row is still ahead of the run.
                        const isDone = index < reached
                        const isRunning = phase === current && state.isRunning
                        return (
                            <VStack
                                key={phase}
                                gap={2}
                            >
                                <HStack
                                    gap={2}
                                    align='center'
                                >
                                    {isRunning ?
                                        <Spinner size='sm' />
                                    :   <StatusDot
                                            variant={isDone ? 'success' : 'neutral'}
                                            label={isDone ? 'done' : 'not started'}
                                        />
                                    }
                                    <Text
                                        type='supporting'
                                        color={isRunning || isDone ? 'primary' : 'secondary'}
                                    >
                                        {BRIEF_PHASE_LABELS[phase]}
                                    </Text>
                                    {phase === 'research' && (isRunning || isDone) && (
                                        <Text type='supporting'>
                                            {`${String(state.research.length)}/${String(RESEARCH_SECTIONS.length)}`}
                                        </Text>
                                    )}
                                </HStack>
                                {/*
                                 * The other three phases are one row each with one delegation behind
                                 * them, so their live line goes here. Research has four rows of its
                                 * own below and puts the line under whichever is running.
                                 */}
                                {isRunning && phase !== 'research' && state.step && (
                                    <VStack paddingInline={5}>
                                        <StepLine step={state.step} />
                                    </VStack>
                                )}
                                {phase === 'research' && (isRunning || isDone) && (
                                    <VStack
                                        gap={1}
                                        paddingInline={5}
                                    >
                                        {RESEARCH_SECTIONS.map(section => {
                                            const kind = answered.get(section)
                                            const isReading = state.running === section
                                            const note = kind && WORKER_OUTCOME_LABELS[kind]
                                            return (
                                                <VStack
                                                    key={section}
                                                    gap={1}
                                                >
                                                    <HStack
                                                        gap={2}
                                                        align='center'
                                                    >
                                                        {isReading ?
                                                            <Spinner size='sm' />
                                                        :   <StatusDot
                                                                variant={
                                                                    kind === undefined ? 'neutral'
                                                                    : kind === 'runaway' ?
                                                                        'warning'
                                                                    :   'success'
                                                                }
                                                                label={kind ?? 'waiting'}
                                                            />
                                                        }
                                                        <Text
                                                            type='supporting'
                                                            color={
                                                                kind || isReading ? 'primary' : (
                                                                    'secondary'
                                                                )
                                                            }
                                                        >
                                                            {WORKER_LABELS[section] ?? section}
                                                        </Text>
                                                        {note && (
                                                            <Text type='supporting'>{note}</Text>
                                                        )}
                                                    </HStack>
                                                    {isReading && state.step && (
                                                        <VStack paddingInline={5}>
                                                            <StepLine step={state.step} />
                                                        </VStack>
                                                    )}
                                                </VStack>
                                            )
                                        })}
                                    </VStack>
                                )}
                            </VStack>
                        )
                    })}
                </VStack>
                {state.cost && (
                    <Text type='supporting'>
                        {`Planning cost ${thousands(state.cost.input + state.cost.output)} tokens`}
                    </Text>
                )}
                {/*
                 * "Cancel", not "Stop", because nothing survives it. A brief cannot be resumed:
                 * a second run rewrites the stored row from its first phase and is handed only the
                 * raw ask, and no control on screen starts one anyway. "Stop" would promise a
                 * pause over minutes of work that is actually thrown away.
                 *
                 * It lives here because the composer is gone. Stopping a brief was the composer's
                 * Stop button, and this panel now stands where the composer stood.
                 *
                 * `secondary`: the screen's job is to be waited on, and leaving is not the press it
                 * should invite.
                 */}
                {state.isRunning && onCancel && (
                    <HStack justify='end'>
                        <Button
                            label='Cancel planning'
                            variant='secondary'
                            size='sm'
                            tooltip='Ends the plan. The phases it has finished are not kept.'
                            onClick={onCancel}
                        />
                    </HStack>
                )}
                {state.ended && (
                    <VStack gap={2}>
                        <Text type='supporting'>
                            {state.ended.kind === 'stopped' ?
                                'Stopped. What it had finished is kept.'
                            :   `It could not finish: ${state.ended.reason ?? 'no reason was reported'}`
                            }
                        </Text>
                        {/*
                         * The way out. A plan that ended without a specification leaves a task that
                         * exists, is named, and has an empty chat — and the dialog that took the ask
                         * is long gone, so the only other thing to do with it is delete it and type
                         * the same sentence again.
                         */}
                        {onStartWithoutPlan && (
                            <HStack justify='end'>
                                <Button
                                    label='Start without a plan'
                                    variant='primary'
                                    onClick={onStartWithoutPlan}
                                />
                            </HStack>
                        )}
                    </VStack>
                )}
            </VStack>
        </Card>
    )
}

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

const WORKER_LABELS: Readonly<Record<string, string>> = {
    FILES: 'Which files this touches',
    APIS: 'Signatures and node types',
    CONTEXT: 'How this project works',
    TOOLING: 'How to check the work'
}

function thousands(tokens: number): string {
    return tokens < 1000 ? String(tokens) : `${(tokens / 1000).toFixed(1)}K`
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
                                    {phase === 'grill' && state.questions > 0 && (
                                        <Text type='supporting'>
                                            {`${String(state.questions)} settled`}
                                        </Text>
                                    )}
                                </HStack>
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
                {state.isRunning && onCancel && (
                    <HStack justify='end'>
                        <Button
                            label='Cancel planning'
                            variant='secondary'
                            size='sm'
                            tooltip='Ends the plan. The phases it has already finished are kept.'
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

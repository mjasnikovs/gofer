import {ClickableCard} from '@astryxdesign/core/ClickableCard'
import {Icon} from '@astryxdesign/core/Icon'
import {HStack, StackItem, VStack} from '@astryxdesign/core/Stack'
import {StatusDot} from '@astryxdesign/core/StatusDot'
import type {StatusDotVariant} from '@astryxdesign/core/StatusDot'
import {Text} from '@astryxdesign/core/Text'
import ChatBubbleLeftIcon from '@heroicons/react/24/outline/ChatBubbleLeftIcon'
import ChatBubbleLeftRightIcon from '@heroicons/react/24/outline/ChatBubbleLeftRightIcon'
import {CARD_STATUSES, CARD_STATUS_LABELS, laneCards} from '../../models/board'
import type {Card, CardStatus} from '../../models/board'
import type {AutopilotPhase} from '../../services/board-autopilot'
import {useNow} from '../../hooks/useNow'
import {useStackedLanes} from '../../hooks/useStackedLanes'
import {relativeTime} from '../../utils/relative-time'

/** The card auto mode is on, and what it is doing with it. */
export type AutoMark = Readonly<{cardId: string; phase: AutopilotPhase}>

type BoardProps = Readonly<{
    cards: readonly Card[]
    auto: AutoMark | undefined
    onOpen: (id: string) => void
}>

const LANE_DOT: Readonly<Record<CardStatus, StatusDotVariant>> = {
    backlog: 'neutral',
    ready: 'neutral',
    doing: 'accent',
    review: 'warning',
    // The theme's accent is green too; a settled lane stays grey so Doing is the only green.
    done: 'neutral'
}

const EMPTY_LANE: Readonly<Record<CardStatus, string>> = {
    backlog: 'Nothing asked yet',
    ready: 'Nothing ready to start',
    doing: 'Nothing in progress',
    review: 'Nothing to review',
    done: 'Nothing finished yet'
}

// Never the word "Auto": the live suite finds the switch by that exact text.
const AUTO_PHASE: Readonly<Record<AutopilotPhase, string>> = {
    off: '',
    picking: 'Picking',
    opening: 'Opening',
    running: 'Running',
    merging: 'Merging',
    resolving: 'Resolving conflicts'
}

export function Board({cards, auto, onOpen}: BoardProps) {
    const [isStacked, board, lanes] = useStackedLanes()
    // Here and not in BoardView: the minute's tick must not redraw an open card dialog.
    const now = useNow()
    const lane = (status: CardStatus) => (
        <Lane
            key={status}
            status={status}
            cards={laneCards(cards, status)}
            auto={auto}
            now={now}
            isStacked={isStacked}
            onOpen={onOpen}
        />
    )

    return (
        <VStack
            ref={board}
            height='100%'
        >
            {isStacked ?
                <VStack
                    gap={5}
                    padding={3}
                    height='100%'
                    isScrollable
                >
                    {CARD_STATUSES.map(lane)}
                </VStack>
            :   <HStack
                    ref={lanes}
                    gap={3}
                    padding={3}
                    height='100%'
                >
                    {CARD_STATUSES.map(status => (
                        <StackItem
                            key={status}
                            className='gofer-board-lane'
                        >
                            {lane(status)}
                        </StackItem>
                    ))}
                </HStack>
            }
        </VStack>
    )
}

type LaneProps = Readonly<{
    status: CardStatus
    cards: readonly Card[]
    auto: AutoMark | undefined
    now: number
    isStacked: boolean
    onOpen: (id: string) => void
}>

function Lane({status, cards, auto, now, isStacked, onOpen}: LaneProps) {
    const label = CARD_STATUS_LABELS[status]
    const list = (
        <VStack
            gap={2}
            padding={1}
        >
            {cards.length === 0 && (
                <Text
                    type='supporting'
                    color='secondary'
                >
                    {EMPTY_LANE[status]}
                </Text>
            )}
            {cards.map(card => (
                <BoardCard
                    key={card.id}
                    card={card}
                    auto={auto?.cardId === card.id ? auto.phase : undefined}
                    now={now}
                    onOpen={onOpen}
                />
            ))}
        </VStack>
    )

    return (
        <VStack
            as='section'
            aria-label={label}
            gap={1}
            {...(!isStacked && {height: '100%'})}
        >
            <HStack
                gap={2}
                paddingInline={1}
                align='center'
            >
                <StatusDot
                    variant={LANE_DOT[status]}
                    label={`${label} column`}
                />
                <Text type='label'>{label}</Text>
                <Text
                    type='supporting'
                    color='secondary'
                    hasTabularNumbers
                >
                    {cards.length}
                </Text>
            </HStack>
            {isStacked ?
                list
            :   <StackItem
                    size='fill'
                    isScrollable
                >
                    {list}
                </StackItem>
            }
        </VStack>
    )
}

type BoardCardProps = Readonly<{
    card: Card
    auto: AutopilotPhase | undefined
    now: number
    onOpen: (id: string) => void
}>

function BoardCard({card, auto, now, onOpen}: BoardCardProps) {
    const comments = `${String(card.commentCount)} comment${card.commentCount === 1 ? '' : 's'}`
    const isPosted = card.taskId !== null && (card.status === 'backlog' || card.status === 'ready')

    return (
        <ClickableCard
            label={card.title}
            padding={3}
            elevation='low'
            onClick={() => {
                onOpen(card.id)
            }}
        >
            <VStack gap={1}>
                <HStack
                    gap={2}
                    align='center'
                >
                    <Text
                        type='supporting'
                        color='secondary'
                        hasTabularNumbers
                    >
                        {`#${String(card.number)}`}
                    </Text>
                    {auto !== undefined && (
                        <HStack
                            gap={1}
                            align='center'
                        >
                            <StatusDot
                                variant='accent'
                                label='Auto is on this card'
                                isPulsing
                            />
                            <Text type='supporting'>{AUTO_PHASE[auto]}</Text>
                        </HStack>
                    )}
                    <StackItem size='fill'>{null}</StackItem>
                    {isPosted && (
                        <HStack
                            gap={1}
                            align='center'
                        >
                            <Icon
                                icon={ChatBubbleLeftRightIcon}
                                size='sm'
                                color='secondary'
                            />
                            <Text
                                type='supporting'
                                color='secondary'
                            >
                                Posted
                            </Text>
                        </HStack>
                    )}
                    {card.commentCount > 0 && (
                        <HStack
                            gap={1}
                            align='center'
                        >
                            <Icon
                                icon={ChatBubbleLeftIcon}
                                size='sm'
                                color='secondary'
                                label={comments}
                            />
                            <Text
                                type='supporting'
                                color='secondary'
                                hasTabularNumbers
                                aria-hidden
                            >
                                {card.commentCount}
                            </Text>
                        </HStack>
                    )}
                </HStack>
                <Text maxLines={3}>{card.title}</Text>
                {card.body.trim() !== '' && (
                    <Text
                        type='supporting'
                        color='secondary'
                        maxLines={2}
                        hasTruncateTooltip={false}
                    >
                        {card.body}
                    </Text>
                )}
                <Text
                    type='supporting'
                    color='secondary'
                >
                    {`${card.owner} · ${relativeTime(card.updatedAt, now)}`}
                </Text>
            </VStack>
        </ClickableCard>
    )
}

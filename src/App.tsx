import {useRef, useState} from 'react'
import {AppShell} from '@astryxdesign/core/AppShell'
import {
    ChatComposer,
    ChatMessage,
    ChatMessageBubble,
    ChatMessageList
} from '@astryxdesign/core/Chat'
import {ClickableCard} from '@astryxdesign/core/ClickableCard'
import {Grid} from '@astryxdesign/core/Grid'
import {Icon} from '@astryxdesign/core/Icon'
import {Layout, LayoutContent, LayoutFooter} from '@astryxdesign/core/Layout'
import {NavIcon} from '@astryxdesign/core/NavIcon'
import {SideNav, SideNavHeading, SideNavItem, SideNavSection} from '@astryxdesign/core/SideNav'
import {HStack, VStack} from '@astryxdesign/core/Stack'
import {StatusDot} from '@astryxdesign/core/StatusDot'
import {Heading, Text} from '@astryxdesign/core/Text'
import {
    BoltIcon,
    ChatBubbleLeftRightIcon,
    CodeBracketSquareIcon,
    Cog6ToothIcon,
    CubeTransparentIcon,
    FolderOpenIcon,
    PlusIcon,
    SparklesIcon
} from '@heroicons/react/24/outline'

type Message = Readonly<{
    id: number
    sender: 'user' | 'assistant'
    text: string
}>

const SUGGESTIONS = [
    {
        title: 'Build a player controller',
        description: 'Create the scene, script movement, and wire input actions.',
        prompt: 'Build a responsive third-person player controller.'
    },
    {
        title: 'Debug the current scene',
        description: 'Inspect nodes, errors, signals, and runtime behavior.',
        prompt: 'Inspect the current scene and help me debug it.'
    },
    {
        title: 'Polish the environment',
        description: 'Improve lighting, materials, composition, and atmosphere.',
        prompt: 'Polish the current environment and explain each change.'
    },
    {
        title: 'Design an interaction',
        description: 'Plan and implement an object the player can use.',
        prompt: 'Design and implement an interactive object for this scene.'
    }
] as const

function Welcome({onSuggestion}: {onSuggestion: (prompt: string) => void}) {
    return (
        <VStack
            gap={8}
            paddingBlock={10}
            hAlign='stretch'
        >
            <VStack
                gap={2}
                hAlign='center'
            >
                <Icon
                    icon={SparklesIcon}
                    size='lg'
                    color='accent'
                />
                <Heading
                    level={1}
                    type='display-2'
                >
                    What should we make?
                </Heading>
                <Text color='secondary'>
                    Describe the outcome. Gofer will plan the work and operate Godot for you.
                </Text>
            </VStack>
            <Grid
                columns={{minWidth: 280}}
                gap={3}
            >
                {SUGGESTIONS.map(suggestion => (
                    <ClickableCard
                        key={suggestion.title}
                        label={suggestion.title}
                        variant='muted'
                        padding={4}
                        onClick={() => {
                            onSuggestion(suggestion.prompt)
                        }}
                    >
                        <VStack gap={1}>
                            <Heading level={3}>{suggestion.title}</Heading>
                            <Text
                                type='supporting'
                                color='secondary'
                            >
                                {suggestion.description}
                            </Text>
                        </VStack>
                    </ClickableCard>
                ))}
            </Grid>
        </VStack>
    )
}

export default function App() {
    const [draft, setDraft] = useState('')
    const [messages, setMessages] = useState<readonly Message[]>([])
    const nextMessageId = useRef(1)

    const submitMessage = (value: string) => {
        const prompt = value.trim()

        if (!prompt) {
            return
        }

        const userMessage: Message = {
            id: nextMessageId.current++,
            sender: 'user',
            text: prompt
        }
        const assistantMessage: Message = {
            id: nextMessageId.current++,
            sender: 'assistant',
            text: 'The workspace is ready. Connect a Godot 4.7 editor to begin executing this task.'
        }

        setMessages(previous => [...previous, userMessage, assistantMessage])
        setDraft('')
    }

    return (
        <AppShell
            contentPadding={0}
            sideNav={
                <SideNav
                    collapsible
                    resizable={{defaultWidth: 280, minWidth: 220, maxWidth: 400}}
                    header={
                        <SideNavHeading
                            heading='Gofer'
                            icon={
                                <NavIcon
                                    icon={
                                        <Icon
                                            icon={SparklesIcon}
                                            size='sm'
                                            color='accent'
                                        />
                                    }
                                />
                            }
                            headingHref='#'
                        />
                    }
                    footer={
                        <SideNavSection
                            title='System'
                            isHeaderHidden
                        >
                            <SideNavItem
                                label='Settings'
                                icon={Cog6ToothIcon}
                                href='#'
                            />
                        </SideNavSection>
                    }
                >
                    <SideNavSection
                        title='Actions'
                        isHeaderHidden
                    >
                        <SideNavItem
                            label='New task'
                            icon={PlusIcon}
                            href='#'
                            isSelected
                        />
                        <SideNavItem
                            label='Projects'
                            icon={FolderOpenIcon}
                            href='#'
                        />
                    </SideNavSection>
                    <SideNavSection title='Recent tasks'>
                        <SideNavItem
                            label='Player movement'
                            icon={ChatBubbleLeftRightIcon}
                            href='#'
                            endContent={
                                <StatusDot
                                    variant='success'
                                    label='Complete'
                                />
                            }
                        />
                        <SideNavItem
                            label='Village lighting'
                            icon={ChatBubbleLeftRightIcon}
                            href='#'
                            endContent={
                                <StatusDot
                                    variant='neutral'
                                    label='Idle'
                                />
                            }
                        />
                        <SideNavItem
                            label='Inventory prototype'
                            icon={ChatBubbleLeftRightIcon}
                            href='#'
                            endContent={
                                <StatusDot
                                    variant='warning'
                                    label='Needs review'
                                />
                            }
                        />
                    </SideNavSection>
                </SideNav>
            }
        >
            <Layout
                height='fill'
                contentWidth={880}
                content={
                    <LayoutContent padding={6}>
                        <VStack
                            gap={6}
                            height='100%'
                        >
                            <HStack
                                hAlign='between'
                                vAlign='center'
                            >
                                <VStack gap={0.5}>
                                    <Heading level={2}>New task</Heading>
                                    <Text
                                        type='supporting'
                                        color='secondary'
                                    >
                                        Agent workspace
                                    </Text>
                                </VStack>
                                <HStack
                                    gap={3}
                                    vAlign='center'
                                >
                                    <HStack
                                        gap={1}
                                        vAlign='center'
                                    >
                                        <StatusDot
                                            variant='neutral'
                                            label='Godot disconnected'
                                        />
                                        <Text type='supporting'>Godot disconnected</Text>
                                    </HStack>
                                    <HStack
                                        gap={1}
                                        vAlign='center'
                                    >
                                        <Icon
                                            icon={CodeBracketSquareIcon}
                                            size='sm'
                                        />
                                        <Text type='supporting'>4.7</Text>
                                    </HStack>
                                </HStack>
                            </HStack>
                            {messages.length === 0 ?
                                <Welcome onSuggestion={setDraft} />
                            :   <ChatMessageList density='spacious'>
                                    {messages.map(message => (
                                        <ChatMessage
                                            key={message.id}
                                            sender={message.sender}
                                        >
                                            <ChatMessageBubble
                                                variant={
                                                    message.sender === 'assistant' ?
                                                        'ghost'
                                                    :   'filled'
                                                }
                                                name={
                                                    message.sender === 'assistant' ?
                                                        'Gofer'
                                                    :   undefined
                                                }
                                            >
                                                <Text>{message.text}</Text>
                                            </ChatMessageBubble>
                                        </ChatMessage>
                                    ))}
                                </ChatMessageList>
                            }
                        </VStack>
                    </LayoutContent>
                }
                footer={
                    <LayoutFooter>
                        <VStack gap={2}>
                            <ChatComposer
                                value={draft}
                                onChange={setDraft}
                                onSubmit={submitMessage}
                                placeholder='Ask Gofer to build, fix, or explain anything…'
                                footerActions={
                                    <HStack
                                        gap={3}
                                        vAlign='center'
                                    >
                                        <HStack
                                            gap={1}
                                            vAlign='center'
                                        >
                                            <Icon
                                                icon={CubeTransparentIcon}
                                                size='sm'
                                            />
                                            <Text type='supporting'>Godot context</Text>
                                        </HStack>
                                        <HStack
                                            gap={1}
                                            vAlign='center'
                                        >
                                            <Icon
                                                icon={BoltIcon}
                                                size='sm'
                                            />
                                            <Text type='supporting'>Plan first</Text>
                                        </HStack>
                                    </HStack>
                                }
                            />
                            <Text
                                type='supporting'
                                color='secondary'
                            >
                                Gofer can make mistakes. Review project changes before shipping.
                            </Text>
                        </VStack>
                    </LayoutFooter>
                }
            />
        </AppShell>
    )
}

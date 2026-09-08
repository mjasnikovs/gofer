import {useCallback, useState} from 'react'
import {Button} from '@astryxdesign/core/Button'
import {Card} from '@astryxdesign/core/Card'
import {HStack, StackItem, VStack} from '@astryxdesign/core/Stack'
import {Text} from '@astryxdesign/core/Text'
import {Token} from '@astryxdesign/core/Token'
import {deleteProjectMemory, setMemoryStates} from '../../services/project-memory'
import {forgetMemoryList, useRememberedFact} from '../../hooks/useRememberedFact'
import {isRetrievable} from '../../models/memory'
import type {ToolActivity} from '../../models/chat'

const REMEMBER_SURFACE = 'gofer-remember-surface'

function Line({children}: Readonly<{children: string}>) {
    return (
        <Text
            type='supporting'
            color='secondary'
        >
            {children}
        </Text>
    )
}

// One thing the model asked to remember, waiting for the user to keep it or throw it away.
//
// The card is drawn from the stored row rather than from the tool result, because a tool result is
// text the model reads and this is a decision that has to still be there when the conversation is
// reopened. Nothing here blocks the turn: the memory is already filed as a candidate, and a
// candidate is never given to another turn, so leaving the card alone is the same as saying no.
export function RememberBlock({tool}: Readonly<{tool: ToolActivity}>) {
    const {memory, isLoaded} = useRememberedFact(tool.id)
    const [isSaving, setIsSaving] = useState(false)

    const keep = useCallback(() => {
        if (!memory) return
        setIsSaving(true)
        void setMemoryStates([memory.id], 'confirmed')
            .catch(() => undefined)
            .finally(() => {
                setIsSaving(false)
                forgetMemoryList()
            })
    }, [memory])

    const drop = useCallback(() => {
        if (!memory) return
        setIsSaving(true)
        void deleteProjectMemory(memory.id)
            .catch(() => undefined)
            .finally(() => {
                setIsSaving(false)
                forgetMemoryList()
            })
    }, [memory])

    if (!isLoaded) return null

    return (
        <Card
            className={REMEMBER_SURFACE}
            padding={4}
            elevation='low'
        >
            <VStack gap={2}>
                <HStack
                    gap={2}
                    align='center'
                >
                    <StackItem size='fill'>
                        <Line>Worth remembering?</Line>
                    </StackItem>
                    {memory && (
                        <Token
                            size='sm'
                            label={memory.kind}
                        />
                    )}
                </HStack>
                <Text>{memory?.content ?? tool.target ?? ''}</Text>
                {memory === undefined ?
                    <Line>Not kept. No later turn will be given it.</Line>
                : isRetrievable(memory) ?
                    <Line>Kept. Later turns can be given it.</Line>
                :   <HStack gap={2}>
                        <Button
                            label='Keep'
                            variant='primary'
                            size='sm'
                            isDisabled={isSaving}
                            onClick={keep}
                        />
                        <Button
                            label='Drop'
                            variant='ghost'
                            size='sm'
                            isDisabled={isSaving}
                            onClick={drop}
                        />
                    </HStack>
                }
            </VStack>
        </Card>
    )
}

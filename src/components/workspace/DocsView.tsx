import {useCallback, useRef, useState} from 'react'
import {Button} from '@astryxdesign/core/Button'
import {Divider} from '@astryxdesign/core/Divider'
import {HStack, StackItem, VStack} from '@astryxdesign/core/Stack'
import {Text} from '@astryxdesign/core/Text'
import {TextInput} from '@astryxdesign/core/TextInput'
import {Token} from '@astryxdesign/core/Token'
import {queryGodotDocs, toGodotError} from '../../services/godot-session'
import type {DocsPassage, GodotError} from '../../models/godot'
import {PanelState} from './PanelState'

const MAX_PASSAGES = 6

/**
 * Documentation retrieval. `retrieve()` is used rather than `query()`, so answering a question here
 * costs no second model request, and it exposes no source link: a citation names the chapter a
 * passage came from and its position in that chapter, which is all the retriever knows.
 */
export function DocsView() {
    const [question, setQuestion] = useState('')
    const [passages, setPassages] = useState<readonly DocsPassage[]>()
    const [error, setError] = useState<GodotError>()
    const [isLoading, setIsLoading] = useState(false)

    /*
     * Only the newest question gets to answer. Enter is not gated on the spinner the way the button
     * is, so two searches can be in flight at once — and they resolve in arrival order, which let an
     * older answer land on top of a newer one and clear the spinner that was still waiting for it.
     */
    const latest = useRef(0)

    const search = useCallback(() => {
        const asked = question.trim()
        if (asked === '') return
        const asking = latest.current + 1
        latest.current = asking
        setIsLoading(true)
        void queryGodotDocs({question: asked, maxPassages: MAX_PASSAGES})
            .then(response => {
                if (latest.current !== asking) return
                setPassages(response.passages)
                setError(undefined)
            })
            .catch((failure: unknown) => {
                if (latest.current !== asking) return
                setError(toGodotError(failure))
                setPassages(undefined)
            })
            .finally(() => {
                if (latest.current === asking) setIsLoading(false)
            })
    }, [question])

    return (
        <VStack
            gap={0}
            height='100%'
        >
            <HStack
                gap={2}
                padding={3}
                align='end'
            >
                <StackItem size='fill'>
                    <TextInput
                        label='Ask the Godot documentation'
                        size='sm'
                        placeholder='How do I move a CharacterBody2D?'
                        value={question}
                        hasClear
                        onChange={setQuestion}
                        onKeyDown={event => {
                            if (event.key === 'Enter') search()
                        }}
                    />
                </StackItem>
                <Button
                    label='Search'
                    size='sm'
                    isDisabled={question.trim() === '' || isLoading}
                    clickAction={search}
                />
            </HStack>
            <Divider />
            <StackItem
                size='fill'
                isScrollable
            >
                <PanelState
                    label='documentation'
                    isLoading={isLoading}
                    error={error}
                    isEmpty={(passages?.length ?? 0) === 0}
                    emptyTitle={passages ? 'Nothing matched' : 'Search the documentation'}
                    emptyDescription='Passages are cited by chapter: the retriever returns no documentation URL.'
                >
                    <VStack
                        gap={3}
                        padding={3}
                    >
                        {(passages ?? []).map(passage => (
                            <VStack
                                key={`${passage.chapter}:${String(passage.order)}`}
                                gap={1}
                            >
                                <HStack
                                    gap={2}
                                    align='center'
                                >
                                    <Text type='label'>{passage.chapter}</Text>
                                    {/*
                                     * Token, not Badge: which section of the chapter this passage
                                     * came from is a label on the result, not a count and not one
                                     * of a fixed set of states.
                                     */}
                                    <Token label={`Section ${String(passage.order)}`} />
                                    <Text
                                        type='supporting'
                                        color='secondary'
                                    >
                                        {`score ${passage.score.toFixed(3)}`}
                                    </Text>
                                </HStack>
                                <Text>{passage.text}</Text>
                            </VStack>
                        ))}
                    </VStack>
                </PanelState>
            </StackItem>
        </VStack>
    )
}

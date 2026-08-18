import {useState} from 'react'
import {Badge} from '@astryxdesign/core/Badge'
import {Button} from '@astryxdesign/core/Button'
import {Dialog, DialogHeader} from '@astryxdesign/core/Dialog'
import {SelectableCard} from '@astryxdesign/core/SelectableCard'
import {HStack, VStack} from '@astryxdesign/core/Stack'
import {Text} from '@astryxdesign/core/Text'
import {TextArea} from '@astryxdesign/core/TextArea'
import type {UserQuestionPrompt} from '../../models/brief'

type UserQuestionDialogProps = Readonly<{
    prompt?: UserQuestionPrompt | undefined
    onAnswer: (questionId: string, answer: string | null) => void
}>

/**
 * Asks the user one question the agent could not settle.
 *
 * Not a brief dialog, though the brief is what it was built for: `ask_user` is an ordinary tool, so
 * an ordinary chat turn reaches this same card. Nothing here knows what asked.
 *
 * The suggested answers are cards rather than the only way in, because they are shortcuts and the
 * real answer is free text — picking one fills the box, so the user can take it, edit it, or ignore
 * it entirely. That is the difference between offering an answer and constraining one.
 *
 * Only the oldest waiting question is shown. The agent may have more than one call in flight, but a
 * stack of dialogs makes it too easy to answer the wrong one.
 *
 * Dismissing is a skip, not a refusal and not an empty answer — the agent is told the user read it
 * and left the decision to it, and told not to ask again. Something has to be said either way: there
 * is a tool call on the other side holding a thread open.
 */
export function UserQuestionDialog({prompt, onAnswer}: UserQuestionDialogProps) {
    const [draft, setDraft] = useState('')
    // Which question the draft was typed for. Compared during render rather than reset from an
    // effect, so an answer meant for one question can never reach the next: an effect would clear it
    // one render *after* the new question is already on screen with the old text in the box.
    const [answering, setAnswering] = useState(prompt?.questionId)
    if (prompt?.questionId !== answering) {
        setAnswering(prompt?.questionId)
        setDraft('')
    }

    if (!prompt) return null
    const answer = draft.trim()
    return (
        <Dialog
            isOpen
            purpose='form'
            width={520}
            onOpenChange={isOpen => {
                if (!isOpen) onAnswer(prompt.questionId, null)
            }}
        >
            <DialogHeader
                title={prompt.question}
                {...(prompt.why && {subtitle: prompt.why})}
            />
            <VStack
                gap={3}
                padding={4}
            >
                {prompt.options.length > 0 && (
                    <VStack gap={2}>
                        <Text
                            size='sm'
                            color='secondary'
                        >
                            {prompt.options.length === 1 ? 'Suggested answer' : 'Suggested answers'}
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
                <TextArea
                    label='Your answer'
                    rows={3}
                    value={draft}
                    hasAutoFocus
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
                            onAnswer(prompt.questionId, null)
                        }}
                    />
                    <Button
                        label='Answer'
                        variant='primary'
                        isDisabled={answer.length === 0}
                        onClick={() => {
                            onAnswer(prompt.questionId, answer)
                        }}
                    />
                </HStack>
            </VStack>
        </Dialog>
    )
}

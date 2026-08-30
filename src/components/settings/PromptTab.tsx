import {Button} from '@astryxdesign/core/Button'
import {Grid} from '@astryxdesign/core/Grid'
import {Icon} from '@astryxdesign/core/Icon'
import {LayoutFooter} from '@astryxdesign/core/Layout'
import {HStack, VStack} from '@astryxdesign/core/Stack'
import {Heading, Text} from '@astryxdesign/core/Text'
import {TextArea} from '@astryxdesign/core/TextArea'
import ArrowUturnLeftIcon from '@heroicons/react/24/outline/ArrowUturnLeftIcon'
import ChatBubbleLeftRightIcon from '@heroicons/react/24/outline/ChatBubbleLeftRightIcon'
import {invoke} from '../../services/desktop'
import {agentPromptIsDefault, agentPromptIsUnsaved} from '../../models/settings-draft'
import {SETTINGS_GRID_COLUMNS, settingsBanner} from './settings-view'
import type {SettingsTabView, SettingsView} from './settings-view'

export function usePromptTab(view: SettingsView): SettingsTabView {
    const {state, dispatch, run} = view
    const draft = state.settings
    const {busy} = state
    const isShippedPrompt = agentPromptIsDefault(state)
    const isPromptUnsaved = agentPromptIsUnsaved(state)

    const saveAgentPrompt = () =>
        run('savingPrompt', 'Agent prompt could not be saved', async () => {
            dispatch({
                type: 'prompt-saved',
                prompt: await invoke('save_agent_prompt', {prompt: state.agentPrompt})
            })
        })

    return {
        body: (
            <VStack gap={8}>
                {settingsBanner(view, 'prompt')}

                <Grid
                    columns={SETTINGS_GRID_COLUMNS}
                    gap={10}
                >
                    <VStack gap={2}>
                        <HStack
                            gap={2}
                            vAlign='center'
                        >
                            <Icon
                                icon={ChatBubbleLeftRightIcon}
                                size='md'
                                color='accent'
                            />
                            <Heading level={2}>Agent prompt</Heading>
                        </HStack>
                        <Text color='secondary'>
                            What the agent is told before every turn, sent exactly as it reads here.
                            It belongs to this project, so another project keeps its own.
                        </Text>
                    </VStack>

                    {draft ?
                        <TextArea
                            label='System prompt'
                            value={state.agentPrompt}
                            rows={18}
                            hasSpellCheck={false}
                            description={
                                isShippedPrompt ?
                                    'This is the prompt Gofer ships. Editing it stores your version with the project.'
                                :   'Edited for this project. Restoring the default lets later Gofer versions update it again.'
                            }
                            onChange={typed => {
                                dispatch({type: 'prompt-typed', value: typed})
                            }}
                        />
                    :   <Text color='secondary'>
                            {state.isLoading ?
                                'Loading the agent prompt…'
                            :   'The agent prompt is unavailable.'}
                        </Text>
                    }
                </Grid>
            </VStack>
        ),
        footer:
            draft ?
                <LayoutFooter
                    hasDivider
                    label='Agent prompt actions'
                >
                    <HStack
                        gap={3}
                        hAlign='end'
                    >
                        <Button
                            label='Restore default'
                            variant='secondary'
                            icon={
                                <Icon
                                    icon={ArrowUturnLeftIcon}
                                    size='sm'
                                />
                            }
                            isDisabled={isShippedPrompt}
                            clickAction={() => {
                                dispatch({type: 'prompt-restored'})
                            }}
                        />
                        <Button
                            label='Save prompt'
                            variant='primary'
                            isLoading={busy.savingPrompt}
                            isDisabled={!isPromptUnsaved}
                            clickAction={saveAgentPrompt}
                        />
                    </HStack>
                </LayoutFooter>
            :   undefined
    }
}

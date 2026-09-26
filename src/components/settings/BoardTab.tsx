import {Button} from '@astryxdesign/core/Button'
import {Grid} from '@astryxdesign/core/Grid'
import {Icon} from '@astryxdesign/core/Icon'
import {LayoutFooter} from '@astryxdesign/core/Layout'
import {HStack, VStack} from '@astryxdesign/core/Stack'
import {Heading, Text} from '@astryxdesign/core/Text'
import ArrowUturnLeftIcon from '@heroicons/react/24/outline/ArrowUturnLeftIcon'
import ViewColumnsIcon from '@heroicons/react/24/outline/ViewColumnsIcon'
import {TextField} from '../TextField'
import {saveCardTemplate} from '../../services/board'
import {cardTemplateIsDefault, cardTemplateIsUnsaved} from '../../models/settings-draft'
import {SETTINGS_GRID_COLUMNS, settingsBanner} from './settings-view'
import type {SettingsTabView, SettingsView} from './settings-view'

export function useBoardTab(view: SettingsView): SettingsTabView {
    const {state, dispatch, run} = view
    const draft = state.settings
    const {busy} = state
    const isShippedTemplate = cardTemplateIsDefault(state)
    const isTemplateUnsaved = cardTemplateIsUnsaved(state)

    const save = () =>
        run('savingTemplate', 'Card template could not be saved', async () => {
            dispatch({type: 'template-saved', template: await saveCardTemplate(state.cardTemplate)})
        })

    return {
        body: (
            <VStack gap={8}>
                {settingsBanner(view, 'board')}

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
                                icon={ViewColumnsIcon}
                                size='md'
                                color='accent'
                            />
                            <Heading level={2}>Board cards</Heading>
                        </HStack>
                        <Text color='secondary'>
                            Every new card starts from this. Bare headings are what Execute as plan
                            reads back, so a section the user filled is kept as written. Leave one
                            out if the project never needs it.
                        </Text>
                    </VStack>

                    {draft ?
                        <TextField
                            kind='plain'
                            label='Card template'
                            value={state.cardTemplate}
                            rows={12}
                            hasSpellCheck={false}
                            description={
                                isShippedTemplate ?
                                    'This is the template Gofer ships. Editing it stores your version with the project.'
                                :   'Edited for this project. Restoring the default lets later Gofer versions update it again.'
                            }
                            onChange={typed => {
                                dispatch({type: 'template-typed', value: typed})
                            }}
                        />
                    :   <Text color='secondary'>
                            {state.isLoading ?
                                'Loading the card template…'
                            :   'The card template is unavailable.'}
                        </Text>
                    }
                </Grid>
            </VStack>
        ),
        footer:
            draft ?
                <LayoutFooter
                    hasDivider
                    label='Card template actions'
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
                            isDisabled={isShippedTemplate}
                            clickAction={() => {
                                dispatch({type: 'template-restored'})
                            }}
                        />
                        <Button
                            label='Save template'
                            variant='primary'
                            isLoading={busy.savingTemplate}
                            isDisabled={!isTemplateUnsaved}
                            clickAction={save}
                        />
                    </HStack>
                </LayoutFooter>
            :   undefined
    }
}

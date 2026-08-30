import {CheckboxInput} from '@astryxdesign/core/CheckboxInput'
import {FormLayout} from '@astryxdesign/core/FormLayout'
import {Grid} from '@astryxdesign/core/Grid'
import {Icon} from '@astryxdesign/core/Icon'
import {HStack, VStack} from '@astryxdesign/core/Stack'
import {Heading, Text} from '@astryxdesign/core/Text'
import ShieldCheckIcon from '@heroicons/react/24/outline/ShieldCheckIcon'
import {invoke} from '../../services/desktop'
import type {GodotSettings} from '../../models/settings'
import {SETTINGS_GRID_COLUMNS, settingsBanner} from './settings-view'
import type {SettingsTabView, SettingsView} from './settings-view'

export function useGodotTab(view: SettingsView): SettingsTabView {
    const {state, dispatch, run} = view
    const draft = state.settings
    const {busy} = state

    const saveGodotSettings = async (update: Partial<GodotSettings>) => {
        const previous = draft?.godot
        if (!previous) return
        dispatch({type: 'godot-changed', update})
        await run('savingGodot', 'Godot rules could not be saved', async () => {
            try {
                const response = await invoke('save_godot_settings', {
                    godot: {...previous, ...update}
                })
                dispatch({type: 'godot-saved', response})
            } catch (error) {
                dispatch({type: 'godot-changed', update: previous})
                throw error
            }
        })
    }

    return {
        body: (
            <VStack gap={8}>
                {settingsBanner(view, 'godot')}

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
                                icon={ShieldCheckIcon}
                                size='md'
                                color='accent'
                            />
                            <Heading level={2}>Godot rules</Heading>
                        </HStack>
                        <Text color='secondary'>
                            What Gofer holds the editor to. Both are written when a Godot session
                            starts, because Godot reads where a game window goes once and never
                            looks again. A change here reaches the editor the next time one is
                            started.
                        </Text>
                    </VStack>

                    {draft ?
                        <FormLayout>
                            <CheckboxInput
                                label='Enforce strict typing'
                                value={draft.godot.strictTyping}
                                isLoading={busy.savingGodot}
                                description='Untyped variables and Variant-based access become parse errors, not warnings. Godot leaves res://addons alone.'
                                onChange={strictTyping => {
                                    void saveGodotSettings({strictTyping})
                                }}
                            />
                            <CheckboxInput
                                label='Enforce game window inline'
                                value={draft.godot.embedGameWindow}
                                isLoading={busy.savingGodot}
                                description='The running game is drawn inside the editor and cannot be torn out into a window of its own.'
                                onChange={embedGameWindow => {
                                    void saveGodotSettings({embedGameWindow})
                                }}
                            />
                        </FormLayout>
                    :   <Text color='secondary'>
                            {state.isLoading ?
                                'Loading the Godot rules…'
                            :   'The Godot rules are unavailable.'}
                        </Text>
                    }
                </Grid>
            </VStack>
        ),
        footer: undefined
    }
}

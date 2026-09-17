import {useEffect, useState} from 'react'
import {Banner} from '@astryxdesign/core/Banner'
import {Button} from '@astryxdesign/core/Button'
import {CheckboxInput} from '@astryxdesign/core/CheckboxInput'
import {CodeBlock} from '@astryxdesign/core/CodeBlock'
import {FormLayout} from '@astryxdesign/core/FormLayout'
import {Grid} from '@astryxdesign/core/Grid'
import {Icon} from '@astryxdesign/core/Icon'
import {LayoutFooter} from '@astryxdesign/core/Layout'
import {HStack, VStack} from '@astryxdesign/core/Stack'
import {Heading, Text} from '@astryxdesign/core/Text'
import {TextInput} from '@astryxdesign/core/TextInput'
import UsersIcon from '@heroicons/react/24/outline/UsersIcon'
import {invoke} from '../../services/desktop'
import {commandErrorMessage} from '../../utils/command-error'
import type {DoorStatus} from '../../models/settings'
import {SETTINGS_GRID_COLUMNS, settingsBanner} from './settings-view'
import type {SettingsTabView, SettingsView} from './settings-view'

/** A fresh token from the browser's own randomness, without the dashes a shell might trip on. */
function mintToken() {
    return crypto.randomUUID().replaceAll('-', '')
}

const LAST_PORT = 65535

function parsePort(typed: string): number | undefined {
    if (!/^\d+$/u.test(typed.trim())) return undefined
    const port = Number.parseInt(typed, 10)
    return port >= 1 && port <= LAST_PORT ? port : undefined
}

const CLI_EXAMPLE = 'gofer-cli tools\ngofer-cli godot_scene list\ngofer-cli board list'

export function useAgentsTab(view: SettingsView): SettingsTabView {
    const {state, dispatch, run} = view
    const draft = state.settings
    const {busy} = state
    const [status, setStatus] = useState<DoorStatus | undefined>()
    // The field holds what was typed, not the number: a port being retyped passes through
    // nothing and through 7, and neither of those is a port the draft should hold.
    const [portText, setPortText] = useState<string>()
    const savedDoor = state.savedSettings?.door
    const typedPort = portText === undefined ? draft?.door.port : parsePort(portText)
    const isPortValid = typedPort !== undefined
    const isDirty =
        draft !== undefined
        && savedDoor !== undefined
        && isPortValid
        && (draft.door.enabled !== savedDoor.enabled
            || draft.door.port !== savedDoor.port
            || draft.door.token !== savedDoor.token)

    useEffect(() => {
        if (!savedDoor) return undefined
        let cancelled = false
        void invoke('door_status')
            .then(read => {
                if (!cancelled) setStatus(read)
            })
            .catch((error: unknown) => {
                if (!cancelled) setStatus({url: null, error: commandErrorMessage(error)})
            })
        return () => {
            cancelled = true
        }
    }, [savedDoor])

    const save = () =>
        run('savingDoor', 'The agent door could not be saved', async () => {
            if (!draft) return
            const response = await invoke('save_door_settings', {door: draft.door})
            dispatch({type: 'door-saved', response})
        })

    const url = status?.url ?? undefined

    return {
        body: (
            <VStack gap={8}>
                {settingsBanner(view, 'agents')}

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
                                icon={UsersIcon}
                                size='md'
                                color='accent'
                            />
                            <Heading level={2}>Other agents</Heading>
                        </HStack>
                        <Text color='secondary'>
                            An agent in a terminal on this machine can call every tool the model
                            has, editor and board alike, through this address and token. The
                            gofer-cli command in Gofer's repository reads both from the settings
                            file. Shut unless you open it: a token that leaks buys file writes.
                        </Text>
                        {status?.error ?
                            <Banner
                                status='error'
                                title='The door is shut'
                                description={status.error}
                            />
                        :   null}
                    </VStack>

                    {draft ?
                        <FormLayout>
                            <CheckboxInput
                                label='Open the door'
                                value={draft.door.enabled}
                                description='While Gofer is open, and only on this machine.'
                                onChange={enabled => {
                                    dispatch({type: 'door-changed', update: {enabled}})
                                }}
                            />
                            <TextInput
                                label='Port'
                                value={portText ?? String(draft.door.port)}
                                description='On this machine only. Two open projects need two ports.'
                                {...(!isPortValid && {
                                    status: {
                                        type: 'error',
                                        message: 'A port is a number between 1 and 65535'
                                    }
                                })}
                                onChange={typed => {
                                    setPortText(typed)
                                    const port = parsePort(typed)
                                    if (port !== undefined)
                                        dispatch({type: 'door-changed', update: {port}})
                                }}
                            />
                            <TextInput
                                label='Token'
                                value={draft.door.token}
                                description='Every request must carry it. Anyone who has it can write to the board.'
                                onChange={token => {
                                    dispatch({type: 'door-changed', update: {token}})
                                }}
                            />
                            <Button
                                label='New token'
                                variant='secondary'
                                clickAction={() => {
                                    dispatch({type: 'door-changed', update: {token: mintToken()}})
                                }}
                            />
                            {url && savedDoor?.enabled ?
                                <CodeBlock
                                    title={url}
                                    code={CLI_EXAMPLE}
                                    width='100%'
                                />
                            :   null}
                        </FormLayout>
                    :   <Text color='secondary'>
                            {state.isLoading ?
                                'Loading the agent door…'
                            :   'The agent door settings are unavailable.'}
                        </Text>
                    }
                </Grid>
            </VStack>
        ),
        footer: (
            <LayoutFooter
                hasDivider
                label='Agent door actions'
            >
                <HStack
                    gap={3}
                    hAlign='end'
                >
                    <Button
                        label='Save'
                        variant='primary'
                        isLoading={busy.savingDoor}
                        isDisabled={!isDirty}
                        clickAction={save}
                    />
                </HStack>
            </LayoutFooter>
        )
    }
}

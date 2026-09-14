import {useEffect, useState} from 'react'
import {Banner} from '@astryxdesign/core/Banner'
import {Button} from '@astryxdesign/core/Button'
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
import type {McpStatus} from '../../models/settings'
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

function connectCommand(url: string, token: string) {
    return `claude mcp add --transport http gofer ${url} --header "Authorization: Bearer ${token}"`
}

export function useAgentsTab(view: SettingsView): SettingsTabView {
    const {state, dispatch, run} = view
    const draft = state.settings
    const {busy} = state
    const [status, setStatus] = useState<McpStatus | undefined>()
    // The field holds what was typed, not the number: a port being retyped passes through
    // nothing and through 7, and neither of those is a port the draft should hold.
    const [portText, setPortText] = useState<string>()
    const savedMcp = state.savedSettings?.mcp
    const typedPort = portText === undefined ? draft?.mcp.port : parsePort(portText)
    const isPortValid = typedPort !== undefined
    const isDirty =
        draft !== undefined
        && savedMcp !== undefined
        && isPortValid
        && (draft.mcp.port !== savedMcp.port || draft.mcp.token !== savedMcp.token)

    useEffect(() => {
        if (!savedMcp) return undefined
        let cancelled = false
        void invoke('mcp_status')
            .then(read => {
                if (!cancelled) setStatus(read)
            })
            .catch((error: unknown) => {
                if (!cancelled) setStatus({url: null, error: commandErrorMessage(error)})
            })
        return () => {
            cancelled = true
        }
    }, [savedMcp])

    const save = () =>
        run('savingMcp', 'The agent door could not be saved', async () => {
            if (!draft) return
            const response = await invoke('save_mcp_settings', {mcp: draft.mcp})
            dispatch({type: 'mcp-saved', response})
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
                            Any MCP client on this machine can read and write the project board with
                            this address and token. It reaches cards and comments only, never files.
                            The door is open while Gofer is open.
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
                            <TextInput
                                label='Port'
                                value={portText ?? String(draft.mcp.port)}
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
                                        dispatch({type: 'mcp-changed', update: {port}})
                                }}
                            />
                            <TextInput
                                label='Token'
                                value={draft.mcp.token}
                                description='Every request must carry it. Anyone who has it can write to the board.'
                                onChange={token => {
                                    dispatch({type: 'mcp-changed', update: {token}})
                                }}
                            />
                            <Button
                                label='New token'
                                variant='secondary'
                                clickAction={() => {
                                    dispatch({type: 'mcp-changed', update: {token: mintToken()}})
                                }}
                            />
                            {url && savedMcp ?
                                <CodeBlock
                                    title='Connect Claude Code'
                                    code={connectCommand(url, savedMcp.token)}
                                    isWrapped
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
                        isLoading={busy.savingMcp}
                        isDisabled={!isDirty}
                        clickAction={save}
                    />
                </HStack>
            </LayoutFooter>
        )
    }
}

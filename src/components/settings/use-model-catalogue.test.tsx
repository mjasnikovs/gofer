import {cleanup, renderHook, waitFor} from '@testing-library/react'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {useModelCatalogue} from './use-model-catalogue'
import type {ModelSeat} from './use-model-catalogue'
import {INITIAL_SETTINGS_DRAFT} from '../../models/settings-draft'
import type {SettingsAction, SettingsDraft} from '../../models/settings-draft'
import type {GoferSettings} from '../../models/settings'
import {SETTINGS} from '../../test/backend'
import {createDesktopFake, installDesktopFake, removeDesktopFake} from '../../test/desktop-driver'
import type {SettingsView} from './settings-view'

const tauri = createDesktopFake()

const STORED: GoferSettings = SETTINGS.settings

function at(address: string): GoferSettings {
    const local = STORED.ai.connections['openai-compatible']
    if (!local) throw new Error('the fixture settings have a local connection')
    return {
        ...STORED,
        ai: {
            ...STORED.ai,
            connections: {
                ...STORED.ai.connections,
                'openai-compatible': {...local, baseUrl: address}
            }
        }
    }
}

function draft(settings: GoferSettings, savedSettings: GoferSettings): SettingsDraft {
    return {...INITIAL_SETTINGS_DRAFT, settings, savedSettings, isLoading: false}
}

function view(state: SettingsDraft, dispatch: (action: SettingsAction) => void): SettingsView {
    return {
        state,
        dispatch,
        run: async (_task, _title, work) => {
            await work()
        }
    }
}

function listing(state: SettingsDraft, seat: ModelSeat = 'main') {
    const dispatched: SettingsAction[] = []
    const rendered = renderHook(
        (props: {state: SettingsDraft}) => {
            useModelCatalogue(
                view(props.state, action => {
                    dispatched.push(action)
                }),
                seat
            )
        },
        {initialProps: {state}}
    )
    return {dispatched, rendered}
}

beforeEach(() => {
    installDesktopFake(tauri)
    tauri.invoke.mockReset()
    tauri.invoke.mockResolvedValue([])
})

afterEach(() => {
    cleanup()
    removeDesktopFake()
    vi.restoreAllMocks()
})

describe('useModelCatalogue', () => {
    it('files the answer against the address it asked, not the one the draft has moved on to', async () => {
        const saved = at('http://saved:8080/v1')
        const {rendered} = listing(draft(saved, saved))
        await waitFor(() => {
            expect(tauri.invoke).toHaveBeenCalled()
        })
        tauri.invoke.mockClear()

        rendered.rerender({state: draft(at('http://typed:9090/v1'), saved)})
        // A typed address is not the question: it re-asks nothing, so nothing is filed under a key
        // that describes an address the request never reached.
        expect(tauri.invoke).not.toHaveBeenCalled()

        listing(draft(at('http://typed:9090/v1'), saved))
        await waitFor(() => {
            expect(tauri.invoke).toHaveBeenCalledTimes(1)
        })
        const [, payload] = tauri.invoke.mock.calls[0] ?? []
        const sent = (payload as {request: {settings: GoferSettings}}).request.settings
        expect(sent.ai.connections['openai-compatible']?.baseUrl).toBe('http://saved:8080/v1')
    })

    it('re-asks when the confirmed address moves, which is the only thing that changes the question', async () => {
        const saved = at('http://saved:8080/v1')
        const {rendered} = listing(draft(saved, saved))
        await waitFor(() => {
            expect(tauri.invoke).toHaveBeenCalledTimes(1)
        })

        const moved = at('http://moved:8080/v1')
        rendered.rerender({state: draft(moved, moved)})
        await waitFor(() => {
            expect(tauri.invoke).toHaveBeenCalledTimes(2)
        })
    })

    it('says which seat listed, so the sub-agent never overwrites the page it shares a driver with', async () => {
        const saved = at('http://saved:8080/v1')
        const main = listing(draft(saved, saved), 'main')
        await waitFor(() => {
            expect(main.dispatched.some(action => action.type === 'models-listed')).toBe(true)
        })
        expect(main.dispatched.some(action => action.type === 'subagent-models-listed')).toBe(false)
    })
})

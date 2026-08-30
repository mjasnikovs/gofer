import type {ReactNode} from 'react'
import {Banner} from '@astryxdesign/core/Banner'
import type {
    SettingsAction,
    SettingsDraft,
    SettingsTab,
    SettingsTask
} from '../../models/settings-draft'

export type SettingsView = Readonly<{
    state: SettingsDraft
    dispatch: (action: SettingsAction) => void
    run: (task: SettingsTask, title: string, work: () => Promise<void>) => Promise<void>
}>

export type SettingsTabView = Readonly<{
    body: ReactNode
    footer: ReactNode
}>

export const SETTINGS_GRID_COLUMNS = {minWidth: 320} as const

export function settingsBanner(view: SettingsView, owner: SettingsTab) {
    const notice = view.state.notices[owner]
    if (!notice) return null
    return (
        <Banner
            status={notice.status}
            title={notice.title}
            description={notice.description}
            isDismissable={notice.status !== 'error'}
            onDismiss={() => {
                view.dispatch({type: 'notice-dismissed', tab: owner})
            }}
        />
    )
}

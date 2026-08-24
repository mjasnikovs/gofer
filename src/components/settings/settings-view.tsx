import type {ReactNode} from 'react'
import {Banner} from '@astryxdesign/core/Banner'
import type {
    SettingsAction,
    SettingsDraft,
    SettingsTab,
    SettingsTask
} from '../../models/settings-draft'

/**
 * What every settings tab is given, and the whole of it.
 *
 * Three things: the draft the page is editing, the one dispatch that changes it, and the runner that
 * owns a task's began / failed / ended. Everything a tab used to close over — the connection it is
 * about, whether a search key is needed, the four update helpers, the save, the model lists — is
 * derived from these inside the tab that needs it.
 *
 * The tabs were five `const`s inside one 1,458-line function, so nothing could reach one without
 * mounting all five. They cross this interface now, which is also where their tests cross it.
 */
export type SettingsView = Readonly<{
    state: SettingsDraft
    dispatch: (action: SettingsAction) => void
    run: (task: SettingsTask, title: string, work: () => Promise<void>) => Promise<void>
}>

/**
 * One tab, as the dialog draws it: what fills the body, and what sits in the footer under it.
 *
 * Both, from one call, because a footer's buttons run the tab's own work — the AI footer's Save is
 * the AI tab's save. Returned as a pair rather than exported as two components so that work is
 * written once.
 */
export type SettingsTabView = Readonly<{
    body: ReactNode
    footer: ReactNode
}>

/** Every settings group breaks to one column at the same width. */
export const SETTINGS_GRID_COLUMNS = {minWidth: 320} as const

/**
 * One banner slot per tab, so a failure sits above the controls it is about. A download that failed
 * on the models tab does not push the connection form down, and neither one hides the other: both
 * tabs can be carrying a banner at once, because both tasks can run at once.
 */
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

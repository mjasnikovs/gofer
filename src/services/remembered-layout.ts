import {
    reduceLayout,
    toScriptViews,
    toWorkspaceLayout,
    type LayoutAction,
    type ScriptViews,
    type WorkspaceLayout
} from '../models/ui-state'
import {rememberValue} from './interface-state'
import type {InterfaceStateStore} from './interface-state'
import {SCRIPT_VIEWS_KEY, WORKSPACE_LAYOUT_KEY} from './ui-state'

export type LayoutStore = InterfaceStateStore

export type RememberedLayoutState =
    | Readonly<{isOpen: false}>
    | Readonly<{isOpen: true; layout: WorkspaceLayout; views: ScriptViews}>

export type RememberedLayout = Readonly<{
    state: () => RememberedLayoutState
    subscribe: (listener: () => void) => () => void
    open: () => Promise<void>
    dispatch: (action: LayoutAction) => void
    recordView: (path: string, view: unknown) => void
}>

const CLOSED: RememberedLayoutState = {isOpen: false}

export function createRememberedLayout(store: LayoutStore): RememberedLayout {
    const layout = rememberValue<WorkspaceLayout>(store, {restore: toWorkspaceLayout})
    let views: Record<string, unknown> = {}
    let current: RememberedLayoutState = CLOSED
    let isOpening = false
    const listeners = new Set<() => void>()

    const publish = (next: RememberedLayoutState) => {
        current = next
        for (const listener of [...listeners]) listener()
    }

    return {
        state: () => current,
        subscribe(listener) {
            listeners.add(listener)
            return () => {
                listeners.delete(listener)
            }
        },
        async open() {
            if (isOpening || current.isOpen) return
            isOpening = true
            await layout.open(WORKSPACE_LAYOUT_KEY)
            const opened = layout.state()
            if (!opened.isOpen) return
            const stored = toScriptViews(
                await store.read(SCRIPT_VIEWS_KEY),
                opened.value.openScripts
            )
            views = {...stored}
            publish({isOpen: true, layout: opened.value, views: stored})
        },
        dispatch(action) {
            if (!current.isOpen) return
            layout.change(previous => reduceLayout(previous, action))
            const changed = layout.state()
            if (!changed.isOpen || changed.value === current.layout) return
            publish({...current, layout: changed.value})

            const kept = toScriptViews(views, changed.value.openScripts)
            if (Object.keys(kept).length === Object.keys(views).length) return
            views = {...kept}
            store.write(SCRIPT_VIEWS_KEY, kept)
        },
        recordView(path, view) {
            views[path] = view
            store.write(SCRIPT_VIEWS_KEY, views)
        }
    }
}

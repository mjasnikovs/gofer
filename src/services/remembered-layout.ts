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

/**
 * Where a project's interface state is kept. The same store every other remembered value uses.
 *
 * The frame is the one remembered value that is two keys rather than one — the layout, and a cursor
 * per open script that is written far more often and published to nobody. That is why it has a
 * module of its own instead of being a bare `rememberValue`. The rule it obeys is not restated
 * here: the layout *is* a `rememberValue`, and what this module adds is the second key beside it.
 */
export type LayoutStore = InterfaceStateStore

export type RememberedLayoutState =
    | Readonly<{isOpen: false}>
    | Readonly<{isOpen: true; layout: WorkspaceLayout; views: ScriptViews}>

export type RememberedLayout = Readonly<{
    /** Whether the project has been read yet, and what it said. */
    state: () => RememberedLayoutState
    subscribe: (listener: () => void) => () => void
    /** Reads the project. Safe to call twice; the second call is ignored. */
    open: () => Promise<void>
    /** Changes the layout and records the change. Does nothing before `open` has answered. */
    dispatch: (action: LayoutAction) => void
    /** Records where the cursor was left in one script. */
    recordView: (path: string, view: unknown) => void
}>

const CLOSED: RememberedLayoutState = {isOpen: false}

/**
 * How one project's workspace was left, and how it is kept that way.
 *
 * The round trip is the module: read both keys, hold the layout closed until both have answered,
 * reduce every change, write what changed, and drop the cursor of a script that is no longer open.
 * Split across a reducer, a writer and a component, the join between them was the one part nothing
 * tested — and the join is where the damage is. Mounting on the defaults writes the defaults over
 * the project's real layout before the read that would have prevented it returns, which is why
 * `state()` reports `isOpen: false` rather than handing out a layout nobody has read yet.
 *
 * That rule is `rememberValue`'s, and the layout is one: closed until its key answers, changes
 * dropped while it is, written when the value genuinely moved. Only the part that is this module's
 * own is written here — the second key, and the fact that the two are opened together.
 */
export function createRememberedLayout(store: LayoutStore): RememberedLayout {
    const layout = rememberValue<WorkspaceLayout>(store, {restore: toWorkspaceLayout})
    let views: Record<string, unknown> = {}
    let current: RememberedLayoutState = CLOSED
    let isOpening = false
    const listeners = new Set<() => void>()

    /*
     * The published state is built here rather than subscribed from the layout, because it is two
     * keys and only one of them publishes. Following the layout's own notifications would announce
     * an open frame in the moment between the layout landing and the cursors being read.
     */
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
            // The layout is read first because it is what says which cursors are worth keeping.
            const stored = toScriptViews(
                await store.read(SCRIPT_VIEWS_KEY),
                opened.value.openScripts
            )
            views = {...stored}
            publish({isOpen: true, layout: opened.value, views: stored})
        },
        dispatch(action) {
            if (!current.isOpen) return
            // `change` answers with nothing, so the layout is read back: it skips a value the
            // reducer left alone, which is what makes this write exactly when the layout is
            // genuinely different rather than once per event.
            layout.change(previous => reduceLayout(previous, action))
            const changed = layout.state()
            if (!changed.isOpen || changed.value === current.layout) return
            publish({...current, layout: changed.value})

            // A closed tab's cursor is not worth keeping: it would grow the record for the life of
            // the project and be restored into a file the user is no longer editing.
            const kept = toScriptViews(views, changed.value.openScripts)
            if (Object.keys(kept).length === Object.keys(views).length) return
            views = {...kept}
            store.write(SCRIPT_VIEWS_KEY, kept)
        },
        recordView(path, view) {
            // Deliberately not published. A cursor moves on every keystroke, and the views are read
            // once when the editor mounts — a render per keystroke is a price the layout does not
            // have to pay to be remembered.
            views[path] = view
            store.write(SCRIPT_VIEWS_KEY, views)
        }
    }
}

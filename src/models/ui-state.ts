import type {GodotLogSeverity} from './godot'
import type {GodotSelection} from './workspace'

/** The centre column's views. */
export type CenterTab = 'chat' | 'scripts' | 'game' | 'docs'
/** The explorer column's views. */
export type ExplorerTab = 'scene' | 'runtime' | 'files'
/** The inspector column's views. */
export type InspectorTab = 'node' | 'project' | 'editor'
/** The bottom panel's views. */
export type BottomTab = 'problems' | 'debugger' | 'output' | 'import'
/** Whether the output panel follows the live session or searches the recorded history. */
export type LogScope = 'session' | 'history'

/**
 * The responsive contract's own numbers. They live here rather than in the frame because the
 * stored width has to be clamped to them: a project remembered under one contract must not
 * reopen a panel at a width the current one forbids.
 */
export const EXPLORER_WIDTH = 260
export const EXPLORER_MIN = 200
export const EXPLORER_MAX = 420
export const INSPECTOR_WIDTH = 380
export const INSPECTOR_MIN = 320
export const INSPECTOR_MAX = 480

/** A chosen node and the edited scene it was chosen in, which is what makes its path meaningful. */
export type ChosenNode = Readonly<{selection: GodotSelection; scene: string}>

/**
 * Everything the workspace remembers about how it was left, stored per project.
 *
 * These are choices about the work rather than about the machine — which scripts were open, which
 * panel was being read, how wide it was — so they belong to the project's own database and follow
 * it, instead of being one shared layout for every project the user has ever opened.
 */
export type WorkspaceLayout = Readonly<{
    centerTab: CenterTab
    explorerTab: ExplorerTab
    inspectorTab: InspectorTab
    bottomTab: BottomTab
    isBottomCollapsed: boolean
    explorerWidth: number
    inspectorWidth: number
    logSeverity: GodotLogSeverity
    logScope: LogScope
    /** Open script tabs, in the order they are shown. */
    openScripts: readonly string[]
    activeScript?: string | undefined
    /** One-based lines carrying a breakpoint, by workspace path. */
    breakpoints: Readonly<Record<string, readonly number[]>>
    selection?: ChosenNode | undefined
}>

/** Monaco's own view state — cursor, selection, scroll — by workspace path. Opaque on purpose. */
export type ScriptViews = Readonly<Record<string, unknown>>

export const DEFAULT_WORKSPACE_LAYOUT: WorkspaceLayout = {
    centerTab: 'chat',
    explorerTab: 'scene',
    inspectorTab: 'node',
    bottomTab: 'problems',
    isBottomCollapsed: false,
    explorerWidth: EXPLORER_WIDTH,
    inspectorWidth: INSPECTOR_WIDTH,
    logSeverity: 'info',
    logScope: 'session',
    openScripts: [],
    breakpoints: {}
}

const CENTER_TABS: readonly CenterTab[] = ['chat', 'scripts', 'game', 'docs']
const EXPLORER_TABS: readonly ExplorerTab[] = ['scene', 'runtime', 'files']
const INSPECTOR_TABS: readonly InspectorTab[] = ['node', 'project', 'editor']
const BOTTOM_TABS: readonly BottomTab[] = ['problems', 'debugger', 'output', 'import']
const LOG_SEVERITIES: readonly GodotLogSeverity[] = ['info', 'warning', 'error']
const LOG_SCOPES: readonly LogScope[] = ['session', 'history']
const SELECTION_ORIGINS: readonly GodotSelection['origin'][] = ['edited', 'runtime']
/** A layout is not a place to keep a working set: this caps what one project can reopen. */
const MAX_OPEN_SCRIPTS = 50
const MAX_BREAKPOINT_LINES = 500

function record(value: unknown): Readonly<Record<string, unknown>> {
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function oneOf<Value extends string>(
    value: unknown,
    allowed: readonly Value[],
    fallback: Value
): Value {
    return allowed.includes(value as Value) ? (value as Value) : fallback
}

function width(value: unknown, minimum: number, maximum: number, fallback: number) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
    return Math.min(Math.max(Math.round(value), minimum), maximum)
}

function paths(value: unknown) {
    if (!Array.isArray(value)) return []
    const listed = value.filter(entry => typeof entry === 'string' && entry !== '')
    return [...new Set<string>(listed)].slice(0, MAX_OPEN_SCRIPTS)
}

function lines(value: unknown) {
    if (!Array.isArray(value)) return []
    const listed = value.filter(
        (entry): entry is number =>
            typeof entry === 'number' && Number.isInteger(entry) && entry > 0
    )
    return [...new Set(listed)].slice(0, MAX_BREAKPOINT_LINES)
}

function breakpoints(value: unknown): Readonly<Record<string, readonly number[]>> {
    const entries = Object.entries(record(value))
        .map(([path, value_]) => [path, lines(value_)] as const)
        .filter(([, listed]) => listed.length > 0)
        .slice(0, MAX_OPEN_SCRIPTS)
    return Object.fromEntries(entries)
}

function selection(value: unknown): ChosenNode | undefined {
    const chosen = record(value)
    const scene = chosen['scene']
    const node = record(chosen['selection'])
    const {origin, path, name, type} = node
    if (
        typeof scene !== 'string'
        || typeof path !== 'string'
        || typeof name !== 'string'
        || typeof type !== 'string'
        || !SELECTION_ORIGINS.includes(origin as GodotSelection['origin'])
    ) {
        return undefined
    }
    return {scene, selection: {origin: origin as GodotSelection['origin'], path, name, type}}
}

/**
 * Reads a stored layout back into one the frame can mount with.
 *
 * Every field is checked rather than trusted. The stored value outlives the version of Gofer that
 * wrote it: a tab that no longer exists, a width the responsive contract no longer allows, and a
 * half-written record are all ordinary, and each one falls back to the default for that field
 * alone rather than discarding the rest of the layout.
 */
export function toWorkspaceLayout(value: unknown): WorkspaceLayout {
    const stored = record(value)
    const activeScript = stored['activeScript']
    const openScripts = paths(stored['openScripts'])
    return {
        centerTab: oneOf(stored['centerTab'], CENTER_TABS, DEFAULT_WORKSPACE_LAYOUT.centerTab),
        explorerTab: oneOf(
            stored['explorerTab'],
            EXPLORER_TABS,
            DEFAULT_WORKSPACE_LAYOUT.explorerTab
        ),
        inspectorTab: oneOf(
            stored['inspectorTab'],
            INSPECTOR_TABS,
            DEFAULT_WORKSPACE_LAYOUT.inspectorTab
        ),
        bottomTab: oneOf(stored['bottomTab'], BOTTOM_TABS, DEFAULT_WORKSPACE_LAYOUT.bottomTab),
        isBottomCollapsed: stored['isBottomCollapsed'] === true,
        explorerWidth: width(
            stored['explorerWidth'],
            EXPLORER_MIN,
            EXPLORER_MAX,
            DEFAULT_WORKSPACE_LAYOUT.explorerWidth
        ),
        inspectorWidth: width(
            stored['inspectorWidth'],
            INSPECTOR_MIN,
            INSPECTOR_MAX,
            DEFAULT_WORKSPACE_LAYOUT.inspectorWidth
        ),
        logSeverity: oneOf(
            stored['logSeverity'],
            LOG_SEVERITIES,
            DEFAULT_WORKSPACE_LAYOUT.logSeverity
        ),
        logScope: oneOf(stored['logScope'], LOG_SCOPES, DEFAULT_WORKSPACE_LAYOUT.logScope),
        openScripts,
        // A tab cannot be the active one unless it is open: a stored pair that disagrees would
        // leave the editor showing nothing with no way to notice why.
        ...(typeof activeScript === 'string'
            && openScripts.includes(activeScript) && {activeScript}),
        breakpoints: breakpoints(stored['breakpoints']),
        ...(selection(stored['selection']) && {selection: selection(stored['selection'])})
    }
}

/**
 * Every change to the layout that is a choice worth remembering.
 *
 * The two that carry no tab — `resized` and `scripts-changed` — are the layout catching up with a
 * value another hook owns. They are actions rather than reads so that the layout stays one value:
 * a snapshot assembled at write time from nine variables can hold a tab from before a drag beside
 * a width from after it, and this cannot.
 */
export type LayoutAction =
    | Readonly<{type: 'center-tab'; tab: CenterTab}>
    | Readonly<{type: 'explorer-tab'; tab: ExplorerTab}>
    | Readonly<{type: 'inspector-tab'; tab: InspectorTab}>
    | Readonly<{type: 'bottom-tab'; tab: BottomTab}>
    | Readonly<{type: 'bottom-toggled'}>
    /** Running the project shows the debugger, which is one change to the layout rather than two. */
    | Readonly<{type: 'debug-started'}>
    | Readonly<{type: 'log-severity'; severity: GodotLogSeverity}>
    | Readonly<{type: 'log-scope'; scope: LogScope}>
    /** A node was chosen, which is also what opens the inspector's node tab. */
    | Readonly<{type: 'node-chosen'; selection: GodotSelection; scene: string}>
    | Readonly<{type: 'resized'; explorerWidth: number; inspectorWidth: number}>
    | Readonly<{
          type: 'scripts-changed'
          openScripts: readonly string[]
          activeScript?: string | undefined
          breakpoints: Readonly<Record<string, readonly number[]>>
      }>

function sameOrder<Item>(left: readonly Item[], right: readonly Item[]) {
    return left.length === right.length && left.every((item, index) => item === right[index])
}

function sameBreakpoints(
    left: Readonly<Record<string, readonly number[]>>,
    right: Readonly<Record<string, readonly number[]>>
) {
    const marked = Object.keys(left)
    if (marked.length !== Object.keys(right).length) return false
    return marked.every(path => {
        const listed = right[path]
        return listed !== undefined && sameOrder(left[path] ?? [], listed)
    })
}

function sameSelection(left: ChosenNode | undefined, right: ChosenNode) {
    return (
        left?.scene === right.scene
        && left.selection.origin === right.selection.origin
        && left.selection.path === right.selection.path
        && left.selection.name === right.selection.name
        && left.selection.type === right.selection.type
    )
}

/**
 * How the workspace's layout moves, as a pure function.
 *
 * Every case answers with the state it was given when nothing actually changed. That is not an
 * optimisation: the layout's identity is what triggers the write to the project's database, and a
 * drag that ends on the width it started at, or a tab click on the tab already open, must not
 * count as the workspace having been left differently.
 */
export function reduceLayout(state: WorkspaceLayout, action: LayoutAction): WorkspaceLayout {
    switch (action.type) {
        case 'center-tab':
            return state.centerTab === action.tab ? state : {...state, centerTab: action.tab}

        case 'explorer-tab':
            return state.explorerTab === action.tab ? state : {...state, explorerTab: action.tab}

        case 'inspector-tab':
            return state.inspectorTab === action.tab ? state : {...state, inspectorTab: action.tab}

        case 'bottom-tab':
            return state.bottomTab === action.tab ? state : {...state, bottomTab: action.tab}

        case 'bottom-toggled':
            return {...state, isBottomCollapsed: !state.isBottomCollapsed}

        case 'debug-started':
            return state.bottomTab === 'debugger' && !state.isBottomCollapsed ?
                    state
                :   {...state, bottomTab: 'debugger', isBottomCollapsed: false}

        case 'log-severity':
            return state.logSeverity === action.severity ?
                    state
                :   {...state, logSeverity: action.severity}

        case 'log-scope':
            return state.logScope === action.scope ? state : {...state, logScope: action.scope}

        case 'node-chosen': {
            const chosen: ChosenNode = {selection: action.selection, scene: action.scene}
            if (state.inspectorTab === 'node' && sameSelection(state.selection, chosen))
                return state
            return {...state, inspectorTab: 'node', selection: chosen}
        }

        case 'resized':
            return (
                    state.explorerWidth === action.explorerWidth
                        && state.inspectorWidth === action.inspectorWidth
                ) ?
                    state
                :   {
                        ...state,
                        explorerWidth: action.explorerWidth,
                        inspectorWidth: action.inspectorWidth
                    }

        case 'scripts-changed': {
            if (
                state.activeScript === action.activeScript
                && sameOrder(state.openScripts, action.openScripts)
                && sameBreakpoints(state.breakpoints, action.breakpoints)
            ) {
                return state
            }
            return {
                ...state,
                openScripts: action.openScripts,
                breakpoints: action.breakpoints,
                activeScript: action.activeScript
            }
        }
    }
}

/** Keeps only the view states of files that still have a tab, so the record cannot grow forever. */
export function toScriptViews(value: unknown, openScripts: readonly string[]): ScriptViews {
    return Object.fromEntries(
        Object.entries(record(value)).filter(
            ([path, state]) => openScripts.includes(path) && state !== null && state !== undefined
        )
    )
}

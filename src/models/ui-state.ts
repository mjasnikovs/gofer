import type {GodotLogSeverity} from './godot'
import type {GodotSelection} from './workspace'

export type CenterTab = 'chat' | 'scripts' | 'game' | 'docs' | 'memory' | 'sketches' | 'skills'
export type ExplorerTab = 'scene' | 'runtime' | 'files'
export type InspectorTab = 'node' | 'project' | 'editor'
export type BottomTab = 'problems' | 'debugger' | 'output' | 'import'
export type LogScope = 'session' | 'history'

export const EXPLORER_WIDTH = 260
export const EXPLORER_MIN = 200
export const EXPLORER_MAX = 420
export const INSPECTOR_WIDTH = 380
export const INSPECTOR_MIN = 320
export const INSPECTOR_MAX = 480
export const SIDE_NAV_WIDTH = 280
export const SIDE_NAV_MIN = 220
export const SIDE_NAV_MAX = 400

export type SideNavLayout = Readonly<{
    isCollapsed: boolean
    width: number
}>

export const DEFAULT_SIDE_NAV_LAYOUT: SideNavLayout = {
    isCollapsed: false,
    width: SIDE_NAV_WIDTH
}

export type ChosenNode = Readonly<{
    selection: GodotSelection
    scene: string
    runtimeEpoch: number
}>

export function nodeStillChosen(
    chosen: ChosenNode | undefined,
    against: Readonly<{scene: string; runtimeEpoch: number}>
): GodotSelection | undefined {
    if (chosen === undefined) return undefined
    const belongsTo =
        chosen.selection.origin === 'edited' ?
            chosen.scene === against.scene
        :   chosen.runtimeEpoch === against.runtimeEpoch
    return belongsTo ? chosen.selection : undefined
}

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
    openScripts: readonly string[]
    activeScript?: string | undefined
    breakpoints: Readonly<Record<string, readonly number[]>>
    selection?: ChosenNode | undefined
}>

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

const CENTER_TABS: readonly CenterTab[] = [
    'chat',
    'scripts',
    'game',
    'docs',
    'memory',
    'sketches',
    'skills'
]
const EXPLORER_TABS: readonly ExplorerTab[] = ['scene', 'runtime', 'files']
const INSPECTOR_TABS: readonly InspectorTab[] = ['node', 'project', 'editor']
const BOTTOM_TABS: readonly BottomTab[] = ['problems', 'debugger', 'output', 'import']
const LOG_SEVERITIES: readonly GodotLogSeverity[] = ['info', 'warning', 'error']
const LOG_SCOPES: readonly LogScope[] = ['session', 'history']
const SELECTION_ORIGINS: readonly GodotSelection['origin'][] = ['edited', 'runtime']
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
    if (origin === 'runtime') return undefined
    return {
        scene,
        runtimeEpoch: 0,
        selection: {origin: origin as GodotSelection['origin'], path, name, type}
    }
}

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
        ...(typeof activeScript === 'string'
            && openScripts.includes(activeScript) && {activeScript}),
        breakpoints: breakpoints(stored['breakpoints']),
        ...(selection(stored['selection']) && {selection: selection(stored['selection'])})
    }
}

export function isSideNavWidth(value: number) {
    return Number.isFinite(value) && value >= SIDE_NAV_MIN && value <= SIDE_NAV_MAX
}

export function toSideNavLayout(value: unknown): SideNavLayout {
    const stored = record(value)
    return {
        isCollapsed: stored['isCollapsed'] === true,
        width: width(stored['width'], SIDE_NAV_MIN, SIDE_NAV_MAX, SIDE_NAV_WIDTH)
    }
}

export type LayoutAction =
    | Readonly<{type: 'center-tab'; tab: CenterTab}>
    | Readonly<{type: 'explorer-tab'; tab: ExplorerTab}>
    | Readonly<{type: 'inspector-tab'; tab: InspectorTab}>
    | Readonly<{type: 'bottom-tab'; tab: BottomTab}>
    | Readonly<{type: 'bottom-toggled'}>
    | Readonly<{type: 'debug-started'}>
    | Readonly<{type: 'log-severity'; severity: GodotLogSeverity}>
    | Readonly<{type: 'log-scope'; scope: LogScope}>
    | Readonly<{
          type: 'node-chosen'
          selection: GodotSelection
          scene: string
          runtimeEpoch: number
      }>
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
        && left.runtimeEpoch === right.runtimeEpoch
        && left.selection.origin === right.selection.origin
        && left.selection.path === right.selection.path
        && left.selection.name === right.selection.name
        && left.selection.type === right.selection.type
    )
}

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
            const chosen: ChosenNode = {
                selection: action.selection,
                scene: action.scene,
                runtimeEpoch: action.runtimeEpoch
            }
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

export function toScriptViews(value: unknown, openScripts: readonly string[]): ScriptViews {
    return Object.fromEntries(
        Object.entries(record(value)).filter(
            ([path, state]) => openScripts.includes(path) && state !== null && state !== undefined
        )
    )
}

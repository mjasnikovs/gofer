import {describe, expect, it} from 'vitest'
import {
    DEFAULT_SIDE_NAV_LAYOUT,
    DEFAULT_WORKSPACE_LAYOUT,
    EXPLORER_MAX,
    INSPECTOR_MIN,
    SIDE_NAV_MAX,
    SIDE_NAV_MIN,
    isSideNavWidth,
    nodeStillChosen,
    reduceLayout,
    toScriptViews,
    toSideNavLayout,
    toWorkspaceLayout
} from './ui-state'
import type {LayoutAction, WorkspaceLayout} from './ui-state'

const STORED = {
    centerTab: 'scripts',
    explorerTab: 'files',
    inspectorTab: 'project',
    bottomTab: 'output',
    isBottomCollapsed: true,
    explorerWidth: 320,
    inspectorWidth: 400,
    logSeverity: 'error',
    logScope: 'history',
    openScripts: ['scripts/player.gd', 'scripts/enemy.gd'],
    activeScript: 'scripts/enemy.gd',
    breakpoints: {'scripts/player.gd': [3, 11]},
    selection: {
        scene: 'res://main.tscn',
        runtimeEpoch: 0,
        selection: {origin: 'edited', path: 'Main/Player', name: 'Player', type: 'Node2D'}
    }
}

describe('toWorkspaceLayout', () => {
    it('reads back a layout it wrote', () => {
        expect(toWorkspaceLayout(STORED)).toEqual(STORED)
    })

    it('opens on the defaults when the project has never been left', () => {
        expect(toWorkspaceLayout(undefined)).toEqual(DEFAULT_WORKSPACE_LAYOUT)
        expect(toWorkspaceLayout('not a layout')).toEqual(DEFAULT_WORKSPACE_LAYOUT)
    })

    /*
     * A tab is two lists, and forgetting the second is silent.
     *
     * The union is what the compiler checks and the array is what a stored value is checked
     * against. A tab added to one and not the other type-checks, renders, and then resets itself to
     * Chat the next time the project is opened — which reads as the window losing its place.
     */
    it('remembers every tab the centre column has', () => {
        for (const tab of ['chat', 'scripts', 'game', 'docs', 'memory', 'sketches'] as const)
            expect(toWorkspaceLayout({...STORED, centerTab: tab}).centerTab).toBe(tab)
    })

    /*
     * The stored value outlives the version that wrote it. A tab that has since been removed, a
     * width the responsive contract no longer allows, and a half-written record all reach this,
     * and none of them is a reason to throw the rest of the layout away.
     */
    it('falls back field by field rather than discarding the layout', () => {
        const layout = toWorkspaceLayout({
            ...STORED,
            centerTab: 'terminal',
            logSeverity: 'trace',
            explorerWidth: 9000,
            inspectorWidth: 10
        })

        expect(layout.centerTab).toBe('chat')
        expect(layout.logSeverity).toBe('info')
        expect(layout.explorerWidth).toBe(EXPLORER_MAX)
        expect(layout.inspectorWidth).toBe(INSPECTOR_MIN)
        // Everything that was readable is still there.
        expect(layout.explorerTab).toBe('files')
        expect(layout.openScripts).toEqual(STORED.openScripts)
    })

    /** A tab that is not open cannot be the active one, or the editor opens showing nothing. */
    it('drops an active script that no tab holds', () => {
        expect(
            toWorkspaceLayout({...STORED, activeScript: 'scripts/gone.gd'}).activeScript
        ).toBeUndefined()
    })

    it('keeps only breakpoints that name real lines', () => {
        expect(
            toWorkspaceLayout({
                ...STORED,
                breakpoints: {
                    'scripts/player.gd': [3, 3, 0, -2, 'four', 11],
                    'scripts/empty.gd': []
                }
            }).breakpoints
        ).toEqual({'scripts/player.gd': [3, 11]})
    })

    it('refuses a half-written selection instead of restoring a node with no name', () => {
        expect(
            toWorkspaceLayout({...STORED, selection: {scene: 'res://main.tscn'}}).selection
        ).toBeUndefined()
        expect(
            toWorkspaceLayout({
                ...STORED,
                selection: {
                    ...STORED.selection,
                    selection: {...STORED.selection.selection, origin: 'saved'}
                }
            }).selection
        ).toBeUndefined()
    })
})

describe('toSideNavLayout', () => {
    it('reads back a sidebar left closed and narrowed', () => {
        expect(toSideNavLayout({isCollapsed: true, width: 240})).toEqual({
            isCollapsed: true,
            width: 240
        })
    })

    it('opens at the default when the project has never stored one', () => {
        expect(toSideNavLayout(undefined)).toEqual(DEFAULT_SIDE_NAV_LAYOUT)
        expect(toSideNavLayout('not a sidebar')).toEqual(DEFAULT_SIDE_NAV_LAYOUT)
        expect(toSideNavLayout({isCollapsed: 'yes'})).toEqual(DEFAULT_SIDE_NAV_LAYOUT)
    })

    it('holds a stored width inside what the sidebar allows today', () => {
        expect(toSideNavLayout({width: 20}).width).toBe(SIDE_NAV_MIN)
        expect(toSideNavLayout({width: 9000}).width).toBe(SIDE_NAV_MAX)
    })

    // The resize hook reports a width before the nav has one, and a stored 0 would reopen every
    // project at the minimum.
    it('refuses a width the sidebar cannot have', () => {
        expect(isSideNavWidth(0)).toBe(false)
        expect(isSideNavWidth(Number.NaN)).toBe(false)
        expect(isSideNavWidth(SIDE_NAV_MIN - 1)).toBe(false)
        expect(isSideNavWidth(SIDE_NAV_MAX + 1)).toBe(false)
        expect(isSideNavWidth(SIDE_NAV_MIN)).toBe(true)
        expect(isSideNavWidth(300)).toBe(true)
    })
})

describe('toScriptViews', () => {
    /** A cursor kept for a file with no tab would grow the record for the life of the project. */
    it('keeps only the cursors of files that still have a tab', () => {
        expect(
            toScriptViews(
                {'scripts/player.gd': {cursorLine: 4}, 'scripts/gone.gd': {cursorLine: 9}},
                ['scripts/player.gd']
            )
        ).toEqual({'scripts/player.gd': {cursorLine: 4}})
    })

    it('answers with nothing when nothing was stored', () => {
        expect(toScriptViews(undefined, ['scripts/player.gd'])).toEqual({})
    })
})

/** Applies a run of actions in order, which is the only way a layout ever reaches a state. */
function apply(...actions: readonly LayoutAction[]): WorkspaceLayout {
    return actions.reduce(reduceLayout, DEFAULT_WORKSPACE_LAYOUT)
}

const NODE = {origin: 'edited', path: '/Main/Player', name: 'Player', type: 'Node2D'} as const

describe('reduceLayout', () => {
    it('moves each tab on its own without disturbing the others', () => {
        const moved = apply(
            {type: 'center-tab', tab: 'game'},
            {type: 'explorer-tab', tab: 'files'},
            {type: 'inspector-tab', tab: 'editor'},
            {type: 'bottom-tab', tab: 'output'}
        )
        expect(moved.centerTab).toBe('game')
        expect(moved.explorerTab).toBe('files')
        expect(moved.inspectorTab).toBe('editor')
        expect(moved.bottomTab).toBe('output')
    })

    /*
     * The layout's identity is what triggers the write to the project's database. A tab click on
     * the tab already open must therefore answer with the same value, or every idle click records
     * the workspace as having been left differently.
     */
    it('answers with the same value when a choice does not change', () => {
        expect(reduceLayout(DEFAULT_WORKSPACE_LAYOUT, {type: 'center-tab', tab: 'chat'})).toBe(
            DEFAULT_WORKSPACE_LAYOUT
        )
        expect(reduceLayout(DEFAULT_WORKSPACE_LAYOUT, {type: 'log-scope', scope: 'session'})).toBe(
            DEFAULT_WORKSPACE_LAYOUT
        )
        expect(
            reduceLayout(DEFAULT_WORKSPACE_LAYOUT, {
                type: 'resized',
                explorerWidth: DEFAULT_WORKSPACE_LAYOUT.explorerWidth,
                inspectorWidth: DEFAULT_WORKSPACE_LAYOUT.inspectorWidth
            })
        ).toBe(DEFAULT_WORKSPACE_LAYOUT)
    })

    it('collapses and reopens the bottom panel', () => {
        expect(apply({type: 'bottom-toggled'}).isBottomCollapsed).toBe(true)
        expect(apply({type: 'bottom-toggled'}, {type: 'bottom-toggled'}).isBottomCollapsed).toBe(
            false
        )
    })

    /** Running the project is one change, so a collapsed panel cannot hide the debugger it opens. */
    it('shows the debugger and reopens the panel when the project runs', () => {
        const running = apply(
            {type: 'bottom-tab', tab: 'output'},
            {type: 'bottom-toggled'},
            {type: 'debug-started'}
        )
        expect(running.bottomTab).toBe('debugger')
        expect(running.isBottomCollapsed).toBe(false)
    })

    it('opens the node tab with the node that was chosen', () => {
        const chosen = apply(
            {type: 'inspector-tab', tab: 'project'},
            {type: 'node-chosen', selection: NODE, scene: 'res://main.tscn', runtimeEpoch: 0}
        )
        expect(chosen.inspectorTab).toBe('node')
        expect(chosen.selection).toEqual({
            selection: NODE,
            scene: 'res://main.tscn',
            runtimeEpoch: 0
        })
    })

    /** Re-clicking the node already selected is a no-op, not a fresh record of the same choice. */
    it('answers with the same value when the same node is chosen again', () => {
        const chosen = apply({
            type: 'node-chosen',
            selection: NODE,
            scene: 'res://main.tscn',
            runtimeEpoch: 0
        })
        expect(
            reduceLayout(chosen, {
                type: 'node-chosen',
                selection: {...NODE},
                scene: 'res://main.tscn',
                runtimeEpoch: 0
            })
        ).toBe(chosen)
    })

    it('treats the same node in another scene as a different choice', () => {
        const chosen = apply({
            type: 'node-chosen',
            selection: NODE,
            scene: 'res://main.tscn',
            runtimeEpoch: 0
        })
        expect(
            reduceLayout(chosen, {
                type: 'node-chosen',
                selection: NODE,
                scene: 'res://level.tscn',
                runtimeEpoch: 0
            })
        ).not.toBe(chosen)
    })

    it('records both panel widths together', () => {
        const dragged = apply({type: 'resized', explorerWidth: 300, inspectorWidth: 420})
        expect(dragged.explorerWidth).toBe(300)
        expect(dragged.inspectorWidth).toBe(420)
    })

    it('follows the open scripts, the active one, and its breakpoints', () => {
        const edited = apply({
            type: 'scripts-changed',
            openScripts: ['scripts/player.gd', 'scripts/enemy.gd'],
            activeScript: 'scripts/enemy.gd',
            breakpoints: {'scripts/player.gd': [4, 9]}
        })
        expect(edited.openScripts).toEqual(['scripts/player.gd', 'scripts/enemy.gd'])
        expect(edited.activeScript).toBe('scripts/enemy.gd')
        expect(edited.breakpoints).toEqual({'scripts/player.gd': [4, 9]})
    })

    /*
     * The open scripts arrive as a fresh array on every render of the frame. Comparing by identity
     * would make each render a change, and a debounced write that never settles.
     */
    it('answers with the same value when the scripts are equal but newly built', () => {
        const edited = apply({
            type: 'scripts-changed',
            openScripts: ['scripts/player.gd'],
            activeScript: 'scripts/player.gd',
            breakpoints: {'scripts/player.gd': [4]}
        })
        expect(
            reduceLayout(edited, {
                type: 'scripts-changed',
                openScripts: ['scripts/player.gd'],
                activeScript: 'scripts/player.gd',
                breakpoints: {'scripts/player.gd': [4]}
            })
        ).toBe(edited)
    })

    it('notices a breakpoint added to a script that already had one', () => {
        const edited = apply({
            type: 'scripts-changed',
            openScripts: ['scripts/player.gd'],
            breakpoints: {'scripts/player.gd': [4]}
        })
        const more = reduceLayout(edited, {
            type: 'scripts-changed',
            openScripts: ['scripts/player.gd'],
            breakpoints: {'scripts/player.gd': [4, 9]}
        })
        expect(more).not.toBe(edited)
        expect(more.breakpoints).toEqual({'scripts/player.gd': [4, 9]})
    })

    it('notices a breakpoint moved to another script', () => {
        const edited = apply({
            type: 'scripts-changed',
            openScripts: ['scripts/player.gd', 'scripts/enemy.gd'],
            breakpoints: {'scripts/player.gd': [4]}
        })
        expect(
            reduceLayout(edited, {
                type: 'scripts-changed',
                openScripts: ['scripts/player.gd', 'scripts/enemy.gd'],
                breakpoints: {'scripts/enemy.gd': [4]}
            })
        ).not.toBe(edited)
    })

    /** Closing the last tab leaves no active script, which is not the same as leaving the old one. */
    it('forgets the active script when the last tab is closed', () => {
        const edited = apply(
            {
                type: 'scripts-changed',
                openScripts: ['scripts/player.gd'],
                activeScript: 'scripts/player.gd',
                breakpoints: {}
            },
            {type: 'scripts-changed', openScripts: [], breakpoints: {}}
        )
        expect(edited.activeScript).toBeUndefined()
        expect(edited.openScripts).toEqual([])
    })

    /** What is stored has to survive being read back, or the layout is remembered as something else. */
    it('answers with a layout the reader accepts unchanged', () => {
        const moved = apply(
            {type: 'center-tab', tab: 'docs'},
            {type: 'explorer-tab', tab: 'runtime'},
            {type: 'bottom-toggled'},
            {type: 'log-severity', severity: 'error'},
            {type: 'resized', explorerWidth: 300, inspectorWidth: 420},
            {type: 'node-chosen', selection: NODE, scene: 'res://main.tscn', runtimeEpoch: 0},
            {
                type: 'scripts-changed',
                openScripts: ['scripts/player.gd'],
                activeScript: 'scripts/player.gd',
                breakpoints: {'scripts/player.gd': [4]}
            }
        )
        expect(toWorkspaceLayout(JSON.parse(JSON.stringify(moved)))).toEqual(moved)
    })
})

/**
 * A node path is only a path. What it names is decided by the scene the editor has open, or by the
 * run of the game it was read out of, and neither of those is the same thing an hour later.
 */
describe('nodeStillChosen', () => {
    const at = {scene: 'res://main.tscn', runtimeEpoch: 3}
    const edited = {selection: NODE, scene: 'res://main.tscn', runtimeEpoch: 0}
    const RUNTIME_NODE = {...NODE, origin: 'runtime' as const}
    const runtime = {selection: RUNTIME_NODE, scene: 'res://main.tscn', runtimeEpoch: 3}

    it('gives back nothing when nothing was chosen', () => {
        expect(nodeStillChosen(undefined, at)).toBeUndefined()
    })

    it('keeps an edited node while the editor still has that scene open', () => {
        expect(nodeStillChosen(edited, at)).toBe(NODE)
    })

    /** The addon answers `Node Main/Player was not found`, which is right and unanswerable. */
    it('retires an edited node the moment the editor opens another scene', () => {
        expect(nodeStillChosen(edited, {...at, scene: 'res://level.tscn'})).toBeUndefined()
    })

    it('keeps a runtime node while it is the same game it was read from', () => {
        expect(nodeStillChosen(runtime, at)).toBe(RUNTIME_NODE)
    })

    /** A node in a running game is a live object; the game after a restart has its own. */
    it('retires a runtime node when the game it belonged to ends', () => {
        expect(nodeStillChosen(runtime, {...at, runtimeEpoch: 4})).toBeUndefined()
    })

    /** The scene it was read beside is not what makes a runtime node mean anything. */
    it('keeps a runtime node across a scene the editor opened underneath it', () => {
        expect(nodeStillChosen(runtime, {...at, scene: 'res://level.tscn'})).toBe(RUNTIME_NODE)
    })

    /**
     * A project reopens with no game running, so a stored runtime node names an object in a game
     * that ended when the window closed. It is dropped on the way in rather than retired later.
     */
    it('is never given a runtime node by a stored layout', () => {
        const stored = toWorkspaceLayout({
            ...STORED,
            selection: {scene: 'res://main.tscn', selection: RUNTIME_NODE}
        })
        expect(stored.selection).toBeUndefined()
    })
})

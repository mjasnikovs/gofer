import {describe, expect, it} from 'vitest'
import {
    DEFAULT_WORKSPACE_LAYOUT,
    EXPLORER_MAX,
    INSPECTOR_MIN,
    toScriptViews,
    toWorkspaceLayout
} from './ui-state'

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

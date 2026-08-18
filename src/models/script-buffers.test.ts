import {describe, expect, it} from 'vitest'
import {NO_SCRIPT_TABS, reduceScriptTabs} from './script-buffers'
import type {ScriptTabs, ScriptTabsAction} from './script-buffers'
import type {ScriptDocument, ScriptStamp} from './script'

/** Applies a run of actions in order, which is the only way the tabs ever reach a state. */
function apply(...actions: readonly ScriptTabsAction[]): ScriptTabs {
    return actions.reduce(reduceScriptTabs, NO_SCRIPT_TABS)
}

function document(path: string, text: string, version = 1): ScriptDocument {
    return {path, text, hash: `hash-${String(version)}`, bytes: text.length, version}
}

function stamp(path: string, version: number): ScriptStamp {
    return {path, hash: `hash-${String(version)}`, version}
}

const PLAYER = document('player.gd', 'extends Node\n')
const ENEMY = document('enemy.gd', 'extends Node2D\n')

const opened = apply({type: 'opened', document: PLAYER, activate: true})

function buffer(tabs: ScriptTabs, path: string) {
    return tabs.buffers.find(entry => entry.path === path)
}

describe('opening and closing', () => {
    it('opens a file as a clean buffer holding the hash it must replace', () => {
        expect(buffer(opened, 'player.gd')).toMatchObject({
            text: 'extends Node\n',
            savedText: 'extends Node\n',
            hash: 'hash-1',
            version: 1,
            dirty: false
        })
        expect(opened.activePath).toBe('player.gd')
    })

    it('opens a second file without disturbing the first', () => {
        const two = reduceScriptTabs(opened, {type: 'opened', document: ENEMY, activate: true})
        expect(two.buffers.map(entry => entry.path)).toEqual(['player.gd', 'enemy.gd'])
        expect(two.activePath).toBe('enemy.gd')
    })

    /** A background reopen — the watcher noticing a file changed — must not steal the tab. */
    it('leaves the reading where it is when a file opens quietly', () => {
        const two = reduceScriptTabs(opened, {type: 'opened', document: ENEMY, activate: false})
        expect(two.activePath).toBe('player.gd')
    })

    it('replaces a file already open rather than opening a second tab for it', () => {
        const reloaded = reduceScriptTabs(opened, {
            type: 'opened',
            document: document('player.gd', 'extends CharacterBody2D\n', 4),
            activate: true
        })
        expect(reloaded.buffers).toHaveLength(1)
        expect(buffer(reloaded, 'player.gd')?.version).toBe(4)
    })

    /*
     * A breakpoint belongs to the line the user set it on. A reload is this same action, so
     * dropping them here would silently clear the gutter of every file that changed on disk.
     */
    it('keeps the breakpoints when a file is reopened', () => {
        const reloaded = apply(
            {type: 'opened', document: PLAYER, activate: true},
            {type: 'breakpoint-toggled', path: 'player.gd', line: 3},
            {type: 'opened', document: document('player.gd', 'extends Node2D\n', 2), activate: true}
        )
        expect(buffer(reloaded, 'player.gd')?.breakpoints).toEqual([3])
    })

    it('gives a file back the breakpoints the stored layout was holding for it', () => {
        const restored = apply({
            type: 'opened',
            document: PLAYER,
            restored: [4, 9],
            activate: true
        })
        expect(buffer(restored, 'player.gd')?.breakpoints).toEqual([4, 9])
    })

    it('moves to the last remaining tab when the one being read is closed', () => {
        const closed = apply(
            {type: 'opened', document: PLAYER, activate: true},
            {type: 'opened', document: ENEMY, activate: true},
            {type: 'closed', path: 'enemy.gd'}
        )
        expect(closed.activePath).toBe('player.gd')
        expect(closed.buffers).toHaveLength(1)
    })

    it('leaves the reading alone when some other tab is closed', () => {
        const closed = apply(
            {type: 'opened', document: PLAYER, activate: true},
            {type: 'opened', document: ENEMY, activate: true},
            {type: 'closed', path: 'player.gd'}
        )
        expect(closed.activePath).toBe('enemy.gd')
    })

    it('leaves nothing being read when the last tab closes', () => {
        expect(
            reduceScriptTabs(opened, {type: 'closed', path: 'player.gd'}).activePath
        ).toBeUndefined()
    })
})

describe('editing and writing', () => {
    it('marks a buffer dirty the moment it differs from what is on disk', () => {
        const typed = reduceScriptTabs(opened, {
            type: 'edited',
            path: 'player.gd',
            text: 'extends Node2D\n'
        })
        expect(buffer(typed, 'player.gd')?.dirty).toBe(true)
    })

    /** Typing back to what was saved is not an edit worth a write. */
    it('goes clean again when the text is typed back to what was saved', () => {
        const undone = apply(
            {type: 'opened', document: PLAYER, activate: true},
            {type: 'edited', path: 'player.gd', text: 'extends Node2D\n'},
            {type: 'edited', path: 'player.gd', text: 'extends Node\n'}
        )
        expect(buffer(undone, 'player.gd')?.dirty).toBe(false)
    })

    /*
     * A sync is the server catching up with text the buffer already holds. Taking anything but the
     * version from it would undo whatever was typed while the request was in flight.
     */
    it('takes only the document version from a sync', () => {
        const synced = apply(
            {type: 'opened', document: PLAYER, activate: true},
            {type: 'edited', path: 'player.gd', text: 'extends Node2D\n'},
            {type: 'synced', path: 'player.gd', version: 2}
        )
        expect(buffer(synced, 'player.gd')).toMatchObject({
            text: 'extends Node2D\n',
            version: 2,
            dirty: true
        })
    })

    it('goes clean on a save and takes the hash the next write must quote', () => {
        const saved = apply(
            {type: 'opened', document: PLAYER, activate: true},
            {type: 'edited', path: 'player.gd', text: 'extends Node2D\n'},
            {
                type: 'saved',
                path: 'player.gd',
                text: 'extends Node2D\n',
                stamp: stamp('player.gd', 3)
            }
        )
        expect(buffer(saved, 'player.gd')).toMatchObject({
            dirty: false,
            hash: 'hash-3',
            version: 3,
            conflict: undefined
        })
    })

    /** A keystroke landing while the write was in flight leaves the tab dirty, which it is. */
    it('stays dirty when the buffer moved on while the save was in flight', () => {
        const saved = apply(
            {type: 'opened', document: PLAYER, activate: true},
            {type: 'edited', path: 'player.gd', text: 'extends Node2D\n'},
            {type: 'edited', path: 'player.gd', text: 'extends Node2D\nvar speed := 1.0\n'},
            {
                type: 'saved',
                path: 'player.gd',
                text: 'extends Node2D\n',
                stamp: stamp('player.gd', 3)
            }
        )
        expect(buffer(saved, 'player.gd')?.dirty).toBe(true)
    })
})

describe('conflicts', () => {
    /** A conflict warns; it does not choose a side. Both answers to it need the user's text. */
    it('keeps the edited text when a save is refused as stale', () => {
        const refused = apply(
            {type: 'opened', document: PLAYER, activate: true},
            {type: 'edited', path: 'player.gd', text: 'extends Node2D\n'},
            {type: 'conflicted', path: 'player.gd', conflict: 'staleSave'}
        )
        expect(buffer(refused, 'player.gd')).toMatchObject({
            text: 'extends Node2D\n',
            dirty: true,
            conflict: 'staleSave'
        })
    })

    it('overwriting writes the buffer and clears the conflict', () => {
        const overwritten = apply(
            {type: 'opened', document: PLAYER, activate: true},
            {type: 'edited', path: 'player.gd', text: 'extends Node2D\n'},
            {type: 'conflicted', path: 'player.gd', conflict: 'staleSave'},
            {
                type: 'overwritten',
                path: 'player.gd',
                text: 'extends Node2D\n',
                stamp: stamp('player.gd', 5)
            }
        )
        expect(buffer(overwritten, 'player.gd')).toMatchObject({
            text: 'extends Node2D\n',
            savedText: 'extends Node2D\n',
            dirty: false,
            conflict: undefined,
            version: 5
        })
    })
})

describe('breakpoints', () => {
    it('sets a breakpoint and takes it off again', () => {
        const set = reduceScriptTabs(opened, {
            type: 'breakpoint-toggled',
            path: 'player.gd',
            line: 3
        })
        expect(buffer(set, 'player.gd')?.breakpoints).toEqual([3])
        expect(
            buffer(
                reduceScriptTabs(set, {type: 'breakpoint-toggled', path: 'player.gd', line: 3}),
                'player.gd'
            )?.breakpoints
        ).toEqual([])
    })
})

describe('renaming', () => {
    it('takes the transaction text into every tab it rewrote, clean', () => {
        const renamed = apply(
            {type: 'opened', document: PLAYER, activate: true},
            {type: 'opened', document: ENEMY, activate: true},
            {
                type: 'renamed',
                files: [
                    {
                        path: 'player.gd',
                        originalText: 'extends Node\n',
                        originalHash: 'hash-1',
                        updatedText: 'extends Node\nfunc start():\n\tpass\n'
                    }
                ],
                stamps: [stamp('player.gd', 7)]
            }
        )
        expect(buffer(renamed, 'player.gd')).toMatchObject({
            text: 'extends Node\nfunc start():\n\tpass\n',
            dirty: false,
            version: 7
        })
        // A file the transaction did not touch is left exactly as it was.
        expect(buffer(renamed, 'enemy.gd')?.text).toBe('extends Node2D\n')
    })

    /** No stamp means no version, and the next edit would be sent under a number nobody knows. */
    it('leaves a rewritten file alone when the transaction answered with no version for it', () => {
        const renamed = apply(
            {type: 'opened', document: PLAYER, activate: true},
            {
                type: 'renamed',
                files: [
                    {
                        path: 'player.gd',
                        originalText: 'extends Node\n',
                        originalHash: 'hash-1',
                        updatedText: 'rewritten\n'
                    }
                ],
                stamps: []
            }
        )
        expect(buffer(renamed, 'player.gd')?.text).toBe('extends Node\n')
    })
})

describe('reopening a project', () => {
    /** The stored active tab may name one of the files that no longer opens. */
    it('falls back to the last tab that opened when the stored one did not', () => {
        const reopened = reduceScriptTabs(
            {buffers: [], activePath: 'deleted.gd'},
            {type: 'reopened', opened: ['player.gd', 'enemy.gd']}
        )
        expect(reopened.activePath).toBe('enemy.gd')
    })

    it('keeps the stored tab when it did open', () => {
        const reopened = reduceScriptTabs(
            {buffers: [], activePath: 'player.gd'},
            {type: 'reopened', opened: ['player.gd', 'enemy.gd']}
        )
        expect(reopened.activePath).toBe('player.gd')
    })

    it('leaves nothing being read when none of the stored tabs opened', () => {
        expect(
            reduceScriptTabs(
                {buffers: [], activePath: 'deleted.gd'},
                {type: 'reopened', opened: []}
            ).activePath
        ).toBeUndefined()
    })
})

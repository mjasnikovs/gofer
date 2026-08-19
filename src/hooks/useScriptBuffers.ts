import {useCallback, useEffect, useReducer, useRef, useState} from 'react'
import {schedule} from '../services/clock'
import {isTauri} from '../services/desktop'
import {
    applyScriptRename,
    callScriptLanguage,
    closeScriptDocument,
    formatGdscript,
    openScriptDocument,
    saveScriptDocument,
    subscribeScriptDiagnostics,
    toScriptError,
    unsubscribeScriptDiagnostics,
    updateScriptDocument
} from '../services/script-session'
import {
    listWorkspaceFiles,
    subscribeWorkspaceChanges,
    unsubscribeWorkspaceChanges
} from '../services/workspace-files'
import {NO_SCRIPT_TABS, reduceScriptTabs} from '../models/script-buffers'
import type {ScriptBuffer} from '../models/script-buffers'
import type {
    PlannedScriptFile,
    ScriptDiagnostic,
    ScriptPosition,
    WorkspaceEntry
} from '../models/script'

export type {ScriptBuffer, ScriptBufferConflict} from '../models/script-buffers'

export type FormatPreview = Readonly<{
    path: string
    original: string
    formatted: string
    changed: boolean
}>

export type RenamePreview = Readonly<{
    path: string
    newName: string
    files: readonly PlannedScriptFile[]
}>

/** The script tabs a project was left with, as they were stored. */
export type ScriptRestore = Readonly<{
    openScripts: readonly string[]
    activeScript?: string | undefined
    breakpoints: Readonly<Record<string, readonly number[]>>
}>

type ScriptBufferOptions = Readonly<{
    onError: (message: string) => void
    /** What to reopen at mount. Read once: it is where the project was left, not where it is. */
    restore?: ScriptRestore | undefined
    /**
     * Called when a buffer operation succeeds, so a failure already on screen can be taken down.
     *
     * Without it the frame's banner is not a report of what just happened but a record of the first
     * thing that ever went wrong: a save conflict resolved twenty minutes ago still says the file
     * could not be saved, through every later save, every tab, and every task.
     */
    onResolved?: (() => void) | undefined
}>

/** Everything the workspace's script surfaces share: one set of buffers, owned by the frame. */
export type ScriptBuffers = ReturnType<typeof useScriptBuffers>

/** Keystrokes are batched before `didChange`: the server answers from the editor's main loop. */
const CHANGE_DEBOUNCE_MS = 250

/**
 * Owns every open script buffer: its text, the hash it expects on disk, the language server's
 * document version, its breakpoints, and its conflict state.
 *
 * The rule the whole hook exists to keep is that one file has exactly one document version.
 * Rust assigns it — on open, on every debounced change, and on save — so a UI edit and an AI edit
 * of the same file cannot leave two versions of the truth behind.
 */
export function useScriptBuffers({onError, onResolved, restore}: ScriptBufferOptions) {
    const [tabs, dispatch] = useReducer(reduceScriptTabs, {
        ...NO_SCRIPT_TABS,
        ...(restore?.activeScript !== undefined && {activePath: restore.activeScript})
    })
    const {activePath, buffers} = tabs
    const [files, setFiles] = useState<readonly WorkspaceEntry[]>([])
    const [diagnostics, setDiagnostics] = useState<Readonly<Record<string, ScriptDiagnostic[]>>>({})
    // One way to call off the pending sync of each edited file, keyed by that file's path.
    const changeDelays = useRef(new Map<string, () => void>())
    const isFollowingDiagnostics = useRef(false)
    // The external-change handler runs outside React's render, so it reads the buffers from a ref
    // rather than deciding inside a state updater, which StrictMode would run twice.
    const buffersRef = useRef<readonly ScriptBuffer[]>([])
    // The breakpoints of files not open yet, waiting for the tab that carries them to come back.
    const restored = useRef<Readonly<Record<string, readonly number[]>>>(restore?.breakpoints ?? {})

    const report = useCallback(
        (error: unknown, action: string) => {
            const failure = toScriptError(error)
            // A stale save has a surface of its own — the buffer's own "out of date" bar, with the
            // two answers to it. Reporting it to the frame as well says the same thing twice in two
            // places, and the frame's copy outlives the conflict.
            if (failure.code === 'file_conflict') return
            onError(`${action}: ${failure.message}`)
        },
        [onError]
    )

    /** Says the workspace is working again, so a failure still on screen can be taken down. */
    const resolved = useCallback(() => {
        onResolved?.()
    }, [onResolved])

    const refreshFiles = useCallback(async () => {
        if (!isTauri()) return
        try {
            setFiles(await listWorkspaceFiles())
        } catch (error) {
            report(error, 'The project could not be listed')
        }
    }, [report])

    const flushChange = useCallback((path: string) => {
        const cancel = changeDelays.current.get(path)
        if (cancel === undefined) return
        cancel()
        changeDelays.current.delete(path)
    }, [])

    /**
     * Follows the language server's published diagnostics.
     *
     * The workspace mounts long before any editor session exists, and there is no server to
     * subscribe to until one does — so a single attempt at mount left the Problems panel silent
     * for the whole run. Every opened script tries again, which is the first moment a server is
     * known to be there.
     */
    const followDiagnostics = useCallback(() => {
        if (isFollowingDiagnostics.current || !isTauri()) return
        isFollowingDiagnostics.current = true
        void subscribeScriptDiagnostics(event => {
            setDiagnostics(previous => ({...previous, [event.path]: [...event.diagnostics]}))
        }).catch(() => {
            isFollowingDiagnostics.current = false
        })
    }, [])

    /** Asks the server what it last published for one file and records it. */
    const pullDiagnostics = useCallback((path: string) => {
        void callScriptLanguage({op: 'diagnostics', path})
            .then(response => {
                if (response.op !== 'diagnostics') return
                setDiagnostics(previous => ({...previous, [path]: [...response.diagnostics]}))
            })
            .catch(() => {
                // No language server yet, which is the ordinary state before a session starts.
            })
    }, [])

    const openBuffer = useCallback(
        async (path: string, activate = true, quiet = false) => {
            if (!isTauri()) return false
            try {
                const document = await openScriptDocument(path)
                followDiagnostics()
                dispatch({
                    type: 'opened',
                    document,
                    ...(restored.current[path] && {restored: restored.current[path]}),
                    activate
                })
                // What the server already thinks of this file, rather than only what it says
                // next: a script opened with an error in it should show that error now.
                pullDiagnostics(path)
                return true
            } catch (error) {
                // A tab being reopened from the last session names a file that may have been
                // renamed, moved, or deleted since. That is not a failure the user provoked, so
                // the tab is simply not there rather than the workspace opening on an error.
                if (!quiet) report(error, `${path} could not be opened`)
                return false
            }
        },
        [followDiagnostics, pullDiagnostics, report]
    )

    const closeBuffer = useCallback(
        (path: string) => {
            flushChange(path)
            dispatch({type: 'closed', path})
            // The rows go with the tab. Diagnostics accumulated per path and were never pruned, so
            // a file the agent deleted — or one the user simply closed — left a permanent error
            // badge on the bottom panel with rows that open nothing when clicked.
            setDiagnostics(previous => {
                if (!(path in previous)) return previous
                const {[path]: _closed, ...kept} = previous
                return kept
            })
            if (!isTauri()) return
            void closeScriptDocument(path).catch((error: unknown) => {
                report(error, `${path} could not be closed`)
            })
        },
        [flushChange, report]
    )

    const changeBuffer = useCallback(
        (path: string, text: string) => {
            dispatch({type: 'edited', path, text})
            if (!isTauri()) return
            flushChange(path)
            changeDelays.current.set(
                path,
                schedule(() => {
                    changeDelays.current.delete(path)
                    void updateScriptDocument(path, text)
                        .then(stamp => {
                            dispatch({type: 'synced', path, version: stamp.version})
                        })
                        .catch((error: unknown) => {
                            report(error, `${path} could not be synchronized`)
                        })
                }, CHANGE_DEBOUNCE_MS)
            )
        },
        [flushChange, report]
    )

    const saveBuffer = useCallback(
        async (path: string) => {
            const buffer = buffers.find(entry => entry.path === path)
            if (!buffer || !isTauri()) return
            flushChange(path)
            try {
                const stamp = await saveScriptDocument(path, buffer.text, buffer.hash)
                dispatch({type: 'saved', path, text: buffer.text, stamp})
                resolved()
            } catch (error) {
                const failure = toScriptError(error)
                // The file changed since this buffer read it. Nothing is written, and the buffer
                // keeps its text so the user can compare before overwriting or reloading.
                if (failure.code === 'file_conflict')
                    dispatch({type: 'conflicted', path, conflict: 'staleSave'})
                report(error, `${path} could not be saved`)
            }
        },
        [buffers, flushChange, report, resolved]
    )

    /** Discards the buffer and takes what is on disk, clearing any conflict. */
    const reloadBuffer = useCallback(
        async (path: string) => {
            flushChange(path)
            await openBuffer(path)
        },
        [flushChange, openBuffer]
    )

    /** Keeps the buffer and overwrites whatever the file now holds. */
    const overwriteBuffer = useCallback(
        async (path: string) => {
            const buffer = buffers.find(entry => entry.path === path)
            if (!buffer || !isTauri()) return
            flushChange(path)
            try {
                const current = await openScriptDocument(path)
                const stamp = await saveScriptDocument(path, buffer.text, current.hash)
                dispatch({type: 'overwritten', path, text: buffer.text, stamp})
                resolved()
            } catch (error) {
                report(error, `${path} could not be overwritten`)
            }
        },
        [buffers, flushChange, report, resolved]
    )

    /** Shows a tab that is already open. Opening one that is not is `openBuffer`'s job. */
    const showBuffer = useCallback((path: string) => {
        dispatch({type: 'shown', path})
    }, [])

    const toggleBreakpoint = useCallback((path: string, line: number) => {
        dispatch({type: 'breakpoint-toggled', path, line})
    }, [])

    /** Formats through the pinned sidecar and returns the diff for the user to accept. */
    const previewFormat = useCallback(
        async (path: string): Promise<FormatPreview | undefined> => {
            const buffer = buffers.find(entry => entry.path === path)
            if (!buffer || !isTauri()) return undefined
            try {
                const response = await formatGdscript(buffer.text)
                return {
                    path,
                    original: buffer.text,
                    formatted: response.formatted,
                    changed: response.changed
                }
            } catch (error) {
                report(error, `${path} could not be formatted`)
                return undefined
            }
        },
        [buffers, report]
    )

    const applyFormat = useCallback(
        (preview: FormatPreview) => {
            changeBuffer(preview.path, preview.formatted)
        },
        [changeBuffer]
    )

    /** Plans a rename without writing anything; `commitRename` performs the transaction. */
    const previewRename = useCallback(
        async (
            path: string,
            position: ScriptPosition,
            newName: string
        ): Promise<RenamePreview | undefined> => {
            if (!isTauri()) return undefined
            try {
                const response = await callScriptLanguage({
                    op: 'rename',
                    path,
                    position,
                    newName
                })
                if (response.op !== 'rename') return undefined
                return {path, newName, files: response.files}
            } catch (error) {
                report(error, `${path} could not be renamed`)
                return undefined
            }
        },
        [report]
    )

    const commitRename = useCallback(
        async (preview: RenamePreview) => {
            if (!isTauri()) return
            try {
                const stamps = await applyScriptRename(preview.files)
                dispatch({type: 'renamed', files: preview.files, stamps})
            } catch (error) {
                report(error, 'The rename could not be applied')
            }
        },
        [report]
    )

    // Published diagnostics arrive for every file the server knows about, including ones no tab
    // holds, so they are kept by path rather than folded into the open buffers.
    useEffect(() => {
        followDiagnostics()
        return () => {
            isFollowingDiagnostics.current = false
            void unsubscribeScriptDiagnostics().catch(() => undefined)
        }
    }, [followDiagnostics])

    // An external change — Godot, the AI agent, a confined shell command — reloads a clean buffer
    // and marks a dirty one instead of overwriting the user's work.
    useEffect(() => {
        if (!isTauri()) return
        void subscribeWorkspaceChanges(changes => {
            void refreshFiles()
            for (const change of changes) {
                const buffer = buffersRef.current.find(entry => entry.path === change.path)
                if (!buffer) continue
                if (buffer.dirty) {
                    dispatch({type: 'conflicted', path: change.path, conflict: 'externalChange'})
                    continue
                }
                void openBuffer(change.path, false)
            }
        }).catch(() => undefined)
        return () => {
            void unsubscribeWorkspaceChanges().catch(() => undefined)
        }
    }, [openBuffer, refreshFiles])

    useEffect(() => {
        buffersRef.current = buffers
    }, [buffers])

    /*
     * Reopens the tabs the project was left with.
     *
     * In order, and one at a time: the tab strip is the order the files were opened in, and the
     * language server is told about each document as it opens. The active tab is chosen last,
     * because the file it names may be one of the ones that no longer opens.
     */
    useEffect(() => {
        const reopening = restore?.openScripts ?? []
        if (reopening.length === 0 || !isTauri()) return
        let cancelled = false
        const reopen = async () => {
            const opened: string[] = []
            for (const path of reopening) {
                if (cancelled) return
                if (await openBuffer(path, false, true)) opened.push(path)
            }
            if (cancelled) return
            dispatch({type: 'reopened', opened})
        }
        void reopen()
        return () => {
            cancelled = true
        }
        // Mount only: `restore` says where the project was left, and reopening it later would
        // fight the user for which tabs are open.
        // eslint-disable-next-line react-hooks/exhaustive-deps -- see above
    }, [])

    // The first listing is fetched on mount; later ones ride the watcher's change batches.
    useEffect(() => {
        if (!isTauri()) return
        let cancelled = false
        const load = async () => {
            try {
                const listing = await listWorkspaceFiles()
                if (!cancelled) setFiles(listing)
            } catch (error) {
                if (!cancelled) report(error, 'The project could not be listed')
            }
        }
        void load()
        return () => {
            cancelled = true
        }
    }, [report])

    useEffect(() => {
        const delays = changeDelays.current
        return () => {
            for (const cancel of delays.values()) cancel()
            delays.clear()
        }
    }, [])

    const activeBuffer = buffers.find(buffer => buffer.path === activePath)

    return {
        activeBuffer,
        activePath,
        buffers,
        diagnostics,
        files,
        applyFormat,
        changeBuffer,
        closeBuffer,
        commitRename,
        openBuffer,
        overwriteBuffer,
        previewFormat,
        previewRename,
        refreshFiles,
        reloadBuffer,
        saveBuffer,
        showBuffer,
        toggleBreakpoint
    }
}

import {useCallback, useEffect, useRef, useState} from 'react'
import {invoke, isTauri} from '../services/desktop'
import {
    applyScriptRename,
    callScriptLanguage,
    closeScriptDocument,
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
import type {
    PlannedScriptFile,
    ScriptDiagnostic,
    ScriptPosition,
    WorkspaceEntry
} from '../models/script'

/**
 * Why a buffer refuses to write. `externalChange` means the file moved underneath a dirty buffer;
 * `staleSave` means the write itself lost the optimistic-concurrency check.
 */
export type ScriptBufferConflict = 'externalChange' | 'staleSave'

export type ScriptBuffer = Readonly<{
    path: string
    /** What the editor holds right now. */
    text: string
    /** What Gofer last read from or wrote to disk. */
    savedText: string
    /** The hash the next write claims to replace. */
    hash: string
    /** The language server's document version. Rust owns it; the renderer only records it. */
    version: number
    dirty: boolean
    /** One-based lines carrying a breakpoint, in the order the user set them. */
    breakpoints: readonly number[]
    conflict?: ScriptBufferConflict | undefined
}>

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

function replaceBuffer(
    buffers: readonly ScriptBuffer[],
    path: string,
    update: (buffer: ScriptBuffer) => ScriptBuffer
) {
    return buffers.map(buffer => (buffer.path === path ? update(buffer) : buffer))
}

/**
 * Owns every open script buffer: its text, the hash it expects on disk, the language server's
 * document version, its breakpoints, and its conflict state.
 *
 * The rule the whole hook exists to keep is that one file has exactly one document version.
 * Rust assigns it — on open, on every debounced change, and on save — so a UI edit and an AI edit
 * of the same file cannot leave two versions of the truth behind.
 */
export function useScriptBuffers({onError, onResolved, restore}: ScriptBufferOptions) {
    const [buffers, setBuffers] = useState<readonly ScriptBuffer[]>([])
    const [activePath, setActivePath] = useState<string | undefined>(restore?.activeScript)
    const [files, setFiles] = useState<readonly WorkspaceEntry[]>([])
    const [diagnostics, setDiagnostics] = useState<Readonly<Record<string, ScriptDiagnostic[]>>>({})
    const changeTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
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
            report(error, 'The worktree could not be listed')
        }
    }, [report])

    const flushChange = useCallback((path: string) => {
        const timer = changeTimers.current.get(path)
        if (timer === undefined) return
        clearTimeout(timer)
        changeTimers.current.delete(path)
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
                setBuffers(previous => {
                    const existing = previous.find(buffer => buffer.path === path)
                    const next: ScriptBuffer = {
                        path,
                        text: document.text,
                        savedText: document.text,
                        hash: document.hash,
                        version: document.version,
                        dirty: false,
                        breakpoints: existing?.breakpoints ?? restored.current[path] ?? [],
                        conflict: undefined
                    }
                    return existing ?
                            replaceBuffer(previous, path, () => next)
                        :   [...previous, next]
                })
                if (activate) setActivePath(path)
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
            setBuffers(previous => {
                const remaining = previous.filter(buffer => buffer.path !== path)
                setActivePath(current =>
                    current === path ? remaining[remaining.length - 1]?.path : current
                )
                return remaining
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
            setBuffers(previous =>
                replaceBuffer(previous, path, buffer => ({
                    ...buffer,
                    text,
                    dirty: text !== buffer.savedText
                }))
            )
            if (!isTauri()) return
            flushChange(path)
            changeTimers.current.set(
                path,
                setTimeout(() => {
                    changeTimers.current.delete(path)
                    void updateScriptDocument(path, text)
                        .then(stamp => {
                            setBuffers(previous =>
                                replaceBuffer(previous, path, buffer => ({
                                    ...buffer,
                                    version: stamp.version
                                }))
                            )
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
                setBuffers(previous =>
                    replaceBuffer(previous, path, entry => ({
                        ...entry,
                        savedText: buffer.text,
                        hash: stamp.hash ?? entry.hash,
                        version: stamp.version,
                        dirty: entry.text !== buffer.text,
                        conflict: undefined
                    }))
                )
                resolved()
            } catch (error) {
                const failure = toScriptError(error)
                // The file changed since this buffer read it. Nothing is written, and the buffer
                // keeps its text so the user can compare before overwriting or reloading.
                if (failure.code === 'file_conflict') {
                    setBuffers(previous =>
                        replaceBuffer(previous, path, entry => ({...entry, conflict: 'staleSave'}))
                    )
                }
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
                setBuffers(previous =>
                    replaceBuffer(previous, path, entry => ({
                        ...entry,
                        text: buffer.text,
                        savedText: buffer.text,
                        hash: stamp.hash ?? entry.hash,
                        version: stamp.version,
                        dirty: false,
                        conflict: undefined
                    }))
                )
                resolved()
            } catch (error) {
                report(error, `${path} could not be overwritten`)
            }
        },
        [buffers, flushChange, report, resolved]
    )

    const toggleBreakpoint = useCallback((path: string, line: number) => {
        setBuffers(previous =>
            replaceBuffer(previous, path, buffer => ({
                ...buffer,
                breakpoints:
                    buffer.breakpoints.includes(line) ?
                        buffer.breakpoints.filter(entry => entry !== line)
                    :   [...buffer.breakpoints, line]
            }))
        )
    }, [])

    /** Formats through the pinned sidecar and returns the diff for the user to accept. */
    const previewFormat = useCallback(
        async (path: string): Promise<FormatPreview | undefined> => {
            const buffer = buffers.find(entry => entry.path === path)
            if (!buffer || !isTauri()) return undefined
            try {
                const response = await invoke('format_gdscript', {request: {source: buffer.text}})
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
                const response = await invoke('call_script_language', {
                    request: {op: 'rename', path, position, newName}
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
                setBuffers(previous =>
                    previous.map(buffer => {
                        const file = preview.files.find(entry => entry.path === buffer.path)
                        const stamp = stamps.find(entry => entry.path === buffer.path)
                        if (!file || !stamp) return buffer
                        return {
                            ...buffer,
                            text: file.updatedText,
                            savedText: file.updatedText,
                            hash: stamp.hash ?? buffer.hash,
                            version: stamp.version,
                            dirty: false,
                            conflict: undefined
                        }
                    })
                )
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
                    setBuffers(previous =>
                        replaceBuffer(previous, change.path, entry => ({
                            ...entry,
                            conflict: 'externalChange'
                        }))
                    )
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
            setActivePath(current =>
                current !== undefined && opened.includes(current) ?
                    current
                :   opened[opened.length - 1]
            )
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
                if (!cancelled) report(error, 'The worktree could not be listed')
            }
        }
        void load()
        return () => {
            cancelled = true
        }
    }, [report])

    useEffect(() => {
        const timers = changeTimers.current
        return () => {
            for (const timer of timers.values()) clearTimeout(timer)
            timers.clear()
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
        setActivePath,
        toggleBreakpoint
    }
}

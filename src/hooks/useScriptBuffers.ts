import {useCallback, useEffect, useMemo, useReducer, useRef, useState} from 'react'
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

export type ScriptRestore = Readonly<{
    openScripts: readonly string[]
    activeScript?: string | undefined
    breakpoints: Readonly<Record<string, readonly number[]>>
}>

type ScriptBufferOptions = Readonly<{
    onError: (message: string) => void
    restore?: ScriptRestore | undefined
    onResolved?: (() => void) | undefined
}>

export type ScriptBuffers = ReturnType<typeof useScriptBuffers>

const CHANGE_DEBOUNCE_MS = 250

export function useScriptBuffers({onError, onResolved, restore}: ScriptBufferOptions) {
    const [tabs, dispatch] = useReducer(reduceScriptTabs, {
        ...NO_SCRIPT_TABS,
        ...(restore?.activeScript !== undefined && {activePath: restore.activeScript})
    })
    const {activePath, buffers} = tabs
    const [files, setFiles] = useState<readonly WorkspaceEntry[]>([])
    const [diagnostics, setDiagnostics] = useState<Readonly<Record<string, ScriptDiagnostic[]>>>({})
    const changeDelays = useRef(new Map<string, () => void>())
    const isFollowingDiagnostics = useRef(false)
    const buffersRef = useRef<readonly ScriptBuffer[]>([])
    const restored = useRef<Readonly<Record<string, readonly number[]>>>(restore?.breakpoints ?? {})

    useEffect(() => {
        buffersRef.current = buffers
    }, [buffers])

    const bufferAt = useCallback(
        (path: string) => buffersRef.current.find(entry => entry.path === path),
        []
    )

    const report = useCallback(
        (error: unknown, action: string) => {
            const failure = toScriptError(error)
            if (failure.code === 'file_conflict') return
            onError(`${action}: ${failure.message}`)
        },
        [onError]
    )

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

    const followDiagnostics = useCallback(() => {
        if (isFollowingDiagnostics.current || !isTauri()) return
        isFollowingDiagnostics.current = true
        void subscribeScriptDiagnostics(event => {
            setDiagnostics(previous => ({...previous, [event.path]: [...event.diagnostics]}))
        }).catch(() => {
            isFollowingDiagnostics.current = false
        })
    }, [])

    const pullDiagnostics = useCallback((path: string) => {
        void callScriptLanguage({op: 'diagnostics', path})
            .then(response => {
                if (response.op !== 'diagnostics') return
                setDiagnostics(previous => ({...previous, [path]: [...response.diagnostics]}))
            })
            .catch(() => undefined)
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
                pullDiagnostics(path)
                return true
            } catch (error) {
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
            const buffer = bufferAt(path)
            if (!buffer || !isTauri()) return
            flushChange(path)
            try {
                const stamp = await saveScriptDocument(path, buffer.text, buffer.hash)
                dispatch({type: 'saved', path, text: buffer.text, stamp})
                resolved()
            } catch (error) {
                const failure = toScriptError(error)
                if (failure.code === 'file_conflict')
                    dispatch({type: 'conflicted', path, conflict: 'staleSave'})
                report(error, `${path} could not be saved`)
            }
        },
        [bufferAt, flushChange, report, resolved]
    )

    const reloadBuffer = useCallback(
        async (path: string) => {
            flushChange(path)
            await openBuffer(path)
        },
        [flushChange, openBuffer]
    )

    const overwriteBuffer = useCallback(
        async (path: string) => {
            const buffer = bufferAt(path)
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
        [bufferAt, flushChange, report, resolved]
    )

    const showBuffer = useCallback((path: string) => {
        dispatch({type: 'shown', path})
    }, [])

    const toggleBreakpoint = useCallback((path: string, line: number) => {
        dispatch({type: 'breakpoint-toggled', path, line})
    }, [])

    const previewFormat = useCallback(
        async (path: string): Promise<FormatPreview | undefined> => {
            const buffer = bufferAt(path)
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
        [bufferAt, report]
    )

    const applyFormat = useCallback(
        (preview: FormatPreview) => {
            changeBuffer(preview.path, preview.formatted)
        },
        [changeBuffer]
    )

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

    useEffect(() => {
        followDiagnostics()
        return () => {
            isFollowingDiagnostics.current = false
            void unsubscribeScriptDiagnostics().catch(() => undefined)
        }
    }, [followDiagnostics])

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
        // eslint-disable-next-line react-hooks/exhaustive-deps -- see above
    }, [])

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

    return useMemo(
        () => ({
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
        }),
        [
            activeBuffer,
            activePath,
            applyFormat,
            buffers,
            changeBuffer,
            closeBuffer,
            commitRename,
            diagnostics,
            files,
            openBuffer,
            overwriteBuffer,
            previewFormat,
            previewRename,
            refreshFiles,
            reloadBuffer,
            saveBuffer,
            showBuffer,
            toggleBreakpoint
        ]
    )
}

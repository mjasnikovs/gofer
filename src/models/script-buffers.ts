import type {PlannedScriptFile, ScriptDocument, ScriptStamp} from './script'

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

/**
 * The open script tabs and which one is showing.
 *
 * Kept as one value because the two cannot be decided apart: closing a tab has to choose the next
 * one from what is left, and reopening a project has to choose an active tab from the files that
 * actually opened. Held in two pieces, each of those is a decision made against a list that may
 * already have moved.
 */
export type ScriptTabs = Readonly<{
    buffers: readonly ScriptBuffer[]
    activePath?: string | undefined
}>

export type ScriptTabsAction =
    /** Rust answered with a document. Also the path a reload takes: same action, same result. */
    | Readonly<{
          type: 'opened'
          document: ScriptDocument
          /** Breakpoints a stored layout is waiting to give back to this file, if any. */
          restored?: readonly number[] | undefined
          activate: boolean
      }>
    | Readonly<{type: 'closed'; path: string}>
    /** A tab already open was clicked. */
    | Readonly<{type: 'shown'; path: string}>
    /** A keystroke. Recorded before the server hears about it, which is what dirty means. */
    | Readonly<{type: 'edited'; path: string; text: string}>
    /** The debounced change reached the server, which answered with a document version. */
    | Readonly<{type: 'synced'; path: string; version: number}>
    | Readonly<{type: 'saved'; path: string; text: string; stamp: ScriptStamp}>
    | Readonly<{type: 'conflicted'; path: string; conflict: ScriptBufferConflict}>
    | Readonly<{type: 'overwritten'; path: string; text: string; stamp: ScriptStamp}>
    | Readonly<{type: 'breakpoint-toggled'; path: string; line: number}>
    | Readonly<{
          type: 'renamed'
          files: readonly PlannedScriptFile[]
          stamps: readonly ScriptStamp[]
      }>
    /** A stored project finished reopening, with the tabs that turned out to still exist. */
    | Readonly<{type: 'reopened'; opened: readonly string[]}>

export const NO_SCRIPT_TABS: ScriptTabs = {buffers: []}

function replace(
    buffers: readonly ScriptBuffer[],
    path: string,
    update: (buffer: ScriptBuffer) => ScriptBuffer
) {
    return buffers.map(buffer => (buffer.path === path ? update(buffer) : buffer))
}

/** What one buffer looks like once a write has landed: clean unless it was typed in meanwhile. */
function written(buffer: ScriptBuffer, text: string, stamp: ScriptStamp): ScriptBuffer {
    return {
        ...buffer,
        savedText: text,
        hash: stamp.hash ?? buffer.hash,
        version: stamp.version,
        // Against the text that was written, not against the buffer: a keystroke landing while the
        // write was in flight leaves the tab dirty, which it is.
        dirty: buffer.text !== text,
        conflict: undefined
    }
}

export function reduceScriptTabs(state: ScriptTabs, action: ScriptTabsAction): ScriptTabs {
    switch (action.type) {
        /*
         * Reopening a file already open replaces it rather than adding a second tab, and keeps the
         * breakpoints. A breakpoint belongs to the line the user set it on, and a reload — which is
         * this same action — would otherwise silently clear the gutter of every file that changed
         * on disk.
         */
        case 'opened': {
            const {document} = action
            const existing = state.buffers.find(buffer => buffer.path === document.path)
            const next: ScriptBuffer = {
                path: document.path,
                text: document.text,
                savedText: document.text,
                hash: document.hash,
                version: document.version,
                dirty: false,
                breakpoints: existing?.breakpoints ?? action.restored ?? [],
                conflict: undefined
            }
            return {
                buffers:
                    existing ?
                        replace(state.buffers, document.path, () => next)
                    :   [...state.buffers, next],
                activePath: action.activate ? document.path : state.activePath
            }
        }

        // Closing the tab being read moves to the last of the ones left, which is where the strip
        // puts the eye anyway. Closing any other tab leaves the reading where it was.
        case 'closed': {
            const remaining = state.buffers.filter(buffer => buffer.path !== action.path)
            return {
                buffers: remaining,
                activePath:
                    state.activePath === action.path ? remaining.at(-1)?.path : state.activePath
            }
        }

        case 'shown':
            return state.activePath === action.path ? state : {...state, activePath: action.path}

        case 'edited':
            return {
                ...state,
                buffers: replace(state.buffers, action.path, buffer => ({
                    ...buffer,
                    text: action.text,
                    dirty: action.text !== buffer.savedText
                }))
            }

        // Only the version. A sync is the server catching up with text the buffer already holds,
        // so taking anything else from it would undo whatever was typed while it was in flight.
        case 'synced':
            return {
                ...state,
                buffers: replace(state.buffers, action.path, buffer => ({
                    ...buffer,
                    version: action.version
                }))
            }

        case 'saved':
            return {
                ...state,
                buffers: replace(state.buffers, action.path, buffer =>
                    written(buffer, action.text, action.stamp)
                )
            }

        // The buffer keeps its text: a conflict warns, it does not choose a side. Both answers to
        // it — reload and overwrite — need the user's version still to be there.
        case 'conflicted':
            return {
                ...state,
                buffers: replace(state.buffers, action.path, buffer => ({
                    ...buffer,
                    conflict: action.conflict
                }))
            }

        case 'overwritten':
            return {
                ...state,
                buffers: replace(state.buffers, action.path, buffer => ({
                    ...written(buffer, action.text, action.stamp),
                    text: action.text,
                    dirty: false
                }))
            }

        case 'breakpoint-toggled':
            return {
                ...state,
                buffers: replace(state.buffers, action.path, buffer => ({
                    ...buffer,
                    breakpoints:
                        buffer.breakpoints.includes(action.line) ?
                            buffer.breakpoints.filter(line => line !== action.line)
                        :   [...buffer.breakpoints, action.line]
                }))
            }

        /*
         * A rename is one transaction across many files, and only the ones with a tab are here.
         * A file the transaction rewrote but that answered with no stamp is left alone: without a
         * version, the next edit to it would be sent under a number the server does not know.
         */
        case 'renamed':
            return {
                ...state,
                buffers: state.buffers.map(buffer => {
                    const file = action.files.find(entry => entry.path === buffer.path)
                    const stamp = action.stamps.find(entry => entry.path === buffer.path)
                    if (!file || !stamp) return buffer
                    return {
                        ...written(buffer, file.updatedText, stamp),
                        text: file.updatedText,
                        dirty: false
                    }
                })
            }

        // Chosen last, because the stored active tab may name one of the files that no longer
        // opens. Falling back to the last one that did beats opening on nothing at all.
        case 'reopened':
            return {
                ...state,
                activePath:
                    state.activePath !== undefined && action.opened.includes(state.activePath) ?
                        state.activePath
                    :   action.opened.at(-1)
            }
    }
}

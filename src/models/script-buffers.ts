import type {PlannedScriptFile, ScriptDocument, ScriptStamp} from './script'

export type ScriptBufferConflict = 'externalChange' | 'staleSave'

export type ScriptBuffer = Readonly<{
    path: string
    text: string
    savedText: string
    hash: string
    version: number
    dirty: boolean
    breakpoints: readonly number[]
    conflict?: ScriptBufferConflict | undefined
}>

export type ScriptTabs = Readonly<{
    buffers: readonly ScriptBuffer[]
    activePath?: string | undefined
}>

export type ScriptTabsAction =
    | Readonly<{
          type: 'opened'
          document: ScriptDocument
          restored?: readonly number[] | undefined
          activate: boolean
      }>
    | Readonly<{type: 'closed'; path: string}>
    | Readonly<{type: 'shown'; path: string}>
    | Readonly<{type: 'edited'; path: string; text: string}>
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
    | Readonly<{type: 'reopened'; opened: readonly string[]}>

export const NO_SCRIPT_TABS: ScriptTabs = {buffers: []}

function replace(
    buffers: readonly ScriptBuffer[],
    path: string,
    update: (buffer: ScriptBuffer) => ScriptBuffer
) {
    return buffers.map(buffer => (buffer.path === path ? update(buffer) : buffer))
}

function written(buffer: ScriptBuffer, text: string, stamp: ScriptStamp): ScriptBuffer {
    return {
        ...buffer,
        savedText: text,
        hash: stamp.hash ?? buffer.hash,
        version: stamp.version,
        dirty: buffer.text !== text,
        conflict: undefined
    }
}

export function reduceScriptTabs(state: ScriptTabs, action: ScriptTabsAction): ScriptTabs {
    switch (action.type) {
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

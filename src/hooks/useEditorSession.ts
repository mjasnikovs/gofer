import {createContext, use} from 'react'
import type {SessionView} from '../models/godot-session-state'
import type {GodotCall} from '../models/workspace'

export type EditorSession = SessionView
    & Readonly<{
        scenePath: string
        call: GodotCall
        ensureReady: () => Promise<boolean>
        start: () => Promise<void>
        stop: () => Promise<void>
    }>

export const EditorSessionContext = createContext<EditorSession | undefined>(undefined)

export function useEditorSession(): EditorSession {
    const session = use(EditorSessionContext)
    if (!session) throw new Error('This panel must be rendered inside an editor session.')
    return session
}

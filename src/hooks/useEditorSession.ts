import {createContext, use} from 'react'
import type {SessionView} from '../models/godot-session-state'
import type {GodotCall} from '../models/workspace'

/**
 * The one Gofer-managed editor session, as everything inside the frame sees it.
 *
 * It is one thing, so it travels as one thing. The way to ask the editor something, whether it can
 * be asked, and the two epochs that say when an answer has gone stale are not four facts a panel
 * assembles for itself — they are the session, and a panel handed them separately could be given a
 * `call` belonging to one editor and an epoch belonging to the next with nothing to object.
 *
 * It is also the seam the panels are tested at. A panel used to need a whole frame around it to be
 * mounted at all; with the session at a seam, a test provides one and mounts the panel alone.
 */
export type EditorSession = SessionView
    & Readonly<{
        /**
         * The scene the editor has open, or empty when it has none.
         *
         * A field of the session rather than something a panel assembles: `node.inspect` refuses a
         * request naming any other scene, so a panel handed a path from one editor and a `call`
         * belonging to the next has nothing to object with.
         */
        scenePath: string
        /** Sends one addon command. Typed by the command map, so a reply is never cast. */
        call: GodotCall
        /**
         * Guarantees an editor that can answer, starting one if none is running, and says whether
         * it got one. Everything that must happen *in* an editor waits on this first.
         */
        ensureReady: () => Promise<boolean>
        start: () => Promise<void>
        stop: () => Promise<void>
    }>

export const EditorSessionContext = createContext<EditorSession | undefined>(undefined)

/**
 * The editor session the surrounding frame owns.
 *
 * Unlike the chat references, there is no sensible reading of "no session provided": a panel that
 * cannot ask the editor anything has nothing to draw. So this throws rather than handing back
 * `undefined` for every panel to check — a missing provider is a wiring mistake, and it should say
 * so where it was made rather than as an empty panel three renders later.
 */
export function useEditorSession(): EditorSession {
    const session = use(EditorSessionContext)
    if (!session) throw new Error('This panel must be rendered inside an editor session.')
    return session
}

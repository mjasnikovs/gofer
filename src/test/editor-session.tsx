import type {ReactNode} from 'react'
import {EditorSessionContext} from '../hooks/useEditorSession'
import type {EditorSession} from '../hooks/useEditorSession'

/** Puts one panel, or one reading, inside an editor session it can read. */
export function InEditorSession({
    session,
    children
}: Readonly<{session: EditorSession; children: ReactNode}>) {
    return <EditorSessionContext value={session}>{children}</EditorSessionContext>
}

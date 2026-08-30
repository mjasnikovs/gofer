import type {ReactNode} from 'react'
import {EditorSessionContext} from '../hooks/useEditorSession'
import type {EditorSession} from '../hooks/useEditorSession'

export function InEditorSession({
    session,
    children
}: Readonly<{session: EditorSession; children: ReactNode}>) {
    return <EditorSessionContext value={session}>{children}</EditorSessionContext>
}

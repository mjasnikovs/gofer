import {useEffect, useRef, useState} from 'react'
import type * as Monaco from 'monaco-editor'
import {StackItem} from '@astryxdesign/core/Stack'
import {Text} from '@astryxdesign/core/Text'
import {loadMonaco} from '../../services/monaco-runtime'
import {GOFER_EDITOR_THEME} from '../../services/monaco-theme'

type SkillEditorProps = Readonly<{
    /** The skill's text as it was read. Changing it replaces what the editor holds. */
    text: string
    onChange: (text: string) => void
}>

/**
 * A skill's own Markdown, in the editor the application already ships.
 *
 * `ScriptEditor` is the other Monaco in this workspace and is deliberately not reused: it is bound
 * to Godot's language server — models keyed by `res://` URIs, diagnostics pushed as markers,
 * breakpoints, rename. None of that means anything for a Markdown file, and a skill is not a file
 * the editor session knows about at all.
 *
 * `loadMonaco` imports the whole `monaco-editor` package, so Markdown highlighting is already
 * there. Only the base editor worker is registered, and Markdown asks for none.
 */
const OPTIONS: Monaco.editor.IStandaloneEditorConstructionOptions = {
    theme: GOFER_EDITOR_THEME,
    language: 'markdown',
    automaticLayout: true,
    minimap: {enabled: false},
    scrollBeyondLastLine: false,
    wordWrap: 'on',
    fontSize: 12
}

const HOST_STYLE = {minHeight: 0, width: '100%', height: '100%'} as const

export function SkillEditor({text, onChange}: SkillEditorProps) {
    const hostRef = useRef<HTMLElement | null>(null)
    const [failed, setFailed] = useState(false)
    /*
     * The newest handler, read at the moment Monaco calls it. The editor is built once, and a
     * subscription that closed over the first `onChange` would go on reporting edits to a save that
     * belonged to the skill the user had already left.
     */
    const report = useRef(onChange)
    useEffect(() => {
        report.current = onChange
    }, [onChange])

    useEffect(() => {
        let editor: Monaco.editor.IStandaloneCodeEditor | undefined
        let cancelled = false
        void loadMonaco()
            .then(monaco => {
                if (cancelled || !hostRef.current) return
                editor = monaco.editor.create(hostRef.current, {...OPTIONS, value: text})
                editor.onDidChangeModelContent(() => {
                    report.current(editor?.getValue() ?? '')
                })
            })
            .catch(() => {
                if (!cancelled) setFailed(true)
            })
        return () => {
            cancelled = true
            editor?.getModel()?.dispose()
            editor?.dispose()
        }
        // Built once per skill. `text` seeds it and is not a dependency: re-running on every
        // keystroke would rebuild the editor under the cursor.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    if (failed)
        return (
            <Text
                type='supporting'
                color='secondary'
            >
                The editor could not be loaded.
            </Text>
        )
    return (
        <StackItem
            size='fill'
            ref={hostRef}
            style={HOST_STYLE}
        />
    )
}

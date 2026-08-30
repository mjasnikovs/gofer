import {useEffect, useRef, useState} from 'react'
import type * as Monaco from 'monaco-editor'
import {StackItem} from '@astryxdesign/core/Stack'
import {Text} from '@astryxdesign/core/Text'
import {loadMonaco} from '../../services/monaco-runtime'
import {GOFER_EDITOR_THEME} from '../../services/monaco-theme'

type SkillEditorProps = Readonly<{
    text: string
    onChange: (text: string) => void
}>

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

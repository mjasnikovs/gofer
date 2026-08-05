import {useEffect, useRef, useState} from 'react'
import type * as Monaco from 'monaco-editor'
import {StackItem} from '@astryxdesign/core/Stack'
import {Text} from '@astryxdesign/core/Text'
import {languageForPath} from '../../services/monaco-gdscript'
import {loadMonaco} from '../../services/monaco-runtime'

type MonacoDiffProps = Readonly<{
    path: string
    original: string
    modified: string
    height: number
}>

const DIFF_OPTIONS: Monaco.editor.IStandaloneDiffEditorConstructionOptions = {
    automaticLayout: true,
    readOnly: true,
    renderSideBySide: false,
    minimap: {enabled: false},
    scrollBeyondLastLine: false,
    fontSize: 12
}

/**
 * A read-only diff of a proposed change. Both the formatter and rename previews use it, so what a
 * user approves is exactly the text that will be written.
 */
export function MonacoDiff({path, original, modified, height}: MonacoDiffProps) {
    const hostRef = useRef<HTMLElement | null>(null)
    const [failed, setFailed] = useState(false)

    useEffect(() => {
        let editor: Monaco.editor.IStandaloneDiffEditor | undefined
        let models: Monaco.editor.ITextModel[] = []
        let cancelled = false
        void loadMonaco()
            .then(monaco => {
                if (cancelled || !hostRef.current) return
                const language = languageForPath(path)
                const before = monaco.editor.createModel(original, language)
                const after = monaco.editor.createModel(modified, language)
                models = [before, after]
                editor = monaco.editor.createDiffEditor(hostRef.current, DIFF_OPTIONS)
                editor.setModel({original: before, modified: after})
            })
            .catch(() => {
                if (!cancelled) setFailed(true)
            })
        return () => {
            cancelled = true
            editor?.dispose()
            for (const model of models) model.dispose()
        }
    }, [modified, original, path])

    if (failed) return <Text color='secondary'>The diff view could not be loaded.</Text>
    return (
        <StackItem
            ref={hostRef}
            size='static'
            style={{height, width: '100%'}}
            data-testid='script-diff-host'
        />
    )
}

import {useEffect, useRef, useState} from 'react'
import type * as Monaco from 'monaco-editor'
import {StackItem} from '@astryxdesign/core/Stack'
import {Text} from '@astryxdesign/core/Text'
import {languageForPath} from '../../services/monaco-gdscript'
import {loadMonaco} from '../../services/monaco-runtime'
import {GOFER_EDITOR_THEME} from '../../services/monaco-theme'

type MonacoDiffProps = Readonly<{
    path: string
    original: string
    modified: string
    /** A fixed height for a dialog, or `fill` to take whatever the column has left. */
    height: number | 'fill'
    isSideBySide?: boolean
    testId?: string
}>

const DIFF_OPTIONS: Monaco.editor.IStandaloneDiffEditorConstructionOptions = {
    theme: GOFER_EDITOR_THEME,
    automaticLayout: true,
    readOnly: true,
    minimap: {enabled: false},
    scrollBeyondLastLine: false,
    fontSize: 12,
    // Monaco folds side-by-side back to inline below 900px of its own width, and Gofer's centre
    // column is 360px with both panels open — so left on, the choice below would never be honoured.
    useInlineViewWhenSpaceIsLimited: false
}

// minHeight lets the host shrink inside a flex column; without it the editor grows past the
// region and `automaticLayout` never settles.
const FILL_STYLE = {minHeight: 0, width: '100%', height: '100%'} as const

export function MonacoDiff({
    path,
    original,
    modified,
    height,
    isSideBySide = false,
    testId = 'script-diff-host'
}: MonacoDiffProps) {
    const hostRef = useRef<HTMLElement | null>(null)
    const editorRef = useRef<Monaco.editor.IStandaloneDiffEditor | null>(null)
    const [failed, setFailed] = useState(false)
    // Monaco is loaded asynchronously, so the effect below has usually already run by the time
    // there is an editor to tell. The creation call reads the latest value through this instead.
    const sideBySide = useRef(isSideBySide)

    useEffect(() => {
        let models: Monaco.editor.ITextModel[] = []
        let cancelled = false
        void loadMonaco()
            .then(monaco => {
                if (cancelled || !hostRef.current) return
                const language = languageForPath(path)
                const before = monaco.editor.createModel(original, language)
                const after = monaco.editor.createModel(modified, language)
                models = [before, after]
                const editor = monaco.editor.createDiffEditor(hostRef.current, {
                    ...DIFF_OPTIONS,
                    renderSideBySide: sideBySide.current
                })
                editor.setModel({original: before, modified: after})
                editorRef.current = editor
            })
            .catch(() => {
                if (!cancelled) setFailed(true)
            })
        return () => {
            cancelled = true
            editorRef.current?.dispose()
            editorRef.current = null
            for (const model of models) model.dispose()
        }
    }, [modified, original, path])

    useEffect(() => {
        sideBySide.current = isSideBySide
        editorRef.current?.updateOptions({renderSideBySide: isSideBySide})
    }, [isSideBySide])

    if (failed) return <Text color='secondary'>The diff view could not be loaded.</Text>
    return (
        <StackItem
            ref={hostRef}
            size={height === 'fill' ? 'fill' : 'static'}
            style={height === 'fill' ? FILL_STYLE : {height, width: '100%'}}
            data-testid={testId}
        />
    )
}

import {useCallback, useMemo, useState} from 'react'
import {Badge} from '@astryxdesign/core/Badge'
import {Banner} from '@astryxdesign/core/Banner'
import {Button} from '@astryxdesign/core/Button'
import {Dialog, DialogHeader} from '@astryxdesign/core/Dialog'
import {Divider} from '@astryxdesign/core/Divider'
import {EmptyState} from '@astryxdesign/core/EmptyState'
import {Item} from '@astryxdesign/core/Item'
import {HStack, StackItem, VStack} from '@astryxdesign/core/Stack'
import {Tab, TabList} from '@astryxdesign/core/TabList'
import {Text} from '@astryxdesign/core/Text'
import {TextInput} from '@astryxdesign/core/TextInput'
import {Toolbar} from '@astryxdesign/core/Toolbar'
import {invoke} from '../../services/desktop'
import {useScriptBuffers} from '../../hooks/useScriptBuffers'
import type {FormatPreview, RenamePreview, ScriptBuffer} from '../../hooks/useScriptBuffers'
import type {ScriptPosition} from '../../models/script'
import {MonacoDiff} from './MonacoDiff'
import {ScriptEditor} from './ScriptEditor'

type ScriptWorkspaceProps = Readonly<{
    onError: (message: string) => void
}>

type RenameTarget = Readonly<{
    path: string
    position: ScriptPosition
    name: string
}>

const EXPLORER_WIDTH = 260
const DIFF_HEIGHT = 420
const MAX_LISTED_FILES = 400
/** Generated sidecars and imported artefacts are noise in a script picker. */
const HIDDEN_SUFFIXES = ['.import', '.uid', '.tmp']
const HIDDEN_PREFIXES = ['.godot/', '.git/', 'addons/gofer/']

const CONFLICT_MESSAGE = {
    externalChange: 'This file changed on disk while the buffer was edited.',
    staleSave: 'The file changed since this buffer read it, so nothing was written.'
} as const

function isListable(path: string) {
    if (HIDDEN_SUFFIXES.some(suffix => path.endsWith(suffix))) return false
    return !HIDDEN_PREFIXES.some(prefix => path.startsWith(prefix))
}

function tabLabel(buffer: ScriptBuffer) {
    const name = buffer.path.split('/').pop() ?? buffer.path
    return buffer.dirty ? `${name} •` : name
}

/**
 * The script editing surface: a worktree file list, one tab per open buffer, and Monaco wired to
 * Godot's language server through Rust.
 *
 * Everything destructive is explicit. A save is a command, never a side effect of typing; the
 * formatter and rename both show what they would write before anything is written; and a file
 * that changed underneath a dirty buffer raises a conflict rather than being overwritten.
 */
export function ScriptWorkspace({onError}: ScriptWorkspaceProps) {
    const {
        activeBuffer,
        activePath,
        buffers,
        diagnostics,
        files,
        applyFormat,
        changeBuffer,
        closeBuffer,
        commitRename,
        openBuffer,
        overwriteBuffer,
        previewFormat,
        previewRename,
        reloadBuffer,
        saveBuffer,
        setActivePath,
        toggleBreakpoint
    } = useScriptBuffers({onError})
    const [filter, setFilter] = useState('')
    const [formatPreview, setFormatPreview] = useState<FormatPreview>()
    const [renameTarget, setRenameTarget] = useState<RenameTarget>()
    const [renamePreview, setRenamePreview] = useState<RenamePreview>()

    const listed = useMemo(
        () =>
            files
                .filter(file => isListable(file.path))
                .filter(file => file.path.toLowerCase().includes(filter.toLowerCase()))
                .slice(0, MAX_LISTED_FILES),
        [files, filter]
    )

    const openPaths = useMemo(() => buffers.map(buffer => buffer.path), [buffers])
    const activeDiagnostics = activePath ? (diagnostics[activePath] ?? []) : []

    const open = useCallback(
        (path: string) => {
            void openBuffer(path)
        },
        [openBuffer]
    )

    const save = useCallback(
        (path: string) => {
            void saveBuffer(path)
        },
        [saveBuffer]
    )

    /**
     * Asks the server what the symbol under the cursor is called before offering to rename it, so
     * the dialog opens on the real identifier rather than on whatever the cursor happened to touch.
     */
    const startRename = useCallback((path: string, position: ScriptPosition) => {
        const prepare = async () => {
            let name = ''
            try {
                const response = await invoke('call_script_language', {
                    request: {op: 'prepareRename', path, position}
                })
                if (response.op === 'prepareRename') name = response.placeholder ?? ''
            } catch {
                // A server that cannot prepare the rename can still perform it; the user types
                // the new name either way.
            }
            setRenameTarget({path, position, name})
        }
        void prepare()
    }, [])

    const requestFormat = useCallback(() => {
        if (!activePath) return
        void previewFormat(activePath).then(preview => {
            if (preview) setFormatPreview(preview)
        })
    }, [activePath, previewFormat])

    const requestRenamePreview = useCallback(() => {
        if (!renameTarget || renameTarget.name.trim() === '') return
        const target = renameTarget
        setRenameTarget(undefined)
        void previewRename(target.path, target.position, target.name.trim()).then(preview => {
            if (preview) setRenamePreview(preview)
        })
    }, [previewRename, renameTarget])

    const conflict = activeBuffer?.conflict

    return (
        <HStack
            gap={0}
            height='100%'
        >
            <VStack
                gap={0}
                width={EXPLORER_WIDTH}
                height='100%'
            >
                <VStack
                    paddingInline={3}
                    paddingBlock={2}
                >
                    <TextInput
                        label='Filter files'
                        isLabelHidden
                        size='sm'
                        placeholder='Filter files'
                        value={filter}
                        hasClear
                        onChange={setFilter}
                    />
                </VStack>
                <Divider />
                <StackItem
                    size='fill'
                    isScrollable
                >
                    {listed.length === 0 ?
                        <VStack padding={3}>
                            <Text
                                type='supporting'
                                color='secondary'
                            >
                                No files match. A worktree is only listed while a Godot session is
                                bound to it.
                            </Text>
                        </VStack>
                    :   listed.map(file => (
                            <Item
                                key={file.path}
                                as='div'
                                density='compact'
                                label={file.path}
                                labelLines={1}
                                onClick={() => {
                                    open(file.path)
                                }}
                            />
                        ))
                    }
                </StackItem>
            </VStack>
            <Divider orientation='vertical' />
            <StackItem size='fill'>
                <VStack
                    gap={0}
                    height='100%'
                >
                    <TabList
                        size='sm'
                        hasDivider
                        value={activePath ?? ''}
                        onChange={setActivePath}
                    >
                        {buffers.map(buffer => (
                            <Tab
                                key={buffer.path}
                                value={buffer.path}
                                label={tabLabel(buffer)}
                                endContent={
                                    diagnostics[buffer.path]?.length ?
                                        <Badge
                                            variant='error'
                                            label={String(diagnostics[buffer.path]?.length)}
                                        />
                                    :   undefined
                                }
                            />
                        ))}
                    </TabList>
                    <Toolbar
                        label='Script actions'
                        size='sm'
                        startContent={
                            <Text
                                type='supporting'
                                color='secondary'
                            >
                                {activeBuffer?.path ?? 'No script open'}
                            </Text>
                        }
                        endContent={
                            <HStack gap={1}>
                                <Button
                                    label='Save'
                                    size='sm'
                                    isDisabled={!activeBuffer?.dirty}
                                    clickAction={() => {
                                        if (activePath) save(activePath)
                                    }}
                                />
                                <Button
                                    label='Reload'
                                    size='sm'
                                    variant='ghost'
                                    isDisabled={!activeBuffer}
                                    clickAction={() => {
                                        if (activePath) void reloadBuffer(activePath)
                                    }}
                                />
                                <Button
                                    label='Format'
                                    size='sm'
                                    variant='ghost'
                                    isDisabled={!activeBuffer}
                                    clickAction={requestFormat}
                                />
                                <Button
                                    label='Close'
                                    size='sm'
                                    variant='ghost'
                                    isDisabled={!activeBuffer}
                                    clickAction={() => {
                                        if (activePath) closeBuffer(activePath)
                                    }}
                                />
                            </HStack>
                        }
                    />
                    {conflict ?
                        <Banner
                            container='section'
                            status='warning'
                            title='This buffer is out of date'
                            description={CONFLICT_MESSAGE[conflict]}
                            endContent={
                                <HStack gap={1}>
                                    <Button
                                        label='Reload from disk'
                                        size='sm'
                                        variant='ghost'
                                        clickAction={() => {
                                            if (activePath) void reloadBuffer(activePath)
                                        }}
                                    />
                                    <Button
                                        label='Overwrite'
                                        size='sm'
                                        clickAction={() => {
                                            if (activePath) void overwriteBuffer(activePath)
                                        }}
                                    />
                                </HStack>
                            }
                        />
                    :   null}
                    {activeBuffer ?
                        <ScriptEditor
                            buffer={activeBuffer}
                            diagnostics={activeDiagnostics}
                            openPaths={openPaths}
                            onChange={changeBuffer}
                            onError={onError}
                            onOpenPath={open}
                            onRename={startRename}
                            onSave={save}
                            onToggleBreakpoint={toggleBreakpoint}
                        />
                    :   <StackItem size='fill'>
                            <EmptyState
                                title='No script open'
                                description='Choose a file to edit it with Godot’s language server attached.'
                            />
                        </StackItem>
                    }
                </VStack>
            </StackItem>
            <Dialog
                isOpen={formatPreview !== undefined}
                purpose='form'
                width={880}
                onOpenChange={() => {
                    setFormatPreview(undefined)
                }}
            >
                <DialogHeader
                    title='Formatted with gdformat'
                    subtitle={
                        formatPreview?.changed ?
                            formatPreview.path
                        :   'The formatter changed nothing in this buffer.'
                    }
                    onOpenChange={() => {
                        setFormatPreview(undefined)
                    }}
                />
                {formatPreview ?
                    <MonacoDiff
                        path={formatPreview.path}
                        original={formatPreview.original}
                        modified={formatPreview.formatted}
                        height={DIFF_HEIGHT}
                    />
                :   null}
                <HStack
                    gap={2}
                    justify='end'
                    padding={3}
                >
                    <Button
                        label='Cancel'
                        variant='ghost'
                        clickAction={() => {
                            setFormatPreview(undefined)
                        }}
                    />
                    <Button
                        label='Apply to buffer'
                        isDisabled={!formatPreview?.changed}
                        clickAction={() => {
                            if (formatPreview) applyFormat(formatPreview)
                            setFormatPreview(undefined)
                        }}
                    />
                </HStack>
            </Dialog>
            <Dialog
                isOpen={renameTarget !== undefined}
                purpose='form'
                onOpenChange={() => {
                    setRenameTarget(undefined)
                }}
            >
                <DialogHeader
                    title='Rename symbol'
                    {...(renameTarget && {subtitle: renameTarget.path})}
                    onOpenChange={() => {
                        setRenameTarget(undefined)
                    }}
                />
                <VStack
                    gap={3}
                    padding={3}
                >
                    <TextInput
                        label='New name'
                        hasAutoFocus
                        value={renameTarget?.name ?? ''}
                        onChange={name => {
                            setRenameTarget(previous => (previous ? {...previous, name} : previous))
                        }}
                    />
                    <HStack
                        gap={2}
                        justify='end'
                    >
                        <Button
                            label='Cancel'
                            variant='ghost'
                            clickAction={() => {
                                setRenameTarget(undefined)
                            }}
                        />
                        <Button
                            label='Preview rename'
                            isDisabled={(renameTarget?.name ?? '').trim() === ''}
                            clickAction={requestRenamePreview}
                        />
                    </HStack>
                </VStack>
            </Dialog>
            <Dialog
                isOpen={renamePreview !== undefined}
                purpose='form'
                width={880}
                onOpenChange={() => {
                    setRenamePreview(undefined)
                }}
            >
                <DialogHeader
                    title={`Rename to ${renamePreview?.newName ?? ''}`}
                    subtitle={`${String(renamePreview?.files.length ?? 0)} file(s) would be rewritten as one transaction.`}
                    onOpenChange={() => {
                        setRenamePreview(undefined)
                    }}
                />
                <VStack
                    gap={3}
                    padding={3}
                >
                    {renamePreview?.files.map(file => (
                        <VStack
                            key={file.path}
                            gap={1}
                        >
                            <Text type='supporting'>{file.path}</Text>
                            <MonacoDiff
                                path={file.path}
                                original={file.originalText}
                                modified={file.updatedText}
                                height={DIFF_HEIGHT}
                            />
                        </VStack>
                    ))}
                    <HStack
                        gap={2}
                        justify='end'
                    >
                        <Button
                            label='Cancel'
                            variant='ghost'
                            clickAction={() => {
                                setRenamePreview(undefined)
                            }}
                        />
                        <Button
                            label='Apply rename'
                            isDisabled={renamePreview?.files.length === 0}
                            clickAction={() => {
                                if (renamePreview) void commitRename(renamePreview)
                                setRenamePreview(undefined)
                            }}
                        />
                    </HStack>
                </VStack>
            </Dialog>
        </HStack>
    )
}

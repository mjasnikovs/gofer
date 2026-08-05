import {useCallback, useState} from 'react'
import {Badge} from '@astryxdesign/core/Badge'
import {Banner} from '@astryxdesign/core/Banner'
import {Button} from '@astryxdesign/core/Button'
import {Dialog, DialogHeader} from '@astryxdesign/core/Dialog'
import {EmptyState} from '@astryxdesign/core/EmptyState'
import {HStack, StackItem, VStack} from '@astryxdesign/core/Stack'
import {Tab, TabList} from '@astryxdesign/core/TabList'
import {Text} from '@astryxdesign/core/Text'
import {TextInput} from '@astryxdesign/core/TextInput'
import {Toolbar} from '@astryxdesign/core/Toolbar'
import {invoke} from '../../services/desktop'
import type {
    FormatPreview,
    RenamePreview,
    ScriptBuffer,
    ScriptBuffers
} from '../../hooks/useScriptBuffers'
import type {ScriptPosition} from '../../models/script'
import {MonacoDiff} from './MonacoDiff'
import {ScriptEditor} from './ScriptEditor'

export type ScriptReveal = Readonly<{
    path: string
    line: number
    at: number
}>

type ScriptWorkspaceProps = Readonly<{
    /** Owned by the frame, so the Problems list and the AI agent see the same buffers. */
    scripts: ScriptBuffers
    reveal?: ScriptReveal | undefined
    onError: (message: string) => void
}>

type RenameTarget = Readonly<{
    path: string
    position: ScriptPosition
    name: string
}>

const DIFF_HEIGHT = 420

const CONFLICT_MESSAGE = {
    externalChange: 'This file changed on disk while the buffer was edited.',
    staleSave: 'The file changed since this buffer read it, so nothing was written.'
} as const

function tabLabel(buffer: ScriptBuffer) {
    const name = buffer.path.split('/').pop() ?? buffer.path
    return buffer.dirty ? `${name} •` : name
}

/**
 * The script editing surface: one tab per open buffer, with Monaco wired to Godot's language server
 * through Rust. Files are chosen in the workspace explorer, which owns the worktree listing.
 *
 * Everything destructive is explicit. A save is a command, never a side effect of typing; the
 * formatter and rename both show what they would write before anything is written; and a file that
 * changed underneath a dirty buffer raises a conflict rather than being overwritten.
 */
export function ScriptWorkspace({scripts, reveal, onError}: ScriptWorkspaceProps) {
    const {
        activeBuffer,
        activePath,
        buffers,
        diagnostics,
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
    } = scripts
    const [formatPreview, setFormatPreview] = useState<FormatPreview>()
    const [renameTarget, setRenameTarget] = useState<RenameTarget>()
    const [renamePreview, setRenamePreview] = useState<RenamePreview>()

    const openPaths = buffers.map(buffer => buffer.path)
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
        <VStack
            gap={0}
            height='100%'
        >
            <TabList
                size='sm'
                hasDivider
                aria-label='Open scripts'
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
                    {...(reveal && {reveal})}
                />
            :   <StackItem size='fill'>
                    <EmptyState
                        title='No script open'
                        description='Choose a file in the explorer to edit it with Godot’s language server attached.'
                    />
                </StackItem>
            }
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
        </VStack>
    )
}

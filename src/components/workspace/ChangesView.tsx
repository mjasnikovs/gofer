import {useCallback, useEffect, useMemo, useState} from 'react'
import {Banner} from '@astryxdesign/core/Banner'
import {Button} from '@astryxdesign/core/Button'
import {Divider} from '@astryxdesign/core/Divider'
import {Item} from '@astryxdesign/core/Item'
import {List} from '@astryxdesign/core/List'
import {HStack, StackItem, VStack} from '@astryxdesign/core/Stack'
import {Text} from '@astryxdesign/core/Text'
import {ToggleButton, ToggleButtonGroup} from '@astryxdesign/core/ToggleButton'
import {listTaskChanges, readTaskChange, toChangesError} from '../../services/task-changes'
import {
    FILTER_KINDS,
    KIND_LABELS,
    NO_CHANGES,
    STATUS_LABELS,
    countByKind,
    filterChanges,
    isGenerated
} from '../../models/changes'
import type {ChangedFile, FileDiff, TaskChanges} from '../../models/changes'
import type {FileKind} from '../../models/file-kinds'
import type {CommandError} from '../../models/errors'
import {MonacoDiff} from './MonacoDiff'
import {PanelState} from './PanelState'

/**
 * One opening of one file, and a counter that only ever goes up.
 *
 * The counter outlives the file on purpose. Reset when nothing is open, a read still in flight from
 * before a Refresh would carry the number the next file is about to be given, and answer for it.
 */
type Selection = Readonly<{file?: ChangedFile; attempt: number}>

/** An answer, carrying the opening that asked for it. */
type Answer<Value> = Readonly<{attempt: number; value: Value}>

type ChangesViewProps = Readonly<{
    isSideBySide: boolean
    onSideBySideChange: (isSideBySide: boolean) => void
}>

function countLabel(file: ChangedFile) {
    if (file.isBinary) return 'binary'
    if (file.added === 0 && file.removed === 0) return ''
    return `+${String(file.added)} −${String(file.removed)}`
}

function describe(file: ChangedFile) {
    const status = STATUS_LABELS[file.status]
    if (file.fromPath) return `${status} from ${file.fromPath}`
    return status
}

/** Why a file has no diff to draw, or nothing when it has one. */
function whyNotShown(diff: FileDiff) {
    if (diff.isSubmodule) return 'This is a submodule, so the change is which commit it points at.'
    if (diff.isTooLarge) return 'This file is too large to show side by side.'
    if (!diff.isText) return 'This file is not text, so there is nothing to compare line by line.'
    return undefined
}

export function ChangesView({isSideBySide, onSideBySideChange}: ChangesViewProps) {
    const [changes, setChanges] = useState<TaskChanges>()
    const [error, setError] = useState<CommandError>()
    const [isLoading, setIsLoading] = useState(true)
    const [kinds, setKinds] = useState<readonly FileKind[]>([])
    const [showGenerated, setShowGenerated] = useState(false)
    const [chosen, setChosen] = useState<Selection>(NOTHING_OPEN)
    const [diff, setDiff] = useState<Answer<FileDiff>>()
    const [diffError, setDiffError] = useState<Answer<CommandError>>()
    const [reads, setReads] = useState(0)

    useEffect(() => {
        let cancelled = false
        void listTaskChanges()
            .then(listed => {
                if (cancelled) return
                setChanges(listed)
                setError(undefined)
            })
            .catch((failure: unknown) => {
                if (cancelled) return
                setError(toChangesError(failure))
                setChanges(undefined)
            })
            .finally(() => {
                if (!cancelled) setIsLoading(false)
            })
        return () => {
            cancelled = true
        }
    }, [reads])

    useEffect(() => {
        const {file, attempt} = chosen
        if (!file) return undefined
        let cancelled = false
        void readTaskChange(file.path)
            .then(read => {
                if (!cancelled) setDiff({attempt, value: read})
            })
            .catch((failure: unknown) => {
                if (!cancelled) setDiffError({attempt, value: toChangesError(failure)})
            })
        return () => {
            cancelled = true
        }
    }, [chosen])

    const refresh = useCallback(() => {
        setIsLoading(true)
        setChosen(previous => ({attempt: previous.attempt + 1}))
        setReads(count => count + 1)
    }, [])

    // Compared by path, not by identity: `shown` filters the same objects, so clicking the row that
    // is already open hands React the value it already holds and it skips the update. The counter
    // is what tells one opening of a file from the next.
    const choose = useCallback((file: ChangedFile) => {
        setChosen(previous =>
            previous.file?.path === file.path ? previous : {file, attempt: previous.attempt + 1}
        )
    }, [])

    const listed = changes ?? NO_CHANGES
    const counts = useMemo(
        () => countByKind(listed.files, showGenerated),
        [listed.files, showGenerated]
    )
    // A kind only has a button while something on screen is that kind. Kept filtering after its
    // button went — Refresh, or hiding the sidecars that were the only config — it would empty the
    // list with no visible filter and no control to clear.
    const active = useMemo(() => kinds.filter(kind => counts.has(kind)), [counts, kinds])
    const shown = useMemo(
        () => filterChanges(listed.files, active, showGenerated),
        [active, listed.files, showGenerated]
    )
    // Counted off the whole listing, not off what is shown: derived from the filtered counts the
    // toggle would vanish the moment it was switched on, taking the way back with it.
    const generated = useMemo(() => listed.files.filter(isGenerated).length, [listed.files])

    // Answers are matched to the selection that asked for them, not to the path. Matched by path
    // alone, reopening a file that failed once would show that failure again before the fresh read
    // it is about to succeed at has answered — and a row the filter has since hidden would keep its
    // diff on screen under a list that no longer holds it.
    const open = shown.some(file => file.path === chosen.file?.path) ? chosen : undefined
    const current = open && diff?.attempt === open.attempt ? diff.value : undefined
    const failure = open && diffError?.attempt === open.attempt ? diffError.value : undefined

    return (
        <VStack
            gap={0}
            height='100%'
        >
            <HStack
                gap={3}
                padding={3}
                align='center'
            >
                <StackItem size='fill'>
                    <Text
                        type='supporting'
                        color='secondary'
                    >
                        Everything this task changed, since it began.
                    </Text>
                </StackItem>
                <ToggleButtonGroup
                    size='sm'
                    type='single'
                    label='How to lay the diff out'
                    value={isSideBySide ? 'split' : 'inline'}
                    onChange={value => {
                        // The group deselects on a second click and answers nothing. A layout has
                        // to be one or the other, so pressing the lit button keeps what it says.
                        if (value !== null) onSideBySideChange(value === 'split')
                    }}
                >
                    <ToggleButton
                        value='split'
                        label='Split'
                    />
                    <ToggleButton
                        value='inline'
                        label='Inline'
                    />
                </ToggleButtonGroup>
                <Button
                    label='Refresh'
                    size='sm'
                    isDisabled={isLoading}
                    clickAction={refresh}
                />
            </HStack>
            {listed.isMerging ?
                <Banner
                    container='section'
                    status='warning'
                    title='This task is part-way through a merge'
                    description='Files marked conflicted hold both versions, so their diff is what Git wrote rather than what the task did.'
                />
            :   null}
            <Divider />
            {listed.files.length > 0 && error === undefined && !isLoading ?
                <StackItem size='static'>
                    <HStack
                        gap={2}
                        padding={3}
                        align='center'
                        isScrollable
                    >
                        <ToggleButtonGroup
                            size='sm'
                            type='multiple'
                            label='Which kinds of file to show'
                            value={[...active]}
                            onChange={value => {
                                setKinds(value as readonly FileKind[])
                            }}
                        >
                            {FILTER_KINDS.filter(kind => counts.has(kind)).map(kind => (
                                <ToggleButton
                                    key={kind}
                                    value={kind}
                                    label={`${KIND_LABELS[kind]} ${String(counts.get(kind) ?? 0)}`}
                                />
                            ))}
                        </ToggleButtonGroup>
                        {generated > 0 ?
                            <ToggleButton
                                size='sm'
                                label={`Generated ${String(generated)}`}
                                isPressed={showGenerated}
                                onPressedChange={setShowGenerated}
                            />
                        :   null}
                    </HStack>
                </StackItem>
            :   null}
            <PanelState
                label='changed files'
                isLoading={isLoading}
                error={error}
                isEmpty={shown.length === 0}
                emptyTitle={
                    listed.files.length === 0 ? 'Nothing has changed yet' : 'Nothing matches'
                }
                emptyDescription={
                    listed.files.length === 0 ?
                        'Once this task edits a file it appears here, next to the version it started from.'
                    :   'This task changed files, but everything it changed is hidden right now.'
                }
            >
                <StackItem
                    size='static'
                    isScrollable
                    style={LIST_STYLE}
                >
                    <List aria-label='Changed files'>
                        {shown.map(file => (
                            <Item
                                key={file.path}
                                as='li'
                                density='compact'
                                layout='inline'
                                label={file.path}
                                description={describe(file)}
                                isSelected={chosen.file?.path === file.path}
                                endContent={
                                    <Text
                                        type='supporting'
                                        color='secondary'
                                    >
                                        {file.isConflicted ? 'conflicted' : countLabel(file)}
                                    </Text>
                                }
                                onClick={() => {
                                    choose(file)
                                }}
                            />
                        ))}
                    </List>
                    {listed.dropped > 0 ?
                        <Text
                            type='supporting'
                            color='secondary'
                        >
                            {`${String(listed.dropped)} more changed files are not listed here.`}
                        </Text>
                    :   null}
                </StackItem>
                <Divider />
                <ChosenDiff
                    file={open?.file}
                    diff={current}
                    error={failure}
                    isSideBySide={isSideBySide}
                />
            </PanelState>
        </VStack>
    )
}

const LIST_STYLE = {maxHeight: '40%'} as const

const NOTHING_OPEN: Selection = {attempt: 0}

type ChosenDiffProps = Readonly<{
    file: ChangedFile | undefined
    diff: FileDiff | undefined
    error: CommandError | undefined
    isSideBySide: boolean
}>

function ChosenDiff({file, diff, error, isSideBySide}: ChosenDiffProps) {
    if (!file)
        return (
            <StackItem size='fill'>
                <VStack padding={3}>
                    <Text
                        type='supporting'
                        color='secondary'
                    >
                        Choose a file to see it beside the version this task started from.
                    </Text>
                </VStack>
            </StackItem>
        )
    if (error)
        return (
            <Banner
                container='section'
                status={error.retryable ? 'warning' : 'error'}
                title='That file could not be read'
                description={`${error.message} (${error.code})`}
            />
        )
    if (!diff)
        return (
            <StackItem size='fill'>
                <VStack padding={3}>
                    <Text
                        type='supporting'
                        color='secondary'
                        role='status'
                    >
                        {`Loading ${file.path}…`}
                    </Text>
                </VStack>
            </StackItem>
        )
    const refused = whyNotShown(diff)
    if (refused)
        return (
            <StackItem size='fill'>
                <VStack padding={3}>
                    <Text color='secondary'>{refused}</Text>
                </VStack>
            </StackItem>
        )
    return (
        <MonacoDiff
            path={diff.path}
            original={diff.original}
            modified={diff.modified}
            height='fill'
            isSideBySide={isSideBySide}
            testId='task-change-diff-host'
        />
    )
}

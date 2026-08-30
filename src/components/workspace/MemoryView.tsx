import {useCallback, useEffect, useMemo, useRef, useState} from 'react'
import {Button} from '@astryxdesign/core/Button'
import {Collapsible, CollapsibleGroup} from '@astryxdesign/core/Collapsible'
import {Divider} from '@astryxdesign/core/Divider'
import {SegmentedControl, SegmentedControlItem} from '@astryxdesign/core/SegmentedControl'
import {Selector} from '@astryxdesign/core/Selector'
import {HStack, StackItem, VStack} from '@astryxdesign/core/Stack'
import {Spinner} from '@astryxdesign/core/Spinner'
import {StatusDot} from '@astryxdesign/core/StatusDot'
import {Text} from '@astryxdesign/core/Text'
import {TextArea} from '@astryxdesign/core/TextArea'
import {Token} from '@astryxdesign/core/Token'
import {
    deleteProjectMemory,
    judgeProjectMemory,
    listProjectMemory,
    saveProjectMemory,
    setMemoryStates,
    stopMemoryJudge,
    sweepProjectMemory,
    toMemoryError,
    watchMemoryJudge,
    watchMemorySweep
} from '../../services/project-memory'
import {
    MEMORY_KINDS,
    checkSummary,
    isBroken,
    isRetrievable,
    isUnjudged,
    missingAnchors,
    verdictSummary
} from '../../models/memory'
import type {
    MemoryCheck,
    MemoryEdit,
    MemoryKind,
    MemoryState,
    MemoryVerdict,
    ProjectMemory
} from '../../models/memory'
import type {CommandError} from '../../models/errors'
import {PanelState} from './PanelState'

const PREVIEW_LENGTH = 110

type MemoryFilter = 'all' | 'review' | 'broken'

const DOT: Readonly<Record<MemoryCheck, 'success' | 'warning' | 'neutral'>> = {
    intact: 'success',
    stale: 'warning',
    unanchored: 'neutral',
    unchecked: 'neutral'
}

const VERDICT_COLOUR: Readonly<Record<MemoryVerdict, 'green' | 'red' | 'gray'>> = {
    holds: 'green',
    broken: 'red',
    unclear: 'gray'
}

type Judging = Readonly<{
    memoryId: string
    requestId: number
    line: string
}>

type Sweeping = Readonly<{
    requestId: number
    done: number
    total: number
}>

function preview(content: string): string {
    const line = content.replace(/\s+/gu, ' ').trim()
    return line.length > PREVIEW_LENGTH ? `${line.slice(0, PREVIEW_LENGTH)}…` : line
}

function withoutTurnLabels(content: string): string {
    return content.replace(/^User request:\s*/u, '').replace(/\n+Outcome:\s*/u, ' → ')
}

function draftOf(memory: ProjectMemory): MemoryEdit {
    return {id: memory.id, kind: memory.kind, state: memory.state, content: memory.content}
}

export function MemoryView() {
    const [memories, setMemories] = useState<readonly ProjectMemory[]>()
    const [error, setError] = useState<CommandError>()
    const [isLoading, setIsLoading] = useState(true)
    const [filter, setFilter] = useState<MemoryFilter>('all')
    const [openId, setOpenId] = useState<string>()
    const [draft, setDraft] = useState<MemoryEdit>()
    const [isSaving, setIsSaving] = useState(false)
    const [judging, setJudging] = useState<Judging>()
    const [sweeping, setSweeping] = useState<Sweeping>()
    const sweepRequest = useRef<number>(undefined)
    const [judgeFailure, setJudgeFailure] = useState<{memoryId: string; reason: string}>()

    const [reads, setReads] = useState(0)

    useEffect(() => {
        let cancelled = false
        void listProjectMemory()
            .then(rows => {
                if (cancelled) return
                setMemories(rows)
                setError(undefined)
            })
            .catch((failure: unknown) => {
                if (cancelled) return
                setError(toMemoryError(failure))
                setMemories(undefined)
            })
            .finally(() => {
                if (!cancelled) setIsLoading(false)
            })
        return () => {
            cancelled = true
        }
    }, [reads])

    const recheck = useCallback(() => {
        setIsLoading(true)
        setReads(count => count + 1)
    }, [])

    useEffect(() => {
        let stop: (() => void) | undefined
        let cancelled = false
        void watchMemoryJudge(event => {
            if (event.type === 'judge-step')
                setJudging(current =>
                    current?.memoryId === event.memoryId ?
                        {...current, line: event.line ?? current.line}
                    :   current
                )
            if (event.type === 'judge-verdict') setReads(count => count + 1)
            if (event.type === 'judge-failed' || event.type === 'judge-stopped') {
                if (event.type === 'judge-failed')
                    setJudgeFailure(current =>
                        current?.memoryId === event.memoryId ?
                            current
                        :   {
                                memoryId: event.memoryId,
                                reason: event.reason ?? 'the judge stopped'
                            }
                    )
                setJudging(current => (current?.memoryId === event.memoryId ? undefined : current))
            }
        }).then(unlisten => {
            if (cancelled) unlisten()
            else stop = unlisten
        })
        return () => {
            cancelled = true
            stop?.()
        }
    }, [])

    useEffect(() => {
        let stop: (() => void) | undefined
        let cancelled = false
        void watchMemorySweep(event => {
            setSweeping(current =>
                current === undefined ? current : {...current, done: event.done, total: event.total}
            )
            if (event.type !== 'sweep-progress') return
            const memoryId = event.memoryId
            if (memoryId === undefined) return
            setJudgeFailure(undefined)
            setJudging(current => {
                const requestId = current?.requestId ?? sweepRequest.current
                return requestId === undefined ? current : (
                        {memoryId, requestId, line: 'starting the sub-agent…'}
                    )
            })
        }).then(unlisten => {
            if (cancelled) unlisten()
            else stop = unlisten
        })
        return () => {
            cancelled = true
            stop?.()
        }
    }, [])

    const judge = useCallback((memory: ProjectMemory) => {
        const requestId = Date.now()
        setJudgeFailure(undefined)
        setJudging({memoryId: memory.id, requestId, line: 'starting the sub-agent…'})
        void judgeProjectMemory({requestId, memoryId: memory.id})
            .then(judged => {
                setMemories(rows => (rows ?? []).map(row => (row.id === judged.id ? judged : row)))
            })
            .catch((failure: unknown) => {
                setJudgeFailure(current =>
                    current?.memoryId === memory.id ?
                        current
                    :   {memoryId: memory.id, reason: toMemoryError(failure).message}
                )
            })
            .finally(() => {
                setJudging(current => (current?.memoryId === memory.id ? undefined : current))
            })
    }, [])

    const stopJudging = useCallback(() => {
        const requestId = judging?.requestId ?? sweeping?.requestId
        if (requestId !== undefined) void stopMemoryJudge(requestId)
    }, [judging, sweeping])

    const open = useCallback(
        (value: string | string[]) => {
            const id = Array.isArray(value) ? value[0] : value
            const chosen = (memories ?? []).find(memory => memory.id === id)
            setOpenId(chosen?.id)
            setDraft(chosen && draftOf(chosen))
        },
        [memories]
    )

    const save = useCallback(() => {
        if (!draft) return
        setIsSaving(true)
        void saveProjectMemory(draft)
            .then(saved => {
                setMemories(rows => (rows ?? []).map(row => (row.id === saved.id ? saved : row)))
                setDraft(draftOf(saved))
                setError(undefined)
            })
            .catch((failure: unknown) => {
                setError(toMemoryError(failure))
            })
            .finally(() => {
                setIsSaving(false)
            })
    }, [draft])

    const forget = useCallback((id: string) => {
        setIsSaving(true)
        void deleteProjectMemory(id)
            .then(() => {
                setMemories(rows => (rows ?? []).filter(row => row.id !== id))
                setOpenId(undefined)
                setDraft(undefined)
                setError(undefined)
            })
            .catch((failure: unknown) => {
                setError(toMemoryError(failure))
            })
            .finally(() => {
                setIsSaving(false)
            })
    }, [])

    const all = useMemo(() => memories ?? [], [memories])
    const needingReview = useMemo(() => all.filter(memory => memory.check === 'stale'), [all])
    const broken = useMemo(() => all.filter(isBroken), [all])
    const unjudged = useMemo(() => all.filter(isUnjudged), [all])
    const shown =
        filter === 'review' ? needingReview
        : filter === 'broken' ? broken
        : all
    const given = all.filter(isRetrievable).length

    const sweep = useCallback(() => {
        const memoryIds = unjudged.map(memory => memory.id)
        if (memoryIds.length === 0) return
        const requestId = Date.now()
        setJudgeFailure(undefined)
        sweepRequest.current = requestId
        setSweeping({requestId, done: 0, total: memoryIds.length})
        const first = memoryIds[0]
        if (first !== undefined)
            setJudging({memoryId: first, requestId, line: 'starting the sub-agent…'})
        void sweepProjectMemory({requestId, memoryIds})
            .then(() => {
                setError(undefined)
            })
            .catch((failure: unknown) => {
                setError(toMemoryError(failure))
            })
            .finally(() => {
                sweepRequest.current = undefined
                setSweeping(undefined)
                setJudging(current => (current?.requestId === requestId ? undefined : current))
                setReads(count => count + 1)
            })
    }, [unjudged])

    const holdBackBroken = useCallback(() => {
        const ids = broken.map(memory => memory.id)
        if (ids.length === 0) return
        setIsSaving(true)
        void setMemoryStates(ids, 'candidate')
            .then(moved => {
                const byId = new Map(moved.map(row => [row.id, row]))
                setMemories(rows => (rows ?? []).map(row => byId.get(row.id) ?? row))
                setError(undefined)
            })
            .catch((failure: unknown) => {
                setError(toMemoryError(failure))
            })
            .finally(() => {
                setIsSaving(false)
            })
    }, [broken])

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
                <SegmentedControl
                    size='sm'
                    label='Which memories to show'
                    value={filter}
                    onChange={value => {
                        setFilter(value as MemoryFilter)
                    }}
                >
                    <SegmentedControlItem
                        value='all'
                        label={`All ${String(all.length)}`}
                    />
                    <SegmentedControlItem
                        value='review'
                        label={`Needs review ${String(needingReview.length)}`}
                    />
                    <SegmentedControlItem
                        value='broken'
                        label={`Model says broken ${String(broken.length)}`}
                    />
                </SegmentedControl>
                <StackItem size='fill'>
                    <Text
                        type='supporting'
                        color='secondary'
                    >
                        {`${String(given)} of these reach the model. A turn is given six.`}
                    </Text>
                </StackItem>
                {sweeping ?
                    <>
                        <HStack
                            gap={2}
                            align='center'
                            role='status'
                        >
                            <Spinner size='sm' />
                            <Text
                                type='supporting'
                                color='secondary'
                            >
                                {`Asking the model about ${String(sweeping.done + 1)} of ${String(sweeping.total)}. Chat waits for this.`}
                            </Text>
                        </HStack>
                        <Button
                            label='Stop'
                            size='sm'
                            clickAction={stopJudging}
                        />
                    </>
                :   <>
                        <Button
                            label='Recheck'
                            size='sm'
                            isDisabled={isLoading}
                            clickAction={recheck}
                        />
                        <Button
                            label={
                                unjudged.length === 0 ?
                                    'Every memory has a verdict'
                                :   `Ask the model about ${String(unjudged.length)}`
                            }
                            size='sm'
                            variant='primary'
                            isDisabled={isLoading || unjudged.length === 0 || Boolean(judging)}
                            clickAction={sweep}
                        />
                    </>
                }
            </HStack>
            {filter === 'broken' && broken.length > 0 && (
                <>
                    <Divider />
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
                                Holding one back stops retrieval reading it. Its words and the
                                model&apos;s reason are kept.
                            </Text>
                        </StackItem>
                        <Button
                            label={`Hold back all ${String(broken.length)}`}
                            size='sm'
                            isDisabled={isSaving || Boolean(sweeping)}
                            clickAction={holdBackBroken}
                        />
                    </HStack>
                </>
            )}
            <Divider />
            <StackItem
                size='fill'
                isScrollable
            >
                <PanelState
                    label='project memory'
                    isLoading={isLoading}
                    error={error}
                    isEmpty={shown.length === 0}
                    emptyTitle={
                        filter === 'review' ? 'Nothing to review'
                        : filter === 'broken' ?
                            'The model has not called anything broken'
                        :   'This project remembers nothing'
                    }
                    emptyDescription={
                        filter === 'review' ?
                            'Every memory names files the workspace still has, or names none at all.'
                        : filter === 'broken' ?
                            'A row lands here once a sub-agent has read the code and said it no longer holds.'
                        :   'A memory is written when a turn finishes. Six are read back into every prompt.'

                    }
                >
                    <CollapsibleGroup
                        type='single'
                        hasDividers
                        value={openId ?? ''}
                        onChange={open}
                    >
                        {shown.map(memory => (
                            <Collapsible
                                key={memory.id}
                                value={memory.id}
                                trigger={
                                    <VStack gap={1}>
                                        <Text>{preview(withoutTurnLabels(memory.content))}</Text>
                                        <HStack
                                            gap={2}
                                            align='center'
                                        >
                                            <StatusDot
                                                variant={DOT[memory.check]}
                                                label={checkSummary(memory)}
                                            />
                                            <Text
                                                type='supporting'
                                                color='secondary'
                                                aria-hidden
                                            >
                                                {checkSummary(memory)}
                                            </Text>
                                            <Token
                                                size='sm'
                                                label={memory.kind}
                                            />
                                            {memory.judgement && (
                                                <Token
                                                    size='sm'
                                                    color={VERDICT_COLOUR[memory.judgement.verdict]}
                                                    label={`model: ${memory.judgement.verdict}`}
                                                    description={verdictSummary(memory.judgement)}
                                                />
                                            )}
                                            {!isRetrievable(memory) && (
                                                <Token
                                                    size='sm'
                                                    color='gray'
                                                    label={`${memory.state} · not given to the model`}
                                                />
                                            )}
                                            <Text
                                                type='supporting'
                                                color='secondary'
                                            >
                                                {new Date(memory.updatedAt).toLocaleString()}
                                            </Text>
                                        </HStack>
                                    </VStack>
                                }
                            >
                                {draft?.id === memory.id && (
                                    <MemoryEditor
                                        memory={memory}
                                        draft={draft}
                                        isSaving={isSaving}
                                        isSweeping={Boolean(sweeping)}
                                        {...(judging?.memoryId === memory.id && {judging})}
                                        {...(judgeFailure?.memoryId === memory.id && {
                                            judgeFailure: judgeFailure.reason
                                        })}
                                        onChange={setDraft}
                                        onSave={save}
                                        onJudge={() => {
                                            judge(memory)
                                        }}
                                        onStopJudging={stopJudging}
                                        onForget={() => {
                                            forget(memory.id)
                                        }}
                                    />
                                )}
                            </Collapsible>
                        ))}
                    </CollapsibleGroup>
                </PanelState>
            </StackItem>
        </VStack>
    )
}

type MemoryEditorProps = Readonly<{
    memory: ProjectMemory
    draft: MemoryEdit
    isSaving: boolean
    isSweeping: boolean
    judging?: Judging | undefined
    judgeFailure?: string | undefined
    onChange: (draft: MemoryEdit) => void
    onSave: () => void
    onJudge: () => void
    onStopJudging: () => void
    onForget: () => void
}>

function MemoryEditor({
    memory,
    draft,
    isSaving,
    isSweeping,
    judging,
    judgeFailure,
    onChange,
    onSave,
    onJudge,
    onStopJudging,
    onForget
}: MemoryEditorProps) {
    const missing = missingAnchors(memory)
    const isUnchanged =
        draft.content === memory.content
        && draft.kind === memory.kind
        && draft.state === memory.state
    const isBusy = isSaving || Boolean(judging) || isSweeping

    return (
        <VStack
            gap={3}
            padding={3}
        >
            {missing.length > 0 && (
                <Text
                    type='supporting'
                    color='secondary'
                >
                    {`Not in the workspace: ${missing.join(', ')}. That is all this check measured — a memory about deleting a file names one too.`}
                </Text>
            )}
            {memory.judgement && (
                <VStack gap={1}>
                    <Text type='label'>{verdictSummary(memory.judgement)}</Text>
                    <Text
                        type='supporting'
                        color='secondary'
                    >
                        {memory.judgement.reason}
                    </Text>
                    <Text
                        type='supporting'
                        color='secondary'
                    >
                        {`${memory.judgement.model} · ${new Date(memory.judgement.at).toLocaleString()}`}
                    </Text>
                </VStack>
            )}
            {judging && (
                <HStack
                    gap={2}
                    align='center'
                    role='status'
                >
                    <Spinner size='sm' />
                    <Text
                        type='supporting'
                        color='secondary'
                    >
                        {judging.line}
                    </Text>
                </HStack>
            )}
            {judgeFailure !== undefined && !judging && (
                <Text
                    type='supporting'
                    color='secondary'
                >
                    {`The judge did not finish: ${judgeFailure}`}
                </Text>
            )}
            <TextArea
                label='What is remembered'
                size='sm'
                rows={8}
                value={draft.content}
                onChange={content => {
                    onChange({...draft, content})
                }}
            />
            <HStack
                gap={3}
                align='end'
            >
                <Selector
                    size='sm'
                    label='Kind'
                    value={draft.kind}
                    options={[...MEMORY_KINDS]}
                    onChange={kind => {
                        onChange({...draft, kind: kind as MemoryKind})
                    }}
                />
                <SegmentedControl
                    size='sm'
                    label='Whether the model is given this memory'
                    value={draft.state}
                    onChange={state => {
                        onChange({...draft, state: state as MemoryState})
                    }}
                >
                    <SegmentedControlItem
                        value='confirmed'
                        label='Given to the model'
                    />
                    <SegmentedControlItem
                        value='candidate'
                        label='Held back'
                    />
                    <SegmentedControlItem
                        value='superseded'
                        label='Replaced'
                    />
                </SegmentedControl>
                <StackItem size='fill'>
                    <HStack
                        gap={2}
                        justify='end'
                    >
                        {judging ?
                            <Button
                                label='Stop'
                                size='sm'
                                clickAction={onStopJudging}
                            />
                        :   <Button
                                label={memory.judgement ? 'Ask again' : 'Ask the model'}
                                size='sm'
                                isDisabled={isBusy}
                                clickAction={onJudge}
                            />
                        }
                        <Button
                            label='Forget'
                            size='sm'
                            isDisabled={isBusy}
                            clickAction={onForget}
                        />
                        <Button
                            label='Save'
                            size='sm'
                            variant='primary'
                            isDisabled={isBusy || isUnchanged}
                            clickAction={onSave}
                        />
                    </HStack>
                </StackItem>
            </HStack>
        </VStack>
    )
}

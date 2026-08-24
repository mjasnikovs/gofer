import {useCallback, useEffect, useRef, useState} from 'react'
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

/** How much of a memory the closed row shows. Two of these rows measured over 2,000 characters. */
const PREVIEW_LENGTH = 110

/** Which rows the list is showing. `review` and `broken` are the reason the screen exists. */
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

/** What one running judgement is doing, and the turn it runs as so Stop can reach it. */
type Judging = Readonly<{
    memoryId: string
    requestId: number
    line: string
}>

/** A sweep in flight: the turn Stop reaches, and how far through the list it is. */
type Sweeping = Readonly<{
    requestId: number
    done: number
    total: number
}>

function preview(content: string): string {
    const line = content.replace(/\s+/gu, ' ').trim()
    return line.length > PREVIEW_LENGTH ? `${line.slice(0, PREVIEW_LENGTH)}…` : line
}

/**
 * A memory's own words, not the wrapper a finished turn put them in.
 *
 * Every row a turn deposits reads `User request: … Outcome: …`, so a list of them is a column of
 * the same two words. The label is dropped from the preview and kept in the editor, where the user
 * is reading the whole thing anyway.
 */
function withoutTurnLabels(content: string): string {
    return content.replace(/^User request:\s*/u, '').replace(/\n+Outcome:\s*/u, ' → ')
}

function draftOf(memory: ProjectMemory): MemoryEdit {
    return {id: memory.id, kind: memory.kind, state: memory.state, content: memory.content}
}

/**
 * What the project remembers, and what checking it against the workspace found.
 *
 * Six of these rows are read into the front of every turn's prompt. Until this screen there was no
 * way to see which six, and no way to correct one that had stopped being true — a memory written by
 * a turn a month ago was as authoritative as one written this morning, and it was invisible.
 *
 * There are two checks and they cost different things. The path check runs with the read rather
 * than behind a button, because it is a directory walk: it reports where files are and nothing
 * more, and a row is marked as naming a file the workspace does not have, never as being wrong,
 * because a memory whose whole subject is a deletion names a file that is correctly gone. The model
 * check is a minute a row and is asked for — one row from its own editor, or the whole list from
 * the sweep. What a sweep leaves behind is triage: `broken` rows to read, and one press to stop
 * retrieval reading them.
 */
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
    // The running sweep's own id, held where the event listener can read it. The listener is
    // registered once, so the state it would otherwise close over is the state at registration.
    const sweepRequest = useRef<number>(undefined)
    // Which memory the failure was about, not only what it said. One string for the whole panel
    // was drawn for whichever row happened to be open, so a judgement that failed on one memory
    // reported itself against another that was never judged at all.
    const [judgeFailure, setJudgeFailure] = useState<{memoryId: string; reason: string}>()

    const [reads, setReads] = useState(0)

    // The read is the check: one listing walks the worktree and answers with every verdict. Nothing
    // is set synchronously here — `isLoading` is already true on mount, and Recheck raises it again
    // from the click, which is where a state change belongs.
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

    // The live line, and the two endings the panel has to hear about. A verdict is not read from
    // here: the backend files it and answers the call with the stored row, so what is drawn is what
    // survived rather than what was reported.
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
            // A verdict is filed on the Rust side before this event leaves it, so the list can be
            // read again and the row will carry it. That is done rather than patching the row from
            // the event for the reason nothing else here is drawn from one: the panel would be
            // showing what was reported, not what was stored. It matters for a sweep, where the
            // alternative is an hour of a list that does not move.
            if (event.type === 'judge-verdict') setReads(count => count + 1)
            // Both endings clear the row, and only one of them has anything to say. The event is
            // the first ending to arrive — the call behind it rejects afterwards — and the first
            // ending is the one kept, because it is the one that names what actually happened.
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

    // A sweep's own count, and which row it has reached. The per-row spinner is still the judge's
    // event: this is what turns the header into "31 of 84" and hands the next row to the editor.
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
            // Armed from the sweep, not from whatever row was being drawn a moment ago. A failure
            // clears `judging`, and this only ever moved a spinner that was already there — so the
            // first `judge-failed` in an eighty-four row sweep took the spinner away for the rest
            // of the hour, while the run went on and the header counted up.
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
        // The same id the brief uses. The backend cancels a turn by it, and a counter that restarts
        // hands a later turn the id of a stopped one.
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
        // One id whether a row or the whole list is running, because there is one turn either way.
        // Stopping from an open row during a sweep ends the sweep, which is the truth of it.
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

    const all = memories ?? []
    const needingReview = all.filter(memory => memory.check === 'stale')
    const broken = all.filter(isBroken)
    const unjudged = all.filter(isUnjudged)
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
                // The rows the sweep answers with are the same rows a read gives, and the read is
                // the one path that also recomputes the path check. One way in, one shape out.
                setReads(count => count + 1)
            })
    }, [unjudged])

    // Held back, not forgotten. `candidate` stops retrieval reading the row and keeps every word of
    // it, along with the verdict and the reason — which is what someone wondering later why the
    // model stopped being told this will want, and what deleting would have thrown away.
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
    /** Whether the whole list is being judged, which is one turn this row cannot start beside. */
    isSweeping: boolean
    /** Present only while this memory is the one being judged. */
    judging?: Judging | undefined
    judgeFailure?: string | undefined
    onChange: (draft: MemoryEdit) => void
    onSave: () => void
    onJudge: () => void
    onStopJudging: () => void
    onForget: () => void
}>

/**
 * One memory, open for correcting.
 *
 * `state` is offered beside the text because it is usually the answer. A memory that is merely
 * unhelpful does not need rewriting or deleting — moving it off `confirmed` stops retrieval reading
 * it, and keeps what it says for whoever wonders later why it was muted.
 */
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

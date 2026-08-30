import {useCallback, useEffect, useRef, useState} from 'react'
import {EMPTY_BRIEF_STATE, SPECIFICATION_FIELD, applyBriefEvent, endBriefRun} from '../models/brief'
import {invoke} from '../services/desktop'
import {readTaskBrief, runTaskBrief, watchBrief} from '../services/brief'
import {setTurnRunning} from '../services/turn-activity'
import {commandErrorMessage} from '../utils/command-error'
import type {BriefState} from '../models/brief'
import type {ChatAttachment} from '../models/chat'

type PlannedAsk = Readonly<{prompt: string; attachments: readonly ChatAttachment[]}>

type TaskBriefOptions = Readonly<{
    taskId?: string | undefined
    onStartTurn: (prompt: string, attachments: readonly ChatAttachment[]) => void
    onError: (message: string) => void
}>

export function useTaskBrief({taskId, onStartTurn, onError}: TaskBriefOptions) {
    const [briefState, setBriefState] = useState<BriefState>(EMPTY_BRIEF_STATE)
    const [asked, setAsked] = useState<PlannedAsk>()
    const [plannedTask, setPlannedTask] = useState<string>()
    const requestId = useRef(0)
    const askedFor = useRef<PlannedAsk | undefined>(undefined)
    const startTurn = useRef(onStartTurn)
    const report = useRef(onError)
    useEffect(() => {
        startTurn.current = onStartTurn
        report.current = onError
    }, [onStartTurn, onError])

    useEffect(() => {
        if (!taskId || asked === undefined) return undefined

        let isCancelled = false
        let dispose: (() => void) | undefined
        let specification: string | undefined
        let hasEnded = false
        const sendSpecification = () => {
            if (isCancelled || !hasEnded || specification === undefined) return
            const prompt = specification
            specification = undefined
            startTurn.current(prompt, asked.attachments)
        }

        void watchBrief(event => {
            if (isCancelled) return
            setBriefState(previous => applyBriefEvent(previous, event))
            if (event.type === 'brief-phase' && event.field === SPECIFICATION_FIELD) {
                specification = event.value
                sendSpecification()
            }
        }).then(unlisten => {
            if (isCancelled) unlisten()
            else dispose = unlisten
        })

        askedFor.current = asked
        requestId.current = Date.now()
        void runTaskBrief({
            requestId: requestId.current,
            taskId,
            prompt: asked.prompt,
            attachments: asked.attachments
        })
            .catch((error: unknown) => {
                if (isCancelled) return
                const reason = commandErrorMessage(error)
                report.current(`The plan could not run: ${reason}`)
                setBriefState(previous =>
                    applyBriefEvent(previous, {type: 'brief-failed', phase: 'startup', reason})
                )
            })
            .finally(() => {
                hasEnded = true
                sendSpecification()
                if (isCancelled) return
                setBriefState(endBriefRun)
            })

        return () => {
            isCancelled = true
            dispose?.()
        }
    }, [taskId, asked])

    const startPlan = useCallback((prompt: string, attachments: readonly ChatAttachment[] = []) => {
        const ask = prompt.trim()
        if (!ask) return
        setAsked(previous => previous ?? {prompt: ask, attachments})
    }, [])

    const stopBrief = useCallback(() => {
        if (requestId.current === 0) return
        void invoke('cancel_ai_request', {requestId: requestId.current}).catch(() => undefined)
    }, [])

    const startWithoutPlan = useCallback(() => {
        const ask = askedFor.current
        if (!ask) return
        startTurn.current(ask.prompt, ask.attachments)
        askedFor.current = undefined
        setBriefState(EMPTY_BRIEF_STATE)
    }, [])

    useEffect(() => {
        if (!taskId) return
        let isCancelled = false
        void readTaskBrief(taskId)
            .then(run => {
                if (isCancelled || !run) return
                setPlannedTask(taskId)
            })
            .catch(() => undefined)
        return () => {
            isCancelled = true
        }
    }, [taskId])

    useEffect(() => {
        setTurnRunning('brief', briefState.isRunning)
        return () => {
            setTurnRunning('brief', false)
        }
    }, [briefState.isRunning])

    return {
        briefState,
        isPlanStarted: asked !== undefined || plannedTask === taskId,
        startPlan,
        stopBrief,
        startWithoutPlan
    }
}

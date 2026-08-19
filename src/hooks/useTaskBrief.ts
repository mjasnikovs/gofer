import {useCallback, useEffect, useRef, useState} from 'react'
import {EMPTY_BRIEF_STATE, SPECIFICATION_FIELD, applyBriefEvent, endBriefRun} from '../models/brief'
import {invoke} from '../services/desktop'
import {readTaskBrief, runTaskBrief, watchBrief} from '../services/brief'
import {setTurnRunning} from '../services/turn-activity'
import {commandErrorMessage} from '../utils/command-error'
import type {BriefState} from '../models/brief'
import type {ChatAttachment} from '../models/chat'

/** What a plan was asked to work from: the sentence, and the pictures beside it. */
type PlannedAsk = Readonly<{prompt: string; attachments: readonly ChatAttachment[]}>

type TaskBriefOptions = Readonly<{
    /** The task this workspace is drawing, or nothing while there is none. */
    taskId?: string | undefined
    /** Sends the task's first message. The brief's output goes through the same path a user does. */
    onStartTurn: (prompt: string, attachments: readonly ChatAttachment[]) => void
    onError: (message: string) => void
}>

/**
 * Runs a task's brief, and shows one while it runs.
 *
 * The ask comes from the composer, because that is where the user writes. Planning is an alternative
 * way to send the first message and nothing more: press it instead of Send and the four phases run
 * against what was typed, then their specification is sent as the turn.
 *
 * The specification is delivered through the same `start` a typed message goes through, and not by
 * writing a chat row directly. Writing the row would show the spec twice — the turn runner appends
 * its own user message — and it would put a message in the transcript that no turn ever ran against.
 *
 * A run that stops or fails delivers nothing, deliberately. The phases it finished are on disk and
 * the panel says where it stopped; handing a half-finished specification to the agent as though it
 * were whole is worse than handing it nothing.
 *
 * Every state change comes from an event rather than from this effect, including the first. That is
 * why the run announces itself: the panel has to appear before the first phase does, because proving
 * every tool is reachable happens first and takes long enough to look like nothing happening.
 */
export function useTaskBrief({taskId, onStartTurn, onError}: TaskBriefOptions) {
    const [briefState, setBriefState] = useState<BriefState>(EMPTY_BRIEF_STATE)
    /*
     * The ask a plan was asked for, which is also the record that one was asked for at all.
     *
     * State rather than a ref because it is what the effect below runs on, and because the composer
     * withholds the plan control once it is set. It is never cleared: a task gets one plan, and the
     * control that would start a second is gone by the time this holds anything.
     *
     * The pictures are part of the ask, not a decoration on it: the phases read them, and so does
     * the turn the specification starts. They are already on disk by the time they arrive here —
     * what this holds is what names them.
     */
    const [asked, setAsked] = useState<PlannedAsk>()
    /**
     * The task whose stored brief was read back, if one was found.
     *
     * The task rather than a flag, so it needs no clearing: this hook is not remounted per task —
     * the workspace passes the open task into it — and a bare boolean that only ever turned on
     * withheld the Plan control from the *next* task, which had never had one. Comparing against
     * the task in hand answers that by construction.
     *
     * Separate from `asked` on purpose. `asked` is what a run is started from, and restoring it
     * would start one; this is only what the composer needs in order to stop offering the control.
     */
    const [plannedTask, setPlannedTask] = useState<string>()
    // The identifier the backend registered this run under, which is the only handle a cancellation
    // has. A brief is an AI turn precisely so Stop can reach it, and Stop reaches a turn by its id.
    const requestId = useRef(0)
    /** The ask this run was started from, which is what a failed plan is restarted with. */
    const askedFor = useRef<PlannedAsk | undefined>(undefined)
    // Held in refs so the effect below depends on the run alone. Without this a re-render that
    // rebuilds either callback would tear down the watcher mid-run and start the brief a second
    // time — a fifteen-minute run, begun twice, because something unrelated re-rendered.
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
        /*
         * The specification, and whether the run that wrote it has ended. Both, because the first
         * turn needs both and they arrive in either order.
         *
         * A brief is an AI turn, and a turn holds the backend's one provider operation until the
         * command answers — the phase event is emitted from inside the worker loop that turn
         * outlives. Sending on the event alone was refused `ai_request_in_progress` every time, and
         * a planned task's first message was a failed bubble.
         */
        let specification: string | undefined
        let hasEnded = false
        const sendSpecification = () => {
            if (isCancelled || !hasEnded || specification === undefined) return
            const prompt = specification
            specification = undefined
            // The pictures the plan was asked about go with the turn it produced. The agent is
            // about to do the work the specification describes, and the specification is prose
            // written by a model that could see the screen it is about.
            startTurn.current(prompt, asked.attachments)
        }

        // Subscribed before the run starts, so the first event cannot land before anything is
        // listening for it.
        void watchBrief(event => {
            if (isCancelled) return
            setBriefState(previous => applyBriefEvent(previous, event))
            // Taken from the phase boundary rather than from the command's answer because that is
            // the event the backend has already made durable — the two agree, and this one arrives
            // first. Held until the run ends rather than sent here; see above.
            if (event.type === 'brief-phase' && event.field === SPECIFICATION_FIELD) {
                specification = event.value
                sendSpecification()
            }
        }).then(unlisten => {
            if (isCancelled) unlisten()
            else dispose = unlisten
        })

        // Kept so a failed plan is not a dead end: the ask is the one thing the user would want
        // back, and the composer was emptied when the plan took it. A ref rather than state,
        // because nothing renders it — the button that uses it appears with the ending, which is a
        // state change of its own.
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
                // A refused command is an ending like any other, so it goes through the fold rather
                // than round it. Patching `isRunning` directly cleared the run without recording
                // that it failed, which unmounted the panel — and the way out of a failed plan is
                // on that panel.
                setBriefState(previous =>
                    applyBriefEvent(previous, {type: 'brief-failed', phase: 'startup', reason})
                )
            })
            .finally(() => {
                // The command has answered, so the turn behind it is over and its provider
                // operation is back. This is the earliest a chat turn can start.
                hasEnded = true
                sendSpecification()
                if (isCancelled) return
                // And it is the only news that a run which worked is over. A finished plan reports
                // nothing — its report is the specification — so without this the panel sat
                // spinning on the last phase for the rest of the task's life, the composer's Stop
                // went on cancelling a brief that had ended, and the window was told the agent was
                // occupied forever.
                setBriefState(endBriefRun)
            })

        return () => {
            isCancelled = true
            dispose?.()
        }
    }, [taskId, asked])

    /**
     * Plans the ask instead of sending it.
     *
     * What the composer's plan control does. An empty ask is refused here rather than in the
     * button, so the backend's own refusal for one is never the thing the user sees.
     */
    const startPlan = useCallback((prompt: string, attachments: readonly ChatAttachment[] = []) => {
        const ask = prompt.trim()
        if (!ask) return
        setAsked(previous => previous ?? {prompt: ask, attachments})
    }, [])

    /**
     * Stops a running brief, the same way Stop stops a turn — because it is one.
     *
     * Cancelling settles the question the run may be blocked on, so a brief waiting on the user is
     * ended by the same press that ends one that is merely slow.
     */
    const stopBrief = useCallback(() => {
        if (requestId.current === 0) return
        void invoke('cancel_ai_request', {requestId: requestId.current}).catch(() => undefined)
    }, [])

    /**
     * Starts the task from the ask the plan was going to work from.
     *
     * The way out of a plan that failed. The task exists and is named, its chat is empty, and the
     * composer was emptied when the plan took the ask — so without this the only thing left to do
     * with the task is delete it and type the same sentence again.
     */
    const startWithoutPlan = useCallback(() => {
        const ask = askedFor.current
        if (!ask) return
        startTurn.current(ask.prompt, ask.attachments)
        askedFor.current = undefined
        // The panel goes with the run it was reporting on: the task is an ordinary one from here.
        setBriefState(EMPTY_BRIEF_STATE)
    }, [])

    /*
     * What the task already asked for, read back off disk.
     *
     * `briefState` and `asked` are both built from live events, so a restart or a switch away and
     * back left them empty — and empty means "no plan was ever asked for", which is what puts the
     * Plan control back in front of a task that has already run one. Pressing it re-ran all four
     * phases: minutes of model time, several worker spawns, over a specification already stored.
     *
     * The row is written phase by phase precisely so it can say how far a run got. Nothing read it.
     *
     * What is restored is the *fact* that a plan was asked for, not the ask itself. Restoring the
     * ask would start it: the run effect below is keyed on `asked`, so putting the old sentence
     * back would re-run the four phases this is here to prevent.
     */
    useEffect(() => {
        if (!taskId) return
        let isCancelled = false
        void readTaskBrief(taskId)
            .then(run => {
                if (isCancelled || !run) return
                setPlannedTask(taskId)
            })
            .catch(() => {
                // A brief that cannot be read is not a failure worth a banner: the cost of being
                // wrong is one re-offered control, and saying so would put an error in front of
                // every task that has never had a plan.
            })
        return () => {
            isCancelled = true
        }
    }, [taskId])

    /*
     * Said out loud, because the sidebar and the composer cannot see it.
     *
     * A brief holds the same single provider operation a chat turn does, so the same controls have
     * to stop being offered. Cleared on the way out as well: a workspace that goes leaves nothing
     * running behind it.
     */
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

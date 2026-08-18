import {useCallback, useEffect, useRef, useState} from 'react'
import {EMPTY_BRIEF_STATE, SPECIFICATION_FIELD, applyBriefEvent, endBriefRun} from '../models/brief'
import {invoke} from '../services/desktop'
import {runTaskBrief, watchBrief} from '../services/brief'
import {peekTaskStart, takeTaskStart} from '../services/task-start'
import {setTurnRunning} from '../services/turn-activity'
import {commandErrorMessage} from '../utils/command-error'
import type {BriefState} from '../models/brief'

type TaskBriefOptions = Readonly<{
    /** The task this workspace is drawing, or nothing while there is none. */
    taskId?: string | undefined
    /**
     * Whether the task's stored conversation has been read yet.
     *
     * Load-bearing, not a nicety. Reading the chat REPLACES what the runner holds, so a turn started
     * before the read lands is thrown away when it does — the message vanishes, the task keeps the
     * name "New task", and nothing anywhere reports a failure.
     */
    isChatLoaded: boolean
    /**
     * Whether the task's remembered draft has been read yet.
     *
     * The same rule, on the other value this touches. A remembered value refuses every write until
     * its own read has answered, so a draft handed over before then is dropped without a word — and
     * the ask the user typed into the dialog would simply not be there when the composer appeared.
     */
    isDraftLoaded: boolean
    /** Sends the task's first message. The brief's output goes through the same path a user does. */
    onStartTurn: (prompt: string) => void
    /** Puts the dialog's ask in the composer, unsent. What "Skip planning" leaves behind. */
    onDraft: (prompt: string) => void
    onError: (message: string) => void
}>

/**
 * Runs a newly created task's opening move, and shows a brief while one is running.
 *
 * Two modes reach this from the new-task dialog. A planned task runs the four phases first, and its
 * first message is their output. A skipped one puts the ask in the composer and sends nothing — the
 * user pressed Skip planning to go and type, so the last thing to do is type for them.
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
export function useTaskBrief({
    taskId,
    isChatLoaded,
    isDraftLoaded,
    onStartTurn,
    onDraft,
    onError
}: TaskBriefOptions) {
    const [briefState, setBriefState] = useState<BriefState>(EMPTY_BRIEF_STATE)
    // The identifier the backend registered this run under, which is the only handle a cancellation
    // has. A brief is an AI turn precisely so Stop can reach it, and Stop reaches a turn by its id.
    const requestId = useRef(0)
    /** The ask this run was started from, which is what a failed plan is restarted with. */
    const askedFor = useRef('')
    // Held in refs so the effect below depends on the task alone. Without this a re-render that
    // rebuilds either callback would tear down the watcher mid-run and start the brief a second
    // time — a fifteen-minute run, begun twice, because something unrelated re-rendered.
    const startTurn = useRef(onStartTurn)
    const draft = useRef(onDraft)
    const report = useRef(onError)
    useEffect(() => {
        startTurn.current = onStartTurn
        draft.current = onDraft
        report.current = onError
    }, [onStartTurn, onDraft, onError])

    /*
     * A skipped task's ask, put in the composer once the composer can hold it.
     *
     * Its own effect rather than a branch of the plan's, because the two wait on different reads and
     * an effect re-runs when anything it waits on changes. Joined, the draft's read landing mid-plan
     * tore down the brief's own subscription and the panel went blank for the rest of the run.
     */
    useEffect(() => {
        if (!taskId || !isDraftLoaded) return
        // Peeked rather than taken: a plan waits on the chat instead, and taking its start here
        // would drop it.
        if (peekTaskStart(taskId)?.mode !== 'draft') return
        const staged = takeTaskStart(taskId)
        if (staged) draft.current(staged.prompt)
    }, [taskId, isDraftLoaded])

    useEffect(() => {
        // Asked before the staged start is taken, so a mount that is not ready to act on it leaves
        // it where it is rather than consuming it and dropping it.
        if (!taskId || !isChatLoaded) return
        if (peekTaskStart(taskId)?.mode !== 'planned') return
        const staged = takeTaskStart(taskId)
        if (!staged) return

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
            startTurn.current(prompt)
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
        // back, and by the time a run has failed the dialog that took it is long gone. A ref rather
        // than state, because nothing renders it — the button that uses it appears with the ending,
        // which is a state change of its own.
        askedFor.current = staged.prompt
        requestId.current = Date.now()
        void runTaskBrief({requestId: requestId.current, taskId, prompt: staged.prompt})
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
    }, [taskId, isChatLoaded])

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
     * dialog that took the ask is long gone — so without this the only thing left to do with the
     * task is delete it and type the same sentence again.
     */
    const startWithoutPlan = useCallback(() => {
        if (!askedFor.current) return
        startTurn.current(askedFor.current)
        askedFor.current = ''
        // The panel goes with the run it was reporting on: the task is an ordinary one from here.
        setBriefState(EMPTY_BRIEF_STATE)
    }, [])

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

    return {briefState, stopBrief, startWithoutPlan}
}

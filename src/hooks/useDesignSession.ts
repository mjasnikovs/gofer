import {useEffect, useState} from 'react'
import {isTauri, listen} from '../services/desktop'
import type {UserQuestionPrompt, UserQuestionResponse} from '../models/brief'

type DesignSessionOptions = Readonly<{
    /** The questions currently waiting, oldest first. The card is drawn from the first of them. */
    questions: readonly UserQuestionPrompt[]
    /** Whether a turn is running at all. The net under a close that never arrives. */
    isTurnRunning: boolean
    /** Where an answer goes. Wrapped rather than called directly, so this hook sees the last one. */
    onAnswer: (response: UserQuestionResponse) => void
}>

/**
 * Keeps one design loop's card on screen for the whole loop.
 *
 * A design loop asks about one layout several times: draft, reaction, revision, reaction. Every one
 * of those is an ordinary `ask_user` call, so without this the card closes the moment the user
 * answers, stays gone for the minute the agent spends redrawing, and opens again looking like a new
 * question. The user watches their own modal flicker instead of watching one design change, and this
 * hook exists to make those rounds read as one thing.
 *
 * It layers *on top of* `useSettledQueue` rather than inside it. That queue is shared with the
 * approvals dialog and is right as it is: a prompt nobody is waiting on must leave it immediately.
 * The held prompt here is not a prompt anybody is waiting on — it is the last thing the user saw,
 * kept so the card has something to be while the agent works.
 *
 * Two ways it lets go, and the second is the important one. The design tool closes its session when
 * it returns, however it returns. But a cancelled turn rejects every call back to Rust — including
 * that close — so the one moment the close is most needed is the one moment it cannot be sent. Hence
 * `isTurnRunning`: no turn, no loop, whatever the events did or did not say.
 *
 * A set of open loops rather than one, because the agent dispatches its tool calls in parallel and
 * nothing stops it delegating two designs at once. Held as one identifier, the second loop to open
 * took the card and the first one's rounds stopped holding — a bug that only appears on the rare
 * turn, which is the kind worth spending a `Set` on.
 */
export function useDesignSession({questions, isTurnRunning, onAnswer}: DesignSessionOptions) {
    const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set())
    const [held, setHeld] = useState<UserQuestionPrompt>()
    /*
     * The loops the user has ended, which is not the same as the loops that have closed.
     *
     * Pressing "Complete and handoff" answers the last question and nothing more arrives, but the
     * loop stays open for as long as the child takes to write the agreement down — minutes, on a
     * local model. Held on the session alone, the card spent all of that showing a spinner that
     * said "Redrawing your layout" over a design the user had just finished, with no way out of it:
     * the card cannot be dismissed, because a stray Escape between rounds would end a real design.
     *
     * So an approval is remembered here and the hold stops the moment it is given. It cannot
     * suppress a real question — `prompt` below still shows anything that is actually waiting — it
     * only takes away the standing-in.
     */
    const [agreed, setAgreed] = useState<ReadonlySet<string>>(() => new Set())

    useEffect(() => {
        if (!isTauri()) return
        let isCancelled = false
        const disposers: (() => void)[] = []
        const track = (pending: Promise<() => void>) => {
            void pending.then(dispose => {
                if (isCancelled) dispose()
                else disposers.push(dispose)
            })
        }
        track(
            listen('ai-design-opened', event => {
                if (isCancelled) return
                const {sessionId} = event.payload
                setOpen(previous => new Set(previous).add(sessionId))
            })
        )
        track(
            // By identifier, both of them. A close arriving late from a loop that already finished
            // must take down neither the other loop's card nor the prompt being looked at.
            listen('ai-design-closed', event => {
                if (isCancelled) return
                const {sessionId} = event.payload
                setOpen(previous => {
                    if (!previous.has(sessionId)) return previous
                    const rest = new Set(previous)
                    rest.delete(sessionId)
                    return rest
                })
                setHeld(previous => (previous?.designSession === sessionId ? undefined : previous))
                setAgreed(previous => {
                    if (!previous.has(sessionId)) return previous
                    const rest = new Set(previous)
                    rest.delete(sessionId)
                    return rest
                })
            })
        )
        return () => {
            isCancelled = true
            for (const dispose of disposers) dispose()
        }
    }, [])

    const asking = questions[0]
    // Both edges have to agree for a loop to count as running. An open session with no turn behind
    // it is a loop whose close never made it out of a cancelled turn.
    // Asked of the value, never of its absence. The backend used to send this field as `null` for
    // every ordinary question, and `null` is not `undefined`.
    const isLive = (sessionId?: string) =>
        isTurnRunning
        && typeof sessionId === 'string'
        && open.has(sessionId)
        && !agreed.has(sessionId)

    /*
     * Compared during render rather than set from an effect. An effect would hold the previous
     * round's sketches for one frame after the new ones arrived, which is the one frame the user is
     * deciding in.
     *
     * Both branches are keyed on the same question and that is what keeps them from fighting.
     * Remembering a prompt on one rule and dropping it on another rule that is true at the same time
     * is a render that sets state, re-renders, unsets it, and never stops — which is what a design
     * question arriving outside a running turn used to do.
     */
    if (isLive(asking?.designSession) && asking !== held) setHeld(asking)
    else if (!isLive(held?.designSession) && held !== undefined) setHeld(undefined)
    if (!isTurnRunning && open.size > 0) setOpen(new Set())
    if (!isTurnRunning && agreed.size > 0) setAgreed(new Set())

    // Only between rounds. A question on screen is the card's own content; this is what stands in
    // for it while the next one is being drawn.
    const redrawing = asking === undefined && isLive(held?.designSession) ? held : undefined

    /*
     * Answering, with the one thing this hook has to see going past.
     *
     * The response carries a question, not a session, so the session is read off the question that
     * is on screen — which is the one being answered, because the card only ever shows one.
     */
    const answer = (response: UserQuestionResponse) => {
        // Asked of the value, the same way `isLive` asks. `??` would read a question the backend
        // sent with a null session as having none of its own and charge its answer to the held
        // loop — which is the null hazard this file already carries a comment about.
        const session =
            typeof asking?.designSession === 'string' ? asking.designSession : held?.designSession
        if (response.approved === true && typeof session === 'string' && session !== '')
            setAgreed(previous => new Set(previous).add(session))
        onAnswer(response)
    }

    return {prompt: asking ?? redrawing, isRedrawing: redrawing !== undefined, answer}
}

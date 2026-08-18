import {afterEach, describe, expect, it, vi} from 'vitest'
import {cleanup, render, screen} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {BriefProgress} from './BriefProgress'
import {EMPTY_BRIEF_STATE} from '../../models/brief'
import type {BriefState} from '../../models/brief'

afterEach(cleanup)

const show = (state: Partial<BriefState>) =>
    render(<BriefProgress state={{...EMPTY_BRIEF_STATE, ...state}} />)

describe('what a plan is doing while it does it', () => {
    it('names every phase, so the length of the wait is visible up front', () => {
        show({isRunning: true})
        for (const label of [
            'Sharpening the ask',
            'Reading the project',
            'Settling the questions',
            'Writing the spec'
        ]) {
            expect(screen.getByText(label)).toBeInTheDocument()
        }
    })

    /*
     * The research row counts workers rather than showing a bar. The count is something the run
     * actually reports; a bar would have to be invented from elapsed time, which is a guess dressed
     * as a measurement and is wrong in exactly the case that matters — a worker that has stopped
     * answering.
     */
    it('counts the research workers that have answered', () => {
        show({
            isRunning: true,
            phase: 'research',
            research: [
                {section: 'FILES', kind: 'ok'},
                {section: 'APIS', kind: 'ok'}
            ]
        })
        expect(screen.getByText('2/4')).toBeInTheDocument()
    })

    /*
     * The panel exists to separate "working" from "stuck", and until this line everything on it sat
     * still for the minutes one worker takes. It is shown against the worker it belongs to, not at
     * the top: four workers run one at a time, and a line floating above the list says the run is
     * alive without saying which part of it is.
     */
    it('says what the worker in flight is doing, beside that worker', () => {
        show({
            isRunning: true,
            phase: 'research',
            running: 'APIS',
            step: 'bash: rg -n "MainMenu"'
        })
        expect(screen.getByText('↳ bash: rg -n "MainMenu"')).toBeInTheDocument()
    })

    // The other three phases are one row with one delegation behind it, so the line goes on the row.
    it('says the same for a phase that has no workers to hang it on', () => {
        show({isRunning: true, phase: 'compose', step: 'thinking…'})
        expect(screen.getByText('↳ thinking…')).toBeInTheDocument()
    })

    /*
     * The row keeps its number after its phase has passed.
     *
     * A finished research phase rendered "0/4" beside its own done marker, because the count was
     * cleared at the next phase boundary while the row that shows it stayed on screen.
     */
    it('still shows what research found once the run has moved on', () => {
        show({
            isRunning: true,
            phase: 'grill',
            research: [
                {section: 'FILES', kind: 'ok'},
                {section: 'APIS', kind: 'ok'},
                {section: 'CONTEXT', kind: 'ok'},
                {section: 'TOOLING', kind: 'ok'}
            ]
        })
        expect(screen.getByText('4/4')).toBeInTheDocument()
    })

    // Before the first phase starts there is nothing behind the run, so nothing reads as finished.
    it('marks nothing done before the first phase has started', () => {
        show({isRunning: true})
        expect(screen.queryAllByLabelText('done')).toHaveLength(0)
    })

    /*
     * Named, not counted.
     *
     * "Four of four" reports that a phase finished. It does not report that the APIS worker found
     * nothing, or that one was cut short and its section is partial — and those are the two things
     * that explain a thin specification, at the point where the user can still act on it.
     */
    it('names each research worker and says how it ended', () => {
        show({
            isRunning: true,
            phase: 'research',
            running: 'CONTEXT',
            research: [
                {section: 'FILES', kind: 'ok'},
                {section: 'APIS', kind: 'empty'}
            ]
        })

        expect(screen.getByText('Which files this touches')).toBeInTheDocument()
        expect(screen.getByText('Signatures and node types')).toBeInTheDocument()
        expect(screen.getByText('How this project works')).toBeInTheDocument()
        expect(screen.getByText('How to check the work')).toBeInTheDocument()

        // The one that found nothing says so; the one that answered normally says nothing extra.
        expect(screen.getByText('nothing to report')).toBeInTheDocument()
        expect(screen.queryByText('cut short')).not.toBeInTheDocument()
    })

    it('says when a worker was cut short, because its section is partial', () => {
        show({
            isRunning: true,
            phase: 'research',
            research: [{section: 'CONTEXT', kind: 'runaway'}]
        })
        expect(screen.getByText('cut short')).toBeInTheDocument()
    })

    /*
     * The workers share one model connection and run one at a time, so the list can only ever hold
     * one spinner. A second would be claiming a concurrency the run does not have.
     */
    it('shows one worker in flight at a time', () => {
        show({
            isRunning: true,
            phase: 'research',
            running: 'APIS',
            research: [{section: 'FILES', kind: 'ok'}]
        })
        // The phase row's own spinner, and the one worker actually reading.
        expect(document.querySelectorAll('.astryx-spinner')).toHaveLength(2)
    })

    it('names no workers before research has started', () => {
        show({isRunning: true, phase: 'refine'})
        expect(screen.queryByText('Which files this touches')).not.toBeInTheDocument()
    })

    it('counts nothing for the phases that have no workers', () => {
        show({isRunning: true, phase: 'refine'})
        expect(screen.queryByText('0/4')).not.toBeInTheDocument()
    })

    // A stopped run keeps what it finished, and says so rather than sitting on a spinner forever.
    it('says a stopped run kept what it had', () => {
        show({isRunning: false, phase: 'research', ended: {kind: 'stopped'}})
        expect(screen.getByText(/Stopped\. What it had finished is kept\./u)).toBeInTheDocument()
    })

    it('says what broke, when something did', () => {
        show({
            isRunning: false,
            phase: 'compose',
            ended: {
                kind: 'failed',
                reason: 'it could not write a specification that can be verified'
            }
        })
        expect(screen.getByText(/could not write a specification/u)).toBeInTheDocument()
    })

    /*
     * A delegation deliberately reports no usage — the context bar reads the last usage event as how
     * full the conversation is, so a child's tokens there would say the first message had filled the
     * window. That leaves the spend real and invisible, and the user is the one deciding whether
     * planning was worth it.
     */
    it('says what the planning cost', () => {
        show({isRunning: false, cost: {input: 40_000, output: 8_000}})
        expect(screen.getByText('Planning cost 48.0K tokens')).toBeInTheDocument()
    })

    it('says nothing about cost before anything has been spent', () => {
        show({isRunning: true, phase: 'refine'})
        expect(screen.queryByText(/Planning cost/u)).not.toBeInTheDocument()
    })

    /*
     * The way out of a failed plan.
     *
     * The task exists, is named after the ask, and has an empty chat — and the dialog that took the
     * ask is long gone. Without this the only other thing to do with the task is delete it and type
     * the same sentence again.
     */
    it('offers to start the task without a plan once one has failed', async () => {
        const onStartWithoutPlan = vi.fn()
        render(
            <BriefProgress
                state={{...EMPTY_BRIEF_STATE, ended: {kind: 'failed', reason: 'no verify block'}}}
                onStartWithoutPlan={onStartWithoutPlan}
            />
        )

        await userEvent.click(screen.getByRole('button', {name: 'Start without a plan'}))
        expect(onStartWithoutPlan).toHaveBeenCalled()
    })

    // Not offered while the run is still going: there is nothing to recover from yet.
    it('offers no way out while the plan is still running', () => {
        render(
            <BriefProgress
                state={{...EMPTY_BRIEF_STATE, isRunning: true, phase: 'research'}}
                onStartWithoutPlan={() => undefined}
            />
        )
        expect(screen.queryByRole('button', {name: 'Start without a plan'})).not.toBeInTheDocument()
    })

    it('says so even when the failure came with no reason', () => {
        show({isRunning: false, ended: {kind: 'failed'}})
        expect(screen.getByText(/no reason was reported/u)).toBeInTheDocument()
    })
})

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

    it('says what the worker in flight is doing, beside that worker', () => {
        show({
            isRunning: true,
            phase: 'research',
            running: 'APIS',
            step: 'bash: rg -n "MainMenu"'
        })
        expect(screen.getByText('↳ bash: rg -n "MainMenu"')).toBeInTheDocument()
    })

    it('says the same for a phase that has no workers to hang it on', () => {
        show({isRunning: true, phase: 'compose', step: 'thinking…'})
        expect(screen.getByText('↳ thinking…')).toBeInTheDocument()
    })

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

    it('marks nothing done before the first phase has started', () => {
        show({isRunning: true})
        expect(screen.queryAllByLabelText('done')).toHaveLength(0)
    })

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

    it('shows one worker in flight at a time', () => {
        show({
            isRunning: true,
            phase: 'research',
            running: 'APIS',
            research: [{section: 'FILES', kind: 'ok'}]
        })
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

    it('says what the planning cost', () => {
        show({isRunning: false, cost: {input: 40_000, output: 8_000}})
        expect(screen.getByText('Planning cost 48.0K tokens')).toBeInTheDocument()
    })

    it('says nothing about cost before anything has been spent', () => {
        show({isRunning: true, phase: 'refine'})
        expect(screen.queryByText(/Planning cost/u)).not.toBeInTheDocument()
    })

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

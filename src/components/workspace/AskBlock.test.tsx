import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {cleanup, render, screen, waitFor, within} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {AskBlock, UnownedAsk} from './AskBlock'
import {AskedQuestionsContext} from '../../hooks/useUserQuestions'
import {OpenCenterTabContext} from '../../hooks/useCenterTab'
import type {CenterTab} from '../../models/ui-state'
import {AGREED_SKETCH_MARK} from '../../models/sketch'
import {ComposerAppendContext} from '../../hooks/useComposerAppend'
import type {ComposerAppendRef} from '../../hooks/useComposerAppend'
import {ComposerContext} from '../../hooks/useComposer'
import type {Composer} from '../../hooks/useComposer'
import {createDesktopFake, installDesktopFake, removeDesktopFake} from '../../test/desktop-driver'
import {installBackend} from '../../test/backend'
import {flush} from '../../test/flush'
import type {UserQuestionPrompt, UserQuestionResponse} from '../../models/brief'
import type {ToolActivity} from '../../models/chat'

afterEach(cleanup)

const COLUMN = {
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 640,
    bottom: 360,
    width: 640,
    height: 360
} as DOMRect

beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(COLUMN)
})

afterEach(() => {
    vi.restoreAllMocks()
})

const CALL = 'call-1'

const call = (over: Partial<ToolActivity> = {}): ToolActivity => ({
    id: CALL,
    name: 'ask_user',
    target: 'Where does the pause menu live?',
    status: 'running',
    startedAt: 0,
    ...over
})

const question = (over: Partial<UserQuestionPrompt> = {}): UserQuestionPrompt => ({
    questionId: 'q-1',
    question: 'Where does the pause menu live?',
    options: ['its own scene', 'inside the HUD'],
    sketches: [],
    why: 'it changes the scene tree',
    revision: 1,
    ownerCallId: CALL,
    isDelegated: false,
    canStopAsking: false,
    ...over
})

const TWO = [
    {label: 'Bar across the top', html: '<p>a</p>'},
    {label: 'Side rail', html: '<p>b</p>'}
]

/** Only `meta.supportsImages` is read from here; the rest is what the type asks for. */
const seeingComposer = (): Composer => ({
    state: {
        draft: '',
        draftAttachments: [],
        selectedModel: 'test-model',
        thinkingLevel: 'off',
        usage: {context: 0, total: 0}
    },
    actions: {
        applyModel: vi.fn(),
        attachClipboardImage: vi.fn(),
        applyThinkingLevel: vi.fn(),
        changeDraft: vi.fn(),
        clearError: vi.fn(),
        compact: vi.fn(),
        editAttachment: vi.fn(),
        plan: vi.fn(),
        removeAttachment: vi.fn(),
        selectAttachments: vi.fn(),
        stop: vi.fn(),
        submit: vi.fn()
    },
    meta: {
        canAttachImages: true,
        canCompact: false,
        canQueue: false,
        contextWindow: 1000,
        isSavingAttachments: false,
        isPlanOffered: false,
        isStreaming: false,
        models: [],
        supportsImages: true,
        thinkingLevels: []
    }
})

const show = (
    tool: ToolActivity,
    questions: readonly UserQuestionPrompt[] = [],
    answer = vi.fn<(response: UserQuestionResponse) => void>(),
    appendRef: ComposerAppendRef = {current: null}
) => {
    const openTab = vi.fn<(tab: CenterTab) => void>()
    const view = render(
        <ComposerAppendContext value={appendRef}>
            <ComposerContext value={seeingComposer()}>
                <OpenCenterTabContext value={openTab}>
                    <AskedQuestionsContext value={{questions, answer}}>
                        <AskBlock tool={tool} />
                    </AskedQuestionsContext>
                </OpenCenterTabContext>
            </ComposerContext>
        </ComposerAppendContext>
    )
    return {answer, appendRef, openTab, view}
}

const answerBox = () => screen.getByRole('combobox', {name: /Your answer/u})

const answerText = () => answerBox().textContent

const tauri = createDesktopFake()

const FILES = [
    {path: 'assets/hero.png', bytes: 900},
    {path: 'scripts/player.gd', bytes: 200}
]

describe('answering with a file decorator', () => {
    beforeEach(() => {
        installDesktopFake(tauri)
        installBackend(tauri, {files: FILES, thumbnails: {}})
    })

    afterEach(() => {
        removeDesktopFake()
        tauri.invoke.mockReset()
    })

    it('opens the workspace file menu on @, the same as the composer does', async () => {
        show(call(), [question()])
        await flush()
        const user = userEvent.setup()

        await user.click(answerBox())
        await user.type(answerBox(), '@player')

        expect(
            within(screen.getByRole('listbox')).getByRole('option', {name: /player\.gd/u})
        ).toBeInTheDocument()
    })

    it('turns the file the user picked into the path the agent reads', async () => {
        const {answer} = show(call(), [question()])
        await flush()
        const user = userEvent.setup()

        await user.click(answerBox())
        await user.type(answerBox(), '@player{Enter}')
        await user.click(screen.getByRole('button', {name: 'Send'}))

        expect(answer).toHaveBeenCalledWith(expect.objectContaining({answer: '@scripts/player.gd'}))
    })

    it('sends on Enter once something has been typed', async () => {
        const {answer} = show(call(), [question()])
        await flush()
        const user = userEvent.setup()

        await user.click(answerBox())
        await user.type(answerBox(), 'its own scene{Enter}')

        expect(answer).toHaveBeenCalledWith(
            expect.objectContaining({questionId: 'q-1', answer: 'its own scene'})
        )
    })

    it('keeps Enter as a newline while the box is empty', async () => {
        const {answer} = show(call(), [question()])
        await flush()
        const user = userEvent.setup()

        await user.click(answerBox())
        await user.type(answerBox(), '{Enter}')

        expect(answer).not.toHaveBeenCalled()
    })

    it('writes a new line rather than sending on shift+Enter', async () => {
        const {answer} = show(call(), [question()])
        await flush()
        const user = userEvent.setup()

        await user.click(answerBox())
        await user.type(answerBox(), 'first{Shift>}{Enter}{/Shift}second')

        expect(answer).not.toHaveBeenCalled()
        expect(answerText()).toContain('first')
        expect(answerText()).toContain('second')
    })
})

const filePicker = (container: HTMLElement) => {
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')
    if (!input) throw new Error('the answer offers no way to attach an image')
    return input
}

describe('a reference sent while a question is waiting', () => {
    beforeEach(() => {
        installDesktopFake(tauri)
        installBackend(tauri, {files: FILES, thumbnails: {}})
    })

    afterEach(() => {
        removeDesktopFake()
        tauri.invoke.mockReset()
    })

    it('lands in the answer, not in a draft nobody can see', async () => {
        const held: ComposerAppendRef = {current: null}
        const {appendRef} = show(call(), [question()], undefined, held)
        await flush()

        expect(appendRef.current).not.toBeNull()
        const landed = appendRef.current?.(() => '@assets/hero.png ', true)

        expect(landed).toBe(true)
        await waitFor(() => {
            expect(answerText()).toContain('@assets/hero.png')
        })
    })
})

describe('answering with a picture', () => {
    beforeEach(() => {
        installDesktopFake(tauri)
        installBackend(tauri, {files: FILES, thumbnails: {}})
    })

    afterEach(() => {
        removeDesktopFake()
        tauri.invoke.mockReset()
    })

    it('sends the attached image beside the words', async () => {
        const {answer, view} = show(call(), [question()])
        await flush()
        const user = userEvent.setup()
        const shot = new File([new Uint8Array([1, 2, 3])], 'shot.png', {type: 'image/png'})

        await user.upload(filePicker(view.container), shot)
        await screen.findByRole('img', {name: /Attached image: shot\.png/u})
        await user.click(screen.getByRole('button', {name: 'Send'}))

        expect(answer).toHaveBeenCalledWith(
            expect.objectContaining({
                images: [expect.objectContaining({name: 'shot.png', mimeType: 'image/png'})]
            })
        )
    })

    it('lets a picture alone be the whole answer', async () => {
        const {view} = show(call(), [question()])
        await flush()
        const user = userEvent.setup()
        const shot = new File([new Uint8Array([1, 2, 3])], 'shot.png', {type: 'image/png'})

        expect(screen.getByRole('button', {name: 'Send'})).toBeDisabled()
        await user.upload(filePicker(view.container), shot)
        await screen.findByRole('img', {name: /Attached image: shot\.png/u})

        expect(screen.getByRole('button', {name: 'Send'})).toBeEnabled()
    })
})

describe('one question, in the feed', () => {
    it('draws the answer box as a box, not an invisible strip', () => {
        show(call(), [question()])

        const shell = answerBox().closest('.astryx-chat-composer')
        expect(shell).not.toBeNull()
        expect(answerBox().closest('[style*="min-height"]')).not.toBeNull()
    })

    it('sends an option the moment it is pressed', async () => {
        const {answer} = show(call(), [question()])

        await userEvent.click(screen.getByRole('button', {name: 'inside the HUD'}))

        expect(answer).toHaveBeenCalledWith(
            expect.objectContaining({questionId: 'q-1', answer: 'inside the HUD'})
        )
    })

    it('marks the recommended answer on the answer itself', async () => {
        const {answer} = show(call(), [question()])

        const recommended = screen.getByRole('button', {name: 'its own scene (recommended)'})
        expect(recommended).toHaveTextContent('its own scene')
        expect(recommended).toContainElement(screen.getByText('Recommended'))

        await userEvent.click(recommended)
        expect(answer).toHaveBeenCalledWith(expect.objectContaining({answer: 'its own scene'}))
    })

    it('offers to stop the questioning only when the asker can stop', () => {
        show(call(), [question()])
        expect(
            screen.queryByRole('button', {name: 'Stop asking, continue'})
        ).not.toBeInTheDocument()
    })

    it('stops the questioning without needing anything typed', async () => {
        const {answer} = show(call(), [question({canStopAsking: true})])

        await userEvent.click(screen.getByRole('button', {name: 'Stop asking, continue'}))

        expect(answer).toHaveBeenCalledWith(
            expect.objectContaining({questionId: 'q-1', answer: '', stopAsking: true})
        )
    })

    it('carries what was typed when the questioning is stopped', async () => {
        const {answer} = show(call(), [question({canStopAsking: true})])
        await userEvent.type(answerBox(), 'inside the HUD is fine')

        await userEvent.click(screen.getByRole('button', {name: 'Stop asking, continue'}))

        expect(answer).toHaveBeenCalledWith(
            expect.objectContaining({answer: 'inside the HUD is fine', stopAsking: true})
        )
    })

    it('marks nothing when there is only one option', () => {
        show(call(), [question({options: ['its own scene']})])

        expect(screen.getByRole('button', {name: 'its own scene'})).toBeInTheDocument()
    })

    it('is one block across a revision, and keeps no answer from the round before', async () => {
        const {answer, view} = show(call(), [question()])
        await userEvent.type(answerBox(), 'make it its own scene')
        await userEvent.click(screen.getByRole('button', {name: 'Send'}))
        expect(answer).toHaveBeenCalledWith(
            expect.objectContaining({answer: 'make it its own scene'})
        )

        view.rerender(
            <AskedQuestionsContext value={{questions: [question({revision: 2})], answer}}>
                <AskBlock tool={call()} />
            </AskedQuestionsContext>
        )

        expect(screen.getByText('Round 2')).toBeInTheDocument()
        expect(answerText()).toBe('')
    })

    it('leaves the caret where the user is typing, and takes it when nobody is', () => {
        const composer = document.createElement('textarea')
        document.body.append(composer)
        composer.focus()

        show(call(), [question()])

        expect(document.activeElement).toBe(composer)
        composer.remove()
        cleanup()

        show(call(), [question()])
        expect(document.activeElement).toBe(answerBox())
    })

    it('keeps no answer across two questions that share a block', async () => {
        const answer = vi.fn<(response: UserQuestionResponse) => void>()
        const first = question()
        const second = question({questionId: 'q-2', question: 'And where does the HUD sit?'})
        const view = render(
            <AskedQuestionsContext value={{questions: [first, second], answer}}>
                <AskBlock tool={call()} />
            </AskedQuestionsContext>
        )
        await userEvent.type(answerBox(), 'its own scene, please')

        view.rerender(
            <AskedQuestionsContext value={{questions: [second], answer}}>
                <AskBlock tool={call()} />
            </AskedQuestionsContext>
        )

        expect(screen.getByText('And where does the HUD sit?')).toBeInTheDocument()
        expect(answerText()).toBe('')
    })

    it('offers another round on an ordinary question', async () => {
        const {answer} = show(call(), [question()])

        await userEvent.type(answerBox(), 'narrower than that')
        await userEvent.click(screen.getByRole('button', {name: 'Ask me again'}))

        expect(answer).toHaveBeenCalledWith(
            expect.objectContaining({answer: 'narrower than that', again: true})
        )
    })

    it('sends without asking for another round', async () => {
        const {answer} = show(call(), [question()])

        await userEvent.type(answerBox(), 'its own scene')
        await userEvent.click(screen.getByRole('button', {name: 'Send'}))

        expect(answer).toHaveBeenCalledWith(expect.not.objectContaining({again: true}))
    })

    it('names the round-again control for the loop it is inside', () => {
        show(call(), [question({sketches: TWO, isDelegated: true})])

        expect(screen.getByRole('button', {name: 'Send changes'})).toBeInTheDocument()
        expect(screen.queryByRole('button', {name: 'Ask me again'})).not.toBeInTheDocument()
        expect(screen.queryByRole('button', {name: 'Send'})).not.toBeInTheDocument()
    })

    it('sends the sketch that was chosen', async () => {
        const {answer} = show(call(), [question({sketches: TWO, isDelegated: true})])

        await userEvent.click(screen.getByRole('button', {name: 'Choose Side rail'}))
        await userEvent.click(screen.getByRole('button', {name: 'Send changes'}))

        expect(answer).toHaveBeenCalledWith(expect.objectContaining({picked: 1, again: true}))
    })

    it('ends a delegation on the button, and only once something is chosen', async () => {
        const {answer} = show(call(), [question({sketches: TWO, isDelegated: true, revision: 3})])

        expect(screen.getByRole('button', {name: 'Done, build it'})).toBeDisabled()
        await userEvent.click(screen.getByRole('button', {name: 'Choose Bar across the top'}))
        await userEvent.click(screen.getByRole('button', {name: 'Done, build it'}))

        expect(answer).toHaveBeenCalledWith(
            expect.objectContaining({picked: 0, approved: true, questionId: 'q-1'})
        )
    })

    it('lets a delegated question in words be ended without a pick', () => {
        show(call(), [question({isDelegated: true})])

        expect(screen.getByRole('button', {name: 'Done, build it'})).toBeEnabled()
    })

    it('offers no ending button outside a delegation', () => {
        show(call(), [question()])

        expect(screen.queryByRole('button', {name: 'Done, build it'})).not.toBeInTheDocument()
    })

    it('reports a skip as a skip', async () => {
        const {answer} = show(call(), [question()])

        await userEvent.click(screen.getByRole('button', {name: 'Let the agent decide'}))

        expect(answer).toHaveBeenCalledWith(
            expect.objectContaining({questionId: 'q-1', skipped: true})
        )
    })

    it('sends what the user wrote when it is none of the options', async () => {
        const {answer} = show(call(), [question()])

        await userEvent.type(answerBox(), 'a separate scene, autoloaded')
        await userEvent.click(screen.getByRole('button', {name: 'Send'}))

        expect(answer).toHaveBeenCalledWith(
            expect.objectContaining({answer: 'a separate scene, autoloaded'})
        )
    })

    it('settles rather than hanging when the turn is stopped mid-question', () => {
        show(call({status: 'error', endedAt: 1, output: 'The question was cancelled.'}), [])

        expect(screen.queryByRole('textbox', {name: /Your answer/u})).not.toBeInTheDocument()
        expect(screen.getByText('not asked')).toBeInTheDocument()
    })

    it('reports what the child is doing while there is nothing to answer', () => {
        show(call({step: 'read res://ui/pause_menu.tscn'}), [])

        expect(screen.getByText(/read res:\/\/ui\/pause_menu\.tscn/u)).toBeInTheDocument()
    })

    it('takes only the question that names its own call', () => {
        show(call(), [question({ownerCallId: 'call-2'})])

        expect(screen.queryByRole('textbox', {name: /Your answer/u})).not.toBeInTheDocument()
    })

    it('collapses to a line once it is answered', async () => {
        const {openTab} = show(
            call({
                status: 'complete',
                endedAt: 1,
                output: `They agreed it.\n\n${AGREED_SKETCH_MARK} ("Side rail").`
            }),
            []
        )

        expect(screen.getByText('design agreed')).toBeInTheDocument()
        const line = screen.getByRole('button', {name: /Where does the pause menu live/u})
        expect(line).toHaveAttribute('aria-expanded', 'false')
        await userEvent.click(line)
        expect(line).toHaveAttribute('aria-expanded', 'true')
        expect(screen.getByText(/They agreed it/u)).toBeVisible()
        await userEvent.click(screen.getByRole('button', {name: 'Open the Design tab'}))
        expect(openTab).toHaveBeenCalledWith('sketches')
    })

    it('says nothing about a design when there was none', () => {
        show(call({status: 'complete', endedAt: 1, output: 'They said: "its own scene".'}), [])

        expect(screen.getByText('answered')).toBeInTheDocument()
        expect(screen.queryByText('design agreed')).not.toBeInTheDocument()
    })
})

describe('a question with no call to belong to', () => {
    const showUnowned = (questions: readonly UserQuestionPrompt[]) => {
        const answer = vi.fn<(response: UserQuestionResponse) => void>()
        render(
            <OpenCenterTabContext value={vi.fn<(tab: CenterTab) => void>()}>
                <AskedQuestionsContext value={{questions, answer}}>
                    <UnownedAsk />
                </AskedQuestionsContext>
            </OpenCenterTabContext>
        )
        return {answer}
    }

    it('is drawn where the conversation is not, and answers', async () => {
        const {ownerCallId: _named, ...unowned} = question()
        const {answer} = showUnowned([unowned])

        await userEvent.click(screen.getByRole('button', {name: 'inside the HUD'}))

        expect(answer).toHaveBeenCalledWith(
            expect.objectContaining({questionId: 'q-1', answer: 'inside the HUD'})
        )
    })

    it('leaves a question that names a call to that call', () => {
        showUnowned([question()])

        expect(screen.queryByRole('button', {name: 'inside the HUD'})).not.toBeInTheDocument()
    })

    it('does not offer another round nothing would come back for', () => {
        const {ownerCallId: _named, ...unowned} = question()
        showUnowned([unowned])

        expect(screen.queryByRole('button', {name: 'Ask me again'})).not.toBeInTheDocument()
        expect(screen.getByRole('button', {name: 'Send'})).toBeInTheDocument()
    })
})

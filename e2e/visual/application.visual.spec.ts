import {expect, test} from '@playwright/test'
import type {Page} from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import {installDesktop} from './desktop-fixture'

const MONACO_DIFF_HOST = '[data-testid="script-diff-host"]'

/**
 * @param hasDiff whether the screen embeds Monaco's diff editor.
 *
 * Two concessions, both to the same third-party DOM and neither to Gofer's own markup. Monaco draws
 * its line numbers in a dimmed colour of its own choosing and gives its hidden edit context an empty
 * `aria-label`, so scanning inside it reports a hundred and fifty findings about an editor this
 * repository does not write. And its `lines-content` layer is sixteen million pixels square, which
 * is what axe walks up to when it looks for the background behind a button sitting *beside* the
 * diff — reporting the dialog's own Cancel as #171717 on the editor's near-black. Excluding the
 * host answers the first; the contrast rule has to come off for the second, and the same tokens are
 * measured on every other screen here.
 */
async function stableScreenshot(page: Page, name: string, hasDiff = false, hasSketch = false) {
    await page.addStyleTag({
        content:
            '*, *::before, *::after { animation: none !important; transition: none !important; }'
    })
    const builder = new AxeBuilder({page}).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    // A sketch is a sandboxed frame with no `allow-scripts`, so nothing can be injected into it to
    // be scanned — axe waits for a frame that will never answer. What is inside is the agent's
    // markup rather than this application's, and it is not ours to hold to WCAG.
    if (hasSketch) builder.exclude('iframe')
    const accessibility = await (
        hasDiff ?
            builder.exclude(MONACO_DIFF_HOST).disableRules(['color-contrast'])
        :   builder).analyze()
    expect(accessibility.violations).toEqual([])
    await expect(page).toHaveScreenshot(name, {
        animations: 'disabled',
        caret: 'hide',
        fullPage: true,
        maxDiffPixels: 200
    })
}

test('first-run preparation', async ({page}) => {
    await installDesktop(page, 'first-run')
    await page.goto('/')
    await expect(page.getByText('Preparing documentation models')).toBeVisible()
    await stableScreenshot(page, 'first-run-preparation.png')
})

test('empty workspace', async ({page}) => {
    await installDesktop(page, 'empty')
    await page.goto('/')
    await expect(page.getByRole('img', {name: 'Local AI connected'})).toBeVisible()
    await stableScreenshot(page, 'empty-workspace.png')
})

/**
 * The dialog that asks the one question making a task cannot answer for itself.
 *
 * It does not ask what the task is — the composer is the only place to write that. It asks what
 * becomes of the files loose in the checkout, and it is only shown when there are any, so the
 * fixture's two changes are what puts it on screen at all.
 */
test('new task dialog', async ({page}) => {
    await installDesktop(page, 'empty')
    await page.goto('/')
    await expect(page.getByRole('img', {name: 'Local AI connected'})).toBeVisible()

    await page.getByRole('link', {name: 'New task'}).click()
    // Scoped to the dialog: the workspace header behind it names an untitled task the same way.
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByText('Each task gets its own branch.')).toBeVisible()
    await expect(dialog.getByText('2 files are not committed yet')).toBeVisible()
    await expect(dialog.getByText('notes/from-the-user.md')).toBeVisible()
    await expect(dialog.getByRole('button', {name: 'Create task'})).toBeEnabled()
    await stableScreenshot(page, 'new-task-dialog.png')
})

/**
 * `@` names a file, the way every other coding agent lets one be named.
 *
 * The composer had no triggers at all, so the only way to point at a file was to remember its whole
 * path and type it. The menu is the feature, so it is driven rather than looked at: typing a few
 * characters out of the middle of a name has to find the file, and choosing it has to leave the
 * path in the message the agent is sent.
 */
test('names a worktree file from the composer with @ @interaction', async ({page}) => {
    await installDesktop(page, 'streaming')
    await page.goto('/')
    await expect(page.getByRole('img', {name: 'Local AI connected'})).toBeVisible()
    const composer = page.getByRole('combobox', {name: 'Message input'})
    await composer.click()
    // The name typed as it reads, not as a fuzzy subsequence: `rankFileMentions` matches the query
    // straight, and the folder in front of the name is not needed to find it.
    await composer.pressSequentially('@play')
    const suggestion = page.getByText('player.gd', {exact: true})
    await expect(suggestion).toBeVisible()
    await suggestion.click()
    await expect(composer).toHaveText(/scripts\/player\.gd/u)
    await composer.press('Enter')
    // What the turn was actually sent, rather than what the composer drew.
    await expect(page.getByRole('log').getByText(/@scripts\/player\.gd/u)).toBeVisible()
})

test('streaming conversation with tool activity', async ({page}) => {
    await installDesktop(page, 'streaming')
    await page.goto('/')
    await expect(page.getByRole('img', {name: 'Local AI connected'})).toBeVisible()
    await page.getByRole('combobox', {name: 'Message input'}).fill('Run the tests')
    await page.getByRole('combobox', {name: 'Message input'}).press('Enter')
    await expect(page.getByText('Finished the requested change.')).toBeVisible()
    await expect(page.getByText('bash')).toBeVisible()
    /*
     * The turn reads top to bottom in the order it happened. Before this, every call in a turn was
     * collapsed into one badge above the reply, and a turn of eighty-eight calls said "88" over a
     * single paragraph of everything the agent had ever said — which is neither followable while it
     * runs nor readable after.
     */
    /*
     * A conversation is a column: it never scrolls sideways. One tool call with a long command in
     * its target used to drag the whole list wider than the panel, so every message in the chat sat
     * behind a horizontal scrollbar. The row's own ellipsis handles the long target once the column
     * stops growing to fit it.
     */
    const overflow = await page.getByRole('log').evaluate(log => {
        const viewport = log.parentElement
        return {scroll: viewport?.scrollWidth ?? 0, client: viewport?.clientWidth ?? 0}
    })
    expect(overflow.scroll, 'the conversation scrolls sideways').toBeLessThanOrEqual(
        overflow.client
    )

    /*
     * The answered question gives ground rather than growing the column. Its summary is one line
     * the model wrote, so the row it sits in has to end at the column's edge and the sentence has
     * to be the part that is cut.
     */
    const summary = page.locator('.astryx-collapsible-trigger .astryx-text', {
        hasText: /^Should I build the proposed/u
    })
    await expect(summary).toBeVisible()
    const clipped = await summary.evaluate(element => ({
        scroll: element.scrollWidth,
        client: element.clientWidth
    }))
    expect(clipped.scroll, 'the answered question is drawn at its full width').toBeGreaterThan(
        clipped.client
    )

    const turn = await page.getByRole('log').innerText()
    const steps = [
        "I'll run the suite first.",
        'npm test',
        'Suite is green',
        'ls -la assets/tiles/',
        'Finished the requested change.'
    ]
    const positions = steps.map(step => turn.indexOf(step))
    expect(positions, `every step is on screen, in:\n${turn}`).not.toContain(-1)
    expect(positions, 'the turn does not read in the order it happened').toEqual(
        [...positions].sort((first, second) => first - second)
    )
    /*
     * The composer's footer, in the narrower of the two layouts it renders in. Held on one line it
     * did not fit the chat column and the reasoning control's chevron was cut in half by the
     * column's right edge — which the baseline recorded rather than caught, because a snapshot
     * agrees with whatever it was shown first. This is the measurement that would have caught it.
     */
    const reasoning = await page.getByRole('button', {name: /^Reasoning:/u}).boundingBox()
    const column = await page.getByRole('combobox', {name: 'Message input'}).boundingBox()
    expect(reasoning, 'the reasoning control is on screen').toBeTruthy()
    expect(
        (reasoning?.x ?? 0) + (reasoning?.width ?? 0),
        'the reasoning control runs past the right edge of the chat column'
    ).toBeLessThanOrEqual((column?.x ?? 0) + (column?.width ?? 0))
    /*
     * The tool's name survives a target too long for the row; only the target gives ground.
     *
     * `ChatToolCalls` shrinks the target ten times faster than the name, which is not the same as
     * shrinking it first: flexbox splits a deficit across every shrinkable item, so five pixels
     * came off the name too. Five pixels is nothing on an eighty-character path and a whole word on
     * an eight-character name — the reported row read `subage…`, and this very baseline used to
     * read `godot_scri…`. Measured rather than looked at, because the screenshot is what recorded
     * it for months.
     */
    for (const tool of ['godot_script', 'subagent']) {
        const name = page
            .locator('.astryx-chat-tool-calls span', {hasText: new RegExp(`^${tool}$`, 'u')})
            .first()
        await expect(name).toHaveText(tool)
        const cutOff = await name.evaluate(span => span.scrollWidth - span.clientWidth)
        expect(cutOff, `${tool} is drawn in full, not cut to an ellipsis`).toBe(0)
    }
    /*
     * And a settled stretch of thinking is folded, under a caption rather than a heading.
     *
     * Two things are measured here. The caption used to be `ChatMessageBubble`'s `name`, drawn in a
     * bare element that inherits its surroundings, so the string came out at body size: bigger than
     * the thinking it labels, which is drawn compact, and bigger than the tool names either side of
     * it. And the thinking itself used to be always open — which was survivable while every block
     * had its own outline and is not now that the transcript is flat, because the muttering and the
     * answer look the same. The fold is by `isStreaming` on the last part only, so a stretch the
     * turn has moved past closes on its own.
     */
    const thinking = page.getByRole('button', {name: 'Thinking'})
    await expect(thinking).toHaveAttribute('aria-expanded', 'false')
    const sizes = await page.evaluate(() => {
        const label = [...document.querySelectorAll('.astryx-collapsible-trigger')].find(
            element => element.textContent === 'Thinking'
        )
        // The deepest element still holding the sentence: Markdown chooses its own tags, and an
        // ancestor's font size is not the one the sentence is drawn at.
        const reply = [...document.querySelectorAll('*')]
            .filter(element => element.textContent.startsWith('All tests passed'))
            .pop()
        const size = (element: Element | undefined) =>
            element ? Number.parseFloat(getComputedStyle(element).fontSize) : 0
        return {label: size(label?.querySelector('.astryx-text') ?? label), reply: size(reply)}
    })
    expect(sizes.label, 'the thinking caption is drawn').toBeGreaterThan(0)
    expect(sizes.reply, 'the reply body is drawn').toBeGreaterThan(0)
    expect(
        sizes.label,
        'the thinking caption must not outshout the reply it sits over'
    ).toBeLessThan(sizes.reply)
    await stableScreenshot(page, 'streaming-tool-activity.png')
})

test('script editor', async ({page}) => {
    await installDesktop(page, 'scripts')
    await page.goto('/')
    await expect(page.getByRole('img', {name: 'Local AI connected'})).toBeVisible()
    await page.getByRole('button', {name: 'Files'}).click()
    await page.getByText('player.gd').click()
    // Monaco renders its own DOM, so waiting for a line it tokenized proves the editor is live.
    await expect(page.locator('.monaco-editor').first()).toBeVisible()
    await expect(page.getByText('func _ready() -> void:')).toBeVisible()
    await stableScreenshot(page, 'script-editor.png')
})

/**
 * The row's own action, which only a real layout can prove.
 *
 * The button is drawn faint until its row is hovered, and it shares a row with a name that may be
 * longer than the column is wide — both of which a component test, with no layout and no pointer,
 * reports as passing however far off the panel the button has been pushed.
 */
test('raises the mention action on the row under the pointer @interaction', async ({page}) => {
    await installDesktop(page, 'inspector')
    await page.goto('/')
    await page
        .getByRole('navigation', {name: 'Explorer'})
        .getByRole('button', {name: 'Start Godot'})
        .click()
    // The deepest row with the longest name: the one a row-width mistake takes out of reach first.
    const action = page.getByRole('button', {
        name: 'Mention DeeplyNestedMarkerNodeName in the message'
    })
    // The strength lives on the slot around the button, not on the button, which is always opaque.
    const slot = action.locator('..')
    // The pointer is left wherever the last click put it, which is inside this very panel.
    await page.mouse.move(0, 0)
    // Absent, not merely invisible: a hidden button that still holds its width leaves a gap in
    // every row of the tree.
    await expect(slot).toHaveCSS('opacity', '0')
    await expect(slot).toHaveCSS('width', '0px')
    await page.getByText('DeeplyNestedMarkerNodeName').hover()
    await expect(slot).toHaveCSS('opacity', '1')
    await expect(slot).not.toHaveCSS('width', '0px')
    await expect(action).toBeVisible()
    // The drawing itself, not just the button around it: a Heroicon handed over without a size
    // renders at nothing in WebKit, which left this button present, hoverable and empty.
    const glyph = await action.locator('svg').boundingBox()
    expect(glyph?.width).toBeGreaterThan(8)
    const box = await action.boundingBox()
    const panel = await page.locator('.astryx-tree-list').boundingBox()
    expect(box && panel && box.x + box.width).toBeLessThanOrEqual(
        (panel?.x ?? 0) + (panel?.width ?? 0)
    )
})

test('inspector workspace', async ({page}) => {
    await installDesktop(page, 'inspector')
    await page.goto('/')
    await expect(page.getByRole('img', {name: 'Local AI connected'})).toBeVisible()
    // Both the explorer and the inspector offer to start one; this is the explorer's.
    await page
        .getByRole('navigation', {name: 'Explorer'})
        .getByRole('button', {name: 'Start Godot'})
        .click()
    // The name is its own element now, so `Player` alone also matches the collision shape below it.
    await page.getByText('Player', {exact: true}).click()
    await expect(
        page.getByRole('complementary', {name: 'Inspector'}).getByText('Main/Player')
    ).toBeVisible()
    await stableScreenshot(page, 'inspector-workspace.png')
})

/*
 * One shot per tab. Only the open tab is rendered, so a single screenshot would have covered the
 * connection form and nothing else — and each tab carries its own footer, which is the part most
 * likely to regress.
 */
/**
 * A turn holding a question open, which is where every question screenshot starts.
 *
 * The block that draws a question is the tool call's own row in the conversation, so a question with
 * no call behind it is a question nothing renders. That is the whole shape of the seam and it is
 * worth paying for here rather than faking around: hold a turn, make the call, then ask.
 */
async function askDuringATurn(
    page: Page,
    sketches: number,
    design?: {revision?: number; delegated?: boolean}
) {
    await installDesktop(page, 'streaming')
    await page.goto('/')
    await expect(page.getByRole('img', {name: 'Local AI connected'})).toBeVisible()
    await page.evaluate(() => {
        window.__GOFER_TEST_HOLD_TURN__ = true
    })
    await page.getByRole('combobox', {name: 'Message input'}).fill('Design the pause menu')
    await page.getByRole('combobox', {name: 'Message input'}).press('Enter')
    await page.evaluate(
        ({count, options}) => {
            window.__GOFER_TEST_ASK__?.(count, options)
        },
        {count: sketches, options: design}
    )
}

/**
 * A question the agent asks with pictures, which is the screen this application is worst at.
 *
 * Two sketches side by side is the case every defect has been in: the columns have to be the same
 * size and start at the same height, each sketch has to be scaled rather than cut off by the column
 * edge, and the control that answers the question has to be on screen.
 */
test('question with two sketches', async ({page}) => {
    await askDuringATurn(page, 2, {delegated: true})
    await expect(page.getByRole('button', {name: 'Choose Centered Overlay'})).toBeVisible()
    // Side by side means side by side. A label allowed to wrap, or a badge on one column only, put
    // the two sketches out of line — twice — and a screenshot alone never said by how much.
    const frames = await page.evaluate(() =>
        [...document.querySelectorAll('iframe')].map(frame => {
            const rect = frame.getBoundingClientRect()
            return {top: rect.top, width: rect.width, height: rect.height}
        })
    )
    expect(frames).toHaveLength(2)
    // And the whole block fits the column it is in. A chat column is a few hundred pixels wide and
    // a flex row sizes itself from its content: three footer controls on one line ran the block off
    // the right edge in the real window, with the primary action as the half that was cut.
    const fit = await page.evaluate(() => {
        const frame = document.querySelector('iframe')
        const block = frame?.closest('.astryx-card')
        const column = block?.closest('[class*="astryx-chat-message-list"]') ?? block?.parentElement
        return {
            block: block?.getBoundingClientRect().right ?? 0,
            column: column?.getBoundingClientRect().right ?? 0
        }
    })
    expect(fit.block).toBeLessThanOrEqual(fit.column + 1)
    expect(Math.abs((frames[0]?.top ?? 0) - (frames[1]?.top ?? 0))).toBeLessThanOrEqual(1)
    expect(Math.abs((frames[0]?.width ?? 0) - (frames[1]?.width ?? 1))).toBeLessThanOrEqual(1)
    expect(Math.abs((frames[0]?.height ?? 0) - (frames[1]?.height ?? 1))).toBeLessThanOrEqual(1)
    await stableScreenshot(page, 'question-two-sketches.png', false, true)
})

test('question with one sketch', async ({page}) => {
    await askDuringATurn(page, 1, {delegated: true})
    await expect(page.getByRole('button', {name: 'Choose Centered Overlay'})).toBeVisible()
    await stableScreenshot(page, 'question-one-sketch.png', false, true)
})

/**
 * The same question with no pictures, which is what most questions are.
 *
 * Here so that the small block cannot be broken by work on the large one — the two share a component
 * and every change to the sketch half has run through this code.
 */
test('question in words', async ({page}) => {
    await askDuringATurn(page, 0)
    await expect(page.getByRole('textbox', {name: /Your answer/u})).toBeVisible()
    // An option is a whole answer, so it is a button that sends rather than one that selects.
    await expect(page.getByRole('button', {name: 'Its own scene'})).toBeVisible()
    await stableScreenshot(page, 'question-in-words.png')
})

/**
 * A sketch that has been chosen.
 *
 * Its own screenshot because the state had none, and what shipped was the chosen button *disabled* —
 * the answer the user had just given, drawn as the one thing they were not allowed to pick.
 */
test('a sketch chosen', async ({page}) => {
    await askDuringATurn(page, 2, {delegated: true})
    await page.getByRole('button', {name: 'Choose Side Panel'}).click()
    await expect(page.getByRole('button', {name: 'Choose Side Panel'})).toBeEnabled()
    await expect(page.getByRole('button', {name: 'Send changes'})).toBeEnabled()
    await stableScreenshot(page, 'question-chosen.png', false, true)
})

/**
 * A round of a delegated design, which is the same block carrying one more control.
 *
 * Worth its own screenshot because the footer is where it can go wrong: three buttons instead of
 * two, one of them the primary the loop exists to reach, and a badge in the header that has to sit
 * beside a long question rather than push it. None of that is visible to jsdom.
 */
test('a design round with two sketches', async ({page}) => {
    await askDuringATurn(page, 2, {delegated: true, revision: 3})
    await expect(page.getByRole('button', {name: 'Done, build it'})).toBeVisible()
    // Which round this is, drawn. The prompt has carried it since the first build and the card threw
    // it away, so a layout the user had already commented on came back looking like a new question.
    await expect(page.getByText('Round 3')).toBeVisible()
    await page.getByRole('button', {name: 'Choose Side Panel'}).click()
    await expect(page.getByRole('button', {name: 'Done, build it'})).toBeEnabled()
    // The footer holds three controls now. On the shipped window they have to be on screen together,
    // which is the thing a count in a unit test cannot tell anybody.
    const footer = await page.evaluate(() => {
        const names = ['Done, build it', 'Send changes', 'Let the agent decide']
        return [...document.querySelectorAll('button')]
            .filter(button => names.includes(button.textContent.trim()))
            .map(button => {
                const rect = button.getBoundingClientRect()
                return {bottom: rect.bottom, text: button.textContent.trim()}
            })
    })
    expect(footer).toHaveLength(3)
    for (const button of footer)
        expect(button.bottom, `${button.text} is below the fold`).toBeLessThanOrEqual(
            page.viewportSize()?.height ?? 0
        )
    await stableScreenshot(page, 'question-design-round.png', false, true)
})

/**
 * Between rounds, which is the state this whole seam was built for.
 *
 * What shipped before was nothing at all here: the card closed on the answer, the window sat empty
 * for the minute the agent spent redrawing, and a new card opened looking like a new question. The
 * block does not close, because it is not a card that opens — it is the tool call's own place in the
 * feed, and a revision is the same block with new content in it.
 */
test('the block between two design rounds', async ({page}) => {
    await askDuringATurn(page, 2, {delegated: true, revision: 2})
    await page.getByRole('button', {name: 'Choose Side Panel'}).click()
    await page.getByRole('button', {name: 'Send changes'}).click()

    // The question is gone and the block is not: it is back to reporting what the child is doing.
    await expect(page.getByRole('button', {name: 'Choose Side Panel'})).toBeHidden()
    await page.evaluate(() => {
        window.__GOFER_TEST_ASK_STEP__?.('read res://ui/pause_menu.tscn')
    })
    await expect(page.getByText(/read res:\/\/ui\/pause_menu\.tscn/u)).toBeVisible()
    await stableScreenshot(page, 'question-design-redrawing.png')
})

/** The zoom: one sketch as large as the window allows, and one way out. */
test('a sketch zoomed', async ({page}) => {
    await askDuringATurn(page, 2, {delegated: true})
    await page.getByRole('button', {name: 'Open Side Panel'}).click()
    await expect(page.getByRole('button', {name: 'Close'})).toBeVisible()
    await stableScreenshot(page, 'question-zoomed.png', false, true)
})

test('settings dialog', async ({page}) => {
    await installDesktop(page, 'settings')
    await page.goto('/#/settings')
    await expect(page.getByRole('heading', {name: 'Settings'})).toBeVisible()
    await expect(page.getByRole('heading', {name: 'AI connection'})).toBeVisible()
    await stableScreenshot(page, 'settings-ai.png')

    const tabs = page.getByRole('navigation', {name: 'Settings sections'})

    await tabs.getByRole('button', {name: 'Agent prompt'}).click()
    await expect(page.getByRole('button', {name: 'Save prompt'})).toBeVisible()
    await stableScreenshot(page, 'settings-prompt.png')

    await tabs.getByRole('button', {name: 'Documentation models'}).click()
    await expect(page.getByText('Installed')).toBeVisible()
    await stableScreenshot(page, 'settings-models.png')

    await tabs.getByRole('button', {name: 'Project storage'}).click()
    await expect(page.getByRole('button', {name: 'Back up project'})).toBeVisible()
    await stableScreenshot(page, 'settings-storage.png')
})

test('initialization error', async ({page}) => {
    await installDesktop(page, 'error')
    await page.goto('/')
    await expect(page.getByText('Models could not be initialized')).toBeVisible()
    await stableScreenshot(page, 'error-state.png')
})

/** Every screen below needs a live editor session before it has anything to draw. */
async function openSession(page: Page) {
    await installDesktop(page, 'inspector')
    await page.goto('/')
    await expect(page.getByRole('img', {name: 'Local AI connected'})).toBeVisible()
    await page
        .getByRole('navigation', {name: 'Explorer'})
        .getByRole('button', {
            name: 'Start Godot'
        })
        .click()
}

/**
 * A toolbar that runs past the panel it sits in.
 *
 * The bottom panel is a fraction of a 1280 px window and both of these rows hold every action their
 * view has; a snapshot shows the clipping but cannot say which button crossed the edge, and a
 * component test has no layout to clip against. This reads the geometry the browser resolved.
 */
async function expectToolbarFits(page: Page, region: string, lastAction: string) {
    const panel = await page.getByRole('toolbar', {name: region}).boundingBox()
    const button = await page.getByRole('button', {name: lastAction}).boundingBox()
    expect(panel, `the ${region} toolbar is on screen`).toBeTruthy()
    expect(button, `${lastAction} is on screen`).toBeTruthy()
    expect(
        (button?.x ?? 0) + (button?.width ?? 0),
        `${lastAction} runs past the right edge of the ${region} toolbar`
    ).toBeLessThanOrEqual((panel?.x ?? 0) + (panel?.width ?? 0))
}

test('debugger tab', async ({page}) => {
    await openSession(page)
    await page.getByRole('button', {name: 'Debugger', exact: true}).click()
    await expect(page.getByText('Not running', {exact: true})).toBeVisible()
    await expectToolbarFits(page, 'Debugger controls', 'Terminate')
    await stableScreenshot(page, 'debugger-tab.png')
})

test('output tab', async ({page}) => {
    await openSession(page)
    await page.getByRole('button', {name: 'Output', exact: true}).click()
    await expect(page.getByText('Godot Engine v4.7.2.stable')).toBeVisible()
    await stableScreenshot(page, 'output-tab.png')
})

test('import tab', async ({page}) => {
    await openSession(page)
    await page.getByRole('button', {name: 'Import', exact: true}).click()
    await expect(page.getByRole('button', {name: 'Rescan project'})).toBeVisible()
    await stableScreenshot(page, 'import-tab.png')
})

test('game tab', async ({page}) => {
    await openSession(page)
    await page.getByRole('button', {name: 'Game', exact: true}).click()
    await expect(page.getByText('No frame captured')).toBeVisible()
    await expectToolbarFits(page, 'Game controls', 'Capture editor')
    await stableScreenshot(page, 'game-tab.png')
})

test('docs tab', async ({page}) => {
    await openSession(page)
    await page.getByRole('button', {name: 'Docs', exact: true}).click()
    await page.getByRole('textbox', {name: 'Ask the Godot documentation'}).fill('move a body')
    await page.getByRole('button', {name: 'Search'}).click()
    await expect(page.getByText('move_and_slide')).toBeVisible()
    await stableScreenshot(page, 'docs-tab.png')
})

/**
 * The layout somebody agreed, found again.
 *
 * `hasSketch` is not optional here. A sketch is a sandboxed frame with no `allow-scripts`, and the
 * accessibility pass waits on it forever otherwise — the same reason the question card's shots pass
 * it.
 */
test('sketches tab', async ({page}) => {
    await openSession(page)
    await page.getByRole('button', {name: 'Design', exact: true}).click()
    await page.getByText('Centered Overlay').click()
    await expect(page.getByRole('button', {name: 'Send to chat'})).toBeVisible()
    await stableScreenshot(page, 'sketches-tab.png', false, true)
})

/** The viewer that makes a 1280-wide layout readable in a 330-wide column. */
test('sketch viewer', async ({page}) => {
    await openSession(page)
    await page.getByRole('button', {name: 'Design', exact: true}).click()
    await page.getByText('Centered Overlay').click()
    await page.getByRole('button', {name: /full size/}).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await stableScreenshot(page, 'sketch-viewer.png', false, true)
})

test('tool approval dialog', async ({page}) => {
    await installDesktop(page, 'inspector')
    await page.goto('/')
    await expect(page.getByRole('img', {name: 'Local AI connected'})).toBeVisible()
    await page.evaluate(() => {
        window.__GOFER_TEST_APPROVE__?.()
    })
    await expect(page.getByRole('button', {name: 'Approve'})).toBeVisible()
    await stableScreenshot(page, 'tool-approval-dialog.png')
})

test('format preview dialog', async ({page}) => {
    await installDesktop(page, 'scripts')
    await page.goto('/')
    await expect(page.getByRole('img', {name: 'Local AI connected'})).toBeVisible()
    await page.getByRole('button', {name: 'Files'}).click()
    await page.getByText('player.gd').click()
    await expect(page.getByText('func _ready() -> void:')).toBeVisible()
    await page.getByRole('button', {name: 'Format'}).click()
    await expect(page.getByRole('button', {name: 'Apply to buffer'})).toBeVisible()
    await stableScreenshot(page, 'format-preview-dialog.png', true)
})

test('rename dialogs', async ({page}) => {
    await installDesktop(page, 'scripts')
    await page.goto('/')
    await expect(page.getByRole('img', {name: 'Local AI connected'})).toBeVisible()
    await page.getByRole('button', {name: 'Files'}).click()
    await page.getByText('player.gd').click()
    // The rename gesture is F2 inside the editor, so the caret has to be in it first.
    await page.getByText('func _ready() -> void:').click()
    await page.keyboard.press('F2')
    await expect(page.getByRole('button', {name: 'Preview rename'})).toBeVisible()
    await stableScreenshot(page, 'rename-dialog.png')

    await page.getByRole('textbox', {name: 'New name'}).fill('on_ready')
    await page.getByRole('button', {name: 'Preview rename'}).click()
    await expect(page.getByRole('button', {name: 'Apply rename'})).toBeVisible()
    await stableScreenshot(page, 'rename-preview-dialog.png', true)
})

/** A flat grey picture, so any coloured pixel in the canvas can only be a stroke that was drawn. */
const GREY_PNG =
    'iVBORw0KGgoAAAANSUhEUgAAAPAAAACMCAIAAADN17N/AAACGUlEQVR4nO3OQQkAMQADsOoce5x/FWeiUBiBCEjO/eAZmQ+gKPMBFGU+gKLMB1CU+QCKMh9AUeYDKMp8AEWZD6Ao8wEUZT6AoswHUJT5AIoyH0BR5gMoynwARZkPoCjzARRlPoCizAdQlPkAijIfQFHmAyjKfABFmQ+gKPMBFGU+gKLMB1CU+QCKMh9AUeYDKMp8AEWZD6Ao8wEUZT6AoswHUJT5AIoyH0BR5gMoynwARZkPoCjzARRlPoCizAdQlPkAijIfQFHmAyjKfABFmQ+gKPMBFGU+gKLMB1CU+QCKMh9AUeYDKMp8AEWZD6Ao8wEUZT6AoswHUJT5AIoyH0BR5gMoynwARZkPoCjzARRlPoCizAdQlPkAijIfQFHmAyjKfABFmQ+gKPMBFGU+gKLMB1CU+QCKMh9AUeYDKMp8AEWZD6Ao8wEUZT6AoswHUJT5AIoyH0BR5gMoynwARZkPoCjzARRlPoCizAdQlPkAijIfQFHmAyjKfABFmQ+gKPMBFGU+gKLMB1CU+QCKMh9AUeYDKMp8AEWZD6Ao8wEUZT6AoswHUJT5AIoyH0BR5gMoynwARZkPoCjzARRlPoCizAdQlPkAijIfQFHmAyjKfABFmQ+gKPMBFGU+gKLMB1CU+QCKMh9AUeYDKMp8AEWZD6Ao8wEUZT6AoswHUJT5AIoyH0BR5gMoynwARZkPoCjzARRlPoCiH+eSj9PnhQ95AAAAAElFTkSuQmCC'

/** Pixels the ink is on, counted in the canvas the dialog draws. Grey art scores zero. */
async function redPixels(page: Page) {
    return page.getByRole('img', {name: /Drawing surface/u}).evaluate(element => {
        const canvas = element as HTMLCanvasElement
        const ctx = canvas.getContext('2d')
        if (!ctx) return 0
        const {data} = ctx.getImageData(0, 0, canvas.width, canvas.height)
        let count = 0
        for (let at = 0; at < data.length; at += 4) {
            const [red, green, blue] = [data[at] ?? 0, data[at + 1] ?? 0, data[at + 2] ?? 0]
            if (red > 180 && green < 90 && blue < 90) count += 1
        }
        return count
    })
}

async function attachGreyImage(page: Page) {
    await page.locator('input[type="file"]').setInputFiles({
        name: 'shot.png',
        mimeType: 'image/png',
        buffer: Buffer.from(GREY_PNG, 'base64')
    })
    return page.getByRole('button', {name: /^Open shot\.png/u})
}

/**
 * Drawing on an attached screenshot, and finding the drawing still there on the way back in.
 *
 * The whole point of the scratchpad is that a picture is faster than a paragraph, and the whole
 * risk is that saving burns the strokes into the pixels and the next edit starts from nothing. So
 * this draws, saves, reopens, and counts the ink: the picture underneath is flat grey, so a red
 * pixel on the second visit can only have come from the shapes being kept and painted again.
 */
test('draws on an attachment and keeps the strokes after saving @interaction', async ({page}) => {
    await installDesktop(page, 'empty')
    await page.goto('/')
    await expect(page.getByRole('img', {name: 'Local AI connected'})).toBeVisible()

    const thumbnail = await attachGreyImage(page)
    await expect(thumbnail).toBeVisible()
    const before = await thumbnail.locator('img').getAttribute('src')

    await thumbnail.click()
    const canvas = page.getByRole('img', {name: /Drawing surface/u})
    await expect(canvas).toBeVisible()
    expect(await redPixels(page)).toBe(0)

    const box = await canvas.boundingBox()
    if (!box) throw new Error('The drawing surface has no box to draw in')
    await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.3)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.6, {steps: 8})
    await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.3, {steps: 8})
    await page.mouse.up()
    expect(await redPixels(page)).toBeGreaterThan(0)
    await stableScreenshot(page, 'image-scratchpad.png')

    await page.getByRole('button', {name: 'Save'}).click()
    await expect(canvas).toBeHidden()
    // The flattened picture is what the model would be sent, so the thumbnail has to be it.
    await expect(thumbnail.locator('img')).not.toHaveAttribute('src', before ?? '')

    await thumbnail.click()
    await expect(canvas).toBeVisible()
    expect(await redPixels(page)).toBeGreaterThan(0)
})

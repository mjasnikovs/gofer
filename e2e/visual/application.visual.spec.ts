import {expect, test} from '@playwright/test'
import type {Page} from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import {installDesktop} from './desktop-fixture'

const MONACO_DIFF_HOST = '[data-testid="script-diff-host"]'

async function stableScreenshot(page: Page, name: string, hasDiff = false, hasSketch = false) {
    await page.addStyleTag({
        content:
            '*, *::before, *::after { animation: none !important; transition: none !important; }'
    })
    const builder = new AxeBuilder({page}).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
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

test('new task dialog', async ({page}) => {
    await installDesktop(page, 'empty')
    await page.goto('/')
    await expect(page.getByRole('img', {name: 'Local AI connected'})).toBeVisible()

    await page.getByRole('link', {name: 'New task'}).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByText('Each task gets its own branch.')).toBeVisible()
    await expect(dialog.getByText('2 files are not committed yet')).toBeVisible()
    await expect(dialog.getByText('notes/from-the-user.md')).toBeVisible()
    await expect(dialog.getByRole('button', {name: 'Create task'})).toBeEnabled()
    await stableScreenshot(page, 'new-task-dialog.png')
})

test('names a worktree file from the composer with @ @interaction', async ({page}) => {
    await installDesktop(page, 'streaming')
    await page.goto('/')
    await expect(page.getByRole('img', {name: 'Local AI connected'})).toBeVisible()
    const composer = page.getByRole('combobox', {name: 'Message input'})
    await composer.click()
    await composer.pressSequentially('@play')
    const suggestion = page.getByText('player.gd', {exact: true})
    await expect(suggestion).toBeVisible()
    await suggestion.click()
    await expect(composer).toHaveText(/scripts\/player\.gd/u)
    await composer.press('Enter')
    await expect(page.getByRole('log').getByText(/@scripts\/player\.gd/u)).toBeVisible()
})

test('the view tabs survive a long running turn @interaction', async ({page}) => {
    await installDesktop(page, 'streaming', {seededMessages: 40})
    await page.goto('/')
    await expect(page.getByRole('img', {name: 'Local AI connected'})).toBeVisible()
    await page.evaluate(() => {
        window.__GOFER_TEST_HOLD_TURN__ = true
    })
    await page.getByRole('combobox', {name: 'Message input'}).fill('Run the tests')
    await page.getByRole('combobox', {name: 'Message input'}).press('Enter')
    await expect(page.getByText('Working', {exact: true})).toBeVisible()
    const strip = page.getByRole('navigation', {name: 'Workspace views'})
    const box = await strip.boundingBox()
    expect(box?.height ?? 0, 'the view strip is drawn at its full height').toBeGreaterThan(28)
    await expect(page.getByRole('button', {name: 'Design'})).toBeVisible()
})

test('streaming conversation with tool activity', async ({page}) => {
    await installDesktop(page, 'streaming')
    await page.goto('/')
    await expect(page.getByRole('img', {name: 'Local AI connected'})).toBeVisible()
    await page.getByRole('combobox', {name: 'Message input'}).fill('Run the tests')
    await page.getByRole('combobox', {name: 'Message input'}).press('Enter')
    await expect(page.getByText('Finished the requested change.')).toBeVisible()
    await expect(page.getByText('bash')).toBeVisible()
    const overflow = await page.getByRole('log').evaluate(log => {
        const viewport = log.parentElement
        return {scroll: viewport?.scrollWidth ?? 0, client: viewport?.clientWidth ?? 0}
    })
    expect(overflow.scroll, 'the conversation scrolls sideways').toBeLessThanOrEqual(
        overflow.client
    )

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
    const reasoning = await page.getByRole('button', {name: /^Reasoning:/u}).boundingBox()
    const column = await page.getByRole('combobox', {name: 'Message input'}).boundingBox()
    expect(reasoning, 'the reasoning control is on screen').toBeTruthy()
    expect(
        (reasoning?.x ?? 0) + (reasoning?.width ?? 0),
        'the reasoning control runs past the right edge of the chat column'
    ).toBeLessThanOrEqual((column?.x ?? 0) + (column?.width ?? 0))
    for (const tool of ['godot_script', 'subagent']) {
        const name = page
            .locator('.astryx-chat-tool-calls span', {hasText: new RegExp(`^${tool}$`, 'u')})
            .first()
        await expect(name).toHaveText(tool)
        const cutOff = await name.evaluate(span => span.scrollWidth - span.clientWidth)
        expect(cutOff, `${tool} is drawn in full, not cut to an ellipsis`).toBe(0)
    }
    const thinking = page.getByRole('button', {name: 'Thinking'})
    await expect(thinking).toHaveAttribute('aria-expanded', 'false')
    const sizes = await page.evaluate(() => {
        const label = [...document.querySelectorAll('.astryx-collapsible-trigger')].find(
            element => element.textContent === 'Thinking'
        )
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
    await expect(page.locator('.monaco-editor').first()).toBeVisible()
    await expect(page.getByText('func _ready() -> void:')).toBeVisible()
    await stableScreenshot(page, 'script-editor.png')
})

test('raises the mention action on the row under the pointer @interaction', async ({page}) => {
    await installDesktop(page, 'inspector')
    await page.goto('/')
    await page
        .getByRole('navigation', {name: 'Explorer'})
        .getByRole('button', {name: 'Start Godot'})
        .click()
    const action = page.getByRole('button', {
        name: 'Mention DeeplyNestedMarkerNodeName in the message'
    })
    const slot = action.locator('..')
    await page.mouse.move(0, 0)
    await expect(slot).toHaveCSS('opacity', '0')
    await expect(slot).toHaveCSS('width', '0px')
    await page.getByText('DeeplyNestedMarkerNodeName').hover()
    await expect(slot).toHaveCSS('opacity', '1')
    await expect(slot).not.toHaveCSS('width', '0px')
    await expect(action).toBeVisible()
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
    await page
        .getByRole('navigation', {name: 'Explorer'})
        .getByRole('button', {name: 'Start Godot'})
        .click()
    await page.getByText('Player', {exact: true}).click()
    await expect(
        page.getByRole('complementary', {name: 'Inspector'}).getByText('Main/Player')
    ).toBeVisible()
    await stableScreenshot(page, 'inspector-workspace.png')
})

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

test('question with two sketches', async ({page}) => {
    await askDuringATurn(page, 2, {delegated: true})
    await expect(page.getByRole('button', {name: 'Choose Centered Overlay'})).toBeVisible()
    const frames = await page.evaluate(() =>
        [...document.querySelectorAll('iframe')].map(frame => {
            const rect = frame.getBoundingClientRect()
            return {top: rect.top, width: rect.width, height: rect.height}
        })
    )
    expect(frames).toHaveLength(2)
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

test('question in words', async ({page}) => {
    await askDuringATurn(page, 0)
    await expect(page.getByRole('textbox', {name: /Your answer/u})).toBeVisible()
    await expect(page.getByRole('button', {name: 'Its own scene'})).toBeVisible()
    await stableScreenshot(page, 'question-in-words.png')
})

test('a sketch chosen', async ({page}) => {
    await askDuringATurn(page, 2, {delegated: true})
    await page.getByRole('button', {name: 'Choose Side Panel'}).click()
    await expect(page.getByRole('button', {name: 'Choose Side Panel'})).toBeEnabled()
    await expect(page.getByRole('button', {name: 'Send changes'})).toBeEnabled()
    await stableScreenshot(page, 'question-chosen.png', false, true)
})

test('a design round with two sketches', async ({page}) => {
    await askDuringATurn(page, 2, {delegated: true, revision: 3})
    await expect(page.getByRole('button', {name: 'Done, build it'})).toBeVisible()
    await expect(page.getByText('Round 3')).toBeVisible()
    await page.getByRole('button', {name: 'Choose Side Panel'}).click()
    await expect(page.getByRole('button', {name: 'Done, build it'})).toBeEnabled()
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

test('the block between two design rounds', async ({page}) => {
    await askDuringATurn(page, 2, {delegated: true, revision: 2})
    await page.getByRole('button', {name: 'Choose Side Panel'}).click()
    await page.getByRole('button', {name: 'Send changes'}).click()

    await expect(page.getByRole('button', {name: 'Choose Side Panel'})).toBeHidden()
    await page.evaluate(() => {
        window.__GOFER_TEST_ASK_STEP__?.('read res://ui/pause_menu.tscn')
    })
    await expect(page.getByText(/read res:\/\/ui\/pause_menu\.tscn/u)).toBeVisible()
    await stableScreenshot(page, 'question-design-redrawing.png')
})

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

test('sketches tab', async ({page}) => {
    await openSession(page)
    await page.getByRole('button', {name: 'Design', exact: true}).click()
    await page.getByText('Centered Overlay').click()
    await expect(page.getByRole('button', {name: 'Send to chat'})).toBeVisible()
    await stableScreenshot(page, 'sketches-tab.png', false, true)
})

test('skills tab', async ({page}) => {
    await page.setViewportSize({width: 1600, height: 900})
    await openSession(page)
    await page.getByRole('button', {name: 'Skills', exact: true}).click()
    await expect(page.getByText('tile-levels', {exact: true})).toBeVisible()
    await expect(page.getByText('One file needs attention')).toBeVisible()
    await stableScreenshot(page, 'skills-tab.png')
})

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
    await page.getByText('func _ready() -> void:').click()
    await page.keyboard.press('F2')
    await expect(page.getByRole('button', {name: 'Preview rename'})).toBeVisible()
    await stableScreenshot(page, 'rename-dialog.png')

    await page.getByRole('textbox', {name: 'New name'}).fill('on_ready')
    await page.getByRole('button', {name: 'Preview rename'}).click()
    await expect(page.getByRole('button', {name: 'Apply rename'})).toBeVisible()
    await stableScreenshot(page, 'rename-preview-dialog.png', true)
})

const GREY_PNG =
    'iVBORw0KGgoAAAANSUhEUgAAAPAAAACMCAIAAADN17N/AAACGUlEQVR4nO3OQQkAMQADsOoce5x/FWeiUBiBCEjO/eAZmQ+gKPMBFGU+gKLMB1CU+QCKMh9AUeYDKMp8AEWZD6Ao8wEUZT6AoswHUJT5AIoyH0BR5gMoynwARZkPoCjzARRlPoCizAdQlPkAijIfQFHmAyjKfABFmQ+gKPMBFGU+gKLMB1CU+QCKMh9AUeYDKMp8AEWZD6Ao8wEUZT6AoswHUJT5AIoyH0BR5gMoynwARZkPoCjzARRlPoCizAdQlPkAijIfQFHmAyjKfABFmQ+gKPMBFGU+gKLMB1CU+QCKMh9AUeYDKMp8AEWZD6Ao8wEUZT6AoswHUJT5AIoyH0BR5gMoynwARZkPoCjzARRlPoCizAdQlPkAijIfQFHmAyjKfABFmQ+gKPMBFGU+gKLMB1CU+QCKMh9AUeYDKMp8AEWZD6Ao8wEUZT6AoswHUJT5AIoyH0BR5gMoynwARZkPoCjzARRlPoCizAdQlPkAijIfQFHmAyjKfABFmQ+gKPMBFGU+gKLMB1CU+QCKMh9AUeYDKMp8AEWZD6Ao8wEUZT6AoswHUJT5AIoyH0BR5gMoynwARZkPoCjzARRlPoCizAdQlPkAijIfQFHmAyjKfABFmQ+gKPMBFGU+gKLMB1CU+QCKMh9AUeYDKMp8AEWZD6Ao8wEUZT6AoswHUJT5AIoyH0BR5gMoynwARZkPoCjzARRlPoCiH+eSj9PnhQ95AAAAAElFTkSuQmCC'

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
    await expect(thumbnail.locator('img')).not.toHaveAttribute('src', before ?? '')

    await thumbnail.click()
    await expect(canvas).toBeVisible()
    expect(await redPixels(page)).toBeGreaterThan(0)
})

import {browser} from '@wdio/tauri-service'

const FAILURES = [
    'could not be started',
    'could not be opened',
    'could not be completed',
    'could not be read',
    'could not be saved',
    'could not be deleted',
    'could not be merged',
    'The debugger could not',
    'The Godot editor did not become ready',
    'contains no project.godot',
    'is not a Godot project'
] as const

const IDLE_MS = 2_000

const BUSY_MARKERS = [
    'Loading the',
    'Preparing documentation',
    'Installing the local models',
    'Gofer is working…',
    'Attaching images…',
    'Generating response'
] as const

const EXCERPT_CHARS = 4_000

const SCRIPT_BUDGET_MS = 1_800_000

const STRETCH_MS = 120_000

export type Outcome = Readonly<{ok: boolean; reason: string; elapsedMs: number}>

type Activity = Readonly<{
    lastActivity: number
    inflight: number
    states: string[]
    errors: string[]
    patched: boolean
    ask: (command: string, args: unknown) => Promise<unknown>
}>

type ActivityWindow = Window & {__goferActivity: Activity}

export async function installActivityProbe() {
    await browser.setTimeout({script: SCRIPT_BUDGET_MS})
    for (let attempt = 0; attempt < 50; attempt++) {
        await plantActivityProbe().catch(() => undefined)
        const patched = await browser
            .execute(
                () =>
                    (window as unknown as {__goferActivity?: {patched?: boolean}}).__goferActivity
                        ?.patched === true
            )
            .catch(() => false)
        if (patched) return
        await browser.pause(200)
    }
    throw new Error(
        'the Tauri command bridge was not instrumented, so a busy backend would read as a still application'
    )
}

async function plantActivityProbe() {
    await browser.execute(() => {
        interface MutableActivity {
            lastActivity: number
            inflight: number
            states: string[]
            errors: string[]
            patched: boolean
            ask: (command: string, args: unknown) => Promise<unknown>
        }
        const scope = window as unknown as {
            __goferActivity?: MutableActivity
            __TAURI__?: {
                event?: {listen?: (name: string, handler: (event: unknown) => void) => void}
            }
            __TAURI_INTERNALS__?: {invoke?: (...args: unknown[]) => Promise<unknown>}
        }
        if (scope.__goferActivity) return
        const activity: MutableActivity = {
            lastActivity: performance.now(),
            inflight: 0,
            states: [],
            errors: [],
            patched: false,
            ask: () => Promise.reject(new Error('the command bridge was never instrumented'))
        }
        scope.__goferActivity = activity
        const touch = () => {
            activity.lastActivity = performance.now()
        }

        new MutationObserver(touch).observe(document.body, {
            subtree: true,
            childList: true,
            characterData: true,
            attributes: true
        })

        for (const name of ['godot-session-event', 'rag-progress'])
            scope.__TAURI__?.event?.listen?.(name, received => {
                touch()
                const payload = (received as {payload?: {type?: string; state?: string}}).payload
                if (payload?.type === 'stateChanged' && payload.state)
                    activity.states.push(payload.state)
            })

        const internals = scope.__TAURI_INTERNALS__
        const original = internals?.invoke
        if (internals && original) {
            activity.ask = (command: string, args: unknown) =>
                original.call(internals, command, args)
            internals.invoke = (...args: unknown[]) => {
                activity.inflight += 1
                touch()
                return original.apply(internals, args).finally(() => {
                    activity.inflight -= 1
                    touch()
                })
            }
            activity.patched = true
        }

        window.addEventListener('error', event => {
            activity.errors.push(`error: ${event.message}`)
        })
        window.addEventListener('unhandledrejection', event => {
            activity.errors.push(`rejection: ${String(event.reason)}`)
        })
        const originalError = console.error.bind(console)
        console.error = (...args: unknown[]) => {
            activity.errors.push(args.map(value => String(value)).join(' '))
            originalError(...args)
        }
    })
}

export async function pageText(): Promise<string> {
    return browser.execute(
        (limit: number) => document.body.innerText.replace(/\s+/g, ' ').trim().slice(0, limit),
        EXCERPT_CHARS
    )
}

export async function conversationText(): Promise<string> {
    return browser.execute(() =>
        (document.querySelector('[role="log"]')?.textContent ?? '').replace(/\s+/gu, ' ')
    )
}

export async function pageErrors(): Promise<readonly string[]> {
    return browser
        .execute(() => (window as unknown as ActivityWindow).__goferActivity.errors)
        .catch(() => ['the page errors were unreadable'])
}

export async function forgetSessionStates() {
    await browser.execute(() => {
        ;(window as unknown as ActivityWindow).__goferActivity.states.length = 0
    })
}

export async function sessionStates(): Promise<readonly string[]> {
    return browser.execute(() => [...(window as unknown as ActivityWindow).__goferActivity.states])
}

type TextOptions = Readonly<{
    failures?: readonly string[]
    allow?: readonly string[]
    absent?: readonly string[]
    limitMs?: number
}>

export async function untilText(
    wanted: readonly string[],
    options: TextOptions = {}
): Promise<Outcome> {
    const limitMs = options.limitMs ?? 60_000
    const started = Date.now()
    for (;;) {
        const remaining = limitMs - (Date.now() - started)
        if (remaining <= 0)
            return {
                ok: false,
                reason:
                    `still working after ${String(Date.now() - started)}ms without `
                    + `${JSON.stringify(wanted)}; it shows: ${await pageText()}`,
                elapsedMs: Date.now() - started
            }
        const outcome = await untilTextOnce(wanted, options, Math.min(remaining, STRETCH_MS))
        if (outcome.ok || outcome.reason !== '')
            return {...outcome, elapsedMs: Date.now() - started}
    }
}

async function untilTextOnce(
    wanted: readonly string[],
    options: TextOptions,
    limitMs: number
): Promise<Outcome> {
    return browser.execute(
        (
            needles: string[],
            failures: string[],
            forbidden: string[],
            markers: string[],
            idleMs: number,
            limit: number,
            excerptChars: number
        ) =>
            new Promise<Outcome>(resolve => {
                const activity = (
                    window as unknown as {
                        __goferActivity: {lastActivity: number; inflight: number}
                    }
                ).__goferActivity
                const started = performance.now()
                const readable = () => document.body.innerText.replace(/\s+/gu, ' ')
                const excerpt = () => readable().trim().slice(0, excerptChars)
                const alreadyShown = new Set(
                    failures.filter(failure => readable().includes(failure))
                )
                const finish = (outcome: Outcome) => {
                    clearInterval(poll)
                    resolve(outcome)
                }
                const poll = setInterval(() => {
                    const text = readable()
                    const elapsedMs = performance.now() - started
                    const failed = failures.find(
                        failure => !alreadyShown.has(failure) && text.includes(failure)
                    )
                    if (failed !== undefined) {
                        const at = text.indexOf(failed)
                        finish({
                            ok: false,
                            reason: `the application reported: ${text.slice(at, at + 300).replace(/\s+/g, ' ')}`,
                            elapsedMs
                        })
                        return
                    }
                    const satisfied =
                        needles.every(needle => text.includes(needle))
                        && !forbidden.some(needle => text.includes(needle))
                    if (satisfied) {
                        finish({ok: true, reason: '', elapsedMs})
                        return
                    }
                    if (markers.some(marker => text.includes(marker)) || activity.inflight > 0)
                        activity.lastActivity = performance.now()
                    const still = performance.now() - activity.lastActivity
                    if (still >= idleMs) {
                        finish({
                            ok: false,
                            reason:
                                `the application went still for ${String(Math.round(still))}ms `
                                + `without ${JSON.stringify(needles)}`
                                + (forbidden.length > 0 ?
                                    ` and away from ${JSON.stringify(forbidden)}`
                                :   '')
                                + `; it shows: ${excerpt()}`,
                            elapsedMs
                        })
                        return
                    }
                    if (elapsedMs >= limit) finish({ok: false, reason: '', elapsedMs})
                }, 100)
            }),
        wanted.map(needle => needle.replace(/\s+/gu, ' ')),
        [
            ...FAILURES.filter(failure => !(options.allow ?? []).includes(failure)),
            ...(options.failures ?? [])
        ],
        (options.absent ?? []).map(needle => needle.replace(/\s+/gu, ' ')),
        [...BUSY_MARKERS],
        IDLE_MS,
        limitMs,
        EXCERPT_CHARS
    )
}

export async function expectText(wanted: readonly string[], options: TextOptions = {}) {
    const outcome = await untilText(wanted, options)
    if (!outcome.ok) throw new Error(outcome.reason)
    return outcome
}

export async function expectGone(unwanted: readonly string[], options: TextOptions = {}) {
    return expectText([], {...options, absent: unwanted})
}

async function untilSelector(selector: string, limitMs = 30_000): Promise<Outcome> {
    return browser.execute(
        (query: string, markers: string[], idleMs: number, limit: number, excerptChars: number) =>
            new Promise<Outcome>(resolve => {
                const activity = (
                    window as unknown as {
                        __goferActivity: {lastActivity: number; inflight: number}
                    }
                ).__goferActivity
                const started = performance.now()
                const poll = setInterval(() => {
                    const elapsedMs = performance.now() - started
                    let matched: boolean
                    try {
                        matched = document.querySelector(query) !== null
                    } catch (error) {
                        clearInterval(poll)
                        resolve({
                            ok: false,
                            reason: `${query} is not a selector this page understands: ${String(error)}`,
                            elapsedMs
                        })
                        return
                    }
                    if (matched) {
                        clearInterval(poll)
                        resolve({ok: true, reason: '', elapsedMs})
                        return
                    }
                    if (
                        markers.some(marker => document.body.innerText.includes(marker))
                        || activity.inflight > 0
                    )
                        activity.lastActivity = performance.now()
                    const still = performance.now() - activity.lastActivity
                    if (still >= idleMs || elapsedMs >= limit) {
                        clearInterval(poll)
                        resolve({
                            ok: false,
                            reason:
                                `nothing matched ${query} after `
                                + `${String(Math.round(elapsedMs))}ms; the application was still `
                                + `for ${String(Math.round(still))}ms and shows: `
                                + document.body.innerText
                                    .replace(/\s+/g, ' ')
                                    .trim()
                                    .slice(0, excerptChars),
                            elapsedMs
                        })
                    }
                }, 100)
            }),
        selector,
        [...BUSY_MARKERS],
        IDLE_MS,
        limitMs,
        EXCERPT_CHARS
    )
}

export async function expectSelector(selector: string, limitMs = 30_000) {
    const outcome = await untilSelector(selector, limitMs)
    if (!outcome.ok) throw new Error(outcome.reason)
    return outcome
}

async function untilSessionState(state: string, limitMs = 90_000): Promise<Outcome> {
    return browser.execute(
        (wanted: string, markers: string[], idleMs: number, limit: number) =>
            new Promise<Outcome>(resolve => {
                const activity = (
                    window as unknown as {
                        __goferActivity: {
                            lastActivity: number
                            inflight: number
                            states: string[]
                            ask: (command: string, args: unknown) => Promise<unknown>
                        }
                    }
                ).__goferActivity
                const started = performance.now()
                let backend = 'unread'
                let asking = false
                const poll = setInterval(() => {
                    const elapsedMs = performance.now() - started
                    if (activity.states.includes(wanted) || backend === wanted) {
                        clearInterval(poll)
                        resolve({ok: true, reason: '', elapsedMs})
                        return
                    }
                    if (!asking) {
                        asking = true
                        activity
                            .ask('get_godot_session', {})
                            .then(session => {
                                const reported = (session as {state?: string} | null)?.state
                                backend = reported ?? 'offline'
                            })
                            .catch((error: unknown) => {
                                backend = `unreadable (${String(error).slice(0, 80)})`
                            })
                            .finally(() => {
                                asking = false
                            })
                    }
                    if (
                        markers.some(marker => document.body.innerText.includes(marker))
                        || activity.inflight > 0
                    )
                        activity.lastActivity = performance.now()
                    const still = performance.now() - activity.lastActivity
                    if (still >= idleMs || elapsedMs >= limit) {
                        clearInterval(poll)
                        resolve({
                            ok: false,
                            reason:
                                `the session never reported ${wanted}; the renderer saw `
                                + `${JSON.stringify(activity.states)}, the backend says `
                                + `${backend}, and then nothing happened for `
                                + `${String(Math.round(still))}ms. The window shows: `
                                + document.body.innerText
                                    .replace(/\s+/g, ' ')
                                    .trim()
                                    .slice(0, 2000),
                            elapsedMs
                        })
                    }
                }, 100)
            }),
        state,
        [...BUSY_MARKERS],
        IDLE_MS,
        limitMs
    )
}

export async function expectSessionState(state: string, limitMs = 90_000) {
    const outcome = await untilSessionState(state, limitMs)
    if (!outcome.ok) throw new Error(outcome.reason)
    return outcome
}

export async function clickSelector(selector: string, description: string, limitMs = 15_000) {
    const deadline = Date.now() + limitMs
    let lastFailure = 'it was never found'
    while (Date.now() < deadline) {
        try {
            const candidates = await browser.$$(selector).getElements()
            lastFailure = `${String(candidates.length)} matched, none displayed`
            for (const candidate of candidates) {
                if (!(await candidate.isDisplayed())) continue
                if ((await candidate.getAttribute('aria-disabled')) === 'true') {
                    lastFailure = 'it was there but disabled'
                    continue
                }
                await candidate.click()
                return
            }
        } catch (error) {
            lastFailure = String(error).split('\n')[0] ?? 'the click was refused'
        }
        await browser.pause(100)
    }
    throw new Error(
        `never clicked the ${description} (${selector}): ${lastFailure}. `
            + `The window shows: ${await pageText()}`
    )
}

export function buttonSelector(label: string) {
    const quoted = JSON.stringify(label)
    const doubled = JSON.stringify(label + label)
    return `//button[normalize-space(.)=${quoted} or normalize-space(.)=${doubled}]`
}

export async function clickButton(label: string, limitMs = 15_000) {
    await clickSelector(buttonSelector(label), `${label} button`, limitMs)
}

export function controlSelector(label: string) {
    const quoted = JSON.stringify(label)
    const doubled = JSON.stringify(label + label)
    return (
        '//*[self::button or self::a or @role="tab" or @role="radio" or @role="menuitem" '
        + 'or @role="option" or @role="switch"]'
        + `[normalize-space(.)=${quoted} or normalize-space(.)=${doubled} `
        + `or @aria-label=${quoted} or @title=${quoted}]`
    )
}

export async function clickControl(label: string, limitMs = 15_000) {
    await clickSelector(controlSelector(label), `control “${label}”`, limitMs)
}

export async function clickTab(label: string, limitMs = 15_000) {
    const quoted = JSON.stringify(label)
    const doubled = JSON.stringify(label + label)
    await clickSelector(
        '//button[@data-tab-value]'
            + `[starts-with(normalize-space(.), ${quoted}) `
            + `or starts-with(normalize-space(.), ${doubled})]`,
        `${label} tab`,
        limitMs
    )
}

export async function clickText(text: string, limitMs = 15_000) {
    await clickSelector(
        `//*[normalize-space(text())=${JSON.stringify(text)}]`,
        `element “${text}”`,
        limitMs
    )
}

export async function fillInput(selector: string, value: string) {
    for (let attempt = 0; attempt < 5; attempt++) {
        const field = browser.$(selector)
        await field.waitForDisplayed({timeout: 15_000})
        try {
            await field.click()
            await field.setValue(value)
            if ((await field.getValue()) === value) return
        } catch {}
        await browser.pause(200)
    }
    throw new Error(
        `${selector} would not take ${JSON.stringify(value)}; the window shows: ${await pageText()}`
    )
}

async function labelledInputId(label: string): Promise<string> {
    return browser.execute((wanted: string) => {
        const fields = Array.from(
            document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea')
        )
        const nameOf = (field: Element) => {
            const direct = field.getAttribute('aria-label')
            if (direct) return direct.trim()
            const labelledBy = field.getAttribute('aria-labelledby')
            if (labelledBy)
                return labelledBy
                    .split(/\s+/)
                    .map(id => document.getElementById(id)?.textContent ?? '')
                    .join(' ')
                    .trim()
            if (field.id) {
                const own = Array.from(document.querySelectorAll('label')).find(
                    entry => entry.getAttribute('for') === field.id
                )
                if (own) return own.textContent.trim()
            }
            return ''
        }
        const plain = (name: string) =>
            name
                .split('∙')[0]
                ?.replace(/\s*\([^)]*\)\s*$/u, '')
                .trim() ?? ''
        const matched = fields.find(field => plain(nameOf(field)) === wanted)
        if (!matched) return ''
        if (!matched.id) matched.id = `gofer-live-${String(Math.floor(Math.random() * 1e9))}`
        return matched.id
    }, label)
}

async function labelledInputIdWhenReady(label: string, limitMs = 15_000): Promise<string> {
    const deadline = Date.now() + limitMs
    for (;;) {
        const id = await labelledInputId(label)
        if (id !== '') return id
        if (Date.now() >= deadline) return ''
        await browser.pause(200)
    }
}

export async function fillLabelledInput(label: string, value: string) {
    for (let attempt = 0; attempt < 3; attempt++) {
        const id = await labelledInputIdWhenReady(label)
        if (id === '') break
        try {
            await fillInput(`#${id}`, value)
            return
        } catch {}
    }
    throw new Error(
        `the field labelled “${label}” would not take ${JSON.stringify(value)}; the window shows: ${await pageText()}`
    )
}

export async function labelledInputValue(label: string): Promise<string> {
    const id = await labelledInputIdWhenReady(label)
    if (id === '') throw new Error(`no field is labelled “${label}”`)
    return browser.execute(
        (fieldId: string) =>
            document.querySelector<HTMLInputElement>(`#${fieldId}`)?.value ?? '(missing)',
        id
    )
}

export async function labelledInputIsDisabled(label: string): Promise<boolean> {
    const id = await labelledInputIdWhenReady(label)
    if (id === '') throw new Error(`no field is labelled “${label}”`)
    return browser.execute((fieldId: string) => {
        const field = document.querySelector<HTMLInputElement>(`#${fieldId}`)
        if (!field) return false
        return field.disabled || field.readOnly || field.getAttribute('aria-disabled') === 'true'
    }, id)
}

export async function clickMenuItem(label: string) {
    const quoted = JSON.stringify(label)
    await clickSelector(
        `//*[@role="menuitem"][normalize-space(.)=${quoted} or starts-with(normalize-space(.), ${quoted})]`,
        `menu item “${label}”`
    )
}

export async function attachImage(name: string, mimeType: string, base64: string) {
    const attached = await browser.execute(
        (fileName: string, type: string, data: string) => {
            const input = document.querySelector<HTMLInputElement>('input[type="file"]')
            if (!input) return 'the composer has no file picker'
            const binary = atob(data)
            const bytes = new Uint8Array(binary.length)
            for (let index = 0; index < binary.length; index++)
                bytes[index] = binary.charCodeAt(index)
            const transfer = new DataTransfer()
            transfer.items.add(new File([bytes], fileName, {type}))
            try {
                input.files = transfer.files
            } catch {}
            if (input.files?.length !== 1)
                Object.defineProperty(input, 'files', {
                    configurable: true,
                    value: transfer.files
                })
            if (input.files?.length !== 1) return 'the file picker would not take the file'
            input.dispatchEvent(new Event('change', {bubbles: true}))
            return ''
        },
        name,
        mimeType,
        base64
    )
    if (attached !== '') throw new Error(`${name} was not attached: ${attached}`)
}

export async function handleSize(label: string): Promise<number> {
    return browser.execute((wanted: string) => {
        const handle = Array.from(document.querySelectorAll('[role="separator"]')).find(
            entry => entry.getAttribute('aria-label') === wanted
        )
        return Number(handle?.getAttribute('aria-valuenow') ?? Number.NaN)
    }, label)
}

export async function nudgeHandle(label: string, key: string, presses: number) {
    await clickSelector(
        `//*[@role="separator"][@aria-label=${JSON.stringify(label)}]`,
        `the ${label} handle`
    )
    for (let press = 0; press < presses; press++) await browser.keys(key)
}

export async function invokeCommand<Answer>(
    command: string,
    args: Readonly<Record<string, unknown>> = {}
): Promise<Answer> {
    return browser.execute(
        (name: string, payload: Record<string, unknown>) =>
            (
                window as unknown as {
                    __TAURI_INTERNALS__: {invoke: (c: string, a: unknown) => Promise<unknown>}
                }
            ).__TAURI_INTERNALS__.invoke(name, payload),
        command,
        {...args}
    ) as Promise<Answer>
}

export async function isNarrowLayout(): Promise<boolean> {
    return browser.execute(() => window.matchMedia('(max-width: 1024px)').matches)
}

export async function regionText(label: string): Promise<string> {
    return browser.execute((wanted: string) => {
        const region = Array.from(document.querySelectorAll('[aria-label]')).find(
            entry => entry.getAttribute('aria-label') === wanted
        )
        return (region as HTMLElement | null)?.innerText.replace(/\s+/gu, ' ').trim() ?? ''
    }, label)
}

export async function dialogText(): Promise<string> {
    return browser.execute(
        () =>
            document
                .querySelector<HTMLElement>('dialog[open]')
                ?.innerText.replace(/\s+/gu, ' ')
                .trim() ?? ''
    )
}

export async function shows(text: string): Promise<boolean> {
    return browser.execute(
        (needle: string) => document.body.innerText.replace(/\s+/gu, ' ').includes(needle),
        text.replace(/\s+/gu, ' ')
    )
}

export async function renderedLines(): Promise<readonly string[]> {
    return browser.execute(() =>
        Array.from(document.querySelectorAll('.monaco-editor .margin-view-overlays > div'))
            .map(overlay => overlay.querySelector('.line-numbers')?.textContent ?? '')
            .filter(Boolean)
    )
}

const KEY = {
    release: '\uE000',
    arrowUp: '\uE013',
    arrowDown: '\uE015'
} as const

export const KEYS = {
    delete: '\uE017',
    arrowLeft: '\uE012',
    arrowRight: '\uE014',
    end: '\uE010',
    f2: '\uE032'
} as const

const EDITOR_HOST = '[data-testid="script-editor-host"]'

export async function typeInEditor(text: string) {
    await focusEditorInput()
    const typed = await browser.execute(
        (host: string, value: string) => {
            const input = document.querySelector<HTMLTextAreaElement>(`${host} textarea`)
            if (!input) return 'the editor has no input'
            const before = input.value.slice(0, input.selectionStart)
            const after = input.value.slice(input.selectionEnd)
            input.value = before + value + after
            input.setSelectionRange(before.length + value.length, before.length + value.length)
            input.dispatchEvent(
                new InputEvent('input', {inputType: 'insertText', data: value, bubbles: true})
            )
            return ''
        },
        EDITOR_HOST,
        text
    )
    if (typed !== '') throw new Error(`${JSON.stringify(text)} was not typed: ${typed}`)
}

export async function releaseModifiers() {
    await browser.keys(KEY.release)
}

async function focusEditorInput() {
    await expectSelector(`${EDITOR_HOST} textarea`, 15_000)
    const focused = await browser.execute((host: string) => {
        const input = document.querySelector<HTMLTextAreaElement>(`${host} textarea`)
        input?.focus()
        return document.activeElement === input
    }, EDITOR_HOST)
    if (!focused)
        throw new Error(
            `the script editor would not take focus; the window shows: ${await pageText()}`
        )
}

export async function revealLine(line: number) {
    await focusEditorInput()
    for (let step = 0; step < 400; step++) {
        const shown = (await renderedLines()).map(Number)
        if (shown.includes(line)) return
        if (shown.length === 0) throw new Error('Monaco is rendering no lines at all')
        await browser.keys(Math.min(...shown) < line ? KEY.arrowDown : KEY.arrowUp)
    }
    throw new Error(
        `Monaco never reached line ${String(line)}; it shows `
            + JSON.stringify(await renderedLines())
    )
}

export async function placeCaretAtStart() {
    await placeCaretAtLineStart(1)
}

export async function placeCaretAtLineStart(line: number) {
    await revealLine(line)
    const point = await browser.execute(
        (host: string, wanted: number) => {
            const editor = document.querySelector(`${host} .monaco-editor`)
            if (!editor) return undefined
            const overlay = Array.from(editor.querySelectorAll('.margin-view-overlays > div')).find(
                entry => entry.querySelector('.line-numbers')?.textContent === String(wanted)
            )
            const lines = editor.querySelector('.view-lines')
            if (!overlay || !lines) return undefined
            const row = overlay.getBoundingClientRect()
            return {
                x: lines.getBoundingClientRect().left + 1,
                y: row.top + row.height / 2
            }
        },
        EDITOR_HOST,
        line
    )
    if (!point) throw new Error(`Monaco is not rendering line ${String(line)} to put the caret on`)
    await clickPoint(point.x, point.y)
}

export async function expectEnabled(label: string, limitMs = 60_000) {
    const selector = controlSelector(label)
    const deadline = Date.now() + limitMs
    while (Date.now() < deadline) {
        const [button] = await browser.$$(selector).getElements()
        if (button && (await button.isEnabled())) return
        await browser.pause(150)
    }
    throw new Error(
        `the ${label} button stayed disabled for ${String(limitMs)}ms; the window shows: `
            + (await pageText())
    )
}

export async function count(selector: string): Promise<number> {
    return browser.execute((query: string) => document.querySelectorAll(query).length, selector)
}

async function clickPoint(x: number, y: number): Promise<string> {
    return browser.execute(
        (px: number, py: number) => {
            const target = document.elementFromPoint(px, py)
            if (!target) return 'nothing is at that point'
            const at = {bubbles: true, cancelable: true, clientX: px, clientY: py, button: 0}
            target.dispatchEvent(new MouseEvent('mousedown', {...at, buttons: 1}))
            target.dispatchEvent(new MouseEvent('mouseup', at))
            target.dispatchEvent(new MouseEvent('click', at))
            return target.className || target.tagName
        },
        Math.round(x),
        Math.round(y)
    )
}

export async function pressGlyphMargin(line: number): Promise<string> {
    const outcome = await browser.execute(
        (host: string, wanted: number) => {
            const editor = document.querySelector(`${host} .monaco-editor`)
            if (!editor) return 'no editor is open'
            const overlay = Array.from(editor.querySelectorAll('.margin-view-overlays > div')).find(
                entry => entry.querySelector('.line-numbers')?.textContent === String(wanted)
            )
            if (!overlay) return `line ${String(wanted)} is not rendered`
            const box = overlay.getBoundingClientRect()
            const at = {
                bubbles: true,
                cancelable: true,
                clientX: box.left + 2,
                clientY: box.top + box.height / 2,
                button: 0,
                detail: 1
            }
            overlay.dispatchEvent(new MouseEvent('mousedown', {...at, buttons: 1}))
            overlay.dispatchEvent(new MouseEvent('mouseup', at))
            return ''
        },
        EDITOR_HOST,
        line
    )
    return outcome
}

export async function expectElement(selector: string, description: string, limitMs = 30_000) {
    const deadline = Date.now() + limitMs
    while (Date.now() < deadline) {
        const matches = await browser.$$(selector).getElements()
        if (matches.length > 0) return
        await browser.pause(150)
    }
    throw new Error(
        `no ${description} appeared within ${String(limitMs)}ms; the window shows: ${await pageText()}`
    )
}

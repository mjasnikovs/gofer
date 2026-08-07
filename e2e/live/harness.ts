import {browser} from '@wdio/tauri-service'

/**
 * The primitives a live sweep is built from.
 *
 * Nothing here waits on a clock. Every wait is handed to the *page*, which polls its own condition
 * and answers the instant it holds — or the instant the application says it failed, or the instant
 * the application stops doing anything at all. A step that cannot succeed therefore reports the
 * sentence the user would have read, in the second it appeared, rather than a timeout minutes
 * later. Hard limits exist only as the outer bound on an application that never stops working.
 */

/** The application's own failure surfaces. Any of these ends a wait immediately. */
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

/**
 * How long the application may be completely still before a wait gives up on it.
 *
 * Stillness means no DOM mutation, no backend event, no command in flight, and nothing on screen
 * claiming to be busy. An application in that state is not working on anything, and waiting longer
 * cannot change the outcome — so the wait ends there and reports what the window shows.
 */
const IDLE_MS = 2_000

/**
 * What the application renders while it is working.
 *
 * This is the honest substitute for counting requests the page cannot see: a panel reading its data
 * says so, the splash preparing models says so, and a streaming answer mutates continuously. While
 * any of it is on screen the application is busy, however still the rest of the page is.
 */
const BUSY_MARKERS = [
    'Loading the',
    'Preparing documentation',
    'Installing the local models',
    'Gofer is working…',
    'Attaching images…',
    'Generating response'
] as const

/** How much of the window a failure quotes. Panels sit deep in the document; a short excerpt of it
 * would report the sidebar instead of the thing that went wrong. */
const EXCERPT_CHARS = 4_000

/**
 * How long the driver lets one in-page wait block.
 *
 * Every wait in this file runs inside the page, so this is the ceiling on all of them: a budget
 * shorter than the longest step turns a working application into a driver error that says nothing
 * about it. An agent turn that authors a scene is the longest step there is.
 */
const SCRIPT_BUDGET_MS = 1_800_000

/**
 * How long one call into the page may block.
 *
 * The driver's transport gives up on a request of its own accord well before the longest wait this
 * sweep makes, so waits are handed over in stretches of this length and resumed. It is a property
 * of the wire, not of the application.
 */
const STRETCH_MS = 120_000

export type Outcome = Readonly<{ok: boolean; reason: string; elapsedMs: number}>

/** The activity record the page keeps about itself, read by every wait below. */
type Activity = Readonly<{
    lastActivity: number
    inflight: number
    states: string[]
    errors: string[]
    patched: boolean
    /**
     * The command bridge as it was before instrumentation.
     *
     * A wait that wants to ask the backend a question has to ask it without answering its own
     * question: going through the counted bridge would mark the application busy for as long as
     * the polling continued, and no wait would ever find it still.
     */
    ask: (command: string, args: unknown) => Promise<unknown>
}>

type ActivityWindow = Window & {__goferActivity: Activity}

/**
 * Teaches the page to record what it is doing.
 *
 * Four independent signs of life, because no one of them covers the application alone: the DOM
 * mutates while it renders, the backend pushes lifecycle and stream events while it works, a Tauri
 * command is in flight while Rust is busy on the renderer's behalf — that last one is the only sign
 * a scene load or a model download gives — and the on-screen busy text covers what the others miss.
 */
export async function installActivityProbe() {
    // The waits below block inside the page, so the driver's script budget has to outlast them —
    // including the one that waits out an agent turn authoring a scene.
    await browser.setTimeout({script: SCRIPT_BUDGET_MS})
    // A reloading window throws the probe away, and it throws away a probe installed into the
    // document it is replacing too — so installation is repeated until the page it landed in is
    // the page that stayed.
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
        // The probe survives route changes, so a second installation would double every counter.
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

        // The AI turn is not here: its deltas ride a channel, and the DOM they change is what the
        // observer above already counts as activity.
        for (const name of ['godot-session-event', 'rag-progress'])
            scope.__TAURI__?.event?.listen?.(name, received => {
                touch()
                const payload = (received as {payload?: {type?: string; state?: string}}).payload
                if (payload?.type === 'stateChanged' && payload.state)
                    activity.states.push(payload.state)
            })

        // Every command the renderer makes goes through this one function. Counting what is in
        // flight is what tells a backend that is working from one that has finished and answered
        // with nothing — the two look identical from the DOM.
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

/** What the application currently shows, as the failure messages quote it. */
export async function pageText(): Promise<string> {
    return browser.execute(
        (limit: number) => document.body.innerText.replace(/\s+/g, ' ').trim().slice(0, limit),
        EXCERPT_CHARS
    )
}

/**
 * Everything the conversation holds, including what its viewport has scrolled past.
 *
 * WebKit's `innerText` is what the eye can see: a message list that has scrolled leaves its earlier
 * answers out of it entirely, so an assertion about what the model said cannot be made against the
 * window's text. The list is a `role="log"` region, and its `textContent` is the whole transcript.
 */
export async function conversationText(): Promise<string> {
    return browser.execute(() =>
        (document.querySelector('[role="log"]')?.textContent ?? '').replace(/\s+/gu, ' ')
    )
}

/** Everything the renderer logged as an error, in order. */
export async function pageErrors(): Promise<readonly string[]> {
    return browser
        .execute(() => (window as unknown as ActivityWindow).__goferActivity.errors)
        .catch(() => ['the page errors were unreadable'])
}

/** Forgets the session states seen so far, so a later wait means "again" rather than "ever". */
export async function forgetSessionStates() {
    await browser.execute(() => {
        ;(window as unknown as ActivityWindow).__goferActivity.states.length = 0
    })
}

/** The session states the backend has reported since the last [`forgetSessionStates`]. */
export async function sessionStates(): Promise<readonly string[]> {
    return browser.execute(() => [...(window as unknown as ActivityWindow).__goferActivity.states])
}

type TextOptions = Readonly<{
    /** Text whose appearance ends the wait as a failure, on top of the standard surfaces. */
    failures?: readonly string[]
    /**
     * Standard failure surfaces this wait is expecting to see.
     *
     * A test whose subject *is* a refusal has to be able to wait for it; without this the shared
     * list would end the wait as a failure the moment the application said the very thing the test
     * came to read.
     */
    allow?: readonly string[]
    /** Text that must be absent for the wait to succeed. */
    absent?: readonly string[]
    limitMs?: number
}>

/**
 * Blocks until the page shows every one of `wanted`, shows a failure, or stops doing anything.
 *
 * The third case is the one that matters. A test that waits a fixed span for a click to have an
 * effect cannot tell a slow application from a dead one, and reports the same timeout for both.
 *
 * The waiting is handed to the page in stretches rather than in one call, because the transport
 * between this process and the window has its own limit: a single script that blocks past it comes
 * back as `UND_ERR_HEADERS_TIMEOUT`, which says nothing about the application. Stretching across
 * several calls changes nothing the page sees — the activity record it polls lives in the page and
 * outlives each one — so a step may still wait out an agent turn that takes a quarter of an hour.
 */
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
        // An empty reason on a failed outcome is this stretch expiring, not the application.
        if (outcome.ok || outcome.reason !== '')
            return {...outcome, elapsedMs: Date.now() - started}
    }
}

/** One stretch of the wait above, bounded by what the transport will carry. */
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
                // Monaco renders a run of spaces as non-breaking ones, and a rendered line ends
                // with no separator at all — so the window's raw text holds "#\u00a0changed" where
                // the eye reads "# changed". Every comparison below is made on the same normalized
                // text the failure quotes, or a step would fail against a window that shows exactly
                // what it asked for.
                const readable = () => document.body.innerText.replace(/\s+/gu, ' ')
                const excerpt = () => readable().trim().slice(0, excerptChars)
                // A failure the window was already showing belongs to the step that produced it.
                // The panels keep their last error until something replaces it, so counting those
                // would fail every later step with a sentence about an earlier one.
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
                    // Failure first: a page can hold a wanted word inside the very sentence that
                    // reports the failure.
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
                    // The stretch is up: an empty reason asks the caller for another one.
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

/** Asserts the page reaches this state, quoting what it said instead if it did not. */
export async function expectText(wanted: readonly string[], options: TextOptions = {}) {
    const outcome = await untilText(wanted, options)
    // The application's own words are the failure: a matcher would replace them with "false".
    if (!outcome.ok) throw new Error(outcome.reason)
    return outcome
}

/** Asserts the page stops showing this text. */
export async function expectGone(unwanted: readonly string[], options: TextOptions = {}) {
    return expectText([], {...options, absent: unwanted})
}

/** Blocks until an element matching this selector exists, on the same activity contract. */
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

/**
 * Blocks until the backend reports this session state.
 *
 * Lifecycle is an event, not a rendering: the game reaching `playing` is something the editor tells
 * Gofer, and waiting for the label that follows it would be waiting for a consequence. Two sources
 * answer the same question — the events the renderer received, and the backend's own view — so a
 * state that arrived before the listener was ready, or that the renderer never saw, is still found.
 * The backend is asked through the uncounted bridge: a poll that marked the application busy would
 * keep every wait from ever finding it still.
 */
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

/**
 * Clicks, re-resolving the element on every attempt.
 *
 * WebKitGTK reports plenty of visible, enabled buttons as unclickable, and a route change remounts
 * the element behind any handle held across it, so a click is retried rather than reported. What is
 * never retried away is the element's absence: the failure names the window.
 */
export async function clickSelector(selector: string, description: string, limitMs = 15_000) {
    const deadline = Date.now() + limitMs
    let lastFailure = 'it was never found'
    while (Date.now() < deadline) {
        try {
            // Every match, not the first: a dialog that has been dismissed leaves its buttons in
            // the document at zero size, and they sort ahead of the visible one.
            const candidates = await browser.$$(selector).getElements()
            lastFailure = `${String(candidates.length)} matched, none displayed`
            for (const candidate of candidates) {
                if (!(await candidate.isDisplayed())) continue
                // A control the design system is refusing stays focusable and says so with ARIA
                // rather than the attribute, so WebDriver clicks it and nothing happens — the step
                // then fails several assertions later, about something else. Waiting for it to be
                // offered is what a person does, and the failure names the refusal.
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

/** The design system renders a button's label twice, so an exact match accepts both. */
export function buttonSelector(label: string) {
    const quoted = JSON.stringify(label)
    const doubled = JSON.stringify(label + label)
    return `//button[normalize-space(.)=${quoted} or normalize-space(.)=${doubled}]`
}

export async function clickButton(label: string, limitMs = 15_000) {
    await clickSelector(buttonSelector(label), `${label} button`, limitMs)
}

/**
 * Whatever interactive thing carries this label — a button, a tab, a segment, a menu item, or an
 * icon that only has an accessible name. The user does not distinguish them, and neither do the
 * coverage requirements.
 */
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

/**
 * Clicks a tab by the label it starts with.
 *
 * A tab's text is not only its label: Problems carries the number of errors, and a script tab
 * carries its own, so an exact match stops working the moment the thing being tested happens.
 */
export async function clickTab(label: string, limitMs = 15_000) {
    const quoted = JSON.stringify(label)
    const doubled = JSON.stringify(label + label)
    await clickSelector(
        // The attribute the design system puts on every tab: its tabs carry no tab role, and a
        // bare prefix would just as happily match the file tree entry of the same name.
        '//button[@data-tab-value]'
            + `[starts-with(normalize-space(.), ${quoted}) `
            + `or starts-with(normalize-space(.), ${doubled})]`,
        `${label} tab`,
        limitMs
    )
}

/** Clicks the element whose own text node is exactly this, ignoring its descendants' text. */
export async function clickText(text: string, limitMs = 15_000) {
    await clickSelector(
        `//*[normalize-space(text())=${JSON.stringify(text)}]`,
        `element “${text}”`,
        limitMs
    )
}

/**
 * Types into a labelled control, replacing whatever it held, and checks that it took the text.
 *
 * One field can be several fields over its lifetime — the output panel's box changes its label with
 * the scope it is filtering — and a click that lands just before that remount leaves the typing with
 * an element the document no longer has. What the field holds afterwards is the only proof.
 */
export async function fillInput(selector: string, value: string) {
    for (let attempt = 0; attempt < 5; attempt++) {
        const field = browser.$(selector)
        await field.waitForDisplayed({timeout: 15_000})
        try {
            await field.click()
            await field.setValue(value)
            if ((await field.getValue()) === value) return
        } catch {
            // A remount between the click and the typing; the next attempt finds the new element.
        }
        await browser.pause(200)
    }
    throw new Error(
        `${selector} would not take ${JSON.stringify(value)}; the window shows: ${await pageText()}`
    )
}

/**
 * Finds a field by the name a person reads, and gives it an id if it has none.
 *
 * The design system labels its inputs through `aria-labelledby`, so there is no attribute on the
 * input itself carrying the words on screen; the placeholder the other waits use exists on some
 * fields and not on the settings form at all. Resolving the accessible name in the page is what
 * lets a step name "Base URL" rather than an id React generated this render.
 */
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
        // The accessible name carries more than the words on the label: the design system appends
        // "∙ Required" or "∙ Optional", and some labels name their unit in brackets.
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

/**
 * The id of the field with this label, waited for rather than asked once.
 *
 * A panel that has just been switched to renders its filter box after the fetch behind it answers,
 * so asking the moment the tab click returns is asking too early.
 */
async function labelledInputIdWhenReady(label: string, limitMs = 15_000): Promise<string> {
    const deadline = Date.now() + limitMs
    for (;;) {
        const id = await labelledInputId(label)
        if (id !== '') return id
        if (Date.now() >= deadline) return ''
        await browser.pause(200)
    }
}

/**
 * Types into the field a person would find by this label.
 *
 * The id is re-resolved on every attempt: `labelledInputId` puts a generated id on a field that has
 * none, and a remount takes that id away with the element, so a single lookup would leave the typing
 * addressed to something the document no longer holds.
 */
export async function fillLabelledInput(label: string, value: string) {
    for (let attempt = 0; attempt < 3; attempt++) {
        const id = await labelledInputIdWhenReady(label)
        if (id === '') break
        try {
            await fillInput(`#${id}`, value)
            return
        } catch {
            // The field was remounted under the id this attempt gave it; the next one re-finds it.
        }
    }
    throw new Error(
        `the field labelled “${label}” would not take ${JSON.stringify(value)}; the window shows: ${await pageText()}`
    )
}

/** What the field with this label currently holds. */
export async function labelledInputValue(label: string): Promise<string> {
    const id = await labelledInputIdWhenReady(label)
    if (id === '') throw new Error(`no field is labelled “${label}”`)
    return browser.execute(
        (fieldId: string) =>
            document.querySelector<HTMLInputElement>(`#${fieldId}`)?.value ?? '(missing)',
        id
    )
}

/**
 * Whether the field with this label refuses input, which is how the form says it is fixed.
 *
 * A design system has three ways to say it, and which one it picked is its business: the DOM's own
 * `disabled`, the ARIA attribute a still-focusable control uses instead, and read-only.
 */
export async function labelledInputIsDisabled(label: string): Promise<boolean> {
    const id = await labelledInputIdWhenReady(label)
    if (id === '') throw new Error(`no field is labelled “${label}”`)
    return browser.execute((fieldId: string) => {
        const field = document.querySelector<HTMLInputElement>(`#${fieldId}`)
        if (!field) return false
        return field.disabled || field.readOnly || field.getAttribute('aria-disabled') === 'true'
    }, id)
}

/** Clicks an item in whichever menu is open. */
export async function clickMenuItem(label: string) {
    const quoted = JSON.stringify(label)
    await clickSelector(
        `//*[@role="menuitem"][normalize-space(.)=${quoted} or starts-with(normalize-space(.), ${quoted})]`,
        `menu item “${label}”`
    )
}

/**
 * Hands a file to the composer's picker without opening the desktop's file dialog.
 *
 * Pressing "Attach images" calls `click()` on a hidden `input[type=file]`, and a real file dialog
 * has no window this driver can reach — it would hang the sweep on a modal only a person can
 * dismiss. WebKitGTK's driver refuses to upload into the control directly as well, so what is built
 * here is the exact result the dialog produces: a `FileList` holding one real `File`, on the input,
 * followed by the `change` event the application listens for. The list is read back before the
 * event, because assigning `files` is not implemented everywhere and a silent no-op would look like
 * an application that ignored the picture.
 */
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
            } catch {
                // Older WebKit leaves `files` read-only; shadowing it on the element itself is what
                // the application's own handler reads either way.
            }
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

/** The width a resize handle reports, which is the panel's own size. */
export async function handleSize(label: string): Promise<number> {
    return browser.execute((wanted: string) => {
        const handle = Array.from(document.querySelectorAll('[role="separator"]')).find(
            entry => entry.getAttribute('aria-label') === wanted
        )
        return Number(handle?.getAttribute('aria-valuenow') ?? Number.NaN)
    }, label)
}

/** Drags a resize handle with the keyboard, which is the way it is reachable without a pointer. */
export async function nudgeHandle(label: string, key: string, presses: number) {
    await clickSelector(
        `//*[@role="separator"][@aria-label=${JSON.stringify(label)}]`,
        `the ${label} handle`
    )
    for (let press = 0; press < presses; press++) await browser.keys(key)
}

/**
 * Asks the backend a question through the same bridge the renderer uses.
 *
 * Some facts a sweep needs are the backend's, not the window's — which worktree the running editor
 * is bound to, say. Reading them from Rust is exact; guessing them from a path listing is not.
 */
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

/**
 * Whether the frame is in its narrow layout.
 *
 * Under 1024px the inspector moves out of the frame and into a dialog opened from the toolbar.
 * A tiling window manager hands the application whatever width it likes, so a sweep cannot assume
 * either layout; it asks.
 */
export async function isNarrowLayout(): Promise<boolean> {
    return browser.execute(() => window.matchMedia('(max-width: 1024px)').matches)
}

/**
 * What one labelled region of the window reads.
 *
 * The whole page is the wrong thing to assert a panel against: the chat column holds the agent's
 * own answer, and an answer that names the nodes it created satisfies a search for those names
 * whether or not the panel ever showed them.
 */
export async function regionText(label: string): Promise<string> {
    return browser.execute((wanted: string) => {
        const region = Array.from(document.querySelectorAll('[aria-label]')).find(
            entry => entry.getAttribute('aria-label') === wanted
        )
        return (region as HTMLElement | null)?.innerText.replace(/\s+/gu, ' ').trim() ?? ''
    }, label)
}

/** Whether the page currently shows this text. A question, not a wait. */
export async function shows(text: string): Promise<boolean> {
    return browser.execute(
        (needle: string) => document.body.innerText.replace(/\s+/gu, ' ').includes(needle),
        text.replace(/\s+/gu, ' ')
    )
}

/** The line numbers Monaco currently has in the document. It renders no others. */
export async function renderedLines(): Promise<readonly string[]> {
    return browser.execute(() =>
        Array.from(document.querySelectorAll('.monaco-editor .margin-view-overlays > div'))
            .map(overlay => overlay.querySelector('.line-numbers')?.textContent ?? '')
            .filter(Boolean)
    )
}

/**
 * The WebDriver names for the keys a sweep presses.
 *
 * They are sent as characters rather than as an array, because the array form holds a modifier down
 * for the rest of the sequence — and a modifier that is never released turns every later keystroke
 * into a shortcut. That is how an earlier sweep typed its script into Monaco's find widget.
 */
const KEY = {
    release: '\uE000',
    arrowUp: '\uE013',
    arrowDown: '\uE015'
} as const

/** The keys a sweep presses one at a time, which is the only way this platform delivers them. */
export const KEYS = {
    delete: '\uE017',
    arrowLeft: '\uE012',
    arrowRight: '\uE014',
    end: '\uE010',
    f2: '\uE032'
} as const

const EDITOR_HOST = '[data-testid="script-editor-host"]'

/**
 * Types into the open script.
 *
 * Monaco is driven through its own input pipeline rather than through WebDriver keystrokes.
 * WebKitGTK delivers a burst of synthetic keys to Monaco out of order and, worse, lets its
 * completion popup eat the arrows and the newline: an earlier sweep asked for `var broken := ` and
 * got `var rbrr`, with the rest of the file re-indented around it. `insertText` on the focused
 * textarea is the same DOM event a real keystroke produces — it is Monaco's own `input` handler
 * that receives it — so what is exercised is still the editor reacting to typing, minus a key
 * transport this platform cannot be trusted with.
 */
export async function typeInEditor(text: string) {
    await focusEditorInput()
    const typed = await browser.execute(
        (host: string, value: string) => {
            const input = document.querySelector<HTMLTextAreaElement>(`${host} textarea`)
            if (!input) return 'the editor has no input'
            // Monaco keeps the editor's selection — and, for screen readers, some of the text
            // around it — in this textarea, and diffs it against what the browser leaves behind.
            // Replacing the selection and putting the caret after it is exactly the state a typed
            // character produces; appending to the whole thing is not, and Monaco reads the
            // difference as the surrounding text having been typed again.
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

/** Releases any modifier an earlier step left held down. */
export async function releaseModifiers() {
    await browser.keys(KEY.release)
}

/** Gives the keyboard to Monaco's hidden input, which is where it reads keys from. */
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

/**
 * Scrolls the open script until Monaco is rendering this line, by walking the caret onto it.
 *
 * Monaco renders no line it is not showing, and the editor is a handful of lines tall in a window a
 * tiling manager has squeezed — so the gutter of line 19 does not exist in the document until the
 * editor has been scrolled to it. The caret is walked rather than jumped because a jump is a chord,
 * and this platform delivers one key at a time or not at all.
 */
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

/**
 * Puts the caret at the very start of the open script.
 *
 * Typing goes in at the editor's caret, and the caret is wherever the last step left it — including
 * inside a word, which is how an earlier sweep produced `ex# gofer sweeptends Node2D`. Clicking the
 * first line's left edge is a place a person can put it and a place this sweep can name.
 */
export async function placeCaretAtStart() {
    await placeCaretAtLineStart(1)
}

/**
 * Puts the caret at the left edge of one line.
 *
 * Which line matters as soon as the text being typed has to be valid: GDScript accepts `extends`
 * only at the top of a file, so an edit typed at position zero produces a script the language
 * server refuses — and every later step then measures a broken file instead of the feature.
 * The line is found by its gutter number rather than by counting rendered rows, which are only the
 * ones Monaco is showing.
 */
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
            // The gutter says which row; the text column says where the line's own left edge is.
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

/** Blocks until a control is enabled again, which is how a busy panel says it has finished. */
export async function expectEnabled(label: string, limitMs = 60_000) {
    // A toolbar too narrow for seven labels draws its actions as icons, so the control carrying
    // this label is as often named by `aria-label` as by the words inside it.
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

/** How many elements match. A question, not a wait. */
export async function count(selector: string): Promise<number> {
    return browser.execute((query: string) => document.querySelectorAll(query).length, selector)
}

/**
 * Clicks whatever is at a viewport coordinate, and reports what that was.
 *
 * Monaco's breakpoint gutter is not an element with a stable selector — it is a strip beside a
 * rendered line — so the only way to press it is where it actually is. What was under the pointer
 * is returned rather than assumed, because a click that lands one strip over does nothing at all
 * and would otherwise be indistinguishable from a broken gutter.
 */
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

/**
 * Presses Monaco's breakpoint gutter beside one line.
 *
 * The press is dispatched on the line's own margin overlay with the coordinate of the glyph strip,
 * because Monaco decides which part of the gutter was hit from the coordinate rather than from what
 * is painted on top: the editor's margin extends under the explorer column here, so a hit test at
 * the same point answers with the file tree and a real pointer would press that instead.
 */
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

/**
 * Blocks until at least one element matches, on the same activity contract as the text waits.
 *
 * WebKit's `innerText` omits whatever a scroll container has moved out of view, so a control that
 * exists but has scrolled away — the Retry beneath a long answer, say — cannot be waited for as
 * text. The document still has it.
 */
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

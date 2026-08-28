import {expect} from '@wdio/globals'
import {browser} from '@wdio/tauri-service'
import {existsSync, readFileSync} from 'node:fs'
import {resolve} from 'node:path'

type SessionSummary = Readonly<{
    sessionId: string
    state: string
    worktree: string
}>

type CallResponse = Readonly<{
    id: string
    result: Record<string, unknown>
    revision?: number
}>

let godotRequestId = 1
let revision = 0

async function waitForReadyWorkspace() {
    await expect(browser.$('body')).toHaveText(expect.stringContaining('Gofer is ready'))
    await expect(browser.$('[aria-label="Local AI connected"]')).toBeExisting()
}

/**
 * The composer's role is whichever one Astryx last spread over its editable.
 *
 * `ChatComposerInput` writes `role="textbox"` and then, once the composer is given triggers,
 * spreads `role="combobox"` over the top of it. Gofer's composer has the file-mention trigger, so
 * it is a combobox today — and a selector naming only one of the two silently stops matching the
 * moment that changes, which is a journey that cannot find the box it types into.
 */
const COMPOSER = '[role="combobox"], [role="textbox"]'

async function sendMessage(text: string) {
    const composer = browser.$(COMPOSER)
    await composer.setValue(text)
    await browser.keys('Enter')
}

/** Invokes one of the application's own commands in the packaged renderer. */
function command<Response>(name: string, payload: Record<string, unknown>): Promise<Response> {
    return browser.execute(
        async (invoked: string, argument: Record<string, unknown>) => {
            const invoke = window.__TAURI__?.core?.invoke
            if (!invoke) throw new Error('Tauri invoke is unavailable in the packaged renderer')
            return invoke(invoked, argument)
        },
        name,
        payload
    ) as Promise<Response>
}

/**
 * One protocol v2 request to the Gofer addon inside the managed editor.
 *
 * This is the renderer's own `call_godot` command, not a test-only transport: the packaged journey
 * proves the shipped path from the window to the editor rather than a parallel one.
 */
async function callGodot(
    name: string,
    params: Record<string, unknown>,
    mutating = false,
    timeoutMs = 60_000
) {
    const response = await command<CallResponse>('call_godot', {
        request: {
            id: `packaged-${String(godotRequestId++)}`,
            command: name,
            params,
            ...(mutating && {expectedRevision: revision}),
            timeoutMs
        }
    })
    if (typeof response.revision === 'number') revision = response.revision
    return response.result
}

/** The session output the application captured, quoted when the editor never answers. */
async function sessionOutput() {
    const page = await command<{entries: {message: string}[]}>('read_godot_logs', {
        query: {limit: 60}
    })
    return page.entries.map(entry => entry.message).join('\n')
}

/**
 * Waits for the addon inside the editor to report a ready session.
 *
 * Starting a session spawns the editor; the addon connects back only once Godot has imported the
 * project and enabled the plugin, so readiness is asked of the addon itself rather than inferred
 * from the process being alive.
 */
async function awaitReadySession() {
    const started = await command<SessionSummary>('start_godot_session', {request: {}})
    expect(started.sessionId).not.toBe('')
    let last = 'no reply'
    for (let attempt = 0; attempt < 480; attempt++) {
        try {
            const state = await callGodot('session.get_state', {}, false, 3_000)
            if (state['state'] === 'ready') return started
            last = JSON.stringify(state)
        } catch (error) {
            last = String(error)
        }
        await browser.pause(250)
    }
    throw new Error(
        `The packaged Godot session never became ready: ${last}\n--- session output ---\n${await sessionOutput()}`
    )
}

describe('packaged desktop application', () => {
    it('completes the deterministic packaged journey and restores persisted state', async () => {
        await waitForReadyWorkspace()
        const windows = await browser.tauri.listWindows()
        expect(windows).toContain('main')

        const session = await awaitReadySession()
        const settings = await callGodot('project.get_settings', {})
        expect(settings['projectName']).toBe('Gofer Protocol Fixture')

        const scene = 'res://packaged.tscn'
        await callGodot('scene.create', {path: scene, rootType: 'Node2D'}, true)
        await callGodot(
            'node.create',
            {scene, parent: '/packaged', name: 'PackagedNode', type: 'Node2D'},
            true
        )
        await callGodot(
            'node.set_property',
            {
                scene,
                node: '/packaged/PackagedNode',
                property: 'position',
                value: {type: 'vector2', value: [12, 34]}
            },
            true
        )
        // The scene lives in memory until it is explicitly saved, which is what makes the file on
        // disk evidence that the whole path — window, command, RPC, editor — did the work.
        await callGodot('scene.save', {}, true)

        const savedScene = readFileSync(resolve(session.worktree, 'packaged.tscn'), 'utf8')
        expect(savedScene).toContain('PackagedNode')
        expect(savedScene).toContain('Vector2(12, 34)')

        // The formatter is the one sidecar Gofer ships rather than launches from the user's
        // machine, so the packaged application is the only place its bundled resolution can be
        // proven: `wdio.packaged.conf.ts` removes any GOFER_GDFORMAT override, which leaves
        // `src-tauri/sidecar/gdformat` — copied beside the executable by the Tauri build — as the
        // only binary that can answer.
        const unformatted = 'extends Node\n\n\nfunc _ready( ) -> void:\n    print( "packaged" )\n'
        const formatted = await command<{formatted: string; changed: boolean}>('format_gdscript', {
            request: {source: unformatted}
        })
        expect(formatted.changed).toBe(true)
        expect(formatted.formatted).toBe(
            'extends Node\n\n\nfunc _ready() -> void:\n\tprint("packaged")\n'
        )

        await command('stop_godot_session', {})
        // Stopping removes what the session staged: the addon is Gofer's, the project is the
        // user's, and a stopped session leaves nothing of the former in the latter.
        expect(existsSync(resolve(session.worktree, 'addons/gofer'))).toBe(false)

        const attachmentData = readFileSync(resolve('src-tauri/icons/32x32.png')).toString('base64')
        await browser.execute(encoded => {
            const bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0))
            const transfer = new DataTransfer()
            transfer.items.add(new File([bytes], '32x32.png', {type: 'image/png'}))
            const input = document.querySelector<HTMLInputElement>('input[type="file"]')
            if (!input) throw new Error('Attachment input was not found')
            input.files = transfer.files
            input.dispatchEvent(new Event('change', {bubbles: true}))
        }, attachmentData)
        await expect(browser.$('body')).toHaveText(expect.stringContaining('32x32.png'))
        await sendMessage('Describe the attached image')
        await expect(browser.$('body')).toHaveText(
            expect.stringContaining('Deterministic response · received 1 image')
        )
        await expect(browser.$('body')).toHaveText(expect.stringContaining('fixture/main.tscn'))
        await expect(browser.$('body')).toHaveText(expect.stringContaining('1ms'))

        await sendMessage('Cancel this active operation')
        await expect(browser.$('body')).toHaveText(
            expect.stringContaining('Cancel this active operation')
        )
        await expect(browser.$('body')).toHaveText(
            expect.stringContaining('Deterministic response')
        )
        const stopButton = browser.$('button[aria-label*="Stop"]')
        await stopButton.click()
        // Retry appears only once the last assistant message is `error` or `aborted`, so a Retry
        // that never arrives is a stop that never landed — and "not displayed" says nothing about
        // which half failed. The first Windows run to reach this line had no Retry and no evidence,
        // so the state the assertion reads is printed with it: whether the stop was accepted, and
        // what the stored conversation looks like from the backend's own side.
        try {
            await expect(browser.$('button*=Retry')).toBeDisplayed()
        } catch (failure) {
            const chat = await command<{messages: {text: string; status?: string}[]}>(
                'load_chat',
                {}
            )
            const stored = chat.messages.map(
                message => `${message.status ?? 'no-status'}: ${message.text.slice(0, 60)}`
            )
            const body = await browser.$('body').getText()
            throw new Error(
                `--- stored messages ---\n${stored.join('\n')}\n--- body ---\n${body}`,
                {cause: failure}
            )
        }

        // The restart journey asserts this conversation comes back, so the process must not be torn
        // down until it is durable. Reading the stored chat is what proves that; a pause only hopes.
        let stored: string[] = []
        for (let attempt = 0; attempt < 60; attempt++) {
            const chat = await command<{messages: {text: string}[]}>('load_chat', {})
            stored = chat.messages.map(message => message.text)
            if (stored.includes('Cancel this active operation')) break
            await browser.pause(250)
        }
        expect(stored).toContain('Cancel this active operation')
    })
})

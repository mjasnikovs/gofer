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

const COMPOSER = '[role="combobox"], [role="textbox"]'

async function sendMessage(text: string) {
    const composer = browser.$(COMPOSER)
    await composer.setValue(text)
    await browser.keys('Enter')
}

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

async function sessionOutput() {
    const page = await command<{entries: {message: string}[]}>('read_godot_logs', {
        query: {limit: 60}
    })
    return page.entries.map(entry => entry.message).join('\n')
}

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
        await callGodot('scene.save', {}, true)

        const savedScene = readFileSync(resolve(session.worktree, 'packaged.tscn'), 'utf8')
        expect(savedScene).toContain('PackagedNode')
        expect(savedScene).toContain('Vector2(12, 34)')

        const unformatted = 'extends Node\n\n\nfunc _ready( ) -> void:\n    print( "packaged" )\n'
        const formatted = await command<{formatted: string; changed: boolean}>('format_gdscript', {
            request: {source: unformatted}
        })
        expect(formatted.changed).toBe(true)
        expect(formatted.formatted).toBe(
            'extends Node\n\n\nfunc _ready() -> void:\n\tprint("packaged")\n'
        )

        await command('stop_godot_session', {})
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
            const candidates = await browser.$$('button*=Retry').getElements()
            const described: string[] = []
            for (const candidate of candidates) {
                const size = await candidate.getSize()
                const displayed = await candidate.isDisplayed()
                const html = await candidate.getHTML({includeSelectorTag: true})
                described.push(
                    `displayed=${String(displayed)} ${String(size.width)}x${String(size.height)} `
                        + html.slice(0, 300)
                )
            }
            const body = await browser.$('body').getText()
            throw new Error(
                `--- stored messages ---\n${stored.join('\n')}`
                    + `\n--- button*=Retry candidates (${String(described.length)}) ---\n`
                    + `${described.join('\n')}\n--- body ---\n${body}`,
                {cause: failure}
            )
        }

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

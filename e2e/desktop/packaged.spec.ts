import {expect} from '@wdio/globals'
import {browser} from '@wdio/tauri-service'
import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'

let godotRequestId = 1

async function waitForReadyWorkspace() {
    await expect(browser.$('body')).toHaveText(expect.stringContaining('Gofer is ready'))
    await expect(browser.$('body')).toHaveText(expect.stringContaining('Local AI connected'))
}

async function sendMessage(text: string) {
    const composer = browser.$('[role="textbox"]')
    await composer.setValue(text)
    await browser.keys('Enter')
}

async function sendGodotCommand(command: string, params: Record<string, unknown>) {
    const address = process.env.GOFER_TEST_GODOT_ADDRESS
    if (!address) throw new Error('Packaged Godot bridge address is unavailable')
    return browser.execute(
        async payload => {
            const invoke = window.__TAURI__?.core?.invoke
            if (!invoke) throw new Error('Tauri invoke is unavailable in the packaged renderer')
            return invoke('send_godot_command', payload)
        },
        {
            address,
            request: {
                protocolVersion: 1,
                id: `packaged-${String(godotRequestId++)}`,
                command,
                params
            }
        }
    )
}

describe('packaged desktop application', () => {
    it('completes the deterministic packaged journey and restores persisted state', async () => {
        await waitForReadyWorkspace()
        const windows = await browser.tauri.listWindows()
        expect(windows).toContain('main')

        await sendGodotCommand('handshake', {})
        await sendGodotCommand('open_project', {scene: 'res://main.tscn'})
        await sendGodotCommand('add_node', {name: 'PackagedNode', type: 'Node2D'})
        await sendGodotCommand('set_property', {
            node: 'PackagedNode',
            property: 'position',
            value: [12, 34]
        })
        await sendGodotCommand('save_scene', {})
        const godotProject = process.env.GOFER_TEST_GODOT_PROJECT
        if (!godotProject) throw new Error('Packaged Godot fixture path is unavailable')
        const savedScene = readFileSync(resolve(godotProject, 'main.tscn'), 'utf8')
        expect(savedScene).toContain('PackagedNode')
        expect(savedScene).toContain('Vector2(12, 34)')

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
            expect.stringContaining('Deterministic response')
        )
        const stopButton = browser.$('button[aria-label*="Stop"]')
        await stopButton.click()
        await expect(browser.$('button*=Retry')).toBeDisplayed()
        await browser.pause(500)
    })
})

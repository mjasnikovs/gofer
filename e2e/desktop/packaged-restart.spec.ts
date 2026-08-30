import {expect} from '@wdio/globals'
import {browser} from '@wdio/tauri-service'

describe('restarted packaged desktop application', () => {
    it('restores persisted chat and settings in a new application process', async () => {
        await expect(browser.$('[aria-label="Local AI connected"]')).toBeExisting()
        await expect(browser.$('body')).toHaveText(
            expect.stringContaining('Describe the attached image')
        )
        await expect(browser.$('body')).toHaveText(
            expect.stringContaining('Deterministic response · received 1 image')
        )
        await expect(browser.$('body')).toHaveText(
            expect.stringContaining('Cancel this active operation')
        )
        await expect(browser.$('button*=Retry')).toBeExisting()
        await expect(browser.$('body')).toHaveText(expect.stringContaining('Gofer packaged test'))
    })
})

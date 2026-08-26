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
        /*
         * Existing, not displayed. A chat message carries `content-visibility: auto` — see
         * `src/theme/chat.css` — so a row the restored conversation has not scrolled to is never
         * drawn, and WebKit reports everything inside it as not displayed. The runner's font stack
         * lays this conversation out a few pixels taller than a developer's, which is enough to put
         * the newest reply's footer under the viewport's edge: the assertion passed locally and
         * failed on CI for that difference alone.
         *
         * What this line is for is that a stopped turn comes back stopped, and offers to run again.
         * The button being in the document is the whole of that. `e2e/live/harness.ts` reached the
         * same place from the other end, where it is `expectElement`.
         */
        await expect(browser.$('button*=Retry')).toBeExisting()
        await expect(browser.$('body')).toHaveText(expect.stringContaining('Gofer packaged test'))
    })
})

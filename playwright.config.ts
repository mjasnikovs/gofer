import {defineConfig} from '@playwright/test'

export default defineConfig({
    testDir: './e2e/visual',
    fullyParallel: false,
    retries: 0,
    workers: 1,
    timeout: 30_000,
    expect: {timeout: 10_000},
    use: {
        baseURL: 'http://127.0.0.1:1420',
        viewport: {width: 1280, height: 800},
        // The application follows the system and is developed and shipped dark. A light runner was
        // measuring a screen nobody looks at: contrast, emphasis and every faint control read
        // differently there, so a snapshot could pass while the real window was unreadable.
        colorScheme: 'dark',
        locale: 'en-US',
        timezoneId: 'Europe/Riga',
        reducedMotion: 'reduce'
    },
    webServer: {
        command: 'npm run dev -- --host 127.0.0.1',
        url: 'http://127.0.0.1:1420',
        reuseExistingServer: false,
        timeout: 30_000
    }
})

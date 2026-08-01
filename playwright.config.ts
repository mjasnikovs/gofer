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
        colorScheme: 'light',
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

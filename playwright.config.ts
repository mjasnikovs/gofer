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
        locale: 'en-US',
        timezoneId: 'Europe/Riga',
        reducedMotion: 'reduce'
    },
    /*
     * Two runs of the same screens, one per colour scheme.
     *
     * `src/main.tsx` renders `<Theme mode='system'>`, so the mode is the desktop's, not Gofer's.
     * Pinning the runner to dark measured the half of the users the developers happen to be in and
     * left the other half with a theme no baseline had ever looked at — which is where the one
     * violation the gate carried lived.
     *
     * The interaction test is dark only: it measures a row's geometry and its hover strength, and
     * neither depends on the palette. Running it twice would only double what it costs.
     */
    projects: [
        {name: 'dark', use: {colorScheme: 'dark'}},
        {name: 'light', use: {colorScheme: 'light'}, grepInvert: /@interaction/u}
    ],
    webServer: {
        command: 'npm run dev -- --host 127.0.0.1',
        url: 'http://127.0.0.1:1420',
        reuseExistingServer: false,
        timeout: 30_000
    }
})

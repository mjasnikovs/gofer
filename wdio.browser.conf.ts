export const config: WebdriverIO.Config = {
    runner: 'local',
    specs: ['./e2e/desktop/browser.spec.ts'],
    maxInstances: 1,
    services: [
        [
            '@wdio/tauri-service',
            {
                mode: 'browser',
                devServerUrl: 'http://127.0.0.1:1420'
            }
        ]
    ],
    capabilities: [
        {
            browserName: 'tauri',
            'goog:chromeOptions': {
                binary: process.env.GOFER_CHROME_BINARY ?? '/usr/bin/chromium',
                args: ['--headless=new', '--no-sandbox', '--window-size=1280,800']
            },
            'wdio:chromedriverOptions': {
                binary: process.env.GOFER_CHROMEDRIVER_BINARY ?? '/usr/bin/chromedriver'
            }
        }
    ],
    logLevel: 'error',
    bail: 0,
    baseUrl: 'http://127.0.0.1:1420',
    waitforTimeout: 10_000,
    connectionRetryTimeout: 30_000,
    connectionRetryCount: 0,
    framework: 'mocha',
    reporters: ['spec'],
    mochaOpts: {ui: 'bdd', timeout: 30_000}
}

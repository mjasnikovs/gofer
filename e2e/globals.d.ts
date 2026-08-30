declare namespace NodeJS {
    interface ProcessEnv {
        GOFER_LIVE_WORKSPACE?: string
        GOFER_WORKSPACE_DIR?: string
        GOFER_GODOT_BINARY?: string
        GOFER_GODOT_HEADLESS?: string
        GOFER_GDFORMAT?: string
        GOFER_PACKAGED_FIXTURE_ROOT?: string
        GOFER_APP_DATA_DIR?: string
        GOFER_RAG_CACHE_DIR?: string
        GOFER_PACKAGED_MODEL_BASE_URL?: string
        GOFER_WEBDRIVER_RAG_READY?: string
        GOFER_WEBDRIVER_SKIP_CREDENTIAL_STORE?: string
        GOFER_AI_WORKER?: string
        GOFER_CHROME_BINARY?: string
        GOFER_CHROMEDRIVER_BINARY?: string
        GOFER_SKILLS_SMOKE_ROOT?: string
        GOFER_SKILL_FOLDER?: string
        GOFER_SKILLS_SMOKE_WORKSPACE?: string
        GOFER_SKILLS_SMOKE_FOLDER?: string
    }
}

declare namespace WebdriverIO {
    interface Capabilities {
        'tauri:options'?: {
            application: string
            args?: string[]
        }
    }
}

interface TauriInternals {
    transformCallback: (callback?: unknown, once?: boolean) => number
    unregisterCallback: (id: number) => void
}

interface FixtureDesktop {
    isTauri: () => boolean
    listen: (event: string, handler: (event: unknown) => void) => Promise<() => void>
    invoke: (command: string, arguments_?: unknown) => Promise<unknown>
}

interface Window {
    __TAURI_INTERNALS__?: TauriInternals
    __GOFER_TEST_APPROVE__?: () => void
    __GOFER_TEST_ASK__?: (
        sketches: number,
        design?: {revision?: number; delegated?: boolean}
    ) => void
    __GOFER_TEST_EMIT_STREAM__?: (event: unknown) => void
    __GOFER_TEST_ASK_STEP__?: (step: string) => void
    __GOFER_TEST_HOLD_TURN__?: boolean
    __GOFER_TEST_DESKTOP__?: FixtureDesktop
}

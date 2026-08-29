/**
 * The globals the end-to-end tier reaches for, declared so the type checker can read it.
 *
 * `src` declares its own on `Window`, but `src` is a different program: the e2e project compiles
 * the specs and the runner configs, and nothing in it has ever seen those declarations. They are
 * repeated here rather than shared because the two halves mean different things — `src` describes
 * what the application installs, this describes what a fixture is allowed to install into a page.
 */

declare namespace NodeJS {
    /**
     * The environment the harness is driven by. Declared as properties rather than left to the
     * index signature so that `process.env.GOFER_GODOT_BINARY` is a name the checker knows, and a
     * misspelt one is an error rather than `undefined` at three in the morning.
     */
    interface ProcessEnv {
        /** Where a live sweep should build its Godot project, and where the app is pointed. */
        GOFER_LIVE_WORKSPACE?: string
        /** The workspace a packaged run opens. */
        GOFER_WORKSPACE_DIR?: string
        /** The Godot editor binary the harness starts, when it is not the installed one. */
        GOFER_GODOT_BINARY?: string
        /** Set when the editor must run without a window. */
        GOFER_GODOT_HEADLESS?: string
        /** The gdformat sidecar, when one has been built. */
        GOFER_GDFORMAT?: string
        /** Where the packaged fixture project is unpacked. */
        GOFER_PACKAGED_FIXTURE_ROOT?: string
        /** The application data directory a packaged run is confined to. */
        GOFER_APP_DATA_DIR?: string
        /** Where the retrieval models are cached, so a sweep does not download them again. */
        GOFER_RAG_CACHE_DIR?: string
        /** Serves the model files a packaged run downloads. */
        GOFER_PACKAGED_MODEL_BASE_URL?: string
        /** Declares the retrieval cache warm, so the splash does not wait for a download. */
        GOFER_WEBDRIVER_RAG_READY?: string
        /** Keeps a headless run out of the desktop credential store. */
        GOFER_WEBDRIVER_SKIP_CREDENTIAL_STORE?: string
        /** The AI worker the backend spawns, when it is not the shipped one. */
        GOFER_AI_WORKER?: string
        /** The browser the browser-mode journey drives. */
        GOFER_CHROME_BINARY?: string
        /** The driver for that browser. */
        GOFER_CHROMEDRIVER_BINARY?: string
        /** Where the skills smoke keeps its workspace and fixture, so its worker finds the same one. */
        GOFER_SKILLS_SMOKE_ROOT?: string
        /** A skill folder of your own for the skills smoke, instead of the fixture it writes. */
        GOFER_SKILL_FOLDER?: string
        /** The workspace the skills smoke imports into, handed to the spec by its runner. */
        GOFER_SKILLS_SMOKE_WORKSPACE?: string
        /** The folder the skills smoke imports, handed to the spec by its runner. */
        GOFER_SKILLS_SMOKE_FOLDER?: string
    }
}

declare namespace WebdriverIO {
    /**
     * The capability the Tauri service reads the application out of.
     *
     * `@wdio/native-types` declares it, but only on a type the runner configs would have to reach
     * through a transitive package to name. Declared here instead, so a config states the
     * capability the service documents and nothing depends on a package this repo never installed.
     */
    interface Capabilities {
        'tauri:options'?: {
            application: string
            args?: string[]
        }
    }
}

/** Tauri's IPC internals, as much of them as a browser fixture has to stand in for. */
interface TauriInternals {
    transformCallback: (callback?: unknown, once?: boolean) => number
    unregisterCallback: (id: number) => void
}

/** The seam a fixture installs a whole backend at, mirroring `src/services/desktop.ts`. */
interface FixtureDesktop {
    isTauri: () => boolean
    listen: (event: string, handler: (event: unknown) => void) => Promise<() => void>
    invoke: (command: string, arguments_?: unknown) => Promise<unknown>
}

interface Window {
    __TAURI_INTERNALS__?: TauriInternals
    /** Raises the approval prompt a fixture cannot provoke through an ordinary command. */
    __GOFER_TEST_APPROVE__?: () => void
    /** Raises one question with `sketches` sketches on it, for the visual suite. */
    __GOFER_TEST_ASK__?: (
        sketches: number,
        design?: {revision?: number; delegated?: boolean}
    ) => void
    /** Pushes one more event down the held turn's stream, so a tool call can be made mid-test. */
    __GOFER_TEST_EMIT_STREAM__?: (event: unknown) => void
    /** Reports what the delegated child is doing, on the block's own live line. */
    __GOFER_TEST_ASK_STEP__?: (step: string) => void
    /** Holds the turn open, for the screens that only exist while one is running. */
    __GOFER_TEST_HOLD_TURN__?: boolean
    __GOFER_TEST_DESKTOP__?: FixtureDesktop
}

import '@testing-library/jest-dom/vitest'
import {noInterval, setIntervalScheduler} from '../services/clock'

/*
 * No poll comes round on its own, in any test, unless that test asks for one.
 *
 * A repeating timer is not a delay a test can wait out — it fires again, and what it does the
 * second time depends on how long everything else took. The session reconcile is the one that bit:
 * it runs every second, and on a machine busy enough for a test to spend a second between rendering
 * a panel and clicking it, the poll had already turned the panel offline and disabled the control
 * the click was aimed at. Nothing in the test said so, and it passed alone every time.
 *
 * A test that wants the second tick says so with `setIntervalScheduler`.
 */
setIntervalScheduler(noInterval)

class ResizeObserverStub implements ResizeObserver {
    disconnect() {
        return undefined
    }
    observe() {
        return undefined
    }
    unobserve() {
        return undefined
    }
}

class StorageStub implements Storage {
    private readonly values = new Map<string, string>()

    get length() {
        return this.values.size
    }

    clear() {
        this.values.clear()
    }

    getItem(key: string) {
        return this.values.get(key) ?? null
    }

    key(index: number) {
        return [...this.values.keys()][index] ?? null
    }

    removeItem(key: string) {
        this.values.delete(key)
    }

    setItem(key: string, value: string) {
        this.values.set(key, value)
    }
}

globalThis.ResizeObserver = ResizeObserverStub
const storage = new StorageStub()
Object.defineProperty(window, 'localStorage', {configurable: true, value: storage})
Object.defineProperty(globalThis, 'localStorage', {configurable: true, value: storage})

Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    value: () => null
})

Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    value(this: HTMLDialogElement) {
        this.open = true
    }
})

Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    value(this: HTMLDialogElement) {
        this.open = false
    }
})

Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => undefined,
        removeListener: () => undefined,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        dispatchEvent: () => false
    })
})

Object.defineProperty(window, 'scrollTo', {
    value: () => undefined
})

// `Channel` registers its receiver through Tauri's IPC internals, which only exist inside the
// desktop shell. The stub keeps channel-carrying commands constructible under jsdom.
let nextCallbackId = 1
const callbacks = new Map<number, (payload: unknown) => void>()
Object.defineProperty(window, '__TAURI_INTERNALS__', {
    configurable: true,
    value: {
        transformCallback: (callback: (payload: unknown) => void) => {
            const id = nextCallbackId++
            callbacks.set(id, callback)
            return id
        },
        unregisterCallback: (id: number) => callbacks.delete(id)
    }
})

/*
 * jsdom lays nothing out, so it implements no scrolling at all.
 *
 * A block with a question waiting scrolls itself into view — the feed's follow settles before the
 * sketches have measured their own height, and a question drawn below the fold is a question
 * nothing on screen says is waiting. Here it is a no-op: there is no viewport to be outside of.
 */
Object.defineProperty(Element.prototype, 'scrollIntoView', {
    configurable: true,
    value: () => undefined
})

import '@testing-library/jest-dom/vitest'

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
